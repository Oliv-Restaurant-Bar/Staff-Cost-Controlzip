/**
 * wage-history.ts
 * ===============
 * Lohnhistorie-Bibliothek — liest und schreibt Lohneinträge
 * aus der employee_wages Supabase-Tabelle.
 *
 * KERNPRINZIP:
 *   - Bestehende Löhne (hourly_wage in employees-Tabelle) werden NICHT geändert.
 *   - Neue Lohneinträge werden als separate Zeilen in employee_wages gespeichert.
 *   - getEffectiveWage() gibt den richtigen Lohn für ein gegebenes Datum zurück.
 *   - Fallback: wenn keine Historie vorhanden → bestehenden employees.hourly_wage verwenden.
 *
 * Debug-Logs:
 *   [WAGE-HISTORY] employee: ...
 *   [WAGE-HISTORY] date: ...
 *   [WAGE-HISTORY] selected wage: ...
 *   [WAGE-HISTORY] source: history/fallback
 *
 * SQL-Migration: supabase/migrations/20260430_employee_wages.sql
 */

import { supabase } from '@/integrations/supabase/client';
import type { Employee } from '@/types/personnel';

// ── Typen ─────────────────────────────────────────────────────────────────────

export interface WageEntry {
  id:                    string;
  employeeId:            string;
  restaurantId:          string;     // 'oliv' | 'beaulieu'
  validFrom:             string;     // YYYY-MM-DD
  hourlyWage:            number;
  monthlySalary:         number;
  monthlySalaryWith13th: number;
  salary13:              boolean;
  notes:                 string;
  createdAt:             string;
}

export interface EffectiveWage {
  hourlyWage:             number;
  monthlySalary?:         number;
  monthlySalaryWith13th?: number;
  salary13:               boolean;
  source:                 'history' | 'fallback';
  validFrom?:             string;    // nur wenn source = 'history'
  /**
   * Lohntyp des Eintrags: 'hourly' = reine Stundenlohn-Phase (monthly_salary=0),
   * 'monthly' = Monatslohn-Phase. Wichtig: eine 'hourly'-Phase muss einen
   * allfälligen Monatslohn auf dem Employee-Stammsatz VERDRÄNGEN (auf 0 setzen),
   * sonst zählt der MA in dieser Phase fälschlich als Fix-MA.
   */
  wageType:               'hourly' | 'monthly' | 'none';
}

export interface NewWageEntry {
  employeeId:            string;
  restaurantId:          string;
  validFrom:             string;     // YYYY-MM-DD
  hourlyWage?:           number;
  monthlySalary?:        number;
  monthlySalaryWith13th?: number;
  salary13?:             boolean;
  notes?:                string;
  createdBy?:            string;     // E-Mail des eingeloggten Benutzers
}

// ── DB → App Mapping ──────────────────────────────────────────────────────────

function rowToEntry(row: Record<string, unknown>): WageEntry {
  return {
    id:                    String(row.id),
    employeeId:            String(row.employee_id),
    restaurantId:          String(row.restaurant_id),
    validFrom:             String(row.valid_from),
    hourlyWage:            Number(row.hourly_wage) || 0,
    monthlySalary:         Number(row.monthly_salary) || 0,
    monthlySalaryWith13th: Number(row.monthly_salary_with_13th) || 0,
    salary13:              Boolean(row.salary_13),
    notes:                 String(row.notes ?? ''),
    createdAt:             String(row.created_at),
  };
}

// ── Lesen ─────────────────────────────────────────────────────────────────────

/**
 * Lohnhistorie für einen Mitarbeiter laden.
 * Sortiert: neueste zuerst.
 */
export async function getWageHistory(
  employeeId:   string,
  restaurantId: string,
): Promise<WageEntry[]> {
  try {
    const { data, error } = await (supabase as any)
      .from('employee_wages')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('restaurant_id', restaurantId)
      .order('valid_from', { ascending: false });

    if (error || !data) return [];
    return (data as Record<string, unknown>[]).map(rowToEntry);
  } catch {
    return [];
  }
}

