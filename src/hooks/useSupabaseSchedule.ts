import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, subDays, addDays } from 'date-fns';
import { toast } from 'sonner';

// Types matching the database schema
export interface DbEmployee {
  id: string;
  name: string;
  department: 'service' | 'kueche';
  employment_type: 'vollzeit' | 'teilzeit' | 'minijob' | 'aushilfe';
  hourly_wage: number;
  weekly_hours: number | null;
  monthly_salary: number | null;
  monthly_salary_with_13th: number | null;
  days_off: string[];
  preferred_work_days: string[];
  created_at: string;
  updated_at: string;
}

export interface DbScheduleEntry {
  id: string;
  employee_id: string;
  date: string;
  frueh_start: string | null;
  frueh_end: string | null;
  frueh_absence: string | null;
  spaet_start: string | null;
  spaet_end: string | null;
  spaet_absence: string | null;
  created_at: string;
  updated_at: string;
}

// Frontend-compatible types
export interface Employee {
  id: string;
  name: string;
  department: 'service' | 'küche';
  employmentType: 'vollzeit' | 'teilzeit' | 'minijob' | 'aushilfe';
  hourlyWage: number;
  weeklyHours?: number;
  monthlySalary?: number;
  monthlySalaryWith13th?: number;
  daysOff?: string[];
  preferredWorkDays?: string[];
}

export interface TimeSlot {
  start: string;
  end: string;
}

export interface DaySchedule {
  früh?: TimeSlot | null;
  spät?: TimeSlot | null;
  frühAbsence?: string | null;
  spätAbsence?: string | null;
}

// Conversion helpers
const dbToFrontendEmployee = (db: DbEmployee): Employee => ({
  id: db.id,
  name: db.name,
  department: db.department === 'kueche' ? 'küche' : 'service',
  employmentType: db.employment_type,
  hourlyWage: Number(db.hourly_wage),
  weeklyHours: db.weekly_hours ?? undefined,
  monthlySalary: db.monthly_salary ?? undefined,
  monthlySalaryWith13th: db.monthly_salary_with_13th ?? undefined,
  daysOff: db.days_off,
  preferredWorkDays: db.preferred_work_days,
});

const frontendToDbEmployee = (emp: Omit<Employee, 'id'> | Employee): Partial<DbEmployee> => ({
  name: emp.name,
  department: emp.department === 'küche' ? 'kueche' : 'service',
  employment_type: emp.employmentType,
  hourly_wage: emp.hourlyWage,
  weekly_hours: emp.weeklyHours ?? null,
  monthly_salary: emp.monthlySalary ?? null,
  monthly_salary_with_13th: emp.monthlySalaryWith13th ?? null,
  days_off: emp.daysOff ?? [],
  preferred_work_days: emp.preferredWorkDays ?? [],
});

const dbToScheduleData = (entries: DbScheduleEntry[]): Record<string, DaySchedule> => {
  const result: Record<string, DaySchedule> = {};
  
  entries.forEach(entry => {
    const key = `${entry.employee_id}-${entry.date}`;
    result[key] = {
      früh: entry.frueh_start && entry.frueh_end 
        ? { start: entry.frueh_start.slice(0, 5), end: entry.frueh_end.slice(0, 5) }
        : null,
      spät: entry.spaet_start && entry.spaet_end
        ? { start: entry.spaet_start.slice(0, 5), end: entry.spaet_end.slice(0, 5) }
        : null,
      frühAbsence: entry.frueh_absence,
      spätAbsence: entry.spaet_absence,
    };
  });
  
  return result;
};

interface TokenAccess {
  department: string;
  role: string;
  is_valid: boolean;
}

interface UseSupabaseScheduleOptions {
  token?: string | null;
  department?: 'service' | 'kueche' | null;
  currentMonth: Date;
}

