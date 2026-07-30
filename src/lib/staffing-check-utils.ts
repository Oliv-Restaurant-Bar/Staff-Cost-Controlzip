/**
 * staffing-check-utils — reine Logik der Dienstplan-Prüfung (Soll vs. Ist)
 * in DREI Dimensionen mit Ampel, plus Chef-de-Service-Regel.
 * ──────────────────────────────────────────────────────────────────────────────
 * KEINE Supabase-/DOM-Abhängigkeiten — isoliert testbar (node-Umgebung).
 * NUR Analyse/Anzeige: verändert weder Dienstplan noch Personalbedarf und
 * verändert insbesondere KEINE Kosten-/Überstunden-Berechnung (die bestehende
 * Pausenlogik in useShiftConfig bleibt unberührt — die ArG-Staffel hier gilt
 * NUR für die Netto-Stunden dieser Prüfung).
 *
 * ── Dimensionen ───────────────────────────────────────────────────────────────
 *  1. STUNDEN     — geplante Netto-Ist-Stunden je Position vs. Netto-Soll
 *                   (Soll = Σ benötigte Personen × Netto-Schichtdauer).
 *  2. POSITIONEN  — geplante Ist-Anzahl je Bedarfs-Schicht vs. anzahl_soll.
 *  3. ABDECKUNG   — jede geforderte Schicht durch ≥1 GESCHULTE Person besetzt
 *                   (Haupt- ODER Zweitposition), zusätzlich CdS-Regel erfüllt.
 *
 * ── Netto-Stunden (ArG/L-GAV-Pausenstaffel) ───────────────────────────────────
 *  Durchgehendes Segment abzüglich Pause: 15 min ab 5.5 h, 30 min ab 7 h,
 *  60 min ab 9 h Bruttodauer. Splitschicht = Summe der Segmente (die grosse
 *  Pause liegt in der Lücke); die Staffel wird je SEGMENT angewendet.
 *
 * ── Ampel ─────────────────────────────────────────────────────────────────────
 *  grün = im Soll · gelb = Soll ±1 bzw. knapp · rot = deutliche Abweichung
 *  bzw. unbesetzte Station/Schicht bzw. CdS-Regel verletzt.
 *  Schwellen (dokumentierte Festlegung):
 *   - Stunden je Position: grün |Δ| ≤ 0.25 h, gelb |Δ| ≤ 1 h, sonst rot.
 *   - Anzahl je Schicht:   grün Δ = 0, gelb |Δ| = 1, sonst rot.
 *   - Abdeckung:           grün alles besetzt + CdS ok; rot sonst
 *                          (gelb, wenn nur die CdS-Besetzung als WARNUNG offen
 *                          ist, aber alle Stationen besetzt sind — «knapp»).
 */
import type { Position } from '@/types/positions';
import type { StaffingRequirement, StaffingSeason } from '@/types/staffing';
import { shiftsForScope, timeToMinutes } from '@/lib/staffing-requirements-utils';
import {
  slotOverlapsShift,
  type PlannedSlot,
  type PlannedEmployeeDay,
} from '@/lib/staffing-comparison-utils';

// ─── ArG/L-GAV-Pausenstaffel + Netto-Minuten ─────────────────────────────────

/** Pausenstaffel: 60 min ab 9 h, 30 min ab 7 h, 15 min ab 5.5 h Bruttodauer. */
export function argBreakMinutes(grossMinutes: number): number {
  if (!Number.isFinite(grossMinutes) || grossMinutes <= 0) return 0;
  if (grossMinutes >= 9 * 60) return 60;
  if (grossMinutes >= 7 * 60) return 30;
  if (grossMinutes >= 5.5 * 60) return 15;
  return 0;
}

/** Netto-Minuten EINES durchgehenden Segments (brutto − Staffel-Pause). */
export function nettoSegmentMinutes(start: string, end: string): number {
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return 0;
  const gross = e - s;
  return Math.max(0, gross - argBreakMinutes(gross));
}

/** Netto-Minuten eines Tages: Splitschicht = Summe der Segmente. */
export function nettoMinutesForSlots(slots: PlannedSlot[]): number {
  return slots.reduce((sum, s) => sum + nettoSegmentMinutes(s.start, s.end), 0);
}

// ─── Chef-de-Service-Regel ────────────────────────────────────────────────────

export interface CdsCheckResult {
  /** Aktiver CdS des Tages (höchste geplante Priorität) oder null. */
  activeCdsId: string | null;
  /**
   * Gastgeber/GF des Tages: die zweitpriorisierte Person, wenn die
   * erstpriorisierte als CdS geplant ist (z.B. Artin geplant → Mendim =
   * Gastgeber/GF). Sonst null.
   */
  gastgeberId: string | null;
  /** true, wenn ein CdS besetzt werden kann. */
  ok: boolean;
  /** Deutsche Warnung, falls kein CdS planbar ist (sonst null). */
  warning: string | null;
}

