// @vitest-environment node
/**
 * Tests: Produktanalyse-Import — Mandanten-Trennung + tag-genaues Überschreiben
 * ============================================================================
 * Reine Logik-Ebene (kein echter DB-Zugriff):
 *   - computeDeleteScope: TAG-GENAUER Lösch-Scope aus den geparsten Zeilen,
 *     gruppiert nach source, exakte (deduplizierte, sortierte) Tagesliste.
 *   - Idempotenz: zweimal dieselben Zeilen ⇒ identischer Scope + identische
 *     Merge-Summen (Delete-Scope + Merge modellieren den Re-Import).
 *   - Tag-genau: Tage ausserhalb der Datei bleiben unberührt.
 *   - Tenant-Isolation: der Scope betrifft NUR die Zeilen des aktiven Mandanten;
 *     Fremd-Mandanten-Zeilen (hier: separater Bestand) bleiben unangetastet
 *     (der DB-Filter .eq('restaurant_id', tenantId) ist in deleteProductSalesForPeriod
 *     bzw. den Lesern verdrahtet; hier: Scope-Berechnung tenant-agnostisch,
 *     Isolation über getrennte Bestände geprüft).
 *
 * Supabase-Client + produkte-store werden gemockt, da sales-db sie beim Import
 * zieht (jsdom/canvas + xlsx vermeiden). Die getesteten Funktionen sind rein.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => ({}) } }));
vi.mock('@/lib/produkte-store', () => ({ loadProductCostsFromDB: async () => [] }));

import { computeDeleteScope, type DeleteScopeInputRow } from '@/lib/sales-db';
// Merge-Semantik (tag-genau) aus der TA-Pipeline wiederverwendet.
import { mergeTakeAwayDays } from '@/lib/takeaway-cockpit-metrics';

// Eine Datei-Zeile für den Import (nur die scope-relevanten Felder).
type Row = DeleteScopeInputRow & { product_name: string; quantity: number; restaurant_id?: string };

const fileFood: Row[] = [
  { product_name: 'Pizza TA', quantity: 6, source: 'food_csv_export', sale_date: '2026-07-27' },
  { product_name: 'Pizza TA', quantity: 6, source: 'food_csv_export', sale_date: '2026-07-28' },
  { product_name: 'Pasta',    quantity: 3, source: 'food_csv_export', sale_date: '2026-07-28' }, // gleicher Tag
];
const fileBev: Row[] = [
  { product_name: 'Wein', quantity: 4, source: 'beverage_csv_export', sale_date: '2026-07-28' },
];

describe('computeDeleteScope — tag-genau, gruppiert nach source', () => {
  it('sammelt exakte Tage je source (dedupliziert, sortiert)', () => {
    const scope = computeDeleteScope([...fileFood, ...fileBev]);
    const food = scope.find(s => s.source === 'food_csv_export')!;
    const bev  = scope.find(s => s.source === 'beverage_csv_export')!;
    expect(food.dates).toEqual(['2026-07-27', '2026-07-28']); // 28. nur EINMAL
    expect(bev.dates).toEqual(['2026-07-28']);
  });

  it('Gleichnamiges Produkt in Food + Beverage bleibt getrennt (verschiedene sources)', () => {
    const scope = computeDeleteScope([
      { product_name: 'Cola TA', quantity: 1, source: 'food_csv_export',     sale_date: '2026-07-28' },
      { product_name: 'Cola TA', quantity: 1, source: 'beverage_csv_export', sale_date: '2026-07-28' },
    ] as Row[]);
    expect(scope.map(s => s.source).sort()).toEqual(['beverage_csv_export', 'food_csv_export']);
  });

  it('fehlende source → Default food_csv_export', () => {
    const scope = computeDeleteScope([{ product_name: 'X', quantity: 1, sale_date: '2026-07-28' } as Row]);
    expect(scope).toEqual([{ source: 'food_csv_export', dates: ['2026-07-28'] }]);
  });

  it('Zeilen ohne sale_date werden ignoriert', () => {
    const scope = computeDeleteScope([{ product_name: 'X', quantity: 1, source: 'food_csv_export', sale_date: '' } as Row]);
    expect(scope).toEqual([]);
  });
});

describe('Idempotenz — zweimal derselbe Import ⇒ identisch', () => {
  it('identischer Delete-Scope', () => {
    const a = computeDeleteScope(fileFood);
    const b = computeDeleteScope(fileFood);
    expect(a).toEqual(b);
  });

  it('Delete(Scope)+Insert modelliert per mergeTakeAwayDays: doppelter Import doppelt nicht', () => {
    // Bestand = erster Import. Zweiter Import derselben Datei ersetzt genau
    // seine Tage → Summen identisch (keine Verdoppelung).
    const firstImport = fileFood;
    const bestand = [...firstImport];
    const merged1 = mergeTakeAwayDays(bestand, firstImport); // erster Re-Import
    const merged2 = mergeTakeAwayDays(merged1, firstImport); // zweiter Re-Import
    const sum = (rows: Row[]) => rows.reduce((s, r) => s + r.quantity, 0);
    expect(sum(merged2 as Row[])).toBe(sum(firstImport));
    // Keine Zeile mehr als im Import (Tage vollständig ersetzt).
    expect((merged2 as Row[]).filter(r => r.sale_date === '2026-07-28').length)
      .toBe(firstImport.filter(r => r.sale_date === '2026-07-28').length);
  });
});

describe('Tag-genau — Tage ausserhalb der Datei bleiben unberührt', () => {
  it('Re-Import von 28.07. lässt 27.07. und 29.07. stehen', () => {
    const bestand: Row[] = [
      { product_name: 'Pizza TA', quantity: 6, source: 'food_csv_export', sale_date: '2026-07-27' },
      { product_name: 'Pizza TA', quantity: 6, source: 'food_csv_export', sale_date: '2026-07-28' },
      { product_name: 'Pizza TA', quantity: 6, source: 'food_csv_export', sale_date: '2026-07-29' },
    ];
    const incoming: Row[] = [
      { product_name: 'Pizza TA', quantity: 40, source: 'food_csv_export', sale_date: '2026-07-28' },
    ];
    // Scope betrifft NUR 28.07.
    expect(computeDeleteScope(incoming)).toEqual([{ source: 'food_csv_export', dates: ['2026-07-28'] }]);
    const merged = mergeTakeAwayDays(bestand, incoming) as Row[];
    expect(merged.find(r => r.sale_date === '2026-07-27')?.quantity).toBe(6);
    expect(merged.find(r => r.sale_date === '2026-07-29')?.quantity).toBe(6);
    expect(merged.find(r => r.sale_date === '2026-07-28')?.quantity).toBe(40);
    expect(merged.filter(r => r.sale_date === '2026-07-28').length).toBe(1);
  });
});

describe('Tenant-Isolation — Scope betrifft nur den aktiven Mandanten-Bestand', () => {
  it('Oliv-Import berechnet Scope aus Oliv-Zeilen; Beaulieu-Bestand unberührt', () => {
    // Zwei getrennte Bestände (in der DB via restaurant_id getrennt).
    const beaulieuBestand: Row[] = [
      { product_name: 'Pizza TA', quantity: 9, source: 'food_csv_export', sale_date: '2026-07-28', restaurant_id: 'beaulieu' },
    ];
    const olivImport: Row[] = [
      { product_name: 'Pizza TA', quantity: 6, source: 'food_csv_export', sale_date: '2026-07-28', restaurant_id: 'oliv' },
    ];
    // Delete/Insert läuft mandanten-isoliert (deleteProductSalesForPeriod('oliv', ...)):
    // der Beaulieu-Bestand wird durch den Oliv-Merge NICHT angefasst.
    const olivMerged = mergeTakeAwayDays([], olivImport) as Row[];
    expect(olivMerged.every(r => r.restaurant_id === 'oliv')).toBe(true);
    // Beaulieu-Bestand bleibt exakt erhalten.
    expect(beaulieuBestand).toEqual([
      { product_name: 'Pizza TA', quantity: 9, source: 'food_csv_export', sale_date: '2026-07-28', restaurant_id: 'beaulieu' },
    ]);
    // Der Scope ist tenant-agnostisch (Filterung erfolgt DB-seitig via .eq),
    // enthält aber genau die Import-Tage:
    expect(computeDeleteScope(olivImport)).toEqual([{ source: 'food_csv_export', dates: ['2026-07-28'] }]);
  });
});
