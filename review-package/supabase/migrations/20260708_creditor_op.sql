-- ============================================================
-- Kreditoren-OP-Listen-Tool (Phase 1) — Tabellen, Indizes, RLS, Grants
-- Datum: 2026-07-08
-- Ausführen im Supabase SQL-Editor (nach allen bestehenden Migrationen).
-- ============================================================
--
-- ZWECK:
--   Monatliche Kreditoren-OP-Listen (PDF "Offene Posten mit Fälligkeiten
--   Kreditoren") werden als Snapshots gespeichert: ein Import pro Stichtag
--   (creditor_op_imports) mit Einzelposten (creditor_op_items).
--
-- LIFECYCLE (kein delete-then-insert, Muster gn_imports):
--   status = 'processing' → 'active' | 'replaced' | 'deleted'.
--   Reads filtern status='active'. Der partielle Unique-Index stellt sicher,
--   dass pro (restaurant_id, snapshot_date) NIE zwei aktive Importe existieren.
--
-- DATENSCHUTZ:
--   KEINE personenbezogenen Daten — nur Firmen-/Behördennamen, Beträge,
--   Rechnungsnummern. RLS aktiv: ausschliesslich `authenticated`; `anon`
--   erhält KEINE Rechte; `service_role` voll. Muster identisch zu
--   20260623_import_runs.sql. Rollen-Feinsteuerung liegt in der React-App.
--
-- Bestehende Tabellen werden NICHT verändert.
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================

-- ── 1. Tabellen ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS creditor_op_imports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     TEXT NOT NULL,                    -- Mandant ('oliv' | 'beaulieu')
  snapshot_date     DATE NOT NULL,                    -- OP-Stichdatum
  imported_at       TIMESTAMPTZ DEFAULT now(),
  source_filename   TEXT,
  total_open_amount NUMERIC(12,2),                    -- Gesamtsaldo lt. PDF (Fallback: Summe Einzelposten)
  total_items       INTEGER,                          -- Anzahl erkannter Posten
  supplier_count    INTEGER,                          -- Anzahl erkannter Lieferanten
  status            TEXT NOT NULL DEFAULT 'processing', -- 'processing'|'active'|'replaced'|'deleted'
  raw_totals_json   JSONB,                            -- PDF-Totale + Warnungen (Diagnose)
  created_by        UUID,                             -- auth.uid() (keine PII)
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- Pro Mandant+Stichtag höchstens EIN aktiver Import (Replace-Flow-sicher,
-- da neue Importe als 'processing' starten und erst nach dem Ersetzen des
-- alten Imports auf 'active' gesetzt werden).
CREATE UNIQUE INDEX IF NOT EXISTS uq_creditor_op_imports_active
  ON creditor_op_imports(restaurant_id, snapshot_date)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_creditor_op_imports_restaurant
  ON creditor_op_imports(restaurant_id, snapshot_date DESC);

CREATE TABLE IF NOT EXISTS creditor_op_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id        UUID NOT NULL REFERENCES creditor_op_imports(id) ON DELETE CASCADE,
  restaurant_id    TEXT NOT NULL,
  supplier_name    TEXT NOT NULL,
  op_date          DATE,
  op_number        TEXT,
  invoice_text     TEXT,
  open_amount      NUMERIC(12,2) NOT NULL,
  -- Fälligkeits-Buckets lt. PDF (NULL = im PDF nicht zuordenbar)
  overdue_29_plus  NUMERIC(12,2),
  overdue_since_29 NUMERIC(12,2),
  overdue_since_14 NUMERIC(12,2),
  due_in_15        NUMERIC(12,2),
  due_in_30        NUMERIC(12,2),
  due_after_30     NUMERIC(12,2),
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creditor_op_items_import
  ON creditor_op_items(import_id);
CREATE INDEX IF NOT EXISTS idx_creditor_op_items_supplier
  ON creditor_op_items(restaurant_id, supplier_name);

-- ── 2. RLS + Policies + Grants (authenticated only, kein anon) ───────────────

DO $$
DECLARE
  t       text;
  polname text;
BEGIN
  FOREACH t IN ARRAY ARRAY['creditor_op_imports', 'creditor_op_items'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);

    -- Sauberer Neustart: bestehende Policies entfernen.
    FOR polname IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I;', polname, t);
    END LOOP;

    -- Ausschliesslich authenticated.
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true);',
      t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (true);',
      t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (true) WITH CHECK (true);',
      t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (true);',
      t || '_delete', t);

    -- GRANTs (Postgres prüft GRANT VOR RLS).
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated;', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role;', t);
    -- anon erhält KEINEN Zugriff.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- PostgREST Schema-Cache neu laden (Policies/GRANTs sofort wirksam).
NOTIFY pgrst, 'reload schema';

-- ── 3. Selbsttest: authenticated darf schreiben, Testdaten werden entfernt ───

DO $$
DECLARE
  new_import uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  INSERT INTO public.creditor_op_imports (restaurant_id, snapshot_date, status, source_filename)
  VALUES ('__rls_selftest__', '1999-01-01', 'deleted', '__rls_selftest__.pdf')
  RETURNING id INTO new_import;
  INSERT INTO public.creditor_op_items (import_id, restaurant_id, supplier_name, open_amount)
  VALUES (new_import, '__rls_selftest__', '__rls_selftest__', 1.00);
  RESET ROLE;
  DELETE FROM public.creditor_op_imports WHERE id = new_import; -- CASCADE räumt Items ab
  RAISE NOTICE '=== Selbsttest OK: authenticated INSERT in creditor_op_* erlaubt (Testzeilen entfernt). ===';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: authenticated INSERT blockiert (RLS/GRANT pruefen).';
END $$;

-- ── 4. Verifikation: Policies + anon-Rechte anzeigen ─────────────────────────

SELECT
  tablename,
  COUNT(*)                                          AS policy_count,
  string_agg(cmd || ':' || array_to_string(roles, '/'), ', ' ORDER BY cmd) AS policies
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('creditor_op_imports', 'creditor_op_items')
GROUP BY tablename;

-- anon darf KEINE Tabellen-Rechte haben (Ergebnis sollte leer sein):
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'anon'
  AND table_name IN ('creditor_op_imports', 'creditor_op_items');
