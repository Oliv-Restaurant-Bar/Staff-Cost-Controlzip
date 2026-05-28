/**
 * Import-Qualitäts-Berechnung
 * ============================
 * Berechnet pro Datenfeld, wie viel Prozent erfolgreich erkannt wurden.
 * Wird nach dem Parsen einer Mirus-Datei aufgerufen und im JSONB-Feld
 * `parser_quality.qualityFields` der Import-Historie gespeichert.
 */

import type { ExcelEmployee, ExcelParseStats } from './mirus-excel-parser';

// ─── Typen ────────────────────────────────────────────────────────────────────

export interface QualityFieldEntry {
  key:      string;
  label:    string;
  detected: number;
  expected: number;
  percent:  number;
  missing:  string[];
  warnings: string[];
}

// ─── Helfer ───────────────────────────────────────────────────────────────────

function pct(detected: number, expected: number): number {
  if (expected === 0) return 100;
  return Math.round((detected / expected) * 100);
}

function field(
  key: string,
  label: string,
  detected: number,
  expected: number,
  missing: string[] = [],
  warnings: string[] = [],
): QualityFieldEntry {
  return { key, label, detected, expected, percent: pct(detected, expected), missing, warnings };
}

/** Prüft ob ein Absence-Code zu einer bestimmten Kategorie gehört */
function matchesAbsence(code: string | null, patterns: string[]): boolean {
  if (!code) return false;
  const lower = code.toLowerCase();
  return patterns.some(p => lower.includes(p));
}

// ─── Haupt-Funktion ───────────────────────────────────────────────────────────

