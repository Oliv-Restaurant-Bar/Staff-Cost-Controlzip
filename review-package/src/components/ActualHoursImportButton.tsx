/**
 * ActualHoursImportButton
 * ========================
 * Importiert Ist-Stunden aus einem Mirus XLS-Export.
 *
 * Features:
 * - Import-Modus: «Ersetzen» (replace) oder «Aktualisieren» (update)
 * - Gespeicherte Namenszuordnungen (persistent über Importe hinweg)
 * - Duplikatschutz: Schlüssel = Mitarbeiter-ID + Datum + importSource='mirus'
 * - Vorschau-Tabelle mit gematchten / ungematchten Mitarbeitern
 * - Plan-Stunden bleiben in jedem Modus unberührt
 */

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Upload, FileSpreadsheet, Check, AlertCircle, AlertTriangle, TestTube2,
  RefreshCw, GitMerge, ChevronRight, ArrowLeft, Trash2, ChevronDown, ChevronUp as ChevUp,
} from 'lucide-react';
import { MirusDailyImportEntry, MirusImportMode, Employee, TimeEntry, Department } from '@/types/personnel';
import { parseMirusDailyExcel } from '@/lib/personnel-utils';
import {
  loadNameMappings, saveNameMappingsBatch, lookupSavedMapping, matchEmployeeByName,
} from '@/lib/mirus-name-mapping-store';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  ImportMatchPreviewDialog, NameMatchInfo, NameMatchOverride,
} from '@/components/schedule-planner/ImportMatchPreviewDialog';
import {
  ImportSummaryDialog, ImportSummaryData,
} from '@/components/schedule-planner/ImportSummaryDialog';

// ─── Props ────────────────────────────────────────────────────────────────────

interface ActualHoursImportButtonProps {
  onImport: (entries: MirusDailyImportEntry[], mode: MirusImportMode) => void;
  onCreateEmployee?: (name: string, department: Department) => Employee;
  employees: Employee[];
  existingTimeEntries?: TimeEntry[];
}

// ─── Vorschau-Zeilentyp ───────────────────────────────────────────────────────

interface PreviewRow {
  name: string;
  department: 'küche' | 'service';
  dateFirst: string;
  dateLast: string;
  totalHours: number;
  dayCount: number;
  matchStatus: 'exact' | 'saved' | 'firstName' | 'unresolved';
  matchedTo?: string;
}

// ─── Name-Matching ────────────────────────────────────────────────────────────

/** Debug-Flag: Namen die immer geloggt werden (case-insensitiv) */
const DEBUG_NAMES = ['sadete', 'momand'];

function isDebugName(name: string): boolean {
  const n = name.toLowerCase();
  return DEBUG_NAMES.some(d => n.includes(d));
}

function findMatchingEmployee(
  importedName: string,
  existingEmployees: Employee[],
): { employee: Employee | null; matchType: 'exact' | 'saved' | 'firstName' | 'new' } {
  const debug = isDebugName(importedName);
  const result = matchEmployeeByName(importedName, existingEmployees, debug);
  return { employee: result.employee, matchType: result.matchType };
}

// ─── Hauptkomponente ─────────────────────────────────────────────────────────

