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
import type { KitchenColdRule } from '@/lib/staffing-profiles-utils';
import { shiftsForScope, timeToMinutes } from '@/lib/staffing-requirements-utils';
import {
  slotOverlapsShift,
  assignPlannedToShifts,
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
 * ISO-Wochentage, an denen die Gastgeber/GF-Rolle vorgesehen ist (Do/Fr/Sa).
 * An So–Mi ist die zweitpriorisierte Person (sofern nicht selbst CdS) in
 * ihrer normalen Position (Service) — kein Gastgeber/GF.
 */
export const GASTGEBER_WEEKDAYS: readonly number[] = [4, 5, 6];

/** Konfigurierbare Teile der Gastgeber-Regel (Default = bisheriges Verhalten). */
export interface CdsRuleOptions {
  /** ISO-Wochentage der Gastgeber/GF-Rolle (Default GASTGEBER_WEEKDAYS Do–Sa). */
  gastgeberWeekdays?: readonly number[];
  /**
   * true (Default) = zweite Priorität wird nur Gastgeber/GF, wenn die ERSTE
   * Priorität als CdS geplant ist. false = zweite Priorität wird Gastgeber/GF,
   * sobald sie geplant und nicht selbst CdS ist.
   */
  gastgeberRequiresFirstPlanned?: boolean;
}

/**
 * Genau 1 CdS pro Tag: die am Tag GEPLANTE Person mit höchster Priorität.
 * Gastgeber/GF = zweitpriorisierte Person an den konfigurierten Wochentagen
 * (Default Do/Fr/Sa), gemäss Bedingung (siehe CdsRuleOptions); an anderen
 * Tagen bleibt sie in ihrer normalen Rolle.
 * Nachfolgende Prioritäten bleiben immer in ihrer normalen Rolle.
 * Leere Prioritätsliste ⇒ Regel nicht konfiguriert (ok, keine Warnung).
 * `weekday` weglassen ⇒ Gastgeber-Zuweisung wie bisher (jeden Tag).
 */
export function computeCdsCheck(
  plannedEmployeeIds: readonly string[],
  cdsPriority: readonly string[],
  weekday?: number,
  rule?: CdsRuleOptions,
): CdsCheckResult {
  if (cdsPriority.length === 0) {
    return { activeCdsId: null, gastgeberId: null, ok: true, warning: null };
  }
  const planned = new Set(plannedEmployeeIds);
  const activeCdsId = cdsPriority.find((id) => planned.has(id)) ?? null;
  const weekdays = rule?.gastgeberWeekdays ?? GASTGEBER_WEEKDAYS;
  const requireFirst = rule?.gastgeberRequiresFirstPlanned !== false;
  const gastgeberDay = weekday === undefined || weekdays.includes(weekday);
  let gastgeberId: string | null = null;
  if (gastgeberDay && activeCdsId !== null && cdsPriority.length > 1) {
    const second = cdsPriority[1];
    const eligible = requireFirst
      ? activeCdsId === cdsPriority[0]        // Bedingung: erste Priorität ist CdS
      : second !== activeCdsId;               // ohne Bedingung: nur nicht selbst CdS
    if (eligible && planned.has(second)) gastgeberId = second;
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

// ─── Küchen-Stationsregel Kalte Küche/Sushi (dynamisch, analog CdS) ──────────

export interface KitchenColdCheckResult {
  /** Person, die heute Kalte Küche/Sushi übernimmt (oder null). */
  coldId: string | null;
  /**
   * 'solo'       = Stamm-Besetzung (Miro) geplant, übernimmt beide Stationen.
   * 'fallback'   = Vertretung aus fallbackIds (Michele > Mejdi).
   * 'weak_day'   = < minHotCooks Herd-Köche geplant → keine eigene Kalte-Station (ok).
   * 'missing'    = genug Herd-Köche, aber niemand kann Kalte Küche übernehmen.
   * 'not_configured' = keine Regel hinterlegt.
   */
  mode: 'solo' | 'fallback' | 'weak_day' | 'missing' | 'not_configured';
  /** Anzahl geplanter Herd-Köche (aus hotCookIds). */
  hotCookCount: number;
  ok: boolean;
  /** Deutsche Warnung bei 'missing' (sonst null). */
  warning: string | null;
}

/**
 * Kalte Küche/Sushi: Miro zuerst; sonst ab `minHotCooks` geplanten Herd-Köchen
 * die erste geplante Vertretung (Michele > Mejdi). An schwach besetzten Tagen
 * (< minHotCooks) entfällt die eigene Kalte-Station ohne Warnung.
 */
export function computeKitchenColdCheck(
  plannedEmployeeIds: readonly string[],
  rule: KitchenColdRule | null | undefined,
): KitchenColdCheckResult {
  if (!rule) {
    return { coldId: null, mode: 'not_configured', hotCookCount: 0, ok: true, warning: null };
  }
  const planned = new Set(plannedEmployeeIds);
  const hotCookCount = rule.hotCookIds.filter((id) => planned.has(id)).length;
  if (planned.has(rule.soloId)) {
    return { coldId: rule.soloId, mode: 'solo', hotCookCount, ok: true, warning: null };
  }
  if (hotCookCount < rule.minHotCooks) {
    return { coldId: null, mode: 'weak_day', hotCookCount, ok: true, warning: null };
  }
  const coldId = rule.fallbackIds.find((id) => planned.has(id)) ?? null;
  if (coldId !== null) {
    return { coldId, mode: 'fallback', hotCookCount, ok: true, warning: null };
  }
  return {
    coldId: null,
    mode: 'missing',
    hotCookCount,
    ok: false,
    warning:
      'Kalte Küche/Sushi unbesetzt — weder die Stamm-Besetzung noch eine Vertretung ist an diesem Tag eingeplant.',
  };
}

/**
 * Übersetzt die dynamischen Regeln (CdS/Gastgeber + Kalte Küche/Sushi) in
 * bevorzugte Positions-Keys je Person — Eingabe für assignPlannedToShifts
 * bzw. computeStaffingComparison({ preferredKeysById }).
 */
export function dynamicPositionOverrides(
  cds: CdsCheckResult,
  kitchenCold: KitchenColdCheckResult,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (cds.activeCdsId) out[cds.activeCdsId] = ['chef_de_service'];
  if (cds.gastgeberId) out[cds.gastgeberId] = ['gastgeber_gf'];
  if (kitchenCold.coldId) {
    out[kitchenCold.coldId] = [...(out[kitchenCold.coldId] ?? []), 'kalte_kueche', 'sushi'];
  }
  return out;
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
  coverage: {
    rows: CoverageCheckRow[];
    cds: CdsCheckResult;
    kitchenCold: KitchenColdCheckResult;
    ampel: Ampel;
  };
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
  /** Konfigurierbare Gastgeber-Regel (Wochentage/Bedingung); Default wie bisher. */
  cdsRule?: CdsRuleOptions;
  /** Küchen-Stationsregel Kalte Küche/Sushi (optional, analog CdS). */
  kitchenCold?: KitchenColdRule | null;
}): DayCheckResult {
  const { requirements, plannedEmployees, season, weekday, cdsPriority, cdsRule, kitchenCold } = args;
  const shifts = shiftsForScope(requirements, season, weekday);

  // ── CdS + Kalte Küche/Sushi (alle produktiv geplanten Personen des Tages) ──
  const plannedIds = plannedEmployees.map((e) => e.id);
  const cds = computeCdsCheck(plannedIds, cdsPriority, weekday, cdsRule);
  const cold = computeKitchenColdCheck(plannedIds, kitchenCold);

  if (shifts.length === 0) {
    const ruleAmpel: Ampel = cds.ok && cold.ok ? 'gruen' : 'gelb';
    return {
      hasRequirements: false,
      hours: { rows: [], ampel: 'gruen' },
      counts: { rows: [], ampel: 'gruen' },
      coverage: { rows: [], cds, kitchenCold: cold, ampel: ruleAmpel },
      overall: ruleAmpel,
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

  // ── 2) Anzahl je Bedarfs-Schicht: eindeutige Zuordnung (jeder Einsatz zählt
  // genau EINMAL — grösste Überlappung, Haupt/Zweit/Regel; keine Mehrfachzählung).
  const assignment = assignPlannedToShifts(
    shifts,
    plannedEmployees,
    dynamicPositionOverrides(cds, cold),
  );
  const countRows: CountCheckRow[] = shifts.map((s, i) => {
    const ist = (assignment.get(i) ?? []).length;
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
    : !cds.ok || !cold.ok
      ? 'gelb'
      : anySecondaryOnly
        ? 'gelb'
        : 'gruen';

  return {
    hasRequirements: true,
    hours: { rows: hoursRows, ampel: hoursOverall },
    counts: { rows: countRows, ampel: countsOverall },
    coverage: { rows: coverageRows, cds, kitchenCold: cold, ampel: coverageOverall },
    overall: worstAmpel([hoursOverall, countsOverall, coverageOverall]),
  };
}
