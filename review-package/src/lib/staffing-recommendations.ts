/**
 * Planungsempfehlungen (Personalcontrolling) — reine Empfehlungslogik.
 *
 * Grenzen (bewusst):
 *  - Kein DOM, kein React, kein Supabase — nur Primitive rein/raus.
 *  - Baut auf der bestehenden Faktentabelle des Controlling-Drilldowns auf
 *    (DrilldownFactCell aus personal-controlling-drilldown.ts) — KEINE
 *    parallele Zweitberechnung von Stunden/Kosten.
 *  - Besetzungsvergleich (Personen vs. SOLL) läuft pro Bedarfs-Schicht mit
 *    derselben Zählregel wie die Personalbedarf-Ampel: Positions-Match +
 *    Slot-Überschneidung (slotOverlapsShift aus staffing-comparison-utils).
 *    Tage ohne Zeitdaten werden vom Besetzungsvergleich AUSGESCHLOSSEN
 *    (coverage = null) — es wird nichts geschätzt.
 *  - Empfehlungen entstehen nur bei genügend Vergleichstagen
 *    (RECO_THRESHOLDS.minComparableDays) und wiederholtem Muster.
 *  - Die Simulation ist rein lokal: keine Speicherung, kein Dienstplan-Write.
 */

import type { DrilldownFactCell, DrilldownShiftTimes } from './personal-controlling-drilldown';
import { slotOverlapsShift } from './staffing-comparison-utils';
import { timeToMinutes, weekdayLabel } from './staffing-requirements-utils';

// ── Schwellen (eine Quelle, keine Streu-Konstanten) ─────────────────────────

export const RECO_THRESHOLDS = {
  /** Mindestanzahl Vergleichstage (gleicher Wochentag × Position), bevor überhaupt empfohlen wird. */
  minComparableDays: 3,
  /** Datenbasis-Stufen (Monatssicht: pro Wochentag max. 4–5 Tage). */
  basisHigh: 5,
  basisMedium: 4,
  /** Anteil der Vergleichstage, an denen das Muster auftreten muss (wiederholt). */
  recurrenceShare: 0.6,
  /** Ø Mehr-/Minderstunden pro Tag, ab denen ein Stundenmuster relevant ist. */
  extraHoursH: 2,
  /** Median-Verschiebung Start/Ende in Minuten, ab der eine Zeitempfehlung entsteht. */
  shiftMinutes: 30,
  /** Ø CHF-Mehrkosten pro Tag, ab denen eine Kostenempfehlung entsteht. */
  costImpactCHF: 50,
  /** Tagesumsatz unter diesem Anteil des Monatsschnitts gilt als tief (wie Drilldown). */
  lowRevenueFactor: 0.75,
  /** Tages-Personenzahl über diesem Anteil des Monatsschnitts gilt als hoch. */
  highPersonsFactor: 1.25,
  /** Max. gleichzeitig sichtbare Empfehlungen. */
  maxVisible: 6,
} as const;

export const MAX_VISIBLE_RECOMMENDATIONS = RECO_THRESHOLDS.maxVisible;

// ── Typen ────────────────────────────────────────────────────────────────────

export type RecommendationType =
  | 'unterbesetzung'
  | 'ueberbesetzung'
  | 'schichtzeit'
  | 'kosten'
  | 'datenqualitaet';

export const RECOMMENDATION_TYPE_LABEL: Record<RecommendationType, string> = {
  unterbesetzung: 'Unterbesetzung',
  ueberbesetzung: 'Überbesetzung',
  schichtzeit: 'Schichtzeiten',
  kosten: 'Kosten',
  datenqualitaet: 'Datenqualität',
};

export type RecommendationTone = 'critical' | 'warn' | 'good' | 'info';

export type RecommendationDataBasis = 'hoch' | 'mittel' | 'gering';

export const DATA_BASIS_LABEL: Record<RecommendationDataBasis, string> = {
  hoch: 'Hohe Datenbasis',
  mittel: 'Mittlere Datenbasis',
  gering: 'Geringe Datenbasis',
};

export interface RecoEmployee {
  id: string;
  /** Positions-Slug (bereits via resolvePositionKey aufgelöst) oder null. */
  position: string | null;
}

/** Bedarfs-Schicht (Teilmenge von StaffingRequirement — nur was die Logik braucht). */
export interface RecoRequirement {
  season: string;
  /** ISO 1..7 oder null = gilt für alle Wochentage. */
  weekday: number | null;
  positionKey: string;
  shiftStart: string;
  shiftEnd: string;
  requiredCount: number;
}

export interface StaffingRecoInput {
  year: number;
  month: number; // 1-basiert
  /** Letzter Tag mit erwartbar vollständigen Ist-Daten (wie Drilldown). */
  lastCompletedDay: number;
  /** Faktentabelle aus buildFactCells (SSOT) — Stunden/Kosten pro MA-Tag. */
  cells: DrilldownFactCell[];
  employees: RecoEmployee[];
  /** Schichtzeiten pro MA-Tag ("empId|YYYY-MM-DD") — nur wo echt vorhanden. */
  shiftTimes: Record<string, DrilldownShiftTimes>;
  requirements: RecoRequirement[];
  /** Manuell gewählte Saison (wie Personalbedarf/Dienstplan — keine Datums-Ableitung). */
  season: string;
  /** Positions-Slug → Anzeigename. */
  positionLabels: Record<string, string>;
  /** Netto-Tagesumsätze YYYY-MM-DD → CHF (nur vorhandene Tage). */
  dailyRevenue: Record<string, number>;
  /** Personen (Reservationen) pro Tag oder null = Daten nicht verfügbar. */
  personsByDate: Record<string, number> | null;
}

/** Besetzungs-Abdeckung einer Bedarfs-Schicht an einem Tag (null = Zeitdaten fehlen). */
export interface RecoShiftCoverage {
  shiftStart: string;
  shiftEnd: string;
  required: number;
  planned: number | null;
  actual: number | null;
}

/** Aggregierte Fakten eines Tages für EINE Position. */
export interface RecoDayFact {
  date: string;
  /** ISO-Wochentag 1..7 (Mo..So). */
  weekday: number;
  positionKey: string;
  planH: number;
  istH: number;
  planCHF: number;
  istCHF: number;
  /** Anzahl MA mit Planstunden > 0 (reine Aktivitätszählung, NICHT SOLL-Vergleich). */
  planEmpCount: number;
  istEmpCount: number;
  /** Ungeplante Einsätze (Ist ohne Plan, ohne Zusatzkosten-Tage). */
  unplanned: number;
  /** Abwesenheiten (Zellen mit Absenz-Code). */
  absences: number;
  /** Fehlende Stempelungen (aus Faktentabelle). */
  missingStamps: number;
  /** Abdeckung pro Bedarfs-Schicht (Saison + Wochentag + Position). */
  coverage: RecoShiftCoverage[];
  /** Früheste Plan-Startzeit / späteste Plan-Endzeit in Minuten (null = keine Zeitdaten). */
  planStartMin: number | null;
  planEndMin: number | null;
  istStartMin: number | null;
  istEndMin: number | null;
  revenue: number | null;
  persons: number | null;
}

