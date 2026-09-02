// @vitest-environment node
/**
 * Tests waren-monatsabgleich: Lieferschein→Monatsrechnung Abgleich & Ersetzen.
 * Kernszenario = die frühere Terravigna-Verdopplung (Monatsrechnung 7'013.37
 * + 9 Lieferscheine 7'035.93): nach «übernehmen» ist Σ = Monatsrechnung.
 */
import { describe, it, expect } from 'vitest';
import {
  istProvisorischerLieferschein, baueMonatsAbgleich, wendeMonatsrechnungAn,
  markiereDifferenzOffen, lieferantStatus, istErsetzt, zaehlendeEintraege,
  gruppiereNachKanonischemLieferantUndMonat, akzeptiereMonatsrechnung,
  kanonischerWarenLieferant,
  gleicherWarenLieferant, normalisiereMwstNr,
  hatZaehlendeLieferantenReferenz, kanonischerLieferantMonatKey,
  loeseEindeutigenLiefermonatAuf,
} from '../waren-monatsabgleich';
import type { InvoiceEntry } from '../waren-db';

let seq = 0;
function inv(p: Partial<InvoiceEntry>): InvoiceEntry {
  return {
    id: p.id ?? `e${++seq}`, date: '2026-07-10', supplierName: 'Terravigna',
    amountGross: 108.1, amountNet: 100, vatIncluded: true, vatRate: 8.1,
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
    ...p,
  } as InvoiceEntry;
}
const NOW = '2026-08-10T00:00:00Z';
const matchtTerra = (n: string) => n.startsWith('Terravigna');

describe('istProvisorischerLieferschein', () => {
  it('ohne quelle / AB = provisorisch; Übernahmen & finale nicht', () => {
    expect(istProvisorischerLieferschein(inv({}))).toBe(true);
    expect(istProvisorischerLieferschein(inv({ quelle: 'auftragsbestaetigung' }))).toBe(true);
    expect(istProvisorischerLieferschein(inv({ quelle: 'kreditoren_uebernahme' }))).toBe(false);
    expect(istProvisorischerLieferschein(inv({ quelle: 'fibu_uebernahme' }))).toBe(false);
    expect(istProvisorischerLieferschein(inv({ quelle: 'monatsrechnung' }))).toBe(false);
    expect(istProvisorischerLieferschein(inv({ final: true }))).toBe(false);
    expect(istProvisorischerLieferschein(inv({ superseded: true }))).toBe(false);
  });
});

describe('baueMonatsAbgleich', () => {
  it('Σ, Differenz und %; fremde Lieferanten/Monate/Quellen bleiben draussen', () => {
    const bestand = [
      inv({ id: 'l1', amountNet: 4000, amountGross: 4324 }),
      inv({ id: 'l2', amountNet: 3035.93, amountGross: 3281.84 }),
      inv({ id: 'x1', supplierName: 'Caporaso' }),
      inv({ id: 'x2', date: '2026-06-30' }),
      inv({ id: 'x3', quelle: 'kreditoren_uebernahme' }),
    ];
    const v = baueMonatsAbgleich({ bestand, monat: '2026-07', totalNet: 7013.37, totalGross: 7581.45, matcht: matchtTerra });
    expect(v.lieferscheine.map(e => e.id)).toEqual(['l1', 'l2']);
    expect(v.sigmaNet).toBe(7035.93);
    expect(v.differenzNet).toBe(-22.56);
    expect(v.differenzPct).toBeCloseTo(-0.3206, 3);
  });
  it('keine Lieferscheine → Σ 0, differenzPct null (nie ÷0)', () => {
    const v = baueMonatsAbgleich({ bestand: [], monat: '2026-07', totalNet: 100, totalGross: 108, matcht: () => true });
    expect(v.sigmaNet).toBe(0);
    expect(v.differenzPct).toBeNull();
  });
});

