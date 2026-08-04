-- ============================================================
-- Migration: VOLLSTÄNDIGER anon-Sperr-Durchlauf
-- (Manuell im Supabase SQL-Editor ausführen bzw. via Management-API.)
--
-- ZIEL: Ohne Login (anon-Rolle, öffentlicher Key im JS-Bundle) ist KEIN
-- direkter Tabellenzugriff möglich — nicht lesen, nicht schreiben.
-- Eingeloggte Nutzer (authenticated) bleiben unverändert.
--
-- AUSNAHMEN (minimal):
--  a) Gast-Freigabe / publizierter Dienstplan (Passwort clientseitig geprüft):
--     app_settings SELECT nur key LIKE 'published-schedule:%' (read-only,
--     PII-frei) + Mitarbeiter-Feedback WRITE-only auf 'staff-feedback:%'-Keys
--     (kein Lesen fremder Keys möglich).
--  b) Mitarbeiter-Token-Flows AUSSCHLIESSLICH über token-geprüfte
--     SECURITY-DEFINER-RPCs:
--     – Stundenblatt-Bestätigung: get_confirmation_page_data +
--       confirm/question/reject_timesheet_by_token (20260804c) + NEU
--       Rückfragen (timesheet_employee_requests) per RPC.
--     – Onboarding (/onboarding/:token + Selbst-Anmeldung): NEU per RPC,
--       direkte anon-Policies auf employees/onboarding_submissions entfallen.
--
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================

-- ── TEIL 1: Flächendeckend sperren ───────────────────────────────────────────
-- Für JEDE Tabelle in public: RLS an, anon-Rechte weg, alle Policies mit
-- Rolle anon ODER public (=ohne TO) entfernen. Tabellen, die danach GAR KEINE
-- Policy mehr haben (bisher RLS-off- oder public-Policy-Tabellen), bekommen
-- das Standard-Muster «nur authenticated» (wie 20260619_gn_rls_fix.sql).
DO $$
DECLARE
  t        text;
  pol      RECORD;
  remaining int;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);

    -- Policies mit anon- oder public-Rolle entfernen.
    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
        AND (roles @> ARRAY['anon'::name] OR roles @> ARRAY['public'::name])
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I;', pol.policyname, t);
    END LOOP;

    -- Ohne verbleibende Policies: Standard-authenticated-Policies anlegen,
    -- sonst wären eingeloggte Nutzer ausgesperrt (RLS neu aktiv).
    SELECT count(*) INTO remaining FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t;
    IF remaining = 0 THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true);',  t || '_select', t);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (true);', t || '_insert', t);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (true) WITH CHECK (true);', t || '_update', t);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (true);',  t || '_delete', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated;', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role;', t);
    END IF;
  END LOOP;
END $$;

-- Alles Übrige (Views, Sequenzen) + Zukunftssicherung.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
-- Schema-USAGE für anon bleibt: nötig für RPC-Aufrufe (EXECUTE-Grants unten).
GRANT USAGE ON SCHEMA public TO anon;

-- ── TEIL 2: Ausnahme (a) — Gast-Freigabe publizierter Dienstplan ─────────────
-- Read-only, PII-frei: NUR published-schedule-Keys. Plus Mitarbeiter-Feedback
-- als reine Schreib-Policy (staff-feedback-Keys sind über die SELECT-Policy
-- NICHT lesbar → kein Datenabfluss).
GRANT SELECT, INSERT, UPDATE ON public.app_settings TO anon;

CREATE POLICY anon_published_schedule_read ON public.app_settings
  FOR SELECT TO anon USING (key LIKE 'published-schedule:%');
CREATE POLICY anon_staff_feedback_insert ON public.app_settings
  FOR INSERT TO anon WITH CHECK (key LIKE 'staff-feedback:%');
CREATE POLICY anon_staff_feedback_update ON public.app_settings
  FOR UPDATE TO anon USING (key LIKE 'staff-feedback:%') WITH CHECK (key LIKE 'staff-feedback:%');

-- ── TEIL 3: Ausnahme (b1) — Stundenblatt-Rückfragen per Token-RPC ────────────
-- (Bestätigen/Ablehnen/Rückfrage-Status laufen bereits über 20260804c-RPCs.)

CREATE OR REPLACE FUNCTION get_timesheet_requests_by_token(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conf RECORD;
  v_out  JSON;
BEGIN
  SELECT * INTO v_conf FROM employee_timesheet_confirmations WHERE token = p_token;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'reason', 'invalid'); END IF;
  SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.created_at DESC), '[]'::json)
  INTO v_out
  FROM timesheet_employee_requests r
  WHERE r.confirmation_id = v_conf.id;
  RETURN json_build_object('ok', true, 'requests', v_out);
END;
$$;

