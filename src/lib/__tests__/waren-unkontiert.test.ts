// @vitest-environment node
/**
 * Unkontierte Positionen: Liste = exakt dieselbe Definition wie der
 * WKQ-Hinweis (zaehleUnkontierte); Zuweisung pur, WKQ rechnet danach mit.
 */
import { describe, it, expect } from 'vitest';
import { listeUnkontierte, weiseKontoZu } from '../waren-unkontiert';
import { zaehleUnkontierte, kategorieOf, istInQuote } from '../warenkosten-quote';
import type { InvoiceEntry } from '../waren-db';

const inv = (p: Partial<InvoiceEntry> & { id: string; supplierName: string; amountNet: number }): InvoiceEntry => ({
  date: '2026-08-05', amountGross: p.amountNet, vatIncluded: true, vatRate: 2.6,
  createdAt: '2026-08-05T00:00:00Z', updatedAt: '2026-08-05T00:00:00Z',
  ...p,
} as InvoiceEntry);

describe('listeUnkontierte', () => {
  const entries = [
    inv({ id: 'a', supplierName: 'Feldschlösschen', amountNet: 500, warenkonto: '4030' }),          // kontiert
    inv({ id: 'b', supplierName: 'Prodega', amountNet: 120, warenkonto: 'offen', reference: 'P-9', note: 'Warengruppe Non-Food' }),
    inv({ id: 'c', supplierName: 'Migros', amountNet: 80 }),                                        // ohne Konto
    inv({ id: 'd', supplierName: 'TG', amountNet: 60, warenkonto: 'Depot' }),                       // Depot zählt nie
    inv({
      id: 'e', supplierName: 'Feldschlösschen', amountNet: 300,
      kontoSplits: [
        { warenkonto: '4030', amountGross: 200, amountNet: 200 },
        { warenkonto: 'offen', amountGross: 60, amountNet: 60 },
        { warenkonto: 'offen', amountGross: 40, amountNet: 40 },
      ],
    }),
  ];

  it('Invariante: Liste hat exakt zaehleUnkontierte Einträge', () => {
    const liste = listeUnkontierte(entries);
    expect(liste.length).toBe(zaehleUnkontierte(entries));
    expect(liste.length).toBe(4); // b, c und 2 Splits von e
  });

  it('trägt Lieferant/Beleg/Bezeichnung — leer statt 0 (null, nicht "")', () => {
    const liste = listeUnkontierte(entries);
    const b = liste.find(z => z.entryId === 'b')!;
    expect(b).toMatchObject({ beleg: 'P-9', bezeichnung: 'Warengruppe Non-Food', betragNet: 120, splitIndex: null });
    const c = liste.find(z => z.entryId === 'c')!;
    expect(c.beleg).toBeNull();
    expect(c.bezeichnung).toBeNull();
    const splits = liste.filter(z => z.entryId === 'e');
    expect(splits.map(z => z.splitIndex).sort()).toEqual([1, 2]);
  });

  it('weiseKontoZu: Eintrag → in der Quote; Split → nur dieser Split; Depot → nie in Quote', () => {
    const b = entries.find(e => e.id === 'b')!;
    const bNeu = weiseKontoZu(b, null, '4050');
    expect(bNeu.warenkonto).toBe('4050');
    expect(istInQuote(kategorieOf(bNeu))).toBe(true);
    expect(zaehleUnkontierte([bNeu])).toBe(0);

    const e = entries.find(x => x.id === 'e')!;
    const eNeu = weiseKontoZu(e, 1, '4701');
    expect(eNeu.kontoSplits![1].warenkonto).toBe('4701');
    expect(eNeu.kontoSplits![0].warenkonto).toBe('4030'); // unberührt
    expect(zaehleUnkontierte([eNeu])).toBe(1);            // Split 2 bleibt offen

    const depot = weiseKontoZu(b, null, 'Depot');
    expect(istInQuote(kategorieOf(depot))).toBe(false);
    expect(zaehleUnkontierte([depot])).toBe(0); // Depot gilt als kontiert (neutral)
  });

  it('kontierte Liste ist leer — Hinweis verschwindet', () => {
    expect(listeUnkontierte([entries[0], entries[3]])).toHaveLength(0);
  });
});
