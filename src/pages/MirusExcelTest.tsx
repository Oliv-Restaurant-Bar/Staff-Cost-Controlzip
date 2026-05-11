/**
 * Mirus Excel Parser — Testseite /mirus-excel-test
 * =================================================
 * Upload → Parse → Validierung → Export
 * Kein Speichern, kein Supabase, keine produktive Logik.
 */

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import {
  Upload, FileText, ChevronDown, ChevronUp,
  AlertTriangle, CheckCircle2, XCircle, Info,
  User, Calendar, Hash, Clock, Loader2, Table2,
  Download,
} from 'lucide-react';
import { parseMirusExcel } from '@/lib/mirus-excel-parser';
import type { ExcelParsedDocument, ExcelEmployee } from '@/lib/mirus-excel-parser';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// ─── Validierungs-Typen ───────────────────────────────────────────────────────

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
  totalsPresent: {
    totalHours: boolean; pause: boolean; ueberzeit: boolean; saldo: boolean; ferien: boolean;
  };
  importStatus: 'ready' | 'review' | 'blocked';
}

interface DocumentValidation {
  employeeValidations: EmployeeValidation[];
  globalIssues: ValidationIssue[];
  summary: {
    total: number; ready: number; review: number; blocked: number;
    totalErrors: number; totalWarnings: number;
  };
}

// ─── Validierungs-Logik ───────────────────────────────────────────────────────

const DIRTY_NAME_TOKENS = [
  'Wöchentliche', 'Kostenstelle', 'Arbeitsverhältnis', 'TOTAL',
  'Personal', 'Betrieb', 'Arbeitszeit', 'Stunden',
];

function getExpectedDays(month: number, year: number): string[] {
  const count = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, '0');
  return Array.from({ length: count }, (_, i) =>
    `${String(i + 1).padStart(2, '0')}.${mm}`,
  );
}

