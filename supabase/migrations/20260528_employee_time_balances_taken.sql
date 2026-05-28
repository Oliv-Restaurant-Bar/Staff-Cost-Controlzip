-- Migration: Ferien bezogen + Feiertage bezogen
-- Trennt "bezogen" (genommene Stunden) von "Restsaldo" (Guthaben) in employee_time_balances

ALTER TABLE employee_time_balances
  ADD COLUMN IF NOT EXISTS vacation_taken_hours  NUMERIC,
  ADD COLUMN IF NOT EXISTS holiday_taken_hours   NUMERIC;

COMMENT ON COLUMN employee_time_balances.vacation_taken_hours  IS 'Ferien bezogen diesen Monat (monthlyAccounts.vacation.actual aus Mirus)';
COMMENT ON COLUMN employee_time_balances.holiday_taken_hours   IS 'Feiertage bezogen diesen Monat (monthlyAccounts.holiday.actual aus Mirus)';
