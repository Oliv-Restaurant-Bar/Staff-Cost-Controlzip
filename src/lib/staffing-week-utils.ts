/**
 * Wochenübersicht des Personalbedarfs («Ganze Woche»): Matrix Mo–So mit je
 * Mittag/Abend-Zelle pro Position, gruppiert nach Abteilung/Bereich, plus
 * Tages-Summen (Einsätze, Netto-Stunden, Umsatzbudget).
 *
 * Reine Funktionen ohne UI. Effektiver Bedarf pro Wochentag kommt aus
 * buildEffectiveRequirements (inkl. UG-Zuschlag Fr/Sa im Winter/UG-Profil;
 * Tages-Event-Flags gibt es hier nicht — die Übersicht zeigt den Regelbedarf).
 *
 * Klassifikation Mittag/Abend: Schichtbeginn vor 16:00 = Mittag, sonst Abend.
 */

import type { Position } from '@/types/positions';
import type { Department } from '@/types/personnel';
import type { StaffingRequirement, StaffingSeason } from '@/types/staffing';
import type { PositionArea } from '@/lib/position-utils';
import { timeToMinutes, buildRequirementMatrix } from '@/lib/staffing-requirements-utils';
import { nettoSegmentMinutes } from '@/lib/staffing-check-utils';
import {
  buildEffectiveRequirements,
  type StaffingProfilesConfig,
} from '@/lib/staffing-profiles-utils';

/** Grenze Mittag/Abend (Minuten seit Mitternacht): Beginn < 16:00 = Mittag. */
export const EVENING_START_MINUTES = 16 * 60;

export function isEveningShift(shiftStart: string): boolean {
  const m = timeToMinutes(shiftStart);
  return !Number.isNaN(m) && m >= EVENING_START_MINUTES;
}

export interface WeekCell {
  /** Σ benötigte Personen der Mittag-Blöcke (Beginn < 16:00). */
  mittag: number;
  /** Σ benötigte Personen der Abend-Blöcke. */
  abend: number;
  /** Blöcke für Tooltip/Detail (Zeit + Anzahl). */
  shifts: { shiftStart: string; shiftEnd: string; requiredCount: number }[];
}

export interface WeekPositionRow {
  positionKey: string;
  positionName: string;
  /** ISO-Wochentag (1=Mo … 7=So) → Zelle. Tage ohne Bedarf fehlen. */
  cells: Record<number, WeekCell>;
}

export interface WeekAreaGroup {
  area: PositionArea | null;
  positions: WeekPositionRow[];
}

export interface WeekDepartmentGroup {
  department: Department;
  areas: WeekAreaGroup[];
}

export interface WeekDayTotals {
  /** Σ benötigte Personen-Einsätze (Soll-Blöcke × Anzahl) des Tages. */
  persons: number;
  /** Σ Netto-Stunden (ARG-Pausenabzug) über alle Soll-Blöcke des Tages. */
  nettoHours: number;
  /** Umsatzbudget des Wochentags (CHF) oder null wenn nicht konfiguriert. */
  budget: number | null;
}

export interface WeekOverview {
  groups: WeekDepartmentGroup[];
  /** ISO-Wochentag → Summen. Für alle 7 Tage vorhanden. */
  totals: Record<number, WeekDayTotals>;
  /** True, wenn irgendein Tag Bedarf hat. */
  hasAny: boolean;
}

/**
 * Baut die Wochenübersicht für ein Profil (Saison). Positionszeilen erscheinen,
 * sobald mindestens EIN Wochentag Bedarf für die Position hat.
 */
export function buildWeekOverview(args: {
  positions: Position[];
  requirements: StaffingRequirement[];
  config: StaffingProfilesConfig;
  season: StaffingSeason;
}): WeekOverview {
  const { positions, requirements, config, season } = args;

  const totals: Record<number, WeekDayTotals> = {};
  // Position → Wochentag → Zelle (aus den Tagesmatrizen eingesammelt).
  const cellsByPosition = new Map<string, Record<number, WeekCell>>();
  // Skelett (Abteilung/Bereich/Reihenfolge) vom ersten Tag mit Struktur.
  let skeleton: ReturnType<typeof buildRequirementMatrix> | null = null;

  for (let weekday = 1; weekday <= 7; weekday++) {
    const effective = buildEffectiveRequirements({
      requirements,
      config,
      season,
      weekday,
      eventOpen: false,
    });
    const matrix = buildRequirementMatrix(positions, effective, season, weekday);
    if (!skeleton) skeleton = matrix;

    let persons = 0;
    let nettoMinutes = 0;
    for (const dept of matrix) {
      for (const area of dept.areas) {
        for (const pr of area.positions) {
          if (pr.shifts.length === 0) continue;
          const cell: WeekCell = { mittag: 0, abend: 0, shifts: [] };
          for (const s of pr.shifts) {
            const count = Number.isFinite(s.requiredCount) ? s.requiredCount : 0;
            if (isEveningShift(s.shiftStart)) cell.abend += count;
            else cell.mittag += count;
            cell.shifts.push({ shiftStart: s.shiftStart, shiftEnd: s.shiftEnd, requiredCount: count });
            persons += count;
            nettoMinutes += nettoSegmentMinutes(s.shiftStart, s.shiftEnd) * count;
          }
          const byDay = cellsByPosition.get(pr.position.key) ?? {};
          byDay[weekday] = cell;
          cellsByPosition.set(pr.position.key, byDay);
        }
      }
    }

    const budgetRaw = config.revenueBudgetByWeekday?.[weekday];
    totals[weekday] = {
      persons,
      nettoHours: Math.round((nettoMinutes / 60) * 10) / 10,
      budget: typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) ? budgetRaw : null,
    };
  }

  // Zeilen in kanonischer Reihenfolge des Skeletts; nur Positionen mit Bedarf.
  const groups: WeekDepartmentGroup[] = [];
  for (const dept of skeleton ?? []) {
    const areas: WeekAreaGroup[] = [];
    for (const area of dept.areas) {
      const rows: WeekPositionRow[] = [];
      for (const pr of area.positions) {
        const cells = cellsByPosition.get(pr.position.key);
        if (!cells || Object.keys(cells).length === 0) continue;
        rows.push({ positionKey: pr.position.key, positionName: pr.position.name, cells });
      }
      if (rows.length > 0) areas.push({ area: area.area, positions: rows });
    }
    if (areas.length > 0) groups.push({ department: dept.department, areas });
  }

  const hasAny = groups.length > 0;
  return { groups, totals, hasAny };
}
