// @vitest-environment happy-dom
/**
 * Überstunden-Kernlogik — Kontrollrechnungen aus der Spec:
 * 100 %-MA normale 42-h-Woche → 0; Ferienwoche (5×Gutschrift) → 0;
 * Frei-/0-Woche → −42; Monat = Σ Wochen (tageanteilig); laufend ab Juli 2026;
 * leer statt 0 bei fehlender Datenbasis; Pensum-Skalierung.
 */
import { describe, it, expect } from 'vitest';
import {
  berechneUeberstundenJahr, mondayOf, isoWeekOf,
  type UeMitarbeiterInput, type UeAbsenzTyp,
} from '@/lib/ueberstunden';

const ALLE_MONATE = new Set(Array.from({ length: 12 }, (_, i) => i + 1));

function ma(over: Partial<UeMitarbeiterInput>): UeMitarbeiterInput {
  return {
    id: 'e1', name: 'Test', wochenSollH: 42, fixMonate: ALLE_MONATE,
    contractStart: '2026-01-01', // Tests: Eintritt vorhanden (fehlend → ohneEintritt)
    istStunden: {}, absenzen: {}, ...over,
  };
}

/** Alle Wochen-Montage eines Bereichs als Daten-Basis markieren. */
function wochen(...mondays: string[]): Set<string> { return new Set(mondays); }

// KW 32/2026: Mo 03.08.2026 – So 09.08.2026
const MO = '2026-08-03';

