-- ============================================================
-- Food Cost Tracking – Vollständiges Schema
-- ============================================================
-- Zweck:
--   Normalisierte Supabase-Tabellen für Produktkalkulation,
--   Wareneinsatz (WES), Lieferantendokumente und Umsatz.
--
-- Designprinzipien:
--   - Bundle-Produkte verwenden `cost_fixed` für die WES-Berechnung
--   - Standard-Produkte verwenden zutatenbasierte Kalkulation
--   - WES-Analysen laufen über Kostenpools, NICHT direkt über Produkte
--   - Alle Geldbeträge in CHF, netto (exkl. MwSt.)
--   - Alle Timestamps in UTC (TIMESTAMPTZ)
--
-- Abhängigkeiten (müssen vorhanden sein):
--   - Tabelle `articles` (aus 20260323_artikel_master.sql)
--
-- Reihenfolge der Tabellenerstellung:
--   1. suppliers              – Lieferanten-Stammdaten
--   2. products               – Produktstamm (Standard + Bundle)
--   3. product_ingredients    – Zutaten pro Produkt (→ articles)
--   4. cost_pools             – Kostenpools (Lunch, TakeAway, etc.)
--   5. product_costpool_mapping – Produkt ↔ Kostenpool Zuordnung
--   6. supplier_documents     – Lieferantendokumente (Lieferschein/Rechnung)
--   7. supplier_document_splits – Prozentuale Aufteilung pro Beleg
--   8. sales                  – Umsatzdaten pro Produkt
-- ============================================================


-- ╔══════════════════════════════════════════════════════════════╗
-- ║  1. suppliers – Lieferanten-Stammdaten                      ║
-- ╚══════════════════════════════════════════════════════════════╝
-- Entspricht dem TypeScript-Interface `SupplierMaster` in
-- src/types/supplier-documents.ts.
-- Gespeichert bisher in localStorage 'supplier_master_v1'.

CREATE TABLE IF NOT EXISTS public.suppliers (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Lieferantenname, z.B. 'Pistor AG', 'Transgourmet', 'Feldschlösschen'
  name                  TEXT        NOT NULL,

  -- Standard-Warenkategorie: 'food' | 'beverage' | 'other'
  -- Wird beim Erfassen eines Belegs als Standardwert vorbelegt
  default_category      TEXT        CHECK (default_category IN ('food', 'beverage', 'other')),

  -- Standard-Kontonummer aus dem Fibu-Kontenplan, 4-stellig
  -- z.B. '4060' = Küche/Food, '4020' = Wein, '4030' = Bier
  default_account_number TEXT,

  -- Inaktive Lieferanten erscheinen nicht im Dropdown
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Optionale Notiz: Kontaktdaten, Zahlungsziel, Konditionen
  note                  TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS suppliers_name_idx       ON public.suppliers (name);
CREATE INDEX IF NOT EXISTS suppliers_is_active_idx  ON public.suppliers (is_active);

-- Auto-Update updated_at
CREATE OR REPLACE FUNCTION public.update_suppliers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS suppliers_updated_at ON public.suppliers;
CREATE TRIGGER suppliers_updated_at
  BEFORE UPDATE ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.update_suppliers_updated_at();

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

-- Eingeloggte Benutzer können alle Lieferanten lesen
CREATE POLICY "authenticated_read_suppliers"
  ON public.suppliers FOR SELECT
  TO authenticated
  USING (true);

-- Eingeloggte Benutzer können Lieferanten verwalten
CREATE POLICY "authenticated_manage_suppliers"
  ON public.suppliers FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);


-- ╔══════════════════════════════════════════════════════════════╗
-- ║  2. products – Produktstamm                                 ║
-- ╚══════════════════════════════════════════════════════════════╝
-- Zentrale Produkttabelle. Deckt beide Typen ab:
--
--   product_type = 'standard'
--     → WES-Berechnung basiert auf Zutaten (product_ingredients)
--     → cost_fixed wird IGNORIERT
--
--   product_type = 'bundle'
--     → WES-Berechnung basiert auf cost_fixed (Pauschalkosten)
--     → product_ingredients werden NICHT ausgewertet
--     → bundle_description: Inhaltsbeschreibung (z.B. 'Frühstückskorb + Kaffee')
--     → bundle_cost_min/max: Kostenspanne für Varianzüberwachung
--
-- Entspricht dem TypeScript-Interface `ProductRecipe` in
-- src/lib/rezeptur-store.ts, erweitert um Stammdatenfelder.

