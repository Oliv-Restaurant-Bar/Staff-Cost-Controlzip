// @vitest-environment node
/**
 * Kontrollwerte aus den Beispiel-PDFs (Mandant OLIV) — Transgourmet, Ambro,
 * Spahni, Blaser (Bohnenblust: nur manuell — keine Sperre, kein Profil).
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
  it('Bohnenblust: KEINE adressbasierte Sperre (wird nur manuell erfasst)', () => {
    expect(erkenneMandantImText(fx('bohnenblust-49300.txt'))).toBeNull();
  });
});

describe('Bohnenblust ist vom Automatik-Import ausgeschlossen', () => {
  it('49300 wird keinem Profil zugeordnet (nur manuelle Erfassung)', () => {
    const e = parse('bohnenblust-49300.txt');
    expect(e.profil).toBeNull();
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
  it('Spahni-RECHNUNG ist immer finale Monatsrechnung (auch mit 1 Lieferung)', () => {
    expect(e.dokumenttyp).toBe('monatsrechnung');
  });
});

describe('Spahni Rabatt-Kürzel + Datum (synthetische Kontrolle)', () => {
  // Minimal-Rechnung im Spahni-Layout: Position MIT Rabatt-Kürzel «A»
  // zwischen Preis und Totalpreis + Belegdatum-Zeile «Zollikofen , … / 500».
  const text = [
    'Metzgerei Spahni AG  CHE-106.963.475 MWST',
    'Zollikofen , 15.01.26 / 500',
    'RECHNUNG : 8628734',
    'LS-Nr. 5942001 vom 12.01.26',
    '01410  Rindshackfleisch  30.000 KG  5.79  A  173.70  1',
    '01250  Rindsentrecôte  6.000 KG  43.10  258.60  1',
    'Total CHF  432.30',
    '1  MWST 2.60 %  11.24',
  ].join('\n');
  const e = parseProfilPdf(text, P);
  it('Rabatt-Position wird NICHT verschluckt; Σ Positionen = Netto', () => {
    expect(e.lieferungen).toHaveLength(1);
    const pos = e.lieferungen[0].positionen;
    expect(pos.map(p => p.artNr)).toEqual(['01410', '01250']);
    expect(pos[0].positionspreis).toBe(173.7);
    expect(pos[0].menge).toBe(30);
    expect(pos[0].preis).toBe(5.79);
    expect(e.lieferungen[0].nettoTotal).toBe(432.3);
    expect(e.hinweise).toHaveLength(0); // keine Σ-Abweichung
  });
  it('Rechnungsdatum aus «Zollikofen , 15.01.26 / 500» (Rest ignoriert)', () => {
    expect(e.rechnungsdatum).toBe('2026-01-15');
  });
  it('RECHNUNG-Kopf ⇒ finale Monatsrechnung trotz nur 1 Lieferung', () => {
    expect(e.dokumenttyp).toBe('monatsrechnung');
  });
  it('Einzel-Lieferschein bleibt provisorisch — auch mit «RECHNUNG : n» im Fusstext', () => {
    const kopf = [
      'Metzgerei Spahni AG  CHE-106.963.475 MWST',
      'Liefersch./Kd.-Nr. : 5210999 / XOLI',
      'Lieferdatum : 04.08.26',
      'Zollikofen , 04.08.26  Seite 1',
      '01250  Rindsentrecôte  6.000 KG  43.10  258.60  1',
      'Total CHF  258.60',
      '1  MWST 2.60 %  6.72',
    ];
    // Fusstext-Referenz weit unten (ausserhalb der Kopfzone) darf NICHT zählen.
    const fuss = [...Array(30).fill('—'), 'RECHNUNG : 9999999 folgt per Monatsende'];
    const ls = parseProfilPdf([...kopf, ...fuss].join('\n'), P);
    expect(ls.dokumenttyp).not.toBe('monatsrechnung');
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
