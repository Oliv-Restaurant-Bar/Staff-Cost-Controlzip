import * as XLSX from 'xlsx';
import * as ExcelJS from 'exceljs';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Employee } from '@/types/personnel';

import { format, eachWeekOfInterval, startOfMonth, endOfMonth, endOfWeek, eachDayOfInterval, isWithinInterval, getISOWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { getShiftConfig, getShiftConfigMap } from '@/hooks/useShiftConfig';
import { DaySchedule, TimeSlot } from '@/components/schedule-planner/ScheduleGrid';
import { getBranding, renderLogoDataUrl } from '@/lib/pl-branding';

/**
 * Normalisiert einen roh importierten Namen auf Title-Case.
 * Verhindert, dass ALL-CAPS oder all-lowercase Namen aus Importdateien
 * unverändert in den Personalstamm übernommen werden.
 * Beispiel: "SAJED MOMAND" → "Sajed Momand", "sadete ramadani" → "Sadete Ramadani"
 */
function normalizeImportedName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

interface ExportOptionsV2 {
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  currentMonth: Date;
  department?: 'service' | 'küche' | 'all';
  dailyBudgets?: Record<string, { plannedRevenue?: number; actualRevenue?: number }>;
  showCosts?: boolean;
  includeWeeklyPages?: boolean;
  specificDays?: Date[];
  employeeFriendly?: boolean;
  /** Optionaler Restaurantname für Dateinamen (Mandantenfähigkeit) */
  restaurantName?: string;
  /** Exporttyp: Aushang (kein Lohn/Kosten) oder Leitungsplan (mit Stunden/Saldo) */
  exportType?: 'aushang' | 'leitungsplan';
  /** Std-Spalte pro Mitarbeiter anzeigen (Standard: EIN für Leitungsplan, AUS für Aushang) */
  showEmpHours?: boolean;
  /** Tagesstunden-Zeile unten anzeigen (Standard: EIN für Leitungsplan, AUS für Aushang) */
  showDayTotals?: boolean;
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

function buildCompactLegendLine(
  pdf: jsPDF,
  allShifts: ReturnType<typeof getShiftConfig>,
  pageWidth: number,
  y: number
): void {
  pdf.setFontSize(6.5);
  pdf.setFont('helvetica', 'normal');

  const workShifts = allShifts.filter(s => s.start && s.end && s.abbrev);
  const absShifts = allShifts.filter(s => (!s.start || !s.end) && s.abbrev);

  let legendX = 10;
  const maxX = pageWidth - 15;

  if (workShifts.length > 0) {
    pdf.setTextColor(30, 64, 175);
    pdf.text('Schichten:', legendX, y);
    pdf.setTextColor(0, 0, 0);
    legendX += 18;
    for (const s of workShifts) {
      const timeStr = `${s.start!.replace(':00', '')}–${s.end!.replace(':00', '')}`;
      const label = `${s.abbrev}=${s.name}(${timeStr})`;
      if (legendX + label.length * 1.6 > maxX) break;
      pdf.text(label, legendX, y);
      legendX += label.length * 1.6 + 3;
    }
    legendX += 4;
  }

  if (absShifts.length > 0 && legendX < maxX) {
    pdf.setTextColor(120, 53, 15);
    pdf.text('Abwesenheiten:', legendX, y);
    pdf.setTextColor(0, 0, 0);
    legendX += 26;
    for (const s of absShifts) {
      const label = `${s.abbrev}=${s.name}`;
      if (legendX + label.length * 1.6 > maxX) break;
      pdf.text(label, legendX, y);
      legendX += label.length * 1.6 + 3;
    }
  }

  pdf.setTextColor(0, 0, 0);
}

function addLegendPage(
  pdf: jsPDF,
  allShifts: ReturnType<typeof getShiftConfig>,
  shiftMap: ReturnType<typeof getShiftConfigMap>,
  monthName: string
): void {
  pdf.addPage();
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();

  pdf.setFillColor(30, 64, 175);
  pdf.rect(0, 0, pageWidth, 22, 'F');
  pdf.setFontSize(15);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(255, 255, 255);
  pdf.text('Legende – Schichtkonfiguration', 10, 14);
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'normal');
  pdf.text(monthName, pageWidth - 10, 14, { align: 'right' });
  pdf.setTextColor(0, 0, 0);

  const workShifts = allShifts.filter(s => s.start && s.end);
  const absShifts = allShifts.filter(s => !s.start || !s.end);

  let currentY = 30;

  if (workShifts.length > 0) {
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(30, 64, 175);
    pdf.text('Arbeitsschichten', 10, currentY);
    pdf.setTextColor(0, 0, 0);
    currentY += 2;

    autoTable(pdf, {
      startY: currentY,
      margin: { left: 10, right: 10 },
      head: [['Kürzel', 'Name', 'Zeiten', 'Std./Schicht', 'Anzeigemodus', 'Bezahlt', 'Zählt zu Soll']],
      body: workShifts.map(s => {
        const cfg = shiftMap[s.name];
        const timeStr = s.start && s.end ? `${s.start} – ${s.end}` : '–';
        const displayMode = cfg?.displayMode === 'code-in-cell' ? 'Kürzel in Zelle' : 'Zeiten in Zelle';
        return [
          s.abbrev || '–',
          s.name,
          timeStr,
          `${s.hours.toFixed(1)} h`,
          displayMode,
          cfg?.isPaid !== false ? 'Ja' : 'Nein',
          cfg?.countsToTarget !== false ? 'Ja' : 'Nein',
        ];
      }),
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [30, 64, 175], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 18, halign: 'center', fontStyle: 'bold' },
        1: { cellWidth: 40 },
        2: { cellWidth: 30, halign: 'center' },
        3: { cellWidth: 28, halign: 'center' },
        4: { cellWidth: 35, halign: 'center' },
        5: { cellWidth: 22, halign: 'center' },
        6: { cellWidth: 28, halign: 'center' },
      },
      didParseCell(data) {
        if (data.section === 'body' && data.column.index === 0) {
          const shiftName = workShifts[data.row.index]?.name;
          const color = shiftMap[shiftName]?.color;
          if (color) {
            const hex = color.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
              data.cell.styles.fillColor = [r, g, b];
              data.cell.styles.textColor = [255, 255, 255];
            }
          }
        }
      },
    });

    currentY = (pdf as any).lastAutoTable.finalY + 12;
  }

  if (absShifts.length > 0 && currentY < pageHeight - 40) {
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(120, 53, 15);
    pdf.text('Abwesenheitscodes', 10, currentY);
    pdf.setTextColor(0, 0, 0);
    currentY += 2;

    autoTable(pdf, {
      startY: currentY,
      margin: { left: 10, right: 10 },
      head: [['Kürzel', 'Name', 'Std./Tag', 'Bezahlt', 'Zählt zu Soll', 'Abteilung']],
      body: absShifts.map(s => {
        const cfg = shiftMap[s.name];
        return [
          s.abbrev || s.name.substring(0, 3),
          s.name,
          `${s.hours.toFixed(1)} h`,
          cfg?.isPaid !== false ? 'Ja' : 'Nein',
          cfg?.countsToTarget !== false ? 'Ja' : 'Nein',
          cfg?.department || 'Alle',
        ];
      }),
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [120, 53, 15], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 18, halign: 'center', fontStyle: 'bold' },
        1: { cellWidth: 50 },
        2: { cellWidth: 25, halign: 'center' },
        3: { cellWidth: 22, halign: 'center' },
        4: { cellWidth: 28, halign: 'center' },
        5: { cellWidth: 30 },
      },
      didParseCell(data) {
        if (data.section === 'body' && data.column.index === 0) {
          const shiftName = absShifts[data.row.index]?.name;
          const color = shiftMap[shiftName]?.color;
          if (color) {
            const hex = color.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
              data.cell.styles.fillColor = [r, g, b];
              data.cell.styles.textColor = [255, 255, 255];
            }
          }
        }
      },
    });
  }

  pdf.setFontSize(7);
  pdf.setFont('helvetica', 'italic');
  pdf.setTextColor(100, 100, 100);
  pdf.text(
    'Alle Legendenkonfigurationen werden in Supabase synchronisiert und sind in Preview und Published App identisch.',
    10,
    pageHeight - 8
  );
  pdf.setTextColor(0, 0, 0);
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
  /** Optionaler Restaurantname für Dateinamen (Mandantenfähigkeit) */
  restaurantName?: string;
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
    actualHoursData = {},
    restaurantName,
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
  const restPrefix = restaurantName ? `${restaurantName}_` : '';
  const fileName = isWeekExport 
    ? `${restPrefix}Dienstplan_KW${format(days[0], 'w', { locale: de })}_${format(currentMonth, 'MMMM_yyyy', { locale: de })}${hoursLabel ? `_${hoursLabel}` : ''}.xlsx`
    : `${restPrefix}Dienstplan_${format(currentMonth, 'MMMM_yyyy', { locale: de })}${hoursLabel ? `_${hoursLabel}` : ''}.xlsx`;
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
  const {
    employees, scheduleData, currentMonth,
    department = 'all', specificDays, restaurantName,
    exportType = 'aushang', employeeFriendly = false,
  } = options;
  const isLeitungsplan = exportType === 'leitungsplan' && !employeeFriendly;
  // Hours display: Leitungsplan shows by default, Aushang hides by default
  const showEmpHours  = options.showEmpHours  ?? isLeitungsplan;
  const showDayTotals = options.showDayTotals ?? isLeitungsplan;
  console.log(`[PDF] exportScheduleToPDF – dept=${department} type=${exportType} showEmpHours=${showEmpHours} showDayTotals=${showDayTotals} employees=${employees.length}`);

  // Date range
  const rangeStart = specificDays ? specificDays[0] : startOfMonth(currentMonth);
  const rangeEnd = specificDays ? specificDays[specificDays.length - 1] : endOfMonth(currentMonth);

  const shifts = getShiftConfig();
  const shiftMap = getShiftConfigMap();
  const absenceShifts = shifts.filter(s => !s.start || !s.end);

  // Sort employees
  const sortById = (a: Employee, b: Employee) => parseInt(a.id) - parseInt(b.id);
  const allServiceEmps = employees.filter(e => e.department === 'service').sort(sortById);
  const allKücheEmps   = employees.filter(e => e.department === 'küche').sort(sortById);

  // ── Branding ─────────────────────────────────────────────────────────────
  const brandingId = restaurantName?.toLowerCase() === 'beaulieu' ? 'beaulieu' : 'oliv';
  const branding = getBranding(brandingId);
  const logoDataUrl = await renderLogoDataUrl(branding, 200, 46);

  // ── PDF setup ─────────────────────────────────────────────────────────────
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const HEADER_H = 22; // compact header
  let isFirstPage = true;

  // ── Palette — matches webapp chip colors ──────────────────────────────────
  // Shift: emerald-50 / emerald-800  (matches ShiftChip in StaffSchedulePage)
  const COL_SHIFT:  { bg: [number,number,number]; fg: [number,number,number] } = { bg: [209,250,229], fg: [5,80,58]   };
  // Frei: slate-100 / slate-600
  const COL_FREI:   { bg: [number,number,number]; fg: [number,number,number] } = { bg: [241,245,249], fg: [71,85,105] };
  // Ferien: blue-100 / blue-700
  const COL_FERIEN: { bg: [number,number,number]; fg: [number,number,number] } = { bg: [198,220,255], fg: [28,68,196] };
  // Krank: red-100 / red-700
  const COL_KRANK:  { bg: [number,number,number]; fg: [number,number,number] } = { bg: [254,226,226], fg: [185,28,28] };
  // Other: amber-100 / amber-800
  const COL_OTHER:  { bg: [number,number,number]; fg: [number,number,number] } = { bg: [254,243,199], fg: [146,64,14] };
  // Weekend: amber-50 (very subtle warm tint)
  const WE_BG: [number,number,number] = [255,253,244];

  // ── Helpers ───────────────────────────────────────────────────────────────

  const getAbsenceType = (abbrev: string): 'frei' | 'ferien' | 'krank' | 'other' => {
    const shift = absenceShifts.find(s => s.abbrev === abbrev);
    const name = (shift?.name || abbrev).toLowerCase();
    if (name.includes('frei')) return 'frei';
    if (name.includes('ferien') || name.includes('urlaub')) return 'ferien';
    if (name.includes('krank') || name.includes('arzt')) return 'krank';
    return 'other';
  };

  interface CellInfo { text: string; absenceType: 'frei' | 'ferien' | 'krank' | 'other' | null; hasShift: boolean; }

  const buildCellInfo = (ds: DaySchedule): CellInfo => {
    const hasFrühAbs = !!ds.frühAbsence;
    const hasSpätAbs = !!ds.spätAbsence;
    const hasFrüh = !!ds.früh?.start;
    const hasSpät = !!ds.spät?.start;
    let absType: CellInfo['absenceType'] = null;
    if (hasFrühAbs) absType = getAbsenceType(ds.frühAbsence!);
    else if (hasSpätAbs) absType = getAbsenceType(ds.spätAbsence!);
    const parts: string[] = [];
    if (hasFrühAbs && hasSpätAbs) {
      parts.push(ds.frühAbsence === ds.spätAbsence ? ds.frühAbsence! : `${ds.frühAbsence}/${ds.spätAbsence}`);
    } else {
      if (hasFrühAbs) parts.push(ds.frühAbsence!);
      else if (hasFrüh) parts.push(formatTimeSlot(ds.früh));
      if (hasSpätAbs) parts.push(ds.spätAbsence!);
      else if (hasSpät) parts.push(formatTimeSlot(ds.spät));
    }
    return { text: parts.join('\n'), absenceType: absType, hasShift: hasFrüh || hasSpät };
  };

  /** True if employee has any activity in given week days */
  const empIsActive = (emp: Employee, weekDays: Date[]): boolean =>
    weekDays.some(day => {
      const ds = scheduleData[`${emp.id}-${format(day, 'yyyy-MM-dd')}`];
      if (!ds) return false;
      return !!(ds.früh?.start || ds.spät?.start || ds.frühAbsence || ds.spätAbsence);
    });

  const calcEmpWeekHours = (emp: Employee, weekDays: Date[]): number => {
    let h = 0;
    weekDays.forEach(day => {
      const ds = scheduleData[`${emp.id}-${format(day, 'yyyy-MM-dd')}`] || {} as DaySchedule;
      h += calculateSlotHours(ds.früh) + calculateSlotHours(ds.spät);
      if (ds.frühAbsence) {
        const s = absenceShifts.find(a => a.abbrev === ds.frühAbsence);
        if (s && shiftMap[s.name]?.countsToTarget) h += shiftMap[s.name].hours || 0;
      }
      if (ds.spätAbsence && ds.spätAbsence !== ds.frühAbsence) {
        const s = absenceShifts.find(a => a.abbrev === ds.spätAbsence);
        if (s && shiftMap[s.name]?.countsToTarget) h += shiftMap[s.name].hours || 0;
      }
    });
    return h;
  };

  // Truncate very long names to prevent ugly wrapping
  const truncateName = (name: string, maxLen = 20): string =>
    name.length > maxLen ? name.slice(0, maxLen - 1) + '…' : name;

  // ── Draw compact branded header ───────────────────────────────────────────

  const drawHeader = (deptLabel: string, weekDays: Date[]) => {
    const kw = getISOWeek(weekDays[0]);
    const from = format(weekDays[0], 'dd.MM.', { locale: de });
    const to = format(weekDays[weekDays.length - 1], 'dd.MM.yyyy', { locale: de });

    pdf.setFillColor(branding.headerBg[0], branding.headerBg[1], branding.headerBg[2]);
    pdf.rect(0, 0, pageW, HEADER_H, 'F');
    pdf.setFillColor(branding.accentColor[0], branding.accentColor[1], branding.accentColor[2]);
    pdf.rect(0, HEADER_H - 0.8, pageW, 0.8, 'F');

    // Logo — compact, right-aligned
    if (logoDataUrl) pdf.addImage(logoDataUrl, 'PNG', pageW - 46, 2, 40, 17);

    // Left text block
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.setTextColor(branding.textPrimary[0], branding.textPrimary[1], branding.textPrimary[2]);
    pdf.text(`${branding.displayName}  ·  KW ${kw}`, 8, 8.5);

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);
    pdf.setTextColor(branding.textSecondary[0], branding.textSecondary[1], branding.textSecondary[2]);
    pdf.text(`${from}–${to}  ·  ${deptLabel}`, 8, 14);

    const typeLabel = isLeitungsplan ? 'Leitungsplan (intern)' : 'Aushang';
    pdf.setFontSize(6);
    pdf.text(typeLabel, 8, 19.5);
    pdf.text(`Stand: ${format(new Date(), 'dd.MM.yyyy HH:mm')}`, 55, 19.5);

    pdf.setTextColor(0, 0, 0);
  };

  // ── Build one weekly table page (chip/card style) ─────────────────────────

  const createWeeklyPage = (allDeptEmps: Employee[], deptLabel: string, weekDays: Date[]) => {
    // Filter: Aushang hides truly inactive employees; Leitungsplan shows all
    const deptEmployees = isLeitungsplan
      ? allDeptEmps
      : allDeptEmps.filter(e => empIsActive(e, weekDays));

    if (deptEmployees.length === 0) return;
    if (!isFirstPage) pdf.addPage();
    isFirstPage = false;
    drawHeader(deptLabel, weekDays);

    // Dynamic sizing — tighter for more employees
    const n   = deptEmployees.length;
    const fs  = n > 34 ? 5   : n > 28 ? 5.5 : n > 22 ? 6   : n > 16 ? 6.5 : 7;
    const mh  = n > 28 ? 7   : n > 20 ? 8   : n > 14 ? 9   : 10;
    const cp  = 0.3; // minimal table padding — chips provide inner spacing

    const DOW      = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const nDays    = weekDays.length;

    // ── Pre-compute chip info per body day cell ──────────────────────────────
    // chipMap key: `${ri},${di}` (row index, day index 0-based)
    type ChipStyle = { bg: [number,number,number]; fg: [number,number,number]; bold: boolean; hasContent: boolean };
    const chipMap = new Map<string, { lines: string[]; style: ChipStyle }>();

    deptEmployees.forEach((emp, ri) => {
      weekDays.forEach((day, di) => {
        const ds = scheduleData[`${emp.id}-${format(day, 'yyyy-MM-dd')}`] || {} as DaySchedule;
        const { text, absenceType, hasShift } = buildCellInfo(ds);
        const isWE = day.getDay() === 0 || day.getDay() === 6;
        const lines = text ? text.split('\n').filter(Boolean) : [];
        const hasContent = lines.length > 0;
        let s: ChipStyle;
        if      (absenceType === 'frei')   s = { bg: COL_FREI.bg,   fg: COL_FREI.fg,   bold: true,  hasContent };
        else if (absenceType === 'ferien') s = { bg: COL_FERIEN.bg, fg: COL_FERIEN.fg, bold: true,  hasContent };
        else if (absenceType === 'krank')  s = { bg: COL_KRANK.bg,  fg: COL_KRANK.fg,  bold: true,  hasContent };
        else if (absenceType === 'other')  s = { bg: COL_OTHER.bg,  fg: COL_OTHER.fg,  bold: true,  hasContent };
        else if (hasShift)                 s = { bg: COL_SHIFT.bg,  fg: COL_SHIFT.fg,  bold: false, hasContent };
        else if (isWE)                     s = { bg: WE_BG,         fg: [175,180,190], bold: false, hasContent: false };
        else                               s = { bg: [255,255,255], fg: [200,205,215], bold: false, hasContent: false };
        chipMap.set(`${ri},${di}`, { lines, style: s });
      });
    });

    // ── Headers ──────────────────────────────────────────────────────────────
    const headers: string[] = ['Mitarbeiter'];
    weekDays.forEach(d => headers.push(`${DOW[d.getDay()]}\n${format(d, 'd.M.')}`));
    if (showEmpHours) {
      headers.push('Std');
      if (isLeitungsplan) { headers.push('Soll'); headers.push('+/−'); }
    }

    // ── Body rows ────────────────────────────────────────────────────────────
    const body: (string | number)[][] = [];
    deptEmployees.forEach((emp, ri) => {
      const row: (string | number)[] = [truncateName(emp.name, 22)];
      const totalH = calcEmpWeekHours(emp, weekDays);
      // Day cells: include actual text so autoTable sizes rows correctly;
      // text is hidden (same colour as bg) and chips are drawn in didDrawCell.
      weekDays.forEach((_, di) => {
        const info = chipMap.get(`${ri},${di}`);
        row.push(info?.lines.join('\n') ?? '');
      });
      if (showEmpHours) {
        row.push(totalH > 0 ? totalH.toFixed(1) : '');
        if (isLeitungsplan) {
          const soll = emp.weeklyHours ?? 42;
          const diff = totalH - soll;
          row.push(soll.toFixed(0));
          row.push(totalH > 0 ? (diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1)) : '');
        }
      }
      body.push(row);
    });

    // Sum row (optional)
    if (showDayTotals) {
      const sumRow: (string | number)[] = ['Gesamt'];
      let grandTotal = 0;
      weekDays.forEach(day => {
        let dayH = 0;
        deptEmployees.forEach(emp => {
          const ds = scheduleData[`${emp.id}-${format(day, 'yyyy-MM-dd')}`] || {} as DaySchedule;
          dayH += calculateSlotHours(ds.früh) + calculateSlotHours(ds.spät);
        });
        sumRow.push(dayH > 0 ? `${dayH.toFixed(0)}h` : '');
        grandTotal += dayH;
      });
      if (showEmpHours) {
        sumRow.push(grandTotal > 0 ? `${grandTotal.toFixed(0)}` : '');
        if (isLeitungsplan) { sumRow.push(''); sumRow.push(''); }
      }
      body.push(sumRow);
    }

    // ── Column widths ────────────────────────────────────────────────────────
    const ML = 7; const MR = 7;
    const nameW  = 30;
    const stdW   = 9;
    const extraW = 9;
    const endColCount = showEmpHours ? (isLeitungsplan ? 3 : 1) : 0;
    const endTotalW   = showEmpHours ? stdW + extraW * (endColCount - 1) : 0;
    const availW = pageW - ML - MR - nameW - endTotalW;
    const dayW   = availW / nDays;

    const colStyles: Record<number, { cellWidth: number; halign?: 'left' | 'center' | 'right' }> = {
      0: { cellWidth: nameW, halign: 'left' },
    };
    for (let i = 0; i < nDays; i++) colStyles[i + 1] = { cellWidth: dayW, halign: 'center' };
    if (showEmpHours) {
      colStyles[nDays + 1] = { cellWidth: stdW,   halign: 'center' };
      if (isLeitungsplan) {
        colStyles[nDays + 2] = { cellWidth: extraW, halign: 'center' };
        colStyles[nDays + 3] = { cellWidth: extraW, halign: 'center' };
      }
    }

    autoTable(pdf, {
      head: [headers],
      body,
      startY: HEADER_H + 2,
      theme: 'plain',
      tableWidth: pageW - ML - MR,
      margin: { left: ML, right: MR, top: 0, bottom: 6 },
      styles: {
        fontSize: fs,
        cellPadding: cp,
        minCellHeight: mh,
        overflow: 'linebreak',
        lineWidth: 0,   // no cell borders — chips provide visual separation
        valign: 'middle',
      },
      headStyles: {
        fillColor: branding.headerBg as [number,number,number],
        textColor: [255, 255, 255] as [number,number,number],
        fontStyle: 'bold',
        fontSize: Math.max(fs - 0.5, 5),
        halign: 'center',
        minCellHeight: 6,
        lineWidth: 0,
        cellPadding: 0.6,
      },
      columnStyles: colStyles,
      didDrawPage: () => {
        const pg = pdf.getCurrentPageInfo().pageNumber;
        const total = pdf.getNumberOfPages();
        pdf.setFontSize(6);
        pdf.setTextColor(175, 178, 185);
        pdf.text(`${pg} / ${total}`, pageW - ML - 2, pageH - 3, { align: 'right' });
        pdf.setTextColor(0, 0, 0);
      },
      didParseCell: (data) => {
        const ci = data.column.index;
        const ri = data.row.index;
        const isDayCol  = ci >= 1 && ci <= nDays;
        const isWECol   = isDayCol && (weekDays[ci - 1].getDay() === 0 || weekDays[ci - 1].getDay() === 6);
        const isTodayCl = isDayCol && format(weekDays[ci - 1], 'yyyy-MM-dd') === todayStr;
        const isSumRow  = data.section === 'body' && ri === deptEmployees.length;
        const isHoursCol = data.section === 'body' && ci > nDays;
        const rowBg: [number,number,number] = ri % 2 === 0 ? [255,255,255] : [249,250,251];

        // ── Head row ──
        if (data.section === 'head') {
          if (isDayCol) {
            if (isTodayCl) {
              data.cell.styles.fillColor = branding.accentColor as [number,number,number];
            } else if (isWECol) {
              const bg = branding.headerBg; const ac = branding.accentColor;
              data.cell.styles.fillColor = [
                Math.round(bg[0]*0.7 + ac[0]*0.3),
                Math.round(bg[1]*0.7 + ac[1]*0.3),
                Math.round(bg[2]*0.7 + ac[2]*0.3),
              ] as [number,number,number];
            }
          }
          return;
        }

        // ── Sum row ──
        if (isSumRow) {
          data.cell.styles.fillColor = [236,239,244] as [number,number,number];
          data.cell.styles.textColor = [55,65,85]   as [number,number,number];
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fontSize  = Math.max(fs - 0.5, 5);
          return;
        }

        // ── Day cells: hide autoTable's text — chip drawn in didDrawCell ──
        if (isDayCol) {
          const cellBg: [number,number,number] = isWECol ? WE_BG : rowBg;
          data.cell.styles.fillColor = cellBg;
          data.cell.styles.textColor = cellBg; // invisible — chip takes over
          return;
        }

        // ── Name column ──
        if (ci === 0) {
          data.cell.styles.fillColor = rowBg;
          data.cell.styles.textColor = [30, 38, 55] as [number,number,number];
          data.cell.styles.fontStyle = 'bold';
          const nameLen = String(data.cell.raw ?? '').length;
          data.cell.styles.fontSize  = nameLen > 20
            ? Math.max(fs - 1.0, 4.5)
            : nameLen > 16
              ? Math.max(fs - 0.5, 5)
              : fs;
          return;
        }

        // ── Hours columns ──
        if (isHoursCol) {
          const hoursBg: [number,number,number] = ri % 2 === 0 ? [249,250,253] : [244,246,250];
          data.cell.styles.fillColor = hoursBg;
          data.cell.styles.fontSize  = Math.max(fs - 0.5, 5);
          data.cell.styles.fontStyle = 'normal';
          const val = String(data.cell.raw ?? '');
          if      (val.startsWith('+')) data.cell.styles.textColor = [21,90,48]   as [number,number,number];
          else if (val.startsWith('-')) data.cell.styles.textColor = [153,27,27]  as [number,number,number];
          else                          data.cell.styles.textColor = [100,110,130] as [number,number,number];
        }
      },

      didDrawCell: (data) => {
        const { section, row, column, cell } = data;
        if (section !== 'body') return;
        const ci = column.index;
        const ri = row.index;
        if (ci < 1 || ci > nDays) return;      // only day columns
        if (ri >= deptEmployees.length) return;  // skip sum row

        const di   = ci - 1;
        const info = chipMap.get(`${ri},${di}`);
        const isWE = weekDays[di].getDay() === 0 || weekDays[di].getDay() === 6;
        const rowBg: [number,number,number] = ri % 2 === 0 ? [255,255,255] : [249,250,251];
        const cellBg: [number,number,number] = isWE ? WE_BG : rowBg;

        // Erase autoTable's text by repainting the cell background
        pdf.setFillColor(cellBg[0], cellBg[1], cellBg[2]);
        pdf.rect(cell.x, cell.y, cell.width, cell.height, 'F');

        if (!info || !info.style.hasContent || info.lines.length === 0) return;

        const { lines, style } = info;
        const chipPadX = 0.9;
        const chipX    = cell.x + chipPadX;
        const chipW    = cell.width - 2 * chipPadX;
        const ptToMm   = 0.352;       // 1pt ≈ 0.352mm
        const chipPadY = 0.65;

        if (lines.length === 1) {
          // Single chip centred in cell
          const chipH  = Math.min(Math.max(fs * ptToMm + 2 * chipPadY, cell.height * 0.55), cell.height - 1.6);
          const chipY  = cell.y + (cell.height - chipH) / 2;
          const r      = Math.min(1.4, chipH / 2);
          pdf.setFillColor(style.bg[0], style.bg[1], style.bg[2]);
          (pdf as any).roundedRect(chipX, chipY, chipW, chipH, r, r, 'F');
          pdf.setFont('helvetica', style.bold ? 'bold' : 'normal');
          pdf.setFontSize(fs);
          pdf.setTextColor(style.fg[0], style.fg[1], style.fg[2]);
          pdf.text(lines[0], chipX + chipW / 2, chipY + chipH / 2 + fs * ptToMm * 0.35, { align: 'center' });
        } else {
          // Two chips stacked (for employees with früh + spät)
          const singleH  = Math.min(Math.max(fs * ptToMm + 1.2, 3.8), (cell.height - 2.4) / 2);
          const gap      = Math.max(0.4, (cell.height - 2 * singleH - 1.4) / 3);
          const totalH   = 2 * singleH + gap;
          const startY   = cell.y + (cell.height - totalH) / 2;
          const r        = Math.min(1.1, singleH / 2);
          const fsSub    = Math.max(fs - 0.5, 5);
          lines.slice(0, 2).forEach((line, i) => {
            const cy = startY + i * (singleH + gap);
            pdf.setFillColor(style.bg[0], style.bg[1], style.bg[2]);
            (pdf as any).roundedRect(chipX, cy, chipW, singleH, r, r, 'F');
            pdf.setFont('helvetica', style.bold ? 'bold' : 'normal');
            pdf.setFontSize(fsSub);
            pdf.setTextColor(style.fg[0], style.fg[1], style.fg[2]);
            pdf.text(line, chipX + chipW / 2, cy + singleH / 2 + fsSub * ptToMm * 0.35, { align: 'center' });
          });
        }
      },
    });
  };

  // ── Iterate weeks, one page per dept ──────────────────────────────────────

  const weeks = eachWeekOfInterval({ start: rangeStart, end: rangeEnd }, { weekStartsOn: 1 });

  weeks.forEach(weekStart => {
    const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
    const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd }).filter(d =>
      isWithinInterval(d, { start: rangeStart, end: rangeEnd })
    );
    if (weekDays.length === 0) return;
    if (department === 'all' || department === 'service') createWeeklyPage(allServiceEmps, 'Service', weekDays);
    if (department === 'all' || department === 'küche')   createWeeklyPage(allKücheEmps,   'Küche',   weekDays);
  });

  // ── Save ──────────────────────────────────────────────────────────────────

  const typeTag = isLeitungsplan ? '_Leitungsplan' : '_Aushang';
  const restPrefix = restaurantName ? `${restaurantName}_` : '';
  const kwFrom = `KW${getISOWeek(rangeStart)}`;
  const kwTo = rangeEnd > endOfWeek(rangeStart, { weekStartsOn: 1 }) ? `-${getISOWeek(rangeEnd)}` : '';
  const yearStr = format(currentMonth, 'yyyy');
  pdf.save(`${restPrefix}Dienstplan_${kwFrom}${kwTo}_${yearStr}${typeTag}.pdf`);
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
                name: normalizeImportedName(originalName),
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
