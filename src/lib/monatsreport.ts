/**
 * Monatsreport — zentrale Datenaufbereitung fürs Meeting-Cockpit
 * ==============================================================
 * Etappe 1: nur automatisch füllbare Zeilen. Fehlende Quellen bleiben null
 * (werden in der UI/Excel leer dargestellt, nie als 0 erfunden).
 *
 * Quellen (alles vorhandene, keine neuen Tabellen):
 *  - Umsatz (brutto/netto/TA/Food/Beverage): kanonische Quelle src/lib/umsatz.ts
 *    (gn_imports Tages-Z-Berichte + gn_discounts Marketing) — SSOT, identisch
 *    mit den Personalkosten
 *  - Gäste:                   gaeste-daily-KV (manueller GÄSTE-Import, Zeile «Gesamt»)
 *  - Durchschnittsverkauf:    avgcheck-monthly/-daily-KV (manueller Import, Zeile «Durchschnitt»)
 *  - Gruppen ab 20 Pax:       reservation_records (Foratable-Import, party_size >= 20)
 *  - Budget:                  budget_v1 (P&L pl_revenue, netto) via getMonthlyBudgetRevenue
 *  - Wochenanteil Budget:     Wochentagsgewichte (ladeWochentagsGewichte, Fallback gleichmässig)
 *  - Vorjahr:                 vj_daily (app_settings) via loadVjDailyMonth
 *  - Stunden Ist/Plan:        ladePersonalkostenDaten (MIRUS actual_hours / Dienstplan)
 */
import { supabase } from '@/integrations/supabase/client';
import { ladeUmsatzTage, nettoUmsatzTag, foodBeverageSplit } from '@/lib/umsatz';
import { getMonthlyBudgetRevenue } from '@/lib/budgetDistribution';
import { computeMonthlyDailyBudgets } from '@/lib/budget-day';
import { ladeWochentagsGewichte, ladePersonalkostenDaten } from '@/lib/personalkosten';
import { loadGaesteDaily, loadAvgCheckDaily, loadAvgCheckMonthly } from '@/lib/gaeste-store';
import { loadVjDailyMonth } from '@/lib/vj-daily-supabase';
import type { TenantId } from '@/contexts/TenantContext';
import type { SocialCostRates } from '@/lib/social-costs';

type KeyFn = (key: string) => string;

const VAT_STD = 1.081;
const pad2 = (n: number) => String(n).padStart(2, '0');
const r2 = (v: number) => Math.round(v * 100) / 100;

// ── Wochen-Auswahl ─────────────────────────────────────────────────────────

export type WeekSelection =
  | { kind: 'lastComplete' }
  | { kind: 'current' }
  | { kind: 'last7' }
  /** ISO-Kalenderwoche `kw` des ISO-Wochenjahres `kwYear`.
   *  `kwYear` ist WICHTIG am Jahreswechsel (Dez → KW 1 Folgejahr,
   *  Jan → KW 52/53 Vorjahr). Fehlt kwYear, gilt das Report-Jahr. */
  | { kind: 'kw'; kw: number; kwYear?: number };

const iso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Montag (00:00) der Woche, die `d` enthält (ISO: Mo=Wochenanfang). */
function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Mo=0
  x.setDate(x.getDate() - dow);
  return x;
}

/** Montag (00:00) der ISO-Kalenderwoche `kw` im gegebenen Jahr. */
function mondayOfIsoWeek(year: number, kw: number): Date {
  // ISO: Woche 1 enthält den 4. Januar (bzw. den ersten Donnerstag).
  const jan4 = new Date(year, 0, 4);
  const week1Monday = mondayOf(jan4);
  const d = new Date(week1Monday);
  d.setDate(d.getDate() + (kw - 1) * 7);
  return d;
}

/** Label für eine Wochen-Auswahl (für UI/Spaltenüberschrift). */
export function weekSelectionLabel(sel: WeekSelection): string {
  switch (sel.kind) {
    case 'current': return 'Aktuelle Woche';
    case 'last7': return 'Letzte 7 Tage';
    case 'kw': return `KW ${sel.kw}`;
    case 'lastComplete':
    default: return 'Letzte abgeschl. Woche';
  }
}

/**
 * Berechnet den ungeklemmten Wochen-Zeitraum (Mo–So bzw. rollend) für eine
 * Auswahl, dann geklemmt auf [fromIso, min(toIso, istToIso)].
 * Ergibt die Klemmung einen leeren Bereich → { weekFrom: null, weekTo: null }.
 * Reine Funktion (keine I/O) — testbar.
 */
