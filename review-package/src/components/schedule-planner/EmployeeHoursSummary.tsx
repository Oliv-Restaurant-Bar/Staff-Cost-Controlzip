import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Employee } from '@/types/personnel';
import { getEmployeeDisplayName } from '@/lib/personnel-utils';
import { cn } from '@/lib/utils';
import { CheckCircle, TrendingDown, TrendingUp, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useState } from 'react';

interface EmployeeSummary {
  employee: Employee;
  plannedHours: number;
  targetHours: number;
  difference: number;
  percentage: number;
  status: 'ok' | 'under' | 'over' | 'warning';
}

interface EmployeeHoursSummaryProps {
  summaries: EmployeeSummary[];
  /** Estimated monthly hours from Personal FIX (empId → hours) */
  varEstimatedHours?: Record<string, number>;
  /** Actual hours this month (empId → hours) */
  actualHoursPerEmp?: Record<string, number>;
}

/** Returns true for hourly/variable employees (no fixed monthly salary) */
function isVariableEmp(emp: Employee): boolean {
  return !((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && (emp.monthlySalary ?? 0) > 0);
}

export const EmployeeHoursSummary = ({
  summaries,
  varEstimatedHours = {},
  actualHoursPerEmp = {},
}: EmployeeHoursSummaryProps) => {
  const serviceSummaries = summaries.filter(s => s.employee.department === 'service');
  const kitchenSummaries = summaries.filter(s => s.employee.department === 'küche');

  const [serviceOpen, setServiceOpen] = useState(false);
  const [kitchenOpen, setKitchenOpen] = useState(false);

  const renderSummaryList = (
    items: EmployeeSummary[],
    title: string,
    isOpen: boolean,
    setIsOpen: (open: boolean) => void,
  ) => {
    if (items.length === 0) return null;

    return (
      <Card>
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <CardHeader className="pb-3">
            <CollapsibleTrigger className="flex items-center gap-2 w-full text-left cursor-pointer hover:text-primary transition-colors">
              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <CardTitle className="text-base">{title} - Stunden-Übersicht</CardTitle>
              <span className="text-xs text-muted-foreground ml-auto">
                {items.length} Mitarbeiter
              </span>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent>
            <CardContent>
              <div className="space-y-3">
                {items.map(({ employee, plannedHours, targetHours, difference, percentage, status }) => {
                  const estimated = varEstimatedHours[employee.id] ?? 0;
                  const actualHrs = actualHoursPerEmp[employee.id] ?? 0;
                  const isVar = isVariableEmp(employee);
                  const planExceedsEstimate = isVar && estimated > 0 && plannedHours > estimated;
                  const istDiff = isVar && estimated > 0 && actualHrs > 0 ? actualHrs - estimated : null;

                  return (
                    <div key={employee.id} className="space-y-1">
                      <div className="flex items-center gap-4">
                        <div className="w-32 shrink-0">
                          <div className="font-medium text-sm truncate flex items-center gap-1">
                            {getEmployeeDisplayName(employee)}
                            {planExceedsEstimate && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <AlertTriangle className="h-3.5 w-3.5 text-orange-500 shrink-0" />
                                </TooltipTrigger>
                                <TooltipContent>
                                  Geplant ({plannedHours.toFixed(1)}h) überschreitet Schätzung ({estimated.toFixed(1)}h)
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {employee.employmentType === 'vollzeit' && 'Vollzeit'}
                            {employee.employmentType === 'teilzeit' && 'Teilzeit'}
                            {employee.employmentType === 'minijob' && 'Minijob'}
                            {employee.employmentType === 'aushilfe' && 'Aushilfe'}
                          </div>
                        </div>

                        <div className="flex-1 min-w-[200px]">
                          <Progress
                            value={Math.min(percentage, 100)}
                            className={cn(
                              "h-2",
                              status === 'ok' && "[&>div]:bg-success",
                              status === 'warning' && "[&>div]:bg-warning",
                              status === 'under' && "[&>div]:bg-destructive",
                              status === 'over' && "[&>div]:bg-destructive"
                            )}
                          />
                        </div>

                        <div className="w-24 text-right shrink-0">
                          <span className={cn(
                            "font-semibold",
                            status === 'ok' && "text-success",
                            status === 'warning' && "text-warning",
                            status === 'under' && "text-destructive",
                            status === 'over' && "text-destructive"
                          )}>
                            {plannedHours.toFixed(1)}h
                          </span>
                          <span className="text-muted-foreground text-sm"> / {targetHours.toFixed(1)}h</span>
                        </div>

                        <div className="w-24 shrink-0 flex items-center gap-1">
                          {status === 'ok' && (
                            <>
                              <CheckCircle className="h-4 w-4 text-success" />
                              <span className="text-xs text-success">Im Ziel</span>
                            </>
                          )}
                          {status === 'warning' && (
                            <>
                              <TrendingDown className="h-4 w-4 text-warning" />
                              <span className="text-xs text-warning">{difference.toFixed(1)}h</span>
                            </>
                          )}
                          {status === 'under' && (
                            <>
                              <TrendingDown className="h-4 w-4 text-destructive" />
                              <span className="text-xs text-destructive">{difference.toFixed(1)}h</span>
                            </>
                          )}
                          {status === 'over' && (
                            <>
                              <TrendingUp className="h-4 w-4 text-destructive" />
                              <span className="text-xs text-destructive">+{difference.toFixed(1)}h</span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Estimated hours hint for variable employees */}
                      {isVar && estimated > 0 && (
                        <div className={cn(
                          'ml-32 pl-0 text-xs flex items-center gap-3 flex-wrap',
                          planExceedsEstimate
                            ? 'text-orange-600 dark:text-orange-400'
                            : 'text-muted-foreground',
                        )}>
                          <span>
                            Schätzung: <strong>{estimated.toFixed(1)}h</strong>
                            {' · '}
                            Plan: <strong className={planExceedsEstimate ? 'text-orange-600 dark:text-orange-400' : ''}>
                              {planExceedsEstimate ? `+${(plannedHours - estimated).toFixed(1)}h` : `${(plannedHours - estimated).toFixed(1)}h`}
                            </strong>
                          </span>
                          {istDiff !== null && (
                            <span className={cn(
                              'ml-2',
                              istDiff > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400',
                            )}>
                              Ist: <strong>{actualHrs.toFixed(1)}h</strong>
                              {' '}
                              ({istDiff > 0 ? '+' : ''}{istDiff.toFixed(1)}h vs. Schätzung)
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      {renderSummaryList(serviceSummaries, 'Service', serviceOpen, setServiceOpen)}
      {renderSummaryList(kitchenSummaries, 'Küche', kitchenOpen, setKitchenOpen)}
    </div>
  );
};
