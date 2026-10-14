import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, TrendingUp, TrendingDown, Minus, BarChart3, Calendar, ArrowUpRight, ArrowDownRight, Equal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportDashboardPDF } from "@/lib/kpi-export";
import { UnifiedExportButton } from "@/components/UnifiedExportButton";
import { useSocialCostRates } from "@/hooks/useSocialCostRates";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Area,
  AreaChart,
  ComposedChart,
} from "recharts";
import { Employee, TimeEntry, DailyBudget } from "@/types/personnel";
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, startOfWeek, endOfWeek, subMonths, subYears } from "date-fns";
import { de } from "date-fns/locale";

interface KPIDashboardProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: DailyBudget[];
  selectedDate: Date;
}

interface DayData {
  date: string;
  dayName: string;
  revenue: number;
  laborCost: number;
  laborCostQuote: number;
  plannedHours: number;
  actualHours: number;
}

interface DepartmentData {
  name: string;
  plannedHours: number;
  actualHours: number;
  laborCost: number;
  revenue: number;
  laborCostQuote: number;
}

const chartConfig = {
  revenue: {
    label: "Umsatz",
    color: "hsl(142, 76%, 36%)",
  },
  laborCost: {
    label: "Personalkosten",
    color: "hsl(346, 87%, 43%)",
  },
  laborCostQuote: {
    label: "PKQ %",
    color: "hsl(217, 91%, 60%)",
  },
  plannedHours: {
    label: "Geplante Std.",
    color: "hsl(262, 83%, 58%)",
  },
  actualHours: {
    label: "Ist-Std.",
    color: "hsl(32, 95%, 44%)",
  },
  service: {
    label: "Service",
    color: "hsl(217, 91%, 60%)",
  },
  kitchen: {
    label: "Küche",
    color: "hsl(142, 76%, 36%)",
  },
};

