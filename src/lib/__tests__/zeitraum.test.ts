// @vitest-environment node
/** Tests der gemeinsamen Zeitraum-Logik (Woche/Monat/Quartal/Jahr). */
import { describe, it, expect } from 'vitest';
import {
  getIsoWeek, isoWeekRange, wochenEndeVon, wochenDesJahres, zeitraumGrenzen,
  zeitraumLabel, shiftZeitraum, mitWochenStart, nextGesperrt,
  wechsleGranularitaet, initialZeitraum, type Zeitraum,
} from '../zeitraum';

const z = (p: Partial<Zeitraum>): Zeitraum => ({
  granular: 'monat', year: 2026, month: 7, quartal: 3, wochenStart: '2026-07-06', ...p,
});

describe('ISO-Wochen', () => {
  it('Woche über Monats-/Jahresgrenze', () => {
    expect(getIsoWeek('2026-01-01').week).toBe(1);
    expect(isoWeekRange(2026, 1)).toEqual({ from: '2025-12-29', to: '2026-01-04' });
    expect(wochenEndeVon('2026-07-27')).toBe('2026-08-02');
    expect(wochenDesJahres(2026).length).toBe(53);
    expect(wochenDesJahres(2025).length).toBe(52);
  });
});

describe('Grenzen & Labels', () => {
  it('zeitraumGrenzen je Granularität', () => {
    expect(zeitraumGrenzen(z({}))).toEqual({ from: '2026-07-01', to: '2026-07-31' });
    expect(zeitraumGrenzen(z({ granular: 'jahr' }))).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(zeitraumGrenzen(z({ granular: 'quartal', quartal: 2 }))).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(zeitraumGrenzen(z({ granular: 'woche', wochenStart: '2026-07-27' }))).toEqual({ from: '2026-07-27', to: '2026-08-02' });
  });
  it('Labels', () => {
    expect(zeitraumLabel(z({ granular: 'jahr' }))).toBe('Jahr 2026');
    expect(zeitraumLabel(z({ granular: 'quartal', quartal: 1 }))).toBe('Q1 2026');
    expect(zeitraumLabel(z({ granular: 'woche', wochenStart: '2026-07-06' }))).toContain('KW 28');
  });
});

describe('Blättern & Sperren', () => {
  it('shift über Jahres-/Quartalsgrenzen; Woche folgt dem Montag', () => {
    expect(shiftZeitraum(z({ month: 1 }), -1)).toMatchObject({ year: 2025, month: 12 });
    expect(shiftZeitraum(z({ granular: 'quartal', quartal: 1 }), -1)).toMatchObject({ year: 2025, quartal: 4 });
    const w = shiftZeitraum(z({ granular: 'woche', wochenStart: '2026-07-27' }), 1);
    expect(w.wochenStart).toBe('2026-08-03');
    expect(w.month).toBe(8); // Ladeanker folgt dem Montag
  });
  it('nextGesperrt: aktuelle/zukünftige Periode gesperrt', () => {
    const heute = '2026-08-14';
    expect(nextGesperrt(z({ month: 8 }), heute)).toBe(true);
    expect(nextGesperrt(z({ month: 7 }), heute)).toBe(false);
    expect(nextGesperrt(z({ granular: 'jahr' }), heute)).toBe(true);
    expect(nextGesperrt(z({ granular: 'quartal', quartal: 3 }), heute)).toBe(true);
    expect(nextGesperrt(z({ granular: 'quartal', quartal: 2 }), heute)).toBe(false);
    expect(nextGesperrt(z({ granular: 'woche', wochenStart: '2026-08-10' }), heute)).toBe(true);
    expect(nextGesperrt(z({ granular: 'woche', wochenStart: '2026-08-03' }), heute)).toBe(false);
  });
});

describe('Granularitäts-Wechsel (FIBU-Muster)', () => {
  const heute = '2026-08-14';
  it('Woche: aktueller Monat → Woche von heute; sonst Woche des Monatsersten', () => {
    const a = wechsleGranularitaet(z({ year: 2026, month: 8 }), 'woche', heute);
    expect(a.wochenStart).toBe('2026-08-10');
    const b = wechsleGranularitaet(z({ year: 2026, month: 6 }), 'woche', heute);
    expect(b.wochenStart).toBe('2026-06-01');
  });
  it('Quartal folgt dem gewählten Monat; Monat/Jahr behalten Zustand', () => {
    expect(wechsleGranularitaet(z({ month: 5 }), 'quartal', heute).quartal).toBe(2);
    expect(wechsleGranularitaet(z({ granular: 'woche' }), 'monat', heute)).toMatchObject({ granular: 'monat', year: 2026, month: 7 });
  });
  it('initialZeitraum liefert konsistenten Start', () => {
    const i = initialZeitraum('woche', new Date('2026-08-14T12:00:00'));
    expect(i.wochenStart).toBe('2026-08-10');
    expect(i.month).toBe(8);
  });
});
