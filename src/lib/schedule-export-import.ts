import * as XLSX from 'xlsx';
import * as ExcelJS from 'exceljs';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Employee } from '@/types/personnel';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { getShiftConfig, getShiftConfigMap } from '@/hooks/useShiftConfig';
import { DaySchedule, TimeSlot } from '@/components/schedule-planner/ScheduleGrid';

interface ExportOptionsV2 {
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  currentMonth: Date;
  department?: 'service' | 'küche' | 'all';
  dailyBudgets?: Record<string, { plannedRevenue?: number; actualRevenue?: number }>;
  showCosts?: boolean;
}

export interface NameMatchInfo {
  importedName: string;
  matchedEmployee: Employee | null;
  matchType: 'exact' | 'firstName' | 'new';
  isNew: boolean;
}

interface ImportResultV2 {
  scheduleData: Record<string, DaySchedule>;
  newEmployees: Employee[];
  errors: string[];
  nameMatches: NameMatchInfo[];
}

const WEEKDAY_NAMES_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function getDaysInMonth(year: number, month: number): Date[] {
  const days: Date[] = [];
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  
  for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d));
  }
  return days;
}

function formatDateHeader(date: Date): string {
  const weekday = WEEKDAY_NAMES_SHORT[date.getDay()];
  const day = date.getDate();
  return `${weekday} ${day}.`;
}

function formatTimeSlot(slot: TimeSlot | null | undefined): string {
  if (!slot?.start || !slot?.end) return '';
  return `${slot.start.replace(':00', '')}-${slot.end.replace(':00', '')}`;
}

function calculateSlotHours(slot: TimeSlot | null | undefined): number {
  if (!slot?.start || !slot?.end) return 0;
  const [startH, startM] = slot.start.split(':').map(Number);
  const [endH, endM] = slot.end.split(':').map(Number);
  let hours = endH - startH + (endM - startM) / 60;
  if (hours < 0) hours += 24;
  return Math.round(hours * 100) / 100;
}

