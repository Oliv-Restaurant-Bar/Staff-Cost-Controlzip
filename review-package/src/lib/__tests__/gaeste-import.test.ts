// @vitest-environment node
/**
 * Tests für parseGaesteXlsx (src/lib/gaeste-import.ts)
 * ===================================================
 * Kern-Regeln:
 *  - Die TAGESSUMME ist massgeblich: Tageswerte werden nur gerundet und
 *    unverändert übernommen — KEINE Skalierung auf das Zeitraum-Total, auch
 *    wenn der Zeitraum-Wert abweicht.
 *  - Rundung der Tageswerte per Math.round().
 *  - Das Feld `tagessumme` liefert die Summe der gerundeten Tageswerte;
 *    `zeitraum` bleibt reine Info (gerundet).
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseGaesteXlsx } from '../gaeste-import';

/**
 * Baut eine Gäste-Excel-Datei mit
 *   Zeile 1: Bezeichnung | Zeitraum | 01.07. | 02.07. | …
 *   Zeile «Gesamt»:      label      | zeitraum | tagesWerte…
 */
async function buildGaesteFile(opts: {
  year: number;
  month: number;
  zeitraum: number | null;
  tageswerte: number[];
}): Promise<File> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Gäste');

  const header: (string | null)[] = ['Bezeichnung', 'Zeitraum'];
  for (let i = 0; i < opts.tageswerte.length; i++) {
    const day = i + 1;
    header.push(`${String(day).padStart(2, '0')}.${String(opts.month).padStart(2, '0')}.`);
  }
  ws.addRow(header);

  const gesamt: (string | number | null)[] = [
    'Gesamt',
    opts.zeitraum == null ? null : `${opts.zeitraum} P.`,
  ];
  for (const v of opts.tageswerte) gesamt.push(`${v} P.`);
  ws.addRow(gesamt);

  const buffer = await wb.xlsx.writeBuffer();
  return new File([buffer], 'gaeste.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

describe('parseGaesteXlsx — Tagessumme ist massgeblich', () => {
  it('übernimmt die Tageswerte unverändert, auch wenn der Zeitraum abweicht', async () => {
    // Tagessumme = 8'584, Zeitraum-Zelle = 8'604 (deckt anderen Zeitraum ab).
    const tageswerte = [8000, 500, 84]; // Summe 8584
    const file = await buildGaesteFile({ year: 2026, month: 7, zeitraum: 8604, tageswerte });
    const r = await parseGaesteXlsx(file, 2026);

    // KEINE Skalierung: Tageswerte bleiben exakt.
    expect(r.daily['2026-07-01']).toBe(8000);
    expect(r.daily['2026-07-02']).toBe(500);
    expect(r.daily['2026-07-03']).toBe(84);

    // Tagessumme = Summe der Tageswerte (massgeblich), nicht der Zeitraum.
    expect(r.tagessumme).toBe(8584);

    // Zeitraum bleibt reine Info (gerundet).
    expect(r.zeitraum).toBe(8604);

    // Summe der gespeicherten Tageswerte bleibt 8584 (kein Rest auf letzten Tag).
    const sum = Object.values(r.daily).reduce((s, v) => s + v, 0);
    expect(sum).toBe(8584);
  });

  it('rundet Tageswerte ganzzahlig (Math.round)', async () => {
    const tageswerte = [10.4, 10.6, 3.5]; // → 10, 11, 4  (Summe 25)
    const file = await buildGaesteFile({ year: 2026, month: 3, zeitraum: null, tageswerte });
    const r = await parseGaesteXlsx(file, 2026);

    expect(r.daily['2026-03-01']).toBe(10);
    expect(r.daily['2026-03-02']).toBe(11);
    expect(r.daily['2026-03-03']).toBe(4);
    expect(r.tagessumme).toBe(25);
    expect(r.zeitraum).toBeNull();
  });

  it('setzt tagessumme aus den gerundeten Tageswerten und meldet daysWithData', async () => {
    const tageswerte = [100, 0, 200]; // Tag 2 ohne Wert → nicht in daily
    const file = await buildGaesteFile({ year: 2026, month: 7, zeitraum: 300, tageswerte });
    const r = await parseGaesteXlsx(file, 2026);

    expect(r.daysWithData).toBe(2);
    expect(r.daily['2026-07-01']).toBe(100);
    expect(r.daily['2026-07-03']).toBe(200);
    expect(r.daily['2026-07-02']).toBeUndefined();
    expect(r.tagessumme).toBe(300);
    expect(r.zeitraum).toBe(300);
    expect(r.month).toBe(7);
    expect(r.year).toBe(2026);
  });
});
