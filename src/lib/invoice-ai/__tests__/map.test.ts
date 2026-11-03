import { describe, it, expect } from 'vitest';
import { parseKiAntwort } from '../schema';
import { mappeKiRechnung } from '../map';
import type { LieferantenProfil } from '@/lib/lieferanten-profile';

const profile = [
  { id: 'p-219630115', name: 'Test Lieferant AG', mwstNr: '219630115', kategorie: 'Fleisch', konto: '4020' },
  { id: 'spahni', name: 'Metzgerei Spahni', mwstNr: '106963475', kategorie: 'Fleisch', konto: '4060', belegtyp: 'dual' },
  { id: 'fideco', name: 'Fideco', mwstNr: '112839932', kategorie: 'Food', konto: '4060', belegtyp: 'dual' },
] as unknown as LieferantenProfil[];

const gut = {
  dokumentart: 'rechnung',
  lieferant: { name: 'Test Lieferant AG', mwstNr: 'CHE-219.630.115 MWST', iban: null },
  rechnungsNr: '4711',
  rechnungsdatum: '2026-10-05',
  netto: 100,
  mwst: 5.35,
  brutto: null,
  mwstKlassen: [
    { satz: 2.6, basis: 50, betrag: 1.3 },
    { satz: 8.1, basis: 50, betrag: 4.05 },
  ],
  positionen: [
    { bezeichnung: 'Poulet', menge: 5, einheit: 'kg', preis: 10, positionspreis: 50, mwstSatz: 2.6 },
    { bezeichnung: 'Wein', menge: 10, einheit: 'Fl', preis: 5, positionspreis: 50, mwstSatz: 8.1 },
  ],
};

function lies(raw: unknown) {
  const r = parseKiAntwort(raw);
  if (r.ok === false) throw new Error(r.grund);
  return mappeKiRechnung(r.daten, profile);
}

describe('parseKiAntwort', () => {
  it('rejects non-JSON text and non-objects', () => {
    expect(parseKiAntwort('not json').ok).toBe(false);
    expect(parseKiAntwort(42).ok).toBe(false);
  });
  it('accepts Swiss/German number strings and DD.MM.YYYY dates', () => {
    const r = parseKiAntwort({ netto: "1'234.50", rechnungsdatum: '05.10.2026', positionen: [{ bezeichnung: 'x', positionspreis: '3.416,45' }] });
    expect(r.ok && r.daten.netto).toBe(1234.5);
    expect(r.ok && r.daten.rechnungsdatum).toBe('2026-10-05');
    expect(r.ok && r.daten.positionen[0].positionspreis).toBe(3416.45);
  });
  it('turns garbage numbers into null, never NaN', () => {
    const r = parseKiAntwort({ netto: 'abc', positionen: [{ bezeichnung: 'x', preis: {} }] });
    expect(r.ok && r.daten.netto).toBeNull();
    expect(r.ok && r.daten.positionen[0].preis).toBeNull();
  });
  it('treats an unknown document type as "sonstiges"', () => {
    const r = parseKiAntwort({ dokumentart: 'quittung' });
    expect(r.ok && r.daten.dokumentart).toBe('sonstiges');
  });
});

