/**
 * queue-store.ts — the list of dropped files for the current browser session.
 * ==========================================================================
 * Module-level (not React state) on purpose: most existing imports are separate pages, so handing a file over
 * leaves /import. The remaining files must still be in the list when the user comes back.
 * Memory only: nothing is persisted, a reload or a tenant switch empties it. NO React / supabase here.
 */

import type { ClassifyResult, UnifiedImportTypeId } from './types';

export type QueueEntryState = 'ready' | 'handed';

export interface QueueEntry {
  id: string;
  file: File;
  result: ClassifyResult;
  /** The type the file will be handed to: the classifier's guess or the user's pick (null = not chosen yet). */
  typeId: UnifiedImportTypeId | null;
  state: QueueEntryState;
}

let entries: QueueEntry[] = [];
let tenantOfList: string | null = null;
let counter = 0;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach(l => l());

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Stable snapshot for useSyncExternalStore (a new array only when something changed). */
export function getEntries(): QueueEntry[] { return entries; }

export function getListTenant(): string | null { return tenantOfList; }

export function addEntries(tenantId: string, items: Array<{ file: File; result: ClassifyResult }>): void {
  if (tenantOfList !== null && tenantOfList !== tenantId) entries = []; // never mix tenants in one list
  tenantOfList = tenantId;
  entries = [
    ...entries,
    ...items.map(({ file, result }) => ({
      id: `f${++counter}`,
      file,
      result,
      // Only a recognised file is pre-selected; «please confirm» keeps the suggestion visible but unselected.
      typeId: result.status === 'recognised' ? result.typeId : null,
      state: 'ready' as QueueEntryState,
    })),
  ];
  emit();
}

export function setEntryType(id: string, typeId: UnifiedImportTypeId | null): void {
  entries = entries.map(e => (e.id === id ? { ...e, typeId } : e));
  emit();
}

export function markHanded(ids: string[]): void {
  const set = new Set(ids);
  entries = entries.map(e => (set.has(e.id) ? { ...e, state: 'handed' } : e));
  emit();
}

export function removeEntry(id: string): void {
  entries = entries.filter(e => e.id !== id);
  emit();
}

export function clearQueue(): void {
  entries = [];
  tenantOfList = null;
  emit();
}