/**
 * Genau 1 CdS pro Tag: die am Tag GEPLANTE Person mit höchster Priorität.
 * Ist die erstpriorisierte Person geplant, wird die zweitpriorisierte (falls
 * ebenfalls geplant) Gastgeber/GF; nachfolgende Prioritäten bleiben in ihrer
 * normalen Rolle (z.B. Ibrahim → Service). Leere Prioritätsliste ⇒ Regel
 * nicht konfiguriert (ok, keine Warnung).
 */
export function computeCdsCheck(
  plannedEmployeeIds: readonly string[],
  cdsPriority: readonly string[],
): CdsCheckResult {
  if (cdsPriority.length === 0) {
    return { activeCdsId: null, gastgeberId: null, ok: true, warning: null };
  }
  const planned = new Set(plannedEmployeeIds);
  const activeCdsId = cdsPriority.find((id) => planned.has(id)) ?? null;
  let gastgeberId: string | null = null;
  if (activeCdsId !== null && activeCdsId === cdsPriority[0] && cdsPriority.length > 1) {
    const second = cdsPriority[1];
    if (planned.has(second)) gastgeberId = second;
  }
  return {
    activeCdsId,
    gastgeberId,
    ok: activeCdsId !== null,
    warning:
      activeCdsId === null
        ? 'Kein Chef de Service planbar — keine Person der Prioritätsliste ist an diesem Tag eingeplant.'
        : null,
  };
}

// ─── Tages-Prüfung (3 Dimensionen) ────────────────────────────────────────────

export type Ampel = 'gruen' | 'gelb' | 'rot';

/** Schlechteste Farbe gewinnt. */
export function worstAmpel(values: Ampel[]): Ampel {
  if (values.includes('rot')) return 'rot';
  if (values.includes('gelb')) return 'gelb';
  return 'gruen';
}

/** Eingeplante Person inkl. GESCHULTER Positionen (Haupt + Zweit, Slugs). */
export interface PlannedEmployeeDayEx extends PlannedEmployeeDay {
  /** Alle Positionen, die die Person abdecken KANN (Haupt + Zweit, Slugs). */
  trainedKeys: string[];
}

export interface HoursCheckRow {
  positionKey: string;
  /** Netto-Soll-Stunden (Σ Anzahl × Netto-Schichtdauer). */
  sollHours: number;
  /** Netto-Ist-Stunden (Σ Netto-Minuten der MA mit dieser HAUPT-Position). */
  istHours: number;
  diffHours: number;
  ampel: Ampel;
}

export interface CountCheckRow {
  positionKey: string;
  shiftStart: string;
  shiftEnd: string;
  soll: number;
  ist: number;
  diff: number;
  ampel: Ampel;
}

export interface CoverageCheckRow {
  positionKey: string;
  shiftStart: string;
  shiftEnd: string;
  /** ≥1 geschulte (Haupt ODER Zweit) Person mit Zeitüberschneidung geplant. */
  covered: boolean;
  /** true, wenn die Abdeckung NUR über Zweitpositionen zustande kommt. */
  coveredOnlyBySecondary: boolean;
}

export interface DayCheckResult {
  hasRequirements: boolean;
  hours: { rows: HoursCheckRow[]; ampel: Ampel };
  counts: { rows: CountCheckRow[]; ampel: Ampel };
  coverage: { rows: CoverageCheckRow[]; cds: CdsCheckResult; ampel: Ampel };
  overall: Ampel;
}

function hoursAmpel(diffHours: number): Ampel {
  const a = Math.abs(diffHours);
  if (a <= 0.25) return 'gruen';
  if (a <= 1) return 'gelb';
  return 'rot';
}

function countAmpel(diff: number): Ampel {
  if (diff === 0) return 'gruen';
  if (Math.abs(diff) === 1) return 'gelb';
  return 'rot';
}

/** Runden auf 0.1 h (Anzeige-/Vergleichsstabilität). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Prüft EINEN Tag gegen das aktive Profil (Saison) in drei Dimensionen.
 * `positions` wird nur zur Beschränkung auf bekannte Slugs NICHT benötigt —
 * geprüft wird der Bedarf, wie er definiert ist (inkl. Orphan-Slugs).
 */
