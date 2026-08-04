// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  buildWarenkostenExport,
  warenkostenExportFileName,
  type WarenkostenExportInvoice,
} from './warenkosten-export';

function inv(p: Partial<WarenkostenExportInvoice> & { id: string; amountNet: number }): WarenkostenExportInvoice {
  return {
    date: '2026-07-01',
    supplierName: 'Lieferant',
    amountGross: p.amountNet,
    ...p,
  };
}

describe('warenkostenExportFileName', () => {
  it('nutzt Warenkosten_<Mandant>_<yyyy-MM> bei genau einem Kalendermonat', () => {
    expect(warenkostenExportFileName('2026-07-01', '2026-07-31', 'Oliv')).toBe('Warenkosten_Oliv_2026-07.xlsx');
    expect(warenkostenExportFileName('2026-02-01', '2026-02-28', 'Le Beaulieu')).toBe('Warenkosten_LeBeaulieu_2026-02.xlsx');
    expect(warenkostenExportFileName('2026-12-05', '2026-12-20')).toBe('Warenkosten_2026-12.xlsx');
  });

  it('fällt auf ISO-Zeitraum zurück, wenn der Zeitraum mehrere Monate umfasst', () => {
    expect(warenkostenExportFileName('2026-07-01', '2026-08-31', 'Oliv')).toBe('Warenkosten_Oliv_2026-07-01_bis_2026-08-31.xlsx');
    expect(warenkostenExportFileName('2025-12-15', '2026-01-15')).toBe('Warenkosten_2025-12-15_bis_2026-01-15.xlsx');
  });
});

describe('buildWarenkostenExport – Summenblock', () => {
  it('trennt Food/Beverage/Sonstiges und schliesst Sonstiges aus der Quote aus', () => {
    const data = buildWarenkostenExport({
      periodLabel: 'Juli 2026',
      from: '2026-07-01',
      to: '2026-07-31',
      tenantName: 'Oliv',
      revenue: 10000,
      invoices: [
        inv({ id: 'a', amountNet: 1000, warenkonto: '4000' }),          // Food
        inv({ id: 'b', amountNet: 500, warenkonto: '4020' }),           // Beverage
        inv({ id: 'c', amountNet: 300, warenkonto: '5000' }),           // Sonstiges
        inv({ id: 'd', amountNet: 200, kategorie: 'Food' }),            // Food explizit
      ],
    });

    expect(data.summary.foodNet).toBe(1200);
    expect(data.summary.beverageNet).toBe(500);
    expect(data.summary.sonstigeNet).toBe(300);
    expect(data.summary.relevantNet).toBe(1700);
    expect(data.summary.totalNet).toBe(2000);
    expect(data.summary.revenue).toBe(10000);
    // Quote = relevant (1700) / 10000 = 17 %, Sonstiges NICHT enthalten
    expect(data.summary.quotePct).toBeCloseTo(17, 6);
  });

  it('liefert quotePct=null bei fehlendem/0-Umsatz', () => {
    const base = {
      periodLabel: 'Juli 2026',
      from: '2026-07-01',
      to: '2026-07-31',
      tenantName: 'Oliv',
      invoices: [inv({ id: 'a', amountNet: 1000, warenkonto: '4000' })],
    };
    expect(buildWarenkostenExport({ ...base, revenue: null }).summary.quotePct).toBeNull();
    expect(buildWarenkostenExport({ ...base, revenue: 0 }).summary.quotePct).toBeNull();
  });

  it('summiert Brutto separat und leitet MwSt je Zeile als Brutto − Netto ab', () => {
    const data = buildWarenkostenExport({
      periodLabel: 'Juli 2026',
      from: '2026-07-01',
      to: '2026-07-31',
      tenantName: 'Oliv',
      revenue: 10000,
      invoices: [
        inv({ id: 'a', amountNet: 1000, amountGross: 1081, warenkonto: '4000' }),
        inv({ id: 'b', amountNet: 500, amountGross: 540.5, warenkonto: '4020' }),
      ],
    });
    expect(data.summary.totalGross).toBeCloseTo(1621.5, 6);
    const rowA = data.rows.find(r => r.supplierName === 'Lieferant' && r.amountNet === 1000)!;
    expect(rowA.amountVat).toBeCloseTo(81, 6);
  });
});

describe('buildWarenkostenExport – Detailzeilen', () => {
  it('markiert imQuote korrekt und sortiert nach Datum, dann Lieferant', () => {
    const data = buildWarenkostenExport({
      periodLabel: 'Juli 2026',
      from: '2026-07-01',
      to: '2026-07-31',
      tenantName: 'Oliv',
      revenue: 10000,
      invoices: [
        inv({ id: 'z', amountNet: 100, date: '2026-07-05', supplierName: 'Zeta', warenkonto: '4000' }),
        inv({ id: 'b', amountNet: 100, date: '2026-07-01', supplierName: 'Bravo', warenkonto: '5000' }),
        inv({ id: 'a', amountNet: 100, date: '2026-07-01', supplierName: 'Alpha', warenkonto: '4020' }),
      ],
    });
    expect(data.rows.map(r => r.supplierName)).toEqual(['Alpha', 'Bravo', 'Zeta']);
    expect(data.rows.map(r => r.imQuote)).toEqual([true, false, true]);
    expect(data.rows.map(r => r.kategorieLabel)).toEqual(['Beverage', 'Sonstiges', 'Food']);
  });

  it('setzt den Dateinamen aus dem Zeitraum ab', () => {
    const data = buildWarenkostenExport({
      periodLabel: 'Juli 2026',
      from: '2026-07-01',
      to: '2026-07-31',
      tenantName: 'Oliv',
      revenue: null,
      invoices: [],
    });
    expect(data.fileName).toBe('Warenkosten_Oliv_2026-07.xlsx');
    expect(data.rows).toEqual([]);
    expect(data.summary.relevantNet).toBe(0);
  });
});
