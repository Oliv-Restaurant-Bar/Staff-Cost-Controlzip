-- Migration: employee_timesheet_confirmations — Korrekturen
-- Ausführen im Supabase SQL-Editor
--
-- Behebt:
--   1. CHECK-Constraint: fehlende Statuswerte 'question_open' und 'finalized'
--   2. Grants für anon-Rolle  (Mitarbeiter bestätigen/ablehnen via Token ohne Login)
--   3. Grants für authenticated-Rolle (Admin)
--   4. Stellt sicher dass tenant_id-Spalte INDEX hat (schnellere Abfragen)

-- ─── 1. Tabelle anlegen falls noch nicht vorhanden ────────────────────────────
-- (idempotent — ändert nichts wenn Tabelle schon existiert)

CREATE TABLE IF NOT EXISTS employee_timesheet_confirmations (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT         NOT NULL,
  employee_id       TEXT         NOT NULL,
  month             INTEGER      NOT NULL CHECK (month BETWEEN 1 AND 12),
  year              INTEGER      NOT NULL CHECK (year >= 2020),
  token             TEXT         UNIQUE NOT NULL,
  status            TEXT         NOT NULL DEFAULT 'open',
  confirmed_at      TIMESTAMPTZ,
  rejected_at       TIMESTAMPTZ,
  employee_comment  TEXT,
  admin_comment     TEXT,
  created_at        TIMESTAMPTZ  DEFAULT now(),
  updated_at        TIMESTAMPTZ  DEFAULT now(),
  expires_at        TIMESTAMPTZ,
  UNIQUE (employee_id, month, year)
);

-- ─── 2. CHECK-Constraint für status ersetzen (alle gültigen Werte) ─────────────
-- Löscht bestehenden Constraint (falls vorhanden) und erstellt korrekten neu

ALTER TABLE employee_timesheet_confirmations
  DROP CONSTRAINT IF EXISTS employee_timesheet_confirmations_status_check;

ALTER TABLE employee_timesheet_confirmations
  ADD CONSTRAINT employee_timesheet_confirmations_status_check
  CHECK (status IN (
    'open',
    'link_created',
    'sent',
    'confirmed',
    'rejected',
    'expired',
    'question_open',   -- Mitarbeiter hat Rückfrage gestellt
    'finalized'        -- Admin hat Monat final abgeschlossen
  ));

-- ─── 3. Updated-at Trigger ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_timesheet_confirmation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_timesheet_confirmation_updated_at
  ON employee_timesheet_confirmations;

CREATE TRIGGER trg_timesheet_confirmation_updated_at
  BEFORE UPDATE ON employee_timesheet_confirmations
  FOR EACH ROW EXECUTE FUNCTION update_timesheet_confirmation_updated_at();

-- ─── 4. RLS aktivieren + Policies ─────────────────────────────────────────────

ALTER TABLE employee_timesheet_confirmations ENABLE ROW LEVEL SECURITY;

-- Policies: sicher ersetzen (DROP IF EXISTS + CREATE)
DROP POLICY IF EXISTS "timesheet_select_all"    ON employee_timesheet_confirmations;
DROP POLICY IF EXISTS "timesheet_insert_auth"   ON employee_timesheet_confirmations;
DROP POLICY IF EXISTS "timesheet_update_all"    ON employee_timesheet_confirmations;
DROP POLICY IF EXISTS "timesheet_delete_auth"   ON employee_timesheet_confirmations;

-- Lesen: alle (Token ist der Zugriffsschutz — kryptografisch zufällig 256-bit)
CREATE POLICY "timesheet_select_all"
  ON employee_timesheet_confirmations FOR SELECT
  USING (true);

-- Einfügen: nur authentifizierte Nutzer (Admin)
CREATE POLICY "timesheet_insert_auth"
  ON employee_timesheet_confirmations FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

-- Aktualisieren: alle (Mitarbeiter bestätigen/ablehnen via öffentlichem Token-Link)
CREATE POLICY "timesheet_update_all"
  ON employee_timesheet_confirmations FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Löschen: nur authentifizierte (Admin)
CREATE POLICY "timesheet_delete_auth"
  ON employee_timesheet_confirmations FOR DELETE
  USING (auth.role() = 'authenticated');

-- ─── 5. Grants ────────────────────────────────────────────────────────────────

-- anon: Lesen + Aktualisieren (für Mitarbeiter-Bestätigung ohne Login)
GRANT SELECT, UPDATE ON employee_timesheet_confirmations TO anon;

-- authenticated: voller Zugriff (Admin)
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_timesheet_confirmations TO authenticated;

-- ─── 6. Performance-Index ─────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_etc_tenant_year_month
  ON employee_timesheet_confirmations (tenant_id, year, month);

CREATE INDEX IF NOT EXISTS idx_etc_employee_year_month
  ON employee_timesheet_confirmations (employee_id, year, month);

CREATE INDEX IF NOT EXISTS idx_etc_token
  ON employee_timesheet_confirmations (token);

-- ─── Verifizierung (optional — zum Prüfen nach Ausführung) ────────────────────
-- SELECT constraint_name, check_clause
-- FROM information_schema.check_constraints
-- WHERE constraint_name = 'employee_timesheet_confirmations_status_check';
