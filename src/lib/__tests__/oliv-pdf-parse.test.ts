// @vitest-environment node
/**
 * Kontrollwerte aus den Beispiel-PDFs (Mandant OLIV) — Transgourmet, Ambro,
 * Spahni, Blaser + Bohnenblust-Mandanten-Gegenprobe (Beleg gehört zu Beaulieu).
 * Fixtures = produktive Zeilenrekonstruktion (reconstructGnPdfLines).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase-kv', () => ({
  kvGet: vi.fn(async () => null),
  kvGetStrict: vi.fn(async () => null),
  kvSet: vi.fn(async () => {}),
  kvRemove: vi.fn(async () => {}),
}));
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProfilPdf } from '@/lib/profil-pdf-parse';
import { DEFAULT_PROFILE_BEAULIEU, erkenneMandantImText } from '@/lib/lieferanten-profile';

const fx = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'oliv-pdf', name), 'utf8');

const P = DEFAULT_PROFILE_BEAULIEU;
const parse = (name: string) => parseProfilPdf(fx(name), P);
const R2 = (n: number) => Math.round(n * 100) / 100;

describe('Mandanten-Erkennung nach Beleg-Adresse', () => {
  it('Oliv-Belege → oliv', () => {
    expect(erkenneMandantImText(fx('spahni-8649975.txt'))).toBe('oliv');
    expect(erkenneMandantImText(fx('blaser-1091031.txt'))).toBe('oliv');
    expect(erkenneMandantImText(fx('transgourmet-64104237.txt'))).toBe('oliv');
    expect(erkenneMandantImText(fx('ambro-26210060.txt'))).toBe('oliv');
  });
  it('Bohnenblust 49300 → beaulieu (Gegenprobe: unter Oliv gesperrt)', () => {
    expect(erkenneMandantImText(fx('bohnenblust-49300.txt'))).toBe('beaulieu');
  });
});

describe('Transgourmet Rechnung 64104237', () => {
  const e = parse('transgourmet-64104237.txt');
  it('Kopf: Nr/Datum/Netto/MwSt/Brutto', () => {
    expect(e.profil?.id).toBe('transgourmet');
    expect(e.belegart).toBe('rechnung');
    expect(e.rechnungsNr).toBe('64104237');
    expect(e.rechnungsdatum).toBe('2026-07-29');
    expect(e.netto).toBe(4985.74);
    expect(e.mwst).toBe(203.87);
    expect(e.brutto).toBe(5189.61);
  });
  it('genau EINE Lieferung (LS 5942418, 29.07.) mit deckender Positionssumme', () => {
    expect(e.lieferungen).toHaveLength(1);
    expect(e.lieferungen[0].rechnungsNr).toBe('5942418');
    expect(e.lieferungen[0].datum).toBe('2026-07-29');
    expect(e.lieferdatum).toBe('2026-07-29');
    expect(e.lieferungen[0].nettoTotal).toBe(4985.74);
    expect(e.hinweise).toHaveLength(0);
  });
  it('Food/Non-Food-Split über MWST-Klassen (2.6 → Food; 8.1/0 → Non-Food)', () => {
    const pos = e.lieferungen[0].positionen;
    const food = R2(pos.filter(p => p.warengruppe === 'Food').reduce((s, p) => s + p.positionspreis, 0));
    const nonfood = R2(pos.filter(p => p.warengruppe === 'Nonfood').reduce((s, p) => s + p.positionspreis, 0));
    expect(food).toBe(3546.75);
    expect(nonfood).toBe(1438.99);
  });
});

describe('Transgourmet Rechnung 64113362', () => {
  const e = parse('transgourmet-64113362.txt');
  it('Kontrollwerte', () => {
    expect(e.netto).toBe(2623.54);
    expect(e.brutto).toBe(2702.91);
    const pos = e.lieferungen.flatMap(l => l.positionen);
    const food = R2(pos.filter(p => p.warengruppe === 'Food').reduce((s, p) => s + p.positionspreis, 0));
    const nonfood = R2(pos.filter(p => p.warengruppe === 'Nonfood').reduce((s, p) => s + p.positionspreis, 0));
    expect(food).toBe(2425.08);
    expect(nonfood).toBe(198.46);
    expect(e.hinweise).toHaveLength(0);
  });
});

describe('Ambro Monatsrechnungen', () => {
  it('26210060: Brutto 5848.15 (inkl. Rundung), Lieferungen decken das Netto', () => {
    const e = parse('ambro-26210060.txt');
    expect(e.profil?.id).toBe('ambro');
    expect(e.rechnungsNr).toBe('26210060');
    expect(e.netto).toBe(5699.94);
    expect(e.brutto).toBe(5848.15);
    expect(e.lieferungen.length).toBeGreaterThan(1);
    expect(e.hinweise).toHaveLength(0); // Positionssumme = Netto
    // Lieferdatum je Block (Bsp: LS 26110129 vom 18.05., LIEFERDATUM 19.05.)
    const l = e.lieferungen.find(x => x.rechnungsNr === '26110129');
    expect(l?.datum).toBe('2026-05-19');
  });
  it('26212344: Brutto 6874.35', () => {
    const e = parse('ambro-26212344.txt');
    expect(e.brutto).toBe(6874.35);
    expect(e.hinweise).toHaveLength(0);
  });
  it('26214454 (merged): Brutto 8791.15', () => {
    const e = parse('ambro-26214454.txt');
    expect(e.rechnungsNr).toBe('26214454');
    expect(e.brutto).toBe(8791.15);
    expect(e.hinweise).toHaveLength(0);
  });
});

describe('Spahni OLIV Rechnung 8649975', () => {
  const e = parse('spahni-8649975.txt');
  it('3 Lieferungen 22./28./31.07, Netto 1842.85, Brutto 1890.75', () => {
    expect(e.profil?.id).toBe('spahni');
    expect(e.netto).toBe(1842.85);
    expect(e.brutto).toBe(1890.75);
    expect(e.lieferungen.map(l => l.datum)).toEqual(['2026-07-22', '2026-07-28', '2026-07-31']);
    expect(e.hinweise).toHaveLength(0);
  });
});

describe('Blaser Rechnung 1091031', () => {
  const e = parse('blaser-1091031.txt');
  it('Netto 731.50, Brutto 750.50, Lieferdatum 29.07. aus dem Kopffeld', () => {
    expect(e.profil?.id).toBe('blaser');
    expect(e.rechnungsNr).toBe('1091031');
    expect(e.netto).toBe(731.5);
    expect(e.brutto).toBe(750.5);
    expect(e.lieferdatum).toBe('2026-07-29');
  });
});

describe('Bohnenblust Rechnung 49300 (Beaulieu)', () => {
  const e = parse('bohnenblust-49300.txt');
  it('2 Lieferungen 10.07./31.07, Netto 277.20, Brutto 284.40', () => {
    expect(e.profil?.id).toBe('bohnenblust');
    expect(e.rechnungsNr).toBe('49300');
    expect(e.netto).toBe(277.2);
    expect(e.mwst).toBe(7.21);
    expect(e.lieferungen.map(l => ({ nr: l.rechnungsNr, datum: l.datum, netto: l.nettoTotal })))
      .toEqual([
        { nr: '497498', datum: '2026-07-10', netto: 138.6 },
        { nr: '499342', datum: '2026-07-31', netto: 138.6 },
      ]);
  });
});
