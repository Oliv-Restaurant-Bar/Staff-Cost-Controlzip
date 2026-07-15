// @vitest-environment node
/**
 * Runde 2.6 — Rundungs- und Ampelkonsistenz (T006/T007).
 *
 * Prüft die vereinheitlichte Regel: Ampel-/Vorzeichenentscheide laufen IMMER
 * auf dem fachlichen Rohwert, nie auf dem gerundeten Anzeigestring; Excel
 * erhält echte Zahlenzellen mit Rohwerten, die Rundung passiert ausschliesslich
 * über das Zellformat. Ausschliesslich synthetische Daten, keine DB/DOM.
 */
import { describe, it, expect, vi } from 'vitest';
import * as XLSX from 'xlsx';
import {
  warenPctTone,
  personalPctTone,
  vollstaendigkeitTone,
  pkQuoteTone,
  exportMonatsdatenToExcel,
  type MonatsdatenRow,
} from '../reporting-export';

vi.mock('xlsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('xlsx')>();
  return { ...actual, writeFile: vi.fn() };
});

// ─── Ampelschwellen auf dem Rohwert (T007) ─────────────────────────────────

describe('warenPctTone (Rohwert-Ampel)', () => {
  it('33.04 % ist kritisch — obwohl die Anzeige «33.0 %» zeigt (alter parseFloat-Bug)', () => {
    // Regression: parseFloat('33.0') <= 33 hätte fälschlich nicht-kritisch ergeben.
    expect(parseFloat((33.04).toFixed(1))).toBeLessThanOrEqual(33);
    expect(warenPctTone(33.04)).toBe('critical');
  });

  it('Grenzen: exakt 33 → warn, exakt 28 → good, 28.04 → warn', () => {
    expect(warenPctTone(33)).toBe('warn');
    expect(warenPctTone(28)).toBe('good');
    expect(warenPctTone(28.04)).toBe('warn');
  });
});

describe('personalPctTone (Rohwert-Ampel, Ziel 40 %)', () => {
  it('40.04 % ist warn — Anzeige «40.0 %» wäre auf Stringbasis noch good', () => {
    expect(personalPctTone(40.04, 40)).toBe('warn');
    expect(personalPctTone(40, 40)).toBe('good');
  });

  it('45.04 % ist kritisch (Ziel + 5 überschritten)', () => {
    expect(personalPctTone(45.04, 40)).toBe('critical');
    expect(personalPctTone(45, 40)).toBe('warn');
  });
});

describe('vollstaendigkeitTone (Rohwert-Ampel)', () => {
  it('79.96 % ist warn — gerundete Anzeige «80 %» wäre fälschlich good', () => {
    expect(Math.round(79.96)).toBe(80);
    expect(vollstaendigkeitTone(79.96)).toBe('warn');
    expect(vollstaendigkeitTone(80)).toBe('good');
  });

  it('49.96 % ist kritisch, 50 % ist warn', () => {
    expect(vollstaendigkeitTone(49.96)).toBe('critical');
    expect(vollstaendigkeitTone(50)).toBe('warn');
  });
});

describe('pkQuoteTone (Rohwert-Ampel, Ziel 40 %, Toleranz ±2)', () => {
  it('42.04 % ist kritisch — Anzeige «42.0 %» wäre auf Stringbasis noch warn', () => {
    expect(pkQuoteTone(42.04, 40)).toBe('critical');
    expect(pkQuoteTone(42, 40)).toBe('warn');
  });

  it('37.96 % ist good, 38.04 % ist warn', () => {
    expect(pkQuoteTone(37.96, 40)).toBe('good');
    expect(pkQuoteTone(38.04, 40)).toBe('warn');
  });
});

describe('Vorzeichenentscheid auf dem Rohwert', () => {
  it('-0.04 % rundet in der Anzeige auf «-0.0 %», bleibt aber fachlich negativ (rot)', () => {
    const abw = -0.04;
    // Anzeigestring suggeriert null-Abweichung …
    expect(`${abw >= 0 ? '+' : ''}${abw.toFixed(1)} %`).toBe('-0.0 %');
    // … der Rohwert-Entscheid bleibt korrekt negativ.
    expect(abw >= 0).toBe(false);
  });
});

