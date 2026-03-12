import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Employee } from '@/types/personnel';
import { cn } from '@/lib/utils';
import { CheckCircle, TrendingDown, TrendingUp, ChevronDown, ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
}

export const EmployeeHoursSummary = ({ summaries }: EmployeeHoursSummaryProps) => {
  const serviceSummaries = summaries.filter(s => s.employee.department === 'service');
  const kitchenSummaries = summaries.filter(s => s.employee.department === 'küche');

  const [serviceOpen, setServiceOpen] = useState(false);
  const [kitchenOpen, setKitchenOpen] = useState(false);

  const renderSummaryList = (items: EmployeeSummary[], title: string, isOpen: boolean, setIsOpen: (open: boolean) => void) => {
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
                {items.map(({ employee, plannedHours, targetHours, difference, percentage, status }) => (
              <div key={employee.id} className="flex items-center gap-4">
                <div className="w-32 shrink-0">
                  <div className="font-medium text-sm truncate">{employee.name}</div>
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
              ))}
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
