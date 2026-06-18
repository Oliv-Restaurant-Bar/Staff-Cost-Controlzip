// @vitest-environment node
/**
 * Test: Gastronovi Durchschnittsbon-Bericht Parser
 * =================================================
 * Deckt das Wide-Format ab: Datums-Spalten (01.06, 02.06 …) plus eine
 * "Durchschnitt"-Zeile mit "CHF 54.07" / "CHF 54,07". Jeder Tageswert wird zu
 * einem eigenen Datensatz. Geprüft werden:
 *   - CHF mit Punkt und Komma als Dezimaltrenner
 *   - Jahr aus Zeitraum-Zeile / Dateiname / Header
 *   - mean / min / max
 *   - leere Tage (Ruhetage) werden übersprungen
 *   - Fallback, wenn keine "Durchschnitt"-Zeile vorhanden ist
 *   - Geldbeträge in der Kopfzeile werden NICHT als Datum erkannt
 */
import { describe, it, expect } from 'vitest';
import { parseGnAverageCheck } from '@/lib/gn-average-check-parser';

describe('Durchschnittsbon Parser — Grundformat', () => {
  it('liest Tageswerte mit CHF + Punkt-Dezimaltrenner', () => {
    const csv = [
      'Zeitraum;01.06.2026 - 03.06.2026',
      'Datum;01.06;02.06;03.06',
      'Durchschnitt;CHF 54.07;CHF 60.00;CHF 48.50',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'durchschnittsbon.csv');

    expect(r.rows.length).toBe(3);
    expect(r.rows[0].date).toBe('2026-06-01');
    expect(r.rows[0].averageCheck).toBeCloseTo(54.07, 2);
    expect(r.rows[1].averageCheck).toBeCloseTo(60.0, 2);
    expect(r.rows[2].averageCheck).toBeCloseTo(48.5, 2);
    expect(r.rows[0].currency).toBe('CHF');
  });

  it('liest CHF mit Komma-Dezimaltrenner', () => {
    const csv = [
      'Zeitraum;01.06.2026 - 02.06.2026',
      'Datum;01.06;02.06',
      'Durchschnitt;CHF 54,07;CHF 60,90',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'x.csv');

    expect(r.rows.length).toBe(2);
    expect(r.rows[0].averageCheck).toBeCloseTo(54.07, 2);
    expect(r.rows[1].averageCheck).toBeCloseTo(60.9, 2);
  });

  it('berechnet mean / min / max korrekt', () => {
    const csv = [
      'Zeitraum;01.06.2026 - 03.06.2026',
      'Datum;01.06;02.06;03.06',
      'Durchschnitt;CHF 40.00;CHF 50.00;CHF 60.00',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'x.csv');

    expect(r.averageMean).toBeCloseTo(50.0, 2);
    expect(r.averageMin).toBeCloseTo(40.0, 2);
    expect(r.averageMax).toBeCloseTo(60.0, 2);
    expect(r.rowCount).toBe(3);
  });
});

describe('Durchschnittsbon Parser — Datum & Jahr', () => {
  it('bezieht das Jahr aus der Zeitraum-Zeile', () => {
    const csv = [
      'Zeitraum;01.12.2025 - 02.12.2025',
      'Datum;01.12;02.12',
      'Durchschnitt;CHF 50.00;CHF 55.00',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'keine-jahreszahl.csv');

    expect(r.rows[0].date).toBe('2025-12-01');
    expect(r.rows[1].date).toBe('2025-12-02');
    expect(r.periodFrom).toBe('2025-12-01');
    expect(r.periodTo).toBe('2025-12-02');
  });

  it('leitet periodFrom/periodTo aus den Tageswerten ab (robust gegen abgekürzte Zeitraum-Angaben)', () => {
    // "01.06.-30.06.2026" enthält nur EIN vollständiges Datum (30.06.2026).
    // periodFrom darf trotzdem NICHT auf den 30.06. fallen, sondern muss dem
    // ersten tatsächlichen Tageswert entsprechen.
    const csv = [
      'Zeitraum;01.06.-30.06.2026',
      'Datum;01.06;02.06;30.06',
      'Durchschnitt;CHF 54.07;CHF 60.00;CHF 48.50',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'x.csv');

    expect(r.periodFrom).toBe('2026-06-01');
    expect(r.periodTo).toBe('2026-06-30');
    expect(r.rows[0].date).toBe('2026-06-01');
  });

  it('akzeptiert volle Datums-Header inkl. Jahr', () => {
    const csv = [
      'Datum;01.06.2024;02.06.2024',
      'Durchschnitt;CHF 50.00;CHF 55.00',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'x.csv');

    expect(r.rows[0].date).toBe('2024-06-01');
    expect(r.rows[1].date).toBe('2024-06-02');
  });

  it('erkennt Geldbeträge in der Kopfzeile NICHT als Datum', () => {
    const csv = [
      'Zeitraum;01.06.2026 - 02.06.2026',
      'Datum;01.06;02.06',
      'Durchschnitt;CHF 54.07;CHF 60.00',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'x.csv');

    // Genau zwei Tageswerte — die CHF-Zellen dürfen keine zusätzlichen
    // Datumsspalten erzeugen.
    expect(r.rows.length).toBe(2);
  });
});

