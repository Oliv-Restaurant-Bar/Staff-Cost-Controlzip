/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import {
  parseChf, parseDatumCH, detectFsPdfTyp, istFeldschloesschenPdf,
  parseFsLieferschein, parseFsSammelrechnung, fsKategorie,
  fsLieferscheinAlsRechnung, fsAnhangAlsRechnung, matchFakturen,
  kategorienGegenprobe, mitFsDefaults, sammelrechnungZuHistorie, findeNaheRechnung,
  kontoSplitsAusFsKategorien, fsKontoVorschlag, parseFsFaktura, fsFakturenAlsRechnungen,
  DEFAULT_FS_KATEGORIEN_MAPPING,
  type FsZeile, type FsKategorieSumme,
} from '../feldschloesschen';

/** Test-Helfer: «a | b | c»-Strings → FsZeile (wie toFsZeilen aus GnPdfLines). */
function zeilen(rows: Array<[number, string]>): FsZeile[] {
  return rows.map(([page, s]) => {
    const cells = s.split('|').map(c => c.trim()).filter(c => c !== '');
    return {
      page, cells,
      text: cells.join(' ').replace(/\s+/g, ' ').trim(),
      kompakt: cells.join('').replace(/\s+/g, '').toLowerCase(),
    };
  });
}

// Fixture: realer Lieferschein Beaulieu 17.07.2026 (gekürzt, Struktur 1:1 aus PDF-Dump)
const LIEFERSCHEIN = zeilen([
  [1, 'Lieferschein'],
  [1, 'Feldschlösschen Getränke AG'],
  [1, 'Lieferdatum: | 17.07.2026'],
  [1, 'Auftrag: | 0941181713'],
  [1, 'Lieferung: | 479741657'],
  [1, 'KD- | Stk- | Preis | MWST'],
  [1, 'Material | Bezeichnung | Einh | Inh. | Auftr | Lief.'],
  [1, 'Material | Preis | CHF | Code'],
  [1, '3 | 10030 | Schneider Weisse unser Original | CRT | 20 | 2.38 | 1 | 1 | 47.60 | 3C'],
  [1, 'TAP7 Harass 20X0,50'],
  [1, '10450 | Feldschlösschen Alkoholfrei Lager | CRT | 24 | 1.49 | 1 | 1 | 35.76 | 4C'],
  [1, 'Harass 24X0,33'],
  [1, '10500 | Rhäzünser mit CO2 Harass 24X0,35 | CRT | 24 | 0.77 | 1 | 1 | 18.48 | 4C'],
  [1, '27692 | Campari Bitter 25% 1X1,00 | BOT | 2 | 22.95 | 2 | 2 | 45.90 | 3C'],
  [1, '10041 | Feldschlösschen Original Container | KEG | 20 | 3.92 | 1 | 1 | 78.40 | 3C'],
  [1, '1X20,00'],
  [1, 'Zwischentotal Warenwert | 226.14'],
  [2, 'Leergut'],
  [2, 'Material | Bezeichnung | Pfandwert | Geliefert | Retourniert | Di | ff | erenz | Preis CHF | MWST Code'],
  [2, '300048 | Harasse 5+12 a 0,50 12 | 11.00 | 6 | 1 | 5 | 55.00 | C0'],
  [2, '300007 | FGG Container/Fass a 50,00 1 | 50.00 | 1 | 4 | -3 | -150.00 | C0'],
  [2, 'Zwischentotal Leergut | -95.00'],
  [2, 'Konditionen | Preis CHF | MWST Code'],
  [2, 'Logistikpauschale | 15.00 | 3C'],
  [2, 'VEG | 0.36 | 3C'],
  [2, 'Zu/Abschläge | 15.36'],
  [2, 'MWST Übersicht'],
  [2, 'Total netto Lieferung | 146.50'],
  [2, 'Total MWST | 15.10'],
  [2, 'Rundungsdi | ff | erenz | -0.02'],
  [2, 'Total Lieferung | 161.58'],
]);

