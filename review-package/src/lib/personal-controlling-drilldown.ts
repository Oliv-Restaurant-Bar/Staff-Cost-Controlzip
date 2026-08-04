/**
 * Personalcontrolling Drilldown & Ursachenanalyse — reine Berechnungslogik.
 *
 * Grenzen (bewusst):
 *  - Kein DOM, kein Supabase, keine Seiteneffekte — nur Primitive rein/raus
 *    (gleiche Boundary wie personal-fix-reconciliation.ts).
 *  - Die Faktentabelle deckt NUR den Flex-Bereich mit Tagesgranularität ab:
 *    variable Mitarbeitende (Plan/Ist-Arbeitstage) + Zusatzkosten-Tage von
 *    Fixlohn-Mitarbeitenden. Fixlöhne und Ferienabbau haben KEINE
 *    Tagesgranularität und werden im Dialog als Monatslinien gebrückt
 *    (Abstimmung gegen pfix.active.istTotal — nie neu berechnet).
 *  - Die Tages-Personalquote ist eine Näherung: Fixkosten werden gleichmässig
 *    auf die Tage im Betrachtungszeitraum verteilt (im UI so ausgewiesen).
 *
 * Die Eingabedaten stammen 1:1 aus den bestehenden Seiten-Loadern
 * (loadDailyPlanDetails / loadDailyIstDetails / loadZusatz*Details) —
 * die FE-Skip-/Pausenabzugs-Regeln werden hier NICHT dupliziert.
 */

import { fmtChfWhole, type ComparisonTone } from './personal-fix-reconciliation';

// ── Typen ────────────────────────────────────────────────────────────────────

export interface DrilldownEmployeeInput {
  id: string;
  name: string;
  /** Abteilung ('service' | 'küche' | …) — Fallback fürs Positions-Grouping. */
  department: string;
  /** Positions-Slug (employee.primaryStation) oder null. */
  position: string | null;
  /** true = Fixlohn (nur Zusatzkosten-Tage zählen im Flex-Bereich). */
  isFixed: boolean;
}

/** Ein Plan- oder Ist-Arbeitstag (Output der bestehenden Loader, flach). */
export interface DrilldownDayValue {
  empId: string;
  /** YYYY-MM-DD */
  date: string;
  hours: number;
  /** Arbeitgeberkosten CHF (Stunden × Lohn × AG-Faktor) — von der Seite geliefert. */
  cost: number;
}

/** Abwesenheitstag (aus actual-hours: FE / Krank / Unfall …). */
export interface DrilldownAbsenceDay {
  empId: string;
  date: string;
  type: string;
}

/** Ein Zeitfenster (HH:MM) einer Schicht — Plan aus schedule-v2, Ist aus Stempelung. */
export interface DrilldownShiftSlot { start: string; end: string }

/** Schichtzeiten pro MA-Tag (nur wo vorhanden — NIE geschätzt). Key: "empId|YYYY-MM-DD". */
export interface DrilldownShiftTimes {
  planSlots: DrilldownShiftSlot[];
  istSlots: DrilldownShiftSlot[];
  /** Pausenabzug Plan in h (brutto − netto) oder null wenn unbekannt. */
  planBreakH: number | null;
}

export interface DrilldownInput {
  year: number;
  month: number; // 1-basiert
  /** Pro-rata-Stichtag (Tag im Monat) oder null = ganzer Monat. */
  cutoffDay: number | null;
  /**
   * Letzter Tag, für den vollständige Ist-Daten erwartet werden
   * (Vergangenheits-Monat = Monatslänge, laufender Monat = gestern, Zukunft = 0).
   * Fehlende Stempelungen werden nur bis zu diesem Tag geflaggt.
   */
  lastCompletedDay: number;
  employees: DrilldownEmployeeInput[];
  /** Variable MA: geplante Arbeitstage (FE bereits übersprungen). */
  planDays: DrilldownDayValue[];
  /** Variable MA: Ist-Arbeitstage. */
  istDays: DrilldownDayValue[];
  /** Fixlohn-MA: Zusatzkosten-Plantage (isAdditionalCostPlan). */
  zusatzPlanDays: DrilldownDayValue[];
  /** Fixlohn-MA: Zusatzkosten-Ist-Tage (isAdditionalCost). */
  zusatzIstDays: DrilldownDayValue[];
  /** Abwesenheiten (FE/Krank/Unfall …) aus actual-hours. */
  absences: DrilldownAbsenceDay[];
  /** Tage mit Überstunden aus der bestehenden Überstunden-Analyse: "empId|YYYY-MM-DD". */
  overtimeDayKeys: string[];
  /** Absenz-Codes Ferien/Krankheit/Unfall (aus der Seite, SSOT `absence-utils`). */
  vacationCodes: string[];
  sickCodes: string[];
  accidentCodes: string[];
  /** Netto-Tagesumsätze YYYY-MM-DD → CHF. */
  dailyRevenue: Record<string, number>;
  /** Monatliche Fixkosten (AG-Total) für die anteilige Tages-Personalquote. */
  fixMonthCHF: number;
  /**
   * Optionale Schichtzeiten pro MA-Tag ("empId|YYYY-MM-DD") für die Detailstufe.
   * Fehlende Einträge werden im UI als "—" gezeigt — nie geschätzt.
   */
  shiftTimes?: Record<string, DrilldownShiftTimes>;
}

