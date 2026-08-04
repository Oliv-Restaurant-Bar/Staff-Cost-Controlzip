/**
 * annual-cost-preview – Konto×Monat-Vorschau + Konfliktmodi (reine Logik)
 * ========================================================================
 * Bereitet den Jahres-Kontoblatt-Import (Sage) VOR dem Schreiben auf:
 *
 *  1. buildAnnualCostPreview: Diff Konto×Monat gegen die bestehenden
 *     numerischen Konto-Kategorien des Zieljahres in reporting_v1 —
 *     Status je Zelle (neu | identisch | ueberschreiben | entfernt),
 *     Validierungen (fehlende Monate, doppelte Konten, Jahr unvollständig),
 *     3xxx-Umsatzkonten EXPLIZIT ausgewiesen (überschreiben den ER-Umsatz
 *     via P&L-Vorrangslogik hasIndividualRevenueAccounts!).
 *
 *  2. applyImportMode: Pre-Merge der Konfliktmodi. Der Schreib-Kern
 *     (replaceAnnualCostYear inkl. assertYearScopedChanges + sequenzielles
 *     KV-Backup) bleibt unverändert — «unangetastet lassen» wird als
 *     «effektive Kategorien = bestehende Kategorien» ausgedrückt; der
 *     Dirty-Check im Schreib-Kern macht identische Monate zum No-op.
 *
 * DOM- und Supabase-frei; fehlend ≠ 0 (kein Wert ⇒ null, nie 0).
 */

import type { ExpenseCategory } from '@/types/reporting';

// identisch zur Definition in reporting-store (numerische Konto-Kategorien)
const NUMERIC_ACCOUNT_RE = /^\d{3,5}$/;
/** 3xxx = Umsatzkonto: hat in der P&L-Engine Vorrang vor revenueActual. */
const REVENUE_ACCOUNT_RE = /^3\d{3}$/;

// ─── Typen ───────────────────────────────────────────────────────────────────

export type AccountMonthStatus = 'neu' | 'identisch' | 'ueberschreiben' | 'entfernt';

export interface AccountMonthCell {
  /** Monat 1–12 */
  month: number;
  /** Wert aus der Import-Datei (null = Konto in diesem Monat nicht in der Datei) */
  newAmount: number | null;
  /** Bestehender Wert in reporting_v1 (null = bisher kein Wert) */
  existingAmount: number | null;
  /** null, wenn weder neu noch bestehend vorhanden */
  status: AccountMonthStatus | null;
}

export interface AccountPreviewRow {
  accountNumber: string;
  label: string;
  /** true = Konto konnte keiner Kategorie zugeordnet werden ([Unzugeordnet]) */
  unmapped: boolean;
  /** true = 3xxx-Umsatzkonto (überschreibt den ER-Umsatz!) */
  isRevenueAccount: boolean;
  /** genau 12 Zellen (Monat 1–12) */
  cells: AccountMonthCell[];
  /** Jahressumme neu (nur Monate mit Wert in der Datei) */
  newTotal: number;
  /** Jahressumme bestehend */
  existingTotal: number;
}

export interface AnnualCostPreview {
  rows: AccountPreviewRow[];
  /** Monate (1–12) mit Daten in der Datei, aufsteigend */
  monthsInFile: number[];
  /** Monate ohne Daten in der Datei */
  missingMonths: number[];
  /** true, wenn die Datei weniger als 12 Monate abdeckt */
  incompleteYear: boolean;
  /** Monate, die bereits numerische Kontodaten haben */
  monthsWithExistingData: number[];
  /** Monate mit mindestens einer Überschreibung (Wert ändert sich) */
  conflictMonths: number[];
  /** Monate, deren bestehende Kontodaten im Modus «replace» entfernt würden
   *  (Monat fehlt in der Datei, hat aber bestehende numerische Konten) */
  clearedMonths: number[];
  /** 3xxx-Umsatzkonten in der Datei (Kontonummern, aufsteigend) */
  revenueAccounts: string[];
  /** Nicht zugeordnete Konten in der Datei (Kontonummern, aufsteigend) */
  unmappedAccounts: string[];
  /** Doppelte Konto-Einträge innerhalb eines Monats (Datenqualität) */
  duplicateAccounts: { month: number; accountNumber: string }[];
  /** Menschenlesbare Validierungshinweise (deutsch) */
  warnings: string[];
}

