-- ─── Migration: Integritätsfelder für employees ─────────────────────────────
-- Datum: 2026-06-05
-- Zweck: Robuste Archivierung — employment_end_date alleine ist nicht
--        ausreichend als Schutz gegen Reaktivierung durch Sync-Prozesse.
--        is_active und archived_at sind redundante, explizite Sperren.
--
-- Dieses Script im Supabase SQL-Editor ausführen.
-- Idempotent: ADD COLUMN IF NOT EXISTS verhindert Fehler bei Mehrfachausführung.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Spalten hinzufügen
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS is_active    BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ          DEFAULT NULL;

-- 2. Kommentare
COMMENT ON COLUMN public.employees.is_active IS
  'false = archiviert/deaktiviert. Wird von archiveEmployee() gesetzt. '
  'Redundanter Schutz gegen Reaktivierung via Sync. '
  'Nur der Personalstamm darf diesen Wert wieder auf true setzen.';

COMMENT ON COLUMN public.employees.archived_at IS
  'Zeitpunkt der Archivierung (UTC). NULL = nie archiviert. '
  'Gesetzt von archiveEmployee() gleichzeitig mit employment_end_date.';

-- 3. Bestehende archivierte Mitarbeiter rückwirkend markieren
--    (employment_end_date in der Vergangenheit → is_active = false)
UPDATE public.employees
SET
  is_active   = false,
  archived_at = COALESCE(archived_at, employment_end_date::TIMESTAMPTZ, now())
WHERE
  employment_end_date IS NOT NULL
  AND employment_end_date < CURRENT_DATE
  AND is_active = true;

-- 4. Validierung
DO $$
DECLARE
  total_employees   INT;
  archived_employees INT;
BEGIN
  SELECT COUNT(*)                           INTO total_employees   FROM public.employees;
  SELECT COUNT(*) FILTER (WHERE NOT is_active) INTO archived_employees FROM public.employees;
  RAISE NOTICE 'employees gesamt: %, davon archiviert (is_active=false): %',
    total_employees, archived_employees;
END $$;
