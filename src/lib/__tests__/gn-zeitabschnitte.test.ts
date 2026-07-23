// @vitest-environment node
/**
 * Tests für die Zeitabschnittsanalyse (reine Logik).
 *
 * Abgedeckte Auftrags-Testpunkte:
 * - Umsatz und Anteil je Stunde.
 * - Stärkste Umsatzstunde und schwächste AKTIVE Umsatzstunde.
 * - Mittags-/Abendumsatz, Umsatz vor/ab 17:00 (zentral definierte Fenster).
 * - Peak-Zeitfenster.
 * - Negative Stundenwerte bleiben erhalten (z. B. −651.60 um 23:00).
 * - Fehlend ≠ 0: keine Stunden im Fenster ⇒ null.
 */

import { describe, it, expect } from 'vitest';
import {
  GN_ZEITFENSTER,
  analyzeGnZeitabschnitte,
  mergeGnStundenwerte,
} from '../gn-zeitabschnitte';
import type { GnHourlyRevenueRow } from '../gn-zbericht-parser';

function row(hour: number | null, totalAmount: number, sharePct: number | null = null): GnHourlyRevenueRow {
  return {
    label: hour === null ? '—' : `${String(hour).padStart(2, '0')}:00`,
    hour,
    totalAmount,
    sharePct,
  };
}

describe('analyzeGnZeitabschnitte — Grundfälle', () => {
  it('null/leer ⇒ null (nie leeres 0-Ergebnis)', () => {
    expect(analyzeGnZeitabschnitte(null)).toBeNull();
    expect(analyzeGnZeitabschnitte(undefined)).toBeNull();
    expect(analyzeGnZeitabschnitte([])).toBeNull();
  });

  it('Zeilen ohne parsebare Stunde werden ausgelassen; nur solche ⇒ null', () => {
    expect(analyzeGnZeitabschnitte([row(null, 500)])).toBeNull();
    const a = analyzeGnZeitabschnitte([row(null, 500), row(12, 100)])!;
    expect(a.hours).toHaveLength(1);
    expect(a.total).toBe(100);
  });

  it('Umsatz und Anteil je Stunde: Anteile aus Rohsummen, sortiert nach Stunde', () => {
    const a = analyzeGnZeitabschnitte([row(19, 300), row(12, 100), row(20, 600)])!;
    expect(a.hours.map(h => h.hour)).toEqual([12, 19, 20]);
    expect(a.total).toBeCloseTo(1000, 6);
    expect(a.hours[0].sharePct).toBeCloseTo(10, 6);
    expect(a.hours[2].sharePct).toBeCloseTo(60, 6);
  });

  it('Gesamt 0 ⇒ Anteil null (keine Division durch 0)', () => {
    const a = analyzeGnZeitabschnitte([row(12, 100), row(13, -100)])!;
    expect(a.total).toBe(0);
    expect(a.hours.every(h => h.sharePct === null)).toBe(true);
  });
});

describe('analyzeGnZeitabschnitte — stärkste/schwächste Stunde', () => {
  it('stärkste Stunde = höchster Wert; schwächste aktive ignoriert 0-Stunden', () => {
    const a = analyzeGnZeitabschnitte([
      row(11, 0), row(12, 800), row(19, 2500), row(22, 40),
    ])!;
    expect(a.strongestHour?.hour).toBe(19);
    expect(a.weakestActiveHour?.hour).toBe(22);
  });

  it('negative Stundenwerte bleiben erhalten und können schwächste aktive Stunde sein', () => {
    const a = analyzeGnZeitabschnitte([
      row(19, 2500), row(23, -651.6),
    ])!;
    expect(a.weakestActiveHour?.hour).toBe(23);
    expect(a.weakestActiveHour?.totalAmount).toBeCloseTo(-651.6, 2);
    expect(a.total).toBeCloseTo(1848.4, 2);
  });

  it('nur 0-Stunden ⇒ keine schwächste aktive Stunde', () => {
    const a = analyzeGnZeitabschnitte([row(12, 0), row(13, 0)])!;
    expect(a.weakestActiveHour).toBeNull();
    expect(a.strongestHour?.totalAmount).toBe(0);
  });
});

