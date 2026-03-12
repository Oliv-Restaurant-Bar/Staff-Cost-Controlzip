import { useMemo } from 'react';
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval, getWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, TimeEntry, DailyBudget } from '@/types/personnel';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { useWeekSync } from '@/hooks/useWeekSync';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { 
  Printer, FileText, TrendingUp, TrendingDown, Minus, 
  Euro, Clock, Users, Target, BarChart3, Calendar
} from 'lucide-react';
import { cn } from '@/lib/utils';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { toast } from '@/hooks/use-toast';

interface PrintableKPISummaryProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
}

export const PrintableKPISummary = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
}: PrintableKPISummaryProps) => {
  const { weekNumber, weekRange, monthLabel } = useWeekSync('PrintableKPISummary', selectedDate);

  // Calculate all KPIs
  const kpiData = useMemo(() => {
    const monthStart = startOfMonth(selectedDate);
    const monthEnd = endOfMonth(selectedDate);
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
    const today = format(selectedDate, 'yyyy-MM-dd');

    const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd }).map(d => format(d, 'yyyy-MM-dd'));
    const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd }).map(d => format(d, 'yyyy-MM-dd'));

    // Daily data
    const dayEntries = timeEntries.filter(e => e.date === today);
    const dayBudget = dailyBudgets[today];
    let dayPlannedHours = 0, dayActualHours = 0, dayPlannedCost = 0, dayActualCost = 0;
    dayEntries.forEach(entry => {
      const emp = employees.find(e => e.id === entry.employeeId);
      if (!emp) return;
      dayPlannedHours += entry.plannedHours || 0;
      dayActualHours += entry.actualHours || 0;
      dayPlannedCost += (entry.plannedHours || 0) * emp.hourlyWage;
      dayActualCost += (entry.actualHours || 0) * emp.hourlyWage;
    });

    // Weekly data
    const weekEntries = timeEntries.filter(e => weekDays.includes(e.date));
    let weekPlannedHours = 0, weekActualHours = 0, weekPlannedCost = 0, weekActualCost = 0;
    let weekPlannedRevenue = 0, weekActualRevenue = 0;
    weekDays.forEach(day => {
      const budget = dailyBudgets[day];
      if (budget) {
        weekPlannedRevenue += budget.plannedRevenue || 0;
        weekActualRevenue += budget.actualRevenue || 0;
      }
    });
    weekEntries.forEach(entry => {
      const emp = employees.find(e => e.id === entry.employeeId);
      if (!emp) return;
      weekPlannedHours += entry.plannedHours || 0;
      weekActualHours += entry.actualHours || 0;
      weekPlannedCost += (entry.plannedHours || 0) * emp.hourlyWage;
      weekActualCost += (entry.actualHours || 0) * emp.hourlyWage;
    });

    // Monthly data
    const monthEntries = timeEntries.filter(e => monthDays.includes(e.date));
    let monthPlannedHours = 0, monthActualHours = 0, monthPlannedCost = 0, monthActualCost = 0;
    let monthPlannedRevenue = 0, monthActualRevenue = 0;
    monthDays.forEach(day => {
      const budget = dailyBudgets[day];
      if (budget) {
        monthPlannedRevenue += budget.plannedRevenue || 0;
        monthActualRevenue += budget.actualRevenue || 0;
      }
    });
    monthEntries.forEach(entry => {
      const emp = employees.find(e => e.id === entry.employeeId);
      if (!emp) return;
      monthPlannedHours += entry.plannedHours || 0;
      monthActualHours += entry.actualHours || 0;
      monthPlannedCost += (entry.plannedHours || 0) * emp.hourlyWage;
      monthActualCost += (entry.actualHours || 0) * emp.hourlyWage;
    });

    // Department breakdown
    const serviceEmployees = employees.filter(e => e.department === 'service');
    const kücheEmployees = employees.filter(e => e.department === 'küche');
    
    const getDeptCosts = (deptEmployees: Employee[], entries: TimeEntry[]) => {
      let planned = 0, actual = 0;
      entries.forEach(entry => {
        const emp = deptEmployees.find(e => e.id === entry.employeeId);
        if (!emp) return;
        planned += (entry.plannedHours || 0) * emp.hourlyWage;
        actual += (entry.actualHours || 0) * emp.hourlyWage;
      });
      return { planned, actual };
    };

    const serviceCosts = getDeptCosts(serviceEmployees, monthEntries);
    const kücheCosts = getDeptCosts(kücheEmployees, monthEntries);

    // Calculate quotes
    const dayQuote = (dayBudget?.actualRevenue || 0) > 0 ? (dayActualCost / dayBudget.actualRevenue) * 100 : 0;
    const weekQuote = weekActualRevenue > 0 ? (weekActualCost / weekActualRevenue) * 100 : 0;
    const monthQuote = monthActualRevenue > 0 ? (monthActualCost / monthActualRevenue) * 100 : 0;

    return {
      day: {
        label: format(selectedDate, 'EEEE, d. MMM', { locale: de }),
        plannedHours: dayPlannedHours,
        actualHours: dayActualHours,
        plannedCost: dayPlannedCost,
        actualCost: dayActualCost,
        plannedRevenue: dayBudget?.plannedRevenue || 0,
        actualRevenue: dayBudget?.actualRevenue || 0,
        quote: dayQuote,
      },
      week: {
        label: `KW ${weekNumber}`,
        plannedHours: weekPlannedHours,
        actualHours: weekActualHours,
        plannedCost: weekPlannedCost,
        actualCost: weekActualCost,
        plannedRevenue: weekPlannedRevenue,
        actualRevenue: weekActualRevenue,
        quote: weekQuote,
      },
      month: {
        label: monthLabel,
        plannedHours: monthPlannedHours,
        actualHours: monthActualHours,
        plannedCost: monthPlannedCost,
        actualCost: monthActualCost,
        plannedRevenue: monthPlannedRevenue,
        actualRevenue: monthActualRevenue,
        quote: monthQuote,
      },
      departments: {
        service: serviceCosts,
        küche: kücheCosts,
      },
      employeeCount: employees.length,
      serviceCount: serviceEmployees.length,
      kücheCount: kücheEmployees.length,
    };
  }, [employees, timeEntries, dailyBudgets, selectedDate, weekNumber, monthLabel]);

  const getQuoteStatus = (quote: number) => {
    if (quote === 0) return { color: 'text-muted-foreground', bg: 'bg-muted/30', status: 'Keine Daten' };
    if (quote <= 25) return { color: 'text-green-600', bg: 'bg-green-500/10', status: 'Excellent' };
    if (quote <= 30) return { color: 'text-green-600', bg: 'bg-green-500/10', status: 'Gut' };
    if (quote <= 35) return { color: 'text-amber-500', bg: 'bg-amber-500/10', status: 'Warnung' };
    return { color: 'text-destructive', bg: 'bg-destructive/10', status: 'Kritisch' };
  };

  const getVarianceIcon = (value: number) => {
    if (value > 0) return <TrendingUp className="h-3 w-3" />;
    if (value < 0) return <TrendingDown className="h-3 w-3" />;
    return <Minus className="h-3 w-3" />;
  };

  const handlePrint = () => {
    window.print();
  };

  const exportToPDF = () => {
    const doc = new jsPDF();
    const now = format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de });
    
    // Title
    doc.setFontSize(18);
    doc.text('KPI Zusammenfassung', 14, 20);
    doc.setFontSize(10);
    doc.setTextColor(128);
    doc.text(`Erstellt am ${now}`, 14, 27);
    doc.setTextColor(0);

    // Overview table
    const overviewData = [
      ['Zeitraum', 'Umsatz (Plan)', 'Umsatz (Ist)', 'Kosten (Plan)', 'Kosten (Ist)', 'PKQ'],
      [
        kpiData.day.label,
        formatCurrency(kpiData.day.plannedRevenue),
        formatCurrency(kpiData.day.actualRevenue),
        formatCurrency(kpiData.day.plannedCost),
        formatCurrency(kpiData.day.actualCost),
        `${kpiData.day.quote.toFixed(1)}%`,
      ],
      [
        kpiData.week.label,
        formatCurrency(kpiData.week.plannedRevenue),
        formatCurrency(kpiData.week.actualRevenue),
        formatCurrency(kpiData.week.plannedCost),
        formatCurrency(kpiData.week.actualCost),
        `${kpiData.week.quote.toFixed(1)}%`,
      ],
      [
        kpiData.month.label,
        formatCurrency(kpiData.month.plannedRevenue),
        formatCurrency(kpiData.month.actualRevenue),
        formatCurrency(kpiData.month.plannedCost),
        formatCurrency(kpiData.month.actualCost),
        `${kpiData.month.quote.toFixed(1)}%`,
      ],
    ];

    autoTable(doc, {
      startY: 35,
      head: [overviewData[0]],
      body: overviewData.slice(1),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [59, 130, 246] },
    });

    // Hours table
    doc.setFontSize(12);
    doc.text('Arbeitsstunden', 14, (doc as any).lastAutoTable.finalY + 15);

    const hoursData = [
      ['Zeitraum', 'Soll-Stunden', 'Plan-Stunden', 'Ist-Stunden', 'Differenz'],
      [
        kpiData.day.label,
        '-',
        formatHours(kpiData.day.plannedHours),
        formatHours(kpiData.day.actualHours),
        formatHours(kpiData.day.actualHours - kpiData.day.plannedHours),
      ],
      [
        kpiData.week.label,
        '-',
        formatHours(kpiData.week.plannedHours),
        formatHours(kpiData.week.actualHours),
        formatHours(kpiData.week.actualHours - kpiData.week.plannedHours),
      ],
      [
        kpiData.month.label,
        '-',
        formatHours(kpiData.month.plannedHours),
        formatHours(kpiData.month.actualHours),
        formatHours(kpiData.month.actualHours - kpiData.month.plannedHours),
      ],
    ];

    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 20,
      head: [hoursData[0]],
      body: hoursData.slice(1),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [34, 197, 94] },
    });

    // Department breakdown
    doc.setFontSize(12);
    doc.text('Abteilungskosten (Monat)', 14, (doc as any).lastAutoTable.finalY + 15);

    const deptData = [
      ['Abteilung', 'Mitarbeiter', 'Plan-Kosten', 'Ist-Kosten', 'Differenz'],
      [
        'Service',
        kpiData.serviceCount.toString(),
        formatCurrency(kpiData.departments.service.planned),
        formatCurrency(kpiData.departments.service.actual),
        formatCurrency(kpiData.departments.service.actual - kpiData.departments.service.planned),
      ],
      [
        'Küche',
        kpiData.kücheCount.toString(),
        formatCurrency(kpiData.departments.küche.planned),
        formatCurrency(kpiData.departments.küche.actual),
        formatCurrency(kpiData.departments.küche.actual - kpiData.departments.küche.planned),
      ],
      [
        'Gesamt',
        kpiData.employeeCount.toString(),
        formatCurrency(kpiData.departments.service.planned + kpiData.departments.küche.planned),
        formatCurrency(kpiData.departments.service.actual + kpiData.departments.küche.actual),
        formatCurrency((kpiData.departments.service.actual + kpiData.departments.küche.actual) - (kpiData.departments.service.planned + kpiData.departments.küche.planned)),
      ],
    ];

    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 20,
      head: [deptData[0]],
      body: deptData.slice(1),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [168, 85, 247] },
    });

    // Status summary
    doc.setFontSize(12);
    doc.text('Status-Bewertung', 14, (doc as any).lastAutoTable.finalY + 15);
    
    const dayStatus = getQuoteStatus(kpiData.day.quote);
    const weekStatus = getQuoteStatus(kpiData.week.quote);
    const monthStatus = getQuoteStatus(kpiData.month.quote);

    const statusData = [
      [kpiData.day.label, `${kpiData.day.quote.toFixed(1)}%`, dayStatus.status],
      [kpiData.week.label, `${kpiData.week.quote.toFixed(1)}%`, weekStatus.status],
      [kpiData.month.label, `${kpiData.month.quote.toFixed(1)}%`, monthStatus.status],
    ];

    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 20,
      head: [['Zeitraum', 'PKQ', 'Status']],
      body: statusData,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [251, 146, 60] },
    });

    // Footer
    doc.setFontSize(8);
    doc.setTextColor(128);
    doc.text('PKQ = Personalkostenquote (Personalkosten / Umsatz × 100)', 14, doc.internal.pageSize.height - 10);

    doc.save(`KPI_Zusammenfassung_${format(selectedDate, 'yyyy-MM-dd')}.pdf`);
    toast({ title: 'PDF exportiert', description: 'KPI-Zusammenfassung als PDF gespeichert' });
  };

  const KPIBlock = ({ 
    title, 
    data, 
    icon: Icon 
  }: { 
    title: string; 
    data: typeof kpiData.day; 
    icon: typeof Calendar;
  }) => {
    const quoteStatus = getQuoteStatus(data.quote);
    
    return (
      <div className="space-y-3 p-4 border rounded-lg print:break-inside-avoid">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <h4 className="font-semibold">{title}</h4>
          </div>
          <Badge variant="outline" className={cn("text-xs", quoteStatus.color)}>
            {quoteStatus.status}
          </Badge>
        </div>
        
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Umsatz</p>
            <p className="font-mono font-medium">{formatCurrency(data.actualRevenue)}</p>
            <p className="text-xs text-muted-foreground">Plan: {formatCurrency(data.plannedRevenue)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Personalkosten</p>
            <p className="font-mono font-medium">{formatCurrency(data.actualCost)}</p>
            <p className="text-xs text-muted-foreground">Plan: {formatCurrency(data.plannedCost)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Arbeitsstunden</p>
            <p className="font-mono font-medium">{formatHours(data.actualHours)}</p>
            <p className="text-xs text-muted-foreground">Plan: {formatHours(data.plannedHours)}</p>
          </div>
          <div className={cn("p-2 rounded", quoteStatus.bg)}>
            <p className="text-muted-foreground text-xs">PKQ</p>
            <p className={cn("font-mono font-bold text-lg", quoteStatus.color)}>
              {data.quote.toFixed(1)}%
            </p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <Card className="stat-card print:shadow-none print:border-0">
      <CardHeader className="pb-3 print:pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <BarChart3 className="h-5 w-5" />
            KPI Zusammenfassung
          </CardTitle>
          <div className="flex items-center gap-1 print:hidden">
            <Button variant="outline" size="sm" className="h-8 gap-1" onClick={handlePrint}>
              <Printer className="h-4 w-4" />
              <span className="hidden sm:inline">Drucken</span>
            </Button>
            <Button variant="outline" size="sm" className="h-8 gap-1" onClick={exportToPDF}>
              <FileText className="h-4 w-4" />
              <span className="hidden sm:inline">PDF</span>
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground print:text-xs">
          Stand: {format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}
        </p>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Time Period KPIs */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <KPIBlock title={kpiData.day.label} data={kpiData.day} icon={Calendar} />
          <KPIBlock title={kpiData.week.label} data={kpiData.week} icon={Calendar} />
          <KPIBlock title={kpiData.month.label} data={kpiData.month} icon={Calendar} />
        </div>

        <Separator className="print:hidden" />

        {/* Department Breakdown */}
        <div className="space-y-3 print:break-inside-avoid">
          <h4 className="font-semibold flex items-center gap-2">
            <Users className="h-4 w-4" />
            Abteilungsübersicht (Monat)
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 border rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium">Service</span>
                <Badge variant="secondary">{kpiData.serviceCount} MA</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">Plan-Kosten</p>
                  <p className="font-mono">{formatCurrency(kpiData.departments.service.planned)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Ist-Kosten</p>
                  <p className="font-mono">{formatCurrency(kpiData.departments.service.actual)}</p>
                </div>
              </div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium">Küche</span>
                <Badge variant="secondary">{kpiData.kücheCount} MA</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">Plan-Kosten</p>
                  <p className="font-mono">{formatCurrency(kpiData.departments.küche.planned)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Ist-Kosten</p>
                  <p className="font-mono">{formatCurrency(kpiData.departments.küche.actual)}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <Separator className="print:hidden" />

        {/* Quick Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center print:break-inside-avoid">
          <div className="p-3 bg-muted/30 rounded-lg">
            <p className="text-xs text-muted-foreground">Mitarbeiter</p>
            <p className="text-2xl font-bold">{kpiData.employeeCount}</p>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg">
            <p className="text-xs text-muted-foreground">Monatsumsatz</p>
            <p className="text-lg font-bold">{formatCurrency(kpiData.month.actualRevenue)}</p>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg">
            <p className="text-xs text-muted-foreground">Monatskosten</p>
            <p className="text-lg font-bold">{formatCurrency(kpiData.month.actualCost)}</p>
          </div>
          <div className={cn("p-3 rounded-lg", getQuoteStatus(kpiData.month.quote).bg)}>
            <p className="text-xs text-muted-foreground">Monats-PKQ</p>
            <p className={cn("text-2xl font-bold", getQuoteStatus(kpiData.month.quote).color)}>
              {kpiData.month.quote.toFixed(1)}%
            </p>
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground pt-2 print:pt-4">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-green-500" /> ≤30% Gut
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-500" /> 30-35% Warnung
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-destructive" /> &gt;35% Kritisch
          </span>
          <span className="ml-auto">PKQ = Personalkostenquote</span>
        </div>
      </CardContent>
    </Card>
  );
};
