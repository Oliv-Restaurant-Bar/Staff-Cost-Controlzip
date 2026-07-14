import { supabase } from '@/integrations/supabase/client';
import { resolveDayBreakHours } from '@/hooks/useShiftConfig';

export type TimesheetStatus = 'open' | 'link_created' | 'sent' | 'confirmed' | 'rejected' | 'expired' | 'question_open' | 'finalized';

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
  absence_type?: string | null;
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
  // Lookup existing record — filter by tenant_id to avoid cross-tenant collisions
  const { data: existing, error: selectErr } = await db()
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('employee_id', employeeId)
    .eq('year', year)
    .eq('month', month)
    .maybeSingle();

  // Table doesn't exist yet → clear error
  if (selectErr?.code === '42P01') {
    const err = new Error(
      `Tabelle employee_timesheet_confirmations existiert noch nicht. ` +
      `Bitte Migration supabase/migrations/20260529_timesheet_confirmations_fix.sql im Supabase SQL-Editor ausführen.`
    );
    (err as Error & { code: string; details: string }).code = '42P01';
    (err as Error & { code: string; details: string }).details = selectErr.message ?? '';
    throw err;
  }
  // Permission denied
  if (selectErr?.code === '42501') {
    const err = new Error(`Keine Berechtigung (RLS). Bitte Grants im SQL-Editor prüfen. [${selectErr.message}]`);
    throw err;
  }

  if (existing) {
    // Bestehenden Eintrag zurückgeben (Token bleibt stabil)
    if (existing.status === 'open') {
      const { data: updated, error: updateErr } = await db()
        .update({ status: 'link_created', updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select()
        .single();
      if (updateErr) {
        console.error('[TIMESHEET] createOrGetConfirmation update:', {
          message: updateErr.message,
          code:    updateErr.code,
          details: updateErr.details,
          employee_id: employeeId,
          month, year,
        });
        throw new Error(`Update fehlgeschlagen: ${updateErr.message} (${updateErr.code})`);
      }
      return (updated ?? existing) as TimesheetConfirmation;
    }
    return existing as TimesheetConfirmation;
  }

  // Neuen Eintrag anlegen
  const token = generateToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 60);

  const { data, error: insertErr } = await db()
    .insert({
      tenant_id:   tenantId,
      employee_id: employeeId,
      year,
      month,
      token,
      status:      'link_created',
      expires_at:  expiresAt.toISOString(),
    })
    .select()
    .single();

  if (insertErr) {
    // Unique-Conflict: Parallelzugriff – nochmals lesen
    if (insertErr.code === '23505') {
      const { data: retry } = await db()
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('employee_id', employeeId)
        .eq('year', year)
        .eq('month', month)
        .maybeSingle();
      if (retry) return retry as TimesheetConfirmation;
    }
    console.error('[TIMESHEET] createOrGetConfirmation insert:', {
      message:    insertErr.message,
      code:       insertErr.code,
      details:    insertErr.details,
      employee_id: employeeId,
      month, year,
    });
    throw new Error(`${insertErr.message} (Code: ${insertErr.code ?? '–'}${insertErr.details ? ' · ' + insertErr.details : ''})`);
  }
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
    .select('date, hours, start_time, end_time, absence_type')
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
      absence_type: (r as { absence_type?: string | null }).absence_type ?? null,
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
  // extended fields (may be absent in older rows)
  skipped_count?: number;
  created_employees_count?: number;
  manual_matches_count?: number;
  is_reimport?: boolean;
  deleted_count?: number;
  protected_count?: number;
  parser_quality?: Record<string, unknown> | null;
  import_status?: string | null;
  error_summary?: string | null;
}

