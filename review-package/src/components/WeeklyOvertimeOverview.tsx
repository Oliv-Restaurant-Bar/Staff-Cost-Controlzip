import { useMemo } from 'react';
import { format, startOfWeek, endOfWeek, eachDayOfInterval } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, TimeEntry } from '@/types/personnel';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { useWeekSync } from '@/hooks/useWeekSync';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Clock, TrendingUp, TrendingDown, Minus, CalendarDays, FileText, FileSpreadsheet } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { toast } from '@/hooks/use-toast';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';

interface WeeklyOvertimeOverviewProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  selectedDate: Date;
}

interface EmployeeWeeklyData {
  employee: Employee;
  expectedHours: number;
  actualHours: number;
  plannedHours: number;
  overtimeHours: number;
  overtimeCost: number;
  daysWorked: number;
}

export const WeeklyOvertimeOverview = ({
  employees,
  timeEntries,
  selectedDate,
}: WeeklyOvertimeOverviewProps) => {
  const { 
    currentWeekStart, 
    weekNumber, 
    weekRange,
  } = useWeekSync('WeeklyOvertimeOverview', selectedDate);

  // Calculate weekly data for each employee
  const weeklyData = useMemo(() => {
    const weekStart = startOfWeek(currentWeekStart, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 1 });
    
    const allDays = eachDayOfInterval({ start: weekStart, end: weekEnd });
    const allDayStrings = allDays.map(d => format(d, 'yyyy-MM-dd'));

    const data: EmployeeWeeklyData[] = employees
      .filter(emp => emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit')
      .map(employee => {
        // Get all time entries for this employee in this week
        const employeeEntries = timeEntries.filter(
          te => te.employeeId === employee.id && allDayStrings.includes(te.date)
        );

        // Calculate actual and planned hours worked
        const actualHours = employeeEntries.reduce((sum, entry) => {
          return sum + (entry.actualHours || 0);
        }, 0);
        
        const plannedHours = employeeEntries.reduce((sum, entry) => {
          return sum + (entry.plannedHours || 0);
        }, 0);

        // Calculate expected hours based on weekly hours
        const weeklyHours = employee.weeklyHours || 42;
        const expectedHours = weeklyHours;

        // Calculate overtime (actual vs expected)
        const overtimeHours = actualHours - expectedHours;
        const overtimeCost = overtimeHours * employee.hourlyWage;

        // Count days worked
        const daysWorked = employeeEntries.filter(e => (e.actualHours || 0) > 0).length;

        return {
          employee,
          expectedHours,
          actualHours,
          plannedHours,
          overtimeHours,
          overtimeCost,
          daysWorked,
        };
      })
      .sort((a, b) => b.overtimeHours - a.overtimeHours);

    return data;
  }, [employees, timeEntries, currentWeekStart]);

  // Calculate totals
  const totals = useMemo(() => {
    return weeklyData.reduce(
      (acc, data) => ({
        expectedHours: acc.expectedHours + data.expectedHours,
        actualHours: acc.actualHours + data.actualHours,
        plannedHours: acc.plannedHours + data.plannedHours,
        overtimeHours: acc.overtimeHours + data.overtimeHours,
        overtimeCost: acc.overtimeCost + data.overtimeCost,
      }),
      { expectedHours: 0, actualHours: 0, plannedHours: 0, overtimeHours: 0, overtimeCost: 0 }
    );
  }, [weeklyData]);

  const getOvertimeIcon = (hours: number) => {
    if (hours > 0) return <TrendingUp className="h-4 w-4 text-destructive" />;
    if (hours < 0) return <TrendingDown className="h-4 w-4 text-green-600" />;
    return <Minus className="h-4 w-4 text-muted-foreground" />;
  };

  const getOvertimeColor = (hours: number) => {
    if (hours > 0) return 'text-destructive';
    if (hours < 0) return 'text-green-600';
    return 'text-muted-foreground';
  };

  // PDF Export
  const exportToPDF = () => {
    const doc = new jsPDF();
    const weekStart = startOfWeek(currentWeekStart, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 1 });
    
    // Title
    doc.setFontSize(16);
    doc.text('Wöchentliche Überstunden-Übersicht', 14, 20);
    doc.setFontSize(11);
    doc.text(`KW ${weekNumber} (${format(weekStart, 'd. MMM', { locale: de })} - ${format(weekEnd, 'd. MMM yyyy', { locale: de })})`, 14, 28);
    
    // Summary
    doc.setFontSize(10);
    doc.text(`Soll-Stunden: ${formatHours(totals.expectedHours)}`, 14, 40);
    doc.text(`Plan-Stunden: ${formatHours(totals.plannedHours)}`, 70, 40);
    doc.text(`Ist-Stunden: ${formatHours(totals.actualHours)}`, 126, 40);
    doc.text(`Überstunden: ${totals.overtimeHours > 0 ? '+' : ''}${formatHours(totals.overtimeHours)}`, 14, 48);
    doc.text(`Überstunden-Kosten: ${totals.overtimeCost > 0 ? '+' : ''}${formatCurrency(totals.overtimeCost)}`, 70, 48);
    
    // Table
    const tableData = weeklyData.map(d => [
      d.employee.name,
      d.employee.department === 'service' ? 'Service' : 'Küche',
      formatHours(d.expectedHours),
      formatHours(d.plannedHours),
      d.actualHours > 0 ? formatHours(d.actualHours) : '-',
      `${d.overtimeHours > 0 ? '+' : ''}${formatHours(d.overtimeHours)}`,
      `${d.overtimeCost > 0 ? '+' : ''}${formatCurrency(d.overtimeCost)}`,
      d.daysWorked.toString(),
    ]);
    
    // Add totals row
    tableData.push([
      'Gesamt',
      '',
      formatHours(totals.expectedHours),
      formatHours(totals.plannedHours),
      formatHours(totals.actualHours),
      `${totals.overtimeHours > 0 ? '+' : ''}${formatHours(totals.overtimeHours)}`,
      `${totals.overtimeCost > 0 ? '+' : ''}${formatCurrency(totals.overtimeCost)}`,
      '',
    ]);
    
    autoTable(doc, {
      startY: 55,
      head: [['Mitarbeiter', 'Abteilung', 'Soll', 'Plan', 'Ist', 'Überstunden', 'Kosten', 'Tage']],
      body: tableData,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [59, 130, 246] },
      footStyles: { fontStyle: 'bold' },
    });
    
    doc.save(`Ueberstunden_KW${weekNumber}_${format(weekStart, 'yyyy')}.pdf`);
    toast({ title: 'PDF exportiert', description: `Überstunden KW ${weekNumber} als PDF gespeichert` });
  };

  // Excel Export
  const exportToExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`KW ${weekNumber}`);
    const weekStart = startOfWeek(currentWeekStart, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 1 });
    
    // Title
    sheet.mergeCells('A1:H1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = `Wöchentliche Überstunden-Übersicht - KW ${weekNumber}`;
    titleCell.font = { bold: true, size: 14 };
    
    sheet.mergeCells('A2:H2');
    sheet.getCell('A2').value = `${format(weekStart, 'd. MMM', { locale: de })} - ${format(weekEnd, 'd. MMM yyyy', { locale: de })}`;
    
    // Summary row
    sheet.getCell('A4').value = 'Soll-Stunden:';
    sheet.getCell('B4').value = totals.expectedHours;
    sheet.getCell('B4').numFmt = '0.00';
    sheet.getCell('C4').value = 'Plan-Stunden:';
    sheet.getCell('D4').value = totals.plannedHours;
    sheet.getCell('D4').numFmt = '0.00';
    sheet.getCell('E4').value = 'Ist-Stunden:';
    sheet.getCell('F4').value = totals.actualHours;
    sheet.getCell('F4').numFmt = '0.00';
    
    sheet.getCell('A5').value = 'Überstunden:';
    sheet.getCell('B5').value = totals.overtimeHours;
    sheet.getCell('B5').numFmt = '+0.00;-0.00;0.00';
    sheet.getCell('C5').value = 'Kosten:';
    sheet.getCell('D5').value = totals.overtimeCost;
    sheet.getCell('D5').numFmt = '"CHF" #,##0.00';
    
    // Headers
    const headerRow = sheet.getRow(7);
    headerRow.values = ['Mitarbeiter', 'Abteilung', 'Soll-Std.', 'Plan-Std.', 'Ist-Std.', 'Überstunden', 'Kosten (CHF)', 'Tage'];
    headerRow.font = { bold: true };
    headerRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });
    
    // Data rows
    weeklyData.forEach((d, i) => {
      const row = sheet.getRow(8 + i);
      row.values = [
        d.employee.name,
        d.employee.department === 'service' ? 'Service' : 'Küche',
        d.expectedHours,
        d.plannedHours,
        d.actualHours || 0,
        d.overtimeHours,
        d.overtimeCost,
        d.daysWorked,
      ];
      row.getCell(3).numFmt = '0.00';
      row.getCell(4).numFmt = '0.00';
      row.getCell(5).numFmt = '0.00';
      row.getCell(6).numFmt = '+0.00;-0.00;0.00';
      row.getCell(7).numFmt = '"CHF" #,##0.00';
      
      // Color coding for overtime
      if (d.overtimeHours > 0) {
        row.getCell(6).font = { color: { argb: 'FFDC2626' } };
        row.getCell(7).font = { color: { argb: 'FFDC2626' } };
      } else if (d.overtimeHours < 0) {
        row.getCell(6).font = { color: { argb: 'FF16A34A' } };
        row.getCell(7).font = { color: { argb: 'FF16A34A' } };
      }
    });
    
    // Totals row
    const totalsRow = sheet.getRow(8 + weeklyData.length);
    totalsRow.values = ['Gesamt', '', totals.expectedHours, totals.plannedHours, totals.actualHours, totals.overtimeHours, totals.overtimeCost, ''];
    totalsRow.font = { bold: true };
    totalsRow.getCell(3).numFmt = '0.00';
    totalsRow.getCell(4).numFmt = '0.00';
    totalsRow.getCell(5).numFmt = '0.00';
    totalsRow.getCell(6).numFmt = '+0.00;-0.00;0.00';
    totalsRow.getCell(7).numFmt = '"CHF" #,##0.00';
    
    // Column widths
    sheet.columns = [
      { width: 20 }, { width: 12 }, { width: 12 }, { width: 12 },
      { width: 12 }, { width: 14 }, { width: 14 }, { width: 8 },
    ];
    
    // Download
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Ueberstunden_KW${weekNumber}_${format(weekStart, 'yyyy')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    
    toast({ title: 'Excel exportiert', description: `Überstunden KW ${weekNumber} als Excel gespeichert` });
  };

  return (
    <Card className="stat-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Clock className="h-5 w-5" />
            Wöchentliche Überstunden-Übersicht
          </CardTitle>
          <div className="flex items-center gap-2">
            {/* Export buttons */}
            <div className="hidden sm:flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-8 gap-1" onClick={exportToPDF}>
                <FileText className="h-4 w-4" />
                <span className="hidden md:inline">PDF</span>
              </Button>
              <Button variant="outline" size="sm" className="h-8 gap-1" onClick={exportToExcel}>
                <FileSpreadsheet className="h-4 w-4" />
                <span className="hidden md:inline">Excel</span>
              </Button>
            </div>
            <div className="flex items-center gap-1.5 px-2 py-1 bg-muted/50 rounded-md">
              <CalendarDays className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">KW {weekNumber}</span>
              <span className="text-sm text-muted-foreground hidden sm:inline">
                ({weekRange})
              </span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="p-3 bg-muted/30 rounded-lg">
            <p className="text-xs text-muted-foreground">Soll-Stunden</p>
            <p className="text-lg font-bold">{formatHours(totals.expectedHours)}</p>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg">
            <p className="text-xs text-muted-foreground">Plan-Stunden</p>
            <p className="text-lg font-bold">{formatHours(totals.plannedHours)}</p>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg">
            <p className="text-xs text-muted-foreground">Ist-Stunden</p>
            <p className="text-lg font-bold">{formatHours(totals.actualHours)}</p>
          </div>
          <div className={cn(
            "p-3 rounded-lg",
            totals.overtimeHours > 0 ? 'bg-destructive/10' : 'bg-green-500/10'
          )}>
            <p className="text-xs text-muted-foreground">Überstunden</p>
            <p className={cn("text-lg font-bold", getOvertimeColor(totals.overtimeHours))}>
              {totals.overtimeHours > 0 ? '+' : ''}{formatHours(totals.overtimeHours)}
            </p>
          </div>
          <div className={cn(
            "p-3 rounded-lg",
            totals.overtimeCost > 0 ? 'bg-destructive/10' : 'bg-green-500/10'
          )}>
            <p className="text-xs text-muted-foreground">Überstunden-Kosten</p>
            <p className={cn("text-lg font-bold", getOvertimeColor(totals.overtimeCost))}>
              {totals.overtimeCost > 0 ? '+' : ''}{formatCurrency(totals.overtimeCost)}
            </p>
          </div>
        </div>

        {/* Overtime Bar Chart */}
        {weeklyData.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground">Überstunden-Verteilung</h4>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={weeklyData.map(d => ({
                    name: d.employee.name.split(' ')[0], // First name only for compact display
                    fullName: d.employee.name,
                    overtime: d.overtimeHours,
                    department: d.employee.department,
                  }))}
                  layout="vertical"
                  margin={{ top: 5, right: 30, left: 60, bottom: 5 }}
                >
                  <XAxis 
                    type="number" 
                    tickFormatter={(value) => `${value > 0 ? '+' : ''}${value.toFixed(1)}h`}
                    domain={['dataMin', 'dataMax']}
                  />
                  <YAxis 
                    type="category" 
                    dataKey="name" 
                    width={55}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip 
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        return (
                          <div className="bg-popover border border-border rounded-lg shadow-lg p-2 text-sm">
                            <p className="font-medium">{data.fullName}</p>
                            <p className="text-muted-foreground capitalize">{data.department}</p>
                            <p className={cn(
                              "font-mono font-medium",
                              data.overtime > 0 ? 'text-destructive' : data.overtime < 0 ? 'text-green-600' : 'text-muted-foreground'
                            )}>
                              {data.overtime > 0 ? '+' : ''}{formatHours(data.overtime)} Überstunden
                            </p>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <ReferenceLine x={0} stroke="hsl(var(--border))" strokeWidth={2} />
                  <Bar dataKey="overtime" radius={[0, 4, 4, 0]}>
                    {weeklyData.map((entry, index) => (
                      <Cell 
                        key={`cell-${index}`}
                        fill={entry.overtimeHours > 0 
                          ? 'hsl(var(--destructive))' 
                          : entry.overtimeHours < 0 
                            ? 'hsl(142 76% 36%)' 
                            : 'hsl(var(--muted-foreground))'
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center justify-center gap-4 text-xs">
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded bg-destructive" />
                <span>Überstunden</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded bg-green-600" />
                <span>Minusstunden</span>
              </div>
            </div>
          </div>
        )}

        {/* Employee Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-left py-2 px-2 font-medium">Mitarbeiter</th>
                <th className="text-left py-2 px-2 font-medium">Abteilung</th>
                <th className="text-right py-2 px-2 font-medium">Soll</th>
                <th className="text-right py-2 px-2 font-medium">Plan</th>
                <th className="text-right py-2 px-2 font-medium">Ist</th>
                <th className="text-right py-2 px-2 font-medium">Überstunden</th>
                <th className="text-right py-2 px-2 font-medium">Kosten</th>
                <th className="text-right py-2 px-2 font-medium">Tage</th>
              </tr>
            </thead>
            <tbody>
              {weeklyData.map((data) => (
                <tr key={data.employee.id} className="border-b border-border/50">
                  <td className="py-2 px-2 font-medium">{data.employee.name}</td>
                  <td className="py-2 px-2 capitalize text-muted-foreground">{data.employee.department}</td>
                  <td className="text-right py-2 px-2 font-mono">{formatHours(data.expectedHours)}</td>
                  <td className="text-right py-2 px-2 font-mono">{formatHours(data.plannedHours)}</td>
                  <td className="text-right py-2 px-2 font-mono">
                    {data.actualHours > 0 ? formatHours(data.actualHours) : '-'}
                  </td>
                  <td className="text-right py-2 px-2">
                    <div className="flex items-center justify-end gap-1">
                      {getOvertimeIcon(data.overtimeHours)}
                      <span className={cn("font-mono", getOvertimeColor(data.overtimeHours))}>
                        {data.overtimeHours > 0 ? '+' : ''}{formatHours(data.overtimeHours)}
                      </span>
                    </div>
                  </td>
                  <td className={cn("text-right py-2 px-2 font-mono", getOvertimeColor(data.overtimeCost))}>
                    {data.overtimeCost > 0 ? '+' : ''}{formatCurrency(data.overtimeCost)}
                  </td>
                  <td className="text-right py-2 px-2 font-mono">{data.daysWorked}</td>
                </tr>
              ))}
              {weeklyData.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-muted-foreground py-8">
                    Keine Vollzeit/Teilzeit-Mitarbeiter vorhanden
                  </td>
                </tr>
              )}
            </tbody>
            {weeklyData.length > 0 && (
              <tfoot>
                <tr className="font-semibold bg-muted/50">
                  <td className="py-2 px-2" colSpan={2}>Gesamt</td>
                  <td className="text-right py-2 px-2 font-mono">{formatHours(totals.expectedHours)}</td>
                  <td className="text-right py-2 px-2 font-mono">{formatHours(totals.plannedHours)}</td>
                  <td className="text-right py-2 px-2 font-mono">{formatHours(totals.actualHours)}</td>
                  <td className={cn("text-right py-2 px-2 font-mono", getOvertimeColor(totals.overtimeHours))}>
                    {totals.overtimeHours > 0 ? '+' : ''}{formatHours(totals.overtimeHours)}
                  </td>
                  <td className={cn("text-right py-2 px-2 font-mono", getOvertimeColor(totals.overtimeCost))}>
                    {totals.overtimeCost > 0 ? '+' : ''}{formatCurrency(totals.overtimeCost)}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <p className="text-xs text-muted-foreground">
          * Überstunden = Ist-Stunden − Soll-Wochenstunden. Positive Werte = Überstunden, negative = Minusstunden.
        </p>
      </CardContent>
    </Card>
  );
};
