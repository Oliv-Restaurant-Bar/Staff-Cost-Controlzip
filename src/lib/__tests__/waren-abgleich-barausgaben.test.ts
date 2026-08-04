// @vitest-environment node
/**
 * Barausgaben (Bar-/Kasseneinkäufe auf Warenkonten) als eigene Lieferanten:
 * Buchungstexte «Barausgabe(n) <Laden>» werden pro Laden als Lieferant
 * «Barausgaben <Laden>» geführt (statt «ohne Zuordnung»), erfasste
 * Schreibweisen («Migros», «Barausgabe Migros») matchen via Standard-Aliasse,
 * Nutzer-Alias-Gruppen überstimmen die Standard-Aliasse.
 */
import { describe, it, expect } from 'vitest';
import { buildWarenAbgleich, barausgabenLieferant, barausgabenAliasGruppen } from '../waren-abgleich';
import { kandidatToDraft, buildUebernahmeKandidaten } from '../waren-fibu-uebernahme';
import { buchungKeysMitIndex } from '../waren-fibu-matches';
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

const buch = (text: string, soll: number, konto = '4060', date = '10.07.2026'): SageJournalEntry => ({
  date, text, accountNumber: konto, accountName: 'Küche',
  soll, haben: 0, amount: soll,
});

const BASE = {
  warenkontoNummern: ['4000', '4060'],
  supplierNames: ['Prodega'],
  aliases: {},
  buchhaltungTotal: null as number | null,
};

describe('barausgabenLieferant', () => {
  it('erkennt Präfix case-insensitiv, Singular/Plural, mit Trennzeichen', () => {
    expect(barausgabenLieferant('Barausgaben Migros')).toBe('Barausgaben Migros');
    expect(barausgabenLieferant('Barausgabe Migros')).toBe('Barausgaben Migros');
    expect(barausgabenLieferant('BARAUSGABEN  Coop  City')).toBe('Barausgaben Coop City');
    expect(barausgabenLieferant('barausgaben: Denner')).toBe('Barausgaben Denner');
    expect(barausgabenLieferant('Barausgaben')).toBe('Barausgaben');
    expect(barausgabenLieferant('ER Prodega Barausgaben')).toBeNull();
    expect(barausgabenLieferant('Barausgabenkonto Ausgleich')).toBeNull(); // kein Wortende
    expect(barausgabenLieferant('')).toBeNull();
    expect(barausgabenLieferant(null)).toBeNull();
  });
});

