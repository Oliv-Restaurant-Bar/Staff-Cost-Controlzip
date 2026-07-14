-- ─── actual_hour_entries ──────────────────────────────────────────────────────
-- Speichert einzelne Arbeitsblöcke (Schichten) pro Mitarbeiter und Tag.
-- actual_hours bleibt die Tagestotale — diese Tabelle ergänzt mit den Details.
--
-- Schema: ein Datensatz pro Arbeitsblock (z.B. zwei Blöcke bei Split-Schicht).
-- UNIQUE auf (employee_id, date, start_time, end_time) → UPSERT-sicher.

CREATE TABLE IF NOT EXISTS actual_hour_entries (
  id              UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id     TEXT         NOT NULL,
  date            DATE         NOT NULL,
  start_time      TIME         NOT NULL,
  end_time        TIME         NOT NULL,
  duration_hours  NUMERIC(5,2) NOT NULL,
  source          TEXT         NOT NULL DEFAULT 'mirus_import',
  created_at      TIMESTAMPTZ  DEFAULT now(),

  CONSTRAINT actual_hour_entries_unique
    UNIQUE (employee_id, date, start_time, end_time)
);

CREATE INDEX IF NOT EXISTS idx_actual_hour_entries_emp_date
  ON actual_hour_entries (employee_id, date);

CREATE INDEX IF NOT EXISTS idx_actual_hour_entries_date
  ON actual_hour_entries (date);

-- Row Level Security
ALTER TABLE actual_hour_entries ENABLE ROW LEVEL SECURITY;

-- Policy: alle eingeloggten Benutzer dürfen lesen und schreiben
CREATE POLICY "Authenticated users can manage actual_hour_entries"
  ON actual_hour_entries
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Grants: explizit erforderlich — RLS allein reicht nicht
GRANT ALL ON TABLE actual_hour_entries TO authenticated;
GRANT ALL ON TABLE actual_hour_entries TO service_role;
GRANT SELECT ON TABLE actual_hour_entries TO anon;

COMMENT ON TABLE actual_hour_entries IS
  'Einzelne Arbeitsblöcke (Kommen/Gehen-Paare) pro Mitarbeiter und Tag. '
  'Tagestotale bleiben in actual_hours. Quelle: mirus_import.';
