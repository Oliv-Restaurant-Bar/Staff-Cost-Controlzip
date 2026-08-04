// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  parseFibuDatum, vatRateForKonto, buildUebernahmeKandidaten,
  kandidatToDraft, findeDublette, draftToInvoiceEntry,
} from '@/lib/waren-fibu-uebernahme';
import type { WarenAbgleich } from '@/lib/waren-abgleich';
import { LEERER_MATCH_STATE, buchungKey, type FibuMatchState } from '@/lib/waren-fibu-matches';
import type { SageJournalEntry } from '@/types/reporting';
import type { InvoiceEntry } from '@/lib/waren-db';

const buchung = (over: Partial<SageJournalEntry> = {}): SageJournalEntry => ({
  date: '05.07.2026', belegNr: 'B-123', text: 'Frigemo AG Rechnung',
  accountNumber: '4000', accountName: 'Einkauf Food', soll: 250.5, haben: 0, amount: 250.5,
  ...over,
});

const abgleichMit = (zeilenBuchungen: SageJournalEntry[], nichtZugeordnet: SageJournalEntry[] = []): WarenAbgleich => ({
  mode: 'lieferanten',
  zeilen: [
    { lieferant: 'Frigemo', erfasst: null, gebucht: 250.5, diff: null, status: 'nur-gebucht', anzahlRechnungen: 0, anzahlBuchungen: zeilenBuchungen.length, buchungen: zeilenBuchungen },
    { lieferant: 'Prodega', erfasst: 100, gebucht: 100, diff: 0, status: 'ok', anzahlRechnungen: 1, anzahlBuchungen: 1, buchungen: [buchung({ text: 'Prodega', soll: 100, amount: 100 })] },
  ],
  erfasstTotal: 100, gebuchtTotal: 350.5, diffTotal: 250.5,
  nichtZugeordnet, nichtZugeordnetSumme: nichtZugeordnet.reduce((s, b) => s + (b.soll - b.haben), 0),
});

describe('parseFibuDatum', () => {
  it('konvertiert DD.MM.YYYY nach ISO', () => {
    expect(parseFibuDatum('05.07.2026')).toBe('2026-07-05');
    expect(parseFibuDatum('5.7.2026')).toBe('2026-07-05');
  });
  it('gibt null bei Mist zurück', () => {
    expect(parseFibuDatum('2026-07-05')).toBeNull();
    expect(parseFibuDatum('32.13.2026')).toBeNull();
    expect(parseFibuDatum('')).toBeNull();
  });
});

describe('vatRateForKonto', () => {
  it('Getränkekonten 8.1, Food 2.6', () => {
    expect(vatRateForKonto('4020')).toBe(8.1);
    expect(vatRateForKonto('4000')).toBe(2.6);
    expect(vatRateForKonto('4010')).toBe(2.6);
  });
});

describe('buildUebernahmeKandidaten', () => {
  it('sammelt nur-gebucht + nichtZugeordnet, nicht ok-Zeilen', () => {
    const nz = buchung({ text: 'Unbekannter Text', date: '02.07.2026', soll: 42, amount: 42 });
    const ks = buildUebernahmeKandidaten(abgleichMit([buchung()], [nz]), LEERER_MATCH_STATE);
    expect(ks).toHaveLength(2);
    // chronologisch: 02.07 vor 05.07
    expect(ks[0].lieferant).toBeNull();
    expect(ks[0].betrag).toBe(42);
    expect(ks[1].lieferant).toBe('Frigemo');
    expect(ks[1].betrag).toBe(250.5);
    expect(ks[1].datumIso).toBe('2026-07-05');
  });
  it('vergibt indizierte Schlüssel (#0) wie das Match-Drilldown', () => {
    const ks = buildUebernahmeKandidaten(abgleichMit([buchung()]), LEERER_MATCH_STATE);
    expect(ks[0].key).toBe(`${buchungKey(buchung())}#0`);
  });
  it('zwei identische Buchungen: Match auf #1 entfernt NUR diese', () => {
    const b = buchung();
    const st: FibuMatchState = {
      gruppen: [{ id: 'g1', invoiceIds: ['i1'], buchungKeys: [`${buchungKey(b)}#1`], herkunft: 'manuell' }],
      gesperrt: { invoiceIds: [], buchungKeys: [] },
    };
    const ks = buildUebernahmeKandidaten(abgleichMit([b, { ...b }]), st);
    expect(ks).toHaveLength(1);
    expect(ks[0].key).toBe(`${buchungKey(b)}#0`);
  });
  it('unindizierter Alt-Schlüssel in der Gruppe zählt als #0', () => {
    const b = buchung();
    const st: FibuMatchState = {
      gruppen: [{ id: 'g1', invoiceIds: ['i1'], buchungKeys: [buchungKey(b)], herkunft: 'manuell' }],
      gesperrt: { invoiceIds: [], buchungKeys: [] },
    };
    expect(buildUebernahmeKandidaten(abgleichMit([b]), st)).toHaveLength(0);
    // …aber ein zweites identisches Exemplar (#1) bleibt Kandidat
    const ks = buildUebernahmeKandidaten(abgleichMit([b, { ...b }]), st);
    expect(ks).toHaveLength(1);
    expect(ks[0].key).toBe(`${buchungKey(b)}#1`);
  });
  it('leer bei nur-total-Modus oder null', () => {
    expect(buildUebernahmeKandidaten(null, LEERER_MATCH_STATE)).toEqual([]);
    expect(buildUebernahmeKandidaten({ ...abgleichMit([]), mode: 'nur-total' }, LEERER_MATCH_STATE)).toEqual([]);
  });
  it('Betrag = Soll − Haben (Gutschrift negativ)', () => {
    const gut = buchung({ soll: 0, haben: 30, amount: 30, text: 'Gutschrift XY' });
    const ks = buildUebernahmeKandidaten(abgleichMit([gut]), LEERER_MATCH_STATE);
    expect(ks[0].betrag).toBe(-30);
  });
});