function normalizeName(name: string | null): string {
  return (name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function validateEmployee(
  emp: ExcelEmployee,
  index: number,
  allEmployees: ExcelEmployee[],
  expectedDays: string[],
): EmployeeValidation {
  const issues: ValidationIssue[] = [];
  const label = emp.name ?? `Mitarbeiter ${index + 1}`;

  // ── Name ────────────────────────────────────────────────────────────────
  if (!emp.name) {
    issues.push({ severity: 'error', category: 'name', message: 'Name fehlt', employeeName: label, employeeIndex: index });
  } else {
    for (const token of DIRTY_NAME_TOKENS) {
      if (emp.name.includes(token)) {
        issues.push({
          severity: 'error', category: 'name', employeeName: label, employeeIndex: index,
          message: `Name enthält Zusatztext: „${token}"`,
        });
        break;
      }
    }
    if (/\d/.test(emp.name)) {
      issues.push({ severity: 'warning', category: 'name', employeeName: label, employeeIndex: index, message: 'Name enthält Ziffern' });
    }
  }

  // ── Duplikat ─────────────────────────────────────────────────────────────
  const myNorm = normalizeName(emp.name);
  const dupIdx = allEmployees.findIndex((e, i) => i !== index && normalizeName(e.name) === myNorm && myNorm !== '');
  if (dupIdx >= 0) {
    issues.push({
      severity: 'error', category: 'duplicate', employeeName: label, employeeIndex: index,
      message: `Duplikat von Mitarbeiter ${dupIdx + 1} (${allEmployees[dupIdx].name})`,
    });
  }

  // ── Kostenstelle / Abteilung ─────────────────────────────────────────────
  if (!emp.kostenstelle) {
    issues.push({ severity: 'warning', category: 'name', employeeName: label, employeeIndex: index, message: 'Kostenstelle fehlt' });
  }
  if (!emp.department) {
    issues.push({ severity: 'warning', category: 'name', employeeName: label, employeeIndex: index, message: 'Abteilung nicht erkannt' });
  }

  // ── Tageszeilen ──────────────────────────────────────────────────────────
  const actualDates = new Set(emp.dayRows.map(r => r.date).filter(Boolean) as string[]);
  const missingDates = expectedDays.filter(d => !actualDates.has(d));

  if (emp.dayRows.length === 0) {
    issues.push({ severity: 'error', category: 'dayrow', employeeName: label, employeeIndex: index, message: 'Keine Tageszeilen erkannt' });
  } else if (missingDates.length > 7) {
    issues.push({
      severity: 'error', category: 'date', employeeName: label, employeeIndex: index,
      message: `${missingDates.length} Tage fehlen`,
    });
  } else if (missingDates.length > 0) {
    issues.push({
      severity: 'warning', category: 'date', employeeName: label, employeeIndex: index,
      message: `${missingDates.length} Tage fehlen: ${missingDates.slice(0, 5).join(', ')}${missingDates.length > 5 ? ' …' : ''}`,
    });
  }

  const multiTimeBlockDays = emp.dayRows
    .filter(r => r.timeBlocks.length > 1)
    .map(r => r.date ?? '?');

  const absenceDays = emp.dayRows
    .filter(r => r.absenceCodes.length > 0)
    .map(r => ({ date: r.date ?? '?', codes: r.absenceCodes }));

  const lowConfRows = emp.dayRows.filter(r => r.confidence === 'low');
  if (lowConfRows.length > 0) {
    issues.push({
      severity: 'warning', category: 'dayrow', employeeName: label, employeeIndex: index,
      message: `${lowConfRows.length} Tageszeile(n) mit schlechter Erkennung`,
    });
  }

  // ── Totale ───────────────────────────────────────────────────────────────
  const totalsPresent = {
    totalHours: !!emp.totals.totalHours,
    pause:      !!emp.totals.pauseTotal,
    ueberzeit:  !!emp.totals.ueberzeit,
    saldo:      !!emp.totals.saldo,
    ferien:     !!emp.totals.ferien,
  };

  if (!totalsPresent.totalHours) {
    issues.push({ severity: 'error', category: 'totals', employeeName: label, employeeIndex: index, message: 'Total Stunden nicht erkannt' });
  }

  // ── Import-Status ────────────────────────────────────────────────────────
  const errors   = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const importStatus: 'ready' | 'review' | 'blocked' =
    errors > 0 ? 'blocked' :
    warnings > 2 ? 'review' :
    warnings > 0 ? 'review' : 'ready';

  return {
    index, name: emp.name, issues,
    dayRowsCount: emp.dayRows.length,
    expectedDaysCount: expectedDays.length,
    missingDates, multiTimeBlockDays, absenceDays,
    totalsPresent, importStatus,
  };
}

function validateDocument(doc: ExcelParsedDocument): DocumentValidation {
  const expectedDays = (doc.month && doc.year)
    ? getExpectedDays(doc.month, doc.year)
    : [];

  const globalIssues: ValidationIssue[] = [];
  if (!doc.month) globalIssues.push({ severity: 'error', category: 'meta', message: 'Monat nicht erkannt' });
  if (!doc.year)  globalIssues.push({ severity: 'error', category: 'meta', message: 'Jahr nicht erkannt' });
  if (doc.employees.length === 0) globalIssues.push({ severity: 'error', category: 'meta', message: 'Keine Mitarbeiter gefunden' });

  const employeeValidations = doc.employees.map((emp, i) =>
    validateEmployee(emp, i, doc.employees, expectedDays),
  );

  const allIssues = [...globalIssues, ...employeeValidations.flatMap(v => v.issues)];
  const ready   = employeeValidations.filter(v => v.importStatus === 'ready').length;
  const review  = employeeValidations.filter(v => v.importStatus === 'review').length;
  const blocked = employeeValidations.filter(v => v.importStatus === 'blocked').length;

  return {
    employeeValidations, globalIssues,
    summary: {
      total: doc.employees.length, ready, review, blocked,
      totalErrors:   allIssues.filter(i => i.severity === 'error').length,
      totalWarnings: allIssues.filter(i => i.severity === 'warning').length,
    },
  };
}

// ─── Export ───────────────────────────────────────────────────────────────────

function exportDebugJson(doc: ExcelParsedDocument, val: DocumentValidation) {
  const payload = {
    meta: {
      fileName: doc.fileName, month: doc.month, monthName: doc.monthName,
      year: doc.year, restaurant: doc.restaurant, creationDate: doc.creationDate,
      exportedAt: new Date().toISOString(),
    },
    quality: doc.quality,
    validationSummary: val.summary,
    employees: doc.employees.map((emp, i) => {
      const ev = val.employeeValidations[i];
      return {
        index: i + 1,
        name: emp.name, personalnummer: emp.personalnummer,
        kostenstelle: emp.kostenstelle, department: emp.department,
        employment: emp.employment, weeklyHours: emp.weeklyHours,
        sheetName: emp.sheetName,
        importStatus: ev.importStatus,
        issues: ev.issues,
        dayRowsCount: emp.dayRows.length,
        expectedDaysCount: ev.expectedDaysCount,
        missingDates: ev.missingDates,
        totals: emp.totals,
        dayRows: emp.dayRows.map(r => ({
          date: r.date, weekday: r.weekday,
          timeBlocks: r.timeBlocks.map(b => `${b.from}–${b.to}`),
          department: r.department, pause: r.pause, totalHours: r.totalHours,
          absenceCodes: r.absenceCodes, remark: r.remark, confidence: r.confidence,
          rawCells: r.rawCells.map(c => ({
            cellRef: c.cellRef, row: c.rowIdx + 1, col: c.colIdx + 1,
            raw: String(c.rawValue ?? ''), formatted: c.formatted,
          })),
        })),
        rawHeaderCells: emp.rawHeaderCells.map(c => ({
          cellRef: c.cellRef, row: c.rowIdx + 1, col: c.colIdx + 1,
          raw: String(c.rawValue ?? ''), formatted: c.formatted,
        })),
      };
    }),
    globalIssues: val.globalIssues,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  const safe = doc.fileName.replace(/[^a-z0-9]/gi, '_');
  a.download = `mirus-debug-${safe}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── UI-Helpers ───────────────────────────────────────────────────────────────

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

function cardBorder(status: 'ready' | 'review' | 'blocked') {
  if (status === 'ready')  return 'border-green-200 dark:border-green-800';
  if (status === 'review') return 'border-yellow-200 dark:border-yellow-800';
  return 'border-red-200 dark:border-red-800';
}

function deptBadge(dept: string | null) {
  if (!dept) return 'bg-muted text-muted-foreground';
  if (dept === 'küche') return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
  return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
}

// ─── Kompakte Fehlerliste ─────────────────────────────────────────────────────

function GlobalErrorList({ val }: { val: DocumentValidation }) {
  const allIssues = [
    ...val.globalIssues,
    ...val.employeeValidations.flatMap(v => v.issues),
  ].sort((a, b) => {
    const order = { error: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });

  if (allIssues.length === 0) return (
    <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50/40 dark:border-green-800 dark:bg-green-900/10 px-4 py-3">
      <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
      <span className="text-sm font-semibold text-green-700 dark:text-green-400">Keine Fehler gefunden</span>
    </div>
  );

  const errors   = allIssues.filter(i => i.severity === 'error');
  const warnings = allIssues.filter(i => i.severity === 'warning');

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-muted/40 border-b border-border">
        <AlertTriangle className="h-4 w-4 text-yellow-500" />
        <span className="text-xs font-bold uppercase tracking-wide">Fehlerliste</span>
        <div className="flex items-center gap-2 ml-auto text-[11px]">
          {errors.length > 0 && <span className="text-red-600 font-semibold">{errors.length} Fehler</span>}
          {warnings.length > 0 && <span className="text-yellow-600 font-semibold">{warnings.length} Warnungen</span>}
        </div>
      </div>
      <div className="max-h-60 overflow-y-auto divide-y divide-border/50">
        {allIssues.map((issue, i) => (
          <div key={i} className={cn(
            'flex items-start gap-2.5 px-4 py-2 text-xs',
            issue.severity === 'error'   ? 'bg-red-50/30 dark:bg-red-900/10' :
            issue.severity === 'warning' ? 'bg-yellow-50/30 dark:bg-yellow-900/10' : '',
          )}>
            {severityIcon(issue.severity)}
            <div className="flex-1 min-w-0">
              {issue.employeeName && (
                <span className="font-semibold text-foreground">{issue.employeeName}: </span>
              )}
              <span className="text-muted-foreground">{issue.message}</span>
            </div>
            <span className={cn(
              'text-[9px] font-mono uppercase shrink-0 px-1 py-0.5 rounded',
              issue.category === 'name'      ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' :
              issue.category === 'dayrow'    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
              issue.category === 'totals'    ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' :
              issue.category === 'duplicate' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
              'bg-muted text-muted-foreground',
            )}>
              {issue.category}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Totale-Check ─────────────────────────────────────────────────────────────

function TotalsCheck({ present }: { present: EmployeeValidation['totalsPresent'] }) {
  const items = [
    { label: 'Total Stunden', ok: present.totalHours },
    { label: 'Pause Total',   ok: present.pause },
    { label: 'Überzeit',      ok: present.ueberzeit },
    { label: 'Saldo',         ok: present.saldo },
    { label: 'Ferien',        ok: present.ferien },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(item => (
        <span key={item.label} className={cn(
          'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-medium',
          item.ok
            ? 'bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400'
            : 'bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400',
        )}>
          {item.ok ? '✓' : '✗'} {item.label}
        </span>
      ))}
    </div>
  );
}

// ─── Tageszeilen-Tabelle ──────────────────────────────────────────────────────

function DayRowsTable({ emp, missingDates }: { emp: ExcelEmployee; missingDates: string[] }) {
  const missingSet = new Set(missingDates);
  const rows = emp.dayRows;
  if (rows.length === 0) return (
    <p className="text-[11px] text-muted-foreground italic">Keine Tageszeilen erkannt.</p>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="text-left py-1 pr-3 font-medium">Datum</th>
            <th className="text-left py-1 pr-3 font-medium">Tag</th>
            <th className="text-left py-1 pr-3 font-medium">Zeitblock</th>
            <th className="text-left py-1 pr-3 font-medium">Dept</th>
            <th className="text-right py-1 pr-3 font-medium">Pause</th>
            <th className="text-right py-1 pr-3 font-medium">Netto h</th>
            <th className="text-left py-1 pr-3 font-medium">Abs</th>
            <th className="text-left py-1 font-medium">Q</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn(
              'border-b border-border/40',
              r.confidence === 'high'   ? '' :
              r.confidence === 'medium' ? 'bg-yellow-50/30 dark:bg-yellow-900/10' :
                                          'bg-red-50/30 dark:bg-red-900/10',
            )}>
              <td className={cn('py-0.5 pr-3 font-mono', r.date && missingSet.has(r.date) ? 'line-through text-muted-foreground' : '')}>
                {r.date ?? <span className="text-muted-foreground">–</span>}
              </td>
              <td className="py-0.5 pr-3">{r.weekday ?? '–'}</td>
              <td className="py-0.5 pr-3 font-mono text-[10px]">
                {r.timeBlocks.length > 0
                  ? r.timeBlocks.map(b => `${b.from}–${b.to}`).join(' / ')
                  : <span className="text-muted-foreground">–</span>}
                {r.timeBlocks.length > 1 && <span className="ml-1 text-blue-500 text-[9px]">×{r.timeBlocks.length}</span>}
              </td>
              <td className="py-0.5 pr-3">
                {r.department
                  ? <span className={cn('px-1 py-0.5 rounded text-[9px] font-semibold', deptBadge(r.department))}>{r.department}</span>
                  : <span className="text-muted-foreground">–</span>}
              </td>
              <td className="py-0.5 pr-3 text-right font-mono">{r.pause ?? '–'}</td>
              <td className="py-0.5 pr-3 text-right font-mono font-semibold">{r.totalHours ?? '–'}</td>
              <td className="py-0.5 pr-3">
                {r.absenceCodes.length > 0
                  ? <span className="text-purple-600 dark:text-purple-400 font-semibold">{r.absenceCodes.join(', ')}</span>
                  : '–'}
              </td>
              <td className="py-0.5 text-center">
                {r.confidence === 'high'   ? <span className="text-green-600">✓</span>  :
                 r.confidence === 'medium' ? <span className="text-yellow-600">⚠</span> :
                                             <span className="text-red-600">✗</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Mitarbeiterkarte ─────────────────────────────────────────────────────────

function EmployeeCard({ emp, ev, index }: {
  emp: ExcelEmployee; ev: EmployeeValidation; index: number;
}) {
  const [expanded,   setExpanded]   = useState(false);
  const [showRaw,    setShowRaw]    = useState(false);
  const [showDays,   setShowDays]   = useState(false);
  const [showMissing, setShowMissing] = useState(false);

  const hasErrors   = ev.issues.some(i => i.severity === 'error');
  const hasWarnings = ev.issues.some(i => i.severity === 'warning');

  return (
    <Card className={cn('border', cardBorder(ev.importStatus))}>
      <button className="w-full text-left" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold">
              {index + 1}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold truncate">{emp.name ?? `Mitarbeiter ${index + 1}`}</p>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                {emp.kostenstelle && <span className="text-[10px] text-muted-foreground">{emp.kostenstelle}</span>}
                {emp.department && (
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-semibold', deptBadge(emp.department))}>
                    {emp.department}
                  </span>
                )}
                {emp.weeklyHours && <span className="text-[10px] text-muted-foreground">· {emp.weeklyHours} h/W</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            <div className="hidden sm:flex items-center gap-2 text-[11px]">
              <span className="text-muted-foreground">{ev.dayRowsCount}/{ev.expectedDaysCount} Tage</span>
              {emp.totals.totalHours && <span className="font-mono text-muted-foreground">{emp.totals.totalHours} h</span>}
              {hasErrors && <XCircle className="h-3.5 w-3.5 text-red-500" />}
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

          {/* Stammdaten */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            {[
              { label: 'Name', value: emp.name, icon: <User className="h-3 w-3" /> },
              { label: 'Personalnr.', value: emp.personalnummer, icon: <Hash className="h-3 w-3" /> },
              { label: 'Kostenstelle', value: emp.kostenstelle },
              { label: 'Wochenstunden', value: emp.weeklyHours ? `${emp.weeklyHours} h` : null, icon: <Clock className="h-3 w-3" /> },
              { label: 'Arbeitsverhältnis', value: emp.employment },
              { label: 'Eintritt', value: emp.eintritt },
              { label: 'Austritt', value: emp.austritt },
              { label: 'Sheet', value: emp.sheetName },
            ].map(item => item.value ? (
              <div key={item.label}>
                <p className="text-muted-foreground mb-0.5 flex items-center gap-1">{item.icon}{item.label}</p>
                <p className="font-semibold">{item.value}</p>
              </div>
            ) : null)}
          </div>

          {/* Fehler/Warnungen dieser MA */}
          {ev.issues.length > 0 && (
            <div className="space-y-1">
              {ev.issues.map((issue, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  {severityIcon(issue.severity)}
                  <span className="text-muted-foreground">{issue.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Totale-Check */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Totale-Prüfung</p>
            <TotalsCheck present={ev.totalsPresent} />
            {emp.totals.totalHours && (
              <div className="flex flex-wrap gap-3 text-xs rounded border border-border bg-muted/20 p-2 mt-2">
                {emp.totals.totalHours  && <span><span className="text-muted-foreground">Total: </span><span className="font-mono font-bold">{emp.totals.totalHours} h</span></span>}
                {emp.totals.pauseTotal  && <span><span className="text-muted-foreground">Pause: </span><span className="font-mono">{emp.totals.pauseTotal} h</span></span>}
                {emp.totals.nettoTotal  && <span><span className="text-muted-foreground">Netto: </span><span className="font-mono">{emp.totals.nettoTotal} h</span></span>}
                {emp.totals.zeitzuschlag && <span><span className="text-muted-foreground">Zeitzuschlag: </span><span className="font-mono">{emp.totals.zeitzuschlag} h</span></span>}
                {emp.totals.ueberzeit   && <span><span className="text-muted-foreground">Überzeit: </span><span className="font-mono">{emp.totals.ueberzeit} h</span></span>}
                {emp.totals.saldo       && <span><span className="text-muted-foreground">Saldo: </span><span className="font-mono">{emp.totals.saldo}</span></span>}
                {emp.totals.ferien      && <span><span className="text-muted-foreground">Ferien: </span><span className="font-mono">{emp.totals.ferien}</span></span>}
              </div>
            )}
          </div>

          {/* Tageszeilen */}
          <div>
            <button
              onClick={() => setShowDays(v => !v)}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors mb-1"
            >
              {showDays ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              <Calendar className="h-3.5 w-3.5" />
              Tageszeilen ({ev.dayRowsCount}/{ev.expectedDaysCount})
              {ev.missingDates.length > 0 && (
                <span className="text-red-600 text-[10px]">— {ev.missingDates.length} fehlen</span>
              )}
              {ev.multiTimeBlockDays.length > 0 && (
                <span className="text-blue-600 text-[10px]">— {ev.multiTimeBlockDays.length} × Doppelschicht</span>
              )}
              {ev.absenceDays.length > 0 && (
                <span className="text-purple-600 text-[10px]">— {ev.absenceDays.length} × Absenz</span>
              )}
            </button>
            {showDays && <DayRowsTable emp={emp} missingDates={ev.missingDates} />}
          </div>

          {/* Fehlende Tage */}
          {ev.missingDates.length > 0 && (
            <div>
              <button
                onClick={() => setShowMissing(v => !v)}
                className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-400 hover:underline"
              >
                {showMissing ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                Fehlende Tage ({ev.missingDates.length})
              </button>
              {showMissing && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {ev.missingDates.map(d => (
                    <span key={d} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-50 border border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">{d}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Rohzellen Header */}
          <div>
            <button
              onClick={() => setShowRaw(r => !r)}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <Table2 className="h-3.5 w-3.5" />
              {showRaw ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              Rohzellen Header ({emp.rawHeaderCells.length})
            </button>
            {showRaw && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-[10px] border-collapse font-mono">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="text-left pr-2 py-0.5">Ref</th>
                      <th className="text-left pr-2 py-0.5">Zeile</th>
                      <th className="text-left pr-2 py-0.5">Spalte</th>
                      <th className="text-left pr-2 py-0.5">Rohwert</th>
                      <th className="text-left py-0.5">Formatiert</th>
                    </tr>
                  </thead>
                  <tbody>
                    {emp.rawHeaderCells.map((cell, i) => (
                      <tr key={i} className="border-b border-border/30">
                        <td className="pr-2 py-0.5 text-primary font-bold">{cell.cellRef}</td>
                        <td className="pr-2 py-0.5 text-muted-foreground">{cell.rowIdx + 1}</td>
                        <td className="pr-2 py-0.5 text-muted-foreground">{cell.colIdx + 1}</td>
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

// ─── Import-Status-Übersicht ──────────────────────────────────────────────────

function ImportStatusSummary({ val }: { val: DocumentValidation }) {
  const { summary } = val;
  return (
    <div className="grid grid-cols-3 gap-3">
      {[
        { label: 'Importfähig', count: summary.ready, color: 'green' },
        { label: 'Prüfen', count: summary.review, color: 'yellow' },
        { label: 'Blockiert', count: summary.blocked, color: 'red' },
      ].map(item => (
        <div key={item.label} className={cn(
          'rounded-lg border p-3 text-center',
          item.color === 'green' ? 'border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-900/10' :
          item.color === 'yellow' ? 'border-yellow-200 bg-yellow-50/50 dark:border-yellow-800 dark:bg-yellow-900/10' :
          'border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-900/10',
        )}>
          <p className="text-2xl font-bold tabular-nums">{item.count}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{item.label}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Dokument-Ergebnis ────────────────────────────────────────────────────────

function DocumentResult({ doc, val }: { doc: ExcelParsedDocument; val: DocumentValidation }) {
  const q = doc.quality;

  return (
    <div className="space-y-5">
      {/* Datei-Header + Export */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-bold flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            {doc.fileName}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {doc.monthName ?? '–'} {doc.year ?? '–'}
            {doc.restaurant ? ` · ${doc.restaurant}` : ''}
            {doc.creationDate ? ` · Erstellt ${doc.creationDate}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn(
            'text-sm font-bold px-3 py-1 rounded-full border',
            q.qualityPercent >= 85
              ? 'bg-green-100 text-green-800 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700'
              : q.qualityPercent >= 60
                ? 'bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-700'
                : 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700',
          )}>
            {q.qualityPercent}% Qualität
          </span>
          <Button size="sm" variant="outline" onClick={() => exportDebugJson(doc, val)} className="gap-1.5 text-xs h-8">
            <Download className="h-3.5 w-3.5" />
            Debug JSON
          </Button>
        </div>
      </div>

      {/* Fehlerliste */}
      <GlobalErrorList val={val} />

      {/* Zusammenfassungs-Boxen */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            label: 'Mitarbeiter', value: q.totalEmployees,
            sub: `${doc.employees.filter(e => !!e.name).length} mit Namen`,
            ok: q.totalEmployees > 0, warn: false,
          },
          {
            label: 'Tageszeilen', value: q.totalDayRows,
            sub: `${q.uncertainRows} unsicher`,
            ok: q.totalDayRows > 0, warn: q.uncertainRows > 0,
          },
          {
            label: 'Totale erkannt', value: q.employeesWithTotals,
            sub: `von ${q.totalEmployees}`,
            ok: q.employeesWithTotals === q.totalEmployees && q.totalEmployees > 0,
            warn: q.employeesWithTotals > 0 && q.employeesWithTotals < q.totalEmployees,
          },
          {
            label: 'Ø Qualität', value: `${q.qualityPercent}%`,
            sub: q.qualityPercent >= 85 ? 'gut' : q.qualityPercent >= 60 ? 'teilweise' : 'kritisch',
            ok: q.qualityPercent >= 85, warn: q.qualityPercent >= 60 && q.qualityPercent < 85,
          },
        ].map(item => (
          <div key={item.label} className={cn(
            'rounded-lg border p-3',
            item.warn  ? 'border-yellow-200 bg-yellow-50/40 dark:border-yellow-800 dark:bg-yellow-900/10' :
            item.ok    ? 'border-green-200 bg-green-50/40 dark:border-green-800 dark:bg-green-900/10' :
                         'border-red-200 bg-red-50/40 dark:border-red-800 dark:bg-red-900/10',
          )}>
            <p className="text-[10px] text-muted-foreground mb-0.5">{item.label}</p>
            <p className="text-xl font-bold tabular-nums">{item.value}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{item.sub}</p>
          </div>
        ))}
      </div>

      {/* Import-Status */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Import-Status</p>
        <ImportStatusSummary val={val} />
      </div>

      {/* Warnungen aus Parser */}
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
            Mitarbeiter ({doc.employees.length}) — Karte anklicken zum Aufklappen
          </p>
          {doc.employees.map((emp, i) => (
            <EmployeeCard key={i} emp={emp} ev={val.employeeValidations[i]} index={i} />
          ))}
        </div>
      ) : (
        <Card className="border-dashed border-border">
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            Keine Mitarbeiter-Abschnitte erkannt — andere Sheet-Struktur?
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Dropzone ─────────────────────────────────────────────────────────────────

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(
      f => f.name.endsWith('.xls') || f.name.endsWith('.xlsx'),
    );
    if (files.length) onFiles(files);
  }, [onFiles]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) onFiles(files);
    e.target.value = '';
  }, [onFiles]);

  return (
    <label
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed cursor-pointer transition-colors p-10',
        dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/60 hover:bg-muted/30',
      )}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <Upload className="h-10 w-10 text-muted-foreground" />
      <div className="text-center">
        <p className="text-sm font-semibold">Excel-Dateien hochladen</p>
        <p className="text-xs text-muted-foreground mt-0.5">.xls / .xlsx — mehrere Dateien gleichzeitig möglich</p>
      </div>
      <input type="file" className="sr-only" multiple accept=".xls,.xlsx" onChange={handleChange} />
    </label>
  );
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

