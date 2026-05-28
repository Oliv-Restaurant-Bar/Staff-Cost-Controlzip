-- Migration: Import-Qualitätsspalten in timesheet_import_history
-- Ausführen im Supabase SQL-Editor

ALTER TABLE timesheet_import_history
  ADD COLUMN IF NOT EXISTS parser_quality  JSONB,
  ADD COLUMN IF NOT EXISTS import_status   TEXT DEFAULT 'success',
  ADD COLUMN IF NOT EXISTS error_summary   TEXT;

-- GRANTs (falls noch nicht vorhanden)
GRANT ALL ON TABLE timesheet_import_history TO authenticated;
GRANT ALL ON TABLE timesheet_import_history TO service_role;
