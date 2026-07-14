// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { calculateBreakDeduction, resolveBreakHours } from '@/hooks/useShiftConfig';

describe('calculateBreakDeduction (automatische Pausenregel, Regression)', () => {
  it('bis und mit 9h → keine Pause', () => {
    expect(calculateBreakDeduction(0)).toBe(0);
    expect(calculateBreakDeduction(4)).toBe(0);
    expect(calculateBreakDeduction(8.5)).toBe(0);
    expect(calculateBreakDeduction(9)).toBe(0);
  });

  it('über 9h → 30 Minuten (0.5h)', () => {
    expect(calculateBreakDeduction(9.01)).toBe(0.5);
    expect(calculateBreakDeduction(9.5)).toBe(0.5);
    expect(calculateBreakDeduction(12)).toBe(0.5);
  });
});

describe('resolveBreakHours (SSoT Pausenauflösung)', () => {
  it('null/undefined → automatische Regel gilt (identisch zum Altverhalten)', () => {
    // ≤9h: keine automatische Pause
    expect(resolveBreakHours(8, null)).toBe(0);
    expect(resolveBreakHours(9, null)).toBe(0);
    expect(resolveBreakHours(8, undefined)).toBe(0);
    expect(resolveBreakHours(8)).toBe(0);
    // >9h: 30 Min automatisch
    expect(resolveBreakHours(9.5, null)).toBe(0.5);
    expect(resolveBreakHours(10, undefined)).toBe(0.5);
    expect(resolveBreakHours(10)).toBe(0.5);
  });

  it('0 = explizit „Keine Pause" — unterdrückt die automatische Regel auch >9h', () => {
    expect(resolveBreakHours(8, 0)).toBe(0);
    expect(resolveBreakHours(10, 0)).toBe(0);
    expect(resolveBreakHours(12, 0)).toBe(0);
  });

  it('30 Min manuell ERSETZT die automatische Regel (nie addieren)', () => {
    // ≤9h: manuell 30 Min obwohl automatisch keine fällig wäre
    expect(resolveBreakHours(6, 30)).toBe(0.5);
    expect(resolveBreakHours(9, 30)).toBe(0.5);
    // >9h: bleibt 0.5 — NICHT 0.5 (auto) + 0.5 (manuell)
    expect(resolveBreakHours(10, 30)).toBe(0.5);
    expect(resolveBreakHours(12, 30)).toBe(0.5);
  });

  it('60 Min manuell → 1h, unabhängig vom Brutto', () => {
    expect(resolveBreakHours(4, 60)).toBe(1);
    expect(resolveBreakHours(9, 60)).toBe(1);
    expect(resolveBreakHours(11, 60)).toBe(1);
  });
});

describe('Tages-Netto-Formel (UI ≡ Export): net = max(0, gross − resolveBreakHours)', () => {
  const dayNet = (gross: number, breakMinutes?: number | null): number => {
    if (gross <= 0) return 0;
    return Math.max(0, gross - resolveBreakHours(gross, breakMinutes));
  };

  it('Automatik: 8h bleibt 8h, 10h wird 9.5h', () => {
    expect(dayNet(8, null)).toBe(8);
    expect(dayNet(10, null)).toBe(9.5);
  });

  it('manuelle Pause reduziert nur die Arbeitszeit', () => {
    expect(dayNet(8, 30)).toBe(7.5);
    expect(dayNet(8, 60)).toBe(7);
    expect(dayNet(10, 0)).toBe(10);
    expect(dayNet(10, 60)).toBe(9);
  });

  it('nie negativ: Kurz-Slot mit 60 Min Pause → 0, nicht −0.75', () => {
    expect(dayNet(0.25, 60)).toBe(0);
    expect(dayNet(0.5, 60)).toBe(0);
  });

  it('kein Arbeits-Brutto → 0 (Pause nie auf Absenzstunden)', () => {
    expect(dayNet(0, 30)).toBe(0);
    expect(dayNet(0, 60)).toBe(0);
  });
});
