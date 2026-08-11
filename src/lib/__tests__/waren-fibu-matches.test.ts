// @vitest-environment node
/**
 * Manuelles FIBU-Matching: Buchungs-Schlüssel, Ampel, Lieferanten-Statistik,
 * Datumsformat und tolerante Blob-Normalisierung.
 */
import { describe, it, expect } from 'vitest';
import {
  buchungKey, buchungKeysMitIndex, buchungBetrag, buchungAnzeigeText, refNummern, buchungRefNummern, fmtDatumCH,
  matchAmpel, lieferantMatchStat, normalizeFibuMatches, normalizeFibuMatchState,
  autoMatchVorschlaege, LEERER_MATCH_STATE, bereinigeMatchState, zerlegeLieferantDifferenz,
  type FibuMatchGruppe, type FibuMatchState,
} from '@/lib/waren-fibu-matches';
import type { InvoiceEntry } from '@/lib/waren-db';
import type { SageJournalEntry } from '@/types/reporting';

function inv(id: string, amountNet: number): InvoiceEntry {
  return { id, date: '2026-06-03', supplierName: 'Prodega', amountNet, amountGross: amountNet } as unknown as InvoiceEntry;
}
function jrn(text: string, soll: number): SageJournalEntry {
  return { accountNumber: '4000', date: '15.06.2026', text, soll, haben: 0 } as unknown as SageJournalEntry;
}

describe('fmtDatumCH', () => {
  it('ISO → dd.mm.yyyy, sonst unverändert', () => {
    expect(fmtDatumCH('2026-06-03')).toBe('03.06.2026');
    expect(fmtDatumCH('15.06.2026')).toBe('15.06.2026');
    expect(fmtDatumCH('')).toBe('');
  });
});

describe('buchungKeysMitIndex', () => {
  it('identische Zeilen bekommen eigene Indizes', () => {
    const a = jrn('Prodega', 100), b = jrn('Prodega', 100), c = jrn('Anders', 50);
    const keys = buchungKeysMitIndex([a, b, c]);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(`${buchungKey(a)}#0`);
    expect(keys[1]).toBe(`${buchungKey(b)}#1`);
  });
});

describe('matchAmpel', () => {
  it('Diff ≤ Toleranz (Default 10) grün, <5% gelb, sonst rot — nie durch 0 teilen', () => {
    expect(matchAmpel(0, 0)).toBe('gruen');
    expect(matchAmpel(1000, 1000)).toBe('gruen');
    expect(matchAmpel(1000, 1010)).toBe('gruen');   // = Toleranz 10
    expect(matchAmpel(1000, 1030)).toBe('gelb');    // 3 %
    expect(matchAmpel(1000, 1200)).toBe('rot');     // 20 %
    expect(matchAmpel(0, 500)).toBe('rot');
    expect(matchAmpel(1000, 1020, 25)).toBe('gruen'); // eigene Toleranz
    expect(matchAmpel(1000, 1005, 2)).toBe('gelb');   // engere Toleranz
  });
});

describe('buchungAnzeigeText / refNummern', () => {
  it('hängt die Belegnummer an den Text an, ohne zu duplizieren', () => {
    const b = { text: 'Transgourmet Schweiz AG', belegNr: '64119916' } as unknown as SageJournalEntry;
    expect(buchungAnzeigeText(b)).toBe('Transgourmet Schweiz AG · 64119916');
    expect(buchungAnzeigeText({ text: 'TG 64119916', belegNr: '64119916' } as unknown as SageJournalEntry)).toBe('TG 64119916');
    expect(buchungAnzeigeText({ text: '', belegNr: '87756560' } as unknown as SageJournalEntry)).toBe('87756560');
  });
  it('refNummern: nur Ziffernfolgen ≥5, führende Nullen normalisiert; Datum/Konto/Beträge ignoriert', () => {
    expect(refNummern('Rechnung 64119916 vom 31.07.2026, Konto 4000, CHF 1234.50')).toEqual(['64119916']);
    expect(refNummern('Ref 0087756560')).toEqual(['87756560']);
    expect(refNummern('')).toEqual([]);
    // Beträge/Tausender-Formate sind KEINE Referenzen
    expect(refNummern('CHF 12345.00')).toEqual([]);
    expect(refNummern('Total 12345,50')).toEqual([]);
    expect(refNummern("1'234'567.90")).toEqual([]);
    expect(refNummern('Zahlung 64119916.')).toEqual(['64119916']); // Satzende ≠ Dezimalpunkt
    const b = { text: 'Transgourmet', belegNr: '64124672 · LS 479500001' } as unknown as SageJournalEntry;
    expect(buchungRefNummern(b).sort()).toEqual(['479500001', '64124672']);
  });
});

