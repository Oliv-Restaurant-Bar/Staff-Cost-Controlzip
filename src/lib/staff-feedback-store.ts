import { appSettingsTable } from '@/lib/app-settings-table';

export interface StaffFeedbackEntry {
  id: string;
  scheduleToken: string;
  employeeName: string;
  date: string;        // 'yyyy-MM-dd' or 'Allgemein'
  reason: string;
  message: string;
  createdAt: string;
  status: 'new' | 'in_progress' | 'done';
}

/**
 * Load all staff feedback entries for a given tenant.
 * Keys are: staff-feedback:{tenantId}-{deptSlug}:{timestamp}
 * Returns entries sorted by createdAt descending, plus a key-map for updates.
 */
export async function loadStaffFeedback(tenantId: string): Promise<{
  entries: StaffFeedbackEntry[];
  keys: Record<string, string>; // entry.id → app_settings row key
}> {
  const prefix = `staff-feedback:${tenantId}-`;
  try {
    const { data, error } = await appSettingsTable()
      .select('key, value')
      .like('key', `${prefix}%`);
    if (error || !data) return { entries: [], keys: {} };

    const entries: StaffFeedbackEntry[] = [];
    const keys: Record<string, string> = {};

    for (const row of data as { key: string; value: unknown }[]) {
      if (row.value && typeof row.value === 'object') {
        const entry = row.value as StaffFeedbackEntry;
        if (entry.id && entry.employeeName && entry.reason) {
          entries.push(entry);
          keys[entry.id] = row.key;
        }
      }
    }

    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { entries, keys };
  } catch {
    return { entries: [], keys: {} };
  }
}

/**
 * Update the status of a single feedback entry in Supabase.
 */
export async function updateFeedbackStatus(
  rowKey: string,
  currentEntry: StaffFeedbackEntry,
  newStatus: StaffFeedbackEntry['status'],
): Promise<void> {
  const updated: StaffFeedbackEntry = { ...currentEntry, status: newStatus };
  await appSettingsTable()
    .update({ value: updated })
    .eq('key', rowKey);
}
