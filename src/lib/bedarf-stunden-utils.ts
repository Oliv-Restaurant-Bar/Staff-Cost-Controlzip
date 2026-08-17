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
 * ABSENZ-Stunden (reine Info): geplante Netto-Stunden EINES Mitarbeiters an
 * EINEM Datum — Basis für «Kranken-/Absenz-Stunden» an Absenztagen ohne
 * MIRUS-Ist. Nimmt die geplanten Zeiten AUCH dann, wenn der Plan selbst eine
 * Absenz-Marke trägt (die geplanten Zeiten sind die Info-Basis).
 * null, wenn keine Plan-Basis existiert (nie geraten, nie 0).
 */
export function absencePlanHoursForEmployeeDate(args: {
  scheduleData: Record<string, DaySchedule>;
  employeeId: string;
  dateStr: string;
}): number | null {
  const ds = args.scheduleData[`${args.employeeId}-${args.dateStr}`];
  if (!ds) return null;
  const slots: Array<{ start: string; end: string }> = [];
  if (ds.früh?.start && ds.früh?.end) slots.push({ start: ds.früh.start, end: ds.früh.end });
  if (ds.spät?.start && ds.spät?.end) slots.push({ start: ds.spät.start, end: ds.spät.end });
  if (slots.length === 0) return null;
  const h = r1(nettoMinutesForSlots(slots) / 60);
  return h > 0 ? h : null;
}

/**
 * Kanonischer Absenzcode (K/U/FE/F/FT) aus einem Ist-Eintrag; Legacy-Strings
 * («ferien», «krank», …) werden normalisiert, Unbekanntes ergibt null (skip).
 */
export function canonicalAbsenceCode(raw: string | undefined | null): 'K' | 'U' | 'FE' | 'F' | 'FT' | null {
  if (!raw) return null;
  const v = String(raw).trim().toUpperCase();
  if (v === 'K' || v === 'U' || v === 'FE' || v === 'F' || v === 'FT') return v;
  switch (v) {
    case 'FERIEN': case 'URLAUB': return 'FE';
    case 'KRANK': case 'KRANKHEIT': return 'K';
    case 'UNFALL': return 'U';
    case 'FEIERTAG': return 'FT';
    case 'FREI': return 'F';
    default: return null;
  }
}

/** Absenz-Stunden-Summe (Info) eines MA über einen Datumsbereich, nach Code. */
export interface AbsenceHoursInfo {
  total: number;
  byCode: Record<string, number>;
}

/**
 * Regel: NUR Tage mit kanonischem Ist-Absenzcode (K/U/FE/F/FT, Legacy-Strings
 * normalisiert, Unbekanntes übersprungen) UND hours EXAKT 0 (MIRUS > 0
 * überschreibt den Code ohnehin und zählt als echte Arbeit). Wert =
 * Plan-Netto-Stunden des Tages; ohne Plan-Basis wird der Tag übersprungen
 * (leer, nie geraten). STRIKT getrennt von produktiven Ist-Stunden.
 */
export function absenceInfoHoursForEmployee(args: {
  actualHours: Record<string, ActualHourEntry>;
  scheduleData: Record<string, DaySchedule>;
  employeeId: string;
  dates: string[];
}): AbsenceHoursInfo | null {
  let total = 0;
  const byCode: Record<string, number> = {};
  let any = false;
  for (const dateStr of args.dates) {
    const e = args.actualHours[`${args.employeeId}-${dateStr}`];
    const code = canonicalAbsenceCode(e?.absenceType);
    if (!code) continue;
    const ist = Number(e!.hours);
    if (!(Number.isFinite(ist) && ist === 0)) continue;
    const h = absencePlanHoursForEmployeeDate({
      scheduleData: args.scheduleData, employeeId: args.employeeId, dateStr,
    });
    if (h == null) continue;
    total += h;
    byCode[code] = r1((byCode[code] ?? 0) + h);
    any = true;
  }
  return any ? { total: r1(total), byCode } : null;
}

/** Absenzcodes mit Stunden-Anrechnung für FIX-MA (Monatslohn). F = 0. */
export const KREDIT_ABSENZ_CODES_FIX: ReadonlySet<string> = new Set(['K', 'U', 'FE', 'FT']);
/** Absenzcodes mit Stunden-Anrechnung für FLEX-MA (Stundenlohn): nur K/U. */
export const KREDIT_ABSENZ_CODES_FLEX: ReadonlySet<string> = new Set(['K', 'U']);

/** Kredit-Codes je Mitarbeitertyp (Fix = Monatslohn, Flex = Stundenlohn). */
export function kreditAbsenzCodes(isFix: boolean): ReadonlySet<string> {
  return isFix ? KREDIT_ABSENZ_CODES_FIX : KREDIT_ABSENZ_CODES_FLEX;
}

/**
 * ABSENZ-ANRECHNUNG (Spec 08/2026, final mit Fix/Flex-Unterscheidung):
 * OHNE MIRUS-Ist (hours exakt 0) zählen die PLAN-Netto-Stunden des Tages als
 * «angerechnete Stunden» (Pensum/Soll-Ist, Überstunden-Saldo, Personalkosten):
 * - K (Krank), U (Unfall): für FIX UND FLEX.
 * - FE (Ferien), FT (Feiertag): NUR für FIX-MA (Monatslohn); Flex/Stundenlohn
 *   → keine Anrechnung, keine Stunden, keine Kosten.
 * - F (Frei): immer 0.
 * NIE in der Produktivität (Nenner bleibt istHoursForDate = nur echte Arbeit).
 * MIRUS > 0 überschreibt den Code → echte Arbeitsstunden, kein Kredit.
 */
export function absenzKreditHoursForEmployeeDate(args: {
  actualHours: Record<string, ActualHourEntry>;
  scheduleData: Record<string, DaySchedule>;
  employeeId: string;
  dateStr: string;
  /** true = Fix-MA (Monatslohn) → K/U/FE/FT; false = Flex → nur K/U. */
  isFix: boolean;
}): number | null {
  const e = args.actualHours[`${args.employeeId}-${args.dateStr}`];
  const code = canonicalAbsenceCode(e?.absenceType);
  if (!code || !kreditAbsenzCodes(args.isFix).has(code)) return null;
  const ist = Number(e!.hours);
  if (!(Number.isFinite(ist) && ist === 0)) return null;
  return absencePlanHoursForEmployeeDate({
    scheduleData: args.scheduleData, employeeId: args.employeeId, dateStr: args.dateStr,
  });
}

/** Σ Absenz-Kredit-Stunden (K/U/FE/FT) eines MA über einen Datumsbereich (0 = keine). */
export function absenzKreditHoursForEmployee(args: {
  actualHours: Record<string, ActualHourEntry>;
  scheduleData: Record<string, DaySchedule>;
  employeeId: string;
  dates: string[];
  /** true = Fix-MA (Monatslohn) → K/U/FE/FT; false = Flex → nur K/U. */
  isFix: boolean;
}): number {
  let sum = 0;
  for (const dateStr of args.dates) {
    const h = absenzKreditHoursForEmployeeDate({ ...args, dateStr });
    if (h != null) sum += h;
  }
  return r1(sum);
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
