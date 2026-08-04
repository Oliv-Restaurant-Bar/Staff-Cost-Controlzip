// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  isoWeekKeyOf, weekLabelOf, groupTotals, flagAnomalies, topInvoices,
  wochenWkq, analyseKpis,
} from '@/lib/waren-analyse';
import { buildWarenkostenExport, warenkostenExportFileName } from '@/lib/warenkosten-export';
import type { InvoiceEntry } from '@/lib/waren-db';

let seq = 0;
function inv(partial: Partial<InvoiceEntry> & { date: string; amountNet: number }): InvoiceEntry {
  return {
    id: `e${++seq}`, supplierName: 'Prodega', amountGross: partial.amountNet * 1.026,
    vatIncluded: true, vatRate: 2.6, createdAt: '', updatedAt: '',
    ...partial,
  } as InvoiceEntry;
}

describe('isoWeekKeyOf', () => {
  it('ISO-Wochenjahr über Jahresgrenzen', () => {
    expect(isoWeekKeyOf('2026-01-01')).toBe('2026-W01'); // Do
    expect(isoWeekKeyOf('2025-12-29')).toBe('2026-W01'); // Mo derselben Woche
    expect(isoWeekKeyOf('2026-07-27')).toBe('2026-W31');
    expect(weekLabelOf('2026-W05')).toBe('KW 5');
  });
});

describe('groupTotals', () => {
  const list = [
    inv({ date: '2026-07-01', amountNet: 100, supplierName: 'A', warenkonto: '4000' }),
    inv({ date: '2026-07-02', amountNet: 300, supplierName: 'B', warenkonto: '4020' }),
    inv({ date: '2026-07-03', amountNet: 50, supplierName: 'A', kontoSplits: [
      { warenkonto: '4000', amountNet: 30, amountGross: 31 },
      { warenkonto: '4020', amountNet: 20, amountGross: 21 },
    ] }),
  ];
  it('Lieferant: Top-Betrag zuerst', () => {
    const rows = groupTotals(list, 'supplier');
    expect(rows.map(r => r.key)).toEqual(['B', 'A']);
    expect(rows[1].totalNet).toBe(150);
  });
  it('Konto: Splits zählen pro Konto', () => {
    const rows = groupTotals(list, 'konto', [{ value: '4000', label: '4000 – LM' }]);
    const k4000 = rows.find(r => r.key === '4000')!;
    expect(k4000.totalNet).toBe(130);
    expect(k4000.label).toBe('4000 – LM');
    expect(rows.find(r => r.key === '4020')!.totalNet).toBe(320);
  });
  it('Woche/Monat chronologisch', () => {
    const rows = groupTotals([
      inv({ date: '2026-07-13', amountNet: 10 }), inv({ date: '2026-07-06', amountNet: 5 }),
    ], 'week');
    expect(rows.map(r => r.key)).toEqual(['2026-W28', '2026-W29']);
  });
});

describe('flagAnomalies', () => {
  it('Lieferant: letzte Woche > +30% vs. Schnitt der Vorwochen → rot', () => {
    const list = [
      inv({ date: '2026-07-06', amountNet: 100, supplierName: 'A' }), // W28
      inv({ date: '2026-07-13', amountNet: 100, supplierName: 'A' }), // W29
      inv({ date: '2026-07-20', amountNet: 200, supplierName: 'A' }), // W30 → 2x Schnitt
      inv({ date: '2026-07-06', amountNet: 100, supplierName: 'B' }),
      inv({ date: '2026-07-13', amountNet: 100, supplierName: 'B' }),
      inv({ date: '2026-07-20', amountNet: 110, supplierName: 'B' }), // +10% → ok
    ];
    const rows = flagAnomalies(groupTotals(list, 'supplier'), list, 'supplier');
    expect(rows.find(r => r.key === 'A')!.flagged).toBe(true);
    expect(rows.find(r => r.key === 'A')!.deltaPct).toBe(100); // 200 vs. Schnitt 100
    expect(rows.find(r => r.key === 'B')!.flagged).toBe(false);
    expect(rows.find(r => r.key === 'B')!.deltaPct).toBe(10);
  });
  it('zu wenig Vorwochen → keine Markierung', () => {
    const list = [
      inv({ date: '2026-07-13', amountNet: 100, supplierName: 'A' }),
      inv({ date: '2026-07-20', amountNet: 500, supplierName: 'A' }),
    ];
    const rows = flagAnomalies(groupTotals(list, 'supplier'), list, 'supplier');
    expect(rows[0].flagged).toBe(false);
  });
  it('Woche: Ausreisser-Woche wird markiert', () => {
    const list = [
      inv({ date: '2026-07-06', amountNet: 100 }),
      inv({ date: '2026-07-13', amountNet: 100 }),
      inv({ date: '2026-07-20', amountNet: 400 }),
    ];
    const rows = flagAnomalies(groupTotals(list, 'week'), list, 'week');
    const w30 = rows.find(r => r.key === '2026-W30')!;
    expect(w30.flagged).toBe(true);
    expect(w30.deltaPct).toBe(300); // 400 vs. Schnitt 100
    expect(rows.find(r => r.key === '2026-W28')!.flagged).toBe(false);
  });
});

