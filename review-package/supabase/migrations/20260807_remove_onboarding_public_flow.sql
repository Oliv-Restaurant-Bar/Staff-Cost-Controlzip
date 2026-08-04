-- ─────────────────────────────────────────────────────────────────────────────
-- 20260807: Onboarding-per-Link komplett entfernen — letzte anon-Restfläche
-- Ziel: 0 anon-RPCs, 0 anon-Bucket-Rechte, 0 anon-Policies/Grants im Schema.
-- Neue Mitarbeitende werden nur noch eingeloggt (Admin) im Personalstamm erfasst.
-- Idempotent, wiederholbar.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Onboarding-Token-RPCs droppen (waren die einzigen anon-EXECUTE-Ausnahmen)
DROP FUNCTION IF EXISTS public.create_onboarding_submission_public(text, jsonb);
DROP FUNCTION IF EXISTS public.get_onboarding_employee_by_token(text);
DROP FUNCTION IF EXISTS public.mark_onboarding_in_progress_by_token(text);
DROP FUNCTION IF EXISTS public.submit_onboarding_by_token(text, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.activate_onboarding_submission(uuid);
DROP FUNCTION IF EXISTS public.get_token_access(text);

-- 2) onboarding_submissions: anon vollständig raus (Tabelle bleibt, authenticated-only)
DO $$
BEGIN
  IF to_regclass('public.onboarding_submissions') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.onboarding_submissions FROM anon;
    DROP POLICY IF EXISTS "anon_insert" ON public.onboarding_submissions;
  END IF;
END $$;

-- 3) Storage: anon-Upload-Policy für onboarding-docs entfernen
DROP POLICY IF EXISTS "Anon upload onboarding docs" ON storage.objects;

-- 4) Sicherheitsnetz: anon/PUBLIC-EXECUTE auf ALLEN public-Funktionen entziehen.
--    Authenticated behält EXECUTE (explizit gegranted, da bisher oft nur via PUBLIC).
DO $$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn.sig);
  END LOOP;
END $$;

-- Zukunftssicher: neue Funktionen bekommen kein PUBLIC/anon-EXECUTE mehr
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

-- 5) Sicherheitsnetz: verbliebene anon-Tabellen-Grants/-Policies (public) droppen
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT table_schema, table_name
    FROM information_schema.role_table_grants
    WHERE grantee = 'anon' AND table_schema = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM anon', r.table_schema, r.table_name);
  END LOOP;
  FOR r IN
    SELECT pol.polname, c.relname
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND pol.polroles::regrole[]::text[] && ARRAY['anon']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.polname, r.relname);
  END LOOP;
END $$;
