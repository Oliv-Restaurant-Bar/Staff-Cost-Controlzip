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
      todayIso: '2026-08-25',
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
    expect(result.weeks.filter(week => !week.offen).map(week => week.label))
      .toEqual(['KW 31', 'KW 32', 'KW 33', 'KW 34']);
    const week = result.weeks.find(row => row.label === 'KW 34');
    expect(week).toMatchObject({ planH: 0, istH: 4, planCost: 0, istCost: 120, offen: false });
    expect(week?.employees).toHaveLength(1);
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
      todayIso: '2026-08-25',
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
    const week = result.weeks.find(row => row.label === 'KW 34');
    const row = week!.employees[0];
    expect(row).toMatchObject({
      id: 'switcher::flexsplit',
      planH: 16,
      istH: 13,
      planCost: 560,
      istCost: 455,
    });
    expect(week!.dates).toEqual(['2026-08-17', '2026-08-18']);
  });

  it('uses the Cockpit calendar boundary even when MIRUS has current-week data', () => {
    localStorage.setItem(tenantKey('schedule-v2-2026-08'), JSON.stringify({
      [cell('goi', '2026-08-23')]: shift('08:00', '16:00'),
      [cell('goi', '2026-08-24')]: shift('08:00', '16:00'),
    }));
    localStorage.setItem(tenantKey('actual-hours-2026-08'), JSON.stringify({
      [cell('goi', '2026-08-23')]: { hours: 7, source: 'mirus' },
      [cell('goi', '2026-08-24')]: { hours: 9, source: 'mirus' },
    }));

    const result = buildFlexWeeklyEvaluation({
      year: 2026,
      month: 8,
      todayIso: '2026-08-25',
      keyFn: tenantKey,
      employees: [{ id: 'goi', name: 'Goi Isabelle', wage: 30 }],
    });

    expect(result.lastIstDate).toBe('2026-08-24');
    expect(result.weeks.filter(week => !week.offen).map(week => week.label))
      .toEqual(['KW 31', 'KW 32', 'KW 33', 'KW 34']);
    expect(result.weeks.find(week => week.label === 'KW 34')).toMatchObject({
      offen: false,
      planH: 8,
      istH: 7,
    });
    expect(result.weeks.find(week => week.label === 'KW 35')).toMatchObject({
      offen: true,
    });
  });

  it('fills the last completed week from authoritative MIRUS rows when the local cache is stale', () => {
    localStorage.setItem(tenantKey('actual-hours-2026-08'), JSON.stringify({
      [cell('goi', '2026-08-16')]: { hours: 5, source: 'mirus' },
      [cell('goi', '2026-08-31')]: { hours: 99, source: 'mirus' },
    }));
    localStorage.setItem(tenantKey('schedule-v2-2026-08'), JSON.stringify({
      [cell('goi', '2026-08-17')]: shift('08:00', '16:00'),
      [cell('goi', '2026-08-23')]: shift('08:00', '16:00'),
    }));

    const result = buildFlexWeeklyEvaluation({
      year: 2026,
      month: 8,
      todayIso: '2026-08-25',
      keyFn: tenantKey,
      actualHours: {
        [cell('goi', '2026-08-17')]: { hours: 7, source: 'mirus' },
        [cell('goi', '2026-08-23')]: { hours: 9, source: 'mirus' },
        [cell('goi', '2026-08-24')]: { hours: 10, source: 'mirus' },
      },
      employees: [{ id: 'goi', name: 'Goi Isabelle', wage: 30 }],
    });

    expect(result.lastIstDate).toBe('2026-08-24');
    expect(result.weeks.find(week => week.label === 'KW 34')).toMatchObject({
      offen: false,
      planH: 16,
      istH: 16,
      planCost: 480,
      istCost: 480,
    });
    expect(result.weeks.find(week => week.label === 'KW 35')).toMatchObject({
      offen: true,
    });
    expect(result.weeks.find(week => week.label === 'KW 36')).toMatchObject({
      offen: true,
      istH: 0,
    });
  });

  it('keeps local absence and additional-cost overrides over remote MIRUS rows', () => {
    localStorage.setItem(tenantKey('actual-hours-2026-08'), JSON.stringify({
      [cell('goi', '2026-08-17')]: { hours: 0, absenceType: 'FE' },
      [cell('goi', '2026-08-18')]: { hours: 4, isAdditionalCost: true },
    }));

    const result = buildFlexWeeklyEvaluation({
      year: 2026,
      month: 8,
      todayIso: '2026-08-25',
      keyFn: tenantKey,
      actualHours: {
        [cell('goi', '2026-08-17')]: { hours: 8, source: 'mirus' },
        [cell('goi', '2026-08-18')]: { hours: 8, source: 'mirus' },
        [cell('goi', '2026-08-23')]: { hours: 6, source: 'mirus' },
      },
      employees: [{ id: 'goi', name: 'Goi Isabelle', wage: 30 }],
    });

    expect(result.weeks.find(week => week.label === 'KW 34')).toMatchObject({
      istH: 6,
      istCost: 180,
    });
  });

  it('does not let additional-cost rows advance the real MIRUS cutoff', () => {
    const result = buildFlexWeeklyEvaluation({
      year: 2026,
      month: 8,
      todayIso: '2026-08-25',
      keyFn: tenantKey,
      actualHours: {
        [cell('goi', '2026-08-23')]: { hours: 6, source: 'mirus' },
        [cell('goi', '2026-08-24')]: { hours: 12, source: 'mirus', isAdditionalCost: true },
      },
      employees: [{ id: 'goi', name: 'Goi Isabelle', wage: 30 }],
    });

    expect(result.lastIstDate).toBe('2026-08-23');
    expect(result.weeks.find(week => week.label === 'KW 34')).toMatchObject({
      istH: 6,
      istCost: 180,
    });
    expect(result.weeks.find(week => week.label === 'KW 35')).toMatchObject({
      offen: true,
      istH: 0,
    });
  });

  it('treats a successful empty remote result as authoritative over stale local hours', () => {
    localStorage.setItem(tenantKey('actual-hours-2026-08'), JSON.stringify({
      [cell('goi', '2026-08-23')]: { hours: 99, source: 'mirus' },
    }));

    const result = buildFlexWeeklyEvaluation({
      year: 2026,
      month: 8,
      todayIso: '2026-08-25',
      keyFn: tenantKey,
      actualHours: {},
      employees: [{ id: 'goi', name: 'Goi Isabelle', wage: 30 }],
    });

    expect(result.lastIstDate).toBe('');
    expect(result.weeks.find(week => week.label === 'KW 34')).toMatchObject({
      offen: false,
      istH: 0,
      istCost: 0,
    });
  });
});