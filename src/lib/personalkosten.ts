/**
 * personalkosten.ts — EINZIGE zentrale Berechnungsquelle für Personalkosten
 * ═════════════════════════════════════════════════════════════════════════
 * Etappe 1: Nur die kanonischen Funktionen + Datenlader. Bestehende Ansichten
 * (PersonalFix, Dashboard, Dienstplan) bleiben unverändert und werden in
 * Etappe 2 auf dieses Modul umgestellt.
 *
 * DEFINITIONEN (Quelle der Wahrheit):
 * - FIX-MA (Monatslohn): Kosten/Monat = "Total AG/Mt" = Bruttolohn inkl.
 *   amortisiertem 13. (monthlySalaryWith13th) × AG-Sozialkostenfaktor.
 *   Pro rata bei Ein-/Austritt im Monat (Kalendertage ÷ Monatstage).
 *   Hängt NICHT von Stunden ab.
 * - FLEX-MA (Stundenlohn): CHF/h = "Total AG/h" (getEffectiveHourlyRate).
 *   Kosten = Stunden × CHF/h. Plan aus Dienstplan, Ist aus MIRUS-Import.
 * - TAG-REGEL: Ein Tag zählt als IST, wenn für diesen Tag Ist-Stunden
 *   importiert sind, sonst als PLAN. Nie Plan UND Ist für denselben Tag.
 * - NICHT enthalten: Ferienabbau (FE), Kranken-/Unfallkosten (Absenzen),
 *   Überstunden/Zusatzkosten-Einträge (isAdditionalCost) — separate Info.
 */

import type { Employee } from '@/types/personnel';
import type { SocialCostRates } from '@/lib/social-costs';
import { socialCostFactorFromRates } from '@/lib/social-costs';
import { getEffectiveHourlyRate } from '@/lib/employee-rate';
import { calculateDayNetHours } from '@/hooks/useShiftConfig';
import { isEmployeeActiveInMonth } from '@/lib/personnel-utils';
import { loadEmployees, loadScheduleForMonth, loadActualHoursForMonth } from '@/lib/supabase-db';
import { applyEffectiveWages, firstOfMonth } from '@/lib/wage-history';
import { computeMonthlyDailyBudgets } from '@/lib/budget-day';
import { getMonthlyBudgetRevenue } from '@/lib/budgetDistribution';
import type { TenantId } from '@/contexts/TenantContext';
import { ladeUmsatzTage, nettoUmsatzTag } from '@/lib/umsatz';

// ── Budget-Konstanten (Vorgabe: 35.5 % von 300'000 = 106'400) ────────────────
export const PK_BUDGET_UMSATZ_MONAT = 300_000;
export const PK_BUDGET_QUOTE       = 0.355;
export const PK_BUDGET_TOTAL       = 106_400;

const r2 = (v: number) => Math.round(v * 100) / 100;
const pad2 = (n: number) => String(n).padStart(2, '0');

// ══ Datenbasis ════════════════════════════════════════════════════════════════

export interface PkFlexTagZelle {
  planStd:   number;
  istStd?:   number;
  chfProStd: number;
  planKosten: number;
  istKosten?: number;
}

export interface PersonalkostenDaten {
  year:  number;
  month: number; // 1-basiert
  daysInMonth: number;
  /** Aktive Fix-MA (Monatslohn) im Monat */
  fixEmployees:  Employee[];
  /** Aktive Flex-MA (Stundenlohn) im Monat */
  flexEmployees: Employee[];
  agFactor: number;
  rates: SocialCostRates;
  /** Plan-Stunden je 'YYYY-MM-DD' je empId (Dienstplan, netto, ohne FE) */
  planStdProTag: Record<string, Record<string, number>>;
  /** Ist-Stunden je 'YYYY-MM-DD' je empId (MIRUS, ohne FE/Absenzen/Zusatzkosten) */
  istStdProTag:  Record<string, Record<string, number>>;
  /** Tage (Set 'YYYY-MM-DD'), für die Ist-Stunden importiert sind → TAG-REGEL */
  istTage: Set<string>;
  /** Ist-NETTO-Umsatz je 'YYYY-MM-DD' aus der kanonischen Quelle umsatz.ts */
  umsatzIstProTag: Record<string, number>;
  /** Budgetierter Monatsumsatz aus dem Budget-Modul (0 = nicht vorhanden) */
  umsatzBudgetMonat: number;
  /** Wochentagsgewichte (normiert, Summe ≈ 1); Fallback = gleichmässig (1/7) */
  gewichte: Record<number, number>;
}

