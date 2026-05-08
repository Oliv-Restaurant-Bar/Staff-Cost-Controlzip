-- ============================================================
-- employee_wages – RLS Fix + GRANT-Korrektur
-- ============================================================
-- Dieses Script behebt den Fehler "permission denied for table employee_wages".
--
-- Ursache: Die ursprüngliche Migration (20260430_employee_wages.sql) hat
-- keine GRANT-Statements gesetzt. Ohne GRANT hat die authenticated-Rolle
-- keine Tabellenberechtigung, auch wenn RLS-Policies vorhanden sind.
--
-- Sicher wiederholbar (idempotent): kann auch ausgeführt werden, wenn
-- die Tabelle bereits existiert.
-- ============================================================

-- ── 1. Tabelle anlegen (falls noch nicht vorhanden) ──────────────────────────

CREATE TABLE IF NOT EXISTS public.employee_wages (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id              TEXT          NOT NULL,
  restaurant_id            TEXT          NOT NULL,   -- 'oliv' | 'beaulieu'
  valid_from               DATE          NOT NULL,
  hourly_wage              NUMERIC(10,2) NOT NULL DEFAULT 0,
  monthly_salary           NUMERIC(10,2) NOT NULL DEFAULT 0,
  monthly_salary_with_13th NUMERIC(10,2) NOT NULL DEFAULT 0,
  salary_13                BOOLEAN       NOT NULL DEFAULT false,
  notes                    TEXT          NOT NULL DEFAULT '',
  created_by               TEXT          NOT NULL DEFAULT '',  -- E-Mail des Erstellers
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Spalte created_by nachträglich hinzufügen falls Tabelle bereits existiert
-- ohne die Spalte (idempotent dank IF NOT EXISTS)
ALTER TABLE public.employee_wages
  ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT '';

-- ── 2. Index (idempotent) ─────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_employee_wages_lookup
  ON public.employee_wages(restaurant_id, employee_id, valid_from DESC);

-- ── 3. RLS aktivieren ─────────────────────────────────────────────────────────

ALTER TABLE public.employee_wages ENABLE ROW LEVEL SECURITY;

-- ── 4. Bestehende Policies entfernen (sauber neu aufsetzen) ──────────────────

DROP POLICY IF EXISTS "employee_wages_auth_all"  ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_anon_all"  ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_select"    ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_insert"    ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_update"    ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_delete"    ON public.employee_wages;
DROP POLICY IF EXISTS "employee_wages_anon_sel"  ON public.employee_wages;

-- ── 5. Neue Policies: authenticated darf alles ───────────────────────────────
--
-- Begründung: Die App nutzt Supabase Auth (Email/Passwort).
-- Alle Datenbankzugriffe kommen von eingeloggten Benutzern (authenticated).
-- Die rollenbasierte Zugriffskontrolle (Admin vs. Manager) wird in der
-- React-App (usePermissions) geregelt — nicht auf DB-Ebene, da die App
-- keinen service_role-Key einsetzt.

CREATE POLICY "employee_wages_auth_select"
  ON public.employee_wages FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "employee_wages_auth_insert"
  ON public.employee_wages FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "employee_wages_auth_update"
  ON public.employee_wages FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "employee_wages_auth_delete"
  ON public.employee_wages FOR DELETE
  TO authenticated
  USING (true);

-- anon-Rolle: nur lesen (für allfällige API-Aufrufe ohne Auth-Session)
CREATE POLICY "employee_wages_anon_select"
  ON public.employee_wages FOR SELECT
  TO anon
  USING (true);

-- ── 6. GRANT-Statements (das war der fehlende Teil) ──────────────────────────
--
-- GRANT ist von den Policies unabhängig: ohne GRANT blockiert Postgres
-- den Zugriff auf Tabellenebene, bevor RLS überhaupt geprüft wird.
-- Das war die Ursache des "permission denied"-Fehlers.

GRANT USAGE ON SCHEMA public TO authenticated, anon;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.employee_wages
  TO authenticated;

GRANT SELECT
  ON public.employee_wages
  TO anon;

-- ── 7. Verifikation ───────────────────────────────────────────────────────────

DO $$
DECLARE
  tbl_exists  BOOLEAN;
  pol_count   INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'employee_wages'
  ) INTO tbl_exists;

  SELECT COUNT(*) FROM pg_policies
  WHERE tablename = 'employee_wages' INTO pol_count;

  RAISE NOTICE 'employee_wages: Tabelle vorhanden = %, Policies = %', tbl_exists, pol_count;

  IF NOT tbl_exists THEN
    RAISE EXCEPTION 'Fehler: employee_wages Tabelle nicht vorhanden!';
  END IF;

  IF pol_count < 4 THEN
    RAISE WARNING 'Weniger als 4 Policies vorhanden (erwartet: 5). Bitte prüfen.';
  END IF;
END;
$$;

SELECT
  'employee_wages RLS-Fix abgeschlossen' AS status,
  COUNT(*) AS policy_count
FROM pg_policies
WHERE tablename = 'employee_wages';
