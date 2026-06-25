-- ============================================================
-- Personalbedarf (Soll-Besetzung je Saison × Wochentag)
-- Datum: 2026-06-25
-- Ausführen im Supabase SQL-Editor.
-- ============================================================
--
-- ZWECK:
--   `staffing_requirements` — konfigurierbare SOLL-Besetzung je Mandant.
--   Pro (Saison × Wochentag) wird für jede Position EINE oder MEHRERE Schichten
--   hinterlegt (Schichtbeginn, Schichtende, Anzahl benötigte Mitarbeiter,
--   Reihenfolge). Eine ZEILE = EINE Schicht.
--
--   Diese Vorlagen sind VOLLSTÄNDIG GETRENNT von der Dienstplanung
--   (schedule_entries) — keine Fremdschlüssel, keine geteilten Tabellen. Sie
--   dienen später als Grundlage für Besetzungs-Abgleich/Warnungen (NICHT Teil
--   dieser Phase).
--
-- ERWEITERBARKEIT OHNE SCHEMA-ÄNDERUNG:
--   Statt nur (season, weekday) gibt es einen generischen Geltungsbereich:
--     scope_type TEXT  — 'weekly' (aktuell genutzt). Künftig OHNE Migration:
--                        'holiday', 'event', 'special_opening', 'custom_season'.
--     scope_ref  TEXT  — optionaler Bezug (z.B. Datum '2026-08-01', Event-ID,
--                        Feiertags-Key, Saison-ID). Für 'weekly' = NULL.
--     weekday    NULLABLE — für 'weekly' gesetzt (1..7 ISO, Mo..So); für
--                        datumsbasierte Geltungsbereiche darf er NULL sein.
--     meta JSONB       — sekundärer Erweiterungs-Auffangraum.
--   So lassen sich Feiertage/Events/Sonderöffnung später als neue scope_type-
--   Werte ergänzen, ohne das Schema zu ändern.
--
-- MANDANTENTRENNUNG:
--   `restaurant_id` TEXT NOT NULL ('oliv' | 'beaulieu'). Jeder Lese-/
--   Schreibzugriff der App filtert nach restaurant_id.
--
-- POSITION:
--   `position_key` TEXT speichert den STABILEN Positions-Slug (positions.key) —
--   bewusst KEIN Fremdschlüssel, damit Umbenennen/Deaktivieren einer Position
--   die Bedarfsvorlage nicht zerstört (analog employee.primary_station).
--
-- SICHERHEIT:
--   RLS aktiv, ausschliesslich `authenticated` + `service_role`. `anon` erhält
--   KEINE Rechte. Die rollenbasierte Feinsteuerung (nur Admin) liegt in der App.
--
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. Tabelle: staffing_requirements ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS staffing_requirements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  TEXT NOT NULL,
  scope_type     TEXT NOT NULL DEFAULT 'weekly',
  season         TEXT NOT NULL DEFAULT 'standard',
  weekday        SMALLINT CHECK (weekday IS NULL OR weekday BETWEEN 1 AND 7),
  scope_ref      TEXT,
  position_key   TEXT NOT NULL,
  shift_start    TEXT NOT NULL,
  shift_end      TEXT NOT NULL,
  required_count SMALLINT NOT NULL DEFAULT 1 CHECK (required_count >= 0),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  meta           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lese-/Schreibpfad filtert immer nach diesem Geltungsbereich.
CREATE INDEX IF NOT EXISTS staffing_requirements_scope_idx
  ON staffing_requirements (restaurant_id, scope_type, season, weekday, scope_ref, position_key, sort_order);

-- ── 2. RLS + Policies + Grants (authenticated only, kein anon) ────────────────

ALTER TABLE public.staffing_requirements ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  polname text;
BEGIN
  -- Sauberer Neustart: bestehende Policies entfernen.
  FOR polname IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'staffing_requirements'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.staffing_requirements;', polname);
  END LOOP;

  CREATE POLICY staffing_requirements_select ON public.staffing_requirements FOR SELECT TO authenticated USING (true);
  CREATE POLICY staffing_requirements_insert ON public.staffing_requirements FOR INSERT TO authenticated WITH CHECK (true);
  CREATE POLICY staffing_requirements_update ON public.staffing_requirements FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
  CREATE POLICY staffing_requirements_delete ON public.staffing_requirements FOR DELETE TO authenticated USING (true);
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staffing_requirements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staffing_requirements TO service_role;
REVOKE ALL ON public.staffing_requirements FROM anon;
GRANT USAGE ON SCHEMA public TO authenticated, service_role;

-- PostgREST Schema-Cache neu laden (Spalten/Policies/GRANTs sofort wirksam).
NOTIFY pgrst, 'reload schema';

-- ── 3. Selbsttest: authenticated darf schreiben, anon nicht lesen ─────────────

DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  INSERT INTO public.staffing_requirements (restaurant_id, weekday, position_key, shift_start, shift_end)
  VALUES ('__rls_selftest__', 1, '__rls_selftest__', '11:00', '22:00');
  DELETE FROM public.staffing_requirements WHERE restaurant_id = '__rls_selftest__';
  RESET ROLE;
  RAISE NOTICE '=== Selbsttest OK: authenticated INSERT/DELETE auf staffing_requirements erlaubt (Testdaten entfernt). ===';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    DELETE FROM public.staffing_requirements WHERE restaurant_id = '__rls_selftest__';
    RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: authenticated INSERT auf staffing_requirements blockiert (RLS/GRANT pruefen).';
END $$;

DO $$
BEGIN
  SET LOCAL ROLE anon;
  PERFORM 1 FROM public.staffing_requirements LIMIT 1;
  RESET ROLE;
  RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: anon konnte staffing_requirements lesen (sollte blockiert sein).';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '=== Selbsttest OK: anon-Zugriff auf staffing_requirements blockiert. ===';
END $$;

-- ── 4. Verifikation ──────────────────────────────────────────────────────────

-- staffing_requirements-Policies:
SELECT tablename, COUNT(*) AS policy_count,
       string_agg(cmd || ':' || array_to_string(roles, '/'), ', ' ORDER BY cmd) AS policies
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'staffing_requirements'
GROUP BY tablename;

-- anon darf KEINE Rechte auf staffing_requirements haben (Ergebnis sollte leer sein):
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee = 'anon' AND table_name = 'staffing_requirements';
