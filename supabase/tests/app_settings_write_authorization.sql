-- Run after migrations in a disposable/local Supabase database.
-- Every fixture and write is rolled back.
BEGIN;

INSERT INTO auth.users
  (id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('40000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'app-settings-admin@test.invalid', '', now(), '{}', '{}', now(), now()),
  ('40000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'app-settings-service@test.invalid', '', now(), '{}', '{}', now(), now()),
  ('40000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'app-settings-beaulieu@test.invalid', '', now(), '{}', '{}', now(), now()),
  ('40000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'app-settings-viewer@test.invalid', '', now(), '{}', '{}', now(), now()),
  ('40000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'app-settings-kueche@test.invalid', '', now(), '{}', '{}', now(), now()),
  ('40000000-0000-0000-0000-000000000006', 'authenticated', 'authenticated', 'app-settings-legacy-manager@test.invalid', '', now(), '{}', '{}', now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.user_profiles (id, role) VALUES
  ('40000000-0000-0000-0000-000000000001', 'admin'),
  ('40000000-0000-0000-0000-000000000002', 'service_manager'),
  ('40000000-0000-0000-0000-000000000003', 'beaulieu_manager'),
  ('40000000-0000-0000-0000-000000000004', 'beaulieu_viewer'),
  ('40000000-0000-0000-0000-000000000005', 'kueche_manager'),
  ('40000000-0000-0000-0000-000000000006', 'manager')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;

-- Seed rows as migration/service context (auth.uid() is NULL).
INSERT INTO public.app_settings(key, value) VALUES
  ('schedule-v2-2099-01', '{}'::jsonb),
  ('shift-config', '{}'::jsonb),
  ('beaulieu:schedule-v2-2099-01', '{}'::jsonb),
  ('budget_v1', '{}'::jsonb),
  ('beaulieu:budget_v1', '{}'::jsonb),
  ('beaulieu:dailyBudgets', '{}'::jsonb),
  ('control-list:v1:beaulieu', '{}'::jsonb),
  ('app-settings-test-unknown', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Small assertion helper: expected SQLSTATE 42501 must be raised.
CREATE OR REPLACE FUNCTION pg_temp.expect_app_settings_denied(p_sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN;
  END;
  RAISE EXCEPTION 'Expected app_settings write to be denied: %', p_sql;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.expect_app_settings_no_rows(p_sql text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_rows bigint;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'Expected app_settings write to affect zero rows: %', p_sql;
  END IF;
END;
$$;

-- Table-driven inventory regression: each concrete key family/pattern has a
-- category and tenant assertion. This runs before SET ROLE, because the
-- classifier is intentionally not executable by API roles.
DO $$
DECLARE r record; actual_category text; actual_tenant text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('admin_password', 'admin_system', 'global'),
      ('shift-config', 'schedule', 'global'),
      ('produkte_data_v2', 'operational', 'global'),
      ('beaulieu:revenue_weekday_percentages', 'admin_system', 'beaulieu'),
      ('reservation_counting_v1', 'admin_system', 'oliv'),
      ('takeaway_offered_v1', 'admin_system', 'oliv'),
      ('reviews_data:beaulieu', 'admin_system', 'beaulieu'),
      ('reservation_seasons:oliv', 'admin_system', 'oliv'),
      ('budget_v1', 'finance', 'oliv'),
      ('beaulieu:socialCostRates_v1', 'finance', 'beaulieu'),
      ('weq-kalkuliert:2099', 'finance', 'oliv'),
      ('beaulieu:weq-kalkuliert:2099', 'finance', 'beaulieu'),
      ('cockpit-budget:2099', 'finance', 'oliv'),
      ('schedule-employees', 'schedule', 'oliv'),
      ('beaulieu:staffing_targets_v1', 'schedule', 'beaulieu'),
      ('schedule_templates_v1', 'schedule', 'oliv'),
      ('beaulieu:employee_availability_v1', 'schedule', 'beaulieu'),
      ('planning_assistant_v1', 'schedule', 'oliv'),
      ('beaulieu:schedule-v2-2099-01', 'schedule', 'beaulieu'),
      ('actual-hours-2099-01', 'schedule', 'oliv'),
      ('absence-ist-2099-01', 'schedule', 'oliv'),
      ('schedule_absences_2099-01', 'schedule', 'oliv'),
      ('mirus_open_hours:beaulieu', 'schedule', 'beaulieu'),
      ('mirus_ist_werte:beaulieu:2099-01', 'schedule', 'beaulieu'),
      ('mirus_name_aliases:oliv', 'schedule', 'oliv'),
      ('schedule_proposals:beaulieu', 'schedule', 'beaulieu'),
      ('sort-order:beaulieu:service', 'schedule', 'beaulieu'),
      ('ist_day_locks:beaulieu:2099-01', 'schedule', 'beaulieu'),
      ('overtime-disabled', 'schedule', 'oliv'),
      ('beaulieu:ueberstunden-absenzen:2099', 'schedule', 'beaulieu'),
      ('dailyBudgets', 'operational', 'oliv'),
      ('beaulieu:dailyRevenueOverrides', 'operational', 'beaulieu'),
      ('vj_daily:beaulieu:2099-01-01', 'operational', 'beaulieu'),
      ('control-list:v1:beaulieu', 'operational', 'beaulieu'),
      ('waren_lieferanten_profile_v1', 'operational', 'oliv'),
      ('beaulieu:avgcheck-daily', 'operational', 'beaulieu'),
      ('beaulieu:maison-daily', 'operational', 'beaulieu'),
      ('import_settings_v1', 'admin_system', 'oliv'),
      ('beaulieu:inventur_checks_v1', 'operational', 'beaulieu'),
      ('import_undo_log:beaulieu', 'operational', 'beaulieu'),
      ('import/document-abc', 'operational', 'oliv'),
      ('beaulieu:import/document-abc', 'operational', 'beaulieu'),
      ('pfix-flex-ist-overrides-2099-01', 'operational', 'oliv'),
      ('beaulieu:personalfix-flex-overrides-v1', 'operational', 'beaulieu'),
      ('weq-modus:2099', 'operational', 'oliv'),
      ('prior_year_locked:beaulieu:2099', 'operational', 'beaulieu'),
      ('cockpit_row_order_v1', 'operational', 'oliv'),
      ('beaulieu:contractHistory', 'operational', 'beaulieu'),
      ('beaulieu:importCockpitControlChecks', 'operational', 'beaulieu'),
      ('staffing_profiles:beaulieu', 'operational', 'beaulieu'),
      ('ug_event_days:oliv', 'operational', 'oliv'),
      ('not-an-inventoried-key', NULL::text, 'oliv')
    ) AS cases(key, expected_category, expected_tenant)
  LOOP
    SELECT category, tenant INTO actual_category, actual_tenant
    FROM public.app_setting_key_scope(r.key);
    IF actual_category IS DISTINCT FROM r.expected_category
       OR actual_tenant IS DISTINCT FROM r.expected_tenant THEN
      RAISE EXCEPTION 'Bad scope for %: got (%, %), expected (%, %)',
        r.key, actual_category, actual_tenant, r.expected_category, r.expected_tenant;
    END IF;
  END LOOP;
END $$;

-- service_manager: authenticated reads and Oliv schedule writes work.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_settings WHERE key = 'budget_v1') THEN
    RAISE EXCEPTION 'Authenticated app_settings read was not preserved';
  END IF;
END $$;
UPDATE public.app_settings SET value = '{"ok":true}' WHERE key = 'schedule-v2-2099-01';
SELECT pg_temp.expect_app_settings_no_rows(
  $$UPDATE public.app_settings SET value='{"bad":true}' WHERE key='beaulieu:schedule-v2-2099-01'$$);
SELECT pg_temp.expect_app_settings_no_rows(
  $$UPDATE public.app_settings SET value='{"bad":true}' WHERE key='budget_v1'$$);
SELECT pg_temp.expect_app_settings_no_rows(
  $$UPDATE public.app_settings SET value='{"bad":true}' WHERE key='shift-config'$$);
SELECT pg_temp.expect_app_settings_denied(
  $$UPDATE public.app_settings SET key='budget_v1' WHERE key='schedule-v2-2099-01'$$);
SELECT pg_temp.expect_app_settings_denied(
  $$INSERT INTO public.app_settings(key,value) VALUES ('unknown-direct-key','{}')$$);
RESET ROLE;

-- kueche_manager has the same Oliv schedule boundary.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000005', true);
INSERT INTO public.app_settings(key, value) VALUES ('actual-hours-2099-02', '{}');
SELECT pg_temp.expect_app_settings_denied(
  $$INSERT INTO public.app_settings(key,value) VALUES ('beaulieu:actual-hours-2099-02','{}')$$);
RESET ROLE;

-- Historical `manager` rows remain constraint-compatible but have no writes.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000006', true);
SELECT pg_temp.expect_app_settings_denied(
  $$INSERT INTO public.app_settings(key,value) VALUES ('schedule-v2-2099-03','{}')$$);
SELECT pg_temp.expect_app_settings_no_rows(
  $$UPDATE public.app_settings SET value='{"bad":true}' WHERE key='schedule-v2-2099-01'$$);
RESET ROLE;

-- beaulieu_manager: own operational/schedule yes; finance/system and Oliv no.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000003', true);
UPDATE public.app_settings SET value = '{"ok":true}' WHERE key = 'beaulieu:dailyBudgets';
UPDATE public.app_settings SET value = '{"ok":true}' WHERE key = 'beaulieu:schedule-v2-2099-01';
UPDATE public.app_settings SET value = '{"version":1}' WHERE key = 'control-list:v1:beaulieu';
INSERT INTO public.app_settings(key, value) VALUES
  ('mirus_ist_werte:beaulieu:2099-01', '{}'),
  ('beaulieu:importCockpitControlChecks', '{}');
SELECT pg_temp.expect_app_settings_no_rows(
  $$UPDATE public.app_settings SET value='{"bad":true}' WHERE key='beaulieu:budget_v1'$$);
SELECT pg_temp.expect_app_settings_no_rows(
  $$UPDATE public.app_settings SET value='{"bad":true}' WHERE key='schedule-v2-2099-01'$$);
SELECT pg_temp.expect_app_settings_denied(
  $$INSERT INTO public.app_settings(key,value) VALUES ('beaulieu:admin_password','"bad"')$$);
SELECT pg_temp.expect_app_settings_denied(
  $$INSERT INTO public.app_settings(key,value) VALUES ('mirus_ist_werte:oliv:2099-01','{}')$$);
SELECT pg_temp.expect_app_settings_denied(
  $$INSERT INTO public.app_settings(key,value) VALUES ('mirus_ist_werte:invalid:2099-01','{}')$$);
SELECT pg_temp.expect_app_settings_denied(
  $$INSERT INTO public.app_settings(key,value) VALUES ('importCockpitControlChecks','{}')$$);
SELECT pg_temp.expect_app_settings_denied(
  $$INSERT INTO public.app_settings(key,value) VALUES ('invalid:importCockpitControlChecks','{}')$$);
RESET ROLE;

-- Viewer cannot INSERT, UPDATE, DELETE, or rename a key.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000004', true);
SELECT pg_temp.expect_app_settings_denied(
  $$INSERT INTO public.app_settings(key,value) VALUES ('beaulieu:dailyRevenueOverrides','{}')$$);
SELECT pg_temp.expect_app_settings_no_rows(
  $$UPDATE public.app_settings SET value='{"bad":true}' WHERE key='beaulieu:dailyBudgets'$$);
SELECT pg_temp.expect_app_settings_no_rows(
  $$DELETE FROM public.app_settings WHERE key='beaulieu:dailyBudgets'$$);
SELECT pg_temp.expect_app_settings_no_rows(
  $$UPDATE public.app_settings SET key='beaulieu:dailyBudgets' WHERE key='app-settings-test-unknown'$$);
RESET ROLE;

-- Admin can write both tenants, but deny-by-default still rejects unknown keys.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000001', true);
UPDATE public.app_settings SET value = '{"ok":true}' WHERE key = 'budget_v1';
UPDATE public.app_settings SET value = '{"ok":true}' WHERE key = 'beaulieu:budget_v1';
UPDATE public.app_settings SET value = '{"ok":true}' WHERE key = 'shift-config';
UPDATE public.app_settings SET value = '{"ok":true}'
WHERE key IN ('revenue_weekday_percentages', 'beaulieu:revenue_weekday_percentages');
DELETE FROM public.app_settings WHERE key = 'control-list:v1:beaulieu';
SELECT pg_temp.expect_app_settings_no_rows(
  $$UPDATE public.app_settings SET value='{"bad":true}' WHERE key='app-settings-test-unknown'$$);
SELECT pg_temp.expect_app_settings_denied(
  $$UPDATE public.app_settings SET key='admin-invented-family' WHERE key='budget_v1'$$);
RESET ROLE;

-- A direct service/migration write with no JWT uid remains possible.
SELECT set_config('request.jwt.claim.sub', '', true);
INSERT INTO public.app_settings(key, value)
VALUES ('service-migration-unknown-key', '{}');

ROLLBACK;