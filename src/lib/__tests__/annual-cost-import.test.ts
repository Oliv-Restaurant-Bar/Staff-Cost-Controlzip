// @vitest-environment node
/**
 * Jahres-Kontoblatt-Import (Sage, ganzes Geschäftsjahr) — Spec-1-Tests
 * =====================================================================
 * Deckt den Bugfix ab: «P&L 2025 zeigt nur einzelne Monate statt aller
 * gebuchten Monate».
 *
 * Getestet:
 *   A. ECHTE Datei (Kosten_Vorjahr_2025.XLSX): alle 12 Monate, Jahr aus
 *      dem Dateizeitraum, keine Buchung verloren.
 *   B. Synthetische Fixtures: Jahr aus Zeitraum-Kopf, Buchungsjahr-Filter,
 *      Total/Saldo-Zeilen, Text-Kontonummern, mehrjähriger Zeitraum → Abbruch,
 *      fehlender Kopf → Jahr aus Buchungen bzw. Abbruch bei Mehrdeutigkeit.
 *   C. buildExpenseCategoriesOnly: Ertrags-Negation + [Unzugeordnet].
 *   D. replaceAnnualCostYear: idempotent, ersetzt numerische Kategorien in
 *      allen 12 Monaten, behält manuelle Kategorien + Direktfelder,
 *      andere Jahre unberührt; removeAnnualCostYear entfernt sauber.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as XLSX from 'xlsx';

// ─── Mocks (vor Produktions-Imports, vi.mock wird gehoisted) ─────────────────

const localStorageStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
});

let kvStore: Record<string, unknown> = {};
vi.mock('@/lib/supabase-kv', () => ({
  kvGet: vi.fn(async (key: string) => kvStore[key] ?? null),
  kvSet: vi.fn(async (key: string, value: unknown) => { kvStore[key] = value; }),
  safeUpsertReportingMonth: vi.fn(async () => {}),
  safeDeleteReportingMonth: vi.fn(async () => {}),
}));
vi.mock('./supabase-kv', () => ({
  kvGet: vi.fn(async (key: string) => kvStore[key] ?? null),
  kvSet: vi.fn(async (key: string, value: unknown) => { kvStore[key] = value; }),
  safeUpsertReportingMonth: vi.fn(async () => {}),
  safeDeleteReportingMonth: vi.fn(async () => {}),
}));

// pdfjs-dist wird im Node-Umfeld nicht gebraucht (nur XLSX-Pfad getestet)
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
  version: 'test',
}));

import { parseAnnualSageKontoblattByMonth } from '../pdf-import-engine';
import { matchCSVRows, buildExpenseCategoriesOnly } from '../csv-import-engine';
import type { ParsedCSVRow, MatchedCSVRow } from '../csv-import-engine';
import {
  replaceAnnualCostYear,
  removeAnnualCostYear,
  loadMonth,
  saveMonth,
} from '../reporting-store';
import type { ExpenseCategory } from '@/types/reporting';

// ─── Helfer ───────────────────────────────────────────────────────────────────

const TEST_KEY = 'test_reporting_annual';

function wbBuffer(aoa: (string | number | null)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Kontoblatt');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return out as ArrayBuffer;
}

/** Standard-Kopf wie im echten Sage-Export (Zeitraum über Zellen verteilt) */
const HEADER_25: (string | number | null)[][] = [
  ['Kontoblatt', null, null, null, null, 'Oliv Gastro AG', null, null],
  ['vom:', null, null, '01.01.25 bis 31.12.25', null, null, null, null],
  [null, null, null, null, null, null, null, null],
  ['Datum', 'Blg', null, 'Text', null, 'G-Konto', 'Soll', 'Haben'],
  [null, null, null, null, null, null, null, null],
];

function monthTotal(rows: ParsedCSVRow[] | undefined): number {
  return (rows ?? []).reduce((s, r) => s + r.amount, 0);
}

beforeEach(() => {
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
  kvStore = {};
});

// ─── A. Echte Datei ───────────────────────────────────────────────────────────