// Fixture: reale Sammelrechnung Juni 2026 (gekürzt)
const SAMMEL = zeilen([
  [1, 'Restaurant Beaulieu AG | Sammelrechnung: | 87749870'],
  [1, 'Erlachstrasse 3 | Datum: | 30.06.2026'],
  [1, 'Endbetrag: | CHF 9\'723.00'],
  [1, 'Faktura | Datum | Auftraggeber | Filiale | Endbetrag'],
  [1, '87717597 | 04.06.2026 | 1245760 | 4\'257.97 | 0.00 | 0.00 | 4\'258.00'],
  [1, '87724934 | 12.06.2026 | 1245760 | 806.34 | 1\'164.10 | 185.40 | 2\'155.85'],
  [1, 'Endbetrag | 6\'440.22 | 2\'817.97 | 464.80 | 9\'723.00'],
  [2, 'Zusammenfassung MwSt.'],
  [2, 'Bier | Nettowert | 5\'259.12 | 0.00 | 0.00 | 5\'259.12'],
  [2, 'MwSt | 425.99 | 0.00 | 0.00 | 425.99'],
  [2, 'Total | 5\'685.11 | 0.00 | 0.00 | 5\'685.11'],
  [2, 'Spirituosen | Nettowert | 347.05 | 0.00 | 0.00 | 347.05'],
  [2, 'MwSt | 28.11 | 0.00 | 0.00 | 28.11'],
  [2, 'Leergut | Nettowert | 0.00 | 0.00 | 464.80 | 464.80'],
  [3, 'Restaurant Beaulieu AG | Rechnung: | 87717597'],
  [3, 'Endbetrag: | CHF 4\'258.00'],
  [3, 'Lieferschein | 479114588 | vom | 02.06.2026'],
  [3, 'Material | Bezeichnung | Inhalt | Menge | Einheit | Preis | Wert | MwSt | Pfand'],
  [3, '10028 | Feldschlösschen Original Gastro-Tanksystem | 1XBULK | 500 L | 500 | 3.9200 | 1\'960.00 | 8.1% | -'],
  [3, '101504 | GTS Innenhüllen DRU Tank 1000 lt. | 1 ST | 1 | gratis | 0.00 | 8.1% | -'],
  [3, '10028 | Feldschlösschen Original Gastro-Tanksystem | 1XBULK | 501 L | 501 | 3.9200 | 1\'963.92 | 8.1% | -'],
  [3, 'Zwischentotal Warenwert / Pfand | 1003 Stk | 3\'923.92 | 0.00'],
  [3, 'Zwischentotal Warenwert inkl. Pfand | 3\'923.92'],
  [3, 'Zu-/Abschläge | Anzahl | Gebühr | Wert | MwSt'],
  [3, 'Logistikpauschale | 1 | 15.0000 | 15.00 | 8.1%'],
  [3, 'Zu-/Abschläge | 15.00'],
  [3, 'Mehrwertsteuer | 319.06'],
  [3, 'Endbetrag CHF | 4\'258.00'],
  // Letzte Seite der Einzel-Faktura: eigene «Zusammenfassung MwSt.»
  [4, 'Datum / Beleg-Nr. | Seite'],
  [4, '04.06.2026 / 87717597 | 2/2'],
  [4, 'Zusammenfassung MwSt.'],
  [4, '8.1% | 2.6% | 0.0%'],
  [4, 'Umsatz | Umsatz | Umsatz netto | Zeilentotal'],
  [4, 'Bier | Nettowert | 3\'923.92 | 0.00 | 0.00 | 3\'923.92'],
  [4, 'MwSt | 317.84 | 0.00 | 0.00 | 317.84'],
  [4, 'Total | 4\'241.76 | 0.00 | 0.00 | 4\'241.76'],
  [4, 'Zu-/Abschläge | Nettowert | 15.00 | 0.00 | 0.00 | 15.00'],
  [4, 'MwSt | 1.22 | 0.00 | 0.00 | 1.22'],
  [4, 'Total | 16.21 | 0.00 | 0.00 | 16.21'],
  [4, 'Endbetrag | 3\'938.92 | 0.00 | 0.00 | 3\'938.92'],
  [4, 'MwSt | 319.05 | 0.00 | 0.00 | 319.05'],
  [4, 'Total Brutto | 4\'257.97 | 0.00 | 0.00 | 4\'257.97'],
]);

describe('parseChf / parseDatumCH', () => {
  it('parst Schweizer Formate', () => {
    expect(parseChf("4'258.00")).toBe(4258);
    expect(parseChf('-217.00')).toBe(-217);
    expect(parseChf("CHF 9'723.00")).toBe(9723);
    expect(parseChf('-')).toBeNull();
    expect(parseChf('gratis')).toBeNull();
    expect(parseDatumCH('17.07.2026')).toBe('2026-07-17');
    expect(parseDatumCH('2.6%')).toBeNull();
  });
});

describe('detectFsPdfTyp', () => {
  it('erkennt Lieferschein und Sammelrechnung inhaltsbasiert', () => {
    expect(detectFsPdfTyp(LIEFERSCHEIN)).toBe('lieferschein');
    expect(detectFsPdfTyp(SAMMEL)).toBe('sammelrechnung');
    expect(detectFsPdfTyp(zeilen([[1, 'Irgendein PDF']]))).toBeNull();
    expect(istFeldschloesschenPdf(LIEFERSCHEIN)).toBe(true);
  });
});

describe('fsKategorie', () => {
  it('MWST-Satz ist das harte Signal', () => {
    expect(fsKategorie('Coca-Cola Harass', 2.6)).toBe('Andere alk. freie Getränke');
    expect(fsKategorie('Feldschlösschen Alkoholfrei Lager', 2.6)).toBe('Alkoholfreies Bier');
    expect(fsKategorie('Rhäzünser mit CO2', 2.6)).toBe('Mineralwasser');
    expect(fsKategorie('Campari Bitter 25%', 8.1)).toBe('Spirituosen');
    expect(fsKategorie('Paesanella Chardonnay Grappa 41%', 8.1)).toBe('Spirituosen'); // Grappa vor Wein
    expect(fsKategorie('Feldschlösschen Original Container', 8.1)).toBe('Bier');
    expect(fsKategorie('Irgendwas', 0)).toBe('Leergut');
  });
  it('rät NIE: unbekannte 8.1%-Position ⇒ null (Konto offen)', () => {
    expect(fsKategorie('Völlig unbekannter Artikel XYZ', 8.1)).toBeNull();
  });
  it('folgt der FGG-Zusammenfassung: Moscht/Cider ≠ Bier, Obstbrände = Spirituosen, Pauschalen = Zu-/Abschläge', () => {
    // SuureMoscht/Apfelwein (auch 8.1%) zählt FGG zu «Andere alk. freie Getränke»
    expect(fsKategorie('Ramseier SuureMoscht Apfelwein naturtrüb 12X0,49', 8.1)).toBe('Andere alk. freie Getränke');
    expect(fsKategorie('Ramseier SuureMoscht alk.frei Bügelflasche', 2.6)).toBe('Andere alk. freie Getränke');
    // Obstbrände: Keyword oder Alkohol-% ≥ 15 in der Bezeichnung
    expect(fsKategorie('Morand Abricot Aprikosenbrand 40% 1X0,70', 8.1)).toBe('Spirituosen');
    expect(fsKategorie('1X0,70 40%', 8.1)).toBe('Spirituosen');
    // Bier mit tiefem Alkohol-% bleibt Bier
    expect(fsKategorie('Valaisanne Lager 5.2% Fass', 8.1)).toBe('Bier');
    expect(fsKategorie('Logistikpauschale', 8.1)).toBe('Zu-/Abschläge');
  });
});

