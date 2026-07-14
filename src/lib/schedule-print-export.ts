/**
 * Schedule Print Export Module
 * 
 * Provides optimized Excel and PDF exports matching the ScheduleGrid view
 * with comprehensive summary sections for professional printing.
 */

import * as ExcelJS from 'exceljs';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Employee } from '@/types/personnel';
import { format, getISOWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { getShiftConfig, getShiftConfigMap, resolveDayBreakHours } from '@/hooks/useShiftConfig';
import { DaySchedule, TimeSlot } from '@/components/schedule-planner/ScheduleGrid';
import { ActualHoursEntry } from '@/components/schedule-planner/ActualHoursGrid';
import { getEffectiveHourlyRate } from '@/lib/employee-rate';
import type { SocialCostRates } from '@/lib/social-costs';

export type ExportHoursType = 'plan' | 'ist' | 'both';

export interface PrintExportOptions {
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  actualHoursData: Record<string, ActualHoursEntry>;
  currentMonth: Date;
  days: Date[];
  hoursType: ExportHoursType;
  includeCosts: boolean;
  isWeekExport: boolean;
  /** AG-Sozialkostensätze — Kosten = Total Arbeitgeberkosten, nie roher hourlyWage */
  rates: SocialCostRates;
}

const WEEKDAY_NAMES_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function calculateSlotHours(slot: TimeSlot | null | undefined): number {
  if (!slot?.start || !slot?.end) return 0;
  const [startH, startM] = slot.start.split(':').map(Number);
  const [endH, endM] = slot.end.split(':').map(Number);
  let hours = endH - startH + (endM - startM) / 60;
  if (hours < 0) hours += 24;
  return Math.round(hours * 100) / 100;
}

// Netto-Arbeitsstunden eines Plan-Tags: Brutto beider Slots minus Pause
// (SSoT resolveDayBreakHours) — Pause NIE auf Absenzstunden anwenden.
function workedNetHours(ds: DaySchedule): number {
  const gross = calculateSlotHours(ds.früh) + calculateSlotHours(ds.spät);
  if (gross <= 0) return 0;
  return Math.max(0, Math.round((gross - resolveDayBreakHours(ds, gross)) * 100) / 100);
}

function formatTimeSlot(slot: TimeSlot | null | undefined): string {
  if (!slot?.start || !slot?.end) return '';
  return `${slot.start.replace(':00', '')}-${slot.end.replace(':00', '')}`;
}

function formatCellContent(daySchedule: DaySchedule | undefined): string {
  if (!daySchedule) return '';
  
  if (daySchedule.frühAbsence && daySchedule.spätAbsence) {
    return daySchedule.frühAbsence === daySchedule.spätAbsence 
      ? daySchedule.frühAbsence 
      : `${daySchedule.frühAbsence}/${daySchedule.spätAbsence}`;
  } else if (daySchedule.frühAbsence) {
    return daySchedule.spät 
      ? `${daySchedule.frühAbsence}/${formatTimeSlot(daySchedule.spät)}` 
      : daySchedule.frühAbsence;
  } else if (daySchedule.spätAbsence) {
    return daySchedule.früh 
      ? `${formatTimeSlot(daySchedule.früh)}/${daySchedule.spätAbsence}` 
      : daySchedule.spätAbsence;
  } else if (daySchedule.früh || daySchedule.spät) {
    const parts: string[] = [];
    if (daySchedule.früh) parts.push(formatTimeSlot(daySchedule.früh));
    if (daySchedule.spät) parts.push(formatTimeSlot(daySchedule.spät));
    return parts.join(' / ');
  }
  return '';
}

// =============================================
// EXCEL EXPORT - Matching ScheduleGrid View
// =============================================

export async function exportScheduleToExcelPrint(options: PrintExportOptions): Promise<void> {
  const { 
    employees, 
    scheduleData, 
    actualHoursData,
    currentMonth, 
    days, 
    hoursType, 
    includeCosts,
    isWeekExport,
    rates
  } = options;

  const shifts = getShiftConfig();
  const shiftMap = getShiftConfigMap();
  const absenceShifts = shifts.filter(s => !s.start || !s.end);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Dienstplan-App';
  workbook.created = new Date();

  const sortByEmployeeId = (a: Employee, b: Employee) => parseInt(a.id) - parseInt(b.id);
  const serviceEmployees = employees.filter(e => e.department === 'service').sort(sortByEmployeeId);
  const kücheEmployees = employees.filter(e => e.department === 'küche').sort(sortByEmployeeId);

  // Calculate employee stats for a specific set of days
  const getEmployeeStats = (emp: Employee, targetDays: Date[]) => {
    let planHours = 0;
    let istHours = 0;
    
    targetDays.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const cellKey = `${emp.id}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];
      const actualEntry = actualHoursData[cellKey];
      
      if (daySchedule) {
        planHours += workedNetHours(daySchedule);
        
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
      
      if (actualEntry?.hours) {
        istHours += actualEntry.hours;
      }
    });
    
    const targetHours = emp.weeklyHours 
      ? (isWeekExport ? emp.weeklyHours : emp.weeklyHours * 4.33) 
      : (isWeekExport ? 42 : 42 * 4.33);
    
    const planCost = planHours * (getEffectiveHourlyRate(emp, rates) ?? 0);
    const istCost = istHours * (getEffectiveHourlyRate(emp, rates) ?? 0);
    
    return { planHours, istHours, targetHours, planCost, istCost };
  };

  // Get daily totals for a department
  const getDailyTotals = (day: Date, deptEmployees: Employee[]) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    let planHours = 0;
    let istHours = 0;
    let planCost = 0;
    let istCost = 0;

    deptEmployees.forEach(emp => {
      const cellKey = `${emp.id}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];
      const actualEntry = actualHoursData[cellKey];

      if (daySchedule) {
        const dayPlanHours = workedNetHours(daySchedule);
        planHours += dayPlanHours;
        planCost += dayPlanHours * (getEffectiveHourlyRate(emp, rates) ?? 0);
      }
      
      if (actualEntry?.hours) {
        istHours += actualEntry.hours;
        istCost += actualEntry.hours * (getEffectiveHourlyRate(emp, rates) ?? 0);
      }
    });

    return { planHours, istHours, planCost, istCost };
  };

  const createSheet = (deptEmployees: Employee[], deptName: string) => {
    const sheet = workbook.addWorksheet(deptName);
    
    // Determine columns based on hoursType
    const showPlan = hoursType === 'plan' || hoursType === 'both';
    const showIst = hoursType === 'ist' || hoursType === 'both';
    const colsPerDay = showPlan && showIst ? 2 : 1;
    
    // Column widths
    sheet.getColumn(1).width = 16; // Name
    for (let i = 0; i < days.length * colsPerDay; i++) {
      sheet.getColumn(2 + i).width = colsPerDay === 2 ? 8 : 12;
    }
    
    // Summary columns
    const summaryStartCol = 2 + days.length * colsPerDay;
    if (showPlan) {
      sheet.getColumn(summaryStartCol).width = 8;      // Plan Std
    }
    if (showIst) {
      sheet.getColumn(summaryStartCol + (showPlan ? 1 : 0)).width = 8; // Ist Std
    }
    if (showPlan && showIst) {
      sheet.getColumn(summaryStartCol + 2).width = 7;  // Diff
    }
    sheet.getColumn(summaryStartCol + (showPlan && showIst ? 3 : (showPlan || showIst ? 1 : 0))).width = 7; // Soll
    if (includeCosts) {
      const costStartCol = summaryStartCol + (showPlan && showIst ? 4 : 2);
      if (showPlan) sheet.getColumn(costStartCol).width = 10;
      if (showIst) sheet.getColumn(costStartCol + (showPlan ? 1 : 0)).width = 10;
    }
    
    // Period label
    const periodLabel = isWeekExport
      ? `KW ${getISOWeek(days[0])} (${format(days[0], 'dd.MM.', { locale: de })} - ${format(days[days.length - 1], 'dd.MM.yyyy', { locale: de })})`
      : format(currentMonth, 'MMMM yyyy', { locale: de });
    
    // Row 1: Title with department and period
    const hoursLabel = hoursType === 'ist' ? ' (Ist-Stunden)' : hoursType === 'both' ? ' (Plan + Ist)' : '';
    const titleRow = sheet.addRow([`Dienstplan ${deptName}${hoursLabel} - ${periodLabel}`]);
    titleRow.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    titleRow.height = 28;
    titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    const totalCols = summaryStartCol + 10; // Approximate
    sheet.mergeCells(1, 1, 1, totalCols);
    titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };

    // Row 2: Empty
    sheet.addRow([]);

    // Row 3: Legend
    const legendRow = sheet.addRow(['Legende:']);
    legendRow.getCell(1).font = { bold: true, size: 9 };
    let legendCol = 2;
    absenceShifts.forEach((shift) => {
      const cell = sheet.getCell(3, legendCol);
      cell.value = `${shift.abbrev} = ${shift.name}`;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: shift.excelColor } };
      cell.font = { size: 8, color: { argb: shift.textColor }, bold: true };
      cell.alignment = { horizontal: 'center' };
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
      legendCol++;
    });

    // Row 4: Empty
    sheet.addRow([]);

    // Row 5: Date headers
    const dateHeaders: string[] = ['Mitarbeiter'];
    days.forEach(d => {
      const weekday = WEEKDAY_NAMES_SHORT[d.getDay()];
      const dateLabel = `${weekday} ${format(d, 'd.', { locale: de })}`;
      if (colsPerDay === 2) {
        dateHeaders.push(`${dateLabel} P`, `${dateLabel} I`); // Plan / Ist
      } else {
        dateHeaders.push(dateLabel);
      }
    });
    
    // Summary headers
    if (showPlan) dateHeaders.push('Plan');
    if (showIst) dateHeaders.push('Ist');
    if (showPlan && showIst) dateHeaders.push('+/-');
    dateHeaders.push('Soll');
    if (includeCosts) {
      if (showPlan) dateHeaders.push('Plan CHF');
      if (showIst) dateHeaders.push('Ist CHF');
    }

    const headerRow = sheet.addRow(dateHeaders);
    headerRow.height = 22;
    headerRow.eachCell((cell, colNumber) => {
      cell.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
      
      // Weekend coloring
      if (colNumber > 1 && colNumber <= days.length * colsPerDay + 1) {
        const dayIdx = Math.floor((colNumber - 2) / colsPerDay);
        const day = days[dayIdx];
        if (day && (day.getDay() === 0 || day.getDay() === 6)) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD97706' } };
        }
      }
    });

    // Employee data rows
    deptEmployees.forEach((emp, empIdx) => {
      const rowData: (string | number)[] = [emp.name];
      
      days.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const cellKey = `${emp.id}-${dateStr}`;
        const daySchedule = scheduleData[cellKey];
        const actualEntry = actualHoursData[cellKey];
        
        if (colsPerDay === 2) {
          // Plan column
          rowData.push(formatCellContent(daySchedule) || '');
          // Ist column
          rowData.push(actualEntry?.hours ? actualEntry.hours.toFixed(1) : '');
        } else {
          if (hoursType === 'ist') {
            rowData.push(actualEntry?.hours ? actualEntry.hours.toFixed(1) : '');
          } else {
            rowData.push(formatCellContent(daySchedule) || '');
          }
        }
      });
      
      // Summary columns
      const stats = getEmployeeStats(emp, days);
      if (showPlan) rowData.push(stats.planHours.toFixed(1));
      if (showIst) rowData.push(stats.istHours.toFixed(1));
      if (showPlan && showIst) {
        const diff = stats.istHours - stats.planHours;
        rowData.push(diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1));
      }
      rowData.push(stats.targetHours.toFixed(0));
      if (includeCosts) {
        if (showPlan) rowData.push(stats.planCost.toFixed(0));
        if (showIst) rowData.push(stats.istCost.toFixed(0));
      }

      const row = sheet.addRow(rowData);
      row.height = 24;

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
      row.getCell(1).font = { size: 10, bold: true };
      row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };

      // Style day cells based on content
      days.forEach((day, dayIdx) => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const cellKey = `${emp.id}-${dateStr}`;
        const daySchedule = scheduleData[cellKey];

        const planColIdx = 2 + dayIdx * colsPerDay;
        const planCell = row.getCell(planColIdx);

        // Style plan cell
        if (colsPerDay === 2 || hoursType !== 'ist') {
          if (daySchedule?.frühAbsence || daySchedule?.spätAbsence) {
            const abbrev = daySchedule.frühAbsence || daySchedule.spätAbsence;
            const shift = absenceShifts.find(s => s.abbrev === abbrev);
            if (shift) {
              planCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: shift.excelColor } };
              planCell.font = { color: { argb: shift.textColor }, bold: true, size: 9 };
            }
          } else if (daySchedule?.früh || daySchedule?.spät) {
            planCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
            planCell.font = { color: { argb: 'FF1E40AF' }, size: 9 };
          } else if (day.getDay() === 0 || day.getDay() === 6) {
            planCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
          }
        }

        // Style ist cell (green tint for actual hours)
        if (colsPerDay === 2) {
          const istCell = row.getCell(planColIdx + 1);
          const actualEntry = actualHoursData[cellKey];
          if (actualEntry?.hours) {
            istCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
            istCell.font = { color: { argb: 'FF15803D' }, size: 9 };
          } else if (day.getDay() === 0 || day.getDay() === 6) {
            istCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
          }
        }
      });

      // Style diff column
      if (showPlan && showIst) {
        const diffColIdx = summaryStartCol + 2;
        const diffCell = row.getCell(diffColIdx);
        const diff = stats.istHours - stats.planHours;
        if (diff >= -2 && diff <= 2) {
          diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
          diffCell.font = { color: { argb: 'FF15803D' }, bold: true, size: 9 };
        } else if (diff < 0) {
          diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
          diffCell.font = { color: { argb: 'FFDC2626' }, bold: true, size: 9 };
        } else {
          diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
          diffCell.font = { color: { argb: 'FF92400E' }, bold: true, size: 9 };
        }
      }
    });

    // Separator row
    sheet.addRow([]);

    // Summary footer row
    const summaryData: (string | number)[] = ['SUMME'];
    let totalPlanHours = 0;
    let totalIstHours = 0;
    let totalPlanCost = 0;
    let totalIstCost = 0;

    days.forEach(day => {
      const stats = getDailyTotals(day, deptEmployees);
      totalPlanHours += stats.planHours;
      totalIstHours += stats.istHours;
      totalPlanCost += stats.planCost;
      totalIstCost += stats.istCost;

      if (colsPerDay === 2) {
        summaryData.push(`${stats.planHours.toFixed(1)}h`);
        summaryData.push(`${stats.istHours.toFixed(1)}h`);
      } else {
        const value = hoursType === 'ist' ? stats.istHours : stats.planHours;
        summaryData.push(`${value.toFixed(1)}h`);
      }
    });

    if (showPlan) summaryData.push(totalPlanHours.toFixed(1));
    if (showIst) summaryData.push(totalIstHours.toFixed(1));
    if (showPlan && showIst) {
      const diff = totalIstHours - totalPlanHours;
      summaryData.push(diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1));
    }
    summaryData.push('');
    if (includeCosts) {
      if (showPlan) summaryData.push(totalPlanCost.toFixed(0));
      if (showIst) summaryData.push(totalIstCost.toFixed(0));
    }

    const summaryRow = sheet.addRow(summaryData);
    summaryRow.height = 24;
    summaryRow.eachCell((cell) => {
      cell.font = { bold: true, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { top: { style: 'medium' }, bottom: { style: 'thin' } };
    });
    summaryRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };

    // Cost summary row if costs enabled
    if (includeCosts) {
      const costData: (string | number)[] = ['KOSTEN'];
      days.forEach(day => {
        const stats = getDailyTotals(day, deptEmployees);
        if (colsPerDay === 2) {
          costData.push(`${stats.planCost.toFixed(0)}€`);
          costData.push(`${stats.istCost.toFixed(0)}€`);
        } else {
          const value = hoursType === 'ist' ? stats.istCost : stats.planCost;
          costData.push(`${value.toFixed(0)}€`);
        }
      });
      if (showPlan) costData.push(totalPlanCost.toFixed(0));
      if (showIst) costData.push(totalIstCost.toFixed(0));
      if (showPlan && showIst) {
        const diff = totalIstCost - totalPlanCost;
        costData.push(diff >= 0 ? `+${diff.toFixed(0)}` : diff.toFixed(0));
      }
      costData.push('');
      if (showPlan) costData.push(`${totalPlanCost.toFixed(0)} CHF`);
      if (showIst) costData.push(`${totalIstCost.toFixed(0)} CHF`);

      const costRow = sheet.addRow(costData);
      costRow.height = 22;
      costRow.eachCell((cell, colNum) => {
        cell.font = { bold: true, size: 9 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        
        // Color cost difference
        if (showPlan && showIst && colNum === summaryStartCol + 2) {
          const diff = totalIstCost - totalPlanCost;
          if (diff > 0) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
            cell.font = { bold: true, size: 9, color: { argb: 'FFDC2626' } };
          } else if (diff < 0) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
            cell.font = { bold: true, size: 9, color: { argb: 'FF16A34A' } };
          }
        }
      });
      costRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
    }

    // Print settings - optimized for A4 landscape
    sheet.pageSetup = {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9, // A4
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
    };

    // Header/Footer for printing
    sheet.headerFooter.oddHeader = `&C&B${deptName} - ${periodLabel}`;
    sheet.headerFooter.oddFooter = '&LSeite &P von &N&RGedruckt: &D';

    // Freeze panes
    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 5 }];
  };

  // Create department sheets
  if (serviceEmployees.length > 0) {
    createSheet(serviceEmployees, 'Service');
  }
  if (kücheEmployees.length > 0) {
    createSheet(kücheEmployees, 'Küche');
  }

  // Create summary sheet
  createSummarySheet(workbook, serviceEmployees, kücheEmployees, options);

  // Download
  const hoursLabel = hoursType === 'ist' ? '_Ist' : hoursType === 'both' ? '_Plan-Ist' : '';
  const periodLabel = isWeekExport 
    ? `KW${getISOWeek(days[0])}_${format(currentMonth, 'yyyy', { locale: de })}`
    : format(currentMonth, 'MMMM_yyyy', { locale: de });
  const fileName = `Dienstplan_${periodLabel}${hoursLabel}.xlsx`;
  
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

