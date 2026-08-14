// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  parseManuelleBuchungen, parseManuellesDatum, parseManuellerBetrag,
  belegKey, summenJeMandant, istManuellErsetzbar,
} from '../manuelle-buchungen-import';

const KOPF = 'Mandant;Lieferant;Datum;BelegNr;Kategorie;Konto;Netto;MwSt%;Bemerkung';

describe('parseManuelleBuchungen', () => {
  it('4-Zeilen-Block: alle Zeilen mit berechneter MwSt/Brutto + Summen je Mandant', () => {
    const input = [
      KOPF,
      'Oliv;Metzgerei Spahni;05.08.2026;Q-1001;Food;4060;164.50;2.6;Barausgabe Quittung',
      'Oliv;Prodega;06.08.2026;Q-1001;Beverage;4020;100.00;8.1;Lieferschein',
      'Beaulieu;Fideco;07.08.2026;7746120;Food;4060;596.88;2.6;Rechnung',
      'Beaulieu;Pistor;08.08.2026;R-77;Sonstiges;4701;50.00;0;Gebühren',
    ].join('\n');
    const { zeilen, fehler } = parseManuelleBuchungen(input);
    expect(fehler).toEqual([]);
    expect(zeilen).toHaveLength(4);
    expect(zeilen.every(z => z.fehler.length === 0)).toBe(true);
    expect(zeilen[0]).toMatchObject({
      mandant: 'oliv', lieferant: 'Metzgerei Spahni', datum: '2026-08-05',
      belegNr: 'Q-1001', kategorie: 'Food', konto: '4060',
      netto: 164.5, mwstSatz: 2.6, mwst: 4.28, brutto: 168.78,
      bemerkung: 'Barausgabe Quittung',
    });
    expect(zeilen[1].mwst).toBe(8.1);
    expect(zeilen[3]).toMatchObject({ mwstSatz: 0, mwst: 0, brutto: 50 });
    const summen = summenJeMandant(zeilen);
    expect(summen.oliv).toMatchObject({ netto: 264.5, anzahl: 2 });
    expect(summen.beaulieu).toMatchObject({ netto: 646.88, anzahl: 2 });
  });

  it('toleriert Tab/Komma als Trenner, Leerzeilen und #-Kommentare', () => {
    const tab = [KOPF.replace(/;/g, '\t'), '', '# Kommentar',
      'Oliv\tSpahni\t05.08.26\tQ-1\tFood\t4060\t1\'234.50\t2.6\tTest'].join('\n');
    const t = parseManuelleBuchungen(tab);
    expect(t.zeilen).toHaveLength(1);
    expect(t.zeilen[0]).toMatchObject({ netto: 1234.5, datum: '2026-08-05', fehler: [] });

    const komma = [KOPF.replace(/;/g, ','),
      'Beaulieu,Fideco,07.08.2026,774,Food,4060,10.00,2.6,x'].join('\n');
    expect(parseManuelleBuchungen(komma).zeilen[0].mandant).toBe('beaulieu');
  });

  it('fremder/unbekannter Mandant, ungültiges Datum und falscher MwSt-Satz werden markiert (nie still gebucht/geraten)', () => {
    const input = [KOPF,
      'Zürich;X;05.08.2026;1;Food;4060;10;2.6;',
      'Oliv;X;31.02.2026;2;Food;4060;10;2.6;',
      'Oliv;X;05.08.2026;3;Food;4060;10;7.7;',
      'Oliv;;05.08.2026;4;Food;4060;abc;2.6;',
    ].join('\n');
    const { zeilen } = parseManuelleBuchungen(input);
    expect(zeilen[0].mandant).toBeNull();
    expect(zeilen[0].fehler[0]).toMatch(/Mandant/);
    expect(zeilen[1].datum).toBeNull();
    expect(zeilen[2].fehler.join()).toMatch(/MwSt-Satz/);
    expect(zeilen[3].fehler.join()).toMatch(/Lieferant fehlt/);
    expect(zeilen[3].fehler.join()).toMatch(/Netto/);
    expect(summenJeMandant(zeilen)).toEqual({});
  });

  it('fehlende/falsche Kopfzeile ⇒ Struktur-Fehler, keine Zeilen', () => {
    const r = parseManuelleBuchungen('Oliv;X;05.08.2026;1;Food;4060;10;2.6;');
    expect(r.fehler[0]).toMatch(/Kopfzeile/);
    expect(r.zeilen).toEqual([]);
  });

  it('belegKey gruppiert case-insensitiv je Mandant', () => {
    expect(belegKey('oliv', ' Spahni ', 'Q-1')).toBe(belegKey('oliv', 'spahni', 'Q-1'));
    expect(belegKey('oliv', 'Spahni', 'Q-1')).not.toBe(belegKey('beaulieu', 'Spahni', 'Q-1'));
  });
});

describe('parseManuellesDatum / parseManuellerBetrag', () => {
  it('Datum: DD.MM.YY → 20YY, Kalender-Gegenprobe', () => {
    expect(parseManuellesDatum('3.08.26')).toBe('2026-08-03');
    expect(parseManuellesDatum('29.02.2026')).toBeNull(); // kein Schaltjahr
    expect(parseManuellesDatum('2026-08-03')).toBeNull();
  });
  it('Betrag: Apostroph/Punkt-Tausender, Dezimal-Komma, CHF-Präfix', () => {
    expect(parseManuellerBetrag("1'234.50")).toBe(1234.5);
    expect(parseManuellerBetrag('1.234.567,89')).toBe(1234567.89);
    expect(parseManuellerBetrag('1234,50')).toBe(1234.5);
    expect(parseManuellerBetrag('CHF 164.50')).toBe(164.5);
    expect(parseManuellerBetrag('')).toBeNull();
    expect(parseManuellerBetrag('abc')).toBeNull();
  });
  it('Betrag: eindeutige Punkt-Gruppierung = Tausender; Mehrdeutiges/Überpräzision abgelehnt', () => {
    expect(parseManuellerBetrag('1.234')).toBe(1234);        // Punkt-Gruppierung
    expect(parseManuellerBetrag('1.234.567')).toBe(1234567); // mehrfache Gruppen
    expect(parseManuellerBetrag('12.345.678')).toBe(12345678);
    expect(parseManuellerBetrag('164.50')).toBe(164.5);      // Dezimalpunkt (2 Stellen)
    expect(parseManuellerBetrag('-1.234')).toBe(-1234);
    expect(parseManuellerBetrag('1.2345')).toBeNull();       // weder Gruppe noch ≤2 Dezimalen
    expect(parseManuellerBetrag('1234.5678')).toBeNull();
    expect(parseManuellerBetrag('1234,505')).toBeNull();     // >2 Nachkommastellen
    expect(parseManuellerBetrag('1234.56.7')).toBeNull();
  });
});

describe('istManuellErsetzbar (Schutz bestehender Buchungen)', () => {
  it('final/Monatsrechnung/markt sind geschützt, provisorische ersetzbar', () => {
    expect(istManuellErsetzbar({})).toBe(true);
    expect(istManuellErsetzbar({ quelle: 'auftragsbestaetigung' })).toBe(true);
    expect(istManuellErsetzbar({ final: true })).toBe(false);
    expect(istManuellErsetzbar({ quelle: 'monatsrechnung' })).toBe(false);
    expect(istManuellErsetzbar({ markt: 'Bern' })).toBe(false);
  });
});
