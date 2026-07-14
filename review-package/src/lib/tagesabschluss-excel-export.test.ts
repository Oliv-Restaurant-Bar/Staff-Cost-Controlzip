// @vitest-environment node
/**
 * Tests für den Excel-Export der Tagesabschluss-Übersicht
 * (tagesabschluss-excel-export.ts) — Datenaufbereitung + Workbook-Aufbau.
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  TAGESABSCHLUSS_EXCEL_HEADERS,
  buildTagesabschlussExcelData,
  buildTagesabschlussExcelWorkbook,
  excelDateSerial,
  excelKkAdyenValue,
  tagesabschlussExcelFilename,
} from './tagesabschluss-excel-export';
import {
  buildTagesabschlussRows,
  emptyTagesabschlussBlob,
  setCashDiffReasons,
  setTagesabschlussComment,
  setTagesabschlussOverride,
  upsertManualDay,
  type GnDayClosing,
} from './tagesabschluss';
import {
  emptyAdyenBlob,
  type AdyenAbstimmungBlob,
  type AdyenStoredDay,
} from './adyen-abstimmung';

const NOW = '2026-07-06T10:00:00.000Z';
const LATER = '2026-07-07T10:00:00.000Z';

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

function makeAdyenDay(byMethod: Record<string, number>): AdyenStoredDay {
  return {
    byMethod,
    countByMethod: {},
    total: Object.values(byMethod).reduce((s, v) => s + v, 0),
    transactionCount: 5,
    fileName: 'adyen.csv',
    importedAt: NOW,
  };
}

/** Standard-Monat: 2 Tage mit Z-Bericht, Startsaldo 500, manuelle Werte + Override. */
function buildFixtureMonth() {
  const closings = {
    '2026-07-01': makeClosing('2026-07-01'),
    '2026-07-02': makeClosing('2026-07-02'),
  };
  let blob = emptyTagesabschlussBlob();
  blob = upsertManualDay(blob, '2026-07-01', {
    bestandKasse: 480,
    einzahlungBank: 200,
    bemerkung: 'Kasse gezählt',
  }, NOW);
  // Umsatz-Override am 2. Tag: Effektivwert 1100 statt Import 1000.
  blob = setTagesabschlussOverride(blob, '2026-07-02', 'umsatz', 1000, 1100, undefined, NOW);
  // Feld-Kommentar am 1. Tag + tombstoned Kommentar (gesetzt, dann gelöscht).
  blob = setTagesabschlussComment(blob, '2026-07-01', 'rechnung', 'Debitor Muster', NOW);
  blob = setTagesabschlussComment(blob, '2026-07-01', 'twint', 'wird gelöscht', NOW);
  blob = setTagesabschlussComment(blob, '2026-07-01', 'twint', '', LATER);
  // Kassendifferenz-Begründung (nur Notiz).
  blob = setCashDiffReasons(blob, '2026-07-01', [], 'Rundung Münz', NOW);
  return { closings, blob };
}

describe('tagesabschlussExcelFilename', () => {
  it('bildet tagesabschluesse_YYYY-MM.xlsx', () => {
    expect(tagesabschlussExcelFilename('2026-07')).toBe('tagesabschluesse_2026-07.xlsx');
  });
});

