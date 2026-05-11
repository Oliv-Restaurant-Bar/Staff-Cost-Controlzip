import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format, getISOWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee } from '@/types/personnel';
import { DaySchedule, TimeSlot } from '@/components/schedule-planner/ScheduleGrid';

export type WeekReportDept = 'all' | 'service' | 'küche';

export interface WeeklyReportParams {
  weekStart: Date;
  weekEnd: Date;
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  actualHoursData: Record<string, { hours: number }>;
  dailyBudgets: Record<string, { plannedRevenue?: number; actualRevenue?: number }>;
  department: WeekReportDept;
  restaurantName: string;
  targetPercent: number;
  targetPercentService?: number;
  targetPercentKüche?: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function slotHours(slot: TimeSlot | null | undefined): number {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = (eh + em / 60) - (sh + sm / 60);
  if (h < 0) h += 24;
  return h;
}

function breakDeduction(gross: number): number {
  if (gross >= 7) return 1;
  if (gross >= 5) return 0.5;
  return 0;
}

function dayPlanHours(ds: DaySchedule): number {
  const gross = slotHours(ds.früh) + slotHours(ds.spät);
  return Math.max(0, gross - breakDeduction(gross));
}

function chf(v: number): string {
  return new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(v);
}

function pct(v: number): string {
  return v.toFixed(1) + ' %';
}

function hrs(v: number): string {
  return v.toFixed(1) + ' h';
}

type TrafficStatus = 'green' | 'orange' | 'red' | 'none';

function trafficColor(status: TrafficStatus): [number, number, number] {
  if (status === 'green')  return [22, 163, 74];
  if (status === 'orange') return [217, 119, 6];
  if (status === 'red')    return [220, 38, 38];
  return [148, 163, 184];
}

function quotaStatus(quota: number | null, target: number): TrafficStatus {
  if (quota === null) return 'none';
  if (quota <= target)     return 'green';
  if (quota <= target + 5) return 'orange';
  return 'red';
}

// ── Data computation ──────────────────────────────────────────────────────────

interface DayStats {
  date: Date;
  dateStr: string;
  planHours: number;
  istHours: number;
  planCost: number;
  istCost: number;
  actualRevenue: number | null;
  planHoursService: number;
  planHoursKüche: number;
  istHoursService: number;
  istHoursKüche: number;
  planCostService: number;
  planCostKüche: number;
  istCostService: number;
  istCostKüche: number;
}

function computeDayStats(
  date: Date,
  employees: Employee[],
  scheduleData: Record<string, DaySchedule>,
  actualHoursData: Record<string, { hours: number }>,
  dailyBudgets: Record<string, { plannedRevenue?: number; actualRevenue?: number }>,
  dept: WeekReportDept,
): DayStats {
  const dateStr = format(date, 'yyyy-MM-dd');
  const relevant = employees.filter(e =>
    dept === 'all' || e.department === dept
  );

  let planH = 0, istH = 0, planC = 0, istC = 0;
  let planHS = 0, planHK = 0, istHS = 0, istHK = 0;
  let planCS = 0, planCK = 0, istCS = 0, istCK = 0;

  relevant.forEach(emp => {
    const key = `${emp.id}-${dateStr}`;
    const ds = scheduleData[key];
    const wage = emp.hourlyWage ?? 0;
    const isSvc = emp.department === 'service';

    const ph = ds ? dayPlanHours(ds) : 0;
    const ah = actualHoursData[key]?.hours ?? 0;
    const pc = ph * wage;
    const ac = ah * wage;

    planH += ph; planC += pc;
    istH  += ah; istC  += ac;

    if (isSvc) {
      planHS += ph; planCS += pc;
      istHS  += ah; istCS  += ac;
    } else {
      planHK += ph; planCK += pc;
      istHK  += ah; istCK  += ac;
    }
  });

  const budget = dailyBudgets[dateStr];
  const actualRevenue = budget?.actualRevenue != null && budget.actualRevenue > 0
    ? budget.actualRevenue : null;

  return {
    date, dateStr,
    planHours: planH, istHours: istH, planCost: planC, istCost: istC,
    actualRevenue,
    planHoursService: planHS, planHoursKüche: planHK,
    istHoursService: istHS, istHoursKüche: istHK,
    planCostService: planCS, planCostKüche: planCK,
    istCostService: istCS, istCostKüche: istCK,
  };
}

// ── PDF generation ────────────────────────────────────────────────────────────

export function exportWeeklyReportPDF(params: WeeklyReportParams): void {
  const {
    weekStart, weekEnd, employees, scheduleData, actualHoursData,
    dailyBudgets, department, restaurantName, targetPercent,
    targetPercentService = targetPercent / 2,
    targetPercentKüche   = targetPercent / 2,
  } = params;

  const kw = getISOWeek(weekStart);
  const kwLabel = `KW ${kw} · ${format(weekStart, 'd.M.yyyy', { locale: de })} – ${format(weekEnd, 'd.M.yyyy', { locale: de })}`;
  const deptLabel = department === 'service' ? 'Service' : department === 'küche' ? 'Küche' : 'Gesamt';

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const ML = 14, MR = W - 14;

  // Generate day stats for each day of the week (Mon–Sun)
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  const dayStats = days.map(d =>
    computeDayStats(d, employees, scheduleData, actualHoursData, dailyBudgets, department)
  );

  // Weekly totals
  const totPlanH   = dayStats.reduce((s, d) => s + d.planHours, 0);
  const totIstH    = dayStats.reduce((s, d) => s + d.istHours, 0);
  const totPlanC   = dayStats.reduce((s, d) => s + d.planCost, 0);
  const totIstC    = dayStats.reduce((s, d) => s + d.istCost, 0);
  const totRevenue = dayStats.reduce((s, d) => s + (d.actualRevenue ?? 0), 0);
  const hasRevenue = dayStats.some(d => d.actualRevenue !== null);
  const totQuota   = totRevenue > 0 ? (totIstC / totRevenue) * 100 : null;
  const weekStatus = quotaStatus(totQuota, targetPercent);

  // Dept totals
  const svcPlanH = dayStats.reduce((s, d) => s + d.planHoursService, 0);
  const svcIstH  = dayStats.reduce((s, d) => s + d.istHoursService, 0);
  const svcPlanC = dayStats.reduce((s, d) => s + d.planCostService, 0);
  const svcIstC  = dayStats.reduce((s, d) => s + d.istCostService, 0);
  const kuePlanH = dayStats.reduce((s, d) => s + d.planHoursKüche, 0);
  const kueIstH  = dayStats.reduce((s, d) => s + d.istHoursKüche, 0);
  const kuePlanC = dayStats.reduce((s, d) => s + d.planCostKüche, 0);
  const kueIstC  = dayStats.reduce((s, d) => s + d.istCostKüche, 0);

  // ── PAGE 1 ────────────────────────────────────────────────────────────────

  // ── Header bar ──────────────────────────────────────────────────────────
  doc.setFillColor(30, 30, 30);
  doc.rect(0, 0, W, 22, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(restaurantName, ML, 10);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text('Wochenreport Personal & Kosten', ML, 16);

  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text(`KW ${kw}`, MR - 20, 10, { align: 'right' });
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text(`${format(weekStart, 'd.M.yyyy', { locale: de })} – ${format(weekEnd, 'd.M.yyyy', { locale: de })}`, MR, 16, { align: 'right' });

  doc.setTextColor(0, 0, 0);

  // Subtitle (dept + export date)
  doc.setFontSize(8);
  doc.setFont('helvetica', 'italic');
  doc.text(`Bereich: ${deptLabel}  ·  Exportiert: ${format(new Date(), 'dd.MM.yyyy HH:mm')}`, ML, 27);

  // ── Section A: Weekly Summary ────────────────────────────────────────────
  let y = 32;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('A  Zusammenfassung Woche', ML, y);
  y += 5;

  // Status badge
  const [sr, sg, sb] = trafficColor(weekStatus);
  doc.setFillColor(sr, sg, sb);
  doc.roundedRect(MR - 34, y - 4.5, 34, 7, 2, 2, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  const statusText = weekStatus === 'green' ? '✓  Im Plan' : weekStatus === 'orange' ? '!  Knapp' : weekStatus === 'red' ? '✗  Zu hoch' : '?  Kein Umsatz';
  doc.text(statusText, MR - 17, y, { align: 'center' });
  doc.setTextColor(0, 0, 0);

  // Summary grid (2 rows × 3 cols)
  const summaryItems = [
    { label: 'Umsatz Ist', value: hasRevenue ? chf(totRevenue) : '–', sub: 'Netto Ist-Umsatz' },
    { label: 'Personal Plan', value: chf(totPlanC), sub: hrs(totPlanH) + ' geplant' },
    { label: 'Personal Ist', value: chf(totIstC), sub: hrs(totIstH) + ' Ist-Stunden' },
    { label: 'Abweichung', value: (totIstC - totPlanC >= 0 ? '+' : '') + chf(totIstC - totPlanC), sub: totPlanC > 0 ? ((totIstC - totPlanC) / totPlanC * 100).toFixed(1) + ' %' : '–', red: totIstC > totPlanC },
    { label: 'Personalquote Ist', value: totQuota !== null ? pct(totQuota) : '–', sub: 'Ziel: ' + targetPercent + ' %', red: totQuota !== null && totQuota > targetPercent },
    { label: 'Zielquote', value: pct(targetPercent), sub: 'Max. ' + pct(targetPercent + 5) + ' orange' },
  ];

  const cellW = (MR - ML) / 3;
  const cellH = 14;
  summaryItems.forEach((item, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const cx = ML + col * cellW;
    const cy = y + 3 + row * (cellH + 2);

    doc.setFillColor(249, 250, 251);
    doc.roundedRect(cx, cy, cellW - 1, cellH, 1, 1, 'F');
    doc.setDrawColor(229, 231, 235);
    doc.roundedRect(cx, cy, cellW - 1, cellH, 1, 1, 'S');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(item.label, cx + 2.5, cy + 4);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(item.red ? 220 : 15, item.red ? 38 : 23, item.red ? 38 : 42);
    doc.text(item.value, cx + 2.5, cy + 10);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(item.sub ?? '', cx + 2.5, cy + 13.5);
  });
  doc.setTextColor(0, 0, 0);
  y += 3 + 2 * (cellH + 2) + 6;

  // ── Section B: Service vs. Küche ────────────────────────────────────────
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('B  Service vs. Küche', ML, y);
  y += 4;

  const svcQuota = totRevenue > 0 ? (svcIstC / totRevenue) * 100 : null;
  const kueQuota = totRevenue > 0 ? (kueIstC / totRevenue) * 100 : null;

  const deptRows: (string | { content: string; styles?: object })[][] = [];
  if (department === 'all' || department === 'service') {
    const diffH = svcIstH - svcPlanH;
    const diffC = svcIstC - svcPlanC;
    deptRows.push([
      { content: 'Service', styles: { fontStyle: 'bold', fillColor: [239, 246, 255] } },
      hrs(svcPlanH), hrs(svcIstH),
      (diffH >= 0 ? '+' : '') + hrs(diffH),
      chf(svcPlanC), chf(svcIstC),
      (diffC >= 0 ? '+' : '') + chf(diffC),
      svcQuota !== null ? pct(svcQuota) : '–',
    ]);
  }
  if (department === 'all' || department === 'küche') {
    const diffH = kueIstH - kuePlanH;
    const diffC = kueIstC - kuePlanC;
    deptRows.push([
      { content: 'Küche', styles: { fontStyle: 'bold', fillColor: [255, 247, 237] } },
      hrs(kuePlanH), hrs(kueIstH),
      (diffH >= 0 ? '+' : '') + hrs(diffH),
      chf(kuePlanC), chf(kueIstC),
      (diffC >= 0 ? '+' : '') + chf(diffC),
      kueQuota !== null ? pct(kueQuota) : '–',
    ]);
  }
  if (department === 'all') {
    const diffH = totIstH - totPlanH;
    const diffC = totIstC - totPlanC;
    deptRows.push([
      { content: 'Total', styles: { fontStyle: 'bold', fillColor: [243, 244, 246] } },
      hrs(totPlanH), hrs(totIstH),
      (diffH >= 0 ? '+' : '') + hrs(diffH),
      chf(totPlanC), chf(totIstC),
      (diffC >= 0 ? '+' : '') + chf(diffC),
      totQuota !== null ? pct(totQuota) : '–',
    ]);
  }

  autoTable(doc, {
    startY: y,
    head: [['Abteilung', 'Plan Std.', 'Ist Std.', 'Δ Std.', 'Plan CHF', 'Ist CHF', 'Δ CHF', 'PKQ Ist']],
    body: deptRows,
    theme: 'plain',
    headStyles: { fillColor: [30, 30, 30], textColor: 255, fontSize: 8, fontStyle: 'bold', cellPadding: 2 },
    styles: { fontSize: 8, cellPadding: 2 },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { halign: 'right', cellWidth: 22 },
      2: { halign: 'right', cellWidth: 22 },
      3: { halign: 'right', cellWidth: 22, textColor: [100, 116, 139] },
      4: { halign: 'right', cellWidth: 25 },
      5: { halign: 'right', cellWidth: 25 },
      6: { halign: 'right', cellWidth: 25 },
      7: { halign: 'right', cellWidth: 19 },
    },
    margin: { left: ML, right: 14 },
  });
  y = (doc as any).lastAutoTable.finalY + 6;

  // ── Section C: Daily Overview ────────────────────────────────────────────
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('C  Tagesübersicht', ML, y);
  y += 4;

  const dayRows = dayStats.map(d => {
    const quota = d.actualRevenue != null && d.actualRevenue > 0
      ? (d.istCost / d.actualRevenue) * 100 : null;
    const status = quotaStatus(quota, targetPercent);
    const [r, g, b] = trafficColor(status);
    const diffC = d.istCost - d.planCost;
    const dayName = format(d.date, 'EEE d.M.', { locale: de });
    return [
      dayName,
      d.actualRevenue != null ? chf(d.actualRevenue) : '–',
      hrs(d.planHours), hrs(d.istHours),
      chf(d.planCost), chf(d.istCost),
      { content: (diffC >= 0 ? '+' : '') + chf(diffC), styles: { textColor: diffC > 0 ? [220, 38, 38] : [22, 163, 74] } },
      quota !== null ? { content: pct(quota), styles: { textColor: [r, g, b], fontStyle: 'bold' } } : { content: '–', styles: {} },
    ];
  });

  autoTable(doc, {
    startY: y,
    head: [['Tag', 'Umsatz Ist', 'Plan Std.', 'Ist Std.', 'Plan CHF', 'Ist CHF', 'Δ CHF', 'PKQ']],
    body: dayRows,
    theme: 'striped',
    headStyles: { fillColor: [30, 30, 30], textColor: 255, fontSize: 8, fontStyle: 'bold', cellPadding: 2 },
    styles: { fontSize: 8, cellPadding: 2 },
    columnStyles: {
      0: { cellWidth: 20 },
      1: { halign: 'right', cellWidth: 28 },
      2: { halign: 'right', cellWidth: 20 },
      3: { halign: 'right', cellWidth: 20 },
      4: { halign: 'right', cellWidth: 25 },
      5: { halign: 'right', cellWidth: 25 },
      6: { halign: 'right', cellWidth: 25 },
      7: { halign: 'right', cellWidth: 19 },
    },
    margin: { left: ML, right: 14 },
  });
  y = (doc as any).lastAutoTable.finalY + 8;

  // ── PAGE 2 ────────────────────────────────────────────────────────────────
  doc.addPage();

  // Header on page 2
  doc.setFillColor(30, 30, 30);
  doc.rect(0, 0, W, 12, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text(`${restaurantName}  ·  Wochenreport Personal & Kosten  ·  ${kwLabel}  ·  ${deptLabel}`, ML, 8);
  doc.setTextColor(0, 0, 0);
  y = 18;

  // ── Section D: Critical Days ─────────────────────────────────────────────
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('D  Kritische Tage', ML, y);
  y += 5;

  const criticalDays = dayStats
    .map(d => {
      const quota = d.actualRevenue != null && d.actualRevenue > 0
        ? (d.istCost / d.actualRevenue) * 100 : null;
      const diffC = d.istCost - d.planCost;
      const diffH = d.istHours - d.planHours;
      const issues: string[] = [];
      if (quota !== null && quota > targetPercent) issues.push(`PKQ ${pct(quota)} > Ziel ${targetPercent} %`);
      if (diffC > 200) issues.push(`+${chf(diffC)} über Plan`);
      if (diffH > 3) issues.push(`+${hrs(diffH)} Mehrstunden`);
      if (d.actualRevenue !== null && d.actualRevenue < 5000 && d.istCost > 1500) issues.push('Tiefer Umsatz / hohe Kosten');
      return { d, quota, issues };
    })
    .filter(x => x.issues.length > 0);

  if (criticalDays.length === 0) {
    doc.setFillColor(240, 253, 244);
    doc.setDrawColor(134, 239, 172);
    doc.roundedRect(ML, y, MR - ML, 10, 2, 2, 'FD');
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(22, 163, 74);
    doc.text('✓  Keine kritischen Tage — Woche im Plan.', ML + 4, y + 6.5);
    doc.setTextColor(0, 0, 0);
    y += 16;
  } else {
    criticalDays.forEach(({ d, issues }) => {
      const quota = d.actualRevenue != null && d.actualRevenue > 0
        ? (d.istCost / d.actualRevenue) * 100 : null;
      const status = quotaStatus(quota, targetPercent);
      const [r, g, b] = trafficColor(status);
      const dayLabel = format(d.date, 'EEEE, d. MMMM', { locale: de });

      doc.setFillColor(254, 242, 242);
      doc.setDrawColor(r, g, b);
      doc.roundedRect(ML, y, MR - ML, 9 + issues.length * 4.5, 2, 2, 'FD');

      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(r, g, b);
      doc.text(dayLabel, ML + 3, y + 5);
      doc.setTextColor(0, 0, 0);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      issues.forEach((issue, ii) => {
        doc.text(`• ${issue}`, ML + 5, y + 9.5 + ii * 4.5);
      });
      y += 11 + issues.length * 4.5 + 2;
    });
    y += 4;
  }

  // ── Section E: Insights ──────────────────────────────────────────────────
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('E  Erkenntnisse', ML, y);
  y += 5;

  const insights: string[] = [];

  if (totQuota !== null) {
    if (totQuota <= targetPercent) {
      insights.push(`Die Personalquote der Woche lag bei ${pct(totQuota)} und damit im Ziel (≤ ${targetPercent} %).`);
    } else {
      insights.push(`Die Personalquote der Woche lag bei ${pct(totQuota)} und überschritt das Ziel von ${targetPercent} %.`);
    }
  }

  const diffH = totIstH - totPlanH;
  if (Math.abs(diffH) > 2) {
    insights.push(diffH > 0
      ? `Insgesamt wurden ${hrs(diffH)} mehr Ist-Stunden als geplant geleistet.`
      : `Insgesamt wurden ${hrs(Math.abs(diffH))} weniger Ist-Stunden als geplant geleistet.`
    );
  }

  if (department === 'all') {
    const svcDiffH = svcIstH - svcPlanH;
    const kueDiffH = kueIstH - kuePlanH;
    if (Math.abs(svcDiffH) > 1.5) {
      insights.push(svcDiffH > 0
        ? `Service hatte ${hrs(svcDiffH)} mehr Ist-Stunden als geplant.`
        : `Service war um ${hrs(Math.abs(svcDiffH))} Stunden unter dem Plan.`
      );
    }
    if (Math.abs(kueDiffH) > 1.5) {
      insights.push(kueDiffH > 0
        ? `Küche hatte ${hrs(kueDiffH)} mehr Ist-Stunden als geplant.`
        : `Küche war um ${hrs(Math.abs(kueDiffH))} Stunden unter dem Plan.`
      );
    }
  }

  dayStats.forEach(d => {
    const quota = d.actualRevenue != null && d.actualRevenue > 0
      ? (d.istCost / d.actualRevenue) * 100 : null;
    const dayName = format(d.date, 'EEEE', { locale: de });
    if (quota !== null && quota > targetPercent + 5) {
      insights.push(`${dayName}: Personalquote lag mit ${pct(quota)} deutlich über Ziel.`);
    }
    if (d.actualRevenue !== null && d.actualRevenue > 20000 && d.istCost > d.planCost * 1.15) {
      insights.push(`${dayName}: Trotz hohem Umsatz (${chf(d.actualRevenue)}) waren die Personalkosten stark erhöht.`);
    }
  });

  const bestDay = [...dayStats].filter(d => d.actualRevenue != null).sort((a, b) => (b.actualRevenue ?? 0) - (a.actualRevenue ?? 0))[0];
  if (bestDay?.actualRevenue) {
    const bestQuota = bestDay.istCost / bestDay.actualRevenue * 100;
    insights.push(`Stärkster Tag: ${format(bestDay.date, 'EEEE', { locale: de })} mit Umsatz ${chf(bestDay.actualRevenue)} und PKQ ${pct(bestQuota)}.`);
  }

  if (insights.length === 0) insights.push('Keine besonderen Erkenntnisse für diese Woche.');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  insights.forEach(text => {
    const lines = doc.splitTextToSize('• ' + text, MR - ML - 4);
    doc.text(lines, ML + 2, y);
    y += lines.length * 4.5 + 1;
  });
  y += 4;

  // ── Section F: Recommendations ───────────────────────────────────────────
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('F  Empfehlungen für nächste Woche', ML, y);
  y += 5;

  const recs: string[] = [];

  const diffC = totIstC - totPlanC;
  if (diffC > 300) {
    recs.push(`Personalkosten waren ${chf(diffC)} über Plan — nächste Woche Besetzung gezielt reduzieren.`);
  }

  dayStats.forEach(d => {
    const quota = d.actualRevenue != null && d.actualRevenue > 0
      ? (d.istCost / d.actualRevenue) * 100 : null;
    const dayName = format(d.date, 'EEEE', { locale: de });
    const istDiffH = d.istHours - d.planHours;
    if (quota !== null && quota > targetPercent + 5) {
      recs.push(`${dayName}: Besetzung prüfen — PKQ war mit ${pct(quota)} deutlich über Ziel.`);
    }
    if (istDiffH > 4) {
      recs.push(`${dayName}: Iststunden überschritten Plan um ${hrs(istDiffH)} — Dienstplan anpassen.`);
    }
    if (d.actualRevenue !== null && d.actualRevenue < 5000 && d.istCost > 1200) {
      recs.push(`${dayName}: Tiefer Umsatz (${chf(d.actualRevenue)}) — Minimalbesetzung prüfen.`);
    }
  });

  if (department === 'all' || department === 'küche') {
    const kueDiff = kueIstC - kuePlanC;
    if (kueDiff > 200) {
      recs.push(`Küche: Frühschichten auf Notwendigkeit prüfen (${chf(kueDiff)} über Plan).`);
    }
  }

  if (department === 'all' || department === 'service') {
    const svcDiff = svcIstC - svcPlanC;
    if (svcDiff > 200) {
      recs.push(`Service: Aushilfen nur an Tagen mit Umsatz > CHF 10'000 einsetzen.`);
    }
  }

  if (recs.length === 0) recs.push('Keine spezifischen Handlungsempfehlungen — Woche verlief im Plan.');

  doc.setFillColor(255, 251, 235);
  doc.setDrawColor(217, 119, 6);
  const recH = recs.reduce((s, r) => s + doc.splitTextToSize('• ' + r, MR - ML - 8).length * 4.5 + 1, 0) + 8;
  doc.roundedRect(ML, y - 1, MR - ML, recH + 2, 2, 2, 'FD');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(92, 45, 0);
  y += 3;
  recs.forEach(text => {
    const lines = doc.splitTextToSize('• ' + text, MR - ML - 8);
    doc.text(lines, ML + 4, y);
    y += lines.length * 4.5 + 1;
  });
  doc.setTextColor(0, 0, 0);
  y += 8;

  // ── Footer on each page ──────────────────────────────────────────────────
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    const ph = doc.internal.pageSize.getHeight();
    doc.setFillColor(245, 245, 245);
    doc.rect(0, ph - 10, W, 10, 'F');
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(120, 120, 120);
    doc.text(`${restaurantName}  ·  ${kwLabel}  ·  ${deptLabel}`, ML, ph - 3.5);
    doc.text(`Seite ${p} / ${totalPages}`, MR, ph - 3.5, { align: 'right' });
  }

  // ── Save ────────────────────────────────────────────────────────────────
  const fileName = `Wochenreport_KW${kw}_${format(weekStart, 'yyyy')}_${deptLabel.replace('ü', 'ue')}.pdf`;
  doc.save(fileName);
}
