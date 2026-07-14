// @vitest-environment node
/**
 * Tests für den Excel-Puffer-Aufbau (DOM-freie Schicht von table-export.ts).
 * Prüft, dass ein gültiges .xlsx (ZIP/„PK"-Signatur) mit den erwarteten Werten
 * entsteht. Synthetische Daten, keine PII, keine DOM-Abhängigkeit.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildXlsxBuffer } from '../table-export';
import { type ExportTable } from '../export-cell';

const table: ExportTable = {
  filename: 'test-export',
  sheetName: 'Gäste',
  headers: ['Name', 'Datum', 'Anzahl'],
  rows: [
    ['Gast A', new Date(2026, 0, 2), 3],
    ['Gast B', null, 0],
  ],
};

describe('buildXlsxBuffer', () => {
  it('liefert einen .xlsx-Puffer mit ZIP-Signatur „PK"', async () => {
    const buffer = await buildXlsxBuffer(table);
    const bytes = new Uint8Array(buffer);
    expect(bytes.length).toBeGreaterThan(0);
    // ZIP/OOXML beginnt mit 0x50 0x4B ("PK").
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('schreibt Kopfzeile, Zahlen als Zahl und ein echtes Datum', async () => {
    const buffer = await buildXlsxBuffer(table);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const sheet = wb.getWorksheet('Gäste');
    expect(sheet).toBeDefined();

    const header = sheet!.getRow(1);
    expect(header.getCell(1).value).toBe('Name');
    expect(header.getCell(2).value).toBe('Datum');
    expect(header.getCell(3).value).toBe('Anzahl');

    const r1 = sheet!.getRow(2);
    expect(r1.getCell(1).value).toBe('Gast A');
    expect(r1.getCell(2).value).toBeInstanceOf(Date);
    expect(r1.getCell(3).value).toBe(3);
    expect(typeof r1.getCell(3).value).toBe('number');

    const r2 = sheet!.getRow(3);
    expect(r2.getCell(3).value).toBe(0);
  });

  it('verwendet den Standard-Blattnamen „Export", wenn keiner gesetzt ist', async () => {
    const buffer = await buildXlsxBuffer({ filename: 'x', headers: ['A'], rows: [] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    expect(wb.getWorksheet('Export')).toBeDefined();
  });
});
