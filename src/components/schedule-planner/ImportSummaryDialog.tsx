import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Users, Calendar, Clock, ArrowRightLeft, FileSpreadsheet } from 'lucide-react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

export interface ImportSummaryData {
  type: 'planned' | 'actual';
  totalEntries: number;
  employeeCount: number;
  dateRange: { start: string; end: string } | null;
  totalHours: number;
  replacedCount: number;
  newCount: number;
  skippedCount: number;
}

interface ImportSummaryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: ImportSummaryData | null;
}

export function ImportSummaryDialog({
  open,
  onOpenChange,
  summary
}: ImportSummaryDialogProps) {
  if (!summary) return null;

  const formatDateRange = () => {
    if (!summary.dateRange) return 'Kein Datumsbereich';
    const start = format(new Date(summary.dateRange.start), 'dd.MM.yyyy', { locale: de });
    const end = format(new Date(summary.dateRange.end), 'dd.MM.yyyy', { locale: de });
    return start === end ? start : `${start} – ${end}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-green-500" />
            Import erfolgreich
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Type Badge */}
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            <Badge variant={summary.type === 'planned' ? 'default' : 'secondary'}>
              {summary.type === 'planned' ? 'Plan-Stunden' : 'Ist-Stunden'}
            </Badge>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg bg-muted/50 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <FileSpreadsheet className="h-4 w-4" />
                <span className="text-xs">Einträge</span>
              </div>
              <p className="text-2xl font-bold">{summary.totalEntries}</p>
            </div>

            <div className="p-3 rounded-lg bg-muted/50 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Users className="h-4 w-4" />
                <span className="text-xs">Mitarbeiter</span>
              </div>
              <p className="text-2xl font-bold">{summary.employeeCount}</p>
            </div>

            <div className="p-3 rounded-lg bg-muted/50 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span className="text-xs">Stunden gesamt</span>
              </div>
              <p className="text-2xl font-bold">{summary.totalHours.toFixed(1)}</p>
            </div>

            <div className="p-3 rounded-lg bg-muted/50 space-y-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Calendar className="h-4 w-4" />
                <span className="text-xs">Zeitraum</span>
              </div>
              <p className="text-sm font-medium">{formatDateRange()}</p>
            </div>
          </div>

          {/* Import Details */}
          <div className="space-y-2 pt-2 border-t">
            <p className="text-sm font-medium text-muted-foreground">Details</p>
            <div className="flex flex-wrap gap-2">
              {summary.newCount > 0 && (
                <Badge variant="outline" className="gap-1">
                  <span className="h-2 w-2 rounded-full bg-green-500" />
                  {summary.newCount} neu
                </Badge>
              )}
              {summary.replacedCount > 0 && (
                <Badge variant="outline" className="gap-1">
                  <ArrowRightLeft className="h-3 w-3" />
                  {summary.replacedCount} ersetzt
                </Badge>
              )}
              {summary.skippedCount > 0 && (
                <Badge variant="outline" className="gap-1 text-muted-foreground">
                  {summary.skippedCount} übersprungen
                </Badge>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>
            Schliessen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
