-- ─── Re-Import Schutz: Spalten für Datenschutz beim Mirus-Import ─────────────
-- Dieses Script muss im Supabase SQL-Editor ausgeführt werden.
-- Abhängig von: 20260528_actual_hour_entries.sql (actual_hour_entries Tabelle)

-- 1. actual_hours: source-Spalte + Schutzfelder
ALTER TABLE actual_hours
  ADD COLUMN IF NOT EXISTS source          TEXT    DEFAULT 'mirus_import',
  ADD COLUMN IF NOT EXISTS is_locked       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS locked_reason   TEXT,
  ADD COLUMN IF NOT EXISTS manually_edited BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN actual_hours.source          IS 'Datenherkunft: mirus_import | manual';
COMMENT ON COLUMN actual_hours.is_locked       IS 'Gesperrt: wird bei Re-Import nicht überschrieben';
COMMENT ON COLUMN actual_hours.locked_reason   IS 'Grund für Sperre (z.B. confirmed, admin_lock)';
COMMENT ON COLUMN actual_hours.manually_edited IS 'Wurde manuell vom Admin nachbearbeitet';

-- 2. actual_hour_entries: Schutzfelder
ALTER TABLE actual_hour_entries
  ADD COLUMN IF NOT EXISTS is_locked       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS locked_reason   TEXT,
  ADD COLUMN IF NOT EXISTS manually_edited BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN actual_hour_entries.is_locked       IS 'Gesperrt: wird bei Re-Import nicht überschrieben';
COMMENT ON COLUMN actual_hour_entries.locked_reason   IS 'Grund für Sperre';
COMMENT ON COLUMN actual_hour_entries.manually_edited IS 'Wurde manuell bearbeitet';

-- 3. timesheet_import_history: Schutzzähler
ALTER TABLE timesheet_import_history
  ADD COLUMN IF NOT EXISTS protected_count         INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_confirmed_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_manual_count    INTEGER DEFAULT 0;

COMMENT ON COLUMN timesheet_import_history.protected_count         IS 'Anzahl MAs mit Schutz (bestätigt + manuell)';
COMMENT ON COLUMN timesheet_import_history.skipped_confirmed_count IS 'Anzahl MAs übersprungen weil bestätigt';
COMMENT ON COLUMN timesheet_import_history.skipped_manual_count    IS 'Anzahl MAs übersprungen wegen manueller Bearbeitung';

-- Validierung
SELECT
  (SELECT count(*) FROM actual_hours)        AS actual_hours_rows,
  (SELECT count(*) FROM actual_hour_entries) AS actual_hour_entries_rows;
