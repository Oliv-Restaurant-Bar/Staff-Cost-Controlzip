import { useState, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ChevronLeft, ChevronRight, FileBarChart2, Loader2 } from 'lucide-react';
import {
  startOfWeek, endOfWeek, subWeeks, addWeeks, getISOWeek, format,
} from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee } from '@/types/personnel';
import { DaySchedule } from '@/components/schedule-planner/ScheduleGrid';
import { exportWeeklyReportPDF, WeekReportDept } from '@/lib/weekly-report-pdf';
import { resolveZielwert } from '@/lib/zielwerte-store';
import { toast } from 'sonner';

interface WeeklyReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  actualHoursData: Record<string, { hours: number }>;
  dailyBudgets: Record<string, { plannedRevenue?: number; actualRevenue?: number }>;
  restaurantName: string;
}

const WEEK_START = { weekStartsOn: 1 as const };

function kwLabel(weekStart: Date, weekEnd: Date): string {
  const kw = getISOWeek(weekStart);
  return `KW ${kw}  ·  ${format(weekStart, 'd. MMM', { locale: de })} – ${format(weekEnd, 'd. MMM yyyy', { locale: de })}`;
}

export function WeeklyReportDialog({
  open, onOpenChange,
  employees, scheduleData, actualHoursData, dailyBudgets,
  restaurantName,
}: WeeklyReportDialogProps) {
  const now = new Date();
  const lastWeekStart = startOfWeek(subWeeks(now, 1), WEEK_START);
  const lastWeekEnd   = endOfWeek(lastWeekStart, WEEK_START);

  const [weekStart, setWeekStart] = useState<Date>(lastWeekStart);
  const [department, setDepartment] = useState<WeekReportDept>('all');
  const [loading, setLoading] = useState(false);

  // Reset to last week whenever dialog opens
  useEffect(() => {
    if (open) {
      setWeekStart(startOfWeek(subWeeks(new Date(), 1), WEEK_START));
      setDepartment('all');
    }
  }, [open]);

  const weekEnd = endOfWeek(weekStart, WEEK_START);
  const kw = getISOWeek(weekStart);

  const handlePrev = () => setWeekStart(w => startOfWeek(subWeeks(w, 1), WEEK_START));
  const handleNext = () => setWeekStart(w => startOfWeek(addWeeks(w, 1), WEEK_START));
  const handleCurrentWeek = () => setWeekStart(startOfWeek(new Date(), WEEK_START));
  const handleLastWeek    = () => setWeekStart(startOfWeek(subWeeks(new Date(), 1), WEEK_START));

  const handleExport = async () => {
    setLoading(true);
    try {
      const year  = weekStart.getFullYear();
      const month = weekStart.getMonth() + 1;
      const targetPercent        = resolveZielwert(year, month, undefined,  false).targetPercent;
      const targetPercentService = resolveZielwert(year, month, 'service',  false).targetPercent;
      const targetPercentKüche   = resolveZielwert(year, month, 'küche',    false).targetPercent;

      exportWeeklyReportPDF({
        weekStart,
        weekEnd,
        employees,
        scheduleData,
        actualHoursData,
        dailyBudgets,
        department,
        restaurantName,
        targetPercent,
        targetPercentService,
        targetPercentKüche,
      });

      toast.success('Wochenreport exportiert');
      onOpenChange(false);
    } catch (err) {
      console.error('Wochenreport PDF Fehler:', err);
      toast.error('PDF-Export fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  };

  const serviceCount = employees.filter(e => e.department === 'service').length;
  const kücheCount   = employees.filter(e => e.department === 'küche').length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileBarChart2 className="h-5 w-5 text-blue-600" />
            Wochenreport PDF
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Management-Bericht mit Plan/Ist-Vergleich, Ampelfarben und Empfehlungen.
          </p>
        </DialogHeader>

        <div className="space-y-5 py-2">

          {/* ── Week picker ─────────────────────────────────────────────── */}
          <div>
            <Label className="text-sm font-semibold mb-2 block">Kalenderwoche</Label>

            {/* Quick buttons */}
            <div className="flex gap-2 mb-3">
              <Button
                variant="outline" size="sm" className="flex-1 text-xs h-8"
                onClick={handleLastWeek}
              >
                Letzte Woche
              </Button>
              <Button
                variant="outline" size="sm" className="flex-1 text-xs h-8"
                onClick={handleCurrentWeek}
              >
                Diese Woche
              </Button>
            </div>

            {/* KW navigation */}
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={handlePrev}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="flex-1 text-center">
                <div className="text-base font-bold">KW {kw}</div>
                <div className="text-xs text-muted-foreground">
                  {format(weekStart, 'dd.MM.', { locale: de })} – {format(weekEnd, 'dd.MM.yyyy', { locale: de })}
                </div>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={handleNext}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* ── Department filter ────────────────────────────────────────── */}
          <div>
            <Label className="text-sm font-semibold mb-2 block">Bereich</Label>
            <RadioGroup
              value={department}
              onValueChange={v => setDepartment(v as WeekReportDept)}
              className="space-y-2"
            >
              <label className="flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer hover:bg-muted/50 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                <RadioGroupItem value="all" id="dept-all" />
                <div>
                  <div className="text-sm font-medium">Gesamt</div>
                  <div className="text-xs text-muted-foreground">
                    Service + Küche ({serviceCount + kücheCount} Mitarbeiter)
                  </div>
                </div>
              </label>
              <label className="flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer hover:bg-muted/50 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                <RadioGroupItem value="service" id="dept-service" />
                <div>
                  <div className="text-sm font-medium">Service</div>
                  <div className="text-xs text-muted-foreground">{serviceCount} Mitarbeiter</div>
                </div>
              </label>
              <label className="flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer hover:bg-muted/50 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                <RadioGroupItem value="küche" id="dept-küche" />
                <div>
                  <div className="text-sm font-medium">Küche</div>
                  <div className="text-xs text-muted-foreground">{kücheCount} Mitarbeiter</div>
                </div>
              </label>
            </RadioGroup>
          </div>

          {/* ── Preview summary ──────────────────────────────────────────── */}
          <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground space-y-0.5">
            <div className="font-semibold text-foreground text-sm">{kwLabel(weekStart, weekEnd)}</div>
            <div>Report enthält: Wochenzusammenfassung, Abteilungsvergleich,</div>
            <div>Tagesübersicht, kritische Tage, Erkenntnisse & Empfehlungen.</div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Abbrechen
          </Button>
          <Button onClick={handleExport} disabled={loading} className="gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileBarChart2 className="h-4 w-4" />}
            PDF exportieren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
