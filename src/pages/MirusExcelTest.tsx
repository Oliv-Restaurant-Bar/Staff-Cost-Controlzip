/**
 * Mirus Excel Parser — Testseite /mirus-excel-test
 * =================================================
 * Lädt Mirus-Monatsblätter (.xls / .xlsx), parst sie und zeigt
 * alle erkannten Daten als Debug-Tabelle an.
 * Kein Speichern, kein Supabase.
 */

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import {
  Upload, FileText, ChevronDown, ChevronUp,
  AlertTriangle, CheckCircle2, XCircle,
  User, Calendar, Hash, Clock, Loader2, Table2,
} from 'lucide-react';
import { parseMirusExcel } from '@/lib/mirus-excel-parser';
import type { ExcelParsedDocument, ExcelEmployee, ExcelDayRow } from '@/lib/mirus-excel-parser';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function qualityColor(pct: number) {
  if (pct >= 85) return 'text-green-600 dark:text-green-400';
  if (pct >= 60) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

function qualityBg(pct: number) {
  if (pct >= 85) return 'bg-green-100 text-green-800 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700';
  if (pct >= 60) return 'bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-700';
  return 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700';
}

function deptBadge(dept: string | null) {
  if (!dept) return 'bg-muted text-muted-foreground';
  if (dept === 'küche') return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
  return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
}

function EmpQualityBadge({ pct }: { pct: number }) {
  if (pct >= 85) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border bg-green-50 border-green-300 text-green-700 dark:bg-green-900/20 dark:border-green-700 dark:text-green-400">
      ✓ {pct}%
    </span>
  );
  if (pct >= 60) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border bg-yellow-50 border-yellow-300 text-yellow-700 dark:bg-yellow-900/20 dark:border-yellow-700 dark:text-yellow-400">
      ⚠ {pct}%
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border bg-red-50 border-red-300 text-red-700 dark:bg-red-900/20 dark:border-red-700 dark:text-red-400">
      ✗ {pct}%
    </span>
  );
}

function empQualityPct(emp: ExcelEmployee): number {
  const totalRows = emp.dayRows.length;
  const hasName = !!emp.name;
  if (!hasName && totalRows === 0) return 0;
  const highRows = emp.dayRows.filter(r => r.confidence === 'high').length;
  const nameScore = hasName ? 35 : 0;
  const rowScore  = totalRows > 0 ? (highRows / totalRows) * 50 : 0;
  const totScore  = emp.totals.totalHours ? 15 : 0;
  return Math.round(nameScore + rowScore + totScore);
}

// ─── DayRows Tabelle ──────────────────────────────────────────────────────────

function DayRowsTable({ rows }: { rows: ExcelDayRow[] }) {
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
            <th className="text-left py-1 pr-3 font-medium">Dept.</th>
            <th className="text-right py-1 pr-3 font-medium">Pause</th>
            <th className="text-right py-1 pr-3 font-medium">Netto h</th>
            <th className="text-left py-1 pr-3 font-medium">Abs.</th>
            <th className="text-left py-1 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn(
              'border-b border-border/40',
              r.confidence === 'high' ? '' :
              r.confidence === 'medium' ? 'bg-yellow-50/30 dark:bg-yellow-900/10' :
              'bg-red-50/30 dark:bg-red-900/10',
            )}>
              <td className="py-0.5 pr-3 font-mono">{r.date ?? <span className="text-muted-foreground">–</span>}</td>
              <td className="py-0.5 pr-3">{r.weekday ?? <span className="text-muted-foreground">–</span>}</td>
              <td className="py-0.5 pr-3 font-mono">
                {r.timeBlocks.length > 0
                  ? r.timeBlocks.map(b => `${b.from}–${b.to}`).join(', ')
                  : <span className="text-muted-foreground">–</span>}
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
              <td className="py-0.5">
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

