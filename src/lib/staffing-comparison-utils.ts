/**
 * staffing-comparison-utils — reine Logik des Personalbedarf-Abgleichs
 * (SOLL-Besetzung aus `staffing_requirements` vs. IST-Planung aus dem Dienstplan).
 * ──────────────────────────────────────────────────────────────────────────────
 * KEINE Supabase-/DOM-Abhängigkeiten (nur `import type` aus den Modellen +
 * reine Helfer aus position-utils / staffing-requirements-utils). Damit im
 * Node-Env testbar.
 *
 * NUR Analyse/Anzeige — verändert WEDER Dienstplan NOCH Personalbedarf und
 * erzeugt KEINE Vorschläge/Budget-Prüfung.
 *
 * ── Ampel-Logik (binär, vom Betrieb bestätigt) ───────────────────────────────
 *   diff = geplant − benötigt
 *   🟢 grün  = exakt erfüllt   (diff === 0)
 *   🔴 rot   = jede Abweichung (diff !== 0 → bereits bei ±1 Person)
 * Die genaue Differenz wird zusätzlich angezeigt
 * (z.B. „+1 Person zu viel", „−1 Person zu wenig").
 *
 * ── Zählregel „geplant" (bewusst, dokumentiert) ───────────────────────────────
 * Der Dienstplan speichert KEINE Position je Schicht. Daher zählt für eine
 * Bedarfs-Schicht ein AKTIVER Mitarbeiter genau dann, wenn
 *   1) seine HAUPTPOSITION (`primaryStation`, auf Slug aufgelöst) === positionKey
 *      der Schicht  (nur Hauptposition → kein Doppelzählen über Zusatz-
 *      qualifikationen), UND
 *   2) er an dem Tag mindestens eine PRODUKTIVE (nicht-Abwesenheits-) Schicht
 *      hat, die sich mit dem Zeitraum der Bedarfs-Schicht ÜBERSCHNEIDET.
 * Jeder Mitarbeiter wird je Bedarfs-Schicht höchstens einmal gezählt.
 */

import type { Department, Employee, DaySchedule } from '@/types/personnel';
import type { Position } from '@/types/positions';
import type { PositionArea } from '@/lib/position-utils';
import {
  DEPARTMENTS,
  groupPositionsByArea,
  activePositions,
  resolvePositionKey,
  positionDisplayName,
} from '@/lib/position-utils';
import type { StaffingRequirement, StaffingSeason } from '@/types/staffing';
import { shiftsForScope, timeToMinutes } from '@/lib/staffing-requirements-utils';

export type ComparisonStatus = 'green' | 'red';

/** Produktive (nicht-Abwesenheits-) Arbeitszeit eines Mitarbeiters an einem Tag. */
export interface PlannedSlot {
  start: string;
  end: string;
}

/** Minimal-Sicht eines eingeplanten Mitarbeiters für den Abgleich (reine Eingabe). */
export interface PlannedEmployeeDay {
  id: string;
  /** Hauptposition als Slug (bereits via resolvePositionKey aufgelöst) oder null. */
  positionKey: string | null;
  /** Produktive Slots des Tages (Abwesenheiten bereits ausgeschlossen). */
  slots: PlannedSlot[];
}

/** Eine Bedarfs-Schicht mit Abgleichsergebnis. */
export interface ShiftComparisonRow {
  requirementId?: string;
  positionKey: string;
  shiftStart: string;
  shiftEnd: string;
  required: number;
  planned: number;
  /** geplant − benötigt. */
  diff: number;
  status: ComparisonStatus;
}

export interface PositionComparison {
  position: Position;
  shifts: ShiftComparisonRow[];
}

export interface AreaComparisonGroup {
  /** null = Sammelgruppe „Ohne Bereich". */
  area: PositionArea | null;
  positions: PositionComparison[];
}

export interface DepartmentComparisonGroup {
  department: Department;
  areas: AreaComparisonGroup[];
}

/** Bedarf für eine nicht (mehr) aktive / unbekannte Position (Slug). */
export interface OrphanPositionComparison {
  positionKey: string;
  positionName: string;
  shifts: ShiftComparisonRow[];
}

