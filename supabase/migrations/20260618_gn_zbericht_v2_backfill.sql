-- ============================================================
-- Gastronovi Z-Bericht v2 — Backfill bestehender Importe
-- Ausführen NACH 20260618_gn_zbericht_v2.sql
--
-- Füllt die neuen Spalten aus dem bereits gespeicherten
-- raw_csv_json (GnParsedZBericht-Objekt) für alle Zeilen,
-- die vor der v2-Migration importiert wurden.
--
-- Feld-Mapping (entspricht saveGnImport in gn-zbericht-db.ts):
--   gross_revenue       ← raw_csv_json → revenue → totalGross
--   net_revenue         ← raw_csv_json → taxNetTotal
--   food_revenue        ← raw_csv_json → foodAmount
--   bev_revenue         ← raw_csv_json → bevAmount
--   take_away_revenue   ← raw_csv_json → takeAwayAmount
--   discount_total      ← raw_csv_json → discountTotal
--   cancellation_total  ← raw_csv_json → stornoTotal   ← ACHTUNG: stornoTotal, nicht cancellationTotal!
--   receipts_count      ← raw_csv_json → bonCount
--   avg_receipt         ← raw_csv_json → avgBon
--   import_type         ← berechnet aus period_from / period_to
--   aggregation_level   ← berechnet aus period_from / period_to
--
-- NULLIF(..., 0): JavaScript-Verhalten nachbilden (0 || null → NULL)
-- ============================================================

-- Schritt 1: Validierung vor dem Backfill
-- Zeigt wie viele Zeilen betroffen sind
SELECT
  COUNT(*)                                          AS total_imports,
  COUNT(*) FILTER (WHERE gross_revenue IS NULL
                     AND raw_csv_json IS NOT NULL)  AS to_backfill,
  COUNT(*) FILTER (WHERE gross_revenue IS NOT NULL) AS already_filled
FROM gn_imports
WHERE status IN ('active', 'replaced');

-- Schritt 2: Backfill — alle neun KPI-Spalten + import_type + aggregation_level
UPDATE gn_imports
SET
  gross_revenue       = NULLIF((raw_csv_json->'revenue'->>'totalGross')::numeric,    0),
  net_revenue         = NULLIF((raw_csv_json->>'taxNetTotal')::numeric,               0),
  food_revenue        = NULLIF((raw_csv_json->>'foodAmount')::numeric,                0),
  bev_revenue         = NULLIF((raw_csv_json->>'bevAmount')::numeric,                 0),
  take_away_revenue   = NULLIF((raw_csv_json->>'takeAwayAmount')::numeric,            0),
  discount_total      = NULLIF((raw_csv_json->>'discountTotal')::numeric,             0),
  cancellation_total  = NULLIF((raw_csv_json->>'stornoTotal')::numeric,               0),
  receipts_count      = NULLIF((raw_csv_json->>'bonCount')::integer,                  0),
  avg_receipt         = NULLIF((raw_csv_json->>'avgBon')::numeric,                    0),

  import_type = CASE
    WHEN period_from IS NULL OR period_to IS NULL                        THEN 'period'
    WHEN period_to = period_from                                         THEN 'daily'
    WHEN (period_to - period_from) + 1 BETWEEN 2   AND 7               THEN 'weekly'
    WHEN (period_to - period_from) + 1 BETWEEN 28  AND 32              THEN 'monthly'
    ELSE 'period'
  END,

  aggregation_level = CASE
    WHEN period_from IS NOT NULL AND period_to = period_from THEN 'day'
    ELSE 'period'
  END

WHERE gross_revenue IS NULL
  AND raw_csv_json IS NOT NULL;

-- Schritt 3: Validierung nach dem Backfill
-- Ergebnis sollte "to_backfill = 0" zeigen
SELECT
  COUNT(*)                                          AS total_imports,
  COUNT(*) FILTER (WHERE gross_revenue IS NULL
                     AND raw_csv_json IS NOT NULL)  AS to_backfill_remaining,
  COUNT(*) FILTER (WHERE gross_revenue IS NOT NULL) AS filled,
  SUM(gross_revenue)                                AS total_gross_sum
FROM gn_imports
WHERE status IN ('active', 'replaced');
