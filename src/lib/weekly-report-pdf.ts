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

// ─────────────────────────────────────────────────────────────────────────────
// DATA HELPERS  (logic unchanged)
// ─────────────────────────────────────────────────────────────────────────────

function slotHours(slot: TimeSlot | null | undefined): number {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = (eh + em / 60) - (sh + sm / 60);
  if (h < 0) h += 24;
  return h;
}
function breakDeduction(gross: number): number {
  return gross >= 7 ? 1 : gross >= 5 ? 0.5 : 0;
}
function dayPlanHours(ds: DaySchedule): number {
  const gross = slotHours(ds.früh) + slotHours(ds.spät);
  return Math.max(0, gross - breakDeduction(gross));
}

function chf(v: number): string {
  return new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(v);
}
function chfShort(v: number): string {
  if (Math.abs(v) >= 10000) return (v / 1000).toFixed(0) + 'k';
  if (Math.abs(v) >= 1000)  return (v / 1000).toFixed(1) + 'k';
  return Math.round(v).toString();
}
function pct(v: number): string { return v.toFixed(1) + '%'; }
function hrs(v: number): string  { return v.toFixed(1) + ' h'; }
function sign(v: number): string { return v >= 0 ? '+' : ''; }

type RGB = [number, number, number];
type TrafficStatus = 'green' | 'orange' | 'red' | 'none';

const C = {
  navy:       [30,  41,  59]  as RGB,
  border:     [226, 232, 240] as RGB,
  muted:      [100, 116, 139] as RGB,
  mutedLight: [148, 163, 184] as RGB,
  bgLight:    [248, 250, 252] as RGB,
  white:      [255, 255, 255] as RGB,
  indigo:     [99,  102, 241] as RGB,
  green:  { bg: [240,253,244] as RGB, text: [21,128,61]   as RGB, bar: [34,197,94]   as RGB, border: [134,239,172] as RGB },
  orange: { bg: [255,251,235] as RGB, text: [161,98,7]    as RGB, bar: [251,146,60]  as RGB, border: [253,186,116] as RGB },
  red:    { bg: [254,242,242] as RGB, text: [153,27,27]   as RGB, bar: [248,113,113] as RGB, border: [252,165,165] as RGB },
  slate:  { bg: [248,250,252] as RGB, text: [100,116,139] as RGB, bar: [148,163,184] as RGB, border: [226,232,240] as RGB },
};

