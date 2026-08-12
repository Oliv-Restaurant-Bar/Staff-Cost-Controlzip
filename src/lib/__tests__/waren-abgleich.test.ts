// @vitest-environment node
/**
 * Warenrechnungen ↔ Buchhaltung Abgleich — pro Lieferant, mit sauberer
 * Degradation ohne Buchungszeilen (nur Total-Vergleich, «keine
 * Buchhaltungsdaten» pro Lieferant, NIE ein Fehler) + Dublettencheck.
 */
import { describe, it, expect } from 'vitest';
import { buildWarenAbgleich, buildKontoAbgleich, findeDublette, istInterneUmbuchung, journalVerfuegbarFuerTenant } from '../waren-abgleich';
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

// ── Degradierter Modus: gleicher Scope wie erfasst (ohne 4701/Depot) ─────────
import { buildWarenAbgleich as bwa2 } from '@/lib/waren-abgleich';
import type { InvoiceEntry as IE3 } from '@/lib/waren-db';

describe('buildWarenAbgleich: 4701/Depot aus der Erfasst-Seite ausgeklammert', () => {
  const invMitSplits = { id: 'a', date: '2026-07-05', supplierName: 'Transgourmet', amountNet: 10000, amountGross: 10810,
    kontoSplits: [
      { warenkonto: '4000', amountNet: 6000, amountGross: 6486 },
      { warenkonto: '4701', amountNet: 3856.64, amountGross: 4169.03 },
      { warenkonto: 'Depot', amountNet: 143.36, amountGross: 143.36 },
    ] } as unknown as IE3;
  it('erfasstTotal = nur direkter Warenaufwand (auch im degradierten Modus)', () => {
    const a = bwa2({
      invoices: [invMitSplits], journal: null, warenkontoNummern: ['4000', '4020', '4050'],
      supplierNames: ['Transgourmet'], aliases: {}, buchhaltungTotal: 6000,
    });
    expect(a.mode).toBe('nur-total');
    expect(a.erfasstTotal).toBe(6000);
    expect(a.diffTotal).toBe(0); // 4701 erzeugt KEINE Scheindifferenz mehr
  });
});

// ── Interne Umbuchungen («Umb.» / «Umbuchung») — 08/2026 ─────────────────────
describe('interne Umbuchungen werden aus dem Rechnungs-Vergleich genommen', () => {
  it('«Umb. …»-Zeilen matchen NIE einen Lieferanten und fehlen im gebuchtTotal', () => {
    const invoices = [
      inv({ supplierName: 'Feldschlösschen', amountNet: 1000 }),
    ];
    const journal = [
      buch('Feldschlösschen Rechnung Juli', 1000),
      buch('Umb. gemäss Webapp', -1830, '4020'),               // TG Non-Food 4060→4701
      buch('Umb. Kontierung Feldschlösschen', -1110),          // FS-Re-Kontierung
      buch('Umbuchung Korrektur Prodega', -50, '4020'),
    ];
    const r = buildWarenAbgleich({ ...BASE, supplierNames: ['Feldschlösschen', 'Prodega'], invoices, journal });
    // FS-Zeile: NUR die echte Rechnung, keine Re-Kontierung → Differenz 0.
    const fs = r.zeilen.find(z => z.lieferant === 'Feldschlösschen')!;
    expect(fs.gebucht).toBe(1000);
    expect(fs.diff).toBe(0);
    expect(r.zeilen.find(z => z.lieferant === 'Prodega')).toBeUndefined();
    // Total-Differenz frei von Umbuchungen; separat ausgewiesen.
    expect(r.gebuchtTotal).toBe(1000);
    expect(r.diffTotal).toBe(0);
    expect(r.interneUmbuchungen).toHaveLength(3);
    expect(r.interneUmbuchungenSumme).toBeCloseTo(-2990, 2);
    expect(r.nichtZugeordnet).toHaveLength(0);
  });

  it('nur ECHTE «Umb.»-Präfixe zählen — «Umbau»/Mitte-Text nicht; leer statt 0', () => {
    expect(istInterneUmbuchung('Umb. gemäss Webapp')).toBe(true);
    expect(istInterneUmbuchung('  umbuchung Kontierung')).toBe(true);
    expect(istInterneUmbuchung('Umbau Küche Material')).toBe(false);
    expect(istInterneUmbuchung('Rechnung Umbuchung folgt')).toBe(false);
    expect(istInterneUmbuchung(null)).toBe(false);
    const r = buildWarenAbgleich({ ...BASE, invoices: [], journal: [buch('Prodega Juli', 200)] });
    expect(r.interneUmbuchungen).toHaveLength(0);
    expect(r.interneUmbuchungenSumme).toBe(0);
  });

  it('degradierter Modus (nur Umb.-Zeilen im Journal) bleibt nur-total, Umbuchungen separat', () => {
    const r = buildWarenAbgleich({
      ...BASE, buchhaltungTotal: 500,
      invoices: [inv({ supplierName: 'Prodega', amountNet: 500 })],
      journal: [buch('Umb. gemäss Webapp', -1830, '4020')],
    });
    expect(r.mode).toBe('nur-total');
    expect(r.interneUmbuchungen).toHaveLength(1);
    expect(r.interneUmbuchungenSumme).toBe(-1830);
    // ER-/Kontoblatt-Total enthält die Umbuchung — für den Vergleich
    // herausgerechnet: 500 − (−1830) = 2330, Differenz gegen erfasst 500.
    expect(r.gebuchtTotal).toBe(2330);
    expect(r.diffTotal).toBe(1830);
  });

  it('degradiert OHNE Journal (null): buchhaltungTotal bleibt unkorrigiert', () => {
    const r = buildWarenAbgleich({
      ...BASE, buchhaltungTotal: 500, journal: null,
      invoices: [inv({ supplierName: 'Prodega', amountNet: 500 })],
    });
    expect(r.mode).toBe('nur-total');
    expect(r.gebuchtTotal).toBe(500);
    expect(r.diffTotal).toBe(0);
    expect(r.interneUmbuchungenSumme).toBe(0);
  });
});

describe('buildKontoAbgleich — interne Umbuchungen ausgeklammert', () => {
  it('Umb.-Zeile fliesst weder ins Konto noch in die Pro-Lieferant-Sammelzeile', () => {
    const zeilen = buildKontoAbgleich({
      invoices: [inv({ supplierName: 'Feldschlösschen', amountNet: 1000, warenkonto: '4030' })],
      journal: [
        { date: '10.07.2026', text: 'Feldschlösschen Juli', accountNumber: '4030', accountName: 'Bier', soll: 1000, haben: 0, amount: 1000 },
        { date: '11.07.2026', text: 'Umb. Kontierung Feldschlösschen', accountNumber: '4030', accountName: 'Bier', soll: 0, haben: 1110, amount: -1110 },
      ],
      relevanteKonten: ['4030'],
      lieferantZeilen: [{ name: 'Feldschlösschen', rx: /feldschl/i }],
    });
    const fs = zeilen.find(z => z.konto === '~Feldschlösschen')!;
    expect(fs.gebucht).toBe(1000);
    expect(fs.diff).toBe(0);
    expect(zeilen.find(z => z.konto === '4030')).toBeUndefined();
  });
});
