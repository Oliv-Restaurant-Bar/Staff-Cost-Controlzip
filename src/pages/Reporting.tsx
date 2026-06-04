/**
 * Reporting / Analyse
 * ===================
 * Zentralisierte Analysepage — direkt gekoppelt an die Erfolgsrechnung.
 *
 * DATENBASIS (identisch mit PLView):
 *   IST-Umsatz   → computeMonthlyIstNet()  (Netto, MwSt abgezogen)
 *   VJ-Umsatz    → computeMonthlyVjNet()   (Netto, MwSt abgezogen)
 *   Budget        → budget_v1 (loadBudgetWithPL / resolveBudgetYear)
 *   PK Ist        → personnelCostActual oder 5xxx-Konten aus expenseCategories
 *   Warenaufwand  → total_cogs (4xxx-Konten + human-readable IDs)
 *
 * QUOTEN-SCHUTZ:
 *   safeQuote() gibt null zurück wenn Umsatz < 1'000 CHF oder fehlt.
 *   Niemals werden Fantasiewerte wie 3297% angezeigt.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, ChevronRight, Plus,
  Edit3, Upload, CheckCircle2, AlertCircle, Clock,
  Info, Save, X, FileText, BarChart2, RefreshCw, Settings2, AlertTriangle,
  FileDown, FileSpreadsheet, UserX, Palmtree, Stethoscope, Sheet,
} from 'lucide-react';
import { eachDayOfInterval, startOfMonth, endOfMonth } from 'date-fns';
import {
  computeAbsenceEvents, resolveAbsenceEvent, summarizeAbsences,
  loadAbsenceOverrides,
} from '@/lib/absence-utils';
import { Employee } from '@/types/personnel';
import { DaySchedule } from '@/lib/supabase-db';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as ReTooltip, Legend, ReferenceLine, ComposedChart, Line, Cell,
} from 'recharts';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  MonthlyFinancialRecord,
  MONTH_NAMES_DE, MONTH_NAMES_SHORT_DE,
  calcCompleteness,
} from '@/types/reporting';
import {
  loadYear, saveMonth, availableYears,
  calcAnnualSummary, formatCHF, formatMonthLabel,
} from '@/lib/reporting-store';
import { loadBudgetWithPL, resolveBudgetYear } from '@/lib/budget-store';
import {
  exportReportingToPDF, exportReportingToExcel, calcEffectiveTotals,
  exportMonatsdatenToPDF, exportMonatsdatenToExcel, MonatsdatenRow,
} from '@/lib/reporting-export';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import { Navigate } from 'react-router-dom';
import { parseAnnualRevenueXLSX, AnnualImportResult } from '@/lib/annual-revenue-import';
import { useStichtag } from '@/contexts/StichtagContext';
import { StichtagBanner } from '@/components/StichtagBanner';

// ── NEU: korrekte Netto-Umsatz-Berechnungen (identisch mit PLView) ───────────
import {
  computeMonthlyIstNet,
  computeMonthlyVjNet,
} from '@/lib/revenue-sync';
import { computePLForMonth } from '@/lib/pl-engine';
import type { PLMonthResult } from '@/types/pl';
import { loadVjDailyYear } from '@/lib/vj-daily-supabase';
import type { VjDayRecord } from '@/lib/vj-daily-supabase';
import {
  getMaisonEnabledSync,
  getMaisonDailySync,
  loadMaisonEnabled,
  loadMaisonDaily,
} from '@/lib/maison-store';
import { useMaison } from '@/contexts/MaisonContext';
import { kvGet } from '@/lib/supabase-kv';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const currentYear  = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;

// ─── MonthlyKPI – zentrales Datenobjekt pro Monat ────────────────────────────

interface MonthlyKPI {
  month:            number;       // 1-12
  label:            string;       // 'Jan', 'Feb', …
  // Umsatz
  umsatzIst:        number | null;
  umsatzBudget:     number | null;
  umsatzVorjahr:    number | null;
  // Abweichungen Umsatz (für "Abw. >10%"-Button)
  abwBudgetPct:     number | null;   // (umsatzIst - umsatzBudget) / umsatzBudget * 100
  abwVorjahrPct:    number | null;   // (umsatzIst - umsatzVorjahr) / umsatzVorjahr * 100
  // Personalkosten (aus Dienstplanung / manuelle Erfassung)
  pkIst:            number | null;
  pkBudget:         number | null;
  // Warenaufwand (aus expenseCategories, für Charts)
  warenIst:         number | null;
  warenBudget:      number | null;
  // Quoten (null wenn Umsatz fehlt oder < 1'000 CHF)
  pkQuoteIst:       number | null;
  pkQuoteBudget:    number | null;
  warenQuoteIst:    number | null;
  warenQuoteBudget: number | null;
  // Aus Erfolgsrechnung / P&L (authoritative für Tabelle)
  warenaufwandPL:    number | null;   // total_cogs aus PLMonthResult
  warenaufwandPLPct: number | null;   // warenaufwandPL / umsatzIst * 100
  personalaufwandPL:    number | null; // total_personnel aus PLMonthResult
  personalaufwandPLPct: number | null; // personalaufwandPL / umsatzIst * 100
}

// ─── Warenaufwand-Extraktion ──────────────────────────────────────────────────

const WAREN_HUMAN_IDS = new Set([
  'wareneinsatz_kueche', 'warenaufwand_kueche', 'food_cost',
  'wareneinsatz_bar', 'wareneinsatz_getraenke', 'warenaufwand_getraenke', 'beverage_cost',
  'wareneinsatz_diverses', 'warenaufwand_diverses',
]);

function sumWarenaufwand(rec: MonthlyFinancialRecord): number {
  let total = 0;
  for (const cat of rec.expenseCategories) {
    const n = parseInt(cat.categoryId);
    // Numerische 4xxx-Konten (Sage-CSV-Import, Wareneinkauf)
    if (!isNaN(n) && n >= 4000 && n <= 4999) { total += cat.amount ?? 0; continue; }
    // Human-readable IDs
    if (WAREN_HUMAN_IDS.has(cat.categoryId)) total += cat.amount ?? 0;
  }
  return total;
}

/**
 * Quote berechnen mit Null-Schutz.
 * Gibt null zurück wenn:
 *   - Numerator fehlt oder 0
 *   - Denominator fehlt, 0 oder < 1'000 CHF (verhindert 3297%-Bugs)
 */
function safeQuote(num: number | null | undefined, denom: number | null | undefined): number | null {
  if (!num || num <= 0)      return null;
  if (!denom || denom < 1000) return null;
  return parseFloat(((num / denom) * 100).toFixed(1));
}

// ─── Zentrale KPI-Berechnung ──────────────────────────────────────────────────

function buildMonthlyKPIs(
  effectiveMonths: MonthlyFinancialRecord[],
  plResults?: PLMonthResult[],
): MonthlyKPI[] {
  return effectiveMonths.map((m, idx) => {
    // PLView-kompatible Umsatz-Berechnung: plResult.net_revenue.actual ist die autoritative Quelle
    // (identisch mit PLView-Darstellung — computeMonthlyIstNet hat Vorrang vor 3xxx-Rohsummen)
    const plResult = plResults?.[idx];
    const plNetRevActual = plResult?.rows.find(r => r.def.id === 'net_revenue')?.values.actual;
    const umsatzIst = (plNetRevActual != null && plNetRevActual > 0)
      ? plNetRevActual
      : (m.revenueActual ?? null);
    const umsatzBudget  = m.revenueBudget        ?? null;
    const umsatzVorjahr = m.revenuePreviousYear  ?? null;
    const pkBudget      = m.personnelCostPlanned ?? null;
    const warenRaw      = sumWarenaufwand(m);
    const warenIst      = warenRaw > 0 ? warenRaw : null;

    // Abweichungen
    const abwBudgetPct = umsatzIst != null && umsatzBudget != null && umsatzBudget !== 0
      ? parseFloat((((umsatzIst - umsatzBudget) / Math.abs(umsatzBudget)) * 100).toFixed(1))
      : null;
    const abwVorjahrPct = umsatzIst != null && umsatzVorjahr != null && umsatzVorjahr !== 0
      ? parseFloat((((umsatzIst - umsatzVorjahr) / Math.abs(umsatzVorjahr)) * 100).toFixed(1))
      : null;

    // P&L-basierte Werte (authoritative, identisch mit PLView)
    const plCogs      = plResult?.rows.find(r => r.def.id === 'total_cogs');
    const plPersonnel = plResult?.rows.find(r => r.def.id === 'total_personnel');
    const rawWaren = plCogs?.values.actual ?? null;
    const rawPers  = plPersonnel?.values.actual ?? null;
    const warenaufwandPL = rawWaren != null && rawWaren > 0 ? rawWaren : null;

    // personalaufwandPL + pkIst: beides direkt aus PLEngine total_personnel — identisch mit ER.
    const personalaufwandPL = rawPers != null && rawPers > 0 ? rawPers : null;
    const pkIst             = personalaufwandPL; // Total (Löhne + Sozial + Übriges), nicht nur Lohnkosten

    return {
      month:            idx + 1,
      label:            MONTH_NAMES_SHORT_DE[idx + 1],
      umsatzIst,
      umsatzBudget,
      umsatzVorjahr,
      abwBudgetPct,
      abwVorjahrPct,
      pkIst,
      pkBudget,
      warenIst,
      warenBudget:          null,
      pkQuoteIst:           safeQuote(pkIst,    umsatzIst),
      pkQuoteBudget:        safeQuote(pkBudget, umsatzIst),
      warenQuoteIst:        safeQuote(warenIst, umsatzIst),
      warenQuoteBudget:     null,
      warenaufwandPL,
      warenaufwandPLPct:    safeQuote(warenaufwandPL,    umsatzIst),
      personalaufwandPL,
      personalaufwandPLPct: safeQuote(personalaufwandPL, umsatzIst),
    };
  });
}

// ─── Formatierung ─────────────────────────────────────────────────────────────

const fmtCHF = (v: number | null | undefined): string => {
  if (v == null || v === 0) return '–';
  return new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(v);
};

const fmtPct = (v: number | null | undefined): string => {
  if (v == null) return '–';
  return `${v.toFixed(1)} %`;
};

