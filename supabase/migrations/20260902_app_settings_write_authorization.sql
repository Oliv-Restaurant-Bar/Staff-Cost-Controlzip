-- Server-side authorization for the shared app_settings KV store.
--
-- Writable key-family inventory (unknown families are denied):
--   admin_system
--     admin_password; revenue_weekday_percentages; labor_cost_threshold;
--     staff-portal-settings; foratable_*; reservation_*; takeaway_*;
--     import_settings_*; season_definitions:*.
--     reviews_data:<tenant>; reservation_seasons:<tenant>.
--   finance
--     budget_v1; reporting_v1; sage_journal_v1; account_mappings_v1;
--     annualCostImports_v1; mwst_rates_v1; social_cost_rates_v1;
--     ziel_personalquote_v1; ziel_warenquote_v1; kpi_targets_v1;
--     kpi_comments_v1.
--     socialCostRates_v1; weq-kalkuliert:<year>.
--     cockpit-budget:<year>.
--   operational
--     dailyBudgets; dailyRevenueOverrides; verkaufszahlen_*; vj_daily:*;
--     products/articles/recipes/components; guest, import, inventory,
--     invoice/reconciliation and daily-closing families; control-list:v1:*;
--     staffing_profiles:*, ug_event_days:* and personal_fix_*.
--     pfix-/personalfix-flex overrides; weq-modus:<year>; prior_year_locked:*;
--     cockpit row order and document keys beginning import/.
--     contractHistory.
--     importCockpitControlChecks.
--   schedule
--     schedule-employees; schedule-v2-*; actual-hours-*; absence-ist-*;
--     schedule_absences_*; shift-config; sort-order:*; timeEntries;
--     mirus scheduling/name/open-hours families; no_time_tracking_v1;
--     overtime-disabled and schedule proposals.
--     ist_day_locks:<tenant>:<month>.
--     ueberstunden-absenzen:<year>.
--     staffing_targets_v1; schedule_templates_v1; employee_availability_v1;
--     planning_assistant_v1.
--     mirus_ist_werte:<tenant>:<YYYY-MM>.
--
-- Tenant conventions:
--   * "beaulieu:<base-key>" is Beaulieu; an unprefixed base key is Oliv.
--   * The explicitly raw legacy globals (for example shift-config and product
--     master stores) derive to `global`; they remain classified but only admin
--     can write them. Tenant-aware Oliv legacy schedule keys remain Oliv.
--   * vj_daily:<tenant>:..., control-list:v1:<tenant>,
--     staffing_profiles:<tenant>, ug_event_days:<tenant>, reviews_data:<tenant>,
--     reservation_seasons:<tenant>, mirus_name_aliases:<tenant> and
--     sort-order:<tenant>:... carry the tenant
--     in the established embedded position.
--
-- Both RLS and a BEFORE trigger enforce the same decision.  RLS provides the
-- normal API boundary; the trigger also protects direct SQL and checks both
-- OLD and NEW keys on UPDATE, so a key rename cannot escape authorization.
-- auth.uid() IS NULL deliberately remains available to service-role jobs and
-- migrations.  Authenticated SELECT remains unchanged.

