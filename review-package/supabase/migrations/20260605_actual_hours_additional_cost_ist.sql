-- ─── Migration: is_additional_cost_ist für actual_hours ────────────────────
-- Datum: 2026-06-05
-- Zweck: Persistiert das «Zusatzkosten» IST-Flag für Fixlohn-Mitarbeiter
--        direkt in der Datenbank. Vorher nur in localStorage → ging nach
--        Reload verloren.
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.actual_hours
  ADD COLUMN IF NOT EXISTS is_additional_cost_ist BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.actual_hours.is_additional_cost_ist IS
  'true = diese IST-Stunde eines Fixlohn-Mitarbeiters zählt als Zusatzkosten '
  '(variable Flexkosten), nicht als Teil des fixen Monatslohns. '
  'Wird im Ist-Stunden-Raster des Dienstplans gesetzt.';

-- Validierung
DO $$
DECLARE cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt FROM public.actual_hours WHERE is_additional_cost_ist = true;
  RAISE NOTICE 'actual_hours.is_additional_cost_ist: Spalte vorhanden. % bestehende true-Einträge.', cnt;
END $$;
