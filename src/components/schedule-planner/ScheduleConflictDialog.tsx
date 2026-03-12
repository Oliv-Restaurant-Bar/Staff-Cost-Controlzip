import { useState, useMemo } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { AlertTriangle, ArrowRight, Check, X, Clock, CalendarDays } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

export interface ScheduleConflict {
  employeeId: string;
  employeeName: string;
  date: string;
  existing: {
    früh?: { start: string; end: string } | null;
    spät?: { start: string; end: string } | null;
    frühAbsence?: string | null;
    spätAbsence?: string | null;
  };
  incoming: {
    früh?: { start: string; end: string } | null;
    spät?: { start: string; end: string } | null;
    frühAbsence?: string | null;
    spätAbsence?: string | null;
  };
  resolution: 'keep' | 'replace';
}

interface ScheduleConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conflicts: ScheduleConflict[];
  newEntriesCount: number;
  onConfirm: (conflicts: ScheduleConflict[]) => void;
  onCancel: () => void;
  alwaysOverwrite?: boolean;
  onAlwaysOverwriteChange?: (value: boolean) => void;
}

const formatTimeSlot = (slot: { start: string; end: string } | null | undefined): string => {
  if (!slot) return '—';
  return `${slot.start} - ${slot.end}`;
};

const formatAbsence = (absence: string | null | undefined): string => {
  if (!absence) return '';
  const labels: Record<string, string> = {
    'urlaub': 'Urlaub',
    'krank': 'Krank',
    'frei': 'Frei',
    'feiertag': 'Feiertag',
    'schule': 'Schule',
  };
  return labels[absence] || absence;
};

