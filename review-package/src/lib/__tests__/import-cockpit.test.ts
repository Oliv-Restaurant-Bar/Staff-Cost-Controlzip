// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  computeSourceStatus,
  deriveMirusPeriodFromHistory,
  deriveMirusPeriodEndFromDays,
  findMissingDays,
  lastGaplessDay,
  summarizeCockpit,
  groupChecklist,
  checklistStateFromStatus,
  normalizeDataDate,
  formatCockpitDate,
  umsatzabstimmungMonthsFromBlob,
  buchhaltungsExportOverride,
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

describe('lastGaplessDay', () => {
  it('bricht beim ersten fehlenden Tag ab ([01,02,03,05] → 03)', () => {
    expect(lastGaplessDay(['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-05'], '2026-07-06')).toBe('2026-07-03');
  });

  it('lückenlose Reihe → letzter Tag', () => {
    expect(lastGaplessDay(['2026-07-04', '2026-07-05', '2026-07-06'], '2026-07-06')).toBe('2026-07-06');
  });

  it('ignoriert zukünftige Tage (> today)', () => {
    // 07.07 und 12.12 liegen nach today (06.07) → für Vollständigkeit irrelevant.
    expect(lastGaplessDay(['2026-07-05', '2026-07-06', '2026-07-07', '2026-12-12'], '2026-07-06')).toBe('2026-07-06');
  });

  it('nur zukünftige Tage → null', () => {
    expect(lastGaplessDay(['2026-12-04', '2026-12-24'], '2026-07-06')).toBeNull();
  });

  it('leere Liste → null', () => {
    expect(lastGaplessDay([], '2026-07-06')).toBeNull();
  });
});

describe('computeSourceStatus — Zukunft & Vollständigkeit (Mirus-Fix)', () => {
  const dailyGap = () => def({ interval: 'daily', checkable: true, detectGaps: true });

  it('zukünftiges MAX-Datum wird nicht als „Ist-Daten bis" gewertet (auf heute begrenzt)', () => {
    // Simuliert eine durchgerutschte Zukunftszeile (z. B. 24.12.2026).
    const r = computeSourceStatus(dailyGap(), sig({ latestDataDate: '2026-12-24' }), NOW);
    expect(r.latestDataDate).toBe('2026-07-06'); // gekappt auf heute, NIE 24.12.
    expect(r.ignoredFutureDate).toBe('2026-12-24');
    expect(r.status).not.toBe('overdue'); // Zukunft macht die Quelle nicht rot
  });

  it('übernimmt den Zukunftshinweis (futureDataDate) aus dem Signal in den Status', () => {
    const covered = ['2026-07-04', '2026-07-05', '2026-07-06'];
    const r = computeSourceStatus(
      dailyGap(),
      sig({ latestDataDate: '2026-07-06', coveredDates: covered, futureDataDate: '2026-12-04' }),
      NOW,
    );
    expect(r.ignoredFutureDate).toBe('2026-12-04');
    expect(r.status).toBe('current');
    expect(r.completeUntil).toBe('2026-07-06');
  });

  it('Zukunftshinweis nur für detectGaps-Quellen (nicht für zukunftsdatierte Quellen wie Dienstplan)', () => {
    const r = computeSourceStatus(
      def({ interval: 'daily', checkable: true, detectGaps: false }),
      sig({ latestDataDate: '2026-07-06', futureDataDate: '2026-12-04' }),
      NOW,
    );
    expect(r.ignoredFutureDate).toBeNull();
  });

  it('fehlender Tag unterbricht die Vollständigkeit (completeUntil < letztes Datum)', () => {
    const covered = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-05', '2026-07-06'];
    const r = computeSourceStatus(dailyGap(), sig({ latestDataDate: '2026-07-06', coveredDates: covered }), NOW);
    expect(r.completeUntil).toBe('2026-07-03'); // 04.07 fehlt → vollständig nur bis 03.07
    expect(r.latestDataDate).toBe('2026-07-06'); // letzter gefundener Ist-Tag bleibt 06.07
  });

  it('Status wird bei Datenlücke gelb (due_soon) statt grün', () => {
    const covered = ['2026-07-03', '2026-07-04', '2026-07-06']; // 05.07 fehlt
    const r = computeSourceStatus(dailyGap(), sig({ latestDataDate: '2026-07-06', coveredDates: covered }), NOW);
    expect(r.status).toBe('due_soon');
    expect(r.missingDays).toEqual(['2026-07-05']);
  });

  it('Status wird bei Datenlücke rot (overdue), wenn der Datenstand zusätzlich alt ist', () => {
    // Letzter Ist-Tag 30.06 (überfällig) + innere Lücke → bleibt overdue.
    const covered = ['2026-06-27', '2026-06-28', '2026-06-30'];
    const r = computeSourceStatus(dailyGap(), sig({ latestDataDate: '2026-06-30', coveredDates: covered }), NOW);
    expect(r.status).toBe('overdue');
    expect(r.missingDays).toEqual(['2026-06-29']);
  });

  it('ohne echte Ist-Daten (kein Datum) → never (Zukunftshinweis bleibt im Drawer)', () => {
    // DB liefert nur einen Zukunftshinweis, aber keinen echten Ist-Tag.
    const r = computeSourceStatus(dailyGap(), sig({ latestDataDate: null, futureDataDate: '2026-12-24' }), NOW);
    expect(r.status).toBe('never');
    expect(r.ignoredFutureDate).toBe('2026-12-24');
  });
});

