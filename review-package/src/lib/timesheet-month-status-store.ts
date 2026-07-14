import { supabase } from '@/integrations/supabase/client';

// ─── Typen ────────────────────────────────────────────────────────────────────

export type MonthStatusValue =
  | 'draft'
  | 'released'
  | 'question_open'
  | 'corrected'
  | 'confirmed'
  | 'finalized'
  | 'archived';

export interface MonthStatusRecord {
  id:           string;
  tenant_id:    string;
  employee_id:  string;
  month:        number;
  year:         number;
  status:       MonthStatusValue;
  released_at:  string | null;
  confirmed_at: string | null;
  finalized_at: string | null;
  archived_at:  string | null;
  released_by:  string | null;
  finalized_by: string | null;
  created_at:   string;
  updated_at:   string;
}

/** Snapshot-Daten beim Finalisieren — entspricht dem zukünftigen PDF-Inhalt */
export interface MonthSnapshotData {
  tenant_id:       string;
  year:            number;
  month:           number;
  finalized_at:    string;
  finalized_by:    string | null;
  employee_count:  number;
  confirmed_count: number;
  total_ist_hours: number;
  open_request_count: number;
  employees: Array<{
    id:                  string;
    name:                string;
    department:          string;
    soll_hours:          number;
    ist_hours:           number;
    diff_hours:          number;
    vacation_balance:    number | null;
    holiday_balance:     number | null;
    confirmation_status: string | null;
    confirmed_at:        string | null;
    employee_comment:    string | null;
  }>;
}

// ─── DB-Funktionen ────────────────────────────────────────────────────────────

/** Alle Monatsstatus-Einträge für einen Tenant / Monat / Jahr */
export async function getMonthStatuses(
  tenantId: string,
  year:     number,
  month:    number,
): Promise<Record<string, MonthStatusRecord>> {
  const { data, error } = await (supabase as any)
    .from('timesheet_month_status')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('year',      year)
    .eq('month',     month);

  if (error?.code === '42P01' || error?.code === '42501' || error?.code === 'PGRST205') return {};
  if (error) {
    console.error('[timesheet-month-status-store] getMonthStatuses:', error);
    return {};
  }
  return Object.fromEntries(
    ((data ?? []) as MonthStatusRecord[]).map(r => [r.employee_id, r]),
  );
}

/**
 * Upsert eines einzelnen Mitarbeiters-Monats-Status.
 * Zeitstempel werden automatisch gesetzt wenn der Status wechselt.
 */
export async function upsertMonthStatus(
  tenantId:   string,
  employeeId: string,
  year:       number,
  month:      number,
  status:     MonthStatusValue,
  userId:     string | null,
): Promise<void> {
  const now    = new Date().toISOString();
  const record: Record<string, unknown> = {
    tenant_id:   tenantId,
    employee_id: employeeId,
    year,
    month,
    status,
    updated_at:  now,
  };

  if (status === 'released')  { record.released_at  = now; record.released_by  = userId; }
  if (status === 'finalized') { record.finalized_at = now; record.finalized_by = userId; }
  if (status === 'confirmed') { record.confirmed_at = now; }
  if (status === 'archived')  { record.archived_at  = now; }
  // Entsperren zurück auf 'confirmed': Finalisierungs-Zeitstempel zurücksetzen
  if (status === 'confirmed') { record.finalized_at = null; record.finalized_by = null; }

  const { error } = await (supabase as any)
    .from('timesheet_month_status')
    .upsert(record, { onConflict: 'tenant_id,employee_id,month,year' });

  if (error) throw error;
}

/** Snapshot beim Finalisieren speichern (UPSERT) */
export async function saveMonthSnapshot(
  tenantId:    string,
  year:        number,
  month:       number,
  data:        MonthSnapshotData,
  finalizedBy: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await (supabase as any)
    .from('timesheet_month_snapshot')
    .upsert(
      {
        tenant_id:      tenantId,
        year,
        month,
        finalized_at:   now,
        finalized_by:   finalizedBy,
        employee_count: data.employee_count,
        data,
        updated_at:     now,
      },
      { onConflict: 'tenant_id,month,year' },
    );
  if (error) throw error;
}

/** Letzten Snapshot für einen Monat laden */
export async function getMonthSnapshot(
  tenantId: string,
  year:     number,
  month:    number,
): Promise<MonthSnapshotData | null> {
  const { data, error } = await (supabase as any)
    .from('timesheet_month_snapshot')
    .select('data')
    .eq('tenant_id', tenantId)
    .eq('year',      year)
    .eq('month',     month)
    .maybeSingle();

  if (error?.code === '42P01' || error?.code === '42501' || error?.code === 'PGRST205') return null;
  if (error) {
    console.error('[timesheet-month-status-store] getMonthSnapshot:', error);
    return null;
  }
  return data?.data ?? null;
}
