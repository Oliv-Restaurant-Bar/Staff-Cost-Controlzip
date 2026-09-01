import type { TenantId } from '@/contexts/TenantContext';
import { appSettingsTable } from '@/lib/app-settings-table';
import { supabase } from '@/integrations/supabase/client';
import type { ControlListDepartment, ControlListDocument } from './control-list-import';

export interface ControlListTenantState {
  version: 1;
  document?: ControlListDocument;
  departments: Record<string, ControlListDepartment>;
  helperSelections: Record<string, boolean>;
}

const emptyState = (): ControlListTenantState => ({ version: 1, departments: {}, helperSelections: {} });
const keyFor = (tenantId: TenantId): string => `control-list:v1:${tenantId}`;

function isDepartment(value: unknown): value is ControlListDepartment {
  return value === 'kueche' || value === 'service' || value === 'geschaeftsleitung';
}

function readState(value: unknown): ControlListTenantState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState();
  const blob = value as Record<string, unknown>;
  const departments: Record<string, ControlListDepartment> = {};
  if (blob.departments && typeof blob.departments === 'object' && !Array.isArray(blob.departments)) {
    for (const [name, department] of Object.entries(blob.departments)) if (isDepartment(department)) departments[name] = department;
  }
  return {
    version: 1,
    document: blob.document && typeof blob.document === 'object' ? blob.document as ControlListDocument : undefined,
    departments,
    helperSelections: blob.helperSelections && typeof blob.helperSelections === 'object' && !Array.isArray(blob.helperSelections)
      ? Object.fromEntries(Object.entries(blob.helperSelections).filter(([, selected]) => typeof selected === 'boolean')) : {},
  };
}

export function departmentForEmployee(state: Pick<ControlListTenantState, 'departments'>, employeeName: string): { department: ControlListDepartment; unknown: boolean } {
  const department = state.departments[employeeName];
  return department ? { department, unknown: false } : { department: 'service', unknown: true };
}

export async function loadControlListState(tenantId: TenantId): Promise<ControlListTenantState> {
  const { data, error } = await appSettingsTable().select('value').eq('key', keyFor(tenantId)).maybeSingle();
  if (error) throw new Error(`Kontrollliste konnte nicht geladen werden: ${error.message}`);
  return readState(data?.value);
}

export async function saveControlListState(tenantId: TenantId, state: ControlListTenantState): Promise<void> {
  // Nicht über den generischen app_settings-Upsert schreiben: Der RPC prüft
  // Rolle und Mandant serverseitig und konstruiert den erlaubten Key selbst.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc('save_control_list_state', {
    p_tenant: tenantId,
    p_value: state,
  });
  if (error) throw new Error(`Kontrollliste konnte nicht gespeichert werden: ${error.message}`);
}