describe('umgebrochene Bezeichnungen (Markenzeile VOR der Materialzeile)', () => {
  it('Markentext vor einer Materialzeile gehört zur NÄCHSTEN Position; Verpackungs-Suffix zur vorherigen', () => {
    const ls = parseFsLieferschein(zeilen([
      [1, 'Lieferschein'],
      [1, 'Lieferdatum: | 17.07.2026'],
      [1, 'Lieferung: | 479000001'],
      [1, '10450 | Feldschlösschen Alkoholfrei Lager | CRT | 24 | 1.49 | 1 | 1 | 35.76 | 4C'],
      [1, 'Harass 24X0,33'],
      [1, 'Feldschlösschen Weizenfrisch alkoholfrei'],
      [1, '20257 | 24X0,33 | CRT | 24 | 1.60 | 3 | 3 | 115.20 | 4C'],
      [1, 'Zwischentotal Warenwert | 150.96'],
    ]));
    expect(ls.positionen[0].bezeichnung).toContain('Harass 24X0,33'); // Suffix → vorherige
    expect(ls.positionen[1].bezeichnung).toContain('Weizenfrisch');   // Marke → nächste
    expect(ls.positionen[1].warengruppe).toBe('Alkoholfreies Bier');
  });
});

describe('parseFsLieferschein', () => {
  const ls = parseFsLieferschein(LIEFERSCHEIN);
  it('liest Kopf und Totale', () => {
    expect(ls.failureReason).toBeUndefined();
    expect(ls.lieferungNr).toBe('479741657');
    expect(ls.lieferdatum).toBe('2026-07-17');
    expect(ls.zwischentotalWarenwert).toBe(226.14);
    expect(ls.leergutTotal).toBe(-95);
    expect(ls.zuAbschlaegeTotal).toBe(15.36);
    expect(ls.totalNetto).toBe(146.5);
    expect(ls.totalLieferung).toBe(161.58);
  });
  it('liest Positionen inkl. KD-Spalte, Folgezeilen, Leergut & Konditionen', () => {
    const waren = ls.positionen.filter(p => p.mwstCode !== 0 && p.artNr !== '');
    expect(waren.map(p => p.artNr)).toEqual(['10030', '10450', '10500', '27692', '10041']);
    expect(waren[0].bezeichnung).toContain('TAP7 Harass'); // Folgezeile angehängt
    expect(waren.reduce((a, p) => a + p.positionspreis, 0)).toBeCloseTo(226.14, 2);
    const leergut = ls.positionen.filter(p => p.mwstCode === 0);
    expect(leergut.reduce((a, p) => a + p.positionspreis, 0)).toBeCloseTo(-95, 2);
    // Konditionen: Logistikpauschale bleibt Zu-/Abschläge; VEG-Glasgebühr zählt
    // lt. FGG-Zusammenfassung zur Warenkategorie (hier 8.1% ⇒ Spirituosen).
    const gebuehren = ls.positionen.filter(p => p.artNr === '' && p.mwstCode !== 0);
    expect(gebuehren.reduce((a, p) => a + p.positionspreis, 0)).toBeCloseTo(15.36, 2);
    const zab = ls.positionen.filter(p => p.warengruppe === 'Zu-/Abschläge');
    expect(zab.reduce((a, p) => a + p.positionspreis, 0)).toBeCloseTo(15.00, 2);
    expect(ls.positionen.find(p => /^VEG/.test(p.bezeichnung))?.warengruppe).toBe('Spirituosen');
    expect(waren.find(p => p.artNr === '10030')?.mwstSatz).toBe(8.1);
    expect(waren.find(p => p.artNr === '10450')?.mwstSatz).toBe(2.6);
    expect(leergut.every(p => p.mwstSatz === 0)).toBe(true);
  });
  it('Netto-Summe aller Positionen = Total netto Lieferung', () => {
    const r = fsLieferscheinAlsRechnung(ls);
    expect(r.nettoTotal).toBeCloseTo(146.5, 2);
  });
  it('kategorisiert: Einzelpreis 2.38 für Preisüberwachung', () => {
    expect(ls.positionen[0].preis).toBe(2.38);
    expect(ls.positionen[0].warengruppe).toBe('Bier');
  });
});