function varianceColor(actual?: number, budget?: number): string {
  if (!actual || !budget) return '';
  const pct = ((actual - budget) / budget) * 100;
  if (pct >= 0)  return 'text-green-600 dark:text-green-400';
  if (pct >= -5) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function formatVariance(actual?: number, previous?: number): string {
  if (!actual || !previous) return '';
  const pct = ((actual - previous) / previous) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)} %`;
}

// ─── Chart-Konstanten ─────────────────────────────────────────────────────────

const AXIS_STYLE  = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };
const GRID_STROKE = 'hsl(var(--border))';

const C_ACTUAL  = '#4f46e5'; // indigo-600  → Umsatz Ist
const C_BUDGET  = '#d97706'; // amber-600   → Budget / Plan
const C_PREV    = '#94a3b8'; // slate-400   → Vorjahr
const C_PK      = '#ea580c'; // orange-600  → Personalkosten
const C_PK_PLAN = '#fb923c'; // orange-400  → PK Plan (heller)
const C_WAREN   = '#b45309'; // amber-800   → Warenaufwand
const C_WAREN_B = '#d97706'; // amber-600   → Warenaufwand Budget
const C_GREEN   = '#16a34a'; // green-600
const C_AMBER   = '#d97706'; // amber-600
const C_RED     = '#dc2626'; // red-600

function pkBarColor(value: number | null, threshold: number): string {
  if (!value) return C_PREV;
  if (value <= threshold - 2) return C_GREEN;
  if (value <= threshold + 2) return C_AMBER;
  return C_RED;
}

function warenBarColor(value: number | null): string {
  if (!value) return C_PREV;
  if (value <= 28) return C_GREEN;
  if (value <= 33) return C_AMBER;
  return C_RED;
}

// ─── Custom Labels auf Balken ─────────────────────────────────────────────────

const renderPctLabel = (props: Record<string, unknown>) => {
  const { x, y, width, value } = props as { x: number; y: number; width: number; value: number };
  if (!value) return null;
  return (
    <text
      x={x + width / 2}
      y={y - 3}
      textAnchor="middle"
      fontSize={9}
      fontWeight="600"
      fill="hsl(var(--foreground))"
    >
      {`${value.toFixed(1)}%`}
    </text>
  );
};

// ─── Custom Tooltips ──────────────────────────────────────────────────────────

const ChfTooltip = ({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border shadow-lg rounded-lg px-3 py-2 text-xs space-y-1">
      <p className="font-bold text-foreground mb-1">{label}</p>
      {payload.filter(p => p.value > 0).map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-semibold">{fmtCHF(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

const PctTooltip = ({ active, payload, label, extraLabel }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
  extraLabel?: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border shadow-lg rounded-lg px-3 py-2 text-xs space-y-1">
      <p className="font-bold text-foreground mb-1">{label}</p>
      {payload.filter(p => p.value > 0).map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-semibold">{p.value.toFixed(1)} %</span>
        </div>
      ))}
      {extraLabel && <p className="text-muted-foreground/60 text-[10px] pt-0.5">{extraLabel}</p>}
    </div>
  );
};

const NoDataOverlay = ({ message }: { message: string }) => (
  <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground/60 italic">
    {message}
  </div>
);

// ─── Chart 1: Umsatzvergleich ─────────────────────────────────────────────────

const RevenueComparisonTooltip = ({
  active, payload, label, allData,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
  allData: MonthlyKPI[];
}) => {
  if (!active || !payload?.length) return null;
  const entry = allData.find(d => d.label === label);
  const ist    = entry?.umsatzIst    ?? null;
  const budget = entry?.umsatzBudget ?? null;
  const vj     = entry?.umsatzVorjahr ?? null;
  const abwB   = entry?.abwBudgetPct  ?? null;
  const abwV   = entry?.abwVorjahrPct ?? null;
  const abwBchf = ist != null && budget != null ? ist - budget : null;
  const abwVchf = ist != null && vj     != null ? ist - vj     : null;

  const pctStyle = (v: number | null) =>
    v == null ? '' : v >= 0 ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold';
  const fmtDelta = (v: number | null) =>
    v == null ? null : `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`;
  const fmtDeltaCHF = (v: number | null) =>
    v == null ? null : `${v >= 0 ? '+' : ''}${fmtCHF(Math.abs(v))}`;

  return (
    <div className="bg-card border border-border shadow-lg rounded-lg px-3 py-2.5 text-xs space-y-1.5 min-w-[210px]">
      <p className="font-bold text-foreground mb-1.5 border-b border-border pb-1">{label}</p>

      {ist != null && (
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: C_ACTUAL }} />
            <span className="text-muted-foreground">Umsatz Ist</span>
          </span>
          <span className="font-semibold">{fmtCHF(ist)}</span>
        </div>
      )}

      {budget != null && (
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: C_BUDGET }} />
            <span className="text-muted-foreground">Budget</span>
          </span>
          <span className="font-semibold">{fmtCHF(budget)}</span>
        </div>
      )}
      {abwB != null && (
        <div className="flex items-center justify-between gap-4 pl-4">
          <span className="text-muted-foreground/70">Abw. Budget</span>
          <span className="flex items-center gap-1.5">
            {abwBchf != null && <span className="text-muted-foreground">{fmtDeltaCHF(abwBchf)}</span>}
            <span className={pctStyle(abwB)}>{fmtDelta(abwB)}</span>
          </span>
        </div>
      )}

      {vj != null && (
        <div className="flex items-center justify-between gap-4 mt-0.5">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: C_PREV }} />
            <span className="text-muted-foreground">Vorjahr</span>
          </span>
          <span className="font-semibold">{fmtCHF(vj)}</span>
        </div>
      )}
      {abwV != null && (
        <div className="flex items-center justify-between gap-4 pl-4">
          <span className="text-muted-foreground/70">Abw. Vorjahr</span>
          <span className="flex items-center gap-1.5">
            {abwVchf != null && <span className="text-muted-foreground">{fmtDeltaCHF(abwVchf)}</span>}
            <span className={pctStyle(abwV)}>{fmtDelta(abwV)}</span>
          </span>
        </div>
      )}
    </div>
  );
};

const RevenueComparisonChart = ({
  data,
  highlightVariance,
  selectedMonths,
  onToggle,
  onSelectAll,
  onSelectNone,
  onSelectData,
}: {
  data: MonthlyKPI[];
  highlightVariance: boolean;
  selectedMonths: Set<number>;
  onToggle: (m: number) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onSelectData: () => void;
}) => {
  const hasData = data.some(d => d.umsatzIst || d.umsatzBudget || d.umsatzVorjahr);
  if (!hasData) return <NoDataOverlay message="Noch keine Umsatzdaten vorhanden." />;

  // ── Kumuliert-Werte für KPI-Box ───────────────────────────────────────────
  const selSet  = selectedMonths.size > 0
    ? selectedMonths
    : new Set(data.filter(d => (d.umsatzIst ?? 0) > 0).map(d => d.month));
  const selData = data.filter(d => selSet.has(d.month));
  const sumIst    = selData.reduce((s, d) => s + (d.umsatzIst    ?? 0), 0);
  const sumBudget = selData.reduce((s, d) => s + (d.umsatzBudget ?? 0), 0);
  const sumVJ     = selData.reduce((s, d) => s + (d.umsatzVorjahr ?? 0), 0);
  const sumAbwB   = sumIst > 0 && sumBudget > 0
    ? parseFloat(((sumIst - sumBudget) / sumBudget * 100).toFixed(1)) : null;
  const sumAbwV   = sumIst > 0 && sumVJ > 0
    ? parseFloat(((sumIst - sumVJ) / sumVJ * 100).toFixed(1)) : null;

  // Nur Monatsdaten – kein Kumuliert-Balken → Y-Achse skaliert auf Monatswerte
  const chartData = data;

  // ── Label renderer ────────────────────────────────────────────────────────
  const renderAbwLabel = (props: Record<string, unknown>) => {
    const { x, y, width, index } = props as { x: number; y: number; width: number; index: number };
    const entry = chartData[index];
    if (!entry?.umsatzIst) return null;

    const abwB = entry.abwBudgetPct;
    const abwV = entry.abwVorjahrPct;
    if (abwB == null && abwV == null) return null;

    const cx = (x as number) + (width as number) / 2;
    const lineH = 12;
    const lines: { text: string; color: string }[] = [];

    if (abwB != null) lines.push({
      text: `B: ${abwB >= 0 ? '+' : ''}${abwB.toFixed(1)}%`,
      color: abwB >= 0 ? '#16a34a' : '#dc2626',
    });
    if (abwV != null) lines.push({
      text: `VJ: ${abwV >= 0 ? '+' : ''}${abwV.toFixed(1)}%`,
      color: abwV >= 0 ? '#16a34a' : '#dc2626',
    });

    const totalH = lines.length * lineH;
    const baseY = Math.min((y as number) - totalH - 4, 8);

    return (
      <g>
        {lines.map((l, i) => (
          <text key={i} x={cx} y={baseY + i * lineH} textAnchor="middle" fontSize={9} fontWeight="700" fill={l.color}>
            {l.text}
          </text>
        ))}
      </g>
    );
  };

  return (
    <div>
      {/* KPI-Box oben rechts – klicken öffnet/schliesst Monatsauswahl */}
      {sumIst > 0 && (
        <div className="flex justify-end mb-2">
          <div className="rounded-lg border bg-muted/40 border-border px-3 py-2 text-right min-w-[160px]">
            <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Umsatz kumuliert</p>
            <p className="text-sm font-bold text-foreground mt-0.5">{fmtCHF(sumIst)}</p>
            <div className="mt-1.5 pt-1.5 border-t border-border/60 space-y-0.5">
              {sumAbwB != null && (
                <p className={cn('text-[11px] font-semibold', sumAbwB >= 0 ? 'text-green-600' : 'text-red-600')}>
                  B: {sumAbwB >= 0 ? '+' : ''}{sumAbwB.toFixed(1)} %
                </p>
              )}
              {sumAbwV != null && (
                <p className={cn('text-[11px] font-semibold', sumAbwV >= 0 ? 'text-green-600' : 'text-red-600')}>
                  VJ: {sumAbwV >= 0 ? '+' : ''}{sumAbwV.toFixed(1)} %
                </p>
              )}
            </div>
            <p className="text-[9px] text-muted-foreground/50 mt-1.5">
              {selData.length} Monat{selData.length !== 1 ? 'e' : ''} ausgewählt
            </p>
          </div>
        </div>
      )}

      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={chartData} barGap={2} barCategoryGap="26%" margin={{ top: 36, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
          <XAxis
            dataKey="label"
            tick={(tickProps: any) => {
              const { x, y, payload } = tickProps;
              const entry  = data.find(d => d.label === payload.value);
              const isSel  = entry ? selectedMonths.has(entry.month) : false;
              const hasPt  = entry ? (entry.umsatzIst ?? 0) > 0 : false;
              return (
                <g
                  transform={`translate(${x},${y})`}
                  style={{ cursor: entry ? 'pointer' : 'default' }}
                  onClick={() => entry && onToggle(entry.month)}
                >
                  <text
                    y={4} textAnchor="middle" dominantBaseline="hanging"
                    fontSize={AXIS_STYLE.fontSize}
                    fontWeight={isSel ? '700' : '400'}
                    fill={isSel ? '#4f46e5' : AXIS_STYLE.fill}
                  >
                    {payload.value}
                  </text>
                  <circle cx={0} cy={19} r={3}
                    fill={!hasPt ? 'rgba(0,0,0,0.1)' : isSel ? '#4f46e5' : 'rgba(0,0,0,0.2)'}
                  />
                </g>
              );
            }}
            axisLine={false} tickLine={false} height={28}
          />
          <YAxis
            tick={AXIS_STYLE} axisLine={false} tickLine={false} width={68}
            tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
          />
          <ReTooltip
            content={<RevenueComparisonTooltip allData={chartData} />}
            cursor={{ fill: 'hsl(var(--muted)/0.4)' }}
          />
          <Legend
            iconType="square" iconSize={10} wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
            formatter={v => <span style={{ color: 'hsl(var(--muted-foreground))' }}>{v}</span>}
          />
          <Bar dataKey="umsatzIst"     name="Umsatz Ist (Netto)" fill={C_ACTUAL} radius={[3,3,0,0]} label={renderAbwLabel as any} />
          <Bar dataKey="umsatzBudget"  name="Budget"              fill={C_BUDGET} radius={[3,3,0,0]} />
          <Bar dataKey="umsatzVorjahr" name="Vorjahr"             fill={C_PREV}   radius={[3,3,0,0]} />
        </BarChart>
      </ResponsiveContainer>

      {/* Monatsauswahl – permanent eingeblendet */}
      <div className="mt-3">
        <MonthSelectorPanel
          kpis={data}
          selected={selectedMonths}
          onToggle={onToggle}
          onSelectAll={onSelectAll}
          onSelectNone={onSelectNone}
          onSelectData={onSelectData}
        />
      </div>
    </div>
  );
};

// ─── Globale Konstanten für Warenaufwand-Ziel ─────────────────────────────────

const WAREN_THRESHOLD = 30;

// ─── Insight-Texte (automatische Bewertung) ───────────────────────────────────

function buildPKInsight(data: MonthlyKPI[], threshold: number): string {
  const withData = data.filter(d => d.personalaufwandPLPct != null);
  if (!withData.length) return '';
  const over  = withData.filter(d => d.personalaufwandPLPct! > threshold);
  const under = withData.filter(d => d.personalaufwandPLPct! <= threshold);
  const parts: string[] = [];
  if (over.length > 0) {
    parts.push(`${over.length} ${over.length === 1 ? 'Monat' : 'Monate'} über Ziel (${threshold} %): ${over.map(d => d.label).join(', ')}.`);
  } else {
    parts.push(`Alle ${withData.length} Monate mit Daten liegen unter dem Zielwert.`);
  }
  if (under.length > 0) {
    const best = under.reduce((a, b) => a.personalaufwandPLPct! < b.personalaufwandPLPct! ? a : b);
    parts.push(`Bester Monat: ${best.label} mit ${best.personalaufwandPLPct!.toFixed(1)} %.`);
  }
  return parts.join(' ');
}

function buildWarenInsight(data: MonthlyKPI[]): string {
  const withData = data.filter(d => d.warenQuoteIst != null);
  if (!withData.length) return '';
  const over  = withData.filter(d => d.warenQuoteIst! > WAREN_THRESHOLD);
  const under = withData.filter(d => d.warenQuoteIst! <= WAREN_THRESHOLD);
  const parts: string[] = [];
  if (over.length > 0) {
    parts.push(`${over.length} ${over.length === 1 ? 'Monat' : 'Monate'} über Ziel (${WAREN_THRESHOLD} %): ${over.map(d => d.label).join(', ')}.`);
  } else {
    parts.push(`Alle ${withData.length} Monate liegen unter dem Ziel.`);
  }
  if (under.length > 0) {
    const best = under.reduce((a, b) => a.warenQuoteIst! < b.warenQuoteIst! ? a : b);
    parts.push(`Bester Monat: ${best.label} mit ${best.warenQuoteIst!.toFixed(1)} %.`);
  }
  return parts.join(' ');
}

// ─── KPI-Strip über Diagrammblock ─────────────────────────────────────────────

const QuoteKpiStrip = ({
  data, quoteFn, stripLabel, threshold,
}: {
  data:       MonthlyKPI[];
  quoteFn:    (d: MonthlyKPI) => number | null;
  stripLabel: string;
  threshold:  number;
}) => {
  const withData = data.filter(d => quoteFn(d) != null);
  if (!withData.length) return null;
  const vals  = withData.map(d => ({ label: d.label, val: quoteFn(d)! }));
  const avg   = vals.reduce((s, d) => s + d.val, 0) / vals.length;
  const best  = vals.reduce((a, b) => a.val < b.val ? a : b);
  const worst = vals.reduce((a, b) => a.val > b.val ? a : b);
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
      <div className="rounded-xl border border-border bg-card px-4 py-3">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">{stripLabel} Ø</p>
        <p className="text-2xl font-bold">{avg.toFixed(1)} %</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">Durchschnitt</p>
      </div>
      <div className="rounded-xl border border-green-200 bg-green-50 dark:bg-green-950/20 px-4 py-3">
        <p className="text-[10px] font-semibold text-green-700 uppercase tracking-wide mb-1">Bester Monat</p>
        <p className="text-2xl font-bold text-green-700">{best.val.toFixed(1)} %</p>
        <p className="text-[10px] text-green-600 mt-0.5">{best.label}</p>
      </div>
      <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-950/20 px-4 py-3">
        <p className="text-[10px] font-semibold text-red-700 uppercase tracking-wide mb-1">Schlechtester</p>
        <p className="text-2xl font-bold text-red-700">{worst.val.toFixed(1)} %</p>
        <p className="text-[10px] text-red-600 mt-0.5">{worst.label}</p>
      </div>
      <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Ziel</p>
        <p className="text-2xl font-bold text-muted-foreground">≤ {threshold} %</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">Obergrenze</p>
      </div>
    </div>
  );
};

const InsightBanner = ({ text }: { text: string }) => {
  if (!text) return null;
  return (
    <p className="text-[11px] text-muted-foreground italic mt-3 px-1 flex items-start gap-1">
      <span className="shrink-0 mt-px">→</span>
      <span>{text}</span>
    </p>
  );
};

// ─── Chart 2: PK-Quote pro Monat (Management-Design) ─────────────────────────

const PKQuoteTooltip = ({
  active, payload, label, threshold, allData,
}: {
  active?: boolean;
  payload?: { name: string; value: number }[];
  label?: string;
  threshold: number;
  allData: MonthlyKPI[];
}) => {
  if (!active || !payload?.length) return null;
  const entry = allData.find(d => d.label === label);
  const quote = entry?.pkQuoteIst ?? null;
  return (
    <div className="bg-card border border-border shadow-lg rounded-xl px-3 py-2.5 text-xs min-w-[190px]">
      <p className="font-bold text-foreground mb-2 border-b border-border pb-1.5">{label}</p>
      <div className="space-y-1.5">
        <div className="flex justify-between gap-6">
          <span className="text-muted-foreground">Umsatz Ist</span>
          <span className="font-semibold">{fmtCHF(entry?.umsatzIst)}</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-muted-foreground">PK Ist</span>
          <span className="font-semibold">{fmtCHF(entry?.pkIst)}</span>
        </div>
        <div className="flex justify-between gap-6 pt-1 border-t border-border">
          <span className="font-medium">PK-Quote</span>
          <span className="font-bold text-[13px]" style={{ color: pkBarColor(quote, threshold) }}>
            {quote != null ? `${quote.toFixed(1)} %` : '–'}
          </span>
        </div>
        <div className="flex justify-between gap-6 text-muted-foreground/60">
          <span>Ziel</span>
          <span>≤ {threshold} %</span>
        </div>
      </div>
    </div>
  );
};

const PKQuoteChart = ({ data, threshold }: { data: MonthlyKPI[]; threshold: number }) => {
  const chartData = data.filter(d => d.pkQuoteIst != null);
  if (!chartData.length) return <NoDataOverlay message="Keine PK-Quote berechenbar – bitte Umsatz und Personalkosten erfassen." />;

  const renderBarLabel = (props: Record<string, unknown>) => {
    const { x, y, width, height, index } = props as { x: number; y: number; width: number; height: number; index: number };
    const entry = chartData[index];
    if (!entry || entry.pkQuoteIst == null) return null;
    const pct = entry.pkQuoteIst;
    const cx  = (x as number) + (width as number) / 2;
    const h   = height as number;
    const col = pkBarColor(pct, threshold);
    if (h > 26) {
      return (
        <text x={cx} y={(y as number) + h / 2 + 5} textAnchor="middle" fontSize={12} fontWeight="700" fill="white">
          {pct.toFixed(1)}%
        </text>
      );
    }
    return (
      <text x={cx} y={(y as number) - 5} textAnchor="middle" fontSize={11} fontWeight="700" fill={col}>
        {pct.toFixed(1)}%
      </text>
    );
  };

  const yMax = Math.max(...chartData.map(d => d.pkQuoteIst ?? 0), threshold + 8);

  return (
    <ResponsiveContainer width="100%" height={310}>
      <BarChart data={chartData} barCategoryGap="42%" margin={{ top: 28, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis dataKey="label" tick={{ ...AXIS_STYLE, fontSize: 12 }} axisLine={false} tickLine={false} />
        <YAxis
          tick={AXIS_STYLE} axisLine={false} tickLine={false} width={42}
          tickFormatter={v => `${v}%`}
          domain={[0, Math.ceil(yMax / 5) * 5]}
        />
        <ReTooltip
          content={(p: any) => <PKQuoteTooltip {...p} threshold={threshold} allData={chartData} />}
          cursor={{ fill: 'hsl(var(--muted)/0.25)' }}
        />
        <ReferenceLine
          y={threshold}
          stroke={C_RED}
          strokeDasharray="6 3"
          strokeWidth={1.5}
          label={{ value: `Ziel ${threshold}%`, position: 'insideTopRight', fontSize: 10, fill: C_RED, dy: -6 }}
        />
        <Bar dataKey="pkQuoteIst" radius={[5,5,0,0]} label={renderBarLabel as any} isAnimationActive={false}>
          {chartData.map((entry, i) => (
            <Cell key={i} fill={pkBarColor(entry.pkQuoteIst, threshold)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
};

// ─── Chart 3: Umsatz vs. Personalkosten (Management-Design) ──────────────────

const PKCombinedTooltip = ({
  active, payload, label, threshold, allData,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
  threshold: number;
  allData: MonthlyKPI[];
}) => {
  if (!active || !payload?.length) return null;
  const entry = allData.find(d => d.label === label);
  const quote = entry?.personalaufwandPLPct ?? null;
  return (
    <div className="bg-card border border-border shadow-lg rounded-xl px-3 py-2.5 text-xs min-w-[230px]">
      <p className="font-bold text-foreground mb-2 border-b border-border pb-1.5">{label}</p>
      <div className="space-y-1.5">
        <div className="flex justify-between gap-6">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: C_ACTUAL }} />
            <span className="text-muted-foreground">Umsatz Ist</span>
          </span>
          <span className="font-semibold">{fmtCHF(entry?.umsatzIst)}</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: C_PK }} />
            <span className="text-muted-foreground">Personalaufwand (ER)</span>
          </span>
          <span className="font-semibold">{fmtCHF(entry?.personalaufwandPL)}</span>
        </div>
        <div className="flex justify-between gap-6 pt-1 border-t border-border">
          <span className="font-medium">PK-Quote (ER)</span>
          <span className="font-bold text-[13px]" style={{ color: pkBarColor(quote, threshold) }}>
            {quote != null ? `${quote.toFixed(1)} %` : '–'}
          </span>
        </div>
        <div className="flex justify-between gap-6 text-muted-foreground/60">
          <span>Ziel</span>
          <span>≤ {threshold} %</span>
        </div>
      </div>
    </div>
  );
};

const RevenuePKChart = ({ data, threshold }: { data: MonthlyKPI[]; threshold: number }) => {
  const chartData = data.filter(d => (d.umsatzIst ?? 0) > 0 || (d.pkIst ?? 0) > 0);
  if (!chartData.length) return <NoDataOverlay message="Noch keine Daten für dieses Diagramm vorhanden." />;

  const renderPKLabel = (props: Record<string, unknown>) => {
    const { x, y, width, index } = props as { x: number; y: number; width: number; index: number };
    const entry = chartData[index];
    const quote = entry?.pkQuoteIst;
    if (!entry?.pkIst || quote == null) return null;
    return (
      <text x={(x as number) + (width as number) / 2} y={(y as number) - 5}
        textAnchor="middle" fontSize={12} fontWeight="700"
        fill={pkBarColor(quote, threshold)}>
        {quote.toFixed(1)}%
      </text>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={310}>
      <BarChart data={chartData} barGap={4} barCategoryGap="34%" margin={{ top: 28, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis dataKey="label" tick={{ ...AXIS_STYLE, fontSize: 12 }} axisLine={false} tickLine={false} />
        <YAxis
          tick={AXIS_STYLE} axisLine={false} tickLine={false} width={52}
          tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
        />
        <ReTooltip
          content={(p: any) => <PKCombinedTooltip {...p} threshold={threshold} allData={chartData} />}
          cursor={{ fill: 'hsl(var(--muted)/0.25)' }}
        />
        <Bar dataKey="umsatzIst" name="Umsatz Ist" fill={C_ACTUAL} radius={[5,5,0,0]} isAnimationActive={false} />
        <Bar dataKey="pkIst"     name="PK Ist"     fill={C_PK}     radius={[5,5,0,0]} isAnimationActive={false}
          label={renderPKLabel as any} />
      </BarChart>
    </ResponsiveContainer>
  );
};

// ─── Chart 4: Warenaufwandquote (Management-Design) ──────────────────────────

const WarenQuoteTooltip = ({
  active, payload, label, allData,
}: {
  active?: boolean;
  payload?: { name: string; value: number }[];
  label?: string;
  allData: MonthlyKPI[];
}) => {
  if (!active || !payload?.length) return null;
  const entry = allData.find(d => d.label === label);
  const quote = entry?.warenQuoteIst ?? null;
  return (
    <div className="bg-card border border-border shadow-lg rounded-xl px-3 py-2.5 text-xs min-w-[190px]">
      <p className="font-bold text-foreground mb-2 border-b border-border pb-1.5">{label}</p>
      <div className="space-y-1.5">
        <div className="flex justify-between gap-6">
          <span className="text-muted-foreground">Umsatz Ist</span>
          <span className="font-semibold">{fmtCHF(entry?.umsatzIst)}</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-muted-foreground">Warenaufwand</span>
          <span className="font-semibold">{fmtCHF(entry?.warenIst)}</span>
        </div>
        <div className="flex justify-between gap-6 pt-1 border-t border-border">
          <span className="font-medium">Warenquote</span>
          <span className="font-bold text-[13px]" style={{ color: warenBarColor(quote) }}>
            {quote != null ? `${quote.toFixed(1)} %` : '–'}
          </span>
        </div>
        <div className="flex justify-between gap-6 text-muted-foreground/60">
          <span>Ziel</span>
          <span>≤ {WAREN_THRESHOLD} %</span>
        </div>
      </div>
    </div>
  );
};

const WarenQuoteChart = ({ data }: { data: MonthlyKPI[] }) => {
  const chartData = data.filter(d => d.warenQuoteIst != null);
  if (!chartData.length) return <NoDataOverlay message="Kein Warenaufwand erfasst. Bitte Sage-CSV mit 4xxx-Konten importieren." />;

  const renderBarLabel = (props: Record<string, unknown>) => {
    const { x, y, width, height, index } = props as { x: number; y: number; width: number; height: number; index: number };
    const entry = chartData[index];
    if (!entry || entry.warenQuoteIst == null) return null;
    const pct = entry.warenQuoteIst;
    const cx  = (x as number) + (width as number) / 2;
    const h   = height as number;
    const col = warenBarColor(pct);
    if (h > 26) {
      return (
        <text x={cx} y={(y as number) + h / 2 + 5} textAnchor="middle" fontSize={12} fontWeight="700" fill="white">
          {pct.toFixed(1)}%
        </text>
      );
    }
    return (
      <text x={cx} y={(y as number) - 5} textAnchor="middle" fontSize={11} fontWeight="700" fill={col}>
        {pct.toFixed(1)}%
      </text>
    );
  };

  const yMax = Math.max(...chartData.map(d => d.warenQuoteIst ?? 0), WAREN_THRESHOLD + 8);

  return (
    <ResponsiveContainer width="100%" height={310}>
      <BarChart data={chartData} barCategoryGap="42%" margin={{ top: 28, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis dataKey="label" tick={{ ...AXIS_STYLE, fontSize: 12 }} axisLine={false} tickLine={false} />
        <YAxis
          tick={AXIS_STYLE} axisLine={false} tickLine={false} width={42}
          tickFormatter={v => `${v}%`}
          domain={[0, Math.ceil(yMax / 5) * 5]}
        />
        <ReTooltip
          content={(p: any) => <WarenQuoteTooltip {...p} allData={chartData} />}
          cursor={{ fill: 'hsl(var(--muted)/0.25)' }}
        />
        <ReferenceLine
          y={WAREN_THRESHOLD}
          stroke={C_WAREN}
          strokeDasharray="6 3"
          strokeWidth={1.5}
          label={{ value: `Ziel ${WAREN_THRESHOLD}%`, position: 'insideTopRight', fontSize: 10, fill: C_WAREN, dy: -6 }}
        />
        <Bar dataKey="warenQuoteIst" radius={[5,5,0,0]} label={renderBarLabel as any} isAnimationActive={false}>
          {chartData.map((entry, i) => (
            <Cell key={i} fill={warenBarColor(entry.warenQuoteIst)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
};

// ─── Chart 5: Umsatz vs. Warenaufwand (Management-Design) ────────────────────

const WarenCombinedTooltip = ({
  active, payload, label, allData,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
  allData: MonthlyKPI[];
}) => {
  if (!active || !payload?.length) return null;
  const entry = allData.find(d => d.label === label);
  const quote = entry?.warenQuoteIst ?? null;
  return (
    <div className="bg-card border border-border shadow-lg rounded-xl px-3 py-2.5 text-xs min-w-[210px]">
      <p className="font-bold text-foreground mb-2 border-b border-border pb-1.5">{label}</p>
      <div className="space-y-1.5">
        <div className="flex justify-between gap-6">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: C_ACTUAL }} />
            <span className="text-muted-foreground">Umsatz Ist</span>
          </span>
          <span className="font-semibold">{fmtCHF(entry?.umsatzIst)}</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: C_WAREN }} />
            <span className="text-muted-foreground">Warenaufwand</span>
          </span>
          <span className="font-semibold">{fmtCHF(entry?.warenIst)}</span>
        </div>
        <div className="flex justify-between gap-6 pt-1 border-t border-border">
          <span className="font-medium">Warenquote</span>
          <span className="font-bold text-[13px]" style={{ color: warenBarColor(quote) }}>
            {quote != null ? `${quote.toFixed(1)} %` : '–'}
          </span>
        </div>
        <div className="flex justify-between gap-6 text-muted-foreground/60">
          <span>Ziel</span>
          <span>≤ {WAREN_THRESHOLD} %</span>
        </div>
      </div>
    </div>
  );
};

const RevenueWarenChart = ({ data }: { data: MonthlyKPI[] }) => {
  const chartData = data.filter(d => (d.umsatzIst ?? 0) > 0 || (d.warenIst ?? 0) > 0);
  if (!chartData.length) return <NoDataOverlay message="Noch keine Daten vorhanden." />;

  const renderWarenLabel = (props: Record<string, unknown>) => {
    const { x, y, width, index } = props as { x: number; y: number; width: number; index: number };
    const entry = chartData[index];
    const quote = entry?.warenQuoteIst;
    if (!entry?.warenIst || quote == null) return null;
    return (
      <text x={(x as number) + (width as number) / 2} y={(y as number) - 5}
        textAnchor="middle" fontSize={12} fontWeight="700"
        fill={warenBarColor(quote)}>
        {quote.toFixed(1)}%
      </text>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={310}>
      <BarChart data={chartData} barGap={4} barCategoryGap="34%" margin={{ top: 28, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis dataKey="label" tick={{ ...AXIS_STYLE, fontSize: 12 }} axisLine={false} tickLine={false} />
        <YAxis
          tick={AXIS_STYLE} axisLine={false} tickLine={false} width={52}
          tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
        />
        <ReTooltip
          content={(p: any) => <WarenCombinedTooltip {...p} allData={chartData} />}
          cursor={{ fill: 'hsl(var(--muted)/0.25)' }}
        />
        <Bar dataKey="umsatzIst" name="Umsatz Ist"   fill={C_ACTUAL} radius={[5,5,0,0]} isAnimationActive={false} />
        <Bar dataKey="warenIst"  name="Warenaufwand" fill={C_WAREN}  radius={[5,5,0,0]} isAnimationActive={false}
          label={renderWarenLabel as any} />
      </BarChart>
    </ResponsiveContainer>
  );
};

// ─── Chart 4+5: Warenaufwand Kombinierte Auswertung (gross, full-width) ───────

interface WarenKombinierteProps {
  data:           MonthlyKPI[];
  year:           number;
  selectedMonths: Set<number>;
  onToggle:       (m: number) => void;
  onSelectAll:    () => void;
  onSelectNone:   () => void;
  onSelectData:   () => void;
}

const renderRevenueLabel = (props: Record<string, unknown>) => {
  const { x, y, width, value } = props as {
    x: number; y: number; width: number; height: number; value: number;
  };
  if (!value || value <= 0) return null;
  const label = `CHF ${Math.round(value).toLocaleString('de-CH')}`;
  return (
    <text
      x={(x as number) + (width as number) / 2}
      y={(y as number) - 6}
      textAnchor="middle"
      dominantBaseline="auto"
      fontSize={11}
      fontWeight="700"
      fill="hsl(var(--foreground))"
    >
      {label}
    </text>
  );
};

const WarenKombinierteChart = ({
  data, year, selectedMonths, onToggle, onSelectAll, onSelectNone, onSelectData,
}: WarenKombinierteProps) => {
  const chartData = data.filter(d => (d.umsatzIst ?? 0) > 0);

  const withQuote      = data.filter(d => d.warenQuoteIst != null);
  const sumWaren       = withQuote.reduce((s, d) => s + (d.warenIst ?? 0), 0);
  const sumUmsatz      = withQuote.reduce((s, d) => s + (d.umsatzIst ?? 0), 0);
  const kumuliertQuote = sumUmsatz > 0 ? (sumWaren / sumUmsatz) * 100 : null;
  const uberZiel       = withQuote.filter(d => d.warenQuoteIst! > WAREN_THRESHOLD).length;
  const insight        = buildWarenInsight(data);

  const renderQuoteLabel = (props: Record<string, unknown>) => {
    const { x, y, width, index } = props as { x: number; y: number; width: number; index: number };
    const entry = chartData[index];
    const quote = entry?.warenQuoteIst;
    if (!entry?.warenIst || quote == null) return null;
    return (
      <text
        x={(x as number) + (width as number) / 2}
        y={(y as number) - 7}
        textAnchor="middle"
        fontSize={13}
        fontWeight="700"
        fill={warenBarColor(quote)}
      >
        {quote.toFixed(1)}%
      </text>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-muted-foreground" />
              Warenaufwand-Analyse {year}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] mt-2">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: C_ACTUAL }} />
                Umsatz Ist
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: C_WAREN }} />
                Warenaufwand — Quote % auf Balken
              </span>
              <span className="text-muted-foreground/50">Ziel ≤ {WAREN_THRESHOLD} %</span>
              <span className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 text-green-600 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" /> ≤ 28 %
                </span>
                <span className="inline-flex items-center gap-1 text-amber-600 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" /> 28–33 %
                </span>
                <span className="inline-flex items-center gap-1 text-red-600 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" /> &gt; 33 %
                </span>
              </span>
            </div>
          </div>

          {/* KPI-Zusammenfassung oben rechts */}
          {sumWaren > 0 && (
            <div className="shrink-0 rounded-lg bg-muted/40 border border-border px-3 py-2 text-right min-w-[140px]">
              <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Warenaufwand kumuliert</p>
              <p className="text-sm font-bold text-foreground mt-0.5">{fmtCHF(sumWaren)}</p>
              <div className="mt-1.5 pt-1.5 border-t border-border/60">
                <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Warenquote</p>
                <p className="text-base font-bold mt-0.5" style={{ color: warenBarColor(kumuliertQuote) }}>
                  {kumuliertQuote != null ? `${kumuliertQuote.toFixed(1)} %` : '–'}
                </p>
                <p className="text-[9px] text-muted-foreground/60">Ziel ≤ {WAREN_THRESHOLD} %</p>
              </div>
              <p className={cn('text-[10px] font-semibold mt-1.5', uberZiel > 0 ? 'text-red-600' : 'text-green-600')}>
                {uberZiel > 0 ? `${uberZiel} Monate über Ziel` : '✓ 0 Monate über Ziel'}
              </p>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="pt-2 px-3">
        {chartData.length === 0 ? (
          <NoDataOverlay message="Kein Warenaufwand erfasst. Bitte Sage-CSV mit 4xxx-Konten importieren." />
        ) : (
          <ResponsiveContainer width="100%" height={400}>
            <ComposedChart
              data={chartData.map(d => ({ ...d, warenTargetPct: WAREN_THRESHOLD }))}
              barGap={5} barCategoryGap="28%"
              margin={{ top: 36, right: 48, bottom: 0, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis
                dataKey="label"
                tick={(tickProps: any) => {
                  const { x, y, payload } = tickProps;
                  const entry = chartData.find(d => d.label === payload.value);
                  const isSel = entry ? selectedMonths.has(entry.month) : false;
                  return (
                    <g
                      transform={`translate(${x},${y})`}
                      style={{ cursor: 'pointer' }}
                      onClick={() => entry && onToggle(entry.month)}
                    >
                      <text y={4} textAnchor="middle" dominantBaseline="hanging"
                        fontSize={12} fontWeight={isSel ? '700' : '400'}
                        fill={isSel ? '#4f46e5' : AXIS_STYLE.fill}
                      >
                        {payload.value}
                      </text>
                      <circle cx={0} cy={20} r={3}
                        fill={isSel ? '#4f46e5' : 'rgba(0,0,0,0.18)'}
                      />
                    </g>
                  );
                }}
                axisLine={false} tickLine={false} height={28}
              />
              <YAxis
                yAxisId="left" orientation="left"
                tick={AXIS_STYLE} axisLine={false} tickLine={false} width={56}
                tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
              />
              <YAxis
                yAxisId="right" orientation="right"
                tick={{ ...AXIS_STYLE, fontSize: 10 }} axisLine={false} tickLine={false} width={34}
                tickFormatter={v => `${v}%`}
                domain={[0, 100]} tickCount={6}
              />
              <ReTooltip
                content={(p: any) => <WarenCombinedTooltip {...p} allData={chartData} />}
                cursor={{ fill: 'hsl(var(--muted)/0.25)' }}
              />
              <Bar yAxisId="left" dataKey="umsatzIst" name="Umsatz Ist" fill={C_ACTUAL} radius={[5,5,0,0]} isAnimationActive={false}
                label={renderRevenueLabel as any} />
              <Bar yAxisId="left" dataKey="warenIst" name="Warenaufwand" radius={[5,5,0,0]} isAnimationActive={false}
                label={renderQuoteLabel as any}>
                {chartData.map((entry, i) => (
                  <Cell key={i} fill={entry.warenQuoteIst == null ? 'hsl(var(--muted))' : warenBarColor(entry.warenQuoteIst)} />
                ))}
              </Bar>
              <Line
                yAxisId="right" dataKey="warenTargetPct" name={`Ziel ${WAREN_THRESHOLD} %`}
                stroke={C_WAREN} strokeDasharray="6 3" strokeWidth={1.5}
                dot={false} activeDot={false} legendType="none"
                label={{ value: `Ziel ${WAREN_THRESHOLD} %`, position: 'right', fontSize: 10, fill: C_WAREN, dx: 4 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}

        {insight && <InsightBanner text={insight} />}
      </CardContent>
    </Card>
  );
};

// ─── Chart PK: Personalkosten Kombinierte Auswertung (gross, full-width) ──────

interface PKKombinierteProps {
  data:      MonthlyKPI[];
  year:      number;
  threshold: number;
}

const PKKombinierteChart = ({ data, year, threshold }: PKKombinierteProps) => {

  const chartData           = data.filter(d => (d.umsatzIst ?? 0) > 0);
  const chartDataWithTarget = chartData.map(d => ({ ...d, pkTargetPct: threshold }));

  // KPI-Berechnung auf Basis Erfolgsrechnung (authoritative)
  const withQuote      = data.filter(d => d.personalaufwandPLPct != null);
  const sumPK          = withQuote.reduce((s, d) => s + (d.personalaufwandPL ?? 0), 0);
  const sumUmsatz      = withQuote.reduce((s, d) => s + (d.umsatzIst ?? 0), 0);
  const kumuliertQuote = sumUmsatz > 0 ? (sumPK / sumUmsatz) * 100 : null;
  const uberZiel       = withQuote.filter(d => d.personalaufwandPLPct! > threshold).length;
  const insight        = buildPKInsight(data, threshold);

  const renderPKLabel = (props: Record<string, unknown>) => {
    const { x, y, width, height, index } = props as {
      x: number; y: number; width: number; height: number; index: number;
    };
    const entry = chartDataWithTarget[index];
    const quote = entry?.personalaufwandPLPct;
    if (!entry?.personalaufwandPL || quote == null) return null;

    const cx = (x as number) + (width as number) / 2;
    const barH = height as number;
    const cy = (y as number) + barH / 2;

    // Hoher Balken → quer (rotiert 90°) im Inneren
    if (barH >= 42) {
      return (
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
          fontSize={12} fontWeight="700" fill="#ffffff"
          transform={`rotate(-90, ${cx}, ${cy})`}
        >
          {quote.toFixed(1)}%
        </text>
      );
    }

    // Mittlerer Balken → horizontal im Inneren
    if (barH >= 20) {
      return (
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
          fontSize={11} fontWeight="700" fill="#ffffff"
        >
          {quote.toFixed(1)}%
        </text>
      );
    }

    // Flacher Balken → oberhalb
    return (
      <text x={cx} y={(y as number) - 5} textAnchor="middle"
        fontSize={10} fontWeight="700" fill={pkBarColor(quote, threshold)}
      >
        {quote.toFixed(1)}%
      </text>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-muted-foreground" />
              Personalkosten-Analyse {year}
            </CardTitle>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5">
              Personalaufwand aus Erfolgsrechnung (5xxx-Konten). PK-Quote = Personalaufwand / Umsatz Ist Netto.
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px] mt-2">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: C_ACTUAL }} />
                Umsatz Ist
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: C_PK }} />
                Personalaufwand (Erfolgsrechnung) — Quote % auf Balken
              </span>
              <span className="text-muted-foreground/50">Ziel ≤ {threshold} %</span>
              <span className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 text-green-600 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" /> unter Ziel
                </span>
                <span className="inline-flex items-center gap-1 text-amber-600 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" /> nahe Ziel
                </span>
                <span className="inline-flex items-center gap-1 text-red-600 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" /> über Ziel
                </span>
              </span>
            </div>
          </div>

          {/* KPI-Box oben rechts */}
          {sumPK > 0 && (
            <div className="shrink-0 rounded-lg bg-muted/40 border border-border px-3 py-2 text-right min-w-[150px]">
              <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Personalaufwand kum.</p>
              <p className="text-sm font-bold text-foreground mt-0.5">{fmtCHF(sumPK)}</p>
              <div className="mt-1.5 pt-1.5 border-t border-border/60">
                <p className="text-[9px] uppercase tracking-wide text-muted-foreground">PK-Quote</p>
                <p className="text-base font-bold mt-0.5" style={{ color: pkBarColor(kumuliertQuote, threshold) }}>
                  {kumuliertQuote != null ? `${kumuliertQuote.toFixed(1)} %` : '–'}
                </p>
                <p className="text-[9px] text-muted-foreground/60">Ziel ≤ {threshold} %</p>
              </div>
              <p className={cn('text-[10px] font-semibold mt-1.5', uberZiel > 0 ? 'text-red-600' : 'text-green-600')}>
                {uberZiel > 0 ? `${uberZiel} Monate über Ziel` : '✓ 0 Monate über Ziel'}
              </p>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="pt-2 px-3">
        {chartData.length === 0 ? (
          <NoDataOverlay message="Keine PK-Quote berechenbar – bitte Umsatz und Personalkosten erfassen." />
        ) : (
          <ResponsiveContainer width="100%" height={400}>
            <ComposedChart
              data={chartDataWithTarget}
              barGap={5} barCategoryGap="28%"
              margin={{ top: 36, right: 48, bottom: 0, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="label" tick={{ ...AXIS_STYLE, fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis
                yAxisId="left" orientation="left"
                tick={AXIS_STYLE} axisLine={false} tickLine={false} width={56}
                tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
              />
              <YAxis
                yAxisId="right" orientation="right"
                tick={{ ...AXIS_STYLE, fontSize: 10 }} axisLine={false} tickLine={false} width={34}
                tickFormatter={v => `${v}%`}
                domain={[0, 100]} tickCount={6}
              />
              <ReTooltip
                content={(p: any) => <PKCombinedTooltip {...p} threshold={threshold} allData={chartDataWithTarget} />}
                cursor={{ fill: 'hsl(var(--muted)/0.25)' }}
              />
              <Bar yAxisId="left" dataKey="umsatzIst" name="Umsatz Ist" fill={C_ACTUAL} radius={[5,5,0,0]} isAnimationActive={false}
                label={renderRevenueLabel as any} />
              <Bar yAxisId="left" dataKey="personalaufwandPL" name="Personalaufwand (ER)" radius={[5,5,0,0]} isAnimationActive={false}
                label={renderPKLabel as any}>
                {chartDataWithTarget.map((entry, i) => (
                  <Cell key={i} fill={entry.personalaufwandPLPct == null ? 'hsl(var(--muted))' : pkBarColor(entry.personalaufwandPLPct, threshold)} />
                ))}
              </Bar>
              <Line
                yAxisId="right" dataKey="pkTargetPct" name={`Ziel ${threshold} %`}
                stroke={C_RED} strokeDasharray="6 3" strokeWidth={1.5}
                dot={false} activeDot={false} legendType="none"
                label={{ value: `Ziel ${threshold} %`, position: 'right', fontSize: 10, fill: C_RED, dx: 4 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
        {insight && <InsightBanner text={insight} />}
      </CardContent>
    </Card>
  );
};

// ─── Vollständigkeits-Badge ───────────────────────────────────────────────────

const CompletenessBadge = ({ pct }: { pct: number }) => {
  if (pct === 100) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-green-600">
      <CheckCircle2 className="h-3 w-3" /> Vollständig
    </span>
  );
  if (pct >= 50) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-600">
      <Clock className="h-3 w-3" /> {pct} %
    </span>
  );
  if (pct > 0) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground">
      <AlertCircle className="h-3 w-3" /> {pct} %
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60">
      <Clock className="h-3 w-3" /> Leer
    </span>
  );
};

// ─── Zahlenfeld ───────────────────────────────────────────────────────────────

const NumberField = ({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) => (
  <div>
    <Label className="text-[10px] text-muted-foreground mb-0.5 block">{label}</Label>
    <Input
      type="number"
      min="0"
      step="100"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="–"
      className="h-8 text-sm"
    />
  </div>
);

// ─── Erfassungs-Dialog ────────────────────────────────────────────────────────

interface EntryDialogProps {
  record: MonthlyFinancialRecord | null;
  storeKey: string;
  onClose: () => void;
  onSaved: () => void;
}

const EntryDialog = ({ record, storeKey, onClose, onSaved }: EntryDialogProps) => {
  if (!record) return null;

  const [revenueActual,         setRevenueActual]         = useState(record.revenueActual?.toString() ?? '');
  const [revenueBudget,         setRevenueBudget]         = useState(record.revenueBudget?.toString() ?? '');
  const [revenuePreviousYear,   setRevenuePreviousYear]   = useState(record.revenuePreviousYear?.toString() ?? '');
  const [personnelActual,       setPersonnelActual]       = useState(record.personnelCostActual?.toString() ?? '');
  const [personnelPlanned,      setPersonnelPlanned]      = useState(record.personnelCostPlanned?.toString() ?? '');
  const [personnelPreviousYear, setPersonnelPreviousYear] = useState(record.personnelCostPreviousYear?.toString() ?? '');
  const [note,                  setNote]                  = useState('');
  const [saving,                setSaving]                = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const parse = (v: string) => {
      const n = parseFloat(v.replace(/[^0-9.-]/g, ''));
      return isNaN(n) ? undefined : n;
    };
    saveMonth(
      {
        year:                    record.year,
        month:                   record.month,
        revenueActual:           parse(revenueActual),
        revenueBudget:           parse(revenueBudget),
        revenuePreviousYear:     parse(revenuePreviousYear),
        personnelCostActual:     parse(personnelActual),
        personnelCostPlanned:    parse(personnelPlanned),
        personnelCostPreviousYear: parse(personnelPreviousYear),
      },
      'manual',
      'update',
      { note: note || undefined },
      storeKey,
    );
    setSaving(false);
    toast.success(`${formatMonthLabel(record.year, record.month)} gespeichert`);
    onSaved();
    onClose();
  };

  const isFuture = record.year > currentYear ||
    (record.year === currentYear && record.month > currentMonth);

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Edit3 className="h-4 w-4" />
            {formatMonthLabel(record.year, record.month)}
          </DialogTitle>
          <DialogDescription>
            Manuelle Datenerfassung. Leere Felder werden nicht überschrieben.
          </DialogDescription>
        </DialogHeader>

        {isFuture && (
          <div className="flex items-center gap-2 rounded-md bg-blue-50 dark:bg-blue-950/20 border border-blue-200 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
            <Info className="h-3.5 w-3.5 flex-shrink-0" />
            Zukunftsmonat – hier können Budgetwerte eingetragen werden.
          </div>
        )}

        <div className="space-y-5 py-2">
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">Umsatz (CHF)</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <NumberField label="Tatsächlich" value={revenueActual}       onChange={setRevenueActual} />
              <NumberField label="Budget"      value={revenueBudget}       onChange={setRevenueBudget} />
              <NumberField label="Vorjahr"     value={revenuePreviousYear} onChange={setRevenuePreviousYear} />
            </div>
          </section>

          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">Personalkosten (CHF)</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <NumberField label="Tatsächlich" value={personnelActual}       onChange={setPersonnelActual} />
              <NumberField label="Geplant"     value={personnelPlanned}      onChange={setPersonnelPlanned} />
              <NumberField label="Vorjahr"     value={personnelPreviousYear} onChange={setPersonnelPreviousYear} />
            </div>
          </section>

          <section className="rounded-md border border-dashed border-muted-foreground/30 p-3">
            <div className="flex items-start gap-2">
              <Upload className="h-4 w-4 text-muted-foreground/50 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs font-semibold text-muted-foreground">Ausgabenkategorien</p>
                <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                  Wird aus Buchhaltungsexport (Sage CSV) importiert. Warenaufwand (4xxx) und PK (5xxx) werden automatisch erkannt.
                </p>
                {record.expenseCategories.length > 0 && (
                  <p className="text-[11px] text-green-600 mt-1">
                    {record.expenseCategories.length} Kategorien vorhanden (davon Warenaufwand: {
                      record.expenseCategories.filter(c => {
                        const n = parseInt(c.categoryId);
                        return (!isNaN(n) && n >= 4000 && n <= 4999) || WAREN_HUMAN_IDS.has(c.categoryId);
                      }).length
                    })
                  </p>
                )}
              </div>
            </div>
          </section>

          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">Notiz</Label>
            <Textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="z.B. Hochsaison, Umbau…"
              className="text-sm resize-none min-h-[60px]"
            />
          </div>

          {record.imports.length > 0 && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">
                Importverlauf ({record.imports.length})
              </h3>
              <ul className="space-y-1">
                {record.imports.slice(-5).map(imp => (
                  <li key={imp.importId} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 flex-shrink-0" />
                    <span>{new Date(imp.importedAt).toLocaleString('de-CH')}</span>
                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">
                      {imp.source === 'manual' ? 'Manuell' : imp.source}
                    </Badge>
                    {imp.note && <span className="italic truncate max-w-[120px]">{imp.note}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            <X className="h-3.5 w-3.5 mr-1" /> Abbrechen
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            <Save className="h-3.5 w-3.5 mr-1" />
            {saving ? 'Speichern…' : 'Speichern'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ─── Absenzen-Controlling ─────────────────────────────────────────────────────

const AbsenzMonatsBlock = ({ year }: { year: number }) => {
  const { tenantId, tenantKey } = useTenant();
  const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth() + 1);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [scheduleData, setScheduleData] = useState<Record<string, DaySchedule>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(tenantKey('schedule-employees'));
      if (raw) setEmployees(JSON.parse(raw));
    } catch { setEmployees([]); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => {
    const key = tenantKey(`schedule-v2-${year}-${String(selectedMonth).padStart(2, '0')}`);
    try {
      const raw = localStorage.getItem(key);
      if (raw) setScheduleData(JSON.parse(raw));
      else setScheduleData({});
    } catch { setScheduleData({}); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, year, selectedMonth]);

  const absenceSummary = useMemo(() => {
    if (!employees.length) return null;
    const overrides  = loadAbsenceOverrides();
    const firstDay   = startOfMonth(new Date(year, selectedMonth - 1));
    const lastDay    = endOfMonth(firstDay);
    const days       = eachDayOfInterval({ start: firstDay, end: lastDay });

    const allAbsences = employees.flatMap(emp => {
      return days.flatMap(day => {
        const dateStr = day.toISOString().split('T')[0];
        const dayData = scheduleData[dateStr];
        if (!dayData) return [];
        const raw = computeAbsenceEvents(emp, day, dayData);
        return raw.map(ev => resolveAbsenceEvent(ev, overrides, tenantKey('absenceOverrides')));
      });
    });

    return summarizeAbsences(allAbsences);
  }, [employees, scheduleData, year, selectedMonth]);

  return (
    <Card>
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <UserX className="h-4 w-4 text-muted-foreground" />
          Absenzen-Controlling
        </CardTitle>
        <div className="flex items-center gap-2 mt-1">
          <Select value={String(selectedMonth)} onValueChange={v => setSelectedMonth(Number(v))}>
            <SelectTrigger className="h-7 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(MONTH_NAMES_DE).filter(([k]) => k !== '0').map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[11px] text-muted-foreground">{year}</span>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {!absenceSummary || (absenceSummary.vacationDays === 0 && absenceSummary.sickDays === 0 && absenceSummary.accidentDays === 0) ? (
          <p className="text-xs text-muted-foreground/60 italic py-2">
            Keine Absenzen im Dienstplan erfasst.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { key: 'vacation',  label: 'Ferien',   days: absenceSummary.vacationDays,  cost: absenceSummary.vacationCost,  icon: <Palmtree   className="h-3.5 w-3.5" /> },
              { key: 'sick',      label: 'Krankheit', days: absenceSummary.sickDays,      cost: absenceSummary.sickCost,      icon: <Stethoscope className="h-3.5 w-3.5" /> },
              { key: 'accident',  label: 'Unfall',    days: absenceSummary.accidentDays,  cost: absenceSummary.accidentCost,  icon: <Stethoscope className="h-3.5 w-3.5" /> },
            ].filter(r => r.days > 0).map(r => (
              <div key={r.key} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
                  {r.icon}
                  <span className="text-[10px] uppercase tracking-wide">{r.label}</span>
                </div>
                <p className="text-lg font-bold">{r.days}</p>
                <p className="text-[10px] text-muted-foreground">
                  Tage · {fmtCHF(r.cost)}
                </p>
              </div>
            ))}
            {absenceSummary.totalCost > 0 && (
              <div className="rounded-lg border border-orange-200 bg-orange-50 dark:bg-orange-950/20 px-3 py-2">
                <div className="flex items-center gap-1.5 text-orange-700 mb-0.5">
                  <UserX className="h-3.5 w-3.5" />
                  <span className="text-[10px] uppercase tracking-wide">Kosten total</span>
                </div>
                <p className="text-lg font-bold">{fmtCHF(absenceSummary.totalCost)}</p>
                <p className="text-[10px] text-muted-foreground">inkl. Sozialkosten</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ─── Zusammenfassungs-Karte ───────────────────────────────────────────────────

type SummaryColor = 'blue' | 'green' | 'orange' | 'red' | 'gray' | 'amber';
const COLOR_MAP: Record<SummaryColor, string> = {
  blue:   'border-blue-200 bg-blue-50 dark:bg-blue-950/20',
  green:  'border-green-200 bg-green-50 dark:bg-green-950/20',
  orange: 'border-orange-200 bg-orange-50 dark:bg-orange-950/20',
  red:    'border-red-200 bg-red-50 dark:bg-red-950/20',
  gray:   'border-border bg-muted/30',
  amber:  'border-amber-200 bg-amber-50 dark:bg-amber-950/20',
};

const SummaryCard = ({ label, value, sub, color = 'gray' }: {
  label: string; value: string; sub?: string; color?: SummaryColor;
}) => (
  <Card className={cn('border', COLOR_MAP[color])}>
    <CardContent className="p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-lg font-bold">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </CardContent>
  </Card>
);

// ─── Import-Modus-Info ────────────────────────────────────────────────────────

const ImportModeInfo = () => (
  <div className="text-[11px] text-muted-foreground space-y-0.5">
    <p><span className="font-semibold text-foreground">Ersetzen:</span> Monat komplett neu importieren</p>
    <p><span className="font-semibold text-foreground">Aktualisieren:</span> Nur geänderte Felder mergen</p>
  </div>
);

// ─── Jahres-Umsatz-Import ─────────────────────────────────────────────────────

const AnnualRevenueImportCard = ({ onImported }: { onImported: () => void }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importYear, setImportYear] = useState(currentYear - 1);
  const [parsing,  setParsing]  = useState(false);
  const [result,   setResult]   = useState<AnnualImportResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [error,    setError]    = useState('');

  const handleFile = async (file: File) => {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      setError('Nur Excel-Dateien (.xlsx/.xls) werden unterstützt.');
      return;
    }
    setParsing(true); setError(''); setResult(null); setSaved(false); setFileName(file.name);
    try {
      const res = await parseAnnualRevenueXLSX(file);
      setResult(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler beim Parsen.');
    } finally { setParsing(false); }
  };

  const handleSave = () => {
    if (!result) return;
    setSaving(true);
    let saved = 0;
    for (const row of result.months) {
      if (row.revenue === 0) continue;
      saveMonth({ year: importYear, month: row.month, revenueActual: row.revenue }, 'annual_xlsx_import', 'update', { note: `Jahres-Import ${fileName}` });
      saved++;
    }
    setSaving(false); setSaved(true); onImported();
    toast.success(`${saved} Monate gespeichert (Vorjahr ${importYear})`);
  };

  const fmt = (v: number) => v === 0 ? '—' : new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(v);

  return (
    <Card className="border-2 border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/10">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Upload className="h-4 w-4 text-blue-600" />
          Jahres-Umsatz importieren (Excel)
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-4 space-y-3">
        <p className="text-xs text-muted-foreground">
          Gastronovi-Jahresbericht als Excel hochladen – Monatswerte werden automatisch erkannt.
        </p>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground whitespace-nowrap">Für Jahr:</label>
          <Select value={String(importYear)} onValueChange={v => { setImportYear(Number(v)); setResult(null); setSaved(false); }}>
            <SelectTrigger className="h-7 text-xs w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[currentYear - 2, currentYear - 1, currentYear].map(y => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!result && !parsing && (
          <div
            className="border-2 border-dashed border-blue-300 dark:border-blue-700 rounded-lg p-4 text-center cursor-pointer hover:bg-blue-50/50 transition-colors"
            onClick={() => fileRef.current?.click()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            onDragOver={e => e.preventDefault()}
          >
            <Upload className="h-6 w-6 mx-auto mb-2 text-blue-400" />
            <p className="text-xs font-medium text-blue-700 dark:text-blue-300">Excel hierher ziehen oder klicken</p>
            <p className="text-[10px] text-muted-foreground mt-1">.xlsx · Gastronovi-Jahresbericht</p>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          </div>
        )}

        {parsing && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Datei wird analysiert…
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded bg-red-50 border border-red-200 p-2 text-xs text-red-700">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /> {error}
          </div>
        )}

        {result && !saved && (
          <div className="space-y-2">
            <p className="text-[11px] font-semibold">{result.months.filter(m => m.revenue > 0).length} Monate erkannt — {fileName}</p>
            <div className="grid grid-cols-4 gap-1 text-[10px]">
              {result.months.map(m => (
                <div key={m.month} className={cn('rounded px-1.5 py-1', m.revenue > 0 ? 'bg-green-50 border border-green-200' : 'bg-muted/30 opacity-50')}>
                  <p className="font-semibold">{MONTH_NAMES_SHORT_DE[m.month]}</p>
                  <p className="font-mono">{fmt(m.revenue)}</p>
                </div>
              ))}
            </div>
            {result.totalRevenue > 0 && (
              <p className="text-xs font-semibold">Total: {fmt(result.totalRevenue)} CHF</p>
            )}
            <Button size="sm" className="w-full h-8 text-xs gap-1.5" onClick={handleSave} disabled={saving}>
              <Save className="h-3.5 w-3.5" />
              {saving ? 'Speichern…' : `${importYear} importieren`}
            </Button>
          </div>
        )}
        {saved && (
          <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded p-2">
            <CheckCircle2 className="h-3.5 w-3.5" /> Import gespeichert.
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ─── Monatsauswahl-Panel ──────────────────────────────────────────────────────

interface MonthSelectorProps {
  kpis:            MonthlyKPI[];
  selected:        Set<number>;
  onToggle:        (month: number) => void;
  onSelectAll:     () => void;
  onSelectNone:    () => void;
  onSelectData:    () => void;
}

const MonthSelectorPanel = ({ kpis, selected, onToggle, onSelectAll, onSelectNone, onSelectData }: MonthSelectorProps) => {
  const dataMonthCount = kpis.filter(k => (k.umsatzIst ?? 0) > 0).length;
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-xs font-bold text-foreground flex items-center gap-1.5">
          <BarChart2 className="h-3.5 w-3.5 text-muted-foreground" />
          Monatsauswahl für Kumuliert-Berechnung
        </h3>
        <div className="flex items-center gap-2">
          <button onClick={onSelectData} className="text-[10px] text-green-700 dark:text-green-400 font-semibold hover:underline">
            Mit Daten ({dataMonthCount})
          </button>
          <span className="text-muted-foreground/40">·</span>
          <button onClick={onSelectAll}  className="text-[10px] text-blue-600 hover:underline">Alle</button>
          <span className="text-muted-foreground/40">·</span>
          <button onClick={onSelectNone} className="text-[10px] text-muted-foreground hover:underline">Keine</button>
        </div>
      </div>
      <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5">
        {kpis.map(k => {
          const isChecked = selected.has(k.month);
          const hasData   = (k.umsatzIst ?? 0) > 0;
          return (
            <label
              key={k.month}
              title={hasData ? `${k.label}: CHF ${(k.umsatzIst ?? 0).toLocaleString('de-CH', { maximumFractionDigits: 0 })}` : `${k.label}: kein Umsatz`}
              className={cn(
                'flex flex-col items-center gap-0.5 rounded border px-1.5 py-1 cursor-pointer transition-colors text-[10px]',
                isChecked
                  ? 'bg-primary/10 border-primary/40 text-primary font-semibold'
                  : 'bg-card border-border text-muted-foreground hover:bg-muted/50',
                !hasData && 'opacity-40',
              )}
            >
              <input
                type="checkbox"
                checked={isChecked}
                onChange={() => onToggle(k.month)}
                className="sr-only"
              />
              <span>{k.label}</span>
              <span className={cn(
                'w-1.5 h-1.5 rounded-full',
                !hasData       ? 'bg-muted-foreground/20' :
                isChecked      ? 'bg-primary' : 'bg-muted-foreground/40',
              )} />
            </label>
          );
        })}
      </div>
      <p className="text-[10px] text-muted-foreground/60">
        ☑ {selected.size} Monat{selected.size !== 1 ? 'e' : ''} ausgewählt — Prozentwerte aus Summen (kein Durchschnitt der Monatsquoten).
      </p>
    </div>
  );
};

// ─── Kumuliert-Zusammenfassung ────────────────────────────────────────────────

interface CumulatedTotals {
  umsatzIst:        number;
  umsatzBudget:     number;
  pkIst:            number;
  pkBudget:         number;
  warenIst:         number;
  warenaufwandPL:   number;
  personalaufwandPL: number;
  pkQuote:          number | null;
  pkQuoteBudget:    number | null;
  warenQuote:       number | null;
  warenaufwandPLPct:    number | null;
  personalaufwandPLPct: number | null;
  months:           number;
}

function calcCumulated(kpis: MonthlyKPI[], selected: Set<number>): CumulatedTotals {
  const sel  = kpis.filter(k => selected.has(k.month));
  const sumU  = sel.reduce((s, k) => s + (k.umsatzIst    ?? 0), 0);
  const sumUB = sel.reduce((s, k) => s + (k.umsatzBudget ?? 0), 0);
  const sumPK = sel.reduce((s, k) => s + (k.pkIst        ?? 0), 0);
  const sumPKB= sel.reduce((s, k) => s + (k.pkBudget     ?? 0), 0);
  const sumW  = sel.reduce((s, k) => s + (k.warenIst     ?? 0), 0);
  const sumWPL= sel.reduce((s, k) => s + (k.warenaufwandPL    ?? 0), 0);
  const sumPPL= sel.reduce((s, k) => s + (k.personalaufwandPL ?? 0), 0);
  return {
    umsatzIst:            sumU,
    umsatzBudget:         sumUB,
    pkIst:                sumPK,
    pkBudget:             sumPKB,
    warenIst:             sumW,
    warenaufwandPL:       sumWPL,
    personalaufwandPL:    sumPPL,
    pkQuote:              sumU >= 1000 && sumPK  > 0 ? parseFloat(((sumPK  / sumU) * 100).toFixed(1)) : null,
    pkQuoteBudget:        sumU >= 1000 && sumPKB > 0 ? parseFloat(((sumPKB / sumU) * 100).toFixed(1)) : null,
    warenQuote:           sumU >= 1000 && sumW   > 0 ? parseFloat(((sumW   / sumU) * 100).toFixed(1)) : null,
    warenaufwandPLPct:    sumU >= 1000 && sumWPL > 0 ? parseFloat(((sumWPL / sumU) * 100).toFixed(1)) : null,
    personalaufwandPLPct: sumU >= 1000 && sumPPL > 0 ? parseFloat(((sumPPL / sumU) * 100).toFixed(1)) : null,
    months:               sel.length,
  };
}

// ─── Haupt-Seite ──────────────────────────────────────────────────────────────

const Reporting = () => {
  const { isAdmin }          = usePermissions();
  const { tenantId, tenantKey } = useTenant();

  if (!isAdmin) return <Navigate to="/" replace />;

  const { isInScope, isActive: stichtagActive } = useStichtag();
  const { showMarketingCol: maisonColPref } = useMaison();
  const years = availableYears();
  const [year,        setYear]        = useState(currentYear);
  const [months,      setMonths]      = useState<MonthlyFinancialRecord[]>(() => loadYear(year));
  const [editRecord,  setEditRecord]  = useState<MonthlyFinancialRecord | null>(null);
  const [highlightVariance, setHighlightVariance] = useState(false);

  // Maison-Umsatz (identisch mit PLView)
  const [maisonEnabled, setMaisonEnabled] = useState(() => getMaisonEnabledSync(tenantKey));
  const [maisonDaily,   setMaisonDaily]   = useState<Record<string, number>>(() => getMaisonDailySync(tenantKey));
  useEffect(() => {
    loadMaisonEnabled(tenantKey).then(setMaisonEnabled);
    loadMaisonDaily(tenantKey).then(setMaisonDaily);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // Takeaway-Monatskorrektur (identisch mit PLView / TagesControlling)
  const [takeawayMonthlyMap, setTakeawayMonthlyMap] = useState<Record<string, number>>({});
  useEffect(() => {
    kvGet(tenantKey(`takeaway-monthly-${year}`)).then(v => {
      if (v && typeof v === 'object') setTakeawayMonthlyMap(v as Record<string, number>);
      else setTakeawayMonthlyMap({});
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, tenantId]);

  // VJ-Tages-Supabase-Daten (wie PLView)
  const [vjDailyData, setVjDailyData] = useState<Record<string, VjDayRecord>>({});
  useEffect(() => {
    loadVjDailyYear(year - 1, tenantId).then(data => setVjDailyData(data));
  }, [year, tenantId]);

  // Nach Supabase-Sync Daten neu laden
  useEffect(() => {
    const handler = () => setMonths(loadYear(year, tenantKey('reporting_v1')));
    window.addEventListener('store-synced', handler);
    return () => window.removeEventListener('store-synced', handler);
  }, [year, tenantId]);

  // Tages-Daten (authoritativ für IST-Umsatz)
  const dailyBudgetsData = useMemo<Record<string, { actualRevenue?: number; takeawayRevenue?: number; previousYearRevenue?: number }>>(() => {
    try { return JSON.parse(localStorage.getItem(tenantKey('dailyBudgets')) || '{}'); }
    catch { return {}; }
  }, [year, months, tenantId]);

  // Budget-Daten
  const resolvedBudget = useMemo(() => {
    try { return resolveBudgetYear(loadBudgetWithPL(year, tenantKey('budget_v1'))); }
    catch { return null; }
  }, [year, tenantId]);

  // Vorjahres-Reporting als Fallback
  const prevYearMonths = useMemo(() => {
    try { return loadYear(year - 1, tenantKey('reporting_v1')); }
    catch { return [] as MonthlyFinancialRecord[]; }
  }, [year, tenantId]);

  // ── Effektive Monatsdaten (IDENTISCH mit PLView) ─────────────────────────
  const effectiveMonths = useMemo<MonthlyFinancialRecord[]>(() => {
    const findBudget = (id: string) => resolvedBudget?.positions.find(p => p.position.id === id);
    const revBudgetPos = findBudget('budget_revenue');
    const perBudgetPos = findBudget('budget_personnel');

    return months.map((rec, idx) => {
      const m = idx + 1;
      let r = rec;

      // 1) IST-Umsatz: computeMonthlyIstNet (NETTO – identisch mit PLView, inkl. Maison + Takeaway)
      const hasIndivRev = r.expenseCategories.some(c => {
        const n = parseInt(c.categoryId);
        return !isNaN(n) && n >= 3000 && n <= 3999;
      });
      if (!hasIndivRev) {
        // Maison (Marketing-Umsatzkanal): nur einrechnen wenn aktiviert und "Anzeigen" aktiv
        const maisonArg = maisonEnabled && maisonColPref ? maisonDaily : undefined;
        const taMonthly = takeawayMonthlyMap[`${year}-${String(m).padStart(2, '0')}`] ?? 0;
        const net = computeMonthlyIstNet(year, m, dailyBudgetsData, undefined, maisonArg, taMonthly > 0 ? taMonthly : undefined);
        if (net > 0) r = { ...r, revenueActual: net };
      }

      // 2) VJ-Umsatz: computeMonthlyVjNet (NETTO – identisch mit PLView)
      const hasIndivPYRev = (r.expenseCategoriesPreviousYear ?? []).some(c => {
        const n = parseInt(c.categoryId);
        return !isNaN(n) && n >= 3000 && n <= 3999;
      });
      if (!hasIndivPYRev) {
        const vjNet = computeMonthlyVjNet(year, m, dailyBudgetsData, vjDailyData);
        if (vjNet > 0) {
          r = { ...r, revenuePreviousYear: vjNet };
        } else if (!r.revenuePreviousYear) {
          const prevActual = prevYearMonths[idx]?.revenueActual;
          if (prevActual) r = { ...r, revenuePreviousYear: prevActual };
        }
      }

      // 3) Budget aus budget_v1
      if (!r.revenueBudget && revBudgetPos) {
        const bv = revBudgetPos.resolvedCHF[idx] ?? 0;
        if (bv > 0) r = { ...r, revenueBudget: bv };
      }
      if (!r.personnelCostPlanned && perBudgetPos) {
        const bp = perBudgetPos.resolvedCHF[idx] ?? 0;
        if (bp > 0) r = { ...r, personnelCostPlanned: bp };
      }

      // 4) PK Ist aus 5xxx-Konten wenn nicht manuell
      if (!r.personnelCostActual && r.expenseCategories.length > 0) {
        const pkFromCats = r.expenseCategories
          .filter(cat => { const n = parseInt(cat.categoryId); return !isNaN(n) && n >= 5000 && n <= 5999; })
          .reduce((sum, cat) => sum + (cat.amount ?? 0), 0);
        if (pkFromCats > 0) r = { ...r, personnelCostActual: pkFromCats };
      }

      return r;
    });
  }, [months, year, dailyBudgetsData, vjDailyData, resolvedBudget, prevYearMonths, maisonEnabled, maisonColPref, maisonDaily, takeawayMonthlyMap]);

  // ── P&L-Berechnungen pro Monat (identisch mit PLView) ───────────────────
  const plResults = useMemo<PLMonthResult[]>(
    () => effectiveMonths.map(rec => computePLForMonth(rec)),
    [effectiveMonths],
  );

  // ── Zentrales KPI-Array (alle Charts nutzen dasselbe Objekt) ────────────
  const monthlyKPIs = useMemo(
    () => buildMonthlyKPIs(effectiveMonths, plResults),
    [effectiveMonths, plResults],
  );

  // ── Monatsauswahl ────────────────────────────────────────────────────────
  const [selectedMonths, setSelectedMonths] = useState<Set<number>>(() => new Set<number>());
  const autoSelectKeyRef = useRef('');

  // Auto-select only months with actual revenue when data first loads or year/tenant changes
  useEffect(() => {
    const key = `${year}-${tenantId}`;
    if (autoSelectKeyRef.current === key) return;
    const withRevenue = monthlyKPIs.filter(k => (k.umsatzIst ?? 0) > 0);
    // Wait until KPIs are computed (at least one month has data or we've passed initial render)
    if (withRevenue.length === 0 && !monthlyKPIs.some(k => k.umsatzIst != null)) return;
    autoSelectKeyRef.current = key;
    setSelectedMonths(new Set(withRevenue.map(k => k.month)));
  }, [year, tenantId, monthlyKPIs]);

  const toggleMonth      = (m: number) => setSelectedMonths(prev => {
    const next = new Set(prev);
    next.has(m) ? next.delete(m) : next.add(m);
    return next;
  });
  const selectAllMonths  = () => setSelectedMonths(new Set(Array.from({ length: 12 }, (_, i) => i + 1)));
  const selectNoMonths   = () => setSelectedMonths(new Set());
  const selectDataMonths = () => setSelectedMonths(new Set(monthlyKPIs.filter(k => (k.umsatzIst ?? 0) > 0).map(k => k.month)));

  const cumulated = useMemo(() => calcCumulated(monthlyKPIs, selectedMonths), [monthlyKPIs, selectedMonths]);

  // ── Restliche Berechnungen ───────────────────────────────────────────────
  const threshold = useMemo(
    () => parseInt(localStorage.getItem(tenantKey('labor_cost_threshold')) || '40'),
    [tenantId],
  );

  const hasAnyData = effectiveMonths.some(m => m.revenueActual !== undefined || m.personnelCostActual !== undefined);
  const totals     = useMemo(() => calcEffectiveTotals(effectiveMonths), [effectiveMonths]);

  const reload = useCallback(() => {
    setMonths(loadYear(year, tenantKey('reporting_v1')));
  }, [year, tenantId]);

  const handleYearChange = (y: number) => {
    setYear(y);
    setMonths(loadYear(y, tenantKey('reporting_v1')));
  };

  const handleExportPDF = () => {
    try {
      exportReportingToPDF(effectiveMonths, totals, year, threshold);
      toast.success('PDF exportiert');
    } catch { toast.error('PDF-Export fehlgeschlagen'); }
  };

  const handleExportMonatsdaten = () => {
    try {
      const rows: MonatsdatenRow[] = effectiveMonths.map((m, idx) => {
        const kpi = monthlyKPIs[idx];
        const completeness = calcCompleteness(m);
        return {
          monat:           MONTH_NAMES_SHORT_DE[m.month],
          umsatzIst:       m.revenueActual        ?? null,
          umsatzBudget:    m.revenueBudget        ?? null,
          umsatzVorjahr:   m.revenuePreviousYear  ?? null,
          abwBudgetPct:    kpi.abwBudgetPct,
          abwVorjahrPct:   kpi.abwVorjahrPct,
          warenaufwand:    kpi.warenaufwandPL,
          warenPct:        kpi.warenaufwandPLPct,
          personalaufwand: kpi.personalaufwandPL,
          personalPct:     kpi.personalaufwandPLPct,
          pkIst:           m.personnelCostActual  ?? null,
          pkPlan:          m.personnelCostPlanned ?? null,
          vollstaendigkeit: completeness.completenessPercent,
        };
      });
      exportMonatsdatenToPDF(rows, year, tenant.name, threshold, tenantId);
      toast.success('Monatsdaten PDF exportiert');
    } catch { toast.error('Monatsdaten PDF fehlgeschlagen'); }
  };

  const handleExportExcel = () => {
    try {
      exportReportingToExcel(effectiveMonths, totals, year);
      toast.success('Excel exportiert');
    } catch { toast.error('Excel-Export fehlgeschlagen'); }
  };

  const buildMonatsdatenRows = (): MonatsdatenRow[] =>
    effectiveMonths.map((m, idx) => {
      const kpi = monthlyKPIs[idx];
      const completeness = calcCompleteness(m);
      return {
        monat:           MONTH_NAMES_SHORT_DE[m.month],
        umsatzIst:       m.revenueActual        ?? null,
        umsatzBudget:    m.revenueBudget        ?? null,
        umsatzVorjahr:   m.revenuePreviousYear  ?? null,
        abwBudgetPct:    kpi.abwBudgetPct,
        abwVorjahrPct:   kpi.abwVorjahrPct,
        warenaufwand:    kpi.warenaufwandPL,
        warenPct:        kpi.warenaufwandPLPct,
        personalaufwand: kpi.personalaufwandPL,
        personalPct:     kpi.personalaufwandPLPct,
        pkIst:           m.personnelCostActual  ?? null,
        pkPlan:          m.personnelCostPlanned ?? null,
        vollstaendigkeit: completeness.completenessPercent,
      };
    });

  const handleExportTablePDF = () => {
    try {
      exportMonatsdatenToPDF(buildMonatsdatenRows(), year, tenant.name, threshold, tenantId);
      toast.success('Monatsdaten PDF exportiert');
    } catch { toast.error('PDF-Export fehlgeschlagen'); }
  };

  const handleExportTableExcel = () => {
    try {
      exportMonatsdatenToExcel(buildMonatsdatenRows(), year, tenant.name, threshold, tenantId);
      toast.success('Monatsdaten Excel exportiert');
    } catch { toast.error('Excel-Export fehlgeschlagen'); }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background flex flex-col">

      {/* ── Header ── */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm flex-shrink-0">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link to="/"><Button variant="ghost" size="sm" className="h-8 px-2">
              <LayoutDashboard className="h-3.5 w-3.5 mr-1" /><span className="text-xs">Dashboard</span>
            </Button></Link>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <Link to="/erfolgsrechnung"><Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground">
              Erfolgsrechnung
            </Button></Link>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <h1 className="text-sm font-bold flex items-center gap-1.5">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              Analyse / Reporting
            </h1>
            <Badge variant="outline" className="text-[10px] border-purple-300 text-purple-700 bg-purple-50 dark:bg-purple-950/20">Admin</Badge>
          </div>

          <div className="flex items-center gap-2">
            <Link to="/erfolgsrechnung">
              <Button variant="outline" size="sm" className="h-8 text-xs gap-1 border-emerald-300 text-emerald-700 hover:bg-emerald-50">
                <BarChart2 className="h-3.5 w-3.5" /><span className="hidden sm:inline">Erfolgsrechnung</span>
              </Button>
            </Link>
            <Link to="/csv-import">
              <Button variant="outline" size="sm" className="h-8 text-xs gap-1 border-blue-300 text-blue-700 hover:bg-blue-50">
                <Upload className="h-3.5 w-3.5" /><span className="hidden sm:inline">Import</span>
              </Button>
            </Link>
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1 border-rose-300 text-rose-700 hover:bg-rose-50" onClick={handleExportPDF}>
              <FileDown className="h-3.5 w-3.5" /><span className="hidden sm:inline">PDF</span>
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1 border-indigo-300 text-indigo-700 hover:bg-indigo-50" onClick={handleExportMonatsdaten}>
              <Sheet className="h-3.5 w-3.5" /><span className="hidden sm:inline">Monatsdaten PDF</span>
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1 border-green-300 text-green-700 hover:bg-green-50" onClick={handleExportExcel}>
              <FileSpreadsheet className="h-3.5 w-3.5" /><span className="hidden sm:inline">Excel</span>
            </Button>
            <Link to="/kontenplan">
              <Button variant="outline" size="sm" className="h-8 text-xs gap-1">
                <Settings2 className="h-3.5 w-3.5" /><span className="hidden sm:inline">Kontenplan</span>
              </Button>
            </Link>
            <Select value={String(year)} onValueChange={v => handleYearChange(Number(v))}>
              <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" className="h-8" onClick={reload}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 max-w-6xl mx-auto w-full px-4 py-5 space-y-5 pb-20">

        <StichtagBanner />

        {/* Datenbasis-Info */}
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 dark:border-emerald-800 p-3 flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-emerald-800 dark:text-emerald-300">
            <span className="font-bold">Datenbasis identisch mit Erfolgsrechnung:</span>{' '}
            IST-Umsatz = Tagesansicht Netto (MwSt abgezogen) · Quoten werden nur berechnet wenn Umsatz ≥ CHF 1'000.
          </div>
        </div>

        {/* ── Jahresübersicht-Karten ── */}
        {hasAnyData && (
          <section>
            <h2 className="text-sm font-bold mb-3">Jahresübersicht {year}</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard
                label="Umsatz Ist (Netto)"
                value={fmtCHF(totals.revenueActual)}
                sub={totals.revenueBudget > 0 ? `Budget: ${fmtCHF(totals.revenueBudget)}` : undefined}
                color="blue"
              />
              <SummaryCard
                label="PK Ist"
                value={fmtCHF(totals.personnelCostActual)}
                sub={totals.personnelCostPlanned > 0 ? `Plan: ${fmtCHF(totals.personnelCostPlanned)}` : undefined}
                color="orange"
              />
              <SummaryCard
                label="PK-Quote Jahres-Ø"
                value={totals.revenueActual > 0 && totals.personnelCostActual > 0
                  ? fmtPct(safeQuote(totals.personnelCostActual, totals.revenueActual))
                  : '–'}
                sub="Personalkosten / Umsatz Netto"
                color={safeQuote(totals.personnelCostActual, totals.revenueActual) !== null &&
                  (safeQuote(totals.personnelCostActual, totals.revenueActual) ?? 0) > threshold
                  ? 'red' : 'green'}
              />
              <SummaryCard
                label="Monate mit Daten"
                value={`${effectiveMonths.filter(m => m.revenueActual !== undefined || m.personnelCostActual !== undefined).length} / 12`}
                sub={`Jahr ${year}`}
                color="gray"
              />
            </div>
          </section>
        )}

        {/* ── Diagramme: Umsatz ── */}
        <section className="space-y-4">
          <h2 className="text-sm font-bold">Umsatzvergleich {year}</h2>

          <Card>
            <CardHeader className="pb-2 pt-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <BarChart2 className="h-4 w-4 text-muted-foreground" />
                Umsatz Ist / Budget / Vorjahr (Netto CHF)
              </CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Identische Datenbasis wie Tagesansicht und Erfolgsrechnung.
              </p>
            </CardHeader>
            <CardContent className="pt-0 pr-2">
              <RevenueComparisonChart
                data={monthlyKPIs}
                highlightVariance={highlightVariance}
                selectedMonths={selectedMonths}
                onToggle={toggleMonth}
                onSelectAll={selectAllMonths}
                onSelectNone={selectNoMonths}
                onSelectData={selectDataMonths}
              />
            </CardContent>
          </Card>
        </section>

        {/* ── Diagramme: Personalkosten (kombiniert) ── */}
        <PKKombinierteChart
          data={monthlyKPIs}
          year={year}
          threshold={threshold}
        />

        {/* ── Diagramme: Warenaufwand (kombiniert) ── */}
        <WarenKombinierteChart
          data={monthlyKPIs}
          year={year}
          selectedMonths={selectedMonths}
          onToggle={toggleMonth}
          onSelectAll={selectAllMonths}
          onSelectNone={selectNoMonths}
          onSelectData={selectDataMonths}
        />

        {/* ── Absenzen ── */}
        <AbsenzMonatsBlock year={year} />

        {/* ── Kumuliert-Zusammenfassung ── */}
        <section className="space-y-3">
        {selectedMonths.size > 0 && cumulated.umsatzIst > 0 && (
          <div>
            <h2 className="text-sm font-bold mb-3">
              Kumuliert – {selectedMonths.size} Monate ({selectedMonths.size === monthlyKPIs.filter(k => (k.umsatzIst ?? 0) > 0).length ? 'alle mit Daten' : 'ausgewählt'})
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
              <SummaryCard label="Umsatz kumuliert"     value={fmtCHF(cumulated.umsatzIst)}    sub={cumulated.umsatzBudget > 0 ? `Budget: ${fmtCHF(cumulated.umsatzBudget)}` : undefined} color="blue" />
              <SummaryCard label="PK Ist kumuliert"     value={fmtCHF(cumulated.pkIst)}         sub={cumulated.pkBudget > 0 ? `Plan: ${fmtCHF(cumulated.pkBudget)}` : undefined}      color="orange" />
              <SummaryCard
                label="PK-Quote kumuliert"
                value={fmtPct(cumulated.pkQuote)}
                sub={cumulated.pkQuoteBudget != null ? `Plan-Quote: ${fmtPct(cumulated.pkQuoteBudget)}` : 'PK Ist / Umsatz Ist'}
                color={cumulated.pkQuote != null && cumulated.pkQuote > threshold ? 'red' : 'green'}
              />
              <SummaryCard
                label="Warenaufwand kumuliert"
                value={fmtCHF(cumulated.warenIst)}
                sub={undefined}
                color="amber"
              />
              <SummaryCard
                label="Warenquote kumuliert"
                value={fmtPct(cumulated.warenQuote)}
                sub="Warenaufwand / Umsatz Ist"
                color={cumulated.warenQuote != null && cumulated.warenQuote > 30 ? 'red' : 'green'}
              />
            </div>
          </div>
        )}
        </section>

        {/* ── Haupttabelle ── */}
        <section>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-sm font-bold">Monatsdaten {year}</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                title="Abweichungen > 10% hervorheben"
                onClick={() => setHighlightVariance(v => !v)}
                className={cn(
                  'h-7 px-2 flex items-center gap-1 rounded border text-xs transition-colors',
                  highlightVariance ? 'bg-amber-500 text-white border-amber-500' : 'bg-card border-border hover:bg-muted text-muted-foreground',
                )}
              >
                <AlertTriangle className="h-3.5 w-3.5" /><span>Abw. &gt;10%</span>
              </button>
              <div className="h-4 border-l border-border/60" />
              <Button
                variant="outline" size="sm"
                className="h-7 text-xs gap-1 border-rose-300 text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/20"
                onClick={handleExportTablePDF}
              >
                <FileDown className="h-3.5 w-3.5" />
                <span>PDF</span>
              </Button>
              <Button
                variant="outline" size="sm"
                className="h-7 text-xs gap-1 border-green-300 text-green-700 hover:bg-green-50 dark:hover:bg-green-950/20"
                onClick={handleExportTableExcel}
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                <span>Excel</span>
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/50 border-b border-border">
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground w-20 sticky left-0 bg-muted/50">Monat</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">Umsatz Ist</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">Budget</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">Vorjahr</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-amber-700 dark:text-amber-400">Warenaufwand</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-amber-700 dark:text-amber-400">Waren %</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-orange-700 dark:text-orange-400">Personalaufwand</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-orange-700 dark:text-orange-400">Personal %</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">PK Ist</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">PK Plan</th>
                    <th className="text-center px-3 py-2.5 font-semibold text-muted-foreground w-16">Vollst.</th>
                    <th className="text-center px-3 py-2.5 font-semibold text-muted-foreground w-20">Aktion</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {effectiveMonths.map((m, idx) => {
                    const kpi          = monthlyKPIs[idx];
                    const completeness = calcCompleteness(m);
                    const isEmpty      = !m.revenueActual && !m.revenueBudget && !m.personnelCostActual && !m.personnelCostPlanned && m.expenseCategories.length === 0;
                    const isCurrent    = m.year === currentYear && m.month === currentMonth;
                    const isOutOfScope = stichtagActive && !isInScope(m.year, m.month);
                    const isSelected   = selectedMonths.has(m.month);

                    const abwB = kpi.abwBudgetPct;
                    const abwV = kpi.abwVorjahrPct;

                    const isVarHighlighted = highlightVariance && abwB !== null && Math.abs(abwB) > 10;
                    const varRowClass = isVarHighlighted
                      ? abwB! < 0
                        ? 'bg-red-50 dark:bg-red-950/20 border-l-4 border-l-red-400'
                        : 'bg-green-50 dark:bg-green-950/20 border-l-4 border-l-green-400'
                      : '';

                    const abwColor = (pct: number | null, positive = true) => {
                      if (pct == null) return 'text-muted-foreground/50';
                      const good = positive ? pct >= 0 : pct <= 0;
                      if (good)  return pct === 0 ? 'text-muted-foreground' : 'text-green-600 dark:text-green-400';
                      return Math.abs(pct) > 10 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400';
                    };

                    const fmtAbw = (pct: number | null) =>
                      pct == null ? null : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)} %`;

                    return (
                      <tr
                        key={m.id}
                        className={cn(
                          'hover:bg-muted/30 transition-colors',
                          isCurrent && !isVarHighlighted && 'bg-primary/5',
                          isEmpty && 'opacity-60',
                          isOutOfScope && 'opacity-40 bg-muted/10',
                          isSelected && !isVarHighlighted && !isEmpty && 'bg-blue-50/30 dark:bg-blue-950/10',
                          varRowClass,
                        )}
                      >
                        {/* Monat */}
                        <td className="px-3 py-2 font-semibold sticky left-0 bg-inherit">
                          <div className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleMonth(m.month)}
                              className="h-3 w-3 rounded"
                            />
                            <span className={cn(isCurrent && 'text-primary', isOutOfScope && 'line-through text-muted-foreground')}>
                              {MONTH_NAMES_SHORT_DE[m.month]}
                            </span>
                          </div>
                        </td>

                        {/* Umsatz Ist */}
                        <td className="px-3 py-2 text-right font-mono">
                          {m.revenueActual !== undefined ? (
                            <div>
                              <span className={varianceColor(m.revenueActual, m.revenueBudget)}>
                                {fmtCHF(m.revenueActual)}
                              </span>
                              {highlightVariance && abwV != null && (
                                <div className={cn('text-[9px] font-semibold', abwColor(abwV))}>
                                  VJ: {fmtAbw(abwV)}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground/40">–</span>
                          )}
                        </td>

                        {/* Budget */}
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                          {m.revenueBudget !== undefined ? (
                            <div>
                              <span>{fmtCHF(m.revenueBudget)}</span>
                              {highlightVariance && abwB != null && (
                                <div className={cn('text-[9px] font-semibold', abwColor(abwB))}>
                                  Bdg: {fmtAbw(abwB)}
                                </div>
                              )}
                            </div>
                          ) : '–'}
                        </td>

                        {/* Vorjahr */}
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                          {m.revenuePreviousYear !== undefined ? (
                            <div>
                              <span>{fmtCHF(m.revenuePreviousYear)}</span>
                              {highlightVariance && (
                                <div className="text-[9px] text-muted-foreground/50">Basis VJ</div>
                              )}
                            </div>
                          ) : '–'}
                        </td>

                        {/* Warenaufwand (P&L) */}
                        <td className="px-3 py-2 text-right font-mono">
                          {kpi.warenaufwandPL != null ? (
                            <span className="text-amber-700 dark:text-amber-400">{fmtCHF(kpi.warenaufwandPL)}</span>
                          ) : <span className="text-muted-foreground/40">–</span>}
                        </td>

                        {/* Waren % */}
                        <td className="px-3 py-2 text-right font-mono">
                          {kpi.warenaufwandPLPct != null ? (
                            <span className={cn('font-semibold',
                              kpi.warenaufwandPLPct > 33 ? 'text-red-600' :
                              kpi.warenaufwandPLPct > 28 ? 'text-amber-600' : 'text-green-600')}>
                              {fmtPct(kpi.warenaufwandPLPct)}
                            </span>
                          ) : <span className="text-muted-foreground/40">–</span>}
                        </td>

                        {/* Personalaufwand (P&L) */}
                        <td className="px-3 py-2 text-right font-mono">
                          {kpi.personalaufwandPL != null ? (
                            <span className="text-orange-700 dark:text-orange-400">{fmtCHF(kpi.personalaufwandPL)}</span>
                          ) : <span className="text-muted-foreground/40">–</span>}
                        </td>

                        {/* Personal % */}
                        <td className="px-3 py-2 text-right font-mono">
                          {kpi.personalaufwandPLPct != null ? (
                            <span className={cn('font-semibold',
                              kpi.personalaufwandPLPct > threshold + 5 ? 'text-red-600' :
                              kpi.personalaufwandPLPct > threshold     ? 'text-amber-600' : 'text-green-600')}>
                              {fmtPct(kpi.personalaufwandPLPct)}
                            </span>
                          ) : <span className="text-muted-foreground/40">–</span>}
                        </td>

                        {/* PK Ist (Dienstplanung) */}
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                          {m.personnelCostActual !== undefined
                            ? fmtCHF(m.personnelCostActual)
                            : <span className="text-muted-foreground/40">–</span>}
                        </td>

                        {/* PK Plan */}
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                          {m.personnelCostPlanned !== undefined
                            ? fmtCHF(m.personnelCostPlanned)
                            : <span className="text-muted-foreground/40">–</span>}
                        </td>

                        {/* Vollständigkeit */}
                        <td className="px-3 py-2 text-center">
                          <CompletenessBadge pct={completeness.completenessPercent} />
                        </td>

                        {/* Aktion */}
                        <td className="px-3 py-2 text-center">
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setEditRecord(m)}>
                            {isEmpty ? <><Plus className="h-3 w-3 mr-0.5" />Erfassen</> : <><Edit3 className="h-3 w-3 mr-0.5" />Bearbeiten</>}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}

                  {/* ── Kumuliert-Zeile ── */}
                  {selectedMonths.size > 0 && selectedMonths.size < 12 && cumulated.umsatzIst > 0 && (
                    <tr className="bg-blue-100/60 dark:bg-blue-900/20 border-t-2 border-blue-300 font-bold">
                      <td className="px-3 py-2.5 text-xs font-bold text-blue-800 dark:text-blue-300 sticky left-0 bg-blue-100/60 dark:bg-blue-900/20">
                        Σ Auswahl ({selectedMonths.size} Mo.)
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">{fmtCHF(cumulated.umsatzIst)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">{cumulated.umsatzBudget > 0 ? fmtCHF(cumulated.umsatzBudget) : '–'}</td>
                      <td className="px-3 py-2.5 text-center text-muted-foreground">–</td>
                      {/* Warenaufwand PL */}
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-amber-700">
                        {cumulated.warenaufwandPL > 0 ? fmtCHF(cumulated.warenaufwandPL) : '–'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">
                        {cumulated.warenaufwandPLPct != null ? (
                          <span className={cumulated.warenaufwandPLPct > 30 ? 'text-red-600' : 'text-green-600'}>
                            {fmtPct(cumulated.warenaufwandPLPct)}
                          </span>
                        ) : '–'}
                      </td>
                      {/* Personalaufwand PL */}
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-orange-700">
                        {cumulated.personalaufwandPL > 0 ? fmtCHF(cumulated.personalaufwandPL) : '–'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">
                        {cumulated.personalaufwandPLPct != null ? (
                          <span className={cumulated.personalaufwandPLPct > threshold ? 'text-red-600' : 'text-green-600'}>
                            {fmtPct(cumulated.personalaufwandPLPct)}
                          </span>
                        ) : '–'}
                      </td>
                      {/* PK Ist / Plan */}
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                        {fmtCHF(cumulated.pkIst)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                        {cumulated.pkBudget > 0 ? fmtCHF(cumulated.pkBudget) : '–'}
                      </td>
                      <td />
                      <td />
                    </tr>
                  )}

                  {/* ── Total-Zeile ── */}
                  {hasAnyData && (
                    <tr className="bg-slate-100 dark:bg-slate-800 border-t-2 border-border font-bold">
                      <td className="px-3 py-2.5 text-sm font-bold sticky left-0 bg-slate-100 dark:bg-slate-800">Σ Total {year}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">{totals.revenueActual > 0 ? fmtCHF(totals.revenueActual) : '–'}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">{totals.revenueBudget > 0 ? fmtCHF(totals.revenueBudget) : '–'}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                        {totals.revenuePreviousYear > 0 ? <>
                          {fmtCHF(totals.revenuePreviousYear)}
                          {totals.revenueActual > 0 && (
                            <span className="ml-1 text-[9px] font-normal">
                              {formatVariance(totals.revenueActual, totals.revenuePreviousYear)}
                            </span>
                          )}
                        </> : '–'}
                      </td>
                      {/* Warenaufwand PL Totals */}
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-amber-700">
                        {monthlyKPIs.reduce((s, k) => s + (k.warenaufwandPL ?? 0), 0) > 0
                          ? fmtCHF(monthlyKPIs.reduce((s, k) => s + (k.warenaufwandPL ?? 0), 0))
                          : '–'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">
                        {(() => {
                          const tw = monthlyKPIs.reduce((s, k) => s + (k.warenaufwandPL ?? 0), 0);
                          const tu = totals.revenueActual;
                          const q  = safeQuote(tw, tu);
                          return q != null ? (
                            <span className={q > 30 ? 'text-red-600' : 'text-green-600'}>{fmtPct(q)}</span>
                          ) : '–';
                        })()}
                      </td>
                      {/* Personalaufwand PL Totals */}
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-orange-700">
                        {monthlyKPIs.reduce((s, k) => s + (k.personalaufwandPL ?? 0), 0) > 0
                          ? fmtCHF(monthlyKPIs.reduce((s, k) => s + (k.personalaufwandPL ?? 0), 0))
                          : '–'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">
                        {(() => {
                          const tp = monthlyKPIs.reduce((s, k) => s + (k.personalaufwandPL ?? 0), 0);
                          const tu = totals.revenueActual;
                          const q  = safeQuote(tp, tu);
                          return q != null ? (
                            <span className={q > threshold ? 'text-red-600' : 'text-green-600'}>{fmtPct(q)}</span>
                          ) : '–';
                        })()}
                      </td>
                      {/* PK Ist */}
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                        {totals.personnelCostActual > 0 ? fmtCHF(totals.personnelCostActual) : '–'}
                      </td>
                      {/* PK Plan */}
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                        {totals.revenueBudget > 0 ? '–' : '–'}
                      </td>
                      <td />
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ── Import-Abschnitte ── */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="border-2 border-purple-200 dark:border-purple-800">
            <CardHeader className="pb-2 pt-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <Upload className="h-4 w-4" />
                Buchhaltungsimport
                <Badge variant="outline" className="text-[9px] border-purple-300 text-purple-700 bg-purple-50 dark:bg-purple-950/20 ml-auto">CSV / Excel</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pb-4 space-y-2">
              <p className="text-xs text-muted-foreground">
                Sage Kontoblatt (Excel), CSV oder Text-PDF importieren. 4xxx-Konten → Warenaufwand, 5xxx-Konten → Personalkosten.
              </p>
              <ImportModeInfo />
              <Link to="/csv-import">
                <Button size="sm" className="w-full h-8 text-xs gap-1.5">
                  <FileText className="h-3.5 w-3.5" /> Zum Buchhaltungs-Import
                </Button>
              </Link>
            </CardContent>
          </Card>
          <AnnualRevenueImportCard onImported={reload} />
        </section>

      </div>

      {/* ── Erfassungs-Dialog ── */}
      {editRecord && (
        <EntryDialog
          record={editRecord}
          storeKey={tenantKey('reporting_v1')}
          onClose={() => setEditRecord(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
};

export default Reporting;
