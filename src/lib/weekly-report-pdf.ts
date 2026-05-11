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

// ── Data helpers (logic unchanged) ───────────────────────────────────────────

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
  return v.toFixed(1) + '%';
}

function hrs(v: number): string {
  return v.toFixed(1) + ' h';
}

function sign(v: number): string {
  return v >= 0 ? '+' : '';
}

type RGB = [number, number, number];
type TrafficStatus = 'green' | 'orange' | 'red' | 'none';

const C = {
  navy:       [30, 41, 59]   as RGB,
  border:     [226, 232, 240] as RGB,
  muted:      [100, 116, 139] as RGB,
  mutedLight: [148, 163, 184] as RGB,
  bgLight:    [248, 250, 252] as RGB,
  indigo:     [99, 102, 241]  as RGB,
  green:  { bg: [240,253,244] as RGB, text: [21,128,61]   as RGB, bar: [74,222,128]  as RGB, border: [134,239,172] as RGB },
  orange: { bg: [255,251,235] as RGB, text: [161,98,7]    as RGB, bar: [251,191,36]  as RGB, border: [253,211,77]  as RGB },
  red:    { bg: [254,242,242] as RGB, text: [153,27,27]   as RGB, bar: [252,165,165] as RGB, border: [252,165,165] as RGB },
  slate:  { bg: [248,250,252] as RGB, text: [100,116,139] as RGB, bar: [148,163,184] as RGB, border: [226,232,240] as RGB },
};

function trafficStatus(quota: number | null, target: number): TrafficStatus {
  if (quota === null) return 'none';
  if (quota <= target)     return 'green';
  if (quota <= target + 5) return 'orange';
  return 'red';
}

function trafficPalette(s: TrafficStatus) {
  if (s === 'green')  return C.green;
  if (s === 'orange') return C.orange;
  if (s === 'red')    return C.red;
  return C.slate;
}

// ── DayStats (logic unchanged) ────────────────────────────────────────────────

interface DayStats {
  date: Date; dateStr: string;
  planHours: number; istHours: number; planCost: number; istCost: number;
  actualRevenue: number | null;
  planHoursService: number; planHoursKüche: number;
  istHoursService: number;  istHoursKüche: number;
  planCostService: number;  planCostKüche: number;
  istCostService: number;   istCostKüche: number;
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
  const relevant = employees.filter(e => dept === 'all' || e.department === dept);
  let planH=0, istH=0, planC=0, istC=0;
  let planHS=0, planHK=0, istHS=0, istHK=0, planCS=0, planCK=0, istCS=0, istCK=0;

  relevant.forEach(emp => {
    const key = `${emp.id}-${dateStr}`;
    const ds = scheduleData[key];
    const wage = emp.hourlyWage ?? 0;
    const isSvc = emp.department === 'service';
    const ph = ds ? dayPlanHours(ds) : 0;
    const ah = actualHoursData[key]?.hours ?? 0;
    planH += ph; planC += ph * wage;
    istH  += ah; istC  += ah * wage;
    if (isSvc) { planHS+=ph; planCS+=ph*wage; istHS+=ah; istCS+=ah*wage; }
    else        { planHK+=ph; planCK+=ph*wage; istHK+=ah; istCK+=ah*wage; }
  });

  const budget = dailyBudgets[dateStr];
  const actualRevenue = budget?.actualRevenue != null && budget.actualRevenue > 0 ? budget.actualRevenue : null;
  return {
    date, dateStr,
    planHours: planH, istHours: istH, planCost: planC, istCost: istC,
    actualRevenue,
    planHoursService: planHS, planHoursKüche: planHK,
    istHoursService: istHS,   istHoursKüche: istHK,
    planCostService: planCS,  planCostKüche: planCK,
    istCostService: istCS,    istCostKüche: istCK,
  };
}

// ── Drawing helpers ───────────────────────────────────────────────────────────

function sectionLabel(doc: jsPDF, text: string, x: number, y: number, rightW: number): void {
  const [r,g,b] = C.navy;
  doc.setFillColor(r, g, b);
  doc.rect(x, y - 3.5, 2.5, 5.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(r, g, b);
  doc.text(text, x + 4.5, y);
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.25);
  doc.line(x, y + 2.5, x + rightW, y + 2.5);
}

