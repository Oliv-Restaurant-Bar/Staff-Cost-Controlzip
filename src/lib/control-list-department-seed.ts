import type { TenantId } from '@/contexts/TenantContext';
import type { ControlListDepartment } from './control-list-import';

interface DailyHoursEmployeeMeta {
  name?: unknown;
  department?: unknown;
  costCenter?: unknown;
}

export function departmentFromDailyHoursMeta(
  department: unknown,
  costCenter: unknown,
): ControlListDepartment | null {
  const text = `${String(costCenter ?? '')} ${String(department ?? '')}`.trim();
  const code = text.match(/(?:^|\s)([124])(?:\s|$)/)?.[1];
  if (code === '1') return 'kueche';
  if (code === '2') return 'service';
  if (code === '4') return 'geschaeftsleitung';
  if (/geschäftsleitung|geschaeftsleitung|direktion|management/i.test(text)) return 'geschaeftsleitung';
  if (/küche|kueche|kitchen|koch/i.test(text)) return 'kueche';
  if (/service|saal/i.test(text)) return 'service';
  return null;
}

/**
 * Reads the latest locally available Tägliche-Stunden review session. The
 * source remains read-only and is ignored unless its restaurant matches the
 * active tenant.
 */
export function loadDailyHoursDepartmentSeed(tenantId: TenantId): Record<string, ControlListDepartment> {
  try {
    const raw = localStorage.getItem('mirus_review_session');
    if (!raw) return {};
    const session = JSON.parse(raw) as { restaurant?: unknown; employees?: DailyHoursEmployeeMeta[] };
    const restaurant = String(session.restaurant ?? '').toLocaleLowerCase('de-CH');
    const correctTenant = tenantId === 'oliv'
      ? restaurant.includes('3027') || restaurant.includes('oliv')
      : restaurant.includes('3012') || restaurant.includes('beaulieu');
    if (!correctTenant || !Array.isArray(session.employees)) return {};
    return Object.fromEntries(session.employees.flatMap(employee => {
      const name = String(employee.name ?? '').trim();
      const department = departmentFromDailyHoursMeta(employee.department, employee.costCenter);
      return name && department ? [[name, department]] : [];
    }));
  } catch {
    return {};
  }
}