import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Upload, FileSpreadsheet, Check, AlertTriangle, Loader2, Target, TrendingUp, DollarSign, HelpCircle } from 'lucide-react';
import { Employee, ScheduleImportEntry, MirusDailyImportEntry, RevenueImportEntry } from '@/types/personnel';
import { detectExcelType, getTypeLabel, getTypeColor, getTypeBgColor, ExcelFileType, DetectionResult } from '@/lib/excel-type-detector';
import { parseScheduleExcel, aggregateScheduleByEmployee } from '@/lib/schedule-excel-parser';
import { parseMirusDailyExcel } from '@/lib/personnel-utils';
import { parseRevenueExcel, RevenueEntry } from '@/lib/revenue-parser';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ImportMatchPreviewDialog, NameMatchInfo, NameMatchOverride } from '@/components/schedule-planner/ImportMatchPreviewDialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';

interface SmartImportButtonProps {
  onImportPlannedHours: (entries: ScheduleImportEntry[]) => void;
  onImportActualHours: (entries: MirusDailyImportEntry[]) => void;
  onImportRevenue: (entries: RevenueImportEntry[]) => void;
  employees: Employee[];
}

function findMatchingEmployee(
  importedName: string,
  existingEmployees: Employee[]
): { employee: Employee | null; matchType: 'exact' | 'firstName' | 'new' } {
  const normalizedImported = importedName.toLowerCase().trim();
  
  const exactMatch = existingEmployees.find(
    emp => emp.name.toLowerCase().trim() === normalizedImported
  );
  if (exactMatch) return { employee: exactMatch, matchType: 'exact' };
  
  const importedFirstName = normalizedImported.split(' ')[0];
  const firstNameMatch = existingEmployees.find(
    emp => emp.name.toLowerCase().trim().split(' ')[0] === importedFirstName
  );
  if (firstNameMatch) return { employee: firstNameMatch, matchType: 'firstName' };
  
  return { employee: null, matchType: 'new' };
}

