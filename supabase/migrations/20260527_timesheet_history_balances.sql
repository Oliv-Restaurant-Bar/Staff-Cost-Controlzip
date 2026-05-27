-- Migration: Import-Historie und Mitarbeiter-Zeitguthaben
-- Muss im Supabase SQL-Editor ausgeführt werden.

-- ─── 1. timesheet_import_history ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS timesheet_import_history (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT         NOT NULL,
  source          TEXT         NOT NULL DEFAULT 'mirus',
  file_name       TEXT,
  month           INTEGER      NOT NULL CHECK (month BETWEEN 1 AND 12),
  year            INTEGER      NOT NULL CHECK (year >= 2020),
  imported_count  INTEGER      NOT NULL DEFAULT 0,
  updated_count   INTEGER      NOT NULL DEFAULT 0,
  error_count     INTEGER      NOT NULL DEFAULT 0,
  errors          JSONB,
  created_at      TIMESTAMPTZ  DEFAULT now(),
  created_by      TEXT
);

ALTER TABLE timesheet_import_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "import_history_select_auth"
  ON timesheet_import_history FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "import_history_insert_auth"
  ON timesheet_import_history FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "import_history_delete_auth"
  ON timesheet_import_history FOR DELETE
  USING (auth.role() = 'authenticated');

-- ─── 2. employee_time_balances ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS employee_time_balances (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   TEXT         NOT NULL,
  employee_id                 TEXT         NOT NULL,
  month                       INTEGER      NOT NULL CHECK (month BETWEEN 1 AND 12),
  year                        INTEGER      NOT NULL CHECK (year >= 2020),
  vacation_balance_hours      NUMERIC,
  public_holiday_balance_hours NUMERIC,
  overtime_balance_hours      NUMERIC,
  hours_balance               NUMERIC,
  source                      TEXT         NOT NULL DEFAULT 'mirus_import',
  created_at                  TIMESTAMPTZ  DEFAULT now(),
  updated_at                  TIMESTAMPTZ  DEFAULT now(),
  UNIQUE (employee_id, month, year)
);

CREATE OR REPLACE FUNCTION update_employee_time_balances_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_employee_time_balances_updated_at
  BEFORE UPDATE ON employee_time_balances
  FOR EACH ROW EXECUTE FUNCTION update_employee_time_balances_updated_at();

ALTER TABLE employee_time_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "time_balances_select_auth"
  ON employee_time_balances FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "time_balances_upsert_auth"
  ON employee_time_balances FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
