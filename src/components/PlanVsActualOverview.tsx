import { useState } from 'react';
import { Employee, TimeEntry } from '@/types/personnel';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { cn } from '@/lib/utils';
import { ArrowRight, TrendingUp, TrendingDown, Minus, Pencil, Check, X, Plus, UserPlus, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface PlanVsActualOverviewProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  selectedDate: string;
  onUpdatePlannedTime?: (entryId: string, field: 'plannedStart' | 'plannedEnd' | 'plannedHours', value: string | number) => void;
  onUpdateActualTime?: (entryId: string, field: 'actualStart' | 'actualEnd' | 'actualHours', value: string | number) => void;
  onAddTimeEntry?: (entry: Omit<TimeEntry, 'id'>) => string;
  onDeleteTimeEntry?: (entryId: string) => void;
}

type DeleteAction = {
  type: 'entry' | 'planned' | 'actual';
  entryId: string;
  employeeName: string;
};

export const PlanVsActualOverview = ({
  employees,
  timeEntries,
  selectedDate,
  onUpdatePlannedTime,
  onUpdateActualTime,
  onAddTimeEntry,
  onDeleteTimeEntry,
}: PlanVsActualOverviewProps) => {
  const [editingEntry, setEditingEntry] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<'planned' | 'actual' | null>(null);
  const [showNewEntryForm, setShowNewEntryForm] = useState(false);
  const [newEntryType, setNewEntryType] = useState<'planned' | 'actual'>('planned');
  const [newEntry, setNewEntry] = useState({
    employeeId: '',
    hours: '',
  });
  const [editValue, setEditValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteAction | null>(null);

  const entriesForDate = timeEntries.filter((entry) => entry.date === selectedDate);

  const getEmployeeForEntry = (employeeId: string) => {
    return employees.find((emp) => emp.id === employeeId);
  };

  const startEditingPlanned = (entry: TimeEntry) => {
    setEditingEntry(entry.id);
    setEditingField('planned');
    setEditValue(String(entry.plannedHours || ''));
  };

  const startEditingActual = (entry: TimeEntry) => {
    setEditingEntry(entry.id);
    setEditingField('actual');
    setEditValue(String(entry.actualHours || ''));
  };

  const cancelEditing = () => {
    setEditingEntry(null);
    setEditingField(null);
    setEditValue('');
  };

  const saveEditing = (entryId: string) => {
    const hours = parseFloat(editValue) || 0;
    
    if (editingField === 'planned' && onUpdatePlannedTime) {
      onUpdatePlannedTime(entryId, 'plannedHours', hours);
    } else if (editingField === 'actual' && onUpdateActualTime) {
      onUpdateActualTime(entryId, 'actualHours', hours);
    }
    
    cancelEditing();
  };

  const clearPlannedHours = (entryId: string) => {
    if (onUpdatePlannedTime) {
      onUpdatePlannedTime(entryId, 'plannedHours', 0);
      onUpdatePlannedTime(entryId, 'plannedStart', '');
      onUpdatePlannedTime(entryId, 'plannedEnd', '');
    }
    setDeleteConfirm(null);
  };

  const clearActualHours = (entryId: string) => {
    if (onUpdateActualTime) {
      onUpdateActualTime(entryId, 'actualHours', 0);
      onUpdateActualTime(entryId, 'actualStart', '');
      onUpdateActualTime(entryId, 'actualEnd', '');
    }
    setDeleteConfirm(null);
  };

  const deleteEntry = (entryId: string) => {
    if (onDeleteTimeEntry) {
      onDeleteTimeEntry(entryId);
    }
    setDeleteConfirm(null);
  };

  const handleConfirmDelete = () => {
    if (!deleteConfirm) return;
    
    switch (deleteConfirm.type) {
      case 'entry':
        deleteEntry(deleteConfirm.entryId);
        break;
      case 'planned':
        clearPlannedHours(deleteConfirm.entryId);
        break;
      case 'actual':
        clearActualHours(deleteConfirm.entryId);
        break;
    }
  };

  const getDeleteDialogContent = () => {
    if (!deleteConfirm) return { title: '', description: '' };
    
    switch (deleteConfirm.type) {
      case 'entry':
        return {
          title: 'Eintrag löschen?',
          description: `Möchtest du den gesamten Zeiteintrag für "${deleteConfirm.employeeName}" wirklich löschen? Plan- und Ist-Stunden werden entfernt.`,
        };
      case 'planned':
        return {
          title: 'Plan-Stunden löschen?',
          description: `Möchtest du die Plan-Stunden für "${deleteConfirm.employeeName}" wirklich löschen?`,
        };
      case 'actual':
        return {
          title: 'Ist-Stunden löschen?',
          description: `Möchtest du die Ist-Stunden für "${deleteConfirm.employeeName}" wirklich löschen?`,
        };
    }
  };

  // Get employees - for new entries, show all employees (they can have multiple types)
  const allEmployees = employees;

  const handleAddNewEntry = () => {
    if (!newEntry.employeeId || !onAddTimeEntry) return;
    
    const hours = parseFloat(newEntry.hours) || 0;
    
    // Check if employee already has an entry for this date
    const existingEntry = entriesForDate.find(e => e.employeeId === newEntry.employeeId);
    
    if (existingEntry) {
      // Update existing entry
      if (newEntryType === 'planned' && onUpdatePlannedTime) {
        onUpdatePlannedTime(existingEntry.id, 'plannedHours', hours);
      } else if (newEntryType === 'actual' && onUpdateActualTime) {
        // For actual hours, we need to handle this differently
        // We'll update via the existing mechanism
      }
    } else {
      // Create new entry
      onAddTimeEntry({
        employeeId: newEntry.employeeId,
        date: selectedDate,
        plannedStart: '',
        plannedEnd: '',
        plannedHours: newEntryType === 'planned' ? hours : 0,
        actualStart: '',
        actualEnd: '',
        actualHours: newEntryType === 'actual' ? hours : undefined,
      });
    }
    
    // Reset form
    setNewEntry({
      employeeId: '',
      hours: '',
    });
    setShowNewEntryForm(false);
  };

  const cancelNewEntry = () => {
    setShowNewEntryForm(false);
    setNewEntry({
      employeeId: '',
      hours: '',
    });
  };

  // Calculate totals
  const totals = entriesForDate.reduce(
    (acc, entry) => {
      const employee = getEmployeeForEntry(entry.employeeId);
      if (!employee) return acc;
      
      const plannedCost = (entry.plannedHours || 0) * employee.hourlyWage;
      const actualCost = (entry.actualHours || 0) * employee.hourlyWage;
      
      return {
        plannedHours: acc.plannedHours + (entry.plannedHours || 0),
        actualHours: acc.actualHours + (entry.actualHours || 0),
        plannedCost: acc.plannedCost + plannedCost,
        actualCost: acc.actualCost + actualCost,
      };
    },
    { plannedHours: 0, actualHours: 0, plannedCost: 0, actualCost: 0 }
  );

  const hoursDiff = totals.actualHours - totals.plannedHours;
  const costDiff = totals.actualCost - totals.plannedCost;

  const canEdit = onUpdatePlannedTime || onUpdateActualTime;
  const canAdd = onAddTimeEntry;
  const canDelete = onDeleteTimeEntry;

  if (entriesForDate.length === 0 && !canAdd) {
    return (
      <div className="stat-card">
        <h3 className="font-semibold mb-4">Plan vs. Ist Übersicht</h3>
        <p className="text-muted-foreground text-center py-8">
          Keine Zeiteinträge für dieses Datum vorhanden.
        </p>
      </div>
    );
  }

  return (
    <div className="stat-card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">Plan vs. Ist Übersicht - {selectedDate}</h3>
        {onAddTimeEntry && !showNewEntryForm && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowNewEntryForm(true)}
            className="gap-2"
          >
            <UserPlus className="h-4 w-4" />
            Eintrag hinzufügen
          </Button>
        )}
      </div>
      
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-muted-foreground">Stunden</span>
            <div className={cn(
              "flex items-center gap-1 text-sm font-semibold",
              hoursDiff > 0 && "text-destructive",
              hoursDiff < 0 && "text-primary",
              hoursDiff === 0 && "text-muted-foreground"
            )}>
              {hoursDiff > 0 ? <TrendingUp className="h-4 w-4" /> : 
               hoursDiff < 0 ? <TrendingDown className="h-4 w-4" /> : 
               <Minus className="h-4 w-4" />}
              {hoursDiff >= 0 ? '+' : ''}{formatHours(hoursDiff)}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="text-xs text-muted-foreground mb-1">Plan</p>
              <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{formatHours(totals.plannedHours)}</p>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground" />
            <div className="flex-1">
              <p className="text-xs text-muted-foreground mb-1">Ist</p>
              <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400">{formatHours(totals.actualHours)}</p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-muted-foreground">Kosten</span>
            <div className={cn(
              "flex items-center gap-1 text-sm font-semibold",
              costDiff > 0 && "text-destructive",
              costDiff < 0 && "text-primary",
              costDiff === 0 && "text-muted-foreground"
            )}>
              {costDiff > 0 ? <TrendingUp className="h-4 w-4" /> : 
               costDiff < 0 ? <TrendingDown className="h-4 w-4" /> : 
               <Minus className="h-4 w-4" />}
              {costDiff >= 0 ? '+' : ''}{formatCurrency(costDiff)}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="text-xs text-muted-foreground mb-1">Plan</p>
              <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{formatCurrency(totals.plannedCost)}</p>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground" />
            <div className="flex-1">
              <p className="text-xs text-muted-foreground mb-1">Ist</p>
              <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400">{formatCurrency(totals.actualCost)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* New Entry Form */}
      {showNewEntryForm && (
        <div className="mb-6 p-4 border border-primary/25 rounded-lg bg-primary/5">
          <h4 className="font-medium mb-3 flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Stunden hinzufügen
          </h4>
          
          {/* Type Selection */}
          <div className="mb-4">
            <Label className="text-xs text-muted-foreground mb-2 block">Art der Stunden</Label>
            <RadioGroup
              value={newEntryType}
              onValueChange={(value) => setNewEntryType(value as 'planned' | 'actual')}
              className="flex gap-4"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="planned" id="planned" />
                <Label htmlFor="planned" className="text-sm font-medium text-blue-600 dark:text-blue-400 cursor-pointer">
                  Plan-Stunden
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="actual" id="actual" />
                <Label htmlFor="actual" className="text-sm font-medium text-emerald-600 dark:text-emerald-400 cursor-pointer">
                  Ist-Stunden
                </Label>
              </div>
            </RadioGroup>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Mitarbeiter</label>
              <Select
                value={newEntry.employeeId}
                onValueChange={(value) => setNewEntry(prev => ({ ...prev, employeeId: value }))}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Mitarbeiter wählen" />
                </SelectTrigger>
                <SelectContent>
                  {allEmployees.map((emp) => (
                    <SelectItem key={emp.id} value={emp.id}>
                      {emp.name} ({emp.department})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                {newEntryType === 'planned' ? 'Plan-Stunden' : 'Ist-Stunden'}
              </label>
              <Input
                type="number"
                step="0.5"
                min="0"
                max="24"
                placeholder="z.B. 8.5"
                value={newEntry.hours}
                onChange={(e) => setNewEntry(prev => ({ ...prev, hours: e.target.value }))}
                className="h-9"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={cancelNewEntry} className="flex-1">
                Abbrechen
              </Button>
              <Button 
                size="sm" 
                onClick={handleAddNewEntry}
                disabled={!newEntry.employeeId || !newEntry.hours}
                className="flex-1"
              >
                <Check className="h-4 w-4 mr-1" />
                Hinzufügen
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Table */}
      {entriesForDate.length > 0 && (
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Mitarbeiter</th>
              <th>Abteilung</th>
              <th className="text-center bg-blue-50 dark:bg-blue-950/30">Plan Std.</th>
              <th className="text-right bg-blue-50 dark:bg-blue-950/30">Plan Kosten</th>
              <th className="text-center bg-blue-50 dark:bg-blue-950/30 w-20"></th>
              <th className="text-center bg-emerald-50 dark:bg-emerald-950/30">Ist Std.</th>
              <th className="text-right bg-emerald-50 dark:bg-emerald-950/30">Ist Kosten</th>
              <th className="text-center bg-emerald-50 dark:bg-emerald-950/30 w-20"></th>
              <th className="text-right">Differenz</th>
              {canDelete && <th className="text-center w-16"></th>}
            </tr>
          </thead>
          <tbody>
            {entriesForDate.map((entry) => {
              const employee = getEmployeeForEntry(entry.employeeId);
              if (!employee) return null;

              const isEditingPlanned = editingEntry === entry.id && editingField === 'planned';
              const isEditingActual = editingEntry === entry.id && editingField === 'actual';
              const plannedHours = entry.plannedHours || 0;
              const actualHours = entry.actualHours || 0;
              const plannedCost = plannedHours * employee.hourlyWage;
              const actualCost = actualHours * employee.hourlyWage;
              const diff = plannedCost - actualCost;

              return (
                <tr key={entry.id}>
                  <td className="font-medium">{employee.name}</td>
                  <td className="capitalize">{employee.department}</td>
                  
                  {/* Plan Std */}
                  <td className="text-center bg-blue-50/50 dark:bg-blue-950/20">
                    {isEditingPlanned ? (
                      <Input
                        type="number"
                        step="0.5"
                        min="0"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="h-7 text-xs w-20 mx-auto text-center"
                        autoFocus
                      />
                    ) : (
                      <span className="font-mono font-medium">{formatHours(plannedHours)}</span>
                    )}
                  </td>
                  
                  {/* Plan Kosten */}
                  <td className="text-right bg-blue-50/50 dark:bg-blue-950/20 font-mono">
                    {formatCurrency(plannedCost)}
                  </td>
                  
                  {/* Plan Aktionen */}
                  <td className="text-center bg-blue-50/50 dark:bg-blue-950/20">
                    {isEditingPlanned ? (
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 text-primary hover:text-primary"
                          onClick={() => saveEditing(entry.id)}
                        >
                          <Check className="h-3 w-3" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={cancelEditing}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-center gap-1">
                        {onUpdatePlannedTime && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            onClick={() => startEditingPlanned(entry)}
                            title="Plan bearbeiten"
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                        )}
                        {plannedHours > 0 && onUpdatePlannedTime && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-destructive/70 hover:text-destructive"
                            onClick={() => setDeleteConfirm({ type: 'planned', entryId: entry.id, employeeName: employee.name })}
                            title="Plan-Stunden löschen"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                  
                  {/* Ist Std */}
                  <td className="text-center bg-emerald-50/50 dark:bg-emerald-950/20">
                    {isEditingActual ? (
                      <Input
                        type="number"
                        step="0.5"
                        min="0"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="h-7 text-xs w-20 mx-auto text-center"
                        autoFocus
                      />
                    ) : (
                      <span className="font-mono font-medium">{formatHours(actualHours)}</span>
                    )}
                  </td>
                  
                  {/* Ist Kosten */}
                  <td className="text-right bg-emerald-50/50 dark:bg-emerald-950/20 font-mono">
                    {formatCurrency(actualCost)}
                  </td>
                  
                  {/* Ist Aktionen */}
                  <td className="text-center bg-emerald-50/50 dark:bg-emerald-950/20">
                    {isEditingActual ? (
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 text-primary hover:text-primary"
                          onClick={() => saveEditing(entry.id)}
                        >
                          <Check className="h-3 w-3" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={cancelEditing}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-center gap-1">
                        {onUpdateActualTime && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            onClick={() => startEditingActual(entry)}
                            title="Ist bearbeiten"
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                        )}
                        {actualHours > 0 && onUpdateActualTime && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-destructive/70 hover:text-destructive"
                            onClick={() => setDeleteConfirm({ type: 'actual', entryId: entry.id, employeeName: employee.name })}
                            title="Ist-Stunden löschen"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                  
                  {/* Differenz */}
                  <td className={cn(
                    "text-right font-mono font-semibold",
                    diff > 0 && "text-primary",
                    diff < 0 && "text-destructive"
                  )}>
                    {diff >= 0 ? '+' : ''}{formatCurrency(diff)}
                  </td>
                  
                  {/* Eintrag löschen */}
                  {canDelete && (
                    <td className="text-center">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          const emp = getEmployeeForEntry(entry.employeeId);
                          setDeleteConfirm({ type: 'entry', entryId: entry.id, employeeName: emp?.name || 'Unbekannt' });
                        }}
                        title="Eintrag komplett löschen"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-muted/50">
            <tr className="font-semibold">
              <td colSpan={2}>Total</td>
              <td className="text-center bg-blue-50/50 dark:bg-blue-950/20 font-mono">
                {formatHours(totals.plannedHours)}
              </td>
              <td className="text-right bg-blue-50/50 dark:bg-blue-950/20 font-mono">
                {formatCurrency(totals.plannedCost)}
              </td>
              <td className="bg-blue-50/50 dark:bg-blue-950/20"></td>
              <td className="text-center bg-emerald-50/50 dark:bg-emerald-950/20 font-mono">
                {formatHours(totals.actualHours)}
              </td>
              <td className="text-right bg-emerald-50/50 dark:bg-emerald-950/20 font-mono">
                {formatCurrency(totals.actualCost)}
              </td>
              <td className="bg-emerald-50/50 dark:bg-emerald-950/20"></td>
              <td className={cn(
                "text-right font-mono",
                costDiff < 0 && "text-primary",
                costDiff > 0 && "text-destructive"
              )}>
                {costDiff <= 0 ? '+' : ''}{formatCurrency(-costDiff)}
              </td>
              {canDelete && <td></td>}
            </tr>
          </tfoot>
        </table>
      </div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{getDeleteDialogContent().title}</AlertDialogTitle>
            <AlertDialogDescription>
              {getDeleteDialogContent().description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
