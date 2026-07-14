-- Zentrale Produktdatenbank für WES-Kosten (Food & Beverage)
CREATE TABLE IF NOT EXISTS public.produkte_kosten (
  id           BIGSERIAL   PRIMARY KEY,
  name         TEXT        NOT NULL,
  category     TEXT        NOT NULL CHECK (category IN ('food', 'beverage')),
  brutto_price NUMERIC(10,4) NOT NULL DEFAULT 0,
  netto_price  NUMERIC(10,4) NOT NULL DEFAULT 0,
  wes          NUMERIC(10,4) NOT NULL DEFAULT 0,
  wes_q        NUMERIC(10,4) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (name, category)
);

ALTER TABLE public.produkte_kosten ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read and write produkte_kosten"
  ON public.produkte_kosten
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
