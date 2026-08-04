-- ============================================================
-- Personaleintritt & digitaler L-GAV-Arbeitsvertrag
-- Datum: 2026-07-24
-- MANUELL im Supabase SQL-Editor ausführen (DDL läuft nicht automatisch).
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================
--
-- ZWECK
--   Dreistufiger Eintrittsprozess: GF erfasst Eckdaten + Lohn und lädt den
--   neuen Mitarbeiter per Token-Link ein → Mitarbeiter füllt Vertrags- und
--   Lohnprogramm-Felder aus und lädt Dokumente hoch (öffentliche Route /e/:token,
--   Zugriff NUR über die Edge Function `personaleintritt-public`) → Backoffice
--   erstellt das Vertrags-PDF, exportiert für MIRUS und übernimmt den
--   Mitarbeiter in die employees-Tabelle.
--
-- SICHERHEIT
--   * In der DB liegt NUR der sha256-Hash des Einladungs-Tokens
--     (invite_token_hash) — der Klartext-Token existiert nur im Link.
--   * personalstamm_id ist TEXT: employees-IDs sind text ('14', 'b-169'), kein uuid.
--   * RLS authenticated-only + REVOKE anon; die öffentliche Phase 2 läuft
--     ausschliesslich über die Edge Function (service_role).

