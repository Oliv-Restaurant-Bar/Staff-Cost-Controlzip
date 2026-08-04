// @vitest-environment node
/**
 * Regression tests for the Gastronovi CSV parser duplicate-name handling.
 *
 * Background (root cause):
 *   `matchAnzahlUmsatz` used to (A) build the Umsatz lookup with `Map.set(name, row)`
 *   which silently DROPPED earlier Umsatz lines when a product name appeared more
 *   than once (lost revenue), and (B) iterate each Anzahl line separately so two
 *   lines sharing a name emitted TWO product_sales records for the same
 *   (product, date) — inflating quantity and double-counting the surviving Umsatz.
 *
 * Fix: both Anzahl and Umsatz lines are now aggregated per normalized product name
 *   (day values summed) and exactly ONE record is emitted per (product, date).
 *
 * These tests exercise the four duplicate scenarios plus the real
 * "Pizza Prosciutto TA" shape that triggered the bug.
 */
import { describe, it, expect } from 'vitest';
import {
  matchAnzahlUmsatz,
  headerToIsoDate,
  saleDateRange,
  type ParseResult,
  type ParsedWideRow,
} from '../gastronovi-csv-parser';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function row(productName: string, dayValues: Record<string, number>): ParsedWideRow {
  return { productName, dayValues, rawValues: {} };
}

function parseResult(rows: ParsedWideRow[], dateColumns: string[]): ParseResult {
  return { rows, dateColumns, skippedRows: [], warningRows: [], rawLineCount: rows.length };
}

const YEAR = 2026;
const META = { source: 'test', importBatch: 'test-batch' };

function match(anzahlRows: ParsedWideRow[], umsatzRows: ParsedWideRow[], dateCols: string[]) {
  return matchAnzahlUmsatz(
    parseResult(anzahlRows, dateCols),
    parseResult(umsatzRows, dateCols),
    YEAR,
    'food',
    META,
  );
}

function rowsFor(result: ReturnType<typeof match>, name: string, isoDate: string) {
  return result.rows.filter(r => r.product_name === name && r.sale_date === isoDate);
}

// ─── 1. Duplicate Umsatz rows ────────────────────────────────────────────────

describe('matchAnzahlUmsatz – duplicate Umsatz rows', () => {
  it('sums revenue across duplicate Umsatz lines (no Map.set overwrite)', () => {
    const anzahl = [row('Cola', { '19.06.': 10 })];
    // Two Umsatz lines for the SAME product on the same day — must be summed, not overwritten.
    const umsatz = [
      row('Cola', { '19.06.': 30 }),
      row('Cola', { '19.06.': 50 }),
    ];
    const res = match(anzahl, umsatz, ['19.06.']);

    const out = rowsFor(res, 'Cola', '2026-06-19');
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBe(10);
    expect(out[0].revenue).toBe(80); // 30 + 50, NOT 50 (last-write) and NOT dropped
    expect(res.duplicateProducts).toContain('Cola');
  });

  it('keeps revenue from a full-period Umsatz line that would previously be dropped', () => {
    // Mirrors the real bug: a full-month main line + a short same-name line.
    const anzahl = [row('Pizza', { '01.06.': 5, '19.06.': 8 })];
    const umsatz = [
      row('Pizza', { '01.06.': 50, '19.06.': 80 }), // main line (would be overwritten before)
      row('Pizza', { '19.06.': 32 }),               // short line (the surviving one before)
    ];
    const res = match(anzahl, umsatz, ['01.06.', '19.06.']);

    // The full-period revenue on 01.06. must survive (was zeroed by the old bug).
    expect(rowsFor(res, 'Pizza', '2026-06-01')[0].revenue).toBe(50);
    expect(rowsFor(res, 'Pizza', '2026-06-19')[0].revenue).toBe(112); // 80 + 32
  });
});

// ─── 2. Duplicate Anzahl rows ────────────────────────────────────────────────

describe('matchAnzahlUmsatz – duplicate Anzahl rows', () => {
  it('merges duplicate Anzahl lines into one record per date (no inflated duplicate records)', () => {
    const anzahl = [
      row('Burger', { '19.06.': 15 }),
      row('Burger', { '19.06.': 5 }),
    ];
    const umsatz = [row('Burger', { '19.06.': 200 })];
    const res = match(anzahl, umsatz, ['19.06.']);

    const out = rowsFor(res, 'Burger', '2026-06-19');
    expect(out).toHaveLength(1);          // exactly ONE record, not two
    expect(out[0].quantity).toBe(20);     // 15 + 5
    expect(out[0].revenue).toBe(200);     // revenue counted once, not doubled
    expect(res.duplicateProducts).toContain('Burger');
  });
});

// ─── 3. Duplicate Umsatz + duplicate Anzahl rows ─────────────────────────────

