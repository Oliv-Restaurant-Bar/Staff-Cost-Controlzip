/**
 * open-groups.ts — which queued files can be (re)opened, grouped by target type. Pure logic.
 * ========================================================================================
 * A handed-over file is NOT finished: the user may come back without importing (the target screens keep
 * their own preview + confirm). So handed files stay openable — «ready» ones are offered first, and a type
 * with only handed files is offered as «open again».
 */

import type { QueueEntry } from './queue-store';
import type { UnifiedImportTypeId } from './types';

export interface OpenGroup {
  typeId: UnifiedImportTypeId;
  ready: QueueEntry[];
  handed: QueueEntry[];
}

/** One group per type, in first-appearance order; only entries with a chosen, allowed type. */
export function buildOpenGroups(
  entries: QueueEntry[],
  allowed: (id: UnifiedImportTypeId) => boolean,
): OpenGroup[] {
  const map = new Map<UnifiedImportTypeId, OpenGroup>();
  for (const e of entries) {
    if (!e.typeId || !allowed(e.typeId)) continue;
    const g = map.get(e.typeId) ?? { typeId: e.typeId, ready: [], handed: [] };
    (e.state === 'handed' ? g.handed : g.ready).push(e);
    map.set(e.typeId, g);
  }
  return Array.from(map.values());
}

/** The files the group button opens: the not-yet-opened ones, or (none left) the already opened ones. */
export function filesForGroupButton(g: OpenGroup): { files: QueueEntry[]; reopen: boolean } {
  return g.ready.length > 0 ? { files: g.ready, reopen: false } : { files: g.handed, reopen: true };
}
