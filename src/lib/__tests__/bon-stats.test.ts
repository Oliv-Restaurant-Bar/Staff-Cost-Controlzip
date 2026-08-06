// @vitest-environment happy-dom
/**
 * bon-stats — Anzahl Bons & gewichteter Jahres-Ø-Bon aus Durchschnittsbon-
 * Tageswerten. Regeln: nur gepaarte Tage (beide Werte > 0), round(Brutto÷Ø),
 * Jahres-Ø = Σ Brutto ÷ Σ Bons (gewichtet), nie durch 0, leer statt 0,
 * Ausreisser = Kennzeichnung (kein Fehler).
 */
import { describe, it, expect } from 'vitest';
import { berechneBonStats, AUSREISSER_FAKTOR } from '@/lib/bon-stats';

describe('berechneBonStats', () => {
  it('paart nur Tage mit beiden Werten und rundet die Bon-Anzahl je Tag', () => {
    const s = berechneBonStats(
      { '2025-01-01': 80, '2025-01-02': 100, '2025-01-03': 90 },
      { '2025-01-01': 8000, '2025-01-02': 1050 }, // 03. ohne Umsatz
      '2025-01-01', '2025-12-31',
    );
    expect(s.tage).toBe(2);
    expect(s.bons).toBe(100 + Math.round(1050 / 100)); // 100 + 11 (Rundung)
    expect(s.ohneUmsatz).toBe(1);
  });

  it('Jahres-Ø-Bon ist GEWICHTET (Σ Brutto ÷ Σ Bons), nicht Mittelwert der Tageswerte', () => {
    const s = berechneBonStats(
      { '2025-01-01': 50, '2025-01-02': 150 },
      { '2025-01-01': 5000, '2025-01-02': 1500 }, // 100 + 10 Bons
      '2025-01-01', '2025-12-31',
    );
    expect(s.bons).toBe(110);
    expect(s.avgBon).toBe(Math.round((6500 / 110) * 100) / 100); // 59.09, NICHT 100
    expect(s.avgBon).not.toBe(100);
  });

  it('keine gepaarten Tage → bons 0 und avgBon null (nie durch 0, nie 0 erfinden)', () => {
    const s = berechneBonStats({ '2025-01-01': 80 }, {}, '2025-01-01', '2025-12-31');
    expect(s.bons).toBe(0);
    expect(s.avgBon).toBeNull();
  });

  it('Ø-Bon 0/negativ und Umsatz 0 zählen nicht (leer statt 0, nie ÷0)', () => {
    const s = berechneBonStats(
      { '2025-01-01': 0, '2025-01-02': -5, '2025-01-03': 80 },
      { '2025-01-01': 900, '2025-01-02': 900, '2025-01-03': 0 },
      '2025-01-01', '2025-12-31',
    );
    expect(s.tage).toBe(0);
    expect(s.bons).toBe(0);
    expect(s.avgBon).toBeNull();
  });

  it('respektiert das Zeitfenster (Tage ausserhalb zählen nicht)', () => {
    const s = berechneBonStats(
      { '2024-12-31': 80, '2025-01-01': 80 },
      { '2024-12-31': 800, '2025-01-01': 800 },
      '2025-01-01', '2025-12-31',
    );
    expect(s.tage).toBe(1);
    expect(s.bons).toBe(10);
  });

  it('kennzeichnet sehr hohe Tages-Ø als Event/Einzelbon — als Hinweis, nicht als Fehler', () => {
    // 30 normale Tage Ø 80 + ein Event-Tag Ø 1319.80 (Einzelrechnung).
    const avg: Record<string, number> = {}; const gross: Record<string, number> = {};
    for (let d = 1; d <= 30; d++) {
      const iso = `2025-03-${String(d).padStart(2, '0')}`;
      avg[iso] = 80; gross[iso] = 8000;
    }
    avg['2025-04-01'] = 1319.80; gross['2025-04-01'] = 2639.60; // 2 Bons
    const s = berechneBonStats(avg, gross, '2025-01-01', '2025-12-31');
    expect(s.events).toEqual([{ date: '2025-04-01', avg: 1319.80 }]);
    expect(s.avgBon).not.toBeNull();
    expect(1319.80).toBeGreaterThanOrEqual(s.avgBon! * AUSREISSER_FAKTOR);
    // Der Event-Tag bleibt in der Statistik enthalten (kein Ausschluss).
    expect(s.bons).toBe(30 * 100 + 2);
  });

  it('Kontrollwert-Szenario: Rundung je Tag, Ø aus Gesamt (2 Nachkommastellen)', () => {
    const s = berechneBonStats(
      { '2025-06-01': 79.87 },
      { '2025-06-01': 7987.13 },
      '2025-01-01', '2025-12-31',
    );
    expect(s.bons).toBe(100);
    expect(s.avgBon).toBe(79.87);
  });
});
