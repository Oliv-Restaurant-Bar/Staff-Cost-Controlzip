// @vitest-environment node
/**
 * Table-driven fixture corpus for the unified import classifier (all fixtures built in memory,
 * no client data). Each fixture must classify to exactly the expected status/type, so a future change
 * to a detector or to the classifier cannot silently re-route a file.
 */
import { describe, it, expect } from 'vitest';
import { classifyProbe } from '../classify';
import type { FileProbe, ProbeContent } from '../types';

const HEADER = ['Bezeichnung', 'Zeitraum', '01.07.', '02.07.', '03.07.'];
const probe = (name: string, content: ProbeContent, size = 1000): FileProbe =>
  ({ name, ext: name.split('.').pop()!.toLowerCase(), size, content });
const sheet = (name: string, rows: string[][]) => probe(name, { kind: 'sheet', rows });
const text = (name: string, t: string) => probe(name, { kind: 'text', text: t });
const pdfLine = (t: string, y: number, pageNumber = 1) => ({ pageNumber, y, cells: [], text: t });
const pdf = (name: string, lines: ReturnType<typeof pdfLine>[], hasTextLayer = true) =>
  probe(name, { kind: 'pdf', lines, hasTextLayer });

// Foratable fixtures use the real header names the existing parsers map.
const RES_CSV = 'Restaurant;Res.Nr.;Personen;Zeit;Datum;Vorname;Nachname;Status\nOliv;1001;4;19:00;01.07.2026;Anna;Muster;bestätigt\n';
const GUEST_CSV = 'Vorname;Name;E-Mail;Telefonnummer;VIP;Firma\nAnna;Muster;a@b.ch;0791234567;VIP;ACME\n';

// Tab-separated sales exports.
const TOTALS_TXT = ['Bezeichnung\tZeitraum\t01.01.\t02.01.', 'Gesamt - Food\tCHF 10.00\tCHF 5.00\tCHF 5.00', 'Pizza\tCHF 4.00\tCHF 2.00\tCHF 2.00'].join('\n');
const productRows = (n: number) => Array.from({ length: n }, (_, i) => `> Artikel ${i}\t${i}\t1\t1`);
const PRODUCTS_TXT = ['Bezeichnung\tZeitraum\t01.01.\t02.01.', ...productRows(20)].join('\n');
const TOTALS_AND_PRODUCTS_TXT = ['Bezeichnung\tZeitraum\t01.01.\t02.01.', 'Gesamt - Food\tCHF 10.00\tCHF 5.00\tCHF 5.00', ...productRows(20)].join('\n');

