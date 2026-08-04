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
import { applyEffectiveWagesForMonth, type MonthWageSplit } from '@/lib/wage-history';
import { computeMonthlyDailyBudgets } from '@/lib/budget-day';
import { getMonthlyBudgetRevenue } from '@/lib/budgetDistribution';
import type { TenantId } from '@/contexts/TenantContext';
import { ladeUmsatzTage, nettoUmsatzTag } from '@/lib/umsatz';
import { loadZielPersonalquoteLocal } from '@/lib/ziel-personalquote';

// ── KEINE hartcodierten Budget-Konstanten mehr ───────────────────────────────
// Umsatz- UND Personalkosten-Budget kommen LIVE aus dem Budget-Modul (SSoT,
// identisch zum Monatsreport). Fehlt ein Wert → null (keine stille Konstante).

const r2 = (v: number) => Math.round(v * 100) / 100;
const pad2 = (n: number) => String(n).padStart(2, '0');

// ══ Datenbasis ════════════════════════════════════════════════════════════════

export interface PkFlexTagZelle {
  planStd:   number;
  istStd?:   number;
  chfProStd: number;
  planKosten: number;
  istKosten?: number;
  /** Effektive Ist-Quelle des MA (getEffectiveIstQuelle). */
  quelle?: IstQuelle;
  /**
   * true = vergangener Tag, an dem für einen 'mirus'/'manuell'-MA das Ist
   * fehlt → mit Plan gerechnet, aber als «Ist fehlt» markiert (nicht still 0).
   */
  istFehlt?: boolean;
}

