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
  User, Calendar, Hash, Clock, Loader2, Table2,
  Download, Search, ArrowRight,
} from 'lucide-react';
import { parseMirusExcel } from '@/lib/mirus-excel-parser';
import type { ExcelParsedDocument, ExcelEmployee } from '@/lib/mirus-excel-parser';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// ═══════════════════════════════════════════════════════════════════════════════
// ─── VALIDIERUNGS-TYPEN ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

type Severity = 'error' | 'warning' | 'info';
type ErrorCategory = 'name' | 'dayrow' | 'totals' | 'date' | 'timeblock' | 'duplicate' | 'meta';

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
  multiTimeBlockDays: string[];
  absenceDays: { date: string; codes: string[] }[];
  totalsPresent: { totalHours: boolean; pause: boolean; ueberzeit: boolean; saldo: boolean; ferien: boolean };
  importStatus: 'ready' | 'review' | 'blocked';
}

interface DocumentValidation {
  employeeValidations: EmployeeValidation[];
  globalIssues: ValidationIssue[];
  summary: { total: number; ready: number; review: number; blocked: number; totalErrors: number; totalWarnings: number };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── STRUKTUR-ANALYSE-TYPEN ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

interface CellData {
  addr: string;
  row: number;     // 0-based
  col: number;     // 0-based
  colLetter: string;
  value: string | number | boolean | null;
  formatted: string;
  type: string;    // 'n' | 's' | 'b' | 'd' | 'e' | 'z' | ''
  formula?: string;
  isMerged: boolean;
  mergeRange?: string;
}

interface MergeInfo { range: string; rows: number; cols: number; topLeft: string }

interface BlockCandidate {
  startRow: number;      // 1-based
  endRow: number | null;
  triggerKeyword: string;
  triggerCell: string;
  possibleNameCell?: string;
  possibleKostenstelleCell?: string;
  possibleTotalRow?: number;
  dayRowCount: number;
  qualityScore: number;  // 0–100
}

interface SheetAnalysis {
  sheetName: string;
  ref: string;
  totalRows: number;
  totalCols: number;
  nonEmptyCells: number;
  merges: MergeInfo[];
  hiddenRows: number[];
  hiddenColLetters: string[];
  cells: CellData[];
  blockCandidates: BlockCandidate[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── STRUKTUR-ANALYSE-LOGIK ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const BLOCK_KEYWORDS = ['Name / Vorname', 'Name/Vorname', 'Kostenstelle', 'Wöchentliche Arbeitszeit', 'TOTAL', 'Unterschrift'];
const DATE_PATTERN = /^\d{1,2}\.\d{1,2}\.?(\d{2,4})?$/;

function buildMergeMap(ws: XLSX.WorkSheet): Map<string, string> {
  const map = new Map<string, string>();
  const merges: XLSX.Range[] = (ws['!merges'] as XLSX.Range[] | undefined) ?? [];
  for (const m of merges) {
    const rangeStr = XLSX.utils.encode_range(m);
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        map.set(XLSX.utils.encode_cell({ r, c }), rangeStr);
      }
    }
  }
  return map;
}

function analyzeBlocks(cells: CellData[], totalRows: number): BlockCandidate[] {
  const candidates: BlockCandidate[] = [];

  // Build row-text map for fast scanning
  const rowText = new Map<number, string[]>();
  for (const cell of cells) {
    if (!rowText.has(cell.row)) rowText.set(cell.row, []);
    rowText.get(cell.row)!.push(cell.formatted);
  }

  const rows = Array.from(rowText.entries()).sort((a, b) => a[0] - b[0]);

  for (const [rowIdx, texts] of rows) {
    const joined = texts.join(' ');
    if (!/Name\s*\/\s*Vorname/i.test(joined)) continue;

    // Found a potential employee block start
    const triggerCell = cells.find(c => c.row === rowIdx && /Name\s*\/\s*Vorname/i.test(c.formatted))?.addr ?? `?${rowIdx + 1}`;

    // Scan forward for name cell (non-label, non-empty, alphabetic)
    let possibleNameCell: string | undefined;
    for (const cell of cells.filter(c => c.row === rowIdx && c.type === 's')) {
      if (!/Name\s*\/\s*Vorname|Wöchentliche|Personal/i.test(cell.formatted) && /^[\p{L}\s'\-]{2,}/u.test(cell.formatted)) {
        possibleNameCell = `${cell.addr}="${cell.formatted}"`;
        break;
      }
    }

    // Scan next 5 rows for Kostenstelle
    let possibleKostenstelleCell: string | undefined;
    for (let r = rowIdx + 1; r <= Math.min(rowIdx + 5, totalRows); r++) {
      const rTexts = rowText.get(r) ?? [];
      if (rTexts.some(t => /Kostenstelle/i.test(t))) {
        const ksCell = cells.find(c => c.row === r && /Kostenstelle/i.test(c.formatted));
        if (ksCell) { possibleKostenstelleCell = ksCell.addr; break; }
      }
    }

    // Scan forward for TOTAL row and count date-like rows
    let possibleTotalRow: number | undefined;
    let dayRowCount = 0;
    let endRow: number | null = null;
    for (let r = rowIdx + 1; r < Math.min(rowIdx + 45, totalRows); r++) {
      const rTexts = rowText.get(r) ?? [];
      const rJoined = rTexts.join(' ');
      if (DATE_PATTERN.test(rTexts[0] ?? '')) dayRowCount++;
      if (/^\s*TOTAL\b/i.test(rJoined) || /unterschrift/i.test(rJoined)) {
        possibleTotalRow = r + 1;
        endRow = r + 1;
        break;
      }
    }

    // Quality score
    let score = 0;
    if (possibleNameCell) score += 40;
    if (possibleKostenstelleCell) score += 20;
    if (dayRowCount > 0) score += Math.min(dayRowCount * 2, 30);
    if (possibleTotalRow) score += 10;

    candidates.push({
      startRow: rowIdx + 1, endRow,
      triggerKeyword: 'Name / Vorname', triggerCell,
      possibleNameCell, possibleKostenstelleCell,
      possibleTotalRow, dayRowCount,
      qualityScore: Math.min(score, 100),
    });
  }

  return candidates;
}

async function analyzeExcelFile(file: File): Promise<SheetAnalysis[]> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true, cellNF: true, cellText: true, sheetStubs: true });
  const analyses: SheetAnalysis[] = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const ref = ws['!ref'] ?? '';
    if (!ref) { analyses.push({ sheetName, ref: '', totalRows: 0, totalCols: 0, nonEmptyCells: 0, merges: [], hiddenRows: [], hiddenColLetters: [], cells: [], blockCandidates: [] }); continue; }

    const range = XLSX.utils.decode_range(ref);
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;

    // Merge map
    const mergeMap = buildMergeMap(ws);
    const rawMerges: XLSX.Range[] = (ws['!merges'] as XLSX.Range[] | undefined) ?? [];
    const merges: MergeInfo[] = rawMerges.map(m => ({
      range: XLSX.utils.encode_range(m),
      rows: m.e.r - m.s.r + 1,
      cols: m.e.c - m.s.c + 1,
      topLeft: XLSX.utils.encode_cell(m.s),
    }));

    // Hidden rows / cols
    const wsRows: { hidden?: boolean }[] = (ws['!rows'] as { hidden?: boolean }[] | undefined) ?? [];
    const wsCols: { hidden?: boolean }[] = (ws['!cols'] as { hidden?: boolean }[] | undefined) ?? [];
    const hiddenRows = wsRows.map((r, i) => r?.hidden ? i + 1 : -1).filter(i => i > 0);
    const hiddenColLetters = wsCols.map((c, i) => c?.hidden ? XLSX.utils.encode_col(i) : '').filter(Boolean);

    // Read all cells
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

        cells.push({
          addr,
          row: r, col: c,
          colLetter: XLSX.utils.encode_col(c),
          value, formatted,
          type: cell.t ?? '',
          formula: cell.f,
          isMerged: mergeMap.has(addr),
          mergeRange: mergeMap.get(addr),
        });
      }
    }

    const blockCandidates = analyzeBlocks(cells, range.e.r + 1);

    analyses.push({ sheetName, ref, totalRows, totalCols, nonEmptyCells, merges, hiddenRows, hiddenColLetters, cells, blockCandidates });
  }

  return analyses;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── VALIDIERUNGS-LOGIK ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const DIRTY_NAME_TOKENS = ['Wöchentliche', 'Kostenstelle', 'Arbeitsverhältnis', 'TOTAL', 'Personal', 'Betrieb', 'Arbeitszeit', 'Stunden'];

