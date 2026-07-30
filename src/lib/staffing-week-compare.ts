/**
 * staffing-week-compare — Wochen-Abgleich «Bedarf vs. Planung vs. Ist» der
 * Personalbedarf-Seite (reine Funktionen, im Node-Env testbar).
 * ──────────────────────────────────────────────────────────────────────────────
 * EINE gemeinsame Berechnung mit Dienstplan-Live-Hinweis, Wochenmatrix und
 * Cockpit, damit sich die Ansichten nie widersprechen:
 *  - Kopfzahl je Position/Tag: computeDayPlanHints → computeWeekCell (Soll)
 *    und assignPlannedToShifts + Personen-Dedupe (Plan).
 *  - Stunden: Soll = hints.totals.sollHours (Blöcke × Anzahl, ArG-Pausen),
 *    Plan = hints.totals.plannedHours (alle produktiven Einsätze),
 *    Ist = istHoursForDate (MIRUS; null solange kein Import — nie 0).
 *  - Bedarf pro DATUM: aktives Profil via resolveActiveProfileForDate,
 *    effektiver Bedarf via buildEffectiveRequirements inkl. Tages-Flag
 *    «UG/Event offen» (eventDays) — identisch zum Einzeltag-Abgleich.
 */

import type { Position } from '@/types/positions';
import type { StaffingRequirement } from '@/types/staffing';
import type { Employee } from '@/types/personnel';
import type { DaySchedule, ActualHourEntry } from '@/lib/supabase-db';
import { isoWeekdayOf, istHoursForDate } from '@/lib/bedarf-stunden-utils';
import {
  buildEffectiveRequirements,
  resolveActiveProfileForDate,
  type StaffingProfilesConfig,
} from '@/lib/staffing-profiles-utils';
import { buildPlannedEmployees } from '@/lib/staffing-comparison-utils';
import {
  computeCdsCheck,
  computeKitchenColdCheck,
  dynamicPositionOverrides,
} from '@/lib/staffing-check-utils';
import { computeDayPlanHints, type DayPlanHints } from '@/lib/staffing-day-hints';

const r1 = (v: number) => Math.round(v * 10) / 10;

export interface WeekCompareDay {
  dateStr: string;
  /** ISO-Wochentag 1=Mo … 7=So. */
  weekday: number;
  /** Kopfzahl-/Stunden-Abgleich des Tages (gemeinsame Berechnung). */
  hints: DayPlanHints;
  /** Σ Bedarf-Netto-Stunden des Tages (aus hints.totals.sollHours). */
  bedarfHours: number;
  /** Plan-Netto-Stunden; null = an dem Tag ist NIEMAND eingeplant (nie 0). */
  planHours: number | null;
  /** Ist-Stunden (MIRUS); null = kein Import (nie 0). */
  istHours: number | null;
  /** true, wenn an dem Tag jemand eingeplant ist. */
  hasPlan: boolean;
}

export interface WeekCompareRowCell {
  soll: number;
  planned: number;
  diff: number;
}

/** Zeile der Wochen-Vergleichsmatrix (Position × Mo–So, Kopfzahl). */
export interface WeekCompareRow {
  positionKey: string;
  positionName: string;
  /** Wochentag → Zelle; Tage ohne Bedarf UND ohne Plan fehlen. */
  cells: Record<number, WeekCompareRowCell>;
}

export interface WeekCompareTotals {
  /** Σ Soll-Kopfzahlen der Woche. */
  sollPersons: number;
  /** Σ Plan-Kopfzahlen (Positions-Einheit, wie sollPersons); null = keine Planung. */
  planPersons: number | null;
  sollHours: number;
  planHours: number | null;
  istHours: number | null;
}

export interface WeekCompare {
  days: WeekCompareDay[];
  rows: WeekCompareRow[];
  totals: WeekCompareTotals;
  /** true, wenn irgendein Tag Bedarf hat. */
  hasAnyRequirement: boolean;
  /** true, wenn irgendein Tag eine Planung hat. */
  hasAnyPlan: boolean;
}

