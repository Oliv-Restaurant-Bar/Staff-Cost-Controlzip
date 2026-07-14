-- Ausschluss-Tabellen für Arbeitszeitblätter-Modul
-- Mitarbeiter können pro Monat (oder ab einem Monat dauerhaft) ausgeschlossen werden.

CREATE TABLE IF NOT EXISTS timesheet_month_exclusions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT,
  employee_id TEXT        NOT NULL,
  start_month INT         NOT NULL,
  start_year  INT         NOT NULL,
  end_month   INT,
  end_year    INT,
  reason      TEXT,
  excluded_by TEXT,
  excluded_at TIMESTAMPTZ DEFAULT now(),
  is_active   BOOLEAN     DEFAULT true
);

CREATE INDEX IF NOT EXISTS timesheet_month_exclusions_tenant
  ON timesheet_month_exclusions(tenant_id, is_active);
CREATE INDEX IF NOT EXISTS timesheet_month_exclusions_emp
  ON timesheet_month_exclusions(employee_id, is_active);

COMMENT ON TABLE  timesheet_month_exclusions                   IS 'Ausschlüsse von Mitarbeitern aus dem Arbeitszeitblatt-Monatslauf';
COMMENT ON COLUMN timesheet_month_exclusions.start_month       IS 'Ab diesem Monat ausgeschlossen (1-12)';
COMMENT ON COLUMN timesheet_month_exclusions.start_year        IS 'Ab diesem Jahr ausgeschlossen';
COMMENT ON COLUMN timesheet_month_exclusions.end_month         IS 'Bis einschliesslich dieses Monats ausgeschlossen (null = unbegrenzt)';
COMMENT ON COLUMN timesheet_month_exclusions.end_year          IS 'Bis einschliesslich dieses Jahres ausgeschlossen (null = unbegrenzt)';
COMMENT ON COLUMN timesheet_month_exclusions.is_active         IS 'Wenn false: historischer Eintrag (überschrieben durch neueren)';

-- Einzelmonat-Ausnahmen: überschreiben einen laufenden Ausschluss für genau einen Monat
CREATE TABLE IF NOT EXISTS timesheet_month_inclusions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT,
  employee_id TEXT        NOT NULL,
  month       INT         NOT NULL,
  year        INT         NOT NULL,
  reason      TEXT,
  included_by TEXT,
  included_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, year, month)
);

CREATE INDEX IF NOT EXISTS timesheet_month_inclusions_tenant
  ON timesheet_month_inclusions(tenant_id);
CREATE INDEX IF NOT EXISTS timesheet_month_inclusions_emp
  ON timesheet_month_inclusions(employee_id, year, month);

COMMENT ON TABLE timesheet_month_inclusions IS 'Einzel-Monats-Ausnahmen: überschreiben einen laufenden Ausschluss für genau einen Monat';