describe('wendeMonatsrechnungAn', () => {
  const bestand = [
    inv({ id: 'l1', amountNet: 4000, amountGross: 4324 }),
    inv({ id: 'l2', amountNet: 3035.93, amountGross: 3281.84, note: 'LS 287229' }),
    inv({ id: 'fremd', supplierName: 'Caporaso' }),
  ];
  const vorschau = baueMonatsAbgleich({ bestand, monat: '2026-07', totalNet: 7013.37, totalGross: 7581.45, matcht: matchtTerra });
  const rechnung = { datum: '2026-07-31', referenz: '211363', totalNet: 7013.37, totalGross: 7581.45, warenkonto: '4020' };

  it('anteilig: Σ exakt = Monatsrechnung, Daten bleiben, abgeglichen+final, kein Zusatz-Eintrag', () => {
    const out = wendeMonatsrechnungAn({ bestand, vorschau, rechnung, modus: 'anteilig', now: NOW });
    expect(out).toHaveLength(3); // NICHT addiert — ersetzt
    const l = out.filter(e => e.id === 'l1' || e.id === 'l2');
    expect(l.reduce((s, e) => s + e.amountNet, 0)).toBeCloseTo(7013.37, 2);
    expect(l.reduce((s, e) => s + e.amountGross, 0)).toBeCloseTo(7581.45, 2);
    expect(l.every(e => e.final === true && e.abgleichStatus === 'abgeglichen')).toBe(true);
    expect(l.map(e => e.date)).toEqual(['2026-07-10', '2026-07-10']); // Lieferwochen bleiben
    expect(out.find(e => e.id === 'l2')!.note).toContain('Monatsabgleich Rg. 211363');
    expect(out.find(e => e.id === 'fremd')!.amountNet).toBe(100); // unberührt
  });

  it('rechnungsdatum: Lieferscheine unverändert + Differenz-Eintrag am Rechnungsdatum', () => {
    const out = wendeMonatsrechnungAn({ bestand, vorschau, rechnung, modus: 'rechnungsdatum', now: NOW });
    expect(out).toHaveLength(4);
    const diff = out.find(e => e.id.startsWith('mabgl_'))!;
    expect(diff.date).toBe('2026-07-31');
    expect(diff.amountNet).toBe(-22.56);
    expect(diff.warenkonto).toBe('4020');
    expect(diff.final).toBe(true);
    expect(out.find(e => e.id === 'l1')!.amountNet).toBe(4000);
    expect(out.filter(e => matchtTerra(e.supplierName)).reduce((s, e) => s + e.amountNet, 0))
      .toBeCloseTo(7013.37, 2);
  });

  it('rechnungsdatum ohne Differenz: kein Korrektur-Eintrag', () => {
    const v0 = baueMonatsAbgleich({ bestand, monat: '2026-07', totalNet: 7035.93, totalGross: 7605.84, matcht: matchtTerra });
    const out = wendeMonatsrechnungAn({
      bestand, vorschau: v0, modus: 'rechnungsdatum', now: NOW,
      rechnung: { ...rechnung, totalNet: 7035.93, totalGross: 7605.84 },
    });
    expect(out).toHaveLength(3);
  });

  it('keine Lieferscheine → Bestand unverändert (Aufrufer speichert regulär)', () => {
    const leer = baueMonatsAbgleich({ bestand, monat: '2026-07', totalNet: 500, totalGross: 540, matcht: () => false });
    expect(wendeMonatsrechnungAn({ bestand, vorschau: leer, rechnung, modus: 'anteilig', now: NOW })).toHaveLength(3);
  });
});

