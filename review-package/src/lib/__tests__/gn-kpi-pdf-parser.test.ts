// @vitest-environment node
/**
 * Tests für den Gastronovi KPI-PDF-Parser (Anzahl Personen, Umsatz pro Person,
 * Durchschnittsbon).
 *
 * Fixtures: synthetische pdfjs-Text-Items, exakt dem Gastronovi-Analyse-Layout
 * nachgebildet (Wide-Tabelle mit Datums-Spaltenköpfen, Summenspalte,
 * wiederholtem Seitentitel und «Gastronovi Office»-Fusszeile).
 */

import { describe, it, expect } from 'vitest';
import {
  parseGnKpiPdf,
  kpiPdfToAverageCheck,
  kpiPdfToPersonReport,
} from '../gn-kpi-pdf-parser';
import type { GnPdfPageItems, GnPdfTextItem } from '../gn-pdf-lines';

// ── Fixture-Bau ───────────────────────────────────────────────────────────────

/** Zellen einer Zeile: [x, text]-Paare bei fester Y-Position. */
function line(y: number, cells: Array<[number, string]>): GnPdfTextItem[] {
  return cells.map(([x, str]) => ({ x, y, str }));
}

function page(pageNumber: number, ...lineItems: GnPdfTextItem[][]): GnPdfPageItems {
  return { pageNumber, items: lineItems.flat() };
}

/** X-Positionen für n Datums-Spalten ab x0 im Abstand step. */
function xs(n: number, x0 = 100, step = 30): number[] {
  return Array.from({ length: n }, (_, i) => x0 + i * step);
}

const FOOTER = (y = 20): GnPdfTextItem[] =>
  line(y, [[100, 'Gastronovi Office — Restaurant Oliv GmbH']]);

/**
 * Durchschnittsbon Juni 2026 über 2 Seiten:
 *   Seite 1: 01.06.–05.06. (03.06. leer), Seite 2: 06.06.–08.06. + «Durchschnitt»-Summenspalte.
 */
function bonFixture(opts?: { periodLine?: string; title?: string }): GnPdfPageItems[] {
  const title = opts?.title ?? 'Durchschnittsbon';
  const period = opts?.periodLine ?? 'Zeitraum: 01.06.2026 - 30.06.2026';
  const x1 = xs(5);
  const x2 = xs(3);
  const sumX = x2[2] + 60;
  return [
    page(1,
      line(800, [[50, title]]),
      line(780, [[50, period]]),
      line(700, [[x1[0], '01.06.'], [x1[1], '02.06.'], [x1[2], '03.06.'], [x1[3], '04.06.'], [x1[4], '05.06.']]),
      line(680, [[30, 'Durchschnitt'], [x1[0], 'CHF 54.07'], [x1[1], 'CHF 61.90'], [x1[3], 'CHF 48.25'], [x1[4], 'CHF 70.10']]),
      FOOTER(),
      line(10, [[300, '1/2']]),
    ),
    page(2,
      line(800, [[50, title]]),
      line(700, [[x2[0], '06.06.'], [x2[1], '07.06.'], [x2[2], '08.06.'], [sumX, 'Durchschnitt']]),
      line(680, [[30, 'Durchschnitt'], [x2[0], 'CHF 52.00'], [x2[2], 'CHF 66.45'], [sumX, 'CHF 58.80']]),
      FOOTER(),
      line(10, [[300, '2/2']]),
    ),
  ];
}

/** Anzahl Personen — eine Seite, Ganzzahlen, «Gesamt»-Summenspalte, ein explizites 0. */
function personenFixture(opts?: { dates?: string[]; periodLine?: string | null; fileNameYearOnly?: boolean }): GnPdfPageItems[] {
  const dates = opts?.dates ?? ['01.06.', '02.06.', '03.06.', '04.06.'];
  const x = xs(dates.length);
  const sumX = x[x.length - 1] + 60;
  const rows: GnPdfTextItem[][] = [
    line(800, [[50, 'Anzahl Personen']]),
  ];
  if (opts?.periodLine !== null) {
    rows.push(line(780, [[50, opts?.periodLine ?? 'Zeitraum: 01.06.2026 - 30.06.2026']]));
  }
  rows.push(
    line(700, [...dates.map((d, i) => [x[i], d] as [number, string]), [sumX, 'Gesamt']]),
    line(680, [[30, 'Personen'], [x[0], '142'], [x[1], '0'], [x[3], "1'208"], [sumX, "1'350"]]),
    FOOTER(),
  );
  return [page(1, ...rows)];
}

