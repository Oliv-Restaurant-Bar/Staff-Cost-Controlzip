/**
 * Reporting Store – Datenzugriff für Monatsdaten
 * ================================================
 *
 * Aktuell: localStorage (Schlüssel: 'reporting_v1')
 * Zukünftig: Supabase-Tabelle "monthly_financial_records"
 *
 * Die API ist bewusst so gestaltet, dass der Wechsel auf Supabase
 * nur diese Datei betrifft – alle Seiten bleiben unverändert.
 *
 * ─── Import-Deduplication-Konzept ───────────────────────────────
 *
 * Problem:  Wenn derselbe Monat zweimal importiert wird, entstehen
 *           sonst doppelte Werte (z.B. Umsatz wird addiert).
 *
 * Lösung:   Jeder Monat hat eine eindeutige ID ("YYYY-MM").
 *           Kein zweiter Datensatz kann mit derselben ID existieren.
 *
 * Zwei Import-Modi steuern, was passiert:
 *
 *   "replace" → Das komplette Monats-Objekt wird durch den neuen
 *               Datensatz ersetzt. Import-Protokoll bleibt erhalten.
 *               Wann: Neuer Buchhaltungsabschluss liegt vor.
 *
 *   "update"  → Nur die explizit mitgelieferten Felder werden
 *               überschrieben. Alle anderen Felder bleiben wie bisher.
 *               Wann: Nachtrag einzelner Positionen ohne Neuimport.
 */

import {
  MonthlyFinancialRecord,
  ImportRecord,
  ImportMode,
  ImportSource,
  ExpenseCategory,
  createEmptyMonth,
  monthId,
  AnnualSummary,
  MONTH_NAMES_DE,
  SageJournalEntry,
} from '@/types/reporting';
import { v4 as uuidv4 } from 'uuid';
import { kvGet, kvSet, safeUpsertReportingMonth, safeDeleteReportingMonth } from './supabase-kv';

// ─── Konstanten ───────────────────────────────────────────────────────────────

export const STORAGE_KEY = 'reporting_v1';

// ─── Interne Hilfsfunktionen ──────────────────────────────────────────────────

function loadAll(storeKey: string = STORAGE_KEY): Record<string, MonthlyFinancialRecord> {
  try {
    return JSON.parse(localStorage.getItem(storeKey) || '{}');
  } catch {
    return {};
  }
}

function saveAll(data: Record<string, MonthlyFinancialRecord>, storeKey: string = STORAGE_KEY): void {
  // Nur localStorage – Supabase-Schreib erfolgt via safeUpsertReportingMonth / safeDeleteReportingMonth
  // (verhindert stale-Overwrite anderer Monate bei unvollständig synchronisiertem localStorage)
  localStorage.setItem(storeKey, JSON.stringify(data));
}

// ─── Öffentliche API ──────────────────────────────────────────────────────────

/**
 * Alle Monate eines bestimmten Jahres laden.
 * Gibt 12 Einträge zurück – leere Monate ohne Daten sind enthalten.
 */
export function loadYear(year: number, storeKey: string = STORAGE_KEY): MonthlyFinancialRecord[] {
  const all = loadAll(storeKey);
  return Array.from({ length: 12 }, (_, i) => {
    const id = monthId(year, i + 1);
    return all[id] ?? createEmptyMonth(year, i + 1);
  });
}

/**
 * Einzelnen Monat laden.
 * Gibt einen leeren Datensatz zurück, wenn noch keine Daten vorhanden.
 */
export function loadMonth(year: number, month: number, storeKey: string = STORAGE_KEY): MonthlyFinancialRecord {
  const all = loadAll(storeKey);
  const id  = monthId(year, month);
  return all[id] ?? createEmptyMonth(year, month);
}

/**
 * Monat speichern.
 *
 * ImportMode entscheidet, was passiert:
 *   "replace" → bestehenden Eintrag vollständig ersetzen
 *               (Import-Protokoll wird angehängt, nicht gelöscht)
 *   "update"  → bestehenden Eintrag mit neuen Daten mergen
 *               (undefined-Felder im neuen Objekt werden ignoriert)
 *
 * In beiden Fällen wird ein ImportRecord angelegt.
 */
