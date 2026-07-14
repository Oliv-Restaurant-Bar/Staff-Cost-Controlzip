/**
 * SimpleKüchenplanImportDialog
 * ============================
 * Schlanker 3-Schritt PDF-Import für den Küchen-Dienstplan.
 * Feste Schicht-Code-Tabelle — keine dynamische Code-Konfiguration.
 *
 * Schritt 1: PDF hochladen & parsen
 * Schritt 2: Mitarbeiter-Matching
 * Schritt 3: Vorschau & Import
 *
 * Codes (fix):
 *   A  = 10:00–17:30       (7.5h)
 *   B  = 11:30–21:30       (9.5h nach Pause)
 *   C  = 10:00–14:00       (4h)
 *   D  = 14:00–23:00       (9h)
 *   H  = 18:00–23:30       (5.5h)
 *   O2 = 07:00–11:30       (4.5h)
 *   O1 = 11:00–14:00 + 18:00–23:30  (Splitschicht, 8.5h)
 *   F  = Frei   → überspringen
 *   FE = Ferien → überspringen
 */

import React, { useState, useRef, useCallback, useMemo } from 'react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Upload, ChevronRight, Check, X, AlertTriangle, Info, FileText, RefreshCw,
} from 'lucide-react';
import { Employee } from '@/types/personnel';
import { DaySchedule } from './ScheduleGrid';
import { parseKüchenplanPDF, ParsedKüchenplan } from '@/lib/küchenplan-pdf-parser';
import { matchEmployeeByName } from '@/lib/mirus-name-mapping-store';
import { getEmployeeDisplayName } from '@/lib/personnel-utils';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// Fixed code table
// ─────────────────────────────────────────────────────────────────────────────

interface CodeDef {
  start: string;
  end: string;
  start2?: string;
  end2?: string;
  hours: number;
  label: string;
}