describe('kandidatToDraft / draftToInvoiceEntry', () => {
  it('leitet Draft korrekt ab (Food-Konto)', () => {
    const [k] = buildUebernahmeKandidaten(abgleichMit([buchung()]), LEERER_MATCH_STATE);
    const d = kandidatToDraft(k);
    expect(d.date).toBe('2026-07-05');
    expect(d.supplierName).toBe('Frigemo');
    expect(d.vatRate).toBe(2.6);
    expect(d.kategorie).toBe('Food');
    expect(d.warenkonto).toBe('4000');
    expect(d.reference).toBe('B-123');
    expect(d.note).toContain('aus FIBU-Abgleich übernommen');
    expect(d.note).toContain('Einkauf Food');
  });
  it('nichtZugeordnet: Buchungstext als Lieferant, Getränkekonto → 8.1/Beverage', () => {
    const nz = buchung({ text: 'Getränke Müller', accountNumber: '4020', accountName: 'Einkauf Wein' });
    const ks = buildUebernahmeKandidaten(abgleichMit([], [nz]), LEERER_MATCH_STATE);
    const d = kandidatToDraft(ks[0]);
    expect(d.supplierName).toBe('Getränke Müller');
    expect(d.vatRate).toBe(8.1);
    expect(d.kategorie).toBe('Beverage');
  });
  it('draftToInvoiceEntry: Betrag exakt, netto, quelle fibu_uebernahme, final=false', () => {
    const [k] = buildUebernahmeKandidaten(abgleichMit([buchung()]), LEERER_MATCH_STATE);
    const inv = draftToInvoiceEntry(kandidatToDraft(k), 'inv-x', '2026-08-04T00:00:00.000Z');
    expect(inv.amountNet).toBe(250.5);
    expect(inv.vatIncluded).toBe(false);
    expect(inv.quelle).toBe('fibu_uebernahme');
    expect(inv.final).toBe(false);
    expect(inv.warenkonto).toBe('4000');
    expect(inv.reference).toBe('B-123');
  });
});

describe('findeDublette', () => {
  const inv = (over: Partial<InvoiceEntry> = {}): InvoiceEntry => ({
    id: 'i1', date: '2026-07-05', supplierName: 'Frigemo', amountNet: 250.5,
    vatIncluded: false, vatRate: 2.6, createdAt: '', updatedAt: '', ...over,
  } as InvoiceEntry);
  it('erkennt gleiche Lieferant+Datum+Betrag (±Toleranz, Namens-Normalisierung)', () => {
    expect(findeDublette({ date: '2026-07-05', supplierName: '  frigemo ', betrag: 250.52 }, [inv()])).not.toBeNull();
  });
  it('kein Treffer bei anderem Datum, Betrag oder Lieferant', () => {
    expect(findeDublette({ date: '2026-07-06', supplierName: 'Frigemo', betrag: 250.5 }, [inv()])).toBeNull();
    expect(findeDublette({ date: '2026-07-05', supplierName: 'Frigemo', betrag: 249 }, [inv()])).toBeNull();
    expect(findeDublette({ date: '2026-07-05', supplierName: 'Prodega', betrag: 250.5 }, [inv()])).toBeNull();
  });
});
