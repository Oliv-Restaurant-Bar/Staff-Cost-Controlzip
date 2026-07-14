-- ============================================================
-- Gastronovi Z-Bericht — RLS-Policy-Fix
-- Datum: 2026-06-19
-- Ausführen im Supabase SQL-Editor (nach allen 20260617_/20260618_ gn_-Migrationen)
-- ============================================================
--
-- PROBLEM (im Live-System reproduziert):
--   Beim Speichern eines Imports schlägt das INSERT fehl mit:
--     42501  new row violates row-level security policy for table "gn_imports"
--
-- URSACHE (durch Tests gegen die Live-DB bestätigt):
--   • RLS ist auf gn_imports (und den abhängigen gn_-Tabellen) AKTIVIERT,
--     ABER es existiert KEINE einzige Policy.  Ohne permissive Policy
--     verweigert Postgres bei aktiviertem RLS grundsätzlich jeden Zugriff.
--   • Das frühere "ALTER TABLE ... DISABLE ROW LEVEL SECURITY;" aus
--     20260617_gn_zbericht.sql ist im Live-System nicht wirksam geworden
--     (Tabelle wurde mit RLS=on angelegt / RLS wurde wieder aktiviert).
--   • Die GRANTs aus 20260617_gn_grants.sql sind vorhanden (authenticated,
--     anon).  Deshalb erscheint der RLS-Fehler und NICHT "permission denied"
--     für authenticated/anon.  service_role hatte hingegen gar keinen GRANT
--     ("permission denied for table gn_imports").
--
--   Anmeldung: Die App nutzt Supabase Auth (E-Mail/Passwort, siehe
--   src/contexts/AuthContext.tsx).  Eingeloggte Benutzer greifen mit der
--   Rolle `authenticated` zu.  Die rollenbasierte Feinsteuerung
--   (Admin/Manager) liegt in der React-App (usePermissions), nicht in der DB
--   — konsistent mit dem employee_wages-RLS-Fix (20260511).
--
-- LÖSUNG (kein Workaround — saubere Policies, Least Privilege):
--   RLS bleibt AKTIV.  Für jede gn_-Tabelle des Import-Speicherpfads gilt
--   ausschliesslich die Rolle `authenticated`:
--     • SELECT / INSERT / UPDATE / DELETE → authenticated
--   Die Rolle `anon` (unauthentifizierter, öffentlich ausgelieferter
--   Anon-Key) erhält KEINEN Zugriff auf diese Finanz-/Importdaten:
--   die zu weit gefassten anon-GRANTs aus 20260617_gn_grants.sql werden
--   wieder ENTZOGEN (REVOKE).  Die App liest diese Tabellen ohnehin nur im
--   eingeloggten Zustand.
--   GRANTs (Postgres prüft GRANT VOR RLS) für authenticated und service_role
--   (Letzteres fehlte und blockiert Admin-/Wartungszugriffe).
--
-- Idempotent: kann mehrfach ausgeführt werden (alte Policies werden zuerst
-- vollständig entfernt).
-- ============================================================

-- ── 1. RLS aktivieren + Policies + GRANTs für alle betroffenen Tabellen ──────

DO $$
DECLARE
  t       text;
  polname text;
  tbls    text[] := ARRAY[
    'gn_imports',
    'gn_revenue_summary',
    'gn_tax_summary',
    'gn_cost_centers',
    'gn_waiters',
    'gn_payment_methods',
    'gn_product_groups',
    'gn_discounts',
    'gn_cancellations',
    'gn_accounting_lines',
    'gn_payment_accounts',
    'gn_zbericht_daily'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    -- Tabelle evtl. noch nicht vorhanden? Dann überspringen (defensiv).
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE NOTICE 'Tabelle %.% existiert nicht — übersprungen.', 'public', t;
      CONTINUE;
    END IF;

    -- RLS aktiv halten.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);

    -- Sauberer Neustart: ALLE bestehenden Policies dieser Tabelle entfernen.
    FOR polname IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I;', polname, t);
    END LOOP;

    -- Neue Policies: ausschliesslich authenticated.
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
    -- Zu weit gefasste anon-Rechte aus 20260617_gn_grants.sql entziehen.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- PostgREST Schema-Cache neu laden (Policies/GRANTs sofort wirksam).
NOTIFY pgrst, 'reload schema';

-- ── 2. Selbsttest: authenticated darf jetzt in gn_imports schreiben ──────────
-- Fügt als Rolle `authenticated` eine Testzeile ein und entfernt sie wieder.
-- Erfolg → NOTICE.  Weiterhin blockiert → harter Abbruch (EXCEPTION), damit
-- ein noch defekter RLS-Zustand nicht übersehen werden kann.

DO $$
DECLARE
  new_id uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  INSERT INTO public.gn_imports (restaurant_id, file_name, status)
  VALUES ('__rls_selftest__', '__rls_selftest__.csv', 'active')
  RETURNING id INTO new_id;
  RESET ROLE;                       -- zurück zum Owner (umgeht RLS beim Aufräumen)
  DELETE FROM public.gn_imports WHERE id = new_id;
  RAISE NOTICE '=== Selbsttest OK: authenticated INSERT in gn_imports erlaubt (Testzeile entfernt). ===';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: authenticated INSERT weiterhin blockiert (RLS/GRANT pruefen).';
END $$;

-- ── 3. Verifikation: Policies pro Tabelle anzeigen ──────────────────────────

SELECT
  tablename,
  COUNT(*)                                          AS policy_count,
  string_agg(cmd || ':' || array_to_string(roles, '/'), ', ' ORDER BY cmd) AS policies
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename LIKE 'gn_%'
GROUP BY tablename
ORDER BY tablename;
