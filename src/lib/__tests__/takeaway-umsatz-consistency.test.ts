// @vitest-environment node
/**
 * Konsistenz-Test: Cockpit-Zeilen «Take Away Umsatz» ↔ «Take Away Anteil»
 * ======================================================================
 * Beide Zeilen stammen aus DERSELBEN Quelle (Tagesumsatz-Import,
 * takeawayRevenue/takeAwayBrutto). Es gilt die Identität:
 *     Take Away Anteil [%]  ==  Take Away Umsatz  ÷  Gesamtumsatz  × 100
 * d.h. der «Take Away Umsatz» ist der ZÄHLER des «Take Away Anteil». Der Test
 * repliziert die in ladeMonatsreport verdrahtete reine Rechnung (Rundung r2 =
 * 2 Nachkommastellen) und prüft die Identität auf denselben Daten.
 *
 * Zusätzlich: die neue id `take_away_umsatz` unterliegt dem
 * «Betrieb bietet Take Away»-Schalter (filterTakeAwayRows).
 */
import { describe, it, expect, vi } from 'vitest';

// takeaway-offered-settings zieht supabase-db (localStorage/browser) beim Import.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/supabase-db', () => ({
  loadSetting: vi.fn(async () => null),
  saveSetting: vi.fn(async () => undefined),
}));

import { TAKEAWAY_ROW_IDS, filterTakeAwayRows } from '@/lib/takeaway-offered-settings';

// Gleiche Rundung wie in monatsreport.ts (r2).
const r2 = (v: number) => Math.round(v * 100) / 100;

// Reine Nachbildung der Zeilenwerte aus ladeMonatsreport.
function takeAwayRow(taBrutto: number, gesamtBrutto: number) {
  const hatUmsatz = gesamtBrutto > 0;
  const umsatz = hatUmsatz && taBrutto > 0 ? r2(taBrutto) : null;               // Zeile «Take Away Umsatz»
  const anteil = umsatz != null && gesamtBrutto > 0 ? r2((taBrutto / gesamtBrutto) * 100) : null; // Zeile «Take Away Anteil»
  return { umsatz, anteil };
}

describe('Take Away Umsatz ↔ Take Away Anteil — Identität', () => {
  const cases: Array<[number, number]> = [
    [1200, 8000],
    [333.33, 10000],
    [50.5, 201.25],
    [0, 5000],       // kein TA-Umsatz → beide null
    [1500, 0],       // kein Gesamtumsatz → beide null
  ];

  it('Anteil == Umsatz ÷ Gesamt × 100 (auf denselben Daten)', () => {
    for (const [ta, gross] of cases) {
      const { umsatz, anteil } = takeAwayRow(ta, gross);
      if (umsatz == null || gross === 0) {
        // Randfall: keine Kennzahl.
        expect(anteil).toBeNull();
        continue;
      }
      // Anteil muss der aus dem (gerundeten) Umsatz und Gesamtumsatz gebildeten Quote entsprechen.
      expect(anteil).toBe(r2((umsatz / gross) * 100));
      // Und umgekehrt: Umsatz = Anteil% × Gesamt ÷ 100 (bis auf die Rundung des
      // Anteils auf 2 Nachkommastellen → Toleranz proportional zum Gesamtumsatz).
      const rundungsToleranz = (0.005 / 100) * gross + 0.01;
      expect(Math.abs((anteil! / 100) * gross - umsatz)).toBeLessThan(rundungsToleranz);
    }
  });

  it('kein TA-Umsatz → beide Kennzahlen null («—», nie 0)', () => {
    expect(takeAwayRow(0, 5000)).toEqual({ umsatz: null, anteil: null });
  });

  it('kein Gesamtumsatz → beide Kennzahlen null', () => {
    expect(takeAwayRow(1500, 0)).toEqual({ umsatz: null, anteil: null });
  });
});

describe('Take Away Umsatz — dem Angebot-Schalter unterworfen', () => {
  it('take_away_umsatz ist in TAKEAWAY_ROW_IDS enthalten', () => {
    expect([...TAKEAWAY_ROW_IDS]).toContain('take_away_umsatz');
  });

  it('filterTakeAwayRows(false) entfernt auch take_away_umsatz', () => {
    const rows = [
      { id: 'netto_umsatz' },
      { id: 'take_away_anteil' },
      { id: 'take_away_umsatz' },
      { id: 'food' },
    ];
    const out = filterTakeAwayRows(rows, false).map(r => r.id);
    expect(out).toEqual(['netto_umsatz', 'food']);
  });

  it('filterTakeAwayRows(true) behält take_away_umsatz', () => {
    const rows = [{ id: 'take_away_umsatz' }, { id: 'food' }];
    expect(filterTakeAwayRows(rows, true).map(r => r.id)).toEqual(['take_away_umsatz', 'food']);
  });
});

// ── Mandanten-Regel Oliv: Take Away zählt 100% zu FOOD (taVollFood) ──────────
import { foodBeverageSplit, nettoUmsatzTag, type UmsatzTag } from '@/lib/umsatz';

describe('foodBeverageSplit — taVollFood (Oliv: TA 100% Food)', () => {
  const base: UmsatzTag = {
    datum: '2026-07-01', gesamtBrutto: 10000, takeAwayBrutto: 2000,
    foodBrutto: 5000, beverageBrutto: 2500, marketingNetto: 100,
  };

  it('ohne Flag: bisherige anteilige Verteilung, Invariante food+bev=netto', () => {
    const s = foodBeverageSplit(base);
    expect(s.food + s.beverage).toBeCloseTo(nettoUmsatzTag(base), 10);
    // Food-Anteil entspricht dem Direktverhältnis (2/3)
    expect(s.food / (s.food + s.beverage)).toBeCloseTo(2 / 3, 3);
  });

  it('mit Flag: TA-Netto vollständig in Food, Rest weiterhin anteilig, Invariante hält', () => {
    const tag = { ...base, taVollFood: true };
    const alt = foodBeverageSplit(base);
    const neu = foodBeverageSplit(tag);
    const taNetto = tag.takeAwayBrutto / 1.026;
    expect(neu.food + neu.beverage).toBeCloseTo(nettoUmsatzTag(tag), 10);
    // Verschiebung = bisheriger Beverage-Anteil des TA (TA-Netto × Bev-Quote 1/3)
    expect(neu.food - alt.food).toBeCloseTo(taNetto * (1 / 3), 6);
    expect(alt.beverage - neu.beverage).toBeCloseTo(taNetto * (1 / 3), 6);
    // Food enthält mindestens Direkt-Food + volles TA-Netto? Nein — Rest kann negativ sein;
    // massgeblich ist: Beverage bekommt KEINEN TA-Anteil mehr:
    const restOhneTa = nettoUmsatzTag(tag) - tag.foodBrutto / 1.081 - tag.beverageBrutto / 1.081 - taNetto;
    expect(neu.beverage).toBeCloseTo(tag.beverageBrutto / 1.081 + restOhneTa * (1 / 3), 6);
  });

  it('mit Flag ohne F/B-Basis: TA zu Food, Rest hälftig', () => {
    const tag: UmsatzTag = { datum: '2026-07-01', gesamtBrutto: 3000, takeAwayBrutto: 1000, foodBrutto: 0, beverageBrutto: 0, marketingNetto: 0, taVollFood: true };
    const s = foodBeverageSplit(tag);
    const taNetto = 1000 / 1.026;
    const rest = nettoUmsatzTag(tag) - taNetto;
    expect(s.food).toBeCloseTo(taNetto + rest / 2, 6);
    expect(s.beverage).toBeCloseTo(rest / 2, 6);
  });
});