/**
 * Wochentagsgewichte für die Tagesverteilung von Budget/Umsatz.
 * Tenant-präfixierter Key hat Vorrang, dann der (historisch globale) Key.
 * Fallback laut Spezifikation: GLEICHMÄSSIG (1/7 pro Wochentag).
 */
export function ladeWochentagsGewichte(tenantKey: KeyFn): Record<number, number> {
  for (const key of [tenantKey('revenue_weekday_percentages'), 'revenue_weekday_percentages']) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed: Record<number, number> = JSON.parse(raw);
      const total = Object.values(parsed).reduce((s, v) => s + (Number(v) || 0), 0);
      if (total <= 0) continue;
      const w: Record<number, number> = {};
      for (let d = 0; d <= 6; d++) w[d] = (Number(parsed[d]) || 0) / total;
      return w;
    } catch { /* nächster Key */ }
  }
  const w: Record<number, number> = {};
  for (let d = 0; d <= 6; d++) w[d] = 1 / 7;
  return w;
}

/** Ob der Mitarbeiter einen fixen Monatslohn hat (identisch zu PersonalFix). */
export function pkHasFixedSalary(emp: Employee): boolean {
  return (emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit')
    && (emp.monthlySalary ?? 0) > 0;
}

/** Brutto-Monatsbasis inkl. 13. (identisch zu PersonalFix.getFixCost). */
function fixBrutto(emp: Employee): number {
  if (emp.monthlySalaryWith13th && emp.monthlySalaryWith13th > 0) return emp.monthlySalaryWith13th;
  if (emp.monthlySalary && emp.monthlySalary > 0) return emp.monthlySalary;
  return 0;
}

/** Pro-rata-Faktor bei Ein-/Austritt im Monat (Kalendertage ÷ Monatstage). */
function proRataFaktor(emp: Employee, year: number, month: number): { faktor: number; label: string | null } {
  const daysInMonth = new Date(year, month, 0).getDate();
  let entryFactor = 1, exitFactor = 1;
  const labels: string[] = [];
  if (emp.contractStart) {
    const d = new Date(emp.contractStart + 'T00:00:00');
    if (d.getFullYear() > year || (d.getFullYear() === year && d.getMonth() + 1 > month)) {
      return { faktor: 0, label: 'Noch nicht eingetreten' };
    }
    if (d.getFullYear() === year && d.getMonth() + 1 === month && d.getDate() > 1) {
      entryFactor = (daysInMonth - d.getDate() + 1) / daysInMonth;
      labels.push(`Pro rata ab ${pad2(d.getDate())}.${pad2(month)}.`);
    }
  }
  if (emp.employmentEndDate) {
    const d = new Date(emp.employmentEndDate + 'T00:00:00');
    if (d.getFullYear() < year || (d.getFullYear() === year && d.getMonth() + 1 < month)) {
      return { faktor: 0, label: 'Ausgetreten' };
    }
    if (d.getFullYear() === year && d.getMonth() + 1 === month) {
      exitFactor = d.getDate() / daysInMonth;
      labels.push(`Pro rata bis ${pad2(d.getDate())}.${pad2(month)}.`);
    }
  }
  return { faktor: entryFactor * exitFactor, label: labels.length ? labels.join(' / ') : null };
}

// ══ 1. fixKosten ═══════════════════════════════════════════════════════════════

export interface FixKostenZeile {
  empId: string;
  name:  string;
  /** Total AG/Mt (pro rata bei Ein-/Austritt) */
  kostenMonat: number;
  /** kostenMonat × (vergangene Tage ÷ Monatstage) */
  kostenBisStichtag: number;
  label: string | null;
}

export interface FixKostenErgebnis {
  zeilen: FixKostenZeile[];
  totalMonat:       number;
  totalBisStichtag: number;
  stichtag: number; // verwendeter Stichtag (Tag im Monat, 0 = keiner vergangen)
}

/** Fix-Kosten pro Monat und bis Stichtag. stichtag = letzter VERGANGENER Tag. */
export function fixKosten(daten: PersonalkostenDaten, opts?: { stichtag?: number }): FixKostenErgebnis {
  const stichtag = Math.max(0, Math.min(opts?.stichtag ?? daten.daysInMonth, daten.daysInMonth));
  const anteil = stichtag / daten.daysInMonth;
  const zeilen: FixKostenZeile[] = [];
  for (const emp of daten.fixEmployees) {
    const { faktor, label } = proRataFaktor(emp, daten.year, daten.month);
    if (faktor <= 0) continue;
    const kostenMonat = r2(fixBrutto(emp) * faktor * daten.agFactor);
    zeilen.push({
      empId: emp.id,
      name:  emp.name,
      kostenMonat,
      kostenBisStichtag: r2(kostenMonat * anteil),
      label,
    });
  }
  zeilen.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return {
    zeilen,
    totalMonat:       r2(zeilen.reduce((s, z) => s + z.kostenMonat, 0)),
    totalBisStichtag: r2(zeilen.reduce((s, z) => s + z.kostenBisStichtag, 0)),
    stichtag,
  };
}

// ══ 2. flexKostenProTag ═════════════════════════════════════════════════════════

export interface FlexTag {
  date: string;
  /** TAG-REGEL: true = Ist-Stunden importiert → Tag zählt als IST */
  istTag: boolean;
  proMa: Record<string, PkFlexTagZelle>; // empId → Zelle
  planKosten: number;
  istKosten:  number;
  /** Effektive Kosten des Tags gemäss Tag-Regel (Ist wenn istTag, sonst Plan) */
  effektivKosten: number;
}

/**
 * Flex-Kosten je Tag/Flex-MA (Plan aus Dienstplan, Ist aus MIRUS).
 * TAG-REGEL: Ein Tag zählt nur dann als IST, wenn er VOR heute liegt UND
 * Ist-Stunden vorhanden sind. Heutiger Tag und alle künftigen Tage = PLAN.
 */
export function flexKostenProTag(daten: PersonalkostenDaten, opts?: { stichtag?: number }): FlexTag[] {
  const stichtag = opts?.stichtag ?? letzterVergangenerTag(daten.year, daten.month);
  const mm = pad2(daten.month);
  const tage: FlexTag[] = [];
  const rateCache = new Map<string, number>();
  const rateOf = (emp: Employee): number => {
    if (!rateCache.has(emp.id)) rateCache.set(emp.id, getEffectiveHourlyRate(emp, daten.rates) ?? 0);
    return rateCache.get(emp.id)!;
  };
  for (let d = 1; d <= daten.daysInMonth; d++) {
    const date = `${daten.year}-${mm}-${pad2(d)}`;
    // TAG-REGEL: nur vergangene Tage (d <= stichtag) mit Ist-Stunden sind Ist-Tage.
    const istTag = d <= stichtag && daten.istTage.has(date);
    const proMa: Record<string, PkFlexTagZelle> = {};
    let planKosten = 0, istKosten = 0;
    for (const emp of daten.flexEmployees) {
      const planStd = daten.planStdProTag[date]?.[emp.id] ?? 0;
      const istStd  = daten.istStdProTag[date]?.[emp.id];
      if (planStd <= 0 && (istStd ?? 0) <= 0) continue;
      const chfProStd = rateOf(emp);
      const zelle: PkFlexTagZelle = {
        planStd,
        chfProStd: r2(chfProStd),
        planKosten: r2(planStd * chfProStd),
      };
      if (istStd != null && istStd > 0) {
        zelle.istStd = istStd;
        zelle.istKosten = r2(istStd * chfProStd);
      }
      proMa[emp.id] = zelle;
      planKosten += zelle.planKosten;
      istKosten  += zelle.istKosten ?? 0;
    }
    planKosten = r2(planKosten);
    istKosten  = r2(istKosten);
    tage.push({
      date, istTag, proMa, planKosten, istKosten,
      effektivKosten: istTag ? istKosten : planKosten,
    });
  }
  return tage;
}

// ══ 3. personalkosten ═══════════════════════════════════════════════════════════

export interface PkSumme { fix: number; flex: number; total: number; }
export type PkModus = 'istBisHeute' | 'hochrechnung';

/**
 * Kanonische Personalkosten je Modus.
 * - istBisHeute:  FIX anteilig bis Stichtag + Σ FLEX-Ist der vergangenen
 *   Ist-Tage (nur Tage mit importierten Ist-Stunden).
 * - hochrechnung: FIX voller Monat + Σ pro Tag (Ist wenn Ist-Tag, sonst Plan).
 * stichtag = letzter vergangener Tag (siehe letzterVergangenerTag()).
 */
export function personalkosten(daten: PersonalkostenDaten, modus: PkModus, opts?: { stichtag?: number }): PkSumme {
  const stichtag = opts?.stichtag ?? letzterVergangenerTag(daten.year, daten.month);
  const tage = flexKostenProTag(daten, { stichtag });
  if (modus === 'istBisHeute') {
    const fix = fixKosten(daten, { stichtag }).totalBisStichtag;
    let flex = 0;
    for (const t of tage) {
      const day = parseInt(t.date.slice(-2), 10);
      if (day <= stichtag && t.istTag) flex += t.istKosten;
    }
    flex = r2(flex);
    return { fix, flex, total: r2(fix + flex) };
  }
  // hochrechnung
  const fix = fixKosten(daten).totalMonat;
  const flex = r2(tage.reduce((s, t) => s + t.effektivKosten, 0));
  return { fix, flex, total: r2(fix + flex) };
}

// ══ 4. budget ═══════════════════════════════════════════════════════════════════

export interface PkBudget {
  total: number;
  proTag: { date: string; betrag: number }[];
}

/**
 * Personalkosten-Budget des Monats: 106'400 (35.5 % von 300'000), auf Tage
 * verteilt nach den vorhandenen Wochentagsgewichten (Umsatzgewichtung);
 * Fallback ohne Einstellungen: gleichmässig (1/7 pro Wochentag).
 */
export function budget(year: number, month: number, gewichte: Record<number, number>): PkBudget {
  const map = computeMonthlyDailyBudgets(PK_BUDGET_TOTAL, year, month, gewichte);
  const proTag = Object.keys(map).sort().map(date => ({ date, betrag: map[date] }));
  return { total: PK_BUDGET_TOTAL, proTag };
}

// ══ 5. umsatz ═══════════════════════════════════════════════════════════════════

export interface PkUmsatz {
  /** Σ Z-Bericht-Umsatz der vergangenen Tage */
  istBisHeute: number;
  /** Σ (Ist vergangene Tage + Budget/Plan-Tagesumsatz Resttage) */
  hochrechnung: number;
  /** Anzahl vergangener Tage mit Ist-Umsatz */
  istTage: number;
}

/** Umsatz Ist-bis-heute und Hochrechnung. KEIN Schein-Budget aus Ist-Umsatz. */
export function umsatz(daten: PersonalkostenDaten, opts?: { stichtag?: number }): PkUmsatz {
  const stichtag = opts?.stichtag ?? letzterVergangenerTag(daten.year, daten.month);
  const mm = pad2(daten.month);
  // Budget-Tagesumsätze: Budget-Modul (Umsatzbudget), Fallback 300'000.
  const budgetMonat = daten.umsatzBudgetMonat > 0 ? daten.umsatzBudgetMonat : PK_BUDGET_UMSATZ_MONAT;
  const budgetProTag = computeMonthlyDailyBudgets(budgetMonat, daten.year, daten.month, daten.gewichte);
  let ist = 0, hochrechnung = 0, istTage = 0;
  for (let d = 1; d <= daten.daysInMonth; d++) {
    const date = `${daten.year}-${mm}-${pad2(d)}`;
    const istUmsatz = daten.umsatzIstProTag[date] ?? 0;
    if (d <= stichtag) {
      // Vergangener Tag: Ist zählt (auch wenn 0 erfasst); ohne Erfassung 0.
      ist += istUmsatz;
      hochrechnung += istUmsatz;
      if (istUmsatz > 0) istTage++;
    } else {
      hochrechnung += budgetProTag[date] ?? 0;
    }
  }
  return { istBisHeute: r2(ist), hochrechnung: r2(hochrechnung), istTage };
}

// ══ 6. personalquote ═══════════════════════════════════════════════════════════

export interface PkQuote {
  /** Ist-Kosten ÷ Ist-Umsatz (vergangene Tage). null wenn kein Ist-Umsatz. */
  pkqIst: number | null;
  /** Hochrechnungs-Kosten ÷ Hochrechnungs-Umsatz. null wenn kein Umsatz. */
  pkqHochrechnung: number | null;
}

/** PKQ. NIEMALS volle Kosten ÷ Teilumsatz — Zähler und Nenner immer gleiche Basis. */
export function personalquote(daten: PersonalkostenDaten, opts?: { stichtag?: number }): PkQuote {
  const stichtag = opts?.stichtag ?? letzterVergangenerTag(daten.year, daten.month);
  const kIst = personalkosten(daten, 'istBisHeute', { stichtag });
  const kHr  = personalkosten(daten, 'hochrechnung', { stichtag });
  const u    = umsatz(daten, { stichtag });
  return {
    pkqIst:          u.istBisHeute  > 0 ? kIst.total / u.istBisHeute  : null,
    pkqHochrechnung: u.hochrechnung > 0 ? kHr.total  / u.hochrechnung : null,
  };
}

// ══ Hilfen ═══════════════════════════════════════════════════════════════════════

/**
 * Letzter vergangener (abgeschlossener) Tag des Monats:
 * - laufender Monat → gestern (0 am Monatsersten)
 * - vergangener Monat → letzter Monatstag
 * - zukünftiger Monat → 0
 */
export function letzterVergangenerTag(year: number, month: number, heute: Date = new Date()): number {
  const hY = heute.getFullYear(), hM = heute.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  if (year < hY || (year === hY && month < hM)) return daysInMonth;
  if (year > hY || (year === hY && month > hM)) return 0;
  return Math.max(0, heute.getDate() - 1);
}

// ══ Datenlader ═══════════════════════════════════════════════════════════════════
// Liest AUS DEN VORHANDENEN QUELLEN (keine neuen Tabellen):
// - Mitarbeiter: Supabase employees + Lohnhistorie (applyEffectiveWages)
// - Plan: Supabase schedule_entries (Fallback localStorage schedule-v2-*)
// - Ist:  Supabase actual_hours + localStorage actual-hours-* (FE-Override lokal)
// - Umsatz Ist: kanonische Netto-Quelle src/lib/umsatz.ts (gn_imports + gn_discounts)
// - Umsatzbudget: Budget-Store (P&L)

type KeyFn = (k: string) => string;

function readJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || '') as T; } catch { return fallback; }
}

