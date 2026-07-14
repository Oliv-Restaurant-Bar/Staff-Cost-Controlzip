-- Tages-Annotationen aus Mirus-Import
-- Speichert pro Tag: Abwesenheitstyp, rohes Label, Stunden, Notizen, Quelle
-- Ergänzt actual_hours.absence_type um rückverfolgbare, mehrfache Annotationen pro Tag.

CREATE TABLE IF NOT EXISTS actual_day_annotations (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id TEXT        NOT NULL,
  date        DATE        NOT NULL,
  type        TEXT        NOT NULL,  -- vacation | accident | sick | holiday | free | note | compensation
  label       TEXT,                  -- Roh-Code aus Mirus (z.B. 'UVG', 'Ferien', 'KR')
  hours       NUMERIC,               -- Abwesenheitsstunden (aus Mirus, falls vorhanden)
  notes       TEXT,                  -- Bemerkungen / Notizen aus der Bemerkungsspalte
  source      TEXT        NOT NULL DEFAULT 'mirus_import',
  created_at  TIMESTAMPTZ NOT NULL   DEFAULT now()
);

-- Eindeutiger Schlüssel: ein Eintrag pro (Mitarbeiter, Tag, Typ, Quelle)
-- Erlaubt z.B. type='vacation' und type='note' am selben Tag gleichzeitig.
CREATE UNIQUE INDEX IF NOT EXISTS actual_day_annotations_unique_idx
  ON actual_day_annotations(employee_id, date, type, source);

-- Index für Monatsabfragen
CREATE INDEX IF NOT EXISTS actual_day_annotations_range_idx
  ON actual_day_annotations(employee_id, date);

-- RLS
ALTER TABLE actual_day_annotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users can manage actual_day_annotations"
  ON actual_day_annotations
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON actual_day_annotations TO authenticated;

COMMENT ON TABLE actual_day_annotations IS
  'Pro-Tag-Annotationen aus Mirus-Import: Abwesenheiten, Notizen, Codes.';
COMMENT ON COLUMN actual_day_annotations.type IS
  'Kanonischer Typ: vacation | accident | sick | holiday | free | note | compensation';
COMMENT ON COLUMN actual_day_annotations.label IS
  'Roh-Code aus Mirus, z.B. UVG, FE, Ferien, Unfall';
COMMENT ON COLUMN actual_day_annotations.hours IS
  'Erfasste Stunden für diese Abwesenheit (aus Mirus totalHours)';
COMMENT ON COLUMN actual_day_annotations.notes IS
  'Freitext aus der Bemerkungsspalte des Mirus-Monatsblatts';
