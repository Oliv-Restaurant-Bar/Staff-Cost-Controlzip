// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { calendarDatesForScope, requiresTimelineAttention, timelineStyle, workedDays } from '../control-list-timeline';

describe('control-list timeline domain', () => {
  it('maps cross-midnight windows into the 07:00–02:00 operational domain', () => {
    expect(timelineStyle({ start: 18, end: 1 })).toEqual({ left: '57.89473684210527%', width: '36.84210526315789%' });
  });

  it('keeps early finishing windows visible at the next-day end of the domain', () => {
    expect(timelineStyle({ start: 0, end: 2 })).toEqual({ left: '89.47368421052632%', width: '10.526315789473683%' });
  });

  it('flags only long shifts or effective windows ending after midnight', () => {
    expect(requiresTimelineAttention({ netHours: 8.5, effectiveWindows: [{ start: 14, end: 23.9 }] })).toBe(false);
    expect(requiresTimelineAttention({ netHours: 8.5, effectiveWindows: [{ start: 18, end: 25 }] })).toBe(true);
    expect(requiresTimelineAttention({ netHours: 8.5, effectiveWindows: [{ start: 18, end: 1 }] })).toBe(true);
    expect(requiresTimelineAttention({ netHours: 9, effectiveWindows: [] })).toBe(true);
  });

  it('excludes zero and negative rows before any timeline or matrix representation', () => {
    expect(workedDays([{ netHours: 0 }, { netHours: -0.5 }, { netHours: 4.25 }])).toEqual([{ netHours: 4.25 }]);
  });

  it('keeps every calendar date in month and year scopes, including helper-only days', () => {
    const august = calendarDatesForScope('2026-08-17', 'month');
    expect(august).toHaveLength(31);
    expect(august).toContain('2026-08-21');
    expect(august[0]).toBe('2026-08-01');
    expect(august.at(-1)).toBe('2026-08-31');

    const leapYear = calendarDatesForScope('2028-08-17', 'year');
    expect(leapYear).toHaveLength(366);
    expect(leapYear).toContain('2028-02-29');
  });
});