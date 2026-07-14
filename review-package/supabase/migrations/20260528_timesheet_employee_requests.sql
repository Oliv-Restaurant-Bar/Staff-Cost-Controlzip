-- Mitarbeiter-Rückfragen und Korrekturanträge für Arbeitszeitblätter
-- Mitarbeiter können auf der öffentlichen Bestätigungsseite Anfragen einreichen.
-- Admins sehen diese und können sie bearbeiten/übernehmen.

CREATE TABLE IF NOT EXISTS timesheet_employee_requests (
  id                   UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  confirmation_id      UUID,
  tenant_id            TEXT,
  employee_id          TEXT        NOT NULL,
  date                 DATE,                          -- Betrifft einen spez. Tag (oder NULL = allgemein)
  month                INTEGER     NOT NULL,
  year                 INTEGER     NOT NULL,
  request_type         TEXT        NOT NULL,          -- 'question' | 'correction_request' | 'general'
  category             TEXT,                          -- 'arbeitszeit' | 'pause' | 'ferien' | 'krankheit' | 'unfall' | 'sonstiges'
  message              TEXT,
  requested_hours      NUMERIC,
  requested_start_time TIME,
  requested_end_time   TIME,
  status               TEXT        NOT NULL DEFAULT 'open',  -- 'open' | 'in_review' | 'resolved' | 'rejected'
  admin_response       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at          TIMESTAMPTZ,
  resolved_by          TEXT                           -- User-Email des Admins (TEXT für Anon-Kompatibilität)
);

CREATE INDEX IF NOT EXISTS ter_tenant_month_idx
  ON timesheet_employee_requests(tenant_id, year, month);

CREATE INDEX IF NOT EXISTS ter_employee_month_idx
  ON timesheet_employee_requests(employee_id, year, month);

CREATE INDEX IF NOT EXISTS ter_confirmation_idx
  ON timesheet_employee_requests(confirmation_id);

-- RLS
ALTER TABLE timesheet_employee_requests ENABLE ROW LEVEL SECURITY;

-- Authentifizierte Admins: voller Zugriff
CREATE POLICY "authenticated_full_access_ter"
  ON timesheet_employee_requests
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Anonyme (Mitarbeiter-Links): können INSERT und SELECT
CREATE POLICY "anon_can_insert_ter"
  ON timesheet_employee_requests
  FOR INSERT TO anon
  WITH CHECK (true);

CREATE POLICY "anon_can_select_ter"
  ON timesheet_employee_requests
  FOR SELECT TO anon
  USING (true);

GRANT SELECT, INSERT ON timesheet_employee_requests TO anon;
GRANT ALL ON timesheet_employee_requests TO authenticated;

COMMENT ON TABLE timesheet_employee_requests IS
  'Mitarbeiter-Rückfragen und Korrekturanträge zu Arbeitszeitblättern.
   Einträge werden vom Mitarbeiter via öffentlichem Token-Link erstellt.
   Admins können sie einsehen, kommentieren, ablehnen oder Korrekturen übernehmen.';
COMMENT ON COLUMN timesheet_employee_requests.request_type IS
  'question = allgemeine Rückfrage; correction_request = Antrag auf Zeitkorrektur; general = allgemeiner Kommentar';
COMMENT ON COLUMN timesheet_employee_requests.status IS
  'open = neu / unbearbeitet; in_review = Admin schaut rein; resolved = erledigt; rejected = abgelehnt';