describe('wochenWkq & topInvoices & analyseKpis', () => {
  it('WKQ je Woche mit Ampel, Wochen ohne Umsatz → null', () => {
    const list = [
      inv({ date: '2026-07-06', amountNet: 350 }), // W28
      inv({ date: '2026-07-13', amountNet: 200 }), // W29
    ];
    const rev = { '2026-07-06': 500, '2026-07-07': 500 }; // nur W28: 1000
    const rows = wochenWkq(list, rev, 30);
    expect(rows[0]).toMatchObject({ weekKey: '2026-W28', wkqPct: 35, ampel: 'red' });
    expect(rows[1]).toMatchObject({ weekKey: '2026-W29', wkqPct: null, ampel: null });
  });
  it('topInvoices sortiert absteigend', () => {
    const list = [inv({ date: '2026-07-01', amountNet: 10 }), inv({ date: '2026-07-02', amountNet: 99 })];
    expect(topInvoices(list, 1)[0].amountNet).toBe(99);
  });
  it('analyseKpis: Anteile + Top-3', () => {
    const k = analyseKpis([
      inv({ date: '2026-07-01', amountNet: 60, kategorie: 'Food', supplierName: 'A' }),
      inv({ date: '2026-07-01', amountNet: 40, kategorie: 'Beverage', supplierName: 'B' }),
    ]);
    expect(k.totalNet).toBe(100);
    expect(k.foodSharePct).toBe(60);
    expect(k.top3.map(t => t.label)).toEqual(['A', 'B']);
    expect(analyseKpis([]).foodSharePct).toBeNull();
  });
});

describe('Export: Summenblöcke & Dateiname', () => {
  it('Dateiname Warenkosten_<Mandant>_<yyyy-MM>.xlsx', () => {
    expect(warenkostenExportFileName('2026-07-01', '2026-07-31', 'Oliv')).toBe('Warenkosten_Oliv_2026-07.xlsx');
    expect(warenkostenExportFileName('2026-06-01', '2026-07-31', 'Le Beaulieu')).toBe('Warenkosten_LeBeaulieu_2026-06-01_bis_2026-07-31.xlsx');
  });
  it('bySupplier/byKonto/byWeek korrekt aggregiert', () => {
    const data = buildWarenkostenExport({
      periodLabel: 'Juli 2026', from: '2026-07-01', to: '2026-07-31', tenantName: 'Oliv',
      revenue: 1000,
      invoices: [
        { id: 'x1', date: '2026-07-06', supplierName: 'A', amountNet: 100, amountGross: 102.6, warenkonto: '4000', kategorie: 'Food' },
        { id: 'x2', date: '2026-07-06', supplierName: 'B', amountNet: 300, amountGross: 307.8, warenkonto: '4020', kategorie: 'Beverage' },
        { id: 'x3', date: '2026-07-13', supplierName: 'A', amountNet: 50, amountGross: 51.3, warenkonto: '4000', kategorie: 'Food' },
      ],
    });
    expect(data.bySupplier.map(r => r.label)).toEqual(['B', 'A']);
    expect(data.bySupplier[1]).toMatchObject({ totalNet: 150, count: 2 });
    expect(data.byKonto.find(r => r.label === '4000')!.totalNet).toBe(150);
    expect(data.byWeek.map(r => r.label)).toEqual(['KW 28', 'KW 29']);
    expect(data.fileName).toBe('Warenkosten_Oliv_2026-07.xlsx');
  });
});

describe('wochenWkq: split-bewusste WKQ-Basis (A1)', () => {
  it('Betriebskosten-Konto fliesst NICHT in die Wochen-WKQ, Warenkonto schon', () => {
    const list = [
      inv({ date: '2026-07-27', amountNet: 100, warenkonto: '4020' }),
      inv({ date: '2026-07-27', amountNet: 50, warenkonto: '4500' }), // Betrieb
      inv({ date: '2026-07-28', amountNet: 30, warenkonto: 'Depot' }), // neutral
    ];
    const rows = wochenWkq(list, { '2026-07-27': 500, '2026-07-28': 500 }, 30);
    expect(rows).toHaveLength(1);
    expect(rows[0].warenNet).toBeCloseTo(100, 2);
    expect(rows[0].wkqPct).toBeCloseTo(10, 2);
  });
});

describe('analyseKpis: relevantNet + unkontiert (A1/A2)', () => {
  it('relevantNet = Food+Beverage (Konto autoritativ), unkontierte werden gezählt', () => {
    const list = [
      inv({ date: '2026-07-01', amountNet: 100, warenkonto: '4000' }), // Food
      inv({ date: '2026-07-01', amountNet: 40, warenkonto: '4030' }), // Beverage
      inv({ date: '2026-07-02', amountNet: 25, warenkonto: '4500' }), // Betrieb → nicht relevant
      inv({ date: '2026-07-03', amountNet: 10 }), // unkontiert → zählt als Food + Hinweis
    ];
    const k = analyseKpis(list);
    expect(k.relevantNet).toBeCloseTo(150, 2);
    expect(k.unkontiert).toBe(1);
    expect(k.totalNet).toBeCloseTo(175, 2);
  });
});
