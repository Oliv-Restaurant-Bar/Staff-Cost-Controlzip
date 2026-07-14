/**
 * budget-day.ts
 * ─────────────
 * Zentrales Utility zur tagesweisen Budgetverteilung
 * nach Wochentagsgewichten aus den Einstellungen.
 *
 * Gewichte werden als Ganzzahl-Prozentwerte gespeichert (Summe = 100):
 *   { 0: 10, 1: 10, 2: 10, 3: 10, 4: 10, 5: 25, 6: 25 }
 *   0 = Sonntag, 1 = Montag, ..., 6 = Samstag
 *
 * Logik:
 *   Tagesbudget(d) = MonatsBudget * Gewicht(wochentag(d)) / Anzahl_dieses_Wochentags_im_Monat
 *   Summe aller Tagesbudgets im Monat ≈ MonatsBudget (Rundungsdifferenz auf letzten Tag)
 */

const WEEKDAY_PERCENTAGES_KEY = 'revenue_weekday_percentages';

const DEFAULT_WEIGHTS: Record<number, number> = {
  0: 10, // Sonntag
  1: 10, // Montag
  2: 10, // Dienstag
  3: 10, // Mittwoch
  4: 10, // Donnerstag
  5: 25, // Freitag
  6: 25, // Samstag
};

const WEEKDAY_NAMES = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/**
 * Wochentagsgewichte aus localStorage laden.
 * Gibt normierte Dezimalbrüche zurück (Summe = 1.0).
 */
export function loadWeekdayWeights(): Record<number, number> {
  try {
    const saved = localStorage.getItem(WEEKDAY_PERCENTAGES_KEY);
    const raw: Record<number, number> = saved ? JSON.parse(saved) : DEFAULT_WEIGHTS;
    const total = Object.values(raw).reduce((s, v) => s + (v as number), 0) || 100;
    const weights: Record<number, number> = {};
    for (let d = 0; d <= 6; d++) {
      weights[d] = (raw[d] ?? DEFAULT_WEIGHTS[d] ?? 0) / total;
    }
    return weights;
  } catch {
    const weights: Record<number, number> = {};
    for (let d = 0; d <= 6; d++) weights[d] = DEFAULT_WEIGHTS[d] / 100;
    return weights;
  }
}

/**
 * Anzahl jedes Wochentags im Monat berechnen.
 */
function countWeekdaysInMonth(year: number, month: number): Record<number, number> {
  const daysInMonth = new Date(year, month, 0).getDate();
  const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (let d = 1; d <= daysInMonth; d++) {
    counts[new Date(year, month - 1, d).getDay()]++;
  }
  return counts;
}

/**
 * Tagesweise Budgetverteilung für einen vollen Monat.
 *
 * @param monthlyBudget  Gesamtbudget des Monats in CHF
 * @param year           z.B. 2026
 * @param month          1-basiert (1=Januar, 12=Dezember)
 * @param weights        Dezimale Wochentagsgewichte (0–6 → 0.0–1.0, Summe ≈ 1)
 * @returns Record<'YYYY-MM-DD', dailyBudget>
 */
export function computeMonthlyDailyBudgets(
  monthlyBudget: number,
  year: number,
  month: number,
  weights: Record<number, number>,
): Record<string, number> {
  if (monthlyBudget <= 0) return {};

  const daysInMonth = new Date(year, month, 0).getDate();
  const weekdayCounts = countWeekdaysInMonth(year, month);
  const mm = String(month).padStart(2, '0');

  const result: Record<string, number> = {};
  let distributed = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const wd = new Date(year, month - 1, d).getDay();
    const count = weekdayCounts[wd];
    const dayBudget = count > 0 ? (monthlyBudget * weights[wd]) / count : 0;
    const rounded = Math.round(dayBudget * 100) / 100;
    const dateStr = `${year}-${mm}-${String(d).padStart(2, '0')}`;
    result[dateStr] = rounded;
    distributed += rounded;
  }

  // Rundungskorrektur auf den letzten Tag
  const diff = Math.round((monthlyBudget - distributed) * 100) / 100;
  if (Math.abs(diff) > 0.001) {
    const lastDate = `${year}-${mm}-${String(daysInMonth).padStart(2, '0')}`;
    result[lastDate] = Math.round((result[lastDate] + diff) * 100) / 100;
  }

  return result;
}

/**
 * Pro-rata Budget bis und mit cutoffDay (inklusiv), weekday-gewichtet.
 * Entspricht der Summe der Tagesbudgets von Tag 1 bis Tag cutoffDay.
 *
 * @param monthlyBudget  Gesamtbudget des Monats in CHF
 * @param year           z.B. 2026
 * @param month          1-basiert
 * @param cutoffDay      Stichtag (1-basiert, inklusiv). null → volles Monatsbudget.
 * @param weights        Dezimale Wochentagsgewichte
 * @returns CHF-Betrag des Pro-Rata-Budgets
 */
