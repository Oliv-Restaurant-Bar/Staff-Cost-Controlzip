-- ============================================================
-- products: wes_per_unit Spalte hinzufügen
-- ============================================================
-- Zweck:
--   Ergänzt die products-Tabelle um ein direktes WES-Feld
--   (Wareneinsatz pro Stück, CHF netto).
--
-- Hinweis:
--   Die App nutzt aktuell die Tabelle produkte_kosten als
--   primären WES-Speicher (loadProductWesMap in sales-db.ts).
--   Diese Migration ist für eine spätere direkte DB-Anbindung
--   über products.wes_per_unit vorgesehen.
--
--   Sobald diese Migration angewendet wurde:
--   → sales-db.ts kann products.wes_per_unit direkt lesen
--   → produkte_kosten bleibt als Fallback bestehen
-- ============================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS wes_per_unit NUMERIC(10, 4);

COMMENT ON COLUMN public.products.wes_per_unit IS
  'Wareneinsatz pro Stück in CHF (netto). '
  'Wird im Verkaufs-Dashboard verwendet: wes_total = quantity × wes_per_unit.';
