-- ============================================================
-- Artikelstamm – Dedizierte Supabase-Tabelle (Stage 2 Migration)
-- ============================================================
-- Diese Migration erstellt eine eigenständige Artikelstamm-Tabelle.
-- Stage 1 verwendet noch die app_settings-Tabelle als temporären Speicher.
-- Diese SQL kann angewendet werden, sobald Stage 2 umgesetzt wird.
-- ============================================================

-- ── Haupt-Tabelle: articles ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS articles (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  inventory_type         TEXT NOT NULL CHECK (inventory_type IN ('food', 'beverage')),
  unit                   TEXT NOT NULL DEFAULT 'Stück',
  -- Standardpreis (= Preis beim Standard-Lieferanten)
  default_cost_per_unit  NUMERIC(12, 4) NOT NULL DEFAULT 0,
  -- Standard-Lieferant (Freitext Stage 1, später FK zu suppliers-Tabelle)
  standard_supplier      TEXT NOT NULL DEFAULT '',
  -- Ausweichlieferant (nur aktiv wenn fallback_enabled = TRUE)
  fallback_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  fallback_supplier      TEXT NOT NULL DEFAULT '',
  -- WICHTIG: Alle Preise (standard + fallback) sind NETTO (exkl. MwSt.)
  -- Nur Nettopreise ermöglichen einen korrekten WES-Vergleich:
  --   Rezept-WES vs. Lieferanten-WES vs. Buchhaltungs-WES
  fallback_price         NUMERIC(12, 4) NOT NULL DEFAULT 0,
  -- Fibu-Konto für WES-Mapping (z.B. '4020' Wein, '4060' Küche/Food)
  -- Ermöglicht Vergleich auf Kontenebene mit der Buchhaltung
  accounting_account     TEXT NOT NULL DEFAULT '',
  storage_locations      TEXT[] NOT NULL DEFAULT '{}',
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Volltext-Index für Artikelnamen ──────────────────────────────────────────

CREATE INDEX IF NOT EXISTS articles_name_idx
  ON articles USING gin(to_tsvector('german', name));

CREATE INDEX IF NOT EXISTS articles_inventory_type_idx
  ON articles (inventory_type);

CREATE INDEX IF NOT EXISTS articles_active_idx
  ON articles (active);

-- ── Auto-Update für updated_at ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_articles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS articles_updated_at ON articles;
CREATE TRIGGER articles_updated_at
  BEFORE UPDATE ON articles
  FOR EACH ROW EXECUTE FUNCTION update_articles_updated_at();

-- ── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE articles ENABLE ROW LEVEL SECURITY;

-- Eingeloggte Benutzer können alle Artikel lesen
CREATE POLICY "authenticated_read_articles"
  ON articles FOR SELECT
  TO authenticated
  USING (true);

-- Eingeloggte Benutzer können Artikel erstellen/ändern/löschen
CREATE POLICY "authenticated_manage_articles"
  ON articles FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ── Hinweis ────────────────────────────────────────────────────────────────────
-- Stage 1 Datenmigration aus app_settings (in der App durchführen):
--
-- INSERT INTO articles (id, name, inventory_type, unit, default_cost_per_unit, storage_locations, active, created_at, updated_at)
-- SELECT
--   (art->>'id')::uuid,
--   art->>'name',
--   art->>'inventoryType',
--   art->>'unit',
--   (art->>'defaultCostPerUnit')::numeric,
--   ARRAY(SELECT jsonb_array_elements_text(art->'storageLocations')),
--   (art->>'active')::boolean,
--   (art->>'createdAt')::timestamptz,
--   (art->>'updatedAt')::timestamptz
-- FROM app_settings,
--      jsonb_array_elements(value->'articles') AS art
-- WHERE key = 'artikel_master_v1';