describe('deriveMirusPeriodFromHistory (Perioden-Ableitung aus Import-Historie)', () => {
  it('nimmt den am weitesten fortgeschrittenen importierten Monat → Perioden-Ende = Monatsende', () => {
    const p = deriveMirusPeriodFromHistory([
      { year: 2026, month: 5, fileName: 'mai.xls', importedAt: '2026-06-02T09:00:00Z', importedCount: 30 },
      { year: 2026, month: 6, fileName: 'juni.xls', importedAt: '2026-07-02T09:00:00Z', importedCount: 42 },
    ]);
    expect(p).not.toBeNull();
    expect(p!.periodFrom).toBe('2026-06-01');
    expect(p!.periodTo).toBe('2026-06-30');
    expect(p!.fileName).toBe('juni.xls');
    expect(p!.importedAt).toBe('2026-07-02T09:00:00Z');
  });

  it('ignoriert Nicht-Mirus-Quellen und leere Läufe (importedCount 0)', () => {
    const p = deriveMirusPeriodFromHistory([
      { year: 2026, month: 7, source: 'reservationen', importedAt: '2026-07-05T09:00:00Z', importedCount: 99 },
      { year: 2026, month: 7, source: 'mirus', importedAt: '2026-07-05T10:00:00Z', importedCount: 0 },
      { year: 2026, month: 6, source: 'mirus', importedAt: '2026-07-02T09:00:00Z', importedCount: 42 },
    ]);
    expect(p!.periodTo).toBe('2026-06-30'); // Juli-Läufe zählen nicht (fremd bzw. leer)
  });

  it('behandelt importedCount null als verwertbar (ältere Zeilen)', () => {
    const p = deriveMirusPeriodFromHistory([
      { year: 2026, month: 6, importedAt: '2026-07-02T09:00:00Z', importedCount: null },
    ]);
    expect(p!.periodTo).toBe('2026-06-30');
  });

  it('bei gleichem Monat gewinnt der jüngste Import (Tie-Break)', () => {
    const p = deriveMirusPeriodFromHistory([
      { year: 2026, month: 6, fileName: 'alt.xls', importedAt: '2026-07-02T09:00:00Z', importedCount: 40 },
      { year: 2026, month: 6, fileName: 'korrektur.xls', importedAt: '2026-07-04T09:00:00Z', importedCount: 42 },
    ]);
    expect(p!.fileName).toBe('korrektur.xls');
  });

  it('leere/ausschliesslich unverwertbare Historie → null', () => {
    expect(deriveMirusPeriodFromHistory([])).toBeNull();
    expect(
      deriveMirusPeriodFromHistory([{ year: 2026, month: 6, source: 'mirus', importedCount: 0 }]),
    ).toBeNull();
  });

  it('Teil-Import des laufenden Monats → periodTo ist das (künftige) Monatsende; Kappen ist Aufgabe des Aggregators', () => {
    const p = deriveMirusPeriodFromHistory([
      { year: 2026, month: 7, source: 'mirus', importedAt: '2026-07-05T09:00:00Z', importedCount: 20 },
    ]);
    expect(p!.periodFrom).toBe('2026-07-01');
    expect(p!.periodTo).toBe('2026-07-31'); // roh = Monatsende; mirusSignal kappt auf heute
  });
});