describe('classifyProbe — daily data (xlsx)', () => {
  it('guests with the client «P.» suffix are recognised as tagesdaten/gaeste', () => {
    const r = classifyProbe(sheet('export.xlsx', [HEADER, ['Gesamt', '8604 P.', '300 P.', '280 P.', '310 P.']]));
    expect(r).toMatchObject({ status: 'recognised', typeId: 'tagesdaten', tagesdatenTyp: 'gaeste' });
  });

  it('the client\'s real case «Anzahl Oliv 07.2026.xlsx» (plain 166/204/259) stays recognised as guests', () => {
    const r = classifyProbe(sheet('Anzahl Oliv 07.2026.xlsx', [HEADER, ['Gesamt', '629', '166', '204', '259']]));
    expect(r).toMatchObject({ status: 'recognised', typeId: 'tagesdaten', tagesdatenTyp: 'gaeste' });
  });

  it('revenue with CHF amounts and exact labels is recognised', () => {
    const r = classifyProbe(sheet('Umsatz Beaulieu 06.2026.xlsx', [HEADER,
      ['Gesamt', 'CHF 22331.80', 'CHF 7400.50', 'CHF 7500.00', 'CHF 7431.30'],
      ['Food', 'CHF 15000.00', 'CHF 5000.00', 'CHF 5000.00', 'CHF 5000.00']]));
    expect(r).toMatchObject({ status: 'recognised', tagesdatenTyp: 'umsatz' });
  });

  it('revenue without a CHF prefix («22331,80») keeps working (client\'s format)', () => {
    const r = classifyProbe(sheet('export.xlsx', [HEADER,
      ['Gesamt', '22331,80', "7'400.50", "7'500.00", "7'431.30"],
      ['Food', '15000,00', "5'000.00", "5'000.00", "5'000.00"]]));
    expect(r).toMatchObject({ status: 'recognised', tagesdatenTyp: 'umsatz' });
  });

  it('marketing is recognised even with a total row', () => {
    const r = classifyProbe(sheet('Maison Marketing.xlsx', [HEADER,
      ['Gesamt', 'CHF 5000.00', 'CHF 1600.00', 'CHF 1700.00', 'CHF 1700.00'],
      ['marketing', 'CHF 300.00', 'CHF 100.00', 'CHF 100.00', 'CHF 100.00']]));
    expect(r).toMatchObject({ status: 'recognised', tagesdatenTyp: 'marketing' });
  });

  it('«Durchschnitt» (per receipt or per person) asks the user, with both options', () => {
    const r = classifyProbe(sheet('Durchschnitt Oliv 08.2026.xlsx', [HEADER, ['Durchschnitt', 'CHF 52.10', 'CHF 51.00', 'CHF 53.00', 'CHF 52.40']]));
    expect(r.status).toBe('confirm');
    expect(r.tagesdatenAlternatives).toEqual(['durchschnitt', 'umsatzprogast']);
    expect(r.reasons).toContain('average-ambiguous');
  });

  it('plain head counts without name or suffix are NOT silently revenue (weak → confirm)', () => {
    const r = classifyProbe(sheet('export.xlsx', [HEADER, ['Gesamt', '629', '166', '204', '259']]));
    expect(r.status).toBe('confirm');
    expect(r.reasons).toContain('amounts-without-chf-marker');
    expect(r.tagesdatenAlternatives).toContain('gaeste');
  });

  it('a label that only CONTAINS «gesamt» («Gesamtanzahl Mitarbeiter») is weak → confirm', () => {
    const r = classifyProbe(sheet('export.xlsx', [HEADER, ['Gesamtanzahl Mitarbeiter', 'CHF 40.00', 'CHF 12.00', 'CHF 14.00', 'CHF 14.00']]));
    expect(r.status).toBe('confirm');
    expect(r.reasons).toContain('label-not-exact');
  });

  it('file name says guests but the values are CHF decimals → name contradicts content → confirm', () => {
    const r = classifyProbe(sheet('Anzahl Juli.xlsx', [HEADER, ['Gesamt', 'CHF 5000.00', 'CHF 1600.00', 'CHF 1700.00', 'CHF 1700.00']]));
    expect(r.status).toBe('confirm');
    expect(r.reasons).toContain('name-contradicts-content');
    expect(r.tagesdatenTyp).toBe('gaeste'); // client's name keyword stays the pre-selection
  });

  it('a sheet without day columns is not daily data', () => {
    const r = classifyProbe(sheet('Umsatz.xlsx', [['Name', 'Betrag'], ['Gesamt', 'CHF 10.00']]));
    expect(r.status).toBe('unknown');
    expect(r.reasons).toContain('no-date-columns');
  });

  it('unrelated sheet content is unknown, with manual choices and the fallback hook open', () => {
    const r = classifyProbe(sheet('irgendwas.xlsx', [HEADER, ['Foo', 'bar', 'baz', 'qux', 'quux']]));
    expect(r).toMatchObject({ status: 'unknown', typeId: null, fallbackEligible: true });
    expect(r.alternatives).toContain('annual-revenue');
  });
});

