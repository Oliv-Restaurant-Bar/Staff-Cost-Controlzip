import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Employee, Department, EmploymentType } from '@/types/personnel';
import { Download, Upload, FileSpreadsheet, Check, AlertCircle, RefreshCw, Users, Briefcase } from 'lucide-react';
import { 
  exportEmployeesToExcel, 
  importEmployeesFromExcel, 
  downloadEmployeeTemplate,
  EmployeeImportResult,
  NameMatchInfo
} from '@/lib/employee-excel-export-import';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { ImportMatchPreviewDialog, NameMatchOverride } from '@/components/schedule-planner/ImportMatchPreviewDialog';

interface EmployeeImportExportButtonsProps {
  employees: Employee[];
  onImport: (employees: Employee[]) => void;
}

export const EmployeeImportExportButtons = ({ 
  employees, 
  onImport 
}: EmployeeImportExportButtonsProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [matchPreviewOpen, setMatchPreviewOpen] = useState(false);
  const [importResult, setImportResult] = useState<EmployeeImportResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  // Selection state for bulk edit
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [bulkDepartment, setBulkDepartment] = useState<Department | ''>('');
  const [bulkEmploymentType, setBulkEmploymentType] = useState<EmploymentType | ''>('');

  const handleExport = () => {
    exportEmployeesToExcel(employees);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    try {
      const result = await importEmployeesFromExcel(file, employees);
      setImportResult(result);
      setSelectedIndices(new Set());
      setBulkDepartment('');
      setBulkEmploymentType('');
      
      // Show matching dialog first if there are any matches to review
      if (result.nameMatches.length > 0) {
        setMatchPreviewOpen(true);
      } else {
        setPreviewOpen(true);
      }
    } finally {
      setIsLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Handle match confirmation from the matching dialog
  const handleMatchConfirm = (overrides: NameMatchOverride[]) => {
    if (!importResult) return;

    const updatedEmployees: Employee[] = [];
    const skippedNames = new Set<string>();
    let newCount = 0;
    let updatedCount = 0;

    overrides.forEach((override, idx) => {
      const originalEmployee = importResult.employees[idx];
      if (!originalEmployee) return;

      if (override.selectedEmployeeId === 'skip') {
        skippedNames.add(override.importedName);
        return;
      }

      if (override.selectedEmployeeId === 'new') {
        // Create as new employee
        updatedEmployees.push({
          ...originalEmployee,
          id: `imported-${Date.now()}-${idx}`,
          name: override.importedName
        });
        newCount++;
      } else {
        // Map to existing employee
        const existingEmp = employees.find(e => e.id === override.selectedEmployeeId);
        if (existingEmp) {
          updatedEmployees.push({
            ...originalEmployee,
            id: existingEmp.id,
            name: existingEmp.name
          });
          updatedCount++;
        }
      }
    });

    // Update import result with the matched employees
    setImportResult({
      ...importResult,
      employees: updatedEmployees,
      newCount,
      updatedCount
    });

    setMatchPreviewOpen(false);
    setPreviewOpen(true);
  };

  const handleMatchCancel = () => {
    setMatchPreviewOpen(false);
    setImportResult(null);
  };

  const toggleSelection = (index: number) => {
    setSelectedIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!importResult) return;
    if (selectedIndices.size === importResult.employees.length) {
      setSelectedIndices(new Set());
    } else {
      setSelectedIndices(new Set(importResult.employees.map((_, i) => i)));
    }
  };

  const applyBulkDepartment = () => {
    if (!importResult || !bulkDepartment || selectedIndices.size === 0) return;
    
    const updatedEmployees = importResult.employees.map((emp, idx) => {
      if (selectedIndices.has(idx)) {
        return { ...emp, department: bulkDepartment };
      }
      return emp;
    });
    
    setImportResult({
      ...importResult,
      employees: updatedEmployees
    });
    
    toast.success(`Abteilung für ${selectedIndices.size} Mitarbeiter geändert`);
    setSelectedIndices(new Set());
    setBulkDepartment('');
  };

  const applyBulkEmploymentType = () => {
    if (!importResult || !bulkEmploymentType || selectedIndices.size === 0) return;
    
    const updatedEmployees = importResult.employees.map((emp, idx) => {
      if (selectedIndices.has(idx)) {
        return { ...emp, employmentType: bulkEmploymentType };
      }
      return emp;
    });
    
    setImportResult({
      ...importResult,
      employees: updatedEmployees
    });
    
    toast.success(`Anstellungsverhältnis für ${selectedIndices.size} Mitarbeiter geändert`);
    setSelectedIndices(new Set());
    setBulkEmploymentType('');
  };

  const handleConfirmImport = () => {
    if (!importResult) return;

    const importedNames = new Set(importResult.employees.map(e => e.name.toLowerCase()));
    const unchangedEmployees = employees.filter(e => !importedNames.has(e.name.toLowerCase()));
    const mergedEmployees = [...unchangedEmployees, ...importResult.employees];
    
    onImport(mergedEmployees);
    
    toast.success(
      `Import abgeschlossen: ${importResult.newCount} neu, ${importResult.updatedCount} aktualisiert`
    );
    
    setPreviewOpen(false);
    setImportResult(null);
    setSelectedIndices(new Set());
  };

  const handleCancelImport = () => {
    setPreviewOpen(false);
    setImportResult(null);
    setSelectedIndices(new Set());
  };

  return (
    <>
      <div className="flex gap-2 flex-wrap">
        <Button 
          variant="outline" 
          size="sm" 
          onClick={handleExport}
          disabled={employees.length === 0}
        >
          <Download className="h-4 w-4 mr-2" />
          Exportieren
        </Button>

        <Button 
          variant="outline" 
          size="sm" 
          onClick={() => fileInputRef.current?.click()}
          disabled={isLoading}
        >
          {isLoading ? (
            <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Upload className="h-4 w-4 mr-2" />
          )}
          Importieren
        </Button>

        <Button 
          variant="ghost" 
          size="sm" 
          onClick={downloadEmployeeTemplate}
        >
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Vorlage
        </Button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      {/* Import Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Mitarbeiter importieren</DialogTitle>
            <DialogDescription>
              Überprüfen Sie die zu importierenden Mitarbeiter. Wählen Sie mehrere aus, um die Abteilung zu ändern.
            </DialogDescription>
          </DialogHeader>

          {importResult && (
            <div className="space-y-4">
              {/* Summary */}
              <div className="flex gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="default" className="bg-green-500">
                    {importResult.newCount}
                  </Badge>
                  <span>Neu</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">
                    {importResult.updatedCount}
                  </Badge>
                  <span>Aktualisiert</span>
                </div>
              </div>

              {/* Bulk Edit Controls */}
              {importResult.employees.length > 0 && (
                <div className="flex flex-col gap-3 p-3 bg-muted/50 rounded-lg border">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Checkbox 
                        checked={selectedIndices.size === importResult.employees.length && importResult.employees.length > 0}
                        onCheckedChange={toggleSelectAll}
                      />
                      <span className="text-sm font-medium">
                        {selectedIndices.size > 0 
                          ? `${selectedIndices.size} ausgewählt`
                          : 'Alle auswählen'
                        }
                      </span>
                    </div>
                  </div>
                  
                  {selectedIndices.size > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Department bulk edit */}
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        <Select value={bulkDepartment} onValueChange={(v) => setBulkDepartment(v as Department)}>
                          <SelectTrigger className="w-[130px] h-8">
                            <SelectValue placeholder="Abteilung..." />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="service">Service</SelectItem>
                            <SelectItem value="küche">Küche</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button 
                          size="sm" 
                          variant="secondary"
                          onClick={applyBulkDepartment}
                          disabled={!bulkDepartment}
                          className="h-8"
                        >
                          Anwenden
                        </Button>
                      </div>
                      
                      <div className="h-6 w-px bg-border hidden sm:block" />
                      
                      {/* Employment type bulk edit */}
                      <div className="flex items-center gap-2">
                        <Briefcase className="h-4 w-4 text-muted-foreground" />
                        <Select value={bulkEmploymentType} onValueChange={(v) => setBulkEmploymentType(v as EmploymentType)}>
                          <SelectTrigger className="w-[130px] h-8">
                            <SelectValue placeholder="Anstellung..." />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="vollzeit">Vollzeit</SelectItem>
                            <SelectItem value="teilzeit">Teilzeit</SelectItem>
                            <SelectItem value="aushilfe">Aushilfe</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button 
                          size="sm" 
                          variant="secondary"
                          onClick={applyBulkEmploymentType}
                          disabled={!bulkEmploymentType}
                          className="h-8"
                        >
                          Anwenden
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Errors */}
              {importResult.errors.length > 0 && (
                <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-destructive mb-2">
                    <AlertCircle className="h-4 w-4" />
                    Hinweise ({importResult.errors.length})
                  </div>
                  <ul className="text-xs text-destructive space-y-1">
                    {importResult.errors.slice(0, 5).map((err, idx) => (
                      <li key={idx}>{err}</li>
                    ))}
                    {importResult.errors.length > 5 && (
                      <li>...und {importResult.errors.length - 5} weitere</li>
                    )}
                  </ul>
                </div>
              )}

              {/* Employee List */}
              <ScrollArea className="h-[300px] border rounded-lg">
                <div className="p-3 space-y-2">
                  {importResult.employees.map((emp, idx) => {
                    const isNew = !employees.find(e => e.name.toLowerCase() === emp.name.toLowerCase());
                    const isSelected = selectedIndices.has(idx);
                    return (
                      <div 
                        key={idx} 
                        className={`flex items-center justify-between p-2 rounded-md cursor-pointer transition-colors ${
                          isSelected 
                            ? 'bg-primary/10 border border-primary/30' 
                            : 'bg-muted/50 hover:bg-muted'
                        }`}
                        onClick={() => toggleSelection(idx)}
                      >
                        <div className="flex items-center gap-3">
                          <Checkbox 
                            checked={isSelected}
                            onCheckedChange={() => toggleSelection(idx)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <div>
                            <div className="font-medium text-sm">{emp.name}</div>
                            <div className="text-xs text-muted-foreground">
                              <Badge variant="outline" className="mr-1 text-xs py-0">
                                {emp.department === 'service' ? 'Service' : 'Küche'}
                              </Badge>
                              {emp.weeklyHours}h/Woche
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-medium">
                            CHF {emp.hourlyWage.toFixed(2)}/h
                          </div>
                          <Badge variant={isNew ? 'default' : 'secondary'} className={isNew ? 'bg-green-500' : ''}>
                            {isNew ? 'Neu' : 'Update'}
                          </Badge>
                        </div>
                      </div>
                    );
                  })}
                  {importResult.employees.length === 0 && (
                    <div className="text-center text-muted-foreground py-8">
                      Keine Mitarbeiter gefunden
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={handleCancelImport}>
              Abbrechen
            </Button>
            <Button 
              onClick={handleConfirmImport}
              disabled={!importResult || importResult.employees.length === 0}
            >
              <Check className="h-4 w-4 mr-2" />
              Import bestätigen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Name Matching Preview Dialog */}
      {importResult && (
        <ImportMatchPreviewDialog
          open={matchPreviewOpen}
          onOpenChange={setMatchPreviewOpen}
          nameMatches={importResult.nameMatches}
          existingEmployees={employees}
          onConfirm={handleMatchConfirm}
          onCancel={handleMatchCancel}
        />
      )}
    </>
  );
};
