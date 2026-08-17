// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Employee } from '@/types/personnel';

// personalkosten.ts zieht über supabase-db den Supabase-Client (localStorage)
// herein. Für die reinen Rechenfunktionen mocken wir die IO-Module weg.
vi.mock('@/lib/supabase-db', () => ({
  loadEmployees: vi.fn(),
  loadScheduleForMonth: vi.fn(),
  loadActualHoursForMonth: vi.fn(),
}));
vi.mock('@/lib/umsatz', () => ({ ladeUmsatzTage: vi.fn(), nettoUmsatzTag: vi.fn() }));
vi.mock('@/lib/wage-history', () => ({ applyEffectiveWages: vi.fn(), firstOfMonth: vi.fn() }));
vi.mock('@/lib/budgetDistribution', () => ({ getMonthlyBudgetRevenue: vi.fn() }));
vi.mock('@/lib/ziel-personalquote', () => ({
  loadZielPersonalquoteLocal: vi.fn(() => ({ pct: 35.5 })),
}));
vi.mock('@/hooks/useShiftConfig', () => ({ calculateDayNetHours: vi.fn() }));
import { DEFAULT_SOCIAL_COST_RATES, socialCostFactorFromRates } from '@/lib/social-costs';
import {
  getEffectiveIstQuelle,
  flexKostenProTagDetail,
  personalkosten,
  type PersonalkostenDaten,
} from '@/lib/personalkosten';

// ── Fixtures ──────────────────────────────────────────────────────────────
const flexEmp = (id: string, istQuelle?: Employee['istQuelle']): Employee => ({
  id,
  name: id,
  department: 'service',
  employmentType: 'aushilfe',
  hourlyWage: 30,
  ...(istQuelle ? { istQuelle } : {}),
});

const fixEmp = (id: string, istQuelle?: Employee['istQuelle']): Employee => ({
  id,
  name: id,
  department: 'service',
  employmentType: 'vollzeit',
  hourlyWage: 0,
  monthlySalary: 5000,
  ...(istQuelle ? { istQuelle } : {}),
});

describe('getEffectiveIstQuelle', () => {
  it('gesetztes Stammfeld hat Vorrang', () => {
    expect(getEffectiveIstQuelle(flexEmp('a', 'manuell'))).toBe('manuell');
    expect(getEffectiveIstQuelle(fixEmp('b', 'plan'))).toBe('plan');
  });

  it('Default: Monatslohn-MA → mirus, Stundenlohn/Aushilfe → plan', () => {
    expect(getEffectiveIstQuelle(fixEmp('c'))).toBe('mirus');
    expect(getEffectiveIstQuelle(flexEmp('d'))).toBe('plan');
  });

  it('ignoriert ungültige Werte und fällt auf Default zurück', () => {
    const bad = { ...flexEmp('e'), istQuelle: 'xxx' as unknown as Employee['istQuelle'] };
    expect(getEffectiveIstQuelle(bad)).toBe('plan');
  });
});

// ── Tag-Regel mit Ist-Quelle ─────────────────────────────────────────────
// Monat mit 5 Tagen, Stichtag = 3 (Tage 1-3 vergangen, 4-5 künftig).
function makeDaten(flexEmployees: Employee[], opts: {
  plan?: Record<string, Record<string, number>>;
  ist?: Record<string, Record<string, number>>;
}): PersonalkostenDaten {
  return {
    year: 2026,
    month: 1,
    daysInMonth: 5,
    fixEmployees: [],
    flexEmployees,
    agFactor: socialCostFactorFromRates(DEFAULT_SOCIAL_COST_RATES),
    rates: DEFAULT_SOCIAL_COST_RATES,
    planStdProTag: opts.plan ?? {},
    istStdProTag: opts.ist ?? {},
    istTage: new Set(Object.keys(opts.ist ?? {})),
    umsatzIstProTag: {},
    umsatzBudgetMonat: 0,
    zielQuotePct: 35.5,
    pkBudgetMonat: null,
    gewichte: {},
  };
}