interface ParseResult {
  doc: ExcelParsedDocument;
  val: DocumentValidation;
  fileName: string;
}

interface ErrorResult {
  error: string;
  fileName: string;
}

export default function MirusExcelTest() {
  const [results, setResults]   = useState<ParseResult[]>([]);
  const [errors, setErrors]     = useState<ErrorResult[]>([]);
  const [parsing, setParsing]   = useState(false);

  const handleFiles = useCallback(async (files: File[]) => {
    setParsing(true);
    const newResults: ParseResult[] = [];
    const newErrors: ErrorResult[]  = [];

    await Promise.all(files.map(async (file) => {
      try {
        const doc = await parseMirusExcel(file);
        const val = validateDocument(doc);
        newResults.push({ doc, val, fileName: file.name });
      } catch (err) {
        newErrors.push({ error: String(err), fileName: file.name });
      }
    }));

    setResults(prev => [...newResults, ...prev]);
    setErrors(prev => [...newErrors, ...prev]);
    setParsing(false);
  }, []);

  const bestQuality = results.reduce((m, r) => Math.max(m, r.doc.quality.qualityPercent), 0);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold flex items-center gap-2">
              <Table2 className="h-5 w-5 text-primary" />
              Mirus Excel — Validierungstest
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Diagnostisch · keine Daten werden gespeichert
            </p>
          </div>
          {results.length > 0 && (
            <div className="flex items-center gap-3 text-xs">
              <span className={cn(
                'font-bold text-sm',
                bestQuality >= 85 ? 'text-green-600' : bestQuality >= 60 ? 'text-yellow-600' : 'text-red-600',
              )}>
                Beste Qualität: {bestQuality}%
              </span>
              <button onClick={() => { setResults([]); setErrors([]); }}
                className="text-muted-foreground hover:text-foreground underline underline-offset-2">
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
            <span className="text-sm">Dateien werden analysiert und validiert …</span>
          </div>
        )}

        {/* Parse-Fehler */}
        {errors.map((e, i) => (
          <div key={i} className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50/40 dark:border-red-800 dark:bg-red-900/10 p-4">
            <XCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-red-600 dark:text-red-400">{e.fileName}</p>
              <p className="text-xs text-muted-foreground mt-1">{e.error}</p>
            </div>
          </div>
        ))}

        {/* Vergleich */}
        {results.length >= 1 && !parsing && (
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">Import-Empfehlung</p>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className={cn(
                'rounded-lg border p-4',
                bestQuality >= 85
                  ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-900/20'
                  : 'border-yellow-300 bg-yellow-50 dark:border-yellow-700 dark:bg-yellow-900/20',
              )}>
                <div className="flex items-center gap-1.5 mb-1">
                  {bestQuality >= 85
                    ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                    : <AlertTriangle className="h-4 w-4 text-yellow-600" />}
                  <span className="font-bold">Excel-Import</span>
                </div>
                <p className={cn('text-2xl font-bold tabular-nums', bestQuality >= 85 ? 'text-green-600' : 'text-yellow-600')}>
                  {bestQuality}%
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {bestQuality >= 85 ? '✓ Empfohlen als Hauptimport' : 'Parser-Anpassung erforderlich'}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="flex items-center gap-1.5 mb-1">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="font-bold text-muted-foreground">PDF-Import</span>
                </div>
                <p className="text-2xl font-bold tabular-nums text-muted-foreground">—</p>
                <p className="text-xs text-muted-foreground mt-0.5">Backup / Archiv · nicht priorisiert</p>
              </div>
            </div>
          </div>
        )}

        {/* Ergebnisse */}
        {results.map((result, idx) => (
          <div key={idx} className="rounded-xl border border-border bg-card p-5">
            <DocumentResult doc={result.doc} val={result.val} />
          </div>
        ))}

        {/* Leer-Zustand */}
        {results.length === 0 && errors.length === 0 && !parsing && (
          <div className="text-center py-10 text-muted-foreground">
            <Table2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Noch keine Dateien geladen.</p>
            <p className="text-xs mt-1">
              Teste mit: <code className="bg-muted px-1 rounded">Monatsblatt Januar 2026.xls</code> und <code className="bg-muted px-1 rounded">Monatsblatt Februar 2026.xls</code>
            </p>
          </div>
        )}

      </div>
    </div>
  );
}
