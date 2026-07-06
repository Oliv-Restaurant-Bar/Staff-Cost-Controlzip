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
 * ── Warnlogik (2 Farben, ab ±1 Person) ───────────────────────────────────────
 *   diff = geplant − benötigt
 *   🟢 grün (optimal)      = exakt erfüllt    (diff === 0)
 *   🔴 rot  (überbesetzt)  = zu viel geplant  (diff > 0 → bereits ab +1 Person)
 *   🔴 rot  (unterbesetzt) = zu wenig geplant (diff < 0 → bereits ab −1 Person)
 * Jede Abweichung ist rot — es gibt KEINE Gelb-/Toleranzstufe mehr. Die
 * Richtung (über-/unterbesetzt) wird über Status-Label + Differenztext
 * unterschieden (z.B. „Überbesetzt · +1 Person").
 * Hinweis: Tage mit `isAdditionalCostPlan` zählen als geplant (es sind
 * eingeplante Personen); Abwesenheiten zählen NICHT.
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

/**
 * Semantischer Status einer Bedarfs-Schicht (2-Farben-Warnlogik):
 *   optimal      → grün  (diff === 0)
 *   overstaffed  → rot   (diff > 0, „Überbesetzt")
 *   understaffed → rot   (diff < 0, „Unterbesetzt")
 */
export type ComparisonStatus = 'optimal' | 'overstaffed' | 'understaffed';

/** Farb-Ebene der Warnlogik: nur exakt (grün) vs. jede Abweichung (rot). */
export type StatusColor = 'green' | 'red';

/** Produktive (nicht-Abwesenheits-) Arbeitszeit eines Mitarbeiters an einem Tag. */
export interface PlannedSlot {
  start: string;
  end: string;
}

/** Minimal-Sicht eines eingeplanten Mitarbeiters für den Abgleich (reine Eingabe). */
export interface PlannedEmployeeDay {
  id: string;
  /** Abteilung des Mitarbeiters (für die Tages-/Abteilungs-Zusammenfassung). */
  department: Department;
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
  counts: { optimal: number; overstaffed: number; understaffed: number };
}

/**
 * Warn-Status aus benötigt/geplant (2 Farben, ab ±1 Person):
 * zu viel → overstaffed (rot), zu wenig → understaffed (rot), exakt → optimal (grün).
 */
export function comparisonStatus(required: number, planned: number): ComparisonStatus {
  if (planned > required) return 'overstaffed';
  if (planned < required) return 'understaffed';
  return 'optimal';
}

/** Farbe eines Status: nur „optimal" ist grün, jede Abweichung ist rot. */
export function statusColor(status: ComparisonStatus): StatusColor {
  return status === 'optimal' ? 'green' : 'red';
}

/** Anzeigebezeichnung des Status (Badge-Text). */
export const STATUS_LABEL: Record<ComparisonStatus, string> = {
  optimal: 'Optimal',
  overstaffed: 'Überbesetzt',
  understaffed: 'Unterbesetzt',
};

/** Anzeigebezeichnung des Status (Badge-/Tooltip-Text). */
export function statusLabel(status: ComparisonStatus): string {
  return STATUS_LABEL[status];
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

/**
 * Differenz als reine Personenangabe (ohne Richtungstext): 0 → „±0",
 * sonst „+1 Person" / „+2 Personen" / „−3 Personen" (U+2212 als Minus).
 * Ergänzt das Status-Label (Überbesetzt/Unterbesetzt), das die Richtung nennt.
 */
export function formatStaffingDiffPersons(diff: number): string {
  if (diff === 0) return '±0';
  const n = Math.abs(diff);
  const unit = n === 1 ? 'Person' : 'Personen';
  const sign = diff > 0 ? '+' : '−';
  return `${sign}${n} ${unit}`;
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

/** IDs der eingeplanten Mitarbeitenden, die eine Bedarfs-Schicht matchen (siehe Zählregel). */
export function plannedIdsForShift(
  planned: PlannedEmployeeDay[],
  positionKey: string,
  shiftStart: string,
  shiftEnd: string,
): string[] {
  return planned
    .filter(
      (e) =>
        e.positionKey === positionKey &&
        e.slots.some((s) => slotOverlapsShift(s, shiftStart, shiftEnd)),
    )
    .map((e) => e.id);
}

/** Anzahl eingeplanter Mitarbeitender für eine Position + Zeitraum (siehe Zählregel). */
export function countPlanned(
  planned: PlannedEmployeeDay[],
  positionKey: string,
  shiftStart: string,
  shiftEnd: string,
): number {
  return plannedIdsForShift(planned, positionKey, shiftStart, shiftEnd).length;
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
      department: emp.department,
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
    { optimal: 0, overstaffed: 0, understaffed: 0 },
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

// ─── Tages-/Abteilungs-Zusammenfassung (kompakte Badges im Dienstplan) ────────

/** Kompakte Kurzform der Differenz für Badges: „+1" / „−2" / „±0" (U+2212). */
export function formatShortStaffingDiff(diff: number): string {
  if (diff === 0) return '±0';
  return diff > 0 ? `+${diff}` : `−${Math.abs(diff)}`;
}

/** Soll/Ist/Diff einer Abteilung an einem Tag (aggregiert über deren Bedarfs-Schichten). */
export interface DepartmentDaySummary {
  department: Department;
  /** Σ benötigte Personen über alle Bedarfs-Schichten der Abteilung (Personen-Schichten). */
  required: number;
  /** Σ gematchte eingeplante Personen über dieselben Schichten (gleiche Einheit wie `required`). */
  planned: number;
  /** planned − required. */
  diff: number;
  status: ComparisonStatus;
  /**
   * Produktiv eingeplante Mitarbeitende dieser Abteilung, die KEINE einzige
   * Bedarfs-Schicht des Tages matchen (fehlende/fremde Hauptposition oder keine
   * Zeitüberschneidung). Reiner Hinweis — zählt NICHT in `planned`.
   */
  unmatchedPlanned: number;
}

export interface DayStaffingSummaryResult {
  /** Gibt es für (Saison × Wochentag) überhaupt Bedarfs-Schichten (vor Abteilungsfilter)? */
  hasRequirements: boolean;
  /** Nur Abteilungen MIT Bedarf in diesem Geltungsbereich (Reihenfolge = DEPARTMENTS). */
  departments: DepartmentDaySummary[];
}

/**
 * Aggregiert den Schicht-Abgleich zu einer kompakten Tages-Zusammenfassung je
 * Abteilung (z.B. „Service: Soll 5 / Ist 6 / +1" im Dienstplan-Tageskopf).
 *
 * BEWUSSTE EINHEITEN-Entscheidung: Soll UND Ist sind Personen-SCHICHTEN
 * (Σ über die Bedarfs-Schichten; ein MA kann Früh- UND Spät-Bedarf erfüllen und
 * zählt dann 2×) — konsistent mit dem Detail-Panel, keine Kopfzahlen-Mischung.
 * Eingeplante MA ohne gematchte Bedarfs-Schicht erscheinen als
 * `unmatchedPlanned`-Hinweis (kein stilles Verschwinden).
 *
 * Dokumentierte Näherung: Ist ein `departments`-Filter aktiv, sind Orphan-Zeilen
 * (Bedarfe auf inaktiver/unbekannter Position) aus `comparison.rows` ausgeblendet —
 * `matchedIds` enthält deren Matches dann nicht. Ein MA einer eingeschränkten Rolle,
 * der NUR eine Orphan-Schicht matcht, erscheint daher als `unmatchedPlanned`.
 * Die Admin-Sicht (ohne Filter) ist davon nicht betroffen.
 *
 * Orphan-Bedarfe (inaktive/unbekannte Positionen) fließen NICHT in die
 * Abteilungs-Summen ein (keine Abteilung zuordenbar) — sie bleiben Sache des
 * Detail-Panels.
 */
export function computeDayStaffingSummary(args: {
  positions: Position[];
  requirements: StaffingRequirement[];
  plannedEmployees: PlannedEmployeeDay[];
  season: StaffingSeason;
  weekday: number;
  departments?: Department[];
}): DayStaffingSummaryResult {
  const comparison = computeStaffingComparison(args);

  // Alle MA-IDs, die irgendeine Bedarfs-Schicht des Tages matchen (über ALLE
  // gerenderten Zeilen inkl. Orphans → kein falscher „ohne Bedarf"-Hinweis).
  const matchedIds = new Set<string>();
  for (const row of comparison.rows) {
    for (const id of plannedIdsForShift(
      args.plannedEmployees,
      row.positionKey,
      row.shiftStart,
      row.shiftEnd,
    )) {
      matchedIds.add(id);
    }
  }

  const departments: DepartmentDaySummary[] = comparison.groups.map((g) => {
    let required = 0;
    let planned = 0;
    for (const area of g.areas) {
      for (const pc of area.positions) {
        for (const s of pc.shifts) {
          required += s.required;
          planned += s.planned;
        }
      }
    }
    const unmatchedPlanned = args.plannedEmployees.filter(
      (e) => e.department === g.department && !matchedIds.has(e.id),
    ).length;
    return {
      department: g.department,
      required,
      planned,
      diff: planned - required,
      status: comparisonStatus(required, planned),
      unmatchedPlanned,
    };
  });

  return { hasRequirements: comparison.hasRequirements, departments };
}

// ─── KPI-Zusammenfassung (Kacheln „oben") ─────────────────────────────────────

/** Dauer einer Bedarfs-Schicht in Stunden (0 bei ungültigen/Null-Zeiten). */
export function shiftDurationHours(shiftStart: string, shiftEnd: string): number {
  const s = timeToMinutes(shiftStart);
  const e = timeToMinutes(shiftEnd);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return 0;
  return (e - s) / 60;
}

/**
 * KPI-Kennzahlen über die gerenderten Bedarfs-Schichten (rein aus vorhandenen
 * Bedarfs-/Schichtdaten — KEINE neue Datenquelle):
 *   - Anzahl Schichten je Status (optimal / über- / unterbesetzt),
 *   - Über-/Unterbesetzung in Personen-Schichten,
 *   - „Überstunden-Potenzial" = fehlende Personen-STUNDEN aus Unterbesetzung
 *     (Σ |diff| × Schichtdauer über unterbesetzte Schichten). Unterbesetzung ⇒
 *     vorhandenes Personal muss abdecken ⇒ Überstunden-Risiko.
 */
export interface StaffingKpiSummary {
  /** Anzahl Bedarfs-Schichten mit diff === 0. */
  optimal: number;
  /** Anzahl Bedarfs-Schichten mit diff > 0. */
  overstaffed: number;
  /** Anzahl Bedarfs-Schichten mit diff < 0. */
  understaffed: number;
  /** Σ Überbesetzung in Personen-Schichten (diff > 0). */
  overstaffPersonShifts: number;
  /** Σ Unterdeckung in Personen-Schichten (|diff| bei diff < 0). */
  understaffPersonShifts: number;
  /** Überstunden-Potenzial in Personen-Stunden (Unterbesetzung × Schichtdauer). */
  overtimePotentialHours: number;
}

export function summarizeStaffingKpis(rows: ShiftComparisonRow[]): StaffingKpiSummary {
  let optimal = 0;
  let overstaffed = 0;
  let understaffed = 0;
  let overstaffPersonShifts = 0;
  let understaffPersonShifts = 0;
  let overtimePotentialHours = 0;
  for (const r of rows) {
    if (r.diff === 0) {
      optimal += 1;
    } else if (r.diff > 0) {
      overstaffed += 1;
      overstaffPersonShifts += r.diff;
    } else {
      understaffed += 1;
      const short = -r.diff;
      understaffPersonShifts += short;
      overtimePotentialHours += short * shiftDurationHours(r.shiftStart, r.shiftEnd);
    }
  }
  return {
    optimal,
    overstaffed,
    understaffed,
    overstaffPersonShifts,
    understaffPersonShifts,
    // auf 0.1 h runden — vermeidet Fließkomma-Rauschen in der Anzeige.
    overtimePotentialHours: Math.round(overtimePotentialHours * 10) / 10,
  };
}

// ─── Tooltip auf der Differenz ────────────────────────────────────────────────

/**
 * Datengrundlage für den Differenz-Tooltip. `required`/`planned`/`diff` stammen
 * aus dem Abgleich; Umsatz/Produktivität sind OPTIONAL und werden nur angezeigt,
 * wenn ein Wert übergeben wird. Dieses Modul führt bewusst KEINE Umsatzquelle
 * (rein/Supabase-frei, keine neue Datenquelle) — die Felder bleiben ohne
 * externen Wert leer statt erfunden zu werden.
 */
export interface StaffingTooltipData {
  required: number;
  planned: number;
  diff: number;
  /** Optionaler Tagesumsatz (CHF). */
  revenue?: number | null;
  /** Optionale Produktivität (Kennzahl). */
  productivity?: number | null;
  /** Optionaler Umsatz je geplantem Mitarbeiter (CHF). */
  revenuePerEmployee?: number | null;
  /** Optionaler Text zur Berechnungsgrundlage (Default gesetzt). */
  basis?: string;
}

export interface StaffingTooltipLine {
  label: string;
  value: string;
}

export const DEFAULT_TOOLTIP_BASIS =
  'Hauptposition mit Zeitüberschneidung; Abwesenheiten zählen nicht.';

function formatChf(n: number): string {
  return `CHF ${Math.round(n)}`;
}

/**
 * Zeilen des Differenz-Tooltips (reine Funktion → im Node-Env testbar).
 * Immer: Benötigt, Geplant, Differenz, Berechnungsgrundlage. Optional dazwischen:
 * Umsatz, Produktivität, Umsatz pro Mitarbeiter (nur falls Wert vorhanden).
 */
export function staffingTooltipLines(d: StaffingTooltipData): StaffingTooltipLine[] {
  const lines: StaffingTooltipLine[] = [
    { label: 'Benötigtes Personal', value: String(d.required) },
    { label: 'Geplantes Personal', value: String(d.planned) },
    { label: 'Differenz', value: formatStaffingDiffPersons(d.diff) },
  ];
  if (d.revenue != null) lines.push({ label: 'Umsatz', value: formatChf(d.revenue) });
  if (d.productivity != null)
    lines.push({ label: 'Produktivität', value: String(Math.round(d.productivity)) });
  if (d.revenuePerEmployee != null)
    lines.push({ label: 'Umsatz pro Mitarbeiter', value: formatChf(d.revenuePerEmployee) });
  lines.push({ label: 'Berechnungsgrundlage', value: d.basis ?? DEFAULT_TOOLTIP_BASIS });
  return lines;
}
