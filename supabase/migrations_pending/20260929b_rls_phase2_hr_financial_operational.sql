-- RLS Phase 2 (2026-09-29): continues 20260928b_rls_phase1_wages_financial.sql
-- — closes the confirmed remaining gaps from the wider table-by-table audit,
-- reusing that migration's SECURITY DEFINER predicate helpers wherever the
-- access shape matches, adding two new ones where it doesn't. Manual apply
-- in the Supabase SQL Editor, same as every other migration here. Idempotent
-- (dynamic drop-all-existing-policies-then-recreate, per-table).
--
-- Scope of this pass: HR/onboarding (personaleintritt, onboarding_submissions),
-- the timesheet lifecycle/history cluster, creditor open-items, daily
-- revenue, statutory minimum-wage write path, core scheduling tables
-- (schedule_entries, actual_hour_entries, actual_day_annotations), and the
-- operational-config + guest/reservation clusters that carry a restaurant_id.
--
-- Deliberately NOT in this pass (documented follow-up, needs a design
-- decision this migration shouldn't guess at):
--   - The gn_* Gastronovi-import cluster (gn_revenue_summary, gn_tax_summary,
--     gn_cost_centers, etc.) — only gn_imports/gn_extended_positions/
--     gn_person_imports/gn_zbericht_daily carry their own restaurant_id; the
--     rest are children joined via an import-id FK. Tenant-scoping them
--     needs either a denormalized restaurant_id per child table or an EXISTS
--     join back to the parent in every policy — a real schema/design choice,
--     not a one-line policy copy.
--   - email_imported_reservations, group_reservations, fortelable_reservations
--     — unlike every sibling reservation table, these three have NO tenant
--     column at all. Unclear whether that's a legacy Oliv-only artifact or
--     an oversight — needs a decision before writing a policy, not a guess.
--   - articles, products, product_ingredients, cost_pools,
--     product_costpool_mapping, sales — no restaurant_id on any of them;
--     read as a shared/global product catalog rather than per-tenant data.
--     Left on authenticated-only; flag to the client if product costs should
--     actually be tenant-siloed between Oliv and Beaulieu.
--   - capacity_settings — single global config row (id='default'), no
--     tenant concept. Left authenticated-only, genuinely global.
--   - produkte_kosten — no tenant column, same reasoning as the product
--     catalog above. Left authenticated-only.
--   - Logs/audit tables (event_notifications_log, external_api_import_log,
--     product_sales_reset_log, import_runs, zbericht_inbox) — low read
--     sensitivity, append-mostly. Left authenticated-only.

-- ── New predicate: admin OR beaulieu_manager-for-own-tenant. Matches
--    src/lib/role-authorization.ts's roleCan(role, 'operational_management')
--    and roleCan(role, 'guest_management') — both resolve to exactly
--    {admin, beaulieu_manager}, so one predicate covers both capabilities
--    (Positionsverwaltung/Personalbedarf and the Gäste-CRM module). ─────────
CREATE OR REPLACE FUNCTION public.role_can_manage_operational_data(p_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE public.current_user_role()
    WHEN 'admin' THEN true
    WHEN 'beaulieu_manager' THEN p_tenant = 'beaulieu'
    ELSE false
  END;
$$;
REVOKE ALL ON FUNCTION public.role_can_manage_operational_data(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.role_can_manage_operational_data(text) TO authenticated;

-- ── Helper macro (documentation only — Postgres has no real macros): every
--    table below follows the same idempotent shape —
--      ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
--      DO $$ ... drop every existing policy on the table ... $$;
--      CREATE POLICY ... FOR SELECT / INSERT / UPDATE / DELETE ...;
--      REVOKE ALL ... FROM anon;
--    repeated per table so each block is independently re-runnable and
--    greppable, matching this repo's established migration style.

-- ══ HR / Onboarding (financial-pii: salary + AHV/IBAN-equivalent PII) ═══════

-- personaleintritt: restaurant_id CHECK IN ('oliv','beaulieu'). Its own
-- migration comment explicitly documented tenant isolation as client-side
-- only — same class of gap as employee_wages/employees, just missed from
-- the first RLS pass. Access matches the /personaleintritt route's own
-- gate (RequireAdmin allowBeaulieu) — i.e. the same admin-or-own-tenant-
-- beaulieu_manager shape as role_can_see_wages.
DO $$
DECLARE polname text;
BEGIN
  ALTER TABLE public.personaleintritt ENABLE ROW LEVEL SECURITY;
  FOR polname IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='personaleintritt' LOOP
    EXECUTE format('DROP POLICY %I ON public.personaleintritt;', polname);
  END LOOP;
END $$;
CREATE POLICY personaleintritt_select ON public.personaleintritt
  FOR SELECT TO authenticated USING (public.role_can_see_wages(restaurant_id));
CREATE POLICY personaleintritt_insert ON public.personaleintritt
  FOR INSERT TO authenticated WITH CHECK (public.role_can_see_wages(restaurant_id));
CREATE POLICY personaleintritt_update ON public.personaleintritt
  FOR UPDATE TO authenticated USING (public.role_can_see_wages(restaurant_id)) WITH CHECK (public.role_can_see_wages(restaurant_id));
CREATE POLICY personaleintritt_delete ON public.personaleintritt
  FOR DELETE TO authenticated USING (public.role_can_see_wages(restaurant_id));
REVOKE ALL ON public.personaleintritt FROM anon;

-- onboarding_submissions: no tenant column (global). Same access level as
-- personaleintritt (the onboarding flow this table feeds is HR/salary-
-- adjacent), gated by role only since there's no tenant to scope by.
DO $$
DECLARE polname text;
BEGIN
  ALTER TABLE public.onboarding_submissions ENABLE ROW LEVEL SECURITY;
  FOR polname IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='onboarding_submissions' LOOP
    EXECUTE format('DROP POLICY %I ON public.onboarding_submissions;', polname);
  END LOOP;
END $$;
CREATE POLICY onboarding_submissions_select ON public.onboarding_submissions
  FOR SELECT TO authenticated USING (public.current_user_role() IN ('admin','beaulieu_manager'));
CREATE POLICY onboarding_submissions_update ON public.onboarding_submissions
  FOR UPDATE TO authenticated USING (public.current_user_role() IN ('admin','beaulieu_manager')) WITH CHECK (public.current_user_role() IN ('admin','beaulieu_manager'));
CREATE POLICY onboarding_submissions_delete ON public.onboarding_submissions
  FOR DELETE TO authenticated USING (public.current_user_role() IN ('admin','beaulieu_manager'));
-- No authenticated INSERT policy: rows are created exclusively via the
-- create_onboarding_submission_public() SECURITY DEFINER RPC (anon-callable,
-- see 20260805_anon_full_lockdown.sql Teil 4), never a direct table insert.
REVOKE ALL ON public.onboarding_submissions FROM anon;

-- ══ Timesheet lifecycle/history cluster (tenant_id-scoped) ══════════════════

DO $$
DECLARE polname text; t text;
BEGIN
  -- timesheet_month_exclusions/timesheet_month_inclusions REMOVED from this
  -- array 2026-10-01: only consumer was timesheet-exclusions-store.ts ->
  -- ArbeitszeitblaetterPage.tsx, confirmed dead (zero importers, not routed)
  -- and moved to src/_deprecated/. Table creation correspondingly removed
  -- from 20260528_timesheet_exclusions.sql in missing_tables/ — ALTER TABLE
  -- against a nonexistent table fails. See src/_deprecated/README.md.
  FOREACH t IN ARRAY ARRAY[
    'employee_timesheet_confirmations', 'timesheet_employee_requests',
    'employee_time_balances', 'timesheet_import_history',
    'timesheet_month_status', 'timesheet_month_snapshot'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    FOR polname IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I;', polname, t);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.role_can_access_tenant(tenant_id));', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.role_can_write_tenant_data(tenant_id));', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.role_can_write_tenant_data(tenant_id)) WITH CHECK (public.role_can_write_tenant_data(tenant_id));', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.role_can_write_tenant_data(tenant_id));', t || '_delete', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END $$;

-- timesheet_mirus_adjustment_status / timesheet_change_log: no tenant_id
-- column on either — role-gated only, matching canAccessModule('personal_fix')
-- (admin + beaulieu_manager, no finer tenant split possible without a
-- schema change).
DO $$
DECLARE polname text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['timesheet_mirus_adjustment_status', 'timesheet_change_log'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    FOR polname IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I;', polname, t);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.current_user_role() IN (''admin'',''beaulieu_manager'')) WITH CHECK (public.current_user_role() IN (''admin'',''beaulieu_manager''));', t || '_admin_beaulieu', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END $$;

-- schedule_change_log / schedule_publication_snapshots: tenant_id NOT NULL
-- DEFAULT 'oliv' — scheduling audit trail, same broad operational-role
-- access as the schedule tables below (all four scheduling roles need
-- their own tenant's history).
DO $$
DECLARE polname text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['schedule_change_log', 'schedule_publication_snapshots'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    FOR polname IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I;', polname, t);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.role_can_access_tenant(tenant_id));', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.role_can_write_tenant_data(tenant_id));', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.role_can_write_tenant_data(tenant_id)) WITH CHECK (public.role_can_write_tenant_data(tenant_id));', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.role_can_write_tenant_data(tenant_id));', t || '_delete', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END $$;

-- ══ Core scheduling tables — tenant derived via the employee id-prefix
--    convention ('b-' = Beaulieu), same as employees itself in Phase 1 ═════

DO $$
DECLARE polname text;
BEGIN
  ALTER TABLE public.schedule_entries ENABLE ROW LEVEL SECURITY;
  FOR polname IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='schedule_entries' LOOP
    EXECUTE format('DROP POLICY %I ON public.schedule_entries;', polname);
  END LOOP;
END $$;
CREATE POLICY schedule_entries_select ON public.schedule_entries
  FOR SELECT TO authenticated
  USING (public.role_can_access_tenant(CASE WHEN employee_id::text LIKE 'b-%' THEN 'beaulieu' ELSE 'oliv' END));
CREATE POLICY schedule_entries_insert ON public.schedule_entries
  FOR INSERT TO authenticated
  WITH CHECK (public.role_can_write_tenant_data(CASE WHEN employee_id::text LIKE 'b-%' THEN 'beaulieu' ELSE 'oliv' END));
CREATE POLICY schedule_entries_update ON public.schedule_entries
  FOR UPDATE TO authenticated
  USING (public.role_can_write_tenant_data(CASE WHEN employee_id::text LIKE 'b-%' THEN 'beaulieu' ELSE 'oliv' END))
  WITH CHECK (public.role_can_write_tenant_data(CASE WHEN employee_id::text LIKE 'b-%' THEN 'beaulieu' ELSE 'oliv' END));
CREATE POLICY schedule_entries_delete ON public.schedule_entries
  FOR DELETE TO authenticated
  USING (public.role_can_write_tenant_data(CASE WHEN employee_id::text LIKE 'b-%' THEN 'beaulieu' ELSE 'oliv' END));
REVOKE ALL ON public.schedule_entries FROM anon;

DO $$
DECLARE polname text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['actual_hour_entries', 'actual_day_annotations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    FOR polname IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I;', polname, t);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.role_can_access_tenant(CASE WHEN employee_id LIKE ''b-%%'' THEN ''beaulieu'' ELSE ''oliv'' END));', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.role_can_write_tenant_data(CASE WHEN employee_id LIKE ''b-%%'' THEN ''beaulieu'' ELSE ''oliv'' END));', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.role_can_write_tenant_data(CASE WHEN employee_id LIKE ''b-%%'' THEN ''beaulieu'' ELSE ''oliv'' END)) WITH CHECK (public.role_can_write_tenant_data(CASE WHEN employee_id LIKE ''b-%%'' THEN ''beaulieu'' ELSE ''oliv'' END));', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.role_can_write_tenant_data(CASE WHEN employee_id LIKE ''b-%%'' THEN ''beaulieu'' ELSE ''oliv'' END));', t || '_delete', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END $$;

-- ══ Operational-config tables (Positionsverwaltung/Personalbedarf —
--    admin + beaulieu_manager only, matches roleCan(role,'operational_management')
--    and the /positionen, /personalbedarf route gates) ══════════════════════

DO $$
DECLARE polname text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['positions', 'staffing_requirements'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    FOR polname IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I;', polname, t);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.role_can_manage_operational_data(restaurant_id));', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.role_can_manage_operational_data(restaurant_id));', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.role_can_manage_operational_data(restaurant_id)) WITH CHECK (public.role_can_manage_operational_data(restaurant_id));', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.role_can_manage_operational_data(restaurant_id));', t || '_delete', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END $$;

