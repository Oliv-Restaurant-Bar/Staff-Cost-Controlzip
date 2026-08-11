/**
 * StundenimportPage — Mirus Stunden-Import in actual_hours
 * =========================================================
 * Wiederverwendet:
 *  - parseMirusExcel()        → xlsx/xls Parser aus mirus-excel-parser.ts
 *  - saveActualHourEntry()    → UPSERT in actual_hours (Duplikatschutz)
 *  - matchEmployeeByName()    → Name-Matching mit persistenten Mappings
 *  - saveNameMappingsBatch()  → speichert manuelle Zuordnungen
 *  - loadEmployees()          → Mitarbeiterliste aus Supabase
 */

import { useState, useRef, useCallback } from 'react';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import { useNavigate } from 'react-router-dom';
import { loadIstDayLocksForMonths } from '@/lib/ist-day-locks';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, XCircle,
  RefreshCw, ChevronRight, ArrowLeft, Users, Clock,
  Check, Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { parseMirusExcel, type ExcelEmployee, type DayRecord } from '@/lib/mirus-excel-parser';
import {
  matchEmployeeByName, saveNameMappingsBatch, loadNameMappings,
  type EmployeeMatchResult,
} from '@/lib/mirus-name-mapping-store';
import { loadEmployees, saveActualHourEntry } from '@/lib/supabase-db';
import type { Employee as PersonnelEmployee } from '@/types/personnel';
import { MONTH_NAMES_DE } from '@/lib/timesheet-store';

// ─── Typen ────────────────────────────────────────────────────────────────────

type MatchStatus = 'exact' | 'saved' | 'firstName' | 'unresolved' | 'skipped' | 'manual';

interface ImportRow {
  mirusName:   string;
  matchStatus: MatchStatus;
  employee:    PersonnelEmployee | null;
  days:        DayRecord[];
  totalHours:  number;
  dayCount:    number;
  dateFrom:    string | null;
  dateTo:      string | null;
  /** Manuell gesetzter Override (Employee-ID) */
  manualId?:   string;
}

interface ImportResult {
  inserted:    number;
  updated:     number;
  skipped:     number;
  errors:      string[];
  unmapped:    string[];
}

