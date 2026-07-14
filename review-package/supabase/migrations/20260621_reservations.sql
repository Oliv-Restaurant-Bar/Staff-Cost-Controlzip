-- ============================================================
-- Reservationen Import (Foratable) — Tabellen, Indizes, RLS, Grants
-- Datum: 2026-06-21
-- Ausführen im Supabase SQL-Editor (nach allen bestehenden Migrationen).
-- ============================================================
--
-- DATENSCHUTZ:
--   reservation_records und guest_profiles enthalten personenbezogene Daten
--   (E-Mail, Mobile, Name).  Diese Tabellen dürfen NICHT über den öffentlich
--   ausgelieferten anon-Key lesbar sein.  RLS ist daher aktiv und gewährt
--   ausschliesslich der Rolle `authenticated` Zugriff (eingeloggte Benutzer).
--   `anon` erhält KEINE Rechte; `service_role` erhält vollen Zugriff für
--   Admin-/Wartungsoperationen.  Muster identisch zu 20260619_gn_rls_fix.sql.
--
--   Die rollenbasierte Feinsteuerung (Admin/Manager) liegt in der React-App
--   (usePermissions), nicht in der DB — konsistent mit dem Projektmuster.
--
-- Bestehende Gastronovi-Tabellen (gn_*) werden NICHT verändert.
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================

-- ── 1. Tabellen ─────────────────────────────────────────────────────────────