describe('flexKostenProTagDetail — Ist-Quelle-Regel', () => {
  const D = (d: number) => `2026-01-0${d}`;

  it("'plan': Plan gilt als Ist an vergangenen Tagen", () => {
    const emp = flexEmp('p', 'plan');
    const daten = makeDaten([emp], {
      plan: { [D(1)]: { p: 4 }, [D(4)]: { p: 4 } },
      ist: {}, // keine Ist-Stunden vorhanden
    });
    const { tage, istFehltTage } = flexKostenProTagDetail(daten, { stichtag: 3 });
    const rate = tage.find(t => t.date === D(1))!.proMa.p.chfProStd;
    // vergangener Tag → Ist = Plan
    expect(tage.find(t => t.date === D(1))!.istKosten).toBeCloseTo(4 * rate, 0);
    // künftiger Tag → nicht als Ist
    expect(tage.find(t => t.date === D(4))!.istKosten).toBe(0);
    // 'plan' erzeugt nie «Ist fehlt»
    expect(istFehltTage).toHaveLength(0);
  });

  it("'mirus' mit vorhandenem Ist: Ist-Stunden zählen", () => {
    const emp = flexEmp('m', 'mirus');
    const daten = makeDaten([emp], {
      plan: { [D(1)]: { m: 4 } },
      ist: { [D(1)]: { m: 5 } },
    });
    const { tage, istFehltTage } = flexKostenProTagDetail(daten, { stichtag: 3 });
    const zelle = tage.find(t => t.date === D(1))!.proMa.m;
    expect(zelle.istStd).toBe(5);
    expect(tage.find(t => t.date === D(1))!.istKosten).toBeCloseTo(5 * zelle.chfProStd, 0);
    expect(istFehltTage).toHaveLength(0);
  });

  it("'mirus' ohne Ist an vergangenem Tag → «Ist fehlt», mit Plan gerechnet (nicht 0)", () => {
    const emp = flexEmp('m', 'mirus');
    const daten = makeDaten([emp], {
      plan: { [D(2)]: { m: 6 } },
      ist: {}, // Ist fehlt trotz Plan
    });
    const { tage, istFehltTage } = flexKostenProTagDetail(daten, { stichtag: 3 });
    const tag = tage.find(t => t.date === D(2))!;
    expect(tag.proMa.m.istFehlt).toBe(true);
    // mit Plan gerechnet, NICHT still 0
    expect(tag.istKosten).toBeCloseTo(tag.planKosten, 2);
    expect(tag.istKosten).toBeGreaterThan(0);
    expect(istFehltTage).toContain(`${D(2)}|m`);
  });

  it("künftiger Tag ist nie «Ist fehlt» (auch ohne Ist)", () => {
    const emp = flexEmp('m', 'mirus');
    const daten = makeDaten([emp], {
      plan: { [D(5)]: { m: 6 } },
      ist: {},
    });
    const { tage, istFehltTage } = flexKostenProTagDetail(daten, { stichtag: 3 });
    const tag = tage.find(t => t.date === D(5))!;
    expect(tag.istTag).toBe(false);
    expect(tag.istKosten).toBe(0);
    expect(istFehltTage).toHaveLength(0);
  });
});

describe('K/U-Anrechnung (Spec 08/2026)', () => {
  const D = (d: number) => `2026-01-0${d}`;

  it("'mirus' ohne Ist am K/U-Tag → Plan angerechnet, KEIN «Ist fehlt»", () => {
    const emp = flexEmp('m', 'mirus');
    const daten = makeDaten([emp], { plan: { [D(2)]: { m: 8 } }, ist: {} });
    daten.absenzKreditTageProMa = new Set([`${D(2)}|m`]);
    const { tage, istFehltTage } = flexKostenProTagDetail(daten, { stichtag: 3 });
    const tag = tage.find(t => t.date === D(2))!;
    expect(tag.proMa.m.absenzAngerechnet).toBe(true);
    expect(tag.proMa.m.istFehlt).toBeUndefined();
    expect(tag.istKosten).toBeCloseTo(8 * tag.proMa.m.chfProStd, 0);
    expect(istFehltTage).toHaveLength(0);
  });

  it('FE/FT bei Flex-MA: KEINE Anrechnung — Tag fällt aus dem Flex-Stapel (Spec final)', () => {
    // Loader nimmt FE/FT-Einsätze gar nicht in planStdProTag auf und erfasst
    // sie nicht in absenzKreditTageProMa → Zelle existiert nicht, keine Kosten.
    const emp = flexEmp('m', 'mirus');
    const daten = makeDaten([emp], { plan: { [D(2)]: { m: 6 } }, ist: {} });
    const { tage, istFehltTage } = flexKostenProTagDetail(daten, { stichtag: 3 });
    expect(tage.find(t => t.date === D(1))!.proMa.m).toBeUndefined();
    expect(istFehltTage).toEqual([`${D(2)}|m`]); // normaler Arbeitstag ohne Ist bleibt markiert
  });

  it('MIRUS-Ist > 0 überschreibt: kein K/U-Kredit, echtes Ist zählt', () => {
    const emp = flexEmp('m', 'mirus');
    const daten = makeDaten([emp], { plan: { [D(2)]: { m: 8 } }, ist: { [D(2)]: { m: 7 } } });
    daten.absenzKreditTageProMa = new Set([`${D(2)}|m`]);
    const { tage } = flexKostenProTagDetail(daten, { stichtag: 3 });
    const tag = tage.find(t => t.date === D(2))!;
    expect(tag.proMa.m.absenzAngerechnet).toBeUndefined();
    expect(tag.istKosten).toBeCloseTo(7 * tag.proMa.m.chfProStd, 0);
  });

  it('Split-Pseudo-id ::flexsplit findet den K/U-Tag der Basis-id', () => {
    const emp = flexEmp('x::flexsplit', 'mirus');
    const daten = makeDaten([emp], { plan: { [D(1)]: { 'x::flexsplit': 5 } }, ist: {} });
    daten.absenzKreditTageProMa = new Set([`${D(1)}|x`]);
    const { tage, istFehltTage } = flexKostenProTagDetail(daten, { stichtag: 3 });
    expect(tage.find(t => t.date === D(1))!.proMa['x::flexsplit'].absenzAngerechnet).toBe(true);
    expect(istFehltTage).toHaveLength(0);
  });

  it('K/U-Tag ohne Plan-Basis → nichts angerechnet (leer, nie geraten)', () => {
    const emp = flexEmp('m', 'mirus');
    const daten = makeDaten([emp], { plan: {}, ist: {} });
    daten.absenzKreditTageProMa = new Set([`${D(1)}|m`]);
    const { tage } = flexKostenProTagDetail(daten, { stichtag: 3 });
    expect(tage.find(t => t.date === D(1))!.istKosten).toBe(0);
  });
});