describe('parseAnnualSageKontoblattByMonth — echte Datei 2025', () => {
  const filePath = join(process.cwd(), 'attached_assets', 'Kosten_Vorjahr_2025_1773869725649.XLSX');
  const buf = readFileSync(filePath);
  const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  it('erkennt Jahr 2025 aus dem Dateizeitraum und ALLE 12 Monate', async () => {
    const res = await parseAnnualSageKontoblattByMonth(arrayBuf);

    expect(res.failureReason).toBeUndefined();
    expect(res.ambiguousYear).toBe(false);
    expect(res.detectedYear).toBe(2025);
    expect(res.yearSource).toBe('period');
    expect(res.periodFrom).toBe('01.01.25');
    expect(res.periodTo).toBe('31.12.25');

    // Der ursprüngliche Bug: nur einzelne Monate kamen an. Jetzt: alle 12.
    expect(res.byMonth.size).toBe(12);
    for (let m = 1; m <= 12; m++) {
      expect(res.byMonth.get(m)?.length ?? 0).toBeGreaterThan(0);
    }

    // Keine Buchung geht verloren (Datei enthält NUR 2025er-Buchungen).
    // 2675 = 2658 numerische + 17 Zeilen mit Text-Beträgen ("6'952.95"),
    // die der parseAmount-Fallback korrekt einliest (u.a. MIRUS-Löhne 5002).
    expect(res.bookingCount).toBe(2675);
    expect(res.skippedOutOfYear).toBe(0);
    expect(res.accountCount).toBe(51);
  });

  it('jeder Monat trägt plausible Kostentotale (> 0)', async () => {
    const res = await parseAnnualSageKontoblattByMonth(arrayBuf);
    for (let m = 1; m <= 12; m++) {
      expect(monthTotal(res.byMonth.get(m))).toBeGreaterThan(0);
    }
  });
});

// ─── B. Synthetische Fixtures ─────────────────────────────────────────────────

describe('parseAnnualSageKontoblattByMonth — synthetisch', () => {
  it('Jahr aus Zeitraum-Kopf; Buchungen ausserhalb des Jahres werden übersprungen', async () => {
    const buf = wbBuffer([
      ...HEADER_25,
      [4000, null, null, 'Wareneinsatz Küche', null, null, null, null],
      [null, null, null, 'Saldo Vortrag', null, null, null, null],
      ['15.01.25', 1, null, 'Einkauf A', null, 1020, 500, null],
      ['20.02.25', 2, null, 'Einkauf B', null, 1020, 300, null],
      ['31.12.24', 3, null, 'Vorjahres-Streuner', null, 1020, 999, null],
      [null, null, null, 'Total Soll', null, null, 800, null],
      [null, null, null, 'Saldo', null, null, 800, null],
    ]);
    const res = await parseAnnualSageKontoblattByMonth(buf);

    expect(res.detectedYear).toBe(2025);
    expect(res.yearSource).toBe('period');
    expect(res.bookingCount).toBe(2);
    expect(res.skippedOutOfYear).toBe(1);
    // Total-/Saldo-Zeilen sind KEINE Buchungen
    expect(monthTotal(res.byMonth.get(1))).toBe(500);
    expect(monthTotal(res.byMonth.get(2))).toBe(300);
    expect(res.byMonth.size).toBe(2);
  });

  it('Konto-Header als TEXT ("4000") wird genauso erkannt wie als Zahl', async () => {
    const buf = wbBuffer([
      ...HEADER_25,
      ['4000', null, null, 'Wareneinsatz Küche', null, null, null, null],
      ['10.03.25', 1, null, 'Einkauf', null, 1020, 250, null],
    ]);
    const res = await parseAnnualSageKontoblattByMonth(buf);
    expect(res.accountCount).toBe(1);
    expect(res.byMonth.get(3)?.[0]?.accountNumber).toBe('4000');
    expect(res.byMonth.get(3)?.[0]?.amount).toBe(250);
  });

  it('Ertragskonto: Haben > Soll ergibt negativen Betrag (Soll − Haben)', async () => {
    const buf = wbBuffer([
      ...HEADER_25,
      [3000, null, null, 'Ertrag Küche', null, null, null, null],
      ['10.03.25', 1, null, 'Tagesumsatz', null, 1000, null, 1200],
      ['12.03.25', 2, null, 'Korrektur', null, 1000, 200, null],
    ]);
    const res = await parseAnnualSageKontoblattByMonth(buf);
    expect(res.byMonth.get(3)?.[0]?.amount).toBe(-1000);
  });

  it('mehrjähriger Dateizeitraum → Abbruch mit failureReason, keine Teildaten', async () => {
    const buf = wbBuffer([
      ['Kontoblatt', null, null, null, null, null, null, null],
      ['vom:', null, null, '01.07.24 bis 30.06.25', null, null, null, null],
      [4000, null, null, 'Wareneinsatz', null, null, null, null],
      ['15.01.25', 1, null, 'Einkauf', null, 1020, 500, null],
    ]);
    const res = await parseAnnualSageKontoblattByMonth(buf);
    expect(res.ambiguousYear).toBe(true);
    expect(res.failureReason).toBeTruthy();
    expect(res.byMonth.size).toBe(0);
  });

  it('kein Zeitraum im Kopf, EIN Buchungsjahr → Jahr aus Buchungen', async () => {
    const buf = wbBuffer([
      ['Kontoblatt', null, null, null, null, null, null, null],
      [4000, null, null, 'Wareneinsatz', null, null, null, null],
      ['15.04.25', 1, null, 'Einkauf', null, 1020, 500, null],
      ['20.05.25', 2, null, 'Einkauf', null, 1020, 300, null],
    ]);
    const res = await parseAnnualSageKontoblattByMonth(buf);
    expect(res.detectedYear).toBe(2025);
    expect(res.yearSource).toBe('bookings');
    expect(res.byMonth.size).toBe(2);
  });

  it('kein Zeitraum im Kopf, MEHRERE Buchungsjahre → Abbruch', async () => {
    const buf = wbBuffer([
      ['Kontoblatt', null, null, null, null, null, null, null],
      [4000, null, null, 'Wareneinsatz', null, null, null, null],
      ['15.04.24', 1, null, 'Einkauf', null, 1020, 500, null],
      ['20.05.25', 2, null, 'Einkauf', null, 1020, 300, null],
    ]);
    const res = await parseAnnualSageKontoblattByMonth(buf);
    expect(res.ambiguousYear).toBe(true);
    expect(res.failureReason).toBeTruthy();
    expect(res.byMonth.size).toBe(0);
  });

  it('leere/unbrauchbare Datei → failureReason statt stiller Erfolg', async () => {
    const buf = wbBuffer([
      ['Irgendein Blatt', null, null, null, null, null, null, null],
      ['ohne Konto-Struktur', null, null, null, null, null, null, null],
    ]);
    const res = await parseAnnualSageKontoblattByMonth(buf);
    expect(res.failureReason).toBeTruthy();
    expect(res.byMonth.size).toBe(0);
    expect(res.debug).toBeDefined();
  });
});