/** Umsatz pro Person — eine Seite, «Durchschnitt»-Summenspalte. */
function umsatzProPersonFixture(): GnPdfPageItems[] {
  const x = xs(3);
  const sumX = x[2] + 60;
  return [page(1,
    line(800, [[50, 'Umsatz pro Person']]),
    line(780, [[50, 'Zeitraum: 01.06.2026 - 30.06.2026']]),
    line(700, [[x[0], '01.06.'], [x[1], '02.06.'], [x[2], '03.06.'], [sumX, 'Durchschnitt']]),
    line(680, [[30, 'Umsatz pro Person'], [x[0], 'CHF 38.50'], [x[1], 'CHF 41.20'], [sumX, 'CHF 39.85']]),
    FOOTER(),
  )];
}

// ── Berichtstyp-Erkennung ─────────────────────────────────────────────────────

describe('parseGnKpiPdf — Berichtstyp', () => {
  it('erkennt Durchschnittsbon inhaltsbasiert', () => {
    const p = parseGnKpiPdf(bonFixture(), 'export.pdf');
    expect(p.kind).toBe('durchschnittsbon');
    expect(p.debug.failureReason).toBeNull();
  });

  it('erkennt Anzahl Personen auch mit «Durchschnitt»-Zeile im Inhalt (Titel gewinnt)', () => {
    const p = parseGnKpiPdf(personenFixture(), 'export.pdf');
    expect(p.kind).toBe('anzahl_personen');
  });

  it('erkennt Umsatz pro Person', () => {
    const p = parseGnKpiPdf(umsatzProPersonFixture(), 'export.pdf');
    expect(p.kind).toBe('umsatz_pro_person');
  });

  it('weist Z-Bericht-PDF mit konkretem Hinweis ab', () => {
    const zb = [page(1,
      line(800, [[50, 'Z-Bericht (Erweiterte Version)']]),
      line(780, [[50, 'Restaurant Oliv']]),
    )];
    const p = parseGnKpiPdf(zb, 'z.pdf');
    expect(p.kind).toBeNull();
    expect(p.diagnosis).toMatch(/Z-Bericht/);
    expect(p.debug.failureReason).toMatch(/Z-Bericht/);
  });

  it('unbekannter Berichtstyp → Diagnose mit Titelzeile, nie stilles Raten', () => {
    const unk = [page(1, line(800, [[50, 'Monatsreport Küche']]))];
    const p = parseGnKpiPdf(unk, 'x.pdf');
    expect(p.kind).toBeNull();
    expect(p.debug.failureReason).toContain('Monatsreport Küche');
  });

  it('Dateiname beeinflusst die Typ-Erkennung NICHT', () => {
    const p = parseGnKpiPdf(bonFixture(), 'Anzahl_Personen_2026.pdf');
    expect(p.kind).toBe('durchschnittsbon');
  });
});

// ── Tageswerte, leere Felder, Seitenumbruch ───────────────────────────────────

describe('parseGnKpiPdf — Tageswerte', () => {
  it('liest Tageswerte über Seitenumbruch, leere Felder bleiben null (nie 0)', () => {
    const p = parseGnKpiPdf(bonFixture(), 'bon.pdf');
    expect(p.days).toHaveLength(8);
    expect(p.filledDayCount).toBe(6);
    expect(p.emptyDayCount).toBe(2);
    const d3 = p.days.find(d => d.date === '2026-06-03');
    expect(d3?.value).toBeNull();
    const d7 = p.days.find(d => d.date === '2026-06-07');
    expect(d7?.value).toBeNull();
    expect(p.days.find(d => d.date === '2026-06-01')?.value).toBeCloseTo(54.07, 2);
    expect(p.days.find(d => d.date === '2026-06-08')?.value).toBeCloseTo(66.45, 2);
  });

  it('liest die Summenspalte («Durchschnitt») separat — kein Tageswert', () => {
    const p = parseGnKpiPdf(bonFixture(), 'bon.pdf');
    expect(p.summaryValue).toBeCloseTo(58.80, 2);
    expect(p.summaryLabel).toMatch(/durchschnitt/i);
    expect(p.days.some(d => d.value != null && Math.abs(d.value - 58.80) < 0.001)).toBe(false);
  });

  it('explizites «0» bleibt 0 (Anzahl Personen), leeres Feld bleibt null', () => {
    const p = parseGnKpiPdf(personenFixture(), 'p.pdf');
    expect(p.days.find(d => d.date === '2026-06-02')?.value).toBe(0);
    expect(p.days.find(d => d.date === '2026-06-03')?.value).toBeNull();
    expect(p.days.find(d => d.date === '2026-06-04')?.value).toBe(1208);
    expect(p.summaryValue).toBe(1350);
  });

  it('Diagnose nennt Tageswerte und leere Felder', () => {
    const p = parseGnKpiPdf(bonFixture(), 'bon.pdf');
    expect(p.diagnosis).toBe('Durchschnittsbon erkannt: 6 Tageswerte und 2 leere Felder.');
  });

  it('Periodengrenzen aus den tatsächlichen Tagen', () => {
    const p = parseGnKpiPdf(bonFixture(), 'bon.pdf');
    expect(p.periodFrom).toBe('2026-06-01');
    expect(p.periodTo).toBe('2026-06-08');
  });

  it('KPI-Bericht ohne Tages-Tabelle → konkreter failureReason', () => {
    const noTable = [page(1,
      line(800, [[50, 'Durchschnittsbon']]),
      line(780, [[50, 'Zeitraum: 01.06.2026 - 30.06.2026']]),
      line(700, [[50, 'Monatswert: CHF 58.80']]),
    )];
    const p = parseGnKpiPdf(noTable, 'bon.pdf');
    expect(p.kind).toBe('durchschnittsbon');
    expect(p.days).toHaveLength(0);
    expect(p.debug.failureReason).toMatch(/keine Datums-Spaltenkopfzeile/);
  });
});

