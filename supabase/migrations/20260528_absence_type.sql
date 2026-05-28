-- Fügt absence_type zu actual_hours hinzu
-- Speichert den aus Mirus erkannten Abwesenheitstyp (Ferien/Unfall/Krankheit/Feiertag/Frei)
-- Canonical values: vacation | accident | sick | holiday | free

ALTER TABLE actual_hours
  ADD COLUMN IF NOT EXISTS absence_type TEXT DEFAULT NULL;

COMMENT ON COLUMN actual_hours.absence_type IS
  'Abwesenheitstyp aus Mirus-Import: vacation | accident | sick | holiday | free';

-- Index für Abfragen nach Abwesenheitstyp pro Monat
CREATE INDEX IF NOT EXISTS actual_hours_absence_type_idx
  ON actual_hours(employee_id, date)
  WHERE absence_type IS NOT NULL;

-- Fehlende Stunden-Einträge für Abwesenheitstage: kein unique-Constraint-Problem
-- da diese Zeilen hours=0 haben (Arbeitstag ohne geleistete Stunden).
-- Der bestehende UNIQUE(employee_id, date) bleibt erhalten.
