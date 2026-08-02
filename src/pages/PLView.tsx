/**
 * Erfolgsrechnung (P&L) – Haupt-Seite
 * =====================================
 *
 * Zwei Ansichten:
 *   A. Monatsansicht  – ein Monat, Spalten: Ist / Budget / Vorjahr / Abw.Budget / Abw.VJ
 *   B. Jahresübersicht – alle 12 Monate nebeneinander + Jahressumme
 *
 * Drilldown:
 *   Klick auf eine Zeile → Dialog mit Quelldaten und Kategorie-Details.
 *
 * Nur für Admin zugänglich.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Navigate, useSearchParams } from 'react-router-dom';
import { MONAT_PARAM, parseMonatParam } from '@/lib/monat-param';
import {
  LayoutDashboard, TrendingUp, ChevronRight, Info,
  ChevronDown, X, BarChart2, Table2, Calendar,
  AlertCircle, CheckCircle2, ArrowUpRight, ArrowDownRight, Trash2,
  Minus, Database, AlignJustify, List, Pencil, Check, Plus, AlertTriangle,
  Calculator, ArrowRight, FileText, Landmark, SlidersHorizontal,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { aggregateBPLRows, aggregateFinancialMetricValues } from '@/lib/bpl-aggregate';
import { getBPLColumnVisibility } from '@/lib/bpl-columns';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  getFinancialMetricDefinition, getFinancialMetricValues,
  type FinancialMetricId, type FinancialMetricValues, type FinancialMetricDefinition,
} from '@/lib/financial-metrics';
import { warenPctTone, personalPctTone } from '@/lib/reporting-export';
import { KpiCard, KpiGrid, MoreKpis } from '@/components/ui/kpi-card';
import type { Tone } from '@/components/ui/tones';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import { loadYear, saveMonth, loadJournalYear, syncJournalYearFromDB, availableYears, yearSelectOptions, calcAnnualSummary, STORAGE_KEY as REPORTING_STORAGE_KEY } from '@/lib/reporting-store';
import type { SageJournalEntry } from '@/types/reporting';
import { lookupAccount, saveMappingCustom } from '@/lib/account-mapping-store';
import { AccountMapping } from '@/types/account-mapping';
import { computePLForMonth, computePLForYear, getDrilldown, PL_STRUCTURE, PLMonthOverrides, buildBudgetByRowForMonth, buildCogsBudgetSplitForMonth, buildPrevYearByRowForMonth } from '@/lib/pl-engine';
import { gruppiereWarenaufwandKonten, WARENAUFWAND_GRUPPE_LABEL, type WarenaufwandGruppe } from '@/lib/warenaufwand-gruppierung';
import { PLComputedRow, PLDrilldown, PLMonthResult } from '@/types/pl';
import { MONTH_NAMES_DE, MONTH_NAMES_SHORT_DE, MonthlyFinancialRecord } from '@/types/reporting';
import { loadBudgetWithPL, deletePLLineItem, addCustomPLLineItem, savePLLineItem, STORAGE_KEY as BUDGET_STORAGE_KEY } from '@/lib/budget-store';
import { BudgetYear, BudgetPLCategory, BudgetPLLineItem, BUDGET_MONTH_NAMES_FULL } from '@/types/budget';
import { useStichtag } from '@/contexts/StichtagContext';
import { StichtagBanner } from '@/components/StichtagBanner';
import { exportPLToPDF, PLExportOptions } from '@/lib/pl-export';
import { getBranding } from '@/lib/pl-branding';
import { PDFExportDialog } from '@/components/PDFExportDialog';
import { UnifiedExportButton } from '@/components/UnifiedExportButton';
import { toast } from 'sonner';
import { loadVjDailyYear } from '@/lib/vj-daily-supabase';
import type { VjDayRecord } from '@/lib/vj-daily-supabase';
import { computePriorYearDiagnostics } from '@/lib/pl-prior-year-diagnostics';
import {
  applyVjRevenueRule,
  applyCanonicalIstRule,
  type CanonicalRevenueByMonth,
} from '@/lib/effective-records';
// IST-Umsatz NETTO/BRUTTO des laufenden Zeitraums: kanonische Quelle (SSOT).
// gn_imports Tages-Z-Berichte via ladeUmsatzTage/summiereUmsatz — keine eigene
// grossToNet/1.081-Rechnung mehr. VJ + Budget + FIBU-Logik bleiben unberührt.
import { ladeUmsatzTage, summiereUmsatz, type UmsatzTag } from '@/lib/umsatz';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';
import {
  getMaisonEnabledSync, getMaisonMonthlySync,
  loadMaisonEnabled, loadMaisonMonthly,
  saveMaisonEnabled,
  getMaisonDailySync, loadMaisonDaily,
} from '@/lib/maison-store';
import { useMaison } from '@/contexts/MaisonContext';
import { kvGet } from '@/lib/supabase-kv';
import { MultiYearAnalysisSection } from '@/components/reporting/MultiYearAnalysisSection';
import { ManagementReportView } from '@/components/reporting/ManagementReportView';
import { BankInvestorView } from '@/components/reporting/BankInvestorView';
import { MULTI_YEAR_POSITIONS, type YearSeries } from '@/lib/multi-year-analysis';
import { BANK_ROW_IDS } from '@/lib/bank-investor-analysis';
import { loadAnnualCostImports, ANNUAL_COST_IMPORTS_KEY, type AnnualCostImportEntry } from '@/lib/annual-cost-imports-store';

/** Datenbasis-Hinweis für Mehrjahresanalyse + Management Report (gleiche Quelle). */
const MULTI_YEAR_DATA_SOURCE_HINT =
  'Kostenbasis sind die im Reporting erfassten Roh-Monatswerte (reporting_v1). Der IST-Umsatz stammt — wie in der Erfolgsrechnung — aus den Tages-Z-Berichten (umsatz.ts, netto); übrige Effekte (Maison-/Ausschluss) der Monats-/Jahresansicht sind hier nicht angewendet, Kostenwerte können daher abweichen.';

// ─── Kanonischer IST-Umsatz (umsatz.ts) ──────────────────────────────────────
// CanonicalMonthRevenue / CanonicalRevenueByMonth + applyCanonicalIstRule sind
// jetzt in src/lib/effective-records.ts (gemeinsame SSoT-Regel für ER + Reporting).

/** Aggregiert die kanonischen Umsatz-Tage einer Map auf Monate (1-basiert). */
function aggregateCanonicalByMonth(tage: Map<string, UmsatzTag>): CanonicalRevenueByMonth {
  const perMonth: Record<number, UmsatzTag[]> = {};
  for (const [datum, tag] of tage) {
    const m = parseInt(datum.slice(5, 7), 10);
    if (!m) continue;
    (perMonth[m] ??= []).push(tag);
  }
  const out: CanonicalRevenueByMonth = {};
  for (let m = 1; m <= 12; m++) {
    const list = perMonth[m] ?? [];
    if (list.length === 0) { out[m] = { net: 0, gross: 0, hasData: false }; continue; }
    const s = summiereUmsatz(list);
    out[m] = { net: s.netto, gross: s.bruttoGesamt, hasData: true };
  }
  return out;
}

// ─── Formatierungen ───────────────────────────────────────────────────────────

