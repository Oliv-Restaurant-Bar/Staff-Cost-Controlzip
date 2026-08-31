import { isoWeekForDate } from './control-list-productivity';

export interface HelperIdentity {
  id: string;
  name: string;
}

export interface ControlWeekPresence {
  names: Set<string>;
  employeeIds: Set<string>;
}

export interface HelperHoursRow<T extends HelperIdentity = HelperIdentity> {
  helper: T;
  days: Array<{ date: string; hours: number }>;
}

export function normalizeControlListName(name: string): string {
  return name.trim().normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('de-CH');
}

export function buildControlPresenceByWeek(
  employees: Array<{ name: string; days: Array<{ date: string }> }>,
  resolveEmployeeId: (name: string) => string | undefined,
): Map<string, ControlWeekPresence> {
  const result = new Map<string, ControlWeekPresence>();
  for (const employee of employees) {
    const matchedId = resolveEmployeeId(employee.name);
    for (const day of employee.days) {
      const weekKey = isoWeekForDate(day.date);
      const presence = result.get(weekKey) ?? { names: new Set<string>(), employeeIds: new Set<string>() };
      presence.names.add(normalizeControlListName(employee.name));
      if (matchedId) presence.employeeIds.add(matchedId);
      result.set(weekKey, presence);
    }
  }
  return result;
}

export function isHelperOnDate(
  person: HelperIdentity,
  date: string,
  presenceByWeek: Map<string, ControlWeekPresence>,
): boolean {
  const presence = presenceByWeek.get(isoWeekForDate(date));
  return !presence?.names.has(normalizeControlListName(person.name)) && !presence?.employeeIds.has(person.id);
}

export function selectedHelperHourRows<T extends HelperIdentity>(
  helperHours: HelperHoursRow<T>[],
  selections: Record<string, boolean>,
): Array<{ date: string; netHours: number }> {
  return helperHours.flatMap(({ helper, days }) => days
    .filter(day => day.hours > 0 && selections[`${helper.id}|${day.date}`])
    .map(day => ({ date: day.date, netHours: day.hours })));
}