/**
 * fairness-utils.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Berechnet wöchentliche Stundenziele und Fairness-Indikatoren
 * pro Mitarbeiter für den Planungsassistenten.
 *
 * Fairness-Dimensionen:
 *   - Wochenend-Belastung   (Samstag/Sonntag-Schichten)
 *   - Abend-Belastung       (Spätschichten)
 *   - Konzentration         (immer dieselben MA auf schlechten Slots)
 *   - Wöchentliche Stunden  (Plan vs. Soll vs. Ist)
 */

import { Employee } from '@/types/personnel';
import { DaySchedule } from '@/components/schedule-planner/ScheduleGrid';
import { format, getISOWeek, startOfISOWeek, isWeekend } from 'date-fns';
import { de } from 'date-fns/locale';
import { resolveBreakHours } from '@/hooks/useShiftConfig';

// ─── Interne Slot-Berechnung (identisch zu PlanningAssistant) ─────────────────

function calcSlotHours(slot: { start?: string | null; end?: string | null } | null | undefined): number {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = (eh - sh) + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.max(0, h);
}

function netHours(ds: DaySchedule): number {
  const gross = calcSlotHours(ds.früh) + calcSlotHours(ds.spät);
  return Math.max(0, gross - resolveBreakHours(gross, ds.breakMinutes));
}

// ─── Typen ────────────────────────────────────────────────────────────────────

/**
 * Wochenzeile für eine Perioden-Übersicht pro Mitarbeiter.
 */
export interface WeeklyHourRow {
  weekStart: string;          // YYYY-MM-DD (ISO Montag)
  weekLabel: string;          // "KW 12 (3.–9.3.)"
  weekNumber: number;         // ISO-Wochennummer
  daysInPeriod: string[];     // dateStr-Liste der Tage dieser Woche innerhalb der Periode
  targetHours: number;        // vertragliches Wochensoll (employee.weeklyHours)
  plannedHours: number;       // Σ geplante Netto-Stunden
  actualHours: number | null; // Σ Ist-Stunden (Mirus), null wenn keine Daten
  plannedDeviation: number;   // plannedHours − targetHours
  actualDeviation: number | null; // actualHours − targetHours (null wenn keine Ist-Daten)
  isPartialWeek: boolean;     // Woche hat weniger als 7 Tage in der Periode (Rand-Woche)
}

/**
 * Fairness-Kennzahlen pro Mitarbeiter über die gesamte Anzeige-Periode.
 */
export interface EmployeeShiftFairness {
  empId: string;
  empName: string;
  dept: 'service' | 'küche';
  totalShiftsWorked: number;   // Früh+Spät-Slots mit echten Schichtzeiten (keine Absenzen)
  weekendShifts: number;       // Schichten an Sa/So
  eveningShifts: number;       // Spät-Slots mit Schichtzeiten
  weekendRatio: number;        // weekendShifts / totalShiftsWorked (0 wenn keine Schichten)
  eveningRatio: number;        // eveningShifts / totalShiftsWorked (0 wenn keine Schichten)
  weeklyBreakdown: WeeklyHourRow[];
}

/**
 * Einzelner Fairness-Hinweis für den Planungsassistenten.
 */