// ─── C. buildExpenseCategoriesOnly ────────────────────────────────────────────

describe('buildExpenseCategoriesOnly', () => {
  const mkRow = (acc: string, name: string, amount: number): ParsedCSVRow => ({
    lineIndex: 1,
    rawLine: `${acc} ${name}`,
    accountNumber: acc,
    accountName: name,
    rawAmount: String(amount),
    amount,
  });

  it('negiert Ertragskonten und markiert Unzugeordnete', () => {
    const matched: MatchedCSVRow[] = [
      { parsed: mkRow('4000', 'Wareneinsatz', 800), category: 'cogs_food', sign: 'expense' } as unknown as MatchedCSVRow,
      { parsed: mkRow('3000', 'Ertrag Küche', -1200), category: 'rev_food', sign: 'income' } as unknown as MatchedCSVRow,
    ];
    const unresolved: MatchedCSVRow[] = [
      { parsed: mkRow('4999', 'Mystery-Konto', 50), category: null, sign: 'expense' } as unknown as MatchedCSVRow,
    ];

    const cats = buildExpenseCategoriesOnly(matched, unresolved);

    expect(cats).toHaveLength(3);
    expect(cats.find(c => c.categoryId === '4000')?.amount).toBe(800);
    // income: −(−1200) = +1200 (Ertrag als positive Grösse)
    expect(cats.find(c => c.categoryId === '3000')?.amount).toBe(1200);
    const un = cats.find(c => c.categoryId === '4999');
    expect(un?.label).toContain('[Unzugeordnet]');
    expect(un?.amount).toBe(50);
  });

  it('liefert NUR Kategorien — keine revenue-/personnel-Direktfelder', () => {
    const cats = buildExpenseCategoriesOnly([], []);
    expect(Array.isArray(cats)).toBe(true);
    expect(cats).toHaveLength(0);
  });
});

// ─── D. replaceAnnualCostYear / removeAnnualCostYear ──────────────────────────

