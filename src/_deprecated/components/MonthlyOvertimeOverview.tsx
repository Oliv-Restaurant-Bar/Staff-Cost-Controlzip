import { useMemo } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDaysInMonth } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, TimeEntry } from '@/types/personnel';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, Clock, TrendingUp, TrendingDown, Minus, CalendarDays } from 'lucide-react';

interface MonthlyOvertimeOverviewProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  selectedDate: Date;
}

interface EmployeeMonthlyData {
  employee: Employee;
  expectedHours: number;
  actualHours: number;
  overtimeHours: number;
  overtimeCost: number;
  daysWorked: number;
}

export const MonthlyOvertimeOverview = ({
  employees,
  timeEntries,
  selectedDate,
}: MonthlyOvertimeOverviewProps) => {
  // Use selectedDate directly for the month
  const currentMonth = startOfMonth(selectedDate);
  const monthLabel = format(currentMonth, 'MMMM yyyy', { locale: de });

  // Calculate monthly data for each employee
  const monthlyData = useMemo(() => {
    const monthStart = currentMonth;
    const monthEnd = endOfMonth(monthStart);
    const daysInMonth = getDaysInMonth(monthStart);
    
    // Calculate working days in month (Mon-Fri = 5 days per week, approx 21.67 days/month)
    // Using standard 4.33 weeks per month
    const workingDaysInMonth = 4.33 * 5; // ~21.67 working days
    
    const allDays = eachDayOfInterval({ start: monthStart, end: monthEnd });
    const allDayStrings = allDays.map(d => format(d, 'yyyy-MM-dd'));

    const data: EmployeeMonthlyData[] = employees
      .filter(emp => emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit')
      .map(employee => {
        // Get all time entries for this employee in this month
        const employeeEntries = timeEntries.filter(
          te => te.employeeId === employee.id && allDayStrings.includes(te.date)
        );

        // Calculate actual hours worked
        const actualHours = employeeEntries.reduce((sum, entry) => {
          return sum + (entry.actualHours || 0);
        }, 0);

        // Calculate expected hours based on weekly hours
        // weeklyHours / 5 days * working days in month
        const weeklyHours = employee.weeklyHours || 42;
        const dailyHours = weeklyHours / 5;
        const expectedHours = dailyHours * workingDaysInMonth;

        // Calculate overtime
        const overtimeHours = actualHours - expectedHours;
        const overtimeCost = overtimeHours * employee.hourlyWage;

        // Count days worked
        const daysWorked = employeeEntries.filter(e => (e.actualHours || 0) > 0).length;

        return {
          employee,
          expectedHours,
          actualHours,
          overtimeHours,
          overtimeCost,
          daysWorked,
        };
      })
      .sort((a, b) => b.overtimeHours - a.overtimeHours); // Sort by overtime descending

    return data;
  }, [employees, timeEntries, currentMonth]);

  // Calculate totals
  const totals = useMemo(() => {
    return monthlyData.reduce(
      (acc, data) => ({
        expectedHours: acc.expectedHours + data.expectedHours,
        actualHours: acc.actualHours + data.actualHours,
        overtimeHours: acc.overtimeHours + data.overtimeHours,
        overtimeCost: acc.overtimeCost + data.overtimeCost,
      }),
      { expectedHours: 0, actualHours: 0, overtimeHours: 0, overtimeCost: 0 }
    );
  }, [monthlyData]);

  const getOvertimeIcon = (hours: number) => {
    if (hours > 0) return <TrendingUp className="h-4 w-4 text-destructive" />;
    if (hours < 0) return <TrendingDown className="h-4 w-4 text-green-600" />;
    return <Minus className="h-4 w-4 text-muted-foreground" />;
  };

  const getOvertimeColor = (hours: number) => {
    if (hours > 0) return 'text-destructive';
    if (hours < 0) return 'text-green-600';
    return 'text-muted-foreground';
  };

  return (
    <Collapsible>
      <div className="stat-card">
        <CollapsibleTrigger className="w-full">
          <div className="flex items-center justify-between cursor-pointer group">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              <h3 className="font-semibold">Monatliche Überstunden-Übersicht</h3>
              <div className="flex items-center gap-1.5 px-2 py-0.5 bg-muted/50 rounded-md text-sm">
                <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{monthLabel}</span>
              </div>
            </div>
            <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-4 space-y-4">

            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="p-4 bg-muted/30 rounded-lg">
                <p className="text-sm text-muted-foreground">Soll-Stunden (gesamt)</p>
                <p className="text-2xl font-bold">{formatHours(totals.expectedHours)}</p>
              </div>
              <div className="p-4 bg-muted/30 rounded-lg">
                <p className="text-sm text-muted-foreground">Ist-Stunden (gesamt)</p>
                <p className="text-2xl font-bold">{formatHours(totals.actualHours)}</p>
              </div>
              <div className={`p-4 rounded-lg ${totals.overtimeHours > 0 ? 'bg-destructive/10' : 'bg-green-500/10'}`}>
                <p className="text-sm text-muted-foreground">Überstunden (gesamt)</p>
                <p className={`text-2xl font-bold ${getOvertimeColor(totals.overtimeHours)}`}>
                  {totals.overtimeHours > 0 ? '+' : ''}{formatHours(totals.overtimeHours)}
                </p>
              </div>
              <div className={`p-4 rounded-lg ${totals.overtimeCost > 0 ? 'bg-destructive/10' : 'bg-green-500/10'}`}>
                <p className="text-sm text-muted-foreground">Überstunden-Kosten</p>
                <p className={`text-2xl font-bold ${getOvertimeColor(totals.overtimeCost)}`}>
                  {totals.overtimeCost > 0 ? '+' : ''}{formatCurrency(totals.overtimeCost)}
                </p>
              </div>
            </div>

            {/* Employee Table */}
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Mitarbeiter</th>
                    <th>Abteilung</th>
                    <th className="text-right">Soll-Std.</th>
                    <th className="text-right">Ist-Std.</th>
                    <th className="text-right">Überstunden</th>
                    <th className="text-right">Kosten (CHF)</th>
                    <th className="text-right">Tage gearbeitet</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyData.map((data) => (
                    <tr key={data.employee.id}>
                      <td className="font-medium">{data.employee.name}</td>
                      <td className="capitalize">{data.employee.department}</td>
                      <td className="text-right font-mono">{formatHours(data.expectedHours)}</td>
                      <td className="text-right font-mono">{formatHours(data.actualHours)}</td>
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {getOvertimeIcon(data.overtimeHours)}
                          <span className={`font-mono ${getOvertimeColor(data.overtimeHours)}`}>
                            {data.overtimeHours > 0 ? '+' : ''}{formatHours(data.overtimeHours)}
                          </span>
                        </div>
                      </td>
                      <td className={`text-right font-mono ${getOvertimeColor(data.overtimeCost)}`}>
                        {data.overtimeCost > 0 ? '+' : ''}{formatCurrency(data.overtimeCost)}
                      </td>
                      <td className="text-right font-mono">{data.daysWorked}</td>
                    </tr>
                  ))}
                  {monthlyData.length === 0 && (
                    <tr>
                      <td colSpan={7} className="text-center text-muted-foreground py-8">
                        Keine Daten für diesen Monat vorhanden
                      </td>
                    </tr>
                  )}
                </tbody>
                {monthlyData.length > 0 && (
                  <tfoot>
                    <tr className="font-semibold bg-muted/50">
                      <td colSpan={2}>Gesamt</td>
                      <td className="text-right font-mono">{formatHours(totals.expectedHours)}</td>
                      <td className="text-right font-mono">{formatHours(totals.actualHours)}</td>
                      <td className={`text-right font-mono ${getOvertimeColor(totals.overtimeHours)}`}>
                        {totals.overtimeHours > 0 ? '+' : ''}{formatHours(totals.overtimeHours)}
                      </td>
                      <td className={`text-right font-mono ${getOvertimeColor(totals.overtimeCost)}`}>
                        {totals.overtimeCost > 0 ? '+' : ''}{formatCurrency(totals.overtimeCost)}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            <p className="text-xs text-muted-foreground">
              * Berechnung basiert auf {((employees[0]?.weeklyHours || 42) / 5 * 4.33 * 5).toFixed(1)} Soll-Stunden/Monat 
              (Wochenstunden ÷ 5 Tage × 4.33 Wochen × 5 Arbeitstage). Positive Werte = Überstunden, negative Werte = Minusstunden.
            </p>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};