CREATE TABLE IF NOT EXISTS public.products (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Produktname, z.B. 'Spaghetti Bolognese', 'Frühstückskorb'
  name              TEXT        NOT NULL,

  -- Kategorie des Produkts
  -- 'food'      = Speisen (Küche)
  -- 'takeaway'  = Take Away Produkte
  -- 'breakfast' = Frühstück
  -- 'dessert'   = Dessert / Patisserie
  -- 'pizza'     = Pizza
  -- 'beverage'  = Getränke
  category          TEXT        NOT NULL
                    CHECK (category IN ('food', 'takeaway', 'breakfast', 'dessert', 'pizza', 'beverage')),

  -- Produkttyp: Standard (zutatenbasiert) oder Bundle (Pauschal)
  -- Entspricht TypeScript `ProductType = 'standard' | 'bundle'`
  product_type      TEXT        NOT NULL DEFAULT 'standard'
                    CHECK (product_type IN ('standard', 'bundle')),

  -- Verkaufspreis netto (CHF, exkl. MwSt.)
  -- Basis für WES-Quote: WES-CHF / selling_price
  selling_price     NUMERIC(10, 4) NOT NULL DEFAULT 0,

  -- Fixkosten (CHF) – wird NUR bei product_type = 'bundle' verwendet.
  -- Bei Standardprodukten NULL (Kosten kommen aus Zutaten).
  cost_fixed        NUMERIC(10, 4),

  -- Bundle-Beschreibung: Inhaltsbeschreibung des Pakets
  -- z.B. 'Frühstückskorb + Kaffee + Orangensaft + 2 Croissants'
  -- Nur relevant wenn product_type = 'bundle'
  bundle_description TEXT,

  -- Kostenspanne Minimum (CHF) – untere Grenze für Bundle-Kosten
  -- Für Varianzüberwachung: Wenn cost_fixed < bundle_cost_min → Warnung
  bundle_cost_min   NUMERIC(10, 4),

  -- Kostenspanne Maximum (CHF) – obere Grenze für Bundle-Kosten
  -- Wenn cost_fixed > bundle_cost_max → Warnung
  bundle_cost_max   NUMERIC(10, 4),

  -- Vertriebskanal des Produkts
  -- 'restaurant' = normaler Restaurantbetrieb
  -- 'lunch'      = Mittagsmenu / Tagesangebot
  -- 'takeaway'   = Take Away
  -- 'breakfast'  = Frühstück
  sales_channel     TEXT
                    CHECK (sales_channel IN ('restaurant', 'lunch', 'takeaway', 'breakfast')),

  -- Kostenberechnungsmodus (nur für product_type = 'standard')
  -- 'rezeptur' = reine Zutatenkosten
  -- 'pauschal' = manuell eingegebener Pauschalpreis
  -- 'mixed'    = Zutaten + Aufschlag
  cost_mode         TEXT
                    CHECK (cost_mode IN ('rezeptur', 'pauschal', 'mixed')),

  -- Aktiv/Inaktiv: Inaktive Produkte erscheinen nicht in der Kalkulation
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints: Bundle-Produkte müssen einen Fixpreis haben
  CONSTRAINT bundle_requires_cost_fixed
    CHECK (product_type != 'bundle' OR cost_fixed IS NOT NULL),

  -- Kostenspanne: Min muss kleiner/gleich Max sein
  CONSTRAINT bundle_cost_range_valid
    CHECK (bundle_cost_min IS NULL OR bundle_cost_max IS NULL OR bundle_cost_min <= bundle_cost_max)
);

