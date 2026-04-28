-- ============================================================
-- produkte_kosten: Tabelle erstellen (mit Multi-Tenant Support)
-- ============================================================
-- Erstellt die Tabelle mit restaurant_id, damit Beaulieu und Oliv
-- getrennte Produktdaten führen können.
--
-- Falls die Tabelle bereits existiert (ohne restaurant_id):
--   ALTER TABLE public.produkte_kosten ADD COLUMN IF NOT EXISTS restaurant_id TEXT NOT NULL DEFAULT 'oliv';
--
-- NEU erstellen (falls Tabelle noch nicht vorhanden):
-- ============================================================

CREATE TABLE IF NOT EXISTS public.produkte_kosten (
  id            BIGSERIAL     PRIMARY KEY,
  restaurant_id TEXT          NOT NULL DEFAULT 'oliv',
  name          TEXT          NOT NULL,
  category      TEXT          NOT NULL CHECK (category IN ('food', 'beverage')),
  brutto_price  NUMERIC(10,4) NOT NULL DEFAULT 0,
  netto_price   NUMERIC(10,4) NOT NULL DEFAULT 0,
  wes           NUMERIC(10,4) NOT NULL DEFAULT 0,
  wes_q         NUMERIC(10,4) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (restaurant_id, name, category)
);

-- Falls die Tabelle schon existiert aber restaurant_id fehlt:
ALTER TABLE public.produkte_kosten
  ADD COLUMN IF NOT EXISTS restaurant_id TEXT NOT NULL DEFAULT 'oliv';

-- Unique constraint auf (restaurant_id, name, category) sicherstellen
-- (Alter constraint (name, category) muss evtl. zuerst gelöscht werden)
DO $$
BEGIN
  -- Alten Unique-Constraint entfernen falls vorhanden
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'produkte_kosten_name_category_key'
    AND conrelid = 'public.produkte_kosten'::regclass
  ) THEN
    ALTER TABLE public.produkte_kosten DROP CONSTRAINT produkte_kosten_name_category_key;
  END IF;
  -- Neuen Constraint hinzufügen falls nicht vorhanden
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

-- Index für schnelle Tenant-Abfragen
CREATE INDEX IF NOT EXISTS idx_produkte_kosten_restaurant_id
  ON public.produkte_kosten (restaurant_id);

-- RLS aktivieren
ALTER TABLE public.produkte_kosten ENABLE ROW LEVEL SECURITY;

-- Policy: eingeloggte Benutzer können lesen und schreiben
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'produkte_kosten'
    AND policyname = 'Authenticated users can read and write produkte_kosten'
  ) THEN
    CREATE POLICY "Authenticated users can read and write produkte_kosten"
      ON public.produkte_kosten
      FOR ALL
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
