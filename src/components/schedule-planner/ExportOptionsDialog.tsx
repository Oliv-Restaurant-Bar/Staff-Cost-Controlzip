import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Calendar, CalendarDays, CalendarRange, FileSpreadsheet, FileText, Clock, Euro, ClipboardList, CheckSquare, Users } from 'lucide-react';
import { format, eachDayOfInterval, startOfMonth, endOfMonth } from 'date-fns';
import { de } from 'date-fns/locale';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';

export type ExportRange = 'month' | 'week' | 'custom';
export type ExportHoursType = 'plan' | 'ist' | 'both';
export type ExportFormat = 'excel' | 'pdf';
export type ExportDepartment = 'service' | 'küche' | 'all';
export type ExportType = 'aushang' | 'leitungsplan';

export interface ExportOptions {
  range: ExportRange;
  customStartDate?: Date;
  customEndDate?: Date;
  hoursType: ExportHoursType;
  includeCosts: boolean;
  format: ExportFormat;
  department: ExportDepartment;
  exportType: ExportType;
}

interface ExportOptionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentMonth: Date;
  currentWeekStart: Date;
  currentWeekEnd: Date;
  onExport: (options: ExportOptions) => void;
  initialFormat?: ExportFormat;
}

export const ExportOptionsDialog = ({
  open,
  onOpenChange,
  currentMonth,
  currentWeekStart,
  currentWeekEnd,
  onExport,
  initialFormat = 'excel',
}: ExportOptionsDialogProps) => {
  const [selectedRange, setSelectedRange] = useState<ExportRange>('month');
  const [customStartDate, setCustomStartDate] = useState<Date | undefined>(startOfMonth(currentMonth));
  const [customEndDate, setCustomEndDate] = useState<Date | undefined>(endOfMonth(currentMonth));
  const [hoursType, setHoursType] = useState<ExportHoursType>('both');
  const [includeCosts, setIncludeCosts] = useState(true);
  const [exportFormat, setExportFormat] = useState<ExportFormat>(initialFormat);
  const [department, setDepartment] = useState<ExportDepartment>('all');
  const [exportType, setExportType] = useState<ExportType>('aushang');

  const handleExport = () => {
    const options: ExportOptions = {
      range: selectedRange,
      customStartDate,
      customEndDate,
      hoursType,
      includeCosts: exportType === 'leitungsplan' ? includeCosts : false,
      format: exportFormat,
      department,
      exportType,
    };
    onExport(options);
    onOpenChange(false);
  };

  const isCustomValid = selectedRange !== 'custom' || (customStartDate && customEndDate && customStartDate <= customEndDate);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Dienstplan exportieren</DialogTitle>
          <DialogDescription>
            Format, Zeitraum und weitere Optionen konfigurieren
          </DialogDescription>
        </DialogHeader>

        {/* Format Section */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Exportformat</Label>
          <div className="grid grid-cols-2 gap-2">
            <div
              className={cn(
                "flex flex-col items-center p-3 rounded-lg border cursor-pointer transition-colors",
                exportFormat === 'excel' ? "border-primary bg-primary/5" : "hover:bg-accent"
              )}
              onClick={() => setExportFormat('excel')}
            >
              <FileSpreadsheet className={cn("h-6 w-6 mb-1", exportFormat === 'excel' ? "text-primary" : "text-muted-foreground")} />
              <span className="text-sm font-medium">Excel</span>
              <span className="text-xs text-muted-foreground">Zum Bearbeiten</span>
            </div>
            <div
              className={cn(
                "flex flex-col items-center p-3 rounded-lg border cursor-pointer transition-colors",
                exportFormat === 'pdf' ? "border-primary bg-primary/5" : "hover:bg-accent"
              )}
              onClick={() => setExportFormat('pdf')}
            >
              <FileText className={cn("h-6 w-6 mb-1", exportFormat === 'pdf' ? "text-primary" : "text-muted-foreground")} />
              <span className="text-sm font-medium">PDF</span>
              <span className="text-xs text-muted-foreground">Zum Drucken</span>
            </div>
          </div>
        </div>

        <Separator />

        {/* Time Range Section */}
        <div className="space-y-3">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Zeitraum
          </Label>
          <RadioGroup
            value={selectedRange}
            onValueChange={(value) => setSelectedRange(value as ExportRange)}
            className="space-y-2"
          >
            <div
              className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-accent cursor-pointer"
              onClick={() => setSelectedRange('month')}
            >
              <RadioGroupItem value="month" id="month" />
              <Label htmlFor="month" className="flex items-center gap-3 cursor-pointer flex-1">
                <Calendar className="h-4 w-4 text-primary" />
                <div>
                  <p className="font-medium text-sm">Ganzer Monat</p>
                  <p className="text-xs text-muted-foreground">
                    {format(currentMonth, 'MMMM yyyy', { locale: de })}
                  </p>
                </div>
              </Label>
            </div>

            <div
              className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-accent cursor-pointer"
              onClick={() => setSelectedRange('week')}
            >
              <RadioGroupItem value="week" id="week" />
              <Label htmlFor="week" className="flex items-center gap-3 cursor-pointer flex-1">
                <CalendarDays className="h-4 w-4 text-primary" />
                <div>
                  <p className="font-medium text-sm">Aktuelle Woche</p>
                  <p className="text-xs text-muted-foreground">
                    {format(currentWeekStart, 'dd.MM.', { locale: de })} - {format(currentWeekEnd, 'dd.MM.yyyy', { locale: de })}
                  </p>
                </div>
              </Label>
            </div>

            <div
              className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-accent cursor-pointer"
              onClick={() => setSelectedRange('custom')}
            >
              <RadioGroupItem value="custom" id="custom" />
              <Label htmlFor="custom" className="flex items-center gap-3 cursor-pointer flex-1">
                <CalendarRange className="h-4 w-4 text-primary" />
                <div>
                  <p className="font-medium text-sm">Benutzerdefiniert</p>
                  <p className="text-xs text-muted-foreground">
                    Eigenen Zeitraum wählen
                  </p>
                </div>
              </Label>
            </div>
          </RadioGroup>

          {selectedRange === 'custom' && (
            <div className="space-y-3 pl-6">
              <div className="flex gap-3">
                <div className="flex-1">
                  <Label className="text-xs text-muted-foreground mb-1 block">Von</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !customStartDate && "text-muted-foreground"
                        )}
                      >
                        <Calendar className="mr-2 h-3 w-3" />
                        {customStartDate ? format(customStartDate, 'dd.MM.yyyy', { locale: de }) : 'Startdatum'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <CalendarComponent
                        mode="single"
                        selected={customStartDate}
                        onSelect={setCustomStartDate}
                        initialFocus
                        className="pointer-events-auto"
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="flex-1">
                  <Label className="text-xs text-muted-foreground mb-1 block">Bis</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !customEndDate && "text-muted-foreground"
                        )}
                      >
                        <Calendar className="mr-2 h-3 w-3" />
                        {customEndDate ? format(customEndDate, 'dd.MM.yyyy', { locale: de }) : 'Enddatum'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <CalendarComponent
                        mode="single"
                        selected={customEndDate}
                        onSelect={setCustomEndDate}
                        initialFocus
                        className="pointer-events-auto"
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
              {customStartDate && customEndDate && customStartDate <= customEndDate && (
                <p className="text-xs text-muted-foreground">
                  {eachDayOfInterval({ start: customStartDate, end: customEndDate }).length} Tage ausgewählt
                </p>
              )}
              {customStartDate && customEndDate && customStartDate > customEndDate && (
                <p className="text-xs text-destructive">
                  Startdatum muss vor dem Enddatum liegen
                </p>
              )}
            </div>
          )}
        </div>

        <Separator />

        {/* Department Section */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Users className="h-4 w-4" />
            Abteilung
          </Label>
          <div className="grid grid-cols-3 gap-2">
            {([
              { value: 'all', label: 'Beide' },
              { value: 'service', label: 'Service' },
              { value: 'küche', label: 'Küche' },
            ] as { value: ExportDepartment; label: string }[]).map(opt => (
              <div
                key={opt.value}
                className={cn(
                  "flex flex-col items-center p-2 rounded-lg border cursor-pointer transition-colors",
                  department === opt.value ? "border-primary bg-primary/5" : "hover:bg-accent"
                )}
                onClick={() => setDepartment(opt.value)}
              >
                <span className={cn("text-sm font-medium", department === opt.value ? "text-primary" : "")}>{opt.label}</span>
              </div>
            ))}
          </div>
        </div>

        <Separator />

        {/* Hours Type Section — nur für Excel relevant */}
        {exportFormat === 'excel' && (
          <>
            <div className="space-y-3">
              <Label className="text-sm font-medium flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Stundentyp
              </Label>
              <RadioGroup
                value={hoursType}
                onValueChange={(value) => setHoursType(value as ExportHoursType)}
                className="grid grid-cols-3 gap-2"
              >
                <div
                  className={cn(
                    "flex flex-col items-center p-3 rounded-lg border cursor-pointer transition-colors",
                    hoursType === 'plan' ? "border-primary bg-primary/5" : "hover:bg-accent"
                  )}
                  onClick={() => setHoursType('plan')}
                >
                  <RadioGroupItem value="plan" id="plan" className="sr-only" />
                  <ClipboardList className={cn("h-5 w-5 mb-1", hoursType === 'plan' ? "text-primary" : "text-muted-foreground")} />
                  <Label htmlFor="plan" className="text-xs font-medium cursor-pointer">
                    Nur Plan
                  </Label>
                </div>

                <div
                  className={cn(
                    "flex flex-col items-center p-3 rounded-lg border cursor-pointer transition-colors",
                    hoursType === 'ist' ? "border-primary bg-primary/5" : "hover:bg-accent"
                  )}
                  onClick={() => setHoursType('ist')}
                >
                  <RadioGroupItem value="ist" id="ist" className="sr-only" />
                  <CheckSquare className={cn("h-5 w-5 mb-1", hoursType === 'ist' ? "text-primary" : "text-muted-foreground")} />
                  <Label htmlFor="ist" className="text-xs font-medium cursor-pointer">
                    Nur Ist
                  </Label>
                </div>

                <div
                  className={cn(
                    "flex flex-col items-center p-3 rounded-lg border cursor-pointer transition-colors",
                    hoursType === 'both' ? "border-primary bg-primary/5" : "hover:bg-accent"
                  )}
                  onClick={() => setHoursType('both')}
                >
                  <RadioGroupItem value="both" id="both" className="sr-only" />
                  <div className="flex gap-0.5 mb-1">
                    <ClipboardList className={cn("h-4 w-4", hoursType === 'both' ? "text-primary" : "text-muted-foreground")} />
                    <CheckSquare className={cn("h-4 w-4", hoursType === 'both' ? "text-primary" : "text-muted-foreground")} />
                  </div>
                  <Label htmlFor="both" className="text-xs font-medium cursor-pointer">
                    Beides
                  </Label>
                </div>
              </RadioGroup>
            </div>
            <Separator />
          </>
        )}

        {/* PDF Export Type — Aushang vs Leitungsplan */}
        {exportFormat === 'pdf' && (
          <>
            <div className="space-y-2">
              <Label className="text-sm font-medium">PDF-Typ</Label>
              <div className="grid grid-cols-2 gap-2">
                <div
                  className={cn(
                    "flex flex-col items-center p-3 rounded-lg border cursor-pointer transition-colors",
                    exportType === 'aushang' ? "border-primary bg-primary/5" : "hover:bg-accent"
                  )}
                  onClick={() => setExportType('aushang')}
                >
                  <Users className={cn("h-5 w-5 mb-1", exportType === 'aushang' ? "text-primary" : "text-muted-foreground")} />
                  <span className={cn("text-sm font-medium", exportType === 'aushang' ? "text-primary" : "")}>Aushang</span>
                  <span className="text-xs text-muted-foreground text-center">Teamplan zum Aushängen</span>
                </div>
                <div
                  className={cn(
                    "flex flex-col items-center p-3 rounded-lg border cursor-pointer transition-colors",
                    exportType === 'leitungsplan' ? "border-primary bg-primary/5" : "hover:bg-accent"
                  )}
                  onClick={() => setExportType('leitungsplan')}
                >
                  <ClipboardList className={cn("h-5 w-5 mb-1", exportType === 'leitungsplan' ? "text-primary" : "text-muted-foreground")} />
                  <span className={cn("text-sm font-medium", exportType === 'leitungsplan' ? "text-primary" : "")}>Leitungsplan</span>
                  <span className="text-xs text-muted-foreground text-center">Mit Std/Soll/+/− intern</span>
                </div>
              </div>
            </div>
            <Separator />
          </>
        )}

        {/* Costs Option — only meaningful for Excel or Leitungsplan */}
        {(exportFormat === 'excel' || exportType === 'leitungsplan') && (
          <div className="flex items-center justify-between p-3 rounded-lg border">
            <div className="flex items-center gap-3">
              <Euro className="h-5 w-5 text-muted-foreground" />
              <div>
                <Label htmlFor="includeCosts" className="font-medium text-sm cursor-pointer">
                  Kosten inkludieren
                </Label>
                <p className="text-xs text-muted-foreground">
                  Personalkosten pro Mitarbeiter und Tag
                </p>
              </div>
            </div>
            <Checkbox
              id="includeCosts"
              checked={includeCosts}
              onCheckedChange={(checked) => setIncludeCosts(checked === true)}
            />
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button onClick={handleExport} disabled={!isCustomValid}>
            {exportFormat === 'excel' ? (
              <FileSpreadsheet className="h-4 w-4 mr-2" />
            ) : (
              <FileText className="h-4 w-4 mr-2" />
            )}
            {exportFormat === 'excel' ? 'Excel exportieren' : 'PDF exportieren'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