export function ScheduleConflictDialog({
  open,
  onOpenChange,
  conflicts,
  newEntriesCount,
  onConfirm,
  onCancel,
  alwaysOverwrite = false,
  onAlwaysOverwriteChange
}: ScheduleConflictDialogProps) {
  // Get default resolution from settings
  const defaultResolution = localStorage.getItem('import-default-resolution') === 'keep' ? 'keep' : 'replace';
  
  const [localConflicts, setLocalConflicts] = useState<ScheduleConflict[]>(() => 
    conflicts.map(c => ({ ...c, resolution: defaultResolution as 'keep' | 'replace' }))
  );

  // Update local state when conflicts prop changes
  useMemo(() => {
    setLocalConflicts(conflicts.map(c => ({ ...c, resolution: defaultResolution as 'keep' | 'replace' })));
  }, [conflicts, defaultResolution]);

  const handleResolutionChange = (index: number, resolution: 'keep' | 'replace') => {
    setLocalConflicts(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], resolution };
      return updated;
    });
  };

  const handleConfirmAll = () => {
    onConfirm(localConflicts);
    onOpenChange(false);
  };

  const handleKeepAll = () => {
    setLocalConflicts(prev => prev.map(c => ({ ...c, resolution: 'keep' as const })));
  };

  const handleReplaceAll = () => {
    setLocalConflicts(prev => prev.map(c => ({ ...c, resolution: 'replace' as const })));
  };

  const replaceCount = localConflicts.filter(c => c.resolution === 'replace').length;
  const keepCount = localConflicts.filter(c => c.resolution === 'keep').length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Konflikte beim Import
          </DialogTitle>
          <DialogDescription>
            {conflicts.length} Einträge existieren bereits und würden überschrieben.
            {newEntriesCount > 0 && (
              <> Zusätzlich werden <strong>{newEntriesCount} neue Einträge</strong> hinzugefügt.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-4 py-2 px-1">
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="secondary" className="gap-1">
              <X className="h-3 w-3" />
              {keepCount} behalten
            </Badge>
            <Badge variant="default" className="gap-1">
              <Check className="h-3 w-3" />
              {replaceCount} ersetzen
            </Badge>
          </div>
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" size="sm" onClick={handleKeepAll}>
              <X className="h-4 w-4 mr-1" />
              Alle behalten
            </Button>
            <Button variant="outline" size="sm" onClick={handleReplaceAll}>
              <Check className="h-4 w-4 mr-1" />
              Alle ersetzen
            </Button>
          </div>
        </div>

        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="space-y-3 py-2">
            {localConflicts.map((conflict, index) => (
              <div key={`${conflict.employeeId}-${conflict.date}`} className="border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{conflict.employeeName}</span>
                    <Badge variant="outline" className="text-xs gap-1">
                      <CalendarDays className="h-3 w-3" />
                      {format(new Date(conflict.date), 'EEE, dd.MM.yyyy', { locale: de })}
                    </Badge>
                  </div>
                  <Badge variant={conflict.resolution === 'keep' ? 'secondary' : 'default'}>
                    {conflict.resolution === 'keep' ? 'Behalten' : 'Ersetzen'}
                  </Badge>
                </div>
                
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {/* Existing data */}
                  <div className={`p-2 rounded-md border ${conflict.resolution === 'keep' ? 'border-primary bg-primary/5' : 'border-muted'}`}>
                    <div className="text-xs text-muted-foreground mb-1 font-medium">Bestehend</div>
                    <div className="space-y-1">
                      {(conflict.existing.früh || conflict.existing.frühAbsence) && (
                        <div className="flex items-center gap-2 text-xs">
                          <Clock className="h-3 w-3 text-muted-foreground" />
                          <span>Früh:</span>
                          <span className="font-mono">
                            {conflict.existing.frühAbsence 
                              ? formatAbsence(conflict.existing.frühAbsence)
                              : formatTimeSlot(conflict.existing.früh)}
                          </span>
                        </div>
                      )}
                      {(conflict.existing.spät || conflict.existing.spätAbsence) && (
                        <div className="flex items-center gap-2 text-xs">
                          <Clock className="h-3 w-3 text-muted-foreground" />
                          <span>Spät:</span>
                          <span className="font-mono">
                            {conflict.existing.spätAbsence 
                              ? formatAbsence(conflict.existing.spätAbsence)
                              : formatTimeSlot(conflict.existing.spät)}
                          </span>
                        </div>
                      )}
                      {!conflict.existing.früh && !conflict.existing.spät && 
                       !conflict.existing.frühAbsence && !conflict.existing.spätAbsence && (
                        <span className="text-xs text-muted-foreground">Keine Daten</span>
                      )}
                    </div>
                  </div>
                  
                  {/* Incoming data */}
                  <div className={`p-2 rounded-md border ${conflict.resolution === 'replace' ? 'border-primary bg-primary/5' : 'border-muted'}`}>
                    <div className="text-xs text-muted-foreground mb-1 font-medium">Import</div>
                    <div className="space-y-1">
                      {(conflict.incoming.früh || conflict.incoming.frühAbsence) && (
                        <div className="flex items-center gap-2 text-xs">
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <span>Früh:</span>
                          <span className="font-mono">
                            {conflict.incoming.frühAbsence 
                              ? formatAbsence(conflict.incoming.frühAbsence)
                              : formatTimeSlot(conflict.incoming.früh)}
                          </span>
                        </div>
                      )}
                      {(conflict.incoming.spät || conflict.incoming.spätAbsence) && (
                        <div className="flex items-center gap-2 text-xs">
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <span>Spät:</span>
                          <span className="font-mono">
                            {conflict.incoming.spätAbsence 
                              ? formatAbsence(conflict.incoming.spätAbsence)
                              : formatTimeSlot(conflict.incoming.spät)}
                          </span>
                        </div>
                      )}
                      {!conflict.incoming.früh && !conflict.incoming.spät && 
                       !conflict.incoming.frühAbsence && !conflict.incoming.spätAbsence && (
                        <span className="text-xs text-muted-foreground">Keine Daten</span>
                      )}
                    </div>
                  </div>
                </div>

                <RadioGroup
                  value={conflict.resolution}
                  onValueChange={(value) => handleResolutionChange(index, value as 'keep' | 'replace')}
                  className="flex gap-4 pt-1"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="keep" id={`keep-${index}`} />
                    <Label htmlFor={`keep-${index}`} className="cursor-pointer text-sm">Behalten</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="replace" id={`replace-${index}`} />
                    <Label htmlFor={`replace-${index}`} className="cursor-pointer text-sm">Ersetzen</Label>
                  </div>
                </RadioGroup>
              </div>
            ))}
          </div>
        </ScrollArea>

        <DialogFooter className="flex-col sm:flex-row gap-2 pt-4 border-t">
          {onAlwaysOverwriteChange && (
            <div className="flex items-center space-x-2 mr-auto">
              <Checkbox 
                id="always-overwrite" 
                checked={alwaysOverwrite}
                onCheckedChange={(checked) => onAlwaysOverwriteChange(checked === true)}
              />
              <Label htmlFor="always-overwrite" className="text-sm cursor-pointer">
                Immer überschreiben (Dialog nicht mehr anzeigen)
              </Label>
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => { onCancel(); onOpenChange(false); }}>
              Abbrechen
            </Button>
            <Button onClick={handleConfirmAll}>
              Import anwenden ({replaceCount} ersetzen, {keepCount} behalten)
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
