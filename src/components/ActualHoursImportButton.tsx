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
  RefreshCw, GitMerge, ChevronRight, ArrowLeft,
} from 'lucide-react';
import { MirusDailyImportEntry, MirusImportMode, Employee, TimeEntry } from '@/types/personnel';
import { parseMirusDailyExcel } from '@/lib/personnel-utils';
import {
  loadNameMappings, saveNameMappingsBatch, lookupSavedMapping,
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

function findMatchingEmployee(
  importedName: string,
  existingEmployees: Employee[],
): { employee: Employee | null; matchType: 'exact' | 'saved' | 'firstName' | 'new' } {
  const savedId = lookupSavedMapping(importedName);
  if (savedId && savedId !== 'skip') {
    const emp = existingEmployees.find(e => e.id === savedId);
    if (emp) return { employee: emp, matchType: 'saved' };
  }
  if (savedId === 'skip') return { employee: null, matchType: 'new' };

  const norm = importedName.toLowerCase().trim();
  const importParts = norm.split(/\s+/).filter(p => p.length > 0);

  // 1) Exact match
  const exact = existingEmployees.find(e => e.name.toLowerCase().trim() === norm);
  if (exact) return { employee: exact, matchType: 'exact' };

  // 2) Reversed-order exact match — Mirus exports "Lastname Firstname",
  //    the system may store "Firstname Lastname"
  const reversed = [...importParts].reverse().join(' ');
  const reversedExact = existingEmployees.find(e => e.name.toLowerCase().trim() === reversed);
  if (reversedExact) return { employee: reversedExact, matchType: 'exact' };

  // 3) Word-level scoring: exact word match scores 2, prefix-based match (min 4 chars) scores 1
  const candParts = importParts.filter(p => p.length > 2);
  if (candParts.length > 0) {
    let bestScore = 0;
    let bestEmp: Employee | null = null;
    for (const emp of existingEmployees) {
      const empParts = emp.name.toLowerCase().trim().split(/\s+/);
      let score = 0;
      for (const ip of candParts) {
        for (const ep of empParts) {
          if (ep === ip) { score += 2; break; }
          if ((ep.startsWith(ip) && ip.length >= 4) || (ip.startsWith(ep) && ep.length >= 4)) {
            score += 1; break;
          }
        }
      }
      if (score > bestScore) { bestScore = score; bestEmp = emp; }
    }
    if (bestEmp && bestScore > 0) return { employee: bestEmp, matchType: 'firstName' };
  }

  // 4) First-word match (original fallback)
  const firstName = importParts[0] ?? '';
  const firstMatch = existingEmployees.find(
    e => e.name.toLowerCase().trim().split(/\s+/)[0] === firstName,
  );
  if (firstMatch) return { employee: firstMatch, matchType: 'firstName' };

  // 5) Last-word match — handle "Lastname Firstname" by checking the last word against any employee word
  const lastName = importParts[importParts.length - 1] ?? '';
  if (lastName.length > 2) {
    const lastMatch = existingEmployees.find(e => {
      const eParts = e.name.toLowerCase().trim().split(/\s+/);
      return eParts.some(ep => ep === lastName || ep.startsWith(lastName) || lastName.startsWith(ep));
    });
    if (lastMatch) return { employee: lastMatch, matchType: 'firstName' };
  }

  return { employee: null, matchType: 'new' };
}

// ─── Hauptkomponente ─────────────────────────────────────────────────────────

export const ActualHoursImportButton = ({
  onImport, employees, existingTimeEntries = [],
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
        setNameMatches(matches);
        setShowMatchDialog(true);
        toast.success(`${result.entries.length} Ist-Stunden-Einträge erkannt`);
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
        setNameMatches(matches);
        setShowMatchDialog(true);
        toast.success(`${result.entries.length} Ist-Stunden aus Testdatei geladen`);
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
      const matchInfo = nameMatches.find(m => m.importedName === originalName);

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
    // Gespeicherte Zuordnungen aktualisieren
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
      if (o.selectedEmployeeId === 'skip') nameToEmployeeId.set(o.importedName, 'skip');
      else if (o.selectedEmployeeId === 'new') nameToEmployeeId.set(o.importedName, 'new');
      else {
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
        if (mapping && mapping !== 'new' && mapping !== 'skip') {
          const emp = employees.find(e => e.id === mapping);
          if (emp) {
            originalToResolved.set(emp.name, entry.name);
            return { ...entry, name: emp.name };
          }
        }
        return entry;
      });

    const rows = buildPreviewRows(updatedEntries, overrides, originalToResolved);

    setParsedEntries(updatedEntries);
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
    if (parsedEntries.length === 0) return;

    onImport(parsedEntries, importMode);

    const uniqueEmployees = new Set(parsedEntries.map(e => e.name));
    const dates           = parsedEntries.map(e => e.date).sort();
    const totalHours      = parsedEntries.reduce((s, e) => s + e.hours, 0);

    setImportSummary({
      type:          'actual',
      totalEntries:  parsedEntries.length,
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
    if (inputRef.current) inputRef.current.value = '';
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
                  onClick={() => { setShowPreview(false); setParsedEntries([]); setPreviewRows([]); }}
                  className="gap-1"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Zurück
                </Button>
                <Button
                  onClick={handleImport}
                  disabled={parsedEntries.length === 0}
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
