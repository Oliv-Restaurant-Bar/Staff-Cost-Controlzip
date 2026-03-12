import { useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Employee, TimeEntry, DailyBudget, HourlyRevenue } from '@/types/personnel';
import { formatCurrency } from '@/lib/personnel-utils';
import { format, startOfWeek, endOfWeek, eachDayOfInterval, addDays } from 'date-fns';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { ChevronDown, Users, TrendingUp, Clock, AlertTriangle, CheckCircle, Utensils, Wine } from 'lucide-react';

interface ShiftRevenueComparisonProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
  showNetRevenue?: boolean;
}

interface HourlyStaffing {
  hour: number;
  employees: { id: string; name: string; department: string; wage: number }[];
  revenue: number;
  foodRevenue: number; // For Küche analysis
  beverageRevenue: number; // For Service analysis
  laborCost: number;
  efficiency: number; // Revenue per employee per hour
  kücheEfficiency: number; // Food revenue / Küche employees
  serviceEfficiency: number; // Beverage revenue / Service employees
}

interface OptimizationSuggestion {
  type: 'overstaffed' | 'understaffed' | 'optimal';
  department?: 'küche' | 'service' | 'all';
  hour: number;
  message: string;
  potentialSaving?: number;
}

export const ShiftRevenueComparison = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
  showNetRevenue = false,
}: ShiftRevenueComparisonProps) => {
  const [viewMode, setViewMode] = useState<'day' | 'week'>('day');
  
  const dateString = format(selectedDate, 'yyyy-MM-dd');
  const budget = dailyBudgets[dateString];
  const hasHourlyData = budget?.hourlyRevenue && budget.hourlyRevenue.length > 0;

  // Parse time entries to get hourly presence
  const getEmployeeHours = (entry: TimeEntry): number[] => {
    const hours: number[] = [];
    
    // Use actual times if available, otherwise planned times
    const startTime = entry.actualStart || entry.plannedStart;
    const endTime = entry.actualEnd || entry.plannedEnd;
    
    if (!startTime || !endTime) return hours;
    
    const [startH] = startTime.split(':').map(Number);
    const [endH] = endTime.split(':').map(Number);
    
    // Handle shifts that might cross midnight
    let h = startH;
    while (h !== endH) {
      hours.push(h);
      h = (h + 1) % 24;
      // Safety: prevent infinite loop
      if (hours.length > 24) break;
    }
    
    return hours;
  };

  // Calculate hourly staffing data
  const hourlyData = useMemo((): HourlyStaffing[] => {
    const dayEntries = timeEntries.filter(e => e.date === dateString);
    const hourlyRevenue = budget?.hourlyRevenue || [];
    
    const data: HourlyStaffing[] = [];
    
    // Focus on typical restaurant hours (10:00 - 24:00)
    for (let hour = 10; hour <= 23; hour++) {
      const employeesPresent: { id: string; name: string; department: string; wage: number }[] = [];
      
      dayEntries.forEach(entry => {
        const hours = getEmployeeHours(entry);
        if (hours.includes(hour)) {
          const emp = employees.find(e => e.id === entry.employeeId);
          if (emp) {
            employeesPresent.push({
              id: emp.id,
              name: emp.name,
              department: emp.department,
              wage: emp.hourlyWage,
            });
          }
        }
      });
      
      const hourData = hourlyRevenue.find(h => h.hour === hour);
      const hourRevenue = hourData?.revenue || 0;
      const foodRevenue = hourData?.food || 0;
      const beverageRevenue = hourData?.beverage || 0;
      
      const laborCost = employeesPresent.reduce((sum, e) => sum + e.wage, 0);
      const efficiency = employeesPresent.length > 0 ? hourRevenue / employeesPresent.length : 0;
      
      // Department-specific efficiency
      const kücheEmployees = employeesPresent.filter(e => e.department === 'küche');
      const serviceEmployees = employeesPresent.filter(e => e.department === 'service');
      const kücheEfficiency = kücheEmployees.length > 0 ? foodRevenue / kücheEmployees.length : 0;
      const serviceEfficiency = serviceEmployees.length > 0 ? beverageRevenue / serviceEmployees.length : 0;
      
      data.push({
        hour,
        employees: employeesPresent,
        revenue: hourRevenue,
        foodRevenue,
        beverageRevenue,
        laborCost,
        efficiency,
        kücheEfficiency,
        serviceEfficiency,
      });
    }
    
    return data;
  }, [timeEntries, employees, budget, dateString]);

  // Generate optimization suggestions with department-specific analysis
  const suggestions = useMemo((): OptimizationSuggestion[] => {
    if (!hasHourlyData) return [];
    
    const suggestions: OptimizationSuggestion[] = [];
    const totalRevenue = hourlyData.reduce((sum, h) => sum + h.revenue, 0);
    const totalFood = hourlyData.reduce((sum, h) => sum + h.foodRevenue, 0);
    const totalBeverage = hourlyData.reduce((sum, h) => sum + h.beverageRevenue, 0);
    const hasFoodBeverageData = totalFood > 0 || totalBeverage > 0;
    
    hourlyData.forEach(data => {
      const kücheEmployees = data.employees.filter(e => e.department === 'küche');
      const serviceEmployees = data.employees.filter(e => e.department === 'service');
      const kücheWages = kücheEmployees.reduce((sum, e) => sum + e.wage, 0);
      const serviceWages = serviceEmployees.reduce((sum, e) => sum + e.wage, 0);
      
      if (hasFoodBeverageData) {
        // Department-specific analysis: Küche vs Food
        const foodPercent = totalFood > 0 ? (data.foodRevenue / totalFood) * 100 : 0;
        if (kücheEmployees.length >= 2 && foodPercent < 3 && data.foodRevenue > 0) {
          const excessStaff = Math.max(0, kücheEmployees.length - 1);
          const avgWage = kücheWages / kücheEmployees.length;
          suggestions.push({
            type: 'overstaffed',
            department: 'küche',
            hour: data.hour,
            message: `${data.hour}:00 Küche - ${kücheEmployees.length} MA bei nur ${formatCurrency(data.foodRevenue)} Food-Umsatz (${foodPercent.toFixed(1)}%)`,
            potentialSaving: excessStaff * avgWage,
          });
        }
        
        // High Food revenue but few kitchen staff
        if (kücheEmployees.length <= 1 && foodPercent > 10 && data.foodRevenue > 0) {
          suggestions.push({
            type: 'understaffed',
            department: 'küche',
            hour: data.hour,
            message: `${data.hour}:00 Küche - Nur ${kücheEmployees.length} MA bei ${formatCurrency(data.foodRevenue)} Food-Umsatz (${foodPercent.toFixed(1)}%)`,
          });
        }
        
        // Department-specific analysis: Service vs Beverage
        const beveragePercent = totalBeverage > 0 ? (data.beverageRevenue / totalBeverage) * 100 : 0;
        if (serviceEmployees.length >= 2 && beveragePercent < 3 && data.beverageRevenue > 0) {
          const excessStaff = Math.max(0, serviceEmployees.length - 1);
          const avgWage = serviceWages / serviceEmployees.length;
          suggestions.push({
            type: 'overstaffed',
            department: 'service',
            hour: data.hour,
            message: `${data.hour}:00 Service - ${serviceEmployees.length} MA bei nur ${formatCurrency(data.beverageRevenue)} Beverage-Umsatz (${beveragePercent.toFixed(1)}%)`,
            potentialSaving: excessStaff * avgWage,
          });
        }
        
        // High Beverage revenue but few service staff
        if (serviceEmployees.length <= 1 && beveragePercent > 10 && data.beverageRevenue > 0) {
          suggestions.push({
            type: 'understaffed',
            department: 'service',
            hour: data.hour,
            message: `${data.hour}:00 Service - Nur ${serviceEmployees.length} MA bei ${formatCurrency(data.beverageRevenue)} Beverage-Umsatz (${beveragePercent.toFixed(1)}%)`,
          });
        }
        
        // Good department efficiency
        if (data.kücheEfficiency > 100 && data.foodRevenue > 0) {
          suggestions.push({
            type: 'optimal',
            department: 'küche',
            hour: data.hour,
            message: `${data.hour}:00 Küche - Gute Effizienz: ${formatCurrency(data.kücheEfficiency)} Food/MA`,
          });
        }
        if (data.serviceEfficiency > 80 && data.beverageRevenue > 0) {
          suggestions.push({
            type: 'optimal',
            department: 'service',
            hour: data.hour,
            message: `${data.hour}:00 Service - Gute Effizienz: ${formatCurrency(data.serviceEfficiency)} Beverage/MA`,
          });
        }
      } else {
        // Fallback: General analysis without Food/Beverage split
        const revenuePercent = totalRevenue > 0 ? (data.revenue / totalRevenue) * 100 : 0;
        
        if (data.employees.length >= 3 && revenuePercent < 3 && data.revenue > 0) {
          const excessStaff = Math.max(0, data.employees.length - 2);
          const avgWage = data.laborCost / data.employees.length;
          suggestions.push({
            type: 'overstaffed',
            department: 'all',
            hour: data.hour,
            message: `${data.hour}:00 - ${data.employees.length} MA bei nur ${formatCurrency(data.revenue)} Umsatz (${revenuePercent.toFixed(1)}%)`,
            potentialSaving: excessStaff * avgWage,
          });
        }
        
        if (data.employees.length <= 2 && revenuePercent > 10) {
          suggestions.push({
            type: 'understaffed',
            department: 'all',
            hour: data.hour,
            message: `${data.hour}:00 - Nur ${data.employees.length} MA bei ${formatCurrency(data.revenue)} Umsatz (${revenuePercent.toFixed(1)}%)`,
          });
        }
      }
    });
    
    // Sort: overstaffed first (actionable savings), then understaffed, then optimal
    return suggestions
      .sort((a, b) => {
        const order = { overstaffed: 0, understaffed: 1, optimal: 2 };
        return order[a.type] - order[b.type];
      })
      .slice(0, 8); // Show more suggestions now that we have dept-specific ones
  }, [hourlyData, hasHourlyData]);

  // Get color based on efficiency
  const getEfficiencyColor = (efficiency: number, revenue: number): string => {
    if (revenue === 0) return 'bg-gray-100 dark:bg-gray-800';
    if (efficiency >= 150) return 'bg-green-100 dark:bg-green-900/30';
    if (efficiency >= 80) return 'bg-blue-100 dark:bg-blue-900/30';
    if (efficiency >= 40) return 'bg-yellow-100 dark:bg-yellow-900/30';
    return 'bg-red-100 dark:bg-red-900/30';
  };

  const formatTime = (hour: number): string => {
    return `${String(hour).padStart(2, '0')}:00`;
  };

  // Calculate summary stats with department breakdown
  const summaryStats = useMemo(() => {
    const totalRevenue = hourlyData.reduce((sum, h) => sum + h.revenue, 0);
    const totalFood = hourlyData.reduce((sum, h) => sum + h.foodRevenue, 0);
    const totalBeverage = hourlyData.reduce((sum, h) => sum + h.beverageRevenue, 0);
    const totalLaborCost = hourlyData.reduce((sum, h) => sum + h.laborCost, 0);
    const peakHour = hourlyData.reduce((max, h) => h.revenue > max.revenue ? h : max, hourlyData[0]);
    
    // Calculate department-specific stats
    let kücheSaving = 0;
    let serviceSaving = 0;
    let kücheLowHours: number[] = [];
    let serviceLowHours: number[] = [];
    
    hourlyData.forEach(h => {
      const kücheEmployees = h.employees.filter(e => e.department === 'küche');
      const serviceEmployees = h.employees.filter(e => e.department === 'service');
      const kücheWages = kücheEmployees.reduce((sum, e) => sum + e.wage, 0);
      const serviceWages = serviceEmployees.reduce((sum, e) => sum + e.wage, 0);
      
      const foodPercent = totalFood > 0 ? (h.foodRevenue / totalFood) * 100 : 0;
      const beveragePercent = totalBeverage > 0 ? (h.beverageRevenue / totalBeverage) * 100 : 0;
      
      // Küche overstaffed check
      if (kücheEmployees.length >= 2 && foodPercent < 3 && h.foodRevenue > 0) {
        const excessStaff = Math.max(0, kücheEmployees.length - 1);
        const avgWage = kücheWages / kücheEmployees.length;
        kücheSaving += excessStaff * avgWage;
        kücheLowHours.push(h.hour);
      }
      
      // Service overstaffed check
      if (serviceEmployees.length >= 2 && beveragePercent < 3 && h.beverageRevenue > 0) {
        const excessStaff = Math.max(0, serviceEmployees.length - 1);
        const avgWage = serviceWages / serviceEmployees.length;
        serviceSaving += excessStaff * avgWage;
        serviceLowHours.push(h.hour);
      }
    });

    // Daily savings = hourly savings × overstaffed hours
    const kücheDailySaving = kücheSaving * kücheLowHours.length;
    const serviceDailySaving = serviceSaving * serviceLowHours.length;
    const totalDailySaving = kücheDailySaving + serviceDailySaving;

    // Monthly projection (30 days - business open daily)
    const daysPerMonth = 30;
    const kücheMonthly = kücheDailySaving * daysPerMonth;
    const serviceMonthly = serviceDailySaving * daysPerMonth;
    const totalMonthly = totalDailySaving * daysPerMonth;
    
    return {
      totalRevenue,
      totalFood,
      totalBeverage,
      totalLaborCost,
      peakHour: peakHour?.hour || 0,
      peakRevenue: peakHour?.revenue || 0,
      kücheSaving,
      serviceSaving,
      kücheLowHours,
      serviceLowHours,
      totalSaving: kücheSaving + serviceSaving,
      hasDepartmentData: totalFood > 0 || totalBeverage > 0,
      // Daily and monthly projections
      kücheDailySaving,
      serviceDailySaving,
      totalDailySaving,
      kücheMonthly,
      serviceMonthly,
      totalMonthly,
    };
  }, [hourlyData]);

  if (!hasHourlyData) {
    return (
      <Collapsible>
        <Card>
          <CollapsibleTrigger className="w-full">
            <CardHeader className="cursor-pointer">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="h-5 w-5 text-muted-foreground" />
                  <CardTitle className="text-lg">Schicht-Umsatz Vergleich</CardTitle>
                </div>
                <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent>
              <div className="text-center py-8 text-muted-foreground">
                <Clock className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p className="font-medium">Keine Stundenumsätze vorhanden</p>
                <p className="text-sm mt-1">
                  Importiere eine Tagesumsatz-Datei im Bereich "Stündlicher Tagesumsatz" um die Analyse zu aktivieren.
                </p>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    );
  }

  return (
    <Collapsible defaultOpen>
      <Card>
        <CollapsibleTrigger className="w-full">
          <CardHeader className="cursor-pointer">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-primary" />
                <div className="text-left">
                  <CardTitle className="text-lg">Schicht-Umsatz Vergleich</CardTitle>
                  <CardDescription>
                    {format(selectedDate, 'EEEE, dd. MMMM yyyy', { locale: de })}
                  </CardDescription>
                </div>
              </div>
              <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-6">
            {/* Summary Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground">Tagesumsatz</p>
                <p className="text-lg font-bold">{formatCurrency(summaryStats.totalRevenue)}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground">Peak Stunde</p>
                <p className="text-lg font-bold">{formatTime(summaryStats.peakHour)}</p>
                <p className="text-xs text-muted-foreground">{formatCurrency(summaryStats.peakRevenue)}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground">Personalkosten</p>
                <p className="text-lg font-bold">{formatCurrency(summaryStats.totalLaborCost)}</p>
              </div>
              {summaryStats.totalSaving > 0 && (
                <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30">
                  <p className="text-xs text-amber-700 dark:text-amber-400">Einsparpotential</p>
                  <p className="text-lg font-bold text-amber-700 dark:text-amber-400">
                    {formatCurrency(summaryStats.totalSaving)}
                  </p>
                </div>
              )}
            </div>

            {/* Hourly Matrix */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="font-medium text-sm">Stundenübersicht</h4>
                <div className="flex gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-green-200" /> Effizient</span>
                  <span className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-yellow-200" /> OK</span>
                  <span className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-red-200" /> Überbesetzt</span>
                </div>
              </div>
              
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="py-2 px-2 text-left font-medium">Zeit</th>
                      <th className="py-2 px-2 text-right font-medium">Umsatz</th>
                      <th className="py-2 px-2 text-center font-medium">MA</th>
                      <th className="py-2 px-2 text-right font-medium">PK</th>
                      <th className="py-2 px-2 text-right font-medium">CHF/MA</th>
                      <th className="py-2 px-2 text-left font-medium">Anwesende Mitarbeiter</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hourlyData.map((data) => (
                      <tr 
                        key={data.hour} 
                        className={cn(
                          'border-b transition-colors',
                          getEfficiencyColor(data.efficiency, data.revenue)
                        )}
                      >
                        <td className="py-2 px-2 font-mono font-medium">
                          {formatTime(data.hour)}
                        </td>
                        <td className="py-2 px-2 text-right font-mono">
                          {data.revenue > 0 ? formatCurrency(data.revenue) : '-'}
                        </td>
                        <td className="py-2 px-2 text-center">
                          <Badge 
                            variant={data.employees.length > 0 ? 'default' : 'secondary'}
                            className="min-w-[24px]"
                          >
                            {data.employees.length}
                          </Badge>
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-muted-foreground">
                          {data.laborCost > 0 ? formatCurrency(data.laborCost) : '-'}
                        </td>
                        <td className="py-2 px-2 text-right font-mono">
                          {data.efficiency > 0 ? formatCurrency(data.efficiency) : '-'}
                        </td>
                        <td className="py-2 px-2">
                          <div className="flex flex-wrap gap-1">
                            {data.employees.slice(0, 4).map((emp) => (
                              <Badge 
                                key={emp.id} 
                                variant="outline" 
                                className={cn(
                                  "text-xs",
                                  emp.department === 'service' ? 'border-blue-300' : 'border-amber-300'
                                )}
                              >
                                {emp.name.split(' ')[0]}
                              </Badge>
                            ))}
                            {data.employees.length > 4 && (
                              <Badge variant="secondary" className="text-xs">
                                +{data.employees.length - 4}
                              </Badge>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Optimization Suggestions */}
            {suggestions.length > 0 && (
              <div className="space-y-2">
                <h4 className="font-medium text-sm flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Optimierungshinweise
                </h4>
                <div className="space-y-2">
                  {suggestions.map((suggestion, i) => (
                    <div
                      key={i}
                      className={cn(
                        "flex items-start gap-2 p-2 rounded-lg text-sm",
                        suggestion.type === 'overstaffed' && "bg-red-50 dark:bg-red-950/30",
                        suggestion.type === 'understaffed' && "bg-amber-50 dark:bg-amber-950/30",
                        suggestion.type === 'optimal' && "bg-green-50 dark:bg-green-950/30"
                      )}
                    >
                      {suggestion.type === 'overstaffed' && (
                        <Users className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
                      )}
                      {suggestion.type === 'understaffed' && (
                        <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
                      )}
                      {suggestion.type === 'optimal' && (
                        <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          {suggestion.department && suggestion.department !== 'all' && (
                            <Badge 
                              variant="outline" 
                              className={cn(
                                "text-xs",
                                suggestion.department === 'küche' && "border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400",
                                suggestion.department === 'service' && "border-blue-400 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400"
                              )}
                            >
                              {suggestion.department === 'küche' ? (
                                <><Utensils className="h-3 w-3 mr-1" /> Küche</>
                              ) : (
                                <><Wine className="h-3 w-3 mr-1" /> Service</>
                              )}
                            </Badge>
                          )}
                          <span>{suggestion.message}</span>
                        </div>
                        {suggestion.potentialSaving && (
                          <Badge variant="outline" className="mt-1 text-xs">
                            Einsparung: ~{formatCurrency(suggestion.potentialSaving)}/Std
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Department Savings Summary */}
            {summaryStats.hasDepartmentData && summaryStats.totalSaving > 0 && (
              <div className="space-y-3 pt-4 border-t">
                <h4 className="font-medium text-sm flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-500" />
                  Einsparpotenzial nach Abteilung
                </h4>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Küche Summary */}
                  <div className={cn(
                    "p-4 rounded-lg border",
                    summaryStats.kücheSaving > 0 
                      ? "bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800" 
                      : "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800"
                  )}>
                    <div className="flex items-center gap-2 mb-2">
                      <Utensils className="h-4 w-4 text-amber-600" />
                      <span className="font-medium">Küche</span>
                      <Badge variant="outline" className="text-xs">Food-Umsatz</Badge>
                    </div>
                    {summaryStats.kücheSaving > 0 ? (
                      <>
                        <p className="text-2xl font-bold text-amber-700 dark:text-amber-400">
                          {formatCurrency(summaryStats.kücheSaving)}/Std
                        </p>
                        <p className="text-sm text-muted-foreground mt-1">
                          Überbesetzung in {summaryStats.kücheLowHours.length} Stunden: {summaryStats.kücheLowHours.map(h => `${h}:00`).join(', ')}
                        </p>
                        <p className="text-xs text-amber-600 mt-2">
                          → Küchenpersonal früher nach Hause schicken bei niedrigem Food-Umsatz
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-green-600 dark:text-green-400">
                        ✓ Küche optimal besetzt
                      </p>
                    )}
                  </div>

                  {/* Service Summary */}
                  <div className={cn(
                    "p-4 rounded-lg border",
                    summaryStats.serviceSaving > 0 
                      ? "bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800" 
                      : "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800"
                  )}>
                    <div className="flex items-center gap-2 mb-2">
                      <Wine className="h-4 w-4 text-blue-600" />
                      <span className="font-medium">Service</span>
                      <Badge variant="outline" className="text-xs">Beverage-Umsatz</Badge>
                    </div>
                    {summaryStats.serviceSaving > 0 ? (
                      <>
                        <p className="text-2xl font-bold text-blue-700 dark:text-blue-400">
                          {formatCurrency(summaryStats.serviceSaving)}/Std
                        </p>
                        <p className="text-sm text-muted-foreground mt-1">
                          Überbesetzung in {summaryStats.serviceLowHours.length} Stunden: {summaryStats.serviceLowHours.map(h => `${h}:00`).join(', ')}
                        </p>
                        <p className="text-xs text-blue-600 mt-2">
                          → Servicepersonal früher nach Hause schicken bei niedrigem Getränke-Umsatz
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-green-600 dark:text-green-400">
                        ✓ Service optimal besetzt
                      </p>
                    )}
                  </div>
                </div>

                {/* Total Savings Summary with Daily & Monthly Projections */}
                <div className="space-y-3">
                  {/* Per Hour Summary */}
                  <div className="p-3 rounded-lg bg-muted/50 border">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm">Pro Stunde (Überbesetzung):</span>
                      <span className="text-lg font-bold">{formatCurrency(summaryStats.totalSaving)}</span>
                    </div>
                  </div>

                  {/* Daily Savings */}
                  <div className="p-4 rounded-lg bg-gradient-to-r from-amber-50 to-blue-50 dark:from-amber-950/20 dark:to-blue-950/20 border">
                    <div className="flex items-center gap-2 mb-3">
                      <Clock className="h-4 w-4 text-primary" />
                      <span className="font-medium">Tägliches Einsparpotenzial</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-center">
                      <div>
                        <p className="text-xs text-amber-600 dark:text-amber-400 mb-1">Küche</p>
                        <p className="font-bold text-amber-700 dark:text-amber-300">
                          {formatCurrency(summaryStats.kücheDailySaving)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          ({summaryStats.kücheLowHours.length} Std)
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-blue-600 dark:text-blue-400 mb-1">Service</p>
                        <p className="font-bold text-blue-700 dark:text-blue-300">
                          {formatCurrency(summaryStats.serviceDailySaving)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          ({summaryStats.serviceLowHours.length} Std)
                        </p>
                      </div>
                      <div className="bg-white/50 dark:bg-black/20 rounded-lg p-2">
                        <p className="text-xs text-muted-foreground mb-1">Gesamt/Tag</p>
                        <p className="text-xl font-bold text-primary">
                          {formatCurrency(summaryStats.totalDailySaving)}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Monthly Projection */}
                  <div className="p-4 rounded-lg bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950/20 dark:to-emerald-950/20 border border-green-200 dark:border-green-800">
                    <div className="flex items-center gap-2 mb-3">
                      <TrendingUp className="h-4 w-4 text-green-600" />
                      <span className="font-medium">Monatliche Hochrechnung</span>
                      <Badge variant="outline" className="text-xs">30 Tage/Monat</Badge>
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-center">
                      <div>
                        <p className="text-xs text-amber-600 dark:text-amber-400 mb-1">Küche</p>
                        <p className="font-bold text-amber-700 dark:text-amber-300">
                          {formatCurrency(summaryStats.kücheMonthly)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-blue-600 dark:text-blue-400 mb-1">Service</p>
                        <p className="font-bold text-blue-700 dark:text-blue-300">
                          {formatCurrency(summaryStats.serviceMonthly)}
                        </p>
                      </div>
                      <div className="bg-green-100/50 dark:bg-green-900/30 rounded-lg p-2">
                        <p className="text-xs text-green-600 dark:text-green-400 mb-1">Gesamt/Monat</p>
                        <p className="text-2xl font-bold text-green-700 dark:text-green-400">
                          {formatCurrency(summaryStats.totalMonthly)}
                        </p>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-3 text-center">
                      Potenzielle monatliche Einsparung bei optimierter Personalplanung
                    </p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
};
