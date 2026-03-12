import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Upload, FileSpreadsheet, Check, AlertCircle, TestTube2 } from 'lucide-react';
import { MirusDailyImportEntry, Employee, TimeEntry } from '@/types/personnel';
import { parseMirusDailyExcel } from '@/lib/personnel-utils';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { ImportMatchPreviewDialog, NameMatchInfo, NameMatchOverride } from '@/components/schedule-planner/ImportMatchPreviewDialog';
import { ScheduleConflictDialog, ScheduleConflict } from '@/components/schedule-planner/ScheduleConflictDialog';
import { ImportSummaryDialog, ImportSummaryData } from '@/components/schedule-planner/ImportSummaryDialog';

interface ActualHoursImportButtonProps {
  onImport: (entries: MirusDailyImportEntry[]) => void;
  employees: Employee[];
  existingTimeEntries?: TimeEntry[];
}

function findMatchingEmployee(
  importedName: string,
  existingEmployees: Employee[]
): { employee: Employee | null; matchType: 'exact' | 'firstName' | 'new' } {
  const normalizedImported = importedName.toLowerCase().trim();
  
  const exactMatch = existingEmployees.find(
    emp => emp.name.toLowerCase().trim() === normalizedImported
  );
  if (exactMatch) {
    return { employee: exactMatch, matchType: 'exact' };
  }
  
  const importedFirstName = normalizedImported.split(' ')[0];
  const firstNameMatch = existingEmployees.find(
    emp => emp.name.toLowerCase().trim().split(' ')[0] === importedFirstName
  );
  if (firstNameMatch) {
    return { employee: firstNameMatch, matchType: 'firstName' };
  }
  
  return { employee: null, matchType: 'new' };
}

