-- Urgent security fixes (2026-09-28), split out ahead of the broader RLS pass
-- because both are small, self-contained, and high severity on their own:
--
-- 1) Three tables hold plaintext third-party credentials (IMAP mailbox
--    password, external API keys) but were swept into the generic
--    `USING(true) TO authenticated` catch-all by 20260805_anon_full_lockdown.sql
--    — meaning every logged-in role, not just the admin/beaulieu_manager roles
--    the UI restricts this to (canManageGuests), can read the raw credentials
--    directly via the API. Restrict to admin + beaulieu_manager, matching
--    usePermissions.ts's canManageGuests.
--
-- 2) user_profiles (the role source of truth) currently lets ANY authenticated
--    user UPDATE or DELETE any other user's row, including an admin's. The
--    2026-07-16 trigger (protect_user_profile_role) already blocks changing
--    the `role` column without being admin, but does nothing for DELETE or for
--    UPDATE of other columns (email) on someone else's row. A non-admin
--    deleting an admin's profile row would silently lock that admin out of
--    every role check in the app (SELECT role ... WHERE id = auth.uid() would
--    return nothing) until someone manually re-inserts it — a live
--    integrity/DoS hole independent of the credential issue above.
--
-- Idempotent — safe to run more than once.

-- ── Part 1: credential tables — admin + beaulieu_manager only ──────────────

DROP POLICY IF EXISTS "Allow public read access on imap_email_settings"   ON public.imap_email_settings;
DROP POLICY IF EXISTS "Allow public insert access on imap_email_settings" ON public.imap_email_settings;
DROP POLICY IF EXISTS "Allow public update access on imap_email_settings" ON public.imap_email_settings;
DROP POLICY IF EXISTS "Allow public delete access on imap_email_settings" ON public.imap_email_settings;
DROP POLICY IF EXISTS imap_email_settings_select ON public.imap_email_settings;
DROP POLICY IF EXISTS imap_email_settings_insert ON public.imap_email_settings;
DROP POLICY IF EXISTS imap_email_settings_update ON public.imap_email_settings;
DROP POLICY IF EXISTS imap_email_settings_delete ON public.imap_email_settings;

CREATE POLICY imap_email_settings_select ON public.imap_email_settings
  FOR SELECT TO authenticated USING (public.current_user_role() IN ('admin', 'beaulieu_manager'));
CREATE POLICY imap_email_settings_insert ON public.imap_email_settings
  FOR INSERT TO authenticated WITH CHECK (public.current_user_role() IN ('admin', 'beaulieu_manager'));
CREATE POLICY imap_email_settings_update ON public.imap_email_settings
  FOR UPDATE TO authenticated
  USING (public.current_user_role() IN ('admin', 'beaulieu_manager'))
  WITH CHECK (public.current_user_role() IN ('admin', 'beaulieu_manager'));
CREATE POLICY imap_email_settings_delete ON public.imap_email_settings
  FOR DELETE TO authenticated USING (public.current_user_role() IN ('admin', 'beaulieu_manager'));

DROP POLICY IF EXISTS "Allow all access to external_api_settings" ON public.external_api_settings;
DROP POLICY IF EXISTS external_api_settings_select ON public.external_api_settings;
DROP POLICY IF EXISTS external_api_settings_insert ON public.external_api_settings;
DROP POLICY IF EXISTS external_api_settings_update ON public.external_api_settings;
DROP POLICY IF EXISTS external_api_settings_delete ON public.external_api_settings;

CREATE POLICY external_api_settings_select ON public.external_api_settings
  FOR SELECT TO authenticated USING (public.current_user_role() IN ('admin', 'beaulieu_manager'));
CREATE POLICY external_api_settings_insert ON public.external_api_settings
  FOR INSERT TO authenticated WITH CHECK (public.current_user_role() IN ('admin', 'beaulieu_manager'));
CREATE POLICY external_api_settings_update ON public.external_api_settings
  FOR UPDATE TO authenticated
  USING (public.current_user_role() IN ('admin', 'beaulieu_manager'))
  WITH CHECK (public.current_user_role() IN ('admin', 'beaulieu_manager'));
CREATE POLICY external_api_settings_delete ON public.external_api_settings
  FOR DELETE TO authenticated USING (public.current_user_role() IN ('admin', 'beaulieu_manager'));

DROP POLICY IF EXISTS "Allow all operations on fortelable_settings" ON public.fortelable_settings;
DROP POLICY IF EXISTS fortelable_settings_select ON public.fortelable_settings;
DROP POLICY IF EXISTS fortelable_settings_insert ON public.fortelable_settings;
DROP POLICY IF EXISTS fortelable_settings_update ON public.fortelable_settings;
DROP POLICY IF EXISTS fortelable_settings_delete ON public.fortelable_settings;

CREATE POLICY fortelable_settings_select ON public.fortelable_settings
  FOR SELECT TO authenticated USING (public.current_user_role() IN ('admin', 'beaulieu_manager'));
CREATE POLICY fortelable_settings_insert ON public.fortelable_settings
  FOR INSERT TO authenticated WITH CHECK (public.current_user_role() IN ('admin', 'beaulieu_manager'));
CREATE POLICY fortelable_settings_update ON public.fortelable_settings
  FOR UPDATE TO authenticated
  USING (public.current_user_role() IN ('admin', 'beaulieu_manager'))
  WITH CHECK (public.current_user_role() IN ('admin', 'beaulieu_manager'));
CREATE POLICY fortelable_settings_delete ON public.fortelable_settings
  FOR DELETE TO authenticated USING (public.current_user_role() IN ('admin', 'beaulieu_manager'));

-- ── Part 2: user_profiles — own row, or admin for any row ──────────────────
-- role-column changes remain governed by the existing trg_protect_user_profile_role
-- trigger (admin-only) regardless of these policies. New rows are created
-- server-side by the handle_new_auth_user() trigger on auth.users (SECURITY
-- DEFINER, bypasses RLS) — client-side INSERT is not part of any live flow,
-- so it is restricted to admin here as defense-in-depth, not because the app
-- relies on it.

DROP POLICY IF EXISTS "User can read own profile"         ON public.user_profiles;
DROP POLICY IF EXISTS "Authenticated can manage profiles" ON public.user_profiles;
DROP POLICY IF EXISTS user_profiles_select ON public.user_profiles;
DROP POLICY IF EXISTS user_profiles_insert ON public.user_profiles;
DROP POLICY IF EXISTS user_profiles_update ON public.user_profiles;
DROP POLICY IF EXISTS user_profiles_delete ON public.user_profiles;

CREATE POLICY user_profiles_select ON public.user_profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.current_user_role() = 'admin');

CREATE POLICY user_profiles_insert ON public.user_profiles
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_role() = 'admin');

CREATE POLICY user_profiles_update ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.current_user_role() = 'admin')
  WITH CHECK (id = auth.uid() OR public.current_user_role() = 'admin');

CREATE POLICY user_profiles_delete ON public.user_profiles
  FOR DELETE TO authenticated
  USING (public.current_user_role() = 'admin');

-- Same tightening for the admin-facing view over user_profiles (currently
-- granted to all authenticated despite its own comment saying admin-only;
-- not referenced anywhere in src/ today, but closing it here is free).
CREATE OR REPLACE VIEW public.user_profiles_with_email AS
  SELECT p.id, u.email, p.role, p.created_at
  FROM   public.user_profiles p
  JOIN   auth.users u ON u.id = p.id
  WHERE  p.id = auth.uid() OR public.current_user_role() = 'admin'
  ORDER  BY p.role, u.email;

NOTIFY pgrst, 'reload schema';