export interface StaffingComparisonResult {
  /** Gibt es für (Saison × Wochentag) überhaupt Bedarfs-Schichten? */
  hasRequirements: boolean;
  /** Aktive Positionen mit Bedarf, hierarchisch Abteilung → Bereich → Position. */
  groups: DepartmentComparisonGroup[];
  /** Bedarf für inaktive/unbekannte Positions-Slugs (kein stilles Verwerfen). */
  orphanPositions: OrphanPositionComparison[];
  /** Alle gerenderten Zeilen (für Summen/Zählung). */
  rows: ShiftComparisonRow[];
  totals: { required: number; planned: number; diff: number };
  counts: { green: number; red: number };
}

/** Ampel-Status aus benötigt/geplant (binär: grün nur bei exakter Erfüllung). */
export function comparisonStatus(required: number, planned: number): ComparisonStatus {
  return planned === required ? 'green' : 'red';
}

/**
 * Genaue Differenz als Text: 0 → „±0", sonst mit Vorzeichen, Plural und
 * Richtung — „+1 Person zu viel" / „−2 Personen zu wenig".
 */
export function formatStaffingDiff(diff: number): string {
  if (diff === 0) return '±0';
  const n = Math.abs(diff);
  const unit = n === 1 ? 'Person' : 'Personen';
  const sign = diff > 0 ? '+' : '−';
  const direction = diff > 0 ? 'zu viel' : 'zu wenig';
  return `${sign}${n} ${unit} ${direction}`;
}

/** Überschneidet sich ein produktiver Slot mit dem Zeitraum einer Bedarfs-Schicht? */
export function slotOverlapsShift(
  slot: PlannedSlot,
  shiftStart: string,
  shiftEnd: string,
): boolean {
  const aS = timeToMinutes(slot.start);
  const aE = timeToMinutes(slot.end);
  const bS = timeToMinutes(shiftStart);
  const bE = timeToMinutes(shiftEnd);
  if ([aS, aE, bS, bE].some((v) => Number.isNaN(v))) return false;
  if (aE <= aS || bE <= bS) return false; // keine Übernacht-/Null-Slots
  return Math.max(aS, bS) < Math.min(aE, bE);
}

/** Anzahl eingeplanter Mitarbeitender für eine Position + Zeitraum (siehe Zählregel). */
export function countPlanned(
  planned: PlannedEmployeeDay[],
  positionKey: string,
  shiftStart: string,
  shiftEnd: string,
): number {
  return planned.filter(
    (e) =>
      e.positionKey === positionKey &&
      e.slots.some((s) => slotOverlapsShift(s, shiftStart, shiftEnd)),
  ).length;
}

/**
 * Baut die `PlannedEmployeeDay[]`-Eingabe aus realen Mitarbeitern + Dienstplan
 * für ein Datum. Reine Funktion (nur `import type` + pure Helfer):
 *   - überspringt archivierte Mitarbeiter (`isActive === false`),
 *   - überspringt Mitarbeiter ohne Eintrag/ohne produktive Schicht an dem Tag,
 *   - schließt Abwesenheiten aus (frühAbsence/spätAbsence gesetzt),
 *   - löst die Hauptposition tolerant auf einen Slug auf (resolvePositionKey).
 */
export function buildPlannedEmployees(
  employees: Employee[],
  scheduleData: Record<string, DaySchedule>,
  positions: Position[],
  dateStr: string,
): PlannedEmployeeDay[] {
  const out: PlannedEmployeeDay[] = [];
  for (const emp of employees) {
    if (emp.isActive === false) continue;
    const ds = scheduleData[`${emp.id}-${dateStr}`];
    if (!ds) continue;
    const slots: PlannedSlot[] = [];
    if (ds.früh && !ds.frühAbsence && ds.früh.start && ds.früh.end) {
      slots.push({ start: ds.früh.start, end: ds.früh.end });
    }
    if (ds.spät && !ds.spätAbsence && ds.spät.start && ds.spät.end) {
      slots.push({ start: ds.spät.start, end: ds.spät.end });
    }
    if (slots.length === 0) continue;
    out.push({
      id: emp.id,
      positionKey: resolvePositionKey(positions, emp.primaryStation) ?? null,
      slots,
    });
  }
  return out;
}

