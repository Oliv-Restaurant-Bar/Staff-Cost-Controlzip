-- ============================================================
-- Nachschärfung zum anon-Lockdown (Review-Findings)
--  1) Storage onboarding-docs: anon-SELECT (las ALLE HR-Dokumente!) weg;
--     authenticated-SELECT neu (Admin-Ansicht via Login). anon-INSERT bleibt
--     (öffentliches Onboarding-Formular lädt Dokumente hoch, Bucket privat).
--  2) Öffentliche RPCs mit Eingabe-Limits gegen Spam/Missbrauch.
-- Idempotent.
-- ============================================================

-- ── 1) Storage-Policies ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anon read own onboarding docs" ON storage.objects;
DROP POLICY IF EXISTS onboarding_docs_select_auth ON storage.objects;
CREATE POLICY onboarding_docs_select_auth ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'onboarding-docs');

-- ── 2) RPC-Härtung ───────────────────────────────────────────────────────────
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
  -- Eingabe-Limits (Missbrauchsschutz)
  IF p_request_type NOT IN ('general', 'question', 'correction_request') THEN
    RETURN json_build_object('ok', false, 'reason', 'invalid_type');
  END IF;
  IF p_message IS NOT NULL AND length(p_message) > 4000 THEN
    RETURN json_build_object('ok', false, 'reason', 'message_too_long');
  END IF;
  IF p_category IS NOT NULL AND length(p_category) > 100 THEN
    RETURN json_build_object('ok', false, 'reason', 'invalid_category');
  END IF;
  -- Max. 50 offene Requests pro Confirmation (Spam-Bremse)
  IF (SELECT count(*) FROM timesheet_employee_requests WHERE confirmation_id = v_conf.id) >= 50 THEN
    RETURN json_build_object('ok', false, 'reason', 'too_many_requests');
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
  IF length(p_name) > 200 THEN
    RETURN json_build_object('ok', false, 'reason', 'name_too_long');
  END IF;
  IF p_form_data IS NOT NULL AND length(p_form_data::text) > 20000 THEN
    RETURN json_build_object('ok', false, 'reason', 'payload_too_large');
  END IF;
  INSERT INTO onboarding_submissions (id, name, form_data)
  VALUES (v_id, btrim(p_name), COALESCE(p_form_data, '{}'::jsonb));
  RETURN json_build_object('ok', true, 'id', v_id);
END;
$$;

NOTIFY pgrst, 'reload schema';
