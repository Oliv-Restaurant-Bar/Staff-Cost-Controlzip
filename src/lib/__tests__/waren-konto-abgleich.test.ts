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
  it('Pfand-Splits (4800 UND Legacy-Depot) landen in der neutralen «Depot»-Zeile — nie als normales Konto', () => {
    const zeilen = buildKontoAbgleich({
      invoices: [
        // Nicht-FS-Lieferant mit echtem 4800-Split (neuer Standard)
        inv({ id: 'a', kontoSplits: [
          { warenkonto: '4020', amountNet: 200, amountGross: 216.2 },
          { warenkonto: '4800', amountNet: -50, amountGross: -50 },
        ] }),
        // Legacy-Split «Depot» — identisch behandelt
        inv({ id: 'b', kontoSplits: [
          { warenkonto: '4030', amountNet: 100, amountGross: 108.1 },
          { warenkonto: 'Depot', amountNet: -20, amountGross: -20 },
        ] }),
        // Reine 4800-Rechnung ohne Splits
        inv({ id: 'c', warenkonto: '4800', amountNet: -10 }),
      ],
      journal: [buchung('4020', 200), buchung('4800', -80)],
    });
    // Keine normale 4800-Zeile mit Journal-Vergleich auf der erfasst-Seite:
    const depot = zeilen.find(z => z.konto === 'Depot')!;
    expect(depot.erfasst).toBeCloseTo(-80, 2);
    expect(depot.gebucht).toBeNull(); // neutral — nie gegen das Journal gerechnet
    const vierAchtHundert = zeilen.filter(z => z.konto === '4800');
    // Journal-only 4800 darf höchstens als reine Journal-Zeile erscheinen (erfasst 0),
    // nie mit erfassten Pfand-Beträgen befüllt:
    for (const z of vierAchtHundert) expect(z.erfasst).toBe(0);
    expect(zeilen.find(z => z.konto === '4020')).toMatchObject({ erfasst: 200, gebucht: 200, diff: 0 });
  });

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

  it('lieferantZeilen: Rechnungen + Journal-Buchungen des Lieferanten in EINER Zeile (alle Konten)', () => {
    const zeilen = buildKontoAbgleich({
      invoices: [
        inv({ id: 'fs1', supplierName: 'Feldschlösschen', kontoSplits: [
          { warenkonto: '4030', amountNet: 4538, amountGross: 4905.58 },
          { warenkonto: '4040', amountNet: 2789.3, amountGross: 3015.23 },
          { warenkonto: '4050', amountNet: 7450.77, amountGross: 8054.28 },
          { warenkonto: 'Depot', amountNet: 1186, amountGross: 1186 },
        ] }),
        inv({ id: 'tg1', supplierName: 'Transgourmet', warenkonto: '4030', amountNet: 111 }),
      ],
      journal: [
        { ...buchung('4030', 14700), text: 'Feldschlösschen Getränke AG Monatsrechnung' },
        { ...buchung('4030', 111), text: 'Transgourmet' },
      ],
      lieferantZeilen: [{ name: 'Feldschlösschen', rx: /feldschl/i }],
    });
    const fs = zeilen.find(z => z.konto === '~Feldschlösschen')!;
    // Depot bleibt aussen vor (neutral): 4538 + 2789.30 + 7450.77 = 14778.07
    expect(fs).toMatchObject({ erfasst: 14778.07, gebucht: 14700, diff: 78.07 });
    // 4030 enthält NUR noch Transgourmet — FS wurde herausgelöst
    expect(zeilen.find(z => z.konto === '4030')).toMatchObject({ erfasst: 111, gebucht: 111, diff: 0 });
    expect(zeilen.find(z => z.konto === 'Depot')).toMatchObject({ erfasst: 1186, gebucht: null });
  });

  it('lieferantZeilen: reine Depot-Rechnung (Einzelkonto) bleibt neutral, keine Lieferantenzeile', () => {
    const zeilen = buildKontoAbgleich({
      invoices: [inv({ id: 'fs2', supplierName: 'Feldschlösschen', warenkonto: 'Depot', amountNet: 185.4 })],
      journal: [],
      lieferantZeilen: [{ name: 'Feldschlösschen', rx: /feldschl/i }],
    });
    expect(zeilen.find(z => z.konto === 'Depot')).toMatchObject({ erfasst: 185.4, gebucht: null, diff: null });
    expect(zeilen.some(z => z.konto === '~Feldschlösschen')).toBe(false);
  });

  it('lieferantZeilen: nur-Journal-Lieferant erscheint sichtbar (erfasst 0)', () => {
    const zeilen = buildKontoAbgleich({
      invoices: [],
      journal: [{ ...buchung('4030', 500), text: 'Feldschlösschen' }],
      lieferantZeilen: [{ name: 'Feldschlösschen', rx: /feldschl/i }],
    });
    expect(zeilen.find(z => z.konto === '~Feldschlösschen')).toMatchObject({ erfasst: 0, gebucht: 500, diff: -500 });
  });

  it('Haben (Gutschriften) mindern gebucht (Soll − Haben)', () => {
    const zeilen = buildKontoAbgleich({
      invoices: [],
      journal: [buchung('4020', 500), buchung('4020', 0, 50)],
    });
    expect(zeilen.find(z => z.konto === '4020')).toMatchObject({ erfasst: 0, gebucht: 450 });
  });
});
