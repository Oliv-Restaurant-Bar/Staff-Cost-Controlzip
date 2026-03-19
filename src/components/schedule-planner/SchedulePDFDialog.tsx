import { useState } from 'react';
import { format, addMonths, subMonths, startOfMonth } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { ChevronLeft, ChevronRight, FileText, Loader2, Users, CalendarDays } from 'lucide-react';
import { Employee } from '@/types/personnel';
import { DaySchedule } from '@/components/schedule-planner/ScheduleGrid';
import { exportScheduleToPDF } from '@/lib/schedule-export-import';
import { toast } from 'sonner';

interface SchedulePDFDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  currentMonth: Date;
  dailyBudgets?: Record<string, { plannedRevenue?: number; actualRevenue?: number }>;
  showCosts?: boolean;
}

type DeptOption = 'service' | 'küche' | 'all';

export function SchedulePDFDialog({
  open,
  onOpenChange,
  employees,
  scheduleData,
  currentMonth,
  dailyBudgets = {},
  showCosts = false,
}: SchedulePDFDialogProps) {
  const [selectedMonth, setSelectedMonth] = useState<Date>(startOfMonth(currentMonth));
  const [department, setDepartment] = useState<DeptOption>('all');
  const [includeWeeks, setIncludeWeeks] = useState(true);
  const [loading, setLoading] = useState(false);

  const serviceCount = employees.filter(e => e.department === 'service').length;
  const kücheCount = employees.filter(e => e.department === 'küche').length;

  const handleExport = async () => {
    setLoading(true);
    try {
      await exportScheduleToPDF({
        employees,
        scheduleData,
        currentMonth: selectedMonth,
        department,
        dailyBudgets,
        showCosts,
        includeWeeklyPages: includeWeeks,
      });
      toast.success('PDF erfolgreich exportiert');
      onOpenChange(false);
    } catch (err) {
      console.error(err);
      toast.error('Fehler beim PDF-Export');
    } finally {
      setLoading(false);
    }
  };

  const deptLabel: Record<DeptOption, string> = {
    service: 'Service',
    küche: 'Küche',
    all: 'Beide Abteilungen',
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-rose-600" />
            Dienstplan als PDF exportieren
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* Monat wählen */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">Zeitraum</Label>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => setSelectedMonth(m => subMonths(m, 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="flex-1 text-center text-sm font-medium">
                {format(selectedMonth, 'MMMM yyyy', { locale: de })}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => setSelectedMonth(m => addMonths(m, 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Abteilung wählen */}
          <div className="space-y-3">
            <Label className="text-sm font-semibold flex items-center gap-2">
              <Users className="h-4 w-4" />
              Abteilung
            </Label>
            <RadioGroup
              value={department}
              onValueChange={(v) => setDepartment(v as DeptOption)}
              className="space-y-2"
            >
              <div className="flex items-center justify-between rounded-lg border p-3 cursor-pointer hover:bg-muted/50" onClick={() => setDepartment('all')}>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="all" id="dept-all" />
                  <Label htmlFor="dept-all" className="cursor-pointer font-normal">Beide Abteilungen</Label>
                </div>
                <span className="text-xs text-muted-foreground">{serviceCount + kücheCount} MA</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3 cursor-pointer hover:bg-muted/50" onClick={() => setDepartment('service')}>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="service" id="dept-service" />
                  <Label htmlFor="dept-service" className="cursor-pointer font-normal">Service</Label>
                </div>
                <span className="text-xs text-muted-foreground">{serviceCount} MA</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3 cursor-pointer hover:bg-muted/50" onClick={() => setDepartment('küche')}>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="küche" id="dept-küche" />
                  <Label htmlFor="dept-küche" className="cursor-pointer font-normal">Küche</Label>
                </div>
                <span className="text-xs text-muted-foreground">{kücheCount} MA</span>
              </div>
            </RadioGroup>
          </div>

          {/* Wochenansichten */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold flex items-center gap-2">
              <CalendarDays className="h-4 w-4" />
              Inhalt
            </Label>
            <div
              className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer hover:bg-muted/50"
              onClick={() => setIncludeWeeks(v => !v)}
            >
              <Checkbox
                id="include-weeks"
                checked={includeWeeks}
                onCheckedChange={(v) => setIncludeWeeks(Boolean(v))}
                className="mt-0.5"
              />
              <div>
                <Label htmlFor="include-weeks" className="cursor-pointer font-normal">
                  Wochenansichten hinzufügen
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Nach der Monatsübersicht folgt pro Woche eine eigene Seite
                </p>
              </div>
            </div>
          </div>

          {/* Vorschau */}
          <div className="rounded-lg bg-muted/40 border border-dashed p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">PDF-Inhalt:</p>
            {department === 'all' ? (
              <>
                <p>• Seite 1: Monatsübersicht Service ({format(selectedMonth, 'MMMM yyyy', { locale: de })})</p>
                <p>• Seite 2: Monatsübersicht Küche ({format(selectedMonth, 'MMMM yyyy', { locale: de })})</p>
              </>
            ) : (
              <p>• Seite 1: Monatsübersicht {deptLabel[department]} ({format(selectedMonth, 'MMMM yyyy', { locale: de })})</p>
            )}
            {includeWeeks && (
              <p>• + je 1 Seite pro Woche × {department === 'all' ? '2 Abteilungen' : deptLabel[department]}</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button onClick={handleExport} disabled={loading} className="gap-2 bg-rose-600 hover:bg-rose-700">
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileText className="h-4 w-4" />
            )}
            PDF exportieren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
