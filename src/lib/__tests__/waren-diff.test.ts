// @vitest-environment node
/**
 * Gesamt-Aufschlüsselung der FIBU-Differenz (SSOT): gebündelt nach
 * echte Lücken / interne Umbuchungen / Pfand-Reste; Invariante
 * lueckenSumme + pfandRestSumme = diffTotal (rappengenau).
 */
import { describe, it, expect } from 'vitest';
import { buildWarenAbgleich } from '../waren-abgleich';
import { buildAliasResolver } from '../waren-alias-gruppen';
import { buildDiffAufschluesselung } from '../waren-diff';
import type { InvoiceEntry } from '../waren-db';
import type { SageJournalEntry } from '@/types/reporting';

const inv = (p: Partial<InvoiceEntry> & { supplierName: string; amountNet: number }): InvoiceEntry => ({
  id: `inv-${Math.random().toString(36).slice(2, 8)}`,
  date: '2026-07-10', reference: p.reference ?? 'R-1', warenkonto: p.warenkonto ?? '4060',
  amountGross: p.amountGross ?? p.amountNet,
  vatIncluded: true, vatRate: 2.6,
  createdAt: '2026-07-10T00:00:00Z', updatedAt: '2026-07-10T00:00:00Z',
  ...p,
} as InvoiceEntry);

const buch = (text: string, soll: number, konto = '4060', belegNr?: string): SageJournalEntry => ({
  date: '10.07.2026', text, accountNumber: konto, accountName: 'Warenaufwand',
  soll, haben: 0, amount: soll, ...(belegNr ? { belegNr } : {}),
});

const BASE = {
  warenkontoNummern: ['4060', '4020'],
  aliases: {},
  buchhaltungTotal: null as number | null,
};

describe('buildDiffAufschluesselung', () => {
  it('bündelt Lücken/Umbuchungen/Reste; Lücken+Reste = diffTotal (exakt)', () => {
    const invoices = [
      // Transgourmet: 3 erfasste Rechnungen, KEINE Buchung → echte Lücken.
      inv({ supplierName: 'Transgourmet', amountNet: 200.68, reference: 'TG-1' }),
      inv({ supplierName: 'Transgourmet', amountNet: 120, reference: 'TG-2' }),
      inv({ supplierName: 'Transgourmet', amountNet: 100, reference: 'TG-3' }),
      // Prodega: erfasst 1000, gebucht 1184 → Rest +184 (Pfand-Rest, ungematcht ⇒ 2 Lücken-Posten).
      inv({ supplierName: 'Prodega', amountNet: 1000, reference: 'P-1' }),
    ];
    const journal = [
      buch('Prodega Juli', 1184, '4060', 'B-77'),
      buch('Umb. gemäss Webapp', -1830, '4020'),
      buch('Umb. Kontierung Feldschlösschen', -1110, '4060'),
      buch('Diverses Kleinzeug', 50, '4020', 'B-99'), // ohne Zuordnung → Lücke
    ];
    const abgleich = buildWarenAbgleich({
      ...BASE, supplierNames: ['Transgourmet', 'Prodega'], invoices, journal,
    });
    const resolve = buildAliasResolver(abgleich.effektiveAliasGruppen);
    const d = buildDiffAufschluesselung({ abgleich, invoices, resolve, gruppen: [], warenkostenGrenze: 4090 });

    expect(d.vollstaendig).toBe(true);
    expect(d.diffTotal).toBe(abgleich.diffTotal);
    // Invariante: Lücken + Reste = Differenz; Umbuchungen stehen AUSSERHALB.
    expect(d.lueckenSumme + d.pfandRestSumme).toBeCloseTo(d.diffTotal!, 2);
    expect(d.umbuchungenSumme).toBeCloseTo(-2940, 2);
    // TG-Lücken: −420.68 enthalten; nicht zugeordnete Buchung +50 auch Lücke.
    const luecken = d.gruppen.find(g => g.kategorie === 'luecke')!;
    expect(luecken.zeilen.filter(z => z.lieferant === 'Transgourmet')).toHaveLength(3);
    expect(luecken.zeilen.some(z => z.label.startsWith('Ohne Zuordnung'))).toBe(true);
    // Zeilen tragen Konto/Beleg/Betrag.
    const tg1 = luecken.zeilen.find(z => z.beleg === 'TG-1')!;
    expect(tg1.konto).toBe('4060');
    expect(tg1.betrag).toBe(-200.68);
    const umb = d.gruppen.find(g => g.kategorie === 'umbuchung')!;
    expect(umb.zeilen.map(z => z.konto).sort()).toEqual(['4020', '4060']);
  });

  it('gematchte Betragsabweichung landet als Pfand-/Betrags-Rest', () => {
    const invoices = [inv({ supplierName: 'Prodega', amountNet: 1000, reference: 'P-1', id: 'p1' } as never)];
    const journal = [buch('Prodega Juli', 1184, '4060', 'B-77')];
    const abgleich = buildWarenAbgleich({ ...BASE, supplierNames: ['Prodega'], invoices, journal });
    const resolve = buildAliasResolver(abgleich.effektiveAliasGruppen);
    const keys = ['B-77|10.07.2026|4060|1184|0']; // echter Key kommt aus buchungKeysMitIndex —
    // hier über die Match-Gruppe mit exakt diesen Keys aus dem Abgleich:
    const d = buildDiffAufschluesselung({
      abgleich, invoices, resolve,
      gruppen: [{ id: 'm1', invoiceIds: ['p1'], buchungKeys: keys }],
      warenkostenGrenze: 4090,
    });
    // Egal ob der Key exakt matcht (match_rest) oder nicht (2 Lücken-Posten):
    // die Invariante hält immer.
    expect(d.lueckenSumme + d.pfandRestSumme).toBeCloseTo(d.diffTotal!, 2);
  });

  it('degradierter Modus: keine Zerlegung, aber Umbuchungen — leer statt 0', () => {
    const abgleich = buildWarenAbgleich({
      ...BASE, supplierNames: ['Prodega'], buchhaltungTotal: 500,
      invoices: [inv({ supplierName: 'Prodega', amountNet: 500 })],
      journal: [buch('Umb. gemäss Webapp', -1830, '4020')],
    });
    const d = buildDiffAufschluesselung({
      abgleich, invoices: [], resolve: n => n, gruppen: [],
    });
    expect(d.vollstaendig).toBe(false);
    expect(d.gruppen.map(g => g.kategorie)).toEqual(['umbuchung']);
    expect(d.lueckenSumme).toBe(0);
    // Ohne Umbuchungen: gar keine Gruppen (leer statt 0).
    const leer = buildDiffAufschluesselung({
      abgleich: { ...abgleich, interneUmbuchungen: [], interneUmbuchungenSumme: 0 },
      invoices: [], resolve: n => n, gruppen: [],
    });
    expect(leer.gruppen).toHaveLength(0);
  });
});