describe('replaceAnnualCostYear', () => {
  const cat = (id: string, label: string, amount: number): ExpenseCategory => ({
    categoryId: id, label, amount,
  });

  function seedMonthWithManualAndDirect() {
    // Monat 2025-03 mit Gastronovi-Umsatz, Personalkosten und manueller Kategorie
    const rec = loadMonth(2025, 3, TEST_KEY);
    saveMonth(
      {
        ...rec,
        revenueActual: 55000,
        personnelCostActual: 21000,
        expenseCategories: [
          cat('miete', 'Miete (manuell)', 9000),
          cat('4000', 'Alter Import-Wert', 123),
        ],
      },
      'manual',
      'update',
      { note: 'Test-Seed' },
      TEST_KEY,
    );
  }

  it('ersetzt numerische Kategorien, behält manuelle + Direktfelder', () => {
    seedMonthWithManualAndDirect();

    const byMonth = new Map<number, ExpenseCategory[]>([
      [3, [cat('4000', 'Wareneinsatz', 800), cat('5000', 'Löhne FIBU', 20000)]],
      [4, [cat('4000', 'Wareneinsatz', 700)]],
    ]);
    const res = replaceAnnualCostYear(2025, byMonth, { fileName: 'test.xlsx' }, TEST_KEY);

    expect(res.monthsWritten).toBe(2);
    const m3 = loadMonth(2025, 3, TEST_KEY);
    expect(m3.revenueActual).toBe(55000);
    expect(m3.personnelCostActual).toBe(21000);
    expect(m3.expenseCategories.find(c => c.categoryId === 'miete')?.amount).toBe(9000);
    expect(m3.expenseCategories.find(c => c.categoryId === '4000')?.amount).toBe(800);
    expect(m3.expenseCategories.find(c => c.categoryId === '5000')?.amount).toBe(20000);
    // Alter numerischer Wert (123) ist weg — ersetzt, nicht addiert
    expect(m3.expenseCategories.filter(c => c.categoryId === '4000')).toHaveLength(1);
  });

  it('ist idempotent: zweiter identischer Import ändert die Werte nicht', () => {
    const byMonth = new Map<number, ExpenseCategory[]>([
      [1, [cat('4000', 'Wareneinsatz', 500)]],
      [2, [cat('4000', 'Wareneinsatz', 300)]],
    ]);
    replaceAnnualCostYear(2025, byMonth, {}, TEST_KEY);
    const first = loadMonth(2025, 1, TEST_KEY).expenseCategories;

    replaceAnnualCostYear(2025, byMonth, {}, TEST_KEY);
    const second = loadMonth(2025, 1, TEST_KEY).expenseCategories;

    expect(second).toEqual(first);
    expect(second.filter(c => c.categoryId === '4000')).toHaveLength(1);
    expect(second.find(c => c.categoryId === '4000')?.amount).toBe(500);
  });

  it('entfernt stale Kontodaten aus Monaten, die im neuen Import fehlen', () => {
    // Erster Import: Jan–Mär. Zweiter Import: nur Jan–Feb → März muss bereinigt werden.
    replaceAnnualCostYear(2025, new Map([
      [1, [cat('4000', 'W', 100)]],
      [2, [cat('4000', 'W', 200)]],
      [3, [cat('4000', 'W', 300)]],
    ]), {}, TEST_KEY);

    const res = replaceAnnualCostYear(2025, new Map([
      [1, [cat('4000', 'W', 110)]],
      [2, [cat('4000', 'W', 210)]],
    ]), {}, TEST_KEY);

    expect(res.monthsWritten).toBe(2);
    expect(res.monthsCleared).toBe(1);
    expect(loadMonth(2025, 3, TEST_KEY).expenseCategories.filter(c => /^\d{3,5}$/.test(c.categoryId))).toHaveLength(0);
  });

  it('lässt andere Jahre unberührt', () => {
    replaceAnnualCostYear(2024, new Map([[6, [cat('4000', 'W', 999)]]]), {}, TEST_KEY);
    replaceAnnualCostYear(2025, new Map([[6, [cat('4000', 'W', 111)]]]), {}, TEST_KEY);

    expect(loadMonth(2024, 6, TEST_KEY).expenseCategories.find(c => c.categoryId === '4000')?.amount).toBe(999);
    expect(loadMonth(2025, 6, TEST_KEY).expenseCategories.find(c => c.categoryId === '4000')?.amount).toBe(111);
  });

  it('removeAnnualCostYear entfernt alle numerischen Kategorien des Jahres', () => {
    seedMonthWithManualAndDirect();
    replaceAnnualCostYear(2025, new Map([
      [3, [cat('4000', 'W', 800)]],
      [7, [cat('4000', 'W', 400)]],
    ]), {}, TEST_KEY);

    const res = removeAnnualCostYear(2025, {}, TEST_KEY);
    expect(res.monthsCleared).toBe(2);

    const m3 = loadMonth(2025, 3, TEST_KEY);
    expect(m3.expenseCategories.filter(c => /^\d{3,5}$/.test(c.categoryId))).toHaveLength(0);
    // Manuelle Kategorie + Direktfelder überleben die Löschung
    expect(m3.expenseCategories.find(c => c.categoryId === 'miete')?.amount).toBe(9000);
    expect(m3.revenueActual).toBe(55000);
  });
});