-- ── 1. Tabelle personaleintritt ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS personaleintritt (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   text NOT NULL CHECK (restaurant_id IN ('oliv','beaulieu')),
  status          text NOT NULL DEFAULT 'entwurf'
                  CHECK (status IN ('entwurf','eingeladen','ausgefuellt','geprueft',
                                    'vertrag_gesendet','unterzeichnet','uebernommen','abgebrochen')),

  -- Phase 1: GF-Eckdaten
  vertragstyp     text CHECK (vertragstyp IN ('SL','ML')),   -- Stundenlohn / Monatslohn
  betrieb         text,
  funktion        text,
  eintritt        date,
  pensum_prozent  numeric,           -- nur ML; SL = unregelmässig
  probezeit_tage  int DEFAULT 90,
  vertragsdauer   text CHECK (vertragsdauer IN ('unbefristet','befristet')),
  befristet_bis   date,

  -- Lohn-Erfassung (3 Modi)
  lohn_modus      text CHECK (lohn_modus IN ('grundlohn','mindestlohn','zieltotal')),
  lohnklasse      text,              -- Ia, Ib, II, IIIa, IIIb, IV
  grundlohn       numeric,           -- Modus A: Brutto exkl. 13.
  ziel_total      numeric,           -- Modus C: gewünschtes Total inkl. alles
  lohn_berechnet  numeric,           -- Basislohn, der ins PDF/MIRUS geht
  lohn_einheit    text CHECK (lohn_einheit IN ('monat','stunde')),
  einfuehrungszeit boolean NOT NULL DEFAULT false,  -- Einarbeitung: Mindestlohn −8 % zulässig

  -- Phase 2: Mitarbeiterdaten (Vertrag + Lohnprogramm) als strukturiertes JSON
  ma_daten        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Einladung (NUR Hash in der DB; Klartext-Token nur im Link)
  invite_token_hash text UNIQUE,
  invite_expires  timestamptz,
  eingeladen_am   timestamptz,
  ausgefuellt_am  timestamptz,

  -- Ergebnis-Artefakte
  pdf_path            text,          -- ausgefülltes Vertrags-PDF im Bucket (editierbar)
  pdf_flat_path       text,          -- geflattete Versandkopie
  mirus_export_path   text,
  skribble_request_id text,
  signed_pdf_path     text,          -- signiertes PDF (Skribble-Rücklauf)
  personalstamm_id    text,          -- employees.id nach Übernahme ('14' / 'b-169' — TEXT!)

  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS personaleintritt_tenant_status
  ON personaleintritt (restaurant_id, status, created_at DESC);

-- Nachrüst-Spalten (idempotent, falls Tabelle bereits ohne sie existiert)
ALTER TABLE personaleintritt ADD COLUMN IF NOT EXISTS einfuehrungszeit boolean NOT NULL DEFAULT false;
ALTER TABLE personaleintritt ADD COLUMN IF NOT EXISTS pdf_flat_path text;
ALTER TABLE personaleintritt ADD COLUMN IF NOT EXISTS signed_pdf_path text;

-- ── 2. Tabelle lgav_mindestlohn (jährlich aktualisierbar, NICHT hartcodiert) ──
CREATE TABLE IF NOT EXISTS lgav_mindestlohn (
  jahr        int  NOT NULL,
  klasse      text NOT NULL,        -- Ia, Ib, II, IIIa, IIIb, IV
  monat_x13   numeric NOT NULL,     -- CHF/Monat inkl. 13. (×13-Basis)
  PRIMARY KEY (jahr, klasse)
);

-- Seed 2026 (×13, inkl. 13.):
INSERT INTO lgav_mindestlohn (jahr, klasse, monat_x13) VALUES
  (2026,'Ia',3713),(2026,'Ib',3943),(2026,'II',4070),
  (2026,'IIIa',4528),(2026,'IIIb',4635),(2026,'IV',5293)
ON CONFLICT DO NOTHING;

-- ── 3. RLS + GRANTs (Muster zbericht_inbox: authenticated-only) ─────────────
ALTER TABLE personaleintritt ENABLE ROW LEVEL SECURITY;
ALTER TABLE lgav_mindestlohn ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE polname text;
BEGIN
  FOR polname IN SELECT policyname FROM pg_policies WHERE tablename = 'personaleintritt' LOOP
    EXECUTE format('DROP POLICY %I ON personaleintritt', polname);
  END LOOP;
  FOR polname IN SELECT policyname FROM pg_policies WHERE tablename = 'lgav_mindestlohn' LOOP
    EXECUTE format('DROP POLICY %I ON lgav_mindestlohn', polname);
  END LOOP;
END $$;

-- Backoffice/GF (eingeloggt): voller Zugriff auf Eintritts-Datensätze.
-- Tenant-Isolation erfolgt client-seitig (.eq('restaurant_id', …)) — Projektmuster.
CREATE POLICY personaleintritt_select ON personaleintritt
  FOR SELECT TO authenticated USING (true);
CREATE POLICY personaleintritt_insert ON personaleintritt
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY personaleintritt_update ON personaleintritt
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY personaleintritt_delete ON personaleintritt
  FOR DELETE TO authenticated USING (true);

CREATE POLICY lgav_mindestlohn_select ON lgav_mindestlohn
  FOR SELECT TO authenticated USING (true);
-- Pflege der Mindestlöhne (neues Jahr) durch Admin im UI:
CREATE POLICY lgav_mindestlohn_write ON lgav_mindestlohn
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY lgav_mindestlohn_update ON lgav_mindestlohn
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON personaleintritt TO authenticated;
GRANT SELECT, INSERT, UPDATE ON lgav_mindestlohn TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON personaleintritt TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON lgav_mindestlohn TO service_role;
REVOKE ALL ON personaleintritt FROM anon;
REVOKE ALL ON lgav_mindestlohn FROM anon;

-- ── 4. Privater Storage-Bucket «mitarbeiter-dokumente» ──────────────────────
--   Pfadstruktur:
--     vorlagen/SL_Arbeitsvertrag_Vorlage.pdf / ML_Arbeitsvertrag_Vorlage.pdf
--     <restaurant_id>/<eintritt_id>/docs/<docType>.<ext>   (Phase-2-Uploads via Edge Function)
--     <restaurant_id>/<eintritt_id>/vertrag.pdf            (Backoffice, client-seitig)
INSERT INTO storage.buckets (id, name, public)
VALUES ('mitarbeiter-dokumente', 'mitarbeiter-dokumente', false)
ON CONFLICT (id) DO NOTHING;

-- Storage-Policies: authenticated darf lesen und schreiben (Backoffice lädt
-- Vorlagen herunter und Vertrags-PDFs hoch); Phase-2-Uploads laufen über die
-- Edge Function mit Service-Role (RLS-Bypass); anon hat KEINEN Zugriff.
-- HINWEIS: Falls der SQL-Editor «must be owner of table objects» meldet,
-- diese Policies im Dashboard anlegen (Storage → Policies → mitarbeiter-dokumente).
DO $$
DECLARE polname text;
BEGIN
  FOR polname IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname LIKE 'mitarbeiter_dokumente_%'
  LOOP
    EXECUTE format('DROP POLICY %I ON storage.objects', polname);
  END LOOP;
END $$;

CREATE POLICY mitarbeiter_dokumente_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'mitarbeiter-dokumente');
CREATE POLICY mitarbeiter_dokumente_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'mitarbeiter-dokumente');
CREATE POLICY mitarbeiter_dokumente_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'mitarbeiter-dokumente')
  WITH CHECK (bucket_id = 'mitarbeiter-dokumente');
