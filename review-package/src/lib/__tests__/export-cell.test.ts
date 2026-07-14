// @vitest-environment node
/**
 * Tests für die reinen Export-Bausteine (CSV-Aufbau, Datums-/Zellformatierung,
 * Slug). Ausschliesslich synthetische Daten, keine PII, keine DB/DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  isoToDate,
  cellToCsv,
  escapeCsvCell,
  buildCsv,
  buildCsvWithBom,
  exportSlug,
  type ExportTable,
} from '../export-cell';

describe('isoToDate', () => {
  it('wandelt ein ISO-Datum in ein lokales Date (Mitternacht) um', () => {
    const d = isoToDate('2026-03-05');
    expect(d).toBeInstanceOf(Date);
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(2); // März = 2 (0-basiert)
    expect(d?.getDate()).toBe(5);
    expect(d?.getHours()).toBe(0);
  });

  it('akzeptiert einen ISO-Timestamp und nimmt nur das Datum', () => {
    const d = isoToDate('2026-12-31T22:15:00Z');
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(11);
    expect(d?.getDate()).toBe(31);
  });

  it('liefert null bei leeren/ungültigen Werten', () => {
    expect(isoToDate(null)).toBeNull();
    expect(isoToDate(undefined)).toBeNull();
    expect(isoToDate('')).toBeNull();
    expect(isoToDate('keinDatum')).toBeNull();
    expect(isoToDate('2026-13-01')).toBeNull(); // Monat 13
    expect(isoToDate('2026-00-10')).toBeNull(); // Monat 0
  });

  it('verwirft unmögliche Kalenderdaten statt sie zu überrollen', () => {
    expect(isoToDate('2026-02-31')).toBeNull(); // Februar hat keinen 31.
    expect(isoToDate('2026-04-31')).toBeNull(); // April hat keinen 31.
    expect(isoToDate('2025-02-29')).toBeNull(); // 2025 ist kein Schaltjahr
    expect(isoToDate('2024-02-29')).not.toBeNull(); // 2024 ist ein Schaltjahr
  });
});

describe('cellToCsv', () => {
  it('formatiert Date → dd.MM.yyyy', () => {
    expect(cellToCsv(new Date(2026, 2, 5))).toBe('05.03.2026');
  });

  it('gibt Zahlen unverändert als String aus, Nicht-Endliche als leer', () => {
    expect(cellToCsv(31)).toBe('31');
    expect(cellToCsv(0)).toBe('0');
    expect(cellToCsv(Number.NaN)).toBe('');
    expect(cellToCsv(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('leere Zellen (null/undefined) → ""', () => {
    expect(cellToCsv(null)).toBe('');
    expect(cellToCsv(undefined)).toBe('');
  });

  it('lässt Strings unverändert', () => {
    expect(cellToCsv('Hallo')).toBe('Hallo');
  });
});

describe('escapeCsvCell', () => {
  it('quotet nur bei Sonderzeichen und verdoppelt Anführungszeichen', () => {
    expect(escapeCsvCell('Normal')).toBe('Normal');
    expect(escapeCsvCell('')).toBe('');
    expect(escapeCsvCell('a;b')).toBe('"a;b"');
    expect(escapeCsvCell('a,b')).toBe('"a,b"'); // Komma quotet (Spec Buchhaltungs-Export §6)
    expect(escapeCsvCell('Zeile\nUmbruch')).toBe('"Zeile\nUmbruch"');
    expect(escapeCsvCell('Mit "Zitat"')).toBe('"Mit ""Zitat"""');
  });
});

describe('buildCsv / buildCsvWithBom', () => {
  const table: ExportTable = {
    filename: 'test',
    headers: ['Name', 'Datum', 'Anzahl'],
    rows: [
      ['Gast A', new Date(2026, 0, 2), 3],
      ['Gast; B', null, null],
    ],
  };

  it('beginnt mit der Kopfzeile, Semikolon-getrennt, CRLF', () => {
    const csv = buildCsv(table);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Name;Datum;Anzahl');
    expect(lines[1]).toBe('Gast A;02.01.2026;3');
    expect(lines[2]).toBe('"Gast; B";;');
  });

  it('buildCsvWithBom stellt genau ein BOM voran', () => {
    const csv = buildCsvWithBom(table);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe(buildCsv(table));
  });

  it('leere Tabelle → nur Kopfzeile ohne BOM', () => {
    const csv = buildCsv({ filename: 'x', headers: ['A', 'B'], rows: [] });
    expect(csv).toBe('A;B');
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe('exportSlug', () => {
  it('macht aus Text einen dateinamen-tauglichen Slug', () => {
    expect(exportSlug('Müller Café')).toBe('muller-cafe');
    expect(exportSlug('  Anna-Lena  ')).toBe('anna-lena');
    expect(exportSlug('A/B\\C')).toBe('a-b-c');
  });

  it('liefert „export" als Rückfall bei leeren Werten', () => {
    expect(exportSlug('')).toBe('export');
    expect(exportSlug(null)).toBe('export');
    expect(exportSlug('---')).toBe('export');
  });
});
