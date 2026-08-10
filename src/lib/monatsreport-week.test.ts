// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

// Reine Logik-Tests: den Supabase-Client (braucht localStorage/browser) stubben,
// damit der Import von monatsreport.ts unter node läuft.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import {
  computeWeekRange, weekSelectionLabel, computeLastCompleteWeeks, vorjahresWoche,
  computeYtdWindow, kwRangeLabel, computeWeeksForYear, computeVergleichsWindow,
  computeVorjahrWocheDays, computePersonalBlock, OBERGRENZE_PKQ_PCT, applyRowOrder, isRunningWeek,
  gewichteterTagesAvg,
  type MrRow,
} from './monatsreport';

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

describe('computeWeekRange — lastComplete bei anderem Monat', () => {
  it('vergangener Monat: letzte abgeschlossene Woche INNERHALB des Monats (Juni 2025 → 23.–29.06.)', () => {
    // heute=16.07.2025, gewählt Juni 2025: 30.06. ist ein Montag,
    // letzter Sonntag ≤ 30.06. ist der 29.06. → Woche 23.–29.06.
    const r = computeWeekRange({ kind: 'lastComplete' }, 2025, '2025-06-01', '2025-06-30', '2025-06-30', heute);
    expect(r).toEqual({ weekFrom: '2025-06-23', weekTo: '2025-06-29' });
  });

  it('Monatsende = Sonntag: Woche endet am Monatsletzten (Nov 2025 → 24.–30.11. bei heute=16.12.)', () => {
    const dez = new Date(2025, 11, 16);
    const r = computeWeekRange({ kind: 'lastComplete' }, 2025, '2025-11-01', '2025-11-30', '2025-11-30', dez);
    expect(r).toEqual({ weekFrom: '2025-11-24', weekTo: '2025-11-30' });
  });

  it('Wochenstart vor Monatsanfang wird geklemmt (Feb 2025 → 24.–28.02.? nein: letzter So=23.02. → 17.–23.02.)', () => {
    // 28.02.2025 = Freitag → letzter Sonntag = 23.02. → Woche 17.–23.02. (voll im Monat).
    const r = computeWeekRange({ kind: 'lastComplete' }, 2025, '2025-02-01', '2025-02-28', '2025-02-28', heute);
    expect(r).toEqual({ weekFrom: '2025-02-17', weekTo: '2025-02-23' });
  });

  it('Zukunftsmonat bleibt leer', () => {
    const r = computeWeekRange({ kind: 'lastComplete' }, 2025, '2025-08-01', '2025-08-31', '', heute);
    expect(r).toEqual({ weekFrom: null, weekTo: null });
  });
});