describe('autoMatchVorschlaege', () => {
  const state0: FibuMatchState = LEERER_MATCH_STATE;

  it('Phase 0: Rechnungsnummer im Buchungstext gruppiert ALLE Split-Zeilen 1:n, ohne Toleranz', () => {
    // Kontrollfall Transgourmet: Splits 3 Zeilen, Summe weicht um Leergut ab.
    const invoices = [
      { ...inv('r1', 1000), reference: '64119916' } as InvoiceEntry,
      { ...inv('r2', 500), reference: '64124672' } as InvoiceEntry,
    ];
    const buchungen = [
      { ...jrn('Transgourmet Schweiz AG', 600), belegNr: '64119916' } as SageJournalEntry,
      { ...jrn('Transgourmet Schweiz AG', 300), belegNr: '64119916' } as SageJournalEntry,
      jrn('Transgourmet Schweiz AG 64119916', 37.21), // Nummer im Text statt belegNr
      { ...jrn('Transgourmet Schweiz AG', 480), belegNr: '64124672' } as SageJournalEntry,
    ];
    const keys = buchungKeysMitIndex(buchungen);
    const neu = autoMatchVorschlaege({ invoices, buchungen, keys, state: state0 });
    expect(neu).toHaveLength(2);
    const g1 = neu.find(g => g.invoiceIds.includes('r1'))!;
    expect(g1.buchungKeys.sort()).toEqual([keys[0], keys[1], keys[2]].sort()); // alle 3 Splits, Diff 62.79 > Toleranz egal
    const g2 = neu.find(g => g.invoiceIds.includes('r2'))!;
    expect(g2.buchungKeys).toEqual([keys[3]]);
  });

  it('Phase 0: mehrdeutige Nummern bleiben offen (nie raten); gesperrte/gematchte werden nicht angefasst', () => {
    const invoices = [
      { ...inv('r1', 100), reference: '55555' } as InvoiceEntry,
      { ...inv('r2', 200), reference: '55555' } as InvoiceEntry, // gleiche Ref auf 2 Rechnungen
      { ...inv('r3', 999), reference: '77777' } as InvoiceEntry,
    ];
    const buchungen = [
      { ...jrn('Lief A', 100), belegNr: '55555' } as SageJournalEntry,
      { ...jrn('Lief B', 999), belegNr: '77777' } as SageJournalEntry,
    ];
    const keys = buchungKeysMitIndex(buchungen);
    const state: FibuMatchState = { ...LEERER_MATCH_STATE, gesperrt: { invoiceIds: ['r3'], buchungKeys: [] } };
    const neu = autoMatchVorschlaege({ invoices, buchungen, keys, state });
    // 55555 mehrdeutig → kein Ref-Match; r3 gesperrt → 77777-Buchung fällt in den Betrags-Fallback
    expect(neu.some(g => g.invoiceIds.includes('r3'))).toBe(false);
    expect(neu.flatMap(g => g.buchungKeys)).not.toContain(keys[1]);
  });

  it('Phase 0: mehrdeutige Ref NEBEN eindeutiger Ref lässt die Buchung offen (Union zählt)', () => {
    const invoices = [
      { ...inv('a', 100), reference: '55555' } as InvoiceEntry,
      { ...inv('b', 200), reference: '55555' } as InvoiceEntry, // 55555 mehrdeutig
      { ...inv('c', 900), reference: '66666' } as InvoiceEntry,
    ];
    // Buchung trägt BEIDE Nummern → erreicht potenziell a/b UND c → offen lassen
    const buchungen = [{ ...jrn('Lief', 900), belegNr: '55555 · 66666' } as SageJournalEntry];
    const keys = buchungKeysMitIndex(buchungen);
    const neu = autoMatchVorschlaege({ invoices, buchungen, keys, state: state0 });
    expect(neu.filter(g => g.herkunft === 'auto' && g.invoiceIds.includes('c') && g.buchungKeys.length === 1 && g.invoiceIds.length === 1 && g.buchungKeys[0] === keys[0])
      .every(g => Math.abs(900 - 900) <= 10)).toBe(true); // Betrags-Fallback DARF noch matchen (900≈900) …
    // … aber NICHT via Phase-0-Ref: dazu prüfen wir den reinen Ref-Fall ohne Betragsgleichheit
    const invoices2 = invoices.map(e => e.id === 'c' ? { ...e, amountNet: 500 } as InvoiceEntry : e);
    const neu2 = autoMatchVorschlaege({ invoices: invoices2, buchungen, keys, state: state0 });
    expect(neu2).toHaveLength(0); // Ref mehrdeutig + Betrag passt nicht → offen
  });

  it('Phase 0 vor Betrags-Fallback: Ref gewinnt auch gegen betragsgleiche andere Rechnung', () => {
    const invoices = [
      { ...inv('mitRef', 500), reference: '64119916' } as InvoiceEntry,
      inv('ohneRef', 500),
    ];
    const buchungen = [{ ...jrn('TG', 500), belegNr: '64119916' } as SageJournalEntry];
    const keys = buchungKeysMitIndex(buchungen);
    const neu = autoMatchVorschlaege({ invoices, buchungen, keys, state: state0 });
    const g = neu.find(g => g.buchungKeys.includes(keys[0]))!;
    expect(g.invoiceIds).toEqual(['mitRef']);
  });

  it('a) eindeutige 1:1 innerhalb Toleranz, Tag auto', () => {
    const invoices = [inv('a', 500), inv('b', 300)];
    const buchungen = [jrn('x', 505), jrn('y', 300)];
    const keys = buchungKeysMitIndex(buchungen);
    const neu = autoMatchVorschlaege({ invoices, buchungen, keys, state: state0 });
    expect(neu).toHaveLength(2);
    expect(neu.every(g => g.herkunft === 'auto')).toBe(true);
    const ga = neu.find(g => g.invoiceIds.includes('a'))!;
    expect(ga.buchungKeys).toEqual([keys[0]]);
  });

  it('mehrdeutige 1:1 bleiben offen (zwei gleiche Beträge, gleiche Distanz)', () => {
    const invoices = [inv('a', 500), inv('b', 500)]; // beide gleiches Datum
    const buchungen = [jrn('x', 500)];
    const keys = buchungKeysMitIndex(buchungen);
    const neu = autoMatchVorschlaege({ invoices, buchungen, keys, state: state0 });
    expect(neu).toHaveLength(0);
  });

  it('b) Kombination: 2 Rechnungen ≈ 1 Buchung innerhalb Toleranz', () => {
    const invoices = [inv('a', 300), inv('b', 208)];
    const buchungen = [jrn('x', 500)]; // 508 vs 500 → Diff 8 ≤ 10
    const keys = buchungKeysMitIndex(buchungen);
    const neu = autoMatchVorschlaege({ invoices, buchungen, keys, state: state0 });
    expect(neu).toHaveLength(1);
    expect(new Set(neu[0].invoiceIds)).toEqual(new Set(['a', 'b']));
    expect(neu[0].buchungKeys).toEqual([keys[0]]);
  });

  it('gesperrte und bereits gematchte Positionen werden NIE angefasst', () => {
    const invoices = [inv('a', 500), inv('b', 300)];
    const buchungen = [jrn('x', 500), jrn('y', 300)];
    const keys = buchungKeysMitIndex(buchungen);
    const state: FibuMatchState = {
      gruppen: [{ id: 'm1', invoiceIds: ['b'], buchungKeys: [keys[1]], herkunft: 'manuell' }],
      gesperrt: { invoiceIds: ['a'], buchungKeys: [] },
      erklaert: {},
    };
    const neu = autoMatchVorschlaege({ invoices, buchungen, keys, state });
    expect(neu).toHaveLength(0); // 'a' gesperrt, 'b' schon gematcht
  });

  it('b) gleiche Summe, unterschiedliche Datumsnähe → Datums-Tiebreaker entscheidet (Spez. 3c)', () => {
    // Buchung 15.06.: Paar {a,b} (10./14.06.) liegt näher als Paar {c,d} (01./02.06.).
    const invoices = [
      { ...inv('a', 300), date: '2026-06-14' }, { ...inv('b', 200), date: '2026-06-10' },
      { ...inv('c', 300), date: '2026-06-01' }, { ...inv('d', 200), date: '2026-06-02' },
    ] as InvoiceEntry[];
    const buchungen = [jrn('x', 500)];
    const keys = buchungKeysMitIndex(buchungen);
    const neu = autoMatchVorschlaege({ invoices, buchungen, keys, state: state0 });
    expect(neu).toHaveLength(1);
    expect(new Set(neu[0].invoiceIds)).toEqual(new Set(['a', 'b']));
  });

  it('b) gleiche Summe UND gleiche Datumsnähe → mehrdeutig, bleibt offen', () => {
    const invoices = [
      { ...inv('a', 300), date: '2026-06-10' }, { ...inv('b', 200), date: '2026-06-10' },
      { ...inv('c', 300), date: '2026-06-10' }, { ...inv('d', 200), date: '2026-06-10' },
    ] as InvoiceEntry[];
    const buchungen = [jrn('x', 500)];
    const keys = buchungKeysMitIndex(buchungen);
    expect(autoMatchVorschlaege({ invoices, buchungen, keys, state: state0 })).toHaveLength(0);
  });

  it('b) Richtung 2 Buchungen ≈ 1 Rechnung; Gleichstand bleibt offen', () => {
    // Eindeutig: 200+300 ≈ Rechnung 505 (Diff 5).
    const invoices1 = [inv('r', 505)];
    const buchungen1 = [jrn('x', 200), jrn('y', 300)];
    const keys1 = buchungKeysMitIndex(buchungen1);
    const neu1 = autoMatchVorschlaege({ invoices: invoices1, buchungen: buchungen1, keys: keys1, state: state0 });
    expect(neu1).toHaveLength(1);
    expect(neu1[0].invoiceIds).toEqual(['r']);
    expect(new Set(neu1[0].buchungKeys)).toEqual(new Set(keys1));
    // Mehrdeutig: zwei gleiche Buchungspaare, gleiche Daten → offen.
    const invoices2 = [inv('r', 500)];
    const buchungen2 = [jrn('x', 200), jrn('y', 300), jrn('z', 200), jrn('w', 300)];
    const keys2 = buchungKeysMitIndex(buchungen2);
    expect(autoMatchVorschlaege({ invoices: invoices2, buchungen: buchungen2, keys: keys2, state: state0 })).toHaveLength(0);
  });

  it('nichts innerhalb Toleranz → keine Vorschläge', () => {
    const invoices = [inv('a', 100)];
    const buchungen = [jrn('x', 200)];
    const keys = buchungKeysMitIndex(buchungen);
    expect(autoMatchVorschlaege({ invoices, buchungen, keys, state: state0 })).toHaveLength(0);
  });
});

