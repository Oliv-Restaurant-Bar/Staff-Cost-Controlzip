// @vitest-environment happy-dom
// parseGastronoviExcel: CHF-Textwerte («CHF 6679,30»), «Gesamt»-Zeile als
// massgeblicher Tagesumsatz, neutrale Zeilen (Non-Foods/Rabatte/Trinkgeld/…)
// nie als Kategorie, «None»/leer = kein Wert, unlesbare Zellen gemeldet.
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseGastronoviExcel } from '@/lib/revenue-parser';
import type { UnlesbareZelle } from '@/lib/tagesdaten-zahlen';

function makeFile(rows: (string | number)[][]): File {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Blatt1');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([buf], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

describe('parseGastronoviExcel — strikt & Gesamt-Zeile', () => {
  it('parst CHF-Text (Komma-Dezimal, Hochkomma), Gesamt = Tagesumsatz, neutrale Zeilen ignoriert', async () => {
    const file = makeFile([
      ['Bezeichnung', 'Zeitraum', '01.01.', '02.01.', '01.02.'],
      ['Gesamt', '', 'CHF 6679,30', "CHF 1'000.00", 'CHF 500.50'],
      ['Food (Speisen)', '', 'CHF 4000,00', 'CHF 600.00', 'CHF 300.00'],
      ['Beverage (Getränke)', '', 'CHF 2679,30', 'CHF 400.00', 'CHF 200.50'],
      ['Non-Foods', '', 'CHF 999.00', 'CHF 999.00', 'CHF 999.00'],
      ['Rabatte', '', 'CHF -50.00', '', ''],
      ['Trinkgeld', '', 'CHF 20.00', '', ''],
      ['Aufladung Kundenkarten', '', 'CHF 100.00', '', ''],
      ['Rundungsdifferenzen', '', '-0.05', '', ''],
    ]);
    const unlesbar: UnlesbareZelle[] = [];
    const rows = await parseGastronoviExcel(file, 2024, unlesbar);
    expect(unlesbar).toEqual([]);
    expect(rows).not.toBeNull();
    const byDate = Object.fromEntries(rows!.map(r => [r.date, r]));
    // Gesamt-Zeile massgeblich — neutrale Zeilen verändern den Tagesumsatz NICHT
    expect(byDate['2024-01-01'].total).toBe(6679.3);
    expect(byDate['2024-01-02'].total).toBe(1000);
    expect(byDate['2024-02-01'].total).toBe(500.5);
    // Food/Beverage = reine Kategoriezeilen (Non-Foods zählt NICHT als Food)
    expect(byDate['2024-01-01'].food).toBe(4000);
    expect(byDate['2024-01-01'].beverage).toBe(2679.3);
    // Monatssummen aus der Gesamt-Zeile
    const jan = rows!.filter(r => r.date.startsWith('2024-01')).reduce((s, r) => s + r.total, 0);
    expect(Math.round(jan * 100) / 100).toBe(7679.3);
  });

  it('«None»/leer = kein Wert (Tag fehlt), unlesbare Zellen werden gemeldet', async () => {
    const file = makeFile([
      ['Bezeichnung', 'Zeitraum', '01.03.', '02.03.', '03.03.'],
      ['Gesamt', '', 'None', 'CHF 100.00', 'kaputt##'],
    ]);
    const unlesbar: UnlesbareZelle[] = [];
    const rows = await parseGastronoviExcel(file, 2024, unlesbar);
    const dates = rows!.map(r => r.date);
    expect(dates).toContain('2024-03-02');
    expect(dates).not.toContain('2024-03-01'); // None ⇒ kein Wert, nie 0
    expect(dates).not.toContain('2024-03-03'); // unlesbar ⇒ nicht verrechnet
    expect(unlesbar).toEqual([
      { zeile: 'Gesamt', spalte: '03.03.', roh: 'kaputt##' },
    ]);
  });
});
