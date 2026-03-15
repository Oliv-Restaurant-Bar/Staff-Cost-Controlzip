import { supabase } from '@/integrations/supabase/client';
import { Employee } from '@/types/personnel';
import { format, startOfMonth, endOfMonth } from 'date-fns';

// ─── Typen ──────────────────────────────────────────────────────────────────

export interface DaySchedule {
  früh?: { start: string; end: string } | null;
  spät?: { start: string; end: string } | null;
  frühAbsence?: string | null;
  spätAbsence?: string | null;
}

export interface ActualHourEntry {
  hours: number;
  start?: string;
  end?: string;
}

// ─── Hilfsfunktionen ────────────────────────────────────────────────────────

const employeeToDb = (emp: Employee) => ({
  // ── Stammdaten ────────────────────────────────────────────────────────────
  id:                       emp.id,
  name:                     emp.name,
  department:               emp.department === 'küche' ? 'kueche' : 'service',
  employment_type:          emp.employmentType,
  // ── Arbeitszeit & Lohn ────────────────────────────────────────────────────
  hourly_wage:              emp.hourlyWage,
  weekly_hours:             emp.weeklyHours             ?? null,
  monthly_salary:           emp.monthlySalary           ?? null,
  monthly_salary_with_13th: emp.monthlySalaryWith13th   ?? null,
  social_cost_factor:       emp.socialCostFactor        ?? 1.13,
  has_13th_salary:          emp.has13thSalary           ?? false,
  // ── Saldi ────────────────────────────────────────────────────────────────
  hours_balance:            emp.hoursBalance            ?? null,
  vacation_balance:         emp.vacationBalance         ?? null,
  vacation_days_per_year:   emp.vacationDaysPerYear     ?? null,
  // ── Dienstplan ────────────────────────────────────────────────────────────
  days_off:                 emp.daysOff                 ?? [],
  preferred_work_days:      emp.preferredWorkDays       ?? [],
  // ── Persönliche Daten ────────────────────────────────────────────────────
  birth_date:               emp.birthDate               ?? null,
  nationality:              emp.nationality             ?? null,
  phone:                    emp.phone                   ?? null,
  email:                    emp.email                   ?? null,
  address_street:           emp.addressStreet           ?? null,
  address_zip:              emp.addressZip              ?? null,
  address_city:             emp.addressCity             ?? null,
  ahv_number:               emp.ahvNumber               ?? null,
  iban:                     emp.iban                    ?? null,
  // ── Vertragliche Grundlagen ──────────────────────────────────────────────
  contract_type:            emp.contractType            ?? null,
  position_title:           emp.positionTitle           ?? null,
  contract_start:           emp.contractStart           ?? null,
  contract_end:             emp.contractEnd             ?? null,
  is_limited_contract:      emp.isLimitedContract       ?? false,
  trial_period_months:      emp.trialPeriodMonths       ?? null,
  notice_period_weeks:      emp.noticePeriodWeeks       ?? null,
  // ── Onboarding ───────────────────────────────────────────────────────────
  onboarding_status:        emp.onboardingStatus        ?? 'none',
  onboarding_token:         emp.onboardingToken         ?? null,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbToEmployee = (row: any): Employee => ({
  // ── Stammdaten ────────────────────────────────────────────────────────────
  id:                     row.id,
  name:                   row.name,
  department:             row.department === 'kueche' ? 'küche' : 'service',
  employmentType:         row.employment_type,
  // ── Arbeitszeit & Lohn ────────────────────────────────────────────────────
  hourlyWage:             Number(row.hourly_wage),
  weeklyHours:            row.weekly_hours              ?? undefined,
  monthlySalary:          row.monthly_salary            ?? undefined,
  monthlySalaryWith13th:  row.monthly_salary_with_13th  ?? undefined,
  socialCostFactor:       row.social_cost_factor        != null ? Number(row.social_cost_factor) : undefined,
  has13thSalary:          row.has_13th_salary           ?? undefined,
  // ── Saldi ────────────────────────────────────────────────────────────────
  hoursBalance:           row.hours_balance             ?? undefined,
  vacationBalance:        row.vacation_balance          ?? undefined,
  vacationDaysPerYear:    row.vacation_days_per_year    ?? undefined,
  // ── Dienstplan ────────────────────────────────────────────────────────────
  daysOff:                row.days_off                  ?? undefined,
  preferredWorkDays:      row.preferred_work_days       ?? undefined,
  // ── Persönliche Daten ────────────────────────────────────────────────────
  birthDate:              row.birth_date                ?? undefined,
  nationality:            row.nationality               ?? undefined,
  phone:                  row.phone                     ?? undefined,
  email:                  row.email                     ?? undefined,
  addressStreet:          row.address_street            ?? undefined,
  addressZip:             row.address_zip               ?? undefined,
  addressCity:            row.address_city              ?? undefined,
  ahvNumber:              row.ahv_number                ?? undefined,
  iban:                   row.iban                      ?? undefined,
  // ── Vertragliche Grundlagen ──────────────────────────────────────────────
  contractType:           row.contract_type             ?? undefined,
  positionTitle:          row.position_title            ?? undefined,
  contractStart:          row.contract_start            ?? undefined,
  contractEnd:            row.contract_end              ?? undefined,
  isLimitedContract:      row.is_limited_contract       ?? undefined,
  trialPeriodMonths:      row.trial_period_months       ?? undefined,
  noticePeriodWeeks:      row.notice_period_weeks       ?? undefined,
  // ── Onboarding ───────────────────────────────────────────────────────────
  onboardingStatus:       row.onboarding_status         ?? undefined,
  onboardingToken:        row.onboarding_token          ?? undefined,
});

// ─── Mitarbeiter ─────────────────────────────────────────────────────────────

export async function loadEmployees(): Promise<Employee[] | null> {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('*')
      .order('name');
    if (error) { console.error('[supabase-db] loadEmployees:', error); return null; }
    return (data ?? []).map(dbToEmployee);
  } catch (e) {
    console.error('[supabase-db] loadEmployees exception:', e);
    return null;
  }
}

export async function upsertEmployee(emp: Employee): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('employees')
      .upsert(employeeToDb(emp), { onConflict: 'id' });
    if (error) { console.error('[supabase-db] upsertEmployee:', error); return false; }
    return true;
  } catch (e) {
    console.error('[supabase-db] upsertEmployee exception:', e);
    return false;
  }
}

