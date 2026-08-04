// @vitest-environment node
/**
 * T511 — Kompakte Monatsübersicht der Startseite.
 * Die Zeilen sind eine reine Umformatierung des SSoT-Aufgabenstands
 * (buildImportTasks + summarizeTypeCompletion) — die Tests laufen deshalb
 * gegen die ECHTE Engine (realer öffentlicher Einstiegspfad), nie gegen
 * nachgebaute Zwischenobjekte. Default-Einstellungen der neuen
 * Import-Strategie (marketing = bei_bedarf, reservationen = wöchentlich,
 * inventur = manuelles Monats-Häkchen).
 */

import { describe, it, expect } from 'vitest';
import {
  buildImportTasks,
  type MonthCoverage,
} from '@/lib/import-tasks-engine';
import { defaultImportSettings } from '@/lib/import-settings';
import { summarizeTypeCompletion } from '@/lib/import-tasks-priority';
import {
  buildMonthOverviewRows,
  isFutureMonthPeriod,
  shiftMonth,
  type MonthPeriod,
} from '@/lib/start-overview-utils';

const TODAY = '2026-07-15';
const SETTINGS = defaultImportSettings();

function rowsFor(
  period: MonthPeriod,
  coverage: MonthCoverage,
  opts: { umsatz?: { status: 'ok'; text: string } } = {},
) {
  const tasks = buildImportTasks(
    { year: period.year, month: period.month, today: TODAY },
    coverage,
    SETTINGS,
  );
  return buildMonthOverviewRows({
    period,
    tasks,
    completions: summarizeTypeCompletion(tasks, TODAY),
    umsatzabstimmung: opts.umsatz ?? null,
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

  it('wöchentliche Reservationen: Fortschritt zählt die Tage der fälligen Wochen', () => {
    // Juni 2026: 4 abgeschlossene ISO-Wochen (Mo 01.06.–So 28.06.) = 28 Tage.
    const rows = rowsFor(
      { year: 2026, month: 6 },
      { reservationen: { coveredDays: allDays(2026, 6, 28) } },
    );
    const r = rows.find((x) => x.type === 'reservationen')!;
    expect(r.text).toBe('Vollständig');
    expect(r.progress).toBe('28 von 28 erwarteten Tagen vorhanden');
  });

  it('marketing (bei_bedarf) erzeugt keine Aufgaben → neutrale Zeile, nie „fehlend"', () => {
    const rows = rowsFor({ year: 2026, month: 6 }, {});
    const m = rows.find((r) => r.type === 'marketing')!;
    expect(m.text).toBe('Noch nicht fällig');
    expect(m.tone).toBe('neutral');
    expect(m.progress).toBeNull();
  });

  it('monatliche Quellen zeigen Monatsstatus — NIE künstliche Tageslücken', () => {
    const rows = rowsFor({ year: 2026, month: 5 }, { erfolgsrechnung: {} });
    const er = rows.find((r) => r.type === 'erfolgsrechnung')!;
    expect(er.text).toBe('Monatsimport fehlt');
    expect(er.progress).toBeNull();
    expect(er.text).not.toContain('Tagen');
  });

  it('Inventur: offener Monat heisst „Noch nicht bestätigt", Häkchen macht ihn vollständig', () => {
    const open = rowsFor({ year: 2026, month: 5 }, { inventur: {} });
    const i = open.find((r) => r.type === 'inventur')!;
    expect(i.text).toBe('Noch nicht bestätigt');
    expect(i.progress).toBeNull();
    const done = rowsFor({ year: 2026, month: 5 }, { inventur: { monthDone: true } });
    expect(done.find((r) => r.type === 'inventur')!.text).toBe('Vollständig');
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

  it('fehlend ≠ 0: ohne Coverage-Eintrag gibt es keinen „0 von 0"-Fortschritt', () => {
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
});
