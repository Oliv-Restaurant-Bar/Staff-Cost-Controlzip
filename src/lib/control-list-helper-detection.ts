export interface HelperIdentity {
  id: string;
  name: string;
}

export interface ControlHoursIndex {
  byNameAndDate: Map<string, number>;
  byEmployeeAndDate: Map<string, number>;
}

export interface HelperHoursRow<T extends HelperIdentity = HelperIdentity> {
  helper: T;
  days: Array<{ date: string; hours: number }>;
}

export function normalizeControlListName(name: string): string {
  return name.trim().normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('de-CH');
}

export function buildControlHoursIndex(
  employees: Array<{ name: string; days: Array<{ date: string; netHours: number }> }>,
  resolveEmployeeId: (name: string) => string | undefined,
): ControlHoursIndex {
  const result: ControlHoursIndex = {
    byNameAndDate: new Map<string, number>(),
    byEmployeeAndDate: new Map<string, number>(),
  };
  for (const employee of employees) {
    const matchedId = resolveEmployeeId(employee.name);
    for (const day of employee.days) {
      const nameKey = `${normalizeControlListName(employee.name)}|${day.date}`;
      result.byNameAndDate.set(nameKey, (result.byNameAndDate.get(nameKey) ?? 0) + day.netHours);
      if (matchedId) {
        const employeeKey = `${matchedId}|${day.date}`;
        result.byEmployeeAndDate.set(employeeKey, (result.byEmployeeAndDate.get(employeeKey) ?? 0) + day.netHours);
      }
    }
  }
  return result;
}

export function controlHoursForPerson(
  person: HelperIdentity,
  date: string,
  index: ControlHoursIndex,
): number {
  return index.byEmployeeAndDate.get(`${person.id}|${date}`)
    ?? index.byNameAndDate.get(`${normalizeControlListName(person.name)}|${date}`)
    ?? 0;
}

export function isManualActualSource(source: string | null | undefined): boolean {
  return source == null || source === 'manual' || source === 'manual_edit';
}

export function manualSupplementHours(
  actualHours: number,
  controlHours: number,
  source: string | null | undefined,
): number {
  if (!isManualActualSource(source) || !(actualHours > 0)) return 0;
  const roundedDifference = Math.round((actualHours - controlHours + Number.EPSILON) * 100) / 100;
  return roundedDifference > 0 ? roundedDifference : 0;
}

export function supplementHoursForPerson(
  person: HelperIdentity,
  date: string,
  actual: { hours: number; source?: string | null } | undefined,
  index: ControlHoursIndex,
): number {
  if (!actual) return 0;
  return manualSupplementHours(actual.hours, controlHoursForPerson(person, date, index), actual.source);
}

export function selectedHelperHourRows<T extends HelperIdentity>(
  helperHours: HelperHoursRow<T>[],
  selections: Record<string, boolean>,
): Array<{ date: string; netHours: number }> {
  return helperHours.flatMap(({ helper, days }) => days
    .filter(day => day.hours > 0 && selections[`${helper.id}|${day.date}`])
    .map(day => ({ date: day.date, netHours: day.hours })));
}