describe('buildTagesabschlussExcelData', () => {
  it('exportiert nur Tage mit Daten (Status „fehlt" ausgelassen) mit Effektivwerten als echte Zahlen', () => {
    const { closings, blob } = buildFixtureMonth();
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 500);
    const data = buildTagesabschlussExcelData(month);

    expect(data.header).toEqual([...TAGESABSCHLUSS_EXCEL_HEADERS]);
    expect(data.rows).toHaveLength(2); // 31 Kalendertage, aber nur 2 mit Daten
    const [d1, d2] = data.rows;

    expect(d1[0]).toBe('2026-07-01');
    expect(d1[1]).toBe(1000);              // Umsatz (Import)
    expect(d1[2]).toBe(300);               // Bargeld Soll = 1000−550−100−30−20
    expect(d1[3]).toBe(600);               // Kassensaldo = 500+300−200
    expect(d1[4]).toBeNull();              // KK Adyen — kein Adyen-Import
    expect(d1[5]).toBeNull();              // Barausgaben — keine erfasst
    expect(d1[6]).toBe(30);                // Debitoren
    expect(d1[9]).toBe(200);               // Einzahlung Bank (manuell)
    expect(d1[10]).toBe(-120);             // Kassendifferenz = 480 − 600
    for (const idx of [1, 2, 3, 6, 9, 10]) expect(typeof d1[idx]).toBe('number');

    expect(d2[0]).toBe('2026-07-02');
    expect(d2[1]).toBe(1100);              // Umsatz-Override, NICHT der Importwert
    expect(d2[2]).toBe(400);               // Bargeld Soll mit Effektiv-Umsatz
    expect(d2[3]).toBe(1000);              // Kassensaldo = 600+400−0
    expect(d2[10]).toBeNull();             // kein Cash Ist → keine Differenz
  });

  it('Kommentar-Spalte: Bemerkung + Feld-Kommentare + Differenz-Begründung; Tombstones fehlen', () => {
    const { closings, blob } = buildFixtureMonth();
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 500);
    const data = buildTagesabschlussExcelData(month);
    const kommentar = String(data.rows[0][11]);
    expect(kommentar).toContain('Kasse gezählt');
    expect(kommentar).toContain('Rechnung / Debitoren: Debitor Muster');
    expect(kommentar).toContain('Kassendifferenz: Rundung Münz');
    expect(kommentar).not.toContain('wird gelöscht'); // tombstoned Kommentar
    expect(data.rows[1][11]).toBeNull();              // Tag 2 ohne Kommentar
  });

  it('KK Adyen: Adyen-Import-Total; bei karten-Override der effektive Z-KK-Wert (karten+TWINT)', () => {
    const { closings } = buildFixtureMonth();
    let blob = emptyTagesabschlussBlob();
    blob = setTagesabschlussOverride(blob, '2026-07-02', 'karten', 550, 600, undefined, NOW);
    const adyenBlob: AdyenAbstimmungBlob = {
      ...emptyAdyenBlob(),
      days: {
        '2026-07-01': makeAdyenDay({ mastercard: 400, visa: 150, twint: 100 }),
        '2026-07-02': makeAdyenDay({ mastercard: 400, visa: 150, twint: 100 }),
      },
    };
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {}, adyenBlob, 500);
    const data = buildTagesabschlussExcelData(month);
    expect(data.rows[0][4]).toBe(650);   // Adyen-Import-Total
    expect(data.rows[1][4]).toBe(700);   // Override 600 + TWINT 100 (Doppelsemantik)
    expect(excelKkAdyenValue(month.rows[1])).toBe(700);
  });

  it('Summenzeile: Spaltensummen, Kassensaldo = Monatsend-Saldo, ohne Anker null', () => {
    const { closings, blob } = buildFixtureMonth();
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 500);
    const { totalsRow } = buildTagesabschlussExcelData(month);
    expect(totalsRow[0]).toBe('Total');
    expect(totalsRow[1]).toBe(2100);   // Umsatz 1000 + 1100
    expect(totalsRow[2]).toBe(700);    // Bargeld Soll 300 + 400
    expect(totalsRow[3]).toBe(1000);   // Monatsend-Saldo, KEINE Summe
    expect(totalsRow[6]).toBe(60);     // Debitoren 30 + 30
    expect(totalsRow[9]).toBe(200);    // Einzahlung Bank
    expect(totalsRow[10]).toBe(-120);  // Kassendifferenzen
    expect(totalsRow[11]).toBeNull();

    const ohneAnker = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, null);
    const dataOhne = buildTagesabschlussExcelData(ohneAnker);
    expect(dataOhne.totalsRow[3]).toBeNull(); // kein Anker → kein Saldo
    expect(dataOhne.rows[0][3]).toBeNull();
  });
});

describe('excelDateSerial', () => {
  it('ist deterministisch (UTC) und fortlaufend', () => {
    expect(excelDateSerial('1970-01-01')).toBe(25569);
    expect(excelDateSerial('2026-07-02') - excelDateSerial('2026-07-01')).toBe(1);
    expect(excelDateSerial('2026-03-01') - excelDateSerial('2026-02-28')).toBe(1); // kein Schaltjahr
  });
});

describe('buildTagesabschlussExcelWorkbook', () => {
  it('schreibt echte Datums- und Zahlenzellen mit Formaten und Summenzeile', () => {
    const { closings, blob } = buildFixtureMonth();
    const month = buildTagesabschlussRows(2026, 7, closings, blob, {}, null, 500);
    const data = buildTagesabschlussExcelData(month);
    const wb = buildTagesabschlussExcelWorkbook(data);
    const ws = wb.Sheets['Tagesabschlüsse'];
    expect(ws).toBeDefined();

    const a1 = ws['A1'];
    expect(a1.v).toBe('Datum');
    const a2 = ws['A2'];
    expect(a2.t).toBe('n');                             // echte Zahl (Datums-Serial)
    expect(a2.v).toBe(excelDateSerial('2026-07-01'));
    expect(a2.z).toBe('dd.mm.yyyy');
    const b2 = ws['B2'];
    expect(b2.t).toBe('n');                             // Umsatz als echte Zahl
    expect(b2.v).toBe(1000);
    expect(b2.z).toBe('#,##0.00');
    const l2 = ws['L2'];
    expect(l2.t).toBe('s');                             // Kommentar als Text

    const a4 = ws['A4'];                                // Header + 2 Tage → Zeile 4 = Total
    expect(a4.v).toBe('Total');
    expect(ws['B4'].v).toBe(2100);
    expect(ws['B4'].z).toBe('#,##0.00');
  });
});
