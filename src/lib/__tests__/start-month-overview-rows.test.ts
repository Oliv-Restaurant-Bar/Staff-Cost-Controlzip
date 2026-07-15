// @vitest-environment node
/**
 * T511 — Kompakte Monatsübersicht der Startseite.
 * Die Zeilen sind eine reine Umformatierung des SSoT-Aufgabenstands
 * (buildImportTasks + summarizeTypeCompletion) — die Tests laufen deshalb
 * gegen die ECHTE Engine (realer öffentlicher Einstiegspfad), nie gegen
 * nachgebaute Zwischenobjekte.
 */

import { describe, it, expect } from 'vitest';
import {
  buildImportTasks,
  type MonthCoverage,
} from '@/lib/import-tasks-engine';
import { summarizeTypeCompletion } from '@/lib/import-tasks-priority';
import {
  buildMonthOverviewRows,
  isFutureMonthPeriod,
  shiftMonth,
  type MonthPeriod,
} from '@/lib/start-overview-utils';

const TODAY = '2026-07-15';

function rowsFor(
  period: MonthPeriod,
  coverage: MonthCoverage,
  opts: { isGuest?: boolean; umsatz?: { status: 'ok'; text: string } } = {},
) {
  const tasks = buildImportTasks(
    { year: period.year, month: period.month, today: TODAY },
    coverage,
  );
  return buildMonthOverviewRows({
    period,
    tasks,
    completions: summarizeTypeCompletion(tasks, TODAY),
    umsatzabstimmung: opts.umsatz ?? null,
    isGuest: opts.isGuest ?? false,
  });
}