const FIXED_CODES: Record<string, CodeDef | null> = {
  A:  { start: '10:00', end: '17:30', hours: 7.5,  label: '10:00–17:30' },
  B:  { start: '11:30', end: '21:30', hours: 9.5,  label: '11:30–21:30' },
  C:  { start: '10:00', end: '14:00', hours: 4,    label: '10:00–14:00' },
  D:  { start: '14:00', end: '23:00', hours: 9,    label: '14:00–23:00' },
  H:  { start: '18:00', end: '23:30', hours: 5.5,  label: '18:00–23:30' },
  O2: { start: '07:00', end: '11:30', hours: 4.5,  label: '07:00–11:30' },
  O1: { start: '11:00', end: '14:00', start2: '18:00', end2: '23:30', hours: 8.5, label: '11:00–14:00 / 18:00–23:30' },
  F:  null,   // Frei – überspringen
  FE: null,   // Ferien – überspringen
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Step = 'upload' | 'matching' | 'preview';

interface NameMatch {
  rawName: string;
  employeeId: string | 'skip';
}

type RowStatus = 'ok' | 'skip' | 'unknown-code' | 'no-employee';

interface PreviewRow {
  rawName: string;
  employee: Employee | null;
  date: string;         // resolved ISO date
  origDate: string;     // parser-assigned date (used as key)
  code: string;
  codeDef: CodeDef | null | 'unknown';
  hours: number;
  status: RowStatus;
  hasConflict: boolean;
}

export interface SimpleKüchenplanImportDialogProps {
  open: boolean;
  onClose: () => void;
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  onImport: (delta: Record<string, DaySchedule>, count: number) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Baut origDate → resolvedDate Map mit Monats-Rollover-Erkennung. */
function buildResolvedDayMap(
  headerDays: ParsedKüchenplan['headerDays'],
  startDateStr: string,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!headerDays.length || !startDateStr) return map;
  const startDate = new Date(startDateStr + 'T00:00:00');
  if (isNaN(startDate.getTime())) return map;

  let year  = startDate.getFullYear();
  let month = startDate.getMonth();
  let prevDay = -1;

  for (const hd of headerDays) {
    if (prevDay >= 0 && hd.day < prevDay) {
      month++;
      if (month > 11) { month = 0; year++; }
    }
    prevDay = hd.day;
    const maxDay = new Date(year, month + 1, 0).getDate();
    const safeDay = Math.min(hd.day, maxDay);
    if (hd.origDate) {
      map.set(hd.origDate, format(new Date(year, month, safeDay), 'yyyy-MM-dd'));
    }
  }
  return map;
}

function safeFormatDate(iso: string, fmt: string): string {
  try {
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return iso;
    return format(d, fmt, { locale: de });
  } catch { return iso; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function SimpleKüchenplanImportDialog({
  open, onClose, employees, scheduleData, onImport,
}: SimpleKüchenplanImportDialogProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep]           = useState<Step>('upload');
  const [isLoading, setIsLoading] = useState(false);
  const [parsed, setParsed]       = useState<ParsedKüchenplan | null>(null);
  const [startDateStr, setStartDateStr] = useState('');
  const [nameMatches, setNameMatches]   = useState<NameMatch[]>([]);
  const [showLogs, setShowLogs]         = useState(false);
  const [importDone, setImportDone]     = useState(false);

  const kücheEmployees = employees.filter(e => e.department === 'küche');

  const resolvedDayMap = useMemo(
    () => buildResolvedDayMap(parsed?.headerDays ?? [], startDateStr),
    [parsed?.headerDays, startDateStr],
  );

  const resolveDate = useCallback(
    (origDate: string) => resolvedDayMap.get(origDate) ?? origDate,
    [resolvedDayMap],
  );

  // ── Step 1: Upload & Parse ─────────────────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      alert('Bitte eine PDF-Datei hochladen.');
      return;
    }
    setIsLoading(true);
    try {
      const result = await parseKüchenplanPDF(file);
      setParsed(result);

      const initStart =
        result.detectedStartDate ??
        result.detectedPeriod?.from ??
        format(new Date(), 'yyyy-MM-dd');
      setStartDateStr(initStart);

      const matches: NameMatch[] = result.detectedNames.map(rawName => {
        const { employee } = matchEmployeeByName(rawName, kücheEmployees);
        return { rawName, employeeId: employee ? employee.id : 'skip' };
      });
      setNameMatches(matches);

      if (result.entries.length > 0 && !result.error) {
        setStep('matching');
      }
    } finally {
      setIsLoading(false);
    }
  }, [kücheEmployees]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  // ── Step 2: Name matching helpers ─────────────────────────────────────────

  const updateMatch = (rawName: string, employeeId: string) => {
    setNameMatches(prev => prev.map(m => m.rawName === rawName ? { ...m, employeeId } : m));
  };

  // ── Step 3: Preview rows ───────────────────────────────────────────────────

  const previewRows: PreviewRow[] = useMemo(() => {
    if (!parsed) return [];
    const rows: PreviewRow[] = [];

    for (const entry of parsed.entries) {
      const upperCode = entry.code.toUpperCase();
      const match     = nameMatches.find(m => m.rawName === entry.rawName);
      const employee  = match && match.employeeId !== 'skip'
        ? kücheEmployees.find(e => e.id === match.employeeId) ?? null
        : null;

      const codeDef: CodeDef | null | 'unknown' =
        upperCode in FIXED_CODES ? FIXED_CODES[upperCode] : 'unknown';

      const resolvedDate = resolveDate(entry.date);
      const cellKey      = `${employee?.id}-${resolvedDate}`;
      const existing     = employee ? scheduleData[cellKey] : null;
      const hasConflict  = !!(existing?.früh || existing?.frühAbsence);

      let status: RowStatus = 'ok';
      if (codeDef === null)     status = 'skip';
      else if (!match || match.employeeId === 'skip') status = 'no-employee';
      else if (codeDef === 'unknown') status = 'unknown-code';

      const hours = (codeDef && codeDef !== 'unknown') ? codeDef.hours : 0;

      // Debug log per row
      const slots = codeDef === null
        ? 'skipped (F/FE)'
        : codeDef === 'unknown'
          ? 'unknown code'
          : codeDef.start2
            ? `2 Slots: ${codeDef.start}–${codeDef.end} / ${codeDef.start2}–${codeDef.end2}`
            : `1 Slot: ${codeDef.start}–${codeDef.end}`;
      console.log(
        `[IMPORT] Name: ${entry.rawName} | Datum: ${resolvedDate} | Code: ${entry.code} | Ergebnis: ${slots}`,
      );

      rows.push({
        rawName: entry.rawName,
        employee,
        date: resolvedDate,
        origDate: entry.date,
        code: upperCode,
        codeDef,
        hours,
        status,
        hasConflict,
      });
    }

    return rows.sort((a, b) => a.date.localeCompare(b.date) || (a.employee?.name ?? '').localeCompare(b.employee?.name ?? ''));
  }, [parsed, nameMatches, kücheEmployees, resolveDate, scheduleData]);

  const importableRows = previewRows.filter(r => r.status === 'ok');
  const skippedRows    = previewRows.filter(r => r.status === 'skip');
  const problemRows    = previewRows.filter(r => r.status === 'no-employee' || r.status === 'unknown-code');
  const conflictRows   = importableRows.filter(r => r.hasConflict);

  // ── Final Import ───────────────────────────────────────────────────────────

  const handleImport = () => {
    const delta: Record<string, DaySchedule> = {};
    let count = 0;

    for (const row of importableRows) {
      if (!row.employee || !row.codeDef || row.codeDef === 'unknown') continue;
      const cellKey = `${row.employee.id}-${row.date}`;
      const ds: DaySchedule = {};

      ds.früh = { start: row.codeDef.start, end: row.codeDef.end };
      if (row.codeDef.start2 && row.codeDef.end2) {
        ds.spät = { start: row.codeDef.start2, end: row.codeDef.end2 };
      }
      delta[cellKey] = ds;
      count++;
    }

    onImport(delta, count);
    setImportDone(true);
  };

  // ── Reset ──────────────────────────────────────────────────────────────────

  const handleReset = () => {
    setStep('upload');
    setParsed(null);
    setNameMatches([]);
    setStartDateStr('');
    setShowLogs(false);
    setImportDone(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleClose = () => {
    handleReset();
    onClose();
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Render helpers
  // ─────────────────────────────────────────────────────────────────────────────

  const STEPS: Step[] = ['upload', 'matching', 'preview'];
  const STEP_LABELS: Record<Step, string> = {
    upload:   '1. PDF hochladen',
    matching: '2. Mitarbeiter',
    preview:  '3. Vorschau & Import',
  };

  const statusBadge = (status: RowStatus, hasConflict: boolean) => {
    if (status === 'skip')          return <Badge variant="secondary" className="text-[10px]">Frei/Ferien – übersprungen</Badge>;
    if (status === 'no-employee')   return <Badge variant="outline" className="text-[10px] border-orange-400 text-orange-600">Kein MA</Badge>;
    if (status === 'unknown-code')  return <Badge variant="outline" className="text-[10px] border-red-400 text-red-600">Unbekannt</Badge>;
    if (hasConflict)                return <Badge variant="outline" className="text-[10px] border-yellow-400 text-yellow-700">Überschreibt</Badge>;
    return <Badge variant="outline" className="text-[10px] border-green-400 text-green-700">OK</Badge>;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogContent className="w-[95vw] max-w-[860px] max-h-[92vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4 text-orange-500" />
            Küchenplan PDF-Import (Einfach)
          </DialogTitle>
          {/* Step indicator */}
          <div className="flex items-center gap-1 mt-2 flex-wrap">
            {STEPS.map((s, i) => (
              <React.Fragment key={s}>
                <span className={cn(
                  'text-[11px] px-2 py-0.5 rounded-full font-medium transition-colors',
                  step === s
                    ? 'bg-orange-500 text-white'
                    : STEPS.indexOf(step) > i
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-muted text-muted-foreground',
                )}>
                  {STEP_LABELS[s]}
                </span>
                {i < STEPS.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
              </React.Fragment>
            ))}
          </div>
        </DialogHeader>

        <ScrollArea className="flex-1 overflow-auto">
          <div className="px-6 py-4 space-y-4">

            {/* ── STEP 1: Upload ──────────────────────────────────────────── */}
            {step === 'upload' && (
              <div className="space-y-4">
                {/* Code reference table */}
                <div className="rounded-md border p-3 bg-muted/30">
                  <p className="text-xs font-semibold text-muted-foreground mb-2">Feste Schicht-Codes (nicht editierbar)</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs">
                    {Object.entries(FIXED_CODES).map(([code, def]) => (
                      <div key={code} className={cn(
                        'flex items-center gap-2 px-2 py-1 rounded border',
                        def === null ? 'bg-gray-50 dark:bg-gray-900/30 text-muted-foreground' : 'bg-white dark:bg-gray-900/50',
                      )}>
                        <span className="font-bold w-6 shrink-0">{code}</span>
                        <span className="text-muted-foreground truncate">
                          {def === null ? '— übersprungen' : def.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Drop zone */}
                <div
                  className="border-2 border-dashed border-border rounded-lg p-10 text-center hover:border-orange-400 transition-colors cursor-pointer"
                  onDrop={handleDrop}
                  onDragOver={e => e.preventDefault()}
                  onClick={() => fileRef.current?.click()}
                >
                  <input ref={fileRef} type="file" accept=".pdf" className="hidden" onChange={handleFileInput} />
                  {isLoading ? (
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <RefreshCw className="h-8 w-8 animate-spin text-orange-400" />
                      <p className="text-sm">PDF wird verarbeitet…</p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <Upload className="h-8 w-8 text-orange-400" />
                      <p className="text-sm font-medium">PDF hierher ziehen oder klicken</p>
                      <p className="text-xs">Küchen-Dienstplan als PDF (aus Excel exportiert)</p>
                    </div>
                  )}
                </div>

                {/* Error */}
                {parsed?.error && (
                  <Alert className="border-red-200 bg-red-50 dark:bg-red-900/20">
                    <AlertTriangle className="h-4 w-4 text-red-500" />
                    <AlertDescription className="text-red-700 dark:text-red-300 text-xs">
                      {parsed.error}
                    </AlertDescription>
                  </Alert>
                )}

                {/* Parse result summary */}
                {parsed && !parsed.error && (
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant="outline">{parsed.entries.length} Einträge erkannt</Badge>
                    <Badge variant="outline">{parsed.detectedNames.length} Namen</Badge>
                    <Badge variant="outline">{parsed.detectedCodes.length} Codes: {parsed.detectedCodes.join(', ')}</Badge>
                    {parsed.detectedPeriod && (
                      <Badge variant="outline">
                        {safeFormatDate(parsed.detectedPeriod.from, 'd. MMM')} – {safeFormatDate(parsed.detectedPeriod.to, 'd. MMM yyyy')}
                      </Badge>
                    )}
                  </div>
                )}

                {/* Debug logs */}
                {parsed && parsed.logs.length > 0 && (
                  <div>
                    <button
                      className="text-xs text-muted-foreground underline"
                      onClick={() => setShowLogs(v => !v)}
                    >
                      {showLogs ? 'Logs ausblenden' : `Parser-Logs anzeigen (${parsed.logs.length})`}
                    </button>
                    {showLogs && (
                      <div className="mt-1 rounded border bg-muted/50 p-2 text-[10px] font-mono text-muted-foreground max-h-32 overflow-y-auto">
                        {parsed.logs.map((l, i) => <div key={i}>{l}</div>)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── STEP 2: Employee Matching ─────────────────────────────────── */}
            {step === 'matching' && (
              <div className="space-y-4">
                {/* Start date override */}
                <div className="flex items-center gap-3 p-3 rounded-md bg-muted/30 border">
                  <Info className="h-4 w-4 text-blue-500 shrink-0" />
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <span className="text-muted-foreground">Start-Datum des Plans:</span>
                    <Input
                      type="date"
                      value={startDateStr}
                      onChange={e => setStartDateStr(e.target.value)}
                      className="h-7 w-36 text-xs"
                    />
                    <span className="text-muted-foreground">(Monats-Rollover wird automatisch erkannt)</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Badge variant="outline">{nameMatches.filter(m => m.employeeId !== 'skip').length} zugeordnet</Badge>
                  <Badge variant="outline" className="border-orange-400 text-orange-600">
                    {nameMatches.filter(m => m.employeeId === 'skip').length} nicht gefunden
                  </Badge>
                </div>

                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Name im PDF</th>
                        <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Mitarbeiter (Küche)</th>
                        <th className="px-3 py-2 text-center font-semibold text-muted-foreground w-8"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {nameMatches.map(m => {
                        const isSkipped = m.employeeId === 'skip';
                        return (
                          <tr key={m.rawName} className={isSkipped ? 'bg-orange-50/40 dark:bg-orange-900/10' : ''}>
                            <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{m.rawName}</td>
                            <td className="px-3 py-2">
                              <Select
                                value={m.employeeId}
                                onValueChange={val => updateMatch(m.rawName, val)}
                              >
                                <SelectTrigger className="h-7 text-xs">
                                  <SelectValue placeholder="Mitarbeiter wählen…" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="skip">— überspringen —</SelectItem>
                                  {kücheEmployees.map(e => (
                                    <SelectItem key={e.id} value={e.id}>
                                      {getEmployeeDisplayName(e)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </td>
                            <td className="px-3 py-2 text-center">
                              {isSkipped
                                ? <X className="h-4 w-4 text-orange-400 mx-auto" />
                                : <Check className="h-4 w-4 text-green-500 mx-auto" />}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── STEP 3: Preview ────────────────────────────────────────────── */}
            {step === 'preview' && (
              <div className="space-y-4">
                {importDone ? (
                  <Alert className="border-green-200 bg-green-50 dark:bg-green-900/20">
                    <Check className="h-4 w-4 text-green-600" />
                    <AlertDescription className="text-green-800 dark:text-green-300">
                      <strong>{importableRows.length} Einträge</strong> wurden in den Dienstplan importiert.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <>
                    {/* Summary badges */}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                        <Check className="h-3 w-3 mr-1" />
                        {importableRows.length} importierbar
                      </Badge>
                      {skippedRows.length > 0 && (
                        <Badge variant="secondary">
                          {skippedRows.length} Frei/Ferien – übersprungen
                        </Badge>
                      )}
                      {conflictRows.length > 0 && (
                        <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          {conflictRows.length} überschreiben bestehende Einträge
                        </Badge>
                      )}
                      {problemRows.length > 0 && (
                        <Badge className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300">
                          <X className="h-3 w-3 mr-1" />
                          {problemRows.length} Probleme (kein MA / unbekannter Code)
                        </Badge>
                      )}
                    </div>

                    {importableRows.length === 0 && (
                      <Alert>
                        <Info className="h-4 w-4" />
                        <AlertDescription className="text-sm">
                          Keine importierbaren Einträge. Bitte Mitarbeiter-Matching prüfen.
                        </AlertDescription>
                      </Alert>
                    )}
                  </>
                )}

                {/* Preview table */}
                <div className="rounded-md border overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs min-w-[540px]">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="px-2 py-2 text-left font-semibold text-muted-foreground">Mitarbeiter</th>
                          <th className="px-2 py-2 text-left font-semibold text-muted-foreground">Datum</th>
                          <th className="px-2 py-2 text-center font-semibold text-muted-foreground">Code</th>
                          <th className="px-2 py-2 text-left font-semibold text-muted-foreground">Zeit(en)</th>
                          <th className="px-2 py-2 text-right font-semibold text-muted-foreground">Std.</th>
                          <th className="px-2 py-2 text-center font-semibold text-muted-foreground">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {previewRows.map((row, i) => {
                          const isSkip = row.status === 'skip';
                          const isOk   = row.status === 'ok';
                          return (
                            <tr
                              key={i}
                              className={cn(
                                isSkip && 'opacity-40',
                                row.status === 'no-employee' && 'bg-orange-50/40 dark:bg-orange-900/10',
                                row.status === 'unknown-code' && 'bg-red-50/40 dark:bg-red-900/10',
                                isOk && row.hasConflict && 'bg-yellow-50/40 dark:bg-yellow-900/10',
                              )}
                            >
                              <td className="px-2 py-1.5">
                                {row.employee
                                  ? getEmployeeDisplayName(row.employee)
                                  : <span className="text-orange-500 italic">{row.rawName}</span>}
                              </td>
                              <td className="px-2 py-1.5 whitespace-nowrap">
                                {safeFormatDate(row.date, 'EE, d. MMM')}
                              </td>
                              <td className="px-2 py-1.5 text-center font-bold">
                                {row.code}
                              </td>
                              <td className="px-2 py-1.5 text-muted-foreground">
                                {row.codeDef === null
                                  ? '—'
                                  : row.codeDef === 'unknown'
                                    ? <span className="text-red-500">Unbekannt</span>
                                    : row.codeDef.start2
                                      ? <span>{row.codeDef.start}–{row.codeDef.end} <span className="text-muted-foreground/60">+</span> {row.codeDef.start2}–{row.codeDef.end2}</span>
                                      : <span>{row.codeDef.start}–{row.codeDef.end}</span>
                                }
                              </td>
                              <td className="px-2 py-1.5 text-right">
                                {row.hours > 0 ? `${row.hours}h` : '—'}
                              </td>
                              <td className="px-2 py-1.5 text-center">
                                {statusBadge(row.status, row.hasConflict)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="px-6 py-4 border-t bg-muted/20 flex items-center justify-between gap-3">
          <Button variant="ghost" size="sm" onClick={handleReset}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Neu starten
          </Button>

          <div className="flex items-center gap-2">
            {step !== 'upload' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const idx = STEPS.indexOf(step);
                  if (idx > 0) setStep(STEPS[idx - 1]);
                }}
              >
                Zurück
              </Button>
            )}

            {step === 'upload' && parsed && !parsed.error && parsed.entries.length > 0 && (
              <Button
                size="sm"
                className="bg-orange-500 hover:bg-orange-600 text-white"
                onClick={() => setStep('matching')}
              >
                Weiter <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            )}

            {step === 'matching' && (
              <Button
                size="sm"
                className="bg-orange-500 hover:bg-orange-600 text-white"
                onClick={() => setStep('preview')}
              >
                Vorschau <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            )}

            {step === 'preview' && !importDone && importableRows.length > 0 && (
              <Button
                size="sm"
                className="bg-green-600 hover:bg-green-700 text-white"
                onClick={handleImport}
              >
                <Check className="h-3.5 w-3.5 mr-1" />
                {importableRows.length} Einträge importieren
              </Button>
            )}

            {importDone && (
              <Button size="sm" onClick={handleClose}>
                Schliessen
              </Button>
            )}

            <Button variant="ghost" size="sm" onClick={handleClose}>
              <X className="h-3.5 w-3.5 mr-1" />
              Abbrechen
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
