// @vitest-environment node
/**
 * Tests für den Gastronovi KPI-CSV-Parser (Wide-Format).
 * Fixtures entsprechen exakt dem realen Gastronovi-CSV-Export:
 * TAB-getrennt, alle Zellen in «"», Kopf «Bezeichnung|Zeitraum|01.06.|…»,
 * EINE Wertezeile («Gesamt»/«Durchschnitt»), leere Tageszellen = null.
 */
import { describe, it, expect } from 'vitest';
import { parseGnKpiCsv } from '../gn-kpi-csv-parser';
import { kpiPdfToAverageCheck, kpiPdfToPersonReport } from '../gn-kpi-pdf-parser';

// ── Fixture-Bau ───────────────────────────────────────────────────────────────

const q = (cells: string[]) => cells.map(c => `"${c}"`).join('\t');

const JUNE_HEADERS = Array.from({ length: 30 }, (_, i) => `${String(i + 1).padStart(2, '0')}.06.`);

const PERSON_VALUES = ['263', '295', '285', '282', '390', '587', '499', '170', '238', '240', '341', '373', '414', '398', '257', '892', '112'];
const BON_VALUES = ['45,22', '55,52', '42,75', '71,89', '55,98', '88,22', '58,88', '46,50', '52,49', '44,57', '60,69', '51,39', '50,74', '53,80', '32,54', '45,38', '31,37'];
const UPP_VALUES = ['20,47', '24,93', '21,26', '30,03', '26,99', '33,09', '26,29', '25,14', '26,03', '24,72', '21,30', '25,56', '25,47', '23,43', '17,77', '21,18', '18,10'];

function personCsv(): string {
  const values = [...PERSON_VALUES.map(v => `${v} P.`), ...Array(13).fill('')];
  return q(['Bezeichnung', 'Zeitraum', ...JUNE_HEADERS]) + '\n'
    + q(['Gesamt', '6036 P.', ...values]) + '\n';
}

function moneyCsv(label: string, summary: string, dayValues: string[]): string {
  const values = [...dayValues.map(v => `CHF ${v}`), ...Array(30 - dayValues.length).fill('')];
  return q(['Bezeichnung', 'Zeitraum', ...JUNE_HEADERS]) + '\n'
    + q([label, `CHF ${summary}`, ...values]) + '\n';
}

// ── Anzahl Personen ───────────────────────────────────────────────────────────