export function saveMonth(
  incoming: Partial<MonthlyFinancialRecord> & { year: number; month: number },
  source: ImportSource,
  mode: ImportMode,
  opts?: { fileName?: string; note?: string },
  storeKey: string = STORAGE_KEY,
): MonthlyFinancialRecord {
  const all      = loadAll(storeKey);
  const id       = monthId(incoming.year, incoming.month);
  const existing = all[id] ?? createEmptyMonth(incoming.year, incoming.month);
  const now      = new Date().toISOString();

  // Feststellen welche Felder sich ändern
  const affectedFields: (keyof MonthlyFinancialRecord)[] = [];
  const trackableFields: (keyof MonthlyFinancialRecord)[] = [
    'revenueActual', 'revenueBudget', 'revenuePreviousYear', 'grossRevenueManual', 'takeAwayGrossManual',
    'personnelCostActual', 'personnelCostPlanned', 'personnelCostPreviousYear',
    'expenseCategories', 'expenseCategoriesPreviousYear',
  ];
  for (const f of trackableFields) {
    if (incoming[f] !== undefined) {
      affectedFields.push(f);
    }
  }

  const importRecord: ImportRecord = {
    importId:       uuidv4(),
    importedAt:     now,
    source,
    mode,
    fileName:       opts?.fileName,
    note:           opts?.note,
    affectedFields,
  };

  let saved: MonthlyFinancialRecord;

  if (mode === 'replace') {
    // Komplett ersetzen – Import-Protokoll aus bestehend anhängen
    saved = {
      ...createEmptyMonth(incoming.year, incoming.month),
      ...incoming,
      id,
      imports:   [...existing.imports, importRecord],
      createdAt: existing.createdAt, // Originaldatum behalten
      updatedAt: now,
    };
  } else {
    // Update: nur gelieferte Felder überschreiben
    const merged: MonthlyFinancialRecord = { ...existing };

    if (incoming.revenueActual          !== undefined) merged.revenueActual          = incoming.revenueActual;
    if (incoming.revenueBudget          !== undefined) merged.revenueBudget          = incoming.revenueBudget;
    if (incoming.revenuePreviousYear    !== undefined) merged.revenuePreviousYear    = incoming.revenuePreviousYear;
    if (incoming.grossRevenueManual     !== undefined) merged.grossRevenueManual     = incoming.grossRevenueManual;
    if (incoming.takeAwayGrossManual    !== undefined) merged.takeAwayGrossManual    = incoming.takeAwayGrossManual;
    if (incoming.personnelCostActual    !== undefined) merged.personnelCostActual    = incoming.personnelCostActual;
    if (incoming.personnelCostPlanned   !== undefined) merged.personnelCostPlanned   = incoming.personnelCostPlanned;
    if (incoming.personnelCostPreviousYear !== undefined) merged.personnelCostPreviousYear = incoming.personnelCostPreviousYear;

    // Für Ausgabenkategorien: vorhandene Kategorien aktualisieren
    // oder neue anhängen – niemals duplizieren
    if (incoming.expenseCategories && incoming.expenseCategories.length > 0) {
      merged.expenseCategories = mergeExpenseCategories(
        merged.expenseCategories,
        incoming.expenseCategories,
      );
    }
    if (incoming.expenseCategoriesPreviousYear && incoming.expenseCategoriesPreviousYear.length > 0) {
      merged.expenseCategoriesPreviousYear = mergeExpenseCategories(
        merged.expenseCategoriesPreviousYear,
        incoming.expenseCategoriesPreviousYear,
      );
    }

    merged.imports   = [...merged.imports, importRecord];
    merged.updatedAt = now;
    saved = merged;
  }

  all[id] = saved;
  saveAll(all, storeKey);
  // Sicher nach Supabase schreiben: erst KV-Stand lesen, nur diesen Monat mergen,
  // dann zurückschreiben — verhindert Datenverlust bei stale localStorage
  safeUpsertReportingMonth(id, saved, storeKey).catch(err => {
    console.error('[REPORTING] saveMonth: safeUpsertReportingMonth fehlgeschlagen', err);
  });
  return saved;
}

