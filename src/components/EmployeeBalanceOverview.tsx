import { useState, useMemo, useCallback, useEffect } from 'react';
import { Employee, TimeEntry } from '@/types/personnel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { EmployeeBalanceEditor } from '@/components/EmployeeBalanceEditor';
import { BalanceExportDialog, BalanceExportOptions } from '@/components/schedule-planner/BalanceExportDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { 
  Clock, 
  Calendar, 
  ChevronDown, 
  ChevronLeft,
  ChevronRight,
  TrendingUp, 
  TrendingDown, 
  Pencil,
  Search,
  Users,
  Calculator,
  RefreshCw,
  FileSpreadsheet,
  Archive,
  CheckCircle2
} from 'lucide-react';
import ExcelJS from 'exceljs';
import { cn } from '@/lib/utils';
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval, addWeeks, subWeeks, addMonths, subMonths, getISOWeek, getMonth, getYear } from 'date-fns';
import { de } from 'date-fns/locale';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface PendingChange {
  employeeId: string;
  employeeName: string;
  currentBalance: number;
  difference: number;
  newBalance: number;
}

interface ConfirmDialogState {
  isOpen: boolean;
  changes: PendingChange[];
  isSingle: boolean;
}

interface MonthCloseDialogState {
  isOpen: boolean;
  year: number;
  month: number;
  entries: MonthCloseEntry[];
}

interface MonthCloseEntry {
  employeeId: string;
  employeeName: string;
  hoursBalanceStart: number;
  hoursTarget: number;
  hoursWorked: number;
  hoursBalanceEnd: number;
  vacationBalanceStart: number;
  vacationDaysUsed: number;
  vacationBalanceEnd: number;
}

interface HistoryEntry {
  employee_id: string;
  year: number;
  month: number;
  hours_balance_end: number | null;
  vacation_balance_end: number | null;
}

interface EmployeeBalanceOverviewProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  selectedDate: Date;
  onUpdateBalance: (employeeId: string, hoursBalance: number, vacationBalance: number) => void;
}

type ViewMode = 'week' | 'month';

