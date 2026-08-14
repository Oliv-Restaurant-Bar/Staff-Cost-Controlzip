// @vitest-environment happy-dom
/**
 * Hierarchischer Gastronovi-Export («> »-Detailzeilen) — Dreifachzählung:
 *  - Kategorie-Summenzeilen (Beverage (Getränke), Food (Speisen), Gesamt)
 *    werden komplett übersprungen (Summen ihrer «> »-Kinder).
 *  - Trinkgeld/Non-Foods haben keine Kinder → Blattwerte, zählen einmal.
 *  - Doppelte «> »-Produkte werden pro Tag summiert (bestehende Regel).
 *  - Paar-übergreifende Dubletten (Trinkgeld in Food- UND Beverage-Paar)
 *    fliessen genau einmal ein (dedupeAcrossPairs, Food gewinnt).
 */
import { describe, it, expect } from 'vitest';
import {
  parseWideFile, matchAnzahlUmsatz, dedupeAcrossPairs,
  type NormalizedSaleRow,
} from '@/lib/gastronovi-csv-parser';

function mkFile(lines: string[], name = 'test.csv'): File {
  return new File([lines.join('\n')], name, { type: 'text/csv' });
}

const HEAD = 'Bezeichnung\tZeitraum\t01.08.\t02.08.';

describe('hierarchischer Export — nur Blatt-Produktzeilen', () => {
  it('überspringt Kategorie-Summen und Gesamt, zählt Details und Blatt-Ausnahmen', async () => {
    const file = mkFile([
      HEAD,
      'Beverage (Getränke)\t\t10\t20',
      '> Espresso\t\t6\t12',
      '> Cola\t\t4\t8',
      'Food (Speisen)\t\t5\t7',
      '> Pizza\t\t5\t7',
      'Trinkgeld\t\t1\t0',
      'Non-Foods (Nichtlebensmittel)\t\t2\t0',
      'Gesamt\t\t18\t27',
    ]);
    const res = await parseWideFile(file);
    const names = res.rows.map(r => r.productName).sort();
    expect(names).toEqual(['Cola', 'Espresso', 'Non-Foods (Nichtlebensmittel)', 'Pizza', 'Trinkgeld']);
    expect(res.skippedRows).toContain('Beverage (Getränke)');
    expect(res.skippedRows).toContain('Food (Speisen)');
    expect(res.skippedRows).toContain('Gesamt');
    // «> »-Präfix ist entfernt
    expect(names.every(n => !n.startsWith('>'))).toBe(true);
  });

  it('Faktor 1.0: Summe der importierten Zeilen = Gesamtzeile der Datei', async () => {
    const file = mkFile([
      HEAD,
      'Beverage (Getränke)\t\t10\t20',
      '> Espresso\t\t6\t12',
      '> Cola\t\t4\t8',
      'Food (Speisen)\t\t5\t7',
      '> Pizza\t\t5\t7',
      'Trinkgeld\t\t1\t0',
      'Gesamt\t\t16\t27',
    ]);
    const res = await parseWideFile(file);
    let sum = 0;
    for (const r of res.rows) for (const v of Object.values(r.dayValues)) sum += v;
    expect(sum).toBe(16 + 27); // = Gesamtzeile, nicht 3×
  });

  it('doppelte «> »-Produkte werden pro Tag zusammengeführt', async () => {
    const anzahl = await parseWideFile(mkFile([
      HEAD,
      'Food (Speisen)\t\t8\t0',
      '> Fischknusperli\t\t3\t0',
      '> Fischknusperli\t\t5\t0',
    ]));
    const umsatz = await parseWideFile(mkFile([
      HEAD,
      'Food (Speisen)\t\t320\t0',
      '> Fischknusperli\t\t120\t0',
      '> Fischknusperli\t\t200\t0',
    ]));
    const m = matchAnzahlUmsatz(anzahl, umsatz, 2026, 'food', { source: 's', importBatch: 'b', anzahlFileName: 'a', umsatzFileName: 'u' });
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0].product_name).toBe('Fischknusperli');
    expect(m.rows[0].quantity).toBe(8);
    expect(m.rows[0].revenue).toBe(320);
    expect(m.duplicateProducts).toContain('Fischknusperli');
  });

  it('nicht-hierarchische Dateien (Altformat) bleiben unverändert', async () => {
    const res = await parseWideFile(mkFile([
      HEAD,
      'Pizza Prosciutto\t\t3\t4',
      'Espresso\t\t5\t6',
    ]));
    expect(res.rows.map(r => r.productName).sort()).toEqual(['Espresso', 'Pizza Prosciutto']);
  });
});

describe('dedupeAcrossPairs — jedes Produkt genau einmal pro Tag', () => {
  const row = (name: string, date: string, q: number, rev: number): NormalizedSaleRow =>
    ({ product_name: name, sale_date: date, quantity: q, revenue: rev });

  it('entfernt Paar-Dubletten (Trinkgeld/Non-Foods), Food gewinnt', () => {
    const food = [row('Pizza', '2026-08-01', 5, 150), row('Trinkgeld', '2026-08-01', 1, 4)];
    const bev = [row('Espresso', '2026-08-01', 6, 28.2), row('Trinkgeld', '2026-08-01', 1, 4)];
    const { rows, removed } = dedupeAcrossPairs(food, bev);
    expect(rows).toHaveLength(1);
    expect(rows[0].product_name).toBe('Espresso');
    expect(removed).toEqual(['Trinkgeld']);
  });

  it('NUR Blatt-Ausnahmen werden dedupliziert — namensgleiche echte Produkte bleiben', () => {
    // Ein echtes Food- und ein echtes Beverage-Produkt mit zufällig gleichem
    // Namen am selben Tag dürfen NICHT verschmolzen/verworfen werden.
    const food = [row('Hausmischung', '2026-08-01', 5, 60)];
    const bev = [row('Hausmischung', '2026-08-01', 8, 40)];
    const { rows, removed } = dedupeAcrossPairs(food, bev);
    expect(rows).toHaveLength(1);
    expect(removed).toEqual([]);
  });

  it('gleicher Name an ANDEREM Tag bleibt erhalten', () => {
    const food = [row('Trinkgeld', '2026-08-01', 1, 4)];
    const bev = [row('Trinkgeld', '2026-08-02', 2, 8)];
    const { rows, removed } = dedupeAcrossPairs(food, bev);
    expect(rows).toHaveLength(1);
    expect(removed).toEqual([]);
  });
});