function trafficStatus(quota: number | null, target: number): TrafficStatus {
  if (quota === null) return 'none';
  if (quota <= target)     return 'green';
  if (quota <= target + 5) return 'orange';
  return 'red';
}
function trafficPalette(s: TrafficStatus) {
  return s === 'green' ? C.green : s === 'orange' ? C.orange : s === 'red' ? C.red : C.slate;
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY STATS  (logic unchanged)
// ─────────────────────────────────────────────────────────────────────────────

interface DayStats {
  date: Date; dateStr: string;
  planHours: number; istHours: number; planCost: number; istCost: number;
  actualRevenue: number | null;
  planHoursService: number; planHoursKüche: number;
  istHoursService:  number; istHoursKüche:  number;
  planCostService:  number; planCostKüche:  number;
  istCostService:   number; istCostKüche:   number;
}

function computeDayStats(
  date: Date, employees: Employee[],
  scheduleData: Record<string, DaySchedule>,
  actualHoursData: Record<string, { hours: number }>,
  dailyBudgets: Record<string, { plannedRevenue?: number; actualRevenue?: number }>,
  dept: WeekReportDept,
): DayStats {
  const dateStr = format(date, 'yyyy-MM-dd');
  const relevant = employees.filter(e => dept === 'all' || e.department === dept);
  let planH=0,istH=0,planC=0,istC=0;
  let planHS=0,planHK=0,istHS=0,istHK=0,planCS=0,planCK=0,istCS=0,istCK=0;
  relevant.forEach(emp => {
    const key = `${emp.id}-${dateStr}`;
    const ds = scheduleData[key];
    const w = emp.hourlyWage ?? 0, isSvc = emp.department === 'service';
    const ph = ds ? dayPlanHours(ds) : 0;
    const ah = actualHoursData[key]?.hours ?? 0;
    planH+=ph; planC+=ph*w; istH+=ah; istC+=ah*w;
    if (isSvc) { planHS+=ph; planCS+=ph*w; istHS+=ah; istCS+=ah*w; }
    else        { planHK+=ph; planCK+=ph*w; istHK+=ah; istCK+=ah*w; }
  });
  const budget = dailyBudgets[dateStr];
  const actualRevenue = budget?.actualRevenue != null && budget.actualRevenue > 0 ? budget.actualRevenue : null;
  return {
    date, dateStr, planHours:planH, istHours:istH, planCost:planC, istCost:istC, actualRevenue,
    planHoursService:planHS, planHoursKüche:planHK,
    istHoursService:istHS,   istHoursKüche:istHK,
    planCostService:planCS,  planCostKüche:planCK,
    istCostService:istCS,    istCostKüche:istCK,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DRAWING PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

function sectionLabel(doc: jsPDF, text: string, x: number, y: number, w: number): void {
  doc.setFillColor(...C.navy);
  doc.rect(x, y - 3.5, 2.5, 5.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...C.navy);
  doc.text(text, x + 4.5, y);
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.25);
  doc.line(x, y + 2.5, x + w, y + 2.5);
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

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 2: COMPACT CRITICAL DAY ROW
// ─────────────────────────────────────────────────────────────────────────────

function drawCriticalDayRow(
  doc: jsPDF, x: number, y: number, w: number,
  d: DayStats, quota: number | null, issues: string[], status: TrafficStatus,
): void {
  const ROW_H = 9;
  const pal = trafficPalette(status);

  // Row background
  doc.setFillColor(...pal.bg);
  doc.setDrawColor(...pal.border);
  doc.setLineWidth(0.25);
  doc.roundedRect(x, y, w, ROW_H, 1, 1, 'FD');

  // Colour dot
  doc.setFillColor(...pal.text);
  doc.circle(x + 4.5, y + ROW_H / 2, 2, 'F');

  // Day name
  const dayName = format(d.date, 'EEE d.M.', { locale: de });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...pal.text);
  doc.text(dayName, x + 10, y + 6);

  // Issues (truncated to 1 line)
  const issueText = issues.slice(0, 2).join('  ·  ');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(60, 60, 60);
  doc.text(issueText, x + 38, y + 6);

  // Right KPI
  const diffC = d.istCost - d.planCost;
  const kpiParts: string[] = [];
  if (quota !== null) kpiParts.push('PKQ ' + pct(quota));
  if (Math.abs(diffC) > 50) kpiParts.push(sign(diffC) + chf(diffC));
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...pal.text);
  doc.text(kpiParts.join('  '), x + w - 2, y + 6, { align: 'right' });
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 2: COST CHART  (Plan vs Ist per day, values on bars)
// ─────────────────────────────────────────────────────────────────────────────

function drawCostChart(
  doc: jsPDF, x: number, y: number, w: number, h: number,
  dayStats: DayStats[], targetPercent: number,
): void {
  const L_PAD = 11, B_PAD = 12, T_PAD = 6;
  const px = x + L_PAD, py = y + T_PAD;
  const pw = w - L_PAD, ph = h - B_PAD - T_PAD;

  const allC = dayStats.flatMap(d => [d.planCost, d.istCost]);
  const scaleMax = Math.max(...allC, 1) * 1.18;
  const scale = ph / scaleMax;

  // Chart area
  doc.setFillColor(252, 252, 254);
  doc.rect(px, py, pw, ph, 'F');
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.2);
  doc.rect(px, py, pw, ph, 'S');

  // Grid + y-axis labels
  for (let g = 1; g <= 4; g++) {
    const gy = py + ph - (ph / 4) * g;
    const gv = (scaleMax / 4) * g;
    doc.setDrawColor(237, 242, 247);
    doc.setLineWidth(0.15);
    doc.line(px, gy, px + pw, gy);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5.5);
    doc.setTextColor(...C.mutedLight);
    doc.text(gv >= 1000 ? (gv/1000).toFixed(gv>=10000?0:1)+'k' : Math.round(gv).toString(), px - 1, gy + 1, { align: 'right' });
  }

  // Bars per day
  const groupW = pw / 7;
  const barW = groupW * 0.34;
  const gap   = groupW * 0.05;

  dayStats.forEach((d, i) => {
    const gx   = px + i * groupW;
    const planH = d.planCost * scale;
    const istH  = d.istCost  * scale;
    const startX = gx + (groupW - 2 * barW - gap) / 2;

    // Plan bar (slate)
    doc.setFillColor(...C.slate.bar);
    doc.rect(startX, py + ph - planH, barW, Math.max(planH, 0.5), 'F');

    // Ist bar (3-colour)
    const over = d.istCost / Math.max(d.planCost, 1) - 1;
    const istCol = over <= 0 ? C.green.bar : over <= 0.15 ? C.orange.bar : C.red.bar;
    const istX = startX + barW + gap;
    doc.setFillColor(...istCol);
    doc.rect(istX, py + ph - istH, barW, Math.max(istH, 0.5), 'F');

    // Value on Plan bar
    if (planH > 6) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(5.5);
      doc.setTextColor(80, 80, 80);
      doc.text(chfShort(d.planCost), startX + barW / 2, py + ph - planH - 1.5, { align: 'center' });
    }
    // Value on Ist bar
    if (istH > 6) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(5.5);
      const [rv, gv, bv] = over > 0 ? C.red.text : C.green.text;
      doc.setTextColor(rv, gv, bv);
      doc.text(chfShort(d.istCost), istX + barW / 2, py + ph - istH - 1.5, { align: 'center' });
    }

    // Diff label beneath group
    const diffC = d.istCost - d.planCost;
    if (Math.abs(diffC) > 30) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(5.5);
      doc.setTextColor(...(diffC > 0 ? C.red.text : C.green.text));
      doc.text(sign(diffC) + chfShort(diffC), startX + barW + gap / 2, py + ph + 4, { align: 'center' });
    }

    // Day label
    const dayLbl = format(d.date, 'EEE', { locale: de }).slice(0, 2);
    const dateLbl = format(d.date, 'd.M.', { locale: de });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6);
    doc.setTextColor(...C.navy);
    doc.text(dayLbl, gx + groupW / 2, py + ph + 7.5, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5);
    doc.setTextColor(...C.muted);
    doc.text(dateLbl, gx + groupW / 2, py + ph + 11, { align: 'center' });
  });

  // Legend
  doc.setFillColor(...C.slate.bar);
  doc.rect(px, py - 4.5, 4, 3, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.setTextColor(...C.muted);
  doc.text('Plan', px + 5, py - 2);
  doc.setFillColor(...C.green.bar);
  doc.rect(px + 18, py - 4.5, 4, 3, 'F');
  doc.text('Ist (im Plan)', px + 23, py - 2);
  doc.setFillColor(...C.red.bar);
  doc.rect(px + 50, py - 4.5, 4, 3, 'F');
  doc.text('Ist (über Plan)', px + 55, py - 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 2: PKQ CHART  (large % values on bars, capped scale)
// ─────────────────────────────────────────────────────────────────────────────

function drawPKQChart(
  doc: jsPDF, x: number, y: number, w: number, h: number,
  dayStats: DayStats[], dayQuotas: (number | null)[], targetPercent: number,
): void {
  const L_PAD = 11, B_PAD = 12, T_PAD = 6;
  const px = x + L_PAD, py = y + T_PAD;
  const pw = w - L_PAD, ph = h - B_PAD - T_PAD;

  const pkqCap = targetPercent * 2.8;
  const validQ = dayQuotas.filter(q => q !== null && q <= pkqCap) as number[];
  const rawMax = Math.max(...validQ, targetPercent * 1.1, 1);
  const scaleMax = rawMax * 1.12;
  const scale = ph / scaleMax;

  // Chart area
  doc.setFillColor(252, 252, 254);
  doc.rect(px, py, pw, ph, 'F');
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.2);
  doc.rect(px, py, pw, ph, 'S');

  // Grid + y-axis labels
  for (let g = 1; g <= 4; g++) {
    const gy = py + ph - (ph / 4) * g;
    const gv = (scaleMax / 4) * g;
    doc.setDrawColor(237, 242, 247);
    doc.setLineWidth(0.15);
    doc.line(px, gy, px + pw, gy);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5.5);
    doc.setTextColor(...C.mutedLight);
    doc.text(gv.toFixed(0) + '%', px - 1, gy + 1, { align: 'right' });
  }

  // Target line — prominent dashed indigo
  const tly = py + ph - targetPercent * scale;
  doc.setDrawColor(...C.indigo);
  doc.setLineWidth(0.6);
  let lx = px;
  while (lx < px + pw) {
    doc.line(lx, tly, Math.min(lx + 3, px + pw), tly);
    lx += 4.5;
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6);
  doc.setTextColor(...C.indigo);
  doc.text('Ziel ' + targetPercent + '%', px + pw + 1, tly + 1.5);

  // Bars
  const groupW = pw / 7;
  const barW = groupW * 0.65;

  dayQuotas.forEach((quota, i) => {
    const gx  = px + i * groupW;
    const bx  = gx + (groupW - barW) / 2;
    const isOutlier = quota !== null && quota > pkqCap;
    const displayQ  = quota === null ? 0 : isOutlier ? scaleMax * 0.97 : Math.min(quota, scaleMax);
    const bh = Math.max(displayQ * scale, 1);
    const stat = trafficStatus(quota, targetPercent);
    const pal  = trafficPalette(stat);

    if (quota === null) {
      // No data — ghost bar
      doc.setFillColor(241, 245, 249);
      doc.rect(bx, py + ph - 3, barW, 3, 'F');
    } else {
      doc.setFillColor(...(isOutlier ? C.red.bar : pal.bar));
      doc.rect(bx, py + ph - bh, barW, bh, 'F');

      // Large % label inside / on top of bar
      const labelY = bh > 12 ? py + ph - bh / 2 + 2 : py + ph - bh - 2;
      const labelColor: RGB = bh > 12 ? C.white : pal.text;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(bh > 10 ? 8.5 : 6.5);
      doc.setTextColor(...labelColor);
      const label = isOutlier ? '!' : pct(quota);
      doc.text(label, bx + barW / 2, labelY, { align: 'center' });

      // Outlier: show real value small above
      if (isOutlier) {
        doc.setFontSize(5.5);
        doc.setTextColor(...C.red.text);
        doc.text(pct(quota), bx + barW / 2, py + 3, { align: 'center' });
        doc.setFontSize(5);
        doc.text('Ausreiss.', bx + barW / 2, py + 6.5, { align: 'center' });
      }
    }

    // Day labels
    const dayLbl = format(dayStats[i].date, 'EEE', { locale: de }).slice(0, 2);
    const dateLbl = format(dayStats[i].date, 'd.M.', { locale: de });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6);
    doc.setTextColor(...C.navy);
    doc.text(dayLbl, gx + groupW / 2, py + ph + 7.5, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5);
    doc.setTextColor(...C.muted);
    doc.text(dateLbl, gx + groupW / 2, py + ph + 11, { align: 'center' });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 2: INSIGHT KPI CARDS  (right column next to chart)
// ─────────────────────────────────────────────────────────────────────────────

interface InsightCard {
  label: string;
  title: string;
  value: string;
  status?: TrafficStatus;
}

function drawInsightCards(doc: jsPDF, x: number, y: number, w: number, h: number, cards: InsightCard[]): void {
  const n = Math.min(cards.length, 4);
  const cardH = Math.min(Math.floor(h / n) - 2, 15);
  const cardGap = 2;

  cards.slice(0, n).forEach((card, i) => {
    const cy = y + i * (cardH + cardGap);
    const pal = trafficPalette(card.status ?? 'none');

    // Card bg
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.25);
    doc.roundedRect(x, cy, w, cardH, 1, 1, 'FD');

    // Left colour strip
    if (card.status && card.status !== 'none') {
      doc.setFillColor(...pal.border);
      doc.roundedRect(x, cy, 2.5, cardH, 1, 1, 'F');
      doc.rect(x + 1, cy, 1.5, cardH, 'F');
    }

    // Label (small grey)
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(...C.muted);
    doc.text(card.label, x + 5, cy + 4.5);

    // Title (medium)
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...C.navy);
    doc.text(card.title, x + 5, cy + 9);

    // Value (large, coloured)
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(card.value.length > 10 ? 7 : 8.5);
    doc.setTextColor(...(card.status && card.status !== 'none' ? pal.text : C.navy));
    doc.text(card.value, x + w - 3, cy + cardH - 2.5, { align: 'right' });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export function exportWeeklyReportPDF(params: WeeklyReportParams): void {
  const {
    weekStart, weekEnd, employees, scheduleData, actualHoursData,
    dailyBudgets, department, restaurantName, targetPercent,
  } = params;

  const kw       = getISOWeek(weekStart);
  const kwRange  = `${format(weekStart, 'd.M.yyyy', { locale: de })} – ${format(weekEnd, 'd.M.yyyy', { locale: de })}`;
  const kwFull   = `KW ${kw}  ·  ${kwRange}`;
  const deptLabel = department === 'service' ? 'Service' : department === 'küche' ? 'Küche' : 'Gesamt';

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const ML = 14, MR = W - 14, CW = MR - ML;

  // Build day data
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart); d.setDate(d.getDate() + i); return d;
  });
  const dayStats = days.map(d =>
    computeDayStats(d, employees, scheduleData, actualHoursData, dailyBudgets, department)
  );

  // Weekly totals
  const totPlanH   = dayStats.reduce((s,d) => s + d.planHours, 0);
  const totIstH    = dayStats.reduce((s,d) => s + d.istHours,  0);
  const totPlanC   = dayStats.reduce((s,d) => s + d.planCost,  0);
  const totIstC    = dayStats.reduce((s,d) => s + d.istCost,   0);
  const totRevenue = dayStats.reduce((s,d) => s + (d.actualRevenue ?? 0), 0);
  const hasRevenue = dayStats.some(d => d.actualRevenue !== null);
  const totQuota   = totRevenue > 0 ? (totIstC / totRevenue) * 100 : null;
  const weekStat   = trafficStatus(totQuota, targetPercent);

  const svcPlanH=dayStats.reduce((s,d)=>s+d.planHoursService,0);
  const svcIstH =dayStats.reduce((s,d)=>s+d.istHoursService, 0);
  const svcPlanC=dayStats.reduce((s,d)=>s+d.planCostService, 0);
  const svcIstC =dayStats.reduce((s,d)=>s+d.istCostService,  0);
  const kuePlanH=dayStats.reduce((s,d)=>s+d.planHoursKüche,  0);
  const kueIstH =dayStats.reduce((s,d)=>s+d.istHoursKüche,   0);
  const kuePlanC=dayStats.reduce((s,d)=>s+d.planCostKüche,   0);
  const kueIstC =dayStats.reduce((s,d)=>s+d.istCostKüche,    0);

  const dayQuotas = dayStats.map(d =>
    d.actualRevenue != null && d.actualRevenue > 0 ? (d.istCost / d.actualRevenue) * 100 : null
  );
  const pkqCap = targetPercent * 2.8;

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGE 1
  // ═══════════════════════════════════════════════════════════════════════════

  // Header
  doc.setFillColor(...C.navy);
  doc.rect(0, 0, W, 26, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text(restaurantName, ML, 11);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  doc.setTextColor(148, 163, 184);
  doc.text('Wochenreport Personal & Kosten', ML, 18);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  doc.setTextColor(255, 255, 255);
  doc.text(`KW ${kw}`, MR, 12, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text(kwRange, MR, 19, { align: 'right' });
  doc.setTextColor(0, 0, 0);

  let y = 31;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...C.muted);
  doc.text(`Bereich: ${deptLabel}  ·  Export: ${format(new Date(), 'dd.MM.yyyy, HH:mm')}`, ML, y);
  y += 6;

  // KPI cards
  sectionLabel(doc, 'Zusammenfassung Woche', ML, y, CW);
  statusPill(doc, weekStat, MR - 30, y);
  y += 5;

  const CARD_W = CW / 3 - 1.5, CARD_H = 20, CARD_GAP = 2;
  const summaryCards = [
    { label: 'Umsatz Ist',       value: hasRevenue ? chf(totRevenue) : '–', sub: 'Netto-Umsatz Woche', status: 'none' as TrafficStatus },
    { label: 'Personal Plan',    value: chf(totPlanC), sub: hrs(totPlanH) + ' geplant',    status: 'none' as TrafficStatus },
    { label: 'Personal Ist',     value: chf(totIstC),  sub: hrs(totIstH) + ' Ist-Stunden', status: 'none' as TrafficStatus },
    { label: 'Abweichung',
      value: sign(totIstC-totPlanC) + chf(totIstC-totPlanC),
      sub: totPlanC > 0 ? sign(totIstC-totPlanC)+((totIstC-totPlanC)/totPlanC*100).toFixed(1)+'%' : '–',
      status: (totIstC > totPlanC ? 'red' : 'green') as TrafficStatus },
    { label: 'Personalquote Ist', value: totQuota !== null ? pct(totQuota) : '–', sub: 'Ziel: ' + pct(targetPercent), status: weekStat },
    { label: 'Zielquote',         value: pct(targetPercent), sub: 'Grenzwert: ' + pct(targetPercent+5), status: 'none' as TrafficStatus },
  ];

  summaryCards.forEach((card, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const cx = ML + col * (CARD_W + CARD_GAP), cy = y + row * (CARD_H + CARD_GAP);
    const pal = trafficPalette(card.status);
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(cx, cy, CARD_W, CARD_H, 1.5, 1.5, 'FD');
    if (card.status !== 'none') {
      doc.setFillColor(...pal.border);
      doc.roundedRect(cx, cy, 2.5, CARD_H, 1, 1, 'F');
      doc.rect(cx + 1, cy, 1.5, CARD_H, 'F');
    }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...C.muted);
    doc.text(card.label, cx + 5, cy + 5.5);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(card.value.length > 10 ? 10 : 12);
    doc.setTextColor(...(card.status !== 'none' ? pal.text : C.navy));
    doc.text(card.value, cx + 5, cy + 13);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...C.mutedLight);
    doc.text(card.sub, cx + 5, cy + 18);
  });
  doc.setTextColor(0, 0, 0);
  y += 2 * CARD_H + CARD_GAP + 7;

  // Service vs Küche
  sectionLabel(doc, 'Service vs. Küche', ML, y, CW);
  y += 5;

  const svcQ = totRevenue > 0 ? (svcIstC / totRevenue) * 100 : null;
  const kueQ = totRevenue > 0 ? (kueIstC / totRevenue) * 100 : null;

  type ACell = string | { content: string; styles?: object };
  const deptRows: ACell[][] = [];
  if (department === 'all' || department === 'service') {
    const dH=svcIstH-svcPlanH, dC=svcIstC-svcPlanC;
    deptRows.push([
      { content: 'Service', styles: { fontStyle: 'bold' } },
      hrs(svcPlanH), hrs(svcIstH),
      { content: sign(dH)+hrs(dH), styles: { textColor: dH>0?C.red.text:C.green.text } },
      chf(svcPlanC), chf(svcIstC),
      { content: sign(dC)+chf(dC), styles: { textColor: dC>0?C.red.text:C.green.text } },
      svcQ !== null ? pct(svcQ) : '–',
    ]);
  }
  if (department === 'all' || department === 'küche') {
    const dH=kueIstH-kuePlanH, dC=kueIstC-kuePlanC;
    deptRows.push([
      { content: 'Küche', styles: { fontStyle: 'bold' } },
      hrs(kuePlanH), hrs(kueIstH),
      { content: sign(dH)+hrs(dH), styles: { textColor: dH>0?C.red.text:C.green.text } },
      chf(kuePlanC), chf(kueIstC),
      { content: sign(dC)+chf(dC), styles: { textColor: dC>0?C.red.text:C.green.text } },
      kueQ !== null ? pct(kueQ) : '–',
    ]);
  }
  if (department === 'all') {
    const dH=totIstH-totPlanH, dC=totIstC-totPlanC;
    deptRows.push([
      { content: 'Total', styles: { fontStyle: 'bold', fillColor: [248,250,252] } },
      hrs(totPlanH), hrs(totIstH),
      { content: sign(dH)+hrs(dH), styles: { textColor: dH>0?C.red.text:C.green.text, fontStyle: 'bold' } },
      chf(totPlanC), chf(totIstC),
      { content: sign(dC)+chf(dC), styles: { textColor: dC>0?C.red.text:C.green.text, fontStyle: 'bold' } },
      totQuota !== null
        ? { content: pct(totQuota), styles: { textColor: trafficPalette(weekStat).text, fontStyle: 'bold' } }
        : '–',
    ]);
  }

  autoTable(doc, {
    startY: y, head: [['Abteilung','Plan Std.','Ist Std.','Diff. Std.','Plan CHF','Ist CHF','Diff. CHF','PKQ %']],
    body: deptRows, theme: 'plain',
    headStyles: { fillColor: C.navy, textColor: [255,255,255], fontSize: 7.5, fontStyle: 'bold', cellPadding: 3 },
    styles: { fontSize: 8, cellPadding: { top:3, bottom:3, left:2, right:2 } },
    alternateRowStyles: { fillColor: [252,252,253] },
    columnStyles: {
      0:{cellWidth:22}, 1:{halign:'right',cellWidth:21}, 2:{halign:'right',cellWidth:21},
      3:{halign:'right',cellWidth:22}, 4:{halign:'right',cellWidth:25},
      5:{halign:'right',cellWidth:26}, 6:{halign:'right',cellWidth:26}, 7:{halign:'right',cellWidth:19},
    },
    margin: { left: ML, right: 14 },
  });
  y = (doc as any).lastAutoTable.finalY + 7;

  // Daily overview
  sectionLabel(doc, 'Tagesübersicht', ML, y, CW);
  y += 5;

  const dayRows = dayStats.map((d, i) => {
    const quota = dayQuotas[i];
    const isOutlier = quota !== null && quota > pkqCap;
    const qStat = trafficStatus(quota, targetPercent);
    const qPal  = trafficPalette(qStat);
    const diffC = d.istCost - d.planCost;
    let pkqCell: ACell;
    if (quota === null)    pkqCell = { content: '–', styles: { textColor: C.muted } };
    else if (isOutlier)    pkqCell = { content: pct(quota)+'!', styles: { textColor: C.red.text, fontStyle:'bold', fontSize:6.5 } };
    else                   pkqCell = { content: pct(quota), styles: { textColor: qPal.text, fontStyle:'bold' } };
    return [
      format(d.date, 'EEE, d.M.', { locale: de }),
      d.actualRevenue != null
        ? { content: chf(d.actualRevenue), styles: { fontStyle:'bold' } }
        : { content: '–', styles: { textColor: C.muted } },
      hrs(d.planHours), hrs(d.istHours), chf(d.planCost),
      { content: chf(d.istCost), styles: { fontStyle: d.istCost > d.planCost ? 'bold' : 'normal' } },
      { content: sign(diffC)+chf(diffC), styles: { textColor: diffC>100?C.red.text:diffC<-100?C.green.text:C.muted } },
      pkqCell,
    ];
  });

  autoTable(doc, {
    startY: y, head: [['Tag','Umsatz Ist','Plan Std.','Ist Std.','Plan CHF','Ist CHF','Diff. CHF','PKQ %']],
    body: dayRows, theme: 'plain',
    headStyles: { fillColor: C.navy, textColor: [255,255,255], fontSize: 7.5, fontStyle:'bold', cellPadding:3 },
    styles: { fontSize:8, cellPadding:{ top:2.5, bottom:2.5, left:2, right:2 } },
    alternateRowStyles: { fillColor: [252,252,253] },
    columnStyles: {
      0:{cellWidth:22}, 1:{halign:'right',cellWidth:28}, 2:{halign:'right',cellWidth:20},
      3:{halign:'right',cellWidth:20}, 4:{halign:'right',cellWidth:25},
      5:{halign:'right',cellWidth:25}, 6:{halign:'right',cellWidth:25}, 7:{halign:'right',cellWidth:17},
    },
    margin: { left: ML, right: 14 },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGE 2  —  DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════════
  doc.addPage();

  // Mini header
  doc.setFillColor(...C.navy);
  doc.rect(0, 0, W, 11, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(255,255,255);
  doc.text(`${restaurantName}  ·  Wochenreport Personal & Kosten  ·  ${kwFull}  ·  ${deptLabel}`, ML, 7.5);
  doc.setTextColor(0, 0, 0);
  y = 17;

  // ── Critical days: compact rows ──────────────────────────────────────────
  const criticalDays = dayStats
    .map((d, i) => {
      const quota = dayQuotas[i];
      const diffC = d.istCost - d.planCost;
      const diffH = d.istHours - d.planHours;
      const issues: string[] = [];
      if (quota !== null && quota > targetPercent) issues.push(`PKQ ${pct(quota)} (Ziel ${pct(targetPercent)})`);
      if (diffC > 200)  issues.push(`${sign(diffC)}${chf(diffC)} über Plan`);
      if (diffH > 3)    issues.push(`${sign(diffH)}${hrs(diffH)} Mehrstunden`);
      if (d.actualRevenue !== null && d.actualRevenue < 5000 && d.istCost > 1500) issues.push('Tiefer Umsatz');
      return { d, quota, issues, status: trafficStatus(quota, targetPercent) };
    })
    .filter(x => x.issues.length > 0)
    .slice(0, 4);

  sectionLabel(doc, 'Kritische Tage', ML, y, CW);
  y += 5;

  if (criticalDays.length === 0) {
    doc.setFillColor(...C.green.bg);
    doc.setDrawColor(...C.green.border);
    doc.setLineWidth(0.3);
    doc.roundedRect(ML, y, CW, 8, 1, 1, 'FD');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...C.green.text);
    doc.text('Keine kritischen Tage — Woche verlief im Plan', ML + 5, y + 5.5);
    doc.setTextColor(0,0,0);
    y += 12;
  } else {
    criticalDays.forEach(({ d, quota, issues, status }) => {
      drawCriticalDayRow(doc, ML, y, CW, d, quota, issues, status);
      y += 11;
    });
    y += 3;
  }

  // ── Chart section layout constants ───────────────────────────────────────
  const CHART_COL_W  = CW * 0.63;      // ~115mm for charts
  const INSIGHT_W    = CW * 0.33;      // ~60mm for insight cards
  const COL_GAP      = CW * 0.04;      // ~7mm gap
  const CHART_H      = 56;             // chart box height including labels
  const CHART_SECTION_H = CHART_H + 14; // label + chart + gap

  // ── Chart A: Plan vs Ist Costs ───────────────────────────────────────────
  sectionLabel(doc, 'Tageskosten  Plan vs. Ist (CHF)', ML, y, CW);
  y += 6;

  drawCostChart(doc, ML, y, CHART_COL_W, CHART_H, dayStats, targetPercent);

  // Cost insight cards
  const sortedByCostDiff = [...dayStats].sort((a,b) => (b.istCost-b.planCost) - (a.istCost-a.planCost));
  const worstCostDay   = sortedByCostDiff[0];
  const bestCostDay    = sortedByCostDiff[sortedByCostDiff.length - 1];
  const worstHoursDay  = [...dayStats].sort((a,b) => (b.istHours-b.planHours) - (a.istHours-a.planHours))[0];

  const costCards: InsightCard[] = [
    {
      label: 'Hoechste Abweichung',
      title: format(worstCostDay.date, 'EEEE', { locale: de }),
      value: sign(worstCostDay.istCost-worstCostDay.planCost) + chf(worstCostDay.istCost-worstCostDay.planCost),
      status: worstCostDay.istCost > worstCostDay.planCost ? 'red' : 'green',
    },
    {
      label: 'Bester Tag (Kosten)',
      title: format(bestCostDay.date, 'EEEE', { locale: de }),
      value: sign(bestCostDay.istCost-bestCostDay.planCost) + chf(bestCostDay.istCost-bestCostDay.planCost),
      status: bestCostDay.istCost <= bestCostDay.planCost ? 'green' : 'orange',
    },
    {
      label: 'Meiste Mehrstunden',
      title: format(worstHoursDay.date, 'EEEE', { locale: de }),
      value: sign(worstHoursDay.istHours-worstHoursDay.planHours) + hrs(worstHoursDay.istHours-worstHoursDay.planHours),
      status: worstHoursDay.istHours > worstHoursDay.planHours ? 'orange' : 'green',
    },
    {
      label: 'Woche gesamt Diff.',
      title: 'Personalkosten',
      value: sign(totIstC-totPlanC) + chf(totIstC-totPlanC),
      status: weekStat,
    },
  ];
  drawInsightCards(doc, ML + CHART_COL_W + COL_GAP, y, INSIGHT_W, CHART_H, costCards);

  y += CHART_SECTION_H;

  // ── Chart B: PKQ per day ─────────────────────────────────────────────────
  sectionLabel(doc, 'Personalquote pro Tag  (PKQ %)', ML, y, CW);
  y += 6;

  drawPKQChart(doc, ML, y, CHART_COL_W, CHART_H, dayStats, dayQuotas, targetPercent);

  // PKQ insight cards
  const validQuotaDays = dayStats.filter((_,i) => dayQuotas[i] !== null && dayQuotas[i]! <= pkqCap);
  const bestPKQDay  = validQuotaDays.sort((a,b) => {
    const qa = dayQuotas[dayStats.indexOf(a)]!, qb = dayQuotas[dayStats.indexOf(b)]!;
    return qa - qb;
  })[0];
  const worstPKQDay = validQuotaDays[validQuotaDays.length - 1];
  const outlierCount = dayQuotas.filter(q => q !== null && q > pkqCap).length;

  const pkqCards: InsightCard[] = [];
  if (bestPKQDay) {
    const bq = dayQuotas[dayStats.indexOf(bestPKQDay)]!;
    pkqCards.push({ label: 'Beste PKQ', title: format(bestPKQDay.date, 'EEEE', { locale: de }), value: pct(bq), status: trafficStatus(bq, targetPercent) });
  }
  if (worstPKQDay && worstPKQDay !== bestPKQDay) {
    const wq = dayQuotas[dayStats.indexOf(worstPKQDay)]!;
    pkqCards.push({ label: 'Schlechteste PKQ', title: format(worstPKQDay.date, 'EEEE', { locale: de }), value: pct(wq), status: trafficStatus(wq, targetPercent) });
  }
  pkqCards.push({ label: 'Zielquote', title: 'Vorgabe', value: pct(targetPercent), status: 'none' });
  if (outlierCount > 0) {
    pkqCards.push({ label: 'Ausreisser (Tiefer Umsatz)', title: outlierCount + ' Tag' + (outlierCount>1?'e':'') + ' im Chart begrenzt', value: 'Echt-Wert in Tabelle', status: 'orange' });
  } else {
    pkqCards.push({ label: 'PKQ-Status Woche', title: weekStat === 'green' ? 'Im Ziel' : weekStat === 'orange' ? 'Knapp' : 'Ueberschritten', value: totQuota !== null ? pct(totQuota) : '–', status: weekStat });
  }

  drawInsightCards(doc, ML + CHART_COL_W + COL_GAP, y, INSIGHT_W, CHART_H, pkqCards);
  y += CHART_SECTION_H;

  // ── Erkenntnisse + Empfehlungen (compact, grouped) ───────────────────────
  sectionLabel(doc, 'Erkenntnisse & Empfehlungen', ML, y, CW);
  y += 5;

  // Build insight bullets
  const bullets: { text: string; status: TrafficStatus }[] = [];
  if (totQuota !== null)
    bullets.push({ text: totQuota <= targetPercent
      ? `PKQ Woche ${pct(totQuota)} — im Ziel (${pct(targetPercent)}).`
      : `PKQ Woche ${pct(totQuota)} — Ziel ${pct(targetPercent)} ueberschritten.`,
      status: weekStat });
  const totDiffH = totIstH - totPlanH;
  if (Math.abs(totDiffH) > 2)
    bullets.push({ text: totDiffH > 0 ? `${hrs(totDiffH)} Mehrstunden gesamt.` : `${hrs(Math.abs(totDiffH))} unter Plan.`, status: totDiffH > 0 ? 'orange' : 'green' });
  if (department === 'all') {
    const sdH = svcIstH-svcPlanH, kdH = kueIstH-kuePlanH;
    if (Math.abs(sdH) > 1.5) bullets.push({ text: sdH > 0 ? `Service: ${hrs(sdH)} Mehrstunden.` : `Service: ${hrs(Math.abs(sdH))} unter Plan.`, status: sdH > 0 ? 'orange' : 'green' });
    if (Math.abs(kdH) > 1.5) bullets.push({ text: kdH > 0 ? `Kueche: ${hrs(kdH)} Mehrstunden.` : `Kueche: ${hrs(Math.abs(kdH))} unter Plan.`, status: kdH > 0 ? 'orange' : 'green' });
  }

  // Build recommendation groups
  interface RecGroup { label: string; color: RGB; items: string[] }
  const groups: RecGroup[] = [
    { label: 'Gesamt',          color: C.navy,       items: [] },
    { label: 'Service',         color: C.indigo,     items: [] },
    { label: 'Kueche',          color: [217,119,6],  items: [] },
    { label: 'Kritische Tage',  color: C.red.text,   items: [] },
  ];
  const totDiffC = totIstC - totPlanC;
  if (totDiffC > 300) groups[0].items.push(`Kosten ${chf(totDiffC)} ueber Plan — Besetzung reduzieren.`);
  if (totQuota !== null && totQuota > targetPercent) groups[0].items.push(`Zielquote ${pct(targetPercent)} anstreben (aktuell ${pct(totQuota)}).`);
  if (department === 'all' || department === 'service') {
    const sd = svcIstC-svcPlanC, sdH2 = svcIstH-svcPlanH;
    if (sd > 200) groups[1].items.push(`Mehrkosten ${chf(sd)} — Aushilfen nur an starken Tagen.`);
    if (sdH2 > 5) groups[1].items.push(`Planstunden um ca. ${hrs(sdH2)} reduzieren.`);
  }
  if (department === 'all' || department === 'küche') {
    const kd = kueIstC-kuePlanC;
    if (kd > 200) groups[2].items.push(`Mehrkosten ${chf(kd)} — Fruehschichten pruefen.`);
  }
  dayStats.forEach((d, i) => {
    const quota = dayQuotas[i];
    const dayName = format(d.date, 'EEEE', { locale: de });
    const istDiffH = d.istHours - d.planHours;
    if (quota !== null && quota > targetPercent+5 && (d.actualRevenue ?? 0) > 500) groups[3].items.push(`${dayName}: PKQ ${pct(quota)} — Besetzung anpassen.`);
    if (istDiffH > 4) groups[3].items.push(`${dayName}: ${hrs(istDiffH)} Mehrstunden — Dienstplan pruefen.`);
  });

  // Render bullets (2-column: insights left, recs right)
  const colW2 = (CW - 4) / 2;

  // Left: insights
  let yl = y, yr = y;
  bullets.slice(0, 5).forEach(b => {
    const pal = trafficPalette(b.status);
    doc.setFillColor(...pal.bar);
    doc.circle(ML + 2, yl + 1.5, 1.2, 'F');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(40,40,40);
    const lines = doc.splitTextToSize(b.text, colW2 - 6);
    doc.text(lines, ML + 5, yl);
    yl += lines.length * 4.5 + 2;
  });

  // Right: grouped recs
  const activeGroups = groups.filter(g => g.items.length > 0);
  if (activeGroups.length === 0) {
    doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(...C.muted);
    doc.text('Keine Empfehlungen — Woche im Plan.', ML + colW2 + 4, yr);
  } else {
    activeGroups.forEach(grp => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(...grp.color);
      doc.text(grp.label, ML + colW2 + 4, yr + 1);
      yr += 5;
      grp.items.slice(0, 2).forEach(item => {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(40,40,40);
        const lines = doc.splitTextToSize('·  ' + item, colW2 - 4);
        doc.text(lines, ML + colW2 + 5, yr);
        yr += lines.length * 4.2 + 1;
      });
      yr += 2;
    });
  }

  // Divider between columns
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.25);
  doc.line(ML + colW2 + 2, y - 1, ML + colW2 + 2, Math.max(yl, yr) + 2);

  // ── Footer ────────────────────────────────────────────────────────────────
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFillColor(245, 247, 250);
    doc.rect(0, H - 10, W, 10, 'F');
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.3);
    doc.line(0, H - 10, W, H - 10);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...C.muted);
    doc.text(`${restaurantName}  ·  ${kwFull}  ·  ${deptLabel}`, ML, H - 3.5);
    doc.text(`Seite ${p} / ${totalPages}`, MR, H - 3.5, { align: 'right' });
  }

  const fileName = `Wochenreport_KW${kw}_${format(weekStart,'yyyy')}_${deptLabel.replace('ü','ue')}.pdf`;
  doc.save(fileName);
}