/**
 * Monat löschen (Admin-Funktion, z.B. Testdaten entfernen).
 */
export function deleteMonth(year: number, month: number, storeKey: string = STORAGE_KEY): void {
  const id = monthId(year, month);
  const all = loadAll(storeKey);
  delete all[id];
  saveAll(all, storeKey);
  // Sicher aus Supabase entfernen: erst KV-Stand lesen, nur diesen Monat entfernen,
  // dann zurückschreiben — andere Monate bleiben erhalten
  safeDeleteReportingMonth(id, storeKey).catch(err => {
    console.error('[REPORTING] deleteMonth: safeDeleteReportingMonth fehlgeschlagen', err);
  });
}

// ─── Jahres-Kontoblatt-Import: Replace-Scope pro Geschäftsjahr ────────────────

/**
 * Numerische Konto-Kategorien (FIBU-Quelle Sage Kontoblatt) — exakt dieselbe
 * Grenze, die pl-engine (resolveRowId) und PLView (prevYearByRow) verwenden.
 * Auch '[Unzugeordnet]'-Zeilen tragen numerische IDs und gehören dazu.
 */
const NUMERIC_ACCOUNT_RE = /^\d{3,5}$/;

export interface ReplaceAnnualCostResult {
  /** Monate, die neue Kontodaten erhalten haben */
  monthsWritten: number;
  /** Monate, in denen nur alte Kontodaten entfernt wurden */
  monthsCleared: number;
}

/**
 * Ersetzt für ein Geschäftsjahr in ALLEN 12 Monaten die numerischen
 * Konto-Kategorien (expenseCategories) durch die Daten eines
 * Jahres-Kontoblatt-Imports — idempotent:
 *
 * - Numerische Kategorien werden komplett ersetzt (auch in Monaten, die in
 *   der neuen Datei fehlen → entfernt stale Werte aus früheren Importen).
 * - Manuelle (nicht-numerische) Kategorien, revenueActual (Gastronovi),
 *   personnelCost*-Felder, Budget- und PY-Felder bleiben unangetastet.
 * - Andere Jahre bleiben unberührt.
 * - Schreibpfad pro Monat über safeUpsertReportingMonth (kein naiver Blob-Write).
 *
 * `categoriesByMonth` = Monat (1–12) → fertige ExpenseCategory-Liste
 * (aus matchCSVRows + buildExpenseCategoriesOnly, Vorzeichen bereits korrekt).
 */
export function replaceAnnualCostYear(
  year: number,
  categoriesByMonth: Map<number, ExpenseCategory[]>,
  opts: { fileName?: string; note?: string },
  storeKey: string = STORAGE_KEY,
): ReplaceAnnualCostResult {
  const all = loadAll(storeKey);
  const now = new Date().toISOString();
  let monthsWritten = 0;
  let monthsCleared = 0;
  const touchedIds: string[] = [];

  for (let month = 1; month <= 12; month++) {
    const id = monthId(year, month);
    const existing = all[id];
    const newCats = categoriesByMonth.get(month) ?? [];
    const hadNumeric = (existing?.expenseCategories ?? []).some(c => NUMERIC_ACCOUNT_RE.test(c.categoryId));

    // Nichts zu ersetzen und nichts Neues → Monat nicht anfassen (keine leeren Records erzeugen)
    if (newCats.length === 0 && !hadNumeric) continue;

    const rec = existing ?? createEmptyMonth(year, month);
    const keptManual = (rec.expenseCategories ?? []).filter(c => !NUMERIC_ACCOUNT_RE.test(c.categoryId));

    const importRecord: ImportRecord = {
      importId: uuidv4(),
      importedAt: now,
      source: 'annual_cost_import',
      mode: 'replace',
      fileName: opts.fileName,
      note: opts.note ?? `Jahres-Kontoblatt ${year}: Konto-Kategorien ersetzt`,
      affectedFields: ['expenseCategories'],
    };

    all[id] = {
      ...rec,
      expenseCategories: [...keptManual, ...newCats],
      imports: [...rec.imports, importRecord],
      updatedAt: now,
    };
    touchedIds.push(id);
    if (newCats.length > 0) monthsWritten++; else monthsCleared++;
  }

  saveAll(all, storeKey);
  for (const id of touchedIds) {
    safeUpsertReportingMonth(id, all[id], storeKey).catch(err => {
      console.error('[REPORTING] replaceAnnualCostYear: safeUpsertReportingMonth fehlgeschlagen', id, err);
    });
  }

  return { monthsWritten, monthsCleared };
}

