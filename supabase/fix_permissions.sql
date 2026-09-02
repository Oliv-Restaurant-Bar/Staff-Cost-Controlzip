-- =============================================================
-- SOFORT-FIX: Fehlende Tabellenberechtigungen
-- Dieses Skript im Supabase SQL-Editor ausführen
-- =============================================================

-- Schema-Zugriff gewähren
GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- Vollzugriff für eingeloggte Benutzer auf alle vier Tabellen
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.schedule_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.actual_hours     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings     TO authenticated;

-- Sequenzen (für auto-generierte IDs)
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- RLS auf allen Tabellen sicherstellen (falls jemand sie deaktiviert hat)
ALTER TABLE public.employees        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.actual_hours     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings     ENABLE ROW LEVEL SECURITY;

-- Bestehende Policies löschen und neu anlegen (falls doppelt vorhanden)
DROP POLICY IF EXISTS "auth_employees_select"  ON public.employees;
DROP POLICY IF EXISTS "auth_employees_insert"  ON public.employees;
DROP POLICY IF EXISTS "auth_employees_update"  ON public.employees;
DROP POLICY IF EXISTS "auth_employees_delete"  ON public.employees;

DROP POLICY IF EXISTS "auth_schedule_select"   ON public.schedule_entries;
DROP POLICY IF EXISTS "auth_schedule_insert"   ON public.schedule_entries;
DROP POLICY IF EXISTS "auth_schedule_update"   ON public.schedule_entries;
DROP POLICY IF EXISTS "auth_schedule_delete"   ON public.schedule_entries;

DROP POLICY IF EXISTS "auth_actual_select"     ON public.actual_hours;
DROP POLICY IF EXISTS "auth_actual_insert"     ON public.actual_hours;
DROP POLICY IF EXISTS "auth_actual_update"     ON public.actual_hours;
DROP POLICY IF EXISTS "auth_actual_delete"     ON public.actual_hours;

DROP POLICY IF EXISTS "auth_settings_select"   ON public.app_settings;
DROP POLICY IF EXISTS "auth_settings_insert"   ON public.app_settings;
DROP POLICY IF EXISTS "auth_settings_update"   ON public.app_settings;
DROP POLICY IF EXISTS "auth_settings_delete"   ON public.app_settings;

-- Policies neu anlegen
CREATE POLICY "auth_employees_select"  ON public.employees        FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_employees_insert"  ON public.employees        FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_employees_update"  ON public.employees        FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_employees_delete"  ON public.employees        FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_schedule_select"   ON public.schedule_entries FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_schedule_insert"   ON public.schedule_entries FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_schedule_update"   ON public.schedule_entries FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_schedule_delete"   ON public.schedule_entries FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_actual_select"     ON public.actual_hours     FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_actual_insert"     ON public.actual_hours     FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_actual_update"     ON public.actual_hours     FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_actual_delete"     ON public.actual_hours     FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_settings_select"   ON public.app_settings     FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_settings_insert"   ON public.app_settings     FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_settings_update"   ON public.app_settings     FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_settings_delete"   ON public.app_settings     FOR DELETE TO authenticated USING (true);

-- Fehlende Mitarbeiter nachtragen (sicher: ON CONFLICT überspringt bereits existierende)
INSERT INTO public.employees (id, name, department, employment_type, hourly_wage)
VALUES ('24', 'Sajed', 'kueche', 'vollzeit', 20.36)
ON CONFLICT (id) DO NOTHING;

