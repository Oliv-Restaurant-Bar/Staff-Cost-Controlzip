import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Trash2, Plus, Settings, Sparkles, Save, FolderOpen, Download, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';

export interface ShiftConfigItem {
  name: string;
  start: string;
  end: string;
  hours: number;
  color: string;
  isPaid: boolean;
  countsToTarget: boolean;
  abbrev: string;
}

interface ShiftConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shifts: ShiftConfigItem[];
  onSave: (shifts: ShiftConfigItem[]) => void;
}

interface SavedTemplate {
  name: string;
  shifts: ShiftConfigItem[];
  createdAt: string;
}

const TEMPLATES_STORAGE_KEY = 'shift-templates';

const COLOR_OPTIONS = [
  { name: 'Amber', value: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-300 dark:border-amber-700' },
  { name: 'Blue', value: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-300 dark:border-blue-700' },
  { name: 'Purple', value: 'bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-200 border-purple-300 dark:border-purple-700' },
  { name: 'Indigo', value: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-200 border-indigo-300 dark:border-indigo-700' },
  { name: 'Green', value: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-200 border-green-300 dark:border-green-600' },
  { name: 'Gray', value: 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-400 dark:border-gray-500' },
  { name: 'Red', value: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-300 dark:border-red-700' },
  { name: 'Teal', value: 'bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-200 border-teal-300 dark:border-teal-700' },
  { name: 'Pink', value: 'bg-pink-100 dark:bg-pink-900/40 text-pink-800 dark:text-pink-200 border-pink-300 dark:border-pink-700' },
  { name: 'Cyan', value: 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-800 dark:text-cyan-200 border-cyan-300 dark:border-cyan-700' },
];

// Break deduction calculation (Pausenregelung)
function calculateBreakDeduction(grossHours: number): number {
  if (grossHours >= 9) return 1; // 60 minutes
  if (grossHours >= 7) return 0.5; // 30 minutes
  if (grossHours >= 5.5) return 0.25; // 15 minutes
  return 0;
}

// Calculate effective hours with break deduction
function calculateEffectiveHours(start: string, end: string, start2?: string, end2?: string): number {
  const parseTime = (time: string): number => {
    const [hours, minutes] = time.split(':').map(Number);
    return hours + minutes / 60;
  };

  let grossHours = 0;

  if (start && end) {
    const startTime = parseTime(start);
    let endTime = parseTime(end);
    if (endTime < startTime) endTime += 24;
    grossHours += endTime - startTime;
  }

  if (start2 && end2) {
    const startTime2 = parseTime(start2);
    let endTime2 = parseTime(end2);
    if (endTime2 < startTime2) endTime2 += 24;
    grossHours += endTime2 - startTime2;
  }

  const breakDeduction = calculateBreakDeduction(grossHours);
  return Math.round((grossHours - breakDeduction) * 100) / 100;
}

// Predefined shift templates for quick adding
const SHIFT_TEMPLATES: ShiftConfigItem[] = [
  // === SERVICE Shifts ===
  { 
    name: 'Früh', 
    start: '11:00', 
    end: '15:00', 
    hours: 4, // 4h gross - no break
    color: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-300 dark:border-amber-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'FR'
  },
  { 
    name: 'Spät', 
    start: '17:00', 
    end: '23:00', 
    hours: 5.75, // 6h gross - 15min break = 5.75h
    color: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-300 dark:border-blue-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'SP'
  },

  // === KÜCHE Shifts ===
  { 
    name: 'Geteilt', 
    start: '10:00', 
    end: '14:00', 
    hours: 8.4,
    color: 'bg-pink-100 dark:bg-pink-900/40 text-pink-800 dark:text-pink-200 border-pink-300 dark:border-pink-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'GT'
  },
  { 
    name: 'Durchgehend', 
    start: '11:30', 
    end: '21:30', 
    hours: 9, // 10h gross - 1h break = 9h
    color: 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200 border-orange-300 dark:border-orange-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'DG'
  },
  { 
    name: 'Küche Früh', 
    start: '10:00', 
    end: '14:00', 
    hours: 4, // 4h gross - no break
    color: 'bg-lime-100 dark:bg-lime-900/40 text-lime-800 dark:text-lime-200 border-lime-300 dark:border-lime-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'KF'
  },

  // === SHARED Shifts ===
  { 
    name: 'Zimmerstunde', 
    start: '', 
    end: '', 
    hours: 8.4,
    color: 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-800 dark:text-cyan-200 border-cyan-300 dark:border-cyan-700', 
    isPaid: true, 
    countsToTarget: true, 
    abbrev: 'ZI'
  },
  { 
    name: 'Ferien', 
    start: '', 
    end: '', 
    hours: 8.4, 
    color: 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-400 dark:border-gray-500', 
    isPaid: false, 
    countsToTarget: true, 
    abbrev: 'FE'
  },
  { 
    name: 'Krank', 
    start: '', 
    end: '', 
    hours: 8.4, 
    color: 'bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-200 border-gray-400 dark:border-gray-500', 
    isPaid: false, 
    countsToTarget: true, 
    abbrev: 'K'
  },
  { 
    name: 'Frei', 
    start: '', 
    end: '', 
    hours: 0, 
    color: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-200 border-green-300 dark:border-green-600', 
    isPaid: false, 
    countsToTarget: false, 
    abbrev: 'F'
  },
];

export const ShiftConfigDialog = ({
  open,
  onOpenChange,
  shifts,
  onSave,
}: ShiftConfigDialogProps) => {
  const [localShifts, setLocalShifts] = useState<ShiftConfigItem[]>(shifts);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');

  // Load saved templates from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(TEMPLATES_STORAGE_KEY);
      if (stored) {
        setSavedTemplates(JSON.parse(stored));
      }
    } catch (e) {
      console.error('Failed to load templates:', e);
    }
  }, [open]);

  useEffect(() => {
    setLocalShifts(shifts);
  }, [shifts, open]);

  // Use the break deduction calculation
  const calculateHoursWithBreaks = (start: string, end: string): number => {
    if (!start || !end) return 0;
    return calculateEffectiveHours(start, end);
  };

  const handleAddShift = () => {
    const newShift: ShiftConfigItem = {
      name: `Schicht ${localShifts.length + 1}`,
      start: '09:00',
      end: '17:00',
      hours: 8,
      color: COLOR_OPTIONS[localShifts.length % COLOR_OPTIONS.length].value,
      isPaid: true,
      countsToTarget: true,
      abbrev: '',
    };
    setLocalShifts([...localShifts, newShift]);
    setEditingIndex(localShifts.length);
  };

  const handleAddFromTemplate = (template: ShiftConfigItem) => {
    // Check if shift with same name already exists
    const existingNames = localShifts.map(s => s.name.toLowerCase());
    if (existingNames.includes(template.name.toLowerCase())) {
      toast.error(`Schicht "${template.name}" existiert bereits`);
      return;
    }
    
    setLocalShifts([...localShifts, { ...template }]);
    setEditingIndex(localShifts.length);
    toast.success(`"${template.name}" hinzugefügt`);
  };

  const getAvailableTemplates = () => {
    const existingNames = localShifts.map(s => s.name.toLowerCase());
    return SHIFT_TEMPLATES.filter(t => !existingNames.includes(t.name.toLowerCase()));
  };

  const handleUpdateShift = (index: number, updates: Partial<ShiftConfigItem>) => {
    const updated = [...localShifts];
    updated[index] = { ...updated[index], ...updates };
    
    // Auto-calculate hours with break deduction if start/end changed
    if (updates.start !== undefined || updates.end !== undefined) {
      const shift = updated[index];
      if (shift.start && shift.end) {
        updated[index].hours = calculateHoursWithBreaks(shift.start, shift.end);
      }
    }
    
    setLocalShifts(updated);
  };

  const handleDeleteShift = (index: number) => {
    if (localShifts.length <= 1) {
      toast.error('Mindestens eine Schicht muss vorhanden sein');
      return;
    }
    const updated = localShifts.filter((_, i) => i !== index);
    setLocalShifts(updated);
    setEditingIndex(null);
  };

  // Save current configuration as template
  const handleSaveAsTemplate = () => {
    if (!newTemplateName.trim()) {
      toast.error('Bitte gib einen Namen für die Vorlage ein');
      return;
    }
    
    // Check for duplicate template names
    if (savedTemplates.some(t => t.name.toLowerCase() === newTemplateName.trim().toLowerCase())) {
      toast.error('Eine Vorlage mit diesem Namen existiert bereits');
      return;
    }

    const newTemplate: SavedTemplate = {
      name: newTemplateName.trim(),
      shifts: [...localShifts],
      createdAt: new Date().toISOString(),
    };

    const updated = [...savedTemplates, newTemplate];
    setSavedTemplates(updated);
    localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(updated));
    setNewTemplateName('');
    setShowSaveDialog(false);
    toast.success(`Vorlage "${newTemplate.name}" gespeichert`);
  };

  // Load a saved template
  const handleLoadTemplate = (template: SavedTemplate) => {
    setLocalShifts([...template.shifts]);
    setEditingIndex(null);
    toast.success(`Vorlage "${template.name}" geladen`);
  };

  // Delete a saved template
  const handleDeleteTemplate = (templateName: string) => {
    const updated = savedTemplates.filter(t => t.name !== templateName);
    setSavedTemplates(updated);
    localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(updated));
    toast.success('Vorlage gelöscht');
  };

  // Export configuration as JSON
  const handleExportConfig = () => {
    const exportData = {
      shifts: localShifts,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `schichten-konfiguration-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Konfiguration exportiert');
  };

  // Import configuration from JSON
  const handleImportConfig = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const data = JSON.parse(event.target?.result as string);
          if (data.shifts && Array.isArray(data.shifts)) {
            setLocalShifts(data.shifts);
            setEditingIndex(null);
            toast.success('Konfiguration importiert');
          } else {
            toast.error('Ungültiges Dateiformat');
          }
        } catch (err) {
          toast.error('Fehler beim Lesen der Datei');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const handleSave = () => {
    // Validate all shifts have names
    const invalidShift = localShifts.find(s => !s.name.trim());
    if (invalidShift) {
      toast.error('Alle Schichten müssen einen Namen haben');
      return;
    }
    
    // Check for duplicate names
    const names = localShifts.map(s => s.name.trim().toLowerCase());
    const hasDuplicates = names.length !== new Set(names).size;
    if (hasDuplicates) {
      toast.error('Schichtnamen müssen eindeutig sein');
      return;
    }

    onSave(localShifts);
    onOpenChange(false);
    toast.success('Schichten gespeichert');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Schichten verwalten
          </DialogTitle>
        </DialogHeader>

        {/* Template Management Bar */}
        <div className="flex flex-wrap items-center gap-2 p-3 bg-muted/30 rounded-lg">
          <span className="text-xs font-medium text-muted-foreground">Vorlagen:</span>
          
          {/* Save as Template */}
          {showSaveDialog ? (
            <div className="flex items-center gap-2">
              <Input
                placeholder="Vorlagenname..."
                value={newTemplateName}
                onChange={(e) => setNewTemplateName(e.target.value)}
                className="h-8 w-40 text-sm"
                onKeyDown={(e) => e.key === 'Enter' && handleSaveAsTemplate()}
              />
              <Button size="sm" variant="default" onClick={handleSaveAsTemplate} className="h-8">
                <Save className="h-3 w-3 mr-1" />
                Speichern
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowSaveDialog(false)} className="h-8">
                Abbrechen
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setShowSaveDialog(true)} className="h-8">
              <Save className="h-3 w-3 mr-1" />
              Als Vorlage speichern
            </Button>
          )}
          
          {/* Load Template Dropdown */}
          {savedTemplates.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-8">
                  <FolderOpen className="h-3 w-3 mr-1" />
                  Vorlage laden ({savedTemplates.length})
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>Gespeicherte Vorlagen</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {savedTemplates.map((template) => (
                  <DropdownMenuItem
                    key={template.name}
                    className="flex items-center justify-between group"
                  >
                    <div 
                      className="flex-1 cursor-pointer"
                      onClick={() => handleLoadTemplate(template)}
                    >
                      <div className="font-medium">{template.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {template.shifts.length} Schichten
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteTemplate(template.name);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <div className="flex-1" />

          {/* Import/Export */}
          <Button size="sm" variant="ghost" onClick={handleImportConfig} className="h-8">
            <Upload className="h-3 w-3 mr-1" />
            Import
          </Button>
          <Button size="sm" variant="ghost" onClick={handleExportConfig} className="h-8">
            <Download className="h-3 w-3 mr-1" />
            Export
          </Button>
        </div>

        <div className="space-y-4 my-4">
          {localShifts.map((shift, index) => (
            <div
              key={index}
              className={cn(
                "border rounded-lg p-4 transition-all",
                editingIndex === index ? "ring-2 ring-primary" : ""
              )}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className={cn("w-4 h-4 rounded border", shift.color)} />
                  <span className="font-semibold">{shift.name}</span>
                  {shift.abbrev && (
                    <span className="text-xs text-muted-foreground">({shift.abbrev})</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingIndex(editingIndex === index ? null : index)}
                  >
                    {editingIndex === index ? 'Schließen' : 'Bearbeiten'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleDeleteShift(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {editingIndex === index && (
                <div className="grid gap-4 pt-3 border-t">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Name</Label>
                      <Input
                        value={shift.name}
                        onChange={(e) => handleUpdateShift(index, { name: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Abkürzung (optional)</Label>
                      <Input
                        value={shift.abbrev}
                        onChange={(e) => handleUpdateShift(index, { abbrev: e.target.value })}
                        placeholder="z.B. FE, K, F"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <Label>Start</Label>
                      <Input
                        type="time"
                        value={shift.start}
                        onChange={(e) => handleUpdateShift(index, { start: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Ende</Label>
                      <Input
                        type="time"
                        value={shift.end}
                        onChange={(e) => handleUpdateShift(index, { end: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Stunden</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={shift.hours}
                        onChange={(e) => handleUpdateShift(index, { hours: parseFloat(e.target.value) || 0 })}
                      />
                    </div>
                  </div>

                  <div>
                    <Label className="mb-2 block">Farbe</Label>
                    <div className="flex flex-wrap gap-2">
                      {COLOR_OPTIONS.map((color) => (
                        <button
                          key={color.name}
                          className={cn(
                            "w-8 h-8 rounded border-2 transition-all",
                            color.value,
                            shift.color === color.value ? "ring-2 ring-primary ring-offset-2" : ""
                          )}
                          onClick={() => handleUpdateShift(index, { color: color.value })}
                          title={color.name}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={shift.isPaid}
                        onCheckedChange={(checked) => handleUpdateShift(index, { isPaid: checked })}
                      />
                      <Label>Bezahlt</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={shift.countsToTarget}
                        onCheckedChange={(checked) => handleUpdateShift(index, { countsToTarget: checked })}
                      />
                      <Label>Zählt zu Soll</Label>
                    </div>
                    {shift.start && shift.end && (
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={shift.displayMode === 'code-in-cell'}
                          onCheckedChange={(checked) =>
                            handleUpdateShift(index, { displayMode: checked ? 'code-in-cell' : 'default' })
                          }
                        />
                        <Label title="Zeigt statt der Uhrzeit nur das Kürzel in der Zelle an">Code in Zelle</Label>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {editingIndex !== index && (
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  {shift.start && shift.end ? (
                    <span>{shift.start} - {shift.end}</span>
                  ) : (
                    <span>Keine Zeitangabe</span>
                  )}
                  <span>{Number.isInteger(shift.hours) ? shift.hours : shift.hours.toFixed(2).replace(/\.?0+$/, '')}h</span>
                  {shift.isPaid && <span className="text-green-600">Bezahlt</span>}
                  {shift.countsToTarget && <span className="text-blue-600">Zählt zu Soll</span>}
                </div>
              )}
            </div>
          ))}

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={handleAddShift}>
              <Plus className="h-4 w-4 mr-2" />
              Leere Schicht
            </Button>
            
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="flex-1">
                  <Sparkles className="h-4 w-4 mr-2" />
                  Aus Vorlage hinzufügen
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Verfügbare Vorlagen</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {getAvailableTemplates().length === 0 ? (
                  <DropdownMenuItem disabled>
                    Alle Vorlagen bereits hinzugefügt
                  </DropdownMenuItem>
                ) : (
                  getAvailableTemplates().map((template) => (
                    <DropdownMenuItem
                      key={template.name}
                      onClick={() => handleAddFromTemplate(template)}
                      className="flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2">
                        <div className={cn("w-3 h-3 rounded border", template.color)} />
                        <span>{template.name}</span>
                        {template.abbrev && (
                          <span className="text-xs text-muted-foreground">({template.abbrev})</span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">{template.hours}h</span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button onClick={handleSave}>
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