describe('classifyProbe — csv / txt', () => {
  it('Foratable reservations CSV (header from the real parser)', () => {
    expect(classifyProbe(text('res.csv', RES_CSV))).toMatchObject({ status: 'recognised', typeId: 'foratable-reservationen' });
  });

  it('Foratable guest export CSV', () => {
    expect(classifyProbe(text('gaeste.csv', GUEST_CSV))).toMatchObject({ status: 'recognised', typeId: 'foratable-gaeste' });
  });

  it('totals export (few rows) → Verkaufsdaten', () => {
    expect(classifyProbe(text('export.txt', TOTALS_TXT))).toMatchObject({ status: 'recognised', typeId: 'verkaufsdaten' });
  });

  it('per-product export (many rows, no totals row) → Sales Upload', () => {
    expect(classifyProbe(text('export.csv', PRODUCTS_TXT))).toMatchObject({ status: 'recognised', typeId: 'sales-upload' });
  });

  it('totals row AND many product rows fits both → confirm', () => {
    const r = classifyProbe(text('export.csv', TOTALS_AND_PRODUCTS_TXT));
    expect(r.status).toBe('confirm');
    expect(r.reasons).toContain('tab-file-totals-and-products');
  });

  it('empty text file', () => {
    expect(classifyProbe(text('leer.csv', '  \n'))).toMatchObject({ status: 'unknown', reasons: ['empty-file'] });
  });

  it('unrecognised csv stays unknown', () => {
    expect(classifyProbe(text('x.csv', 'a;b;c\n1;2;3\n'))).toMatchObject({ status: 'unknown', typeId: null });
  });
});

describe('classifyProbe — pdf', () => {
  it.each([
    ['Z-Bericht', 'zbericht-pdf'],
    ['Anzahl Personen', 'gn-kpi-pdf'],
    ['Umsatz pro Person', 'gn-kpi-pdf'],
    ['Durchschnittsbon', 'gn-kpi-pdf'],
  ])('title «%s» → %s (recognised)', (title, typeId) => {
    const r = classifyProbe(pdf('b.pdf', [pdfLine(title, 800), pdfLine('Zeitraum 01.07.2026', 780)]));
    expect(r).toMatchObject({ status: 'recognised', typeId });
  });

  it('kind found only in the body text → confirm', () => {
    const r = classifyProbe(pdf('b.pdf', [pdfLine('Statistik', 800), pdfLine('Siehe auch Z-Bericht vom 01.07.', 700)]));
    expect(r.status).toBe('confirm');
    expect(r.reasons).toContain('pdf-kind-from-body-only');
  });

  it('unknown pdf is unknown; kontoblatt can be picked by hand', () => {
    const r = classifyProbe(pdf('sage.pdf', [pdfLine('Kontoblatt 6000', 800)]));
    expect(r).toMatchObject({ status: 'unknown', fallbackEligible: true });
    expect(r.alternatives).toContain('kontoblatt');
  });

  it('scanned pdf (no text layer) is unknown and marked for the later AI fallback', () => {
    const r = classifyProbe(pdf('scan.pdf', [], false));
    expect(r).toMatchObject({ status: 'unknown', fallbackEligible: true });
    expect(r.reasons).toContain('pdf-no-text-layer');
  });
});

describe('classifyProbe — unreadable input', () => {
  it.each([
    [probe('alt.xls', { kind: 'legacy-xls' }), 'legacy-xls'],
    [probe('gross.xlsx', { kind: 'too-large' }), 'file-too-large'],
    [probe('bild.png', { kind: 'none' }), 'unsupported-extension'],
  ])('%#: unsupported with a reason', (p, reason) => {
    expect(classifyProbe(p)).toMatchObject({ status: 'unsupported', reasons: [reason] });
  });

  it('a read error is unknown (not unsupported), no fallback', () => {
    expect(classifyProbe(probe('kaputt.xlsx', { kind: 'error', message: 'boom' }))).toMatchObject({
      status: 'unknown', reasons: ['read-error'], fallbackEligible: false,
    });
  });
});

// ── weekly sources: Mirus, category analysis, feedback CSV ───────────────────

const MIRUS_ROWS = [
  ['Oliv Restaurant & Bar'],
  ['Tägliche Stunden von 01.07.2026 bis 31.07.2026'],
  ['Name', '01.07.2026', '02.07.2026'],
  ['Muster Anna', '8', '7.5'],
];
const CAT_ROWS = [
  ['Kategorie', 'Total', '01.07.2026', '02.07.2026'],
  ['Food'],
  ['> Vorspeisen', '', '120', '80'],
  ['> Hauptgang', '', '300', '250'],
  ['> Dessert', '', '40', '55'],
];
const FEEDBACK_CSV = 'Publish Date;Average;Comment\n2026-07-01;5;Super\n2026-07-02;4;Gut\n';