-- app_settings deny-by-default (standalone; does not rely on migrations).
-- Families: admin_system=settings/integrations; finance=budget/reporting/
-- accounting/rates/targets; operational=revenue/products/guests/personal_fix/
-- imports/invoices/control-list; schedule=schedule/actual/absence/shift/mirus.
-- Tenant follows beaulieu:<key> or the embedded tenant conventions used by
-- vj_daily, control-list, staffing_profiles, ug_event_days, reviews_data,
-- reservation_seasons,
-- mirus_name_aliases and sort-order. Everything else is Oliv.
-- Explicit raw legacy globals (shift-config/product master stores) derive to
-- `global` and are consequently admin-only.
CREATE OR REPLACE FUNCTION public.app_setting_key_scope(p_key text)
RETURNS TABLE(category text, tenant text)
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  WITH n AS (
    SELECT CASE WHEN p_key LIKE 'beaulieu:%' THEN substr(p_key,10) ELSE p_key END base_key,
      CASE WHEN p_key LIKE 'beaulieu:%' THEN 'beaulieu'
        WHEN p_key ~ '^(admin_password|shift-config|timeEntries|account_mappings_v1|artikel_master_v1|basis_komponenten_v1|produkte_rezeptur_v1|produkte_data_v2|produkte_ignored_v1|produkte_cost_v1|produkte_groups_v1)$' THEN 'global'
        WHEN p_key ~ '^vj_daily:(oliv|beaulieu):' THEN (regexp_match(p_key,'^vj_daily:(oliv|beaulieu):'))[1]
        WHEN p_key ~ '^control-list:v1:(oliv|beaulieu)$' THEN (regexp_match(p_key,'^control-list:v1:(oliv|beaulieu)$'))[1]
        WHEN p_key ~ '^(staffing_profiles|ug_event_days|reviews_data|reservation_seasons|mirus_name_aliases|mirus_open_hours|mirus_ist_werte|schedule_proposals|import_undo_log|ist_day_locks|prior_year_locked):(oliv|beaulieu)(:|$)' THEN (regexp_match(p_key,'^(?:staffing_profiles|ug_event_days|reviews_data|reservation_seasons|mirus_name_aliases|mirus_open_hours|mirus_ist_werte|schedule_proposals|import_undo_log|ist_day_locks|prior_year_locked):(oliv|beaulieu)(?::|$)'))[1]
        WHEN p_key ~ '^sort-order:(oliv|beaulieu):' THEN (regexp_match(p_key,'^sort-order:(oliv|beaulieu):'))[1]
        ELSE 'oliv' END derived_tenant)
  SELECT CASE
    WHEN base_key ~ '^(admin_password|revenue_weekday_percentages|labor_cost_threshold|staff-portal-settings)$'
      OR base_key ~ '^(foratable|reservation|takeaway|import_settings|season_definitions)([:_-]|$)' THEN 'admin_system'
    WHEN p_key ~ '^(reviews_data|reservation_seasons):(oliv|beaulieu)(:|$)' THEN 'admin_system'
    WHEN base_key ~ '^(budget_v1|reporting_v1|sage_journal_v1|account_mappings_v1|annualCostImports_v1|mwst_rates_v1|social_cost_rates_v1|socialCostRates_v1|ziel_personalquote_v1|ziel_warenquote_v1|kpi_targets_v1|kpi_comments_v1)$'
      OR base_key ~ '^weq-kalkuliert:'
      OR base_key ~ '^cockpit-budget:'
      THEN 'finance'
    WHEN base_key ~ '^(schedule-employees|shift-config|timeEntries|no_time_tracking_v1|overtime-disabled|staffing_targets_v1|schedule_templates_v1|employee_availability_v1|planning_assistant_v1)$'
      OR base_key ~ '^(schedule-v2-|actual-hours-|absence-ist-|schedule_absences_|schedule-proposal|schedule_proposal|mirus_)'
      OR p_key ~ '^ist_day_locks:(oliv|beaulieu):'
      OR base_key ~ '^ueberstunden-absenzen:'
      OR p_key ~ '^sort-order:(oliv|beaulieu):' OR p_key ~ '^mirus_name_aliases:(oliv|beaulieu)$' THEN 'schedule'
    WHEN base_key ~ '^(dailyBudgets|dailyRevenueOverrides|produkte_data_v2|produkte_ignored_v1|produkte_cost_v1|produkte_groups_v1|produkte_rezeptur_v1|basis_komponenten_v1|artikel_master_v1|umsatz_kategorien_v1|umsatz_kategorien_undo_v1|ta-gaeste-daily|waren_abgleich_ignoriert_v1|waren_kreditoren_zuordnung_v1|waren_kreditoren_ignoriert_v1|suppliers_v1|fs_historie_lock_v1|vj2025_imported_v1|vj2025_beaulieu_imported_v1|cockpit_row_order_v1|contractHistory|importCockpitControlChecks)$'
      OR base_key ~ '^(personal_fix_|pfix-flex-ist-overrides-|personalfix-flex-overrides|weq-modus:|prior_year_locked:)'
      OR base_key ~ '^(verkaufszahlen|adyenAbstimmung|tagesabschluss|gaeste|reviews|avgcheck|umsatzprogast|maison|import|inventur|waren|lieferanten|journal_dedupe|kuechenplan_import_undo)([:_-]|$)'
      OR base_key ~ '^import/'
      OR p_key ~ '^vj_daily:(oliv|beaulieu):' OR p_key ~ '^control-list:v1:(oliv|beaulieu)$'
      OR p_key ~ '^(staffing_profiles|ug_event_days):(oliv|beaulieu)$' THEN 'operational'
    ELSE NULL END, derived_tenant FROM n;
