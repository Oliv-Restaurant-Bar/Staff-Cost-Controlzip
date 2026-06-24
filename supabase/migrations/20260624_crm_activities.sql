-- ============================================================
-- Gäste-CRM — Segment-Aktionen: Aktivitäten + Kontaktlisten
-- Datum: 2026-06-24
-- Ausführen im Supabase SQL-Editor (NACH 20260622_guest_crm_profiles.sql).
-- ============================================================
--
-- ZWECK:
--   Speichert INTERNE, manuell ausgelöste CRM-Aktionen je Gast (keine
--   E-Mails/WhatsApp, keine externen Integrationen):
--
--     guest_crm_activities  — eine Zeile je Gast und Aktion. Der Typ
--       (activity_type) unterscheidet:
--         'contacted'  → „als kontaktiert markiert" (contacted_on Pflicht),
--         'note'       → interne Notiz (note Pflicht, nicht leer),
--         'follow_up'  → Folgeaufgabe (due_date + status Pflicht).
--       Sammelaktionen über ein ganzes Segment / eine Auswahl werden über
--       eine gemeinsame batch_id gruppiert (eine Zeile pro Gast).
--
--     guest_crm_contact_lists — benannte Kontaktliste mit einem JSONB-
--       Schnappschuss der Gäste-IDs (guest_ids) + member_count.
--
--   STRIKT GETRENNT von den automatisch berechneten CRM-Kennzahlen/Segmenten
--   (reservation-crm.ts) und vom manuellen Profil (guest_crm_profiles) —
--   diese werden NICHT verändert.
--
-- MANDANTENTRENNUNG:
--   Beide Tabellen tragen restaurant_id TEXT NOT NULL. Jeder Lese-/Schreib-
--   zugriff der App filtert nach restaurant_id; vor jedem Schreibvorgang prüft
--   die App zusätzlich, dass alle betroffenen Gäste zum Mandanten gehören
--   (verifyGuestsBelongToTenant). guest_id verweist auf guest_profiles (FK,
--   ON DELETE CASCADE) — wird ein Gast gelöscht, verschwinden seine
--   Aktivitäten automatisch.
--
-- DATENSCHUTZ (identisch zu guest_profiles/guest_crm_profiles):
--   created_by ist NUR die Operator-UUID (kein Name/keine E-Mail). RLS aktiv,
--   ausschliesslich `authenticated` + `service_role`, `anon` erhält KEINE
--   Rechte. Die rollenbasierte Feinsteuerung (Admin) liegt in der React-App.
--
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================

-- gen_random_uuid() für die Primärschlüssel.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. Tabelle: guest_crm_activities ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS guest_crm_activities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id TEXT NOT NULL,
  guest_id      UUID NOT NULL REFERENCES guest_profiles(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('contacted', 'note', 'follow_up')),
  segment_key   TEXT,
  note          TEXT,
  due_date      DATE,
  status        TEXT CHECK (status IN ('open', 'done')),
  contacted_on  DATE,
  batch_id      UUID,
  created_by    UUID,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Typ-spezifische Integrität: Pflichtfelder gesetzt, fremde Felder leer.
  CONSTRAINT guest_crm_activities_type_fields CHECK (
    (activity_type = 'contacted'
      AND contacted_on IS NOT NULL
      AND due_date IS NULL AND status IS NULL)
    OR (activity_type = 'note'
      AND note IS NOT NULL AND length(btrim(note)) > 0
      AND due_date IS NULL AND status IS NULL AND contacted_on IS NULL)
    OR (activity_type = 'follow_up'
      AND due_date IS NOT NULL AND status IS NOT NULL
      AND contacted_on IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS guest_crm_activities_guest_idx
  ON guest_crm_activities (restaurant_id, guest_id);
CREATE INDEX IF NOT EXISTS guest_crm_activities_type_idx
  ON guest_crm_activities (restaurant_id, activity_type);
CREATE INDEX IF NOT EXISTS guest_crm_activities_batch_idx
  ON guest_crm_activities (batch_id);

-- ── 2. Tabelle: guest_crm_contact_lists ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS guest_crm_contact_lists (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  segment_key   TEXT,
  guest_ids     JSONB NOT NULL DEFAULT '[]'::jsonb,
  member_count  INTEGER NOT NULL DEFAULT 0,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT guest_crm_contact_lists_guest_ids_array
    CHECK (jsonb_typeof(guest_ids) = 'array')
);

CREATE INDEX IF NOT EXISTS guest_crm_contact_lists_rest_idx
  ON guest_crm_contact_lists (restaurant_id, created_at DESC);

-- ── 3. RLS + Policies + Grants (authenticated only, kein anon) ───────────────

DO $$
DECLARE
  tbl     text;
  polname text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['guest_crm_activities', 'guest_crm_contact_lists']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', tbl);

    -- Sauberer Neustart: bestehende Policies entfernen.
    FOR polname IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = tbl
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I;', polname, tbl);
    END LOOP;

    -- Ausschliesslich authenticated.
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true);', tbl || '_select', tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (true);', tbl || '_insert', tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (true) WITH CHECK (true);', tbl || '_update', tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (true);', tbl || '_delete', tbl);

    -- GRANTs (Postgres prüft GRANT VOR RLS).
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated;', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role;', tbl);
    -- PII-nah (Operator-UUID + Gästebezug): anon erhält KEINEN Zugriff.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', tbl);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO authenticated, service_role;

