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
    expect(e.monatsSaldo[5]).toBeCloseTo(0, 6); // Juni
    expect(e.monatsSaldo[6]).toBeCloseTo(0, 6); // Juli
    // Laufend startet 01.07. → Juni-Tage zählen NICHT ins Konto
    expect(e.laufend).toBeCloseTo(0, 6);
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
    expect(e.monatsSaldo[5]).toBeCloseTo(10, 6);
    expect(e.laufend).toBeCloseTo(5, 6);
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
