/**
 * mirus-import-engine.ts
 * ======================
 * Reine Logik für den MIRUS-Ist-Stunden-Import im Modus
 * «MIRUS überschreibt mit Rückfragen» — mandantenfähig, ohne Seiteneffekte.
 *
 * Regeln (pro MIRUS-Mitarbeiter, pro Datei-Tag):
 *   - Dienstplan leer/frei ohne Marke + Datei > 0  → MIRUS-Stunden übernehmen (auto)
 *   - Dienstplan leer/frei              + Datei = 0 → bleibt frei (unverändert)
 *   - Dienstplan Stunden ohne Marke     + Datei > 0 → mit MIRUS überschreiben (auto)
 *   - Dienstplan Absenz-Marke           + Datei = 0 → Marke + evtl. Stunden bleiben (unverändert)
 *   - KONFLIKT A: Datei = 0, Dienstplan hat Stunden ohne Marke → Rückfrage
 *   - KONFLIKT B: Datei > 0, Dienstplan hat Absenz-Marke        → Rückfrage
 *
 * MANUELL-Mitarbeiter und Mitarbeiter, die nicht in der Datei stehen,
 * werden NIE angefasst — auch nicht im lokalen State.
 */

import type { ActualHourEntry } from '@/lib/supabase-db';

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

export type MirusCellDecision =
  | 'auto_take'        // Datei-Wert wird automatisch übernommen (neu oder überschreibt Stunden)
  | 'unchanged_free'   // Datei 0 + Dienstplan leer → bleibt frei
  | 'unchanged_equal'  // Werte identisch → nichts zu tun
  | 'unchanged_absence'// Datei 0 + Absenz-Marke → Marke bleibt vollständig
  | 'conflict_a'       // Datei 0 vs. Dienstplan-Stunden ohne Marke
  | 'conflict_b';      // Datei > 0 vs. Absenz-Marke

export interface MirusCellPlan {
  employeeId: string;
  employeeName: string;
  date: string;
  fileHours: number;
  /** Bestehender Dienstplan-Ist-Eintrag (null = leer) */
  before: ActualHourEntry | null;
  decision: MirusCellDecision;
  /** Nur bei Konflikten: gewählte Lösung ('mirus' | 'keep'), Default 'mirus'. */
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
  conflicts: MirusCellPlan[];
  autoChanges: MirusCellPlan[];
}

export interface MirusWriteOp {
  employeeId: string;
  date: string;
  /** null = Zelle löschen (kommt bei diesem Modus nicht vor, aber für Undo nützlich) */
  entry: ActualHourEntry | null;
}

// ─── Scope-Check ─────────────────────────────────────────────────────────────

/**
 * Prüft den Datei-Zeitraum: alle Tage müssen im selben Monat + Jahr liegen.
 * Monatsübergreifend → Abbruch mit Meldung.
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

function classifyCell(fileHours: number, before: ActualHourEntry | null): MirusCellDecision {
  const beforeHours = before?.hours ?? 0;
  const hasAbsence = !!before?.absenceType;
  if (fileHours > 0) {
    if (hasAbsence) return 'conflict_b';
    if (Math.abs(beforeHours - fileHours) < 0.005 && before) return 'unchanged_equal';
    return 'auto_take'; // leer ODER abweichende Stunden ohne Marke
  }
  // fileHours === 0
  if (hasAbsence) return 'unchanged_absence';
  if (before && beforeHours > 0) return 'conflict_a';
  if (before && beforeHours === 0) return 'unchanged_equal';
  return 'unchanged_free';
}

/**
 * Baut den vollständigen Abgleich-Plan. Schreibt NICHTS.
 *
 * @param entries        Datei-Einträge mit aufgelöster employeeId (inkl. 0-Werte für alle Datei-Tage!)
 * @param existing       Bestehender Ist-Zustand, Key = `${employeeId}-${date}`
 * @param erfassungsart  Map employeeId → 'MIRUS' | 'MANUELL' (bereits mit Default aufgelöst)
 * @param dates          Datei-Tage (aus checkMirusScope)
 */
