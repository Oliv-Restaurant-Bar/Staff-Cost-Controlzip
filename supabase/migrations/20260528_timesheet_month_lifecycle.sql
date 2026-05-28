-- Monatsabschluss-Workflow für Arbeitszeitblätter
-- Ausführen im Supabase SQL-Editor (nach 20260528_mirus_adjustment_status.sql)

-- ──────────────────────────────────────────────────────────────────────────────
-- Tabelle 1: timesheet_month_status
-- Pro Mitarbeiter + Monat: Lebenszyklus-Status
-- draft → released → question_open → corrected → confirmed → finalized → archived
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS timesheet_month_status (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT         NOT NULL,
  employee_id    TEXT         NOT NULL,
  month          INTEGER      NOT NULL CHECK (month BETWEEN 1 AND 12),
  year           INTEGER      NOT NULL CHECK (year BETWEEN 2020 AND 2040),
  status         TEXT         NOT NULL DEFAULT 'draft',
  released_at    TIMESTAMPTZ,
  confirmed_at   TIMESTAMPTZ,
  finalized_at   TIMESTAMPTZ,
  archived_at    TIMESTAMPTZ,
  released_by    TEXT,
  finalized_by   TEXT,
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (tenant_id, employee_id, month, year)
);

ALTER TABLE timesheet_month_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "timesheet_month_status_auth"
  ON timesheet_month_status FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_tms_tenant_year_month
  ON timesheet_month_status (tenant_id, year, month);

CREATE INDEX IF NOT EXISTS idx_tms_employee
  ON timesheet_month_status (employee_id, year, month);

-- ──────────────────────────────────────────────────────────────────────────────
-- Tabelle 2: timesheet_month_snapshot
-- JSON-Snapshot aller relevanten Daten beim Finalisieren (PDF-Vorbereitung)
-- Pro Tenant + Monat: ein Snapshot, UPSERT bei erneutem Finalisieren
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS timesheet_month_snapshot (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT         NOT NULL,
  month          INTEGER      NOT NULL CHECK (month BETWEEN 1 AND 12),
  year           INTEGER      NOT NULL CHECK (year BETWEEN 2020 AND 2040),
  finalized_at   TIMESTAMPTZ  NOT NULL,
  finalized_by   TEXT,
  employee_count INTEGER      NOT NULL DEFAULT 0,
  data           JSONB        NOT NULL,
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (tenant_id, month, year)
);

ALTER TABLE timesheet_month_snapshot ENABLE ROW LEVEL SECURITY;

CREATE POLICY "timesheet_month_snapshot_auth"
  ON timesheet_month_snapshot FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_tms_snap_tenant_year_month
  ON timesheet_month_snapshot (tenant_id, year, month);
