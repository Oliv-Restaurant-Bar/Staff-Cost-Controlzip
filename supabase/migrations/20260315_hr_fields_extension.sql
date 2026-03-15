-- ═══════════════════════════════════════════════════════════════════════════
-- HR-Felder Erweiterung der employees-Tabelle
-- Datum: 2026-03-15
-- Zweck: Persönliche Daten, Vertragliche Grundlagen und Onboarding-Status
--        zentral in Supabase speichern (statt nur im Browser-localStorage)
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Saldo-Felder (wurden bisher nur im Code referenziert, aber nicht in DB)
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS hours_balance       NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS vacation_balance    NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS vacation_days_per_year INTEGER;

-- 2. Lohn-Erweiterung
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS social_cost_factor  NUMERIC(5,4) DEFAULT 1.13,
  ADD COLUMN IF NOT EXISTS has_13th_salary     BOOLEAN      DEFAULT false;

-- 3. Persönliche Daten (für Onboarding / Vertrag)
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS birth_date          DATE,
  ADD COLUMN IF NOT EXISTS nationality         TEXT,
  ADD COLUMN IF NOT EXISTS phone               TEXT,
  ADD COLUMN IF NOT EXISTS email               TEXT,
  ADD COLUMN IF NOT EXISTS address_street      TEXT,
  ADD COLUMN IF NOT EXISTS address_zip         TEXT,
  ADD COLUMN IF NOT EXISTS address_city        TEXT,
  ADD COLUMN IF NOT EXISTS ahv_number          TEXT,
  ADD COLUMN IF NOT EXISTS iban                TEXT;

-- 4. Vertragliche Grundlagen (Architektur für Vertragsgenerierung)
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS contract_type           TEXT     CHECK (contract_type IN ('monthly', 'hourly', 'irregular') OR contract_type IS NULL),
  ADD COLUMN IF NOT EXISTS position_title          TEXT,
  ADD COLUMN IF NOT EXISTS contract_start          DATE,
  ADD COLUMN IF NOT EXISTS contract_end            DATE,
  ADD COLUMN IF NOT EXISTS is_limited_contract     BOOLEAN  DEFAULT false,
  ADD COLUMN IF NOT EXISTS trial_period_months     INTEGER,
  ADD COLUMN IF NOT EXISTS notice_period_weeks     INTEGER;

-- 5. Onboarding-Status und Token (für späteren Self-Service-Link)
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS onboarding_status   TEXT DEFAULT 'none'
    CHECK (onboarding_status IN ('none', 'prepared', 'sent', 'completed')),
  ADD COLUMN IF NOT EXISTS onboarding_token    TEXT;

-- 6. Kommentare für Dokumentation
COMMENT ON COLUMN public.employees.social_cost_factor  IS 'AG-Sozialkostenfaktor, z.B. 1.13 = 13% Arbeitgeberanteil (AHV, ALV, etc.)';
COMMENT ON COLUMN public.employees.has_13th_salary     IS '13. Monatslohn vereinbart?';
COMMENT ON COLUMN public.employees.ahv_number          IS 'AHV-Nummer (vertraulich, nur Admin sichtbar)';
COMMENT ON COLUMN public.employees.iban                IS 'IBAN für Lohnzahlung (vertraulich, nur Admin sichtbar)';
COMMENT ON COLUMN public.employees.onboarding_token    IS 'Eindeutiger UUID-Token für späteren Self-Onboarding-Link';
COMMENT ON COLUMN public.employees.onboarding_status   IS 'Status: none → prepared → sent → completed';
COMMENT ON COLUMN public.employees.contract_type       IS 'monthly = Monatslohn, hourly = Stundenlohn, irregular = Aushilfe';
