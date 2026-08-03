// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  parseTransgourmetCsv, kontoFuerWarengruppe, kontoSplitsFuerRechnung,
  artikelKey, berechnePreisAenderungen, aktualisierePreisHistorie,
  normalizePreisHistorie, normalizePreisSchwelle, DEFAULT_PREIS_SCHWELLE,
  type ParsedCsvRechnung, type PreisHistorie,
} from '@/lib/waren-positionen';

const HEADER = 'Kundennummer;Rechnungsnummer;Datum;Markt;Warengruppe;Position;Art. Nr.;Menge;Gewicht;Einheit;Artikelbezeichnung;Preis;Positionspreis;MwSt;EAN;Pfand;Aktion;MwSt. Code;Detailrichtpreis;';
const zeile = (nr: string, datum: string, grp: string, art: string, bez: string, preis: number, pos: number, mwst: number, code: number) =>
  `90032154;${nr};${datum};BGH;${grp};10;${art};1;;kg;${bez};${preis};${pos};${mwst};123;0;0;${code};;`;

describe('parseTransgourmetCsv', () => {
  it('parst, gruppiert pro Rechnungsnummer und summiert netto/mwst', () => {
    const csv = [HEADER,
      zeile('R1', '2026-07-31', 'Metzgerei', '002066', 'Entrecote', 45.05, 265.16, 6.89, 1),
      zeile('R1', '2026-07-31', 'Früchte + Gemüse', '000079', 'Ifco LiftLock', 3.2, 6.4, 0, 0),
      zeile('R2', '2026-07-30', 'Food', '512610', 'Petersilie', 5.32, 21.28, 0.55, 1),
    ].join('\n');
    const res = parseTransgourmetCsv(csv);
    expect(res.failureReason).toBeNull();
    expect(res.rechnungen).toHaveLength(2);
    const r1 = res.rechnungen.find(r => r.rechnungsNr === 'R1')!;
    expect(r1.positionen).toHaveLength(2);
    expect(r1.nettoTotal).toBeCloseTo(271.56, 2);
    expect(r1.bruttoTotal).toBeCloseTo(278.45, 2);
    expect(res.debug.zeilenVerwendet).toBe(3);
  });

  it('fremdes Format → failureReason mit echten Spalten, nie raten', () => {
    const res = parseTransgourmetCsv('Foo;Bar\n1;2');
    expect(res.rechnungen).toHaveLength(0);
    expect(res.failureReason).toContain('fehlende Spalten');
    expect(res.debug.spalten).toEqual(['Foo', 'Bar']);
  });

  it('ungültige Zeilen (ohne Datum/Nr.) werden verworfen und gezählt', () => {
    const csv = [HEADER, zeile('R1', 'kein-datum', 'Food', '1', 'X', 1, 1, 0, 1), zeile('R1', '2026-07-01', 'Food', '1', 'X', 1, 1, 0, 1)].join('\n');
    const res = parseTransgourmetCsv(csv);
    expect(res.debug.zeilenVerworfen).toBe(1);
    expect(res.rechnungen[0].positionen).toHaveLength(1);
  });
});

describe('docKey: gleiche Rechnungsnummer an verschiedenen Daten', () => {
  it('bleibt als SEPARATE Dokumente erhalten (Portal verwendet Nummern wieder)', () => {
    const csv = [HEADER,
      zeile('58', '2026-02-21', 'Food', '1', 'A', 10, 100, 2.6, 1),
      zeile('58', '2026-07-15', 'Food', '1', 'A', 12, 120, 3.1, 1),
    ].join('\n');
    const res = parseTransgourmetCsv(csv);
    expect(res.rechnungen).toHaveLength(2);
    expect(res.rechnungen.map(r => r.docKey)).toEqual(['58|2026-02-21', '58|2026-07-15']);
    // Historie: getrennte Dokumente vergleichen normal (kein Re-Import-Skip):
    let h = aktualisierePreisHistorie({}, [res.rechnungen[0]], 'TG');
    const aen = berechnePreisAenderungen(res.rechnungen[1], 'TG', h);
    expect(aen).toHaveLength(1); // 10 → 12 = +20 %
    expect(aen[0].stark).toBe(true);
    h = aktualisierePreisHistorie(h, [res.rechnungen[1]], 'TG');
    expect(h['tg|nr:1']).toMatchObject({ preis: 12, rechnungsNr: '58|2026-07-15' });
    // Echter Re-Import desselben Dokuments → kein Vergleich:
    expect(berechnePreisAenderungen(res.rechnungen[1], 'TG', h)).toHaveLength(0);
  });
});

describe('Warengruppe → Konto', () => {
  it('mappt bekannte Gruppen, Default 4000', () => {
    expect(kontoFuerWarengruppe('Früchte + Gemüse')).toBe('4000');
    expect(kontoFuerWarengruppe('Nonfood')).toBe('4060');
    expect(kontoFuerWarengruppe('Getränke')).toBe('4020');
    expect(kontoFuerWarengruppe('Tiefkühlprodukte')).toBe('4030');
    expect(kontoFuerWarengruppe('Reinigung')).toBe('4050');
  });

  it('kontoSplitsFuerRechnung aggregiert pro Konto', () => {
    const csv = [HEADER,
      zeile('R1', '2026-07-01', 'Food', '1', 'A', 10, 100, 2.6, 1),
      zeile('R1', '2026-07-01', 'Nonfood', '2', 'B', 5, 50, 4.05, 2),
      zeile('R1', '2026-07-01', 'Metzgerei', '3', 'C', 20, 200, 5.2, 1),
    ].join('\n');
    const r = parseTransgourmetCsv(csv).rechnungen[0];
    const splits = kontoSplitsFuerRechnung(r);
    expect(splits).toHaveLength(2);
    expect(splits[0]).toMatchObject({ warenkonto: '4000', amountNet: 300 });
    expect(splits[1]).toMatchObject({ warenkonto: '4060', amountNet: 50 });
  });
});