export async function exportScheduleToExcelV2(options: ExportOptionsV2): Promise<void> {
  const { employees, scheduleData, currentMonth, department = 'all', dailyBudgets = {}, showCosts = false } = options;
  
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const days = getDaysInMonth(year, month);
  const monthName = format(currentMonth, 'MMMM yyyy', { locale: de });
  
  const shifts = getShiftConfig();
  const shiftMap = getShiftConfigMap();
  const absenceShifts = shifts.filter(s => !s.start || !s.end);
  
  // Load labor cost threshold
  const LABOR_COST_THRESHOLD_KEY = 'labor_cost_threshold';
  const laborCostThreshold = parseFloat(localStorage.getItem(LABOR_COST_THRESHOLD_KEY) || '40');
  
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Dienstplan-App';
  workbook.created = new Date();
  
  // Sort employees by ID to maintain consistent order from Excel file
  const sortByEmployeeId = (a: Employee, b: Employee) => parseInt(a.id) - parseInt(b.id);
  const serviceEmployees = employees.filter(e => e.department === 'service').sort(sortByEmployeeId);
  const kücheEmployees = employees.filter(e => e.department === 'küche').sort(sortByEmployeeId);
  
// Calculate daily stats
  const getDailyStats = (day: Date, deptEmployees: Employee[]) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    let totalHours = 0;
    let totalCosts = 0;
    let employeeCount = 0;

    deptEmployees.forEach(emp => {
      const cellKey = `${emp.id}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];
      
      if (daySchedule) {
        const frühHours = calculateSlotHours(daySchedule.früh);
        const spätHours = calculateSlotHours(daySchedule.spät);
        let dayHours = frühHours + spätHours;
        
        // Add absence hours if countsToTarget
        if (daySchedule.frühAbsence) {
          const absenceShift = absenceShifts.find(s => s.abbrev === daySchedule.frühAbsence);
          if (absenceShift && shiftMap[absenceShift.name]?.countsToTarget) {
            dayHours += absenceShift.hours;
          }
        }
        if (daySchedule.spätAbsence) {
          const absenceShift = absenceShifts.find(s => s.abbrev === daySchedule.spätAbsence);
          if (absenceShift && shiftMap[absenceShift.name]?.countsToTarget) {
            // Only add if different from früh absence (avoid double counting)
            if (daySchedule.spätAbsence !== daySchedule.frühAbsence) {
              dayHours += absenceShift.hours;
            }
          }
        }
        
        if (dayHours > 0 || daySchedule.frühAbsence || daySchedule.spätAbsence) {
          employeeCount++;
        }
        totalHours += dayHours;
        
        if (emp.hourlyWage) {
          totalCosts += dayHours * emp.hourlyWage;
        }
      }
    });

    const budget = dailyBudgets[dateStr];
    const plannedRevenue = budget?.plannedRevenue || 0;
    const laborCostPercentage = plannedRevenue > 0 ? (totalCosts / plannedRevenue) * 100 : 0;
    const isOverBudget = plannedRevenue > 0 && laborCostPercentage > laborCostThreshold;
    
    return { totalHours, totalCosts, employeeCount, plannedRevenue, laborCostPercentage, isOverBudget };
  };
  
  const createSheet = (deptEmployees: Employee[], deptName: string) => {
    const sheet = workbook.addWorksheet(deptName);
    
    // Column widths - 2 columns per day (Früh + Spät)
    sheet.getColumn(1).width = 20; // NAME
    
    for (let i = 0; i < days.length * 2; i++) {
      sheet.getColumn(2 + i).width = 10;
    }
    const summaryStartCol = 2 + days.length * 2;
    sheet.getColumn(summaryStartCol).width = 10; // PLAN
    sheet.getColumn(summaryStartCol + 1).width = 10; // SOLL
    sheet.getColumn(summaryStartCol + 2).width = 8; // DIFF
    if (showCosts) {
      sheet.getColumn(summaryStartCol + 3).width = 10; // KOSTEN
    }
    
    // Row 1: Title
    const titleRow = sheet.addRow([`Dienstplan ${deptName} - ${monthName}`]);
    titleRow.font = { bold: true, size: 16 };
    titleRow.height = 24;
    const titleColCount = showCosts ? days.length * 2 + 5 : days.length * 2 + 4;
    sheet.mergeCells(1, 1, 1, titleColCount);
    
    // Row 2: Instructions
    const instructionRow = sheet.addRow(['Hinweis: Zeiten im Format "10-14" oder "10:00-14:00" eintragen. Für Abwesenheiten die Kürzel aus der Legende verwenden.']);
    instructionRow.font = { italic: true, size: 9, color: { argb: 'FF666666' } };
    sheet.mergeCells(2, 1, 2, Math.min(10, days.length * 2 + 1));
    
    // Row 3: Legend
    const legendTitleCell = sheet.getCell(3, 1);
    legendTitleCell.value = 'Legende:';
    legendTitleCell.font = { bold: true, size: 10 };
    
    let colOffset = 2;
    absenceShifts.forEach((shiftConfig) => {
      const cell = sheet.getCell(3, colOffset);
      cell.value = `${shiftConfig.abbrev} = ${shiftConfig.name}`;
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: shiftConfig.excelColor }
      };
      cell.font = { size: 8, color: { argb: shiftConfig.textColor }, bold: true };
      cell.alignment = { horizontal: 'center' };
      colOffset++;
    });
    
    // Row 4: Format examples
    const exampleRow = sheet.addRow(['Beispiele:', '10-14', '9:30-17:30', 'U', 'K', 'F']);
    exampleRow.font = { size: 9, color: { argb: 'FF888888' } };
    exampleRow.getCell(1).font = { bold: true, size: 9, color: { argb: 'FF666666' } };
    
    // Row 5: Empty
    sheet.addRow([]);
    
    // Build dropdown list for data validation (shift abbreviations)
    const shiftAbbreviations = absenceShifts.map(s => s.abbrev).filter(Boolean);
    const dropdownList = shiftAbbreviations.join(',');
    
    // Row 6: Date headers (two columns per day - Früh and Spät)
    const dateHeaderData: string[] = ['Mitarbeiter'];
    days.forEach(d => {
      dateHeaderData.push(`${formatDateHeader(d)} F`); // Früh
      dateHeaderData.push(`${formatDateHeader(d)} S`); // Spät
    });
    dateHeaderData.push('Plan', 'Soll', '+/-');
    if (showCosts) {
      dateHeaderData.push('CHF');
    }
    const dateRow = sheet.addRow(dateHeaderData);
    dateRow.height = 20;
    
    dateRow.eachCell((cell, colNumber) => {
      cell.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E40AF' }
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF1E3A8A' } },
        bottom: { style: 'thin', color: { argb: 'FF1E3A8A' } },
        left: { style: 'thin', color: { argb: 'FF1E3A8A' } },
        right: { style: 'thin', color: { argb: 'FF1E3A8A' } }
      };
      
      // Weekend coloring (2 columns per day now)
      if (colNumber > 1 && colNumber <= days.length * 2 + 1) {
        const dayIdx = Math.floor((colNumber - 2) / 2);
        const day = days[dayIdx];
        if (day && (day.getDay() === 0 || day.getDay() === 6)) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFD97706' }
          };
        }
      }
    });
    
    // Employee data rows
    deptEmployees.forEach((emp, empIdx) => {
      const rowData: (string | number)[] = [emp.name];
      let plannedHours = 0;
      let empCost = 0;
      
      days.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const cellKey = `${emp.id}-${dateStr}`;
        const daySchedule = scheduleData[cellKey] || {};
        
        // Früh cell
        let frühContent = '';
        if (daySchedule.frühAbsence) {
          frühContent = daySchedule.frühAbsence;
        } else if (daySchedule.früh) {
          frühContent = formatTimeSlot(daySchedule.früh);
        }
        rowData.push(frühContent);
        
        // Spät cell
        let spätContent = '';
        if (daySchedule.spätAbsence) {
          spätContent = daySchedule.spätAbsence;
        } else if (daySchedule.spät) {
          spätContent = formatTimeSlot(daySchedule.spät);
        }
        rowData.push(spätContent);
        
        // Calculate hours
        const frühHours = calculateSlotHours(daySchedule.früh);
        const spätHours = calculateSlotHours(daySchedule.spät);
        plannedHours += frühHours + spätHours;
        
        // Add absence hours if counts to target
        if (daySchedule.frühAbsence) {
          const shift = absenceShifts.find(s => shiftMap[s.name]?.abbrev === daySchedule.frühAbsence);
          if (shift && shiftMap[shift.name]?.countsToTarget) {
            plannedHours += shiftMap[shift.name].hours;
          }
        }
        if (daySchedule.spätAbsence) {
          const shift = absenceShifts.find(s => shiftMap[s.name]?.abbrev === daySchedule.spätAbsence);
          if (shift && shiftMap[shift.name]?.countsToTarget) {
            plannedHours += shiftMap[shift.name].hours;
          }
        }
        
        // Cost calculation
        if (emp.hourlyWage) {
          empCost += (frühHours + spätHours) * emp.hourlyWage;
        }
      });
      
      // Hours and difference columns
      const targetHours = emp.weeklyHours ? emp.weeklyHours * 4.33 : 42 * 4.33;
      const diff = plannedHours - targetHours;
      
      rowData.push(plannedHours.toFixed(1));
      rowData.push(targetHours.toFixed(0));
      rowData.push(diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1));
      if (showCosts) {
        rowData.push(empCost.toFixed(0));
      }
      
      const row = sheet.addRow(rowData);
      row.height = 28;
      
      // Style cells
      row.eachCell((cell, colNumber) => {
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.font = { size: 8 };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          right: { style: 'thin', color: { argb: 'FFE5E7EB' } }
        };
        
        // Alternating row colors
        if (empIdx % 2 === 1) {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF9FAFB' }
          };
        }
      });
      
      // Name cell
      const nameCell = row.getCell(1);
      nameCell.font = { size: 9, bold: true };
      nameCell.alignment = { horizontal: 'left', vertical: 'middle' };
      
      // Style day cells (2 columns per day now: Früh and Spät)
      days.forEach((day, dayIdx) => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const cellKey = `${emp.id}-${dateStr}`;
        const daySchedule = scheduleData[cellKey] || {};
        const frühCell = row.getCell(2 + dayIdx * 2);     // Früh column
        const spätCell = row.getCell(2 + dayIdx * 2 + 1); // Spät column
        
        // Style Früh cell
        if (daySchedule.frühAbsence) {
          const shift = absenceShifts.find(s => shiftMap[s.name]?.abbrev === daySchedule.frühAbsence);
          if (shift) {
            frühCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: shift.excelColor } };
            frühCell.font = { color: { argb: shift.textColor }, bold: true, size: 8 };
          }
        } else if (daySchedule.früh) {
          frühCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
          frühCell.font = { color: { argb: 'FF1E40AF' }, size: 8 };
        } else if (day.getDay() === 0 || day.getDay() === 6) {
          frühCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
        }
        
        // Style Spät cell
        if (daySchedule.spätAbsence) {
          const shift = absenceShifts.find(s => shiftMap[s.name]?.abbrev === daySchedule.spätAbsence);
          if (shift) {
            spätCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: shift.excelColor } };
            spätCell.font = { color: { argb: shift.textColor }, bold: true, size: 8 };
          }
        } else if (daySchedule.spät) {
          spätCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
          spätCell.font = { color: { argb: 'FF1E40AF' }, size: 8 };
        } else if (day.getDay() === 0 || day.getDay() === 6) {
          spätCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
        }
        
        // Add data validation dropdown for both cells
        if (dropdownList) {
          if (!daySchedule.früh && !daySchedule.frühAbsence) {
            frühCell.dataValidation = {
              type: 'list',
              allowBlank: true,
              formulae: [`"${dropdownList}"`],
              showInputMessage: true,
              prompt: 'Früh: Kürzel oder Zeiten (z.B. 10-14)',
              promptTitle: 'Eingabehilfe'
            };
          }
          if (!daySchedule.spät && !daySchedule.spätAbsence) {
            spätCell.dataValidation = {
              type: 'list',
              allowBlank: true,
              formulae: [`"${dropdownList}"`],
              showInputMessage: true,
              prompt: 'Spät: Kürzel oder Zeiten (z.B. 17-22)',
              promptTitle: 'Eingabehilfe'
            };
          }
        }
      });
      
      // Hours difference styling (2 columns per day now)
      const diffCell = row.getCell(2 + days.length * 2 + 2);
      if (diff >= -5 && diff <= 5) {
        diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
        diffCell.font = { color: { argb: 'FF15803D' }, bold: true, size: 8 };
      } else if (diff < -5) {
        diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
        diffCell.font = { color: { argb: 'FF92400E' }, bold: true, size: 8 };
      } else {
        diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
        diffCell.font = { color: { argb: 'FF991B1B' }, bold: true, size: 8 };
      }
    });
    
    // Footer row with daily totals (spanning 2 columns per day)
    const footerData: (string | number)[] = ['SUMME'];
    let totalMonthHours = 0;
    let totalMonthCosts = 0;
    let totalMonthRevenue = 0;
    
    days.forEach(day => {
      const stats = getDailyStats(day, deptEmployees);
      footerData.push(`${stats.totalHours.toFixed(1)}h`);
      footerData.push(''); // Empty second column for this day
      totalMonthHours += stats.totalHours;
      totalMonthCosts += stats.totalCosts;
      totalMonthRevenue += stats.plannedRevenue;
    });
    
    footerData.push(totalMonthHours.toFixed(1), '', '');
    if (showCosts) {
      footerData.push(totalMonthCosts.toFixed(0));
    }
    
    const footerRow = sheet.addRow(footerData);
    footerRow.height = 22;
    
    // Merge cells for each day's total (2 columns per day)
    days.forEach((_, dayIdx) => {
      const startCol = 2 + dayIdx * 2;
      const endCol = startCol + 1;
      sheet.mergeCells(footerRow.number, startCol, footerRow.number, endCol);
    });
    
    footerRow.eachCell((cell) => {
      cell.font = { bold: true, size: 9 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE5E7EB' }
      };
      cell.border = {
        top: { style: 'medium', color: { argb: 'FF9CA3AF' } },
        bottom: { style: 'thin', color: { argb: 'FF9CA3AF' } }
      };
    });
    
    // Cost footer row (if costs enabled)
    if (showCosts) {
      const costFooterData: (string | number)[] = ['KOSTEN'];
      
      days.forEach(day => {
        const stats = getDailyStats(day, deptEmployees);
        costFooterData.push(`CHF ${stats.totalCosts.toFixed(0)}`);
        costFooterData.push(''); // Empty second column
      });
      costFooterData.push('', '', '', totalMonthCosts.toFixed(0));
      
      const costRow = sheet.addRow(costFooterData);
      costRow.height = 20;
      
      // Merge cells for each day
      days.forEach((_, dayIdx) => {
        const startCol = 2 + dayIdx * 2;
        const endCol = startCol + 1;
        sheet.mergeCells(costRow.number, startCol, costRow.number, endCol);
      });
      
      costRow.eachCell((cell, colNumber) => {
        const dayIdx = Math.floor((colNumber - 2) / 2);
        const day = days[dayIdx];
        const stats = day ? getDailyStats(day, deptEmployees) : null;
        
        cell.font = { bold: true, size: 8 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        
        if (stats && stats.isOverBudget) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
          cell.font = { bold: true, size: 8, color: { argb: 'FF991B1B' } };
        } else {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
          cell.font = { bold: true, size: 8, color: { argb: 'FF15803D' } };
        }
      });
      
      // PKQ row
      const pkqData: (string | number)[] = ['PKQ'];
      
      days.forEach(day => {
        const stats = getDailyStats(day, deptEmployees);
        pkqData.push(stats.plannedRevenue > 0 ? `${stats.laborCostPercentage.toFixed(1)}%` : '-');
        pkqData.push(''); // Empty second column
      });
      
      const monthPKQ = totalMonthRevenue > 0 ? (totalMonthCosts / totalMonthRevenue * 100) : 0;
      pkqData.push('', '', '', monthPKQ > 0 ? `${monthPKQ.toFixed(1)}%` : '-');
      
      const pkqRow = sheet.addRow(pkqData);
      pkqRow.height = 20;
      
      // Merge cells for each day
      days.forEach((_, dayIdx) => {
        const startCol = 2 + dayIdx * 2;
        const endCol = startCol + 1;
        sheet.mergeCells(pkqRow.number, startCol, pkqRow.number, endCol);
      });
      
      pkqRow.eachCell((cell, colNumber) => {
        const dayIdx = Math.floor((colNumber - 2) / 2);
        const day = days[dayIdx];
        const stats = day ? getDailyStats(day, deptEmployees) : null;
        
        cell.font = { bold: true, size: 8 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        
        if (stats && stats.isOverBudget) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
          cell.font = { bold: true, size: 8, color: { argb: 'FF991B1B' } };
        } else if (stats && stats.plannedRevenue > 0) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
          cell.font = { bold: true, size: 8, color: { argb: 'FF15803D' } };
        } else {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
        }
      });
    }
    
    // Print settings
    sheet.pageSetup = {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9, // A4
      margins: {
        left: 0.25,
        right: 0.25,
        top: 0.5,
        bottom: 0.5,
        header: 0.3,
        footer: 0.3
      }
    };
    
    // Freeze first column and header row
    sheet.views = [{
      state: 'frozen',
      xSplit: 1,
      ySplit: 5
    }];
  };
  
  if (department === 'all' || department === 'service') {
    createSheet(serviceEmployees, 'Service');
  }
  
  if (department === 'all' || department === 'küche') {
    createSheet(kücheEmployees, 'Küche');
  }
  
// Download the file
  const fileName = `Dienstplan_${format(currentMonth, 'MMMM_yyyy', { locale: de })}.xlsx`;
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Template Export Function matching reference format - 4 columns per day (Früh Start, Früh Ende, Spät Start, Spät Ende)
export type ExportHoursType = 'plan' | 'ist' | 'both';

export interface ActualHoursEntry {
  hours: number;
  start?: string;
  end?: string;
}

interface TemplateExportOptions {
  employees: Employee[];
  currentMonth: Date;
  department?: 'service' | 'küche' | 'all';
  dailyBudgets?: Record<string, { plannedRevenue?: number; actualRevenue?: number }>;
  scheduleData?: Record<string, DaySchedule>;
  /** Optional: specific days to export (for week export). If not provided, exports entire month */
  specificDays?: Date[];
  /** Which hours to include in export */
  hoursType?: ExportHoursType;
  /** Whether to include costs */
  includeCosts?: boolean;
  /** Actual hours data for Ist export */
  actualHoursData?: Record<string, ActualHoursEntry>;
}

const WEEKDAY_NAMES_FULL = ['SONNTAG', 'MONTAG', 'DIENSTAG', 'MITTWOCH', 'DONNERSTAG', 'FREITAG', 'SAMSTAG'];

export async function exportScheduleTemplate(options: TemplateExportOptions): Promise<void> {
  const { 
    employees, 
    currentMonth, 
    department = 'all', 
    dailyBudgets = {}, 
    scheduleData = {}, 
    specificDays,
    hoursType = 'plan',
    includeCosts = true,
    actualHoursData = {}
  } = options;
  
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  // Use specific days if provided, otherwise get all days in month
  const days = specificDays || getDaysInMonth(year, month);
  const isWeekExport = !!specificDays;
  const monthName = isWeekExport 
    ? `KW ${format(days[0], 'w', { locale: de })} - ${format(currentMonth, 'MMMM yyyy', { locale: de })}`
    : format(currentMonth, 'MMMM yyyy', { locale: de });
  
  const shifts = getShiftConfig();
  const shiftMap = getShiftConfigMap();
  const absenceShifts = shifts.filter(s => !s.start || !s.end);
  
  // Load labor cost threshold
  const LABOR_COST_THRESHOLD_KEY = 'labor_cost_threshold';
  const laborCostThreshold = parseFloat(localStorage.getItem(LABOR_COST_THRESHOLD_KEY) || '40');
  
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Dienstplan-App';
  workbook.created = new Date();
  
  // Sort employees by ID to maintain consistent order from Excel file
  const sortByEmployeeId = (a: Employee, b: Employee) => parseInt(a.id) - parseInt(b.id);
  const serviceEmployees = employees.filter(e => e.department === 'service').sort(sortByEmployeeId);
  const kücheEmployees = employees.filter(e => e.department === 'küche').sort(sortByEmployeeId);
  
  // Build dropdown list for data validation (shift abbreviations)
  const shiftAbbreviations = absenceShifts.map(s => s.abbrev).filter(Boolean);
  const dropdownList = shiftAbbreviations.join(',');
  
  // Calculate daily stats for Labor row
  const getDailyStats = (day: Date, deptEmployees: Employee[]) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    let totalHours = 0;
    let totalCosts = 0;

    deptEmployees.forEach(emp => {
      const cellKey = `${emp.id}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];
      
      if (daySchedule) {
        const frühHours = calculateSlotHours(daySchedule.früh);
        const spätHours = calculateSlotHours(daySchedule.spät);
        let dayHours = frühHours + spätHours;
        
        // Add absence hours if countsToTarget
        if (daySchedule.frühAbsence) {
          const absenceShift = absenceShifts.find(s => s.abbrev === daySchedule.frühAbsence);
          if (absenceShift && shiftMap[absenceShift.name]?.countsToTarget) {
            dayHours += absenceShift.hours;
          }
        }
        if (daySchedule.spätAbsence) {
          const absenceShift = absenceShifts.find(s => s.abbrev === daySchedule.spätAbsence);
          if (absenceShift && shiftMap[absenceShift.name]?.countsToTarget) {
            if (daySchedule.spätAbsence !== daySchedule.frühAbsence) {
              dayHours += absenceShift.hours;
            }
          }
        }
        
        totalHours += dayHours;
        if (emp.hourlyWage) {
          totalCosts += dayHours * emp.hourlyWage;
        }
      }
    });

    const budget = dailyBudgets[dateStr];
    const plannedRevenue = budget?.plannedRevenue || 0;
    const laborCostPercentage = plannedRevenue > 0 ? (totalCosts / plannedRevenue) * 100 : 0;
    
    return { totalHours, totalCosts, plannedRevenue, laborCostPercentage };
  };
  
  const createTemplateSheet = (deptEmployees: Employee[], deptName: string) => {
    const sheet = workbook.addWorksheet(deptName);
    
    // Column A: NAME column
    // Then 4 columns per day (Früh Start, Früh Ende, Spät Start, Spät Ende)
    const COLS_PER_DAY = 4;
    sheet.getColumn(1).width = 12; // NAME
    
    for (let i = 0; i < days.length * COLS_PER_DAY; i++) {
      sheet.getColumn(2 + i).width = 6;
    }
    
    const summaryStartCol = 2 + days.length * COLS_PER_DAY;
    sheet.getColumn(summaryStartCol).width = 7;     // Plan
    sheet.getColumn(summaryStartCol + 1).width = 7; // Soll
    sheet.getColumn(summaryStartCol + 2).width = 6; // +/-
    sheet.getColumn(summaryStartCol + 3).width = 8; // CHF
    
    const totalCols = summaryStartCol + 3;
    
    // Row 1: Title
    const titleRow = sheet.addRow([`Dienstplan ${deptName}`]);
    titleRow.font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } };
    titleRow.height = 30;
    titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    sheet.mergeCells(1, 1, 1, totalCols);
    titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Row 2: Empty row
    sheet.addRow([]);
    
    // Row 3: Weekday names (MONTAG, DIENSTAG, etc.) - merged across 4 columns each
    const weekdayRowData: string[] = [''];
    days.forEach(d => {
      weekdayRowData.push(WEEKDAY_NAMES_FULL[d.getDay()]);
      weekdayRowData.push('', '', '');
    });
    const weekdayRow = sheet.addRow(weekdayRowData);
    weekdayRow.height = 20;
    
    // Merge and style weekday cells (4 columns per day)
    days.forEach((day, idx) => {
      const startCol = 2 + idx * COLS_PER_DAY;
      sheet.mergeCells(3, startCol, 3, startCol + 3);
      const cell = weekdayRow.getCell(startCol);
      cell.font = { bold: true, size: 10, color: { argb: 'FF000000' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: (day.getDay() === 0 || day.getDay() === 6) ? 'FFF59E0B' : 'FFE5E7EB' }
      };
      cell.border = {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
    
    // Row 4: Date (DD.MM.YYYY) - merged across 4 columns each
    const dateRowData: string[] = [''];
    days.forEach(d => {
      dateRowData.push(format(d, 'dd.MM.yyyy'));
      dateRowData.push('', '', '');
    });
    const dateRow = sheet.addRow(dateRowData);
    dateRow.height = 18;
    
    // Merge and style date cells (4 columns per day)
    days.forEach((day, idx) => {
      const startCol = 2 + idx * COLS_PER_DAY;
      sheet.mergeCells(4, startCol, 4, startCol + 3);
      const cell = dateRow.getCell(startCol);
      cell.font = { size: 9 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: (day.getDay() === 0 || day.getDay() === 6) ? 'FFFEF3C7' : 'FFF3F4F6' }
      };
      cell.border = {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
    
    // Row 5: Labor percentage row - "Labor" in first col, percentage in next cols per day
    const laborRowData: (string | number)[] = [''];
    days.forEach(day => {
      const stats = getDailyStats(day, deptEmployees);
      laborRowData.push('Labor');
      laborRowData.push(stats.laborCostPercentage > 0 ? `${stats.laborCostPercentage.toFixed(2)} %` : '');
      laborRowData.push('', '');
    });
    const laborRow = sheet.addRow(laborRowData);
    laborRow.height = 18;
    
    // Style labor cells (merge first 2 and last 2 of each day's 4 columns)
    days.forEach((day, idx) => {
      const startCol = 2 + idx * COLS_PER_DAY;
      
      // Merge "Labor" across 2 columns
      sheet.mergeCells(5, startCol, 5, startCol + 1);
      const labelCell = laborRow.getCell(startCol);
      labelCell.font = { size: 8, italic: true };
      labelCell.alignment = { horizontal: 'right', vertical: 'middle' };
      labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
      
      // Merge percentage value across 2 columns
      sheet.mergeCells(5, startCol + 2, 5, startCol + 3);
      const valueCell = laborRow.getCell(startCol + 2);
      valueCell.font = { size: 8 };
      valueCell.alignment = { horizontal: 'left', vertical: 'middle' };
      valueCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
    });
    
    // Row 6: Notes/Events row (empty, can be used for special events)
    const notesRowData: string[] = [''];
    days.forEach(() => {
      notesRowData.push('', '', '', '');
    });
    const notesRow = sheet.addRow(notesRowData);
    notesRow.height = 20;
    
    // Row 7: Früh/Spät headers - each day has 4 columns: Früh (2) + Spät (2)
    const slotHeaderData: string[] = ['NAME'];
    days.forEach(() => {
      slotHeaderData.push('Früh', '', 'Spät', '');
    });
    slotHeaderData.push('Plan', 'Soll', '+/-', 'CHF');
    const slotRow = sheet.addRow(slotHeaderData);
    slotRow.height = 22;
    const headerRowNum = slotRow.number;
    
    // Merge Früh and Spät headers (2 columns each)
    days.forEach((_, idx) => {
      const startCol = 2 + idx * COLS_PER_DAY;
      sheet.mergeCells(7, startCol, 7, startCol + 1); // Früh
      sheet.mergeCells(7, startCol + 2, 7, startCol + 3); // Spät
    });
    
    slotRow.eachCell((cell, colNumber) => {
      if (colNumber >= 2) {
        cell.font = { bold: true, size: 9 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
        cell.border = {
          top: { style: 'thin' },
          bottom: { style: 'medium' },
          left: { style: 'thin' },
          right: { style: 'thin' }
        };
      }
    });
    slotRow.getCell(1).font = { bold: true, size: 10 };
    slotRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4CAF50' } };
    slotRow.getCell(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    
    // Helper to convert time string "HH:MM" to Excel time value (fraction of day)
    const timeToExcelValue = (time: string): number | null => {
      if (!time) return null;
      const [h, m] = time.split(':').map(Number);
      if (isNaN(h) || isNaN(m)) return null;
      return (h * 60 + m) / (24 * 60);
    };
    
    // Employee data rows - 4 columns per day
    deptEmployees.forEach((emp, empIdx) => {
      const rowData: (string | number | null)[] = [emp.name];
      
      // Fill in schedule data for each day (4 columns: Früh Start, Früh Ende, Spät Start, Spät Ende)
      days.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const cellKey = `${emp.id}-${dateStr}`;
        const daySchedule = scheduleData[cellKey];
        
        let frühStart: string | number | null = null;
        let frühEnd: string | number | null = null;
        let spätStart: string | number | null = null;
        let spätEnd: string | number | null = null;
        
        if (daySchedule) {
          // Früh slot
          if (daySchedule.frühAbsence) {
            frühStart = daySchedule.frühAbsence;
            frühEnd = daySchedule.frühAbsence;
          } else if (daySchedule.früh) {
            // Convert to Excel time values
            frühStart = timeToExcelValue(daySchedule.früh.start) ?? '';
            frühEnd = timeToExcelValue(daySchedule.früh.end) ?? '';
          }
          
          // Spät slot
          if (daySchedule.spätAbsence) {
            spätStart = daySchedule.spätAbsence;
            spätEnd = daySchedule.spätAbsence;
          } else if (daySchedule.spät) {
            // Convert to Excel time values
            spätStart = timeToExcelValue(daySchedule.spät.start) ?? '';
            spätEnd = timeToExcelValue(daySchedule.spät.end) ?? '';
          }
        }
        
        rowData.push(frühStart ?? '', frühEnd ?? '', spätStart ?? '', spätEnd ?? '');
      });
      
      // Summary columns
      const hoursCol = summaryStartCol;
      const sollCol = summaryStartCol + 1;
      const diffCol = summaryStartCol + 2;
      const costsCol = summaryStartCol + 3;
      
      rowData.push(0, 0, 0, 0);
      
      const row = sheet.addRow(rowData);
      row.height = 22;
      
      // Calculate planned hours for this employee
      let plannedHours = 0;
      days.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const cellKey = `${emp.id}-${dateStr}`;
        const daySchedule = scheduleData[cellKey];
        
        if (daySchedule) {
          plannedHours += calculateSlotHours(daySchedule.früh);
          plannedHours += calculateSlotHours(daySchedule.spät);
          
          // Add absence hours
          if (daySchedule.frühAbsence) {
            const shift = absenceShifts.find(s => s.abbrev === daySchedule.frühAbsence);
            if (shift && shiftMap[shift.name]?.countsToTarget) {
              plannedHours += shift.hours;
            }
          }
          if (daySchedule.spätAbsence && daySchedule.spätAbsence !== daySchedule.frühAbsence) {
            const shift = absenceShifts.find(s => s.abbrev === daySchedule.spätAbsence);
            if (shift && shiftMap[shift.name]?.countsToTarget) {
              plannedHours += shift.hours;
            }
          }
        }
      });
      
      const targetHours = emp.weeklyHours ? Math.round(emp.weeklyHours * 4.33) : Math.round(42 * 4.33);
      const diff = plannedHours - targetHours;
      const empCost = plannedHours * (emp.hourlyWage || 0);
      
      row.getCell(hoursCol).value = plannedHours;
      row.getCell(hoursCol).numFmt = '0.0';
      row.getCell(sollCol).value = targetHours;
      row.getCell(diffCol).value = diff;
      row.getCell(diffCol).numFmt = '+0.0;-0.0;0';
      row.getCell(costsCol).value = empCost;
      row.getCell(costsCol).numFmt = '"CHF" #,##0';
      
      // Style cells
      row.eachCell((cell, colNumber) => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { size: 9 };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          right: { style: 'thin', color: { argb: 'FFE5E7EB' } }
        };
        
        // Alternating row colors
        if (empIdx % 2 === 1) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
        }
      });
      
      // Name cell styling
      const nameCell = row.getCell(1);
      nameCell.font = { size: 10, bold: true };
      nameCell.alignment = { horizontal: 'left', vertical: 'middle' };
      
      // Style cells with colors based on content
      days.forEach((day, dayIdx) => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const cellKey = `${emp.id}-${dateStr}`;
        const daySchedule = scheduleData[cellKey];
        
        const frühStartCol = 2 + dayIdx * COLS_PER_DAY;
        const frühEndCol = frühStartCol + 1;
        const spätStartCol = frühStartCol + 2;
        const spätEndCol = frühStartCol + 3;
        
        const frühStartCell = row.getCell(frühStartCol);
        const frühEndCell = row.getCell(frühEndCol);
        const spätStartCell = row.getCell(spätStartCol);
        const spätEndCell = row.getCell(spätEndCol);
        
        // Apply time format for numeric time values (HH:MM)
        [frühStartCell, frühEndCell, spätStartCell, spätEndCell].forEach(cell => {
          if (typeof cell.value === 'number') {
            cell.numFmt = 'hh:mm';
          }
        });
        
        // Apply absence styling for Früh
        if (daySchedule?.frühAbsence) {
          const shift = absenceShifts.find(s => s.abbrev === daySchedule.frühAbsence);
          if (shift) {
            frühStartCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: shift.excelColor } };
            frühStartCell.font = { color: { argb: shift.textColor }, bold: true, size: 9 };
            frühEndCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: shift.excelColor } };
            frühEndCell.font = { color: { argb: shift.textColor }, bold: true, size: 9 };
          }
        }
        
        // Apply absence styling for Spät
        if (daySchedule?.spätAbsence) {
          const shift = absenceShifts.find(s => s.abbrev === daySchedule.spätAbsence);
          if (shift) {
            spätStartCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: shift.excelColor } };
            spätStartCell.font = { color: { argb: shift.textColor }, bold: true, size: 9 };
            spätEndCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: shift.excelColor } };
            spätEndCell.font = { color: { argb: shift.textColor }, bold: true, size: 9 };
          }
        }
        
        // Weekend background for empty cells
        if ((day.getDay() === 0 || day.getDay() === 6)) {
          [frühStartCell, frühEndCell, spätStartCell, spätEndCell].forEach(cell => {
            if (!cell.value) {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
            }
          });
        }
        
        // Add dropdown validation for all time cells
        if (dropdownList) {
          [frühStartCell, frühEndCell, spätStartCell, spätEndCell].forEach((cell, i) => {
            cell.dataValidation = {
              type: 'list',
              allowBlank: true,
              formulae: [`"${dropdownList}"`],
              showInputMessage: true,
              prompt: i % 2 === 0 ? 'Startzeit (z.B. 11:00) oder Kürzel' : 'Endzeit (z.B. 14:00) oder Kürzel',
              promptTitle: i < 2 ? 'Früh' : 'Spät'
            };
          });
        }
      });
      
      // Diff cell coloring
      const diffCell = row.getCell(diffCol);
      if (diff >= -5 && diff <= 5) {
        diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
        diffCell.font = { color: { argb: 'FF15803D' }, bold: true };
      } else if (diff < -5) {
        diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
        diffCell.font = { color: { argb: 'FF92400E' }, bold: true };
      } else {
        diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
        diffCell.font = { color: { argb: 'FF991B1B' }, bold: true };
      }
    });
    
    // Aushilfe separator row
    const aushilfeRow = sheet.addRow(['Aushilfe']);
    aushilfeRow.height = 20;
    aushilfeRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3C7' } };
    aushilfeRow.getCell(1).font = { bold: true, size: 10 };
    
    // Summary row
    const summaryData: (string | number)[] = ['SUMME'];
    
    let totalMonthHours = 0;
    let totalMonthCosts = 0;
    
    days.forEach(day => {
      const stats = getDailyStats(day, deptEmployees);
      summaryData.push(`${stats.totalHours.toFixed(1)}h`, '', '', '');
      totalMonthHours += stats.totalHours;
      totalMonthCosts += stats.totalCosts;
    });
    
    summaryData.push(totalMonthHours.toFixed(1), '', '', totalMonthCosts.toFixed(0));
    
    const summaryRow = sheet.addRow(summaryData);
    summaryRow.height = 24;
    summaryRow.font = { bold: true };
    
    summaryRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'medium' },
        bottom: { style: 'thin' }
      };
    });
    
    // Merge summary day cells (4 columns per day)
    days.forEach((_, idx) => {
      const startCol = 2 + idx * COLS_PER_DAY;
      sheet.mergeCells(summaryRow.number, startCol, summaryRow.number, startCol + 3);
    });
    
    // Pause row at the bottom
    const pauseData: (string | number)[] = ['Pause'];
    days.forEach(() => {
      pauseData.push('', '', '', '');
    });
    const pauseRow = sheet.addRow(pauseData);
    pauseRow.height = 20;
    pauseRow.getCell(1).font = { bold: true };
    
    // Print settings
    sheet.pageSetup = {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
      margins: {
        left: 0.25,
        right: 0.25,
        top: 0.5,
        bottom: 0.5,
        header: 0.3,
        footer: 0.3
      }
    };
    
    // Freeze first column and header rows
    sheet.views = [{
      state: 'frozen',
      xSplit: 1,
      ySplit: 7
    }];
  };
  
  // Create Plan vs. Ist comparison sheet if hoursType is 'both' or 'ist'
  const createComparisonSheet = (deptEmployees: Employee[], deptName: string) => {
    const sheet = workbook.addWorksheet(`${deptName} Vergleich`);
    
    // Column widths
    sheet.getColumn(1).width = 15; // Name
    sheet.getColumn(2).width = 10; // Plan Stunden
    sheet.getColumn(3).width = 10; // Ist Stunden
    sheet.getColumn(4).width = 10; // Differenz
    if (includeCosts) {
      sheet.getColumn(5).width = 12; // Plan Kosten
      sheet.getColumn(6).width = 12; // Ist Kosten
      sheet.getColumn(7).width = 12; // Kosten Diff
    }
    
    // Title row
    const titleRow = sheet.addRow([`Plan vs. Ist Vergleich - ${deptName} - ${monthName}`]);
    titleRow.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    titleRow.height = 26;
    titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    sheet.mergeCells(1, 1, 1, includeCosts ? 7 : 4);
    titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    
    sheet.addRow([]);
    
    // Header row
    const headers = ['Mitarbeiter', 'Plan Std.', 'Ist Std.', 'Diff.'];
    if (includeCosts) {
      headers.push('Plan CHF', 'Ist CHF', 'Diff. CHF');
    }
    const headerRow = sheet.addRow(headers);
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'medium' } };
    });
    
    // Employee rows
    let totalPlanHours = 0;
    let totalIstHours = 0;
    let totalPlanCosts = 0;
    let totalIstCosts = 0;
    
    deptEmployees.forEach((emp) => {
      // Calculate plan hours
      let planHours = 0;
      days.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const cellKey = `${emp.id}-${dateStr}`;
        const daySchedule = scheduleData[cellKey];
        
        if (daySchedule) {
          planHours += calculateSlotHours(daySchedule.früh);
          planHours += calculateSlotHours(daySchedule.spät);
          
          if (daySchedule.frühAbsence) {
            const shift = absenceShifts.find(s => s.abbrev === daySchedule.frühAbsence);
            if (shift && shiftMap[shift.name]?.countsToTarget) {
              planHours += shift.hours;
            }
          }
          if (daySchedule.spätAbsence && daySchedule.spätAbsence !== daySchedule.frühAbsence) {
            const shift = absenceShifts.find(s => s.abbrev === daySchedule.spätAbsence);
            if (shift && shiftMap[shift.name]?.countsToTarget) {
              planHours += shift.hours;
            }
          }
        }
      });
      
      // Calculate ist hours
      let istHours = 0;
      days.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const cellKey = `${emp.id}-${dateStr}`;
        const entry = actualHoursData[cellKey];
        if (entry?.hours) {
          istHours += entry.hours;
        }
      });
      
      const diff = istHours - planHours;
      const planCost = planHours * (emp.hourlyWage || 0);
      const istCost = istHours * (emp.hourlyWage || 0);
      const costDiff = istCost - planCost;
      
      totalPlanHours += planHours;
      totalIstHours += istHours;
      totalPlanCosts += planCost;
      totalIstCosts += istCost;
      
      const rowData: (string | number)[] = [emp.name, planHours, istHours, diff];
      if (includeCosts) {
        rowData.push(planCost, istCost, costDiff);
      }
      
      const row = sheet.addRow(rowData);
      row.getCell(2).numFmt = '0.0';
      row.getCell(3).numFmt = '0.0';
      row.getCell(4).numFmt = '+0.0;-0.0;0';
      row.getCell(4).font = { color: { argb: diff > 0 ? 'FF16A34A' : diff < 0 ? 'FFDC2626' : 'FF000000' } };
      
      if (includeCosts) {
        row.getCell(5).numFmt = '#,##0';
        row.getCell(6).numFmt = '#,##0';
        row.getCell(7).numFmt = '+#,##0;-#,##0;0';
        row.getCell(7).font = { color: { argb: costDiff > 0 ? 'FFDC2626' : costDiff < 0 ? 'FF16A34A' : 'FF000000' } };
      }
    });
    
    // Total row
    sheet.addRow([]);
    const totalRowData: (string | number)[] = ['TOTAL', totalPlanHours, totalIstHours, totalIstHours - totalPlanHours];
    if (includeCosts) {
      totalRowData.push(totalPlanCosts, totalIstCosts, totalIstCosts - totalPlanCosts);
    }
    const totalRow = sheet.addRow(totalRowData);
    totalRow.font = { bold: true };
    totalRow.eachCell((cell, colNum) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
      cell.border = { top: { style: 'medium' } };
      if (colNum === 2) cell.numFmt = '0.0';
      if (colNum === 3) cell.numFmt = '0.0';
      if (colNum === 4) {
        cell.numFmt = '+0.0;-0.0;0';
        const diff = totalIstHours - totalPlanHours;
        cell.font = { bold: true, color: { argb: diff > 0 ? 'FF16A34A' : diff < 0 ? 'FFDC2626' : 'FF000000' } };
      }
      if (includeCosts && colNum === 5) cell.numFmt = '#,##0';
      if (includeCosts && colNum === 6) cell.numFmt = '#,##0';
      if (includeCosts && colNum === 7) {
        cell.numFmt = '+#,##0;-#,##0;0';
        const diff = totalIstCosts - totalPlanCosts;
        cell.font = { bold: true, color: { argb: diff > 0 ? 'FFDC2626' : diff < 0 ? 'FF16A34A' : 'FF000000' } };
      }
    });
  };
  
  // Create sheets based on hoursType
  if (hoursType === 'plan' || hoursType === 'both') {
    if (department === 'all' || department === 'service') {
      createTemplateSheet(serviceEmployees, 'Service');
    }
    if (department === 'all' || department === 'küche') {
      createTemplateSheet(kücheEmployees, 'Küche');
    }
  }
  
  if (hoursType === 'ist' || hoursType === 'both') {
    if (department === 'all' || department === 'service') {
      createComparisonSheet(serviceEmployees, 'Service');
    }
    if (department === 'all' || department === 'küche') {
      createComparisonSheet(kücheEmployees, 'Küche');
    }
  }
  
  // Download the file
  const hoursLabel = hoursType === 'ist' ? 'Ist' : hoursType === 'both' ? 'Plan-Ist' : '';
  const fileName = isWeekExport 
    ? `Dienstplan_KW${format(days[0], 'w', { locale: de })}_${format(currentMonth, 'MMMM_yyyy', { locale: de })}${hoursLabel ? `_${hoursLabel}` : ''}.xlsx`
    : `Dienstplan_${format(currentMonth, 'MMMM_yyyy', { locale: de })}${hoursLabel ? `_${hoursLabel}` : ''}.xlsx`;
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function exportScheduleToPDF(options: ExportOptionsV2): Promise<void> {
  const { employees, scheduleData, currentMonth, department = 'all', dailyBudgets = {}, showCosts = false } = options;
  
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const days = getDaysInMonth(year, month);
  const monthName = format(currentMonth, 'MMMM yyyy', { locale: de });
  
  const shifts = getShiftConfig();
  const shiftMap = getShiftConfigMap();
  const absenceShifts = shifts.filter(s => !s.start || !s.end);
  
  // Load labor cost threshold
  const LABOR_COST_THRESHOLD_KEY = 'labor_cost_threshold';
  const laborCostThreshold = parseFloat(localStorage.getItem(LABOR_COST_THRESHOLD_KEY) || '40');
  
  // Sort employees by ID to maintain consistent order from Excel file
  const sortByEmployeeId = (a: Employee, b: Employee) => parseInt(a.id) - parseInt(b.id);
  const serviceEmployees = employees.filter(e => e.department === 'service').sort(sortByEmployeeId);
  const kücheEmployees = employees.filter(e => e.department === 'küche').sort(sortByEmployeeId);
  
// Calculate daily stats
  const getDailyStats = (day: Date, deptEmployees: Employee[]) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    let totalHours = 0;
    let totalCosts = 0;

    deptEmployees.forEach(emp => {
      const cellKey = `${emp.id}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];
      
      if (daySchedule) {
        const frühHours = calculateSlotHours(daySchedule.früh);
        const spätHours = calculateSlotHours(daySchedule.spät);
        let dayHours = frühHours + spätHours;
        
        // Add absence hours if countsToTarget
        if (daySchedule.frühAbsence) {
          const absenceShift = absenceShifts.find(s => s.abbrev === daySchedule.frühAbsence);
          if (absenceShift && shiftMap[absenceShift.name]?.countsToTarget) {
            dayHours += absenceShift.hours;
          }
        }
        if (daySchedule.spätAbsence) {
          const absenceShift = absenceShifts.find(s => s.abbrev === daySchedule.spätAbsence);
          if (absenceShift && shiftMap[absenceShift.name]?.countsToTarget) {
            // Only add if different from früh absence (avoid double counting)
            if (daySchedule.spätAbsence !== daySchedule.frühAbsence) {
              dayHours += absenceShift.hours;
            }
          }
        }
        
        totalHours += dayHours;
        
        if (emp.hourlyWage) {
          totalCosts += dayHours * emp.hourlyWage;
        }
      }
    });

    const budget = dailyBudgets[dateStr];
    const plannedRevenue = budget?.plannedRevenue || 0;
    const laborCostPercentage = plannedRevenue > 0 ? (totalCosts / plannedRevenue) * 100 : 0;
    const isOverBudget = plannedRevenue > 0 && laborCostPercentage > laborCostThreshold;
    
    return { totalHours, totalCosts, plannedRevenue, laborCostPercentage, isOverBudget };
  };
  
  // Create PDF (A4 landscape)
  const pdf = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4'
  });
  
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  
  const createPage = (deptEmployees: Employee[], deptName: string, isFirstPage: boolean) => {
    if (!isFirstPage) {
      pdf.addPage();
    }
    
    // Title
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text(`Dienstplan ${deptName} - ${monthName}`, 10, 12);
    
    // Legend
    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'normal');
    let legendX = 10;
    absenceShifts.forEach((shift) => {
      pdf.text(`${shift.abbrev} = ${shift.name}`, legendX, 18);
      legendX += 25;
    });
    
    // Prepare table data
    const headers: string[] = ['Name'];
    days.forEach(d => {
      headers.push(formatDateHeader(d));
    });
    headers.push('Plan', 'Soll', '+/-');
    if (showCosts) {
      headers.push('CHF');
    }
    
    const body: (string | number)[][] = [];
    
    deptEmployees.forEach((emp) => {
      const rowData: (string | number)[] = [emp.name];
      let plannedHours = 0;
      let empCost = 0;
      
      days.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const cellKey = `${emp.id}-${dateStr}`;
        const daySchedule = scheduleData[cellKey] || {};
        
        let cellContent = '';
        
        if (daySchedule.frühAbsence && daySchedule.spätAbsence) {
          cellContent = daySchedule.frühAbsence === daySchedule.spätAbsence 
            ? daySchedule.frühAbsence 
            : `${daySchedule.frühAbsence}/${daySchedule.spätAbsence}`;
        } else if (daySchedule.frühAbsence) {
          cellContent = daySchedule.spät 
            ? `${daySchedule.frühAbsence}/${formatTimeSlot(daySchedule.spät)}` 
            : daySchedule.frühAbsence;
        } else if (daySchedule.spätAbsence) {
          cellContent = daySchedule.früh 
            ? `${formatTimeSlot(daySchedule.früh)}/${daySchedule.spätAbsence}` 
            : daySchedule.spätAbsence;
        } else if (daySchedule.früh || daySchedule.spät) {
          const parts: string[] = [];
          if (daySchedule.früh) parts.push(formatTimeSlot(daySchedule.früh));
          if (daySchedule.spät) parts.push(formatTimeSlot(daySchedule.spät));
          cellContent = parts.join(' / ');
        }
        
        rowData.push(cellContent);
        
        const frühHours = calculateSlotHours(daySchedule.früh);
        const spätHours = calculateSlotHours(daySchedule.spät);
        plannedHours += frühHours + spätHours;
        
        if (daySchedule.frühAbsence) {
          const shift = absenceShifts.find(s => shiftMap[s.name]?.abbrev === daySchedule.frühAbsence);
          if (shift && shiftMap[shift.name]?.countsToTarget) {
            plannedHours += shiftMap[shift.name].hours;
          }
        }
        if (daySchedule.spätAbsence) {
          const shift = absenceShifts.find(s => shiftMap[s.name]?.abbrev === daySchedule.spätAbsence);
          if (shift && shiftMap[shift.name]?.countsToTarget) {
            plannedHours += shiftMap[shift.name].hours;
          }
        }
        
        if (emp.hourlyWage) {
          empCost += (frühHours + spätHours) * emp.hourlyWage;
        }
      });
      
      const targetHours = emp.weeklyHours ? emp.weeklyHours * 4.33 : 42 * 4.33;
      const diff = plannedHours - targetHours;
      
      rowData.push(plannedHours.toFixed(1));
      rowData.push(targetHours.toFixed(0));
      rowData.push(diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1));
      if (showCosts) {
        rowData.push(`${empCost.toFixed(0)}€`);
      }
      
      body.push(rowData);
    });
    
    // Footer rows
    const footerRow: (string | number)[] = ['SUMME'];
    let totalMonthHours = 0;
    let totalMonthCosts = 0;
    
    days.forEach(day => {
      const stats = getDailyStats(day, deptEmployees);
      footerRow.push(`${stats.totalHours.toFixed(1)}h`);
      totalMonthHours += stats.totalHours;
      totalMonthCosts += stats.totalCosts;
    });
    footerRow.push(totalMonthHours.toFixed(1), '', '');
    if (showCosts) {
      footerRow.push(`${totalMonthCosts.toFixed(0)}€`);
    }
    body.push(footerRow);
    
    if (showCosts) {
      // Costs row
      const costRow: (string | number)[] = ['KOSTEN'];
      days.forEach(day => {
        const stats = getDailyStats(day, deptEmployees);
        costRow.push(`${stats.totalCosts.toFixed(0)}€`);
      });
      costRow.push('', '', '', `${totalMonthCosts.toFixed(0)}€`);
      body.push(costRow);
      
      // PKQ row
      const pkqRow: (string | number)[] = ['PKQ'];
      let totalRevenue = 0;
      days.forEach(day => {
        const stats = getDailyStats(day, deptEmployees);
        pkqRow.push(stats.plannedRevenue > 0 ? `${stats.laborCostPercentage.toFixed(1)}%` : '-');
        totalRevenue += stats.plannedRevenue;
      });
      const monthPKQ = totalRevenue > 0 ? (totalMonthCosts / totalRevenue * 100) : 0;
      pkqRow.push('', '', '', monthPKQ > 0 ? `${monthPKQ.toFixed(1)}%` : '-');
      body.push(pkqRow);
    }
    
    // Calculate column widths
    const nameColWidth = 22;
    const summaryColWidth = 10;
    const numSummaryCols = showCosts ? 4 : 3;
    const availableWidth = pageWidth - 20 - nameColWidth - (summaryColWidth * numSummaryCols);
    const dayColWidth = availableWidth / days.length;
    
    const columnStyles: Record<number, { cellWidth: number; halign?: 'left' | 'center' | 'right' }> = {
      0: { cellWidth: nameColWidth, halign: 'left' }
    };
    for (let i = 1; i <= days.length; i++) {
      columnStyles[i] = { cellWidth: dayColWidth, halign: 'center' };
    }
    for (let i = 0; i < numSummaryCols; i++) {
      columnStyles[days.length + 1 + i] = { cellWidth: summaryColWidth, halign: 'center' };
    }
    
    autoTable(pdf, {
      head: [headers],
      body: body,
      startY: 22,
      theme: 'grid',
      styles: {
        fontSize: 6,
        cellPadding: 1,
        lineWidth: 0.1,
        lineColor: [200, 200, 200],
        overflow: 'linebreak'
      },
      headStyles: {
        fillColor: [30, 64, 175],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 6,
        halign: 'center'
      },
      columnStyles: columnStyles,
      didParseCell: function(data) {
        const colIndex = data.column.index;
        const rowIndex = data.row.index;
        
        // Weekend headers
        if (data.section === 'head' && colIndex > 0 && colIndex <= days.length) {
          const day = days[colIndex - 1];
          if (day && (day.getDay() === 0 || day.getDay() === 6)) {
            data.cell.styles.fillColor = [217, 119, 6];
          }
        }
        
        // Employee rows styling
        if (data.section === 'body' && rowIndex < deptEmployees.length) {
          // Alternating row colors
          if (rowIndex % 2 === 1) {
            data.cell.styles.fillColor = [249, 250, 251];
          }
          
          // Day cell styling
          if (colIndex > 0 && colIndex <= days.length) {
            const emp = deptEmployees[rowIndex];
            const day = days[colIndex - 1];
            const dateStr = format(day, 'yyyy-MM-dd');
            const cellKey = `${emp.id}-${dateStr}`;
            const daySchedule = scheduleData[cellKey] || {};
            
            if (daySchedule.frühAbsence || daySchedule.spätAbsence) {
              data.cell.styles.fillColor = [254, 243, 199];
              data.cell.styles.fontStyle = 'bold';
            } else if (daySchedule.früh || daySchedule.spät) {
              data.cell.styles.fillColor = [219, 234, 254];
              data.cell.styles.textColor = [30, 64, 175];
            } else if (day.getDay() === 0 || day.getDay() === 6) {
              data.cell.styles.fillColor = [254, 243, 199];
            }
          }
          
          // Diff column styling
          const diffColIndex = days.length + 3;
          if (colIndex === diffColIndex) {
            const cellValue = String(data.cell.raw);
            const diffValue = parseFloat(cellValue);
            if (!isNaN(diffValue)) {
              if (diffValue >= -5 && diffValue <= 5) {
                data.cell.styles.fillColor = [220, 252, 231];
                data.cell.styles.textColor = [21, 128, 61];
              } else if (diffValue < -5) {
                data.cell.styles.fillColor = [254, 243, 199];
                data.cell.styles.textColor = [146, 64, 14];
              } else {
                data.cell.styles.fillColor = [254, 226, 226];
                data.cell.styles.textColor = [153, 27, 27];
              }
              data.cell.styles.fontStyle = 'bold';
            }
          }
        }
        
        // Footer rows styling
        if (data.section === 'body' && rowIndex >= deptEmployees.length) {
          data.cell.styles.fillColor = [229, 231, 235];
          data.cell.styles.fontStyle = 'bold';
        }
      }
    });
  };
  
  let isFirst = true;
  if (department === 'all' || department === 'service') {
    createPage(serviceEmployees, 'Service', isFirst);
    isFirst = false;
  }
  
  if (department === 'all' || department === 'küche') {
    createPage(kücheEmployees, 'Küche', isFirst);
  }
  
  // Save PDF
  const fileName = `Dienstplan_${format(currentMonth, 'MMMM_yyyy', { locale: de })}.pdf`;
  pdf.save(fileName);
}

export function importScheduleFromExcelV2(
  file: File,
  employees: Employee[],
  currentMonth: Date,
  existingScheduleData: Record<string, DaySchedule>
): Promise<ImportResultV2> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        
        const year = currentMonth.getFullYear();
        const month = currentMonth.getMonth();
        const days = getDaysInMonth(year, month);
        
        const shifts = getShiftConfig();
        const shiftMap = getShiftConfigMap();
        
        const newScheduleData = { ...existingScheduleData };
        const newEmployees: Employee[] = [];
        const errors: string[] = [];
        const nameMatches: NameMatchInfo[] = [];
        const processedNames = new Set<string>(); // Track already processed names
        
        // Helper to generate unique employee ID
        const generateEmployeeId = (): string => {
          const timestamp = Date.now();
          const random = Math.random().toString(36).substring(2, 8);
          return `imported-${timestamp}-${random}`;
        };
        
        // Detect department from sheet name
        const detectDepartment = (sheetName: string): 'service' | 'küche' => {
          const lower = sheetName.toLowerCase();
          if (lower.includes('küche') || lower.includes('kuche') || lower.includes('kitchen')) {
            return 'küche';
          }
          return 'service';
        };
        
        workbook.SheetNames.forEach(sheetName => {
          const sheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json<any>(sheet, { header: 1 });
          
          // Find header row with NAME or Mitarbeiter
          let headerRowIndex = -1;
          let nameColIndex = -1;
          
          for (let i = 0; i < jsonData.length; i++) {
            const row = jsonData[i] as any[];
            if (row) {
              const nameIdx = row.findIndex((cell: any) => 
                typeof cell === 'string' && (
                  cell.toUpperCase() === 'NAME' || 
                  cell.toLowerCase() === 'mitarbeiter'
                )
              );
              if (nameIdx !== -1) {
                headerRowIndex = i;
                nameColIndex = nameIdx;
                break;
              }
            }
          }
          
          if (headerRowIndex === -1) {
            errors.push(`Sheet "${sheetName}": Keine NAME/Mitarbeiter-Spalte gefunden`);
            return;
          }
          
          const headerRow = jsonData[headerRowIndex] as any[];
          
          // Check if this is the new 4-column format (Früh merged over 2 cols, Spät merged over 2 cols)
          const frühIndices: number[] = [];
          const spätIndices: number[] = [];
          
          for (let col = 0; col < (headerRow.length || 0); col++) {
            const cell = headerRow[col];
            if (typeof cell === 'string') {
              if (cell === 'Früh') frühIndices.push(col);
              if (cell === 'Spät') spätIndices.push(col);
            }
          }
          
          // Find date row - look for dates like "12.01.2026"
          let dateRowIndex = -1;
          
          for (let i = headerRowIndex - 1; i >= 0; i--) {
            const row = jsonData[i] as any[];
            if (row) {
              const hasDate = row.some((cell: any) => 
                typeof cell === 'string' && /\d{2}\.\d{2}\.\d{4}/.test(cell)
              );
              if (hasDate) {
                dateRowIndex = i;
                break;
              }
            }
          }
          
          // Build day column map - supporting both 2-column and 4-column formats
          const dayColumnMap: { 
            date: Date; 
            frühStartCol: number; 
            frühEndCol: number; 
            spätStartCol: number; 
            spätEndCol: number;
            is4ColFormat: boolean;
          }[] = [];
          
          // Detect format: 4-column format has Früh and Spät each spanning 2 columns
          // Check if Früh and Spät are 2 columns apart (4-column format) or 1 column apart (2-column format)
          const is4ColFormat = frühIndices.length > 0 && spätIndices.length > 0 && 
            spätIndices[0] - frühIndices[0] === 2;
          
          if (is4ColFormat && dateRowIndex >= 0) {
            // 4-column format: Früh Start, Früh Ende, Spät Start, Spät Ende
            const dateRow = jsonData[dateRowIndex] as any[];
            
            for (let i = 0; i < frühIndices.length; i++) {
              const frühCol = frühIndices[i];
              const spätCol = spätIndices[i];
              
              if (spätCol !== undefined && spätCol === frühCol + 2) {
                // Look for date in dateRow (may be merged, so check nearby columns)
                let dateValue: string | null = null;
                for (let offset = 0; offset <= 3; offset++) {
                  const checkCol = frühCol + offset;
                  if (dateRow[checkCol]) {
                    const val = String(dateRow[checkCol]);
                    const dateMatch = val.match(/(\d{2})\.(\d{2})\.(\d{4})/);
                    if (dateMatch) {
                      dateValue = val;
                      break;
                    }
                  }
                }
                
                if (dateValue) {
                  const dateMatch = dateValue.match(/(\d{2})\.(\d{2})\.(\d{4})/);
                  if (dateMatch) {
                    const day = parseInt(dateMatch[1]);
                    const monthNum = parseInt(dateMatch[2]) - 1;
                    const yearNum = parseInt(dateMatch[3]);
                    
                    if (monthNum === month && yearNum === year) {
                      dayColumnMap.push({
                        date: new Date(yearNum, monthNum, day),
                        frühStartCol: frühCol,
                        frühEndCol: frühCol + 1,
                        spätStartCol: spätCol,
                        spätEndCol: spätCol + 1,
                        is4ColFormat: true
                      });
                    }
                  }
                }
              }
            }
          } else if (frühIndices.length > 0 && spätIndices.length > 0 && dateRowIndex >= 0) {
            // 2-column format: Früh, Spät (each 1 column)
            const dateRow = jsonData[dateRowIndex] as any[];
            
            for (let i = 0; i < frühIndices.length; i++) {
              const frühCol = frühIndices[i];
              const spätCol = spätIndices[i];
              
              if (spätCol !== undefined && spätCol === frühCol + 1) {
                // Look for date
                let dateValue: string | null = null;
                for (let offset = 0; offset <= 1; offset++) {
                  const checkCol = frühCol + offset;
                  if (dateRow[checkCol]) {
                    const val = String(dateRow[checkCol]);
                    const dateMatch = val.match(/(\d{2})\.(\d{2})\.(\d{4})/);
                    if (dateMatch) {
                      dateValue = val;
                      break;
                    }
                  }
                }
                
                if (dateValue) {
                  const dateMatch = dateValue.match(/(\d{2})\.(\d{2})\.(\d{4})/);
                  if (dateMatch) {
                    const day = parseInt(dateMatch[1]);
                    const monthNum = parseInt(dateMatch[2]) - 1;
                    const yearNum = parseInt(dateMatch[3]);
                    
                    if (monthNum === month && yearNum === year) {
                      dayColumnMap.push({
                        date: new Date(yearNum, monthNum, day),
                        frühStartCol: frühCol,
                        frühEndCol: frühCol,
                        spätStartCol: spätCol,
                        spätEndCol: spätCol,
                        is4ColFormat: false
                      });
                    }
                  }
                }
              }
            }
          }
          
          // Fallback: sequential days
          if (dayColumnMap.length === 0 && frühIndices.length > 0) {
            let dayCounter = 1;
            for (let i = 0; i < frühIndices.length && dayCounter <= days.length; i++) {
              const date = new Date(year, month, dayCounter);
              if (date.getMonth() === month) {
                if (is4ColFormat) {
                  dayColumnMap.push({
                    date,
                    frühStartCol: frühIndices[i],
                    frühEndCol: frühIndices[i] + 1,
                    spätStartCol: spätIndices[i] || frühIndices[i] + 2,
                    spätEndCol: (spätIndices[i] || frühIndices[i] + 2) + 1,
                    is4ColFormat: true
                  });
                } else {
                  dayColumnMap.push({
                    date,
                    frühStartCol: frühIndices[i],
                    frühEndCol: frühIndices[i],
                    spätStartCol: spätIndices[i] || frühIndices[i] + 1,
                    spätEndCol: spätIndices[i] || frühIndices[i] + 1,
                    is4ColFormat: false
                  });
                }
                dayCounter++;
              }
            }
          }
          
          // Parse time helper - handles Excel time values (decimals like 0.458333 for 11:00) and strings
          const parseTime = (val: any): string | null => {
            if (val === null || val === undefined || val === '') return null;
            
            // Handle Excel time values (decimal numbers representing fraction of day)
            // Excel stores 11:00 as 0.458333... (11/24), 14:00 as 0.583333... (14/24)
            if (typeof val === 'number') {
              // Excel serial time: 0.5 = 12:00, 0.75 = 18:00, etc.
              // Handle values that might be stored as hours (e.g., 11 for 11:00)
              if (val >= 0 && val < 1) {
                // It's a time fraction (e.g., 0.458333 for 11:00)
                const totalMinutes = Math.round(val * 24 * 60);
                const hours = Math.floor(totalMinutes / 60);
                const minutes = totalMinutes % 60;
                return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
              } else if (val >= 1 && val <= 24) {
                // It might be stored as hour (e.g., 11 for 11:00)
                const hours = Math.floor(val);
                const minutes = Math.round((val - hours) * 60);
                return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
              }
              return null;
            }
            
            // Handle string values
            const strVal = String(val).trim();
            if (!strVal) return null;
            
            // Standard time format "HH:MM" or "H:MM"
            const timeMatch = strVal.match(/^(\d{1,2}):(\d{2})$/);
            if (timeMatch) {
              const h = timeMatch[1].padStart(2, '0');
              const m = timeMatch[2];
              return `${h}:${m}`;
            }
            
            // Just hours like "11" or "14"
            const hoursOnly = strVal.match(/^(\d{1,2})$/);
            if (hoursOnly) {
              const h = hoursOnly[1].padStart(2, '0');
              return `${h}:00`;
            }
            
            return null;
          };
          
          // Check if value is an absence code
          const isAbsence = (val: string): string | null => {
            if (!val) return null;
            const abbrevShift = shifts.find(
              s => s.abbrev && s.abbrev.toLowerCase() === val.toLowerCase()
            );
            return abbrevShift?.abbrev || null;
          };
          
          // Process employee rows
          for (let rowIdx = headerRowIndex + 1; rowIdx < jsonData.length; rowIdx++) {
            const row = jsonData[rowIdx] as any[];
            if (!row) continue;
            
            const employeeName = row[nameColIndex];
            if (!employeeName || typeof employeeName !== 'string' || !employeeName.trim()) {
              continue;
            }
            
            // Skip summary rows
            const nameLower = employeeName.toLowerCase().trim();
            if (nameLower === 'summe' || nameLower === 'pkq' || nameLower === 'aushilfe' ||
                nameLower.includes('budget') || nameLower.includes('personalkosten') ||
                nameLower.includes('pause')) {
              continue;
            }
            
            // Helper function to match employee by name (exact match or first name match)
            const findEmployeeByName = (empList: Employee[], searchName: string): { employee: Employee; matchType: 'exact' | 'firstName' } | null => {
              const searchLower = searchName.toLowerCase().trim();
              const searchFirstName = searchLower.split(/[\s,]+/)[0]; // Get first word as first name
              
              // Priority 1: Exact match
              let match = empList.find(e => e.name.toLowerCase() === searchLower);
              if (match) return { employee: match, matchType: 'exact' };
              
              // Priority 2: First name match (for single names like "Mendim", "Artin", etc.)
              // Only use first name matching if the search name is a single word
              if (!searchLower.includes(' ')) {
                // Find all employees whose first name matches
                const firstNameMatches = empList.filter(e => {
                  const empFirstName = e.name.toLowerCase().split(/[\s,]+/)[0];
                  return empFirstName === searchFirstName;
                });
                
                // Only use this match if there's exactly one result (avoid ambiguity)
                if (firstNameMatches.length === 1) {
                  return { employee: firstNameMatches[0], matchType: 'firstName' };
                }
              }
              
              return null;
            };
            
            const originalName = employeeName.trim();
            const nameKey = originalName.toLowerCase();
            
            let employee: Employee | undefined;
            let matchType: 'exact' | 'firstName' | 'new' = 'new';
            
            // Try to find in existing employees
            const existingMatch = findEmployeeByName(employees, nameLower);
            if (existingMatch) {
              employee = existingMatch.employee;
              matchType = existingMatch.matchType;
            }
            
            // Also check if employee was already added in this import
            if (!employee) {
              const newMatch = findEmployeeByName(newEmployees, nameLower);
              if (newMatch) {
                employee = newMatch.employee;
                matchType = newMatch.matchType;
              }
            }
            
            // If employee not found, create a new one
            if (!employee) {
              const department = detectDepartment(sheetName);
              const newEmployee: Employee = {
                id: generateEmployeeId(),
                name: originalName,
                department,
                employmentType: 'aushilfe',
                hourlyWage: 25.00, // Default wage
              };
              newEmployees.push(newEmployee);
              employee = newEmployee;
              matchType = 'new';
              console.log(`Neuer Mitarbeiter erstellt: ${newEmployee.name} (${department})`);
            }
            
            // Track name match info (only once per name)
            if (!processedNames.has(nameKey)) {
              processedNames.add(nameKey);
              nameMatches.push({
                importedName: originalName,
                matchedEmployee: matchType !== 'new' ? employee : null,
                matchType,
                isNew: matchType === 'new'
              });
            }
            
            // Process each day's values
            dayColumnMap.forEach(({ date, frühStartCol, frühEndCol, spätStartCol, spätEndCol, is4ColFormat }) => {
              const dateStr = format(date, 'yyyy-MM-dd');
              const cellKey = `${employee.id}-${dateStr}`;
              
              // Keep raw values - could be numbers (Excel time) or strings
              const frühStartVal = row[frühStartCol];
              const frühEndVal = row[frühEndCol];
              const spätStartVal = row[spätStartCol];
              const spätEndVal = row[spätEndCol];
              
              // Check if all values are empty
              const isEmpty = (v: any) => v === null || v === undefined || v === '' || 
                (typeof v === 'string' && v.trim() === '');
              if (isEmpty(frühStartVal) && isEmpty(frühEndVal) && isEmpty(spätStartVal) && isEmpty(spätEndVal)) return;
              
              // Check for absences first (only for string values)
              const frühAbsence = (typeof frühStartVal === 'string' ? isAbsence(frühStartVal) : null) || 
                                  (typeof frühEndVal === 'string' ? isAbsence(frühEndVal) : null);
              const spätAbsence = (typeof spätStartVal === 'string' ? isAbsence(spätStartVal) : null) || 
                                  (typeof spätEndVal === 'string' ? isAbsence(spätEndVal) : null);
              
              let frühSlot: TimeSlot | null = null;
              let spätSlot: TimeSlot | null = null;
              
              if (!frühAbsence && is4ColFormat) {
                // 4-column format: Früh has start and end in separate columns
                const frühStart = parseTime(frühStartVal);
                const frühEnd = parseTime(frühEndVal);
                if (frühStart && frühEnd) {
                  frühSlot = { start: frühStart, end: frühEnd };
                }
              } else if (!frühAbsence && !is4ColFormat) {
                // 2-column format: Früh is start, check if it's a time range (only for strings)
                if (typeof frühStartVal === 'string') {
                  const rangeMatch = frühStartVal.match(/(\d{1,2}):?(\d{2})?\s*[-–]\s*(\d{1,2}):?(\d{2})?/);
                  if (rangeMatch) {
                    const startH = rangeMatch[1].padStart(2, '0');
                    const startM = rangeMatch[2] || '00';
                    const endH = rangeMatch[3].padStart(2, '0');
                    const endM = rangeMatch[4] || '00';
                    frühSlot = { start: `${startH}:${startM}`, end: `${endH}:${endM}` };
                  }
                }
                if (!frühSlot) {
                  const frühStart = parseTime(frühStartVal);
                  const frühEnd = parseTime(spätStartVal);
                  if (frühStart && frühEnd) {
                    // Interpret as single shift spanning Früh to Spät columns
                    frühSlot = { start: frühStart, end: frühEnd };
                  }
                }
              }
              
              if (!spätAbsence && is4ColFormat) {
                // 4-column format: Spät has start and end in separate columns
                const spätStart = parseTime(spätStartVal);
                const spätEnd = parseTime(spätEndVal);
                if (spätStart && spätEnd) {
                  spätSlot = { start: spätStart, end: spätEnd };
                }
              }
              
              // Save to schedule data
              if (frühAbsence || spätAbsence || frühSlot || spätSlot) {
                newScheduleData[cellKey] = {
                  früh: frühSlot,
                  frühAbsence: frühAbsence || null,
                  spät: spätSlot,
                  spätAbsence: spätAbsence || null
                };
              }
            });
          }
        });
        
        resolve({ scheduleData: newScheduleData, newEmployees, errors, nameMatches });
        
      } catch (error) {
        reject(new Error('Fehler beim Lesen der Excel-Datei'));
      }
    };
    
    reader.onerror = () => reject(new Error('Fehler beim Lesen der Datei'));
    reader.readAsArrayBuffer(file);
  });
}

// Keep old exports for backward compatibility
interface CustomShift {
  start: string;
  end: string;
  hours: number;
  start2?: string;
  end2?: string;
}

interface ExportOptions {
  employees: Employee[];
  scheduleData: Record<string, string | null>;
  customShifts: Record<string, CustomShift>;
  currentMonth: Date;
  department?: 'service' | 'küche' | 'all';
}

interface ImportResult {
  scheduleData: Record<string, string | null>;
  customShifts: Record<string, CustomShift>;
  errors: string[];
}

export async function exportScheduleToExcel(options: ExportOptions): Promise<void> {
  // Legacy export - redirect to V2 with empty data for now
  console.warn('Legacy export called - please update to exportScheduleToExcelV2');
}

export function importScheduleFromExcel(
  file: File,
  employees: Employee[],
  currentMonth: Date,
  existingScheduleData: Record<string, string | null>,
  existingCustomShifts: Record<string, CustomShift>
): Promise<ImportResult> {
  console.warn('Legacy import called - please update to importScheduleFromExcelV2');
  return Promise.resolve({
    scheduleData: existingScheduleData,
    customShifts: existingCustomShifts,
    errors: ['Bitte verwende das neue Format']
  });
}
