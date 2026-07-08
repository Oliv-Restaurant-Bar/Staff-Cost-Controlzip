// @vitest-environment node
/**
 * Tests für die reine OP-Listen-Vergleichslogik (zwei Stichtage) und die
 * Behörden-/Sozialabgaben-Gruppierung.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateSuppliers,
  buildAuthoritySummary,
  compareSnapshots,
  normalizeSupplierName,
  summarizeSnapshot,
  topSuppliers,
  type OpCompareItem,
} from '../op-liste-compare';

const item = (
  supplierName: string,
  openAmount: number,
  buckets?: OpCompareItem['buckets'],
): OpCompareItem => ({ supplierName, openAmount, buckets });

describe('normalizeSupplierName', () => {
  it('entfernt Konto-Nr.-Präfix, Case und Mehrfach-Whitespace', () => {
    expect(normalizeSupplierName('2000 Saviva AG')).toBe('saviva ag');
    expect(normalizeSupplierName('SAVIVA   AG ')).toBe('saviva ag');
    expect(normalizeSupplierName('Saviva AG')).toBe(normalizeSupplierName('2000 Saviva AG'));
  });
});

describe('aggregateSuppliers / summarizeSnapshot', () => {
  const items = [
    item('2000 Saviva AG', 1000, { overdue29Plus: 1000 }),
    item('Saviva AG', 500, { overdueSince14: 500 }),
    item('2100 Transgourmet', 200),
  ];

  it('aggregiert je Lieferant über den normalisierten Namen', () => {
    const aggs = aggregateSuppliers(items);
    expect(aggs).toHaveLength(2);
    expect(aggs[0].name).toBe('2000 Saviva AG');
    expect(aggs[0].amount).toBe(1500);
    expect(aggs[0].itemCount).toBe(2);
    expect(aggs[0].overdueAmount).toBe(1500);
    expect(aggs[1].overdueAmount).toBeNull(); // keine Bucket-Daten
  });

  it('summarizeSnapshot liefert KPIs inkl. Überfällig', () => {
    const s = summarizeSnapshot(items);
    expect(s.totalOpen).toBe(1700);
    expect(s.itemCount).toBe(3);
    expect(s.supplierCount).toBe(2);
    expect(s.overdueAmount).toBe(1500);
    expect(s.buckets.overdue29Plus).toBe(1000);
    expect(s.buckets.dueIn30).toBeNull();
  });

  it('overdueAmount ist null ohne jegliche Bucket-Daten', () => {
    expect(summarizeSnapshot([item('A', 100)]).overdueAmount).toBeNull();
  });

  it('topSuppliers sortiert nach Betrag', () => {
    expect(topSuppliers(items, 1)[0].name).toBe('2000 Saviva AG');
  });
});

describe('compareSnapshots', () => {
  const before = [
    item('Saviva AG', 1000),
    item('Transgourmet', 500),
    item('Weinhandlung Keller', 300),
    item('Bäckerei Muster', 200),
  ];
  const after = [
    item('2000 Saviva AG', 1400),   // gestiegen (+400), trotz Konto-Nr.-Präfix gematcht
    item('Transgourmet', 100),      // gesunken (−400)
    item('Weinhandlung Keller', 300), // unverändert
    item('Neuer Metzger', 250),     // neu
    // Bäckerei Muster fehlt → erledigt
  ];

  const r = compareSnapshots(before, after);

  it('vergibt die Status korrekt', () => {
    const byName = new Map(r.rows.map(row => [row.matchKey, row]));
    expect(byName.get('saviva ag')?.status).toBe('gestiegen');
    expect(byName.get('transgourmet')?.status).toBe('gesunken');
    expect(byName.get('weinhandlung keller')?.status).toBe('unveraendert');
    expect(byName.get('neuer metzger')?.status).toBe('neu');
    expect(byName.get('bäckerei muster')?.status).toBe('erledigt');
    expect(byName.get('bäckerei muster')?.after).toBeNull();
    expect(byName.get('neuer metzger')?.before).toBeNull();
  });

  it('sortiert höchste Erhöhung zuerst', () => {
    expect(r.rows[0].matchKey).toBe('saviva ag');       // +400
    expect(r.rows[1].matchKey).toBe('neuer metzger');   // +250
    expect(r.rows[r.rows.length - 1].matchKey).toBe('transgourmet'); // −400
  });

  it('berechnet KPI-Deltas', () => {
    expect(r.totalOpen.before).toBe(2000);
    expect(r.totalOpen.after).toBe(2050);
    expect(r.totalOpen.diff).toBe(50);
    expect(r.supplierCount.diff).toBe(0);
    expect(r.itemCount.before).toBe(4);
    expect(r.overdueAmount.diff).toBeNull(); // keine Bucket-Daten
  });

  it('Cent-Rauschen (≤0.005) gilt als unverändert', () => {
    const rr = compareSnapshots([item('A', 100)], [item('A', 100.004)]);
    expect(rr.rows[0].status).toBe('unveraendert');
  });
});

describe('buildAuthoritySummary (Behörden & Sozialabgaben)', () => {
  const before = [
    item('2500 Eidgenössische Steuerverwaltung', 8000),
    item('2510 Steuerverwaltung des Kantons Bern', 1200),
    item('2520 GastroSocial Ausgleichskasse', 5000),
    item('2530 GastroSocial Pensionskasse', 3000),
    item('Saviva AG', 999),
  ];
  const after = [
    item('Eidgenössische Steuerverwaltung', 9000),
    item('GastroSocial Ausgleichskasse', 4000),
    // QST + BVG bezahlt → fehlen
  ];

  const rows = buildAuthoritySummary(before, after);
  const byKey = new Map(rows.map(r => [r.key, r]));

  it('ordnet alle vier Gruppen zu (MWST/QST/AHV/BVG)', () => {
    expect(rows.map(r => r.key)).toEqual(['MWST', 'QST', 'AHV', 'BVG']);
    expect(byKey.get('MWST')?.before).toBe(8000);
    expect(byKey.get('MWST')?.after).toBe(9000);
    expect(byKey.get('MWST')?.diff).toBe(1000);
    expect(byKey.get('AHV')?.diff).toBe(-1000);
  });

  it('fehlende Behörde im Nachher-Stichtag → after null, diff = −before', () => {
    expect(byKey.get('QST')?.before).toBe(1200);
    expect(byKey.get('QST')?.after).toBeNull();
    expect(byKey.get('QST')?.diff).toBe(-1200);
    expect(byKey.get('BVG')?.diff).toBe(-3000);
  });

  it('normale Lieferanten fallen in keine Gruppe', () => {
    const rr = buildAuthoritySummary([item('Saviva AG', 999)], []);
    expect(rr.every(row => row.before === null && row.after === null)).toBe(true);
  });
});
