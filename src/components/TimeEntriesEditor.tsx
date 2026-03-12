import { Employee, TimeEntry } from '@/types/personnel';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Trash2, Save, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface TimeEntriesEditorProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  onUpdatePlannedTime: (entryId: string, field: 'plannedStart' | 'plannedEnd' | 'plannedHours', value: string | number) => void;
  onDeleteTimeEntry: (entryId: string) => void;
  onAddTimeEntry: (entry: Omit<TimeEntry, 'id'>) => string;
  selectedDate: string;
}

interface NewEntryForm {
  employeeId: string;
  plannedStart: string;
  plannedEnd: string;
  plannedHours: number;
}

export const TimeEntriesEditor = ({
  employees,
  timeEntries,
  onUpdatePlannedTime,
  onDeleteTimeEntry,
  onAddTimeEntry,
  selectedDate,
}: TimeEntriesEditorProps) => {
  const [editedEntries, setEditedEntries] = useState<Record<string, Partial<TimeEntry>>>({});
  const [showNewEntryForm, setShowNewEntryForm] = useState(false);
  const [newEntry, setNewEntry] = useState<NewEntryForm>({
    employeeId: '',
    plannedStart: '',
    plannedEnd: '',
    plannedHours: 0,
  });

  const entriesForDate = timeEntries.filter((entry) => entry.date === selectedDate);
  
  // Get employees without entries for this date
  const employeesWithoutEntry = employees.filter(
    (emp) => !entriesForDate.some((entry) => entry.employeeId === emp.id)
  );

  const getEmployeeForEntry = (employeeId: string) => {
    return employees.find((emp) => emp.id === employeeId);
  };

  const handleLocalChange = (entryId: string, field: 'plannedStart' | 'plannedEnd' | 'plannedHours', value: string | number) => {
    setEditedEntries((prev) => ({
      ...prev,
      [entryId]: {
        ...prev[entryId],
        [field]: value,
      },
    }));
  };

  const handleSave = (entry: TimeEntry) => {
    const edits = editedEntries[entry.id];
    if (edits) {
      if (edits.plannedStart !== undefined) {
        onUpdatePlannedTime(entry.id, 'plannedStart', edits.plannedStart);
      }
      if (edits.plannedEnd !== undefined) {
        onUpdatePlannedTime(entry.id, 'plannedEnd', edits.plannedEnd);
      }
      if (edits.plannedHours !== undefined) {
        onUpdatePlannedTime(entry.id, 'plannedHours', edits.plannedHours);
      }
      
      // Clear local edits after save
      setEditedEntries((prev) => {
        const newState = { ...prev };
        delete newState[entry.id];
        return newState;
      });
      
      toast.success('Zeiten gespeichert');
    }
  };

  const getValue = (entry: TimeEntry, field: keyof TimeEntry) => {
    const editedValue = editedEntries[entry.id]?.[field];
    if (editedValue !== undefined) return editedValue;
    return entry[field];
  };

  const hasChanges = (entryId: string) => {
    return editedEntries[entryId] && Object.keys(editedEntries[entryId]).length > 0;
  };

  const handleAddNewEntry = () => {
    if (!newEntry.employeeId) {
      toast.error('Bitte wähle einen Mitarbeiter aus');
      return;
    }

    onAddTimeEntry({
      employeeId: newEntry.employeeId,
      date: selectedDate,
      plannedStart: newEntry.plannedStart,
      plannedEnd: newEntry.plannedEnd,
      plannedHours: newEntry.plannedHours,
    });

    // Reset form
    setNewEntry({
      employeeId: '',
      plannedStart: '',
      plannedEnd: '',
      plannedHours: 0,
    });
    setShowNewEntryForm(false);
    toast.success('Zeiteintrag erstellt');
  };

  const calculateHoursFromTimes = (start: string, end: string): number => {
    if (!start || !end) return 0;
    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    let hours = endH - startH + (endM - startM) / 60;
    if (hours < 0) hours += 24; // Handle overnight shifts
    return Math.round(hours * 100) / 100;
  };

  const handleNewEntryTimeChange = (field: 'plannedStart' | 'plannedEnd', value: string) => {
    setNewEntry((prev) => {
      const updated = { ...prev, [field]: value };
      if (updated.plannedStart && updated.plannedEnd) {
        updated.plannedHours = calculateHoursFromTimes(updated.plannedStart, updated.plannedEnd);
      }
      return updated;
    });
  };

  return (
    <div className="stat-card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold">Zeiten bearbeiten - {selectedDate}</h3>
          <p className="text-sm text-muted-foreground">
            Hier kannst du geplante Arbeitszeiten manuell korrigieren oder neue erstellen.
          </p>
        </div>
        <Button
          onClick={() => setShowNewEntryForm(!showNewEntryForm)}
          variant={showNewEntryForm ? "secondary" : "default"}
          size="sm"
          className="gap-2"
        >
          <Plus className="h-4 w-4" />
          Neuer Eintrag
        </Button>
      </div>

      {/* New Entry Form */}
      {showNewEntryForm && (
        <div className="mb-6 p-4 rounded-lg border border-primary/30 bg-primary/5">
          <h4 className="font-medium mb-3">Neuen Zeiteintrag erstellen</h4>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
            <div className="md:col-span-2">
              <label className="text-sm text-muted-foreground block mb-1">Mitarbeiter</label>
              <Select
                value={newEntry.employeeId}
                onValueChange={(value) => setNewEntry((prev) => ({ ...prev, employeeId: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Mitarbeiter wählen..." />
                </SelectTrigger>
                <SelectContent>
                  {employeesWithoutEntry.length === 0 ? (
                    <SelectItem value="none" disabled>
                      Alle Mitarbeiter haben bereits Einträge
                    </SelectItem>
                  ) : (
                    employeesWithoutEntry.map((emp) => (
                      <SelectItem key={emp.id} value={emp.id}>
                        {emp.name} ({emp.department})
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm text-muted-foreground block mb-1">Start</label>
              <Input
                type="time"
                value={newEntry.plannedStart}
                onChange={(e) => handleNewEntryTimeChange('plannedStart', e.target.value)}
                className="h-10"
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground block mb-1">Ende</label>
              <Input
                type="time"
                value={newEntry.plannedEnd}
                onChange={(e) => handleNewEntryTimeChange('plannedEnd', e.target.value)}
                className="h-10"
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground block mb-1">Stunden</label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  step="0.5"
                  min="0"
                  max="24"
                  value={newEntry.plannedHours || ''}
                  onChange={(e) => setNewEntry((prev) => ({ ...prev, plannedHours: parseFloat(e.target.value) || 0 }))}
                  className="h-10"
                />
                <Button onClick={handleAddNewEntry} className="h-10 px-4">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {entriesForDate.length === 0 && !showNewEntryForm ? (
        <p className="text-muted-foreground text-center py-8">
          Keine Zeiteinträge für dieses Datum vorhanden. 
          Klicke auf "Neuer Eintrag" um einen zu erstellen.
        </p>
      ) : entriesForDate.length > 0 && (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Mitarbeiter</th>
                <th>Abteilung</th>
                <th className="text-center">Geplanter Start</th>
                <th className="text-center">Geplantes Ende</th>
                <th className="text-center">Geplante Stunden</th>
                <th className="text-right">Plan Kosten</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entriesForDate.map((entry) => {
                const employee = getEmployeeForEntry(entry.employeeId);
                if (!employee) return null;

                const plannedHours = Number(getValue(entry, 'plannedHours')) || 0;
                const plannedCost = plannedHours * employee.hourlyWage;

                return (
                  <tr key={entry.id} className="group">
                    <td className="font-medium">{employee.name}</td>
                    <td className="capitalize">{employee.department}</td>
                    <td className="text-center">
                      <Input
                        type="time"
                        value={String(getValue(entry, 'plannedStart') || '')}
                        onChange={(e) => handleLocalChange(entry.id, 'plannedStart', e.target.value)}
                        className="w-28 h-8 text-sm mx-auto"
                      />
                    </td>
                    <td className="text-center">
                      <Input
                        type="time"
                        value={String(getValue(entry, 'plannedEnd') || '')}
                        onChange={(e) => handleLocalChange(entry.id, 'plannedEnd', e.target.value)}
                        className="w-28 h-8 text-sm mx-auto"
                      />
                    </td>
                    <td className="text-center">
                      <Input
                        type="number"
                        step="0.5"
                        min="0"
                        max="24"
                        value={String(getValue(entry, 'plannedHours') || '')}
                        onChange={(e) => handleLocalChange(entry.id, 'plannedHours', parseFloat(e.target.value) || 0)}
                        className="w-20 h-8 text-sm mx-auto text-center"
                      />
                    </td>
                    <td className="text-right font-mono">{formatCurrency(plannedCost)}</td>
                    <td className="text-right">
                      <div className="flex gap-1 justify-end">
                        {hasChanges(entry.id) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleSave(entry)}
                            className="h-8 w-8 p-0 text-primary hover:text-primary"
                          >
                            <Save className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onDeleteTimeEntry(entry.id)}
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