-- Ein Eintrag pro importierter Datei (für Importverlauf + Statistik).
CREATE TABLE IF NOT EXISTS reservation_imports (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id          TEXT NOT NULL,            -- Mandant ('oliv' | 'beaulieu')
  file_name              TEXT NOT NULL,
  period_from            DATE,
  period_to              DATE,
  reservation_count      INTEGER,
  total_persons          INTEGER,
  cancelled_count        INTEGER,
  completed_count        INTEGER,
  new_guests             INTEGER,
  returning_guests       INTEGER,
  status                 TEXT NOT NULL DEFAULT 'active',  -- 'processing' | 'active' | 'failed'
  error_message          TEXT,
  checksum               TEXT,
  imported_at            TIMESTAMPTZ DEFAULT now(),
  created_at             TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reservation_imports_restaurant ON reservation_imports(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_reservation_imports_period     ON reservation_imports(period_from, period_to);

-- Gästeprofile (Wiedererkennung + Aggregat-Statistik).
CREATE TABLE IF NOT EXISTS guest_profiles (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id          TEXT NOT NULL,
  first_name             TEXT,
  last_name              TEXT,
  email                  TEXT,
  mobile                 TEXT,
  normalized_email       TEXT,
  normalized_mobile      TEXT,
  normalized_name        TEXT,
  match_key              TEXT NOT NULL,            -- kanonisch: 'email:…' | 'mobile:…' | 'name:…'
  first_seen_at          DATE,
  last_seen_at           DATE,
  total_reservations     INTEGER DEFAULT 0,
  total_persons          INTEGER DEFAULT 0,
  cancelled_reservations INTEGER DEFAULT 0,
  completed_reservations INTEGER DEFAULT 0,
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT guest_profiles_restaurant_matchkey_uq UNIQUE (restaurant_id, match_key)
);

CREATE INDEX IF NOT EXISTS idx_guest_profiles_restaurant   ON guest_profiles(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_guest_profiles_norm_email   ON guest_profiles(restaurant_id, normalized_email);
CREATE INDEX IF NOT EXISTS idx_guest_profiles_norm_mobile  ON guest_profiles(restaurant_id, normalized_mobile);
CREATE INDEX IF NOT EXISTS idx_guest_profiles_norm_name    ON guest_profiles(restaurant_id, normalized_name);

-- Einzelne Reservationen.  Dedup/Upsert über (restaurant_id, external_reservation_id):
-- erneuter Import derselben Res.Nr. AKTUALISIERT die Zeile statt sie zu duplizieren.
CREATE TABLE IF NOT EXISTS reservation_records (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id           TEXT NOT NULL,
  external_reservation_id TEXT NOT NULL,           -- Res.Nr. aus Foratable
  guest_id                UUID REFERENCES guest_profiles(id) ON DELETE SET NULL,
  restaurant_name         TEXT,                    -- Rohwert der Spalte "Restaurant"
  reservation_date        DATE,
  reservation_time        TEXT,                    -- "HH:mm" (tolerant gespeichert)
  party_size              INTEGER,
  company                 TEXT,
  first_name              TEXT,
  last_name               TEXT,
  mobile                  TEXT,
  email                   TEXT,
  status                  TEXT,                    -- Rohwert
  status_normalized       TEXT,                    -- completed|cancelled|noshow|confirmed|pending|unknown
  reserved_at             TIMESTAMPTZ,
  comment                 TEXT,
  note                    TEXT,
  table_name              TEXT,
  selection               TEXT,
  guest_information        TEXT,
  room                    TEXT,
  area                    TEXT,
  source_file_name        TEXT,
  last_import_id          UUID REFERENCES reservation_imports(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT reservation_records_restaurant_extid_uq UNIQUE (restaurant_id, external_reservation_id)
);

CREATE INDEX IF NOT EXISTS idx_reservation_records_restaurant_date ON reservation_records(restaurant_id, reservation_date);
CREATE INDEX IF NOT EXISTS idx_reservation_records_guest          ON reservation_records(guest_id);
CREATE INDEX IF NOT EXISTS idx_reservation_records_status         ON reservation_records(restaurant_id, status_normalized);

-- ── 2. RLS + Policies + Grants (authenticated only, kein anon) ───────────────

DO $$
DECLARE
  t       text;
  polname text;
  tbls    text[] := ARRAY[
    'reservation_imports',
    'guest_profiles',
    'reservation_records'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);

    -- Sauberer Neustart: bestehende Policies entfernen.
    FOR polname IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I;', polname, t);
    END LOOP;

    -- Ausschliesslich authenticated.
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true);',
      t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (true);',
      t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (true) WITH CHECK (true);',
      t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (true);',
      t || '_delete', t);

    -- GRANTs (Postgres prüft GRANT VOR RLS).
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated;', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role;', t);
    -- PII: anon erhält KEINEN Zugriff.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- PostgREST Schema-Cache neu laden (Policies/GRANTs sofort wirksam).
NOTIFY pgrst, 'reload schema';

-- ── 3. Selbsttest: authenticated darf schreiben, anon NICHT lesen ────────────

DO $$
DECLARE
  new_id uuid;
BEGIN
  SET LOCAL ROLE authenticated;
  INSERT INTO public.reservation_imports (restaurant_id, file_name, status)
  VALUES ('__rls_selftest__', '__rls_selftest__.csv', 'active')
  RETURNING id INTO new_id;
  RESET ROLE;
  DELETE FROM public.reservation_imports WHERE id = new_id;
  RAISE NOTICE '=== Selbsttest OK: authenticated INSERT in reservation_imports erlaubt (Testzeile entfernt). ===';
EXCEPTION
  WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE EXCEPTION 'Selbsttest FEHLGESCHLAGEN: authenticated INSERT blockiert (RLS/GRANT pruefen).';
END $$;

-- ── 4. Verifikation: Policies + anon-Rechte anzeigen ─────────────────────────

SELECT
  tablename,
  COUNT(*)                                          AS policy_count,
  string_agg(cmd || ':' || array_to_string(roles, '/'), ', ' ORDER BY cmd) AS policies
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('reservation_imports', 'guest_profiles', 'reservation_records')
GROUP BY tablename
ORDER BY tablename;

-- anon darf KEINE Tabellen-Rechte haben (Ergebnis sollte leer sein):
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'anon'
  AND table_name IN ('reservation_imports', 'guest_profiles', 'reservation_records');