describe('parseFsSammelrechnung', () => {
  const s = parseFsSammelrechnung(SAMMEL);
  it('liest Kopf, Fakturen, Kategorien', () => {
    expect(s.failureReason).toBeUndefined();
    expect(s.nr).toBe('87749870');
    expect(s.datum).toBe('2026-06-30');
    expect(s.endbetrag).toBe(9723);
    expect(s.fakturen.map(f => f.nr)).toEqual(['87717597', '87724934']);
    expect(s.fakturen[1].endbetrag).toBe(2155.85);
    expect(s.kategorien.find(k => k.name === 'Bier')?.nettoTotal).toBe(5259.12);
    expect(s.kategorien.find(k => k.name === 'Leergut')?.netto00).toBe(464.8);
  });
  it('liest Anhang-Lieferscheine inkl. gratis-Positionen und Zu-/Abschlägen', () => {
    expect(s.anhangLieferscheine).toHaveLength(1);
    const a = s.anhangLieferscheine[0];
    expect(a.fakturaNr).toBe('87717597');
    expect(a.lieferscheinNr).toBe('479114588');
    expect(a.datum).toBe('2026-06-02');
    expect(a.warenwertNetto).toBe(3923.92); // «inkl. Pfand»-Zeile überschreibt NICHT
    expect(a.fakturaEndbetrag).toBe(4258);
    const gratis = a.positionen.find(p => p.artNr === '101504');
    expect(gratis?.positionspreis).toBe(0);
    // Rundungs-Ausgleich: Brutto = offizieller Endbetrag
    const r = fsAnhangAlsRechnung(a);
    expect(r.bruttoTotal).toBeCloseTo(4258, 2);
  });
  it('liest die Faktura-eigene «Zusammenfassung MwSt.» (fakturaKategorien)', () => {
    const kats = s.fakturaKategorien['87717597'];
    expect(kats).toBeDefined();
    expect(kats.map(k => k.name)).toEqual(['Bier', 'Zu-/Abschläge']);
    expect(kats.find(k => k.name === 'Bier')?.netto81).toBe(3923.92);
    expect(kats.find(k => k.name === 'Bier')?.mwst81).toBe(317.84);
    expect(kats.find(k => k.name === 'Zu-/Abschläge')?.nettoTotal).toBe(15);
    // Endbetrag-/MwSt-/Total-Zeilen werden NICHT als Kategorien gesammelt
    expect(kats.some(k => /endbetrag|total|mwst/i.test(k.name))).toBe(false);
    // globale Kategorien bleiben unberührt (keine Pollution)
    expect(s.kategorien.find(k => k.name === 'Bier')?.nettoTotal).toBe(5259.12);
    // «Endbetrag CHF» der Faktura bleibt korrekt geparst
    expect(s.anhangLieferscheine[0].fakturaEndbetrag).toBe(4258);
  });
});

// Fixture: einzelne Faktura-PDF (Kopf «Rechnung: <Nr>», 2 Lieferscheine, eigene ZSF)
const FAKTURA = zeilen([
  [1, 'Feldschlösschen Getränke AG | Rechnung: | 87750197'],
  [1, 'Restaurant Olivenbaum | Datum: | 31.07.2026'],
  [1, 'Lieferschein | 479500001 | vom | 03.07.2026'],
  [1, 'Material | Bezeichnung | Inhalt | Menge | Einheit | Preis | Wert | MwSt | Pfand'],
  [1, '10042 | Feldschlösschen Original 20/0.50 | 20X0,50 | 10 | HAR | 30.0000 | 300.00 | 8.1% | 36.60'],
  [1, 'Zwischentotal Warenwert / Pfand | 10 Stk | 300.00 | 36.60'],
  [2, 'Lieferschein | 479500002 | vom | 17.07.2026'],
  [2, 'Material | Bezeichnung | Inhalt | Menge | Einheit | Preis | Wert | MwSt | Pfand'],
  [2, '117774 | Eptinger blau | 24X0,33 | 5 | HAR | 20.0000 | 100.00 | 2.6% | -'],
  [2, 'Zwischentotal Warenwert / Pfand | 5 Stk | 100.00 | 0.00'],
  [2, 'Mehrwertsteuer | 26.90'],
  [2, 'Endbetrag CHF | 463.50'],
  [3, 'Zusammenfassung MwSt.'],
  [3, '8.1% | 2.6% | 0.0%'],
  [3, 'Bier | Nettowert | 300.00 | 0.00 | 0.00 | 300.00'],
  [3, 'MwSt | 24.30 | 0.00 | 0.00 | 24.30'],
  [3, 'Mineralwasser | Nettowert | 0.00 | 100.00 | 0.00 | 100.00'],
  [3, 'MwSt | 0.00 | 2.60 | 0.00 | 2.60'],
  [3, 'Leergut | Nettowert | 0.00 | 0.00 | 36.60 | 36.60'],
  [3, 'Endbetrag | 436.60 | 0.00 | 0.00 | 436.60'],
  [3, 'Total Brutto | 463.50 | 0.00 | 0.00 | 463.50'],
]);