// ─── Excel: echte Zahlenzellen mit Rohwerten (T006) ────────────────────────

function makeRow(overrides: Partial<MonatsdatenRow> = {}): MonatsdatenRow {
  return {
    monat: 'Jan',
    umsatzIst: 100000.4,
    umsatzBudget: 95000,
    umsatzVorjahr: 90000,
    abwBudgetPct: 5.26,
    abwVorjahrPct: 11.56,
    warenaufwand: 28047.6,
    warenPct: 28.0464,
    personalaufwand: 40016.3,
    personalPct: 40.0463,
    pkIst: 39000.2,
    pkER: 40016.3,
    pkPlan: 38000,
    vollstaendigkeit: 79.96,
    ...overrides,
  };
}

function exportAndGetSheet(rows: MonatsdatenRow[]): XLSX.WorkSheet {
  (XLSX.writeFile as unknown as ReturnType<typeof vi.fn>).mockClear();
  exportMonatsdatenToExcel(rows, 2026, 'Testbetrieb', 40, 'oliv');
  const calls = (XLSX.writeFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBe(1);
  const wb = calls[0][0] as XLSX.WorkBook;
  return wb.Sheets[wb.SheetNames[0]];
}

describe('exportMonatsdatenToExcel — Zahlenbasis', () => {
  it('schreibt ROHWERTE in echte Zahlenzellen (keine toFixed-Strings)', () => {
    const ws = exportAndGetSheet([makeRow()]);
    // Erste Datenzeile = Zeile 5 (0-basiert r=4). Waren % ist Spalte F.
    const warenCell = ws['F5'];
    expect(warenCell.t).toBe('n');
    expect(warenCell.v).toBe(28.0464); // Rohwert, NICHT 28.0
    // Umsatz Ist (B5) ungerundeter Rohwert
    expect(ws['B5'].t).toBe('n');
    expect(ws['B5'].v).toBe(100000.4);
    // Vollständigkeit (K5) Rohwert, nicht Math.round
    expect(ws['K5'].v).toBe(79.96);
  });

  it('rundet NUR über das Zellformat (z), nicht in der Zahl', () => {
    const ws = exportAndGetSheet([makeRow()]);
    expect(ws['F5'].z).toBe('0.0" %"');        // Quote: 1 Dezimalstelle
    expect(ws['B5'].z).toBe('"CHF "#\'##0');   // CHF: ganze Franken
    expect(ws['K5'].z).toBe('0" %"');          // Vollständigkeit: ganzzahlig
  });

  it('fehlende Werte bleiben leere Zellen — nie 0', () => {
    const ws = exportAndGetSheet([
      makeRow({ umsatzBudget: null, warenaufwand: null, warenPct: null, vollstaendigkeit: 0 }),
    ]);
    expect(ws['C5']).toBeUndefined(); // Budget fehlt → leere Zelle
    expect(ws['E5']).toBeUndefined(); // Warenaufwand fehlt
    expect(ws['F5']).toBeUndefined(); // Waren % fehlt
    expect(ws['K5']).toBeUndefined(); // Vollständigkeit 0 → leer
  });

  it('Total-Quote wird aus den ROHEN Summen gerechnet, nicht aus gerundeten Werten', () => {
    const rows = [
      makeRow({ monat: 'Jan', umsatzIst: 100000, warenaufwand: 28040 }),
      makeRow({ monat: 'Feb', umsatzIst: 100000, warenaufwand: 28040 }),
    ];
    const ws = exportAndGetSheet(rows);
    // Total-Zeile = r=6 (0-basiert), Waren % Spalte F → F7
    expect(ws['F7'].v).toBeCloseTo((56080 / 200000) * 100, 10);
  });
});

describe('de-CH-Anzeigeformat bleibt von der Rohbasis unberührt', () => {
  it('Intl de-CH rundet 28.0464 auf «28.0» — nur in der ANZEIGE', () => {
    const display = new Intl.NumberFormat('de-CH', {
      minimumFractionDigits: 1, maximumFractionDigits: 1,
    }).format(28.0464);
    expect(display).toBe('28.0');
    // Fachentscheid nutzt weiterhin den Rohwert:
    expect(warenPctTone(28.0464)).toBe('warn');
  });
});