/**
 * Entfernt alle numerischen Konto-Kategorien eines Geschäftsjahres
 * (Lösch-Aktion der Import-Verwaltung). Manuelle Kategorien und
 * Direktfelder bleiben erhalten.
 */
export function removeAnnualCostYear(
  year: number,
  opts: { note?: string },
  storeKey: string = STORAGE_KEY,
): ReplaceAnnualCostResult {
  return replaceAnnualCostYear(
    year,
    new Map(),
    { note: opts.note ?? `Jahres-Kontoblatt ${year}: Konto-Kategorien entfernt` },
    storeKey,
  );
}

/**
 * Gibt an, welche Jahre Daten enthalten.
 * Nützlich für den Jahr-Selector in der UI.
 */
export function availableYears(storeKey: string = STORAGE_KEY): number[] {
  const all = loadAll(storeKey);
  const years = new Set<number>();
  Object.keys(all).forEach(id => {
    const y = parseInt(id.split('-')[0]);
    if (!isNaN(y)) years.add(y);
  });
  const current = new Date().getFullYear();
  years.add(current);
  return Array.from(years).sort((a, b) => b - a); // Neueste zuerst
}

/**
 * Optionen für Jahr-Selektoren: Jahre mit Daten ∪ [aktuell−2 … aktuell+1],
 * aufsteigend sortiert. Macht abgeschlossene Geschäftsjahre (z. B. 2024)
 * wählbar, auch bevor Daten importiert wurden — ohne harte Jahreszahlen.
 */
export function yearSelectOptions(available: number[], current: number): number[] {
  const years = new Set<number>(available);
  for (let y = current - 2; y <= current + 1; y++) years.add(y);
  return Array.from(years).sort((a, b) => a - b);
}

// ─── Aggregationen ────────────────────────────────────────────────────────────

/**
 * Berechnet die Jahresübersicht aus den Monatsdaten.
 * Nur Monate mit tatsächlichen Daten werden einbezogen.
 */
export function calcAnnualSummary(year: number, storeKey: string = STORAGE_KEY): AnnualSummary {
  const months = loadYear(year);
  let totalRevenueActual      = 0;
  let totalRevenueBudget      = 0;
  let totalRevenuePreviousYear = 0;
  let totalPersonnelCostActual = 0;
  let totalPersonnelCostPlanned = 0;
  let monthsWithData = 0;

  for (const m of months) {
    const hasData = m.revenueActual !== undefined || m.personnelCostActual !== undefined;
    if (hasData) monthsWithData++;
    totalRevenueActual       += m.revenueActual       ?? 0;
    totalRevenueBudget       += m.revenueBudget       ?? 0;
    totalRevenuePreviousYear += m.revenuePreviousYear ?? 0;
    totalPersonnelCostActual += m.personnelCostActual ?? 0;
    totalPersonnelCostPlanned += m.personnelCostPlanned ?? 0;
  }

  const personnelCostRatio = totalRevenueActual > 0
    ? (totalPersonnelCostActual / totalRevenueActual) * 100
    : 0;

  return {
    year,
    totalRevenueActual,
    totalRevenueBudget,
    totalRevenuePreviousYear,
    totalPersonnelCostActual,
    totalPersonnelCostPlanned,
    personnelCostRatio,
    monthsWithData,
  };
}

// ─── Interne Hilfsfunktion: Kategorie-Merge ───────────────────────────────────

/**
 * Ausgabenkategorien zusammenführen ohne Duplikate.
 *
 * Regel:
 *   - Kategorie existiert bereits → Betrag überschreiben
 *   - Neue Kategorie → anhängen
 *
 * Dies ist der Kern der "update"-Deduplication für Kostenpositionen.
 */
