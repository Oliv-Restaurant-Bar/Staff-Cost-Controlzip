-- Update AG-Sozialkostenfaktor von 1.13 auf 1.03 für alle bestehenden Mitarbeiter
UPDATE public.employees
SET social_cost_factor = 1.03
WHERE social_cost_factor = 1.13;

-- Standardwert der Spalte ebenfalls anpassen
ALTER TABLE public.employees
  ALTER COLUMN social_cost_factor SET DEFAULT 1.03;
