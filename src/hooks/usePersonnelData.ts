import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Employee, TimeEntry, DailyBudget, MirusImportEntry, MirusDailyImportEntry, ScheduleImportEntry, RevenueImportEntry, HourlyRevenue } from '@/types/personnel';
import { calculateHours, calculateDailySummary } from '@/lib/personnel-utils';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { toast } from 'sonner';
import { upsertAllEmployees } from '@/lib/supabase-db';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, eachMonthOfInterval, subMonths, addMonths } from 'date-fns';
import { calculateDayNetHours } from '@/hooks/useShiftConfig';
import { supabase } from '@/integrations/supabase/client';
import { useTenant } from '@/contexts/TenantContext';
import type { TenantId } from '@/contexts/TenantContext';

// Storage key used by both SchedulePlanner and usePersonnelData
const EMPLOYEES_STORAGE_KEY = 'schedule-employees';
const DAILY_BUDGETS_KEY = 'dailyBudgets';
const TIME_ENTRIES_KEY = 'timeEntries';

/** Tenant-spezifischer localStorage/KV-Schlüssel für dailyBudgets */
function dailyBudgetsKey(tenantId: string): string {
  return tenantId === 'beaulieu' ? 'beaulieu:dailyBudgets' : DAILY_BUDGETS_KEY;
}

// TimeSlot interface matching ScheduleGrid
interface TimeSlot {
  start: string;
  end: string;
}

// DaySchedule interface matching ScheduleGrid
interface DaySchedule {
  früh?: TimeSlot | null;
  spät?: TimeSlot | null;
  frühAbsence?: string | null;
  spätAbsence?: string | null;
  isAdditionalCostPlan?: boolean;
  isAdditionalCost?: boolean;
  /** Manuelle Pause 1. Einsatz in Minuten (0/30/60); null/undefined = keine manuelle Angabe */
  fruehBreakMinutes?: number | null;
  /** Manuelle Pause 2. Einsatz in Minuten (0/30/60); null/undefined = keine manuelle Angabe */
  spaetBreakMinutes?: number | null;
  /** @deprecated Legacy-Tages-Pause; nur Lese-Fallback in resolveDayBreakHours */
  breakMinutes?: number | null;
}

// Supabase DB employee type
interface DbEmployee {
  id: string;
  name: string;
  department: 'service' | 'kueche';
  employment_type: 'vollzeit' | 'teilzeit' | 'minijob' | 'aushilfe';
  hourly_wage: number;
  weekly_hours: number | null;
  monthly_salary: number | null;
  monthly_salary_with_13th: number | null;
  days_off: string[] | null;
  preferred_work_days: string[] | null;
  hours_balance: number | null;
  vacation_balance: number | null;
  vacation_days_per_year: number | null;
}

// Convert DB employee to frontend Employee type
import { DayOfWeek } from '@/types/personnel';

const dbToFrontendEmployee = (db: DbEmployee): Employee => {
  const storedWage = Number(db.hourly_wage);
  // Falls kein Stundenlohn hinterlegt, aber Monatslohn + Wochenstunden vorhanden:
  // Effektiven Stundenlohn berechnen (Bruttolohn: Monatslohn / monatliche Sollstunden)
  // Formel: Jahresstunden = Wochenstunden × 52, Monatsstunden = / 12
  const derivedWage =
    !storedWage && db.monthly_salary && db.weekly_hours && db.weekly_hours > 0
      ? Math.round((db.monthly_salary / (db.weekly_hours * 52 / 12)) * 100) / 100
      : storedWage;

  return {
    id: db.id,
    name: db.name,
    department: db.department === 'kueche' ? 'küche' : 'service',
    employmentType: db.employment_type,
    hourlyWage: derivedWage,
    weeklyHours: db.weekly_hours ?? undefined,
    monthlySalary: db.monthly_salary ?? undefined,
    monthlySalaryWith13th: db.monthly_salary_with_13th ?? undefined,
    daysOff: (db.days_off as DayOfWeek[]) ?? undefined,
    preferredWorkDays: (db.preferred_work_days as DayOfWeek[]) ?? undefined,
    hoursBalance: db.hours_balance ?? undefined,
    vacationBalance: db.vacation_balance ?? undefined,
    vacationDaysPerYear: db.vacation_days_per_year ?? undefined,
  };
};

// Fallback employees for when Supabase is not available
const defaultEmployees: Employee[] = [
  // === SERVICE ===
  { id: '1', name: 'Mendim', department: 'service', employmentType: 'vollzeit', hourlyWage: 36.92, weeklyHours: 42, monthlySalary: 5538.45, monthlySalaryWith13th: 6203.06 },
  { id: '2', name: 'Artin', department: 'service', employmentType: 'vollzeit', hourlyWage: 33.85, weeklyHours: 42, monthlySalary: 5076.95, monthlySalaryWith13th: 5686.18 },
  { id: '3', name: 'Joana', department: 'service', employmentType: 'teilzeit', hourlyWage: 28.00 },
  { id: '4', name: 'Husein', department: 'service', employmentType: 'vollzeit', hourlyWage: 31.33, weeklyHours: 42, monthlySalary: 5000.00, monthlySalaryWith13th: 5264.00 },
  { id: '5', name: 'Eduard', department: 'service', employmentType: 'vollzeit', hourlyWage: 34.46, weeklyHours: 42, monthlySalary: 5169.25, monthlySalaryWith13th: 5789.56 },
  { id: '6', name: 'Nahuel', department: 'service', employmentType: 'vollzeit', hourlyWage: 28.31, weeklyHours: 42, monthlySalary: 4246.50, monthlySalaryWith13th: 4756.08 },
  { id: '7', name: 'Carlos', department: 'service', employmentType: 'teilzeit', hourlyWage: 24.70 },
  { id: '8', name: 'Arber', department: 'service', employmentType: 'vollzeit', hourlyWage: 30.77, weeklyHours: 42, monthlySalary: 4615.40, monthlySalaryWith13th: 5169.25 },
  { id: '9', name: 'Marion', department: 'service', employmentType: 'vollzeit', hourlyWage: 28.67, weeklyHours: 42, monthlySalary: 4576.95, monthlySalaryWith13th: 4816.00 },
  { id: '10', name: 'Isabel', department: 'service', employmentType: 'teilzeit', hourlyWage: 26.37 },
  { id: '11', name: 'David', department: 'service', employmentType: 'vollzeit', hourlyWage: 31.33, weeklyHours: 42, monthlySalary: 4700.00, monthlySalaryWith13th: 5264.00 },
  { id: '12', name: 'Saad', department: 'service', employmentType: 'vollzeit', hourlyWage: 26.00, weeklyHours: 42, monthlySalary: 3900.00, monthlySalaryWith13th: 4368.00 },
  { id: '13', name: 'Aushilfe Service', department: 'service', employmentType: 'teilzeit', hourlyWage: 20.50 },
  // === KÜCHE ===
  { id: '14', name: 'Mejdi', department: 'küche', employmentType: 'vollzeit', hourlyWage: 0, weeklyHours: 42, monthlySalary: 7400.00, monthlySalaryWith13th: 8288.00, contractType: 'monthly' },
  { id: '15', name: 'Miro', department: 'küche', employmentType: 'vollzeit', hourlyWage: 34.46, weeklyHours: 42, monthlySalary: 5169.00, monthlySalaryWith13th: 5789.28 },
  { id: '16', name: 'Culi', department: 'küche', employmentType: 'vollzeit', hourlyWage: 47.33, weeklyHours: 42, monthlySalary: 7100.00, monthlySalaryWith13th: 7952.00 },
  { id: '17', name: 'Karel', department: 'küche', employmentType: 'vollzeit', hourlyWage: 30.67, weeklyHours: 42, monthlySalary: 4600.00, monthlySalaryWith13th: 5152.00 },
  { id: '18', name: 'Micky', department: 'küche', employmentType: 'vollzeit', hourlyWage: 27.69, weeklyHours: 42, monthlySalary: 4153.85, monthlySalaryWith13th: 4652.31 },
  { id: '19', name: 'Asim', department: 'küche', employmentType: 'vollzeit', hourlyWage: 28.92, weeklyHours: 42, monthlySalary: 4338.45, monthlySalaryWith13th: 4859.06 },
  { id: '20', name: 'Ali', department: 'küche', employmentType: 'teilzeit', hourlyWage: 20.36 },
  { id: '21', name: 'Sadete', department: 'küche', employmentType: 'teilzeit', hourlyWage: 20.36 },
  { id: '24', name: 'Sajed', department: 'küche', employmentType: 'vollzeit', hourlyWage: 20.36 },
  { id: '22', name: 'Aushilfe 1 Küche F', department: 'küche', employmentType: 'teilzeit', hourlyWage: 30.00 },
  { id: '23', name: 'Aushilfe 2 Küche A', department: 'küche', employmentType: 'teilzeit', hourlyWage: 30.00 },
];

