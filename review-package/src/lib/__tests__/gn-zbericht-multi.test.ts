// @vitest-environment node
/**
 * Tests: Gastronovi Z-Bericht Multi-Datei-Import (Batch)
 * ======================================================
 * Deckt die reine Klassifizierungs- und Konflikt-Logik ab (keine DB):
 *   - eine einzelne Datei
 *   - mehrere valide Tagesdateien
 *   - gemischte valide + fehlerhafte Dateien
 *   - Datei mit Zeitraum statt Einzeltag (Mehrtagesbericht → Warnung, nie auto-split)
 *   - Duplikat innerhalb des Batches (gleicher Tag/Kostenstelle)
 *   - planBatchImport: Überspringen, Ersetzen, Abbruch bei Fehlern
 *
 * Hinweis zu Beträgen: `parseSwissNumber` liefert für mit "CHF" präfixierte Zellen 0
 * (parseFloat scheitert am Präfix). Die Fixtures verwenden daher reine Zahlen, damit
 * die Aggregations-Assertions deterministisch sind. Das ist ein reiner Parser-Aspekt
 * und unabhängig von der hier getesteten Batch-Logik.
 */
import { describe, it, expect } from 'vitest';
import {
  parseZBerichtBatch,
  planBatchImport,
  MULTI_DAY_WARNING,
} from '@/lib/gn-zbericht-multi';
import type { OverlapInfo } from '@/lib/gn-zbericht-db';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Valider Einzel-Tagesbericht (periodFrom === periodTo). */
function dayCsv(opts: { date: string; cc?: string; z?: string; gross?: number }): string {
  const { date, cc = 'Restaurant Oliv', z = '100', gross = 5000 } = opts;
  return [
    `Z-Bericht;${cc}`,
    `Kostenstelle;${cc}`,
    `Von;${date}, 10:00`,
    `Bis;${date}, 23:59`,
    `Z-Zähler;${z}`,
    'Umsatz',
    `Gesamtumsatz inkl. Trinkgeld;${gross.toFixed(2)}`,
    'Hauptwarengruppe;Anzahl;Betrag',
    'Getränke;50;2000.00',
  ].join('\n');
}

/** Mehrtagesbericht (Zeitraum, periodFrom !== periodTo). */
function periodCsv(from: string, to: string): string {
  return [
    'Z-Bericht;Restaurant Oliv',
    'Kostenstelle;Restaurant Oliv',
    `Von;${from}, 10:00`,
    `Bis;${to}, 23:59`,
    'Z-Zähler;200',
    'Umsatz',
    'Gesamtumsatz inkl. Trinkgeld;35000.00',
  ].join('\n');
}

/** Unbrauchbarer Inhalt: kein Datum, kein Umsatz → Fehler. */
const garbageCsv = 'Hallo Welt;keine Daten\nNur Text;ohne Zahlen';

const overlap = (id: string): OverlapInfo => ({
  id,
  file_name: 'alt.csv',
  period_from: '2026-06-01',
  period_to: '2026-06-01',
  z_counter: '99',
  gross_revenue: 1000,
  import_type: 'daily',
});

// ── Parsing & Klassifizierung ─────────────────────────────────────────────────