/**
 * Vergleicht die SOLL-Besetzung (Bedarfs-Schichten eines Saison-Wochentags) mit
 * den eingeplanten Mitarbeitenden. Iteriert über die Bedarfs-Schichten (nicht
 * über alle Positionen) → es erscheinen nur Positionen MIT Bedarf in diesem
 * Geltungsbereich.
 *
 * `departments` (optional) beschränkt die Anzeige auf bestimmte Abteilungen
 * (Rollen-Scoping, z.B. Küchen-Manager). Ohne Angabe werden alle Abteilungen
 * gezeigt; Orphan-Bedarfe werden nur ohne Abteilungsfilter ausgewiesen.
 */
export function computeStaffingComparison(args: {
  positions: Position[];
  requirements: StaffingRequirement[];
  plannedEmployees: PlannedEmployeeDay[];
  season: StaffingSeason;
  weekday: number;
  departments?: Department[];
}): StaffingComparisonResult {
  const { positions, requirements, plannedEmployees, season, weekday } = args;
  const deptFilter =
    args.departments && args.departments.length ? args.departments : undefined;

  const scopeShifts = shiftsForScope(requirements, season, weekday);

  const byKey = new Map<string, StaffingRequirement[]>();
  for (const s of scopeShifts) {
    const arr = byKey.get(s.positionKey);
    if (arr) arr.push(s);
    else byKey.set(s.positionKey, [s]);
  }

  const rows: ShiftComparisonRow[] = [];
  const toRow = (req: StaffingRequirement): ShiftComparisonRow => {
    const planned = countPlanned(
      plannedEmployees,
      req.positionKey,
      req.shiftStart,
      req.shiftEnd,
    );
    const diff = planned - req.requiredCount;
    return {
      requirementId: req.id,
      positionKey: req.positionKey,
      shiftStart: req.shiftStart,
      shiftEnd: req.shiftEnd,
      required: req.requiredCount,
      planned,
      diff,
      status: comparisonStatus(req.requiredCount, planned),
    };
  };

  const activeKeySet = new Set(activePositions(positions).map((p) => p.key));
  const departmentsToRender = deptFilter
    ? DEPARTMENTS.filter((d) => deptFilter.includes(d))
    : DEPARTMENTS;

  const groups: DepartmentComparisonGroup[] = [];
  for (const dept of departmentsToRender) {
    const areaGroups = groupPositionsByArea(positions, dept, { includeInactive: false });
    const areas: AreaComparisonGroup[] = [];
    for (const ag of areaGroups) {
      const positionsWithShifts: PositionComparison[] = [];
      for (const p of ag.positions) {
        const shifts = byKey.get(p.key);
        if (!shifts || shifts.length === 0) continue;
        const shiftRows = shifts.map(toRow);
        rows.push(...shiftRows);
        positionsWithShifts.push({ position: p, shifts: shiftRows });
      }
      if (positionsWithShifts.length) areas.push({ area: ag.area, positions: positionsWithShifts });
    }
    if (areas.length) groups.push({ department: dept, areas });
  }

  // Orphan-Bedarfe = Slugs ohne aktive Position. Nur ohne Abteilungsfilter
  // ausweisen (gescopte Rollen sehen keine fremden/inaktiven Positionen).
  const orphanPositions: OrphanPositionComparison[] = [];
  if (!deptFilter) {
    for (const [key, shifts] of byKey) {
      if (activeKeySet.has(key)) continue;
      const shiftRows = shifts.map(toRow);
      rows.push(...shiftRows);
      orphanPositions.push({
        positionKey: key,
        positionName: positionDisplayName(positions, key) || key,
        shifts: shiftRows,
      });
    }
  }

  const totals = rows.reduce(
    (t, r) => ({
      required: t.required + r.required,
      planned: t.planned + r.planned,
      diff: t.diff + r.diff,
    }),
    { required: 0, planned: 0, diff: 0 },
  );
  const counts = rows.reduce(
    (c, r) => {
      c[r.status] += 1;
      return c;
    },
    { green: 0, red: 0 },
  );

  return {
    hasRequirements: scopeShifts.length > 0,
    groups,
    orphanPositions,
    rows,
    totals,
    counts,
  };
}
