/**
 * pending-files.ts — in-memory handover of dropped files to the existing import flows.
 * ====================================================================================
 * The drop zone calls `setPending(typeId, files)` and navigates / scrolls to the target. The target flow
 * picks the files up via `useIncomingImportFiles` and runs its normal «file chosen» code path.
 * Files stay in the browser; nothing is persisted and nothing is saved by this module.
 */

import type { UnifiedImportTypeId } from './types';

export const HANDOVER_EVENT = 'unified-import:handover';

const pending = new Map<UnifiedImportTypeId, File[]>();

/** Stores files for a flow (replacing older ones) and tells already-mounted flows to pick them up. */
export function setPending(id: UnifiedImportTypeId, files: File[]): void {
  if (files.length === 0) return;
  pending.set(id, files);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(HANDOVER_EVENT, { detail: { id } }));
  }
}

/** Removes and returns the files waiting for a flow (empty array when none). */
export function takePending(id: UnifiedImportTypeId): File[] {
  const files = pending.get(id) ?? [];
  pending.delete(id);
  return files;
}

export function hasPending(id: UnifiedImportTypeId): boolean {
  return (pending.get(id)?.length ?? 0) > 0;
}

/** Drops everything (tenant switch, drop zone reset): files must never reach a flow of another tenant. */
export function clearAllPending(): void {
  pending.clear();
}
