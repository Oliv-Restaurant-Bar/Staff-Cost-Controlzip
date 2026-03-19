import { useState, useEffect, useCallback } from 'react';
import { kvGet, kvSet } from '@/lib/supabase-kv';

export interface ShiftConfigItem {
  name: string;
  start: string;
  end: string;
  start2?: string;  // For split shifts
  end2?: string;    // For split shifts
  hours: number;
  color: string;
  isPaid: boolean;
  countsToTarget: boolean;
  abbrev: string;
  excelColor: string;
  textColor: string;
  department?: 'service' | 'küche' | 'all';  // Department-specific shifts
  fixedHours?: boolean;  // If true, use hours directly without break calculation
}

export interface ShiftConfigMap {
  [key: string]: Omit<ShiftConfigItem, 'name'>;
}

// Break deduction rules (Pausenregelung)
// - ab 5:30 Stunden → 15 Minuten
// - ab 7:00 Stunden → 30 Minuten
// - ab 9:00 Stunden → 60 Minuten
export function calculateBreakDeduction(grossHours: number): number {
  if (grossHours >= 9) {
    return 1; // 60 minutes = 1 hour
  } else if (grossHours >= 7) {
    return 0.5; // 30 minutes
  } else if (grossHours >= 5.5) {
    return 0.25; // 15 minutes
  }
  return 0;
}

// Calculate effective hours with break deduction
export function calculateEffectiveHours(start: string, end: string, start2?: string, end2?: string): number {
  const parseTime = (time: string): number => {
    const [hours, minutes] = time.split(':').map(Number);
    return hours + minutes / 60;
  };

  let grossHours = 0;

  if (start && end) {
    const startTime = parseTime(start);
    let endTime = parseTime(end);
    
    // Handle overnight shifts (e.g., 14:00-02:00)
    if (endTime < startTime) {
      endTime += 24;
    }
    
    grossHours += endTime - startTime;
  }

  // Add second shift part if exists (split shift)
  if (start2 && end2) {
    const startTime2 = parseTime(start2);
    let endTime2 = parseTime(end2);
    
    if (endTime2 < startTime2) {
      endTime2 += 24;
    }
    
    grossHours += endTime2 - startTime2;
  }

  const breakDeduction = calculateBreakDeduction(grossHours);
  return Math.round((grossHours - breakDeduction) * 100) / 100;
}

