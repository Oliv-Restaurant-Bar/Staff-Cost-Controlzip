// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildControlPresenceByWeek,
  isHelperOnDate,
  normalizeControlListName,
  selectedHelperHourRows,
} from '@/lib/control-list-helper-detection';

describe('control-list helper detection', () => {
  const week = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30'];

  it('normalizes whitespace and casing for exact control-list names', () => {
    expect(normalizeControlListName('  Krasniqi   Ibrahim ')).toBe('krasniqi ibrahim');
  });

  it('recognizes regular and external Ist people absent from the week while excluding a mapped MIRUS employee', () => {
    const presence = buildControlPresenceByWeek([
      { name: 'Batushaj Brahim', days: week.map(date => ({ date })) },
      { name: '  Krasniqi   Ibrahim ', days: week.map(date => ({ date })) },
    ], name => name === 'Batushaj Brahim' ? '111' : undefined);

    expect(isHelperOnDate({ id: 'party', name: 'Pathi' }, '2026-08-25', presence)).toBe(true);
    expect(isHelperOnDate({ id: 'aush_external', name: 'Event Aushilfe' }, '2026-08-25', presence)).toBe(true);
    expect(isHelperOnDate({ id: '111', name: 'Batushaj Ibrahim' }, '2026-08-25', presence)).toBe(false);
    expect(isHelperOnDate({ id: 'other', name: 'KRASNIQI IBRAHIM' }, '2026-08-25', presence)).toBe(false);
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