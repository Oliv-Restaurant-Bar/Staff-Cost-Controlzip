-- =============================================================
-- Personalkostentracker – Datenbankeinrichtung (neues Projekt)
-- Dieses Skript einmalig im Supabase SQL-Editor ausführen
-- =============================================================

-- Mitarbeitertabelle
CREATE TABLE IF NOT EXISTS public.employees (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  department TEXT NOT NULL CHECK (department IN ('service', 'kueche')),
  employment_type TEXT NOT NULL DEFAULT 'aushilfe'
    CHECK (employment_type IN ('vollzeit', 'teilzeit', 'minijob', 'aushilfe')),
  hourly_wage NUMERIC(10,2) NOT NULL DEFAULT 0,
  weekly_hours NUMERIC(5,2),
  monthly_salary NUMERIC(10,2),
  monthly_salary_with_13th NUMERIC(10,2),
  days_off TEXT[] DEFAULT '{}',
  preferred_work_days TEXT[] DEFAULT '{}',
  hours_balance NUMERIC(8,2),
  vacation_balance NUMERIC(8,2),
  vacation_days_per_year NUMERIC(5,1),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Dienstplantabelle (Soll-Stunden pro Mitarbeiter und Tag)
CREATE TABLE IF NOT EXISTS public.schedule_entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  frueh_start TEXT,
  frueh_end TEXT,
  frueh_absence TEXT,
  spaet_start TEXT,
  spaet_end TEXT,
  spaet_absence TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, date)
);

-- Ist-Stunden-Tabelle (tatsächlich geleistete Stunden)
CREATE TABLE IF NOT EXISTS public.actual_hours (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  hours NUMERIC(5,2),
  start_time TEXT,
  end_time TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, date)
);

-- App-Einstellungen (geteilte Konfiguration für alle Benutzer)
CREATE TABLE IF NOT EXISTS public.app_settings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Row Level Security aktivieren
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.actual_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Berechtigungen: nur angemeldete Benutzer dürfen lesen/schreiben
CREATE POLICY "auth_employees_select" ON public.employees FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_employees_insert" ON public.employees FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_employees_update" ON public.employees FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_employees_delete" ON public.employees FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_schedule_select" ON public.schedule_entries FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_schedule_insert" ON public.schedule_entries FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_schedule_update" ON public.schedule_entries FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_schedule_delete" ON public.schedule_entries FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_actual_select" ON public.actual_hours FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_actual_insert" ON public.actual_hours FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_actual_update" ON public.actual_hours FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_actual_delete" ON public.actual_hours FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_settings_select" ON public.app_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_settings_insert" ON public.app_settings FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_settings_update" ON public.app_settings FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_settings_delete" ON public.app_settings FOR DELETE TO authenticated USING (true);