$$;
CREATE OR REPLACE FUNCTION public.app_setting_write_allowed(p_key text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_role text; v_category text; v_tenant text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN true; END IF;
  SELECT s.category,s.tenant INTO v_category,v_tenant FROM public.app_setting_key_scope(p_key) s;
  IF v_category IS NULL OR v_tenant NOT IN ('oliv','beaulieu','global') THEN RETURN false; END IF;
  SELECT role INTO v_role FROM public.user_profiles WHERE id=auth.uid();
  RETURN CASE WHEN v_role='admin' THEN true
    WHEN v_role IN ('service_manager','kueche_manager') THEN v_tenant='oliv' AND v_category='schedule'
    WHEN v_role='beaulieu_manager' THEN v_tenant='beaulieu' AND v_category IN ('operational','schedule')
    ELSE false END;
END; $$;
DO $$
BEGIN
  IF to_regclass('public.user_profiles') IS NOT NULL THEN
    ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_check;
    ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_role_check
      CHECK (role IN ('admin','service_manager','kueche_manager','beaulieu_manager','beaulieu_viewer','manager'));
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION public.protect_app_settings_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP<>'INSERT' AND NOT public.app_setting_write_allowed(OLD.key) THEN
    RAISE EXCEPTION 'Keine Berechtigung zum Ändern der App-Einstellung %',OLD.key USING ERRCODE='42501'; END IF;
  IF TG_OP<>'DELETE' AND NOT public.app_setting_write_allowed(NEW.key) THEN
    RAISE EXCEPTION 'Keine Berechtigung zum Ändern der App-Einstellung %',NEW.key USING ERRCODE='42501'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;
DROP POLICY IF EXISTS "auth_settings_insert" ON public.app_settings;
DROP POLICY IF EXISTS "auth_settings_update" ON public.app_settings;
DROP POLICY IF EXISTS "auth_settings_delete" ON public.app_settings;
CREATE POLICY "auth_settings_insert" ON public.app_settings FOR INSERT TO authenticated WITH CHECK(public.app_setting_write_allowed(key));
CREATE POLICY "auth_settings_update" ON public.app_settings FOR UPDATE TO authenticated USING(public.app_setting_write_allowed(key)) WITH CHECK(public.app_setting_write_allowed(key));
CREATE POLICY "auth_settings_delete" ON public.app_settings FOR DELETE TO authenticated USING(public.app_setting_write_allowed(key));
DROP TRIGGER IF EXISTS trg_protect_app_settings_write ON public.app_settings;
CREATE TRIGGER trg_protect_app_settings_write BEFORE INSERT OR UPDATE OR DELETE ON public.app_settings FOR EACH ROW EXECUTE FUNCTION public.protect_app_settings_write();
REVOKE ALL ON FUNCTION public.app_setting_key_scope(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.app_setting_write_allowed(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.protect_app_settings_write() FROM PUBLIC,anon,authenticated;
-- Required by RLS predicate evaluation; classifier and trigger remain private.
GRANT EXECUTE ON FUNCTION public.app_setting_write_allowed(text) TO authenticated;