// Load employees from Supabase — tenant-filtered
// WICHTIG: Kein Fallback auf Demo-/Defaultdaten. Supabase ist einzige Quelle der Wahrheit.
// Bei Fehler oder leerem Ergebnis → leeres Array zurückgeben (nicht defaultEmployees).
const loadEmployeesFromSupabase = async (restaurantId?: TenantId): Promise<Employee[]> => {
  try {
    console.log(`[CONSISTENCY] tenant: ${restaurantId ?? 'alle'}`);
    console.log('[usePersonnelData] Loading employees from Supabase...');

    let query = supabase.from('employees').select('*').order('name');

    // ─── TENANT FILTER ──────────────────────────────────────────────────────
    // ID-Präfix-Methode: Beaulieu = b-*, Oliv = numerisch (kein b-* Präfix).
    // restaurant_id-Spalte existiert, kann aber NULL sein → ID-Präfix ist zuverlässiger.
    if (restaurantId === 'beaulieu') {
      query = query.like('id', 'b-%');
      console.log('[loadEmployeesFromSupabase] tenant=beaulieu → filter id LIKE b-%');
    } else if (restaurantId === 'oliv') {
      query = query.not('id', 'like', 'b-%');
      console.log('[loadEmployeesFromSupabase] tenant=oliv → filter id NOT LIKE b-%');
    }
    // ────────────────────────────────────────────────────────────────────────

    const { data, error } = await query;

    if (error) {
      console.error('[usePersonnelData] Error loading employees from Supabase — returning empty list (no demo fallback):', error);
      return [];
    }

    if (!data || data.length === 0) {
      console.log('[usePersonnelData] No employees found in Supabase — returning empty list (no demo fallback)');
      return [];
    }

    console.log(`[usePersonnelData] Loaded ${data.length} employees from Supabase`);
    const frontendEmployees = data.map(dbToFrontendEmployee);

    // Präfix-Integritätsprüfung: Warnung bei falschem ID-Format
    if (restaurantId === 'beaulieu') {
      const wrongPrefix = frontendEmployees.filter(e => !String(e.id).startsWith('b-'));
      if (wrongPrefix.length > 0) {
        console.warn(
          `[ID-INTEGRITY] WARNUNG: ${wrongPrefix.length} Beaulieu-Mitarbeiter ohne b-Präfix gefunden!`,
          wrongPrefix.map(e => `id=${e.id} name="${e.name}"`)
        );
      }
    } else if (restaurantId === 'oliv') {
      const wrongPrefix = frontendEmployees.filter(e => String(e.id).startsWith('b-'));
      if (wrongPrefix.length > 0) {
        console.warn(
          `[ID-INTEGRITY] WARNUNG: ${wrongPrefix.length} Oliv-Mitarbeiter mit b-Präfix gefunden!`,
          wrongPrefix.map(e => `id=${e.id} name="${e.name}"`)
        );
      }
    }

    // Oliv-Leak-Check wenn Beaulieu aktiv
    if (restaurantId === 'beaulieu') {
      const names = frontendEmployees.map(e => e.name);
      const olivNames = ['arber', 'artin', 'carlos', 'mendim', 'joana', 'husein', 'mejdi', 'miro', 'culi'];
      const leaked = names.filter(n => olivNames.some(o => n.toLowerCase().includes(o)));
      if (leaked.length > 0) {
        console.error(`[CONSISTENCY] mismatch: yes – Oliv-Mitarbeiter in Beaulieu-Abfrage: ${leaked.join(', ')}`);
      } else {
        console.log('[CONSISTENCY] mismatch: no');
      }
      console.log(`[CONSISTENCY] personal_fix employees: ${frontendEmployees.length}`);
      console.log(`[CONSISTENCY] employee names: ${names.join(', ')}`);
    }

    console.log('[usePersonnelData] Küche employees:', frontendEmployees.filter(e => e.department === 'küche').map(e => e.name));
    return frontendEmployees;
  } catch (err) {
    console.error('[usePersonnelData] Failed to load employees from Supabase:', err);
    return tenantFallback;
  }
};

// Load schedule entries from Supabase and convert to TimeEntries
const loadScheduleEntriesFromSupabase = async (employees: Employee[]): Promise<TimeEntry[]> => {
  try {
    console.log('[usePersonnelData] Loading schedule entries from Supabase...');
    const { data, error } = await supabase
      .from('schedule_entries')
      .select('*');
    
    if (error) {
      console.error('[usePersonnelData] Error loading schedule entries from Supabase:', error);
      return [];
    }
    
    if (!data || data.length === 0) {
      console.log('[usePersonnelData] No schedule entries found in Supabase');
      return [];
    }
    
    console.log(`[usePersonnelData] Loaded ${data.length} schedule entries from Supabase`);
    
    const timeEntries: TimeEntry[] = [];
    
    for (const entry of data) {
      const daySchedule: DaySchedule = {
        früh: entry.frueh_start && entry.frueh_end 
          ? { start: entry.frueh_start.slice(0, 5), end: entry.frueh_end.slice(0, 5) }
          : null,
        spät: entry.spaet_start && entry.spaet_end
          ? { start: entry.spaet_start.slice(0, 5), end: entry.spaet_end.slice(0, 5) }
          : null,
        frühAbsence: entry.frueh_absence,
        spätAbsence: entry.spaet_absence,
      };
      
      // Skip if no actual schedule data
      if (!daySchedule.früh && !daySchedule.spät) continue;
      
      // Calculate hours
      const hours = calculateDayHoursInternal(daySchedule);
      
      // Determine start/end display times
      let plannedStart = '';
      let plannedEnd = '';
      
      if (hours.frühStart && hours.spätEnd) {
        plannedStart = hours.frühStart;
        plannedEnd = hours.spätEnd;
      } else if (hours.frühStart && hours.frühEnd) {
        plannedStart = hours.frühStart;
        plannedEnd = hours.frühEnd;
      } else if (hours.spätStart && hours.spätEnd) {
        plannedStart = hours.spätStart;
        plannedEnd = hours.spätEnd;
      }
      
      if (hours.total > 0 || plannedStart) {
        timeEntries.push({
          id: `schedule_${entry.employee_id}_${entry.date}`,
          employeeId: entry.employee_id,
          date: entry.date,
          plannedStart,
          plannedEnd,
          plannedHours: hours.total,
        });
      }
    }
    
    return timeEntries;
  } catch (err) {
    console.error('Failed to load schedule entries from Supabase:', err);
    return [];
  }
};

// Helper to calculate day NET hours (internal version for Supabase loading) — SSoT
const calculateDayHoursInternal = (daySchedule: DaySchedule): { total: number; frühStart?: string; frühEnd?: string; spätStart?: string; spätEnd?: string } => {
  const total = calculateDayNetHours(daySchedule);
  
  return {
    total,
    frühStart: daySchedule.früh?.start,
    frühEnd: daySchedule.früh?.end,
    spätStart: daySchedule.spät?.start,
    spätEnd: daySchedule.spät?.end,
  };
};

