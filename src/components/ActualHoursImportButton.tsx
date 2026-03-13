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
  Upload, FileSpreadsheet, Check, AlertCircle, AlertTriangle, TestTube2,
  RefreshCw, GitMerge, Info,
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
  const exact = existingEmployees.find(e => e.name.toLowerCase().trim() === norm);
  if (exact) return { employee: exact, matchType: 'exact' };

  const firstName = norm.split(' ')[0];
  const firstMatch = existingEmployees.find(
    e => e.name.toLowerCase().trim().split(' ')[0] === firstName,
  );
  if (firstMatch) return { employee: firstMatch, matchType: 'firstName' };

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

    const updatedEntries = parsedEntries
      .filter(entry => nameToEmployeeId.get(entry.name) !== 'skip')
      .map(entry => {
        const mapping = nameToEmployeeId.get(entry.name);
        if (mapping && mapping !== 'new' && mapping !== 'skip') {
          const emp = employees.find(e => e.id === mapping);
          if (emp) return { ...entry, name: emp.name };
        }
        return entry;
      });

    setParsedEntries(updatedEntries);
    setShowMatchDialog(false);
    setNameMatches([]);
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
              Mirus Ist-Stunden importieren
            </DialogTitle>
          </DialogHeader>

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

            {/* ── Vorschau-Tabelle ── */}
            {summary.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                    <Check className="h-4 w-4" />
                    {summary.length} Mitarbeiter erkannt
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {detectedDates.length > 0 && formatDateRange(detectedDates)}
                  </div>
                </div>

                <div className="max-h-[200px] overflow-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted sticky top-0">
                      <tr>
                        <th className="text-left p-2">Name</th>
                        <th className="text-right p-2">Tage</th>
                        <th className="text-right p-2">Ist-Std.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.map((entry, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="p-2">{entry.name}</td>
                          <td className="p-2 text-right">{entry.days}</td>
                          <td className="p-2 text-right font-mono">{entry.hours.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Unresolved warning */}
                {unresolvedNames.length > 0 && (
                  <Alert variant="destructive" className="text-sm py-2">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      <strong>{unresolvedNames.length} Mitarbeiter nicht zugeordnet:</strong>{' '}
                      {unresolvedNames.join(', ')}
                      <br />
                      <span className="text-xs">Öffne den Name-Matching-Dialog (wird beim Upload automatisch geöffnet), um sie manuell zuzuweisen.</span>
                    </AlertDescription>
                  </Alert>
                )}

                <Alert className="text-sm py-2 border-green-200 bg-green-50">
                  <AlertCircle className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-green-700">
                    <strong>Plan-Stunden sind sicher:</strong> Egal welcher Modus – geplante Anfangs-/Endzeiten und Plan-Stunden werden nie verändert.
                  </AlertDescription>
                </Alert>

                {importMode === 'replace' && (
                  <Alert className="text-sm py-2 border-orange-200 bg-orange-50">
                    <RefreshCw className="h-4 w-4 text-orange-600" />
                    <AlertDescription className="text-orange-700">
                      <strong>Ersetzen aktiv:</strong> Alle bestehenden Mirus-Ist-Stunden für die Tage{' '}
                      {formatDateRange(detectedDates)} werden gelöscht und durch diesen Import ersetzt.
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>Abbrechen</Button>
            <Button
              onClick={handleImport}
              disabled={parsedEntries.length === 0}
              className={importMode === 'replace'
                ? 'bg-orange-600 hover:bg-orange-700'
                : 'bg-green-600 hover:bg-green-700'}
            >
              {importMode === 'replace' ? 'Ersetzen & Importieren' : 'Aktualisieren & Importieren'}
            </Button>
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
