import { supabase } from '@/integrations/supabase/client';

// ─── Typen ────────────────────────────────────────────────────────────────────

export interface ExclusionRecord {
  id:          string;
  tenant_id:   string | null;
  employee_id: string;
  start_month: number;
  start_year:  number;
  end_month:   number | null;
  end_year:    number | null;
  reason:      string | null;
  excluded_by: string | null;
  excluded_at: string;
  is_active:   boolean;
}

export interface InclusionRecord {
  id:          string;
  tenant_id:   string | null;
  employee_id: string;
  month:       number;
  year:        number;
  reason:      string | null;
  included_by: string | null;
  included_at: string;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Gibt true zurück wenn der Mitarbeiter für den Monat Y/M ausgeschlossen ist.
 * Einzelmonat-Inclusions überschreiben einen laufenden Ausschluss.
 */
export function isExcludedForMonth(
  empId:      string,
  year:       number,
  month:      number,
  exclusions: ExclusionRecord[],
  inclusions: InclusionRecord[],
): boolean {
  const hasInclusion = inclusions.some(
    i => i.employee_id === empId && i.year === year && i.month === month,
  );
  if (hasInclusion) return false;

  return exclusions.some(ex => {
    if (ex.employee_id !== empId || !ex.is_active) return false;
    // afterStart: (start_year, start_month) <= (year, month)
    const afterStart = ex.start_year < year
      || (ex.start_year === year && ex.start_month <= month);
    if (!afterStart) return false;
    // beforeEnd: no end, or (end_year, end_month) >= (year, month)
    if (ex.end_year == null || ex.end_month == null) return true;
    return ex.end_year > year || (ex.end_year === year && ex.end_month >= month);
  });
}

/** Gibt den aktiven Ausschluss-Eintrag für einen Mitarbeiter zurück (falls vorhanden). */
export function getActiveExclusion(
  empId:      string,
  exclusions: ExclusionRecord[],
): ExclusionRecord | null {
  return exclusions.find(ex => ex.employee_id === empId && ex.is_active) ?? null;
}

// ─── Lesefunktionen ───────────────────────────────────────────────────────────

export async function getExclusionsForTenant(tenantId: string): Promise<ExclusionRecord[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('timesheet_month_exclusions')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('excluded_at', { ascending: false });
  if (error?.code === '42P01' || error?.code === '42501') return [];
  if (error) { console.error('[EXCLUSIONS] getExclusionsForTenant:', error); return []; }
  return (data ?? []) as ExclusionRecord[];
}

export async function getInclusionsForMonth(
  tenantId: string,
  year:     number,
  month:    number,
): Promise<InclusionRecord[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('timesheet_month_inclusions')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('year', year)
    .eq('month', month);
  if (error?.code === '42P01' || error?.code === '42501') return [];
  if (error) { console.error('[EXCLUSIONS] getInclusionsForMonth:', error); return []; }
  return (data ?? []) as InclusionRecord[];
}

// ─── Schreibfunktionen ────────────────────────────────────────────────────────

/**
 * Schliesst einen Mitarbeiter aus.
 * scope='month_only': nur den genannten Monat (end = start)
 * scope='permanent':  ab diesem Monat dauerhaft (kein end)
 */
export async function excludeEmployee(params: {
  tenantId:    string;
  employeeId:  string;
  startYear:   number;
  startMonth:  number;
  scope:       'month_only' | 'permanent';
  reason:      string | null;
  excludedBy:  string | null;
}): Promise<void> {
  const { tenantId, employeeId, startYear, startMonth, scope, reason, excludedBy } = params;

  // Bestehende aktive Ausschlüsse deaktivieren
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any)
    .from('timesheet_month_exclusions')
    .update({ is_active: false })
    .eq('tenant_id', tenantId)
    .eq('employee_id', employeeId)
    .eq('is_active', true);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('timesheet_month_exclusions')
    .insert({
      tenant_id:   tenantId,
      employee_id: employeeId,
      start_month: startMonth,
      start_year:  startYear,
      end_month:   scope === 'month_only' ? startMonth : null,
      end_year:    scope === 'month_only' ? startYear  : null,
      reason,
      excluded_by: excludedBy,
      excluded_at: new Date().toISOString(),
      is_active:   true,
    });
  if (error) throw error;
}

/**
 * Schliesst einen Mitarbeiter dauerhaft wieder ein — setzt end_month/end_year
 * des laufenden Ausschlusses auf den Vormonat von fromYear/fromMonth.
 */
export async function reIncludeEmployeePermanent(
  tenantId:   string,
  employeeId: string,
  fromYear:   number,
  fromMonth:  number,
  userEmail:  string | null,
): Promise<void> {
  let prevMonth = fromMonth - 1;
  let prevYear  = fromYear;
  if (prevMonth === 0) { prevMonth = 12; prevYear = fromYear - 1; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('timesheet_month_exclusions')
    .update({ end_month: prevMonth, end_year: prevYear })
    .eq('tenant_id', tenantId)
    .eq('employee_id', employeeId)
    .eq('is_active', true);
  if (error) throw error;

  // Evtl. vorhandene Einzelmonat-Inclusion für diesen Monat entfernen
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any)
    .from('timesheet_month_inclusions')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('employee_id', employeeId)
    .eq('year', fromYear)
    .eq('month', fromMonth);

  void userEmail; // audit reserved for future
}

/**
 * Schliesst einen Mitarbeiter nur für diesen einen Monat wieder ein
 * (Einzelmonat-Ausnahme via timesheet_month_inclusions).
 */
export async function reIncludeEmployeeMonth(
  tenantId:   string,
  employeeId: string,
  year:       number,
  month:      number,
  reason:     string | null,
  userEmail:  string | null,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('timesheet_month_inclusions')
    .upsert({
      tenant_id:   tenantId,
      employee_id: employeeId,
      year,
      month,
      reason,
      included_by: userEmail,
      included_at: new Date().toISOString(),
    }, { onConflict: 'employee_id,year,month' });
  if (error) throw error;
}