export interface ComparableDayGroup {
  weekday: number;
  positionKey: string;
  days: RecoDayFact[];
}

export interface ComparableDayDetail {
  date: string;
  planH: number;
  istH: number;
  planCHF: number;
  istCHF: number;
  planPersons: number | null;
  istPersons: number | null;
  required: number | null;
  unplanned: number;
  absences: number;
  revenue: number | null;
  persons: number | null;
  /** Tag trägt zum Befund der Empfehlung bei. */
  hit: boolean;
}

export interface SimulationBase {
  weekdayLabel: string;
  positionLabel: string;
  /** Ø Planstunden der Position pro Vergleichstag. */
  avgPlanHoursPerDay: number;
  /** Ø geplante Personen pro Tag (Aktivitätszählung) oder null. */
  avgPlanHeadcount: number | null;
  /** Ø Stundensatz CHF/h aus Plan- bzw. Ist-Kosten der Vergleichstage oder null. */
  avgHourlyCostCHF: number | null;
  /** Ø Netto-Umsatz der Vergleichstage oder null (fehlende Daten). */
  avgRevenueCHF: number | null;
  /** SOLL-Personen der relevantesten Bedarfs-Schicht oder null. */
  requiredPersons: number | null;
  /** Zeitfenster der Bedarfs-Schicht (echte SOLL-Zeiten) oder null. */
  shiftStart: string | null;
  shiftEnd: string | null;
  /** Ø Stunden pro Person und Tag oder null. */
  avgHoursPerPerson: number | null;
}

export interface SimulationAdjustments {
  deltaPeople: number;
  deltaHours: number;
  startTime: string | null;
  endTime: string | null;
}

export const DEFAULT_SIMULATION_ADJUSTMENTS: SimulationAdjustments = {
  deltaPeople: 0,
  deltaHours: 0,
  startTime: null,
  endTime: null,
};

export interface SimulationResult {
  basePlanHours: number;
  baseCostCHF: number | null;
  basePkqPct: number | null;
  newHeadcount: number | null;
  newPlanHours: number;
  newCostCHF: number | null;
  newPkqPct: number | null;
  deltaHours: number;
  deltaCostCHF: number | null;
  /** neue Personen − SOLL oder null (kein SOLL/keine Personenzahl). */
  staffingDiff: number | null;
  issues: string[];
}

export interface StaffingRecommendation {
  /** Stabil: type|weekday|position|variant. */
  id: string;
  type: RecommendationType;
  tone: RecommendationTone;
  title: string;
  /** Konkrete Empfehlung (ein Satz). */
  action: string;
  weekday: number;
  weekdayLabel: string;
  positionKey: string;
  positionLabel: string;
  timeWindow: { start: string; end: string } | null;
  /** Erwartete Veränderung (aus echten Zahlen) oder null. */
  expectedChange: string | null;
  reasoning: string;
  dataBasis: RecommendationDataBasis;
  comparableDayCount: number;
  hitDayCount: number;
  recurrenceShare: number;
  /** Ø CHF-Wirkung pro Vergleichstag (Vorzeichen: + = Mehrkosten) oder null. */
  costImpactCHF: number | null;
  keyMetrics: { label: string; value: string }[];
  comparableDays: ComparableDayDetail[];
  /** Bekannte Einschränkungen der Datenbasis (fehlende Quellen etc.). */
  limitations: string[];
  simulationBase: SimulationBase;
}

export interface StaffingRecoResult {
  recommendations: StaffingRecommendation[];
  facts: RecoDayFact[];
  /** Gruppen mit genügend Vergleichstagen. */
  evaluatedGroups: number;
  /** Gruppen, die an der Mindestdatenbasis scheiterten. */
  skippedGroups: number;
  hasAnyData: boolean;
  reservationsAvailable: boolean;
  revenueAvailable: boolean;
}

// ── Kleine pure Helfer ───────────────────────────────────────────────────────

const OHNE_POSITION_KEY = '__ohne_position__';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO-Wochentag 1..7 (Mo..So) aus YYYY-MM-DD; null bei defektem Datum. */
export function isoWeekdayFromDate(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  const wd = d.getUTCDay(); // 0=So..6=Sa
  return wd === 0 ? 7 : wd;
}

