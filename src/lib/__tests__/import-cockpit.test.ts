// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  computeSourceStatus,
  findMissingDays,
  summarizeCockpit,
  groupChecklist,
  checklistStateFromStatus,
  normalizeDataDate,
  formatCockpitDate,
  rowMatchesFilters,
  matchesCockpitSearch,
  EMPTY_COCKPIT_FILTER,
  CATEGORY_ORDER,
  IMPORT_TYPE_ORDER,
  CATEGORY_LABEL,
  IMPORT_TYPE_LABEL,
  STATUS_LABEL,
  COCKPIT_SOURCES,
  type CockpitRow,
  type CockpitSourceDef,
  type CockpitStatusResult,
  type CockpitSignal,
  type CockpitStatus,
  type CockpitCategory,
  type CockpitImportType,
  type CockpitFilterState,
  type ImportInterval,
} from '../import-cockpit';

const NOW = new Date('2026-07-06T12:00:00');

function def(
  overrides: Partial<Pick<CockpitSourceDef, 'interval' | 'checkable' | 'detectGaps'>>,
): Pick<CockpitSourceDef, 'interval' | 'checkable' | 'detectGaps'> {
  return { interval: 'daily', checkable: true, detectGaps: false, ...overrides };
}

function sig(overrides: Partial<CockpitSignal>): CockpitSignal {
  return { latestDataDate: null, ...overrides };
}

describe('computeSourceStatus — daily', () => {
  it('täglich aktuell (0–1 Tage) → current', () => {
    expect(computeSourceStatus(def({ interval: 'daily' }), sig({ latestDataDate: '2026-07-06' }), NOW).status).toBe(
      'current',
    );
    expect(computeSourceStatus(def({ interval: 'daily' }), sig({ latestDataDate: '2026-07-05' }), NOW).status).toBe(
      'current',
    );
  });

  it('täglich 3 Tage hinter → due_soon', () => {
    expect(computeSourceStatus(def({ interval: 'daily' }), sig({ latestDataDate: '2026-07-03' }), NOW).status).toBe(
      'due_soon',
    );
  });

  it('täglich überfällig (>3 Tage) → overdue', () => {
    const r = computeSourceStatus(def({ interval: 'daily' }), sig({ latestDataDate: '2026-06-30' }), NOW);
    expect(r.status).toBe('overdue');
    expect(r.daysBehind).toBe(6);
  });

  it('setzt nextDue auf den Folgetag des Datenstands', () => {
    const r = computeSourceStatus(def({ interval: 'daily' }), sig({ latestDataDate: '2026-07-05' }), NOW);
    expect(r.nextDue).toBe('2026-07-06');
  });
});

describe('computeSourceStatus — weekly / monthly / yearly', () => {
  it('wöchentlich fällig (8 Tage) → due_soon', () => {
    expect(computeSourceStatus(def({ interval: 'weekly' }), sig({ latestDataDate: '2026-06-28' }), NOW).status).toBe(
      'due_soon',
    );
  });

  it('wöchentlich aktuell (≤7 Tage) → current', () => {
    expect(computeSourceStatus(def({ interval: 'weekly' }), sig({ latestDataDate: '2026-07-01' }), NOW).status).toBe(
      'current',
    );
  });

  it('monatlich fällig (Vormonat, 36 Tage) → due_soon', () => {
    const r = computeSourceStatus(def({ interval: 'monthly' }), sig({ latestDataDate: '2026-05' }), NOW);
    expect(r.status).toBe('due_soon');
  });

  it('monatlich aktuell (letzter Monat) → current', () => {
    expect(computeSourceStatus(def({ interval: 'monthly' }), sig({ latestDataDate: '2026-06' }), NOW).status).toBe(
      'current',
    );
  });

  it('jährlich fällig (Vorjahr) → due_soon; aktuelles Jahr → current; älter → overdue', () => {
    expect(computeSourceStatus(def({ interval: 'yearly' }), sig({ latestDataDate: '2025' }), NOW).status).toBe(
      'due_soon',
    );
    expect(computeSourceStatus(def({ interval: 'yearly' }), sig({ latestDataDate: '2026' }), NOW).status).toBe(
      'current',
    );
    expect(computeSourceStatus(def({ interval: 'yearly' }), sig({ latestDataDate: '2024' }), NOW).status).toBe(
      'overdue',
    );
  });
});

