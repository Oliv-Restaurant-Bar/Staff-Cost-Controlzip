// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildKontoAbgleich } from '@/lib/waren-abgleich';
import type { InvoiceEntry } from '@/lib/waren-db';
import type { SageJournalEntry } from '@/types/reporting';

const inv = (o: Partial<InvoiceEntry>): InvoiceEntry => ({
  id: 'x', date: '2026-07-05', supplierName: 'TG', amountGross: 108.1, amountNet: 100,
  vatIncluded: false, vatRate: 8.1, createdAt: '', updatedAt: '', ...o,
} as unknown as InvoiceEntry);

const buchung = (accountNumber: string, soll: number, haben = 0): SageJournalEntry => ({
  date: '05.07.2026', text: 'Buchung', accountNumber, accountName: `Konto ${accountNumber}`,
  soll, haben, amount: soll - haben,
} as unknown as SageJournalEntry);

describe('buildKontoAbgleich', () => {
  it('erfasst je Konto (Splits + Einzelkonto) vs. gebucht je Konto; Diff', () => {
    const zeilen = buildKontoAbgleich({
      invoices: [
        inv({ id: 'a', warenkonto: '4020', amountNet: 500 }),
        inv({ id: 'b', kontoSplits: [
          { warenkonto: '4060', amountNet: 300, amountGross: 324.3 },
          { warenkonto: '4020', amountNet: 100, amountGross: 108.1 },
        ] }),
      ],
      journal: [buchung('4020', 590), buchung('04060', 310)], // führende Null toleriert
      kontoNamen: { '4020': 'Wein Warenaufwand' },
    });
    const wein = zeilen.find(z => z.konto === '4020')!;
    expect(wein).toMatchObject({ erfasst: 600, gebucht: 590, diff: 10, bezeichnung: 'Wein Warenaufwand' });
    const kueche = zeilen.find(z => z.konto === '4060')!;
    expect(kueche).toMatchObject({ erfasst: 300, gebucht: 310, diff: -10 });
  });

  it('kein Journal-Konto → gebucht/diff null (leer statt 0); nur-Journal-Konto erscheint', () => {
    const zeilen = buildKontoAbgleich({
      invoices: [inv({ warenkonto: '4090', amountNet: 50 })],
      journal: [buchung('4030', 200)],
    });
    expect(zeilen.find(z => z.konto === '4090')).toMatchObject({ erfasst: 50, gebucht: null, diff: null });
    expect(zeilen.find(z => z.konto === '4030')).toMatchObject({ erfasst: 0, gebucht: 200, diff: -200 });
  });

  it('nicht-numerische Pseudo-Konten (Depot/offen) ohne Journal-Vergleich; null-Journal ok', () => {
    const zeilen = buildKontoAbgleich({
      invoices: [inv({ kontoSplits: [
        { warenkonto: '4060', amountNet: 90, amountGross: 97.3 },
        { warenkonto: 'Depot', amountNet: 6.4, amountGross: 6.4 },
        { warenkonto: 'offen', amountNet: 3.6, amountGross: 3.9 },
      ] })],
      journal: null,
    });
    expect(zeilen.find(z => z.konto === 'Depot')).toMatchObject({ erfasst: 6.4, gebucht: null, diff: null });
    expect(zeilen.find(z => z.konto === 'offen')).toMatchObject({ erfasst: 3.6, gebucht: null, diff: null });
    expect(zeilen.find(z => z.konto === '4060')).toMatchObject({ gebucht: null, diff: null });
  });

  it('relevanteKonten begrenzt nur-Journal-Zeilen (Kontoblatt flutet nicht)', () => {
    const zeilen = buildKontoAbgleich({
      invoices: [inv({ warenkonto: '4020', amountNet: 100 })],
      journal: [buchung('4020', 100), buchung('4030', 50), buchung('6040', 999), buchung('5000', 12345)],
      relevanteKonten: ['4020', '4030', '4060'],
    });
    expect(zeilen.map(z => z.konto).sort()).toEqual(['4020', '4030']); // 6040/5000 raus
  });

  it('Haben (Gutschriften) mindern gebucht (Soll − Haben)', () => {
    const zeilen = buildKontoAbgleich({
      invoices: [],
      journal: [buchung('4020', 500), buchung('4020', 0, 50)],
    });
    expect(zeilen.find(z => z.konto === '4020')).toMatchObject({ erfasst: 0, gebucht: 450 });
  });
});
