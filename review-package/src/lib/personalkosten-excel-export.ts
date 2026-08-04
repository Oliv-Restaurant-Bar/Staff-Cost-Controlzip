/**
 * Personalkosten Excel-Export (einfach)
 * =====================================
 * Erzeugt eine .xlsx mit EINEM Tabellenblatt für den gewählten Monat + Mandanten,
 * drei Abschnitte klar untereinander (je Titelzeile + Leerzeile dazwischen):
 *  1. Übersicht:       Total FIX, Total FLEX, Total Personalkosten, PKQ
 *  2. Fix-Lohnkosten:  pro Mitarbeiter + Zwischentotale je Abteilung + Gesamttotal FIX
 *  3. Flex-Lohnkosten: pro Mitarbeiter + Total FLEX
 * Titelzeilen, Spaltenköpfe und Totale sind fett; einheitliche Spaltenbreiten.
 *
 * Reiner Darstellungs-Export: alle Zahlen kommen fertig gerechnet von der
 * Seite (SSOT personalkosten.ts) — hier wird NICHTS neu berechnet, nur
 * summiert, was ohnehin in den Tabellen steht.
 */
import ExcelJS from 'exceljs';

export interface FixExportRow {
  department: string;
  name: string;
  anstellung: string;
  /** Basis-Lohn/Mt */
  basisMt: number;
  /** inkl. 13./Mt */
  inkl13Mt: number;
  /** Total AG/Mt */
  agMt: number;
  /** Total AG/Jahr */
  agJahr: number;
}

export interface FlexExportRow {
  name: string;
  department: string;
  /** Total AG/h */
  agProStunde: number;
  planStd: number;
  istStd: number;
  flexPlan: number;
  flexIst: number;
  diff: number;
}

