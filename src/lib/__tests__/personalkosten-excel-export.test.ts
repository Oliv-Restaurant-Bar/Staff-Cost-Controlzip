// @vitest-environment node
/** Excel-Export Personalkosten: EIN Blatt mit 3 Abschnitten, Fett-Formatierung, Totale, Dateiname. */
import { describe, it, expect } from 'vitest';
import type ExcelJS from 'exceljs';
import {
  buildPersonalkostenWorkbook, personalkostenExportFilename,
  type PersonalkostenExportInput,
} from '@/lib/personalkosten-excel-export';

const input: PersonalkostenExportInput = {
  tenantLabel: 'Oliv',
  monthKey: '2026-08',
  monthLabel: 'August 2026',
  totalFix: 50000,
  totalFlex: 12000.456,
  totalPersonalkosten: 62000.456,
  pkqProzent: 34.27,
  fixRows: [
    { department: 'Service', name: 'Anna', anstellung: 'Vollzeit', basisMt: 5000, inkl13Mt: 5416.65, agMt: 6267, agJahr: 75204 },
    { department: 'Küche', name: 'Ben', anstellung: 'Vollzeit', basisMt: 5500, inkl13Mt: 5958.35, agMt: 6893, agJahr: 82716 },
    { department: 'Service', name: 'Cleo', anstellung: 'Teilzeit', basisMt: 2500, inkl13Mt: 2708.35, agMt: 3133, agJahr: 37596 },
  ],
  flexRows: [
    { name: 'Dora', department: 'Service', agProStunde: 32.5, planStd: 80, istStd: 84.5, flexPlan: 2600, flexIst: 2746.25, diff: 146.25 },
  ],
};

/** Alle Zeilen als Wert-Arrays (1-basierte ExcelJS-values → ab Index 1). */
function rows(ws: ExcelJS.Worksheet): (string | number | null)[][] {
  const out: (string | number | null)[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const vals = (row.values as (string | number | null)[]).slice(1);
    out.push(vals);
  });
  return out;
}
const findRow = (ws: ExcelJS.Worksheet, first: string) => rows(ws).find((r) => r[0] === first);
const findRowNr = (ws: ExcelJS.Worksheet, first: string) => {
  let nr = -1;
  ws.eachRow((row, n) => { if (nr === -1 && row.getCell(1).value === first) nr = n; });
  return nr;
};

