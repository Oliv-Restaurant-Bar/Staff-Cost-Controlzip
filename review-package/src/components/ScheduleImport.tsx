import { useState, useRef } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Upload, FileSpreadsheet, Check, AlertCircle, TestTube2, DollarSign, Download } from 'lucide-react';
import { MirusDailyImportEntry, ScheduleImportEntry, RevenueImportEntry, Employee } from '@/types/personnel';
import { parseMirusDailyExcel } from '@/lib/personnel-utils';
import { parseScheduleExcel, aggregateScheduleByEmployee as aggregateFromExcel } from '@/lib/schedule-excel-parser';
import { parseRevenueExcel, RevenueEntry } from '@/lib/revenue-parser';
import { downloadScheduleTemplate } from '@/lib/schedule-template-generator';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { ImportMatchPreviewDialog, NameMatchInfo, NameMatchOverride } from '@/components/schedule-planner/ImportMatchPreviewDialog';

// Helper function for smart name matching
function findMatchingEmployee(
  importedName: string,
  existingEmployees: Employee[]
): { employee: Employee | null; matchType: 'exact' | 'firstName' | 'new' } {
  const normalizedImported = importedName.toLowerCase().trim();
  
  // Try exact match first
  const exactMatch = existingEmployees.find(
    emp => emp.name.toLowerCase().trim() === normalizedImported
  );
  if (exactMatch) {
    return { employee: exactMatch, matchType: 'exact' };
  }
  
  // Try first name match
  const importedFirstName = normalizedImported.split(' ')[0];
  const firstNameMatch = existingEmployees.find(
    emp => emp.name.toLowerCase().trim().split(' ')[0] === importedFirstName
  );
  if (firstNameMatch) {
    return { employee: firstNameMatch, matchType: 'firstName' };
  }
  
  return { employee: null, matchType: 'new' };
}

interface ScheduleImportProps {
  onImport: (data: string, type: 'mirus' | 'schedule') => void;
  onMirusImport: (entries: any[]) => void;
  onMirusDailyImport?: (entries: MirusDailyImportEntry[]) => void;
  onScheduleImport?: (entries: ScheduleImportEntry[]) => void;
  onRevenueImport?: (entries: RevenueImportEntry[]) => void;
  employees?: Employee[];
}

