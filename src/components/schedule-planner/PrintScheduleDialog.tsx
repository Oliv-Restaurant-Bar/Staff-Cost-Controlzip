import { useRef, useState } from 'react';
import { format, getDay, startOfWeek, endOfWeek, eachWeekOfInterval, isSameWeek, startOfMonth, endOfMonth, eachDayOfInterval, isWithinInterval } from 'date-fns';
import { de } from 'date-fns/locale';
import { DaySchedule, TimeSlot } from './ScheduleGrid';
import { useShiftConfig, calculateBreakDeduction } from '@/hooks/useShiftConfig';
import { Employee, Department } from '@/types/personnel';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Printer, Calendar, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PrintScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: Employee[];
  days: Date[];
  scheduleData: Record<string, DaySchedule>;
  currentMonth: Date;
  department: Department | 'all';
  /**
   * Per-cell color map.  Key: `${empId}-${yyyy-MM-dd}-früh` / `…-spät`.
   * When present the cell background is overridden (visual only — no effect on hours/costs).
   */
  cellColors?: Record<string, string>;
}

type ViewMode = 'month' | 'week';

export const PrintScheduleDialog = ({
  open,
  onOpenChange,
  employees,
  days,
  scheduleData,
  currentMonth,
  department,
  cellColors = {},
}: PrintScheduleDialogProps) => {
  const { shiftMap, absenceShifts } = useShiftConfig();
  const printRef = useRef<HTMLDivElement>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [selectedWeek, setSelectedWeek] = useState(0);

  // Get weeks in month
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const weeksInMonth = eachWeekOfInterval(
    { start: monthStart, end: monthEnd },
    { weekStartsOn: 1 }
  );

  // Get days to display based on view mode
  const getDisplayDays = (): Date[] => {
    if (viewMode === 'month') {
      return days;
    }
    const weekStart = weeksInMonth[selectedWeek];
    const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
    return eachDayOfInterval({ start: weekStart, end: weekEnd }).filter(
      d => isWithinInterval(d, { start: monthStart, end: monthEnd })
    );
  };

  const displayDays = getDisplayDays();

  const calculateSlotHours = (slot: TimeSlot | null | undefined): number => {
    if (!slot?.start || !slot?.end) return 0;
    const [startH, startM] = slot.start.split(':').map(Number);
    const [endH, endM] = slot.end.split(':').map(Number);
    let hours = endH - startH + (endM - startM) / 60;
    if (hours < 0) hours += 24;
    return Math.round(hours * 100) / 100;
  };

  const calculateDayHours = (daySchedule: DaySchedule): number => {
    const frühHours = calculateSlotHours(daySchedule.früh);
    const spätHours = calculateSlotHours(daySchedule.spät);
    const totalGross = frühHours + spätHours;
    const breakDeduction = calculateBreakDeduction(totalGross);
    return Math.round((totalGross - breakDeduction) * 100) / 100;
  };

  const getAbsenceHours = (abbrev: string | null | undefined): number => {
    if (!abbrev) return 0;
    const shift = absenceShifts.find(s => shiftMap[s]?.abbrev === abbrev);
    if (shift && shiftMap[shift]?.countsToTarget) {
      return shiftMap[shift].hours;
    }
    return 0;
  };

  const handlePrint = () => {
    const printContent = printRef.current;
    if (!printContent) return;

    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    const styles = `
      <style>
        @page {
          size: A4 landscape;
          margin: 10mm;
        }
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: Arial, sans-serif;
          font-size: 9px;
          line-height: 1.2;
        }
        .print-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
          padding-bottom: 8px;
          border-bottom: 2px solid #333;
        }
        .print-title {
          font-size: 16px;
          font-weight: bold;
        }
        .print-subtitle {
          font-size: 11px;
          color: #666;
        }
        .print-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 8px;
        }
        .print-table th,
        .print-table td {
          border: 1px solid #ccc;
          padding: 3px 4px;
          text-align: center;
          vertical-align: middle;
        }
        .print-table th {
          background: #f0f0f0;
          font-weight: bold;
        }
        .print-table th.employee-col {
          text-align: left;
          min-width: 100px;
        }
        .print-table td.employee-cell {
          text-align: left;
          font-weight: 500;
        }
        .print-table td.hours-cell {
          font-weight: bold;
          background: #f9f9f9;
        }
        .print-table td.week-sum {
          font-weight: bold;
          background: #e0f2fe;
          color: #0369a1;
        }
        .weekend {
          background: #fff7ed !important;
        }
        .day-separator {
          border-right: 2px solid #9ca3af !important;
        }
        .shift-cell {
          font-size: 7px;
          padding: 2px !important;
        }
        .slot-früh { background: #dbeafe; color: #1e40af; }
        .slot-spät { background: #e0e7ff; color: #3730a3; }
        .slot-absence { background: #f3f4f6; color: #374151; }
        .shift-ferien { background: #d1fae5; color: #065f46; }
        .shift-krank { background: #fee2e2; color: #991b1b; }
        .shift-frei { background: #f1f5f9; color: #64748b; }
        .legend {
          margin-top: 12px;
          padding-top: 8px;
          border-top: 1px solid #ccc;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          font-size: 8px;
        }
        .legend-item {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .legend-color {
          width: 12px;
          height: 12px;
          border: 1px solid #999;
        }
        .summary-row td {
          font-weight: bold;
          background: #f0f0f0 !important;
        }
        .week-header {
          background: #1e40af !important;
          color: white !important;
        }
        .sub-header {
          background: #3b82f6 !important;
          color: white !important;
          font-size: 7px !important;
        }
      </style>
    `;

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Dienstplan ${format(currentMonth, 'MMMM yyyy', { locale: de })} - ${department === 'service' ? 'Service' : department === 'küche' ? 'Küche' : 'Gesamt'}</title>
          ${styles}
        </head>
        <body>
          ${printContent.innerHTML}
        </body>
      </html>
    `);

    printWindow.document.close();
    printWindow.focus();
    
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 250);
  };

  const formatTimeSlot = (slot: TimeSlot | null | undefined): string => {
    if (!slot?.start || !slot?.end) return '';
    return `${slot.start.replace(':00', '')}-${slot.end.replace(':00', '')}`;
  };

  const calculateEmployeeHoursForDays = (employeeId: string, daysToCalc: Date[]): number => {
    let totalHours = 0;
    daysToCalc.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const cellKey = `${employeeId}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];

      if (daySchedule) {
        if (daySchedule.frühAbsence) {
          totalHours += getAbsenceHours(daySchedule.frühAbsence);
        }
        if (daySchedule.spätAbsence) {
          totalHours += getAbsenceHours(daySchedule.spätAbsence);
        }
        totalHours += calculateDayHours(daySchedule);
      }
    });
    return totalHours;
  };

  // Check if this is end of week (Sunday) to show weekly sum
  const isEndOfWeek = (day: Date): boolean => {
    return getDay(day) === 0; // Sunday
  };

  // Get days in the week containing this day (for weekly sum calculation)
  const getWeekDays = (day: Date): Date[] => {
    const weekStart = startOfWeek(day, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(day, { weekStartsOn: 1 });
    return displayDays.filter(d => isWithinInterval(d, { start: weekStart, end: weekEnd }));
  };

  const totalPlannedHours = calculateEmployeeHoursForDays(
    employees.map(e => e.id).join(','), 
    displayDays
  );

  const employeeTotalHours = employees.reduce(
    (sum, emp) => sum + calculateEmployeeHoursForDays(emp.id, displayDays), 
    0
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-4">
            <span>Druckvorschau</span>
            <div className="flex items-center gap-2">
              {/* View Mode Toggle */}
              <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
                <Button
                  variant={viewMode === 'month' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('month')}
                  className="h-7 gap-1"
                >
                  <CalendarDays className="h-3 w-3" />
                  Monat
                </Button>
                <Button
                  variant={viewMode === 'week' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('week')}
                  className="h-7 gap-1"
                >
                  <Calendar className="h-3 w-3" />
                  Woche
                </Button>
              </div>
              
              {/* Week Selector */}
              {viewMode === 'week' && (
                <select
                  value={selectedWeek}
                  onChange={(e) => setSelectedWeek(Number(e.target.value))}
                  className="h-8 px-2 text-sm border rounded-md bg-background"
                >
                  {weeksInMonth.map((week, idx) => (
                    <option key={idx} value={idx}>
                      KW {format(week, 'w')} ({format(week, 'd.MM.')} - {format(endOfWeek(week, { weekStartsOn: 1 }), 'd.MM.')})
                    </option>
                  ))}
                </select>
              )}
              
              <Button onClick={handlePrint} className="gap-2">
                <Printer className="h-4 w-4" />
                Drucken
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>

        {/* Print Content */}
        <div 
          ref={printRef} 
          className="bg-white p-4 text-black"
          style={{ minWidth: '1000px' }}
        >
          {/* Header */}
          <div className="print-header">
            <div>
              <div className="print-title">
                Dienstplan {department === 'all' ? 'Gesamt' : department === 'service' ? 'Service' : 'Küche'}
              </div>
              <div className="print-subtitle">
                {viewMode === 'week' 
                  ? `KW ${format(weeksInMonth[selectedWeek], 'w')} (${format(weeksInMonth[selectedWeek], 'd. MMMM', { locale: de })} - ${format(endOfWeek(weeksInMonth[selectedWeek], { weekStartsOn: 1 }), 'd. MMMM yyyy', { locale: de })})`
                  : format(currentMonth, 'MMMM yyyy', { locale: de })
                } • {employees.length} Mitarbeiter • {employeeTotalHours.toFixed(1)} Stunden geplant
              </div>
            </div>
            <div className="print-subtitle">
              Erstellt: {format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}
            </div>
          </div>

          {/* Schedule Table with Früh/Spät columns */}
          <table className="print-table">
            <thead>
              {/* Date Header Row */}
              <tr>
                <th className="employee-col week-header" rowSpan={2}>Mitarbeiter</th>
                <th className="week-header" rowSpan={2}>Std.</th>
                {displayDays.map((day, idx) => {
                  const dayOfWeek = getDay(day);
                  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                  const showWeekSum = isEndOfWeek(day) || idx === displayDays.length - 1;
                  
                  return (
                    <th 
                      key={day.toISOString()} 
                      colSpan={2}
                      className={cn(
                        'week-header',
                        isWeekend && 'weekend'
                      )}
                      style={showWeekSum ? { borderRight: '3px solid #1e40af' } : undefined}
                    >
                      <div>{format(day, 'EE', { locale: de })}</div>
                      <div>{format(day, 'd.MM.')}</div>
                    </th>
                  );
                })}
                {viewMode === 'month' && <th className="week-header" rowSpan={2}>Wo.</th>}
              </tr>
              {/* Früh/Spät Sub-Header */}
              <tr>
                {displayDays.map((day, idx) => {
                  const showWeekSum = isEndOfWeek(day) || idx === displayDays.length - 1;
                  return (
                    <>
                      <th key={`${day.toISOString()}-früh`} className="sub-header">Früh</th>
                      <th 
                        key={`${day.toISOString()}-spät`} 
                        className="sub-header"
                        style={showWeekSum ? { borderRight: '3px solid #1e40af' } : undefined}
                      >
                        Spät
                      </th>
                    </>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {employees.map(emp => {
                const totalHours = calculateEmployeeHoursForDays(emp.id, displayDays);
                
                return (
                  <tr key={emp.id}>
                    <td className="employee-cell">
                      {emp.name}
                      <br />
                      <span style={{ fontSize: '7px', color: '#666' }}>
                        {emp.employmentType} {emp.weeklyHours ? `• ${emp.weeklyHours}h/Wo` : ''}
                      </span>
                    </td>
                    <td className="hours-cell">{totalHours.toFixed(1)}</td>
                    {displayDays.map((day, idx) => {
                      const dateStr = format(day, 'yyyy-MM-dd');
                      const cellKey = `${emp.id}-${dateStr}`;
                      const daySchedule = scheduleData[cellKey] || {};
                      const dayOfWeek = getDay(day);
                      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                      const showWeekSum = isEndOfWeek(day) || idx === displayDays.length - 1;
                      
                      // Früh cell
                      const frühContent = daySchedule.frühAbsence 
                        ? daySchedule.frühAbsence
                        : formatTimeSlot(daySchedule.früh);
                      const frühClass = daySchedule.frühAbsence 
                        ? `slot-absence ${daySchedule.frühAbsence === 'FE' ? 'shift-ferien' : daySchedule.frühAbsence === 'K' ? 'shift-krank' : 'shift-frei'}`
                        : daySchedule.früh ? 'slot-früh' : '';
                      
                      // Spät cell
                      const spätContent = daySchedule.spätAbsence 
                        ? daySchedule.spätAbsence
                        : formatTimeSlot(daySchedule.spät);
                      const spätClass = daySchedule.spätAbsence 
                        ? `slot-absence ${daySchedule.spätAbsence === 'FE' ? 'shift-ferien' : daySchedule.spätAbsence === 'K' ? 'shift-krank' : 'shift-frei'}`
                        : daySchedule.spät ? 'slot-spät' : '';

                      // Custom cell colors (visual only — no effect on hours/costs)
                      const frühColorKey = `${emp.id}-${dateStr}-früh`;
                      const spätColorKey  = `${emp.id}-${dateStr}-spät`;
                      const frühColor = !daySchedule.frühAbsence && cellColors[frühColorKey];
                      const spätColor  = !daySchedule.spätAbsence  && cellColors[spätColorKey];

                      return (
                        <>
                          <td 
                            key={`${day.toISOString()}-früh`}
                            className={cn(
                              'shift-cell',
                              isWeekend && !frühClass && !frühColor && 'weekend',
                              !frühColor && frühClass
                            )}
                            style={frühColor ? { backgroundColor: frühColor, color: '#1e3a5f' } : undefined}
                          >
                            {frühContent}
                          </td>
                          <td 
                            key={`${day.toISOString()}-spät`}
                            className={cn(
                              'shift-cell',
                              isWeekend && !spätClass && !spätColor && 'weekend',
                              !spätColor && spätClass
                            )}
                            style={{
                              ...(showWeekSum ? { borderRight: '3px solid #1e40af' } : {}),
                              ...(spätColor ? { backgroundColor: spätColor, color: '#1e3a5f' } : {}),
                            }}
                          >
                            {spätContent}
                          </td>
                        </>
                      );
                    })}
                    {viewMode === 'month' && (
                      <td className="week-sum">
                        {calculateEmployeeHoursForDays(emp.id, displayDays).toFixed(1)}
                      </td>
                    )}
                  </tr>
                );
              })}
              {/* Summary Row */}
              <tr className="summary-row">
                <td className="employee-cell">Gesamt</td>
                <td className="hours-cell">{employeeTotalHours.toFixed(1)}</td>
                {displayDays.map((day, idx) => {
                  let dayFrühTotal = 0;
                  let daySpätTotal = 0;
                  employees.forEach(emp => {
                    const dateStr = format(day, 'yyyy-MM-dd');
                    const cellKey = `${emp.id}-${dateStr}`;
                    const daySchedule = scheduleData[cellKey];
                    if (daySchedule) {
                      dayFrühTotal += calculateSlotHours(daySchedule.früh);
                      daySpätTotal += calculateSlotHours(daySchedule.spät);
                    }
                  });
                  const showWeekSum = isEndOfWeek(day) || idx === displayDays.length - 1;
                  
                  return (
                    <>
                      <td key={`${day.toISOString()}-früh-sum`}>
                        {dayFrühTotal > 0 ? dayFrühTotal.toFixed(1) : ''}
                      </td>
                      <td 
                        key={`${day.toISOString()}-spät-sum`}
                        style={showWeekSum ? { borderRight: '3px solid #1e40af' } : undefined}
                      >
                        {daySpätTotal > 0 ? daySpätTotal.toFixed(1) : ''}
                      </td>
                    </>
                  );
                })}
                {viewMode === 'month' && <td className="week-sum">{employeeTotalHours.toFixed(1)}</td>}
              </tr>
            </tbody>
          </table>

          {/* Legend */}
          <div className="legend">
            <div className="legend-item">
              <div className="legend-color slot-früh"></div>
              <span>Frühschicht</span>
            </div>
            <div className="legend-item">
              <div className="legend-color slot-spät"></div>
              <span>Spätschicht</span>
            </div>
            <div className="legend-item">
              <div className="legend-color shift-ferien"></div>
              <span>FE = Ferien</span>
            </div>
            <div className="legend-item">
              <div className="legend-color shift-krank"></div>
              <span>K = Krank</span>
            </div>
            <div className="legend-item">
              <div className="legend-color shift-frei"></div>
              <span>F = Frei</span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
