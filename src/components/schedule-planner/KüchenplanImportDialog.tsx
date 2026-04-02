/**
 * KüchenplanImportDialog
 * ======================
 * Halbautomatischer PDF-Import für Küchen-Dienstpläne.
 * 4-stufiger Wizard: Upload → Code-Mapping → Mitarbeiter-Matching → Vorschau & Import
 *
 * Neu:
 * - Zeitraum-Picker nach dem Upload: Start-Datum wählen, Tage werden automatisch zugewiesen
 *   und Monats-Rollover (z.B. 30.03 → 31.03 → 01.04) wird erkannt.
 * - Zeiten in Schritt 2 sind editierbar.
 * - Datum pro Zeile in Schritt 4 ist inline editierbar.
 */

import React, { useState, useRef, useCallback, useMemo } from 'react';
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
  FileText, RefreshCw, ChevronDown, ChevronUp, CalendarDays,
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
  origDate: string;  // original date from parser (key for dateOverrides)
  date: string;      // resolved date (after month override + per-entry override)
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

/** Baut eine Map origDate → resolvedDate unter Berücksichtigung von Monats-Rollover. */
function buildResolvedDayMap(
  headerDays: ParsedKüchenplan['headerDays'],
  startDateStr: string,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!headerDays.length || !startDateStr) return map;

  const startDate = new Date(startDateStr + 'T00:00:00');
  if (isNaN(startDate.getTime())) return map;

  let year  = startDate.getFullYear();
  let month = startDate.getMonth(); // 0-based
  let prevDay = -1;

  for (const hd of headerDays) {
    // Monats-Rollover: Tageszahl ist kleiner als vorheriger Tag → neuer Monat
    if (prevDay >= 0 && hd.day < prevDay) {
      month++;
      if (month > 11) { month = 0; year++; }
    }
    prevDay = hd.day;

    // Sicherstellen, dass der Tag im Monat gültig ist
    const maxDay = new Date(year, month + 1, 0).getDate();
    const safeDay = Math.min(hd.day, maxDay);
    const newDate = format(new Date(year, month, safeDay), 'yyyy-MM-dd');

    if (hd.origDate) {
      map.set(hd.origDate, newDate);
    }
  }
  return map;
}

