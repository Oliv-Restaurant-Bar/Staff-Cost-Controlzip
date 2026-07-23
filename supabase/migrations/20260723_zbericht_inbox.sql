-- ============================================================
-- Gastronovi Z-Bericht — E-Mail-Eingang (n8n → Edge Function)
-- Datum: 2026-07-23
-- MANUELL im Supabase SQL-Editor ausführen (DDL läuft nicht automatisch).
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================
--
-- ZWECK
--   Per E-Mail eingegangene Z-Bericht-PDFs landen über die Edge Function
--   `gastronovi-inbound` (n8n-Webhook) im privaten Storage-Bucket
--   `zbericht-inbox` plus einer Zeile in `zbericht_inbox` (status 'pending').
--   Der Import selbst passiert UNVERÄNDERT im Browser: die Import-Seite lädt
--   das PDF per signierter URL und nutzt exakt den bestehenden Parser-/
--   Speicherweg (parseGnZBerichtPdf → gn_imports). KEIN serverseitiges Parsing.
--
-- IDEMPOTENZ
--   UNIQUE (restaurant_id, file_hash): dieselbe PDF-Datei (sha256 der Bytes)
--   wird pro Betrieb nur einmal angenommen — die Edge Function antwortet bei
--   Wiederholung mit {status:'duplicate'} und schreibt nichts.

-- ── 1. Privater Storage-Bucket «zbericht-inbox» ──────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('zbericht-inbox', 'zbericht-inbox', false)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Tabelle zbericht_inbox ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zbericht_inbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id text NOT NULL CHECK (restaurant_id IN ('oliv', 'beaulieu')),
  file_name     text NOT NULL,
  -- Pfad im Bucket zbericht-inbox: <restaurant_id>/<file_hash>.pdf
  storage_path  text NOT NULL,
  -- sha256 (hex) über die rohen PDF-Bytes — Idempotenz-Schlüssel.
  file_hash     text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'imported', 'ignored')),
  -- Nach erfolgreichem Import: Verweis auf den entstandenen gn_imports-Eintrag.
  gn_import_id  uuid NULL REFERENCES gn_imports(id),
  received_at   timestamptz NOT NULL DEFAULT now(),
  imported_at   timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS zbericht_inbox_tenant_hash_uniq
  ON zbericht_inbox (restaurant_id, file_hash);

CREATE INDEX IF NOT EXISTS zbericht_inbox_tenant_status
  ON zbericht_inbox (restaurant_id, status, received_at DESC);

-- ── 3. RLS + GRANTs (Muster 20260619_gn_rls_fix: authenticated-only) ────────
ALTER TABLE zbericht_inbox ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  polname text;
BEGIN
  FOR polname IN
    SELECT policyname FROM pg_policies WHERE tablename = 'zbericht_inbox'
  LOOP
    EXECUTE format('DROP POLICY %I ON zbericht_inbox', polname);
  END LOOP;
END $$;

CREATE POLICY zbericht_inbox_select ON zbericht_inbox
  FOR SELECT TO authenticated USING (true);
-- INSERT kommt ausschliesslich aus der Edge Function (service_role, RLS-bypass).
-- Frontend darf nur Status-Übergänge schreiben (imported/ignored):
CREATE POLICY zbericht_inbox_update ON zbericht_inbox
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, UPDATE ON zbericht_inbox TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON zbericht_inbox TO service_role;
REVOKE ALL ON zbericht_inbox FROM anon;

-- ── 4. Storage-Policies: authenticated darf PDFs des Buckets LESEN ──────────
--   (signierte URL / Download auf der Import-Seite). Upload macht NUR die
--   Edge Function mit dem Service-Role-Key (RLS-Bypass) — kein INSERT für
--   authenticated, kein Zugriff für anon.
--   HINWEIS: Falls der SQL-Editor hier «must be owner of table objects»
--   meldet, diese eine Policy stattdessen im Dashboard anlegen:
--   Storage → Policies → zbericht-inbox → New policy → SELECT für
--   authenticated mit Bedingung bucket_id = 'zbericht-inbox'.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'zbericht_inbox_objects_select'
  ) THEN
    DROP POLICY zbericht_inbox_objects_select ON storage.objects;
  END IF;
END $$;

CREATE POLICY zbericht_inbox_objects_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'zbericht-inbox');