describe('Manuelle Buchungen (CSV/Text) im Dual-Modell', () => {
  it('manuell erfasste Belege (id manuell-*, kein quelle/final) werden wie PDF-Lieferscheine abgeglichen & ersetzt', () => {
    // Struktur exakt wie sie ManuelleBuchungenImport schreibt.
    const manuell = (id: string, net: number) => inv({
      id: `manuell-${id}`, supplierName: 'Fideco', date: '2026-08-05',
      amountNet: net, amountGross: Math.round(net * 1.081 * 100) / 100,
      vatIncluded: false, reference: `77460${id}`,
      warenkonto: '4060', kategorie: 'Food',
    });
    const bestand = [manuell('26', 200), manuell('27', 167.7)];
    const matchtFideco = (n: string) => n.trim().toLowerCase() === 'fideco';

    expect(bestand.every(istProvisorischerLieferschein)).toBe(true);
    const v = baueMonatsAbgleich({ bestand, monat: '2026-08', totalNet: 380, totalGross: 410.78, matcht: matchtFideco });
    expect(v.lieferscheine).toHaveLength(2);
    expect(v.sigmaNet).toBe(367.7);
    expect(v.differenzNet).toBe(12.3); // Differenz sichtbar, kein Doppelzählen

    const out = wendeMonatsrechnungAn({
      bestand, vorschau: v, modus: 'anteilig', now: NOW,
      rechnung: { datum: '2026-08-31', referenz: 'MR-08', totalNet: 380, totalGross: 410.78 },
    });
    expect(out).toHaveLength(2); // ersetzt, NIE addiert
    expect(out.every(e => e.final === true && e.abgleichStatus === 'abgeglichen')).toBe(true);
    expect(Math.round(out.reduce((s, e) => s + e.amountNet, 0) * 100) / 100).toBe(380);
    // Beleg-Nr & Konto bleiben für Rückverfolgung/WKQ erhalten.
    expect(out.map(e => e.reference)).toEqual(['7746026', '7746027']);
    expect(out.every(e => e.warenkonto === '4060')).toBe(true);
  });
});

describe('markiereDifferenzOffen / lieferantStatus', () => {
  it('markiert nur die Lieferscheine; Status-Priorität differenz_offen > provisorisch > abgeglichen', () => {
    const bestand = [inv({ id: 'l1' }), inv({ id: 'fremd', supplierName: 'Caporaso' })];
    const out = markiereDifferenzOffen(bestand, [bestand[0]], NOW);
    expect(out[0].abgleichStatus).toBe('differenz_offen');
    expect(out[1].abgleichStatus).toBeUndefined();
    expect(out[0].amountNet).toBe(100); // Beträge unangetastet
    expect(lieferantStatus(out)).toBe('differenz_offen');
    expect(lieferantStatus([inv({})])).toBe('provisorisch');
    expect(lieferantStatus([inv({ final: true, abgleichStatus: 'abgeglichen' })])).toBe('abgeglichen');
    expect(lieferantStatus([inv({ quelle: 'kreditoren_uebernahme' })])).toBe('abgeglichen');
  });
});

