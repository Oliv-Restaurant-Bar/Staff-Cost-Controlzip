// @vitest-environment node
/**
 * Monatsrechnungs-Abgleich (Dual-Lieferanten): Die Monatsrechnung ist
 * MASSGEBLICH — sie überschreibt provisorische Lieferscheine/ABs mit den
 * finalen Werten (Lieferdatum je Lieferung aus der Rechnung) und bucht
 * Fehlendes frisch. Vorschau: überschrieben/neu/unverändert + manuell-Warnung.
 * Kontroll-Szenario: Fideco-Monatsrechnung mit 15 Lieferungen (01.07.–30.07.),
 * Netto 5'900.30.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-Memory-Bestand statt Supabase.
const bestand = new Map<string, import('@/lib/waren-db').InvoiceEntry[]>();
vi.mock('@/lib/supabase-kv', () => ({
  kvGet: vi.fn(async () => null),
  kvGetStrict: vi.fn(async () => null),
  kvSet: vi.fn(async () => {}),
  kvRemove: vi.fn(async () => {}),
}));
vi.mock('@/lib/waren-db', async (orig) => {
  const mod = await orig() as Record<string, unknown>;
  return {
    ...mod,
    loadMonthInvoices: vi.fn(async (_t: string, m: string) => bestand.get(m) ?? []),
  };
});

import { abgleicheMonatsrechnung } from '@/lib/monatsrechnung-abgleich';
import type { ParsedCsvRechnung } from '@/lib/waren-positionen';
import type { InvoiceEntry } from '@/lib/waren-db';

const R2 = (n: number) => Math.round(n * 100) / 100;

/** 15 Lieferungen 01.07.–30.07.2026, Netto-Summe exakt 5900.30 (2.6% MwSt). */
function fidecoLieferungen(): ParsedCsvRechnung[] {
  const nettos = [400.10, 380.00, 350.55, 420.30, 410.00, 395.45, 388.20, 402.75,
    377.60, 415.90, 390.35, 385.00, 405.25, 398.85, 380.00];
  expect(R2(nettos.reduce((s, n) => s + n, 0))).toBe(5900.30);
  return nettos.map((netto, i) => {
    const tag = String(1 + i * 2).padStart(2, '0');
    const mwst = R2(netto * 0.026);
    return {
      docKey: `LS-90${i}`, rechnungsNr: `90${i}`, datum: `2026-07-${tag}`, markt: 'Fideco',
      positionen: [{ artNr: `A${i}`, bezeichnung: `Pos ${i}`, warengruppe: 'Fleisch',
        menge: 1, einheit: 'KG', preis: netto, positionspreis: netto, mwstBetrag: mwst, mwstCode: 1 }],
      nettoTotal: netto, mwstTotal: mwst, bruttoTotal: R2(netto + mwst),
    };
  });
}

/** Import-Eintrag (id-Präfix 'lpdf-' = NICHT manuell). */
function eintrag(p: { id: string; ref?: string; date: string; net: number }): InvoiceEntry {
  return {
    id: p.id, date: p.date, supplierName: 'Fideco',
    amountNet: p.net, amountGross: R2(p.net * 1.026), vatIncluded: false, vatRate: 2.6,
    ...(p.ref ? { reference: p.ref } : {}),
    kategorie: 'Food', warenkonto: '4060',
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  } as InvoiceEntry;
}

beforeEach(() => bestand.clear());