describe('berechneUeberstundenJahr — Wochen-Saldi', () => {
  it('normale 42-h-Woche (100 %) → Saldo 0', () => {
    const ist: Record<string, number> = {};
    for (let i = 0; i < 5; i++) ist[`2026-08-0${3 + i}`] = 8.4;
    const r = berechneUeberstundenJahr(2026, [ma({ istStunden: ist })], wochen(MO), '2026-12-31');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.soll).toBe(42);
    expect(w.ist).toBeCloseTo(42, 6);
    expect(w.saldo).toBeCloseTo(0, 6);
  });

  it('Ferienwoche (5 × Ferien) → Saldo 0', () => {
    const abs: Record<string, UeAbsenzTyp> = {};
    for (let i = 0; i < 5; i++) abs[`2026-08-0${3 + i}`] = 'ferien';
    const r = berechneUeberstundenJahr(2026, [ma({ absenzen: abs })], wochen(MO), '2026-12-31');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.saldo).toBeCloseTo(0, 6);
    expect(w.gutschrift).toBeCloseTo(42, 6);
  });

  it('Ferien Mo–So (7 Tage, 0 MIRUS) → Deckelung auf Wochen-Soll, Saldo 0 (Kontrollfall Spec)', () => {
    // Kontrolle Mawlood KW32: FE Mo–So, 0 Arbeitsstunden →
    // Roh-Gutschrift 7×8.4=58.8, gedeckelt auf 42−0=42 → Saldo 0.0 (nicht +16.8).
    const abs: Record<string, UeAbsenzTyp> = {};
    for (let i = 0; i < 7; i++) abs[`2026-08-0${3 + i}`] = 'ferien';
    const r = berechneUeberstundenJahr(2026, [ma({ absenzen: abs })], wochen(MO), '2026-12-31');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.gutschrift).toBeCloseTo(42, 6);
    expect(w.saldo).toBeCloseTo(0, 6);
    expect(r.mitarbeiter[0].laufend).toBeCloseTo(0, 6);
  });

  it('Deckelung: Arbeit + Ferien überschreiten das Wochen-Soll nie (kein Plus aus Absenzen)', () => {
    // 4 Arbeitstage à 10 h (40 h) + 1 Ferientag: Gutschrift roh 8.4, Deckel 42−40=2.
    const ist: Record<string, number> = {};
    for (let i = 0; i < 4; i++) ist[`2026-08-0${3 + i}`] = 10;
    const r = berechneUeberstundenJahr(2026, [ma({
      istStunden: ist, absenzen: { '2026-08-07': 'ferien' },
    })], wochen(MO), '2026-12-31');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.gutschrift).toBeCloseTo(2, 6);
    expect(w.saldo).toBeCloseTo(0, 6);
  });

  it('Mehrarbeit ohne Absenzen bleibt ungedeckelt (+5)', () => {
    const ist: Record<string, number> = {};
    for (let i = 0; i < 5; i++) ist[`2026-08-0${3 + i}`] = 9.4;
    const r = berechneUeberstundenJahr(2026, [ma({ istStunden: ist })], wochen(MO), '2026-12-31');
    expect(r.mitarbeiter[0].wochen.find(w => w.monday === MO)!.saldo).toBeCloseTo(5, 6);
  });

  it('Dienstplan-Absenzen (planAbsenzen) zählen wie manuelle; manuelle Erfassung sticht', () => {
    const plan: Record<string, UeAbsenzTyp> = {};
    for (let i = 0; i < 5; i++) plan[`2026-08-0${3 + i}`] = 'ferien';
    // Manueller Override: Mittwoch ist «frei» (keine Gutschrift) statt Plan-Ferien.
    const r = berechneUeberstundenJahr(2026, [ma({
      planAbsenzen: plan, absenzen: { '2026-08-05': 'frei' },
    })], wochen(MO), '2026-12-31');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.tage[2].absenzTyp).toBe('frei');
    expect(w.gutschrift).toBeCloseTo(4 * 8.4, 6);
    expect(w.saldo).toBeCloseTo(-8.4, 6);
  });

  it('Plan-Ferienwoche aktiviert NUR den betroffenen MA (kein −42-Drift für andere)', () => {
    // Woche OHNE mandanten-weite Datenbasis (kein MIRUS, keine manuelle Absenz):
    // A hat Plan-FE Mo–Fr → Saldo 0; B (nichts) bleibt leer (null), nie −42.
    const plan: Record<string, UeAbsenzTyp> = {};
    for (let i = 0; i < 5; i++) plan[`2026-08-0${3 + i}`] = 'ferien';
    const r = berechneUeberstundenJahr(2026, [
      ma({ id: 'A', planAbsenzen: plan }),
      ma({ id: 'B' }),
    ], wochen(), '2026-12-31');
    const wA = r.mitarbeiter.find(m => m.id === 'A')!.wochen.find(w => w.monday === MO)!;
    const wB = r.mitarbeiter.find(m => m.id === 'B')!.wochen.find(w => w.monday === MO)!;
    expect(wA.saldo).toBeCloseTo(0, 6);
    expect(wB.saldo).toBeNull();
    expect(wB.soll).toBeNull();
  });

  it('Plan-«Frei» allein aktiviert die Woche NICHT (bleibt leer)', () => {
    const plan: Record<string, UeAbsenzTyp> = {};
    for (let i = 0; i < 7; i++) plan[`2026-08-0${3 + i}`] = 'frei';
    const r = berechneUeberstundenJahr(2026, [ma({ planAbsenzen: plan })], wochen(), '2026-12-31');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.saldo).toBeNull();
  });

  it('Frei-/0-Woche (Datenbasis vorhanden) → Saldo −42', () => {
    const r = berechneUeberstundenJahr(2026, [ma({})], wochen(MO), '2026-12-31');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.saldo).toBeCloseTo(-42, 6);
  });

  it('Woche OHNE Datenbasis → leer (null), nie −42', () => {
    const r = berechneUeberstundenJahr(2026, [ma({})], wochen(), '2026-12-31');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.saldo).toBeNull();
    expect(w.soll).toBeNull();
    expect(r.mitarbeiter[0].laufend).toBeNull();
    expect(r.totalLaufend).toBeNull();
  });

  it('Pensum 50 % (21 h): Soll 21, Ferientag +4.2', () => {
    const r = berechneUeberstundenJahr(2026, [ma({
      wochenSollH: 21,
      absenzen: { '2026-08-03': 'ferien' },
      istStunden: { '2026-08-04': 4.2, '2026-08-05': 4.2, '2026-08-06': 4.2, '2026-08-07': 4.2 },
    })], wochen(MO), '2026-12-31');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.soll).toBeCloseTo(21, 6);
    expect(w.gutschrift).toBeCloseTo(4.2, 6);
    expect(w.saldo).toBeCloseTo(0, 6);
  });

  it('Frei-Eintrag = 0 Gutschrift (wie kein Eintrag)', () => {
    const r = berechneUeberstundenJahr(2026, [ma({
      absenzen: { '2026-08-03': 'frei' },
    })], wochen(MO), '2026-12-31');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.gutschrift).toBe(0);
    expect(w.saldo).toBeCloseTo(-42, 6);
  });

  it('Wochenend-Arbeit zählt ins Ist, Sa/So haben kein Soll', () => {
    const r = berechneUeberstundenJahr(2026, [ma({
      istStunden: { '2026-08-08': 6 }, // Samstag
    })], wochen(MO), '2026-12-31');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.soll).toBe(42);
    expect(w.ist).toBe(6);
    expect(w.saldo).toBeCloseTo(-36, 6);
  });
});

