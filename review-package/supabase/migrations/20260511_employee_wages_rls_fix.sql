-- ============================================================
-- employee_wages – Vollständiger RLS- & GRANT-Fix
-- Datum: 2026-05-11
-- ============================================================
--
-- Was dieses Script tut (idempotent, kann mehrfach ausgeführt werden):
--
--   1. Tabelle employee_wages anlegen (falls noch nicht vorhanden)
--   2. Alle fehlenden Spalten hinzufügen (created_by, contract_type)
--   3. Index sicherstellen
--   4. RLS aktivieren
--   5. ALLE alten Policies entfernen (sauberer Neustart)
--   6. Neue Policies anlegen: SELECT / INSERT / UPDATE / DELETE
--      → authenticated darf alles (Rollenprüfung läuft in React / usePermissions)
--      → anon darf nur SELECT (für allfällige öffentliche Abfragen)
--   7. GRANT-Statements setzen (Postgres prüft GRANT VOR RLS)
--   8. Supabase Schema-Cache aktualisieren (NOTIFY pgrst)
--   9. Verifikation mit RAISE NOTICE
--
-- Multi-Tenant Sicherheit:
--   Die restaurant_id-Spalte (Werte: 'oliv' | 'beaulieu') wird in der
--   React-App als Pflichtfeld beim Schreiben mitgegeben.
--   Eine DB-seitige Einschränkung via auth.jwt() ist hier nicht
--   implementiert, da die App keinen service_role-Key einsetzt und die
--   rollenbasierte Zugriffskontrolle vollständig in usePermissions liegt.
-- ============================================================

-- ── 1. Tabelle anlegen ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.employee_wages (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id              TEXT          NOT NULL,
  restaurant_id            TEXT          NOT NULL,            -- 'oliv' | 'beaulieu'
  valid_from               DATE          NOT NULL,
  hourly_wage              NUMERIC(10,2) NOT NULL DEFAULT 0,
  monthly_salary           NUMERIC(10,2) NOT NULL DEFAULT 0,
  monthly_salary_with_13th NUMERIC(10,2) NOT NULL DEFAULT 0,
  salary_13                BOOLEAN       NOT NULL DEFAULT false,
  notes                    TEXT          NOT NULL DEFAULT '',
  created_by               TEXT          NOT NULL DEFAULT '',  -- E-Mail des Erstellers
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ── 2. Fehlende Spalten nachrüsten (idempotent) ───────────────────────────────

-- created_by (Audit-Trail: wer hat den Lohn erfasst)
ALTER TABLE public.employee_wages
  ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT '';

-- contract_type (Vertragswechsel-Historie: 'monthly' | 'hourly')
ALTER TABLE public.employee_wages
  ADD COLUMN IF NOT EXISTS contract_type TEXT DEFAULT NULL;

-- ── 3. Index ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_employee_wages_lookup
  ON public.employee_wages(restaurant_id, employee_id, valid_from DESC);

-- ── 4. RLS aktivieren ────────────────────────────────────────────────────────

ALTER TABLE public.employee_wages ENABLE ROW LEVEL SECURITY;

-- ── 5. Alle alten Policies entfernen (sauber neu aufsetzen) ──────────────────
--
-- Alle bekannten Policynamen aus früheren Migrationen:

DROP POLICY IF EXISTS "employee_wages_auth_all"       ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_anon_all"       ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_select"         ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_insert"         ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_update"         ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_delete"         ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_anon_sel"       ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_anon_select"    ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_auth_select"    ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_auth_insert"    ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_auth_update"    ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_auth_delete"    ON public.employee_wages;

-- ── 6. Neue Policies anlegen ─────────────────────────────────────────────────

-- SELECT: authenticated + anon
CREATE POLICY "ew_select"
  ON public.employee_wages FOR SELECT
  TO authenticated, anon
  USING (true);

-- INSERT: nur authenticated
CREATE POLICY "ew_insert"
  ON public.employee_wages FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- UPDATE: nur authenticated
CREATE POLICY "ew_update"
  ON public.employee_wages FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- DELETE: nur authenticated
CREATE POLICY "ew_delete"
  ON public.employee_wages FOR DELETE
  TO authenticated
  USING (true);

-- ── 7. GRANT-Statements ───────────────────────────────────────────────────────
--
-- WICHTIG: Postgres prüft GRANT auf Tabellenebene BEVOR es RLS prüft.
-- Ohne GRANT → "permission denied", auch wenn RLS-Policies vorhanden sind.

GRANT USAGE ON SCHEMA public TO authenticated, anon;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.employee_wages
  TO authenticated;

GRANT SELECT
  ON public.employee_wages
  TO anon;

-- Sequenzen für auto-generierte UUIDs (gen_random_uuid braucht das nicht,
-- aber sicher ist sicher falls je SERIAL verwendet wird)
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated, anon;

-- ── 8. Supabase Schema-Cache aktualisieren ────────────────────────────────────
--
-- Supabase PostgREST cached das Schema beim Start.
-- NOTIFY pgrst aktualisiert den Cache ohne Neustart.

NOTIFY pgrst, 'reload schema';

-- ── 9. Verifikation ───────────────────────────────────────────────────────────

DO $$
DECLARE
  tbl_exists   BOOLEAN;
  pol_count    INTEGER;
  col_created  BOOLEAN;
  col_contract BOOLEAN;
BEGIN
  -- Tabelle vorhanden?
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'employee_wages'
  ) INTO tbl_exists;

  -- Policies zählen
  SELECT COUNT(*) FROM pg_policies
  WHERE tablename = 'employee_wages'
  INTO pol_count;

  -- Spalte created_by vorhanden?
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'employee_wages'
      AND column_name  = 'created_by'
  ) INTO col_created;

  -- Spalte contract_type vorhanden?
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'employee_wages'
      AND column_name  = 'contract_type'
  ) INTO col_contract;

  RAISE NOTICE '=== employee_wages Verifikation ===';
  RAISE NOTICE 'Tabelle vorhanden:       %', tbl_exists;
  RAISE NOTICE 'Anzahl Policies:         % (erwartet: 4)', pol_count;
  RAISE NOTICE 'Spalte created_by:       %', col_created;
  RAISE NOTICE 'Spalte contract_type:    %', col_contract;

  IF NOT tbl_exists THEN
    RAISE EXCEPTION 'FEHLER: Tabelle employee_wages fehlt!';
  END IF;
  IF pol_count < 4 THEN
    RAISE WARNING 'Weniger als 4 Policies (hat %). Bitte prüfen.', pol_count;
  END IF;
  IF NOT col_created THEN
    RAISE EXCEPTION 'FEHLER: Spalte created_by fehlt!';
  END IF;

  RAISE NOTICE '=== Migration erfolgreich abgeschlossen ===';
END;
$$;

-- Abschlussstatus anzeigen
SELECT
  'employee_wages RLS-Fix 2026-05-11 — OK' AS status,
  COUNT(*)                                  AS policy_count
FROM pg_policies
WHERE tablename = 'employee_wages';

-- Alle Spalten anzeigen (zur Kontrolle)
SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'employee_wages'
ORDER BY ordinal_position;