export interface PersonalkostenDaten {
  year:  number;
  month: number; // 1-basiert
  daysInMonth: number;
  /** Aktive Fix-MA (Monatslohn) im Monat */
  fixEmployees:  Employee[];
  /** Aktive Flex-MA (Stundenlohn) im Monat; enthält bei Lohnart-Wechsel im
   *  Monat zusätzlich Pseudo-Einträge `<empId>::flexsplit` (Stundenlohn-Anteil). */
  flexEmployees: Employee[];
  /** Lohnart-Wechsel MITTEN im Monat (empId → Split mit Tage-Anteilen). */
  wageSplits?: Record<string, MonthWageSplit>;
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
  /**
   * Ziel-Personalquote in Prozent (zentrale Einstellung, Default 35.5). Daraus
   * skaliert das PK-Budget mit dem Umsatz: pkBudgetMonat = zielQuotePct/100 ×
   * umsatzBudgetMonat.
   */
  zielQuotePct: number;
  /**
   * Personalkosten-Budget des Monats = Ziel-Personalquote × Netto-Umsatz-Budget.
   * `null`, wenn KEIN Umsatz-Budget für den Monat hinterlegt ist (umsatzBudgetMonat
   * ≤ 0) — dann darf NICHT still auf eine Konstante zurückgefallen werden.
   */
  pkBudgetMonat: number | null;
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

export type IstQuelle = 'mirus' | 'manuell' | 'plan';

/**
 * Effektive Ist-Quelle eines MA gemäss TAG-REGEL.
 * Ist das Stammfeld `istQuelle` gesetzt, gilt es. Sonst greift die Default-
 * Ableitung (NICHT in die DB zurückgeschrieben):
 *   Monatslohn-MA ('fix') → 'mirus'; Stundenlohn/Aushilfe → 'plan'.
 */
export function getEffectiveIstQuelle(emp: Employee): IstQuelle {
  if (emp.istQuelle === 'mirus' || emp.istQuelle === 'manuell' || emp.istQuelle === 'plan') {
    return emp.istQuelle;
  }
  return pkHasFixedSalary(emp) ? 'mirus' : 'plan';
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
    // Lohnart-Wechsel im Monat: nur der Monatslohn-Tage-Anteil zählt als FIX
    // (der Stundenlohn-Anteil läuft als Pseudo-Flex-MA über flexKosten).
    const split = daten.wageSplits?.[String(emp.id)];
    const splitFaktor = split ? split.monthlyFraction : 1;
    const kostenMonat = r2(fixBrutto(emp) * faktor * splitFaktor * daten.agFactor);
    zeilen.push({
      empId: emp.id,
      name:  emp.name,
      kostenMonat,
      kostenBisStichtag: r2(kostenMonat * anteil),
      label: split ? [label, 'Lohnart-Wechsel pro rata'].filter(Boolean).join(' / ') : label,
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
  /** TAG-REGEL: true = vergangener (abgeschlossener) Tag → zählt als IST */
  istTag: boolean;
  proMa: Record<string, PkFlexTagZelle>; // empId → Zelle
  planKosten: number;
  /**
   * Effektive Ist-Kosten des Tags gemäss Ist-Quelle-Regel (nur an vergangenen
   * Tagen > 0): 'plan' → Plan gilt als Ist; 'mirus'/'manuell' → importiertes/
   * manuelles Ist, bei fehlendem Ist Fallback auf Plan (markiert als «Ist fehlt»).
   */
  istKosten:  number;
  /** Effektive Kosten des Tags gemäss Tag-Regel (Ist wenn istTag, sonst Plan) */
  effektivKosten: number;
}

export interface FlexKostenProTagErgebnis {
  tage: FlexTag[];
  /**
   * Vergangene Tage, an denen bei einem 'mirus'/'manuell'-MA das Ist fehlt.
   * Format: 'YYYY-MM-DD|empId' (eindeutig je MA+Tag). Mit Plan gerechnet.
   */
  istFehltTage: string[];
}

/**
 * Flex-Kosten je Tag/Flex-MA (Plan aus Dienstplan, Ist aus MIRUS/manuell).
 * TAG-REGEL mit Ist-Quelle (getEffectiveIstQuelle je MA):
 *   - Künftiger/heutiger Tag (> stichtag) → PLAN.
 *   - Vergangener Tag (<= stichtag):
 *       'plan'            → Plan gilt als Ist.
 *       'mirus'/'manuell' → Ist-Stunden; fehlt das Ist trotz Plan → «Ist fehlt»,
 *                           mit Plan gerechnet (NICHT still 0).
 * Pro Tag genau eine Zahl je MA — nie Plan UND Ist gleichzeitig.
 */
export function flexKostenProTagDetail(daten: PersonalkostenDaten, opts?: { stichtag?: number }): FlexKostenProTagErgebnis {
  const stichtag = opts?.stichtag ?? letzterVergangenerTag(daten.year, daten.month);
  const mm = pad2(daten.month);
  const tage: FlexTag[] = [];
  const istFehltTage: string[] = [];
  const rateCache = new Map<string, number>();
  const quelleCache = new Map<string, IstQuelle>();
  const rateOf = (emp: Employee): number => {
    if (!rateCache.has(emp.id)) rateCache.set(emp.id, getEffectiveHourlyRate(emp, daten.rates) ?? 0);
    return rateCache.get(emp.id)!;
  };
  const quelleOf = (emp: Employee): IstQuelle => {
    if (!quelleCache.has(emp.id)) quelleCache.set(emp.id, getEffectiveIstQuelle(emp));
    return quelleCache.get(emp.id)!;
  };
  for (let d = 1; d <= daten.daysInMonth; d++) {
    const date = `${daten.year}-${mm}-${pad2(d)}`;
    const istTag = d <= stichtag; // vergangener, abgeschlossener Tag
    const proMa: Record<string, PkFlexTagZelle> = {};
    let planKosten = 0, istKosten = 0;
    for (const emp of daten.flexEmployees) {
      const planStd = daten.planStdProTag[date]?.[emp.id] ?? 0;
      const istStd  = daten.istStdProTag[date]?.[emp.id];
      if (planStd <= 0 && (istStd ?? 0) <= 0) continue;
      const chfProStd = rateOf(emp);
      const quelle = quelleOf(emp);
      const zelle: PkFlexTagZelle = {
        planStd,
        chfProStd: r2(chfProStd),
        planKosten: r2(planStd * chfProStd),
        quelle,
      };
      const hasIst = istStd != null && istStd > 0;
      if (hasIst) {
        zelle.istStd = istStd;
        zelle.istKosten = r2(istStd * chfProStd);
      }
      // Effektiver Ist-Wert des MA an diesem Tag (nur an vergangenen Tagen).
      let maIstKosten = 0;
      if (istTag) {
        if (quelle === 'plan') {
          // Plan gilt als Ist.
          maIstKosten = zelle.planKosten;
        } else if (hasIst) {
          // 'mirus'/'manuell' mit vorhandenem Ist.
          maIstKosten = zelle.istKosten!;
        } else if (planStd > 0) {
          // 'mirus'/'manuell', Ist fehlt trotz Plan → mit Plan rechnen, markieren.
          maIstKosten = zelle.planKosten;
          zelle.istFehlt = true;
          istFehltTage.push(`${date}|${emp.id}`);
        }
      }
      proMa[emp.id] = zelle;
      planKosten += zelle.planKosten;
      istKosten  += maIstKosten;
    }
    planKosten = r2(planKosten);
    istKosten  = r2(istKosten);
    tage.push({
      date, istTag, proMa, planKosten, istKosten,
      effektivKosten: istTag ? istKosten : planKosten,
    });
  }
  return { tage, istFehltTage };
}

/** Rückwärtskompatibler Wrapper: nur die Tag-Liste (siehe flexKostenProTagDetail). */
export function flexKostenProTag(daten: PersonalkostenDaten, opts?: { stichtag?: number }): FlexTag[] {
  return flexKostenProTagDetail(daten, opts).tage;
}

// ══ 3. personalkosten ═══════════════════════════════════════════════════════════

export interface PkSumme {
  fix: number;
  flex: number;
  total: number;
  /**
   * Vergangene Tage, an denen bei 'mirus'/'manuell'-MA das Ist fehlt
   * ('YYYY-MM-DD|empId'). Es wurde mit Plan gerechnet (nicht still 0).
   */
  istFehltTage: string[];
}
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
  const { tage, istFehltTage } = flexKostenProTagDetail(daten, { stichtag });
  if (modus === 'istBisHeute') {
    const fix = fixKosten(daten, { stichtag }).totalBisStichtag;
    // istKosten enthält gemäss Ist-Quelle-Regel bereits nur die vergangenen
    // Tage (0 an künftigen Tagen); «Ist fehlt» wurde mit Plan aufgefüllt.
    const flex = r2(tage.reduce((s, t) => s + (t.istTag ? t.istKosten : 0), 0));
    return { fix, flex, total: r2(fix + flex), istFehltTage };
  }
  // hochrechnung: FIX voll + FLEX-Ist (vergangene Tage) + FLEX-Plan (Resttage)
  const fix = fixKosten(daten).totalMonat;
  const flex = r2(tage.reduce((s, t) => s + t.effektivKosten, 0));
  return { fix, flex, total: r2(fix + flex), istFehltTage };
}

// ══ 4. budget ═══════════════════════════════════════════════════════════════════

export interface PkBudget {
  total: number;
  proTag: { date: string; betrag: number }[];
}

/**
 * Personalkosten-Budget des Monats = Ziel-Personalquote × Netto-Umsatz-Budget,
 * auf Tage verteilt nach den vorhandenen Wochentagsgewichten (Umsatzgewichtung);
 * Fallback ohne Einstellungen: gleichmässig (1/7 pro Wochentag).
 *
 * `pkBudgetMonat` stammt aus `PersonalkostenDaten.pkBudgetMonat`
 * (= zielQuotePct/100 × umsatzBudgetMonat). Fehlt das Umsatz-Budget (`null`),
 * gibt die Funktion `null` zurück → die Anzeige muss «—»/Hinweis zeigen, NICHT
 * auf eine Konstante zurückfallen.
 */
export function budget(
  year: number,
  month: number,
  gewichte: Record<number, number>,
  pkBudgetMonat: number | null,
): PkBudget | null {
  if (pkBudgetMonat == null || pkBudgetMonat <= 0) return null;
  const map = computeMonthlyDailyBudgets(pkBudgetMonat, year, month, gewichte);
  const proTag = Object.keys(map).sort().map(date => ({ date, betrag: map[date] }));
  return { total: pkBudgetMonat, proTag };
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
  // Budget-Tagesumsätze ausschliesslich aus dem Budget-Modul (kein Fallback auf
  // eine Konstante); fehlt das Umsatzbudget → 0 pro Tag (keine Erfindung).
  const budgetMonat = daten.umsatzBudgetMonat > 0 ? daten.umsatzBudgetMonat : 0;
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

/**
 * Ziel-PK-Quote als BRUCH (z.B. 0.355) — die zentrale Einstellung
 * (`zielQuotePct`), NICHT aus Budget-Werten abgeleitet. Damit ist die Ziel-Linie
 * der PKQ-Grafik KONSTANT und unabhängig vom Umsatz-Budget. Immer definiert
 * (Default 35.5 %), daher nie `null`.
 */
export function budgetZielQuote(daten: PersonalkostenDaten): number {
  return daten.zielQuotePct / 100;
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
  // SSOT Lohnart: im Monat aktive Vertragsphase (inkl. Backfill-Regel) — gleiche
  // Auflösung wie die Personal-FIX/VARIABEL-Seite, damit sich die Ansichten decken.
  const { employees, splits } = await applyEffectiveWagesForMonth(emps, year, month, tenantId);
  const aktiv = employees.filter(e => isEmployeeActiveInMonth(e, year, month));
  const fixEmployees  = aktiv.filter(pkHasFixedSalary);
  const flexEmployees = aktiv.filter(e => !pkHasFixedSalary(e));
  // Lohnart-Wechsel MITTEN im Monat: Stundenlohn-Anteil als Pseudo-Flex-MA
  // (eigene id `<empId>::flexsplit`), Fix-Anteil bleibt pro rata in fixKosten.
  for (const emp of fixEmployees) {
    const s = splits[String(emp.id)];
    if (!s) continue;
    flexEmployees.push({
      ...emp,
      id: `${emp.id}::flexsplit`,
      contractType: 'hourly',
      hourlyWage: s.hourly.hourlyWage,
      monthlySalary: 0,
      monthlySalaryWith13th: 0,
      // 13. der STUNDENLOHN-Phase (Split): nie das Flag der Monatslohn-Seite
      has13thSalary: s.hourly.salary13,
    });
  }

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

  // ── Umsatzbudget (Budget-Modul, SSoT identisch Monatsreport) ─────────────
  const umsatzBudgetMonat = getMonthlyBudgetRevenue(year, month - 1, tenantKey('budget_v1'));
  // ── Personalkosten-Budget = Ziel-Personalquote × Netto-Umsatz-Budget ──────
  // Ziel-Personalquote = zentrale Einstellung (Default 35.5 %); lokaler Frisch-
  // Stand genügt (KV-Backup zieht via Hook/Event in den Ansichten nach).
  const zielQuotePct = loadZielPersonalquoteLocal(tenantId).pct;
  const pkBudgetMonat = umsatzBudgetMonat > 0
    ? r2((zielQuotePct / 100) * umsatzBudgetMonat)
    : null;

  // Split-Monate: Tages-Stunden der Stundenlohn-Phase auf die Pseudo-Flex-id
  // verschieben (tag-genau — Tage der Monatslohn-Phase erzeugen keine Flex-Kosten).
  for (const [empId, s] of Object.entries(splits)) {
    for (const map of [planStdProTag, istStdProTag]) {
      for (const [date, perEmp] of Object.entries(map)) {
        if (perEmp[empId] == null) continue;
        if (date >= s.hourlyFrom && date <= s.hourlyTo) {
          perEmp[`${empId}::flexsplit`] = perEmp[empId];
        }
        delete perEmp[empId];
      }
    }
  }

  return {
    year, month, daysInMonth,
    fixEmployees, flexEmployees,
    wageSplits: splits,
    agFactor: socialCostFactorFromRates(rates),
    rates,
    planStdProTag, istStdProTag, istTage,
    umsatzIstProTag, umsatzBudgetMonat, zielQuotePct, pkBudgetMonat,
    gewichte: ladeWochentagsGewichte(tenantKey),
  };
}