export type DrilldownGroup = 'day' | 'employee' | 'position';
export type DrilldownPeriod = 'day' | 'week' | 'month';

export type DrilldownCause =
  | 'ueberstunden'
  | 'ferien'
  | 'krankheit'
  | 'unfall'
  | 'zusatzkosten'
  | 'fehlende_stempelung'
  | 'ungeplant'
  | 'mehr_stunden'
  | 'weniger_stunden'
  | 'umsatz_tief';

export const DRILLDOWN_CAUSE_LABEL: Record<DrilldownCause, string> = {
  ueberstunden:        'Überstunden',
  ferien:              'Ferien',
  krankheit:           'Krankheit',
  unfall:              'Unfall',
  zusatzkosten:        'Zusatzkosten',
  fehlende_stempelung: 'Fehlende Stempelung',
  ungeplant:           'Ungeplanter Einsatz',
  mehr_stunden:        'Mehr Stunden als geplant',
  weniger_stunden:     'Weniger Stunden als geplant',
  umsatz_tief:         'Umsatz unter Monatsschnitt',
};

/** Anzeige-Priorität (kleiner = wichtiger) für Ursachen-Pills und Erklärungen. */
const CAUSE_PRIORITY: DrilldownCause[] = [
  'fehlende_stempelung', 'ueberstunden', 'ungeplant', 'zusatzkosten',
  'krankheit', 'unfall', 'ferien', 'mehr_stunden', 'weniger_stunden', 'umsatz_tief',
];

export interface DrilldownCauseCount { cause: DrilldownCause; count: number }

export interface DrilldownRow {
  key: string;
  label: string;
  sublabel?: string;
  planH: number;
  istH: number;
  diffH: number;
  planCHF: number;
  istCHF: number;
  diffCHF: number;
  /** Nur bei Zeit-Gruppierung; null wenn kein Umsatz erfasst. */
  revenue: number | null;
  /** Näherungs-Personalquote % (Flex-Ist + anteilige Fixkosten) / Umsatz; nur Zeit-Gruppierung. */
  pkqPct: number | null;
  causes: DrilldownCauseCount[];
  tone: ComparisonTone;
  explanation: string;
}

// ── Schwellenwerte (zentral, testbar) ────────────────────────────────────────

export const DRILLDOWN_THRESHOLDS = {
  /** CHF über Plan ab dem eine Zeile orange bzw. rot wird. */
  warnCHF: 50,
  critCHF: 200,
  /** Prozent über Plan (relativ) ab dem orange bzw. rot (mit CHF-Mindestbetrag). */
  warnPct: 5,
  critPct: 15,
  /** Mindest-CHF damit die Prozent-Regel überhaupt greift (Kleinstbeträge bleiben grün). */
  minCHFForPct: 20,
  /** Stunden-Differenz ab der mehr_stunden / weniger_stunden geflaggt wird. */
  hoursFlag: 2,
  /** Tagesumsatz unter diesem Anteil des Monatsschnitts → umsatz_tief. */
  lowRevenueFactor: 0.75,
  /** Detailstufe: Toleranz der Abstimmung Detail ↔ übergeordnete Zeile. */
  detailToleranceH: 0.05,
  detailToleranceCHF: 1,
  /** Detailstufe: |Diff h| unterhalb derer eine Schicht als "ohne Stundenabweichung" gilt. */
  shiftQuietHours: 0.25,
} as const;

/** Ton einer Drilldown-Zeile: über Plan = schlecht (orange/rot), im Rahmen/darunter = grün. */
export function toneForDrilldownRow(planCHF: number, diffCHF: number): ComparisonTone {
  const t = DRILLDOWN_THRESHOLDS;
  const pctOver = planCHF > 0 ? (diffCHF / planCHF) * 100 : (diffCHF > 0 ? 100 : 0);
  if (diffCHF >= t.critCHF || (pctOver >= t.critPct && diffCHF >= t.warnCHF)) return 'critical';
  if (diffCHF >= t.warnCHF || (pctOver >= t.warnPct && diffCHF >= t.minCHFForPct)) return 'warn';
  return 'good';
}

// ── Datums-Helfer (lokal, ohne Abhängigkeiten) ───────────────────────────────

