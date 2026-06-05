-- ─── Migration: schedule_extra_cost_people ─────────────────────────────────
-- Datum: 2026-06-05
-- Zweck: Eigene Tabelle für externe Aushilfen / Zusatzkosten-Ressourcen.
--        Sie dürfen nicht in employees gespeichert werden, brauchen aber
--        persistente Datensätze für Dienstplanung und Personal FIX.
--
-- WICHTIG: Vor der Datenmigration müssen die FK-Constraints auf
--          schedule_entries.employee_id und actual_hours.employee_id
--          entfernt werden — sonst CASCADE DELETE alle Schicht-Einträge.
--
-- Reihenfolge:
--   1. FK-Constraints droppen
--   2. Neue Tabelle erstellen
--   3. Daten migrieren (aush_* aus employees → schedule_extra_cost_people)
--   4. Gemigerte employees archivieren (is_active=false)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. FK-Constraints auf schedule_entries und actual_hours entfernen
--    employee_id bleibt TEXT NOT NULL, aber ohne FK-Referenz auf employees.
--    Referentielle Integrität wird auf Applikationsebene sichergestellt.
ALTER TABLE public.schedule_entries
  DROP CONSTRAINT IF EXISTS schedule_entries_employee_id_fkey;

ALTER TABLE public.actual_hours
  DROP CONSTRAINT IF EXISTS actual_hours_employee_id_fkey;

-- 2. Neue Tabelle für externe Aushilfen / Zusatzkosten-Ressourcen
CREATE TABLE IF NOT EXISTS public.schedule_extra_cost_people (
  id           TEXT         NOT NULL PRIMARY KEY,
  name         TEXT         NOT NULL,
  department   TEXT         NOT NULL CHECK (department IN ('service', 'kueche')),
  hourly_wage  NUMERIC(10,2) NOT NULL DEFAULT 0,
  tenant_id    TEXT         NOT NULL DEFAULT 'oliv',
  is_active    BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ           DEFAULT now(),
  archived_at  TIMESTAMPTZ           DEFAULT NULL
);

COMMENT ON TABLE public.schedule_extra_cost_people IS
  'Externe Aushilfen und Zusatzkosten-Ressourcen für den Dienstplan. '
  'Kein normaler Personalstamm — kein Monatslohn, keine Sozialleistungen. '
  'IDs können aush_* oder b-aush_* sein (tenant-prefix analog employees).';

COMMENT ON COLUMN public.schedule_extra_cost_people.tenant_id IS
  'oliv oder beaulieu. Tenant-Isolation wie bei employees.';

-- 3. Row Level Security
ALTER TABLE public.schedule_extra_cost_people ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_extracost_select" ON public.schedule_extra_cost_people
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_extracost_insert" ON public.schedule_extra_cost_people
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_extracost_update" ON public.schedule_extra_cost_people
  FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_extracost_delete" ON public.schedule_extra_cost_people
  FOR DELETE TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.schedule_extra_cost_people TO authenticated;

CREATE INDEX IF NOT EXISTS idx_extracost_tenant ON public.schedule_extra_cost_people(tenant_id, is_active);

-- 4. Datenmigration: bestehende aush_*-Mitarbeiter aus employees übernehmen
--    id LIKE 'aush_%'    → Oliv
--    id LIKE 'b-aush_%'  → Beaulieu
INSERT INTO public.schedule_extra_cost_people (id, name, department, hourly_wage, tenant_id, is_active, created_at)
SELECT
  id,
  name,
  department,
  COALESCE(hourly_wage, 0),
  CASE WHEN id LIKE 'b-%' THEN 'beaulieu' ELSE 'oliv' END,
  COALESCE(is_active, true),
  COALESCE(created_at, now())
FROM public.employees
WHERE id LIKE 'aush_%' OR id LIKE 'b-aush_%'
ON CONFLICT (id) DO NOTHING;

-- 5. Gemigerte employees archivieren (nicht löschen — Audit-Trail)
UPDATE public.employees
SET
  is_active   = false,
  archived_at = COALESCE(archived_at, now())
WHERE (id LIKE 'aush_%' OR id LIKE 'b-aush_%')
  AND is_active = true;

-- 6. Validierung
DO $$
DECLARE
  migrated_count  INT;
  archived_count  INT;
BEGIN
  SELECT COUNT(*) INTO migrated_count  FROM public.schedule_extra_cost_people;
  SELECT COUNT(*) INTO archived_count  FROM public.employees WHERE (id LIKE 'aush_%' OR id LIKE 'b-aush_%') AND is_active = false;
  RAISE NOTICE 'schedule_extra_cost_people: % Einträge', migrated_count;
  RAISE NOTICE 'employees archiviert (aush_*): %', archived_count;
END $$;