CREATE INDEX IF NOT EXISTS products_name_idx         ON public.products (name);
CREATE INDEX IF NOT EXISTS products_category_idx     ON public.products (category);
CREATE INDEX IF NOT EXISTS products_product_type_idx ON public.products (product_type);
CREATE INDEX IF NOT EXISTS products_sales_channel_idx ON public.products (sales_channel);
CREATE INDEX IF NOT EXISTS products_is_active_idx    ON public.products (is_active);

-- Volltext-Index für Produktnamen (Deutsch)
CREATE INDEX IF NOT EXISTS products_name_fts_idx
  ON public.products USING gin(to_tsvector('german', name));

-- Auto-Update updated_at
CREATE OR REPLACE FUNCTION public.update_products_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_updated_at ON public.products;
CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.update_products_updated_at();

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_products"
  ON public.products FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "authenticated_manage_products"
  ON public.products FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);


-- ╔══════════════════════════════════════════════════════════════╗
-- ║  3. product_ingredients – Zutaten pro Produkt               ║
-- ╚══════════════════════════════════════════════════════════════╝
-- Verknüpft Standardprodukte mit ihren Zutaten aus dem Artikelstamm.
-- Jede Zeile = 1 Zutat in einer bestimmten Menge.
--
-- WICHTIG: Diese Tabelle wird NUR für product_type = 'standard' verwendet.
-- Bundle-Produkte ignorieren Zutaten und verwenden products.cost_fixed.
--
-- Entspricht dem Ingredients-Array in `ProductRecipe.ingredients`
-- (src/lib/rezeptur-store.ts).

CREATE TABLE IF NOT EXISTS public.product_ingredients (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Verweis auf das übergeordnete Produkt
  product_id    UUID        NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,

  -- Verweis auf den Artikel im Artikelstamm (articles-Tabelle)
  -- Enthält Preis, Einheit, Lieferant, Fibu-Konto
  ingredient_id UUID        NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,

  -- Mengenmässiger Einsatz der Zutat pro Portion
  -- Beispiel: 0.150 (= 150g Mehl)
  quantity      NUMERIC(12, 4) NOT NULL DEFAULT 0
                CHECK (quantity >= 0),

  -- Mengeneinheit: 'g', 'kg', 'ml', 'l', 'Stück', 'EL', 'TL', etc.
  unit          TEXT        NOT NULL DEFAULT 'g',

  -- Reihenfolge der Zutat in der Rezeptliste (für UI-Sortierung)
  sort_order    INTEGER     NOT NULL DEFAULT 0,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Ein Artikel kann pro Produkt nur einmal eingetragen werden
  UNIQUE (product_id, ingredient_id)
);

CREATE INDEX IF NOT EXISTS product_ingredients_product_idx    ON public.product_ingredients (product_id);
CREATE INDEX IF NOT EXISTS product_ingredients_ingredient_idx ON public.product_ingredients (ingredient_id);

ALTER TABLE public.product_ingredients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_product_ingredients"
  ON public.product_ingredients FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "authenticated_manage_product_ingredients"
  ON public.product_ingredients FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);


-- ╔══════════════════════════════════════════════════════════════╗
-- ║  4. cost_pools – Kostenpools                                ║
-- ╚══════════════════════════════════════════════════════════════╝
-- Kostenpools definieren, welchem Bereich ein Wareneinsatz zugeordnet wird.
-- Entspricht dem TypeScript-Typ `CostAllocationTarget` in
-- src/types/supplier-documents.ts.
--
-- WES-Berechnung:
--   Ist-WES = Summe aller supplier_documents mit diesem cost_pool_id
--   Soll-WES = Summe aller products.cost_fixed (Bundle) oder berechnete
--              Rezeptkosten × verkaufte Menge (Standard)
--
-- Wichtig: WES-Vergleiche laufen IMMER über Kostenpools, niemals
-- direkt über Produkt-IDs. Dies ermöglicht flexible Zuordnung
-- mehrerer Produkte zu einem Pool.

