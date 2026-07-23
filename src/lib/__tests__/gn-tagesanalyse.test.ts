// @vitest-environment node
/**
 * Tests für die gemeinsame Tagesanalyse (reine Logik).
 *
 * Abgedeckte Auftrags-Testpunkte:
 * - Leere Werte werden nicht als 0 behandelt (fehlend = null).
 * - Gewichtete Periodenwerte (Quotienten von Summen, keine Mittelwerte
 *   von Tagesdurchschnitten).
 * - Z-Bericht-Umsatz hat Vorrang vor berechnetem Umsatz.
 * - Keine Division durch 0.
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeGnTag,
  analyzeGnTage,
  summarizeGnPeriode,
  mergeGnTagesQuellen,
  BONS_BERECHNET_TOOLTIP,
} from '../gn-tagesanalyse';

describe('analyzeGnTag — Quellenpriorität Umsatz', () => {
  it('Z-Bericht hat Vorrang vor validiertem Tagesumsatz und berechnetem Umsatz', () => {
    const r = analyzeGnTag({
      date: '2026-07-01',
      persons: 100,
      revenuePerPerson: 50,
      zRevenue: 12225.20,
      validatedRevenue: 12000,
    });
    expect(r.primaryRevenue).toBe(12225.20);
    expect(r.primaryRevenueSource).toBe('zbericht');
    // Berechneter Umsatz existiert weiter, überschreibt aber nie
    expect(r.derivedRevenue).toBe(5000);
  });

  it('validierter Tagesumsatz vor berechnetem Umsatz', () => {
    const r = analyzeGnTag({
      date: '2026-07-01',
      persons: 100,
      revenuePerPerson: 50,
      validatedRevenue: 4800,
    });
    expect(r.primaryRevenue).toBe(4800);
    expect(r.primaryRevenueSource).toBe('tagesumsatz');
  });

  it('berechneter Umsatz (Personen × Umsatz pro Person) als letzte Quelle', () => {
    const r = analyzeGnTag({ date: '2026-07-01', persons: 80, revenuePerPerson: 42.5 });
    expect(r.primaryRevenue).toBeCloseTo(3400, 5);
    expect(r.primaryRevenueSource).toBe('berechnet');
    expect(r.derivedRevenue).toBeCloseTo(3400, 5);
  });

  it('ohne jede Umsatzquelle bleibt primaryRevenue null (nie 0)', () => {
    const r = analyzeGnTag({ date: '2026-07-01', persons: 80 });
    expect(r.primaryRevenue).toBeNull();
    expect(r.primaryRevenueSource).toBeNull();
    expect(r.derivedRevenue).toBeNull();
  });
});

describe('analyzeGnTag — Bonanzahl und Personen pro Bon', () => {
  it('Bonanzahl = primärer Umsatz ÷ Durchschnittsbon', () => {
    const r = analyzeGnTag({ date: '2026-07-01', zRevenue: 10000, averageReceipt: 80 });
    expect(r.derivedReceiptCount).toBeCloseTo(125, 5);
  });

  it('Personen pro Bon = Personen ÷ Bonanzahl', () => {
    const r = analyzeGnTag({
      date: '2026-07-01', persons: 250, zRevenue: 10000, averageReceipt: 80,
    });
    expect(r.derivedPersonsPerReceipt).toBeCloseTo(2, 5);
  });

  it('keine Division durch 0: Durchschnittsbon 0 oder fehlend ⇒ null', () => {
    expect(analyzeGnTag({ date: 'd', zRevenue: 10000, averageReceipt: 0 }).derivedReceiptCount).toBeNull();
    expect(analyzeGnTag({ date: 'd', zRevenue: 10000 }).derivedReceiptCount).toBeNull();
  });

  it('keine Division durch 0: ohne Umsatz keine Bonanzahl, ohne Bonanzahl keine Personen pro Bon', () => {
    const r = analyzeGnTag({ date: 'd', persons: 100, averageReceipt: 80 });
    expect(r.derivedReceiptCount).toBeNull();
    expect(r.derivedPersonsPerReceipt).toBeNull();
  });

  it('0 Personen bleibt echter Wert (nicht null), erzeugt aber keinen berechneten Umsatz', () => {
    const r = analyzeGnTag({ date: 'd', persons: 0, revenuePerPerson: 50 });
    expect(r.persons).toBe(0);
    expect(r.derivedRevenue).toBeNull();
    expect(r.primaryRevenue).toBeNull();
  });

  it('negative oder nicht-endliche Eingaben werden verworfen (null)', () => {
    const r = analyzeGnTag({
      date: 'd', persons: -5, revenuePerPerson: NaN, averageReceipt: Infinity, zRevenue: -1,
    });
    expect(r.persons).toBeNull();
    expect(r.revenuePerPerson).toBeNull();
    expect(r.averageReceipt).toBeNull();
    expect(r.primaryRevenue).toBeNull();
  });
});

describe('summarizeGnPeriode — gewichtete Periodenwerte', () => {
  it('Summen für Personen, Umsatz, Bonanzahl; Quotienten aus Summen', () => {
    const days = analyzeGnTage([
      { date: '2026-07-01', persons: 100, zRevenue: 8000,  averageReceipt: 80 },  // 100 Bons
      { date: '2026-07-02', persons: 300, zRevenue: 12000, averageReceipt: 60 },  // 200 Bons
    ]);
    const p = summarizeGnPeriode(days);
    expect(p.persons).toBe(400);
    expect(p.primaryRevenue).toBe(20000);
    expect(p.derivedReceiptCount).toBeCloseTo(300, 5);
    // Umsatz pro Person = 20000 / 400 = 50 — NICHT Mittel aus (80, 40) = 60
    expect(p.revenuePerPerson).toBeCloseTo(50, 5);
    // Durchschnittsbon = 20000 / 300 = 66.67 — NICHT Mittel aus (80, 60) = 70
    expect(p.averageReceipt).toBeCloseTo(20000 / 300, 5);
    // Personen pro Bon = 400 / 300
    expect(p.personsPerReceipt).toBeCloseTo(400 / 300, 5);
  });

  it('fehlende Tage zählen nicht als 0 (leer ≠ 0)', () => {
    const days = analyzeGnTage([
      { date: '2026-07-01', persons: 100, zRevenue: 8000, averageReceipt: 80 },
      { date: '2026-07-02' }, // komplett leer
    ]);
    const p = summarizeGnPeriode(days);
    expect(p.dayCount).toBe(1);
    expect(p.persons).toBe(100);
    expect(p.primaryRevenue).toBe(8000);
    expect(p.revenuePerPerson).toBeCloseTo(80, 5);
  });

  it('ungepaarte Tage verfälschen Quotienten nicht (Umsatz ohne Personen)', () => {
    const days = analyzeGnTage([
      { date: '2026-07-01', persons: 100, zRevenue: 8000 },
      { date: '2026-07-02', zRevenue: 5000 }, // keine Personen
    ]);
    const p = summarizeGnPeriode(days);
    expect(p.primaryRevenue).toBe(13000);       // Summe über alle Umsatztage
    expect(p.revenuePerPerson).toBeCloseTo(80); // nur gepaarter Tag: 8000/100
  });

  it('leere Periode ⇒ alles null, keine 0-Erfindung', () => {
    const p = summarizeGnPeriode([]);
    expect(p.dayCount).toBe(0);
    expect(p.persons).toBeNull();
    expect(p.primaryRevenue).toBeNull();
    expect(p.revenuePerPerson).toBeNull();
    expect(p.averageReceipt).toBeNull();
    expect(p.derivedReceiptCount).toBeNull();
    expect(p.personsPerReceipt).toBeNull();
  });
});

describe('mergeGnTagesQuellen', () => {
  it('führt Quellen über das Kalenderdatum zusammen (sortiert, nur vorhandene Tage)', () => {
    const days = mergeGnTagesQuellen({
      personsByDate:          new Map([['2026-07-02', 120], ['2026-07-01', 100]]),
      averageReceiptByDate:   new Map([['2026-07-01', 75]]),
      zRevenueByDate:         new Map([['2026-07-01', 9000]]),
      validatedRevenueByDate: new Map([['2026-07-03', 4000]]),
    });
    expect(days.map(d => d.date)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    expect(days[0].primaryRevenueSource).toBe('zbericht');
    expect(days[0].derivedReceiptCount).toBeCloseTo(120, 5);
    expect(days[1].persons).toBe(120);
    expect(days[1].primaryRevenue).toBeNull();
    expect(days[2].primaryRevenueSource).toBe('tagesumsatz');
  });

  it('ohne Quellen: leeres Ergebnis', () => {
    expect(mergeGnTagesQuellen({})).toEqual([]);
  });
});

describe('UI-Konstanten', () => {
  it('Tooltip-Text «Bons, berechnet» entspricht exakt dem Auftrag', () => {
    expect(BONS_BERECHNET_TOOLTIP).toBe(
      'Aus Umsatz und Durchschnittsbon berechnet. Aufgrund gerundeter Berichtswerte kann die Anzahl leicht abweichen.',
    );
  });
});