const fmt = (v: number | undefined, digits = 0): string => {
  if (v === undefined) return '—';
  return new Intl.NumberFormat('de-CH', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
};

const fmtPct = (v: number | undefined): string => {
  if (v === undefined) return '—';
  return `${v.toFixed(1)} %`;
};

const fmtCHF = (v: number | undefined): string => {
  if (v === undefined) return '—';
  return `CHF ${fmt(v)}`;
};

// ─── E006/E007: Registry-KPI-Leiste (Erfolgsrechnung) ────────────────────────
// Kennzahlen 1:1 aus der Financial-Metrics-Registry (SSoT, keine Doppelberechnung).
const PLVIEW_KPI_METRIC_IDS: FinancialMetricId[] = [
  'net_revenue', 'cogs_ratio', 'personnel_ratio', 'ebitda', 'ebit',
];

const fmtMetricValue = (v: number | null, unit: 'CHF' | '%'): string =>
  v === null ? '—' : unit === '%' ? `${v.toFixed(1)} %` : fmt(v);

/**
 * E007: kleiner Ampel-Punkt — Quoten über die bestehenden Ton-Helfer
 * (warenPctTone/personalPctTone, Rohwerte), Beträge über das Vorzeichen der
 * Budget-Abweichung (bestehende BPLVarCell-Logik); fehlend ⇒ neutral.
 */
const registryKpiTone = (id: FinancialMetricId, v: FinancialMetricValues, laborThreshold: number): Tone => {
  if (id === 'cogs_ratio')      return v.actual === null ? 'neutral' : warenPctTone(v.actual);
  if (id === 'personnel_ratio') return v.actual === null ? 'neutral' : personalPctTone(v.actual, laborThreshold);
  if (v.actual === null || v.budget === null) return 'neutral';
  return v.actual - v.budget >= 0 ? 'good' : 'critical';
};

/** Abweichung IST − Budget als Trend (Quote runter = grün; Beträge rauf = grün). */
const registryKpiTrend = (
  def: FinancialMetricDefinition,
  v: FinancialMetricValues,
): { direction: 'up' | 'down' | 'flat'; tone: Tone; label: string } | undefined => {
  if (v.actual === null || v.budget === null) return undefined;
  const d = v.actual - v.budget;
  const direction = d === 0 ? 'flat' as const : d > 0 ? 'up' as const : 'down' as const;
  const tone: Tone = d === 0 ? 'neutral' : def.kind === 'ratio' ? (d < 0 ? 'good' : 'critical') : (d > 0 ? 'good' : 'critical');
  const label = def.kind === 'ratio'
    ? `${d > 0 ? '+' : ''}${d.toFixed(1)} pp vs. Budget`
    : `${d > 0 ? '+' : ''}${fmt(d)} vs. Budget`;
  return { direction, tone, label };
};

// ─── Zeilenstile ─────────────────────────────────────────────────────────────

const ROW_STYLE: Record<string, string> = {
  section:     'bg-[#4F6F52] text-white dark:bg-[#3d5640]',
  subtotal:    'bg-slate-100 dark:bg-slate-800/60 font-semibold border-t border-b border-slate-300 dark:border-slate-600',
  result:      'bg-[#F7F0E3] dark:bg-slate-800/60 font-bold text-base border-t-2 border-[#4F6F52] dark:border-[#3d5640] text-gray-900 dark:text-gray-100',
  line:        'hover:bg-muted/30 cursor-pointer border-b border-slate-100 dark:border-slate-800',
  percent_line:'bg-transparent text-muted-foreground text-xs italic',
  spacer:      'h-2 bg-transparent',
};

// ─── Abweichungs-Anzeige ──────────────────────────────────────────────────────

const VarCell = ({ value, pct, inverted = false }: {
  value?: number; pct?: number; inverted?: boolean;
}) => {
  if (value === undefined) return <td className="px-2 py-1 text-right text-muted-foreground/50">—</td>;
  const positive = inverted ? value < 0 : value > 0;
  const neutral = Math.abs(value) < 0.5;
  return (
    <td className={cn(
      'px-2 py-1 text-right text-xs whitespace-nowrap',
      neutral ? 'text-muted-foreground' :
      positive ? 'text-emerald-600 dark:text-emerald-400' :
                 'text-red-600 dark:text-red-400',
    )}>
      <span className="flex items-center justify-end gap-0.5">
        {!neutral && (positive
          ? <ArrowUpRight className="h-3 w-3" />
          : <ArrowDownRight className="h-3 w-3" />
        )}
        {value > 0 ? '+' : ''}{fmt(value)}
        {pct !== undefined && (
          <span className="ml-1 opacity-70">({value > 0 ? '+' : ''}{fmtPct(pct)})</span>
        )}
      </span>
    </td>
  );
};

// ─── Monats-P&L-Zeile ─────────────────────────────────────────────────────────

const MonthRow = ({
  row, revenueActual, onClick,
}: {
  row: PLComputedRow;
  revenueActual: number | undefined;
  onClick: () => void;
}) => {
  const { def, values } = row;
  if (def.type === 'spacer') return <tr className="h-2"><td colSpan={8} /></tr>;
  if (def.type === 'section') {
    return (
      <tr className={ROW_STYLE.section}>
        <td colSpan={8} className="px-3 py-2 text-xs font-bold tracking-wider">
          {def.label}
        </td>
      </tr>
    );
  }

  const isClickable = def.type === 'line' || def.type === 'subtotal';
  const pctOfRevenue = revenueActual && values.actual !== undefined
    ? (values.actual / revenueActual) * 100 : undefined;
  // For expense rows, variance vs budget is inverted (less spend = good)
  const expenseInverted = def.valueRole === 'negative';

  return (
    <tr
      className={cn(ROW_STYLE[def.type] || ROW_STYLE.line, 'transition-colors')}
      onClick={isClickable ? onClick : undefined}
      title={isClickable ? 'Klicken für Details' : undefined}
    >
      {/* Label */}
      <td className={cn(
        'px-3 py-1.5 text-sm whitespace-nowrap',
        def.type === 'result' && 'py-2',
        def.indent === 1 && 'pl-7',
        def.indent === 2 && 'pl-11',
      )}>
        <span className="flex items-center gap-1">
          {def.label}
          {isClickable && def.type === 'line' && (
            <ChevronDown className="h-3 w-3 text-muted-foreground opacity-40" />
          )}
        </span>
      </td>
      {/* Ist (CHF) */}
      <td className={cn('px-2 py-1.5 text-right text-sm font-mono', def.type === 'result' && 'font-bold')}>
        {fmt(values.actual)}
      </td>
      {/* % Umsatz */}
      <td className={cn('px-2 py-1.5 text-right text-xs',
        def.type === 'result' ? 'text-gray-500' : 'text-muted-foreground',
      )}>
        {def.showPercent || def.type === 'result'
          ? fmtPct(pctOfRevenue)
          : ''}
      </td>
      {/* Budget */}
      <td className={cn('px-2 py-1.5 text-right text-sm font-mono',
        def.type === 'result' ? 'text-gray-700' : 'text-muted-foreground',
      )}>
        {fmt(values.budget)}
      </td>
      {/* Abw. Budget */}
      <VarCell value={values.vsBudget} pct={values.vsBudgetPct} inverted={expenseInverted} />
      {/* Vorjahr */}
      <td className={cn('px-2 py-1.5 text-right text-sm font-mono',
        def.type === 'result' ? 'text-gray-700' : 'text-muted-foreground',
      )}>
        {fmt(values.prevYear)}
      </td>
      {/* Abw. VJ */}
      <VarCell value={values.vsPrevYear} pct={values.vsPrevYearPct} inverted={expenseInverted} />
    </tr>
  );
};

// ─── Jahres-Zeile ─────────────────────────────────────────────────────────────

const NET_REV_ROW_IDX = PL_STRUCTURE.findIndex(r => r.id === 'net_revenue');

const YearRow = ({
  rows, rowIndex, onClickMonth, pctMode = 'off', revenueTotal = 0, excludeMonthIdx = -1,
}: {
  rows: PLComputedRow[][];  // rows[monthIndex][rowIndex]
  rowIndex: number;
  onClickMonth: (month: number) => void;
  pctMode?: 'off' | 'normal' | 'subtle';
  revenueTotal?: number;
  excludeMonthIdx?: number; // 0-basiert; -1 = kein Ausschluss
}) => {
  const def = PL_STRUCTURE[rowIndex];
  const showPct = pctMode !== 'off';
  // 1 label + 1 total + optional 1 pct-total + 12 months × (1 + optional 1 pct)
  const colCount = 2 + (showPct ? 1 : 0) + 12 * (showPct ? 2 : 1);
  if (!def) return null;
  if (def.type === 'spacer') return <tr className="h-2"><td colSpan={colCount} /></tr>;
  if (def.type === 'section') {
    return (
      <tr className={ROW_STYLE.section}>
        <td colSpan={colCount} className="px-3 py-2 text-xs font-bold tracking-wider sticky left-0 bg-[#4F6F52] dark:bg-[#3d5640]">
          {def.label}
        </td>
      </tr>
    );
  }

  // Total: laufenden Monat bei Bedarf ausschliessen
  const vals = rows
    .map((r, i) => (i === excludeMonthIdx ? undefined : r[rowIndex]?.values.actual))
    .filter((v): v is number => v !== undefined);
  const total = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : undefined;
  const pctStr = showPct && revenueTotal > 0 && total !== undefined && total !== 0
    ? `${(total / revenueTotal * 100).toFixed(1)}%`
    : null;

  const pctCls = cn(
    'px-1.5 py-1.5 text-right font-mono whitespace-nowrap tabular-nums',
    def.type === 'result' ? 'font-bold text-[10px]' : 'text-[10px]',
    pctMode === 'subtle' ? 'italic text-muted-foreground/40' : 'text-amber-600 dark:text-amber-400',
  );

  return (
    <tr className={cn(ROW_STYLE[def.type] || ROW_STYLE.line, 'group')}>
      {/* Label (sticky) */}
      <td className={cn(
        'sticky left-0 z-10 px-3 py-1.5 text-sm whitespace-nowrap bg-inherit min-w-[180px]',
        def.type === 'result' && 'font-bold py-2',
        def.indent === 1 && 'pl-7',
      )}>
        {def.label}
      </td>
      {/* Jahressumme */}
      <td className={cn(
        'px-2 py-1.5 text-right text-sm font-mono',
        def.type === 'result' ? 'font-bold' : 'font-semibold',
        !showPct && 'border-r-2 border-slate-300 dark:border-slate-600',
      )}>
        {total !== undefined ? fmt(total) : '—'}
      </td>
      {/* % vom Jahresumsatz (Total) */}
      {showPct && (
        <td className={cn(
          pctCls,
          'border-r-2 border-slate-300 dark:border-slate-600',
        )}>
          {pctStr ?? <span className="opacity-30">—</span>}
        </td>
      )}
      {/* Monatswerte + optionale % pro Monat */}
      {rows.map((monthRows, mIdx) => {
        const row = monthRows[rowIndex];
        const actual = row?.values.actual;
        const monthNetRev = showPct ? (monthRows[NET_REV_ROW_IDX]?.values.actual ?? 0) : 0;
        const monthPctStr = showPct && monthNetRev > 0 && actual !== undefined
          ? `${(actual / monthNetRev * 100).toFixed(1)}%`
          : null;
        return (
          <React.Fragment key={mIdx}>
            <td
              className={cn(
                'px-2 py-1.5 text-right text-sm font-mono whitespace-nowrap',
                def.type === 'line' && 'cursor-pointer hover:underline',
                def.type === 'result' && 'font-bold',
                actual !== undefined && def.valueRole === 'positive' && actual < 0 && 'text-red-600',
              )}
              onClick={def.type === 'line' ? () => onClickMonth(mIdx + 1) : undefined}
            >
              {actual !== undefined ? fmt(actual) : '—'}
            </td>
            {showPct && (
              <td className={pctCls}>
                {monthPctStr ?? <span className="opacity-30">—</span>}
              </td>
            )}
          </React.Fragment>
        );
      })}
    </tr>
  );
};

// ─── Drilldown-Dialog ─────────────────────────────────────────────────────────

const DrilldownDialog = ({
  drilldown,
  onClose,
}: {
  drilldown: PLDrilldown;
  onClose: () => void;
}) => (
  <Dialog open onOpenChange={() => onClose()}>
    <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-sm">
          <Database className="h-4 w-4 text-muted-foreground" />
          Quelldaten: {drilldown.rowLabel}
          {drilldown.month > 0 && (
            <span className="text-muted-foreground font-normal">
              – {MONTH_NAMES_DE[drilldown.month]} {drilldown.year}
            </span>
          )}
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-4 pt-2">
        {/* Zusammenfassung */}
        <div className="rounded-lg bg-muted/40 border border-border p-3 grid grid-cols-3 gap-2 text-xs">
          <div>
            <p className="text-muted-foreground mb-0.5">Ist (CHF)</p>
            <p className="font-bold text-base">{fmtCHF(drilldown.values.actual)}</p>
          </div>
          <div>
            <p className="text-muted-foreground mb-0.5">Budget (CHF)</p>
            <p className="font-semibold">{fmtCHF(drilldown.values.budget)}</p>
          </div>
          <div>
            <p className="text-muted-foreground mb-0.5">Vorjahr (CHF)</p>
            <p className="font-semibold">{fmtCHF(drilldown.values.prevYear)}</p>
          </div>
          {drilldown.values.vsBudget !== undefined && (() => {
            const isExpRow = PL_STRUCTURE.find(r => r.id === drilldown.rowId)?.valueRole === 'negative';
            const goodBudget = isExpRow ? drilldown.values.vsBudget < 0 : drilldown.values.vsBudget > 0;
            return (
              <div>
                <p className="text-muted-foreground mb-0.5">Abw. Budget</p>
                <p className={cn('font-semibold', goodBudget ? 'text-emerald-600' : 'text-red-600')}>
                  {drilldown.values.vsBudget > 0 ? '+' : ''}{fmtCHF(drilldown.values.vsBudget)}
                  {drilldown.values.vsBudgetPct !== undefined &&
                    ` (${drilldown.values.vsBudgetPct > 0 ? '+' : ''}${fmtPct(drilldown.values.vsBudgetPct)})`}
                </p>
              </div>
            );
          })()}
          {drilldown.values.vsPrevYear !== undefined && (() => {
            const isExpRow = PL_STRUCTURE.find(r => r.id === drilldown.rowId)?.valueRole === 'negative';
            const goodPY = isExpRow ? drilldown.values.vsPrevYear < 0 : drilldown.values.vsPrevYear > 0;
            return (
              <div>
                <p className="text-muted-foreground mb-0.5">Abw. Vorjahr</p>
                <p className={cn('font-semibold', goodPY ? 'text-emerald-600' : 'text-red-600')}>
                  {drilldown.values.vsPrevYear > 0 ? '+' : ''}{fmtCHF(drilldown.values.vsPrevYear)}
                </p>
              </div>
            );
          })()}
        </div>

        {/* Quelldaten */}
        <div>
          <h3 className="text-xs font-semibold mb-2 text-muted-foreground uppercase tracking-wider">
            Enthaltene Positionen
          </h3>

          {drilldown.sources.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              <AlertCircle className="h-4 w-4 mx-auto mb-2 opacity-50" />
              Noch keine Daten erfasst.
              <br />
              <span className="text-xs">Daten unter «Reporting» manuell eingeben
              oder später via CSV-Import laden.</span>
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Position</th>
                    <th className="text-right px-3 py-2 font-semibold text-muted-foreground">Ist (CHF)</th>
                    <th className="text-right px-3 py-2 font-semibold text-muted-foreground">Vorjahr (CHF)</th>
                    <th className="text-right px-3 py-2 font-semibold text-muted-foreground">Quelle</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {drilldown.sources.map((src, i) => (
                    <tr key={i} className="hover:bg-muted/20">
                      <td className="px-3 py-2">
                        <span className="font-medium">{src.label}</span>
                        <p className="text-[10px] text-muted-foreground/70">{src.categoryId}</p>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(src.actualAmount)}</td>
                      <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                        {src.prevYearAmount !== undefined ? fmt(src.prevYearAmount) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Badge variant="outline" className="text-[10px]">
                          {src.sourceType === 'direct_field' ? 'Direktfeld' :
                           src.sourceType === 'manual_entry' ? 'Manuell' : 'CSV-Import'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Hinweis: CSV-Import noch nicht implementiert */}
        <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20 p-3 flex items-start gap-2">
          <Info className="h-3.5 w-3.5 text-blue-600 mt-0.5 flex-shrink-0" />
          <p className="text-[11px] text-blue-700 dark:text-blue-300">
            Kontonummer-genaue Buchungsdaten werden nach dem CSV-Import aus dem
            Buchhaltungsprogramm hier sichtbar – mit exakter Kontonummer, Buchungstext und Betrag.
          </p>
        </div>
      </div>
    </DialogContent>
  </Dialog>
);

// ─── Monatsansicht ────────────────────────────────────────────────────────────

const MonthlyView = ({
  result,
  onDrilldown,
}: {
  result: PLMonthResult;
  onDrilldown: (rowId: string) => void;
}) => {
  const revenueRow = result.rows.find(r => r.def.id === 'net_revenue');
  const revenueActual = revenueRow?.values.actual;

  if (!result.hasData) {
    return (
      <div className="text-center py-16 text-muted-foreground space-y-3">
        <BarChart2 className="h-10 w-10 mx-auto opacity-30" />
        <p className="font-medium">Keine Daten für diesen Monat</p>
        <p className="text-sm">
          Erfassen Sie Monatsdaten unter{' '}
          <Link to="/reporting" className="text-primary underline">Reporting → Monatsdaten</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse min-w-[700px]">
        <thead>
          <tr className="bg-[#4F6F52] text-white text-xs">
            <th className="text-left px-3 py-2 min-w-[200px]">Position</th>
            <th className="text-right px-2 py-2">Ist (CHF)</th>
            <th className="text-right px-2 py-2">% Umsatz</th>
            <th className="text-right px-2 py-2">Budget (CHF)</th>
            <th className="text-right px-2 py-2">Abw. Budget</th>
            <th className="text-right px-2 py-2">Vorjahr (CHF)</th>
            <th className="text-right px-2 py-2">Abw. VJ</th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map(row => (
            <MonthRow
              key={row.def.id}
              row={row}
              revenueActual={revenueActual}
              onClick={() => onDrilldown(row.def.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ─── Jahresansicht ────────────────────────────────────────────────────────────

const YearView = ({
  results,
  onClickMonth,
  pctMode = 'off',
  revenueTotal = 0,
  excludeMonthIdx = -1,
}: {
  results: PLMonthResult[];
  onClickMonth: (month: number) => void;
  pctMode?: 'off' | 'normal' | 'subtle';
  revenueTotal?: number;
  excludeMonthIdx?: number; // 0-basiert; -1 = kein Ausschluss
}) => {
  const allRows = results.map(r => r.rows);
  const totalLabel = excludeMonthIdx >= 0
    ? `Jan–${MONTH_NAMES_SHORT_DE[excludeMonthIdx] ?? '?'} (ohne ${MONTH_NAMES_SHORT_DE[excludeMonthIdx + 1] ?? '?'})`
    : 'Total';

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse" style={{ minWidth: '1200px' }}>
        <thead>
          <tr className="bg-[#4F6F52] text-white text-xs">
            <th className="text-left px-3 py-2 sticky left-0 bg-[#4F6F52] z-10 min-w-[180px]">Position</th>
            <th className={cn(
              'text-right px-2 py-2 whitespace-nowrap font-bold bg-[#3d5640]',
              pctMode === 'off' && 'border-r-2 border-[#3d5640]',
            )}
              title={excludeMonthIdx >= 0 ? `Summe Jan–${MONTH_NAMES_DE[excludeMonthIdx] ?? '?'} (laufender Monat ausgeschlossen)` : 'Jahressumme aller Monate'}
            >
              {totalLabel}
            </th>
            {pctMode !== 'off' && (
              <th className={cn(
                'text-right px-2 py-2 whitespace-nowrap border-r-2 border-[#3d5640] bg-[#3d5640]',
                pctMode === 'subtle' ? 'opacity-50 italic text-[10px]' : 'text-[#d4e8c4]',
              )} title="% vom Jahres-Umsatz">
                % Ums.
              </th>
            )}
            {MONTH_NAMES_SHORT_DE.slice(1).map((m, i) => {
              const isExcluded = i === excludeMonthIdx;
              return (
                <React.Fragment key={i}>
                  <th
                    className={cn(
                      'text-right px-2 py-2 cursor-pointer whitespace-nowrap',
                      isExcluded
                        ? 'bg-slate-600/60 opacity-60 italic'
                        : 'hover:bg-[#3d5640]',
                    )}
                    onClick={() => onClickMonth(i + 1)}
                    title={isExcluded
                      ? `${MONTH_NAMES_DE[i + 1]} – laufender Monat (vom Total ausgeschlossen)`
                      : `Zu ${MONTH_NAMES_DE[i + 1]} wechseln`}
                  >
                    {m}{isExcluded ? ' *' : ''}
                  </th>
                  {pctMode !== 'off' && (
                    <th
                      className={cn(
                        'text-right px-1.5 py-2 whitespace-nowrap text-[10px]',
                        isExcluded ? 'opacity-40 italic' : '',
                        pctMode === 'subtle' ? 'opacity-50 italic' : 'text-[#d4e8c4]',
                      )}
                      title={`% Umsatz ${MONTH_NAMES_DE[i + 1]}`}
                    >
                      %
                    </th>
                  )}
                </React.Fragment>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {PL_STRUCTURE.map((_, rowIndex) => (
            <YearRow
              key={rowIndex}
              rows={allRows}
              rowIndex={rowIndex}
              onClickMonth={onClickMonth}
              pctMode={pctMode}
              revenueTotal={revenueTotal}
              excludeMonthIdx={excludeMonthIdx}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ─── Budget P&L Vergleich ─────────────────────────────────────────────────────

export interface BPLCell {
  isExpense: boolean;
  budget: number;
  actual: number;
  prevYear: number;
  vsBudget: number;
  vsBudgetPct?: number;
  vsPrevYear: number;
  vsPrevYearPct?: number;
}

export interface BPLRow {
  catId: string;
  catLabel: string;
  catType: 'items' | 'result';
  isExpense: boolean;
  isCategory: boolean;
  itemLabel?: string;
  itemAccountNumber?: string;
  itemId?: string;
  isInternal?: boolean;
  isTopDownable?: boolean;
  /** Zwischentotal-Zeile (z.B. Direkter/Übriger Warenaufwand) — nicht klickbar/editierbar */
  isGroupSubtotal?: boolean;
}

export interface BPLRowWithValues extends BPLRow {
  values: BPLCell;
}

// Kontoplan Oliv Gastro AG 2026 – Kategoriegrenzen für Ist-Zuweisung
const BPL_CAT_RANGES: Record<string, [number, number]> = {
  pl_revenue:         [3000, 3999],  // 3000-3990: Betriebsertrag
  pl_goods_cost:      [4000, 4899],  // 4020-4801: Warenaufwand
  pl_wages:           [5000, 5019],  // 5000-5010: Löhne inkl. Zulagen
  pl_social:          [5700, 5799],  // 5700-5740: AHV/BVG/UVG/KVG
  pl_personnel_other: [5800, 5899],  // 5810-5890: Übriger Personalaufwand
  pl_rent:            [6000, 6099],  // 6000-6050: Miete, Reinigung, Unterhalt Räume
  pl_maintenance:     [6100, 6199],  // 6100-6140: URE Maschinen/Mobiliar/EDV
  pl_vehicles:        [6200, 6299],  // 6200-6240: Fahrzeug Service/Benzin/Versicherung/Leasing
  pl_insurance:       [6300, 6399],  // 6310-6360: Haftpflicht, Abgaben, Gebühren
  pl_energy:          [6400, 6499],  // 6400: Strom, Gas, Heizöl, Wasser
  pl_admin:           [6500, 6599],  // 6500-6530: Büro, Telefon, Buchhaltung
  pl_marketing:       [6600, 6699],  // 6600-6640: Werbung, Kost&Logis, Geschenke
  pl_other_op:        [6700, 6899],  // 6790: Sonst. betr. Aufwand
  pl_finance:         [6900, 6999],  // 6940: Bankspesen
};

/**
 * Normalisiert eine Kontonummer für den Bereichsvergleich.
 * 5-stellige Konten (z.B. «61409») werden auf die ersten 4 Stellen
 * reduziert (→ 6140), damit sie korrekt in den 4-stelligen Bereich fallen.
 */
function normalizeAccountNum(categoryId: string): number {
  const s = categoryId.trim();
  if (s.length > 4) return parseInt(s.slice(0, 4));
  return parseInt(s);
}

function getCatActual(catId: string, rec: MonthlyFinancialRecord | undefined): number {
  if (!rec) return 0;
  if (catId === 'pl_revenue') {
    // Priorität 1: individuelle 3xxx-Konten aus expenseCategories (Sage-Import)
    const r = BPL_CAT_RANGES['pl_revenue']; // [3000, 3999]
    const fromExpCat = (rec.expenseCategories ?? [])
      .filter(c => { const n = normalizeAccountNum(c.categoryId ?? ''); return !isNaN(n) && n >= r[0] && n <= r[1]; })
      .reduce((s, c) => s + (c.amount ?? 0), 0);
    if (fromExpCat !== 0) return fromExpCat;
    // Priorität 2: revenueActual Direktfeld (manuelle Eingabe / Gastronovi)
    return rec.revenueActual ?? (rec as any).revenue ?? 0;
  }
  const r = BPL_CAT_RANGES[catId];
  if (!r) return 0;
  return (rec.expenseCategories ?? [])
    .filter(c => { const n = normalizeAccountNum(c.categoryId ?? ''); return !isNaN(n) && n >= r[0] && n <= r[1]; })
    .reduce((s, c) => s + (c.amount ?? 0), 0);
}

function getCatPY(
  catId: string,
  rec: MonthlyFinancialRecord | undefined,
  prevRec?: MonthlyFinancialRecord,
): number {
  // Manuelle Eingabe hat immer höchste Priorität (überschreibt Vorjahres-Ist)
  if (rec && catId === 'pl_revenue') {
    const manual = (rec as any).revenuePreviousYear as number | undefined;
    if (manual && manual !== 0) return manual;
  }

  // Automatisch: Ist-Daten aus dem Vorjahresdatensatz (z.B. 2025-Actual)
  if (prevRec) {
    if (catId === 'pl_revenue') {
      const fromActual = prevRec.revenueActual ?? 0;
      if (fromActual !== 0) return fromActual;
    }
    const r = BPL_CAT_RANGES[catId];
    if (r) {
      const fromActual = (prevRec.expenseCategories ?? [])
        .filter(c => { const n = normalizeAccountNum(c.categoryId ?? ''); return !isNaN(n) && n >= r[0] && n <= r[1]; })
        .reduce((s, c) => s + (c.amount ?? 0), 0);
      if (fromActual !== 0) return fromActual;
    }
  }
  // Fallback: PreviousYear-Felder im aktuellen Datensatz (manuell als "Vorjahr" importiert)
  if (!rec) return 0;
  if (catId === 'pl_revenue') return (rec as any).revenuePreviousYear ?? 0;
  const r = BPL_CAT_RANGES[catId];
  if (!r) return 0;
  return (rec.expenseCategoriesPreviousYear ?? [])
    .filter(c => { const n = normalizeAccountNum(c.categoryId ?? ''); return !isNaN(n) && n >= r[0] && n <= r[1]; })
    .reduce((s, c) => s + (c.amount ?? 0), 0);
}

function makeCell(actual: number, budget: number, prevYear: number, isExpense: boolean): BPLCell {
  const vsBudget   = actual - budget;
  const vsPrevYear = actual - prevYear;
  return {
    isExpense, actual, budget, prevYear,
    vsBudget,
    vsBudgetPct:   budget    !== 0 ? (vsBudget   / Math.abs(budget))    * 100 : undefined,
    vsPrevYear,
    vsPrevYearPct: prevYear  !== 0 ? (vsPrevYear / Math.abs(prevYear))  * 100 : undefined,
  };
}

// Mappt account-mapping-store plCategory → BPL-Kategorie (Kontoplan 2026)
const PL_CAT_TO_BPL: Partial<Record<string, string>> = {
  // Ertrag
  revenue_food:      'pl_revenue',
  revenue_beverage:  'pl_revenue',
  revenue_catering:  'pl_revenue',
  revenue_other:     'pl_revenue',
  // Warenaufwand
  cogs_food:         'pl_goods_cost',
  cogs_beverage:     'pl_goods_cost',
  cogs_other:        'pl_goods_cost',
  // Personal
  personnel_kitchen: 'pl_wages',
  personnel_service: 'pl_wages',
  personnel_admin:   'pl_wages',
  personnel_social:  'pl_social',
  personnel_other:   'pl_personnel_other',
  // Raumaufwand (6000–6099: Miete, Reinigung, Unterhalt Räume)
  rent:              'pl_rent',
  cleaning:          'pl_rent',
  // URE (6100–6199)
  maintenance:       'pl_maintenance',
  // Fahrzeugaufwand (6200–6299)
  vehicle_costs:     'pl_vehicles',
  // Sachversicherungen / Abgaben (6300–6399)
  insurance:         'pl_insurance',
  // Energie (6400–6499)
  utilities:         'pl_energy',
  // Verwaltung (6500–6599)
  admin_costs:       'pl_admin',
  office:            'pl_admin',
  // Werbung (6600–6699)
  marketing:         'pl_marketing',
  // Übriger Betriebsaufwand (6700–6899)
  other_operating:   'pl_other_op',
  depreciation:      'pl_other_op',
  // Finanzaufwand (6900–6999)
  bank_fees:         'pl_finance',
};

// Export nur für Tests (Warenaufwand-Gruppierung in der klassischen Ansicht)
export function computeBPLRows(
  budget: BudgetYear,
  rec: MonthlyFinancialRecord | undefined,
  mIdx: number,
  prevRec?: MonthlyFinancialRecord,
): BPLRowWithValues[] {
  const cats  = (budget.plCategories ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
  const items = budget.plLineItems ?? [];
  const rows: BPLRowWithValues[] = [];

  const budgetItemAccounts = new Set(items.map(i => i.accountNumber).filter(Boolean) as string[]);

  const actualByCat: Record<string, Array<{ accountNum: string; amount: number; label: string }>> = {};
  for (const ec of (rec?.expenseCategories ?? [])) {
    if (!ec.categoryId || ec.amount === undefined || ec.amount === 0) continue;
    const result = lookupAccount(ec.categoryId);
    const bplCatId = result.mapping ? PL_CAT_TO_BPL[result.mapping.plCategory] : undefined;
    if (!bplCatId) continue;
    if (!actualByCat[bplCatId]) actualByCat[bplCatId] = [];
    actualByCat[bplCatId].push({
      accountNum: ec.categoryId,
      amount:     ec.amount,
      label:      ec.label ?? result.mapping?.accountName ?? ec.categoryId,
    });
  }

  const catB: Record<string, number> = {};
  const catA: Record<string, number> = {};
  const catP: Record<string, number> = {};

  for (const cat of cats) {
    if (cat.type === 'items') {
      // Interne und ausgeblendete Positionen werden aus den Kategorie-Summen ausgeschlossen
      const its = items.filter(i => i.categoryId === cat.id && !i.isInternal && !i.isHidden);
      catB[cat.id] = its.reduce((s, i) => s + (i.monthlyValues[mIdx] ?? 0), 0);
      catA[cat.id] = getCatActual(cat.id, rec);
      catP[cat.id] = getCatPY(cat.id, rec, prevRec);
      // Manuell eingegebene Ist-Werte für Positionen ohne Sage-Buchungen zum Kategorie-Total addieren
      for (const item of its) {
        const manualVal = item.manualIstValues?.[mIdx] ?? 0;
        if (!manualVal) continue;
        const hasSage = (rec?.expenseCategories ?? []).some(
          c => c.categoryId === item.accountNumber && (c.amount ?? 0) !== 0,
        );
        if (!hasSage) catA[cat.id] = (catA[cat.id] ?? 0) + manualVal;
      }
    }
  }
  for (const cat of cats) {
    if (cat.type === 'result' && cat.resultFormula) {
      catB[cat.id] = cat.resultFormula.reduce((s, f) => s + f.sign * (catB[f.categoryId] ?? 0), 0);
      catA[cat.id] = cat.resultFormula.reduce((s, f) => s + f.sign * (catA[f.categoryId] ?? 0), 0);
      catP[cat.id] = cat.resultFormula.reduce((s, f) => s + f.sign * (catP[f.categoryId] ?? 0), 0);
    }
  }

  for (const cat of cats) {
    if (cat.type === 'items') {
      rows.push({
        catId: cat.id, catLabel: cat.label, catType: 'items',
        isExpense: cat.isExpense, isCategory: true,
        values: makeCell(catA[cat.id] ?? 0, catB[cat.id] ?? 0, catP[cat.id] ?? 0, cat.isExpense),
      });

      // Ob die Kategorie individuelle 3xxx-Konten in expenseCategories hat (Sage-Import)
      // Falls nicht → Gastronovi-revenueActual auf das primäre Konto (3000) mappen
      const catHas3xxxActual = cat.id === 'pl_revenue' && (rec?.expenseCategories ?? []).some(c => {
        const n = normalizeAccountNum(c.categoryId ?? '');
        return !isNaN(n) && n >= 3000 && n <= 3999;
      });
      const catHas3xxxPY = cat.id === 'pl_revenue' && (
        (prevRec?.expenseCategories ?? []).some(c => { const n = normalizeAccountNum(c.categoryId ?? ''); return !isNaN(n) && n >= 3000 && n <= 3999; }) ||
        (rec?.expenseCategoriesPreviousYear ?? []).some(c => { const n = normalizeAccountNum(c.categoryId ?? ''); return !isNaN(n) && n >= 3000 && n <= 3999; })
      );

      // Mitglieder-Zeilen werden zuerst gesammelt: beim Warenaufwand werden sie
      // anschliessend nach numerischer Range (4000–4070 / 4071–4900) gruppiert
      // und mit Zwischentotalen ausgegeben; sonst unverändert angehängt.
      const memberRows: BPLRowWithValues[] = [];

      const its = items.filter(i => i.categoryId === cat.id && !i.isHidden).sort((a, b) => a.sortOrder - b.sortOrder);
      for (const item of its) {
        if (item.accountNumber) {
          const acc = lookupAccount(item.accountNumber);
          if (acc.mapping?.isActive === false) continue;
        }
        const iB = item.monthlyValues[mIdx] ?? 0;
        const iA_ec = (rec?.expenseCategories ?? []).find(c => c.categoryId === item.accountNumber)?.amount ?? 0;
        const manualIst = item.manualIstValues?.[mIdx] ?? 0;
        const iP_ec =
          (prevRec?.expenseCategories ?? []).find(c => c.categoryId === item.accountNumber)?.amount
          ?? (rec?.expenseCategoriesPreviousYear ?? []).find(c => c.categoryId === item.accountNumber)?.amount
          ?? 0;

        // Gastronovi-Fallback: revenueActual / revenuePreviousYear auf primäres Konto 3000 mappen
        // wenn keine Sage 3xxx-Einträge vorhanden sind
        const isPrimaryRevenueItem = cat.id === 'pl_revenue' && item.accountNumber === '3000';
        const iA = isPrimaryRevenueItem && !catHas3xxxActual && iA_ec === 0
          ? (catA[cat.id] ?? 0)
          : (iA_ec !== 0 ? iA_ec : manualIst);
        const iP = isPrimaryRevenueItem && !catHas3xxxPY && iP_ec === 0
          ? (catP[cat.id] ?? 0)
          : iP_ec;

        // Zeige immer: intern (INTERN-Badge), explizit eingeblendet (isForceVisible), oder user-added (isDefault=false).
        // Verstecke nur Default-Items die in allen drei Spalten 0 haben (kein Sage-Wert, kein Budget, kein VJ).
        const alwaysShow = item.isInternal || item.isForceVisible || item.isDefault === false;
        if (!alwaysShow && iA === 0 && iB === 0 && iP === 0) continue;
        memberRows.push({
          catId: cat.id, catLabel: cat.label, catType: 'items',
          isExpense: cat.isExpense, isCategory: false,
          itemId: item.id, itemLabel: item.label, itemAccountNumber: item.accountNumber,
          isInternal: item.isInternal,
          values: makeCell(iA, iB, iP, cat.isExpense),
        });
      }

      const actualRows = (actualByCat[cat.id] ?? [])
        .filter(a => {
          if (budgetItemAccounts.has(a.accountNum)) return false;
          const acc = lookupAccount(a.accountNum);
          if (acc.mapping?.isActive === false) return false;
          return true;
        })
        .sort((a, b) => parseInt(a.accountNum) - parseInt(b.accountNum));
      for (const ar of actualRows) {
        const iP =
          (prevRec?.expenseCategories ?? []).find(c => c.categoryId === ar.accountNum)?.amount
          ?? (rec?.expenseCategoriesPreviousYear ?? []).find(c => c.categoryId === ar.accountNum)?.amount
          ?? 0;
        if (ar.amount === 0 && iP === 0) continue;
        memberRows.push({
          catId: cat.id, catLabel: cat.label, catType: 'items',
          isExpense: cat.isExpense, isCategory: false,
          itemId: `actual_${ar.accountNum}`, itemLabel: ar.label, itemAccountNumber: ar.accountNum,
          values: makeCell(ar.amount, 0, iP, cat.isExpense),
        });
      }

      if (cat.id === 'pl_goods_cost' && memberRows.length > 0) {
        // Warenaufwand: Zeilen nach numerischer Range gruppieren (SSoT
        // warenaufwand-gruppierung). Konten ohne Range-Zuordnung fallen auf
        // die Kontenzuordnungs-Gruppe zurück (kein stilles Ummappen).
        const grouped = gruppiereWarenaufwandKonten(memberRows, r => r.itemAccountNumber);
        const direct = [...grouped.direct];
        const uebrig = [...grouped.uebrig];
        for (const r of grouped.unzugeordnet) {
          const plCat = r.itemAccountNumber ? lookupAccount(r.itemAccountNumber).mapping?.plCategory : undefined;
          if (plCat === 'cogs_food' || plCat === 'cogs_beverage') direct.push(r);
          else uebrig.push(r);
        }
        const pushGroup = (groupRows: BPLRowWithValues[], gruppe: WarenaufwandGruppe) => {
          // Leere Gruppe → Block UND Zwischentotal weglassen (fehlend ≠ 0)
          if (groupRows.length === 0) return;
          rows.push(...groupRows);
          // Interne Positionen zählen (wie beim Kategorie-Total) nicht mit
          const rel = groupRows.filter(r => !r.isInternal);
          rows.push({
            catId: cat.id, catLabel: cat.label, catType: 'items',
            isExpense: cat.isExpense, isCategory: false, isGroupSubtotal: true,
            itemId: `subtotal_${gruppe}`,
            itemLabel: WARENAUFWAND_GRUPPE_LABEL[gruppe],
            values: makeCell(
              rel.reduce((s, r) => s + r.values.actual, 0),
              rel.reduce((s, r) => s + r.values.budget, 0),
              rel.reduce((s, r) => s + r.values.prevYear, 0),
              cat.isExpense,
            ),
          });
        };
        pushGroup(direct, 'direct');
        pushGroup(uebrig, 'uebrig');
      } else {
        rows.push(...memberRows);
      }
    } else if (cat.type === 'result') {
      const isTopDownable = (cat.resultFormula ?? []).some(
        f => cats.find(c => c.id === f.categoryId)?.type === 'items'
      );
      rows.push({
        catId: cat.id, catLabel: cat.label, catType: 'result',
        isExpense: cat.isExpense, isCategory: true, isTopDownable,
        values: makeCell(catA[cat.id] ?? 0, catB[cat.id] ?? 0, catP[cat.id] ?? 0, cat.isExpense),
      });
    }
  }
  return rows;
}

const BPLVarCell = ({ value, pct, isExpense = false }: { value: number; pct?: number; isExpense?: boolean }) => {
  const isGood  = isExpense ? value < 0 : value > 0;
  const neutral = Math.abs(value) < 0.5;
  return (
    <td className={cn(
      'px-2 py-1 text-right text-xs whitespace-nowrap tabular-nums',
      neutral  ? 'text-muted-foreground' :
      isGood   ? 'text-emerald-600 dark:text-emerald-400 font-semibold' :
                 'text-red-600 dark:text-red-400 font-semibold',
    )}>
      <span className="flex items-center justify-end gap-0.5">
        {!neutral && (isGood
          ? <ArrowUpRight className="h-3 w-3" />
          : <ArrowDownRight className="h-3 w-3" />
        )}
        {value > 0 ? '+' : ''}{fmt(value)}
        {pct !== undefined && (
          <span className="ml-0.5 opacity-70">
            ({value > 0 ? '+' : ''}{fmtPct(pct)})
          </span>
        )}
      </span>
    </td>
  );
};

// ─── Inline Ist-Zellen-Editor ─────────────────────────────────────────────────

const InlineIstCell = ({
  value, row, month, year, onSaved, onCancel,
}: {
  value: number;
  row: BPLRowWithValues;
  month: number;
  year: number;
  onSaved: () => void;
  onCancel: () => void;
}) => {
  const { tenantKey } = useTenant();
  const [input, setInput] = useState(value !== 0 ? String(value) : '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);

  const save = () => {
    const raw = input.trim().replace(/^CHF\s*/i, '').replace(/['\s]/g, '').replace(',', '.');
    const num = parseFloat(raw);
    if (isNaN(num)) { onCancel(); return; }

    const storeKey = tenantKey(REPORTING_STORAGE_KEY);
    const account  = row.itemAccountNumber;
    try {
      // Lohnaufwand-Kategorie → personnelCostActual
      if (row.catId === 'pl_wages' && row.isCategory) {
        saveMonth({ year, month, personnelCostActual: num }, 'manual_entry', 'update', { note: 'Manuelle Eingabe' }, storeKey);
      // Alle Item-Zeilen mit Kontonummer (inkl. Betriebsertrag-Konten) → expenseCategories
      } else if (!row.isCategory && account) {
        const existing = loadYear(year, storeKey)[month - 1];
        const cats = (existing?.expenseCategories ?? []).filter(c => c.categoryId !== account);
        cats.push({ categoryId: account, amount: num, label: row.itemLabel ?? account });
        saveMonth({ year, month, expenseCategories: cats }, 'manual_entry', 'update', { note: `Manuelle Eingabe Konto ${account}` }, storeKey);
      // Betriebsertrag-Kategorie ohne einzelne Konten → revenueActual
      } else if (row.catId === 'pl_revenue' && row.isCategory) {
        saveMonth({ year, month, revenueActual: num }, 'manual_entry', 'update', { note: 'Manuelle Eingabe Umsatz' }, storeKey);
      } else {
        onCancel();
        return;
      }
    } catch (err) {
      console.error('[InlineIstCell] Speicherfehler:', err);
      onCancel();
      return;
    }
    onSaved();
  };

  return (
    <div className="flex items-center justify-end" onClick={e => e.stopPropagation()}>
      <input
        ref={ref}
        className="w-24 h-6 text-right font-mono text-xs border border-primary rounded px-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={save}
      />
    </div>
  );
};

// Quartals-Bereichslabels für Periodenwahl & Titel (E003)
const QUARTER_RANGE_LABELS = ['Jan–Mär', 'Apr–Jun', 'Jul–Sep', 'Okt–Dez'] as const;

// ─── Inline Ist-Umsatz Schnelleingabe (für PLView-Banner) ─────────────────────
const InlineRevenueEntry = ({
  year, month, onSaved,
}: { year: number; month: number; onSaved: () => void }) => {
  const { tenantKey } = useTenant();
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  const handleSave = () => {
    const raw = input.replace(/['\s]/g, '').replace(',', '.');
    const num = parseFloat(raw);
    if (isNaN(num) || num <= 0) return;
    setSaving(true);
    try {
      saveMonth({ year, month, revenueActual: num }, 'manual_entry', 'update', { note: 'Schnelleingabe Ist-Umsatz' }, tenantKey(REPORTING_STORAGE_KEY));
      toast.success(`Ist-Umsatz ${MONTH_NAMES_DE[month]} ${year} gespeichert`);
      onSaved();
      setInput('');
    } catch (err) {
      console.error('[InlineRevenueEntry] Speicherfehler:', err);
      toast.error('Konnte Wert nicht speichern');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-orange-200 bg-orange-50 dark:bg-orange-950/20 p-4 flex items-center gap-3 flex-wrap">
      <AlertCircle className="h-4 w-4 text-orange-600 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-orange-800 dark:text-orange-300">
          Kein Ist-Umsatz für {MONTH_NAMES_DE[month]} {year} erfasst
        </p>
        <p className="text-[11px] text-orange-700 dark:text-orange-400 mt-0.5">
          Der Umsatz ist nicht im Sage Kontoblatt enthalten — bitte direkt hier oder unter Reporting erfassen.
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <input
          ref={ref}
          type="text"
          placeholder="Umsatz CHF"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
          className="w-32 h-8 text-right font-mono text-xs border border-orange-300 rounded px-2 bg-white dark:bg-orange-950/30 focus:outline-none focus:ring-2 focus:ring-orange-400"
        />
        <Button
          size="sm"
          className="h-8 text-xs bg-orange-600 hover:bg-orange-700 text-white"
          onClick={handleSave}
          disabled={saving || !input.trim()}
        >
          Speichern
        </Button>
      </div>
    </div>
  );
};

const BPLRowComp = ({ row, onClick, compact, onDelete, month, year, onSaved, highlightVariance, pctMode: pctModeProp = 'off', revenueActual = 0, revenueBudget = 0, revenuePrevYear = 0, compareMode = 'all', isCollapsed, onToggleCollapse, onBudgetEdit, readOnly = false, isMobile = false }: {
  row: BPLRowWithValues;
  onClick: () => void;
  compact: boolean;
  onDelete?: (itemId: string) => void;
  month: number;
  year: number;
  onSaved: () => void;
  highlightVariance?: boolean;
  pctMode?: 'off' | 'normal' | 'subtle';
  revenueActual?: number;
  revenueBudget?: number;
  revenuePrevYear?: number;
  compareMode?: 'all' | 'ist_budget' | 'ist_vorjahr' | 'monat_vs_monat';
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  onBudgetEdit?: (catId: string, monthIdx: number, budgetVal: number) => void;
  /** Quartal-/Jahres-Aggregat: KEINE Inline-Bearbeitung (Saves sind monatsgebunden). */
  readOnly?: boolean;
  /** E009: mobil reduzierte Spalten (zentrale reine Logik, keine Zweitberechnung). */
  isMobile?: boolean;
}) => {
  const [editingIst, setEditingIst] = useState(false);
  const { values: v } = row;
  const py = compact ? 'py-1' : 'py-2';
  const pyResult = compact ? 'py-1' : 'py-2.5';
  const pyItem = compact ? 'py-0.5' : 'py-1.5';
  const { showBudget, showPrevYear, pctMode } = getBPLColumnVisibility(compareMode, pctModeProp, isMobile);

  const pctVal = (actual: number) =>
    revenueActual > 0 && actual !== 0
      ? `${(actual / revenueActual * 100).toFixed(1)}%`
      : null;
  const pctValBudget = (budget: number) =>
    revenueBudget > 0 && budget !== 0
      ? `${(budget / revenueBudget * 100).toFixed(1)}%`
      : null;
  const pctValPY = (prevYear: number) =>
    revenuePrevYear > 0 && prevYear !== 0
      ? `${(prevYear / revenuePrevYear * 100).toFixed(1)}%`
      : null;
  const pctNormalClass = 'px-2 text-right font-mono tabular-nums text-xs text-amber-700 dark:text-amber-400';
  const pctSubtleClass  = 'px-2 text-right font-mono tabular-nums text-[10px] italic text-muted-foreground/50';
  const pctClass = pctMode === 'subtle' ? pctSubtleClass : pctNormalClass;
  const pctBudClass = pctMode === 'subtle'
    ? 'px-2 text-right font-mono tabular-nums text-[10px] italic text-muted-foreground/50'
    : 'px-2 text-right font-mono tabular-nums text-xs text-slate-400 dark:text-slate-400';
  const pctPYClass = pctMode === 'subtle'
    ? 'px-2 text-right font-mono tabular-nums text-[10px] italic text-muted-foreground/50'
    : 'px-2 text-right font-mono tabular-nums text-xs text-slate-400 dark:text-slate-400';

  if (row.catType === 'result') {
    const isPos = v.actual >= 0;
    const p = pctVal(v.actual);
    return (
      <tr
        className="bg-[#F7F0E3] dark:bg-slate-800/80 font-bold border-t-2 border-b border-[#4F6F52] dark:border-[#3d5640] cursor-pointer hover:bg-[#efe5cf] dark:hover:bg-slate-700/80 transition-colors"
        onClick={onClick}
        title={`${row.catLabel} – Zusammensetzung anzeigen`}
      >
        <td className={cn('px-3 text-sm text-gray-900 dark:text-gray-100 sticky left-0 z-10 bg-[#F7F0E3] dark:bg-slate-800', pyResult)} colSpan={2}>{row.catLabel}</td>
        <td className={cn('px-2 text-right text-sm font-mono tabular-nums font-bold', pyResult,
          isPos ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'
        )}>{fmt(v.actual)}</td>
        {pctMode !== 'off' && (
          <td className={cn('px-2 text-right font-mono tabular-nums text-xs text-gray-500 dark:text-gray-400 font-bold', pyResult)}>
            {p ?? <span className="opacity-30">—</span>}
          </td>
        )}
        {showBudget && (
          <td
            className={cn(
              'px-2 text-right text-sm font-mono tabular-nums text-gray-700 dark:text-gray-300', pyResult,
              onBudgetEdit && row.isTopDownable
                ? 'cursor-pointer hover:bg-amber-50 dark:hover:bg-amber-900/20 hover:ring-1 hover:ring-inset hover:ring-amber-300 dark:hover:ring-amber-600 transition-colors group'
                : '',
            )}
            onClick={onBudgetEdit && row.isTopDownable ? e => { e.stopPropagation(); onBudgetEdit(row.catId, month - 1, v.budget); } : undefined}
            title={onBudgetEdit && row.isTopDownable ? `Budget ${row.catLabel} anpassen (Top-Down)` : undefined}
          >
            <span className="flex items-center justify-end gap-1">
              {fmt(v.budget)}
              {onBudgetEdit && row.isTopDownable && <Pencil className="h-2.5 w-2.5 opacity-0 group-hover:opacity-50 shrink-0 transition-opacity" />}
            </span>
          </td>
        )}
        {showBudget && pctMode !== 'off' && <td className={cn('px-2 text-right font-mono tabular-nums text-xs text-gray-500 dark:text-gray-400 font-bold', pyResult)}>{pctValBudget(v.budget) ?? <span className="opacity-30">—</span>}</td>}
        {showBudget && <BPLVarCell value={v.vsBudget} pct={v.vsBudgetPct} isExpense={row.isExpense} />}
        {showPrevYear && <td className={cn('px-2 text-right text-sm font-mono tabular-nums text-gray-700 dark:text-gray-300', pyResult)}>{fmt(v.prevYear)}</td>}
        {showPrevYear && pctMode !== 'off' && <td className={cn('px-2 text-right font-mono tabular-nums text-xs text-gray-500 dark:text-gray-400 font-bold', pyResult)}>{pctValPY(v.prevYear) ?? <span className="opacity-30">—</span>}</td>}
        {showPrevYear && <BPLVarCell value={v.vsPrevYear} pct={v.vsPrevYearPct} isExpense={row.isExpense} />}
      </tr>
    );
  }

  if (row.isCategory) {
    const p = pctVal(v.actual);
    return (
      <tr
        className="bg-[#4F6F52] text-white dark:bg-[#3d5640] cursor-pointer hover:bg-[#3d5640] transition-colors select-none"
        onClick={onClick}
      >
        <td className={cn('px-3 text-xs font-bold tracking-wider sticky left-0 z-10 bg-[#4F6F52] dark:bg-[#3d5640]', py)} colSpan={2}>
          <span className="inline-flex items-center gap-1.5">
            <span
              onClick={e => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={isCollapsed ? `${row.catLabel} – ausklappen` : `${row.catLabel} – einklappen`}
              className="hover:opacity-100 opacity-60 transition-opacity cursor-pointer p-0.5 -m-0.5 rounded"
            >
              {isCollapsed
                ? <ChevronRight className="h-3 w-3 shrink-0" />
                : <ChevronDown  className="h-3 w-3 shrink-0" />
              }
            </span>
            {row.catLabel}
          </span>
        </td>
        <td className={cn('px-2 text-right text-sm font-mono tabular-nums', py)}>{fmt(v.actual)}</td>
        {pctMode !== 'off' && (
          <td className={cn(
            py,
            pctMode === 'subtle'
              ? 'px-2 text-right font-mono tabular-nums text-[10px] italic text-white/40'
              : 'px-2 text-right font-mono tabular-nums text-xs text-[#d4e8c4] font-bold',
          )}>
            {p ?? <span className="opacity-30">—</span>}
          </td>
        )}
        {showBudget && <td className={cn('px-2 text-right text-sm font-mono tabular-nums opacity-75', py)}>{fmt(v.budget)}</td>}
        {showBudget && pctMode !== 'off' && <td className={cn(py, pctMode === 'subtle' ? 'px-2 text-right font-mono tabular-nums text-[10px] italic text-white/30' : 'px-2 text-right font-mono tabular-nums text-xs text-[#c8d9b8] font-bold')}>{pctValBudget(v.budget) ?? <span className="opacity-30">—</span>}</td>}
        {showBudget && <BPLVarCell value={v.vsBudget} pct={v.vsBudgetPct} isExpense={row.isExpense} />}
        {showPrevYear && <td className={cn('px-2 text-right text-sm font-mono tabular-nums opacity-65', py)}>{fmt(v.prevYear)}</td>}
        {showPrevYear && pctMode !== 'off' && <td className={cn(py, pctMode === 'subtle' ? 'px-2 text-right font-mono tabular-nums text-[10px] italic text-white/30' : 'px-2 text-right font-mono tabular-nums text-xs text-[#c8d9b8] font-bold')}>{pctValPY(v.prevYear) ?? <span className="opacity-30">—</span>}</td>}
        {showPrevYear && <BPLVarCell value={v.vsPrevYear} pct={v.vsPrevYearPct} isExpense={row.isExpense} />}
      </tr>
    );
  }

  if (row.isGroupSubtotal) {
    // Zwischentotal (Direkter/Übriger Warenaufwand) — reine Anzeigezeile
    const p = pctVal(v.actual);
    return (
      <tr className="bg-muted/60 dark:bg-slate-800/60 border-t border-b border-slate-200 dark:border-slate-700 font-semibold" data-testid={`bpl-${row.itemId}`}>
        <td className={cn('px-3 pl-6 text-xs text-gray-700 dark:text-gray-300 uppercase tracking-wide sticky left-0 z-10 bg-slate-100 dark:bg-slate-800', pyItem)} colSpan={2}>
          {row.itemLabel}
        </td>
        <td className={cn('px-2 text-right text-sm font-mono tabular-nums font-semibold', pyItem)}>{fmt(v.actual)}</td>
        {pctMode !== 'off' && (
          <td className={cn(pctClass, pyItem)}>{p ?? <span className="opacity-30">—</span>}</td>
        )}
        {showBudget && <td className={cn('px-2 text-right text-sm font-mono tabular-nums text-gray-600 dark:text-gray-400', pyItem)}>{fmt(v.budget)}</td>}
        {showBudget && pctMode !== 'off' && <td className={cn(pctBudClass, pyItem)}>{pctValBudget(v.budget) ?? <span className="opacity-30">—</span>}</td>}
        {showBudget && <BPLVarCell value={v.vsBudget} pct={v.vsBudgetPct} isExpense={row.isExpense} />}
        {showPrevYear && <td className={cn('px-2 text-right text-sm font-mono tabular-nums text-gray-600 dark:text-gray-400', pyItem)}>{fmt(v.prevYear)}</td>}
        {showPrevYear && pctMode !== 'off' && <td className={cn(pctPYClass, pyItem)}>{pctValPY(v.prevYear) ?? <span className="opacity-30">—</span>}</td>}
        {showPrevYear && <BPLVarCell value={v.vsPrevYear} pct={v.vsPrevYearPct} isExpense={row.isExpense} />}
      </tr>
    );
  }

  const isBudgetItem = row.itemId && !row.itemId.startsWith('actual_');
  const canEdit = !row.isCategory && !readOnly;

  const varPct = v.vsBudgetPct;
  const isVarianceHighlighted =
    highlightVariance &&
    v.budget !== undefined && v.budget !== 0 &&
    v.actual !== undefined && v.actual !== 0 &&
    varPct !== undefined &&
    Math.abs(varPct) > 10;
  const varBgClass = isVarianceHighlighted
    ? varPct! < 0
      ? 'bg-red-50 dark:bg-red-950/20 border-l-4 border-l-red-400'
      : 'bg-green-50 dark:bg-green-950/20 border-l-4 border-l-green-400'
    : '';
  // Sticky erste Spalte braucht einen OPAKEN Hintergrund (replit.md §3)
  const stickyItemBg = isVarianceHighlighted
    ? (varPct! < 0 ? 'bg-red-50 dark:bg-red-950' : 'bg-green-50 dark:bg-green-950')
    : row.isInternal ? 'bg-violet-50 dark:bg-violet-950' : 'bg-card';

  return (
    <tr
      className={cn(
        'hover:bg-muted/30 border-b border-slate-100 dark:border-slate-800 transition-colors group',
        row.isInternal && !isVarianceHighlighted && 'opacity-75 bg-violet-50/40 dark:bg-violet-950/10',
        varBgClass,
      )}
    >
      <td className={cn('px-3 pl-9 text-sm cursor-pointer sticky left-0 z-10', stickyItemBg, pyItem)} onClick={onClick}>
        <span className="text-[10px] text-muted-foreground/50 font-mono mr-1.5">{row.itemAccountNumber}</span>
        {row.itemLabel}
        {row.isInternal && (
          <span className="ml-1.5 inline-flex items-center rounded px-1 py-0.5 text-[9px] font-semibold bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300 border border-violet-200 dark:border-violet-700">
            INTERN
          </span>
        )}
      </td>
      <td className={cn('px-2 w-5', pyItem)}>
        {isBudgetItem && onDelete ? (
          <button
            onClick={e => { e.stopPropagation(); onDelete(row.itemId!); }}
            title="Zeile löschen"
            className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-red-500 transition-opacity"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground opacity-30 cursor-pointer" onClick={onClick} />
        )}
      </td>
      {/* Ist-Zelle: inline editierbar beim Klick */}
      <td
        className={cn('px-2 text-right text-sm font-mono tabular-nums', pyItem,
          canEdit ? 'cursor-pointer hover:bg-primary/10 rounded transition-colors' : 'cursor-pointer',
        )}
        onClick={e => { if (canEdit && !editingIst) { e.stopPropagation(); setEditingIst(true); } else onClick(); }}
        title={canEdit ? 'Klicken zum direkten Bearbeiten' : undefined}
      >
        {editingIst && canEdit ? (
          <InlineIstCell
            value={v.actual}
            row={row}
            month={month}
            year={year}
            onSaved={() => { setEditingIst(false); onSaved(); }}
            onCancel={() => setEditingIst(false)}
          />
        ) : (
          v.actual !== 0 ? fmt(v.actual) : <span className="text-muted-foreground/40">—</span>
        )}
      </td>
      {pctMode !== 'off' && (
        <td className={cn(pctClass, pyItem)}>
          {pctVal(v.actual) ?? <span className="opacity-25">—</span>}
        </td>
      )}
      {showBudget && <td className={cn('px-2 text-right text-sm font-mono tabular-nums text-muted-foreground cursor-pointer', pyItem)} onClick={onClick}>{v.budget !== 0 ? fmt(v.budget) : <span className="opacity-40">—</span>}</td>}
      {showBudget && pctMode !== 'off' && <td className={cn(pctBudClass, pyItem)}>{pctValBudget(v.budget) ?? <span className="opacity-25">—</span>}</td>}
      {showBudget && <BPLVarCell value={v.vsBudget} pct={v.vsBudgetPct} />}
      {showPrevYear && <td className={cn('px-2 text-right text-sm font-mono tabular-nums text-muted-foreground cursor-pointer', pyItem)} onClick={onClick}>{v.prevYear !== 0 ? fmt(v.prevYear) : <span className="opacity-40">—</span>}</td>}
      {showPrevYear && pctMode !== 'off' && <td className={cn(pctPYClass, pyItem)}>{pctValPY(v.prevYear) ?? <span className="opacity-25">—</span>}</td>}
      {showPrevYear && <BPLVarCell value={v.vsPrevYear} pct={v.vsPrevYearPct} />}
    </tr>
  );
};

const BudgetPLView = ({
  rows,
  onRowClick,
  onDeleteItem,
  compact,
  month,
  year,
  onSaved,
  highlightVariance,
  pctMode: pctModeProp = 'off',
  revenueActual = 0,
  revenueBudget = 0,
  revenuePrevYear = 0,
  compareMode = 'all',
  pctIsBudgetBased = false,
  maisonEnabled = false,
  maisonNet = 0,
  prevYearLabel = 'Vorjahr',
  onBudgetEdit,
  readOnly = false,
  isMobile = false,
}: {
  rows: BPLRowWithValues[];
  onRowClick: (row: BPLRowWithValues) => void;
  onDeleteItem?: (itemId: string) => void;
  compact: boolean;
  month: number;
  year: number;
  onSaved: () => void;
  highlightVariance?: boolean;
  pctMode?: 'off' | 'normal' | 'subtle';
  revenueActual?: number;
  revenueBudget?: number;
  revenuePrevYear?: number;
  compareMode?: 'all' | 'ist_budget' | 'ist_vorjahr' | 'monat_vs_monat';
  pctIsBudgetBased?: boolean;
  maisonEnabled?: boolean;
  maisonNet?: number;
  prevYearLabel?: string;
  onBudgetEdit?: (catId: string, monthIdx: number, budgetVal: number) => void;
  /** Quartal-/Jahres-Aggregat: strikt read-only (Saves sind monatsgebunden). */
  readOnly?: boolean;
  /** E009: mobil reduzierte Tabelle (zentrale reine Spalten-Logik). */
  isMobile?: boolean;
}) => {
  const { showBudget, showPrevYear, pctMode } = getBPLColumnVisibility(compareMode, pctModeProp, isMobile);
  // Sticky Tabellenkopf: jede th-Zelle braucht einen eigenen OPAKEN Hintergrund
  const thSticky = 'sticky top-0 z-20 bg-[#4F6F52]';
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());

  function toggleCat(catId: string) {
    setCollapsedCats(prev => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }

  return (
  <div className="overflow-auto max-h-[70vh]" data-testid="bpl-table-scroll">
    <table className="w-full text-sm border-collapse md:min-w-[600px]">
      <thead>
        <tr className="bg-[#4F6F52] text-white text-xs">
          <th className={cn('text-left px-3 min-w-[140px] md:min-w-[230px]', thSticky, 'left-0 z-30', compact ? 'py-1.5' : 'py-2.5')}>Position</th>
          <th className={cn('w-5', thSticky, compact ? 'py-1.5' : 'py-2.5')} />
          <th className={cn('text-right px-2 min-w-[100px]', thSticky, compact ? 'py-1.5' : 'py-2.5')} title={readOnly ? 'Summe der Monatswerte (nur Lesen)' : 'Klick auf Ist-Wert = direkt bearbeiten'}>{readOnly ? 'Ist (CHF)' : 'Ist (CHF) ✎'}</th>
          {pctMode !== 'off' && (
            <th className={cn('text-right px-2 min-w-[60px]', thSticky, compact ? 'py-1.5' : 'py-2.5',
              pctMode === 'subtle' ? 'opacity-50 italic text-[10px]' : 'text-[#d4e8c4]',
            )} title={pctIsBudgetBased ? '% vom Budget-Umsatz (kein Ist-Umsatz erfasst)' : '% vom Ist-Umsatz'}>
              {pctIsBudgetBased ? '% Bud.' : '% Ums.'}
            </th>
          )}
          {showBudget && <th className={cn('text-right px-2 min-w-[100px]', thSticky, compact ? 'py-1.5' : 'py-2.5')}>Budget (CHF)</th>}
          {showBudget && pctMode !== 'off' && <th className={cn('text-right px-2 min-w-[55px]', thSticky, compact ? 'py-1.5' : 'py-2.5', 'text-[#c8d9b8]')} title="% vom Budget-Umsatz">% Bud.</th>}
          {showBudget && <th className={cn('text-right px-2 min-w-[130px]', thSticky, compact ? 'py-1.5' : 'py-2.5')}>Abw. Budget</th>}
          {showPrevYear && <th className={cn('text-right px-2 min-w-[100px]', thSticky, compact ? 'py-1.5' : 'py-2.5')}>{prevYearLabel} (CHF)</th>}
          {showPrevYear && pctMode !== 'off' && <th className={cn('text-right px-2 min-w-[55px]', thSticky, compact ? 'py-1.5' : 'py-2.5', 'text-[#c8d9b8]')} title={`% vom ${prevYearLabel}-Umsatz`}>% {prevYearLabel.length > 6 ? 'Vgl.' : prevYearLabel}</th>}
          {showPrevYear && <th className={cn('text-right px-2 min-w-[120px]', thSticky, compact ? 'py-1.5' : 'py-2.5')}>Abw. {prevYearLabel.length > 6 ? 'Vgl.' : prevYearLabel}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          // Zeilen unterhalb einer eingeklappten Kategorie ausblenden.
          // result-Zeilen (Bruttogewinn, etc.) und andere Kategorie-Header immer zeigen.
          const isHiddenByCollapse =
            !row.isCategory && row.catType !== 'result' && collapsedCats.has(row.catId);
          if (isHiddenByCollapse) return null;

          const isLastRevItem =
            row.catId === 'pl_revenue' && !row.isCategory && row.catType !== 'result' &&
            (i === rows.length - 1 || rows[i + 1]?.catId !== 'pl_revenue');

          return (
            <React.Fragment key={`${row.catId}-${row.itemId ?? 'cat'}-${i}`}>
              <BPLRowComp
                row={row}
                onClick={() => onRowClick(row)}
                compact={compact}
                onDelete={readOnly ? undefined : onDeleteItem}
                month={month}
                year={year}
                onSaved={onSaved}
                highlightVariance={highlightVariance}
                pctMode={pctMode}
                revenueActual={revenueActual}
                revenueBudget={revenueBudget}
                revenuePrevYear={revenuePrevYear}
                compareMode={compareMode}
                isCollapsed={row.isCategory ? collapsedCats.has(row.catId) : undefined}
                onToggleCollapse={row.isCategory ? () => toggleCat(row.catId) : undefined}
                onBudgetEdit={readOnly ? undefined : onBudgetEdit}
                readOnly={readOnly}
                isMobile={isMobile}
              />
              {isLastRevItem && maisonEnabled && maisonNet > 0 && (
                <tr className="bg-violet-50/70 dark:bg-violet-950/20 border-b border-violet-100 dark:border-violet-900/50">
                  <td className={cn('pl-8 pr-2 text-xs text-violet-700 dark:text-violet-400 font-medium sticky left-0 z-10 bg-violet-50 dark:bg-violet-950', compact ? 'py-0.5' : 'py-1')}>
                    <span className="flex items-center gap-1.5">
                      <span className="text-violet-400 text-[10px]">↳</span>
                      Marketing
                    </span>
                  </td>
                  <td className={compact ? 'py-0.5' : 'py-1'} />
                  <td className={cn('px-2 text-right text-xs font-mono tabular-nums text-violet-700 dark:text-violet-400 font-semibold', compact ? 'py-0.5' : 'py-1')}>
                    {fmt(maisonNet)}
                  </td>
                  {pctMode !== 'off' && <td />}
                  {showBudget && <td />}
                  {showBudget && pctMode !== 'off' && <td />}
                  {showBudget && <td />}
                  {showPrevYear && <td />}
                  {showPrevYear && pctMode !== 'off' && <td />}
                  {showPrevYear && <td />}
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  </div>
  );
};

const BudgetPLDrilldownDialog = ({
  row,
  month,
  year,
  onClose,
  onSaved,
  composition,
}: {
  row: BPLRowWithValues;
  month: number;
  year: number;
  onClose: () => void;
  onSaved: () => void;
  /** E005: Zusammensetzung einer Ergebniszeile — dieselben Tabellenzeilen, reine Anzeige. */
  composition?: BPLRowWithValues[];
}) => {
  const { tenantKey } = useTenant();
  const label   = row.itemLabel ?? row.catLabel;
  const account = row.itemAccountNumber;
  const v       = row.values;

  const [istInput,  setIstInput]  = useState(v.actual   !== 0 ? String(v.actual)   : '');
  const [saved,     setSaved]     = useState(false);
  const [istError,  setIstError]  = useState<string | null>(null);
  const [vjInput,   setVjInput]   = useState(v.prevYear !== 0 ? String(v.prevYear) : '');
  const [vjSaved,   setVjSaved]   = useState(false);
  const [vjError,   setVjError]   = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const canEdit        = row.catType !== 'result';
  const canEditVorjahr = row.catId === 'pl_revenue';

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const parseInput = (raw: string): number | null => {
    const cleaned = raw.trim().replace(/^CHF\s*/i, '').replace(/['\s]/g, '').replace(',', '.');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  };

  const handleSave = () => {
    const num = parseInput(istInput);
    if (num === null) { setIstError('Bitte eine gültige Zahl eingeben (z.B. 267920 oder 267\'920).'); return; }
    setIstError(null);

    const storeKey = tenantKey(REPORTING_STORAGE_KEY);
    try {
      // Lohnaufwand-Kategorie → personnelCostActual
      if (row.catId === 'pl_wages' && row.isCategory) {
        saveMonth({ year, month, personnelCostActual: num }, 'manual_entry', 'update', { note: 'Manuelle Eingabe' }, storeKey);
      // Alle Item-Zeilen mit Kontonummer (inkl. Betriebsertrag-Konten) → expenseCategories
      } else if (!row.isCategory && account) {
        const existing = loadYear(year, storeKey)[month - 1];
        const cats = (existing?.expenseCategories ?? []).filter(c => c.categoryId !== account);
        cats.push({ categoryId: account, amount: num, label: row.itemLabel ?? label });
        saveMonth({ year, month, expenseCategories: cats }, 'manual_entry', 'update', { note: `Manuelle Eingabe Konto ${account}` }, storeKey);
      // Betriebsertrag-Kategorie (kein einzelnes Konto) → revenueActual
      } else if (row.catId === 'pl_revenue' && row.isCategory) {
        saveMonth({ year, month, revenueActual: num }, 'manual_entry', 'update', { note: 'Manuelle Eingabe Umsatz' }, storeKey);
      } else {
        return;
      }
      toast.success(`Ist-Wert gespeichert (${MONTH_NAMES_DE[month]} ${year})`);
      setSaved(true);
      setTimeout(() => { onSaved(); }, 600);
    } catch (err) {
      console.error('[BPLDrilldown] Speicherfehler Ist-Wert:', err);
      setIstError('Konnte Ist-Wert nicht speichern. Details in der Konsole.');
      toast.error('Konnte Ist-Wert nicht speichern');
    }
  };

  const handleSaveVorjahr = () => {
    const num = parseInput(vjInput);
    if (num === null) { setVjError('Bitte eine gültige Zahl eingeben (z.B. 296018 oder 296\'018).'); return; }
    setVjError(null);

    const storeKey = tenantKey(REPORTING_STORAGE_KEY);
    try {
      saveMonth({ year, month, revenuePreviousYear: num }, 'manual_entry', 'update', { note: 'Manuelle Eingabe Vorjahr-Umsatz' }, storeKey);
      toast.success(`Vorjahreswert gespeichert (${MONTH_NAMES_DE[month]} ${year - 1})`);
      setVjSaved(true);
      setTimeout(() => { onSaved(); }, 600);
    } catch (err) {
      console.error('[BPLDrilldown] Speicherfehler Vorjahr-Wert:', err);
      setVjError('Konnte Vorjahreswert nicht speichern. Details in der Konsole.');
      toast.error('Konnte Vorjahreswert nicht speichern');
    }
  };

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Database className="h-4 w-4 text-muted-foreground" />
            {label}
            <span className="text-muted-foreground font-normal text-xs">
              – {MONTH_NAMES_DE[month]} {year}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {account && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Kontonummer:</span>
              <span className="font-mono font-bold text-foreground bg-muted px-1.5 py-0.5 rounded">{account}</span>
            </div>
          )}

          {/* Manuelle Ist-Eingabe */}
          {canEdit && (
            <div className="rounded-lg border-2 border-primary/30 bg-primary/5 p-3 space-y-2">
              <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Pencil className="h-3.5 w-3.5 text-primary" />
                Ist-Wert manuell eingeben
              </p>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-mono">CHF</span>
                  <Input
                    ref={inputRef}
                    className="pl-10 font-mono text-right text-base h-9"
                    placeholder="0"
                    value={istInput}
                    onChange={e => { setIstInput(e.target.value); setSaved(false); }}
                    onKeyDown={e => e.key === 'Enter' && handleSave()}
                  />
                </div>
                <Button
                  size="sm"
                  className="h-9 px-4"
                  onClick={handleSave}
                  disabled={saved}
                  variant={saved ? 'outline' : 'default'}
                >
                  {saved ? (
                    <><Check className="h-3.5 w-3.5 mr-1 text-emerald-600" /> Gespeichert</>
                  ) : (
                    'Speichern'
                  )}
                </Button>
              </div>
              {istError && (
                <p className="text-xs text-red-600 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3 flex-shrink-0" />{istError}
                </p>
              )}
              {row.isCategory && row.catId !== 'pl_revenue' && row.catId !== 'pl_wages' && (
                <p className="text-[10px] text-amber-600">
                  Hinweis: Kategorie-Summen werden aus Einzelkonten berechnet. Bitte die Unterkonten einzeln eingeben.
                </p>
              )}
            </div>
          )}

          {/* Manuelle Vorjahr-Eingabe (nur für Umsatz) */}
          {canEditVorjahr && (
            <div className="rounded-lg border-2 border-slate-200 bg-slate-50 dark:bg-slate-800/40 p-3 space-y-2">
              <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Pencil className="h-3.5 w-3.5 text-slate-500" />
                Vorjahr-Umsatz manuell eingeben
                <span className="font-normal text-muted-foreground ml-1">({MONTH_NAMES_DE[month]} {year - 1})</span>
              </p>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-mono">CHF</span>
                  <Input
                    className="pl-10 font-mono text-right text-base h-9"
                    placeholder="0"
                    value={vjInput}
                    onChange={e => { setVjInput(e.target.value); setVjSaved(false); }}
                    onKeyDown={e => e.key === 'Enter' && handleSaveVorjahr()}
                  />
                </div>
                <Button
                  size="sm"
                  className="h-9 px-4"
                  onClick={handleSaveVorjahr}
                  disabled={vjSaved}
                  variant={vjSaved ? 'outline' : 'secondary'}
                >
                  {vjSaved ? (
                    <><Check className="h-3.5 w-3.5 mr-1 text-emerald-600" /> Gespeichert</>
                  ) : (
                    'Speichern'
                  )}
                </Button>
              </div>
              {vjError && (
                <p className="text-xs text-red-600 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3 flex-shrink-0" />{vjError}
                </p>
              )}
              <p className="text-[10px] text-muted-foreground">
                Dieser Wert erscheint in der Vorjahr-Spalte und im Dashboard-Vergleich.
              </p>
            </div>
          )}

          {/* E005: Zusammensetzung der Ergebniszeile (reine Anzeige, Summen stimmen sichtbar ab) */}
          {row.catType === 'result' && composition && composition.length > 0 && (
            <div className="rounded-lg border border-border overflow-hidden" data-testid="bpl-drilldown-composition">
              <p className="text-xs font-semibold bg-muted/60 px-3 py-2 border-b border-border">Zusammensetzung</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border/60">
                    <th className="px-3 py-1 text-left font-medium">Position</th>
                    <th className="px-2 py-1 text-right font-medium">Ist</th>
                    <th className="px-2 py-1 text-right font-medium">Budget</th>
                    <th className="px-3 py-1 text-right font-medium">Vorjahr</th>
                  </tr>
                </thead>
                <tbody>
                  {composition.map((c, i) => (
                    <tr key={`${c.catId}-${i}`} className={cn('border-b border-border/40', c.catType === 'result' && 'font-semibold bg-muted/30')}>
                      <td className="px-3 py-1.5">
                        {c.isExpense && <span className="mr-1 text-muted-foreground">−</span>}
                        {c.catLabel}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmt(c.values.actual)}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{fmt(c.values.budget)}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{fmt(c.values.prevYear)}</td>
                    </tr>
                  ))}
                  <tr className="font-bold border-t-2 border-foreground/30">
                    <td className="px-3 py-1.5">= {label}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmt(v.actual)}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{fmt(v.budget)}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{fmt(v.prevYear)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* Zusammenfassung */}
          <div className="rounded-lg bg-muted/40 border border-border p-3 grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-muted-foreground mb-0.5">Ist (CHF)</p>
              <p className="font-bold text-lg">{fmtCHF(v.actual)}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5">Budget (CHF)</p>
              <p className="font-semibold text-base">{fmtCHF(v.budget)}</p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5">Abw. Budget (CHF / %)</p>
              <p className={cn('font-semibold',
                (row.isExpense ? v.vsBudget < 0 : v.vsBudget >= 0) ? 'text-emerald-600' : 'text-red-600'
              )}>
                {v.vsBudget >= 0 ? '+' : ''}{fmtCHF(v.vsBudget)}
                {v.vsBudgetPct !== undefined && (
                  <span className="ml-1 text-xs opacity-80">
                    ({v.vsBudgetPct >= 0 ? '+' : ''}{fmtPct(v.vsBudgetPct)})
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground mb-0.5">Vorjahr (CHF)</p>
              <p className="font-semibold text-base">{fmtCHF(v.prevYear)}</p>
            </div>
            <div className="col-span-2">
              <p className="text-muted-foreground mb-0.5">Abw. Vorjahr (CHF / %)</p>
              <p className={cn('font-semibold',
                (row.isExpense ? v.vsPrevYear < 0 : v.vsPrevYear >= 0) ? 'text-emerald-600' : 'text-red-600'
              )}>
                {v.vsPrevYear >= 0 ? '+' : ''}{fmtCHF(v.vsPrevYear)}
                {v.vsPrevYearPct !== undefined && (
                  <span className="ml-1 text-xs opacity-80">
                    ({v.vsPrevYearPct >= 0 ? '+' : ''}{fmtPct(v.vsPrevYearPct)})
                  </span>
                )}
              </p>
            </div>
          </div>

          {/* Varianz-Erklärung */}
          <div className="text-xs text-muted-foreground space-y-1 border-t border-border pt-3">
            <p className="font-semibold text-foreground mb-1">Wie werden die Abweichungen berechnet?</p>
            {row.isExpense ? (
              <p>Bei Aufwand-Positionen: <strong>Abw. = Ist − Budget</strong>.
                Ein negativer Wert (grün) bedeutet: weniger ausgegeben als budgetiert = gut.
                Positiv (rot) = Budgetüberschreitung.</p>
            ) : (
              <p>Bei Ertrags-Positionen: <strong>Abw. = Ist − Budget</strong>.
                Ein positiver Wert (grün) bedeutet: mehr eingenommen als geplant = gut.
                Negativ (rot) = unter Plan.</p>
            )}
          </div>

          {/* Quellenhinweis */}
          <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20 p-3 flex items-start gap-2">
            <Info className="h-3.5 w-3.5 text-blue-600 mt-0.5 flex-shrink-0" />
            <p className="text-[11px] text-blue-700 dark:text-blue-300">
              {v.actual > 0 && account
                ? `Ist-Wert aus Buchhaltungs-Import, Kontonummer ${account}.`
                : v.actual > 0
                ? 'Ist-Wert aus manueller Reporting-Erfassung.'
                : 'Noch kein Ist-Wert für diesen Monat – bitte Daten importieren oder manuell erfassen.'}
              {v.budget > 0
                ? ` Budget stammt aus der Budget-Planung für ${MONTH_NAMES_DE[month]} ${year}.`
                : ' Kein Budget für diesen Monat hinterlegt.'}
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ─── Konto-Schnellaktionen Dialog ─────────────────────────────────────────────

const AccountActionDialog = ({
  row,
  year,
  month,
  onClose,
  onRefresh,
  onOpenDrilldown,
}: {
  row: BPLRowWithValues;
  year: number;
  month: number;
  onClose: () => void;
  onRefresh: () => void;
  onOpenDrilldown: () => void;
}) => {
  const { tenantId, tenantKey } = useTenant();
  const accountNum = row.itemAccountNumber ?? '';
  const result     = lookupAccount(accountNum);
  const mapping    = result.mapping;
  const isActive   = mapping?.isActive !== false;
  const isBudgetItem = !!(row.itemId && !row.itemId.startsWith('actual_'));

  const mIdx = month - 1;

  // Manuellen Ist-Wert aus dem Budget-Item lesen
  const budgetItem = useMemo<BudgetPLLineItem | undefined>(() => {
    if (!isBudgetItem || !row.itemId) return undefined;
    const bd = loadBudgetWithPL(year, tenantKey(BUDGET_STORAGE_KEY));
    return bd.plLineItems?.find(i => i.id === row.itemId);
  }, [isBudgetItem, row.itemId, year, tenantKey]);

  const currentManualIst = budgetItem?.manualIstValues?.[mIdx] ?? 0;
  const [manualIstInput, setManualIstInput] = useState(() =>
    currentManualIst !== 0 ? String(currentManualIst) : '',
  );
  const [isSavingIst, setIsSavingIst] = useState(false);

  useEffect(() => {
    setManualIstInput(currentManualIst !== 0 ? String(currentManualIst) : '');
  }, [currentManualIst]);

  const handleSaveManualIst = () => {
    if (!budgetItem) return;
    const val = parseFloat(manualIstInput.replace(',', '.'));
    if (isNaN(val)) return;
    setIsSavingIst(true);
    try {
      const newManualIst = [...(budgetItem.manualIstValues ?? Array(12).fill(0))];
      newManualIst[mIdx] = val;
      savePLLineItem(year, { ...budgetItem, manualIstValues: newManualIst }, tenantKey(BUDGET_STORAGE_KEY));
      toast.success(`Manueller Ist-Wert für ${MONTH_NAMES_DE[mIdx]} gespeichert`);
      onRefresh();
      onClose();
    } finally {
      setIsSavingIst(false);
    }
  };

  const handleClearManualIst = () => {
    if (!budgetItem) return;
    const newManualIst = [...(budgetItem.manualIstValues ?? Array(12).fill(0))];
    newManualIst[mIdx] = 0;
    savePLLineItem(year, { ...budgetItem, manualIstValues: newManualIst }, tenantKey(BUDGET_STORAGE_KEY));
    toast.success(`Manueller Ist-Wert für ${MONTH_NAMES_DE[mIdx]} gelöscht`);
    onRefresh();
    onClose();
  };

  // Buchungszeilen für dieses Konto laden
  const bookings = useMemo<SageJournalEntry[]>(() => {
    if (!accountNum) return [];
    const all = loadJournalYear(year, tenantId);
    return all.filter(e => e.accountNumber === accountNum.padStart(4, '0'));
  }, [accountNum, year, tenantId]);

  const handleToggleActive = () => {
    if (mapping) {
      saveMappingCustom({ ...mapping, isActive: !isActive, source: 'custom' });
    } else {
      saveMappingCustom({
        accountNumber: accountNum,
        accountName:   row.itemLabel ?? accountNum,
        plCategory:    'cogs_other',
        plSection:     'cogs',
        department:    'general',
        sign:          'expense',
        source:        'custom',
        isActive:      false,
        canOverride:   true,
      } as AccountMapping);
    }
    onRefresh();
    onClose();
  };

  const handleDelete = () => {
    if (isBudgetItem && row.itemId) {
      deletePLLineItem(year, row.itemId, tenantKey(BUDGET_STORAGE_KEY));
    }
    onRefresh();
    onClose();
  };

  const totalBookings = bookings.reduce((s, e) => s + e.amount, 0);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono text-muted-foreground text-sm">{accountNum}</span>
            <span className="text-base">{row.itemLabel}</span>
          </DialogTitle>
          <DialogDescription>
            Buchungen und Konto-Aktionen für {year}
          </DialogDescription>
        </DialogHeader>

        {/* Buchungszeilen */}
        <div className="flex-1 overflow-auto min-h-0">
          {bookings.length > 0 ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-foreground">
                  Einzelbuchungen ({bookings.length})
                </p>
                <span className="text-xs text-muted-foreground font-mono">
                  Total: {fmtCHF(totalBookings)}
                </span>
              </div>
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/60 border-b border-border">
                      <th className="text-left px-2 py-1.5 font-medium text-muted-foreground w-24">Datum</th>
                      <th className="text-left px-2 py-1.5 font-medium text-muted-foreground w-20">Beleg</th>
                      <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Buchungstext</th>
                      <th className="text-right px-2 py-1.5 font-medium text-muted-foreground w-24">Betrag CHF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookings.map((entry, idx) => (
                      <tr
                        key={idx}
                        className={cn(
                          'border-b border-border last:border-0',
                          idx % 2 === 0 ? 'bg-background' : 'bg-muted/20',
                        )}
                      >
                        <td className="px-2 py-1.5 font-mono text-muted-foreground">{entry.date}</td>
                        <td className="px-2 py-1.5 font-mono text-muted-foreground">{entry.belegNr ?? '—'}</td>
                        <td className="px-2 py-1.5">{entry.text}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                          {fmtCHF(entry.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/40 border-t-2 border-border">
                      <td colSpan={3} className="px-2 py-1.5 font-semibold text-xs">Total</td>
                      <td className="px-2 py-1.5 text-right font-semibold font-mono tabular-nums">
                        {fmtCHF(totalBookings)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-border bg-muted/30 px-4 py-5 space-y-3">
              <div className="flex flex-col items-center text-center mb-1">
                <Database className="h-7 w-7 text-muted-foreground/40 mb-2" />
                <p className="text-sm text-foreground font-semibold">Keine Buchungszeilen vorhanden</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Einzelbuchungen sind nur nach einem Excel-Import des Sage-Kontoblatts verfügbar.
                </p>
              </div>
              <div className="rounded border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300 space-y-1.5">
                <p className="font-semibold">So werden Buchungszeilen aktiviert:</p>
                <ol className="list-decimal list-inside space-y-1 text-amber-700 dark:text-amber-400">
                  <li>In <strong>Sage</strong>: Konto <span className="font-mono">{accountNum}</span> aufrufen → <em>Kontoblatt</em> als <strong>Excel (.xlsx)</strong> exportieren</li>
                  <li>Im <Link to="/csv-import" className="underline font-medium" onClick={onClose}>Buchh.-Import</Link>: Datei hochladen, Format «Excel (Sage Kontoblatt)» wählen</li>
                  <li>Nach dem Import erscheinen hier die Einzelbuchungen</li>
                </ol>
                <p className="text-amber-600 dark:text-amber-500 mt-1">
                  <strong>Hinweis:</strong> Ein normaler CSV-Summarien-Export enthält nur Kontototale, keine Einzelbuchungen.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Manueller Ist-Wert */}
        {isBudgetItem && budgetItem && (
          <div className="border-t border-border pt-3 space-y-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              Manueller Ist-Wert — {MONTH_NAMES_DE[mIdx]} {year}
            </p>
            {bookings.length > 0 ? (
              <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 rounded px-2 py-1.5 border border-amber-200 dark:border-amber-800">
                Sage-Buchungen vorhanden — manueller Wert wird ignoriert solange Sage-Daten vorliegen.
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="0.01"
                className="h-8 text-sm w-36 font-mono"
                value={manualIstInput}
                onChange={e => setManualIstInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveManualIst(); }}
                placeholder="0.00"
              />
              <span className="text-xs text-muted-foreground">CHF</span>
              <Button
                size="sm"
                className="h-8 text-xs gap-1"
                onClick={handleSaveManualIst}
                disabled={isSavingIst || !manualIstInput.trim()}
              >
                <Check className="h-3 w-3" />
                {isSavingIst ? 'Speichern…' : 'Speichern'}
              </Button>
              {currentManualIst !== 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs text-red-600 hover:text-red-700 gap-1"
                  onClick={handleClearManualIst}
                >
                  <X className="h-3 w-3" /> Löschen
                </Button>
              )}
            </div>
            {currentManualIst !== 0 && bookings.length === 0 && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                Gespeicherter Wert: {fmtCHF(currentManualIst)} — wird als Ist-Wert verwendet.
              </p>
            )}
          </div>
        )}

        {/* Trennlinie + Konto-Aktionen */}
        <div className="border-t border-border pt-3 space-y-1.5">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Aktionen</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className={cn('gap-1.5 text-xs', !isActive && 'border-emerald-300 text-emerald-700')}
              onClick={handleToggleActive}
            >
              {isActive ? (
                <><X className="h-3 w-3 text-amber-500" /> Inaktiv setzen</>
              ) : (
                <><Check className="h-3 w-3 text-emerald-500" /> Aktivieren</>
              )}
            </Button>

            {isBudgetItem && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs text-blue-600 border-blue-200"
                onClick={() => { onClose(); setTimeout(onOpenDrilldown, 50); }}
              >
                <Pencil className="h-3 w-3" /> Budget bearbeiten
              </Button>
            )}

            <Link to={`/kontenplan?q=${accountNum}`} onClick={onClose}>
              <Button size="sm" variant="outline" className="gap-1.5 text-xs">
                <ArrowUpRight className="h-3 w-3 text-muted-foreground" /> Kontenplan
              </Button>
            </Link>

            {isBudgetItem && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs text-red-600 border-red-200"
                onClick={handleDelete}
              >
                <Trash2 className="h-3 w-3" /> Zeile entfernen
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ─── Konto hinzufügen Dialog ──────────────────────────────────────────────────

interface AddKontoDialogProps {
  open: boolean;
  onClose: () => void;
  year: number;
  categories: BudgetPLCategory[];
  existingItems: BudgetPLLineItem[];
  onSaved: () => void;
}

type ConflictState =
  | { kind: 'hidden';  item: BudgetPLLineItem }   // exists but isHidden=true → offer to show
  | { kind: 'visible'; item: BudgetPLLineItem };   // exists and is already visible → can only update

const AddKontoDialog = ({ open, onClose, year, categories, existingItems, onSaved }: AddKontoDialogProps) => {
  const { tenantKey } = useTenant();
  const [accountNumber, setAccountNumber] = useState('');
  const [label,         setLabel]         = useState('');
  const [categoryId,    setCategoryId]    = useState('');
  const [isInternal,    setIsInternal]    = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [isSaving,      setIsSaving]      = useState(false);
  const [conflict,      setConflict]      = useState<ConflictState | null>(null);

  const itemCats = categories.filter(c => c.type === 'items');

  React.useEffect(() => {
    if (open) {
      setAccountNumber('');
      setLabel('');
      setCategoryId(itemCats[0]?.id ?? '');
      setIsInternal(false);
      setError(null);
      setIsSaving(false);
      setConflict(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function reset() {
    setAccountNumber('');
    setLabel('');
    setCategoryId(itemCats[0]?.id ?? '');
    setIsInternal(false);
    setError(null);
    setIsSaving(false);
    setConflict(null);
  }

  function handleSave() {
    const num = accountNumber.trim();
    const lbl = label.trim();
    if (!num)                 { setError('Kontonummer ist erforderlich.'); return; }
    if (!/^\d{4}$/.test(num)) { setError('Kontonummer muss genau 4 Ziffern sein.'); return; }
    if (!lbl)                 { setError('Bezeichnung ist erforderlich.'); return; }
    if (!categoryId)          { setError('Bitte eine Kategorie auswählen.'); return; }

    // Check for duplicate by account number
    const existing = existingItems.find(i => i.accountNumber === num);
    if (existing) {
      // Populate form fields with existing data so user can see/adjust
      if (!label.trim() || label === existing.label) setLabel(existing.label);
      if (!categoryId || categoryId === itemCats[0]?.id) setCategoryId(existing.categoryId);
      setIsInternal(existing.isInternal ?? false);
      setConflict(existing.isHidden ? { kind: 'hidden', item: existing } : { kind: 'visible', item: existing });
      setError(null);
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const storeKey = tenantKey(BUDGET_STORAGE_KEY);
      const zeroMonths: BudgetPLLineItem['monthlyValues'] = [0,0,0,0,0,0,0,0,0,0,0,0];
      addCustomPLLineItem(year, {
        categoryId,
        accountNumber: num,
        label: lbl,
        valueType: 'chf',
        monthlyValues: zeroMonths,
        sortOrder: 9999,
        isInternal,
        isHidden: false,
        isForceVisible: true,
      }, storeKey);
      toast.success(`Konto ${num} «${lbl}» hinzugefügt`);
      onSaved();
      reset();
      onClose();
    } catch (err) {
      console.error('[AddKonto] Fehler beim Speichern:', err);
      setError('Konto konnte nicht hinzugefügt werden. Details in der Konsole.');
    } finally {
      setIsSaving(false);
    }
  }

  function handleShowExisting() {
    if (!conflict) return;
    const lbl = label.trim() || conflict.item.label;
    const cat = categoryId || conflict.item.categoryId;
    setIsSaving(true);
    try {
      const storeKey = tenantKey(BUDGET_STORAGE_KEY);
      savePLLineItem(year, {
        ...conflict.item,
        label: lbl,
        categoryId: cat,
        isInternal,
        isHidden: false,
        isForceVisible: true,
      }, storeKey);
      toast.success(`Konto ${conflict.item.accountNumber} «${lbl}» eingeblendet`);
      onSaved();
      reset();
      onClose();
    } catch (err) {
      console.error('[AddKonto] Fehler beim Einblenden:', err);
      setError('Konto konnte nicht eingeblendet werden. Details in der Konsole.');
    } finally {
      setIsSaving(false);
    }
  }

  function handleUpdateExisting() {
    if (!conflict) return;
    const lbl = label.trim() || conflict.item.label;
    const cat = categoryId || conflict.item.categoryId;
    setIsSaving(true);
    try {
      const storeKey = tenantKey(BUDGET_STORAGE_KEY);
      savePLLineItem(year, {
        ...conflict.item,
        label: lbl,
        categoryId: cat,
        isInternal,
        isForceVisible: true,
      }, storeKey);
      toast.success(`Konto ${conflict.item.accountNumber} aktualisiert`);
      onSaved();
      reset();
      onClose();
    } catch (err) {
      console.error('[AddKonto] Fehler beim Aktualisieren:', err);
      setError('Konto konnte nicht aktualisiert werden. Details in der Konsole.');
    } finally {
      setIsSaving(false);
    }
  }

  const num = accountNumber.trim();
  const isFormDisabled = isSaving;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) { reset(); onClose(); } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Konto hinzufügen</DialogTitle>
          <DialogDescription>
            Fügt ein Konto zur Erfolgsrechnung hinzu. Interne Konten erscheinen mit
            INTERN-Badge und werden aus Summen und Ergebniszeilen ausgeschlossen.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {/* ── Konflikt-Banner ──────────────────────────────────────── */}
          {conflict && (
            <div className={`rounded-md border px-3 py-2.5 text-sm ${
              conflict.kind === 'hidden'
                ? 'bg-amber-50 border-amber-300 text-amber-800 dark:bg-amber-950/30 dark:border-amber-700 dark:text-amber-300'
                : 'bg-blue-50 border-blue-300 text-blue-800 dark:bg-blue-950/30 dark:border-blue-700 dark:text-blue-300'
            }`}>
              {conflict.kind === 'hidden' ? (
                <>
                  <p className="font-medium">Konto {num} ist bereits vorhanden, aber ausgeblendet.</p>
                  <p className="text-xs mt-1 opacity-80">
                    Aktuelle Bezeichnung: «{conflict.item.label}» · Kategorie: {categories.find(c => c.id === conflict.item.categoryId)?.label ?? conflict.item.categoryId}
                  </p>
                  <p className="text-xs mt-1">Du kannst die Felder unten anpassen und das Konto dann einblenden.</p>
                </>
              ) : (
                <>
                  <p className="font-medium">Konto {num} ist bereits in der Erfolgsrechnung sichtbar.</p>
                  <p className="text-xs mt-1 opacity-80">
                    Aktuelle Bezeichnung: «{conflict.item.label}» · Kategorie: {categories.find(c => c.id === conflict.item.categoryId)?.label ?? conflict.item.categoryId}
                  </p>
                  <p className="text-xs mt-1">Du kannst Bezeichnung und Kategorie anpassen und aktualisieren.</p>
                </>
              )}
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Kontonummer</label>
            <Input
              placeholder="z.B. 5850"
              value={accountNumber}
              maxLength={4}
              onChange={e => { setAccountNumber(e.target.value.replace(/\D/g, '')); setConflict(null); setError(null); }}
              className="h-8 text-sm font-mono"
              disabled={isFormDisabled}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Bezeichnung</label>
            <Input
              placeholder="z.B. Personalverpflegung"
              value={label}
              onChange={e => setLabel(e.target.value)}
              className="h-8 text-sm"
              disabled={isFormDisabled}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Kategorie</label>
            <Select value={categoryId} onValueChange={setCategoryId} disabled={isFormDisabled}>
              <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Kategorie wählen" /></SelectTrigger>
              <SelectContent>
                {itemCats.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={isInternal}
              onChange={e => setIsInternal(e.target.checked)}
              className="mt-0.5 accent-violet-600"
              disabled={isFormDisabled}
            />
            <div>
              <span className="text-sm font-medium">Nur intern</span>
              <p className="text-xs text-muted-foreground mt-0.5">
                Konto wird mit INTERN-Badge angezeigt und fliesst nicht in die offiziellen Summen ein.
              </p>
            </div>
          </label>

          {error && (
            <p className="text-xs text-red-600 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />{error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => { reset(); onClose(); }} disabled={isSaving}>
            Abbrechen
          </Button>

          {/* ── Aktions-Buttons je nach Zustand ──────────────────────── */}
          {!conflict && (
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              {isSaving
                ? <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />Speichern…</span>
                : <><Plus className="h-3.5 w-3.5 mr-1" />Hinzufügen</>
              }
            </Button>
          )}

          {conflict?.kind === 'hidden' && (
            <Button size="sm" onClick={handleShowExisting} disabled={isSaving}
              className="bg-amber-600 hover:bg-amber-700 text-white">
              {isSaving
                ? <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />Einblenden…</span>
                : 'Einblenden'
              }
            </Button>
          )}

          {conflict?.kind === 'visible' && (
            <Button size="sm" onClick={handleUpdateExisting} disabled={isSaving}>
              {isSaving
                ? <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />Speichern…</span>
                : 'Aktualisieren'
              }
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ─── Haupt-Seite ──────────────────────────────────────────────────────────────

const currentYear  = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;

type ViewMode = 'monthly' | 'yearly' | 'budget_pl' | 'multi_year' | 'mgmt_report' | 'bank_investor';

const PLViewPage = () => {
  const { tenantId, tenant, tenantKey } = useTenant();
  const { isAdmin } = usePermissions();
  if (!isAdmin) return <Navigate to="/" replace />;

  // Monats-Kontext aus dem Management-KPI-Dashboard (?monat=YYYY-MM, nur Initialwert)
  const [searchParams] = useSearchParams();
  const monatParam = parseMonatParam(searchParams.get(MONAT_PARAM));
  const [year,   setYear]   = useState(monatParam?.year ?? currentYear);
  const [month,  setMonth]  = useState(monatParam?.month ?? currentMonth);
  const [mode,   setMode]   = useState<ViewMode>('budget_pl');
  const [drilldown,       setDrilldown]       = useState<PLDrilldown | null>(null);
  const [bplDrilldown,    setBplDrilldown]    = useState<BPLRowWithValues | null>(null);
  const [miniYearsOpen,   setMiniYearsOpen]   = useState(false);
  const [accountAction,   setAccountAction]   = useState<BPLRowWithValues | null>(null);
  const [compact,          setCompact]          = useState(false);
  const isMobile = useIsMobile();
  const [excludeCurrentMonth, setExcludeCurrentMonth] = useState(false);
  const [highlightVariance, setHighlightVariance] = useState(false);
  const [pctMode,          setPctMode]          = useState<'off' | 'normal' | 'subtle'>('off');
  const [monthlyEbitInputs,  setMonthlyEbitInputs]  = useState<string[]>(() => Array(12).fill(''));
  const [annualDistribInput, setAnnualDistribInput] = useState('');
  const [hochYearOpen,  setHochYearOpen]  = useState(true);
  const [hochMonthOpen, setHochMonthOpen] = useState(true);
  // Banken-/Investorensicht: Importstand + nicht gemappte Konten (read-only Hinweis)
  const [annualImports, setAnnualImports] = useState<AnnualCostImportEntry[]>([]);
  const [persFixed,     setPersFixed]     = useState(false);
  const [compareMode,      setCompareMode]      = useState<'all' | 'ist_budget' | 'ist_vorjahr' | 'monat_vs_monat'>('all');
  const [cmpMonth,         setCmpMonth]         = useState<number>(() => month > 1 ? month - 1 : 12);
  const [cmpYear,          setCmpYear]          = useState<number>(() => month > 1 ? new Date().getFullYear() : new Date().getFullYear() - 1);
  const [refreshKey,       setRefreshKey]       = useState(0);
  const [addKontoOpen,    setAddKontoOpen]    = useState(false);
  // Budget-P&L Periodenwahl (E003): Quartal/Jahr = reine Anzeige-Aggregation, strikt read-only
  const [period,  setPeriod]  = useState<'month' | 'quarter' | 'year'>('month');
  const [quarter, setQuarter] = useState<number>(() => Math.ceil(currentMonth / 3));

  // Per-Monat Top-Down Budget (PLView)
  const [bplTopDownDialog,  setBplTopDownDialog]  = useState<{ catId: string; catLabel: string; monthIdx: number; monthBudgetTotal: number } | null>(null);
  const [bplTopDownMode,    setBplTopDownMode]    = useState<'chf' | 'pct'>('chf');
  const [bplTopDownInput,   setBplTopDownInput]   = useState('');

  // ── Maison / Marketing Umsatzkanal ───────────────────────────────────────
  const [maisonEnabled, setMaisonEnabled] = useState(() => getMaisonEnabledSync(tenantKey));
  const [maisonMonthly]                   = useState<Record<string, number>>(() => getMaisonMonthlySync(tenantKey));
  const [maisonDaily,   setMaisonDaily]   = useState<Record<string, number>>(() => getMaisonDailySync(tenantKey));
  const { showMarketingCol: maisonColPref, maisonExclude, setMaisonExclude } = useMaison();
  const { showNetRevenue } = useRevenueDisplay();

  useEffect(() => {
    loadMaisonEnabled(tenantKey).then(setMaisonEnabled);
    loadMaisonMonthly(tenantKey); // warm cache; not used for display
    loadMaisonDaily(tenantKey).then(setMaisonDaily);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const handleMaisonToggle = async () => {
    const newVal = !maisonEnabled;
    setMaisonEnabled(newVal);
    // Feature 2: Bei Aktivierung Marketing immer in Nettoumsatz einrechnen
    if (newVal) setMaisonExclude(false);
    await saveMaisonEnabled(tenantKey, newVal);
  };

  // Take-Away monatliche Werte (Record<'YYYY-MM', grossCHF>)
  const [takeawayMonthlyMap, setTakeawayMonthlyMap] = useState<Record<string, number>>({});
  useEffect(() => {
    kvGet(tenantKey(`takeaway-monthly-${year}`)).then(v => {
      setTakeawayMonthlyMap((v as Record<string, number> | null) ?? {});
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, year]);

  // Take-Away-Werte ALLER Jahre (nur Mehrjahres-/Bank-Modi): damit die
  // Mehrjahresserien exakt dieselben Monatswerte verwenden wie die ER
  // (Keys "YYYY-MM" sind jahrespräfixiert → gefahrlos mergebar).
  const [takeawayAllYears, setTakeawayAllYears] = useState<Record<string, number>>({});
  useEffect(() => {
    if (mode !== 'multi_year' && mode !== 'mgmt_report' && mode !== 'bank_investor') return;
    let cancelled = false;
    const yrs = availableYears(tenantKey(REPORTING_STORAGE_KEY));
    Promise.all(yrs.map(y => kvGet(tenantKey(`takeaway-monthly-${y}`)).catch(() => null)))
      .then(list => {
        if (cancelled) return;
        const merged: Record<string, number> = {};
        for (const v of list) Object.assign(merged, (v as Record<string, number> | null) ?? {});
        setTakeawayAllYears(merged);
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tenantId, refreshKey]);

  // Kanonischer IST-Umsatz ALLER Serien-Jahre (nur Mehrjahres-/Bank-/Mgmt-Modi):
  // damit die Mehrjahresanalyse denselben umsatz.ts-IST verwendet wie die ER.
  const [canonicalByYear, setCanonicalByYear] = useState<Record<number, CanonicalRevenueByMonth>>({});
  useEffect(() => {
    if (mode !== 'multi_year' && mode !== 'mgmt_report' && mode !== 'bank_investor') return;
    let cancelled = false;
    const currentYr = new Date().getFullYear();
    const yrs = Array.from(new Set([
      ...availableYears(tenantKey(REPORTING_STORAGE_KEY)),
      currentYr - 2, currentYr - 1, currentYr,
    ]));
    Promise.all(yrs.map(y =>
      ladeUmsatzTage(tenantId, `${y}-01-01`, `${y}-12-31`)
        .then(tage => [y, aggregateCanonicalByMonth(tage)] as const)
        .catch(() => [y, {} as CanonicalRevenueByMonth] as const),
    )).then(pairs => {
      if (cancelled) return;
      const map: Record<number, CanonicalRevenueByMonth> = {};
      for (const [y, cr] of pairs) map[y] = cr;
      setCanonicalByYear(map);
    });
    return () => { cancelled = true; };
  // KEIN refreshKey (Supabase-Direktquelle) — sonst verwerfen häufige refreshKey-
  // Bumps die laufende Ladung, siehe canonicalRevenue-Effekt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tenantId]);

  // Marketing-Nettobetrag für den aktuell gewählten Monat (aus Tagesdaten)
  // Gibt 0 zurück wenn "Ausblenden" (maisonColPref=false) → Marketing-Zeile verschwindet
  // WICHTIG: maison-daily ist Netto-NENNWERT (gleiche Regel wie umsatz.ts) —
  // KEINE /1.081-Division mehr (Juli 2026: 13'193.40, nicht 12'205).
  const maisonMonthNet = useMemo(() => {
    if (!maisonEnabled || !maisonColPref) return 0;
    const mm   = String(month).padStart(2, '0');
    const days = new Date(year, month, 0).getDate();
    let total  = 0;
    for (let d = 1; d <= days; d++) {
      const v = Number(maisonDaily[`${year}-${mm}-${String(d).padStart(2, '0')}`] ?? 0);
      if (v !== 0) total += Math.round(Math.abs(v) * 100) / 100;
    }
    return total;
  }, [maisonEnabled, maisonColPref, maisonDaily, year, month]);

  // Marketing-Unterzeile in der Tabelle: per Default AUSGEBLENDET (nur informativ,
  // Marketing ist bereits im Betriebsertrag-Netto enthalten). Toggle im Maison-Banner.
  const [showMarketingRow, setShowMarketingRow] = useState(false);

  // Stichtag — wenn aktiv, springt die Ansicht automatisch zu Jahr/Monat des Stichtags
  const { isActive: stichtagActive, stichtagYear, stichtagMonth } = useStichtag();
  useEffect(() => {
    if (stichtagActive && stichtagYear && stichtagMonth) {
      setYear(stichtagYear);
      setMonth(stichtagMonth);
    }
  }, [stichtagActive, stichtagYear, stichtagMonth]);

  // Nach Supabase-Sync Daten neu laden
  useEffect(() => {
    const handler = () => setRefreshKey(k => k + 1);
    window.addEventListener('store-synced', handler);
    return () => window.removeEventListener('store-synced', handler);
  }, []);

  // Mandantenwechsel: Daten neu laden
  useEffect(() => {
    setRefreshKey(k => k + 1);
    console.log(`[TENANT] PLView: Mandant "${tenantId}" – neu geladen`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // VJ-Supabase-Daten für das Vorjahr laden (einmaliger Query für alle 12 Monate)
  const [vjDailyData, setVjDailyData] = useState<Record<string, VjDayRecord>>({});
  useEffect(() => {
    loadVjDailyYear(year - 1, tenantId).then(data => {
      console.log(`[REVENUE-SYNC] VJ Supabase-Daten geladen: ${Object.keys(data).length} Tage für ${year - 1}`);
      setVjDailyData(data);
    });
  }, [year, tenantId]);

  // Sage Journal für das gewählte Jahr aus Supabase laden (auto-migration)
  useEffect(() => {
    syncJournalYearFromDB(year, tenantId).then(() => setRefreshKey(k => k + 1));
  }, [year, tenantId]);

  // Daten laden & P&L berechnen
  const records = useMemo(() => loadYear(year, tenantKey(REPORTING_STORAGE_KEY)), [year, month, refreshKey, tenantId]);
  const prevYearRecords = useMemo(() => loadYear(year - 1, tenantKey(REPORTING_STORAGE_KEY)), [year, tenantId]);

  // Jahr-Selector: Jahre mit Daten ∪ [aktuell−2 … aktuell+1] — macht 2024 als
  // reguläres Geschäftsjahr wählbar (auch vor dem ersten Import), tenant-bewusst.
  // refreshKey: nach einem Jahres-Import erscheint das neue Jahr sofort.
  const years = useMemo(
    () => yearSelectOptions(availableYears(tenantKey(REPORTING_STORAGE_KEY)), currentYear),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tenantId, tenantKey, refreshKey],
  );

  // Banken-/Investorensicht: Import-Registry read-only laden (Importstand +
  // nicht gemappte Konten als Datenqualitätshinweis — KEIN Schreibpfad).
  useEffect(() => {
    if (mode !== 'bank_investor') return;
    let cancelled = false;
    loadAnnualCostImports(tenantKey(ANNUAL_COST_IMPORTS_KEY))
      .then(entries => { if (!cancelled) setAnnualImports(entries); })
      .catch(() => { if (!cancelled) setAnnualImports([]); });
    return () => { cancelled = true; };
  }, [mode, tenantId, tenantKey, refreshKey]);

  const bankImportInfo = useMemo(() => {
    const unmapped = annualImports.reduce((sum, e) => sum + (e.unmappedCount || 0), 0);
    const latest = annualImports.reduce<string | null>(
      (acc, e) => (e.importedAt && (!acc || e.importedAt > acc) ? e.importedAt : acc), null,
    );
    let importStand: string | null = null;
    if (latest) {
      const d = new Date(latest);
      importStand = Number.isNaN(d.getTime())
        ? latest
        : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
    }
    // Import-Metadaten je Jahr für die Investor Timeline (neuester Eintrag
    // je Geschäftsjahr; Tombstones sind bereits im Loader gefiltert).
    const importInfoByYear: Record<number, { importedAt: string | null; fileName?: string | null }> = {};
    for (const e of annualImports) {
      const prev = importInfoByYear[e.year];
      if (!prev || (e.importedAt && (!prev.importedAt || e.importedAt > prev.importedAt))) {
        importInfoByYear[e.year] = { importedAt: e.importedAt || null, fileName: e.fileName || null };
      }
    }
    return { unmappedAccounts: unmapped > 0 ? unmapped : undefined, importStand, importInfoByYear };
  }, [annualImports]);

  // Vorjahres-Diagnose: macht sichtbar, ob/welche Vorjahresdaten vorhanden sind
  // (verändert KEINE Berechnungen, erfindet KEINE Werte — nur Sichtbarkeit).
  const priorYearDiag = useMemo(
    () => computePriorYearDiagnostics(year - 1, prevYearRecords, vjDailyData),
    [year, prevYearRecords, vjDailyData],
  );

  // Gastronovi-Tagesdaten aus localStorage laden (nur noch für VJ-Umsatz-Regel)
  const dailyBudgetsData = useMemo<Record<string, { actualRevenue?: number; takeawayRevenue?: number; previousYearRevenue?: number }>>(() => {
    try { return JSON.parse(localStorage.getItem(tenantKey('dailyBudgets')) || '{}'); }
    catch { return {}; }
  }, [refreshKey, tenantId]);

  // ── Kanonischer IST-Umsatz pro Monat (umsatz.ts, gn_imports Tages-Z-Berichte) ──
  // SSOT für den IST-Umsatz des laufenden Jahres; ersetzt die frühere
  // grossToNet/dailyBudgets-Herleitung. Tage ohne Import fehlen → kein 0 erfunden.
  const [canonicalRevenue, setCanonicalRevenue] = useState<CanonicalRevenueByMonth>({});
  useEffect(() => {
    // WICHTIG: KEIN refreshKey in den Deps. Der Wert kommt direkt aus Supabase
    // (gn_imports), nicht aus localStorage — refreshKey wird von mehreren anderen
    // Effekten (store-synced, Journal-Sync, Mandantenwechsel) hochgezählt. Hinge
    // dieser Effekt an refreshKey, würde ein solcher Bump die noch laufende
    // ladeUmsatzTage-Promise via cancelled=true verwerfen, BEVOR sie state setzt
    // → Erfolgsrechnung bliebe leer ("Noch keine Daten"), obwohl gn_imports Daten
    // liefert (Dashboard funktioniert, weil dessen Effekt nicht an refreshKey hängt).
    // Generationszähler statt cancelled-Flag; zusätzlich Nachladen bei
    // 'store-synced': Läuft der Mount-Load, BEVOR die Auth-Session am Supabase-
    // Client hängt, liefert RLS still 0 Zeilen (kein Fehler!) — ohne Retry
    // bliebe die Erfolgsrechnung dauerhaft leer, obwohl gn_imports Daten hat.
    let gen = 0;
    const load = () => {
      const myGen = ++gen;
      ladeUmsatzTage(tenantId, `${year}-01-01`, `${year}-12-31`)
        .then(tage => {
          if (myGen !== gen) return;
          const agg = aggregateCanonicalByMonth(tage);
          // Leeres Ergebnis überschreibt nie ein bereits geladenes (Session-Race).
          setCanonicalRevenue(prev =>
            tage.size === 0 && Object.values(prev).some(m => m.hasData) ? prev : agg,
          );
        })
        .catch(() => { /* Fehler bereits in ladeUmsatzTage geloggt; State behalten */ });
    };
    load();
    const refresh = () => load();
    window.addEventListener('store-synced', refresh);
    return () => { gen++; window.removeEventListener('store-synced', refresh); };
  }, [year, tenantId]);

  // ── Mehrjahresanalyse: Serien je Jahr (effektive Records → computePLForMonth)
  // Datenbasis IDENTISCH zur Erfolgsrechnung: dieselbe SSoT-Lib (effective-records)
  // wendet IST-Umsatz-Sync (Tagesansicht) + Personalkosten-Buchhaltungsvorrang an —
  // importierte Monate erscheinen nie als "—", nur weil reporting_v1 leer ist.
  // (VJ-Umsatz-Regel betrifft nur die VJ-Spalte der Monatssicht — hier irrelevant.)
  const multiYearSeries = useMemo<YearSeries[] | null>(() => {
    if (mode !== 'multi_year' && mode !== 'mgmt_report' && mode !== 'bank_investor') return null;
    const storeKey = tenantKey(REPORTING_STORAGE_KEY);
    // Banken-/Investorensicht braucht ALLE P&L-Zwischentotale — Vereinigungsmenge
    // (dieselben computePLForMonth-Rows, nur mehr IDs; keine Zweitberechnung).
    const positionIds = Array.from(new Set([
      ...MULTI_YEAR_POSITIONS.map(p => p.id),
      ...BANK_ROW_IDS,
      // Personal-Komponenten für den Jahresvergleichs-Drilldown (§8):
      // Löhne + Sozialleistungen + übriger Personalaufwand = Total Personal.
      'personnel_wages', 'personnel_social', 'personnel_other',
    ]));
    // Jahresbasis: Jahre mit Records ∪ [aktuell−2 … aktuell] — abgeschlossene
    // Geschäftsjahre (z. B. Vorvorjahr) erscheinen als wählbare, leere Serie
    // («—»-Spalte mit Import-Hinweis), statt still zu fehlen.
    const currentYr = new Date().getFullYear();
    const seriesYearBasis = Array.from(new Set([
      ...availableYears(storeKey),
      currentYr - 2, currentYr - 1, currentYr,
    ])).sort((a, b) => a - b);
    return seriesYearBasis.map(y => {
      const canonical = canonicalByYear[y] ?? {};
      const recs = loadYear(y, storeKey).map((rec, idx) => applyCanonicalIstRule(rec, idx + 1, {
        year: y,
        canonical,
        takeawayMonthly: takeawayAllYears,
        net: showNetRevenue,
      }));
      const values: (number | null)[] = [];
      const byPosition: Record<string, (number | null)[]> =
        Object.fromEntries(positionIds.map(id => [id, [] as (number | null)[]]));
      const personnelPct: (number | null)[] = [];
      const wesPct: (number | null)[] = [];
      for (let m = 0; m < 12; m++) {
        const res = computePLForMonth(recs[m]);
        if (!res.hasData) {
          values.push(null); personnelPct.push(null); wesPct.push(null);
          for (const id of positionIds) byPosition[id].push(null);
          continue;
        }
        const rowVal = (id: string) => res.rows.find(r => r.def.id === id)?.values.actual ?? null;
        const rev = rowVal('net_revenue');
        const pers = rowVal('total_personnel');
        const cogs = rowVal('total_cogs');
        values.push(rev);
        for (const id of positionIds) byPosition[id].push(rowVal(id));
        personnelPct.push(rev != null && rev !== 0 && pers != null ? (pers / rev) * 100 : null);
        wesPct.push(rev != null && rev !== 0 && cogs != null ? (cogs / rev) * 100 : null);
      }
      return { year: y, values, byPosition, personnelPct, wesPct };
    });
  }, [mode, refreshKey, tenantId, tenantKey, canonicalByYear, maisonEnabled, maisonDaily, takeawayAllYears, showNetRevenue]);

  // Budget P&L laden (vor den Overrides benötigt)
  const budgetData = useMemo(() => loadBudgetWithPL(year, tenantKey(BUDGET_STORAGE_KEY)), [year, refreshKey, tenantId]);

  // Effektive Records für alle 12 Monate:
  // Tagesansicht (dailyBudgets + VJ-Supabase) ist die authoritative Umsatz-Quelle.
  // Regeln:
  //   IST-Umsatz: Tagesansicht-NETTO schlägt reporting_v1, ausser wenn Sage 3xxx-Konten vorhanden.
  //   VJ-Umsatz:  Tagesansicht-VJ-NETTO schlägt reporting_v1, ausser wenn Sage 3xxx-PY-Konten vorhanden.
  // → Garantiert: PLView-Umsatz ≡ Tagesansicht-Umsatz
  const effectiveAllRecords = useMemo(() => {
    return records.map((rec, idx) => {
      const m = idx + 1;
      // ── IST-Umsatz (kanonische Quelle umsatz.ts) + Personalkosten-Vorrang ──
      // Maison-Zuschlag fliesst NICHT in revenueActual (kanonischer Umsatz identisch
      // mit Dashboard/Monatsreport); Maison ist ggf. eine separate Anzeige-Spalte.
      let r = applyCanonicalIstRule(rec, m, {
        year,
        canonical: canonicalRevenue,
        takeawayMonthly: takeawayMonthlyMap,
        net: showNetRevenue,
      });

      // ── VJ-Umsatz: zentrale Regel aus effective-records (SSoT — dieselbe
      // Quelle nutzt die Financial-Metrics-Registry für das Dashboard) ──────
      r = applyVjRevenueRule(r, m, {
        year,
        dailyBudgets: dailyBudgetsData,
        vjDaily: vjDailyData,
        prevYearRecord: prevYearRecords[idx],
      });

      return r;
    });
  }, [records, prevYearRecords, year, canonicalRevenue, dailyBudgetsData, vjDailyData, maisonEnabled, maisonColPref, maisonDaily, takeawayMonthlyMap, showNetRevenue]);

  // Effektiver Datensatz für den ausgewählten Monat
  const effectiveMonthRecord = useMemo(
    () => effectiveAllRecords[month - 1],
    [effectiveAllRecords, month],
  );

  // Pro-Monat Overrides (Budget + Vorjahr) für alle 12 Monate — zentral für Klassisch & Jahresansicht
  const allMonthOverrides = useMemo((): PLMonthOverrides[] => {
    return Array.from({ length: 12 }, (_, idx) => {
      // Budget-Overrides zentral aus pl-engine (Single Source of Truth — dieselbe
      // Quelle nutzt PersonalFix für „Planung vs. Erfolgsrechnung").
      const budgetByRow = buildBudgetByRowForMonth(budgetData, idx, lookupAccount);
      // VJ-Overrides zentral aus pl-engine (Single Source of Truth — dieselbe
      // Quelle nutzt die Financial-Metrics-Registry für das Dashboard).
      // Priorität: effRec.revenuePreviousYear (Tagesansicht-VJ, vorgängig in
      // effectiveAllRecords gesetzt) > prevYearRecords (reporting_v1 Vorjahr).
      const prevYearByRow = buildPrevYearByRowForMonth(
        prevYearRecords[idx],
        effectiveAllRecords[idx],
        lookupAccount,
      );
      return {
        budgetByRow:   budgetByRow.size   > 0 ? budgetByRow   : undefined,
        prevYearByRow: prevYearByRow.size > 0 ? prevYearByRow : undefined,
        // Warenaufwand-Budget nach numerischer Range (SSoT für die Zwischentotale)
        cogsBudgetSplit: buildCogsBudgetSplitForMonth(budgetData, idx, lookupAccount),
      };
    });
  }, [budgetData, prevYearRecords, effectiveAllRecords]);

  const monthResult = useMemo(
    () => computePLForMonth(effectiveMonthRecord, allMonthOverrides[month - 1]),
    [effectiveMonthRecord, allMonthOverrides, month],
  );

  const yearResult = useMemo(
    () => computePLForYear(effectiveAllRecords, allMonthOverrides),
    [effectiveAllRecords, allMonthOverrides],
  );

  const bplRows = useMemo(
    () => computeBPLRows(budgetData, effectiveMonthRecord, month - 1, prevYearRecords[month - 1]),
    [budgetData, effectiveMonthRecord, month, prevYearRecords],
  );

  // ── Monat-vs-Monat Vergleich ─────────────────────────────────────────────
  const cmpRecord = useMemo(() => {
    if (compareMode !== 'monat_vs_monat') return undefined;
    const idx = cmpMonth - 1;
    if (cmpYear === year) return effectiveAllRecords[idx] as MonthlyFinancialRecord | undefined;
    if (cmpYear === year - 1) return prevYearRecords[idx] as MonthlyFinancialRecord | undefined;
    return undefined;
  }, [compareMode, cmpMonth, cmpYear, year, effectiveAllRecords, prevYearRecords]);

  const cmpBplRows = useMemo<BPLRowWithValues[]>(() => {
    if (!cmpRecord) return [];
    return computeBPLRows(budgetData, cmpRecord, cmpMonth - 1, undefined);
  }, [budgetData, cmpRecord, cmpMonth]);

  // effectiveBplRows: bplRows mit injizierten Vergleichsmonat-Werten als prevYear
  const effectiveBplRows = useMemo<BPLRowWithValues[]>(() => {
    if (compareMode !== 'monat_vs_monat' || cmpBplRows.length === 0) return bplRows;
    const cmpMap = new Map<string, number>();
    for (const row of cmpBplRows) {
      const key = row.isCategory ? `cat:${row.catId}` : `item:${row.catId}:${row.itemId}`;
      cmpMap.set(key, row.values.actual);
    }
    return bplRows.map(row => {
      const key = row.isCategory ? `cat:${row.catId}` : `item:${row.catId}:${row.itemId}`;
      const cmpActual = cmpMap.get(key);
      if (cmpActual === undefined) return row;
      const newVsPrevYear = row.values.actual - cmpActual;
      return {
        ...row,
        values: {
          ...row.values,
          prevYear: cmpActual,
          vsPrevYear: newVsPrevYear,
          vsPrevYearPct: cmpActual !== 0 ? (newVsPrevYear / Math.abs(cmpActual)) * 100 : undefined,
        },
      };
    });
  }, [compareMode, bplRows, cmpBplRows]);

  // ── Perioden-Aggregation Quartal/Jahr (E003) — reine Anzeige, read-only ──
  // Summe der UNVERÄNDERTEN Monats-Zeilen aus computeBPLRows; Abweichungen
  // und Prozente aus den Rohsummen (bpl-aggregate) — keine Zweitberechnung.
  const periodAgg = useMemo(() => {
    if (mode !== 'budget_pl' || period === 'month') return null;
    const monthIdxs = period === 'quarter'
      ? [0, 1, 2].map(i => (quarter - 1) * 3 + i)
      : Array.from({ length: 12 }, (_, i) => i);
    const rowsPerMonth = monthIdxs.map(i =>
      computeBPLRows(budgetData, effectiveAllRecords[i], i, prevYearRecords[i]));
    const hasDataFlags = monthIdxs.map(i => yearResult.months[i]?.hasData ?? false);
    return aggregateBPLRows(rowsPerMonth, hasDataFlags);
  }, [mode, period, quarter, budgetData, effectiveAllRecords, prevYearRecords, yearResult]);

  // Anzeige-Zeilen: Monat = effectiveBplRows (inkl. Monat-vs-Monat-Injektion);
  // Quartal/Jahr = aggregierte Zeilen (Monat-vs-Monat dort nicht verfügbar).
  const displayBplRows = periodAgg ? periodAgg.rows : effectiveBplRows;
  const effectiveCompareMode = period !== 'month' && compareMode === 'monat_vs_monat' ? 'all' : compareMode;

  const bplRevenue = useMemo(
    () => displayBplRows.find(r => r.catId === 'pl_revenue' && r.isCategory)?.values.actual ?? 0,
    [displayBplRows],
  );

  // Wenn kein Ist-Umsatz vorhanden → Budget-Umsatz als Fallback für %-Berechnung
  const bplBudgetRevenue = useMemo(
    () => displayBplRows.find(r => r.catId === 'pl_revenue' && r.isCategory)?.values.budget ?? 0,
    [displayBplRows],
  );
  const bplPrevYearRevenue = useMemo(
    () => displayBplRows.find(r => r.catId === 'pl_revenue' && r.isCategory)?.values.prevYear ?? 0,
    [displayBplRows],
  );
  const bplEffectiveRevenue = bplRevenue > 0 ? bplRevenue : bplBudgetRevenue;
  const pctIsBudgetBased = pctMode !== 'off' && bplRevenue === 0 && bplBudgetRevenue > 0;

  const handleDrilldown = useCallback((rowId: string) => {
    const dd = getDrilldown(rowId, monthResult);
    if (dd) setDrilldown(dd);
  }, [monthResult]);

  const parseBplTopDownInput = () =>
    parseFloat(bplTopDownInput.replace(/['\u2019\s]/g, '').replace(',', '.')) || 0;

  const calcBplTopDownTargetCHF = () => {
    const val = parseBplTopDownInput();
    return bplTopDownMode === 'pct' ? val / 100 * bplBudgetRevenue : val;
  };

  const restoreBplSnapshot = (snapshot: { itemId: string; monthlyValues: BudgetPLLineItem['monthlyValues'] }[]) => {
    const freshItems = loadBudgetWithPL(year, tenantKey(BUDGET_STORAGE_KEY)).plLineItems ?? [];
    for (const s of snapshot) {
      const item = freshItems.find(i => i.id === s.itemId);
      if (!item) continue;
      savePLLineItem(year, { ...item, monthlyValues: s.monthlyValues }, tenantKey(BUDGET_STORAGE_KEY));
    }
    setRefreshKey(k => k + 1);
    toast.success('Änderung rückgängig gemacht');
  };

  const applyBplTopDownMonth = () => {
    if (!bplTopDownDialog) return;
    const { catId, catLabel, monthIdx } = bplTopDownDialog;
    const targetCHF = calcBplTopDownTargetCHF();
    if (targetCHF <= 0) { toast.error('Bitte einen gültigen Wert (> 0) eingeben.'); return; }

    const cats = budgetData.plCategories ?? [];
    const items = budgetData.plLineItems ?? [];
    const cat = cats.find(c => c.id === catId);
    if (!cat) return;

    const contribCatIds = (cat.resultFormula ?? [])
      .map(f => f.categoryId)
      .filter(cId => cats.find(c => c.id === cId)?.type === 'items');
    const affectedItems = items.filter(i => contribCatIds.includes(i.categoryId) && !i.isHidden && !i.isInternal);
    if (affectedItems.length === 0) { toast.error('Keine anpassbaren Konten gefunden.'); return; }

    const currentMonthTotal = affectedItems.reduce((s, item) => s + (item.monthlyValues[monthIdx] ?? 0), 0);
    if (currentMonthTotal === 0) { toast.error('Aktueller Monatswert ist 0 – bitte zuerst manuell befüllen.'); return; }

    const snapshot = affectedItems.map(item => ({ itemId: item.id, monthlyValues: [...item.monthlyValues] as BudgetPLLineItem['monthlyValues'] }));

    const factor = targetCHF / currentMonthTotal;
    const storeKey = tenantKey(BUDGET_STORAGE_KEY);
    for (const item of affectedItems) {
      const newVals = [...item.monthlyValues] as BudgetPLLineItem['monthlyValues'];
      newVals[monthIdx] = Math.round((newVals[monthIdx] ?? 0) * factor);
      savePLLineItem(year, { ...item, monthlyValues: newVals }, storeKey);
    }
    setRefreshKey(k => k + 1);
    setBplTopDownDialog(null);
    setBplTopDownInput('');
    const pct = bplBudgetRevenue > 0 ? (targetCHF / bplBudgetRevenue * 100).toFixed(1) : null;
    toast.success(
      `${catLabel} ${BUDGET_MONTH_NAMES_FULL[monthIdx]}: CHF ${Math.round(targetCHF).toLocaleString('de-CH')}${pct ? ` (${pct}%)` : ''}`,
      { action: { label: 'Rückgängig', onClick: () => restoreBplSnapshot(snapshot) } }
    );
  };

  const [pdfDialogOpen, setPdfDialogOpen] = useState(false);

  const handleExportPDF = useCallback(() => {
    setPdfDialogOpen(true);
  }, []);

  const handlePdfExport = useCallback(async (opts: PLExportOptions) => {
    const branding = getBranding(tenantId);
    const currentlyIncludes = maisonEnabled && maisonColPref;

    let exportMonthResult = monthResult;
    let exportYearResult  = yearResult;

    // If the export Maison setting differs from the current view state, recompute
    if (opts.includeMaison !== undefined && !!opts.includeMaison !== !!currentlyIncludes) {
      const delta = opts.includeMaison ? 1 : -1;

      // Compute net Maison revenue for a given month from daily gross values (/1.081)
      const getMaisonNetForMonth = (m: number): number => {
        const mm   = String(m).padStart(2, '0');
        const days = new Date(year, m, 0).getDate();
        let net    = 0;
        // Gleiche Regel wie maisonMonthNet/umsatz.ts: Netto-NENNWERT 1:1, kein /1.081
        for (let d = 1; d <= days; d++) {
          const key = `${year}-${mm}-${String(d).padStart(2, '0')}`;
          const v   = Number(maisonDaily[key] ?? 0);
          if (v !== 0) net += Math.round(Math.abs(v) * 100) / 100;
        }
        return net;
      };

      // Adjust the selected month
      const monthMaisonNet = getMaisonNetForMonth(month);
      if (monthMaisonNet > 0 && effectiveMonthRecord) {
        const adjRec = {
          ...effectiveMonthRecord,
          revenueActual: (effectiveMonthRecord.revenueActual ?? 0) + delta * monthMaisonNet,
        };
        exportMonthResult = computePLForMonth(adjRec, allMonthOverrides[month - 1]);
      }

      // Adjust all months for yearResult (cumulative/prevMonth sections)
      const adjAllRecs = effectiveAllRecords.map((rec, idx) => {
        const mNet = getMaisonNetForMonth(idx + 1);
        if (mNet <= 0) return rec;
        return { ...rec, revenueActual: (rec.revenueActual ?? 0) + delta * mNet };
      });
      exportYearResult = computePLForYear(adjAllRecs, allMonthOverrides);
    }

    const exportMaisonLabel = opts.includeMaison && maisonMonthNet > 0
      ? `inkl. Maison CHF ${Math.round(maisonMonthNet).toLocaleString('de-CH')}`
      : undefined;

    try {
      await exportPLToPDF(exportMonthResult, exportYearResult, year, month, mode, opts, branding, exportMaisonLabel);
      toast.success('PDF erstellt');
    } catch (e) {
      console.error(e);
      toast.error('PDF-Export fehlgeschlagen');
    }
  }, [monthResult, yearResult, effectiveMonthRecord, effectiveAllRecords, allMonthOverrides, year, month, mode, tenantId, maisonEnabled, maisonColPref, maisonDaily, maisonMonthNet]);

  const handleYearMonthClick = useCallback((m: number) => {
    setMonth(m);
    setMode('monthly');
  }, []);

  // ── E006: KPI-Leiste aus der Financial-Metrics-Registry (SSoT) ─────────────
  // Monat: direkt getFinancialMetricValues({pl: monthResult}) — dieselbe
  // computePLForMonth-Basis wie Dashboard-Finanzkarten. Quartal/Jahr:
  // null-erhaltende Aggregation über die BEREITS berechneten yearResult.months
  // (E011: keine zusätzliche Berechnung, keine neuen Queries).
  const laborThreshold = useMemo(
    () => parseInt(localStorage.getItem(tenantKey('labor_cost_threshold')) || '40'),
    [tenantKey],
  );

  const registryKpis = useMemo(() => {
    if (mode !== 'monthly' && mode !== 'budget_pl') return null;
    const periodPls =
      mode === 'budget_pl' && period === 'quarter'
        ? yearResult.months.slice((quarter - 1) * 3, (quarter - 1) * 3 + 3)
        : mode === 'budget_pl' && period === 'year'
          ? yearResult.months
          : null;
    return PLVIEW_KPI_METRIC_IDS.map(id => ({
      def: getFinancialMetricDefinition(id),
      values: periodPls
        ? aggregateFinancialMetricValues(id, periodPls)
        : getFinancialMetricValues(id, { pl: monthResult }),
    }));
  }, [mode, period, quarter, monthResult, yearResult]);

  const renderRegistryKpiCard = (k: { def: FinancialMetricDefinition; values: FinancialMetricValues }) => (
    <KpiCard
      key={k.def.id}
      label={k.def.label}
      value={fmtMetricValue(k.values.actual, k.def.unit)}
      tone={registryKpiTone(k.def.id, k.values, laborThreshold)}
      trend={registryKpiTrend(k.def, k.values)}
      sub={<>Budget {fmtMetricValue(k.values.budget, k.def.unit)} · VJ {fmtMetricValue(k.values.priorYear, k.def.unit)}</>}
      data-testid={`plview-kpi-${k.def.id}`}
    />
  );

  // ── E008: Mini-Jahresvergleich (lazy beim Öffnen; calcAnnualSummary liest
  // nur localStorage — keine neuen Supabase-Queries, kein neuer Store) ────────
  const miniYearCompare = useMemo(() => {
    if (!miniYearsOpen || mode !== 'budget_pl') return null;
    const storeKey = tenantKey(REPORTING_STORAGE_KEY);
    const years = [year - 2, year - 1, year];
    const sums = years.map(y => calcAnnualSummary(y, storeKey));
    return years.map((y, i) => {
      const s = sums[i];
      const prev = i > 0 ? sums[i - 1] : null;
      const hasData = s.monthsWithData > 0;
      const prevHasData = !!prev && prev.monthsWithData > 0;
      const delta = hasData && prevHasData ? s.totalRevenueActual - prev!.totalRevenueActual : null;
      const deltaPct = delta !== null && prev!.totalRevenueActual !== 0
        ? (delta / Math.abs(prev!.totalRevenueActual)) * 100
        : null;
      return { year: y, revenue: hasData ? s.totalRevenueActual : null, months: s.monthsWithData, delta, deltaPct };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [miniYearsOpen, mode, year, tenantKey, refreshKey]);

  // ── E005: Zusammensetzung einer Ergebniszeile (reine Anzeige derselben
  // Tabellenzeilen — Kategorien seit dem vorherigen Zwischenergebnis) ─────────
  const bplDrilldownComposition = useMemo(() => {
    if (!bplDrilldown || bplDrilldown.catType !== 'result' || !bplDrilldown.isCategory) return undefined;
    const idx = displayBplRows.findIndex(r => r.isCategory && r.catType === 'result' && r.catId === bplDrilldown.catId);
    if (idx === -1) return undefined;
    let start = 0;
    for (let i = idx - 1; i >= 0; i--) {
      if (displayBplRows[i].isCategory && displayBplRows[i].catType === 'result') { start = i; break; }
    }
    return displayBplRows.slice(start, idx).filter(r => r.isCategory);
  }, [bplDrilldown, displayBplRows]);

  // prevYearLabel für Budget-P&L Tabellenkopf (Monat-vs-Monat → Vergleichsmonat-Name);
  // effectiveCompareMode: bei Quartal/Jahr fällt monat_vs_monat auf 'all' zurück → Label «Vorjahr»
  const prevYearColLabel = effectiveCompareMode === 'monat_vs_monat'
    ? `${MONTH_NAMES_DE[cmpMonth]?.slice(0, 3) ?? `M${cmpMonth}`} ${cmpYear}`
    : 'Vorjahr';

  // KPI-Karten Jahresansicht (Summe über alle / nur abgeschlossene Monate)
  // excludeMonthIdx: 0-basiert (currentMonth - 1); -1 = kein Ausschluss
  const excludeMonthIdx = (excludeCurrentMonth && year === currentYear) ? currentMonth - 1 : -1;
  const yearEffectiveMonths = useMemo(
    () => excludeMonthIdx >= 0
      ? yearResult.months.filter((_, i) => i !== excludeMonthIdx)
      : yearResult.months,
    [yearResult, excludeMonthIdx],
  );
  const yearNetRevTotal      = useMemo(() => yearEffectiveMonths.reduce((s, m) => s + (m.rows.find(r => r.def.id === 'net_revenue')?.values.actual ?? 0), 0), [yearEffectiveMonths]);
  const yearGP1Total         = useMemo(() => yearEffectiveMonths.reduce((s, m) => s + (m.rows.find(r => r.def.id === 'gross_profit_1')?.values.actual ?? 0), 0), [yearEffectiveMonths]);
  const yearGP2Total         = useMemo(() => yearEffectiveMonths.reduce((s, m) => s + (m.rows.find(r => r.def.id === 'gross_profit_2')?.values.actual ?? 0), 0), [yearEffectiveMonths]);
  const yearEbitTotal        = useMemo(() => yearEffectiveMonths.reduce((s, m) => s + (m.rows.find(r => r.def.id === 'ebit')?.values.actual ?? 0), 0), [yearEffectiveMonths]);
  const yearCogsTotal        = useMemo(() => yearEffectiveMonths.reduce((s, m) => s + (m.rows.find(r => r.def.id === 'total_cogs')?.values.actual ?? 0), 0), [yearEffectiveMonths]);
  const yearPersonnelTotal   = useMemo(() => yearEffectiveMonths.reduce((s, m) => s + (m.rows.find(r => r.def.id === 'total_personnel')?.values.actual ?? 0), 0), [yearEffectiveMonths]);

  // Hochrechnung: pro Monat unabhängig berechnen
  const hochrechnungMonths = useMemo(() => {
    return yearResult.months.map((monthData, i) => {
      const monthNetRev    = monthData.rows.find(r => r.def.id === 'net_revenue')?.values.actual    ?? 0;
      const monthCogs      = monthData.rows.find(r => r.def.id === 'total_cogs')?.values.actual     ?? 0;
      const monthPersonnel = monthData.rows.find(r => r.def.id === 'total_personnel')?.values.actual ?? 0;
      const monthGP1       = monthData.rows.find(r => r.def.id === 'gross_profit_1')?.values.actual ?? 0;
      const monthGP2       = monthData.rows.find(r => r.def.id === 'gross_profit_2')?.values.actual ?? 0;
      const monthEbit      = monthData.rows.find(r => r.def.id === 'ebit')?.values.actual           ?? 0;
      const raw = (monthlyEbitInputs[i] ?? '').trim().replace(/[''\s]/g, '').replace(',', '.');
      const targetEbit = parseFloat(raw);
      const hasInput = raw !== '' && !isNaN(targetEbit);
      const cogsQuote = monthNetRev > 0 ? monthCogs      / monthNetRev * 100 : null;
      const persQuote = monthNetRev > 0 ? monthPersonnel / monthNetRev * 100 : null;
      const ebitPct = monthNetRev > 0 ? monthEbit / monthNetRev : null;
      const canCompute = hasInput && ebitPct !== null && Math.abs(ebitPct) > 0.0001 && monthNetRev > 0;
      if (!canCompute) {
        return { monthNetRev, monthCogs, monthPersonnel, monthGP1, monthGP2, monthEbit, cogsQuote, persQuote, targetEbit: hasInput ? targetEbit : null, hasInput, canCompute: false as const, reqNetRev: null, factor: null, reqCogs: null, reqPersonnel: null };
      }
      const reqNetRev    = targetEbit / (ebitPct as number);
      const factor       = reqNetRev / monthNetRev;
      const reqCogs      = monthCogs * factor;
      const reqPersonnel = persFixed ? monthPersonnel : monthPersonnel * factor;
      return { monthNetRev, monthCogs, monthPersonnel, monthGP1, monthGP2, monthEbit, cogsQuote, persQuote, targetEbit, hasInput, canCompute: true as const, reqNetRev, factor, reqCogs, reqPersonnel };
    });
  }, [yearResult.months, monthlyEbitInputs, persFixed]);

  const hochrechnungTotal = useMemo(() => {
    const active = hochrechnungMonths.filter(m => m.canCompute);
    const activeCogs      = active.reduce((s, m) => s + m.monthCogs,       0);
    const activePers      = active.reduce((s, m) => s + m.monthPersonnel,   0);
    const activeNetRev    = active.reduce((s, m) => s + m.monthNetRev,      0);
    const reqCogs         = active.reduce((s, m) => s + (m.reqCogs      ?? 0), 0);
    const reqPersonnel    = active.reduce((s, m) => s + (m.reqPersonnel  ?? 0), 0);
    return {
      reqNetRev:    active.reduce((s, m) => s + (m.reqNetRev ?? 0), 0),
      reqCogs,
      reqPersonnel,
      activeCogs,
      activePers,
      activeNetRev,
      deltaCogs:    reqCogs      - activeCogs,
      deltaPers:    reqPersonnel - activePers,
      targetEbit:   hochrechnungMonths.filter(m => m.hasInput).reduce((s, m) => s + (m.targetEbit ?? 0), 0),
      activeMonths: active.length,
    };
  }, [hochrechnungMonths]);

  const handleDistributeAnnual = useCallback(() => {
    const raw = annualDistribInput.trim().replace(/[''\s]/g, '').replace(',', '.');
    const annualTarget = parseFloat(raw);
    if (isNaN(annualTarget)) return;
    const monthNetRevs = yearResult.months.map(m => m.rows.find(r => r.def.id === 'net_revenue')?.values.actual ?? 0);
    const totalRev = monthNetRevs.reduce((s, v) => s + v, 0);
    setMonthlyEbitInputs(monthNetRevs.map(v => {
      if (totalRev <= 0 || v <= 0) return '';
      return String(Math.round(annualTarget * (v / totalRev)));
    }));
  }, [annualDistribInput, yearResult.months]);

  const yearMonthLabel   = excludeMonthIdx >= 0 ? `Jan–${MONTH_NAMES_DE[excludeMonthIdx] ?? ''}` : String(year);
  const yearKpis = [
    { label: 'Betriebsertrag netto', val: yearNetRevTotal, suffix: '' },
    { label: 'Bruttogewinn 1',       val: yearGP1Total,    suffix: yearNetRevTotal > 0 ? `(${(yearGP1Total / yearNetRevTotal * 100).toFixed(1)} %)` : '' },
    { label: 'Deckungsbeitrag',       val: yearGP2Total,    suffix: yearNetRevTotal > 0 ? `(${(yearGP2Total / yearNetRevTotal * 100).toFixed(1)} %)` : '' },
    { label: 'Betriebsergebnis EBIT', val: yearEbitTotal,   suffix: yearNetRevTotal > 0 ? `(${(yearEbitTotal / yearNetRevTotal * 100).toFixed(1)} %)` : '' },
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col">

      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-full px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link to="/">
              <Button variant="ghost" size="sm" className="h-8 px-2">
                <LayoutDashboard className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs hidden sm:inline">Dashboard</span>
              </Button>
            </Link>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <Link to="/reporting">
              <Button variant="ghost" size="sm" className="h-8 px-2">
                <TrendingUp className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs hidden sm:inline">Reporting</span>
              </Button>
            </Link>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <h1 className="text-sm font-bold flex items-center gap-1.5">
              <BarChart2 className="h-4 w-4 text-muted-foreground" />
              Erfolgsrechnung (P&L)
            </h1>
            <Badge variant="outline" className="text-[10px] border-purple-300 text-purple-700 bg-purple-50">
              Admin
            </Badge>
          </div>

          {/* Steuerung */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Ansicht */}
            <div className="flex rounded-md border border-border overflow-hidden text-xs">
              <button
                className={cn('px-2 py-1.5 flex items-center gap-1',
                  mode === 'budget_pl' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'
                )}
                onClick={() => setMode('budget_pl')}
              >
                <BarChart2 className="h-3 w-3" /><span className="hidden sm:inline">Budget P&L</span><span className="sm:hidden">Budg.</span>
              </button>
              <button
                className={cn('px-2 py-1.5 flex items-center gap-1',
                  mode === 'monthly' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'
                )}
                onClick={() => setMode('monthly')}
              >
                <Calendar className="h-3 w-3" /><span className="hidden sm:inline">Klassisch</span><span className="sm:hidden">Monat</span>
              </button>
              <button
                className={cn('px-2 py-1.5 flex items-center gap-1',
                  mode === 'yearly' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'
                )}
                onClick={() => setMode('yearly')}
              >
                <Table2 className="h-3 w-3" /> Jahr
              </button>
              <button
                className={cn('px-2 py-1.5 flex items-center gap-1',
                  mode === 'multi_year' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'
                )}
                onClick={() => setMode('multi_year')}
                data-testid="plview-mode-multi-year"
              >
                <TrendingUp className="h-3 w-3" /><span className="hidden sm:inline">Mehrjahre</span><span className="sm:hidden">MJ</span>
              </button>
              <button
                className={cn('px-2 py-1.5 flex items-center gap-1',
                  mode === 'mgmt_report' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'
                )}
                onClick={() => setMode('mgmt_report')}
                data-testid="plview-mode-mgmt-report"
              >
                <FileText className="h-3 w-3" /><span className="hidden sm:inline">Management Report</span><span className="sm:hidden">Report</span>
              </button>
              <button
                className={cn('px-2 py-1.5 flex items-center gap-1',
                  mode === 'bank_investor' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'
                )}
                onClick={() => setMode('bank_investor')}
                data-testid="plview-mode-bank-investor"
              >
                <Landmark className="h-3 w-3" /><span className="hidden sm:inline">Banken &amp; Investoren</span><span className="sm:hidden">Bank</span>
              </button>
            </div>

            {/* Jahr (nicht bei Mehrjahresanalyse/Report/Bankensicht — dort werden alle Jahre gezeigt) */}
            {mode !== 'multi_year' && mode !== 'mgmt_report' && mode !== 'bank_investor' && (
              <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
                <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                </SelectContent>
              </Select>
            )}

            {/* Periode: Monat / Quartal / Jahr (nur Budget P&L — Aggregat ist read-only) */}
            {mode === 'budget_pl' && (
              <div className="flex rounded-md border border-border overflow-hidden" role="group" aria-label="Periode">
                {(['month', 'quarter', 'year'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    data-testid={`plview-period-${p}`}
                    className={cn(
                      'h-8 px-2.5 text-xs transition-colors',
                      period === p
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-card hover:bg-muted text-muted-foreground',
                    )}
                  >
                    {p === 'month' ? 'Monat' : p === 'quarter' ? 'Quartal' : 'Jahr'}
                  </button>
                ))}
              </div>
            )}

            {mode === 'budget_pl' && period === 'quarter' && (
              <Select value={String(quarter)} onValueChange={v => setQuarter(Number(v))}>
                <SelectTrigger className="h-8 w-36 text-xs" data-testid="plview-quarter-select"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4].map(q => (
                    <SelectItem key={q} value={String(q)}>Q{q} · {QUARTER_RANGE_LABELS[q - 1]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {(mode === 'monthly' || (mode === 'budget_pl' && period === 'month')) && (
              <Select value={String(month)} onValueChange={v => setMonth(Number(v))}>
                <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MONTH_NAMES_DE.slice(1).map((name, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Konto hinzufügen (nur Monatsansicht — Quartal/Jahr ist read-only) */}
            {mode === 'budget_pl' && period === 'month' && (
              <button
                title="Konto zur Erfolgsrechnung hinzufügen"
                onClick={() => setAddKontoOpen(true)}
                className="h-8 px-2 flex items-center gap-1 rounded border text-xs transition-colors bg-card border-border hover:bg-muted text-muted-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Konto hinzufügen</span>
              </button>
            )}

            {/* «Ansicht»-Menü: Darstellung + %-Spalte + Vergleichsmodus (E002) */}
            {mode === 'budget_pl' && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 text-xs gap-1" data-testid="plview-view-options">
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Ansicht</span>
                    {(compact || highlightVariance || pctMode !== 'off' || effectiveCompareMode !== 'all') && (
                      <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-label="Ansichtsoptionen aktiv" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-60">
                  <DropdownMenuLabel className="text-xs">Darstellung</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    className="text-xs"
                    checked={compact}
                    onCheckedChange={v => setCompact(v === true)}
                    onSelect={e => e.preventDefault()}
                  >
                    Kompakter Zeilenabstand
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    className="text-xs"
                    checked={highlightVariance}
                    onCheckedChange={v => setHighlightVariance(v === true)}
                    onSelect={e => e.preventDefault()}
                  >
                    Abweichung &gt;10% hervorheben
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs">% Anteil am Umsatz</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={pctMode} onValueChange={v => setPctMode(v as 'off' | 'normal' | 'subtle')}>
                    <DropdownMenuRadioItem className="text-xs" value="off" onSelect={e => e.preventDefault()}>Ausgeblendet</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem className="text-xs" value="normal" onSelect={e => e.preventDefault()}>Anzeigen</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem className="text-xs" value="subtle" onSelect={e => e.preventDefault()}>Dezent</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs">Vergleich</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={effectiveCompareMode} onValueChange={v => setCompareMode(v as 'all' | 'ist_budget' | 'ist_vorjahr' | 'monat_vs_monat')}>
                    <DropdownMenuRadioItem className="text-xs" value="all" onSelect={e => e.preventDefault()}>Alles (Budget + Vorjahr)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem className="text-xs" value="ist_budget" onSelect={e => e.preventDefault()}>Ist vs Budget</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem className="text-xs" value="ist_vorjahr" onSelect={e => e.preventDefault()}>Ist vs Vorjahr</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem
                      className="text-xs"
                      value="monat_vs_monat"
                      disabled={period !== 'month'}
                      onSelect={e => e.preventDefault()}
                      title={period !== 'month' ? 'Nur in der Monatsansicht verfügbar' : undefined}
                    >
                      Ist vs anderer Monat
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* % Anteil am Umsatz */}
            {/* Laufenden Monat ausschliessen (nur Jahresansicht, nur laufendes Jahr) */}
            {mode === 'yearly' && year === currentYear && (
              <button
                title={excludeCurrentMonth
                  ? `${MONTH_NAMES_DE[currentMonth]} wieder einschliessen (Total = alle Monate)`
                  : `${MONTH_NAMES_DE[currentMonth]} (laufender Monat) vom Total ausschliessen – vermeidet Verzerrung durch unvollständige Daten`}
                onClick={() => setExcludeCurrentMonth(v => !v)}
                className={cn(
                  'h-8 px-2 flex items-center gap-1 rounded border text-xs transition-colors',
                  excludeCurrentMonth
                    ? 'bg-orange-500 text-white border-orange-500'
                    : 'bg-card border-border hover:bg-muted text-muted-foreground',
                )}
              >
                <span className="hidden sm:inline">
                  {excludeCurrentMonth ? `Ohne ${MONTH_NAMES_DE[currentMonth]}` : `${MONTH_NAMES_DE[currentMonth]} ausschl.`}
                </span>
                <span className="sm:hidden">⊘ Mtl.</span>
              </button>
            )}

            {mode === 'yearly' && (
              <button
                title={
                  pctMode === 'off'
                    ? '% Anteil am Umsatz einblenden'
                    : pctMode === 'normal'
                    ? 'Dezent anzeigen'
                    : '% Spalte ausblenden'
                }
                onClick={() => setPctMode(m => m === 'off' ? 'normal' : m === 'normal' ? 'subtle' : 'off')}
                className={cn(
                  'h-8 px-2 flex items-center gap-1 rounded border text-xs transition-colors',
                  pctMode === 'normal' && !pctIsBudgetBased
                    ? 'bg-amber-500 text-white border-amber-500'
                    : pctMode === 'normal' && pctIsBudgetBased
                    ? 'bg-slate-500 text-white border-slate-500'
                    : pctMode === 'subtle'
                    ? 'bg-card border-slate-300 dark:border-slate-600 text-muted-foreground'
                    : 'bg-card border-border hover:bg-muted text-muted-foreground',
                )}
              >
                <span className={cn(
                  'font-mono font-bold',
                  pctMode === 'subtle' ? 'italic opacity-50 text-[10px]' : 'text-xs',
                )}>%</span>
                <span className="hidden sm:inline">
                  {pctMode === 'subtle' ? 'Dezent' : pctIsBudgetBased && pctMode !== 'off' ? '% Budget' : '% Anteil'}
                </span>
              </button>
            )}
            {pctIsBudgetBased && pctMode !== 'off' && (
              <span className="text-[10px] text-slate-500 dark:text-slate-400 italic hidden sm:inline" title="Kein Ist-Umsatz erfasst – Prozente basieren auf dem Budget-Umsatz">
                ⚠ % vom Budget
              </span>
            )}

            {/* Vergleichsmonat-Selektor (nur Monat-vs-Monat, nur Monatsansicht) */}
            {mode === 'budget_pl' && period === 'month' && compareMode === 'monat_vs_monat' && (
              <>
                <Select value={String(cmpYear)} onValueChange={v => setCmpYear(Number(v))}>
                  <SelectTrigger className="h-8 w-20 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[year - 1, year].map(y => (
                      <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={String(cmpMonth)} onValueChange={v => setCmpMonth(Number(v))}>
                  <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES_DE.slice(1).map((name, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}

            {/* Analyse-Link */}
            <Link to="/reporting">
              <Button
                variant="outline" size="sm"
                className="h-8 text-xs gap-1 border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-300"
                title="Zur Analyse-Seite (Umsatz, PK-Quote, Warenaufwand, Charts)"
              >
                <TrendingUp className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Analyse</span>
              </Button>
            </Link>

            {/* PDF Export – alle 3 Ansichten (öffnet den bestehenden Export-Dialog) */}
            <UnifiedExportButton
              actions={[
                { key: 'pdf', label: 'PDF (alle 3 Ansichten)', kind: 'pdf', onSelect: handleExportPDF },
              ]}
            />
          </div>
        </div>
      </header>

      <div className="flex-1 px-4 py-5 space-y-5 pb-20 max-w-full">

        {/* Stichtag-Hinweisbanner */}
        <StichtagBanner />

        {/* Vorjahres-Diagnose-Hinweis (nur Sichtbarkeit, keine Berechnung) */}
        {priorYearDiag.message && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm',
              priorYearDiag.status === 'none'
                ? 'border-amber-300 bg-amber-50 text-amber-800'
                : 'border-blue-300 bg-blue-50 text-blue-800',
            )}
            role="status"
          >
            <Info className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{priorYearDiag.message}</span>
          </div>
        )}

        {/* E006/E007: KPI-Leiste aus der Financial-Metrics-Registry (max. 4 sichtbar, EBIT unter «Mehr») */}
        {(mode === 'monthly' || mode === 'budget_pl') && registryKpis && (
          <div className="space-y-2" data-testid="plview-kpi-bar">
            <KpiGrid>
              {registryKpis.slice(0, 4).map(renderRegistryKpiCard)}
            </KpiGrid>
            <MoreKpis storageKey="plview-more-kpis">
              <KpiGrid>
                {registryKpis.slice(4).map(renderRegistryKpiCard)}
              </KpiGrid>
            </MoreKpis>
          </div>
        )}

        {/* E008: Mini-Jahresvergleich (lazy; Details in der Mehrjahresanalyse) */}
        {mode === 'budget_pl' && (
          <div className="rounded-lg border border-border bg-card">
            <button
              type="button"
              onClick={() => setMiniYearsOpen(v => !v)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              data-testid="plview-mini-years-toggle"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !miniYearsOpen && '-rotate-90')} />
              Jahresvergleich {year - 2}–{year}
              <span className="font-normal opacity-70">· Umsatz mit Δ zum Vorjahr</span>
            </button>
            {miniYearsOpen && miniYearCompare && (
              <div className="border-t border-border px-3 py-2">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="py-1 text-left font-medium">Jahr</th>
                      <th className="py-1 text-right font-medium">Umsatz (CHF)</th>
                      <th className="py-1 text-right font-medium">Δ Vorjahr</th>
                      <th className="py-1 text-right font-medium">Trend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {miniYearCompare.map(r => (
                      <tr key={r.year} className="border-t border-border/50" data-testid={`plview-mini-year-${r.year}`}>
                        <td className="py-1.5 font-medium">
                          {r.year}
                          {r.revenue !== null && r.months < 12 && (
                            <span className="ml-1 text-[10px] text-muted-foreground">({r.months} Mte)</span>
                          )}
                        </td>
                        <td className="py-1.5 text-right font-mono tabular-nums">{r.revenue !== null ? fmt(r.revenue) : '—'}</td>
                        <td className={cn(
                          'py-1.5 text-right font-mono tabular-nums',
                          r.delta === null ? 'text-muted-foreground' : r.delta >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600',
                        )}>
                          {r.delta !== null ? (
                            <>
                              {r.delta >= 0 ? '+' : ''}{fmt(r.delta)}
                              {r.deltaPct !== null && (
                                <span className="ml-1 opacity-70">({r.deltaPct >= 0 ? '+' : ''}{r.deltaPct.toFixed(1)} %)</span>
                              )}
                            </>
                          ) : '—'}
                        </td>
                        <td className="py-1.5 text-right">
                          {r.delta === null ? '—' : r.delta > 0 ? '↑' : r.delta < 0 ? '↓' : '→'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>Teiljahre sind markiert; Jahre ohne Daten bleiben «—» (keine Hochrechnung).</span>
                  <button
                    type="button"
                    className="underline hover:text-foreground whitespace-nowrap"
                    onClick={() => setMode('multi_year')}
                    data-testid="plview-mini-years-details-link"
                  >
                    Details in der Mehrjahresanalyse
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* KPI-Karten Jahresansicht */}
        {mode === 'yearly' && (
          <>
            {/* Info-Banner wenn laufender Monat ausgeschlossen */}
            {excludeCurrentMonth && year === currentYear && (
              <div className="rounded-lg border border-orange-200 bg-orange-50 dark:border-orange-800 dark:bg-orange-950/20 px-4 py-2.5 flex items-center gap-2 text-xs text-orange-800 dark:text-orange-300">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                <span>
                  <strong>{MONTH_NAMES_DE[currentMonth]}</strong> (laufender Monat) ist vom Total ausgeschlossen —
                  Jahressumme zeigt <strong>{yearMonthLabel}</strong> (nur abgeschlossene Monate).
                  Der Monat bleibt als Spalte sichtbar, wird aber nicht summiert.
                </span>
              </div>
            )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {yearKpis.map(kpi => {
              const isPositive = kpi.val >= 0;
              const hasData = kpi.val !== 0;
              return (
                <Card key={kpi.label} className={cn(
                  'border',
                  hasData
                    ? isPositive ? 'border-emerald-200 dark:border-emerald-800' : 'border-red-200 dark:border-red-800'
                    : 'border-border',
                )}>
                  <CardContent className="p-3">
                    <p className="text-[11px] text-muted-foreground mb-1 leading-tight">{kpi.label}</p>
                    <p className="text-[9px] text-orange-500 mb-0.5">{excludeCurrentMonth && year === currentYear ? yearMonthLabel : ''}</p>
                    {hasData ? (
                      <>
                        <p className={cn('text-lg font-bold', isPositive ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600')}>
                          {fmt(kpi.val)}
                        </p>
                        <p className="text-[10px] text-muted-foreground">{kpi.suffix || 'CHF'}</p>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground/50 italic">Keine Daten</p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
          </>
        )}

        {/* Datenvollständigkeit-Hinweis (monatsbezogen — bei Quartal/Jahr übernimmt der Coverage-Badge)
            Zeigt sich NUR, wenn wirklich keine Daten vorliegen: weder P&L-hasData, noch
            ein effektiver Ist-Umsatz (revenueActual), noch kanonischer IST-Umsatz aus
            gn_imports (canonicalRevenue) für diesen Monat. Verhindert den Banner, wenn ein
            Ist-Wert (Tages-Z-Berichte) angezeigt wird. */}
        {(mode === 'monthly' || (mode === 'budget_pl' && period === 'month'))
          && !monthResult.hasData
          && !effectiveMonthRecord?.revenueActual
          && !canonicalRevenue[month]?.hasData && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-4 flex items-start gap-3">
            <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-amber-800 dark:text-amber-300">
              <p className="font-semibold">Noch keine Daten für {MONTH_NAMES_DE[month]} {year}</p>
              <p className="mt-0.5">Erfassen Sie die Monatsdaten unter{' '}
                <Link to="/reporting" className="underline font-medium">Reporting → Monatsdaten erfassen</Link>.
                Nach der Dateneingabe erscheint hier die vollständige Erfolgsrechnung.
              </p>
            </div>
          </div>
        )}

        {/* Kein Ist-Umsatz – inline Schnelleingabe (nur wenn KEINE Quelle vorhanden; Schreibpfad → nur Monatsansicht) */}
        {(mode === 'monthly' || (mode === 'budget_pl' && period === 'month')) && monthResult.hasData && !effectiveMonthRecord?.revenueActual && (
          <InlineRevenueEntry
            year={year}
            month={month}
            onSaved={() => setRefreshKey(k => k + 1)}
          />
        )}

        {/* ── Marketing/Maison Umsatzkanal (monatsbezogen → nur Monatsansicht) ── */}
        {(mode === 'monthly' || (mode === 'budget_pl' && period === 'month')) && maisonColPref && (
          <div className={cn(
            'rounded-lg border px-4 py-3 flex items-center gap-3 flex-wrap',
            maisonEnabled
              ? 'border-violet-200 bg-violet-50 dark:border-violet-800 dark:bg-violet-950/20'
              : 'border-border bg-muted/20',
          )}>
            {/* Toggle */}
            <button
              onClick={handleMaisonToggle}
              className="flex items-center gap-2 shrink-0 group"
              title={maisonEnabled ? 'Marketing deaktivieren' : 'Marketing aktivieren'}
            >
              <span className={cn(
                'h-5 w-9 rounded-full border-2 transition-all duration-200 relative block',
                maisonEnabled
                  ? 'border-violet-500 bg-violet-500'
                  : 'border-muted-foreground/30 bg-muted/50',
              )}>
                <span className={cn(
                  'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200',
                  maisonEnabled ? 'translate-x-[14px] left-0.5' : 'translate-x-0 left-0.5',
                )} />
              </span>
              <span className={cn(
                'text-xs font-semibold',
                maisonEnabled ? 'text-violet-700 dark:text-violet-400' : 'text-muted-foreground',
              )}>Maison</span>
            </button>

            {maisonEnabled ? (
              <>
                <span className="text-xs text-violet-700 dark:text-violet-400">
                  {maisonMonthNet > 0
                    ? `${MONTH_NAMES_DE[month]} ${year}: ${Math.round(maisonMonthNet).toLocaleString('de-CH')} CHF netto — in Betriebsertrag eingerechnet`
                    : `Keine Marketing-Tagesdaten für ${MONTH_NAMES_DE[month]} ${year} — Werte im Tages-Controlling erfassen`}
                </span>
                {/* Unterzeile-Toggle: Marketing-Aufschlüsselung in der Tabelle ein-/ausblenden */}
                <button
                  onClick={() => setShowMarketingRow(v => !v)}
                  className="flex items-center gap-2 shrink-0 group ml-auto"
                  title={showMarketingRow ? 'Marketing-Zeile ausblenden' : 'Marketing-Zeile in der Tabelle anzeigen'}
                >
                  <span className={cn(
                    'h-5 w-9 rounded-full border-2 transition-all duration-200 relative block',
                    showMarketingRow
                      ? 'border-violet-500 bg-violet-500'
                      : 'border-muted-foreground/30 bg-muted/50',
                  )}>
                    <span className={cn(
                      'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200',
                      showMarketingRow ? 'translate-x-[14px] left-0.5' : 'translate-x-0 left-0.5',
                    )} />
                  </span>
                  <span className={cn(
                    'text-xs font-semibold',
                    showMarketingRow ? 'text-violet-700 dark:text-violet-400' : 'text-muted-foreground',
                  )}>Marketing anzeigen</span>
                </button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                Aktivieren um Marketing-Umsatz in Betriebsertrag einzurechnen (Tageswerte aus Tages-Controlling)
              </span>
            )}
          </div>
        )}

        {/* Mehrjahresanalyse (Banken-/Investorensicht) */}
        {mode === 'multi_year' && multiYearSeries && (
          <MultiYearAnalysisSection
            series={multiYearSeries}
            restaurantName={tenant.shortName}
            dataSourceHints={[MULTI_YEAR_DATA_SOURCE_HINT]}
          />
        )}

        {/* Management Report (Live-Ansicht, gleiche Datenbasis wie Mehrjahresanalyse) */}
        {mode === 'mgmt_report' && multiYearSeries && (
          <ManagementReportView
            series={multiYearSeries}
            restaurantName={tenant.shortName}
            dataSourceHints={[MULTI_YEAR_DATA_SOURCE_HINT]}
          />
        )}

        {/* Banken & Investoren (gleiche Datenbasis wie Mehrjahresanalyse) */}
        {mode === 'bank_investor' && multiYearSeries && (
          <BankInvestorView
            key={tenantId}
            series={multiYearSeries}
            restaurantName={tenant.shortName}
            unmappedAccounts={bankImportInfo.unmappedAccounts}
            importStand={bankImportInfo.importStand}
            importInfoByYear={bankImportInfo.importInfoByYear}
          />
        )}

        {/* P&L-Tabelle */}
        {mode !== 'multi_year' && mode !== 'mgmt_report' && mode !== 'bank_investor' && (
        <div className="rounded-lg border border-border overflow-hidden shadow-sm">
          {/* Tabellen-Header */}
          <div className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold">
                {mode === 'budget_pl'
                  ? `Budget-P&L Vergleich – ${
                      period === 'month' ? `${MONTH_NAMES_DE[month]} ${year}`
                      : period === 'quarter' ? `Q${quarter} ${year} (${QUARTER_RANGE_LABELS[quarter - 1]})`
                      : `Jahr ${year}`}`
                  : mode === 'monthly'
                  ? `Erfolgsrechnung – ${MONTH_NAMES_DE[month]} ${year}`
                  : `Erfolgsrechnung – Jahresübersicht ${year}`}
              </h2>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {mode === 'budget_pl'
                  ? period !== 'month'
                    ? 'Summe der Monatswerte · nur Lesen — Bearbeitung in der Monatsansicht'
                    : effectiveCompareMode === 'ist_budget'
                    ? 'Ist vs Budget · Abweichungen – Budget-Hierarchie mit Kontonummern'
                    : effectiveCompareMode === 'ist_vorjahr'
                    ? 'Ist vs Vorjahr · Abweichungen – Budget-Hierarchie mit Kontonummern'
                    : 'Ist · Budget · Vorjahr · Abweichungen – Budget-Hierarchie mit Kontonummern'
                  : mode === 'monthly'
                  ? 'Ist / Budget / Vorjahr inkl. Abweichungen'
                  : 'Alle 12 Monate + Jahressumme · Klick auf Monatsspalte → Monatsansicht'}
              </p>
            </div>
            <div className="text-[10px] text-slate-400">
              {mode === 'budget_pl' && period !== 'month' && periodAgg ? (
                <span className="flex items-center gap-1" data-testid="bpl-period-coverage">
                  <Database className="h-3 w-3 text-emerald-400" />
                  Ist-Daten in {periodAgg.monthsWithData} von {periodAgg.monthsTotal} Monaten
                </span>
              ) : (mode === 'monthly' || mode === 'budget_pl') && monthResult.hasData && (
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                  Ist-Daten vorhanden
                </span>
              )}
            </div>
          </div>

          {/* Tabelle */}
          {mode === 'budget_pl'
            ? <BudgetPLView
                rows={displayBplRows}
                onRowClick={row => {
                  // Quartal/Jahr: Drilldown-Dialoge sind monatsgebunden (saveMonth-Writes) → deaktiviert
                  if (period !== 'month') return;
                  if (row.isCategory || row.catId === 'pl_revenue') {
                    setBplDrilldown(row);
                  } else {
                    setAccountAction(row);
                  }
                }}
                compact={compact}
                onDeleteItem={period === 'month' ? itemId => {
                  deletePLLineItem(year, itemId, tenantKey(BUDGET_STORAGE_KEY));
                  setRefreshKey(k => k + 1);
                } : undefined}
                month={month}
                year={year}
                onSaved={() => setRefreshKey(k => k + 1)}
                highlightVariance={highlightVariance}
                pctMode={pctMode}
                revenueActual={bplEffectiveRevenue}
                revenueBudget={bplBudgetRevenue}
                revenuePrevYear={bplPrevYearRevenue}
                compareMode={effectiveCompareMode}
                pctIsBudgetBased={pctIsBudgetBased}
                maisonEnabled={maisonEnabled && maisonColPref && period === 'month' && showMarketingRow}
                maisonNet={maisonMonthNet}
                prevYearLabel={prevYearColLabel}
                readOnly={period !== 'month'}
                onBudgetEdit={period === 'month' ? (catId, monthIdx, budgetVal) => {
                  const catLabel = displayBplRows.find(r => r.catId === catId && r.catType === 'result' && r.isCategory)?.catLabel ?? catId;
                  setBplTopDownDialog({ catId, catLabel, monthIdx, monthBudgetTotal: budgetVal });
                  setBplTopDownInput('');
                  setBplTopDownMode('chf');
                } : undefined}
                isMobile={isMobile}
              />
            : mode === 'monthly'
            ? <MonthlyView result={monthResult} onDrilldown={handleDrilldown} />
            : <YearView results={yearResult.months} onClickMonth={handleYearMonthClick} pctMode={pctMode} revenueTotal={yearNetRevTotal} excludeMonthIdx={excludeMonthIdx} />
          }
        </div>
        )}

        {/* ── Hochrechnung: Betriebsergebnis → Nettoumsatz (pro Monat) ───────── */}
        {mode === 'yearly' && (
          <div className="rounded-lg border border-indigo-200 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/20 overflow-hidden shadow-sm">
            <div className="bg-indigo-700 text-white px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
              <button onClick={() => setHochYearOpen(v => !v)} className="flex items-center gap-2 text-left hover:opacity-80 transition-opacity">
                <ChevronDown className={`h-4 w-4 shrink-0 transition-transform duration-200 ${hochYearOpen ? '' : '-rotate-90'}`} />
                <TrendingUp className="h-4 w-4 shrink-0" />
                <div>
                  <h3 className="text-sm font-bold">Hochrechnung — Betriebsergebnis auf Nettoumsatz</h3>
                  <p className="text-[11px] text-indigo-200">Ziel-EBIT pro Monat eingeben → erforderlicher Nettoumsatz bei gleichen %-Sätzen</p>
                </div>
              </button>
              {/* Jahreswert-Verteiler */}
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-indigo-200 whitespace-nowrap">Jahreswert verteilen:</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="z.B. 300000"
                  value={annualDistribInput}
                  onChange={e => setAnnualDistribInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleDistributeAnnual()}
                  className="h-7 w-32 border border-indigo-400 rounded px-2 text-xs text-right bg-white/10 text-white placeholder-indigo-300 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                />
                <button
                  onClick={handleDistributeAnnual}
                  className="h-7 px-2.5 rounded bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-semibold transition-colors whitespace-nowrap"
                >
                  Proportional verteilen
                </button>
                <button
                  disabled={!monthlyEbitInputs.some(v => v !== '') && annualDistribInput === ''}
                  onClick={() => { setMonthlyEbitInputs(Array(12).fill('')); setAnnualDistribInput(''); }}
                  className="h-7 px-2 rounded border border-indigo-400 text-indigo-200 hover:text-white text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Zurücksetzen
                </button>
                <label className="flex items-center gap-1.5 text-[11px] text-indigo-200 cursor-pointer select-none border border-indigo-400 rounded px-2 py-1 hover:border-indigo-300 transition-colors">
                  <input type="checkbox" checked={persFixed} onChange={e => setPersFixed(e.target.checked)} className="h-3 w-3 accent-indigo-400" />
                  PK CHF fixieren
                </label>
              </div>
            </div>

            {hochYearOpen && (<>
            {/* Zusammenfassung (nur wenn mind. 1 Monat hat Eingabe) */}
            {hochrechnungTotal.activeMonths > 0 && (
              <div className="bg-indigo-100 dark:bg-indigo-900/30 px-4 py-2 flex flex-wrap gap-x-6 gap-y-0.5 text-xs border-b border-indigo-200 dark:border-indigo-700">
                <span>
                  <span className="text-muted-foreground">Ziel-EBIT ({hochrechnungTotal.activeMonths} Monate): </span>
                  <strong className="text-indigo-900 dark:text-indigo-200">CHF {Math.round(hochrechnungTotal.targetEbit).toLocaleString('de-CH')}</strong>
                </span>
                <span>
                  <span className="text-muted-foreground">Ziel-Nettoumsatz: </span>
                  <strong className="text-indigo-900 dark:text-indigo-200">CHF {Math.round(hochrechnungTotal.reqNetRev).toLocaleString('de-CH')}</strong>
                </span>
                <span>
                  <span className="text-muted-foreground">Ziel-Warenaufwand: </span>
                  <strong className="text-amber-800 dark:text-amber-300">CHF {Math.round(hochrechnungTotal.reqCogs).toLocaleString('de-CH')}</strong>
                </span>
                <span>
                  <span className="text-muted-foreground">Δ Umsatz <span className="text-[10px] opacity-70">(Ziel−Ist)</span>: </span>
                  <strong className={hochrechnungTotal.reqNetRev >= hochrechnungTotal.activeNetRev ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}>
                    {hochrechnungTotal.reqNetRev >= hochrechnungTotal.activeNetRev ? '+' : ''}{Math.round(hochrechnungTotal.reqNetRev - hochrechnungTotal.activeNetRev).toLocaleString('de-CH')} CHF
                  </strong>
                </span>
              </div>
            )}

            {/* Haupttabelle */}
            <div className="overflow-x-auto p-3">
              <table className="text-[11px] border-collapse w-full" style={{ minWidth: '1050px' }}>
                <thead>
                  <tr className="bg-indigo-700 text-white">
                    <th className="text-left px-2 py-1.5 sticky left-0 bg-indigo-700 z-10 min-w-[155px]">Position</th>
                    {MONTH_NAMES_SHORT_DE.slice(1).map(m => (
                      <th key={m} className="text-right px-1.5 py-1.5 whitespace-nowrap font-normal">{m}</th>
                    ))}
                    <th className="text-right px-2 py-1.5 font-bold bg-indigo-800 whitespace-nowrap">Total</th>
                  </tr>
                </thead>
                <tbody>

                  {/* ── Eingabezeile: Ziel EBIT ── */}
                  <tr className="bg-indigo-50 dark:bg-indigo-950/30 border-b-2 border-indigo-300 dark:border-indigo-600">
                    <td className="px-2 py-1 font-semibold text-indigo-800 dark:text-indigo-300 sticky left-0 bg-indigo-50 dark:bg-indigo-950/30 z-10">
                      Ziel EBIT (CHF)
                    </td>
                    {hochrechnungMonths.map((m, i) => (
                      <td key={i} className="px-1 py-0.5">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={monthlyEbitInputs[i] ?? ''}
                          onChange={e => {
                            const next = [...monthlyEbitInputs];
                            next[i] = e.target.value;
                            setMonthlyEbitInputs(next);
                          }}
                          placeholder={m.monthNetRev > 0 ? String(Math.round(m.monthEbit)) : '–'}
                          className={cn(
                            'w-full h-6 rounded px-1.5 text-right text-[11px] tabular-nums border focus:outline-none focus:ring-1 focus:ring-indigo-400',
                            m.hasInput
                              ? 'border-indigo-400 bg-white dark:bg-background text-indigo-900 dark:text-indigo-100 font-semibold'
                              : 'border-slate-200 bg-white/60 dark:bg-background/40 text-muted-foreground',
                          )}
                        />
                      </td>
                    ))}
                    <td className="text-right px-2 py-1 tabular-nums font-bold text-indigo-800 dark:text-indigo-200 bg-indigo-100 dark:bg-indigo-900/40">
                      {hochrechnungTotal.activeMonths > 0 ? Math.round(hochrechnungTotal.targetEbit).toLocaleString('de-CH') : '–'}
                    </td>
                  </tr>

                  {/* ── Ist EBIT (Referenz) ── */}
                  <tr className="bg-white dark:bg-background">
                    <td className="px-2 py-1 text-muted-foreground pl-5 sticky left-0 bg-white dark:bg-background z-10">EBIT Ist</td>
                    {hochrechnungMonths.map((m, i) => (
                      <td key={i} className="text-right px-1.5 py-1 tabular-nums text-muted-foreground">
                        {m.monthNetRev > 0 ? Math.round(m.monthEbit).toLocaleString('de-CH') : '–'}
                      </td>
                    ))}
                    <td className="text-right px-2 py-1 tabular-nums text-muted-foreground bg-slate-50 dark:bg-slate-900/20">
                      {Math.round(yearEbitTotal).toLocaleString('de-CH')}
                    </td>
                  </tr>

                  {/* ── Nettoumsatz Ist ── */}
                  <tr className="bg-slate-50 dark:bg-slate-900/20">
                    <td className="px-2 py-1 text-muted-foreground sticky left-0 bg-slate-50 dark:bg-slate-900/20 z-10">Nettoumsatz Ist</td>
                    {hochrechnungMonths.map((m, i) => (
                      <td key={i} className="text-right px-1.5 py-1 tabular-nums text-muted-foreground">
                        {m.monthNetRev > 0 ? Math.round(m.monthNetRev).toLocaleString('de-CH') : '–'}
                      </td>
                    ))}
                    <td className="text-right px-2 py-1 tabular-nums text-muted-foreground bg-slate-100 dark:bg-slate-800/30">
                      {Math.round(yearNetRevTotal).toLocaleString('de-CH')}
                    </td>
                  </tr>

                  {/* ── Nettoumsatz Ziel ── */}
                  <tr className="bg-indigo-100 dark:bg-indigo-900/30 font-bold text-indigo-800 dark:text-indigo-200 border-b border-indigo-200 dark:border-indigo-700">
                    <td className="px-2 py-1.5 sticky left-0 bg-indigo-100 dark:bg-indigo-900/30 z-10">Nettoumsatz Ziel</td>
                    {hochrechnungMonths.map((m, i) => (
                      <td key={i} className="text-right px-1.5 py-1.5 tabular-nums">
                        {m.canCompute ? Math.round(m.reqNetRev!).toLocaleString('de-CH') : (m.hasInput ? <span className="text-red-500 font-normal text-[10px]">n/a</span> : '–')}
                      </td>
                    ))}
                    <td className="text-right px-2 py-1.5 tabular-nums bg-indigo-200 dark:bg-indigo-800/50">
                      {hochrechnungTotal.activeMonths > 0 ? Math.round(hochrechnungTotal.reqNetRev).toLocaleString('de-CH') : '–'}
                    </td>
                  </tr>

                  {/* ── Skalierungsfaktor ── */}
                  <tr className="bg-white dark:bg-background text-[10px]">
                    <td className="px-2 py-1 text-muted-foreground pl-5 sticky left-0 bg-white dark:bg-background z-10">Faktor</td>
                    {hochrechnungMonths.map((m, i) => (
                      <td key={i} className={cn(
                        'text-right px-1.5 py-1 tabular-nums',
                        m.canCompute
                          ? m.factor! >= 1 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'
                          : 'text-muted-foreground/40',
                      )}>
                        {m.canCompute ? `${m.factor!.toFixed(2)}×` : '–'}
                      </td>
                    ))}
                    <td className="text-right px-2 py-1 tabular-nums text-muted-foreground bg-slate-50 dark:bg-slate-900/20">–</td>
                  </tr>

                  {/* ── Warenaufwand Ist ── */}
                  <tr className="bg-slate-50 dark:bg-slate-900/20">
                    <td className="px-2 py-1 text-muted-foreground pl-5 sticky left-0 bg-slate-50 dark:bg-slate-900/20 z-10">Warenaufwand Ist</td>
                    {hochrechnungMonths.map((m, i) => (
                      <td key={i} className="text-right px-1.5 py-1 tabular-nums text-muted-foreground">
                        {m.monthCogs > 0 ? Math.round(m.monthCogs).toLocaleString('de-CH') : '–'}
                      </td>
                    ))}
                    <td className="text-right px-2 py-1 tabular-nums text-muted-foreground bg-slate-100 dark:bg-slate-800/30">
                      {Math.round(yearCogsTotal).toLocaleString('de-CH')}
                    </td>
                  </tr>

                  {/* ── Warenquote % ── */}
                  <tr className="bg-white dark:bg-background text-[10px]">
                    <td className="px-2 py-0.5 text-amber-600 dark:text-amber-400 pl-5 sticky left-0 bg-white dark:bg-background z-10 whitespace-nowrap">
                      Warenquote <span className="text-muted-foreground font-normal">(skaliert 1:1)</span>
                    </td>
                    {hochrechnungMonths.map((m, i) => (
                      <td key={i} className="text-right px-1.5 py-0.5 tabular-nums text-amber-600 dark:text-amber-400">
                        {m.cogsQuote !== null ? `${m.cogsQuote.toFixed(1)} %` : '–'}
                      </td>
                    ))}
                    <td className="text-right px-2 py-0.5 tabular-nums text-amber-600 dark:text-amber-400 bg-slate-50 dark:bg-slate-900/20">
                      {yearNetRevTotal > 0 ? `${(yearCogsTotal / yearNetRevTotal * 100).toFixed(1)} %` : '–'}
                    </td>
                  </tr>

                  {/* ── Warenaufwand Ziel ── */}
                  <tr className="bg-amber-50 dark:bg-amber-950/20 font-semibold text-amber-800 dark:text-amber-300">
                    <td className="px-2 py-1.5 pl-5 sticky left-0 bg-amber-50 dark:bg-amber-950/20 z-10">Warenaufwand Ziel</td>
                    {hochrechnungMonths.map((m, i) => (
                      <td key={i} className="text-right px-1.5 py-1.5 tabular-nums">
                        {m.canCompute ? Math.round(m.reqCogs!).toLocaleString('de-CH') : '–'}
                      </td>
                    ))}
                    <td className="text-right px-2 py-1.5 tabular-nums bg-amber-100 dark:bg-amber-900/30">
                      {hochrechnungTotal.activeMonths > 0 ? Math.round(hochrechnungTotal.reqCogs).toLocaleString('de-CH') : '–'}
                    </td>
                  </tr>

                  {/* ── Δ Warenaufwand ── */}
                  <tr className="bg-white dark:bg-background text-[11px]">
                    <td className="px-2 py-0.5 pl-8 text-amber-700 dark:text-amber-500 italic sticky left-0 bg-white dark:bg-background z-10">davon Veränderung</td>
                    {hochrechnungMonths.map((m, i) => {
                      if (!m.canCompute) return <td key={i} className="text-right px-1.5 py-0.5 text-muted-foreground">–</td>;
                      const delta = m.reqCogs! - m.monthCogs;
                      const pct = m.monthCogs > 0 ? delta / m.monthCogs * 100 : null;
                      const pos = delta > 0;
                      return (
                        <td key={i} className={`text-right px-1.5 py-0.5 tabular-nums font-medium ${pos ? 'text-orange-600 dark:text-orange-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                          {pos ? '+' : ''}{Math.round(delta).toLocaleString('de-CH')}
                          {pct !== null && <span className="ml-0.5 text-[9px] opacity-75">({pos ? '+' : ''}{pct.toFixed(1)}%)</span>}
                        </td>
                      );
                    })}
                    <td className="text-right px-2 py-0.5 tabular-nums bg-slate-50 dark:bg-slate-900/20">
                      {hochrechnungTotal.activeMonths > 0 ? (() => {
                        const delta = hochrechnungTotal.deltaCogs;
                        const pct = hochrechnungTotal.activeCogs > 0 ? delta / hochrechnungTotal.activeCogs * 100 : null;
                        const pos = delta > 0;
                        return <span className={`font-medium ${pos ? 'text-orange-600 dark:text-orange-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                          {pos ? '+' : ''}{Math.round(delta).toLocaleString('de-CH')}{pct !== null ? ` (${pos ? '+' : ''}${pct.toFixed(1)}%)` : ''}
                        </span>;
                      })() : '–'}
                    </td>
                  </tr>

                  {/* ── Personalkosten Ist ── */}
                  <tr className="bg-slate-50 dark:bg-slate-900/20">
                    <td className="px-2 py-1 text-muted-foreground pl-5 sticky left-0 bg-slate-50 dark:bg-slate-900/20 z-10">Personalkosten Ist</td>
                    {hochrechnungMonths.map((m, i) => (
                      <td key={i} className="text-right px-1.5 py-1 tabular-nums text-muted-foreground">
                        {m.monthPersonnel > 0 ? Math.round(m.monthPersonnel).toLocaleString('de-CH') : '–'}
                      </td>
                    ))}
                    <td className="text-right px-2 py-1 tabular-nums text-muted-foreground bg-slate-100 dark:bg-slate-800/30">
                      {Math.round(yearPersonnelTotal).toLocaleString('de-CH')}
                    </td>
                  </tr>

                  {/* ── Personalkostenquote % ── */}
                  <tr className="bg-white dark:bg-background text-[10px]">
                    <td className="px-2 py-0.5 text-blue-600 dark:text-blue-400 pl-5 sticky left-0 bg-white dark:bg-background z-10 whitespace-nowrap">
                      Personalkostenquote <span className="text-muted-foreground font-normal">{persFixed ? '(CHF fixiert)' : '(gleiche Quote)'}</span>
                    </td>
                    {hochrechnungMonths.map((m, i) => (
                      <td key={i} className="text-right px-1.5 py-0.5 tabular-nums text-blue-600 dark:text-blue-400">
                        {m.persQuote !== null ? `${m.persQuote.toFixed(1)} %` : '–'}
                      </td>
                    ))}
                    <td className="text-right px-2 py-0.5 tabular-nums text-blue-600 dark:text-blue-400 bg-slate-50 dark:bg-slate-900/20">
                      {yearNetRevTotal > 0 ? `${(yearPersonnelTotal / yearNetRevTotal * 100).toFixed(1)} %` : '–'}
                    </td>
                  </tr>

                  {/* ── Personalkosten Ziel ── */}
                  <tr className="bg-blue-50 dark:bg-blue-950/20 font-semibold text-blue-800 dark:text-blue-300">
                    <td className="px-2 py-1.5 pl-5 sticky left-0 bg-blue-50 dark:bg-blue-950/20 z-10">Personalkosten Ziel</td>
                    {hochrechnungMonths.map((m, i) => (
                      <td key={i} className="text-right px-1.5 py-1.5 tabular-nums leading-tight">
                        {m.canCompute ? (
                          <>
                            {Math.round(m.reqPersonnel!).toLocaleString('de-CH')}
                            {m.reqNetRev && m.reqNetRev > 0 && (
                              <div className="text-[9px] font-normal text-blue-500 dark:text-blue-400">
                                {(m.reqPersonnel! / m.reqNetRev * 100).toFixed(1)} %
                              </div>
                            )}
                          </>
                        ) : '–'}
                      </td>
                    ))}
                    <td className="text-right px-2 py-1.5 tabular-nums bg-blue-100 dark:bg-blue-900/30 leading-tight">
                      {hochrechnungTotal.activeMonths > 0 ? (
                        <>
                          {Math.round(hochrechnungTotal.reqPersonnel).toLocaleString('de-CH')}
                          {hochrechnungTotal.reqNetRev > 0 && (
                            <div className="text-[9px] font-normal text-blue-500 dark:text-blue-400">
                              {(hochrechnungTotal.reqPersonnel / hochrechnungTotal.reqNetRev * 100).toFixed(1)} %
                            </div>
                          )}
                        </>
                      ) : '–'}
                    </td>
                  </tr>

                  {/* ── Δ Personalkosten (nur wenn nicht fixiert) ── */}
                  {!persFixed && (
                  <tr className="bg-white dark:bg-background text-[11px]">
                    <td className="px-2 py-0.5 pl-8 text-blue-700 dark:text-blue-500 italic sticky left-0 bg-white dark:bg-background z-10">davon Veränderung</td>
                    {hochrechnungMonths.map((m, i) => {
                      if (!m.canCompute) return <td key={i} className="text-right px-1.5 py-0.5 text-muted-foreground">–</td>;
                      const delta = m.reqPersonnel! - m.monthPersonnel;
                      const pct = m.monthPersonnel > 0 ? delta / m.monthPersonnel * 100 : null;
                      const pos = delta > 0;
                      return (
                        <td key={i} className={`text-right px-1.5 py-0.5 tabular-nums font-medium ${pos ? 'text-orange-600 dark:text-orange-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                          {pos ? '+' : ''}{Math.round(delta).toLocaleString('de-CH')}
                          {pct !== null && <span className="ml-0.5 text-[9px] opacity-75">({pos ? '+' : ''}{pct.toFixed(1)}%)</span>}
                        </td>
                      );
                    })}
                    <td className="text-right px-2 py-0.5 tabular-nums bg-slate-50 dark:bg-slate-900/20">
                      {hochrechnungTotal.activeMonths > 0 ? (() => {
                        const delta = hochrechnungTotal.deltaPers;
                        const pct = hochrechnungTotal.activePers > 0 ? delta / hochrechnungTotal.activePers * 100 : null;
                        const pos = delta > 0;
                        return <span className={`font-medium ${pos ? 'text-orange-600 dark:text-orange-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                          {pos ? '+' : ''}{Math.round(delta).toLocaleString('de-CH')}{pct !== null ? ` (${pos ? '+' : ''}${pct.toFixed(1)}%)` : ''}
                        </span>;
                      })() : '–'}
                    </td>
                  </tr>
                  )}

                  {/* ── Neue Personalkostenquote (nur wenn CHF fixiert) ── */}
                  {persFixed && (
                  <tr className="bg-blue-50/60 dark:bg-blue-950/10 text-[10px]">
                    <td className="px-2 py-0.5 pl-8 text-blue-600 dark:text-blue-400 italic sticky left-0 bg-blue-50/60 dark:bg-blue-950/10 z-10 whitespace-nowrap">→ neue Quote</td>
                    {hochrechnungMonths.map((m, i) => {
                      if (!m.canCompute || !m.reqNetRev || m.reqNetRev <= 0) return <td key={i} className="text-right px-1.5 py-0.5 text-muted-foreground">–</td>;
                      const nq = (m.monthPersonnel / m.reqNetRev) * 100;
                      return <td key={i} className="text-right px-1.5 py-0.5 tabular-nums font-semibold text-blue-700 dark:text-blue-300">{nq.toFixed(1)} %</td>;
                    })}
                    <td className="text-right px-2 py-0.5 tabular-nums font-semibold text-blue-700 dark:text-blue-300 bg-blue-100/60 dark:bg-blue-900/20">
                      {hochrechnungTotal.activeMonths > 0 && hochrechnungTotal.reqNetRev > 0
                        ? `${(hochrechnungTotal.activePers / hochrechnungTotal.reqNetRev * 100).toFixed(1)} %`
                        : '–'}
                    </td>
                  </tr>
                  )}

                </tbody>
              </table>
            </div>

            {/* Hinweis */}
            <p className="text-[10px] text-indigo-600 dark:text-indigo-400 px-4 pb-3 italic">
              Monate ohne Ist-Daten werden übersprungen. «n/a» = EBIT-Quote nahe 0, Hochrechnung nicht sinnvoll.
              Placeholder-Werte (grau) = aktueller Ist-EBIT des Monats.
            </p>
            </>)}
          </div>
        )}

        {/* Legende */}
        {(mode === 'monthly' || mode === 'budget_pl') && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1 flex-wrap">
            <Info className="h-3 w-3" />
            {mode === 'budget_pl' ? (
              <>
                <span className="font-semibold text-foreground">Ist-Wert direkt bearbeiten:</span> Klick auf die Ist-Zelle einer Kontozeile → Inline-Eingabe (Enter = speichern, Esc = abbrechen).
                · Kategorie-Zeilen (dunkel): Klick → Dialog mit Bearbeitung.
                · <span className="text-emerald-600 font-semibold">Grün</span> = besser als geplant
                · <span className="text-red-600 font-semibold">Rot</span> = schlechter als geplant
              </>
            ) : (
              'Klicken Sie auf eine Zeilenposition für Quelldaten und Details.'
            )}
          </p>
        )}
      </div>

      {/* Drilldown-Dialog (klassische Ansicht) */}
      {drilldown && (
        <DrilldownDialog drilldown={drilldown} onClose={() => setDrilldown(null)} />
      )}

      {/* Drilldown-Dialog (Budget P&L) */}
      {bplDrilldown && (
        <BudgetPLDrilldownDialog
          row={bplDrilldown}
          month={month}
          year={year}
          onClose={() => setBplDrilldown(null)}
          onSaved={() => { setBplDrilldown(null); setRefreshKey(k => k + 1); }}
          composition={bplDrilldownComposition}
        />
      )}

      {/* Konto-Schnellaktionen */}
      {accountAction && (
        <AccountActionDialog
          row={accountAction}
          year={year}
          month={month}
          onClose={() => setAccountAction(null)}
          onRefresh={() => setRefreshKey(k => k + 1)}
          onOpenDrilldown={() => { setAccountAction(null); setBplDrilldown(accountAction); }}
        />
      )}

      {/* Konto hinzufügen */}
      <AddKontoDialog
        open={addKontoOpen}
        onClose={() => setAddKontoOpen(false)}
        year={year}
        categories={budgetData.plCategories ?? []}
        existingItems={budgetData.plLineItems ?? []}
        onSaved={() => setRefreshKey(k => k + 1)}
      />

      {/* Per-Monat Top-Down Budget Dialog (PLView) */}
      <Dialog open={!!bplTopDownDialog} onOpenChange={open => !open && setBplTopDownDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calculator className="h-4 w-4" />
              {bplTopDownDialog?.catLabel} — {bplTopDownDialog !== null ? BUDGET_MONTH_NAMES_FULL[bplTopDownDialog.monthIdx] : ''}
            </DialogTitle>
          </DialogHeader>
          {bplTopDownDialog && (() => {
            const { catId, monthIdx, monthBudgetTotal } = bplTopDownDialog;
            const cats = budgetData.plCategories ?? [];
            const items = budgetData.plLineItems ?? [];
            const cat = cats.find(c => c.id === catId);
            const contribCatIds = (cat?.resultFormula ?? [])
              .map(f => f.categoryId)
              .filter(cId => cats.find(c => c.id === cId)?.type === 'items');
            const affectedItems = items.filter(i => contribCatIds.includes(i.categoryId) && !i.isHidden && !i.isInternal);
            const affectedCats  = cats.filter(c => contribCatIds.includes(c.id));
            const currentMonthTotal = affectedItems.reduce((s, item) => s + (item.monthlyValues[monthIdx] ?? 0), 0);
            const targetCHF = calcBplTopDownTargetCHF();
            const factor = currentMonthTotal > 0 && targetCHF > 0 ? targetCHF / currentMonthTotal : null;
            const targetPct = bplBudgetRevenue > 0 && targetCHF > 0 ? targetCHF / bplBudgetRevenue * 100 : null;
            const currentPct = bplBudgetRevenue > 0 && monthBudgetTotal !== 0 ? monthBudgetTotal / bplBudgetRevenue * 100 : null;
            const canApply = targetCHF > 0 && currentMonthTotal > 0 && affectedItems.length > 0;
            return (
              <div className="space-y-4">
                <div className="rounded-md bg-muted/50 px-3 py-2.5 text-sm">
                  <div className="text-muted-foreground text-xs mb-1">Aktueller Budget-Wert ({BUDGET_MONTH_NAMES_FULL[monthIdx]})</div>
                  <div className="font-mono font-bold text-base flex items-center gap-2">
                    CHF {monthBudgetTotal.toLocaleString('de-CH', { maximumFractionDigits: 0 })}
                    {currentPct !== null && (
                      <span className="text-amber-600 text-xs font-normal">= {currentPct.toFixed(1)}% des Umsatzes</span>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Neuer Zielwert</Label>
                  <div className="flex gap-2 items-center">
                    <div className="flex border rounded-md overflow-hidden text-sm font-semibold flex-shrink-0">
                      <button
                        className={cn('px-3 py-1.5 transition-colors', bplTopDownMode === 'chf' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                        onClick={() => {
                          setBplTopDownMode('chf');
                          if (bplTopDownMode === 'pct') {
                            const pv = parseBplTopDownInput();
                            setBplTopDownInput(bplBudgetRevenue > 0 ? String(Math.round(pv / 100 * bplBudgetRevenue)) : bplTopDownInput);
                          }
                        }}
                      >CHF</button>
                      <button
                        className={cn('px-3 py-1.5 transition-colors', bplTopDownMode === 'pct' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                        onClick={() => {
                          setBplTopDownMode('pct');
                          if (bplTopDownMode === 'chf') {
                            const cv = parseBplTopDownInput();
                            setBplTopDownInput(bplBudgetRevenue > 0 ? (cv / bplBudgetRevenue * 100).toFixed(1) : bplTopDownInput);
                          }
                        }}
                      >%</button>
                    </div>
                    <Input
                      autoFocus
                      value={bplTopDownInput}
                      onChange={e => setBplTopDownInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && canApply && applyBplTopDownMonth()}
                      placeholder={bplTopDownMode === 'chf' ? 'z.B. 180000' : 'z.B. 75.0'}
                      className="font-mono flex-1"
                    />
                    {bplTopDownMode === 'pct' && (
                      <span className="text-sm text-muted-foreground flex-shrink-0">% des Umsatzes</span>
                    )}
                  </div>
                </div>
                {factor !== null && (
                  <div className="rounded-md border px-3 py-2.5 space-y-1.5 text-sm">
                    <div className="font-semibold text-xs text-muted-foreground uppercase tracking-wide mb-1">Vorschau</div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Neuer Wert</span>
                      <span className="font-mono font-bold">
                        CHF {Math.round(targetCHF).toLocaleString('de-CH')}
                        {targetPct !== null && <span className="text-amber-600 ml-1.5 font-normal text-xs">({targetPct.toFixed(1)}%)</span>}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Skalierungsfaktor</span>
                      <span className={cn('font-mono text-xs', factor > 1 ? 'text-green-600' : 'text-orange-600')}>
                        × {factor.toFixed(4)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Betroffene Konten</span>
                      <span className="font-mono text-xs">{affectedItems.length} in {affectedCats.length} Gruppen</span>
                    </div>
                    {affectedCats.length > 0 && (
                      <div className="text-xs text-muted-foreground pt-0.5 border-t">
                        {affectedCats.map(c => c.label).join(' · ')}
                      </div>
                    )}
                  </div>
                )}
                {currentMonthTotal === 0 && affectedItems.length > 0 && (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>Monatswert ist 0 – bitte Konten zuerst manuell befüllen.</AlertDescription>
                  </Alert>
                )}
                {affectedItems.length === 0 && (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>Keine anpassbaren Konten gefunden.</AlertDescription>
                  </Alert>
                )}
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBplTopDownDialog(null)}>Abbrechen</Button>
            <Button
              onClick={applyBplTopDownMonth}
              disabled={calcBplTopDownTargetCHF() <= 0}
              className="gap-1.5"
            >
              <ArrowRight className="h-3.5 w-3.5" />
              Übernehmen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* PDF Export Dialog */}
      <PDFExportDialog
        open={pdfDialogOpen}
        onClose={() => setPdfDialogOpen(false)}
        year={year}
        month={month}
        mode={mode}
        onExport={handlePdfExport}
        maisonAvailable={maisonEnabled && maisonColPref}
        maisonMonthNet={maisonMonthNet}
      />

    </div>
  );
};

export default PLViewPage;