function statusPill(doc: jsPDF, status: TrafficStatus, x: number, y: number): void {
  const pal = trafficPalette(status);
  const label = status === 'green' ? 'Im Plan' : status === 'orange' ? 'Knapp' : status === 'red' ? 'Zu hoch' : 'Kein Umsatz';
  const pw = 28, ph = 6.5;
  doc.setFillColor(...pal.bg);
  doc.setDrawColor(...pal.border);
  doc.setLineWidth(0.4);
  doc.roundedRect(x, y - 5, pw, ph, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...pal.text);
  doc.text(label, x + pw / 2, y - 0.2, { align: 'center' });
}

// ── Bar chart (manual jsPDF drawing) ─────────────────────────────────────────

interface BarChartOpts {
  x: number; y: number; w: number; h: number;
  planValues?: number[];      // grey reference bars
  istValues: number[];        // main bars
  labels: string[];
  targetValue?: number;       // draw target line
  maxCap?: number;            // clamp scale; outliers get annotated
  unit?: string;
  isPercentage?: boolean;
}

function drawBarChart(doc: jsPDF, o: BarChartOpts): void {
  const { x, y, w, h, planValues, istValues, labels, targetValue, maxCap, unit='', isPercentage=false } = o;
  const LEFT_PAD = 9, BOTTOM_PAD = 7;
  const px = x + LEFT_PAD, py = y;
  const pw = w - LEFT_PAD, ph = h - BOTTOM_PAD;

  // Scale
  const allVals = [...istValues, ...(planValues ?? []), targetValue ?? 0].filter(v => v > 0);
  const rawMax = Math.max(...allVals, 1);
  const scaleMax = maxCap != null ? Math.max(maxCap, targetValue ?? 0) : rawMax * 1.1;
  const scale = ph / scaleMax;

  // Background + border
  doc.setFillColor(...C.bgLight);
  doc.rect(px, py, pw, ph, 'F');
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.2);
  doc.rect(px, py, pw, ph, 'S');

  // Grid lines + y-axis labels
  const gridCount = 3;
  for (let g = 1; g <= gridCount; g++) {
    const gy = py + ph - (ph / gridCount) * g;
    const gVal = (scaleMax / gridCount) * g;
    doc.setDrawColor(237, 242, 247);
    doc.setLineWidth(0.15);
    doc.line(px, gy, px + pw, gy);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5);
    doc.setTextColor(...C.mutedLight);
    const label = gVal >= 1000
      ? (gVal / 1000).toFixed(0) + 'k'
      : gVal.toFixed(isPercentage && gVal < 10 ? 1 : 0) + unit;
    doc.text(label, px - 1, gy + 1, { align: 'right' });
  }

  // Target line (indigo dashed)
  if (targetValue != null && targetValue > 0 && targetValue <= scaleMax) {
    const ty = py + ph - targetValue * scale;
    doc.setDrawColor(...C.indigo);
    doc.setLineWidth(0.45);
    const dash = 2, gap = 1.5;
    let lx = px;
    while (lx < px + pw) {
      doc.line(lx, ty, Math.min(lx + dash, px + pw), ty);
      lx += dash + gap;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(5);
    doc.setTextColor(...C.indigo);
    doc.text('Ziel', px + pw + 1, ty + 1.2);
  }

  // Bars
  const n = labels.length;
  const groupW = pw / n;

  istValues.forEach((val, i) => {
    const isOutlier = maxCap != null && val > maxCap;
    const displayVal = isOutlier ? scaleMax * 0.98 : Math.min(val, scaleMax);
    const bh = Math.max(displayVal * scale, 0.5);

    if (planValues) {
      // Grouped bars: Plan (slate) + Ist (colored)
      const planVal = planValues[i] ?? 0;
      const planH = Math.min(planVal, scaleMax) * scale;
      const planBW = groupW * 0.36;
      const istBW  = groupW * 0.36;
      const gapBetween = groupW * 0.04;
      const totalBW = planBW + gapBetween + istBW;
      const startX = px + i * groupW + (groupW - totalBW) / 2;

      // Plan bar
      doc.setFillColor(...C.slate.bar);
      doc.rect(startX, py + ph - planH, planBW, Math.max(planH, 0.5), 'F');

      // Ist bar
      const isOver = val > planVal;
      const barCol = isOver ? C.red.bar : C.green.bar;
      doc.setFillColor(...barCol);
      doc.rect(startX + planBW + gapBetween, py + ph - bh, istBW, bh, 'F');

      if (isOutlier) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(5.5);
        doc.setTextColor(...C.red.text);
        doc.text('!', startX + planBW + gapBetween + istBW / 2, py + 2.5, { align: 'center' });
      }
    } else {
      // Single bar (PKQ chart)
      const barBW = groupW * 0.62;
      const bx = px + i * groupW + (groupW - barBW) / 2;
      let barCol: RGB;
      if (targetValue != null) {
        const s = trafficStatus(val, targetValue);
        barCol = trafficPalette(s).bar;
      } else {
        barCol = C.indigo;
      }
      doc.setFillColor(...(isOutlier ? C.red.bar : barCol));
      doc.rect(bx, py + ph - bh, barBW, bh, 'F');

      // Value label above bar (only if not too small)
      if (bh > 5 && !isOutlier) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(5.5);
        doc.setTextColor(60, 60, 60);
        doc.text(val.toFixed(0) + unit, bx + barBW / 2, py + ph - bh - 1, { align: 'center' });
      }
      if (isOutlier) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6);
        doc.setTextColor(...C.red.text);
        doc.text('!', bx + barBW / 2, py + 2.5, { align: 'center' });
        doc.setFontSize(4.5);
        doc.text(val.toFixed(0) + unit, bx + barBW / 2, py + 5.5, { align: 'center' });
      }
    }

    // Day label
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5.5);
    doc.setTextColor(...C.muted);
    doc.text(labels[i], px + i * groupW + groupW / 2, py + ph + 5, { align: 'center' });
  });
}