export const useSupabaseSchedule = ({ token, department, currentMonth }: UseSupabaseScheduleOptions) => {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [scheduleData, setScheduleData] = useState<Record<string, DaySchedule>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [tokenAccess, setTokenAccess] = useState<TokenAccess | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Validate token access
  useEffect(() => {
    const validateToken = async () => {
      if (!token) {
        setTokenAccess(null);
        return;
      }

      try {
        const { data, error } = await supabase.rpc('get_token_access', { token_value: token });
        
        if (error || !data || data.length === 0) {
          console.log('Token validation failed:', error);
          setTokenAccess(null);
        } else {
          const access = data[0] as TokenAccess;
          if (access.is_valid) {
            setTokenAccess(access);
          } else {
            setTokenAccess(null);
          }
        }
      } catch (err) {
        console.error('Token validation error:', err);
        setTokenAccess(null);
      }
    };

    validateToken();
  }, [token]);

  // Load employees
  const loadEmployees = useCallback(async () => {
    try {
      let query = supabase.from('employees').select('*').order('name');
      
      // Filter by department if specified
      if (department) {
        query = query.eq('department', department);
      }
      
      const { data, error } = await query;
      
      if (error) throw error;
      
      const frontendEmployees = (data || []).map(dbToFrontendEmployee);
      setEmployees(frontendEmployees);
      
      return frontendEmployees;
    } catch (err) {
      console.error('Error loading employees:', err);
      setError('Fehler beim Laden der Mitarbeiter');
      return [];
    }
  }, [department]);

  // Load schedule data for the current month including week overlaps
  const loadScheduleData = useCallback(async () => {
    try {
      // Calculate date range including week overlaps at month boundaries
      // This ensures days visible in week view (e.g., Sunday in next month) are included
      const monthStart = startOfMonth(currentMonth);
      const monthEnd = endOfMonth(currentMonth);
      
      // Extend range to include full weeks at boundaries
      // Start: go back to Monday of the week containing month start
      const extendedStart = startOfWeek(monthStart, { weekStartsOn: 1 });
      // End: go forward to Sunday of the week containing month end
      const extendedEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
      
      const startStr = format(extendedStart, 'yyyy-MM-dd');
      const endStr = format(extendedEnd, 'yyyy-MM-dd');
      
      let query = supabase
        .from('schedule_entries')
        .select('*, employees!inner(department)')
        .gte('date', startStr)
        .lte('date', endStr);
      
      // Filter by department if specified
      if (department) {
        query = query.eq('employees.department', department);
      }
      
      const { data, error } = await query;
      
      if (error) throw error;
      
      const scheduleMap = dbToScheduleData(data || []);
      setScheduleData(scheduleMap);
      
      return scheduleMap;
    } catch (err) {
      console.error('Error loading schedule:', err);
      setError('Fehler beim Laden des Dienstplans');
      return {};
    }
  }, [currentMonth, department]);

  // Initial load
  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      setError(null);
      
      await Promise.all([loadEmployees(), loadScheduleData()]);
      
      setIsLoading(false);
    };
    
    load();
  }, [loadEmployees, loadScheduleData]);

  // Add employee
  const addEmployee = async (employee: Omit<Employee, 'id'>): Promise<Employee | null> => {
    try {
      const dbData = {
        name: employee.name,
        department: employee.department === 'küche' ? 'kueche' as const : 'service' as const,
        employment_type: employee.employmentType,
        hourly_wage: employee.hourlyWage,
        weekly_hours: employee.weeklyHours ?? null,
        monthly_salary: employee.monthlySalary ?? null,
        monthly_salary_with_13th: employee.monthlySalaryWith13th ?? null,
        days_off: employee.daysOff ?? [],
        preferred_work_days: employee.preferredWorkDays ?? [],
      };
      
      const { data, error } = await supabase
        .from('employees')
        .insert(dbData)
        .select()
        .single();
      
      if (error) throw error;
      
      const newEmployee = dbToFrontendEmployee(data);
      setEmployees(prev => [...prev, newEmployee]);
      toast.success(`${employee.name} hinzugefügt`);
      
      return newEmployee;
    } catch (err) {
      console.error('Error adding employee:', err);
      toast.error('Fehler beim Hinzufügen');
      return null;
    }
  };

  // Update employee
  const updateEmployee = async (employee: Employee): Promise<boolean> => {
    try {
      const dbEmployee = frontendToDbEmployee(employee);
      
      const { error } = await supabase
        .from('employees')
        .update(dbEmployee)
        .eq('id', employee.id);
      
      if (error) throw error;
      
      setEmployees(prev => prev.map(e => e.id === employee.id ? employee : e));
      toast.success(`${employee.name} aktualisiert`);
      
      return true;
    } catch (err) {
      console.error('Error updating employee:', err);
      toast.error('Fehler beim Aktualisieren');
      return false;
    }
  };

  // Delete employee
  const deleteEmployee = async (employeeId: string): Promise<boolean> => {
    try {
      const emp = employees.find(e => e.id === employeeId);
      
      const { error } = await supabase
        .from('employees')
        .delete()
        .eq('id', employeeId);
      
      if (error) throw error;
      
      setEmployees(prev => prev.filter(e => e.id !== employeeId));
      if (emp) toast.success(`${emp.name} entfernt`);
      
      return true;
    } catch (err) {
      console.error('Error deleting employee:', err);
      toast.error('Fehler beim Löschen');
      return false;
    }
  };

  // Update schedule entry
  const updateScheduleEntry = async (
    employeeId: string,
    date: string,
    slotType: 'früh' | 'spät',
    value: TimeSlot | null,
    absenceType?: string | null
  ): Promise<boolean> => {
    try {
      const cellKey = `${employeeId}-${date}`;
      const current = scheduleData[cellKey] || {};
      
      // Build updated schedule
      const updated = { ...current };
      if (slotType === 'früh') {
        updated.früh = value;
        updated.frühAbsence = absenceType || null;
      } else {
        updated.spät = value;
        updated.spätAbsence = absenceType || null;
      }
      
      // Check if we should delete or upsert
      const isEmpty = !updated.früh && !updated.spät && !updated.frühAbsence && !updated.spätAbsence;
      
      if (isEmpty) {
        // Delete the entry
        const { error } = await supabase
          .from('schedule_entries')
          .delete()
          .eq('employee_id', employeeId)
          .eq('date', date);
        
        if (error) throw error;
        
        setScheduleData(prev => {
          const newState = { ...prev };
          delete newState[cellKey];
          return newState;
        });
      } else {
        // Upsert the entry
        const { error } = await supabase
          .from('schedule_entries')
          .upsert({
            employee_id: employeeId,
            date: date,
            frueh_start: updated.früh?.start || null,
            frueh_end: updated.früh?.end || null,
            frueh_absence: updated.frühAbsence || null,
            spaet_start: updated.spät?.start || null,
            spaet_end: updated.spät?.end || null,
            spaet_absence: updated.spätAbsence || null,
          }, {
            onConflict: 'employee_id,date'
          });
        
        if (error) throw error;
        
        setScheduleData(prev => ({ ...prev, [cellKey]: updated }));
      }
      
      // Dispatch event for other components
      window.dispatchEvent(new CustomEvent('schedule-updated'));
      
      return true;
    } catch (err) {
      console.error('Error updating schedule:', err);
      toast.error('Fehler beim Speichern');
      return false;
    }
  };

  // Bulk save schedule
  const saveSchedule = async (): Promise<boolean> => {
    // Changes are already saved in real-time via updateScheduleEntry
    toast.success('Dienstplan gespeichert');
    return true;
  };

  // Check access permissions
  const canEdit = (employeeDepartment: 'service' | 'küche'): boolean => {
    if (!tokenAccess) return true; // Admin mode (no token) can edit all
    
    if (tokenAccess.role === 'admin') return true;
    
    const tokenDept = tokenAccess.department === 'service' ? 'service' : 'küche';
    return tokenDept === employeeDepartment;
  };

  const isAdmin = tokenAccess?.role === 'admin' || !token;

  return {
    employees,
    scheduleData,
    isLoading,
    error,
    tokenAccess,
    isAdmin,
    canEdit,
    loadEmployees,
    loadScheduleData,
    addEmployee,
    updateEmployee,
    deleteEmployee,
    updateScheduleEntry,
    saveSchedule,
    refresh: async () => {
      await Promise.all([loadEmployees(), loadScheduleData()]);
    },
  };
};

