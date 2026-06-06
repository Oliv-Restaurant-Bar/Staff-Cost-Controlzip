-- ─── Migration: Kawtar + Party → normale Flex-Mitarbeiter ──────────────────
-- Datum: 2026-06-06
-- Tenant: Oliv
--
-- Zweck:
--   Kawtar (Service, CHF 20/h) und Party (Küche, CHF 25/h) werden aus
--   schedule_extra_cost_people in die normale employees-Tabelle überführt.
--   Neue saubere IDs: 'kawtar' und 'party'.
--   Bestehende schedule_entries und actual_hours werden auf die neuen IDs
--   umgeschrieben — kein Datenverlust.
--   Alte aush_*-Einträge in schedule_extra_cost_people werden archiviert
--   (is_active=false, archived_at=now()).
--
-- SUPABASE AKTION ERFORDERLICH: JA
-- Dieses Skript im Supabase SQL-Editor ausführen.
-- Idempotent: ON CONFLICT DO UPDATE + INSERT IF NOT EXISTS Logik.
--
-- Reihenfolge:
--   0. is_active/archived_at Spalten sicherstellen (idempotent)
--   1. Kawtar → employees 'kawtar'
--   2. Party  → employees 'party'
--   3. schedule_entries migrieren
--   4. actual_hours migrieren
--   5. schedule_extra_cost_people archivieren
--   6. Alte aush_*-employees-Einträge archivieren
--   7. Validierung + Bericht
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Schritt 0: Spalten sicherstellen (idempotent) ────────────────────────────
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS is_active   BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ          DEFAULT NULL;

-- ── Schritt 1: Kawtar → employees mit ID 'kawtar' ────────────────────────────
INSERT INTO public.employees (id, name, department, employment_type, hourly_wage, is_active)
SELECT
  'kawtar'    AS id,
  name,
  'service'   AS department,  -- Service-Abteilung
  'aushilfe'  AS employment_type,
  20.00       AS hourly_wage,
  true        AS is_active
FROM public.schedule_extra_cost_people
WHERE name ILIKE '%kawtar%'
  AND tenant_id = 'oliv'
LIMIT 1
ON CONFLICT (id) DO UPDATE SET
  name            = EXCLUDED.name,
  department      = 'service',
  employment_type = 'aushilfe',
  hourly_wage     = 20.00,
  is_active       = true,
  updated_at      = now();

-- Fallback: Falls kein Eintrag in schedule_extra_cost_people gefunden, direkt eintragen
INSERT INTO public.employees (id, name, department, employment_type, hourly_wage, is_active)
VALUES ('kawtar', 'Kawtar', 'service', 'aushilfe', 20.00, true)
ON CONFLICT (id) DO NOTHING;

-- ── Schritt 2: Party → employees mit ID 'party' ──────────────────────────────
INSERT INTO public.employees (id, name, department, employment_type, hourly_wage, is_active)
SELECT
  'party'     AS id,
  name,
  'kueche'    AS department,  -- Küche-Abteilung
  'aushilfe'  AS employment_type,
  25.00       AS hourly_wage,
  true        AS is_active
FROM public.schedule_extra_cost_people
WHERE name ILIKE '%party%'
  AND tenant_id = 'oliv'
LIMIT 1
ON CONFLICT (id) DO UPDATE SET
  name            = EXCLUDED.name,
  department      = 'kueche',
  employment_type = 'aushilfe',
  hourly_wage     = 25.00,
  is_active       = true,
  updated_at      = now();

-- Fallback
INSERT INTO public.employees (id, name, department, employment_type, hourly_wage, is_active)
VALUES ('party', 'Party', 'kueche', 'aushilfe', 25.00, true)
ON CONFLICT (id) DO NOTHING;

-- ── Schritt 3: schedule_entries migrieren ─────────────────────────────────────
-- Kawtar: aush_*-ID → 'kawtar'
UPDATE public.schedule_entries
SET employee_id = 'kawtar'
WHERE employee_id IN (
  SELECT id FROM public.schedule_extra_cost_people
  WHERE name ILIKE '%kawtar%' AND tenant_id = 'oliv'
);

-- Party: aush_*-ID → 'party'
UPDATE public.schedule_entries
SET employee_id = 'party'
WHERE employee_id IN (
  SELECT id FROM public.schedule_extra_cost_people
  WHERE name ILIKE '%party%' AND tenant_id = 'oliv'
);

-- Alte aush_*-Einträge aus employees (falls vorhanden)
UPDATE public.schedule_entries
SET employee_id = 'kawtar'
WHERE employee_id IN (
  SELECT id FROM public.employees
  WHERE (id LIKE 'aush_%' OR id LIKE 'b-aush_%')
    AND name ILIKE '%kawtar%'
    AND employee_id != 'kawtar'
);

UPDATE public.schedule_entries
SET employee_id = 'party'
WHERE employee_id IN (
  SELECT id FROM public.employees
  WHERE (id LIKE 'aush_%' OR id LIKE 'b-aush_%')
    AND name ILIKE '%party%'
    AND employee_id != 'party'
);

-- ── Schritt 4: actual_hours migrieren ────────────────────────────────────────
-- Kawtar
UPDATE public.actual_hours
SET employee_id = 'kawtar'
WHERE employee_id IN (
  SELECT id FROM public.schedule_extra_cost_people
  WHERE name ILIKE '%kawtar%' AND tenant_id = 'oliv'
);

-- Party
UPDATE public.actual_hours
SET employee_id = 'party'
WHERE employee_id IN (
  SELECT id FROM public.schedule_extra_cost_people
  WHERE name ILIKE '%party%' AND tenant_id = 'oliv'
);

