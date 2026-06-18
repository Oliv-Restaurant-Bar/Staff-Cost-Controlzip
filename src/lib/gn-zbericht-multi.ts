/**
 * Gastronovi Z-Bericht — Multi-Datei-Import (Batch)
 *
 * Reine, DB-freie Logik für den gleichzeitigen Import mehrerer einzelner
 * Tages-Z-Berichte.  Jede Datei wird separat geparst, klassifiziert und
 * zusammengefasst.  Kumulierte Zeitraum-Berichte werden NICHT automatisch auf
 * Tage verteilt — sie werden erkannt, klar markiert und nur mit Warnung
 * importiert.
 *
 * Dieses Modul enthält bewusst KEINE Supabase-Aufrufe, damit die gesamte
 * Klassifizierungs- und Konflikt-Logik unit-testbar ist.  Die eigentlichen
 * Schreibvorgänge liegen in `gn-zbericht-db.ts`.
 */

import { parseGnZBericht, type GnParsedZBericht } from './gn-zbericht-parser';
// Nur Typ-Import: zieht zur Laufzeit NICHT den Supabase-Client herein, damit
// dieses Modul rein und ohne DB-Abhängigkeit unit-testbar bleibt.
import type { OverlapInfo } from './gn-zbericht-db';

// ── Konstanten ───────────────────────────────────────────────────────────────

/** Warnung für Berichte, die mehrere Tage umfassen (kein Tagesbericht). */
export const MULTI_DAY_WARNING =
  'Dieser Bericht umfasst mehrere Tage und wird nicht als Tagesbericht behandelt.';

/** Warnung wenn dieselbe Datei (Tag/Kostenstelle) mehrfach im Batch liegt. */
export const DUPLICATE_IN_BATCH_WARNING =
  'Mehrere Dateien betreffen denselben Tag und dieselbe Kostenstelle.';

/** Warnung wenn kein Zeitraum erkannt wurde. */
export const NO_PERIOD_WARNING =
  'Kein Zeitraum erkannt — die Datei kann nicht als Tagesbericht gespeichert werden.';

// ── Typen ────────────────────────────────────────────────────────────────────

export type BatchFileStatus = 'ok' | 'warning' | 'error';

export interface BatchFileInput {
  name: string;
  text: string;
}

/** Klassifiziertes Ergebnis pro Datei. */
export interface BatchFileResult {
  /** Stabile, eindeutige Batch-ID (Index-basiert) — robust gegen gleiche Dateinamen. */
  id: string;
  fileName: string;
  status: BatchFileStatus;
  /** Geparstes Resultat — null nur bei hartem Parse-Fehler. */
  parsed: GnParsedZBericht | null;
  /** Grund bei status === 'error'. */
  errorReason: string | null;
  warnings: string[];

  // Abgeleitete Kennzahlen (null bei Fehler)
  periodFrom: string | null;
  periodTo: string | null;
  isMultiDay: boolean;
  /** 'Tagesimport' | 'Wochenimport' | 'Monatsimport' | 'Zeitraumimport' */
  importKindLabel: string;
  costCenter: string | null;
  zCounter: string | null;
  grossRevenue: number | null;
  netRevenue: number | null;
  foodRevenue: number | null;
  bevRevenue: number | null;

  /** Eindeutiger Tagesschlüssel (periodFrom|kostenstelle) — null wenn kein Tag. */
  dailyKey: string | null;
  /** Eine andere Datei im selben Batch betrifft denselben Tagesschlüssel. */
  duplicateInBatch: boolean;
}

export interface BatchAggregate {
  fileCount: number;
  okCount: number;
  warningCount: number;
  errorCount: number;
  /** Erkannte Einzel-Tagesberichte (verwertbar als Tagesimport). */
  dailyReportCount: number;
  /** Erkannte Zeitraum-/Mehrtagesberichte. */
  periodReportCount: number;
  /** Frühestes erkanntes Datum (ISO) oder null. */
  dayFrom: string | null;
  /** Spätestes erkanntes Datum (ISO) oder null. */
  dayTo: string | null;
  totalGross: number;
  totalNet: number;
  totalFood: number;
  totalBev: number;
}

