-- Migration: RPC-Funktion für öffentliche Confirmation-Page
-- Ausführen im Supabase SQL-Editor.
--
-- Warum wird diese Funktion benötigt?
-- employees, actual_hours und employee_time_balances haben RLS-Policies
-- die nur "authenticated"-Nutzer erlauben. Die Confirmation-Page ist jedoch
-- eine öffentliche Seite (kein Login). Diese SECURITY DEFINER Funktion
-- läuft server-seitig mit erhöhten Rechten und gibt NUR die Daten zurück,
-- die zum übergebenen Token gehören — sicher und minimal.

CREATE OR REPLACE FUNCTION get_confirmation_page_data(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conf RECORD;
  v_emp  RECORD;
  v_days JSON;
  v_bal  RECORD;
  v_from DATE;
  v_to   DATE;
BEGIN
  -- 1. Confirmation via Token laden
  SELECT * INTO v_conf
  FROM employee_timesheet_confirmations
  WHERE token = p_token;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- 2. Datumsgrenzen berechnen
  v_from := make_date(v_conf.year, v_conf.month, 1);
  v_to   := (v_from + INTERVAL '1 month' - INTERVAL '1 day')::DATE;

  -- 3. Mitarbeiterdaten
  SELECT id, name, department, weekly_hours INTO v_emp
  FROM employees
  WHERE id = v_conf.employee_id;

  -- 4. Ist-Stunden (actual_hours) für den Monat
  SELECT json_agg(
    json_build_object(
      'date',            ah.date,
      'hours',           COALESCE(ah.hours, 0),
      'start_time',      ah.start_time,
      'end_time',        ah.end_time,
      'absence_type',    ah.absence_type,
      'manually_edited', COALESCE(ah.manually_edited, false),
      'is_locked',       COALESCE(ah.is_locked, false)
    ) ORDER BY ah.date
  ) INTO v_days
  FROM actual_hours ah
  WHERE ah.employee_id = v_conf.employee_id
    AND ah.date >= v_from
    AND ah.date <= v_to;

  -- 5. Zeitguthaben
  SELECT
    vacation_balance_hours,
    public_holiday_balance_hours,
    overtime_balance_hours,
    compensation_balance_hours
  INTO v_bal
  FROM employee_time_balances
  WHERE employee_id = v_conf.employee_id
    AND year  = v_conf.year
    AND month = v_conf.month;

  RETURN json_build_object(
    'confirmation', row_to_json(v_conf),
    'employee',     row_to_json(v_emp),
    'days',         COALESCE(v_days, '[]'::JSON),
    'balances',     row_to_json(v_bal),
    '_debug', json_build_object(
      'employee_id',   v_conf.employee_id,
      'tenant_id',     v_conf.tenant_id,
      'year',          v_conf.year,
      'month',         v_conf.month,
      'date_from',     v_from,
      'date_to',       v_to,
      'emp_found',     (v_emp.id IS NOT NULL),
      'days_count',    (SELECT count(*) FROM actual_hours
                        WHERE employee_id = v_conf.employee_id
                          AND date >= v_from AND date <= v_to)
    )
  );
END;
$$;

-- Anon und authenticated dürfen die Funktion aufrufen
-- (Daten werden intern durch Token-Lookup geschützt)
GRANT EXECUTE ON FUNCTION get_confirmation_page_data(TEXT) TO anon, authenticated;
