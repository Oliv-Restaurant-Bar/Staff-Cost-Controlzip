-- ============================================================
-- Migration: Duplikate in product_sales bereinigen
-- + Unique Constraint (product_name, sale_date, source)
-- ============================================================
-- Ausführen im Supabase SQL-Editor.
-- Voraussetzung: product_sales existiert (aus vorherigen Migrations).
--
-- SCHRITT 1: Bestehende Duplikate bereinigen
-- Behalte pro (product_name, sale_date, source) nur die Zeile mit der
-- höchsten ID (= neueste), lösche ältere Duplikate.
-- ============================================================

-- 1a. Zeige Duplikate vor der Bereinigung (zur Kontrolle)
SELECT
  product_name,
  sale_date,
  source,
  count(*) AS duplikate,
  sum(revenue) AS total_revenue_doppelt
FROM product_sales
GROUP BY product_name, sale_date, source
HAVING count(*) > 1
ORDER BY duplikate DESC
LIMIT 50;

-- 1b. Duplikate löschen (behalte je Gruppe den neuesten Eintrag = höchste id)
DELETE FROM product_sales
WHERE id NOT IN (
  SELECT DISTINCT ON (product_name, sale_date, source) id
  FROM product_sales
  ORDER BY product_name, sale_date, source, id DESC
);

-- 1c. Kontrolle nach Bereinigung (sollte 0 Zeilen liefern)
SELECT
  product_name, sale_date, source, count(*) AS n
FROM product_sales
GROUP BY product_name, sale_date, source
HAVING count(*) > 1;

-- ============================================================
-- SCHRITT 2: Unique Constraint hinzufügen
-- Verhindert künftige Duplikate auf Datenbankebene.
-- ============================================================
ALTER TABLE product_sales
  ADD CONSTRAINT product_sales_unique_per_day
  UNIQUE (product_name, sale_date, source);

-- ============================================================
-- SCHRITT 3: Index für Performance (Zeitraum-Abfragen)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_product_sales_source_date
  ON product_sales (source, sale_date);

-- ============================================================
-- Fertig. Prüfung:
-- SELECT count(*) FROM product_sales;  → Anzahl bereinigter Zeilen
-- ============================================================
