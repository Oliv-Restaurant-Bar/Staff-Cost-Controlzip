import { useState, useMemo } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, startOfWeek, endOfWeek, isSameMonth, addWeeks, subWeeks, getISOWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { useWeekSync } from '@/hooks/useWeekSync';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Employee, TimeEntry, DailyBudget, ScheduleImportEntry, MirusDailyImportEntry } from '@/types/personnel';
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Calendar, CalendarDays, Target, TrendingUp, Clock, X, Download, FileSpreadsheet, Users, UtensilsCrossed, Building2, BarChart3, FileText, PenLine } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';
import { PlannedHoursImportButton } from '@/components/PlannedHoursImportButton';
import { ActualHoursImportButton } from '@/components/ActualHoursImportButton';
import { HoursCSVImportButton } from '@/components/HoursCSVImportButton';
import { HoursDirectEntryDialog } from '@/components/HoursDirectEntryDialog';
import { exportComprehensiveReport } from '@/lib/comprehensive-report';

interface HoursEditorProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
  onUpdatePlannedHours?: (date: string, hours: number) => void;
  onImportPlannedHours?: (entries: ScheduleImportEntry[]) => void;
  onImportActualHours?: (entries: MirusDailyImportEntry[]) => void;
}

const WEEKDAYS = [
  { key: 1, label: 'Montag', short: 'Mo' },
  { key: 2, label: 'Dienstag', short: 'Di' },
  { key: 3, label: 'Mittwoch', short: 'Mi' },
  { key: 4, label: 'Donnerstag', short: 'Do' },
  { key: 5, label: 'Freitag', short: 'Fr' },
  { key: 6, label: 'Samstag', short: 'Sa' },
  { key: 0, label: 'Sonntag', short: 'So' },
];

const STEP = 0.5;

type ViewMode = 'week' | 'month';
type HoursMode = 'planned' | 'actual';
type DepartmentFilter = 'all' | 'service' | 'küche';