-- PostgREST Schema-Cache neu laden (Policies/GRANTs sofort wirksam).
NOTIFY pgrst, 'reload schema';

-- ── 4. Selbsttest: authenticated darf schreiben, anon nicht lesen ────────────

DO $$
DECLARE
  test_guest uuid;
BEGIN
  -- Temporäres Gästeprofil als Tabellenbesitzer anlegen (für die FK-Beziehung).
  INSERT INTO public.guest_profiles (restaurant_id, match_key)
  VALUES ('__rls_selftest__', 'name:__rls_selftest__')
  RETURNING id INTO test_guest;

  SET LOCAL ROLE authenticated;
  INSERT INTO public.guest_crm_activities (restaurant_id, guest_id, activity_type, contacted_on)
  VALUES ('__rls_selftest__', test_guest, 'contacted', CURRENT_DATE);
  INSERT INTO public.guest_crm_activities (restaurant_id, guest_id, activity_type, note)
  VALUES ('__rls_selftest__', test_guest, 'note', '__rls_selftest__');
  INSERT INTO public.guest_crm_activities (restaurant_id, guest_id, activity_type, due_date, status)
  VALUES ('__rls_selftest__', test_guest, 'follow_up', CURRENT_DATE, 'open');
  INSERT INTO public.guest_crm_contact_lists (restaurant_id, name, guest_ids, member_count)
  VALUES ('__rls_selftest__', '__rls_selftest__', to_jsonb(ARRAY[test_guest::text]), 1);
  RESET ROLE;

  -- Cascade-Cleanup der Aktivitäten via guest_profiles; Kontaktliste explizit.
  DELETE FROM public.guest_crm_contact_lists WHERE restaurant_id = '__rls_selftest__';
  DELETE FROM public.guest_profiles WHERE id = test_guest;
  RAISE NOTICE '=== Selbsttest OK: authenticated INSERT auf guest_crm_activities/_contact_lists erlaubt (Testdaten entfernt). ===';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    DELETE FROM public.guest_crm_contact_lists WHERE restaurant_id = '__rls_selftest__';
    DELETE FROM public.guest_profiles WHERE restaurant_id = '__rls_selftest__';
    RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: authenticated INSERT blockiert (RLS/GRANT pruefen).';
END $$;

DO $$
BEGIN
  SET LOCAL ROLE anon;
  PERFORM 1 FROM public.guest_crm_activities LIMIT 1;
  RESET ROLE;
  RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: anon konnte guest_crm_activities lesen (Datenleck!).';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '=== Selbsttest OK: anon-Zugriff auf guest_crm_activities blockiert. ===';
END $$;

-- ── 5. Verifikation: Policies + anon-Rechte anzeigen ─────────────────────────

SELECT
  tablename,
  COUNT(*)                                          AS policy_count,
  string_agg(cmd || ':' || array_to_string(roles, '/'), ', ' ORDER BY cmd) AS policies
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('guest_crm_activities', 'guest_crm_contact_lists')
GROUP BY tablename;

-- anon darf KEINE Tabellen-Rechte haben (Ergebnis sollte leer sein):
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'anon'
  AND table_name IN ('guest_crm_activities', 'guest_crm_contact_lists');
