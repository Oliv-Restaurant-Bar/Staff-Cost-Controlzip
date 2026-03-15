-- ═══════════════════════════════════════════════════════════════════════════
-- Quellensteuer-relevante Felder (Source Tax fields)
-- Datum: 2026-03-15
-- Zweck: Aufenthaltsstatus, Zivilstand, Ehepartner-Fragen für Quellensteuer
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS permit_type VARCHAR
    CHECK (permit_type IN ('swiss', 'C', 'B', 'L', 'G', 'other')),
  ADD COLUMN IF NOT EXISTS marital_status VARCHAR
    CHECK (marital_status IN ('single', 'married', 'divorced', 'widowed')),
  ADD COLUMN IF NOT EXISTS spouse_employed BOOLEAN,
  ADD COLUMN IF NOT EXISTS spouse_lives_in_switzerland BOOLEAN;

COMMENT ON COLUMN public.employees.permit_type IS
  'Aufenthaltsstatus: swiss = CH-Bürger | C = Niederlassungsb. | B/L/G/other = quellensteuerpflichtig';
COMMENT ON COLUMN public.employees.marital_status IS
  'Zivilstand: single | married | divorced | widowed';
COMMENT ON COLUMN public.employees.spouse_employed IS
  'Ehepartner erwerbstätig? (relevant für Quellensteuer-Tarif)';
COMMENT ON COLUMN public.employees.spouse_lives_in_switzerland IS
  'Ehepartner wohnt in der Schweiz? (relevant für Quellensteuer-Tarif)';