-- betriebe: admin-only per its own App.tsx route comment ("NUR Admin OHNE
-- Gäste — kein beaulieu_manager"), not tenant-scoped (a Betrieb record can
-- legitimately map to either tenant via scc_tenant, but only admin manages
-- the list itself).
DO $$
DECLARE polname text;
BEGIN
  ALTER TABLE public.betriebe ENABLE ROW LEVEL SECURITY;
  FOR polname IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='betriebe' LOOP
    EXECUTE format('DROP POLICY %I ON public.betriebe;', polname);
  END LOOP;
END $$;
CREATE POLICY betriebe_admin_all ON public.betriebe
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');
REVOKE ALL ON public.betriebe FROM anon;

-- ══ Accounts payable (creditor open items) — same access shape as the
--    Warenrechnungen module it sits next to; reuses its existing predicates
--    rather than inventing a parallel tenant-scoped one ═════════════════════

DO $$
DECLARE polname text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['creditor_op_imports', 'creditor_op_items'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    FOR polname IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I;', polname, t);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.role_can_view_warenrechnungen());', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.role_can_edit_warenrechnungen()) WITH CHECK (public.role_can_edit_warenrechnungen());', t || '_manage', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END $$;

-- ══ Daily revenue — NOT applied here. `daily_revenues`/`sales_upload_log`
--    don't exist in production and aren't being created (zero code
--    references either — see
--    supabase/migrations_pending/missing_tables/not_applying_confirmed_dead/README.md
--    and docs/personal-cost-tracker-missing-tables.md). A dynamic ALTER
--    TABLE on a nonexistent table fails the whole DO block. ═════════════════