describe('parseFsFaktura / fsFakturenAlsRechnungen (einzelne Faktura-PDF)', () => {
  it('detectFsPdfTyp erkennt die Einzel-Faktura (und weiter Sammelrechnung/Lieferschein)', () => {
    expect(detectFsPdfTyp(FAKTURA)).toBe('faktura');
    expect(detectFsPdfTyp(SAMMEL)).toBe('sammelrechnung');
    expect(detectFsPdfTyp(LIEFERSCHEIN)).toBe('lieferschein');
  });
  it('parst Kopf, beide Lieferscheine und die eigene Zusammenfassung MwSt.', () => {
    const s = parseFsFaktura(FAKTURA);
    expect(s.failureReason).toBeUndefined();
    expect(s.nr).toBe('87750197');
    expect(s.datum).toBe('2026-07-31');
    expect(s.anhangLieferscheine).toHaveLength(2);
    expect(s.fakturaKategorien['87750197']?.map(k => k.name)).toEqual(['Bier', 'Mineralwasser', 'Leergut']);
  });
  it('fsFakturenAlsRechnungen: EINE Buchung je Faktura, ZSF massgeblich, offizielle Beträge', () => {
    const s = parseFsFaktura(FAKTURA);
    const [fr] = fsFakturenAlsRechnungen(s);
    expect(fr.r.rechnungsNr).toBe('87750197');
    expect(fr.r.datum).toBe('2026-07-17'); // letztes Lieferdatum
    expect(fr.fsKategorien?.map(k => k.name)).toEqual(['Bier', 'Mineralwasser', 'Leergut']);
    expect(fr.nettoOffiziell).toBeCloseTo(436.6, 2);
    expect(fr.bruttoOffiziell).toBe(463.5);
    const { splits } = kontoSplitsAusFsKategorien(fr.fsKategorien!, []);
    const m = Object.fromEntries(splits.map(x => [x.warenkonto, x.amountNet]));
    expect(m).toEqual({ '4030': 300, '4050': 100, '4800': 36.6 });
    expect(splits.find(x => x.warenkonto === '4030')?.vatClasses).toEqual([
      { vatRate: 8.1, amountNet: 300, amountVat: 24.3, amountGross: 324.3 },
    ]);
    expect(splits.find(x => x.warenkonto === '4800')?.vatClasses).toEqual([
      { vatRate: 0, amountNet: 36.6, amountVat: 0, amountGross: 36.6 },
    ]);
  });
  it('ohne Zusammenfassung MwSt. → failureReason (Kontierung nicht belegbar)', () => {
    const ohne = zeilen([
      [1, 'Feldschlösschen Getränke AG | Rechnung: | 999'],
      [1, 'Lieferschein | 1 | vom | 03.07.2026'],
      [1, '10042 | Bier | 20X0,50 | 10 | HAR | 30.0000 | 300.00 | 8.1% | -'],
    ]);
    expect(parseFsFaktura(ohne).failureReason).toMatch(/Zusammenfassung MwSt/);
  });
  it('ohne «Endbetrag CHF» → failureReason (offizieller Betrag fehlt)', () => {
    const ohneEndbetrag = zeilen([
      [1, 'Feldschlösschen Getränke AG | Rechnung: | 999'],
      [1, 'Lieferschein | 1 | vom | 03.07.2026'],
      [1, 'Material | Bezeichnung | Inhalt | Menge | Einheit | Preis | Wert | MwSt | Pfand'],
      [1, '10042 | Feldschlösschen Original 20/0.50 | 20X0,50 | 10 | HAR | 30.0000 | 300.00 | 8.1% | -'],
      [2, 'Zusammenfassung MwSt.'],
      [2, 'Bier | Nettowert | 300.00 | 0.00 | 0.00 | 300.00'],
    ]);
    expect(parseFsFaktura(ohneEndbetrag).failureReason).toMatch(/Endbetrag CHF/);
  });
});

