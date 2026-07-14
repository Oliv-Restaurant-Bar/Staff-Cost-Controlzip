/**
 * Tabellen-Export (CSV + Excel) — DOM-/ExcelJS-Schicht
 * =============================================================================
 * Setzt die in `export-cell.ts` definierten reinen Bausteine in echte Downloads
 * um. CSV: UTF-8 mit BOM, Semikolon-getrennt. Excel: echtes .xlsx via ExcelJS
 * (Datum als Datum, Zahlen als Zahlen, fixierte/fette Kopfzeile).
 *
 * `buildXlsxBuffer` ist bewusst DOM-frei (nur ExcelJS) und damit testbar; nur die
 * `download*`-Funktionen greifen auf `Blob`/`document` zu.
 */

import ExcelJS from 'exceljs';
import {
  type ExportTable,
  buildCsvWithBom,
} from './export-cell';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_MIME = 'text/csv;charset=utf-8;';

/** Baut einen .xlsx-Puffer aus einer Export-Tabelle (ohne DOM-Zugriff). */
export async function buildXlsxBuffer(table: ExportTable): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(table.sheetName ?? 'Export');

  sheet.addRow(table.headers);
  for (const row of table.rows) {
    sheet.addRow(row.map(cell => (cell === undefined ? null : cell)));
  }

  // Kopfzeile: fett + fixiert (friert beim Scrollen ein).
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // Spaltenbreiten grob an den Inhalt anpassen; Datumszellen formatieren.
  table.headers.forEach((header, colIdx) => {
    const column = sheet.getColumn(colIdx + 1);
    let maxLen = header.length;
    for (const row of table.rows) {
      const value = row[colIdx];
      const len =
        value instanceof Date
          ? 10
          : value === null || value === undefined
            ? 0
            : String(value).length;
      if (len > maxLen) maxLen = len;
    }
    column.width = Math.min(Math.max(maxLen + 2, 8), 48);
  });

  for (let r = 0; r < table.rows.length; r++) {
    const sheetRow = sheet.getRow(r + 2);
    table.rows[r].forEach((value, c) => {
      if (value instanceof Date) sheetRow.getCell(c + 1).numFmt = 'dd.mm.yyyy';
    });
  }

  return workbook.xlsx.writeBuffer();
}

/** Löst einen Browser-Download für einen Blob unter dem gegebenen Dateinamen aus. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** CSV-Download (UTF-8 mit BOM, Semikolon-getrennt). */
export function downloadCsv(table: ExportTable): void {
  const blob = new Blob([buildCsvWithBom(table)], { type: CSV_MIME });
  triggerDownload(blob, `${table.filename}.csv`);
}

/** Excel-Download (.xlsx). */
export async function downloadXlsx(table: ExportTable): Promise<void> {
  const buffer = await buildXlsxBuffer(table);
  const blob = new Blob([buffer], { type: XLSX_MIME });
  triggerDownload(blob, `${table.filename}.xlsx`);
}