describe('parseGnKpiCsv — Anzahl Personen', () => {
  it('erkennt den Berichtstyp inhaltlich an der Einheit «P.»', () => {
    const p = parseGnKpiCsv(personCsv(), 'irgendein_name.csv');
    expect(p.kind).toBe('anzahl_personen');
    expect(p.debug.failureReason).toBeNull();
  });

  it('liest 17 Tageswerte, 13 leere Felder (null, NIE 0) und die Gesamt-Summe', () => {
    const p = parseGnKpiCsv(personCsv(), 'Anzahl_Personen_1784820255774.csv', 2026);
    expect(p.days).toHaveLength(30);
    expect(p.filledDayCount).toBe(17);
    expect(p.emptyDayCount).toBe(13);
    expect(p.days[0].value).toBe(263);
    expect(p.days[16].value).toBe(112);
    expect(p.days[17].value).toBeNull();
    expect(p.days[29].value).toBeNull();
    expect(p.summaryValue).toBe(6036);
    expect(p.summaryLabel).toBe('Gesamt');
    const sum = p.days.reduce((s, d) => s + (d.value ?? 0), 0);
    expect(sum).toBe(6036);
  });

  it('Upload-Zeitstempel im Dateinamen («…1784820255774» enthält «2025») liefert KEIN Jahr — Pflichtwahl', () => {
    const p = parseGnKpiCsv(personCsv(), 'Anzahl_Personen_1784820255774.csv');
    expect(p.yearMissing).toBe(true);
    expect(p.year).toBeNull();
    expect(p.debug.usedYearSource).toBe('Pflichtwahl');
    expect(p.days.every(d => d.date === '')).toBe(true);
  });

  it('Benutzerwahl setzt ISO-Daten und Zeitraum', () => {
    const p = parseGnKpiCsv(personCsv(), 'Anzahl_Personen_1784820255774.csv', 2026);
    expect(p.yearMissing).toBe(false);
    expect(p.year).toBe(2026);
    expect(p.debug.usedYearSource).toBe('Benutzerwahl');
    expect(p.days[0].date).toBe('2026-06-01');
    expect(p.days[29].date).toBe('2026-06-30');
    expect(p.periodFrom).toBe('2026-06-01');
    expect(p.periodTo).toBe('2026-06-30');
  });

  it('eigenständige Jahreszahl im Dateinamen wird als Fallback verwendet (mit Warnung)', () => {
    const p = parseGnKpiCsv(personCsv(), 'Anzahl_Personen_2026.csv');
    expect(p.yearMissing).toBe(false);
    expect(p.year).toBe(2026);
    expect(p.debug.usedYearSource).toBe('Dateiname');
    expect(p.warnings.some(w => w.includes('Dateinamen'))).toBe(true);
  });

  it('Jahr in den Datums-Spaltenköpfen gewinnt (CSV-Inhalt)', () => {
    const csv = q(['Bezeichnung', 'Zeitraum', '01.06.2026', '02.06.2026']) + '\n'
      + q(['Gesamt', '500 P.', '263 P.', '237 P.']) + '\n';
    const p = parseGnKpiCsv(csv, 'Anzahl_Personen.csv', 2024);
    expect(p.year).toBe(2026);
    expect(p.debug.usedYearSource).toBe('CSV-Inhalt');
    expect(p.days[0].date).toBe('2026-06-01');
  });

  it('explizites «0 P.» bleibt 0 (nicht null)', () => {
    const csv = q(['Bezeichnung', 'Zeitraum', '01.06.', '02.06.']) + '\n'
      + q(['Gesamt', '263 P.', '263 P.', '0 P.']) + '\n';
    const p = parseGnKpiCsv(csv, 'Anzahl_Personen.csv', 2026);
    expect(p.days[1].value).toBe(0);
    expect(p.filledDayCount).toBe(2);
  });

  it('Konverter kpiPdfToPersonReport übernimmt Gesamt-Summe und Zeilen', () => {
    const p = parseGnKpiCsv(personCsv(), 'Anzahl_Personen.csv', 2026);
    const report = kpiPdfToPersonReport(p);
    expect(report.detectedCsvType).toBe('anzahl_personen');
    expect(report.rowCount).toBe(17);
    expect(report.totalGuests).toBe(6036);
    expect(report.rows[0]).toMatchObject({ date: '2026-06-01', guestsCount: 263 });
  });
});

// ── Durchschnittsbon ──────────────────────────────────────────────────────────

describe('parseGnKpiCsv — Durchschnittsbon', () => {
  it('erkennt den Typ über den Dateinamen (CHF-Werte sind inhaltlich mehrdeutig)', () => {
    const p = parseGnKpiCsv(moneyCsv('Durchschnitt', '54,07', BON_VALUES), 'Durchschnittsbon_1784820255778.csv', 2026);
    expect(p.kind).toBe('durchschnittsbon');
    expect(p.filledDayCount).toBe(17);
    expect(p.days[0].value).toBeCloseTo(45.22, 2);
    expect(p.days[17].value).toBeNull();
    expect(p.summaryValue).toBeCloseTo(54.07, 2);
    expect(p.summaryLabel).toBe('Durchschnitt');
  });

  it('Konverter kpiPdfToAverageCheck liefert nur gefüllte Tage', () => {
    const p = parseGnKpiCsv(moneyCsv('Durchschnitt', '54,07', BON_VALUES), 'Durchschnittsbon.csv', 2026);
    const avg = kpiPdfToAverageCheck(p);
    expect(avg.rowCount).toBe(17);
    expect(avg.rows[0]).toMatchObject({ date: '2026-06-01' });
    expect(avg.rows[0].averageCheck).toBeCloseTo(45.22, 2);
    expect(avg.periodFrom).toBe('2026-06-01');
    expect(avg.periodTo).toBe('2026-06-17');
  });
});

// ── Umsatz pro Person ─────────────────────────────────────────────────────────