function createSummarySheet(
  workbook: ExcelJS.Workbook, 
  serviceEmployees: Employee[], 
  kücheEmployees: Employee[],
  options: PrintExportOptions
) {
  const { scheduleData, actualHoursData, currentMonth, days, hoursType, includeCosts, isWeekExport, rates } = options;
  const sheet = workbook.addWorksheet('Zusammenfassung');

  const showPlan = hoursType === 'plan' || hoursType === 'both';
  const showIst = hoursType === 'ist' || hoursType === 'both';

  const shifts = getShiftConfig();
  const shiftMap = getShiftConfigMap();
  const absenceShifts = shifts.filter(s => !s.start || !s.end);

  // Helper function
  const getEmployeeTotals = (emp: Employee) => {
    let planHours = 0;
    let istHours = 0;
    
    days.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const cellKey = `${emp.id}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];
      const actualEntry = actualHoursData[cellKey];
      
      if (daySchedule) {
        planHours += workedNetHours(daySchedule);
        
        if (daySchedule.frühAbsence) {
          const shift = absenceShifts.find(s => s.abbrev === daySchedule.frühAbsence);
          if (shift && shiftMap[shift.name]?.countsToTarget) planHours += shift.hours;
        }
        if (daySchedule.spätAbsence && daySchedule.spätAbsence !== daySchedule.frühAbsence) {
          const shift = absenceShifts.find(s => s.abbrev === daySchedule.spätAbsence);
          if (shift && shiftMap[shift.name]?.countsToTarget) planHours += shift.hours;
        }
      }
      
      if (actualEntry?.hours) istHours += actualEntry.hours;
    });
    
    const targetHours = emp.weeklyHours 
      ? (isWeekExport ? emp.weeklyHours : emp.weeklyHours * 4.33)
      : (isWeekExport ? 42 : 42 * 4.33);
    
    return {
      planHours,
      istHours,
      targetHours,
      planCost: planHours * (getEffectiveHourlyRate(emp, rates) ?? 0),
      istCost: istHours * (getEffectiveHourlyRate(emp, rates) ?? 0),
      diff: istHours - planHours,
      saldo: (showIst ? istHours : planHours) - targetHours
    };
  };

  // Column widths
  sheet.getColumn(1).width = 18;
  sheet.getColumn(2).width = 12;
  sheet.getColumn(3).width = 12;
  sheet.getColumn(4).width = 10;
  sheet.getColumn(5).width = 10;
  sheet.getColumn(6).width = 12;
  sheet.getColumn(7).width = 12;

  const periodLabel = isWeekExport
    ? `KW ${getISOWeek(days[0])} (${format(days[0], 'dd.MM.', { locale: de })} - ${format(days[days.length - 1], 'dd.MM.yyyy', { locale: de })})`
    : format(currentMonth, 'MMMM yyyy', { locale: de });

  // Title
  const titleRow = sheet.addRow(['Zusammenfassung - ' + periodLabel]);
  titleRow.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  titleRow.height = 28;
  titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  sheet.mergeCells(1, 1, 1, 7);
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };

  sheet.addRow([]);

  // Build headers based on options
  const headers = ['Mitarbeiter'];
  if (showPlan) headers.push('Plan Std.');
  if (showIst) headers.push('Ist Std.');
  headers.push('Soll', 'Saldo');
  if (includeCosts) {
    if (showPlan) headers.push('Plan CHF');
    if (showIst) headers.push('Ist CHF');
  }

  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { bottom: { style: 'medium' } };
  });

  // Service section
  const serviceLabel = sheet.addRow(['SERVICE']);
  serviceLabel.font = { bold: true, size: 11 };
  serviceLabel.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
  serviceLabel.getCell(1).font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  sheet.mergeCells(serviceLabel.number, 1, serviceLabel.number, headers.length);

  let serviceTotalPlan = 0, serviceTotalIst = 0, serviceTotalPlanCost = 0, serviceTotalIstCost = 0;

  serviceEmployees.forEach(emp => {
    const stats = getEmployeeTotals(emp);
    serviceTotalPlan += stats.planHours;
    serviceTotalIst += stats.istHours;
    serviceTotalPlanCost += stats.planCost;
    serviceTotalIstCost += stats.istCost;

    const rowData: (string | number)[] = [emp.name];
    if (showPlan) rowData.push(stats.planHours.toFixed(1));
    if (showIst) rowData.push(stats.istHours.toFixed(1));
    rowData.push(stats.targetHours.toFixed(0));
    rowData.push(stats.saldo >= 0 ? `+${stats.saldo.toFixed(1)}` : stats.saldo.toFixed(1));
    if (includeCosts) {
      if (showPlan) rowData.push(stats.planCost.toFixed(0));
      if (showIst) rowData.push(stats.istCost.toFixed(0));
    }

    const row = sheet.addRow(rowData);
    
    // Style saldo cell
    const saldoColIdx = 2 + (showPlan ? 1 : 0) + (showIst ? 1 : 0) + 1;
    const saldoCell = row.getCell(saldoColIdx);
    if (stats.saldo >= 0) {
      saldoCell.font = { color: { argb: 'FF16A34A' } };
    } else {
      saldoCell.font = { color: { argb: 'FFDC2626' } };
    }
  });

  // Service subtotal
  const serviceSubtotal: (string | number)[] = ['Service Gesamt'];
  if (showPlan) serviceSubtotal.push(serviceTotalPlan.toFixed(1));
  if (showIst) serviceSubtotal.push(serviceTotalIst.toFixed(1));
  serviceSubtotal.push('', '');
  if (includeCosts) {
    if (showPlan) serviceSubtotal.push(serviceTotalPlanCost.toFixed(0));
    if (showIst) serviceSubtotal.push(serviceTotalIstCost.toFixed(0));
  }
  const serviceTotalRow = sheet.addRow(serviceSubtotal);
  serviceTotalRow.font = { bold: true };
  serviceTotalRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
  });

  sheet.addRow([]);

  // Küche section
  const kuecheLabel = sheet.addRow(['KÜCHE']);
  kuecheLabel.font = { bold: true, size: 11 };
  kuecheLabel.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } };
  kuecheLabel.getCell(1).font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  sheet.mergeCells(kuecheLabel.number, 1, kuecheLabel.number, headers.length);

  let kuecheTotalPlan = 0, kuecheTotalIst = 0, kuecheTotalPlanCost = 0, kuecheTotalIstCost = 0;

  kücheEmployees.forEach(emp => {
    const stats = getEmployeeTotals(emp);
    kuecheTotalPlan += stats.planHours;
    kuecheTotalIst += stats.istHours;
    kuecheTotalPlanCost += stats.planCost;
    kuecheTotalIstCost += stats.istCost;

    const rowData: (string | number)[] = [emp.name];
    if (showPlan) rowData.push(stats.planHours.toFixed(1));
    if (showIst) rowData.push(stats.istHours.toFixed(1));
    rowData.push(stats.targetHours.toFixed(0));
    rowData.push(stats.saldo >= 0 ? `+${stats.saldo.toFixed(1)}` : stats.saldo.toFixed(1));
    if (includeCosts) {
      if (showPlan) rowData.push(stats.planCost.toFixed(0));
      if (showIst) rowData.push(stats.istCost.toFixed(0));
    }

    const row = sheet.addRow(rowData);
    
    const saldoColIdx = 2 + (showPlan ? 1 : 0) + (showIst ? 1 : 0) + 1;
    const saldoCell = row.getCell(saldoColIdx);
    if (stats.saldo >= 0) {
      saldoCell.font = { color: { argb: 'FF16A34A' } };
    } else {
      saldoCell.font = { color: { argb: 'FFDC2626' } };
    }
  });

  // Küche subtotal
  const kuecheSubtotal: (string | number)[] = ['Küche Gesamt'];
  if (showPlan) kuecheSubtotal.push(kuecheTotalPlan.toFixed(1));
  if (showIst) kuecheSubtotal.push(kuecheTotalIst.toFixed(1));
  kuecheSubtotal.push('', '');
  if (includeCosts) {
    if (showPlan) kuecheSubtotal.push(kuecheTotalPlanCost.toFixed(0));
    if (showIst) kuecheSubtotal.push(kuecheTotalIstCost.toFixed(0));
  }
  const kuecheTotalRow = sheet.addRow(kuecheSubtotal);
  kuecheTotalRow.font = { bold: true };
  kuecheTotalRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
  });

  sheet.addRow([]);

  // Grand total
  const grandTotal: (string | number)[] = ['GESAMT'];
  if (showPlan) grandTotal.push((serviceTotalPlan + kuecheTotalPlan).toFixed(1));
  if (showIst) grandTotal.push((serviceTotalIst + kuecheTotalIst).toFixed(1));
  grandTotal.push('', '');
  if (includeCosts) {
    if (showPlan) grandTotal.push((serviceTotalPlanCost + kuecheTotalPlanCost).toFixed(0));
    if (showIst) grandTotal.push((serviceTotalIstCost + kuecheTotalIstCost).toFixed(0));
  }
  const grandTotalRow = sheet.addRow(grandTotal);
  grandTotalRow.font = { bold: true, size: 12 };
  grandTotalRow.height = 26;
  grandTotalRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    cell.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    cell.border = { top: { style: 'medium' }, bottom: { style: 'medium' } };
  });

  // Print settings
  sheet.pageSetup = {
    orientation: 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 1,
    paperSize: 9
  };
}

// =============================================
// PDF EXPORT - Print Optimized
// =============================================

export async function exportScheduleToPDFPrint(options: PrintExportOptions): Promise<void> {
  const { 
    employees, 
    scheduleData, 
    actualHoursData,
    currentMonth, 
    days, 
    hoursType, 
    includeCosts,
    isWeekExport,
    rates
  } = options;

  const shifts = getShiftConfig();
  const shiftMap = getShiftConfigMap();
  const absenceShifts = shifts.filter(s => !s.start || !s.end);

  const sortByEmployeeId = (a: Employee, b: Employee) => parseInt(a.id) - parseInt(b.id);
  const serviceEmployees = employees.filter(e => e.department === 'service').sort(sortByEmployeeId);
  const kücheEmployees = employees.filter(e => e.department === 'küche').sort(sortByEmployeeId);

  const showPlan = hoursType === 'plan' || hoursType === 'both';
  const showIst = hoursType === 'ist' || hoursType === 'both';

  const periodLabel = isWeekExport
    ? `KW ${getISOWeek(days[0])} (${format(days[0], 'dd.MM.', { locale: de })} - ${format(days[days.length - 1], 'dd.MM.yyyy', { locale: de })})`
    : format(currentMonth, 'MMMM yyyy', { locale: de });

  const pdf = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();

  const getEmployeeStats = (emp: Employee) => {
    let planHours = 0;
    let istHours = 0;
    
    days.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const cellKey = `${emp.id}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];
      const actualEntry = actualHoursData[cellKey];
      
      if (daySchedule) {
        planHours += workedNetHours(daySchedule);
        if (daySchedule.frühAbsence) {
          const shift = absenceShifts.find(s => s.abbrev === daySchedule.frühAbsence);
          if (shift && shiftMap[shift.name]?.countsToTarget) planHours += shift.hours;
        }
        if (daySchedule.spätAbsence && daySchedule.spätAbsence !== daySchedule.frühAbsence) {
          const shift = absenceShifts.find(s => s.abbrev === daySchedule.spätAbsence);
          if (shift && shiftMap[shift.name]?.countsToTarget) planHours += shift.hours;
        }
      }
      if (actualEntry?.hours) istHours += actualEntry.hours;
    });
    
    return {
      planHours,
      istHours,
      planCost: planHours * (getEffectiveHourlyRate(emp, rates) ?? 0),
      istCost: istHours * (getEffectiveHourlyRate(emp, rates) ?? 0)
    };
  };

  const getDailyTotals = (day: Date, deptEmployees: Employee[]) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    let planHours = 0;
    let istHours = 0;
    let planCost = 0;
    let istCost = 0;

    deptEmployees.forEach(emp => {
      const cellKey = `${emp.id}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];
      const actualEntry = actualHoursData[cellKey];

      if (daySchedule) {
        const dayPlanHours = workedNetHours(daySchedule);
        planHours += dayPlanHours;
        planCost += dayPlanHours * (getEffectiveHourlyRate(emp, rates) ?? 0);
      }
      if (actualEntry?.hours) {
        istHours += actualEntry.hours;
        istCost += actualEntry.hours * (getEffectiveHourlyRate(emp, rates) ?? 0);
      }
    });

    return { planHours, istHours, planCost, istCost };
  };

  const createDepartmentPage = (deptEmployees: Employee[], deptName: string, isFirstPage: boolean) => {
    if (!isFirstPage) pdf.addPage();

    // Header with sage green accent
    pdf.setFillColor(30, 58, 95);
    pdf.rect(0, 0, pageWidth, 16, 'F');
    
    // Title
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    const hoursLabel = hoursType === 'ist' ? ' (Ist-Stunden)' : hoursType === 'both' ? ' (Plan + Ist)' : '';
    pdf.text(`Dienstplan ${deptName}${hoursLabel}`, 10, 10);
    
    // Period
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    pdf.text(periodLabel, pageWidth - 10, 10, { align: 'right' });
    
    // Reset color
    pdf.setTextColor(0, 0, 0);

    // Legend
    pdf.setFontSize(7);
    let legendX = 10;
    pdf.text('Legende:', legendX, 22);
    legendX += 12;
    absenceShifts.forEach((shift) => {
      pdf.text(`${shift.abbrev} = ${shift.name}`, legendX, 22);
      legendX += 22;
    });

    // Table headers
    const headers: string[] = ['Name'];
    days.forEach(d => {
      const weekday = WEEKDAY_NAMES_SHORT[d.getDay()];
      headers.push(`${weekday} ${d.getDate()}.`);
    });
    if (showPlan) headers.push('Plan');
    if (showIst) headers.push('Ist');
    if (showPlan && showIst) headers.push('Diff');
    if (includeCosts) {
      headers.push('CHF');
    }

    // Table body
    const body: (string | number)[][] = [];
    
    deptEmployees.forEach((emp) => {
      const rowData: (string | number)[] = [emp.name];
      
      days.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const cellKey = `${emp.id}-${dateStr}`;
        const daySchedule = scheduleData[cellKey];
        const actualEntry = actualHoursData[cellKey];
        
        if (hoursType === 'both') {
          const planContent = formatCellContent(daySchedule) || '-';
          const istContent = actualEntry?.hours ? actualEntry.hours.toFixed(1) : '-';
          rowData.push(`${planContent} / ${istContent}`);
        } else if (hoursType === 'ist') {
          rowData.push(actualEntry?.hours ? actualEntry.hours.toFixed(1) : '');
        } else {
          rowData.push(formatCellContent(daySchedule) || '');
        }
      });

      const stats = getEmployeeStats(emp);
      if (showPlan) rowData.push(stats.planHours.toFixed(1));
      if (showIst) rowData.push(stats.istHours.toFixed(1));
      if (showPlan && showIst) {
        const diff = stats.istHours - stats.planHours;
        rowData.push(diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1));
      }
      if (includeCosts) {
        const cost = hoursType === 'ist' ? stats.istCost : stats.planCost;
        rowData.push(`${cost.toFixed(0)}€`);
      }

      body.push(rowData);
    });

    // Summary row
    const summaryRow: (string | number)[] = ['SUMME'];
    let totalPlanHours = 0;
    let totalIstHours = 0;
    let totalCost = 0;

    days.forEach(day => {
      const stats = getDailyTotals(day, deptEmployees);
      totalPlanHours += stats.planHours;
      totalIstHours += stats.istHours;
      
      if (hoursType === 'both') {
        summaryRow.push(`${stats.planHours.toFixed(0)}/${stats.istHours.toFixed(0)}`);
      } else if (hoursType === 'ist') {
        summaryRow.push(`${stats.istHours.toFixed(0)}h`);
      } else {
        summaryRow.push(`${stats.planHours.toFixed(0)}h`);
      }
    });

    if (showPlan) summaryRow.push(totalPlanHours.toFixed(0));
    if (showIst) summaryRow.push(totalIstHours.toFixed(0));
    if (showPlan && showIst) {
      const diff = totalIstHours - totalPlanHours;
      summaryRow.push(diff >= 0 ? `+${diff.toFixed(0)}` : diff.toFixed(0));
    }
    
    deptEmployees.forEach(emp => {
      const stats = getEmployeeStats(emp);
      totalCost += hoursType === 'ist' ? stats.istCost : stats.planCost;
    });
    if (includeCosts) summaryRow.push(`${totalCost.toFixed(0)}€`);
    
    body.push(summaryRow);

    // Calculate column widths
    const nameColWidth = 25;
    const summaryColCount = (showPlan ? 1 : 0) + (showIst ? 1 : 0) + (showPlan && showIst ? 1 : 0) + (includeCosts ? 1 : 0);
    const summaryColWidth = 11;
    const availableWidth = pageWidth - 20 - nameColWidth - (summaryColWidth * summaryColCount);
    const dayColWidth = availableWidth / days.length;

    const columnStyles: Record<number, { cellWidth: number; halign?: 'left' | 'center' | 'right' }> = {
      0: { cellWidth: nameColWidth, halign: 'left' }
    };
    for (let i = 1; i <= days.length; i++) {
      columnStyles[i] = { cellWidth: dayColWidth, halign: 'center' };
    }
    for (let i = 0; i < summaryColCount; i++) {
      columnStyles[days.length + 1 + i] = { cellWidth: summaryColWidth, halign: 'center' };
    }

    autoTable(pdf, {
      head: [headers],
      body: body,
      startY: 26,
      theme: 'grid',
      styles: {
        fontSize: hoursType === 'both' ? 5 : 6,
        cellPadding: 1.5,
        lineWidth: 0.1,
        lineColor: [200, 200, 200],
        overflow: 'linebreak'
      },
      headStyles: {
        fillColor: [30, 64, 138],
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
          if (rowIndex % 2 === 1) {
            data.cell.styles.fillColor = [249, 250, 251];
          }

          // Day cell styling
          if (colIndex > 0 && colIndex <= days.length) {
            const emp = deptEmployees[rowIndex];
            const day = days[colIndex - 1];
            const dateStr = format(day, 'yyyy-MM-dd');
            const cellKey = `${emp.id}-${dateStr}`;
            const daySchedule = scheduleData[cellKey];
            const actualEntry = actualHoursData[cellKey];

            if (daySchedule?.frühAbsence || daySchedule?.spätAbsence) {
              data.cell.styles.fillColor = [254, 243, 199];
              data.cell.styles.fontStyle = 'bold';
            } else if (daySchedule?.früh || daySchedule?.spät) {
              data.cell.styles.fillColor = [219, 234, 254];
              data.cell.styles.textColor = [30, 64, 175];
            } else if (actualEntry?.hours && hoursType === 'ist') {
              data.cell.styles.fillColor = [220, 252, 231];
              data.cell.styles.textColor = [21, 128, 61];
            } else if (day.getDay() === 0 || day.getDay() === 6) {
              data.cell.styles.fillColor = [254, 243, 199];
            }
          }
        }

        // Summary row styling
        if (data.section === 'body' && rowIndex >= deptEmployees.length) {
          data.cell.styles.fillColor = [229, 231, 235];
          data.cell.styles.fontStyle = 'bold';
        }
      }
    });

    // Footer
    pdf.setFontSize(7);
    pdf.setTextColor(128, 128, 128);
    const footerY = pageHeight - 8;
    pdf.text(`Gedruckt: ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`, 10, footerY);
    pdf.text(`Seite ${pdf.getNumberOfPages()}`, pageWidth - 10, footerY, { align: 'right' });
  };

  // Create pages
  let isFirst = true;
  if (serviceEmployees.length > 0) {
    createDepartmentPage(serviceEmployees, 'Service', isFirst);
    isFirst = false;
  }
  if (kücheEmployees.length > 0) {
    createDepartmentPage(kücheEmployees, 'Küche', isFirst);
  }

  // Save
  const hoursLabel = hoursType === 'ist' ? '_Ist' : hoursType === 'both' ? '_Plan-Ist' : '';
  const fileName = isWeekExport 
    ? `Dienstplan_KW${getISOWeek(days[0])}_${format(currentMonth, 'yyyy', { locale: de })}${hoursLabel}.pdf`
    : `Dienstplan_${format(currentMonth, 'MMMM_yyyy', { locale: de })}${hoursLabel}.pdf`;
  
  pdf.save(fileName);
}
