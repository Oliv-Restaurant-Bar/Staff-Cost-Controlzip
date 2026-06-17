-- ============================================================
-- Gastronovi Z-Bericht v2 — Importtyp, Tageswerte, KPIs
-- Ausführen im Supabase SQL-Editor (nach 20260617_gn_grants.sql)
-- ============================================================

-- ── Neue Spalten in gn_imports ────────────────────────────────────────────────

ALTER TABLE gn_imports
  ADD COLUMN IF NOT EXISTS import_type        TEXT DEFAULT 'period',
  ADD COLUMN IF NOT EXISTS aggregation_level  TEXT DEFAULT 'period',
  ADD COLUMN IF NOT EXISTS gross_revenue      NUMERIC,
  ADD COLUMN IF NOT EXISTS net_revenue        NUMERIC,
  ADD COLUMN IF NOT EXISTS food_revenue       NUMERIC,
  ADD COLUMN IF NOT EXISTS bev_revenue        NUMERIC,
  ADD COLUMN IF NOT EXISTS take_away_revenue  NUMERIC,
  ADD COLUMN IF NOT EXISTS discount_total     NUMERIC,
  ADD COLUMN IF NOT EXISTS cancellation_total NUMERIC,
  ADD COLUMN IF NOT EXISTS receipts_count     INTEGER,
  ADD COLUMN IF NOT EXISTS avg_receipt        NUMERIC;

-- Bestehende Einträge mit import_type 'period' markieren (Rückwärtskompatibilität)
UPDATE gn_imports SET import_type = 'period' WHERE import_type IS NULL;

-- ── Neue Tabelle: Tagesebene ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gn_zbericht_daily (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id           UUID NOT NULL REFERENCES gn_imports(id) ON DELETE CASCADE,
  restaurant_id       TEXT NOT NULL,
  date                DATE NOT NULL,
  gross_revenue       NUMERIC,
  net_revenue         NUMERIC,
  food_revenue        NUMERIC,
  bev_revenue         NUMERIC,
  take_away_revenue   NUMERIC,
  discount_total      NUMERIC,
  cancellation_total  NUMERIC,
  receipts_count      INTEGER,
  avg_receipt         NUMERIC,
  source_period_from  DATE,
  source_period_to    DATE,
  aggregation_level   TEXT NOT NULL DEFAULT 'period',
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gn_daily_import          ON gn_zbericht_daily(import_id);
CREATE INDEX IF NOT EXISTS idx_gn_daily_restaurant_date ON gn_zbericht_daily(restaurant_id, date);

ALTER TABLE gn_zbericht_daily DISABLE ROW LEVEL SECURITY;

-- ── Berechtigungen ───────────────────────────────────────────────────────────
-- Konsistent mit 20260617_gn_grants.sql: beide Rollen erhalten Vollzugriff.

GRANT SELECT, INSERT, UPDATE, DELETE ON gn_zbericht_daily TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON gn_imports         TO authenticated, anon;
