/**
 * KennzahlenBerichtPage — Management Report / Kennzahlen Bericht
 *
 * Datenquellen (aktuell live):
 *   - dailyBudgets (localStorage / Supabase KV): Umsatz, PK, Budget, VJ
 *   - Warenrechnungen (Supabase KV): WES Food / Beverage / Sonstiges
 *
 * Vorbereitet für spätere Erweiterung:
 *   - Gästezahlen aus gastronovi Z-Bericht
 *   - Stunden aus Mirus / Dienstplanung
 *   - Zahlungsarten, Artikel-Gruppen
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
  chart: { label: string; net: number; planned: number; vj: number }[];
}

// ── Module-level helpers ──────────────────────────────────────────────────

function readBudgets(tenantId: string): Record<string, DailyBudget> {
  try {
    const k = tenantId === 'beaulieu' ? 'beaulieu:dailyBudgets' : 'dailyBudgets';
    return JSON.parse(localStorage.getItem(k) || '{}');
  } catch { return {}; }
}

const FMT = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
function chf(v: number) { return `CHF ${FMT.format(Math.round(v))}`; }
function pct(v: number) { return v.toFixed(1) + ' %'; }
function sgn(v: number) { return v >= 0 ? '+' : ''; }

function tLight(actual: number, target: number, lowerIsBetter = false): 'green' | 'yellow' | 'red' {
  if (target <= 0 || actual <= 0) return 'yellow';
  const r = actual / target;
  if (lowerIsBetter) {
    if (r <= 1.0)  return 'green';
    if (r <= 1.12) return 'yellow';
    return 'red';
  }
  if (r >= 0.97) return 'green';
  if (r >= 0.88) return 'yellow';
  return 'red';
}

// ── Main component ────────────────────────────────────────────────────────

export default function KennzahlenBerichtPage() {
  const { tenantId } = useTenant();
  const today = useMemo(() => new Date(), []);

  const [period,     setPeriod]     = useState<Period>('monat');
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
          const f = parseISO(customFrom);
          const t = parseISO(customTo);
          return { from: f, to: t };
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
        const budgets = readBudgets(tenantId);
        const days    = eachDayOfInterval({ start: from, end: to });
        const nDays   = days.length;
        const lblFmt  = nDays > 90 ? 'MMM yy' : nDays > 14 ? 'dd.MM' : 'dd.MM.';

        let grossTotal   = 0, netTotal   = 0;
        let foodGross    = 0, bevGross   = 0;
        let plannedGross = 0, vjGross    = 0;
        let laborActual  = 0, laborPlanned = 0;
        let daysWithData = 0;
        const chartMap = new Map<string, { net: number; planned: number; vj: number }>();

        for (const day of days) {
          const key = format(day, 'yyyy-MM-dd');
          const d   = budgets[key];
          const gross  = d?.actualRevenue   ?? 0;
          const ta     = d?.takeawayRevenue  ?? 0;
          const net    = grossToNet(gross, ta);
          const planG  = d?.plannedRevenue   ?? 0;
          const vjG    = d?.previousYearRevenue ?? 0;

          grossTotal   += gross;
          netTotal     += net;
          foodGross    += d?.actualFood      ?? 0;
          bevGross     += d?.actualBeverage  ?? 0;
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
        }

        // Waren invoices for all months in range
        const months = [...new Set(days.map(d => format(d, 'yyyy-MM')))];
        const allInv = (await Promise.all(months.map(m => loadMonthInvoices(tenantId, m))))
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
          chart:       Array.from(chartMap.entries()).map(([label, v]) => ({ label, ...v })),
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

  // ── PDF export ────────────────────────────────────────────────────────

  const exportPdf = useCallback(async () => {
    if (!summary) return;
    const { default: jsPDF }     = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const PW = 210; const M = 14;
    const HS = { fillColor: [30, 41, 59] as [number, number, number] };
    const ST = { fontSize: 8.5 };

    // Header band
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

    // Pre-compute PDF values (all divisions here, never in JSX)
    const pkPctPdf  = summary.netTotal > 0 ? (summary.laborActual / summary.netTotal) * 100 : 0;
    const wesPctPdf = summary.netTotal > 0 ? (summary.warenTotal  / summary.netTotal) * 100 : 0;
    const wFPdf     = summary.foodNet  > 0 && summary.warenFood > 0 ? (summary.warenFood / summary.foodNet) * 100 : 0;
    const wBPdf     = summary.bevNet   > 0 && summary.warenBev  > 0 ? (summary.warenBev  / summary.bevNet)  * 100 : 0;
    const budDiff   = summary.plannedNet > 0 ? summary.netTotal - summary.plannedNet : null;
    const budDiffP  = summary.plannedNet > 0 ? ((summary.netTotal - summary.plannedNet) / summary.plannedNet) * 100 : null;
    const vjDiff    = summary.vjNet > 0 ? summary.netTotal - summary.vjNet : null;
    const vjDiffP   = summary.vjNet  > 0 ? ((summary.netTotal - summary.vjNet) / summary.vjNet) * 100 : null;

    const section = (title: string) => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(30, 41, 59);
      doc.text(title, M, y);
      y += 2;
    };

    // Umsatz
    section('Umsatzübersicht');
    autoTable(doc, {
      startY: y, margin: { left: M, right: M },
      head: [['Kennzahl', 'Wert']],
      body: [
        ['Nettoumsatz Total',        chf(summary.netTotal)],
        ['Bruttoumsatz Total',       chf(summary.grossTotal)],
        ['Umsatz Food (netto)',      summary.foodNet > 0 ? chf(summary.foodNet) : '—'],
        ['Umsatz Beverage (netto)',  summary.bevNet  > 0 ? chf(summary.bevNet)  : '—'],
        ['Budget Nettoumsatz',       summary.plannedNet > 0 ? chf(summary.plannedNet) : '—'],
        ['Abw. Budget',              budDiff !== null ? `${sgn(budDiff)}${chf(budDiff)} (${sgn(budDiffP!)}${budDiffP!.toFixed(1)} %)` : '—'],
        ['Vorjahr Nettoumsatz',      summary.vjNet > 0 ? chf(summary.vjNet) : '—'],
        ['Abw. Vorjahr',             vjDiff  !== null ? `${sgn(vjDiff)}${chf(vjDiff)} (${sgn(vjDiffP!)}${vjDiffP!.toFixed(1)} %)` : '—'],
      ],
      headStyles: HS, styles: ST,
    });
    y = (doc as any).lastAutoTable.finalY + 8;

    // Personal
    section('Personal Kennzahlen');
    autoTable(doc, {
      startY: y, margin: { left: M, right: M },
      head: [['Kennzahl', 'Wert']],
      body: [
        ['Personalkosten Ist',  chf(summary.laborActual)],
        ['Personalkosten Plan', summary.laborPlanned > 0 ? chf(summary.laborPlanned) : '—'],
        ['Personalkostenquote', summary.netTotal > 0 ? pct(pkPctPdf) : '—'],
      ],
      headStyles: HS, styles: ST,
    });
    y = (doc as any).lastAutoTable.finalY + 8;

    // WES
    section('Warenaufwand / WES');
    autoTable(doc, {
      startY: y, margin: { left: M, right: M },
      head: [['Kategorie', 'CHF', '% vom Umsatz']],
      body: [
        ['Food',      summary.warenFood  > 0 ? FMT.format(Math.round(summary.warenFood))  : '—', wFPdf > 0 ? pct(wFPdf) : '—'],
        ['Beverage',  summary.warenBev   > 0 ? FMT.format(Math.round(summary.warenBev))   : '—', wBPdf > 0 ? pct(wBPdf) : '—'],
        ['Sonstiges', summary.warenSonst > 0 ? FMT.format(Math.round(summary.warenSonst)) : '—', '—'],
        ['Total',     summary.warenTotal > 0 ? FMT.format(Math.round(summary.warenTotal)) : '—',
          summary.netTotal > 0 && summary.warenTotal > 0 ? pct(wesPctPdf) : '—'],
      ],
      headStyles: HS, styles: ST,
    });

    // Page footer
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(`Seite ${i} / ${pages}`, PW / 2, 288, { align: 'center' });
    }
    doc.save(`kennzahlen-bericht-${format(from, 'yyyy-MM-dd')}.pdf`);
  }, [summary, rangeLabel, from]);

  // ── Pre-compute ALL derived values (no division in JSX) ────────────────

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

  const tlRev  = summary ? tLight(summary.netTotal,     summary.plannedNet)             : 'yellow';
  const tlPk   = summary ? tLight(summary.laborActual,  summary.netTotal * 0.35, true)  : 'yellow';
  const tlWes  = summary && summary.warenTotal > 0 ? tLight(summary.warenTotal, summary.netTotal * 0.32, true) : 'yellow';
  const tlBudg = summary && budDiff !== null ? tLight(summary.netTotal, summary.plannedNet) : 'yellow';

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">

      {/* ── Sticky Header ──────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 bg-card border-b border-border shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">Kennzahlen Bericht</h1>
          </div>
          <span className="text-xs text-muted-foreground hidden sm:block">{rangeLabel}</span>
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

      <main className="max-w-7xl mx-auto px-4 py-4 space-y-4">

        {/* ── Period selector ────────────────────────────────────────────── */}
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
              <input
                type="date" value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
                className="h-7 rounded border border-border bg-background px-2 text-xs"
              />
              <span className="text-xs text-muted-foreground">–</span>
              <input
                type="date" value={customTo}
                onChange={e => setCustomTo(e.target.value)}
                className="h-7 rounded border border-border bg-background px-2 text-xs"
              />
            </div>
          )}
        </div>

        {/* ── Loading ───────────────────────────────────────────────────── */}
        {loading && (
          <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground text-sm">
            <div className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            Lade Berichtsdaten…
          </div>
        )}

        {!loading && summary && <>

          {/* ── KPI Cards ───────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard
              label="Nettoumsatz"
              value={chf(summary.netTotal)}
              sub={summary.daysWithData > 0 ? `${summary.daysWithData} Tage mit Umsatz` : 'Keine Umsatzdaten'}
              light={tlRev}
            />
            <KpiCard
              label="Personalkosten"
              value={chf(summary.laborActual)}
              sub={summary.netTotal > 0 ? `${pct(pkPct)} vom Umsatz` : '—'}
              light={tlPk}
            />
            <KpiCard
              label="WES Total"
              value={summary.warenTotal > 0 ? chf(summary.warenTotal) : '—'}
              sub={summary.warenTotal > 0 ? `${pct(wesPct)} vom Umsatz` : 'Keine Rechnungen'}
              light={tlWes}
            />
            <KpiCard
              label="Abw. Budget"
              value={budDiff !== null ? `${sgn(budDiff)}${chf(budDiff)}` : '—'}
              sub={budPct !== null ? `${sgn(budPct)}${pct(budPct)}` : 'Kein Budget'}
              light={tlBudg}
            />
          </div>

          {/* ── Umsatz ──────────────────────────────────────────────────── */}
          <BSection title="Umsatzübersicht" icon={<DollarSign className="h-4 w-4" />}>
            <Grid>
              <Row label="Nettoumsatz Total"       value={chf(summary.netTotal)} bold />
              <Row label="Bruttoumsatz Total"      value={chf(summary.grossTotal)} />
              <Row label="Umsatz Food (netto)"     value={summary.foodNet > 0 ? chf(summary.foodNet) : '—'} />
              <Row label="Umsatz Beverage (netto)" value={summary.bevNet  > 0 ? chf(summary.bevNet)  : '—'} />
              <Row label="Tage mit Umsatz"         value={`${summary.daysWithData} / ${summary.daysTotal}`} />
              <Row label="Ø Tagesumsatz (netto)"   value={avgDaily > 0 ? chf(avgDaily) : '—'} />
              <Row label="Anzahl Bons / Gäste"     value="—" hint="gastronovi Import" />
              <Row label="Durchschnittsbon"        value="—" hint="gastronovi Import" />
              <Row label="Rabatte / Stornos"       value="—" hint="gastronovi Import" />
            </Grid>
          </BSection>

          {/* ── Vergleichswerte ─────────────────────────────────────────── */}
          <BSection title="Vergleichswerte" icon={<TrendingUp className="h-4 w-4" />}>
            <Grid>
              <Row label="Budget Nettoumsatz"
                value={summary.plannedNet > 0 ? chf(summary.plannedNet) : '—'} />
              <Row label="Abw. Budget (CHF)"
                value={budDiff !== null ? `${sgn(budDiff)}${chf(budDiff)}` : '—'}
                diff={budDiff !== null ? (budDiff >= 0 ? 'pos' : 'neg') : undefined} />
              <Row label="Abw. Budget (%)"
                value={budPct !== null ? `${sgn(budPct)}${pct(budPct)}` : '—'}
                diff={budPct !== null ? (budPct >= 0 ? 'pos' : 'neg') : undefined} />
              <Row label="Vorjahr Nettoumsatz"
                value={summary.vjNet > 0 ? chf(summary.vjNet) : '—'} />
              <Row label="Abw. Vorjahr (CHF)"
                value={vjDiff !== null ? `${sgn(vjDiff)}${chf(vjDiff)}` : '—'}
                diff={vjDiff !== null ? (vjDiff >= 0 ? 'pos' : 'neg') : undefined} />
              <Row label="Abw. Vorjahr (%)"
                value={vjPct !== null ? `${sgn(vjPct)}${pct(vjPct)}` : '—'}
                diff={vjPct !== null ? (vjPct >= 0 ? 'pos' : 'neg') : undefined} />
              <Row label="PK-Quote vs. Ziel (35 %)"
                value={summary.netTotal > 0 ? pct(pkPct) : '—'}
                diff={summary.netTotal > 0 ? (pkPct <= 35 ? 'pos' : 'neg') : undefined} />
              <Row label="WES-Quote vs. Ziel (32 %)"
                value={summary.netTotal > 0 && summary.warenTotal > 0 ? pct(wesPct) : '—'}
                diff={summary.netTotal > 0 && summary.warenTotal > 0 ? (wesPct <= 32 ? 'pos' : 'neg') : undefined} />
            </Grid>
          </BSection>

          {/* ── Personal ────────────────────────────────────────────────── */}
          <BSection title="Personal Kennzahlen" icon={<Clock className="h-4 w-4" />}>
            <Grid>
              <Row label="Personalkosten Ist"    value={chf(summary.laborActual)} bold />
              <Row label="Personalkosten Plan"   value={summary.laborPlanned > 0 ? chf(summary.laborPlanned) : '—'} />
              <Row label="Abw. Personalkosten"
                value={summary.laborPlanned > 0 ? `${sgn(laborDiff)}${chf(laborDiff)}` : '—'}
                diff={summary.laborPlanned > 0 ? (laborDiff <= 0 ? 'pos' : 'neg') : undefined} />
              <Row label="Personalkostenquote"   value={summary.netTotal > 0 ? pct(pkPct) : '—'} bold />
              <Row label="Geplante Stunden"      value="—" hint="Dienstplanung" />
              <Row label="Ist Stunden"           value="—" hint="Mirus Import" />
              <Row label="Umsatz / Arbeitsstunde" value="—" hint="Benötigt Stundenerfassung" />
              <Row label="PK pro Gast"           value="—" hint="Benötigt Gästezahlen" />
            </Grid>
          </BSection>

          {/* ── WES ─────────────────────────────────────────────────────── */}
          <BSection title="Warenaufwand / WES" icon={<Package className="h-4 w-4" />}>
            {summary.warenTotal === 0 ? (
              <p className="text-sm text-muted-foreground py-1">
                Keine Warenrechnungen für diesen Zeitraum — Daten werden unter Warenrechnungen gepflegt.
              </p>
            ) : (
              <Grid>
                <Row label="Warenaufwand Food"      value={summary.warenFood  > 0 ? chf(summary.warenFood)  : '—'} />
                <Row label="WES Food %"
                  value={summary.foodNet > 0 && summary.warenFood > 0 ? pct(wesFoodPct) : '—'} />
                <Row label="Warenaufwand Beverage"  value={summary.warenBev   > 0 ? chf(summary.warenBev)   : '—'} />
                <Row label="WES Beverage %"
                  value={summary.bevNet > 0 && summary.warenBev > 0 ? pct(wesBevPct) : '—'} />
                <Row label="Warenaufwand Sonstiges" value={summary.warenSonst > 0 ? chf(summary.warenSonst) : '—'} />
                <Row label="WES Total %"            value={summary.netTotal > 0 ? pct(wesPct) : '—'} bold />
              </Grid>
            )}
          </BSection>

          {/* ── Gäste (Platzhalter) ──────────────────────────────────────── */}
          <BSection title="Gäste / Kunden Kennzahlen" icon={<Users className="h-4 w-4" />}>
            <Grid>
              <Row label="Anzahl Gäste / Personen" value="—" hint="gastronovi Import" />
              <Row label="Umsatz pro Gast"         value="—" hint="Benötigt Gästezahlen" />
              <Row label="Ø Gäste pro Tag"         value="—" hint="Benötigt Gästezahlen" />
              <Row label="Bons pro Gast"           value="—" hint="gastronovi Z-Bericht" />
            </Grid>
          </BSection>

          {/* ── Umsatzverlauf Chart ──────────────────────────────────────── */}
          {summary.chart.length > 0 && summary.chart.some(d => d.net > 0) && (
            <BSection title="Umsatzverlauf" icon={<BarChart2 className="h-4 w-4" />}>
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={summary.chart} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                      tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
                      width={42}
                    />
                    <Tooltip
                      formatter={(val: number, name: string) => [chf(val), name]}
                      contentStyle={{ fontSize: 11 }}
                      labelStyle={{ fontWeight: 600 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="net"     name="Ist (netto)"  fill="hsl(217 91% 60%)"  radius={[2, 2, 0, 0]} />
                    <Bar dataKey="planned" name="Budget"       fill="hsl(215 20% 68%)"  radius={[2, 2, 0, 0]} opacity={0.55} />
                    <Line dataKey="vj"     name="Vorjahr"      stroke="hsl(38 92% 50%)" strokeDasharray="4 2" dot={false} strokeWidth={1.5} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </BSection>
          )}

        </>}

        {!loading && !summary && (
          <div className="text-center py-16 text-muted-foreground text-sm">
            Keine Daten für den ausgewählten Zeitraum.
          </div>
        )}

      </main>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

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

function Grid({ children }: { children: ReactNode }) {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-8">
      {children}
    </div>
  );
}

function KpiCard({ label, value, sub, light }: {
  label: string; value: string; sub: string;
  light: 'green' | 'yellow' | 'red';
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
  label: string; value: string; bold?: boolean; hint?: string;
  diff?: 'pos' | 'neg';
}) {
  const vc = diff === 'pos'
    ? 'text-emerald-600 dark:text-emerald-400'
    : diff === 'neg'
    ? 'text-red-600 dark:text-red-400'
    : '';
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
