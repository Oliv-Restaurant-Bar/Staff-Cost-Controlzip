/**
 * Export-Bausteine (reine Logik, KEINE DOM/ExcelJS-Abhängigkeit)
 * =============================================================================
 * Gemeinsame Typen und Helfer für CSV-/Excel-Exporte. Bewusst frei von DOM und
 * ExcelJS, damit Domänen-Module (z. B. Kampagnen, Gästeliste) diese Typen ohne
 * schwere Abhängigkeit nutzen und reine Unit-Tests im Node-Env laufen können.
 *
 * Konventionen:
 *  - Datumswerte werden als echte `Date`-Zellen geführt (Excel: echtes Datum,
 *    CSV: „dd.MM.yyyy"). Zahlen bleiben Zahlen. Fehlende Werte → leere Zelle.
 */

import { format as formatDate } from 'date-fns';

/** Mögliche Zellwerte eines Exports. `null`/`undefined` → leere Zelle. */
export type ExportCell = string | number | Date | null | undefined;

/** Eine exportierbare Tabelle (Kopfzeile + Zeilen) inkl. Basis-Dateiname. */
export interface ExportTable {
  /** Basis-Dateiname OHNE Endung — die Endung ergänzt der jeweilige Downloader. */
  filename: string;
  /** Name des Tabellenblatts (Excel). Standard: „Export". */
  sheetName?: string;
  headers: string[];
  rows: ExportCell[][];
}

/**
 * Wandelt ein ISO-Datum („yyyy-MM-dd" bzw. ISO-Timestamp) in ein lokales
 * `Date` (Mitternacht) um. Leere/ungültige Werte → `null` (keine TZ-Verschiebung,
 * da Komponenten lokal konstruiert werden).
 */
export function isoToDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (Number.isNaN(d.getTime())) return null;
  // Unmögliche Kalenderdaten (z. B. 2026-02-31) rollen sonst in den Folgemonat —
  // Round-Trip-Prüfung verwirft sie.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return d;
}

/** Formatiert eine Zelle für CSV: Datum → „dd.MM.yyyy", Zahl → String, leer → "". */
export function cellToCsv(cell: ExportCell): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return formatDate(cell, 'dd.MM.yyyy');
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : '';
  return cell;
}

/**
 * Quotet eine CSV-Zelle nur, wenn nötig (Trennzeichen, Anführungszeichen,
 * Umbruch). KOMMA gehört dazu, obwohl Semikolon der Trenner ist — Beträge/
 * Texte mit Komma dürfen beim Öffnen in Fremd-Tools keine Spalten verschieben
 * (Spec Buchhaltungs-Export §6).
 */
export function escapeCsvCell(value: string): string {
  if (value === '') return '';
  if (/[",;\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Baut den CSV-Inhalt (ohne BOM): Kopfzeile + Zeilen, Semikolon als Trenner,
 * CRLF als Zeilenumbruch. Das UTF-8-BOM wird separat (Download) vorangestellt.
 */
export function buildCsv(table: ExportTable): string {
  const lines = [table.headers, ...table.rows.map(r => r.map(cellToCsv))];
  return lines
    .map(cols => cols.map(escapeCsvCell).join(';'))
    .join('\r\n');
}

/** CSV-Inhalt mit vorangestelltem UTF-8-BOM (Excel erkennt Umlaute korrekt). */
export function buildCsvWithBom(table: ExportTable): string {
  return '\uFEFF' + buildCsv(table);
}

/** Macht aus beliebigem Text einen dateinamen-tauglichen Slug. */
export function exportSlug(value: string | null | undefined): string {
  const base = (value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'export';
}