export const ActualHoursImportButton = ({
  onImport, onCreateEmployee, employees, existingTimeEntries = [],
}: ActualHoursImportButtonProps) => {

  const [isOpen, setIsOpen]             = useState(false);
  const [parsedEntries, setParsedEntries] = useState<MirusDailyImportEntry[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [detectedDates, setDetectedDates] = useState<string[]>([]);
  const [importMode, setImportMode]     = useState<MirusImportMode>('update');

  const [showMatchDialog, setShowMatchDialog]   = useState(false);
  const [nameMatches, setNameMatches]           = useState<NameMatchInfo[]>([]);

  const [showPreview, setShowPreview]     = useState(false);
  const [previewRows, setPreviewRows]     = useState<PreviewRow[]>([]);

  const [showSummaryDialog, setShowSummaryDialog] = useState(false);
  const [importSummary, setImportSummary]         = useState<ImportSummaryData | null>(null);

  const [editableEntries, setEditableEntries] = useState<MirusDailyImportEntry[]>([]);
  const [showDetail, setShowDetail]           = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // ── Unresolved Namen (nach Matching) ─────────────────────────────────────

  const unresolvedNames: string[] = nameMatches
    .filter(m => m.matchType === 'new' && !m.matchedEmployee)
    .map(m => m.importedName);

  // ── Name-Match-Generierung ────────────────────────────────────────────────

  function generateNameMatches(entries: MirusDailyImportEntry[]): NameMatchInfo[] {
    const uniqueNames = [...new Set(entries.map(e => e.name))];
    return uniqueNames.map(name => {
      const { employee, matchType } = findMatchingEmployee(name, employees);
      return {
        importedName:    name,
        matchedEmployee: employee,
        matchType:       matchType === 'saved' ? 'exact' : matchType,
        isNew:           matchType === 'new',
      };
    });
  }

  // ── Auto-Import wenn alle Namen bereits bekannt ───────────────────────────

  const autoApplyAndImport = (matches: NameMatchInfo[], entries: MirusDailyImportEntry[]) => {
    const overrides: NameMatchOverride[] = matches.map(m => ({
      importedName:       m.importedName,
      selectedEmployeeId: m.matchedEmployee?.id || 'skip',
    }));

    saveNameMappingsBatch(
      overrides
        .filter(o => o.selectedEmployeeId !== 'new')
        .map(o => ({ importedName: o.importedName, employeeId: o.selectedEmployeeId || 'skip' })),
    );

    const nameToId = new Map<string, string | 'skip'>();
    overrides.forEach(o => nameToId.set(o.importedName, o.selectedEmployeeId || 'skip'));

    const updatedEntries = entries
      .filter(entry => {
        const m = nameToId.get(entry.name);
        return m !== 'skip' && m !== undefined;
      })
      .map(entry => {
        const empId = nameToId.get(entry.name);
        if (empId && empId !== 'skip') {
          const emp = employees.find(e => e.id === empId);
          if (emp) return { ...entry, name: emp.name };
        }
        return entry;
      });

    // Build previewRows for the summary table
    const originalToResolved = new Map<string, string>();
    matches.forEach(m => {
      if (m.matchedEmployee) originalToResolved.set(m.matchedEmployee.name, m.importedName);
    });
    const rows = buildPreviewRows(updatedEntries, overrides, originalToResolved, matches);

    setParsedEntries(updatedEntries);
    setEditableEntries([...updatedEntries]);
    setNameMatches(matches);
    setPreviewRows(rows);
    setShowPreview(true);
  };

  // ── Datei-Upload ──────────────────────────────────────────────────────────

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (inputRef.current) inputRef.current.value = '';
    setIsProcessing(true);
    try {
      const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
        reader.readAsArrayBuffer(file);
      });
      const blob    = new Blob([arrayBuffer], { type: file.type });
      const newFile = new File([blob], file.name, { type: file.type });
      const result  = await parseMirusDailyExcel(newFile);
      setParsedEntries(result.entries);
      setDetectedDates(result.dateRange);

      if (result.entries.length === 0) {
        toast.error(
          'Keine Ist-Stunden gefunden. Prüfe ob die Datei das Mirus-Format hat (Datumsbereich "von … bis …" erwartet).',
        );
      } else {
        const matches = generateNameMatches(result.entries);
        const unresolved = matches.filter(m => m.isNew && !m.matchedEmployee);
        if (unresolved.length === 0) {
          // Alle Namen bekannt → direkt importieren ohne Dialog
          autoApplyAndImport(matches, result.entries);
        } else {
          setNameMatches(matches);
          setShowMatchDialog(true);
          toast.success(`${result.entries.length} Ist-Stunden-Einträge erkannt`);
        }
      }
    } catch (error) {
      console.error('Fehler beim Parsen:', error);
      toast.error(`Fehler beim Lesen der Excel-Datei: ${error instanceof Error ? error.message : 'Unbekannter Fehler'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // ── Test-Datei ────────────────────────────────────────────────────────────

  const loadTestFile = async () => {
    setIsProcessing(true);
    try {
      const response = await fetch('/test-files/Taegliche_Stunden.xls');
      if (!response.ok) throw new Error('Testdatei nicht gefunden');
      const blob    = await response.blob();
      const file    = new File([blob], 'Taegliche_Stunden.xls', { type: 'application/vnd.ms-excel' });
      const result  = await parseMirusDailyExcel(file);
      setParsedEntries(result.entries);
      setDetectedDates(result.dateRange);
      if (result.entries.length > 0) {
        const matches = generateNameMatches(result.entries);
        const unresolved = matches.filter(m => m.isNew && !m.matchedEmployee);
        if (unresolved.length === 0) {
          autoApplyAndImport(matches, result.entries);
        } else {
          setNameMatches(matches);
          setShowMatchDialog(true);
          toast.success(`${result.entries.length} Ist-Stunden aus Testdatei geladen`);
        }
      }
    } catch {
      toast.error('Fehler beim Laden der Testdatei');
    } finally {
      setIsProcessing(false);
    }
  };

  // ── Match-Dialog bestätigen ───────────────────────────────────────────────

  // ── Preview-Zeilen aufbauen ───────────────────────────────────────────────

  function buildPreviewRows(
    updatedEntries: MirusDailyImportEntry[],
    overrides: NameMatchOverride[],
    originalNames: Map<string, string>,
    currentMatches: NameMatchInfo[] = nameMatches,
  ): PreviewRow[] {
    const byName = new Map<string, { entries: MirusDailyImportEntry[]; override: NameMatchOverride }>();

    for (const entry of updatedEntries) {
      const existing = byName.get(entry.name);
      const override = overrides.find(o => {
        if (o.selectedEmployeeId === 'skip' || o.selectedEmployeeId === 'new') return false;
        const mapped = employees.find(e => e.id === o.selectedEmployeeId);
        return mapped?.name === entry.name || o.importedName === entry.name;
      }) ?? overrides.find(o => o.importedName === originalNames.get(entry.name));

      if (existing) {
        existing.entries.push(entry);
      } else {
        byName.set(entry.name, {
          entries:  [entry],
          override: override ?? { importedName: entry.name, selectedEmployeeId: '' },
        });
      }
    }

    const rows: PreviewRow[] = [];
    for (const [name, { entries, override }] of byName) {
      const dates     = entries.map(e => e.date).sort();
      const totalHours = entries.reduce((s, e) => s + e.hours, 0);
      const dept      = entries[0]?.department ?? 'service';
      const originalName = originalNames.get(name) ?? name;
      const matchInfo = currentMatches.find(m => m.importedName === originalName);

      let matchStatus: PreviewRow['matchStatus'] = 'unresolved';
      if (override.selectedEmployeeId === override.importedName || override.selectedEmployeeId === '') {
        matchStatus = 'exact';
      } else if (matchInfo) {
        const t = matchInfo.matchType;
        if (t === 'saved' || t === 'exact') matchStatus = 'saved';
        else if (t === 'firstName')          matchStatus = 'firstName';
        else if (t === 'new')               matchStatus = 'unresolved';
        else                                 matchStatus = 'exact';
      }

      const matchedEmp = employees.find(e => e.id === override.selectedEmployeeId);

      rows.push({
        name,
        department:  dept,
        dateFirst:   dates[0],
        dateLast:    dates[dates.length - 1],
        totalHours,
        dayCount:    dates.length,
        matchStatus,
        matchedTo:   matchedEmp?.name !== name ? matchedEmp?.name : undefined,
      });
    }

    return rows.sort((a, b) => {
      const dOrder = a.department === b.department ? 0 : a.department === 'küche' ? -1 : 1;
      if (dOrder !== 0) return dOrder;
      return a.name.localeCompare(b.name);
    });
  }

  const handleMatchConfirm = (overrides: NameMatchOverride[]) => {
    // Neu zu erstellende Mitarbeiter anlegen (falls Callback vorhanden)
    const createdEmployees = new Map<string, Employee>();
    if (onCreateEmployee) {
      for (const o of overrides) {
        if (o.selectedEmployeeId === 'new') {
          const firstEntry = parsedEntries.find(e => e.name === o.importedName);
          const dept: Department = (firstEntry?.department === 'küche' ? 'küche' : 'service') as Department;
          const newEmp = onCreateEmployee(o.importedName, dept);
          createdEmployees.set(o.importedName, newEmp);
        }
      }
    }

    // Gespeicherte Zuordnungen aktualisieren (keine 'new'-Einträge speichern)
    saveNameMappingsBatch(
      overrides
        .filter(o => o.selectedEmployeeId !== 'new')
        .map(o => ({
          importedName: o.importedName,
          employeeId:   o.selectedEmployeeId || 'skip',
        })),
    );

    const nameToEmployeeId = new Map<string, string | 'skip'>();
    overrides.forEach(o => {
      if (o.selectedEmployeeId === 'skip') {
        nameToEmployeeId.set(o.importedName, 'skip');
      } else if (o.selectedEmployeeId === 'new') {
        const created = createdEmployees.get(o.importedName);
        if (created) nameToEmployeeId.set(o.importedName, created.id);
        else nameToEmployeeId.set(o.importedName, 'skip');
      } else {
        const emp = employees.find(e => e.id === o.selectedEmployeeId);
        if (emp) nameToEmployeeId.set(o.importedName, emp.id);
      }
    });

    // originalName → resolvedName-Mapping für Preview-Rückverfolgung
    const originalToResolved = new Map<string, string>();

    const updatedEntries = parsedEntries
      .filter(entry => nameToEmployeeId.get(entry.name) !== 'skip')
      .map(entry => {
        const mapping = nameToEmployeeId.get(entry.name);
        if (mapping && mapping !== 'skip') {
          const emp = employees.find(e => e.id === mapping)
            ?? [...createdEmployees.values()].find(e => e.id === mapping);
          if (emp) {
            originalToResolved.set(emp.name, entry.name);
            return { ...entry, name: emp.name };
          }
        }
        return entry;
      });

    const rows = buildPreviewRows(updatedEntries, overrides, originalToResolved);

    setParsedEntries(updatedEntries);
    setEditableEntries([...updatedEntries]);
    setPreviewRows(rows);
    setShowMatchDialog(false);
    setNameMatches([]);
    setShowPreview(true);
  };

  const handleMatchCancel = () => {
    setShowMatchDialog(false);
    setNameMatches([]);
    setParsedEntries([]);
  };

  // ── Import ausführen ──────────────────────────────────────────────────────

  const handleImport = () => {
    const finalEntries = editableEntries.length > 0 ? editableEntries : parsedEntries;
    if (finalEntries.length === 0) return;

    onImport(finalEntries, importMode);

    const uniqueEmployees = new Set(finalEntries.map(e => e.name));
    const dates           = finalEntries.map(e => e.date).sort();
    const totalHours      = finalEntries.reduce((s, e) => s + e.hours, 0);

    setImportSummary({
      type:          'actual',
      totalEntries:  finalEntries.length,
      employeeCount: uniqueEmployees.size,
      dateRange:     dates.length > 0 ? { start: dates[0], end: dates[dates.length - 1] } : null,
      totalHours,
      replacedCount: importMode === 'replace' ? parsedEntries.length : 0,
      newCount:      importMode === 'update'  ? parsedEntries.length : 0,
      skippedCount:  0,
    });
    setShowSummaryDialog(true);
    setParsedEntries([]);
    setIsOpen(false);
  };

  // ── Reset ─────────────────────────────────────────────────────────────────

  const resetState = () => {
    setParsedEntries([]);
    setDetectedDates([]);
    setNameMatches([]);
    setShowMatchDialog(false);
    setShowPreview(false);
    setPreviewRows([]);
    setEditableEntries([]);
    setShowDetail(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  // ── Editierbare Einträge helpers ──────────────────────────────────────────

  const updateEntryHours = (idx: number, hours: number) => {
    setEditableEntries(prev => prev.map((e, i) => i === idx ? { ...e, hours } : e));
  };

  const deleteEntry = (idx: number) => {
    setEditableEntries(prev => prev.filter((_, i) => i !== idx));
  };

  const deleteAllForEmployee = (name: string) => {
    setEditableEntries(prev => prev.filter(e => e.name !== name));
  };

  const formatDateRange = (dates: string[]) => {
    if (dates.length === 0) return '';
    if (dates.length === 1) return format(new Date(dates[0]), 'dd.MM.yyyy', { locale: de });
    const first = format(new Date(dates[0]), 'dd.MM', { locale: de });
    const last  = format(new Date(dates[dates.length - 1]), 'dd.MM.yyyy', { locale: de });
    return `${first} – ${last}`;
  };

  const getSummary = () => {
    const byEmployee = new Map<string, { hours: number; days: Set<string> }>();
    for (const entry of parsedEntries) {
      const ex = byEmployee.get(entry.name);
      if (ex) { ex.hours += entry.hours; ex.days.add(entry.date); }
      else     { byEmployee.set(entry.name, { hours: entry.hours, days: new Set([entry.date]) }); }
    }
    return [...byEmployee.entries()].map(([name, d]) => ({ name, hours: d.hours, days: d.days.size }));
  };

  const summary = getSummary();

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-2 border-green-500 text-green-600 hover:bg-green-50"
        onClick={() => setIsOpen(true)}
      >
        <Upload className="h-4 w-4" />
        Ist importieren
      </Button>

      <Dialog open={isOpen} onOpenChange={open => { setIsOpen(open); if (!open) resetState(); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-green-600" />
              {showPreview ? 'Importvorschau – Bitte prüfen' : 'Mirus Ist-Stunden importieren'}
            </DialogTitle>
          </DialogHeader>

          {/* ═══════════════════════════════════════════════════════════════════
              SCHRITT 1: Upload + Modus-Auswahl (vor Matching/Preview)
          ══════════════════════════════════════════════════════════════════════ */}
          {!showPreview && (
            <div className="space-y-5">

              {/* ── Import-Modus ── */}
              <div className="rounded-lg border p-4 space-y-3">
                <p className="text-sm font-medium">Import-Modus</p>
                <RadioGroup
                  value={importMode}
                  onValueChange={v => setImportMode(v as MirusImportMode)}
                  className="space-y-2"
                >
                  {/* Replace */}
                  <div className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    importMode === 'replace'
                      ? 'bg-orange-50 border-orange-300'
                      : 'hover:bg-muted/50'
                  }`}
                    onClick={() => setImportMode('replace')}
                  >
                    <RadioGroupItem value="replace" id="mode-replace" className="mt-0.5" />
                    <div>
                      <Label htmlFor="mode-replace" className="cursor-pointer font-medium flex items-center gap-1.5">
                        <RefreshCw className="h-3.5 w-3.5 text-orange-600" />
                        Ersetzen
                      </Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Alle bestehenden Mirus-Ist-Stunden im importierten Zeitraum werden zuerst gelöscht,
                        dann werden die neuen Stunden eingetragen. Plan-Stunden bleiben immer erhalten.
                        <br />
                        <span className="text-orange-600 font-medium">Wann verwenden:</span> Neuer vollständiger Monatsexport aus Mirus liegt vor.
                      </p>
                    </div>
                  </div>

                  {/* Update */}
                  <div className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    importMode === 'update'
                      ? 'bg-green-50 border-green-300'
                      : 'hover:bg-muted/50'
                  }`}
                    onClick={() => setImportMode('update')}
                  >
                    <RadioGroupItem value="update" id="mode-update" className="mt-0.5" />
                    <div>
                      <Label htmlFor="mode-update" className="cursor-pointer font-medium flex items-center gap-1.5">
                        <GitMerge className="h-3.5 w-3.5 text-green-600" />
                        Aktualisieren
                      </Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Nur die Einträge für dieselbe Person und denselben Tag werden überschrieben.
                        Alle anderen Tage und manuell erfasste Stunden bleiben erhalten.
                        <br />
                        <span className="text-green-600 font-medium">Wann verwenden:</span> Teilperioden-Nachtrag, einzelne Korrekturen einspielen.
                      </p>
                    </div>
                  </div>
                </RadioGroup>
              </div>

              {/* ── Upload-Bereich ── */}
              <div className="border-2 border-dashed border-green-500/25 rounded-lg p-6 text-center bg-green-50 dark:bg-green-950/20">
                <FileSpreadsheet className="h-10 w-10 mx-auto mb-3 text-green-600" />
                <p className="text-sm font-medium mb-1">Mirus XLS-Datei hochladen</p>
                <p className="text-xs text-muted-foreground mb-4">
                  «Tägliche Stunden» Export aus Mirus (.xls oder .xlsx)
                </p>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xls,.xlsx"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <Button
                  onClick={() => inputRef.current?.click()}
                  disabled={isProcessing}
                  className="bg-green-600 hover:bg-green-700"
                >
                  {isProcessing ? 'Verarbeite…' : 'Excel auswählen'}
                </Button>

                <div className="mt-4 pt-4 border-t border-dashed border-green-500/25">
                  <p className="text-xs text-muted-foreground mb-2">
                    <TestTube2 className="h-3 w-3 inline mr-1" />
                    Testdatei:
                  </p>
                  <Button
                    variant="outline" size="sm"
                    onClick={loadTestFile}
                    disabled={isProcessing}
                    className="border-green-500 text-green-600 hover:bg-green-50"
                  >
                    Ist-Stunden Test
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════════════════
              SCHRITT 2: Detaillierte Vorschau nach Name-Matching
              Zeigt pro Mitarbeiter: Abteilung, Zeitraum, Std., Match-Status
          ══════════════════════════════════════════════════════════════════════ */}
          {showPreview && (
            <div className="space-y-4">

              {/* Kopfzeile mit Statistik */}
              <div className="flex items-center justify-between flex-wrap gap-2 text-sm">
                <div className="flex items-center gap-2 text-green-700 font-medium">
                  <Check className="h-4 w-4" />
                  {previewRows.length} Mitarbeiter · {parsedEntries.length} Einträge · {parsedEntries.reduce((s,e) => s + e.hours, 0).toFixed(1)} Stunden total
                </div>
                <div className="text-muted-foreground">
                  {detectedDates.length > 0 && formatDateRange(detectedDates)}
                </div>
              </div>

              {/* Detaillierte Tabelle */}
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted">
                      <TableHead className="w-[180px]">Name</TableHead>
                      <TableHead>Abteilung</TableHead>
                      <TableHead>Zeitraum</TableHead>
                      <TableHead className="text-right">Tage</TableHead>
                      <TableHead className="text-right">Stunden</TableHead>
                      <TableHead>Zuordnung</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewRows.map((row, idx) => {
                      const isUnresolved = row.matchStatus === 'unresolved';
                      return (
                        <TableRow
                          key={idx}
                          className={isUnresolved ? 'bg-red-50 dark:bg-red-950/20' : ''}
                        >
                          <TableCell className="font-medium py-2">
                            <span className={isUnresolved ? 'text-red-700' : ''}>{row.name}</span>
                          </TableCell>
                          <TableCell className="py-2">
                            <Badge
                              variant="outline"
                              className={row.department === 'küche'
                                ? 'border-orange-300 text-orange-700 bg-orange-50'
                                : 'border-blue-300 text-blue-700 bg-blue-50'}
                            >
                              {row.department === 'küche' ? 'Küche' : 'Service'}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-2 text-sm text-muted-foreground">
                            {row.dateFirst === row.dateLast
                              ? format(new Date(row.dateFirst), 'dd.MM.yyyy', { locale: de })
                              : `${format(new Date(row.dateFirst), 'dd.MM', { locale: de })} – ${format(new Date(row.dateLast), 'dd.MM.yyyy', { locale: de })}`
                            }
                          </TableCell>
                          <TableCell className="py-2 text-right font-mono text-sm">
                            {row.dayCount}
                          </TableCell>
                          <TableCell className="py-2 text-right font-mono font-medium">
                            {row.totalHours.toFixed(1)}
                          </TableCell>
                          <TableCell className="py-2">
                            {isUnresolved ? (
                              <Badge variant="destructive" className="text-xs">
                                <AlertTriangle className="h-3 w-3 mr-1" />
                                Nicht zugeordnet
                              </Badge>
                            ) : row.matchStatus === 'exact' ? (
                              <Badge className="text-xs bg-green-100 text-green-700 border-green-300 hover:bg-green-100">
                                <Check className="h-3 w-3 mr-1" />
                                Exakt
                              </Badge>
                            ) : row.matchStatus === 'saved' ? (
                              <Badge className="text-xs bg-blue-100 text-blue-700 border-blue-300 hover:bg-blue-100">
                                <Check className="h-3 w-3 mr-1" />
                                Gespeichert
                              </Badge>
                            ) : (
                              <Badge className="text-xs bg-yellow-100 text-yellow-700 border-yellow-300 hover:bg-yellow-100">
                                <AlertCircle className="h-3 w-3 mr-1" />
                                Vorname{row.matchedTo ? ` → ${row.matchedTo}` : ''}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* ── Editable per-day detail table ── */}
              <div className="rounded-lg border overflow-hidden">
                <button
                  onClick={() => setShowDetail(v => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 bg-muted/30 hover:bg-muted/50 transition-colors text-sm font-medium"
                >
                  <span className="flex items-center gap-2">
                    {showDetail
                      ? <ChevUp className="h-3.5 w-3.5 text-muted-foreground" />
                      : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                    Einträge einzeln bearbeiten
                    <span className="text-xs font-normal text-muted-foreground">
                      ({editableEntries.length} Tage · {editableEntries.reduce((s,e)=>s+e.hours,0).toFixed(1)} Std.)
                    </span>
                  </span>
                  {editableEntries.length !== parsedEntries.length && (
                    <span className="text-xs text-amber-600 font-semibold">
                      {parsedEntries.length - editableEntries.length} gelöscht
                    </span>
                  )}
                </button>

                {showDetail && (
                  <div className="max-h-72 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-muted border-b">
                        <tr className="text-muted-foreground">
                          <th className="text-left py-1.5 pl-3 pr-1 font-semibold">Mitarbeiter</th>
                          <th className="text-left py-1.5 px-1 font-semibold">Abt.</th>
                          <th className="text-left py-1.5 px-1 font-semibold">Datum</th>
                          <th className="text-right py-1.5 px-1 font-semibold">Stunden</th>
                          <th className="py-1.5 pr-2 w-8" />
                        </tr>
                      </thead>
                      <tbody>
                        {editableEntries.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-4 text-center text-muted-foreground">
                              Alle Einträge gelöscht
                            </td>
                          </tr>
                        ) : (() => {
                          const sorted = [...editableEntries]
                            .map((e, origIdx) => ({ ...e, origIdx }))
                            .sort((a, b) => a.name.localeCompare(b.name, 'de') || a.date.localeCompare(b.date));

                          let lastEmp = '';
                          return sorted.map(({ origIdx, ...entry }) => {
                            const empChanged = entry.name !== lastEmp;
                            lastEmp = entry.name;
                            const isKüche = entry.department === 'küche';
                            return (
                              <tr key={origIdx} className="border-b last:border-0 hover:bg-muted/30">
                                <td className="py-1 pl-3 pr-1 font-medium whitespace-nowrap">
                                  {empChanged ? (
                                    <span className="flex items-center gap-1">
                                      {entry.name}
                                      <button
                                        onClick={() => deleteAllForEmployee(entry.name)}
                                        title={`Alle Einträge von ${entry.name} löschen`}
                                        className="text-muted-foreground hover:text-red-500 transition-colors ml-0.5"
                                      >
                                        <Trash2 className="h-2.5 w-2.5" />
                                      </button>
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground text-[10px] pl-1">↳</span>
                                  )}
                                </td>
                                <td className="py-1 px-1">
                                  <span className={`text-[10px] px-1 py-0.5 rounded-full font-semibold ${
                                    isKüche
                                      ? 'bg-orange-100 text-orange-700'
                                      : 'bg-blue-100 text-blue-700'
                                  }`}>
                                    {isKüche ? 'K' : 'S'}
                                  </span>
                                </td>
                                <td className="py-1 px-1 text-muted-foreground whitespace-nowrap">
                                  {format(new Date(entry.date), 'EE dd.MM.', { locale: de })}
                                </td>
                                <td className="py-1 px-1 text-right">
                                  <input
                                    type="number"
                                    min={0}
                                    max={24}
                                    step={0.25}
                                    value={entry.hours}
                                    onChange={e => {
                                      const v = parseFloat(e.target.value);
                                      if (!isNaN(v) && v >= 0) updateEntryHours(origIdx, v);
                                    }}
                                    className="w-14 text-right tabular-nums border border-border rounded px-1 py-0.5 text-xs bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                                  />
                                </td>
                                <td className="py-1 pr-2 text-center">
                                  <button
                                    onClick={() => deleteEntry(origIdx)}
                                    title="Diesen Tag löschen"
                                    className="text-muted-foreground hover:text-red-500 transition-colors"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </td>
                              </tr>
                            );
                          });
                        })()}
                      </tbody>
                    </table>
                    {editableEntries.length !== parsedEntries.length && (
                      <div className="border-t px-3 py-1.5 flex justify-end">
                        <button
                          onClick={() => setEditableEntries([...parsedEntries])}
                          className="text-[10px] text-primary hover:underline"
                        >
                          Alle Löschungen zurücksetzen
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Legende */}
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                  Exakt: Name stimmt überein
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
                  Gespeichert: früher manuell zugeordnet
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-yellow-500 inline-block" />
                  Vorname: nur Vornamen-Match
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
                  Nicht zugeordnet: wird nicht importiert
                </span>
              </div>

              {/* Hinweis nicht zugeordnete */}
              {previewRows.some(r => r.matchStatus === 'unresolved') && (
                <Alert variant="destructive" className="text-sm py-2">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <strong>{previewRows.filter(r => r.matchStatus === 'unresolved').length} Mitarbeiter werden nicht importiert</strong> (rot markiert),
                    da keine Zuordnung vorhanden ist. Stunden dieser Personen werden übersprungen.
                  </AlertDescription>
                </Alert>
              )}

              {/* Plan-Stunden sicher */}
              <Alert className="text-sm py-2 border-green-200 bg-green-50">
                <AlertCircle className="h-4 w-4 text-green-600" />
                <AlertDescription className="text-green-700">
                  <strong>Plan-Stunden sind sicher:</strong> Geplante Zeiten und Plan-Stunden werden nie verändert.
                </AlertDescription>
              </Alert>

              {/* Ersetzen-Warnung */}
              {importMode === 'replace' && (
                <Alert className="text-sm py-2 border-orange-200 bg-orange-50">
                  <RefreshCw className="h-4 w-4 text-orange-600" />
                  <AlertDescription className="text-orange-700">
                    <strong>Ersetzen aktiv:</strong> Alle bestehenden Mirus-Ist-Stunden für{' '}
                    {formatDateRange(detectedDates)} werden gelöscht und durch diesen Import ersetzt.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          <DialogFooter>
            {showPreview ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => { setShowPreview(false); setParsedEntries([]); setPreviewRows([]); setEditableEntries([]); setShowDetail(false); }}
                  className="gap-1"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Zurück
                </Button>
                <Button
                  onClick={handleImport}
                  disabled={editableEntries.length === 0}
                  className={importMode === 'replace'
                    ? 'bg-orange-600 hover:bg-orange-700 gap-1'
                    : 'bg-green-600 hover:bg-green-700 gap-1'}
                >
                  <ChevronRight className="h-4 w-4" />
                  {importMode === 'replace' ? 'Ersetzen & Importieren' : 'Aktualisieren & Importieren'}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setIsOpen(false)}>Abbrechen</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportMatchPreviewDialog
        open={showMatchDialog}
        onOpenChange={setShowMatchDialog}
        onConfirm={handleMatchConfirm}
        onCancel={handleMatchCancel}
        nameMatches={nameMatches}
        existingEmployees={employees}
      />

      <ImportSummaryDialog
        open={showSummaryDialog}
        onOpenChange={setShowSummaryDialog}
        summary={importSummary}
      />
    </>
  );
};