// Default shift configuration
const DEFAULT_SHIFTS: ShiftConfigItem[] = [
  // === SERVICE Shifts ===
  { 
    name: 'Früh', 
    start: '11:00', 
    end: '15:00', 
    hours: 4, // 4h gross - no break (under 5.5h)
    color: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-300 dark:border-amber-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'FR',
    excelColor: 'FFFEF3C7',
    textColor: 'FF92400E',
    department: 'service'
  },
  { 
    name: 'Spät', 
    start: '17:00', 
    end: '23:00', 
    hours: 5.75, // 6h gross - 15min break = 5.75h
    color: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-300 dark:border-blue-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'SP',
    excelColor: 'FFDBEAFE',
    textColor: 'FF1E40AF',
    department: 'service'
  },
  { 
    name: '11-14 / 17-23:30', 
    start: '11:00', 
    end: '14:00', 
    start2: '17:00',
    end2: '23:30',
    hours: 8.4, // 42h ÷ 5 Tage = 8h 24min = 8.4h (fixed, no break calc)
    color: 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-800 dark:text-cyan-200 border-cyan-300 dark:border-cyan-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'ZI',
    excelColor: 'FFCFFAFE',
    textColor: 'FF155E75',
    department: 'service',
    fixedHours: true
  },

  // === KÜCHE Shifts ===
  { 
    name: '10-14 / 17:30-23', 
    start: '10:00', 
    end: '14:00', 
    start2: '17:30',
    end2: '23:00',
    hours: 8.4, // 42h ÷ 5 Tage = 8h 24min = 8.4h (fixed, no break calc)
    color: 'bg-pink-100 dark:bg-pink-900/40 text-pink-800 dark:text-pink-200 border-pink-300 dark:border-pink-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'GT',
    excelColor: 'FFFCE7F3',
    textColor: 'FF9D174D',
    department: 'küche',
    fixedHours: true
  },
  { 
    name: 'Durchgehend', 
    start: '11:30', 
    end: '21:30', 
    hours: 9, // 10h gross - 1h break = 9h
    color: 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200 border-orange-300 dark:border-orange-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'DG',
    excelColor: 'FFFFEDD5',
    textColor: 'FFC2410C',
    department: 'küche'
  },
  { 
    name: 'Küche Früh', 
    start: '10:00', 
    end: '14:00', 
    hours: 4, // 4h gross - no break
    color: 'bg-lime-100 dark:bg-lime-900/40 text-lime-800 dark:text-lime-200 border-lime-300 dark:border-lime-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'KF',
    excelColor: 'FFECFCCB',
    textColor: 'FF4D7C0F',
    department: 'küche'
  },
  { 
    name: 'Küche Spät', 
    start: '17:30', 
    end: '23:00', 
    hours: 5.25, // 5.5h gross - 15min break = 5.25h
    color: 'bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-200 border-teal-300 dark:border-teal-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'KS',
    excelColor: 'FFCCFBF1',
    textColor: 'FF115E59',
    department: 'küche'
  },
  { 
    name: 'Küche Lang', 
    start: '14:00', 
    end: '23:00', 
    hours: 8.5, // 9h gross - 30min break = 8.5h
    color: 'bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200 border-rose-300 dark:border-rose-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'KL',
    excelColor: 'FFFFE4E6',
    textColor: 'FF9F1239',
    department: 'küche'
  },
  { 
    name: 'Küche Mittag', 
    start: '11:00', 
    end: '14:00', 
    hours: 3, // 3h gross - no break
    color: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-emerald-300 dark:border-emerald-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'KM',
    excelColor: 'FFD1FAE5',
    textColor: 'FF065F46',
    department: 'küche'
  },
  { 
    name: 'Küche Abend', 
    start: '18:30', 
    end: '23:30', 
    hours: 5, // 5h gross - no break (under 5.5h)
    color: 'bg-violet-100 dark:bg-violet-900/40 text-violet-800 dark:text-violet-200 border-violet-300 dark:border-violet-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'KA',
    excelColor: 'FFEDE9FE',
    textColor: 'FF5B21B6',
    department: 'küche'
  },

  // === SHARED Shifts (both departments) ===
  { 
    name: '8.5h Fest', 
    start: '', 
    end: '', 
    hours: 8.5,
    color: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-200 border-indigo-300 dark:border-indigo-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: '8.5',
    excelColor: 'FFE0E7FF',
    textColor: 'FF3730A3',
    department: 'all',
    fixedHours: true
  },
  {
    name: 'Ferien', 
    start: '', 
    end: '', 
    hours: 8.4, 
    color: 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-400 dark:border-gray-500', 
    isPaid: false, 
    countsToTarget: true, 
    abbrev: 'FE',
    excelColor: 'FFE5E7EB',
    textColor: 'FF374151',
    department: 'all'
  },
  { 
    name: 'Krank', 
    start: '', 
    end: '', 
    hours: 8.4, 
    color: 'bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-200 border-gray-400 dark:border-gray-500', 
    isPaid: false, 
    countsToTarget: true, 
    abbrev: 'K',
    excelColor: 'FFD1D5DB',
    textColor: 'FF374151',
    department: 'all'
  },
  { 
    name: 'Frei', 
    start: '', 
    end: '', 
    hours: 0, 
    color: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-200 border-green-300 dark:border-green-600', 
    isPaid: false, 
    countsToTarget: false, 
    abbrev: 'F',
    excelColor: 'FFDCFCE7',
    textColor: 'FF15803D',
    department: 'all'
  },
];

const STORAGE_KEY = 'shift-config';