describe('historienerhaltender Monatsabgleich', () => {
  const canonicalize = kanonischerWarenLieferant;

  it('ersetzt nur Lieferbelege im Liefermonat, bewahrt deren Historie und zählt die MR genau einmal', () => {
    const ls = inv({
      id: 'ls-july', supplierName: 'WKQ AG', date: '2026-07-31',
      amountNet: 120, amountGross: 129.72, reference: 'LS-7', note: 'Original-LS',
    });
    const june = inv({ id: 'ls-june', supplierName: 'Fideco Schweiz', date: '2026-06-30', amountNet: 90 });
    // Eine finale Einzelrechnung ist kein provisorischer Lieferschein und zählt weiter.
    const einzel = inv({ id: 'einzel', supplierName: 'Fideco', date: '2026-07-15', amountNet: 40, final: true });
    const monthly = inv({
      id: 'mr-july', supplierName: 'Fideco', date: '2026-08-03',
      amountNet: 125, amountGross: 135.13, reference: 'MR-2026-07',
    });
    const out = akzeptiereMonatsrechnung({
      bestand: [ls, june, einzel], liefermonat: '2026-07', monatsrechnung: monthly,
      canonicalize, now: NOW,
    });

    const historical = out.find(e => e.id === 'ls-july')!;
    expect(historical.date).toBe('2026-07-31');
    expect(historical.amountNet).toBe(120);
    expect(historical.amountGross).toBe(129.72);
    expect(historical.note).toBe('Original-LS');
    expect(historical.supersededById).toBe('mr-july');
    expect(historical.supersededByReference).toBe('MR-2026-07');
    expect(istErsetzt(historical)).toBe(true);
    expect(out.find(e => e.id === 'ls-june')!.superseded).toBeUndefined(); // month boundary
    expect(out.find(e => e.id === 'einzel')!.superseded).toBeUndefined();

    const counting = zaehlendeEintraege(out);
    expect(counting.map(e => e.id)).toEqual(['ls-june', 'einzel', 'mr-july']);
    expect(counting.filter(e => e.id === 'mr-july')).toHaveLength(1);
    expect(counting.reduce((sum, e) => sum + e.amountNet, 0)).toBe(255);
    expect(out.find(e => e.id === 'mr-july')!.quelle).toBe('monatsrechnung');
    expect(out.find(e => e.id === 'mr-july')!.final).toBe(true);
  });

  it('groups only counting entries by injected canonical supplier and delivery month', () => {
    const entries = [
      inv({ id: 'old', supplierName: 'WKQ AG', date: '2026-07-01', superseded: true }),
      inv({ id: 'alias', supplierName: 'Fideco Schweiz', date: '2026-07-31' }),
      inv({ id: 'next', supplierName: 'Fideco', date: '2026-08-01' }),
      // Old persisted entries have no new fields and must remain countable.
      inv({ id: 'legacy', supplierName: 'Fideco', date: '2026-07-10' }),
    ];
    const groups = gruppiereNachKanonischemLieferantUndMonat(entries, canonicalize);
    expect([...groups.values()].map(g => [g.lieferant, g.monat, g.entries.map(e => e.id)])).toEqual([
      ['fideco', '2026-07', ['alias', 'legacy']],
      ['fideco', '2026-08', ['next']],
    ]);
  });

  it('recognizes lineage-only historical records as superseded for forward-compatible reads', () => {
    expect(istErsetzt(inv({ supersededById: 'mr-old' }))).toBe(true);
    expect(istErsetzt(inv({ supersededByReference: 'MR-old' }))).toBe(true);
    expect(zaehlendeEintraege([inv({ id: 'legacy' }), inv({ id: 'replaced', superseded: true })])
      .map(e => e.id)).toEqual(['legacy']);
  });

  it('bildet für WKQ und Fideco denselben Monats-Gruppenschlüssel', () => {
    expect(kanonischerLieferantMonatKey('2026-07', 'WKQ AG'))
      .toBe(kanonischerLieferantMonatKey('2026-07', 'Fideco Schweiz AG'));
    expect(kanonischerLieferantMonatKey('2026-08', 'Fideco'))
      .not.toBe(kanonischerLieferantMonatKey('2026-07', 'Fideco'));
  });

  it('normalisiert Rechtsformen, Klammerzusätze und bekannte Lieferantenvarianten', () => {
    expect(kanonischerWarenLieferant('  Gourmador   (frigemo) SA ')).toBe('gourmador');
    expect(kanonischerWarenLieferant('GOURMADOR')).toBe('gourmador');
    expect(kanonischerWarenLieferant('Ambro Food SA')).toBe('ambro food');
    expect(kanonischerWarenLieferant('Metzgerei Spahni GmbH')).toBe('spahni');
    expect(kanonischerWarenLieferant('Spahni')).toBe('spahni');
  });

  it('vergleicht vorrangig über MWST-Nr und fällt für Legacy-Einträge auf Namen zurück', () => {
    expect(normalisiereMwstNr('CHE-123.456.789 MWST')).toBe('123456789');
    expect(gleicherWarenLieferant(
      { supplierName: 'Altname', supplierVatId: 'CHE-123.456.789' },
      { supplierName: 'Neuer Name AG', supplierVatId: '123456789' },
    )).toBe(true);
    expect(gleicherWarenLieferant(
      { supplierName: 'Gourmador', supplierVatId: '123456789' },
      { supplierName: 'Gourmador (frigemo)', supplierVatId: '987654321' },
    )).toBe(false);
    expect(gleicherWarenLieferant(
      { supplierName: 'Gourmador' },
      { supplierName: 'Gourmador (frigemo)', supplierVatId: '123456789' },
    )).toBe(true);
  });

  it('ersetzt provisorische Gourmador-Varianten durch genau eine Monatsrechnung', () => {
    const provisional = inv({
      id: 'ls-gourmador', supplierName: 'Gourmador', date: '2026-08-12',
      amountNet: 3004.04, amountGross: 3082.15,
    });
    const monthly = inv({
      id: 'mr-gourmador', supplierName: 'Gourmador (frigemo)', date: '2026-08-31',
      amountNet: 3004.04, amountGross: 3082.15,
    });
    const out = akzeptiereMonatsrechnung({
      bestand: [provisional], liefermonat: '2026-08', monatsrechnung: monthly,
      canonicalize, now: NOW,
    });
    expect(out.find(e => e.id === 'ls-gourmador')?.superseded).toBe(true);
    expect(zaehlendeEintraege(out).map(e => [e.supplierName, e.amountNet]))
      .toEqual([['Gourmador (frigemo)', 3004.04]]);
  });

  it('ersetzt bei identischem Namen keinen Beleg mit abweichender bekannter MWST-Nr', () => {
    const provisional = inv({
      id: 'ls-fremd', supplierName: 'Gourmador', supplierVatId: '111111111',
      date: '2026-08-12', amountNet: 3004.04,
    });
    const monthly = inv({
      id: 'mr', supplierName: 'Gourmador (frigemo)', supplierVatId: '222222222',
      date: '2026-08-31', amountNet: 3004.04,
    });
    const out = akzeptiereMonatsrechnung({
      bestand: [provisional], liefermonat: '2026-08', monatsrechnung: monthly,
      canonicalize, now: NOW,
    });
    expect(out.find(e => e.id === 'ls-fremd')?.superseded).toBeUndefined();
    expect(zaehlendeEintraege(out)).toHaveLength(2);
  });

  it('ignoriert ersetzte WKQ-Historie in der Fideco-Dublettenanzeige', () => {
    const refs = new Set(['ls-1']);
    const historie = inv({
      supplierName: 'WKQ AG', reference: 'LS-1', superseded: true,
    });
    expect(hatZaehlendeLieferantenReferenz([historie], 'Fideco', refs)).toBe(false);
    expect(hatZaehlendeLieferantenReferenz([
      { ...historie, superseded: false },
    ], 'Fideco Schweiz', refs)).toBe(true);
  });

  it('zeigt bei gleicher Referenz und abweichender MWST-Nr keine Dublette an', () => {
    const bestand = inv({
      supplierName: 'Gourmador', supplierVatId: '111111111', reference: 'LS-1',
    });
    expect(hatZaehlendeLieferantenReferenz(
      [bestand], 'Gourmador (frigemo)', new Set(['ls-1']),
      kanonischerWarenLieferant, '222222222',
    )).toBe(false);
  });

  it('löst eine August-Buchung eindeutig auf Juli-Lieferscheine auf', () => {
    const july = inv({
      id: 'wkq-july', supplierName: 'WKQ AG', date: '2026-07-31',
      final: false,
    });
    const resolved = loeseEindeutigenLiefermonatAuf({
      buchungsmonat: '2026-08',
      bestandByMonat: new Map([
        ['2026-07', [july]],
        ['2026-08', []],
      ]),
      matcht: name => kanonischerWarenLieferant(name) === 'fideco',
    });
    expect(resolved).toEqual({ monat: '2026-07', hatLieferscheine: true });
  });

  it('verweigert eine automatische Wahl bei passenden Lieferscheinen in zwei Monaten', () => {
    const resolved = loeseEindeutigenLiefermonatAuf({
      buchungsmonat: '2026-08',
      bestandByMonat: new Map([
        ['2026-07', [inv({ supplierName: 'WKQ AG', date: '2026-07-31' })]],
        ['2026-08', [inv({ supplierName: 'Fideco', date: '2026-08-01' })]],
      ]),
      matcht: name => kanonischerWarenLieferant(name) === 'fideco',
    });
    expect(resolved).toEqual({ monat: null, hatLieferscheine: true });
  });
});
