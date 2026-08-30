-- Ramadani Mejdi ist ein normaler Fixlohn-Mitarbeiter. Historische
-- Zusatzkosten-Flags hatten seine Dienstplanstunden aus allgemeinen Summen
-- entfernt und zusätzlich stundenbasierte Kosten erzeugt.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.employees
    WHERE id = '14' AND lower(name) LIKE '%mejdi%'
  ) THEN
    RAISE EXCEPTION 'Sicherheitsabbruch: OLIV-Mitarbeiter 14 / Mejdi nicht eindeutig gefunden';
  END IF;

  UPDATE public.employees
  SET employment_type = 'vollzeit',
      contract_type = 'monthly',
      hourly_wage = 0
  WHERE id = '14'
    AND lower(name) LIKE '%mejdi%';

  UPDATE public.actual_hours a
  SET is_additional_cost_ist = false
  FROM public.employees e
  WHERE a.employee_id = e.id
    AND e.id = '14'
    AND lower(e.name) LIKE '%mejdi%'
    AND a.is_additional_cost_ist = true;

  UPDATE public.schedule_entries s
  SET is_additional_cost_plan = false
  FROM public.employees e
  WHERE s.employee_id = e.id
    AND e.id = '14'
    AND lower(e.name) LIKE '%mejdi%'
    AND s.is_additional_cost_plan = true;

  UPDATE public.schedule_extra_cost_people
  SET is_active = false,
      archived_at = COALESCE(archived_at, now())
  WHERE tenant_id = 'oliv'
    AND is_active = true
    AND lower(trim(name)) IN ('ramadani mejdi', 'mejdi', 'lokaj mendim', 'mendim');

  INSERT INTO public.app_settings (key, value)
  VALUES ('no_time_tracking_v1', '{"14": true, "103": true}'::jsonb)
  ON CONFLICT (key) DO UPDATE
  SET value = COALESCE(public.app_settings.value, '{}'::jsonb)
              || '{"14": true, "103": true}'::jsonb;
END $$;