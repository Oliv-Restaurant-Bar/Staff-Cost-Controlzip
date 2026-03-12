import { format } from 'date-fns';
import { Employee, TimeEntry, DailyBudget } from '@/types/personnel';
import { HoursEditor } from '@/components/HoursEditor';
import { PlanVsActualOverview } from '@/components/PlanVsActualOverview';
import { EmployeeTable } from '@/components/EmployeeTable';
import { EmployeeImportExportButtons } from '@/components/EmployeeImportExportButtons';
import { PlannedHoursImportButton } from '@/components/PlannedHoursImportButton';
import { ActualHoursImportButton } from '@/components/ActualHoursImportButton';
import { SmartImportButton } from '@/components/SmartImportButton';
import { CombinedSummary } from '@/components/CombinedSummary';
import { EmployeeBalanceOverview } from '@/components/EmployeeBalanceOverview';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { usePlanDisplay } from '@/contexts/PlanDisplayContext';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Users, ChevronDown, UserPlus, Pencil, Trash2, CalendarDays, FileSpreadsheet, BarChart3 } from 'lucide-react';
import { formatCurrency } from '@/lib/personnel-utils';

interface PersonnelTabProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
  dailySummary: any;
  onImportPlannedHours: (data: any) => void;
  onImportActualHours: (data: any) => void;
  onImportRevenue: (data: any) => void;
  onUpdateTimeEntry: (id: string, field: string, value: any) => void;
  onUpdatePlannedTime: (entryId: string, field: 'plannedStart' | 'plannedEnd' | 'plannedHours', value: string | number) => void;
  onAddTimeEntry: (entry: Omit<TimeEntry, 'id'>) => string;
  onDeleteTimeEntry: (id: string) => void;
  onEditEmployee: (employee: Employee) => void;
  onDeleteEmployee: (id: string) => void;
  onSetAllEmployees: (employees: Employee[]) => void;
  onAddNewEmployee: () => void;
  onBudgetUpdate: (date: string, field: 'plannedRevenue' | 'actualRevenue', value: number) => void;
  onUpdateEmployeeBalance: (employeeId: string, hoursBalance: number, vacationBalance: number) => void;
}

