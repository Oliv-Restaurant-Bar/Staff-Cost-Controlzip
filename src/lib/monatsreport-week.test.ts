// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

// Reine Logik-Tests: den Supabase-Client (braucht localStorage/browser) stubben,
// damit der Import von monatsreport.ts unter node läuft.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import {
  computeWeekRange, weekSelectionLabel, computeLastCompleteWeeks, vorjahresWoche,
  computeYtdWindow, kwRangeLabel, computeWeeksForYear, computeVergleichsWindow,
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

// ── Wochenverlauf: Jahr-Auswahl (Fensterbestimmung fürs gewählte Jahr) ───────

describe('computeWeeksForYear', () => {
  // Referenz-Heute: Mi 16.07.2025 → letzte 4 abgeschlossene Wochen = KW 24–27/2025.
  const h2025 = new Date(2025, 6, 16);

  it('aktuelles Jahr = identisch zu computeLastCompleteWeeks', () => {
    const ref = computeLastCompleteWeeks(4, h2025);
    const sel = computeWeeksForYear(4, h2025, 2025);
    expect(sel).toEqual(ref);
  });

  it('vergangenes Jahr: gleiche KW-Nummern, aber im Zieljahr (2024)', () => {
    const ref = computeLastCompleteWeeks(4, h2025);   // KW 24–27/2025
    const sel = computeWeeksForYear(4, h2025, 2024);
    expect(sel.map(w => w.kw)).toEqual(ref.map(w => w.kw));       // gleiche KW-Nummern
    expect(sel.every(w => w.kwYear === 2024)).toBe(true);         // alle im Zieljahr
    // KW 27/2024 = Mo 01.07.2024 – So 07.07.2024.
    const kw27 = sel.find(w => w.kw === 27)!;
    expect(kw27).toMatchObject({ kwYear: 2024, from: '2024-07-01', to: '2024-07-07' });
  });

  it('KW-53-Randfall: KW 53 wird weggelassen, wenn sie im Zieljahr nicht existiert', () => {
    // Heute so wählen, dass KW 53 im Referenz-Fenster liegt: 08.01.2021 (KW 1/2021),
    // letzte abgeschlossene Woche = KW 53/2020 (2020 hat 53 Wochen).
    const hJan2021 = new Date(2021, 0, 8);
    const ref = computeLastCompleteWeeks(2, hJan2021);
    expect(ref.some(w => w.kw === 53)).toBe(true);   // Referenz enthält KW 53
    // Zieljahr −1 (Shift −1): 2020→2019 usw. 2019 hat KEINE KW 53 → weggelassen.
    const sel = computeWeeksForYear(2, hJan2021, hJan2021.getFullYear() - 1);
    expect(sel.some(w => w.kw === 53)).toBe(false);  // KW 53 fehlt (2019 hat sie nicht)
    expect(sel.length).toBeLessThan(ref.length);     // eine Woche weniger
  });
});
