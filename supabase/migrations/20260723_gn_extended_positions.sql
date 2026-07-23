-- ============================================================
-- Gastronovi Z-Bericht — Erweiterter Bericht (Detailpositionen)
-- Datum: 2026-07-23
-- MANUELL im Supabase SQL-Editor ausführen (DDL läuft nicht automatisch).
-- Idempotent: kann mehrfach ausgeführt werden.
-- ============================================================
--
-- ZWECK
--   Der erweiterte Z-Bericht enthält zusätzliche Detailsektionen
--   (Hauptwarengruppen/Warengruppen inner/außer Haus, Positionen).
--   Diese aggregierten Detaildaten werden hier persistiert, damit die
--   Produktanalyse sie als bevorzugte Quelle nutzen kann.
--
-- IDEMPOTENZ / ATOMARES ERSETZEN
--   Fachlicher Schlüssel: tenant + Kostenstelle + Z-Zähler + Zeitraum +
--   Abschnitt + normalisierter Name.  Umsetzung:
--   • tenant/Kostenstelle/Z-Zähler/Zeitraum leben auf gn_imports; ein
--     erneuter Import desselben Zeitraums läuft über den BESTEHENDEN
--     Replace-Mechanismus (alter Import → status 'replaced', mit Rollback).
--     Leser berücksichtigen NUR Positionen aktiver Importe → nie doppelt.
--   • Innerhalb EINES Imports erzwingt ein UNIQUE-Index
--     (import_id, section, name, consumption_type) Duplikatfreiheit.
--   • Die Zeilen sind aggregierte PERIODENSUMMEN des Berichts — KEINE
--     Einzeltransaktionen (keine Bons, Tische, Uhrzeiten).
--
-- WICHTIG: Kein ALTER an bestehenden Kind-Tabellen. gn_imports erhält nur
--   die NULLABLE Spalte report_type ('standard' | 'extended'); bestehende
--   Zeilen bleiben NULL (= Standard).

-- ── 1. Spalte report_type auf gn_imports ─────────────────────────────────────
ALTER TABLE gn_imports ADD COLUMN IF NOT EXISTS report_type text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gn_imports_report_type_check'
  ) THEN
    ALTER TABLE gn_imports
      ADD CONSTRAINT gn_imports_report_type_check
      CHECK (report_type IS NULL OR report_type IN ('standard', 'extended'));
  END IF;
END $$;

-- ── 2. Tabelle gn_extended_positions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gn_extended_positions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id        uuid NOT NULL REFERENCES gn_imports(id) ON DELETE CASCADE,
  -- Denormalisiert für tenant-gefilterte Direktabfragen der Produktanalyse:
  restaurant_id    text NOT NULL,
  period_from      date,
  period_to        date,
  -- Abschnitt des Detailberichts:
  --   main_categories_ct  = «Hauptwarengruppen (inner/außer Haus)»
  --   categories          = «Warengruppen»
  --   categories_ct       = «Warengruppen (inner/außer Haus)»
  --   positions           = «Positionen»
  section          text NOT NULL CHECK (section IN
                     ('main_categories_ct', 'categories', 'categories_ct', 'positions')),
  -- Technisch normalisierter Name OHNE Verzehrart-Suffix.
  name             text NOT NULL,
  quantity         integer NOT NULL DEFAULT 0,
  -- Betrag nach Rabatten; 0-CHF-Positionen (Beilagen, Garstufen, …) sind gültig.
  gross_amount     numeric(12,2) NOT NULL DEFAULT 0,
  -- Original-Betrag vor Rabatt (falls im Bericht vorhanden).
  original_amount  numeric(12,2),
  consumption_type text CHECK (consumption_type IS NULL OR consumption_type IN ('in_house', 'takeaway')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Duplikatfreiheit innerhalb eines Imports (consumption_type NULL-sicher).
CREATE UNIQUE INDEX IF NOT EXISTS gn_extended_positions_uniq
  ON gn_extended_positions (import_id, section, name, COALESCE(consumption_type, ''));

CREATE INDEX IF NOT EXISTS gn_extended_positions_tenant_period
  ON gn_extended_positions (restaurant_id, period_from, period_to);

CREATE INDEX IF NOT EXISTS gn_extended_positions_import
  ON gn_extended_positions (import_id);

-- ── 3. RLS + GRANTs (Muster 20260619_gn_rls_fix: authenticated-only) ────────
ALTER TABLE gn_extended_positions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  polname text;
BEGIN
  FOR polname IN
    SELECT policyname FROM pg_policies WHERE tablename = 'gn_extended_positions'
  LOOP
    EXECUTE format('DROP POLICY %I ON gn_extended_positions', polname);
  END LOOP;
END $$;

CREATE POLICY gn_extended_positions_select ON gn_extended_positions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY gn_extended_positions_insert ON gn_extended_positions
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY gn_extended_positions_update ON gn_extended_positions
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY gn_extended_positions_delete ON gn_extended_positions
  FOR DELETE TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON gn_extended_positions TO authenticated, service_role;
REVOKE ALL ON gn_extended_positions FROM anon;