describe('computeSourceStatus — Sonderfälle', () => {
  it('noch nie importiert (prüfbar, kein Datum) → never', () => {
    const r = computeSourceStatus(def({ checkable: true }), sig({ latestDataDate: null }), NOW);
    expect(r.status).toBe('never');
    expect(r.latestDataDate).toBeNull();
  });

  it('keine Historie vorhanden (nicht prüfbar) → uncheckable', () => {
    const r = computeSourceStatus(def({ checkable: false }), sig({ latestDataDate: '2026-07-06' }), NOW);
    expect(r.status).toBe('uncheckable');
    expect(r.nextDue).toBeNull();
  });

  it('letzter Import fehlgeschlagen → overdue + failed', () => {
    const r = computeSourceStatus(
      def({ checkable: true }),
      sig({ latestDataDate: '2026-07-06', lastImport: { at: '2026-07-06T08:00:00Z', status: 'failed' } }),
      NOW,
    );
    expect(r.status).toBe('overdue');
    expect(r.failed).toBe(true);
  });

  it('fällt auf das letzte Importdatum zurück, wenn kein Datenstand vorliegt', () => {
    const r = computeSourceStatus(
      def({ interval: 'daily', checkable: true }),
      sig({ latestDataDate: null, lastImport: { at: '2026-07-05T09:00:00Z', status: 'success' } }),
      NOW,
    );
    expect(r.status).toBe('current');
  });
});

describe('computeSourceStatus — Datenlücken', () => {
  it('erkennt eine innere Lücke und senkt current → due_soon', () => {
    const covered = ['2026-07-01', '2026-07-02', '2026-07-04', '2026-07-05', '2026-07-06'];
    const r = computeSourceStatus(
      def({ interval: 'daily', checkable: true, detectGaps: true }),
      sig({ latestDataDate: '2026-07-06', coveredDates: covered }),
      NOW,
    );
    expect(r.missingDays).toEqual(['2026-07-03']);
    expect(r.status).toBe('due_soon');
    expect(r.reason).toContain('Datenlücke');
  });

  it('ohne Lücke bleibt current', () => {
    const covered = ['2026-07-04', '2026-07-05', '2026-07-06'];
    const r = computeSourceStatus(
      def({ interval: 'daily', checkable: true, detectGaps: true }),
      sig({ latestDataDate: '2026-07-06', coveredDates: covered }),
      NOW,
    );
    expect(r.missingDays).toEqual([]);
    expect(r.status).toBe('current');
  });
});

describe('findMissingDays', () => {
  it('liefert nur innere Löcher', () => {
    expect(findMissingDays(['2026-07-01', '2026-07-02', '2026-07-04'], '2026-06-01', '2026-07-04')).toEqual([
      '2026-07-03',
    ]);
  });

  it('keine Lücke → leer', () => {
    expect(findMissingDays(['2026-07-01', '2026-07-02', '2026-07-03'], '2026-06-01', '2026-07-03')).toEqual([]);
  });

  it('einzelnes Datum oder leer → leer', () => {
    expect(findMissingDays(['2026-07-01'], '2026-06-01', '2026-07-04')).toEqual([]);
    expect(findMissingDays([], '2026-06-01', '2026-07-04')).toEqual([]);
  });
});

