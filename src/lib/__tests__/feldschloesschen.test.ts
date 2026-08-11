/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import {
  parseChf, parseDatumCH, detectFsPdfTyp, istFeldschloesschenPdf,
  parseFsLieferschein, parseFsSammelrechnung, fsKategorie,
  fsLieferscheinAlsRechnung, fsAnhangAlsRechnung, matchFakturen,
  kategorienGegenprobe, mitFsDefaults, sammelrechnungZuHistorie, findeNaheRechnung,
  kontoSplitsAusFsKategorien,
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
    expect(kats.find(k => k.name === 'Zu-/Abschläge')?.nettoTotal).toBe(15);
    // Endbetrag-/MwSt-/Total-Zeilen werden NICHT als Kategorien gesammelt
    expect(kats.some(k => /endbetrag|total|mwst/i.test(k.name))).toBe(false);
    // globale Kategorien bleiben unberührt (keine Pollution)
    expect(s.kategorien.find(k => k.name === 'Bier')?.nettoTotal).toBe(5259.12);
    // «Endbetrag CHF» der Faktura bleibt korrekt geparst
    expect(s.anhangLieferscheine[0].fakturaEndbetrag).toBe(4258);
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
    expect(m['Depot']).toBe(185.4);
    // Brutto: 8.1%- und 2.6%-Anteile hochgerechnet, 0% unverändert
    expect(splits.find(s2 => s2.warenkonto === 'Depot')?.amountGross).toBe(185.4);
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
  it('eigenes Mapping übersteuert die Defaults', () => {
    const { splits } = kontoSplitsAusFsKategorien([kat('Bier', 100)], [{ gruppe: 'Bier', konto: '4099' }]);
    expect(splits[0].warenkonto).toBe('4099');
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