describe('mappeKiRechnung', () => {
  it('maps a consistent invoice with no findings and assigns the supplier by VAT no', () => {
    const { ergebnis, pruefungen } = lies(gut);
    expect(ergebnis.profil?.id).toBe('p-219630115');
    expect(ergebnis.perKi).toBe(true);
    expect(ergebnis.positionenErkannt).toBe(true);
    expect(ergebnis.lieferungen[0].positionen).toHaveLength(2);
    expect(ergebnis.lieferungen[0].nettoTotal).toBe(100);
    expect(pruefungen).toEqual([]);
    expect(ergebnis.mwstSatz).toBeNull(); // mixed classes: never an average
  });

  it('leaves the supplier open when nothing matches', () => {
    const { ergebnis } = lies({ ...gut, lieferant: { name: 'Unbekannt GmbH', mwstNr: 'CHE-111.111.111', iban: null } });
    expect(ergebnis.profil).toBeNull();
    expect(ergebnis.mwstNrn).toEqual(['111111111']);
  });

  it('flags a misread line: sum of lines differs from printed net', () => {
    const bad = { ...gut, positionen: [{ ...gut.positionen[0], positionspreis: 5, preis: 1 }, gut.positionen[1]] };
    const { pruefungen } = lies(bad);
    expect(pruefungen.some(p => p.code === 'lines-vs-net' && p.level === 'error')).toBe(true);
    expect(pruefungen.some(p => p.code === 'lines-vs-classes')).toBe(true);
  });

  it('flags qty x unit price that does not match the line total', () => {
    const bad = { ...gut, positionen: [{ ...gut.positionen[0], menge: 6 }, gut.positionen[1]] };
    const { pruefungen, positionsFlags } = lies(bad);
    expect(pruefungen.some(p => p.code === 'line-arithmetic' && p.position === 0)).toBe(true);
    expect(positionsFlags[0].warn).toBe(true);
    expect(positionsFlags[1].warn).toBe(false);
  });

  it('flags gross != net + VAT', () => {
    const { pruefungen } = lies({ ...gut, brutto: 999 });
    expect(pruefungen.some(p => p.code === 'gross-vs-net-vat')).toBe(true);
  });

  it('does not accept an old/odd VAT rate silently', () => {
    const odd = { ...gut, mwstKlassen: [], positionen: [{ ...gut.positionen[0], mwstSatz: 7.7 }, gut.positionen[1]] };
    const { pruefungen, ergebnis } = lies(odd);
    expect(pruefungen.some(p => p.code === 'vat-rate-unknown')).toBe(true);
    expect(ergebnis.lieferungen[0].positionen[0].mwstSatz).toBeUndefined();
    expect(ergebnis.lieferungen[0].positionen[0].mwstBetrag).toBe(0);
  });

  it('computes a missing line total from qty x price and says so', () => {
    const p = { ...gut, positionen: [{ ...gut.positionen[0], positionspreis: null }, gut.positionen[1]] };
    const { pruefungen, ergebnis } = lies(p);
    expect(pruefungen.some(x => x.code === 'line-total-computed')).toBe(true);
    expect(ergebnis.lieferungen[0].positionen[0].positionspreis).toBe(50);
  });

  it('skips a line with neither amount nor quantity x price, with a warning', () => {
    const p = { ...gut, positionen: [{ bezeichnung: 'Kaputt' }, ...gut.positionen] };
    const { pruefungen, ergebnis } = lies(p);
    expect(pruefungen.some(x => x.code === 'line-skipped' && x.position === 0)).toBe(true);
    expect(ergebnis.lieferungen[0].positionen).toHaveLength(2);
  });

  it('locks non-invoices (offer, order confirmation, unknown)', () => {
    for (const art of ['offerte', 'auftragsbestaetigung', 'bestellung', 'sonstiges']) {
      const { ergebnis, pruefungen } = lies({ ...gut, dokumentart: art });
      expect(ergebnis.belegart).not.toBe('rechnung');
      expect(pruefungen.some(p => p.code === 'not-invoice')).toBe(true);
    }
  });

  it('survives an empty / partial model answer without throwing', () => {
    const { ergebnis, pruefungen } = lies({});
    expect(ergebnis.positionenErkannt).toBe(false);
    expect(ergebnis.netto).toBeNull();
    expect(pruefungen.some(p => p.code === 'no-lines')).toBe(true);
  });

  it('reports lines without invoice number/date instead of inventing a key', () => {
    const { ergebnis, pruefungen } = lies({ ...gut, rechnungsNr: null, rechnungsdatum: null });
    expect(ergebnis.lieferungen).toHaveLength(0);
    expect(pruefungen.some(p => p.code === 'missing-header' && p.level === 'error')).toBe(true);
  });

  it('groups lines per delivery note when the invoice lists several', () => {
    const p = {
      ...gut,
      positionen: [
        { ...gut.positionen[0], lieferscheinNr: 'LS1', lieferdatum: '2026-10-01' },
        { ...gut.positionen[1], lieferscheinNr: 'LS2', lieferdatum: '2026-10-03' },
      ],
    };
    const { ergebnis } = lies(p);
    expect(ergebnis.lieferungen.map(l => l.rechnungsNr).sort()).toEqual(['LS1', 'LS2']);
  });

  it('treats an AI-read invoice of Spahni as the final monthly invoice, a delivery note as provisional', () => {
    const spahni = { ...gut, lieferant: { name: 'Metzgerei Spahni', mwstNr: 'CHE-106.963.475 MWST', iban: null } };
    expect(lies(spahni).ergebnis.dokumenttyp).toBe('monatsrechnung');
    expect(lies({ ...spahni, dokumentart: 'lieferschein' }).ergebnis.dokumenttyp).toBe('lieferschein');
  });

  it('leaves other dual suppliers undecided so the preview default / user choice applies', () => {
    const fideco = { ...gut, lieferant: { name: 'Fideco', mwstNr: 'CHE-112.839.932 MWST', iban: null } };
    expect(lies(fideco).ergebnis.dokumenttyp).toBeNull();
  });
});