describe('abgleicheMonatsrechnung (massgeblich — Fideco-Kontrollszenario)', () => {
  it('leerer Bestand: alle 15 neu, Summe Monatsrechnung 5900.30', async () => {
    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco', fidecoLieferungen());
    expect(a.neu).toBe(15);
    expect(a.ueberschrieben).toBe(0);
    expect(a.unveraendert).toBe(0);
    expect(a.summeMonatsrechnung).toBe(5900.30);
  });

  it('identische Lieferscheine = «unverändert», abweichende = «überschreiben» mit alt→neu — kein Doppel', async () => {
    const ls = fidecoLieferungen();
    bestand.set('2026-07', [
      // 3 identisch erfasst (Import-id) → unverändert
      ...ls.slice(0, 3).map((l, i) => eintrag({ id: `lpdf-e${i}`, ref: l.rechnungsNr, date: l.datum, net: l.nettoTotal })),
      // 1 mit abweichendem Betrag → überschreiben inkl. diffBetrag
      { ...eintrag({ id: 'lpdf-e3', ref: ls[3].rechnungsNr, date: ls[3].datum, net: ls[3].nettoTotal }), amountGross: 999 },
      // 1 mit abweichendem Datum (Ref-Match) → überschreiben inkl. diffDatum
      eintrag({ id: 'lpdf-e4', ref: ls[4].rechnungsNr, date: '2026-07-08', net: ls[4].nettoTotal }),
    ]);
    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco', ls);
    expect(a.unveraendert).toBe(3);
    expect(a.ueberschrieben).toBe(2);
    expect(a.neu).toBe(10);
    expect(a.manuell).toBe(0);
    expect(a.eintraege[3].diffBetrag).toEqual({ alt: 999, neu: ls[3].bruttoTotal });
    expect(a.eintraege[4].diffDatum).toEqual({ alt: '2026-07-08', neu: ls[4].datum });
    // Kein Bestands-Eintrag deckt zwei Lieferungen.
    const matchIds = a.eintraege.filter(e => e.match).map(e => e.match!.id);
    expect(new Set(matchIds).size).toBe(matchIds.length);
  });

  it('findet bestehende WKQ-AG-Lieferscheine für eine Fideco-Monatsrechnung', async () => {
    const ls = fidecoLieferungen().slice(0, 1);
    bestand.set('2026-07', [{
      ...eintrag({ id: 'lpdf-wkq', ref: ls[0].rechnungsNr, date: ls[0].datum, net: ls[0].nettoTotal }),
      supplierName: 'WKQ AG',
    }]);

    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco Schweiz', ls);
    expect(a.unveraendert).toBe(1);
    expect(a.eintraege[0].match?.id).toBe('lpdf-wkq');
  });

  it('Match ohne LS-Nr über Datum + Betrag (brutto ±0.10), Fenster 0 = exaktes Datum', async () => {
    const ls = fidecoLieferungen();
    bestand.set('2026-07', [
      // gleiche(s) Datum+Betrag, keine Referenz → matcht (unverändert)
      eintrag({ id: 'lpdf-m1', date: ls[0].datum, net: ls[0].nettoTotal }),
      // Betrag weicht > 0.10 brutto ab → matcht NICHT
      eintrag({ id: 'lpdf-m2', date: ls[1].datum, net: ls[1].nettoTotal + 5 }),
      // anderes Datum → matcht NICHT
      eintrag({ id: 'lpdf-m3', date: '2026-07-31', net: ls[2].nettoTotal }),
    ]);
    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco', ls);
    expect(a.eintraege[0].status).toBe('unveraendert');
    expect(a.eintraege[0].match?.id).toBe('lpdf-m1');
    expect(a.neu).toBe(14);
  });

  it('fensterTage=3 (Terravigna AB↔Rechnung): Datum ±3 Tage matcht, ±5 nicht', async () => {
    const ls = fidecoLieferungen().slice(0, 2);
    bestand.set('2026-07', [
      { ...eintrag({ id: 'lpdf-p1', date: '2026-07-03', net: ls[0].nettoTotal }), quelle: 'auftragsbestaetigung' } as InvoiceEntry,
      { ...eintrag({ id: 'lpdf-p2', date: '2026-07-08', net: ls[1].nettoTotal }), quelle: 'auftragsbestaetigung' } as InvoiceEntry,
    ]);
    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco', ls, 3);
    expect(a.eintraege[0].status).toBe('ueberschreiben'); // 01.07 vs 03.07 → Datum-Korrektur
    expect(a.eintraege[0].diffDatum).toEqual({ alt: '2026-07-03', neu: ls[0].datum });
    expect(a.eintraege[1].status).toBe('neu'); // 03.07 vs 08.07 → ausserhalb
  });

  it('LS-Nr-Match greift auch bei abweichendem Datum (Monate ±1)', async () => {
    const ls = fidecoLieferungen();
    bestand.set('2026-08', [eintrag({ id: 'lpdf-x1', ref: ls[14].rechnungsNr, date: '2026-08-01', net: ls[14].nettoTotal })]);
    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco', ls);
    expect(a.eintraege[14].status).toBe('ueberschreiben');
    expect(a.eintraege[14].diffDatum).toEqual({ alt: '2026-08-01', neu: ls[14].datum });
  });

  it('nichtInMr: provisorische Buchungen im MR-Monat ohne Match werden gelistet (finale/gematchte nicht)', async () => {
    const ls = fidecoLieferungen();
    bestand.set('2026-07', [
      // gematcht → NICHT in nichtInMr
      eintrag({ id: 'lpdf-a1', ref: ls[0].rechnungsNr, date: ls[0].datum, net: ls[0].nettoTotal }),
      // provisorisch, kein Match → nichtInMr
      eintrag({ id: 'lpdf-orphan', ref: '999999', date: '2026-07-14', net: 123.45 }),
      // FINAL, kein Match → NICHT in nichtInMr (nur provisorische zählen)
      { ...eintrag({ id: 'lpdf-final', ref: '888888', date: '2026-07-15', net: 50 }), final: true } as InvoiceEntry,
    ]);
    // Nachbarmonat: ausserhalb der MR-Monate → NIE in nichtInMr
    bestand.set('2026-06', [eintrag({ id: 'lpdf-juni', ref: '777777', date: '2026-06-20', net: 80 })]);
    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco', ls);
    expect(a.nichtInMr.map(e => e.id)).toEqual(['lpdf-orphan']);
    // summeErfasst = provisorische Buchungen im MR-Monat (gematcht + orphan)
    expect(a.summeErfasst).toBe(R2(ls[0].nettoTotal + 123.45));
  });

  it('Stufe-1-Kopf (Gourmador): MR als Gesamt-Lieferung — LS des Monats landen in nichtInMr, Differenz sichtbar', async () => {
    const { kopfAlsLieferung } = await import('@/lib/monatsrechnung-abgleich');
    const kopf = kopfAlsLieferung(
      { rechnungsNr: '778899', rechnungsdatum: '2026-07-31', netto: 4000, mwst: 104 },
      { name: 'Gourmador (frigemo)', kategorie: 'TK/Gemüse' });
    expect(kopf).not.toBeNull();
    expect(kopf!.nettoTotal).toBe(4000);
    expect(kopf!.positionen[0].bezeichnung).toBe('Monatsrechnung gesamt');
    // Unvollständiger Kopf ⇒ null (kein MR-Modus)
    expect(kopfAlsLieferung({ rechnungsNr: null, rechnungsdatum: '2026-07-31', netto: 4000, mwst: 0 },
      { name: 'X', kategorie: 'Y' })).toBeNull();
    bestand.set('2026-07', [
      { ...eintrag({ id: 'lpdf-ls1', ref: 'LS-1', date: '2026-07-05', net: 1500 }), supplierName: 'Gourmador (frigemo)' },
      { ...eintrag({ id: 'lpdf-ls2', ref: 'LS-2', date: '2026-07-19', net: 2450 }), supplierName: 'Gourmador (frigemo)' },
    ]);
    const a = await abgleicheMonatsrechnung('beaulieu', 'Gourmador (frigemo)', [kopf!]);
    // MR-Gesamtbuchung matcht keinen LS → 'neu' (Einzelbestätigung nötig);
    // beide LS unmatcht → nichtInMr; Differenz = 4000 − 3950 = 50.
    expect(a.neu).toBe(1);
    expect(a.nichtInMr.map(e => e.id).sort()).toEqual(['lpdf-ls1', 'lpdf-ls2']);
    expect(a.summeMonatsrechnung).toBe(4000);
    expect(a.summeErfasst).toBe(3950);
  });

  it('manuell erfasste Treffer (fremdes id-Präfix) werden als manuell markiert', async () => {
    const ls = fidecoLieferungen().slice(0, 2);
    bestand.set('2026-07', [
      { ...eintrag({ id: 'inv-manual-1', ref: ls[0].rechnungsNr, date: ls[0].datum, net: ls[0].nettoTotal }), amountGross: 500 },
      eintrag({ id: 'fs-auto-2', ref: ls[1].rechnungsNr, date: ls[1].datum, net: ls[1].nettoTotal }),
    ]);
    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco', ls);
    expect(a.manuell).toBe(1);
    expect(a.eintraege[0].manuell).toBe(true);
    expect(a.eintraege[1].manuell).toBeUndefined();
  });

  it('fremde Lieferanten im Bestand werden ignoriert', async () => {
    const ls = fidecoLieferungen();
    bestand.set('2026-07', [{ ...eintrag({ id: 'lpdf-f1', ref: ls[0].rechnungsNr, date: ls[0].datum, net: ls[0].nettoTotal }), supplierName: 'Metzgerei Spahni' }]);
    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco', ls);
    expect(a.neu).toBe(15);
  });
});
