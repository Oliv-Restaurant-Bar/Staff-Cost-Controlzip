-- Kürzere Dienstplan-Links: 12 Zeichen aus A-Z a-z 0-9 (~71 Bit, kryptografisch
-- zufällig) statt 64 Hex-Zeichen. Link-Pfad im Frontend: /s/<token>.
--
-- Hängt von 20261023_schedule_share.sql ab. Manuell im Supabase SQL-Editor
-- ausführen. Idempotent (auch erneut ausführbar, falls eine frühere Fassung
-- dieser Datei schon gelaufen ist).
--
-- ACHTUNG: Bereits ausgegebene LÄNGERE Links (> 12 Zeichen) werden hier durch
-- kurze ersetzt und funktionieren danach nicht mehr — vor dem produktiven
-- Einsatz unkritisch (nur Test-Links).
--
-- Token-Bildung: Bytes 0-5 und 9-15 einer UUID v4 (Byte 6/8 tragen feste
-- Versions-/Variant-Bits und werden übersprungen), je Byte -> Zeichen via mod 62.
-- Der Modulo-Bias ist vernachlässigbar (< 0,1 Bit Entropieverlust je Zeichen).

BEGIN;

CREATE OR REPLACE FUNCTION public.schedule_share_new_token()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  b   bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  idx int[] := ARRAY[0,1,2,3,4,5,9,10,11,12,13,14];
  token_out text := '';
  i   int;
BEGIN
  FOREACH i IN ARRAY idx LOOP
    token_out := token_out || substr(alphabet, (get_byte(b, i) % 62) + 1, 1);
  END LOOP;
  RETURN token_out;
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_share_new_token() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.schedule_share_get_link(p_tenant text, p_department text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token text;
BEGIN
  PERFORM public.schedule_share_assert_allowed(p_tenant, p_department);

  INSERT INTO public.schedule_share_links (tenant_id, department, token)
  VALUES (p_tenant, p_department, public.schedule_share_new_token())
  ON CONFLICT (tenant_id, department) DO NOTHING;

  SELECT token INTO v_token
  FROM public.schedule_share_links
  WHERE tenant_id = p_tenant AND department = p_department;

  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.schedule_share_rotate_link(p_tenant text, p_department text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token text := public.schedule_share_new_token();
BEGIN
  PERFORM public.schedule_share_assert_allowed(p_tenant, p_department);

  INSERT INTO public.schedule_share_links (tenant_id, department, token, rotated_at)
  VALUES (p_tenant, p_department, v_token, now())
  ON CONFLICT (tenant_id, department)
  DO UPDATE SET token = EXCLUDED.token, rotated_at = now();

  RETURN v_token;
END;
$$;

-- Öffentlicher Abruf: Mindestlänge 10 (kurze Tokens), sonst unverändert zu 20261023.
CREATE OR REPLACE FUNCTION public.schedule_public_get(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link   public.schedule_share_links%ROWTYPE;
  v_weeks  jsonb;
BEGIN
  IF p_token IS NULL OR length(p_token) < 10 OR length(p_token) > 128 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_link FROM public.schedule_share_links WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'week_start', t.week_start,
             'revision', t.revision,
             'published_at', t.published_at,
             'payload', jsonb_set(
               t.payload,
               '{employees}',
               COALESCE(
                 (SELECT jsonb_agg(e - 'id')
                  FROM jsonb_array_elements(t.payload->'employees') AS e),
                 '[]'::jsonb))
           ) ORDER BY t.week_start), '[]'::jsonb)
    INTO v_weeks
  FROM (
    SELECT w.week_start, w.revision, w.published_at, w.payload
    FROM public.published_schedule_weeks w
    WHERE w.tenant_id = v_link.tenant_id
      AND w.department = v_link.department
      AND w.week_start BETWEEN (current_date - 7) AND (current_date + 60)
    ORDER BY w.week_start
    LIMIT 12
  ) t;

  RETURN jsonb_build_object(
    'tenant', v_link.tenant_id,
    'department', v_link.department,
    'weeks', v_weeks);
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_public_get(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.schedule_public_get(text) TO anon, authenticated;

-- Bestehende längere Test-Links auf kurze umstellen.
UPDATE public.schedule_share_links
SET token = public.schedule_share_new_token(), rotated_at = now()
WHERE length(token) > 12;

COMMIT;
