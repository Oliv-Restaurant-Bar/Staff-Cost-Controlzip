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

// ── Einheitlicher F/B-Split (beide Mandanten, seit 08/2026) ──────────────────
// Direkt: Food→Food, Beverage→Beverage; Oliv: TA 100% Food (taVollFood);
// DEFAULT: gesamter übriger Rest (auch unbekannte Positionen) 50/50.
import { foodBeverageSplit, nettoUmsatzTag, type UmsatzTag } from '@/lib/umsatz';

describe('foodBeverageSplit — einheitlicher Default: Rest 50/50', () => {
  const base: UmsatzTag = {
    datum: '2026-07-01', gesamtBrutto: 10000, takeAwayBrutto: 0,
    foodBrutto: 5000, beverageBrutto: 2500, marketingNetto: 100,
  };

  it('Rest (Non-Food, Rabatte, Marketing, Unbekanntes) hälftig, direkte Kategorien direkt, Invariante hält', () => {
    const s = foodBeverageSplit(base);
    const fd = base.foodBrutto / 1.081, bd = base.beverageBrutto / 1.081;
    const rest = nettoUmsatzTag(base) - fd - bd;
    expect(s.food).toBeCloseTo(fd + rest / 2, 6);
    expect(s.beverage).toBeCloseTo(bd + rest / 2, 6);
    expect(s.food + s.beverage).toBeCloseTo(nettoUmsatzTag(base), 10);
  });

  it('negativer Rest (z.B. Rabatte drücken Gesamt unter die Kategorien) wird ebenfalls 50/50 getragen', () => {
    const tag: UmsatzTag = { datum: '2026-07-01', gesamtBrutto: 7000, takeAwayBrutto: 0, foodBrutto: 5000, beverageBrutto: 2600, marketingNetto: 0 };
    const s = foodBeverageSplit(tag);
    const fd = tag.foodBrutto / 1.081, bd = tag.beverageBrutto / 1.081;
    const rest = nettoUmsatzTag(tag) - fd - bd; // < 0
    expect(rest).toBeLessThan(0);
    expect(s.food).toBeCloseTo(fd + rest / 2, 6);
    expect(s.beverage).toBeCloseTo(bd + rest / 2, 6);
    expect(s.food + s.beverage).toBeCloseTo(nettoUmsatzTag(tag), 10);
  });

  it('keine direkten Kategorien: alles 50/50 (unbekannte Positionen gehen nicht verloren)', () => {
    const tag: UmsatzTag = { datum: '2026-07-01', gesamtBrutto: 3000, takeAwayBrutto: 0, foodBrutto: 0, beverageBrutto: 0, marketingNetto: 50 };
    const s = foodBeverageSplit(tag);
    expect(s.food).toBeCloseTo(nettoUmsatzTag(tag) / 2, 6);
    expect(s.beverage).toBeCloseTo(nettoUmsatzTag(tag) / 2, 6);
  });
});

// ── Vorjahr (vj_daily): identische Regel über vjTagWerte ─────────────────────
import { vjTagWerte } from '@/lib/umsatz';

describe('vjTagWerte — Vorjahr nach identischer Regel', () => {
  it('Beaulieu: Kategorien > Gesamt (Rabatte) → negativer Rest 50/50, Invariante hält', () => {
    // Nachbau des gemeldeten Falls: foodRev+bevRev übersteigen actualRevenue.
    const w = vjTagWerte('beaulieu', { actualRevenue: 7000, takeawayRevenue: 0, foodRevenue: 5000, beverageRevenue: 2600 })!;
    const fd = 5000 / 1.081, bd = 2600 / 1.081, netto = 7000 / 1.081;
    const rest = netto - fd - bd; // < 0
    expect(w.netto).toBeCloseTo(netto, 10);
    expect(w.food).toBeCloseTo(fd + rest / 2, 6);
    expect(w.beverage).toBeCloseTo(bd + rest / 2, 6);
    expect(w.food + w.beverage).toBeCloseTo(w.netto, 10);
  });

  it('Oliv: TA-Netto (÷1.026) vollständig Food, Rest 50/50, Invariante hält', () => {
    const w = vjTagWerte('oliv', { actualRevenue: 10000, takeawayRevenue: 2000, foodRevenue: 5000, beverageRevenue: 2500 })!;
    const taN = 2000 / 1.026, netto = taN + 8000 / 1.081;
    const fd = 5000 / 1.081, bd = 2500 / 1.081;
    const rest = netto - fd - bd - taN;
    expect(w.netto).toBeCloseTo(netto, 10);
    expect(w.food).toBeCloseTo(fd + taN + rest / 2, 6);
    expect(w.beverage).toBeCloseTo(bd + rest / 2, 6);
    expect(w.food + w.beverage).toBeCloseTo(w.netto, 10);
  });

  it('kein Umsatz → null («leer statt 0»)', () => {
    expect(vjTagWerte('oliv', { actualRevenue: 0, foodRevenue: 500 })).toBeNull();
    expect(vjTagWerte('beaulieu', {})).toBeNull();
  });
});

describe('foodBeverageSplit — taVollFood (Oliv: TA 100% Food)', () => {
  const base: UmsatzTag = {
    datum: '2026-07-01', gesamtBrutto: 10000, takeAwayBrutto: 2000,
    foodBrutto: 5000, beverageBrutto: 2500, marketingNetto: 100,
  };

  it('mit Flag: TA-Netto vollständig in Food, übriger Rest 50/50, Invariante hält', () => {
    const tag = { ...base, taVollFood: true };
    const s = foodBeverageSplit(tag);
    const fd = tag.foodBrutto / 1.081, bd = tag.beverageBrutto / 1.081;
    const taNetto = tag.takeAwayBrutto / 1.026;
    const rest = nettoUmsatzTag(tag) - fd - bd - taNetto;
    expect(s.food).toBeCloseTo(fd + taNetto + rest / 2, 6);
    expect(s.beverage).toBeCloseTo(bd + rest / 2, 6);
    expect(s.food + s.beverage).toBeCloseTo(nettoUmsatzTag(tag), 10);
  });

  it('ohne Flag (Beaulieu): TA bliebe im 50/50-Rest — Beverage erhält TA-Hälfte', () => {
    const mit = foodBeverageSplit({ ...base, taVollFood: true });
    const ohne = foodBeverageSplit(base);
    const taNetto = base.takeAwayBrutto / 1.026;
    expect(mit.food - ohne.food).toBeCloseTo(taNetto / 2, 6);
    expect(ohne.beverage - mit.beverage).toBeCloseTo(taNetto / 2, 6);
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
