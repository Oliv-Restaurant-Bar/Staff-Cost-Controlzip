import type { ControlListDocument } from './control-list-import';
import { isoWeekForDate } from './control-list-productivity';

/**
 * Replaces every week present in an incoming Kontrollliste while preserving up
 * to four earlier weeks. This keeps re-imports idempotent and gives the live
 * view and Cockpit export one shared five-week history.
 */
export function mergeControlListHistory(
  current: ControlListDocument | undefined,
  incoming: ControlListDocument,
  maxWeeks = 5,
): ControlListDocument {
  const incomingWeeks = new Set(incoming.employees.flatMap(employee => employee.days.map(day => isoWeekForDate(day.date))));
  const retained = (current?.employees ?? []).flatMap(employee =>
    employee.days
      .filter(day => !incomingWeeks.has(isoWeekForDate(day.date)))
      .map(day => ({ name: employee.name, inIst: employee.inIst, day })));
  const replacements = incoming.employees.flatMap(employee =>
    employee.days.map(day => ({ name: employee.name, inIst: employee.inIst, day })));
  const allRows = [...retained, ...replacements];
  const keptWeeks = new Set([...new Set(allRows.map(row => isoWeekForDate(row.day.date)))].sort().slice(-maxWeeks));
  const employees = new Map<string, { name: string; inIst: boolean; days: typeof incoming.employees[number]['days'] }>();

  for (const row of allRows.filter(item => keptWeeks.has(isoWeekForDate(item.day.date)))) {
    const normalized = row.name.trim().normalize('NFKC').toLocaleLowerCase('de-CH');
    const existing = employees.get(normalized) ?? { name: row.name, inIst: false, days: [] };
    existing.name = row.name;
    existing.inIst ||= row.inIst;
    const duplicateIndex = existing.days.findIndex(day => day.date === row.day.date);
    if (duplicateIndex >= 0) existing.days[duplicateIndex] = row.day;
    else existing.days.push(row.day);
    employees.set(normalized, existing);
  }

  const mergedEmployees = [...employees.values()]
    .map(employee => ({ ...employee, days: employee.days.sort((a, b) => a.date.localeCompare(b.date)) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de-CH'));
  const dates = mergedEmployees.flatMap(employee => employee.days.map(day => day.date)).sort();
  const formatDate = (value: string | undefined) => value
    ? new Date(`${value}T12:00:00`).toLocaleDateString('de-CH')
    : '—';

  return {
    tenant: incoming.tenant,
    period: `Kontrollliste ${formatDate(dates[0])} - ${formatDate(dates.at(-1))}`,
    employees: mergedEmployees,
  };
}