export function buildMirusReconcilePlan(params: {
  entries: MirusResolvedEntry[];
  existing: Record<string, ActualHourEntry>;
  erfassungsart: Record<string, 'MIRUS' | 'MANUELL'>;
  month: string;
  dates: string[];
}): MirusReconcilePlan {
  const { entries, existing, erfassungsart, month, dates } = params;
  const dateSet = new Set(dates);

  // Datei-Werte je MA/Tag (fehlender Tag = 0)
  const byEmp = new Map<string, { name: string; days: Map<string, number> }>();
  for (const e of entries) {
    if (!dateSet.has(e.date)) continue;
    let rec = byEmp.get(e.employeeId);
    if (!rec) { rec = { name: e.employeeName, days: new Map() }; byEmp.set(e.employeeId, rec); }
    rec.days.set(e.date, r2((rec.days.get(e.date) ?? 0) + e.hours));
  }

  const employees: MirusEmployeePlan[] = [];
  const skippedManual: MirusReconcilePlan['skippedManual'] = [];
  const conflicts: MirusCellPlan[] = [];
  const autoChanges: MirusCellPlan[] = [];

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
      beforeTotal += before?.hours ?? 0;
      const decision = classifyCell(fileHours, before);
      const cell: MirusCellPlan = {
        employeeId: empId, employeeName: rec.name, date, fileHours, before, decision,
        ...(decision === 'conflict_a' || decision === 'conflict_b' ? { resolution: 'mirus' as const } : {}),
      };
      cells.push(cell);
      if (decision === 'auto_take') autoChanges.push(cell);
      if (decision === 'conflict_a' || decision === 'conflict_b') conflicts.push(cell);
    }
    employees.push({ employeeId: empId, employeeName: rec.name, fileTotal, beforeTotal: r2(beforeTotal), cells });
  }

  employees.sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'de'));
  return { month, dates, employees, skippedManual, conflicts, autoChanges };
}

// ─── Schreib-Operationen aus dem bestätigten Plan ────────────────────────────

/**
 * Ermittelt die tatsächlichen Schreib-Operationen NACH der Konflikt-Auflösung.
 * Nur Zellen mit effektiver Änderung werden zurückgegeben.
 */
export function resolvePlanToWrites(plan: MirusReconcilePlan): MirusWriteOp[] {
  const ops: MirusWriteOp[] = [];
  for (const emp of plan.employees) {
    for (const cell of emp.cells) {
      switch (cell.decision) {
        case 'auto_take':
          ops.push({ employeeId: cell.employeeId, date: cell.date, entry: { hours: cell.fileHours, source: 'mirus_import' } });
          break;
        case 'conflict_a': // Datei 0 vs. Stunden
          if (cell.resolution === 'mirus') {
            // 0 übernehmen = Zelle wird frei → Eintrag löschen
            ops.push({ employeeId: cell.employeeId, date: cell.date, entry: null });
          }
          break;
        case 'conflict_b': // Datei > 0 vs. Absenz
          if (cell.resolution === 'mirus') {
            // Stunden übernehmen und Marke entfernen
            ops.push({ employeeId: cell.employeeId, date: cell.date, entry: { hours: cell.fileHours, source: 'mirus_import' } });
          }
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
      switch (cell.decision) {
        case 'auto_take':          total += cell.fileHours; break;
        case 'unchanged_equal':    total += cell.before?.hours ?? 0; break;
        case 'unchanged_absence':  total += cell.before?.hours ?? 0; break;
        case 'conflict_a':         total += cell.resolution === 'mirus' ? 0 : (cell.before?.hours ?? 0); break;
        case 'conflict_b':         total += cell.resolution === 'mirus' ? cell.fileHours : (cell.before?.hours ?? 0); break;
        default: break;
      }
    }
    out[emp.employeeId] = r2(total);
  }
  return out;
}
