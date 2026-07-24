-- ============================================================================
-- Migration 20260724f — Mandantenfähiges Fundament: Betriebe als Datensätze
-- ============================================================================
-- Auftrag «Betriebe»: Tabelle betriebe + personaleintritt.betrieb_id (FK).
-- Die bestehende SCC-Tenancy (restaurant_id 'oliv'/'beaulieu') bleibt
-- UNVERÄNDERT: restaurant_id ist weiterhin der «Heimat-Mandant» jedes
-- Datensatzes (CHECK-Constraint!). Betriebe mit scc_integration=true sind an
-- genau EINEN SCC-Tenant gekoppelt (scc_tenant, partieller UNIQUE-Index);
-- Dritt-Betriebe haben scc_tenant NULL und erben als restaurant_id den
-- aktiven Mandanten des Erstellers.
--
-- Idempotent; manuell im Supabase SQL-Editor bzw. per Management-API ausführen.

-- ── 1. Tabelle betriebe ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS betriebe (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Juristischer Firmenname (Vertrags-/Behörden-Dokumente):
  name                 text NOT NULL,
  -- Anzeigename fürs UI/Betreffzeilen (Fallback: name):
  anzeigename          text,
  strasse              text,
  plz_ort              text,
  -- UID (CHE-…) für die SEM-Meldung (Feld NuméroIDEB):
  uid                  text,
  land                 text NOT NULL DEFAULT 'CH',
  -- Wochenstundenmodell (L-GAV): steuert die Stundenlohn-Spalte der
  -- lgav_mindestlohn-Tabelle (stunde_42 / stunde_43_5 / stunde_45):
  wochenstunden_modell numeric NOT NULL DEFAULT 42
                       CHECK (wochenstunden_modell IN (42, 43.5, 45)),
  kontaktperson_name   text,
  kontaktperson_tel    text,
  kontaktperson_email  text,
  -- Zustelladresse der kantonalen Behörde (SEM-Meldung):
  behoerde_email       text,
  -- Kopplung an die bestehende SCC-Tenancy (Personalstamm/Dienstplan):
  scc_integration      boolean NOT NULL DEFAULT false,
  scc_tenant           text CHECK (scc_tenant IN ('oliv','beaulieu')),
  -- scc_integration=true erfordert einen scc_tenant (sonst kein Schreibziel):
  CONSTRAINT betriebe_scc_tenant_required
    CHECK (NOT scc_integration OR scc_tenant IS NOT NULL),
  -- Logo (Bucket-Pfad) — Feld angelegt, noch UNBENUTZT (Branding = Firmenname):
  logo                 text,
  -- Kein Hard-Delete (FK-Ziel): Deaktivieren statt löschen.
  aktiv                boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Je SCC-Tenant höchstens EIN Betrieb (Dritt-Betriebe: scc_tenant NULL, beliebig viele):
CREATE UNIQUE INDEX IF NOT EXISTS betriebe_scc_tenant_unique
  ON betriebe (scc_tenant) WHERE scc_tenant IS NOT NULL;

-- ── 2. Seed: die zwei bestehenden Betriebe (FIXE UUIDs, idempotent) ─────────
-- Firmendaten gemäss Vorgabe der Geschäftsführung (Juli 2026).
-- ON CONFLICT DO NOTHING: spätere manuelle Änderungen im UI werden bei
-- erneutem Einspielen NICHT überschrieben.
INSERT INTO betriebe (
  id, name, anzeigename, strasse, plz_ort, uid, land, wochenstunden_modell,
  kontaktperson_name, kontaktperson_tel, behoerde_email, scc_integration, scc_tenant
) VALUES
  ('b1e7c1a0-0000-4000-8000-000000000001',
   'Oliv Gastro AG', 'Oliv Restaurant & Bar',
   'Waisenhausplatz 28', '3011 Bern', 'CHE-196.132.560', 'CH', 42,
   'Berat Osmani', '076 398 67 47', 'meldeverfahren.midi@be.ch', true, 'oliv'),
  ('b1e7c1a0-0000-4000-8000-000000000002',
   'Restaurant Beaulieu AG', 'Restaurant Beaulieu',
   'Erlachstrasse 3', '3011 Bern', 'CHE-336.566.594', 'CH', 42,
   'Berat Osmani', '076 398 67 47', 'meldeverfahren.midi@be.ch', true, 'beaulieu')
ON CONFLICT (id) DO NOTHING;

-- ── 3. personaleintritt.betrieb_id + Backfill ───────────────────────────────
ALTER TABLE personaleintritt
  ADD COLUMN IF NOT EXISTS betrieb_id uuid REFERENCES betriebe(id);

-- Bestand: restaurant_id ('oliv'/'beaulieu') → Betrieb mit gleichem scc_tenant.
UPDATE personaleintritt p
SET betrieb_id = b.id
FROM betriebe b
WHERE p.betrieb_id IS NULL
  AND b.scc_tenant = p.restaurant_id;

-- ── 4. RLS + GRANTs (Muster personaleintritt: authenticated-only) ───────────
-- Schreibrechte werden im UI auf Admin && !Gast begrenzt (TS-Gate,
-- dokumentiertes Projektmuster); KEINE DELETE-Policy — Betriebe werden
-- deaktiviert (aktiv=false), nie gelöscht (FK-Ziel von personaleintritt).
ALTER TABLE betriebe ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE polname text;
BEGIN
  FOR polname IN SELECT policyname FROM pg_policies WHERE tablename = 'betriebe' LOOP
    EXECUTE format('DROP POLICY %I ON betriebe', polname);
  END LOOP;
END $$;

CREATE POLICY betriebe_select ON betriebe
  FOR SELECT TO authenticated USING (true);
CREATE POLICY betriebe_insert ON betriebe
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY betriebe_update ON betriebe
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON betriebe TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON betriebe TO service_role;
REVOKE ALL ON betriebe FROM anon;