describe('kontoSplitsAusFsKategorien', () => {
  const kat = (name: string, n81: number, n26 = 0, n00 = 0): FsKategorieSumme =>
    ({ name, netto81: n81, netto26: n26, netto00: n00, nettoTotal: n81 + n26 + n00 });
  it('kontiert Warenkategorien nach Mapping, 0%-Kategorien auf Depot', () => {
    const { splits, offen } = kontoSplitsAusFsKategorien([
      kat('Bier', 452), kat('Mineralwasser', 0, 1156.44), kat('Spirituosen', 195.13),
      kat('Wein', 100), kat('Zu-/Abschläge', 76.95), kat('Leergut', 0, 0, 185.40),
      kat('Mietmaterial', 20), kat('Recyclinggebühren', 5),
    ], []);
    expect(offen).toEqual([]);
    const m = Object.fromEntries(splits.map(s2 => [s2.warenkonto, s2.amountNet]));
    expect(m['4030']).toBe(452);
    expect(m['4050']).toBe(1156.44);
    expect(m['4040']).toBe(195.13);
    expect(m['4020']).toBe(100);
    expect(m['4701']).toBeCloseTo(101.95, 2); // Zu-/Abschläge + Mietmaterial + Recycling
    expect(m['4800']).toBe(185.4);
    // Brutto: 8.1%- und 2.6%-Anteile hochgerechnet, 0% unverändert
    expect(splits.find(s2 => s2.warenkonto === '4800')?.amountGross).toBe(185.4);
    expect(splits.find(s2 => s2.warenkonto === '4030')?.amountGross).toBeCloseTo(488.61, 2);
  });
  it('unbekannte Kategorie → «offen», nie raten; leere Kategorien übersprungen', () => {
    const { splits, offen } = kontoSplitsAusFsKategorien([
      kat('Bier', 100), kat('Völlig Neu', 50), kat('Wein', 0, 0, 0),
    ], []);
    expect(offen).toEqual(['Völlig Neu']);
    expect(splits.find(s2 => s2.warenkonto === 'offen')?.amountNet).toBe(50);
    expect(splits.some(s2 => s2.warenkonto === '4020')).toBe(false);
  });
  // Kontrollwerte Rechnung 87791818 (08/2026, Oliv): Gebühren-Positionen (VEG/
  // Recycl./Logistik) stecken in der ZSF INNERHALB der Warenkategorien — mit
  // übergebenen Positionen werden sie je Kategorie/Satz herausgerechnet → 4701.
  it('Gebühren-Positionen werden aus den ZSF-Warenkonto-Buckets herausgerechnet (87791818)', () => {
    const kats = [
      kat('Bier', 420), kat('Spirituosen', 539.39),
      // Wie auf der echten Rechnung: Recycl.-Geb. PET (4.96, 2.6%) steckt in der
      // ZSF INNERHALB von «Andere alk. freie Getränke» (nicht in Zu-/Abschläge).
      kat('Andere alk. freie Getränke', 0, 733.48), kat('Mineralwasser', 0, 99.84),
      kat('Zu-/Abschläge', 15), kat('Leergut', 0, 0, -233),
    ];
    const pos = [
      { bezeichnung: 'VEG EW Glas ab 33 cl bis 60 cl', warengruppe: 'Spirituosen', mwstCode: 1, positionspreis: 0.04 },
      { bezeichnung: 'VEG EW Glas ab 60cl', warengruppe: 'Spirituosen', mwstCode: 1, positionspreis: 0.60 },
      { bezeichnung: 'VEG EW Glas 9 bis 33 cl', warengruppe: 'Andere alk. freie Getränke', mwstCode: 2, positionspreis: 1.44 },
      { bezeichnung: 'Logistikpauschale', warengruppe: 'Zu-/Abschläge', mwstCode: 1, positionspreis: 15 },
      // Warengruppe wie sie gebuehrWarengruppe seit dem Recycl-Fix liefert:
      { bezeichnung: 'Recycl.-Geb. PET ab 50cl', warengruppe: 'Andere alk. freie Getränke', mwstCode: 2, positionspreis: 4.96 },
      { bezeichnung: 'Pfand Fass', warengruppe: 'Leergut', mwstCode: 0, positionspreis: -233 },
      { bezeichnung: 'Lager hell Fass', warengruppe: 'Bier', mwstCode: 1, positionspreis: 420 },
    ];
    const { splits, offen } = kontoSplitsAusFsKategorien(kats, [], pos);
    expect(offen).toEqual([]);
    const m = Object.fromEntries(splits.map(s2 => [s2.warenkonto, s2.amountNet]));
    expect(m['4030']).toBe(420);
    expect(m['4040']).toBeCloseTo(538.75, 2);  // 539.39 − 0.64 VEG
    expect(m['4050']).toBeCloseTo(826.92, 2);  // 728.52 − 1.44 VEG + 99.84
    expect(m['4701']).toBeCloseTo(22.04, 2);   // 15.00 + 4.96 + 2.08 VEG
    expect(m['4800']).toBe(-233);
    // Zahlenneutral: Σ netto unverändert
    expect(splits.reduce((a, s2) => a + s2.amountNet, 0)).toBeCloseTo(1574.71, 2);
    // OHNE Positionen (alter Pfad) blieben VEG- UND Recycl-Anteile in den Warenkonten:
    const alt = Object.fromEntries(kontoSplitsAusFsKategorien(kats, []).splits.map(s2 => [s2.warenkonto, s2.amountNet]));
    expect(alt['4050']).toBeCloseTo(833.32, 2);
    expect(alt['4701']).toBeCloseTo(15, 2);
  });
  it('ZSF mit eigener «Recyclinggebühren»-Kategorie: keine Doppelzählung, Rest gemeldet (fail-safe)', () => {
    // Kategorie selbst → 4701; die Recycl-Position trägt (seit dem Fix) eine
    // Waren-Warengruppe ohne passenden ZSF-Bucket → gebuehrenRest > 0, Aufrufer
    // weicht sichtbar auf die Positions-Kontierung aus (4701 genau einmal).
    const r = kontoSplitsAusFsKategorien(
      [kat('Bier', 100), kat('Recyclinggebühren', 0, 4.96)], [],
      [{ bezeichnung: 'Recycl.-Geb. PET ab 50cl', warengruppe: 'Andere alk. freie Getränke', mwstCode: 2, positionspreis: 4.96 }],
    );
    const m = Object.fromEntries(r.splits.map(s2 => [s2.warenkonto, s2.amountNet]));
    expect(m['4701']).toBeCloseTo(4.96, 2); // nur via Kategorie, nicht doppelt
    expect(m['4030']).toBe(100);            // Waren-Bucket unangetastet
    expect(r.gebuehrenRest).toBeCloseTo(4.96, 2); // → Aufrufer nimmt Positions-Pfad
  });
  it('Reinigungs-Positionen werden aus ZSF-Warenkonto-Buckets herausgerechnet → 6040', () => {
    // Reinigungsmittel in einer Waren-Kategorie (z.B. Non-Food-Zeile in der ZSF):
    const r = kontoSplitsAusFsKategorien(
      [kat('Bier', 100), kat('Mineralwasser', 0, 60)], [],
      [{ bezeichnung: 'Persil Universal Gel', warengruppe: 'Mineralwasser', mwstCode: 2, positionspreis: 53.22 }],
    );
    const m = Object.fromEntries(r.splits.map(s2 => [s2.warenkonto, s2.amountNet]));
    expect(m['6040']).toBeCloseTo(53.22, 2);
    expect(m['4050']).toBeCloseTo(6.78, 2); // 60 − 53.22
    expect(m['4030']).toBe(100);
    expect(r.gebuehrenRest).toBe(0);
    // Ohne passende Kategorie → Rest gemeldet (Aufrufer weicht auf Positions-Pfad aus):
    const rest = kontoSplitsAusFsKategorien([kat('Bier', 100)], [],
      [{ bezeichnung: 'Cif Crème', warengruppe: 'Unbekannt', mwstCode: 1, positionspreis: 41.10 }]);
    expect(rest.gebuehrenRest).toBeCloseTo(41.10, 2);
  });
  it('gebuehrenRest: abweichender Kategoriename / Betrag > Bucket → Rest gemeldet, nie negativ', () => {
    // Gebühren-Position mit Warengruppe, die KEINE ZSF-Kategorie hat:
    const nichtMatch = kontoSplitsAusFsKategorien([kat('Bier', 100)], [],
      [{ bezeichnung: 'Recycl.-Geb. PET', warengruppe: 'Unbekannte Gruppe', mwstCode: 2, positionspreis: 4.96 }]);
    expect(nichtMatch.gebuehrenRest).toBeCloseTo(4.96, 2);
    expect(Object.fromEntries(nichtMatch.splits.map(s2 => [s2.warenkonto, s2.amountNet]))['4030']).toBe(100);
    // Gebührenbetrag übersteigt den Satz-Bucket → nur bis Bucket subtrahieren, Rest melden:
    const zuGross = kontoSplitsAusFsKategorien([kat('Spirituosen', 2)], [],
      [{ bezeichnung: 'VEG EW Glas ab 60cl', warengruppe: 'Spirituosen', mwstCode: 1, positionspreis: 5 }]);
    expect(zuGross.gebuehrenRest).toBeCloseTo(3, 2);
    const mz = Object.fromEntries(zuGross.splits.map(s2 => [s2.warenkonto, s2.amountNet]));
    expect(mz['4040']).toBe(0);          // nie negativ
    expect(mz['4701']).toBeCloseTo(2, 2);
    // Kategorie läuft selbst auf 4701 → verrechnet, kein Rest, keine Doppelzählung:
    const selbst = kontoSplitsAusFsKategorien([kat('Zu-/Abschläge', 15)], [],
      [{ bezeichnung: 'Logistikpauschale', warengruppe: 'Zu-/Abschläge', mwstCode: 1, positionspreis: 15 }]);
    expect(selbst.gebuehrenRest).toBe(0);
    expect(Object.fromEntries(selbst.splits.map(s2 => [s2.warenkonto, s2.amountNet]))['4701']).toBe(15);
  });
  it('eigenes Mapping übersteuert die Defaults', () => {
    const { splits } = kontoSplitsAusFsKategorien([kat('Bier', 100)], [{ gruppe: 'Bier', konto: '4099' }]);
    expect(splits[0].warenkonto).toBe('4099');
  });
  // Kontrollwerte Rechnung 87750197 (08/2026): «Event Material» ist unbekannt →
  // offen (Buchen gesperrt); nach Zuordnung Event Material → 4701 in der Vorschau
  // (Regel im Mapping): 4701 = 375.00 (75 Zu-/Abschläge + 300 Event) · offen = 0.
  it('Kontrollwerte 87750197: Event Material offen → nach Regel 4701 = 375.00', () => {
    const kats = [kat('Bier', 452), kat('Zu-/Abschläge', 75), kat('Event Material', 300)];
    const ohne = kontoSplitsAusFsKategorien(kats, []);
    expect(ohne.offen).toEqual(['Event Material']);
    expect(ohne.splits.find(s2 => s2.warenkonto === 'offen')?.amountNet).toBe(300);
    const mit = kontoSplitsAusFsKategorien(kats, [{ gruppe: 'Event Material', konto: '4701' }]);
    expect(mit.offen).toEqual([]);
    const m = Object.fromEntries(mit.splits.map(s2 => [s2.warenkonto, s2.amountNet]));
    expect(m['4701']).toBeCloseTo(375, 2);
  });
  it('fsKontoVorschlag: Material-Kategorien → 4701, sonst kein Vorschlag', () => {
    expect(fsKontoVorschlag('Event Material')).toBe('4701');
    expect(fsKontoVorschlag('Mietmaterial')).toBe('4701');
    expect(fsKontoVorschlag('Völlig Neu')).toBeNull();
  });
});

