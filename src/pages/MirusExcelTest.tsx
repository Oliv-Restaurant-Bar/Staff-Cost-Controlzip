/**
 * Mirus Excel Parser — Testseite /mirus-excel-test
 * =================================================
 * Upload → Struktur-Analyse → Parse → Validierung → Export
 * Kein Speichern, kein Supabase, keine produktive Logik.
 */

import { useState, useCallback, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { cn } from '@/lib/utils';
import {
  Upload, FileText, ChevronDown, ChevronUp,
  AlertTriangle, CheckCircle2, XCircle, Info,
  User, Calendar, Loader2, Table2, Download, Search, ArrowRight, Grid3x3,
} from 'lucide-react';
import { parseMirusExcel } from '@/lib/mirus-excel-parser';
import type { ExcelParsedDocument, ExcelEmployee, DayRecord } from '@/lib/mirus-excel-parser';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// ═══════════════════════════════════════════════════════════════════════════════
// ─── VALIDIERUNGS-TYPEN ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

type Severity     = 'error' | 'warning' | 'info';
type ErrorCategory = 'name' | 'dayrow' | 'totals' | 'date' | 'duplicate' | 'meta';

interface ValidationIssue {
  severity: Severity;
  category: ErrorCategory;
  message: string;
  employeeName?: string;
  employeeIndex?: number;
}

interface EmployeeValidation {
  index: number;
  name: string | null;
  issues: ValidationIssue[];
  dayRowsCount: number;
  expectedDaysCount: number;
  missingDates: string[];
  multiShiftDays: number;
  absenceDays: number;
  totalsPresent: { totalHours: boolean; pause: boolean; ueberzeit: boolean; saldo: boolean; ferien: boolean };
  importStatus: 'ready' | 'review' | 'blocked';
}

interface DocumentValidation {
  employeeValidations: EmployeeValidation[];
  globalIssues: ValidationIssue[];
  summary: { total: number; ready: number; review: number; blocked: number; totalErrors: number; totalWarnings: number };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── STRUKTUR-ANALYSE (Raw-Grid) ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

interface CellData {
  addr: string; row: number; col: number; colLetter: string;
  value: string | number | boolean | null; formatted: string;
  type: string; formula?: string; isMerged: boolean; mergeRange?: string;
}
interface MergeInfo { range: string; rows: number; cols: number }
interface BlockCandidate {
  startRow: number; endRow: number | null; triggerCell: string;
  possibleNameCell?: string; qualityScore: number; dayRowCount: number;
}
interface SheetAnalysis {
  sheetName: string; ref: string; totalRows: number; totalCols: number;
  nonEmptyCells: number; merges: MergeInfo[]; hiddenRows: number[]; hiddenColLetters: string[];
  cells: CellData[]; blockCandidates: BlockCandidate[];
}

function buildMergeMap(ws: XLSX.WorkSheet): Map<string, string> {
  const map = new Map<string, string>();
  const merges: XLSX.Range[] = (ws['!merges'] as XLSX.Range[] | undefined) ?? [];
  for (const m of merges) {
    const rs = XLSX.utils.encode_range(m);
    for (let r = m.s.r; r <= m.e.r; r++)
      for (let c = m.s.c; c <= m.e.c; c++)
        map.set(XLSX.utils.encode_cell({ r, c }), rs);
  }
  return map;
}

async function analyzeExcelFile(file: File): Promise<SheetAnalysis[]> {
  const buf = await file.arrayBuffer();
  const wb  = XLSX.read(buf, { type: 'array', cellDates: true, cellNF: true, cellText: true, sheetStubs: true });
  const out: SheetAnalysis[] = [];

  for (const sheetName of wb.SheetNames) {
    const ws  = wb.Sheets[sheetName];
    const ref = ws['!ref'] ?? '';
    if (!ref) { out.push({ sheetName, ref: '', totalRows: 0, totalCols: 0, nonEmptyCells: 0, merges: [], hiddenRows: [], hiddenColLetters: [], cells: [], blockCandidates: [] }); continue; }

    const range = XLSX.utils.decode_range(ref);
    const mergeMap  = buildMergeMap(ws);
    const rawMerges: XLSX.Range[] = (ws['!merges'] as XLSX.Range[] | undefined) ?? [];
    const merges = rawMerges.map(m => ({ range: XLSX.utils.encode_range(m), rows: m.e.r - m.s.r + 1, cols: m.e.c - m.s.c + 1 }));

    const wsRows: { hidden?: boolean }[] = (ws['!rows'] as { hidden?: boolean }[] | undefined) ?? [];
    const wsCols: { hidden?: boolean }[] = (ws['!cols'] as { hidden?: boolean }[] | undefined) ?? [];
    const hiddenRows = wsRows.map((r, i) => r?.hidden ? i + 1 : -1).filter(i => i > 0);
    const hiddenColLetters = wsCols.map((c, i) => c?.hidden ? XLSX.utils.encode_col(i) : '').filter(Boolean);

    const cells: CellData[] = [];
    let nonEmptyCells = 0;
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr] as XLSX.CellObject | undefined;
        if (!cell || cell.t === 'z') continue;
        nonEmptyCells++;
        let value: CellData['value'] = null;
        if (cell.v instanceof Date) value = cell.v.toLocaleDateString('de-CH');
        else if (cell.v !== undefined) value = cell.v as string | number | boolean;
        const formatted = cell.w ?? (value !== null ? String(value) : '');
        if (!formatted.trim()) continue;
        cells.push({ addr, row: r, col: c, colLetter: XLSX.utils.encode_col(c), value, formatted, type: cell.t ?? '', formula: cell.f, isMerged: mergeMap.has(addr), mergeRange: mergeMap.get(addr) });
      }
    }

    // Block-Kandidaten: "Name / Vorname" in Spalte C
    const colC    = XLSX.utils.decode_col('C');
    const rowText = new Map<number, string[]>();
    for (const cell of cells) {
      if (!rowText.has(cell.row)) rowText.set(cell.row, []);
      rowText.get(cell.row)!.push(cell.formatted);
    }
    const blockCandidates: BlockCandidate[] = [];
    for (const [rowIdx, texts] of rowText) {
      const joined = texts.join(' ');
      if (!/Name\s*\/\s*Vorname/i.test(joined)) continue;
      const triggerCell = cells.find(c2 => c2.row === rowIdx && c2.col === colC)?.addr ?? `C${rowIdx + 1}`;
      const mNameCell = cells.find(c2 => c2.row === rowIdx && c2.col === XLSX.utils.decode_col('M'));
      const possibleNameCell = mNameCell ? `${mNameCell.addr}="${mNameCell.formatted}"` : undefined;
      let dayRowCount = 0, endRow: number | null = null;
      for (let r = rowIdx + 1; r < Math.min(rowIdx + 45, range.e.r); r++) {
        const rt = rowText.get(r) ?? [];
        if (/^\d{1,2}\.\d{1,2}/.test(rt[0] ?? '')) dayRowCount++;
        if (/TOTAL|unterschrift/i.test(rt.join(' '))) { endRow = r + 1; break; }
      }
      let score = 0;
      if (possibleNameCell) score += 40;
      if (dayRowCount > 0) score += Math.min(dayRowCount * 2, 40);
      if (endRow) score += 20;
      blockCandidates.push({ startRow: rowIdx + 1, endRow, triggerCell, possibleNameCell, dayRowCount, qualityScore: Math.min(score, 100) });
    }
    out.push({ sheetName, ref, totalRows: range.e.r - range.s.r + 1, totalCols: range.e.c - range.s.c + 1, nonEmptyCells, merges, hiddenRows, hiddenColLetters, cells, blockCandidates });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── VALIDIERUNGS-LOGIK ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function getExpectedDays(month: number, year: number): string[] {
  const count = new Date(year, month, 0).getDate();
  const mm    = String(month).padStart(2, '0');
  return Array.from({ length: count }, (_, i) => `${String(i + 1).padStart(2, '0')}.${mm}`);
}

function normName(name: string | null) { return (name ?? '').toLowerCase().replace(/\s+/g, ' ').trim(); }

function validateEmployee(emp: ExcelEmployee, idx: number, _all: ExcelEmployee[], expected: string[]): EmployeeValidation {
  const issues: ValidationIssue[] = [];
  const label = emp.name ?? `Mitarbeiter ${idx + 1}`;

  // ── Name ───────────────────────────────────────────────────────────────────
  if (!emp.name) {
    issues.push({ severity: 'error', category: 'name', message: 'Name fehlt', employeeName: label, employeeIndex: idx });
  } else if (/Wöchentliche|Kostenstelle|TOTAL|Arbeitszeit|Betrieb/i.test(emp.name)) {
    issues.push({ severity: 'error', category: 'name', message: `Name enthält Zusatztext: „${emp.name}"`, employeeName: label, employeeIndex: idx });
  }

  // ── Kostenstelle / Abteilung ───────────────────────────────────────────────
  if (!emp.costCenter) issues.push({ severity: 'warning', category: 'name', message: 'Kostenstelle fehlt', employeeName: label, employeeIndex: idx });

  // ── Tageszeilen ────────────────────────────────────────────────────────────
  const actualDates  = new Set(emp.days.map(d => d.date).filter(Boolean) as string[]);
  const normalised   = new Set(Array.from(actualDates).map(d => d.slice(0, 5)));
  const missingDates = expected.filter(d => !normalised.has(d));
  const daysWithData = emp.days.filter(d => d.shifts.length > 0 || !!d.absenceCode).length;

  if (emp.days.length === 0 && !emp.totals.totalHours) {
    issues.push({ severity: 'error', category: 'dayrow', message: 'Keine Tageszeilen und keine Totale erkannt', employeeName: label, employeeIndex: idx });
  } else if (emp.days.length === 0) {
    issues.push({ severity: 'warning', category: 'dayrow', message: 'Keine Tageszeilen, aber Totale vorhanden', employeeName: label, employeeIndex: idx });
  } else if (daysWithData === 0 && emp.days.length < 5) {
    issues.push({ severity: 'warning', category: 'dayrow', message: 'Sehr wenige Tageszeilen ohne Zeitdaten', employeeName: label, employeeIndex: idx });
  }
  // Missing days: only warn if many missing AND data was expected (full month)
  if (expected.length > 0 && missingDates.length > 15 && emp.days.length > 0) {
    issues.push({ severity: 'warning', category: 'date', message: `${missingDates.length} von ${expected.length} Tagen nicht erkannt`, employeeName: label, employeeIndex: idx });
  }
  // Merged blocks: note (not error)
  if (emp.mergedFromCount > 1) {
    issues.push({ severity: 'info', category: 'meta', message: `${emp.mergedFromCount} Teilblöcke zusammengeführt (Zeilen: ${emp.mergedBlockRows.map(([s, e]) => `${s}–${e}`).join(', ')})`, employeeName: label, employeeIndex: idx });
  }

  // ── Totale ────────────────────────────────────────────────────────────────
  const tp = { totalHours: !!emp.totals.totalHours, pause: !!emp.totals.pauseTotal, ueberzeit: !!emp.totals.ueberzeit, saldo: !!emp.totals.saldo, ferien: !!emp.totals.ferien };
  // Totale fehlen ist nur eine Warnung, nicht ein Fehler (wenn Tageszeilen vorhanden)
  if (!tp.totalHours && emp.days.length < 5) {
    issues.push({ severity: 'warning', category: 'totals', message: 'Total Stunden fehlt', employeeName: label, employeeIndex: idx });
  }

  // ── Import-Status ─────────────────────────────────────────────────────────
  // Blocked: nur wenn kein Name ODER gar keine verwertbaren Daten
  const hasData        = emp.days.length > 0 || !!emp.totals.totalHours;
  const hasErrors      = issues.some(i => i.severity === 'error');
  const hasWarnings    = issues.some(i => i.severity === 'warning');
  const hasEnoughDays  = emp.days.length >= 10 || !!emp.totals.totalHours;
  const hasTimeData    = daysWithData > 0;
  const wasMerged      = emp.mergedFromCount > 1;

  const importStatus: 'ready' | 'review' | 'blocked' =
    !emp.name || !hasData ? 'blocked' :
    hasErrors             ? 'blocked' :
    hasEnoughDays && hasTimeData && !hasWarnings ? 'ready' :
    wasMerged || hasWarnings || !hasEnoughDays   ? 'review' : 'ready';

  return {
    index: idx, name: emp.name, issues,
    dayRowsCount: emp.days.length, expectedDaysCount: expected.length,
    missingDates, multiShiftDays: emp.days.filter(d => d.shifts.length > 1).length,
    absenceDays: emp.days.filter(d => !!d.absenceCode).length,
    totalsPresent: tp, importStatus,
  };
}

function validateDocument(doc: ExcelParsedDocument): DocumentValidation {
  const expected  = (doc.month && doc.year) ? getExpectedDays(doc.month, doc.year) : [];
  const globalIssues: ValidationIssue[] = [];
  if (!doc.month) globalIssues.push({ severity: 'error', category: 'meta', message: 'Monat nicht erkannt (Dateiname auswertbar)' });
  if (!doc.year)  globalIssues.push({ severity: 'error', category: 'meta', message: 'Jahr nicht erkannt' });
  if (doc.employees.length === 0) globalIssues.push({ severity: 'error', category: 'meta', message: 'Keine Mitarbeiterblöcke gefunden — prüfe Spalte C' });

  const employeeValidations = doc.employees.map((e, i) => validateEmployee(e, i, doc.employees, expected));
  const all = [...globalIssues, ...employeeValidations.flatMap(v => v.issues)];
  return {
    employeeValidations, globalIssues,
    summary: {
      total: doc.employees.length,
      ready:   employeeValidations.filter(v => v.importStatus === 'ready').length,
      review:  employeeValidations.filter(v => v.importStatus === 'review').length,
      blocked: employeeValidations.filter(v => v.importStatus === 'blocked').length,
      totalErrors:   all.filter(i => i.severity === 'error').length,
      totalWarnings: all.filter(i => i.severity === 'warning').length,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── EXPORT ───────────────────────────────────════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

function dl(data: unknown, name: string) {
  const b = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const u = URL.createObjectURL(b);
  const a = Object.assign(document.createElement('a'), { href: u, download: name });
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(u);
}

function exportDebugJson(doc: ExcelParsedDocument, val: DocumentValidation) {
  dl({
    meta: { fileName: doc.fileName, month: doc.month, monthName: doc.monthName, year: doc.year, exportedAt: new Date().toISOString() },
    quality: doc.quality, validationSummary: val.summary, globalIssues: val.globalIssues,
    employees: doc.employees.map((emp, i) => ({
      index: i + 1, ...emp,
      importStatus: val.employeeValidations[i].importStatus,
      validationIssues: val.employeeValidations[i].issues,
    })),
  }, `mirus-debug-${doc.fileName.replace(/[^a-z0-9]/gi, '_')}.json`);
}

function exportStructureJson(doc: ExcelParsedDocument, val: DocumentValidation, analyses: SheetAnalysis[]) {
  dl({
    fileName: doc.fileName, exportedAt: new Date().toISOString(),
    sheets: analyses.map(a => ({
      sheetName: a.sheetName, ref: a.ref, totalRows: a.totalRows, totalCols: a.totalCols,
      nonEmptyCells: a.nonEmptyCells, merges: a.merges, hiddenRows: a.hiddenRows,
      blockCandidates: a.blockCandidates,
      cellMatrix: a.cells.map(c => ({ addr: c.addr, row: c.row + 1, col: c.col + 1, colLetter: c.colLetter, type: c.type, value: String(c.value ?? ''), formatted: c.formatted, isMerged: c.isMerged, mergeRange: c.mergeRange ?? null })),
    })),
    parsedBlocks: doc.employees.map(e => ({ name: e.name, blockStartRow: e.blockStartRow, blockEndRow: e.blockEndRow, rawBlock: e.rawBlock })),
    validationSummary: val.summary,
  }, `mirus-struktur-${doc.fileName.replace(/[^a-z0-9]/gi, '_')}.json`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── UI HELPERS ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function SevIcon({ s }: { s: Severity }) {
  if (s === 'error')   return <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  if (s === 'warning') return <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 shrink-0" />;
  return <Info className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
}

function StatusBadge({ status }: { status: 'ready' | 'review' | 'blocked' }) {
  if (status === 'ready')  return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-green-50 border-green-300 text-green-700 dark:bg-green-900/20 dark:border-green-700 dark:text-green-400">✓ Importfähig</span>;
  if (status === 'review') return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-yellow-50 border-yellow-300 text-yellow-700 dark:bg-yellow-900/20 dark:border-yellow-700 dark:text-yellow-400">⚠ Prüfen</span>;
  return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-red-50 border-red-300 text-red-700 dark:bg-red-900/20 dark:border-red-700 dark:text-red-400">✗ Nicht importierbar</span>;
}

function cardBorder(s: 'ready' | 'review' | 'blocked') {
  return s === 'ready' ? 'border-green-200 dark:border-green-800' : s === 'review' ? 'border-yellow-200 dark:border-yellow-800' : 'border-red-200 dark:border-red-800';
}

function catBadge(cat: ErrorCategory) {
  const cls: Record<ErrorCategory, string> = {
    name: 'bg-purple-100 text-purple-700', dayrow: 'bg-blue-100 text-blue-700',
    totals: 'bg-orange-100 text-orange-700', date: 'bg-teal-100 text-teal-700',
    duplicate: 'bg-red-100 text-red-700', meta: 'bg-gray-100 text-gray-700',
  };
  return cls[cat] ?? 'bg-muted text-muted-foreground';
}

function cellTypeCls(type: string) {
  switch (type) {
    case 'n': return 'text-blue-600'; case 's': return 'text-foreground';
    case 'd': return 'text-green-600'; case 'b': return 'text-purple-600';
    default: return 'text-muted-foreground';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── FEHLERLISTE ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function GlobalErrorList({ val }: { val: DocumentValidation }) {
  // Only show structural issues (errors + important warnings), not every missing day
  const issues = [...val.globalIssues, ...val.employeeValidations.flatMap(v => v.issues)]
    .filter(i => i.severity === 'error' || i.severity === 'warning')
    .sort((a, b) => ({ error: 0, warning: 1, info: 2 }[a.severity] - { error: 0, warning: 1, info: 2 }[b.severity]));

  if (issues.length === 0) return (
    <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50/40 dark:border-green-800 dark:bg-green-900/10 px-4 py-2.5">
      <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
      <span className="text-sm font-semibold text-green-700 dark:text-green-400">Keine strukturellen Fehler</span>
    </div>
  );
  const errs = issues.filter(i => i.severity === 'error').length;
  const warns = issues.filter(i => i.severity === 'warning').length;

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2 bg-muted/40 border-b border-border">
        <AlertTriangle className="h-4 w-4 text-yellow-500" />
        <span className="text-xs font-bold uppercase tracking-wide">Strukturfehler</span>
        <div className="flex gap-2 ml-auto text-[11px]">
          {errs > 0   && <span className="text-red-600 font-semibold">{errs} Fehler</span>}
          {warns > 0  && <span className="text-yellow-600 font-semibold">{warns} Warnungen</span>}
        </div>
      </div>
      <div className="max-h-48 overflow-y-auto divide-y divide-border/50">
        {issues.map((issue, i) => (
          <div key={i} className={cn('flex items-start gap-2.5 px-4 py-1.5 text-xs', issue.severity === 'error' ? 'bg-red-50/30 dark:bg-red-900/10' : 'bg-yellow-50/20 dark:bg-yellow-900/10')}>
            <SevIcon s={issue.severity} />
            <div className="flex-1 min-w-0">
              {issue.employeeName && <span className="font-semibold">{issue.employeeName}: </span>}
              <span className="text-muted-foreground">{issue.message}</span>
            </div>
            <span className={cn('text-[9px] font-mono uppercase px-1 py-0.5 rounded shrink-0', catBadge(issue.category))}>{issue.category}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── BLOCK-RASTER ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function empQualityPct(emp: ExcelEmployee): number {
  let s = 0;
  if (emp.name)        s += 25;
  if (emp.weeklyHours) s += 10;
  if (emp.costCenter)  s += 10;
  if      (emp.days.length >= 20) s += 30;
  else if (emp.days.length >= 10) s += 22;
  else if (emp.days.length >= 5)  s += 15;
  else if (emp.days.length >= 1)  s += 8;
  const active = emp.days.filter(d => d.shifts.length > 0 || !!d.absenceCode).length;
  if      (active >= 15) s += 15;
  else if (active >= 5)  s += 10;
  else if (active >= 1)  s += 5;
  if (emp.totals.totalHours) s += 10;
  return Math.min(100, s);
}

function BlockRasterPanel({ employees }: { employees: ExcelEmployee[] }) {
  if (employees.length === 0) return (
    <p className="text-xs text-muted-foreground italic">Keine Blöcke erkannt.</p>
  );
  const totalMerged = employees.filter(e => e.mergedFromCount > 1).length;
  return (
    <div className="space-y-2">
      {totalMerged > 0 && (
        <p className="text-[11px] text-blue-600 dark:text-blue-400 font-medium">
          {totalMerged} Mitarbeiter aus mehreren Teilblöcken zusammengeführt
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] border-collapse font-mono">
          <thead>
            <tr className="border-b border-border text-muted-foreground text-[10px]">
              <th className="text-left py-1 pr-3 font-medium">#</th>
              <th className="text-left py-1 pr-3 font-medium">Name-Zelle</th>
              <th className="text-left py-1 pr-3 font-medium">Name</th>
              <th className="text-left py-1 pr-3 font-medium">Zeilen</th>
              <th className="text-left py-1 pr-3 font-medium">Status</th>
              <th className="text-right py-1 pr-3 font-medium">Tage</th>
              <th className="text-right py-1 pr-3 font-medium">Zeitbl.</th>
              <th className="text-right py-1 pr-3 font-medium">Totale</th>
              <th className="text-right py-1 font-medium">Qual.</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((emp, i) => {
              const shiftCount = emp.days.reduce((s, d) => s + d.shifts.length, 0);
              const totalCount = Object.values(emp.totals).filter(Boolean).length;
              const q          = empQualityPct(emp);
              const isMerged   = emp.mergedFromCount > 1;
              const rowRange   = isMerged
                ? emp.mergedBlockRows.map(([s, e]) => `${s}–${e}`).join(' + ')
                : `${emp.blockStartRow}–${emp.blockEndRow ?? '?'}`;
              return (
                <tr key={i} className={cn('border-b border-border/40 hover:bg-muted/20', isMerged && 'bg-blue-50/20 dark:bg-blue-900/10')}>
                  <td className="py-0.5 pr-3 text-primary font-bold">{i + 1}</td>
                  <td className="py-0.5 pr-3 text-primary">{emp.rawBlock.nameCell}</td>
                  <td className="py-0.5 pr-3 font-sans font-semibold">
                    {emp.name ?? <span className="text-red-500">—</span>}
                  </td>
                  <td className="py-0.5 pr-3 text-[10px]">{rowRange}</td>
                  <td className="py-0.5 pr-3">
                    {isMerged && (
                      <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-100 border border-blue-300 text-blue-700 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-400">
                        ⊞ Merged ×{emp.mergedFromCount}
                      </span>
                    )}
                  </td>
                  <td className={cn('py-0.5 pr-3 text-right tabular-nums', emp.days.length === 0 ? 'text-red-500' : 'text-green-600')}>{emp.days.length}</td>
                  <td className="py-0.5 pr-3 text-right tabular-nums">{shiftCount}</td>
                  <td className={cn('py-0.5 pr-3 text-right tabular-nums', totalCount === 0 ? 'text-muted-foreground' : 'text-green-600')}>{totalCount}</td>
                  <td className={cn('py-0.5 text-right tabular-nums font-bold', q >= 80 ? 'text-green-600' : q >= 50 ? 'text-yellow-600' : 'text-red-500')}>{q}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TAGESZEILEN-TABELLE ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function DayRowsTable({ days }: { days: DayRecord[] }) {
  if (days.length === 0) return <p className="text-[11px] text-muted-foreground italic">Keine Tageszeilen erkannt.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            {['Datum', 'Tag', 'Zeitblock', 'Pause', 'Total h', 'Absenz', 'Notiz', 'Q'].map(h => (
              <th key={h} className="text-left py-1 pr-3 font-medium last:pr-0">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d, i) => (
            <tr key={i} className={cn('border-b border-border/40', d.confidence === 'low' ? 'bg-red-50/30 dark:bg-red-900/10' : d.confidence === 'medium' ? 'bg-yellow-50/20 dark:bg-yellow-900/10' : '')}>
              <td className="py-0.5 pr-3 font-mono">{d.date ?? '—'}</td>
              <td className="py-0.5 pr-3">{d.weekday ?? '—'}</td>
              <td className="py-0.5 pr-3 font-mono text-[10px]">
                {d.shifts.length > 0 ? d.shifts.map(s => `${s.from}–${s.to}`).join(' / ') : <span className="text-muted-foreground">—</span>}
                {d.shifts.length > 1 && <span className="ml-1 text-blue-500">×{d.shifts.length}</span>}
              </td>
              <td className="py-0.5 pr-3 font-mono">{d.breakMinutes != null ? `${d.breakMinutes} min` : '—'}</td>
              <td className="py-0.5 pr-3 font-mono font-semibold">{d.totalHours ?? '—'}</td>
              <td className="py-0.5 pr-3">{d.absenceCode ? <span className="text-purple-600 font-semibold">{d.absenceCode}</span> : '—'}</td>
              <td className="py-0.5 pr-3 text-muted-foreground max-w-[120px] truncate">{d.notes ?? '—'}</td>
              <td className="py-0.5">{d.confidence === 'high' ? <span className="text-green-600">✓</span> : d.confidence === 'medium' ? <span className="text-yellow-600">⚠</span> : <span className="text-red-600">✗</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MITARBEITERKARTE ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function TotalsCheck({ tp }: { tp: EmployeeValidation['totalsPresent'] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {([['Total h', tp.totalHours], ['Pause', tp.pause], ['Überzeit', tp.ueberzeit], ['Saldo', tp.saldo], ['Ferien', tp.ferien]] as [string, boolean][]).map(([l, ok]) => (
        <span key={l} className={cn('text-[10px] px-1.5 py-0.5 rounded border font-medium', ok ? 'bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400' : 'bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400')}>
          {ok ? '✓' : '✗'} {l}
        </span>
      ))}
    </div>
  );
}

function EmployeeCard({ emp, ev, index }: { emp: ExcelEmployee; ev: EmployeeValidation; index: number }) {
  const [expanded,  setExpanded]  = useState(false);
  const [showDays,  setShowDays]  = useState(false);
  const hasErrors   = ev.issues.some(i => i.severity === 'error');
  const hasWarnings = ev.issues.some(i => i.severity === 'warning');
  const isMerged    = emp.mergedFromCount > 1;
  const q           = empQualityPct(emp);

  return (
    <Card className={cn('border', cardBorder(ev.importStatus), isMerged && 'ring-1 ring-blue-200 dark:ring-blue-800')}>
      <button className="w-full text-left" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-center justify-between px-4 py-2.5">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold">{index + 1}</div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <p className="text-sm font-bold truncate">{emp.name ?? <span className="text-red-500 italic">Name fehlt</span>}</p>
                {isMerged && (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-100 border border-blue-300 text-blue-700 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-400 shrink-0">
                    ⊞ Merged ×{emp.mergedFromCount}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground">
                {emp.costCenter ?? '—'}{emp.weeklyHours ? ` · ${emp.weeklyHours} h/W` : ''}{' · '}
                {isMerged
                  ? `Zeilen: ${emp.mergedBlockRows.map(([s, e]) => `${s}–${e}`).join(' + ')}`
                  : `Zeile ${emp.blockStartRow}–${emp.blockEndRow ?? '?'}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            <span className="text-[11px] text-muted-foreground hidden sm:block">
              {ev.dayRowsCount} Tage · {emp.days.reduce((s, d) => s + d.shifts.length, 0)} Zeitbl.
              {' · '}<span className={cn('font-semibold', q >= 80 ? 'text-green-600' : q >= 50 ? 'text-yellow-600' : 'text-red-500')}>{q}%</span>
            </span>
            {hasErrors && <XCircle className="h-3.5 w-3.5 text-red-500" />}
            {!hasErrors && hasWarnings && <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />}
            {!hasErrors && !hasWarnings && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
            <StatusBadge status={ev.importStatus} />
            {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-4">
          {/* Merged sub-blocks info */}
          {isMerged && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] rounded border border-blue-200 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-900/10 px-3 py-2">
              <span className="font-bold text-blue-700 dark:text-blue-400">⊞ {emp.mergedFromCount} Teilblöcke zusammengeführt:</span>
              {emp.mergedBlockRows.map(([s, e], idx) => (
                <span key={idx} className="font-mono text-blue-600 dark:text-blue-400">Zeile {s}–{e}</span>
              ))}
            </div>
          )}

          {/* Stammdaten */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            {[
              ['Name', emp.name], ['Kostenstelle', emp.costCenter],
              ['Abteilung', emp.department], ['Wochenstunden', emp.weeklyHours ? `${emp.weeklyHours} h` : null],
              ['Arbeitsverhältnis', emp.employmentPeriod], ['Sheet', emp.sheetName],
              ['Qualität', `${q}%`],
            ].map(([l, v]) => v ? (
              <div key={String(l)}><p className="text-muted-foreground mb-0.5">{l}</p><p className="font-semibold truncate">{v}</p></div>
            ) : null)}
          </div>

          {/* Rohzellen */}
          <div className="text-[10px] font-mono text-muted-foreground bg-muted/30 rounded p-2 space-y-0.5">
            <div>Marker: <span className="text-primary">{emp.rawBlock.markerCell}</span> · Name: <span className="text-primary">{emp.rawBlock.nameCell}</span> · Stunden: <span className="text-primary">{emp.rawBlock.weeklyHoursCell}</span></div>
            <div>Meta: {emp.rawBlock.metaRowText.slice(0, 120) || '—'}</div>
            <div>Spalten: {Object.entries(emp.rawBlock.detectedColMap).map(([k, v]) => `${k}=${v}`).join(' · ') || '(default)'}</div>
          </div>

          {/* Validierungsfehler */}
          {ev.issues.length > 0 && (
            <div className="space-y-1">
              {ev.issues.map((issue, i) => (
                <div key={i} className="flex items-start gap-2 text-xs"><SevIcon s={issue.severity} /><span className="text-muted-foreground">{issue.message}</span></div>
              ))}
            </div>
          )}

          {/* Totale */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Totale-Prüfung</p>
            <TotalsCheck tp={ev.totalsPresent} />
            {Object.entries(emp.totals).some(([, v]) => !!v) && (
              <div className="flex flex-wrap gap-3 text-xs rounded border border-border bg-muted/20 p-2 mt-2">
                {Object.entries(emp.totals).map(([k, v]) => v ? (
                  <span key={k}><span className="text-muted-foreground">{k}: </span><span className="font-mono font-bold">{v}</span></span>
                ) : null)}
              </div>
            )}
          </div>

          {/* Tageszeilen (ausgeklappt) */}
          <div>
            <button onClick={() => setShowDays(v => !v)} className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
              <Calendar className="h-3.5 w-3.5" />
              {showDays ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              Tageszeilen ({ev.dayRowsCount})
              {ev.multiShiftDays > 0 && <span className="text-blue-600 ml-1">· {ev.multiShiftDays}× Doppelschicht</span>}
              {ev.absenceDays > 0 && <span className="text-purple-600 ml-1">· {ev.absenceDays}× Absenz</span>}
              {ev.missingDates.length > 0 && <span className="text-red-600 ml-1">· {ev.missingDates.length} Tage fehlen</span>}
            </button>
            {showDays && <div className="mt-2"><DayRowsTable days={emp.days} /></div>}
          </div>
        </div>
      )}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── GRID PREVIEW ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function GridPreview({ sheet }: { sheet: SheetAnalysis }) {
  const [filterText, setFilterText] = useState('');
  const [rowStart, setRowStart] = useState(1);
  const [rowEnd,   setRowEnd]   = useState(Math.min(100, sheet.totalRows));
  const [nonEmpty, setNonEmpty] = useState(true);
  const [matchIdx, setMatchIdx] = useState(0);
  const tableRef = useRef<HTMLDivElement>(null);

  const filteredCells = useMemo(() => {
    const lo = rowStart - 1, hi = rowEnd - 1;
    return sheet.cells.filter(c => {
      if (c.row < lo || c.row > hi) return false;
      if (nonEmpty && !c.formatted.trim()) return false;
      if (filterText && !c.formatted.toLowerCase().includes(filterText.toLowerCase())) return false;
      return true;
    });
  }, [sheet.cells, rowStart, rowEnd, nonEmpty, filterText]);

  const rowsMap = useMemo(() => {
    const m = new Map<number, CellData[]>();
    for (const cell of filteredCells) {
      if (!m.has(cell.row)) m.set(cell.row, []);
      m.get(cell.row)!.push(cell);
    }
    return m;
  }, [filteredCells]);

  const sortedRows = useMemo(() => Array.from(rowsMap.keys()).sort((a, b) => a - b), [rowsMap]);

  const searchMatches = useMemo(() => {
    if (!filterText) return [];
    return sheet.cells.filter(c => c.formatted.toLowerCase().includes(filterText.toLowerCase())).map(c => c.row);
  }, [sheet.cells, filterText]);

  const jumpToNext = useCallback(() => {
    if (!searchMatches.length) return;
    const next = (matchIdx + 1) % searchMatches.length;
    setMatchIdx(next);
    const tr = searchMatches[next] + 1;
    setRowStart(Math.max(1, tr - 5));
    setRowEnd(Math.min(sheet.totalRows, tr + 20));
  }, [matchIdx, searchMatches, sheet.totalRows]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[160px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={filterText} onChange={e => { setFilterText(e.target.value); setMatchIdx(0); }} placeholder="Suchen: Name, TOTAL, Kostenstelle …" className="pl-8 h-8 text-xs" />
        </div>
        {filterText && searchMatches.length > 0 && (
          <Button size="sm" variant="outline" onClick={jumpToNext} className="gap-1 h-8 text-xs">
            <ArrowRight className="h-3.5 w-3.5" />Nächster ({matchIdx + 1}/{searchMatches.length})
          </Button>
        )}
        <div className="flex items-center gap-1 text-xs">
          <span className="text-muted-foreground">Zeile</span>
          <Input value={rowStart} onChange={e => setRowStart(Math.max(1, parseInt(e.target.value) || 1))} className="w-16 h-8 text-xs text-center" type="number" min={1} max={sheet.totalRows} />
          <span className="text-muted-foreground">–</span>
          <Input value={rowEnd} onChange={e => setRowEnd(Math.min(sheet.totalRows, parseInt(e.target.value) || 100))} className="w-16 h-8 text-xs text-center" type="number" min={1} max={sheet.totalRows} />
        </div>
        <label className="flex items-center gap-1 text-xs cursor-pointer">
          <input type="checkbox" checked={nonEmpty} onChange={e => setNonEmpty(e.target.checked)} className="rounded" />
          <span className="text-muted-foreground">Nur befüllt</span>
        </label>
        <span className="text-[10px] text-muted-foreground">{sortedRows.length} Zeilen · {filteredCells.length} Zellen</span>
      </div>

      <div ref={tableRef} className="overflow-x-auto max-h-[460px] overflow-y-auto border border-border rounded">
        <table className="w-full text-[11px] border-collapse font-mono">
          <thead className="sticky top-0 bg-muted/90 backdrop-blur z-10">
            <tr className="border-b border-border">
              <th className="text-left px-2 py-1 font-medium text-muted-foreground border-r border-border w-10">Z.</th>
              <th className="text-left px-2 py-1 font-medium text-muted-foreground">Zellen</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(rowIdx => {
              const rowCells = rowsMap.get(rowIdx)!.sort((a, b) => a.col - b.col);
              const isMatch  = filterText && rowCells.some(c => c.formatted.toLowerCase().includes(filterText.toLowerCase()));
              return (
                <tr key={rowIdx} className={cn('border-b border-border/40 hover:bg-muted/20', isMatch && 'bg-yellow-50/60 dark:bg-yellow-900/20')}>
                  <td className="px-2 py-0.5 text-muted-foreground border-r border-border/40 tabular-nums w-10">{rowIdx + 1}</td>
                  <td className="px-2 py-0.5">
                    <div className="flex flex-wrap gap-3">
                      {rowCells.map(cell => (
                        <span key={cell.addr} className={cn('inline-flex items-center gap-1', cell.isMerged && 'underline decoration-dotted')}>
                          <span className="text-primary font-bold text-[10px]">{cell.addr}</span>
                          <span className={cn('text-[8px] px-0.5 rounded bg-muted', cellTypeCls(cell.type))}>{cell.type || '?'}</span>
                          <span className={cn('max-w-[180px] truncate', isMatch && cell.formatted.toLowerCase().includes(filterText.toLowerCase()) ? 'bg-yellow-200 dark:bg-yellow-800 rounded px-0.5' : '')}>
                            {cell.formatted}
                          </span>
                          {cell.isMerged && <span className="text-[8px] text-amber-600">⊠</span>}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
            {sortedRows.length === 0 && (
              <tr><td colSpan={2} className="text-center py-6 text-xs text-muted-foreground">Keine Zellen im gewählten Bereich / Filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── EXCEL STRUKTUR SEKTION ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function ExcelStructureSection({ doc, val, analyses }: { doc: ExcelParsedDocument; val: DocumentValidation; analyses: SheetAnalysis[] }) {
  const [expanded,     setExpanded]     = useState(false);
  const [selectedSheet, setSelectedSheet] = useState(0);
  const sheet = analyses[selectedSheet];
  if (!sheet) return null;

  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-800 overflow-hidden">
      <div
        role="button" tabIndex={0}
        className="w-full flex items-center justify-between px-4 py-3 bg-amber-50/60 dark:bg-amber-900/20 cursor-pointer select-none"
        onClick={() => setExpanded(e => !e)}
        onKeyDown={ev => ev.key === 'Enter' && setExpanded(e => !e)}
      >
        <div className="flex items-center gap-2">
          <Table2 className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <span className="text-sm font-bold text-amber-800 dark:text-amber-300">Excel Grid Analyse</span>
          <span className="text-[10px] text-amber-600">{analyses.length} Sheet{analyses.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={e => { e.stopPropagation(); exportStructureJson(doc, val, analyses); }}
            className="gap-1 h-7 text-[11px] border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-400">
            <Download className="h-3 w-3" />Struktur JSON
          </Button>
          {expanded ? <ChevronUp className="h-4 w-4 text-amber-600" /> : <ChevronDown className="h-4 w-4 text-amber-600" />}
        </div>
      </div>

      {expanded && (
        <div className="p-4 space-y-5 bg-amber-50/20 dark:bg-amber-900/10">
          {analyses.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {analyses.map((a, i) => (
                <button key={i} onClick={() => setSelectedSheet(i)}
                  className={cn('text-xs px-2.5 py-1 rounded border transition-colors', i === selectedSheet ? 'bg-amber-600 text-white border-amber-600' : 'border-amber-200 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-400')}>
                  {a.sheetName}
                </button>
              ))}
            </div>
          )}

          {/* Sheet-Metadaten */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            {[['Bereich', sheet.ref || '—'], ['Zeilen', sheet.totalRows], ['Spalten', sheet.totalCols], ['Nicht-leere Zellen', sheet.nonEmptyCells], ['Merge-Bereiche', sheet.merges.length], ['Ausgebl. Zeilen', sheet.hiddenRows.length]].map(([l, v]) => (
              <div key={String(l)} className="rounded border border-amber-200 dark:border-amber-800 bg-white dark:bg-background p-2.5">
                <p className="text-[10px] text-amber-600 mb-0.5">{l}</p>
                <p className="text-sm font-bold">{v}</p>
              </div>
            ))}
          </div>

          {/* Merges */}
          {sheet.merges.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 mb-1.5">Merge-Bereiche ({sheet.merges.length})</p>
              <div className="flex flex-wrap gap-1.5">
                {sheet.merges.map((m, i) => <span key={i} className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 text-amber-800">{m.range} ({m.rows}R×{m.cols}C)</span>)}
              </div>
            </div>
          )}

          {/* Block-Kandidaten */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 mb-1.5">Block-Kandidaten ({sheet.blockCandidates.length})</p>
            {sheet.blockCandidates.length === 0
              ? <p className="text-xs text-muted-foreground italic">Kein „Name / Vorname" in Spalte C gefunden.</p>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px] border-collapse font-mono">
                    <thead><tr className="border-b border-border text-muted-foreground text-[10px]">{['#', 'Start', 'Ende', 'Auslöser', 'Name-Zelle', 'Tage', 'Q%'].map(h => <th key={h} className="text-left py-1 pr-3 font-medium">{h}</th>)}</tr></thead>
                    <tbody>
                      {sheet.blockCandidates.map((b, i) => (
                        <tr key={i} className="border-b border-border/40">
                          <td className="py-0.5 pr-3 text-primary font-bold">{i + 1}</td>
                          <td className="py-0.5 pr-3">{b.startRow}</td>
                          <td className="py-0.5 pr-3">{b.endRow ?? '—'}</td>
                          <td className="py-0.5 pr-3 text-primary">{b.triggerCell}</td>
                          <td className="py-0.5 pr-3 max-w-[200px] truncate font-sans">{b.possibleNameCell ?? '—'}</td>
                          <td className="py-0.5 pr-3">{b.dayRowCount}</td>
                          <td className={cn('py-0.5 font-bold', b.qualityScore >= 70 ? 'text-green-600' : b.qualityScore >= 40 ? 'text-yellow-600' : 'text-red-600')}>{b.qualityScore}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </div>

          {/* Raw Grid */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 mb-1.5">Raw Grid Preview — „{sheet.sheetName}"</p>
            <GridPreview sheet={sheet} />
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── DOKUMENT-ERGEBNIS ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function DocumentResult({ doc, val, analyses }: { doc: ExcelParsedDocument; val: DocumentValidation; analyses: SheetAnalysis[] }) {
  const [showRaster, setShowRaster] = useState(true);
  const q  = doc.quality;
  const qc = q.qualityPercent >= 85 ? 'bg-green-100 text-green-800 border-green-300' : q.qualityPercent >= 50 ? 'bg-yellow-100 text-yellow-800 border-yellow-300' : 'bg-red-100 text-red-800 border-red-300';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-bold flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />{doc.fileName}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {doc.monthName ?? '–'} {doc.year ?? '–'} · {doc.employees.length} Mitarbeiter · {doc.sheetsProcessed.join(', ') || 'kein Sheet erkannt'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('text-sm font-bold px-3 py-1 rounded-full border', qc)}>{q.qualityPercent}% Qualität</span>
          <Button size="sm" variant="outline" onClick={() => exportDebugJson(doc, val)} className="gap-1.5 text-xs h-8">
            <Download className="h-3.5 w-3.5" />Debug JSON
          </Button>
        </div>
      </div>

      {/* Zusammenfassung */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {[
          { l: 'Mitarbeiter', v: q.totalEmployees, ok: q.totalEmployees > 0 },
          { l: 'Mit Name', v: q.employeesWithName, ok: q.employeesWithName === q.totalEmployees },
          { l: 'Mit Tagen', v: q.employeesWithDays, ok: q.employeesWithDays > 0 },
          { l: 'Mit Totalen', v: q.employeesWithTotals, ok: q.employeesWithTotals > 0 },
          { l: 'Tageszeilen', v: q.totalDayRecords, ok: q.totalDayRecords > 0 },
          { l: 'Mit Zeitdaten', v: q.daysWithShifts, ok: q.daysWithShifts > 0 },
        ].map(({ l, v, ok }) => (
          <div key={l} className={cn('rounded border p-2', ok ? 'border-green-200 bg-green-50/30 dark:border-green-800' : 'border-red-200 bg-red-50/30 dark:border-red-800')}>
            <p className="text-[10px] text-muted-foreground">{l}</p>
            <p className="text-lg font-bold tabular-nums">{v}</p>
          </div>
        ))}
      </div>

      {/* Parser-Warnungen */}
      {doc.warnings.length > 0 && (
        <div className="rounded border border-yellow-200 bg-yellow-50/40 dark:border-yellow-800 p-3 space-y-1">
          {doc.warnings.map((w, i) => <p key={i} className="flex items-start gap-1.5 text-xs text-yellow-800 dark:text-yellow-300"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />{w}</p>)}
        </div>
      )}

      {/* Grid Analyse */}
      <ExcelStructureSection doc={doc} val={val} analyses={analyses} />

      {/* Block-Raster */}
      <div className="rounded-xl border border-border overflow-hidden">
        <button className="w-full flex items-center justify-between px-4 py-3 bg-muted/30" onClick={() => setShowRaster(v => !v)}>
          <div className="flex items-center gap-2">
            <Grid3x3 className="h-4 w-4 text-primary" />
            <span className="text-sm font-bold">Block-Raster</span>
            <span className="text-xs text-muted-foreground">{doc.employees.length} erkannte Blöcke</span>
          </div>
          {showRaster ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>
        {showRaster && <div className="p-4"><BlockRasterPanel employees={doc.employees} /></div>}
      </div>

      {/* Fehlerliste */}
      <GlobalErrorList val={val} />

      {/* Import-Status */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { l: 'Importfähig', v: val.summary.ready,   col: 'green' },
          { l: 'Prüfen',      v: val.summary.review,  col: 'yellow' },
          { l: 'Blockiert',   v: val.summary.blocked, col: 'red' },
        ].map(({ l, v, col }) => (
          <div key={l} className={cn('rounded-lg border p-3 text-center', col === 'green' ? 'border-green-200 bg-green-50/50 dark:border-green-800' : col === 'yellow' ? 'border-yellow-200 bg-yellow-50/50 dark:border-yellow-800' : 'border-red-200 bg-red-50/50 dark:border-red-800')}>
            <p className="text-2xl font-bold tabular-nums">{v}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{l}</p>
          </div>
        ))}
      </div>

      {/* Mitarbeiterkarten (eingeklappt) */}
      {doc.employees.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <User className="h-3.5 w-3.5" />Mitarbeiter ({doc.employees.length}) — anklicken zum Aufklappen
          </p>
          {doc.employees.map((emp, i) => (
            <EmployeeCard key={i} emp={emp} ev={val.employeeValidations[i]} index={i} />
          ))}
        </div>
      ) : (
        <Card className="border-dashed">
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            Keine Mitarbeiter erkannt — Block-Raster und Grid Analyse oben prüfen.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── DROPZONE ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    onFiles(Array.from(e.dataTransfer.files).filter(f => /\.(xls|xlsx)$/.test(f.name)));
  }, [onFiles]);
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onFiles(Array.from(e.target.files ?? [])); e.target.value = '';
  }, [onFiles]);
  return (
    <label className={cn('flex flex-col items-center gap-3 rounded-xl border-2 border-dashed cursor-pointer transition-colors p-10', dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/60 hover:bg-muted/30')}
      onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={handleDrop}>
      <Upload className="h-10 w-10 text-muted-foreground" />
      <div className="text-center">
        <p className="text-sm font-semibold">Excel-Dateien hochladen</p>
        <p className="text-xs text-muted-foreground mt-0.5">.xls / .xlsx — mehrere Dateien gleichzeitig möglich</p>
      </div>
      <input type="file" className="sr-only" multiple accept=".xls,.xlsx" onChange={handleChange} />
    </label>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HAUPTSEITE ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

interface ParseResult { doc: ExcelParsedDocument; val: DocumentValidation; analyses: SheetAnalysis[]; fileName: string }

export default function MirusExcelTest() {
  const [results,  setResults]  = useState<ParseResult[]>([]);
  const [errors,   setErrors]   = useState<{ error: string; fileName: string }[]>([]);
  const [parsing,  setParsing]  = useState(false);

  const handleFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setParsing(true);
    const newR: ParseResult[] = [];
    const newE: { error: string; fileName: string }[] = [];

    await Promise.all(files.map(async (file) => {
      try {
        const [doc, analyses] = await Promise.all([parseMirusExcel(file), analyzeExcelFile(file)]);
        newR.push({ doc, val: validateDocument(doc), analyses, fileName: file.name });
      } catch (err) {
        newE.push({ error: String(err), fileName: file.name });
      }
    }));

    setResults(prev => [...newR, ...prev]);
    setErrors(prev => [...newE, ...prev]);
    setParsing(false);
  }, []);

  const bestQ = results.reduce((m, r) => Math.max(m, r.doc.quality.qualityPercent), 0);

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border bg-card sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold flex items-center gap-2"><Table2 className="h-5 w-5 text-primary" />Mirus Excel — Koordinatenbasierter Parser</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Diagnostisch · kein Speichern · kein Supabase</p>
          </div>
          {results.length > 0 && (
            <div className="flex items-center gap-3">
              <span className={cn('font-bold text-sm', bestQ >= 85 ? 'text-green-600' : bestQ >= 50 ? 'text-yellow-600' : 'text-red-600')}>Beste Qualität: {bestQ}%</span>
              <button onClick={() => { setResults([]); setErrors([]); }} className="text-xs text-muted-foreground hover:text-foreground underline">Alle löschen</button>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-8">
        <DropZone onFiles={handleFiles} />

        {parsing && (
          <div className="flex items-center justify-center gap-3 py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Koordinatenbasierte Analyse läuft …</span>
          </div>
        )}

        {errors.map((e, i) => (
          <div key={i} className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50/40 dark:border-red-800 p-4">
            <XCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
            <div><p className="text-sm font-semibold text-red-600">{e.fileName}</p><p className="text-xs text-muted-foreground mt-1">{e.error}</p></div>
          </div>
        ))}

        {results.map((r, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-5">
            <DocumentResult doc={r.doc} val={r.val} analyses={r.analyses} />
          </div>
        ))}

        {!results.length && !errors.length && !parsing && (
          <div className="text-center py-10 text-muted-foreground">
            <Table2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Datei hochladen zum Starten der Analyse.</p>
            <p className="text-xs mt-1">Sucht nach „Name / Vorname" in Spalte C und liest M(r) als Namen.</p>
          </div>
        )}
      </div>
    </div>
  );
}