// Helper to calculate slot hours (internal version)
const calculateSlotHoursInternal = (slot: TimeSlot | null | undefined): number => {
  if (!slot?.start || !slot?.end) return 0;
  const [startH, startM] = slot.start.split(':').map(Number);
  const [endH, endM] = slot.end.split(':').map(Number);
  let hours = endH - startH + (endM - startM) / 60;
  if (hours < 0) hours += 24;
  return Math.round(hours * 100) / 100;
};

// Legacy: Load employees from localStorage (Cache-only — KEIN Merge mit defaultEmployees)
// WICHTIG: Nur bereits gecachte Supabase-Daten lesen. Niemals defaultEmployees einmischen.
// Nur für Connectivity-Fallback wenn Supabase temporär nicht erreichbar.
const loadEmployeesFromStorage = (): Employee[] => {
  if (typeof window === 'undefined') return [];

  try {
    const stored = localStorage.getItem(EMPLOYEES_STORAGE_KEY);
    if (!stored) return [];

    const storedEmployees: Employee[] = JSON.parse(stored);

    // Hinweis: per-MA socialCostFactor wird nicht mehr gelesen/migriert —
    // AG-Sozialkosten kommen zentral aus den Einstellungen (useSocialCostRates).

    // Guard: Demo-/Default-Mitarbeiter (IDs 1–24) aus dem Cache filtern falls vorhanden.
    // Diese dürfen niemals als echte Mitarbeiter erscheinen.
    const defaultIds = new Set(['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24']);
    const safeEmployees = storedEmployees.filter(e => !defaultIds.has(e.id));
    if (safeEmployees.length !== storedEmployees.length) {
      console.warn(`[loadEmployeesFromStorage] ${storedEmployees.length - safeEmployees.length} Demo-Mitarbeiter aus localStorage-Cache entfernt`);
      localStorage.setItem(EMPLOYEES_STORAGE_KEY, JSON.stringify(safeEmployees));
    }

    return safeEmployees;
  } catch {
    return [];
  }
};

// Calculate hours from a time slot
const calculateSlotHours = (slot: TimeSlot | null | undefined): number => {
  if (!slot?.start || !slot?.end) return 0;
  const [startH, startM] = slot.start.split(':').map(Number);
  const [endH, endM] = slot.end.split(':').map(Number);
  let hours = endH - startH + (endM - startM) / 60;
  if (hours < 0) hours += 24;
  return Math.round(hours * 100) / 100;
};

// Calculate total NET hours for a day (früh + spät) — SSoT calculateDayNetHours
const calculateDayHours = (daySchedule: DaySchedule): { total: number; frühStart?: string; frühEnd?: string; spätStart?: string; spätEnd?: string } => {
  const total = calculateDayNetHours(daySchedule);
  
  return {
    total,
    frühStart: daySchedule.früh?.start,
    frühEnd: daySchedule.früh?.end,
    spätStart: daySchedule.spät?.start,
    spätEnd: daySchedule.spät?.end,
  };
};

// Convert schedule data (schedule-v2-*) to time entries
const convertScheduleToTimeEntries = (employees: Employee[]): TimeEntry[] => {
  const timeEntries: TimeEntry[] = [];
  if (typeof window === 'undefined') return timeEntries;

  // Read ALL stored months instead of a fixed window around "today"
  const scheduleKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('schedule-v2-')) scheduleKeys.push(k);
  }

  for (const storageKey of scheduleKeys) {
    const savedSchedule = localStorage.getItem(storageKey);
    if (!savedSchedule) continue;

    try {
      const scheduleData: Record<string, DaySchedule> = JSON.parse(savedSchedule);

      for (const [cellKey, daySchedule] of Object.entries(scheduleData)) {
        if (!daySchedule) continue;
        if (!daySchedule.früh && !daySchedule.spät) continue;

        // cellKey is `${employeeId}-${yyyy-MM-dd}`
        const splitIdx = cellKey.indexOf('-');
        if (splitIdx === -1) continue;

        const employeeId = cellKey.slice(0, splitIdx);
        const dateStr = cellKey.slice(splitIdx + 1);

        const employeeExists = employees.some((e) => e.id === employeeId);
        if (!employeeExists) continue;

        const hours = calculateDayHours(daySchedule);

        // Determine start/end display times
        let plannedStart = '';
        let plannedEnd = '';

        if (hours.frühStart && hours.spätEnd) {
          plannedStart = hours.frühStart;
          plannedEnd = hours.spätEnd;
        } else if (hours.frühStart && hours.frühEnd) {
          plannedStart = hours.frühStart;
          plannedEnd = hours.frühEnd;
        } else if (hours.spätStart && hours.spätEnd) {
          plannedStart = hours.spätStart;
          plannedEnd = hours.spätEnd;
        }

        if (hours.total > 0 || plannedStart) {
          timeEntries.push({
            id: `schedule_${employeeId}_${dateStr}`,
            employeeId,
            date: dateStr,
            plannedStart,
            plannedEnd,
            plannedHours: hours.total,
          });
        }
      }
    } catch (e) {
      console.error(`Error parsing schedule for ${storageKey}:`, e);
    }
  }

  return timeEntries;
};

// Load daily budgets from localStorage (tenant-aware key)
const loadDailyBudgetsFromStorage = (key: string = DAILY_BUDGETS_KEY): {[key: string]: DailyBudget} => {
  if (typeof window === 'undefined') return {};
  
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  return {};
};