describe('summarizeCockpit', () => {
  const mkResult = (status: CockpitStatus, missingDays: string[] = []): { result: CockpitStatusResult } => ({
    result: {
      status,
      latestDataDate: null,
      daysBehind: null,
      nextDue: null,
      missingDays,
      failed: false,
      reason: '',
    },
  });

  it('zählt Statusverteilung und Datenlücken korrekt', () => {
    const rows = [
      mkResult('current'),
      mkResult('current', ['2026-07-03']),
      mkResult('due_soon'),
      mkResult('overdue'),
      mkResult('never'),
      mkResult('uncheckable'),
      mkResult('uncheckable'),
    ];
    const kpis = summarizeCockpit(rows);
    expect(kpis).toEqual({ current: 2, dueSoon: 1, overdue: 1, never: 1, uncheckable: 2, dataGaps: 1 });
  });
});

describe('groupChecklist + checklistStateFromStatus', () => {
  const mkRow = (id: string, interval: ImportInterval, status: CockpitStatus): CockpitRow =>
    ({
      def: { id, interval, checklistLabel: `Aufgabe ${id}`, route: '/x' } as CockpitSourceDef,
      signal: { latestDataDate: null } as CockpitSignal,
      result: {
        status,
        latestDataDate: null,
        daysBehind: null,
        nextDue: null,
        missingDays: [],
        failed: false,
        reason: '',
      },
    }) as CockpitRow;

  it('mappt Status → Checklisten-Zustand', () => {
    expect(checklistStateFromStatus('current')).toBe('done');
    expect(checklistStateFromStatus('due_soon')).toBe('open');
    expect(checklistStateFromStatus('never')).toBe('open');
    expect(checklistStateFromStatus('overdue')).toBe('overdue');
    expect(checklistStateFromStatus('uncheckable')).toBe('unknown');
  });

  it('gruppiert nach Intervall', () => {
    const rows = [
      mkRow('a', 'daily', 'current'),
      mkRow('b', 'daily', 'overdue'),
      mkRow('c', 'weekly', 'due_soon'),
      mkRow('d', 'monthly', 'uncheckable'),
      mkRow('e', 'yearly', 'never'),
    ];
    const g = groupChecklist(rows);
    expect(g.daily.map((i) => i.state)).toEqual(['done', 'overdue']);
    expect(g.weekly[0].state).toBe('open');
    expect(g.monthly[0].state).toBe('unknown');
    expect(g.yearly[0].state).toBe('open');
  });
});

describe('normalizeDataDate + formatCockpitDate', () => {
  it('normalisiert Monat auf Monatsende und Jahr auf 31.12.', () => {
    const month = normalizeDataDate('2026-06')!;
    expect([month.getFullYear(), month.getMonth(), month.getDate()]).toEqual([2026, 5, 30]);
    const year = normalizeDataDate('2026')!;
    expect([year.getFullYear(), year.getMonth(), year.getDate()]).toEqual([2026, 11, 31]);
    expect(normalizeDataDate(null)).toBeNull();
    expect(normalizeDataDate('quatsch')).toBeNull();
  });

  it('formatiert Datenstände lesbar', () => {
    expect(formatCockpitDate('2026-07-06')).toBe('06.07.2026');
    expect(formatCockpitDate('2026-06')).toBe('06.2026');
    expect(formatCockpitDate('2026')).toBe('2026');
    expect(formatCockpitDate(null)).toBe('Keine Daten');
  });
});