-- ══ Statutory minimum-wage table — read stays open (public legal data,
--    needed for payroll compliance calcs across roles), write restricted to
--    admin only (currently USING(true) for write too — a non-admin could
--    otherwise tamper with a table that feeds payroll compliance) ══════════

DO $$
DECLARE polname text;
BEGIN
  ALTER TABLE public.lgav_mindestlohn ENABLE ROW LEVEL SECURITY;
  FOR polname IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='lgav_mindestlohn' LOOP
    EXECUTE format('DROP POLICY %I ON public.lgav_mindestlohn;', polname);
  END LOOP;
END $$;
CREATE POLICY lgav_mindestlohn_select ON public.lgav_mindestlohn
  FOR SELECT TO authenticated USING (true);
CREATE POLICY lgav_mindestlohn_write ON public.lgav_mindestlohn
  FOR INSERT TO authenticated WITH CHECK (public.current_user_role() = 'admin');
CREATE POLICY lgav_mindestlohn_update ON public.lgav_mindestlohn
  FOR UPDATE TO authenticated USING (public.current_user_role() = 'admin') WITH CHECK (public.current_user_role() = 'admin');
CREATE POLICY lgav_mindestlohn_delete ON public.lgav_mindestlohn
  FOR DELETE TO authenticated USING (public.current_user_role() = 'admin');