// Helper to migrate localStorage data to Supabase (one-time use)
export const migrateLocalStorageToSupabase = async (): Promise<{ success: boolean; message: string }> => {
  try {
    // Check if migration already done
    const migrated = localStorage.getItem('supabase-migration-done');
    if (migrated) {
      return { success: true, message: 'Migration bereits durchgeführt' };
    }

    // Load employees from localStorage
    const savedEmployees = localStorage.getItem('schedule-employees');
    if (savedEmployees) {
      const localEmployees = JSON.parse(savedEmployees) as Employee[];
      
      // Insert employees
      for (const emp of localEmployees) {
        const dbData = {
          name: emp.name,
          department: emp.department === 'küche' ? 'kueche' as const : 'service' as const,
          employment_type: emp.employmentType,
          hourly_wage: emp.hourlyWage,
          weekly_hours: emp.weeklyHours ?? null,
          monthly_salary: emp.monthlySalary ?? null,
          monthly_salary_with_13th: emp.monthlySalaryWith13th ?? null,
          days_off: emp.daysOff ?? [],
          preferred_work_days: emp.preferredWorkDays ?? [],
        };
        await supabase.from('employees').insert(dbData);
      }
    }

    // Load schedule data for recent months
    const now = new Date();
    for (let i = -1; i <= 2; i++) {
      const month = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const monthKey = format(month, 'yyyy-MM');
      const savedSchedule = localStorage.getItem(`schedule-v2-${monthKey}`);
      
      if (savedSchedule) {
        const scheduleData = JSON.parse(savedSchedule) as Record<string, DaySchedule>;
        
        for (const [key, schedule] of Object.entries(scheduleData)) {
          const [employeeId, date] = key.split('-').slice(0, 2);
          const dateStr = key.substring(key.indexOf('-') + 1);
          
          if (schedule.früh || schedule.spät || schedule.frühAbsence || schedule.spätAbsence) {
            await supabase.from('schedule_entries').upsert({
              employee_id: employeeId,
              date: dateStr,
              frueh_start: schedule.früh?.start || null,
              frueh_end: schedule.früh?.end || null,
              frueh_absence: schedule.frühAbsence || null,
              spaet_start: schedule.spät?.start || null,
              spaet_end: schedule.spät?.end || null,
              spaet_absence: schedule.spätAbsence || null,
            }, {
              onConflict: 'employee_id,date'
            });
          }
        }
      }
    }

    localStorage.setItem('supabase-migration-done', 'true');
    return { success: true, message: 'Migration erfolgreich abgeschlossen' };
  } catch (err) {
    console.error('Migration error:', err);
    return { success: false, message: `Migration fehlgeschlagen: ${err}` };
  }
};