/**
 * Effektiver Lohn für einen Mitarbeiter an einem bestimmten Datum.
 *
 * Logik: Letzter Eintrag mit valid_from <= date.
 * Fallback: null (Aufrufer soll dann emp.hourlyWage verwenden).
 */
export async function getEffectiveWage(
  employeeId:   string,
  date:         string, // YYYY-MM-DD
  restaurantId: string,
): Promise<EffectiveWage | null> {
  try {
    const { data, error } = await (supabase as any)
      .from('employee_wages')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('restaurant_id', restaurantId)
      .lte('valid_from', date)
      .order('valid_from', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    const entry = rowToEntry(data as Record<string, unknown>);

    console.log(`[WAGE-HISTORY] employee: ${employeeId} | date: ${date} | selected wage: ${entry.hourlyWage || entry.monthlySalary} | source: history`);

    return {
      hourlyWage:             entry.hourlyWage,
      monthlySalary:          entry.monthlySalary  || undefined,
      monthlySalaryWith13th:  entry.monthlySalaryWith13th || undefined,
      salary13:               entry.salary13,
      source:                 'history',
      validFrom:              entry.validFrom,
      wageType:               wageType(entry),
    };
  } catch {
    return null;
  }
}

/**
 * Effektive Löhne für mehrere Mitarbeiter auf einmal.
 * Effizienter als N Einzelabfragen.
 *
 * Gibt eine Map zurück: employeeId → EffectiveWage
 */
export async function getEffectiveWageBatch(
  employeeIds:  string[],
  date:         string, // YYYY-MM-DD
  restaurantId: string,
): Promise<Record<string, EffectiveWage>> {
  if (employeeIds.length === 0) return {};

  try {
    // Alle Einträge für diese Tenant bis zum gewünschten Datum holen
    const { data, error } = await (supabase as any)
      .from('employee_wages')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .in('employee_id', employeeIds)
      .lte('valid_from', date)
      .order('valid_from', { ascending: false }); // neueste zuerst

    if (error || !data) return {};

    const entries = (data as Record<string, unknown>[]).map(rowToEntry);

    // Pro Mitarbeiter: ersten (= neuesten gültigen) Eintrag nehmen
    const result: Record<string, EffectiveWage> = {};
    for (const entry of entries) {
      if (result[entry.employeeId]) continue; // bereits gefunden (neuester)
      result[entry.employeeId] = {
        hourlyWage:            entry.hourlyWage,
        monthlySalary:         entry.monthlySalary  || undefined,
        monthlySalaryWith13th: entry.monthlySalaryWith13th || undefined,
        salary13:              entry.salary13,
        source:                'history',
        validFrom:             entry.validFrom,
        wageType:              wageType(entry),
      };
    }

    console.log(`[WAGE-HISTORY] batch: ${restaurantId} | date: ${date} | ${Object.keys(result).length}/${employeeIds.length} mit Historie`);
    return result;
  } catch {
    return {};
  }
}

/**
 * Employee-Array mit effektiven Löhnen anreichern.
 *
 * Ändert die hourlyWage, monthlySalary, monthlySalaryWith13th Felder
 * auf dem Employee-Objekt entsprechend dem Datum.
 * Fallback: bestehendes emp.hourlyWage bleibt unverändert.
 *
 * Bestehende employees-Tabellen-Daten werden NICHT verändert.
 */
export async function applyEffectiveWages(
  employees:    Employee[],
  date:         string, // YYYY-MM-DD
  restaurantId: string,
): Promise<Employee[]> {
  const ids = employees.map(e => String(e.id));
  const wageMap = await getEffectiveWageBatch(ids, date, restaurantId);

  return employees.map(emp => {
    const effective = wageMap[String(emp.id)];

    if (!effective) {
      // Fallback: bestehender Lohn unverändert
      console.log(`[WAGE-HISTORY] employee: ${emp.id} | date: ${date} | source: fallback | wage: ${emp.hourlyWage}`);
      return emp;
    }

    // History-Wert anwenden
    console.log(`[WAGE-HISTORY] employee: ${emp.id} | date: ${date} | selected wage: ${effective.hourlyWage || effective.monthlySalary} | source: history | valid_from: ${effective.validFrom} | type: ${effective.wageType}`);

    if (effective.wageType === 'hourly') {
      // Reine Stundenlohn-Phase: Monatslohn des Stammsatzes VERDRÄNGEN (auf 0),
      // sonst würde der MA in dieser Phase weiterhin als Fix-MA (Monatslohn)
      // gerechnet (z.B. Wechsel Stundenlohn → Monatslohn per Stichtag: Monate
      // VOR dem Stichtag müssen Stundenlohn rechnen).
      return {
        ...emp,
        contractType:          'hourly',
        hourlyWage:            effective.hourlyWage,
        monthlySalary:         0,
        monthlySalaryWith13th: 0,
      };
    }

    // Monatslohn-Phase (oder leerer Eintrag → bestehende Werte als Fallback)
    return {
      ...emp,
      hourlyWage:            effective.hourlyWage            || emp.hourlyWage,
      monthlySalary:         effective.monthlySalary         ?? emp.monthlySalary,
      monthlySalaryWith13th: effective.monthlySalaryWith13th ?? emp.monthlySalaryWith13th,
    };
  });
}

// ── Monats-Auflösung (FIX/FLEX nach aktiver Vertragsphase des Monats) ────────

/**
 * Phasenwechsel Stundenlohn ↔ Monatslohn INNERHALB eines Monats.
 * Tage-Anteile für die pro-rata-Aufteilung FIX/FLEX.
 */
export interface MonthWageSplit {
  monthly:          EffectiveWage;
  hourly:           EffectiveWage;
  monthlyFrom:      string;  // YYYY-MM-DD (innerhalb des Monats)
  monthlyTo:        string;
  hourlyFrom:       string;
  hourlyTo:         string;
  monthlyFraction:  number;  // Tage-Anteil Monatslohn-Phase (0..1)
  hourlyFraction:   number;  // Tage-Anteil Stundenlohn-Phase (0..1)
}

export interface MonthWageResolution {
  /** Massgebende Phase des Monats (bei Split: die Monatslohn-Phase). */
  wage:   EffectiveWage;
  /** Nur gesetzt, wenn die Lohnart mitten im Monat wechselt. */
  split?: MonthWageSplit;
}

function lastOfMonth(year: number, month: number): string {
  const d = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function entryToEffective(entry: WageEntry): EffectiveWage {
  return {
    hourlyWage:            entry.hourlyWage,
    monthlySalary:         entry.monthlySalary || undefined,
    monthlySalaryWith13th: entry.monthlySalaryWith13th || undefined,
    salary13:              entry.salary13,
    source:                'history',
    validFrom:             entry.validFrom,
    wageType:              wageType(entry),
  };
}

/**
 * Lohnart-Auflösung PRO ANZEIGEMONAT (Single Source of Truth für FIX/FLEX).
 *
 * Regeln:
 * - Massgebend ist die am Monatsersten aktive Historie-Phase.
 * - Backfill: existiert KEINE Phase vor dem Monatsersten, aber eine Phase, die
 *   IM Monat beginnt und die früheste Historie überhaupt ist, gilt sie ab
 *   Monatsbeginn (die erste Zeile markiert den Beginn der ERFASSUNG, nicht
 *   einen echten Wechsel).
 * - Wechselt die LOHNART (hourly ↔ monthly) mitten im Monat, wird ein Split
 *   mit Datumsbereichen + Tage-Anteilen zurückgegeben (erster Wechsel zählt).
 * - Keine Historie bis Monatsende → kein Eintrag in der Map (Aufrufer nutzt
 *   den employees-Stammsatz als Fallback).
 */
export async function getMonthWageResolutionBatch(
  employeeIds:  string[],
  year:         number,
  month:        number,
  restaurantId: string,
): Promise<Record<string, MonthWageResolution>> {
  if (employeeIds.length === 0) return {};
  const monthStart = firstOfMonth(year, month);
  const monthEnd   = lastOfMonth(year, month);

  let rows: Record<string, unknown>[] = [];
  try {
    const { data, error } = await (supabase as any)
      .from('employee_wages')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .in('employee_id', employeeIds)
      .lte('valid_from', monthEnd)
      .order('valid_from', { ascending: true });
    if (error || !data) return {};
    rows = data as Record<string, unknown>[];
  } catch {
    return {};
  }

  const byEmp: Record<string, WageEntry[]> = {};
  for (const row of rows) {
    const e = rowToEntry(row);
    (byEmp[e.employeeId] ||= []).push(e); // bereits aufsteigend sortiert
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  const result: Record<string, MonthWageResolution> = {};

  for (const [empId, entries] of Object.entries(byEmp)) {
    // Am Monatsersten aktive Phase (letzter Eintrag mit valid_from <= monthStart)
    const atStart = [...entries].reverse().find(e => e.validFrom <= monthStart) ?? null;
    const inMonth = entries.filter(e => e.validFrom > monthStart && e.validFrom <= monthEnd);

    // Backfill: keine Phase vor Monatsbeginn → früheste In-Monats-Phase gilt ab Monatsbeginn
    const startEntry = atStart ?? inMonth.shift() ?? null;
    if (!startEntry) continue;

    const startType = wageType(startEntry);
    // Erster LOHNART-Wechsel im Monat (Wertänderungen gleicher Art sind kein Split)
    const change = inMonth.find(e => wageType(e) !== startType && wageType(e) !== 'none');

    if (!change || startType === 'none') {
      result[empId] = { wage: entryToEffective(startEntry) };
      console.log(`[WAGE-MONTH] employee: ${empId} | monat: ${year}-${String(month).padStart(2, '0')} | lohnart: ${startType} | quelle: phase (valid_from ${startEntry.validFrom}${atStart ? '' : ', backfill ab Monatsbeginn'})`);
      continue;
    }

    // Split: Tag des Wechsels
    const changeDay   = parseInt(change.validFrom.slice(8, 10), 10);
    const firstDays   = changeDay - 1;              // Tage der Start-Phase
    const secondDays  = daysInMonth - firstDays;    // Tage der Wechsel-Phase
    const dayBefore   = `${year}-${String(month).padStart(2, '0')}-${String(changeDay - 1).padStart(2, '0')}`;

    const first  = entryToEffective(startEntry);
    const second = entryToEffective(change);
    const monthlyFirst = startType === 'monthly';

    const split: MonthWageSplit = monthlyFirst
      ? {
          monthly: first,  hourly: second,
          monthlyFrom: monthStart, monthlyTo: dayBefore,
          hourlyFrom: change.validFrom, hourlyTo: monthEnd,
          monthlyFraction: firstDays / daysInMonth,
          hourlyFraction:  secondDays / daysInMonth,
        }
      : {
          monthly: second, hourly: first,
          monthlyFrom: change.validFrom, monthlyTo: monthEnd,
          hourlyFrom: monthStart, hourlyTo: dayBefore,
          monthlyFraction: secondDays / daysInMonth,
          hourlyFraction:  firstDays / daysInMonth,
        };

    result[empId] = { wage: split.monthly, split };
    console.log(`[WAGE-MONTH] employee: ${empId} | monat: ${year}-${String(month).padStart(2, '0')} | lohnart: SPLIT (${startType} → ${wageType(change)} ab ${change.validFrom}) | quelle: phase`);
  }

  return result;
}

/**
 * Employees mit der im ANZEIGEMONAT aktiven Vertragsphase anreichern
 * (Monats-Variante von applyEffectiveWages, plus Split-Infos).
 *
 * - Voll-Monatslohn-Monat  → Monatslohn-Werte, Stundenlohn/Stammsatz verdrängt nicht.
 * - Voll-Stundenlohn-Monat → hourlyWage gesetzt, Monatslohn VERDRÄNGT (0) → FLEX.
 * - Phasenwechsel im Monat → Employee erhält die Monatslohn-Werte (FIX-Seite);
 *   der Aufrufer teilt pro rata über die zurückgegebene splits-Map auf.
 * - Ohne Historie → Stammsatz unverändert (Fallback, wird geloggt).
 */
export async function applyEffectiveWagesForMonth(
  employees:    Employee[],
  year:         number,
  month:        number,
  restaurantId: string,
): Promise<{ employees: Employee[]; splits: Record<string, MonthWageSplit> }> {
  const ids = employees.map(e => String(e.id));
  const resMap = await getMonthWageResolutionBatch(ids, year, month, restaurantId);

  const splits: Record<string, MonthWageSplit> = {};
  const enriched = employees.map(emp => {
    const res = resMap[String(emp.id)];
    if (!res) {
      console.log(`[WAGE-MONTH] employee: ${emp.id} | monat: ${year}-${String(month).padStart(2, '0')} | lohnart: ${(emp.monthlySalary ?? 0) > 0 ? 'monthly' : 'hourly'} | quelle: fallback (employees-Stammsatz)`);
      return emp;
    }
    if (res.split) splits[String(emp.id)] = res.split;

    const w = res.wage;
    if (w.wageType === 'hourly') {
      // Reine Stundenlohn-Phase: Monatslohn des Stammsatzes verdrängen → FLEX
      return {
        ...emp,
        contractType:          'hourly' as const,
        hourlyWage:            w.hourlyWage,
        monthlySalary:         0,
        monthlySalaryWith13th: 0,
      };
    }
    // Monatslohn-Phase (inkl. Split: FIX-Seite)
    return {
      ...emp,
      contractType:          'monthly' as const,
      hourlyWage:            w.hourlyWage            || emp.hourlyWage,
      monthlySalary:         w.monthlySalary         ?? emp.monthlySalary,
      monthlySalaryWith13th: w.monthlySalaryWith13th ?? emp.monthlySalaryWith13th,
    };
  });

  return { employees: enriched, splits };
}

// ── Schreiben ─────────────────────────────────────────────────────────────────

/**
 * Neuen Lohneintrag hinzufügen.
 * Bestehende Einträge werden NIEMALS geändert.
 *
 * Fehlerbehandlung:
 *   - "created_by column not found" → Spalte fehlt; Retry ohne created_by.
 *     Migration 20260509_employee_wages_created_by.sql für Audit-Trail ausführen.
 *   - "permission denied"           → Migration 20260508_employee_wages_fix_rls.sql ausführen.
 *   - "relation does not exist"     → Migration 20260430_employee_wages.sql ausführen.
 */
export async function addWageEntry(
  entry: NewWageEntry,
): Promise<{ error: string | null; userMessage: string | null }> {
  // Basis-Payload (immer vorhanden)
  const baseRow: Record<string, unknown> = {
    employee_id:              entry.employeeId,
    restaurant_id:            entry.restaurantId,
    valid_from:               entry.validFrom,
    hourly_wage:              entry.hourlyWage             ?? 0,
    monthly_salary:           entry.monthlySalary          ?? 0,
    monthly_salary_with_13th: entry.monthlySalaryWith13th  ?? 0,
    salary_13:                entry.salary13               ?? false,
    notes:                    entry.notes                  ?? '',
  };

  const doInsert = async (includeCreatedBy: boolean) => {
    const row = includeCreatedBy && entry.createdBy
      ? { ...baseRow, created_by: entry.createdBy }
      : { ...baseRow };
    return (supabase as any).from('employee_wages').insert(row);
  };

  const handleError = (error: { code?: string; message?: string; details?: string; hint?: string }) => {
    console.error('[WAGE-HISTORY] addWageEntry Fehler:', {
      code:    error.code,
      message: error.message,
      details: error.details,
      hint:    error.hint,
      entry:   { employeeId: entry.employeeId, restaurantId: entry.restaurantId, validFrom: entry.validFrom },
    });

    const msg = error.message ?? '';

    if (msg.includes('permission denied') || error.code === '42501') {
      return {
        error:       msg,
        userMessage: 'Lohneintrag konnte wegen fehlender Berechtigung nicht gespeichert werden. Bitte Administrator kontaktieren (Supabase-Migration 20260508_employee_wages_fix_rls.sql ausführen).',
      };
    }
    if (msg.includes('relation') && msg.includes('does not exist')) {
      return {
        error:       msg,
        userMessage: 'Tabelle employee_wages fehlt in der Datenbank. Bitte Migration 20260430_employee_wages.sql im Supabase SQL-Editor ausführen.',
      };
    }
    if (msg.includes('duplicate') || error.code === '23505') {
      return {
        error:       msg,
        userMessage: `Für das Datum ${entry.validFrom} existiert bereits ein Lohneintrag. Bitte ein anderes Datum wählen.`,
      };
    }
    return {
      error:       msg,
      userMessage: `Speichern fehlgeschlagen: ${msg}`,
    };
  };

  try {
    // Versuch 1: mit created_by (voller Audit-Trail)
    let { error } = await doInsert(true);

    // Falls created_by-Spalte fehlt → Retry ohne created_by (Graceful Degradation)
    // Die Spalte wird durch Migration 20260509_employee_wages_created_by.sql hinzugefügt.
    if (error) {
      const msg = error.message ?? '';
      const isCreatedByMissing =
        msg.includes('created_by') ||
        msg.includes('schema cache') ||
        (msg.includes('column') && msg.includes('does not exist') && msg.includes('created_by'));

      if (isCreatedByMissing) {
        console.warn(
          '[WAGE-HISTORY] Spalte created_by fehlt → Retry ohne Audit-Feld.\n' +
          '  Für vollständigen Audit-Trail bitte ausführen:\n' +
          '  supabase/migrations/20260509_employee_wages_created_by.sql',
        );
        const retry = await doInsert(false);
        error = retry.error;
      }
    }

    if (error) {
      return handleError(error);
    }

    console.log(
      `[WAGE-HISTORY] addWageEntry OK | employee: ${entry.employeeId}` +
      ` | validFrom: ${entry.validFrom}` +
      ` | wage: ${entry.hourlyWage || entry.monthlySalary}` +
      ` | createdBy: ${entry.createdBy ?? '–'}`,
    );
    return { error: null, userMessage: null };

  } catch (e) {
    const msg = String(e);
    console.error('[WAGE-HISTORY] addWageEntry Exception:', msg);
    return { error: msg, userMessage: `Unerwarteter Fehler: ${msg}` };
  }
}

/**
 * Lohneintrag löschen (anhand der ID).
 */
export async function deleteWageEntry(
  id: string,
): Promise<{ error: string | null }> {
  try {
    const { error } = await (supabase as any)
      .from('employee_wages')
      .delete()
      .eq('id', id);
    if (error) return { error: error.message };
    console.log(`[WAGE-HISTORY] deleteWageEntry OK | id: ${id}`);
    return { error: null };
  } catch (e) {
    return { error: String(e) };
  }
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

/** Formatiert ein Datum als YYYY-MM-DD */
export function toIsoDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/** Ersten Tag des Monats als YYYY-MM-DD */
export function firstOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/** Lohntyp ermitteln: stundenlohn vs monatslohn */
export function wageType(entry: Pick<WageEntry, 'hourlyWage' | 'monthlySalary'>): 'hourly' | 'monthly' | 'none' {
  if ((entry.monthlySalary ?? 0) > 0) return 'monthly';
  if ((entry.hourlyWage ?? 0) > 0)    return 'hourly';
  return 'none';
}

/** Formatiert einen Lohn als CHF-String */
export function formatWage(entry: Pick<WageEntry, 'hourlyWage' | 'monthlySalary' | 'salary13'>): string {
  const type = wageType(entry);
  const fmt = (v: number) => v.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (type === 'hourly')  return `CHF ${fmt(entry.hourlyWage)}/h`;
  if (type === 'monthly') return `CHF ${fmt(entry.monthlySalary)}/Mt${entry.salary13 ? ' + 13.' : ''}`;
  return '–';
}
