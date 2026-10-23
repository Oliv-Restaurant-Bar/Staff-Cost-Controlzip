-- Dienstplan per WhatsApp teilen: veröffentlichte Wochen + stabiler Abteilungs-Link.
--
-- Sicherheitsmodell (nach 20260805/20260806 anon-Sperre):
--   * Beide Tabellen: RLS an, KEINE Policies -> weder anon noch authenticated
--     können direkt lesen/schreiben. Zugriff nur über SECURITY DEFINER-Funktionen.
--   * Einzige anon-aufrufbare Funktion: schedule_public_get(token). Der Token ist
--     zufällig (>= 244 Bit), pro Mandant+Abteilung stabil, per Rotation widerrufbar.
--   * Die Payload wird beim Veröffentlichen SERVERSEITIG validiert (Schlüssel-
--     Whitelist, erlaubte Abwesenheitstexte, Größen/Datumsgrenzen). Löhne oder
--     freie Texte können so nicht gespeichert werden. Mitarbeiter-IDs werden in
--     der öffentlichen Antwort entfernt.
--
-- Manuell im Supabase SQL-Editor ausführen (zuerst Dev). Idempotent.

BEGIN;

-- ── Tabellen ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.schedule_share_links (
  tenant_id   text        NOT NULL,
  department  text        NOT NULL CHECK (department IN ('service', 'kueche')),
  token       text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  rotated_at  timestamptz,
  PRIMARY KEY (tenant_id, department)
);

CREATE TABLE IF NOT EXISTS public.published_schedule_weeks (
  tenant_id    text        NOT NULL,
  department   text        NOT NULL CHECK (department IN ('service', 'kueche')),
  week_start   date        NOT NULL,
  payload      jsonb       NOT NULL,
  revision     integer     NOT NULL DEFAULT 1,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  PRIMARY KEY (tenant_id, department, week_start)
);

ALTER TABLE public.schedule_share_links     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.published_schedule_weeks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.schedule_share_links     FROM anon, authenticated;
REVOKE ALL ON public.published_schedule_weeks FROM anon, authenticated;

-- ── Berechtigung ─────────────────────────────────────────────────────────────
-- admin: alles | service_manager: oliv/service | kueche_manager: oliv/kueche
-- beaulieu_manager: beaulieu, beide Abteilungen
CREATE OR REPLACE FUNCTION public.schedule_share_assert_allowed(p_tenant text, p_department text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  IF p_tenant NOT IN ('oliv', 'beaulieu') OR p_department NOT IN ('service', 'kueche') THEN
    RAISE EXCEPTION 'Ungültiger Mandant oder Abteilung' USING ERRCODE = '22023';
  END IF;

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Nicht angemeldet' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = auth.uid();

  IF v_role = 'admin'
     OR (v_role = 'service_manager'  AND p_tenant = 'oliv' AND p_department = 'service')
     OR (v_role = 'kueche_manager'   AND p_tenant = 'oliv' AND p_department = 'kueche')
     OR (v_role = 'beaulieu_manager' AND p_tenant = 'beaulieu')
  THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'Keine Berechtigung zum Veröffentlichen dieses Dienstplans'
    USING ERRCODE = '42501';
END;
$$;

-- ── Payload-Validierung (Whitelist) ──────────────────────────────────────────
-- Erlaubte öffentliche Abwesenheitstexte; Krankheit/Unfall werden bewusst nur als
-- "Abwesend" veröffentlicht (Gesundheitsdaten gehören nicht in einen weiterleitbaren Link).
CREATE OR REPLACE FUNCTION public.schedule_share_validate_payload(
  p_department text,
  p_week_start date,
  p_payload    jsonb
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_emp   jsonb;
  v_day   jsonb;
  v_slot  jsonb;
  v_field text;
  v_abs   text;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Ungültige Daten' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_payload::text) > 500000 THEN
    RAISE EXCEPTION 'Veröffentlichung zu groß' USING ERRCODE = '22023';
  END IF;
  IF (p_payload - ARRAY['version','department','weekStart','weekEnd','kw','employees']) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Unerwartete Felder in den Daten' USING ERRCODE = '22023';
  END IF;
  IF p_payload->>'department' IS DISTINCT FROM p_department
     OR p_payload->>'weekStart' IS DISTINCT FROM to_char(p_week_start, 'YYYY-MM-DD') THEN
    RAISE EXCEPTION 'Daten passen nicht zur Woche/Abteilung' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_payload->'employees') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_payload->'employees') > 200 THEN
    RAISE EXCEPTION 'Ungültige Mitarbeiterliste' USING ERRCODE = '22023';
  END IF;

  FOR v_emp IN SELECT * FROM jsonb_array_elements(p_payload->'employees') LOOP
    IF jsonb_typeof(v_emp) IS DISTINCT FROM 'object'
       OR (v_emp - ARRAY['id','name','days']) <> '{}'::jsonb
       OR jsonb_typeof(v_emp->'name') IS DISTINCT FROM 'string'
       OR char_length(v_emp->>'name') > 100
       OR jsonb_typeof(v_emp->'days') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_emp->'days') IS DISTINCT FROM 7 THEN
      RAISE EXCEPTION 'Ungültiger Mitarbeitereintrag' USING ERRCODE = '22023';
    END IF;

    FOR v_day IN SELECT * FROM jsonb_array_elements(v_emp->'days') LOOP
      IF jsonb_typeof(v_day) IS DISTINCT FROM 'object'
         OR (v_day - ARRAY['date','früh','spät','frühAbsence','spätAbsence',
                           'changed','previousFrüh','previousSpät']) <> '{}'::jsonb THEN
        RAISE EXCEPTION 'Ungültiger Tageseintrag' USING ERRCODE = '22023';
      END IF;

      FOREACH v_field IN ARRAY ARRAY['früh','spät','previousFrüh','previousSpät'] LOOP
        v_slot := v_day->v_field;
        IF v_slot IS NOT NULL AND jsonb_typeof(v_slot) <> 'null' THEN
          IF jsonb_typeof(v_slot) IS DISTINCT FROM 'object'
             OR (v_slot - ARRAY['start','end']) <> '{}'::jsonb
             OR char_length(COALESCE(v_slot->>'start', '')) NOT BETWEEN 1 AND 5
             OR char_length(COALESCE(v_slot->>'end', ''))   NOT BETWEEN 1 AND 5 THEN
            RAISE EXCEPTION 'Ungültige Schichtzeit' USING ERRCODE = '22023';
          END IF;
        END IF;
      END LOOP;

      FOREACH v_field IN ARRAY ARRAY['frühAbsence','spätAbsence'] LOOP
        v_abs := v_day->>v_field;
        IF v_abs IS NOT NULL AND v_abs NOT IN ('Ferien', 'Feiertag', 'Frei', 'Abwesend') THEN
          RAISE EXCEPTION 'Ungültiger Abwesenheitstext' USING ERRCODE = '22023';
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;

