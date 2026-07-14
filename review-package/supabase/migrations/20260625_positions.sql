-- ============================================================
-- Positionsverwaltung (Personalbedarf-Grundlage, Phase 1)
-- Datum: 2026-06-25
-- Ausführen im Supabase SQL-Editor.
-- ============================================================
--
-- ZWECK:
--   1) `positions` — konfigurierbare Positions-/Stationsstammdaten je Mandant
--      (Name, Abteilung, Farbe, Icon, Sortierung, aktiv). Ersetzt die bisher
--      fix im Code hinterlegte Stationsliste (station-config.ts) als
--      Quelle der Wahrheit. Startwerte werden aus der App geseedet
--      (seedDefaultPositions), damit nichts verloren geht.
--
--   2) Zwei neue Spalten auf `employees`:
--        primary_station     TEXT     — bevorzugte Hauptposition (stabiler KEY)
--        secondary_stations  TEXT[]   — weitere abdeckbare Positionen (KEYS)
--      Diese Felder existierten bereits im TypeScript-Modell, wurden aber NIE
--      in die DB geschrieben (Mapper-/Spalten-Lücke). Zugewiesene Stationen
--      gingen nach jedem Reload verloren — diese Migration behebt das.
--
-- WICHTIG (stabiler Schlüssel):
--   Gespeichert wird je Mitarbeiter ein stabiler Positions-KEY (nicht der
--   Anzeigename). So kann eine Position später umbenannt werden, ohne dass
--   bestehende Mitarbeiter-Zuordnungen kaputtgehen.
--
-- MANDANTENTRENNUNG:
--   `positions.restaurant_id` TEXT NOT NULL ('oliv' | 'beaulieu'). Jeder
--   Lese-/Schreibzugriff der App filtert nach restaurant_id.
--
-- SICHERHEIT:
--   RLS aktiv, ausschliesslich `authenticated` + `service_role`. `anon` erhält
--   KEINE Rechte. Die rollenbasierte Feinsteuerung (nur Admin verwaltet
--   Positionen) liegt in der React-App.
--
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. Tabelle: positions ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS positions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    TEXT NOT NULL,
  key              TEXT NOT NULL,
  name             TEXT NOT NULL,
  department       TEXT NOT NULL CHECK (department IN ('service', 'kueche')),
  department_group TEXT,
  color            TEXT,
  icon             TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- KEY ist je Mandant eindeutig und stabil (Anzeigename darf sich ändern).
  CONSTRAINT positions_restaurant_key_unique UNIQUE (restaurant_id, key)
);

CREATE INDEX IF NOT EXISTS positions_restaurant_idx
  ON positions (restaurant_id, department, sort_order);

-- ── 2. employees: Stations-/Positionsfelder ergänzen ─────────────────────────
-- ADD COLUMN IF NOT EXISTS ist idempotent; bestehende Zeilen erhalten den
-- Default. primary_station bleibt NULL (= keine Hauptposition gesetzt).

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS primary_station    TEXT;
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS secondary_stations TEXT[] NOT NULL DEFAULT '{}';

-- ── 3. RLS + Policies + Grants (authenticated only, kein anon) ────────────────

ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  polname text;
BEGIN
  -- Sauberer Neustart: bestehende Policies entfernen.
  FOR polname IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'positions'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.positions;', polname);
  END LOOP;

  CREATE POLICY positions_select ON public.positions FOR SELECT TO authenticated USING (true);
  CREATE POLICY positions_insert ON public.positions FOR INSERT TO authenticated WITH CHECK (true);
  CREATE POLICY positions_update ON public.positions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
  CREATE POLICY positions_delete ON public.positions FOR DELETE TO authenticated USING (true);
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.positions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.positions TO service_role;
REVOKE ALL ON public.positions FROM anon;
GRANT USAGE ON SCHEMA public TO authenticated, service_role;

-- PostgREST Schema-Cache neu laden (Spalten/Policies/GRANTs sofort wirksam).
NOTIFY pgrst, 'reload schema';

-- ── 4. Selbsttest: authenticated darf schreiben, anon nicht lesen ─────────────

DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  INSERT INTO public.positions (restaurant_id, key, name, department)
  VALUES ('__rls_selftest__', '__rls_selftest__', '__rls_selftest__', 'service');
  DELETE FROM public.positions WHERE restaurant_id = '__rls_selftest__';
  RESET ROLE;
  RAISE NOTICE '=== Selbsttest OK: authenticated INSERT/DELETE auf positions erlaubt (Testdaten entfernt). ===';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    DELETE FROM public.positions WHERE restaurant_id = '__rls_selftest__';
    RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: authenticated INSERT auf positions blockiert (RLS/GRANT pruefen).';
END $$;

DO $$
BEGIN
  SET LOCAL ROLE anon;
  PERFORM 1 FROM public.positions LIMIT 1;
  RESET ROLE;
  RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: anon konnte positions lesen (sollte blockiert sein).';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '=== Selbsttest OK: anon-Zugriff auf positions blockiert. ===';
END $$;

-- ── 5. Verifikation ──────────────────────────────────────────────────────────

-- Neue employees-Spalten vorhanden?
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'employees'
  AND column_name IN ('primary_station', 'secondary_stations')
ORDER BY column_name;

-- positions-Policies:
SELECT tablename, COUNT(*) AS policy_count,
       string_agg(cmd || ':' || array_to_string(roles, '/'), ', ' ORDER BY cmd) AS policies
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'positions'
GROUP BY tablename;

-- anon darf KEINE Rechte auf positions haben (Ergebnis sollte leer sein):
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee = 'anon' AND table_name = 'positions';
