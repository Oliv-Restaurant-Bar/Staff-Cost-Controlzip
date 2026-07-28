import { useEffect, useMemo, useState } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, startOfWeek, endOfWeek, eachWeekOfInterval } from 'date-fns';
import { de } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Employee } from '@/types/personnel';
import { DaySchedule, TimeSlot } from './ScheduleGrid';
import { calculateDayNetHours } from '@/hooks/useShiftConfig';
import { Euro, TrendingUp, TrendingDown, Users, Clock, Download, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { useTenant } from '@/contexts/TenantContext';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { getEffectiveHourlyRate } from '@/lib/employee-rate';
import { EMPLOYER_COST_LABELS, EMPLOYER_COST_LABELS_SHORT } from '@/lib/social-costs';
import { EmployerCostInfoTip } from '@/components/ui/employer-cost-info';
import {
  ladePersonalkostenDaten, personalkosten, personalquote,
  PK_BUDGET_QUOTE, type PersonalkostenDaten,
} from '@/lib/personalkosten';

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

  // Zielquote (Schwellenwert): Default = zentrale Budget-Quote (35.5 %),
  // 40 % gilt als harte Obergrenze (Ampel wird ab dort rot statt orange).
  const laborCostThreshold = parseFloat(
    localStorage.getItem('labor_cost_threshold') || String(PK_BUDGET_QUOTE * 100),
  );
  const HARD_CAP_PCT = 40;

  const { tenantId, tenantKey } = useTenant();

  // Zentrale AG-Sozialkostensätze — Kostenbasis = Total Arbeitgeberkosten
  // (Bruttolohn + Arbeitgeber-Sozialkosten), nie roher hourlyWage.
  const { rates: socialCostRates, loading: ratesLoading } = useSocialCostRates();

  // ── Zentrale Berechnungsquelle (personalkosten.ts) ──────────────────────────
  // Monats-Total (Fix+Flex, Hochrechnung) und PKQ kommen aus der Lib, damit
  // dieselben Regeln gelten wie in /personalkosten-neu (Etappe 2b). Async-Load
  // pro Monat gecacht; Abteilungs-Splits behalten ihre lokale Detail-Logik.
  const [pkDaten, setPkDaten] = useState<PersonalkostenDaten | null>(null);
  useEffect(() => {
    if (ratesLoading) return;
    // Vorherige Monats-/Mandanten-Daten sofort verwerfen, damit beim Wechsel
    // keine veralteten zentralen Totale angezeigt werden (Fallback = lokal).
    setPkDaten(null);
    let alive = true;
    const y = currentMonth.getFullYear();
    const m = currentMonth.getMonth() + 1;
    ladePersonalkostenDaten(y, m, tenantId, tenantKey, socialCostRates)
      .then(d => { if (alive) setPkDaten(d); })
      .catch(() => { if (alive) setPkDaten(null); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMonth, tenantId, ratesLoading, socialCostRates]);

  const centralTotals = useMemo(() => {
    if (!pkDaten) return null;
    const k = personalkosten(pkDaten, 'hochrechnung');
    const q = personalquote(pkDaten);
    return { total: k.total, fix: k.fix, flex: k.flex, pkqHochrechnung: q.pkqHochrechnung };
  }, [pkDaten]);
  const rateById = useMemo(() => {
    const m = new Map<string, number>();
    employees.forEach(emp => {
      const r = getEffectiveHourlyRate(emp, socialCostRates);
      if (r != null && r > 0) m.set(emp.id, r);
    });
    return m;
  }, [employees, socialCostRates]);

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
          // Netto via SSoT (Pause pro Einsatz abgezogen)
          const netHours = calculateDayNetHours(daySchedule);
          
          totalHours += netHours;
          const rate = rateById.get(emp.id);
          if (rate) {
            totalCosts += netHours * rate;
          }
        }
      });
    });

    return { totalHours, totalCosts };
  };

  const serviceStats = useMemo(() => calculateDepartmentStats(serviceEmployees), [serviceEmployees, scheduleData, daysInMonth, rateById]);
  const kitchenStats = useMemo(() => calculateDepartmentStats(kitchenEmployees), [kitchenEmployees, scheduleData, daysInMonth, rateById]);
  // Lokale (eigene) Splitsumme — dient als Basis für die proportionale
  // Umverteilung des zentralen Gesamt-Totals auf Service/Küche.
  const localSplitTotal = serviceStats.totalCosts + kitchenStats.totalCosts;

  // GESAMT-Total kommt aus der zentralen Quelle (personalkosten.ts, Hochrechnung
  // = Fix voller Monat + Flex pro Tag). Fallback auf lokale Summe, solange die
  // Lib-Daten noch laden. Die Abteilungs-Splits behalten ihre Detail-Logik,
  // werden aber proportional zur zentralen Flex-Summe skaliert, damit
  // Service + Küche = Gesamt (inkl. Fix-Anteil) ergibt.
  const totalCosts = centralTotals ? centralTotals.total : localSplitTotal;
  const splitScale = localSplitTotal > 0 ? totalCosts / localSplitTotal : 1;
  // Randfall: keine lokale Split-Basis (z.B. nur Fixkosten, keine Stunden) —
  // dann Gesamt hälftig aufteilen, damit Service + Küche = Gesamt bleibt.
  const noSplitBasis = localSplitTotal <= 0 && totalCosts > 0;
  const serviceCosts = noSplitBasis ? totalCosts / 2 : serviceStats.totalCosts * splitScale;
  const kitchenCosts = noSplitBasis ? totalCosts / 2 : kitchenStats.totalCosts * splitScale;
  const totalStats = {
    totalHours: serviceStats.totalHours + kitchenStats.totalHours,
    totalCosts,
  };

  // Calculate monthly revenue
  const monthlyRevenue = useMemo(() => {
    return daysInMonth.reduce((sum, day) => {
      const dateStr = format(day, 'yyyy-MM-dd');
      return sum + (dailyBudgets[dateStr]?.plannedRevenue || 0);
    }, 0);
  }, [daysInMonth, dailyBudgets]);

  // PKQ aus der zentralen Quelle (gleiche Basis Kosten/Netto-Umsatz);
  // Fallback: lokale Kosten ÷ geplanter Umsatz, solange Lib-Daten laden.
  const laborCostPercentage = centralTotals?.pkqHochrechnung != null
    ? centralTotals.pkqHochrechnung * 100
    : (monthlyRevenue > 0 ? (totalStats.totalCosts / monthlyRevenue) * 100 : 0);
  const isOverBudget = laborCostPercentage > laborCostThreshold;
  // Harte Obergrenze (40 %) → Ampel rot; zwischen Ziel und Cap → orange.
  const isOverHardCap = laborCostPercentage > HARD_CAP_PCT;

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
            // Netto via SSoT (Pause pro Einsatz abgezogen)
            const netHours = calculateDayNetHours(daySchedule);
            
            weekHours += netHours;
            const rate = rateById.get(emp.id);
            if (rate) {
              weekCosts += netHours * rate;
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
  }, [weeksInMonth, employees, scheduleData, dailyBudgets, monthStart, monthEnd, laborCostThreshold, rateById]);

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
        [EMPLOYER_COST_LABELS.total, `CHF ${totalStats.totalCosts.toFixed(2)}`],
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
      head: [['Abteilung', 'Mitarbeiter', 'Stunden', EMPLOYER_COST_LABELS_SHORT.total]],
      body: [
        ['Service', serviceEmployees.length.toString(), `${serviceStats.totalHours.toFixed(1)} h`, `CHF ${serviceCosts.toFixed(2)}`],
        ['Küche', kitchenEmployees.length.toString(), `${kitchenStats.totalHours.toFixed(1)} h`, `CHF ${kitchenCosts.toFixed(2)}`],
        ['Gesamt', employees.length.toString(), `${totalStats.totalHours.toFixed(1)} h`, `CHF ${totalStats.totalCosts.toFixed(2)}`],
      ],
      theme: 'striped',
    });

    // Weekly breakdown
    const finalY2 = (doc as any).lastAutoTable.finalY + 10;
    doc.text('Wochenübersicht', 14, finalY2);

    autoTable(doc, {
      startY: finalY2 + 5,
      head: [['KW', 'Zeitraum', 'Stunden', EMPLOYER_COST_LABELS_SHORT.total, 'Umsatz', 'Quote']],
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
          // Netto via SSoT (Pause pro Einsatz abgezogen)
          const net = calculateDayNetHours(daySchedule);
          
          dayHours += net;
          const rate = rateById.get(emp.id);
          if (rate) {
            dayCosts += net * rate;
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
      head: [['Tag', 'Stunden', EMPLOYER_COST_LABELS_SHORT.total, 'Umsatz', 'Quote']],
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
            <EmployerCostInfoTip rates={socialCostRates} />
          </CardTitle>
          <Button onClick={exportToPDF} variant="outline" size="sm" className="gap-2">
            <Download className="h-4 w-4" />
            PDF Export
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Warning if over budget — 40 % ist die harte Obergrenze (rot) */}
        {isOverBudget && (
          <div className={cn(
            'flex items-center gap-2 p-3 rounded-lg border',
            isOverHardCap
              ? 'bg-destructive/10 border-destructive/30 text-destructive'
              : 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400',
          )}>
            <AlertTriangle className="h-5 w-5" />
            <span className="font-medium">
              Personalkostenquote ({laborCostPercentage.toFixed(1)}%) überschreitet
              {' '}{isOverHardCap ? `harte Obergrenze (${HARD_CAP_PCT}%)` : `Zielquote (${laborCostThreshold}%)`}
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
                <span className="text-muted-foreground">{EMPLOYER_COST_LABELS_SHORT.total}:</span>
                <span className="font-medium text-blue-600">CHF {serviceCosts.toFixed(0)}</span>
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
                <span className="text-muted-foreground">{EMPLOYER_COST_LABELS_SHORT.total}:</span>
                <span className="font-medium text-orange-600">CHF {kitchenCosts.toFixed(0)}</span>
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
                <span className="text-muted-foreground">{EMPLOYER_COST_LABELS_SHORT.total}:</span>
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
                <th className="text-right py-2 px-2">{EMPLOYER_COST_LABELS_SHORT.total}</th>
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
