/**
 * Mirus PDF Parser — Testseite
 * ============================
 * Lädt Mirus-Monatsblätter, parst sie und zeigt alle erkannten
 * Daten als Debug-Tabelle an. Kein Speichern, kein Supabase.
 */

import { useState, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import {
  Upload, FileText, ChevronDown, ChevronUp,
  AlertTriangle, CheckCircle2, XCircle, Info,
  User, Calendar, Hash, Clock, Loader2,
} from 'lucide-react';
import { parseMirusPDF } from '@/lib/mirus-pdf-parser';
import type {
  MirusParsedDocument, MirusEmployee, MirusDayRow,
} from '@/lib/mirus-pdf-parser';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function qualityColor(pct: number) {
  if (pct >= 80) return 'text-green-600 dark:text-green-400';
  if (pct >= 50) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

function qualityBg(pct: number) {
  if (pct >= 80) return 'bg-green-500';
  if (pct >= 50) return 'bg-yellow-500';
  return 'bg-red-500';
}

function confBadge(c: 'high' | 'medium' | 'low') {
  if (c === 'high')   return 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-200';
  if (c === 'medium') return 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 border-yellow-200';
  return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200';
}

function deptBadge(dept: string | null) {
  if (!dept) return 'bg-muted text-muted-foreground';
  if (dept === 'service') return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300';
  if (dept === 'küche')   return 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300';
  return 'bg-muted text-muted-foreground';
}

// ─── Sub-Komponenten ──────────────────────────────────────────────────────────

function MetaCard({ doc }: { doc: MirusParsedDocument }) {
  return (
    <Card className="border border-border">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Info className="h-4 w-4 text-primary" />
          Erkannte Monatsdaten
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <p className="text-muted-foreground mb-0.5">Monat</p>
            <p className="font-semibold">{doc.monthName ?? <em className="text-muted-foreground">–</em>}</p>
          </div>
          <div>
            <p className="text-muted-foreground mb-0.5">Jahr</p>
            <p className="font-semibold">{doc.year ?? <em className="text-muted-foreground">–</em>}</p>
          </div>
          <div>
            <p className="text-muted-foreground mb-0.5">Restaurant</p>
            <p className="font-semibold">{doc.restaurant ?? <em className="text-muted-foreground">–</em>}</p>
          </div>
          <div>
            <p className="text-muted-foreground mb-0.5">Erstellungsdatum</p>
            <p className="font-semibold">{doc.creationDate ?? <em className="text-muted-foreground">–</em>}</p>
          </div>
        </div>
        {doc.warnings.length > 0 && (
          <div className="mt-3 space-y-1">
            {doc.warnings.map((w, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[11px] text-yellow-700 dark:text-yellow-300">
                <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                {w}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DayRowsTable({ rows }: { rows: MirusDayRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic py-3 text-center">
        Keine Tageszeilen erkannt
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="text-left px-2 py-1.5 font-semibold text-muted-foreground w-20">Datum</th>
            <th className="text-left px-2 py-1.5 font-semibold text-muted-foreground w-10">Tag</th>
            <th className="text-left px-2 py-1.5 font-semibold text-muted-foreground">Zeitblöcke</th>
            <th className="text-center px-2 py-1.5 font-semibold text-muted-foreground w-16">Pause</th>
            <th className="text-center px-2 py-1.5 font-semibold text-muted-foreground w-16">Total h</th>
            <th className="text-center px-2 py-1.5 font-semibold text-muted-foreground w-20">Absenz</th>
            <th className="text-center px-2 py-1.5 font-semibold text-muted-foreground w-8">N</th>
            <th className="text-left px-2 py-1.5 font-semibold text-muted-foreground">Bemerkung</th>
            <th className="text-center px-2 py-1.5 font-semibold text-muted-foreground w-20">Konfidenz</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className={cn(
                'border-b border-border/50',
                row.confidence === 'low'    ? 'bg-red-50/60 dark:bg-red-950/10' :
                row.confidence === 'medium' ? 'bg-yellow-50/40 dark:bg-yellow-950/10' :
                i % 2 === 0 ? 'bg-transparent' : 'bg-muted/20',
              )}
            >
              <td className="px-2 py-1 font-mono">{row.date ?? <span className="text-red-500">?</span>}</td>
              <td className="px-2 py-1 font-medium">{row.weekday ?? <span className="text-muted-foreground">–</span>}</td>
              <td className="px-2 py-1">
                {row.timeBlocks.length > 0
                  ? row.timeBlocks.map((b, j) => (
                      <span key={j} className="inline-block bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded px-1 mr-1 font-mono text-[10px]">
                        {b.from}–{b.to}
                      </span>
                    ))
                  : <span className="text-muted-foreground">–</span>
                }
              </td>
              <td className="px-2 py-1 text-center font-mono">{row.pause ?? '–'}</td>
              <td className="px-2 py-1 text-center font-mono font-semibold">{row.totalHours ?? '–'}</td>
              <td className="px-2 py-1 text-center">
                {row.absenceCodes.length > 0
                  ? row.absenceCodes.map(c => (
                      <span key={c} className="inline-block bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded px-1 text-[10px] font-bold mr-0.5">
                        {c}
                      </span>
                    ))
                  : <span className="text-muted-foreground">–</span>
                }
              </td>
              <td className="px-2 py-1 text-center">
                {row.nightSupplement && (
                  <span className="inline-block bg-slate-200 dark:bg-slate-700 rounded px-1 text-[10px] font-bold">N</span>
                )}
              </td>
              <td className="px-2 py-1 text-muted-foreground">{row.remark ?? '–'}</td>
              <td className="px-2 py-1 text-center">
                <span className={cn('inline-block px-1.5 py-0.5 rounded border text-[9px] font-bold', confBadge(row.confidence))}>
                  {row.confidence === 'high' ? 'OK' : row.confidence === 'medium' ? 'UNSICHER' : 'FEHLER'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TotalsRow({ emp }: { emp: MirusEmployee }) {
  const t = emp.totals;
  const fields = [
    { label: 'Total Stunden', value: t.totalHours },
    { label: 'Pause Total', value: t.pauseTotal },
    { label: 'Netto / Total', value: t.nettoTotal },
    { label: 'Zeitzuschlag', value: t.zeitzuschlag },
    { label: 'Überzeit', value: t.ueberzeit },
    { label: 'Saldo', value: t.saldo },
  ];
  return (
    <div className="mt-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Erkannte Totale</p>
      <div className="flex flex-wrap gap-2">
        {fields.map(f => (
          <div key={f.label} className={cn(
            'rounded border px-2 py-1 text-xs',
            f.value
              ? 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800'
              : 'bg-muted/30 border-dashed border-border',
          )}>
            <span className="text-muted-foreground">{f.label}: </span>
            <span className={cn('font-mono font-semibold', f.value ? '' : 'text-muted-foreground italic')}>
              {f.value ?? 'nicht erkannt'}
            </span>
          </div>
        ))}
        <div className={cn(
          'rounded border px-2 py-1 text-xs',
          t.signatureFound
            ? 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200'
            : 'bg-muted/30 border-dashed',
        )}>
          <span className="text-muted-foreground">Unterschrift: </span>
          <span className={cn('font-semibold', t.signatureFound ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground italic')}>
            {t.signatureFound ? 'Ja' : 'Nicht erkannt'}
          </span>
        </div>
      </div>
    </div>
  );
}

function EmployeeCard({ emp, index }: { emp: MirusEmployee; index: number }) {
  const [expanded, setExpanded]       = useState(true);
  const [showRaw, setShowRaw]         = useState(false);

  const highRows = emp.dayRows.filter(r => r.confidence === 'high').length;
  const totalRows = emp.dayRows.length;
  const hasIssues = emp.uncertainRows > 0 || !emp.totals.totalHours;

  return (
    <Card className={cn(
      'border',
      hasIssues ? 'border-yellow-300 dark:border-yellow-700' : 'border-border',
    )}>
      {/* Header */}
      <button
        className="w-full text-left"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold">
              {index + 1}
            </div>
            <div>
              <p className="text-sm font-bold">{emp.name ?? `Mitarbeiter ${index + 1}`}</p>
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
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Stats */}
            <div className="hidden sm:flex items-center gap-2 text-[11px]">
              <span className="text-muted-foreground">{totalRows} Zeilen</span>
              {emp.uncertainRows > 0 && (
                <span className="text-yellow-600 dark:text-yellow-400 font-semibold">
                  ⚠ {emp.uncertainRows} unsicher
                </span>
              )}
              {totalRows > 0 && (
                <span className={cn('font-semibold', highRows === totalRows ? 'text-green-600' : 'text-yellow-600')}>
                  {Math.round((highRows / totalRows) * 100)}% OK
                </span>
              )}
            </div>
            {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-4">
          {/* Stammdaten */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <p className="text-muted-foreground mb-0.5 flex items-center gap-1"><User className="h-3 w-3" /> Name</p>
              <p className="font-semibold">{emp.name ?? <em className="text-muted-foreground">–</em>}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5 flex items-center gap-1"><Hash className="h-3 w-3" /> Personalnr.</p>
              <p className="font-semibold">{emp.personalnummer ?? <em className="text-muted-foreground">–</em>}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5">Kostenstelle</p>
              <p className="font-semibold">{emp.kostenstelle ?? <em className="text-muted-foreground">–</em>}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5 flex items-center gap-1"><Clock className="h-3 w-3" /> Wochenstunden</p>
              <p className="font-semibold">{emp.weeklyHours ? `${emp.weeklyHours} h` : <em className="text-muted-foreground">–</em>}</p>
            </div>
          </div>

          {/* Tageszeilen */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              Erkannte Tageszeilen ({totalRows})
              {emp.uncertainRows > 0 && (
                <span className="text-yellow-600 dark:text-yellow-400 ml-1">
                  — {emp.uncertainRows} unsicher
                </span>
              )}
            </p>
            <DayRowsTable rows={emp.dayRows} />
          </div>

          {/* Totale */}
          <TotalsRow emp={emp} />

          {/* Rohtext (einklappbar) */}
          <div>
            <button
              onClick={() => setShowRaw(r => !r)}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {showRaw ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              Rohtext ({emp.rawLines.length} Zeilen)
            </button>
            {showRaw && (
              <pre className="mt-2 max-h-64 overflow-y-auto rounded border border-border bg-muted/30 p-3 text-[10px] leading-relaxed whitespace-pre-wrap font-mono text-muted-foreground">
                {emp.rawLines.map((l, i) => `${String(i + emp.startLine + 1).padStart(4, ' ')}: ${l}`).join('\n')}
              </pre>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function QualityPanel({ doc }: { doc: MirusParsedDocument }) {
  const q = doc.quality;
  const items = [
    { label: 'Erkannte Mitarbeiter', value: q.totalEmployees, icon: <User className="h-4 w-4" />, good: q.totalEmployees > 0 },
    { label: 'Erkannte Tageszeilen', value: q.totalDayRows,   icon: <Calendar className="h-4 w-4" />, good: q.totalDayRows > 0 },
    { label: 'Unsichere Zeilen',     value: q.uncertainRows,  icon: <AlertTriangle className="h-4 w-4" />, good: q.uncertainRows === 0, bad: q.uncertainRows > 0 },
    { label: 'Totale nicht erkannt', value: q.unassignedTotals, icon: <Hash className="h-4 w-4" />, good: q.unassignedTotals === 0, bad: q.unassignedTotals > 0 },
  ];

  return (
    <Card className="border border-border">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-primary" />
          Parser-Qualität
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-4">
        {/* Quality bar */}
        <div>
          <div className="flex items-end justify-between mb-1.5">
            <span className="text-xs text-muted-foreground">Gesamtqualität</span>
            <span className={cn('text-2xl font-bold tabular-nums', qualityColor(q.qualityPercent))}>
              {q.qualityPercent} %
            </span>
          </div>
          <div className="h-2.5 rounded-full bg-muted overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', qualityBg(q.qualityPercent))}
              style={{ width: `${q.qualityPercent}%` }}
            />
          </div>
        </div>

        {/* Metrics grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {items.map(item => (
            <div key={item.label} className={cn(
              'rounded-lg border p-3',
              item.bad ? 'border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/10' :
              item.good ? 'border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/10' :
              'border-border',
            )}>
              <div className={cn(
                'mb-1',
                item.bad ? 'text-red-500' : item.good ? 'text-green-500' : 'text-muted-foreground',
              )}>
                {item.icon}
              </div>
              <p className="text-lg font-bold tabular-nums">{item.value}</p>
              <p className="text-[10px] text-muted-foreground leading-tight">{item.label}</p>
            </div>
          ))}
        </div>

        {/* Interpretation */}
        <div className={cn(
          'rounded-lg border p-3 text-xs',
          q.qualityPercent >= 80
            ? 'bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
            : q.qualityPercent >= 50
              ? 'bg-yellow-50 dark:bg-yellow-950/20 border-yellow-200 dark:border-yellow-800 text-yellow-700 dark:text-yellow-300'
              : 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300',
        )}>
          {q.qualityPercent >= 80
            ? '✓ Erkennung stabil — Import-Implementierung kann beginnen.'
            : q.qualityPercent >= 50
              ? '⚠ Erkennung teilweise erfolgreich — Parser-Regeln müssen verfeinert werden.'
              : '✗ Erkennung unzuverlässig — PDF-Format ist unbekannt oder abweichend. Rohtext prüfen.'}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Upload-Bereich ───────────────────────────────────────────────────────────

function DropZone({
  onFiles,
  loading,
}: {
  onFiles: (files: File[]) => void;
  loading: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
    if (files.length > 0) onFiles(files);
  }, [onFiles]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onFiles(files);
    e.target.value = '';
  }, [onFiles]);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => !loading && inputRef.current?.click()}
      className={cn(
        'relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 cursor-pointer transition-colors',
        dragging
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-primary/50 hover:bg-muted/30',
        loading && 'pointer-events-none opacity-60',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        multiple
        className="hidden"
        onChange={handleChange}
      />
      {loading ? (
        <>
          <Loader2 className="h-10 w-10 text-primary animate-spin mb-3" />
          <p className="text-sm font-medium">PDF wird geparst…</p>
        </>
      ) : (
        <>
          <Upload className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm font-medium">Mirus-PDF hier ablegen</p>
          <p className="text-xs text-muted-foreground mt-1">oder klicken zum Auswählen — mehrere PDFs gleichzeitig möglich</p>
          <p className="text-[11px] text-muted-foreground/60 mt-2">Kein Speichern — nur Analyse</p>
        </>
      )}
    </div>
  );
}

// ─── Ergebnis pro Datei ───────────────────────────────────────────────────────

interface ParseResult {
  fileName: string;
  doc: MirusParsedDocument | null;
  error: string | null;
  durationMs: number;
}

function ResultSection({ result }: { result: ParseResult }) {
  const [showAllLines, setShowAllLines] = useState(false);

  if (result.error) {
    return (
      <Card className="border border-red-300 dark:border-red-700">
        <CardContent className="px-4 py-4 flex items-center gap-3">
          <XCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-700 dark:text-red-300">{result.fileName}</p>
            <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">{result.error}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const doc = result.doc!;

  return (
    <div className="space-y-4">
      {/* File header */}
      <div className="flex items-center gap-3">
        <FileText className="h-5 w-5 text-primary flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm truncate">{result.fileName}</p>
          <p className="text-[11px] text-muted-foreground">
            {doc.allLines.length} Textzeilen extrahiert · geparst in {result.durationMs} ms
          </p>
        </div>
        <Badge variant="outline" className={cn(
          'text-[10px]',
          doc.quality.qualityPercent >= 80 ? 'border-green-300 text-green-700' :
          doc.quality.qualityPercent >= 50 ? 'border-yellow-300 text-yellow-700' :
          'border-red-300 text-red-700',
        )}>
          {doc.quality.qualityPercent}% Qualität
        </Badge>
      </div>

      {/* Metadaten */}
      <MetaCard doc={doc} />

      {/* Mitarbeiter-Karten */}
      {doc.employees.length > 0 ? (
        <div className="space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <User className="h-3.5 w-3.5" />
            Erkannte Mitarbeiter ({doc.employees.length})
          </h2>
          {doc.employees.map((emp, i) => (
            <EmployeeCard key={i} emp={emp} index={i} />
          ))}
        </div>
      ) : (
        <Card className="border-dashed border-border">
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            Keine Mitarbeiter-Abschnitte erkannt — Rohtext unten prüfen.
          </CardContent>
        </Card>
      )}

      {/* Qualität */}
      <QualityPanel doc={doc} />

      {/* Gesamter Rohtext (einklappbar) */}
      <Card className="border border-border">
        <button
          onClick={() => setShowAllLines(r => !r)}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <span className="text-xs font-semibold flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            Alle extrahierten Zeilen ({doc.allLines.length})
          </span>
          {showAllLines ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>
        {showAllLines && (
          <div className="border-t border-border">
            <pre className="max-h-96 overflow-y-auto p-4 text-[10px] leading-relaxed whitespace-pre-wrap font-mono text-muted-foreground">
              {doc.allLines.map((l, i) => (
                `${String(i + 1).padStart(4, ' ')}  [S${l.pageNum}]  ${l.text}\n`
              )).join('')}
            </pre>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

export default function MirusParserTest() {
  const [loading,  setLoading]  = useState(false);
  const [results,  setResults]  = useState<ParseResult[]>([]);

  const handleFiles = useCallback(async (files: File[]) => {
    setLoading(true);
    setResults([]);

    const newResults: ParseResult[] = [];

    for (const file of files) {
      const t0 = Date.now();
      try {
        const doc = await parseMirusPDF(file);
        newResults.push({
          fileName: file.name,
          doc,
          error: null,
          durationMs: Date.now() - t0,
        });
      } catch (err) {
        newResults.push({
          fileName: file.name,
          doc: null,
          error: String(err),
          durationMs: Date.now() - t0,
        });
      }
    }

    setResults(newResults);
    setLoading(false);
  }, []);

  const handleReset = () => {
    setResults([]);
    setLoading(false);
  };

  return (
    <div className="p-4 md:p-6 max-w-[1200px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="flex items-center gap-1.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 px-2.5 py-1 rounded-md">
              <FileText className="h-4 w-4" />
              <span className="text-sm font-bold">Parser-Test</span>
            </div>
            <Badge variant="outline" className="text-[10px]">Beta · Kein Speichern</Badge>
          </div>
          <h1 className="text-xl font-bold">Mirus PDF Parser — Diagnose</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Analysiert Mirus-Monatsblätter ohne Datenspeicherung
          </p>
        </div>
        {results.length > 0 && (
          <Button variant="outline" size="sm" onClick={handleReset}>
            Zurücksetzen
          </Button>
        )}
      </div>

      {/* Hinweis */}
      <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
        <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold mb-0.5">Nur Test-Modus</p>
          <p>Es werden keine Daten in Supabase gespeichert. Keine Monatsblätter werden erstellt. Nur Analyse der PDF-Erkennungsqualität.</p>
        </div>
      </div>

      {/* Upload */}
      {results.length === 0 && (
        <DropZone onFiles={handleFiles} loading={loading} />
      )}

      {/* Ergebnisse */}
      {results.length > 0 && (
        <>
          {/* Multi-File Übersicht */}
          {results.length > 1 && (
            <Card className="border border-border">
              <CardContent className="px-4 py-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  {results.length} Dateien analysiert
                </p>
                <div className="space-y-1.5">
                  {results.map((r, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="truncate mr-4">{r.fileName}</span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {r.error
                          ? <span className="text-red-600 font-semibold">Fehler</span>
                          : <>
                              <span className="text-muted-foreground">{r.doc!.employees.length} MA</span>
                              <span className="text-muted-foreground">·</span>
                              <span className="text-muted-foreground">{r.doc!.quality.totalDayRows} Zeilen</span>
                              <span className={cn('font-semibold', qualityColor(r.doc!.quality.qualityPercent))}>
                                {r.doc!.quality.qualityPercent}%
                              </span>
                            </>
                        }
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Weiteres PDF hinzufügen */}
          <DropZone onFiles={handleFiles} loading={loading} />

          {/* Einzelne Ergebnisse */}
          {results.map((r, i) => (
            <div key={i} className="space-y-2">
              {results.length > 1 && (
                <div className="h-px bg-border my-6" />
              )}
              <ResultSection result={r} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
