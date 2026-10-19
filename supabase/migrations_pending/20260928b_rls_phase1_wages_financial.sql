-- RLS Phase 1 (2026-09-28): real database-level role/tenant enforcement for
-- the highest-sensitivity tables, replacing the generic
-- `USING(true) TO authenticated` catch-all that every one of these currently
-- has (from 20260805_anon_full_lockdown.sql or their own original migration).
--
-- Scope of this pass (per client priority + follow-up scoping decision):
--   employee_wages, supplier_documents/supplier_document_splits/suppliers
--   (Warenrechnungen), employees, schedule_extra_cost_people.
-- user_profiles and the 3 plaintext-credential tables were already fixed in
-- 20260928_urgent_credential_and_profile_lockdown.sql.
--
-- NOT in scope here (documented follow-up, needs app-level changes, not just
-- SQL): fully hiding the wage COLUMNS inside `employees` and
-- `schedule_extra_cost_people` from roles that still need the other columns
-- in the same row (name/department, for scheduling) — Postgres RLS is
-- row-level, not column-level, so that needs either a column-filtered view
-- the app queries instead of the base table, or a SECURITY DEFINER RPC. This
-- migration DOES close both tables' cross-tenant row leakage (e.g. a
-- service_manager currently being able to read Beaulieu employee rows) since
-- that's a plain row-level fix.
--
-- The remaining ~40 lower-sensitivity tables found in the wider audit
-- (reference/lookup data, notification logs, gn_* import tables, guest CRM,
-- etc.) are intentionally deferred to a later pass — see
-- docs/dev/personal-cost-tracker-issues.md issue #7 for the running list.
--
-- Idempotent — safe to run more than once.

-- ── Shared predicate helpers (SECURITY DEFINER, mirrors current_user_role()
--    from 20260716_user_profiles_role_protection.sql) ───────────────────────

