-- Fügt compensation_balance_hours zur employee_time_balances-Tabelle hinzu.
-- Speichert den Kompensations-Saldo (Schliessbestand) aus dem Mirus-Monatsbericht.

ALTER TABLE employee_time_balances
  ADD COLUMN IF NOT EXISTS compensation_balance_hours NUMERIC;

COMMENT ON COLUMN employee_time_balances.compensation_balance_hours IS
  'Schliessbestand Kompensation in Stunden (aus Mirus-Monatsbericht, Konto "comp")';