describe('parseZBerichtBatch — Klassifizierung', () => {
  it('eine einzelne valide Datei → 1 Tagesbericht, kein Fehler', () => {
    const r = parseZBerichtBatch([{ name: 'a.csv', text: dayCsv({ date: '01.06.2026' }) }]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].status).toBe('ok');
    expect(r.files[0].isMultiDay).toBe(false);
    expect(r.files[0].periodFrom).toBe('2026-06-01');
    expect(r.files[0].importKindLabel).toBe('Tagesimport');
    expect(r.aggregate.fileCount).toBe(1);
    expect(r.aggregate.dailyReportCount).toBe(1);
    expect(r.aggregate.errorCount).toBe(0);
    expect(r.aggregate.totalGross).toBeCloseTo(5000, 2);
  });

  it('mehrere valide Tagesdateien → Summen + Tag von/bis korrekt', () => {
    const r = parseZBerichtBatch([
      { name: 'd1.csv', text: dayCsv({ date: '01.06.2026', z: '1', gross: 1000 }) },
      { name: 'd2.csv', text: dayCsv({ date: '02.06.2026', z: '2', gross: 2000 }) },
      { name: 'd3.csv', text: dayCsv({ date: '03.06.2026', z: '3', gross: 3000 }) },
    ]);
    expect(r.aggregate.dailyReportCount).toBe(3);
    expect(r.aggregate.errorCount).toBe(0);
    expect(r.aggregate.dayFrom).toBe('2026-06-01');
    expect(r.aggregate.dayTo).toBe('2026-06-03');
    expect(r.aggregate.totalGross).toBeCloseTo(6000, 2);
    expect(r.files.every(f => f.status === 'ok')).toBe(true);
  });

  it('gemischt valide + fehlerhaft → Fehler blockiert nicht die valide Datei', () => {
    const r = parseZBerichtBatch([
      { name: 'gut.csv', text: dayCsv({ date: '01.06.2026' }) },
      { name: 'kaputt.csv', text: garbageCsv },
    ]);
    expect(r.aggregate.fileCount).toBe(2);
    expect(r.aggregate.okCount).toBe(1);
    expect(r.aggregate.errorCount).toBe(1);
    expect(r.aggregate.dailyReportCount).toBe(1);
    const bad = r.files.find(f => f.fileName === 'kaputt.csv')!;
    expect(bad.status).toBe('error');
    expect(bad.errorReason).toBeTruthy();
  });

  it('Datei mit Zeitraum statt Einzeltag → Warnung, kein Tagesbericht, nie auto-split', () => {
    const r = parseZBerichtBatch([
      { name: 'zeitraum.csv', text: periodCsv('01.06.2026', '07.06.2026') },
    ]);
    const f = r.files[0];
    expect(f.status).toBe('warning');
    expect(f.isMultiDay).toBe(true);
    expect(f.periodFrom).toBe('2026-06-01');
    expect(f.periodTo).toBe('2026-06-07');
    expect(f.warnings).toContain(MULTI_DAY_WARNING);
    expect(f.importKindLabel).not.toBe('Tagesimport');
    expect(r.aggregate.periodReportCount).toBe(1);
    expect(r.aggregate.dailyReportCount).toBe(0);
  });

  it('Duplikat im Batch (gleicher Tag + Kostenstelle) → beide markiert', () => {
    const r = parseZBerichtBatch([
      { name: 'a.csv', text: dayCsv({ date: '01.06.2026', z: '1' }) },
      { name: 'b.csv', text: dayCsv({ date: '01.06.2026', z: '2' }) },
    ]);
    expect(r.files.every(f => f.duplicateInBatch)).toBe(true);
    expect(r.files.every(f => f.status === 'warning')).toBe(true);
  });

  it('gleicher Tag, ABER andere Kostenstelle → kein Duplikat', () => {
    const r = parseZBerichtBatch([
      { name: 'a.csv', text: dayCsv({ date: '01.06.2026', cc: 'Restaurant Oliv' }) },
      { name: 'b.csv', text: dayCsv({ date: '01.06.2026', cc: 'Restaurant Beaulieu' }) },
    ]);
    expect(r.files.some(f => f.duplicateInBatch)).toBe(false);
  });
});

// ── Importplanung (Konfliktauflösung) ─────────────────────────────────────────

