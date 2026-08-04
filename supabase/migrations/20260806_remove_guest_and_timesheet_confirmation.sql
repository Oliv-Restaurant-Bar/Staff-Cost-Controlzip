-- ═══════════════════════════════════════════════════════════════════════════
-- 20260806 — Features entfernt: Gast-Freigaben (published-schedule/staff-feedback)
--            und Mitarbeiter-Stundenbestätigung (Token-Flow).
--            Ziel: NULL anon-Policies und NULL anon-Grants auf allen Tabellen.
-- Tabellen employee_timesheet_confirmations / timesheet_employee_requests
-- bleiben BESTEHEN (Daten erhalten, nur noch authenticated) — können später
-- bei Bedarf gedroppt werden.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Gast-Freigaben: anon-Ausnahmen auf app_settings entfernen ────────────
DROP POLICY IF EXISTS "anon_published_schedule_read"  ON public.app_settings;
DROP POLICY IF EXISTS "anon_staff_feedback_insert"    ON public.app_settings;
DROP POLICY IF EXISTS "anon_staff_feedback_update"    ON public.app_settings;
REVOKE ALL ON public.app_settings FROM anon;

-- ── 2) Stundenbestätigung: Token-RPCs entfernen ─────────────────────────────
DROP FUNCTION IF EXISTS public.get_confirmation_page_data(text);
DROP FUNCTION IF EXISTS public.confirm_timesheet_by_token(text);
DROP FUNCTION IF EXISTS public.question_timesheet_by_token(text);
DROP FUNCTION IF EXISTS public.reject_timesheet_by_token(text, text);
DROP FUNCTION IF EXISTS public.get_timesheet_requests_by_token(text);
DROP FUNCTION IF EXISTS public.create_timesheet_request_by_token(
  text, text, text, text, text, numeric, text, text);

-- ── 2b) anon-EXECUTE auf Nicht-Onboarding-Funktionen entziehen ──────────────
REVOKE EXECUTE ON FUNCTION
  public.get_my_role(),
  public.set_user_role(text, text),
  public.get_token_access(text),
  public.activate_onboarding_submission(uuid),
  public.handle_new_auth_user(),
  public.gn_average_checks_set_updated_at(),
  public.update_employee_time_balances_updated_at(),
  public.update_timesheet_confirmation_updated_at()
FROM anon;

-- ── 3) Sicherheitsnetz: sämtliche anon-Tabellen-Grants + anon-Policies weg ──
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM anon', r.schemaname, r.tablename);
  END LOOP;
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND 'anon' = ANY(roles)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- ── 4) Bestandsaufnahme (Ziel: beide Abfragen liefern 0 Zeilen) ─────────────
-- SELECT table_name, privilege_type FROM information_schema.role_table_grants
--  WHERE grantee = 'anon' AND table_schema = 'public';
-- SELECT tablename, policyname FROM pg_policies
--  WHERE schemaname = 'public' AND 'anon' = ANY(roles);
--
-- Hinweis: Bewusst NICHT entfernt (Onboarding-Feature, separat gescopet):
--  * EXECUTE-Rechte für anon auf token-geprüften Onboarding-RPCs
--    (get_onboarding_employee_by_token, mark_onboarding_in_progress_by_token,
--     submit_onboarding_by_token, create_onboarding_submission_public)
--  * anon-INSERT Storage-Policy auf Bucket onboarding-docs
