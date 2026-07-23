// @vitest-environment happy-dom
// happy-dom (statt node), weil kpi-catalog transitiv den Supabase-Client lädt
// (localStorage beim Modul-Load).
/**
 * Management-KPI-Export — Identität UI ≡ Excel ≡ PDF (Korrekturrunde).
 *
 * Zeilen kommen aus buildManagementKpiRows (dieselben getKpiValues/getKpiTone
 * wie die UI, inkl. Dependency-Gate); Excel-Zellen tragen Rohwerte (null =
 * LEERE Zelle), der PDF-Body dieselben formatierten Strings («—» für null).
 * Hinweiszeile «Laufender Monat …» verschiebt die Datenzeilen — Zahlformate
 * müssen mitwandern (dataStart dynamisch).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as XLSX from 'xlsx';
import autoTable from 'jspdf-autotable';
import {
  buildManagementKpiRows,
  exportManagementKpisToExcel,
  exportManagementKpisToPDF,
  filterRowsForProfile,
} from '@/lib/management-kpi-export';
import { KPI_CATALOG, getKpiValues, type KpiCatalogInput } from '@/lib/kpi-catalog';
import { computePLForMonth } from '@/lib/pl-engine';
import type { MonthlyFinancialRecord } from '@/types/reporting';

vi.mock('xlsx', async importOriginal => {
  const actual = await importOriginal<typeof import('xlsx')>();
  return { ...actual, writeFile: vi.fn() };
});
vi.mock('jspdf', () => ({
  default: vi.fn().mockImplementation(() => ({
    internal: { pageSize: { getWidth: () => 210 } },
    setFillColor: vi.fn(),
    rect: vi.fn(),
    setTextColor: vi.fn(),
    setFontSize: vi.fn(),
    setFont: vi.fn(),
    text: vi.fn(),
    save: vi.fn(),
  })),
}));
vi.mock('jspdf-autotable', () => ({ default: vi.fn() }));

const mkRec = (over: Partial<MonthlyFinancialRecord> = {}): MonthlyFinancialRecord => ({
  id: '2026-07',
  year: 2026,
  month: 7,
  expenseCategories: [],
  expenseCategoriesPreviousYear: [],
  ...over,
} as MonthlyFinancialRecord);

/** Unvollständiger Monat: Umsatz da, Abschreibungen fehlen ⇒ EBIT gegated null. */
const incompleteInput: KpiCatalogInput = {
  financialInput: {
    pl: computePLForMonth(mkRec({
      revenueActual: 100_000,
      personnelCostActual: 35_000,
      expenseCategories: [
        { categoryId: 'food_cost', amount: 30_000, label: 'Wareneinsatz Küche' },
        { categoryId: 'miete', amount: 10_000, label: 'Miete' },
      ] as never,
    })),
  },
  guests: null,
  avgReceipt: null,
  productiveHours: null,
  verkaufsWes: null,
  cash: null,
  personnelRatioTarget: null,
};

const NOTE = 'Laufender Monat – Vergleich mit vollständigem Monatsbudget · IST = Stand 23.07.2026';

function lastWrittenSheet(): XLSX.WorkSheet {
  const writeFile = vi.mocked(XLSX.writeFile);
  const wb = writeFile.mock.calls.at(-1)?.[0] as XLSX.WorkBook;
  return wb.Sheets[wb.SheetNames[0]];
}

beforeEach(() => {
  vi.mocked(XLSX.writeFile).mockClear();
  vi.mocked(autoTable).mockClear();
});

describe('buildManagementKpiRows ≡ UI (getKpiValues, inkl. Dependency-Gate)', () => {
  it('jede Zeile trägt exakt die UI-Werte; gegatetes EBIT bleibt null', () => {
    const rows = buildManagementKpiRows(incompleteInput, {}, '2026-07');
    expect(rows).toHaveLength(KPI_CATALOG.length);
    for (const row of rows) {
      const v = getKpiValues(row.def.id, incompleteInput);
      expect(row.actual).toBe(v.actual);
      expect(row.budget).toBe(v.budget);
      expect(row.priorYear).toBe(v.priorYear);
    }
    const ebit = rows.find(r => r.def.id === 'ebit')!;
    expect(ebit.actual).toBeNull();
    expect(rows.find(r => r.def.id === 'umsatz')!.actual).toBe(100_000);
  });
});

