// @vitest-environment node
/**
 * Contract tests: the client's own file conventions.
 *
 * The client built the existing import logic and uploads files the way these tests describe
 * (file-name keywords, the «P.» suffix on guest counts, «CHF» / plain amounts on revenue, titles
 * on Gastronovi PDFs). The unified import is built ON TOP of this logic and must never change
 * what it does for these cases. If one of these tests fails, the change is wrong, not the test.
 */
import { describe, it, expect } from 'vitest';
import {
  detectTagesdatenTyp, suggestTypFromFileName, suggestTagesdatenTyp,
  analyzeWertemuster, istHartBlockiert,
} from '../../tagesdaten-auto-import';
import { detectGnPdfReportKind } from '../../gn-pdf-lines';
import { parseVerkaufsdatenFile } from '../../verkaufsdaten-import';

const HEADER = ['Bezeichnung', 'Zeitraum', '01.07.', '02.07.', '03.07.'];
const pdfLine = (text: string, y: number) => ({ pageNumber: 1, y, cells: [], text });

describe('client convention: file names decide the daily-data type', () => {
  it.each([
    ['Anzahl Oliv 07.2026.xlsx', 'gaeste'],
    ['Umsatz Beaulieu 06.2026.xlsx', 'umsatz'],
    ['Durchschnitt 07.2026.xlsx', 'durchschnitt'],
    ['Umsatz pro Gast 08.2026.xlsx', 'umsatzprogast'],
    ['Maison Marketing.xlsx', 'marketing'],
  ])('%s → %s', (name, typ) => {
    expect(suggestTypFromFileName(name)).toBe(typ);
  });

  it('an unknown name gives no suggestion', () => {
    expect(suggestTypFromFileName('irgendwas.xlsx')).toBeNull();
  });

  it('«Anzahl …» wins over the content, even when the content looks like CHF', () => {
    const chfRows = [HEADER, ['Gesamt', 'CHF 5000.00', 'CHF 1600.00', 'CHF 1700.00', 'CHF 1700.00']];
    expect(suggestTagesdatenTyp('Anzahl Juli.xlsx', chfRows)).toBe('gaeste');
  });
});

describe('client convention: content', () => {
  it('guests = «Gesamt» row with the «P.» suffix', () => {
    expect(detectTagesdatenTyp([HEADER, ['Gesamt', '8604 P.', '300 P.', '280 P.', '310 P.']])).toBe('gaeste');
  });

  it('revenue without a CHF prefix («22331,80», «1\'234.50») is still revenue', () => {
    const rows = [HEADER, ['Gesamt', '22331,80', '7\'400.50', '7\'500.00', '7\'431.30'], ['Food', '15000,00', '5\'000.00', '5\'000.00', '5\'000.00']];
    expect(detectTagesdatenTyp(rows)).toBe('umsatz');
  });

  it('marketing wins over a total row', () => {
    const rows = [HEADER, ['Gesamt', 'CHF 5000.00', 'CHF 1600.00', 'CHF 1700.00', 'CHF 1700.00'], ['marketing', 'CHF 300.00', 'CHF 100.00', 'CHF 100.00', 'CHF 100.00']];
    expect(detectTagesdatenTyp(rows)).toBe('marketing');
  });

  it('a lone «Durchschnitt» CHF row stays ambiguous (no suggestion)', () => {
    const rows = [HEADER, ['Durchschnitt', 'CHF 52.10', 'CHF 51.00', 'CHF 53.00', 'CHF 52.40']];
    expect(detectTagesdatenTyp(rows)).toBeNull();
  });

  it('the real case «Anzahl Oliv 07.2026» (166/204/259) stays HARD-blocked as revenue', () => {
    const rows = [HEADER, ['Gesamt', '629', '166', '204', '259']];
    expect(analyzeWertemuster(rows)).toBe('anzahl');
    expect(istHartBlockiert('umsatz', analyzeWertemuster(rows))).toBe(true);
  });
});

describe('client convention: Gastronovi PDF titles', () => {
  it.each([
    ['Z-Bericht', 'zbericht'],
    ['Anzahl Personen', 'anzahl_personen'],
    ['Umsatz pro Person', 'umsatz_pro_person'],
    ['Durchschnittsbon', 'durchschnittsbon'],
  ])('title «%s» → %s', (title, kind) => {
    const lines = [pdfLine(title, 800), pdfLine('Zeitraum 01.07.2026 - 31.07.2026', 780)];
    expect(detectGnPdfReportKind(lines as never).kind).toBe(kind);
  });
});

describe('client convention: sales data export (Food / Beverage)', () => {
  it('«Gesamt - Food» with CHF is food revenue', () => {
    const txt = ['Bezeichnung\tZeitraum\t01.01.\t02.01.', 'Gesamt - Food\tCHF 10.00\tCHF 5.00\tCHF 5.00'].join('\n');
    const r = parseVerkaufsdatenFile(txt, 'export.txt');
    expect(r).toMatchObject({ ok: true, category: 'food', kind: 'umsatz' });
  });

  it('«Gesamt - Beverage» without CHF is a beverage count', () => {
    const txt = ['Bezeichnung\tZeitraum\t01.01.\t02.01.', 'Gesamt - Beverage\t10\t5\t5'].join('\n');
    const r = parseVerkaufsdatenFile(txt, 'anzahl.txt');
    expect(r).toMatchObject({ ok: true, category: 'beverage', kind: 'anzahl' });
  });
});
