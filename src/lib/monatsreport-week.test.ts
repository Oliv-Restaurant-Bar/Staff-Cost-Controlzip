// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

// Reine Logik-Tests: den Supabase-Client (braucht localStorage/browser) stubben,
// damit der Import von monatsreport.ts unter node läuft.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { computeWeekRange, weekSelectionLabel, computeLastCompleteWeeks } from './monatsreport';

/**
 * Reine Logik-Tests für die Wochen-Zeitraum-Berechnung (computeWeekRange)
 * und die Labels. Die Umsatz-pro-Gast-Paarungs-Regel ist in ladeMonatsreport
 * verdrahtet (I/O), wird hier als Regel-Kommentar dokumentiert:
 *   Umsatz pro Gast = Σ(Netto der Tage mit gesamtBrutto>0 UND Gäste>0)
 *                     ÷ Σ(Gäste dieser selben Tage)
 * «Gäste IN» zeigt weiterhin die volle importierte Summe.
 */

// Referenz-Heute: Mittwoch, 16. Juli 2025 (KW 29).
const heute = new Date(2025, 6, 16);

describe('weekSelectionLabel', () => {
  it('gibt die erwarteten Labels', () => {
    expect(weekSelectionLabel({ kind: 'lastComplete' })).toBe('Letzte abgeschl. Woche');
    expect(weekSelectionLabel({ kind: 'current' })).toBe('Aktuelle Woche');
    expect(weekSelectionLabel({ kind: 'last7' })).toBe('Letzte 7 Tage');
    expect(weekSelectionLabel({ kind: 'kw', kw: 30 })).toBe('KW 30');
    expect(weekSelectionLabel({ kind: 'kw', kw: 1, kwYear: 2026 })).toBe('KW 1');
  });
});

describe('computeWeekRange — laufender Monat (Juli 2025, heute=16.07.)', () => {
  const from = '2025-07-01', to = '2025-07-31', istTo = '2025-07-16';

  it('lastComplete = Mo–So der Vorwoche (07.–13.07.)', () => {
    const r = computeWeekRange({ kind: 'lastComplete' }, 2025, from, to, istTo, heute);
    expect(r).toEqual({ weekFrom: '2025-07-07', weekTo: '2025-07-13' });
  });

  it('current = Montag der laufenden Woche bis heute (14.–16.07.)', () => {
    const r = computeWeekRange({ kind: 'current' }, 2025, from, to, istTo, heute);
    expect(r).toEqual({ weekFrom: '2025-07-14', weekTo: '2025-07-16' });
  });

  it('last7 = heute−6 bis heute (10.–16.07.)', () => {
    const r = computeWeekRange({ kind: 'last7' }, 2025, from, to, istTo, heute);
    expect(r).toEqual({ weekFrom: '2025-07-10', weekTo: '2025-07-16' });
  });

  it('current wird auf Ist-Grenze (heute) geklemmt', () => {
    const r = computeWeekRange({ kind: 'current' }, 2025, from, to, istTo, heute);
    expect(r.weekTo).toBe('2025-07-16');
  });
});

describe('computeWeekRange — kw (ganze Woche, vergangener Monat)', () => {
  it('KW 27 2025 = 30.06.–06.07., auf Juli geklemmt (01.–06.07.)', () => {
    // Vergangener Monat → istTo = Monatsende (voller Monat).
    const r = computeWeekRange({ kind: 'kw', kw: 27 }, 2025, '2025-07-01', '2025-07-31', '2025-07-31', heute);
    // KW27 Montag = 30.06.2025; auf fromIso geklemmt.
    expect(r).toEqual({ weekFrom: '2025-07-01', weekTo: '2025-07-06' });
  });

  it('KW 30 2025 = 21.–27.07. (voll im Monat)', () => {
    const r = computeWeekRange({ kind: 'kw', kw: 30 }, 2025, '2025-07-01', '2025-07-31', '2025-07-31', heute);
    expect(r).toEqual({ weekFrom: '2025-07-21', weekTo: '2025-07-27' });
  });
});

describe('computeWeekRange — Jahreswechsel (kwYear)', () => {
  it('Dezember-Report 2025 mit KW 1/2026 = 29.12.2025–04.01.2026, geklemmt auf 29.–31.12.', () => {
    const r = computeWeekRange(
      { kind: 'kw', kw: 1, kwYear: 2026 },
      2025, '2025-12-01', '2025-12-31', '2025-12-31', heute,
    );
    expect(r).toEqual({ weekFrom: '2025-12-29', weekTo: '2025-12-31' });
  });

  it('ohne kwYear (Fallback Report-Jahr) landet KW 1 im falschen Jahr → leer (Regressionsschutz)', () => {
    const r = computeWeekRange(
      { kind: 'kw', kw: 1 }, // kwYear fehlt → nutzt Report-Jahr 2025
      2025, '2025-12-01', '2025-12-31', '2025-12-31', heute,
    );
    // KW1/2025 = 30.12.2024–05.01.2025, überschneidet Dez 2025 NICHT.
    expect(r).toEqual({ weekFrom: null, weekTo: null });
  });

  it('Januar-Report 2021 mit KW 53/2020 = 28.12.2020–03.01.2021, geklemmt auf 01.–03.01.2021', () => {
    const r = computeWeekRange(
      { kind: 'kw', kw: 53, kwYear: 2020 },
      2021, '2021-01-01', '2021-01-31', '2021-01-31', heute,
    );
    expect(r).toEqual({ weekFrom: '2021-01-01', weekTo: '2021-01-03' });
  });

  it('Januar-Report 2025 mit KW 52/2024 = 23.–29.12.2024, geklemmt → leer (liegt vor Januar)', () => {
    const r = computeWeekRange(
      { kind: 'kw', kw: 52, kwYear: 2024 },
      2025, '2025-01-01', '2025-01-31', '2025-01-31', heute,
    );
    expect(r).toEqual({ weekFrom: null, weekTo: null });
  });
});