/**
 * Baut den Wochen-Abgleich für 7 konkrete Kalendertage (Mo–So).
 * `dates` müssen yyyy-MM-dd sein, Reihenfolge = Mo…So.
 */
export function buildWeekCompare(args: {
  positions: Position[];
  requirements: StaffingRequirement[];
  config: StaffingProfilesConfig;
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  actualHours: Record<string, ActualHourEntry>;
  dates: string[];
  /** Tages-Flags «UG/Event offen» (aktiviert den UG-Zuschlag ganzjährig). */
  eventDays?: Set<string>;
}): WeekCompare {
  const { positions, requirements, config, employees, scheduleData, actualHours } = args;

  const days: WeekCompareDay[] = [];
  const rowByKey = new Map<string, WeekCompareRow>();
  const rowOrder: string[] = [];
  let sollPersons = 0;
  let planPersons = 0;
  let sollHours = 0;
  let planHours = 0;
  let istHours = 0;
  let anyReq = false;
  let anyPlan = false;
  let anyIst = false;

  for (const dateStr of args.dates) {
    const weekday = isoWeekdayOf(dateStr);
    const date = new Date(`${dateStr}T12:00:00`);
    const season = resolveActiveProfileForDate(config, date);
    const eventOpen = args.eventDays?.has(dateStr) ?? false;
    const effective = buildEffectiveRequirements({
      requirements, config, season, weekday, eventOpen,
    });
    const planned = buildPlannedEmployees(employees, scheduleData, positions, dateStr);
    const plannedIds = planned.map((p) => p.id);
    const cds = computeCdsCheck(plannedIds, config.cdsPriority ?? [], weekday);
    const cold = computeKitchenColdCheck(plannedIds, config.kitchenCold);
    const hints = computeDayPlanHints({
      positions,
      requirements: effective,
      plannedEmployees: planned,
      season,
      weekday,
      preferredKeysById: dynamicPositionOverrides(cds, cold),
      ruleWarnings: [cds.warning, cold.warning],
    });

    const hasPlan = planned.length > 0;
    const ist = istHoursForDate(actualHours, dateStr);
    days.push({
      dateStr,
      weekday,
      hints,
      bedarfHours: hints.totals.sollHours,
      planHours: hasPlan ? hints.totals.plannedHours : null,
      istHours: ist,
      hasPlan,
    });

    if (hints.hasRequirements) anyReq = true;
    if (hasPlan) anyPlan = true;
    if (ist != null) { anyIst = true; istHours += ist; }
    sollPersons += hints.totals.sollPersons;
    planPersons += hints.totals.plannedPersons;
    sollHours += hints.totals.sollHours;
    if (hasPlan) planHours += hints.totals.plannedHours;

    for (const p of hints.positions) {
      let row = rowByKey.get(p.positionKey);
      if (!row) {
        row = { positionKey: p.positionKey, positionName: p.positionName, cells: {} };
        rowByKey.set(p.positionKey, row);
        rowOrder.push(p.positionKey);
      }
      row.cells[weekday] = { soll: p.soll, planned: p.planned, diff: p.diff };
    }
  }

  // Zeilen in kanonischer Positions-Reihenfolge (wie die Soll-Wochenübersicht):
  // aktive Positionen zuerst in ihrer Sortierung, Orphans in Auftrittsreihenfolge.
  const canonical = positions
    .filter((p) => p.active)
    .map((p) => p.key)
    .filter((k) => rowByKey.has(k));
  const orphans = rowOrder.filter((k) => !canonical.includes(k));
  const rows = [...canonical, ...orphans].map((k) => rowByKey.get(k)!);

  return {
    days,
    rows,
    totals: {
      sollPersons,
      planPersons: anyPlan ? planPersons : null,
      sollHours: r1(sollHours),
      planHours: anyPlan ? r1(planHours) : null,
      istHours: anyIst ? r1(istHours) : null,
    },
    hasAnyRequirement: anyReq,
    hasAnyPlan: anyPlan,
  };
}