describe('classifyProbe — weekly sources', () => {
  it('recognises a Mirus «Tägliche Stunden» xlsx and carries the month; the Import-Center dialog is offered too', () => {
    const r = classifyProbe(sheet('Taegliche_Stunden.xlsx', MIRUS_ROWS));
    expect(r.status).toBe('recognised');
    expect(r.typeId).toBe('mirus-schedule');
    expect(r.alternatives).toContain('ist-stunden');
    expect(r.meta?.mirusMonth).toBe('2026-07');
  });

  it('recognises a Mirus export that is a real binary .xls (the format Mirus delivers)', () => {
    const r = classifyProbe(probe('Taegliche_Stunden.xls', { kind: 'sheet', rows: MIRUS_ROWS, legacy: true }));
    expect(r.status).toBe('recognised');
    expect(r.typeId).toBe('mirus-schedule');
  });

  it('a binary .xls that is NOT Mirus stays unsupported (other flows need .xlsx)', () => {
    const r = classifyProbe(probe('umsatz.xls', { kind: 'sheet', rows: [HEADER, ['Gesamt', '1', '2', '3', '4']], legacy: true }));
    expect(r.status).toBe('unsupported');
    expect(r.reasons).toContain('legacy-xls');
  });

  it('recognises the category analysis sheet', () => {
    const r = classifyProbe(sheet('Umsatzanalyse.xlsx', CAT_ROWS));
    expect(r.status).toBe('recognised');
    expect(r.typeId).toBe('umsatzkategorien');
  });

  it('recognises the feedback CSV through the importer\'s own parser', () => {
    const r = classifyProbe(text('feedback.csv', FEEDBACK_CSV));
    expect(r.status).toBe('recognised');
    expect(r.typeId).toBe('rezensionen');
  });

  it('does not take a Foratable CSV for feedback', () => {
    expect(classifyProbe(text('res.csv', RES_CSV)).typeId).toBe('foratable-reservationen');
  });
});

describe('Gastronovi KPI CSV exports (same files the existing KPI import accepts)', () => {
  const header = '"Bezeichnung"\t"Zeitraum"\t"01.06."\t"02.06."';
  it('Anzahl Personen CSV is recognised via the «P.» unit', () => {
    const body = `${header}\n"Gesamt"\t"558 P."\t"263 P."\t"295 P."\n`;
    expect(classifyProbe(text('Anzahl_Personen.csv', body))).toMatchObject({ status: 'recognised', typeId: 'gn-kpi-pdf' });
  });
  it('Durchschnittsbon CSV is recognised via the Gastronovi file name', () => {
    const body = `${header}\n"Durchschnitt"\t"CHF 54,07"\t"CHF 45,22"\t"CHF 55,52"\n`;
    expect(classifyProbe(text('Durchschnittsbon.csv', body))).toMatchObject({ status: 'recognised', typeId: 'gn-kpi-pdf' });
  });
  it('a CHF CSV with an ambiguous name stays unrecognised (never guessed)', () => {
    const body = `${header}\n"Durchschnitt"\t"CHF 54,07"\t"CHF 45,22"\t"CHF 55,52"\n`;
    expect(classifyProbe(text('export.csv', body)).status).not.toBe('recognised');
  });
});

describe('KPI kind is carried so the weekly card can show the right file per row', () => {
  const header = '"Bezeichnung"\t"Zeitraum"\t"01.06."\t"02.06."';
  it('CSV: Anzahl Personen / Durchschnittsbon', () => {
    expect(classifyProbe(text('Anzahl_Personen.csv', `${header}\n"Gesamt"\t"558 P."\t"263 P."\t"295 P."\n`)).meta?.kpiKind).toBe('anzahl_personen');
    expect(classifyProbe(text('Durchschnittsbon.csv', `${header}\n"Durchschnitt"\t"CHF 54,07"\t"CHF 45,22"\t"CHF 55,52"\n`)).meta?.kpiKind).toBe('durchschnittsbon');
  });
});