describe('artikelKey', () => {
  it('Art.-Nr. vor Name; ohne beides null (kein Fehlalarm)', () => {
    expect(artikelKey('TG', { artNr: '002066', bezeichnung: 'Entrecote' })).toBe('tg|nr:002066');
    expect(artikelKey('TG', { artNr: '', bezeichnung: '  Entrecote  Rind ' })).toBe('tg|name:entrecote rind');
    expect(artikelKey('TG', { artNr: '', bezeichnung: '  ' })).toBeNull();
  });
});

describe('berechnePreisAenderungen', () => {
  const rechnung = (nr: string, datum: string, preis: number, code = 1): ParsedCsvRechnung =>
    parseTransgourmetCsv([HEADER, zeile(nr, datum, 'Metzgerei', '002066', 'Entrecote', preis, preis, 0.5, code)].join('\n')).rechnungen[0];
  const hist: PreisHistorie = { 'tg|nr:002066': { preis: 45.05, datum: '2026-06-15', name: 'Entrecote', rechnungsNr: 'ALT' } };

  it('erzeugt Hinweis mit alt/neu, Δ abs und %, seit-Datum; ≥ Schwelle = stark', () => {
    const aen = berechnePreisAenderungen(rechnung('R9', '2026-07-31', 50.0), 'TG', hist);
    expect(aen).toHaveLength(1);
    expect(aen[0]).toMatchObject({ alt: 45.05, neu: 50, erhoehung: true, stark: true, seit: '2026-06-15' });
    expect(aen[0].diffPct).toBeCloseTo(11, 0);
  });

  it('kleine Änderung unter Mindest-CHF (Rundung) → kein Hinweis', () => {
    expect(berechnePreisAenderungen(rechnung('R9', '2026-07-31', 45.15), 'TG', hist)).toHaveLength(0);
  });

  it('unter %-Schwelle aber ≥ min CHF → dezenter Hinweis (stark=false)', () => {
    const aen = berechnePreisAenderungen(rechnung('R9', '2026-07-31', 46.0), 'TG', hist);
    expect(aen).toHaveLength(1);
    expect(aen[0].stark).toBe(false);
  });

  it('Pfand (MwSt-Code 0) ausgenommen; Re-Import derselben Rechnung vergleicht nicht', () => {
    expect(berechnePreisAenderungen(rechnung('R9', '2026-07-31', 99, 0), 'TG', hist)).toHaveLength(0);
    const histSelbe: PreisHistorie = { 'tg|nr:002066': { ...hist['tg|nr:002066'], rechnungsNr: 'R9|2026-07-31' } };
    expect(berechnePreisAenderungen(rechnung('R9', '2026-07-31', 99), 'TG', histSelbe)).toHaveLength(0);
  });

  it('alter Preis 0 → diffPct null (nie durch 0 teilen)', () => {
    const h: PreisHistorie = { 'tg|nr:002066': { preis: 0.0, datum: '2026-06-15', name: 'E', rechnungsNr: 'ALT' } };
    // normalize wirft 0-Preise raus — aber direkter Aufruf darf nicht crashen:
    const aen = berechnePreisAenderungen(rechnung('R9', '2026-07-31', 5), 'TG', h);
    expect(aen[0]?.diffPct ?? null).toBeNull();
  });
});

describe('aktualisierePreisHistorie', () => {
  const r = (nr: string, datum: string, preis: number): ParsedCsvRechnung =>
    parseTransgourmetCsv([HEADER, zeile(nr, datum, 'Food', '111', 'Milch', preis, preis, 0.1, 1)].join('\n')).rechnungen[0];

  it('neueres Datum gewinnt; ältere Datei überschreibt nicht', () => {
    let h = aktualisierePreisHistorie({}, [r('A', '2026-07-01', 2.0)], 'TG');
    h = aktualisierePreisHistorie(h, [r('B', '2026-06-01', 1.5)], 'TG'); // älter → ignoriert
    expect(h['tg|nr:111'].preis).toBe(2.0);
    h = aktualisierePreisHistorie(h, [r('C', '2026-08-01', 2.5)], 'TG');
    expect(h['tg|nr:111'].preis).toBe(2.5);
  });

  it('Re-Import derselben Rechnung ERSETZT den Eintrag (verfälscht nicht)', () => {
    let h = aktualisierePreisHistorie({}, [r('A', '2026-07-01', 2.0)], 'TG');
    h = aktualisierePreisHistorie(h, [r('A', '2026-07-01', 2.2)], 'TG'); // korrigierte Datei
    expect(h['tg|nr:111']).toMatchObject({ preis: 2.2, rechnungsNr: 'A|2026-07-01' });
  });
});

describe('normalize', () => {
  it('PreisHistorie tolerant (kaputte/0-Einträge raus), Schwelle mit Defaults', () => {
    expect(normalizePreisHistorie({ a: { preis: 2, datum: 'd', name: 'n', rechnungsNr: 'r' }, b: { preis: 0 }, c: 'x' }))
      .toEqual({ a: { preis: 2, datum: 'd', name: 'n', rechnungsNr: 'r' } });
    expect(normalizePreisHistorie(null)).toEqual({});
    expect(normalizePreisSchwelle({})).toEqual(DEFAULT_PREIS_SCHWELLE);
    expect(normalizePreisSchwelle({ pct: 5, minChf: 0.5 })).toEqual({ pct: 5, minChf: 0.5 });
    expect(normalizePreisSchwelle({ pct: -1 })).toEqual(DEFAULT_PREIS_SCHWELLE);
  });
});