export async function ladePersonalkostenDaten(
  year: number,
  month: number,
  tenantId: TenantId,
  tenantKey: KeyFn,
  rates: SocialCostRates,
): Promise<PersonalkostenDaten> {
  const mm = pad2(month);
  const prefix = `${year}-${mm}`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthDate = new Date(year, month - 1, 1);

  // Mitarbeiter mit zum Monatsbeginn gültigen Löhnen
  const emps = (await loadEmployees(tenantId)) ?? [];
  const employees = await applyEffectiveWages(emps, firstOfMonth(year, month), tenantId);
  const aktiv = employees.filter(e => isEmployeeActiveInMonth(e, year, month));
  const fixEmployees  = aktiv.filter(pkHasFixedSalary);
  const flexEmployees = aktiv.filter(e => !pkHasFixedSalary(e));

  // ── Plan-Stunden (Dienstplan) ────────────────────────────────────────────
  // Supabase ist kanonisch; leeres Resultat → localStorage-Cache als Fallback.
  const planStdProTag: Record<string, Record<string, number>> = {};
  let scheduleRaw: Record<string, any> | null = await loadScheduleForMonth(monthDate, tenantId);
  if (!scheduleRaw || Object.keys(scheduleRaw).length === 0) {
    scheduleRaw = readJson<Record<string, any>>(tenantKey(`schedule-v2-${prefix}`), {});
  }
  for (const [cellKey, ds] of Object.entries(scheduleRaw)) {
    const date = cellKey.slice(-10);
    if (!date.startsWith(prefix)) continue;
    const empId = cellKey.slice(0, cellKey.length - 11);
    if (typeof ds !== 'object' || ds == null) continue;
    // FE (Ferien) zählt nicht als Arbeit; Zusatzkosten-Plan (Überstunden Fix-MA) ausgeschlossen
    if (ds.frühAbsence === 'FE' || ds.spätAbsence === 'FE') continue;
    if (ds.isAdditionalCostPlan) continue;
    const net = calculateDayNetHours(ds);
    if (net > 0) {
      (planStdProTag[date] ??= {})[empId] = r2(((planStdProTag[date]?.[empId]) ?? 0) + net);
    }
  }

  // ── Ist-Stunden (MIRUS) ──────────────────────────────────────────────────
  // localStorage zuerst (enthält FE/K/U-Overrides und lokale Einträge),
  // Supabase gewinnt bei echten Stunden — identische Regel wie PersonalFix.
  const istStdProTag: Record<string, Record<string, number>> = {};
  const istTage = new Set<string>();
  const localIst = readJson<Record<string, any>>(tenantKey(`actual-hours-${prefix}`), {});
  const supaIst  = (await loadActualHoursForMonth(monthDate, tenantId)) ?? {};
  const cellKeys = new Set([...Object.keys(localIst), ...Object.keys(supaIst)]);
  for (const cellKey of cellKeys) {
    const date = cellKey.slice(-10);
    if (!date.startsWith(prefix)) continue;
    const empId = cellKey.slice(0, cellKey.length - 11);
    const localVal = localIst[cellKey];
    const localObj = typeof localVal === 'object' && localVal != null ? localVal : null;
    // Lokale Absenz-Markierung (FE/K/U) gewinnt → kein Arbeits-Ist
    if (localObj?.absenceType) continue;
    // Zusatzkosten (Überstunden Fix-MA) fliessen NICHT in diese Totale
    if (localObj?.isAdditionalCost) continue;
    const supaVal = supaIst[cellKey];
    const h = supaVal != null
      ? (supaVal.isAdditionalCost ? 0 : (supaVal.hours ?? 0))
      : (typeof localVal === 'number' ? localVal : (localObj?.hours ?? 0));
    if (h > 0) {
      (istStdProTag[date] ??= {})[empId] = r2(((istStdProTag[date]?.[empId]) ?? 0) + h);
      istTage.add(date); // TAG-REGEL: Tag hat importierte Ist-Stunden
    }
  }

  // ── Ist-Umsatz NETTO (kanonische Quelle src/lib/umsatz.ts) ───────────────
  const umsatzIstProTag: Record<string, number> = {};
  const umsatzTage = await ladeUmsatzTage(tenantId, `${prefix}-01`, `${prefix}-${pad2(daysInMonth)}`);
  for (const [date, tag] of umsatzTage) {
    const netto = nettoUmsatzTag(tag);
    if (netto > 0) umsatzIstProTag[date] = netto;
  }

  // ── Umsatzbudget (Budget-Modul) ──────────────────────────────────────────
  const umsatzBudgetMonat = getMonthlyBudgetRevenue(year, month - 1, tenantKey('budget_v1'));

  return {
    year, month, daysInMonth,
    fixEmployees, flexEmployees,
    agFactor: socialCostFactorFromRates(rates),
    rates,
    planStdProTag, istStdProTag, istTage,
    umsatzIstProTag, umsatzBudgetMonat,
    gewichte: ladeWochentagsGewichte(tenantKey),
  };
}
