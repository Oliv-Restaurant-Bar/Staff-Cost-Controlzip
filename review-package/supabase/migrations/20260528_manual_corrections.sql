-- Migration: Manuelle Korrekturen & Änderungsprotokoll
-- Ausführen im Supabase SQL-Editor

-- ── 1. Änderungsprotokoll-Tabelle ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS timesheet_change_log (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  TEXT         NOT NULL,
  date         DATE         NOT NULL,
  month        INTEGER      NOT NULL,
  year         INTEGER      NOT NULL,
  table_name   TEXT         NOT NULL,
  field_name   TEXT         NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  change_type  TEXT         NOT NULL,
  reason       TEXT,
  changed_by   TEXT,
  changed_at   TIMESTAMPTZ  DEFAULT now(),
  source       TEXT         DEFAULT 'manual_edit'
);

CREATE INDEX IF NOT EXISTS idx_change_log_employee_date
  ON timesheet_change_log (employee_id, date);

CREATE INDEX IF NOT EXISTS idx_change_log_employee_month
  ON timesheet_change_log (employee_id, year, month);

-- ── 2. actual_hours erweitern ─────────────────────────────────────────────────

ALTER TABLE actual_hours
  ADD COLUMN IF NOT EXISTS is_locked       BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_reason   TEXT,
  ADD COLUMN IF NOT EXISTS manually_edited BOOLEAN DEFAULT false;

-- ── 3. actual_hour_entries erweitern ─────────────────────────────────────────

ALTER TABLE actual_hour_entries
  ADD COLUMN IF NOT EXISTS is_locked       BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_reason   TEXT,
  ADD COLUMN IF NOT EXISTS manually_edited BOOLEAN DEFAULT false;

-- ── 4. GRANTs ─────────────────────────────────────────────────────────────────

GRANT ALL ON TABLE timesheet_change_log    TO authenticated;
GRANT ALL ON TABLE timesheet_change_log    TO service_role;
GRANT ALL ON TABLE actual_hours            TO authenticated;
GRANT ALL ON TABLE actual_hours            TO service_role;
GRANT ALL ON TABLE actual_hour_entries     TO authenticated;
GRANT ALL ON TABLE actual_hour_entries     TO service_role;