function mergeExpenseCategories(
  existing: { categoryId: string; label: string; amount: number }[],
  incoming: { categoryId: string; label: string; amount: number }[],
): { categoryId: string; label: string; amount: number }[] {
  const map = new Map(existing.map(e => [e.categoryId, { ...e }]));
  for (const item of incoming) {
    map.set(item.categoryId, { ...item }); // Überschreiben oder neu einfügen
  }
  return Array.from(map.values());
}

// ─── Sage Buchungsjournal ─────────────────────────────────────────────────────

const JOURNAL_KEY = 'sage_journal_v1';

function journalMonthKey(year: number, month: number): string {
  return `${JOURNAL_KEY}_${year}_${String(month).padStart(2, '0')}`;
}

/**
 * Buchungszeilen für einen Monat speichern.
 * Schreibt immer nach localStorage UND Supabase (fire-and-forget).
 */
export function saveJournalEntries(
  year: number,
  month: number,
  entries: SageJournalEntry[],
  mode: ImportMode = 'replace',
): void {
  const key = journalMonthKey(year, month);
  let final: SageJournalEntry[];
  if (mode === 'replace') {
    final = entries;
  } else {
    final = [...loadJournalEntries(year, month), ...entries];
  }
  localStorage.setItem(key, JSON.stringify(final));
  kvSet(key, final).catch(() => {});
  console.log(`[Journal] Gespeichert: ${key} (${final.length} Einträge) → localStorage + Supabase`);
}

/**
 * Buchungszeilen für einen Monat aus localStorage laden (sync, sofort).
 */
export function loadJournalEntries(year: number, month: number): SageJournalEntry[] {
  const key = journalMonthKey(year, month);
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]');
  } catch {
    return [];
  }
}

/**
 * Buchungszeilen für einen Monat aus Supabase laden (async).
 * Führt einmalige Auto-Migration durch wenn Supabase leer ist aber localStorage Daten hat.
 */
export async function loadJournalEntriesFromDB(year: number, month: number): Promise<SageJournalEntry[]> {
  const key = journalMonthKey(year, month);
  try {
    const remote = await kvGet(key);
    if (remote !== null && Array.isArray(remote) && (remote as SageJournalEntry[]).length > 0) {
      const entries = remote as SageJournalEntry[];
      localStorage.setItem(key, JSON.stringify(entries));
      console.log(`[Journal] Aus Supabase geladen: ${key} (${entries.length} Einträge)`);
      return entries;
    }
    // Supabase leer — localStorage prüfen und ggf. migrieren
    const local = loadJournalEntries(year, month);
    if (local.length > 0) {
      console.log(`[Journal] Supabase leer – sync localStorage→Supabase: ${key} (${local.length} Einträge)`);
      kvSet(key, local).catch(() => {});
    } else {
      console.log(`[Journal] Keine Daten: ${key}`);
    }
    return local;
  } catch (err) {
    console.error(`[Journal] loadJournalEntriesFromDB Fehler: ${key}`, err);
    return loadJournalEntries(year, month);
  }
}

/**
 * Buchungszeilen für ein ganzes Jahr laden (alle 12 Monate, sync).
 */
export function loadJournalYear(year: number): SageJournalEntry[] {
  const all: SageJournalEntry[] = [];
  for (let m = 1; m <= 12; m++) {
    all.push(...loadJournalEntries(year, m));
  }
  return all;
}

/**
 * Ganzes Journal-Jahr aus Supabase laden und in localStorage synchronisieren.
 * Für Auto-Migration beim Seitenaufruf.
 */
export async function syncJournalYearFromDB(year: number): Promise<void> {
  for (let m = 1; m <= 12; m++) {
    await loadJournalEntriesFromDB(year, m);
  }
}

// ─── Formatierungshilfen ──────────────────────────────────────────────────────

export function formatCHF(value: number): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency',
    currency: 'CHF',
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatMonthLabel(year: number, month: number): string {
  return `${MONTH_NAMES_DE[month]} ${year}`;
}