export const ActualHoursImportButton = ({ onImport, employees, existingTimeEntries = [] }: ActualHoursImportButtonProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [parsedEntries, setParsedEntries] = useState<MirusDailyImportEntry[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [detectedDates, setDetectedDates] = useState<string[]>([]);
  const [showMatchDialog, setShowMatchDialog] = useState(false);
  const [nameMatches, setNameMatches] = useState<NameMatchInfo[]>([]);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [conflicts, setConflicts] = useState<ScheduleConflict[]>([]);
  const [pendingEntries, setPendingEntries] = useState<MirusDailyImportEntry[]>([]);
  const [alwaysOverwrite, setAlwaysOverwrite] = useState(() => {
    return localStorage.getItem('import-always-overwrite') === 'true';
  });
  const [showSummaryDialog, setShowSummaryDialog] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummaryData | null>(null);
  const [lastReplacedCount, setLastReplacedCount] = useState(0);
  const [lastSkippedCount, setLastSkippedCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const generateNameMatches = (entries: MirusDailyImportEntry[]): NameMatchInfo[] => {
    const uniqueNames = [...new Set(entries.map(e => e.name))];
    return uniqueNames.map(name => {
      const { employee, matchType } = findMatchingEmployee(name, employees);
      return {
        importedName: name,
        matchedEmployee: employee,
        matchType,
        isNew: matchType === 'new'
      };
    });
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Reset file input for re-upload of same file
    if (inputRef.current) {
      inputRef.current.value = '';
    }

    setIsProcessing(true);
    try {
      // Read file as ArrayBuffer first to avoid NotReadableError
      const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
        reader.readAsArrayBuffer(file);
      });

      // Create a new File object from the ArrayBuffer
      const blob = new Blob([arrayBuffer], { type: file.type });
      const newFile = new File([blob], file.name, { type: file.type });

      const result = await parseMirusDailyExcel(newFile);
      setParsedEntries(result.entries);
      setDetectedDates(result.dateRange);

      if (result.entries.length === 0) {
        toast.error('Keine Ist-Stunden gefunden. Prüfe ob die Datei das richtige Format hat (Datumsbereich "von ... bis ..." erwartet).');
      } else {
        const matches = generateNameMatches(result.entries);
        setNameMatches(matches);
        setShowMatchDialog(true);
        toast.success(`${result.entries.length} Ist-Stunden erkannt`);
      }
    } catch (error) {
      console.error('Fehler beim Parsen:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unbekannter Fehler';
      toast.error(`Fehler beim Lesen der Excel-Datei: ${errorMessage}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const loadTestFile = async () => {
    setIsProcessing(true);
    try {
      const fileName = '/test-files/Taegliche_Stunden.xls';
      const response = await fetch(fileName);
      if (!response.ok) throw new Error(`Testdatei nicht gefunden`);
      
      const blob = await response.blob();
      const file = new File([blob], 'Taegliche_Stunden.xls', { type: 'application/vnd.ms-excel' });
      
      const result = await parseMirusDailyExcel(file);
      setParsedEntries(result.entries);
      setDetectedDates(result.dateRange);

      if (result.entries.length > 0) {
        const matches = generateNameMatches(result.entries);
        setNameMatches(matches);
        setShowMatchDialog(true);
        toast.success(`${result.entries.length} Ist-Stunden aus Testdatei geladen`);
      }
    } catch (error) {
      toast.error('Fehler beim Laden der Testdatei');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleMatchConfirm = (overrides: NameMatchOverride[]) => {
    const nameToEmployeeId = new Map<string, string | 'skip'>();
    overrides.forEach(override => {
      if (override.selectedEmployeeId === 'skip') {
        nameToEmployeeId.set(override.importedName, 'skip');
      } else if (override.selectedEmployeeId === 'new') {
        nameToEmployeeId.set(override.importedName, 'new');
      } else {
        const emp = employees.find(e => e.id === override.selectedEmployeeId);
        if (emp) {
          nameToEmployeeId.set(override.importedName, emp.id);
        }
      }
    });

    const updatedEntries = parsedEntries.filter(entry => {
      const mapping = nameToEmployeeId.get(entry.name);
      return mapping !== 'skip';
    }).map(entry => {
      const mapping = nameToEmployeeId.get(entry.name);
      if (mapping && mapping !== 'new' && mapping !== 'skip') {
        const emp = employees.find(e => e.id === mapping);
        if (emp) {
          return { ...entry, name: emp.name };
        }
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

  // Check for conflicts and handle import
  const checkConflictsAndImport = (entries: MirusDailyImportEntry[]) => {
    // If always overwrite is enabled, skip conflict dialog
    if (alwaysOverwrite) {
      doImport(entries);
      return;
    }

    const foundConflicts: ScheduleConflict[] = [];
    const nonConflictingEntries: MirusDailyImportEntry[] = [];

    for (const entry of entries) {
      // Find employee ID
      const emp = employees.find(e => e.name.toLowerCase() === entry.name.toLowerCase());
      if (!emp) {
        nonConflictingEntries.push(entry);
        continue;
      }

      // Check if there's existing actual hours data for this date/employee
      const existingEntry = existingTimeEntries.find(
        te => te.employeeId === emp.id && te.date === entry.date && te.actualHours && te.actualHours > 0
      );

      if (existingEntry) {
        foundConflicts.push({
          employeeId: emp.id,
          employeeName: emp.name,
          date: entry.date,
          existing: {
            früh: existingEntry.actualStart && existingEntry.actualEnd 
              ? { start: existingEntry.actualStart, end: existingEntry.actualEnd }
              : null,
            spät: null,
            frühAbsence: null,
            spätAbsence: null,
          },
          incoming: {
            früh: { start: '—', end: `${entry.hours.toFixed(1)}h` },
            spät: null,
            frühAbsence: null,
            spätAbsence: null,
          },
          resolution: 'replace', // Default to replace (newest data)
        });
      } else {
        nonConflictingEntries.push(entry);
      }
    }

    if (foundConflicts.length > 0) {
      setConflicts(foundConflicts);
      setPendingEntries(nonConflictingEntries);
      setShowConflictDialog(true);
    } else {
      // No conflicts, import directly
      doImport(entries);
    }
  };

  const handleAlwaysOverwriteChange = (value: boolean) => {
    setAlwaysOverwrite(value);
    localStorage.setItem('import-always-overwrite', value.toString());
  };

  const doImport = (entries: MirusDailyImportEntry[], replacedCount: number = 0, skippedCount: number = 0) => {
    if (entries.length > 0) {
      onImport(entries);
      
      // Show summary if enabled
      const showSummary = localStorage.getItem('import-show-summary') !== 'false';
      if (showSummary) {
        const uniqueEmployees = new Set(entries.map(e => e.name));
        const dates = entries.map(e => e.date).sort();
        const totalHours = entries.reduce((sum, e) => sum + e.hours, 0);
        
        setImportSummary({
          type: 'actual',
          totalEntries: entries.length,
          employeeCount: uniqueEmployees.size,
          dateRange: dates.length > 0 ? { start: dates[0], end: dates[dates.length - 1] } : null,
          totalHours,
          replacedCount,
          newCount: entries.length - replacedCount,
          skippedCount
        });
        setShowSummaryDialog(true);
      } else {
        toast.success(`${entries.length} Ist-Stunden importiert`);
      }
      
      setParsedEntries([]);
      setIsOpen(false);
    }
  };

  const handleConflictConfirmUpdated = (resolvedConflicts: ScheduleConflict[]) => {
    // Get entries to replace (conflicts resolved as 'replace')
    const entriesToImport = [...pendingEntries];
    let replacedCount = 0;
    let skippedCount = 0;

    for (const conflict of resolvedConflicts) {
      if (conflict.resolution === 'replace') {
        // Find the original entry from parsedEntries
        const originalEntry = parsedEntries.find(e => {
          const emp = employees.find(emp => emp.name.toLowerCase() === e.name.toLowerCase());
          return emp?.id === conflict.employeeId && e.date === conflict.date;
        });
        if (originalEntry) {
          entriesToImport.push(originalEntry);
          replacedCount++;
        }
      } else {
        skippedCount++;
      }
    }

    doImport(entriesToImport, replacedCount, skippedCount);
    setConflicts([]);
    setPendingEntries([]);
  };

  const handleConflictCancel = () => {
    setConflicts([]);
    setPendingEntries([]);
    setShowConflictDialog(false);
  };

  const handleImport = () => {
    if (parsedEntries.length > 0) {
      checkConflictsAndImport(parsedEntries);
    }
  };

  const resetState = () => {
    setParsedEntries([]);
    setDetectedDates([]);
    setNameMatches([]);
    setShowMatchDialog(false);
    setConflicts([]);
    setPendingEntries([]);
    setShowConflictDialog(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const formatDateRange = (dates: string[]) => {
    if (dates.length === 0) return '';
    if (dates.length === 1) return format(new Date(dates[0]), 'dd.MM.yyyy', { locale: de });
    const first = format(new Date(dates[0]), 'dd.MM', { locale: de });
    const last = format(new Date(dates[dates.length - 1]), 'dd.MM.yyyy', { locale: de });
    return `${first} - ${last}`;
  };

  // Group entries by employee for summary
  const getSummary = () => {
    const byEmployee = new Map<string, { hours: number; days: Set<string> }>();
    for (const entry of parsedEntries) {
      const existing = byEmployee.get(entry.name);
      if (existing) {
        existing.hours += entry.hours;
        existing.days.add(entry.date);
      } else {
        byEmployee.set(entry.name, { hours: entry.hours, days: new Set([entry.date]) });
      }
    }
    return Array.from(byEmployee.entries()).map(([name, data]) => ({
      name,
      hours: data.hours,
      days: data.days.size
    }));
  };

  const summary = getSummary();

  return (
    <>
      <Button variant="outline" size="sm" className="gap-2 border-green-500 text-green-600 hover:bg-green-50" onClick={() => setIsOpen(true)}>
        <Upload className="h-4 w-4" />
        Ist importieren
      </Button>

      <Dialog open={isOpen} onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) resetState();
      }}>
        <DialogContent className="max-w-xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-green-600" />
              Ist-Stunden importieren
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="border-2 border-dashed border-green-500/25 rounded-lg p-6 text-center bg-green-50 dark:bg-green-950/20">
              <FileSpreadsheet className="h-10 w-10 mx-auto mb-3 text-green-600" />
              <p className="text-sm font-medium mb-2">Ist-Stunden Excel hochladen</p>
              <p className="text-xs text-muted-foreground mb-4">
                Nur Ist-Stunden werden aktualisiert. Plan-Stunden und Umsatz bleiben erhalten.
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
                {isProcessing ? 'Verarbeite...' : 'Excel auswählen'}
              </Button>

              <div className="mt-4 pt-4 border-t border-dashed border-green-500/25">
                <p className="text-xs text-muted-foreground mb-2">
                  <TestTube2 className="h-3 w-3 inline mr-1" />
                  Testdatei:
                </p>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={loadTestFile} 
                  disabled={isProcessing}
                  className="border-green-500 text-green-600 hover:bg-green-50"
                >
                  Ist-Stunden Test
                </Button>
              </div>
            </div>

            {summary.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
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

                <div className="flex items-start gap-2 p-3 bg-green-50 dark:bg-green-950/30 rounded-lg">
                  <AlertCircle className="h-4 w-4 mt-0.5 text-green-600" />
                  <p className="text-xs text-green-700 dark:text-green-400">
                    <strong>Hinweis:</strong> Nur Ist-Stunden werden importiert. Bereits vorhandene Plan-Stunden und Umsätze bleiben erhalten.
                  </p>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsOpen(false)}>Abbrechen</Button>
              <Button onClick={handleImport} disabled={parsedEntries.length === 0} className="bg-green-600 hover:bg-green-700">
                Importieren
              </Button>
            </div>
          </div>
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

      <ScheduleConflictDialog
        open={showConflictDialog}
        onOpenChange={setShowConflictDialog}
        conflicts={conflicts}
        newEntriesCount={pendingEntries.length}
        onConfirm={handleConflictConfirmUpdated}
        onCancel={handleConflictCancel}
        alwaysOverwrite={alwaysOverwrite}
        onAlwaysOverwriteChange={handleAlwaysOverwriteChange}
      />

      <ImportSummaryDialog
        open={showSummaryDialog}
        onOpenChange={setShowSummaryDialog}
        summary={importSummary}
      />
    </>
  );
};