CREATE OR REPLACE FUNCTION create_timesheet_request_by_token(
  p_token TEXT,
  p_request_type TEXT,
  p_message TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_date TEXT DEFAULT NULL,
  p_requested_hours NUMERIC DEFAULT NULL,
  p_requested_start_time TEXT DEFAULT NULL,
  p_requested_end_time TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conf RECORD;
  v_id   UUID;
BEGIN
  SELECT * INTO v_conf FROM employee_timesheet_confirmations WHERE token = p_token;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'reason', 'invalid'); END IF;
  IF v_conf.expires_at IS NOT NULL AND v_conf.expires_at < now() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;
  -- Tenant/Mitarbeiter/Monat kommen aus der Confirmation — Client-Angaben
  -- dazu werden bewusst IGNORIERT (kein Cross-Tenant-Schreiben möglich).
  INSERT INTO timesheet_employee_requests (
    confirmation_id, tenant_id, employee_id, date, month, year,
    request_type, category, message, requested_hours,
    requested_start_time, requested_end_time, status
  ) VALUES (
    v_conf.id, v_conf.tenant_id, v_conf.employee_id,
    NULLIF(p_date, '')::date, v_conf.month, v_conf.year,
    p_request_type, NULLIF(p_category, ''), NULLIF(p_message, ''),
    p_requested_hours, NULLIF(p_requested_start_time, ''), NULLIF(p_requested_end_time, ''),
    'open'
  ) RETURNING id INTO v_id;
  RETURN json_build_object('ok', true, 'id', v_id);
END;
$$;

-- ── TEIL 4: Ausnahme (b2) — Onboarding per Token-RPC ─────────────────────────

CREATE OR REPLACE FUNCTION get_onboarding_employee_by_token(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp RECORD;
BEGIN
  IF p_token IS NULL OR p_token = '' THEN RETURN NULL; END IF;
  SELECT id, name, department, onboarding_status,
         position_title, contract_start, contract_type,
         birth_date, nationality, permit_type, marital_status,
         spouse_employed, spouse_lives_in_switzerland,
         phone, email, address_street, address_zip, address_city,
         ahv_number, iban
  INTO v_emp
  FROM employees
  WHERE onboarding_token = p_token;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN row_to_json(v_emp);
END;
$$;

CREATE OR REPLACE FUNCTION mark_onboarding_in_progress_by_token(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE employees
  SET onboarding_status = 'in_progress'
  WHERE onboarding_token = p_token
    AND onboarding_status IN ('prepared', 'sent');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN json_build_object('ok', v_count > 0);
END;
$$;

CREATE OR REPLACE FUNCTION submit_onboarding_by_token(
  p_token TEXT,
  p_data JSONB,
  p_documents JSONB DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp RECORD;
BEGIN
  SELECT id, onboarding_status INTO v_emp
  FROM employees WHERE onboarding_token = p_token;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'reason', 'invalid'); END IF;
  IF v_emp.onboarding_status NOT IN ('prepared', 'sent', 'in_progress') THEN
    RETURN json_build_object('ok', false, 'reason', 'already_done');
  END IF;
  UPDATE employees SET
    birth_date                  = NULLIF(p_data->>'birthDate', '')::date,
    nationality                 = NULLIF(p_data->>'nationality', ''),
    phone                       = NULLIF(p_data->>'phone', ''),
    email                       = NULLIF(p_data->>'email', ''),
    address_street              = NULLIF(p_data->>'addressStreet', ''),
    address_zip                 = NULLIF(p_data->>'addressZip', ''),
    address_city                = NULLIF(p_data->>'addressCity', ''),
    ahv_number                  = NULLIF(p_data->>'ahvNumber', ''),
    iban                        = NULLIF(p_data->>'iban', ''),
    permit_type                 = NULLIF(p_data->>'permitType', ''),
    marital_status              = NULLIF(p_data->>'maritalStatus', ''),
    spouse_employed             = CASE WHEN p_data ? 'spouseEmployed' AND p_data->>'spouseEmployed' <> ''
                                       THEN (p_data->>'spouseEmployed')::boolean ELSE NULL END,
    spouse_lives_in_switzerland = CASE WHEN p_data ? 'spouseLivesInSwitzerland' AND p_data->>'spouseLivesInSwitzerland' <> ''
                                       THEN (p_data->>'spouseLivesInSwitzerland')::boolean ELSE NULL END,
    onboarding_documents        = CASE WHEN p_documents IS NOT NULL AND jsonb_array_length(p_documents) > 0
                                       THEN p_documents::text ELSE NULL END,
    onboarding_status           = 'completed'
  WHERE id = v_emp.id;
  RETURN json_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION create_onboarding_submission_public(
  p_name TEXT,
  p_form_data JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID := gen_random_uuid();
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RETURN json_build_object('ok', false, 'reason', 'name_required');
  END IF;
  INSERT INTO onboarding_submissions (id, name, form_data)
  VALUES (v_id, btrim(p_name), COALESCE(p_form_data, '{}'::jsonb));
  RETURN json_build_object('ok', true, 'id', v_id);
END;
$$;

GRANT EXECUTE ON FUNCTION get_timesheet_requests_by_token(TEXT)                 TO anon, authenticated;
GRANT EXECUTE ON FUNCTION create_timesheet_request_by_token(TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,TEXT,TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_onboarding_employee_by_token(TEXT)                TO anon, authenticated;
GRANT EXECUTE ON FUNCTION mark_onboarding_in_progress_by_token(TEXT)            TO anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_onboarding_by_token(TEXT,JSONB,JSONB)          TO anon, authenticated;
GRANT EXECUTE ON FUNCTION create_onboarding_submission_public(TEXT,JSONB)       TO anon, authenticated;

-- PostgREST-Schema-Cache neu laden.
NOTIFY pgrst, 'reload schema';