-- Zugriffsrechte für eingeloggte Benutzer (GRANT muss immer gesetzt werden!)
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.schedule_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.actual_hours     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings     TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Indizes für schnellere Abfragen
CREATE INDEX IF NOT EXISTS idx_schedule_employee_date ON public.schedule_entries(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_schedule_date ON public.schedule_entries(date);
CREATE INDEX IF NOT EXISTS idx_actual_employee_date ON public.actual_hours(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_actual_date ON public.actual_hours(date);

-- Standardmitarbeiter eintragen (können später im Tool angepasst werden)
INSERT INTO public.employees (id, name, department, employment_type, hourly_wage, weekly_hours, monthly_salary, monthly_salary_with_13th) VALUES
  ('1',  'Mendim',             'service', 'vollzeit', 36.92, 42, 5538.45, 6203.06),
  ('2',  'Artin',              'service', 'vollzeit', 33.85, 42, 5076.95, 5686.18),
  ('3',  'Joana',              'service', 'teilzeit', 28.00, NULL, NULL, NULL),
  ('4',  'Husein',             'service', 'vollzeit', 31.33, 42, 5000.00, 5264.00),
  ('5',  'Eduard',             'service', 'vollzeit', 34.46, 42, 5169.25, 5789.56),
  ('6',  'Nahuel',             'service', 'vollzeit', 28.31, 42, 4246.50, 4756.08),
  ('7',  'Carlos',             'service', 'teilzeit', 24.70, NULL, NULL, NULL),
  ('8',  'Arber',              'service', 'vollzeit', 30.77, 42, 4615.40, 5169.25),
  ('9',  'Marion',             'service', 'vollzeit', 28.67, 42, 4576.95, 4816.00),
  ('10', 'Isabel',             'service', 'teilzeit', 26.37, NULL, NULL, NULL),
  ('11', 'David',              'service', 'vollzeit', 31.33, 42, 4700.00, 5264.00),
  ('12', 'Saad',               'service', 'vollzeit', 26.00, 42, 3900.00, 4368.00),
  ('13', 'Aushilfe Service',   'service', 'teilzeit', 20.50, NULL, NULL, NULL),
  ('14', 'Mejdi',              'kueche',  'vollzeit', 0.00, 42, 7400.00, 8288.00),
  ('15', 'Miro',               'kueche',  'vollzeit', 34.46, 42, 5169.00, 5789.28),
  ('16', 'Culi',               'kueche',  'vollzeit', 47.33, 42, 7100.00, 7952.00),
  ('17', 'Karel',              'kueche',  'vollzeit', 30.67, 42, 4600.00, 5152.00),
  ('18', 'Micky',              'kueche',  'vollzeit', 27.69, 42, 4153.85, 4652.31),
  ('19', 'Asim',               'kueche',  'vollzeit', 28.92, 42, 4338.45, 4859.06),
  ('20', 'Ali',                'kueche',  'teilzeit', 20.36, NULL, NULL, NULL),
  ('21', 'Sadete',             'kueche',  'teilzeit', 20.36, NULL, NULL, NULL),
  ('24', 'Sajed',              'kueche',  'vollzeit', 20.36, NULL, NULL, NULL),
  ('22', 'Aushilfe 1 Küche F', 'kueche', 'teilzeit', 30.00, NULL, NULL, NULL),
  ('23', 'Aushilfe 2 Küche A', 'kueche', 'teilzeit', 30.00, NULL, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- app_settings Schreibschutz (eigenständig; keine Migration vorausgesetzt).
-- Inventar/Klassen: admin_system = admin_password, weekday/labor/settings/
-- integration configuration; finance = budget/reporting/accounting/rates/
-- targets; operational = revenue, products, guests, imports, personal_fix,
-- invoices/reconciliation/control-list; schedule = schedules, actual/absence
-- hours, shift/sort/mirus/proposals. Unbekannte Familien werden verweigert.
-- Tenant: beaulieu:<key>; ansonsten Oliv, ausser den etablierten eingebetteten
-- Formen vj_daily/control-list/staffing_profiles/ug_event_days/
-- reviews_data/reservation_seasons/mirus_name_aliases/sort-order:<tenant>:...
-- Raw legacy globals (shift-config/product master stores) derive to `global`
-- and therefore remain admin-only; tenant-aware Oliv schedule keys stay Oliv.
CREATE OR REPLACE FUNCTION public.app_setting_key_scope(p_key text)
RETURNS TABLE(category text, tenant text)
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  WITH n AS (
    SELECT CASE WHEN p_key LIKE 'beaulieu:%' THEN substr(p_key, 10) ELSE p_key END base_key,
      CASE
        WHEN p_key LIKE 'beaulieu:%' THEN 'beaulieu'
        WHEN p_key ~ '^(admin_password|shift-config|timeEntries|account_mappings_v1|artikel_master_v1|basis_komponenten_v1|produkte_rezeptur_v1|produkte_data_v2|produkte_ignored_v1|produkte_cost_v1|produkte_groups_v1)$' THEN 'global'
        WHEN p_key ~ '^vj_daily:(oliv|beaulieu):' THEN (regexp_match(p_key, '^vj_daily:(oliv|beaulieu):'))[1]
        WHEN p_key ~ '^control-list:v1:(oliv|beaulieu)$' THEN (regexp_match(p_key, '^control-list:v1:(oliv|beaulieu)$'))[1]
        WHEN p_key ~ '^(staffing_profiles|ug_event_days|reviews_data|reservation_seasons|mirus_name_aliases|mirus_open_hours|mirus_ist_werte|schedule_proposals|import_undo_log|ist_day_locks|prior_year_locked):(oliv|beaulieu)(:|$)' THEN (regexp_match(p_key, '^(?:staffing_profiles|ug_event_days|reviews_data|reservation_seasons|mirus_name_aliases|mirus_open_hours|mirus_ist_werte|schedule_proposals|import_undo_log|ist_day_locks|prior_year_locked):(oliv|beaulieu)(?::|$)'))[1]
        WHEN p_key ~ '^sort-order:(oliv|beaulieu):' THEN (regexp_match(p_key, '^sort-order:(oliv|beaulieu):'))[1]
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
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role text; v_category text; v_tenant text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN true; END IF;
  SELECT s.category, s.tenant INTO v_category, v_tenant
    FROM public.app_setting_key_scope(p_key) s;
  IF v_category IS NULL OR v_tenant NOT IN ('oliv', 'beaulieu', 'global') THEN RETURN false; END IF;
  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();
  RETURN CASE
    WHEN v_role = 'admin' THEN true
    WHEN v_role IN ('service_manager','kueche_manager') THEN v_tenant='oliv' AND v_category='schedule'
    WHEN v_role = 'beaulieu_manager' THEN v_tenant='beaulieu' AND v_category IN ('operational','schedule')
    ELSE false END;
END; $$;

-- `add_user_roles.sql` creates this table in a new project.  If it already
-- exists, make its role constraint match all application roles and preserve
-- historical `manager` rows (the authorization predicate still denies them).
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
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND NOT public.app_setting_write_allowed(OLD.key) THEN
    RAISE EXCEPTION 'Keine Berechtigung zum Ändern der App-Einstellung %', OLD.key USING ERRCODE='42501';
  END IF;
  IF TG_OP <> 'DELETE' AND NOT public.app_setting_write_allowed(NEW.key) THEN
    RAISE EXCEPTION 'Keine Berechtigung zum Ändern der App-Einstellung %', NEW.key USING ERRCODE='42501';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;

DROP POLICY IF EXISTS "auth_settings_insert" ON public.app_settings;
DROP POLICY IF EXISTS "auth_settings_update" ON public.app_settings;
DROP POLICY IF EXISTS "auth_settings_delete" ON public.app_settings;
CREATE POLICY "auth_settings_insert" ON public.app_settings FOR INSERT TO authenticated
  WITH CHECK (public.app_setting_write_allowed(key));
CREATE POLICY "auth_settings_update" ON public.app_settings FOR UPDATE TO authenticated
  USING (public.app_setting_write_allowed(key)) WITH CHECK (public.app_setting_write_allowed(key));
CREATE POLICY "auth_settings_delete" ON public.app_settings FOR DELETE TO authenticated
  USING (public.app_setting_write_allowed(key));
DROP TRIGGER IF EXISTS trg_protect_app_settings_write ON public.app_settings;
CREATE TRIGGER trg_protect_app_settings_write BEFORE INSERT OR UPDATE OR DELETE
  ON public.app_settings FOR EACH ROW EXECUTE FUNCTION public.protect_app_settings_write();
REVOKE ALL ON FUNCTION public.app_setting_key_scope(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.app_setting_write_allowed(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_app_settings_write() FROM PUBLIC, anon, authenticated;
-- Required because RLS evaluates its predicate as authenticated; all other
-- helper functions remain private.
GRANT EXECUTE ON FUNCTION public.app_setting_write_allowed(text) TO authenticated;
