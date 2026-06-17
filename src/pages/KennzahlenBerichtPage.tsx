/**
 * KennzahlenBerichtPage — Management Report
 *
 * Zwei Ansichten:
 *   Dashboard — KPI-Karten + Diagramm
 *   Excel     — Spaltenbericht (Kennzahl | Budget | Vorjahr | Woche +/- | Monat +/-)
 *
 * Datenquellen:
 *   dailyBudgets (localStorage / Supabase KV): Umsatz, PK, Budget, VJ
 *   Warenrechnungen (Supabase KV): WES Food / Beverage / Lieferanten
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { ReactNode } from 'react';
import {
  startOfWeek, endOfMonth, startOfMonth, startOfYear,
  subDays, subMonths, eachDayOfInterval, format, parseISO,
  isBefore, isAfter,
} from 'date-fns';
import { de } from 'date-fns/locale';
import {
  BarChart2, Download, DollarSign, Clock, Package, Users, TrendingUp,
  Table2, LayoutDashboard,
} from 'lucide-react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { grossToNet } from '@/types/personnel';
import { loadMonthInvoices } from '@/lib/waren-db';
import type { DailyBudget } from '@/types/personnel';

// ── Period ────────────────────────────────────────────────────────────────

type Period = 'heute' | 'gestern' | 'woche' | 'monat' | 'letzter_monat' | 'jahr' | 'custom';
type ViewMode = 'dashboard' | 'excel';

const PERIOD_BTNS: { key: Period; label: string }[] = [
  { key: 'heute',         label: 'Heute' },
  { key: 'gestern',       label: 'Gestern' },
  { key: 'woche',         label: 'Woche' },
  { key: 'monat',         label: 'Monat' },
  { key: 'letzter_monat', label: 'Vormonat' },
  { key: 'jahr',          label: 'Jahr' },
  { key: 'custom',        label: 'Benutzerdefiniert' },
];

// ── Data types ────────────────────────────────────────────────────────────

interface PeriodSlice {
  netTotal: number;
  grossTotal: number;
  vjNet: number;
  plannedNet: number;
  laborActual: number;
  warenFood: number;
  warenBev: number;
  warenSonst: number;
  warenTotal: number;
  foodNet: number;
  bevNet: number;
}

interface Summary {
  daysTotal: number;
  daysWithData: number;
  netTotal: number;
  grossTotal: number;
  foodNet: number;
  bevNet: number;
  plannedNet: number;
  vjNet: number;
  laborActual: number;
  laborPlanned: number;
  warenFood: number;
  warenBev: number;
  warenSonst: number;
  warenTotal: number;
  suppliers: Record<string, number>;
  week: PeriodSlice;
  chart: { label: string; net: number; planned: number; vj: number }[];
}

interface XRow {
  label: string;
  isSection?: boolean;
  isBold?: boolean;
  isIndent?: boolean;
  budget: number | null;
  vj: number | null;
  week: number | null;
  weekBudget: number | null;
  month: number | null;
  isPct?: boolean;
}

// ── Module-level helpers ──────────────────────────────────────────────────

function readBudgets(tenantId: string): Record<string, DailyBudget> {
  try {
    const k = tenantId === 'beaulieu' ? 'beaulieu:dailyBudgets' : 'dailyBudgets';
    return JSON.parse(localStorage.getItem(k) || '{}');
  } catch { return {}; }
}

const FMT = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
function fmtChf(v: number) { return `CHF ${FMT.format(Math.round(v))}`; }
function fmtPct(v: number) { return v.toFixed(1) + ' %'; }
function fmtDev(v: number) { return (v >= 0 ? '+' : '') + v.toFixed(1) + ' %'; }
function sgn(v: number) { return v >= 0 ? '+' : ''; }
function n2(v: number | null): string { return v !== null && v > 0 ? fmtChf(v) : '—'; }
function p2(v: number | null): string { return v !== null && v > 0 ? fmtPct(v) : '—'; }

function tLight(actual: number, target: number, lowerIsBetter = false): 'green' | 'yellow' | 'red' {
  if (target <= 0 || actual <= 0) return 'yellow';
  const r = actual / target;
  if (lowerIsBetter) { return r <= 1.0 ? 'green' : r <= 1.12 ? 'yellow' : 'red'; }
  return r >= 0.97 ? 'green' : r >= 0.88 ? 'yellow' : 'red';
}

function getSupp(supp: Record<string, number>, pattern: string): number {
  const lower = pattern.toLowerCase();
  return Object.entries(supp)
    .filter(([n]) => n.toLowerCase().includes(lower))
    .reduce((s, [, v]) => s + v, 0);
}

function getSuppOther(supp: Record<string, number>, patterns: string[]): number {
  const lowers = patterns.map(p => p.toLowerCase());
  return Object.entries(supp)
    .filter(([n]) => !lowers.some(l => n.toLowerCase().includes(l)))
    .reduce((s, [, v]) => s + v, 0);
}

// ── Build Excel Rows (shared computation) ────────────────────────────────

function buildExcelRows(s: Summary): XRow[] {
  const { week } = s;

  // Supplier breakdown
  const SUPP_PATTERNS = ['spahni', 'transgourmet', 'gourmador', 'ambro', 'feldschlöss', 'terravigna'];
  const spahni       = getSupp(s.suppliers, 'spahni');
  const transgourmet = getSupp(s.suppliers, 'transgourmet');
  const gourmador    = getSupp(s.suppliers, 'gourmador');
  const ambro        = getSupp(s.suppliers, 'ambro');
  const feldschl     = getSupp(s.suppliers, 'feldschlöss');
  const terravigna   = getSupp(s.suppliers, 'terravigna');
  const weitere      = getSuppOther(s.suppliers, SUPP_PATTERNS);

  // WES %
  const wesPct     = s.netTotal  > 0 && s.warenTotal  > 0 ? (s.warenTotal  / s.netTotal)  * 100 : null;
  const wesWeekPct = week.netTotal > 0 && week.warenTotal > 0 ? (week.warenTotal / week.netTotal) * 100 : null;

  const r = (
    label: string,
    month: number | null,
    week: number | null = null,
    weekBudget: number | null = null,
    budget: number | null = null,
    vj: number | null = null,
    opts: Partial<XRow> = {},
  ): XRow => ({ label, month, week, weekBudget, budget, vj, ...opts });

  const sec = (label: string): XRow =>
    ({ label, isSection: true, budget: null, vj: null, week: null, weekBudget: null, month: null });

  const M = (v: number) => v > 0 ? v : null;

  return [
    // ── Umsatz ──────────────────────────────────────────────────────────
    sec('Umsatz'),
    r('Brutto Umsatz',              M(s.grossTotal), M(week.grossTotal), M(week.plannedNet * 1.081), M(s.plannedNet * 1.081), M(s.vjNet * 1.081)),
    r('Netto Umsatz',               M(s.netTotal),   M(week.netTotal),   M(week.plannedNet),         M(s.plannedNet),         M(s.vjNet), { isBold: true }),
    r('Netto Plan zum Budget',      M(s.plannedNet), M(week.plannedNet), null, null, null),
    r('Gäste Inhouse zum Budget',   null, null, null, null, null),
    r('Gäste Take Away Budget',     null, null, null, null, null),
    r('Gruppen ab 20 Pax Budget',   null, null, null, null, null),

    // ── Durchschnitt ────────────────────────────────────────────────────
    sec('Durchschnitt'),
    r('Durchschnittsverkauf',             null, null, null, null, null),
    r('Durchschnittsverkauf Take Away',   null, null, null, null, null),
    r('Take Away Anteil',                 null, null, null, null, null, { isPct: true }),

    // ── Vorjahr ─────────────────────────────────────────────────────────
    sec('Vorjahr'),
    r('Brutto Umsatz letztes Jahr',        s.vjNet > 0 ? s.vjNet * 1.081 : null, week.vjNet > 0 ? week.vjNet * 1.081 : null, null, null, null),
    r('Netto Umsatz letztes Jahr',         M(s.vjNet), M(week.vjNet), null, null, null),
    r('Gäste letztes Jahr',                null, null, null, null, null),
    r('Durchschnittsverkauf letztes Jahr', null, null, null, null, null),

    // ── Umsatzgruppen ───────────────────────────────────────────────────
    sec('Umsatzgruppen'),
    r('Wein / Spirituosen',           null, null, null, null, null),
    r('Bar Umsatz',                   M(s.bevNet),  null, null, null, null),
    r('Küchen Umsatz',                M(s.foodNet), null, null, null, null),
    r('Wein / Spirituosen letztes Jahr', null, null, null, null, null),
    r('Bar Umsatz letztes Jahr',      null, null, null, null, null),
    r('Küchen Umsatz letztes Jahr',   null, null, null, null, null),

    // ── Bewertungen ─────────────────────────────────────────────────────
    sec('Bewertungen'),
    r('Google Rezension 5 Sterne', null, null, null, null, null),
    r('Google Rezension 3 Sterne', null, null, null, null, null),
    r('Google Rezension 1 Stern',  null, null, null, null, null),
    r('Tripadvisor 5 Sterne',      null, null, null, null, null),
    r('Tripadvisor 3 Sterne',      null, null, null, null, null),
    r('Tripadvisor 1 Stern',       null, null, null, null, null),

    // ── Brunch ──────────────────────────────────────────────────────────
    sec('Brunch'),
    r('Brunch Umsatz / Anteil', null, null, null, null, null),

    // ── Produktivität ───────────────────────────────────────────────────
    sec('Produktivität'),
    r('Produktive Stunden',         null, null, null, null, null),
    r('Produktive Stunden geplant', null, null, null, null, null),
    r('Produktivität',              null, null, null, null, null, { isPct: true }),
    r('Umsatz pro Gast',            null, null, null, null, null),

    // ── Warenaufwand ────────────────────────────────────────────────────
    sec('Warenaufwand'),
    r('Warenaufwand nach gastronovi in %', wesPct, wesWeekPct, null, null, null, { isPct: true }),
    r('Inventurwert (Einkauf / Verkauf)',  null,   null,        null, null, null),
    r('Food',          M(s.warenFood), M(week.warenFood), null, null, null, { isIndent: true }),
    r('Getränke',      M(s.warenBev),  M(week.warenBev),  null, null, null, { isIndent: true }),
    r('Einkauf Gesamt', M(s.warenTotal), M(week.warenTotal), null, null, null, { isBold: true }),

    // ── Lieferanten ─────────────────────────────────────────────────────
    sec('Lieferanten'),
    r('Spahni',        spahni       > 0 ? spahni       : null, null, null, null, null, { isIndent: true }),
    r('Transgourmet',  transgourmet > 0 ? transgourmet : null, null, null, null, null, { isIndent: true }),
    r('Gourmador',     gourmador    > 0 ? gourmador    : null, null, null, null, null, { isIndent: true }),
    r('Ambro',         ambro        > 0 ? ambro        : null, null, null, null, null, { isIndent: true }),
    r('Feldschlössli', feldschl     > 0 ? feldschl     : null, null, null, null, null, { isIndent: true }),
    r('Terravigna',    terravigna   > 0 ? terravigna   : null, null, null, null, null, { isIndent: true }),
    r('Weitere',       weitere      > 0 ? weitere      : null, null, null, null, null, { isIndent: true }),
    r('Zusammen',      M(s.warenTotal), M(week.warenTotal), null, null, null, { isBold: true }),

    // ── Korrekturen / Kosten ────────────────────────────────────────────
    sec('Korrekturen / Kosten'),
    r('Rohabfall',                     null, null, null, null, null),
    r('Marketing',                     null, null, null, null, null),
    r('Maison',                        null, null, null, null, null),
    r('Storno',                        null, null, null, null, null),
    r('Kosten ohne Rezeptur',          null, null, null, null, null),
    r('Total Warenaufwand n. Rechnung', M(s.warenTotal), M(week.warenTotal), null, null, null, { isBold: true }),
  ];
}

// ── Main component ────────────────────────────────────────────────────────

export default function KennzahlenBerichtPage() {
  const { tenantId } = useTenant();
  const today = useMemo(() => new Date(), []);

  const [period,     setPeriod]     = useState<Period>('monat');
  const [viewMode,   setViewMode]   = useState<ViewMode>('dashboard');
  const [customFrom, setCustomFrom] = useState(format(startOfMonth(today), 'yyyy-MM-dd'));
  const [customTo,   setCustomTo]   = useState(format(today, 'yyyy-MM-dd'));
  const [loading,    setLoading]    = useState(false);
  const [summary,    setSummary]    = useState<Summary | null>(null);

  // ── Date range ────────────────────────────────────────────────────────

  const { from, to } = useMemo(() => {
    switch (period) {
      case 'heute':
        return { from: today, to: today };
      case 'gestern': {
        const y = subDays(today, 1);
        return { from: y, to: y };
      }
      case 'woche':
        return { from: startOfWeek(today, { weekStartsOn: 1 }), to: today };
      case 'monat':
        return { from: startOfMonth(today), to: today };
      case 'letzter_monat': {
        const lm = subMonths(today, 1);
        return { from: startOfMonth(lm), to: endOfMonth(lm) };
      }
      case 'jahr':
        return { from: startOfYear(today), to: today };
      default: {
        try {
          return { from: parseISO(customFrom), to: parseISO(customTo) };
        } catch { return { from: today, to: today }; }
      }
    }
  }, [period, customFrom, customTo, today]);

  const rangeLabel = useMemo(
    () => `${format(from, 'dd.MM.yyyy', { locale: de })} – ${format(to, 'dd.MM.yyyy', { locale: de })}`,
    [from, to],
  );

  // ── Load data ─────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const budgets     = readBudgets(tenantId);
        const days        = eachDayOfInterval({ start: from, end: to });
        const nDays       = days.length;
        const lblFmt      = nDays > 90 ? 'MMM yy' : nDays > 14 ? 'dd.MM' : 'dd.MM.';
        const weekFromMs  = Math.max(from.getTime(), subDays(to, 6).getTime());
        const weekFromDate = new Date(weekFromMs);

        // Month accumulators
        let grossTotal = 0, netTotal = 0;
        let foodGross = 0, bevGross = 0;
        let plannedGross = 0, vjGross = 0;
        let laborActual = 0, laborPlanned = 0;
        let daysWithData = 0;
        const chartMap = new Map<string, { net: number; planned: number; vj: number }>();

        // Week accumulators
        let wGross = 0, wNet = 0, wVjGross = 0, wPlanGross = 0;
        let wFoodGross = 0, wBevGross = 0;
        let wLabor = 0;

        for (const day of days) {
          const key   = format(day, 'yyyy-MM-dd');
          const d     = budgets[key];
          const gross = d?.actualRevenue    ?? 0;
          const ta    = d?.takeawayRevenue  ?? 0;
          const net   = grossToNet(gross, ta);
          const planG = d?.plannedRevenue   ?? 0;
          const vjG   = d?.previousYearRevenue ?? 0;

          grossTotal   += gross;
          netTotal     += net;
          foodGross    += d?.actualFood     ?? 0;
          bevGross     += d?.actualBeverage ?? 0;
          plannedGross += planG;
          vjGross      += vjG;
          laborActual  += d?.actualLaborCost  ?? 0;
          laborPlanned += d?.plannedLaborCost ?? 0;
          if (gross > 0) daysWithData++;

          const lbl = format(day, lblFmt, { locale: de });
          const ex  = chartMap.get(lbl) ?? { net: 0, planned: 0, vj: 0 };
          chartMap.set(lbl, {
            net:     ex.net     + Math.round(net),
            planned: ex.planned + Math.round(grossToNet(planG)),
            vj:      ex.vj      + Math.round(grossToNet(vjG)),
          });

          // Week slice
          if (!isBefore(day, weekFromDate)) {
            wGross     += gross;
            wNet       += net;
            wVjGross   += vjG;
            wPlanGross += planG;
            wFoodGross += d?.actualFood     ?? 0;
            wBevGross  += d?.actualBeverage ?? 0;
            wLabor     += d?.actualLaborCost ?? 0;
          }
        }

        // Waren invoices
        const months  = [...new Set(days.map(d => format(d, 'yyyy-MM')))];
        const allInv  = (await Promise.all(months.map(m => loadMonthInvoices(tenantId, m))))
          .flat()
          .filter(inv => {
            try {
              const d = parseISO(inv.date);
              return !isBefore(d, from) && !isAfter(d, to);
            } catch { return false; }
          });

        const warenFood  = allInv.filter(i => i.kategorie === 'Food')
                           .reduce((s, i) => s + (i.amountNet ?? 0), 0);
        const warenBev   = allInv.filter(i => i.kategorie === 'Beverage')
                           .reduce((s, i) => s + (i.amountNet ?? 0), 0);
        const warenSonst = allInv.filter(i => i.kategorie === 'Sonstiges')
                           .reduce((s, i) => s + (i.amountNet ?? 0), 0);

        // Week waren
        const weekInv    = allInv.filter(inv => {
          try { return !isBefore(parseISO(inv.date), weekFromDate); } catch { return false; }
        });
        const wWarenFood  = weekInv.filter(i => i.kategorie === 'Food').reduce((s, i) => s + (i.amountNet ?? 0), 0);
        const wWarenBev   = weekInv.filter(i => i.kategorie === 'Beverage').reduce((s, i) => s + (i.amountNet ?? 0), 0);
        const wWarenSonst = weekInv.filter(i => i.kategorie === 'Sonstiges').reduce((s, i) => s + (i.amountNet ?? 0), 0);

        // Supplier map
        const supplierMap: Record<string, number> = {};
        for (const inv of allInv) {
          const name = inv.supplierName?.trim() || 'Unbekannt';
          supplierMap[name] = (supplierMap[name] ?? 0) + (inv.amountNet ?? 0);
        }

        if (!alive) return;
        setSummary({
          daysTotal:   days.length,
          daysWithData,
          netTotal,
          grossTotal,
          foodNet:     foodGross / 1.081,
          bevNet:      bevGross  / 1.081,
          plannedNet:  grossToNet(plannedGross),
          vjNet:       grossToNet(vjGross),
          laborActual,
          laborPlanned,
          warenFood,
          warenBev,
          warenSonst,
          warenTotal:  warenFood + warenBev + warenSonst,
          suppliers:   supplierMap,
          week: {
            netTotal:   wNet,
            grossTotal: wGross,
            vjNet:      grossToNet(wVjGross),
            plannedNet: grossToNet(wPlanGross),
            laborActual: wLabor,
            warenFood:  wWarenFood,
            warenBev:   wWarenBev,
            warenSonst: wWarenSonst,
            warenTotal: wWarenFood + wWarenBev + wWarenSonst,
            foodNet:    wFoodGross / 1.081,
            bevNet:     wBevGross  / 1.081,
          },
          chart: Array.from(chartMap.entries()).map(([label, v]) => ({ label, ...v })),
        });
      } catch (err) {
        console.error('[KennzahlenBericht] load error', err);
        if (alive) setSummary(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [tenantId, from, to]);

  // ── Excel rows (shared computation) ──────────────────────────────────

  const excelRows = useMemo(() => {
    if (!summary) return [];
    return buildExcelRows(summary);
  }, [summary]);

  // ── PDF export ────────────────────────────────────────────────────────

  const exportPdf = useCallback(async () => {
    if (!summary) return;
    const { default: jsPDF }     = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');

    if (viewMode === 'excel') {
      // ── Excel view PDF (Landscape A4) ────────────────────────────────
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const PW = 297; const M = 12;

      doc.setFillColor(30, 41, 59);
      doc.rect(0, 0, PW, 24, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(255, 255, 255);
      doc.text('Kennzahlen Bericht — Spaltenbericht', M, 10);
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'normal');
      doc.text(rangeLabel, M, 18);
      doc.text(`Erstellt: ${format(new Date(), 'dd.MM.yyyy HH:mm')}`, PW - M, 18, { align: 'right' });

      const head = [['Kennzahl', 'Budget', 'Vorjahr', 'Woche', '+/- %', 'Monat', '+/- %']];
      const body: string[][] = [];

      for (const row of excelRows) {
        if (row.isSection) {
          body.push([row.label, '', '', '', '', '', '']);
          continue;
        }
        const fmt = row.isPct ? p2 : n2;
        // Compute deviations (all division precomputed here, not in JSX)
        const wDev  = row.week !== null && row.weekBudget !== null && row.weekBudget > 0
          ? ((row.week - row.weekBudget) / row.weekBudget) * 100 : null;
        const mDev  = row.month !== null && row.budget !== null && row.budget > 0
          ? ((row.month - row.budget) / row.budget) * 100 : null;
        const indent = row.isIndent ? '   ' : '';
        body.push([
          indent + row.label,
          fmt(row.budget),
          fmt(row.vj),
          fmt(row.week),
          wDev !== null ? fmtDev(wDev) : '—',
          fmt(row.month),
          mDev !== null ? fmtDev(mDev) : '—',
        ]);
      }

      autoTable(doc, {
        startY: 28, margin: { left: M, right: M },
        head,
        body,
        styles: { fontSize: 7, cellPadding: 1.5 },
        headStyles: { fillColor: [30, 41, 59], fontSize: 7.5 },
        columnStyles: {
          0: { cellWidth: 80 },
          1: { cellWidth: 28, halign: 'right' },
          2: { cellWidth: 28, halign: 'right' },
          3: { cellWidth: 28, halign: 'right' },
          4: { cellWidth: 22, halign: 'right' },
          5: { cellWidth: 28, halign: 'right' },
          6: { cellWidth: 22, halign: 'right' },
        },
        didParseCell: (data) => {
          if (data.section === 'body') {
            const row = excelRows[data.row.index];
            if (row?.isSection) {
              data.cell.styles.fillColor = [241, 245, 249];
              data.cell.styles.textColor = [71, 85, 105];
              data.cell.styles.fontStyle = 'bold';
              data.cell.styles.fontSize  = 7;
            } else if (row?.isBold) {
              data.cell.styles.fontStyle = 'bold';
            }
            // Color +/- columns
            if ((data.column.index === 4 || data.column.index === 6) && typeof data.cell.raw === 'string') {
              const v = data.cell.raw as string;
              if (v.startsWith('+')) data.cell.styles.textColor = [4, 120, 87];
              else if (v.startsWith('-')) data.cell.styles.textColor = [185, 28, 28];
            }
          }
        },
      });

      const pages = doc.getNumberOfPages();
      for (let i = 1; i <= pages; i++) {
        doc.setPage(i);
        doc.setFontSize(6.5);
        doc.setTextColor(150);
        doc.text(`Seite ${i} / ${pages}`, PW / 2, 205, { align: 'center' });
      }
      doc.save(`spaltenbericht-${format(from, 'yyyy-MM-dd')}.pdf`);

    } else {
      // ── Dashboard PDF (Portrait A4) ─────────────────────────────────
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const PW = 210; const M = 14;
      const HS = { fillColor: [30, 41, 59] as [number, number, number] };
      const ST = { fontSize: 8.5 };

      doc.setFillColor(30, 41, 59);
      doc.rect(0, 0, PW, 28, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(255, 255, 255);
      doc.text('Kennzahlen Bericht', M, 12);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.text(rangeLabel, M, 20);
      doc.text(`Erstellt: ${format(new Date(), 'dd.MM.yyyy HH:mm')}`, PW - M, 20, { align: 'right' });

      let y = 36;
      const pkPctPdf  = summary.netTotal > 0 ? (summary.laborActual / summary.netTotal) * 100 : 0;
      const wesPctPdf = summary.netTotal > 0 ? (summary.warenTotal  / summary.netTotal) * 100 : 0;
      const wFPdf     = summary.foodNet  > 0 && summary.warenFood > 0 ? (summary.warenFood / summary.foodNet) * 100 : 0;
      const wBPdf     = summary.bevNet   > 0 && summary.warenBev  > 0 ? (summary.warenBev  / summary.bevNet)  * 100 : 0;
      const budDiffP  = summary.netTotal - summary.plannedNet;
      const budDiffPP = summary.plannedNet > 0 ? (budDiffP / summary.plannedNet) * 100 : 0;
      const vjDiffP   = summary.netTotal - summary.vjNet;
      const vjDiffPP  = summary.vjNet > 0 ? (vjDiffP / summary.vjNet) * 100 : 0;

      const sec = (title: string) => {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(30, 41, 59);
        doc.text(title, M, y); y += 2;
      };

      sec('Umsatzübersicht');
      autoTable(doc, {
        startY: y, margin: { left: M, right: M },
        head: [['Kennzahl', 'Wert']],
        body: [
          ['Nettoumsatz Total',       fmtChf(summary.netTotal)],
          ['Bruttoumsatz Total',      fmtChf(summary.grossTotal)],
          ['Budget Nettoumsatz',      summary.plannedNet > 0 ? fmtChf(summary.plannedNet) : '—'],
          ['Abw. Budget',             summary.plannedNet > 0 ? `${sgn(budDiffP)}${fmtChf(budDiffP)} (${sgn(budDiffPP)}${budDiffPP.toFixed(1)} %)` : '—'],
          ['Vorjahr Nettoumsatz',     summary.vjNet > 0 ? fmtChf(summary.vjNet) : '—'],
          ['Abw. Vorjahr',            summary.vjNet > 0 ? `${sgn(vjDiffP)}${fmtChf(vjDiffP)} (${sgn(vjDiffPP)}${vjDiffPP.toFixed(1)} %)` : '—'],
        ],
        headStyles: HS, styles: ST,
      });
      y = (doc as any).lastAutoTable.finalY + 8;

      sec('Personal Kennzahlen');
      autoTable(doc, {
        startY: y, margin: { left: M, right: M },
        head: [['Kennzahl', 'Wert']],
        body: [
          ['Personalkosten Ist',  fmtChf(summary.laborActual)],
          ['Personalkosten Plan', summary.laborPlanned > 0 ? fmtChf(summary.laborPlanned) : '—'],
          ['Personalkostenquote', summary.netTotal > 0 ? fmtPct(pkPctPdf) : '—'],
        ],
        headStyles: HS, styles: ST,
      });
      y = (doc as any).lastAutoTable.finalY + 8;

      sec('Warenaufwand / WES');
      autoTable(doc, {
        startY: y, margin: { left: M, right: M },
        head: [['Kategorie', 'CHF', '% vom Umsatz']],
        body: [
          ['Food',      n2(summary.warenFood),  wFPdf > 0 ? fmtPct(wFPdf) : '—'],
          ['Beverage',  n2(summary.warenBev),   wBPdf > 0 ? fmtPct(wBPdf) : '—'],
          ['Sonstiges', n2(summary.warenSonst), '—'],
          ['Total',     n2(summary.warenTotal), summary.netTotal > 0 && summary.warenTotal > 0 ? fmtPct(wesPctPdf) : '—'],
        ],
        headStyles: HS, styles: ST,
      });

      const pages = doc.getNumberOfPages();
      for (let i = 1; i <= pages; i++) {
        doc.setPage(i);
        doc.setFontSize(7); doc.setTextColor(150);
        doc.text(`Seite ${i} / ${pages}`, PW / 2, 288, { align: 'center' });
      }
      doc.save(`kennzahlen-bericht-${format(from, 'yyyy-MM-dd')}.pdf`);
    }
  }, [summary, viewMode, rangeLabel, from, excelRows]);

  // ── Pre-compute derived values (no division in JSX) ───────────────────

  const pkPct      = summary && summary.netTotal > 0    ? (summary.laborActual / summary.netTotal)   * 100 : 0;
  const wesPct     = summary && summary.netTotal > 0    ? (summary.warenTotal  / summary.netTotal)   * 100 : 0;
  const wesFoodPct = summary && summary.foodNet  > 0    ? (summary.warenFood   / summary.foodNet)    * 100 : 0;
  const wesBevPct  = summary && summary.bevNet   > 0    ? (summary.warenBev    / summary.bevNet)     * 100 : 0;
  const budDiff    = summary && summary.plannedNet > 0  ? summary.netTotal - summary.plannedNet       : null;
  const budPct     = summary && summary.plannedNet > 0  ? ((summary.netTotal - summary.plannedNet) / summary.plannedNet) * 100 : null;
  const vjDiff     = summary && summary.vjNet > 0       ? summary.netTotal - summary.vjNet            : null;
  const vjPct      = summary && summary.vjNet > 0       ? ((summary.netTotal - summary.vjNet) / summary.vjNet) * 100 : null;
  const avgDaily   = summary && summary.daysWithData > 0 ? summary.netTotal / summary.daysWithData    : 0;
  const laborDiff  = summary ? summary.laborActual - summary.laborPlanned : 0;

  const tlRev  = summary ? tLight(summary.netTotal,    summary.plannedNet)             : 'yellow';
  const tlPk   = summary ? tLight(summary.laborActual, summary.netTotal * 0.35, true)  : 'yellow';
  const tlWes  = summary && summary.warenTotal > 0 ? tLight(summary.warenTotal, summary.netTotal * 0.32, true) : 'yellow';
  const tlBudg = summary && budDiff !== null ? tLight(summary.netTotal, summary.plannedNet) : 'yellow';

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">

      {/* ── Sticky Header ──────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 bg-card border-b border-border shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">Kennzahlen Bericht</h1>
          </div>
          <span className="text-xs text-muted-foreground hidden sm:block">{rangeLabel}</span>

          {/* View toggle */}
          <div className="flex items-center gap-0.5 bg-muted rounded-md p-0.5 ml-2">
            <button
              onClick={() => setViewMode('dashboard')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors',
                viewMode === 'dashboard' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <LayoutDashboard className="h-3 w-3" />
              Dashboard
            </button>
            <button
              onClick={() => setViewMode('excel')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors',
                viewMode === 'excel' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Table2 className="h-3 w-3" />
              Excel Ansicht
            </button>
          </div>

          <div className="ml-auto">
            <button
              onClick={exportPdf}
              disabled={!summary || loading}
              className="flex items-center gap-1.5 h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-40 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              PDF exportieren
            </button>
          </div>
        </div>
      </header>

      <main className={cn('mx-auto px-4 py-4 space-y-4', viewMode === 'excel' ? 'max-w-5xl' : 'max-w-7xl')}>

        {/* ── Period selector ──────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-1.5 items-center">
          {PERIOD_BTNS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setPeriod(key)}
              className={cn(
                'px-3 py-1 rounded-full text-xs font-medium transition-colors border',
                period === key
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'text-muted-foreground hover:text-foreground border-border',
              )}
            >
              {label}
            </button>
          ))}
          {period === 'custom' && (
            <div className="flex items-center gap-2 ml-1">
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                className="h-7 rounded border border-border bg-background px-2 text-xs" />
              <span className="text-xs text-muted-foreground">–</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                className="h-7 rounded border border-border bg-background px-2 text-xs" />
            </div>
          )}
        </div>

        {/* ── Loading ──────────────────────────────────────────────────── */}
        {loading && (
          <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground text-sm">
            <div className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            Lade Berichtsdaten…
          </div>
        )}

        {/* ── Dashboard view ───────────────────────────────────────────── */}
        {!loading && summary && viewMode === 'dashboard' && <>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard label="Nettoumsatz"    value={fmtChf(summary.netTotal)}
              sub={summary.daysWithData > 0 ? `${summary.daysWithData} Tage mit Umsatz` : 'Keine Daten'} light={tlRev} />
            <KpiCard label="Personalkosten" value={fmtChf(summary.laborActual)}
              sub={summary.netTotal > 0 ? `${fmtPct(pkPct)} vom Umsatz` : '—'} light={tlPk} />
            <KpiCard label="WES Total"      value={summary.warenTotal > 0 ? fmtChf(summary.warenTotal) : '—'}
              sub={summary.warenTotal > 0 ? `${fmtPct(wesPct)} vom Umsatz` : 'Keine Rechnungen'} light={tlWes} />
            <KpiCard label="Abw. Budget"    value={budDiff !== null ? `${sgn(budDiff)}${fmtChf(budDiff)}` : '—'}
              sub={budPct !== null ? `${sgn(budPct)}${fmtPct(budPct)}` : 'Kein Budget'} light={tlBudg} />
          </div>

          <BSection title="Umsatzübersicht" icon={<DollarSign className="h-4 w-4" />}>
            <DGrid>
              <Row label="Nettoumsatz Total"       value={fmtChf(summary.netTotal)} bold />
              <Row label="Bruttoumsatz Total"      value={fmtChf(summary.grossTotal)} />
              <Row label="Umsatz Food (netto)"     value={summary.foodNet > 0 ? fmtChf(summary.foodNet) : '—'} />
              <Row label="Umsatz Beverage (netto)" value={summary.bevNet  > 0 ? fmtChf(summary.bevNet)  : '—'} />
              <Row label="Tage mit Umsatz"         value={`${summary.daysWithData} / ${summary.daysTotal}`} />
              <Row label="Ø Tagesumsatz (netto)"   value={avgDaily > 0 ? fmtChf(avgDaily) : '—'} />
              <Row label="Anzahl Bons / Gäste"     value="—" hint="gastronovi Import" />
              <Row label="Durchschnittsbon"        value="—" hint="gastronovi Import" />
              <Row label="Rabatte / Stornos"       value="—" hint="gastronovi Import" />
            </DGrid>
          </BSection>

          <BSection title="Vergleichswerte" icon={<TrendingUp className="h-4 w-4" />}>
            <DGrid>
              <Row label="Budget Nettoumsatz"
                value={summary.plannedNet > 0 ? fmtChf(summary.plannedNet) : '—'} />
              <Row label="Abw. Budget (CHF)"
                value={budDiff !== null ? `${sgn(budDiff)}${fmtChf(budDiff)}` : '—'}
                diff={budDiff !== null ? (budDiff >= 0 ? 'pos' : 'neg') : undefined} />
              <Row label="Abw. Budget (%)"
                value={budPct !== null ? `${sgn(budPct)}${fmtPct(budPct)}` : '—'}
                diff={budPct !== null ? (budPct >= 0 ? 'pos' : 'neg') : undefined} />
              <Row label="Vorjahr Nettoumsatz"
                value={summary.vjNet > 0 ? fmtChf(summary.vjNet) : '—'} />
              <Row label="Abw. Vorjahr (CHF)"
                value={vjDiff !== null ? `${sgn(vjDiff)}${fmtChf(vjDiff)}` : '—'}
                diff={vjDiff !== null ? (vjDiff >= 0 ? 'pos' : 'neg') : undefined} />
              <Row label="Abw. Vorjahr (%)"
                value={vjPct !== null ? `${sgn(vjPct)}${fmtPct(vjPct)}` : '—'}
                diff={vjPct !== null ? (vjPct >= 0 ? 'pos' : 'neg') : undefined} />
              <Row label="PK-Quote vs. Ziel (35 %)"
                value={summary.netTotal > 0 ? fmtPct(pkPct) : '—'}
                diff={summary.netTotal > 0 ? (pkPct <= 35 ? 'pos' : 'neg') : undefined} />
              <Row label="WES-Quote vs. Ziel (32 %)"
                value={summary.netTotal > 0 && summary.warenTotal > 0 ? fmtPct(wesPct) : '—'}
                diff={summary.netTotal > 0 && summary.warenTotal > 0 ? (wesPct <= 32 ? 'pos' : 'neg') : undefined} />
            </DGrid>
          </BSection>

          <BSection title="Personal Kennzahlen" icon={<Clock className="h-4 w-4" />}>
            <DGrid>
              <Row label="Personalkosten Ist"    value={fmtChf(summary.laborActual)} bold />
              <Row label="Personalkosten Plan"   value={summary.laborPlanned > 0 ? fmtChf(summary.laborPlanned) : '—'} />
              <Row label="Abw. Personalkosten"
                value={summary.laborPlanned > 0 ? `${sgn(laborDiff)}${fmtChf(laborDiff)}` : '—'}
                diff={summary.laborPlanned > 0 ? (laborDiff <= 0 ? 'pos' : 'neg') : undefined} />
              <Row label="Personalkostenquote"   value={summary.netTotal > 0 ? fmtPct(pkPct) : '—'} bold />
              <Row label="Geplante Stunden"      value="—" hint="Dienstplanung" />
              <Row label="Ist Stunden"           value="—" hint="Mirus Import" />
              <Row label="Umsatz / Arbeitsstunde" value="—" hint="Stundenerfassung" />
              <Row label="PK pro Gast"           value="—" hint="Gästezahlen" />
            </DGrid>
          </BSection>

          <BSection title="Warenaufwand / WES" icon={<Package className="h-4 w-4" />}>
            {summary.warenTotal === 0 ? (
              <p className="text-sm text-muted-foreground py-1">
                Keine Warenrechnungen für diesen Zeitraum — Daten werden unter Warenrechnungen gepflegt.
              </p>
            ) : (
              <DGrid>
                <Row label="Warenaufwand Food"      value={summary.warenFood  > 0 ? fmtChf(summary.warenFood)  : '—'} />
                <Row label="WES Food %"             value={summary.foodNet > 0 && summary.warenFood > 0 ? fmtPct(wesFoodPct) : '—'} />
                <Row label="Warenaufwand Beverage"  value={summary.warenBev   > 0 ? fmtChf(summary.warenBev)   : '—'} />
                <Row label="WES Beverage %"         value={summary.bevNet > 0 && summary.warenBev > 0 ? fmtPct(wesBevPct) : '—'} />
                <Row label="Warenaufwand Sonstiges" value={summary.warenSonst > 0 ? fmtChf(summary.warenSonst) : '—'} />
                <Row label="WES Total %"            value={summary.netTotal > 0 ? fmtPct(wesPct) : '—'} bold />
              </DGrid>
            )}
          </BSection>

          <BSection title="Gäste / Kunden Kennzahlen" icon={<Users className="h-4 w-4" />}>
            <DGrid>
              <Row label="Anzahl Gäste / Personen" value="—" hint="gastronovi Import" />
              <Row label="Umsatz pro Gast"         value="—" hint="Gästezahlen" />
              <Row label="Ø Gäste pro Tag"         value="—" hint="Gästezahlen" />
              <Row label="Bons pro Gast"           value="—" hint="gastronovi Z-Bericht" />
            </DGrid>
          </BSection>

          {summary.chart.length > 0 && summary.chart.some(d => d.net > 0) && (
            <BSection title="Umsatzverlauf" icon={<BarChart2 className="h-4 w-4" />}>
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={summary.chart} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} width={42} />
                    <Tooltip formatter={(val: number, name: string) => [fmtChf(val), name]} contentStyle={{ fontSize: 11 }} labelStyle={{ fontWeight: 600 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="net"     name="Ist (netto)" fill="hsl(217 91% 60%)"  radius={[2,2,0,0]} />
                    <Bar dataKey="planned" name="Budget"      fill="hsl(215 20% 68%)"  radius={[2,2,0,0]} opacity={0.55} />
                    <Line dataKey="vj"     name="Vorjahr"     stroke="hsl(38 92% 50%)" strokeDasharray="4 2" dot={false} strokeWidth={1.5} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </BSection>
          )}
        </>}

        {/* ── Excel view ───────────────────────────────────────────────── */}
        {!loading && summary && viewMode === 'excel' && (
          <ExcelView rows={excelRows} rangeLabel={rangeLabel} />
        )}

        {!loading && !summary && (
          <div className="text-center py-16 text-muted-foreground text-sm">
            Keine Daten für den ausgewählten Zeitraum.
          </div>
        )}

      </main>
    </div>
  );
}

// ── Excel View ────────────────────────────────────────────────────────────

function ExcelView({ rows, rangeLabel }: { rows: XRow[]; rangeLabel: string }) {
  return (
    <div className="rounded-lg border border-border bg-white dark:bg-card overflow-hidden shadow-sm">
      {/* Table header info */}
      <div className="px-4 py-2 bg-slate-800 text-white flex items-center justify-between">
        <span className="text-xs font-semibold tracking-wide">SPALTENBERICHT</span>
        <span className="text-xs opacity-70">{rangeLabel}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          {/* Column headers */}
          <thead>
            <tr className="bg-slate-100 dark:bg-muted border-b-2 border-slate-300 dark:border-border">
              <th className="text-left px-3 py-2 font-semibold text-slate-700 dark:text-foreground w-[40%]">
                Kennzahl
              </th>
              <th className="text-right px-2 py-2 font-semibold text-slate-700 dark:text-foreground whitespace-nowrap">
                Budget
              </th>
              <th className="text-right px-2 py-2 font-semibold text-slate-700 dark:text-foreground whitespace-nowrap">
                Vorjahr
              </th>
              <th className="text-right px-2 py-2 font-semibold text-slate-700 dark:text-foreground whitespace-nowrap">
                Woche
              </th>
              <th className="text-right px-2 py-2 font-semibold text-slate-500 dark:text-muted-foreground whitespace-nowrap text-[11px]">
                +/- %
              </th>
              <th className="text-right px-2 py-2 font-semibold text-slate-700 dark:text-foreground whitespace-nowrap">
                Monat
              </th>
              <th className="text-right px-2 py-2 font-semibold text-slate-500 dark:text-muted-foreground whitespace-nowrap text-[11px]">
                +/- %
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => <ExcelRow key={i} row={row} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExcelRow({ row }: { row: XRow }) {
  if (row.isSection) {
    return (
      <tr className="bg-slate-100 dark:bg-muted/60 border-t border-slate-200 dark:border-border">
        <td colSpan={7} className="px-3 py-1.5 font-semibold text-slate-600 dark:text-muted-foreground text-[11px] uppercase tracking-wider">
          {row.label}
        </td>
      </tr>
    );
  }

  const fmt = row.isPct ? p2 : n2;

  // Pre-compute deviations (no division in JSX)
  const wDev  = row.week !== null && row.weekBudget !== null && row.weekBudget > 0
    ? ((row.week - row.weekBudget) / row.weekBudget) * 100 : null;
  const mDev  = row.month !== null && row.budget !== null && row.budget > 0
    ? ((row.month - row.budget) / row.budget) * 100 : null;

  const wDevStr = wDev !== null ? fmtDev(wDev) : '—';
  const mDevStr = mDev !== null ? fmtDev(mDev) : '—';
  const wDevCls = wDev !== null ? (wDev >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400') : 'text-muted-foreground';
  const mDevCls = mDev !== null ? (mDev >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400') : 'text-muted-foreground';

  return (
    <tr className="border-b border-slate-100 dark:border-border/30 hover:bg-slate-50 dark:hover:bg-muted/20 transition-colors">
      <td className={cn(
        'px-3 py-1.5 text-slate-800 dark:text-foreground',
        row.isBold   && 'font-semibold',
        row.isIndent && 'pl-7 text-slate-600 dark:text-muted-foreground',
      )}>
        {row.label}
      </td>
      <td className="text-right px-2 py-1.5 tabular-nums text-slate-500 dark:text-muted-foreground">
        {fmt(row.budget)}
      </td>
      <td className="text-right px-2 py-1.5 tabular-nums text-slate-500 dark:text-muted-foreground">
        {fmt(row.vj)}
      </td>
      <td className={cn('text-right px-2 py-1.5 tabular-nums', row.isBold ? 'font-semibold' : '')}>
        {fmt(row.week)}
      </td>
      <td className={cn('text-right px-2 py-1.5 tabular-nums text-[11px]', wDevCls)}>
        {wDevStr}
      </td>
      <td className={cn('text-right px-2 py-1.5 tabular-nums', row.isBold ? 'font-semibold' : '')}>
        {fmt(row.month)}
      </td>
      <td className={cn('text-right px-2 py-1.5 tabular-nums text-[11px]', mDevCls)}>
        {mDevStr}
      </td>
    </tr>
  );
}

// ── Dashboard sub-components ──────────────────────────────────────────────

function BSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-2 border-b border-border bg-muted/40 flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  );
}

function DGrid({ children }: { children: ReactNode }) {
  return <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-8">{children}</div>;
}

function KpiCard({ label, value, sub, light }: {
  label: string; value: string; sub: string; light: 'green' | 'yellow' | 'red';
}) {
  const dot = light === 'green' ? 'bg-emerald-500' : light === 'red' ? 'bg-red-500' : 'bg-amber-400';
  return (
    <div className="rounded-lg border border-border bg-card p-3 flex flex-col gap-1 min-h-[80px]">
      <div className="flex items-center gap-1.5">
        <span className={cn('h-2 w-2 rounded-full shrink-0', dot)} />
        <p className="text-[11px] text-muted-foreground truncate">{label}</p>
      </div>
      <p className="text-lg font-bold leading-tight tracking-tight">{value}</p>
      <p className="text-[11px] text-muted-foreground leading-tight">{sub}</p>
    </div>
  );
}

function Row({ label, value, bold, hint, diff }: {
  label: string; value: string; bold?: boolean; hint?: string; diff?: 'pos' | 'neg';
}) {
  const vc = diff === 'pos' ? 'text-emerald-600 dark:text-emerald-400'
           : diff === 'neg' ? 'text-red-600 dark:text-red-400' : '';
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 border-b border-border/30 last:border-0">
      <div className="flex items-baseline gap-1 min-w-0">
        <span className="text-xs text-muted-foreground truncate">{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground/50 whitespace-nowrap shrink-0">({hint})</span>}
      </div>
      <span className={cn('text-xs font-medium whitespace-nowrap shrink-0', bold && 'font-bold text-sm', vc)}>
        {value}
      </span>
    </div>
  );
}