describe('Monats-Split & laufendes Konto', () => {
  it('Monatsgrenze: KW-Tage werden tageanteilig dem Monat zugeordnet', () => {
    // KW 27/2026: Mo 29.06. – So 05.07. → Juni-Anteil Mo+Di (2 Tage à 8.4 Soll),
    // Juli-Anteil Mi–Fr (3 Tage). MA arbeitet exakt Soll an allen 5 Tagen.
    const ist = {
      '2026-06-29': 8.4, '2026-06-30': 8.4,
      '2026-07-01': 8.4, '2026-07-02': 8.4, '2026-07-03': 8.4,
    };
    const mo = mondayOf('2026-07-01');
    expect(mo).toBe('2026-06-29');
    const r = berechneUeberstundenJahr(2026, [ma({ istStunden: ist })], wochen(mo), '2026-12-31');
    const e = r.mitarbeiter[0];
    // Konto-Start 01.07.: Juni-Tage der KW 27 zählen NIRGENDS (weder Soll noch Ist)
    expect(e.monatsSaldo[5]).toBeNull();        // Juni: vor Konto-Start → leer
    expect(e.monatsSaldo[6]).toBeCloseTo(0, 6); // Juli (Mi–Fr, Soll = Ist)
    expect(e.laufend).toBeCloseTo(0, 6);
    // KW 27 mit anteiligem Soll: nur 3 Juli-Wochentage (Mi–Fr) → 25.2, nie −42-Basis
    const w = e.wochen.find(w => w.monday === mo)!;
    expect(w.soll).toBeCloseTo(25.2, 6);
    expect(w.ist).toBeCloseTo(25.2, 6);
  });

  it('Wochenliste beginnt mit der Konto-Start-Woche (KW 27) — nichts davor', () => {
    const r = berechneUeberstundenJahr(2026, [ma({})], wochen(), '2026-12-31');
    const wochenListe = r.mitarbeiter[0].wochen;
    expect(wochenListe[0].monday).toBe('2026-06-29'); // Woche des 01.07.
    expect(wochenListe.some(w => w.monday < '2026-06-29')).toBe(false);
  });

  it('laufendes Konto kumuliert nur ab Juli 2026', () => {
    // Juni-Woche mit +10 Überstunden (zählt nicht), Juli-Woche mit +5 (zählt).
    const juniMo = '2026-06-01';
    const juliMo = '2026-07-06';
    const ist: Record<string, number> = {};
    for (let i = 0; i < 5; i++) ist[`2026-06-0${1 + i}`] = 10.4; // +2/Tag = +10
    for (let i = 0; i < 5; i++) ist[`2026-07-${String(6 + i).padStart(2, '0')}`] = 9.4; // +1/Tag = +5
    const r = berechneUeberstundenJahr(2026, [ma({ istStunden: ist })], wochen(juniMo, juliMo), '2026-12-31');
    const e = r.mitarbeiter[0];
    expect(e.monatsSaldo[5]).toBeNull(); // Juni liegt vor dem Konto-Start → leer
    expect(e.laufend).toBeCloseTo(5, 6);
  });

  it('Eintritt 01.08. (Abdii-Fall): Juli leer, Laufend erst ab August', () => {
    const juliMo = '2026-07-06', augMo = '2026-08-03';
    const ist: Record<string, number> = {};
    for (let i = 0; i < 5; i++) ist[`2026-08-0${3 + i}`] = 9.4; // +1/Tag = +5
    const r = berechneUeberstundenJahr(2026, [ma({
      contractStart: '2026-08-01', istStunden: ist,
    })], wochen(juliMo, augMo), '2026-12-31');
    const e = r.mitarbeiter[0];
    const juliWoche = e.wochen.find(w => w.monday === juliMo)!;
    expect(juliWoche.soll).toBeNull();  // vor Eintritt: kein Soll, kein −42
    expect(juliWoche.saldo).toBeNull();
    expect(e.monatsSaldo[6]).toBeNull(); // Juli leer
    expect(e.monatsSaldo[7]).toBeCloseTo(5, 6);
    expect(e.laufend).toBeCloseTo(5, 6); // nur ab August
    expect(e.ohneEintritt).toBe(false);
  });

  it('OHNE Eintrittsdatum: nicht gerechnet (alles leer), nur Hinweis-Flag', () => {
    const ist: Record<string, number> = { '2026-08-03': 8.4 };
    const r = berechneUeberstundenJahr(2026, [ma({
      contractStart: null, istStunden: ist,
    })], wochen(MO), '2026-12-31');
    const e = r.mitarbeiter[0];
    expect(e.ohneEintritt).toBe(true);
    expect(e.laufend).toBeNull();
    expect(e.wochen.every(w => w.soll === null && w.saldo === null)).toBe(true);
    expect(r.totalLaufend).toBeNull(); // kein unterstelltes Voll-Soll im Total
  });

  it('Monat = Σ seiner (anteiligen) Wochen', () => {
    // August 2026: KW 32–35 voll + Randwochen. Zwei Wochen Daten: eine 0-Saldo,
    // eine −42 → Monats-Saldo August = −42.
    const w1 = '2026-08-03', w2 = '2026-08-10';
    const ist: Record<string, number> = {};
    for (let i = 0; i < 5; i++) ist[`2026-08-0${3 + i}`] = 8.4;
    const r = berechneUeberstundenJahr(2026, [ma({ istStunden: ist })], wochen(w1, w2), '2026-12-31');
    expect(r.mitarbeiter[0].monatsSaldo[7]).toBeCloseTo(-42, 6);
  });

  it('Tage nach «heute» zählen nicht (Stand bis heute)', () => {
    const ist = { '2026-08-03': 8.4, '2026-08-04': 8.4 };
    const r = berechneUeberstundenJahr(2026, [ma({ istStunden: ist })], wochen(MO), '2026-08-04');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.soll).toBeCloseTo(16.8, 6); // nur Mo+Di
    expect(w.saldo).toBeCloseTo(0, 6);
  });

  it('FIX nur in manchen Monaten: andere Monate zählen nicht', () => {
    const r = berechneUeberstundenJahr(2026, [ma({
      fixMonate: new Set([7]), // nur Juli FIX
      istStunden: { '2026-08-03': 8.4 },
    })], wochen(MO), '2026-12-31');
    const e = r.mitarbeiter[0];
    expect(e.monatsSaldo[7]).toBeNull(); // August: kein FIX-Monat → leer
  });

  it('Eintritt/Austritt begrenzen Soll und Ist', () => {
    const r = berechneUeberstundenJahr(2026, [ma({
      contractStart: '2026-08-05',
      istStunden: { '2026-08-03': 8, '2026-08-05': 8.4, '2026-08-06': 8.4, '2026-08-07': 8.4 },
    })], wochen(MO), '2026-12-31');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.soll).toBeCloseTo(25.2, 6); // Mi–Fr
    expect(w.ist).toBeCloseTo(25.2, 6);  // Mo-Stunden vor Eintritt zählen nicht
    expect(w.saldo).toBeCloseTo(0, 6);
  });

  it('Total = Σ laufende Saldi mehrerer MA; MA ohne Datenbasis bleibt null', () => {
    const ist: Record<string, number> = {};
    for (let i = 0; i < 5; i++) ist[`2026-08-0${3 + i}`] = 9.4; // +5
    const r = berechneUeberstundenJahr(2026, [
      ma({ id: 'a', istStunden: ist }),
      ma({ id: 'b' }), // keine Stunden, keine Absenz → in Datenwoche: −42
    ], wochen(MO), '2026-12-31');
    expect(r.mitarbeiter.find(m => m.id === 'a')!.laufend).toBeCloseTo(5, 6);
    expect(r.mitarbeiter.find(m => m.id === 'b')!.laufend).toBeCloseTo(-42, 6);
    expect(r.totalLaufend).toBeCloseTo(-37, 6);
  });
});