describe('analyzeGnZeitabschnitte — zentrale Zeitfenster', () => {
  it('Mittag/Abend/vor/ab 17:00 folgen den zentralen Definitionen', () => {
    // Fenster-Erwartungen direkt aus den Konstanten ableiten — Test bricht,
    // wenn jemand die Definition still ändert.
    expect(GN_ZEITFENSTER.mittag.fromHour).toBe(11);
    expect(GN_ZEITFENSTER.grenzeStunde).toBe(17);

    const a = analyzeGnZeitabschnitte([
      row(10, 50), row(11, 200), row(13, 300), row(14, 80),
      row(17, 400), row(20, 900), row(23, -100),
    ])!;
    expect(a.mittagRevenue).toBeCloseTo(500, 6);      // 11 + 13
    expect(a.abendRevenue).toBeCloseTo(1200, 6);      // 17 + 20 + 23(−100)
    expect(a.vor17Revenue).toBeCloseTo(630, 6);       // 10+11+13+14
    expect(a.ab17Revenue).toBeCloseTo(1200, 6);
  });

  it('fehlend ≠ 0: keine Stunde im Fenster ⇒ null, nie 0', () => {
    const a = analyzeGnZeitabschnitte([row(9, 120)])!;
    expect(a.mittagRevenue).toBeNull();
    expect(a.abendRevenue).toBeNull();
    expect(a.ab17Revenue).toBeNull();
    expect(a.vor17Revenue).toBeCloseTo(120, 6);
  });
});

describe('analyzeGnZeitabschnitte — Peak-Zeitfenster', () => {
  it('findet das stärkste zusammenhängende Fenster der zentral definierten Länge', () => {
    const a = analyzeGnZeitabschnitte([
      row(12, 500), row(13, 300),
      row(19, 800), row(20, 900), row(21, 700),
    ])!;
    expect(a.peakWindow?.fromHour).toBe(19);
    expect(a.peakWindow?.toHour).toBe(19 + GN_ZEITFENSTER.peakFensterStunden - 1);
    expect(a.peakWindow?.totalAmount).toBeCloseTo(2400, 6);
    expect(a.peakWindow?.label).toBe('19:00–22:00');
  });

  it('Fenster ohne vorhandene Stunden werden nicht gewertet', () => {
    const a = analyzeGnZeitabschnitte([row(3, -50)])!;
    // Einziges aktives Fenster enthält Stunde 3, auch wenn Summe negativ ist.
    expect(a.peakWindow).not.toBeNull();
    expect(a.peakWindow!.totalAmount).toBeCloseTo(-50, 6);
  });
});

describe('mergeGnStundenwerte — Mehrtages-Merge', () => {
  it('summiert Stunde für Stunde über Tage; sharePct wird verworfen', () => {
    const merged = mergeGnStundenwerte([
      [row(12, 100, 10), row(19, 400, 40)],
      [row(12, 150), row(20, 250)],
    ]);
    expect(merged.map(r => [r.hour, r.totalAmount])).toEqual([
      [12, 250], [19, 400], [20, 250],
    ]);
    expect(merged.every(r => r.sharePct === null)).toBe(true);
  });

  it('lässt Zeilen ohne Stunde aus und behält negative Summen', () => {
    const merged = mergeGnStundenwerte([
      [row(null, 999), row(23, -651.6)],
      [row(23, -100)],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].totalAmount).toBeCloseTo(-751.6, 2);
  });

  it('leere Eingabe ⇒ leeres Ergebnis; Analyse darauf ⇒ null', () => {
    const merged = mergeGnStundenwerte([]);
    expect(merged).toEqual([]);
    expect(analyzeGnZeitabschnitte(merged)).toBeNull();
  });
});