export async function saveImportHistory(params: {
  tenantId: string;
  year: number;
  month: number;
  source?: string;
  fileName?: string | null;
  importedCount: number;
  updatedCount?: number;
  skippedCount?: number;
  createdEmployeesCount?: number;
  manualMatchesCount?: number;
  errors?: string[];
  createdBy?: string | null;
  parserQuality?: Record<string, unknown> | null;
  isReimport?: boolean;
  deletedCount?: number;
  protectedCount?: number;
  skippedConfirmedCount?: number;
  skippedManualCount?: number;
}): Promise<void> {
  const {
    tenantId, year, month, source = 'mirus', fileName,
    importedCount, updatedCount = 0,
    skippedCount = 0, createdEmployeesCount = 0, manualMatchesCount = 0,
    errors = [], createdBy, parserQuality,
    isReimport = false, deletedCount = 0,
    protectedCount = 0, skippedConfirmedCount = 0, skippedManualCount = 0,
  } = params;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('timesheet_import_history')
    .insert({
      tenant_id:                tenantId,
      source,
      file_name:                fileName ?? null,
      month,
      year,
      imported_count:           importedCount,
      updated_count:            updatedCount,
      skipped_count:            skippedCount,
      created_employees_count:  createdEmployeesCount,
      manual_matches_count:     manualMatchesCount,
      error_count:              errors.length,
      errors:                   errors.length ? errors : null,
      created_by:               createdBy ?? null,
      ...(parserQuality ? { parser_quality: parserQuality } : {}),
      ...(isReimport ? { is_reimport: true, deleted_count: deletedCount } : {}),
      ...(protectedCount > 0 || skippedConfirmedCount > 0 || skippedManualCount > 0
        ? { protected_count: protectedCount, skipped_confirmed_count: skippedConfirmedCount, skipped_manual_count: skippedManualCount }
        : {}),
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

export async function getImportHistoryAll(
  tenantId: string,
  limit: number = 30,
): Promise<ImportHistoryEntry[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('timesheet_import_history')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error?.code === '42P01' || error?.code === '42501') return [];
  if (error) { console.error('[TIMESHEET-HISTORY] getImportHistoryAll:', error); return []; }
  return (data ?? []) as ImportHistoryEntry[];
}

// ─── Mitarbeiter-Zeitguthaben ─────────────────────────────────────────────────

export interface EmployeeTimeBalance {
  employee_id: string;
  vacation_balance_hours:       number | null;
  vacation_taken_hours:         number | null;
  vacation_taken_days:          number | null;
  vacation_balance_days:        number | null;
  public_holiday_balance_hours: number | null;
  holiday_taken_hours:          number | null;
  holiday_taken_days:           number | null;
  holiday_balance_days:         number | null;
  overtime_balance_hours:       number | null;
  compensation_balance_hours:   number | null;
  hours_balance:                number | null;
}

export async function upsertEmployeeTimeBalance(params: {
  tenantId: string;
  employeeId: string;
  year: number;
  month: number;
  vacationHours?: number | null;
  vacationTakenHours?: number | null;
  vacationTakenDays?: number | null;
  vacationBalanceDays?: number | null;
  holidayHours?: number | null;
  holidayTakenHours?: number | null;
  holidayTakenDays?: number | null;
  holidayBalanceDays?: number | null;
  overtimeHours?: number | null;
  compensationHours?: number | null;
  hoursBalance?: number | null;
}): Promise<void> {
  const {
    tenantId, employeeId, year, month,
    vacationHours, vacationTakenHours, vacationTakenDays, vacationBalanceDays,
    holidayHours, holidayTakenHours, holidayTakenDays, holidayBalanceDays,
    overtimeHours, compensationHours, hoursBalance,
  } = params;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const basePayload = {
    tenant_id:                    tenantId,
    employee_id:                  employeeId,
    month,
    year,
    vacation_balance_hours:       vacationHours        ?? null,
    vacation_taken_hours:         vacationTakenHours   ?? null,
    public_holiday_balance_hours: holidayHours         ?? null,
    holiday_taken_hours:          holidayTakenHours    ?? null,
    overtime_balance_hours:       overtimeHours        ?? null,
    compensation_balance_hours:   compensationHours    ?? null,
    hours_balance:                hoursBalance         ?? null,
    source:                       'mirus_import',
    updated_at:                   new Date().toISOString(),
  };
  const fullPayload = {
    ...basePayload,
    vacation_taken_days:          vacationTakenDays    ?? null,
    vacation_balance_days:        vacationBalanceDays  ?? null,
    holiday_taken_days:           holidayTakenDays     ?? null,
    holiday_balance_days:         holidayBalanceDays   ?? null,
  };
  let { error } = await (supabase as any)
    .from('employee_time_balances')
    .upsert(fullPayload, { onConflict: 'employee_id,month,year' });
  // Spalte noch nicht migriert → Fallback ohne Tage-Felder
  if (error?.code === '42703') {
    const fallback = await (supabase as any)
      .from('employee_time_balances')
      .upsert(basePayload, { onConflict: 'employee_id,month,year' });
    error = fallback.error;
  }
  if (error) console.error('[TIMESHEET-BALANCE] upsertEmployeeTimeBalance:', error);
}

export async function getEmployeeTimeBalancesForMonth(
  tenantId: string,
  year: number,
  month: number,
): Promise<Record<string, EmployeeTimeBalance>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // Vollständiger SELECT inkl. Tage-Spalten (nach Migration vorhanden)
  const FULL_COLS = [
    'employee_id',
    'vacation_balance_hours', 'vacation_taken_hours',
    'vacation_taken_days',    'vacation_balance_days',
    'public_holiday_balance_hours', 'holiday_taken_hours',
    'holiday_taken_days',     'holiday_balance_days',
    'overtime_balance_hours', 'compensation_balance_hours', 'hours_balance',
  ].join(', ');

  // Fallback-SELECT ohne Tage-Spalten (vor Migration)
  const BASE_COLS = [
    'employee_id',
    'vacation_balance_hours', 'vacation_taken_hours',
    'public_holiday_balance_hours', 'holiday_taken_hours',
    'overtime_balance_hours', 'compensation_balance_hours', 'hours_balance',
  ].join(', ');

  let { data, error } = await (supabase as any)
    .from('employee_time_balances')
    .select(FULL_COLS)
    .eq('tenant_id', tenantId)
    .eq('year', year)
    .eq('month', month);

  // Spalte existiert noch nicht (Migration ausstehend) → Fallback auf Basis-Spalten
  if (error?.code === '42703') {
    const fallback = await (supabase as any)
      .from('employee_time_balances')
      .select(BASE_COLS)
      .eq('tenant_id', tenantId)
      .eq('year', year)
      .eq('month', month);
    data  = fallback.data;
    error = fallback.error;
  }

  if (error?.code === '42P01' || error?.code === '42501') return {};
  if (error) { console.error('[TIMESHEET-BALANCE] getEmployeeTimeBalancesForMonth:', error); return {}; }

  const result: Record<string, EmployeeTimeBalance> = {};
  for (const row of data ?? []) {
    result[row.employee_id] = {
      employee_id:                  row.employee_id,
      vacation_balance_hours:       row.vacation_balance_hours       ?? null,
      vacation_taken_hours:         row.vacation_taken_hours         ?? null,
      vacation_taken_days:          row.vacation_taken_days          ?? null,
      vacation_balance_days:        row.vacation_balance_days        ?? null,
      public_holiday_balance_hours: row.public_holiday_balance_hours ?? null,
      holiday_taken_hours:          row.holiday_taken_hours          ?? null,
      holiday_taken_days:           row.holiday_taken_days           ?? null,
      holiday_balance_days:         row.holiday_balance_days         ?? null,
      overtime_balance_hours:       row.overtime_balance_hours       ?? null,
      compensation_balance_hours:   row.compensation_balance_hours   ?? null,
      hours_balance:                row.hours_balance                ?? null,
    };
  }
  return result;
}

// ─── Dienstplan-Stunden pro Mitarbeiter/Monat laden ──────────────────────────
// Quelle: schedule_entries (frueh_start/end, spaet_start/end)
// Gleiche Berechnungslogik wie usePersonnelData.calculateDayHoursInternal

function schedSlotHours(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let h = (eh - sh) + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.round(h * 100) / 100;
}

export async function loadDienstplanHoursForMonth(
  employeeIds: string[],
  year: number,
  month: number,
): Promise<Record<string, number>> {
  if (!employeeIds.length) return {};
  const startStr = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDay   = new Date(year, month, 0).getDate();
  const endStr   = `${year}-${String(month).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;

  // select('*'): funktioniert vor UND nach Migration 20260714 — Pausen-Spalten fehlen
  // pre-Migration einfach in den Rows (→ Automatik), Cast weil generierte Typen die
  // Spalten noch nicht kennen.
  type SchedHourRow = {
    employee_id: string;
    frueh_start: string | null; frueh_end: string | null;
    spaet_start: string | null; spaet_end: string | null;
    frueh_break_minutes?: number | null;
    spaet_break_minutes?: number | null;
    break_minutes?: number | null; // Legacy-Tages-Pause (vor Migration 20260714)
  };
  const { data, error } = await supabase
    .from('schedule_entries')
    .select('*')
    .in('employee_id', employeeIds)
    .gte('date', startStr)
    .lte('date', endStr);

  if (error) {
    if (error.code === '42P01' || error.code === '42501') return {};
    console.error('[TIMESHEET] loadDienstplanHoursForMonth:', error);
    return {};
  }

  const result: Record<string, number> = {};
  for (const row of (data as unknown as SchedHourRow[] | null) ?? []) {
    const frühH  = schedSlotHours(row.frueh_start, row.frueh_end);
    const spätH  = schedSlotHours(row.spaet_start, row.spaet_end);
    const gross  = frühH + spätH;
    const breakH = resolveDayBreakHours({
      fruehBreakMinutes: row.frueh_break_minutes ?? null,
      spaetBreakMinutes: row.spaet_break_minutes ?? null,
      breakMinutes:      row.break_minutes ?? null,
    }, gross);
    const net    = Math.round((gross - breakH) * 100) / 100;
    if (net <= 0) continue;
    result[row.employee_id] = Math.round(((result[row.employee_id] ?? 0) + net) * 100) / 100;
  }
  return result;
}

// ─── Tagesvergleich: schedule_entries + actual_hours für 1 Mitarbeiter ────────

/** Abwesenheitstypen gemäss Absence-Codes aus schedule_entries oder Mirus-Import */
export type AbsenceType = 'vacation' | 'sick' | 'holiday' | 'free' | 'accident' | null;

export interface DayComparisonEntry {
  date: string;                    // YYYY-MM-DD
  // Dienstplan (schedule_entries)
  frueh_start:    string | null;
  frueh_end:      string | null;
  frueh_absence:  string | null;
  spaet_start:    string | null;
  spaet_end:      string | null;
  spaet_absence:  string | null;
  plan_hours:     number | null;   // Nettostunden (inkl. Pausenabzug)
  plan_gross:     number | null;   // Bruttostunden (ohne Pause)
  frueh_break_minutes: number | null; // manuelle Pause 1. Einsatz (null = keine Angabe)
  spaet_break_minutes: number | null; // manuelle Pause 2. Einsatz (null = keine Angabe)
  break_minutes:  number | null;   // Legacy-Tages-Pause (nur Lese-Fallback)
  // AZB (actual_hours)
  azb_hours:      number | null;
  azb_start:      string | null;
  azb_end:        string | null;
  // Abwesenheit (aus absence-Code)
  absence_code:   string | null;
  absence_type:   AbsenceType;
}

/**
 * Geplante Pausenminuten eines Tages (zentrale Auflösung, SSoT resolveDayBreakHours):
 * manuelle Einsatz-Pausen haben Vorrang, dann Legacy-Tages-Pause, sonst Automatik.
 * Nur bei geplanter Arbeitszeit — Pause nie auf reine Absenztage.
 */
export function planPauseMinutes(e: Pick<DayComparisonEntry, 'plan_gross' | 'frueh_break_minutes' | 'spaet_break_minutes' | 'break_minutes'>): number {
  if (e.plan_gross == null || e.plan_gross <= 0) return 0;
  return Math.round(resolveDayBreakHours({
    fruehBreakMinutes: e.frueh_break_minutes,
    spaetBreakMinutes: e.spaet_break_minutes,
    breakMinutes:      e.break_minutes,
  }, e.plan_gross) * 60);
}

const VACATION_CODES  = new Set(['FE', 'FW', 'FERIEN', 'FERI', 'URLAUB', 'U', 'FER', 'VACATION']);
const ACCIDENT_CODES  = new Set(['UNFALL', 'UVG', 'UNFALLTAG', 'AUF', 'ACCIDENT']);
const SICK_CODES      = new Set(['K', 'KR', 'KRANK', 'KRANKHEIT', 'SICK']);
const HOLIDAY_CODES   = new Set(['FT', 'FEIERTAG', 'PH', 'PHFT', 'HOLIDAY']);
const FREE_CODES      = new Set(['F', 'FR', 'FREI', 'KO', 'KOMPENSATION', 'FREE']);

/** Canonical-type values die direkt gespeichert wurden — kein Mapping nötig */
const CANONICAL_TYPES = new Set<string>(['vacation', 'accident', 'sick', 'holiday', 'free']);

function classifyAbsence(code: string | null | undefined): AbsenceType {
  if (!code) return null;
  const c = code.toUpperCase().trim();
  if (CANONICAL_TYPES.has(code.toLowerCase())) return code.toLowerCase() as AbsenceType;
  if (VACATION_CODES.has(c))  return 'vacation';
  if (ACCIDENT_CODES.has(c))  return 'accident';
  if (SICK_CODES.has(c))      return 'sick';
  if (HOLIDAY_CODES.has(c))   return 'holiday';
  if (FREE_CODES.has(c))      return 'free';
  return null;
}

/**
 * Lädt die Tagesdetails (Dienstplan + AZB) für einen Mitarbeiter im angegebenen Monat.
 * Gibt ein Array mit allen Kalendertagen zurück (fehlende = leere Einträge).
 */
export async function loadEmployeeMonthDetail(
  employeeId: string,
  year: number,
  month: number,
): Promise<DayComparisonEntry[]> {
  const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay  = new Date(year, month, 0).getDate();
  const toDate   = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // select('*'): funktioniert vor UND nach Migration 20260714 (Pausen-Spalten);
  // Cast weil generierte Supabase-Typen die Spalten noch nicht kennen.
  type SchedDetailRow = {
    date: string;
    frueh_start: string | null; frueh_end: string | null; frueh_absence: string | null;
    spaet_start: string | null; spaet_end: string | null; spaet_absence: string | null;
    frueh_break_minutes?: number | null;
    spaet_break_minutes?: number | null;
    break_minutes?: number | null; // Legacy-Tages-Pause (vor Migration 20260714)
  };

  const [schedRes, azbRes] = await Promise.all([
    supabase
      .from('schedule_entries')
      .select('*')
      .eq('employee_id', employeeId)
      .gte('date', fromDate)
      .lte('date', toDate)
      .order('date'),
    supabase
      .from('actual_hours')
      .select('date, hours, start_time, end_time, absence_type')
      .eq('employee_id', employeeId)
      .gte('date', fromDate)
      .lte('date', toDate)
      .order('date'),
  ]);

  const schedMap: Record<string, SchedDetailRow> = {};
  for (const row of (schedRes.data as unknown as SchedDetailRow[] | null) ?? []) schedMap[row.date] = row;

  const azbMap: Record<string, {
    hours: number; start_time: string | null; end_time: string | null; absence_type: string | null;
  }> = {};
  for (const row of azbRes.data ?? []) {
    azbMap[row.date] = {
      hours:        row.hours ?? 0,
      start_time:   row.start_time,
      end_time:     row.end_time,
      absence_type: row.absence_type ?? null,
    };
  }

  const entries: DayComparisonEntry[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const sched   = schedMap[dateStr];
    const azb     = azbMap[dateStr];

    let planHours: number | null = null;
    let planGross: number | null = null;
    let absCode:   string | null = null;

    if (sched) {
      const frühH  = schedSlotHours(sched.frueh_start, sched.frueh_end);
      const spätH  = schedSlotHours(sched.spaet_start, sched.spaet_end);
      const gross  = Math.round((frühH + spätH) * 100) / 100;
      const breakH = resolveDayBreakHours({
        fruehBreakMinutes: sched.frueh_break_minutes ?? null,
        spaetBreakMinutes: sched.spaet_break_minutes ?? null,
        breakMinutes:      sched.break_minutes ?? null,
      }, gross);
      const net    = Math.round((gross - breakH) * 100) / 100;
      planGross    = gross > 0 ? gross : null;
      planHours    = net   > 0 ? net   : null;
      absCode      = sched.frueh_absence || sched.spaet_absence || null;
    }

    // Mirus-Abwesenheitstyp hat Vorrang vor Dienstplan-Abwesenheitscode
    const mirusAbsence = azb?.absence_type ?? null;
    const finalAbsenceType = mirusAbsence
      ? classifyAbsence(mirusAbsence)   // bereits kanonisch, classifyAbsence gibt ihn direkt zurück
      : classifyAbsence(absCode);       // Fallback: Dienstplan-Code

    entries.push({
      date:          dateStr,
      frueh_start:   sched?.frueh_start   ?? null,
      frueh_end:     sched?.frueh_end     ?? null,
      frueh_absence: sched?.frueh_absence ?? null,
      spaet_start:   sched?.spaet_start   ?? null,
      spaet_end:     sched?.spaet_end     ?? null,
      spaet_absence: sched?.spaet_absence ?? null,
      plan_hours:    planHours,
      plan_gross:    planGross,
      frueh_break_minutes: sched?.frueh_break_minutes ?? null,
      spaet_break_minutes: sched?.spaet_break_minutes ?? null,
      break_minutes: sched?.break_minutes ?? null,
      azb_hours:     azb?.hours     ?? null,
      azb_start:     azb?.start_time ?? null,
      azb_end:       azb?.end_time   ?? null,
      absence_code:  mirusAbsence ?? absCode,
      absence_type:  finalAbsenceType,
    });
  }

  return entries;
}

// ─── Mitarbeiter-Rückfragen (timesheet_employee_requests) ─────────────────────

export interface EmployeeRequest {
  id:                   string;
  confirmation_id:      string | null;
  tenant_id:            string | null;
  employee_id:          string;
  date:                 string | null;    // YYYY-MM-DD oder null = allgemein
  month:                number;
  year:                 number;
  request_type:         string;           // 'question' | 'correction_request' | 'general'
  category:             string | null;    // 'arbeitszeit' | 'pause' | 'ferien' | 'krankheit' | 'unfall' | 'sonstiges'
  message:              string | null;
  requested_hours:      number | null;
  requested_start_time: string | null;
  requested_end_time:   string | null;
  status:               string;           // 'open' | 'in_review' | 'resolved' | 'rejected'
  admin_response:       string | null;
  created_at:           string;
  resolved_at:          string | null;
  resolved_by:          string | null;
}

export async function createEmployeeRequest(params: {
  confirmationId?:      string | null;
  tenantId?:            string | null;
  employeeId:           string;
  date?:                string | null;
  month:                number;
  year:                 number;
  requestType:          string;
  category?:            string | null;
  message?:             string | null;
  requestedHours?:      number | null;
  requestedStartTime?:  string | null;
  requestedEndTime?:    string | null;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const { data, error } = await supabase
      .from('timesheet_employee_requests')
      .insert({
        confirmation_id:      params.confirmationId      ?? null,
        tenant_id:            params.tenantId            ?? null,
        employee_id:          params.employeeId,
        date:                 params.date                ?? null,
        month:                params.month,
        year:                 params.year,
        request_type:         params.requestType,
        category:             params.category            ?? null,
        message:              params.message             ?? null,
        requested_hours:      params.requestedHours      ?? null,
        requested_start_time: params.requestedStartTime  ?? null,
        requested_end_time:   params.requestedEndTime    ?? null,
        status:               'open',
      })
      .select('id')
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: (data as { id: string }).id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getRequestsForMonth(
  tenantId: string,
  year:     number,
  month:    number,
): Promise<EmployeeRequest[]> {
  const { data, error } = await supabase
    .from('timesheet_employee_requests')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('year', year)
    .eq('month', month)
    .order('created_at', { ascending: false });
  if (error?.code === '42P01' || error?.code === '42501') return [];
  if (error) { console.error('[TIMESHEET] getRequestsForMonth:', error); return []; }
  return (data ?? []) as EmployeeRequest[];
}

export async function getRequestsForConfirmation(
  confirmationId: string,
): Promise<EmployeeRequest[]> {
  const { data, error } = await supabase
    .from('timesheet_employee_requests')
    .select('*')
    .eq('confirmation_id', confirmationId)
    .order('created_at', { ascending: false });
  if (error?.code === '42P01' || error?.code === '42501') return [];
  if (error) { console.error('[TIMESHEET] getRequestsForConfirmation:', error); return []; }
  return (data ?? []) as EmployeeRequest[];
}

export async function updateRequestStatus(
  id:            string,
  status:        string,
  adminResponse?: string | null,
  resolvedBy?:   string | null,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = { status };
  if (adminResponse != null) payload.admin_response = adminResponse;
  if (status === 'resolved' || status === 'rejected') {
    payload.resolved_at = new Date().toISOString();
    if (resolvedBy) payload.resolved_by = resolvedBy;
  }
  const { error } = await supabase
    .from('timesheet_employee_requests')
    .update(payload)
    .eq('id', id);
  if (error) throw error;
}

/**
 * Setzt Bestätigung-Status auf 'question_open' (Mitarbeiter hat Rückfrage gestellt).
 * Verwendet den öffentlichen Token (kein Auth erforderlich).
 */
export async function questionTimesheet(token: string): Promise<void> {
  const { error } = await db()
    .update({ status: 'question_open', updated_at: new Date().toISOString() })
    .eq('token', token);
  if (error) throw error;
}

/**
 * Setzt Status auf 'finalized' (Admin schliesst Monat final ab).
 */
export async function finalizeTimesheet(id: string): Promise<void> {
  const { error } = await db()
    .update({ status: 'finalized', updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/**
 * Setzt alle Bestätigungen eines Monats auf 'sent' (Monat zur Prüfung freigegeben).
 * Erstellt neue Bestätigungen für Mitarbeiter ohne bestehenden Eintrag.
 */
export async function markMonthSent(
  tenantId:    string,
  year:        number,
  month:       number,
  employeeIds: string[],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  const existingConfs = await getConfirmationsForMonth(tenantId, year, month);
  const existingMap   = Object.fromEntries(existingConfs.map(c => [c.employee_id, c]));

  for (const empId of employeeIds) {
    const existing = existingMap[empId];
    if (!existing) {
      try {
        await createOrGetConfirmation(tenantId, empId, year, month);
        const { error } = await db()
          .update({ status: 'sent', updated_at: new Date().toISOString() })
          .eq('employee_id', empId)
          .eq('year', year)
          .eq('month', month)
          .eq('tenant_id', tenantId);
        if (!error) created++;
      } catch {}
    } else if (existing.status === 'open' || existing.status === 'link_created') {
      const { error } = await db()
        .update({ status: 'sent', updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (!error) updated++;
    }
  }
  return { created, updated };
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
