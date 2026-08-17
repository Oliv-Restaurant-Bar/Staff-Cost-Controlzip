// @vitest-environment happy-dom
// (node ginge nicht: umsatz-kategorien → supabase-kv → supabase-client braucht localStorage)
/**
 * Tests «Umsatzanalyse Kategorien»: Parser (breites Excel-Format mit
 * Gruppen-Köpfen, «> »-Unterkategorien, Sonderzeilen) und Auswertung
 * (Jahr-Filter, Zeitraum min–max, Anteil %, leer statt 0).
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  parseUmsatzKategorienExcel, berechneKatAuswertung, parseTagKopf,
  type UmsatzKategorienBlob,
} from '../umsatz-kategorien';

function buildXlsx(rows: unknown[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Blatt1');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return out;
}

const KOPF = ['Bezeichnung', 'Gesamtbetrag im Anzeigezeitraum', '01.01.2026', '02.01.2026', '24.08.2026'];

describe('parseUmsatzKategorienExcel', () => {
  it('parst Gruppen, Unterkategorien und Tageswerte; ignoriert Spalte B und Sonderzeilen', () => {
    const buf = buildXlsx([
      KOPF,
      ['Food (Speisen)', 999, '', '', ''],
      ['> Pasta', 999, 100, 50, 25],
      ['> Pizza', 999, 200, '', 75.5],
      ['Beverage (Getränke)', 999, '', '', ''],
      ['> Wein', 999, 40, 10, ''],
      ['Rabatte', 999, -5, -5, -5],
      ['> Rabatt intern', 999, -1, -1, -1],   // gehört zum Sonderblock → ignorieren
      ['Trinkgeld', 999, 9, 9, 9],
      ['Gesamt', 999, 400, 400, 400],
    ]);
    const r = parseUmsatzKategorienExcel(buf);
    expect(r.failureReason).toBeNull();
    expect(r.debug.tagesSpalten).toBe(3);
    expect(r.debug.gruppenGefunden).toEqual(['Food (Speisen)', 'Beverage (Getränke)']);
    const keys = r.eintraege.map(e => `${e.datum}|${e.gruppe}|${e.kategorie}`).sort();
    expect(keys).toEqual([
      '2026-01-01|beverage|Wein', '2026-01-01|food|Pasta', '2026-01-01|food|Pizza',
      '2026-01-02|beverage|Wein', '2026-01-02|food|Pasta',
      '2026-08-24|food|Pasta', '2026-08-24|food|Pizza',
    ]);
    const pizza = r.eintraege.find(e => e.kategorie === 'Pizza' && e.datum === '2026-08-24');
    expect(pizza?.umsatz).toBe(75.5);
    // Keine Sonderzeilen im Ergebnis
    expect(r.eintraege.some(e => /rabatt|trinkgeld|gesamt/i.test(e.kategorie))).toBe(false);
  });

  it('summiert doppelte Kategorien-Zeilen pro Tag (Ersetzen erst beim Import, hier Summe der Datei)', () => {
    const buf = buildXlsx([
      KOPF,
      ['Food (Speisen)', 0, '', '', ''],
      ['> Pasta', 0, 10, '', ''],
      ['> Pasta', 0, 5, '', ''],
    ]);
    const r = parseUmsatzKategorienExcel(buf);
    expect(r.eintraege).toHaveLength(1);
    expect(r.eintraege[0].umsatz).toBe(15);
  });

  it('explizite 0 ist ein Tageswert (ersetzt beim Re-Upload alte Werte)', () => {
    const buf = buildXlsx([
      KOPF,
      ['Food (Speisen)', 0, '', '', ''],
      ['> Pasta', 0, 0, '', 25],
    ]);
    const r = parseUmsatzKategorienExcel(buf);
    expect(r.failureReason).toBeNull();
    const nullTag = r.eintraege.find(e => e.datum === '2026-01-01');
    expect(nullTag?.umsatz).toBe(0); // 0 kommt durch → überschreibt alten Wert
    expect(r.eintraege.some(e => e.datum === '2026-01-02')).toBe(false); // leer bleibt leer
  });

  it('1904-Datumssystem: Serial-Köpfe werden um 1462 Tage korrigiert', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Bezeichnung', 'Total', 44561, 44562], // 1904-Serials für 01./02.01.2026
      ['Food (Speisen)', 0, '', ''],
      ['> Pasta', 0, 10, 20],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'B1');
    wb.Workbook = { WBProps: { date1904: true } };
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const r = parseUmsatzKategorienExcel(buf);
    expect(r.failureReason).toBeNull();
    expect(r.eintraege.map(e => e.datum).sort()).toEqual(['2026-01-01', '2026-01-02']);
  });

  it('meldet failureReason mit Debug wenn keine Datumsspalten', () => {
    const r = parseUmsatzKategorienExcel(buildXlsx([['Bezeichnung', 'Total'], ['> Pasta', 10]]));
    expect(r.failureReason).toMatch(/Kopfzeile/);
    expect(r.eintraege).toHaveLength(0);
  });

  it('meldet failureReason wenn keine Gruppen-Köpfe', () => {
    const r = parseUmsatzKategorienExcel(buildXlsx([KOPF, ['> Pasta', 0, 10, 20, 30]]));
    expect(r.failureReason).toMatch(/Gruppen-Köpfe/);
  });
});

describe('parseTagKopf', () => {
  it('TT.MM.JJJJ, TT.MM.JJ, ISO und Excel-Serial', () => {
    expect(parseTagKopf('01.01.2026')).toBe('2026-01-01');
    expect(parseTagKopf('5.3.26')).toBe('2026-03-05');
    expect(parseTagKopf('2026-08-24')).toBe('2026-08-24');
    expect(parseTagKopf(46023)).toBe('2026-01-01'); // Excel-Serial (1900-System)
    expect(parseTagKopf('Bezeichnung')).toBeNull();
    expect(parseTagKopf('')).toBeNull();
    expect(parseTagKopf(999)).toBeNull(); // keine plausible Serial
  });
});

describe('berechneKatAuswertung', () => {
  const blob: UmsatzKategorienBlob = {
    werte: {
      '2026-01-01|food|Pasta': 100,
      '2026-08-24|food|Pasta': 50,
      '2026-01-01|food|Pizza': 300,
      '2026-03-10|beverage|Wein': 80,
      '2025-12-31|food|Pasta': 999,   // anderes Jahr → ignorieren
    },
  };

  it('summiert nur Jahr, sortiert absteigend, Anteil % korrekt, Zeitraum min–max', () => {
    const a = berechneKatAuswertung(blob, 2026);
    expect(a.zeitraum).toEqual({ von: '2026-01-01', bis: '2026-08-24' });
    expect(a.food.total).toBe(450);
    expect(a.food.zeilen.map(z => z.kategorie)).toEqual(['Pizza', 'Pasta']);
    expect(a.food.zeilen[0].anteilPct).toBeCloseTo(66.7, 1);
    expect(a.food.zeilen[1].anteilPct).toBeCloseTo(33.3, 1);
    expect(a.beverage.total).toBe(80);
    expect(a.beverage.zeilen[0].anteilPct).toBe(100);
  });

  it('leer statt 0: keine Daten → total null, zeilen leer, zeitraum null', () => {
    const a = berechneKatAuswertung({ werte: {} }, 2026);
    expect(a.zeitraum).toBeNull();
    expect(a.food.total).toBeNull();
    expect(a.food.zeilen).toEqual([]);
  });

  it('nie durch 0 teilen: Total 0 → anteilPct null', () => {
    const a = berechneKatAuswertung({ werte: { '2026-01-01|food|X': 0.0 } }, 2026);
    // 0-Werte werden beim Parsen gar nicht erzeugt; hier direkt im Blob:
    expect(a.food.total).toBe(0);
    expect(a.food.zeilen[0].anteilPct).toBeNull();
  });
});
