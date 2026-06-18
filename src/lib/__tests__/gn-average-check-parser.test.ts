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