CREATE TABLE IF NOT EXISTS public.cost_pools (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Interner Schlüssel, entspricht CostAllocationTarget-Enum-Wert
  -- z.B. 'lunch_basic', 'takeaway_food', 'breakfast_food'
  -- UNIQUE damit FK-Verweise stabil bleiben
  pool_key    TEXT    NOT NULL UNIQUE,

  -- Anzeigename in der UI
  -- z.B. 'Lunch Basic (Menu 1)', 'Take Away – Speisen'
  name        TEXT    NOT NULL,

  -- Pool-Typ für übergeordnete Gruppierung in der Analyse
  -- 'lunch'      = Mittagsangebot
  -- 'takeaway'   = Take Away
  -- 'breakfast'  = Frühstück
  -- 'kitchen'    = Allgemeine Küche / Mise en place
  -- 'beverage'   = Getränke
  -- 'dessert'    = Dessert / Patisserie
  -- 'pizza'      = Pizza
  -- 'general'    = Allgemein (keiner Sparte zugeordnet)
  type        TEXT    NOT NULL
              CHECK (type IN ('lunch', 'takeaway', 'breakfast', 'kitchen', 'beverage', 'dessert', 'pizza', 'general')),

  -- Sortierreihenfolge in der UI
  sort_order  INTEGER NOT NULL DEFAULT 0,

  -- Ist dieser Pool für neue Zuordnungen sichtbar?
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cost_pools_type_idx   ON public.cost_pools (type);
CREATE INDEX IF NOT EXISTS cost_pools_key_idx    ON public.cost_pools (pool_key);

ALTER TABLE public.cost_pools ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_cost_pools"
  ON public.cost_pools FOR SELECT
  TO authenticated
  USING (true);

-- Nur Admins dürfen Kostenpools anlegen/ändern (Stammdaten)
CREATE POLICY "authenticated_manage_cost_pools"
  ON public.cost_pools FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ── Standard-Kostenpools einfügen ─────────────────────────────────────────────
-- Entspricht exakt den CostAllocationTarget-Werten in supplier-documents.ts.
-- ON CONFLICT DO NOTHING → sicher wiederholbar (idempotent).

INSERT INTO public.cost_pools (pool_key, name, type, sort_order) VALUES
  -- Lunch / Mittagsmenu
  ('lunch_basic',        'Lunch Basic (Menu 1)',          'lunch',    10),
  ('lunch_premium',      'Lunch Premium (Menu 2)',         'lunch',    20),

  -- Take Away
  ('takeaway',           'Take Away (allgemein / Legacy)', 'takeaway', 30),
  ('takeaway_food',      'Take Away – Speisen',            'takeaway', 31),
  ('takeaway_beverages', 'Take Away – Getränke',           'takeaway', 32),

  -- Frühstück
  ('breakfast_food',     'Frühstück – Speisen',            'breakfast', 40),
  ('breakfast_drinks',   'Frühstück – Getränke',           'breakfast', 41),

  -- Küche allgemein
  ('a_la_carte',         'À la carte',                    'kitchen',  50),
  ('kinder',             'Kindermenu',                    'kitchen',  51),
  ('kueche_allgemein',   'Allg. Küche / Mise en place',   'kitchen',  52),

  -- Weitere Bereiche
  ('pizza',              'Pizza',                          'pizza',    60),
  ('dessert',            'Dessert / Patisserie',           'dessert',  70),
  ('beverage',           'Getränke',                       'beverage', 80)

ON CONFLICT (pool_key) DO NOTHING;


-- ╔══════════════════════════════════════════════════════════════╗
-- ║  5. product_costpool_mapping – Produkt ↔ Kostenpool         ║
-- ╚══════════════════════════════════════════════════════════════╝
-- Ordnet Produkte einem oder mehreren Kostenpools zu.
-- Ermöglicht Soll-WES-Berechnung pro Pool:
--   Pool-Soll = Summe (Rezeptkosten × verkaufte Menge) für alle
--               diesem Pool zugeordneten Produkte.
--
-- Ein Produkt kann mehreren Pools angehören (z.B. ein Gericht
-- wird sowohl im Lunch-Bereich als auch à la carte verkauft).

CREATE TABLE IF NOT EXISTS public.product_costpool_mapping (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),

  product_id    UUID    NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  cost_pool_id  UUID    NOT NULL REFERENCES public.cost_pools(id) ON DELETE RESTRICT,

  -- Optionaler Gewichtungsfaktor, falls ein Produkt anteilig
  -- zu mehreren Pools gehört (0.0–1.0, Standard = 1.0 = 100%)
  weight        NUMERIC(5, 4) NOT NULL DEFAULT 1.0
                CHECK (weight > 0 AND weight <= 1),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Jede Produkt-Pool-Kombination nur einmal
  UNIQUE (product_id, cost_pool_id)
);