export const HoursEditor = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
  onImportPlannedHours,
  onImportActualHours,
}: HoursEditorProps) => {
  const { currentWeekStart, currentMonthStart, navigateWeek, navigateMonth, weekNumber } = useWeekSync('HoursEditor', selectedDate);
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [hoursMode, setHoursMode] = useState<HoursMode>('actual');
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [selectedDateForDetail, setSelectedDateForDetail] = useState<string | null>(null);
  const [departmentFilter, setDepartmentFilter] = useState<DepartmentFilter>('all');
  const [directEntryOpen, setDirectEntryOpen] = useState(false);

  const monthDays = useMemo(() => {
    const monthStart = startOfMonth(currentMonthStart);
    const monthEnd = endOfMonth(currentMonthStart);
    return eachDayOfInterval({ start: monthStart, end: monthEnd });
  }, [currentMonthStart]);

  const weekDays = useMemo(() => {
    const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 1 });
    return eachDayOfInterval({ start: currentWeekStart, end: weekEnd });
  }, [currentWeekStart]);

  // navigateMonth and navigateWeek are now provided by useWeekSync hook

  // Filter entries by department
  const filterByDepartment = (entry: TimeEntry) => {
    if (departmentFilter === 'all') return true;
    const employee = employees.find((e) => e.id === entry.employeeId);
    return employee?.department === departmentFilter;
  };

  // Calculate hours for a specific date
  const getHoursForDate = (dateString: string, mode: 'planned' | 'actual') => {
    const dayEntries = timeEntries.filter((te) => te.date === dateString && filterByDepartment(te));
    if (mode === 'planned') {
      return dayEntries.reduce((sum, entry) => sum + (entry.plannedHours || 0), 0);
    }
    return dayEntries.reduce((sum, entry) => sum + (entry.actualHours || 0), 0);
  };

  // Calculate costs for a specific date
  const getCostsForDate = (dateString: string, mode: 'planned' | 'actual') => {
    const dayEntries = timeEntries.filter((te) => te.date === dateString && filterByDepartment(te));
    return dayEntries.reduce((sum, entry) => {
      const employee = employees.find((e) => e.id === entry.employeeId);
      if (!employee) return sum;
      const hours = mode === 'planned' ? (entry.plannedHours || 0) : (entry.actualHours || 0);
      return sum + hours * employee.hourlyWage;
    }, 0);
  };

  const formatHours = (value: number) => {
    return value.toFixed(1).replace('.', ',');
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('de-CH', {
      style: 'decimal',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  // Get detailed breakdown for a specific date
  const getDetailedBreakdown = (dateString: string, mode: 'planned' | 'actual') => {
    const dayEntries = timeEntries.filter((te) => te.date === dateString && filterByDepartment(te));
    return dayEntries.map(entry => {
      const employee = employees.find((e) => e.id === entry.employeeId);
      const hours = mode === 'planned' ? (entry.plannedHours || 0) : (entry.actualHours || 0);
      const cost = employee ? hours * employee.hourlyWage : 0;
      return {
        employeeName: employee?.name || 'Unbekannt',
        employeeId: entry.employeeId,
        hours,
        cost,
        hourlyWage: employee?.hourlyWage || 0,
        department: employee?.department || 'unknown',
      };
    }).filter(item => item.hours > 0).sort((a, b) => b.hours - a.hours);
  };

  // Get combined breakdown with both planned and actual hours for comparison
  const getCombinedBreakdown = (dateString: string) => {
    const dayEntries = timeEntries.filter((te) => te.date === dateString && filterByDepartment(te));
    return dayEntries.map(entry => {
      const employee = employees.find((e) => e.id === entry.employeeId);
      const plannedHours = entry.plannedHours || 0;
      const actualHours = entry.actualHours || 0;
      const plannedCost = employee ? plannedHours * employee.hourlyWage : 0;
      const actualCost = employee ? actualHours * employee.hourlyWage : 0;
      return {
        employeeName: employee?.name || 'Unbekannt',
        employeeId: entry.employeeId,
        plannedHours,
        actualHours,
        plannedCost,
        actualCost,
        hoursDiff: actualHours - plannedHours,
        costDiff: actualCost - plannedCost,
        hourlyWage: employee?.hourlyWage || 0,
        department: employee?.department || 'unknown',
      };
    }).filter(item => item.plannedHours > 0 || item.actualHours > 0).sort((a, b) => (b.actualHours + b.plannedHours) - (a.actualHours + a.plannedHours));
  };

  const handleHoursClick = (dateString: string) => {
    setSelectedDateForDetail(dateString);
    setDetailDialogOpen(true);
  };

  // Export to PDF with Plan vs Ist comparison
  const exportToPDF = () => {
    if (!selectedDateForDetail || selectedDateCombinedBreakdown.length === 0) return;

    const doc = new jsPDF();
    const dateStr = format(new Date(selectedDateForDetail), 'EEEE, d. MMMM yyyy', { locale: de });
    
    // Title
    doc.setFontSize(18);
    doc.text('Plan vs. Ist Aufschlüsselung', 14, 20);
    doc.setFontSize(12);
    doc.text(dateStr, 14, 28);

    // Calculate totals
    const totalPlanned = selectedDateCombinedBreakdown.reduce((sum, item) => sum + item.plannedHours, 0);
    const totalActual = selectedDateCombinedBreakdown.reduce((sum, item) => sum + item.actualHours, 0);
    const totalPlannedCost = selectedDateCombinedBreakdown.reduce((sum, item) => sum + item.plannedCost, 0);
    const totalActualCost = selectedDateCombinedBreakdown.reduce((sum, item) => sum + item.actualCost, 0);
    const hoursDiff = totalActual - totalPlanned;
    const costDiff = totalActualCost - totalPlannedCost;

    // Calculate department totals
    const serviceItems = selectedDateCombinedBreakdown.filter(item => item.department === 'service');
    const kuecheItems = selectedDateCombinedBreakdown.filter(item => item.department === 'küche');
    
    const servicePlannedHours = serviceItems.reduce((sum, item) => sum + item.plannedHours, 0);
    const serviceActualHours = serviceItems.reduce((sum, item) => sum + item.actualHours, 0);
    const servicePlannedCost = serviceItems.reduce((sum, item) => sum + item.plannedCost, 0);
    const serviceActualCost = serviceItems.reduce((sum, item) => sum + item.actualCost, 0);
    
    const kuechePlannedHours = kuecheItems.reduce((sum, item) => sum + item.plannedHours, 0);
    const kuecheActualHours = kuecheItems.reduce((sum, item) => sum + item.actualHours, 0);
    const kuechePlannedCost = kuecheItems.reduce((sum, item) => sum + item.plannedCost, 0);
    const kuecheActualCost = kuecheItems.reduce((sum, item) => sum + item.actualCost, 0);

    // Summary section with department breakdown
    doc.setFontSize(10);
    doc.text('Zusammenfassung:', 14, 38);
    
    // Service
    if (serviceItems.length > 0) {
      doc.text(`Service (${serviceItems.length} MA): Plan ${servicePlannedHours.toFixed(1)} Std / CHF ${servicePlannedCost.toFixed(0)} → Ist ${serviceActualHours.toFixed(1)} Std / CHF ${serviceActualCost.toFixed(0)}`, 14, 44);
    }
    // Küche
    if (kuecheItems.length > 0) {
      doc.text(`Küche (${kuecheItems.length} MA): Plan ${kuechePlannedHours.toFixed(1)} Std / CHF ${kuechePlannedCost.toFixed(0)} → Ist ${kuecheActualHours.toFixed(1)} Std / CHF ${kuecheActualCost.toFixed(0)}`, 14, 50);
    }
    // Total
    doc.setFont(undefined, 'bold');
    doc.text(`Gesamt: Plan ${totalPlanned.toFixed(1)} Std / CHF ${totalPlannedCost.toFixed(0)} → Ist ${totalActual.toFixed(1)} Std / CHF ${totalActualCost.toFixed(0)} | Diff: ${costDiff >= 0 ? '+' : ''}CHF ${costDiff.toFixed(0)}`, 14, 56);
    doc.setFont(undefined, 'normal');

    // Build table data with department subtotals
    const tableData: (string | number)[][] = [];
    
    // Service section
    if (serviceItems.length > 0) {
      serviceItems.forEach(item => {
        tableData.push([
          'Service',
          item.employeeName,
          `CHF ${item.hourlyWage.toFixed(2)}`,
          item.plannedHours.toFixed(1).replace('.', ','),
          item.actualHours.toFixed(1).replace('.', ','),
          `${item.hoursDiff >= 0 ? '+' : ''}${item.hoursDiff.toFixed(1).replace('.', ',')}`,
          `CHF ${item.plannedCost.toFixed(0)}`,
          `CHF ${item.actualCost.toFixed(0)}`,
          `${item.costDiff >= 0 ? '+' : ''}CHF ${item.costDiff.toFixed(0)}`,
        ]);
      });
      // Service subtotal
      tableData.push([
        '►',
        `Total Service (${serviceItems.length} MA)`,
        '',
        servicePlannedHours.toFixed(1).replace('.', ','),
        serviceActualHours.toFixed(1).replace('.', ','),
        `${(serviceActualHours - servicePlannedHours) >= 0 ? '+' : ''}${(serviceActualHours - servicePlannedHours).toFixed(1).replace('.', ',')}`,
        `CHF ${servicePlannedCost.toFixed(0)}`,
        `CHF ${serviceActualCost.toFixed(0)}`,
        `${(serviceActualCost - servicePlannedCost) >= 0 ? '+' : ''}CHF ${(serviceActualCost - servicePlannedCost).toFixed(0)}`,
      ]);
    }
    
    // Küche section
    if (kuecheItems.length > 0) {
      kuecheItems.forEach(item => {
        tableData.push([
          'Küche',
          item.employeeName,
          `CHF ${item.hourlyWage.toFixed(2)}`,
          item.plannedHours.toFixed(1).replace('.', ','),
          item.actualHours.toFixed(1).replace('.', ','),
          `${item.hoursDiff >= 0 ? '+' : ''}${item.hoursDiff.toFixed(1).replace('.', ',')}`,
          `CHF ${item.plannedCost.toFixed(0)}`,
          `CHF ${item.actualCost.toFixed(0)}`,
          `${item.costDiff >= 0 ? '+' : ''}CHF ${item.costDiff.toFixed(0)}`,
        ]);
      });
      // Küche subtotal
      tableData.push([
        '►',
        `Total Küche (${kuecheItems.length} MA)`,
        '',
        kuechePlannedHours.toFixed(1).replace('.', ','),
        kuecheActualHours.toFixed(1).replace('.', ','),
        `${(kuecheActualHours - kuechePlannedHours) >= 0 ? '+' : ''}${(kuecheActualHours - kuechePlannedHours).toFixed(1).replace('.', ',')}`,
        `CHF ${kuechePlannedCost.toFixed(0)}`,
        `CHF ${kuecheActualCost.toFixed(0)}`,
        `${(kuecheActualCost - kuechePlannedCost) >= 0 ? '+' : ''}CHF ${(kuecheActualCost - kuechePlannedCost).toFixed(0)}`,
      ]);
    }

    // Grand total
    tableData.push([
      '★', 
      'GESAMT', 
      '',
      totalPlanned.toFixed(1).replace('.', ','),
      totalActual.toFixed(1).replace('.', ','),
      `${hoursDiff >= 0 ? '+' : ''}${hoursDiff.toFixed(1).replace('.', ',')}`,
      `CHF ${totalPlannedCost.toFixed(0)}`,
      `CHF ${totalActualCost.toFixed(0)}`,
      `${costDiff >= 0 ? '+' : ''}CHF ${costDiff.toFixed(0)}`,
    ]);

    autoTable(doc, {
      head: [['Abt.', 'Mitarbeiter', 'CHF/Std', 'Plan Std', 'Ist Std', 'Diff Std', 'Plan CHF', 'Ist CHF', 'Diff CHF']],
      body: tableData,
      startY: 62,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [59, 130, 246] },
      columnStyles: {
        0: { cellWidth: 15 },
        1: { cellWidth: 32 },
        2: { cellWidth: 18 },
        5: { fontStyle: 'bold' },
        8: { fontStyle: 'bold' },
      },
      didParseCell: (data) => {
        // Style subtotal rows
        if (data.row.raw && Array.isArray(data.row.raw) && (data.row.raw[0] === '►' || data.row.raw[0] === '★')) {
          data.cell.styles.fillColor = data.row.raw[0] === '★' ? [59, 130, 246] : [229, 231, 235];
          data.cell.styles.fontStyle = 'bold';
          if (data.row.raw[0] === '★') {
            data.cell.styles.textColor = [255, 255, 255];
          }
        }
      },
    });

    const fileName = `plan-ist-vergleich-${format(new Date(selectedDateForDetail), 'yyyy-MM-dd')}.pdf`;
    doc.save(fileName);
    toast.success('PDF mit Plan/Ist-Vergleich exportiert');
  };

  // Export to Excel with Plan vs Ist comparison
  const exportToExcel = async () => {
    if (!selectedDateForDetail || selectedDateCombinedBreakdown.length === 0) return;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Plan vs Ist Vergleich');
    
    const dateStr = format(new Date(selectedDateForDetail), 'EEEE, d. MMMM yyyy', { locale: de });

    // Title
    const titleRow = worksheet.addRow(['Plan vs. Ist Aufschlüsselung']);
    titleRow.font = { bold: true, size: 14 };
    worksheet.addRow([dateStr]);
    worksheet.addRow([]);

    // Calculate totals
    const totalPlanned = selectedDateCombinedBreakdown.reduce((sum, item) => sum + item.plannedHours, 0);
    const totalActual = selectedDateCombinedBreakdown.reduce((sum, item) => sum + item.actualHours, 0);
    const totalPlannedCost = selectedDateCombinedBreakdown.reduce((sum, item) => sum + item.plannedCost, 0);
    const totalActualCost = selectedDateCombinedBreakdown.reduce((sum, item) => sum + item.actualCost, 0);
    const hoursDiff = totalActual - totalPlanned;
    const costDiff = totalActualCost - totalPlannedCost;

    // Calculate department totals
    const serviceItems = selectedDateCombinedBreakdown.filter(item => item.department === 'service');
    const kuecheItems = selectedDateCombinedBreakdown.filter(item => item.department === 'küche');
    
    const servicePlannedHours = serviceItems.reduce((sum, item) => sum + item.plannedHours, 0);
    const serviceActualHours = serviceItems.reduce((sum, item) => sum + item.actualHours, 0);
    const servicePlannedCost = serviceItems.reduce((sum, item) => sum + item.plannedCost, 0);
    const serviceActualCost = serviceItems.reduce((sum, item) => sum + item.actualCost, 0);
    const serviceHoursDiff = serviceActualHours - servicePlannedHours;
    const serviceCostDiff = serviceActualCost - servicePlannedCost;
    
    const kuechePlannedHours = kuecheItems.reduce((sum, item) => sum + item.plannedHours, 0);
    const kuecheActualHours = kuecheItems.reduce((sum, item) => sum + item.actualHours, 0);
    const kuechePlannedCost = kuecheItems.reduce((sum, item) => sum + item.plannedCost, 0);
    const kuecheActualCost = kuecheItems.reduce((sum, item) => sum + item.actualCost, 0);
    const kuecheHoursDiff = kuecheActualHours - kuechePlannedHours;
    const kuecheCostDiff = kuecheActualCost - kuechePlannedCost;

    // Summary section
    worksheet.addRow(['Zusammenfassung nach Abteilung']);
    const summaryHeaderRow = worksheet.addRow(['Abteilung', 'Anz. MA', 'Plan Std', 'Ist Std', 'Diff Std', 'Plan CHF', 'Ist CHF', 'Diff CHF']);
    summaryHeaderRow.font = { bold: true };
    summaryHeaderRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    });
    
    if (serviceItems.length > 0) {
      const serviceRow = worksheet.addRow(['Service', serviceItems.length, servicePlannedHours, serviceActualHours, serviceHoursDiff, servicePlannedCost, serviceActualCost, serviceCostDiff]);
      serviceRow.getCell(5).font = { color: { argb: serviceHoursDiff > 0 ? 'FFDC2626' : serviceHoursDiff < 0 ? 'FF16A34A' : 'FF000000' } };
      serviceRow.getCell(8).font = { bold: true, color: { argb: serviceCostDiff > 0 ? 'FFDC2626' : serviceCostDiff < 0 ? 'FF16A34A' : 'FF000000' } };
    }
    
    if (kuecheItems.length > 0) {
      const kuecheRow = worksheet.addRow(['Küche', kuecheItems.length, kuechePlannedHours, kuecheActualHours, kuecheHoursDiff, kuechePlannedCost, kuecheActualCost, kuecheCostDiff]);
      kuecheRow.getCell(5).font = { color: { argb: kuecheHoursDiff > 0 ? 'FFDC2626' : kuecheHoursDiff < 0 ? 'FF16A34A' : 'FF000000' } };
      kuecheRow.getCell(8).font = { bold: true, color: { argb: kuecheCostDiff > 0 ? 'FFDC2626' : kuecheCostDiff < 0 ? 'FF16A34A' : 'FF000000' } };
    }
    
    const summaryTotalRow = worksheet.addRow(['GESAMT', serviceItems.length + kuecheItems.length, totalPlanned, totalActual, hoursDiff, totalPlannedCost, totalActualCost, costDiff]);
    summaryTotalRow.font = { bold: true };
    summaryTotalRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });
    
    worksheet.addRow([]);
    worksheet.addRow([]);

    // Detail Headers
    const headerRow = worksheet.addRow([
      'Abteilung', 'Mitarbeiter', 'Stundenlohn', 
      'Plan Std', 'Ist Std', 'Diff Std',
      'Plan CHF', 'Ist CHF', 'Diff CHF'
    ]);
    headerRow.font = { bold: true };
    headerRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });

    // Service employees
    if (serviceItems.length > 0) {
      serviceItems.forEach(item => {
        const row = worksheet.addRow([
          'Service', item.employeeName, item.hourlyWage,
          item.plannedHours, item.actualHours, item.hoursDiff,
          item.plannedCost, item.actualCost, item.costDiff,
        ]);
        row.getCell(6).font = { color: { argb: item.hoursDiff > 0 ? 'FFDC2626' : item.hoursDiff < 0 ? 'FF16A34A' : 'FF000000' } };
        row.getCell(9).font = { color: { argb: item.costDiff > 0 ? 'FFDC2626' : item.costDiff < 0 ? 'FF16A34A' : 'FF000000' } };
      });
      
      // Service subtotal
      const serviceSubtotalRow = worksheet.addRow([
        '►', `Total Service (${serviceItems.length} MA)`, '',
        servicePlannedHours, serviceActualHours, serviceHoursDiff,
        servicePlannedCost, serviceActualCost, serviceCostDiff
      ]);
      serviceSubtotalRow.font = { bold: true };
      serviceSubtotalRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
      });
      serviceSubtotalRow.getCell(6).font = { bold: true, color: { argb: serviceHoursDiff > 0 ? 'FFDC2626' : serviceHoursDiff < 0 ? 'FF16A34A' : 'FF000000' } };
      serviceSubtotalRow.getCell(9).font = { bold: true, color: { argb: serviceCostDiff > 0 ? 'FFDC2626' : serviceCostDiff < 0 ? 'FF16A34A' : 'FF000000' } };
    }
    
    // Küche employees
    if (kuecheItems.length > 0) {
      kuecheItems.forEach(item => {
        const row = worksheet.addRow([
          'Küche', item.employeeName, item.hourlyWage,
          item.plannedHours, item.actualHours, item.hoursDiff,
          item.plannedCost, item.actualCost, item.costDiff,
        ]);
        row.getCell(6).font = { color: { argb: item.hoursDiff > 0 ? 'FFDC2626' : item.hoursDiff < 0 ? 'FF16A34A' : 'FF000000' } };
        row.getCell(9).font = { color: { argb: item.costDiff > 0 ? 'FFDC2626' : item.costDiff < 0 ? 'FF16A34A' : 'FF000000' } };
      });
      
      // Küche subtotal
      const kuecheSubtotalRow = worksheet.addRow([
        '►', `Total Küche (${kuecheItems.length} MA)`, '',
        kuechePlannedHours, kuecheActualHours, kuecheHoursDiff,
        kuechePlannedCost, kuecheActualCost, kuecheCostDiff
      ]);
      kuecheSubtotalRow.font = { bold: true };
      kuecheSubtotalRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFED7AA' } };
      });
      kuecheSubtotalRow.getCell(6).font = { bold: true, color: { argb: kuecheHoursDiff > 0 ? 'FFDC2626' : kuecheHoursDiff < 0 ? 'FF16A34A' : 'FF000000' } };
      kuecheSubtotalRow.getCell(9).font = { bold: true, color: { argb: kuecheCostDiff > 0 ? 'FFDC2626' : kuecheCostDiff < 0 ? 'FF16A34A' : 'FF000000' } };
    }

    // Grand total row
    worksheet.addRow([]);
    const totalRow = worksheet.addRow([
      '★', 'GESAMT', '',
      totalPlanned, totalActual, hoursDiff,
      totalPlannedCost, totalActualCost, costDiff
    ]);
    totalRow.font = { bold: true };
    totalRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });

    // Column widths
    worksheet.columns = [
      { width: 12 },
      { width: 26 },
      { width: 12 },
      { width: 10 },
      { width: 10 },
      { width: 10 },
      { width: 12 },
      { width: 12 },
      { width: 12 },
    ];

    // Format number columns
    worksheet.getColumn(3).numFmt = '#,##0.00';
    worksheet.getColumn(4).numFmt = '#,##0.0';
    worksheet.getColumn(5).numFmt = '#,##0.0';
    worksheet.getColumn(6).numFmt = '+#,##0.0;-#,##0.0;0';
    worksheet.getColumn(7).numFmt = '#,##0';
    worksheet.getColumn(8).numFmt = '#,##0';
    worksheet.getColumn(9).numFmt = '+#,##0;-#,##0;0';

    // Generate and download
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `plan-ist-vergleich-${format(new Date(selectedDateForDetail), 'yyyy-MM-dd')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Excel mit Plan/Ist-Vergleich exportiert');
  };

  // Export monthly report to PDF
  const exportMonthlyToPDF = () => {
    const doc = new jsPDF('landscape');
    const monthStr = format(currentMonthStart, 'MMMM yyyy', { locale: de });
    const modeStr = hoursMode === 'actual' ? 'Ist-Stunden' : 'Plan-Stunden';
    const days = viewMode === 'week' ? weekDays : monthDays;
    
    // Title
    doc.setFontSize(16);
    doc.text(`${modeStr} Monatsübersicht - ${monthStr}`, 14, 15);

    // Collect all employees with hours
    const employeeHours: Record<string, { name: string; department: string; hourlyWage: number; dailyHours: Record<string, number>; total: number; cost: number }> = {};
    
    days.forEach(day => {
      const dateString = format(day, 'yyyy-MM-dd');
      const breakdown = getDetailedBreakdown(dateString, hoursMode);
      breakdown.forEach(item => {
        if (!employeeHours[item.employeeId]) {
          employeeHours[item.employeeId] = {
            name: item.employeeName,
            department: item.department,
            hourlyWage: item.hourlyWage,
            dailyHours: {},
            total: 0,
            cost: 0,
          };
        }
        employeeHours[item.employeeId].dailyHours[dateString] = item.hours;
        employeeHours[item.employeeId].total += item.hours;
        employeeHours[item.employeeId].cost += item.cost;
      });
    });

    // Create table headers
    const headers = ['Mitarbeiter', 'Abteilung', ...days.map(d => format(d, 'd', { locale: de })), 'Total Std', 'Kosten CHF'];
    
    // Create table data
    const tableData = Object.values(employeeHours)
      .sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name))
      .map(emp => [
        emp.name,
        emp.department === 'service' ? 'Service' : 'Küche',
        ...days.map(d => {
          const h = emp.dailyHours[format(d, 'yyyy-MM-dd')] || 0;
          return h > 0 ? h.toFixed(1) : '-';
        }),
        emp.total.toFixed(1),
        emp.cost.toFixed(0),
      ]);

    // Add daily totals row
    const dailyTotals = days.map(day => {
      const dateString = format(day, 'yyyy-MM-dd');
      return getHoursForDate(dateString, hoursMode);
    });
    const grandTotal = dailyTotals.reduce((sum, h) => sum + h, 0);
    const grandCost = Object.values(employeeHours).reduce((sum, emp) => sum + emp.cost, 0);
    
    tableData.push([
      'TOTAL',
      '',
      ...dailyTotals.map(h => h > 0 ? h.toFixed(1) : '-'),
      grandTotal.toFixed(1),
      grandCost.toFixed(0),
    ]);

    autoTable(doc, {
      head: [headers],
      body: tableData,
      startY: 22,
      styles: { fontSize: 7, cellPadding: 1 },
      headStyles: { fillColor: [59, 130, 246], fontSize: 7 },
      columnStyles: {
        0: { cellWidth: 30 },
        1: { cellWidth: 15 },
      },
    });

    doc.save(`monatsübersicht-${format(currentMonthStart, 'yyyy-MM')}.pdf`);
    toast.success('Monats-PDF exportiert');
  };

  // Export weekly report to Excel with previous week comparison
  const exportWeeklyToExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Wochenübersicht');
    
    const weekStr = `KW ${weekNumber} (${format(currentWeekStart, 'dd.MM.', { locale: de })} - ${format(endOfWeek(currentWeekStart, { weekStartsOn: 1 }), 'dd.MM.yyyy', { locale: de })})`;
    const prevWeekStart = subWeeks(currentWeekStart, 1);
    const prevWeekNumber = getISOWeek(prevWeekStart);
    const prevWeekEnd = endOfWeek(prevWeekStart, { weekStartsOn: 1 });
    const prevWeekDays = eachDayOfInterval({ start: prevWeekStart, end: prevWeekEnd });
    
    // Title
    const titleRow = worksheet.addRow([`Wochenübersicht - ${weekStr}`]);
    titleRow.font = { bold: true, size: 14 };
    worksheet.addRow([`Abteilung: ${departmentFilter === 'all' ? 'Alle' : departmentFilter === 'service' ? 'Service' : 'Küche'}`]);
    worksheet.addRow([]);

    // Calculate previous week totals
    let prevWeekPlannedHours = 0;
    let prevWeekActualHours = 0;
    let prevWeekPlannedCosts = 0;
    let prevWeekActualCosts = 0;
    
    prevWeekDays.forEach(day => {
      const dateString = format(day, 'yyyy-MM-dd');
      prevWeekPlannedHours += getHoursForDate(dateString, 'planned');
      prevWeekActualHours += getHoursForDate(dateString, 'actual');
      prevWeekPlannedCosts += getCostsForDate(dateString, 'planned');
      prevWeekActualCosts += getCostsForDate(dateString, 'actual');
    });

    // Summary section with week comparison
    worksheet.addRow(['Zusammenfassung & Vorwochenvergleich']);
    const summaryHeaderRow = worksheet.addRow(['', 'Plan Stunden', 'Ist Stunden', 'Diff Stunden', 'Plan Kosten CHF', 'Ist Kosten CHF', 'Diff Kosten CHF']);
    summaryHeaderRow.font = { bold: true };
    summaryHeaderRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    });
    
    const hoursDiff = weekActualHours - weekPlannedHours;
    const costDiff = weekActualCosts - weekPlannedCosts;
    const summaryRow = worksheet.addRow([`Aktuelle Woche (KW ${weekNumber})`, weekPlannedHours, weekActualHours, hoursDiff, weekPlannedCosts, weekActualCosts, costDiff]);
    summaryRow.getCell(4).font = { color: { argb: hoursDiff > 0 ? 'FFDC2626' : hoursDiff < 0 ? 'FF16A34A' : 'FF000000' } };
    summaryRow.getCell(7).font = { bold: true, color: { argb: costDiff > 0 ? 'FFDC2626' : costDiff < 0 ? 'FF16A34A' : 'FF000000' } };
    
    const prevHoursDiff = prevWeekActualHours - prevWeekPlannedHours;
    const prevCostDiff = prevWeekActualCosts - prevWeekPlannedCosts;
    const prevSummaryRow = worksheet.addRow([`Vorwoche (KW ${prevWeekNumber})`, prevWeekPlannedHours, prevWeekActualHours, prevHoursDiff, prevWeekPlannedCosts, prevWeekActualCosts, prevCostDiff]);
    prevSummaryRow.getCell(4).font = { color: { argb: prevHoursDiff > 0 ? 'FFDC2626' : prevHoursDiff < 0 ? 'FF16A34A' : 'FF000000' } };
    prevSummaryRow.getCell(7).font = { bold: true, color: { argb: prevCostDiff > 0 ? 'FFDC2626' : prevCostDiff < 0 ? 'FF16A34A' : 'FF000000' } };
    
    // Week-over-week change
    worksheet.addRow([]);
    const wowHeaderRow = worksheet.addRow(['Veränderung zur Vorwoche', 'Plan Stunden', 'Ist Stunden', '', 'Plan Kosten CHF', 'Ist Kosten CHF', '']);
    wowHeaderRow.font = { bold: true };
    wowHeaderRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6366F1' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });
    
    const plannedHoursChange = weekPlannedHours - prevWeekPlannedHours;
    const actualHoursChange = weekActualHours - prevWeekActualHours;
    const plannedCostChange = weekPlannedCosts - prevWeekPlannedCosts;
    const actualCostChange = weekActualCosts - prevWeekActualCosts;
    const plannedHoursChangePercent = prevWeekPlannedHours > 0 ? ((weekPlannedHours - prevWeekPlannedHours) / prevWeekPlannedHours) * 100 : 0;
    const actualHoursChangePercent = prevWeekActualHours > 0 ? ((weekActualHours - prevWeekActualHours) / prevWeekActualHours) * 100 : 0;
    const plannedCostChangePercent = prevWeekPlannedCosts > 0 ? ((weekPlannedCosts - prevWeekPlannedCosts) / prevWeekPlannedCosts) * 100 : 0;
    const actualCostChangePercent = prevWeekActualCosts > 0 ? ((weekActualCosts - prevWeekActualCosts) / prevWeekActualCosts) * 100 : 0;
    
    const changeRow = worksheet.addRow([
      'Absolut',
      plannedHoursChange,
      actualHoursChange,
      '',
      plannedCostChange,
      actualCostChange,
      ''
    ]);
    changeRow.getCell(2).font = { color: { argb: plannedHoursChange > 0 ? 'FFDC2626' : plannedHoursChange < 0 ? 'FF16A34A' : 'FF000000' } };
    changeRow.getCell(3).font = { color: { argb: actualHoursChange > 0 ? 'FFDC2626' : actualHoursChange < 0 ? 'FF16A34A' : 'FF000000' } };
    changeRow.getCell(5).font = { bold: true, color: { argb: plannedCostChange > 0 ? 'FFDC2626' : plannedCostChange < 0 ? 'FF16A34A' : 'FF000000' } };
    changeRow.getCell(6).font = { bold: true, color: { argb: actualCostChange > 0 ? 'FFDC2626' : actualCostChange < 0 ? 'FF16A34A' : 'FF000000' } };
    
    const percentRow = worksheet.addRow([
      'Prozentual',
      `${plannedHoursChangePercent >= 0 ? '+' : ''}${plannedHoursChangePercent.toFixed(1)}%`,
      `${actualHoursChangePercent >= 0 ? '+' : ''}${actualHoursChangePercent.toFixed(1)}%`,
      '',
      `${plannedCostChangePercent >= 0 ? '+' : ''}${plannedCostChangePercent.toFixed(1)}%`,
      `${actualCostChangePercent >= 0 ? '+' : ''}${actualCostChangePercent.toFixed(1)}%`,
      ''
    ]);
    percentRow.getCell(2).font = { color: { argb: plannedHoursChangePercent > 0 ? 'FFDC2626' : plannedHoursChangePercent < 0 ? 'FF16A34A' : 'FF000000' } };
    percentRow.getCell(3).font = { color: { argb: actualHoursChangePercent > 0 ? 'FFDC2626' : actualHoursChangePercent < 0 ? 'FF16A34A' : 'FF000000' } };
    percentRow.getCell(5).font = { bold: true, color: { argb: plannedCostChangePercent > 0 ? 'FFDC2626' : plannedCostChangePercent < 0 ? 'FF16A34A' : 'FF000000' } };
    percentRow.getCell(6).font = { bold: true, color: { argb: actualCostChangePercent > 0 ? 'FFDC2626' : actualCostChangePercent < 0 ? 'FF16A34A' : 'FF000000' } };
    
    worksheet.addRow([]);
    worksheet.addRow([]);

    // Collect all employees with hours for current week
    const employeeHours: Record<string, { name: string; department: string; hourlyWage: number; dailyPlanned: Record<string, number>; dailyActual: Record<string, number>; totalPlanned: number; totalActual: number; plannedCost: number; actualCost: number }> = {};
    
    weekDays.forEach(day => {
      const dateString = format(day, 'yyyy-MM-dd');
      const breakdown = getCombinedBreakdown(dateString);
      breakdown.forEach(item => {
        if (!employeeHours[item.employeeId]) {
          employeeHours[item.employeeId] = {
            name: item.employeeName,
            department: item.department,
            hourlyWage: item.hourlyWage,
            dailyPlanned: {},
            dailyActual: {},
            totalPlanned: 0,
            totalActual: 0,
            plannedCost: 0,
            actualCost: 0,
          };
        }
        employeeHours[item.employeeId].dailyPlanned[dateString] = item.plannedHours;
        employeeHours[item.employeeId].dailyActual[dateString] = item.actualHours;
        employeeHours[item.employeeId].totalPlanned += item.plannedHours;
        employeeHours[item.employeeId].totalActual += item.actualHours;
        employeeHours[item.employeeId].plannedCost += item.plannedCost;
        employeeHours[item.employeeId].actualCost += item.actualCost;
      });
    });

    // Detail sheet with Plan vs Actual per day
    worksheet.addRow(['Detailübersicht Plan vs. Ist']);
    const detailHeaders = ['Mitarbeiter', 'Abteilung', 'CHF/Std', ...weekDays.flatMap(d => [format(d, 'EEE d.M', { locale: de }) + ' Plan', format(d, 'EEE d.M', { locale: de }) + ' Ist']), 'Total Plan', 'Total Ist', 'Diff Std', 'Plan CHF', 'Ist CHF', 'Diff CHF'];
    const detailHeaderRow = worksheet.addRow(detailHeaders);
    detailHeaderRow.font = { bold: true };
    detailHeaderRow.eachCell((cell, colNumber) => {
      if (colNumber <= 3) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
      } else if (colNumber <= 3 + weekDays.length * 2) {
        const isActual = (colNumber - 4) % 2 === 1;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isActual ? 'FF22C55E' : 'FF3B82F6' } };
      } else {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6366F1' } };
      }
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });

    // Data rows
    Object.values(employeeHours)
      .sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name))
      .forEach(emp => {
        const empHoursDiff = emp.totalActual - emp.totalPlanned;
        const empCostDiff = emp.actualCost - emp.plannedCost;
        const row = worksheet.addRow([
          emp.name,
          emp.department === 'service' ? 'Service' : 'Küche',
          emp.hourlyWage,
          ...weekDays.flatMap(d => {
            const dateStr = format(d, 'yyyy-MM-dd');
            return [emp.dailyPlanned[dateStr] || 0, emp.dailyActual[dateStr] || 0];
          }),
          emp.totalPlanned,
          emp.totalActual,
          empHoursDiff,
          emp.plannedCost,
          emp.actualCost,
          empCostDiff,
        ]);
        // Color the diff cells
        const diffStdCol = 4 + weekDays.length * 2 + 2;
        const diffChfCol = 4 + weekDays.length * 2 + 5;
        row.getCell(diffStdCol).font = { color: { argb: empHoursDiff > 0 ? 'FFDC2626' : empHoursDiff < 0 ? 'FF16A34A' : 'FF000000' } };
        row.getCell(diffChfCol).font = { bold: true, color: { argb: empCostDiff > 0 ? 'FFDC2626' : empCostDiff < 0 ? 'FF16A34A' : 'FF000000' } };
      });

    // Totals row
    const dailyPlannedTotals = weekDays.map(day => getHoursForDate(format(day, 'yyyy-MM-dd'), 'planned'));
    const dailyActualTotals = weekDays.map(day => getHoursForDate(format(day, 'yyyy-MM-dd'), 'actual'));
    const grandPlanned = dailyPlannedTotals.reduce((sum, h) => sum + h, 0);
    const grandActual = dailyActualTotals.reduce((sum, h) => sum + h, 0);
    const grandPlannedCost = Object.values(employeeHours).reduce((sum, emp) => sum + emp.plannedCost, 0);
    const grandActualCost = Object.values(employeeHours).reduce((sum, emp) => sum + emp.actualCost, 0);
    
    worksheet.addRow([]);
    const totalDiff = grandActual - grandPlanned;
    const totalCostDiff = grandActualCost - grandPlannedCost;
    const totalRow = worksheet.addRow([
      'TOTAL', 
      '', 
      '', 
      ...weekDays.flatMap((_, i) => [dailyPlannedTotals[i], dailyActualTotals[i]]),
      grandPlanned, 
      grandActual, 
      totalDiff,
      grandPlannedCost, 
      grandActualCost,
      totalCostDiff
    ]);
    totalRow.font = { bold: true };
    totalRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    });
    const diffStdColTotal = 4 + weekDays.length * 2 + 2;
    const diffChfColTotal = 4 + weekDays.length * 2 + 5;
    totalRow.getCell(diffStdColTotal).font = { bold: true, color: { argb: totalDiff > 0 ? 'FFDC2626' : totalDiff < 0 ? 'FF16A34A' : 'FF000000' } };
    totalRow.getCell(diffChfColTotal).font = { bold: true, color: { argb: totalCostDiff > 0 ? 'FFDC2626' : totalCostDiff < 0 ? 'FF16A34A' : 'FF000000' } };

    // Column widths
    worksheet.getColumn(1).width = 28;
    worksheet.getColumn(2).width = 14;
    worksheet.getColumn(3).width = 10;
    for (let i = 4; i <= 3 + weekDays.length * 2; i++) {
      worksheet.getColumn(i).width = 9;
    }
    worksheet.getColumn(4 + weekDays.length * 2).width = 10;
    worksheet.getColumn(5 + weekDays.length * 2).width = 10;
    worksheet.getColumn(6 + weekDays.length * 2).width = 10;
    worksheet.getColumn(7 + weekDays.length * 2).width = 10;
    worksheet.getColumn(8 + weekDays.length * 2).width = 10;
    worksheet.getColumn(9 + weekDays.length * 2).width = 10;

    // Generate and download
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wochenübersicht-kw${weekNumber}-${format(currentWeekStart, 'yyyy')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Wochen-Excel mit Vorwochenvergleich exportiert');
  };

  // Export monthly report to Excel
  const exportMonthlyToExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Monatsübersicht');
    
    const monthStr = format(currentMonthStart, 'MMMM yyyy', { locale: de });
    const modeStr = hoursMode === 'actual' ? 'Ist-Stunden' : 'Plan-Stunden';
    const days = viewMode === 'week' ? weekDays : monthDays;

    // Title
    worksheet.addRow([`${modeStr} Monatsübersicht - ${monthStr}`]);
    worksheet.addRow([]);

    // Collect all employees with hours
    const employeeHours: Record<string, { name: string; department: string; hourlyWage: number; dailyHours: Record<string, number>; total: number; cost: number }> = {};
    
    days.forEach(day => {
      const dateString = format(day, 'yyyy-MM-dd');
      const breakdown = getDetailedBreakdown(dateString, hoursMode);
      breakdown.forEach(item => {
        if (!employeeHours[item.employeeId]) {
          employeeHours[item.employeeId] = {
            name: item.employeeName,
            department: item.department,
            hourlyWage: item.hourlyWage,
            dailyHours: {},
            total: 0,
            cost: 0,
          };
        }
        employeeHours[item.employeeId].dailyHours[dateString] = item.hours;
        employeeHours[item.employeeId].total += item.hours;
        employeeHours[item.employeeId].cost += item.cost;
      });
    });

    // Headers
    const headers = ['Mitarbeiter', 'Abteilung', 'Stundenlohn', ...days.map(d => format(d, 'EEE d.M', { locale: de })), 'Total Std', 'Kosten CHF'];
    const headerRow = worksheet.addRow(headers);
    headerRow.font = { bold: true };
    headerRow.eachCell(cell => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF3B82F6' },
      };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });

    // Data rows
    Object.values(employeeHours)
      .sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name))
      .forEach(emp => {
        worksheet.addRow([
          emp.name,
          emp.department === 'service' ? 'Service' : 'Küche',
          emp.hourlyWage,
          ...days.map(d => emp.dailyHours[format(d, 'yyyy-MM-dd')] || 0),
          emp.total,
          emp.cost,
        ]);
      });

    // Totals row
    const dailyTotals = days.map(day => {
      const dateString = format(day, 'yyyy-MM-dd');
      return getHoursForDate(dateString, hoursMode);
    });
    const grandTotal = dailyTotals.reduce((sum, h) => sum + h, 0);
    const grandCost = Object.values(employeeHours).reduce((sum, emp) => sum + emp.cost, 0);
    
    worksheet.addRow([]);
    const totalRow = worksheet.addRow(['TOTAL', '', '', ...dailyTotals, grandTotal, grandCost]);
    totalRow.font = { bold: true };
    totalRow.eachCell(cell => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE5E7EB' },
      };
    });

    // Column widths
    worksheet.getColumn(1).width = 25;
    worksheet.getColumn(2).width = 10;
    worksheet.getColumn(3).width = 12;
    for (let i = 4; i <= 3 + days.length; i++) {
      worksheet.getColumn(i).width = 8;
    }
    worksheet.getColumn(4 + days.length).width = 10;
    worksheet.getColumn(5 + days.length).width = 12;

    // Generate and download
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `monatsübersicht-${format(currentMonthStart, 'yyyy-MM')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Monats-Excel exportiert');
  };

  const selectedDateBreakdown = useMemo(() => {
    if (!selectedDateForDetail) return [];
    return getDetailedBreakdown(selectedDateForDetail, hoursMode);
  }, [selectedDateForDetail, hoursMode, timeEntries, employees, departmentFilter]);

  const selectedDateCombinedBreakdown = useMemo(() => {
    if (!selectedDateForDetail) return [];
    return getCombinedBreakdown(selectedDateForDetail);
  }, [selectedDateForDetail, timeEntries, employees, departmentFilter]);

  // Calculate week/month totals
  const weekPlannedHours = useMemo(() => {
    return weekDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + getHoursForDate(dateString, 'planned');
    }, 0);
  }, [weekDays, timeEntries, departmentFilter]);

  const weekActualHours = useMemo(() => {
    return weekDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + getHoursForDate(dateString, 'actual');
    }, 0);
  }, [weekDays, timeEntries, departmentFilter]);

  const weekPlannedCosts = useMemo(() => {
    return weekDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + getCostsForDate(dateString, 'planned');
    }, 0);
  }, [weekDays, timeEntries, employees, departmentFilter]);

  const weekActualCosts = useMemo(() => {
    return weekDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + getCostsForDate(dateString, 'actual');
    }, 0);
  }, [weekDays, timeEntries, employees, departmentFilter]);

  const monthPlannedHours = useMemo(() => {
    return monthDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + getHoursForDate(dateString, 'planned');
    }, 0);
  }, [monthDays, timeEntries, departmentFilter]);

  const monthActualHours = useMemo(() => {
    return monthDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + getHoursForDate(dateString, 'actual');
    }, 0);
  }, [monthDays, timeEntries, departmentFilter]);

  const monthPlannedCosts = useMemo(() => {
    return monthDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + getCostsForDate(dateString, 'planned');
    }, 0);
  }, [monthDays, timeEntries, employees, departmentFilter]);

  const monthActualCosts = useMemo(() => {
    return monthDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + getCostsForDate(dateString, 'actual');
    }, 0);
  }, [monthDays, timeEntries, employees, departmentFilter]);

  // Render day cell
  const renderDayCell = (day: Date) => {
    const dateString = format(day, 'yyyy-MM-dd');
    const plannedHours = getHoursForDate(dateString, 'planned');
    const actualHours = getHoursForDate(dateString, 'actual');
    const plannedCosts = getCostsForDate(dateString, 'planned');
    const actualCosts = getCostsForDate(dateString, 'actual');
    const isOtherMonth = !isSameMonth(day, currentMonthStart);
    const dayEntries = timeEntries.filter((te) => te.date === dateString);
    const hasData = plannedHours > 0 || actualHours > 0;

    return (
      <div 
        key={dateString}
        className={cn(
          "p-2 rounded-lg border text-center space-y-1",
          isOtherMonth && viewMode === 'month' && "opacity-50",
          hasData && "bg-muted/50",
          hoursMode === 'actual' && actualHours > 0 && "border-primary/30 bg-primary/5",
          hoursMode === 'planned' && plannedHours > 0 && "border-blue-500/30 bg-blue-50 dark:bg-blue-950/20"
        )}
      >
        <div className="text-xs font-medium text-muted-foreground">
          {format(day, 'EEE', { locale: de })}
        </div>
        <div className="font-bold text-base">
          {format(day, 'd. MMM', { locale: de })}
        </div>
        
        {/* Hours display - clickable */}
        <button 
          onClick={() => handleHoursClick(dateString)}
          className="w-full space-y-1 pt-1 hover:bg-muted/50 rounded p-1 transition-colors cursor-pointer"
          title="Klicken für Details"
        >
          <div className={cn(
            "text-sm font-semibold",
            hoursMode === 'planned' ? "text-blue-600" : "text-primary"
          )}>
            {hoursMode === 'planned' ? formatHours(plannedHours) : formatHours(actualHours)} Std
          </div>
          <div className="text-xs text-muted-foreground">
            CHF {hoursMode === 'planned' ? formatCurrency(plannedCosts) : formatCurrency(actualCosts)}
          </div>
        </button>

        {/* Comparison */}
        {hoursMode === 'actual' && plannedHours > 0 && (
          <div className={cn(
            "text-[10px]",
            actualHours <= plannedHours ? "text-green-600" : "text-red-600"
          )}>
            Plan: {formatHours(plannedHours)} Std
          </div>
        )}
        {hoursMode === 'planned' && actualHours > 0 && (
          <div className={cn(
            "text-[10px]",
            actualHours <= plannedHours ? "text-green-600" : "text-red-600"
          )}>
            Ist: {formatHours(actualHours)} Std
          </div>
        )}

        {/* Employee count */}
        <div className="text-[10px] text-muted-foreground">
          {dayEntries.length} MA
        </div>
      </div>
    );
  };

  return (
    <Card className="stat-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Clock className="h-5 w-5" />
            Stunden Editor
          </CardTitle>
          
          <div className="flex items-center gap-2 flex-wrap">
            {/* Hours Mode Toggle (Plan vs Ist) */}
            <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
              <Button
                variant={hoursMode === 'planned' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setHoursMode('planned')}
                className="gap-1 text-xs"
              >
                <Target className="h-3 w-3" />
                Plan
              </Button>
              <Button
                variant={hoursMode === 'actual' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setHoursMode('actual')}
                className="gap-1 text-xs"
              >
                <TrendingUp className="h-3 w-3" />
                Ist
              </Button>
            </div>
            
            {/* View Mode Toggle */}
            <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
              <Button
                variant={viewMode === 'week' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('week')}
                className="gap-1 text-xs"
              >
                <Calendar className="h-3 w-3" />
                Woche
              </Button>
              <Button
                variant={viewMode === 'month' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('month')}
                className="gap-1 text-xs"
              >
                <CalendarDays className="h-3 w-3" />
                Monat
              </Button>
            </div>

            {/* Department Filter */}
            <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
              <Button
                variant={departmentFilter === 'all' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setDepartmentFilter('all')}
                className="gap-1 text-xs"
              >
                <Building2 className="h-3 w-3" />
                Alle
              </Button>
              <Button
                variant={departmentFilter === 'service' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setDepartmentFilter('service')}
                className="gap-1 text-xs"
              >
                <Users className="h-3 w-3" />
                Service
              </Button>
              <Button
                variant={departmentFilter === 'küche' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setDepartmentFilter('küche')}
                className="gap-1 text-xs"
              >
                <UtensilsCrossed className="h-3 w-3" />
                Küche
              </Button>
            </div>

            {/* Ist-Stunden Import (nur im Ist-Modus) */}
            {hoursMode === 'actual' && (
              <div className="flex items-center gap-1 border-l pl-2 ml-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDirectEntryOpen(true)}
                  className="gap-1 text-xs"
                  title="Stunden direkt in Tabelle eingeben"
                >
                  <PenLine className="h-3 w-3" />
                  Direkteingabe
                </Button>
                <HoursCSVImportButton
                  employees={employees}
                  selectedDate={currentMonthStart}
                  onImport={entries => onImportActualHours?.(entries)}
                />
              </div>
            )}

            {/* Export Buttons */}
            <div className="flex items-center gap-1">
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  exportComprehensiveReport(employees, timeEntries, dailyBudgets, currentMonthStart);
                  toast.success('Umfassender Report exportiert');
                }}
                className="gap-1 text-xs bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
                title="Umfassender Kosten-Report mit allen Analysen"
              >
                <FileText className="h-3 w-3" />
                Report
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={exportMonthlyToPDF}
                className="gap-1 text-xs"
                title="Als PDF exportieren"
              >
                <Download className="h-3 w-3" />
                PDF
              </Button>
              {viewMode === 'week' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportWeeklyToExcel}
                  className="gap-1 text-xs"
                  title="Wochenansicht als Excel exportieren"
                >
                  <FileSpreadsheet className="h-3 w-3" />
                  Woche
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={exportMonthlyToExcel}
                className="gap-1 text-xs"
                title="Monatsübersicht als Excel exportieren"
              >
                <FileSpreadsheet className="h-3 w-3" />
                {viewMode === 'week' ? 'Monat' : 'Excel'}
              </Button>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => viewMode === 'week' ? navigateWeek('prev') : navigateMonth('prev')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="font-medium min-w-[180px] text-center">
            {viewMode === 'week' 
              ? `${format(currentWeekStart, 'd. MMM', { locale: de })} - ${format(endOfWeek(currentWeekStart, { weekStartsOn: 1 }), 'd. MMM yyyy', { locale: de })}`
              : format(currentMonthStart, 'MMMM yyyy', { locale: de })
            }
          </span>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => viewMode === 'week' ? navigateWeek('next') : navigateMonth('next')}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Enhanced Summary with Department Breakdown */}
        <div className="space-y-3">
          {/* Main Summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3 bg-muted/50 rounded-lg">
            <div>
              <div className="text-xs text-muted-foreground">
                {viewMode === 'week' ? 'Woche Plan-Std' : 'Monat Plan-Std'}
              </div>
              <div className={cn(
                "text-lg font-bold",
                hoursMode === 'planned' && "text-blue-600"
              )}>
                {formatHours(viewMode === 'week' ? weekPlannedHours : monthPlannedHours)} Std
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">
                {viewMode === 'week' ? 'Woche Ist-Std' : 'Monat Ist-Std'}
              </div>
              <div className={cn(
                "text-lg font-bold",
                hoursMode === 'actual' && "text-primary"
              )}>
                {formatHours(viewMode === 'week' ? weekActualHours : monthActualHours)} Std
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">
                {viewMode === 'week' ? 'Woche Plan-Kosten' : 'Monat Plan-Kosten'}
              </div>
              <div className="text-lg font-bold text-blue-600">
                CHF {formatCurrency(viewMode === 'week' ? weekPlannedCosts : monthPlannedCosts)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">
                {viewMode === 'week' ? 'Woche Ist-Kosten' : 'Monat Ist-Kosten'}
              </div>
              <div className={cn(
                "text-lg font-bold",
                (viewMode === 'week' ? weekActualCosts : monthActualCosts) > (viewMode === 'week' ? weekPlannedCosts : monthPlannedCosts)
                  ? "text-red-600"
                  : "text-green-600"
              )}>
                CHF {formatCurrency(viewMode === 'week' ? weekActualCosts : monthActualCosts)}
              </div>
            </div>
          </div>

          {/* Department Breakdown */}
          {(() => {
            const days = viewMode === 'week' ? weekDays : monthDays;
            const servicePlannedHours = days.reduce((sum, day) => {
              const dateString = format(day, 'yyyy-MM-dd');
              return sum + timeEntries.filter(te => te.date === dateString && employees.find(e => e.id === te.employeeId)?.department === 'service')
                .reduce((s, e) => s + (e.plannedHours || 0), 0);
            }, 0);
            const serviceActualHours = days.reduce((sum, day) => {
              const dateString = format(day, 'yyyy-MM-dd');
              return sum + timeEntries.filter(te => te.date === dateString && employees.find(e => e.id === te.employeeId)?.department === 'service')
                .reduce((s, e) => s + (e.actualHours || 0), 0);
            }, 0);
            const servicePlannedCosts = days.reduce((sum, day) => {
              const dateString = format(day, 'yyyy-MM-dd');
              return sum + timeEntries.filter(te => te.date === dateString).reduce((s, entry) => {
                const emp = employees.find(e => e.id === entry.employeeId);
                if (emp?.department !== 'service') return s;
                return s + (entry.plannedHours || 0) * emp.hourlyWage;
              }, 0);
            }, 0);
            const serviceActualCosts = days.reduce((sum, day) => {
              const dateString = format(day, 'yyyy-MM-dd');
              return sum + timeEntries.filter(te => te.date === dateString).reduce((s, entry) => {
                const emp = employees.find(e => e.id === entry.employeeId);
                if (emp?.department !== 'service') return s;
                return s + (entry.actualHours || 0) * emp.hourlyWage;
              }, 0);
            }, 0);
            
            const küchePlannedHours = days.reduce((sum, day) => {
              const dateString = format(day, 'yyyy-MM-dd');
              return sum + timeEntries.filter(te => te.date === dateString && employees.find(e => e.id === te.employeeId)?.department === 'küche')
                .reduce((s, e) => s + (e.plannedHours || 0), 0);
            }, 0);
            const kücheActualHours = days.reduce((sum, day) => {
              const dateString = format(day, 'yyyy-MM-dd');
              return sum + timeEntries.filter(te => te.date === dateString && employees.find(e => e.id === te.employeeId)?.department === 'küche')
                .reduce((s, e) => s + (e.actualHours || 0), 0);
            }, 0);
            const küchePlannedCosts = days.reduce((sum, day) => {
              const dateString = format(day, 'yyyy-MM-dd');
              return sum + timeEntries.filter(te => te.date === dateString).reduce((s, entry) => {
                const emp = employees.find(e => e.id === entry.employeeId);
                if (emp?.department !== 'küche') return s;
                return s + (entry.plannedHours || 0) * emp.hourlyWage;
              }, 0);
            }, 0);
            const kücheActualCosts = days.reduce((sum, day) => {
              const dateString = format(day, 'yyyy-MM-dd');
              return sum + timeEntries.filter(te => te.date === dateString).reduce((s, entry) => {
                const emp = employees.find(e => e.id === entry.employeeId);
                if (emp?.department !== 'küche') return s;
                return s + (entry.actualHours || 0) * emp.hourlyWage;
              }, 0);
            }, 0);

            const serviceAvgHourly = serviceActualHours > 0 ? serviceActualCosts / serviceActualHours : 0;
            const kücheAvgHourly = kücheActualHours > 0 ? kücheActualCosts / kücheActualHours : 0;
            const totalAvgHourly = (serviceActualHours + kücheActualHours) > 0 
              ? (serviceActualCosts + kücheActualCosts) / (serviceActualHours + kücheActualHours) 
              : 0;

            const totalCosts = serviceActualCosts + kücheActualCosts;
            const servicePct = totalCosts > 0 ? (serviceActualCosts / totalCosts) * 100 : 50;
            const küchePct = totalCosts > 0 ? (kücheActualCosts / totalCosts) * 100 : 50;

            return (
              <div className="border rounded-lg overflow-hidden">
                {/* Department Cost Distribution Bar */}
                <div className="flex h-2">
                  <div className="bg-blue-500" style={{ width: `${servicePct}%` }} title={`Service: ${servicePct.toFixed(0)}%`} />
                  <div className="bg-orange-500" style={{ width: `${küchePct}%` }} title={`Küche: ${küchePct.toFixed(0)}%`} />
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-3 bg-card">
                  {/* Service */}
                  <div className="space-y-2 p-2 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-blue-600" />
                        <span className="font-semibold text-sm text-blue-700 dark:text-blue-400">Service</span>
                      </div>
                      <span className="text-xs px-2 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded">
                        {servicePct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-muted-foreground">Plan:</span>
                        <div className="font-semibold">{formatHours(servicePlannedHours)} Std</div>
                        <div className="text-blue-600">CHF {formatCurrency(servicePlannedCosts)}</div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Ist:</span>
                        <div className="font-semibold">{formatHours(serviceActualHours)} Std</div>
                        <div className={cn(
                          serviceActualCosts > servicePlannedCosts ? "text-red-600" : "text-green-600"
                        )}>CHF {formatCurrency(serviceActualCosts)}</div>
                      </div>
                    </div>
                    <div className="text-xs pt-1 border-t border-blue-200 dark:border-blue-800">
                      <span className="text-muted-foreground">Ø Stundenlohn: </span>
                      <span className="font-semibold">CHF {serviceAvgHourly.toFixed(2)}</span>
                    </div>
                  </div>

                  {/* Küche */}
                  <div className="space-y-2 p-2 rounded-lg bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <UtensilsCrossed className="h-4 w-4 text-orange-600" />
                        <span className="font-semibold text-sm text-orange-700 dark:text-orange-400">Küche</span>
                      </div>
                      <span className="text-xs px-2 py-0.5 bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 rounded">
                        {küchePct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-muted-foreground">Plan:</span>
                        <div className="font-semibold">{formatHours(küchePlannedHours)} Std</div>
                        <div className="text-orange-600">CHF {formatCurrency(küchePlannedCosts)}</div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Ist:</span>
                        <div className="font-semibold">{formatHours(kücheActualHours)} Std</div>
                        <div className={cn(
                          kücheActualCosts > küchePlannedCosts ? "text-red-600" : "text-green-600"
                        )}>CHF {formatCurrency(kücheActualCosts)}</div>
                      </div>
                    </div>
                    <div className="text-xs pt-1 border-t border-orange-200 dark:border-orange-800">
                      <span className="text-muted-foreground">Ø Stundenlohn: </span>
                      <span className="font-semibold">CHF {kücheAvgHourly.toFixed(2)}</span>
                    </div>
                  </div>

                  {/* Total Summary */}
                  <div className="space-y-2 p-2 rounded-lg bg-muted/50 border">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                      <span className="font-semibold text-sm">Gesamt Kennzahlen</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-muted-foreground">Ø Stundenlohn:</span>
                        <div className="font-bold text-lg">CHF {totalAvgHourly.toFixed(2)}</div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Kosten/Tag:</span>
                        <div className="font-bold text-lg">
                          CHF {formatCurrency((serviceActualCosts + kücheActualCosts) / (days.length || 1))}
                        </div>
                      </div>
                    </div>
                    <div className="text-xs pt-1 border-t">
                      <span className="text-muted-foreground">Ø Stunden/Tag: </span>
                      <span className="font-semibold">{formatHours((serviceActualHours + kücheActualHours) / (days.length || 1))}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Labor Cost Quota Summary */}
          {(() => {
            const plannedCosts = viewMode === 'week' ? weekPlannedCosts : monthPlannedCosts;
            const actualCosts = viewMode === 'week' ? weekActualCosts : monthActualCosts;
            const plannedHours = viewMode === 'week' ? weekPlannedHours : monthPlannedHours;
            const actualHours = viewMode === 'week' ? weekActualHours : monthActualHours;
            const costDiff = actualCosts - plannedCosts;
            const hoursDiff = actualHours - plannedHours;
            const costPercent = plannedCosts > 0 ? ((actualCosts / plannedCosts) * 100) : 0;
            const hoursPercent = plannedHours > 0 ? ((actualHours / plannedHours) * 100) : 0;
            const isOverBudget = costPercent > 100;
            const isOverHours = hoursPercent > 100;

            return (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 border rounded-lg bg-card">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Kosten-Quote (Ist vs. Plan)</span>
                    <span className={cn(
                      "text-sm font-bold px-2 py-0.5 rounded",
                      isOverBudget ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400" : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                    )}>
                      {costPercent.toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div 
                      className={cn(
                        "h-full transition-all",
                        isOverBudget ? "bg-red-500" : "bg-green-500"
                      )}
                      style={{ width: `${Math.min(costPercent, 100)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Differenz: {costDiff >= 0 ? '+' : ''}{formatCurrency(costDiff)} CHF</span>
                    <span>{isOverBudget ? 'Über Budget' : 'Im Budget'}</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Stunden-Quote (Ist vs. Plan)</span>
                    <span className={cn(
                      "text-sm font-bold px-2 py-0.5 rounded",
                      isOverHours ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400" : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                    )}>
                      {hoursPercent.toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div 
                      className={cn(
                        "h-full transition-all",
                        isOverHours ? "bg-red-500" : "bg-green-500"
                      )}
                      style={{ width: `${Math.min(hoursPercent, 100)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Differenz: {hoursDiff >= 0 ? '+' : ''}{formatHours(hoursDiff)} Std</span>
                    <span>{isOverHours ? 'Über Plan' : 'Im Plan'}</span>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Month End Forecast */}
          {viewMode === 'month' && (() => {
            const today = new Date();
            const todayStr = format(today, 'yyyy-MM-dd');
            const isCurrentMonth = format(today, 'yyyy-MM') === format(currentMonthStart, 'yyyy-MM');
            
            // Split days into past (with actual data) and future (planned/projected)
            const pastDays: Date[] = [];
            const futureDays: Date[] = [];
            
            monthDays.forEach(day => {
              const dateString = format(day, 'yyyy-MM-dd');
              if (isCurrentMonth) {
                if (dateString <= todayStr) {
                  pastDays.push(day);
                } else {
                  futureDays.push(day);
                }
              } else {
                // For past months, all days are "past"
                pastDays.push(day);
              }
            });

            // Calculate actual costs from past days
            let actualCostsToDate = 0;
            let actualHoursToDate = 0;
            let daysWithData = 0;

            pastDays.forEach(day => {
              const dateString = format(day, 'yyyy-MM-dd');
              const dayActualHours = getHoursForDate(dateString, 'actual');
              const dayActualCosts = getCostsForDate(dateString, 'actual');
              if (dayActualHours > 0) {
                actualCostsToDate += dayActualCosts;
                actualHoursToDate += dayActualHours;
                daysWithData++;
              }
            });

            // Calculate planned costs for future days
            let plannedCostsFuture = 0;
            let plannedHoursFuture = 0;
            
            futureDays.forEach(day => {
              const dateString = format(day, 'yyyy-MM-dd');
              plannedCostsFuture += getCostsForDate(dateString, 'planned');
              plannedHoursFuture += getHoursForDate(dateString, 'planned');
            });

            // Calculate averages for projection
            const avgDailyCost = daysWithData > 0 ? actualCostsToDate / daysWithData : 0;
            const avgDailyHours = daysWithData > 0 ? actualHoursToDate / daysWithData : 0;

            // Project future costs (use planned if available, otherwise use average)
            const projectedFutureCosts = plannedCostsFuture > 0 ? plannedCostsFuture : futureDays.length * avgDailyCost;
            const projectedFutureHours = plannedHoursFuture > 0 ? plannedHoursFuture : futureDays.length * avgDailyHours;

            // Total projected end-of-month
            const projectedTotalCosts = actualCostsToDate + projectedFutureCosts;
            const projectedTotalHours = actualHoursToDate + projectedFutureHours;

            // Compare to full month plan
            const monthlyPlannedCostsTotal = monthPlannedCosts;
            const monthlyPlannedHoursTotal = monthPlannedHours;

            const costVariance = projectedTotalCosts - monthlyPlannedCostsTotal;
            const hoursVariance = projectedTotalHours - monthlyPlannedHoursTotal;
            const costVariancePercent = monthlyPlannedCostsTotal > 0 ? (costVariance / monthlyPlannedCostsTotal) * 100 : 0;

            const progressPercent = monthDays.length > 0 ? (pastDays.length / monthDays.length) * 100 : 0;
            const costProgressPercent = monthlyPlannedCostsTotal > 0 ? (actualCostsToDate / monthlyPlannedCostsTotal) * 100 : 0;

            // Confidence level based on data availability
            const confidenceLevel = daysWithData >= 10 ? 'high' : daysWithData >= 5 ? 'medium' : 'low';
            const confidenceLabels = { high: 'Hoch', medium: 'Mittel', low: 'Niedrig' };
            const confidenceColors = { 
              high: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400',
              medium: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400',
              low: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400'
            };

            if (!isCurrentMonth && daysWithData === 0) return null;

            return (
              <div className="border rounded-lg p-4 bg-gradient-to-r from-blue-50/50 to-purple-50/50 dark:from-blue-950/20 dark:to-purple-950/20 space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-sm flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-blue-600" />
                    Monatsend-Prognose
                  </h4>
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "text-xs px-2 py-0.5 rounded-full",
                      confidenceColors[confidenceLevel]
                    )}>
                      Konfidenz: {confidenceLabels[confidenceLevel]}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {format(currentMonthStart, 'MMMM yyyy', { locale: de })}
                    </span>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Monatsfortschritt</span>
                    <span>{pastDays.length} von {monthDays.length} Tagen ({progressPercent.toFixed(0)}%)</span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </div>

                {/* Forecast Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {/* Actual to Date */}
                  <div className="bg-white/60 dark:bg-black/20 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground">Ist bis heute</div>
                    <div className="text-lg font-bold text-blue-600">
                      CHF {formatCurrency(actualCostsToDate)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatHours(actualHoursToDate)} Std
                    </div>
                  </div>

                  {/* Projected Remaining */}
                  <div className="bg-white/60 dark:bg-black/20 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground">Prognose Rest</div>
                    <div className="text-lg font-bold text-purple-600">
                      CHF {formatCurrency(projectedFutureCosts)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatHours(projectedFutureHours)} Std
                    </div>
                  </div>

                  {/* Projected Total */}
                  <div className="bg-white/60 dark:bg-black/20 rounded-lg p-3 space-y-1 border-2 border-dashed border-blue-300 dark:border-blue-700">
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <Target className="h-3 w-3" />
                      Prognose Gesamt
                    </div>
                    <div className="text-lg font-bold">
                      CHF {formatCurrency(projectedTotalCosts)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatHours(projectedTotalHours)} Std
                    </div>
                  </div>

                  {/* Variance */}
                  <div className={cn(
                    "rounded-lg p-3 space-y-1",
                    costVariance > 0 
                      ? "bg-red-50 dark:bg-red-950/30" 
                      : "bg-green-50 dark:bg-green-950/30"
                  )}>
                    <div className="text-xs text-muted-foreground">vs. Plan</div>
                    <div className={cn(
                      "text-lg font-bold",
                      costVariance > 0 ? "text-red-600" : "text-green-600"
                    )}>
                      {costVariance >= 0 ? '+' : ''}CHF {formatCurrency(costVariance)}
                    </div>
                    <div className={cn(
                      "text-xs font-medium",
                      costVariance > 0 ? "text-red-600" : "text-green-600"
                    )}>
                      {costVariancePercent >= 0 ? '+' : ''}{costVariancePercent.toFixed(1)}%
                    </div>
                  </div>
                </div>

                {/* Detailed Breakdown */}
                <details className="group">
                  <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground flex items-center gap-1">
                    <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                    Prognose-Details anzeigen
                  </summary>
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                    <div className="space-y-2">
                      <div className="font-semibold">Berechnungsgrundlage</div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="p-2 bg-muted/50 rounded">
                          <div className="text-muted-foreground">Tage mit Daten</div>
                          <div className="font-semibold">{daysWithData}</div>
                        </div>
                        <div className="p-2 bg-muted/50 rounded">
                          <div className="text-muted-foreground">Ø Kosten/Tag</div>
                          <div className="font-semibold">CHF {formatCurrency(avgDailyCost)}</div>
                        </div>
                        <div className="p-2 bg-muted/50 rounded">
                          <div className="text-muted-foreground">Ø Stunden/Tag</div>
                          <div className="font-semibold">{avgDailyHours.toFixed(1)}</div>
                        </div>
                        <div className="p-2 bg-muted/50 rounded">
                          <div className="text-muted-foreground">Verbleibende Tage</div>
                          <div className="font-semibold">{futureDays.length}</div>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="font-semibold">Planvergleich</div>
                      <div className="space-y-2">
                        <div className="flex justify-between p-2 bg-muted/50 rounded">
                          <span className="text-muted-foreground">Plan Monatskosten</span>
                          <span className="font-semibold">CHF {formatCurrency(monthlyPlannedCostsTotal)}</span>
                        </div>
                        <div className="flex justify-between p-2 bg-muted/50 rounded">
                          <span className="text-muted-foreground">Plan Stunden</span>
                          <span className="font-semibold">{formatHours(monthlyPlannedHoursTotal)} Std</span>
                        </div>
                        <div className={cn(
                          "flex justify-between p-2 rounded font-semibold",
                          costVariance > 0 ? "bg-red-100 dark:bg-red-950" : "bg-green-100 dark:bg-green-950"
                        )}>
                          <span>Prognose-Abweichung</span>
                          <span className={costVariance > 0 ? "text-red-600" : "text-green-600"}>
                            {costVariance >= 0 ? '+' : ''}{formatCurrency(costVariance)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Warning/Info Messages */}
                  {costVariance > 0 && (
                    <div className="mt-3 p-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-400">
                      ⚠️ Die Prognose zeigt eine Überschreitung des Monatsbudgets um CHF {formatCurrency(costVariance)}. 
                      Prüfen Sie die Planung der verbleibenden {futureDays.length} Tage.
                    </div>
                  )}
                  {costVariance < -500 && (
                    <div className="mt-3 p-2 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded text-xs text-green-700 dark:text-green-400">
                      ✓ Gute Entwicklung! Die Prognose zeigt Einsparungen von CHF {formatCurrency(Math.abs(costVariance))} gegenüber dem Plan.
                    </div>
                  )}
                  {confidenceLevel === 'low' && (
                    <div className="mt-3 p-2 bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded text-xs text-yellow-700 dark:text-yellow-400">
                      ℹ️ Die Prognose basiert auf wenigen Datenpunkten ({daysWithData} Tage). Die Genauigkeit steigt mit mehr erfassten Ist-Daten.
                    </div>
                  )}
                </details>
              </div>
            );
          })()}

          {/* Cost Trend Analysis */}
          {viewMode === 'month' && (() => {
            // Calculate weekly trends to see if costs are improving or worsening
            const weeks: { weekNum: number; startDate: Date; endDate: Date; costs: number; hours: number; avgPerDay: number; daysWithData: number }[] = [];
            
            let weekNum = 1;
            let localWeekStart = startOfMonth(currentMonthStart);
            const monthEnd = endOfMonth(currentMonthStart);
            const today = new Date();
            
            while (localWeekStart <= monthEnd) {
              const weekEnd = endOfWeek(localWeekStart, { weekStartsOn: 1 });
              const actualWeekEnd = weekEnd > monthEnd ? monthEnd : weekEnd;
              const daysInWeek = eachDayOfInterval({ start: localWeekStart, end: actualWeekEnd });
              
              let weekCosts = 0;
              let weekHours = 0;
              let daysWithData = 0;
              
              daysInWeek.forEach(day => {
                // Only count days up to today for actual data
                if (day <= today) {
                  const dateString = format(day, 'yyyy-MM-dd');
                  const dayCosts = getCostsForDate(dateString, hoursMode);
                  const dayHours = getHoursForDate(dateString, hoursMode);
                  
                  if (dayHours > 0) {
                    weekCosts += dayCosts;
                    weekHours += dayHours;
                    daysWithData += 1;
                  }
                }
              });
              
              if (daysWithData > 0) {
                weeks.push({
                  weekNum,
                  startDate: localWeekStart,
                  endDate: actualWeekEnd,
                  costs: weekCosts,
                  hours: weekHours,
                  avgPerDay: weekCosts / daysWithData,
                  daysWithData
                });
              }
              
              weekNum++;
              localWeekStart = addWeeks(localWeekStart, 1);
              if (localWeekStart.getMonth() !== currentMonthStart.getMonth()) break;
            }
            
            if (weeks.length < 2) return null;
            
            // Calculate trend - compare each week to the previous
            const trendData = weeks.map((week, idx) => {
              if (idx === 0) {
                return { ...week, change: 0, changePercent: 0 };
              }
              const prevWeek = weeks[idx - 1];
              const change = week.avgPerDay - prevWeek.avgPerDay;
              const changePercent = prevWeek.avgPerDay > 0 ? (change / prevWeek.avgPerDay) * 100 : 0;
              return { ...week, change, changePercent };
            });
            
            // Overall trend analysis
            const firstWeekAvg = weeks[0].avgPerDay;
            const lastWeekAvg = weeks[weeks.length - 1].avgPerDay;
            const overallChange = lastWeekAvg - firstWeekAvg;
            const overallChangePercent = firstWeekAvg > 0 ? (overallChange / firstWeekAvg) * 100 : 0;
            
            // Determine trend direction
            const isImproving = overallChange < 0;
            const isStable = Math.abs(overallChangePercent) < 5;
            const isWorsening = overallChange > 0;
            
            // Calculate moving averages for smoothed trend
            const avgCostPerDay = weeks.reduce((sum, w) => sum + w.avgPerDay, 0) / weeks.length;
            const totalHoursPerDayAvg = weeks.reduce((sum, w) => sum + (w.hours / w.daysWithData), 0) / weeks.length;
            
            // Calculate cost efficiency trend (CHF per hour)
            const weeklyEfficiency = weeks.map(w => ({
              weekNum: w.weekNum,
              efficiency: w.hours > 0 ? w.costs / w.hours : 0
            }));
            const firstEfficiency = weeklyEfficiency[0]?.efficiency || 0;
            const lastEfficiency = weeklyEfficiency[weeklyEfficiency.length - 1]?.efficiency || 0;
            const efficiencyChange = lastEfficiency - firstEfficiency;
            const efficiencyImproving = efficiencyChange < 0;
            
            // Week over week momentum
            const recentWeeks = trendData.slice(-3);
            const recentChanges = recentWeeks.filter(w => w.change !== 0).map(w => w.change);
            const momentumPositive = recentChanges.length > 0 && recentChanges.filter(c => c < 0).length >= recentChanges.length / 2;
            
            return (
              <div className="border rounded-lg p-4 bg-gradient-to-r from-emerald-50/50 to-teal-50/50 dark:from-emerald-950/20 dark:to-teal-950/20 space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-sm flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-emerald-600" />
                    Kosten-Trend Analyse
                  </h4>
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "text-xs px-2 py-0.5 rounded-full font-medium",
                      isImproving ? "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400" :
                      isWorsening ? "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400" :
                      "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-400"
                    )}>
                      {isImproving ? '↓ Verbesserung' : isWorsening ? '↑ Verschlechterung' : '→ Stabil'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {weeks.length} Wochen analysiert
                    </span>
                  </div>
                </div>

                {/* Trend Indicator */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {/* Overall Trend */}
                  <div className={cn(
                    "rounded-lg p-3 space-y-1",
                    isImproving ? "bg-green-50 dark:bg-green-950/30" :
                    isWorsening ? "bg-red-50 dark:bg-red-950/30" :
                    "bg-yellow-50 dark:bg-yellow-950/30"
                  )}>
                    <div className="text-xs text-muted-foreground">Trend Gesamt</div>
                    <div className={cn(
                      "text-lg font-bold flex items-center gap-1",
                      isImproving ? "text-green-600" :
                      isWorsening ? "text-red-600" :
                      "text-yellow-600"
                    )}>
                      {isImproving ? <ChevronDown className="h-5 w-5" /> : isWorsening ? <ChevronUp className="h-5 w-5" /> : null}
                      {overallChangePercent >= 0 ? '+' : ''}{overallChangePercent.toFixed(1)}%
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {overallChange >= 0 ? '+' : ''}CHF {formatCurrency(overallChange)}/Tag
                    </div>
                  </div>

                  {/* First vs Last Week */}
                  <div className="bg-white/60 dark:bg-black/20 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground">Woche 1 → Woche {weeks.length}</div>
                    <div className="text-sm font-semibold">
                      <span className="text-muted-foreground">CHF {formatCurrency(firstWeekAvg)}</span>
                      <span className="mx-1">→</span>
                      <span className={cn(
                        isImproving ? "text-green-600" : isWorsening ? "text-red-600" : ""
                      )}>
                        CHF {formatCurrency(lastWeekAvg)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">Ø Kosten/Tag</div>
                  </div>

                  {/* Cost Efficiency */}
                  <div className="bg-white/60 dark:bg-black/20 rounded-lg p-3 space-y-1">
                    <div className="text-xs text-muted-foreground">Kosten-Effizienz</div>
                    <div className={cn(
                      "text-lg font-bold",
                      efficiencyImproving ? "text-green-600" : efficiencyChange > 0 ? "text-red-600" : "text-foreground"
                    )}>
                      {efficiencyChange >= 0 ? '+' : ''}{efficiencyChange.toFixed(2)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      CHF/Std Veränderung
                    </div>
                  </div>

                  {/* Momentum */}
                  <div className={cn(
                    "rounded-lg p-3 space-y-1",
                    momentumPositive ? "bg-green-50 dark:bg-green-950/30" : "bg-orange-50 dark:bg-orange-950/30"
                  )}>
                    <div className="text-xs text-muted-foreground">Momentum</div>
                    <div className={cn(
                      "text-lg font-bold",
                      momentumPositive ? "text-green-600" : "text-orange-600"
                    )}>
                      {momentumPositive ? '✓ Positiv' : '⚠ Negativ'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Letzte 3 Wochen
                    </div>
                  </div>
                </div>

                {/* Weekly Progress Chart */}
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">Wöchentlicher Verlauf (Ø Kosten/Tag)</div>
                  <div className="flex items-end gap-2 h-24">
                    {trendData.map((week, idx) => {
                      const maxCost = Math.max(...weeks.map(w => w.avgPerDay));
                      const heightPercent = maxCost > 0 ? (week.avgPerDay / maxCost) * 100 : 0;
                      const isLast = idx === trendData.length - 1;
                      
                      return (
                        <div key={week.weekNum} className="flex-1 flex flex-col items-center gap-1 group relative">
                          <div 
                            className={cn(
                              "w-full rounded-t transition-all relative",
                              isLast ? "bg-gradient-to-t from-emerald-500 to-teal-400" :
                              week.changePercent < -5 ? "bg-green-400" :
                              week.changePercent > 5 ? "bg-red-400" :
                              "bg-blue-400"
                            )}
                            style={{ height: `${heightPercent}%`, minHeight: '8px' }}
                          >
                            {week.changePercent !== 0 && (
                              <div className={cn(
                                "absolute -top-4 left-1/2 -translate-x-1/2 text-[10px] font-semibold whitespace-nowrap",
                                week.changePercent < 0 ? "text-green-600" : "text-red-600"
                              )}>
                                {week.changePercent >= 0 ? '+' : ''}{week.changePercent.toFixed(0)}%
                              </div>
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground font-medium">
                            KW{week.weekNum}
                          </div>
                          
                          {/* Tooltip */}
                          <div className="absolute bottom-full mb-6 left-1/2 -translate-x-1/2 px-2 py-1 bg-popover border rounded shadow-lg text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
                            <div className="font-semibold">Kalenderwoche {week.weekNum}</div>
                            <div>{format(week.startDate, 'd.M.', { locale: de })} - {format(week.endDate, 'd.M.', { locale: de })}</div>
                            <div>Ø Kosten/Tag: CHF {formatCurrency(week.avgPerDay)}</div>
                            <div>{week.daysWithData} Tage mit Daten</div>
                            {week.changePercent !== 0 && (
                              <div className={week.changePercent < 0 ? "text-green-600" : "text-red-600"}>
                                vs. Vorwoche: {week.changePercent >= 0 ? '+' : ''}{week.changePercent.toFixed(1)}%
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Trend Details */}
                <details className="group">
                  <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground flex items-center gap-1">
                    <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                    Wochendetails anzeigen
                  </summary>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-1.5 font-medium">Woche</th>
                          <th className="text-left py-1.5 font-medium">Zeitraum</th>
                          <th className="text-right py-1.5 font-medium">Tage</th>
                          <th className="text-right py-1.5 font-medium">Stunden</th>
                          <th className="text-right py-1.5 font-medium">Kosten</th>
                          <th className="text-right py-1.5 font-medium">Ø/Tag</th>
                          <th className="text-right py-1.5 font-medium">CHF/Std</th>
                          <th className="text-right py-1.5 font-medium">Trend</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trendData.map((week, idx) => (
                          <tr key={week.weekNum} className="border-b border-dashed">
                            <td className="py-1.5 font-medium">KW {week.weekNum}</td>
                            <td className="py-1.5 text-muted-foreground">
                              {format(week.startDate, 'd.M.', { locale: de })} - {format(week.endDate, 'd.M.', { locale: de })}
                            </td>
                            <td className="text-right py-1.5">{week.daysWithData}</td>
                            <td className="text-right py-1.5">{formatHours(week.hours)}</td>
                            <td className="text-right py-1.5 font-semibold">CHF {formatCurrency(week.costs)}</td>
                            <td className="text-right py-1.5">CHF {formatCurrency(week.avgPerDay)}</td>
                            <td className="text-right py-1.5">
                              {week.hours > 0 ? (week.costs / week.hours).toFixed(2) : '-'}
                            </td>
                            <td className={cn(
                              "text-right py-1.5 font-medium",
                              idx === 0 ? "text-muted-foreground" :
                              week.changePercent < -5 ? "text-green-600" :
                              week.changePercent > 5 ? "text-red-600" :
                              "text-muted-foreground"
                            )}>
                              {idx === 0 ? '-' : (week.changePercent >= 0 ? '+' : '') + week.changePercent.toFixed(0) + '%'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-muted/30 font-medium">
                          <td className="py-1.5" colSpan={2}>Durchschnitt</td>
                          <td className="text-right py-1.5">
                            {(weeks.reduce((s, w) => s + w.daysWithData, 0) / weeks.length).toFixed(1)}
                          </td>
                          <td className="text-right py-1.5">
                            {formatHours(weeks.reduce((s, w) => s + w.hours, 0) / weeks.length)}
                          </td>
                          <td className="text-right py-1.5">
                            CHF {formatCurrency(weeks.reduce((s, w) => s + w.costs, 0) / weeks.length)}
                          </td>
                          <td className="text-right py-1.5">
                            CHF {formatCurrency(avgCostPerDay)}
                          </td>
                          <td className="text-right py-1.5">
                            {totalHoursPerDayAvg > 0 ? (avgCostPerDay / (totalHoursPerDayAvg)).toFixed(2) : '-'}
                          </td>
                          <td className="text-right py-1.5"></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  
                  {/* Insights */}
                  <div className="mt-3 space-y-2">
                    {isImproving && (
                      <div className="p-2 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded text-xs text-green-700 dark:text-green-400">
                        ✓ <strong>Positive Entwicklung:</strong> Die durchschnittlichen Tageskosten sind von CHF {formatCurrency(firstWeekAvg)} auf CHF {formatCurrency(lastWeekAvg)} gesunken ({overallChangePercent.toFixed(1)}%). Behalten Sie diesen Trend bei.
                      </div>
                    )}
                    {isWorsening && (
                      <div className="p-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-400">
                        ⚠️ <strong>Achtung:</strong> Die durchschnittlichen Tageskosten sind von CHF {formatCurrency(firstWeekAvg)} auf CHF {formatCurrency(lastWeekAvg)} gestiegen (+{overallChangePercent.toFixed(1)}%). Überprüfen Sie die Personalplanung.
                      </div>
                    )}
                    {efficiencyImproving && !isImproving && (
                      <div className="p-2 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded text-xs text-blue-700 dark:text-blue-400">
                        ℹ️ <strong>Effizienz verbessert:</strong> Der Stundensatz ist gesunken ({efficiencyChange.toFixed(2)} CHF/Std), obwohl die Gesamtkosten gestiegen sind.
                      </div>
                    )}
                    {!momentumPositive && isImproving && (
                      <div className="p-2 bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded text-xs text-yellow-700 dark:text-yellow-400">
                        ⚡ <strong>Momentum dreht:</strong> Obwohl der Gesamttrend positiv ist, zeigen die letzten Wochen eine Verschlechterung. Beobachten Sie die Entwicklung.
                      </div>
                    )}
                  </div>
                </details>
              </div>
            );
          })()}

          {/* Weekday Cost Analysis */}
          {viewMode === 'month' && (() => {
            // Calculate costs per weekday
            const weekdayStats: Record<number, { hours: number; costs: number; days: number }> = {};
            WEEKDAYS.forEach(wd => {
              weekdayStats[wd.key] = { hours: 0, costs: 0, days: 0 };
            });

            monthDays.forEach(day => {
              const dateString = format(day, 'yyyy-MM-dd');
              const dayOfWeek = getDay(day);
              const dayHours = getHoursForDate(dateString, hoursMode);
              const dayCosts = getCostsForDate(dateString, hoursMode);
              
              if (dayHours > 0) {
                weekdayStats[dayOfWeek].hours += dayHours;
                weekdayStats[dayOfWeek].costs += dayCosts;
                weekdayStats[dayOfWeek].days += 1;
              }
            });

            // Calculate averages and find min/max
            const weekdayData = WEEKDAYS.map(wd => {
              const stats = weekdayStats[wd.key];
              const avgHours = stats.days > 0 ? stats.hours / stats.days : 0;
              const avgCosts = stats.days > 0 ? stats.costs / stats.days : 0;
              const avgHourly = stats.hours > 0 ? stats.costs / stats.hours : 0;
              return {
                ...wd,
                avgHours,
                avgCosts,
                avgHourly,
                totalDays: stats.days,
                totalHours: stats.hours,
                totalCosts: stats.costs,
              };
            }).filter(wd => wd.totalDays > 0);

            if (weekdayData.length === 0) return null;

            const maxAvgCost = Math.max(...weekdayData.map(d => d.avgCosts));
            const minAvgCost = Math.min(...weekdayData.map(d => d.avgCosts));
            const avgOverall = weekdayData.reduce((s, d) => s + d.avgCosts, 0) / weekdayData.length;

            const expensiveDay = weekdayData.find(d => d.avgCosts === maxAvgCost);
            const cheapDay = weekdayData.find(d => d.avgCosts === minAvgCost);

            return (
              <div className="border rounded-lg p-3 bg-card space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-sm flex items-center gap-2">
                    <Calendar className="h-4 w-4" />
                    Wochentags-Kostenanalyse
                  </h4>
                  <span className="text-xs text-muted-foreground">
                    {hoursMode === 'planned' ? 'Plan' : 'Ist'} · {format(currentMonthStart, 'MMMM yyyy', { locale: de })}
                  </span>
                </div>

                {/* Visual Bar Chart */}
                <div className="grid grid-cols-7 gap-1">
                  {WEEKDAYS.map(wd => {
                    const data = weekdayData.find(d => d.key === wd.key);
                    if (!data) {
                      return (
                        <div key={wd.key} className="text-center">
                          <div className="text-xs text-muted-foreground mb-1">{wd.short}</div>
                          <div className="h-16 bg-muted/30 rounded flex items-end justify-center">
                            <span className="text-[10px] text-muted-foreground pb-1">-</span>
                          </div>
                        </div>
                      );
                    }

                    const heightPercent = maxAvgCost > 0 ? (data.avgCosts / maxAvgCost) * 100 : 0;
                    const isExpensive = data.avgCosts === maxAvgCost;
                    const isCheap = data.avgCosts === minAvgCost && weekdayData.length > 1;
                    const isAboveAvg = data.avgCosts > avgOverall;

                    return (
                      <div key={wd.key} className="text-center group relative">
                        <div className="text-xs text-muted-foreground mb-1 font-medium">{wd.short}</div>
                        <div className="h-16 bg-muted/30 rounded flex items-end justify-center overflow-hidden">
                          <div 
                            className={cn(
                              "w-full rounded-t transition-all",
                              isExpensive ? "bg-red-500" : isCheap ? "bg-green-500" : isAboveAvg ? "bg-orange-400" : "bg-blue-400"
                            )}
                            style={{ height: `${heightPercent}%` }}
                          />
                        </div>
                        <div className="text-[10px] font-semibold mt-1">
                          {formatCurrency(data.avgCosts)}
                        </div>
                        <div className="text-[9px] text-muted-foreground">
                          {data.avgHours.toFixed(1)} Std
                        </div>
                        
                        {/* Tooltip on hover */}
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-popover border rounded shadow-lg text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
                          <div className="font-semibold">{wd.label}</div>
                          <div>Ø Kosten: CHF {formatCurrency(data.avgCosts)}</div>
                          <div>Ø Stunden: {data.avgHours.toFixed(1)}</div>
                          <div>Ø CHF/Std: {data.avgHourly.toFixed(2)}</div>
                          <div className="text-muted-foreground">{data.totalDays}x im Monat</div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Summary Legend */}
                <div className="flex flex-wrap gap-3 text-xs pt-2 border-t">
                  {expensiveDay && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded bg-red-500" />
                      <span className="text-muted-foreground">Teuerster:</span>
                      <span className="font-semibold">{expensiveDay.label}</span>
                      <span className="text-red-600 font-medium">CHF {formatCurrency(expensiveDay.avgCosts)}</span>
                    </div>
                  )}
                  {cheapDay && weekdayData.length > 1 && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded bg-green-500" />
                      <span className="text-muted-foreground">Günstigster:</span>
                      <span className="font-semibold">{cheapDay.label}</span>
                      <span className="text-green-600 font-medium">CHF {formatCurrency(cheapDay.avgCosts)}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 ml-auto">
                    <span className="text-muted-foreground">Ø/Tag:</span>
                    <span className="font-semibold">CHF {formatCurrency(avgOverall)}</span>
                  </div>
                </div>

                {/* Detailed Weekday Table */}
                <details className="group">
                  <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground flex items-center gap-1">
                    <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                    Details anzeigen
                  </summary>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-1 font-medium">Tag</th>
                          <th className="text-right py-1 font-medium">Anzahl</th>
                          <th className="text-right py-1 font-medium">Ø Stunden</th>
                          <th className="text-right py-1 font-medium">Ø Kosten</th>
                          <th className="text-right py-1 font-medium">Ø CHF/Std</th>
                          <th className="text-right py-1 font-medium">vs. Ø</th>
                        </tr>
                      </thead>
                      <tbody>
                        {weekdayData.map(data => {
                          const diffFromAvg = ((data.avgCosts - avgOverall) / avgOverall) * 100;
                          return (
                            <tr key={data.key} className="border-b border-dashed">
                              <td className="py-1.5 font-medium">{data.label}</td>
                              <td className="text-right py-1.5">{data.totalDays}x</td>
                              <td className="text-right py-1.5">{data.avgHours.toFixed(1)}</td>
                              <td className="text-right py-1.5 font-semibold">CHF {formatCurrency(data.avgCosts)}</td>
                              <td className="text-right py-1.5">{data.avgHourly.toFixed(2)}</td>
                              <td className={cn(
                                "text-right py-1.5 font-medium",
                                diffFromAvg > 5 ? "text-red-600" : diffFromAvg < -5 ? "text-green-600" : "text-muted-foreground"
                              )}>
                                {diffFromAvg >= 0 ? '+' : ''}{diffFromAvg.toFixed(0)}%
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            );
          })()}
        </div>

        {/* Week View */}
        {viewMode === 'week' && (
          <div className="grid grid-cols-7 gap-2">
            {weekDays.map((day) => renderDayCell(day))}
          </div>
        )}

        {/* Month View */}
        {viewMode === 'month' && (
          <div className="space-y-2">
            {/* Weekday headers */}
            <div className="grid grid-cols-7 gap-2">
              {WEEKDAYS.map((weekday) => (
                <div key={weekday.key} className="text-center text-xs font-medium text-muted-foreground py-1">
                  {weekday.short}
                </div>
              ))}
            </div>
            
            {/* Calendar grid */}
            <div className="grid grid-cols-7 gap-2">
              {/* Add empty cells for days before month start */}
              {Array.from({ length: (getDay(monthDays[0]) + 6) % 7 }).map((_, i) => (
                <div key={`empty-${i}`} className="p-2" />
              ))}
              
              {monthDays.map((day) => renderDayCell(day))}
            </div>
          </div>
        )}
      </CardContent>

      {/* Detail Breakdown Dialog */}
      <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Stunden-Aufschlüsselung
            </DialogTitle>
            <DialogDescription>
              {selectedDateForDetail && format(new Date(selectedDateForDetail), 'EEEE, d. MMMM yyyy', { locale: de })}
            </DialogDescription>
          </DialogHeader>
          
          <ScrollArea className="max-h-[450px]">
            {selectedDateCombinedBreakdown.length > 0 ? (
              <div className="space-y-4">
                {/* Summary comparison cards */}
                {(() => {
                  const totalPlanned = selectedDateCombinedBreakdown.reduce((sum, item) => sum + item.plannedHours, 0);
                  const totalActual = selectedDateCombinedBreakdown.reduce((sum, item) => sum + item.actualHours, 0);
                  const totalPlannedCost = selectedDateCombinedBreakdown.reduce((sum, item) => sum + item.plannedCost, 0);
                  const totalActualCost = selectedDateCombinedBreakdown.reduce((sum, item) => sum + item.actualCost, 0);
                  const hoursDiff = totalActual - totalPlanned;
                  const costDiff = totalActualCost - totalPlannedCost;
                  
                  return (
                    <div className="grid grid-cols-2 gap-3">
                      {/* Hours comparison */}
                      <div className="rounded-lg border p-3 bg-muted/30">
                        <div className="text-xs text-muted-foreground mb-2 font-medium">Stunden</div>
                        <div className="flex items-center gap-2 mb-2">
                          <div className="flex-1">
                            <div className="text-[10px] text-blue-600 dark:text-blue-400 uppercase tracking-wide">Plan</div>
                            <div className="text-lg font-bold text-blue-600 dark:text-blue-400">{formatHours(totalPlanned)}</div>
                          </div>
                          <div className="text-muted-foreground">→</div>
                          <div className="flex-1">
                            <div className="text-[10px] text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">Ist</div>
                            <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{formatHours(totalActual)}</div>
                          </div>
                        </div>
                        <div className={cn(
                          "text-xs font-semibold flex items-center gap-1 justify-center py-1 rounded",
                          hoursDiff > 0 ? "text-amber-600 bg-amber-100 dark:bg-amber-900/30" :
                          hoursDiff < 0 ? "text-blue-600 bg-blue-100 dark:bg-blue-900/30" :
                          "text-muted-foreground bg-muted"
                        )}>
                          {hoursDiff > 0 ? <ChevronUp className="h-3 w-3" /> : hoursDiff < 0 ? <ChevronDown className="h-3 w-3" /> : null}
                          {hoursDiff >= 0 ? '+' : ''}{formatHours(hoursDiff)} Std
                        </div>
                      </div>
                      
                      {/* Costs comparison */}
                      <div className="rounded-lg border p-3 bg-muted/30">
                        <div className="text-xs text-muted-foreground mb-2 font-medium">Kosten</div>
                        <div className="flex items-center gap-2 mb-2">
                          <div className="flex-1">
                            <div className="text-[10px] text-blue-600 dark:text-blue-400 uppercase tracking-wide">Plan</div>
                            <div className="text-lg font-bold text-blue-600 dark:text-blue-400">CHF {formatCurrency(totalPlannedCost)}</div>
                          </div>
                          <div className="text-muted-foreground">→</div>
                          <div className="flex-1">
                            <div className="text-[10px] text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">Ist</div>
                            <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">CHF {formatCurrency(totalActualCost)}</div>
                          </div>
                        </div>
                        <div className={cn(
                          "text-xs font-semibold flex items-center gap-1 justify-center py-1 rounded",
                          costDiff > 0 ? "text-destructive bg-red-100 dark:bg-red-900/30" :
                          costDiff < 0 ? "text-success bg-green-100 dark:bg-green-900/30" :
                          "text-muted-foreground bg-muted"
                        )}>
                          {costDiff > 0 ? <ChevronUp className="h-3 w-3" /> : costDiff < 0 ? <ChevronDown className="h-3 w-3" /> : null}
                          {costDiff >= 0 ? '+' : ''}CHF {formatCurrency(Math.abs(costDiff))}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Group by department */}
                {['service', 'küche'].map(dept => {
                  const deptItems = selectedDateCombinedBreakdown.filter(item => item.department === dept);
                  if (deptItems.length === 0) return null;
                  
                  const deptPlannedHours = deptItems.reduce((sum, item) => sum + item.plannedHours, 0);
                  const deptActualHours = deptItems.reduce((sum, item) => sum + item.actualHours, 0);
                  const deptPlannedCost = deptItems.reduce((sum, item) => sum + item.plannedCost, 0);
                  const deptActualCost = deptItems.reduce((sum, item) => sum + item.actualCost, 0);
                  const deptHoursDiff = deptActualHours - deptPlannedHours;
                  const deptCostDiff = deptActualCost - deptPlannedCost;
                  
                  return (
                    <div key={dept} className="space-y-2">
                      <div className="flex items-center gap-2 pb-1 border-b">
                        <span className={cn(
                          "w-2 h-2 rounded-full",
                          dept === 'service' ? "bg-blue-500" : "bg-orange-500"
                        )} />
                        <span className="font-semibold text-sm capitalize">{dept}</span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          Plan: {formatHours(deptPlannedHours)} · Ist: {formatHours(deptActualHours)}
                        </span>
                      </div>
                      
                      {deptItems.map((item, index) => (
                        <div 
                          key={`${item.employeeId}-${index}`}
                          className="p-2 bg-muted/50 rounded-lg"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="font-medium text-sm">{item.employeeName}</div>
                            <div className="text-xs text-muted-foreground">
                              CHF {item.hourlyWage.toFixed(2)}/Std
                            </div>
                          </div>
                          
                          {/* Visual comparison bar */}
                          <div className="space-y-1">
                            <div className="flex items-center gap-2 text-xs">
                              <span className="w-10 text-blue-600 dark:text-blue-400 font-medium">Plan</span>
                              <div className="flex-1 h-4 bg-muted rounded overflow-hidden relative">
                                <div 
                                  className="h-full bg-blue-500/60 transition-all"
                                  style={{ 
                                    width: `${Math.min((item.plannedHours / Math.max(item.plannedHours, item.actualHours, 1)) * 100, 100)}%` 
                                  }}
                                />
                                <span className="absolute inset-0 flex items-center px-2 text-[10px] font-semibold">
                                  {formatHours(item.plannedHours)} Std
                                </span>
                              </div>
                              <span className="w-16 text-right text-muted-foreground">
                                CHF {formatCurrency(item.plannedCost)}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                              <span className="w-10 text-emerald-600 dark:text-emerald-400 font-medium">Ist</span>
                              <div className="flex-1 h-4 bg-muted rounded overflow-hidden relative">
                                <div 
                                  className={cn(
                                    "h-full transition-all",
                                    item.hoursDiff > 0 ? "bg-amber-500/60" : "bg-emerald-500/60"
                                  )}
                                  style={{ 
                                    width: `${Math.min((item.actualHours / Math.max(item.plannedHours, item.actualHours, 1)) * 100, 100)}%` 
                                  }}
                                />
                                <span className="absolute inset-0 flex items-center px-2 text-[10px] font-semibold">
                                  {formatHours(item.actualHours)} Std
                                </span>
                              </div>
                              <span className="w-16 text-right text-muted-foreground">
                                CHF {formatCurrency(item.actualCost)}
                              </span>
                            </div>
                            
                            {/* Difference indicator */}
                            {item.hoursDiff !== 0 && (
                              <div className={cn(
                                "text-[10px] font-medium text-right",
                                item.hoursDiff > 0 ? "text-amber-600" : "text-emerald-600"
                              )}>
                                Differenz: {item.hoursDiff >= 0 ? '+' : ''}{formatHours(item.hoursDiff)} Std · 
                                {item.costDiff >= 0 ? '+' : ''}CHF {formatCurrency(item.costDiff)}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                      
                      {/* Department Total */}
                      <div className={cn(
                        "mt-2 p-2 rounded-lg border-2",
                        dept === 'service' ? "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800" : "bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-800"
                      )}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "text-sm font-bold",
                              dept === 'service' ? "text-blue-700 dark:text-blue-300" : "text-orange-700 dark:text-orange-300"
                            )}>
                              Total {dept === 'service' ? 'Service' : 'Küche'}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              ({deptItems.length} MA)
                            </span>
                          </div>
                          <div className="text-right">
                            <div className="flex items-center gap-3 text-xs">
                              <div>
                                <span className="text-blue-600 dark:text-blue-400">Plan: </span>
                                <span className="font-semibold">{formatHours(deptPlannedHours)} Std</span>
                                <span className="text-muted-foreground ml-1">· CHF {formatCurrency(deptPlannedCost)}</span>
                              </div>
                              <div>
                                <span className="text-emerald-600 dark:text-emerald-400">Ist: </span>
                                <span className="font-semibold">{formatHours(deptActualHours)} Std</span>
                                <span className="text-muted-foreground ml-1">· CHF {formatCurrency(deptActualCost)}</span>
                              </div>
                            </div>
                            <div className={cn(
                              "text-xs font-bold mt-1",
                              deptCostDiff > 0 ? "text-destructive" : deptCostDiff < 0 ? "text-success" : "text-muted-foreground"
                            )}>
                              Differenz: {deptHoursDiff >= 0 ? '+' : ''}{formatHours(deptHoursDiff)} Std · 
                              {deptCostDiff >= 0 ? '+' : ''}CHF {formatCurrency(deptCostDiff)}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                Keine Stunden für diesen Tag erfasst.
              </div>
            )}
          </ScrollArea>
          
          {selectedDateCombinedBreakdown.length > 0 && (
            <DialogFooter className="flex-row gap-2 sm:justify-start">
              <Button variant="outline" size="sm" onClick={exportToPDF} className="gap-2">
                <Download className="h-4 w-4" />
                PDF
              </Button>
              <Button variant="outline" size="sm" onClick={exportToExcel} className="gap-2">
                <FileSpreadsheet className="h-4 w-4" />
                Excel
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* Ist-Stunden Direkteingabe */}
      <HoursDirectEntryDialog
        open={directEntryOpen}
        onClose={() => setDirectEntryOpen(false)}
        employees={employees}
        selectedDate={currentMonthStart}
      />
    </Card>
  );
};