CREATE OR REPLACE FUNCTION public.app_setting_key_scope(p_key text)
RETURNS TABLE(category text, tenant text)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH normalized AS (
    SELECT
      CASE
        WHEN p_key LIKE 'beaulieu:%' THEN substr(p_key, 10)
        ELSE p_key
      END AS base_key,
      CASE
        WHEN p_key LIKE 'beaulieu:%' THEN 'beaulieu'
        WHEN p_key ~ '^(admin_password|shift-config|timeEntries|account_mappings_v1|artikel_master_v1|basis_komponenten_v1|produkte_rezeptur_v1|produkte_data_v2|produkte_ignored_v1|produkte_cost_v1|produkte_groups_v1)$' THEN 'global'
        WHEN p_key ~ '^vj_daily:(oliv|beaulieu):' THEN
          (regexp_match(p_key, '^vj_daily:(oliv|beaulieu):'))[1]
        WHEN p_key ~ '^control-list:v1:(oliv|beaulieu)$' THEN
          (regexp_match(p_key, '^control-list:v1:(oliv|beaulieu)$'))[1]
        WHEN p_key ~ '^(staffing_profiles|ug_event_days|reviews_data|reservation_seasons|mirus_name_aliases|mirus_open_hours|mirus_ist_werte|schedule_proposals|import_undo_log|ist_day_locks|prior_year_locked):(oliv|beaulieu)(:|$)' THEN
          (regexp_match(p_key, '^(?:staffing_profiles|ug_event_days|reviews_data|reservation_seasons|mirus_name_aliases|mirus_open_hours|mirus_ist_werte|schedule_proposals|import_undo_log|ist_day_locks|prior_year_locked):(oliv|beaulieu)(?::|$)'))[1]
        WHEN p_key ~ '^sort-order:(oliv|beaulieu):' THEN
          (regexp_match(p_key, '^sort-order:(oliv|beaulieu):'))[1]
        ELSE 'oliv'
      END AS derived_tenant
  )
  SELECT
    CASE
      WHEN base_key ~ '^(admin_password|revenue_weekday_percentages|labor_cost_threshold|staff-portal-settings)$'
        OR base_key ~ '^(foratable|reservation|takeaway|import_settings|season_definitions)([:_-]|$)'
        OR p_key ~ '^(reviews_data|reservation_seasons):(oliv|beaulieu)(:|$)'
        THEN 'admin_system'

      WHEN base_key ~ '^(budget_v1|reporting_v1|sage_journal_v1|account_mappings_v1|annualCostImports_v1|mwst_rates_v1|social_cost_rates_v1|socialCostRates_v1|ziel_personalquote_v1|ziel_warenquote_v1|kpi_targets_v1|kpi_comments_v1)$'
        OR base_key ~ '^weq-kalkuliert:'
        OR base_key ~ '^cockpit-budget:'
        THEN 'finance'

      WHEN base_key ~ '^(schedule-employees|shift-config|timeEntries|no_time_tracking_v1|overtime-disabled|staffing_targets_v1|schedule_templates_v1|employee_availability_v1|planning_assistant_v1)$'
        OR base_key ~ '^(schedule-v2-|actual-hours-|absence-ist-|schedule_absences_|schedule-proposal|schedule_proposal|mirus_)'
        OR p_key ~ '^ist_day_locks:(oliv|beaulieu):'
        OR base_key ~ '^ueberstunden-absenzen:'
        OR p_key ~ '^sort-order:(oliv|beaulieu):'
        OR p_key ~ '^mirus_name_aliases:(oliv|beaulieu)$'
        THEN 'schedule'

      WHEN base_key ~ '^(dailyBudgets|dailyRevenueOverrides|produkte_data_v2|produkte_ignored_v1|produkte_cost_v1|produkte_groups_v1|produkte_rezeptur_v1|basis_komponenten_v1|artikel_master_v1|umsatz_kategorien_v1|umsatz_kategorien_undo_v1|ta-gaeste-daily|waren_abgleich_ignoriert_v1|waren_kreditoren_zuordnung_v1|waren_kreditoren_ignoriert_v1|suppliers_v1|fs_historie_lock_v1|vj2025_imported_v1|vj2025_beaulieu_imported_v1|cockpit_row_order_v1|contractHistory|importCockpitControlChecks)$'
        OR base_key ~ '^(personal_fix_|pfix-flex-ist-overrides-|personalfix-flex-overrides|weq-modus:|prior_year_locked:)'
        OR base_key ~ '^(verkaufszahlen|adyenAbstimmung|tagesabschluss|gaeste|reviews|avgcheck|umsatzprogast|maison|import|inventur|waren|lieferanten|journal_dedupe|kuechenplan_import_undo)([:_-]|$)'
        OR base_key ~ '^import/'
        OR p_key ~ '^vj_daily:(oliv|beaulieu):'
        OR p_key ~ '^control-list:v1:(oliv|beaulieu)$'
        OR p_key ~ '^(staffing_profiles|ug_event_days):(oliv|beaulieu)$'
        THEN 'operational'
      ELSE NULL
    END,
    derived_tenant
  FROM normalized;