-- Can this role see/write rows belonging to tenant p_tenant ('oliv'|'beaulieu')
-- at all, ignoring any write-eligibility restriction (e.g. beaulieu_viewer is
-- read-eligible for 'beaulieu' here — use role_can_write_tenant_data below to
-- exclude view-only roles from writes)?
CREATE OR REPLACE FUNCTION public.role_can_access_tenant(p_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE public.current_user_role()
    WHEN 'admin' THEN true
    WHEN 'beaulieu_manager' THEN p_tenant = 'beaulieu'
    WHEN 'beaulieu_viewer'  THEN p_tenant = 'beaulieu'
    WHEN 'service_manager'  THEN p_tenant = 'oliv'
    WHEN 'kueche_manager'   THEN p_tenant = 'oliv'
    ELSE false
  END;
$$;

-- Write-eligible roles per tenant, excluding view-only roles (beaulieu_viewer).
CREATE OR REPLACE FUNCTION public.role_can_write_tenant_data(p_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE public.current_user_role()
    WHEN 'admin' THEN true
    WHEN 'beaulieu_manager' THEN p_tenant = 'beaulieu'
    WHEN 'service_manager'  THEN p_tenant = 'oliv'
    WHEN 'kueche_manager'   THEN p_tenant = 'oliv'
    ELSE false
  END;
$$;

-- Wage visibility: usePermissions.ts's canSeeHourlyWages = isAdmin || isBeaulieuManager.
CREATE OR REPLACE FUNCTION public.role_can_see_wages(p_tenant text)
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

-- Employee editing: usePermissions.ts's canEditEmployees = admin, beaulieu_manager, kueche_manager.
CREATE OR REPLACE FUNCTION public.role_can_edit_employees(p_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE public.current_user_role()
    WHEN 'admin' THEN true
    WHEN 'beaulieu_manager' THEN p_tenant = 'beaulieu'
    WHEN 'kueche_manager'   THEN p_tenant = 'oliv'
    ELSE false
  END;
$$;

-- Warenrechnungen (supplier invoices): usePermissions.ts's warenrechnungenPerms.
-- view: admin, beaulieu_manager, beaulieu_viewer. create/edit/delete: admin, beaulieu_manager only.
CREATE OR REPLACE FUNCTION public.role_can_view_warenrechnungen()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.current_user_role() IN ('admin', 'beaulieu_manager', 'beaulieu_viewer');
$$;

CREATE OR REPLACE FUNCTION public.role_can_edit_warenrechnungen()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.current_user_role() IN ('admin', 'beaulieu_manager');
$$;

REVOKE ALL ON FUNCTION public.role_can_access_tenant(text)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.role_can_write_tenant_data(text)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.role_can_see_wages(text)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.role_can_edit_employees(text)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.role_can_view_warenrechnungen()    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.role_can_edit_warenrechnungen()    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.role_can_access_tenant(text)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.role_can_write_tenant_data(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.role_can_see_wages(text)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.role_can_edit_employees(text)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.role_can_view_warenrechnungen()  TO authenticated;
GRANT EXECUTE ON FUNCTION public.role_can_edit_warenrechnungen()  TO authenticated;

-- ── employee_wages ──────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "employee_wages_auth_select" ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_auth_insert" ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_auth_update" ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_auth_delete" ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_anon_select" ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_auth_all"    ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_anon_all"    ON public.employee_wages;
DROP POLICY IF EXISTS employee_wages_select ON public.employee_wages;
DROP POLICY IF EXISTS employee_wages_insert ON public.employee_wages;
DROP POLICY IF EXISTS employee_wages_update ON public.employee_wages;
DROP POLICY IF EXISTS employee_wages_delete ON public.employee_wages;

CREATE POLICY employee_wages_select ON public.employee_wages
  FOR SELECT TO authenticated USING (public.role_can_see_wages(restaurant_id));
CREATE POLICY employee_wages_insert ON public.employee_wages
  FOR INSERT TO authenticated WITH CHECK (public.role_can_see_wages(restaurant_id));
CREATE POLICY employee_wages_update ON public.employee_wages
  FOR UPDATE TO authenticated
  USING (public.role_can_see_wages(restaurant_id))
  WITH CHECK (public.role_can_see_wages(restaurant_id));
CREATE POLICY employee_wages_delete ON public.employee_wages
  FOR DELETE TO authenticated USING (public.role_can_see_wages(restaurant_id));

REVOKE SELECT ON public.employee_wages FROM anon;

-- ── Warenrechnungen: supplier_documents, supplier_document_splits ───────────
-- `suppliers` itself is NOT RLS'd here: the table doesn't exist in production
-- and isn't being created (zero code references it — see
-- supabase/migrations_pending/missing_tables/not_applying_confirmed_dead/README.md
-- and docs/dev/personal-cost-tracker-missing-tables.md). A policy on a
-- nonexistent table fails the whole migration, same failure mode that
-- surfaced this entire investigation.

DROP POLICY IF EXISTS "authenticated_read_supplier_documents"   ON public.supplier_documents;
DROP POLICY IF EXISTS "authenticated_manage_supplier_documents" ON public.supplier_documents;
CREATE POLICY authenticated_read_supplier_documents ON public.supplier_documents
  FOR SELECT TO authenticated USING (public.role_can_view_warenrechnungen());
CREATE POLICY authenticated_manage_supplier_documents ON public.supplier_documents
  FOR ALL TO authenticated
  USING (public.role_can_edit_warenrechnungen())
  WITH CHECK (public.role_can_edit_warenrechnungen());

DROP POLICY IF EXISTS "authenticated_read_supplier_document_splits"   ON public.supplier_document_splits;
DROP POLICY IF EXISTS "authenticated_manage_supplier_document_splits" ON public.supplier_document_splits;
CREATE POLICY authenticated_read_supplier_document_splits ON public.supplier_document_splits
  FOR SELECT TO authenticated USING (public.role_can_view_warenrechnungen());
CREATE POLICY authenticated_manage_supplier_document_splits ON public.supplier_document_splits
  FOR ALL TO authenticated
  USING (public.role_can_edit_warenrechnungen())
  WITH CHECK (public.role_can_edit_warenrechnungen());

-- ── employees: tenant row-scoping (wage-COLUMN hiding is a separate,
--    documented follow-up — see header comment) ────────────────────────────
-- Tenant is derived from the id prefix convention ('b-' = Beaulieu), the
-- same convention the app itself already enforces client-side in
-- src/lib/supabase-db.ts's upsertEmployee() prefix guard.
-- Physical delete is against this app's own data-integrity rule (see
-- SchedulePlanner.tsx's handleRemoveEmployee comment: "Physisches Löschen
-- ist verboten") — restricted to admin here as a DB-level backstop, not
-- because any current UI flow performs one.

DROP POLICY IF EXISTS "auth_employees_select" ON public.employees;
DROP POLICY IF EXISTS "auth_employees_insert" ON public.employees;
DROP POLICY IF EXISTS "auth_employees_update" ON public.employees;
DROP POLICY IF EXISTS "auth_employees_delete" ON public.employees;
DROP POLICY IF EXISTS "Anon self-register new employee" ON public.employees;
DROP POLICY IF EXISTS employees_select ON public.employees;
DROP POLICY IF EXISTS employees_insert ON public.employees;
DROP POLICY IF EXISTS employees_update ON public.employees;
DROP POLICY IF EXISTS employees_delete ON public.employees;

CREATE POLICY employees_select ON public.employees
  FOR SELECT TO authenticated
  USING (public.role_can_access_tenant(CASE WHEN id LIKE 'b-%' THEN 'beaulieu' ELSE 'oliv' END));
CREATE POLICY employees_insert ON public.employees
  FOR INSERT TO authenticated
  WITH CHECK (public.role_can_edit_employees(CASE WHEN id LIKE 'b-%' THEN 'beaulieu' ELSE 'oliv' END));
CREATE POLICY employees_update ON public.employees
  FOR UPDATE TO authenticated
  USING (public.role_can_edit_employees(CASE WHEN id LIKE 'b-%' THEN 'beaulieu' ELSE 'oliv' END))
  WITH CHECK (public.role_can_edit_employees(CASE WHEN id LIKE 'b-%' THEN 'beaulieu' ELSE 'oliv' END));
CREATE POLICY employees_delete ON public.employees
  FOR DELETE TO authenticated USING (public.current_user_role() = 'admin');

REVOKE ALL ON public.employees FROM anon;

-- ── schedule_extra_cost_people: real tenant_id column, same wage-column
--    caveat as employees (hourly_wage stays visible to whichever role can
--    read the row at all — see header comment). ────────────────────────────

DROP POLICY IF EXISTS "auth_extracost_select" ON public.schedule_extra_cost_people;
DROP POLICY IF EXISTS "auth_extracost_insert" ON public.schedule_extra_cost_people;
DROP POLICY IF EXISTS "auth_extracost_update" ON public.schedule_extra_cost_people;
DROP POLICY IF EXISTS "auth_extracost_delete" ON public.schedule_extra_cost_people;

CREATE POLICY auth_extracost_select ON public.schedule_extra_cost_people
  FOR SELECT TO authenticated USING (public.role_can_access_tenant(tenant_id));
CREATE POLICY auth_extracost_insert ON public.schedule_extra_cost_people
  FOR INSERT TO authenticated WITH CHECK (public.role_can_write_tenant_data(tenant_id));
CREATE POLICY auth_extracost_update ON public.schedule_extra_cost_people
  FOR UPDATE TO authenticated
  USING (public.role_can_write_tenant_data(tenant_id))
  WITH CHECK (public.role_can_write_tenant_data(tenant_id));
CREATE POLICY auth_extracost_delete ON public.schedule_extra_cost_people
  FOR DELETE TO authenticated USING (public.role_can_write_tenant_data(tenant_id));

NOTIFY pgrst, 'reload schema';
