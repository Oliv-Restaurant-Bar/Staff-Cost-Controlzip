import { useState, useEffect } from 'react';
import { Employee, TimeEntry } from '@/types/personnel';
import { formatCurrency, formatHours, getEmploymentTypeLabel, getEmploymentTypeBadgeClass } from '@/lib/personnel-utils';
import { cn } from '@/lib/utils';
import { useEmployerRateMap } from '@/hooks/useEmployerRateMap';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Pencil, Trash2, Lock, LockOpen } from 'lucide-react';
import { PASSWORD_PROTECTION_ENABLED_KEY } from '@/components/PasswordProtection';

interface EmployeeTableProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  onTimeUpdate: (entryId: string, field: 'actualStart' | 'actualEnd', value: string) => void;
  onEditEmployee?: (employee: Employee) => void;
  onDeleteEmployee?: (employeeId: string) => void;
  selectedDate: string;
}

// Storage key for salary column unlock status
const SALARY_UNLOCKED_KEY = 'salary_columns_unlocked';

export const EmployeeTable = ({
  employees,
  timeEntries,
  onTimeUpdate,
  onEditEmployee,
  onDeleteEmployee,
  selectedDate,
}: EmployeeTableProps) => {
  // Kosten = Total Arbeitgeberkosten (Bruttolohn + AG-Sozialkosten), nie roher hourlyWage.
  const { rateById } = useEmployerRateMap(employees);
  // Check if salary columns should be visible (password protection and unlock status)
  const [showSalaryColumns, setShowSalaryColumns] = useState(false);
  
  useEffect(() => {
    const isProtectionEnabled = localStorage.getItem(PASSWORD_PROTECTION_ENABLED_KEY) === 'true';
    const isUnlocked = sessionStorage.getItem(SALARY_UNLOCKED_KEY) === 'true';
    
    // Show salary columns if protection is disabled OR if unlocked
    setShowSalaryColumns(!isProtectionEnabled || isUnlocked);
  }, []);

  const getEntryForEmployee = (employeeId: string) => {
    return timeEntries.find(
      (entry) => entry.employeeId === employeeId && entry.date === selectedDate
    );
  };

  const calculateCost = (hours: number, wage: number) => hours * wage;

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="data-table">
        <thead>
          <tr>
            <th>Mitarbeiter</th>
            <th>Abteilung</th>
            <th>Anstellung</th>
            <th>Stundenlohn</th>
            {showSalaryColumns && (
              <>
                <th className="text-right">Monatslohn</th>
                <th className="text-right">inkl. 13. ML</th>
              </>
            )}
            <th className="text-center">Plan</th>
            <th className="text-center">Ist</th>
            <th className="text-right">Plan Kosten</th>
            <th className="text-right">Ist Kosten</th>
            <th className="text-right">Differenz</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {employees.map((employee) => {
            const entry = getEntryForEmployee(employee.id);
            const plannedHours = entry?.plannedHours || 0;
            const actualHours = entry?.actualHours || 0;
            const plannedCost = calculateCost(plannedHours, rateById.get(employee.id) ?? 0);
            const actualCost = calculateCost(actualHours, rateById.get(employee.id) ?? 0);
            const variance = plannedCost - actualCost;

            return (
              <tr key={employee.id} className="group">
                <td className="font-medium">{employee.name}</td>
                <td className="capitalize">{employee.department}</td>
                <td>
                  <span className={cn('badge-employment', getEmploymentTypeBadgeClass(employee.employmentType))}>
                    {getEmploymentTypeLabel(employee.employmentType)}
                  </span>
                </td>
                <td className="font-mono">{formatCurrency(employee.hourlyWage)}</td>
                {showSalaryColumns && (
                  <>
                    <td className="text-right font-mono text-muted-foreground">
                      {employee.monthlySalary ? formatCurrency(employee.monthlySalary) : '–'}
                    </td>
                    <td className="text-right font-mono">
                      {employee.monthlySalaryWith13th ? (
                        <span className="text-green-600 dark:text-green-400 font-medium">
                          {formatCurrency(employee.monthlySalaryWith13th)}
                        </span>
                      ) : '–'}
                    </td>
                  </>
                )}
                <td className="text-center">
                  <span className="text-muted-foreground text-xs">
                    {entry?.plannedStart} - {entry?.plannedEnd}
                  </span>
                  <br />
                  <span className="font-mono font-medium">{formatHours(plannedHours)}</span>
                </td>
                <td className="text-center">
                  <div className="flex items-center gap-1 justify-center">
                    <Input
                      type="time"
                      value={entry?.actualStart || ''}
                      onChange={(e) => entry && onTimeUpdate(entry.id, 'actualStart', e.target.value)}
                      className="w-24 h-8 text-xs"
                    />
                    <span className="text-muted-foreground">-</span>
                    <Input
                      type="time"
                      value={entry?.actualEnd || ''}
                      onChange={(e) => entry && onTimeUpdate(entry.id, 'actualEnd', e.target.value)}
                      className="w-24 h-8 text-xs"
                    />
                  </div>
                  <span className="font-mono font-medium text-sm mt-1 block">
                    {formatHours(actualHours)}
                  </span>
                </td>
                <td className="text-right font-mono">{formatCurrency(plannedCost)}</td>
                <td className="text-right font-mono">{formatCurrency(actualCost)}</td>
                <td className={cn(
                  'text-right font-mono font-semibold',
                  variance > 0 && 'stat-positive',
                  variance < 0 && 'stat-negative'
                )}>
                  {variance >= 0 ? '+' : ''}{formatCurrency(variance)}
                </td>
                <td className="text-right">
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 justify-end">
                    {onEditEmployee && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onEditEmployee(employee)}
                        className="h-8 w-8 p-0"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {onDeleteEmployee && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onDeleteEmployee(employee.id)}
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
