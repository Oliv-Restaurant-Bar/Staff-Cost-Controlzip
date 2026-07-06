// @vitest-environment node
/**
 * Tests für den Tabelle2-Buchhaltungs-Export (tagesabschluss-export.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  TABELLE2_HEADERS,
  buildTabelle2Csv,
  buildTabelle2Rows,
  formatBookingAmount,
  isoToChDate,
  tabelle2ToExportTable,
  validateExpenses,
  validateExportSettings,
} from './tagesabschluss-export';
import {
  buildTagesabschlussRows,
  defaultExportSettings,
  emptyTagesabschlussBlob,
  setTagesabschlussOverride,
  upsertExpense,
  upsertManualDay,
  type CashExpense,
  type GnDayClosing,
  type TagesabschlussExportSettings,
} from './tagesabschluss';

const NOW = '2026-07-06T10:00:00.000Z';

function makeClosing(date: string, over: Partial<GnDayClosing> = {}): GnDayClosing {
  return {
    date,
    grossRevenue: 1000,
    netRevenue: 925.07,
    tip: null,
    taxes: [{ rate: '8.1%', net: 925.07, tax: 74.93, gross: 1000 }],
    payments: [
      { name: 'Bar', count: 10, amount: 300 },
      { name: 'Mastercard', count: 8, amount: 400 },
      { name: 'VISA', count: 3, amount: 150 },
      { name: 'TWINT', count: 4, amount: 100 },
      { name: 'Rechnung', count: 1, amount: 30 },
      { name: 'Gutschein', count: 1, amount: 20 },
    ],
    accountingLines: [],
    paymentAccounts: [],
    ...over,
  };
}

function reviewedSettings(over: Partial<TagesabschlussExportSettings> = {}): TagesabschlussExportSettings {
  return {
    ...defaultExportSettings(NOW),
    mwstCodes: { '8.1%': 'U81' },
    reviewed: true,
    ...over,
  };
}

function monthFixture() {
  const closings = { '2026-07-01': makeClosing('2026-07-01') };
  const blob = emptyTagesabschlussBlob();
  const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
  return { closings, blob, rows };
}

describe('isoToChDate / formatBookingAmount', () => {
  it('formatiert Datum und Beträge fürs Buchungs-CSV', () => {
    expect(isoToChDate('2026-07-01')).toBe('01.07.2026');
    expect(isoToChDate('kaputt')).toBe('kaputt');
    expect(formatBookingAmount(300)).toBe('300.00');
    expect(formatBookingAmount(74.93)).toBe('74.93');
    expect(formatBookingAmount(-12.5)).toBe('-12.50');
  });
});

describe('validateExportSettings', () => {
  it('blockiert ohne Einstellungen, ohne reviewed und bei fehlenden Konten/Codes', () => {
    const { closings, rows } = monthFixture();
    expect(validateExportSettings(null, rows, closings).ok).toBe(false);

    const unreviewed = { ...reviewedSettings(), reviewed: false };
    const v1 = validateExportSettings(unreviewed, rows, closings);
    expect(v1.ok).toBe(false);
    expect(v1.errors.join(' ')).toMatch(/geprüft/);

    const missingKonto = reviewedSettings();
    missingKonto.konten = { ...missingKonto.konten, kasse: '' };
    const v2 = validateExportSettings(missingKonto, rows, closings);
    expect(v2.ok).toBe(false);
    expect(v2.errors.join(' ')).toMatch(/Kasse/);

    const missingCode = reviewedSettings({ mwstCodes: {} });
    const v3 = validateExportSettings(missingCode, rows, closings);
    expect(v3.ok).toBe(false);
    expect(v3.errors.join(' ')).toMatch(/8\.1%/);

    expect(validateExportSettings(reviewedSettings(), rows, closings).ok).toBe(true);
  });
});

describe('validateExpenses', () => {
  it('meldet fehlendes Konto und fehlenden Betrag', () => {
    const errors = validateExpenses([
      { id: 'a', date: '2026-07-01', amount: 0, konto: '', text: 'X', updatedAt: NOW },
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/Konto fehlt/);
    expect(errors[1]).toMatch(/Betrag/);
  });
});

describe('buildTabelle2Rows', () => {
  it('liefert bei unvollständigem Mapping Fehler und KEINE Zeilen', () => {
    const { closings, blob, rows } = monthFixture();
    const out = buildTabelle2Rows(rows, closings, blob, { ...reviewedSettings(), reviewed: false });
    expect(out.rows).toHaveLength(0);
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it('bucht Umsatz gesammelt je Steuersatz über das Durchlaufkonto', () => {
    const { closings, blob, rows } = monthFixture();
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    expect(out.errors).toHaveLength(0);
    const revenue = out.rows.filter(r => r.kto === '1098' && r.gkto === '3000');
    expect(revenue).toHaveLength(1);
    expect(revenue[0].netto).toBe(925.07);
    expect(revenue[0].steuer).toBe(74.93);
    expect(revenue[0].code).toBe('U81');
    expect(revenue[0].datum).toBe('01.07.2026');
  });

  it('bucht die Zahlungsmittel-Seite: Barumsatz berechnet, Karten je Zahlungsart', () => {
    const { closings, blob, rows } = monthFixture();
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    // Barumsatz = 1000 − 550 − 100 − 30 − 20 = 300 auf Kasse.
    const barRow = out.rows.find(r => r.kto === '1000' && r.gkto === '1098');
    expect(barRow?.netto).toBe(300);
    // Visa auf 1112, TWINT auf 1119; Mastercard hat kein Mapping → Sammelkonto 1110.
    expect(out.rows.find(r => r.kto === '1112')?.netto).toBe(150);
    expect(out.rows.find(r => r.kto === '1119')?.netto).toBe(100);
    expect(out.rows.find(r => r.kto === '1110')?.netto).toBe(400);
    // Debitoren + eingelöste Gutscheine.
    expect(out.rows.find(r => r.kto === '1100')?.netto).toBe(30);
    expect(out.rows.find(r => r.kto === '2003' && r.gkto === '1098')?.netto).toBe(20);
  });

  it('exportiert Barausgaben EINZELN mit Text/Beleg/Code, Einzahlung Bank separat', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    const e1: CashExpense = { id: 'e1', date: '2026-07-01', amount: 45.5, konto: '6000', text: 'Blumen', belegNr: 'B-7', mwstCode: 'V81', updatedAt: NOW };
    const e2: CashExpense = { id: 'e2', date: '2026-07-01', amount: 12, konto: '6510', gegenkonto: '1001', text: 'Porto', updatedAt: NOW };
    blob = upsertExpense(blob, e1);
    blob = upsertExpense(blob, e2);
    blob = upsertManualDay(blob, '2026-07-01', { einzahlungBank: 250 }, NOW);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    expect(out.errors).toHaveLength(0);

    const exp1 = out.rows.find(r => r.tx1 === 'Blumen');
    expect(exp1?.kto).toBe('6000');
    expect(exp1?.gkto).toBe('1000'); // Default-Gegenkonto Kasse
    expect(exp1?.blg).toBe('B-7');
    expect(exp1?.code).toBe('V81');
    expect(exp1?.netto).toBe(45.5);

    const exp2 = out.rows.find(r => r.tx1 === 'Porto');
    expect(exp2?.gkto).toBe('1001'); // explizites Gegenkonto

    const bank = out.rows.find(r => r.kto === '1020' && r.gkto === '1000');
    expect(bank?.netto).toBe(250);
  });

  it('Barausgabe ohne Konto blockiert den Export komplett', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = upsertExpense(blob, { id: 'e1', date: '2026-07-01', amount: 10, konto: '', text: 'X', updatedAt: NOW });
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    expect(out.rows).toHaveLength(0);
    expect(out.errors.join(' ')).toMatch(/Konto fehlt/);
  });

  it('Korrekturen (Overrides) ändern den Export NICHT — Originale bleiben, Warnung wird gelistet', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = setTagesabschlussOverride(blob, '2026-07-01', 'rechnung', 30, 50, 'Nachtrag', NOW);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());

    // Export nutzt ORIGINAL-Z-Bericht-Werte: Rechnung 30, Barumsatz 300.
    expect(out.rows.find(r => r.kto === '1100')?.netto).toBe(30);
    expect(out.rows.find(r => r.kto === '1000' && r.gkto === '1098')?.netto).toBe(300);

    // Durchlaufkonto 1098 bleibt in Balance (Soll = Haben).
    const soll = out.rows.filter(r => r.kto === '1098').reduce((s, r) => s + r.netto + r.steuer, 0);
    const haben = out.rows.filter(r => r.gkto === '1098').reduce((s, r) => s + r.netto, 0);
    expect(Math.round(soll * 100) / 100).toBe(Math.round(haben * 100) / 100);

    // Die Korrektur wird EXPLIZIT als Warnung ausgewiesen (manuell nachbuchen).
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/01\.07\.2026/);
    expect(out.warnings[0]).toMatch(/Rechnung/);
    expect(out.warnings[0]).toMatch(/30\.00 → 50\.00/);
    expect(out.warnings[0]).toMatch(/manuell/);
  });

  it('ohne Korrekturen: keine Warnungen', () => {
    const { closings, blob, rows } = monthFixture();
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    expect(out.warnings).toHaveLength(0);
  });

  it('Tage ohne Z-Bericht erzeugen keine Umsatzbuchungen', () => {
    const { closings, blob } = monthFixture();
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    const dates = new Set(out.rows.map(r => r.datum));
    expect(dates).toEqual(new Set(['01.07.2026']));
  });

  it('fortlaufende Belegnummern ab blgStart; Beleg der Ausgabe hat Vorrang', () => {
    const { closings, blob, rows } = monthFixture();
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings({ blgStart: '100' }));
    expect(out.rows[0].blg).toBe('100');
    expect(out.rows.every(r => r.blg !== '')).toBe(true);
    const nums = out.rows.map(r => parseInt(r.blg, 10));
    expect(new Set(nums).size).toBe(nums.length); // je Buchung eine Nummer (Umsatz-Zeilen teilen den Beleg)
  });
});

describe('CSV-Serialisierung', () => {
  it('20 Spalten, Semikolon, CRLF, BOM, dd.MM.yyyy, 2-Dezimal-Beträge', () => {
    const { closings, blob, rows } = monthFixture();
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    const table = tabelle2ToExportTable(out.rows, 'tagesabschluss-2026-07');
    expect(table.headers).toHaveLength(20);
    expect(table.headers).toEqual([...TABELLE2_HEADERS]);
    expect(table.rows.every(r => r.length === 20)).toBe(true);

    const csv = buildTabelle2Csv(out.rows, 'tagesabschluss-2026-07');
    expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(TABELLE2_HEADERS.join(';'));
    expect(lines[1]).toContain('01.07.2026');
    expect(lines[1]).toContain('925.07');
    expect(lines[1]).toContain('74.93');
  });
});
