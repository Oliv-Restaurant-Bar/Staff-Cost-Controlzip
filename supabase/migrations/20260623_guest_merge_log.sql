-- ============================================================
-- Gäste-Duplikate — Audit-Log für Zusammenführungen (guest_merge_log)
-- Datum: 2026-06-23
-- Ausführen im Supabase SQL-Editor (nach allen bestehenden Migrationen).
-- ============================================================
--
-- ZWECK:
--   Protokolliert JEDE Gäste-Zusammenführung (Duplikat-Merge) als Audit-Eintrag.
--   Die App schreibt diese Zeile NUR „best-effort" (Fehler werden verschluckt) —
--   ein Logging-Fehler darf eine erfolgreiche Zusammenführung nie zurückrollen.
--
-- DATENSCHUTZ:
--   Es werden AUSSCHLIESSLICH technische IDs + Zähler gespeichert (Mandant,
--   Master-Gast-ID, zusammengeführte Gast-IDs, Anzahlen, optional die Operator-
--   UUID).  KEINE personenbezogenen Gastdaten (kein Name/E-Mail/Telefon).
--
--   RLS aktiv: nur `authenticated` erhält Zugriff, `anon` KEINEN, `service_role`
--   vollen.  Muster identisch zu 20260621_reservations.sql.  Die rollenbasierte
--   Feinsteuerung (Admin/Manager) liegt in der React-App (usePermissions).
--
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================

-- ── 1. Tabelle ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS guest_merge_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id      TEXT NOT NULL,            -- Mandant ('oliv' | 'beaulieu')
  master_guest_id    UUID NOT NULL,            -- Ziel-Gast (bleibt erhalten)
  merged_guest_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- gelöschte Duplikat-IDs
  merged_count       INTEGER NOT NULL DEFAULT 0,          -- Anzahl gelöschter Duplikate
  reservations_moved INTEGER NOT NULL DEFAULT 0,          -- auf den Master umgehängte Reservationen
  crm_merged         BOOLEAN NOT NULL DEFAULT false,      -- wurden CRM-Profile zusammengeführt?
  created_by         UUID,                     -- Operator (auth.uid()) — KEINE PII
  created_at         TIMESTAMPTZ DEFAULT now() -- autoritativer DB-Zeitstempel
);

CREATE INDEX IF NOT EXISTS idx_guest_merge_log_restaurant ON guest_merge_log(restaurant_id, created_at);

-- ── 2. RLS + Policies + Grants (authenticated only, kein anon) ──────────────

DO $$
DECLARE
  polname text;
BEGIN
  EXECUTE 'ALTER TABLE public.guest_merge_log ENABLE ROW LEVEL SECURITY;';

  -- Sauberer Neustart: bestehende Policies entfernen.
  FOR polname IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'guest_merge_log'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.guest_merge_log;', polname);
  END LOOP;

  -- Ausschliesslich authenticated.
  CREATE POLICY guest_merge_log_select ON public.guest_merge_log FOR SELECT TO authenticated USING (true);
  CREATE POLICY guest_merge_log_insert ON public.guest_merge_log FOR INSERT TO authenticated WITH CHECK (true);
  CREATE POLICY guest_merge_log_update ON public.guest_merge_log FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
  CREATE POLICY guest_merge_log_delete ON public.guest_merge_log FOR DELETE TO authenticated USING (true);

  -- GRANTs (Postgres prüft GRANT VOR RLS).
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.guest_merge_log TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.guest_merge_log TO service_role;
  -- anon erhält KEINEN Zugriff.
  REVOKE ALL ON public.guest_merge_log FROM anon;
END $$;

GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- PostgREST Schema-Cache neu laden (Policies/GRANTs sofort wirksam).
NOTIFY pgrst, 'reload schema';

-- ── 3. Selbsttest: authenticated darf schreiben, anon NICHT ─────────────────

DO $$
DECLARE
  new_id uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  INSERT INTO public.guest_merge_log (restaurant_id, master_guest_id, merged_count)
  VALUES ('__rls_selftest__', gen_random_uuid(), 0)
  RETURNING id INTO new_id;
  RESET ROLE;
  DELETE FROM public.guest_merge_log WHERE id = new_id;
  RAISE NOTICE '=== Selbsttest OK: authenticated INSERT in guest_merge_log erlaubt (Testzeile entfernt). ===';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: authenticated INSERT blockiert (RLS/GRANT pruefen).';
END $$;

-- ── 4. Verifikation: Policies + anon-Rechte anzeigen ────────────────────────

SELECT
  tablename,
  COUNT(*)                                          AS policy_count,
  string_agg(cmd || ':' || array_to_string(roles, '/'), ', ' ORDER BY cmd) AS policies
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'guest_merge_log'
GROUP BY tablename;

-- anon darf KEINE Rechte haben (Ergebnis sollte leer sein):
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'anon'
  AND table_name = 'guest_merge_log';
