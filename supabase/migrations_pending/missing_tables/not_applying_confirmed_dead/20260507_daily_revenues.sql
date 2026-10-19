-- ============================================================
-- Migration: daily_revenues
-- ============================================================
-- Ziel: Single Source of Truth für Tagesumsätze.
-- Ersetzt den dailyBudgets-JSON-Blob in app_settings.
--
-- Vorteile gegenüber Blob-Speicher:
--   - Atomares UPSERT pro Tag → kein Blob-Overwrite-Risiko
--   - Eindeutiger Constraint (restaurant_id, date) → kein Duplikat
--   - Revisionslog via sales_upload_log Tabelle
--   - Direkte SQL-Abfragen für Reporting
--   - Kein Race-Condition-Risiko bei konkurrierenden Writes
--
-- ANLEITUNG:
--   1. Dieses SQL im Supabase SQL-Editor ausführen.
--   2. In einem zweiten Schritt die Datenmigration aus app_settings
--      durchführen (siehe Kommentar am Ende dieser Datei).
--
-- Hinweis zur Tenant-Isolation:
--   restaurant_id = 'oliv' | 'beaulieu'
--   Entspricht den bisherigen KV-Prefixen ('dailyBudgets' vs 'beaulieu:dailyBudgets').
-- ============================================================

-- 1. Haupttabelle: ein Eintrag pro Restaurant + Tag
CREATE TABLE IF NOT EXISTS daily_revenues (
  id                    uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id         text            NOT NULL,
  date                  date            NOT NULL,
  actual_revenue        numeric(12, 2)  NOT NULL DEFAULT 0,
  takeaway_revenue      numeric(12, 2)  NOT NULL DEFAULT 0,
  food_revenue          numeric(12, 2)  NOT NULL DEFAULT 0,
  beverage_revenue      numeric(12, 2)  NOT NULL DEFAULT 0,
  previous_year_revenue numeric(12, 2)  NOT NULL DEFAULT 0,
  previous_year_food    numeric(12, 2)  NOT NULL DEFAULT 0,
  previous_year_beverage numeric(12, 2) NOT NULL DEFAULT 0,
  planned_revenue       numeric(12, 2)  NOT NULL DEFAULT 0,
  planned_labor_cost    numeric(12, 2)  NOT NULL DEFAULT 0,
  actual_labor_cost     numeric(12, 2)  NOT NULL DEFAULT 0,
  source                text,           -- 'gastronovi_import' | 'manual' | 'vj_seed'
  notes                 text,
  created_at            timestamptz     NOT NULL DEFAULT now(),
  updated_at            timestamptz     NOT NULL DEFAULT now(),

  CONSTRAINT daily_revenues_restaurant_date_unique UNIQUE (restaurant_id, date)
);

-- 2. Automatisches updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS daily_revenues_updated_at ON daily_revenues;
CREATE TRIGGER daily_revenues_updated_at
  BEFORE UPDATE ON daily_revenues
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Indizes für Performance
CREATE INDEX IF NOT EXISTS daily_revenues_restaurant_date_idx
  ON daily_revenues (restaurant_id, date DESC);

CREATE INDEX IF NOT EXISTS daily_revenues_date_idx
  ON daily_revenues (date DESC);

-- 4. Upload-Audit-Log (welcher User hat wann was hochgeladen)
CREATE TABLE IF NOT EXISTS sales_upload_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   text        NOT NULL,
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  uploaded_by     uuid        REFERENCES auth.users(id),
  source          text        NOT NULL,  -- 'gastronovi_excel' | 'manual' | 'csv_import'
  date_from       date        NOT NULL,
  date_to         date        NOT NULL,
  days_inserted   integer     NOT NULL DEFAULT 0,
  days_updated    integer     NOT NULL DEFAULT 0,
  days_skipped    integer     NOT NULL DEFAULT 0,
  total_revenue   numeric(12, 2),
  notes           text
);

CREATE INDEX IF NOT EXISTS sales_upload_log_restaurant_idx
  ON sales_upload_log (restaurant_id, uploaded_at DESC);

-- 5. RLS aktivieren
ALTER TABLE daily_revenues   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_upload_log ENABLE ROW LEVEL SECURITY;

-- 6. RLS-Policies (eingeloggte User dürfen lesen und schreiben)
DROP POLICY IF EXISTS "daily_revenues_select" ON daily_revenues;
CREATE POLICY "daily_revenues_select"
  ON daily_revenues FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "daily_revenues_insert" ON daily_revenues;
CREATE POLICY "daily_revenues_insert"
  ON daily_revenues FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "daily_revenues_update" ON daily_revenues;