-- Aus alten aush_*-employees-Einträgen
UPDATE public.actual_hours
SET employee_id = 'kawtar'
WHERE employee_id IN (
  SELECT id FROM public.employees
  WHERE (id LIKE 'aush_%' OR id LIKE 'b-aush_%')
    AND name ILIKE '%kawtar%'
);

UPDATE public.actual_hours
SET employee_id = 'party'
WHERE employee_id IN (
  SELECT id FROM public.employees
  WHERE (id LIKE 'aush_%' OR id LIKE 'b-aush_%')
    AND name ILIKE '%party%'
);

-- ── Schritt 5: schedule_extra_cost_people archivieren ────────────────────────
UPDATE public.schedule_extra_cost_people
SET
  is_active   = false,
  archived_at = COALESCE(archived_at, now())
WHERE (name ILIKE '%kawtar%' OR name ILIKE '%party%')
  AND tenant_id = 'oliv';

-- ── Schritt 6: Alte aush_*-Einträge in employees archivieren (NUR OLIV) ───────
-- SICHERHEIT: Nur Oliv-IDs (kein 'b-' Präfix) → Beaulieu-Mitarbeiter unberührt.
-- Kawtar und Party sind ausschliesslich Oliv-Mitarbeiter.
UPDATE public.employees
SET
  is_active   = false,
  archived_at = COALESCE(archived_at, now())
WHERE id LIKE 'aush_%'
  AND NOT (id LIKE 'b-%')
  AND (name ILIKE '%kawtar%' OR name ILIKE '%party%');

-- ── Schritt 7: Validierung + Migrationsbericht ───────────────────────────────
DO $$
DECLARE
  kawtar_in_emp     BOOLEAN;
  party_in_emp      BOOLEAN;
  kawtar_dept       TEXT;
  party_dept        TEXT;
  kawtar_wage       NUMERIC;
  party_wage        NUMERIC;
  kawtar_sch        INT;
  party_sch         INT;
  kawtar_act        INT;
  party_act         INT;
  kawtar_archived   INT;
  party_archived    INT;
  old_kawtar_ids    TEXT;
  old_party_ids     TEXT;
BEGIN
  SELECT (COUNT(*) > 0), department, hourly_wage
    INTO kawtar_in_emp, kawtar_dept, kawtar_wage
    FROM public.employees WHERE id = 'kawtar' AND is_active = true;

  SELECT (COUNT(*) > 0), department, hourly_wage
    INTO party_in_emp, party_dept, party_wage
    FROM public.employees WHERE id = 'party'  AND is_active = true;

  SELECT COUNT(*) INTO kawtar_sch FROM public.schedule_entries WHERE employee_id = 'kawtar';
  SELECT COUNT(*) INTO party_sch  FROM public.schedule_entries WHERE employee_id = 'party';
  SELECT COUNT(*) INTO kawtar_act FROM public.actual_hours    WHERE employee_id = 'kawtar';
  SELECT COUNT(*) INTO party_act  FROM public.actual_hours    WHERE employee_id = 'party';

  SELECT COUNT(*) INTO kawtar_archived
    FROM public.schedule_extra_cost_people
    WHERE name ILIKE '%kawtar%' AND is_active = false;
  SELECT COUNT(*) INTO party_archived
    FROM public.schedule_extra_cost_people
    WHERE name ILIKE '%party%' AND is_active = false;

  SELECT STRING_AGG(id, ', ') INTO old_kawtar_ids
    FROM public.employees WHERE name ILIKE '%kawtar%' AND is_active = false;
  SELECT STRING_AGG(id, ', ') INTO old_party_ids
    FROM public.employees WHERE name ILIKE '%party%' AND is_active = false;

  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════════';
  RAISE NOTICE '  KAWTAR / PARTY → NORMALE MITARBEITER — ERGEBNIS';
  RAISE NOTICE '═══════════════════════════════════════════════════════';
  RAISE NOTICE '';
  RAISE NOTICE '  Kawtar:';
  RAISE NOTICE '    Neue ID:               kawtar';
  RAISE NOTICE '    In employees (aktiv):  %', kawtar_in_emp;
  RAISE NOTICE '    Abteilung:             % (soll: service)', kawtar_dept;
  RAISE NOTICE '    Stundenlohn:           % CHF (soll: 20.00)', kawtar_wage;
  RAISE NOTICE '    schedule_entries:      % Einträge migriert', kawtar_sch;
  RAISE NOTICE '    actual_hours:          % Einträge migriert', kawtar_act;
  RAISE NOTICE '    Archiviert in extra:   %', kawtar_archived;
  RAISE NOTICE '    Alte aush_*-IDs:       %', COALESCE(old_kawtar_ids, 'keine');
  RAISE NOTICE '';
  RAISE NOTICE '  Party:';
  RAISE NOTICE '    Neue ID:               party';
  RAISE NOTICE '    In employees (aktiv):  %', party_in_emp;
  RAISE NOTICE '    Abteilung:             % (soll: kueche)', party_dept;
  RAISE NOTICE '    Stundenlohn:           % CHF (soll: 25.00)', party_wage;
  RAISE NOTICE '    schedule_entries:      % Einträge migriert', party_sch;
  RAISE NOTICE '    actual_hours:          % Einträge migriert', party_act;
  RAISE NOTICE '    Archiviert in extra:   %', party_archived;
  RAISE NOTICE '    Alte aush_*-IDs:       %', COALESCE(old_party_ids, 'keine');
  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════════';

  IF NOT kawtar_in_emp THEN
    RAISE WARNING 'FEHLER: Kawtar nicht in employees oder is_active=false!';
  END IF;
  IF NOT party_in_emp THEN
    RAISE WARNING 'FEHLER: Party nicht in employees oder is_active=false!';
  END IF;
END $$;

COMMIT;