export const SmartImportButton = ({ 
  onImportPlannedHours, 
  onImportActualHours, 
  onImportRevenue,
  employees 
}: SmartImportButtonProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [selectedType, setSelectedType] = useState<ExcelFileType | null>(null);
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  
  // Multi-file queue
  const [fileQueue, setFileQueue] = useState<File[]>([]);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  
  // Parsed data states
  const [parsedPlannedHours, setParsedPlannedHours] = useState<ScheduleImportEntry[]>([]);
  const [parsedActualHours, setParsedActualHours] = useState<MirusDailyImportEntry[]>([]);
  const [parsedRevenue, setParsedRevenue] = useState<RevenueEntry[]>([]);
  const [revenueType, setRevenueType] = useState<'planned' | 'actual' | 'previousYear'>('actual');
  
  // Match dialog states
  const [showMatchDialog, setShowMatchDialog] = useState(false);
  const [nameMatches, setNameMatches] = useState<NameMatchInfo[]>([]);
  const [matchDialogType, setMatchDialogType] = useState<'planned' | 'actual'>('planned');
  
  const inputRef = useRef<HTMLInputElement>(null);

  const generateNameMatches = (names: string[]): NameMatchInfo[] => {
    const uniqueNames = [...new Set(names)];
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

  const processFile = useCallback(async (file: File) => {
    if (!file.name.match(/\.(xls|xlsx)$/i)) {
      toast.error('Bitte nur Excel-Dateien (.xls, .xlsx) hochladen');
      return;
    }

    setCurrentFile(file);
    setIsDetecting(true);
    setParsedPlannedHours([]);
    setParsedActualHours([]);
    setParsedRevenue([]);

    try {
      const result = await detectExcelType(file);
      setDetection(result);
      setSelectedType(result.type !== 'unknown' ? result.type : null);
      
      if (result.confidence >= 50) {
        // Auto-parse based on detected type
        await parseFileAsType(file, result.type);
      }
    } catch (error) {
      console.error('Detection error:', error);
      toast.error('Fehler beim Analysieren der Datei');
      setDetection({ type: 'unknown', confidence: 0, reason: 'Fehler bei der Analyse' });
    } finally {
      setIsDetecting(false);
    }
  }, [employees]);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await processFile(file);
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    const excelFiles = droppedFiles.filter(f => f.name.match(/\.(xls|xlsx)$/i));
    
    if (excelFiles.length === 0) {
      toast.error('Bitte nur Excel-Dateien (.xls, .xlsx) hochladen');
      return;
    }
    
    if (droppedFiles.length !== excelFiles.length) {
      toast.warning(`${droppedFiles.length - excelFiles.length} Datei(en) übersprungen (kein Excel-Format)`);
    }
    
    if (excelFiles.length === 1) {
      await processFile(excelFiles[0]);
    } else {
      // Multiple files - queue them
      setFileQueue(excelFiles);
      setCurrentFileIndex(0);
      setIsProcessingQueue(true);
      await processFile(excelFiles[0]);
    }
  }, [processFile]);

  const parseFileAsType = async (file: File, type: ExcelFileType) => {
    try {
      switch (type) {
        case 'planned-hours': {
          const result = await parseScheduleExcel(file);
          setParsedPlannedHours(result.entries);
          if (result.entries.length > 0) {
            const matches = generateNameMatches(result.entries.map(e => e.name));
            setNameMatches(matches);
            setMatchDialogType('planned');
            if (matches.some(m => m.matchType === 'new')) {
              setShowMatchDialog(true);
            }
          }
          break;
        }
        case 'actual-hours': {
          const result = await parseMirusDailyExcel(file);
          setParsedActualHours(result.entries);
          if (result.entries.length > 0) {
            const matches = generateNameMatches(result.entries.map(e => e.name));
            setNameMatches(matches);
            setMatchDialogType('actual');
            if (matches.some(m => m.matchType === 'new')) {
              setShowMatchDialog(true);
            }
          }
          break;
        }
        case 'revenue': {
          const result = await parseRevenueExcel(file);
          setParsedRevenue(result.entries);
          break;
        }
      }
    } catch (error) {
      console.error('Parse error:', error);
      toast.error('Fehler beim Parsen der Datei');
    }
  };

  const handleTypeChange = async (type: ExcelFileType) => {
    setSelectedType(type);
    if (currentFile && type !== 'unknown') {
      setParsedPlannedHours([]);
      setParsedActualHours([]);
      setParsedRevenue([]);
      await parseFileAsType(currentFile, type);
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
        if (emp) nameToEmployeeId.set(override.importedName, emp.id);
      }
    });

    if (matchDialogType === 'planned') {
      const updated = parsedPlannedHours.filter(e => nameToEmployeeId.get(e.name) !== 'skip')
        .map(e => {
          const mapping = nameToEmployeeId.get(e.name);
          if (mapping && mapping !== 'new' && mapping !== 'skip') {
            const emp = employees.find(emp => emp.id === mapping);
            if (emp) return { ...e, name: emp.name };
          }
          return e;
        });
      setParsedPlannedHours(updated);
    } else {
      const updated = parsedActualHours.filter(e => nameToEmployeeId.get(e.name) !== 'skip')
        .map(e => {
          const mapping = nameToEmployeeId.get(e.name);
          if (mapping && mapping !== 'new' && mapping !== 'skip') {
            const emp = employees.find(emp => emp.id === mapping);
            if (emp) return { ...e, name: emp.name };
          }
          return e;
        });
      setParsedActualHours(updated);
    }

    setShowMatchDialog(false);
    setNameMatches([]);
  };

  const handleImport = async () => {
    if (selectedType === 'planned-hours' && parsedPlannedHours.length > 0) {
      onImportPlannedHours(parsedPlannedHours);
      toast.success(`${parsedPlannedHours.length} Plan-Stunden importiert`);
    } else if (selectedType === 'actual-hours' && parsedActualHours.length > 0) {
      onImportActualHours(parsedActualHours);
      toast.success(`${parsedActualHours.length} Ist-Stunden importiert`);
    } else if (selectedType === 'revenue' && parsedRevenue.length > 0) {
      onImportRevenue(parsedRevenue.map(e => ({ date: e.date, revenue: e.revenue, type: revenueType })));
      const typeLabel = revenueType === 'planned' ? 'Plan-' : revenueType === 'actual' ? 'Ist-' : 'Vorjahres-';
      toast.success(`${parsedRevenue.length} ${typeLabel}Umsatzeinträge importiert`);
    }
    
    // Check if there are more files in the queue
    if (isProcessingQueue && currentFileIndex < fileQueue.length - 1) {
      const nextIndex = currentFileIndex + 1;
      setCurrentFileIndex(nextIndex);
      // Reset state for next file
      setDetection(null);
      setSelectedType(null);
      setCurrentFile(null);
      setParsedPlannedHours([]);
      setParsedActualHours([]);
      setParsedRevenue([]);
      setNameMatches([]);
      // Process next file
      await processFile(fileQueue[nextIndex]);
    } else {
      // All files processed
      resetAndClose();
    }
  };

  const resetAndClose = () => {
    setIsOpen(false);
    setDetection(null);
    setSelectedType(null);
    setCurrentFile(null);
    setParsedPlannedHours([]);
    setParsedActualHours([]);
    setParsedRevenue([]);
    setNameMatches([]);
    setFileQueue([]);
    setCurrentFileIndex(0);
    setIsProcessingQueue(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const getDataCount = () => {
    if (selectedType === 'planned-hours') return parsedPlannedHours.length;
    if (selectedType === 'actual-hours') return parsedActualHours.length;
    if (selectedType === 'revenue') return parsedRevenue.length;
    return 0;
  };

  const getTypeIcon = (type: ExcelFileType) => {
    switch (type) {
      case 'planned-hours': return <Target className="h-4 w-4" />;
      case 'actual-hours': return <TrendingUp className="h-4 w-4" />;
      case 'revenue': return <DollarSign className="h-4 w-4" />;
      default: return <HelpCircle className="h-4 w-4" />;
    }
  };

  return (
    <>
      <Button variant="default" className="gap-2" onClick={() => setIsOpen(true)}>
        <Upload className="h-4 w-4" />
        Smart Import
      </Button>

      <Dialog open={isOpen} onOpenChange={(open) => { if (!open) resetAndClose(); else setIsOpen(true); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" />
              Smart Excel Import
              {isProcessingQueue && fileQueue.length > 1 && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({currentFileIndex + 1} / {fileQueue.length})
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* File Upload Area with Drag & Drop */}
            <div 
              className={cn(
                "border-2 border-dashed rounded-lg p-6 text-center transition-all duration-200 cursor-pointer",
                detection ? getTypeBgColor(detection.type) : "border-muted-foreground/25 bg-muted/30",
                isDragging && "border-primary bg-primary/10 scale-[1.02]",
                !detection && !isDragging && "hover:border-primary/50 hover:bg-muted/50"
              )}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => !detection && inputRef.current?.click()}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".xls,.xlsx"
                onChange={handleFileSelect}
                className="hidden"
              />
              
              {isDetecting ? (
                <div className="space-y-2">
                  <Loader2 className="h-10 w-10 mx-auto animate-spin text-primary" />
                  <p className="text-sm">Analysiere Datei...</p>
                </div>
              ) : detection ? (
                <div className="space-y-3">
                  <div className={cn("flex items-center justify-center gap-2", getTypeColor(detection.type))}>
                    {getTypeIcon(detection.type)}
                    <span className="font-medium">{getTypeLabel(detection.type)}</span>
                    {detection.confidence >= 70 && <Check className="h-4 w-4" />}
                    {detection.confidence >= 30 && detection.confidence < 70 && <AlertTriangle className="h-4 w-4 text-amber-500" />}
                  </div>
                  <p className="text-xs text-muted-foreground">{detection.reason}</p>
                  <p className="text-xs text-muted-foreground">
                    Konfidenz: {detection.confidence}%
                  </p>
                  <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}>
                    Andere Datei wählen
                  </Button>
                </div>
              ) : isDragging ? (
                <div className="space-y-2">
                  <Upload className="h-10 w-10 mx-auto text-primary animate-bounce" />
                  <p className="text-sm font-medium text-primary">Datei hier ablegen</p>
                </div>
              ) : (
                <>
                  <FileSpreadsheet className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
                  <p className="text-sm font-medium mb-1">Excel-Datei hochladen</p>
                  <p className="text-xs text-muted-foreground mb-2">
                    Der Dateityp wird automatisch erkannt
                  </p>
                  <p className="text-xs text-muted-foreground mb-4">
                    <span className="inline-flex items-center gap-1">
                      <Upload className="h-3 w-3" />
                      Datei hierher ziehen oder klicken
                    </span>
                  </p>
                  <Button onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}>
                    Datei auswählen
                  </Button>
                </>
              )}
            </div>

            {/* Type Override */}
            {detection && (
              <div className="space-y-2">
                <Label className="text-sm">Datentyp</Label>
                <div className="flex gap-2">
                  <Button
                    variant={selectedType === 'planned-hours' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => handleTypeChange('planned-hours')}
                    className="flex-1 gap-1"
                  >
                    <Target className="h-3 w-3" />
                    Plan
                  </Button>
                  <Button
                    variant={selectedType === 'actual-hours' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => handleTypeChange('actual-hours')}
                    className={cn("flex-1 gap-1", selectedType === 'actual-hours' && "bg-green-600 hover:bg-green-700")}
                  >
                    <TrendingUp className="h-3 w-3" />
                    Ist
                  </Button>
                  <Button
                    variant={selectedType === 'revenue' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => handleTypeChange('revenue')}
                    className={cn("flex-1 gap-1", selectedType === 'revenue' && "bg-amber-600 hover:bg-amber-700")}
                  >
                    <DollarSign className="h-3 w-3" />
                    Umsatz
                  </Button>
                </div>
              </div>
            )}

            {/* Revenue Type Selection */}
            {selectedType === 'revenue' && parsedRevenue.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm">Umsatz-Typ</Label>
                <Select value={revenueType} onValueChange={(v) => setRevenueType(v as 'planned' | 'actual' | 'previousYear')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="actual">Ist-Umsatz (Aktuell)</SelectItem>
                    <SelectItem value="planned">Plan-Umsatz (Budget)</SelectItem>
                    <SelectItem value="previousYear">Vorjahres-Umsatz</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Data Preview */}
            {getDataCount() > 0 && (
              <div className="p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <Check className="h-4 w-4" />
                  <span className="font-medium">{getDataCount()} Einträge erkannt</span>
                </div>
                {selectedType === 'planned-hours' && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {aggregateScheduleByEmployee(parsedPlannedHours).length} Mitarbeiter
                  </p>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={resetAndClose}>Abbrechen</Button>
            <Button 
              onClick={handleImport} 
              disabled={getDataCount() === 0}
              className={cn(
                selectedType === 'actual-hours' && "bg-green-600 hover:bg-green-700",
                selectedType === 'revenue' && "bg-amber-600 hover:bg-amber-700"
              )}
            >
              {isProcessingQueue && currentFileIndex < fileQueue.length - 1 
                ? `Importieren & Weiter (${currentFileIndex + 1}/${fileQueue.length})`
                : `${getDataCount()} Einträge importieren`
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportMatchPreviewDialog
        open={showMatchDialog}
        onOpenChange={setShowMatchDialog}
        onConfirm={handleMatchConfirm}
        onCancel={() => { setShowMatchDialog(false); setNameMatches([]); }}
        nameMatches={nameMatches}
        existingEmployees={employees}
      />
    </>
  );
};