describe('personalkosten-excel-export', () => {
  const wb = buildPersonalkostenWorkbook(input);
  const ws = wb.getWorksheet('Personalkosten')!;

  it('genau EIN Tabellenblatt mit allen drei Abschnitts-Titeln', () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Personalkosten']);
    const firsts = rows(ws).map((r) => r[0]);
    expect(firsts).toContain('Übersicht');
    expect(firsts).toContain('Fix-Lohnkosten');
    expect(firsts).toContain('Flex-Lohnkosten');
    // Abschnitte in richtiger Reihenfolge
    const idx = (t: string) => firsts.indexOf(t);
    expect(idx('Übersicht')).toBeLessThan(idx('Fix-Lohnkosten'));
    expect(idx('Fix-Lohnkosten')).toBeLessThan(idx('Flex-Lohnkosten'));
  });

  it('Übersicht enthält die vier Kennzahlen (Geld auf ganze CHF gerundet, PKQ als Zahl)', () => {
    expect(findRow(ws, 'Total FIX (alle Abteilungen)')?.[1]).toBe(50000);
    expect(findRow(ws, 'Total FLEX (alle Mitarbeiter)')?.[1]).toBe(12000);
    expect(findRow(ws, 'Total Personalkosten (FIX + FLEX)')?.[1]).toBe(62000);
    expect(findRow(ws, 'Personalquote (PKQ)')?.[1]).toBe(34.27);
    // PKQ-Zelle trägt Prozent-Format «49.7 %»
    const nr = findRowNr(ws, 'Personalquote (PKQ)');
    expect(ws.getRow(nr).getCell(2).numFmt).toBe('0.0" %"');
  });

  it('Geldzellen: Apostroph-Tausender, keine Dezimalstellen, rechtsbündig', () => {
    const nr = findRowNr(ws, 'Total FIX (alle Abteilungen)');
    const cell = ws.getRow(nr).getCell(2);
    expect(cell.numFmt).toBe("#'##0;-#'##0");
    expect(cell.alignment?.horizontal).toBe('right');
  });

  it('Fix-Abschnitt: Gruppierung, Zwischentotale, Gesamttotal FIX', () => {
    const firsts = rows(ws).map((r) => r[0]);
    const seq = firsts.filter((v) => ['Anna', 'Cleo', 'Total Service', 'Ben', 'Total Küche'].includes(v as string));
    expect(seq).toEqual(['Anna', 'Cleo', 'Total Service', 'Ben', 'Total Küche']);
    const totalService = findRow(ws, 'Total Service')!;
    expect(totalService[3]).toBe(7500);   // Basis
    expect(totalService[5]).toBe(9400);   // AG/Mt
    // Gesamttotal FIX = zweite Zeile mit diesem Titel (erste steht in der Übersicht)
    const grand = rows(ws).filter((r) => r[0] === 'Total FIX (alle Abteilungen)')[1]!;
    expect(grand[3]).toBe(13000);
    expect(grand[4]).toBe(14083); // ganze CHF (14083.35 gerundet)
    expect(grand[5]).toBe(16293);
    expect(grand[6]).toBe(195516);
  });

  it('Flex-Abschnitt: Spaltenköpfe + Total FLEX', () => {
    const header = rows(ws).find((r) => r[0] === 'Name' && r[2] === 'Total AG/h')!;
    expect(header).toEqual(['Name', 'Abteilung', 'Total AG/h', 'Plan Std', 'Ist Std', 'Flex Plan', 'Flex Ist', 'Diff']);
    const total = findRow(ws, 'Total FLEX')!;
    expect(total[3]).toBe(80);      // Plan Std: 1 Dezimalstelle bleibt
    expect(total[4]).toBe(84.5);    // Ist Std: 1 Dezimalstelle bleibt
    expect(total[5]).toBe(2600);    // Geld: ganze CHF
    expect(total[6]).toBe(2746);    // 2746.25 gerundet
    expect(total[7]).toBe(146);     // 146.25 gerundet
    // Stunden-Zellen tragen 1-Dezimal-Format, Geld-Zellen das CHF-Format
    const nr = findRowNr(ws, 'Dora');
    expect(ws.getRow(nr).getCell(4).numFmt).toBe("#'##0.0;-#'##0.0");
    expect(ws.getRow(nr).getCell(6).numFmt).toBe("#'##0;-#'##0");
    expect(ws.getRow(nr).getCell(6).alignment?.horizontal).toBe('right');
  });

  it('Titelzeilen und Totale sind fett, Leerzeile zwischen Abschnitten', () => {
    for (const title of ['Übersicht', 'Fix-Lohnkosten', 'Flex-Lohnkosten', 'Total Service', 'Total FLEX']) {
      const nr = findRowNr(ws, title);
      expect(nr, title).toBeGreaterThan(0);
      expect(ws.getRow(nr).font?.bold, `${title} fett`).toBe(true);
    }
    // Leerzeile direkt vor «Fix-Lohnkosten» und «Flex-Lohnkosten»
    for (const title of ['Fix-Lohnkosten', 'Flex-Lohnkosten']) {
      const nr = findRowNr(ws, title);
      expect(ws.getRow(nr - 1).actualCellCount, `Leerzeile vor ${title}`).toBe(0);
    }
    // normale Datenzeile nicht fett
    const annaNr = findRowNr(ws, 'Anna');
    expect(ws.getRow(annaNr).font?.bold ?? false).toBe(false);
  });

  it('PKQ null wird als «—» exportiert', () => {
    const ws2 = buildPersonalkostenWorkbook({ ...input, pkqProzent: null }).getWorksheet('Personalkosten')!;
    expect(findRow(ws2, 'Personalquote (PKQ)')?.[1]).toBe('—');
  });

  it('Dateiname enthält Mandant + Monat', () => {
    expect(personalkostenExportFilename('Beaulieu', '2026-08')).toBe('Personalkosten_Beaulieu_2026-08.xlsx');
  });
});