describe('matchFakturen', () => {
  const fakturen = [
    { nr: '1', datum: '2026-06-04', wert81: 0, wert26: 0, wert00: 0, endbetrag: 4258 },
    { nr: '2', datum: '2026-06-16', wert81: 0, wert26: 0, wert00: 0, endbetrag: 2155.85 },
    { nr: '3', datum: '2026-06-20', wert81: 0, wert26: 0, wert00: 0, endbetrag: 999 },
  ];
  it('Einzel-, Teilmengen-Match (±0.10, Datum ±7 Tage) und «fehlt»', () => {
    const abgl = matchFakturen(fakturen, [
      { id: 'a', date: '2026-06-04', amountGross: 4257.97 },       // Einzel (2 Rp. Toleranz)
      { id: 'b', date: '2026-06-12', amountGross: 2892.24 },       // Teilmenge b+c (Datum 4 Tage vor Faktura)
      { id: 'c', date: '2026-06-12', amountGross: -736.39 },
    ]);
    expect(abgl.vorhanden).toBe(2);
    expect(abgl.gesamt).toBe(3);
    expect(abgl.matches[0].invoiceIds).toEqual(['a']);
    expect(abgl.matches[1].invoiceIds.sort()).toEqual(['b', 'c']);
    expect(abgl.matches[2].status).toBe('fehlt');
    expect(abgl.summeMonatsrechnung).toBeCloseTo(4258 + 2155.85 + 999, 2);
  });
  it('belegt jede Rechnung nur einmal', () => {
    const abgl = matchFakturen(
      [fakturen[0], { ...fakturen[0], nr: '1b' }],
      [{ id: 'a', date: '2026-06-04', amountGross: 4258 }],
    );
    expect(abgl.matches.filter(m => m.status === 'vorhanden')).toHaveLength(1);
  });
});

