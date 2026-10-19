-- URGENT follow-up to 20260928_urgent_credential_and_profile_lockdown.sql —
-- a second security-audit pass (2026-09-29) found more of the same shape of
-- gap: secrets/tokens readable or writable by any authenticated role instead
-- of just admin/beaulieu_manager. Manual apply in the Supabase SQL Editor,
-- same as every other migration in this repo. Idempotent.
--
-- ── 1) app_settings.admin_password is world-readable to any authenticated
--    role ────────────────────────────────────────────────────────────────
-- 20260902_app_settings_write_authorization.sql locked down INSERT/UPDATE/
-- DELETE on app_settings by key-family + role, but its own header comment
-- says "Authenticated SELECT remains unchanged" — and no earlier migration
-- ever added a SELECT policy for this table, so it is still on the generic
-- `USING(true) TO authenticated` catch-all for reads. The `admin_password`
-- key (src/components/GlobalSiteProtection.tsx / PasswordProtection.tsx /
-- src/pages/Settings.tsx) holds the app's own site-wide access password —
-- currently any logged-in role, including the lowest-privilege
-- beaulieu_viewer, can read it straight off the Supabase REST API.
--
-- Fix: SELECT stays open for every OTHER key (broad legitimate cross-role
-- reads — schedule config, operational data, etc. — are not being
-- reclassified in this pass, only the one confirmed secret), but
-- `admin_password` itself is now admin-only to read.
--
-- ── 2) department_access_tokens — a second plaintext-credential-shaped
--    table missed from the original urgent pass ───────────────────────────
-- Bearer tokens granting department-schedule access (`token`, `role`,
-- `expires_at`). Its original public-read policy was dropped by
-- 20260805_anon_full_lockdown.sql, leaving it on the auto-generated 4-op
-- `TO authenticated USING(true)` catch-all — any authenticated role can
-- read/write/delete every token, not just admin. The consuming feature
-- (guest-link department schedules) is currently disabled per the client's
-- 2026-09-28 decision (routes + admin UI commented out in App.tsx/
-- Settings.tsx), so this is defense-in-depth, not fixing a reachable leak
-- today — but the table and its weak policy are still live via direct API.
--
-- ── 3) app_kv_store — confirmed effectively unused (repo-wide grep: the
--    only live caller is Produkte.tsx's cleanup delete of two specific
--    legacy keys; the actual live KV store is app_settings, per
--    src/lib/produkte-store.ts's own comment) but still on the open
--    catch-all. Tightened to admin-only since nothing legitimate needs
--    broader access right now.
--
-- Idempotent — safe to run more than once.

-- ── app_settings: admin-only SELECT on admin_password ───────────────────────

DO $$
DECLARE
  polname text;
BEGIN
  FOR polname IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'app_settings' AND cmd = 'SELECT'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.app_settings;', polname);
  END LOOP;
END $$;

CREATE POLICY app_settings_select ON public.app_settings
  FOR SELECT TO authenticated
  USING (key <> 'admin_password' OR public.current_user_role() = 'admin');

-- ── department_access_tokens: admin-only (matches the disabled feature's
--    only legitimate caller, DepartmentTokenManager, which is itself
--    admin-only UI) ───────────────────────────────────────────────────────

ALTER TABLE public.department_access_tokens ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  polname text;
BEGIN
  FOR polname IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'department_access_tokens'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.department_access_tokens;', polname);
  END LOOP;
END $$;

CREATE POLICY department_access_tokens_admin_all ON public.department_access_tokens
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

REVOKE ALL ON public.department_access_tokens FROM anon;

-- ── app_kv_store: admin + beaulieu_manager (matches its one live caller,
--    Produkte.tsx's legacy-key cleanup delete, which sits behind the
--    /produkte route's admin+beaulieu_manager guard) ───────────────────────

ALTER TABLE public.app_kv_store ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  polname text;
BEGIN
  FOR polname IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'app_kv_store'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.app_kv_store;', polname);
  END LOOP;
END $$;

CREATE POLICY app_kv_store_admin_all ON public.app_kv_store
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'beaulieu_manager'))
  WITH CHECK (public.current_user_role() IN ('admin', 'beaulieu_manager'));

REVOKE ALL ON public.app_kv_store FROM anon;

NOTIFY pgrst, 'reload schema';
