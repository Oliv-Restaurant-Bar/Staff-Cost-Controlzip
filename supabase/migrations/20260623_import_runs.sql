-- ============================================================
-- Import-Historie (Foratable) — gemeinsame Log-Tabelle `import_runs`
-- Datum: 2026-06-23
-- Ausführen im Supabase SQL-Editor (nach allen bestehenden Migrationen).
-- ============================================================
--
-- ZWECK:
--   Ein einheitliches Import-Protokoll für BEIDE Foratable-Importe
--   (Reservationen-Import und Gästeexport/CRM-Anreicherung). Jeder Importlauf
--   schreibt genau eine Zeile mit Zeitstempel (aus der DB), Mandant, Dateiname,
--   Status, Kennzahlen (stats_json) und ggf. Fehlermeldung.
--
-- DATENSCHUTZ:
--   Diese Tabelle enthält KEINE personenbezogenen Gästedaten (keine Namen,
--   E-Mails, Telefonnummern). Gespeichert werden nur Aggregat-Kennzahlen,
--   der Dateiname und — falls verfügbar — die UUID des importierenden Benutzers
--   (`created_by`, kein Klartext-Name/E-Mail). RLS ist aktiv und gewährt
--   ausschliesslich der Rolle `authenticated` Zugriff; `anon` erhält KEINE
--   Rechte; `service_role` erhält vollen Zugriff. Muster identisch zu
--   20260621_reservations.sql.
--
--   Die rollenbasierte Feinsteuerung (Admin/Manager) liegt in der React-App
--   (usePermissions), nicht in der DB — konsistent mit dem Projektmuster.
--
-- Bestehende Tabellen werden NICHT verändert.
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================

-- ── 1. Tabelle ──────────────────────────────────────────────────────────────

-- Ein Eintrag pro Importlauf (beide Importtypen teilen sich diese Tabelle).
CREATE TABLE IF NOT EXISTS import_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id TEXT NOT NULL,                 -- Mandant ('oliv' | 'beaulieu')
  import_type   TEXT NOT NULL,                 -- 'reservations' | 'guest_export'
  file_name     TEXT,
  status        TEXT NOT NULL DEFAULT 'success', -- 'success' | 'failed'
  record_count  INTEGER,                       -- Anzahl verarbeiteter Datensätze (Schnellanzeige)
  period_from   DATE,                          -- ableitbarer Datenzeitraum (falls vorhanden)
  period_to     DATE,
  error_message TEXT,
  stats_json    JSONB,                         -- normalisierte Kennzahlen (inserted/updated/skipped/…)
  created_by    UUID,                          -- auth.uid() des Benutzers (keine PII, optional)
  started_at    TIMESTAMPTZ,                   -- Beginn des Importlaufs (Client)
  finished_at   TIMESTAMPTZ DEFAULT now(),     -- Ende — DB-Zeitstempel (massgeblich)
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_runs_restaurant       ON import_runs(restaurant_id, finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_runs_restaurant_type  ON import_runs(restaurant_id, import_type, finished_at DESC);

-- ── 2. RLS + Policies + Grants (authenticated only, kein anon) ───────────────

DO $$
DECLARE
  t       text := 'import_runs';
  polname text;
BEGIN
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
END $$;

GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- PostgREST Schema-Cache neu laden (Policies/GRANTs sofort wirksam).
NOTIFY pgrst, 'reload schema';

-- ── 3. Selbsttest: authenticated darf schreiben, anon NICHT ──────────────────

DO $$
DECLARE
  new_id uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  INSERT INTO public.import_runs (restaurant_id, import_type, file_name, status)
  VALUES ('__rls_selftest__', 'reservations', '__rls_selftest__.csv', 'success')
  RETURNING id INTO new_id;
  RESET ROLE;
  DELETE FROM public.import_runs WHERE id = new_id;
  RAISE NOTICE '=== Selbsttest OK: authenticated INSERT in import_runs erlaubt (Testzeile entfernt). ===';
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
  AND tablename = 'import_runs'
GROUP BY tablename;

-- anon darf KEINE Tabellen-Rechte haben (Ergebnis sollte leer sein):
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'anon'
  AND table_name = 'import_runs';