export function computeProRataBudget(
  monthlyBudget: number,
  year: number,
  month: number,
  cutoffDay: number | null,
  weights: Record<number, number>,
): number {
  if (monthlyBudget <= 0) return 0;
  if (cutoffDay === null) return monthlyBudget;

  const dailyBudgets = computeMonthlyDailyBudgets(monthlyBudget, year, month, weights);
  const mm = String(month).padStart(2, '0');
  let total = 0;
  for (let d = 1; d <= cutoffDay; d++) {
    const dateStr = `${year}-${mm}-${String(d).padStart(2, '0')}`;
    total += dailyBudgets[dateStr] ?? 0;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Einzel-API: Tagesbudget-Map für einen Monat (inkl. Wochentagsgewichten aus Einstellungen).
 * Single Source of Truth — ALLE Stellen sollen diese Funktion verwenden.
 *
 * @param monthlyBudget  Monatsbudget in CHF (Umsatz oder Personal)
 * @param year           z.B. 2026
 * @param month          1-basiert (1=Januar, 12=Dezember)
 * @returns              Record<'YYYY-MM-DD', dailyBudget>
 */
export function getDailyBudgetMap(
  monthlyBudget: number,
  year: number,
  month: number,
): Record<string, number> {
  if (monthlyBudget <= 0) return {};
  const weights = loadWeekdayWeights();
  const map     = computeMonthlyDailyBudgets(monthlyBudget, year, month, weights);

  // ── [BUDGET-FIX] Debug-Ausgabe ──────────────────────────────────────────
  const mm   = String(month).padStart(2, '0');
  const wdNm = ['So','Mo','Di','Mi','Do','Fr','Sa'];

  const wdCounts: Record<string, number> = {};
  for (let d = 0; d <= 6; d++) wdCounts[wdNm[d]] = 0;
  Object.keys(map).forEach(k => { wdCounts[wdNm[new Date(k).getDay()]]++; });

  const wdWeights: Record<string, string> = {};
  for (let d = 0; d <= 6; d++) wdWeights[wdNm[d]] = (weights[d] * 100).toFixed(1) + '%';

  console.log(`[BUDGET-FIX] getDailyBudgetMap ${year}-${mm}: budget=${monthlyBudget.toFixed(0)}`);
  console.log(`[BUDGET-FIX] weekday distribution: ${JSON.stringify(wdWeights)}`);
  console.log(`[BUDGET-FIX] weekday counts: ${JSON.stringify(wdCounts)}`);
  const sampleDays = Object.keys(map).sort().slice(0, 5);
  sampleDays.forEach(k => {
    const d = parseInt(k.slice(8), 10);
    console.log(`[BUDGET-FIX] daily budget ${String(d).padStart(2,'0')}.${mm}: ${(map[k] ?? 0).toFixed(2)}`);
  });
  const total = Object.values(map).reduce((s, v) => s + v, 0);
  console.log(`[BUDGET-FIX] total: ${total.toFixed(2)} (vs budget: ${monthlyBudget.toFixed(2)})`);
  return map;
}

/**
 * Weekday-gewichtetes Pro-Rata-Budget bis Stichtag (kumuliert).
 * Entspricht der Summe der Tagesbudgets von Tag 1 bis Tag cutoffDay.
 * Verwendet getDailyBudgetMap als Basis.
 *
 * @param monthlyBudget  Monatsbudget in CHF
 * @param year           z.B. 2026
 * @param month          1-basiert
 * @param cutoffDay      Stichtag 1-basiert inklusiv. null → volles Monatsbudget.
 * @returns CHF-Betrag
 */
export function getCumulativeBudget(
  monthlyBudget: number,
  year: number,
  month: number,
  cutoffDay: number | null,
): number {
  if (monthlyBudget <= 0) return 0;
  if (cutoffDay === null) return monthlyBudget;
  const map = getDailyBudgetMap(monthlyBudget, year, month);
  const mm  = String(month).padStart(2, '0');
  let total = 0;
  for (let d = 1; d <= cutoffDay; d++) {
    total += map[`${year}-${mm}-${String(d).padStart(2, '0')}`] ?? 0;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Debug-Logs für die tagesweise Budgetverteilung.
 * Ausgabe nur wenn `personnelBudget > 0`.
 */
export function logBudgetDayDebug(
  monthlyBudget: number,
  year: number,
  month: number,
  weights: Record<number, number>,
  cutoffDay?: number | null,
): void {
  if (monthlyBudget <= 0) return;

  const dailyBudgets = computeMonthlyDailyBudgets(monthlyBudget, year, month, weights);
  const mm = String(month).padStart(2, '0');

  const weightsPct: Record<string, string> = {};
  for (let d = 0; d <= 6; d++) weightsPct[WEEKDAY_NAMES[d]] = (weights[d] * 100).toFixed(1) + '%';

  const counts = countWeekdaysInMonth(year, month);
  const countsFmt: Record<string, number> = {};
  for (let d = 0; d <= 6; d++) countsFmt[WEEKDAY_NAMES[d]] = counts[d];

  console.log(`[BUDGET-DAY] monthly budget: ${monthlyBudget.toFixed(2)}`);
  console.log(`[BUDGET-DAY] weekday weights: ${JSON.stringify(weightsPct)}`);
  console.log(`[BUDGET-DAY] month weekday counts: ${JSON.stringify(countsFmt)}`);

  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= Math.min(3, daysInMonth); d++) {
    const dateStr = `${year}-${mm}-${String(d).padStart(2, '0')}`;
    console.log(`[BUDGET-DAY] daily budget for ${dateStr}: ${(dailyBudgets[dateStr] ?? 0).toFixed(2)}`);
  }

  const total = Object.values(dailyBudgets).reduce((s, v) => s + v, 0);
  console.log(`[BUDGET-DAY] total distributed budget: ${total.toFixed(2)}`);

  if (cutoffDay !== null && cutoffDay !== undefined) {
    let proRata = 0;
    for (let d = 1; d <= cutoffDay; d++) {
      const dateStr = `${year}-${mm}-${String(d).padStart(2, '0')}`;
      proRata += dailyBudgets[dateStr] ?? 0;
    }
    console.log(`[BUDGET-DAY] pro-rata budget until day ${cutoffDay}: ${proRata.toFixed(2)}`);
  }
}
