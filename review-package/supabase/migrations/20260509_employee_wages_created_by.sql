-- ============================================================
-- employee_wages – Spalte created_by hinzufügen
-- ============================================================
-- Dieses Script behebt den Fehler:
--   "Could not find the 'created_by' column of 'employee_wages'
--    in the schema cache"
--
-- Wann ausführen:
--   Wenn die Tabelle employee_wages bereits existiert (Migration
--   20260430_employee_wages.sql wurde ausgeführt), aber die Spalte
--   created_by fehlt.
--
-- Idempotent: kann problemlos mehrfach ausgeführt werden.
-- ============================================================

-- Spalte hinzufügen (falls noch nicht vorhanden)
ALTER TABLE public.employee_wages
  ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT '';

-- Verifikation
DO $$
DECLARE
  col_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'employee_wages'
      AND column_name  = 'created_by'
  ) INTO col_exists;

  IF col_exists THEN
    RAISE NOTICE 'OK: Spalte created_by ist vorhanden in employee_wages.';
  ELSE
    RAISE EXCEPTION 'Fehler: Spalte created_by konnte nicht hinzugefügt werden!';
  END IF;
END;
$$;

-- Supabase Schema-Cache aktualisieren
NOTIFY pgrst, 'reload schema';

SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'employee_wages'
ORDER BY ordinal_position;