// ── Jahres-Priorität ─────────────────────────────────────────────────────────

describe('parseGnKpiPdf — Jahres-Priorität', () => {
  const noYearDates = ['01.06.', '02.06.', '03.06.', '04.06.'];

  it('1. Jahr aus PDF-Datumszellen gewinnt (auch gegen Benutzerwahl)', () => {
    const fx = personenFixture({ dates: ['01.06.2026', '02.06.2026', '03.06.2026', '04.06.2026'], periodLine: null });
    const p = parseGnKpiPdf(fx, 'p.pdf', 2023);
    expect(p.year).toBe(2026);
    expect(p.debug.usedYearSource).toBe('PDF-Inhalt');
  });

  it('2. Zeitraum-Zeile, wenn Datumszellen ohne Jahr', () => {
    const p = parseGnKpiPdf(personenFixture({ dates: noYearDates }), 'p.pdf', 2023);
    expect(p.year).toBe(2026);
    expect(p.debug.usedYearSource).toBe('Zeitraum');
  });

  it('3. Benutzerwahl vor Dateiname', () => {
    const fx = personenFixture({ dates: noYearDates, periodLine: 'Zeitraum: Juni' });
    const p = parseGnKpiPdf(fx, 'Personen_2024.pdf', 2025);
    expect(p.year).toBe(2025);
    expect(p.debug.usedYearSource).toBe('Benutzerwahl');
  });

  it('4. eindeutiger Dateiname als letzter automatischer Fallback', () => {
    const fx = personenFixture({ dates: noYearDates, periodLine: 'Zeitraum: Juni' });
    const p = parseGnKpiPdf(fx, 'Personen_2024.pdf');
    expect(p.year).toBe(2024);
    expect(p.debug.usedYearSource).toBe('Dateiname');
    expect(p.warnings.some(w => w.includes('Dateinamen'))).toBe(true);
  });

  it('mehrdeutiger Dateiname (zwei Jahre) zählt NICHT', () => {
    const fx = personenFixture({ dates: noYearDates, periodLine: 'Zeitraum: Juni' });
    const p = parseGnKpiPdf(fx, 'Vergleich_2024_2025.pdf');
    expect(p.yearMissing).toBe(true);
  });

  it('5. Pflichtwahl: kein Jahr ermittelbar → yearMissing + Diagnose', () => {
    const fx = personenFixture({ dates: noYearDates, periodLine: 'Zeitraum: Juni' });
    const p = parseGnKpiPdf(fx, 'export.pdf');
    expect(p.yearMissing).toBe(true);
    expect(p.year).toBeNull();
    expect(p.diagnosis).toBe('Anzahl Personen erkannt, aber Jahr fehlt.');
    expect(p.days.every(d => d.date === '')).toBe(true);
  });

  it('Monats-Rollover über die Jahresgrenze', () => {
    const x = xs(3);
    const fx = [page(1,
      line(800, [[50, 'Durchschnittsbon']]),
      line(780, [[50, 'Zeitraum: 30.12.2025 - 01.01.2026']]),
      line(700, [[x[0], '30.12.'], [x[1], '31.12.'], [x[2], '01.01.']]),
      line(680, [[30, 'Durchschnitt'], [x[0], 'CHF 80.00'], [x[1], 'CHF 95.50'], [x[2], 'CHF 44.10']]),
    )];
    const p = parseGnKpiPdf(fx, 'bon.pdf');
    expect(p.year).toBe(2025);
    expect(p.days.map(d => d.date)).toEqual(['2025-12-30', '2025-12-31', '2026-01-01']);
  });
});