function getExpectedDays(month: number, year: number): string[] {
  const count = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, '0');
  return Array.from({ length: count }, (_, i) => `${String(i + 1).padStart(2, '0')}.${mm}`);
}

function normalizeName(name: string | null): string {
  return (name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function validateEmployee(emp: ExcelEmployee, index: number, allEmployees: ExcelEmployee[], expectedDays: string[]): EmployeeValidation {
  const issues: ValidationIssue[] = [];
  const label = emp.name ?? `Mitarbeiter ${index + 1}`;

  if (!emp.name) {
    issues.push({ severity: 'error', category: 'name', message: 'Name fehlt', employeeName: label, employeeIndex: index });
  } else {
    for (const token of DIRTY_NAME_TOKENS) {
      if (emp.name.includes(token)) {
        issues.push({ severity: 'error', category: 'name', employeeName: label, employeeIndex: index, message: `Name enthält Zusatztext: „${token}"` });
        break;
      }
    }
    if (/\d/.test(emp.name)) issues.push({ severity: 'warning', category: 'name', employeeName: label, employeeIndex: index, message: 'Name enthält Ziffern' });
  }

  const myNorm = normalizeName(emp.name);
  const dupIdx = allEmployees.findIndex((e, i) => i !== index && normalizeName(e.name) === myNorm && myNorm !== '');
  if (dupIdx >= 0) issues.push({ severity: 'error', category: 'duplicate', employeeName: label, employeeIndex: index, message: `Duplikat von Mitarbeiter ${dupIdx + 1} (${allEmployees[dupIdx].name})` });

  if (!emp.kostenstelle) issues.push({ severity: 'warning', category: 'name', employeeName: label, employeeIndex: index, message: 'Kostenstelle fehlt' });
  if (!emp.department)   issues.push({ severity: 'warning', category: 'name', employeeName: label, employeeIndex: index, message: 'Abteilung nicht erkannt' });

  const actualDates  = new Set(emp.dayRows.map(r => r.date).filter(Boolean) as string[]);
  const missingDates = expectedDays.filter(d => !actualDates.has(d));
  if (emp.dayRows.length === 0) issues.push({ severity: 'error', category: 'dayrow', employeeName: label, employeeIndex: index, message: 'Keine Tageszeilen erkannt' });
  else if (missingDates.length > 7) issues.push({ severity: 'error', category: 'date', employeeName: label, employeeIndex: index, message: `${missingDates.length} Tage fehlen` });
  else if (missingDates.length > 0) issues.push({ severity: 'warning', category: 'date', employeeName: label, employeeIndex: index, message: `${missingDates.length} Tage fehlen: ${missingDates.slice(0, 5).join(', ')}${missingDates.length > 5 ? ' …' : ''}` });

  const lowConfRows = emp.dayRows.filter(r => r.confidence === 'low');
  if (lowConfRows.length > 0) issues.push({ severity: 'warning', category: 'dayrow', employeeName: label, employeeIndex: index, message: `${lowConfRows.length} Tageszeile(n) mit schlechter Erkennung` });

  const totalsPresent = { totalHours: !!emp.totals.totalHours, pause: !!emp.totals.pauseTotal, ueberzeit: !!emp.totals.ueberzeit, saldo: !!emp.totals.saldo, ferien: !!emp.totals.ferien };
  if (!totalsPresent.totalHours) issues.push({ severity: 'error', category: 'totals', employeeName: label, employeeIndex: index, message: 'Total Stunden nicht erkannt' });

  const errors   = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const importStatus: 'ready' | 'review' | 'blocked' = errors > 0 ? 'blocked' : warnings > 0 ? 'review' : 'ready';

  return {
    index, name: emp.name, issues,
    dayRowsCount: emp.dayRows.length, expectedDaysCount: expectedDays.length,
    missingDates, multiTimeBlockDays: emp.dayRows.filter(r => r.timeBlocks.length > 1).map(r => r.date ?? '?'),
    absenceDays: emp.dayRows.filter(r => r.absenceCodes.length > 0).map(r => ({ date: r.date ?? '?', codes: r.absenceCodes })),
    totalsPresent, importStatus,
  };
}

function validateDocument(doc: ExcelParsedDocument): DocumentValidation {
  const expectedDays = (doc.month && doc.year) ? getExpectedDays(doc.month, doc.year) : [];
  const globalIssues: ValidationIssue[] = [];
  if (!doc.month) globalIssues.push({ severity: 'error', category: 'meta', message: 'Monat nicht erkannt' });
  if (!doc.year)  globalIssues.push({ severity: 'error', category: 'meta', message: 'Jahr nicht erkannt' });
  if (doc.employees.length === 0) globalIssues.push({ severity: 'error', category: 'meta', message: 'Keine Mitarbeiter gefunden' });

  const employeeValidations = doc.employees.map((emp, i) => validateEmployee(emp, i, doc.employees, expectedDays));
  const allIssues = [...globalIssues, ...employeeValidations.flatMap(v => v.issues)];
  return {
    employeeValidations, globalIssues,
    summary: {
      total: doc.employees.length,
      ready:   employeeValidations.filter(v => v.importStatus === 'ready').length,
      review:  employeeValidations.filter(v => v.importStatus === 'review').length,
      blocked: employeeValidations.filter(v => v.importStatus === 'blocked').length,
      totalErrors:   allIssues.filter(i => i.severity === 'error').length,
      totalWarnings: allIssues.filter(i => i.severity === 'warning').length,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── EXPORT ───────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportDebugJson(doc: ExcelParsedDocument, val: DocumentValidation) {
  downloadJson({
    meta: { fileName: doc.fileName, month: doc.month, monthName: doc.monthName, year: doc.year, restaurant: doc.restaurant, creationDate: doc.creationDate, exportedAt: new Date().toISOString() },
    quality: doc.quality, validationSummary: val.summary, globalIssues: val.globalIssues,
    employees: doc.employees.map((emp, i) => ({
      index: i + 1, name: emp.name, personalnummer: emp.personalnummer, kostenstelle: emp.kostenstelle,
      department: emp.department, employment: emp.employment, weeklyHours: emp.weeklyHours, sheetName: emp.sheetName,
      importStatus: val.employeeValidations[i].importStatus, issues: val.employeeValidations[i].issues,
      dayRowsCount: emp.dayRows.length, expectedDaysCount: val.employeeValidations[i].expectedDaysCount,
      missingDates: val.employeeValidations[i].missingDates, totals: emp.totals,
      dayRows: emp.dayRows.map(r => ({ date: r.date, weekday: r.weekday, timeBlocks: r.timeBlocks.map(b => `${b.from}–${b.to}`), department: r.department, pause: r.pause, totalHours: r.totalHours, absenceCodes: r.absenceCodes, confidence: r.confidence, rawCells: r.rawCells.map(c => ({ cellRef: c.cellRef, row: c.rowIdx + 1, col: c.colIdx + 1, raw: String(c.rawValue ?? ''), formatted: c.formatted })) })),
      rawHeaderCells: emp.rawHeaderCells.map(c => ({ cellRef: c.cellRef, row: c.rowIdx + 1, col: c.colIdx + 1, raw: String(c.rawValue ?? ''), formatted: c.formatted })),
    })),
  }, `mirus-debug-${doc.fileName.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}.json`);
}

function exportStructureJson(doc: ExcelParsedDocument, val: DocumentValidation, analyses: SheetAnalysis[]) {
  downloadJson({
    fileName: doc.fileName, exportedAt: new Date().toISOString(),
    sheets: analyses.map(a => ({
      sheetName: a.sheetName, ref: a.ref, totalRows: a.totalRows, totalCols: a.totalCols,
      nonEmptyCells: a.nonEmptyCells, merges: a.merges,
      hiddenRows: a.hiddenRows, hiddenColLetters: a.hiddenColLetters,
      blockCandidates: a.blockCandidates,
      cellMatrix: a.cells.map(c => ({ addr: c.addr, row: c.row + 1, col: c.col + 1, colLetter: c.colLetter, type: c.type, value: String(c.value ?? ''), formatted: c.formatted, isMerged: c.isMerged, mergeRange: c.mergeRange ?? null, formula: c.formula ?? null })),
    })),
    parsedEmployees: doc.employees.length,
    validationSummary: val.summary,
    globalIssues: val.globalIssues,
  }, `mirus-struktur-${doc.fileName.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}.json`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── UI HELPERS ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function severityIcon(s: Severity) {
  if (s === 'error')   return <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  if (s === 'warning') return <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 shrink-0" />;
  return <Info className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
}

function statusBadge(status: 'ready' | 'review' | 'blocked') {
  if (status === 'ready')   return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-green-50 border-green-300 text-green-700 dark:bg-green-900/20 dark:border-green-700 dark:text-green-400">✓ Importfähig</span>;
  if (status === 'review')  return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-yellow-50 border-yellow-300 text-yellow-700 dark:bg-yellow-900/20 dark:border-yellow-700 dark:text-yellow-400">⚠ Prüfen</span>;
  return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-red-50 border-red-300 text-red-700 dark:bg-red-900/20 dark:border-red-700 dark:text-red-400">✗ Nicht importierbar</span>;
}

function deptBadge(dept: string | null) {
  if (!dept) return 'bg-muted text-muted-foreground';
  if (dept === 'küche') return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
  return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
}

function cellTypeBadge(type: string) {
  switch (type) {
    case 'n': return 'text-blue-600 dark:text-blue-400';
    case 's': return 'text-foreground';
    case 'd': return 'text-green-600 dark:text-green-400';
    case 'b': return 'text-purple-600 dark:text-purple-400';
    case 'e': return 'text-red-600 dark:text-red-400';
    default:  return 'text-muted-foreground';
  }
}

function cellTypeLabel(type: string): string {
  switch (type) { case 'n': return 'num'; case 's': return 'str'; case 'd': return 'date'; case 'b': return 'bool'; case 'e': return 'err'; default: return type || '?'; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── GRID PREVIEW ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function GridPreview({ sheet }: { sheet: SheetAnalysis }) {
  const [filterText, setFilterText] = useState('');
  const [rowStart, setRowStart]     = useState(1);
  const [rowEnd, setRowEnd]         = useState(Math.min(100, sheet.totalRows));
  const [nonEmptyOnly, setNonEmptyOnly] = useState(true);
  const [matchIdx, setMatchIdx]     = useState(0);
  const tableRef = useRef<HTMLDivElement>(null);

  const filteredCells = useMemo(() => {
    const lo = rowStart - 1;  // 0-based
    const hi = rowEnd - 1;
    return sheet.cells.filter(c => {
      if (c.row < lo || c.row > hi) return false;
      if (nonEmptyOnly && !c.formatted.trim()) return false;
      if (filterText && !c.formatted.toLowerCase().includes(filterText.toLowerCase())) return false;
      return true;
    });
  }, [sheet.cells, rowStart, rowEnd, nonEmptyOnly, filterText]);

  // Group by row
  const rowsMap = useMemo(() => {
    const m = new Map<number, CellData[]>();
    for (const cell of filteredCells) {
      if (!m.has(cell.row)) m.set(cell.row, []);
      m.get(cell.row)!.push(cell);
    }
    return m;
  }, [filteredCells]);

  const sortedRows = useMemo(() => Array.from(rowsMap.keys()).sort((a, b) => a - b), [rowsMap]);

  // Search matches (all cells matching filterText, in ALL rows for navigation)
  const searchMatches = useMemo(() => {
    if (!filterText) return [];
    return sheet.cells.filter(c => c.formatted.toLowerCase().includes(filterText.toLowerCase()))
      .map(c => c.row);
  }, [sheet.cells, filterText]);

  const jumpToNext = useCallback(() => {
    if (searchMatches.length === 0) return;
    const nextIdx = (matchIdx + 1) % searchMatches.length;
    setMatchIdx(nextIdx);
    const targetRow = searchMatches[nextIdx] + 1; // 1-based
    setRowStart(Math.max(1, targetRow - 5));
    setRowEnd(Math.min(sheet.totalRows, targetRow + 20));
  }, [matchIdx, searchMatches, sheet.totalRows]);

  return (
    <div className="space-y-3">
      {/* Filter-Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[160px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={filterText}
            onChange={e => { setFilterText(e.target.value); setMatchIdx(0); }}
            placeholder="Suchen: Name, TOTAL, Kostenstelle …"
            className="pl-8 h-8 text-xs"
          />
        </div>
        {filterText && searchMatches.length > 0 && (
          <Button size="sm" variant="outline" onClick={jumpToNext} className="gap-1 h-8 text-xs">
            <ArrowRight className="h-3.5 w-3.5" />
            Nächster Treffer ({matchIdx + 1}/{searchMatches.length})
          </Button>
        )}
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Zeile</span>
          <Input value={rowStart} onChange={e => setRowStart(Math.max(1, parseInt(e.target.value) || 1))} className="w-16 h-8 text-xs text-center" type="number" min={1} max={sheet.totalRows} />
          <span className="text-muted-foreground">–</span>
          <Input value={rowEnd} onChange={e => setRowEnd(Math.min(sheet.totalRows, parseInt(e.target.value) || 100))} className="w-16 h-8 text-xs text-center" type="number" min={1} max={sheet.totalRows} />
        </div>
        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
          <input type="checkbox" checked={nonEmptyOnly} onChange={e => setNonEmptyOnly(e.target.checked)} className="rounded" />
          <span className="text-muted-foreground">Nur befüllte Zellen</span>
        </label>
        <span className="text-[10px] text-muted-foreground">{sortedRows.length} Zeilen · {filteredCells.length} Zellen</span>
      </div>

      {/* Grid-Tabelle */}
      <div ref={tableRef} className="overflow-x-auto max-h-[500px] overflow-y-auto border border-border rounded">
        <table className="w-full text-[11px] border-collapse font-mono">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
            <tr className="border-b border-border">
              <th className="text-left px-2 py-1 font-medium text-muted-foreground w-12 border-r border-border">Zeile</th>
              <th className="text-left px-2 py-1 font-medium text-muted-foreground w-12 border-r border-border">Addr</th>
              <th className="text-left px-2 py-1 font-medium text-muted-foreground w-10 border-r border-border">Typ</th>
              <th className="text-left px-2 py-1 font-medium text-muted-foreground">Wert</th>
              <th className="text-left px-2 py-1 font-medium text-muted-foreground w-24 border-l border-border">Merge</th>
              <th className="text-left px-2 py-1 font-medium text-muted-foreground border-l border-border">Formel</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(rowIdx => {
              const rowCells = rowsMap.get(rowIdx)!.sort((a, b) => a.col - b.col);
              const isSearchMatch = filterText && rowCells.some(c => c.formatted.toLowerCase().includes(filterText.toLowerCase()));
              return (
                <tr key={rowIdx} className={cn('border-b border-border/40 hover:bg-muted/20', isSearchMatch && 'bg-yellow-50/60 dark:bg-yellow-900/20')}>
                  <td className="px-2 py-0.5 text-muted-foreground border-r border-border/40 tabular-nums">{rowIdx + 1}</td>
                  <td className="px-2 py-0.5 border-r border-border/40 space-y-0.5" colSpan={5}>
                    <div className="flex flex-wrap gap-2">
                      {rowCells.map(cell => (
                        <span key={cell.addr} className={cn('inline-flex items-center gap-1', cell.isMerged && 'underline decoration-dotted')}>
                          <span className="text-primary font-bold text-[10px]">{cell.addr}</span>
                          <span className={cn('text-[9px] px-0.5 rounded bg-muted', cellTypeBadge(cell.type))}>{cellTypeLabel(cell.type)}</span>
                          <span className={cn('max-w-[200px] truncate', isSearchMatch && cell.formatted.toLowerCase().includes(filterText.toLowerCase()) && 'bg-yellow-200 dark:bg-yellow-800 rounded px-0.5')}>
                            {cell.formatted}
                          </span>
                          {cell.isMerged && <span className="text-[9px] text-amber-600 dark:text-amber-400">⊠{cell.mergeRange}</span>}
                          {cell.formula && <span className="text-[9px] text-purple-500">ƒ</span>}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sortedRows.length === 0 && (
          <div className="text-center py-8 text-xs text-muted-foreground">
            Keine Zellen für diesen Filter / Bereich.
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── BLOCK-KANDIDATEN ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function BlockCandidatesPanel({ blocks }: { blocks: BlockCandidate[] }) {
  if (blocks.length === 0) return (
    <p className="text-xs text-muted-foreground italic">Keine Mitarbeiterblöcke erkannt (kein „Name / Vorname" gefunden).</p>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="text-left py-1 pr-3 font-medium">#</th>
            <th className="text-left py-1 pr-3 font-medium">Start</th>
            <th className="text-left py-1 pr-3 font-medium">Ende</th>
            <th className="text-left py-1 pr-3 font-medium">Auslöser-Zelle</th>
            <th className="text-left py-1 pr-3 font-medium">Möglicher Name</th>
            <th className="text-left py-1 pr-3 font-medium">Kostenstelle-Zeile</th>
            <th className="text-right py-1 pr-3 font-medium">Tagesdaten</th>
            <th className="text-right py-1 font-medium">Qualität</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((b, i) => (
            <tr key={i} className="border-b border-border/40">
              <td className="py-0.5 pr-3 font-bold text-primary">{i + 1}</td>
              <td className="py-0.5 pr-3 font-mono">{b.startRow}</td>
              <td className="py-0.5 pr-3 font-mono">{b.endRow ?? '—'}</td>
              <td className="py-0.5 pr-3 font-mono text-primary">{b.triggerCell}</td>
              <td className="py-0.5 pr-3 max-w-[200px] truncate">{b.possibleNameCell ?? <span className="text-muted-foreground">—</span>}</td>
              <td className="py-0.5 pr-3 font-mono">{b.possibleKostenstelleCell ?? <span className="text-muted-foreground">—</span>}</td>
              <td className="py-0.5 pr-3 text-right tabular-nums">{b.dayRowCount}</td>
              <td className={cn('py-0.5 text-right font-bold tabular-nums', b.qualityScore >= 70 ? 'text-green-600' : b.qualityScore >= 40 ? 'text-yellow-600' : 'text-red-600')}>
                {b.qualityScore}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── EXCEL STRUKTUR SEKTION ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function ExcelStructureSection({ doc, val, analyses }: { doc: ExcelParsedDocument; val: DocumentValidation; analyses: SheetAnalysis[] }) {
  const [expanded, setExpanded] = useState(true);
  const [selectedSheet, setSelectedSheet] = useState(0);

  const sheet = analyses[selectedSheet];
  if (!sheet) return null;

  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-800 overflow-hidden">
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 bg-amber-50/60 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-2">
          <Table2 className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <span className="text-sm font-bold text-amber-800 dark:text-amber-300">Excel Grid Analyse</span>
          <span className="text-[10px] text-amber-600 dark:text-amber-400">{analyses.length} Sheet{analyses.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm" variant="outline"
            onClick={e => { e.stopPropagation(); exportStructureJson(doc, val, analyses); }}
            className="gap-1 h-7 text-[11px] border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-400"
          >
            <Download className="h-3 w-3" />
            Struktur JSON
          </Button>
          {expanded ? <ChevronUp className="h-4 w-4 text-amber-600" /> : <ChevronDown className="h-4 w-4 text-amber-600" />}
        </div>
      </button>

      {expanded && (
        <div className="p-4 space-y-5 bg-amber-50/20 dark:bg-amber-900/10">

          {/* Sheet-Auswahl */}
          {analyses.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {analyses.map((a, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedSheet(i)}
                  className={cn(
                    'text-xs px-2.5 py-1 rounded border transition-colors',
                    i === selectedSheet
                      ? 'bg-amber-600 text-white border-amber-600'
                      : 'border-amber-200 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-400',
                  )}
                >
                  {a.sheetName}
                </button>
              ))}
            </div>
          )}

          {/* Sheet-Metadaten */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            {[
              { label: 'Bereich (!ref)', value: sheet.ref || '—' },
              { label: 'Zeilen', value: sheet.totalRows },
              { label: 'Spalten', value: sheet.totalCols },
              { label: 'Nicht-leere Zellen', value: sheet.nonEmptyCells },
              { label: 'Merge-Bereiche', value: sheet.merges.length },
              { label: 'Ausgebl. Zeilen', value: sheet.hiddenRows.length },
            ].map(item => (
              <div key={item.label} className="rounded border border-amber-200 dark:border-amber-800 bg-white dark:bg-background p-2.5">
                <p className="text-[10px] text-amber-600 dark:text-amber-400 mb-0.5">{item.label}</p>
                <p className="text-sm font-bold tabular-nums">{item.value}</p>
              </div>
            ))}
          </div>

          {/* Merge-Bereiche */}
          {sheet.merges.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300 mb-2">Merge-Bereiche ({sheet.merges.length})</p>
              <div className="flex flex-wrap gap-1.5">
                {sheet.merges.map((m, i) => (
                  <span key={i} className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300">
                    {m.range} ({m.rows}R×{m.cols}C)
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Ausgeblendete Zeilen/Spalten */}
          {(sheet.hiddenRows.length > 0 || sheet.hiddenColLetters.length > 0) && (
            <div className="flex gap-6 text-xs">
              {sheet.hiddenRows.length > 0 && <span className="text-muted-foreground">Ausgeblendete Zeilen: <span className="font-mono text-foreground">{sheet.hiddenRows.slice(0, 20).join(', ')}{sheet.hiddenRows.length > 20 ? ' …' : ''}</span></span>}
              {sheet.hiddenColLetters.length > 0 && <span className="text-muted-foreground">Ausgeblendete Spalten: <span className="font-mono text-foreground">{sheet.hiddenColLetters.join(', ')}</span></span>}
            </div>
          )}

          {/* Mitarbeiterblock-Analyse */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300 mb-2">
              Mitarbeiterblock-Analyse ({sheet.blockCandidates.length} gefunden)
            </p>
            <BlockCandidatesPanel blocks={sheet.blockCandidates} />
          </div>

          {/* Raw Grid Preview */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300 mb-2">
              Raw Grid Preview — Sheet „{sheet.sheetName}"
            </p>
            <GridPreview sheet={sheet} />
          </div>

        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── VALIDIERUNGS-UI ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function GlobalErrorList({ val }: { val: DocumentValidation }) {
  const allIssues = [...val.globalIssues, ...val.employeeValidations.flatMap(v => v.issues)]
    .sort((a, b) => ({ error: 0, warning: 1, info: 2 }[a.severity] - { error: 0, warning: 1, info: 2 }[b.severity]));

  if (allIssues.length === 0) return (
    <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50/40 dark:border-green-800 dark:bg-green-900/10 px-4 py-3">
      <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
      <span className="text-sm font-semibold text-green-700 dark:text-green-400">Keine Fehler gefunden</span>
    </div>
  );

  const errors = allIssues.filter(i => i.severity === 'error').length;
  const warnings = allIssues.filter(i => i.severity === 'warning').length;

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-muted/40 border-b border-border">
        <AlertTriangle className="h-4 w-4 text-yellow-500" />
        <span className="text-xs font-bold uppercase tracking-wide">Fehlerliste</span>
        <div className="flex items-center gap-2 ml-auto text-[11px]">
          {errors > 0   && <span className="text-red-600 font-semibold">{errors} Fehler</span>}
          {warnings > 0 && <span className="text-yellow-600 font-semibold">{warnings} Warnungen</span>}
        </div>
      </div>
      <div className="max-h-52 overflow-y-auto divide-y divide-border/50">
        {allIssues.map((issue, i) => (
          <div key={i} className={cn('flex items-start gap-2.5 px-4 py-1.5 text-xs', issue.severity === 'error' ? 'bg-red-50/30 dark:bg-red-900/10' : issue.severity === 'warning' ? 'bg-yellow-50/30 dark:bg-yellow-900/10' : '')}>
            {severityIcon(issue.severity)}
            <div className="flex-1 min-w-0">
              {issue.employeeName && <span className="font-semibold text-foreground">{issue.employeeName}: </span>}
              <span className="text-muted-foreground">{issue.message}</span>
            </div>
            <span className={cn('text-[9px] font-mono uppercase shrink-0 px-1 py-0.5 rounded', issue.category === 'name' ? 'bg-purple-100 text-purple-700' : issue.category === 'dayrow' ? 'bg-blue-100 text-blue-700' : issue.category === 'totals' ? 'bg-orange-100 text-orange-700' : issue.category === 'duplicate' ? 'bg-red-100 text-red-700' : 'bg-muted text-muted-foreground')}>
              {issue.category}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TotalsCheck({ present }: { present: EmployeeValidation['totalsPresent'] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {[['Total Stunden', present.totalHours], ['Pause', present.pause], ['Überzeit', present.ueberzeit], ['Saldo', present.saldo], ['Ferien', present.ferien]].map(([label, ok]) => (
        <span key={String(label)} className={cn('text-[10px] px-1.5 py-0.5 rounded border font-medium', ok ? 'bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400' : 'bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400')}>
          {ok ? '✓' : '✗'} {label}
        </span>
      ))}
    </div>
  );
}

function EmployeeCard({ emp, ev, index }: { emp: ExcelEmployee; ev: EmployeeValidation; index: number }) {
  const [expanded, setExpanded]       = useState(false);
  const [showRaw, setShowRaw]         = useState(false);
  const [showMissing, setShowMissing] = useState(false);
  const hasErrors   = ev.issues.some(i => i.severity === 'error');
  const hasWarnings = ev.issues.some(i => i.severity === 'warning');

  const cardBorderCls =
    ev.importStatus === 'ready'  ? 'border-green-200 dark:border-green-800' :
    ev.importStatus === 'review' ? 'border-yellow-200 dark:border-yellow-800' :
                                   'border-red-200 dark:border-red-800';

  return (
    <Card className={cn('border', cardBorderCls)}>
      <button className="w-full text-left" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold">{index + 1}</div>
            <div className="min-w-0">
              <p className="text-sm font-bold truncate">{emp.name ?? `Mitarbeiter ${index + 1}`}</p>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                {emp.kostenstelle && <span className="text-[10px] text-muted-foreground">{emp.kostenstelle}</span>}
                {emp.department   && <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-semibold', deptBadge(emp.department))}>{emp.department}</span>}
                {emp.weeklyHours  && <span className="text-[10px] text-muted-foreground">· {emp.weeklyHours} h/W</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            <div className="hidden sm:flex items-center gap-2 text-[11px]">
              <span className="text-muted-foreground">{ev.dayRowsCount}/{ev.expectedDaysCount} Tage</span>
              {emp.totals.totalHours && <span className="font-mono text-muted-foreground">{emp.totals.totalHours} h</span>}
              {hasErrors && !hasWarnings && <XCircle className="h-3.5 w-3.5 text-red-500" />}
              {!hasErrors && hasWarnings && <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />}
              {!hasErrors && !hasWarnings && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
            </div>
            {statusBadge(ev.importStatus)}
            {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            {[
              { l: 'Name', v: emp.name }, { l: 'Personalnr.', v: emp.personalnummer },
              { l: 'Kostenstelle', v: emp.kostenstelle }, { l: 'Wochenstd.', v: emp.weeklyHours ? `${emp.weeklyHours} h` : null },
              { l: 'Arbeitsverhältnis', v: emp.employment }, { l: 'Sheet', v: emp.sheetName },
            ].map(item => item.v ? (
              <div key={item.l}><p className="text-muted-foreground mb-0.5">{item.l}</p><p className="font-semibold">{item.v}</p></div>
            ) : null)}
          </div>

          {ev.issues.length > 0 && (
            <div className="space-y-1">
              {ev.issues.map((issue, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">{severityIcon(issue.severity)}<span className="text-muted-foreground">{issue.message}</span></div>
              ))}
            </div>
          )}

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Totale-Prüfung</p>
            <TotalsCheck present={ev.totalsPresent} />
            {(emp.totals.totalHours || emp.totals.saldo) && (
              <div className="flex flex-wrap gap-3 text-xs rounded border border-border bg-muted/20 p-2 mt-2">
                {emp.totals.totalHours   && <span><span className="text-muted-foreground">Total: </span><span className="font-mono font-bold">{emp.totals.totalHours} h</span></span>}
                {emp.totals.pauseTotal   && <span><span className="text-muted-foreground">Pause: </span><span className="font-mono">{emp.totals.pauseTotal} h</span></span>}
                {emp.totals.nettoTotal   && <span><span className="text-muted-foreground">Netto: </span><span className="font-mono">{emp.totals.nettoTotal} h</span></span>}
                {emp.totals.ueberzeit    && <span><span className="text-muted-foreground">Überzeit: </span><span className="font-mono">{emp.totals.ueberzeit} h</span></span>}
                {emp.totals.saldo        && <span><span className="text-muted-foreground">Saldo: </span><span className="font-mono">{emp.totals.saldo}</span></span>}
                {emp.totals.ferien       && <span><span className="text-muted-foreground">Ferien: </span><span className="font-mono">{emp.totals.ferien}</span></span>}
              </div>
            )}
          </div>

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
              Tageszeilen {ev.dayRowsCount}/{ev.expectedDaysCount}
              {ev.missingDates.length > 0 && <span className="text-red-600 ml-2">{ev.missingDates.length} fehlen</span>}
              {ev.multiTimeBlockDays.length > 0 && <span className="text-blue-600 ml-2">{ev.multiTimeBlockDays.length}× Doppelschicht</span>}
              {ev.absenceDays.length > 0 && <span className="text-purple-600 ml-2">{ev.absenceDays.length}× Absenz</span>}
            </p>
            {ev.missingDates.length > 0 && (
              <>
                <button onClick={() => setShowMissing(v => !v)} className="flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400 hover:underline mb-1">
                  {showMissing ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  Fehlende Tage anzeigen
                </button>
                {showMissing && (
                  <div className="flex flex-wrap gap-1">
                    {ev.missingDates.map(d => (
                      <span key={d} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-50 border border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">{d}</span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div>
            <button onClick={() => setShowRaw(r => !r)} className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
              <Table2 className="h-3.5 w-3.5" />{showRaw ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              Rohzellen Header ({emp.rawHeaderCells.length})
            </button>
            {showRaw && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-[10px] border-collapse font-mono">
                  <thead><tr className="text-muted-foreground border-b border-border"><th className="text-left pr-2 py-0.5">Ref</th><th className="text-left pr-2 py-0.5">Zeile</th><th className="text-left pr-2 py-0.5">Rohwert</th><th className="text-left py-0.5">Formatiert</th></tr></thead>
                  <tbody>
                    {emp.rawHeaderCells.map((cell, i) => (
                      <tr key={i} className="border-b border-border/30">
                        <td className="pr-2 py-0.5 text-primary font-bold">{cell.cellRef}</td>
                        <td className="pr-2 py-0.5 text-muted-foreground">{cell.rowIdx + 1}</td>
                        <td className="pr-2 py-0.5 text-yellow-700 dark:text-yellow-400">{String(cell.rawValue ?? '').slice(0, 60)}</td>
                        <td className="py-0.5">{cell.formatted.slice(0, 60)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── DOKUMENT-ERGEBNIS ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function DocumentResult({ doc, val, analyses }: { doc: ExcelParsedDocument; val: DocumentValidation; analyses: SheetAnalysis[] }) {
  const q = doc.quality;
  const qualBg = q.qualityPercent >= 85
    ? 'bg-green-100 text-green-800 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700'
    : q.qualityPercent >= 60
      ? 'bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-700'
      : 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-bold flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            {doc.fileName}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {doc.monthName ?? '–'} {doc.year ?? '–'}{doc.restaurant ? ` · ${doc.restaurant}` : ''}{doc.creationDate ? ` · Erstellt ${doc.creationDate}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('text-sm font-bold px-3 py-1 rounded-full border', qualBg)}>{q.qualityPercent}% Parser-Qualität</span>
          <Button size="sm" variant="outline" onClick={() => exportDebugJson(doc, val)} className="gap-1.5 text-xs h-8">
            <Download className="h-3.5 w-3.5" />Debug JSON
          </Button>
        </div>
      </div>

      {/* Excel Struktur Analyse — zuerst! */}
      <ExcelStructureSection doc={doc} val={val} analyses={analyses} />

      {/* Fehlerliste */}
      <GlobalErrorList val={val} />

      {/* Zusammenfassungs-Boxen */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Mitarbeiter', value: q.totalEmployees, sub: `${doc.employees.filter(e => !!e.name).length} mit Namen`, ok: q.totalEmployees > 0, warn: false },
          { label: 'Tageszeilen', value: q.totalDayRows, sub: `${q.uncertainRows} unsicher`, ok: q.totalDayRows > 0, warn: q.uncertainRows > 0 },
          { label: 'Totale erkannt', value: q.employeesWithTotals, sub: `von ${q.totalEmployees}`, ok: q.employeesWithTotals === q.totalEmployees && q.totalEmployees > 0, warn: q.employeesWithTotals > 0 && q.employeesWithTotals < q.totalEmployees },
          { label: 'Block-Kandidaten', value: analyses.reduce((s, a) => s + a.blockCandidates.length, 0), sub: 'erkannte Blöcke', ok: analyses.some(a => a.blockCandidates.length > 0), warn: false },
        ].map(item => (
          <div key={item.label} className={cn('rounded-lg border p-3', item.warn ? 'border-yellow-200 bg-yellow-50/40 dark:border-yellow-800 dark:bg-yellow-900/10' : item.ok ? 'border-green-200 bg-green-50/40 dark:border-green-800 dark:bg-green-900/10' : 'border-red-200 bg-red-50/40 dark:border-red-800 dark:bg-red-900/10')}>
            <p className="text-[10px] text-muted-foreground mb-0.5">{item.label}</p>
            <p className="text-xl font-bold tabular-nums">{item.value}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{item.sub}</p>
          </div>
        ))}
      </div>

      {/* Parser-Warnungen */}
      {doc.warnings.length > 0 && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50/40 dark:border-yellow-800 dark:bg-yellow-900/10 p-3 space-y-1">
          {doc.warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-1.5 text-xs text-yellow-800 dark:text-yellow-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />{w}
            </p>
          ))}
        </div>
      )}

      {/* Mitarbeiterkarten */}
      {doc.employees.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <User className="h-3.5 w-3.5" />
            Mitarbeiter ({doc.employees.length}) — Karte zum Aufklappen anklicken
          </p>
          {doc.employees.map((emp, i) => (
            <EmployeeCard key={i} emp={emp} ev={val.employeeValidations[i]} index={i} />
          ))}
        </div>
      ) : (
        <Card className="border-dashed border-border">
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            Keine Mitarbeiter erkannt — Struktur-Analyse oben prüfen.
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
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.xls') || f.name.endsWith('.xlsx'));
    if (files.length) onFiles(files);
  }, [onFiles]);
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) onFiles(files);
    e.target.value = '';
  }, [onFiles]);
  return (
    <label className={cn('flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed cursor-pointer transition-colors p-10', dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/60 hover:bg-muted/30')} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={handleDrop}>
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

interface ParseResult {
  doc: ExcelParsedDocument;
  val: DocumentValidation;
  analyses: SheetAnalysis[];
  fileName: string;
}

export default function MirusExcelTest() {
  const [results, setResults] = useState<ParseResult[]>([]);
  const [parseErrors, setParseErrors] = useState<{ error: string; fileName: string }[]>([]);
  const [parsing, setParsing] = useState(false);

  const handleFiles = useCallback(async (files: File[]) => {
    setParsing(true);
    const newResults: ParseResult[] = [];
    const newErrors: { error: string; fileName: string }[] = [];

    await Promise.all(files.map(async (file) => {
      try {
        const [doc, analyses] = await Promise.all([parseMirusExcel(file), analyzeExcelFile(file)]);
        const val = validateDocument(doc);
        newResults.push({ doc, val, analyses, fileName: file.name });
      } catch (err) {
        newErrors.push({ error: String(err), fileName: file.name });
      }
    }));

    setResults(prev => [...newResults, ...prev]);
    setParseErrors(prev => [...newErrors, ...prev]);
    setParsing(false);
  }, []);

  const bestQuality = results.reduce((m, r) => Math.max(m, r.doc.quality.qualityPercent), 0);

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border bg-card sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold flex items-center gap-2">
              <Table2 className="h-5 w-5 text-primary" />
              Mirus Excel — Struktur & Validierung
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">Diagnostisch · keine Daten werden gespeichert</p>
          </div>
          {results.length > 0 && (
            <div className="flex items-center gap-3 text-xs">
              <span className={cn('font-bold text-sm', bestQuality >= 85 ? 'text-green-600' : bestQuality >= 60 ? 'text-yellow-600' : 'text-red-600')}>
                Beste Qualität: {bestQuality}%
              </span>
              <button onClick={() => { setResults([]); setParseErrors([]); }} className="text-muted-foreground hover:text-foreground underline underline-offset-2">
                Alle löschen
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-8">
        <DropZone onFiles={handleFiles} />

        {parsing && (
          <div className="flex items-center justify-center gap-3 py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Struktur wird analysiert und validiert …</span>
          </div>
        )}

        {parseErrors.map((e, i) => (
          <div key={i} className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50/40 dark:border-red-800 dark:bg-red-900/10 p-4">
            <XCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-red-600">{e.fileName}</p>
              <p className="text-xs text-muted-foreground mt-1">{e.error}</p>
            </div>
          </div>
        ))}

        {results.map((r, idx) => (
          <div key={idx} className="rounded-xl border border-border bg-card p-5">
            <DocumentResult doc={r.doc} val={r.val} analyses={r.analyses} />
          </div>
        ))}

        {results.length === 0 && parseErrors.length === 0 && !parsing && (
          <div className="text-center py-10 text-muted-foreground">
            <Table2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Noch keine Dateien geladen.</p>
            <p className="text-xs mt-1">Teste mit: <code className="bg-muted px-1 rounded">Monatsblatt Januar 2026.xls</code></p>
          </div>
        )}
      </div>
    </div>
  );
}