function EmployeeCard({ emp, index }: { emp: ExcelEmployee; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw]   = useState(false);
  const pct = empQualityPct(emp);

  const cardBorder =
    pct >= 85 ? 'border-green-200 dark:border-green-800' :
    pct >= 60 ? 'border-yellow-200 dark:border-yellow-800' :
                'border-red-200 dark:border-red-800';

  const totalRows = emp.dayRows.length;
  const highRows  = emp.dayRows.filter(r => r.confidence === 'high').length;

  return (
    <Card className={cn('border', cardBorder)}>
      <button className="w-full text-left" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold">
              {index + 1}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold truncate">{emp.name ?? `Mitarbeiter ${index + 1}`}</p>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                {emp.kostenstelle && (
                  <span className="text-[10px] text-muted-foreground">{emp.kostenstelle}</span>
                )}
                {emp.department && (
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-semibold', deptBadge(emp.department))}>
                    {emp.department}
                  </span>
                )}
                {emp.employment && (
                  <span className="text-[10px] text-muted-foreground">· {emp.employment}</span>
                )}
                {emp.weeklyHours && (
                  <span className="text-[10px] text-muted-foreground">· {emp.weeklyHours} h/W</span>
                )}
                <span className="text-[10px] text-muted-foreground">· Sheet: {emp.sheetName}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            <div className="hidden sm:flex items-center gap-2 text-[11px]">
              <span className="text-muted-foreground">{totalRows} Tage</span>
              {emp.totals.totalHours && (
                <span className="font-mono text-muted-foreground">{emp.totals.totalHours} h</span>
              )}
              {totalRows > 0 && (
                <span className={cn('font-semibold', highRows === totalRows ? 'text-green-600' : 'text-yellow-600')}>
                  {Math.round((highRows / totalRows) * 100)}% OK
                </span>
              )}
            </div>
            <EmpQualityBadge pct={pct} />
            {expanded
              ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
              : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-4">
          {/* Stammdaten */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <p className="text-muted-foreground mb-0.5 flex items-center gap-1"><User className="h-3 w-3" /> Name</p>
              <p className="font-semibold">{emp.name ?? '–'}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5 flex items-center gap-1"><Hash className="h-3 w-3" /> Personalnr.</p>
              <p className="font-semibold">{emp.personalnummer ?? '–'}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5">Kostenstelle</p>
              <p className="font-semibold">{emp.kostenstelle ?? '–'}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5 flex items-center gap-1"><Clock className="h-3 w-3" /> Wochenstunden</p>
              <p className="font-semibold">{emp.weeklyHours ? `${emp.weeklyHours} h` : '–'}</p>
            </div>
            {emp.eintritt && (
              <div>
                <p className="text-muted-foreground mb-0.5">Eintritt</p>
                <p className="font-semibold">{emp.eintritt}</p>
              </div>
            )}
            {emp.austritt && (
              <div>
                <p className="text-muted-foreground mb-0.5">Austritt</p>
                <p className="font-semibold">{emp.austritt}</p>
              </div>
            )}
          </div>

          {/* Totale */}
          {(emp.totals.totalHours || emp.totals.nettoTotal || emp.totals.saldo) && (
            <div className="flex flex-wrap gap-3 text-xs rounded-lg border border-border bg-muted/20 p-3">
              {emp.totals.totalHours && (
                <div><p className="text-muted-foreground">Total</p><p className="font-bold font-mono">{emp.totals.totalHours} h</p></div>
              )}
              {emp.totals.pauseTotal && (
                <div><p className="text-muted-foreground">Pause</p><p className="font-mono">{emp.totals.pauseTotal} h</p></div>
              )}
              {emp.totals.nettoTotal && (
                <div><p className="text-muted-foreground">Netto</p><p className="font-mono">{emp.totals.nettoTotal} h</p></div>
              )}
              {emp.totals.zeitzuschlag && (
                <div><p className="text-muted-foreground">Zeitzuschlag</p><p className="font-mono">{emp.totals.zeitzuschlag} h</p></div>
              )}
              {emp.totals.ueberzeit && (
                <div><p className="text-muted-foreground">Überzeit</p><p className="font-mono">{emp.totals.ueberzeit} h</p></div>
              )}
              {emp.totals.saldo && (
                <div><p className="text-muted-foreground">Saldo</p><p className="font-mono">{emp.totals.saldo}</p></div>
              )}
            </div>
          )}

          {/* Tageszeilen */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              Tageszeilen ({totalRows})
              {emp.uncertainRows > 0 && (
                <span className="text-yellow-600 dark:text-yellow-400">— {emp.uncertainRows} unsicher</span>
              )}
            </p>
            <DayRowsTable rows={emp.dayRows} />
          </div>

          {/* Rohzellen (Header) */}
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
                      <th className="text-left pr-2 py-0.5">Wert</th>
                      <th className="text-left py-0.5">Formatiert</th>
                    </tr>
                  </thead>
                  <tbody>
                    {emp.rawHeaderCells.map((cell, i) => (
                      <tr key={i} className="border-b border-border/30">
                        <td className="pr-2 py-0.5 text-primary font-semibold">{cell.cellRef}</td>
                        <td className="pr-2 py-0.5 text-muted-foreground">{cell.rowIdx + 1}</td>
                        <td className="pr-2 py-0.5 text-muted-foreground">{cell.colIdx + 1}</td>
                        <td className="pr-2 py-0.5 text-yellow-700 dark:text-yellow-400">
                          {String(cell.rawValue ?? '').slice(0, 60)}
                        </td>
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

// ─── Dokument-Karte ───────────────────────────────────────────────────────────

function DocumentResult({ doc }: { doc: ExcelParsedDocument }) {
  const q = doc.quality;

  return (
    <div className="space-y-4">
      {/* Datei-Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
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
        <span className={cn('text-sm font-bold px-3 py-1 rounded-full border', qualityBg(q.qualityPercent))}>
          {q.qualityPercent}% Qualität
        </span>
      </div>

      {/* Zusammenfassung */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            label: 'Mitarbeiter',
            value: q.totalEmployees,
            sub: `${doc.employees.filter(e => !!e.name).length} mit Namen`,
            ok: q.totalEmployees > 0,
            warn: false,
          },
          {
            label: 'Tageszeilen',
            value: q.totalDayRows,
            sub: `${q.uncertainRows} unsicher`,
            ok: q.totalDayRows > 0,
            warn: q.uncertainRows > 0,
          },
          {
            label: 'Totale erkannt',
            value: q.employeesWithTotals,
            sub: `von ${q.totalEmployees}`,
            ok: q.employeesWithTotals === q.totalEmployees && q.totalEmployees > 0,
            warn: q.employeesWithTotals > 0 && q.employeesWithTotals < q.totalEmployees,
          },
          {
            label: 'Ø Qualität',
            value: `${q.qualityPercent}%`,
            sub: q.qualityPercent >= 85 ? 'gut' : q.qualityPercent >= 60 ? 'teilweise' : 'kritisch',
            ok: q.qualityPercent >= 85,
            warn: q.qualityPercent >= 60 && q.qualityPercent < 85,
          },
        ].map(item => (
          <div key={item.label} className={cn(
            'rounded-lg border p-3',
            item.warn
              ? 'border-yellow-200 bg-yellow-50/40 dark:border-yellow-800 dark:bg-yellow-900/10'
              : item.ok
                ? 'border-green-200 bg-green-50/40 dark:border-green-800 dark:bg-green-900/10'
                : 'border-red-200 bg-red-50/40 dark:border-red-800 dark:bg-red-900/10',
          )}>
            <p className="text-[10px] text-muted-foreground mb-0.5">{item.label}</p>
            <p className="text-xl font-bold tabular-nums">{item.value}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{item.sub}</p>
          </div>
        ))}
      </div>

      {/* Warnungen */}
      {doc.warnings.length > 0 && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50/40 dark:border-yellow-800 dark:bg-yellow-900/10 p-3 space-y-1">
          {doc.warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-1.5 text-xs text-yellow-800 dark:text-yellow-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              {w}
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
            <EmployeeCard key={i} emp={emp} index={i} />
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
    e.preventDefault();
    setDragging(false);
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
        'flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed cursor-pointer transition-colors p-12',
        dragging
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-primary/60 hover:bg-muted/30',
      )}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <Upload className="h-10 w-10 text-muted-foreground" />
      <div className="text-center">
        <p className="text-sm font-semibold">Excel-Dateien hochladen</p>
        <p className="text-xs text-muted-foreground mt-0.5">.xls oder .xlsx — mehrere Dateien gleichzeitig möglich</p>
      </div>
      <input type="file" className="sr-only" multiple accept=".xls,.xlsx" onChange={handleChange} />
    </label>
  );
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

interface ParseResult {
  doc: ExcelParsedDocument | null;
  error: string | null;
  fileName: string;
}

export default function MirusExcelTest() {
  const [results, setResults] = useState<ParseResult[]>([]);
  const [parsing, setParsing]   = useState(false);

  const handleFiles = useCallback(async (files: File[]) => {
    setParsing(true);
    const newResults: ParseResult[] = await Promise.all(
      files.map(async (file): Promise<ParseResult> => {
        try {
          const doc = await parseMirusExcel(file);
          return { doc, error: null, fileName: file.name };
        } catch (err) {
          return { doc: null, error: String(err), fileName: file.name };
        }
      }),
    );
    setResults(prev => [...newResults, ...prev]);
    setParsing(false);
  }, []);

  // Vergleich: beste Qualität aus PDF (falls manuell eingetippt) vs. Excel
  const bestExcelQuality = results.reduce((max, r) => Math.max(max, r.doc?.quality.qualityPercent ?? 0), 0);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold flex items-center gap-2">
              <Table2 className="h-5 w-5 text-primary" />
              Mirus Excel Parser — Testseite
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Diagnostischer Import · keine Daten werden gespeichert
            </p>
          </div>
          {results.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">{results.length} Datei{results.length !== 1 ? 'en' : ''} geladen</span>
              <button
                onClick={() => setResults([])}
                className="text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                Alle löschen
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-8">

        {/* Dropzone */}
        <DropZone onFiles={handleFiles} />

        {/* Loading */}
        {parsing && (
          <div className="flex items-center justify-center gap-3 py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Dateien werden verarbeitet …</span>
          </div>
        )}

        {/* Vergleich PDF vs. Excel (wenn mehrere Ergebnisse) */}
        {results.length >= 1 && !parsing && (
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
              Import-Empfehlung
            </p>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className={cn(
                'rounded-lg border p-4',
                bestExcelQuality >= 85
                  ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-900/20'
                  : 'border-yellow-300 bg-yellow-50 dark:border-yellow-700 dark:bg-yellow-900/20',
              )}>
                <div className="flex items-center gap-1.5 mb-1">
                  {bestExcelQuality >= 85
                    ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                    : <AlertTriangle className="h-4 w-4 text-yellow-600" />}
                  <span className="font-bold">Excel-Import</span>
                </div>
                <p className={cn('text-2xl font-bold tabular-nums', qualityColor(bestExcelQuality))}>
                  {bestExcelQuality}%
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {bestExcelQuality >= 85
                    ? '✓ Empfohlen als Hauptimport'
                    : 'Parser-Anpassung erforderlich'}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="flex items-center gap-1.5 mb-1">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="font-bold text-muted-foreground">PDF-Import</span>
                </div>
                <p className="text-2xl font-bold tabular-nums text-muted-foreground">—</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Backup / Archiv · nicht priorisiert
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Ergebnisse */}
        {results.map((result, idx) => (
          <div key={idx} className="rounded-xl border border-border bg-card p-5 space-y-5">
            {result.error ? (
              <div className="flex items-start gap-3">
                <XCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-red-600 dark:text-red-400">{result.fileName}</p>
                  <p className="text-xs text-muted-foreground mt-1">{result.error}</p>
                </div>
              </div>
            ) : result.doc ? (
              <DocumentResult doc={result.doc} />
            ) : null}
          </div>
        ))}

        {/* Leer-Zustand */}
        {results.length === 0 && !parsing && (
          <div className="text-center py-8 text-muted-foreground">
            <Table2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Noch keine Dateien geladen.</p>
            <p className="text-xs mt-1">Teste mit: <code className="bg-muted px-1 rounded">Monatsblatt Januar 2026.xls</code></p>
          </div>
        )}

      </div>
    </div>
  );
}
