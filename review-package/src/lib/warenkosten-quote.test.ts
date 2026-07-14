// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  kategorieFromKonto,
  kategorieOf,
  istInQuote,
  computeWarenkostenTotals,
  warenkostenQuote,
  buildErVergleich,
  erVergleichStatusLabel,
  ER_VERGLEICH_THRESHOLDS,
  type WarenkostenEntryInput,
} from './warenkosten-quote';

function entry(p: Partial<WarenkostenEntryInput> & { id: string; amountNet: number }): WarenkostenEntryInput {
  return { ...p };
}

describe('kategorieFromKonto (operatives Konto-Mapping)', () => {
  it('mappt 4000/4030 → Food, 4020 → Beverage, Rest → Sonstiges', () => {
    expect(kategorieFromKonto('4000')).toBe('Food');
    expect(kategorieFromKonto('4030')).toBe('Food');
    expect(kategorieFromKonto('4020')).toBe('Beverage');
    expect(kategorieFromKonto('4060')).toBe('Sonstiges');
    expect(kategorieFromKonto('6040')).toBe('Sonstiges');
    expect(kategorieFromKonto(undefined)).toBe('Sonstiges');
  });
});

describe('kategorieOf', () => {
  it('explizite Kategorie hat Vorrang vor Konto-Ableitung', () => {
    expect(kategorieOf(entry({ id: 'a', amountNet: 10, kategorie: 'Beverage', warenkonto: '4000' }))).toBe('Beverage');
  });
  it('fällt auf Konto-Ableitung zurück, wenn keine Kategorie gesetzt', () => {
    expect(kategorieOf(entry({ id: 'a', amountNet: 10, warenkonto: '4020' }))).toBe('Beverage');
  });
  it('Default Sonstiges ohne Kategorie und ohne Konto', () => {
    expect(kategorieOf(entry({ id: 'a', amountNet: 10 }))).toBe('Sonstiges');
  });
});

describe('istInQuote', () => {
  it('Food/Beverage = true, Sonstiges = false', () => {
    expect(istInQuote('Food')).toBe(true);
    expect(istInQuote('Beverage')).toBe(true);
    expect(istInQuote('Sonstiges')).toBe(false);
  });
});

describe('computeWarenkostenTotals', () => {
  const entries: WarenkostenEntryInput[] = [
    entry({ id: 'f1', amountNet: 100, kategorie: 'Food' }),
    entry({ id: 'f2', amountNet: 50, kategorie: 'Food' }),
    entry({ id: 'b1', amountNet: 40, kategorie: 'Beverage' }),
    entry({ id: 's1', amountNet: 30, kategorie: 'Sonstiges' }),
    entry({ id: 's2', amountNet: 20 }), // default Sonstiges
  ];

  it('summiert je Kategorie korrekt', () => {
    const t = computeWarenkostenTotals(entries);
    expect(t.foodNet).toBe(150);
    expect(t.beverageNet).toBe(40);
    expect(t.sonstigeNet).toBe(50);
  });

  it('relevante Warenkosten = Food + Beverage (Sonstiges AUSGESCHLOSSEN)', () => {
    const t = computeWarenkostenTotals(entries);
    expect(t.relevantNet).toBe(190); // 150 + 40, NICHT + 50 Sonstiges
    expect(t.relevantNet).toBe(t.foodNet + t.beverageNet);
    expect(t.relevantNet + t.sonstigeNet).toBe(t.totalNet);
  });

  it('totalNet enthält Sonstiges (nur Info, nicht Quotenbasis)', () => {
    const t = computeWarenkostenTotals(entries);
    expect(t.totalNet).toBe(240); // 190 + 50
  });

  it('perEntry markiert imQuote nur für Food/Beverage', () => {
    const t = computeWarenkostenTotals(entries);
    const map = Object.fromEntries(t.perEntry.map(p => [p.id, p.imQuote]));
    expect(map.f1).toBe(true);
    expect(map.b1).toBe(true);
    expect(map.s1).toBe(false);
    expect(map.s2).toBe(false);
  });

  it('leere Liste → alle Summen 0', () => {
    const t = computeWarenkostenTotals([]);
    expect(t.foodNet).toBe(0);
    expect(t.relevantNet).toBe(0);
    expect(t.totalNet).toBe(0);
    expect(t.perEntry).toHaveLength(0);
  });
});

describe('warenkostenQuote', () => {
  it('rechnet Prozent = relevantNet / revenue * 100 (unrundiert)', () => {
    expect(warenkostenQuote(190, 1000)).toBeCloseTo(19, 10);
    expect(warenkostenQuote(48500, 250000)).toBeCloseTo(19.4, 10);
  });
  it('gibt null bei fehlender/ungültiger Umsatzbasis zurück (NIE 0%)', () => {
    expect(warenkostenQuote(190, 0)).toBeNull();
    expect(warenkostenQuote(190, null)).toBeNull();
    expect(warenkostenQuote(190, undefined)).toBeNull();
    expect(warenkostenQuote(190, -100)).toBeNull();
    expect(warenkostenQuote(190, NaN)).toBeNull();
  });
  it('relevantNet 0 bei gültigem Umsatz → 0 (nicht null)', () => {
    expect(warenkostenQuote(0, 1000)).toBe(0);
  });
});