CREATE INDEX IF NOT EXISTS product_costpool_product_idx  ON public.product_costpool_mapping (product_id);
CREATE INDEX IF NOT EXISTS product_costpool_pool_idx     ON public.product_costpool_mapping (cost_pool_id);

ALTER TABLE public.product_costpool_mapping ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_product_costpool_mapping"
  ON public.product_costpool_mapping FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "authenticated_manage_product_costpool_mapping"
  ON public.product_costpool_mapping FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);


-- ╔══════════════════════════════════════════════════════════════╗
-- ║  6. supplier_documents – Lieferantendokumente               ║
-- ╚══════════════════════════════════════════════════════════════╝
-- Erfassung von Lieferscheinen und Rechnungen.
-- Entspricht dem TypeScript-Interface `SupplierDocument` in
-- src/types/supplier-documents.ts.
--
-- Gespeichert bisher in localStorage 'supplier_docs_v1'.
-- Diese Tabelle ist die Ziel-Migrationsstruktur für Stage 2.
--
-- Wichtige Regel:
--   Diese Werte sind OPERATIVER NATUR (Echtzeit-Schätzung).
--   Sie ersetzen NIEMALS die offiziellen Buchhaltungswerte
--   (Saldo-Import aus Sage via PDF/CSV).
--   Bei Abweichungen ist immer die Buchhaltung massgebend.
--
-- Ist-WES-Berechnung:
--   Pro Monat und Kostenpool = Summe aller Beträge (amount) der
--   Dokumente, die diesem Pool zugeordnet sind.

