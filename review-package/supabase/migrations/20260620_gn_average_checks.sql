-- ============================================================
-- Gastronovi Durchschnittsbon-Bericht — Tabelle + RLS
-- Datum: 2026-06-20
-- Ausführen im Supabase SQL-Editor (nach 20260619_gn_rls_fix.sql)
-- ============================================================
--
-- Dritter dedizierter Gastronovi-Importtyp: "Durchschnittsbon Bericht"
-- (Durchschnittsbon pro Tag).  Anders als der Personen-Bericht wird der
-- Durchschnittsbon NICHT aus Umsatz/Bons berechnet, sondern als offizielle
-- Gastronovi-Kennzahl pro Tag importiert.  Jeder Tageswert ist eine eigene
-- Zeile (report_date + average_check_chf).
--
-- Sicherheit (identisch zu 20260619_gn_rls_fix.sql):
--   • RLS bleibt AKTIV.
--   • Policies ausschliesslich für `authenticated` (SELECT/INSERT/UPDATE/DELETE).
--   • `anon` (öffentlich ausgelieferter Anon-Key) erhält KEINEN Zugriff
--     (REVOKE) — Finanz-/Importdaten.
--   • GRANTs für `authenticated` und `service_role`
--     (Postgres prüft GRANT VOR RLS).
--
-- Idempotent: kann mehrfach ausgeführt werden (Policies/Trigger werden zuerst
-- entfernt bzw. mit OR REPLACE neu angelegt).
-- ============================================================

-- ── 1. Tabelle + Indizes ────────────────────────────────────────────────────
-- UNIQUE (business_id, report_date): genau eine Zeile pro Mandant/Tag.  Damit
-- ist der Schreibpfad ein ATOMARER UPSERT (kein delete+insert, kein Datenverlust-
-- Fenster, keine Doppelzeilen bei Parallel-Import) — vgl. Datenintegritäts-
-- Vorgabe in replit.md.  Dieser Unique-Index deckt zugleich Mandanten- und
-- Datumsbereichs-Abfragen ab (business_id ist führende Spalte).
CREATE TABLE IF NOT EXISTS gn_average_checks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id         UUID NOT NULL,
  business_id       TEXT NOT NULL,            -- Mandant: 'oliv' | 'beaulieu'
  report_date       DATE NOT NULL,
  average_check_chf NUMERIC,
  currency          TEXT NOT NULL DEFAULT 'CHF',
  source_file_name  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_gn_average_checks_business_date UNIQUE (business_id, report_date)
);

-- Idempotenz: Falls die Tabelle aus einem früheren Teil-Lauf ohne Constraint
-- existiert, Unique-Constraint nachziehen (ADD CONSTRAINT IF NOT EXISTS gibt es
-- in Postgres nicht → über Katalog prüfen).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_gn_average_checks_business_date'
      AND conrelid = 'public.gn_average_checks'::regclass
  ) THEN
    ALTER TABLE public.gn_average_checks
      ADD CONSTRAINT uq_gn_average_checks_business_date UNIQUE (business_id, report_date);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gn_average_checks_import ON gn_average_checks(import_id);

-- ── 2. updated_at automatisch pflegen ───────────────────────────────────────
CREATE OR REPLACE FUNCTION gn_average_checks_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gn_average_checks_updated_at ON gn_average_checks;
CREATE TRIGGER trg_gn_average_checks_updated_at
  BEFORE UPDATE ON gn_average_checks
  FOR EACH ROW EXECUTE FUNCTION gn_average_checks_set_updated_at();

-- ── 3. RLS aktivieren + Policies + GRANTs ───────────────────────────────────
ALTER TABLE public.gn_average_checks ENABLE ROW LEVEL SECURITY;

-- Sauberer Neustart: ALLE bestehenden Policies dieser Tabelle entfernen.
DO $$
DECLARE polname text;
BEGIN
  FOR polname IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'gn_average_checks'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.gn_average_checks;', polname);
  END LOOP;
END $$;

-- Neue Policies: ausschliesslich authenticated.
CREATE POLICY gn_average_checks_select ON public.gn_average_checks
  FOR SELECT TO authenticated USING (true);
CREATE POLICY gn_average_checks_insert ON public.gn_average_checks
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY gn_average_checks_update ON public.gn_average_checks
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY gn_average_checks_delete ON public.gn_average_checks
  FOR DELETE TO authenticated USING (true);

-- GRANTs (Postgres prüft GRANT VOR RLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gn_average_checks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gn_average_checks TO service_role;
-- Anon (unauthentifiziert) erhält KEINEN Zugriff auf Finanz-/Importdaten.
REVOKE ALL ON public.gn_average_checks FROM anon;

GRANT USAGE ON SCHEMA public TO authenticated, service_role;

-- PostgREST Schema-Cache neu laden (Policies/GRANTs sofort wirksam).
NOTIFY pgrst, 'reload schema';

-- ── 4. Selbsttest: authenticated darf schreiben ─────────────────────────────
-- Fügt als Rolle `authenticated` eine Testzeile ein und entfernt sie wieder.
-- Erfolg → NOTICE.  Weiterhin blockiert → harter Abbruch (EXCEPTION).
DO $$
DECLARE new_id uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  INSERT INTO public.gn_average_checks (import_id, business_id, report_date, average_check_chf)
  VALUES (gen_random_uuid(), '__rls_selftest__', '2026-01-01', 1)
  RETURNING id INTO new_id;
  RESET ROLE;                       -- zurück zum Owner (umgeht RLS beim Aufräumen)
  DELETE FROM public.gn_average_checks WHERE id = new_id;
  RAISE NOTICE '=== Selbsttest OK: authenticated INSERT in gn_average_checks erlaubt (Testzeile entfernt). ===';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: authenticated INSERT weiterhin blockiert (RLS/GRANT pruefen).';
END $$;

-- ── 5. Verifikation: Policies anzeigen ──────────────────────────────────────
SELECT
  tablename,
  COUNT(*)                                                                  AS policy_count,
  string_agg(cmd || ':' || array_to_string(roles, '/'), ', ' ORDER BY cmd) AS policies
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'gn_average_checks'
GROUP BY tablename;