export type AnnualCostImportMode = 'replace' | 'keep-existing' | 'fill-empty' | 'selective';

export interface ApplyImportModeResult {
  /** Effektive Kategorien je Monat (1–12) für den Schreib-Kern */
  effective: Map<number, ExpenseCategory[]>;
  /** Monate, die bewusst unverändert bleiben (Dirty-Check ⇒ No-op) */
  monthsSkipped: number[];
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function isNumericAccount(c: ExpenseCategory): boolean {
  return NUMERIC_ACCOUNT_RE.test(c.categoryId);
}

/** Kanonischer Vergleich zweier Kategorien-Listen (Reihenfolge egal). */
export function sameCategorySet(a: ExpenseCategory[], b: ExpenseCategory[]): boolean {
  if (a.length !== b.length) return false;
  const key = (c: ExpenseCategory) => `${c.categoryId}\u0000${c.label}\u0000${c.amount}`;
  const sa = [...a].map(key).sort();
  const sb = [...b].map(key).sort();
  return sa.every((v, i) => v === sb[i]);
}

/** Summiert doppelte Konto-Einträge eines Monats; meldet Duplikate. */
function toAccountMap(
  cats: ExpenseCategory[],
  month: number,
  duplicates: { month: number; accountNumber: string }[] | null,
): Map<string, { label: string; amount: number }> {
  const map = new Map<string, { label: string; amount: number }>();
  for (const c of cats) {
    if (!isNumericAccount(c)) continue;
    const prev = map.get(c.categoryId);
    if (prev) {
      if (duplicates) duplicates.push({ month, accountNumber: c.categoryId });
      map.set(c.categoryId, { label: prev.label, amount: prev.amount + c.amount });
    } else {
      map.set(c.categoryId, { label: c.label, amount: c.amount });
    }
  }
  return map;
}

const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

function listMonths(months: number[]): string {
  return months.map(m => MONTH_NAMES_SHORT[m - 1]).join(', ');
}

// ─── Vorschau ────────────────────────────────────────────────────────────────

/**
 * Baut die Konto×Monat-Vorschau eines Jahres-Kontoblatt-Imports.
 *
 * @param newByMonth      Kategorien aus der Datei (matchCSVRows + buildExpenseCategoriesOnly)
 * @param existingByMonth Bestehende expenseCategories je Monat aus reporting_v1
 *                        (kompletter Bestand; nicht-numerische werden ignoriert)
 */
export function buildAnnualCostPreview(
  newByMonth: Map<number, ExpenseCategory[]>,
  existingByMonth: Map<number, ExpenseCategory[]>,
): AnnualCostPreview {
  const duplicateAccounts: { month: number; accountNumber: string }[] = [];

  // Konto → Monat → Betrag (neu und bestehend)
  const newMaps = new Map<number, Map<string, { label: string; amount: number }>>();
  const existingMaps = new Map<number, Map<string, { label: string; amount: number }>>();
  for (let m = 1; m <= 12; m++) {
    newMaps.set(m, toAccountMap(newByMonth.get(m) ?? [], m, duplicateAccounts));
    existingMaps.set(m, toAccountMap(existingByMonth.get(m) ?? [], m, null));
  }

  // Alle Kontonummern (neu ∪ bestehend), sortiert
  const accountNumbers = new Set<string>();
  const labels = new Map<string, string>();
  const unmappedSet = new Set<string>();
  for (const [, map] of newMaps) {
    for (const [acc, v] of map) {
      accountNumbers.add(acc);
      labels.set(acc, v.label);
      if (v.label.startsWith('[Unzugeordnet]')) unmappedSet.add(acc);
    }
  }
  for (const [, map] of existingMaps) {
    for (const [acc, v] of map) {
      accountNumbers.add(acc);
      if (!labels.has(acc)) labels.set(acc, v.label);
    }
  }

  const rows: AccountPreviewRow[] = [...accountNumbers].sort().map(acc => {
    const cells: AccountMonthCell[] = [];
    let newTotal = 0;
    let existingTotal = 0;
    for (let m = 1; m <= 12; m++) {
      const nv = newMaps.get(m)!.get(acc);
      const monthInFile = (newByMonth.get(m) ?? []).length > 0;
      const ev = existingMaps.get(m)!.get(acc);
      const newAmount = nv ? nv.amount : null;
      const existingAmount = ev ? ev.amount : null;
      if (newAmount !== null) newTotal += newAmount;
      if (existingAmount !== null) existingTotal += existingAmount;

      let status: AccountMonthStatus | null = null;
      if (newAmount !== null && existingAmount === null) status = 'neu';
      else if (newAmount !== null && existingAmount !== null) {
        status = newAmount === existingAmount ? 'identisch' : 'ueberschreiben';
      } else if (newAmount === null && existingAmount !== null) {
        // Konto fehlt in der Datei: Monat in der Datei vorhanden ⇒ Konto wird
        // ersetzt (entfernt); Monat komplett absent ⇒ replace cleart den Monat.
        status = 'entfernt';
        void monthInFile;
      }
      cells.push({ month: m, newAmount, existingAmount, status });
    }
    return {
      accountNumber: acc,
      label: labels.get(acc) ?? acc,
      unmapped: unmappedSet.has(acc),
      isRevenueAccount: REVENUE_ACCOUNT_RE.test(acc),
      cells,
      newTotal,
      existingTotal,
    };
  });

  const monthsInFile: number[] = [];
  const missingMonths: number[] = [];
  const monthsWithExistingData: number[] = [];
  const conflictMonths: number[] = [];
  const clearedMonths: number[] = [];
  for (let m = 1; m <= 12; m++) {
    const hasNew = (newByMonth.get(m) ?? []).length > 0;
    const hasExisting = existingMaps.get(m)!.size > 0;
    if (hasNew) monthsInFile.push(m); else missingMonths.push(m);
    if (hasExisting) monthsWithExistingData.push(m);
    if (hasNew && hasExisting) {
      const changed = rows.some(r => {
        const c = r.cells[m - 1];
        return c.status === 'ueberschreiben' || c.status === 'entfernt';
      });
      if (changed) conflictMonths.push(m);
    }
    if (!hasNew && hasExisting) clearedMonths.push(m);
  }

  const revenueAccounts = rows.filter(r => r.isRevenueAccount && r.newTotal !== 0)
    .map(r => r.accountNumber);
  const unmappedAccounts = [...unmappedSet].sort();
  const incompleteYear = monthsInFile.length < 12;

  const warnings: string[] = [];
  if (monthsInFile.length === 0) {
    warnings.push('Die Datei enthält keine Monatsdaten — es gibt nichts zu importieren.');
  } else if (incompleteYear) {
    warnings.push(
      `Unvollständiges Jahr: Die Datei deckt ${monthsInFile.length} von 12 Monaten ab ` +
      `(fehlend: ${listMonths(missingMonths)}).`,
    );
  }
  if (clearedMonths.length > 0) {
    warnings.push(
      `Achtung (Modus «Ersetzen»): ${listMonths(clearedMonths)} ` +
      `${clearedMonths.length === 1 ? 'hat' : 'haben'} bestehende Kontodaten, fehlen aber in der Datei — ` +
      'die bestehenden Kontodaten dieser Monate würden entfernt.',
    );
  }
  if (conflictMonths.length > 0) {
    warnings.push(
      `Bestehende Kontodaten würden in ${conflictMonths.length} Monat(en) verändert: ${listMonths(conflictMonths)}.`,
    );
  }
  if (revenueAccounts.length > 0) {
    warnings.push(
      `Die Datei enthält ${revenueAccounts.length} Umsatzkonto/-konten (3xxx: ${revenueAccounts.join(', ')}). ` +
      'Diese überschreiben in der Erfolgsrechnung den Umsatz aus der Tagesansicht/Gastronovi!',
    );
  }
  if (unmappedAccounts.length > 0) {
    warnings.push(
      `${unmappedAccounts.length} Konto/Konten ohne Zuordnung im Kontenplan: ${unmappedAccounts.join(', ')} — ` +
      'werden als [Unzugeordnet] importiert.',
    );
  }
  if (duplicateAccounts.length > 0) {
    const list = duplicateAccounts.map(d => `${d.accountNumber} (${MONTH_NAMES_SHORT[d.month - 1]})`).join(', ');
    warnings.push(`Doppelte Konto-Einträge in der Datei wurden summiert: ${list}.`);
  }

  return {
    rows,
    monthsInFile,
    missingMonths,
    incompleteYear,
    monthsWithExistingData,
    conflictMonths,
    clearedMonths,
    revenueAccounts,
    unmappedAccounts,
    duplicateAccounts,
    warnings,
  };
}

// ─── Konfliktmodi (Pre-Merge) ────────────────────────────────────────────────

/**
 * Wendet den Konfliktmodus als reinen Pre-Merge an. Ergebnis geht 1:1 an
 * replaceAnnualCostYear; «Monat unangetastet lassen» = effektive Kategorien
 * gleich den bestehenden numerischen Kategorien (Dirty-Check ⇒ No-op, kein
 * updatedAt-Bump, kein KV-Write).
 *
 * - 'replace':       Datei gewinnt komplett; Monate ohne Datei-Daten mit
 *                    bestehenden Konten werden GECLEART (heutiges Verhalten).
 * - 'keep-existing': Bestehende Konto-Werte bleiben; nur Konten, die im
 *                    Monat bisher fehlen, werden aus der Datei ergänzt.
 * - 'fill-empty':    Nur Monate OHNE bestehende numerische Konten erhalten
 *                    Datei-Daten; Monate mit Daten bleiben unangetastet.
 *                    Cleart NIE absente Monate.
 * - 'selective':     Nur die ausgewählten Monate erhalten Datei-Daten
 *                    (Datei-Stand ersetzt den Monat); übrige unangetastet.
 */
export function applyImportMode(
  mode: AnnualCostImportMode,
  newByMonth: Map<number, ExpenseCategory[]>,
  existingByMonth: Map<number, ExpenseCategory[]>,
  selectedMonths?: ReadonlySet<number>,
): ApplyImportModeResult {
  const effective = new Map<number, ExpenseCategory[]>();
  // «übersprungen» = die Datei hätte für den Monat Daten, sie werden aber
  // (wegen des Modus) nicht bzw. nicht vollständig als Ersatz angewendet.
  const monthsSkipped: number[] = [];

  for (let m = 1; m <= 12; m++) {
    const newCats = (newByMonth.get(m) ?? []).filter(isNumericAccount);
    const existingCats = (existingByMonth.get(m) ?? []).filter(isNumericAccount);
    const hasNew = newCats.length > 0;
    const hasExisting = existingCats.length > 0;

    // Monat unangetastet lassen: bestehende Kategorien als effektiven Stand
    // setzen — der Dirty-Check im Schreib-Kern macht daraus einen No-op.
    const keepUntouched = () => {
      if (hasExisting) effective.set(m, existingCats);
      if (hasNew) monthsSkipped.push(m);
    };

    switch (mode) {
      case 'replace':
        // Datei gewinnt; absente Monate ⇒ kein Eintrag ⇒ Schreib-Kern cleart
        if (hasNew) effective.set(m, newCats);
        break;

      case 'keep-existing': {
        if (!hasNew) { keepUntouched(); break; }
        if (!hasExisting) { effective.set(m, newCats); break; }
        const existingIds = new Set(existingCats.map(c => c.categoryId));
        const added = newCats.filter(c => !existingIds.has(c.categoryId));
        if (added.length === 0) {
          keepUntouched();
        } else {
          // bestehende Werte bleiben, nur neue Konten kommen dazu
          effective.set(m, [...existingCats, ...added]);
        }
        break;
      }

      case 'fill-empty':
        if (hasExisting) keepUntouched();
        else if (hasNew) effective.set(m, newCats);
        break;

      case 'selective':
        if (selectedMonths?.has(m)) {
          // gewählter Monat: Datei-Stand ersetzt den Monat; ohne Datei-Daten
          // bewusst clearen (kein Eintrag ⇒ Schreib-Kern entfernt Kontodaten)
          if (hasNew) effective.set(m, newCats);
        } else {
          keepUntouched();
        }
        break;
    }
  }

  return { effective, monthsSkipped };
}