function safeFormatDate(isoDate: string, fmt: string): string {
  try {
    const d = new Date(isoDate + 'T00:00:00');
    if (isNaN(d.getTime())) return isoDate;
    return format(d, fmt, { locale: de });
  } catch {
    return isoDate;
  }
}

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

  // ── Zeitraum-Override ────────────────────────────────────────────────────
  const [startDateStr, setStartDateStr] = useState(''); // yyyy-MM-dd
  // Map von origDate → manuell korrigiertem Datum (pro Zelle in Schritt 4)
  const [dateOverrides, setDateOverrides] = useState<Map<string, string>>(new Map());

  const kücheEmployees = employees.filter(e => e.department === 'küche');

  // Neu berechnet wenn startDateStr oder headerDays sich ändern
  const resolvedDayMap = useMemo(
    () => buildResolvedDayMap(parsed?.headerDays ?? [], startDateStr),
    [parsed?.headerDays, startDateStr],
  );

  const resolveDate = useCallback((origDate: string): string => {
    return dateOverrides.get(origDate) ?? resolvedDayMap.get(origDate) ?? origDate;
  }, [dateOverrides, resolvedDayMap]);

  const setDateOverride = useCallback((origDate: string, newDate: string) => {
    setDateOverrides(prev => {
      const next = new Map(prev);
      next.set(origDate, newDate);
      return next;
    });
  }, []);

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
      setDateOverrides(new Map());

      // Start-Datum aus erkanntem Bereich initialisieren
      const initStart = result.detectedStartDate
        ?? result.detectedPeriod?.from
        ?? format(new Date(), 'yyyy-MM-dd');
      setStartDateStr(initStart);

      // Pre-build name matches
      const matches: NameMatch[] = result.detectedNames.map(rawName => {
        const { employee } = matchEmployeeByName(rawName, kücheEmployees);
        return { rawName, employeeId: employee ? employee.id : 'skip' };
      });
      setNameMatches(matches);

      // Add any new codes to the mapping
      const currentCodes = codeMapping.map(e => e.code.toUpperCase());
      const newEntries: SchichtCodeEntry[] = [];
      for (const code of result.detectedCodes) {
        if (!currentCodes.includes(code.toUpperCase())) {
          newEntries.push({ code, label: code, type: 'work', hours: 0, start: '07:00', end: '15:30' });
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

  const matchedCount   = nameMatches.filter(m => m.employeeId !== 'skip').length;
  const unmatchedCount = nameMatches.filter(m => m.employeeId === 'skip').length;

  const updateMatch = (rawName: string, employeeId: string) => {
    setNameMatches(prev => prev.map(m =>
      m.rawName === rawName ? { ...m, employeeId } : m,
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
      const resolvedDate = resolveDate(entry.date);
      const cellKey = `${employee.id}-${resolvedDate}`;
      const existing = scheduleData[cellKey];
      const hasConflict = !!(existing?.früh || existing?.frühAbsence);

      rows.push({
        rawName: entry.rawName,
        employee,
        origDate: entry.date,
        date: resolvedDate,
        code: entry.code,
        mapped,
        hours,
        hasConflict,
      });
    }

    return rows.sort((a, b) => a.date.localeCompare(b.date) || a.employee.name.localeCompare(b.employee.name));
  };

  const previewRows   = step === 'preview' ? buildPreview() : [];
  const conflictRows  = previewRows.filter(r => r.hasConflict);

  // ── Final Import ───────────────────────────────────────────────────────────

  const handleImport = () => {
    const delta: Record<string, DaySchedule> = {};

    for (const row of previewRows) {
      const cellKey = `${row.employee.id}-${row.date}`; // row.date bereits resolved
      if (row.mapped.type === 'work') {
        const ds: DaySchedule = {};
        if (row.mapped.start && row.mapped.end) {
          ds.früh = { start: row.mapped.start, end: row.mapped.end };
        }
        if (row.mapped.start2 && row.mapped.end2) {
          ds.spät = { start: row.mapped.start2, end: row.mapped.end2 };
        }
        if (ds.früh || ds.spät) delta[cellKey] = ds;
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
    setStartDateStr('');
    setDateOverrides(new Map());
    onClose();
  };

  const handleReset = () => {
    setStep('upload');
    setParsed(null);
    setNameMatches([]);
    setShowLogs(false);
    setStartDateStr('');
    setDateOverrides(new Map());
    if (fileRef.current) fileRef.current.value = '';
  };

  // Kompaktes Datumsanzeige für Zeitraum-Preview
  const resolvedFrom = parsed?.headerDays[0]
    ? resolveDate(parsed.headerDays[0].origDate)
    : null;
  const resolvedTo = parsed?.headerDays[parsed.headerDays.length - 1]
    ? resolveDate(parsed.headerDays[parsed.headerDays.length - 1].origDate)
    : null;

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

                    {/* ── Zeitraum anpassen ────────────────────────────── */}
                    {!parsed.error && parsed.headerDays.length > 0 && (
                      <div className="rounded-md border border-blue-200 bg-blue-50/60 dark:bg-blue-900/10 dark:border-blue-800 p-4 space-y-3">
                        <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-1.5">
                          <CalendarDays className="h-3.5 w-3.5" />
                          Zeitraum prüfen &amp; korrigieren
                        </p>

                        <div className="flex items-center gap-3 flex-wrap">
                          <label className="text-xs text-muted-foreground whitespace-nowrap font-medium">
                            Start-Datum:
                          </label>
                          <Input
                            type="date"
                            value={startDateStr}
                            onChange={e => {
                              setStartDateStr(e.target.value);
                              setDateOverrides(new Map()); // Manuelle Overrides bei Monatswechsel zurücksetzen
                            }}
                            className="h-7 text-xs w-36"
                          />
                          {resolvedFrom && resolvedTo && (
                            <span className="text-xs text-muted-foreground">
                              → Plan: <strong className="text-foreground">
                                {safeFormatDate(resolvedFrom, 'dd.MM.yyyy')}
                              </strong>
                              {' – '}
                              <strong className="text-foreground">
                                {safeFormatDate(resolvedTo, 'dd.MM.yyyy')}
                              </strong>
                            </span>
                          )}
                        </div>

                        {/* Kompakte Tages-Vorschau */}
                        {resolvedDayMap.size > 0 && (
                          <div className="text-[11px] text-muted-foreground leading-5">
                            <span className="font-medium text-foreground">Tage: </span>
                            {parsed.headerDays.slice(0, 7).map((hd, idx) => {
                              const resolved = resolveDate(hd.origDate);
                              const label = safeFormatDate(resolved, 'dd.MM');
                              return (
                                <span key={idx} className="inline-flex items-center mr-1.5">
                                  <span className="font-mono bg-muted rounded px-1">{hd.day}</span>
                                  <span className="mx-0.5 text-muted-foreground/50">→</span>
                                  <span>{label}</span>
                                </span>
                              );
                            })}
                            {parsed.headerDays.length > 7 && (
                              <span className="text-muted-foreground/70">
                                … bis {safeFormatDate(resolveDate(parsed.headerDays[parsed.headerDays.length - 1].origDate), 'dd.MM.yyyy')}
                              </span>
                            )}
                          </div>
                        )}

                        <p className="text-[11px] text-muted-foreground">
                          Monatswechsel wird automatisch erkannt. Einzelne Daten können in Schritt 4 (Vorschau) übersteuert werden.
                        </p>
                      </div>
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
                    Überprüfe Stunden und Zeiten für jeden Schichtcode.
                    Start/Ende bestimmt den Dienstplan-Eintrag. Änderungen werden gespeichert.
                  </p>
                </div>

                {unmappedCodes.length > 0 && (
                  <Alert className="border-yellow-200 bg-yellow-50 dark:bg-yellow-900/20">
                    <AlertTriangle className="h-4 w-4 text-yellow-600" />
                    <AlertDescription className="text-yellow-800 dark:text-yellow-300">
                      Neue Codes ohne Mapping: <strong>{unmappedCodes.join(', ')}</strong> — bitte unten als Arbeit oder Abwesenheit definieren.
                    </AlertDescription>
                  </Alert>
                )}

                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Code</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Bezeichnung</th>
                        <th className="px-3 py-2 text-center text-xs font-semibold text-muted-foreground">Planstunden</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Zeiten</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Typ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {codeMapping
                        .map((entry, globalIdx) => ({ entry, globalIdx }))
                        .filter(({ entry }) =>
                          parsed.detectedCodes.some(c => c.toUpperCase() === entry.code.toUpperCase()),
                        )
                        .map(({ entry, globalIdx }) => (
                          <tr key={entry.code} className="bg-white dark:bg-card">
                            <td className="px-3 py-2">
                              <span className="font-mono font-bold text-sm bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300 px-1.5 py-0.5 rounded">
                                {entry.code}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">
                              {entry.label}
                            </td>
                            <td className="px-3 py-2 text-center">
                              {entry.type === 'work' ? (
                                <Input
                                  className="h-7 text-xs w-16 font-mono text-center mx-auto"
                                  value={entry.hours}
                                  type="number"
                                  step="0.25"
                                  min="0"
                                  onChange={e => updateCodeEntry(globalIdx, { hours: parseFloat(e.target.value) || 0 })}
                                />
                              ) : (
                                <span className="text-xs font-semibold text-muted-foreground">0.0</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {entry.type === 'work' ? (
                                <div className="space-y-1">
                                  {/* Erste Schicht */}
                                  <div className="flex items-center gap-1">
                                    <Input
                                      type="time"
                                      value={entry.start ?? ''}
                                      onChange={e => updateCodeEntry(globalIdx, { start: e.target.value })}
                                      className="h-6 text-xs w-24 font-mono px-1"
                                    />
                                    <span className="text-[10px] text-muted-foreground">–</span>
                                    <Input
                                      type="time"
                                      value={entry.end ?? ''}
                                      onChange={e => updateCodeEntry(globalIdx, { end: e.target.value })}
                                      className="h-6 text-xs w-24 font-mono px-1"
                                    />
                                  </div>
                                  {/* Zweite Schicht (Splitschicht) */}
                                  {(entry.start2 !== undefined || entry.end2 !== undefined) && (
                                    <div className="flex items-center gap-1">
                                      <span className="text-[10px] text-muted-foreground w-3">+</span>
                                      <Input
                                        type="time"
                                        value={entry.start2 ?? ''}
                                        onChange={e => updateCodeEntry(globalIdx, { start2: e.target.value })}
                                        className="h-6 text-xs w-24 font-mono px-1"
                                      />
                                      <span className="text-[10px] text-muted-foreground">–</span>
                                      <Input
                                        type="time"
                                        value={entry.end2 ?? ''}
                                        onChange={e => updateCodeEntry(globalIdx, { end2: e.target.value })}
                                        className="h-6 text-xs w-24 font-mono px-1"
                                      />
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span className="italic text-muted-foreground text-xs">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <Select
                                value={entry.type}
                                onValueChange={v => updateCodeEntry(globalIdx, { type: v as any, hours: v === 'work' ? entry.hours : 0 })}
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
                  {dateOverrides.size > 0 && (
                    <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                      <CalendarDays className="h-3 w-3 mr-1" />
                      {dateOverrides.size} Datum-Korrekturen
                    </Badge>
                  )}
                </div>

                <Alert className="border-blue-200 bg-blue-50/60 dark:bg-blue-900/10 py-2">
                  <Info className="h-4 w-4 text-blue-500" />
                  <AlertDescription className="text-blue-800 dark:text-blue-300 text-xs">
                    Datum pro Zeile direkt editierbar — Klick auf das Datumsfeld zum Korrigieren.
                  </AlertDescription>
                </Alert>

                {conflictRows.length > 0 && (
                  <Alert className="border-red-200 bg-red-50 dark:bg-red-900/20">
                    <AlertTriangle className="h-4 w-4 text-red-600" />
                    <AlertDescription className="text-red-800 dark:text-red-300 text-xs">
                      <strong>{conflictRows.length} Einträge</strong> haben bereits Daten im Dienstplan.
                      Diese werden beim Import überschrieben.
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
                          <th className="px-2 py-2 text-left font-semibold text-muted-foreground">
                            Datum
                            <span className="ml-1 text-[10px] font-normal text-muted-foreground/70">(editierbar)</span>
                          </th>
                          <th className="px-2 py-2 text-center font-semibold text-muted-foreground">Code</th>
                          <th className="px-2 py-2 text-center font-semibold text-muted-foreground">Typ</th>
                          <th className="px-2 py-2 text-right font-semibold text-muted-foreground">Stunden</th>
                          <th className="px-2 py-2 text-center font-semibold text-muted-foreground">Konflikt</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {previewRows.map((row, i) => {
                          const isOverridden = dateOverrides.has(row.origDate);
                          return (
                            <tr key={i} className={row.hasConflict ? 'bg-red-50/60 dark:bg-red-900/10' : ''}>
                              <td className="px-2 py-1.5 font-medium">
                                {getEmployeeDisplayName(row.employee)}
                              </td>
                              <td className="px-2 py-1.5">
                                <input
                                  type="date"
                                  value={dateOverrides.get(row.origDate) ?? row.date}
                                  onChange={e => setDateOverride(row.origDate, e.target.value)}
                                  className={`border rounded text-xs px-1.5 py-0.5 h-6 w-32 tabular-nums font-mono bg-background
                                    ${isOverridden
                                      ? 'border-blue-400 text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/20'
                                      : 'border-border text-muted-foreground'
                                    }`}
                                />
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
                          );
                        })}
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
