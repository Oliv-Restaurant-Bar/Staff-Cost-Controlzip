// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { buildFlexWeeklyEvaluation } from '@/lib/flex-weekly-ssot';

const tenantKey = (key: string) => `beaulieu:${key}`;
const cell = (employeeId: string, date: string) => `${employeeId}|${date}`;
const shift = (start: string, end: string) => ({ früh: { start, end } });

describe('Flex weekly SSOT', () => {
  beforeEach(() => localStorage.clear());

  it('includes external helpers without plan and caps plan and actual to the same MIRUS date', () => {
    localStorage.setItem(tenantKey('schedule-v2-2026-08'), JSON.stringify({
      [cell('goi', '2026-08-17')]: shift('08:00', '16:00'),
      [cell('goi', '2026-08-21')]: shift('08:00', '16:00'),
      [cell('goi', '2026-08-22')]: shift('08:00', '16:00'),
    }));
    localStorage.setItem(tenantKey('actual-hours-2026-08'), JSON.stringify({
      [cell('goi', '2026-08-17')]: { hours: 7.5, source: 'mirus' },
      [cell('goi', '2026-08-21')]: { hours: 8.5, source: 'mirus' },
      [cell('goi', '2026-08-22')]: { hours: 8, source: 'plan_sync' },
      [cell('aush_yuliia', '2026-08-17')]: { hours: 2.25, source: 'mirus' },
      [cell('aush_yuliia', '2026-08-21')]: { hours: 3.75, source: 'mirus' },
    }));

    const result = buildFlexWeeklyEvaluation({
      year: 2026,
      month: 8,
      keyFn: tenantKey,
      employees: [
        { id: 'goi', name: 'Goi Isabelle', wage: 32 },
        { id: 'aush_yuliia', name: 'Dzhymsheleishvili Yuliia', wage: 28.9 },
      ],
    });

    expect(result.lastIstDate).toBe('2026-08-21');
    const week = result.weeks.find(row => row.label === 'KW 34');
    expect(week).toMatchObject({
      teilweise: true,
      offen: false,
      von: '2026-08-17',
      bis: '2026-08-21',
      planH: 16,
      istH: 22,
      planCost: 512,
      istCost: 685.4,
    });
    expect(week?.employees.find(row => row.id === 'aush_yuliia')).toMatchObject({
      planH: 0,
      istH: 6,
      planCost: 0,
      istCost: 173.4,
    });
    expect(week?.dates).not.toContain('2026-08-22');
  });

  it('uses tenant-scoped caches and does not count FE as Flex work', () => {
    localStorage.setItem('schedule-v2-2026-08', JSON.stringify({
      [cell('foreign', '2026-08-18')]: shift('08:00', '18:00'),
    }));
    localStorage.setItem(tenantKey('schedule-v2-2026-08'), JSON.stringify({
      [cell('goi', '2026-08-18')]: { ...shift('08:00', '16:00'), frühAbsence: 'FE' },
    }));
    localStorage.setItem(tenantKey('actual-hours-2026-08'), JSON.stringify({
      [cell('goi', '2026-08-18')]: { hours: 8, absenceType: 'FE', source: 'mirus' },
      [cell('goi', '2026-08-19')]: { hours: 4, source: 'mirus' },
    }));

    const result = buildFlexWeeklyEvaluation({
      year: 2026,
      month: 8,
      keyFn: tenantKey,
      employees: [{ id: 'goi', name: 'Goi Isabelle', wage: 30 }],
    });

    expect(result.lastIstDate).toBe('2026-08-19');
    expect(result.weeks).toHaveLength(1);
    expect(result.weeks[0]).toMatchObject({ planH: 0, istH: 4, planCost: 0, istCost: 120 });
    expect(result.weeks[0].employees).toHaveLength(1);
  });

  it('reads split employees from the base ID and counts only their hourly phase', () => {
    localStorage.setItem(tenantKey('schedule-v2-2026-08'), JSON.stringify({
      [cell('switcher', '2026-08-14')]: shift('08:00', '16:00'),
      [cell('switcher', '2026-08-17')]: shift('08:00', '16:00'),
      [cell('switcher', '2026-08-18')]: shift('08:00', '16:00'),
    }));
    localStorage.setItem(tenantKey('actual-hours-2026-08'), JSON.stringify({
      [cell('switcher', '2026-08-14')]: { hours: 8, source: 'mirus' },
      [cell('switcher', '2026-08-17')]: { hours: 7, source: 'mirus' },
      [cell('switcher', '2026-08-18')]: { hours: 6, source: 'mirus' },
    }));

    const result = buildFlexWeeklyEvaluation({
      year: 2026,
      month: 8,
      keyFn: tenantKey,
      employees: [{
        id: 'switcher::flexsplit',
        sourceId: 'switcher',
        name: 'Wage Switcher',
        wage: 35,
        activeFrom: '2026-08-17',
        activeTo: '2026-08-31',
      }],
    });

    expect(result.lastIstDate).toBe('2026-08-18');
    const row = result.weeks[0].employees[0];
    expect(row).toMatchObject({
      id: 'switcher::flexsplit',
      planH: 16,
      istH: 13,
      planCost: 560,
      istCost: 455,
    });
    expect(result.weeks[0].dates).toEqual(['2026-08-17', '2026-08-18']);
  });
});