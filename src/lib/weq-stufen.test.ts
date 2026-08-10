// @vitest-environment happy-dom
// (happy-dom nötig: cockpit-budget importiert transitiv den Supabase-Client.)
// WEQ-Stufenlogik (Spec 08/2026): manueller Monats-WEQ gilt ab dem Monat
// weiter (Carry-Forward), bis ein neuer manueller Wert kommt; Reset stellt
// Auto/Import wieder her. Randfälle: mehrere Stufen, kein Import, Reset.
import { describe, it, expect } from 'vitest';
import { weqCarryForward, weqMonatswerteMitStufen } from './cockpit-budget';

const N = (n: number) => Array(12).fill(n) as number[];

describe('weqCarryForward', () => {
  it('manueller Wert hält bis zum nächsten manuellen (Auto davor bleibt)', () => {
    const manuell = [null, null, null, null, null, null, 24, null, null, null, null, null];
    const auto = [20.8, 22.1, 21.1, 21.8, 21.5, 22.5, 21.9, 21.9, 21.9, 21.9, 21.9, 21.9];
    const eff = weqCarryForward(manuell, auto);
    expect(eff.slice(0, 6)).toEqual(auto.slice(0, 6)); // Jan–Jun unverändert
    expect(eff.slice(6)).toEqual([24, 24, 24, 24, 24, 24]); // ab Juli Carry
  });

  it('mehrere manuelle Stufen: jede gilt bis zur nächsten', () => {
    const manuell = [null, null, 23, null, null, 26, null, null, null, null, null, null];
    const eff = weqCarryForward(manuell, N(20));
    expect(eff).toEqual([20, 20, 23, 23, 23, 26, 26, 26, 26, 26, 26, 26]);
  });

  it('ohne Auto und ohne Carry bleibt null (leer statt 0)', () => {
    const manuell = [null, null, null, 25, null, null, null, null, null, null, null, null];
    const eff = weqCarryForward(manuell, Array(12).fill(null));
    expect(eff.slice(0, 3)).toEqual([null, null, null]);
    expect(eff.slice(3)).toEqual(Array(9).fill(25));
  });
});

describe('weqMonatswerteMitStufen', () => {
  const erNetto = N(100000);

  it('manuelle Monate bleiben exakt, Folgemonate werden materialisiert', () => {
    const mv = [null, null, null, null, null, null, 24000, null, null, null, null, null];
    const me = [false, false, false, false, false, false, true, false, false, false, false, false];
    const out = weqMonatswerteMitStufen(mv, me, erNetto, N(22));
    expect(out[6]).toBe(24000); // manuell unangetastet
    expect(out.slice(0, 6)).toEqual(Array(6).fill(22000)); // Auto
    expect(out.slice(7)).toEqual(Array(5).fill(24000)); // Carry 24 %
  });

  it('Reset des einzigen manuellen Monats: alles wieder Auto', () => {
    const mv = [null, null, null, null, null, null, 24000, 24000, null, null, null, null];
    const me = Array(12).fill(false); // Juli-Override bereits aufgehoben
    const out = weqMonatswerteMitStufen(mv, me, erNetto, N(22));
    expect(out).toEqual(Array(12).fill(22000));
  });

  it('ohne ER-Netto bleibt der Monat leer (nie ÷0/×null)', () => {
    const er = [null, ...N(100000).slice(1)];
    const mv = Array(12).fill(null); const me = Array(12).fill(false);
    const out = weqMonatswerteMitStufen(mv, me, er, N(22));
    expect(out[0]).toBeNull();
    expect(out[1]).toBe(22000);
  });
});
