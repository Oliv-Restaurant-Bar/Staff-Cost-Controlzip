-- Migration: employee_timesheet_confirmations
-- Digitale Arbeitszeitblatt-Bestätigungen pro Mitarbeiter und Monat

CREATE TABLE IF NOT EXISTS employee_timesheet_confirmations (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT         NOT NULL,
  employee_id       TEXT         NOT NULL,
  month             INTEGER      NOT NULL CHECK (month BETWEEN 1 AND 12),
  year              INTEGER      NOT NULL CHECK (year >= 2020),
  token             TEXT         UNIQUE NOT NULL,
  status            TEXT         NOT NULL DEFAULT 'open'
                                 CHECK (status IN ('open','link_created','sent','confirmed','rejected','expired')),
  confirmed_at      TIMESTAMPTZ,
  rejected_at       TIMESTAMPTZ,
  employee_comment  TEXT,
  admin_comment     TEXT,
  created_at        TIMESTAMPTZ  DEFAULT now(),
  updated_at        TIMESTAMPTZ  DEFAULT now(),
  expires_at        TIMESTAMPTZ,

  -- Pro Mitarbeiter/Monat/Jahr nur eine aktive Bestätigung
  UNIQUE (employee_id, month, year)
);

-- Auto-Update updated_at
CREATE OR REPLACE FUNCTION update_timesheet_confirmation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_timesheet_confirmation_updated_at
  BEFORE UPDATE ON employee_timesheet_confirmations
  FOR EACH ROW EXECUTE FUNCTION update_timesheet_confirmation_updated_at();

-- RLS
ALTER TABLE employee_timesheet_confirmations ENABLE ROW LEVEL SECURITY;

-- Lesen: alle (Token ist der Zugriffsschutz – kryptografisch zufällig)
CREATE POLICY "timesheet_select_all"
  ON employee_timesheet_confirmations FOR SELECT
  USING (true);

-- Einfügen: nur authentifizierte (Admin)
CREATE POLICY "timesheet_insert_auth"
  ON employee_timesheet_confirmations FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

-- Aktualisieren: alle (Mitarbeiter bestätigen/ablehnen via Token-URL)
CREATE POLICY "timesheet_update_all"
  ON employee_timesheet_confirmations FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Löschen: nur authentifizierte (Admin)
CREATE POLICY "timesheet_delete_auth"
  ON employee_timesheet_confirmations FOR DELETE
  USING (auth.role() = 'authenticated');