const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WEEKDAY_LONG  = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function dateFromIso(date: string): Date {
  return new Date(`${date}T12:00:00`); // Mittag → keine DST-Kanten
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** ISO-Kalenderwoche (1–53) eines YYYY-MM-DD-Datums. */
export function isoWeekOf(date: string): number {
  const d = dateFromIso(date);
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Mo=0
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // Donnerstag der Woche
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }

export function dayLabel(date: string): string {
  const d = dateFromIso(date);
  return `${WEEKDAY_SHORT[d.getDay()]} ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.`;
}

export function dayLabelLong(date: string): string {
  const d = dateFromIso(date);
  return `${WEEKDAY_LONG[d.getDay()]} ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.`;
}

/** "KW 24 (08.–14.06.)" — Wochenspanne an den Monat geclippt. */
export function weekLabel(year: number, month: number, week: number, datesInWeek: string[]): string {
  const sorted = [...datesInWeek].sort();
  const first = dateFromIso(sorted[0]);
  const last = dateFromIso(sorted[sorted.length - 1]);
  return `KW ${week} (${pad2(first.getDate())}.–${pad2(last.getDate())}.${pad2(month)}.)`;
}

// ── Faktentabelle ────────────────────────────────────────────────────────────

export interface DrilldownFactCell {
  empId: string;
  date: string;
  dayNum: number;
  planH: number;
  istH: number;
  planCHF: number;
  istCHF: number;
  zusatz: boolean;
  absence: string | null;
  overtime: boolean;
  missingStamp: boolean;
}

/** Baut die per-MA-per-Tag-Faktentabelle EINMAL auf; Aggregationen laufen darüber. */
export function buildFactCells(input: DrilldownInput): DrilldownFactCell[] {
  const cells = new Map<string, DrilldownFactCell>();
  const monthPrefix = `${input.year}-${pad2(input.month)}`;
  const maxDay = input.cutoffDay ?? daysInMonth(input.year, input.month);

  const get = (empId: string, date: string): DrilldownFactCell | null => {
    if (!date.startsWith(monthPrefix)) return null;
    const dayNum = parseInt(date.slice(-2), 10);
    if (!Number.isFinite(dayNum) || dayNum < 1 || dayNum > maxDay) return null;
    const key = `${empId}|${date}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        empId, date, dayNum,
        planH: 0, istH: 0, planCHF: 0, istCHF: 0,
        zusatz: false, absence: null, overtime: false, missingStamp: false,
      };
      cells.set(key, cell);
    }
    return cell;
  };

  // Rundung r2 pro Zelle — identisch zur zentralen Quelle personalkosten.ts
  // (flexKostenProTag rundet planKosten/istKosten je Zelle auf 2 Stellen).
  // Ausschlüsse (FE/Absenzen/Zusatzkosten der Fix-MA) sind bereits von den
  // Seiten-Loadern angewandt; zusatz* fliesst hier bewusst separat ein.
  for (const p of input.planDays) {
    const c = get(p.empId, p.date);
    if (!c) continue;
    c.planH = round2(c.planH + p.hours); c.planCHF = round2(c.planCHF + p.cost);
  }
  for (const p of input.zusatzPlanDays) {
    const c = get(p.empId, p.date);
    if (!c) continue;
    c.planH = round2(c.planH + p.hours); c.planCHF = round2(c.planCHF + p.cost); c.zusatz = true;
  }
  for (const i of input.istDays) {
    const c = get(i.empId, i.date);
    if (!c) continue;
    c.istH = round2(c.istH + i.hours); c.istCHF = round2(c.istCHF + i.cost);
  }
  for (const i of input.zusatzIstDays) {
    const c = get(i.empId, i.date);
    if (!c) continue;
    c.istH = round2(c.istH + i.hours); c.istCHF = round2(c.istCHF + i.cost); c.zusatz = true;
  }
  for (const a of input.absences) {
    const c = get(a.empId, a.date);
    if (!c) continue;
    c.absence = a.type;
  }

  const overtimeSet = new Set(input.overtimeDayKeys);
  for (const c of cells.values()) {
    if (overtimeSet.has(`${c.empId}|${c.date}`)) c.overtime = true;
    c.missingStamp =
      c.planH > 0 && c.istH === 0 && !c.absence && c.dayNum <= input.lastCompletedDay;
  }

  return [...cells.values()].sort((a, b) =>
    a.date === b.date ? a.empId.localeCompare(b.empId) : a.date.localeCompare(b.date));
}

// ── Aggregation ──────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

function collectCauses(
  bucket: DrilldownFactCell[],
  input: Pick<DrilldownInput, 'vacationCodes' | 'sickCodes' | 'accidentCodes'>,
  diffH: number,
  extra: DrilldownCauseCount[] = [],
): DrilldownCauseCount[] {
  const counts = new Map<DrilldownCause, number>();
  const bump = (cause: DrilldownCause, by = 1) => counts.set(cause, (counts.get(cause) ?? 0) + by);
  for (const c of bucket) {
    if (c.overtime) bump('ueberstunden');
    if (c.absence && input.vacationCodes.includes(c.absence)) bump('ferien');
    else if (c.absence && input.sickCodes.includes(c.absence)) bump('krankheit');
    else if (c.absence && input.accidentCodes.includes(c.absence)) bump('unfall');
    if (c.zusatz && c.istH > 0) bump('zusatzkosten');
    if (c.missingStamp) bump('fehlende_stempelung');
    if (!c.zusatz && c.istH > 0 && c.planH === 0) bump('ungeplant');
  }
  if (diffH >= DRILLDOWN_THRESHOLDS.hoursFlag) bump('mehr_stunden');
  else if (diffH <= -DRILLDOWN_THRESHOLDS.hoursFlag) bump('weniger_stunden');
  for (const e of extra) bump(e.cause, e.count);
  return [...counts.entries()]
    .map(([cause, count]) => ({ cause, count }))
    .sort((a, b) => CAUSE_PRIORITY.indexOf(a.cause) - CAUSE_PRIORITY.indexOf(b.cause));
}

const fmtH = (n: number) =>
  n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Erklärungssatz einer Zeile, z. B. "+18.0 h gegenüber Soll (CHF 450 über Plan) — Überstunden, Ferien." */
export function buildRowExplanation(
  diffH: number, diffCHF: number, causes: DrilldownCauseCount[],
): string {
  if (Math.abs(diffH) < 0.05 && Math.abs(diffCHF) < 1) return 'Im Plan.';
  const sign = diffH >= 0 ? '+' : '−';
  const dir = diffCHF >= 0 ? 'über' : 'unter';
  const base = `${sign}${fmtH(Math.abs(diffH))} h gegenüber Soll (${fmtChfWhole(Math.abs(diffCHF))} ${dir} Plan)`;
  const top = causes
    .filter(c => c.cause !== 'mehr_stunden' && c.cause !== 'weniger_stunden')
    .slice(0, 2)
    .map(c => DRILLDOWN_CAUSE_LABEL[c.cause]);
  return top.length > 0 ? `${base} — ${top.join(', ')}.` : `${base}.`;
}

function positionLabelFromSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Anzeige-Label fürs Positions-Grouping: primaryStation-Slug, Fallback Abteilung. */
export function positionKeyForEmployee(emp: DrilldownEmployeeInput): { key: string; label: string } {
  if (emp.position) return { key: `pos:${emp.position}`, label: positionLabelFromSlug(emp.position) };
  const dept = emp.department === 'küche' || emp.department === 'kueche' ? 'Küche' : 'Service';
  return { key: `dept:${dept}`, label: `${dept} (ohne Position)` };
}

export interface DrilldownRowsOptions {
  group: DrilldownGroup;
  /** Nur bei group='day' relevant. */
  period: DrilldownPeriod;
}

export function buildDrilldownRows(
  input: DrilldownInput,
  cells: DrilldownFactCell[],
  opts: DrilldownRowsOptions,
): DrilldownRow[] {
  const scopeDays = Math.min(input.cutoffDay ?? Infinity, daysInMonth(input.year, input.month));
  const fixPerDay = scopeDays > 0 ? input.fixMonthCHF / scopeDays : 0;

  // Monatsschnitt Umsatz (nur erfasste Tage im Scope) für umsatz_tief.
  const monthPrefix = `${input.year}-${pad2(input.month)}`;
  const revenueDates = Object.keys(input.dailyRevenue)
    .filter(d => d.startsWith(monthPrefix) && parseInt(d.slice(-2), 10) <= scopeDays)
    .filter(d => (input.dailyRevenue[d] ?? 0) > 0);
  const avgRevenue = revenueDates.length > 0
    ? revenueDates.reduce((s, d) => s + input.dailyRevenue[d], 0) / revenueDates.length
    : 0;

  const empById = new Map(input.employees.map(e => [e.id, e]));

  type Bucket = { key: string; label: string; sublabel?: string; cells: DrilldownFactCell[]; dates: Set<string> };
  const buckets = new Map<string, Bucket>();
  const push = (key: string, label: string, sublabel: string | undefined, c: DrilldownFactCell) => {
    let b = buckets.get(key);
    if (!b) { b = { key, label, sublabel, cells: [], dates: new Set() }; buckets.set(key, b); }
    b.cells.push(c);
    b.dates.add(c.date);
  };

  for (const c of cells) {
    if (opts.group === 'day') {
      if (opts.period === 'day') {
        push(c.date, dayLabel(c.date), undefined, c);
      } else if (opts.period === 'week') {
        const w = isoWeekOf(c.date);
        push(`w${pad2(w)}`, '', undefined, c); // Label nach dem Sammeln (braucht alle Daten)
      } else {
        push('month', `${pad2(input.month)}.${input.year}`, undefined, c);
      }
    } else if (opts.group === 'employee') {
      const emp = empById.get(c.empId);
      const label = emp?.name ?? c.empId;
      const sub = emp ? positionKeyForEmployee(emp).label : undefined;
      push(`emp:${c.empId}`, label, sub, c);
    } else {
      const emp = empById.get(c.empId);
      const pk = emp ? positionKeyForEmployee(emp) : { key: 'dept:Service', label: 'Service (ohne Position)' };
      push(pk.key, pk.label, undefined, c);
    }
  }

  const isTimeGroup = opts.group === 'day';

  const rows: DrilldownRow[] = [...buckets.values()].map(b => {
    let planH = 0, istH = 0, planCHF = 0, istCHF = 0;
    for (const c of b.cells) { planH += c.planH; istH += c.istH; planCHF += c.planCHF; istCHF += c.istCHF; }
    const diffH = istH - planH;
    const diffCHF = istCHF - planCHF;

    let revenue: number | null = null;
    let pkqPct: number | null = null;
    const extraCauses: DrilldownCauseCount[] = [];
    if (isTimeGroup) {
      let rev = 0; let hasRev = false;
      for (const d of b.dates) {
        const r = input.dailyRevenue[d];
        if (r !== undefined && r > 0) { rev += r; hasRev = true; }
      }
      revenue = hasRev ? round2(rev) : null;
      if (revenue !== null && revenue > 0) {
        pkqPct = round2(((istCHF + fixPerDay * b.dates.size) / revenue) * 100);
      }
      if (opts.period === 'day' && revenue !== null && avgRevenue > 0
          && revenue < avgRevenue * DRILLDOWN_THRESHOLDS.lowRevenueFactor) {
        extraCauses.push({ cause: 'umsatz_tief', count: 1 });
      }
    }

    const causes = collectCauses(b.cells, input, diffH, extraCauses);
    const tone = toneForDrilldownRow(planCHF, diffCHF);
    let label = b.label;
    if (opts.group === 'day' && opts.period === 'week') {
      const w = parseInt(b.key.slice(1), 10);
      label = weekLabel(input.year, input.month, w, [...b.dates]);
    }

    return {
      key: b.key,
      label,
      sublabel: b.sublabel,
      planH: round2(planH), istH: round2(istH), diffH: round2(diffH),
      planCHF: round2(planCHF), istCHF: round2(istCHF), diffCHF: round2(diffCHF),
      revenue, pkqPct, causes, tone,
      explanation: buildRowExplanation(diffH, diffCHF, causes),
    };
  });

  rows.sort((a, b) => {
    if (isTimeGroup) return a.key.localeCompare(b.key);
    return Math.abs(b.diffCHF) - Math.abs(a.diffCHF); // grösste Abweichung zuerst
  });
  return rows;
}

// ── Summen & Hauptursachen-Satz ──────────────────────────────────────────────

export interface DrilldownTotals {
  planH: number; istH: number; diffH: number;
  planCHF: number; istCHF: number; diffCHF: number;
  revenue: number | null;
}

export function summarizeDrilldownCells(
  cells: DrilldownFactCell[], input: DrilldownInput,
): DrilldownTotals {
  let planH = 0, istH = 0, planCHF = 0, istCHF = 0;
  for (const c of cells) { planH += c.planH; istH += c.istH; planCHF += c.planCHF; istCHF += c.istCHF; }
  const scopeDays = Math.min(input.cutoffDay ?? Infinity, daysInMonth(input.year, input.month));
  const monthPrefix = `${input.year}-${pad2(input.month)}`;
  let rev = 0; let hasRev = false;
  for (const [d, r] of Object.entries(input.dailyRevenue)) {
    if (!d.startsWith(monthPrefix)) continue;
    if (parseInt(d.slice(-2), 10) > scopeDays) continue;
    if (r > 0) { rev += r; hasRev = true; }
  }
  return {
    planH: round2(planH), istH: round2(istH), diffH: round2(istH - planH),
    planCHF: round2(planCHF), istCHF: round2(istCHF), diffCHF: round2(istCHF - planCHF),
    revenue: hasRev ? round2(rev) : null,
  };
}

/**
 * "…, hauptsächlich verursacht durch Mittwoch 05.03. und Donnerstag 06.03."
 * Nimmt die Top-N Zeilen mit positiver CHF-Abweichung; null wenn keine über Plan.
 */
export function buildMainCauseSentence(rows: DrilldownRow[], topN = 2): string | null {
  const over = rows.filter(r => r.diffCHF > 0).sort((a, b) => b.diffCHF - a.diffCHF).slice(0, topN);
  if (over.length === 0) return null;
  const labels = over.map(r => r.label);
  const joined = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} und ${labels[labels.length - 1]}`;
  return `Hauptsächlich verursacht durch ${joined}.`;
}

// ── CSV-Export (rein, Blob-IO macht der Dialog) ──────────────────────────────

const csvField = (v: string | number | null): string => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : v;
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ── Detailstufe (2. Drilldown-Ebene: Tag / Mitarbeitende / Position) ─────────

/** Die angeklickte Übersichtszeile — bestimmt Filter + Abstimmungsreferenz. */
export interface DrilldownDetailSelection {
  group: DrilldownGroup;
  period: DrilldownPeriod;
  key: string;
  label: string;
  sublabel?: string;
}

/** Zellen, die zur angeklickten Zeile gehören (gleiche Bucket-Logik wie buildDrilldownRows). */
export function filterCellsForSelection(
  input: DrilldownInput,
  cells: DrilldownFactCell[],
  sel: Pick<DrilldownDetailSelection, 'group' | 'period' | 'key'>,
): DrilldownFactCell[] {
  if (sel.group === 'day') {
    if (sel.period === 'day') return cells.filter(c => c.date === sel.key);
    if (sel.period === 'week') return cells.filter(c => `w${pad2(isoWeekOf(c.date))}` === sel.key);
    return [...cells]; // Monat = alle Zellen im Scope
  }
  if (sel.group === 'employee') {
    const empId = sel.key.startsWith('emp:') ? sel.key.slice(4) : sel.key;
    return cells.filter(c => c.empId === empId);
  }
  const empById = new Map(input.employees.map(e => [e.id, e]));
  return cells.filter(c => {
    const emp = empById.get(c.empId);
    const pk = emp ? positionKeyForEmployee(emp) : { key: 'dept:Service', label: '' };
    return pk.key === sel.key;
  });
}

/**
 * Zusätzliche Schicht-Auffälligkeiten (nur Detailstufe, bewusst GETRENNT von
 * DrilldownCause — die bestehenden Ursachen bleiben die SSOT und werden
 * unverändert weiterverwendet).
 */
export type DrilldownShiftFlag =
  | 'zeiten_abweichend'      // Plan- und Ist-Zeiten vorhanden, aber unterschiedlich
  | 'kosten_ohne_stunden'    // Kostenabweichung ohne nennenswerte Stundenabweichung
  | 'stunden_ohne_kosten';   // Stundenabweichung ohne relevante Kostenabweichung

export const DRILLDOWN_SHIFT_FLAG_LABEL: Record<DrilldownShiftFlag, string> = {
  zeiten_abweichend:   'Schichtzeiten weichen ab',
  kosten_ohne_stunden: 'Kostenabweichung ohne Stundenabweichung',
  stunden_ohne_kosten: 'Stundenabweichung ohne Kostenwirkung',
};

const fmtSlots = (slots: DrilldownShiftSlot[]): string | null =>
  slots.length > 0 ? slots.map(s => `${s.start}–${s.end}`).join(' · ') : null;

export interface DrilldownShiftRow {
  /** "empId|YYYY-MM-DD" */
  key: string;
  date: string;
  dateLabel: string;
  empId: string;
  empName: string;
  position: string;
  /** "11:00–14:00 · 18:00–22:00" oder null = keine Zeiten vorhanden. */
  planTimes: string | null;
  istTimes: string | null;
  /** Pausenabzug Plan (h) oder null = unbekannt. */
  pauseH: number | null;
  planH: number; istH: number; diffH: number;
  planCHF: number; istCHF: number; diffCHF: number;
  causes: DrilldownCauseCount[];
  flags: DrilldownShiftFlag[];
  tone: ComparisonTone;
  /** Wichtigste Ursache bzw. Auffälligkeit als Text ("Im Plan" wenn keine). */
  status: string;
}

/** Schichtzeilen (1 Zeile = 1 MA-Tag-Einsatz) der Detailstufe — Basis: Faktenzellen. */
export function buildDetailShiftRows(
  input: DrilldownInput,
  cells: DrilldownFactCell[],
  sel: Pick<DrilldownDetailSelection, 'group' | 'period' | 'key'>,
): DrilldownShiftRow[] {
  const t = DRILLDOWN_THRESHOLDS;
  const empById = new Map(input.employees.map(e => [e.id, e]));
  const filtered = filterCellsForSelection(input, cells, sel);

  return filtered.map(c => {
    const emp = empById.get(c.empId);
    const times = input.shiftTimes?.[`${c.empId}|${c.date}`];
    const planTimes = times ? fmtSlots(times.planSlots) : null;
    const istTimes = times ? fmtSlots(times.istSlots) : null;
    const diffH = round2(c.istH - c.planH);
    const diffCHF = round2(c.istCHF - c.planCHF);
    const causes = collectCauses([c], input, diffH);

    const flags: DrilldownShiftFlag[] = [];
    if (planTimes !== null && istTimes !== null && c.planH > 0 && c.istH > 0 && planTimes !== istTimes) {
      flags.push('zeiten_abweichend');
    }
    if (Math.abs(diffCHF) >= t.warnCHF && Math.abs(diffH) < t.shiftQuietHours) {
      flags.push('kosten_ohne_stunden');
    }
    if (Math.abs(diffH) >= t.hoursFlag && Math.abs(diffCHF) < t.warnCHF) {
      flags.push('stunden_ohne_kosten');
    }

    const status = causes.length > 0
      ? DRILLDOWN_CAUSE_LABEL[causes[0].cause]
      : flags.length > 0
        ? DRILLDOWN_SHIFT_FLAG_LABEL[flags[0]]
        : 'Im Plan';

    return {
      key: `${c.empId}|${c.date}`,
      date: c.date,
      dateLabel: dayLabel(c.date),
      empId: c.empId,
      empName: emp?.name ?? c.empId,
      position: emp ? positionKeyForEmployee(emp).label : '—',
      planTimes, istTimes,
      pauseH: times?.planBreakH ?? null,
      planH: round2(c.planH), istH: round2(c.istH), diffH,
      planCHF: round2(c.planCHF), istCHF: round2(c.istCHF), diffCHF,
      causes, flags,
      tone: toneForDrilldownRow(c.planCHF, diffCHF),
      status,
    };
  }).sort((a, b) =>
    a.date === b.date
      ? (a.empName === b.empName ? a.empId.localeCompare(b.empId) : a.empName.localeCompare(b.empName, 'de-CH'))
      : a.date.localeCompare(b.date));
}

export interface DrilldownDetailKpis {
  planH: number; istH: number; diffH: number;
  planCHF: number; istCHF: number; diffCHF: number;
  shiftCount: number;
  /** Schichten mit mindestens einer Ursache oder Auffälligkeit. */
  issueCount: number;
}

export function buildDetailKpis(rows: DrilldownShiftRow[]): DrilldownDetailKpis {
  let planH = 0, istH = 0, planCHF = 0, istCHF = 0, issueCount = 0;
  for (const r of rows) {
    planH += r.planH; istH += r.istH; planCHF += r.planCHF; istCHF += r.istCHF;
    if (r.causes.length > 0 || r.flags.length > 0) issueCount++;
  }
  return {
    planH: round2(planH), istH: round2(istH), diffH: round2(istH - planH),
    planCHF: round2(planCHF), istCHF: round2(istCHF), diffCHF: round2(istCHF - planCHF),
    shiftCount: rows.length, issueCount,
  };
}

/** Tageskontext — NUR aus bereits geladenen Daten (kein Wert wird erfunden). */
export interface DrilldownDetailContext {
  /** Umsatz der abgedeckten Tage oder null = kein Umsatz erfasst. */
  revenue: number | null;
  /** Anzahl MA mit Plan-Stunden bzw. Ist-Stunden in der Auswahl. */
  plannedStaff: number;
  actualStaff: number;
  dates: string[];
}

export function buildDetailContext(
  input: DrilldownInput,
  filteredCells: DrilldownFactCell[],
): DrilldownDetailContext {
  const dates = [...new Set(filteredCells.map(c => c.date))].sort();
  let rev = 0; let hasRev = false;
  for (const d of dates) {
    const r = input.dailyRevenue[d];
    if (r !== undefined && r > 0) { rev += r; hasRev = true; }
  }
  const planned = new Set<string>();
  const actual = new Set<string>();
  for (const c of filteredCells) {
    if (c.planH > 0) planned.add(c.empId);
    if (c.istH > 0) actual.add(c.empId);
  }
  return {
    revenue: hasRev ? round2(rev) : null,
    plannedStaff: planned.size,
    actualStaff: actual.size,
    dates,
  };
}

/** Abstimmung Detail-Summen ↔ angeklickte Übersichtszeile (kleine Toleranz, nie stumm). */
export interface DrilldownDetailReconciliation {
  sumPlanH: number; sumIstH: number; sumDiffCHF: number;
  parentPlanH: number; parentIstH: number; parentDiffCHF: number;
  diffH: number; diffCHF: number;
  ok: boolean;
}

export function reconcileDetail(
  rows: DrilldownShiftRow[],
  parent: Pick<DrilldownRow, 'planH' | 'istH' | 'diffCHF'>,
): DrilldownDetailReconciliation {
  const t = DRILLDOWN_THRESHOLDS;
  let sumPlanH = 0, sumIstH = 0, sumDiffCHF = 0;
  for (const r of rows) { sumPlanH += r.planH; sumIstH += r.istH; sumDiffCHF += r.diffCHF; }
  sumPlanH = round2(sumPlanH); sumIstH = round2(sumIstH); sumDiffCHF = round2(sumDiffCHF);
  const diffH = round2(Math.max(Math.abs(sumPlanH - parent.planH), Math.abs(sumIstH - parent.istH)));
  const diffCHF = round2(sumDiffCHF - parent.diffCHF);
  return {
    sumPlanH, sumIstH, sumDiffCHF,
    parentPlanH: parent.planH, parentIstH: parent.istH, parentDiffCHF: parent.diffCHF,
    diffH, diffCHF,
    ok: diffH <= t.detailToleranceH && Math.abs(diffCHF) <= t.detailToleranceCHF,
  };
}

export type ShiftSortCol =
  | 'date' | 'empName' | 'position'
  | 'planH' | 'istH' | 'diffH' | 'planCHF' | 'istCHF' | 'diffCHF';

/** Stabile Sortierung (Tie-Break Datum + empId), null = Eingangs-Reihenfolge. */
export function sortShiftRows(
  rows: DrilldownShiftRow[],
  sort: { col: ShiftSortCol; dir: 1 | -1 } | null,
): DrilldownShiftRow[] {
  if (!sort) return rows;
  const tieBreak = (a: DrilldownShiftRow, b: DrilldownShiftRow) =>
    a.date === b.date ? a.empId.localeCompare(b.empId) : a.date.localeCompare(b.date);
  return [...rows].sort((a, b) => {
    let cmp: number;
    if (sort.col === 'date') cmp = a.date.localeCompare(b.date);
    else if (sort.col === 'empName') cmp = a.empName.localeCompare(b.empName, 'de-CH');
    else if (sort.col === 'position') cmp = a.position.localeCompare(b.position, 'de-CH');
    else cmp = a[sort.col] - b[sort.col];
    return sort.dir * cmp || tieBreak(a, b);
  });
}

/** CSV der Detailstufe — exportiert NUR die übergebenen (sichtbaren) Schichtzeilen. */
export function buildShiftCsv(rows: DrilldownShiftRow[]): string {
  const header = [
    'Datum', 'Mitarbeitender', 'Position',
    'Plan Start', 'Plan Ende', 'Plan h',
    'Ist Start', 'Ist Ende', 'Ist h',
    'Pause h', 'Diff h', 'Plan CHF', 'Ist CHF', 'Diff CHF', 'Ursache',
  ];
  const starts = (s: string | null) =>
    s === null ? '' : s.split(' · ').map(x => x.split('–')[0]).join(' / ');
  const ends = (s: string | null) =>
    s === null ? '' : s.split(' · ').map(x => x.split('–')[1] ?? '').join(' / ');
  const lines = [header.map(csvField).join(';')];
  for (const r of rows) {
    const causeText = [
      ...r.causes.map(c => DRILLDOWN_CAUSE_LABEL[c.cause]),
      ...r.flags.map(f => DRILLDOWN_SHIFT_FLAG_LABEL[f]),
    ].join(', ');
    lines.push([
      csvField(r.date), csvField(r.empName), csvField(r.position),
      csvField(starts(r.planTimes)), csvField(ends(r.planTimes)), csvField(r.planH),
      csvField(starts(r.istTimes)), csvField(ends(r.istTimes)), csvField(r.istH),
      csvField(r.pauseH), csvField(r.diffH),
      csvField(r.planCHF), csvField(r.istCHF), csvField(r.diffCHF),
      csvField(causeText || 'Im Plan'),
    ].join(';'));
  }
  return lines.join('\n');
}

/** Titel der Detailansicht: Tag → langer Wochentag, sonst Label der Zeile. */
export function detailTitleForSelection(sel: DrilldownDetailSelection): string {
  if (sel.group === 'day' && sel.period === 'day') return dayLabelLong(sel.key);
  return sel.label;
}

export function buildDrilldownCsv(rows: DrilldownRow[], groupHeader: string): string {
  const header = [
    groupHeader, 'Plan h', 'Ist h', 'Diff h', 'Plan CHF', 'Ist CHF', 'Diff CHF',
    'Umsatz CHF', 'Personalquote %', 'Ursachen', 'Erklärung',
  ];
  const lines = [header.map(csvField).join(';')];
  for (const r of rows) {
    lines.push([
      csvField(r.sublabel ? `${r.label} (${r.sublabel})` : r.label),
      csvField(r.planH), csvField(r.istH), csvField(r.diffH),
      csvField(r.planCHF), csvField(r.istCHF), csvField(r.diffCHF),
      csvField(r.revenue), csvField(r.pkqPct),
      csvField(r.causes.map(c => `${DRILLDOWN_CAUSE_LABEL[c.cause]} (${c.count})`).join(', ')),
      csvField(r.explanation),
    ].join(';'));
  }
  return lines.join('\n');
}
