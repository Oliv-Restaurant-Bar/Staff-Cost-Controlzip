// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, unknown>();
vi.mock('@/lib/supabase-kv', () => ({
  kvGet: vi.fn(async (k: string) => store.get(k) ?? null),
  kvSet: vi.fn(async (k: string, v: unknown) => { store.set(k, v); }),
  kvSetStrict: vi.fn(async (k: string, v: unknown) => { store.set(k, v); }),
}));

import {
  abgleichIgnoriertKey, ignoriereAbgleichZeile, wiederAufnehmenAbgleichZeile,
  ladeAbgleichIgnoriert, filterIgnorierteKandidaten,
} from '@/lib/waren-abgleich-ignoriert';

const zeile = { belegNr: 'RE-4711', datumIso: '2026-08-05', betrag: 123.45, text: 'TG Buchung', lieferant: 'Transgourmet' };

beforeEach(() => store.clear());

describe('abgleichIgnoriertKey', () => {
  it('Beleg-Schlüssel = Nummer (case-insensitiv) + Datum + Betrag — textunabhängig, kollisionssicher', () => {
    expect(abgleichIgnoriertKey(zeile)).toBe('beleg:re-4711|2026-08-05|123.45|transgourmet');
    // Re-Import derselben Rechnung mit anderem Text ⇒ gleicher Schlüssel
    expect(abgleichIgnoriertKey({ ...zeile, text: 'anders' })).toBe('beleg:re-4711|2026-08-05|123.45|transgourmet');
    // gleiche Nummer, anderes Jahr/Betrag ⇒ ANDERER Schlüssel (keine Kollision)
    expect(abgleichIgnoriertKey({ ...zeile, datumIso: '2025-08-05' })).not.toBe(abgleichIgnoriertKey(zeile));
    expect(abgleichIgnoriertKey({ ...zeile, betrag: 999 })).not.toBe(abgleichIgnoriertKey(zeile));
  });
  it('Fallback ohne Belegnummer: Datum + Betrag (2 Dez.) + normalisierter Text', () => {
    const k = abgleichIgnoriertKey({ datumIso: '2026-08-05', betrag: 10.005, text: '  Bar   Bezug ' });
    expect(k).toBe('f:2026-08-05|10.01|bar bezug');
  });
});

describe('Ignorier-Liste (pro Mandant, dublettensicher)', () => {
  it('ignorieren → persistiert; erneutes Ignorieren ERSETZT (ein Schlüssel = ein Eintrag)', async () => {
    await ignoriereAbgleichZeile('oliv', { ...zeile, grund: 'Privatbezug' });
    await ignoriereAbgleichZeile('oliv', { ...zeile, grund: 'Korrektur' });
    const l = await ladeAbgleichIgnoriert('oliv');
    expect(Object.keys(l.eintraege)).toHaveLength(1);
    expect(l.eintraege['beleg:re-4711|2026-08-05|123.45|transgourmet'].grund).toBe('Korrektur');
  });

  it('mandantengetrennt: Beaulieu sieht Olivs Einträge nicht', async () => {
    await ignoriereAbgleichZeile('oliv', zeile);
    const beaulieu = await ladeAbgleichIgnoriert('beaulieu');
    expect(Object.keys(beaulieu.eintraege)).toHaveLength(0);
  });

  it('wieder aufnehmen entfernt den Eintrag (Undo)', async () => {
    await ignoriereAbgleichZeile('oliv', zeile);
    expect(await wiederAufnehmenAbgleichZeile('oliv', 'beleg:re-4711|2026-08-05|123.45|transgourmet')).toBe(true);
    expect(Object.keys((await ladeAbgleichIgnoriert('oliv')).eintraege)).toHaveLength(0);
    expect(await wiederAufnehmenAbgleichZeile('oliv', 'beleg:re-4711|2026-08-05|123.45|transgourmet')).toBe(false);
  });

  it('filterIgnorierteKandidaten: import-fest — neu abgeleitete Kandidaten mit gleichem Schlüssel bleiben draussen', async () => {
    await ignoriereAbgleichZeile('oliv', zeile);
    const liste = await ladeAbgleichIgnoriert('oliv');
    const kandidaten = [
      { ...zeile, text: 'Transgourmet Einkauf (Re-Import, anderer Text)' }, // gleiche BelegNr
      { belegNr: undefined, datumIso: '2026-08-06', betrag: 55, text: 'Anderer' },
    ];
    const { sichtbar, ignoriert } = filterIgnorierteKandidaten(kandidaten, liste);
    expect(ignoriert).toHaveLength(1);
    expect(sichtbar).toHaveLength(1);
    expect(sichtbar[0].betrag).toBe(55);
  });

  it('Beleg-Nr-Kollisionen (anderer Lieferant/Betrag oder anderes Jahr) bleiben SICHTBAR und koexistieren', async () => {
    await ignoriereAbgleichZeile('oliv', zeile); // RE-4711, 2026-08-05, 123.45
    let liste = await ladeAbgleichIgnoriert('oliv');
    const kandidaten = [
      { ...zeile, text: 'Re-Import, anderer Text' },   // gleiche Rechnung → ignoriert
      { ...zeile, betrag: 987.65 },                    // Kollision Betrag → sichtbar
      { ...zeile, datumIso: '2025-08-05' },            // Kollision Jahr (gleicher Betrag!) → sichtbar
      { ...zeile, lieferant: 'Prodega' },              // ANDERER LIEFERANT, gleiche Nr+Datum+Betrag → sichtbar
    ];
    let res = filterIgnorierteKandidaten(kandidaten, liste);
    expect(res.ignoriert).toHaveLength(1);
    expect(res.sichtbar).toHaveLength(3);
    // Zweite/dritte Zeile mit gleicher Nummer unabhängig ignorieren — ERSETZT den ersten Eintrag NICHT
    await ignoriereAbgleichZeile('oliv', { ...zeile, datumIso: '2025-08-05' });
    await ignoriereAbgleichZeile('oliv', { ...zeile, lieferant: 'Prodega' }); // Cross-Supplier, gleiche Nr+Datum+Betrag
    liste = await ladeAbgleichIgnoriert('oliv');
    expect(Object.keys(liste.eintraege)).toHaveLength(3);
    res = filterIgnorierteKandidaten(kandidaten, liste);
    expect(res.ignoriert).toHaveLength(3);
    // Undo der Jahres-Zeile lässt den anderen Eintrag unangetastet
    await wiederAufnehmenAbgleichZeile('oliv', abgleichIgnoriertKey({ ...zeile, datumIso: '2025-08-05' }));
    liste = await ladeAbgleichIgnoriert('oliv');
    expect(Object.keys(liste.eintraege)).toHaveLength(2);
    expect(filterIgnorierteKandidaten(kandidaten, liste).ignoriert).toHaveLength(2);
  });

  it('kaputter Blob → tolerant leere Liste beim Lesen', async () => {
    store.set('waren_abgleich_ignoriert_v1', { eintraege: { x: { datumIso: 5 } } });
    const l = await ladeAbgleichIgnoriert('oliv');
    expect(Object.keys(l.eintraege)).toHaveLength(0);
  });
});