export interface BatchParseResult {
  files: BatchFileResult[];
  aggregate: BatchAggregate;
}

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

function normCostCenter(cc: string | null | undefined): string {
  return (cc || '').trim().toLowerCase();
}

/** Tagesschlüssel für Duplikat-Erkennung: nur für echte Einzeltage. */
function makeDailyKey(periodFrom: string | null, costCenter: string | null): string | null {
  if (!periodFrom) return null;
  return `${periodFrom}|${normCostCenter(costCenter)}`;
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Wurde überhaupt ein Z-Bericht erkannt (Datum ODER Bruttoumsatz)? */
function isRecognized(p: GnParsedZBericht): boolean {
  return !!p.periodFrom || num(p.revenue?.totalGross) > 0;
}

/**
 * Reines Deutsch-Label für die Importart (ohne DB-Abhängigkeit).
 * Entspricht `detectImportType` + `importTypeLabel` aus `gn-zbericht-db.ts`.
 */
function importKindLabelFor(periodFrom: string | null, periodTo: string | null): string {
  if (!periodFrom || !periodTo) return 'Zeitraumimport';
  const ms = new Date(periodTo).getTime() - new Date(periodFrom).getTime();
  const days = Math.round(ms / (1000 * 60 * 60 * 24)) + 1;
  if (days <= 1) return 'Tagesimport';
  if (days <= 7) return 'Wochenimport';
  if (days >= 28 && days <= 32) return 'Monatsimport';
  return 'Zeitraumimport';
}

// ── Batch parsen + klassifizieren ────────────────────────────────────────────

/**
 * Parst und klassifiziert alle Dateien eines Batches.  Reine Funktion ohne
 * Seiteneffekte: gleiche Eingabe → gleiches Ergebnis.
 */
export function parseZBerichtBatch(files: BatchFileInput[]): BatchParseResult {
  const results: BatchFileResult[] = files.map((f, i) => classifyFile(f, String(i)));

  // Intra-Batch-Duplikate markieren (gleicher Tagesschlüssel mehrfach).
  const keyCounts = new Map<string, number>();
  for (const r of results) {
    if (r.dailyKey) keyCounts.set(r.dailyKey, (keyCounts.get(r.dailyKey) ?? 0) + 1);
  }
  for (const r of results) {
    if (r.dailyKey && (keyCounts.get(r.dailyKey) ?? 0) > 1) {
      r.duplicateInBatch = true;
      if (!r.warnings.includes(DUPLICATE_IN_BATCH_WARNING)) {
        r.warnings.push(DUPLICATE_IN_BATCH_WARNING);
      }
      if (r.status === 'ok') r.status = 'warning';
    }
  }

  return { files: results, aggregate: aggregateBatch(results) };
}

function classifyFile(input: BatchFileInput, id: string): BatchFileResult {
  const base: BatchFileResult = {
    id,
    fileName: input.name,
    status: 'error',
    parsed: null,
    errorReason: null,
    warnings: [],
    periodFrom: null,
    periodTo: null,
    isMultiDay: false,
    importKindLabel: '—',
    costCenter: null,
    zCounter: null,
    grossRevenue: null,
    netRevenue: null,
    foodRevenue: null,
    bevRevenue: null,
    dailyKey: null,
    duplicateInBatch: false,
  };

  let parsed: GnParsedZBericht;
  try {
    parsed = parseGnZBericht(input.text, input.name);
  } catch (e: unknown) {
    return {
      ...base,
      errorReason: e instanceof Error ? e.message : 'Parser-Fehler',
    };
  }

  if (!isRecognized(parsed)) {
    return {
      ...base,
      parsed,
      errorReason: 'Kein gültiger Z-Bericht erkannt (kein Zeitraum, kein Umsatz).',
      warnings: [...parsed.warnings],
    };
  }

  const periodFrom = parsed.periodFrom || null;
  const periodTo = parsed.periodTo || periodFrom;
  const isMultiDay = !!periodFrom && !!periodTo && periodFrom !== periodTo;
  const importKindLabel = importKindLabelFor(periodFrom, periodTo);
  const warnings = [...parsed.warnings];

  // Status: 'warning' nur bei für den Batch RELEVANTEN Problemen (Mehrtagesbericht
  // oder fehlender Zeitraum).  Harmlose Parser-Hinweise (z. B. fehlende optionale
  // Sektionen) bleiben in `warnings`, stufen den Status aber NICHT herab.
  let status: BatchFileStatus = 'ok';
  if (isMultiDay) {
    if (!warnings.includes(MULTI_DAY_WARNING)) warnings.push(MULTI_DAY_WARNING);
    status = 'warning';
  } else if (!periodFrom) {
    if (!warnings.includes(NO_PERIOD_WARNING)) warnings.push(NO_PERIOD_WARNING);
    status = 'warning';
  }

  return {
    id,
    fileName: input.name,
    status,
    parsed,
    errorReason: null,
    warnings,
    periodFrom,
    periodTo,
    isMultiDay,
    importKindLabel,
    costCenter: parsed.costCenter || null,
    zCounter: parsed.zCounter || null,
    grossRevenue: parsed.revenue?.totalGross ?? null,
    netRevenue: parsed.taxNetTotal ?? null,
    foodRevenue: parsed.foodAmount ?? null,
    bevRevenue: parsed.bevAmount ?? null,
    // Tagesschlüssel nur für echte Einzeltage (kein Mehrtagesbericht).
    dailyKey: isMultiDay ? null : makeDailyKey(periodFrom, parsed.costCenter || null),
    duplicateInBatch: false,
  };
}

function aggregateBatch(results: BatchFileResult[]): BatchAggregate {
  let okCount = 0, warningCount = 0, errorCount = 0;
  let dailyReportCount = 0, periodReportCount = 0;
  let totalGross = 0, totalNet = 0, totalFood = 0, totalBev = 0;
  let dayFrom: string | null = null;
  let dayTo: string | null = null;

  for (const r of results) {
    if (r.status === 'ok') okCount++;
    else if (r.status === 'warning') warningCount++;
    else errorCount++;

    if (r.status === 'error') continue; // unerkannte Dateien zählen nicht mit

    if (r.isMultiDay) periodReportCount++;
    else if (r.periodFrom) dailyReportCount++;

    totalGross += num(r.grossRevenue);
    totalNet += num(r.netRevenue);
    totalFood += num(r.foodRevenue);
    totalBev += num(r.bevRevenue);

    if (r.periodFrom && (dayFrom === null || r.periodFrom < dayFrom)) dayFrom = r.periodFrom;
    const end = r.periodTo || r.periodFrom;
    if (end && (dayTo === null || end > dayTo)) dayTo = end;
  }

  return {
    fileCount: results.length,
    okCount,
    warningCount,
    errorCount,
    dailyReportCount,
    periodReportCount,
    dayFrom,
    dayTo,
    totalGross,
    totalNet,
    totalFood,
    totalBev,
  };
}

// ── Konflikt-/Importplanung (rein) ───────────────────────────────────────────

export type ConflictAction = 'replace' | 'skip' | 'abort';
export type ErrorPolicy = 'only_valid' | 'abort_on_error';

export interface BatchImportOptions {
  /** Verhalten bei bestehenden Daten (DB-Überschneidung) für denselben Tag. */
  conflictAction: ConflictAction;
  /** Verhalten bei fehlerhaften Dateien im Batch. */
  errorPolicy: ErrorPolicy;
}

export interface FileImportPlan {
  /** Stabile Batch-ID der Datei (entspricht BatchFileResult.id). */
  id: string;
  fileName: string;
  /** 'import' = neu, 'replace' = bestehende ersetzen, 'skip' = nicht importieren. */
  action: 'import' | 'replace' | 'skip';
  /** IDs der zu ersetzenden bestehenden Importe (nur bei action 'replace'). */
  overlapIds: string[];
  reason: string;
}

export interface BatchPlan {
  plans: FileImportPlan[];
  /** False, wenn der gesamte Import abgebrochen werden muss. */
  canProceed: boolean;
  abortReason: string | null;
  /** Anzahl Dateien, die tatsächlich geschrieben werden (import + replace). */
  importCount: number;
}

/**
 * Entscheidet rein (ohne DB) für jede Datei, ob sie importiert, ersetzt oder
 * übersprungen wird.  `overlapsByFile` enthält die bereits ermittelten
 * DB-Überschneidungen je Batch-ID (BatchFileResult.id).
 */
export function planBatchImport(
  files: BatchFileResult[],
  overlapsByFile: Record<string, OverlapInfo[]>,
  opts: BatchImportOptions,
): BatchPlan {
  const hasErrors = files.some(f => f.status === 'error');
  if (opts.errorPolicy === 'abort_on_error' && hasErrors) {
    return {
      plans: files.map(f => ({
        id: f.id,
        fileName: f.fileName,
        action: 'skip',
        overlapIds: [],
        reason: 'Abbruch wegen fehlerhafter Dateien im Batch.',
      })),
      canProceed: false,
      abortReason: 'Mindestens eine Datei ist fehlerhaft und die Richtlinie ist "Bei Fehlern abbrechen".',
      importCount: 0,
    };
  }

  // Bei Intra-Batch-Duplikaten: nur die ERSTE Datei je Tagesschlüssel importieren.
  const seenKeys = new Set<string>();
  const plans: FileImportPlan[] = [];

  for (const f of files) {
    if (f.status === 'error') {
      plans.push({ id: f.id, fileName: f.fileName, action: 'skip', overlapIds: [], reason: f.errorReason || 'Fehlerhafte Datei.' });
      continue;
    }
    if (!f.periodFrom) {
      plans.push({ id: f.id, fileName: f.fileName, action: 'skip', overlapIds: [], reason: NO_PERIOD_WARNING });
      continue;
    }

    if (f.dailyKey) {
      if (seenKeys.has(f.dailyKey)) {
        plans.push({ id: f.id, fileName: f.fileName, action: 'skip', overlapIds: [], reason: 'Duplikat im Batch — bereits durch eine andere Datei abgedeckt.' });
        continue;
      }
      seenKeys.add(f.dailyKey);
    }

    const overlaps = overlapsByFile[f.id] ?? [];
    if (overlaps.length === 0) {
      plans.push({ id: f.id, fileName: f.fileName, action: 'import', overlapIds: [], reason: 'Neuer Import.' });
      continue;
    }

    // Es gibt bestehende Daten für diesen Tag → Konfliktaktion anwenden.
    if (opts.conflictAction === 'abort') {
      return {
        plans: files.map(x => ({ id: x.id, fileName: x.fileName, action: 'skip', overlapIds: [], reason: 'Abbruch wegen bestehender Daten.' })),
        canProceed: false,
        abortReason: `Für ${f.fileName} bestehen bereits Daten und die Konfliktaktion ist "Abbrechen".`,
        importCount: 0,
      };
    }
    if (opts.conflictAction === 'skip') {
      plans.push({ id: f.id, fileName: f.fileName, action: 'skip', overlapIds: [], reason: 'Bestehende Daten — übersprungen.' });
      continue;
    }
    // replace
    plans.push({
      id: f.id,
      fileName: f.fileName,
      action: 'replace',
      overlapIds: overlaps.map(o => o.id),
      reason: 'Bestehende Daten werden ersetzt.',
    });
  }

  const importCount = plans.filter(p => p.action === 'import' || p.action === 'replace').length;
  return {
    plans,
    canProceed: importCount > 0,
    abortReason: importCount > 0 ? null : 'Keine importierbaren Dateien.',
    importCount,
  };
}
