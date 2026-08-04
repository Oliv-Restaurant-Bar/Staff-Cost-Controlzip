// @vitest-environment node
/**
 * ABNAHME mit echten User-Dateien (temporär, kann nach Abnahme entfernt werden):
 *  A. «Kosten Oliv 06.2026» (PDF, extrahierte pdfjs-Zeilen):
 *     4060 = 47'428.54, 4030 = 10'947.69, 5000 = 60'453.80, Mandant oliv, 06/2026.
 *  B. «Vorjahreskosten 2024.XLSX» (Oliv, ganzes Jahr): 12 Monate, Jahr 2024,
 *     Mandant oliv, keine Buchung verloren; upsertCostMonths idempotent
 *     (2. Lauf → alle Monate «unverändert»).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const localStorageStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
});
vi.mock('pdfjs-dist', () => ({ getDocument: vi.fn(), GlobalWorkerOptions: {} }));
vi.mock('../pdf-worker-setup', () => ({ ensurePdfWorkerConfigured: () => {} }));
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

import { parseSageKontoblatt, parseSageHeaderMeta, parseAnnualSageKontoblattByMonth } from '../pdf-import-engine';
import { upsertCostMonths, loadYear } from '../reporting-store';
import type { ExpenseCategory } from '@/types/reporting';
import fixtureJun from './fixtures/sage-oliv-2026-06-lines.json';

type Fixture = { y: number; items: { x: number; text: string }[]; text: string }[];
const jun = fixtureJun as unknown as Fixture;

describe('Abnahme A — Kosten Oliv 06.2026 (PDF)', () => {
  const res = parseSageKontoblatt(jun as never);
  const map = new Map(res.rows.map(r => [r.accountNumber, r]));

  it('Kopf: Oliv, Juni 2026', () => {
    const meta = parseSageHeaderMeta(jun.map(l => l.text));
    expect(meta.tenant).toBe('oliv');
    expect(meta.month).toBe(6);
    expect(meta.year).toBe(2026);
  });
  it('4060 = 47428.54', () => expect(map.get('4060')?.amount).toBeCloseTo(47428.54, 2));
  it('4030 = 10947.69', () => expect(map.get('4030')?.amount).toBeCloseTo(10947.69, 2));
  it('5000 = 60453.80', () => expect(map.get('5000')?.amount).toBeCloseTo(60453.8, 2));
});

describe('Abnahme B — Vorjahreskosten 2024.XLSX (Oliv, ganzes Jahr)', () => {
  const buf = readFileSync(join(__dirname, '../../../attached_assets/0_Vorjahreskosten_2024_1785694437316.XLSX'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

  beforeEach(() => { for (const k of Object.keys(localStorageStore)) delete localStorageStore[k]; });

  it('12 Monate, Jahr 2024, Mandant oliv, keine Buchung verloren; Upsert idempotent', async () => {
    const r = await parseAnnualSageKontoblattByMonth(ab);
    expect(r.failureReason).toBeUndefined();
    expect(r.detectedYear).toBe(2024);
    expect(r.detectedTenant).toBe('oliv');
    expect(r.byMonth.size).toBe(12);
    const journalTotal = [...r.journalByMonth.values()].reduce((s, es) => s + es.length, 0);
    expect(journalTotal).toBe(r.bookingCount);
    // Monats-Netto (Kategorien) == Journal-Netto pro Monat
    for (const [m, rows] of r.byMonth.entries()) {
      const netRows = rows.reduce((s, x) => s + x.amount, 0);
      const netJournal = (r.journalByMonth.get(m) ?? []).reduce((s, e) => s + (e.soll - e.haben), 0);
      expect(netJournal).toBeCloseTo(netRows, 1);
    }

    // Upsert 1: schreibt alle 12 Monate; Upsert 2: alle unverändert
    const catsByMonth = new Map<number, ExpenseCategory[]>();
    for (const [m, rows] of r.byMonth.entries()) {
      catsByMonth.set(m, rows.map(x => ({ categoryId: x.accountNumber, label: x.accountName, amount: x.amount })));
    }
    const first = upsertCostMonths(2024, catsByMonth, { fileName: 'Vorjahreskosten 2024.XLSX' });
    await first.kvBackup;
    expect(first.monthsWritten).toBe(12);
    expect(first.monthsUnchanged).toBe(0);
    const second = upsertCostMonths(2024, catsByMonth, { fileName: 'Vorjahreskosten 2024.XLSX' });
    await second.kvBackup;
    expect(second.monthsWritten).toBe(0);
    expect(second.monthsUnchanged).toBe(12);
    // ER-Sicht: gespeicherte Monatssumme == Datei-Netto pro Monat (keine Doppelzählung)
    const stored = loadYear(2024);
    expect(stored.length).toBe(12);
    for (const rec of stored) {
      const netFile = (r.byMonth.get(rec.month) ?? []).reduce((s, x) => s + x.amount, 0);
      const netStored = (rec.expenseCategories ?? []).reduce((s, c) => s + c.amount, 0);
      expect(netStored).toBeCloseTo(netFile, 1);
    }
  });
});
