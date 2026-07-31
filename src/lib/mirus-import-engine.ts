/**
 * mirus-import-engine.ts
 * ======================
 * Reine Logik für den MIRUS-Ist-Stunden-Import im Modus
 * «MIRUS überschreibt mit Rückfragen» — mandantenfähig, ohne Seiteneffekte.
 *
 * Drei-Weg-Vergleich pro Mitarbeiter/Tag: MIRUS-Datei / Dienstplan-PLAN /
 * gespeicherte Ist. Alle Fälle werden nach GRUND/MUSTER klassiert (Spec):
 *
 *   - Rundung: |MIRUS − alte Ist| ≤ Schwelle (Default 0.05 h) → STILL übernehmen
 *     (erscheint weder in Gruppen noch als Konflikt; exakt gleich = kein Write).
 *   - Muster 1 `auto_take`:      MIRUS hat Stunden, kein Gegenteil (Ist leer,
 *                                keine Absenz) → Sammelgruppe «wird übernommen».
 *   - Muster 2 `conflict_zero`:  MIRUS = 0, aber Ist ODER Plan hat Stunden → Rückfrage.
 *   - Muster 3 `absence_keep`:   Absenz (FE/K/U), MIRUS = 0 → Code behalten, bestätigen.
 *   - Muster 4 `conflict_absence`: Absenz, MIRUS = Stunden → Rückfrage.
 *   - Muster 5 `conflict_diff`:  beide Stunden, Abweichung > Schwelle → Rückfrage mit Differenz.
 *
 * MANUELL-Mitarbeiter und Mitarbeiter, die nicht in der Datei stehen,
 * werden NIE angefasst — auch nicht im lokalen State.
 */

import type { ActualHourEntry } from '@/lib/supabase-db';

// Kanonische Absenz-Familien — bewusst LOKAL kopiert (statt Import aus
// absence-utils), damit die Engine keine Supabase-/Hook-Kette in Node-Tests
// zieht. Muss mit VACATION_/SICK_/ACCIDENT_CODES in absence-utils.ts synchron bleiben.
const VACATION_CODES = new Set(['FE', 'FW', 'Ferien', 'Urlaub']);
const SICK_CODES     = new Set(['K', 'KO', 'Krank', 'Krankheit', 'AUF']);
const ACCIDENT_CODES = new Set(['U', 'Unfall', 'UNF', 'UNFALL']);

// ─── Typen ───────────────────────────────────────────────────────────────────

export interface MirusScopeResult {
  ok: boolean;
  error?: string;
  /** 'YYYY-MM' des Datei-Zeitraums (nur bei ok) */
  month?: string;
  /** Sortierte ISO-Datumsliste der Datei-Tage (nur bei ok) */
  dates?: string[];
}

/** Datei-Eintrag mit bereits aufgelöstem Mitarbeiter. */
export interface MirusResolvedEntry {
  employeeId: string;
  employeeName: string;
  date: string;   // ISO
  hours: number;  // auf 2 Stellen gerundet
}

/** Dienstplan-PLAN eines Tages (dritte Vergleichsgrösse). */
export interface MirusPlanInfo {
  /** Geplante Netto-Stunden (calculateDayNetHours). */
  hours: number;
  /** Kanonischer Absenzcode FE | K | U (andere Plan-Codes zählen nicht). */
  absence: 'FE' | 'K' | 'U' | null;
}

export type MirusCellDecision =
  | 'auto_take'        // Muster 1: MIRUS-Stunden, kein Gegenteil → Sammelgruppe «wird übernommen»
  | 'silent_round'     // Rundungsdifferenz ≤ Schwelle → still übernehmen (unsichtbar, wird geschrieben)
  | 'unchanged_free'   // Datei 0 + überall leer → bleibt frei
  | 'unchanged_equal'  // Werte praktisch identisch (< 0.005) → nichts zu tun
  | 'conflict_zero'    // Muster 2: MIRUS 0 vs. Stunden (Ist oder Plan)
  | 'absence_keep'     // Muster 3: Absenz + MIRUS 0 → Code behalten (bestätigen)
  | 'conflict_absence' // Muster 4: Absenz vs. MIRUS-Stunden
  | 'conflict_diff';   // Muster 5: Stunden vs. Stunden, Differenz > Schwelle