REVOKE ALL ON public.lgav_mindestlohn FROM anon;

-- ══ Guest/reservation cluster (real guest PII: name/email/phone) — matches
--    canManageGuests / the /gaeste* route gates (admin + beaulieu_manager) ══

DO $$
DECLARE polname text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'guest_profiles', 'guest_crm_activities', 'guest_crm_contact_lists',
    'guest_merge_log', 'reservation_imports', 'reservation_records'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    FOR polname IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I;', polname, t);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.role_can_manage_operational_data(restaurant_id)) WITH CHECK (public.role_can_manage_operational_data(restaurant_id));', t || '_admin_beaulieu', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END $$;

-- guest_crm_profiles: no own restaurant_id — 1:1 extension of guest_profiles
-- via guest_id FK, tenant derived through the parent row.
DO $$
DECLARE polname text;
BEGIN
  ALTER TABLE public.guest_crm_profiles ENABLE ROW LEVEL SECURITY;
  FOR polname IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='guest_crm_profiles' LOOP
    EXECUTE format('DROP POLICY %I ON public.guest_crm_profiles;', polname);
  END LOOP;
END $$;
CREATE POLICY guest_crm_profiles_all ON public.guest_crm_profiles
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.guest_profiles gp
    WHERE gp.id = guest_crm_profiles.guest_id
      AND public.role_can_manage_operational_data(gp.restaurant_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.guest_profiles gp
    WHERE gp.id = guest_crm_profiles.guest_id
      AND public.role_can_manage_operational_data(gp.restaurant_id)
  ));
REVOKE ALL ON public.guest_crm_profiles FROM anon;

NOTIFY pgrst, 'reload schema';
