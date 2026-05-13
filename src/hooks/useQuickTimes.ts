import { useState, useCallback } from 'react';

export interface QuickTimePreset {
  id: string;
  label: string;
  start: string;
  end: string;
  start2?: string;
  end2?: string;
  slotType: 'früh' | 'spät' | 'all';
  color?: string;
}

const LS_KEY = 'dienstplan:quick-times';
const MIGRATION_KEY = 'dienstplan:quick-times-split-migrated-v1';

export const DEFAULT_QUICK_PRESETS: QuickTimePreset[] = [
  // Simple — single shift
  { id: 'f1', label: '10–14',      start: '10:00', end: '14:00', slotType: 'all' },
  { id: 'f2', label: '11–14',      start: '11:00', end: '14:00', slotType: 'all' },
  { id: 'f3', label: '11–15',      start: '11:00', end: '15:00', slotType: 'all' },
  { id: 'f4', label: '12–15',      start: '12:00', end: '15:00', slotType: 'all' },
  { id: 's1', label: '17–22',      start: '17:00', end: '22:00', slotType: 'all' },
  { id: 's2', label: '17–23',      start: '17:00', end: '23:00', slotType: 'all' },
  { id: 's3', label: '17:30–23',   start: '17:30', end: '23:00', slotType: 'all' },
  { id: 's4', label: '18–23',      start: '18:00', end: '23:00', slotType: 'all' },
  // Split — two shifts in one day
  { id: 'sp1', label: '10–14 / 17:30–23',   start: '10:00', end: '14:00', start2: '17:30', end2: '23:00',  slotType: 'all' },
  { id: 'sp2', label: '11–14 / 17–23',      start: '11:00', end: '14:00', start2: '17:00', end2: '23:00',  slotType: 'all' },
  { id: 'sp3', label: '11–14 / 17–23:30',   start: '11:00', end: '14:00', start2: '17:00', end2: '23:30',  slotType: 'all' },
  { id: 'sp4', label: '11:15–14 / 17:30–23',start: '11:15', end: '14:00', start2: '17:30', end2: '23:00',  slotType: 'all' },
];

// Default split presets only — used by the migration
const DEFAULT_SPLIT_PRESETS: QuickTimePreset[] = DEFAULT_QUICK_PRESETS.filter(
  p => !!(p.start2 && p.end2)
);

/**
 * Loads presets from localStorage.
 * Runs a one-time migration to append split presets to any existing list that
 * has no splits yet, so users who had the old simple-only list get them back.
 */
function load(): QuickTimePreset[] {
  try {
    const raw = localStorage.getItem(LS_KEY);

    if (!raw) {
      // Fresh start — store full defaults immediately
      persist(DEFAULT_QUICK_PRESETS);
      return DEFAULT_QUICK_PRESETS;
    }

    const parsed: QuickTimePreset[] = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      persist(DEFAULT_QUICK_PRESETS);
      return DEFAULT_QUICK_PRESETS;
    }

    // One-time migration: if the stored list has no split presets, append the defaults
    const alreadyMigrated = localStorage.getItem(MIGRATION_KEY) === '1';
    if (!alreadyMigrated) {
      const hasSplits = parsed.some(p => !!(p.start2 && p.end2));
      if (!hasSplits) {
        // Append split presets that aren't already present (by id)
        const existingIds = new Set(parsed.map(p => p.id));
        const toAdd = DEFAULT_SPLIT_PRESETS.filter(p => !existingIds.has(p.id));
        const merged = [...parsed, ...toAdd];
        persist(merged);
        localStorage.setItem(MIGRATION_KEY, '1');
        return merged;
      }
      localStorage.setItem(MIGRATION_KEY, '1');
    }

    return parsed;
  } catch {
    return DEFAULT_QUICK_PRESETS;
  }
}

function persist(presets: QuickTimePreset[]): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(presets)); } catch { /* ignore */ }
}

export function useQuickTimes() {
  const [presets, setPresets] = useState<QuickTimePreset[]>(() => load());

  const addPreset = useCallback((preset: Omit<QuickTimePreset, 'id'>) => {
    const id = `qt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setPresets(prev => {
      const next = [...prev, { ...preset, id }];
      persist(next);
      return next;
    });
  }, []);

  const updatePreset = useCallback((id: string, changes: Partial<Omit<QuickTimePreset, 'id'>>) => {
    setPresets(prev => {
      const next = prev.map(p => p.id === id ? { ...p, ...changes } : p);
      persist(next);
      return next;
    });
  }, []);

  const deletePreset = useCallback((id: string) => {
    setPresets(prev => {
      const next = prev.filter(p => p.id !== id);
      persist(next);
      return next;
    });
  }, []);

  const movePreset = useCallback((id: string, direction: 'up' | 'down') => {
    setPresets(prev => {
      const idx = prev.findIndex(p => p.id === id);
      if (idx < 0) return prev;
      const next = [...prev];
      const target = direction === 'up' ? idx - 1 : idx + 1;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      persist(next);
      return next;
    });
  }, []);

  const resetToDefaults = useCallback(() => {
    setPresets(DEFAULT_QUICK_PRESETS);
    persist(DEFAULT_QUICK_PRESETS);
    localStorage.setItem(MIGRATION_KEY, '1');
  }, []);

  return { presets, addPreset, updatePreset, deletePreset, movePreset, resetToDefaults };
}
