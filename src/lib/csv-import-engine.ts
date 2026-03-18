/**
 * CSV-Import-Engine – Buchhaltungs-CSV einlesen und zuordnen
 * ===========================================================
 *
 * Unterstützte Formate:
 *   - Semikolon- oder kommagetrennt
 *   - Typische Schweizer Buchhaltungssoftware:
 *     Banana Accounting, AbaNinja, Bexio, Sage 50
 *   - Spalten: Kontonummer, Bezeichnung, Betrag (in beliebiger Reihenfolge)
 *   - Betragsformate: 1'234.56 / 1.234,56 / 1234.56 / -1234.56
 *
 * Matching-Reihenfolge:
 *   1. Exakter Treffer in Kontenplan (Custom- oder Standard-Mapping)
 *   2. Bereichstreffer (z.B. 3000–3099 → Speiseumsatz)
 *   3. Kein Treffer → Status 'unresolved' → Admin muss manuell zuordnen
 *
 * Speicherlogik:
 *   - Jeder Account → ExpenseCategory mit categoryId = Kontonummer
 *   - Umsatzkonten (sign='income') → auch revenueActual / revenuePreviousYear
 *   - Personalkonten (5xxx) → auch personnelCostActual / personnelCostPreviousYear
 *   - Update-Modus: gleiche Kontonummer → Betrag wird überschrieben (kein Duplikat)
 *   - Replace-Modus: ganzer Monat wird neu gesetzt
 */

import { ExpenseCategory, MonthlyFinancialRecord, SageJournalEntry } from '@/types/reporting';
import { lookupAccount, getCategoryLabel, getSectionLabel } from '@/lib/account-mapping-store';
import { PLCategory } from '@/types/account-mapping';

// ─── Typen ────────────────────────────────────────────────────────────────────

/** Rohdaten einer geparsten CSV-Zeile */
export interface ParsedCSVRow {
  lineIndex: number;
  rawLine: string;
  accountNumber: string;   // 4-stellige Kontonummer
  accountName: string;     // Bezeichnung aus CSV oder aus Kontenplan
  rawAmount: string;       // Originalbetrag als String (für Debug)
  amount: number;          // Geparster Betrag in CHF
}

/** Status nach Matching */
export type MatchStatus = 'exact' | 'range' | 'unresolved';

/** Gematchte Zeile mit P&L-Zuordnung */
export interface MatchedCSVRow {
  parsed: ParsedCSVRow;
  status: MatchStatus;
  plCategory: PLCategory | null;
  plCategoryLabel: string;
  plSection: string;
  plRowId: string | null;   // P&L-Zeilen-ID aus pl-engine.ts
  sign: 'income' | 'expense' | null;
  department: string | null;
  /** Notiz für Admin, z.B. 'Bereichstreffer 3000–3099' */
  matchNote?: string;
}

/** Vollständiges Parse-Ergebnis */
export interface CSVParseResult {
  matched: MatchedCSVRow[];
  unresolved: MatchedCSVRow[];
  journalEntries: SageJournalEntry[];
  totalRows: number;
  matchedCount: number;
  unresolvedCount: number;
  detectedSeparator: ';' | ',';
  warnings: string[];
}

/** Konfiguration für den Import-Vorgang */
export interface ImportConfig {
  year: number;
  month: number;
  /** 'actual' = laufendes Jahr, 'previous_year' = Vorjahresdaten */
  dataType: 'actual' | 'previous_year';
  /** 'replace' = ganzen Monat ersetzen, 'update' = nur ändern */
  mode: 'replace' | 'update';
  fileName: string;
}

// ─── PLCategory → P&L-Zeilen-ID ──────────────────────────────────────────────

/**
 * Ordnet jede PLCategory der korrekten Zeilen-ID im P&L-Schema zu.
 * Muss konsistent mit PL_STRUCTURE in pl-engine.ts sein.
 */
export const PL_CATEGORY_TO_ROW_ID: Partial<Record<PLCategory, string>> = {
  revenue_food:      'revenue_total',
  revenue_beverage:  'revenue_total',
  revenue_catering:  'revenue_total',
  revenue_other:     'revenue_total',
  cogs_food:         'cogs_food',
  cogs_beverage:     'cogs_bev',
  cogs_other:        'cogs_other',
  personnel_kitchen: 'personnel_wages',
  personnel_service: 'personnel_wages',
  personnel_admin:   'personnel_wages',
  personnel_social:  'personnel_social',
  personnel_other:   'personnel_other',
  rent:              'rent',
  utilities:         'utilities',
  cleaning:          'cleaning',
  maintenance:       'maintenance',
  insurance:         'insurance',
  marketing:         'marketing',
  admin_costs:       'admin',
  office:            'admin',
  bank_fees:         'admin',
  other_operating:   'other_operating',
  depreciation:      'depreciation',
  unmapped:          'other_operating',
};

