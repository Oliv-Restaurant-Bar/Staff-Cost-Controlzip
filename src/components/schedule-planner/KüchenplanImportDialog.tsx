/**
 * KüchenplanImportDialog
 * ======================
 * Halbautomatischer PDF-Import für Küchen-Dienstpläne.
 * 4-stufiger Wizard: Upload → Code-Mapping → Mitarbeiter-Matching → Vorschau & Import
 */

import React, { useState, useRef, useCallback } from 'react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Upload, ChevronRight, Check, X, AlertTriangle, Info,
  FileText, User, RefreshCw, ChevronDown, ChevronUp,
} from 'lucide-react';
import { Employee } from '@/types/personnel';
import { DaySchedule } from './ScheduleGrid';
import { parseKüchenplanPDF, ParsedKüchenplan } from '@/lib/küchenplan-pdf-parser';
import {
  loadSchichtCodeMapping, saveSchichtCodeMapping, getMappingForCode,
  SchichtCodeEntry, computeHours,
} from '@/lib/schicht-code-mapping-store';
import { matchEmployeeByName } from '@/lib/mirus-name-mapping-store';
import { getEmployeeDisplayName } from '@/lib/personnel-utils';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Step = 'upload' | 'mapping' | 'matching' | 'preview';

interface NameMatch {
  rawName: string;
  employeeId: string | 'skip';
}

interface PreviewRow {
  rawName: string;
  employee: Employee;
  date: string;
  code: string;
  mapped: SchichtCodeEntry;
  hours: number;
  hasConflict: boolean;
}

