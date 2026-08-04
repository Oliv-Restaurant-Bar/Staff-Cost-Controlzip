/**
 * Monatsrechnungs-Abgleich (Dual-Lieferanten, Feldschlösschen-Modell):
 * Lieferscheine führend, Monatsrechnung = Kontrolle + Lückenfüller.
 * Kontroll-Szenario gemäss Aufgabe: Fideco-Monatsrechnung mit 15 Lieferungen
 * (01.07.–30.07.), Netto 5'900.30 — zuerst erfasste Lieferscheine müssen als
 * «bereits vorhanden» erscheinen, der Rest als «fehlt», nie doppelt.
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

describe('abgleicheMonatsrechnung (Fideco-Kontrollszenario)', () => {
  it('leerer Bestand: alle 15 fehlen, Summe Monatsrechnung 5900.30', async () => {
    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco', fidecoLieferungen());
    expect(a.vorhanden).toBe(0);
    expect(a.fehlt).toBe(15);
    expect(a.summeMonatsrechnung).toBe(5900.30);
    expect(a.summeErfasst).toBe(0);
  });

  it('zuerst erfasste Lieferscheine = «bereits vorhanden», Rest «fehlt» — kein Doppel', async () => {
    const ls = fidecoLieferungen();
    // 6 Lieferscheine wurden bereits einzeln erfasst (Match über LS-Nr).
    bestand.set('2026-07', ls.slice(0, 6).map((l, i) =>
      eintrag({ id: `e${i}`, ref: l.rechnungsNr, date: l.datum, net: l.nettoTotal })));
    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco', ls);
    expect(a.vorhanden).toBe(6);
    expect(a.fehlt).toBe(9);
    expect(a.summeErfasst).toBe(R2(ls.slice(0, 6).reduce((s, l) => s + l.nettoTotal, 0)));
    // Kein Bestands-Eintrag deckt zwei Lieferungen.
    const matchIds = a.eintraege.filter(e => e.match).map(e => e.match!.id);
    expect(new Set(matchIds).size).toBe(matchIds.length);
  });

  it('Match ohne LS-Nr über Datum + Betrag (brutto ±0.10), nie grosszügiger', async () => {
    const ls = fidecoLieferungen();
    bestand.set('2026-07', [
      // gleiche(s) Datum+Betrag, keine Referenz → matcht
      eintrag({ id: 'm1', date: ls[0].datum, net: ls[0].nettoTotal }),
      // Betrag weicht > 0.10 brutto ab → matcht NICHT
      eintrag({ id: 'm2', date: ls[1].datum, net: ls[1].nettoTotal + 5 }),
      // anderes Datum → matcht NICHT
      eintrag({ id: 'm3', date: '2026-07-31', net: ls[2].nettoTotal }),
    ]);
    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco', ls);
    expect(a.vorhanden).toBe(1);
    expect(a.eintraege[0].match?.id).toBe('m1');
    expect(a.fehlt).toBe(14);
  });

  it('LS-Nr-Match greift auch bei abweichendem Datum (Monate ±1)', async () => {
    const ls = fidecoLieferungen();
    // Lieferschein wurde mit leicht anderem Datum im Folgemonat erfasst.
    bestand.set('2026-08', [eintrag({ id: 'x1', ref: ls[14].rechnungsNr, date: '2026-08-01', net: ls[14].nettoTotal })]);
    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco', ls);
    expect(a.eintraege[14].status).toBe('vorhanden');
    expect(a.vorhanden).toBe(1);
  });

  it('fremde Lieferanten im Bestand werden ignoriert', async () => {
    const ls = fidecoLieferungen();
    bestand.set('2026-07', [{ ...eintrag({ id: 'f1', ref: ls[0].rechnungsNr, date: ls[0].datum, net: ls[0].nettoTotal }), supplierName: 'Metzgerei Spahni' }]);
    const a = await abgleicheMonatsrechnung('beaulieu', 'Fideco', ls);
    expect(a.vorhanden).toBe(0);
  });
});