export function computeWeekRange(
  sel: WeekSelection,
  year: number,
  fromIso: string,
  toIso: string,
  istToIso: string,   // '' = Zukunftsmonat (kein Ist)
  heute: Date,
): { weekFrom: string | null; weekTo: string | null } {
  let rawFrom: Date;
  let rawTo: Date;
  const today = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate());

  switch (sel.kind) {
    case 'current': {
      rawFrom = mondayOf(today);
      rawTo = today;
      break;
    }
    case 'last7': {
      rawTo = today;
      rawFrom = new Date(today);
      rawFrom.setDate(rawFrom.getDate() - 6);
      break;
    }
    case 'kw': {
      // ISO-Wochenjahr verwenden (Fallback: Report-Jahr) — sonst springt der
      // Zeitraum am Jahreswechsel ins falsche Jahr.
      rawFrom = mondayOfIsoWeek(sel.kwYear ?? year, sel.kw);
      rawTo = new Date(rawFrom);
      rawTo.setDate(rawTo.getDate() + 6);
      break;
    }
    case 'lastComplete':
    default: {
      // Letzte vollständig abgeschlossene Woche Mo–So vor der laufenden Woche.
      const thisMonday = mondayOf(today);
      rawFrom = new Date(thisMonday);
      rawFrom.setDate(rawFrom.getDate() - 7);
      rawTo = new Date(thisMonday);
      rawTo.setDate(rawTo.getDate() - 1);
      break;
    }
  }

  const upper = istToIso ? (istToIso < toIso ? istToIso : toIso) : '';
  // Kein Ist verfügbar (Zukunftsmonat) → leer.
  if (!upper) return { weekFrom: null, weekTo: null };

  let wf = iso(rawFrom);
  let wt = iso(rawTo);
  if (wf < fromIso) wf = fromIso;
  if (wt > upper) wt = upper;
  if (wf > wt) return { weekFrom: null, weekTo: null };
  return { weekFrom: wf, weekTo: wt };
}

// ── Zeilenmodell ─────────────────────────────────────────────────────────────

export type MrFormat = 'chf' | 'count' | 'pct' | 'hours';

export interface MrRow {
  type: 'data' | 'empty';
  label?: string;
  fmt?: MrFormat;
  bold?: boolean;
  /** Spalte «Budget» */
  budget: number | null;
  /** Spalte «Vorjahr» */
  vj: number | null;
  /** Spalte «Woche» (Ist der aktuellen Woche) */
  week: number | null;
  /** Budget-Wochenanteil (Basis für +/- der Woche, nicht als Spalte gezeigt) */
  weekBudget: number | null;
  /** Spalte «Monat» (Ist bis heute) */
  month: number | null;
}

export interface MonatsreportDaten {
  year: number;
  month: number; // 1-basiert
  /** Zeitraum der «Woche»-Spalte (leer, wenn geklemmter Bereich leer ist) */
  weekFrom: string | null;
  weekTo: string | null;
  /** Beschriftung der «Woche»-Auswahl (z.B. "KW 30", "Aktuelle Woche") */
  weekLabel: string;
  rows: MrRow[];
}

// ── Hilfen ───────────────────────────────────────────────────────────────────

/** Gruppen ab 20 Pax im Monat (Foratable-Reservationen, ohne Stornos). */
async function countGroupsFrom20Pax(
  tenantId: TenantId, fromIso: string, toIso: string,
): Promise<number | null> {
  try {
    const { count, error } = await (supabase as any)
      .from('reservation_records')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', tenantId)
      .gte('reservation_date', fromIso)
      .lte('reservation_date', toIso)
      .gte('party_size', 20)
      .neq('status_normalized', 'cancelled');
    if (error) return null;
    return typeof count === 'number' ? count : null;
  } catch { return null; }
}

// ── Hauptlader ───────────────────────────────────────────────────────────────