CREATE TABLE IF NOT EXISTS public.supplier_documents (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Verweis auf Lieferanten-Stammdaten
  -- Wenn NULL: Lieferant wird als Freitext in supplier_name gespeichert
  supplier_id         UUID        REFERENCES public.suppliers(id) ON DELETE SET NULL,

  -- Lieferantenname als Freitext (Fallback / Direkteingabe)
  -- Wird aus suppliers.name befüllt wenn supplier_id gesetzt ist
  supplier_name       TEXT        NOT NULL,

  -- Dokumenttyp: 'delivery_note' = Lieferschein, 'invoice' = Rechnung
  document_type       TEXT        NOT NULL
                      CHECK (document_type IN ('delivery_note', 'invoice')),

  -- Belegdatum (Datum der Rechnung oder des Lieferscheins)
  date                DATE        NOT NULL,

  -- Lieferdatum (optional) – Priorität über `date` bei Monatszuordnung
  -- Wenn gesetzt: WES wird zum Liefermonat, nicht zum Rechnungsmonat gerechnet
  -- Beispiel: Rechnung 5. April für Lieferung 30. März → deliveryDate = 30.03
  delivery_date       DATE,

  -- Effektives Datum für Monatszuordnung:
  --   COALESCE(delivery_date, date)
  -- Wird als computed-ähnliches Feld für Abfragen verwendet
  -- (da Postgres Computed Columns in WHERE besser indiziert werden können)
  effective_year      SMALLINT    NOT NULL,
  effective_month     SMALLINT    NOT NULL CHECK (effective_month BETWEEN 1 AND 12),

  -- Warenkategorie: bestimmt Buchhaltungsbereich
  -- 'food'     → Wareneinsatz Küche    (Konto 4000–4099)
  -- 'beverage' → Wareneinsatz Getränke (Konto 4100–4199)
  -- 'other'    → Sonstiger Aufwand     (Konto 4200–4299)
  category            TEXT        NOT NULL
                      CHECK (category IN ('food', 'beverage', 'other')),

  -- Betrag in CHF netto (ohne MwSt.)
  -- Operativer Schätzwert – nicht für Buchhaltungsabschluss verwenden
  total_amount        NUMERIC(12, 2) NOT NULL
                      CHECK (total_amount >= 0),

  -- Kostenpool-Zuordnung (einfach, ohne prozentuale Aufteilung)
  -- Entspricht SupplierDocument.allocationTarget
  -- Wenn NULL oder 'unassigned': kein Pool zugeordnet
  -- Wenn allocationSplits vorhanden (in supplier_document_splits):
  --   → dieses Feld wird ignoriert
  cost_pool_id        UUID        REFERENCES public.cost_pools(id) ON DELETE SET NULL,

  -- Zuordnungstyp:
  -- 'simple' = nur cost_pool_id (kein Split)
  -- 'split'  = prozentuale Aufteilung in supplier_document_splits
  allocation_type     TEXT        NOT NULL DEFAULT 'simple'
                      CHECK (allocation_type IN ('simple', 'split')),

  -- Fibu-Kontonummer (4-stellig), z.B. '4060' = Küche/Food
  -- Verbindet den operativen Beleg mit dem Buchhaltungskontenplan
  account_number      TEXT,

  -- Referenznummer: Lieferschein-Nr., Rechnungs-Nr., Bestellnummer
  reference_number    TEXT,

  -- Optionale Notiz: Kommentar, Sonderkonditionen, etc.
  note                TEXT,

  -- ── Duplikat-Prävention: Lieferschein ↔ Rechnung Matching ────────────────
  -- Verknüpftes Gegenstück (Lieferschein ↔ Rechnung)
  -- Wenn gesetzt: Lieferscheine werden aus der Monatssumme ausgeschlossen
  -- (die Rechnung zählt), um Doppelzählung zu vermeiden
  linked_document_id  UUID        REFERENCES public.supplier_documents(id) ON DELETE SET NULL,

  -- Matching-Status:
  -- 'linked'    = manuell bestätigt verknüpft → Lieferschein aus Summe ausgeschlossen
  -- 'suggested' = automatisch erkannte mögliche Übereinstimmung → zu bestätigen
  -- NULL        = kein Matching
  match_status        TEXT
                      CHECK (match_status IN ('linked', 'suggested')),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS supplier_docs_supplier_id_idx     ON public.supplier_documents (supplier_id);
CREATE INDEX IF NOT EXISTS supplier_docs_year_month_idx      ON public.supplier_documents (effective_year, effective_month);
CREATE INDEX IF NOT EXISTS supplier_docs_category_idx        ON public.supplier_documents (category);
CREATE INDEX IF NOT EXISTS supplier_docs_cost_pool_idx       ON public.supplier_documents (cost_pool_id);
CREATE INDEX IF NOT EXISTS supplier_docs_document_type_idx   ON public.supplier_documents (document_type);
CREATE INDEX IF NOT EXISTS supplier_docs_date_idx            ON public.supplier_documents (date);
CREATE INDEX IF NOT EXISTS supplier_docs_match_status_idx    ON public.supplier_documents (match_status);

-- Zusammengesetzter Index für die häufigste Abfrage:
-- «Alle Belege eines Monats nach Pool»
CREATE INDEX IF NOT EXISTS supplier_docs_month_pool_idx
  ON public.supplier_documents (effective_year, effective_month, cost_pool_id);

-- Auto-Update updated_at
CREATE OR REPLACE FUNCTION public.update_supplier_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supplier_documents_updated_at ON public.supplier_documents;
CREATE TRIGGER supplier_documents_updated_at
  BEFORE UPDATE ON public.supplier_documents
  FOR EACH ROW EXECUTE FUNCTION public.update_supplier_documents_updated_at();

ALTER TABLE public.supplier_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_supplier_documents"
  ON public.supplier_documents FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "authenticated_manage_supplier_documents"
  ON public.supplier_documents FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);


