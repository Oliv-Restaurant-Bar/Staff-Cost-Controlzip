import { calculateDayNetHours, type DayNetFields } from '@/hooks/useShiftConfig';
import { getLastCompletedWeekRange } from '@/lib/completed-week';

type KeyFn = (key: string) => string;
interface StoredEntry extends DayNetFields {
  frühAbsence?: string;
  spätAbsence?: string;
  absenceType?: string;
  hours?: number;
  source?: string;
}
type StoredValue = number | StoredEntry;
const round2 = (value: number) => Math.round(value * 100) / 100;

export interface FlexDayEntry {
  date: string;
  hours: number;
  cost: number;
}

export interface FlexWeeklyEmployeeInput {
  id: string;
  /** Persisted schedule/actual key ID; differs for ::flexsplit pseudo rows. */
  sourceId?: string;
  name: string;
  wage: number;
  agOff?: boolean;
  /** Optional inclusive date range, used by mid-month hourly phases. */
  activeFrom?: string;
  activeTo?: string;
}

export interface FlexWeeklyEmployeeRow {
  id: string;
  name: string;
  agOff: boolean;
  planH: number;
  istH: number;
  planCost: number;
  istCost: number;
}

export interface FlexWeeklyDay {
  date: string;
  planH: number;
  istH: number;
  planCost: number;
  istCost: number;
}

export interface FlexWeeklyWeek {
  label: string;
  von: string;
  bis: string;
  dates: string[];
  offen: boolean;
  teilweise: boolean;
  planH: number;
  istH: number;
  planCost: number;
  istCost: number;
  employees: FlexWeeklyEmployeeRow[];
}

export interface FlexWeeklyEvaluation {
  lastIstDate: string;
  days: FlexWeeklyDay[];
  weeks: FlexWeeklyWeek[];
}

function readRecord(key: string): Record<string, StoredValue> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as Record<string, StoredValue> : {};
  } catch {
    return {};
  }
}