describe('parseGnKpiCsv — Umsatz pro Person', () => {
  it('erkennt den Typ über den Dateinamen und übernimmt den Durchschnitt', () => {
    const p = parseGnKpiCsv(moneyCsv('Durchschnitt', '24,66', UPP_VALUES), 'Umsatz_pro_Person_1784820255778.csv', 2026);
    expect(p.kind).toBe('umsatz_pro_person');
    expect(p.summaryValue).toBeCloseTo(24.66, 2);
    const report = kpiPdfToPersonReport(p);
    expect(report.detectedCsvType).toBe('umsatz_pro_person');
    expect(report.rowCount).toBe(17);
    expect(report.avgRevPerPerson).toBeCloseTo(24.66, 2);
    expect(report.rows[0].revPerPerson).toBeCloseTo(20.47, 2);
  });
});

// ── Fehlerpfade (Diagnose statt Blind-Adaption) ───────────────────────────────

describe('parseGnKpiCsv — Fehlerpfade', () => {
  it('CHF-Werte ohne Dateinamen-Hinweis ⇒ Fehler mit failureReason', () => {
    const p = parseGnKpiCsv(moneyCsv('Durchschnitt', '54,07', BON_VALUES), 'export.csv');
    expect(p.kind).toBeNull();
    expect(p.debug.failureReason).toMatch(/Dateiname/);
    expect(p.days).toHaveLength(0);
  });

  it('Dateiname «Anzahl_Personen» mit CHF-Werten ⇒ Widerspruch, Fehler', () => {
    const p = parseGnKpiCsv(moneyCsv('Durchschnitt', '54,07', BON_VALUES), 'Anzahl_Personen.csv');
    expect(p.kind).toBeNull();
    expect(p.debug.failureReason).toMatch(/Geldbeträge/);
  });

  it('«P.»-Einheit gewinnt über widersprüchlichen Dateinamen (mit Warnung)', () => {
    const p = parseGnKpiCsv(personCsv(), 'Durchschnittsbon.csv', 2026);
    expect(p.kind).toBe('anzahl_personen');
    expect(p.warnings.some(w => w.includes('Personen-Einheit'))).toBe(true);
  });

  it('keine Datums-Kopfzeile ⇒ Fehler mit Diagnose der ersten Zeilen', () => {
    const p = parseGnKpiCsv('"Datum";"Personen"\n"01.06.2026";"263"\n', 'Anzahl_Personen.csv');
    expect(p.kind).toBeNull();
    expect(p.debug.failureReason).toMatch(/Datums-Spaltenkopfzeile/);
    expect(p.debug.firstLines.length).toBeGreaterThan(0);
  });

  it('Kopfzeile ohne Wertezeile ⇒ Fehler', () => {
    const p = parseGnKpiCsv(q(['Bezeichnung', 'Zeitraum', '01.06.', '02.06.']) + '\n', 'Anzahl_Personen.csv');
    expect(p.kind).toBeNull();
    expect(p.debug.failureReason).toMatch(/keine Zeile mit Tageswerten/);
  });

  it('nur leere Tageszellen ⇒ Fehler, nie 0-Werte', () => {
    const csv = q(['Bezeichnung', 'Zeitraum', '01.06.', '02.06.']) + '\n'
      + q(['Gesamt', '6036 P.', '', '']) + '\n';
    const p = parseGnKpiCsv(csv, 'Anzahl_Personen.csv', 2026);
    expect(p.debug.failureReason).not.toBeNull();
    expect(p.days).toHaveLength(0);
  });
});

// ── Format-Varianten ──────────────────────────────────────────────────────────

describe('parseGnKpiCsv — Format-Varianten', () => {
  it('Semikolon-getrennt ohne Anführungszeichen funktioniert ebenfalls', () => {
    const csv = 'Bezeichnung;Zeitraum;01.06.;02.06.\nGesamt;500 P.;263 P.;237 P.\n';
    const p = parseGnKpiCsv(csv, 'Anzahl_Personen.csv', 2026);
    expect(p.kind).toBe('anzahl_personen');
    expect(p.days.map(d => d.value)).toEqual([263, 237]);
    expect(p.summaryValue).toBe(500);
  });

  it('gleicher Inhalt ⇒ gleiche Checksum (Idempotenz-Basis), anderes Jahr ändert die Checksum nicht', () => {
    const a = parseGnKpiCsv(personCsv(), 'Anzahl_Personen.csv');
    const b = parseGnKpiCsv(personCsv(), 'Anzahl_Personen.csv', 2026);
    expect(a.checksum).toBe(b.checksum);
  });
});