export async function deleteEmployee(id: string): Promise<boolean> {
  try {
    const { error } = await supabase.from('employees').delete().eq('id', id);
    if (error) { console.error('[supabase-db] deleteEmployee:', error); return false; }
    return true;
  } catch (e) {
    console.error('[supabase-db] deleteEmployee exception:', e);
    return false;
  }
}

export async function upsertAllEmployees(employees: Employee[]): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('employees')
      .upsert(employees.map(employeeToDb), { onConflict: 'id' });
    if (error) { console.error('[supabase-db] upsertAllEmployees:', error); return false; }
    return true;
  } catch (e) {
    console.error('[supabase-db] upsertAllEmployees exception:', e);
    return false;
  }
}

// ─── Dienstplan (schedule_entries) ───────────────────────────────────────────

export async function loadScheduleForMonth(month: Date): Promise<Record<string, DaySchedule> | null> {
  try {
    const startStr = format(startOfMonth(month), 'yyyy-MM-dd');
    const endStr = format(endOfMonth(month), 'yyyy-MM-dd');

    const { data, error } = await supabase
      .from('schedule_entries')
      .select('*')
      .gte('date', startStr)
      .lte('date', endStr);

    if (error) { console.error('[supabase-db] loadScheduleForMonth:', error); return null; }

    const result: Record<string, DaySchedule> = {};
    for (const row of data ?? []) {
      const key = `${row.employee_id}-${row.date}`;
      result[key] = {
        früh: row.frueh_start && row.frueh_end
          ? { start: row.frueh_start.slice(0, 5), end: row.frueh_end.slice(0, 5) }
          : null,
        spät: row.spaet_start && row.spaet_end
          ? { start: row.spaet_start.slice(0, 5), end: row.spaet_end.slice(0, 5) }
          : null,
        frühAbsence: row.frueh_absence ?? null,
        spätAbsence: row.spaet_absence ?? null,
      };
    }
    return result;
  } catch (e) {
    console.error('[supabase-db] loadScheduleForMonth exception:', e);
    return null;
  }
}

