// @vitest-environment happy-dom
// parseGastronoviExcel: Die Spalte «Zeitraum»/«Gesamtbetrag im Anzeigezeitraum»
// darf die Tageswerte NIE skalieren — sie deckt den ganzen Anzeigezeitraum ab,
// auch wenn nur ein Teil der Tage als Spalten vorhanden ist (Bug 08/2026:
// Faktor ×2.62 bei 4 Tagesspalten). Tageswerte werden 1:1 übernommen.
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import fs from 'node:fs';
import { parseGastronoviExcel } from '@/lib/revenue-parser';

function makeFile(rows: (string | number)[][]): File {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Blatt1');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([buf], 'test.xlsx');
}

describe('parseGastronoviExcel — keine Skalierung auf das Zeitraum-Total', () => {
  it('Tageswerte 1:1 trotz viel grösserem Zeitraum-Total (Teil-Tagesspalten)', async () => {
    // Zeitraum-Total 67'167.50 deckt 01.-13.08. ab, aber nur 4 Tagesspalten:
    const file = makeFile([
      ['Bezeichnung', 'Gesamtbetrag im Anzeigezeitraum', '10.08.', '11.08.', '12.08.', '13.08.'],
      ['Gesamt', "CHF 67'167.50", "CHF 5'742.60", "CHF 5'889.00", "CHF 6'720.60", "CHF 7'249.90"],
      ['Food (Speisen)', "CHF 40'000.00", "CHF 3'500.00", "CHF 3'600.00", "CHF 4'000.00", "CHF 4'400.00"],
      ['Beverage (Getränke)', "CHF 27'167.50", "CHF 2'242.60", "CHF 2'289.00", "CHF 2'720.60", "CHF 2'849.90"],
    ]);
    const rows = await parseGastronoviExcel(file, 2026);
    expect(rows).not.toBeNull();
    const byDate = Object.fromEntries(rows!.map(r => [r.date, r]));
    // ROHE Tageswerte — KEIN Faktor ×2.62:
    expect(byDate['2026-08-10'].total).toBe(5742.6);
    expect(byDate['2026-08-11'].total).toBe(5889.0);
    expect(byDate['2026-08-12'].total).toBe(6720.6);
    expect(byDate['2026-08-13'].total).toBe(7249.9);
    expect(byDate['2026-08-10'].food).toBe(3500);
    expect(byDate['2026-08-10'].beverage).toBe(2242.6);
  });

  it('echte Gastronovi-Datei: Tageswerte 1:1 aus den Tagesspalten (keine Anpassung ans Zeitraum-Total)', async () => {
    const buf = fs.readFileSync('attached_assets/1_export_1786186679513.xlsx');
    const file = new File([new Uint8Array(buf)], 'export.xlsx');
    const rows = await parseGastronoviExcel(file, 2026);
    expect(rows).not.toBeNull();
    // Datei: Gesamt 02.01. = CHF 1784,56 / 03.01. = CHF 2058,06 — roh übernehmen.
    const byDate = Object.fromEntries(rows!.map(r => [r.date, r]));
    expect(byDate['2026-01-02']?.total).toBe(1784.56);
    expect(byDate['2026-01-03']?.total).toBe(2058.06);
  });
});