/** Muster-Nummer (1–5) je Entscheidung; null = kein sichtbarer Fall. */
export function patternOf(decision: MirusCellDecision): 1 | 2 | 3 | 4 | 5 | null {
  switch (decision) {
    case 'auto_take':        return 1;
    case 'conflict_zero':    return 2;
    case 'absence_keep':     return 3;
    case 'conflict_absence': return 4;
    case 'conflict_diff':    return 5;
    default:                 return null;
  }
}

export interface MirusCellPlan {
  employeeId: string;
  employeeName: string;
  date: string;
  fileHours: number;
  /** Bestehender gespeicherter Ist-Eintrag (null = leer). */
  before: ActualHourEntry | null;
  /** Dienstplan-PLAN des Tages (dritte Vergleichsgrösse, Anzeige). */
  plan: MirusPlanInfo;
  decision: MirusCellDecision;
  /**
   * Entscheid je Muster-Zelle: 'mirus' = MIRUS-Wert übernehmen,
   * 'keep' = Bestehendes behalten (bei Muster 3 = Absenzcode bestätigen).
   * Defaults: Muster 1/2/4/5 → 'mirus', Muster 3 → 'keep'.
   */
  resolution?: 'mirus' | 'keep';
}

export interface MirusEmployeePlan {
  employeeId: string;
  employeeName: string;
  fileTotal: number;
  beforeTotal: number;
  cells: MirusCellPlan[];
}

export interface MirusReconcilePlan {
  month: string;
  dates: string[];
  employees: MirusEmployeePlan[];
  /** Datei-MA, die MANUELL klassiert sind → werden NICHT geschrieben. */
  skippedManual: Array<{ employeeId: string; employeeName: string; fileTotal: number }>;
  /** Zeilen ausserhalb des Monats («ausserhalb Zeitraum, übersprungen»). */
  skippedOutOfScope: Array<{ employeeName: string; date: string; hours: number }>;
  /** Stille Rundungs-Übernahmen (werden geschrieben, aber nicht angezeigt). */
  silentRounds: MirusCellPlan[];
  /** Verwendete Rundungsschwelle in Stunden. */
  roundingThreshold: number;
}

/** Zellen nach Muster 1–5 gruppiert (Vorschau-Gruppen). */
export function groupPlanCells(plan: MirusReconcilePlan): Record<1 | 2 | 3 | 4 | 5, MirusCellPlan[]> {
  const groups: Record<1 | 2 | 3 | 4 | 5, MirusCellPlan[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const emp of plan.employees) {
    for (const cell of emp.cells) {
      const p = patternOf(cell.decision);
      if (p) groups[p].push(cell);
    }
  }
  return groups;
}

export interface MirusWriteOp {
  employeeId: string;
  date: string;
  /** null = Zelle löschen/leeren. */
  entry: ActualHourEntry | null;
}

// ─── Scope-Check ─────────────────────────────────────────────────────────────

/**
 * Prüft den Datei-Zeitraum: alle Tage müssen im selben Monat + Jahr liegen.
 * Monatsübergreifend → Abbruch mit Meldung. (Zeilen ausserhalb des GEWÄHLTEN
 * Monats werden separat im Plan-Aufbau übersprungen und gelistet.)
 */
export function checkMirusScope(dates: string[]): MirusScopeResult {
  const valid = [...new Set(dates)].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (valid.length === 0) {
    return { ok: false, error: 'Kein Datumsbereich in der Datei erkannt («von DD.MM.YYYY bis DD.MM.YYYY» erwartet).' };
  }
  const months = new Set(valid.map(d => d.slice(0, 7)));
  if (months.size > 1) {
    return {
      ok: false,
      error: `Datei ist monatsübergreifend (${[...months].sort().join(', ')}). Bitte pro Monat exportieren — es wurde nichts geschrieben.`,
    };
  }
  return { ok: true, month: valid[0].slice(0, 7), dates: valid };
}

// ─── Plan-Aufbau ─────────────────────────────────────────────────────────────

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Default-Rundungsschwelle: 0.05 h = 3 Minuten (Spec, konfigurierbar). */
export const MIRUS_ROUNDING_THRESHOLD_H = 0.05;

/** Plan-Absenzcode (frühAbsence/spätAbsence) auf kanonisch FE/K/U abbilden. */
export function canonicalAbsence(code: string | null | undefined): 'FE' | 'K' | 'U' | null {
  if (!code) return null;
  if (VACATION_CODES.has(code)) return 'FE';
  if (SICK_CODES.has(code))     return 'K';
  if (ACCIDENT_CODES.has(code)) return 'U';
  return null; // 'F' (frei) u.ä. sind KEINE Absenz im Sinne des Imports
}