// Load manually entered time entries from localStorage
const loadTimeEntriesFromStorage = (): TimeEntry[] => {
  if (typeof window === 'undefined') return [];
  
  try {
    const stored = localStorage.getItem(TIME_ENTRIES_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  return [];
};

// Merge schedule-based time entries with manual entries
// Manual entries take precedence for BOTH planned + actual fields.
// IMPORTANT: Deduplication - only one entry per employee per date
const mergeTimeEntries = (scheduleEntries: TimeEntry[], manualEntries: TimeEntry[]): TimeEntry[] => {
  const entriesByKey = new Map<string, TimeEntry>();

  // First, add all schedule entries
  for (const entry of scheduleEntries) {
    const key = `${entry.employeeId}-${entry.date}`;
    entriesByKey.set(key, entry);
  }

  // Then, overlay manual entries (they take precedence)
  for (const manualEntry of manualEntries) {
    const key = `${manualEntry.employeeId}-${manualEntry.date}`;
    const existing = entriesByKey.get(key);

    if (existing) {
      // Merge: manual values override schedule values where present
      entriesByKey.set(key, {
        ...existing,
        // planned overrides (if present in manual and not empty/0)
        plannedStart: manualEntry.plannedStart || existing.plannedStart,
        plannedEnd: manualEntry.plannedEnd || existing.plannedEnd,
        plannedHours: (manualEntry.plannedHours && manualEntry.plannedHours > 0) 
          ? manualEntry.plannedHours 
          : existing.plannedHours,
        // actual overrides (always prefer manual)
        actualStart: manualEntry.actualStart ?? existing.actualStart,
        actualEnd: manualEntry.actualEnd ?? existing.actualEnd,
        actualHours: manualEntry.actualHours ?? existing.actualHours,
        break: manualEntry.break ?? existing.break,
      });
    } else {
      // No schedule entry, just add manual
      entriesByKey.set(key, manualEntry);
    }
  }

  return Array.from(entriesByKey.values());
};

const today = format(new Date(), 'yyyy-MM-dd');

const sampleTimeEntries: TimeEntry[] = [];

export const usePersonnelData = () => {
  const { tenantId } = useTenant();
  // Zentrale AG-Sozialkostensätze — Kostenbasis = Total Arbeitgeberkosten.
  const { rates: socialCostRates } = useSocialCostRates();
  // Start empty — Supabase will populate with tenant-correct data.
  // Never pre-fill with Oliv defaultEmployees (they would show as initial state for Beaulieu).
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>(sampleTimeEntries);
  const [manualTimeEntries, setManualTimeEntries] = useState<TimeEntry[]>([]);
  const [dailyBudgets, setDailyBudgets] = useState<{ [key: string]: DailyBudget }>({});

  // Keep latest state in refs for event handlers
  const employeesRef = useRef(employees);
  const manualRef = useRef(manualTimeEntries);
  useEffect(() => {
    employeesRef.current = employees;
  }, [employees]);
  useEffect(() => {
    manualRef.current = manualTimeEntries;
  }, [manualTimeEntries]);

  // Generation-Guard: eine späte Antwort (z.B. nach Mandantenwechsel) darf den
  // State des neueren Sync-Laufs / des anderen Mandanten nicht überschreiben.
  const syncGeneration = useRef(0);

  // Sync data from Supabase and localStorage — tenant-aware
  const syncFromSupabase = useCallback(async () => {
    const gen = ++syncGeneration.current;
    try {
      console.log(`[usePersonnelData] Starting sync from Supabase (tenant: ${tenantId})...`);

      // Load employees from Supabase — always pass tenantId so filter is applied
      const supabaseEmployees = await loadEmployeesFromSupabase(tenantId);
      console.log(`[usePersonnelData] Got ${supabaseEmployees.length} employees`);
      
      // Load schedule entries from Supabase and convert to time entries
      const supabaseScheduleEntries = await loadScheduleEntriesFromSupabase(supabaseEmployees);
      console.log(`[usePersonnelData] Got ${supabaseScheduleEntries.length} time entries from schedule`);
      
      // Tenant-spezifischer Key für dailyBudgets
      const budgetKey = dailyBudgetsKey(tenantId);

      // 1. Lokaler Cache (schnell)
      const localBudgets = loadDailyBudgetsFromStorage(budgetKey);

      // 2. Supabase KV — Quelle der Wahrheit für Umsatzdaten
      let kvBudgets: Record<string, DailyBudget> = {};
      try {
        const { kvGet } = await import('@/lib/supabase-kv');
        const remote = await kvGet(budgetKey);
        if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
          kvBudgets = remote as Record<string, DailyBudget>;
          console.log(`[usePersonnelData] KV budgets loaded: ${Object.keys(kvBudgets).length} Tage (key: ${budgetKey})`);
        }
      } catch (kvErr) {
        console.warn('[usePersonnelData] KV load failed, using localStorage fallback:', kvErr);
      }

      // 3. Merge: KV gewinnt für alle bestehenden Einträge (ist der Master).
      //    Lokale Werte füllen nur Lücken die KV nicht kennt.
      const mergedBudgets: Record<string, DailyBudget> = { ...localBudgets };
      for (const [date, kvDay] of Object.entries(kvBudgets)) {
        const localDay = localBudgets[date] ?? {} as DailyBudget;
        // KV-Felder überschreiben lokale Felder vollständig
        mergedBudgets[date] = { ...localDay, ...kvDay } as DailyBudget;
      }

      // 4. localStorage mit authoritivem Stand synchronisieren
      try { localStorage.setItem(budgetKey, JSON.stringify(mergedBudgets)); } catch { /* ignore */ }

      const loadedManualEntries = loadTimeEntriesFromStorage();

      if (gen !== syncGeneration.current) {
        console.log('[usePersonnelData] Stale sync verworfen (neuerer Lauf aktiv)');
        return;
      }

      // Set employees from Supabase
      setEmployees(supabaseEmployees);
      setDailyBudgets(mergedBudgets);
      setManualTimeEntries(loadedManualEntries);
      
      // Merge Supabase schedule entries with manual entries
      const mergedEntries = mergeTimeEntries(supabaseScheduleEntries, loadedManualEntries);
      console.log(`[usePersonnelData] Merged time entries: ${mergedEntries.length}`);
      setTimeEntries(mergedEntries);
      
      console.log('[usePersonnelData] Sync complete!');
    } catch (err) {
      console.error('[usePersonnelData] Error syncing from Supabase:', err);
      if (gen !== syncGeneration.current) return; // stale — nicht überschreiben
      // Fallback to localStorage (Beaulieu: empty rather than Oliv defaults)
      if (tenantId === 'beaulieu') {
        setEmployees([]);
      } else {
        syncFromStorageFallback();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // Fallback sync from localStorage (if Supabase fails)
  const syncFromStorageFallback = useCallback(() => {
    const loadedEmployees = loadEmployeesFromStorage();
    const loadedBudgets = loadDailyBudgetsFromStorage(dailyBudgetsKey(tenantId));
    const loadedManualEntries = loadTimeEntriesFromStorage();

    setEmployees(loadedEmployees);
    setDailyBudgets(loadedBudgets);
    setManualTimeEntries(loadedManualEntries);

    const scheduleEntries = convertScheduleToTimeEntries(loadedEmployees);
    setTimeEntries(mergeTimeEntries(scheduleEntries, loadedManualEntries));
  }, [tenantId]);

  // Initial load from Supabase — isInitialized nur setzen, wenn der Lauf noch
  // der aktuelle ist (sonst könnten Persistenz-Effekte mit altem State unter
  // dem neuen Tenant-Key laufen).
  useEffect(() => {
    const gen = syncGeneration.current + 1; // syncFromSupabase inkrementiert gleich
    syncFromSupabase().then(() => {
      if (syncGeneration.current === gen) setIsInitialized(true);
    });
  }, [syncFromSupabase]);

  // React immediately when SchedulePlanner updates (same tab)
  useEffect(() => {
    const onScheduleUpdated = () => syncFromSupabase();
    window.addEventListener('schedule-updated', onScheduleUpdated);
    return () => window.removeEventListener('schedule-updated', onScheduleUpdated);
  }, [syncFromSupabase]);

  // Tagesumsatz aus KV nachladen wenn ein Import abgeschlossen wurde.
  // GastronoviImportSection und andere Import-Flows feuern 'supabase-kv-synced'
  // nach dem Schreiben in Supabase. Ohne diesen Listener würde der Dashboard-
  // State veraltete Werte zeigen bis zur nächsten vollständigen Seiten-Reload.
  useEffect(() => {
    const budgetKey = dailyBudgetsKey(tenantId);
    let alive = true; // Mandantenwechsel/Unmount: späte KV-Antwort verwerfen
    const reloadBudgetsFromKV = async () => {
      try {
        const { kvGet } = await import('@/lib/supabase-kv');
        const remote = await kvGet(budgetKey);
        if (!alive) return;
        if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
          const kvBudgets = remote as Record<string, DailyBudget>;
          setDailyBudgets(prev => {
            // KV-Felder gewinnen über lokalen State
            const merged = { ...prev };
            for (const [date, kvDay] of Object.entries(kvBudgets)) {
              merged[date] = { ...(prev[date] ?? {} as DailyBudget), ...kvDay } as DailyBudget;
            }
            // Auch localStorage aktualisieren
            try { localStorage.setItem(budgetKey, JSON.stringify(merged)); } catch { /* ignore */ }
            return merged;
          });
        }
      } catch { /* ignore – stale state bleibt sichtbar */ }
    };
    window.addEventListener('supabase-kv-synced', reloadBudgetsFromKV);
    return () => {
      alive = false;
      window.removeEventListener('supabase-kv-synced', reloadBudgetsFromKV);
    };
  }, [tenantId]);

  // React to changes from other tabs/windows
  useEffect(() => {
    const budgetKey = dailyBudgetsKey(tenantId);
    const onStorage = (e: StorageEvent) => {
      if (!e.key) return;
      if (
        e.key === EMPLOYEES_STORAGE_KEY ||
        e.key === budgetKey ||
        e.key === TIME_ENTRIES_KEY ||
        e.key.startsWith('schedule-v2-')
      ) {
        syncFromSupabase();
      }
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [syncFromSupabase, tenantId]);

  // Sync employees to localStorage whenever they change (after initial load).
  // WICHTIG: Kein Supabase-Schreibzugriff hier!
  // employees darf nur noch über explizite Admin-Aktionen im Personalstamm geschrieben werden.
  // Ein automatischer upsertAllEmployees-Aufruf hier kann:
  //  a) Veraltete localStorage-Daten (ohne employment_end_date) nach Supabase schreiben
  //  b) Archivierte Mitarbeiter (z.B. Ali) reaktivieren
  //  c) Unbekannte Demo/Seed-Einträge ins System einschleusen
  useEffect(() => {
    if (isInitialized) {
      localStorage.setItem(EMPLOYEES_STORAGE_KEY, JSON.stringify(employees));
      // upsertAllEmployees(employees, tenantId); // BLOCKIERT — nur Personalstamm schreibt employees
    }
  }, [employees, isInitialized, tenantId]);

  // Sync daily budgets to localStorage and Supabase.
  // WICHTIG: Nur schreiben wenn der Blob tatsächlich Daten enthält.
  // Ein leerer Blob (frischer Login) darf den bestehenden Supabase-Stand NICHT überschreiben.
  // Nur Lohnkosten-Felder werden in KV geschrieben — Revenue-Felder NIEMALS von diesem Hook.
  useEffect(() => {
    if (isInitialized && Object.keys(dailyBudgets).length > 0) {
      const budgetKey = dailyBudgetsKey(tenantId);
      // localStorage aktualisieren — dient als schneller Cache
      try { localStorage.setItem(budgetKey, JSON.stringify(dailyBudgets)); } catch { /* ignore */ }
      // KV: nur Lohnkosten-Felder schreiben (Revenue-Felder bleiben aus KV, nie überschreiben)
      import('@/lib/supabase-kv').then(({ kvGet, kvSet }) => {
        kvGet(budgetKey).then(remote => {
          const base = (remote && typeof remote === 'object' && !Array.isArray(remote))
            ? remote as Record<string, Record<string, unknown>>
            : {};
          const merged: Record<string, Record<string, unknown>> = { ...base };
          for (const [day, data] of Object.entries(dailyBudgets)) {
            const existing = base[day] ?? {};
            // Nur Lohnkosten-Felder aktualisieren — Revenue-Felder (actualRevenue, etc.)
            // bleiben aus KV erhalten und werden NICHT von lokalem State überschrieben.
            merged[day] = {
              ...existing,
              plannedLaborCost: (data as Record<string, unknown>).plannedLaborCost ?? existing.plannedLaborCost ?? 0,
              actualLaborCost:  (data as Record<string, unknown>).actualLaborCost  ?? existing.actualLaborCost  ?? 0,
            };
          }
          kvSet(budgetKey, merged).catch(() => {});
        }).catch(() => {});
      });
    }
  }, [dailyBudgets, isInitialized, tenantId]);

  // Sync manual time entries to localStorage
  useEffect(() => {
    if (isInitialized) {
      localStorage.setItem(TIME_ENTRIES_KEY, JSON.stringify(manualTimeEntries));
    }
  }, [manualTimeEntries, isInitialized]);

  const addEmployee = useCallback((employee: Omit<Employee, 'id'>) => {
    // Beaulieu-Mitarbeiter müssen eine b-* ID bekommen, sonst filtert
    // loadEmployees('beaulieu') sie beim nächsten Laden heraus (id LIKE 'b-%').
    const prefix = tenantId === 'beaulieu' ? 'b-emp_' : 'emp_';
    const id = `${prefix}${Date.now()}`;
    console.log(`[addEmployee] tenant=${tenantId} id=${id} name=${employee.name}`);
    setEmployees((prev) => [...prev, { ...employee, id }]);
    return id;
  }, [tenantId]);

  const updateEmployee = useCallback((employee: Employee) => {
    setEmployees((prev) =>
      prev.map((e) => (e.id === employee.id ? employee : e))
    );
  }, []);

  const deleteEmployee = useCallback((employeeId: string) => {
    setEmployees((prev) => prev.filter((e) => e.id !== employeeId));
    setTimeEntries((prev) => prev.filter((t) => t.employeeId !== employeeId));
    setManualTimeEntries((prev) => prev.filter((t) => t.employeeId !== employeeId));
  }, []);

  const updateTimeEntry = useCallback(
    (entryId: string, field: 'actualStart' | 'actualEnd' | 'actualHours', value: string | number) => {
      // Update in merged time entries for display
      setTimeEntries((prev) =>
        prev.map((entry) => {
          if (entry.id !== entryId) return entry;

          const updated = { ...entry, [field]: value };

          // Recalculate actual hours if both times are set (not if hours was set directly)
          if (field !== 'actualHours' && updated.actualStart && updated.actualEnd) {
            updated.actualHours = calculateHours(
              updated.actualStart,
              updated.actualEnd,
              updated.break || 0
            );
          }

          return updated;
        })
      );
      
      // Also update or create in manual entries for persistence
      setManualTimeEntries((prev) => {
        const existingEntry = prev.find(e => e.id === entryId);
        const sourceEntry = timeEntries.find(e => e.id === entryId);
        
        if (existingEntry) {
          // Update existing manual entry
          return prev.map((entry) => {
            if (entry.id !== entryId) return entry;

            const updated = { ...entry, [field]: value };

            if (field !== 'actualHours' && updated.actualStart && updated.actualEnd) {
              updated.actualHours = calculateHours(
                updated.actualStart,
                updated.actualEnd,
                updated.break || 0
              );
            }

            return updated;
          });
        } else if (sourceEntry) {
          // Create new manual entry from schedule entry
          const newEntry = { ...sourceEntry, [field]: value };
          
          if (field !== 'actualHours' && newEntry.actualStart && newEntry.actualEnd) {
            newEntry.actualHours = calculateHours(
              newEntry.actualStart,
              newEntry.actualEnd,
              newEntry.break || 0
            );
          }
          
          // Generate a new ID for the manual entry but link to same employee/date
          const manualEntry: TimeEntry = {
            id: `manual_${sourceEntry.employeeId}_${sourceEntry.date}`,
            employeeId: sourceEntry.employeeId,
            date: sourceEntry.date,
            plannedStart: sourceEntry.plannedStart,
            plannedEnd: sourceEntry.plannedEnd,
            plannedHours: sourceEntry.plannedHours,
            actualStart: newEntry.actualStart,
            actualEnd: newEntry.actualEnd,
            actualHours: newEntry.actualHours,
            break: newEntry.break,
          };
          
          return [...prev, manualEntry];
        }
        
        return prev;
      });
    },
    [timeEntries]
  );

  const updatePlannedTime = useCallback(
    (entryId: string, field: 'plannedStart' | 'plannedEnd' | 'plannedHours', value: string | number) => {
      // Update in merged time entries for display
      setTimeEntries((prev) =>
        prev.map((entry) => {
          if (entry.id !== entryId) return entry;

          const updated = { ...entry, [field]: value } as TimeEntry;

          // Recalculate planned hours if both times are set and hours field is not directly edited
          if (field !== 'plannedHours' && updated.plannedStart && updated.plannedEnd) {
            updated.plannedHours = calculateHours(updated.plannedStart, updated.plannedEnd, updated.break || 0);
          }

          return updated;
        })
      );

      // Also persist planned edits in manual entries (so they survive re-sync)
      setManualTimeEntries((prev) => {
        const sourceEntry = timeEntries.find((e) => e.id === entryId);
        if (!sourceEntry) return prev;

        const key = `${sourceEntry.employeeId}-${sourceEntry.date}`;
        const existingIdx = prev.findIndex((e) => `${e.employeeId}-${e.date}` === key);

        const base: TimeEntry = existingIdx >= 0
          ? prev[existingIdx]
          : {
              id: `manual_${sourceEntry.employeeId}_${sourceEntry.date}`,
              employeeId: sourceEntry.employeeId,
              date: sourceEntry.date,
              plannedStart: sourceEntry.plannedStart,
              plannedEnd: sourceEntry.plannedEnd,
              plannedHours: sourceEntry.plannedHours,
              actualStart: sourceEntry.actualStart,
              actualEnd: sourceEntry.actualEnd,
              actualHours: sourceEntry.actualHours,
              break: sourceEntry.break,
            };

        const updated = { ...base, [field]: value } as TimeEntry;
        if (field !== 'plannedHours' && updated.plannedStart && updated.plannedEnd) {
          updated.plannedHours = calculateHours(updated.plannedStart, updated.plannedEnd, updated.break || 0);
        }

        if (existingIdx >= 0) {
          return prev.map((e, idx) => (idx === existingIdx ? updated : e));
        }
        return [...prev, updated];
      });
    },
    [timeEntries]
  );

  const deleteTimeEntry = useCallback((entryId: string) => {
    setTimeEntries((prev) => prev.filter((entry) => entry.id !== entryId));
    setManualTimeEntries((prev) => prev.filter((entry) => entry.id !== entryId));
    toast.success('Zeiteintrag gelöscht');
  }, []);

  const addTimeEntry = useCallback((entry: Omit<TimeEntry, 'id'>) => {
    const id = `manual_${Date.now()}`;
    const newEntry = { ...entry, id };
    
    // Add to both merged entries and manual entries
    setTimeEntries((prev) => [...prev, newEntry]);
    setManualTimeEntries((prev) => [...prev, newEntry]);
    
    return id;
  }, []);

  const updateBudget = useCallback(
    (date: string, field: 'plannedRevenue' | 'actualRevenue' | 'previousYearRevenue', value: number) => {
      setDailyBudgets((prev) => ({
        ...prev,
        [date]: {
          ...(prev[date] || {
            date,
            plannedRevenue: 0,
            actualRevenue: 0,
            previousYearRevenue: 0,
            plannedLaborCost: 0,
            actualLaborCost: 0,
          }),
          [field]: value,
        },
      }));
    },
    []
  );

  const setFixedBudget = useCallback(
    (date: string, value: number) => {
      setDailyBudgets((prev) => ({
        ...prev,
        [date]: {
          ...(prev[date] || {
            date,
            plannedRevenue: 0,
            actualRevenue: 0,
            previousYearRevenue: 0,
            plannedLaborCost: 0,
            actualLaborCost: 0,
          }),
          fixedBudget: value,
        },
      }));
    },
    []
  );

  const updateHourlyRevenue = useCallback(
    (date: string, hourlyRevenue: HourlyRevenue[], totalRevenue: number, totalFood?: number, totalBeverage?: number) => {
      setDailyBudgets((prev) => ({
        ...prev,
        [date]: {
          ...(prev[date] || {
            date,
            plannedRevenue: 0,
            actualRevenue: 0,
            previousYearRevenue: 0,
            plannedLaborCost: 0,
            actualLaborCost: 0,
          }),
          actualRevenue: totalRevenue,
          hourlyRevenue,
        },
      }));
    },
    []
  );

  const getDailySummary = useCallback(
    (date: string) => {
      const dayEntries = timeEntries.filter((e) => e.date === date);
      const budget = dailyBudgets[date] || {
        plannedRevenue: 0,
        actualRevenue: 0,
      };

      return calculateDailySummary(
        dayEntries,
        employees,
        budget.plannedRevenue,
        budget.actualRevenue,
        socialCostRates
      );
    },
    [timeEntries, employees, dailyBudgets, socialCostRates]
  );

  const importScheduleData = useCallback(
    (text: string, type: 'mirus' | 'schedule') => {
      console.log(`Importing ${type} data:`, text);
      // Here you would parse the text and create/update time entries
      // For now, we'll just log it
    },
    []
  );

  // DEPRECATED: Use importMirusDailyData instead for daily imports
  // This function is kept for backwards compatibility
  const importMirusData = useCallback(
    (entries: MirusImportEntry[], date: string) => {
      let matchedCount = 0;
      let updatedCount = 0;
      let unmatchedNames: string[] = [];
      
      // Deduplicate: take last entry per employee for the same date
      const deduplicatedEntries = new Map<string, MirusImportEntry>();
      entries.forEach((entry) => {
        deduplicatedEntries.set(entry.name.toLowerCase(), entry);
      });

      deduplicatedEntries.forEach((entry) => {
        // Find matching employee by name
        const employee = employees.find((emp) => {
          const empNameParts = emp.name.toLowerCase().split(' ');
          const entryNameParts = entry.name.toLowerCase().split(' ');
          return empNameParts.some((part) =>
            entryNameParts.some((entryPart) => 
              part.includes(entryPart) || entryPart.includes(part)
            )
          );
        });

        if (employee) {
          // Check if time entry exists for this employee on this date
          const existingEntry = timeEntries.find(
            (te) => te.employeeId === employee.id && te.date === date
          );

          if (existingEntry) {
            // Update actual hours - NO DUPLICATE
            setTimeEntries((prev) =>
              prev.map((te) =>
                te.employeeId === employee.id && te.date === date
                  ? { ...te, actualHours: entry.hours }
                  : te
              )
            );
            updatedCount++;
          } else {
            // Create new time entry with actual hours
            const id = `time_${employee.id}_${date}`;
            setTimeEntries((prev) => {
              // Extra check to prevent duplicates
              if (prev.some(te => te.employeeId === employee.id && te.date === date)) {
                return prev.map(te => 
                  te.employeeId === employee.id && te.date === date
                    ? { ...te, actualHours: entry.hours }
                    : te
                );
              }
              return [
                ...prev,
                {
                  id,
                  employeeId: employee.id,
                  date,
                  plannedStart: '',
                  plannedEnd: '',
                  plannedHours: 0,
                  actualHours: entry.hours,
                },
              ];
            });
          }
          matchedCount++;
        } else {
          unmatchedNames.push(entry.name);
        }
      });

      if (matchedCount > 0) {
        toast.success(`${matchedCount} Arbeitszeiten ${updatedCount > 0 ? 'aktualisiert' : 'importiert'}`);
      }
      if (unmatchedNames.length > 0) {
        toast.warning(`${unmatchedNames.length} Mitarbeiter nicht gefunden: ${unmatchedNames.slice(0, 3).join(', ')}${unmatchedNames.length > 3 ? '...' : ''}`);
      }
    },
    [employees, timeEntries]
  );

  const importSchedulePDF = useCallback(
    (entries: ScheduleImportEntry[]) => {
      let matchedCount = 0;
      const unmatchedNames: string[] = [];
      const processedEmployees = new Set<string>();

      const normalizeTime = (t?: string) => {
        const raw = String(t ?? '').trim();
        if (!raw) return '';
        if (raw.includes(':')) {
          const [h, m] = raw.split(':');
          return `${String(parseInt(h, 10)).padStart(2, '0')}:${String(parseInt(m ?? '0', 10)).padStart(2, '0')}`;
        }
        // "10" -> "10:00"
        const h = parseInt(raw, 10);
        if (!isNaN(h)) return `${String(h).padStart(2, '0')}:00`;
        return '';
      };

      const getHour = (t?: string) => {
        const n = normalizeTime(t);
        if (!n) return null;
        const h = parseInt(n.split(':')[0], 10);
        return Number.isFinite(h) ? h : null;
      };

      // Group changes per month (schedule-v2-YYYY-MM)
      const monthToSchedule: Record<string, Record<string, DaySchedule>> = {};

      for (const entry of entries) {
        const employee = employees.find((emp) => {
          const empNameLower = emp.name.toLowerCase();
          const entryNameLower = entry.name.toLowerCase();

          if (empNameLower === entryNameLower) return true;

          const empParts = empNameLower.split(' ').filter((p) => p.length > 1);
          const entryParts = entryNameLower.split(' ').filter((p) => p.length > 1);
          return empParts.some((p) => entryParts.some((ep) => p.includes(ep) || ep.includes(p)));
        });

        if (!employee) {
          if (!unmatchedNames.includes(entry.name)) unmatchedNames.push(entry.name);
          continue;
        }

        const monthKey = entry.date.slice(0, 7);
        const storageKey = `schedule-v2-${monthKey}`;

        if (!monthToSchedule[storageKey]) {
          try {
            monthToSchedule[storageKey] = JSON.parse(localStorage.getItem(storageKey) || '{}');
          } catch {
            monthToSchedule[storageKey] = {};
          }
        }

        const scheduleData = monthToSchedule[storageKey];
        const cellKey = `${employee.id}-${entry.date}`;
        const existing = scheduleData[cellKey] || {};

        const start = normalizeTime(entry.plannedStart);
        const end = normalizeTime(entry.plannedEnd);

        // If we don't have times, we still persist it as a manual planned entry (so overview shows it)
        if (!start || !end) {
          setManualTimeEntries((prev) => {
            const key = `${employee.id}-${entry.date}`;
            const existingIdx = prev.findIndex((e) => `${e.employeeId}-${e.date}` === key);

            const base: TimeEntry = existingIdx >= 0
              ? prev[existingIdx]
              : {
                  id: `manual_${employee.id}_${entry.date}`,
                  employeeId: employee.id,
                  date: entry.date,
                  plannedStart: '',
                  plannedEnd: '',
                  plannedHours: 0,
                };

            const updated: TimeEntry = {
              ...base,
              plannedHours: entry.plannedHours,
              plannedStart: base.plannedStart,
              plannedEnd: base.plannedEnd,
            };

            if (existingIdx >= 0) return prev.map((e, idx) => (idx === existingIdx ? updated : e));
            return [...prev, updated];
          });

          if (!processedEmployees.has(employee.id)) {
            matchedCount++;
            processedEmployees.add(employee.id);
          }
          continue;
        }

        // Choose Früh/Spät based on start time (fallback: fill first empty slot)
        const hour = getHour(start);
        let slot: 'früh' | 'spät' = hour !== null && hour >= 15 ? 'spät' : 'früh';
        if (slot === 'früh' && existing.früh && !existing.spät) slot = 'spät';
        if (slot === 'spät' && existing.spät && !existing.früh) slot = 'früh';

        const updatedDay: DaySchedule = {
          ...existing,
          [slot]: { start, end },
        };

        scheduleData[cellKey] = updatedDay;

        if (!processedEmployees.has(employee.id)) {
          matchedCount++;
          processedEmployees.add(employee.id);
        }
      }

      // Persist schedule-v2 changes
      for (const [storageKey, scheduleData] of Object.entries(monthToSchedule)) {
        localStorage.setItem(storageKey, JSON.stringify(scheduleData));
      }

      // Trigger re-sync (overview + editor)
      window.dispatchEvent(new CustomEvent('schedule-updated'));

      if (matchedCount > 0) {
        toast.success(`Arbeitsplan importiert (${matchedCount} Mitarbeiter)`);
      }
      if (unmatchedNames.length > 0) {
        toast.warning(
          `${unmatchedNames.length} Mitarbeiter nicht gefunden: ${unmatchedNames.slice(0, 3).join(', ')}${unmatchedNames.length > 3 ? '...' : ''}`
        );
      }
    },
    [employees]
  );

  // Import revenue data - automatically overwrites existing data for same dates
  const importRevenueData = useCallback(
    (entries: RevenueImportEntry[]) => {
      let importedCount = 0;
      let updatedCount = 0;
      let plannedCount = 0;
      let actualCount = 0;
      let previousYearCount = 0;

      // Deduplicate entries: take last entry per date/type combination
      const deduplicatedEntries = new Map<string, RevenueImportEntry>();
      entries.forEach((entry) => {
        const key = `${entry.date}-${entry.type}`;
        deduplicatedEntries.set(key, entry);
      });

      deduplicatedEntries.forEach((entry) => {
        const field = entry.type === 'planned' 
          ? 'plannedRevenue' 
          : entry.type === 'actual' 
            ? 'actualRevenue' 
            : 'previousYearRevenue';
        
        setDailyBudgets((prev) => {
          const existing = prev[entry.date];
          const isUpdate = existing && existing[field] && existing[field] > 0;
          if (isUpdate) updatedCount++;
          
          return {
            ...prev,
            [entry.date]: {
              ...(existing || {
                date: entry.date,
                plannedRevenue: 0,
                actualRevenue: 0,
                previousYearRevenue: 0,
                plannedLaborCost: 0,
                actualLaborCost: 0,
              }),
              [field]: entry.revenue,
            },
          };
        });
        
        importedCount++;
        if (entry.type === 'planned') {
          plannedCount++;
        } else if (entry.type === 'actual') {
          actualCount++;
        } else {
          previousYearCount++;
        }
      });

      if (importedCount > 0) {
        const parts: string[] = [];
        if (plannedCount > 0) parts.push(`${plannedCount} Plan`);
        if (actualCount > 0) parts.push(`${actualCount} Ist`);
        if (previousYearCount > 0) parts.push(`${previousYearCount} Vorjahr`);
        const updateInfo = updatedCount > 0 ? ` (${updatedCount} überschrieben)` : '';
        toast.success(`${parts.join(', ')} Umsatzeinträge importiert${updateInfo}`);
      }
    },
    []
  );

  // Import daily Mirus data (individual hours per day per employee)
  // IMPORTANT: This only updates actualHours - it preserves any existing plannedHours
  // DEDUPLICATION: Overwrites existing data for the same employee/date - no duplicates
  // MODE:
  //   'replace' → clears ALL Mirus-tagged entries for the imported date range first,
  //               then inserts the new data fresh.  Use for a full month re-import.
  //   'update'  → merges into existing data; only entries for the same employee+date
  //               are overwritten.  Planned hours are always preserved regardless of mode.
  const importMirusDailyData = useCallback(
    (entries: MirusDailyImportEntry[], mode: 'replace' | 'update' = 'update') => {
      let matchedCount = 0;
      let updatedCount = 0;
      let createdCount = 0;
      let unmatchedNames: string[] = [];
      const processedEmployees = new Set<string>();

      // First, deduplicate incoming entries (take last entry for each employee/date)
      const deduplicatedEntries = new Map<string, { entry: MirusDailyImportEntry; employee: Employee }>();
      
      entries.forEach((entry) => {
        // Find matching employee by name (case-insensitive, partial match)
        const employee = employeesRef.current.find((emp) => {
          const empNameLower = emp.name.toLowerCase();
          const entryNameLower = entry.name.toLowerCase();
          
          // Direct match
          if (empNameLower === entryNameLower) return true;
          
          // Partial match on name parts
          const empNameParts = empNameLower.split(' ').filter(p => p.length > 1);
          const entryNameParts = entryNameLower.split(' ').filter(p => p.length > 1);
          
          return empNameParts.some((part) =>
            entryNameParts.some((entryPart) => 
              part.includes(entryPart) || entryPart.includes(part)
            )
          );
        });

        if (employee) {
          const key = `${employee.id}-${entry.date}`;
          deduplicatedEntries.set(key, { entry, employee });
        } else {
          if (!unmatchedNames.includes(entry.name)) {
            unmatchedNames.push(entry.name);
          }
        }
      });

      // ── REPLACE MODE: clear all Mirus actual-hours for the affected date range ──
      if (mode === 'replace') {
        const importedDates = new Set(entries.map(e => e.date));
        // In replace mode: reset actualHours (and importSource) for all existing
        // Mirus entries that fall within the imported date range.
        // Planned hours (plannedStart/plannedEnd/plannedHours) are never touched.
        setManualTimeEntries(prev =>
          prev.map(te =>
            importedDates.has(te.date) && (te.importSource === 'mirus' || te.importSource === undefined)
              ? { ...te, actualHours: undefined, importSource: undefined }
              : te,
          ),
        );
        setTimeEntries(prev =>
          prev.map(te =>
            importedDates.has(te.date) && (te.importSource === 'mirus' || te.importSource === undefined)
              ? { ...te, actualHours: undefined, importSource: undefined }
              : te,
          ),
        );
        // Also clear the monthly actual-hours localStorage cache for affected months
        // IMPORTANT: FE/K/F entries (absenceType) must NEVER be deleted — they are localStorage-only
        const affectedMonths = new Set([...importedDates].map(d => d.slice(0, 7)));
        for (const monthKey of affectedMonths) {
          const storageKey = `actual-hours-${monthKey}`;
          try {
            const existing: Record<string, unknown> = JSON.parse(localStorage.getItem(storageKey) || '{}');
            for (const cellKey of Object.keys(existing)) {
              // The cell key is `${employeeId}-YYYY-MM-DD` – date is the last 10 chars
              const dateFromKey = cellKey.length >= 10 ? cellKey.slice(-10) : '';
              if (importedDates.has(dateFromKey)) {
                const val = existing[cellKey];
                const hasAbsenceType = typeof val === 'object' && val !== null && !!(val as Record<string, unknown>).absenceType;
                if (hasAbsenceType) {
                  // Keep FE/K/F: import must not erase vacation/sick entries
                  console.log(`[FERIEN] preserved on navigation: ${cellKey} absenceType=${(val as Record<string, unknown>).absenceType}`);
                } else {
                  delete existing[cellKey];
                }
              }
            }
            localStorage.setItem(storageKey, JSON.stringify(existing));
          } catch { /* ignore */ }
        }
      }

      // Process deduplicated entries
      deduplicatedEntries.forEach(({ entry, employee }, key) => {
        // Update or create in manual entries (preserving existing planned data)
        setManualTimeEntries((prev) => {
          const existingIdx = prev.findIndex((e) => `${e.employeeId}-${e.date}` === key);
          
          if (existingIdx >= 0) {
            // Update only actualHours + importSource, preserve everything else
            updatedCount++;
            return prev.map((e, idx) => 
              idx === existingIdx 
                ? { ...e, actualHours: entry.hours, importSource: 'mirus' }
                : e
            );
          } else {
            // Create new entry
            createdCount++;
            const newEntry: TimeEntry = {
              id: `manual_${employee.id}_${entry.date}`,
              employeeId: employee.id,
              date: entry.date,
              plannedStart: '',
              plannedEnd: '',
              plannedHours: 0,
              actualHours: entry.hours,
              importSource: 'mirus',
            };
            return [...prev, newEntry];
          }
        });
        
        // Also update merged timeEntries for immediate display
        setTimeEntries((prev) => {
          const existingIdx = prev.findIndex((te) => te.employeeId === employee.id && te.date === entry.date);
          
          if (existingIdx >= 0) {
            // Update only actualHours + importSource, preserve planned data - NO DUPLICATE
            return prev.map((te, idx) =>
              idx === existingIdx
                ? { ...te, actualHours: entry.hours, importSource: 'mirus' }
                : te
            );
          } else {
            // Create new entry
            const id = `time_${employee.id}_${entry.date}`;
            return [
              ...prev,
              {
                id,
                employeeId: employee.id,
                date: entry.date,
                plannedStart: '',
                plannedEnd: '',
                plannedHours: 0,
                actualHours: entry.hours,
                importSource: 'mirus' as const,
              },
            ];
          }
        });
        
        if (!processedEmployees.has(employee.id)) {
          matchedCount++;
          processedEmployees.add(employee.id);
        }
      });

      // Also update actual-hours-YYYY-MM for the schedule planner's Ist-Dienstplan view
      // Group entries by month and update localStorage
      const monthlyActualHours: Record<string, Record<string, { hours: number }>> = {};
      
      deduplicatedEntries.forEach(({ entry, employee }) => {
        const monthKey = entry.date.slice(0, 7); // YYYY-MM
        const storageKey = `actual-hours-${monthKey}`;
        const cellKey = `${employee.id}-${entry.date}`;
        
        if (!monthlyActualHours[storageKey]) {
          // Load existing data for this month
          try {
            const existing = localStorage.getItem(storageKey);
            monthlyActualHours[storageKey] = existing ? JSON.parse(existing) : {};
          } catch {
            monthlyActualHours[storageKey] = {};
          }
        }
        
        // Only overwrite an FE/K/F entry if the import brings real working hours (>0)
        const existingEntry = monthlyActualHours[storageKey][cellKey] as Record<string, unknown> | undefined;
        if (existingEntry?.absenceType && entry.hours <= 0) {
          console.log(`[FERIEN] ignored empty import, kept holiday: ${cellKey} absenceType=${existingEntry.absenceType}`);
        } else {
          monthlyActualHours[storageKey][cellKey] = { hours: entry.hours };
          if (entry.hours > 0) {
            console.log(`[FERIEN] replaced by working-hours import: ${cellKey} hours=${entry.hours}`);
          }
        }
      });
      
      // Persist updated actual hours to localStorage
      for (const [storageKey, data] of Object.entries(monthlyActualHours)) {
        localStorage.setItem(storageKey, JSON.stringify(data));
      }
      
      // Trigger schedule update event so the Dienstplan refreshes
      window.dispatchEvent(new CustomEvent('schedule-updated'));

      if (matchedCount > 0) {
        const details = [];
        if (updatedCount > 0) details.push(`${updatedCount} aktualisiert`);
        if (createdCount > 0) details.push(`${createdCount} neu`);
        toast.success(`Ist-Stunden für ${matchedCount} Mitarbeiter importiert (${details.join(', ')})`);
      }
      if (unmatchedNames.length > 0) {
        toast.warning(`${unmatchedNames.length} Mitarbeiter nicht gefunden: ${unmatchedNames.slice(0, 3).join(', ')}${unmatchedNames.length > 3 ? '...' : ''}`);
      }
    },
    []
  );

  // Replace all employees (for bulk import)
  const setAllEmployees = useCallback((newEmployees: Employee[]) => {
    setEmployees(newEmployees);
  }, []);

  // Update employee balance (hours and vacation)
  const updateEmployeeBalance = useCallback(
    async (employeeId: string, hoursBalance: number, vacationBalance: number) => {
      // Update local state
      setEmployees((prev) =>
        prev.map((e) =>
          e.id === employeeId
            ? { ...e, hoursBalance, vacationBalance }
            : e
        )
      );

      // Sync to Supabase
      try {
        const { error } = await supabase
          .from('employees')
          .update({
            hours_balance: hoursBalance,
            vacation_balance: vacationBalance,
          })
          .eq('id', employeeId);

        if (error) {
          console.error('[usePersonnelData] Error updating balance in Supabase:', error);
          toast.error('Fehler beim Speichern des Saldos');
          return;
        }

        toast.success('Saldo aktualisiert');
      } catch (err) {
        console.error('[usePersonnelData] Failed to update balance in Supabase:', err);
        toast.error('Fehler beim Speichern');
      }
    },
    []
  );

  return {
    employees,
    timeEntries,
    dailyBudgets,
    addEmployee,
    updateEmployee,
    deleteEmployee,
    setAllEmployees,
    updateEmployeeBalance,
    updateTimeEntry,
    updatePlannedTime,
    deleteTimeEntry,
    addTimeEntry,
    updateBudget,
    setFixedBudget,
    updateHourlyRevenue,
    getDailySummary,
    importScheduleData,
    importMirusData,
    importMirusDailyData,
    importSchedulePDF,
    importRevenueData,
  };
};
