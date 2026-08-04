// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { aggregateBySupplier, sumInvoicesNet, warenkostenquote, wkqAmpel, monthDateRange, kategorieShares, sumNetByKategorie } from '@/lib/waren-cockpit';
import type { InvoiceEntry, Warenkonto } from '@/lib/waren-db';

function inv(supplierName: string, amountNet: number, date = '2026-07-10'): InvoiceEntry {
  return {
    id: `${supplierName}-${amountNet}-${Math.random()}`, date, supplierName,
    amountGross: amountNet * 1.026, amountNet, vatIncluded: true, vatRate: 2.6,
    createdAt: '2026-07-10T00:00:00Z', updatedAt: '2026-07-10T00:00:00Z',
  };
}

describe('kategorieShares / sumNetByKategorie (effektive Kategorie)', () => {
  const konten: Warenkonto[] = [
    { value: '4000', label: '4000 – LM', kategorie: 'Food' },
    { value: '9999', label: '9999 – Spezial', kategorie: 'Beverage' }, // explizit ≠ Heuristik
  ];

  it('persistierte kategorie hat Vorrang', () => {
    const e = { ...inv('A', 100), kategorie: 'Beverage' as const, warenkonto: '4000' };
    expect(kategorieShares(e, konten)).toEqual([{ kategorie: 'Beverage', net: 100 }]);
  });

  it('ohne kategorie: explizite Konto-Kategorie vor Nummern-Heuristik (Altbestand)', () => {
    const e = { ...inv('A', 100), warenkonto: '9999' };
    expect(kategorieShares(e, konten)[0].kategorie).toBe('Beverage');
    // Konto nicht in Stammdaten → Heuristik (4000er = Food)
    const e2 = { ...inv('A', 50), warenkonto: '4000' };
    expect(kategorieShares(e2, [])[0].kategorie).toBe('Food');
  });

  it('Split-Rechnung: je Split-Konto dessen Kategorie', () => {
    const e = { ...inv('A', 100), kontoSplits: [
      { warenkonto: '4000', amountNet: 60, amountGross: 61 },
      { warenkonto: '9999', amountNet: 40, amountGross: 41 },
    ] };
    expect(sumNetByKategorie([e], 'Food', konten)).toBe(60);
    expect(sumNetByKategorie([e], 'Beverage', konten)).toBe(40);
  });

  it('sumNetByKategorie über mehrere Rechnungen', () => {
    const list = [
      { ...inv('A', 100), kategorie: 'Food' as const },
      { ...inv('B', 30), warenkonto: '9999' },
    ];
    expect(sumNetByKategorie(list, 'Food', konten)).toBe(100);
    expect(sumNetByKategorie(list, 'Beverage', konten)).toBe(30);
    expect(sumNetByKategorie([], 'Food', konten)).toBe(0);
  });
});

describe('waren-cockpit', () => {
  it('summiert Netto-Beträge', () => {
    expect(sumInvoicesNet([inv('A', 100), inv('B', 50.5)])).toBeCloseTo(150.5);
    expect(sumInvoicesNet([])).toBe(0);
  });

  it('aggregiert nach Lieferant, absteigend, mit Anteil und Anzahl', () => {
    const rows = aggregateBySupplier([inv('A', 100), inv('B', 300), inv('A', 100)]);
    expect(rows.map(r => r.supplierName)).toEqual(['B', 'A']);
    expect(rows[0].totalNet).toBe(300);
    expect(rows[0].sharePct).toBeCloseTo(60);
    expect(rows[0].count).toBe(1);
    expect(rows[1].totalNet).toBe(200);
    expect(rows[1].sharePct).toBeCloseTo(40);
    expect(rows[1].count).toBe(2);
  });

  it('leerer Lieferantenname wird als «—» gebündelt', () => {
    const rows = aggregateBySupplier([inv('', 10), inv('  ', 20)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].supplierName).toBe('—');
    expect(rows[0].totalNet).toBe(30);
  });

  it('WKQ: null ohne Umsatz, sonst Prozent', () => {
    expect(warenkostenquote(100, 0)).toBeNull();
    expect(warenkostenquote(300, 1000)).toBeCloseTo(30);
  });

  it('monthDateRange: kalenderkorrekter Monatsletzter (Feb, 30-Tage, Schaltjahr)', () => {
    expect(monthDateRange(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthDateRange(2028, 2)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthDateRange(2026, 4)).toEqual({ from: '2026-04-01', to: '2026-04-30' });
    expect(monthDateRange(2026, 12)).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    // Folgemonats-Tag liegt strikt NACH `to` (String-Vergleich wie im Lader)
    expect('2026-03-01' > monthDateRange(2026, 2).to).toBe(true);
  });

  it('Ampel: grün ≤ Ziel, rot > Ziel, null ohne WKQ', () => {
    expect(wkqAmpel(29.9, 30)).toBe('green');
    expect(wkqAmpel(30, 30)).toBe('green');
    expect(wkqAmpel(30.1, 30)).toBe('red');
    expect(wkqAmpel(null, 30)).toBeNull();
  });
});

describe('filterInvoicesByRange & supplierSlug', () => {
  it('filtert inklusiv nach ISO-Datum', async () => {
    const { filterInvoicesByRange } = await import('@/lib/waren-cockpit');
    const list = [inv('A', 10, '2026-07-01'), inv('A', 20, '2026-07-15'), inv('A', 30, '2026-08-01')];
    const got = filterInvoicesByRange(list, '2026-07-01', '2026-07-31');
    expect(got.map(e => e.amountNet)).toEqual([10, 20]);
    expect(filterInvoicesByRange(list, '2026-07-02', '2026-07-14')).toHaveLength(0);
  });
  it('supplierSlug: stabil, Umlaute, Sonderzeichen', async () => {
    const { supplierSlug } = await import('@/lib/waren-cockpit');
    expect(supplierSlug('Growa CC')).toBe('growa_cc');
    expect(supplierSlug('Müller & Söhne AG')).toBe('mueller_soehne_ag');
    expect(supplierSlug('  —  ')).toBe('unbenannt');
    expect(supplierSlug('')).toBe('unbenannt');
  });
});

describe('supplierRowIds (kollisionssicher)', () => {
  it('vergibt deterministische Suffixe bei Slug-Kollision', async () => {
    const { supplierRowIds } = await import('@/lib/waren-cockpit');
    expect(supplierRowIds(['Migros', 'MIGROS!', 'Coop', 'migros']))
      .toEqual(['migros', 'migros_2', 'coop', 'migros_3']);
    expect(supplierRowIds([])).toEqual([]);
    expect(supplierRowIds(['', ' '])).toEqual(['unbenannt', 'unbenannt_2']);
  });
});