$$;

CREATE OR REPLACE FUNCTION public.app_setting_write_allowed(p_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_category text;
  v_tenant text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN true;
  END IF;

  SELECT s.category, s.tenant
    INTO v_category, v_tenant
  FROM public.app_setting_key_scope(p_key) AS s;

  IF v_category IS NULL OR v_tenant NOT IN ('oliv', 'beaulieu', 'global') THEN
    RETURN false;
  END IF;

  SELECT role INTO v_role
  FROM public.user_profiles
  WHERE id = auth.uid();

  RETURN CASE
    WHEN v_role = 'admin' THEN true
    WHEN v_role IN ('service_manager', 'kueche_manager')
      THEN v_tenant = 'oliv' AND v_category = 'schedule'
    WHEN v_role = 'beaulieu_manager'
      THEN v_tenant = 'beaulieu'
       AND v_category IN ('operational', 'schedule')
    ELSE false
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_app_settings_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP <> 'INSERT'
     AND NOT public.app_setting_write_allowed(OLD.key) THEN
    RAISE EXCEPTION 'Keine Berechtigung zum Ändern der App-Einstellung %', OLD.key
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP <> 'DELETE'
     AND NOT public.app_setting_write_allowed(NEW.key) THEN
    RAISE EXCEPTION 'Keine Berechtigung zum Ändern der App-Einstellung %', NEW.key
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Earlier setup SQL constrained profiles to three roles.  The write predicate
-- is authoritative only when all roles used by the application can be stored.
-- Legacy `manager` is retained non-destructively in the CHECK, but deliberately
-- receives no write authorization (the predicate's ELSE false).
DO $$
BEGIN
  IF to_regclass('public.user_profiles') IS NOT NULL THEN
    ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_check;
    ALTER TABLE public.user_profiles
      ADD CONSTRAINT user_profiles_role_check
      CHECK (role IN ('admin', 'service_manager', 'kueche_manager',
                      'beaulieu_manager', 'beaulieu_viewer', 'manager'));
  END IF;
END;
$$;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_settings_insert" ON public.app_settings;
DROP POLICY IF EXISTS "auth_settings_update" ON public.app_settings;
DROP POLICY IF EXISTS "auth_settings_delete" ON public.app_settings;

CREATE POLICY "auth_settings_insert" ON public.app_settings
  FOR INSERT TO authenticated
  WITH CHECK (public.app_setting_write_allowed(key));
CREATE POLICY "auth_settings_update" ON public.app_settings
  FOR UPDATE TO authenticated
  USING (public.app_setting_write_allowed(key))
  WITH CHECK (public.app_setting_write_allowed(key));
CREATE POLICY "auth_settings_delete" ON public.app_settings
  FOR DELETE TO authenticated
  USING (public.app_setting_write_allowed(key));

DROP TRIGGER IF EXISTS trg_protect_app_settings_write ON public.app_settings;
CREATE TRIGGER trg_protect_app_settings_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.protect_app_settings_write();

REVOKE ALL ON FUNCTION public.app_setting_key_scope(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.app_setting_write_allowed(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_app_settings_write() FROM PUBLIC, anon, authenticated;
-- RLS evaluates this function as the requesting role, so authenticated needs
-- EXECUTE on this one boolean predicate. The classifier and trigger stay private.
GRANT EXECUTE ON FUNCTION public.app_setting_write_allowed(text) TO authenticated;