-- ── Link holen / anlegen ─────────────────────────────────────────────────────
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
  VALUES (p_tenant, p_department,
          replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  ON CONFLICT (tenant_id, department) DO NOTHING;

  SELECT token INTO v_token
  FROM public.schedule_share_links
  WHERE tenant_id = p_tenant AND department = p_department;

  RETURN v_token;
END;
$$;

-- ── Link zurücksetzen (alter Link wird ungültig) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.schedule_share_rotate_link(p_tenant text, p_department text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
BEGIN
  PERFORM public.schedule_share_assert_allowed(p_tenant, p_department);

  INSERT INTO public.schedule_share_links (tenant_id, department, token, rotated_at)
  VALUES (p_tenant, p_department, v_token, now())
  ON CONFLICT (tenant_id, department)
  DO UPDATE SET token = EXCLUDED.token, rotated_at = now();

  RETURN v_token;
END;
$$;

-- ── Woche veröffentlichen (Revision +1) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.schedule_share_publish_week(
  p_tenant     text,
  p_department text,
  p_week_start date,
  p_payload    jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_revision integer;
BEGIN
  PERFORM public.schedule_share_assert_allowed(p_tenant, p_department);

  IF extract(isodow FROM p_week_start) <> 1 THEN
    RAISE EXCEPTION 'Wochenstart muss ein Montag sein' USING ERRCODE = '22023';
  END IF;
  IF p_week_start < current_date - 60 OR p_week_start > current_date + 60 THEN
    RAISE EXCEPTION 'Woche liegt zu weit in der Vergangenheit/Zukunft (max. 60 Tage)' USING ERRCODE = '22023';
  END IF;

  PERFORM public.schedule_share_validate_payload(p_department, p_week_start, p_payload);

  INSERT INTO public.published_schedule_weeks AS w
    (tenant_id, department, week_start, payload, revision, published_at, published_by)
  VALUES (p_tenant, p_department, p_week_start, p_payload, 1, now(), auth.uid())
  ON CONFLICT (tenant_id, department, week_start)
  DO UPDATE SET payload      = EXCLUDED.payload,
                revision     = w.revision + 1,
                published_at = now(),
                published_by = auth.uid()
  RETURNING revision INTO v_revision;

  -- Link sicherstellen, damit er nach dem ersten Veröffentlichen sofort existiert.
  PERFORM public.schedule_share_get_link(p_tenant, p_department);

  RETURN v_revision;
END;
$$;

-- ── Zuletzt veröffentlichte Woche lesen (Planer: Änderungsvorschau/Status) ───
CREATE OR REPLACE FUNCTION public.schedule_share_get_week(
  p_tenant     text,
  p_department text,
  p_week_start date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.schedule_share_assert_allowed(p_tenant, p_department);

  SELECT jsonb_build_object(
           'payload', payload,
           'revision', revision,
           'published_at', published_at)
    INTO v_result
  FROM public.published_schedule_weeks
  WHERE tenant_id = p_tenant AND department = p_department AND week_start = p_week_start;

  RETURN v_result;  -- NULL, wenn noch nie veröffentlicht
END;
$$;

-- ── Öffentlicher Abruf per Token (einzige anon-Funktion) ─────────────────────
-- Begrenzt auf 12 Wochen im Fenster [heute-7, heute+60]; Mitarbeiter-IDs entfernt.
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
  IF p_token IS NULL OR length(p_token) < 32 OR length(p_token) > 128 THEN
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

-- ── Grants ───────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.schedule_share_assert_allowed(text, text)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_share_validate_payload(text, date, jsonb)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_share_get_link(text, text)                    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.schedule_share_rotate_link(text, text)                 FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.schedule_share_publish_week(text, text, date, jsonb)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.schedule_share_get_week(text, text, date)              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.schedule_public_get(text)                              FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.schedule_share_get_link(text, text)                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_share_rotate_link(text, text)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_share_publish_week(text, text, date, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_share_get_week(text, text, date)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_public_get(text)                            TO anon, authenticated;

COMMIT;