describe('buildErVergleich', () => {
  it('ohne Erfolgsrechnung: hasEr=false, Status none, Diffs null', () => {
    const v = buildErVergleich({ calcFood: 30000, calcBev: 18500, er: null });
    expect(v.hasEr).toBe(false);
    expect(v.status).toBe('none');
    expect(v.diffChf).toBeNull();
    expect(v.diffPp).toBeNull();
    expect(v.calcTotal).toBe(48500);
    expect(v.revenue).toBeNull();
  });

  it('ER-Seite = cogs_food + cogs_bev (Diverses AUSGESCHLOSSEN), Beispiel aus Spec', () => {
    const v = buildErVergleich({
      calcFood: 30000,
      calcBev: 18500, // calcTotal 48'500
      er: { cogsFood: 32000, cogsBev: 19200, cogsOther: 5000, revenue: 250000 },
    });
    expect(v.erTotal).toBe(51200); // 32000 + 19200, NICHT + 5000 Diverses
    expect(v.erOther).toBe(5000);
    expect(v.calcQuote).toBeCloseTo(19.4, 5);
    expect(v.erQuote).toBeCloseTo(20.48, 5);
    expect(v.diffChf).toBe(2700); // ER − berechnet
    expect(v.diffPp).toBeCloseTo(1.08, 5);
    expect(v.status).toBe('warn');
  });

  it('Prozentpunkt-Differenz ist absolut (Quote-Differenz), nicht relativ', () => {
    const v = buildErVergleich({
      calcFood: 10, calcBev: 0,
      er: { cogsFood: 20, cogsBev: 0, cogsOther: 0, revenue: 100 },
    });
    // calcQuote 10%, erQuote 20% → diffPp = 10 (Prozentpunkte), nicht 100%
    expect(v.diffPp).toBeCloseTo(10, 5);
  });

  it('Status-Schwellen: ok ≤ okPp, warn ≤ warnPp, sonst critical', () => {
    const rev = 100;
    // diffPp = (erTotal - calcTotal)/rev*100
    const mk = (calc: number, er: number) =>
      buildErVergleich({ calcFood: calc, calcBev: 0, er: { cogsFood: er, cogsBev: 0, cogsOther: 0, revenue: rev } });
    expect(mk(10, 10 + ER_VERGLEICH_THRESHOLDS.okPp).status).toBe('ok');        // genau 0.5pp
    expect(mk(10, 10 + ER_VERGLEICH_THRESHOLDS.okPp + 0.01).status).toBe('warn');
    expect(mk(10, 10 + ER_VERGLEICH_THRESHOLDS.warnPp).status).toBe('warn');    // genau 2.0pp
    expect(mk(10, 10 + ER_VERGLEICH_THRESHOLDS.warnPp + 0.01).status).toBe('critical');
    expect(mk(10, 10).status).toBe('ok');                                        // 0pp
  });

  it('negative Abweichung (berechnet > ER) liefert negatives Vorzeichen', () => {
    const v = buildErVergleich({
      calcFood: 60, calcBev: 0,
      er: { cogsFood: 40, cogsBev: 0, cogsOther: 0, revenue: 1000 },
    });
    expect(v.diffChf).toBe(-20);
    expect(v.diffPp).toBeCloseTo(-2, 5);
    expect(v.status).toBe('warn'); // |−2| = 2.0 ≤ warnPp
  });

  it('ER importiert aber Umsatz unbekannt: diffChf gesetzt, diffPp null, Status none', () => {
    const v = buildErVergleich({
      calcFood: 100, calcBev: 0,
      er: { cogsFood: 120, cogsBev: 0, cogsOther: 0, revenue: null },
    });
    expect(v.hasEr).toBe(true);
    expect(v.diffChf).toBe(20);
    expect(v.diffPp).toBeNull();
    expect(v.status).toBe('none');
    expect(v.calcQuote).toBeNull();
    expect(v.erQuote).toBeNull();
  });
});

describe('erVergleichStatusLabel', () => {
  it('liefert deutsche Labels', () => {
    expect(erVergleichStatusLabel('ok')).toBe('Übereinstimmend');
    expect(erVergleichStatusLabel('warn')).toBe('geringe Abweichung');
    expect(erVergleichStatusLabel('critical')).toBe('auffällige Abweichung');
    expect(erVergleichStatusLabel('none')).toBe('Keine Erfolgsrechnung');
  });
});