export function computeDayCheck(args: {
  requirements: StaffingRequirement[];
  plannedEmployees: PlannedEmployeeDayEx[];
  season: StaffingSeason;
  weekday: number;
  cdsPriority: readonly string[];
}): DayCheckResult {
  const { requirements, plannedEmployees, season, weekday, cdsPriority } = args;
  const shifts = shiftsForScope(requirements, season, weekday);

  // ── CdS (alle produktiv geplanten Personen des Tages) ──
  const cds = computeCdsCheck(plannedEmployees.map((e) => e.id), cdsPriority);

  if (shifts.length === 0) {
    return {
      hasRequirements: false,
      hours: { rows: [], ampel: 'gruen' },
      counts: { rows: [], ampel: 'gruen' },
      coverage: { rows: [], cds, ampel: cds.ok ? 'gruen' : 'gelb' },
      overall: cds.ok ? 'gruen' : 'gelb',
    };
  }

  // ── 1) Stunden je Position ──
  const sollMinutesByKey = new Map<string, number>();
  for (const s of shifts) {
    const netto = nettoSegmentMinutes(s.shiftStart, s.shiftEnd) * s.requiredCount;
    sollMinutesByKey.set(s.positionKey, (sollMinutesByKey.get(s.positionKey) ?? 0) + netto);
  }
  const istMinutesByKey = new Map<string, number>();
  for (const e of plannedEmployees) {
    if (!e.positionKey) continue;
    istMinutesByKey.set(
      e.positionKey,
      (istMinutesByKey.get(e.positionKey) ?? 0) + nettoMinutesForSlots(e.slots),
    );
  }
  const hoursKeys = [...new Set([...sollMinutesByKey.keys(), ...istMinutesByKey.keys()])]
    // Nur Positionen MIT Soll anzeigen + Ist-Positionen ohne Soll (Übermass).
    .filter((k) => (sollMinutesByKey.get(k) ?? 0) > 0 || (istMinutesByKey.get(k) ?? 0) > 0);
  const hoursRows: HoursCheckRow[] = hoursKeys.map((key) => {
    const soll = round1((sollMinutesByKey.get(key) ?? 0) / 60);
    const ist = round1((istMinutesByKey.get(key) ?? 0) / 60);
    const diff = round1(ist - soll);
    return { positionKey: key, sollHours: soll, istHours: ist, diffHours: diff, ampel: hoursAmpel(diff) };
  });

  // ── 2) Anzahl je Bedarfs-Schicht (Zählregel wie bisher: HAUPT-Position) ──
  const countRows: CountCheckRow[] = shifts.map((s) => {
    const ist = plannedEmployees.filter(
      (e) =>
        e.positionKey === s.positionKey &&
        e.slots.some((sl) => slotOverlapsShift(sl, s.shiftStart, s.shiftEnd)),
    ).length;
    const diff = ist - s.requiredCount;
    return {
      positionKey: s.positionKey,
      shiftStart: s.shiftStart,
      shiftEnd: s.shiftEnd,
      soll: s.requiredCount,
      ist,
      diff,
      ampel: countAmpel(diff),
    };
  });

  // ── 3) Abdeckung (geschulte Person = Haupt ODER Zweit) + CdS ──
  const coverageRows: CoverageCheckRow[] = shifts
    .filter((s) => s.requiredCount > 0)
    .map((s) => {
      const matching = plannedEmployees.filter(
        (e) =>
          e.trainedKeys.includes(s.positionKey) &&
          e.slots.some((sl) => slotOverlapsShift(sl, s.shiftStart, s.shiftEnd)),
      );
      const covered = matching.length > 0;
      const coveredOnlyBySecondary =
        covered && matching.every((e) => e.positionKey !== s.positionKey);
      return {
        positionKey: s.positionKey,
        shiftStart: s.shiftStart,
        shiftEnd: s.shiftEnd,
        covered,
        coveredOnlyBySecondary,
      };
    });

  const hoursOverall = worstAmpel(hoursRows.map((r) => r.ampel));
  const countsOverall = worstAmpel(countRows.map((r) => r.ampel));
  const anyUncovered = coverageRows.some((r) => !r.covered);
  const anySecondaryOnly = coverageRows.some((r) => r.coveredOnlyBySecondary);
  const coverageOverall: Ampel = anyUncovered
    ? 'rot'
    : !cds.ok
      ? 'gelb'
      : anySecondaryOnly
        ? 'gelb'
        : 'gruen';

  return {
    hasRequirements: true,
    hours: { rows: hoursRows, ampel: hoursOverall },
    counts: { rows: countRows, ampel: countsOverall },
    coverage: { rows: coverageRows, cds, ampel: coverageOverall },
    overall: worstAmpel([hoursOverall, countsOverall, coverageOverall]),
  };
}
