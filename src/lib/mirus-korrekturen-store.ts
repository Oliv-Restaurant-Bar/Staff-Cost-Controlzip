import { supabase } from '@/integrations/supabase/client';

export const MIRUS_RELEVANT_TYPES = [
  'update_daily_hours',
  'update_time_block',
  'add_time_block',
  'delete_time_block',
  'reimport_overwrite_manual',
  'approved_employee_request',
  'admin_apply_employee_request',
] as const;

export type MirusRelevantType = (typeof MIRUS_RELEVANT_TYPES)[number];

export interface MirusChangeEntry {
  id:          string;
  employee_id: string;
  date:        string;
  month:       number;
  year:        number;
  table_name:  string;
  field_name:  string;
  old_value:   string | null;
  new_value:   string | null;
  change_type: string;
  reason:      string | null;
  changed_by:  string | null;
  changed_at:  string;
  source:      string;
}

export interface MirusAdjustmentStatus {
  id:             string;
  employee_id:    string;
  month:          number;
  year:           number;
  status:         'open' | 'done';
  marked_done_at: string | null;
  marked_done_by: string | null;
  note:           string | null;
  created_at:     string;
}

function filterByTenant(rows: MirusChangeEntry[], tenantId: string): MirusChangeEntry[] {
  const isBeau = tenantId === 'beaulieu';
  return rows.filter(r => isBeau ? r.employee_id.startsWith('b-') : !r.employee_id.startsWith('b-'));
}

/**
 * Lädt alle timesheet_change_log Einträge für den Monat/Jahr die als Mirus-Korrektur gelten:
 * - change_type in MIRUS_RELEVANT_TYPES  ODER  source = 'manual_edit'
 */
export async function getMirusCorrections(
  tenantId: string,
  year:     number,
  month:    number,
): Promise<MirusChangeEntry[]> {
  const [byType, bySource] = await Promise.allSettled([
    (supabase as any)
      .from('timesheet_change_log')
      .select('*')
      .eq('year', year)
      .eq('month', month)
      .in('change_type', [...MIRUS_RELEVANT_TYPES])
      .order('date',       { ascending: true })
      .order('changed_at', { ascending: true }),
    (supabase as any)
      .from('timesheet_change_log')
      .select('*')
      .eq('year', year)
      .eq('month', month)
      .eq('source', 'manual_edit')
      .order('date',       { ascending: true })
      .order('changed_at', { ascending: true }),
  ]);

  const rows1: MirusChangeEntry[] = byType.status   === 'fulfilled' ? (byType.value.data   ?? []) : [];
  const rows2: MirusChangeEntry[] = bySource.status === 'fulfilled' ? (bySource.value.data ?? []) : [];

  const seen = new Set<string>();
  const merged: MirusChangeEntry[] = [];
  for (const r of [...rows1, ...rows2]) {
    if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
  }
  merged.sort((a, b) =>
    a.date.localeCompare(b.date) || a.changed_at.localeCompare(b.changed_at),
  );

  return filterByTenant(merged, tenantId);
}

/** Lädt alle Mirus-Nachtrag-Stati für den Monat/Jahr */
export async function getMirusAdjustmentStatuses(
  tenantId: string,
  year:     number,
  month:    number,
): Promise<MirusAdjustmentStatus[]> {
  const { data, error } = await (supabase as any)
    .from('timesheet_mirus_adjustment_status')
    .select('*')
    .eq('year',  year)
    .eq('month', month);

  if (error?.code === '42P01' || error?.code === '42501') return [];
  if (error) {
    console.error('[mirus-korrekturen-store] getMirusAdjustmentStatuses:', error);
    return [];
  }

  const rows = (data ?? []) as MirusAdjustmentStatus[];
  const isBeau = tenantId === 'beaulieu';
  return rows.filter(r => isBeau ? r.employee_id.startsWith('b-') : !r.employee_id.startsWith('b-'));
}

/** Markiert Korrekturen eines Mitarbeiters für den Monat als in Mirus eingetragen */
export async function markMirusAdjustmentDone(
  employeeId: string,
  year:       number,
  month:      number,
  note:       string | null,
  markedBy:   string | null,
): Promise<void> {
  const { error } = await (supabase as any)
    .from('timesheet_mirus_adjustment_status')
    .upsert(
      {
        employee_id:    employeeId,
        year,
        month,
        status:         'done',
        marked_done_at: new Date().toISOString(),
        marked_done_by: markedBy,
        note,
      },
      { onConflict: 'employee_id,month,year' },
    );
  if (error) throw error;
}

/** Setzt den Mirus-Status eines Mitarbeiters auf "offen" zurück */
export async function resetMirusAdjustment(
  employeeId: string,
  year:       number,
  month:      number,
): Promise<void> {
  const { error } = await (supabase as any)
    .from('timesheet_mirus_adjustment_status')
    .upsert(
      {
        employee_id:    employeeId,
        year,
        month,
        status:         'open',
        marked_done_at: null,
        marked_done_by: null,
        note:           null,
      },
      { onConflict: 'employee_id,month,year' },
    );
  if (error) throw error;
}
