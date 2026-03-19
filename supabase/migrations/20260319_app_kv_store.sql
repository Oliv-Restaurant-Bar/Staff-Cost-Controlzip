-- Allgemeiner Key-Value-Speicher für App-Daten (Reporting, Budget, Tagesdaten)
CREATE TABLE IF NOT EXISTS public.app_kv_store (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.app_kv_store ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read and write app_kv_store"
  ON public.app_kv_store
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