/** Daily plan hours for one employee from the same schedule cache used on PersonalFix. */
export function loadDailyPlanDetails(
  empId: string,
  year: number,
  month: number,
  cutoffDay: number | null,
  wage: number,
  keyFn: KeyFn = key => key,
): FlexDayEntry[] {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const data = readRecord(keyFn(`schedule-v2-${prefix}`));
  const entries: FlexDayEntry[] = [];
  for (const [cellKey, ds] of Object.entries(data)) {
    const date = cellKey.slice(-10);
    if (!date.startsWith(prefix) || cellKey.slice(0, cellKey.length - 11) !== empId) continue;
    if (typeof ds !== 'object' || ds === null) continue;
    const day = Number(date.slice(-2));
    if (cutoffDay !== null && day > cutoffDay) continue;
    if (ds?.frühAbsence === 'FE' || ds?.spätAbsence === 'FE') continue;
    const net = calculateDayNetHours(ds);
    if (net > 0) {
      entries.push({
        date,
        hours: Math.round(net * 100) / 100,
        cost: Math.round(net * wage * 100) / 100,
      });
    }
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

/** Daily actual hours for one employee from the same MIRUS cache used on PersonalFix. */
export function loadDailyIstDetails(
  empId: string,
  year: number,
  month: number,
  cutoffDay: number | null,
  wage: number,
  keyFn: KeyFn = key => key,
): FlexDayEntry[] {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const data = readRecord(keyFn(`actual-hours-${prefix}`));
  const entries: FlexDayEntry[] = [];
  for (const [cellKey, val] of Object.entries(data)) {
    const date = cellKey.slice(-10);
    if (!date.startsWith(prefix) || cellKey.slice(0, cellKey.length - 11) !== empId) continue;
    const day = Number(date.slice(-2));
    if (cutoffDay !== null && day > cutoffDay) continue;
    const absenceType = typeof val === 'object' ? val.absenceType : undefined;
    if (absenceType === 'FE') continue;
    const hours = typeof val === 'number' ? val : (val.hours ?? 0);
    if (hours > 0) {
      entries.push({
        date,
        hours: Math.round(hours * 100) / 100,
        cost: Math.round(hours * wage * 100) / 100,
      });
    }
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Last day with real imported actual hours. Automated plan_sync mirrors do not
 * close a week; legacy entries without a source remain valid MIRUS actuals.
 */
export function loadMirusIstStichtag(
  year: number,
  month: number,
  keyFn: KeyFn = key => key,
): string {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const data = readRecord(keyFn(`actual-hours-${prefix}`));
  let max = '';
  for (const [cellKey, val] of Object.entries(data)) {
    const date = cellKey.slice(-10);
    if (!date.startsWith(prefix)) continue;
    const source = typeof val === 'object' ? val.source : undefined;
    if (source === 'plan_sync') continue;
    const hours = typeof val === 'number' ? val : (val.hours ?? 0);
    if (hours > 0 && date > max) max = date;
  }
  return max;
}

function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const day = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

function isoWeekLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const day = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() + 4 - day);
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const kw = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `KW ${kw}`;
}

/**
 * Canonical weekly Flex facts for PersonalFix and the Cockpit PDF.
 * Plan and actual are capped to the same real-MIRUS cutoff in partial weeks.
 */
export function buildFlexWeeklyEvaluation(params: {
  year: number;
  month: number;
  employees: FlexWeeklyEmployeeInput[];
  keyFn?: KeyFn;
  cutoffDay?: number | null;
  todayIso?: string;
}): FlexWeeklyEvaluation {
  const { year, month, employees } = params;
  const keyFn = params.keyFn ?? (key => key);
  const cutoffDay = params.cutoffDay ?? null;
  const now = new Date();
  const todayIso = params.todayIso
    ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const lastIstDate = loadMirusIstStichtag(year, month, keyFn);
  type EmployeeDay = { planH: number; istH: number; planCost: number; istCost: number };
  const byDate = new Map<string, Map<string, EmployeeDay>>();
  const employeeInfo = new Map(employees.map(emp => [emp.id, emp]));

  const cell = (date: string, id: string): EmployeeDay => {
    let perEmployee = byDate.get(date);
    if (!perEmployee) {
      perEmployee = new Map();
      byDate.set(date, perEmployee);
    }
    let value = perEmployee.get(id);
    if (!value) {
      value = { planH: 0, istH: 0, planCost: 0, istCost: 0 };
      perEmployee.set(id, value);
    }
    return value;
  };

  for (const employee of employees) {
    if (!(employee.wage > 0)) continue;
    const sourceId = employee.sourceId ?? employee.id;
    const isActiveDate = (date: string) =>
      (!employee.activeFrom || date >= employee.activeFrom)
      && (!employee.activeTo || date <= employee.activeTo);
    for (const entry of loadDailyPlanDetails(sourceId, year, month, cutoffDay, employee.wage, keyFn)) {
      if (!isActiveDate(entry.date)) continue;
      const value = cell(entry.date, employee.id);
      value.planH += entry.hours;
      value.planCost += entry.cost;
    }
    for (const entry of loadDailyIstDetails(sourceId, year, month, cutoffDay, employee.wage, keyFn)) {
      if (!isActiveDate(entry.date)) continue;
      const value = cell(entry.date, employee.id);
      value.istH += entry.hours;
      value.istCost += entry.cost;
    }
  }

  const days: FlexWeeklyDay[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, perEmployee]) => ({
      date,
      planH: [...perEmployee.values()].reduce((sum, value) => sum + value.planH, 0),
      istH: [...perEmployee.values()].reduce((sum, value) => sum + value.istH, 0),
      planCost: [...perEmployee.values()].reduce((sum, value) => sum + value.planCost, 0),
      istCost: [...perEmployee.values()].reduce((sum, value) => sum + value.istCost, 0),
    }));

  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const weekDates = new Map<string, string[]>();
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${monthPrefix}-${String(day).padStart(2, '0')}`;
    const monday = mondayOf(date);
    (weekDates.get(monday) ?? weekDates.set(monday, []).get(monday)!).push(date);
  }
  const completedRange = getLastCompletedWeekRange(
    `${monthPrefix}-01`,
    `${monthPrefix}-${String(daysInMonth).padStart(2, '0')}`,
    todayIso,
  );

  const weeks: FlexWeeklyWeek[] = [...weekDates.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monday, allDates]) => {
      const offen = completedRange === null || monday > completedRange.from;
      const teilweise = !offen && (lastIstDate === '' || allDates.some(date => date > lastIstDate));
      const dates = offen
        ? allDates
        : (lastIstDate ? allDates.filter(date => date <= lastIstDate) : []);
      const dateSet = new Set(dates);
      const employeesForWeek: FlexWeeklyEmployeeRow[] = [];
      for (const [id, employee] of employeeInfo) {
        let planH = 0;
        let istH = 0;
        let planCost = 0;
        let istCost = 0;
        for (const date of dateSet) {
          const value = byDate.get(date)?.get(id);
          if (!value) continue;
          planH += value.planH;
          istH += value.istH;
          planCost += value.planCost;
          istCost += value.istCost;
        }
        if (planH <= 0 && istH <= 0) continue;
        employeesForWeek.push({
          id,
          name: employee.name,
          agOff: employee.agOff === true,
          planH,
          istH,
          planCost: round2(planCost),
          istCost: round2(istCost),
        });
      }
      employeesForWeek.sort((a, b) => a.name.localeCompare(b.name, 'de'));
      return {
        label: isoWeekLabel(monday),
        von: dates[0] ?? allDates[0],
        bis: dates[dates.length - 1] ?? allDates[allDates.length - 1],
        dates,
        offen,
        teilweise,
        planH: employeesForWeek.reduce((sum, row) => sum + row.planH, 0),
        istH: employeesForWeek.reduce((sum, row) => sum + row.istH, 0),
        planCost: round2(employeesForWeek.reduce((sum, row) => sum + row.planCost, 0)),
        istCost: round2(employeesForWeek.reduce((sum, row) => sum + row.istCost, 0)),
        employees: employeesForWeek,
      };
    });

  return { lastIstDate, days, weeks };
}