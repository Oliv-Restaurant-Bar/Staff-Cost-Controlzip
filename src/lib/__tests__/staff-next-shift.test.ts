import { describe, it, expect } from 'vitest';
import { nextShiftFor } from '../staff-next-shift';
import type { PublicDay, WeekPayload } from '../schedule-publish-payload';

const day = (date: string, over: Partial<PublicDay> = {}): PublicDay => ({
  date, früh: null, spät: null, frühAbsence: null, spätAbsence: null, ...over,
});

const week = (weekStart: string, days: PublicDay[], name = 'Anna'): WeekPayload => ({
  version: 1, department: 'service', weekStart, weekEnd: weekStart, kw: 1,
  employees: [{ id: 'x', name, days }],
});

const at = (iso: string) => new Date(iso);

describe('nextShiftFor', () => {
  const w43 = week('2026-10-19', [
    day('2026-10-19', { früh: { start: '10:00', end: '14:00' } }),
    day('2026-10-21', { frühAbsence: 'Ferien' }),
    day('2026-10-22', { früh: { start: '11:00', end: '15:00' }, spät: { start: '17:00', end: '23:00' } }),
  ]);
  const w44 = week('2026-10-26', [day('2026-10-26', { spät: { start: '17:00', end: '22:00' } })]);

  it('nimmt die nächste Schicht ab heute und überspringt Abwesenheiten', () => {
    const n = nextShiftFor([w43, w44], 'Anna', at('2026-10-20T09:00:00'));
    expect(n).toMatchObject({ date: '2026-10-22', weekStart: '2026-10-19', isToday: false });
    expect(n?.times).toEqual(['11:00 – 15:00', '17:00 – 23:00']);
  });

  it('heute: bereits beendete Schichten zählen nicht', () => {
    const n = nextShiftFor([w43], 'Anna', at('2026-10-22T16:00:00'));
    expect(n).toMatchObject({ date: '2026-10-22', isToday: true, times: ['17:00 – 23:00'] });
  });

  it('heute vollständig vorbei → nächste spätere Schicht', () => {
    const n = nextShiftFor([w43, w44], 'Anna', at('2026-10-22T23:30:00'));
    expect(n).toMatchObject({ date: '2026-10-26', weekStart: '2026-10-26' });
  });

  it('Nachtschicht (Ende nach Mitternacht) ist um 23:00 noch offen', () => {
    const night = week('2026-10-19', [day('2026-10-19', { spät: { start: '18:00', end: '02:00' } })]);
    expect(nextShiftFor([night], 'Anna', at('2026-10-19T23:00:00'))?.isToday).toBe(true);
  });

  it('keine Schicht mehr / unbekannter Name / leerer Name → null', () => {
    expect(nextShiftFor([w43, w44], 'Anna', at('2026-11-30T09:00:00'))).toBeNull();
    expect(nextShiftFor([w43], 'Berta', at('2026-10-19T09:00:00'))).toBeNull();
    expect(nextShiftFor([w43], '', at('2026-10-19T09:00:00'))).toBeNull();
  });

  it('Wochen in beliebiger Reihenfolge', () => {
    expect(nextShiftFor([w44, w43], 'Anna', at('2026-10-20T09:00:00'))?.date).toBe('2026-10-22');
  });
});