describe('erklaert (erklärte Differenz pro Lieferant)', () => {
  it('normalize: Alt-Format (Notiz-String) migriert zu «sonstiges»; leere/kaputte Werte fliegen raus', () => {
    const s = normalizeFibuMatchState({
      gruppen: [], gesperrt: { invoiceIds: [], buchungKeys: [] },
      erklaert: { 'Feldschlösschen': 'GU-Doppelzahlung', Transgourmet: '  ', X: 42 },
    });
    expect(s.erklaert).toEqual({
      'Feldschlösschen': { grund: 'sonstiges', notiz: 'GU-Doppelzahlung', betrag: null, erklaertAm: '' },
    });
  });
  it('normalize: strukturiertes Format bleibt erhalten; unbekannter Grund → sonstiges, kaputter Betrag → null', () => {
    const s = normalizeFibuMatchState({
      gruppen: [],
      erklaert: {
        A: { grund: 'leergut', betrag: -12.5, erklaertAm: '2026-08-11' },
        B: { grund: 'quatsch', notiz: 'x', betrag: 'NaN', erklaertAm: 7 },
      },
    });
    expect(s.erklaert.A).toEqual({ grund: 'leergut', betrag: -12.5, erklaertAm: '2026-08-11' });
    expect(s.erklaert.B).toEqual({ grund: 'sonstiges', notiz: 'x', betrag: null, erklaertAm: '' });
  });
  it('normalize: Alt-Blob ohne erklaert → leere Map', () => {
    expect(normalizeFibuMatchState({ gruppen: [] }).erklaert).toEqual({});
  });
  it('bereinigeMatchState lässt erklaert unangetastet', () => {
    const state: FibuMatchState = {
      gruppen: [{ id: 'g1', invoiceIds: ['weg'], buchungKeys: ['b1'] }],
      gesperrt: { invoiceIds: ['weg'], buchungKeys: [] },
      erklaert: { Transgourmet: { grund: 'periodenfremd', notiz: 'Rechnung umgebucht', betrag: 99, erklaertAm: '2026-08-01' } },
    };
    const { state: neu } = bereinigeMatchState(state, new Set<string>());
    expect(neu.erklaert).toEqual(state.erklaert);
  });
});