export const EmployeeBalanceOverview = ({
  employees,
  timeEntries,
  selectedDate,
  onUpdateBalance,
}: EmployeeBalanceOverviewProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [departmentFilter, setDepartmentFilter] = useState<'all' | 'service' | 'küche'>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [currentPeriod, setCurrentPeriod] = useState(selectedDate);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    changes: [],
    isSingle: false,
  });
  const [monthCloseDialog, setMonthCloseDialog] = useState<MonthCloseDialogState>({
    isOpen: false,
    year: 0,
    month: 0,
    entries: [],
  });
  const [closedMonths, setClosedMonths] = useState<Set<string>>(new Set());
  const [isClosingMonth, setIsClosingMonth] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  // Fetch closed months on mount
  useEffect(() => {
    const fetchClosedMonths = async () => {
      const { data } = await supabase
        .from('employee_balance_history')
        .select('year, month')
        .order('year', { ascending: false })
        .order('month', { ascending: false });
      
      if (data) {
        const closed = new Set<string>();
        data.forEach(entry => {
          closed.add(`${entry.year}-${entry.month}`);
        });
        setClosedMonths(closed);
      }
    };
    fetchClosedMonths();
  }, []);

  // Current month info for close check
  const currentMonthInfo = useMemo(() => {
    const year = getYear(currentPeriod);
    const month = getMonth(currentPeriod) + 1; // 1-indexed
    const key = `${year}-${month}`;
    return { year, month, key, isClosed: closedMonths.has(key) };
  }, [currentPeriod, closedMonths]);

  // Period navigation
  const navigatePeriod = useCallback((direction: 'prev' | 'next') => {
    if (viewMode === 'week') {
      setCurrentPeriod(prev => direction === 'next' ? addWeeks(prev, 1) : subWeeks(prev, 1));
    } else {
      setCurrentPeriod(prev => direction === 'next' ? addMonths(prev, 1) : subMonths(prev, 1));
    }
  }, [viewMode]);

  const toggleViewMode = useCallback(() => {
    setViewMode(prev => prev === 'week' ? 'month' : 'week');
  }, []);

  // Get period boundaries
  const periodBounds = useMemo(() => {
    if (viewMode === 'week') {
      return {
        start: startOfWeek(currentPeriod, { weekStartsOn: 1 }),
        end: endOfWeek(currentPeriod, { weekStartsOn: 1 }),
      };
    }
    return {
      start: startOfMonth(currentPeriod),
      end: endOfMonth(currentPeriod),
    };
  }, [currentPeriod, viewMode]);

  // Period label
  const periodLabel = useMemo(() => {
    if (viewMode === 'week') {
      const weekNum = getISOWeek(currentPeriod);
      return `KW ${weekNum}`;
    }
    return format(currentPeriod, 'MMM yyyy', { locale: de });
  }, [currentPeriod, viewMode]);

  // Calculate stats for each employee in the current period
  const periodStats = useMemo(() => {
    const days = eachDayOfInterval({ start: periodBounds.start, end: periodBounds.end });
    const stats: Record<string, { 
      targetHours: number; 
      plannedHours: number; 
      actualHours: number;
      difference: number;
    }> = {};

    employees.forEach((employee) => {
      // Target hours from contract
      const weeksInPeriod = days.length / 7;
      const targetHours = (employee.weeklyHours || 0) * weeksInPeriod;

      // Get entries for this period
      let plannedHours = 0;
      let actualHours = 0;

      days.forEach((day) => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const entry = timeEntries.find(
          (e) => e.employeeId === employee.id && e.date === dateStr
        );
        if (entry) {
          plannedHours += entry.plannedHours || 0;
          actualHours += entry.actualHours || 0;
        }
      });

      const difference = actualHours - targetHours;

      stats[employee.id] = {
        targetHours: Math.round(targetHours * 100) / 100,
        plannedHours: Math.round(plannedHours * 100) / 100,
        actualHours: Math.round(actualHours * 100) / 100,
        difference: Math.round(difference * 100) / 100,
      };
    });

    return stats;
  }, [employees, timeEntries, periodBounds]);

  // Filter employees
  const filteredEmployees = useMemo(() => {
    return employees
      .filter((e) => {
        const matchesSearch = e.name.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesDepartment = departmentFilter === 'all' || e.department === departmentFilter;
        return matchesSearch && matchesDepartment;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [employees, searchTerm, departmentFilter]);

  // Summary stats
  const summaryStats = useMemo(() => {
    let totalOvertime = 0;
    let totalUndertime = 0;
    let totalVacation = 0;

    filteredEmployees.forEach((e) => {
      const balance = e.hoursBalance || 0;
      if (balance > 0) {
        totalOvertime += balance;
      } else if (balance < 0) {
        totalUndertime += Math.abs(balance);
      }
      totalVacation += e.vacationBalance || 0;
    });

    return {
      totalOvertime: Math.round(totalOvertime * 100) / 100,
      totalUndertime: Math.round(totalUndertime * 100) / 100,
      totalVacation: Math.round(totalVacation * 100) / 100,
    };
  }, [filteredEmployees]);

  // Prepare single employee calculation for confirmation
  const handleAutoCalculate = useCallback((employeeId: string) => {
    const employee = employees.find(e => e.id === employeeId);
    const stats = periodStats[employeeId];
    
    if (!employee || !stats) return;

    if (stats.actualHours === 0) {
      toast.error('Keine Ist-Stunden für diesen Zeitraum vorhanden');
      return;
    }

    const currentBalance = employee.hoursBalance || 0;
    const newBalance = Math.round((currentBalance + stats.difference) * 100) / 100;
    
    setConfirmDialog({
      isOpen: true,
      isSingle: true,
      changes: [{
        employeeId: employee.id,
        employeeName: employee.name,
        currentBalance,
        difference: stats.difference,
        newBalance,
      }],
    });
  }, [employees, periodStats]);

  // Prepare batch calculation for confirmation
  const handleBatchCalculate = useCallback(() => {
    const changes: PendingChange[] = [];
    
    filteredEmployees.forEach((employee) => {
      const stats = periodStats[employee.id];
      if (stats && stats.actualHours > 0) {
        const currentBalance = employee.hoursBalance || 0;
        const newBalance = Math.round((currentBalance + stats.difference) * 100) / 100;
        changes.push({
          employeeId: employee.id,
          employeeName: employee.name,
          currentBalance,
          difference: stats.difference,
          newBalance,
        });
      }
    });

    if (changes.length === 0) {
      toast.warning('Keine Ist-Stunden vorhanden');
      return;
    }

    setConfirmDialog({
      isOpen: true,
      isSingle: false,
      changes,
    });
  }, [filteredEmployees, periodStats]);

  // Apply confirmed changes
  const handleConfirmChanges = useCallback(() => {
    confirmDialog.changes.forEach((change) => {
      const employee = employees.find(e => e.id === change.employeeId);
      onUpdateBalance(change.employeeId, change.newBalance, employee?.vacationBalance || 0);
    });

    const count = confirmDialog.changes.length;
    toast.success(`${count} ${count === 1 ? 'Saldo' : 'Salden'} aktualisiert`);
    setConfirmDialog({ isOpen: false, changes: [], isSingle: false });
  }, [confirmDialog.changes, employees, onUpdateBalance]);

  // Prepare month close
  const handlePrepareMonthClose = useCallback(() => {
    if (viewMode !== 'month') {
      toast.error('Monatsabschluss nur in Monatsansicht verfügbar');
      return;
    }

    if (currentMonthInfo.isClosed) {
      toast.info('Dieser Monat wurde bereits abgeschlossen');
      return;
    }

    const entries: MonthCloseEntry[] = [];
    
    employees.forEach((employee) => {
      const stats = periodStats[employee.id] || { targetHours: 0, actualHours: 0, difference: 0 };
      const hoursBalanceStart = employee.hoursBalance || 0;
      const hoursBalanceEnd = Math.round((hoursBalanceStart + stats.difference) * 100) / 100;
      
      entries.push({
        employeeId: employee.id,
        employeeName: employee.name,
        hoursBalanceStart,
        hoursTarget: stats.targetHours,
        hoursWorked: stats.actualHours,
        hoursBalanceEnd,
        vacationBalanceStart: employee.vacationBalance || 0,
        vacationDaysUsed: 0, // Could be extended to track vacation usage
        vacationBalanceEnd: employee.vacationBalance || 0,
      });
    });

    setMonthCloseDialog({
      isOpen: true,
      year: currentMonthInfo.year,
      month: currentMonthInfo.month,
      entries,
    });
  }, [viewMode, currentMonthInfo, employees, periodStats]);

  // Execute month close
  const handleExecuteMonthClose = useCallback(async () => {
    setIsClosingMonth(true);
    
    try {
      // Insert history entries
      const historyEntries = monthCloseDialog.entries.map(entry => ({
        employee_id: entry.employeeId,
        year: monthCloseDialog.year,
        month: monthCloseDialog.month,
        hours_balance_start: entry.hoursBalanceStart,
        hours_balance_end: entry.hoursBalanceEnd,
        hours_target: entry.hoursTarget,
        hours_worked: entry.hoursWorked,
        vacation_balance_start: entry.vacationBalanceStart,
        vacation_balance_end: entry.vacationBalanceEnd,
        vacation_days_used: entry.vacationDaysUsed,
      }));

      const { error } = await supabase
        .from('employee_balance_history')
        .insert(historyEntries);

      if (error) throw error;

      // Update employee balances
      for (const entry of monthCloseDialog.entries) {
        if (entry.hoursWorked > 0) {
          onUpdateBalance(entry.employeeId, entry.hoursBalanceEnd, entry.vacationBalanceEnd);
        }
      }

      // Mark month as closed
      setClosedMonths(prev => new Set([...prev, `${monthCloseDialog.year}-${monthCloseDialog.month}`]));
      
      toast.success(`Monatsabschluss ${format(new Date(monthCloseDialog.year, monthCloseDialog.month - 1), 'MMMM yyyy', { locale: de })} erfolgreich`);
      setMonthCloseDialog({ isOpen: false, year: 0, month: 0, entries: [] });
    } catch (error) {
      console.error('Month close error:', error);
      toast.error('Fehler beim Monatsabschluss');
    } finally {
      setIsClosingMonth(false);
    }
  }, [monthCloseDialog, onUpdateBalance]);

  const formatHours = (hours: number, showSign = true) => {
    if (!showSign) return `${Math.abs(hours).toFixed(1)}h`;
    const sign = hours >= 0 ? '+' : '';
    return `${sign}${hours.toFixed(1)}h`;
  };

  const getBalanceColor = (balance: number) => {
    if (balance > 0) return 'text-green-600 dark:text-green-400';
    if (balance < 0) return 'text-red-600 dark:text-red-400';
    return 'text-muted-foreground';
  };

  // Excel Export function with dynamic period
  const handleExcelExport = useCallback(async (options: BalanceExportOptions) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Personalplanung';
    workbook.created = new Date();

    // Calculate stats for the selected export period
    const exportDays = eachDayOfInterval({ start: options.startDate, end: options.endDate });
    
    const exportStats: Record<string, { 
      targetHours: number; 
      plannedHours: number; 
      actualHours: number;
      difference: number;
    }> = {};

    employees.forEach((employee) => {
      const weeksInPeriod = exportDays.length / 7;
      const targetHours = (employee.weeklyHours || 0) * weeksInPeriod;

      let plannedHours = 0;
      let actualHours = 0;

      exportDays.forEach((day) => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const entry = timeEntries.find(
          (e) => e.employeeId === employee.id && e.date === dateStr
        );
        if (entry) {
          plannedHours += entry.plannedHours || 0;
          actualHours += entry.actualHours || 0;
        }
      });

      const difference = actualHours - targetHours;

      exportStats[employee.id] = {
        targetHours: Math.round(targetHours * 100) / 100,
        plannedHours: Math.round(plannedHours * 100) / 100,
        actualHours: Math.round(actualHours * 100) / 100,
        difference: Math.round(difference * 100) / 100,
      };
    });

    // Sheet 1: Current Balances
    const balanceSheet = workbook.addWorksheet('Aktuelle Salden');
    
    // Header style
    const headerStyle: Partial<ExcelJS.Style> = {
      font: { bold: true, color: { argb: 'FFFFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a2e' } },
      alignment: { horizontal: 'center', vertical: 'middle' },
      border: {
        bottom: { style: 'thin', color: { argb: 'FF000000' } },
      },
    };

    // Add period info as title row
    balanceSheet.mergeCells('A1:I1');
    const titleCell = balanceSheet.getCell('A1');
    titleCell.value = `Mitarbeiter-Salden - Zeitraum: ${options.periodLabel}`;
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { horizontal: 'left', vertical: 'middle' };
    balanceSheet.getRow(1).height = 28;

    // Add export date row
    balanceSheet.mergeCells('A2:I2');
    const dateCell = balanceSheet.getCell('A2');
    dateCell.value = `Exportiert am: ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`;
    dateCell.font = { italic: true, size: 10, color: { argb: 'FF666666' } };
    balanceSheet.getRow(2).height = 18;

    // Setup columns starting from row 4
    balanceSheet.columns = [
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Abteilung', key: 'department', width: 12 },
      { header: 'Wochenstunden', key: 'weeklyHours', width: 15 },
      { header: `Soll (${options.periodLabel})`, key: 'targetHours', width: 20 },
      { header: `Ist (${options.periodLabel})`, key: 'actualHours', width: 20 },
      { header: `Differenz`, key: 'difference', width: 12 },
      { header: 'Stundensaldo', key: 'hoursBalance', width: 14 },
      { header: 'Feriensaldo', key: 'vacationBalance', width: 13 },
      { header: 'Ferientage/Jahr', key: 'vacationDays', width: 14 },
    ];

    // Add header row at row 4
    const headerRow = balanceSheet.getRow(4);
    ['Name', 'Abteilung', 'Wochenstunden', `Soll (${options.periodLabel})`, `Ist (${options.periodLabel})`, 'Differenz', 'Stundensaldo', 'Feriensaldo', 'Ferientage/Jahr'].forEach((header, idx) => {
      const cell = headerRow.getCell(idx + 1);
      cell.value = header;
      Object.assign(cell, { style: headerStyle });
    });
    headerRow.height = 24;

    // Add data starting from row 5
    filteredEmployees.forEach((employee, idx) => {
      const stats = exportStats[employee.id] || { targetHours: 0, actualHours: 0, difference: 0 };
      const row = balanceSheet.getRow(5 + idx);
      row.values = [
        employee.name,
        employee.department === 'service' ? 'Service' : 'Küche',
        employee.weeklyHours || 0,
        stats.targetHours,
        stats.actualHours,
        stats.difference,
        employee.hoursBalance || 0,
        employee.vacationBalance || 0,
        employee.vacationDaysPerYear || 0,
      ];

      // Conditional formatting for difference
      const diffCell = row.getCell(6);
      if (stats.difference > 0) {
        diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFd4edda' } };
        diffCell.font = { color: { argb: 'FF155724' } };
      } else if (stats.difference < 0) {
        diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFf8d7da' } };
        diffCell.font = { color: { argb: 'FF721c24' } };
      }

      // Conditional formatting for hours balance
      const balanceCell = row.getCell(7);
      const balance = employee.hoursBalance || 0;
      if (balance > 0) {
        balanceCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFd4edda' } };
        balanceCell.font = { bold: true, color: { argb: 'FF155724' } };
      } else if (balance < 0) {
        balanceCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFf8d7da' } };
        balanceCell.font = { bold: true, color: { argb: 'FF721c24' } };
      }
    });

    // Add summary row
    const summaryRowIdx = 5 + filteredEmployees.length;
    const summaryRow = balanceSheet.getRow(summaryRowIdx);
    summaryRow.values = [
      'GESAMT',
      '',
      '',
      filteredEmployees.reduce((sum, e) => sum + (exportStats[e.id]?.targetHours || 0), 0),
      filteredEmployees.reduce((sum, e) => sum + (exportStats[e.id]?.actualHours || 0), 0),
      filteredEmployees.reduce((sum, e) => sum + (exportStats[e.id]?.difference || 0), 0),
      filteredEmployees.reduce((sum, e) => sum + (e.hoursBalance || 0), 0),
      filteredEmployees.reduce((sum, e) => sum + (e.vacationBalance || 0), 0),
      '',
    ];
    summaryRow.font = { bold: true };
    summaryRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFe9ecef' } };

    // Sheet 2: Period Details (historical view)
    const detailSheet = workbook.addWorksheet('Periodenübersicht');

    // Add period info as title row
    detailSheet.mergeCells('A1:I1');
    const detailTitleCell = detailSheet.getCell('A1');
    detailTitleCell.value = `Periodenübersicht - Zeitraum: ${options.periodLabel}`;
    detailTitleCell.font = { bold: true, size: 14 };
    detailTitleCell.alignment = { horizontal: 'left', vertical: 'middle' };
    detailSheet.getRow(1).height = 28;
    
    detailSheet.columns = [
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Abteilung', key: 'department', width: 12 },
      { header: 'Anstellungsart', key: 'employmentType', width: 15 },
      { header: 'Stundenlohn', key: 'hourlyWage', width: 12 },
      { header: 'Periode', key: 'period', width: 25 },
      { header: 'Soll-Stunden', key: 'targetHours', width: 13 },
      { header: 'Ist-Stunden', key: 'actualHours', width: 12 },
      { header: 'Differenz', key: 'difference', width: 11 },
      { header: 'Aktueller Saldo', key: 'currentBalance', width: 15 },
    ];

    // Add header row at row 3
    const detailHeaderRow = detailSheet.getRow(3);
    ['Name', 'Abteilung', 'Anstellungsart', 'Stundenlohn', 'Periode', 'Soll-Stunden', 'Ist-Stunden', 'Differenz', 'Aktueller Saldo'].forEach((header, idx) => {
      const cell = detailHeaderRow.getCell(idx + 1);
      cell.value = header;
      Object.assign(cell, { style: headerStyle });
    });
    detailHeaderRow.height = 24;

    filteredEmployees.forEach((employee, idx) => {
      const stats = exportStats[employee.id] || { targetHours: 0, actualHours: 0, difference: 0 };
      const row = detailSheet.getRow(4 + idx);
      row.values = [
        employee.name,
        employee.department === 'service' ? 'Service' : 'Küche',
        employee.employmentType.charAt(0).toUpperCase() + employee.employmentType.slice(1),
        employee.hourlyWage,
        options.periodLabel,
        stats.targetHours,
        stats.actualHours,
        stats.difference,
        employee.hoursBalance || 0,
      ];

      // Format currency
      row.getCell(4).numFmt = '"CHF" #,##0.00';

      // Conditional formatting
      const diffCell = row.getCell(8);
      if (stats.difference > 0) {
        diffCell.font = { color: { argb: 'FF155724' } };
      } else if (stats.difference < 0) {
        diffCell.font = { color: { argb: 'FF721c24' } };
      }
    });

    // Generate filename with period info
    const sanitizedPeriod = options.periodLabel.replace(/[^a-zA-Z0-9äöüÄÖÜß\-\s]/g, '').replace(/\s+/g, '_');
    const filename = `Mitarbeiter-Salden_${sanitizedPeriod}_${format(new Date(), 'yyyy-MM-dd')}.xlsx`;

    // Generate and download file
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);

    toast.success('Excel-Export erstellt');
  }, [employees, filteredEmployees, timeEntries]);

  return (
    <>
      <Collapsible>
        <Card>
          <CardHeader className="py-3">
            <CollapsibleTrigger className="w-full">
              <div className="flex items-center justify-between cursor-pointer group">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="h-4 w-4 text-primary" />
                  Stunden- & Feriensaldo
                </CardTitle>
                <div className="flex items-center gap-2">
                  {summaryStats.totalOvertime > 0 && (
                    <Badge className="bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300 text-xs">
                      +{summaryStats.totalOvertime.toFixed(0)}h
                    </Badge>
                  )}
                  {summaryStats.totalUndertime > 0 && (
                    <Badge className="bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 text-xs">
                      -{summaryStats.totalUndertime.toFixed(0)}h
                    </Badge>
                  )}
                  <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                </div>
              </div>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="pt-0 space-y-4">
              {/* Compact Navigation & Filters */}
              <div className="flex flex-wrap gap-2 items-center justify-between">
                <div className="flex items-center gap-2">
                  {/* Period Navigation */}
                  <div className="flex items-center bg-muted/50 rounded-lg">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={(e) => { e.stopPropagation(); navigatePeriod('prev'); }}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleViewMode(); }}
                      className="px-3 py-1 text-sm font-medium hover:bg-muted rounded transition-colors min-w-[80px]"
                    >
                      {periodLabel}
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={(e) => { e.stopPropagation(); navigatePeriod('next'); }}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* Department Filter Pills */}
                  <div className="flex gap-0.5 bg-muted/50 rounded-lg p-0.5">
                    {(['all', 'service', 'küche'] as const).map((dept) => (
                      <button
                        key={dept}
                        onClick={(e) => { e.stopPropagation(); setDepartmentFilter(dept); }}
                        className={cn(
                          "px-2 py-1 text-xs rounded transition-colors",
                          departmentFilter === dept 
                            ? "bg-background shadow-sm font-medium" 
                            : "hover:bg-muted"
                        )}
                      >
                        {dept === 'all' ? 'Alle' : dept.charAt(0).toUpperCase() + dept.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Search */}
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      placeholder="Suchen..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-7 h-8 w-32 text-sm"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>

                  {/* Batch Calculate */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    onClick={(e) => { e.stopPropagation(); handleBatchCalculate(); }}
                    title={`Alle Salden für ${periodLabel} berechnen`}
                  >
                    <Calculator className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Auto</span>
                  </Button>

                  {/* Excel Export */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    onClick={(e) => { e.stopPropagation(); setExportDialogOpen(true); }}
                    title="Excel-Export mit Salden"
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Export</span>
                  </Button>

                  {/* Month Close Button - only in month view */}
                  {viewMode === 'month' && (
                    <Button
                      variant={currentMonthInfo.isClosed ? "secondary" : "default"}
                      size="sm"
                      className="h-8 gap-1.5 text-xs"
                      onClick={(e) => { e.stopPropagation(); handlePrepareMonthClose(); }}
                      disabled={currentMonthInfo.isClosed}
                      title={currentMonthInfo.isClosed ? 'Monat bereits abgeschlossen' : 'Monatsabschluss durchführen'}
                    >
                      {currentMonthInfo.isClosed ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Abgeschlossen</span>
                        </>
                      ) : (
                        <>
                          <Archive className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Abschluss</span>
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>

              {/* Compact Summary */}
              <div className="flex gap-4 text-sm">
                <div className="flex items-center gap-1.5">
                  <TrendingUp className="h-4 w-4 text-green-500" />
                  <span className="text-muted-foreground">Überstunden:</span>
                  <span className="font-medium text-green-600 dark:text-green-400">
                    +{summaryStats.totalOvertime.toFixed(1)}h
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <TrendingDown className="h-4 w-4 text-red-500" />
                  <span className="text-muted-foreground">Minusstunden:</span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    -{summaryStats.totalUndertime.toFixed(1)}h
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Calendar className="h-4 w-4 text-orange-500" />
                  <span className="text-muted-foreground">Ferien:</span>
                  <span className="font-medium text-orange-600 dark:text-orange-400">
                    {summaryStats.totalVacation.toFixed(1)} Tage
                  </span>
                </div>
              </div>

              {/* Compact Employee Table */}
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium">Name</th>
                      <th className="text-center py-2 px-3 font-medium w-16">Abt.</th>
                      <th className="text-right py-2 px-3 font-medium">
                        <span className="text-muted-foreground text-xs">Soll</span>
                      </th>
                      <th className="text-right py-2 px-3 font-medium">
                        <span className="text-muted-foreground text-xs">Ist</span>
                      </th>
                      <th className="text-right py-2 px-3 font-medium">
                        <span className="text-xs">Diff ({periodLabel})</span>
                      </th>
                      <th className="text-right py-2 px-3 font-medium">Saldo</th>
                      <th className="text-right py-2 px-3 font-medium">Ferien</th>
                      <th className="w-20"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredEmployees.map((employee) => {
                      const stats = periodStats[employee.id] || { targetHours: 0, actualHours: 0, difference: 0 };
                      const hoursBalance = employee.hoursBalance || 0;
                      const vacationBalance = employee.vacationBalance || 0;

                      return (
                        <tr key={employee.id} className="hover:bg-muted/30 group">
                          <td className="py-1.5 px-3 font-medium">{employee.name}</td>
                          <td className="py-1.5 px-3 text-center">
                            <span className={cn(
                              "text-xs px-1.5 py-0.5 rounded",
                              employee.department === 'service' 
                                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
                                : "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"
                            )}>
                              {employee.department === 'service' ? 'S' : 'K'}
                            </span>
                          </td>
                          <td className="py-1.5 px-3 text-right font-mono text-xs text-muted-foreground">
                            {stats.targetHours.toFixed(1)}h
                          </td>
                          <td className="py-1.5 px-3 text-right font-mono text-xs">
                            {stats.actualHours > 0 ? `${stats.actualHours.toFixed(1)}h` : '-'}
                          </td>
                          <td className={cn('py-1.5 px-3 text-right font-mono text-xs', getBalanceColor(stats.difference))}>
                            {stats.actualHours > 0 ? formatHours(stats.difference) : '-'}
                          </td>
                          <td className={cn('py-1.5 px-3 text-right font-mono font-medium', getBalanceColor(hoursBalance))}>
                            {formatHours(hoursBalance)}
                          </td>
                          <td className="py-1.5 px-3 text-right font-mono text-orange-600 dark:text-orange-400">
                            {vacationBalance.toFixed(1)}d
                          </td>
                          <td className="py-1.5 px-3 text-right">
                            <div className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              {stats.actualHours > 0 && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 p-0"
                                  onClick={() => handleAutoCalculate(employee.id)}
                                  title="Differenz zum Saldo hinzufügen"
                                >
                                  <RefreshCw className="h-3 w-3" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                                onClick={() => setEditingEmployee(employee)}
                                title="Saldo bearbeiten"
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {filteredEmployees.length === 0 && (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  <Users className="h-6 w-6 mx-auto mb-1 opacity-50" />
                  Keine Mitarbeiter gefunden
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Balance Editor Dialog */}
      {editingEmployee && (
        <EmployeeBalanceEditor
          employee={editingEmployee}
          isOpen={!!editingEmployee}
          onClose={() => setEditingEmployee(null)}
          onSave={onUpdateBalance}
        />
      )}

      {/* Confirmation Dialog */}
      <AlertDialog open={confirmDialog.isOpen} onOpenChange={(open) => !open && setConfirmDialog({ isOpen: false, changes: [], isSingle: false })}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Calculator className="h-5 w-5 text-primary" />
              Saldo-Änderungen bestätigen
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDialog.isSingle 
                ? 'Möchten Sie die folgende Änderung übernehmen?' 
                : `Möchten Sie ${confirmDialog.changes.length} Änderungen übernehmen?`}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="text-left py-2 px-3 font-medium">Name</th>
                  <th className="text-right py-2 px-3 font-medium">Aktuell</th>
                  <th className="text-right py-2 px-3 font-medium">Diff</th>
                  <th className="text-right py-2 px-3 font-medium">Neu</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {confirmDialog.changes.map((change) => (
                  <tr key={change.employeeId} className="hover:bg-muted/30">
                    <td className="py-1.5 px-3 font-medium">{change.employeeName}</td>
                    <td className={cn('py-1.5 px-3 text-right font-mono text-xs', getBalanceColor(change.currentBalance))}>
                      {formatHours(change.currentBalance)}
                    </td>
                    <td className={cn('py-1.5 px-3 text-right font-mono text-xs', getBalanceColor(change.difference))}>
                      {formatHours(change.difference)}
                    </td>
                    <td className={cn('py-1.5 px-3 text-right font-mono font-medium', getBalanceColor(change.newBalance))}>
                      {formatHours(change.newBalance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmChanges}>
              Bestätigen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Month Close Dialog */}
      <AlertDialog open={monthCloseDialog.isOpen} onOpenChange={(open) => !open && setMonthCloseDialog({ isOpen: false, year: 0, month: 0, entries: [] })}>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Archive className="h-5 w-5 text-primary" />
              Monatsabschluss {monthCloseDialog.month > 0 && format(new Date(monthCloseDialog.year, monthCloseDialog.month - 1), 'MMMM yyyy', { locale: de })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Die folgenden Salden werden in die Historie gespeichert und die aktuellen Mitarbeiter-Salden entsprechend aktualisiert.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="text-left py-2 px-3 font-medium">Name</th>
                  <th className="text-right py-2 px-3 font-medium text-xs">Saldo Start</th>
                  <th className="text-right py-2 px-3 font-medium text-xs">Soll</th>
                  <th className="text-right py-2 px-3 font-medium text-xs">Ist</th>
                  <th className="text-right py-2 px-3 font-medium text-xs">Saldo Ende</th>
                  <th className="text-right py-2 px-3 font-medium text-xs">Ferien</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {monthCloseDialog.entries.map((entry) => (
                  <tr key={entry.employeeId} className="hover:bg-muted/30">
                    <td className="py-1.5 px-3 font-medium">{entry.employeeName}</td>
                    <td className={cn('py-1.5 px-3 text-right font-mono text-xs', getBalanceColor(entry.hoursBalanceStart))}>
                      {formatHours(entry.hoursBalanceStart)}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono text-xs text-muted-foreground">
                      {entry.hoursTarget.toFixed(1)}h
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono text-xs">
                      {entry.hoursWorked > 0 ? `${entry.hoursWorked.toFixed(1)}h` : '-'}
                    </td>
                    <td className={cn('py-1.5 px-3 text-right font-mono font-medium', getBalanceColor(entry.hoursBalanceEnd))}>
                      {formatHours(entry.hoursBalanceEnd)}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono text-xs text-orange-600 dark:text-orange-400">
                      {entry.vacationBalanceEnd.toFixed(1)}d
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-muted/50 rounded-lg p-3 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Mitarbeiter mit Ist-Stunden:</span>
              <span className="font-medium">{monthCloseDialog.entries.filter(e => e.hoursWorked > 0).length} / {monthCloseDialog.entries.length}</span>
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isClosingMonth}>Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={handleExecuteMonthClose} disabled={isClosingMonth}>
              {isClosingMonth ? 'Wird gespeichert...' : 'Abschluss durchführen'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Balance Export Dialog */}
      <BalanceExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        currentDate={currentPeriod}
        onExport={handleExcelExport}
      />
    </>
  );
};