describe('deriveMirusPeriodEndFromDays (Fallback ohne Historie)', () => {
  it('nimmt das Monatsende des letzten Monats VOR dem laufenden Monat — verirrte Tage im Juli zählen nicht', () => {
    const end = deriveMirusPeriodEndFromDays(
      ['2026-06-28', '2026-06-29', '2026-06-30', '2026-07-04'],
      '2026-07-06',
    );
    expect(end).toBe('2026-06-30'); // 04.07 (laufender Monat) wird ausgeschlossen
  });

  it('nur Tage im laufenden Monat → null (keine vollständige Periode)', () => {
    expect(deriveMirusPeriodEndFromDays(['2026-07-01', '2026-07-04'], '2026-07-06')).toBeNull();
  });

  it('leere Liste → null', () => {
    expect(deriveMirusPeriodEndFromDays([], '2026-07-06')).toBeNull();
  });
});

describe('computeSourceStatus — Mirus periodenbasiert (detectGaps=false)', () => {
  const mirus = () => def({ interval: 'daily', checkable: true, detectGaps: false });

  it('zeigt das Perioden-Ende (30.06), NICHT den verirrten Tagesdatensatz (04.07)', () => {
    const r = computeSourceStatus(
      mirus(),
      sig({
        latestDataDate: '2026-06-30',
        dataUntil: '2026-06-30',
        dataFrom: '2026-06-01',
        latestRecordDate: '2026-07-04',
        lastImport: { at: '2026-07-02T09:00:00Z', status: 'success' },
      }),
      NOW,
    );
    expect(r.latestDataDate).toBe('2026-06-30'); // niemals 04.07
    expect(r.status).toBe('overdue'); // 6 Tage hinter (täglich) → niemals „aktuell"
    expect(r.status).not.toBe('current');
  });

  it('ohne ableitbare Periode (kein Datum) → never', () => {
    const r = computeSourceStatus(mirus(), sig({ latestDataDate: null, latestRecordDate: '2026-07-04' }), NOW);
    expect(r.status).toBe('never');
  });

  it('Teil-Import laufender Monat (vom Aggregator auf heute gekappt) → nie Zukunftsdatum', () => {
    // mirusSignal kappt periodTo=31.07 auf heute und meldet 31.07 als Zukunftshinweis.
    const r = computeSourceStatus(
      mirus(),
      sig({
        latestDataDate: '2026-07-06',
        dataUntil: '2026-07-06',
        dataFrom: '2026-07-01',
        futureDataDate: '2026-07-31',
      }),
      NOW,
    );
    expect(r.latestDataDate).toBe('2026-07-06'); // niemals 31.07
    expect(r.status).toBe('current');
  });
});