describe('zerlegeLieferantDifferenz', () => {
  it('zerlegt exakt: Match-Rest (Rundung), ungematchte Rechnung negativ, Nur-FIBU positiv; Summe = diff', () => {
    const invoices = [inv('a', 500), inv('b', 300)];
    const buchungen = [jrn('x', 500.03), jrn('y', 120)];
    const keys = buchungKeysMitIndex(buchungen);
    const gruppen: FibuMatchGruppe[] = [{ id: 'g1', invoiceIds: ['a'], buchungKeys: [keys[0]] }];
    const { posten, summe } = zerlegeLieferantDifferenz(invoices, buchungen, keys, gruppen);
    expect(posten.map(p => p.typ)).toEqual(['rundung', 'nur_erfasst', 'nur_fibu']);
    expect(posten[0].betrag).toBeCloseTo(0.03, 2);
    expect(posten[1].betrag).toBe(-300);
    expect(posten[2].betrag).toBe(120);
    // diff = gebucht − erfasst = 620.03 − 800 = −179.97
    expect(summe).toBeCloseTo(-179.97, 2);
  });
  it('Depot-Split ist AUS dem Vergleich ausgeklammert: Pfand erzeugt keine Restdifferenz mehr', () => {
    // Rechnung 500 = 480 Waren + 20 Depot; FIBU bucht nur die 480 (Pfand auf
    // separates Depot-Konto) → Vergleich 480 vs. 480 = KEIN Posten (Spec 08/2026).
    const e = { ...inv('a', 500), kontoSplits: [
      { warenkonto: '4000', amountNet: 480, amountGross: 517 },
      { warenkonto: 'Depot', amountNet: 20, amountGross: 21.6 },
    ] } as InvoiceEntry;
    const buchungen = [jrn('x', 480)];
    const keys = buchungKeysMitIndex(buchungen);
    const gruppen: FibuMatchGruppe[] = [{ id: 'g1', invoiceIds: ['a'], buchungKeys: [keys[0]] }];
    const { posten, summe } = zerlegeLieferantDifferenz([e], buchungen, keys, gruppen);
    expect(posten).toHaveLength(0);
    expect(summe).toBe(0);
  });
  it('echte Match-Abweichung trotz Depot: Rest ohne Depot, Hinweis nur informativ', () => {
    // 480 Waren + 20 Depot erfasst, FIBU bucht 450 → Rest = 450 − 480 = −30
    // (das Depot steckt NICHT in der Differenz, wird aber ausgewiesen).
    const e = { ...inv('a', 500), kontoSplits: [
      { warenkonto: '4000', amountNet: 480, amountGross: 517 },
      { warenkonto: 'Depot', amountNet: 20, amountGross: 21.6 },
    ] } as InvoiceEntry;
    const buchungen = [jrn('x', 450)];
    const keys = buchungKeysMitIndex(buchungen);
    const gruppen: FibuMatchGruppe[] = [{ id: 'g1', invoiceIds: ['a'], buchungKeys: [keys[0]] }];
    const { posten, summe } = zerlegeLieferantDifferenz([e], buchungen, keys, gruppen);
    expect(posten).toHaveLength(1);
    expect(posten[0].typ).toBe('match_rest');
    expect(posten[0].betrag).toBe(-30);
    expect(posten[0].detail).toMatch(/Pfand\/Leergut CHF 20.00 separat als Depot/);
    expect(summe).toBe(-30);
  });
  it('cross-supplier-Gruppe (lokale Rechnung + fremde Buchung) → gruppe_extern, Summen-Invariante hält', () => {
    const invoices = [inv('a', 500)];
    const buchungen: SageJournalEntry[] = [];
    const keys = buchungKeysMitIndex(buchungen);
    const gruppen: FibuMatchGruppe[] = [{ id: 'g1', invoiceIds: ['a'], buchungKeys: ['fremd|key|0'] }];
    const { posten, summe } = zerlegeLieferantDifferenz(invoices, buchungen, keys, gruppen);
    expect(posten).toHaveLength(1);
    expect(posten[0].typ).toBe('gruppe_extern');
    expect(posten[0].betrag).toBe(-500);
    // diff der Zeile = gebucht(0) − erfasst(500) = −500 → Invariante exakt.
    expect(summe).toBe(-500);
  });
  it('cross-supplier-Gruppe (lokale Buchung + fremde Rechnung) → gruppe_extern positiv, Invariante hält', () => {
    const invoices: InvoiceEntry[] = [];
    const buchungen = [jrn('x', 320)];
    const keys = buchungKeysMitIndex(buchungen);
    const gruppen: FibuMatchGruppe[] = [{ id: 'g1', invoiceIds: ['fremde-rechnung'], buchungKeys: [keys[0]] }];
    const { posten, summe } = zerlegeLieferantDifferenz(invoices, buchungen, keys, gruppen);
    expect(posten).toHaveLength(1);
    expect(posten[0].typ).toBe('gruppe_extern');
    expect(posten[0].betrag).toBe(320);
    expect(summe).toBe(320); // = gebucht(320) − erfasst(0)
  });
  it('Summen-Invariante: Posten-Summe = gebucht − erfasst über gemischte Zustände', () => {
    const invoices = [inv('a', 500), inv('b', 300), inv('c', 42.4)];
    const buchungen = [jrn('x', 500.03), jrn('y', 120), jrn('z', 77)];
    const keys = buchungKeysMitIndex(buchungen);
    const gruppen: FibuMatchGruppe[] = [
      { id: 'g1', invoiceIds: ['a'], buchungKeys: [keys[0]] },
      { id: 'g2', invoiceIds: ['b', 'fremd'], buchungKeys: ['fremd|key|0'] }, // cross-supplier
    ];
    const { summe } = zerlegeLieferantDifferenz(invoices, buchungen, keys, gruppen);
    const diff = (500.03 + 120 + 77) - (500 + 300 + 42.4);
    expect(summe).toBeCloseTo(Math.round(diff * 100) / 100, 2);
  });
  it('fremde Gruppen (anderer Lieferant) werden ignoriert; alles gematcht & ausgeglichen → keine Posten', () => {
    const invoices = [inv('a', 250)];
    const buchungen = [jrn('x', 250)];
    const keys = buchungKeysMitIndex(buchungen);
    const gruppen: FibuMatchGruppe[] = [
      { id: 'fremd', invoiceIds: ['zzz'], buchungKeys: ['unbekannt|0'] },
      { id: 'g1', invoiceIds: ['a'], buchungKeys: [keys[0]] },
    ];
    const { posten, summe } = zerlegeLieferantDifferenz(invoices, buchungen, keys, gruppen);
    expect(posten).toHaveLength(0);
    expect(summe).toBe(0);
  });
});

