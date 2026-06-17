-- ============================================================
-- Gastronovi Z-Bericht Import Tables
-- Ausführen im Supabase SQL-Editor
-- ============================================================

-- Haupttabelle: ein Eintrag pro importiertem Z-Bericht
CREATE TABLE IF NOT EXISTS gn_imports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  pdf_file_name   TEXT,
  z_counter       TEXT,
  cost_center     TEXT,
  period_from     DATE,
  period_to       DATE,
  status          TEXT NOT NULL DEFAULT 'active',
  raw_csv_json    JSONB,
  checksum        TEXT,
  imported_at     TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gn_imports_restaurant ON gn_imports(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_gn_imports_period     ON gn_imports(period_from, period_to);
CREATE INDEX IF NOT EXISTS idx_gn_imports_checksum   ON gn_imports(checksum);

-- Umsatz-Zusammenfassung
CREATE TABLE IF NOT EXISTS gn_revenue_summary (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id                     UUID NOT NULL REFERENCES gn_imports(id) ON DELETE CASCADE,
  total_gross                   NUMERIC,
  total_excl_tip                NUMERIC,
  total_excl_rounding           NUMERIC,
  total_excl_customer_card_topups NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_gn_revenue_import ON gn_revenue_summary(import_id);

-- Steuerbericht
CREATE TABLE IF NOT EXISTS gn_tax_summary (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id   UUID NOT NULL REFERENCES gn_imports(id) ON DELETE CASCADE,
  tax_rate    TEXT,
  net_amount  NUMERIC,
  tax_amount  NUMERIC,
  gross_amount NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_gn_tax_import ON gn_tax_summary(import_id);

-- Kostenstellen
CREATE TABLE IF NOT EXISTS gn_cost_centers (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES gn_imports(id) ON DELETE CASCADE,
  name      TEXT,
  count     INTEGER,
  amount    NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_gn_costcenters_import ON gn_cost_centers(import_id);

-- Kellner
CREATE TABLE IF NOT EXISTS gn_waiters (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES gn_imports(id) ON DELETE CASCADE,
  name      TEXT,
  count     INTEGER,
  amount    NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_gn_waiters_import ON gn_waiters(import_id);

-- Bezahlarten
CREATE TABLE IF NOT EXISTS gn_payment_methods (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES gn_imports(id) ON DELETE CASCADE,
  name      TEXT,
  count     INTEGER,
  amount    NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_gn_payment_import ON gn_payment_methods(import_id);

-- Hauptwarengruppen
CREATE TABLE IF NOT EXISTS gn_product_groups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id       UUID NOT NULL REFERENCES gn_imports(id) ON DELETE CASCADE,
  name            TEXT,
  count           INTEGER,
  original_amount NUMERIC,
  amount          NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_gn_productgroups_import ON gn_product_groups(import_id);

-- Rabatte (Rabatte + Positionsrabatte)
CREATE TABLE IF NOT EXISTS gn_discounts (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES gn_imports(id) ON DELETE CASCADE,
  type      TEXT,    -- 'rabatt' | 'positionsrabatt'
  name      TEXT,
  count     INTEGER,
  amount    NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_gn_discounts_import ON gn_discounts(import_id);

-- Stornierte Artikel
CREATE TABLE IF NOT EXISTS gn_cancellations (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES gn_imports(id) ON DELETE CASCADE,
  name      TEXT,
  count     INTEGER,
  amount    NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_gn_cancellations_import ON gn_cancellations(import_id);

-- Buchungskonten
CREATE TABLE IF NOT EXISTS gn_accounting_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id    UUID NOT NULL REFERENCES gn_imports(id) ON DELETE CASCADE,
  name         TEXT,
  account      TEXT,
  tax_rate     TEXT,
  gross_amount NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_gn_accounting_import ON gn_accounting_lines(import_id);

-- Zahlungskonten
CREATE TABLE IF NOT EXISTS gn_payment_accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id    UUID NOT NULL REFERENCES gn_imports(id) ON DELETE CASCADE,
  name         TEXT,
  account      TEXT,
  gross_amount NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_gn_payaccounts_import ON gn_payment_accounts(import_id);

-- RLS deaktiviert (App nutzt Service-Role-Key für Admin-Operationen)
ALTER TABLE gn_imports           DISABLE ROW LEVEL SECURITY;
ALTER TABLE gn_revenue_summary   DISABLE ROW LEVEL SECURITY;
ALTER TABLE gn_tax_summary       DISABLE ROW LEVEL SECURITY;
ALTER TABLE gn_cost_centers      DISABLE ROW LEVEL SECURITY;
ALTER TABLE gn_waiters           DISABLE ROW LEVEL SECURITY;
ALTER TABLE gn_payment_methods   DISABLE ROW LEVEL SECURITY;
ALTER TABLE gn_product_groups    DISABLE ROW LEVEL SECURITY;
ALTER TABLE gn_discounts         DISABLE ROW LEVEL SECURITY;
ALTER TABLE gn_cancellations     DISABLE ROW LEVEL SECURITY;
ALTER TABLE gn_accounting_lines  DISABLE ROW LEVEL SECURITY;
ALTER TABLE gn_payment_accounts  DISABLE ROW LEVEL SECURITY;