export function computeImportQuality(
  employees: ExcelEmployee[],
  parseStats: ExcelParseStats,
): QualityFieldEntry[] {
  const n = employees.length;
  const fields: QualityFieldEntry[] = [];

  // ── 1. Mitarbeiter ─────────────────────────────────────────────────────────
  fields.push(field('employees', 'Mitarbeiter', n, n));

  // ── 2. Abteilung ───────────────────────────────────────────────────────────
  {
    const withDept    = employees.filter(e => e.department != null);
    const missingDept = employees.filter(e => e.department == null).map(e => e.name ?? '?');
    fields.push(field('departments', 'Abteilung', withDept.length, n, missingDept));
  }

  // ── 3. Arbeitsverhältnis ───────────────────────────────────────────────────
  {
    const withPeriod    = employees.filter(e => e.employmentPeriod != null);
    const missingPeriod = employees.filter(e => e.employmentPeriod == null).map(e => e.name ?? '?');
    fields.push(field('employment_period', 'Arbeitsverhältnis', withPeriod.length, n, missingPeriod));
  }

  // ── 4. Eintrittsdatum ──────────────────────────────────────────────────────
  {
    const dateRegex     = /\d{2}\.\d{2}\.\d{4}/;
    const withStart     = employees.filter(e => e.employmentPeriod && dateRegex.test(e.employmentPeriod));
    const missingStart  = employees
      .filter(e => !e.employmentPeriod || !dateRegex.test(e.employmentPeriod))
      .map(e => e.name ?? '?');
    fields.push(field('start_dates', 'Eintrittsdatum', withStart.length, n, missingStart));
  }

  // ── 5. Austrittsdatum (nur Mitarbeiter mit explizitem End-Datum) ───────────
  {
    const withEndDate = employees.filter(e => {
      if (!e.employmentPeriod) return false;
      const matches = e.employmentPeriod.match(/\d{2}\.\d{2}\.\d{4}/g);
      return matches != null && matches.length >= 2;
    });
    // expected = nur Mitarbeiter die ein Enddatum haben (= detected)
    fields.push(field('end_dates', 'Austrittsdatum', withEndDate.length, withEndDate.length));
  }

  // ── 6. Sollstunden (Wochenstunden) ────────────────────────────────────────
  {
    const withHours    = employees.filter(e => e.weeklyHours != null);
    const missingHours = employees.filter(e => e.weeklyHours == null).map(e => e.name ?? '?');
    fields.push(field('target_hours', 'Sollstunden', withHours.length, n, missingHours));
  }

  // ── 7. AZB Tagesstunden (totalHours pro Tag) ───────────────────────────────
  {
    let totalDaysWithDate = 0;
    let totalDaysWithHours = 0;
    const missingDays: string[] = [];
    for (const emp of employees) {
      for (const day of emp.days) {
        if (!day.date) continue;
        totalDaysWithDate++;
        if (day.totalHours != null) {
          totalDaysWithHours++;
        } else if (missingDays.length < 20) {
          missingDays.push(`${emp.name ?? '?'}: ${day.date}`);
        }
      }
    }
    fields.push(field('azb_daily_hours', 'AZB Tagesstunden', totalDaysWithHours, totalDaysWithDate, missingDays));
  }

  // ── 8. Zeitstempel / Zeitblöcke (shifts pro Arbeitstag) ───────────────────
  {
    let workingDays    = 0;
    let daysWithBlocks = 0;
    const missingBlocks: string[] = [];
    for (const emp of employees) {
      for (const day of emp.days) {
        if (!day.date || (day.totalHours ?? 0) <= 0) continue;
        workingDays++;
        if (day.shifts && day.shifts.length > 0) {
          daysWithBlocks++;
        } else if (missingBlocks.length < 20) {
          missingBlocks.push(`${emp.name ?? '?'}: ${day.date}`);
        }
      }
    }
    fields.push(field('time_blocks', 'Zeitstempel / Zeitblöcke', daysWithBlocks, workingDays, missingBlocks));
  }

  // ── 9. Pausen (breakMinutes pro Arbeitstag) ───────────────────────────────
  {
    let workingDays   = 0;
    let daysWithBreak = 0;
    const missingBreaks: string[] = [];
    for (const emp of employees) {
      for (const day of emp.days) {
        if (!day.date || (day.totalHours ?? 0) <= 0) continue;
        workingDays++;
        if (day.breakMinutes != null) {
          daysWithBreak++;
        } else if (missingBreaks.length < 10) {
          missingBreaks.push(`${emp.name ?? '?'}: ${day.date}`);
        }
      }
    }
    fields.push(field('breaks', 'Pausen', daysWithBreak, workingDays, missingBreaks));
  }

  // ── 10. Ferien-Tage (Abwesenheitstage mit Ferien-Code) ────────────────────
  {
    let vacDays = 0;
    for (const emp of employees)
      for (const day of emp.days)
        if (matchesAbsence(day.absenceCode, ['fe', 'ferie', 'ferien', 'urlaub'])) vacDays++;
    fields.push(field('vacation_days', 'Ferien-Tage', vacDays, vacDays));
  }

  // ── 11. Feiertage ─────────────────────────────────────────────────────────
  {
    let hdDays = 0;
    for (const emp of employees)
      for (const day of emp.days)
        if (matchesAbsence(day.absenceCode, ['feiertag', 'ft'])) hdDays++;
    fields.push(field('public_holidays', 'Feiertage', hdDays, hdDays));
  }

  // ── 12. Ferienguthaben (Saldo) ────────────────────────────────────────────
  {
    // expected = Mitarbeiter für die eine Ferien-Zeile gefunden wurde
    const vacExpected = n - parseStats.employeesMissingVacation.length;
    const vacDetected = parseStats.employeesWithVacationBalance;
    const vacMissing  = [
      ...parseStats.employeesMissingVacation.map(name => `${name} (Zeile fehlt)`),
      ...parseStats.employeesVacationRowFoundNoValue.map(name => `${name} (Wert nicht lesbar)`),
    ];
    fields.push(field(
      'vacation_balance',
      'Ferienguthaben',
      vacDetected,
      Math.max(vacExpected, 0),
      vacMissing,
    ));
  }

  // ── 13. Feiertagsguthaben ─────────────────────────────────────────────────
  {
    const holExpected = n - parseStats.employeesMissingHoliday.length;
    const holDetected = parseStats.employeesWithHolidayBalance;
    const holMissing  = [
      ...parseStats.employeesMissingHoliday.map(name => `${name} (Zeile fehlt)`),
      ...parseStats.employeesHolidayRowFoundNoValue.map(name => `${name} (Wert nicht lesbar)`),
    ];
    fields.push(field(
      'public_holiday_balance',
      'Feiertagsguthaben',
      holDetected,
      Math.max(holExpected, 0),
      holMissing,
    ));
  }

  // ── 14. Krankheit ─────────────────────────────────────────────────────────
  {
    let sickDays = 0;
    for (const emp of employees)
      for (const day of emp.days)
        if (matchesAbsence(day.absenceCode, ['kr', 'krank'])) sickDays++;
    fields.push(field('sick_days', 'Krankheit', sickDays, sickDays));
  }

  // ── 15. Unfall ────────────────────────────────────────────────────────────
  {
    let accDays = 0;
    for (const emp of employees)
      for (const day of emp.days)
        if (matchesAbsence(day.absenceCode, ['unfall'])) accDays++;
    fields.push(field('accident_days', 'Unfall', accDays, accDays));
  }

  // ── 16. Frei-Tage ─────────────────────────────────────────────────────────
  {
    let freeDays = 0;
    for (const emp of employees)
      for (const day of emp.days)
        if (matchesAbsence(day.absenceCode, ['fr', 'frei'])) freeDays++;
    fields.push(field('free_days', 'Frei-Tage', freeDays, freeDays));
  }

  // ── 17. Abwesenheiten total ────────────────────────────────────────────────
  {
    let totalAbsence = 0;
    for (const emp of employees)
      for (const day of emp.days)
        if (day.absenceCode) totalAbsence++;
    fields.push(field('absence_days_total', 'Abwesenheiten total', totalAbsence, totalAbsence));
  }

  return fields;
}

// ─── Gesamtstatus ─────────────────────────────────────────────────────────────

/** Berechnet den Gesamtstatus aus der Qualitätsliste. */
export function computeOverallStatus(qualityFields: QualityFieldEntry[]): 'ok' | 'warn' | 'error' {
  const qualityMetrics = qualityFields.filter(f =>
    !['vacation_days','public_holidays','sick_days','accident_days','free_days','absence_days_total','end_dates']
      .includes(f.key)
  );
  const minPct = Math.min(...qualityMetrics.map(f => f.percent));
  if (minPct >= 95) return 'ok';
  if (minPct >= 70) return 'warn';
  return 'error';
}

/** Summiert die Schlüsselmetriken als lesbaren String. */
export function summarizeQuality(qualityFields: QualityFieldEntry[]): string {
  const get = (key: string) => qualityFields.find(f => f.key === key);
  const parts: string[] = [];
  const emp  = get('employees');
  const azb  = get('azb_daily_hours');
  const blk  = get('time_blocks');
  const vac  = get('vacation_balance');
  const hol  = get('public_holiday_balance');
  if (emp) parts.push(`MA ${emp.detected}/${emp.expected}`);
  if (azb) parts.push(`AZB ${azb.percent}%`);
  if (blk) parts.push(`Stempel ${blk.percent}%`);
  if (vac) parts.push(`Ferien ${vac.percent}%`);
  if (hol) parts.push(`Feiertag ${hol.percent}%`);
  return parts.join(' · ');
}