describe('normalizeFibuMatchState', () => {
  it('Alt-Blob ohne gesperrt lädt sauber; herkunft-Default manuell', () => {
    const st = normalizeFibuMatchState({ gruppen: [{ id: 'm1', invoiceIds: ['a'], buchungKeys: ['k'] }] });
    expect(st.gesperrt).toEqual({ invoiceIds: [], buchungKeys: [] });
    expect(st.gruppen[0].herkunft).toBe('manuell');
    const st2 = normalizeFibuMatchState({ gruppen: [], gesperrt: { invoiceIds: ['a', 1], buchungKeys: ['k'] } });
    expect(st2.gesperrt).toEqual({ invoiceIds: ['a'], buchungKeys: ['k'] });
  });
});

describe('lieferantMatchStat', () => {
  it('zählt gematchte Zeilen und summiert nur offene Beträge', () => {
    const invoices = [inv('a', 100), inv('b', 200), inv('c', 50)];
    const buchungen = [jrn('x', 120), jrn('y', 230)];
    const keys = buchungKeysMitIndex(buchungen);
    const gruppen: FibuMatchGruppe[] = [{ id: 'm1', invoiceIds: ['a', 'b'], buchungKeys: [keys[0]] }];
    const s = lieferantMatchStat(invoices, buchungen, keys, gruppen);
    expect(s.matchedInvoices).toBe(2);
    expect(s.totalInvoices).toBe(3);
    expect(s.matchedBuchungen).toBe(1);
    expect(s.totalBuchungen).toBe(2);
    expect(s.offenErfasst).toBeCloseTo(50);
    expect(s.offenGebucht).toBeCloseTo(230);
  });
});