describe('computeWeekRange — kw (ganze Woche, vergangener Monat)', () => {
  it('KW 27 2025 = VOLLE Woche 30.06.–06.07. (monatsübergreifend, KEINE Monats-Klemmung)', () => {
    // Vergangener Monat → Ist-Obergrenze weit genug (z.B. Monatsende).
    const r = computeWeekRange({ kind: 'kw', kw: 27 }, 2025, '2025-07-01', '2025-07-31', '2025-07-31', heute);
    expect(r).toEqual({ weekFrom: '2025-06-30', weekTo: '2025-07-06' });
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
    // KW1/2025 = 30.12.2024–05.01.2025: seit der monatsübergreifenden
    // Wochenanzeige wird die VOLLE Woche geliefert (keine Monats-Klemmung) —
    // sie liegt aber im falschen Jahr; das UI übergibt kwYear immer.
    expect(r).toEqual({ weekFrom: '2024-12-30', weekTo: '2025-01-05' });
  });

  it('Januar-Report 2021 mit KW 53/2020 = VOLLE Woche 28.12.2020–03.01.2021', () => {
    const r = computeWeekRange(
      { kind: 'kw', kw: 53, kwYear: 2020 },
      2021, '2021-01-01', '2021-01-31', '2021-01-31', heute,
    );
    expect(r).toEqual({ weekFrom: '2020-12-28', weekTo: '2021-01-03' });
  });

  it('Januar-Report 2025 mit KW 52/2024 = VOLLE Woche 23.–29.12.2024 (monatsübergreifend)', () => {
    const r = computeWeekRange(
      { kind: 'kw', kw: 52, kwYear: 2024 },
      2025, '2025-01-01', '2025-01-31', '2025-01-31', heute,
    );
    expect(r).toEqual({ weekFrom: '2024-12-23', weekTo: '2024-12-29' });
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

  it('lastComplete im laufenden Monat, wenn Vorwoche vor Monatsanfang liegt → VOLLE Vorwoche (monatsübergreifend)', () => {
    // heute = 02.07.2025 (Mittwoch) → Vorwoche 23.–29.06. liegt vor dem 01.07.
    const early = new Date(2025, 6, 2);
    const r = computeWeekRange({ kind: 'lastComplete' }, 2025, '2025-07-01', '2025-07-31', '2025-07-02', early);
    // Seit der monatsübergreifenden Wochenanzeige wird die volle Woche gezeigt.
    expect(r).toEqual({ weekFrom: '2025-06-23', weekTo: '2025-06-29' });
  });
});

// ── Wochenverlauf: Fenster der letzten N abgeschlossenen Wochen ───────────────

describe('computeLastCompleteWeeks', () => {
  it('heute Mi 16.07.2025 → jüngste Woche = LAUFENDE KW 29 (14.–20.07.), volle 7 Tage', () => {
    const w = computeLastCompleteWeeks(1, heute);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kwYear: 2025, kw: 29, from: '2025-07-14', to: '2025-07-20' });
  });

  it('N=4 → 4 Wochen, älteste links → laufende Woche rechts, aufsteigend & lückenlos', () => {
    const w = computeLastCompleteWeeks(4, heute);
    expect(w.map(x => x.kw)).toEqual([26, 27, 28, 29]);
    expect(w.map(x => x.from)).toEqual(['2025-06-23', '2025-06-30', '2025-07-07', '2025-07-14']);
    expect(w.map(x => x.to)).toEqual(['2025-06-29', '2025-07-06', '2025-07-13', '2025-07-20']);
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

  it('Jahreswechsel: heute Mi 07.01.2026 → jüngste (laufende) Woche = KW 2/2026 (05.–11.01.)', () => {
    const jan = new Date(2026, 0, 7); // Mi 07.01.2026 (KW2)
    const w = computeLastCompleteWeeks(2, jan);
    expect(w).toHaveLength(2);
    // jüngste (rechts) = laufende Woche = KW2/2026
    expect(w[1]).toMatchObject({ kwYear: 2026, kw: 2, from: '2026-01-05', to: '2026-01-11' });
    // ältere (links) = KW1/2026 (29.12.2025–04.01.2026)
    expect(w[0]).toMatchObject({ kwYear: 2026, kw: 1, from: '2025-12-29', to: '2026-01-04' });
  });

  it('Jahreswechsel mit KW 53: heute Mi 30.12.2020 (KW 53/2020) → laufende = KW 53/2020 (28.12.2020–03.01.2021)', () => {
    const dez = new Date(2020, 11, 30); // Mi 30.12.2020 (KW53/2020)
    const w = computeLastCompleteWeeks(1, dez);
    expect(w[0]).toMatchObject({ kwYear: 2020, kw: 53, from: '2020-12-28', to: '2021-01-03' });
  });
});

// ── Wochenverlauf: laufende (partielle) Woche ────────────────────────────────

describe('isRunningWeek', () => {
  const w = { kwYear: 2025, kw: 29, from: '2025-07-14', to: '2025-07-20' };
  it('heute innerhalb Mo–So → laufend (inkl. Randtage)', () => {
    expect(isRunningWeek(w, '2025-07-16')).toBe(true);
    expect(isRunningWeek(w, '2025-07-14')).toBe(true);
    expect(isRunningWeek(w, '2025-07-20')).toBe(true);
  });
  it('heute ausserhalb → nicht laufend', () => {
    expect(isRunningWeek(w, '2025-07-13')).toBe(false);
    expect(isRunningWeek(w, '2025-07-21')).toBe(false);
  });
});

// ── Wochenverlauf: Vorjahres-Woche (gleiche ISO-KW im Wochenjahr−1) ──────────

describe('vorjahresWoche', () => {
  it('gleiche KW-Nummer im Vorjahr: KW 27/2026 → KW 27/2025 (30.06.–06.07.2025)', () => {
    const vj = vorjahresWoche({ kwYear: 2026, kw: 27, from: '2026-06-29', to: '2026-07-05' });
    expect(vj).toMatchObject({ kwYear: 2025, kw: 27, from: '2025-06-30', to: '2025-07-06' });
  });

  it('KW 1: KW 1/2026 (29.12.2025–04.01.2026) → KW 1/2025 (30.12.2024–05.01.2025)', () => {
    const vj = vorjahresWoche({ kwYear: 2026, kw: 1, from: '2025-12-29', to: '2026-01-04' });
    expect(vj).toMatchObject({ kwYear: 2025, kw: 1, from: '2024-12-30', to: '2025-01-05' });
  });

  it('KW 53 existiert im Vorjahr → gültig: KW 53/2021 (2020 hat KW 53) → 28.12.2020–03.01.2021', () => {
    // 2020 ist ein ISO-53-Wochen-Jahr.
    const vj = vorjahresWoche({ kwYear: 2021, kw: 53, from: '2021-01-04', to: '2021-01-10' });
    // KW 53/2021 gibt es gar nicht, aber der Test prüft die Logik: kwYear-1 = 2020,
    // und 2020 HAT eine KW 53.
    expect(vj).toMatchObject({ kwYear: 2020, kw: 53, from: '2020-12-28', to: '2021-01-03' });
  });

  it('KW 53 existiert im Vorjahr NICHT → null (2025 hat nur 52 Wochen)', () => {
    // KW 53/2026: Vorjahr 2025 hat nur 52 ISO-Wochen → keine KW 53 → null.
    const vj = vorjahresWoche({ kwYear: 2026, kw: 53, from: '2026-12-28', to: '2027-01-03' });
    expect(vj).toBeNull();
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

// ── Jahresvergleich: YTD-Fensterlogik (aktuell vs. Vorjahr pro rata) ─────────

describe('computeYtdWindow', () => {
  it('01.01.–heute vs. 01.01. Vorjahr–gleiches Datim (28.07.2026 ↔ 28.07.2025)', () => {
    const w = computeYtdWindow(new Date(2026, 6, 28)); // 28. Juli 2026
    expect(w).toMatchObject({
      curYear: 2026, vjYear: 2025,
      curFrom: '2026-01-01', curTo: '2026-07-28',
      vjFrom: '2025-01-01', vjTo: '2025-07-28',
    });
  });

  it('Jahresanfang: 03.01.2025 → cur 01.–03.01.2025, vj 01.–03.01.2024', () => {
    const w = computeYtdWindow(new Date(2025, 0, 3));
    expect(w).toMatchObject({
      curFrom: '2025-01-01', curTo: '2025-01-03',
      vjFrom: '2024-01-01', vjTo: '2024-01-03',
    });
  });

  it('Schaltjahr-Randfall: heute 29.02.2024 → VJ geklemmt auf 28.02.2023', () => {
    const w = computeYtdWindow(new Date(2024, 1, 29)); // 2024 ist Schaltjahr
    expect(w.curTo).toBe('2024-02-29');
    expect(w.vjYear).toBe(2023);      // 2023 kein Schaltjahr
    expect(w.vjTo).toBe('2023-02-28'); // 29.02. existiert im VJ nicht → geklemmt
  });

  it('Schaltjahr → Schaltjahr: heute 29.02.2024 nicht, aber 28.02.2025 → VJ 28.02.2024 (kein Klemmen nötig)', () => {
    const w = computeYtdWindow(new Date(2025, 1, 28));
    expect(w.curTo).toBe('2025-02-28');
    expect(w.vjTo).toBe('2024-02-28'); // regulär, kein 29.02.-Sonderfall
  });
});

// ── Jahresvergleich: wählbarer Zeitraum (Fensterlogik aller Modi) ────────────

describe('computeVergleichsWindow', () => {
  const heute = new Date(2025, 6, 16); // Mi 16.07.2025

  it('«ytd» = identisch zu computeYtdWindow', () => {
    expect(computeVergleichsWindow('ytd', heute)).toEqual(computeYtdWindow(heute));
  });

  it('«ganzjahr»: aktuelles Jahr 01.01.–31.12. vs. ganzes Vorjahr 01.01.–31.12.', () => {
    const w = computeVergleichsWindow('ganzjahr', heute);
    expect(w).toMatchObject({
      curYear: 2025, vjYear: 2024,
      curFrom: '2025-01-01', curTo: '2025-12-31',
      vjFrom: '2024-01-01', vjTo: '2024-12-31',
    });
  });

  it('«custom»: freier Bereich im aktuellen Jahr vs. gleicher MM-TT-Bereich im Vorjahr', () => {
    const w = computeVergleichsWindow('custom', heute, '2025-03-10', '2025-06-20');
    expect(w).toMatchObject({
      curYear: 2025, vjYear: 2024,
      curFrom: '2025-03-10', curTo: '2025-06-20',
      vjFrom: '2024-03-10', vjTo: '2024-06-20',
    });
  });

  it('«custom» 29.02.-Klemmung: bis 29.02. → VJ (Nicht-Schaltjahr) 28.02.', () => {
    // Heute 2024 (Schaltjahr), Bereich endet auf 29.02.2024; VJ 2023 hat keinen 29.02.
    const h2024 = new Date(2024, 5, 1);
    const w = computeVergleichsWindow('custom', h2024, '2024-01-15', '2024-02-29');
    expect(w.curTo).toBe('2024-02-29');
    expect(w.vjYear).toBe(2023);
    expect(w.vjTo).toBe('2023-02-28'); // geklemmt (2023 kein Schaltjahr)
    expect(w.vjFrom).toBe('2023-01-15');
  });

  it('«custom» 29.02.-Start klemmt ebenfalls', () => {
    const h2024 = new Date(2024, 5, 1);
    const w = computeVergleichsWindow('custom', h2024, '2024-02-29', '2024-03-31');
    expect(w.curFrom).toBe('2024-02-29');
    expect(w.vjFrom).toBe('2023-02-28'); // Startdatum ins VJ gespiegelt + geklemmt
    expect(w.vjTo).toBe('2023-03-31');
  });

  it('baseYear (Jahres-Navigation): abgeschlossenes Jahr → «ytd» wird ganzes Jahr vs. ganzes Vorjahr', () => {
    const w = computeVergleichsWindow('ytd', heute, undefined, undefined, 2024);
    expect(w).toMatchObject({
      curYear: 2024, vjYear: 2023,
      curFrom: '2024-01-01', curTo: '2024-12-31',
      vjFrom: '2023-01-01', vjTo: '2023-12-31',
    });
  });

  it('baseYear = laufendes Jahr: «ytd» bleibt YTD (identisch ohne baseYear)', () => {
    expect(computeVergleichsWindow('ytd', heute, undefined, undefined, 2025))
      .toEqual(computeYtdWindow(heute));
  });

  it('baseYear + «custom»: Bereich im gewählten Jahr vs. gleicher MM-TT-Bereich im Jahr davor', () => {
    const w = computeVergleichsWindow('custom', heute, '2024-03-10', '2024-06-20', 2024);
    expect(w).toMatchObject({
      curYear: 2024, vjYear: 2023,
      curFrom: '2024-03-10', curTo: '2024-06-20',
      vjFrom: '2023-03-10', vjTo: '2023-06-20',
    });
  });

  it('«custom» von>bis: Fenster wird NICHT normalisiert (Aufrufer validiert; Werte bleiben roh)', () => {
    // computeVergleichsWindow spiegelt nur — die von≤bis-Validierung liegt in der UI.
    const w = computeVergleichsWindow('custom', heute, '2025-06-20', '2025-03-10');
    expect(w.curFrom).toBe('2025-06-20');
    expect(w.curTo).toBe('2025-03-10'); // roh übernommen → UI verhindert Load
  });
});

// ── KW-Dropdown-Label mit Datumsbereich (Monatsübersicht) ────────────────────

describe('kwRangeLabel', () => {
  it('KW 27/2025 → «KW 27 · 30.06.–06.07.» (Mo–So)', () => {
    expect(kwRangeLabel(2025, 27)).toBe('KW 27 · 30.06.–06.07.');
  });

  it('KW 1/2026 überschreitet Jahresgrenze → «KW 1 · 29.12.–04.01.»', () => {
    // KW 1/2026 = Mo 29.12.2025 – So 04.01.2026.
    expect(kwRangeLabel(2026, 1)).toBe('KW 1 · 29.12.–04.01.');
  });

  it('KW 53/2020 → «KW 53 · 28.12.–03.01.»', () => {
    expect(kwRangeLabel(2020, 53)).toBe('KW 53 · 28.12.–03.01.');
  });
});

// ── Monatsübersicht: Vorjahres-Woche der gewählten (Monats-)Woche ────────────

describe('computeVorjahrWocheDays', () => {
  it('volle Woche → 7 tag-genaue Ist→VJ-Paare, gleiche KW im Vorjahr (Mo→Mo)', () => {
    // KW 30/2025 = Mo 21.07. – So 27.07.2025. Vorjahr KW 30/2024 = Mo 22.07. – So 28.07.2024.
    const pairs = computeVorjahrWocheDays('2025-07-21', '2025-07-27');
    expect(pairs).toHaveLength(7);
    expect(pairs[0]).toEqual({ ist: '2025-07-21', vj: '2024-07-22' }); // Mo→Mo
    expect(pairs[6]).toEqual({ ist: '2025-07-27', vj: '2024-07-28' }); // So→So
    // Wochentags-Ausrichtung: jeder Ist-Tag ↦ selber Wochentag im VJ.
    for (const p of pairs) {
      const wi = new Date(p.ist).getDay();
      const wv = new Date(p.vj).getDay();
      expect(wi).toBe(wv);
    }
  });

  it('Teilwoche (auf Monatsanfang geklemmt) bleibt tag-genau ausgerichtet', () => {
    // Angenommen geklemmt auf Di–So (22.–27.07.2025) → VJ Di–So derselben KW.
    const pairs = computeVorjahrWocheDays('2025-07-22', '2025-07-27');
    expect(pairs).toHaveLength(6);
    expect(pairs[0]).toEqual({ ist: '2025-07-22', vj: '2024-07-23' }); // Di→Di
    expect(pairs[5]).toEqual({ ist: '2025-07-27', vj: '2024-07-28' }); // So→So
  });

  it('last7-artige Teilwoche (Do–So) mappt auf dieselben Wochentage im VJ', () => {
    // Do 24.07. – So 27.07.2025 → VJ Do 25.07. – So 28.07.2024.
    const pairs = computeVorjahrWocheDays('2025-07-24', '2025-07-27');
    expect(pairs.map(p => p.vj)).toEqual([
      '2024-07-25', '2024-07-26', '2024-07-27', '2024-07-28',
    ]);
  });

  it('Jahreswechsel: KW 1/2026 (29.12.2025–…) → VJ KW 1/2025 (30.12.2024–…)', () => {
    const pairs = computeVorjahrWocheDays('2025-12-29', '2025-12-31');
    // 29.12.2025 = Mo (KW1/2026). VJ Mo KW1/2025 = 30.12.2024.
    expect(pairs[0]).toEqual({ ist: '2025-12-29', vj: '2024-12-30' });
    expect(pairs).toHaveLength(3);
  });

  it('KW existiert im Vorjahr nicht (KW-53-Randfall) → leeres Array', () => {
    // KW 53/2026: Vorjahr 2025 hat nur 52 ISO-Wochen → keine Zuordnung.
    // Mo KW53/2026 = 28.12.2026.
    const pairs = computeVorjahrWocheDays('2026-12-28', '2027-01-03');
    expect(pairs).toEqual([]);
  });

  it('leerer/ungültiger Bereich → leeres Array', () => {
    expect(computeVorjahrWocheDays(null, null)).toEqual([]);
    expect(computeVorjahrWocheDays('2025-07-27', '2025-07-21')).toEqual([]);
  });
});

// ── Monatsübersicht: Personal-Block (Personalkosten + PKQ) ───────────────────

describe('computePersonalBlock', () => {
  // Basis-Szenario: Monat 30 Tage, FIX 30'000/Mt → 1'000/Tag; Woche = 7 Tage
  // (davon 5 vergangene Ist-Tage mit FLEX-Ist), Ziel 35.5 %.
  const base = {
    // FLEX-Ist nur an den 5 vergangenen Ist-Tagen (Mo–Fr), je 200.
    flexIstProTag: {
      '2025-07-07': 200, '2025-07-08': 200, '2025-07-09': 200,
      '2025-07-10': 200, '2025-07-11': 200,
    } as Record<string, number>,
    istTagSet: new Set(['2025-07-07', '2025-07-08', '2025-07-09', '2025-07-10', '2025-07-11']),
    fixMonat: 30000,
    daysInMonth: 30,
    wocheTage: [
      '2025-07-07', '2025-07-08', '2025-07-09', '2025-07-10', '2025-07-11',
      '2025-07-12', '2025-07-13',
    ],
    wBudgetNet: 20000,      // Netto-Umsatz-Budget der Woche
    wNetIst: 18000,         // Netto-Umsatz-Ist der Woche
    zielQuote: 0.355,
    istKostenMonat: 123961,
    umsatzBudgetMonat: 280000,
    pkqIstMonat: 0.489,
  };

  it('PK-Ist-Woche = FIX pro-rata (7/30 × 30000) + FLEX-Ist (5×200)', () => {
    const r = computePersonalBlock(base);
    // 30000 × 7/30 = 7000; + 1000 FLEX = 8000.
    expect(r.pkIstWoche).toBe(8000);
  });

  it('FLEX-Ist zählt nur an Ist-Tagen (künftige Wochentage ohne Ist ignoriert)', () => {
    // Zusätzlicher (künftiger) FLEX-Wert an einem NICHT-Ist-Tag darf nicht zählen.
    const r = computePersonalBlock({
      ...base,
      flexIstProTag: { ...base.flexIstProTag, '2025-07-12': 999 },
    });
    expect(r.pkIstWoche).toBe(8000); // 2025-07-12 ist kein istTag → ignoriert
  });

  it('PK-Budget-Woche = Zielquote × Netto-Umsatz-Budget-Woche', () => {
    const r = computePersonalBlock(base);
    expect(r.pkBudgetWoche).toBe(7100); // 0.355 × 20000
  });

  it('PK-Budget-Monat = Zielquote × Umsatz-Budget-Monat', () => {
    const r = computePersonalBlock(base);
    expect(r.pkBudgetMonat).toBe(99400); // 0.355 × 280000
  });

  it('PKQ-Woche = PK-Ist-Woche ÷ Netto-Umsatz-Ist-Woche (Ist÷Ist), %', () => {
    const r = computePersonalBlock(base);
    // 8000 / 18000 = 44.44 %
    expect(r.pkqWochePct).toBeCloseTo(44.44, 2);
    // über Obergrenze → würde in der UI rot markiert.
    expect(r.pkqWochePct! > OBERGRENZE_PKQ_PCT).toBe(true);
  });

  it('PKQ-Monat = Ist bis Stichtag (durchgereicht), % ; Ist-Kosten durchgereicht', () => {
    const r = computePersonalBlock(base);
    expect(r.pkqMonatPct).toBe(48.9);
    expect(r.pkIstMonat).toBe(123961);
  });

  it('keine Woche gewählt → Woche-Werte null (leer statt 0)', () => {
    const r = computePersonalBlock({ ...base, wocheTage: [] });
    expect(r.pkIstWoche).toBeNull();
    expect(r.pkBudgetWoche).toBeNull();
    expect(r.pkqWochePct).toBeNull();
    // Monatswerte bleiben verfügbar.
    expect(r.pkBudgetMonat).toBe(99400);
    expect(r.pkqMonatPct).toBe(48.9);
  });

  it('fehlendes Umsatz-Budget → Budget-Zellen null, nie 0', () => {
    const r = computePersonalBlock({ ...base, wBudgetNet: null, umsatzBudgetMonat: null });
    expect(r.pkBudgetWoche).toBeNull();
    expect(r.pkBudgetMonat).toBeNull();
    // Ist-Woche ist von Budget unabhängig.
    expect(r.pkIstWoche).toBe(8000);
  });

  it('kein Ist-Umsatz-Woche → PKQ-Woche null (nicht 0/∞)', () => {
    const r = computePersonalBlock({ ...base, wNetIst: 0 });
    expect(r.pkqWochePct).toBeNull();
  });

  it('kein PKQ-Ist vom Kern → PKQ-Monat null', () => {
    const r = computePersonalBlock({ ...base, pkqIstMonat: null });
    expect(r.pkqMonatPct).toBeNull();
  });
});

// ── Cockpit: benutzerdefinierte Zeilen-Reihenfolge (applyRowOrder) ───────────

describe('applyRowOrder', () => {
  const dat = (id: string): MrRow => ({
    type: 'data', id, label: id,
    budget: null, vj: null, vjMonth: null, week: null, weekBudget: null, monthBudget: null, month: null,
  });
  const sep = (): MrRow => ({
    type: 'empty', budget: null, vj: null, vjMonth: null, week: null, weekBudget: null, monthBudget: null, month: null,
  });
  // Standard: A, B, (Trenner), C
  const standard: MrRow[] = [dat('a'), dat('b'), sep(), dat('c')];
  const ids = (rows: MrRow[]) => rows.filter(r => r.type === 'data').map(r => r.id);

  it('leeres/fehlendes Setting → Standard unverändert (inkl. Trenner)', () => {
    expect(applyRowOrder(standard, null)).toBe(standard);
    expect(applyRowOrder(standard, undefined)).toBe(standard);
    expect(applyRowOrder(standard, [])).toBe(standard);
  });

  it('gespeicherte Reihenfolge wird angewendet; Trenner entfallen', () => {
    const out = applyRowOrder(standard, ['c', 'a', 'b']);
    expect(ids(out)).toEqual(['c', 'a', 'b']);
    // Keine Trenner mehr in der benutzerdefinierten Reihenfolge.
    expect(out.every(r => r.type === 'data')).toBe(true);
  });

  it('unbekannte gespeicherte IDs werden ignoriert (nie crashen)', () => {
    const out = applyRowOrder(standard, ['x', 'c', 'y', 'a']);
    // x/y existieren nicht → übersprungen; b ist neu → hinten angehängt.
    expect(ids(out)).toEqual(['c', 'a', 'b']);
  });

  it('NEUE Zeilen (nicht im Setting) hängen in Standard-Reihenfolge hinten an', () => {
    // Setting kennt nur c; a und b sind «neu» → in Standardreihenfolge (a, b) danach.
    const out = applyRowOrder(standard, ['c']);
    expect(ids(out)).toEqual(['c', 'a', 'b']);
  });

  it('Duplikate im Setting werden nur einmal berücksichtigt', () => {
    const out = applyRowOrder(standard, ['b', 'b', 'a', 'c']);
    expect(ids(out)).toEqual(['b', 'a', 'c']);
  });

  it('verliert nie Zeilen — Ausgabe enthält alle Datenzeilen genau einmal', () => {
    const out = applyRowOrder(standard, ['c']);
    expect(new Set(ids(out))).toEqual(new Set(['a', 'b', 'c']));
    expect(ids(out).length).toBe(3);
  });

  // Legacy: alte gespeicherte Reihenfolgen kennen die entfernten Zeilen
  // 'warenkostenquote'/'wkq_food'/'wkq_beverage' noch → einfach übersprungen;
  // Lieferanten-Kinder (childOf) bleiben erhalten und werden nie verloren.
  it('legacy WKQ-IDs im Setting + Lieferanten-Kinder: keine Zeile geht verloren', () => {
    const child = (id: string): MrRow => ({ ...dat(id), childOf: 'warenkosten_total' });
    const rows = [dat('a'), dat('warenkosten_total'), child('warenkosten_migros'), child('warenkosten_weinhandel')];
    const out = applyRowOrder(rows, ['warenkostenquote', 'wkq_food', 'wkq_beverage', 'warenkosten_total', 'a']);
    expect(ids(out)).toEqual(['warenkosten_total', 'a', 'warenkosten_migros', 'warenkosten_weinhandel']);
    // Kinder behalten ihre childOf-Zuordnung (Anzeige gruppiert sie unter dem Total).
    expect(out.filter(r => r.childOf === 'warenkosten_total').length).toBe(2);
  });

  // Stunden-Stapel: Bedarf → Plan → Ist müssen IMMER ein zusammenhängender
  // Block sein — auch wenn eine alte gespeicherte Reihenfolge 'bedarf_stunden'
  // noch nicht kennt (die Zeile würde sonst einzeln ans Tabellenende rutschen).
  it('Stunden-Stapel wird zusammengeklebt: bedarf_stunden rückt vor plan/ist', () => {
    const rows = [dat('a'), dat('prod_stunden_plan'), dat('prod_stunden_ist'), dat('b'), dat('bedarf_stunden')];
    // Altes Setting ohne bedarf_stunden → würde ohne Glue hinten angehängt.
    const out = applyRowOrder(rows, ['a', 'prod_stunden_plan', 'prod_stunden_ist', 'b']);
    expect(ids(out)).toEqual(['a', 'bedarf_stunden', 'prod_stunden_plan', 'prod_stunden_ist', 'b']);
  });

  it('Stunden-Stapel: feste Block-Reihenfolge auch bei verdrehtem Setting', () => {
    const rows = [dat('bedarf_stunden'), dat('prod_stunden_plan'), dat('prod_stunden_ist'), dat('x')];
    const out = applyRowOrder(rows, ['prod_stunden_ist', 'x', 'bedarf_stunden', 'prod_stunden_plan']);
    // Block an Position der ersten Stapel-Zeile, intern Bedarf → Plan → Ist.
    expect(ids(out)).toEqual(['bedarf_stunden', 'prod_stunden_plan', 'prod_stunden_ist', 'x']);
  });
});

// ── Wochenverlauf: Jahr-Auswahl (Fensterbestimmung fürs gewählte Jahr) ───────

describe('computeWeeksForYear', () => {
  // Referenz-Heute: Mi 16.07.2025 → 4 Wochen inkl. laufender = KW 25–28/2025.
  const h2025 = new Date(2025, 6, 16);

  it('aktuelles Jahr = identisch zu computeLastCompleteWeeks', () => {
    const ref = computeLastCompleteWeeks(4, h2025);
    const sel = computeWeeksForYear(4, h2025, 2025);
    expect(sel).toEqual(ref);
  });

  it('vergangenes Jahr: gleiche KW-Nummern, aber im Zieljahr (2024)', () => {
    const ref = computeLastCompleteWeeks(4, h2025);   // KW 25–28/2025
    const sel = computeWeeksForYear(4, h2025, 2024);
    expect(sel.map(w => w.kw)).toEqual(ref.map(w => w.kw));       // gleiche KW-Nummern
    expect(sel.every(w => w.kwYear === 2024)).toBe(true);         // alle im Zieljahr
    // KW 27/2024 = Mo 01.07.2024 – So 07.07.2024.
    const kw27 = sel.find(w => w.kw === 27)!;
    expect(kw27).toMatchObject({ kwYear: 2024, from: '2024-07-01', to: '2024-07-07' });
  });

  it('KW-53-Randfall: KW 53 wird weggelassen, wenn sie im Zieljahr nicht existiert', () => {
    // Heute so wählen, dass KW 53 im Referenz-Fenster liegt: 08.01.2021 (KW 1/2021),
    // Vorwoche = KW 53/2020 (2020 hat 53 Wochen).
    const hJan2021 = new Date(2021, 0, 8);
    const ref = computeLastCompleteWeeks(2, hJan2021);
    expect(ref.some(w => w.kw === 53)).toBe(true);   // Referenz enthält KW 53
    // Zieljahr −1 (Shift −1): 2020→2019 usw. 2019 hat KEINE KW 53 → weggelassen.
    const sel = computeWeeksForYear(2, hJan2021, hJan2021.getFullYear() - 1);
    expect(sel.some(w => w.kw === 53)).toBe(false);  // KW 53 fehlt (2019 hat sie nicht)
    expect(sel.length).toBeLessThan(ref.length);     // eine Woche weniger
  });
});

describe('gewichteterTagesAvg — Durchschnittsverkauf-Fallback (Monat & Woche)', () => {
  const tage = ['2026-07-01', '2026-07-02', '2026-07-03'];

  it('gäste-gewichteter Mittelwert wenn Gästezahlen vorhanden', () => {
    const avg = { '2026-07-01': 10, '2026-07-02': 20 };
    const gaeste = { '2026-07-01': 100, '2026-07-02': 300 };
    // (10*100 + 20*300) / 400 = 17.5
    expect(gewichteterTagesAvg(tage, avg, gaeste)).toBe(17.5);
  });

  it('Fallback einfacher Mittelwert ohne Gästezahlen', () => {
    const avg = { '2026-07-01': 10, '2026-07-02': 20 };
    expect(gewichteterTagesAvg(tage, avg, {})).toBe(15);
  });

  it('null wenn keine Tageswerte (leer statt 0)', () => {
    expect(gewichteterTagesAvg(tage, {}, { '2026-07-01': 100 })).toBeNull();
    expect(gewichteterTagesAvg([], { '2026-07-01': 10 }, {})).toBeNull();
  });

  it('Tage ausserhalb der Liste und Werte <= 0 werden ignoriert', () => {
    const avg = { '2026-07-01': 0, '2026-07-02': 20, '2026-08-01': 99 };
    const gaeste = { '2026-07-02': 50, '2026-08-01': 500 };
    expect(gewichteterTagesAvg(tage, avg, gaeste)).toBe(20);
  });

  it('Mischfall: nur Tage MIT Gästen gewichten (Regel wWeight>0 gewinnt)', () => {
    const avg = { '2026-07-01': 10, '2026-07-02': 20 };
    const gaeste = { '2026-07-02': 200 };
    // Tag 1 hat keinen Gästewert → nur Tag 2 zählt gewichtet: 20
    expect(gewichteterTagesAvg(tage, avg, gaeste)).toBe(20);
  });
});