function classifyCell(
  fileHours: number,
  before: ActualHourEntry | null,
  plan: MirusPlanInfo,
  threshold: number,
): MirusCellDecision {
  const beforeHours = before?.hours ?? 0;
  // Absenz-Marke: gespeicherte Ist-Marke ODER (Ist leer + Plan-Absenz FE/K/U).
  const hasAbsence = !!before?.absenceType || (!before && plan.absence != null);

  if (fileHours > 0) {
    if (hasAbsence) return 'conflict_absence';                       // Muster 4
    if (before && beforeHours > 0) {
      const d = Math.abs(beforeHours - fileHours);
      if (d < 0.005) return 'unchanged_equal';
      if (d <= threshold) return 'silent_round';                     // Rundung: still übernehmen
      return 'conflict_diff';                                        // Muster 5
    }
    return 'auto_take';                                              // Muster 1
  }

  // fileHours === 0
  if (hasAbsence) return 'absence_keep';                             // Muster 3
  if (before && beforeHours > 0) return 'conflict_zero';             // Muster 2 (Ist hat Stunden)
  if (!before && plan.hours > 0) return 'conflict_zero';             // Muster 2 (Plan hat Stunden)
  if (before) return 'unchanged_equal';
  return 'unchanged_free';
}

function defaultResolution(decision: MirusCellDecision): 'mirus' | 'keep' | undefined {
  switch (decision) {
    case 'auto_take':
    case 'conflict_zero':
    case 'conflict_absence':
    case 'conflict_diff':
      return 'mirus';
    case 'absence_keep':
      return 'keep';
    default:
      return undefined;
  }
}

/**
 * Baut den vollständigen Abgleich-Plan. Schreibt NICHTS.
 *
 * @param entries        Datei-Einträge mit aufgelöster employeeId (inkl. 0-Werte für alle Datei-Tage!)
 * @param existing       Bestehender Ist-Zustand, Key = `${employeeId}-${date}`
 * @param planned        Dienstplan-PLAN, Key = `${employeeId}-${date}` (fehlend = kein Plan)
 * @param erfassungsart  Map employeeId → 'MIRUS' | 'MANUELL' (bereits mit Default aufgelöst)
 * @param dates          Datei-Tage des Ziel-Monats (aus checkMirusScope)
 */
export function buildMirusReconcilePlan(params: {
  entries: MirusResolvedEntry[];
  existing: Record<string, ActualHourEntry>;
  planned?: Record<string, MirusPlanInfo>;
  erfassungsart: Record<string, 'MIRUS' | 'MANUELL'>;
  month: string;
  dates: string[];
  roundingThreshold?: number;
}): MirusReconcilePlan {
  const { entries, existing, erfassungsart, month, dates } = params;
  const planned = params.planned ?? {};
  const threshold = params.roundingThreshold ?? MIRUS_ROUNDING_THRESHOLD_H;
  const dateSet = new Set(dates);
  const NO_PLAN: MirusPlanInfo = { hours: 0, absence: null };

  // Datei-Werte je MA/Tag (fehlender Tag = 0); Zeilen ausserhalb → Log-Liste.
  const byEmp = new Map<string, { name: string; days: Map<string, number> }>();
  const skippedOutOfScope: MirusReconcilePlan['skippedOutOfScope'] = [];
  for (const e of entries) {
    if (!dateSet.has(e.date)) {
      skippedOutOfScope.push({ employeeName: e.employeeName, date: e.date, hours: e.hours });
      continue;
    }
    let rec = byEmp.get(e.employeeId);
    if (!rec) { rec = { name: e.employeeName, days: new Map() }; byEmp.set(e.employeeId, rec); }
    rec.days.set(e.date, r2((rec.days.get(e.date) ?? 0) + e.hours));
  }

  const employees: MirusEmployeePlan[] = [];
  const skippedManual: MirusReconcilePlan['skippedManual'] = [];
  const silentRounds: MirusCellPlan[] = [];

  for (const [empId, rec] of byEmp) {
    const fileTotal = r2([...rec.days.values()].reduce((a, b) => a + b, 0));
    if ((erfassungsart[empId] ?? 'MANUELL') === 'MANUELL') {
      skippedManual.push({ employeeId: empId, employeeName: rec.name, fileTotal });
      continue;
    }
    const cells: MirusCellPlan[] = [];
    let beforeTotal = 0;
    for (const date of dates) {
      const fileHours = rec.days.get(date) ?? 0;
      const before = existing[`${empId}-${date}`] ?? null;
      const plan = planned[`${empId}-${date}`] ?? NO_PLAN;
      beforeTotal += before?.hours ?? 0;
      const decision = classifyCell(fileHours, before, plan, threshold);
      const resolution = defaultResolution(decision);
      const cell: MirusCellPlan = {
        employeeId: empId, employeeName: rec.name, date, fileHours, before, plan, decision,
        ...(resolution ? { resolution } : {}),
      };
      cells.push(cell);
      if (decision === 'silent_round') silentRounds.push(cell);
    }
    employees.push({ employeeId: empId, employeeName: rec.name, fileTotal, beforeTotal: r2(beforeTotal), cells });
  }

  employees.sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'de'));
  return { month, dates, employees, skippedManual, skippedOutOfScope, silentRounds, roundingThreshold: threshold };
}