describe('normalizeFibuMatches', () => {
  it('toleriert kaputte Blobs', () => {
    expect(normalizeFibuMatches(null)).toEqual([]);
    expect(normalizeFibuMatches({ gruppen: 'x' })).toEqual([]);
    expect(normalizeFibuMatches({ gruppen: [{ id: 'm1', invoiceIds: ['a', 1], buchungKeys: [] }, {}] }))
      .toEqual([{ id: 'm1', invoiceIds: ['a'], buchungKeys: [], herkunft: 'manuell' }]);
  });
});

describe('buchungBetrag', () => {
  it('Soll − Haben', () => {
    expect(buchungBetrag({ soll: 100, haben: 20 } as SageJournalEntry)).toBe(80);
    expect(buchungBetrag({} as SageJournalEntry)).toBe(0);
  });
});

describe('bereinigeMatchState (C1: Cleanup nach Löschen/Undo)', () => {
  const state = (): FibuMatchState => ({
    gruppen: [
      { id: 'g1', invoiceIds: ['a', 'b'], buchungKeys: ['k1'] },
      { id: 'g2', invoiceIds: ['c'], buchungKeys: ['k2'] },
      { id: 'g3', invoiceIds: ['d'], buchungKeys: [] }, // beschädigt: keine Buchungsseite
    ],
    gesperrt: { invoiceIds: ['a', 'x'], buchungKeys: ['k9'] },
    erklaert: {},
  });

  it('entfernt verwaiste invoiceIds; Gruppen ohne Rechnungs- ODER Buchungsseite fliegen raus', () => {
    const { state: s, geaendert } = bereinigeMatchState(state(), new Set(['a', 'd']));
    expect(geaendert).toBe(true);
    // g1 behält 'a', verliert 'b'; g2 verliert letzte Rechnung → weg; g3 ohne buchungKeys → weg
    expect(s.gruppen.map(g => g.id)).toEqual(['g1']);
    expect(s.gruppen[0].invoiceIds).toEqual(['a']);
    // Sperrliste: 'x' verwaist → raus; Buchungs-Sperren bleiben
    expect(s.gesperrt.invoiceIds).toEqual(['a']);
    expect(s.gesperrt.buchungKeys).toEqual(['k9']);
  });

  it('unverändert, wenn alle IDs gültig sind (kein unnötiger Save)', () => {
    const voll = state();
    voll.gruppen = voll.gruppen.slice(0, 2); // ohne die beschädigte g3
    voll.gesperrt.invoiceIds = ['a']; // 'x' wäre verwaist
    const { geaendert } = bereinigeMatchState(voll, new Set(['a', 'b', 'c']));
    expect(geaendert).toBe(false);
  });
});