// Color mapping for excelColor based on tailwind color
const COLOR_TO_EXCEL: Record<string, { excelColor: string; textColor: string }> = {
  'bg-amber-100': { excelColor: 'FFFEF3C7', textColor: 'FF92400E' },
  'bg-blue-100': { excelColor: 'FFDBEAFE', textColor: 'FF1E40AF' },
  'bg-purple-100': { excelColor: 'FFF3E8FF', textColor: 'FF6B21A8' },
  'bg-indigo-100': { excelColor: 'FFE0E7FF', textColor: 'FF3730A3' },
  'bg-green-100': { excelColor: 'FFDCFCE7', textColor: 'FF15803D' },
  'bg-gray-200': { excelColor: 'FFE5E7EB', textColor: 'FF374151' },
  'bg-gray-300': { excelColor: 'FFD1D5DB', textColor: 'FF374151' },
  'bg-red-100': { excelColor: 'FFFEE2E2', textColor: 'FF991B1B' },
  'bg-teal-100': { excelColor: 'FFCCFBF1', textColor: 'FF115E59' },
  'bg-pink-100': { excelColor: 'FFFCE7F3', textColor: 'FF9D174D' },
  'bg-cyan-100': { excelColor: 'FFCFFAFE', textColor: 'FF155E75' },
  'bg-sky-100': { excelColor: 'FFE0F2FE', textColor: 'FF0369A1' },
  'bg-orange-100': { excelColor: 'FFFFEDD5', textColor: 'FFC2410C' },
  'bg-lime-100': { excelColor: 'FFECFCCB', textColor: 'FF4D7C0F' },
};

function getExcelColorsFromTailwind(tailwindColor: string): { excelColor: string; textColor: string } {
  // Extract the base color class (e.g., 'bg-amber-100' from the full color string)
  const match = tailwindColor.match(/bg-(\w+)-(\d+)/);
  if (match) {
    const colorKey = `bg-${match[1]}-${match[2]}`;
    if (COLOR_TO_EXCEL[colorKey]) {
      return COLOR_TO_EXCEL[colorKey];
    }
  }
  // Default fallback
  return { excelColor: 'FFFFFFFF', textColor: 'FF000000' };
}

function loadShiftsFromStorage(): ShiftConfigItem[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as ShiftConfigItem[];
      // Ensure all items have excelColor and textColor
      const enriched = parsed.map(item => {
        if (!item.excelColor || !item.textColor) {
          const colors = getExcelColorsFromTailwind(item.color);
          return { ...item, ...colors };
        }
        return item;
      });
      
      // Merge in any new default shifts that don't exist in storage
      const storedNames = new Set(enriched.map(s => s.name));
      const newDefaults = DEFAULT_SHIFTS.filter(d => !storedNames.has(d.name));
      if (newDefaults.length > 0) {
        const merged = [...enriched, ...newDefaults];
        // Save merged config back to storage
        saveShiftsToStorage(merged);
        return merged;
      }
      
      return enriched;
    }
  } catch (e) {
    console.error('Failed to load shift config from localStorage:', e);
  }
  return DEFAULT_SHIFTS;
}

function saveShiftsToStorage(shifts: ShiftConfigItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shifts));
    // Supabase sync (fire-and-forget)
    kvSet(STORAGE_KEY, shifts).catch(() => {});
  } catch (e) {
    console.error('Failed to save shift config to localStorage:', e);
  }
}

/**
 * Schichtkonfiguration aus Supabase laden (async).
 * Auto-Migration: wenn Supabase leer aber localStorage hat Daten → sync.
 * Gibt null zurück wenn nichts Neues geladen wurde.
 */
async function loadShiftsFromDB(): Promise<ShiftConfigItem[] | null> {
  try {
    const remote = await kvGet(STORAGE_KEY);
    if (remote !== null && Array.isArray(remote) && (remote as ShiftConfigItem[]).length > 0) {
      const shifts = remote as ShiftConfigItem[];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(shifts));
      console.log(`[Schichten] Aus Supabase geladen: ${shifts.length} Schichttypen`);
      return shifts;
    }
    const local = loadShiftsFromStorage();
    const isDefault = local === DEFAULT_SHIFTS;
    if (!isDefault && local.length > 0) {
      console.log(`[Schichten] Supabase leer – sync localStorage→Supabase: ${local.length} Schichttypen`);
      kvSet(STORAGE_KEY, local).catch(() => {});
    } else {
      console.log('[Schichten] Standard-Schichtkonfiguration aktiv, kein Supabase-Sync nötig');
    }
    return null;
  } catch (err) {
    console.error('[Schichten] loadShiftsFromDB Fehler:', err);
    return null;
  }
}

