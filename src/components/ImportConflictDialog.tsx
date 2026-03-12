import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { AlertTriangle, ArrowRight, Check, X } from 'lucide-react';
import { ImportConflict, SavedNameMapping } from '@/lib/name-matching';

interface ImportConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conflicts: ImportConflict[];
  newMappings: SavedNameMapping[];
  onConfirm: (conflicts: ImportConflict[]) => void;
}

export function ImportConflictDialog({
  open,
  onOpenChange,
  conflicts,
  newMappings,
  onConfirm
}: ImportConflictDialogProps) {
  const handleResolutionChange = (index: number, resolution: 'keep' | 'replace') => {
    const updated = [...conflicts];
    updated[index] = { ...updated[index], resolution };
    onConfirm(updated);
  };

  const handleConfirmAll = () => {
    onOpenChange(false);
  };

  const handleKeepAll = () => {
    const updated = conflicts.map(c => ({ ...c, resolution: 'keep' as const }));
    onConfirm(updated);
  };

  const handleReplaceAll = () => {
    const updated = conflicts.map(c => ({ ...c, resolution: 'replace' as const }));
    onConfirm(updated);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Konflikte beim Import
          </DialogTitle>
          <DialogDescription>
            {conflicts.length} Zuordnung{conflicts.length !== 1 ? 'en' : ''} existiert bereits mit einem anderen Ziel.
            {newMappings.length > 0 && ` ${newMappings.length} neue Zuordnung${newMappings.length !== 1 ? 'en' : ''} werden hinzugefügt.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-4">
          {conflicts.map((conflict, index) => (
            <div key={conflict.importedName} className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{conflict.importedName}</span>
                <Badge variant={conflict.resolution === 'keep' ? 'secondary' : 'default'}>
                  {conflict.resolution === 'keep' ? 'Behalten' : 'Ersetzen'}
                </Badge>
              </div>
              
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className={`p-3 rounded-md border ${conflict.resolution === 'keep' ? 'border-primary bg-primary/5' : 'border-muted'}`}>
                  <div className="text-xs text-muted-foreground mb-1">Bestehend (lokal)</div>
                  <div className="flex items-center gap-2">
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{conflict.existing.employeeName}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {new Date(conflict.existing.createdAt).toLocaleDateString('de-DE')}
                  </div>
                </div>
                
                <div className={`p-3 rounded-md border ${conflict.resolution === 'replace' ? 'border-primary bg-primary/5' : 'border-muted'}`}>
                  <div className="text-xs text-muted-foreground mb-1">Importiert</div>
                  <div className="flex items-center gap-2">
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{conflict.incoming.employeeName}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {new Date(conflict.incoming.createdAt).toLocaleDateString('de-DE')}
                  </div>
                </div>
              </div>

              <RadioGroup
                value={conflict.resolution}
                onValueChange={(value) => handleResolutionChange(index, value as 'keep' | 'replace')}
                className="flex gap-4"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="keep" id={`keep-${index}`} />
                  <Label htmlFor={`keep-${index}`} className="cursor-pointer">Behalten</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="replace" id={`replace-${index}`} />
                  <Label htmlFor={`replace-${index}`} className="cursor-pointer">Ersetzen</Label>
                </div>
              </RadioGroup>
            </div>
          ))}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <div className="flex gap-2 mr-auto">
            <Button variant="outline" size="sm" onClick={handleKeepAll}>
              <X className="h-4 w-4 mr-1" />
              Alle behalten
            </Button>
            <Button variant="outline" size="sm" onClick={handleReplaceAll}>
              <Check className="h-4 w-4 mr-1" />
              Alle ersetzen
            </Button>
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button onClick={handleConfirmAll}>
            Import anwenden
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