// ─── Schreib-Operationen aus dem bestätigten Plan ────────────────────────────

/**
 * Ermittelt die tatsächlichen Schreib-Operationen NACH der Muster-Auflösung.
 * Nur Zellen mit effektiver Änderung werden zurückgegeben.
 */
export function resolvePlanToWrites(plan: MirusReconcilePlan): MirusWriteOp[] {
  const ops: MirusWriteOp[] = [];
  for (const emp of plan.employees) {
    for (const cell of emp.cells) {
      const take = cell.resolution === 'mirus';
      switch (cell.decision) {
        case 'silent_round': // Rundung: immer still übernehmen
          ops.push({ employeeId: cell.employeeId, date: cell.date, entry: { hours: cell.fileHours, source: 'mirus_import' } });
          break;
        case 'auto_take': // Muster 1 (Gruppe kann abgelehnt werden → keep = nichts)
          if (take) ops.push({ employeeId: cell.employeeId, date: cell.date, entry: { hours: cell.fileHours, source: 'mirus_import' } });
          break;
        case 'conflict_zero': // Muster 2: MIRUS 0 übernehmen = Zelle leeren
          if (take && cell.before) ops.push({ employeeId: cell.employeeId, date: cell.date, entry: null });
          break;
        case 'absence_keep': // Muster 3: bestätigt = Code bleibt, Ist-Stunden 0
          if (take) {
            // «MIRUS übernehmen» = 0 ohne Code → Zelle leeren (falls vorhanden)
            if (cell.before) ops.push({ employeeId: cell.employeeId, date: cell.date, entry: null });
          } else if (!cell.before && cell.plan.absence) {
            // Bestätigte PLAN-Absenz ohne Ist-Eintrag → Code materialisieren, Stunden 0
            ops.push({ employeeId: cell.employeeId, date: cell.date, entry: { hours: 0, absenceType: cell.plan.absence, source: 'mirus_import' } });
          }
          // bestehende Ist-Absenz bleibt vollständig unangetastet
          break;
        case 'conflict_absence': // Muster 4: MIRUS-Stunden übernehmen entfernt die Marke
          if (take) ops.push({ employeeId: cell.employeeId, date: cell.date, entry: { hours: cell.fileHours, source: 'mirus_import' } });
          break;
        case 'conflict_diff': // Muster 5
          if (take) ops.push({ employeeId: cell.employeeId, date: cell.date, entry: { hours: cell.fileHours, source: 'mirus_import' } });
          break;
        default:
          break; // unchanged_*
      }
    }
  }
  return ops;
}

/**
 * Erwartetes gespeichertes Total je MA nach Anwendung des Plans —
 * für die Gegenprüfung «gespeichert = Datei (± Tagesrundung)».
 */
export function expectedAfterTotals(plan: MirusReconcilePlan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const emp of plan.employees) {
    let total = 0;
    for (const cell of emp.cells) {
      const take = cell.resolution === 'mirus';
      switch (cell.decision) {
        case 'silent_round':     total += cell.fileHours; break;
        case 'auto_take':        total += take ? cell.fileHours : (cell.before?.hours ?? 0); break;
        case 'unchanged_equal':  total += cell.before?.hours ?? 0; break;
        case 'absence_keep':     total += take ? 0 : (cell.before?.hours ?? 0); break;
        case 'conflict_zero':    total += take ? 0 : (cell.before?.hours ?? 0); break;
        case 'conflict_absence': total += take ? cell.fileHours : (cell.before?.hours ?? 0); break;
        case 'conflict_diff':    total += take ? cell.fileHours : (cell.before?.hours ?? 0); break;
        default: break;
      }
    }
    out[emp.employeeId] = r2(total);
  }
  return out;
}