describe('Überstunden-Kosten & Tages-Aufschlüsselung', () => {
  it('Kosten = positives laufendes Saldo × Stundensatz; negativ = 0; ohne Satz = null', () => {
    const istPlus: Record<string, number> = {};
    for (let i = 0; i < 5; i++) istPlus[`2026-08-0${3 + i}`] = 9.4; // +5 h
    const r = berechneUeberstundenJahr(2026, [
      ma({ id: 'plus', istStunden: istPlus, stundensatz: 40 }),
      ma({ id: 'minus', stundensatz: 40 }),           // Datenwoche ohne Stunden → −42
      ma({ id: 'ohneSatz', istStunden: istPlus, stundensatz: null }),
    ], wochen(MO), '2026-12-31');
    expect(r.mitarbeiter.find(m => m.id === 'plus')!.kosten).toBeCloseTo(200, 2);   // 5 × 40
    expect(r.mitarbeiter.find(m => m.id === 'minus')!.kosten).toBe(0);              // schuldet Stunden
    expect(r.mitarbeiter.find(m => m.id === 'ohneSatz')!.kosten).toBeNull();        // Satz fehlt
    expect(r.totalKosten).toBeCloseTo(200, 2); // Σ nur positive Konten
    expect(r.totalLaufend).toBeCloseTo(5 - 42 + 5, 6);
  });

  it('Woche ohne Datenbasis → Kosten null (nie stille 0)', () => {
    const r = berechneUeberstundenJahr(2026, [ma({ stundensatz: 40 })], wochen(), '2026-12-31');
    expect(r.mitarbeiter[0].kosten).toBeNull();
    expect(r.totalKosten).toBeNull();
  });

  it('Tages-Aufschlüsselung: Arbeit/Absenz/Gutschrift/Soll je Tag, zaehlt-Flag', () => {
    const r = berechneUeberstundenJahr(2026, [ma({
      contractStart: '2026-08-05', // Mi
      istStunden: { '2026-08-05': 8, '2026-08-06': 9 },
      absenzen: { '2026-08-07': 'ferien' },
    })], wochen(MO), '2026-12-31');
    const w = r.mitarbeiter[0].wochen.find(w => w.monday === MO)!;
    expect(w.tage).toHaveLength(7);
    const [mo2, , mi, doo, fr, sa] = [w.tage[0], w.tage[1], w.tage[2], w.tage[3], w.tage[4], w.tage[5]];
    expect(mo2.zaehlt).toBe(false); // vor Eintritt
    expect(mi.zaehlt).toBe(true);
    expect(mi.arbeitH).toBe(8);
    expect(mi.soll).toBeCloseTo(8.4, 6);
    expect(doo.arbeitH).toBe(9);
    expect(fr.absenzTyp).toBe('ferien');
    // Deckelung (Spec 08/2026): Gutschrift ≤ Wochen-Soll − Arbeits-Ist
    // (25.2 − 17 = 8.2 statt roh 8.4) — Ferien füllen höchstens bis Saldo 0.
    expect(fr.gutschrift).toBeCloseTo(8.2, 6);
    expect(sa.soll).toBe(0); // Samstag: kein Soll
    // Wochen-Summen konsistent zur Tagesliste (Saldo genau 0 dank Deckelung)
    expect(w.soll).toBeCloseTo(25.2, 6);
    expect(w.ist).toBeCloseTo(25.2, 6);
    expect(w.saldo).toBeCloseTo(0, 6);
  });
});

describe('Jahre vor dem Konto-Start', () => {
  it('2025: explizit leeres Ergebnis (keine Wochen, alles null)', () => {
    const r = berechneUeberstundenJahr(2025, [ma({
      istStunden: { '2025-08-04': 8.4 },
    })], wochen('2025-08-04'), '2026-12-31');
    const e = r.mitarbeiter[0];
    expect(e.wochen).toHaveLength(0);
    expect(e.monatsSaldo.every(s => s === null)).toBe(true);
    expect(e.laufend).toBeNull();
    expect(r.totalLaufend).toBeNull();
  });
});

describe('ISO-Wochen-Helfer', () => {
  it('isoWeekOf: Jahreswechsel korrekt', () => {
    expect(isoWeekOf('2026-01-01')).toEqual({ kw: 1, kwYear: 2026 });
    expect(isoWeekOf('2026-08-03')).toEqual({ kw: 32, kwYear: 2026 });
    expect(isoWeekOf('2026-12-31')).toEqual({ kw: 53, kwYear: 2026 });
  });
  it('mondayOf', () => {
    expect(mondayOf('2026-08-09')).toBe('2026-08-03'); // Sonntag → Montag davor
    expect(mondayOf('2026-08-03')).toBe('2026-08-03');
  });
});