// Convert array to map for easy lookup
function shiftsToMap(shifts: ShiftConfigItem[]): ShiftConfigMap {
  const map: ShiftConfigMap = {};
  for (const shift of shifts) {
    map[shift.name] = {
      start: shift.start,
      end: shift.end,
      start2: shift.start2,
      end2: shift.end2,
      hours: shift.hours,
      color: shift.color,
      isPaid: shift.isPaid,
      countsToTarget: shift.countsToTarget,
      abbrev: shift.abbrev,
      excelColor: shift.excelColor,
      textColor: shift.textColor,
      department: shift.department,
      fixedHours: shift.fixedHours,
    };
  }
  return map;
}

// Get shift names (work shifts first, then absence shifts)
function getShiftNames(shifts: ShiftConfigItem[]): { workShifts: string[]; absenceShifts: string[] } {
  const workShifts = shifts.filter(s => s.start && s.end).map(s => s.name);
  const absenceShifts = shifts.filter(s => !s.start || !s.end).map(s => s.name);
  return { workShifts, absenceShifts };
}

// Get shifts filtered by department
export function getShiftsByDepartment(shifts: ShiftConfigItem[], department: 'service' | 'küche' | 'all'): ShiftConfigItem[] {
  return shifts.filter(s => 
    s.department === 'all' || s.department === department || !s.department
  );
}

export function useShiftConfig() {
  const [shifts, setShifts] = useState<ShiftConfigItem[]>(loadShiftsFromStorage);
  const [shiftMap, setShiftMap] = useState<ShiftConfigMap>(() => shiftsToMap(loadShiftsFromStorage()));

  useEffect(() => {
    // Sync localStorage initial state
    const loaded = loadShiftsFromStorage();
    setShifts(loaded);
    setShiftMap(shiftsToMap(loaded));
    // Dann aus Supabase laden (überschreibt lokalen Stand wenn Supabase neuere Daten hat)
    loadShiftsFromDB().then(dbShifts => {
      if (dbShifts) {
        // Merge in any new defaults that don't exist in stored config
        const storedNames = new Set(dbShifts.map(s => s.name));
        const newDefaults = DEFAULT_SHIFTS.filter(d => !storedNames.has(d.name));
        const merged = newDefaults.length > 0 ? [...dbShifts, ...newDefaults] : dbShifts;
        setShifts(merged);
        setShiftMap(shiftsToMap(merged));
      }
    });
  }, []);

  const updateShifts = useCallback((newShifts: ShiftConfigItem[]) => {
    // Ensure excelColor and textColor
    const enriched = newShifts.map(shift => {
      if (!shift.excelColor || !shift.textColor) {
        const colors = getExcelColorsFromTailwind(shift.color);
        return { ...shift, ...colors };
      }
      return shift;
    });
    
    setShifts(enriched);
    setShiftMap(shiftsToMap(enriched));
    saveShiftsToStorage(enriched);
  }, []);

  const resetToDefaults = useCallback(() => {
    setShifts(DEFAULT_SHIFTS);
    setShiftMap(shiftsToMap(DEFAULT_SHIFTS));
    saveShiftsToStorage(DEFAULT_SHIFTS);
  }, []);

  const { workShifts, absenceShifts } = getShiftNames(shifts);

  return {
    shifts,
    shiftMap,
    workShifts,
    absenceShifts,
    allShiftNames: [...workShifts, ...absenceShifts],
    updateShifts,
    resetToDefaults,
    getShiftsByDepartment: (dept: 'service' | 'küche' | 'all') => getShiftsByDepartment(shifts, dept),
  };
}

// Static function to get shifts (for use outside React components)
export function getShiftConfig(): ShiftConfigItem[] {
  return loadShiftsFromStorage();
}

export function getShiftConfigMap(): ShiftConfigMap {
  return shiftsToMap(loadShiftsFromStorage());
}

export { DEFAULT_SHIFTS };
