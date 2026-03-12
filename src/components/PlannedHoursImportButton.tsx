import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Upload, FileSpreadsheet, Check, AlertCircle, TestTube2, Download } from 'lucide-react';
import { ScheduleImportEntry, Employee, DaySchedule } from '@/types/personnel';
import { parseScheduleExcel, aggregateScheduleByEmployee } from '@/lib/schedule-excel-parser';
import { downloadScheduleTemplate } from '@/lib/schedule-template-generator';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { ImportMatchPreviewDialog, NameMatchInfo, NameMatchOverride } from '@/components/schedule-planner/ImportMatchPreviewDialog';
import { ScheduleConflictDialog, ScheduleConflict } from '@/components/schedule-planner/ScheduleConflictDialog';
import { ImportSummaryDialog, ImportSummaryData } from '@/components/schedule-planner/ImportSummaryDialog';

interface PlannedHoursImportButtonProps {
  onImport: (entries: ScheduleImportEntry[]) => void;
  employees: Employee[];
  existingScheduleData?: Record<string, DaySchedule>;
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

export const PlannedHoursImportButton = ({ onImport, employees, existingScheduleData = {} }: PlannedHoursImportButtonProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [parsedEntries, setParsedEntries] = useState<ScheduleImportEntry[]>([]);
  const [scheduleSummary, setScheduleSummary] = useState<{ name: string; department: 'service' | 'küche'; totalHours: number; days: number }[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [detectedDepartment, setDetectedDepartment] = useState<'service' | 'küche'>('service');
  const [detectedDates, setDetectedDates] = useState<string[]>([]);
  const [showMatchDialog, setShowMatchDialog] = useState(false);
  const [nameMatches, setNameMatches] = useState<NameMatchInfo[]>([]);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [conflicts, setConflicts] = useState<ScheduleConflict[]>([]);
  const [pendingEntries, setPendingEntries] = useState<ScheduleImportEntry[]>([]);
  const [alwaysOverwrite, setAlwaysOverwrite] = useState(() => {
    return localStorage.getItem('import-always-overwrite') === 'true';
  });
  const [showSummaryDialog, setShowSummaryDialog] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummaryData | null>(null);
  const excelInputRef = useRef<HTMLInputElement>(null);

  const generateNameMatches = (entries: ScheduleImportEntry[]): NameMatchInfo[] => {
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

  const handleExcelUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    try {
      const result = await parseScheduleExcel(file);
      setParsedEntries(result.entries);
      setDetectedDepartment(result.department);
      setDetectedDates(result.weekDates);

      const summary = aggregateScheduleByEmployee(result.entries);
      setScheduleSummary(summary);

      if (result.entries.length === 0) {
        toast.error('Keine Schichten in der Excel gefunden.');
      } else {
        const matches = generateNameMatches(result.entries);
        setNameMatches(matches);
        setShowMatchDialog(true);
        toast.success(`${result.entries.length} Schichten erkannt`);
      }
    } catch (error) {
      console.error('Fehler beim Parsen:', error);
      toast.error('Fehler beim Lesen der Excel-Datei');
    } finally {
      setIsProcessing(false);
    }
  };

  const loadTestFile = async (type: 'service' | 'küche') => {
    setIsProcessing(true);
    try {
      const fileName = type === 'service' 
        ? '/test-files/Arbeitsplan_Service_Januar_26.xlsx'
        : '/test-files/Arbeitsplan_Küche_Januar_26.xlsx';
      
      const response = await fetch(fileName);
      if (!response.ok) throw new Error(`Testdatei nicht gefunden: ${fileName}`);
      
      const blob = await response.blob();
      const file = new File([blob], fileName.split('/').pop() || 'test.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      
      const result = await parseScheduleExcel(file);
      setParsedEntries(result.entries);
      setDetectedDepartment(result.department);
      setDetectedDates(result.weekDates);

      const summary = aggregateScheduleByEmployee(result.entries);
      setScheduleSummary(summary);

      if (result.entries.length > 0) {
        const matches = generateNameMatches(result.entries);
        setNameMatches(matches);
        setShowMatchDialog(true);
        toast.success(`${result.entries.length} Schichten aus Testdatei geladen`);
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
    const summary = aggregateScheduleByEmployee(updatedEntries);
    setScheduleSummary(summary);
    setShowMatchDialog(false);
    setNameMatches([]);
  };

  const handleMatchCancel = () => {
    setShowMatchDialog(false);
    setNameMatches([]);
    setParsedEntries([]);
    setScheduleSummary([]);
  };

  // Check for conflicts and handle import
  const checkConflictsAndImport = (entries: ScheduleImportEntry[]) => {
    // If always overwrite is enabled, skip conflict dialog
    if (alwaysOverwrite) {
      doImport(entries);
      return;
    }

    const foundConflicts: ScheduleConflict[] = [];
    const nonConflictingEntries: ScheduleImportEntry[] = [];

    for (const entry of entries) {
      // Find employee ID
      const emp = employees.find(e => e.name.toLowerCase() === entry.name.toLowerCase());
      if (!emp) {
        nonConflictingEntries.push(entry);
        continue;
      }

      const cellKey = `${emp.id}-${entry.date}`;
      const existing = existingScheduleData[cellKey];

      // Check if there's existing data that would be overwritten
      if (existing && (existing.früh || existing.spät || existing.frühAbsence || existing.spätAbsence)) {
        // Parse incoming times
        const incomingFrüh = entry.plannedStart && entry.plannedEnd 
          ? { start: entry.plannedStart, end: entry.plannedEnd }
          : null;

        foundConflicts.push({
          employeeId: emp.id,
          employeeName: emp.name,
          date: entry.date,
          existing: {
            früh: existing.früh,
            spät: existing.spät,
            frühAbsence: existing.frühAbsence,
            spätAbsence: existing.spätAbsence,
          },
          incoming: {
            früh: incomingFrüh,
            spät: null, // Schedule import typically goes to früh
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

  const doImport = (entries: ScheduleImportEntry[], replacedCount: number = 0, skippedCount: number = 0) => {
    if (entries.length > 0) {
      onImport(entries);
      
      // Show summary if enabled
      const showSummary = localStorage.getItem('import-show-summary') !== 'false';
      if (showSummary) {
        const uniqueEmployees = new Set(entries.map(e => e.name));
        const dates = entries.map(e => e.date).sort();
        const totalHours = entries.reduce((sum, e) => sum + (e.plannedHours || 0), 0);
        
        setImportSummary({
          type: 'planned',
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
        toast.success(`${entries.length} geplante Schichten importiert`);
      }
      
      setParsedEntries([]);
      setScheduleSummary([]);
      setIsOpen(false);
    }
  };

  const handleConflictConfirm = (resolvedConflicts: ScheduleConflict[]) => {
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
    setScheduleSummary([]);
    setDetectedDates([]);
    setNameMatches([]);
    setShowMatchDialog(false);
    setConflicts([]);
    setPendingEntries([]);
    setShowConflictDialog(false);
    if (excelInputRef.current) excelInputRef.current.value = '';
  };

  const formatDateRange = (dates: string[]) => {
    if (dates.length === 0) return '';
    if (dates.length === 1) return format(new Date(dates[0]), 'dd.MM.yyyy', { locale: de });
    const first = format(new Date(dates[0]), 'dd.MM', { locale: de });
    const last = format(new Date(dates[dates.length - 1]), 'dd.MM.yyyy', { locale: de });
    return `${first} - ${last}`;
  };

  return (
    <>
      <Button variant="outline" size="sm" className="gap-2" onClick={() => setIsOpen(true)}>
        <Upload className="h-4 w-4" />
        Plan importieren
      </Button>

      <Dialog open={isOpen} onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) resetState();
      }}>
        <DialogContent className="max-w-xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-primary" />
              Plan-Stunden importieren
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="border-2 border-dashed border-primary/25 rounded-lg p-6 text-center bg-primary/5">
              <FileSpreadsheet className="h-10 w-10 mx-auto mb-3 text-primary" />
              <p className="text-sm font-medium mb-2">Arbeitsplan Excel hochladen</p>
              <p className="text-xs text-muted-foreground mb-4">
                Nur Plan-Stunden werden aktualisiert. Ist-Stunden und Umsatz bleiben erhalten.
              </p>
              <input
                ref={excelInputRef}
                type="file"
                accept=".xls,.xlsx"
                onChange={handleExcelUpload}
                className="hidden"
              />
              <Button onClick={() => excelInputRef.current?.click()} disabled={isProcessing}>
                {isProcessing ? 'Verarbeite...' : 'Excel auswählen'}
              </Button>

              <div className="mt-4 pt-4 border-t border-dashed border-muted-foreground/25">
                <p className="text-xs text-muted-foreground mb-2">
                  <Download className="h-3 w-3 inline mr-1" />
                  Vorlage herunterladen:
                </p>
                <div className="flex gap-2 justify-center flex-wrap">
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => {
                      const now = new Date();
                      downloadScheduleTemplate(employees, now.getMonth(), now.getFullYear());
                      toast.success('Vorlage heruntergeladen');
                    }}
                    disabled={employees.length === 0}
                  >
                    <Download className="h-3 w-3 mr-1" />
                    Dieser Monat
                  </Button>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-dashed border-muted-foreground/25">
                <p className="text-xs text-muted-foreground mb-2">
                  <TestTube2 className="h-3 w-3 inline mr-1" />
                  Testdateien:
                </p>
                <div className="flex gap-2 justify-center">
                  <Button variant="outline" size="sm" onClick={() => loadTestFile('service')} disabled={isProcessing}>
                    Service Test
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => loadTestFile('küche')} disabled={isProcessing}>
                    Küche Test
                  </Button>
                </div>
              </div>
            </div>

            {scheduleSummary.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                    <Check className="h-4 w-4" />
                    {scheduleSummary.length} Mitarbeiter erkannt
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {detectedDates.length > 0 && formatDateRange(detectedDates)}
                    {' • '}
                    <span className="capitalize">{detectedDepartment}</span>
                  </div>
                </div>

                <div className="max-h-[200px] overflow-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted sticky top-0">
                      <tr>
                        <th className="text-left p-2">Name</th>
                        <th className="text-right p-2">Tage</th>
                        <th className="text-right p-2">Std.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scheduleSummary.map((entry, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="p-2">{entry.name}</td>
                          <td className="p-2 text-right">{entry.days}</td>
                          <td className="p-2 text-right font-mono">{entry.totalHours.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg">
                  <AlertCircle className="h-4 w-4 mt-0.5 text-blue-600" />
                  <p className="text-xs text-blue-700 dark:text-blue-400">
                    <strong>Hinweis:</strong> Nur Plan-Stunden werden importiert. Bereits vorhandene Ist-Stunden und Umsätze bleiben erhalten.
                  </p>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsOpen(false)}>Abbrechen</Button>
              <Button onClick={handleImport} disabled={parsedEntries.length === 0}>
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
        onConfirm={handleConflictConfirm}
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
