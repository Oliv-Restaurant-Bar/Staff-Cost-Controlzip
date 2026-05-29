-- Migration: Ferien/Feiertag Tage-Felder + Sicherung bereits geplanter Spalten
-- Stellt sicher dass alle benötigten Spalten in employee_time_balances existieren.
-- Muss im Supabase SQL-Editor ausgeführt werden (nicht automatisch).

-- ── Bereits geplante Spalten (aus _taken und _comp Migrationen) ───────────────
ALTER TABLE employee_time_balances
  ADD COLUMN IF NOT EXISTS vacation_taken_hours   NUMERIC,
  ADD COLUMN IF NOT EXISTS holiday_taken_hours    NUMERIC,
  ADD COLUMN IF NOT EXISTS compensation_balance_hours NUMERIC;

-- ── Neue Tage-Felder ──────────────────────────────────────────────────────────
ALTER TABLE employee_time_balances
  ADD COLUMN IF NOT EXISTS vacation_taken_days    NUMERIC,
  ADD COLUMN IF NOT EXISTS vacation_balance_days  NUMERIC,
  ADD COLUMN IF NOT EXISTS holiday_taken_days     NUMERIC,
  ADD COLUMN IF NOT EXISTS holiday_balance_days   NUMERIC;

-- ── Kommentare ────────────────────────────────────────────────────────────────
COMMENT ON COLUMN employee_time_balances.vacation_taken_hours   IS 'Ferien bezogen diesen Monat in Stunden (aus Mirus monthlyAccounts.vacation.actual)';
COMMENT ON COLUMN employee_time_balances.holiday_taken_hours    IS 'Feiertage bezogen diesen Monat in Stunden (aus Mirus monthlyAccounts.holiday.actual)';
COMMENT ON COLUMN employee_time_balances.compensation_balance_hours IS 'Schliessbestand Kompensation in Stunden (aus Mirus Konto comp)';
COMMENT ON COLUMN employee_time_balances.vacation_taken_days    IS 'Ferien bezogen diesen Monat in Tagen (gezählt aus Absenz-Tags)';
COMMENT ON COLUMN employee_time_balances.vacation_balance_days  IS 'Ferienrestguthaben in Tagen (vacation_balance_hours / tägliche Sollstunden)';
COMMENT ON COLUMN employee_time_balances.holiday_taken_days     IS 'Feiertage bezogen diesen Monat in Tagen (gezählt aus Absenz-Tags)';
COMMENT ON COLUMN employee_time_balances.holiday_balance_days   IS 'Feiertagguthaben Rest in Tagen (public_holiday_balance_hours / tägliche Sollstunden)';

-- ── Validierung ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  col_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO col_count
  FROM information_schema.columns
  WHERE table_name = 'employee_time_balances'
    AND column_name IN (
      'vacation_taken_hours', 'holiday_taken_hours', 'compensation_balance_hours',
      'vacation_taken_days',  'vacation_balance_days',
      'holiday_taken_days',   'holiday_balance_days'
    );
  IF col_count < 7 THEN
    RAISE EXCEPTION 'Migration unvollständig: nur % von 7 erwarteten Spalten gefunden', col_count;
  END IF;
  RAISE NOTICE 'Migration erfolgreich: alle 7 Spalten vorhanden';
END $$;