describe('planBatchImport — Konfliktauflösung', () => {
  const validBatch = () =>
    parseZBerichtBatch([
      { name: 'd1.csv', text: dayCsv({ date: '01.06.2026', z: '1' }) },
      { name: 'd2.csv', text: dayCsv({ date: '02.06.2026', z: '2' }) },
    ]).files;

  it('ohne Konflikte → alle als Neuimport', () => {
    const plan = planBatchImport(validBatch(), {}, { conflictAction: 'replace', errorPolicy: 'only_valid' });
    expect(plan.canProceed).toBe(true);
    expect(plan.importCount).toBe(2);
    expect(plan.plans.every(p => p.action === 'import')).toBe(true);
  });

  it('bestehende Daten + skip → konfliktbehaftete Datei wird übersprungen', () => {
    const files = validBatch();
    const overlaps = { [files[0].id]: [overlap('x1')] };
    const plan = planBatchImport(files, overlaps, { conflictAction: 'skip', errorPolicy: 'only_valid' });
    const p1 = plan.plans.find(p => p.id === files[0].id)!;
    const p2 = plan.plans.find(p => p.id === files[1].id)!;
    expect(p1.action).toBe('skip');
    expect(p2.action).toBe('import');
    expect(plan.importCount).toBe(1);
    expect(plan.canProceed).toBe(true);
  });

  it('bestehende Daten + replace → Datei ersetzt mit overlapIds', () => {
    const files = validBatch();
    const overlaps = { [files[0].id]: [overlap('x1'), overlap('x2')] };
    const plan = planBatchImport(files, overlaps, { conflictAction: 'replace', errorPolicy: 'only_valid' });
    const p1 = plan.plans.find(p => p.id === files[0].id)!;
    expect(p1.action).toBe('replace');
    expect(p1.overlapIds).toEqual(['x1', 'x2']);
    expect(plan.importCount).toBe(2);
  });

  it('bestehende Daten + abort → kompletter Abbruch', () => {
    const files = validBatch();
    const overlaps = { [files[0].id]: [overlap('x1')] };
    const plan = planBatchImport(files, overlaps, { conflictAction: 'abort', errorPolicy: 'only_valid' });
    expect(plan.canProceed).toBe(false);
    expect(plan.abortReason).toBeTruthy();
    expect(plan.importCount).toBe(0);
  });

  it('Überschneidungen werden je Batch-ID (nicht Dateiname) zugeordnet — gleiche Dateinamen kollidieren nicht', () => {
    // Zwei Dateien mit IDENTISCHEM Dateinamen, aber verschiedenen Tagen.
    // Nur die erste (per Batch-ID) hat einen DB-Konflikt.
    const files = parseZBerichtBatch([
      { name: 'z-bericht.csv', text: dayCsv({ date: '01.06.2026', z: '1' }) },
      { name: 'z-bericht.csv', text: dayCsv({ date: '02.06.2026', z: '2' }) },
    ]).files;
    expect(files[0].id).not.toBe(files[1].id);
    const overlaps = { [files[0].id]: [overlap('x1')] };
    const plan = planBatchImport(files, overlaps, { conflictAction: 'replace', errorPolicy: 'only_valid' });
    const p1 = plan.plans.find(p => p.id === files[0].id)!;
    const p2 = plan.plans.find(p => p.id === files[1].id)!;
    expect(p1.action).toBe('replace');
    expect(p1.overlapIds).toEqual(['x1']);
    expect(p2.action).toBe('import');
    expect(p2.overlapIds).toEqual([]);
  });

  it('errorPolicy abort_on_error + fehlerhafte Datei → kompletter Abbruch', () => {
    const files = parseZBerichtBatch([
      { name: 'gut.csv', text: dayCsv({ date: '01.06.2026' }) },
      { name: 'kaputt.csv', text: garbageCsv },
    ]).files;
    const plan = planBatchImport(files, {}, { conflictAction: 'replace', errorPolicy: 'abort_on_error' });
    expect(plan.canProceed).toBe(false);
    expect(plan.importCount).toBe(0);
  });

  it('errorPolicy only_valid + fehlerhafte Datei → valide Datei wird importiert', () => {
    const files = parseZBerichtBatch([
      { name: 'gut.csv', text: dayCsv({ date: '01.06.2026' }) },
      { name: 'kaputt.csv', text: garbageCsv },
    ]).files;
    const plan = planBatchImport(files, {}, { conflictAction: 'replace', errorPolicy: 'only_valid' });
    expect(plan.canProceed).toBe(true);
    expect(plan.importCount).toBe(1);
    const good = plan.plans.find(p => p.fileName === 'gut.csv')!;
    const bad = plan.plans.find(p => p.fileName === 'kaputt.csv')!;
    expect(good.action).toBe('import');
    expect(bad.action).toBe('skip');
  });

  it('Intra-Batch-Duplikat → nur die erste Datei wird importiert', () => {
    const files = parseZBerichtBatch([
      { name: 'a.csv', text: dayCsv({ date: '01.06.2026', z: '1' }) },
      { name: 'b.csv', text: dayCsv({ date: '01.06.2026', z: '2' }) },
    ]).files;
    const plan = planBatchImport(files, {}, { conflictAction: 'replace', errorPolicy: 'only_valid' });
    const a = plan.plans.find(p => p.fileName === 'a.csv')!;
    const b = plan.plans.find(p => p.fileName === 'b.csv')!;
    expect(a.action).toBe('import');
    expect(b.action).toBe('skip');
    expect(plan.importCount).toBe(1);
  });
});
