/**
 * bedarf-stunden-utils.ts
 * =======================
 * Gestapelte Stundenwerte «Bedarf → Dienstplan → Ist» (reine Funktionen).
 *
 * Hierarchie (Anzeige-Konvention überall gleich):
 *  1. BEDARF-Stunden (Soll)  — Leitplanke, aus dem Personalbedarf
 *     (Soll-Schichten, netto mit ArG-Pausenstaffel — nettoSegmentMinutes).
 *  2. DIENSTPLAN-Plan-Stunden — gespeicherter Dienstplan, netto mit ArG
 *     (nettoMinutesForSlots über die geplanten Einsätze).
 *  3. IST-Stunden (MIRUS)     — gestempelte Stunden; OHNE Datenquelle bleibt
 *     der Wert null (nie 0 anzeigen).
 *
 * Bedarf pro DATUM: aktives Profil via resolveActiveProfileForDate, effektiver
 * Bedarf via buildEffectiveRequirements (eventOpen=false — Tages-Event-Flags
 * werden hier wie in der Wochenübersicht bewusst nicht einbezogen).
 */

import type { Position } from '@/types/positions';
import type { StaffingRequirement } from '@/types/staffing';
import type { Employee } from '@/types/personnel';
import type { DaySchedule, ActualHourEntry } from '@/lib/supabase-db';
import { nettoSegmentMinutes, nettoMinutesForSlots } from '@/lib/staffing-check-utils';
import { buildRequirementMatrix } from '@/lib/staffing-requirements-utils';
import {
  buildEffectiveRequirements,
  resolveActiveProfileForDate,
  type StaffingProfilesConfig,
} from '@/lib/staffing-profiles-utils';
import { buildPlannedEmployees } from '@/lib/staffing-comparison-utils';

const r1 = (v: number) => Math.round(v * 10) / 10;

/** ISO-Wochentag (1=Mo … 7=So) eines yyyy-MM-dd-Datums (lokale Zeit). */
export function isoWeekdayOf(dateStr: string): number {
  const d = new Date(`${dateStr}T12:00:00`);
  const wd = d.getDay(); // 0=So … 6=Sa
  return wd === 0 ? 7 : wd;
}

/**
 * BEDARF-Netto-Stunden für EIN Datum: aktives Profil des Datums, effektiver
 * Bedarf des Wochentags, Σ nettoSegmentMinutes × Anzahl über alle Soll-Blöcke.
 * Konsistent mit den Tages-Summen der Soll-Wochenübersicht (gleiche Filterung
 * über buildRequirementMatrix: nur aktive Positionen).
 */
export function bedarfNettoHoursForDate(args: {
  positions: Position[];
  requirements: StaffingRequirement[];
  config: StaffingProfilesConfig;
  dateStr: string;
}): number {
  const { positions, requirements, config, dateStr } = args;
  const date = new Date(`${dateStr}T12:00:00`);
  const season = resolveActiveProfileForDate(config, date);
  const weekday = isoWeekdayOf(dateStr);
  const effective = buildEffectiveRequirements({
    requirements, config, season, weekday, eventOpen: false,
  });
  const matrix = buildRequirementMatrix(positions, effective, season, weekday);
  let minutes = 0;
  for (const dept of matrix) {
    for (const area of dept.areas) {
      for (const pr of area.positions) {
        for (const s of pr.shifts) {
          const count = Number.isFinite(s.requiredCount) ? s.requiredCount : 0;
          minutes += nettoSegmentMinutes(s.shiftStart, s.shiftEnd) * count;
        }
      }
    }
  }
  return r1(minutes / 60);
}

/**
 * BEDARF-Netto-Stunden über einen Datumsbereich (Summe der Tageswerte).
 * null, wenn GAR KEIN Tag Bedarf hat (Bedarf noch nicht erfasst).
 */
export function bedarfNettoHoursForDates(args: {
  positions: Position[];
  requirements: StaffingRequirement[];
  config: StaffingProfilesConfig;
  dates: string[];
}): number | null {
  let sum = 0;
  let any = false;
  for (const dateStr of args.dates) {
    const h = bedarfNettoHoursForDate({ ...args, dateStr });
    if (h > 0) any = true;
    sum += h;
  }
  return any ? r1(sum) : null;
}

/**
 * DIENSTPLAN-Plan-Netto-Stunden für EIN Datum aus dem gespeicherten Plan
 * (Absenzen zählen nicht; ArG-Pausenstaffel je Einsatz-Segment).
 * null, wenn an dem Tag NIEMAND eingeplant ist (leer, nicht 0).
 */
export function planNettoHoursForDate(args: {
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  positions: Position[];
  dateStr: string;
}): number | null {
  const planned = buildPlannedEmployees(
    args.employees, args.scheduleData, args.positions, args.dateStr,
  );
  if (planned.length === 0) return null;
  let minutes = 0;
  for (const p of planned) minutes += nettoMinutesForSlots(p.slots);
  return r1(minutes / 60);
}

/**
 * DIENSTPLAN-Plan-Netto-Stunden über einen Datumsbereich (Summe der Tage mit
 * Planung). null, wenn an KEINEM Tag jemand eingeplant ist (leer, nie 0).
 */
export function planNettoHoursForDates(args: {
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  positions: Position[];
  dates: string[];
}): number | null {
  let sum = 0;
  let any = false;
  for (const dateStr of args.dates) {
    const h = planNettoHoursForDate({ ...args, dateStr });
    if (h != null) { sum += h; any = true; }
  }
  return any ? r1(sum) : null;
}

/**
 * IST-Stunden (gestempelt/MIRUS) für EIN Datum: Σ hours der actual-hours-
 * Einträge des Tages, OHNE Absenz-Einträge (absenceType) — analog zur
 * Overtime-/Ist-Analytik. null, wenn für den Tag KEIN Eintrag existiert
 * (kein Import ⇒ leer, nie 0).
 */
export function istHoursForDate(
  actualHours: Record<string, ActualHourEntry>,
  dateStr: string,
): number | null {
  const suffix = `-${dateStr}`;
  let sum = 0;
  let any = false;
  for (const [key, entry] of Object.entries(actualHours)) {
    if (!key.endsWith(suffix)) continue;
    if (entry.absenceType) continue;
    const h = Number(entry.hours);
    if (!Number.isFinite(h)) continue;
    sum += h;
    any = true;
  }
  return any ? r1(sum) : null;
}

/**
 * IST-Stunden über einen Datumsbereich. null, wenn KEIN Tag Einträge hat
 * (kein Import ⇒ leer, nie 0).
 */
export function istHoursForDates(
  actualHours: Record<string, ActualHourEntry>,
  dates: string[],
): number | null {
  let sum = 0;
  let any = false;
  for (const dateStr of dates) {
    const h = istHoursForDate(actualHours, dateStr);
    if (h != null) { sum += h; any = true; }
  }
  return any ? r1(sum) : null;
}

/**
 * Differenz zum Bedarf formatieren: '+2.5' / '−1.0' (de-CH-Minus) oder null,
 * wenn eine Seite fehlt. Positiv = ÜBER Bedarf (rot), ≤ 0 = grün.
 */
export function diffToBedarf(value: number | null, bedarf: number | null): number | null {
  if (value == null || bedarf == null) return null;
  return r1(value - bedarf);
}
