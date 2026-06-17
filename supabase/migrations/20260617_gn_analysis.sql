-- ============================================================
-- Gastronovi Analysis: Metriken erweitern
-- Ausführen im Supabase SQL-Editor (nach 20260617_gn_personen.sql)
-- ============================================================

-- gn_person_metrics: average_receipt + metric_type
ALTER TABLE gn_person_metrics
  ADD COLUMN IF NOT EXISTS average_receipt NUMERIC,
  ADD COLUMN IF NOT EXISTS metric_type TEXT DEFAULT 'personen';

-- gn_person_imports: csv_type (erkannter/gewählter Analysetyp)
ALTER TABLE gn_person_imports
  ADD COLUMN IF NOT EXISTS csv_type TEXT DEFAULT 'personen';

-- Index für schnellen Filter nach metric_type + date
CREATE INDEX IF NOT EXISTS idx_gn_person_metrics_type_date
  ON gn_person_metrics(metric_type, date);
