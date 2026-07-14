// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  calculateBreakDeduction, resolveBreakHours, resolveDayBreakHours,
  slotGrossHours, calculateNetShiftHours, calculateDayNetHours, calculateDaySlotNetHours,
} from '@/hooks/useShiftConfig';

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

describe('resolveDayBreakHours (SSoT Pause pro EINSATZ, Migration 20260714)', () => {
  it('keine Felder / leeres Objekt → Automatik-Regel (>9h → 30 Min)', () => {
    expect(resolveDayBreakHours(null, 8)).toBe(0);
    expect(resolveDayBreakHours(undefined, 10)).toBe(0.5);
    expect(resolveDayBreakHours({}, 8)).toBe(0);
    expect(resolveDayBreakHours({}, 10)).toBe(0.5);
  });

  it('eine Einsatz-Pause manuell → Summe, nicht gesetzter Einsatz = 0; ERSETZT Automatik', () => {
    // 10h Brutto: Automatik wäre 30 Min — manuell 0 im 1. Einsatz unterdrückt sie
    expect(resolveDayBreakHours({ fruehBreakMinutes: 0 }, 10)).toBe(0);
    expect(resolveDayBreakHours({ spaetBreakMinutes: 0 }, 10)).toBe(0);
    expect(resolveDayBreakHours({ fruehBreakMinutes: 30 }, 6)).toBe(0.5);
    expect(resolveDayBreakHours({ spaetBreakMinutes: 60 }, 6)).toBe(1);
  });

  it('beide Einsatz-Pausen gesetzt → Summe (nie zusätzlich Automatik addieren)', () => {
    expect(resolveDayBreakHours({ fruehBreakMinutes: 30, spaetBreakMinutes: 30 }, 12)).toBe(1);
    expect(resolveDayBreakHours({ fruehBreakMinutes: 60, spaetBreakMinutes: 30 }, 12)).toBe(1.5);
    expect(resolveDayBreakHours({ fruehBreakMinutes: 0, spaetBreakMinutes: 0 }, 12)).toBe(0);
  });

  it('Legacy-Tages-Pause breakMinutes bleibt Lese-Fallback (alte Daten)', () => {
    expect(resolveDayBreakHours({ breakMinutes: 60 }, 8)).toBe(1);
    expect(resolveDayBreakHours({ breakMinutes: 0 }, 10)).toBe(0);
    // Einsatz-Pause gewinnt gegen Legacy-Wert
    expect(resolveDayBreakHours({ fruehBreakMinutes: 30, breakMinutes: 60 }, 8)).toBe(0.5);
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

describe('slotGrossHours (Brutto EINES Einsatzes)', () => {
  it('normale Zeiten, Mitternachts-Überlauf, leere/ungültige Slots', () => {
    expect(slotGrossHours({ start: '10:00', end: '14:00' })).toBe(4);
    expect(slotGrossHours({ start: '17:30', end: '23:00' })).toBe(5.5);
    expect(slotGrossHours({ start: '22:00', end: '02:00' })).toBe(4); // über Mitternacht
    expect(slotGrossHours(null)).toBe(0);
    expect(slotGrossHours({})).toBe(0);
    expect(slotGrossHours({ start: '10:00', end: null })).toBe(0);
    expect(slotGrossHours({ start: 'abc', end: '14:00' })).toBe(0);
  });
});

describe('calculateNetShiftHours (Netto EINES Einsatzes, null bei ungültig)', () => {
  it('Ende − Start − Pause, nie unter 0', () => {
    expect(calculateNetShiftHours({ startTime: '10:00', endTime: '14:00', breakMinutes: 0 })).toBe(4);
    expect(calculateNetShiftHours({ startTime: '17:30', endTime: '23:00', breakMinutes: 30 })).toBe(5);
    expect(calculateNetShiftHours({ startTime: '10:00', endTime: '10:15', breakMinutes: 60 })).toBe(0); // Clamping
  });

  it('fehlende/ungültige Zeiten → null (nie stillschweigend 0)', () => {
    expect(calculateNetShiftHours({ startTime: null, endTime: '14:00' })).toBeNull();
    expect(calculateNetShiftHours({ startTime: '10:00', endTime: undefined })).toBeNull();
    expect(calculateNetShiftHours({ startTime: 'x', endTime: '14:00' })).toBeNull();
  });
});

describe('calculateDayNetHours (SSoT Tages-Netto, Pause pro Einsatz)', () => {
  it('SPEC-Fall: 10–14 ohne Pause + 17:30–23 mit 30 Min → 9.0h (nicht 9.5)', () => {
    expect(calculateDayNetHours({
      früh: { start: '10:00', end: '14:00' },
      spät: { start: '17:30', end: '23:00' },
      fruehBreakMinutes: 0,
      spaetBreakMinutes: 30,
    })).toBe(9);
  });

  it('manuelle Einsatz-Pausen: 4.0 / 3.5 / 3.0 je nach Pausensumme', () => {
    const day = {
      früh: { start: '10:00', end: '12:00' },
      spät: { start: '18:00', end: '20:00' },
    };
    expect(calculateDayNetHours({ ...day, fruehBreakMinutes: 0, spaetBreakMinutes: 0 })).toBe(4);
    expect(calculateDayNetHours({ ...day, fruehBreakMinutes: 30, spaetBreakMinutes: 0 })).toBe(3.5);
    expect(calculateDayNetHours({ ...day, fruehBreakMinutes: 30, spaetBreakMinutes: 30 })).toBe(3);
  });

  it('Clamping PRO EINSATZ: Pause > Slot-Brutto zieht nie vom anderen Einsatz ab', () => {
    // früh 0.5h mit 60 Min Pause → 0 (nicht −0.5); spät 4h ohne Pause → 4
    expect(calculateDayNetHours({
      früh: { start: '10:00', end: '10:30' },
      spät: { start: '18:00', end: '22:00' },
      fruehBreakMinutes: 60,
      spaetBreakMinutes: 0,
    })).toBe(4);
  });

  it('ohne manuelle Pausen: Automatik (>9h → 30 Min) bzw. Legacy-Tagespause', () => {
    // 10h Brutto → Automatik 30 Min
    expect(calculateDayNetHours({
      früh: { start: '08:00', end: '13:00' },
      spät: { start: '17:00', end: '22:00' },
    })).toBe(9.5);
    // 8h Brutto → keine Automatik
    expect(calculateDayNetHours({ früh: { start: '08:00', end: '16:00' } })).toBe(8);
    // Legacy-Tagespause als Lese-Fallback
    expect(calculateDayNetHours({
      früh: { start: '08:00', end: '16:00' },
      breakMinutes: 60,
    })).toBe(7);
  });

  it('leer/null → 0', () => {
    expect(calculateDayNetHours(null)).toBe(0);
    expect(calculateDayNetHours(undefined)).toBe(0);
    expect(calculateDayNetHours({})).toBe(0);
    expect(calculateDayNetHours({ fruehBreakMinutes: 30 })).toBe(0); // Pause ohne Arbeitszeit
  });
});

describe('calculateDaySlotNetHours (Netto-Aufteilung pro Einsatz)', () => {
  it('manuelle Pausen: jede Pause von IHREM Einsatz, pro Einsatz geclampt', () => {
    const r = calculateDaySlotNetHours({
      früh: { start: '10:00', end: '14:00' },
      spät: { start: '17:30', end: '23:00' },
      fruehBreakMinutes: 0,
      spaetBreakMinutes: 30,
    });
    expect(r.frühNet).toBe(4);
    expect(r.spätNet).toBe(5);
    // Clamping: Pause > Slot-Brutto
    const c = calculateDaySlotNetHours({
      früh: { start: '10:00', end: '10:30' },
      spät: { start: '18:00', end: '22:00' },
      fruehBreakMinutes: 60,
      spaetBreakMinutes: 0,
    });
    expect(c.frühNet).toBe(0);
    expect(c.spätNet).toBe(4);
  });

  it('ohne manuelle Pausen: Tagespause proportional aufgeteilt, Summe ≡ Tages-Netto', () => {
    const day = {
      früh: { start: '08:00', end: '13:00' }, // 5h
      spät: { start: '17:00', end: '22:00' }, // 5h → 10h Brutto, Automatik 30 Min
    };
    const r = calculateDaySlotNetHours(day);
    expect(r.frühNet).toBe(4.75);
    expect(r.spätNet).toBe(4.75);
    expect(Math.round((r.frühNet + r.spätNet) * 100) / 100).toBe(calculateDayNetHours(day));
  });

  it('leer → {0, 0}', () => {
    expect(calculateDaySlotNetHours(null)).toEqual({ frühNet: 0, spätNet: 0 });
    expect(calculateDaySlotNetHours({})).toEqual({ frühNet: 0, spätNet: 0 });
  });
});
