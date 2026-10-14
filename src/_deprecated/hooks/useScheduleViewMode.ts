import { useState, useCallback } from 'react';

export type ScheduleViewMode = 'classic' | 'modern';

const LS_KEY = 'schedule_view_mode';

function load(): ScheduleViewMode {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === 'modern') return 'modern';
  } catch { /* ignore */ }
  return 'classic';
}

export function useScheduleViewMode() {
  const [mode, setMode] = useState<ScheduleViewMode>(() => load());

  const setViewMode = useCallback((next: ScheduleViewMode) => {
    try { localStorage.setItem(LS_KEY, next); } catch { /* ignore */ }
    setMode(next);
  }, []);

  return { viewMode: mode, setViewMode };
}