export interface PersonalkostenExportInput {
  tenantLabel: string;
  /** yyyy-MM */
  monthKey: string;
  monthLabel: string;
  totalFix: number;
  totalFlex: number;
  totalPersonalkosten: number;
  /** PKQ in Prozent, null wenn kein Umsatz. */
  pkqProzent: number | null;
  fixRows: FixExportRow[];
  flexRows: FlexExportRow[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
/** Ganze CHF (Export zeigt keine Rappen). */
const r0 = (v: number) => Math.round(v);

/** Schweizer Zahlenformate (Excel-numFmt). */
const FMT_CHF   = "#'##0;-#'##0";      // Apostroph-Tausender, keine Dezimalstellen
const FMT_STD   = "#'##0.0;-#'##0.0";  // Stunden mit einer Dezimalstelle
const FMT_PCT   = '0.0" %"';           // z. B. 49.7 %

type NumKind = 'chf' | 'std' | 'pct';

/** Formatiert die angegebenen Zellen (1-basierte Spaltennummern) einer Zeile. */
function fmtCells(row: ExcelJS.Row, cols: Record<number, NumKind>): void {
  for (const [colStr, kind] of Object.entries(cols)) {
    const cell = row.getCell(Number(colStr));
    cell.numFmt = kind === 'chf' ? FMT_CHF : kind === 'std' ? FMT_STD : FMT_PCT;
    cell.alignment = { horizontal: 'right' };
  }
}

export function buildPersonalkostenWorkbook(input: PersonalkostenExportInput): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Personalkosten');
  // Einheitliche Spaltenbreiten für alle Abschnitte (8 Spalten).
  ws.columns = [
    { width: 30 }, { width: 14 }, { width: 14 }, { width: 14 },
    { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 },
  ];

  const addBold = (values: (string | number)[]) => { const r = ws.addRow(values); r.font = { bold: true }; return r; };
  const addRow  = (values: (string | number)[]) => ws.addRow(values);
  const blank   = () => ws.addRow([]);

  // Kopf
  addBold([`Personalkosten ${input.tenantLabel} — ${input.monthLabel}`]);
  blank();

  // ── Abschnitt 1: Übersicht ────────────────────────────────────────────────
  addBold(['Übersicht']);
  addBold(['Kennzahl', 'Wert']);
  fmtCells(addRow(['Total FIX (alle Abteilungen)', r0(input.totalFix)]), { 2: 'chf' });
  fmtCells(addRow(['Total FLEX (alle Mitarbeiter)', r0(input.totalFlex)]), { 2: 'chf' });
  fmtCells(addBold(['Total Personalkosten (FIX + FLEX)', r0(input.totalPersonalkosten)]), { 2: 'chf' });
  if (input.pkqProzent != null) {
    fmtCells(addRow(['Personalquote (PKQ)', r2(input.pkqProzent)]), { 2: 'pct' });
  } else {
    addRow(['Personalquote (PKQ)', '—']);
  }
  blank();

  // ── Abschnitt 2: Fix-Lohnkosten ───────────────────────────────────────────
  addBold(['Fix-Lohnkosten']);
  addBold(['Name', 'Abteilung', 'Anstellung', 'Basis-Lohn/Mt', 'inkl. 13./Mt', 'Total AG/Mt', 'Total AG/Jahr']);
  const byDept = new Map<string, FixExportRow[]>();
  for (const row of input.fixRows) {
    const list = byDept.get(row.department) ?? [];
    list.push(row);
    byDept.set(row.department, list);
  }
  const sum = (rows: FixExportRow[], f: (r: FixExportRow) => number) => r0(rows.reduce((s, r) => s + f(r), 0));
  const FIX_MONEY: Record<number, NumKind> = { 4: 'chf', 5: 'chf', 6: 'chf', 7: 'chf' };
  for (const [dept, rows] of byDept) {
    for (const r of rows) {
      fmtCells(addRow([r.name, r.department, r.anstellung, r0(r.basisMt), r0(r.inkl13Mt), r0(r.agMt), r0(r.agJahr)]), FIX_MONEY);
    }
    fmtCells(addBold([
      `Total ${dept}`, dept, '',
      sum(rows, (r) => r.basisMt), sum(rows, (r) => r.inkl13Mt), sum(rows, (r) => r.agMt), sum(rows, (r) => r.agJahr),
    ]), FIX_MONEY);
  }
  fmtCells(addBold([
    'Total FIX (alle Abteilungen)', '', '',
    sum(input.fixRows, (r) => r.basisMt), sum(input.fixRows, (r) => r.inkl13Mt),
    sum(input.fixRows, (r) => r.agMt), sum(input.fixRows, (r) => r.agJahr),
  ]), FIX_MONEY);
  blank();

  // ── Abschnitt 3: Flex-Lohnkosten ──────────────────────────────────────────
  addBold(['Flex-Lohnkosten']);
  addBold(['Name', 'Abteilung', 'Total AG/h', 'Plan Std', 'Ist Std', 'Flex Plan', 'Flex Ist', 'Diff']);
  // Stunden-Spalten (Plan/Ist Std) behalten EINE Dezimalstelle, Geld ganze CHF.
  const FLEX_FMT: Record<number, NumKind> = { 3: 'chf', 4: 'std', 5: 'std', 6: 'chf', 7: 'chf', 8: 'chf' };
  for (const r of input.flexRows) {
    fmtCells(addRow([r.name, r.department, r0(r.agProStunde), r2(r.planStd), r2(r.istStd), r0(r.flexPlan), r0(r.flexIst), r0(r.diff)]), FLEX_FMT);
  }
  const fsumStd = (f: (r: FlexExportRow) => number) => r2(input.flexRows.reduce((s, r) => s + f(r), 0));
  const fsumChf = (f: (r: FlexExportRow) => number) => r0(input.flexRows.reduce((s, r) => s + f(r), 0));
  fmtCells(addBold([
    'Total FLEX', '', '', fsumStd((r) => r.planStd), fsumStd((r) => r.istStd),
    fsumChf((r) => r.flexPlan), fsumChf((r) => r.flexIst), fsumChf((r) => r.diff),
  ]), FLEX_FMT);

  return wb;
}

export function personalkostenExportFilename(tenantLabel: string, monthKey: string): string {
  return `Personalkosten_${tenantLabel}_${monthKey}.xlsx`;
}

/** Baut die Arbeitsmappe und löst den Browser-Download aus. */
export async function exportPersonalkostenExcel(input: PersonalkostenExportInput): Promise<void> {
  const wb = buildPersonalkostenWorkbook(input);
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = personalkostenExportFilename(input.tenantLabel, input.monthKey);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
