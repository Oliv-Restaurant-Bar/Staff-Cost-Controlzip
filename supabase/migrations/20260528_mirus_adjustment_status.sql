-- Mirus-Nachtrag-Status: Pro Mitarbeiter + Monat verfolgen ob Admin Korrekturen in Mirus eingetragen hat
--
-- Ausführen im Supabase SQL-Editor (nach 20260528_timesheet_employee_requests.sql)

CREATE TABLE IF NOT EXISTS timesheet_mirus_adjustment_status (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    TEXT         NOT NULL,
  month          INTEGER      NOT NULL CHECK (month BETWEEN 1 AND 12),
  year           INTEGER      NOT NULL CHECK (year BETWEEN 2020 AND 2040),
  status         TEXT         NOT NULL DEFAULT 'open',   -- 'open' | 'done'
  marked_done_at TIMESTAMPTZ,
  marked_done_by TEXT,   -- E-Mail des Admins der es markiert hat
  note           TEXT,
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (employee_id, month, year)
);

ALTER TABLE timesheet_mirus_adjustment_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_full_access"
  ON timesheet_mirus_adjustment_status
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_mirus_adj_status_year_month
  ON timesheet_mirus_adjustment_status (year, month);

CREATE INDEX IF NOT EXISTS idx_mirus_adj_status_employee
  ON timesheet_mirus_adjustment_status (employee_id);
