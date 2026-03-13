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
  createEmptyMonth,
  monthId,
  AnnualSummary,
  MONTH_NAMES_DE,
} from '@/types/reporting';
import { v4 as uuidv4 } from 'uuid';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'reporting_v1';

// ─── Interne Hilfsfunktionen ──────────────────────────────────────────────────

function loadAll(): Record<string, MonthlyFinancialRecord> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveAll(data: Record<string, MonthlyFinancialRecord>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ─── Öffentliche API ──────────────────────────────────────────────────────────

/**
 * Alle Monate eines bestimmten Jahres laden.
 * Gibt 12 Einträge zurück – leere Monate ohne Daten sind enthalten.
 */
export function loadYear(year: number): MonthlyFinancialRecord[] {
  const all = loadAll();
  return Array.from({ length: 12 }, (_, i) => {
    const id = monthId(year, i + 1);
    return all[id] ?? createEmptyMonth(year, i + 1);
  });
}

/**
 * Einzelnen Monat laden.
 * Gibt einen leeren Datensatz zurück, wenn noch keine Daten vorhanden.
 */
export function loadMonth(year: number, month: number): MonthlyFinancialRecord {
  const all = loadAll();
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
): MonthlyFinancialRecord {
  const all      = loadAll();
  const id       = monthId(incoming.year, incoming.month);
  const existing = all[id] ?? createEmptyMonth(incoming.year, incoming.month);
  const now      = new Date().toISOString();

  // Feststellen welche Felder sich ändern
  const affectedFields: (keyof MonthlyFinancialRecord)[] = [];
  const trackableFields: (keyof MonthlyFinancialRecord)[] = [
    'revenueActual', 'revenueBudget', 'revenuePreviousYear',
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

    if (incoming.revenueActual        !== undefined) merged.revenueActual        = incoming.revenueActual;
    if (incoming.revenueBudget        !== undefined) merged.revenueBudget        = incoming.revenueBudget;
    if (incoming.revenuePreviousYear  !== undefined) merged.revenuePreviousYear  = incoming.revenuePreviousYear;
    if (incoming.personnelCostActual  !== undefined) merged.personnelCostActual  = incoming.personnelCostActual;
    if (incoming.personnelCostPlanned !== undefined) merged.personnelCostPlanned = incoming.personnelCostPlanned;
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
  saveAll(all);
  return saved;
}

/**
 * Monat löschen (Admin-Funktion, z.B. Testdaten entfernen).
 */
export function deleteMonth(year: number, month: number): void {
  const all = loadAll();
  delete all[monthId(year, month)];
  saveAll(all);
}

/**
 * Gibt an, welche Jahre Daten enthalten.
 * Nützlich für den Jahr-Selector in der UI.
 */
export function availableYears(): number[] {
  const all = loadAll();
  const years = new Set<number>();
  Object.keys(all).forEach(id => {
    const y = parseInt(id.split('-')[0]);
    if (!isNaN(y)) years.add(y);
  });
  const current = new Date().getFullYear();
  years.add(current);
  return Array.from(years).sort((a, b) => b - a); // Neueste zuerst
}

// ─── Aggregationen ────────────────────────────────────────────────────────────

/**
 * Berechnet die Jahresübersicht aus den Monatsdaten.
 * Nur Monate mit tatsächlichen Daten werden einbezogen.
 */
export function calcAnnualSummary(year: number): AnnualSummary {
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