// ── Main export function ──────────────────────────────────────────────────────

export function exportWeeklyReportPDF(params: WeeklyReportParams): void {
  const {
    weekStart, weekEnd, employees, scheduleData, actualHoursData,
    dailyBudgets, department, restaurantName, targetPercent,
    targetPercentService = targetPercent,
    targetPercentKüche   = targetPercent,
  } = params;

  const kw = getISOWeek(weekStart);
  const kwRange = `${format(weekStart, 'd.M.yyyy', { locale: de })} – ${format(weekEnd, 'd.M.yyyy', { locale: de })}`;
  const kwFull  = `KW ${kw}  ·  ${kwRange}`;
  const deptLabel = department === 'service' ? 'Service' : department === 'küche' ? 'Küche' : 'Gesamt';

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const ML = 14, MR = W - 14, CW = MR - ML;

  // Build day data
  const days: Date[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart); d.setDate(d.getDate() + i); return d;
  });
  const dayStats = days.map(d =>
    computeDayStats(d, employees, scheduleData, actualHoursData, dailyBudgets, department)
  );

  // Weekly totals
  const totPlanH   = dayStats.reduce((s,d) => s + d.planHours, 0);
  const totIstH    = dayStats.reduce((s,d) => s + d.istHours, 0);
  const totPlanC   = dayStats.reduce((s,d) => s + d.planCost, 0);
  const totIstC    = dayStats.reduce((s,d) => s + d.istCost, 0);
  const totRevenue = dayStats.reduce((s,d) => s + (d.actualRevenue ?? 0), 0);
  const hasRevenue = dayStats.some(d => d.actualRevenue !== null);
  const totQuota   = totRevenue > 0 ? (totIstC / totRevenue) * 100 : null;
  const weekStat   = trafficStatus(totQuota, targetPercent);

  // Dept totals
  const svcPlanH=dayStats.reduce((s,d)=>s+d.planHoursService,0);
  const svcIstH =dayStats.reduce((s,d)=>s+d.istHoursService,0);
  const svcPlanC=dayStats.reduce((s,d)=>s+d.planCostService,0);
  const svcIstC =dayStats.reduce((s,d)=>s+d.istCostService,0);
  const kuePlanH=dayStats.reduce((s,d)=>s+d.planHoursKüche,0);
  const kueIstH =dayStats.reduce((s,d)=>s+d.istHoursKüche,0);
  const kuePlanC=dayStats.reduce((s,d)=>s+d.planCostKüche,0);
  const kueIstC =dayStats.reduce((s,d)=>s+d.istCostKüche,0);

  // Per-day PKQ (for charts + table)
  const dayQuotas = dayStats.map(d =>
    d.actualRevenue != null && d.actualRevenue > 0 ? (d.istCost / d.actualRevenue) * 100 : null
  );
  const dayLabels = dayStats.map(d => format(d.date, 'EEE', { locale: de }).slice(0, 2));

  // PKQ chart cap: 2× target, so outliers don't destroy the scale
  const pkqChartCap = targetPercent * 2.5;

  // ════════════════════════════════════════════════════════════════════════════
  // PAGE 1
  // ════════════════════════════════════════════════════════════════════════════

  // ── Header ────────────────────────────────────────────────────────────────
  const HEADER_H = 26;
  doc.setFillColor(...C.navy);
  doc.rect(0, 0, W, HEADER_H, 'F');

  // Restaurant + subtitle
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(restaurantName, ML, 11);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(148, 163, 184);
  doc.text('Wochenreport Personal & Kosten', ML, 18);

  // KW right-aligned
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(255, 255, 255);
  doc.text(`KW ${kw}`, MR, 12, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text(kwRange, MR, 19, { align: 'right' });

  doc.setTextColor(0, 0, 0);

  // Meta line
  let y = HEADER_H + 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...C.muted);
  doc.text(`Bereich: ${deptLabel}  ·  Export: ${format(new Date(), 'dd.MM.yyyy, HH:mm')}`, ML, y);
  y += 6;

  // ── Section A: KPI Cards ──────────────────────────────────────────────────
  sectionLabel(doc, 'Zusammenfassung Woche', ML, y, CW);

  // Status pill aligned to right of section heading
  statusPill(doc, weekStat, MR - 30, y);
  y += 5;

  const CARD_W = CW / 3 - 1.5;
  const CARD_H = 20;
  const CARD_GAP = 2;

  const summaryCards = [
    {
      label: 'Umsatz Ist',
      value: hasRevenue ? chf(totRevenue) : '–',
      sub: 'Netto-Umsatz Woche',
      status: 'none' as TrafficStatus,
    },
    {
      label: 'Personal Plan',
      value: chf(totPlanC),
      sub: hrs(totPlanH) + ' geplant',
      status: 'none' as TrafficStatus,
    },
    {
      label: 'Personal Ist',
      value: chf(totIstC),
      sub: hrs(totIstH) + ' Ist-Stunden',
      status: 'none' as TrafficStatus,
    },
    {
      label: 'Abweichung',
      value: sign(totIstC - totPlanC) + chf(totIstC - totPlanC),
      sub: totPlanC > 0 ? sign(totIstC - totPlanC) + ((totIstC - totPlanC) / totPlanC * 100).toFixed(1) + '%' : '–',
      status: totIstC > totPlanC ? 'red' : totIstC > totPlanC * 0.97 ? 'orange' : 'green' as TrafficStatus,
    },
    {
      label: 'Personalquote Ist',
      value: totQuota !== null ? pct(totQuota) : '–',
      sub: 'Ziel: ' + pct(targetPercent),
      status: weekStat,
    },
    {
      label: 'Zielquote',
      value: pct(targetPercent),
      sub: 'Grenzwert: ' + pct(targetPercent + 5),
      status: 'none' as TrafficStatus,
    },
  ];

  summaryCards.forEach((card, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const cx = ML + col * (CARD_W + CARD_GAP);
    const cy = y + row * (CARD_H + CARD_GAP);
    const pal = trafficPalette(card.status);

    // Card bg
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(cx, cy, CARD_W, CARD_H, 1.5, 1.5, 'FD');

    // Colored left accent strip
    if (card.status !== 'none') {
      doc.setFillColor(...pal.border);
      doc.roundedRect(cx, cy, 2.5, CARD_H, 1, 1, 'F');
      doc.setFillColor(...pal.border);
      doc.rect(cx + 1, cy, 1.5, CARD_H, 'F'); // square off right side of strip
    }

    // Label
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...C.muted);
    doc.text(card.label, cx + 5, cy + 5.5);

    // Value
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(card.value.length > 10 ? 10 : 12);
    doc.setTextColor(...(card.status !== 'none' ? pal.text : C.navy));
    doc.text(card.value, cx + 5, cy + 13);

    // Sub-label
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...C.mutedLight);
    doc.text(card.sub, cx + 5, cy + 18);
  });

  doc.setTextColor(0, 0, 0);
  y += 2 * CARD_H + CARD_GAP + 7;

  // ── Section B: Service vs. Küche ──────────────────────────────────────────
  sectionLabel(doc, 'Service vs. Küche', ML, y, CW);
  y += 5;

  const svcQuota = totRevenue > 0 ? (svcIstC / totRevenue) * 100 : null;
  const kueQuota = totRevenue > 0 ? (kueIstC / totRevenue) * 100 : null;

  type ATableCell = string | { content: string; styles?: object };
  const deptRows: ATableCell[][] = [];

  if (department === 'all' || department === 'service') {
    const dH = svcIstH - svcPlanH, dC = svcIstC - svcPlanC;
    deptRows.push([
      { content: 'Service', styles: { fontStyle: 'bold' } },
      hrs(svcPlanH), hrs(svcIstH),
      { content: sign(dH) + hrs(dH), styles: { textColor: dH > 0 ? C.red.text : C.green.text } },
      chf(svcPlanC), chf(svcIstC),
      { content: sign(dC) + chf(dC), styles: { textColor: dC > 0 ? C.red.text : C.green.text } },
      svcQuota !== null ? pct(svcQuota) : '–',
    ]);
  }
  if (department === 'all' || department === 'küche') {
    const dH = kueIstH - kuePlanH, dC = kueIstC - kuePlanC;
    deptRows.push([
      { content: 'Küche', styles: { fontStyle: 'bold' } },
      hrs(kuePlanH), hrs(kueIstH),
      { content: sign(dH) + hrs(dH), styles: { textColor: dH > 0 ? C.red.text : C.green.text } },
      chf(kuePlanC), chf(kueIstC),
      { content: sign(dC) + chf(dC), styles: { textColor: dC > 0 ? C.red.text : C.green.text } },
      kueQuota !== null ? pct(kueQuota) : '–',
    ]);
  }
  if (department === 'all') {
    const dH = totIstH - totPlanH, dC = totIstC - totPlanC;
    deptRows.push([
      { content: 'Total', styles: { fontStyle: 'bold', fillColor: [248, 250, 252] } },
      hrs(totPlanH), hrs(totIstH),
      { content: sign(dH) + hrs(dH), styles: { textColor: dH > 0 ? C.red.text : C.green.text, fontStyle: 'bold' } },
      chf(totPlanC), chf(totIstC),
      { content: sign(dC) + chf(dC), styles: { textColor: dC > 0 ? C.red.text : C.green.text, fontStyle: 'bold' } },
      totQuota !== null
        ? { content: pct(totQuota), styles: { textColor: trafficPalette(weekStat).text, fontStyle: 'bold' } }
        : '–',
    ]);
  }

  autoTable(doc, {
    startY: y,
    head: [['Abteilung', 'Plan Std.', 'Ist Std.', 'Diff. Std.', 'Plan CHF', 'Ist CHF', 'Diff. CHF', 'PKQ %']],
    body: deptRows,
    theme: 'plain',
    headStyles: { fillColor: C.navy, textColor: [255,255,255], fontSize: 7.5, fontStyle: 'bold', cellPadding: 3 },
    styles: { fontSize: 8, cellPadding: { top: 3, bottom: 3, left: 2, right: 2 } },
    alternateRowStyles: { fillColor: [252, 252, 253] },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { halign: 'right', cellWidth: 21 },
      2: { halign: 'right', cellWidth: 21 },
      3: { halign: 'right', cellWidth: 22 },
      4: { halign: 'right', cellWidth: 25 },
      5: { halign: 'right', cellWidth: 26 },
      6: { halign: 'right', cellWidth: 26 },
      7: { halign: 'right', cellWidth: 19 },
    },
    margin: { left: ML, right: 14 },
  });
  y = (doc as any).lastAutoTable.finalY + 7;

  // ── Section C: Daily Overview ─────────────────────────────────────────────
  sectionLabel(doc, 'Tagesübersicht', ML, y, CW);
  y += 5;

  const dayRows = dayStats.map((d, i) => {
    const quota = dayQuotas[i];
    const isOutlier = quota !== null && quota > pkqChartCap;
    const qStatus = trafficStatus(quota, targetPercent);
    const qPal    = trafficPalette(qStatus);
    const diffC   = d.istCost - d.planCost;
    const dayName = format(d.date, 'EEE, d.M.', { locale: de });

    let pkqCell: ATableCell;
    if (quota === null) {
      pkqCell = { content: '–', styles: { textColor: C.muted } };
    } else if (isOutlier) {
      pkqCell = {
        content: pct(quota) + ' !',
        styles: { textColor: C.red.text, fontStyle: 'bold', fontSize: 6.5 },
      };
    } else {
      pkqCell = {
        content: pct(quota),
        styles: { textColor: qPal.text, fontStyle: 'bold' },
      };
    }

    return [
      dayName,
      d.actualRevenue != null
        ? { content: chf(d.actualRevenue), styles: { fontStyle: 'bold' } }
        : { content: '–', styles: { textColor: C.muted } },
      hrs(d.planHours),
      hrs(d.istHours),
      chf(d.planCost),
      { content: chf(d.istCost), styles: { fontStyle: d.istCost > d.planCost ? 'bold' : 'normal' } },
      {
        content: sign(diffC) + chf(diffC),
        styles: { textColor: diffC > 100 ? C.red.text : diffC < -100 ? C.green.text : C.muted },
      },
      pkqCell,
    ];
  });

  autoTable(doc, {
    startY: y,
    head: [['Tag', 'Umsatz Ist', 'Plan Std.', 'Ist Std.', 'Plan CHF', 'Ist CHF', 'Diff. CHF', 'PKQ %']],
    body: dayRows,
    theme: 'plain',
    headStyles: { fillColor: C.navy, textColor: [255,255,255], fontSize: 7.5, fontStyle: 'bold', cellPadding: 3 },
    styles: { fontSize: 8, cellPadding: { top: 2.5, bottom: 2.5, left: 2, right: 2 } },
    alternateRowStyles: { fillColor: [252, 252, 253] },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { halign: 'right', cellWidth: 28 },
      2: { halign: 'right', cellWidth: 20 },
      3: { halign: 'right', cellWidth: 20 },
      4: { halign: 'right', cellWidth: 25 },
      5: { halign: 'right', cellWidth: 25 },
      6: { halign: 'right', cellWidth: 25 },
      7: { halign: 'right', cellWidth: 17 },
    },
    margin: { left: ML, right: 14 },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // PAGE 2
  // ════════════════════════════════════════════════════════════════════════════
  doc.addPage();

  // Mini header strip
  doc.setFillColor(...C.navy);
  doc.rect(0, 0, W, 11, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(255, 255, 255);
  doc.text(`${restaurantName}  ·  Wochenreport Personal & Kosten  ·  ${kwFull}  ·  ${deptLabel}`, ML, 7.5);
  doc.setTextColor(0, 0, 0);
  y = 17;

  // ── Section D: Critical Days ──────────────────────────────────────────────
  sectionLabel(doc, 'Kritische Tage', ML, y, CW);
  y += 5;

  const criticalDays = dayStats
    .map((d, i) => {
      const quota = dayQuotas[i];
      const diffC = d.istCost - d.planCost;
      const diffH = d.istHours - d.planHours;
      const issues: string[] = [];
      if (quota !== null && quota > targetPercent)
        issues.push(`PKQ ${pct(quota)} (Ziel ${pct(targetPercent)})`);
      if (diffC > 200)
        issues.push(`${sign(diffC)}${chf(diffC)} über Plan`);
      if (diffH > 3)
        issues.push(`${sign(diffH)}${hrs(diffH)} Mehrstunden`);
      if (d.actualRevenue !== null && d.actualRevenue < 5000 && d.istCost > 1500)
        issues.push('Tiefer Umsatz bei hohen Kosten');
      return { d, quota, issues, status: trafficStatus(quota, targetPercent) };
    })
    .filter(x => x.issues.length > 0)
    .slice(0, 4); // cap at 4 to ensure page fit

  if (criticalDays.length === 0) {
    const pal = C.green;
    doc.setFillColor(...pal.bg);
    doc.setDrawColor(...pal.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(ML, y, CW, 9, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...pal.text);
    doc.text('Keine kritischen Tage — Woche verlief im Plan', ML + 5, y + 6);
    doc.setTextColor(0, 0, 0);
    y += 14;
  } else {
    criticalDays.forEach(({ d, issues, status }) => {
      const pal = trafficPalette(status);
      const boxH = 8 + issues.length * 4.8;
      doc.setFillColor(...pal.bg);
      doc.setDrawColor(...pal.border);
      doc.setLineWidth(0.3);
      doc.roundedRect(ML, y, CW, boxH, 1.5, 1.5, 'FD');
      // Left accent
      doc.setFillColor(...pal.border);
      doc.roundedRect(ML, y, 2.5, boxH, 1, 1, 'F');
      doc.rect(ML + 1, y, 1.5, boxH, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...pal.text);
      doc.text(format(d.date, 'EEEE, d. MMMM', { locale: de }), ML + 5, y + 5.5);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(60, 60, 60);
      issues.forEach((issue, ii) => {
        doc.text('·  ' + issue, ML + 7, y + 9.5 + ii * 4.8);
      });
      y += boxH + 3;
    });
    y += 3;
  }

  // ── Section E: Charts ─────────────────────────────────────────────────────
  sectionLabel(doc, 'Wochendiagramme', ML, y, CW);
  y += 6;

  const CHART_H = 43;
  const halfCW = CW / 2 - 3;

  // Legend for Chart A
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...C.navy);
  doc.text('Plan vs. Ist Kosten (CHF)', ML, y);
  doc.setFillColor(...C.slate.bar);
  doc.rect(ML + CW / 2 - 22, y - 3.5, 5, 3, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...C.muted);
  doc.text('Plan', ML + CW / 2 - 16, y - 1);
  doc.setFillColor(...C.green.bar);
  doc.rect(ML + CW / 2 - 8, y - 3.5, 5, 3, 'F');
  doc.text('Ist (OK)', ML + CW / 2 - 2, y - 1);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(...C.navy);
  doc.text('Personalquote pro Tag (%)', ML + halfCW + 6, y);
  y += 2;

  // Chart A: Plan vs Ist costs
  drawBarChart(doc, {
    x: ML, y, w: halfCW, h: CHART_H,
    planValues: dayStats.map(d => d.planCost),
    istValues:  dayStats.map(d => d.istCost),
    labels: dayLabels,
    unit: '',
  });

  // Chart B: PKQ per day
  const validQuotas = dayQuotas.map(q => q ?? 0);
  drawBarChart(doc, {
    x: ML + halfCW + 6, y, w: halfCW, h: CHART_H,
    istValues: validQuotas,
    labels: dayLabels,
    targetValue: targetPercent,
    maxCap: pkqChartCap,
    unit: '%',
    isPercentage: true,
  });

  y += CHART_H + 10;

  // Outlier legend (if any)
  if (dayQuotas.some(q => q !== null && q > pkqChartCap)) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(6.5);
    doc.setTextColor(...C.red.text);
    doc.text(
      '!  Tage mit Ausreisser-PKQ (Umsatz zu tief): Wert wird im Chart begrenzt dargestellt, echter Wert steht in Tagesübersicht.',
      ML, y
    );
    y += 6;
  }

  // ── Section F: Insights ───────────────────────────────────────────────────
  sectionLabel(doc, 'Erkenntnisse', ML, y, CW);
  y += 5;

  const insights: string[] = [];
  if (totQuota !== null) {
    if (totQuota <= targetPercent)
      insights.push(`Personalquote Woche: ${pct(totQuota)} — im Ziel (Ziel: ${pct(targetPercent)}).`);
    else
      insights.push(`Personalquote Woche: ${pct(totQuota)} — Ziel von ${pct(targetPercent)} überschritten.`);
  }
  const totDiffH = totIstH - totPlanH;
  if (Math.abs(totDiffH) > 2)
    insights.push(totDiffH > 0
      ? `Total ${hrs(totDiffH)} mehr Ist-Stunden als geplant.`
      : `Total ${hrs(Math.abs(totDiffH))} weniger Ist-Stunden als geplant.`
    );
  if (department === 'all') {
    const sdH = svcIstH - svcPlanH;
    const kdH = kueIstH - kuePlanH;
    if (Math.abs(sdH) > 1.5)
      insights.push(sdH > 0 ? `Service: ${hrs(sdH)} Mehrstunden.` : `Service: ${hrs(Math.abs(sdH))} unter Plan.`);
    if (Math.abs(kdH) > 1.5)
      insights.push(kdH > 0 ? `Küche: ${hrs(kdH)} Mehrstunden.` : `Küche: ${hrs(Math.abs(kdH))} unter Plan.`);
  }
  const bestDay = [...dayStats].filter(d => d.actualRevenue != null)
    .sort((a, b) => (b.actualRevenue ?? 0) - (a.actualRevenue ?? 0))[0];
  if (bestDay?.actualRevenue) {
    const bq = bestDay.istCost / bestDay.actualRevenue * 100;
    insights.push(
      `Stärkster Tag: ${format(bestDay.date, 'EEEE', { locale: de })} — Umsatz ${chf(bestDay.actualRevenue)}, PKQ ${pct(bq)}.`
    );
  }
  if (insights.length === 0) insights.push('Keine besonderen Erkenntnisse für diese Woche.');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(40, 40, 40);
  insights.slice(0, 5).forEach(text => {
    const lines = doc.splitTextToSize('·  ' + text, CW - 4);
    doc.text(lines, ML + 2, y);
    y += lines.length * 4.8 + 0.8;
  });
  y += 5;

  // ── Section G: Recommendations (grouped) ─────────────────────────────────
  sectionLabel(doc, 'Empfehlungen für nächste Woche', ML, y, CW);
  y += 5;

  interface RecGroup { label: string; color: RGB; items: string[] }
  const groups: RecGroup[] = [
    { label: 'Gesamt',          color: C.navy,       items: [] },
    { label: 'Service',         color: C.indigo,     items: [] },
    { label: 'Küche',           color: [234,88,12],  items: [] },
    { label: 'Kritische Tage',  color: C.red.text,   items: [] },
  ];

  const totDiffC = totIstC - totPlanC;
  if (totDiffC > 300)
    groups[0].items.push(`Personalkosten waren ${chf(totDiffC)} über Plan — Besetzung reduzieren.`);
  if (totQuota !== null && totQuota > targetPercent)
    groups[0].items.push(`Zielquote ${pct(targetPercent)} anstreben — aktuell ${pct(totQuota)}.`);

  if (department === 'all' || department === 'service') {
    const svcDiff = svcIstC - svcPlanC;
    if (svcDiff > 200)
      groups[1].items.push(`Mehrkosten ${chf(svcDiff)} — Aushilfen nur an starken Tagen einsetzen.`);
    const svcDiffH2 = svcIstH - svcPlanH;
    if (svcDiffH2 > 5)
      groups[1].items.push(`Planstunden um ca. ${hrs(svcDiffH2)} reduzieren.`);
  }
  if (department === 'all' || department === 'küche') {
    const kueDiff = kueIstC - kuePlanC;
    if (kueDiff > 200)
      groups[2].items.push(`Mehrkosten ${chf(kueDiff)} — Frühschichten prüfen.`);
  }

  dayStats.forEach((d, i) => {
    const quota = dayQuotas[i];
    const dayName = format(d.date, 'EEEE', { locale: de });
    const istDiffH = d.istHours - d.planHours;
    if (quota !== null && quota > targetPercent + 5 && d.actualRevenue !== null && d.actualRevenue > 500)
      groups[3].items.push(`${dayName}: PKQ ${pct(quota)} — Besetzung anpassen.`);
    if (istDiffH > 4)
      groups[3].items.push(`${dayName}: ${hrs(istDiffH)} Mehrstunden — Dienstplan prüfen.`);
    if (d.actualRevenue !== null && d.actualRevenue < 5000 && d.istCost > 1200)
      groups[3].items.push(`${dayName}: Tiefer Umsatz — Minimalbesetzung prüfen.`);
  });

  const activeGroups = groups.filter(g => g.items.length > 0);
  if (activeGroups.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(...C.muted);
    doc.text('Keine spezifischen Empfehlungen — Woche verlief im Plan.', ML + 2, y);
    y += 7;
  } else {
    const recBoxH = activeGroups.reduce((s, g) =>
      s + 6.5 + g.items.slice(0, 3).reduce((ss, item) =>
        ss + doc.splitTextToSize('·  ' + item, CW - 40).length * 4.5, 0
      ) + 3, 0
    ) + 6;

    doc.setFillColor(255, 251, 235);
    doc.setDrawColor(...C.orange.border);
    doc.setLineWidth(0.3);
    const recBoxY = y - 2;
    doc.roundedRect(ML, recBoxY, CW, recBoxH, 2, 2, 'FD');
    y += 3;

    activeGroups.forEach(grp => {
      // Group label
      doc.setFillColor(...grp.color);
      doc.rect(ML + 3, y - 1, CW - 6, 0.5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(...grp.color);
      doc.text(grp.label, ML + 5, y + 3.5);
      y += 6.5;

      grp.items.slice(0, 3).forEach(item => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(60, 40, 0);
        const lines = doc.splitTextToSize('·  ' + item, CW - 12);
        doc.text(lines, ML + 7, y);
        y += lines.length * 4.5 + 1;
      });
      y += 2;
    });
  }

  // ── Footer on both pages ──────────────────────────────────────────────────
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFillColor(245, 247, 250);
    doc.rect(0, H - 10, W, 10, 'F');
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.3);
    doc.line(0, H - 10, W, H - 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...C.muted);
    doc.text(`${restaurantName}  ·  ${kwFull}  ·  ${deptLabel}`, ML, H - 3.5);
    doc.text(`Seite ${p} / ${totalPages}`, MR, H - 3.5, { align: 'right' });
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  const fileName = `Wochenreport_KW${kw}_${format(weekStart, 'yyyy')}_${deptLabel.replace('ü', 'ue')}.pdf`;
  doc.save(fileName);
}
