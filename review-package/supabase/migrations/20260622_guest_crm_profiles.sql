-- ============================================================
-- Gäste-CRM Phase 1 — manuelle CRM-Profile: Tabelle, RLS, Grants
-- Datum: 2026-06-22
-- Ausführen im Supabase SQL-Editor (NACH 20260621_reservations.sql).
-- ============================================================
--
-- ZWECK:
--   Speichert MANUELL gepflegte CRM-Daten je Gast (VIP/Stammgast-Flags,
--   Firmenkunde, Newsletter, gesperrt, Geburtstag, Firma, Sprache, Allergien,
--   Ernährungs-/CRM-Notizen, Lieblings-Tisch/-Bereich/-Wein/-Gericht).
--   STRIKT GETRENNT von den automatisch berechneten CRM-Kennzahlen
--   (guest_statistics / reservation-crm.ts) — diese bleiben unverändert.
--
--   1:1 zu guest_profiles über guest_id (PRIMARY KEY + FK, ON DELETE CASCADE):
--   wird ein Gästeprofil gelöscht, verschwindet auch sein manuelles CRM-Profil.
--   KEINE eigene restaurant_id-Spalte — die Mandantentrennung erfolgt in der App
--   (Tenant-Check über guest_profiles vor jedem Lese-/Schreibzugriff), da
--   guest_profiles.id global eindeutig ist.
--
-- DATENSCHUTZ (identisch zu guest_profiles/reservation_records):
--   Enthält personenbezogene Daten → RLS aktiv, ausschliesslich `authenticated`
--   + `service_role`, `anon` erhält KEINE Rechte. Die rollenbasierte
--   Feinsteuerung (Admin) liegt in der React-App (usePermissions).
--
-- guest_profiles, Importlogik und guest_statistics werden NICHT verändert.
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================

-- ── 1. Tabelle ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS guest_crm_profiles (
  guest_id          UUID PRIMARY KEY REFERENCES guest_profiles(id) ON DELETE CASCADE,
  vip_manual        BOOLEAN NOT NULL DEFAULT false,
  stammgast_manual  BOOLEAN NOT NULL DEFAULT false,
  company_customer  BOOLEAN NOT NULL DEFAULT false,
  newsletter_opt_in BOOLEAN NOT NULL DEFAULT false,
  blocked_guest     BOOLEAN NOT NULL DEFAULT false,
  birthday          DATE,
  company           TEXT,
  language          TEXT,
  allergies         TEXT,
  dietary_notes     TEXT,
  favorite_table    TEXT,
  favorite_area     TEXT,
  favorite_wine     TEXT,
  favorite_dish     TEXT,
  crm_notes         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 2. RLS + Policies + Grants (authenticated only, kein anon) ───────────────

DO $$
DECLARE
  polname text;
BEGIN
  ALTER TABLE public.guest_crm_profiles ENABLE ROW LEVEL SECURITY;

  -- Sauberer Neustart: bestehende Policies entfernen.
  FOR polname IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'guest_crm_profiles'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.guest_crm_profiles;', polname);
  END LOOP;

  -- Ausschliesslich authenticated.
  CREATE POLICY guest_crm_profiles_select ON public.guest_crm_profiles
    FOR SELECT TO authenticated USING (true);
  CREATE POLICY guest_crm_profiles_insert ON public.guest_crm_profiles
    FOR INSERT TO authenticated WITH CHECK (true);
  CREATE POLICY guest_crm_profiles_update ON public.guest_crm_profiles
    FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
  CREATE POLICY guest_crm_profiles_delete ON public.guest_crm_profiles
    FOR DELETE TO authenticated USING (true);

  -- GRANTs (Postgres prüft GRANT VOR RLS).
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.guest_crm_profiles TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.guest_crm_profiles TO service_role;
  -- PII: anon erhält KEINEN Zugriff.
  REVOKE ALL ON public.guest_crm_profiles FROM anon;
END $$;

GRANT USAGE ON SCHEMA public TO authenticated, service_role;

-- PostgREST Schema-Cache neu laden (Policies/GRANTs sofort wirksam).
NOTIFY pgrst, 'reload schema';

-- ── 3. Selbsttest: authenticated darf schreiben (FK-konform), anon nicht lesen ─

DO $$
DECLARE
  test_guest uuid;
BEGIN
  -- Temporäres Gästeprofil als Tabellenbesitzer anlegen (für die FK-Beziehung).
  INSERT INTO public.guest_profiles (restaurant_id, match_key)
  VALUES ('__rls_selftest__', 'name:__rls_selftest__')
  RETURNING id INTO test_guest;

  SET LOCAL ROLE authenticated;
  INSERT INTO public.guest_crm_profiles (guest_id, crm_notes)
  VALUES (test_guest, '__rls_selftest__');
  UPDATE public.guest_crm_profiles SET company = '__rls_selftest__' WHERE guest_id = test_guest;
  RESET ROLE;

  -- Cascade-Cleanup: Löschen des Gastes entfernt auch die CRM-Zeile.
  DELETE FROM public.guest_profiles WHERE id = test_guest;
  RAISE NOTICE '=== Selbsttest OK: authenticated INSERT/UPDATE auf guest_crm_profiles erlaubt (Testdaten via Cascade entfernt). ===';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    DELETE FROM public.guest_profiles WHERE restaurant_id = '__rls_selftest__';
    RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: authenticated INSERT auf guest_crm_profiles blockiert (RLS/GRANT pruefen).';
END $$;

DO $$
BEGIN
  SET LOCAL ROLE anon;
  PERFORM 1 FROM public.guest_crm_profiles LIMIT 1;
  RESET ROLE;
  RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: anon konnte guest_crm_profiles lesen (PII-Leck!).';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '=== Selbsttest OK: anon-Zugriff auf guest_crm_profiles blockiert. ===';
END $$;

-- ── 4. Verifikation: Policies + anon-Rechte anzeigen ─────────────────────────

SELECT
  tablename,
  COUNT(*)                                          AS policy_count,
  string_agg(cmd || ':' || array_to_string(roles, '/'), ', ' ORDER BY cmd) AS policies
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'guest_crm_profiles'
GROUP BY tablename;

-- anon darf KEINE Tabellen-Rechte haben (Ergebnis sollte leer sein):
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'anon'
  AND table_name = 'guest_crm_profiles';