describe('Durchschnittsbon Parser — Sonderfälle', () => {
  it('überspringt leere Tage (Ruhetage)', () => {
    const csv = [
      'Zeitraum;01.06.2026 - 03.06.2026',
      'Datum;01.06;02.06;03.06',
      'Durchschnitt;CHF 54.07;;CHF 48.50',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'x.csv');

    expect(r.rows.length).toBe(2);
    expect(r.rows.map(x => x.date)).toEqual(['2026-06-01', '2026-06-03']);
    expect(r.warnings.some(w => /leere Tag/i.test(w))).toBe(true);
  });

  it('nutzt Fallback-Zeile, wenn keine "Durchschnitt"-Zeile existiert', () => {
    const csv = [
      'Zeitraum;01.06.2026 - 02.06.2026',
      'Datum;01.06;02.06',
      'Ø Bon;CHF 54.07;CHF 60.00',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'x.csv');

    expect(r.rows.length).toBe(2);
    expect(r.warnings.some(w => /nicht eindeutig/i.test(w))).toBe(true);
  });

  it('gibt ein leeres Ergebnis zurück, wenn keine Datums-Spalten vorhanden sind', () => {
    const csv = [
      'Bericht;Irgendwas',
      'Total;CHF 1234.00',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'x.csv');

    expect(r.rows.length).toBe(0);
    expect(r.rowCount).toBe(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('sortiert Tageswerte chronologisch', () => {
    const csv = [
      'Zeitraum;01.06.2026 - 03.06.2026',
      'Datum;03.06;01.06;02.06',
      'Durchschnitt;CHF 48.50;CHF 54.07;CHF 60.00',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'x.csv');

    expect(r.rows.map(x => x.date)).toEqual([
      '2026-06-01', '2026-06-02', '2026-06-03',
    ]);
  });
});

describe('Durchschnittsbon Parser — echte Datei (Wide mit Zeitraum-Spalte)', () => {
  // Reproduktion des realen Exports "Durchschnittsbon(1).csv":
  //   Kopf : Bezeichnung;Zeitraum;01.06.;02.06.;…;17.06.
  //   Wert : Durchschnitt;CHF 54,07;CHF 45,22;CHF 55,52;…
  // Der Wert unter "Zeitraum" (54,07) ist der Gesamt-Durchschnitt und darf
  // NICHT als Tageswert zählen — die Tageswerte beginnen erst bei 01.06.
  const dayHeaders = Array.from({ length: 17 }, (_, i) => `${String(i + 1).padStart(2, '0')}.06.`);
  const dayValues = [
    45.22, 55.52, 50.10, 52.30, 58.90, 61.20, 49.80, 53.40, 47.60,
    55.00, 56.70, 59.10, 62.40, 51.30, 48.20, 54.90, 57.80,
  ];
  const fmt = (n: number) => `CHF ${n.toFixed(2).replace('.', ',')}`;

  it('erkennt alle 17 Tage (01.06–17.06) und überspringt den Gesamt-Durchschnitt', () => {
    const header = ['Bezeichnung', 'Zeitraum', ...dayHeaders].map(c => `"${c}"`).join(';');
    const row = ['Durchschnitt', fmt(54.07), ...dayValues.map(fmt)].map(c => `"${c}"`).join(';');
    const csv = [header, row].join('\n');

    const r = parseGnAverageCheck(csv, 'Durchschnittsbon(1).csv');
    const y = new Date().getFullYear();

    expect(r.debug.detectedFormat).toBe('wide');
    expect(r.rows.length).toBe(17);
    expect(r.rows[0].date).toBe(`${y}-06-01`);
    expect(r.rows[0].averageCheck).toBeCloseTo(45.22, 2);
    expect(r.rows[1].averageCheck).toBeCloseTo(55.52, 2);
    expect(r.rows[16].date).toBe(`${y}-06-17`);
    expect(r.rows[16].averageCheck).toBeCloseTo(57.80, 2);
    // Gesamt-Durchschnitt 54,07 darf NICHT als Tageswert auftauchen.
    expect(r.rows.some(x => Math.abs(x.averageCheck - 54.07) < 1e-6)).toBe(false);
  });

  it('verwendet das aktuelle Jahr als Fallback und meldet es in der Diagnose', () => {
    const header = ['Bezeichnung', 'Zeitraum', '01.06.', '02.06.'].join(';');
    const row = ['Durchschnitt', fmt(54.07), fmt(45.22), fmt(55.52)].join(';');
    const r = parseGnAverageCheck([header, row].join('\n'), 'Durchschnittsbon(1).csv');

    expect(r.debug.usedYear).toBe(new Date().getFullYear());
    expect(r.debug.usedYearSource).toBe('aktuelles Jahr');
    expect(r.warnings.some(w => /Kein Jahr/i.test(w))).toBe(true);
  });

  it('leitet das Jahr aus dem Dateinamen ab, wenn die Header keines tragen', () => {
    const header = ['Bezeichnung', 'Zeitraum', '01.06.', '02.06.'].join(';');
    const row = ['Durchschnitt', 'CHF 54,07', 'CHF 45,22', 'CHF 55,52'].join(';');
    const r = parseGnAverageCheck([header, row].join('\n'), 'Durchschnittsbon_2024.csv');

    expect(r.rows[0].date).toBe('2024-06-01');
    expect(r.debug.usedYear).toBe(2024);
    expect(r.debug.usedYearSource).toBe('Dateiname');
  });

  it('füllt die Diagnosefelder Layout / skippedEmptyColumns', () => {
    const header = ['Bezeichnung', 'Zeitraum', '01.06.', '02.06.', '03.06.'].join(';');
    const row = ['Durchschnitt', 'CHF 54,07', 'CHF 45,22', '', 'CHF 50,10'].join(';');
    const r = parseGnAverageCheck([header, row].join('\n'), 'Durchschnittsbon(1).csv');

    expect(r.debug.detectedFormat).toBe('wide');
    expect(r.debug.skippedEmptyColumns).toBe(1);
    expect(r.rows.length).toBe(2);
  });
});

describe('Durchschnittsbon Parser — Langformat (eine Zeile pro Tag)', () => {
  it('liest das Langformat mit Header "Datum;Durchschnitt"', () => {
    const csv = [
      'Datum;Durchschnitt',
      '01.06.2026;CHF 45,22',
      '02.06.2026;CHF 55,52',
      '03.06.2026;CHF 50,10',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'vertical.csv');

    expect(r.debug.detectedFormat).toBe('vertical');
    expect(r.rows.length).toBe(3);
    expect(r.rows[0].date).toBe('2026-06-01');
    expect(r.rows[0].averageCheck).toBeCloseTo(45.22, 2);
    expect(r.rows[2].averageCheck).toBeCloseTo(50.10, 2);
  });

  it('wählt im Langformat die Durchschnitt-Spalte aus mehreren Wertspalten', () => {
    const csv = [
      'Datum;Umsatz;Durchschnitt',
      '01.06.2026;CHF 5000,00;CHF 45,22',
      '02.06.2026;CHF 6100,00;CHF 55,52',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'x.csv');

    expect(r.rows.length).toBe(2);
    expect(r.rows[0].averageCheck).toBeCloseTo(45.22, 2);
    expect(r.rows[1].averageCheck).toBeCloseTo(55.52, 2);
  });

  it('liest Langformat ohne Header (Datum;Wert)', () => {
    const csv = [
      '01.06.2026;CHF 45,22',
      '02.06.2026;CHF 55,52',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'x.csv');

    expect(r.debug.detectedFormat).toBe('vertical');
    expect(r.rows.length).toBe(2);
    expect(r.rows[0].date).toBe('2026-06-01');
  });

  it('überspringt leere Tage auch im Langformat', () => {
    const csv = [
      'Datum;Durchschnitt',
      '01.06.2026;CHF 45,22',
      '02.06.2026;',
      '03.06.2026;CHF 50,10',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'x.csv');

    expect(r.rows.map(x => x.date)).toEqual(['2026-06-01', '2026-06-03']);
    expect(r.debug.skippedEmptyColumns).toBe(1);
  });
});

describe('Durchschnittsbon Parser — Jahres-Rollover (Dez → Jan, ohne Jahr)', () => {
  it('rollt im Wide-Format über den Jahreswechsel', () => {
    const csv = [
      'Datum;30.12;31.12;01.01',
      'Durchschnitt;CHF 50,00;CHF 55,00;CHF 60,00',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'jahreswechsel.csv');
    const y = new Date().getFullYear();

    expect(r.rows.map(x => x.date)).toEqual([
      `${y}-12-30`, `${y}-12-31`, `${y + 1}-01-01`,
    ]);
  });

  it('rollt im Langformat über den Jahreswechsel', () => {
    const csv = [
      'Datum;Durchschnitt',
      '30.12;CHF 50,00',
      '31.12;CHF 55,00',
      '01.01;CHF 60,00',
    ].join('\n');

    const r = parseGnAverageCheck(csv, 'jahreswechsel.csv');
    const y = new Date().getFullYear();

    expect(r.debug.detectedFormat).toBe('vertical');
    expect(r.rows.map(x => x.date)).toEqual([
      `${y}-12-30`, `${y}-12-31`, `${y + 1}-01-01`,
    ]);
  });
});
