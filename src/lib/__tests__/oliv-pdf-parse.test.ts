// @vitest-environment node
/**
 * Kontrollwerte aus den Beispiel-PDFs (Mandant OLIV) — Transgourmet, Ambro,
 * Spahni, Blaser (Bohnenblust: PDF-Import nur Beaulieu via nurMandant-Scope;
 * bei Oliv weiterhin manuell — Kunden-Nr 9865.2 = Beaulieu).
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
import { aktualisierePreisHistorie, berechnePreisAenderungen, positionenAusRechnung } from '@/lib/waren-positionen';
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
  it('Bohnenblust: Kunden-Nr entscheidet — 9865.2 = Beaulieu, andere (Oliv 1422004) ohne Sperre', () => {
    // Oliv-Beleg (Kunden-Nr 1422004): Adresse ist trotzdem Beaulieu → keine
    // adressbasierte Sperre; ohne Profil bleibt es bei manueller Erfassung.
    expect(erkenneMandantImText(fx('bohnenblust-49300.txt'))).toBeNull();
    expect(erkenneMandantImText('Bäckerei Bohnenblust AG\nKunden-Nr. 9865.2')).toBe('beaulieu');
  });
});

describe('Terravigna Retouren + gemischte MwSt (synthetische Kontrolle)', () => {
  const text = [
    'Terra Vigna AG  CHE-108.008.709 MWST',
    'Rechnung 209259',
    'Belegdatum 30.06.26',
    'Lieferungsnr. 285295 vom 18.06.26',
    '1  21111-24-075  12 75 cl  14.50  174.00',
    'Barbera d’Asti',
    'Lieferungsnr. 286277 vom 18.06.26',
    '2  33333-24-075  -36 75 cl  14.50  -522.00',
    'Retoure Weisswein',
    '3  44444-24-075  6 75 cl  21.00  126.00',
    'Total CHF ohne MwSt.  -222.00',
    'Total CHF inkl. MwSt.  -238.15',
  ].join('\n');
  const e = parseProfilPdf(text, P);
  it('negative Retouren-Positionen werden gelesen und subtrahiert', () => {
    expect(e.profil?.id).toBe('terravigna');
    expect(e.lieferungen).toHaveLength(2); // 18.06. ZWEIMAL: 285295 UND 286277
    expect(e.lieferungen[1].positionen.map(p => p.positionspreis)).toEqual([-522, 126]);
    expect(e.lieferungen[1].positionen[0].menge).toBe(-36);
    expect(R2(e.lieferungen.reduce((s, l) => s + l.nettoTotal, 0))).toBe(-222);
    expect(e.hinweise).toHaveLength(0); // Σ Positionen == Netto
  });
  it('Brutto direkt aus «Total CHF inkl. MwSt.»; MwSt = Brutto − Netto', () => {
    expect(e.netto).toBe(-222);
    expect(e.brutto).toBe(-238.15);
    expect(e.mwst).toBe(-16.15);
  });
});

describe('Bohnenblust: PDF-Import NUR Beaulieu (nurMandant-Scope)', () => {
  it('Default-Profil trägt nurMandant beaulieu (loadLieferantenProfile filtert es bei Oliv)', () => {
    const bb = DEFAULT_PROFILE_BEAULIEU.find(p => p.id === 'bohnenblust')!;
    expect(bb.nurMandant).toBe('beaulieu');
  });
  it('Oliv-Beleg 49300 (Kunden-Nr 1422004) parst zwar, aber der Mandanten-Check blockt nicht via Adresse', () => {
    const e = parse('bohnenblust-49300.txt');
    expect(e.profil?.id).toBe('bohnenblust');
    expect(erkenneMandantImText(fx('bohnenblust-49300.txt'))).toBeNull();
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
    const alle = e.lieferungen.flatMap(x => x.positionen);
    expect(alle.find(p => p.artNr === '540.402')).toMatchObject({
      bezeichnung: 'Pelati San Marzano DOP Casa Marrazzo',
      menge: 24,
      einheit: 'SCA',
      preis: 10.54,
      positionspreis: 252.96,
      mwstBetrag: 6.58,
    });
    // 100%-Rabatt/Gratisposition ist keine Preisbeobachtung.
    expect(alle.some(p => p.artNr === '111.009' || p.preis === 0)).toBe(false);
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

describe('Ambro EINZEL-LIEFERSCHEINE (provisorisch, Positionen + Belegnummer)', () => {
  it('26116806: 1 Position, Lieferdatum 05.08. (nicht Auftragsdatum 04.08.)', () => {
    const e = parse('ambro-ls-26116806.txt');
    expect(e.profil?.id).toBe('ambro');
    expect(e.dokumenttyp).toBe('lieferschein');
    expect(e.rechnungsNr).toBe('26116806');
    expect(e.netto).toBe(31.62);
    expect(e.positionenErkannt).toBe(true);
    expect(e.lieferungen).toHaveLength(1);
    const l = e.lieferungen[0];
    expect(l.rechnungsNr).toBe('26116806');
    expect(l.datum).toBe('2026-08-05');           // Lieferdatum, NIE 2026-08-04
    expect(l.nettoTotal).toBe(31.62);
    expect(l.positionen).toHaveLength(1);
    expect(l.positionen[0]).toMatchObject({
      artNr: '540.402', menge: 3, einheit: 'SCA', preis: 10.54, positionspreis: 31.62,
    });
    expect(l.positionen[0].bezeichnung).toContain('Pelati San Marzano');
    expect(e.hinweise).toHaveLength(0);           // Positionssumme = Kopf-Netto
  });
  it('26117033: 3 Positionen, Netto 560.80', () => {
    const e = parse('ambro-ls-26117033.txt');
    expect(e.rechnungsNr).toBe('26117033');
    expect(e.dokumenttyp).toBe('lieferschein');
    const l = e.lieferungen[0];
    expect(l.datum).toBe('2026-08-07');
    expect(l.nettoTotal).toBe(560.8);
    expect(l.positionen.map(p => [p.artNr, p.menge, p.preis, p.positionspreis])).toEqual([
      ['450.725', 48, 5.45, 261.6],
      ['120.296', 104, 2.2, 228.8],
      ['120.228', 4, 17.6, 70.4],
    ]);
    expect(e.hinweise).toHaveLength(0);
  });
  it('26117323: 4 Positionen, Netto 608.85; Burrata/Mozzarella-Preise stabil (Historie-Testfall)', () => {
    const e = parse('ambro-ls-26117323.txt');
    expect(e.rechnungsNr).toBe('26117323');
    const l = e.lieferungen[0];
    expect(l.datum).toBe('2026-08-12');           // Lieferdatum, NIE 11.08.
    expect(l.nettoTotal).toBe(608.85);
    expect(l.positionen.map(p => [p.artNr, p.menge, p.preis, p.positionspreis])).toEqual([
      ['460.852', 36, 6.94, 249.98],
      ['120.296', 104, 2.2, 228.8],
      ['120.228', 4, 17.6, 70.4],
      ['450.037', 17, 3.51, 59.67],
    ]);
    // Mehrzeilige Bezeichnungen: Zeile über der Positionszeile
    expect(l.positionen[0].bezeichnung).toContain('Olio Extravergine');
    expect(l.positionen[3].bezeichnung).toContain('Doppio Concentrato');
    expect(e.hinweise).toHaveLength(0);
  });
  it('Monatsrechnung mit unlesbaren Blöcken fällt NICHT in den LS-Fallback (Kopf-Buchung statt falscher Lieferung)', () => {
    const roh = fx('ambro-26210060.txt').split('\n')
      .filter(z => !/Basierend auf Lieferschein/i.test(z)).join('\n');
    const e = parseProfilPdf(roh, P);
    expect(e.profil?.id).toBe('ambro');
    expect(e.positionenErkannt).toBe(false);   // keine Lieferungen — Fallback gesperrt
    expect(e.lieferungen).toHaveLength(0);
  });
  it('unvollständige Positionssumme wird fail-closed verworfen, Kopf-Netto bleibt erhalten', () => {
    const roh = fx('ambro-ls-26117033.txt').replace(
      '2  120.296  Burrata 120gr vaschetta (crtx8pz)  104.000  PZ  2.85  22.81  2.20  228.80',
      '');
    const e = parseProfilPdf(roh, P);
    expect(e.netto).toBe(560.8);
    expect(e.positionenErkannt).toBe(false);
    expect(e.lieferungen).toHaveLength(0);
    expect(e.hinweise.join(' ')).toContain('Artikeldetails verworfen');
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

describe('Caporaso LIEFERSCHEIN-RECHNUNG (echte Artikel + Konto-Split via MwSt)', () => {
  it('2144841: 4060 1199.40 / 4701 240.00 · netto 1439.40 · Lieferdatum 04.08.', () => {
    const e = parse('caporaso-2144841.txt');
    expect(e.profil?.id).toBe('caporaso');
    expect(e.belegart).toBe('rechnung');
    expect(e.rechnungsNr).toBe('2144841');
    expect(e.lieferdatum).toBe('2026-08-04');
    // Bei Caporaso = Rechnungsdatum.
    expect(e.rechnungsdatum).toBe('2026-08-04');
    expect(e.netto).toBe(1439.4);
    // Gedruckte MwSt-Beträge der Rechnung: 19.45 (8.1 %) + 31.20 (2.6 %).
    expect(e.mwst).toBe(50.65);
    expect(e.positionenErkannt).toBe(true);
    expect(e.lieferungen).toHaveLength(1);
    const l = e.lieferungen[0];
    expect(l.rechnungsNr).toBe('2144841');
    expect(l.datum).toBe('2026-08-04');
    expect(l.positionen).toHaveLength(6); // Gratis-Abverkaufsartikel (0.00) ausgeschlossen
    const kueche = R2(l.positionen.filter(p => p.warengruppe === 'Küche').reduce((s, p) => s + p.positionspreis, 0));
    const betrieb = R2(l.positionen.filter(p => p.warengruppe === 'Betriebsmaterial').reduce((s, p) => s + p.positionspreis, 0));
    expect(kueche).toBe(1199.4);
    expect(betrieb).toBe(240.0);
    expect(R2(l.nettoTotal)).toBe(1439.4);
    expect(l.mwstTotal).toBe(50.65);
    expect(l.bruttoTotal).toBe(1490.05);
    const gespeichert = positionenAusRechnung(l, []);
    expect(R2(gespeichert.reduce((s, p) => s + p.positionspreis + p.mwstBetrag, 0))).toBe(e.brutto);
    expect(l.positionen.some(p => p.preis === 0 || !p.artNr)).toBe(false);
    expect(l.positionen.find(p => p.artNr === '020266')).toMatchObject({
      bezeichnung: 'Parmaschinken DOP Block 14 Mt.',
      menge: 2.98,
      einheit: 'KG',
      preis: 33,
      positionspreis: 98.4,
      mwstBetrag: 2.56,
    });
    // Sack à 25 kg: Preisverlauf auf kg-Basis, nicht CHF 42.50/Sack oder CHF 425 Position.
    expect(l.positionen.find(p => p.artNr === '090022')).toMatchObject({
      menge: 250,
      einheit: 'KG',
      preis: 1.7,
      positionspreis: 425,
    });
    // Karton à 100 Stück: gedruckter Vergleichspreis bleibt erhalten.
    expect(l.positionen.find(p => p.artNr === '140040')).toMatchObject({
      menge: 1000,
      einheit: 'STK',
      preis: 0.25,
      positionspreis: 240,
      warengruppe: 'Betriebsmaterial',
    });
    expect(e.hinweise).toHaveLength(0);
  });

  it('2144990: 4060 566.40 / 4701 120.00 · netto 686.40', () => {
    const e = parse('caporaso-2144990.txt');
    expect(e.profil?.id).toBe('caporaso');
    expect(e.rechnungsNr).toBe('2144990');
    expect(e.lieferdatum).toBe('2026-08-06');
    expect(e.netto).toBe(686.4);
    const l = e.lieferungen[0];
    expect(l.mwstTotal).toBe(24.45);
    expect(l.bruttoTotal).toBe(710.85);
    expect(R2(positionenAusRechnung(l, []).reduce((s, p) => s + p.positionspreis + p.mwstBetrag, 0))).toBe(e.brutto);
    expect(R2(l.positionen.filter(p => p.warengruppe === 'Küche').reduce((s, p) => s + p.positionspreis, 0))).toBe(566.4);
    expect(R2(l.positionen.filter(p => p.warengruppe === 'Betriebsmaterial').reduce((s, p) => s + p.positionspreis, 0))).toBe(120.0);
    expect(l.positionen.find(p => p.artNr === '010467')).toMatchObject({
      menge: 6,
      einheit: 'KG',
      preis: 6.4,
      positionspreis: 38.4,
    });
  });

  it('fehlende Artikelzeile verwirft Details statt eine Sammelposition zu erzeugen', () => {
    const roh = fx('caporaso-2144990.txt').replace(
      '1.2  010461  8.00  Karton  Mozzarella Julienne Fior di Latte Antica Napoli  1  60.00  2.60 %  480.00',
      '');
    const e = parseProfilPdf(roh, P);
    expect(e.netto).toBe(686.4);
    expect(e.positionenErkannt).toBe(false);
    expect(e.lieferungen).toHaveLength(0);
    expect(e.hinweise.join(' ')).toContain('Artikeldetails verworfen');
  });

  it('Artikelnummer bleibt über Belege stabil; Preisänderung wird erkannt, Re-Import nicht doppelt gemeldet', () => {
    const alt = parse('caporaso-2144841.txt').lieferungen[0];
    const neuBasis = parse('caporaso-2144990.txt').lieferungen[0];
    const historie = aktualisierePreisHistorie({}, [alt], 'Caporaso');
    const neu = {
      ...neuBasis,
      positionen: neuBasis.positionen.map(p => p.artNr === '010461' ? { ...p, preis: 16 } : p),
    };
    const aenderungen = berechnePreisAenderungen(neu, 'Caporaso', historie);
    expect(aenderungen).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'caporaso|nr:010461',
        artNr: '010461',
        alt: 15,
        neu: 16,
      }),
    ]));
    const nachImport = aktualisierePreisHistorie(historie, [neu], 'Caporaso');
    expect(berechnePreisAenderungen(neu, 'Caporaso', nachImport)).toHaveLength(0);
  });

  it('Selbstvalidierung: Positionszeilen mit zufälligen %-Angaben zählen nicht', async () => {
    const { caporasoMwstBasen } = await import('@/lib/profil-pdf-parse');
    const text = [
      'Rabatt 2.60 % auf 100.00  97.40', // 100×2.6 % = 2.60 ≠ 97.40 → verworfen
      'MwSt 2.60 % von 566.40  14.73',
      'MwSt 8.10 % von 120.00  9.72',
      'MwSt 8.10 % von 120.00  9.72', // Wiederholung (Folgeseite) zählt nicht doppelt
    ].join('\n');
    const basen = caporasoMwstBasen(text);
    expect(basen).toHaveLength(2);
    expect(basen.find(b => b.satz === 2.6)?.basis).toBe(566.4);
    expect(basen.find(b => b.satz === 8.1)?.basis).toBe(120.0);
  });
});

describe('caporasoMwstBasen: nur MwSt-Zusammenfassungszeilen', () => {
  it('rechnerisch passende Rabatt-/Positionszeilen ohne MwSt-Kontext zählen nie', async () => {
    const { caporasoMwstBasen } = await import('@/lib/profil-pdf-parse');
    const text = [
      'Rabatt 2.60 % auf 1000.00  26.00',        // Mathe passt, kein MwSt-Kontext → verworfen
      '9002 Artikel Aktion 8.10 %  200.00 16.20', // dito
      'MwSt-Rabatt 2.60 % 500.00 13.00',          // MwSt-Wort, aber Rabatt → verworfen
      'MwSt 2.60 % von 566.40  14.73',
      'MwSt 8.10 % von 120.00  9.72',
    ].join('\n');
    const basen = caporasoMwstBasen(text);
    expect(basen).toHaveLength(2);
    expect(basen.find(b => b.satz === 2.6)?.basis).toBe(566.4);
    expect(basen.find(b => b.satz === 8.1)?.basis).toBe(120.0);
  });
});

// ─── Echte Caporaso-PDFs: volle Pipeline (pdfjs-Items → Zeilen → Parser) ─────
// Die .items.json-Fixtures sind die UNVERÄNDERTEN pdfjs-getTextContent-Items
// der beiden Original-PDFs; nur die pdfjs-IO-Schicht ist ausgelassen.
import { reconstructGnPdfLines, type GnPdfPageItems } from '@/lib/gn-pdf-lines';
import { findeProfilImText } from '@/lib/lieferanten-profile';

const itemsFx = (name: string): GnPdfPageItems[] =>
  (JSON.parse(fx(name)) as { pages: GnPdfPageItems[] }).pages;

describe('Caporaso: echte PDF-Items durch die produktive Pipeline', () => {
  it('2144841: Zeilenrekonstruktion → Parser liefert echte Artikel und den Konto-Split', () => {
    const text = reconstructGnPdfLines(itemsFx('caporaso-2144841.items.json')).map(l => l.text).join('\n');
    const e = parseProfilPdf(text, P);
    expect(e.profil?.id).toBe('caporaso');
    expect(e.netto).toBe(1439.4);
    const l = e.lieferungen[0];
    expect(l.positionen).toHaveLength(6);
    expect(R2(l.positionen.filter(p => p.warengruppe === 'Küche').reduce((s, p) => s + p.positionspreis, 0))).toBe(1199.4);
    expect(R2(l.positionen.filter(p => p.warengruppe === 'Betriebsmaterial').reduce((s, p) => s + p.positionspreis, 0))).toBe(240.0);
    expect(l.positionen.find(p => p.artNr === '090022')?.preis).toBe(1.7);
  });
  it('2144990: Zeilenrekonstruktion → Parser liefert den Konto-Split', () => {
    const text = reconstructGnPdfLines(itemsFx('caporaso-2144990.items.json')).map(l => l.text).join('\n');
    const e = parseProfilPdf(text, P);
    expect(e.profil?.id).toBe('caporaso');
    expect(e.netto).toBe(686.4);
    const l = e.lieferungen[0];
    expect(l.positionen).toHaveLength(4);
    expect(R2(l.positionen.filter(p => p.warengruppe === 'Küche').reduce((s, p) => s + p.positionspreis, 0))).toBe(566.4);
    expect(R2(l.positionen.filter(p => p.warengruppe === 'Betriebsmaterial').reduce((s, p) => s + p.positionspreis, 0))).toBe(120.0);
  });
  it('Schnellerfassungs-Text (Items stumpf mit Spaces gejoint) erkennt Caporaso — Kunden-MWST-Nr zählt nicht', () => {
    for (const name of ['caporaso-2144841.items.json', 'caporaso-2144990.items.json']) {
      const flat = itemsFx(name).flatMap(p => p.items.map(i => i.str)).join(' ');
      const { profil } = findeProfilImText(flat, P);
      expect(profil?.id).toBe('caporaso');
    }
  });
});
