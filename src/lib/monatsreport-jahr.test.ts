// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Reine Logik-Tests der Quellen-Weiche im Wochenverlauf. Alle I/O-Bausteine
// werden gemockt, damit ladeWochenverlauf unter node ohne Netzwerk/Browser läuft.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

const ladeUmsatzTage = vi.fn();
const nettoUmsatzTag = vi.fn((t: { gesamtBrutto: number }) => t.gesamtBrutto / 1.081);
const foodBeverageSplit = vi.fn(() => ({ food: 0, beverage: 0 }));
vi.mock('@/lib/umsatz', () => ({
  ladeUmsatzTage: (...a: unknown[]) => ladeUmsatzTage(...a),
  nettoUmsatzTag: (...a: unknown[]) => nettoUmsatzTag(...(a as [{ gesamtBrutto: number }])),
  foodBeverageSplit: (...a: unknown[]) => foodBeverageSplit(),
}));

const loadVjDailyMonth = vi.fn();
vi.mock('@/lib/vj-daily-supabase', () => ({
  loadVjDailyMonth: (...a: unknown[]) => loadVjDailyMonth(...a),
}));

const ladePersonalkostenDaten = vi.fn();
vi.mock('@/lib/personalkosten', () => ({
  ladePersonalkostenDaten: (...a: unknown[]) => ladePersonalkostenDaten(...a),
  ladeWochentagsGewichte: () => ({}),
}));

const loadGaesteDaily = vi.fn();
const loadAvgCheckDaily = vi.fn();
vi.mock('@/lib/gaeste-store', () => ({
  loadGaesteDaily: (...a: unknown[]) => loadGaesteDaily(...a),
  loadAvgCheckDaily: (...a: unknown[]) => loadAvgCheckDaily(...a),
  loadAvgCheckMonthly: vi.fn(async () => ({})),
}));

// budgetDistribution / budget-day werden von ladeWochenverlauf NICHT verwendet,
// aber vom Modul importiert → harmlose Stubs.
vi.mock('@/lib/budgetDistribution', () => ({ getMonthlyBudgetRevenue: () => 0 }));
vi.mock('@/lib/budget-day', () => ({ computeMonthlyDailyBudgets: () => ({}) }));

import { ladeWochenverlauf } from './monatsreport';

const tenantId = 't1' as never;
const tenantKey = (k: string) => k;
const rates = {} as never;
const heute = new Date(2025, 6, 16); // Mi 16.07.2025

beforeEach(() => {
  vi.clearAllMocks();
  ladeUmsatzTage.mockResolvedValue(new Map());
  loadVjDailyMonth.mockResolvedValue({});
  ladePersonalkostenDaten.mockResolvedValue({ istStdProTag: {}, planStdProTag: {} });
  loadGaesteDaily.mockResolvedValue({});
  loadAvgCheckDaily.mockResolvedValue({});
});

describe('ladeWochenverlauf – Quellen-Weiche je Jahr', () => {
  it('aktuelles Jahr: Hauptlinie aus ladeUmsatzTage + Personalstunden (kein vj_daily ohne Toggle)', async () => {
    await ladeWochenverlauf(4, tenantId, tenantKey, rates, heute, false, 2025);
    expect(ladeUmsatzTage).toHaveBeenCalledTimes(1);
    expect(ladePersonalkostenDaten).toHaveBeenCalled();     // Stunden fürs aktuelle Jahr
    expect(loadVjDailyMonth).not.toHaveBeenCalled();        // ohne Vorjahresvergleich keine vj_daily
  });

  it('vergangenes Jahr: Hauptlinie aus vj_daily, KEIN ladeUmsatzTage, KEINE Personalstunden', async () => {
    const daten = await ladeWochenverlauf(4, tenantId, tenantKey, rates, heute, false, 2024);
    expect(ladeUmsatzTage).not.toHaveBeenCalled();          // kein dailyBudgets-Pfad
    expect(ladePersonalkostenDaten).not.toHaveBeenCalled(); // keine Stunden für Vergangenheit
    expect(loadVjDailyMonth).toHaveBeenCalled();            // vj_daily als Hauptquelle
    // Produktive Stunden/Produktivität → keine Quelle → alle Wochen leer.
    const istRow = daten.rows.find(r => r.label === 'Stunden — Plan (Budget) / Ist (MIRUS)')!;
    expect(istRow.values.every(v => v === null)).toBe(true);
    const prodRow = daten.rows.find(r => r.label === 'Produktivität (Umsatz/Std)')!;
    expect(prodRow.values.every(v => v === null)).toBe(true);
  });

  it('vergangenes Jahr + Vorjahr-Toggle: vj_daily für Haupt- UND Vergleichsjahr, vjWeeks gesetzt', async () => {
    const daten = await ladeWochenverlauf(4, tenantId, tenantKey, rates, heute, true, 2025);
    // aktuelles Jahr als Auswahl → Hauptlinie Ist, Vergleich (2024) aus vj_daily.
    expect(ladeUmsatzTage).toHaveBeenCalledTimes(1);
    expect(loadVjDailyMonth).toHaveBeenCalled();
    expect(daten.vjWeeks).toBeDefined();
    expect(daten.vjWeeks!.length).toBe(daten.weeks.length);
    const brutto = daten.rows.find(r => r.label === 'Brutto Umsatz')!;
    expect(brutto.vjValues).toBeDefined();
  });

  it('Default (kein jahr-Parameter) = aktuelles Jahr, rückwärtskompatibel', async () => {
    await ladeWochenverlauf(4, tenantId, tenantKey, rates, heute);
    expect(ladeUmsatzTage).toHaveBeenCalledTimes(1);
    expect(loadVjDailyMonth).not.toHaveBeenCalled();
  });
});