export interface FairnessAlert {
  empId: string;
  empName: string;
  dept: 'service' | 'küche';
  type: 'weekend-overload' | 'evening-overload' | 'can-take-free';
  severity: 'high' | 'medium' | 'low';
  message: string;
  /** Detailtext (zweite Zeile) */
  detail?: string;
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

/**
 * Gruppiert Tage nach ISO-Woche.
 * Rückgabe: Map von weekStart (YYYY-MM-DD) → Tage in dieser Woche
 */
function groupByIsoWeek(days: Date[]): Map<string, Date[]> {
  const map = new Map<string, Date[]>();
  for (const day of days) {
    const ws = format(startOfISOWeek(day), 'yyyy-MM-dd');
    if (!map.has(ws)) map.set(ws, []);
    map.get(ws)!.push(day);
  }
  return map;
}

/**
 * Wochenlabel: "KW 12 (3.–9.3.)"
 */
function weekLabel(weekDays: Date[]): string {
  const kw = getISOWeek(weekDays[0]);
  const from = format(weekDays[0], 'd.M.', { locale: de });
  const to   = format(weekDays[weekDays.length - 1], 'd.M.', { locale: de });
  return `KW ${kw} (${from}–${to})`;
}

// ─── Hauptberechnungen ────────────────────────────────────────────────────────

/**
 * Berechnet Fairness-Kennzahlen und wöchentliche Stundenübersicht
 * für alle übergebenen Mitarbeiter.
 *
 * @param employees     Alle Mitarbeitenden (gefiltert nach Abt.)
 * @param scheduleData  Plan-Daten (empId-dateStr → DaySchedule)
 * @param displayDays   Angezeigte Tage
 * @param actualHoursData Ist-Stunden aus Mirus (empId-dateStr → { hours })
 */
export function computeShiftFairness(
  employees: Employee[],
  scheduleData: Record<string, DaySchedule>,
  displayDays: Date[],
  actualHoursData: Record<string, { hours: number }> = {},
): EmployeeShiftFairness[] {
  if (!displayDays.length || !employees.length) return [];

  const weekMap = groupByIsoWeek(displayDays);
  const weekEntries = Array.from(weekMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  const totalDaysInPeriod = displayDays.length;

  return employees.map(emp => {
    let totalShiftsWorked = 0;
    let weekendShifts = 0;
    let eveningShifts = 0;

    // Count shifts per day
    for (const day of displayDays) {
      const dateStr = format(day, 'yyyy-MM-dd');
      const ds = scheduleData[`${emp.id}-${dateStr}`];
      const isWE = isWeekend(day);

      const hasFrüh = ds && calcSlotHours(ds.früh) > 0 && !ds.frühAbsence;
      const hasSpät = ds && calcSlotHours(ds.spät) > 0 && !ds.spätAbsence;

      if (hasFrüh) {
        totalShiftsWorked++;
        if (isWE) weekendShifts++;
      }
      if (hasSpät) {
        totalShiftsWorked++;
        eveningShifts++;
        if (isWE) weekendShifts++;
      }
    }

    // Per-week breakdown
    const weeklyBreakdown: WeeklyHourRow[] = weekEntries.map(([ws, wDays]) => {
      let planned = 0;
      let actualSum = 0;
      let hasActual = false;

      for (const day of wDays) {
        const dateStr = format(day, 'yyyy-MM-dd');
        const ds = scheduleData[`${emp.id}-${dateStr}`];
        if (ds) {
          planned += netHours(ds);
        }
        const ah = actualHoursData[`${emp.id}-${dateStr}`]?.hours;
        if (ah !== undefined) {
          actualSum += ah;
          hasActual = true;
        }
      }

      const target = emp.weeklyHours ?? 0;
      const isoWeekNum = getISOWeek(wDays[0]);
      const label = weekLabel(wDays);

      return {
        weekStart: ws,
        weekLabel: label,
        weekNumber: isoWeekNum,
        daysInPeriod: wDays.map(d => format(d, 'yyyy-MM-dd')),
        targetHours: target,
        plannedHours: Math.round(planned * 10) / 10,
        actualHours: hasActual ? Math.round(actualSum * 10) / 10 : null,
        plannedDeviation: Math.round((planned - target) * 10) / 10,
        actualDeviation: hasActual ? Math.round((actualSum - target) * 10) / 10 : null,
        isPartialWeek: wDays.length < 7,
      };
    });

    return {
      empId: emp.id,
      empName: emp.name,
      dept: emp.department,
      totalShiftsWorked,
      weekendShifts,
      eveningShifts,
      weekendRatio: totalShiftsWorked > 0 ? weekendShifts / totalShiftsWorked : 0,
      eveningRatio:  totalShiftsWorked > 0 ? eveningShifts  / totalShiftsWorked : 0,
      weeklyBreakdown,
    };
  });
}

/**
 * Vergleicht pro Abteilung und erzeugt Hinweise für die Planungshilfe.
 *
 * Schwellenwerte:
 *   - Wochenend-Ratio > avg + 0.25  → Warnung
 *   - Abend-Ratio     > avg + 0.30  → Warnung (da Spät generell unbeliebter)
 *   - kann eher frei: WE- oder Abend-Overload UND cumBalance >= 0
 *
 * @param fairnessData    Ergebnis von computeShiftFairness
 * @param balanceMap      empId → cumulativeBalance (aus buildHourBalances)
 */
export function buildFairnessAlerts(
  fairnessData: EmployeeShiftFairness[],
  balanceMap: Record<string, number> = {},
): FairnessAlert[] {
  if (!fairnessData.length) return [];

  const avg = (arr: number[]) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

  const alerts: FairnessAlert[] = [];

  for (const dept of ['service', 'küche'] as const) {
    const group = fairnessData.filter(f => f.dept === dept && f.totalShiftsWorked > 0);
    if (group.length < 2) continue; // Vergleich erst ab 2 MA sinnvoll

    const avgWE  = avg(group.map(f => f.weekendRatio));
    const avgEve = avg(group.map(f => f.eveningRatio));

    for (const f of group) {
      const weOver  = f.weekendRatio - avgWE;
      const eveOver = f.eveningRatio - avgEve;
      const balance = balanceMap[f.empId] ?? null;

      if (weOver > 0.25) {
        const pct = Math.round(f.weekendRatio * 100);
        const avgPct = Math.round(avgWE * 100);
        alerts.push({
          empId: f.empId,
          empName: f.empName,
          dept: f.dept,
          type: 'weekend-overload',
          severity: weOver > 0.40 ? 'high' : 'medium',
          message: `${f.empName} hat überdurchschnittlich viele Wochenendschichten`,
          detail: `${pct} % Wochenendeinsatz (Ø ${avgPct} %)  · ${f.weekendShifts} von ${f.totalShiftsWorked} Schichten`,
        });
      }

      if (eveOver > 0.30) {
        const pct = Math.round(f.eveningRatio * 100);
        const avgPct = Math.round(avgEve * 100);
        alerts.push({
          empId: f.empId,
          empName: f.empName,
          dept: f.dept,
          type: 'evening-overload',
          severity: eveOver > 0.45 ? 'high' : 'medium',
          message: `${f.empName} hatte bereits viele Spätschichten`,
          detail: `${pct} % Spätschichten (Ø ${avgPct} %)  · ${f.eveningShifts} von ${f.totalShiftsWorked} Schichten`,
        });
      }

      // Can take free: above-average unpopular shifts AND balance is ok (not under-target)
      if ((weOver > 0.15 || eveOver > 0.20) && balance !== null && balance >= 0) {
        alerts.push({
          empId: f.empId,
          empName: f.empName,
          dept: f.dept,
          type: 'can-take-free',
          severity: 'low',
          message: `${f.empName} kann fairerweise eher einen freien Tag bekommen`,
          detail: `Überdurchschnittliche Belastung bei${weOver > 0.15 ? ' Wochenende' : ''}${weOver > 0.15 && eveOver > 0.20 ? ' und' : ''}${eveOver > 0.20 ? ' Spätschichten' : ''} — Saldo: ${balance >= 0 ? '+' : ''}${balance.toFixed(1)}h`,
        });
      }
    }
  }

  // Sort: high first, then medium, then low; alphabetically within same severity
  const sevOrder = { high: 0, medium: 1, low: 2 };
  alerts.sort((a, b) =>
    sevOrder[a.severity] !== sevOrder[b.severity]
      ? sevOrder[a.severity] - sevOrder[b.severity]
      : a.empName.localeCompare(b.empName, 'de'),
  );

  return alerts;
}

// ─── Hilfsfunktion für Farb-Klassen ──────────────────────────────────────────

export function deviationColorClass(deviation: number, tolerance = 1): string {
  if (Math.abs(deviation) <= tolerance)   return 'text-emerald-600 dark:text-emerald-400';
  if (deviation < -tolerance * 3)         return 'text-red-600 dark:text-red-400';
  if (deviation < 0)                      return 'text-amber-600 dark:text-amber-400';
  if (deviation > tolerance * 5)          return 'text-violet-600 dark:text-violet-400';
  return 'text-blue-600 dark:text-blue-400';
}

export function deviationSign(n: number): string {
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}
