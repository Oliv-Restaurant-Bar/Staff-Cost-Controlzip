import { useMemo } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, startOfWeek, endOfWeek, eachWeekOfInterval } from 'date-fns';
import { de } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Employee } from '@/types/personnel';
import { DaySchedule, TimeSlot } from './ScheduleGrid';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';
import { Euro, TrendingUp, TrendingDown, Users, Clock, Download, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

interface MonthlyCostSummaryProps {
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  dailyBudgets: Record<string, { plannedRevenue?: number; actualRevenue?: number }>;
  currentMonth: Date;
  showCosts: boolean;
}

// Calculate hours from a time slot
const calculateSlotHours = (slot: TimeSlot | null | undefined): number => {
  if (!slot?.start || !slot?.end) return 0;
  const [startH, startM] = slot.start.split(':').map(Number);
  const [endH, endM] = slot.end.split(':').map(Number);
  let hours = endH - startH + (endM - startM) / 60;
  if (hours < 0) hours += 24;
  return Math.round(hours * 100) / 100;
};

export const MonthlyCostSummary = ({
  employees,
  scheduleData,
  dailyBudgets,
  currentMonth,
  showCosts,
}: MonthlyCostSummaryProps) => {
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const weeksInMonth = eachWeekOfInterval({ start: monthStart, end: monthEnd }, { weekStartsOn: 1 });

  // Load threshold from settings
  const laborCostThreshold = parseFloat(localStorage.getItem('labor_cost_threshold') || '40');

  const serviceEmployees = employees.filter(e => e.department === 'service');
  const kitchenEmployees = employees.filter(e => e.department === 'küche');

  const calculateDepartmentStats = (deptEmployees: Employee[]) => {
    let totalHours = 0;
    let totalCosts = 0;

    daysInMonth.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      
      deptEmployees.forEach(emp => {
        const cellKey = `${emp.id}-${dateStr}`;
        const daySchedule = scheduleData[cellKey];
        
        if (daySchedule) {
          const frühHours = calculateSlotHours(daySchedule.früh);
          const spätHours = calculateSlotHours(daySchedule.spät);
          const dayHours = frühHours + spätHours;
          const breakDeduction = calculateBreakDeduction(dayHours);
          const netHours = dayHours - breakDeduction;
          
          totalHours += netHours;
          if (emp.hourlyWage) {
            totalCosts += netHours * emp.hourlyWage;
          }
        }
      });
    });

    return { totalHours, totalCosts };
  };

  const serviceStats = useMemo(() => calculateDepartmentStats(serviceEmployees), [serviceEmployees, scheduleData, daysInMonth]);
  const kitchenStats = useMemo(() => calculateDepartmentStats(kitchenEmployees), [kitchenEmployees, scheduleData, daysInMonth]);
  const totalStats = {
    totalHours: serviceStats.totalHours + kitchenStats.totalHours,
    totalCosts: serviceStats.totalCosts + kitchenStats.totalCosts,
  };

  // Calculate monthly revenue
  const monthlyRevenue = useMemo(() => {
    return daysInMonth.reduce((sum, day) => {
      const dateStr = format(day, 'yyyy-MM-dd');
      return sum + (dailyBudgets[dateStr]?.plannedRevenue || 0);
    }, 0);
  }, [daysInMonth, dailyBudgets]);

  const laborCostPercentage = monthlyRevenue > 0 ? (totalStats.totalCosts / monthlyRevenue) * 100 : 0;
  const isOverBudget = laborCostPercentage > laborCostThreshold;

  // Calculate weekly breakdown
  const weeklyBreakdown = useMemo(() => {
    return weeksInMonth.map(weekStart => {
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
      const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd }).filter(
        d => d >= monthStart && d <= monthEnd
      );

      let weekHours = 0;
      let weekCosts = 0;
      let weekRevenue = 0;

      weekDays.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        weekRevenue += dailyBudgets[dateStr]?.plannedRevenue || 0;

        employees.forEach(emp => {
          const cellKey = `${emp.id}-${dateStr}`;
          const daySchedule = scheduleData[cellKey];
          
          if (daySchedule) {
            const frühHours = calculateSlotHours(daySchedule.früh);
            const spätHours = calculateSlotHours(daySchedule.spät);
            const dayHours = frühHours + spätHours;
            const breakDeduction = calculateBreakDeduction(dayHours);
            const netHours = dayHours - breakDeduction;
            
            weekHours += netHours;
            if (emp.hourlyWage) {
              weekCosts += netHours * emp.hourlyWage;
            }
          }
        });
      });

      const weekPercentage = weekRevenue > 0 ? (weekCosts / weekRevenue) * 100 : 0;

      return {
        weekNumber: format(weekStart, 'w'),
        startDate: format(weekStart, 'd.MM.'),
        endDate: format(weekEnd, 'd.MM.'),
        hours: weekHours,
        costs: weekCosts,
        revenue: weekRevenue,
        percentage: weekPercentage,
        isOver: weekPercentage > laborCostThreshold,
      };
    });
  }, [weeksInMonth, employees, scheduleData, dailyBudgets, monthStart, monthEnd, laborCostThreshold]);

  // Export PDF
  const exportToPDF = () => {
    const doc = new jsPDF();
    const monthName = format(currentMonth, 'MMMM yyyy', { locale: de });

    // Title
    doc.setFontSize(18);
    doc.text(`Personalkostenanalyse - ${monthName}`, 14, 20);

    // Summary
    doc.setFontSize(12);
    doc.text('Monatliche Zusammenfassung', 14, 35);

    autoTable(doc, {
      startY: 40,
      head: [['Kennzahl', 'Wert']],
      body: [
        ['Gesamtstunden', `${totalStats.totalHours.toFixed(1)} h`],
        ['Gesamtpersonalkosten', `CHF ${totalStats.totalCosts.toFixed(2)}`],
        ['Geplanter Umsatz', `CHF ${monthlyRevenue.toFixed(2)}`],
        ['Personalkostenquote', `${laborCostPercentage.toFixed(1)}%`],
        ['Schwellenwert', `${laborCostThreshold}%`],
        ['Status', isOverBudget ? 'ÜBER BUDGET' : 'Im Budget'],
      ],
      theme: 'striped',
    });

    // Department breakdown
    const finalY1 = (doc as any).lastAutoTable.finalY + 10;
    doc.text('Abteilungsübersicht', 14, finalY1);

    autoTable(doc, {
      startY: finalY1 + 5,
      head: [['Abteilung', 'Mitarbeiter', 'Stunden', 'Kosten']],
      body: [
        ['Service', serviceEmployees.length.toString(), `${serviceStats.totalHours.toFixed(1)} h`, `CHF ${serviceStats.totalCosts.toFixed(2)}`],
        ['Küche', kitchenEmployees.length.toString(), `${kitchenStats.totalHours.toFixed(1)} h`, `CHF ${kitchenStats.totalCosts.toFixed(2)}`],
        ['Gesamt', employees.length.toString(), `${totalStats.totalHours.toFixed(1)} h`, `CHF ${totalStats.totalCosts.toFixed(2)}`],
      ],
      theme: 'striped',
    });

    // Weekly breakdown
    const finalY2 = (doc as any).lastAutoTable.finalY + 10;
    doc.text('Wochenübersicht', 14, finalY2);

    autoTable(doc, {
      startY: finalY2 + 5,
      head: [['KW', 'Zeitraum', 'Stunden', 'Kosten', 'Umsatz', 'Quote']],
      body: weeklyBreakdown.map(week => [
        `KW ${week.weekNumber}`,
        `${week.startDate} - ${week.endDate}`,
        `${week.hours.toFixed(1)} h`,
        `CHF ${week.costs.toFixed(2)}`,
        `CHF ${week.revenue.toFixed(2)}`,
        `${week.percentage.toFixed(1)}%`,
      ]),
      theme: 'striped',
    });

    // Daily breakdown
    const finalY3 = (doc as any).lastAutoTable.finalY + 10;
    doc.addPage();
    doc.text('Tagesübersicht', 14, 20);

    const dailyData = daysInMonth.map(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      let dayHours = 0;
      let dayCosts = 0;

      employees.forEach(emp => {
        const cellKey = `${emp.id}-${dateStr}`;
        const daySchedule = scheduleData[cellKey];
        
        if (daySchedule) {
          const frühHours = calculateSlotHours(daySchedule.früh);
          const spätHours = calculateSlotHours(daySchedule.spät);
          const gross = frühHours + spätHours;
          const net = gross - calculateBreakDeduction(gross);
          
          dayHours += net;
          if (emp.hourlyWage) {
            dayCosts += net * emp.hourlyWage;
          }
        }
      });

      const dayRevenue = dailyBudgets[dateStr]?.plannedRevenue || 0;
      const dayPercentage = dayRevenue > 0 ? (dayCosts / dayRevenue) * 100 : 0;

      return [
        format(day, 'EEE d.MM.', { locale: de }),
        `${dayHours.toFixed(1)} h`,
        `CHF ${dayCosts.toFixed(0)}`,
        `CHF ${dayRevenue.toFixed(0)}`,
        `${dayPercentage.toFixed(0)}%`,
      ];
    });

    autoTable(doc, {
      startY: 25,
      head: [['Tag', 'Stunden', 'Kosten', 'Umsatz', 'Quote']],
      body: dailyData,
      theme: 'striped',
      styles: { fontSize: 8 },
    });

    doc.save(`Personalkostenanalyse_${format(currentMonth, 'yyyy-MM')}.pdf`);
  };

  if (!showCosts) return null;

  return (
    <Card className="border-2 border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Euro className="h-5 w-5 text-primary" />
            Monatliche Kostenübersicht - {format(currentMonth, 'MMMM yyyy', { locale: de })}
          </CardTitle>
          <Button onClick={exportToPDF} variant="outline" size="sm" className="gap-2">
            <Download className="h-4 w-4" />
            PDF Export
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Warning if over budget */}
        {isOverBudget && (
          <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive">
            <AlertTriangle className="h-5 w-5" />
            <span className="font-medium">
              Personalkostenquote ({laborCostPercentage.toFixed(1)}%) überschreitet Schwellenwert ({laborCostThreshold}%)
            </span>
          </div>
        )}

        {/* Department Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Service */}
          <div className="p-4 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-3 h-3 rounded-full bg-blue-500" />
              <h4 className="font-semibold">Service</h4>
            </div>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Mitarbeiter:</span>
                <span className="font-medium">{serviceEmployees.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Stunden:</span>
                <span className="font-medium">{serviceStats.totalHours.toFixed(1)} h</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Kosten:</span>
                <span className="font-medium text-blue-600">CHF {serviceStats.totalCosts.toFixed(0)}</span>
              </div>
            </div>
          </div>

          {/* Kitchen */}
          <div className="p-4 bg-orange-50 dark:bg-orange-950/30 rounded-lg border border-orange-200 dark:border-orange-800">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-3 h-3 rounded-full bg-orange-500" />
              <h4 className="font-semibold">Küche</h4>
            </div>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Mitarbeiter:</span>
                <span className="font-medium">{kitchenEmployees.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Stunden:</span>
                <span className="font-medium">{kitchenStats.totalHours.toFixed(1)} h</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Kosten:</span>
                <span className="font-medium text-orange-600">CHF {kitchenStats.totalCosts.toFixed(0)}</span>
              </div>
            </div>
          </div>

          {/* Total */}
          <div className={cn(
            "p-4 rounded-lg border",
            isOverBudget 
              ? "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800" 
              : "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800"
          )}>
            <div className="flex items-center gap-2 mb-2">
              <Euro className="h-4 w-4" />
              <h4 className="font-semibold">Gesamt</h4>
            </div>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Stunden:</span>
                <span className="font-medium">{totalStats.totalHours.toFixed(1)} h</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Kosten:</span>
                <span className={cn("font-bold", isOverBudget ? "text-red-600" : "text-green-600")}>
                  CHF {totalStats.totalCosts.toFixed(0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Quote:</span>
                <span className={cn("font-bold", isOverBudget ? "text-red-600" : "text-green-600")}>
                  {laborCostPercentage.toFixed(1)}%
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Weekly Breakdown */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 px-2">KW</th>
                <th className="text-left py-2 px-2">Zeitraum</th>
                <th className="text-right py-2 px-2">Stunden</th>
                <th className="text-right py-2 px-2">Kosten</th>
                <th className="text-right py-2 px-2">Umsatz</th>
                <th className="text-right py-2 px-2">Quote</th>
              </tr>
            </thead>
            <tbody>
              {weeklyBreakdown.map((week, idx) => (
                <tr key={idx} className={cn("border-b", week.isOver && "bg-red-50 dark:bg-red-950/20")}>
                  <td className="py-2 px-2 font-medium">KW {week.weekNumber}</td>
                  <td className="py-2 px-2 text-muted-foreground">{week.startDate} - {week.endDate}</td>
                  <td className="py-2 px-2 text-right">{week.hours.toFixed(1)} h</td>
                  <td className="py-2 px-2 text-right">CHF {week.costs.toFixed(0)}</td>
                  <td className="py-2 px-2 text-right">CHF {week.revenue.toFixed(0)}</td>
                  <td className={cn("py-2 px-2 text-right font-medium", week.isOver ? "text-red-600" : "text-green-600")}>
                    {week.percentage.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
};
