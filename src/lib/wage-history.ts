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
    console.log(`[WAGE-HISTORY] employee: ${emp.id} | date: ${date} | selected wage: ${effective.hourlyWage || effective.monthlySalary} | source: history | valid_from: ${effective.validFrom}`);
    return {
      ...emp,
      hourlyWage:            effective.hourlyWage            || emp.hourlyWage,
      monthlySalary:         effective.monthlySalary         ?? emp.monthlySalary,
      monthlySalaryWith13th: effective.monthlySalaryWith13th ?? emp.monthlySalaryWith13th,
    };
  });
}

// ── Schreiben ─────────────────────────────────────────────────────────────────

/**
 * Neuen Lohneintrag hinzufügen.
 * Bestehende Einträge werden NIEMALS geändert.
 */
export async function addWageEntry(
  entry: NewWageEntry,
): Promise<{ error: string | null }> {
  try {
    const { error } = await (supabase as any)
      .from('employee_wages')
      .insert({
        employee_id:             entry.employeeId,
        restaurant_id:           entry.restaurantId,
        valid_from:              entry.validFrom,
        hourly_wage:             entry.hourlyWage             ?? 0,
        monthly_salary:          entry.monthlySalary          ?? 0,
        monthly_salary_with_13th: entry.monthlySalaryWith13th ?? 0,
        salary_13:               entry.salary13               ?? false,
        notes:                   entry.notes                  ?? '',
      });

    if (error) {
      console.error('[WAGE-HISTORY] addWageEntry Fehler:', error.message);
      return { error: error.message };
    }

    console.log(`[WAGE-HISTORY] employee: ${entry.employeeId} | new entry: ${entry.validFrom} | wage: ${entry.hourlyWage || entry.monthlySalary}`);
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
