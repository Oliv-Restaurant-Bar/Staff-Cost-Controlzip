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
  upsertCostMonths,
  assertYearScopedChanges,
  loadMonth,
  saveMonth,
} from '../reporting-store';
import type { MonthlyFinancialRecord } from '@/types/reporting';
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

  it('liefert Journal pro Monat (Summe = bookingCount) und erkennt den Mandanten', async () => {
    const res = await parseAnnualSageKontoblattByMonth(arrayBuf);
    let journalTotal = 0;
    for (let m = 1; m <= 12; m++) {
      const j = res.journalByMonth.get(m) ?? [];
      expect(j.length).toBeGreaterThan(0);
      journalTotal += j.length;
      // Journal-Netto = Konto-Netto des Monats
      const jNet = j.reduce((s, e) => s + e.soll - e.haben, 0);
      expect(jNet).toBeCloseTo(monthTotal(res.byMonth.get(m)), 2);
    }
    expect(journalTotal).toBe(res.bookingCount);
    expect(res.detectedTenant).toBe('oliv');
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

    // Journal pro Monat: Buchungszeilen mit Datum/Beleg/Text/Soll/Haben
    expect(res.journalByMonth.get(1)).toHaveLength(1);
    expect(res.journalByMonth.get(2)).toHaveLength(1);
    const j1 = res.journalByMonth.get(1)![0];
    expect(j1.date).toBe('15.01.25');
    expect(j1.text).toBe('Einkauf A');
    expect(j1.accountNumber).toBe('4000');
    expect(j1.soll).toBe(500);
    expect(j1.haben).toBe(0);
    // Mandant aus Kopfzeile «Oliv Gastro AG»
    expect(res.detectedTenant).toBe('oliv');
    expect(res.detectedCompany).toContain('Oliv');
  });

  it('Beaulieu-Kopf → detectedTenant beaulieu', async () => {
    const header = HEADER_25.map(r => [...r]);
    header[0][5] = 'Café Beaulieu AG';
    const buf = wbBuffer([
      ...header,
      [4000, null, null, 'Wareneinsatz Küche', null, null, null, null],
      ['15.03.25', 1, null, 'Prodega', null, 1020, 100, null],
      [null, null, null, 'Total Soll', null, null, 100, null],
    ]);
    const res = await parseAnnualSageKontoblattByMonth(buf);
    expect(res.detectedTenant).toBe('beaulieu');
  });

  it('2024-Kontoblatt: Jahr 2024 aus dem Zeitraum-Kopf, kein stiller Fallback auf 2025', async () => {
    const buf = wbBuffer([
      ['Kontoblatt', null, null, null, null, 'Oliv Gastro AG', null, null],
      ['vom:', null, null, '01.01.24 bis 31.12.24', null, null, null, null],
      [null, null, null, null, null, null, null, null],
      ['Datum', 'Blg', null, 'Text', null, 'G-Konto', 'Soll', 'Haben'],
      [null, null, null, null, null, null, null, null],
      [4000, null, null, 'Wareneinsatz Küche', null, null, null, null],
      ['15.03.24', 1, null, 'Einkauf A', null, 1020, 700, null],
      ['20.11.24', 2, null, 'Einkauf B', null, 1020, 250, null],
      ['05.01.25', 3, null, 'Folgejahr-Streuner', null, 1020, 999, null],
    ]);
    const res = await parseAnnualSageKontoblattByMonth(buf);

    expect(res.failureReason).toBeUndefined();
    expect(res.detectedYear).toBe(2024);
    expect(res.yearSource).toBe('period');
    expect(res.bookingCount).toBe(2);
    expect(res.skippedOutOfYear).toBe(1);
    expect(monthTotal(res.byMonth.get(3))).toBe(700);
    expect(monthTotal(res.byMonth.get(11))).toBe(250);
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

  it('Dirty-Check: identischer Zweitimport ist ein No-op (kein updatedAt-Bump, kein Import-Protokoll)', () => {
    const byMonth = new Map<number, ExpenseCategory[]>([
      [1, [cat('4000', 'Wareneinsatz', 500)]],
      [2, [cat('4000', 'Wareneinsatz', 300)]],
    ]);
    const first = replaceAnnualCostYear(2025, byMonth, {}, TEST_KEY);
    expect(first.monthsWritten).toBe(2);
    expect(first.monthsUnchanged).toBe(0);
    const m1After1 = loadMonth(2025, 1, TEST_KEY);

    const second = replaceAnnualCostYear(2025, byMonth, {}, TEST_KEY);
    expect(second.monthsWritten).toBe(0);
    expect(second.monthsUnchanged).toBe(2);
    const m1After2 = loadMonth(2025, 1, TEST_KEY);
    expect(m1After2.updatedAt).toBe(m1After1.updatedAt);
    expect(m1After2.imports).toHaveLength(m1After1.imports.length);
  });

  it('Dirty-Check greift auch mit manuellen Kategorien im Bestand', () => {
    seedMonthWithManualAndDirect(); // 2025-03: miete (manuell) + 4000 (123)
    const byMonth = new Map<number, ExpenseCategory[]>([
      [3, [cat('4000', 'Alter Import-Wert', 123)]], // exakt der Bestand
    ]);
    const res = replaceAnnualCostYear(2025, byMonth, {}, TEST_KEY);
    expect(res.monthsWritten).toBe(0);
    expect(res.monthsUnchanged).toBe(1);
    const m3 = loadMonth(2025, 3, TEST_KEY);
    expect(m3.expenseCategories.find(c => c.categoryId === 'miete')?.amount).toBe(9000);
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

  it('2024: Import schreibt NUR ins Jahr 2024 — 2025/2026 bleiben unverändert (§12)', () => {
    // Bestehende Daten in 2025 und 2026 seeden
    replaceAnnualCostYear(2025, new Map([[3, [cat('4000', 'W', 500)]]]), {}, TEST_KEY);
    replaceAnnualCostYear(2026, new Map([[3, [cat('4000', 'W', 600)]]]), {}, TEST_KEY);

    const res = replaceAnnualCostYear(2024, new Map([
      [3, [cat('4000', 'Wareneinsatz', 450), cat('5000', 'Löhne FIBU', 18000)]],
      [11, [cat('4000', 'Wareneinsatz', 470)]],
    ]), { fileName: 'kosten_2024.xlsx' }, TEST_KEY);

    expect(res.monthsWritten).toBe(2);
    expect(loadMonth(2024, 3, TEST_KEY).expenseCategories.find(c => c.categoryId === '4000')?.amount).toBe(450);
    expect(loadMonth(2024, 11, TEST_KEY).expenseCategories.find(c => c.categoryId === '4000')?.amount).toBe(470);
    // Andere Jahre unberührt
    expect(loadMonth(2025, 3, TEST_KEY).expenseCategories.find(c => c.categoryId === '4000')?.amount).toBe(500);
    expect(loadMonth(2026, 3, TEST_KEY).expenseCategories.find(c => c.categoryId === '4000')?.amount).toBe(600);
    // Fehlende 2024-Monate bleiben leer (fehlend ≠ 0)
    expect(loadMonth(2024, 4, TEST_KEY).expenseCategories.filter(c => /^\d{3,5}$/.test(c.categoryId))).toHaveLength(0);
  });

  it('2024: wiederholter identischer Import ist idempotent (keine Doppelwerte)', () => {
    const byMonth = new Map<number, ExpenseCategory[]>([
      [1, [cat('4000', 'Wareneinsatz', 400)]],
      [12, [cat('4000', 'Wareneinsatz', 420)]],
    ]);
    replaceAnnualCostYear(2024, byMonth, {}, TEST_KEY);
    const first = loadMonth(2024, 1, TEST_KEY).expenseCategories;

    replaceAnnualCostYear(2024, byMonth, {}, TEST_KEY);
    const second = loadMonth(2024, 1, TEST_KEY).expenseCategories;

    expect(second).toEqual(first);
    expect(second.filter(c => c.categoryId === '4000')).toHaveLength(1);
    expect(second.find(c => c.categoryId === '4000')?.amount).toBe(400);
  });

  it('2024: Tenant-Trennung — Import unter einem Storage-Key berührt den anderen nie', () => {
    const OLIV_KEY = TEST_KEY;
    const BEAULIEU_KEY = `b-${TEST_KEY}`;

    replaceAnnualCostYear(2024, new Map([[5, [cat('4000', 'W Oliv', 1000)]]]), {}, OLIV_KEY);
    replaceAnnualCostYear(2024, new Map([[5, [cat('4000', 'W Beaulieu', 2000)]]]), {}, BEAULIEU_KEY);

    expect(loadMonth(2024, 5, OLIV_KEY).expenseCategories.find(c => c.categoryId === '4000')?.amount).toBe(1000);
    expect(loadMonth(2024, 5, BEAULIEU_KEY).expenseCategories.find(c => c.categoryId === '4000')?.amount).toBe(2000);

    removeAnnualCostYear(2024, {}, BEAULIEU_KEY);
    expect(loadMonth(2024, 5, OLIV_KEY).expenseCategories.find(c => c.categoryId === '4000')?.amount).toBe(1000);
    expect(loadMonth(2024, 5, BEAULIEU_KEY).expenseCategories.filter(c => /^\d{3,5}$/.test(c.categoryId))).toHaveLength(0);
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

// ─── E. Jahresimport-Schreibschutz (T006/T007): fremde Jahre bitgenau erhalten ─

describe('upsertCostMonths — Mehrmonats-Upsert ohne Clearing anderer Monate', () => {
  const cat = (id: string, amount: number): ExpenseCategory => ({
    categoryId: id, label: `Konto ${id}`, amount,
  });

  it('schreibt nur die übergebenen Monate; andere Monate bleiben unangetastet', () => {
    // Bestand: numerische Kontodaten im März (nicht Teil der Datei)
    replaceAnnualCostYear(2026, new Map([[3, [cat('4000', 111)]]]), {}, TEST_KEY);

    const res = upsertCostMonths(2026, new Map([
      [5, [cat('4000', 500)]],
      [6, [cat('4000', 600)]],
    ]), {}, TEST_KEY);

    expect(res.monthsWritten).toBe(2);
    expect(res.monthsCleared).toBe(0);
    // März NICHT bereinigt (Unterschied zu replaceAnnualCostYear)
    expect(loadMonth(2026, 3, TEST_KEY)?.expenseCategories?.[0]?.amount).toBe(111);
    expect(loadMonth(2026, 5, TEST_KEY)?.expenseCategories?.[0]?.amount).toBe(500);
    expect(loadMonth(2026, 6, TEST_KEY)?.expenseCategories?.[0]?.amount).toBe(600);
  });

  it('ist idempotent: identischer Zweitimport → monthsUnchanged, kein Doppel', () => {
    const cats = new Map([[5, [cat('4000', 500)]]]);
    upsertCostMonths(2026, cats, {}, TEST_KEY);
    const before = loadMonth(2026, 5, TEST_KEY);
    const res2 = upsertCostMonths(2026, cats, {}, TEST_KEY);
    expect(res2.monthsWritten).toBe(0);
    expect(res2.monthsUnchanged).toBe(1);
    const after = loadMonth(2026, 5, TEST_KEY);
    expect(after?.expenseCategories).toHaveLength(1);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it('ersetzt numerische Konten des Monats, behält manuelle Kategorien', () => {
    const manual: ExpenseCategory = { categoryId: 'sonstiges', label: 'Manuell', amount: 42 };
    saveMonth({ year: 2026, month: 5, expenseCategories: [manual, cat('4000', 1)] }, 'manual', 'update', undefined, TEST_KEY);
    upsertCostMonths(2026, new Map([[5, [cat('4000', 500)]]]), {}, TEST_KEY);
    const rec = loadMonth(2026, 5, TEST_KEY);
    expect(rec?.expenseCategories?.find(c => c.categoryId === 'sonstiges')?.amount).toBe(42);
    expect(rec?.expenseCategories?.find(c => c.categoryId === '4000')?.amount).toBe(500);
    expect(rec?.expenseCategories).toHaveLength(2);
  });

  it('lässt fremde Jahre unberührt (assertYearScopedChanges aktiv)', () => {
    replaceAnnualCostYear(2025, new Map([[7, [cat('4000', 77)]]]), {}, TEST_KEY);
    upsertCostMonths(2026, new Map([[5, [cat('4000', 500)]]]), {}, TEST_KEY);
    expect(loadMonth(2025, 7, TEST_KEY)?.expenseCategories?.[0]?.amount).toBe(77);
  });
});

describe('Jahresimport-Schreibschutz — fremde Jahre bleiben bitgenau erhalten', () => {
  const cat = (id: string, label: string, amount: number): ExpenseCategory => ({
    categoryId: id, label, amount,
  });

  /** Roh-Snapshot aller Monats-Records, die NICHT zum Jahr `excludeYear` gehören. */
  function snapshotOtherYears(excludeYear: number): string {
    const all = JSON.parse(localStorageStore[TEST_KEY] ?? '{}') as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const id of Object.keys(all).sort()) {
      if (!id.startsWith(`${excludeYear}-`)) out[id] = all[id];
    }
    return JSON.stringify(out);
  }

  function seedYears() {
    // 2025: Kontodaten + Umsatz + manuelle Kategorie; 2026: Kontodaten
    saveMonth(
      { year: 2025, month: 3, revenueActual: 55000, personnelCostActual: 21000,
        expenseCategories: [cat('miete', 'Miete (manuell)', 9000)] },
      'manual', 'update', {}, TEST_KEY,
    );
    replaceAnnualCostYear(2025, new Map([
      [1, [cat('4000', 'W', 100)]],
      [3, [cat('4000', 'W', 500), cat('5000', 'Löhne', 20000)]],
    ]), {}, TEST_KEY);
    replaceAnnualCostYear(2026, new Map([
      [2, [cat('4000', 'W', 600)]],
      [6, [cat('4020', 'Getränke', 250)]],
    ]), {}, TEST_KEY);
  }

  it('Import 2024 → 2025 und 2026 bitgenau unverändert (inkl. Monats-Anzahl)', async () => {
    seedYears();
    const before = snapshotOtherYears(2024);
    const countBefore = Object.keys(JSON.parse(localStorageStore[TEST_KEY]!)).length;

    const res = replaceAnnualCostYear(2024, new Map([
      [3, [cat('4000', 'W 2024', 450)]],
      [11, [cat('4000', 'W 2024', 470)]],
    ]), { fileName: 'kosten_2024.xlsx' }, TEST_KEY);

    expect(snapshotOtherYears(2024)).toBe(before);
    // Genau 2 neue Monate (2024-03, 2024-11) — keine fremden Records entfernt
    expect(Object.keys(JSON.parse(localStorageStore[TEST_KEY]!)).length).toBe(countBefore + 2);
    // KV-Backup vollständig (gemockt) — keine Fehlmonate
    await expect(res.kvBackup).resolves.toEqual({ failedMonths: [] });
  });

  it('Import 2025 → 2024 und 2026 bitgenau unverändert', () => {
    seedYears();
    replaceAnnualCostYear(2024, new Map([[5, [cat('4000', 'W', 900)]]]), {}, TEST_KEY);
    const before2024und2026 = snapshotOtherYears(2025);

    replaceAnnualCostYear(2025, new Map([[7, [cat('4000', 'W neu', 777)]]]), {}, TEST_KEY);

    expect(snapshotOtherYears(2025)).toBe(before2024und2026);
  });

  it('Import 2026 → 2024 und 2025 bitgenau unverändert', () => {
    seedYears();
    replaceAnnualCostYear(2024, new Map([[5, [cat('4000', 'W', 900)]]]), {}, TEST_KEY);
    const before = snapshotOtherYears(2026);

    replaceAnnualCostYear(2026, new Map([[9, [cat('4000', 'W neu', 888)]]]), {}, TEST_KEY);

    expect(snapshotOtherYears(2026)).toBe(before);
  });

  it('Mehrfachimport 2024 → fremde Jahre weiterhin bitgenau, keine Dubletten', () => {
    seedYears();
    const byMonth = new Map<number, ExpenseCategory[]>([[3, [cat('4000', 'W', 450)]]]);
    const before = snapshotOtherYears(2024);

    replaceAnnualCostYear(2024, byMonth, {}, TEST_KEY);
    replaceAnnualCostYear(2024, byMonth, {}, TEST_KEY);
    replaceAnnualCostYear(2024, byMonth, {}, TEST_KEY);

    expect(snapshotOtherYears(2024)).toBe(before);
    const m3 = loadMonth(2024, 3, TEST_KEY);
    expect(m3.expenseCategories.filter(c => c.categoryId === '4000')).toHaveLength(1);
    expect(m3.expenseCategories.find(c => c.categoryId === '4000')?.amount).toBe(450);
  });

  it('Löschen 2024 → 2025 und 2026 bleiben vollständig und bitgenau erhalten', () => {
    seedYears();
    replaceAnnualCostYear(2024, new Map([
      [3, [cat('4000', 'W', 450)]],
      [11, [cat('4000', 'W', 470)]],
    ]), {}, TEST_KEY);
    const before = snapshotOtherYears(2024);

    const res = removeAnnualCostYear(2024, {}, TEST_KEY);
    expect(res.monthsCleared).toBe(2);

    expect(snapshotOtherYears(2024)).toBe(before);
    expect(loadMonth(2024, 3, TEST_KEY).expenseCategories.filter(c => /^\d{3,5}$/.test(c.categoryId))).toHaveLength(0);
  });
});

// ─── F. Integritätsprüfung assertYearScopedChanges (T007) ────────────────────

describe('assertYearScopedChanges — Abbruch bei Fremdjahr-Änderung', () => {
  const rec = (year: number, month: number, amount: number): MonthlyFinancialRecord => ({
    id: `${year}-${String(month).padStart(2, '0')}`,
    year, month,
    revenueActual: 0, revenueBudget: 0, revenuePreviousYear: 0,
    personnelCostActual: 0, personnelCostPlanned: 0, personnelCostPreviousYear: 0,
    expenseCategories: [{ categoryId: '4000', label: 'W', amount }],
    expenseCategoriesPreviousYear: [],
    imports: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as MonthlyFinancialRecord);

  it('erlaubt Änderungen ausschliesslich im Zieljahr', () => {
    const before = { '2025-03': rec(2025, 3, 100) };
    const after  = { '2025-03': rec(2025, 3, 100), '2024-05': rec(2024, 5, 50) };
    expect(() => assertYearScopedChanges(before, after, 2024)).not.toThrow();
  });

  it('wirft, wenn ein Fremdjahr-Record verändert würde', () => {
    const before = { '2025-03': rec(2025, 3, 100) };
    const after  = { '2025-03': rec(2025, 3, 999), '2024-05': rec(2024, 5, 50) };
    expect(() => assertYearScopedChanges(before, after, 2024)).toThrow(/2025-03/);
  });

  it('wirft, wenn ein Fremdjahr-Record gelöscht würde', () => {
    const before = { '2025-03': rec(2025, 3, 100), '2026-01': rec(2026, 1, 10) };
    const after  = { '2025-03': rec(2025, 3, 100) };
    expect(() => assertYearScopedChanges(before, after, 2024)).toThrow(/2026-01/);
  });

  it('wirft, wenn ein Fremdjahr-Record neu angelegt würde', () => {
    const before = {} as Record<string, MonthlyFinancialRecord>;
    const after  = { '2025-01': rec(2025, 1, 10) };
    expect(() => assertYearScopedChanges(before, after, 2024)).toThrow(/2025-01/);
  });
});

// ─── E. Merge-Schutz manueller Kontierungen (quelle='manuell') ────────────────

describe('Merge-Schutz: manuell erfasste Konten überleben Re-Import', () => {
  const mcat = (id: string, label: string, amount: number, quelle?: 'import' | 'manuell'): ExpenseCategory =>
    ({ categoryId: id, label, amount, ...(quelle ? { quelle } : {}) });

  function seedManual5004(year = 2025, month = 4) {
    const rec = loadMonth(year, month, TEST_KEY);
    saveMonth(
      {
        ...rec,
        expenseCategories: [
          mcat('5004', 'Aushilfslöhne (manuell)', 4200, 'manuell'),
          mcat('4000', 'Wareneinsatz (alt)', 100, 'import'),
        ],
      },
      'manual_entry', 'update', { note: 'Seed' }, TEST_KEY,
    );
  }

  it('Regression: manuell angelegtes Konto 5004 überlebt Re-Import (replaceAnnualCostYear), auch wenn es in der Datei fehlt', () => {
    seedManual5004();
    const byMonth = new Map<number, ExpenseCategory[]>([
      [4, [mcat('4000', 'Wareneinsatz', 800, 'import')]],
    ]);
    const res = replaceAnnualCostYear(2025, byMonth, {}, TEST_KEY);
    expect(res.zeilenGeschuetzt).toBe(1);
    const m4 = loadMonth(2025, 4, TEST_KEY);
    const c5004 = m4.expenseCategories.find(c => c.categoryId === '5004');
    expect(c5004?.amount).toBe(4200);
    expect(c5004?.quelle).toBe('manuell');
    expect(m4.expenseCategories.find(c => c.categoryId === '4000')?.amount).toBe(800);
  });

  it('Import mit KOLLIDIERENDEM Wert überschreibt manuelle Zeile NICHT (ohne Freigabe)', () => {
    seedManual5004();
    const byMonth = new Map<number, ExpenseCategory[]>([
      [4, [mcat('5004', 'Aushilfslöhne FIBU', 9999, 'import')]],
    ]);
    replaceAnnualCostYear(2025, byMonth, {}, TEST_KEY);
    const c5004 = loadMonth(2025, 4, TEST_KEY).expenseCategories.filter(c => c.categoryId === '5004');
    expect(c5004).toHaveLength(1);
    expect(c5004[0].amount).toBe(4200);
    expect(c5004[0].quelle).toBe('manuell');
  });

  it('«Importwert übernehmen» (uebernehmen-Set) ersetzt gezielt EINE Zeile — Ergebnis wieder quelle=manuell', () => {
    seedManual5004();
    const byMonth = new Map<number, ExpenseCategory[]>([
      [4, [mcat('5004', 'Aushilfslöhne FIBU', 9999, 'import')]],
    ]);
    const res = replaceAnnualCostYear(2025, byMonth, { uebernehmen: new Set(['4|5004']) }, TEST_KEY);
    expect(res.zeilenGeschuetzt).toBe(0);
    const c5004 = loadMonth(2025, 4, TEST_KEY).expenseCategories.filter(c => c.categoryId === '5004');
    expect(c5004).toHaveLength(1);
    expect(c5004[0].amount).toBe(9999);
    expect(c5004[0].quelle).toBe('manuell');
  });

  it('uebernehmen-Key ist monatsscharf: Freigabe 4|5004 schützt 5|5004 weiterhin', () => {
    seedManual5004(2025, 4);
    seedManual5004(2025, 5);
    const byMonth = new Map<number, ExpenseCategory[]>([
      [4, [mcat('5004', 'FIBU', 9999, 'import')]],
      [5, [mcat('5004', 'FIBU', 8888, 'import')]],
    ]);
    replaceAnnualCostYear(2025, byMonth, { uebernehmen: new Set(['4|5004']) }, TEST_KEY);
    expect(loadMonth(2025, 4, TEST_KEY).expenseCategories.find(c => c.categoryId === '5004')?.amount).toBe(9999);
    expect(loadMonth(2025, 5, TEST_KEY).expenseCategories.find(c => c.categoryId === '5004')?.amount).toBe(4200);
  });

  it('upsertCostMonths schützt manuelle Zeilen identisch (Mehrmonats-Kontoblatt)', () => {
    seedManual5004(2025, 6);
    const byMonth = new Map<number, ExpenseCategory[]>([
      [6, [mcat('5004', 'FIBU', 7777, 'import'), mcat('4000', 'Wareneinsatz', 500, 'import')]],
    ]);
    const res = upsertCostMonths(2025, byMonth, {}, TEST_KEY);
    expect(res.zeilenGeschuetzt).toBe(1);
    const m6 = loadMonth(2025, 6, TEST_KEY);
    expect(m6.expenseCategories.find(c => c.categoryId === '5004')?.amount).toBe(4200);
    expect(m6.expenseCategories.find(c => c.categoryId === '4000')?.amount).toBe(500);
  });

  it('Legacy-Zeilen OHNE quelle-Flag werden wie Import behandelt (ersetzt)', () => {
    const rec = loadMonth(2025, 7, TEST_KEY);
    saveMonth(
      { ...rec, expenseCategories: [mcat('6000', 'Legacy ohne Flag', 111)] },
      'manual_entry', 'update', { note: 'Seed' }, TEST_KEY,
    );
    replaceAnnualCostYear(2025, new Map([[7, [mcat('6000', 'Neu', 222, 'import')]]]), {}, TEST_KEY);
    expect(loadMonth(2025, 7, TEST_KEY).expenseCategories.find(c => c.categoryId === '6000')?.amount).toBe(222);
  });

  it('Dirty-Check bleibt No-op, wenn nur geschützte Zeilen existieren und die Datei den Monat nicht enthält', () => {
    seedManual5004(2025, 8);
    const res = replaceAnnualCostYear(2025, new Map([[8, [mcat('4000', 'W', 100, 'import')]]]), {}, TEST_KEY);
    const updatedAt1 = loadMonth(2025, 8, TEST_KEY).updatedAt;
    const res2 = replaceAnnualCostYear(2025, new Map([[8, [mcat('4000', 'W', 100, 'import')]]]), {}, TEST_KEY);
    expect(res2.monthsUnchanged).toBeGreaterThanOrEqual(1);
    expect(loadMonth(2025, 8, TEST_KEY).updatedAt).toBe(updatedAt1);
    expect(res.zeilenGeschuetzt).toBe(1);
  });
});

describe('removeAnnualCostYear — explizites Löschen entfernt auch manuelle Konten', () => {
  it('entfernt ALLE numerischen Kategorien inkl. quelle=manuell (Schutz gilt nur für Imports)', () => {
    const rec = loadMonth(2025, 9, TEST_KEY);
    saveMonth(
      {
        ...rec,
        expenseCategories: [
          { categoryId: '5004', label: 'Aushilfslöhne (manuell)', amount: 4200, quelle: 'manuell' },
          { categoryId: '4000', label: 'Wareneinsatz', amount: 800, quelle: 'import' },
          { categoryId: 'miete', label: 'Miete (nicht-numerisch)', amount: 900 },
        ],
      },
      'manual_entry', 'update', { note: 'Seed' }, TEST_KEY,
    );
    removeAnnualCostYear(2025, {}, TEST_KEY);
    const cats = loadMonth(2025, 9, TEST_KEY).expenseCategories;
    expect(cats.find(c => c.categoryId === '5004')).toBeUndefined();
    expect(cats.find(c => c.categoryId === '4000')).toBeUndefined();
    // Nicht-numerische Kategorien bleiben wie bisher erhalten
    expect(cats.find(c => c.categoryId === 'miete')?.amount).toBe(900);
  });
});
