import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { FileDown } from 'lucide-react';
import { exportRevenueData, RevenueExportMode, RevenueExportPeriod } from '@/lib/revenue-export';
import { DailyBudget } from '@/types/personnel';
import { toast } from 'sonner';

interface RevenueExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDate: Date;
  dailyBudgets: Record<string, DailyBudget>;
}

export const RevenueExportDialog = ({
  open,
  onOpenChange,
  selectedDate,
  dailyBudgets,
}: RevenueExportDialogProps) => {
  const [mode, setMode] = useState<RevenueExportMode>('brutto');
  const [period, setPeriod] = useState<RevenueExportPeriod>('month');
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      await exportRevenueData({
        mode,
        period,
        selectedDate,
        dailyBudgets,
      });
      toast.success(`Umsatzdaten (${mode === 'brutto' ? 'Brutto' : 'Netto'}) exportiert`);
      onOpenChange(false);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Fehler beim Export');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileDown className="h-5 w-5" />
            Umsatzdaten exportieren
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Mode Selection */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">Darstellung</Label>
            <RadioGroup
              value={mode}
              onValueChange={(value) => setMode(value as RevenueExportMode)}
              className="grid grid-cols-2 gap-3"
            >
              <div className="flex items-center space-x-2 p-3 rounded-lg border border-border hover:bg-muted/50 cursor-pointer">
                <RadioGroupItem value="brutto" id="brutto" />
                <Label htmlFor="brutto" className="cursor-pointer flex-1">
                  <span className="font-medium">Brutto</span>
                  <span className="block text-xs text-muted-foreground">inkl. MwSt.</span>
                </Label>
              </div>
              <div className="flex items-center space-x-2 p-3 rounded-lg border border-border hover:bg-muted/50 cursor-pointer">
                <RadioGroupItem value="netto" id="netto" />
                <Label htmlFor="netto" className="cursor-pointer flex-1">
                  <span className="font-medium">Netto</span>
                  <span className="block text-xs text-muted-foreground">exkl. MwSt.</span>
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Period Selection */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">Zeitraum</Label>
            <RadioGroup
              value={period}
              onValueChange={(value) => setPeriod(value as RevenueExportPeriod)}
              className="grid grid-cols-3 gap-3"
            >
              <div className="flex items-center space-x-2 p-3 rounded-lg border border-border hover:bg-muted/50 cursor-pointer">
                <RadioGroupItem value="week" id="week" />
                <Label htmlFor="week" className="cursor-pointer flex-1">
                  <span className="font-medium">Woche</span>
                  <span className="block text-xs text-muted-foreground">Aktuelle KW</span>
                </Label>
              </div>
              <div className="flex items-center space-x-2 p-3 rounded-lg border border-border hover:bg-muted/50 cursor-pointer">
                <RadioGroupItem value="month" id="month" />
                <Label htmlFor="month" className="cursor-pointer flex-1">
                  <span className="font-medium">Monat</span>
                  <span className="block text-xs text-muted-foreground">Aktueller Monat</span>
                </Label>
              </div>
              <div className="flex items-center space-x-2 p-3 rounded-lg border border-border hover:bg-muted/50 cursor-pointer">
                <RadioGroupItem value="quarter" id="quarter" />
                <Label htmlFor="quarter" className="cursor-pointer flex-1">
                  <span className="font-medium">Quartal</span>
                  <span className="block text-xs text-muted-foreground">Aktuelles Quartal</span>
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Info Box */}
          <div className="p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
            <p>
              {mode === 'netto' ? (
                <>MwSt.-Berechnung: 8.1% (Standard), 2.6% (Take Away)</>
              ) : (
                <>Alle Umsatzwerte inklusive Mehrwertsteuer</>
              )}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button onClick={handleExport} disabled={isExporting} className="gap-2">
            <FileDown className="h-4 w-4" />
            {isExporting ? 'Exportiere...' : 'Excel exportieren'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
