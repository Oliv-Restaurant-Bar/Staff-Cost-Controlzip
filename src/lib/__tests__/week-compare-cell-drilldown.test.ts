// @vitest-environment happy-dom
/**
 * Zell-Detail-Drill-down: DayPositionHint.assigned muss exakt zur planned-
 * Kopfzahl passen (Dedupe Früh+Spät = 1 Person) und shiftLabelForSlots
 * klassifiziert Mittag/Abend/durchgehend korrekt.
 */
import { describe, it, expect } from 'vitest';
import { shiftLabelForSlots } from '@/components/schedule-planner/WeekCompareCellDialog';
import { computeDayPlanHints } from '@/lib/staffing-day-hints';
import type { Position } from '@/types/positions';
import type { StaffingRequirement } from '@/types/staffing';

const pos = (key: string, name: string): Position => ({
  key, name, department: 'küche', departmentGroup: 'kueche_produktion',
  color: '#000', icon: 'ChefHat', sortOrder: 1, active: true,
} as unknown as Position);

const req = (positionKey: string, shiftStart: string, shiftEnd: string, requiredCount = 1): StaffingRequirement => ({
  id: `${positionKey}-${shiftStart}`, positionKey, scopeType: 'weekly', season: 'sommer', weekday: 1,
  shiftStart, shiftEnd, requiredCount, meta: {},
} as unknown as StaffingRequirement);

describe('DayPositionHint.assigned (Drill-down)', () => {
  it('assigned.length === planned, Früh+Spät derselben Person = 1 Person mit 2 Slots', () => {
    const hints = computeDayPlanHints({
      positions: [pos('kochen_heiss', 'Kochen (heiss)')],
      requirements: [req('kochen_heiss', '10:00', '14:30'), req('kochen_heiss', '17:00', '23:00')],
      plannedEmployees: [
        {
          id: 'koch1', department: 'küche', positionKey: 'kochen_heiss',
          slots: [{ start: '10:00', end: '14:30' }, { start: '17:00', end: '23:00' }],
        },
        {
          id: 'koch2', department: 'küche', positionKey: 'kochen_heiss',
          slots: [{ start: '17:00', end: '23:00' }],
        },
      ],
      season: 'sommer',
      weekday: 1,
    });
    const row = hints.positions.find((p) => p.positionKey === 'kochen_heiss')!;
    expect(row.planned).toBe(2);
    expect(row.assigned).toHaveLength(row.planned);
    const koch1 = row.assigned.find((a) => a.id === 'koch1')!;
    expect(koch1.slots).toHaveLength(2);
    expect(koch1.slots[0].start).toBe('10:00'); // chronologisch sortiert
    expect(shiftLabelForSlots(koch1.slots)).toBe('Mittag + Abend');
  });
});

describe('shiftLabelForSlots', () => {
  it('klassifiziert Mittag/Abend/durchgehend/Split', () => {
    expect(shiftLabelForSlots([{ start: '10:00', end: '14:30' }])).toBe('Mittag');
    expect(shiftLabelForSlots([{ start: '17:00', end: '23:00' }])).toBe('Abend');
    expect(shiftLabelForSlots([{ start: '10:00', end: '22:00' }])).toBe('durchgehend');
    expect(shiftLabelForSlots([
      { start: '10:00', end: '14:00' },
      { start: '17:00', end: '22:00' },
    ])).toBe('Mittag + Abend');
    expect(shiftLabelForSlots([])).toBe('—');
  });
});