-- ╔══════════════════════════════════════════════════════════════╗
-- ║  7. supplier_document_splits – Prozentuale Aufteilung       ║
-- ╚══════════════════════════════════════════════════════════════╝
-- Ermöglicht einen Beleg anteilig auf mehrere Kostenpools aufzuteilen.
-- Entspricht dem TypeScript-Interface `AllocationSplit` in
-- src/types/supplier-documents.ts.
--
-- Beispiel:
--   Beleg CHF 500 → 60% Lunch Basic + 40% À la carte
--   → Split 1: cost_pool_id = lunch_basic,  percentage = 60, amount = 300
--   → Split 2: cost_pool_id = a_la_carte,   percentage = 40, amount = 200
--
-- Bedingung: Alle Splits eines Dokuments müssen zusammen 100% ergeben.
--   (Validierung in der Applikationslogik, nicht auf DB-Ebene,
--    da Postgres-SUM-Checks über mehrere Zeilen nicht trivial sind.)

CREATE TABLE IF NOT EXISTS public.supplier_document_splits (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Verweis auf das übergeordnete Lieferantendokument
  document_id   UUID        NOT NULL REFERENCES public.supplier_documents(id) ON DELETE CASCADE,

  -- Kostenpool für diesen Split-Anteil
  cost_pool_id  UUID        NOT NULL REFERENCES public.cost_pools(id) ON DELETE RESTRICT,

  -- Prozentualer Anteil (0–100)
  -- Alle Splits eines Dokuments müssen zusammen 100.00 ergeben
  percentage    NUMERIC(6, 2) NOT NULL
                CHECK (percentage > 0 AND percentage <= 100),

  -- Absoluter Betrag in CHF = supplier_documents.total_amount × (percentage / 100)
  -- Wird aus Applikationslogik berechnet und gespeichert, damit
  -- SQL-Abfragen ohne JOIN zur Parent-Tabelle aggregieren können
  amount        NUMERIC(12, 2) NOT NULL
                CHECK (amount >= 0),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Ein Kostenpool kann pro Dokument nur einmal vorkommen
  UNIQUE (document_id, cost_pool_id)
);

CREATE INDEX IF NOT EXISTS doc_splits_document_idx   ON public.supplier_document_splits (document_id);
CREATE INDEX IF NOT EXISTS doc_splits_cost_pool_idx  ON public.supplier_document_splits (cost_pool_id);

ALTER TABLE public.supplier_document_splits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_supplier_document_splits"
  ON public.supplier_document_splits FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "authenticated_manage_supplier_document_splits"
  ON public.supplier_document_splits FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);


-- ╔══════════════════════════════════════════════════════════════╗
-- ║  8. sales – Umsatzdaten pro Produkt                         ║
-- ╚══════════════════════════════════════════════════════════════╝
-- Tägliche oder monatliche Verkaufsdaten pro Produkt.
-- Grundlage für:
--   - Ist-WES: Menge × Rezeptkosten (Standard) oder cost_fixed (Bundle)
--   - Umsatzanalyse: Menge × selling_price
--   - Deckungsbeitrags-Auswertung pro Produkt und Kostenpool
--
-- Hinweis: Der offizielle Umsatz kommt aus dem Sage-Import (reporting_v1).
-- Diese Tabelle enthält operative Stückzahlen aus dem Kassensystem
-- oder der manuellen Erfassung.

