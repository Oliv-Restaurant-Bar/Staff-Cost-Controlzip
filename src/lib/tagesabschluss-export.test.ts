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
  type TagesabschlussBlob,
  type TagesabschlussExportSettings,
} from './tagesabschluss';

const NOW = '2026-07-06T10:00:00.000Z';

/** Markiert Tage als definitiv abgeschlossen (Export-Vorbedingung §10). */
function withClosedDays(blob: TagesabschlussBlob, dates: string[]): TagesabschlussBlob {
  const abschluesse = { ...blob.abschluesse };
  for (const d of dates) {
    abschluesse[d] = {
      status: 'abgeschlossen',
      closedAt: NOW,
      closedBy: 'test@oliv.ch',
      fixedKassensaldo: null,
      updatedAt: NOW,
      history: [{ at: NOW, by: 'test@oliv.ch', action: 'abschluss', status: 'abgeschlossen' }],
    };
  }
  return { ...blob, abschluesse };
}

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
    reviewed: true,
    ...over,
  };
}

function monthFixture() {
  const closings = { '2026-07-01': makeClosing('2026-07-01') };
  const blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
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
  it('blockiert ohne Einstellungen, ohne reviewed und bei fehlenden Konten', () => {
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

    expect(validateExportSettings(reviewedSettings(), rows, closings).ok).toBe(true);
  });

  it('LEGACY-Felder (umsatz-Konto, mwstCodes) werden NICHT mehr validiert', () => {
    const { closings, rows } = monthFixture();
    const s = reviewedSettings({ mwstCodes: {} });
    s.konten = { ...s.konten, umsatz: '' };
    expect(validateExportSettings(s, rows, closings).ok).toBe(true);
  });

  it('unklassifizierte Zahlart ohne Konto-Mapping blockiert den Export', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01', {
        payments: [
          { name: 'Bar', count: 10, amount: 960 },
          { name: 'KD Tisch 5000', count: 1, amount: 40 },
        ],
      }),
    };
    const blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});

    const withoutMapping = reviewedSettings({ kontoJeZahlungsart: {} });
    const v = validateExportSettings(withoutMapping, rows, closings);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/KD Tisch/);

    // Default-Settings enthalten kd_tisch_5000 → 1104: valide.
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
  it('BLOCKIERT, solange ein Z-Bericht-Tag nicht abgeschlossen ist (§10)', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    const blob = emptyTagesabschlussBlob(); // Tag NICHT abgeschlossen
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    expect(out.rows).toHaveLength(0);
    expect(out.errors.join(' ')).toMatch(/nicht abgeschlossen/);
    expect(out.errors.join(' ')).toMatch(/01\.07\.2026/);

    // Wieder geöffneter Tag zählt ebenfalls als nicht abgeschlossen.
    let reopened = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    reopened = {
      ...reopened,
      abschluesse: {
        '2026-07-01': { ...reopened.abschluesse['2026-07-01'], status: 'wieder_geoeffnet' },
      },
    };
    const r2 = buildTagesabschlussRows(2026, 7, closings, reopened, {});
    const out2 = buildTabelle2Rows(r2.rows, closings, reopened, reviewedSettings());
    expect(out2.rows).toHaveLength(0);
    expect(out2.errors.join(' ')).toMatch(/nicht abgeschlossen/);
  });

  it('liefert bei unvollständigem Mapping Fehler und KEINE Zeilen', () => {
    const { closings, blob, rows } = monthFixture();
    const out = buildTabelle2Rows(rows, closings, blob, { ...reviewedSettings(), reviewed: false });
    expect(out.rows).toHaveLength(0);
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it('Brutto-Modell: KEINE Umsatz-/MWST-Zeilen, kein Konto 2200/3000, keine Steuer-Spalte', () => {
    const { closings, blob, rows } = monthFixture();
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    expect(out.errors).toHaveLength(0);
    // Keine Zeile bucht das alte Ertragskonto oder eine MWST-Seite.
    expect(out.rows.some(r => r.kto === '3000' || r.gkto === '3000')).toBe(false);
    expect(out.rows.some(r => r.kto === '2200' || r.gkto === '2200')).toBe(false);
    expect(out.rows.every(r => r.steuer === 0)).toBe(true);
    // 1098 erscheint NUR als Haben-Seite (GKto) der Zahlweg-Zeilen.
    expect(out.rows.some(r => r.kto === '1098')).toBe(false);
  });

  it('Pflicht-Balance: Σ(Zeilen mit GKto = 1098) = Original-Tagesumsatz', () => {
    const { closings, blob, rows } = monthFixture();
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    const haben = out.rows
      .filter(r => r.gkto === '1098')
      .reduce((s, r) => s + r.netto, 0);
    expect(Math.round(haben * 100) / 100).toBe(1000);
  });

  it('bucht die Zahlungsmittel-Seite: Barumsatz berechnet, Karten je Zahlungsart', () => {
    const { closings, blob, rows } = monthFixture();
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    // Barumsatz = 1000 − 550 − 100 − 30 − 20 = 300 auf Kasse (1000).
    const barRow = out.rows.find(r => r.kto === '1000' && r.gkto === '1098');
    expect(barRow?.netto).toBe(300);
    // Default-Mapping: MC/Visa/TWINT bewusst ohne Einzelkonto → Sammel 1110.
    const sammel = out.rows.filter(r => r.kto === '1110');
    expect(sammel.map(r => r.netto).sort((a, b) => a - b)).toEqual([100, 150, 400]);
    // Debitoren (1100) + eingelöste Gutscheine (2003, Soll).
    expect(out.rows.find(r => r.kto === '1100')?.netto).toBe(30);
    expect(out.rows.find(r => r.kto === '2003' && r.gkto === '1098')?.netto).toBe(20);
  });

  it('bucht kartenähnliche Zahlarten SEPARAT und KD Tisch 5000 auf eigenes Konto (1104)', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01', {
        payments: [
          { name: 'Bar', count: 10, amount: 245 },
          { name: 'Mastercard', count: 8, amount: 400 },
          { name: 'TWINT', count: 4, amount: 100 },
          { name: 'Rechnung', count: 1, amount: 30 },
          { name: 'Gutschein', count: 1, amount: 20 },
          { name: 'American Express', count: 1, amount: 60 },
          { name: 'PostCard', count: 1, amount: 50 },
          { name: 'Lunch-Check', count: 1, amount: 35 },
          { name: 'Stripe', count: 1, amount: 20 },
          { name: 'KD Tisch 5000', count: 1, amount: 40 },
        ],
      }),
    };
    const blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    // Default-Settings: amex 1114, postcard 1116, lunch_check 1115,
    // stripe 1118, kd_tisch_5000 1104; MC/TWINT → Sammel 1110.
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    expect(out.errors).toHaveLength(0);

    expect(out.rows.find(r => r.tx1.startsWith('American Express'))?.kto).toBe('1114');
    expect(out.rows.find(r => r.tx1.startsWith('PostCard'))?.kto).toBe('1116');
    expect(out.rows.find(r => r.tx1.startsWith('PostCard'))?.netto).toBe(50);
    expect(out.rows.find(r => r.tx1.startsWith('Lunch-Check'))?.kto).toBe('1115');
    expect(out.rows.find(r => r.tx1.startsWith('Stripe'))?.kto).toBe('1118');

    // KD Tisch 5000 wird SEPARAT gebucht (1104, GKto 1098) — nie im Barumsatz.
    const kd = out.rows.find(r => /KD Tisch/i.test(r.tx1));
    expect(kd?.kto).toBe('1104');
    expect(kd?.gkto).toBe('1098');
    expect(kd?.netto).toBe(40);
    expect(kd?.kategorie).toBe('weitere_zahlungsarten');

    // Barumsatz = 1000 − karten(565) − twint(100) − rechnung(30)
    //             − gutschein(20) − KD Tisch(40) = 245.
    const barRow = out.rows.find(r => r.kto === '1000' && r.gkto === '1098');
    expect(barRow?.netto).toBe(245);

    // Balance: Zahlungsmittel-Seite (GKto 1098) deckt den Umsatz exakt.
    const haben = out.rows
      .filter(r => r.gkto === '1098')
      .reduce((s, r) => s + r.netto, 0);
    expect(Math.round(haben * 100) / 100).toBe(1000);
  });

  it('unklassifizierte Zahlart ohne Mapping: buildTabelle2Rows blockiert mit Fehler', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01', {
        payments: [
          { name: 'Bar', count: 10, amount: 960 },
          { name: 'KD Tisch 5000', count: 1, amount: 40 },
        ],
      }),
    };
    const blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings({ kontoJeZahlungsart: {} }));
    expect(out.rows).toHaveLength(0);
    expect(out.errors.join(' ')).toMatch(/KD Tisch/);
  });

  it('exportiert Barausgaben EINZELN mit Text/Beleg/Code', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    const e1: CashExpense = { id: 'e1', date: '2026-07-01', amount: 45.5, konto: '6000', text: 'Blumen', belegNr: 'B-7', mwstCode: 'V81', updatedAt: NOW };
    const e2: CashExpense = { id: 'e2', date: '2026-07-01', amount: 12, konto: '6510', gegenkonto: '1001', text: 'Porto', updatedAt: NOW };
    blob = upsertExpense(blob, e1);
    blob = upsertExpense(blob, e2);
    blob = withClosedDays(blob, ['2026-07-01']);
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
  });

  it('Einzahlung Bank erzeugt KEINE Buchungszeile und erscheint nicht im CSV', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { einzahlungBank: 250 }, NOW);
    blob = withClosedDays(blob, ['2026-07-01']);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    expect(out.errors).toHaveLength(0);

    // Keine Zeile auf das Bankkonto, keine Zeile mit Betrag 250, kein Text.
    expect(out.rows.some(r => r.kto === '1020' || r.gkto === '1020')).toBe(false);
    expect(out.rows.some(r => r.netto === 250)).toBe(false);
    expect(out.rows.some(r => r.tx1.includes('Einzahlung Bank'))).toBe(false);

    const csv = buildTabelle2Csv(out.rows, 'test.csv');
    expect(csv).not.toMatch(/Einzahlung Bank/);
    expect(csv).not.toMatch(/1020/);
  });

  it('Export bleibt trotz Einzahlung Bank ausgeglichen: Σ(GKto=1098) = Umsatz', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { einzahlungBank: 250 }, NOW);
    blob = withClosedDays(blob, ['2026-07-01']);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    expect(out.errors).toHaveLength(0);

    const transitSum = out.rows
      .filter(r => r.gkto === '1098')
      .reduce((sum, r) => sum + r.netto, 0);
    expect(Math.round(transitSum * 100) / 100).toBe(1000); // Original-Tagesumsatz
  });

  it('validateExportSettings verlangt KEIN Bank-Konto (Einzahlung Bank wird nicht exportiert)', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = upsertManualDay(blob, '2026-07-01', { einzahlungBank: 250 }, NOW);
    blob = withClosedDays(blob, ['2026-07-01']);
    const settings = reviewedSettings();
    settings.konten.bank = ''; // LEGACY-Feld leer → darf NICHT blockieren
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    expect(validateExportSettings(settings, rows, closings).ok).toBe(true);
    const out = buildTabelle2Rows(rows, closings, blob, settings);
    expect(out.errors).toHaveLength(0);
    expect(out.rows.length).toBeGreaterThan(0);
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
    blob = withClosedDays(blob, ['2026-07-01']);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());

    // Export nutzt ORIGINAL-Z-Bericht-Werte: Rechnung 30, Barumsatz 300.
    expect(out.rows.find(r => r.kto === '1100')?.netto).toBe(30);
    expect(out.rows.find(r => r.kto === '1000' && r.gkto === '1098')?.netto).toBe(300);

    // Balance: Σ(GKto = 1098) = Original-Umsatz — Korrekturen brechen sie nicht.
    const haben = out.rows.filter(r => r.gkto === '1098').reduce((s, r) => s + r.netto, 0);
    expect(Math.round(haben * 100) / 100).toBe(1000);

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
    expect(new Set(nums).size).toBe(nums.length); // je Buchungszeile eine eigene Nummer
  });

  it('emittiert KEINE Nullzeilen (Zahlarten/Felder mit Betrag 0 fehlen)', () => {
    const closings = {
      '2026-07-01': makeClosing('2026-07-01', {
        payments: [
          { name: 'Bar', count: 10, amount: 1000 },
          { name: 'Mastercard', count: 0, amount: 0 },
          { name: 'TWINT', count: 0, amount: 0 },
          { name: 'Rechnung', count: 0, amount: 0 },
          { name: 'KD Tisch 5000', count: 0, amount: 0 },
        ],
      }),
    };
    const blob = withClosedDays(emptyTagesabschlussBlob(), ['2026-07-01']);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    expect(out.errors).toHaveLength(0);
    // Nur die Barumsatz-Zeile — alle 0er-Zahlarten fehlen.
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].kto).toBe('1000');
    expect(out.rows[0].netto).toBe(1000);
    expect(out.rows.every(r => r.netto !== 0)).toBe(true);
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
    // Erste Buchungszeile = Barumsatz (Brutto-Modell, keine Umsatz-/MWST-Zeilen).
    expect(lines[1]).toContain('01.07.2026');
    expect(lines[1]).toContain('300.00');
    expect(csv).not.toContain('925.07');
    expect(csv).not.toContain('74.93');
  });

  it('quotet Zellen mit Komma (Spec §6) — Spalten verschieben sich nie', () => {
    const closings = { '2026-07-01': makeClosing('2026-07-01') };
    let blob = emptyTagesabschlussBlob();
    blob = upsertExpense(blob, {
      id: 'e1', date: '2026-07-01', amount: 10, konto: '6000',
      text: 'Blumen, Deko und Kerzen', updatedAt: NOW,
    });
    blob = withClosedDays(blob, ['2026-07-01']);
    const { rows } = buildTagesabschlussRows(2026, 7, closings, blob, {});
    const out = buildTabelle2Rows(rows, closings, blob, reviewedSettings());
    expect(out.errors).toHaveLength(0);
    const csv = buildTabelle2Csv(out.rows, 'tagesabschluss-2026-07');
    expect(csv).toContain('"Blumen, Deko und Kerzen"');
    // Jede Zeile behält exakt 20 Spalten (19 Semikola ausserhalb von Quotes).
    const lines = csv.slice(1).split('\r\n');
    for (const line of lines) {
      const cols = line.replace(/"[^"]*"/g, 'Q').split(';');
      expect(cols).toHaveLength(20);
    }
  });
});
