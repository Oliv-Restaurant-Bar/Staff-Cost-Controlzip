-- Kontrolllistenstatus sicher schreiben:
-- - admin: OLIV und Beaulieu
-- - beaulieu_manager: nur Beaulieu
-- - alle anderen authentifizierten Rollen: nur lesen
-- Der Trigger schützt die festen Keys auch bei direkten app_settings-Writes.

CREATE OR REPLACE FUNCTION public.assert_control_list_key_write_allowed(p_key text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  IF p_key NOT LIKE 'control-list:v1:%' THEN
    RETURN;
  END IF;

  -- Service-Role/Migrationen haben keine Benutzer-UID und bleiben funktionsfähig.
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  SELECT role INTO v_role
  FROM public.user_profiles
  WHERE id = auth.uid();

  IF v_role = 'admin' THEN
    RETURN;
  END IF;

  IF v_role = 'beaulieu_manager' AND p_key = 'control-list:v1:beaulieu' THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'Keine Berechtigung zum Ändern des Kontrolllistenstatus'
    USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_control_list_state_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.assert_control_list_key_write_allowed(OLD.key);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.assert_control_list_key_write_allowed(NEW.key);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_control_list_state_write ON public.app_settings;
CREATE TRIGGER trg_protect_control_list_state_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_control_list_state_write();

CREATE OR REPLACE FUNCTION public.save_control_list_state(
  p_tenant text,
  p_value jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Anmeldung erforderlich' USING ERRCODE = '42501';
  END IF;

  IF p_tenant NOT IN ('oliv', 'beaulieu') THEN
    RAISE EXCEPTION 'Ungültiger Mandant' USING ERRCODE = '22023';
  END IF;

  IF p_value IS NULL
     OR jsonb_typeof(p_value) <> 'object'
     OR p_value->>'version' IS DISTINCT FROM '1'
     OR jsonb_typeof(COALESCE(p_value->'departments', '{}'::jsonb)) <> 'object'
     OR jsonb_typeof(COALESCE(p_value->'helperSelections', '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'Ungültiger Kontrolllistenstatus' USING ERRCODE = '22023';
  END IF;

  v_key := 'control-list:v1:' || p_tenant;
  PERFORM public.assert_control_list_key_write_allowed(v_key);

  INSERT INTO public.app_settings (key, value, updated_at)
  VALUES (v_key, p_value, now())
  ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.assert_control_list_key_write_allowed(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_control_list_state_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_control_list_state(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_control_list_state(text, jsonb) TO authenticated;