type Step = 'upload' | 'preview' | 'done';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null) {
  if (!iso) return '–';
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function fmtH(h: number) { return h.toFixed(1) + ' h'; }

function buildRows(
  excelEmps: ExcelEmployee[],
  allEmps: PersonnelEmployee[],
  isBeaulieu: boolean,
): ImportRow[] {
  loadNameMappings(); // sicherstellen dass Mappings geladen sind

  const tenantEmps = allEmps.filter(e =>
    isBeaulieu ? e.id.startsWith('b-') : !e.id.startsWith('b-'),
  );

  return excelEmps.map(exc => {
    const mirusName = exc.name ?? '(Kein Name)';
    const result: EmployeeMatchResult = matchEmployeeByName(mirusName, tenantEmps);

    const validDays = exc.days.filter(
      d => d.date && (d.totalHours ?? 0) > 0,
    );
    const totalHours = validDays.reduce((s, d) => s + (d.totalHours ?? 0), 0);
    const sortedDates = validDays.map(d => d.date!).sort();

    let matchStatus: MatchStatus = 'unresolved';
    if (result.employee) {
      matchStatus = result.matchType as MatchStatus;
    }

    return {
      mirusName,
      matchStatus,
      employee: result.employee,
      days: validDays,
      totalHours,
      dayCount: validDays.length,
      dateFrom: sortedDates[0] ?? null,
      dateTo:   sortedDates.at(-1) ?? null,
    };
  });
}

// ─── Match-Badge ──────────────────────────────────────────────────────────────

const MATCH_META: Record<MatchStatus, { label: string; color: string; icon: React.ReactNode }> = {
  exact:      { label: 'Exakt',     color: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/40', icon: <CheckCircle2 className="h-3 w-3" /> },
  saved:      { label: 'Gespeichert', color: 'text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-950/40',          icon: <Check className="h-3 w-3" /> },
  firstName:  { label: 'Vorname',   color: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40',        icon: <AlertTriangle className="h-3 w-3" /> },
  manual:     { label: 'Manuell',   color: 'text-purple-700 bg-purple-50 dark:text-purple-300 dark:bg-purple-950/40',    icon: <Check className="h-3 w-3" /> },
  unresolved: { label: 'Nicht zugeordnet', color: 'text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/40',        icon: <XCircle className="h-3 w-3" /> },
  skipped:    { label: 'Überspringen', color: 'text-muted-foreground bg-muted',                                          icon: <XCircle className="h-3 w-3" /> },
};

function MatchBadge({ status }: { status: MatchStatus }) {
  const m = MATCH_META[status];
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium', m.color)}>
      {m.icon}{m.label}
    </span>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function StundenimportPage() {
  const navigate = useNavigate();
  const { isAdmin, isBeaulieuManager } = usePermissions();
  const { tenantId } = useTenant();
  const isBeaulieu = tenantId === 'beaulieu';

  if (!isAdmin && !isBeaulieuManager) { navigate('/'); return null; }

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep]           = useState<Step>('upload');
  const [parsing, setParsing]     = useState(false);
  const [importing, setImporting] = useState(false);
  const [fileName, setFileName]   = useState('');
  const [rows, setRows]           = useState<ImportRow[]>([]);
  const [allEmps, setAllEmps]     = useState<PersonnelEmployee[]>([]);
  const [result, setResult]       = useState<ImportResult | null>(null);
  const [detectedMonth, setDetectedMonth] = useState<string>('');

  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  // ── Datei verarbeiten ──────────────────────────────────────────────────────

  const processFile = useCallback(async (file: File) => {
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!ext || !['xlsx', 'xls'].includes(ext)) {
      toast.error('Nur .xlsx und .xls Dateien werden unterstützt.');
      return;
    }

    setParsing(true);
    setFileName(file.name);
    try {
      const [parsed, employees] = await Promise.all([
        parseMirusExcel(file),
        loadEmployees(),
      ]);

      const emps = employees ?? [];
      setAllEmps(emps);

      if (!parsed.employees.length) {
        toast.error('Keine Mitarbeiterdaten in der Datei gefunden.');
        setParsing(false);
        return;
      }

      // Monat aus den Daten ermitteln
      const allDates = parsed.employees.flatMap(e => e.days.map(d => d.date)).filter(Boolean) as string[];
      if (allDates.length) {
        const first = allDates.sort()[0];
        const [y, m] = first.split('-').map(Number);
        setDetectedMonth(`${MONTH_NAMES_DE[m - 1]} ${y}`);
      }

      const importRows = buildRows(parsed.employees, emps, isBeaulieu);
      setRows(importRows);
      setStep('preview');
    } catch (err) {
      console.error('[STUNDENIMPORT] parse error', err);
      toast.error('Fehler beim Verarbeiten der Datei. Bitte prüfe das Format.');
    } finally {
      setParsing(false);
    }
  }, [isBeaulieu]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  // ── Manuelle Zuordnung ─────────────────────────────────────────────────────

  const setManualMatch = (rowIdx: number, employeeId: string) => {
    setRows(prev => prev.map((r, i) => {
      if (i !== rowIdx) return r;
      if (employeeId === '__skip__') {
        return { ...r, manualId: undefined, matchStatus: 'skipped', employee: null };
      }
      const emp = allEmps.find(e => e.id === employeeId) ?? null;
      return {
        ...r,
        manualId: employeeId,
        matchStatus: emp ? 'manual' : 'unresolved',
        employee: emp,
      };
    }));
  };

  // ── Import ausführen ───────────────────────────────────────────────────────

  const runImport = async () => {
    setImporting(true);
    const res: ImportResult = { inserted: 0, updated: 0, skipped: 0, errors: [], unmapped: [] };

    // Ist-Tagessperren strikt lesen (fail-closed): gesperrte Tage werden
    // NIE überschrieben; Lesefehler = Abbruch, nichts geschrieben.
    let lockedDates: Set<string>;
    try {
      const months = new Set(rows.flatMap(r => r.days.map(d => d.date?.slice(0, 7))).filter(Boolean) as string[]);
      lockedDates = await loadIstDayLocksForMonths(tenantId, months);
    } catch (e) {
      toast.error(`${e instanceof Error ? e.message : String(e)} — Import abgebrochen (nichts geschrieben).`);
      setImporting(false);
      return;
    }

    // Manuelle Mappings speichern
    const newMappings: Record<string, string> = {};
    for (const row of rows) {
      if ((row.matchStatus === 'manual' || row.matchStatus === 'skipped') && row.employee) {
        newMappings[row.mirusName] = row.employee.id;
      } else if (row.matchStatus === 'skipped' && !row.employee) {
        newMappings[row.mirusName] = 'skip';
      }
    }
    if (Object.keys(newMappings).length) saveNameMappingsBatch(newMappings);

    for (const row of rows) {
      if (!row.employee || row.matchStatus === 'skipped') {
        if (!row.employee) res.unmapped.push(row.mirusName);
        res.skipped += row.days.length;
        continue;
      }

      for (const day of row.days) {
        if (!day.date || (day.totalHours ?? 0) <= 0) { res.skipped++; continue; }
        // Gesperrter Tag: «gesperrt — nicht überschrieben», kein Fehler.
        if (lockedDates.has(day.date)) { res.skipped++; continue; }
        try {
          const start = day.shifts?.[0]?.from ?? undefined;
          const end   = day.shifts?.[0]?.to   ?? undefined;
          await saveActualHourEntry(row.employee.id, day.date, {
            hours: day.totalHours!,
            start,
            end,
          });
          res.inserted++;
        } catch (err) {
          res.errors.push(`${row.employee.name} / ${day.date}: ${String(err)}`);
        }
      }
    }

    setResult(res);
    setStep('done');
    setImporting(false);

    if (res.errors.length === 0) {
      toast.success(`Import abgeschlossen: ${res.inserted} Einträge gespeichert`);
    } else {
      toast.warning(`Import mit ${res.errors.length} Fehler(n) abgeschlossen`);
    }
  };

  // ── Statistiken ────────────────────────────────────────────────────────────

  const matched   = rows.filter(r => r.employee && r.matchStatus !== 'skipped').length;
  const uncertain = rows.filter(r => r.matchStatus === 'firstName').length;
  const unmatched = rows.filter(r => !r.employee && r.matchStatus !== 'skipped').length;
  const skipped   = rows.filter(r => r.matchStatus === 'skipped').length;
  const totalDays = rows.reduce((s, r) => s + (r.employee && r.matchStatus !== 'skipped' ? r.dayCount : 0), 0);

  const tenantEmps = allEmps.filter(e =>
    isBeaulieu ? e.id.startsWith('b-') : !e.id.startsWith('b-'),
  );

  // ── Render: Upload ─────────────────────────────────────────────────────────

  if (step === 'upload') {
    return (
      <PageShell title="Stundenimport" subtitle="Mirus-Export → actual_hours">
        <div className="max-w-xl mx-auto mt-8 space-y-6">
          <div
            onDrop={handleDrop}
            onDragOver={e => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-border rounded-xl p-10 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
          >
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFileChange} />
            {parsing ? (
              <div className="flex flex-col items-center gap-3">
                <RefreshCw className="h-10 w-10 text-primary animate-spin" />
                <p className="text-sm font-medium">Datei wird verarbeitet…</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <FileSpreadsheet className="h-12 w-12 text-muted-foreground/50" />
                <div>
                  <p className="font-semibold">Mirus-Excel hier ablegen</p>
                  <p className="text-sm text-muted-foreground mt-1">oder klicken zum Auswählen</p>
                </div>
                <p className="text-xs text-muted-foreground">Unterstützt: .xlsx, .xls</p>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Info className="h-4 w-4 text-blue-500" />
              Voraussetzungen
            </div>
            <ul className="text-xs text-muted-foreground space-y-1 ml-6 list-disc">
              <li>Mirus-Monatsblatt (Excel-Drucklayout)</li>
              <li>Die Datei muss Mitarbeiternamen und Tageszeiten enthalten</li>
              <li>Importiert wird in die <code className="bg-muted px-1 rounded">actual_hours</code>-Tabelle</li>
              <li>Bestehende Einträge (gleicher MA + Tag) werden aktualisiert</li>
            </ul>
          </div>
        </div>
      </PageShell>
    );
  }

  // ── Render: Preview ────────────────────────────────────────────────────────

  if (step === 'preview') {
    return (
      <PageShell title="Stundenimport" subtitle={detectedMonth ? `Monat: ${detectedMonth}` : fileName}>
        {/* Zusammenfassung */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {[
            { label: 'Zugeordnet',      value: matched,   color: 'text-emerald-600 dark:text-emerald-400', Icon: CheckCircle2 },
            { label: 'Unsicher',        value: uncertain, color: 'text-amber-600 dark:text-amber-400',    Icon: AlertTriangle },
            { label: 'Nicht zugeordnet', value: unmatched, color: 'text-red-600 dark:text-red-400',       Icon: XCircle },
            { label: 'Tageseinträge',   value: totalDays, color: 'text-foreground',                       Icon: Clock },
          ].map(s => (
            <div key={s.label} className="bg-card border border-border rounded-lg p-3 flex items-center gap-2">
              <s.Icon className={cn('h-4 w-4 shrink-0', s.color)} />
              <div>
                <p className="text-[11px] text-muted-foreground">{s.label}</p>
                <p className={cn('text-xl font-bold tabular-nums', s.color)}>{s.value}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Tabelle */}
        <div className="bg-card border border-border rounded-lg overflow-hidden mb-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Mirus-Name</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Zuordnung</th>
                  <th className="px-3 py-2.5 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wide">Status</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden sm:table-cell">Tage</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden sm:table-cell">Total</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden md:table-cell">Zeitraum</th>
                  <th className="px-3 py-2.5 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wide">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {rows.map((row, idx) => {
                  const expanded = expandedRows.has(idx);
                  return (
                    <>
                      <tr
                        key={idx}
                        className={cn(
                          'hover:bg-muted/30 transition-colors',
                          row.matchStatus === 'skipped' && 'opacity-50',
                        )}
                      >
                        <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{row.mirusName}</td>
                        <td className="px-3 py-2.5">
                          <select
                            value={row.employee?.id ?? (row.matchStatus === 'skipped' ? '__skip__' : '')}
                            onChange={e => setManualMatch(idx, e.target.value)}
                            className="text-xs border border-border rounded px-2 py-1 bg-background max-w-[180px] truncate"
                          >
                            <option value="">— Nicht zugeordnet —</option>
                            <option value="__skip__">↷ Überspringen</option>
                            <optgroup label="Mitarbeiter">
                              {tenantEmps.map(e => (
                                <option key={e.id} value={e.id}>{e.name}</option>
                              ))}
                            </optgroup>
                          </select>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <MatchBadge status={row.matchStatus} />
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-xs hidden sm:table-cell text-muted-foreground">
                          {row.dayCount}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-xs font-medium hidden sm:table-cell">
                          {row.totalHours > 0 ? fmtH(row.totalHours) : '–'}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell">
                          {row.dateFrom ? `${fmtDate(row.dateFrom)} – ${fmtDate(row.dateTo)}` : '–'}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <button
                            onClick={() => setExpandedRows(prev => {
                              const next = new Set(prev);
                              next.has(idx) ? next.delete(idx) : next.add(idx);
                              return next;
                            })}
                            className="text-xs text-primary hover:underline"
                          >
                            {expanded ? 'Schließen' : `${row.dayCount} Tage`}
                          </button>
                        </td>
                      </tr>

                      {/* Detail-Expansion */}
                      {expanded && (
                        <tr key={`${idx}-detail`}>
                          <td colSpan={7} className="bg-muted/20 px-4 py-3">
                            <div className="overflow-x-auto max-h-48 overflow-y-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-muted-foreground">
                                    <th className="pb-1 text-left pr-4">Datum</th>
                                    <th className="pb-1 text-left pr-4">Beginn</th>
                                    <th className="pb-1 text-left pr-4">Ende</th>
                                    <th className="pb-1 text-right">Stunden</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {row.days.map((d, di) => (
                                    <tr key={di} className="border-t border-border/30">
                                      <td className="py-0.5 pr-4 font-mono">{fmtDate(d.date)}</td>
                                      <td className="py-0.5 pr-4 text-muted-foreground">{d.shifts?.[0]?.from ?? '–'}</td>
                                      <td className="py-0.5 pr-4 text-muted-foreground">{d.shifts?.[0]?.to ?? '–'}</td>
                                      <td className="py-0.5 text-right font-medium tabular-nums">{fmtH(d.totalHours ?? 0)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {unmatched > 0 && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 p-3 mb-4 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              <strong>{unmatched}</strong> Mitarbeiter konnten nicht automatisch zugeordnet werden.
              Bitte weise sie manuell zu oder wähle „Überspringen".
            </span>
          </div>
        )}

        {/* Aktionen */}
        <div className="flex items-center gap-3 justify-end">
          <Button variant="outline" onClick={() => { setStep('upload'); setRows([]); }}>
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Zurück
          </Button>
          <Button
            onClick={runImport}
            disabled={importing || matched === 0}
            className="gap-2"
          >
            {importing
              ? <><RefreshCw className="h-4 w-4 animate-spin" />Importiere…</>
              : <><ChevronRight className="h-4 w-4" />Import starten ({matched} MA, {totalDays} Tage)</>
            }
          </Button>
        </div>
      </PageShell>
    );
  }

  // ── Render: Done ───────────────────────────────────────────────────────────

  return (
    <PageShell title="Import abgeschlossen" subtitle={detectedMonth}>
      <div className="max-w-lg mx-auto space-y-6 mt-6">
        {/* Ergebnis-Kacheln */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800 rounded-lg p-4 text-center">
            <p className="text-xs text-emerald-700 dark:text-emerald-400 mb-1">Gespeichert</p>
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">{result?.inserted ?? 0}</p>
          </div>
          <div className="bg-muted/40 border border-border rounded-lg p-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">Übersprungen</p>
            <p className="text-2xl font-bold tabular-nums">{result?.skipped ?? 0}</p>
          </div>
          <div className={cn('border rounded-lg p-4 text-center', (result?.errors.length ?? 0) > 0 ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800' : 'bg-muted/40 border-border')}>
            <p className={cn('text-xs mb-1', (result?.errors.length ?? 0) > 0 ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground')}>Fehler</p>
            <p className={cn('text-2xl font-bold tabular-nums', (result?.errors.length ?? 0) > 0 ? 'text-red-700 dark:text-red-400' : '')}>{result?.errors.length ?? 0}</p>
          </div>
        </div>

        {/* Nicht zugeordnete MA */}
        {(result?.unmapped.length ?? 0) > 0 && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 p-4">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-2 flex items-center gap-2">
              <Users className="h-4 w-4" />
              Nicht importiert (kein Match)
            </p>
            <ul className="text-xs text-amber-700 dark:text-amber-400 space-y-0.5">
              {result!.unmapped.map(n => <li key={n}>• {n}</li>)}
            </ul>
          </div>
        )}

        {/* Fehler */}
        {(result?.errors.length ?? 0) > 0 && (
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20 p-4">
            <p className="text-sm font-semibold text-red-800 dark:text-red-300 mb-2">Fehler</p>
            <ul className="text-xs text-red-700 dark:text-red-400 space-y-0.5 max-h-32 overflow-y-auto">
              {result!.errors.map((e, i) => <li key={i}>• {e}</li>)}
            </ul>
          </div>
        )}

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={() => { setStep('upload'); setRows([]); setResult(null); setFileName(''); setDetectedMonth(''); }}>
            <Upload className="h-4 w-4 mr-1.5" />
            Neuen Import starten
          </Button>
          <Button className="flex-1" onClick={() => navigate('/arbeitszeitblaetter')}>
            <CheckCircle2 className="h-4 w-4 mr-1.5" />
            Arbeitszeitblätter anzeigen
          </Button>
        </div>
      </div>
    </PageShell>
  );
}

// ─── Shell ────────────────────────────────────────────────────────────────────

function PageShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border bg-card px-4 py-3 shrink-0 flex items-center gap-2">
        <FileSpreadsheet className="h-5 w-5 text-primary shrink-0" />
        <div>
          <h1 className="text-base font-bold leading-tight">{title}</h1>
          {subtitle && <p className="text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {children}
      </div>
    </div>
  );
}