describe('matchAnzahlUmsatz – duplicate Umsatz AND Anzahl rows', () => {
  it('aggregates both sides and emits a single record per date', () => {
    const anzahl = [
      row('Pasta', { '20.06.': 3, '21.06.': 4 }),
      row('Pasta', { '20.06.': 13, '21.06.': 2 }),
    ];
    const umsatz = [
      row('Pasta', { '20.06.': 30, '21.06.': 40 }),
      row('Pasta', { '20.06.': 208, '21.06.': 64 }),
    ];
    const res = match(anzahl, umsatz, ['20.06.', '21.06.']);

    expect(res.rows.filter(r => r.product_name === 'Pasta')).toHaveLength(2); // one per date

    const d20 = rowsFor(res, 'Pasta', '2026-06-20')[0];
    expect(d20.quantity).toBe(16);   // 3 + 13
    expect(d20.revenue).toBe(238);   // 30 + 208

    const d21 = rowsFor(res, 'Pasta', '2026-06-21')[0];
    expect(d21.quantity).toBe(6);    // 4 + 2
    expect(d21.revenue).toBe(104);   // 40 + 64
  });
});

// ─── 4. Product name appearing multiple times across the export ───────────────

describe('matchAnzahlUmsatz – product appears on multiple lines', () => {
  it('never emits two records for the same (product, date) and flags the duplicate', () => {
    const anzahl = [
      row('Wasser', { '01.06.': 4, '02.06.': 6 }),
      row('Wasser', { '02.06.': 1, '03.06.': 9 }), // overlaps on 02.06.
    ];
    const umsatz = [
      row('Wasser', { '01.06.': 16, '02.06.': 24 }),
      row('Wasser', { '02.06.': 4, '03.06.': 36 }),
    ];
    const res = match(anzahl, umsatz, ['01.06.', '02.06.', '03.06.']);

    // No (product, date) duplicates anywhere.
    const seen = new Set<string>();
    for (const r of res.rows) {
      const k = `${r.product_name}|${r.sale_date}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }

    expect(rowsFor(res, 'Wasser', '2026-06-02')[0].quantity).toBe(7); // 6 + 1
    expect(rowsFor(res, 'Wasser', '2026-06-02')[0].revenue).toBe(28); // 24 + 4
    expect(res.duplicateProducts).toContain('Wasser');
    expect(res.rows.filter(r => r.product_name === 'Wasser')).toHaveLength(3);
  });

  it('does not flag products that appear only once', () => {
    const res = match(
      [row('Salat', { '01.06.': 2 })],
      [row('Salat', { '01.06.': 18 })],
      ['01.06.'],
    );
    expect(res.duplicateProducts).toEqual([]);
    expect(rowsFor(res, 'Salat', '2026-06-01')[0]).toMatchObject({ quantity: 2, revenue: 18 });
  });
});

// ─── 5. Pizza Prosciutto TA real-shape scenario ──────────────────────────────

describe('matchAnzahlUmsatz – Pizza Prosciutto TA shape', () => {
  // Reconstructed shape: a full-period 10-CHF main article (line A) plus a short
  // 16-CHF same-name article (line B) on 19/20/21. The old bug dropped line A's
  // revenue (Map.set) and doubled the surviving line B revenue across duplicate rows.
  const dateCols = ['01.06.', '02.06.', '19.06.', '20.06.', '21.06.', '24.06.'];

  const anzahlA = row('Pizza Prosciutto TA', {
    '01.06.': 25, '02.06.': 13, '19.06.': 15, '20.06.': 3, '21.06.': 2, '24.06.': 21,
  });
  const anzahlB = row('Pizza Prosciutto TA', { '19.06.': 5, '20.06.': 13, '21.06.': 4 });

  const umsatzA = row('Pizza Prosciutto TA', {
    '01.06.': 250, '02.06.': 130, '19.06.': 150, '20.06.': 30, '21.06.': 20, '24.06.': 210,
  });
  const umsatzB = row('Pizza Prosciutto TA', { '19.06.': 80, '20.06.': 208, '21.06.': 64 });

  it('emits exactly one record per date with summed qty and revenue', () => {
    const res = match([anzahlA, anzahlB], [umsatzA, umsatzB], dateCols);
    const pizza = res.rows.filter(r => r.product_name === 'Pizza Prosciutto TA');

    // One row per active date (6 dates), no duplicates.
    expect(pizza).toHaveLength(6);
    for (const d of ['2026-06-01', '2026-06-02', '2026-06-19', '2026-06-20', '2026-06-21', '2026-06-24']) {
      expect(rowsFor(res, 'Pizza Prosciutto TA', d)).toHaveLength(1);
    }
  });

  it('recovers the dropped full-period revenue (full-month days are no longer zero)', () => {
    const res = match([anzahlA, anzahlB], [umsatzA, umsatzB], dateCols);
    expect(rowsFor(res, 'Pizza Prosciutto TA', '2026-06-01')[0].revenue).toBe(250);
    expect(rowsFor(res, 'Pizza Prosciutto TA', '2026-06-24')[0].revenue).toBe(210);
  });

  it('sums both same-name articles on the overlapping days (no double-count of a single line)', () => {
    const res = match([anzahlA, anzahlB], [umsatzA, umsatzB], dateCols);

    const d19 = rowsFor(res, 'Pizza Prosciutto TA', '2026-06-19')[0];
    expect(d19.quantity).toBe(20);  // 15 + 5
    expect(d19.revenue).toBe(230);  // 150 + 80

    const d20 = rowsFor(res, 'Pizza Prosciutto TA', '2026-06-20')[0];
    expect(d20.quantity).toBe(16);  // 3 + 13
    expect(d20.revenue).toBe(238);  // 30 + 208

    const d21 = rowsFor(res, 'Pizza Prosciutto TA', '2026-06-21')[0];
    expect(d21.quantity).toBe(6);   // 2 + 4
    expect(d21.revenue).toBe(84);   // 20 + 64
  });

  it('totals match the sum of both source lines (qty 101 / rev 1142 for this fixture)', () => {
    const res = match([anzahlA, anzahlB], [umsatzA, umsatzB], dateCols);
    const pizza = res.rows.filter(r => r.product_name === 'Pizza Prosciutto TA');
    const totalQty = pizza.reduce((s, r) => s + r.quantity, 0);
    const totalRev = pizza.reduce((s, r) => s + r.revenue, 0);
    expect(totalQty).toBe(25 + 13 + 20 + 16 + 6 + 21);      // 101
    expect(totalRev).toBe(250 + 130 + 230 + 238 + 84 + 210); // 1142
    expect(res.duplicateProducts).toContain('Pizza Prosciutto TA');
  });
});

// ─── Behaviour preserved: unmatched products ─────────────────────────────────

describe('matchAnzahlUmsatz – unmatched products (unchanged behaviour)', () => {
  it('imports Anzahl-only products with revenue 0 and lists them as unmatched', () => {
    const res = match([row('NurMenge', { '01.06.': 3 })], [], ['01.06.']);
    expect(rowsFor(res, 'NurMenge', '2026-06-01')[0]).toMatchObject({ quantity: 3, revenue: 0 });
    expect(res.unmatchedProducts).toContain('NurMenge');
  });

  it('flags Umsatz-only products as "(nur in Umsatz)" and does not import them', () => {
    const res = match([], [row('NurUmsatz', { '01.06.': 99 })], ['01.06.']);
    expect(res.rows).toHaveLength(0);
    expect(res.unmatchedProducts.some(p => p.includes('NurUmsatz'))).toBe(true);
  });
});

// ─── Jahr-Datierung der «TT.MM.»-Spalten ──────────────────────────────────────

describe('headerToIsoDate — gewähltes Jahr fliesst in die Datierung ein', () => {
  it('datiert «01.03.» mit dem übergebenen Jahr', () => {
    expect(headerToIsoDate('01.03.', 2025)).toBe('2025-03-01');
    expect(headerToIsoDate('01.03.', 2023)).toBe('2023-03-01');
  });
  it('akzeptiert Header ohne abschliessenden Punkt', () => {
    expect(headerToIsoDate('9.7', 2024)).toBe('2024-07-09');
  });
  it('Nicht-Datums-Header → null', () => {
    expect(headerToIsoDate('Bezeichnung', 2025)).toBeNull();
    expect(headerToIsoDate('', 2025)).toBeNull();
  });
  it('dasselbe Datum ergibt unterschiedliche ISO-Daten je Jahr (kein globaler Zustand)', () => {
    expect(headerToIsoDate('15.06.', 2024)).not.toBe(headerToIsoDate('15.06.', 2025));
  });
});

describe('saleDateRange — datierter Zeitraum (Vorschau)', () => {
  it('ermittelt min/max über datierte Zeilen', () => {
    const rows = [
      { sale_date: '2025-03-15' },
      { sale_date: '2025-03-01' },
      { sale_date: '2025-03-31' },
    ];
    expect(saleDateRange(rows)).toEqual({ from: '2025-03-01', to: '2025-03-31' });
  });
  it('ignoriert leere/ungültige Daten', () => {
    const rows = [
      { sale_date: '' },
      { sale_date: null },
      { sale_date: 'kaputt' },
      { sale_date: '2025-07-10' },
    ];
    expect(saleDateRange(rows)).toEqual({ from: '2025-07-10', to: '2025-07-10' });
  });
  it('leere Eingabe → { from: null, to: null }', () => {
    expect(saleDateRange([])).toEqual({ from: null, to: null });
  });
  it('folgt dem gewählten Jahr (Datierung via headerToIsoDate)', () => {
    const headers = ['01.03.', '28.02.', '15.03.'];
    const rows2025 = headers.map(h => ({ sale_date: headerToIsoDate(h, 2025)! }));
    const rows2023 = headers.map(h => ({ sale_date: headerToIsoDate(h, 2023)! }));
    expect(saleDateRange(rows2025)).toEqual({ from: '2025-02-28', to: '2025-03-15' });
    expect(saleDateRange(rows2023)).toEqual({ from: '2023-02-28', to: '2023-03-15' });
  });
});
