import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, ChevronRight, Euro, Clock, Users, TrendingUp, Palmtree, ThermometerSnowflake, Briefcase, HandCoins } from 'lucide-react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, addMonths, subMonths } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, Department } from '@/types/personnel';
import { ShiftType, CustomShift } from '@/pages/SchedulePlanner';
import { useShiftConfig } from '@/hooks/useShiftConfig';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { cn } from '@/lib/utils';

interface PlannedLaborCostCalculatorProps {
  employees: Employee[];
}

interface DepartmentCosts {
  department: Department;
  paidHours: number;
  unpaidHours: number;
  totalCost: number;
  employeeCount: number;
}

interface MonthlySalaryCosts {
  department: Department;
  fixedSalary: number; // Sum of monthlySalaryWith13th for Vollzeit
  variableCost: number; // Hourly workers cost estimate
  employeeCount: number;
  vollzeitCount: number;
}

export const PlannedLaborCostCalculator = ({ employees }: PlannedLaborCostCalculatorProps) => {
  const { shiftMap } = useShiftConfig();
  
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [scheduleData, setScheduleData] = useState<Record<string, ShiftType | null>>({});
  const [customShifts, setCustomShifts] = useState<Record<string, CustomShift>>({});
  const [scheduleEmployees, setScheduleEmployees] = useState<Employee[]>([]);

  // Load schedule data from localStorage
  useEffect(() => {
    const monthKey = format(currentMonth, 'yyyy-MM');
    const savedSchedule = localStorage.getItem(`schedule-${monthKey}`);
    const savedCustom = localStorage.getItem(`schedule-custom-${monthKey}`);
    const savedEmployees = localStorage.getItem('schedule-employees');

    if (savedSchedule) {
      setScheduleData(JSON.parse(savedSchedule));
    } else {
      setScheduleData({});
    }

    if (savedCustom) {
      setCustomShifts(JSON.parse(savedCustom));
    } else {
      setCustomShifts({});
    }

    if (savedEmployees) {
      setScheduleEmployees(JSON.parse(savedEmployees));
    } else {
      setScheduleEmployees(employees);
    }
  }, [currentMonth, employees]);

  // Get days in current month
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // Calculate costs and hours
  const calculations = useMemo(() => {
    const employeeStats: {[key: string]: { paidHours: number; unpaidHours: number; cost: number }} = {};
    
    // Merge employees from schedule with passed employees for hourly rates
    const employeeMap = new Map<string, Employee>();
    employees.forEach(e => employeeMap.set(e.id, e));
    scheduleEmployees.forEach(e => {
      if (!employeeMap.has(e.id)) {
        employeeMap.set(e.id, e);
      }
    });

    // Calculate per employee
    employeeMap.forEach((emp, empId) => {
      let paidHours = 0;
      let unpaidHours = 0;

      daysInMonth.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const cellKey = `${empId}-${dateStr}`;
        const shift = scheduleData[cellKey];
        const custom = customShifts[cellKey];

        if (custom) {
          paidHours += custom.hours;
        } else if (shift && shift in shiftMap) {
          const config = shiftMap[shift];
          if (config.isPaid) {
            paidHours += config.hours;
          } else if (config.countsToTarget) {
            // Ferien, Krank - counts to target but not paid
            unpaidHours += config.hours;
          }
          // Frei - doesn't count at all
        }
      });

      const cost = paidHours * (emp.hourlyWage || 0);
      employeeStats[empId] = { paidHours, unpaidHours, cost };
    });

    // Aggregate by department
    const departmentStats: {[key: string]: DepartmentCosts} = {
      service: { department: 'service', paidHours: 0, unpaidHours: 0, totalCost: 0, employeeCount: 0 },
      küche: { department: 'küche', paidHours: 0, unpaidHours: 0, totalCost: 0, employeeCount: 0 },
    };

    employeeMap.forEach((emp, empId) => {
      const stats = employeeStats[empId];
      if (stats && (stats.paidHours > 0 || stats.unpaidHours > 0)) {
        const dept = emp.department as Department;
        if (departmentStats[dept]) {
          departmentStats[dept].paidHours += stats.paidHours;
          departmentStats[dept].unpaidHours += stats.unpaidHours;
          departmentStats[dept].totalCost += stats.cost;
          departmentStats[dept].employeeCount += 1;
        }
      }
    });

    const totalPaidHours = Object.values(departmentStats).reduce((sum, d) => sum + d.paidHours, 0);
    const totalUnpaidHours = Object.values(departmentStats).reduce((sum, d) => sum + d.unpaidHours, 0);
    const totalCost = Object.values(departmentStats).reduce((sum, d) => sum + d.totalCost, 0);
    const totalEmployees = Object.values(departmentStats).reduce((sum, d) => sum + d.employeeCount, 0);

    return {
      employeeStats,
      departmentStats,
      totalPaidHours,
      totalUnpaidHours,
      totalCost,
      totalEmployees,
    };
  }, [scheduleData, customShifts, daysInMonth, employees, scheduleEmployees, shiftMap]);

  // Calculate monthly salary costs (fixed costs based on monthlySalaryWith13th)
  const monthlySalaryCosts = useMemo(() => {
    const employeeMap = new Map<string, Employee>();
    employees.forEach(e => employeeMap.set(e.id, e));
    scheduleEmployees.forEach(e => {
      // Prefer data from passed employees (has salary info)
      if (!employeeMap.has(e.id)) {
        employeeMap.set(e.id, e);
      }
    });

    const departmentSalaries: {[key: string]: MonthlySalaryCosts} = {
      service: { department: 'service', fixedSalary: 0, variableCost: 0, employeeCount: 0, vollzeitCount: 0 },
      küche: { department: 'küche', fixedSalary: 0, variableCost: 0, employeeCount: 0, vollzeitCount: 0 },
    };

    employeeMap.forEach((emp) => {
      const dept = emp.department as Department;
      if (!departmentSalaries[dept]) return;

      departmentSalaries[dept].employeeCount += 1;

      if (emp.employmentType === 'vollzeit' && emp.monthlySalaryWith13th) {
        // Vollzeit with monthly salary
        departmentSalaries[dept].fixedSalary += emp.monthlySalaryWith13th;
        departmentSalaries[dept].vollzeitCount += 1;
      } else {
        // Teilzeit/Aushilfe - estimate based on planned hours from schedule
        const stats = calculations.employeeStats[emp.id];
        if (stats) {
          departmentSalaries[dept].variableCost += stats.cost;
        }
      }
    });

    const totalFixedSalary = Object.values(departmentSalaries).reduce((sum, d) => sum + d.fixedSalary, 0);
    const totalVariableCost = Object.values(departmentSalaries).reduce((sum, d) => sum + d.variableCost, 0);
    const totalVollzeit = Object.values(departmentSalaries).reduce((sum, d) => sum + d.vollzeitCount, 0);
    const totalEmployees = Object.values(departmentSalaries).reduce((sum, d) => sum + d.employeeCount, 0);

    return {
      departmentSalaries,
      totalFixedSalary,
      totalVariableCost,
      totalCombined: totalFixedSalary + totalVariableCost,
      totalVollzeit,
      totalEmployees,
    };
  }, [employees, scheduleEmployees, calculations.employeeStats]);

  const hasData = calculations.totalPaidHours > 0 || calculations.totalUnpaidHours > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Euro className="h-5 w-5 text-primary" />
            Geplante Lohnkosten
          </CardTitle>
          
          {/* Month Navigation */}
          <div className="flex items-center gap-2">
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-8 w-8"
              onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium min-w-[100px] text-center">
              {format(currentMonth, 'MMMM yyyy', { locale: de })}
            </span>
            <Button 
              variant="ghost" 
              size="icon"
              className="h-8 w-8"
              onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <div className="text-center py-8 text-muted-foreground">
            <p>Keine Dienstplandaten für {format(currentMonth, 'MMMM yyyy', { locale: de })} vorhanden.</p>
            <p className="text-sm mt-1">Erstelle einen Dienstplan um die Kosten zu berechnen.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Total Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-primary/10 rounded-lg p-4 text-center">
                <Euro className="h-6 w-6 mx-auto mb-2 text-primary" />
                <p className="text-2xl font-bold text-primary">{formatCurrency(calculations.totalCost)}</p>
                <p className="text-xs text-muted-foreground">Gesamtkosten</p>
              </div>
              <div className="bg-blue-100 dark:bg-blue-900/30 rounded-lg p-4 text-center">
                <Clock className="h-6 w-6 mx-auto mb-2 text-blue-600" />
                <p className="text-2xl font-bold text-blue-600">{formatHours(calculations.totalPaidHours)}</p>
                <p className="text-xs text-muted-foreground">Bezahlte Stunden</p>
              </div>
              <div className="bg-amber-100 dark:bg-amber-900/30 rounded-lg p-4 text-center">
                <div className="flex justify-center gap-1 mb-2">
                  <Palmtree className="h-5 w-5 text-amber-600" />
                  <ThermometerSnowflake className="h-5 w-5 text-amber-600" />
                </div>
                <p className="text-2xl font-bold text-amber-600">{formatHours(calculations.totalUnpaidHours)}</p>
                <p className="text-xs text-muted-foreground">Ferien/Krank (unbezahlt)</p>
              </div>
              <div className="bg-muted rounded-lg p-4 text-center">
                <Users className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
                <p className="text-2xl font-bold">{calculations.totalEmployees}</p>
                <p className="text-xs text-muted-foreground">Mitarbeiter eingeplant</p>
              </div>
            </div>

            {/* Department Breakdown */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(['service', 'küche'] as Department[]).map(dept => {
                const stats = calculations.departmentStats[dept];
                const percentage = calculations.totalCost > 0 
                  ? (stats.totalCost / calculations.totalCost) * 100 
                  : 0;
                
                return (
                  <div 
                    key={dept}
                    className={cn(
                      "rounded-lg border p-4",
                      dept === 'service' ? "border-blue-200 dark:border-blue-800" : "border-orange-200 dark:border-orange-800"
                    )}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "w-3 h-3 rounded-full",
                          dept === 'service' ? "bg-blue-500" : "bg-orange-500"
                        )} />
                        <span className="font-semibold capitalize">{dept}</span>
                        <Badge variant="outline" className="text-xs">
                          {stats.employeeCount} MA
                        </Badge>
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {percentage.toFixed(0)}%
                      </span>
                    </div>
                    
                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">Lohnkosten:</span>
                        <span className="font-semibold">{formatCurrency(stats.totalCost)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">Bezahlte Stunden:</span>
                        <span className="font-mono text-sm">{formatHours(stats.paidHours)}</span>
                      </div>
                      {stats.unpaidHours > 0 && (
                        <div className="flex justify-between text-amber-600">
                          <span className="text-sm">Ferien/Krank:</span>
                          <span className="font-mono text-sm">{formatHours(stats.unpaidHours)}</span>
                        </div>
                      )}
                    </div>
                    
                    {/* Progress bar */}
                    <div className="mt-3 h-2 bg-muted rounded-full overflow-hidden">
                      <div 
                        className={cn(
                          "h-full transition-all",
                          dept === 'service' ? "bg-blue-500" : "bg-orange-500"
                        )}
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Monthly Salary Costs (Fixed + Variable) */}
            {monthlySalaryCosts.totalFixedSalary > 0 && (
              <div className="rounded-lg border-2 border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-900/20 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Briefcase className="h-5 w-5 text-green-600" />
                    <span className="font-semibold text-green-700 dark:text-green-400">Monatliche Gesamtpersonalkosten</span>
                  </div>
                  <Badge className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
                    {monthlySalaryCosts.totalVollzeit} VZ / {monthlySalaryCosts.totalEmployees} MA
                  </Badge>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-white dark:bg-background rounded-lg p-3 text-center border border-green-200 dark:border-green-800">
                    <Briefcase className="h-5 w-5 mx-auto mb-1 text-green-600" />
                    <p className="text-xl font-bold text-green-600">{formatCurrency(monthlySalaryCosts.totalFixedSalary)}</p>
                    <p className="text-xs text-muted-foreground">Fixlöhne (inkl. 13. ML)</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{monthlySalaryCosts.totalVollzeit} Vollzeit-MA</p>
                  </div>
                  <div className="bg-white dark:bg-background rounded-lg p-3 text-center border border-green-200 dark:border-green-800">
                    <HandCoins className="h-5 w-5 mx-auto mb-1 text-amber-600" />
                    <p className="text-xl font-bold text-amber-600">{formatCurrency(monthlySalaryCosts.totalVariableCost)}</p>
                    <p className="text-xs text-muted-foreground">Variable Kosten</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Teilzeit/Aushilfe</p>
                  </div>
                  <div className="bg-green-100 dark:bg-green-800/50 rounded-lg p-3 text-center">
                    <Euro className="h-5 w-5 mx-auto mb-1 text-green-700 dark:text-green-300" />
                    <p className="text-xl font-bold text-green-700 dark:text-green-300">{formatCurrency(monthlySalaryCosts.totalCombined)}</p>
                    <p className="text-xs text-green-600 dark:text-green-400">Gesamtkosten Monat</p>
                  </div>
                </div>

                {/* Department breakdown for salaries */}
                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-green-200 dark:border-green-700">
                  {(['service', 'küche'] as Department[]).map(dept => {
                    const salaryStats = monthlySalaryCosts.departmentSalaries[dept];
                    const deptTotal = salaryStats.fixedSalary + salaryStats.variableCost;
                    return (
                      <div key={dept} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "w-2 h-2 rounded-full",
                            dept === 'service' ? "bg-blue-500" : "bg-orange-500"
                          )} />
                          <span className="capitalize text-muted-foreground">{dept}:</span>
                        </div>
                        <div className="text-right">
                          <span className="font-semibold">{formatCurrency(deptTotal)}</span>
                          <span className="text-xs text-muted-foreground ml-1">
                            ({salaryStats.vollzeitCount} VZ)
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Average hourly cost */}
            {calculations.totalPaidHours > 0 && (
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Durchschnittlicher Stundensatz:</span>
                </div>
                <span className="font-semibold">
                  {formatCurrency(calculations.totalCost / calculations.totalPaidHours)}/h
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