// ─── CSV-Parser ───────────────────────────────────────────────────────────────

/**
 * Erkennt den Trennzeichen des CSV (Semikolon oder Komma).
 */
function detectSeparator(content: string): ';' | ',' {
  const firstLine = content.split('\n')[0] ?? '';
  const semiCount  = (firstLine.match(/;/g) ?? []).length;
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  return semiCount >= commaCount ? ';' : ',';
}

/**
 * Normalisiert einen Betrag-String in eine JavaScript-Zahl.
 * Unterstützt:
 *   1'234.56  (Schweizer Format: Apostroph als Tausender, Punkt als Dezimal)
 *   1.234,56  (Europäisches Format: Punkt als Tausender, Komma als Dezimal)
 *   1234.56   (Standard)
 *   -1234.56  (negativ)
 *   1234      (ganzzahlig)
 */
export function parseAmount(raw: string): number | null {
  if (!raw) return null;
  let s = raw.trim().replace(/\s/g, '');

  // Vorzeichen merken
  const negative = s.startsWith('-');
  s = s.replace(/^[+\-]/, '');

  // Formatierung erkennen
  if (/['']/.test(s)) {
    // Schweizer Format: 1'234.56
    s = s.replace(/['']/g, '').replace(',', '.');
  } else if (/\.\d{3},/.test(s) || /\d{1,3}(\.\d{3})+,\d+$/.test(s)) {
    // Europäisches Format: 1.234,56
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/,\d{2}$/.test(s) && !s.includes('.')) {
    // Nur Komma als Dezimal: 1234,56
    s = s.replace(',', '.');
  } else {
    // Standard oder bereits korrekt: 1234.56
    s = s.replace(',', '.');
  }

  // Restliche nicht-numerische Zeichen entfernen (ausser Punkt)
  s = s.replace(/[^0-9.]/g, '');

  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return negative ? -n : n;
}

/**
 * Prüft ob ein String eine gültige 4-stellige Kontonummer ist.
 */
function isAccountNumber(s: string): boolean {
  return /^\d{3,5}$/.test(s.trim());
}

/**
 * Versucht, Spalten-Indices für Kontonummer, Bezeichnung und Betrag zu finden.
 */
function detectColumns(
  headers: string[],
  firstDataRow: string[],
): { accountIdx: number; nameIdx: number; amountIdx: number } | null {

  const lowerHeaders = headers.map(h => h.toLowerCase().trim());

  // Heuristiken für Kontonummer-Spalte
  let accountIdx = lowerHeaders.findIndex(h =>
    /kont|account|kto|nr\b|num/i.test(h)
  );

  // Heuristiken für Bezeichnung-Spalte
  let nameIdx = lowerHeaders.findIndex(h =>
    /bezeich|beschreib|name|text|titel|desc/i.test(h)
  );

  // Heuristiken für Betrag-Spalte (von hinten: letzter numerischer Kandidat)
  let amountIdx = lowerHeaders.findIndex(h =>
    /betrag|saldo|chf|eur|summe|total|amount|value|haben|soll|kredit|debit/i.test(h)
  );

  // Falls keine Header-Erkennung: anhand der Daten der ersten Zeile raten
  if (accountIdx === -1 && nameIdx === -1 && amountIdx === -1 && firstDataRow) {
    for (let i = 0; i < firstDataRow.length; i++) {
      const cell = firstDataRow[i]?.trim() ?? '';
      if (accountIdx === -1 && isAccountNumber(cell)) accountIdx = i;
      else if (nameIdx === -1 && /[a-zA-ZäöüÄÖÜ]{3,}/.test(cell) && accountIdx !== i) nameIdx = i;
      else if (amountIdx === -1 && parseAmount(cell) !== null && i !== accountIdx && i !== nameIdx) amountIdx = i;
    }
  }

  if (accountIdx === -1 || amountIdx === -1) return null;
  return { accountIdx, nameIdx, amountIdx };
}

