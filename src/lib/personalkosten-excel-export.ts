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
  addRow(['Total FIX (alle Abteilungen)', r2(input.totalFix)]);
  addRow(['Total FLEX (alle Mitarbeiter)', r2(input.totalFlex)]);
  addBold(['Total Personalkosten (FIX + FLEX)', r2(input.totalPersonalkosten)]);
  addRow(['Personalquote (PKQ)', input.pkqProzent != null ? `${input.pkqProzent.toFixed(1)} %` : '—']);
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
  const sum = (rows: FixExportRow[], f: (r: FixExportRow) => number) => r2(rows.reduce((s, r) => s + f(r), 0));
  for (const [dept, rows] of byDept) {
    for (const r of rows) {
      addRow([r.name, r.department, r.anstellung, r2(r.basisMt), r2(r.inkl13Mt), r2(r.agMt), r2(r.agJahr)]);
    }
    addBold([
      `Total ${dept}`, dept, '',
      sum(rows, (r) => r.basisMt), sum(rows, (r) => r.inkl13Mt), sum(rows, (r) => r.agMt), sum(rows, (r) => r.agJahr),
    ]);
  }
  addBold([
    'Total FIX (alle Abteilungen)', '', '',
    sum(input.fixRows, (r) => r.basisMt), sum(input.fixRows, (r) => r.inkl13Mt),
    sum(input.fixRows, (r) => r.agMt), sum(input.fixRows, (r) => r.agJahr),
  ]);
  blank();

  // ── Abschnitt 3: Flex-Lohnkosten ──────────────────────────────────────────
  addBold(['Flex-Lohnkosten']);
  addBold(['Name', 'Abteilung', 'Total AG/h', 'Plan Std', 'Ist Std', 'Flex Plan', 'Flex Ist', 'Diff']);
  for (const r of input.flexRows) {
    addRow([r.name, r.department, r2(r.agProStunde), r2(r.planStd), r2(r.istStd), r2(r.flexPlan), r2(r.flexIst), r2(r.diff)]);
  }
  const fsum = (f: (r: FlexExportRow) => number) => r2(input.flexRows.reduce((s, r) => s + f(r), 0));
  addBold([
    'Total FLEX', '', '', fsum((r) => r.planStd), fsum((r) => r.istStd),
    fsum((r) => r.flexPlan), fsum((r) => r.flexIst), fsum((r) => r.diff),
  ]);

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
