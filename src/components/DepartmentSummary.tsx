import { Employee, TimeEntry, DailyBudget, grossToNet } from '@/types/personnel';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { cn } from '@/lib/utils';
import { Users, ChefHat, ChevronDown, FileText, FileSpreadsheet } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { exportKPIReportPDF, exportKPIReportExcel } from '@/lib/kpi-export';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';

interface DepartmentSummaryProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
  showNetRevenue?: boolean;
  showPlannedData?: boolean;
}

export const DepartmentSummary = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
  showNetRevenue: propShowNetRevenue,
  showPlannedData = true,
}: DepartmentSummaryProps) => {
  const { showNetRevenue: contextShowNetRevenue } = useRevenueDisplay();
  // Use prop if provided, otherwise use context
  const showNetRevenue = propShowNetRevenue ?? contextShowNetRevenue;
  
  const dateString = typeof selectedDate === 'string' ? selectedDate : selectedDate.toISOString().split('T')[0];
  
  const calculateDepartmentStats = (department: 'service' | 'küche') => {
    const deptEmployees = employees.filter((e) => e.department === department);
    const deptEntries = timeEntries.filter(
      (entry) =>
        entry.date === dateString &&
        deptEmployees.some((e) => e.id === entry.employeeId)
    );

    let plannedHours = 0;
    let actualHours = 0;
    let plannedCost = 0;
    let actualCost = 0;
    let employeeCount = 0;

    deptEntries.forEach((entry) => {
      const employee = deptEmployees.find((e) => e.id === entry.employeeId);
      if (!employee) return;

      employeeCount++;
      plannedHours += entry.plannedHours;
      plannedCost += entry.plannedHours * employee.hourlyWage;

      if (entry.actualHours !== undefined) {
        actualHours += entry.actualHours;
        actualCost += entry.actualHours * employee.hourlyWage;
      }
    });

    return {
      employeeCount,
      plannedHours,
      actualHours,
      plannedCost,
      actualCost,
      variance: plannedCost - actualCost,
    };
  };

  const serviceStats = calculateDepartmentStats('service');
  const kitchenStats = calculateDepartmentStats('küche');

  const handleExportPDF = () => {
    const date = typeof selectedDate === 'string' ? new Date(selectedDate) : selectedDate;
    // KPI Export hat: (employees, timeEntries, dailyBudgets, selectedDate, customEndDate?, periodLabel?, companyName?, logoUrl?, showNetRevenue?)
    exportKPIReportPDF(employees, timeEntries, dailyBudgets, date, undefined, undefined, undefined, undefined, showNetRevenue);
  };

  const handleExportExcel = () => {
    const date = typeof selectedDate === 'string' ? new Date(selectedDate) : selectedDate;
    // KPI Export hat: (employees, timeEntries, dailyBudgets, selectedDate, customEndDate?, periodLabel?, showNetRevenue?)
    exportKPIReportExcel(employees, timeEntries, dailyBudgets, date, undefined, undefined, showNetRevenue);
  };

  const DepartmentCard = ({
    title,
    icon: Icon,
    stats,
    color,
  }: {
    title: string;
    icon: typeof Users;
    stats: ReturnType<typeof calculateDepartmentStats>;
    color: string;
  }) => (
    <div className="stat-card">
      <div className="flex items-center gap-3 mb-4">
        <div className={cn('rounded-lg p-2.5', color)}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">
            {stats.employeeCount} Mitarbeiter heute
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-muted-foreground mb-1">
            {showPlannedData ? 'Stunden Plan/Ist' : 'Ist-Stunden'}
          </p>
          <p className="font-mono font-medium">
            {showPlannedData 
              ? `${formatHours(stats.plannedHours)} / ${formatHours(stats.actualHours)}`
              : formatHours(stats.actualHours)
            }
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">
            {showPlannedData ? 'Kosten Plan/Ist' : 'Ist-Kosten'}
          </p>
          <p className="font-mono font-medium">
            {showPlannedData
              ? `${formatCurrency(stats.plannedCost)} / ${formatCurrency(stats.actualCost)}`
              : formatCurrency(stats.actualCost)
            }
          </p>
        </div>
      </div>

      {showPlannedData && (
        <div className="mt-4 pt-4 border-t border-border">
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Differenz</span>
            <span
              className={cn(
                'font-mono font-bold',
                stats.variance > 0 && 'stat-positive',
                stats.variance < 0 && 'stat-negative'
              )}
            >
              {stats.variance >= 0 ? '+' : ''}
              {formatCurrency(stats.variance)}
            </span>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <Collapsible>
      <div className="stat-card">
        <CollapsibleTrigger className="w-full">
          <div className="flex items-center justify-between cursor-pointer group">
            <h2 className="text-lg font-semibold">Abteilungsübersicht</h2>
            <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex gap-2 mt-4 mb-4">
            <Button variant="outline" size="sm" onClick={handleExportPDF} className="gap-2">
              <FileText className="h-4 w-4" />
              KPI Report (PDF)
            </Button>
            <Button variant="outline" size="sm" onClick={handleExportExcel} className="gap-2">
              <FileSpreadsheet className="h-4 w-4" />
              KPI Report (Excel)
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <DepartmentCard
              title="Service"
              icon={Users}
              stats={serviceStats}
              color="bg-primary/10 text-primary"
            />
            <DepartmentCard
              title="Küche"
              icon={ChefHat}
              stats={kitchenStats}
              color="bg-warning/10 text-warning"
            />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};
