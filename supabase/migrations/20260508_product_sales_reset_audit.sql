-- ============================================================
-- Migration: Audit-Log Tabelle für Monatsdaten-Reset
-- ============================================================
-- Ausführen im Supabase SQL-Editor.
-- Zweck: Protokolliert jeden Admin-Reset von Produktdaten mit
--        wer / wann / welcher Monat / wie viele Zeilen gelöscht.
-- ============================================================

CREATE TABLE IF NOT EXISTS product_sales_reset_log (
  id           BIGSERIAL PRIMARY KEY,
  deleted_by   TEXT        NOT NULL,           -- E-Mail des Admins
  year         INTEGER     NOT NULL,
  month        INTEGER     NOT NULL CHECK (month BETWEEN 1 AND 12),
  sources      TEXT        NOT NULL,           -- kommagetrennt, z.B. 'food_csv_export,beverage_csv_export'
  rows_deleted INTEGER     NOT NULL DEFAULT 0,
  deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index für Abfragen nach Datum / Admin
CREATE INDEX IF NOT EXISTS idx_reset_log_deleted_at
  ON product_sales_reset_log (deleted_at DESC);

CREATE INDEX IF NOT EXISTS idx_reset_log_year_month
  ON product_sales_reset_log (year, month);

-- Row-Level Security: nur authentifizierte User dürfen lesen/schreiben
ALTER TABLE product_sales_reset_log ENABLE ROW LEVEL SECURITY;

-- Admins dürfen INSERT
CREATE POLICY "Admin kann Reset-Log schreiben"
  ON product_sales_reset_log FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Admins dürfen SELECT (alle Einträge)
CREATE POLICY "Admin kann Reset-Log lesen"
  ON product_sales_reset_log FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================
-- Abfrage-Beispiel (Audit-Protokoll anzeigen):
-- SELECT
--   deleted_by, year, month, sources, rows_deleted,
--   to_char(deleted_at, 'DD.MM.YYYY HH24:MI') AS zeitpunkt
-- FROM product_sales_reset_log
-- ORDER BY deleted_at DESC
-- LIMIT 50;
-- ============================================================