// ── Konverter ────────────────────────────────────────────────────────────────

describe('kpiPdfToAverageCheck', () => {
  it('liefert GnParsedAverageCheck mit identischen Tageswerten', () => {
    const p = parseGnKpiPdf(bonFixture(), 'bon.pdf');
    const avg = kpiPdfToAverageCheck(p);
    expect(avg.rowCount).toBe(6);
    expect(avg.rows[0]).toMatchObject({ date: '2026-06-01', averageCheck: 54.07, currency: 'CHF' });
    expect(avg.periodFrom).toBe('2026-06-01');
    expect(avg.periodTo).toBe('2026-06-08');
    expect(avg.averageMean).toBeCloseTo((54.07 + 61.90 + 48.25 + 70.10 + 52.00 + 66.45) / 6, 4);
    expect(avg.debug.skippedEmptyColumns).toBe(2);
    expect(avg.checksum).toBe(p.checksum);
  });

  it('wirft bei falschem Berichtstyp und bei fehlendem Jahr', () => {
    const person = parseGnKpiPdf(personenFixture(), 'p.pdf');
    expect(() => kpiPdfToAverageCheck(person)).toThrow(/falscher Berichtstyp/);
    const noYear = parseGnKpiPdf(
      bonFixture({ periodLine: 'Zeitraum: Juni' }), 'bon.pdf');
    expect(noYear.yearMissing).toBe(true);
    expect(() => kpiPdfToAverageCheck(noYear)).toThrow(/Jahr fehlt/);
  });
});

describe('kpiPdfToPersonReport', () => {
  it('Anzahl Personen: Zeilen nur für Tage MIT Wert, Gesamt aus Summenspalte', () => {
    const p = parseGnKpiPdf(personenFixture(), 'p.pdf');
    const rep = kpiPdfToPersonReport(p);
    expect(rep.detectedCsvType).toBe('anzahl_personen');
    expect(rep.rowCount).toBe(3); // 142, 0, 1208 — leerer Tag 03.06. fehlt
    expect(rep.rows.map(r => r.date)).toEqual(['2026-06-01', '2026-06-02', '2026-06-04']);
    expect(rep.rows[1].guestsCount).toBe(0);
    expect(rep.totalGuests).toBe(1350); // «Gesamt»-Spalte, nicht die Zeilensumme
  });

  it('Umsatz pro Person: Durchschnitt aus Summenspalte', () => {
    const p = parseGnKpiPdf(umsatzProPersonFixture(), 'u.pdf');
    const rep = kpiPdfToPersonReport(p);
    expect(rep.detectedCsvType).toBe('umsatz_pro_person');
    expect(rep.rowCount).toBe(2);
    expect(rep.rows[0].revPerPerson).toBeCloseTo(38.50, 2);
    expect(rep.avgRevPerPerson).toBeCloseTo(39.85, 2);
  });

  it('wirft bei Durchschnittsbon (gehört in kpiPdfToAverageCheck)', () => {
    const bon = parseGnKpiPdf(bonFixture(), 'bon.pdf');
    expect(() => kpiPdfToPersonReport(bon)).toThrow(/falscher Berichtstyp/);
  });
});

// ── Idempotenz-Basis ─────────────────────────────────────────────────────────

describe('parseGnKpiPdf — Checksum', () => {
  it('gleicher Inhalt ⇒ gleiche Checksum, unabhängig vom Dateinamen', () => {
    const a = parseGnKpiPdf(bonFixture(), 'a.pdf');
    const b = parseGnKpiPdf(bonFixture(), 'b.pdf');
    expect(a.checksum).toBe(b.checksum);
  });

  it('anderer Inhalt ⇒ andere Checksum', () => {
    const a = parseGnKpiPdf(bonFixture(), 'a.pdf');
    const c = parseGnKpiPdf(umsatzProPersonFixture(), 'a.pdf');
    expect(a.checksum).not.toBe(c.checksum);
  });
});