/** Alle Tage yyyy-MM-01 … yyyy-MM-lastDay als ISO-Liste. */
function allDays(year: number, month: number, upToDay?: number): string[] {
  const last = upToDay ?? new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) =>
    `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
  );
}

describe('T511 — Monatsnavigation (shiftMonth / isFutureMonthPeriod)', () => {
  it('vorheriger Monat über die Jahresgrenze: Januar 2025 → Dezember 2024', () => {
    expect(shiftMonth({ year: 2025, month: 1 }, -1)).toEqual({ year: 2024, month: 12 });
  });

  it('nächster Monat über die Jahresgrenze: Dezember 2024 → Januar 2025', () => {
    expect(shiftMonth({ year: 2024, month: 12 }, 1)).toEqual({ year: 2025, month: 1 });
  });

  it('Verschiebung innerhalb des Jahres und um mehrere Monate', () => {
    expect(shiftMonth({ year: 2026, month: 7 }, -1)).toEqual({ year: 2026, month: 6 });
    expect(shiftMonth({ year: 2026, month: 7 }, -19)).toEqual({ year: 2024, month: 12 });
    expect(shiftMonth({ year: 2026, month: 7 }, 6)).toEqual({ year: 2027, month: 1 });
  });

  it('Zukunftserkennung: erst der Folgemonat gilt als Zukunft', () => {
    expect(isFutureMonthPeriod({ year: 2026, month: 7 }, TODAY)).toBe(false); // laufender Monat
    expect(isFutureMonthPeriod({ year: 2026, month: 6 }, TODAY)).toBe(false); // Vergangenheit
    expect(isFutureMonthPeriod({ year: 2026, month: 8 }, TODAY)).toBe(true);
    expect(isFutureMonthPeriod({ year: 2027, month: 1 }, TODAY)).toBe(true);
  });
});

describe('T511 — Zeilen aus dem SSoT-Aufgabenstand', () => {
  it('vollständiger Vormonat: „Vollständig" mit Fortschritt X von X', () => {
    const rows = rowsFor(
      { year: 2026, month: 6 },
      { zbericht: { coveredDays: allDays(2026, 6) } },
    );
    const z = rows.find((r) => r.type === 'zbericht')!;
    expect(z.text).toBe('Vollständig');
    expect(z.tone).toBe('good');
    expect(z.progress).toBe('30 von 30 erwarteten Tagen vorhanden');
  });

  it('Einzeltag-Lücke wird als einzelner Tag angezeigt', () => {
    const covered = allDays(2026, 6).filter((d) => d !== '2026-06-10');
    const rows = rowsFor({ year: 2026, month: 6 }, { zbericht: { coveredDays: covered } });
    const z = rows.find((r) => r.type === 'zbericht')!;
    expect(z.text).toContain('Fehlend:');
    expect(z.text).toContain('10.06.');
    expect(z.progress).toBe('29 von 30 erwarteten Tagen vorhanden');
  });

  it('zusammenhängende fehlende Tage werden als EIN Bereich formatiert', () => {
    const covered = allDays(2026, 6).filter((d) => d < '2026-06-10' || d > '2026-06-14');
    const rows = rowsFor({ year: 2026, month: 6 }, { zbericht: { coveredDays: covered } });
    const z = rows.find((r) => r.type === 'zbericht')!;
    expect(z.text).toContain('10.–14.06.');
  });

  it('viele Lücken werden kompakt gekürzt („+ N weitere" in Tagen)', () => {
    // Nur jeden 4. Tag abgedeckt → viele Einzel-Lücken.
    const covered = allDays(2026, 6).filter((_, i) => i % 4 === 0);
    const rows = rowsFor({ year: 2026, month: 6 }, { zbericht: { coveredDays: covered } });
    const z = rows.find((r) => r.type === 'zbericht')!;
    expect(z.text).toMatch(/\+ \d+ weitere/);
  });

  it('Zukunftsmonat (tasks=null): alle Zeilen „Noch nicht fällig", nie „fehlend", kein Fortschritt', () => {
    const rows = buildMonthOverviewRows({
      period: { year: 2026, month: 8 },
      tasks: null,
      completions: null,
      umsatzabstimmung: null,
      isGuest: false,
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.text).toBe('Noch nicht fällig');
      expect(r.tone).toBe('neutral');
      expect(r.progress).toBeNull();
    }
  });

  it('laufender Monat: erwartete Tage sind auf gestern gedeckelt — Zukunftstage fehlen nie', () => {
    // Bis gestern (14.07.) alles importiert → done, obwohl der Monat 31 Tage hat.
    const rows = rowsFor(
      { year: 2026, month: 7 },
      { zbericht: { coveredDays: allDays(2026, 7, 14) } },
    );
    const z = rows.find((r) => r.type === 'zbericht')!;
    expect(z.text).toBe('Vollständig');
    expect(z.progress).toBe('14 von 14 erwarteten Tagen vorhanden');
  });

  it('monatliche Quellen zeigen Monatsstatus — NIE künstliche Tageslücken', () => {
    const rows = rowsFor({ year: 2026, month: 5 }, { erfolgsrechnung: {} });
    const er = rows.find((r) => r.type === 'erfolgsrechnung')!;
    expect(er.text).toBe('Monatsimport fehlt');
    expect(er.progress).toBeNull();
    expect(er.text).not.toContain('Tagen');
  });

  it('Jahresbudget: Jahresstatus statt Tagesliste; laufendes Jahr neutral, vergangenes Jahr offen', () => {
    // Laufendes Jahr (2026): Budget-Jahresperiode läuft noch → neutral, nie „fehlt".
    const running = rowsFor({ year: 2026, month: 5 }, { budget: {} });
    expect(running.find((r) => r.type === 'budget')!.text).toBe('Noch nicht fällig');
    // Vergangenes Jahr (2025): fehlendes Jahresbudget ist offen — als Jahresstatus, ohne Tagesliste.
    const open = rowsFor({ year: 2025, month: 5 }, { budget: {} });
    const b = open.find((r) => r.type === 'budget')!;
    expect(b.text).toBe('Jahresbudget fehlt');
    expect(b.progress).toBeNull();
    const done = rowsFor({ year: 2025, month: 5 }, { budget: { yearDone: true } });
    expect(done.find((r) => r.type === 'budget')!.text).toBe('Vollständig');
  });

  it('Teilfehler einer Quelle blendet die anderen Quellen nicht aus', () => {
    const rows = rowsFor(
      { year: 2026, month: 6 },
      {
        zbericht: { error: 'DB nicht erreichbar' },
        erfolgsrechnung: { monthDone: true },
      },
    );
    const z = rows.find((r) => r.type === 'zbericht')!;
    expect(z.tone).toBe('critical');
    expect(z.text).toBe('Status konnte nicht ermittelt werden');
    expect(z.href).toBe('/import-cockpit');
    const er = rows.find((r) => r.type === 'erfolgsrechnung')!;
    expect(er.text).toBe('Vollständig');
    expect(rows.length).toBeGreaterThanOrEqual(9);
  });

  it('fehlend ≠ 0: ohne Coverage-Eintrag gibt es keinen „0 von …"-Fortschritt', () => {
    const rows = rowsFor({ year: 2026, month: 6 }, {});
    for (const r of rows) {
      expect(r.progress ?? '').not.toMatch(/^0 von 0/);
      expect(r.text).not.toBe('0');
    }
  });

  it('Umsatzabstimmungs-Zeile: Deep-Link übernimmt Jahr und Monat', () => {
    const rows = rowsFor(
      { year: 2024, month: 3 },
      {},
      { umsatz: { status: 'ok', text: 'Abgestimmt (Differenz < 1 %)' } },
    );
    const u = rows.find((r) => r.type === 'umsatzabstimmung')!;
    expect(u.href).toBe('/umsatzabstimmung?year=2024&month=3');
    expect(u.tone).toBe('good');
  });

  it('Gast-Session: keine Zeile der Monatsübersicht ist verlinkt', () => {
    const rows = rowsFor(
      { year: 2026, month: 6 },
      { zbericht: { coveredDays: allDays(2026, 6) } },
      { isGuest: true, umsatz: { status: 'ok', text: 'Abgestimmt (Differenz < 1 %)' } },
    );
    expect(rows.every((r) => r.href === null)).toBe(true);
  });
});
