/**
 * weekly-sources.ts — which weekly source of «Wöchentlich — Cockpit-Bereitschaft» a dropped file feeds.
 * =======================================================================================================
 * Pure mapping (no React / supabase). Source ids are the ones of `WEEKLY_SOURCES` in import-freshness.ts.
 * The drop zone uses it to show which of the 8 weekly sources the current list covers.
 */

import type { TagesdatenTyp } from '@/lib/tagesdaten-auto-import';
import type { UnifiedImportTypeId } from './types';

export type WeeklySourceKey =
  | 'umsatz' | 'gaeste' | 'avgcheck' | 'verkauf' | 'mirus' | 'reservationen' | 'rezensionen' | 'umsatzkategorien';

/** Weekly sources a file of this type (and, for daily data, sub-type) delivers. Empty = not a weekly source. */
export function weeklySourcesFor(typeId: UnifiedImportTypeId | null, tagesdatenTyp: TagesdatenTyp | null): WeeklySourceKey[] {
  switch (typeId) {
    case 'tagesdaten':
      if (tagesdatenTyp === 'umsatz') return ['umsatz'];
      if (tagesdatenTyp === 'gaeste') return ['gaeste'];
      if (tagesdatenTyp === 'durchschnitt' || tagesdatenTyp === 'umsatzprogast') return ['avgcheck'];
      return [];
    case 'zbericht-pdf': return ['umsatz'];
    case 'gn-kpi-pdf': return ['gaeste', 'avgcheck'];
    case 'verkaufsdaten':
    case 'sales-upload': return ['verkauf'];
    case 'mirus-schedule':
    case 'ist-stunden': return ['mirus'];
    case 'foratable-reservationen': return ['reservationen'];
    case 'rezensionen': return ['rezensionen'];
    case 'umsatzkategorien': return ['umsatzkategorien'];
    default: return [];
  }
}

export interface CoverageEntry {
  typeId: UnifiedImportTypeId | null;
  tagesdatenTyp: TagesdatenTyp | null;
  state: 'ready' | 'handed';
  name: string;
}

export interface Coverage { state: 'ready' | 'handed'; names: string[] }

/** Per weekly source: the files covering it and whether any is already handed over ('handed' wins). */
export function weeklyCoverage(entries: CoverageEntry[]): Map<WeeklySourceKey, Coverage> {
  const out = new Map<WeeklySourceKey, Coverage>();
  for (const e of entries) {
    for (const k of weeklySourcesFor(e.typeId, e.tagesdatenTyp)) {
      const cur = out.get(k);
      out.set(k, {
        state: cur?.state === 'handed' || e.state === 'handed' ? 'handed' : 'ready',
        names: [...(cur?.names ?? []), e.name],
      });
    }
  }
  return out;
}