function fin(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = values.reduce((a, b) => a + fin(b), 0);
  return s / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const fmtH1 = (n: number) =>
  n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtP1 = (n: number) =>
  n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtChf0 = (n: number) =>
  `CHF ${Math.round(n).toLocaleString('de-CH')}`;

export function dataBasisForDays(count: number): RecommendationDataBasis {
  if (count >= RECO_THRESHOLDS.basisHigh) return 'hoch';
  if (count >= RECO_THRESHOLDS.basisMedium) return 'mittel';
  return 'gering';
}

function positionLabelOf(input: Pick<StaffingRecoInput, 'positionLabels'>, key: string): string {
  if (key === OHNE_POSITION_KEY) return 'Ohne Position';
  return input.positionLabels[key] ?? key;
}

// ── Fakten pro Tag × Position ────────────────────────────────────────────────

/**
 * Aggregiert die Drilldown-Faktenzellen zu Tages-Positions-Fakten und rechnet
 * die Besetzungs-Abdeckung pro Bedarfs-Schicht (Zählregel wie Personalbedarf).
 * Tage ganz ohne Aktivität (kein Plan/Ist über ALLE Positionen) gelten als
 * Ruhetage und erzeugen keine Fakten — sonst würde jede Schliessung als
 * „Unterbesetzung" fehlinterpretiert.
 */
export function buildRecoDayFacts(input: StaffingRecoInput): RecoDayFact[] {
  const posByEmp = new Map<string, string>();
  for (const e of input.employees) {
    posByEmp.set(e.id, e.position && e.position.trim() ? e.position : OHNE_POSITION_KEY);
  }

  // Aktive Tage: irgendeine Plan- oder Ist-Stunde an dem Tag (alle Positionen).
  const activeDates = new Set<string>();
  for (const c of input.cells) {
    if (c.dayNum > input.lastCompletedDay) continue;
    if (c.planH > 0 || c.istH > 0) activeDates.add(c.date);
  }

  // Zellen je (Datum × Position) einsammeln.
  const byDatePos = new Map<string, DrilldownFactCell[]>();
  for (const c of input.cells) {
    if (!activeDates.has(c.date)) continue;
    const pos = posByEmp.get(c.empId) ?? OHNE_POSITION_KEY;
    const key = `${c.date}|${pos}`;
    const list = byDatePos.get(key);
    if (list) list.push(c);
    else byDatePos.set(key, [c]);
  }

  // Bedarfs-Positionen ohne jegliche Zellen an aktiven Tagen ebenfalls aufnehmen
  // (SOLL vorhanden, niemand eingeplant = echte Unterbesetzung).
  const seasonReqs = input.requirements.filter((r) => r.season === input.season);
  if (seasonReqs.length > 0) {
    for (const date of activeDates) {
      const wd = isoWeekdayFromDate(date);
      if (wd == null) continue;
      for (const r of seasonReqs) {
        if (r.weekday != null && r.weekday !== wd) continue;
        const key = `${date}|${r.positionKey}`;
        if (!byDatePos.has(key)) byDatePos.set(key, []);
      }
    }
  }

  const facts: RecoDayFact[] = [];
  for (const [key, cellList] of byDatePos.entries()) {
    const sep = key.indexOf('|');
    const date = key.slice(0, sep);
    const positionKey = key.slice(sep + 1);
    const weekday = isoWeekdayFromDate(date);
    if (weekday == null) continue;

    let planH = 0, istH = 0, planCHF = 0, istCHF = 0;
    let planEmpCount = 0, istEmpCount = 0, unplanned = 0, absences = 0, missingStamps = 0;
    let planStartMin: number | null = null, planEndMin: number | null = null;
    let istStartMin: number | null = null, istEndMin: number | null = null;
    /** MA-Tage mit Planstunden, aber ohne Plan-Zeitslots → Besetzungscheck unbekannt. */
    let planTimesMissing = 0;
    let istTimesMissing = 0;
    const planSlotsByEmp: { start: string; end: string }[][] = [];
    const istSlotsByEmp: { start: string; end: string }[][] = [];

    for (const c of cellList) {
      planH += fin(c.planH); istH += fin(c.istH);
      planCHF += fin(c.planCHF); istCHF += fin(c.istCHF);
      if (c.planH > 0) planEmpCount += 1;
      if (c.istH > 0) istEmpCount += 1;
      if (!c.zusatz && c.istH > 0 && c.planH === 0) unplanned += 1;
      if (c.absence) absences += 1;
      if (c.missingStamp) missingStamps += 1;

      const st = input.shiftTimes[`${c.empId}|${c.date}`];
      const planSlots = st?.planSlots ?? [];
      const istSlots = st?.istSlots ?? [];
      if (c.planH > 0) {
        if (planSlots.length > 0) planSlotsByEmp.push(planSlots);
        else planTimesMissing += 1;
      }
      if (c.istH > 0) {
        if (istSlots.length > 0) istSlotsByEmp.push(istSlots);
        else istTimesMissing += 1;
      }
      for (const s of planSlots) {
        const a = timeToMinutes(s.start); const b = timeToMinutes(s.end);
        if (!Number.isNaN(a)) planStartMin = planStartMin == null ? a : Math.min(planStartMin, a);
        if (!Number.isNaN(b)) planEndMin = planEndMin == null ? b : Math.max(planEndMin, b);
      }
      if (c.istH > 0) for (const s of istSlots) {
        const a = timeToMinutes(s.start); const b = timeToMinutes(s.end);
        if (!Number.isNaN(a)) istStartMin = istStartMin == null ? a : Math.min(istStartMin, a);
        if (!Number.isNaN(b)) istEndMin = istEndMin == null ? b : Math.max(istEndMin, b);
      }
    }

    // Abdeckung pro Bedarfs-Schicht — Zählregel wie Personalbedarf-Ampel:
    // Position bereits gematcht (Gruppierung), Person zählt bei Slot-Überschneidung.
    const coverage: RecoShiftCoverage[] = [];
    for (const r of seasonReqs) {
      if (r.positionKey !== positionKey) continue;
      if (r.weekday != null && r.weekday !== weekday) continue;
      const planKnown = planTimesMissing === 0;
      const istKnown = istTimesMissing === 0;
      let planned: number | null = null;
      let actual: number | null = null;
      if (planKnown) {
        planned = planSlotsByEmp.filter((slots) =>
          slots.some((s) => slotOverlapsShift(s, r.shiftStart, r.shiftEnd))).length;
      }
      if (istKnown) {
        actual = istSlotsByEmp.filter((slots) =>
          slots.some((s) => slotOverlapsShift(s, r.shiftStart, r.shiftEnd))).length;
      }
      coverage.push({ shiftStart: r.shiftStart, shiftEnd: r.shiftEnd, required: r.requiredCount, planned, actual });
    }

    facts.push({
      date, weekday, positionKey,
      planH, istH, planCHF, istCHF,
      planEmpCount, istEmpCount, unplanned, absences, missingStamps,
      coverage,
      planStartMin, planEndMin, istStartMin, istEndMin,
      revenue: input.dailyRevenue[date] ?? null,
      persons: input.personsByDate ? (input.personsByDate[date] ?? null) : null,
    });
  }

  facts.sort((a, b) => a.date.localeCompare(b.date) || a.positionKey.localeCompare(b.positionKey));
  return facts;
}

/** Vergleichsgruppen = gleicher Wochentag × Position (nur abgeschlossene Tage). */
export function groupComparableDays(facts: RecoDayFact[]): ComparableDayGroup[] {
  const map = new Map<string, ComparableDayGroup>();
  for (const f of facts) {
    const key = `${f.weekday}|${f.positionKey}`;
    let g = map.get(key);
    if (!g) {
      g = { weekday: f.weekday, positionKey: f.positionKey, days: [] };
      map.set(key, g);
    }
    g.days.push(f);
  }
  const groups = [...map.values()];
  for (const g of groups) g.days.sort((a, b) => a.date.localeCompare(b.date));
  groups.sort((a, b) => a.weekday - b.weekday || a.positionKey.localeCompare(b.positionKey));
  return groups;
}

// ── Empfehlungen ─────────────────────────────────────────────────────────────

interface BuildCtx {
  input: StaffingRecoInput;
  /** Monatsschnitt Umsatz über aktive Tage (nur vorhandene Werte). */
  avgRevenueAll: number | null;
  avgPersonsAll: number | null;
}

function detailRow(f: RecoDayFact, hit: boolean): ComparableDayDetail {
  // Tages-SOLL als Peak über die Bedarfs-Schichten (Summe wäre falsch: eine
  // Person kann mehrere Schichten abdecken).
  const required = f.coverage.length > 0 ? Math.max(...f.coverage.map((c) => c.required)) : null;
  const planKnown = f.coverage.length > 0 && f.coverage.every((c) => c.planned != null);
  const istKnown = f.coverage.length > 0 && f.coverage.every((c) => c.actual != null);
  return {
    date: f.date,
    planH: f.planH, istH: f.istH, planCHF: f.planCHF, istCHF: f.istCHF,
    planPersons: planKnown ? Math.max(...f.coverage.map((c) => c.planned as number)) : (f.planEmpCount > 0 ? f.planEmpCount : (f.planH > 0 ? null : 0)),
    istPersons: istKnown ? Math.max(...f.coverage.map((c) => c.actual as number)) : (f.istEmpCount > 0 ? f.istEmpCount : (f.istH > 0 ? null : 0)),
    required,
    unplanned: f.unplanned,
    absences: f.absences,
    revenue: f.revenue,
    persons: f.persons,
    hit,
  };
}

function simulationBaseFor(group: ComparableDayGroup, ctx: BuildCtx, timeWindow: { start: string; end: string } | null, required: number | null): SimulationBase {
  const days = group.days;
  const planHVals = days.map((d) => d.planH);
  const avgPlanH = avg(planHVals) ?? 0;
  const headVals = days.filter((d) => d.planEmpCount > 0).map((d) => d.planEmpCount);
  const avgHead = avg(headVals);
  // Stundensatz aus echten Kosten/Stunden (Plan bevorzugt, sonst Ist) — nie fix.
  const planCHF = days.reduce((s, d) => s + d.planCHF, 0);
  const planH = days.reduce((s, d) => s + d.planH, 0);
  const istCHF = days.reduce((s, d) => s + d.istCHF, 0);
  const istH = days.reduce((s, d) => s + d.istH, 0);
  const rate = planH > 0.01 ? planCHF / planH : istH > 0.01 ? istCHF / istH : null;
  const revVals = days.map((d) => d.revenue).filter((v): v is number => v != null && v > 0);
  const avgRev = avg(revVals);
  const perPerson = avgHead != null && avgHead > 0 && avgPlanH > 0 ? avgPlanH / avgHead : null;
  return {
    weekdayLabel: weekdayLabel(group.weekday),
    positionLabel: positionLabelOf(ctx.input, group.positionKey),
    avgPlanHoursPerDay: avgPlanH,
    avgPlanHeadcount: avgHead,
    avgHourlyCostCHF: rate != null && Number.isFinite(rate) ? rate : null,
    avgRevenueCHF: avgRev,
    requiredPersons: required,
    shiftStart: timeWindow?.start ?? null,
    shiftEnd: timeWindow?.end ?? null,
    avgHoursPerPerson: perPerson,
  };
}

function groupLimitations(group: ComparableDayGroup, ctx: BuildCtx): string[] {
  const out: string[] = [];
  if (ctx.input.personsByDate == null) out.push('Keine Reservationsdaten verfügbar.');
  if (group.days.every((d) => d.revenue == null)) out.push('Kein Tagesumsatz für diese Tage vorhanden.');
  const noPlanTimes = group.days.filter((d) => d.planH > 0 && d.planStartMin == null).length;
  if (noPlanTimes > 0) out.push(`Plan-Zeiten fehlen an ${noPlanTimes} von ${group.days.length} Tagen.`);
  const noIstTimes = group.days.filter((d) => d.istH > 0 && d.istStartMin == null).length;
  if (noIstTimes > 0) out.push(`Ist-Zeiten (Stempelungen) fehlen an ${noIstTimes} von ${group.days.length} Tagen.`);
  return out;
}

function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

/**
 * Erkennungen einer Vergleichsgruppe. Jede Empfehlung ist aus den Tageszeilen
 * nachvollziehbar (hit-Markierung) und erfindet keine Werte.
 */
function buildGroupRecommendations(group: ComparableDayGroup, ctx: BuildCtx): StaffingRecommendation[] {
  const T = RECO_THRESHOLDS;
  const days = group.days;
  const n = days.length;
  if (n < T.minComparableDays) return [];

  const out: StaffingRecommendation[] = [];
  const wdLabel = weekdayLabel(group.weekday);
  const posLabel = positionLabelOf(ctx.input, group.positionKey);
  const basis = dataBasisForDays(n);
  const limitations = groupLimitations(group, ctx);

  const make = (args: {
    variant: string;
    type: RecommendationType;
    tone: RecommendationTone;
    title: string;
    action: string;
    reasoning: string;
    expectedChange: string | null;
    timeWindow: { start: string; end: string } | null;
    hitDates: Set<string>;
    costImpactCHF: number | null;
    keyMetrics: { label: string; value: string }[];
    required: number | null;
  }): StaffingRecommendation => ({
    id: `${args.type}|${group.weekday}|${group.positionKey}|${args.variant}`,
    type: args.type,
    tone: args.tone,
    title: args.title,
    action: args.action,
    weekday: group.weekday,
    weekdayLabel: wdLabel,
    positionKey: group.positionKey,
    positionLabel: posLabel,
    timeWindow: args.timeWindow,
    expectedChange: args.expectedChange,
    reasoning: args.reasoning,
    dataBasis: basis,
    comparableDayCount: n,
    hitDayCount: args.hitDates.size,
    recurrenceShare: args.hitDates.size / n,
    costImpactCHF: args.costImpactCHF,
    keyMetrics: args.keyMetrics,
    comparableDays: days.map((d) => detailRow(d, args.hitDates.has(d.date))),
    limitations,
    simulationBase: simulationBaseFor(group, ctx, args.timeWindow, args.required),
  });

  // Kontext: hohe Personen / tiefer Umsatz (nur echte Daten).
  const personsCtx = (dates: string[]): string | null => {
    if (ctx.input.personsByDate == null || ctx.avgPersonsAll == null) return null;
    const vals = days.filter((d) => dates.includes(d.date) && d.persons != null).map((d) => d.persons as number);
    const m = avg(vals);
    if (m == null) return null;
    if (m >= ctx.avgPersonsAll * T.highPersonsFactor) {
      return `Gleichzeitig lagen die Reservationen mit Ø ${Math.round(m)} Personen deutlich über dem Monatsschnitt (${Math.round(ctx.avgPersonsAll)}).`;
    }
    if (m <= ctx.avgPersonsAll * T.lowRevenueFactor) {
      return `Gleichzeitig lagen die Reservationen mit Ø ${Math.round(m)} Personen deutlich unter dem Monatsschnitt (${Math.round(ctx.avgPersonsAll)}).`;
    }
    return null;
  };
  const revenueCtx = (dates: string[], direction: 'low' | 'high'): string | null => {
    if (ctx.avgRevenueAll == null) return null;
    const vals = days.filter((d) => dates.includes(d.date) && d.revenue != null).map((d) => d.revenue as number);
    const m = avg(vals);
    if (m == null) return null;
    if (direction === 'low' && m <= ctx.avgRevenueAll * T.lowRevenueFactor) {
      return `Der Umsatz lag an diesen Tagen mit Ø ${fmtChf0(m)} deutlich unter dem Monatsschnitt (${fmtChf0(ctx.avgRevenueAll)}).`;
    }
    if (direction === 'high' && m >= ctx.avgRevenueAll * T.highPersonsFactor) {
      return `Der Umsatz lag an diesen Tagen mit Ø ${fmtChf0(m)} deutlich über dem Monatsschnitt (${fmtChf0(ctx.avgRevenueAll)}).`;
    }
    return null;
  };

  // ── 1) Unterbesetzung: Plan-Besetzung unter SOLL (pro Bedarfs-Schicht) ─────
  // Nur Tage mit bekannter Plan-Abdeckung (Zeitdaten vorhanden) zählen.
  const shiftKeys = new Map<string, { start: string; end: string; required: number }>();
  for (const d of days) for (const c of d.coverage) {
    shiftKeys.set(`${c.shiftStart}|${c.shiftEnd}`, { start: c.shiftStart, end: c.shiftEnd, required: c.required });
  }
  let bestUnder: { shift: { start: string; end: string; required: number }; hits: Set<string>; evaluable: number; avgGap: number } | null = null;
  let bestOver: { shift: { start: string; end: string; required: number }; hits: Set<string>; evaluable: number; avgOver: number } | null = null;
  for (const shift of shiftKeys.values()) {
    const evaluable = days.filter((d) => d.coverage.some((c) => c.shiftStart === shift.start && c.shiftEnd === shift.end && c.planned != null));
    if (evaluable.length < T.minComparableDays) continue;
    const gaps: { date: string; gap: number }[] = evaluable.map((d) => {
      const c = d.coverage.find((c) => c.shiftStart === shift.start && c.shiftEnd === shift.end)!;
      return { date: d.date, gap: (c.planned as number) - c.required };
    });
    const underDays = gaps.filter((g) => g.gap < 0);
    if (underDays.length / evaluable.length >= T.recurrenceShare) {
      const avgGap = avg(underDays.map((g) => g.gap)) ?? 0;
      if (!bestUnder || avgGap < bestUnder.avgGap) {
        bestUnder = { shift, hits: new Set(underDays.map((g) => g.date)), evaluable: evaluable.length, avgGap };
      }
    }
    const overDays = gaps.filter((g) => g.gap > 0);
    if (overDays.length / evaluable.length >= T.recurrenceShare) {
      const avgOver = avg(overDays.map((g) => g.gap)) ?? 0;
      if (!bestOver || avgOver > bestOver.avgOver) {
        bestOver = { shift, hits: new Set(overDays.map((g) => g.date)), evaluable: evaluable.length, avgOver };
      }
    }
  }

  if (bestUnder) {
    const { shift, hits, evaluable, avgGap } = bestUnder;
    const pctx = personsCtx([...hits]);
    const rctx = revenueCtx([...hits], 'high');
    out.push(make({
      variant: 'person-plus',
      type: 'unterbesetzung',
      tone: 'critical',
      title: `${wdLabel}: ${posLabel} verstärken`,
      action: `${wdLabel}, ${shift.start}–${shift.end} Uhr: eine zusätzliche Person ${posLabel} einplanen.`,
      reasoning: [
        `An ${hits.size} von ${evaluable} vergleichbaren ${wdLabel}en lag die geplante Besetzung der Schicht ${shift.start}–${shift.end} im Schnitt ${fmtP1(Math.abs(avgGap))} Person(en) unter dem Soll (${shift.required}).`,
        pctx, rctx,
      ].filter(Boolean).join(' '),
      expectedChange: `Besetzung erreicht das Soll von ${shift.required} Person(en) in der Schicht ${shift.start}–${shift.end}.`,
      timeWindow: { start: shift.start, end: shift.end },
      hitDates: hits,
      costImpactCHF: null,
      keyMetrics: [
        { label: 'Ø Lücke', value: `${fmtP1(Math.abs(avgGap))} Person(en)` },
        { label: 'Soll', value: `${shift.required} Person(en)` },
        { label: 'Betroffene Tage', value: `${hits.size} / ${evaluable}` },
      ],
      required: shift.required,
    }));
  }

  if (bestOver) {
    const { shift, hits, evaluable, avgOver } = bestOver;
    const pctx = personsCtx([...hits]);
    const rctx = revenueCtx([...hits], 'low');
    // CHF-Wirkung nur, wenn Stundensatz + Stunden/Person echt ableitbar sind.
    const sim = simulationBaseFor(group, ctx, { start: shift.start, end: shift.end }, shift.required);
    const saving = sim.avgHourlyCostCHF != null && sim.avgHoursPerPerson != null
      ? sim.avgHourlyCostCHF * sim.avgHoursPerPerson
      : null;
    out.push(make({
      variant: 'person-minus',
      type: 'ueberbesetzung',
      tone: 'warn',
      title: `${wdLabel}: ${posLabel} reduziert prüfen`,
      action: `${wdLabel}, ${shift.start}–${shift.end} Uhr: eine Person ${posLabel} weniger einplanen.`,
      reasoning: [
        `An ${hits.size} von ${evaluable} vergleichbaren ${wdLabel}en lag die geplante Besetzung der Schicht ${shift.start}–${shift.end} im Schnitt ${fmtP1(avgOver)} Person(en) über dem Soll (${shift.required}).`,
        pctx, rctx,
      ].filter(Boolean).join(' '),
      expectedChange: saving != null
        ? `≈ ${fmtChf0(saving)} weniger Personalkosten pro ${wdLabel} (Ø ${fmtH1(sim.avgHoursPerPerson as number)} h × ${fmtChf0(sim.avgHourlyCostCHF as number)}/h).`
        : null,
      timeWindow: { start: shift.start, end: shift.end },
      hitDates: hits,
      costImpactCHF: saving,
      keyMetrics: [
        { label: 'Ø Überhang', value: `${fmtP1(avgOver)} Person(en)` },
        { label: 'Soll', value: `${shift.required} Person(en)` },
        { label: 'Betroffene Tage', value: `${hits.size} / ${evaluable}` },
      ],
      required: shift.required,
    }));
  }

  // ── 2) Unterbesetzung: wiederholte Mehrstunden / ungeplante Einsätze ───────
  const extraDays = days.filter((d) => d.istH - d.planH >= T.extraHoursH || d.unplanned > 0);
  if (extraDays.length / n >= T.recurrenceShare) {
    const avgExtra = avg(extraDays.map((d) => d.istH - d.planH)) ?? 0;
    const totalUnplanned = extraDays.reduce((s, d) => s + d.unplanned, 0);
    const avgCost = avg(extraDays.map((d) => d.istCHF - d.planCHF));
    const hits = new Set(extraDays.map((d) => d.date));
    const pctx = personsCtx([...hits]);
    const rctx = revenueCtx([...hits], 'high');
    out.push(make({
      variant: 'stunden-plus',
      type: 'unterbesetzung',
      tone: avgExtra >= T.extraHoursH * 2 ? 'critical' : 'warn',
      title: `${wdLabel}: Mehrstunden bei ${posLabel}`,
      action: `${wdLabel}: mehr Stunden für ${posLabel} einplanen (Ø +${fmtH1(Math.max(avgExtra, 0))} h) oder eine zusätzliche Person vorsehen.`,
      reasoning: [
        `An ${hits.size} von ${n} vergleichbaren ${wdLabel}en fielen im Schnitt ${fmtH1(Math.max(avgExtra, 0))} Stunden mehr an als geplant${totalUnplanned > 0 ? ` und es gab insgesamt ${totalUnplanned} ungeplante Einsätze` : ''}.`,
        pctx, rctx,
      ].filter(Boolean).join(' '),
      expectedChange: avgCost != null && avgCost > 0
        ? `Planung deckt den realen Bedarf; heute entstehen Ø ${fmtChf0(avgCost)} ungeplante Mehrkosten pro ${wdLabel}.`
        : null,
      timeWindow: null,
      hitDates: hits,
      costImpactCHF: avgCost != null && avgCost > 0 ? avgCost : null,
      keyMetrics: [
        { label: 'Ø Mehrstunden', value: `+${fmtH1(Math.max(avgExtra, 0))} h` },
        { label: 'Ungeplante Einsätze', value: `${totalUnplanned}` },
        { label: 'Betroffene Tage', value: `${hits.size} / ${n}` },
      ],
      required: null,
    }));
  }

  // ── 3) Überbesetzung: Ist wiederholt deutlich unter Plan (Stunden) ─────────
  const idleDays = days.filter((d) => d.planH - d.istH >= T.extraHoursH && d.istH > 0);
  if (idleDays.length / n >= T.recurrenceShare) {
    const avgIdle = avg(idleDays.map((d) => d.planH - d.istH)) ?? 0;
    const avgSave = avg(idleDays.map((d) => d.planCHF - d.istCHF));
    const hits = new Set(idleDays.map((d) => d.date));
    const pctx = personsCtx([...hits]);
    const rctx = revenueCtx([...hits], 'low');
    out.push(make({
      variant: 'stunden-minus',
      type: 'ueberbesetzung',
      tone: 'good',
      title: `${wdLabel}: kürzere Schichten bei ${posLabel} möglich`,
      action: `${wdLabel}: Schichten für ${posLabel} um Ø ${fmtH1(avgIdle)} h kürzen.`,
      reasoning: [
        `An ${hits.size} von ${n} vergleichbaren ${wdLabel}en wurden im Schnitt ${fmtH1(avgIdle)} Stunden weniger gearbeitet als geplant.`,
        pctx, rctx,
      ].filter(Boolean).join(' '),
      expectedChange: avgSave != null && avgSave > 0
        ? `≈ ${fmtChf0(avgSave)} Einsparpotenzial pro ${wdLabel}.`
        : null,
      timeWindow: null,
      hitDates: hits,
      costImpactCHF: avgSave != null && avgSave > 0 ? avgSave : null,
      keyMetrics: [
        { label: 'Ø Minderstunden', value: `−${fmtH1(avgIdle)} h` },
        { label: 'Betroffene Tage', value: `${hits.size} / ${n}` },
      ],
      required: null,
    }));
  }

  // ── 4) Schichtzeit-Verschiebung (nur mit echten Plan- UND Ist-Zeiten) ──────
  const timedDays = days.filter((d) =>
    d.planStartMin != null && d.planEndMin != null && d.istStartMin != null && d.istEndMin != null);
  if (timedDays.length >= T.minComparableDays) {
    const startDeltas = timedDays.map((d) => (d.istStartMin as number) - (d.planStartMin as number));
    const endDeltas = timedDays.map((d) => (d.istEndMin as number) - (d.planEndMin as number));
    const medStart = median(startDeltas) ?? 0;
    const medEnd = median(endDeltas) ?? 0;

    const lateStartDays = timedDays.filter((d) => (d.istStartMin as number) - (d.planStartMin as number) >= T.shiftMinutes);
    if (medStart >= T.shiftMinutes && lateStartDays.length / timedDays.length >= T.recurrenceShare) {
      const hits = new Set(lateStartDays.map((d) => d.date));
      const newStart = fmtMin(Math.round(((avg(timedDays.map((d) => d.planStartMin as number)) ?? 0) + medStart)));
      out.push(make({
        variant: 'start-spaeter',
        type: 'schichtzeit',
        tone: 'good',
        title: `${wdLabel}: ${posLabel} später starten`,
        action: `${wdLabel}: Start für ${posLabel} um ~${Math.round(medStart)} Min. nach hinten schieben (≈ ${newStart} Uhr).`,
        reasoning: `An ${hits.size} von ${timedDays.length} vergleichbaren ${wdLabel}en mit Zeitdaten begann die Arbeit im Median ${Math.round(medStart)} Min. später als geplant.`,
        expectedChange: `Weniger Leerlauf am Schichtbeginn (Median-Verschiebung ${Math.round(medStart)} Min.).`,
        timeWindow: null,
        hitDates: hits,
        costImpactCHF: null,
        keyMetrics: [
          { label: 'Median Start-Verschiebung', value: `+${Math.round(medStart)} Min.` },
          { label: 'Tage mit Zeitdaten', value: `${timedDays.length} / ${n}` },
        ],
        required: null,
      }));
    }
    const earlyStartDays = timedDays.filter((d) => (d.planStartMin as number) - (d.istStartMin as number) >= T.shiftMinutes);
    if (-medStart >= T.shiftMinutes && earlyStartDays.length / timedDays.length >= T.recurrenceShare) {
      const hits = new Set(earlyStartDays.map((d) => d.date));
      out.push(make({
        variant: 'start-frueher',
        type: 'schichtzeit',
        tone: 'warn',
        title: `${wdLabel}: ${posLabel} früher starten`,
        action: `${wdLabel}: Start für ${posLabel} um ~${Math.round(-medStart)} Min. vorziehen.`,
        reasoning: `An ${hits.size} von ${timedDays.length} vergleichbaren ${wdLabel}en mit Zeitdaten begann die Arbeit im Median ${Math.round(-medStart)} Min. früher als geplant — der Plan startet zu spät.`,
        expectedChange: `Plan deckt den realen Schichtbeginn ab (Median ${Math.round(-medStart)} Min. früher).`,
        timeWindow: null,
        hitDates: hits,
        costImpactCHF: null,
        keyMetrics: [
          { label: 'Median Start-Verschiebung', value: `−${Math.round(-medStart)} Min.` },
          { label: 'Tage mit Zeitdaten', value: `${timedDays.length} / ${n}` },
        ],
        required: null,
      }));
    }
    const earlyEndDays = timedDays.filter((d) => (d.planEndMin as number) - (d.istEndMin as number) >= T.shiftMinutes);
    if (-medEnd >= T.shiftMinutes && earlyEndDays.length / timedDays.length >= T.recurrenceShare) {
      const hits = new Set(earlyEndDays.map((d) => d.date));
      out.push(make({
        variant: 'ende-frueher',
        type: 'schichtzeit',
        tone: 'good',
        title: `${wdLabel}: ${posLabel} früher beenden`,
        action: `${wdLabel}: Schichtende für ${posLabel} um ~${Math.round(-medEnd)} Min. vorziehen.`,
        reasoning: `An ${hits.size} von ${timedDays.length} vergleichbaren ${wdLabel}en mit Zeitdaten endete die Arbeit im Median ${Math.round(-medEnd)} Min. früher als geplant.`,
        expectedChange: `Weniger Leerlauf am Schichtende (Median ${Math.round(-medEnd)} Min.).`,
        timeWindow: null,
        hitDates: hits,
        costImpactCHF: null,
        keyMetrics: [
          { label: 'Median Ende-Verschiebung', value: `−${Math.round(-medEnd)} Min.` },
          { label: 'Tage mit Zeitdaten', value: `${timedDays.length} / ${n}` },
        ],
        required: null,
      }));
    }
    const lateEndDays = timedDays.filter((d) => (d.istEndMin as number) - (d.planEndMin as number) >= T.shiftMinutes);
    if (medEnd >= T.shiftMinutes && lateEndDays.length / timedDays.length >= T.recurrenceShare) {
      const hits = new Set(lateEndDays.map((d) => d.date));
      out.push(make({
        variant: 'ende-spaeter',
        type: 'schichtzeit',
        tone: 'warn',
        title: `${wdLabel}: ${posLabel} länger einplanen`,
        action: `${wdLabel}: Schichtende für ${posLabel} um ~${Math.round(medEnd)} Min. nach hinten planen.`,
        reasoning: `An ${hits.size} von ${timedDays.length} vergleichbaren ${wdLabel}en mit Zeitdaten endete die Arbeit im Median ${Math.round(medEnd)} Min. später als geplant — der Plan endet zu früh.`,
        expectedChange: `Plan deckt das reale Schichtende ab (Median ${Math.round(medEnd)} Min. später).`,
        timeWindow: null,
        hitDates: hits,
        costImpactCHF: null,
        keyMetrics: [
          { label: 'Median Ende-Verschiebung', value: `+${Math.round(medEnd)} Min.` },
          { label: 'Tage mit Zeitdaten', value: `${timedDays.length} / ${n}` },
        ],
        required: null,
      }));
    }
  }

  // ── 5) Kosten: wiederholte Mehrkosten ohne klares Personal-/Stundenmuster ──
  const hasUnderRec = out.some((r) => r.type === 'unterbesetzung');
  if (!hasUnderRec) {
    const costDays = days.filter((d) => d.istCHF - d.planCHF >= T.costImpactCHF);
    if (costDays.length / n >= T.recurrenceShare) {
      const avgCost = avg(costDays.map((d) => d.istCHF - d.planCHF)) ?? 0;
      const hits = new Set(costDays.map((d) => d.date));
      out.push(make({
        variant: 'mehrkosten',
        type: 'kosten',
        tone: 'warn',
        title: `${wdLabel}: wiederholte Mehrkosten bei ${posLabel}`,
        action: `${wdLabel}: Personaleinsatz für ${posLabel} prüfen — wiederholt Ø ${fmtChf0(avgCost)} über Plan.`,
        reasoning: `An ${hits.size} von ${n} vergleichbaren ${wdLabel}en lagen die Ist-Personalkosten im Schnitt ${fmtChf0(avgCost)} über dem Plan.`,
        expectedChange: `Bis zu ${fmtChf0(avgCost)} pro ${wdLabel} vermeidbar, wenn die Planung den realen Einsatz abbildet.`,
        timeWindow: null,
        hitDates: hits,
        costImpactCHF: avgCost,
        keyMetrics: [
          { label: 'Ø Mehrkosten', value: fmtChf0(avgCost) },
          { label: 'Betroffene Tage', value: `${hits.size} / ${n}` },
        ],
        required: null,
      }));
    }
  }

  // ── 6) Datenqualität: fehlende Stempelungen / fehlende Zeitdaten ───────────
  const stampDays = days.filter((d) => d.missingStamps > 0);
  const reqExists = days.some((d) => d.coverage.length > 0);
  const noPlanTimeDays = days.filter((d) => d.planH > 0 && d.planStartMin == null);
  if (stampDays.length / n >= T.recurrenceShare) {
    const total = stampDays.reduce((s, d) => s + d.missingStamps, 0);
    const hits = new Set(stampDays.map((d) => d.date));
    out.push(make({
      variant: 'stempelung',
      type: 'datenqualitaet',
      tone: 'info',
      title: `${wdLabel}: fehlende Stempelungen bei ${posLabel}`,
      action: `Zeiterfassung für ${posLabel} am ${wdLabel} prüfen — ${total} fehlende Stempelungen.`,
      reasoning: `An ${hits.size} von ${n} vergleichbaren ${wdLabel}en fehlen Ist-Stempelungen (${total} MA-Tage). Ohne Ist-Daten sind Besetzungs- und Stundenvergleiche unvollständig.`,
      expectedChange: null,
      timeWindow: null,
      hitDates: hits,
      costImpactCHF: null,
      keyMetrics: [
        { label: 'Fehlende Stempelungen', value: `${total}` },
        { label: 'Betroffene Tage', value: `${hits.size} / ${n}` },
      ],
      required: null,
    }));
  } else if (reqExists && noPlanTimeDays.length / n >= T.recurrenceShare) {
    const hits = new Set(noPlanTimeDays.map((d) => d.date));
    out.push(make({
      variant: 'planzeiten',
      type: 'datenqualitaet',
      tone: 'info',
      title: `${wdLabel}: Plan-Zeiten für ${posLabel} fehlen`,
      action: `Dienstplan-Zeiten für ${posLabel} am ${wdLabel} erfassen, damit der Soll-Abgleich möglich wird.`,
      reasoning: `Für ${posLabel} ist ein Personalbedarf definiert, aber an ${hits.size} von ${n} vergleichbaren ${wdLabel}en fehlen Plan-Zeiten — der Besetzungsvergleich ist dort nicht möglich.`,
      expectedChange: null,
      timeWindow: null,
      hitDates: hits,
      costImpactCHF: null,
      keyMetrics: [
        { label: 'Tage ohne Plan-Zeiten', value: `${hits.size} / ${n}` },
      ],
      required: null,
    }));
  }

  return out;
}

const TONE_RANK: Record<RecommendationTone, number> = { critical: 4, warn: 3, good: 2, info: 1 };
const BASIS_RANK: Record<RecommendationDataBasis, number> = { hoch: 3, mittel: 2, gering: 1 };

/**
 * Priorisierung (Spec): 1. operative Dringlichkeit, 2. wiederkehrendes Muster,
 * 3. finanzielle Auswirkung, 4. Datenbasis. Stabiler Tiebreak über die id.
 */
export function sortRecommendations(recs: StaffingRecommendation[]): StaffingRecommendation[] {
  return [...recs].sort((a, b) =>
    TONE_RANK[b.tone] - TONE_RANK[a.tone]
    || b.recurrenceShare - a.recurrenceShare
    || Math.abs(b.costImpactCHF ?? 0) - Math.abs(a.costImpactCHF ?? 0)
    || BASIS_RANK[b.dataBasis] - BASIS_RANK[a.dataBasis]
    || a.id.localeCompare(b.id));
}

export type RecommendationFilter = 'alle' | RecommendationType;

export function filterRecommendations(
  recs: StaffingRecommendation[],
  filter: RecommendationFilter,
): StaffingRecommendation[] {
  if (filter === 'alle') return recs;
  return recs.filter((r) => r.type === filter);
}

export function visibleRecommendations(
  recs: StaffingRecommendation[],
  showAll: boolean,
): StaffingRecommendation[] {
  return showAll ? recs : recs.slice(0, MAX_VISIBLE_RECOMMENDATIONS);
}

/** Hauptfunktion: Fakten → Gruppen → priorisierte Empfehlungen. */
export function buildStaffingRecommendations(input: StaffingRecoInput): StaffingRecoResult {
  const facts = buildRecoDayFacts(input);
  const groups = groupComparableDays(facts);
  let evaluated = 0;
  let skipped = 0;
  const ctxAll: BuildCtx = {
    input,
    avgRevenueAll: avg(facts.filter((f, i, arr) => arr.findIndex((x) => x.date === f.date) === i && f.revenue != null).map((f) => f.revenue as number)),
    avgPersonsAll: input.personsByDate == null ? null
      : avg(facts.filter((f, i, arr) => arr.findIndex((x) => x.date === f.date) === i && f.persons != null).map((f) => f.persons as number)),
  };
  const recs: StaffingRecommendation[] = [];
  for (const g of groups) {
    if (g.days.length < RECO_THRESHOLDS.minComparableDays) { skipped += 1; continue; }
    evaluated += 1;
    recs.push(...buildGroupRecommendations(g, ctxAll));
  }
  return {
    recommendations: sortRecommendations(recs),
    facts,
    evaluatedGroups: evaluated,
    skippedGroups: skipped,
    hasAnyData: facts.length > 0,
    reservationsAvailable: input.personsByDate != null,
    revenueAvailable: Object.keys(input.dailyRevenue).length > 0,
  };
}

// ── Simulation (rein lokal — keine Speicherung, kein Dienstplan-Write) ───────

function durationH(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const a = timeToMinutes(start);
  const b = timeToMinutes(end);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
  return (b - a) / 60;
}

/**
 * Wendet die Anpassungen auf die Basis der Vergleichstage an. Alle Werte
 * stammen aus echten Daten; wo eine Grösse fehlt (Stundensatz, Umsatz, SOLL),
 * bleibt das Ergebnisfeld null und ein Hinweis wird geliefert — nichts wird
 * erfunden, nichts wird still auf 0 gesetzt.
 */
export function applySimulation(base: SimulationBase, adj: SimulationAdjustments): SimulationResult {
  const issues: string[] = [];
  const basePlanHours = fin(base.avgPlanHoursPerDay);
  const baseCost = base.avgHourlyCostCHF != null ? basePlanHours * base.avgHourlyCostCHF : null;
  if (base.avgHourlyCostCHF == null) issues.push('Kein Stundensatz ableitbar — Kostenwirkung nicht berechenbar.');

  // Personen-Wirkung: Stunden pro Person aus echten Daten, sonst SOLL-Schichtdauer.
  const perPersonH = base.avgHoursPerPerson ?? durationH(base.shiftStart, base.shiftEnd);
  let hours = basePlanHours + fin(adj.deltaHours);
  if (adj.deltaPeople !== 0) {
    if (perPersonH != null) hours += adj.deltaPeople * perPersonH;
    else issues.push('Stunden pro Person unbekannt — Personen-Änderung wirkt nicht auf die Stunden.');
  }

  // Zeitfenster-Wirkung: Dauer-Differenz × betroffene Personen (SOLL bzw. Ø Plan).
  const baseDur = durationH(base.shiftStart, base.shiftEnd);
  const newStart = adj.startTime ?? base.shiftStart;
  const newEnd = adj.endTime ?? base.shiftEnd;
  const newDur = durationH(newStart, newEnd);
  if ((adj.startTime || adj.endTime)) {
    if (baseDur != null && newDur != null) {
      const affected = base.requiredPersons ?? base.avgPlanHeadcount ?? 1;
      hours += (newDur - baseDur) * affected;
    } else {
      issues.push('Zeitfenster unvollständig — Start-/Endzeit-Änderung wirkt nicht auf die Stunden.');
    }
  }

  if (hours < 0) {
    issues.push('Anpassung ergäbe negative Planstunden — auf 0 begrenzt.');
    hours = 0;
  }
  if (!Number.isFinite(hours)) hours = 0;

  const newCost = base.avgHourlyCostCHF != null ? hours * base.avgHourlyCostCHF : null;
  const pkq = (cost: number | null): number | null => {
    if (cost == null) return null;
    if (base.avgRevenueCHF == null || base.avgRevenueCHF <= 0) return null;
    const v = (cost / base.avgRevenueCHF) * 100;
    return Number.isFinite(v) ? v : null;
  };
  if (base.avgRevenueCHF == null || base.avgRevenueCHF <= 0) {
    issues.push('Kein Umsatz für diese Tage — Personalkostenquote nicht berechenbar.');
  }

  let newHeadcount: number | null = null;
  if (base.avgPlanHeadcount != null) {
    newHeadcount = Math.max(0, base.avgPlanHeadcount + adj.deltaPeople);
  } else if (adj.deltaPeople !== 0) {
    issues.push('Geplante Personenzahl unbekannt — Besetzungsdiff nicht berechenbar.');
  }
  const staffingDiff = newHeadcount != null && base.requiredPersons != null
    ? newHeadcount - base.requiredPersons
    : null;

  return {
    basePlanHours,
    baseCostCHF: baseCost,
    basePkqPct: pkq(baseCost),
    newHeadcount,
    newPlanHours: hours,
    newCostCHF: newCost,
    newPkqPct: pkq(newCost),
    deltaHours: hours - basePlanHours,
    deltaCostCHF: baseCost != null && newCost != null ? newCost - baseCost : null,
    staffingDiff,
    issues,
  };
}