interface KüchenplanImportDialogProps {
  open: boolean;
  onClose: () => void;
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  onImport: (delta: Record<string, DaySchedule>, count: number) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const STEP_LABELS: Record<Step, string> = {
  upload: '1. PDF hochladen',
  mapping: '2. Code-Mapping',
  matching: '3. Mitarbeiter',
  preview: '4. Vorschau',
};

const TYPE_LABELS: Record<string, string> = {
  work: 'Arbeit',
  vacation: 'Ferien',
  absence: 'Abwesenheit',
  off: 'Frei',
};

const TYPE_COLORS: Record<string, string> = {
  work: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  vacation: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  absence: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  off: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function KüchenplanImportDialog({
  open, onClose, employees, scheduleData, onImport,
}: KüchenplanImportDialogProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('upload');
  const [isLoading, setIsLoading] = useState(false);
  const [parsed, setParsed] = useState<ParsedKüchenplan | null>(null);
  const [codeMapping, setCodeMapping] = useState<SchichtCodeEntry[]>(() => loadSchichtCodeMapping());
  const [nameMatches, setNameMatches] = useState<NameMatch[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  const kücheEmployees = employees.filter(e => e.department === 'küche');

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

      // Pre-build name matches using existing matching logic
      const matches: NameMatch[] = result.detectedNames.map(rawName => {
        const { employee } = matchEmployeeByName(rawName, kücheEmployees);
        return { rawName, employeeId: employee ? employee.id : 'skip' };
      });
      setNameMatches(matches);

      // Add any new codes to the mapping if not already present
      const currentCodes = codeMapping.map(e => e.code.toUpperCase());
      const newEntries: SchichtCodeEntry[] = [];
      for (const code of result.detectedCodes) {
        if (!currentCodes.includes(code.toUpperCase())) {
          newEntries.push({ code, label: code, type: 'work', start: '07:00', end: '15:30' });
        }
      }
      if (newEntries.length > 0) {
        setCodeMapping(prev => [...prev, ...newEntries]);
      }

      if (result.entries.length > 0) {
        setStep('mapping');
      }
    } finally {
      setIsLoading(false);
    }
  }, [kücheEmployees, codeMapping]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  // ── Step 2: Code Mapping ───────────────────────────────────────────────────

  const detectedCodesInMapping = parsed
    ? codeMapping.filter(e =>
        parsed.detectedCodes.some(c => c.toUpperCase() === e.code.toUpperCase()))
    : [];

  const unmappedCodes = parsed
    ? parsed.detectedCodes.filter(c =>
        !codeMapping.some(e => e.code.toUpperCase() === c.toUpperCase()))
    : [];

  const updateCodeEntry = (idx: number, patch: Partial<SchichtCodeEntry>) => {
    setCodeMapping(prev => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], ...patch };
      return copy;
    });
  };

  const handleSaveMapping = () => {
    saveSchichtCodeMapping(codeMapping);
  };

  // ── Step 3: Employee Matching ──────────────────────────────────────────────

  const matchedCount = nameMatches.filter(m => m.employeeId !== 'skip').length;
  const unmatchedCount = nameMatches.filter(m => m.employeeId === 'skip').length;

  const updateMatch = (rawName: string, employeeId: string) => {
    setNameMatches(prev => prev.map(m =>
      m.rawName === rawName ? { ...m, employeeId } : m
    ));
  };

  // ── Step 4: Preview ────────────────────────────────────────────────────────

  const buildPreview = (): PreviewRow[] => {
    if (!parsed) return [];
    const rows: PreviewRow[] = [];

    for (const entry of parsed.entries) {
      const match = nameMatches.find(m => m.rawName === entry.rawName);
      if (!match || match.employeeId === 'skip') continue;

      const employee = kücheEmployees.find(e => e.id === match.employeeId);
      if (!employee) continue;

      const mapped = getMappingForCode(entry.code, codeMapping);
      if (!mapped) continue;

      const hours = computeHours(mapped);
      const cellKey = `${employee.id}-${entry.date}`;
      const existing = scheduleData[cellKey];
      const hasConflict = !!(existing?.früh || existing?.frühAbsence);

      rows.push({ rawName: entry.rawName, employee, date: entry.date, code: entry.code, mapped, hours, hasConflict });
    }

    return rows.sort((a, b) => a.date.localeCompare(b.date) || a.employee.name.localeCompare(b.employee.name));
  };

  const previewRows = step === 'preview' ? buildPreview() : [];
  const conflictRows = previewRows.filter(r => r.hasConflict);

  // ── Final Import ───────────────────────────────────────────────────────────

  const handleImport = () => {
    const delta: Record<string, DaySchedule> = {};

    for (const row of previewRows) {
      const cellKey = `${row.employee.id}-${row.date}`;
      if (row.mapped.type === 'work' && row.mapped.start && row.mapped.end) {
        delta[cellKey] = { früh: { start: row.mapped.start, end: row.mapped.end } };
      } else if (row.mapped.type === 'vacation' || row.mapped.type === 'absence') {
        delta[cellKey] = { früh: null, frühAbsence: row.code };
      }
    }

    onImport(delta, previewRows.length);
    handleClose();
  };

  // ── Dialog close / reset ───────────────────────────────────────────────────

  const handleClose = () => {
    setStep('upload');
    setParsed(null);
    setNameMatches([]);
    setShowLogs(false);
    onClose();
  };

  const handleReset = () => {
    setStep('upload');
    setParsed(null);
    setNameMatches([]);
    setShowLogs(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4 text-orange-500" />
            Küchenplan PDF-Import
          </DialogTitle>
          {/* Step indicator */}
          <div className="flex items-center gap-1 mt-2">
            {(['upload', 'mapping', 'matching', 'preview'] as Step[]).map((s, i) => (
              <React.Fragment key={s}>
                <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium transition-colors ${
                  step === s
                    ? 'bg-orange-500 text-white'
                    : i < (['upload','mapping','matching','preview'] as Step[]).indexOf(step)
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-muted text-muted-foreground'
                }`}>
                  {STEP_LABELS[s]}
                </span>
                {i < 3 && <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
              </React.Fragment>
            ))}
          </div>
        </DialogHeader>

        <ScrollArea className="flex-1 overflow-auto">
          <div className="px-6 py-4 space-y-4">

            {/* ── STEP 1: Upload ──────────────────────────────────────────── */}
            {step === 'upload' && (
              <div className="space-y-4">
                <div
                  className="border-2 border-dashed border-border rounded-lg p-10 text-center hover:border-orange-400 transition-colors cursor-pointer"
                  onDrop={handleDrop}
                  onDragOver={e => e.preventDefault()}
                  onClick={() => fileRef.current?.click()}
                >
                  {isLoading ? (
                    <div className="flex flex-col items-center gap-2">
                      <RefreshCw className="h-8 w-8 text-orange-500 animate-spin" />
                      <p className="text-sm font-medium">PDF wird analysiert…</p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2">
                      <Upload className="h-8 w-8 text-muted-foreground" />
                      <p className="text-sm font-medium">PDF hier ablegen oder klicken</p>
                      <p className="text-xs text-muted-foreground">
                        Küchen-Dienstplan als PDF (aus Excel exportiert)
                      </p>
                    </div>
                  )}
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={handleFileInput}
                  />
                </div>

                {parsed && (
                  <div className="space-y-3">
                    {parsed.error && (
                      <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription>{parsed.error}</AlertDescription>
                      </Alert>
                    )}
                    {!parsed.error && (
                      <Alert className="border-green-200 bg-green-50 dark:bg-green-900/20">
                        <Check className="h-4 w-4 text-green-600" />
                        <AlertDescription className="text-green-800 dark:text-green-300">
                          <strong>{parsed.entries.length}</strong> Einträge erkannt,{' '}
                          <strong>{parsed.detectedNames.length}</strong> Mitarbeitende,{' '}
                          Zeitraum: <strong>{parsed.detectedPeriod?.from ?? '?'} – {parsed.detectedPeriod?.to ?? '?'}</strong>
                        </AlertDescription>
                      </Alert>
                    )}
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setShowLogs(v => !v)}
                    >
                      {showLogs ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      Parser-Log ({parsed.logs.length} Einträge)
                    </button>
                    {showLogs && (
                      <div className="rounded bg-muted p-3 text-xs font-mono space-y-0.5 max-h-48 overflow-y-auto">
                        {parsed.logs.map((l, i) => (
                          <div key={i} className={l.startsWith('❌') ? 'text-red-500' : l.startsWith('⚠️') ? 'text-yellow-600' : ''}>{l}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── STEP 2: Code Mapping ────────────────────────────────────── */}
            {step === 'mapping' && parsed && (
              <div className="space-y-4">
                <div className="flex items-start gap-2">
                  <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
                  <p className="text-sm text-muted-foreground">
                    Definiere für jeden erkannten Schichtcode die Start- und Endzeit.
                    Das Mapping wird gespeichert und beim nächsten Import vorbelegt.
                  </p>
                </div>

                {unmappedCodes.length > 0 && (
                  <Alert className="border-yellow-200 bg-yellow-50 dark:bg-yellow-900/20">
                    <AlertTriangle className="h-4 w-4 text-yellow-600" />
                    <AlertDescription className="text-yellow-800 dark:text-yellow-300">
                      Neue Codes ohne Mapping: <strong>{unmappedCodes.join(', ')}</strong> — bitte unten definieren.
                    </AlertDescription>
                  </Alert>
                )}

                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Code</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Typ</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Start</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Ende</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground">Std.</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {codeMapping
                        .map((entry, globalIdx) => ({ entry, globalIdx }))
                        .filter(({ entry }) =>
                          parsed.detectedCodes.some(c => c.toUpperCase() === entry.code.toUpperCase())
                        )
                        .map(({ entry, globalIdx }) => (
                          <tr key={entry.code} className={`transition-colors ${
                            parsed.detectedCodes.some(c => c.toUpperCase() === entry.code.toUpperCase())
                              ? 'bg-white dark:bg-card'
                              : 'bg-muted/20'
                          }`}>
                            <td className="px-3 py-2">
                              <span className="font-mono font-bold text-sm bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300 px-1.5 py-0.5 rounded">
                                {entry.code}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <Select
                                value={entry.type}
                                onValueChange={v => updateCodeEntry(globalIdx, { type: v as any })}
                              >
                                <SelectTrigger className="h-7 text-xs w-28">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="work">Arbeit</SelectItem>
                                  <SelectItem value="vacation">Ferien</SelectItem>
                                  <SelectItem value="absence">Abwesenheit</SelectItem>
                                  <SelectItem value="off">Frei</SelectItem>
                                </SelectContent>
                              </Select>
                            </td>
                            <td className="px-3 py-2">
                              {entry.type === 'work' ? (
                                <Input
                                  className="h-7 text-xs w-20 font-mono"
                                  value={entry.start ?? ''}
                                  onChange={e => updateCodeEntry(globalIdx, { start: e.target.value })}
                                  placeholder="07:00"
                                />
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {entry.type === 'work' ? (
                                <Input
                                  className="h-7 text-xs w-20 font-mono"
                                  value={entry.end ?? ''}
                                  onChange={e => updateCodeEntry(globalIdx, { end: e.target.value })}
                                  placeholder="15:30"
                                />
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <span className={`text-xs font-semibold tabular-nums ${
                                entry.type === 'work' ? 'text-foreground' : 'text-muted-foreground'
                              }`}>
                                {entry.type === 'work' ? computeHours(entry).toFixed(1) : '0.0'}
                              </span>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex justify-end">
                  <Button variant="outline" size="sm" onClick={handleSaveMapping}>
                    <Check className="h-3 w-3 mr-1" />
                    Mapping speichern
                  </Button>
                </div>
              </div>
            )}

            {/* ── STEP 3: Employee Matching ───────────────────────────────── */}
            {step === 'matching' && (
              <div className="space-y-4">
                <div className="flex items-center gap-3 text-sm">
                  <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                    <Check className="h-3 w-3 mr-1" />
                    {matchedCount} gematcht
                  </Badge>
                  {unmatchedCount > 0 && (
                    <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      {unmatchedCount} nicht zugeordnet
                    </Badge>
                  )}
                </div>

                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Name im PDF</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Personalstamm</th>
                        <th className="px-3 py-2 text-center text-xs font-semibold text-muted-foreground">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {nameMatches.map(match => {
                        const emp = kücheEmployees.find(e => e.id === match.employeeId);
                        const isSkipped = match.employeeId === 'skip';
                        return (
                          <tr key={match.rawName} className={`${
                            isSkipped ? 'bg-orange-50/50 dark:bg-orange-900/10' : 'bg-white dark:bg-card'
                          }`}>
                            <td className="px-3 py-2">
                              <span className="font-medium text-sm">{match.rawName}</span>
                            </td>
                            <td className="px-3 py-2">
                              <Select
                                value={match.employeeId}
                                onValueChange={v => updateMatch(match.rawName, v)}
                              >
                                <SelectTrigger className="h-7 text-xs">
                                  <SelectValue placeholder="Mitarbeiter wählen…" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="skip">
                                    <span className="text-muted-foreground">— Überspringen —</span>
                                  </SelectItem>
                                  {kücheEmployees.map(e => (
                                    <SelectItem key={e.id} value={e.id}>
                                      {getEmployeeDisplayName(e)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </td>
                            <td className="px-3 py-2 text-center">
                              {isSkipped ? (
                                <X className="h-4 w-4 text-orange-400 mx-auto" />
                              ) : (
                                <Check className="h-4 w-4 text-green-500 mx-auto" />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {unmatchedCount > 0 && (
                  <Alert className="border-orange-200 bg-orange-50 dark:bg-orange-900/20">
                    <AlertTriangle className="h-4 w-4 text-orange-600" />
                    <AlertDescription className="text-orange-800 dark:text-orange-300 text-xs">
                      {unmatchedCount} Name(n) werden übersprungen und nicht importiert.
                      Bitte ggf. manuell zuordnen.
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            {/* ── STEP 4: Preview ─────────────────────────────────────────── */}
            {step === 'preview' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                    <Check className="h-3 w-3 mr-1" />
                    {previewRows.length} Einträge importierbar
                  </Badge>
                  {conflictRows.length > 0 && (
                    <Badge className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      {conflictRows.length} Konflikte (werden überschrieben)
                    </Badge>
                  )}
                </div>

                {conflictRows.length > 0 && (
                  <Alert className="border-red-200 bg-red-50 dark:bg-red-900/20">
                    <AlertTriangle className="h-4 w-4 text-red-600" />
                    <AlertDescription className="text-red-800 dark:text-red-300 text-xs">
                      <strong>{conflictRows.length} Einträge</strong> haben bereits Daten im Dienstplan.
                      Diese werden beim Import überschrieben (nur der Früh-Slot).
                    </AlertDescription>
                  </Alert>
                )}

                {previewRows.length === 0 ? (
                  <Alert>
                    <Info className="h-4 w-4" />
                    <AlertDescription>
                      Keine importierbaren Einträge. Bitte Mitarbeiter-Matching prüfen.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="px-2 py-2 text-left font-semibold text-muted-foreground">Mitarbeiter</th>
                          <th className="px-2 py-2 text-left font-semibold text-muted-foreground">Datum</th>
                          <th className="px-2 py-2 text-center font-semibold text-muted-foreground">Code</th>
                          <th className="px-2 py-2 text-center font-semibold text-muted-foreground">Typ</th>
                          <th className="px-2 py-2 text-right font-semibold text-muted-foreground">Stunden</th>
                          <th className="px-2 py-2 text-center font-semibold text-muted-foreground">Konflikt</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {previewRows.map((row, i) => (
                          <tr key={i} className={row.hasConflict ? 'bg-red-50/60 dark:bg-red-900/10' : ''}>
                            <td className="px-2 py-1.5 font-medium">
                              {getEmployeeDisplayName(row.employee)}
                            </td>
                            <td className="px-2 py-1.5 text-muted-foreground tabular-nums">
                              {format(new Date(row.date + 'T00:00:00'), 'dd.MM.yy', { locale: de })}
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <span className="font-mono font-bold bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300 px-1.5 py-0.5 rounded text-[11px]">
                                {row.code}
                              </span>
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${TYPE_COLORS[row.mapped.type]}`}>
                                {TYPE_LABELS[row.mapped.type]}
                              </span>
                            </td>
                            <td className="px-2 py-1.5 text-right font-semibold tabular-nums">
                              {row.mapped.type === 'work'
                                ? `${row.hours.toFixed(1)}h`
                                : <span className="text-muted-foreground">—</span>
                              }
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              {row.hasConflict
                                ? <AlertTriangle className="h-3.5 w-3.5 text-red-500 mx-auto" />
                                : <span className="text-muted-foreground text-[10px]">—</span>
                              }
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

          </div>
        </ScrollArea>

        {/* Footer navigation */}
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
                  const order: Step[] = ['upload', 'mapping', 'matching', 'preview'];
                  const idx = order.indexOf(step);
                  if (idx > 0) setStep(order[idx - 1]);
                }}
              >
                Zurück
              </Button>
            )}

            {step === 'upload' && parsed && !parsed.error && parsed.entries.length > 0 && (
              <Button size="sm" className="bg-orange-500 hover:bg-orange-600 text-white" onClick={() => setStep('mapping')}>
                Weiter <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            )}

            {step === 'mapping' && (
              <Button size="sm" className="bg-orange-500 hover:bg-orange-600 text-white" onClick={() => {
                handleSaveMapping();
                setStep('matching');
              }}>
                Weiter <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            )}

            {step === 'matching' && (
              <Button size="sm" className="bg-orange-500 hover:bg-orange-600 text-white" onClick={() => setStep('preview')}>
                Vorschau <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            )}

            {step === 'preview' && previewRows.length > 0 && (
              <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={handleImport}>
                <Check className="h-3.5 w-3.5 mr-1" />
                {previewRows.length} Einträge importieren
              </Button>
            )}

            <Button variant="ghost" size="sm" onClick={handleClose}>
              <X className="h-3.5 w-3.5 mr-1" />
              Schliessen
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