export const KPIDashboard = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
}: KPIDashboardProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const { rates: socialCostRates } = useSocialCostRates();

  const monthData = useMemo(() => {
    const monthStart = startOfMonth(selectedDate);
    const monthEnd = endOfMonth(selectedDate);
    const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });

    const dailyData: DayData[] = daysInMonth.map((day) => {
      const dateStr = format(day, "yyyy-MM-dd");
      const dayOfWeek = getDay(day);
      const dayNames = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
      const dayName = dayNames[dayOfWeek];

      const dayEntries = timeEntries.filter((entry) => entry.date === dateStr);
      const dayBudget = dailyBudgets.find((b) => b.date === dateStr);

      let totalPlannedHours = 0;
      let totalActualHours = 0;
      let totalLaborCost = 0;

      dayEntries.forEach((entry) => {
        const employee = employees.find((e) => e.id === entry.employeeId);
        if (employee) {
          totalPlannedHours += entry.plannedHours;
          totalActualHours += entry.actualHours || 0;
          totalLaborCost +=
            (entry.actualHours || 0) * employee.hourlyWage * 1.22; // 22% Lohnnebenkosten
        }
      });

      const revenue = dayBudget?.actualRevenue || dayBudget?.plannedRevenue || 0;
      const laborCostQuote = revenue > 0 ? (totalLaborCost / revenue) * 100 : 0;

      return {
        date: format(day, "dd.MM"),
        dayName,
        revenue,
        laborCost: totalLaborCost,
        laborCostQuote: Math.round(laborCostQuote * 10) / 10,
        plannedHours: totalPlannedHours,
        actualHours: totalActualHours,
      };
    });

    return dailyData;
  }, [employees, timeEntries, dailyBudgets, selectedDate]);

  const weeklyData = useMemo(() => {
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
    const daysInWeek = eachDayOfInterval({ start: weekStart, end: weekEnd });

    return daysInWeek.map((day) => {
      const dateStr = format(day, "yyyy-MM-dd");
      const dayOfWeek = getDay(day);
      const dayNames = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

      const dayEntries = timeEntries.filter((entry) => entry.date === dateStr);
      const dayBudget = dailyBudgets.find((b) => b.date === dateStr);

      let totalLaborCost = 0;
      let totalActualHours = 0;

      dayEntries.forEach((entry) => {
        const employee = employees.find((e) => e.id === entry.employeeId);
        if (employee) {
          totalActualHours += entry.actualHours || 0;
          totalLaborCost +=
            (entry.actualHours || 0) * employee.hourlyWage * 1.22;
        }
      });

      const revenue = dayBudget?.actualRevenue || dayBudget?.plannedRevenue || 0;
      const laborCostQuote = revenue > 0 ? (totalLaborCost / revenue) * 100 : 0;

      return {
        date: format(day, "dd.MM"),
        dayName: dayNames[dayOfWeek],
        revenue,
        laborCost: totalLaborCost,
        laborCostQuote: Math.round(laborCostQuote * 10) / 10,
        actualHours: totalActualHours,
      };
    });
  }, [employees, timeEntries, dailyBudgets, selectedDate]);

  const departmentData = useMemo(() => {
    const monthStart = startOfMonth(selectedDate);
    const monthEnd = endOfMonth(selectedDate);
    const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });

    const departments: Record<string, DepartmentData> = {
      Service: { name: "Service", plannedHours: 0, actualHours: 0, laborCost: 0, revenue: 0, laborCostQuote: 0 },
      Küche: { name: "Küche", plannedHours: 0, actualHours: 0, laborCost: 0, revenue: 0, laborCostQuote: 0 },
    };

    daysInMonth.forEach((day) => {
      const dateStr = format(day, "yyyy-MM-dd");
      const dayEntries = timeEntries.filter((entry) => entry.date === dateStr);
      const dayBudget = dailyBudgets.find((b) => b.date === dateStr);

      dayEntries.forEach((entry) => {
        const employee = employees.find((e) => e.id === entry.employeeId);
        const deptName = employee?.department === 'service' ? 'Service' : employee?.department === 'küche' ? 'Küche' : null;
        if (employee && deptName && departments[deptName]) {
          const dept = departments[deptName];
          dept.plannedHours += entry.plannedHours;
          dept.actualHours += entry.actualHours || 0;
          dept.laborCost +=
            (entry.actualHours || 0) * employee.hourlyWage * 1.22;
        }
      });

      if (dayBudget) {
        // Split revenue proportionally between departments based on labor cost
        const totalDayLaborCost = Object.values(departments).reduce(
          (sum, d) => sum + d.laborCost,
          0
        );
        const dayRevenue = dayBudget.actualRevenue || dayBudget.plannedRevenue || 0;
        if (totalDayLaborCost > 0) {
          Object.values(departments).forEach((dept) => {
            dept.revenue += dayRevenue * (dept.laborCost / totalDayLaborCost);
          });
        }
      }
    });

    Object.values(departments).forEach((dept) => {
      dept.laborCostQuote = dept.revenue > 0 ? (dept.laborCost / dept.revenue) * 100 : 0;
    });

    return Object.values(departments);
  }, [employees, timeEntries, dailyBudgets, selectedDate]);

  const summaryStats = useMemo(() => {
    const totalRevenue = monthData.reduce((sum, d) => sum + d.revenue, 0);
    const totalLaborCost = monthData.reduce((sum, d) => sum + d.laborCost, 0);
    const avgLaborCostQuote = totalRevenue > 0 ? (totalLaborCost / totalRevenue) * 100 : 0;
    const totalPlannedHours = monthData.reduce((sum, d) => sum + d.plannedHours, 0);
    const totalActualHours = monthData.reduce((sum, d) => sum + d.actualHours, 0);
    const hoursDiff = totalActualHours - totalPlannedHours;

    return {
      totalRevenue,
      totalLaborCost,
      avgLaborCostQuote: Math.round(avgLaborCostQuote * 10) / 10,
      totalPlannedHours,
      totalActualHours,
      hoursDiff,
    };
  }, [monthData]);

  // Calculate previous month data
  const previousMonthStats = useMemo(() => {
    const prevMonthDate = subMonths(selectedDate, 1);
    const monthStart = startOfMonth(prevMonthDate);
    const monthEnd = endOfMonth(prevMonthDate);
    const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });

    let totalRevenue = 0;
    let totalLaborCost = 0;
    let totalPlannedHours = 0;
    let totalActualHours = 0;

    daysInMonth.forEach((day) => {
      const dateStr = format(day, "yyyy-MM-dd");
      const dayEntries = timeEntries.filter((entry) => entry.date === dateStr);
      const dayBudget = dailyBudgets.find((b) => b.date === dateStr);

      dayEntries.forEach((entry) => {
        const employee = employees.find((e) => e.id === entry.employeeId);
        if (employee) {
          totalPlannedHours += entry.plannedHours;
          totalActualHours += entry.actualHours || 0;
          totalLaborCost += (entry.actualHours || 0) * employee.hourlyWage * 1.22;
        }
      });

      totalRevenue += dayBudget?.actualRevenue || dayBudget?.plannedRevenue || 0;
    });

    const avgLaborCostQuote = totalRevenue > 0 ? (totalLaborCost / totalRevenue) * 100 : 0;

    return {
      month: format(prevMonthDate, "MMM yyyy", { locale: de }),
      totalRevenue,
      totalLaborCost,
      avgLaborCostQuote: Math.round(avgLaborCostQuote * 10) / 10,
      totalPlannedHours,
      totalActualHours,
    };
  }, [employees, timeEntries, dailyBudgets, selectedDate]);

  // Calculate previous year same month data
  const previousYearStats = useMemo(() => {
    const prevYearDate = subYears(selectedDate, 1);
    const monthStart = startOfMonth(prevYearDate);
    const monthEnd = endOfMonth(prevYearDate);
    const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });

    let totalRevenue = 0;
    let totalLaborCost = 0;
    let totalPlannedHours = 0;
    let totalActualHours = 0;

    daysInMonth.forEach((day) => {
      const dateStr = format(day, "yyyy-MM-dd");
      const dayEntries = timeEntries.filter((entry) => entry.date === dateStr);
      const dayBudget = dailyBudgets.find((b) => b.date === dateStr);

      dayEntries.forEach((entry) => {
        const employee = employees.find((e) => e.id === entry.employeeId);
        if (employee) {
          totalPlannedHours += entry.plannedHours;
          totalActualHours += entry.actualHours || 0;
          totalLaborCost += (entry.actualHours || 0) * employee.hourlyWage * 1.22;
        }
      });

      totalRevenue += dayBudget?.actualRevenue || dayBudget?.previousYearRevenue || 0;
    });

    const avgLaborCostQuote = totalRevenue > 0 ? (totalLaborCost / totalRevenue) * 100 : 0;

    return {
      month: format(prevYearDate, "MMM yyyy", { locale: de }),
      totalRevenue,
      totalLaborCost,
      avgLaborCostQuote: Math.round(avgLaborCostQuote * 10) / 10,
      totalPlannedHours,
      totalActualHours,
    };
  }, [employees, timeEntries, dailyBudgets, selectedDate]);

  // Calculate comparison data for chart
  const comparisonData = useMemo(() => {
    return [
      {
        period: format(selectedDate, "MMM yy", { locale: de }),
        type: "Aktuell",
        revenue: summaryStats.totalRevenue,
        laborCost: summaryStats.totalLaborCost,
        laborCostQuote: summaryStats.avgLaborCostQuote,
        hours: summaryStats.totalActualHours,
      },
      {
        period: previousMonthStats.month,
        type: "Vormonat",
        revenue: previousMonthStats.totalRevenue,
        laborCost: previousMonthStats.totalLaborCost,
        laborCostQuote: previousMonthStats.avgLaborCostQuote,
        hours: previousMonthStats.totalActualHours,
      },
      {
        period: previousYearStats.month,
        type: "Vorjahr",
        revenue: previousYearStats.totalRevenue,
        laborCost: previousYearStats.totalLaborCost,
        laborCostQuote: previousYearStats.avgLaborCostQuote,
        hours: previousYearStats.totalActualHours,
      },
    ];
  }, [summaryStats, previousMonthStats, previousYearStats, selectedDate]);

  // Calculate percentage changes
  const getPercentageChange = (current: number, previous: number) => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return ((current - previous) / previous) * 100;
  };

  const revenueChangeVsPrevMonth = getPercentageChange(summaryStats.totalRevenue, previousMonthStats.totalRevenue);
  const revenueChangeVsPrevYear = getPercentageChange(summaryStats.totalRevenue, previousYearStats.totalRevenue);
  const laborCostChangeVsPrevMonth = getPercentageChange(summaryStats.totalLaborCost, previousMonthStats.totalLaborCost);
  const laborCostChangeVsPrevYear = getPercentageChange(summaryStats.totalLaborCost, previousYearStats.totalLaborCost);
  const quoteChangeVsPrevMonth = summaryStats.avgLaborCostQuote - previousMonthStats.avgLaborCostQuote;
  const quoteChangeVsPrevYear = summaryStats.avgLaborCostQuote - previousYearStats.avgLaborCostQuote;

  const getTrendIcon = (value: number, threshold: number, inverted = false) => {
    if (inverted) {
      if (value < threshold - 2) return <TrendingUp className="h-4 w-4 text-green-600" />;
      if (value > threshold + 2) return <TrendingDown className="h-4 w-4 text-red-600" />;
    } else {
      if (value > threshold + 2) return <TrendingUp className="h-4 w-4 text-green-600" />;
      if (value < threshold - 2) return <TrendingDown className="h-4 w-4 text-red-600" />;
    }
    return <Minus className="h-4 w-4 text-muted-foreground" />;
  };

  const getQuoteColor = (quote: number) => {
    if (quote <= 25) return "text-green-600";
    if (quote <= 30) return "text-amber-600";
    return "text-red-600";
  };

  const pieData = [
    { name: "Personalkosten", value: summaryStats.totalLaborCost, fill: "hsl(346, 87%, 43%)" },
    { name: "Sonstige Kosten", value: summaryStats.totalRevenue - summaryStats.totalLaborCost, fill: "hsl(142, 76%, 36%)" },
  ];

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className="mb-6">
        <CardHeader className="pb-2">
          <CollapsibleTrigger className="flex items-center justify-between w-full cursor-pointer hover:opacity-80">
            <CardTitle className="flex items-center gap-2 text-lg">
              <BarChart3 className="h-5 w-5 text-primary" />
              KPI Dashboard - {format(selectedDate, "MMMM yyyy", { locale: de })}
            </CardTitle>
            <ChevronDown
              className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${
                isOpen ? "rotate-180" : ""
              }`}
            />
          </CollapsibleTrigger>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="space-y-6">
            {/* Export Button */}
            <div className="flex justify-end">
              <UnifiedExportButton
                data-testid="kpi-dashboard-export"
                actions={[
                  { key: 'pdf', label: 'Dashboard (PDF)', kind: 'pdf', onSelect: () => exportDashboardPDF(employees, timeEntries, dailyBudgets, selectedDate, socialCostRates) },
                ]}
              />
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="bg-muted/30">
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground">Monatsumsatz</p>
                  <p className="text-2xl font-bold">
                    CHF {summaryStats.totalRevenue.toLocaleString("de-CH")}
                  </p>
                </CardContent>
              </Card>
              <Card className="bg-muted/30">
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground">Personalkosten</p>
                  <p className="text-2xl font-bold">
                    CHF {summaryStats.totalLaborCost.toLocaleString("de-CH", { maximumFractionDigits: 0 })}
                  </p>
                </CardContent>
              </Card>
              <Card className="bg-muted/30">
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground">Personalkostenquote</p>
                  <div className="flex items-center gap-2">
                    <p className={`text-2xl font-bold ${getQuoteColor(summaryStats.avgLaborCostQuote)}`}>
                      {summaryStats.avgLaborCostQuote}%
                    </p>
                    {getTrendIcon(summaryStats.avgLaborCostQuote, 28, true)}
                  </div>
                </CardContent>
              </Card>
              <Card className="bg-muted/30">
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground">Stundenabweichung</p>
                  <p className={`text-2xl font-bold ${summaryStats.hoursDiff > 0 ? "text-red-600" : "text-green-600"}`}>
                    {summaryStats.hoursDiff > 0 ? "+" : ""}
                    {summaryStats.hoursDiff.toFixed(1)}h
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Historical Comparison Section */}
            <Card className="border-primary/20">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Calendar className="h-4 w-4 text-primary" />
                  Historischer Vergleich
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid md:grid-cols-3 gap-4 mb-6">
                  {/* Revenue Comparison */}
                  <div className="p-4 rounded-lg bg-muted/30 space-y-3">
                    <h4 className="font-medium text-sm flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-green-500" />
                      Umsatz
                    </h4>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">vs. Vormonat</span>
                        <div className="flex items-center gap-1">
                          {revenueChangeVsPrevMonth > 0 ? (
                            <ArrowUpRight className="h-3 w-3 text-green-600" />
                          ) : revenueChangeVsPrevMonth < 0 ? (
                            <ArrowDownRight className="h-3 w-3 text-red-600" />
                          ) : (
                            <Equal className="h-3 w-3 text-muted-foreground" />
                          )}
                          <span className={`text-sm font-medium ${revenueChangeVsPrevMonth >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {revenueChangeVsPrevMonth >= 0 ? "+" : ""}{revenueChangeVsPrevMonth.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">vs. Vorjahr</span>
                        <div className="flex items-center gap-1">
                          {revenueChangeVsPrevYear > 0 ? (
                            <ArrowUpRight className="h-3 w-3 text-green-600" />
                          ) : revenueChangeVsPrevYear < 0 ? (
                            <ArrowDownRight className="h-3 w-3 text-red-600" />
                          ) : (
                            <Equal className="h-3 w-3 text-muted-foreground" />
                          )}
                          <span className={`text-sm font-medium ${revenueChangeVsPrevYear >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {revenueChangeVsPrevYear >= 0 ? "+" : ""}{revenueChangeVsPrevYear.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Labor Cost Comparison */}
                  <div className="p-4 rounded-lg bg-muted/30 space-y-3">
                    <h4 className="font-medium text-sm flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-red-500" />
                      Personalkosten
                    </h4>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">vs. Vormonat</span>
                        <div className="flex items-center gap-1">
                          {laborCostChangeVsPrevMonth > 0 ? (
                            <ArrowUpRight className="h-3 w-3 text-red-600" />
                          ) : laborCostChangeVsPrevMonth < 0 ? (
                            <ArrowDownRight className="h-3 w-3 text-green-600" />
                          ) : (
                            <Equal className="h-3 w-3 text-muted-foreground" />
                          )}
                          <span className={`text-sm font-medium ${laborCostChangeVsPrevMonth <= 0 ? "text-green-600" : "text-red-600"}`}>
                            {laborCostChangeVsPrevMonth >= 0 ? "+" : ""}{laborCostChangeVsPrevMonth.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">vs. Vorjahr</span>
                        <div className="flex items-center gap-1">
                          {laborCostChangeVsPrevYear > 0 ? (
                            <ArrowUpRight className="h-3 w-3 text-red-600" />
                          ) : laborCostChangeVsPrevYear < 0 ? (
                            <ArrowDownRight className="h-3 w-3 text-green-600" />
                          ) : (
                            <Equal className="h-3 w-3 text-muted-foreground" />
                          )}
                          <span className={`text-sm font-medium ${laborCostChangeVsPrevYear <= 0 ? "text-green-600" : "text-red-600"}`}>
                            {laborCostChangeVsPrevYear >= 0 ? "+" : ""}{laborCostChangeVsPrevYear.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Labor Cost Quote Comparison */}
                  <div className="p-4 rounded-lg bg-muted/30 space-y-3">
                    <h4 className="font-medium text-sm flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-blue-500" />
                      Personalkostenquote
                    </h4>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">vs. Vormonat</span>
                        <div className="flex items-center gap-1">
                          {quoteChangeVsPrevMonth < 0 ? (
                            <ArrowDownRight className="h-3 w-3 text-green-600" />
                          ) : quoteChangeVsPrevMonth > 0 ? (
                            <ArrowUpRight className="h-3 w-3 text-red-600" />
                          ) : (
                            <Equal className="h-3 w-3 text-muted-foreground" />
                          )}
                          <span className={`text-sm font-medium ${quoteChangeVsPrevMonth <= 0 ? "text-green-600" : "text-red-600"}`}>
                            {quoteChangeVsPrevMonth >= 0 ? "+" : ""}{quoteChangeVsPrevMonth.toFixed(1)}pp
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">vs. Vorjahr</span>
                        <div className="flex items-center gap-1">
                          {quoteChangeVsPrevYear < 0 ? (
                            <ArrowDownRight className="h-3 w-3 text-green-600" />
                          ) : quoteChangeVsPrevYear > 0 ? (
                            <ArrowUpRight className="h-3 w-3 text-red-600" />
                          ) : (
                            <Equal className="h-3 w-3 text-muted-foreground" />
                          )}
                          <span className={`text-sm font-medium ${quoteChangeVsPrevYear <= 0 ? "text-green-600" : "text-red-600"}`}>
                            {quoteChangeVsPrevYear >= 0 ? "+" : ""}{quoteChangeVsPrevYear.toFixed(1)}pp
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Historical Comparison Chart */}
                <ChartContainer config={{
                  ...chartConfig,
                  current: { label: "Aktuell", color: "hsl(217, 91%, 60%)" },
                  previous: { label: "Vormonat", color: "hsl(262, 83%, 58%)" },
                  prevYear: { label: "Vorjahr", color: "hsl(32, 95%, 44%)" },
                }} className="h-[200px] w-full">
                  <BarChart data={comparisonData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis type="number" className="text-xs" tickFormatter={(v) => `CHF ${(v/1000).toFixed(0)}k`} />
                    <YAxis dataKey="period" type="category" className="text-xs" width={70} />
                    <ChartTooltip 
                      content={<ChartTooltipContent />}
                      formatter={(value: number) => `CHF ${value.toLocaleString("de-CH", { maximumFractionDigits: 0 })}`}
                    />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Bar dataKey="revenue" name="Umsatz" fill="hsl(142, 76%, 36%)" radius={[0, 4, 4, 0]} />
                    <Bar dataKey="laborCost" name="Personalkosten" fill="hsl(346, 87%, 43%)" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ChartContainer>

                {/* Comparison Table */}
                <div className="overflow-x-auto mt-4">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 font-medium">Zeitraum</th>
                        <th className="text-right py-2 font-medium">Umsatz</th>
                        <th className="text-right py-2 font-medium">Personalkosten</th>
                        <th className="text-right py-2 font-medium">PKQ</th>
                        <th className="text-right py-2 font-medium">Stunden</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b bg-primary/5">
                        <td className="py-2 font-medium">{format(selectedDate, "MMMM yyyy", { locale: de })}</td>
                        <td className="text-right py-2">CHF {summaryStats.totalRevenue.toLocaleString("de-CH")}</td>
                        <td className="text-right py-2">CHF {summaryStats.totalLaborCost.toLocaleString("de-CH", { maximumFractionDigits: 0 })}</td>
                        <td className={`text-right py-2 font-medium ${getQuoteColor(summaryStats.avgLaborCostQuote)}`}>
                          {summaryStats.avgLaborCostQuote}%
                        </td>
                        <td className="text-right py-2">{summaryStats.totalActualHours.toFixed(1)}h</td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2 text-muted-foreground">Vormonat ({previousMonthStats.month})</td>
                        <td className="text-right py-2">CHF {previousMonthStats.totalRevenue.toLocaleString("de-CH")}</td>
                        <td className="text-right py-2">CHF {previousMonthStats.totalLaborCost.toLocaleString("de-CH", { maximumFractionDigits: 0 })}</td>
                        <td className={`text-right py-2 ${getQuoteColor(previousMonthStats.avgLaborCostQuote)}`}>
                          {previousMonthStats.avgLaborCostQuote}%
                        </td>
                        <td className="text-right py-2">{previousMonthStats.totalActualHours.toFixed(1)}h</td>
                      </tr>
                      <tr>
                        <td className="py-2 text-muted-foreground">Vorjahr ({previousYearStats.month})</td>
                        <td className="text-right py-2">CHF {previousYearStats.totalRevenue.toLocaleString("de-CH")}</td>
                        <td className="text-right py-2">CHF {previousYearStats.totalLaborCost.toLocaleString("de-CH", { maximumFractionDigits: 0 })}</td>
                        <td className={`text-right py-2 ${getQuoteColor(previousYearStats.avgLaborCostQuote)}`}>
                          {previousYearStats.avgLaborCostQuote}%
                        </td>
                        <td className="text-right py-2">{previousYearStats.totalActualHours.toFixed(1)}h</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
            <div className="grid md:grid-cols-2 gap-6">
              {/* Revenue & Labor Cost Trend */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">
                    Umsatz- & Personalkosten-Trend (Woche)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ChartContainer config={chartConfig} className="h-[250px] w-full">
                    <ComposedChart data={weeklyData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="dayName" className="text-xs" />
                      <YAxis yAxisId="left" className="text-xs" />
                      <YAxis yAxisId="right" orientation="right" className="text-xs" />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <ChartLegend content={<ChartLegendContent />} />
                      <Bar
                        yAxisId="left"
                        dataKey="revenue"
                        name="Umsatz"
                        fill="hsl(142, 76%, 36%)"
                        radius={[4, 4, 0, 0]}
                      />
                      <Bar
                        yAxisId="left"
                        dataKey="laborCost"
                        name="Personalkosten"
                        fill="hsl(346, 87%, 43%)"
                        radius={[4, 4, 0, 0]}
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="laborCostQuote"
                        name="PKQ %"
                        stroke="hsl(217, 91%, 60%)"
                        strokeWidth={2}
                        dot={{ fill: "hsl(217, 91%, 60%)" }}
                      />
                    </ComposedChart>
                  </ChartContainer>
                </CardContent>
              </Card>

              {/* Labor Cost Quote Trend */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">
                    Personalkostenquote im Monat
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ChartContainer config={chartConfig} className="h-[250px] w-full">
                    <AreaChart data={monthData.slice(0, 14)}>
                      <defs>
                        <linearGradient id="colorQuote" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="date" className="text-xs" />
                      <YAxis className="text-xs" domain={[0, 50]} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Area
                        type="monotone"
                        dataKey="laborCostQuote"
                        name="PKQ %"
                        stroke="hsl(217, 91%, 60%)"
                        fill="url(#colorQuote)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ChartContainer>
                </CardContent>
              </Card>
            </div>

            {/* Charts Row 2 */}
            <div className="grid md:grid-cols-2 gap-6">
              {/* Department Comparison */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Abteilungsvergleich</CardTitle>
                </CardHeader>
                <CardContent>
                  <ChartContainer config={chartConfig} className="h-[250px] w-full">
                    <BarChart data={departmentData} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis type="number" className="text-xs" />
                      <YAxis dataKey="name" type="category" className="text-xs" width={60} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <ChartLegend content={<ChartLegendContent />} />
                      <Bar
                        dataKey="plannedHours"
                        name="Geplante Std."
                        fill="hsl(262, 83%, 58%)"
                        radius={[0, 4, 4, 0]}
                      />
                      <Bar
                        dataKey="actualHours"
                        name="Ist-Std."
                        fill="hsl(32, 95%, 44%)"
                        radius={[0, 4, 4, 0]}
                      />
                    </BarChart>
                  </ChartContainer>
                </CardContent>
              </Card>

              {/* Cost Distribution Pie */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Kostenverteilung</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-[250px] flex items-center justify-center">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={90}
                          paddingAngle={2}
                          dataKey="value"
                          label={({ name, percent }) =>
                            `${name}: ${(percent * 100).toFixed(0)}%`
                          }
                          labelLine={false}
                        >
                          {pieData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.fill} />
                          ))}
                        </Pie>
                        <ChartTooltip
                          formatter={(value: number) =>
                            `€${value.toLocaleString("de-DE", { maximumFractionDigits: 0 })}`
                          }
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex justify-center gap-6 mt-2">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-red-500" />
                      <span className="text-sm">Personalkosten</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-green-600" />
                      <span className="text-sm">Sonstiges</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Department KPI Table */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Abteilungs-KPIs im Detail</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 font-medium">Abteilung</th>
                        <th className="text-right py-2 font-medium">Geplante Std.</th>
                        <th className="text-right py-2 font-medium">Ist-Std.</th>
                        <th className="text-right py-2 font-medium">Abweichung</th>
                        <th className="text-right py-2 font-medium">Personalkosten</th>
                        <th className="text-right py-2 font-medium">PKQ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {departmentData.map((dept) => {
                        const hoursDiff = dept.actualHours - dept.plannedHours;
                        return (
                          <tr key={dept.name} className="border-b last:border-0">
                            <td className="py-2 font-medium">{dept.name}</td>
                            <td className="text-right py-2">{dept.plannedHours.toFixed(1)}h</td>
                            <td className="text-right py-2">{dept.actualHours.toFixed(1)}h</td>
                            <td
                              className={`text-right py-2 ${
                                hoursDiff > 0 ? "text-red-600" : "text-green-600"
                              }`}
                            >
                              {hoursDiff > 0 ? "+" : ""}
                              {hoursDiff.toFixed(1)}h
                            </td>
                            <td className="text-right py-2">
                              €{dept.laborCost.toLocaleString("de-DE", { maximumFractionDigits: 0 })}
                            </td>
                            <td
                              className={`text-right py-2 font-medium ${getQuoteColor(
                                dept.laborCostQuote
                              )}`}
                            >
                              {dept.laborCostQuote.toFixed(1)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
};