describe('COCKPIT_SOURCES Deskriptoren', () => {
  it('hat eindeutige IDs und deckt alle Intervalle ab', () => {
    const ids = COCKPIT_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const intervals = new Set(COCKPIT_SOURCES.map((s) => s.interval));
    expect(intervals).toEqual(new Set(['daily', 'weekly', 'monthly', 'yearly']));
  });

  it('detectGaps nur bei täglichen, prüfbaren Quellen', () => {
    for (const s of COCKPIT_SOURCES) {
      if (s.detectGaps) {
        expect(s.interval).toBe('daily');
        expect(s.checkable).toBe(true);
      }
    }
  });

  it('jede Quelle hat gültige Kategorie, Import-Art und uploadLabel', () => {
    const categories = new Set<CockpitCategory>(CATEGORY_ORDER);
    const types = new Set<CockpitImportType>(IMPORT_TYPE_ORDER);
    for (const s of COCKPIT_SOURCES) {
      expect(categories.has(s.category)).toBe(true);
      expect(types.has(s.importType)).toBe(true);
      expect(s.uploadLabel.trim().length).toBeGreaterThan(0);
    }
  });

  it('Datei-Upload-Quellen tragen Quelle und Beispiel-Format', () => {
    const fileUploads = COCKPIT_SOURCES.filter((s) => s.importType === 'file_upload');
    expect(fileUploads.length).toBeGreaterThan(0);
    for (const s of fileUploads) {
      expect(s.sourceHint && s.sourceHint.trim().length).toBeTruthy();
      expect(s.exampleFormat && s.exampleFormat.trim().length).toBeTruthy();
    }
  });

  it('Label-Maps decken alle Kategorien und Import-Arten ab', () => {
    for (const c of CATEGORY_ORDER) expect(CATEGORY_LABEL[c].trim().length).toBeGreaterThan(0);
    for (const t of IMPORT_TYPE_ORDER) expect(IMPORT_TYPE_LABEL[t].trim().length).toBeGreaterThan(0);
    // Bestehende Status-Labels unverändert
    expect(STATUS_LABEL.uncheckable).toBe('Nicht prüfbar');
    expect(STATUS_LABEL.never).toBe('Nie importiert');
  });
});

// ─── Filter (rein) ───────────────────────────────────────────────────────────────

function rowFromSource(def: CockpitSourceDef, status: CockpitStatus): CockpitRow {
  const result: CockpitStatusResult = {
    status,
    reason: '',
    nextDue: null,
    daysBehind: null,
    missingDays: [],
    failed: false,
  };
  return { def, signal: { latestDataDate: null }, result };
}

describe('rowMatchesFilters + matchesCockpitSearch', () => {
  const source = COCKPIT_SOURCES[0];
  const base = rowFromSource(source, 'current');

  it('leerer Filter lässt alles durch', () => {
    for (const s of COCKPIT_SOURCES) {
      expect(rowMatchesFilters(rowFromSource(s, 'current'), EMPTY_COCKPIT_FILTER)).toBe(true);
    }
  });

  it('filtert nach Kategorie', () => {
    const f: CockpitFilterState = { ...EMPTY_COCKPIT_FILTER, category: source.category };
    expect(rowMatchesFilters(base, f)).toBe(true);
    const other = CATEGORY_ORDER.find((c) => c !== source.category)!;
    expect(rowMatchesFilters(base, { ...EMPTY_COCKPIT_FILTER, category: other })).toBe(false);
  });

  it('filtert nach Import-Art', () => {
    const f: CockpitFilterState = { ...EMPTY_COCKPIT_FILTER, importType: source.importType };
    expect(rowMatchesFilters(base, f)).toBe(true);
    const other = IMPORT_TYPE_ORDER.find((t) => t !== source.importType)!;
    expect(rowMatchesFilters(base, { ...EMPTY_COCKPIT_FILTER, importType: other })).toBe(false);
  });

  it('filtert nach Intervall und Status (UND-Verknüpfung)', () => {
    const f: CockpitFilterState = {
      ...EMPTY_COCKPIT_FILTER,
      interval: source.interval,
      status: 'current',
    };
    expect(rowMatchesFilters(base, f)).toBe(true);
    // Status passt nicht mehr → raus, obwohl Intervall stimmt
    expect(rowMatchesFilters(base, { ...f, status: 'overdue' })).toBe(false);
  });

  it('Suche trifft Name, Bereich, Aufgabe und uploadLabel', () => {
    expect(matchesCockpitSearch(source, '')).toBe(true);
    expect(matchesCockpitSearch(source, source.label.slice(0, 4).toLowerCase())).toBe(true);
    expect(matchesCockpitSearch(source, 'zzz-kein-treffer-xyz')).toBe(false);
  });
});
