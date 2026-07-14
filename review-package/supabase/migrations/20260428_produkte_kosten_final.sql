-- ============================================================
-- FINALE MIGRATION: produkte_kosten (Multi-Tenant)
-- ============================================================
-- Erstellt die Tabelle neu ODER ergänzt restaurant_id falls
-- die Tabelle bereits ohne Multi-Tenant-Spalte existiert.
--
-- Ausführen im Supabase SQL-Editor (Dashboard → SQL Editor)
-- ============================================================

-- 1. Tabelle erstellen (falls nicht vorhanden)
CREATE TABLE IF NOT EXISTS public.produkte_kosten (
  id            BIGSERIAL     PRIMARY KEY,
  restaurant_id TEXT          NOT NULL DEFAULT 'oliv',
  name          TEXT          NOT NULL,
  category      TEXT          NOT NULL CHECK (category IN ('food', 'beverage')),
  brutto_price  NUMERIC(10,4) NOT NULL DEFAULT 0,
  netto_price   NUMERIC(10,4) NOT NULL DEFAULT 0,
  wes           NUMERIC(10,4) NOT NULL DEFAULT 0,
  wes_q         NUMERIC(10,4) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 2. restaurant_id ergänzen falls Tabelle schon ohne diese Spalte existiert
ALTER TABLE public.produkte_kosten
  ADD COLUMN IF NOT EXISTS restaurant_id TEXT NOT NULL DEFAULT 'oliv';

-- 3. Unique Constraint: alten (name, category) ersetzen durch (restaurant_id, name, category)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'produkte_kosten_name_category_key'
    AND conrelid = 'public.produkte_kosten'::regclass
  ) THEN
    ALTER TABLE public.produkte_kosten DROP CONSTRAINT produkte_kosten_name_category_key;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'produkte_kosten_restaurant_id_name_category_key'
    AND conrelid = 'public.produkte_kosten'::regclass
  ) THEN
    ALTER TABLE public.produkte_kosten
      ADD CONSTRAINT produkte_kosten_restaurant_id_name_category_key
      UNIQUE (restaurant_id, name, category);
  END IF;
END $$;

-- 4. Index für schnelle Tenant-Abfragen
CREATE INDEX IF NOT EXISTS idx_produkte_kosten_restaurant_id
  ON public.produkte_kosten (restaurant_id);

-- 5. Row Level Security aktivieren
ALTER TABLE public.produkte_kosten ENABLE ROW LEVEL SECURITY;

-- 6. RLS-Policy: eingeloggte Benutzer können alles lesen und schreiben
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'produkte_kosten'
    AND policyname = 'produkte_kosten_auth_all'
  ) THEN
    CREATE POLICY "produkte_kosten_auth_all"
      ON public.produkte_kosten
      FOR ALL
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- 7. PostgREST Schema-Cache neu laden
NOTIFY pgrst, 'reload schema';

-- 8. Kontrolle: Tabelle und Spalten anzeigen
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'produkte_kosten'
ORDER BY ordinal_position;
