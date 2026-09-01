// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildControlHoursIndex,
  controlHoursForPerson,
  manualSupplementHours,
  normalizeControlListName,
  selectedHelperHourRows,
  supplementHoursForPerson,
} from '@/lib/control-list-helper-detection';

describe('control-list helper detection', () => {
  const week = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30'];

  it('normalizes whitespace and casing for exact control-list names', () => {
    expect(normalizeControlListName('  Krasniqi   Ibrahim ')).toBe('krasniqi ibrahim');
  });

  it('indexes control hours by normalized name and mapped employee id', () => {
    const index = buildControlHoursIndex([
      { name: 'Batushaj Brahim', days: week.map(date => ({ date, netHours: 8 })) },
      { name: '  Krasniqi   Ibrahim ', days: week.map(date => ({ date, netHours: 7 })) },
    ], name => name === 'Batushaj Brahim' ? '111' : undefined);

    expect(controlHoursForPerson({ id: '111', name: 'Batushaj Ibrahim' }, '2026-08-25', index)).toBe(8);
    expect(controlHoursForPerson({ id: 'other', name: 'KRASNIQI IBRAHIM' }, '2026-08-25', index)).toBe(7);
    expect(controlHoursForPerson({ id: 'party', name: 'Pathi' }, '2026-08-25', index)).toBe(0);
  });

  it('returns only manual positive daily excess and ignores MIRUS rounding differences', () => {
    expect(manualSupplementHours(3.1, 0, null)).toBe(3.1);
    expect(manualSupplementHours(8.4, 0, 'manual_edit')).toBe(8.4);
    expect(manualSupplementHours(8.4, 8, 'manual')).toBe(0.4);
    expect(manualSupplementHours(3.32, 3.3166666667, 'import')).toBe(0);
    expect(manualSupplementHours(3.32, 3.3166666667, null)).toBe(0);
    expect(manualSupplementHours(8, 0, 'plan_sync')).toBe(0);
  });

  it('finds both a wholly absent helper and regular employee supplementary days', () => {
    const index = buildControlHoursIndex([
      { name: 'Domi Sadete', days: week.slice(0, 5).map(date => ({ date, netHours: 3.1 })) },
    ], () => '21');
    expect(supplementHoursForPerson({ id: 'party', name: 'Pathi' }, '2026-08-25', { hours: 8.4, source: null }, index)).toBe(8.4);
    expect(supplementHoursForPerson({ id: '21', name: 'Domi Sadete' }, '2026-08-25', { hours: 3.1, source: 'import' }, index)).toBe(0);
    expect(supplementHoursForPerson({ id: '21', name: 'Domi Sadete' }, '2026-08-29', { hours: 3.1, source: null }, index)).toBe(3.1);
  });

  it('adds only positively selected helper days', () => {
    const rows = selectedHelperHourRows([
      {
        helper: { id: 'party', name: 'Pathi' },
        days: [
          { date: '2026-08-25', hours: 8.4 },
          { date: '2026-08-26', hours: 8.4 },
          { date: '2026-08-27', hours: 0 },
        ],
      },
    ], {
      'party|2026-08-25': true,
      'party|2026-08-26': false,
      'party|2026-08-27': true,
    });

    expect(rows).toEqual([{ date: '2026-08-25', netHours: 8.4 }]);
  });
});