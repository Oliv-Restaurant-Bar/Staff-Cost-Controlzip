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

export const DEFAULT_QUICK_PRESETS: QuickTimePreset[] = [
  { id: 'f1', label: '10-14',      start: '10:00', end: '14:00', slotType: 'früh' },
  { id: 'f2', label: '11-14',      start: '11:00', end: '14:00', slotType: 'früh' },
  { id: 'f3', label: '11-15',      start: '11:00', end: '15:00', slotType: 'früh' },
  { id: 'f4', label: '12-15',      start: '12:00', end: '15:00', slotType: 'früh' },
  { id: 's1', label: '17-22',      start: '17:00', end: '22:00', slotType: 'spät' },
  { id: 's2', label: '17-23',      start: '17:00', end: '23:00', slotType: 'spät' },
  { id: 's3', label: '18-22:30',   start: '18:00', end: '22:30', slotType: 'spät' },
  { id: 's4', label: '18-23',      start: '18:00', end: '23:00', slotType: 'spät' },
];

function load(): QuickTimePreset[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_QUICK_PRESETS;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch { /* ignore */ }
  return DEFAULT_QUICK_PRESETS;
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
  }, []);

  return { presets, addPreset, updatePreset, deletePreset, movePreset, resetToDefaults };
}
