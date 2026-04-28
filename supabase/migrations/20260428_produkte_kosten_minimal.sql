-- Minimale Migration: produkte_kosten mit restaurant_id
-- Sicher idempotent – kann mehrfach ausgeführt werden.
-- Schritt 1: Tabelle erstellen (falls noch nicht vorhanden)

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

-- Schritt 2: restaurant_id hinzufügen (falls Tabelle schon ohne existierte)
ALTER TABLE public.produkte_kosten
  ADD COLUMN IF NOT EXISTS restaurant_id TEXT NOT NULL DEFAULT 'oliv';

-- Schritt 3: RLS aktivieren
ALTER TABLE public.produkte_kosten ENABLE ROW LEVEL SECURITY;

-- Schritt 4: Policy (alten löschen und neu erstellen – sicher idempotent)
DROP POLICY IF EXISTS "Authenticated users can read and write produkte_kosten" ON public.produkte_kosten;
DROP POLICY IF EXISTS "produkte_kosten_auth_all" ON public.produkte_kosten;

CREATE POLICY "produkte_kosten_auth_all"
  ON public.produkte_kosten
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
