// @vitest-environment node
/**
 * Warenrechnungen ↔ Buchhaltung Abgleich — pro Lieferant, mit sauberer
 * Degradation ohne Buchungszeilen (nur Total-Vergleich, «keine
 * Buchhaltungsdaten» pro Lieferant, NIE ein Fehler) + Dublettencheck.
 */
import { describe, it, expect } from 'vitest';
import { buildWarenAbgleich, findeDublette, journalVerfuegbarFuerTenant } from '../waren-abgleich';
import type { InvoiceEntry } from '../waren-db';
import type { SageJournalEntry } from '@/types/reporting';

const inv = (p: Partial<InvoiceEntry> & { supplierName: string; amountNet: number }): InvoiceEntry => ({
  id: p.id ?? Math.random().toString(36).slice(2),
  date: p.date ?? '2026-07-10',
  amountGross: p.amountGross ?? p.amountNet,
  vatIncluded: true, vatRate: 2.6,
  createdAt: '2026-07-10T00:00:00Z', updatedAt: '2026-07-10T00:00:00Z',
  ...p,
});

const buch = (text: string, soll: number, konto = '4000'): SageJournalEntry => ({
  date: '10.07.2026', text, accountNumber: konto, accountName: 'Warenaufwand',
  soll, haben: 0, amount: soll,
});

const BASE = {
  warenkontoNummern: ['4000', '4020'],
  supplierNames: ['Prodega', 'Transgourmet', 'Blaser Café'],
  aliases: {},
  buchhaltungTotal: null as number | null,
};

describe('buildWarenAbgleich — Lieferanten-Modus', () => {
  it('matcht Buchungen über Buchungstext, berechnet Differenz + Status', () => {
    const r = buildWarenAbgleich({
      ...BASE,
      invoices: [inv({ supplierName: 'Prodega', amountNet: 1000 }), inv({ supplierName: 'Blaser Café', amountNet: 200 })],
      journal: [
        buch('ER Prodega Markt', 1010),          // Δ 10 → ok (unter Schwelle 50)
        buch('Rechnung Transgourmet', 300),      // nur gebucht
        buch('Bareinkauf Denner', 80),           // nicht zuordenbar
        buch('Lohnbuchung', 5000, '5000'),       // fremdes Konto → ignoriert
      ],
    });
    expect(r.mode).toBe('lieferanten');
    const prodega = r.zeilen.find(z => z.lieferant === 'Prodega')!;
    expect(prodega.gebucht).toBe(1010);
    expect(prodega.diff).toBe(10);
    expect(prodega.status).toBe('ok');
    expect(r.zeilen.find(z => z.lieferant === 'Transgourmet')!.status).toBe('nur-gebucht');
    expect(r.zeilen.find(z => z.lieferant === 'Blaser Café')!.status).toBe('nur-erfasst');
    expect(r.nichtZugeordnet.length).toBe(1);
    expect(r.nichtZugeordnetSumme).toBe(80);
    expect(r.gebuchtTotal).toBe(1390); // 1010+300+80, ohne Konto 5000
    expect(r.diffTotal).toBe(1390 - 1200);
  });

  it('Differenz über Schwelle → abweichung; Haben mindert (Gutschrift)', () => {
    const r = buildWarenAbgleich({
      ...BASE,
      invoices: [inv({ supplierName: 'Prodega', amountNet: 1000 })],
      journal: [buch('Prodega', 1200), { ...buch('Gutschrift Prodega', 0), haben: 50, amount: 50 }],
    });
    const z = r.zeilen[0];
    expect(z.gebucht).toBe(1150);
    expect(z.status).toBe('abweichung');
    expect(z.anzahlBuchungen).toBe(2);
  });
});

describe('buildWarenAbgleich — Degradation ohne Buchungszeilen', () => {
  it('journal null/leer → nur-total mit ER-Total, pro Lieferant keine-fibu', () => {
    for (const journal of [null, []]) {
      const r = buildWarenAbgleich({
        ...BASE, journal,
        invoices: [inv({ supplierName: 'Prodega', amountNet: 800 })],
        buchhaltungTotal: 900,
      });
      expect(r.mode).toBe('nur-total');
      expect(r.erfasstTotal).toBe(800);
      expect(r.gebuchtTotal).toBe(900);
      expect(r.diffTotal).toBe(100);
      expect(r.zeilen[0].status).toBe('keine-fibu');
      expect(r.zeilen[0].gebucht).toBeNull();
    }
  });

  it('auch ohne ER-Total kein Fehler (alles null)', () => {
    const r = buildWarenAbgleich({ ...BASE, journal: null, invoices: [], buchhaltungTotal: null });
    expect(r.mode).toBe('nur-total');
    expect(r.gebuchtTotal).toBeNull();
    expect(r.diffTotal).toBeNull();
    expect(r.zeilen).toEqual([]);
  });

  it('Journal vorhanden, aber nur fremde Konten → ebenfalls degradiert', () => {
    const r = buildWarenAbgleich({
      ...BASE, journal: [buch('Lohn', 5000, '5000')],
      invoices: [inv({ supplierName: 'Prodega', amountNet: 100 })],
      buchhaltungTotal: 120,
    });
    expect(r.mode).toBe('nur-total');
    expect(r.diffTotal).toBe(20);
  });
});

describe('journalVerfuegbarFuerTenant — Mandanten-Schutz', () => {
  it('Oliv (Legacy-Keys ohne Präfix) und Beaulieu (tenant-präfixierte Keys) nutzen das Journal', () => {
    // Journal-Keys sind mandantenfähig (reporting-store.journalMonthKey):
    // Oliv historisch ohne Präfix, Beaulieu mit `beaulieu:`-Präfix.
    // Unbekannte Mandanten bleiben im degradierten Modus.
    expect(journalVerfuegbarFuerTenant('oliv')).toBe(true);
    expect(journalVerfuegbarFuerTenant('beaulieu')).toBe(true);
    expect(journalVerfuegbarFuerTenant('irgendwas')).toBe(false);
  });
});

describe('findeDublette', () => {
  const bestand = [
    inv({ id: 'a', supplierName: 'Prodega', amountNet: 990, amountGross: 1000, date: '2026-07-10', reference: 'RE-1' }),
  ];
  it('gleicher Lieferant+Datum+Betrag → Dublette', () => {
    expect(findeDublette(bestand, { supplierName: 'Prodega', date: '2026-07-10', amountGross: 1000 })?.id).toBe('a');
  });
  it('gleiche Referenz reicht (anderes Datum)', () => {
    expect(findeDublette(bestand, { supplierName: 'Prodega', date: '2026-07-12', amountGross: 500, reference: 're-1' })?.id).toBe('a');
  });
  it('anderer Lieferant/Betrag → keine Dublette; ignoreId beim Editieren', () => {
    expect(findeDublette(bestand, { supplierName: 'Transgourmet', date: '2026-07-10', amountGross: 1000 })).toBeNull();
    expect(findeDublette(bestand, { supplierName: 'Prodega', date: '2026-07-10', amountGross: 1000 }, 'a')).toBeNull();
  });
});

describe('NaN-Absicherung (degradierter Modus)', () => {
  it('NaN-Buchhaltungstotal ⇒ gebuchtTotal/diffTotal null (nie «CHF NaN»)', () => {
    const r = buildWarenAbgleich({ ...BASE, journal: null, invoices: [], buchhaltungTotal: NaN });
    expect(r.mode).toBe('nur-total');
    expect(r.gebuchtTotal).toBeNull();
    expect(r.diffTotal).toBeNull();
    expect(Number.isFinite(r.erfasstTotal)).toBe(true);
  });
});