describe('Excel-Export — Rohwerte, leere Zellen für null, Hinweiszeilen-Offset', () => {
  it('ohne Hinweis: Datenstart Zeile 5 (Index 4); EBIT-IST-Zelle LEER, Umsatz Rohwert', () => {
    const rows = buildManagementKpiRows(incompleteInput, {}, '2026-07');
    exportManagementKpisToExcel(rows, 'geschaeftsleitung', 'Juli 2026', 'Oliv');
    const ws = lastWrittenSheet();
    const filtered = filterRowsForProfile(rows, 'geschaeftsleitung');
    const umsatzRi = filtered.findIndex(r => r.def.id === 'umsatz');
    const ebitRi = filtered.findIndex(r => r.def.id === 'ebit');
    expect(ws[XLSX.utils.encode_cell({ r: 4 + umsatzRi, c: 1 })]?.v).toBe(100_000);
    expect(ws[XLSX.utils.encode_cell({ r: 4 + umsatzRi, c: 1 })]?.z).toBe('#,##0');
    // gegated null ⇒ Zelle existiert NICHT (leer, nie 0)
    expect(ws[XLSX.utils.encode_cell({ r: 4 + ebitRi, c: 1 })]).toBeUndefined();
  });

  it('mit Hinweiszeile: Note in Zeile 3, Datenstart verschiebt sich, Formate wandern mit', () => {
    const rows = buildManagementKpiRows(incompleteInput, {}, '2026-07');
    exportManagementKpisToExcel(rows, 'geschaeftsleitung', 'Juli 2026', 'Oliv', NOTE);
    const ws = lastWrittenSheet();
    expect(ws[XLSX.utils.encode_cell({ r: 2, c: 0 })]?.v).toBe(NOTE);
    const filtered = filterRowsForProfile(rows, 'geschaeftsleitung');
    const umsatzRi = filtered.findIndex(r => r.def.id === 'umsatz');
    const ebitRi = filtered.findIndex(r => r.def.id === 'ebit');
    // dataStart = 5 (Titel, Untertitel, Note, Leerzeile, Header)
    expect(ws[XLSX.utils.encode_cell({ r: 5 + umsatzRi, c: 0 })]?.v).toBe(
      filtered[umsatzRi].def.name,
    );
    expect(ws[XLSX.utils.encode_cell({ r: 5 + umsatzRi, c: 1 })]?.v).toBe(100_000);
    expect(ws[XLSX.utils.encode_cell({ r: 5 + umsatzRi, c: 1 })]?.z).toBe('#,##0');
    expect(ws[XLSX.utils.encode_cell({ r: 5 + ebitRi, c: 1 })]).toBeUndefined();
  });
});

describe('PDF-Export — identische Fehlzustände («—») + Hinweis-Offset', () => {
  it('EBIT-IST = «—» im Body; Umsatz formatiert; startY 28 ohne / 30 mit Hinweis', () => {
    const rows = buildManagementKpiRows(incompleteInput, {}, '2026-07');
    exportManagementKpisToPDF(rows, 'geschaeftsleitung', 'Juli 2026', 'Oliv');
    const optsOhne = vi.mocked(autoTable).mock.calls.at(-1)?.[1] as {
      startY: number; body: string[][];
    };
    expect(optsOhne.startY).toBe(28);
    const filtered = filterRowsForProfile(rows, 'geschaeftsleitung');
    const ebitRi = filtered.findIndex(r => r.def.id === 'ebit');
    const umsatzRi = filtered.findIndex(r => r.def.id === 'umsatz');
    expect(optsOhne.body[ebitRi][1]).toBe('—');
    expect(optsOhne.body[umsatzRi][1]).toBe('CHF 100’000');

    exportManagementKpisToPDF(rows, 'geschaeftsleitung', 'Juli 2026', 'Oliv', NOTE);
    const optsMit = vi.mocked(autoTable).mock.calls.at(-1)?.[1] as { startY: number };
    expect(optsMit.startY).toBe(30);
  });
});
