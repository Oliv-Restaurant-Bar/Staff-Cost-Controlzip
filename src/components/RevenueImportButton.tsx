import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Upload, DollarSign, Check, AlertCircle, TestTube2 } from 'lucide-react';
import { RevenueImportEntry } from '@/types/personnel';
import { parseRevenueExcel, RevenueEntry } from '@/lib/revenue-parser';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';

interface RevenueImportButtonProps {
  onImport: (entries: RevenueImportEntry[]) => void;
}

export const RevenueImportButton = ({ onImport }: RevenueImportButtonProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [parsedEntries, setParsedEntries] = useState<RevenueEntry[]>([]);
  const [revenueType, setRevenueType] = useState<'planned' | 'actual' | 'previousYear'>('actual');
  const [isProcessing, setIsProcessing] = useState(false);
  const [detectedDates, setDetectedDates] = useState<string[]>([]);
  const [detectedCurrency, setDetectedCurrency] = useState<'CHF' | 'EUR'>('CHF');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    try {
      const result = await parseRevenueExcel(file);
      setParsedEntries(result.entries);
      setDetectedCurrency(result.currency);
      setDetectedDates(result.dateRange);

      if (result.entries.length === 0) {
        toast.error('Keine Umsatzdaten gefunden');
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

  const loadTestFile = async () => {
    setIsProcessing(true);
    try {
      const fileName = '/test-files/Umsatzbeispiel.xlsx';
      const response = await fetch(fileName);
      if (!response.ok) throw new Error(`Testdatei nicht gefunden`);
      
      const blob = await response.blob();
      const file = new File([blob], 'Umsatzbeispiel.xlsx', { 
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
      });
      
      const result = await parseRevenueExcel(file);
      setParsedEntries(result.entries);
      setDetectedCurrency(result.currency);
      setDetectedDates(result.dateRange);

      if (result.entries.length > 0) {
        toast.success(`${result.entries.length} Umsatzeinträge aus Testdatei geladen`);
      }
    } catch (error) {
      toast.error('Fehler beim Laden der Testdatei');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleImport = () => {
    if (parsedEntries.length > 0) {
      onImport(parsedEntries.map(e => ({ date: e.date, revenue: e.revenue, type: revenueType })));
      setParsedEntries([]);
      setIsOpen(false);
      const typeLabel = revenueType === 'planned' ? 'Plan-' : revenueType === 'actual' ? 'Ist-' : 'Vorjahres-';
      toast.success(`${parsedEntries.length} ${typeLabel}Umsatzeinträge importiert`);
    }
  };

  const resetState = () => {
    setParsedEntries([]);
    setDetectedDates([]);
    if (inputRef.current) inputRef.current.value = '';
  };

  const formatDateRange = (dates: string[]) => {
    if (dates.length === 0) return '';
    if (dates.length === 1) return format(new Date(dates[0]), 'dd.MM.yyyy', { locale: de });
    const first = format(new Date(dates[0]), 'dd.MM', { locale: de });
    const last = format(new Date(dates[dates.length - 1]), 'dd.MM.yyyy', { locale: de });
    return `${first} - ${last}`;
  };

  const formatRevenue = (amount: number) => {
    return new Intl.NumberFormat('de-CH', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const getTotalRevenue = () => {
    return parsedEntries.reduce((sum, entry) => sum + entry.revenue, 0);
  };

  return (
    <>
      <Button variant="outline" size="sm" className="gap-2 border-amber-500 text-amber-600 hover:bg-amber-50" onClick={() => setIsOpen(true)}>
        <Upload className="h-4 w-4" />
        Umsatz importieren
      </Button>

      <Dialog open={isOpen} onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) resetState();
      }}>
        <DialogContent className="max-w-xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-amber-600" />
              Umsatz importieren
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="border-2 border-dashed border-amber-500/25 rounded-lg p-6 text-center bg-amber-50 dark:bg-amber-950/20">
              <DollarSign className="h-10 w-10 mx-auto mb-3 text-amber-600" />
              <p className="text-sm font-medium mb-2">Umsatz Excel hochladen</p>
              <p className="text-xs text-muted-foreground mb-4">
                Nur Umsatzdaten werden aktualisiert. Stunden bleiben erhalten.
              </p>
              <input
                ref={inputRef}
                type="file"
                accept=".xls,.xlsx"
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button 
                onClick={() => inputRef.current?.click()} 
                disabled={isProcessing}
                className="bg-amber-600 hover:bg-amber-700"
              >
                {isProcessing ? 'Verarbeite...' : 'Excel auswählen'}
              </Button>

              <div className="mt-4 pt-4 border-t border-dashed border-amber-500/25">
                <p className="text-xs text-muted-foreground mb-2">
                  <TestTube2 className="h-3 w-3 inline mr-1" />
                  Testdatei:
                </p>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={loadTestFile} 
                  disabled={isProcessing}
                  className="border-amber-500 text-amber-600 hover:bg-amber-50"
                >
                  Umsatz Test
                </Button>
              </div>
            </div>

            {parsedEntries.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-amber-600">
                    <Check className="h-4 w-4" />
                    {parsedEntries.length} Einträge erkannt
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {detectedDates.length > 0 && formatDateRange(detectedDates)}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Umsatz-Typ</Label>
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

                <div className="max-h-[200px] overflow-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted sticky top-0">
                      <tr>
                        <th className="text-left p-2">Datum</th>
                        <th className="text-right p-2">Umsatz</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsedEntries.slice(0, 10).map((entry, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="p-2">{format(new Date(entry.date), 'dd.MM.yyyy', { locale: de })}</td>
                          <td className="p-2 text-right font-mono">{detectedCurrency} {formatRevenue(entry.revenue)}</td>
                        </tr>
                      ))}
                      {parsedEntries.length > 10 && (
                        <tr className="border-t bg-muted/50">
                          <td className="p-2 text-muted-foreground" colSpan={2}>
                            ... und {parsedEntries.length - 10} weitere Einträge
                          </td>
                        </tr>
                      )}
                    </tbody>
                    <tfoot className="bg-muted font-medium">
                      <tr>
                        <td className="p-2">Gesamt</td>
                        <td className="p-2 text-right font-mono">{detectedCurrency} {formatRevenue(getTotalRevenue())}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg">
                  <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    <strong>Hinweis:</strong> Nur Umsatzdaten werden importiert. Bereits vorhandene Stunden bleiben erhalten.
                  </p>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsOpen(false)}>Abbrechen</Button>
              <Button onClick={handleImport} disabled={parsedEntries.length === 0} className="bg-amber-600 hover:bg-amber-700">
                Importieren
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