export async function saveScheduleEntry(
  employeeId: string,
  date: string,
  schedule: DaySchedule | null
): Promise<void> {
  try {
    const isEmpty = !schedule ||
      (!schedule.früh && !schedule.spät && !schedule.frühAbsence && !schedule.spätAbsence);

    if (isEmpty) {
      await supabase
        .from('schedule_entries')
        .delete()
        .eq('employee_id', employeeId)
        .eq('date', date);
    } else {
      await supabase.from('schedule_entries').upsert({
        employee_id: employeeId,
        date,
        frueh_start: schedule?.früh?.start ?? null,
        frueh_end: schedule?.früh?.end ?? null,
        frueh_absence: schedule?.frühAbsence ?? null,
        spaet_start: schedule?.spät?.start ?? null,
        spaet_end: schedule?.spät?.end ?? null,
        spaet_absence: schedule?.spätAbsence ?? null,
      }, { onConflict: 'employee_id,date' });
    }
  } catch (e) {
    console.error('[supabase-db] saveScheduleEntry exception:', e);
  }
}

export async function saveFullScheduleForMonth(
  month: Date,
  scheduleData: Record<string, DaySchedule>
): Promise<void> {
  const startStr = format(startOfMonth(month), 'yyyy-MM-dd');
  const endStr = format(endOfMonth(month), 'yyyy-MM-dd');

  try {
    await supabase
      .from('schedule_entries')
      .delete()
      .gte('date', startStr)
      .lte('date', endStr);

    const rows = Object.entries(scheduleData)
      .filter(([, s]) => s && (s.früh || s.spät || s.frühAbsence || s.spätAbsence))
      .map(([key, s]) => {
        const date = key.slice(-10);
        const employeeId = key.slice(0, -11);
        return {
          employee_id: employeeId,
          date,
          frueh_start: s.früh?.start ?? null,
          frueh_end: s.früh?.end ?? null,
          frueh_absence: s.frühAbsence ?? null,
          spaet_start: s.spät?.start ?? null,
          spaet_end: s.spät?.end ?? null,
          spaet_absence: s.spätAbsence ?? null,
        };
      });

    if (rows.length > 0) {
      await supabase.from('schedule_entries').insert(rows);
    }
  } catch (e) {
    console.error('[supabase-db] saveFullScheduleForMonth exception:', e);
  }
}

// ─── Ist-Stunden (actual_hours) ───────────────────────────────────────────────

export async function loadActualHoursForMonth(month: Date): Promise<Record<string, ActualHourEntry> | null> {
  try {
    const startStr = format(startOfMonth(month), 'yyyy-MM-dd');
    const endStr = format(endOfMonth(month), 'yyyy-MM-dd');

    const { data, error } = await supabase
      .from('actual_hours')
      .select('*')
      .gte('date', startStr)
      .lte('date', endStr);

    if (error) { console.error('[supabase-db] loadActualHoursForMonth:', error); return null; }

    const result: Record<string, ActualHourEntry> = {};
    for (const row of data ?? []) {
      const key = `${row.employee_id}-${row.date}`;
      result[key] = {
        hours: Number(row.hours ?? 0),
        start: row.start_time ?? undefined,
        end: row.end_time ?? undefined,
      };
    }
    return result;
  } catch (e) {
    console.error('[supabase-db] loadActualHoursForMonth exception:', e);
    return null;
  }
}

export async function saveActualHourEntry(
  employeeId: string,
  date: string,
  entry: ActualHourEntry | null
): Promise<void> {
  try {
    if (!entry) {
      await supabase
        .from('actual_hours')
        .delete()
        .eq('employee_id', employeeId)
        .eq('date', date);
    } else {
      await supabase.from('actual_hours').upsert({
        employee_id: employeeId,
        date,
        hours: entry.hours,
        start_time: entry.start ?? null,
        end_time: entry.end ?? null,
      }, { onConflict: 'employee_id,date' });
    }
  } catch (e) {
    console.error('[supabase-db] saveActualHourEntry exception:', e);
  }
}

// ─── App-Einstellungen (app_settings) ────────────────────────────────────────

export async function loadSetting<T>(key: string): Promise<T | null> {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) { console.error('[supabase-db] loadSetting:', error); return null; }
    return data ? (data.value as T) : null;
  } catch (e) {
    console.error('[supabase-db] loadSetting exception:', e);
    return null;
  }
}

export async function saveSetting<T>(key: string, value: T): Promise<void> {
  try {
    await supabase.from('app_settings').upsert(
      { key, value: value as object },
      { onConflict: 'key' }
    );
  } catch (e) {
    console.error('[supabase-db] saveSetting exception:', e);
  }
}
