import { supabase } from '@/integrations/supabase/client';

export type TimesheetStatus = 'open' | 'link_created' | 'sent' | 'confirmed' | 'rejected' | 'expired';

export interface TimesheetConfirmation {
  id: string;
  tenant_id: string;
  employee_id: string;
  month: number;
  year: number;
  token: string;
  status: TimesheetStatus;
  confirmed_at: string | null;
  rejected_at: string | null;
  employee_comment: string | null;
  admin_comment: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface DailyHourEntry {
  date: string;
  hours: number;
  start_time?: string | null;
  end_time?: string | null;
}

function generateToken(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => (supabase as any).from('employee_timesheet_confirmations');

export async function getConfirmationsForMonth(
  tenantId: string,
  year: number,
  month: number,
): Promise<TimesheetConfirmation[]> {
  const { data, error } = await db()
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('year', year)
    .eq('month', month)
    .order('created_at', { ascending: false });
  if (error) {
    // Tabelle existiert noch nicht (Migration ausstehend) → leer zurückgeben
    if (error.code === '42P01' || error.code === '42501') return [];
    throw error;
  }
  return (data ?? []) as TimesheetConfirmation[];
}

export async function createOrGetConfirmation(
  tenantId: string,
  employeeId: string,
  year: number,
  month: number,
): Promise<TimesheetConfirmation> {
  const { data: existing } = await db()
    .select('*')
    .eq('employee_id', employeeId)
    .eq('year', year)
    .eq('month', month)
    .maybeSingle();

  if (existing) {
    if (existing.status === 'open') {
      const { data: updated } = await db()
        .update({ status: 'link_created', updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select()
        .single();
      return (updated ?? existing) as TimesheetConfirmation;
    }
    return existing as TimesheetConfirmation;
  }

  const token = generateToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 60);

  const { data, error } = await db()
    .insert({
      tenant_id: tenantId,
      employee_id: employeeId,
      year,
      month,
      token,
      status: 'link_created',
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data as TimesheetConfirmation;
}

export async function getConfirmationByToken(
  token: string,
): Promise<TimesheetConfirmation | null> {
  const { data, error } = await db()
    .select('*')
    .eq('token', token)
    .maybeSingle();
  if (error) return null;
  return (data ?? null) as TimesheetConfirmation | null;
}

export async function confirmTimesheet(token: string): Promise<void> {
  const { error } = await db()
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('token', token);
  if (error) throw error;
}

export async function rejectTimesheet(token: string, comment: string): Promise<void> {
  const { error } = await db()
    .update({
      status: 'rejected',
      rejected_at: new Date().toISOString(),
      employee_comment: comment || null,
    })
    .eq('token', token);
  if (error) throw error;
}

export async function deleteConfirmation(id: string): Promise<void> {
  const { error } = await db().delete().eq('id', id);
  if (error) throw error;
}

export async function getActualHoursForMonth(
  employeeId: string,
  year: number,
  month: number,
): Promise<{ total: number; days: DailyHourEntry[] }> {
  const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const toDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const { data, error } = await supabase
    .from('actual_hours')
    .select('date, hours, start_time, end_time')
    .eq('employee_id', employeeId)
    .gte('date', fromDate)
    .lte('date', toDate)
    .order('date');

  if (!error && data && data.length > 0) {
    const days = data.map(r => ({
      date: r.date,
      hours: r.hours ?? 0,
      start_time: r.start_time,
      end_time: r.end_time,
    }));
    return { total: days.reduce((s, d) => s + d.hours, 0), days };
  }

  const lsKey = `actual-hours-${year}-${String(month).padStart(2, '0')}`;
  try {
    const lsData = JSON.parse(localStorage.getItem(lsKey) || '{}') as Record<
      string, { hours?: number; start?: string; end?: string }
    >;
    const days: DailyHourEntry[] = [];
    let total = 0;
    const prefix = employeeId + '-';
    for (const [key, val] of Object.entries(lsData)) {
      if (key.startsWith(prefix)) {
        const date = key.slice(prefix.length);
        const hours = val.hours ?? 0;
        days.push({ date, hours, start_time: val.start, end_time: val.end });
        total += hours;
      }
    }
    days.sort((a, b) => a.date.localeCompare(b.date));
    return { total, days };
  } catch {
    return { total: 0, days: [] };
  }
}

export async function getActualHoursBatch(
  employeeIds: string[],
  year: number,
  month: number,
): Promise<Record<string, number>> {
  if (employeeIds.length === 0) return {};
  const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const toDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const { data } = await supabase
    .from('actual_hours')
    .select('employee_id, hours')
    .in('employee_id', employeeIds)
    .gte('date', fromDate)
    .lte('date', toDate);

  const result: Record<string, number> = {};
  for (const row of data ?? []) {
    result[row.employee_id] = (result[row.employee_id] ?? 0) + (row.hours ?? 0);
  }

  if (Object.keys(result).length === 0) {
    const lsKey = `actual-hours-${year}-${String(month).padStart(2, '0')}`;
    try {
      const lsData = JSON.parse(localStorage.getItem(lsKey) || '{}') as Record<
        string, { hours?: number }
      >;
      for (const [key, val] of Object.entries(lsData)) {
        const empId = employeeIds.find(id => key.startsWith(id + '-'));
        if (empId) result[empId] = (result[empId] ?? 0) + (val.hours ?? 0);
      }
    } catch { /* ignore */ }
  }

  return result;
}

export function timesheetPublicUrl(token: string): string {
  return `${window.location.origin}/timesheet-confirmation/${token}`;
}

export const MONTH_NAMES_DE = [
  'Januar','Februar','März','April','Mai','Juni',
  'Juli','August','September','Oktober','November','Dezember',
];

// ─── Import-Historie ──────────────────────────────────────────────────────────

export interface ImportHistoryEntry {
  id: string;
  tenant_id: string;
  source: string;
  file_name: string | null;
  month: number;
  year: number;
  imported_count: number;
  updated_count: number;
  error_count: number;
  errors: string[] | null;
  created_at: string;
  created_by: string | null;
}

export async function saveImportHistory(params: {
  tenantId: string;
  year: number;
  month: number;
  source?: string;
  fileName?: string | null;
  importedCount: number;
  updatedCount?: number;
  errors?: string[];
  createdBy?: string | null;
}): Promise<void> {
  const { tenantId, year, month, source = 'mirus', fileName, importedCount, updatedCount = 0, errors = [], createdBy } = params;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('timesheet_import_history')
    .insert({
      tenant_id:      tenantId,
      source,
      file_name:      fileName ?? null,
      month,
      year,
      imported_count: importedCount,
      updated_count:  updatedCount,
      error_count:    errors.length,
      errors:         errors.length ? errors : null,
      created_by:     createdBy ?? null,
    });
  if (error) console.error('[TIMESHEET-HISTORY] saveImportHistory:', error);
}

export async function getImportHistoryForMonth(
  tenantId: string,
  year: number,
  month: number,
): Promise<ImportHistoryEntry | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('timesheet_import_history')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('year', year)
    .eq('month', month)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error?.code === '42P01' || error?.code === '42501') return null;
  return (data ?? null) as ImportHistoryEntry | null;
}

// ─── Mitarbeiter-Zeitguthaben ─────────────────────────────────────────────────

export interface EmployeeTimeBalance {
  employee_id: string;
  vacation_balance_hours: number | null;
  public_holiday_balance_hours: number | null;
  overtime_balance_hours: number | null;
  hours_balance: number | null;
}

export async function upsertEmployeeTimeBalance(params: {
  tenantId: string;
  employeeId: string;
  year: number;
  month: number;
  vacationHours?: number | null;
  holidayHours?: number | null;
  overtimeHours?: number | null;
  hoursBalance?: number | null;
}): Promise<void> {
  const { tenantId, employeeId, year, month, vacationHours, holidayHours, overtimeHours, hoursBalance } = params;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('employee_time_balances')
    .upsert({
      tenant_id:                    tenantId,
      employee_id:                  employeeId,
      month,
      year,
      vacation_balance_hours:       vacationHours       ?? null,
      public_holiday_balance_hours: holidayHours        ?? null,
      overtime_balance_hours:       overtimeHours       ?? null,
      hours_balance:                hoursBalance        ?? null,
      source:                       'mirus_import',
      updated_at:                   new Date().toISOString(),
    }, { onConflict: 'employee_id,month,year' });
  if (error) console.error('[TIMESHEET-BALANCE] upsertEmployeeTimeBalance:', error);
}

export async function getEmployeeTimeBalancesForMonth(
  tenantId: string,
  year: number,
  month: number,
): Promise<Record<string, EmployeeTimeBalance>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('employee_time_balances')
    .select('employee_id, vacation_balance_hours, public_holiday_balance_hours, overtime_balance_hours, hours_balance')
    .eq('tenant_id', tenantId)
    .eq('year', year)
    .eq('month', month);
  if (error?.code === '42P01' || error?.code === '42501') return {};

  const result: Record<string, EmployeeTimeBalance> = {};
  for (const row of data ?? []) {
    result[row.employee_id] = {
      employee_id:                  row.employee_id,
      vacation_balance_hours:       row.vacation_balance_hours       ?? null,
      public_holiday_balance_hours: row.public_holiday_balance_hours ?? null,
      overtime_balance_hours:       row.overtime_balance_hours       ?? null,
      hours_balance:                row.hours_balance                ?? null,
    };
  }
  return result;
}

// ─── Mirus-Stunden-String parsen ──────────────────────────────────────────────
// Formate: "42.5"  |  "3 T 2:00"  |  "3:00"  |  "-1.5"  |  "1 T 0:30"

export function parseMirusHoursString(s: string | undefined): number | null {
  if (!s || s.trim() === '' || s.trim() === '-') return null;
  const t = s.trim();
  // Einfache Zahl: "42.5" oder "-1.5"
  const simple = parseFloat(t.replace(',', '.'));
  if (!isNaN(simple) && !t.includes('T') && !t.includes(':')) return simple;
  // Format "X T H:MM" (Tage + Zeit)
  const dayTime = t.match(/(-?\d+(?:[.,]\d+)?)\s*T\s*(\d+):(\d+)/i);
  if (dayTime) {
    const days  = parseFloat(dayTime[1].replace(',', '.'));
    const hours = parseInt(dayTime[2]);
    const mins  = parseInt(dayTime[3]);
    return Math.round((days * 8 + hours + mins / 60) * 100) / 100;
  }
  // Format "H:MM" oder "-H:MM"
  const timeMatch = t.match(/^(-?)(\d+):(\d+)$/);
  if (timeMatch) {
    const sign = timeMatch[1] === '-' ? -1 : 1;
    const h    = parseInt(timeMatch[2]);
    const m    = parseInt(timeMatch[3]);
    return sign * Math.round((h + m / 60) * 100) / 100;
  }
  // Nochmal als float (Komma-Decimal)
  const fallback = parseFloat(t.replace(',', '.'));
  return isNaN(fallback) ? null : fallback;
}