describe('COCKPIT_SOURCES — Mirus ist periodenbasiert', () => {
  it('Mirus-Quelle hat detectGaps deaktiviert (keine Tages-Lückenprüfung)', () => {
    const mirusDef = COCKPIT_SOURCES.find((s) => s.id === 'mirus');
    expect(mirusDef).toBeDefined();
    expect(mirusDef!.detectGaps).toBe(false);
    expect(mirusDef!.checkable).toBe(true);
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
      completeUntil: null,
      ignoredFutureDate: null,
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
    completeUntil: null,
    ignoredFutureDate: null,
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

// ─── Umsatzabstimmung (manuelle Monats-Erfassung, reporting_v1-Blob) ────────────

describe('umsatzabstimmungMonthsFromBlob', () => {
  it('liefert Monate mit manuellem Bruttoumsatz ODER Take-Away (> 0), sortiert', () => {
    const months = umsatzabstimmungMonthsFromBlob({
      '2026-05': { grossRevenueManual: 120_000 },
      '2026-03': { takeAwayGrossManual: 4_500 },
      '2026-04': { grossRevenueManual: 98_000, takeAwayGrossManual: 3_000 },
    });
    expect(months).toEqual(['2026-03', '2026-04', '2026-05']);
  });

  it('ignoriert Monate ohne manuelle Werte, 0-Werte und Nicht-Monats-Schlüssel', () => {
    expect(
      umsatzabstimmungMonthsFromBlob({
        '2026-01': {}, // keine manuellen Werte → nicht gepflegt
        '2026-02': { grossRevenueManual: 0, takeAwayGrossManual: 0 }, // 0 zählt nicht
        '2026-06': { grossRevenueManual: 50_000 },
        'meta': { grossRevenueManual: 999 } as never, // kein 'yyyy-MM'-Schlüssel
        '2026-07-01': { grossRevenueManual: 1 } as never, // Tag, kein Monat
      }),
    ).toEqual(['2026-06']);
  });

  it('leerer/fehlender Blob → keine Monate (Status never, nie erfinden)', () => {
    expect(umsatzabstimmungMonthsFromBlob({})).toEqual([]);
    expect(umsatzabstimmungMonthsFromBlob(null)).toEqual([]);
    expect(umsatzabstimmungMonthsFromBlob(undefined)).toEqual([]);
  });

  it('gepflegter Monat als latestDataDate ergibt einen monatlichen Frische-Status', () => {
    // Signal wie im Aggregator: letzter gepflegter Monat 'yyyy-MM' (Juni), heute 06.07.2026
    const r = computeSourceStatus(def({ interval: 'monthly' }), { latestDataDate: '2026-06' }, NOW);
    expect(r.latestDataDate).toBe('2026-06');
    expect(['current', 'due_soon', 'overdue']).toContain(r.status);
    expect(r.status).not.toBe('never');
  });

  it('ohne gepflegte Monate (leeres Signal) → never', () => {
    const r = computeSourceStatus(def({ interval: 'monthly' }), { latestDataDate: null }, NOW);
    expect(r.status).toBe('never');
  });
});

// ── Buchhaltungs-Export-Kontrollaufgabe (§11) ────────────────────────────────

describe('Buchhaltungs-Export-Kontrollaufgabe', () => {
  it('COCKPIT_SOURCES enthält die Kontrollaufgabe mit Route zum Export-Assistenten', () => {
    const d = COCKPIT_SOURCES.find((s) => s.id === 'buchhaltungs_export');
    expect(d).toBeTruthy();
    expect(d!.section).toBe('control');
    expect(d!.importType).toBe('control');
    expect(d!.interval).toBe('monthly');
    expect(d!.route).toBe('/tagesabschluesse');
    expect(d!.checkable).toBe(true);
  });

  it('buchhaltungsExportOverride bildet die 4 Fachstatus auf Cockpit-Status ab', () => {
    expect(buchhaltungsExportOverride('exportiert', '2026-06', 2)).toEqual({
      status: 'current',
      reason: 'Buchhaltungs-Export 2026-06 aktuell (Export 2).',
    });
    expect(buchhaltungsExportOverride('veraltet', '2026-06', 1).status).toBe('overdue');
    expect(buchhaltungsExportOverride('veraltet', '2026-06', 1).reason).toContain(
      'nach dem letzten Export geändert',
    );
    expect(buchhaltungsExportOverride('bereit', '2026-06', null).status).toBe('due_soon');
    expect(buchhaltungsExportOverride('offen', '2026-06', null).status).toBe('due_soon');
  });

  it('computeSourceStatus respektiert den statusOverride (gewinnt über Frische)', () => {
    // Monat weit in der Vergangenheit — Frische-Logik würde overdue sagen,
    // Override "current" gewinnt trotzdem (Export ist aktuell).
    const r = computeSourceStatus(
      def({ interval: 'monthly' }),
      {
        latestDataDate: '2025-01',
        statusOverride: { status: 'current', reason: 'Buchhaltungs-Export 2025-01 aktuell (Export 1).' },
      },
      NOW,
    );
    expect(r.status).toBe('current');
    expect(r.reason).toBe('Buchhaltungs-Export 2025-01 aktuell (Export 1).');
    expect(r.latestDataDate).toBe('2025-01');
    expect(r.failed).toBe(false);

    // veraltet → overdue, unabhängig vom Datum.
    const r2 = computeSourceStatus(
      def({ interval: 'monthly' }),
      {
        latestDataDate: '2026-07',
        statusOverride: { status: 'overdue', reason: 'Der Monat 2026-07 wurde nach dem letzten Export geändert. Bitte neuen Export erstellen.' },
      },
      NOW,
    );
    expect(r2.status).toBe('overdue');
    expect(checklistStateFromStatus(r2.status)).toBe('overdue');
  });

  it('leeres Signal ohne Override bleibt never (nie Zeitstempel erfinden)', () => {
    const r = computeSourceStatus(def({ interval: 'monthly' }), { latestDataDate: null }, NOW);
    expect(r.status).toBe('never');
  });
});