describe('buildWarenAbgleich — Barausgaben', () => {
  it('führt Barausgaben pro Laden als eigene nur-gebucht-Zeile (statt ohne Zuordnung)', () => {
    const r = buildWarenAbgleich({
      ...BASE,
      invoices: [],
      journal: [
        buch('Barausgaben Aldi', 292.40, '4060', '04.07.2026'),
        buch('Barausgaben Denner', 20.00, '4060', '16.07.2026'),
        buch('Barausgaben Migros', 45.50),
        buch('Barausgabe Migros', 30.00, '4060', '20.07.2026'), // Singular → gleiche Gruppe
      ],
    });
    expect(r.nichtZugeordnet).toHaveLength(0);
    const aldi = r.zeilen.find(z => z.lieferant === 'Barausgaben Aldi')!;
    expect(aldi.status).toBe('nur-gebucht');
    expect(aldi.gebucht).toBeCloseTo(292.40, 2);
    expect(r.zeilen.find(z => z.lieferant === 'Barausgaben Denner')!.gebucht).toBeCloseTo(20, 2);
    const migros = r.zeilen.find(z => z.lieferant === 'Barausgaben Migros')!;
    expect(migros.anzahlBuchungen).toBe(2);
    expect(migros.gebucht).toBeCloseTo(75.50, 2);
  });

  it('matcht bereits erfasste Schreibweisen («Migros», «Barausgabe Migros») via Standard-Alias', () => {
    const r = buildWarenAbgleich({
      ...BASE,
      invoices: [
        inv({ supplierName: 'Migros', amountNet: 45.50 }),
        inv({ supplierName: 'Barausgabe Coop', amountNet: 12.00 }),
      ],
      journal: [
        buch('Barausgaben Migros', 45.50),
        buch('Barausgaben Coop', 12.00),
      ],
    });
    const migros = r.zeilen.find(z => z.lieferant === 'Barausgaben Migros')!;
    expect(migros.status).toBe('ok');
    expect(migros.erfasst).toBeCloseTo(45.50, 2);
    const coop = r.zeilen.find(z => z.lieferant === 'Barausgaben Coop')!;
    expect(coop.status).toBe('ok');
    // keine falschen «fehlt»-Zeilen
    expect(r.zeilen.some(z => z.status === 'nur-erfasst')).toBe(false);
    expect(r.zeilen.some(z => z.status === 'nur-gebucht')).toBe(false);
  });

  it('Normalfall: identische Schreibweise «Barausgaben <Laden>» matcht DIREKT (kein Alias nötig), case-insensitiv und leerzeichen-tolerant', () => {
    const r = buildWarenAbgleich({
      ...BASE,
      invoices: [
        inv({ supplierName: 'Barausgaben Migros', amountNet: 45.50 }),   // exakt wie Buchhaltung
        inv({ supplierName: 'barausgaben coop', amountNet: 12.00 }),     // lowercase
        inv({ supplierName: 'Barausgaben  Denner', amountNet: 20.00 }),  // Doppel-Leerzeichen
      ],
      journal: [
        buch('Barausgaben Migros', 45.50),
        buch('Barausgaben  Coop', 12.00),   // Doppel-Leerzeichen im Buchungstext
        buch('barausgaben Denner', 20.00),  // lowercase im Buchungstext
      ],
    });
    for (const laden of ['Migros', 'Coop', 'Denner']) {
      const z = r.zeilen.find(x => x.lieferant === `Barausgaben ${laden}`)!;
      expect(z.status, `Barausgaben ${laden}`).toBe('ok');
    }
    expect(r.zeilen.some(z => z.status === 'nur-erfasst' || z.status === 'nur-gebucht')).toBe(false);
  });

  it('Nutzer-Alias-Gruppe überstimmt Standard-Alias', () => {
    const r = buildWarenAbgleich({
      ...BASE,
      invoices: [inv({ supplierName: 'Migros', amountNet: 100 })],
      journal: [buch('Barausgaben Migros', 45.50), buch('ER Migros Genossenschaft', 100)],
      supplierNames: ['Migros'],
      aliasGruppen: [{ id: 'g1', name: 'Migros Gross', aliases: ['Migros'] }],
    });
    // Nutzer sagt: «Migros» gehört zu «Migros Gross» — nicht zu Barausgaben.
    const gross = r.zeilen.find(z => z.lieferant === 'Migros Gross')!;
    expect(gross.erfasst).toBe(100);
    const bar = r.zeilen.find(z => z.lieferant === 'Barausgaben Migros')!;
    expect(bar.status).toBe('nur-gebucht');
  });

  it('Gutschrift (Haben) wird korrekt negativ geführt', () => {
    const r = buildWarenAbgleich({
      ...BASE,
      invoices: [],
      journal: [
        buch('Barausgaben Aldi', 292.40),
        // Gutschrift auf denselben Laden-Text → mindert die Aldi-Zeile
        { date: '12.07.2026', text: 'Barausgabe Aldi', accountNumber: '4060', accountName: 'Küche', soll: 0, haben: 50, amount: -50 },
      ],
    });
    const aldi = r.zeilen.find(z => z.lieferant === 'Barausgaben Aldi')!;
    expect(aldi.gebucht).toBeCloseTo(242.40, 2);
    expect(aldi.anzahlBuchungen).toBe(2);
  });

  it('Übernahme-Kandidat: Konto/Kategorie/MwSt aus 4060 (Food 2.6), Bemerkung «Barausgabe aus FIBU übernommen»', () => {
    const r = buildWarenAbgleich({
      ...BASE,
      invoices: [],
      journal: [buch('Barausgaben Aldi', 292.40, '4060', '04.07.2026')],
    });
    const kand = buildUebernahmeKandidaten(r, { gruppen: [], gesperrt: [] } as never);
    expect(kand).toHaveLength(1);
    expect(kand[0].lieferant).toBe('Barausgaben Aldi');
    const d = kandidatToDraft(kand[0]);
    expect(d.supplierName).toBe('Barausgaben Aldi');
    expect(d.warenkonto).toBe('4060');
    expect(d.kategorie).toBe('Food');
    expect(d.vatRate).toBe(2.6);
    expect(d.date).toBe('2026-07-04');
    expect(d.note).toBe('Barausgabe aus FIBU übernommen');
  });
});