export async function ladeMonatsreport(
  year: number,
  month: number, // 1-basiert
  tenantId: TenantId,
  tenantKey: KeyFn,
  rates: SocialCostRates,
  heute: Date = new Date(),
  weekSelection: WeekSelection = { kind: 'lastComplete' },
): Promise<MonatsreportDaten> {
  const mm = pad2(month);
  const daysInMonth = new Date(year, month, 0).getDate();
  const fromIso = `${year}-${mm}-01`;
  const toIso = `${year}-${mm}-${pad2(daysInMonth)}`;
  const todayIso = `${heute.getFullYear()}-${pad2(heute.getMonth() + 1)}-${pad2(heute.getDate())}`;
  const isCurrentMonth = heute.getFullYear() === year && heute.getMonth() + 1 === month;
  const isFutureMonth = new Date(year, month - 1, 1) > heute;
  /** Ist-Grenze: laufender Monat = bis heute, vergangene Monate = ganzer Monat. */
  const istToIso = isFutureMonth ? '' : (isCurrentMonth ? todayIso : toIso);

  // «Woche» = gewählte Woche, auf den Monat + Ist-Grenze geklemmt.
  // Die Spalte existiert, sobald der geklemmte Bereich nicht leer ist
  // (funktioniert damit auch für 'kw' in vergangenen Monaten).
  const weekLabel = weekSelectionLabel(weekSelection);
  const { weekFrom, weekTo } = computeWeekRange(weekSelection, year, fromIso, toIso, istToIso, heute);

  const alleTage: string[] = [];
  for (let t = 1; t <= daysInMonth; t++) alleTage.push(`${year}-${mm}-${pad2(t)}`);
  const istTage = alleTage.filter(d => istToIso && d <= istToIso);
  const wocheTage = weekFrom && weekTo ? alleTage.filter(d => d >= weekFrom! && d <= weekTo!) : [];

  // ── Parallel laden ─────────────────────────────────────────────────────────
  const vjMonth = month; // gleicher Monat im Vorjahr
  const [gaesteDaily, avgDaily, avgMonthly, vjDaily, gruppen20, pk] = await Promise.all([
    loadGaesteDaily(tenantKey).catch(() => ({} as Record<string, number>)),
    loadAvgCheckDaily(tenantKey).catch(() => ({} as Record<string, number>)),
    loadAvgCheckMonthly(tenantKey).catch(() => ({} as Record<string, number>)),
    loadVjDailyMonth(year - 1, vjMonth, tenantId),
    // Ist-Logik wie übrige Monatswerte: laufender Monat bis heute, Zukunft leer.
    istToIso ? countGroupsFrom20Pax(tenantId, fromIso, istToIso) : Promise.resolve(null),
    ladePersonalkostenDaten(year, month, tenantId, tenantKey, rates).catch(() => null),
  ]);

  // ── Umsatz Ist aus der kanonischen Netto-Quelle (src/lib/umsatz.ts) ────────
  const umsatzTage = await ladeUmsatzTage(tenantId, fromIso, toIso);
  let mGross = 0, mNet = 0, mTa = 0, mFood = 0, mBev = 0, mHatUmsatz = false;
  let wGross = 0, wNet = 0, wTa = 0, wHatUmsatz = false;
  // «Umsatz pro Gast»: Netto ÷ Gäste, aber NUR über Tage, die BEIDE Quellen
  // haben (Umsatz-Tag mit gesamtBrutto>0 UND gaesteDaily[date]>0).
  let pairedNet = 0, pairedGaeste = 0, wPairedNet = 0, wPairedGaeste = 0;
  for (const date of istTage) {
    const tag = umsatzTage.get(date);
    if (!tag || tag.gesamtBrutto <= 0) continue;
    const netto = nettoUmsatzTag(tag);
    const split = foodBeverageSplit(tag);
    mGross += tag.gesamtBrutto; mTa += tag.takeAwayBrutto; mNet += netto;
    mFood += split.food; mBev += split.beverage;
    mHatUmsatz = true;
    const inWeek = !!(weekFrom && weekTo && date >= weekFrom && date <= weekTo);
    if (inWeek) {
      wGross += tag.gesamtBrutto; wTa += tag.takeAwayBrutto; wNet += netto; wHatUmsatz = true;
    }
    const g = gaesteDaily[date] ?? 0;
    if (g > 0) {
      pairedNet += netto; pairedGaeste += g;
      if (inWeek) { wPairedNet += netto; wPairedGaeste += g; }
    }
  }

  // ── Budget (netto aus Budget-Modul) + Wochenanteil ─────────────────────────
  const budgetNet = getMonthlyBudgetRevenue(year, month - 1, tenantKey('budget_v1'));
  const gewichte = ladeWochentagsGewichte(tenantKey);
  const budgetProTag = budgetNet > 0 ? computeMonthlyDailyBudgets(budgetNet, year, month, gewichte) : {};
  const wBudgetNet = wocheTage.reduce((s, d) => s + (budgetProTag[d] ?? 0), 0);
  const hatBudget = budgetNet > 0;

  // ── Gäste (manueller GÄSTE-Import, gaeste-daily-KV) ────────────────────────
  let mGaeste = 0, wGaeste = 0, hatGaeste = false, hatWGaeste = false;
  for (const [date, n] of Object.entries(gaesteDaily)) {
    if (date < fromIso || !istToIso || date > istToIso) continue;
    if (!(n > 0)) continue;
    mGaeste += n; hatGaeste = true;
    if (weekFrom && weekTo && date >= weekFrom && date <= weekTo) { wGaeste += n; hatWGaeste = true; }
  }
  const vjFrom = `${year - 1}-${mm}-01`;
  const vjTo = `${year - 1}-${mm}-${pad2(new Date(year - 1, vjMonth, 0).getDate())}`;
  let vjGaeste = 0, hatVjGaeste = false;
  for (const [date, n] of Object.entries(gaesteDaily)) {
    if (date < vjFrom || date > vjTo || !(n > 0)) continue;
    vjGaeste += n; hatVjGaeste = true;
  }

  // ── Durchschnittsverkauf (manueller Import; Zeitraum-Wert massgeblich) ─────
  const avgMonat: number | null = avgMonthly[`${year}-${mm}`] ?? null;
  const avgVj: number | null = avgMonthly[`${year - 1}-${mm}`] ?? null;
  // Woche: gäste-gewichteter Mittelwert der Tageswerte (Fallback: einfacher Mittelwert)
  let avgWoche: number | null = null;
  if (weekFrom && weekTo) {
    let wSum = 0, wWeight = 0, sSum = 0, sCount = 0;
    for (const date of wocheTage) {
      const v = avgDaily[date];
      if (!(v > 0)) continue;
      const g = gaesteDaily[date] ?? 0;
      if (g > 0) { wSum += v * g; wWeight += g; }
      sSum += v; sCount++;
    }
    if (wWeight > 0) avgWoche = r2(wSum / wWeight);
    else if (sCount > 0) avgWoche = r2(sSum / sCount);
  }

  // ── Vorjahr (vj_daily) ─────────────────────────────────────────────────────
  let vjGross = 0, vjFoodG = 0, vjBevG = 0, hatVj = false, hatVjFood = false, hatVjBev = false;
  for (const rec of Object.values(vjDaily)) {
    if ((rec.actualRevenue ?? 0) > 0) { vjGross += rec.actualRevenue; hatVj = true; }
    if ((rec.foodRevenue ?? 0) > 0) { vjFoodG += rec.foodRevenue!; hatVjFood = true; }
    if ((rec.beverageRevenue ?? 0) > 0) { vjBevG += rec.beverageRevenue!; hatVjBev = true; }
  }

  // ── Produktive Stunden ─────────────────────────────────────────────────────
  let istStd: number | null = null, planStd: number | null = null;
  let wIstStd: number | null = null;
  if (pk) {
    let ist = 0, hatIst = false, plan = 0, hatPlan = false, wIst = 0;
    for (const [date, perEmp] of Object.entries(pk.istStdProTag)) {
      for (const h of Object.values(perEmp)) { ist += h; hatIst = true; }
      if (weekFrom && weekTo && date >= weekFrom && date <= weekTo) {
        for (const h of Object.values(perEmp)) wIst += h;
      }
    }
    for (const perEmp of Object.values(pk.planStdProTag)) {
      for (const h of Object.values(perEmp)) { plan += h; hatPlan = true; }
    }
    istStd = hatIst ? r2(ist) : null;
    planStd = hatPlan ? r2(plan) : null;
    wIstStd = hatIst && weekFrom ? r2(wIst) : null;
  }

  // ── Zeilen bauen ───────────────────────────────────────────────────────────
  const N = (v: number, hat: boolean): number | null => (hat ? r2(v) : null);
  const e = (): MrRow => ({ type: 'empty', budget: null, vj: null, week: null, weekBudget: null, month: null });
  const d = (
    label: string,
    vals: { budget?: number | null; vj?: number | null; week?: number | null; weekBudget?: number | null; month?: number | null },
    opts: { fmt?: MrFormat; bold?: boolean } = {},
  ): MrRow => ({
    type: 'data', label,
    budget: vals.budget ?? null, vj: vals.vj ?? null,
    week: vals.week ?? null, weekBudget: vals.weekBudget ?? null,
    month: vals.month ?? null,
    fmt: opts.fmt ?? 'chf', bold: opts.bold,
  });

  const mGrossV = N(mGross, mHatUmsatz);
  const mNetV = N(mNet, mHatUmsatz);
  const wGrossV = weekFrom ? N(wGross, wHatUmsatz) : null;
  const wNetV = weekFrom ? N(wNet, wHatUmsatz) : null;
  const budgetGross = hatBudget ? r2(budgetNet * VAT_STD) : null;
  const budgetNetV = hatBudget ? r2(budgetNet) : null;
  const wBudget = hatBudget && weekFrom ? r2(wBudgetNet) : null;
  const vjGrossV = N(vjGross, hatVj);
  const vjNetV = hatVj ? r2(vjGross / VAT_STD) : null;
  const mGaesteV = N(mGaeste, hatGaeste);
  const wGaesteV = weekFrom ? N(wGaeste, hatWGaeste) : null;
  const vjGaesteV = N(vjGaeste, hatVjGaeste);
  const taM = mHatUmsatz && mTa > 0 ? r2(mTa) : null;
  const taW = weekFrom && wHatUmsatz && wTa > 0 ? r2(wTa) : null;

  // Vorjahr-Netto der Sparten (Vorjahr-Spalte trägt jetzt den Vergleich,
  // separate Vorjahr-Zeilen entfallen).
  const vjFoodNet = hatVjFood ? r2(vjFoodG / VAT_STD) : null;
  const vjBevNet = hatVjBev ? r2(vjBevG / VAT_STD) : null;

  const rows: MrRow[] = [
    // ── Block Umsatz/Gäste ──
    d('Brutto Umsatz', { month: mGrossV, week: wGrossV, weekBudget: wBudget != null ? r2(wBudget * VAT_STD) : null, budget: budgetGross, vj: vjGrossV }, { bold: true }),
    d('Netto Umsatz', { month: mNetV, week: wNetV, weekBudget: wBudget, budget: budgetNetV, vj: vjNetV }, { bold: true }),
    d('Gäste IN', { month: mGaesteV, week: wGaesteV, vj: vjGaesteV }, { fmt: 'count' }),
    d('Gäste Take Away', {}, { fmt: 'count' }), // keine Quelle (Personen-Import ohne TA-Trennung)
    d('Gruppen ab 20 Pax', { month: gruppen20 }, { fmt: 'count' }),
    e(),
    // ── Block Durchschnitt ──
    // Durchschnittsverkauf = importierter Wert (Zeitraum-Spalte massgeblich),
    // NICHT berechnet — die berechnete Grösse ist «Umsatz pro Gast».
    d('Durchschnittsverkauf', {
      month: avgMonat,
      week: avgWoche,
      vj: avgVj,
    }),
    d('Take Away Anteil', {
      month: taM != null && mGross > 0 ? r2((mTa / mGross) * 100) : null,
      week: taW != null && wGross > 0 ? r2((wTa / wGross) * 100) : null,
    }, { fmt: 'pct' }),
    e(),
    // ── Block Sparten (netto) — Gastronovi-Begriffe, Vorjahr in vj-Spalte ──
    d('Food', { month: mHatUmsatz && mFood > 0 ? r2(mFood) : null, vj: vjFoodNet }),
    d('Beverage', { month: mHatUmsatz && mBev > 0 ? r2(mBev) : null, vj: vjBevNet }),
    e(),
    // ── Block Produktivität ──
    d('Produktive Stunden (Ist)', { month: istStd, week: wIstStd }, { fmt: 'hours' }),
    d('Produktive Stunden geplant', { month: planStd }, { fmt: 'hours' }),
    d('Produktivität (Umsatz/Std)', {
      month: mNetV != null && istStd ? r2(mNet / istStd) : null,
      week: wNetV != null && wIstStd ? r2(wNet / wIstStd) : null,
    }),
    // Netto ÷ Gäste, NUR über Tage mit BEIDEN Quellen (Umsatz + Gäste).
    d('Umsatz pro Gast', {
      month: pairedGaeste > 0 ? r2(pairedNet / pairedGaeste) : null,
      week: weekFrom && wPairedGaeste > 0 ? r2(wPairedNet / wPairedGaeste) : null,
    }),
  ];

  return { year, month, weekFrom, weekTo, weekLabel, rows };
}