export const PersonnelTab = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
  dailySummary,
  onImportPlannedHours,
  onImportActualHours,
  onImportRevenue,
  onUpdateTimeEntry,
  onUpdatePlannedTime,
  onAddTimeEntry,
  onDeleteTimeEntry,
  onEditEmployee,
  onDeleteEmployee,
  onSetAllEmployees,
  onAddNewEmployee,
  onBudgetUpdate,
  onUpdateEmployeeBalance,
}: PersonnelTabProps) => {
  const dateString = format(selectedDate, 'yyyy-MM-dd');

  const { showPlannedData, setShowPlannedData } = usePlanDisplay();

  return (
    <div className="space-y-6">
      {/* Quick Actions + Plan/Ist Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
        <SmartImportButton 
          onImportPlannedHours={onImportPlannedHours}
          onImportActualHours={onImportActualHours}
          onImportRevenue={onImportRevenue}
          employees={employees}
        />
        <PlannedHoursImportButton onImport={onImportPlannedHours} employees={employees} />
        <ActualHoursImportButton onImport={onImportActualHours} employees={employees} existingTimeEntries={timeEntries} />
        <Button
          onClick={onAddNewEmployee}
          variant="outline"
          size="sm"
          className="gap-1.5"
        >
          <UserPlus className="h-4 w-4" />
          <span className="hidden sm:inline">Mitarbeiter</span>
        </Button>
        </div>
        {/* Plan/Ist Toggle */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/50 border">
          <BarChart3 className="h-3.5 w-3.5 text-muted-foreground" />
          <Label htmlFor="plan-ist-personnel" className="text-xs cursor-pointer whitespace-nowrap">
            {showPlannedData ? 'Plan + Ist' : 'Nur Ist'}
          </Label>
          <Switch
            id="plan-ist-personnel"
            checked={showPlannedData}
            onCheckedChange={setShowPlannedData}
            className="scale-75"
          />
        </div>
      </div>

      {/* Hours Editor */}
      <div id="stunden">
        <div className="flex items-center gap-2 mb-2">
          <CalendarDays className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Stunden & Planung</h2>
        </div>
        
        <HoursEditor
          employees={employees}
          timeEntries={timeEntries}
          dailyBudgets={dailyBudgets}
          selectedDate={selectedDate}
          onImportPlannedHours={onImportPlannedHours}
          onImportActualHours={onImportActualHours}
        />
      </div>

      {/* Plan vs Actual Overview */}
      <PlanVsActualOverview
        employees={employees}
        timeEntries={timeEntries}
        selectedDate={dateString}
        onUpdatePlannedTime={onUpdatePlannedTime}
        onUpdateActualTime={onUpdateTimeEntry}
        onAddTimeEntry={onAddTimeEntry}
        onDeleteTimeEntry={onDeleteTimeEntry}
      />

      {/* Employee Day Overview - Collapsible */}
      <Collapsible>
        <Card>
          <CardHeader className="py-3">
            <CollapsibleTrigger className="w-full">
              <div className="flex items-center justify-between cursor-pointer group">
                <CardTitle className="text-base flex items-center gap-2">
                  <Users className="h-4 w-4 text-primary" />
                  Tagesübersicht Mitarbeiter
                </CardTitle>
                <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </div>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="pt-0">
              <EmployeeTable
                employees={employees}
                timeEntries={timeEntries}
                onTimeUpdate={onUpdateTimeEntry}
                onEditEmployee={onEditEmployee}
                onDeleteEmployee={onDeleteEmployee}
                selectedDate={dateString}
              />
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* All Employees - Collapsible */}
      <Collapsible>
        <Card>
          <CardHeader className="py-3">
            <div className="flex items-center justify-between">
              <CollapsibleTrigger className="flex-1">
                <div className="flex items-center justify-between cursor-pointer group">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Users className="h-4 w-4 text-primary" />
                    Alle Mitarbeiter ({employees.length})
                  </CardTitle>
                  <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                </div>
              </CollapsibleTrigger>
              <div className="ml-4 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <Button
                  onClick={onAddNewEmployee}
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-8"
                >
                  <UserPlus className="h-4 w-4" />
                  <span className="hidden sm:inline">Neu</span>
                </Button>
                <EmployeeImportExportButtons 
                  employees={employees}
                  onImport={onSetAllEmployees}
                />
              </div>
            </div>
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="pt-0">
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Abteilung</th>
                      <th>Anstellung</th>
                      <th className="text-right">Stundenlohn</th>
                      <th className="text-right">Wochenstunden</th>
                      <th className="text-right">Aktionen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((employee) => (
                      <tr key={employee.id}>
                        <td className="font-medium">{employee.name}</td>
                        <td className="capitalize">{employee.department}</td>
                        <td className="capitalize">{employee.employmentType}</td>
                        <td className="text-right font-mono">
                          {formatCurrency(employee.hourlyWage)}
                        </td>
                        <td className="text-right font-mono">
                          {employee.weeklyHours || '-'}
                        </td>
                        <td className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button 
                              variant="ghost" 
                              size="icon"
                              onClick={() => onEditEmployee(employee)}
                              title="Bearbeiten"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button 
                                  variant="ghost" 
                                  size="icon"
                                  className="text-destructive hover:text-destructive"
                                  title="Löschen"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Mitarbeiter löschen?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Möchten Sie "{employee.name}" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                                  <AlertDialogAction 
                                    onClick={() => onDeleteEmployee(employee.id)}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  >
                                    Löschen
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Employee Balance Overview */}
      <EmployeeBalanceOverview
        employees={employees}
        timeEntries={timeEntries}
        selectedDate={selectedDate}
        onUpdateBalance={onUpdateEmployeeBalance}
      />

      {/* Combined Summary */}
      <CombinedSummary
        employees={employees}
        timeEntries={timeEntries}
        dailyBudgets={dailyBudgets}
        selectedDate={selectedDate}
        dailySummary={dailySummary}
        onBudgetUpdate={onBudgetUpdate}
      />
    </div>
  );
};