export const ScheduleImport = ({ onMirusDailyImport, onScheduleImport, onRevenueImport, employees = [] }: ScheduleImportProps) => {
  const { tenantId } = useTenant();
  const [isOpen, setIsOpen] = useState(false);
  const [revenueType, setRevenueType] = useState<'planned' | 'actual' | 'previousYear'>('actual');
  const [activeTab, setActiveTab] = useState<'schedule-excel' | 'mirus-daily' | 'revenue'>('schedule-excel');
  const [parsedDailyEntries, setParsedDailyEntries] = useState<MirusDailyImportEntry[]>([]);
  const [parsedScheduleEntries, setParsedScheduleEntries] = useState<ScheduleImportEntry[]>([]);
  const [parsedRevenueEntries, setParsedRevenueEntries] = useState<RevenueEntry[]>([]);
  const mirusDailyInputRef = useRef<HTMLInputElement>(null);
  const [detectedCurrency, setDetectedCurrency] = useState<'CHF' | 'EUR'>('CHF');
  const [scheduleSummary, setScheduleSummary] = useState<{ name: string; department: 'service' | 'küche'; totalHours: number; days: number }[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [detectedDepartment, setDetectedDepartment] = useState<'service' | 'küche'>('service');
  const [detectedDates, setDetectedDates] = useState<string[]>([]);
  const excelInputRef = useRef<HTMLInputElement>(null);
  const revenueExcelInputRef = useRef<HTMLInputElement>(null);
  
  // Matching dialog states
  const [showMatchDialog, setShowMatchDialog] = useState(false);
  const [matchDialogType, setMatchDialogType] = useState<'schedule' | 'mirus'>('schedule');
  const [nameMatches, setNameMatches] = useState<NameMatchInfo[]>([]);

  // Generate name matches for schedule entries
  const generateScheduleNameMatches = (entries: ScheduleImportEntry[]): NameMatchInfo[] => {
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

  // Generate name matches for mirus daily entries
  const generateMirusNameMatches = (entries: MirusDailyImportEntry[]): NameMatchInfo[] => {
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
      setParsedScheduleEntries(result.entries);
      setDetectedDepartment(result.department);
      setDetectedDates(result.weekDates);

      const summary = aggregateFromExcel(result.entries);
      setScheduleSummary(summary);

      if (result.entries.length === 0) {
        const d = result.diagnostics;
        if (d) {
          const reasons: string[] = [];
          if (!d.dateRowFound) reasons.push('keine Datumszeile erkannt');
          if (!d.headerFound) reasons.push('keine Früh/Spät-Header erkannt');
          if (d.parsedEmployees === 0) reasons.push('keine Mitarbeiternamen erkannt');
          toast.error(`Keine Schichten gefunden (${reasons.join(', ') || 'Format prüfen'})`);
        } else {
          toast.error('Keine Schichten in der Excel gefunden. Prüfen Sie das Format.');
        }
      } else {
        // Generate name matches and show dialog
        const matches = generateScheduleNameMatches(result.entries);
        setNameMatches(matches);
        setMatchDialogType('schedule');
        setShowMatchDialog(true);
        toast.success(`${result.entries.length} Schichten für ${result.employeeCount} Mitarbeiter erkannt`);
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
      if (!response.ok) {
        throw new Error(`Testdatei nicht gefunden: ${fileName}`);
      }
      
      const blob = await response.blob();
      const file = new File([blob], fileName.split('/').pop() || 'test.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      
      const result = await parseScheduleExcel(file);
      setParsedScheduleEntries(result.entries);
      setDetectedDepartment(result.department);
      setDetectedDates(result.weekDates);

      const summary = aggregateFromExcel(result.entries);
      setScheduleSummary(summary);

      if (result.entries.length === 0) {
        const d = result.diagnostics;
        if (d) {
          const reasons: string[] = [];
          if (!d.dateRowFound) reasons.push('keine Datumszeile erkannt');
          if (!d.headerFound) reasons.push('keine Früh/Spät-Header erkannt');
          if (d.parsedEmployees === 0) reasons.push('keine Mitarbeiternamen erkannt');
          toast.error(`Keine Schichten in der Testdatei gefunden (${reasons.join(', ') || 'Format prüfen'})`);
        } else {
          toast.error('Keine Schichten in der Testdatei gefunden.');
        }
      } else {
        // Generate name matches and show dialog
        const matches = generateScheduleNameMatches(result.entries);
        setNameMatches(matches);
        setMatchDialogType('schedule');
        setShowMatchDialog(true);
        toast.success(`${result.entries.length} Schichten für ${result.employeeCount} Mitarbeiter aus Testdatei geladen`);
      }
    } catch (error) {
      console.error('Fehler beim Laden der Testdatei:', error);
      toast.error('Fehler beim Laden der Testdatei: ' + (error instanceof Error ? error.message : 'Unbekannter Fehler'));
    } finally {
      setIsProcessing(false);
    }
  };

  const loadMirusDailyTestFile = async () => {
    setIsProcessing(true);
    try {
      const fileName = '/test-files/Taegliche_Stunden.xls';

      const response = await fetch(fileName);
      if (!response.ok) throw new Error(`Testdatei nicht gefunden: ${fileName}`);

      const blob = await response.blob();
      const file = new File([blob], fileName.split('/').pop() || 'test.xls', {
        type: 'application/vnd.ms-excel',
      });

      const result = await parseMirusDailyExcel(file);

      setParsedDailyEntries(result.entries);
      setDetectedDates(result.dateRange);

      if (result.failureReason) {
        console.warn('[MIRUS] import gestoppt:', result.failureReason, result.debug);
        toast.error(`Import gestoppt: ${result.failureReason}`);
      } else if (result.entries.length === 0) {
        toast.error('Keine Ist-Stunden in Test-Excel gefunden');
      } else {
        // Generate name matches and show dialog
        const matches = generateMirusNameMatches(result.entries);
        setNameMatches(matches);
        setMatchDialogType('mirus');
        setShowMatchDialog(true);
        toast.success(`${result.entries.length} Ist-Stunden aus Test-Excel erkannt`);
      }
    } catch (error) {
      console.error('Fehler beim Laden der Ist-Stunden Testdatei:', error);
      toast.error('Fehler beim Laden der Ist-Stunden Testdatei');
    } finally {
      setIsProcessing(false);
    }
  };
  
  // Handle Mirus daily file upload with matching
  const handleMirusDailyUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsProcessing(true);
    if (tenantId === 'beaulieu') {
      console.log('[BEAULIEU-TEST] mirus import target: beaulieu');
      console.log(`[BEAULIEU-TEST] mirus import – file: ${file.name}, employees available: ${employees.length}`);
    }
    try {
      const result = await parseMirusDailyExcel(file);
      setParsedDailyEntries(result.entries);
      setDetectedDates(result.dateRange);
      if (result.failureReason) {
        console.warn('[MIRUS] import gestoppt:', result.failureReason, result.debug);
        toast.error(`Import gestoppt: ${result.failureReason}`);
      } else if (result.entries.length === 0) {
        toast.error('Keine Ist-Stunden gefunden');
      } else {
        if (tenantId === 'beaulieu') {
          console.log(`[BEAULIEU-TEST] mirus import – ${result.entries.length} entries parsed`);
          const uniqueNames = [...new Set(result.entries.map(e => e.employeeName))];
          uniqueNames.forEach(name => console.log(`[BEAULIEU-TEST] mirus name to match: "${name}"`));
        }
        // Generate name matches and show dialog
        const matches = generateMirusNameMatches(result.entries);
        setNameMatches(matches);
        setMatchDialogType('mirus');
        setShowMatchDialog(true);
        toast.success(`${result.entries.length} Ist-Stunden erkannt`);
      }
    } catch (error) {
      toast.error('Fehler beim Lesen der Excel-Datei');
    } finally {
      setIsProcessing(false);
    }
  };
  
  // Handle match confirmation from dialog
  const handleMatchConfirm = (overrides: NameMatchOverride[]) => {
    // Create a mapping from imported name to selected employee ID
    const nameToEmployeeId = new Map<string, string | 'skip'>();
    overrides.forEach(override => {
      if (override.selectedEmployeeId === 'skip') {
        nameToEmployeeId.set(override.importedName, 'skip');
      } else if (override.selectedEmployeeId === 'new') {
        // For 'new', we keep the original name
        nameToEmployeeId.set(override.importedName, 'new');
      } else {
        // Find the employee and use their name
        const emp = employees.find(e => e.id === override.selectedEmployeeId);
        if (emp) {
          nameToEmployeeId.set(override.importedName, emp.id);
        }
      }
    });
    
    if (matchDialogType === 'schedule') {
      // Update schedule entries with matched employee names
      const updatedEntries = parsedScheduleEntries.filter(entry => {
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
      
      setParsedScheduleEntries(updatedEntries);
      const summary = aggregateFromExcel(updatedEntries);
      setScheduleSummary(summary);
    } else {
      // Update mirus daily entries with matched employee names
      const updatedEntries = parsedDailyEntries.filter(entry => {
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
      
      setParsedDailyEntries(updatedEntries);
    }
    
    setShowMatchDialog(false);
    setNameMatches([]);
  };
  
  const handleMatchCancel = () => {
    setShowMatchDialog(false);
    setNameMatches([]);
    // Reset parsed data
    if (matchDialogType === 'schedule') {
      setParsedScheduleEntries([]);
      setScheduleSummary([]);
    } else {
      setParsedDailyEntries([]);
    }
  };

  const handleRevenueExcelUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    try {
      const result = await parseRevenueExcel(file);
      setParsedRevenueEntries(result.entries);
      setDetectedCurrency(result.currency);
      setDetectedDates(result.dateRange);
      
      if (result.entries.length === 0) {
        toast.error('Keine Umsatzdaten in der Excel gefunden. Prüfen Sie das Format.');
      } else {
        toast.success(`${result.entries.length} Umsatzeinträge erkannt`);
      }
    } catch (error) {
      console.error('Fehler beim Parsen:', error);
      toast.error('Fehler beim Lesen der Excel-Datei');
    } finally {
      setIsProcessing(false);
    }
  };

  const loadRevenueTestFile = async () => {
    setIsProcessing(true);
    try {
      const fileName = '/test-files/Umsatzbeispiel.xlsx';

      const response = await fetch(fileName);
      if (!response.ok) throw new Error(`Testdatei nicht gefunden: ${fileName}`);

      const blob = await response.blob();
      const file = new File([blob], 'Umsatzbeispiel.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      const result = await parseRevenueExcel(file);
      setParsedRevenueEntries(result.entries);
      setDetectedCurrency(result.currency);
      setDetectedDates(result.dateRange);

      if (result.entries.length === 0) {
        toast.error('Keine Umsatzdaten in der Testdatei gefunden');
      } else {
        toast.success(`${result.entries.length} Umsatzeinträge aus Testdatei erkannt`);
      }
    } catch (error) {
      console.error('Fehler beim Laden der Umsatz-Testdatei:', error);
      toast.error('Fehler beim Laden der Umsatz-Testdatei');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleImport = () => {
    if (activeTab === 'schedule-excel') {
      if (parsedScheduleEntries.length > 0 && onScheduleImport) {
        onScheduleImport(parsedScheduleEntries);
        setParsedScheduleEntries([]);
        setScheduleSummary([]);
        setIsOpen(false);
        toast.success(`${parsedScheduleEntries.length} geplante Schichten importiert`);
      }
    } else if (activeTab === 'revenue') {
      if (parsedRevenueEntries.length > 0 && onRevenueImport) {
        onRevenueImport(parsedRevenueEntries.map(e => ({ date: e.date, revenue: e.revenue, type: revenueType })));
        setParsedRevenueEntries([]);
        setIsOpen(false);
        const typeLabel = revenueType === 'planned' ? 'Plan-' : revenueType === 'actual' ? 'Ist-' : 'Vorjahres-';
        toast.success(`${parsedRevenueEntries.length} ${typeLabel}Umsatzeinträge importiert`);
      }
    } else if (activeTab === 'mirus-daily') {
      if (parsedDailyEntries.length > 0 && onMirusDailyImport) {
        onMirusDailyImport(parsedDailyEntries);
        setParsedDailyEntries([]);
        setIsOpen(false);
        toast.success(`${parsedDailyEntries.length} Ist-Stunden importiert`);
      }
    }
  };

  const resetState = () => {
    setParsedDailyEntries([]);
    setParsedScheduleEntries([]);
    setParsedRevenueEntries([]);
    setScheduleSummary([]);
    setDetectedDates([]);
    setNameMatches([]);
    setShowMatchDialog(false);
    if (excelInputRef.current) {
      excelInputRef.current.value = '';
    }
    if (revenueExcelInputRef.current) {
      revenueExcelInputRef.current.value = '';
    }
    if (mirusDailyInputRef.current) {
      mirusDailyInputRef.current.value = '';
    }
  };

  const formatRevenue = (amount: number) => {
    return new Intl.NumberFormat('de-CH', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const getTotalRevenue = () => {
    return parsedRevenueEntries.reduce((sum, entry) => sum + entry.revenue, 0);
  };

  const formatDateRange = (dates: string[]) => {
    if (dates.length === 0) return '';
    if (dates.length === 1) return format(new Date(dates[0]), 'dd.MM.yyyy', { locale: de });
    const first = format(new Date(dates[0]), 'dd.MM', { locale: de });
    const last = format(new Date(dates[dates.length - 1]), 'dd.MM.yyyy', { locale: de });
    return `${first} - ${last}`;
  };

  const getTotalPlannedCost = () => {
    return scheduleSummary.reduce((sum, emp) => sum + emp.totalHours, 0);
  };

  return (
    <>
    <Dialog open={isOpen} onOpenChange={(open) => {
      setIsOpen(open);
      if (!open) resetState();
    }}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Upload className="h-4 w-4" />
          Daten importieren
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Daten importieren</DialogTitle>
        </DialogHeader>

        <Tabs 
          value={activeTab} 
          onValueChange={(v) => {
            setActiveTab(v as 'schedule-excel' | 'mirus-daily' | 'revenue');
            setParsedDailyEntries([]);
            setParsedScheduleEntries([]);
            setParsedRevenueEntries([]);
            setScheduleSummary([]);
          }}
          className="flex-1 overflow-hidden flex flex-col"
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="schedule-excel" className="gap-1 text-xs sm:text-sm px-1 sm:px-2">
              <FileSpreadsheet className="h-3 w-3 sm:h-4 sm:w-4" />
              <span className="hidden sm:inline">Plan-Stunden</span>
              <span className="sm:hidden">Plan</span>
            </TabsTrigger>
            <TabsTrigger value="mirus-daily" className="gap-1 text-xs sm:text-sm px-1 sm:px-2 bg-green-100 dark:bg-green-900/30">
              <Upload className="h-3 w-3 sm:h-4 sm:w-4" />
              <span className="hidden sm:inline">Ist-Stunden</span>
              <span className="sm:hidden">Ist</span>
            </TabsTrigger>
            <TabsTrigger value="revenue" className="gap-1 text-xs sm:text-sm px-1 sm:px-2">
              <DollarSign className="h-3 w-3 sm:h-4 sm:w-4" />
              <span className="hidden sm:inline">Umsatz</span>
              <span className="sm:hidden">CHF</span>
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-auto mt-4">
            {/* Schedule Excel Import Tab */}
            <TabsContent value="schedule-excel" className="space-y-4 m-0">
              <div className="space-y-4">
                <div className="border-2 border-dashed border-primary/25 rounded-lg p-6 text-center bg-primary/5">
                  <FileSpreadsheet className="h-10 w-10 mx-auto mb-3 text-primary" />
                  <p className="text-sm font-medium mb-2">
                    Arbeitsplan Excel hochladen (Service / Küche)
                  </p>
                  <p className="text-xs text-muted-foreground mb-4">
                    Unterstützt: Wochenplan mit Früh/Spät-Schichten und Zeitangaben
                  </p>
                  <input
                    ref={excelInputRef}
                    type="file"
                    accept=".xls,.xlsx"
                    onChange={handleExcelUpload}
                    className="hidden"
                    id="schedule-excel-upload"
                  />
                  <div className="flex gap-2 justify-center flex-wrap">
                    <Button 
                      onClick={() => excelInputRef.current?.click()}
                      disabled={isProcessing}
                    >
                      {isProcessing ? 'Verarbeite...' : 'Excel auswählen'}
                    </Button>
                  </div>
                  
                  {/* Template Download section */}
                  <div className="mt-4 pt-4 border-t border-dashed border-muted-foreground/25">
                    <p className="text-xs text-muted-foreground mb-2">
                      <Download className="h-3 w-3 inline mr-1" />
                      Monats-Vorlage herunterladen (mit Schicht-Dropdown):
                    </p>
                    <div className="flex gap-2 justify-center flex-wrap">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => {
                          const now = new Date();
                          downloadScheduleTemplate(employees, now.getMonth(), now.getFullYear());
                          toast.success('Vorlage für aktuellen Monat heruntergeladen');
                        }}
                        disabled={employees.length === 0}
                      >
                        <Download className="h-3 w-3 mr-1" />
                        Dieser Monat
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => {
                          const now = new Date();
                          const nextMonth = now.getMonth() === 11 ? 0 : now.getMonth() + 1;
                          const nextYear = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
                          downloadScheduleTemplate(employees, nextMonth, nextYear);
                          toast.success('Vorlage für nächsten Monat heruntergeladen');
                        }}
                        disabled={employees.length === 0}
                      >
                        <Download className="h-3 w-3 mr-1" />
                        Nächster Monat
                      </Button>
                    </div>
                    {employees.length === 0 && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Keine Mitarbeiter vorhanden für Vorlage
                      </p>
                    )}
                  </div>
                  
                  {/* Test files section */}
                  <div className="mt-4 pt-4 border-t border-dashed border-muted-foreground/25">
                    <p className="text-xs text-muted-foreground mb-2">
                      <TestTube2 className="h-3 w-3 inline mr-1" />
                      Testdateien laden:
                    </p>
                    <div className="flex gap-2 justify-center">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => loadTestFile('service')}
                        disabled={isProcessing}
                      >
                        Service Test
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => loadTestFile('küche')}
                        disabled={isProcessing}
                      >
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
                        {detectedDates.length > 0 && (
                          <span>{formatDateRange(detectedDates)}</span>
                        )}
                        {' • '}
                        <span className="capitalize">{detectedDepartment}</span>
                      </div>
                    </div>
                    
                    <div className="max-h-[200px] overflow-auto rounded-lg border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted sticky top-0">
                          <tr>
                            <th className="text-left p-2">Name</th>
                            <th className="text-left p-2">Abteilung</th>
                            <th className="text-right p-2">Tage</th>
                            <th className="text-right p-2">Geplante Std.</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scheduleSummary.map((entry, idx) => (
                            <tr key={idx} className="border-t">
                              <td className="p-2">{entry.name}</td>
                              <td className="p-2 capitalize">{entry.department}</td>
                              <td className="p-2 text-right">{entry.days}</td>
                              <td className="p-2 text-right font-mono">{entry.totalHours.toFixed(1)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-muted font-medium">
                          <tr>
                            <td className="p-2" colSpan={3}>Gesamt</td>
                            <td className="p-2 text-right font-mono">{getTotalPlannedCost().toFixed(1)} Std.</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                    
                    <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg">
                      <AlertCircle className="h-4 w-4 mt-0.5 text-blue-600" />
                      <p className="text-xs text-blue-700 dark:text-blue-400">
                        <strong>Tipp:</strong> Die geplanten Stunden werden aus den Früh- und Spätschichten berechnet. 
                        Nach dem Import erscheinen die Personalkosten in der Übersicht.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* Ist-Stunden Import Tab */}
            <TabsContent value="mirus-daily" className="space-y-4 m-0">
              <div className="space-y-4">
                <div className="border-2 border-dashed border-green-500/25 rounded-lg p-6 text-center bg-green-50 dark:bg-green-950/20">
                  <FileSpreadsheet className="h-10 w-10 mx-auto mb-3 text-green-600" />
                  <p className="text-sm font-medium mb-2">
                    Ist-Stunden Excel hochladen
                  </p>
                  <p className="text-xs text-muted-foreground mb-4">
                    Unterstützte Formate: .xls, .xlsx (Mirus "Tägliche Stunden")
                  </p>
                  <input
                    ref={mirusDailyInputRef}
                    type="file"
                    accept=".xls,.xlsx"
                    onChange={handleMirusDailyUpload}
                    className="hidden"
                  />
                  <Button 
                    onClick={() => mirusDailyInputRef.current?.click()}
                    disabled={isProcessing}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    {isProcessing ? 'Verarbeite...' : 'Excel auswählen'}
                  </Button>
                  
                  {/* Test file section */}
                  <div className="mt-4 pt-4 border-t border-dashed border-green-500/25">
                    <p className="text-xs text-muted-foreground mb-2">
                      <TestTube2 className="h-3 w-3 inline mr-1" />
                      Testdatei laden:
                    </p>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={loadMirusDailyTestFile}
                      disabled={isProcessing}
                      className="border-green-500 text-green-600 hover:bg-green-50"
                    >
                      Ist-Stunden Test
                    </Button>
                  </div>
                </div>

                {parsedDailyEntries.length > 0 && (
                  <div className="space-y-3">
                    {/* Summary by employee */}
                    {(() => {
                      const summary = parsedDailyEntries.reduce((acc, entry) => {
                        const existing = acc.find(e => e.name === entry.name);
                        if (existing) {
                          existing.totalHours += entry.hours;
                          existing.days.add(entry.date);
                        } else {
                          acc.push({
                            name: entry.name,
                            department: entry.department,
                            totalHours: entry.hours,
                            days: new Set([entry.date])
                          });
                        }
                        return acc;
                      }, [] as { name: string; department: 'service' | 'küche'; totalHours: number; days: Set<string> }[]);

                      return (
                        <div className="space-y-2">
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
                                  <th className="text-left p-2">Abteilung</th>
                                  <th className="text-right p-2">Tage</th>
                                  <th className="text-right p-2">Ist-Stunden</th>
                                </tr>
                              </thead>
                              <tbody>
                                {summary.slice(0, 30).map((s, idx) => (
                                  <tr key={idx} className="border-t">
                                    <td className="p-2">{s.name}</td>
                                    <td className="p-2 capitalize">{s.department}</td>
                                    <td className="p-2 text-right font-mono">{s.days.size}</td>
                                    <td className="p-2 text-right font-mono">{s.totalHours.toFixed(2)}</td>
                                  </tr>
                                ))}
                                {summary.length > 30 && (
                                  <tr className="border-t bg-muted/50">
                                    <td className="p-2 text-muted-foreground" colSpan={4}>
                                      ... und {summary.length - 30} weitere Mitarbeiter
                                    </td>
                                  </tr>
                                )}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Raw data preview */}
                    <div className="space-y-2">
                      <div className="text-sm font-medium text-muted-foreground">Rohdaten (Auszug)</div>
                      <div className="max-h-[200px] overflow-auto rounded-lg border">
                        <table className="w-full text-sm">
                          <thead className="bg-muted sticky top-0">
                            <tr>
                              <th className="text-left p-2">Name</th>
                              <th className="text-left p-2">Datum</th>
                              <th className="text-right p-2">Ist-Stunden</th>
                            </tr>
                          </thead>
                          <tbody>
                            {parsedDailyEntries.slice(0, 20).map((entry, idx) => (
                              <tr key={idx} className="border-t">
                                <td className="p-2">{entry.name}</td>
                                <td className="p-2">{entry.date}</td>
                                <td className="p-2 text-right font-mono">{entry.hours.toFixed(2)}</td>
                              </tr>
                            ))}
                            {parsedDailyEntries.length > 20 && (
                              <tr className="border-t bg-muted/50">
                                <td className="p-2 text-muted-foreground" colSpan={3}>
                                  ... und {parsedDailyEntries.length - 20} weitere Einträge
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* Revenue Import Tab */}
            <TabsContent value="revenue" className="space-y-4 m-0">
              <div className="space-y-4">
                {/* Revenue Type Selection */}
                <div className="flex items-center justify-center gap-4 p-3 bg-muted/50 rounded-lg">
                  <span className="text-sm font-medium">Import als:</span>
                  <div className="flex gap-2 flex-wrap justify-center">
                    <Button
                      variant={revenueType === 'planned' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setRevenueType('planned')}
                    >
                      Plan-Umsatz
                    </Button>
                    <Button
                      variant={revenueType === 'actual' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setRevenueType('actual')}
                      className={revenueType === 'actual' ? 'bg-green-600 hover:bg-green-700' : ''}
                    >
                      Ist-Umsatz
                    </Button>
                    <Button
                      variant={revenueType === 'previousYear' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setRevenueType('previousYear')}
                      className={revenueType === 'previousYear' ? 'bg-amber-600 hover:bg-amber-700' : ''}
                    >
                      Vorjahr
                    </Button>
                  </div>
                </div>

                <div className={cn(
                  "border-2 border-dashed rounded-lg p-6 text-center",
                  revenueType === 'actual' 
                    ? "border-green-500/25 bg-green-50 dark:bg-green-950/20" 
                    : revenueType === 'previousYear'
                      ? "border-amber-500/25 bg-amber-50 dark:bg-amber-950/20"
                      : "border-blue-500/25 bg-blue-50 dark:bg-blue-950/20"
                )}>
                  <DollarSign className={cn(
                    "h-10 w-10 mx-auto mb-3",
                    revenueType === 'actual' ? "text-green-600" : revenueType === 'previousYear' ? "text-amber-600" : "text-blue-600"
                  )} />
                  <p className="text-sm font-medium mb-2">
                    {revenueType === 'planned' ? 'Plan-Umsatz' : revenueType === 'actual' ? 'Ist-Umsatz' : 'Vorjahres-Umsatz'} importieren (Excel)
                  </p>
                  <p className="text-xs text-muted-foreground mb-4">
                    Unterstützt: Umsatzdateien mit Datum und Betrag (CHF/EUR)
                  </p>
                  <input
                    ref={revenueExcelInputRef}
                    type="file"
                    accept=".xls,.xlsx"
                    onChange={handleRevenueExcelUpload}
                    className="hidden"
                    id="revenue-excel-upload"
                  />
                  <Button 
                    onClick={() => revenueExcelInputRef.current?.click()}
                    disabled={isProcessing}
                    className={
                      revenueType === 'actual' 
                        ? "bg-green-600 hover:bg-green-700" 
                        : revenueType === 'previousYear'
                          ? "bg-amber-600 hover:bg-amber-700"
                          : "bg-blue-600 hover:bg-blue-700"
                    }
                  >
                    {isProcessing ? 'Verarbeite...' : 'Excel auswählen'}
                  </Button>
                  
                  {/* Test file section */}
                  <div className="mt-4 pt-4 border-t border-dashed border-muted-foreground/25">
                    <p className="text-xs text-muted-foreground mb-2">
                      <TestTube2 className="h-3 w-3 inline mr-1" />
                      Testdatei laden:
                    </p>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={loadRevenueTestFile}
                      disabled={isProcessing}
                    >
                      Umsatz Test
                    </Button>
                  </div>
                </div>

                {parsedRevenueEntries.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                        <Check className="h-4 w-4" />
                        {parsedRevenueEntries.length} Umsatzeinträge erkannt
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {detectedDates.length > 0 && (
                          <span>{formatDateRange(detectedDates)}</span>
                        )}
                        {' • '}
                        <span>{detectedCurrency}</span>
                      </div>
                    </div>
                    
                    <div className="max-h-[200px] overflow-auto rounded-lg border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted sticky top-0">
                          <tr>
                            <th className="text-left p-2">Datum</th>
                            <th className="text-right p-2">Umsatz</th>
                          </tr>
                        </thead>
                        <tbody>
                          {parsedRevenueEntries.map((entry, idx) => (
                            <tr key={idx} className="border-t">
                              <td className="p-2">{format(new Date(entry.date), 'dd.MM.yyyy', { locale: de })}</td>
                              <td className="p-2 text-right font-mono">{detectedCurrency} {formatRevenue(entry.revenue)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-muted font-medium">
                          <tr>
                            <td className="p-2">Gesamt</td>
                            <td className="p-2 text-right font-mono">{detectedCurrency} {formatRevenue(getTotalRevenue())}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                    
                    <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg">
                      <AlertCircle className="h-4 w-4 mt-0.5 text-blue-600" />
                      <p className="text-xs text-blue-700 dark:text-blue-400">
                        <strong>Tipp:</strong> Die Umsatzdaten werden für die ausgewählten Tage importiert.
                        Wählen Sie oben den richtigen Umsatztyp (Plan/Ist/Vorjahr).
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t mt-4">
            <Button variant="outline" onClick={() => setIsOpen(false)}>
              Abbrechen
            </Button>
            <Button
              onClick={handleImport}
              disabled={
                (activeTab === 'schedule-excel' && parsedScheduleEntries.length === 0) ||
                (activeTab === 'mirus-daily' && parsedDailyEntries.length === 0) ||
                (activeTab === 'revenue' && parsedRevenueEntries.length === 0)
              }
            >
              Importieren
            </Button>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
    
    {/* Name Matching Dialog */}
    <ImportMatchPreviewDialog
      open={showMatchDialog}
      onOpenChange={setShowMatchDialog}
      nameMatches={nameMatches}
      existingEmployees={employees}
      onConfirm={handleMatchConfirm}
      onCancel={handleMatchCancel}
    />
  </>
  );
};