CREATE POLICY "daily_revenues_update"
  ON daily_revenues FOR UPDATE
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "sales_upload_log_select" ON sales_upload_log;
CREATE POLICY "sales_upload_log_select"
  ON sales_upload_log FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "sales_upload_log_insert" ON sales_upload_log;
CREATE POLICY "sales_upload_log_insert"
  ON sales_upload_log FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ============================================================
-- DATENMIGRATION (nach Tabellenerstellung manuell ausführen)
-- Verschiebt bestehende dailyBudgets-Daten aus app_settings
-- in die neue daily_revenues-Tabelle.
--
-- WICHTIG: Erst ausführen wenn daily_revenues erstellt wurde.
-- Gibt einen Überblick welche Datensätze migriert werden.
-- ============================================================

/*
-- Vorschau: Was ist in app_settings unter 'dailyBudgets'?
SELECT
  key,
  jsonb_array_length(to_jsonb(array(SELECT jsonb_object_keys(value::jsonb)))) AS day_count
FROM app_settings
WHERE key IN ('dailyBudgets', 'beaulieu:dailyBudgets');

-- Migration Oliv (dailyBudgets → restaurant_id='oliv')
INSERT INTO daily_revenues (restaurant_id, date, actual_revenue, takeaway_revenue,
                            food_revenue, beverage_revenue, previous_year_revenue,
                            planned_revenue, source)
SELECT
  'oliv'                                           AS restaurant_id,
  (day_key)::date                                  AS date,
  COALESCE((day_val->>'actualRevenue')::numeric, 0) AS actual_revenue,
  COALESCE((day_val->>'takeawayRevenue')::numeric, 0) AS takeaway_revenue,
  COALESCE((day_val->>'actualFood')::numeric, 0)    AS food_revenue,
  COALESCE((day_val->>'actualBeverage')::numeric, 0) AS beverage_revenue,
  COALESCE((day_val->>'previousYearRevenue')::numeric, 0) AS previous_year_revenue,
  COALESCE((day_val->>'plannedRevenue')::numeric, 0) AS planned_revenue,
  'migrated_from_kv'                               AS source
FROM app_settings,
  jsonb_each(value::jsonb) AS kv(day_key, day_val)
WHERE key = 'dailyBudgets'
  AND (day_val->>'actualRevenue')::numeric > 0
ON CONFLICT (restaurant_id, date) DO UPDATE
  SET actual_revenue        = EXCLUDED.actual_revenue,
      takeaway_revenue      = EXCLUDED.takeaway_revenue,
      food_revenue          = EXCLUDED.food_revenue,
      beverage_revenue      = EXCLUDED.beverage_revenue,
      previous_year_revenue = EXCLUDED.previous_year_revenue,
      planned_revenue       = EXCLUDED.planned_revenue,
      updated_at            = now();

-- Migration Beaulieu (beaulieu:dailyBudgets → restaurant_id='beaulieu')
INSERT INTO daily_revenues (restaurant_id, date, actual_revenue, takeaway_revenue,
                            food_revenue, beverage_revenue, previous_year_revenue,
                            planned_revenue, source)
SELECT
  'beaulieu'                                       AS restaurant_id,
  (day_key)::date                                  AS date,
  COALESCE((day_val->>'actualRevenue')::numeric, 0) AS actual_revenue,
  COALESCE((day_val->>'takeawayRevenue')::numeric, 0) AS takeaway_revenue,
  COALESCE((day_val->>'actualFood')::numeric, 0)    AS food_revenue,
  COALESCE((day_val->>'actualBeverage')::numeric, 0) AS beverage_revenue,
  COALESCE((day_val->>'previousYearRevenue')::numeric, 0) AS previous_year_revenue,
  COALESCE((day_val->>'plannedRevenue')::numeric, 0) AS planned_revenue,
  'migrated_from_kv'                               AS source
FROM app_settings,
  jsonb_each(value::jsonb) AS kv(day_key, day_val)
WHERE key = 'beaulieu:dailyBudgets'
  AND (day_val->>'actualRevenue')::numeric > 0
ON CONFLICT (restaurant_id, date) DO UPDATE
  SET actual_revenue        = EXCLUDED.actual_revenue,
      takeaway_revenue      = EXCLUDED.takeaway_revenue,
      food_revenue          = EXCLUDED.food_revenue,
      beverage_revenue      = EXCLUDED.beverage_revenue,
      previous_year_revenue = EXCLUDED.previous_year_revenue,
      planned_revenue       = EXCLUDED.planned_revenue,
      updated_at            = now();
*/
