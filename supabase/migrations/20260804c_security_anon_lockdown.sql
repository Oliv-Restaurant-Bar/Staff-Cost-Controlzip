-- ============================================================
-- Migration: Sicherheitslücken schliessen — anon-Rolle aussperren
-- (DDL im Supabase SQL-Editor bzw. via Management-API ausführen.)
--
-- 1) employee_wages: anon-SELECT-Policy + Grants entfernen (Policies nur
--    noch TO authenticated) — Nachschärfung von 20260508_employee_wages_fix_rls.sql.
-- 2) employee_timesheet_confirmations: direkte anon-Tabellenrechte entfernen.
--    Der öffentliche Token-Bestätigungs-Flow (Mitarbeiter ohne Login) läuft
--    danach AUSSCHLIESSLICH über token-geprüfte SECURITY-DEFINER-RPCs:
--    get_confirmation_page_data (lesen, bestehend) + NEU
--    confirm_timesheet_by_token / question_timesheet_by_token /
--    reject_timesheet_by_token (schreiben).
-- 3) gn_person_imports, gn_person_metrics, gn_analysis_imports,
--    gn_analysis_metrics: exakt das Muster aus 20260619_gn_rls_fix.sql
--    (diese Tabellen wurden dort vergessen).
--
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================

-- ── 1+2+3: RLS + Policies nur authenticated + REVOKE anon ────────────────────
DO $$
DECLARE
  t       text;
  polname text;
  tbls    text[] := ARRAY[
    'employee_wages',
    'employee_timesheet_confirmations',
    'gn_person_imports',
    'gn_person_metrics',
    'gn_analysis_imports',
    'gn_analysis_metrics'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE NOTICE 'Tabelle %.% existiert nicht — übersprungen.', 'public', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);

    -- Sauberer Neustart: ALLE bestehenden Policies entfernen
    -- (inkl. anon-Policies mit USING(true)).
    FOR polname IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I;', polname, t);
    END LOOP;

    -- Neue Policies: ausschliesslich authenticated.
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true);',
      t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (true);',
      t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (true) WITH CHECK (true);',
      t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (true);',
      t || '_delete', t);

    -- GRANTs (Postgres prüft GRANT VOR RLS) + anon vollständig entziehen.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated;', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END $$;

-- ── 2b: Token-geprüfte Schreib-RPCs für den öffentlichen Bestätigungs-Flow ──
-- SECURITY DEFINER: läuft mit Owner-Rechten, gibt aber NUR den Datensatz
-- zum übergebenen Token frei. Statusregeln:
--   * Token unbekannt          → {'ok':false,'reason':'invalid'}
--   * abgelaufen (expires_at)  → {'ok':false,'reason':'expired'}
--   * bereits final (confirmed/finalized/rejected) → {'ok':false,'reason':'already_done'}
--   * sonst: Statuswechsel und {'ok':true,'status':<neu>}

CREATE OR REPLACE FUNCTION confirm_timesheet_by_token(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conf RECORD;
BEGIN
  SELECT * INTO v_conf FROM employee_timesheet_confirmations WHERE token = p_token;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'reason', 'invalid'); END IF;
  IF v_conf.expires_at IS NOT NULL AND v_conf.expires_at < now() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;
  IF v_conf.status IN ('confirmed', 'finalized', 'rejected') THEN
    RETURN json_build_object('ok', false, 'reason', 'already_done', 'status', v_conf.status);
  END IF;
  UPDATE employee_timesheet_confirmations
  SET status = 'confirmed', confirmed_at = now(), updated_at = now()
  WHERE token = p_token;
  RETURN json_build_object('ok', true, 'status', 'confirmed');
END;
$$;

CREATE OR REPLACE FUNCTION question_timesheet_by_token(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conf RECORD;
BEGIN
  SELECT * INTO v_conf FROM employee_timesheet_confirmations WHERE token = p_token;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'reason', 'invalid'); END IF;
  IF v_conf.expires_at IS NOT NULL AND v_conf.expires_at < now() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;
  IF v_conf.status IN ('confirmed', 'finalized', 'rejected') THEN
    RETURN json_build_object('ok', false, 'reason', 'already_done', 'status', v_conf.status);
  END IF;
  UPDATE employee_timesheet_confirmations
  SET status = 'question_open', updated_at = now()
  WHERE token = p_token;
  RETURN json_build_object('ok', true, 'status', 'question_open');
END;
$$;

CREATE OR REPLACE FUNCTION reject_timesheet_by_token(p_token TEXT, p_comment TEXT DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conf RECORD;
BEGIN
  SELECT * INTO v_conf FROM employee_timesheet_confirmations WHERE token = p_token;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'reason', 'invalid'); END IF;
  IF v_conf.expires_at IS NOT NULL AND v_conf.expires_at < now() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;
  IF v_conf.status IN ('confirmed', 'finalized', 'rejected') THEN
    RETURN json_build_object('ok', false, 'reason', 'already_done', 'status', v_conf.status);
  END IF;
  UPDATE employee_timesheet_confirmations
  SET status = 'rejected', rejected_at = now(),
      employee_comment = NULLIF(p_comment, ''), updated_at = now()
  WHERE token = p_token;
  RETURN json_build_object('ok', true, 'status', 'rejected');
END;
$$;

GRANT EXECUTE ON FUNCTION confirm_timesheet_by_token(TEXT)        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION question_timesheet_by_token(TEXT)       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION reject_timesheet_by_token(TEXT, TEXT)   TO anon, authenticated;

-- PostgREST-Schema-Cache neu laden (neue RPCs + geänderte Rechte).
NOTIFY pgrst, 'reload schema';