CREATE TABLE IF NOT EXISTS public.sales (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Verkauftes Produkt
  product_id  UUID        NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,

  -- Verkaufte Menge (Anzahl Portionen / Stück)
  quantity    NUMERIC(10, 4) NOT NULL
              CHECK (quantity > 0),

  -- Umsatz in CHF netto (quantity × selling_price zum Zeitpunkt des Verkaufs)
  -- Gespeichert damit Preisänderungen historische Daten nicht verfälschen
  revenue     NUMERIC(12, 2) NOT NULL
              CHECK (revenue >= 0),

  -- Effektiver Verkaufspreis netto zum Zeitpunkt des Verkaufs (CHF)
  -- Kann vom aktuellen products.selling_price abweichen (Preisanpassungen)
  unit_price  NUMERIC(10, 4),

  -- Verkaufsdatum
  date        DATE        NOT NULL,

  -- Jahr und Monat für schnelle Aggregation ohne EXTRACT
  year        SMALLINT    NOT NULL,
  month       SMALLINT    NOT NULL CHECK (month BETWEEN 1 AND 12),

  -- Optionaler Vertriebskanal-Override (übersteuert products.sales_channel)
  -- Wenn NULL: sales_channel aus products.sales_channel
  sales_channel TEXT
              CHECK (sales_channel IN ('restaurant', 'lunch', 'takeaway', 'breakfast')),

  -- Quelle der Verkaufsdaten
  -- 'pos'     = Kassensystem (automatisch importiert)
  -- 'manual'  = Manuell erfasst
  source      TEXT        NOT NULL DEFAULT 'manual'
              CHECK (source IN ('pos', 'manual')),

  -- Optionale Notiz: Sonderaktion, Event, Menüwoche, etc.
  note        TEXT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sales_product_idx        ON public.sales (product_id);
CREATE INDEX IF NOT EXISTS sales_date_idx           ON public.sales (date);
CREATE INDEX IF NOT EXISTS sales_year_month_idx     ON public.sales (year, month);
CREATE INDEX IF NOT EXISTS sales_sales_channel_idx  ON public.sales (sales_channel);

-- Zusammengesetzter Index für die Ist-WES-Berechnung:
-- «Alle Verkäufe eines Monats nach Produkt»
CREATE INDEX IF NOT EXISTS sales_month_product_idx
  ON public.sales (year, month, product_id);

ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_sales"
  ON public.sales FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "authenticated_manage_sales"
  ON public.sales FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);


-- ============================================================
-- WES-Berechnungslogik (als Kommentar dokumentiert)
-- ============================================================
--
-- Ist-WES pro Pool und Monat:
--   SELECT
--     cp.name                          AS pool,
--     SUM(sd.total_amount)             AS ist_wes_chf
--   FROM supplier_documents sd
--   JOIN cost_pools cp ON cp.id = sd.cost_pool_id
--   WHERE sd.effective_year = :year AND sd.effective_month = :month
--     AND sd.match_status IS DISTINCT FROM 'linked'  -- Lieferschein-Duplikate ausschliessen
--   GROUP BY cp.name;
--
-- Soll-WES pro Pool und Monat (Standard-Produkte):
--   SELECT
--     cp.name                                              AS pool,
--     SUM(s.quantity * pi.quantity * a.default_cost_per_unit) AS soll_wes_chf
--   FROM sales s
--   JOIN products p                   ON p.id = s.product_id
--   JOIN product_costpool_mapping pcm ON pcm.product_id = p.id
--   JOIN cost_pools cp                ON cp.id = pcm.cost_pool_id
--   JOIN product_ingredients pi       ON pi.product_id = p.id
--   JOIN articles a                   ON a.id = pi.ingredient_id
--   WHERE s.year = :year AND s.month = :month
--     AND p.product_type = 'standard'
--   GROUP BY cp.name;
--
-- Soll-WES pro Pool und Monat (Bundle-Produkte):
--   SELECT
--     cp.name                              AS pool,
--     SUM(s.quantity * p.cost_fixed)       AS soll_wes_chf
--   FROM sales s
--   JOIN products p                   ON p.id = s.product_id
--   JOIN product_costpool_mapping pcm ON pcm.product_id = p.id
--   JOIN cost_pools cp                ON cp.id = pcm.cost_pool_id
--   WHERE s.year = :year AND s.month = :month
--     AND p.product_type = 'bundle'
--   GROUP BY cp.name;
--
-- WES-Quote (in %):
--   WES-CHF / Umsatz-CHF × 100
--   Soll:  Soll-WES-CHF / SUM(s.revenue) × 100
--   Ist:   Ist-WES-CHF  / Buchhaltungs-Umsatz × 100
-- ============================================================
