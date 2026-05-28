-- ─── actual_hour_entries ──────────────────────────────────────────────────────
-- Speichert einzelne Stempelzeiten (Kommen/Gehen) pro Mitarbeiter und Tag.
-- Ersetzt NICHT actual_hours (Tagestotale bleiben dort).
-- Source: 'mirus' = aus Mirus-Excel-Import, 'manual' = manuell erfasst.

CREATE TABLE IF NOT EXISTS actual_hour_entries (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id  TEXT        NOT NULL,
  date         DATE        NOT NULL,
  entry_type   TEXT        NOT NULL CHECK (entry_type IN ('in', 'out')),
  time         TIME        NOT NULL,
  source       TEXT        NOT NULL DEFAULT 'mirus',
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_actual_hour_entries_emp_date
  ON actual_hour_entries (employee_id, date);

CREATE INDEX IF NOT EXISTS idx_actual_hour_entries_date
  ON actual_hour_entries (date);

-- Row Level Security (analog zu anderen Tabellen im Projekt)
ALTER TABLE actual_hour_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage actual_hour_entries"
  ON actual_hour_entries
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Kommentar
COMMENT ON TABLE actual_hour_entries IS
  'Einzelne Kommen/Gehen-Stempel pro Mitarbeiter und Tag. '
  'Verknüpft mit actual_hours über (employee_id, date).';