describe('buildUebernahmeKandidaten — Buchungs-Ebene bei gemischten Barausgaben-Zeilen', () => {
  const matchLeer = { gruppen: [], gesperrt: [] } as never;

  it('Laden mit erfasster UND fehlender Buchung: nur die fehlende ist übernehmbar', () => {
    const erfasst = inv({ supplierName: 'Migros', amountNet: 45.50, date: '2026-07-10' });
    const r = buildWarenAbgleich({
      ...BASE,
      invoices: [erfasst],
      journal: [
        buch('Barausgaben Migros', 45.50, '4060', '10.07.2026'),  // erfasst (Datum+Betrag)
        buch('Barausgaben Migros', 33.20, '4060', '18.07.2026'),  // fehlt
      ],
    });
    const zeile = r.zeilen.find(z => z.lieferant === 'Barausgaben Migros')!;
    expect(zeile.status).toBe('ok'); // Δ 33.20 unter Schwelle 50 — Buchungs-Ebene greift trotzdem
    const kand = buildUebernahmeKandidaten(r, matchLeer, [erfasst]);
    expect(kand).toHaveLength(1);
    expect(kand[0].betrag).toBeCloseTo(33.20, 2);
    expect(kand[0].datumIso).toBe('2026-07-18');
    expect(kand[0].lieferant).toBe('Barausgaben Migros');
  });

  it('jede Rechnung deckt höchstens EINE identische Buchung; ohne invoices keine Buchungs-Ebene', () => {
    const erfasst = inv({ supplierName: 'Barausgabe Coop', amountNet: 20, date: '2026-07-16' });
    const r = buildWarenAbgleich({
      ...BASE,
      invoices: [erfasst],
      journal: [
        buch('Barausgaben Coop', 20, '4060', '16.07.2026'),
        buch('Barausgaben Coop', 20, '4060', '16.07.2026'), // identische Doppel-Buchung
      ],
    });
    const kand = buildUebernahmeKandidaten(r, matchLeer, [erfasst]);
    expect(kand).toHaveLength(1); // genau eine bleibt offen
    expect(kand[0].key.endsWith('#1') || kand[0].key.endsWith('#0')).toBe(true);
    // Rückwärtskompatibel: ohne invoices bleiben ok/abweichung-Zeilen aussen vor
    expect(buildUebernahmeKandidaten(r, matchLeer)).toHaveLength(0);
  });

  it('bereits gematchte Rechnung deckt keine ZWEITE Buchung: #1 bleibt Kandidat', () => {
    const erfasst = inv({ id: 'inv-1', supplierName: 'Barausgabe Coop', amountNet: 20, date: '2026-07-16' });
    const r = buildWarenAbgleich({
      ...BASE,
      invoices: [erfasst],
      journal: [
        buch('Barausgaben Coop', 20, '4060', '16.07.2026'),
        buch('Barausgaben Coop', 20, '4060', '16.07.2026'), // identische Doppel-Buchung
      ],
    });
    const zeile = r.zeilen.find(z => z.lieferant === 'Barausgaben Coop')!;
    const keys = buchungKeysMitIndex(zeile.buchungen);
    // Rechnung ist manuell auf Buchung #0 gematcht → sie ist «verbraucht»
    const state = {
      gruppen: [{ id: 'm1', invoiceIds: ['inv-1'], buchungKeys: [keys[0]] }],
      gesperrt: { invoiceIds: [], buchungKeys: [] },
    } as never;
    const kand = buildUebernahmeKandidaten(r, state, [erfasst]);
    expect(kand).toHaveLength(1);
    expect(kand[0].key).toBe(keys[1]);
  });

  it('normale Lieferanten-Zeilen (ok) bleiben von der Buchungs-Ebene unberührt', () => {
    const erfasst = inv({ supplierName: 'Prodega', amountNet: 1000, date: '2026-07-05' });
    const r = buildWarenAbgleich({
      ...BASE,
      invoices: [erfasst],
      journal: [buch('ER Prodega', 990, '4000', '05.07.2026'), buch('ER Prodega', 15, '4000', '20.07.2026')],
    });
    expect(r.zeilen.find(z => z.lieferant === 'Prodega')!.status).toBe('ok');
    expect(buildUebernahmeKandidaten(r, matchLeer, [erfasst])).toHaveLength(0);
  });
});

describe('barausgabenAliasGruppen', () => {
  it('erzeugt pro Laden eine Gruppe mit «<Laden>» und «Barausgabe <Laden>»', () => {
    const g = barausgabenAliasGruppen([
      buch('Barausgaben Migros', 10),
      buch('Barausgabe Migros', 5),
      buch('Barausgaben', 3),          // ohne Laden → keine Gruppe
      buch('ER Prodega', 100),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].name).toBe('Barausgaben Migros');
    expect(g[0].aliases).toEqual(['Migros', 'Barausgabe Migros']);
  });
});