describe('personalkosten — Modi + istFehltTage durchgereicht', () => {
  const D = (d: number) => `2026-01-0${d}`;

  it('hochrechnung = Ist (vergangen) + Plan (Rest); istBisHeute nur vergangen', () => {
    const emp = flexEmp('m', 'mirus');
    const daten = makeDaten([emp], {
      plan: { [D(1)]: { m: 4 }, [D(5)]: { m: 4 } },
      ist: { [D(1)]: { m: 4 } },
    });
    const rate = flexKostenProTagDetail(daten).tage.find(t => t.date === D(1))!.proMa.m.chfProStd;
    const kIst = personalkosten(daten, 'istBisHeute', { stichtag: 3 });
    const kHr = personalkosten(daten, 'hochrechnung', { stichtag: 3 });
    // Ist bis Stichtag = nur Tag 1 (4h)
    expect(kIst.flex).toBeCloseTo(4 * rate, 0);
    // Hochrechnung = Tag 1 Ist (4h) + Tag 5 Plan (4h)
    expect(kHr.flex).toBeCloseTo(8 * rate, 0);
    expect(Array.isArray(kIst.istFehltTage)).toBe(true);
  });

  it('reicht «Ist fehlt» in beiden Modi weiter', () => {
    const emp = flexEmp('m', 'mirus');
    const daten = makeDaten([emp], { plan: { [D(2)]: { m: 6 } }, ist: {} });
    expect(personalkosten(daten, 'istBisHeute', { stichtag: 3 }).istFehltTage).toContain(`${D(2)}|m`);
    expect(personalkosten(daten, 'hochrechnung', { stichtag: 3 }).istFehltTage).toContain(`${D(2)}|m`);
  });

  it('Kopf-Kachel FLEX (kHr.flex) ist Ist+Plan, NICHT reiner Plan, wenn Ist ≠ Plan', () => {
    // Vergangener Tag 1: Plan 4h, aber Ist 6h (mehr gearbeitet). Zukunft Tag 5: Plan 4h.
    // Reiner Monatsplan wäre (4+4)=8h; korrekte Hochrechnung = Ist 6h + Plan 4h = 10h.
    const emp = flexEmp('m', 'mirus');
    const daten = makeDaten([emp], {
      plan: { [D(1)]: { m: 4 }, [D(5)]: { m: 4 } },
      ist:  { [D(1)]: { m: 6 } },
    });
    const rate = flexKostenProTagDetail(daten).tage.find(t => t.date === D(1))!.proMa.m.chfProStd;
    const kHr = personalkosten(daten, 'hochrechnung', { stichtag: 3 });
    // Beweist: HR-FLEX = 10h × rate (Ist 6 + Plan 4), NICHT 8h (reiner Plan).
    expect(kHr.flex).toBeCloseTo(10 * rate, 0);
    expect(kHr.flex).not.toBeCloseTo(8 * rate, 0);
  });
});
