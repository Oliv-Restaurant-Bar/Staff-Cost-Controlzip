// @vitest-environment node
/**
 * produkt-quellen.test.ts
 * =======================
 * Quellenpriorität der Produktanalyse (reine Logik):
 * erweiterter Z-Bericht > Verkaufsdatenimport, keine Doppelzählung,
 * Mehrtagesberichte nie auf Tage verteilt, Kategorie aus Verkaufshistorie.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSalesCategoryMap,
  mergeProduktQuellen,
  produktQuellenLabel,
  isGnExtendedRow,
  isGnExtendedPeriodSumRow,
  GN_EXTENDED_SOURCE,
  GN_EXTENDED_SOURCE_FOOD,
  GN_EXTENDED_SOURCE_BEVERAGE,
  type ExtendedPositionInput,
} from '../produkt-quellen';
import { categoryOf } from '../product-analytics';
import type { ProductSalesRow } from '../sales-db';

function salesRow(over: Partial<ProductSalesRow>): ProductSalesRow {
  return {
    product_name: 'Produkt',
    quantity: 1,
    revenue: 10,
    sale_date: '2026-07-01',
    source: 'food_csv_export',
    import_batch: 'batch-1',
    ...over,
  };
}

function pos(over: Partial<ExtendedPositionInput>): ExtendedPositionInput {
  return {
    importId: 'imp-1',
    periodFrom: '2026-07-01',
    periodTo: '2026-07-01',
    name: 'Cappuccino',
    quantity: 5,
    grossAmount: 27.5,
    ...over,
  };
}

const JULI = { from: '2026-07-01', to: '2026-07-31' };
const EMPTY_CAT = new Map<string, 'food' | 'beverage'>();

describe('buildSalesCategoryMap', () => {
  it('leitet Food/Beverage aus der Quelle ab, neuester Eintrag gewinnt', () => {
    const map = buildSalesCategoryMap([
      salesRow({ product_name: 'Cappuccino', source: 'food_csv_export', sale_date: '2026-01-01' }),
      salesRow({ product_name: 'Cappuccino', source: 'beverage_csv_export', sale_date: '2026-06-01' }),
      salesRow({ product_name: 'Pizza', source: 'food_csv_export', sale_date: '2026-05-01' }),
      salesRow({ product_name: 'Unbekannt', source: 'manual_test', sale_date: '2026-05-01' }),
    ], categoryOf);
    expect(map.get('Cappuccino')).toBe('beverage');
    expect(map.get('Pizza')).toBe('food');
    expect(map.has('Unbekannt')).toBe(false);
  });
});

describe('mergeProduktQuellen — Quellenpriorität', () => {
  it('Eintagesbericht verdrängt Verkaufsdaten desselben Tages (keine Doppelzählung)', () => {
    const res = mergeProduktQuellen({
      salesRows: [
        salesRow({ product_name: 'Cappuccino', sale_date: '2026-07-01', revenue: 20 }),
        salesRow({ product_name: 'Pizza', sale_date: '2026-07-02', revenue: 30 }),
      ],
      extendedPositions: [pos({})],
      bounds: JULI,
      categoryByProduct: EMPTY_CAT,
    });
    // 01.07 kommt NUR aus dem erweiterten Bericht, 02.07 bleibt Verkaufsdaten
    expect(res.excludedSalesRows).toBe(1);
    expect(res.usedExtendedImportIds).toEqual(['imp-1']);
    expect(res.source).toBe('gemischt');
    const dates01 = res.rows.filter(r => r.sale_date === '2026-07-01');
    expect(dates01).toHaveLength(1);
    expect(isGnExtendedRow(dates01[0])).toBe(true);
    expect(dates01[0].revenue).toBe(27.5);
    expect(res.rows.some(r => r.product_name === 'Pizza')).toBe(true);
  });

  it('ohne erweiterte Berichte bleiben die Verkaufsdaten unverändert (Fallback)', () => {
    const res = mergeProduktQuellen({
      salesRows: [salesRow({})],
      extendedPositions: [],
      bounds: JULI,
      categoryByProduct: EMPTY_CAT,
    });
    expect(res.source).toBe('verkaufsdaten');
    expect(res.rows).toHaveLength(1);
    expect(res.excludedSalesRows).toBe(0);
  });

  it('leerer Zeitraum → source «keine», Label null', () => {
    const res = mergeProduktQuellen({
      salesRows: [], extendedPositions: [], bounds: JULI, categoryByProduct: EMPTY_CAT,
    });
    expect(res.source).toBe('keine');
    expect(produktQuellenLabel(res.source)).toBeNull();
  });

  it('Mehrtagesbericht INNERHALB des Zeitraums zählt als EINE Periodensumme am Bis-Datum', () => {
    const res = mergeProduktQuellen({
      salesRows: [],
      extendedPositions: [
        pos({ importId: 'imp-2', periodFrom: '2026-06-30', periodTo: '2026-07-01' }),
      ],
      bounds: { from: '2026-06-01', to: '2026-07-31' },
      categoryByProduct: EMPTY_CAT,
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].sale_date).toBe('2026-07-01'); // Geschäftstag endet am Bis-Datum
    expect(isGnExtendedPeriodSumRow(res.rows[0])).toBe(true);
    expect(res.periodSumOnlyReports).toHaveLength(0);
  });

  it('Mehrtagesbericht, der über den Zeitraum hinausragt, wird AUSGESCHLOSSEN und gemeldet', () => {
    const res = mergeProduktQuellen({
      salesRows: [salesRow({ sale_date: '2026-07-01' })],
      extendedPositions: [
        pos({ importId: 'imp-3', periodFrom: '2026-06-30', periodTo: '2026-07-01' }),
      ],
      bounds: { from: '2026-07-01', to: '2026-07-01' }, // Tagesansicht
      categoryByProduct: EMPTY_CAT,
    });
    // Bericht nicht verwendbar → Verkaufsdaten-Fallback bleibt, Hinweis gemeldet
    expect(res.usedExtendedImportIds).toHaveLength(0);
    expect(res.periodSumOnlyReports).toEqual([
      { importId: 'imp-3', periodFrom: '2026-06-30', periodTo: '2026-07-01' },
    ]);
    expect(res.rows).toHaveLength(1);
    expect(isGnExtendedRow(res.rows[0])).toBe(false);
    expect(res.source).toBe('verkaufsdaten');
  });

  it('Bericht ausserhalb des Zeitraums zählt nirgends (weder Zeilen noch Hinweis)', () => {
    const res = mergeProduktQuellen({
      salesRows: [],
      extendedPositions: [pos({ periodFrom: '2026-05-01', periodTo: '2026-05-01' })],
      bounds: JULI,
      categoryByProduct: EMPTY_CAT,
    });
    expect(res.rows).toHaveLength(0);
    expect(res.periodSumOnlyReports).toHaveLength(0);
    expect(res.source).toBe('keine');
  });

  it('Bericht ohne Zeitraum (period null) zählt nirgends', () => {
    const res = mergeProduktQuellen({
      salesRows: [],
      extendedPositions: [pos({ periodFrom: null, periodTo: null })],
      bounds: JULI,
      categoryByProduct: EMPTY_CAT,
    });
    expect(res.rows).toHaveLength(0);
    expect(res.source).toBe('keine');
  });

  it('Kategorie kommt aus der Verkaufshistorie; ohne Historie unklassifiziert', () => {
    const cat = new Map<string, 'food' | 'beverage'>([
      ['Pizza', 'food'],
      ['Cappuccino', 'beverage'],
    ]);
    const res = mergeProduktQuellen({
      salesRows: [],
      extendedPositions: [
        pos({ name: 'Pizza' }),
        pos({ name: 'Cappuccino' }),
        pos({ name: 'Neu im Sortiment' }),
      ],
      bounds: JULI,
      categoryByProduct: cat,
    });
    const bySrc = new Map(res.rows.map(r => [r.product_name, r.source]));
    expect(bySrc.get('Pizza')).toBe(GN_EXTENDED_SOURCE_FOOD);
    expect(bySrc.get('Cappuccino')).toBe(GN_EXTENDED_SOURCE_BEVERAGE);
    expect(bySrc.get('Neu im Sortiment')).toBe(GN_EXTENDED_SOURCE);
  });

  it('zwei verwendete Berichte an verschiedenen Tagen summieren sich, Verkaufsdaten beider Tage weichen', () => {
    const res = mergeProduktQuellen({
      salesRows: [
        salesRow({ sale_date: '2026-07-01' }),
        salesRow({ sale_date: '2026-07-02' }),
        salesRow({ sale_date: '2026-07-03' }),
      ],
      extendedPositions: [
        pos({ importId: 'a', periodFrom: '2026-07-01', periodTo: '2026-07-01' }),
        pos({ importId: 'b', periodFrom: '2026-07-02', periodTo: '2026-07-02' }),
      ],
      bounds: JULI,
      categoryByProduct: EMPTY_CAT,
    });
    expect(res.usedExtendedImportIds.sort()).toEqual(['a', 'b']);
    expect(res.excludedSalesRows).toBe(2);
    expect(res.rows.filter(r => !isGnExtendedRow(r))).toHaveLength(1); // nur 03.07
  });

  it('Labels der Datenquelle', () => {
    expect(produktQuellenLabel('extended')).toContain('Erweiterter Z-Bericht');
    expect(produktQuellenLabel('verkaufsdaten')).toContain('Verkaufsdatenimport');
    expect(produktQuellenLabel('gemischt')).toContain('+');
  });
});