describe('computeWeekRange — leere Bereiche', () => {
  it('Zukunftsmonat (kein Ist) → null/null', () => {
    const r = computeWeekRange({ kind: 'current' }, 2025, '2025-12-01', '2025-12-31', '', heute);
    expect(r).toEqual({ weekFrom: null, weekTo: null });
  });

  it('KW ausserhalb des Monats → leere Klemmung → null/null', () => {
    // KW 40 2025 (Ende September/Oktober) liegt nicht im Juli.
    const r = computeWeekRange({ kind: 'kw', kw: 40 }, 2025, '2025-07-01', '2025-07-31', '2025-07-31', heute);
    expect(r).toEqual({ weekFrom: null, weekTo: null });
  });

  it('lastComplete im laufenden Monat, wenn Vorwoche vor Monatsanfang liegt → geklemmt', () => {
    // heute = 02.07.2025 (Mittwoch) → Vorwoche 23.–29.06. liegt vor dem 01.07.
    const early = new Date(2025, 6, 2);
    const r = computeWeekRange({ kind: 'lastComplete' }, 2025, '2025-07-01', '2025-07-31', '2025-07-02', early);
    // Vorwoche komplett vor fromIso → leer.
    expect(r).toEqual({ weekFrom: null, weekTo: null });
  });
});

// ── Wochenverlauf: Fenster der letzten N abgeschlossenen Wochen ───────────────

describe('computeLastCompleteWeeks', () => {
  it('heute Mi 16.07.2025 → letzte abgeschl. Woche = KW 28 (07.–13.07.), volle 7 Tage', () => {
    const w = computeLastCompleteWeeks(1, heute);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kwYear: 2025, kw: 28, from: '2025-07-07', to: '2025-07-13' });
  });

  it('N=4 → 4 Wochen, älteste links → neueste rechts, aufsteigend & lückenlos', () => {
    const w = computeLastCompleteWeeks(4, heute);
    expect(w.map(x => x.kw)).toEqual([25, 26, 27, 28]);
    expect(w.map(x => x.from)).toEqual(['2025-06-16', '2025-06-23', '2025-06-30', '2025-07-07']);
    expect(w.map(x => x.to)).toEqual(['2025-06-22', '2025-06-29', '2025-07-06', '2025-07-13']);
    // jede Woche = volle 7 Tage
    for (const x of w) {
      const d = (Date.parse(x.to) - Date.parse(x.from)) / (24 * 3600 * 1000);
      expect(d).toBe(6);
    }
  });

  it('überschreitet Monatsgrenze (Woche 30.06.–06.07. bleibt volle 7 Tage, keine Klemmung)', () => {
    const w = computeLastCompleteWeeks(4, heute);
    const grenz = w.find(x => x.from === '2025-06-30')!;
    expect(grenz.to).toBe('2025-07-06'); // NICHT auf Monatsende geklemmt
    expect(grenz.kw).toBe(27);
  });

  it('Jahreswechsel: heute Mi 07.01.2026 → jüngste abgeschl. Woche = KW 1/2026 (29.12.2025–04.01.2026)', () => {
    const jan = new Date(2026, 0, 7); // Mi 07.01.2026 (KW2)
    const w = computeLastCompleteWeeks(2, jan);
    expect(w).toHaveLength(2);
    // jüngste (rechts) = Woche vor der laufenden = KW1/2026
    expect(w[1]).toMatchObject({ kwYear: 2026, kw: 1, from: '2025-12-29', to: '2026-01-04' });
    // ältere (links) = KW52/2025
    expect(w[0]).toMatchObject({ kwYear: 2025, kw: 52, from: '2025-12-22', to: '2025-12-28' });
  });

  it('Jahreswechsel mit KW 53: heute Mi 06.01.2021 → jüngste abgeschl. = KW 53/2020 (28.12.2020–03.01.2021)', () => {
    const jan = new Date(2021, 0, 6); // Mi 06.01.2021 (KW1/2021)
    const w = computeLastCompleteWeeks(1, jan);
    expect(w[0]).toMatchObject({ kwYear: 2020, kw: 53, from: '2020-12-28', to: '2021-01-03' });
  });
});

/**
 * «leer statt 0»-Regel im Wochenverlauf (in ladeWochenverlauf verdrahtet, I/O):
 *   - Woche ohne Umsatz-Import  → Brutto/Netto/Food/Beverage/TA-Anteil = null
 *   - Woche ohne Gäste-Import    → Gäste IN = null, Umsatz pro Gast = null
 *   - Umsatz pro Gast nur über Tage mit Umsatz UND Gästen (pairedGaeste>0)
 *   - Trend nur, wenn beide Wochen einen Wert haben (trendPct in der UI).
 * Fensterlogik oben deckt die Wochen-Bestimmung inkl. Jahreswechsel ab.
 */