/**
 * Parst den CSV-Inhalt und gibt erkannte Buchungszeilen zurück.
 */
export function parseCSVContent(rawContent: string): {
  rows: ParsedCSVRow[];
  warnings: string[];
  separator: ';' | ',';
} {
  const warnings: string[] = [];
  const separator = detectSeparator(rawContent);
  const rows: ParsedCSVRow[] = [];

  const lines = rawContent
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length === 0) {
    return { rows, warnings: ['CSV ist leer'], separator };
  }

  // Header-Zeile identifizieren
  const firstLine = lines[0].split(separator);
  const secondLine = lines.length > 1 ? lines[1].split(separator) : [];

  // Wenn die erste Zeile keine Zahlen enthält → Header
  const firstLineHasNumbers = firstLine.some(c => /\d/.test(c));
  const hasHeaders = !firstLineHasNumbers || firstLine.some(c => /[a-zA-Z]{4,}/.test(c));

  const headers = hasHeaders ? firstLine : [];
  const dataLines = hasHeaders ? lines.slice(1) : lines;

  const cols = detectColumns(headers, dataLines[0]?.split(separator) ?? []);

  if (!cols) {
    warnings.push('Konnte Spalten nicht automatisch erkennen. Erwarte: Kontonummer | Bezeichnung | Betrag');
    return { rows, warnings, separator };
  }

  for (let i = 0; i < dataLines.length; i++) {
    const line = dataLines[i];
    const cells = line.split(separator).map(c => c.replace(/^["']|["']$/g, '').trim());

    const accountRaw = cells[cols.accountIdx] ?? '';
    const nameRaw    = cells[cols.nameIdx]    ?? '';
    const amountRaw  = cells[cols.amountIdx]  ?? '';

    if (!accountRaw) continue;

    // Nur 3–5-stellige Kontonummern (auch wenn "3" → zu kurz; mindestens 3)
    if (!isAccountNumber(accountRaw)) continue;

    const amount = parseAmount(amountRaw);
    if (amount === null) {
      warnings.push(`Zeile ${i + 1 + (hasHeaders ? 1 : 0)}: Betrag '${amountRaw}' konnte nicht geparst werden – übersprungen`);
      continue;
    }

    // Beträge von 0 überspringen (Saldenzeilen, leere Konten)
    if (amount === 0) continue;

    rows.push({
      lineIndex: i + (hasHeaders ? 2 : 1),
      rawLine: line,
      accountNumber: accountRaw.trim().padStart(4, '0'),
      accountName: nameRaw || `Konto ${accountRaw}`,
      rawAmount: amountRaw,
      amount: Math.abs(amount), // Beträge immer positiv speichern (Vorzeichen via sign)
    });
  }

  if (rows.length === 0) {
    warnings.push('Keine gültigen Buchungszeilen gefunden. Prüfen Sie Format und Spaltenstruktur.');
  }

  return { rows, warnings, separator };
}

// ─── Account-Matching ─────────────────────────────────────────────────────────

/**
 * Matcht alle geparsten Zeilen gegen den Kontenplan.
 */
export function matchCSVRows(rows: ParsedCSVRow[]): CSVParseResult {
  const matched: MatchedCSVRow[] = [];
  const unresolved: MatchedCSVRow[] = [];

  for (const row of rows) {
    const result = lookupAccount(row.accountNumber);

    const matchedRow: MatchedCSVRow = {
      parsed: row,
      status: result.matchType === 'exact' ? 'exact' :
              result.matchType === 'range' ? 'range' : 'unresolved',
      plCategory: result.mapping?.plCategory ?? null,
      plCategoryLabel: result.mapping
        ? getCategoryLabel(result.mapping.plCategory)
        : 'Nicht zugeordnet',
      plSection: result.mapping
        ? getSectionLabel(result.mapping.plSection)
        : '—',
      plRowId: result.mapping
        ? (PL_CATEGORY_TO_ROW_ID[result.mapping.plCategory] ?? null)
        : null,
      sign: result.mapping?.sign ?? null,
      department: result.mapping?.department ?? null,
      matchNote: result.matchType === 'range'
        ? `Bereichstreffer (kein exaktes Konto – bitte im Kontenplan anlegen)`
        : result.matchType === 'none'
        ? 'Kein Mapping gefunden – manuell zuordnen'
        : undefined,
    };

    // Account-Name aus Kontenplan wenn CSV-Name fehlt
    if (!row.accountName || row.accountName === `Konto ${row.accountNumber}`) {
      if (result.mapping?.accountName) {
        matchedRow.parsed = { ...row, accountName: result.mapping.accountName };
      }
    }

    if (result.requiresManualMapping) {
      unresolved.push(matchedRow);
    } else {
      matched.push(matchedRow);
    }
  }

  return {
    matched,
    unresolved,
    journalEntries: [],
    totalRows: rows.length,
    matchedCount: matched.length,
    unresolvedCount: unresolved.length,
    detectedSeparator: ';',
    warnings: [],
  };
}

// ─── Journal-CSV-Parser ───────────────────────────────────────────────────────

/**
 * Erkennt und parst das Sage/Abacus Buchungsjournal-CSV-Format.
 *
 * Erkannte Spalten (flexibel, reihenfolge-unabhängig):
 *   Datum | BelegNr | Buchungstext | Konto | Soll | Haben
 *   Datum | Ref     | Text         | Acc   | Debit | Credit
 *
 * Gibt null zurück wenn das CSV nicht als Journal-Format erkannt wird.
 */
export function parseJournalCSV(rawContent: string): {
  entries: SageJournalEntry[];
  warnings: string[];
} | null {
  const warnings: string[] = [];
  const sep = rawContent.includes(';') ? ';' : ',';
  const lines = rawContent.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return null;

  const header = lines[0].split(sep).map(h => h.replace(/^["']|["']$/g, '').trim().toLowerCase());

  // Journal erkannt wenn: Datum-Spalte UND (Buchungstext/Text)-Spalte UND (Konto/Account)-Spalte
  const dateIdx = header.findIndex(h => /^datum$|^date$|^dat\.?$/i.test(h));
  const textIdx = header.findIndex(h => /buchungstext|text|beschreibung|description|bezeichn/i.test(h));
  const accIdx  = header.findIndex(h => /^konto$|^account$|^kto$|^acc\.?$/i.test(h));
  const belegIdx = header.findIndex(h => /beleg|beleg.?nr|ref|belegnr|doc/i.test(h));
  const sollIdx  = header.findIndex(h => /^soll$|^debit$|^debet$/i.test(h));
  const habenIdx = header.findIndex(h => /^haben$|^credit$|^kredit$/i.test(h));
  const amtIdx   = header.findIndex(h => /^betrag$|^amount$|^chf$/i.test(h));

  // Muss mindestens Datum + Text + (Konto oder Betrag) haben
  if (dateIdx === -1 || textIdx === -1 || (accIdx === -1 && amtIdx === -1 && sollIdx === -1)) {
    return null;
  }

  const entries: SageJournalEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(sep).map(c => c.replace(/^["']|["']$/g, '').trim());

    const dateRaw = cells[dateIdx] ?? '';
    const textRaw = cells[textIdx] ?? '';
    const accRaw  = accIdx >= 0 ? (cells[accIdx] ?? '') : '';
    const belegRaw = belegIdx >= 0 ? (cells[belegIdx] ?? '') : '';

    if (!dateRaw || !textRaw) continue;

    // Datum normalisieren: "1.1.26" → "01.01.2026"
    let dateStr = dateRaw;
    const dm = dateRaw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
    if (dm) {
      const yy = parseInt(dm[3]);
      const yyyy = yy < 100 ? (yy < 50 ? 2000 + yy : 1900 + yy) : yy;
      dateStr = `${dm[1].padStart(2,'0')}.${dm[2].padStart(2,'0')}.${yyyy}`;
    }

    // Beträge
    const soll  = sollIdx >= 0  ? (parseAmount(cells[sollIdx]  ?? '') ?? 0) : 0;
    const haben = habenIdx >= 0 ? (parseAmount(cells[habenIdx] ?? '') ?? 0) : 0;
    const amt   = amtIdx >= 0   ? Math.abs(parseAmount(cells[amtIdx] ?? '') ?? 0) : 0;
    const amount = amt > 0 ? amt : (soll > 0 ? Math.abs(soll) : Math.abs(haben));

    if (amount === 0 && soll === 0 && haben === 0) continue;

    // Kontonummer
    const accountNumber = /^\d{3,5}$/.test(accRaw)
      ? accRaw.padStart(4, '0')
      : '';

    const mapping = accountNumber ? lookupAccount(accountNumber).mapping : undefined;

    entries.push({
      date:          dateStr,
      belegNr:       belegRaw || undefined,
      text:          textRaw,
      accountNumber: accountNumber || accRaw,
      accountName:   mapping?.accountName ?? (accountNumber ? `Konto ${accountNumber}` : accRaw),
      soll:          Math.abs(soll),
      haben:         Math.abs(haben),
      amount,
    });
  }

  if (entries.length === 0) return null;

  warnings.push(`Buchungsjournal-Format erkannt: ${entries.length} Einzelbuchungen gelesen.`);
  return { entries, warnings };
}

// ─── Record-Builder ───────────────────────────────────────────────────────────

/**
 * Baut einen Partial<MonthlyFinancialRecord> aus den gematchten Zeilen.
 * Summiert Umsatz- und Personalkonten in die Top-Level-Felder,
 * und speichert alle Konten als ExpenseCategory für den Drilldown.
 *
 * Zeilen mit 'income' sign (Ertragskonten, z.B. 3xxx) werden ADDIERT
 * zu revenueActual / revenuePreviousYear.
 * Zeilen mit 'expense' sign (Aufwandskonten) werden als ExpenseCategory gespeichert.
 * Personalkonten (personnel_*) werden ZUSÄTZLICH zu personnelCostActual summiert.
 */
export function buildMonthRecord(
  matched: MatchedCSVRow[],
  unresolved: MatchedCSVRow[],
  config: ImportConfig,
): Partial<MonthlyFinancialRecord> {
  const isPY = config.dataType === 'previous_year';

  let revenueTotal   = 0;
  let personnelTotal = 0;
  let hasRevenue     = false;
  let hasPersonnel   = false;

  const expenseCategories: ExpenseCategory[] = [];

  // Alle gematchten Zeilen verarbeiten
  for (const row of matched) {
    const { parsed, sign, plCategory } = row;
    // Ertragskonten (3xxx): Soll - Haben ist negativ (Haben > Soll), daher negieren → positiver Betrag
    const amount = sign === 'income' ? -parsed.amount : parsed.amount;
    const cat: ExpenseCategory = {
      categoryId: parsed.accountNumber,
      label: parsed.accountName,
      amount,
    };
    expenseCategories.push(cat);

    if (sign === 'income') {
      revenueTotal += amount; // positiver Betrag
      hasRevenue = true;
    }

    if (plCategory && ['personnel_kitchen','personnel_service','personnel_admin'].includes(plCategory)) {
      personnelTotal += parsed.amount;
      hasPersonnel = true;
    }
  }

  // Nicht zugeordnete Zeilen: als "sonstiges" speichern
  for (const row of unresolved) {
    expenseCategories.push({
      categoryId: row.parsed.accountNumber,
      label: `[Unzugeordnet] ${row.parsed.accountName}`,
      amount: row.parsed.amount,
    });
  }

  if (isPY) {
    return {
      year:  config.year,
      month: config.month,
      ...(hasRevenue   && { revenuePreviousYear:         revenueTotal }),
      ...(hasPersonnel && { personnelCostPreviousYear:   personnelTotal }),
      expenseCategoriesPreviousYear: expenseCategories,
    };
  } else {
    return {
      year:  config.year,
      month: config.month,
      ...(hasRevenue   && { revenueActual:        revenueTotal }),
      ...(hasPersonnel && { personnelCostActual:  personnelTotal }),
      expenseCategories,
    };
  }
}

// ─── Vollständiger Parse-Durchlauf ────────────────────────────────────────────

/**
 * Führt alle Import-Schritte durch: Parsen → Matchen → Ergebnis.
 * Gibt ein vollständiges CSVParseResult zurück.
 */
export function processCSV(rawContent: string): {
  parseResult: CSVParseResult;
  warnings: string[];
  separator: ';' | ',';
} {
  const { rows, warnings, separator } = parseCSVContent(rawContent);
  const parseResult = matchCSVRows(rows);
  parseResult.warnings.push(...warnings);
  parseResult.detectedSeparator = separator;

  // Zusätzlich: Journal-Format erkennen und Einzelbuchungen extrahieren
  const journal = parseJournalCSV(rawContent);
  if (journal) {
    parseResult.journalEntries = journal.entries;
    parseResult.warnings.push(...journal.warnings);
  }

  return { parseResult, warnings, separator };
}