describe('findeNaheRechnung (Duplikat-Wache bei Anhang-Übernahme)', () => {
  const invoices = [
    { id: 'x', date: '2026-06-11', amountGross: 2892.20, reference: 'ANDERE-REF' },
    { id: 'y', date: '2026-06-12', amountGross: 500, reference: '479248314' },
  ];
  it('blockiert Beinahe-Treffer (±7 Tage, ±0.10) mit anderer Referenz', () => {
    const nahe = findeNaheRechnung(invoices, { lieferscheinNr: '479216837', datum: '2026-06-12', brutto: 2892.24 }, new Set());
    expect(nahe?.id).toBe('x');
  });
  it('erlaubt exakte Referenz+Datum-Treffer (idempotenter Upsert)', () => {
    const nahe = findeNaheRechnung(invoices, { lieferscheinNr: '479248314', datum: '2026-06-12', brutto: 500.05 }, new Set());
    expect(nahe).toBeNull();
  });
  it('ignoriert bereits einer Faktura zugeordnete Rechnungen', () => {
    const nahe = findeNaheRechnung(invoices, { lieferscheinNr: '479216837', datum: '2026-06-12', brutto: 2892.24 }, new Set(['x']));
    expect(nahe).toBeNull();
  });
  it('meldet nichts bei klar anderem Betrag', () => {
    const nahe = findeNaheRechnung(invoices, { lieferscheinNr: '479216837', datum: '2026-06-12', brutto: 111 }, new Set());
    expect(nahe).toBeNull();
  });
});

describe('kategorienGegenprobe & mitFsDefaults', () => {
  it('vergleicht erfasste Positionsnetto je Kategorie mit der Monatsrechnung', () => {
    const zeilenGp = kategorienGegenprobe(
      [
        { name: 'Bier', netto81: 100, netto26: 0, netto00: 0, nettoTotal: 100 },
        { name: 'Spirituosen', netto81: 50, netto26: 0, netto00: 0, nettoTotal: 50 },
        { name: 'POS-Promo Material', netto81: 0, netto26: 0, netto00: 0, nettoTotal: 0 },
      ],
      [
        { warengruppe: 'Bier', positionspreis: 60 },
        { warengruppe: 'Bier', positionspreis: 40.004 },
      ],
    );
    expect(zeilenGp).toHaveLength(2); // 0er-Kategorie ohne Erfassung ausgeblendet
    expect(zeilenGp[0].diff).toBe(0);
    expect(zeilenGp[1].erfasst).toBeNull(); // leer statt 0
  });
  it('FS-Standards ergänzen die Tabelle, gespeicherte Gruppen gewinnen', () => {
    const m = mitFsDefaults([{ gruppe: 'Bier', konto: '4444' }]);
    expect(m.find(r => r.gruppe === 'Bier')?.konto).toBe('4444');
    expect(m.find(r => r.gruppe === 'Spirituosen')?.konto).toBe('4040');
    expect(m).toHaveLength(1 + DEFAULT_FS_KATEGORIEN_MAPPING.length - 1);
  });
});

describe('sammelrechnungZuHistorie', () => {
  it('aggregiert Kategorien und Material (ohne Pfand)', () => {
    const h = sammelrechnungZuHistorie(parseFsSammelrechnung(SAMMEL));
    expect(h.sammelNr).toBe('87749870');
    expect(h.monat).toBe('2026-06');
    expect(h.fakturaAnzahl).toBe(2);
    expect(h.kategorien['Bier']).toBe(5259.12);
    expect(h.kategorien['POS-Promo Material']).toBeUndefined();
    expect(h.material['10028'].wert).toBeCloseTo(3923.92, 2);
    expect(h.material['10028'].letzterPreis).toBe(3.92);
  });
});

// ── Regression FS Juli (Oliv): alle Depot-Typen → Depot, nie 4030/4040/4050 ──
describe('FS Juli Kontrollwerte: Depot separat, Warenkosten ohne Leergut', () => {
  const kat2 = (name: string, n81: number, n26 = 0, n00 = 0): FsKategorieSumme =>
    ({ name, netto81: n81, netto26: n26, netto00: n00, nettoTotal: n81 + n26 + n00 });
  it('Depot 645.00, Warenkosten 15064.15, Betriebsmaterial 465.00 → 4701', () => {
    const { splits, offen } = kontoSplitsAusFsKategorien([
      kat2('Bier', 4538.00),
      kat2('Spirituosen', 2789.30),
      kat2('Mineralwasser', 0, 5000.00),
      kat2('Andere alk. freie Getränke', 0, 2736.85),
      kat2('Leergut', 0, 0, 400.00),
      kat2('Gebinde', 0, 0, 145.00),      // Harasse/Gebinde → Depot
      kat2('Ladungsträger', 0, 0, 100.00),
      kat2('Andere Güter', 465.00),        // Betriebsmaterial → 4701
    ], []);
    expect(offen).toEqual([]);
    const m = Object.fromEntries(splits.map(s2 => [s2.warenkonto, s2.amountNet]));
    expect(m['4800']).toBeCloseTo(645.00, 2);
    expect(m['4701']).toBeCloseTo(465.00, 2);
    const waren = (m['4030'] ?? 0) + (m['4040'] ?? 0) + (m['4050'] ?? 0);
    expect(waren).toBeCloseTo(15064.15, 2);
    // Kein Depot-Anteil auf den Warenkonten:
    expect(m['4030']).toBeCloseTo(4538.00, 2);
    expect(m['4040']).toBeCloseTo(2789.30, 2);
    expect(m['4050']).toBeCloseTo(7736.85, 2);
  });
  it('gemischt-sätzige Depot-Kategorie (Name zählt, nicht nur 0 %)', () => {
    const { splits } = kontoSplitsAusFsKategorien([kat2('Harasse', 10, 0, 90)], []);
    expect(splits).toMatchObject([{
      warenkonto: '4800', amountNet: 100, amountGross: expect.any(Number),
      vatClasses: [
        { vatRate: 8.1, amountNet: 10, amountVat: 0.81, amountGross: 10.81 },
        { vatRate: 0, amountNet: 90, amountVat: 0, amountGross: 90 },
      ],
    }]);
  });
});
