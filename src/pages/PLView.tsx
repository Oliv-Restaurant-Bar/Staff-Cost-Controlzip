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

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Navigate } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, ChevronRight, Info,
  ChevronDown, X, BarChart2, Table2, Calendar,
  AlertCircle, CheckCircle2, ArrowUpRight, ArrowDownRight, Trash2,
  Minus, Database, AlignJustify, List, Pencil, Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { usePermissions } from '@/hooks/usePermissions';
import { loadYear, saveMonth } from '@/lib/reporting-store';
import { lookupAccount, saveMappingCustom } from '@/lib/account-mapping-store';
import { AccountMapping } from '@/types/account-mapping';
import { computePLForMonth, computePLForYear, getDrilldown, PL_STRUCTURE } from '@/lib/pl-engine';
import { PLComputedRow, PLDrilldown, PLMonthResult } from '@/types/pl';
import { MONTH_NAMES_DE, MONTH_NAMES_SHORT_DE, MonthlyFinancialRecord } from '@/types/reporting';
import { loadBudgetWithPL, deletePLLineItem } from '@/lib/budget-store';
import { BudgetYear, BudgetPLCategory } from '@/types/budget';

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

// ─── Zeilenstile ─────────────────────────────────────────────────────────────

const ROW_STYLE: Record<string, string> = {
  section:     'bg-slate-700 text-white dark:bg-slate-800',
  subtotal:    'bg-slate-100 dark:bg-slate-800/60 font-semibold border-t border-b border-slate-300 dark:border-slate-600',
  result:      'bg-slate-50 dark:bg-slate-900/40 font-bold text-base border-t-2 border-slate-400 dark:border-slate-500',
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
      <td className="px-2 py-1.5 text-right text-xs text-muted-foreground">
        {def.showPercent || def.type === 'result'
          ? fmtPct(pctOfRevenue)
          : ''}
      </td>
      {/* Budget */}
      <td className="px-2 py-1.5 text-right text-sm font-mono text-muted-foreground">
        {fmt(values.budget)}
      </td>
      {/* Abw. Budget */}
      <VarCell value={values.vsBudget} pct={values.vsBudgetPct} inverted={expenseInverted} />
      {/* Vorjahr */}
      <td className="px-2 py-1.5 text-right text-sm font-mono text-muted-foreground">
        {fmt(values.prevYear)}
      </td>
      {/* Abw. VJ */}
      <VarCell value={values.vsPrevYear} pct={values.vsPrevYearPct} inverted={expenseInverted} />
    </tr>
  );
};

// ─── Jahres-Zeile ─────────────────────────────────────────────────────────────

const YearRow = ({
  rows, rowIndex, onClickMonth,
}: {
  rows: PLComputedRow[][];  // rows[monthIndex][rowIndex]
  rowIndex: number;
  onClickMonth: (month: number) => void;
}) => {
  const def = PL_STRUCTURE[rowIndex];
  if (!def) return null;
  if (def.type === 'spacer') return <tr className="h-2"><td colSpan={15} /></tr>;
  if (def.type === 'section') {
    return (
      <tr className={ROW_STYLE.section}>
        <td colSpan={15} className="px-3 py-2 text-xs font-bold tracking-wider sticky left-0 bg-slate-700 dark:bg-slate-800">
          {def.label}
        </td>
      </tr>
    );
  }

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
      {/* Jahressumme (vor den Monaten) */}
      <td className={cn(
        'px-2 py-1.5 text-right text-sm font-mono border-r-2 border-slate-300 dark:border-slate-600',
        def.type === 'result' ? 'font-bold' : 'font-semibold',
      )}>
        {(() => {
          const vals = rows
            .map(r => r[rowIndex]?.values.actual)
            .filter((v): v is number => v !== undefined);
          return vals.length > 0 ? fmt(vals.reduce((a, b) => a + b, 0)) : '—';
        })()}
      </td>
      {/* Monatswerte */}
      {rows.map((monthRows, mIdx) => {
        const row = monthRows[rowIndex];
        const actual = row?.values.actual;
        return (
          <td
            key={mIdx}
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
          {drilldown.values.vsBudget !== undefined && (
            <div>
              <p className="text-muted-foreground mb-0.5">Abw. Budget</p>
              <p className={cn('font-semibold',
                drilldown.values.vsBudget > 0 ? 'text-emerald-600' : 'text-red-600'
              )}>
                {drilldown.values.vsBudget > 0 ? '+' : ''}{fmtCHF(drilldown.values.vsBudget)}
                {drilldown.values.vsBudgetPct !== undefined &&
                  ` (${drilldown.values.vsBudgetPct > 0 ? '+' : ''}${fmtPct(drilldown.values.vsBudgetPct)})`}
              </p>
            </div>
          )}
          {drilldown.values.vsPrevYear !== undefined && (
            <div>
              <p className="text-muted-foreground mb-0.5">Abw. Vorjahr</p>
              <p className={cn('font-semibold',
                drilldown.values.vsPrevYear > 0 ? 'text-emerald-600' : 'text-red-600'
              )}>
                {drilldown.values.vsPrevYear > 0 ? '+' : ''}{fmtCHF(drilldown.values.vsPrevYear)}
              </p>
            </div>
          )}
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
          <tr className="bg-slate-800 text-white text-xs">
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
}: {
  results: PLMonthResult[];
  onClickMonth: (month: number) => void;
}) => {
  const allRows = results.map(r => r.rows);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse" style={{ minWidth: '1200px' }}>
        <thead>
          <tr className="bg-slate-800 text-white text-xs">
            <th className="text-left px-3 py-2 sticky left-0 bg-slate-800 z-10 min-w-[180px]">Position</th>
            <th className="text-right px-2 py-2 border-r-2 border-slate-500 whitespace-nowrap font-bold bg-slate-700">
              Total
            </th>
            {MONTH_NAMES_SHORT_DE.slice(1).map((m, i) => (
              <th
                key={i}
                className="text-right px-2 py-2 cursor-pointer hover:bg-slate-700 whitespace-nowrap"
                onClick={() => onClickMonth(i + 1)}
                title={`Zu ${MONTH_NAMES_DE[i + 1]} wechseln`}
              >
                {m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PL_STRUCTURE.map((_, rowIndex) => (
            <YearRow
              key={rowIndex}
              rows={allRows}
              rowIndex={rowIndex}
              onClickMonth={onClickMonth}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ─── Budget P&L Vergleich ─────────────────────────────────────────────────────

interface BPLCell {
  budget: number;
  actual: number;
  prevYear: number;
  vsBudget: number;
  vsBudgetPct?: number;
  vsPrevYear: number;
  vsPrevYearPct?: number;
}

interface BPLRow {
  catId: string;
  catLabel: string;
  catType: 'items' | 'result';
  isExpense: boolean;
  isCategory: boolean;
  itemLabel?: string;
  itemAccountNumber?: string;
  itemId?: string;
}

interface BPLRowWithValues extends BPLRow {
  values: BPLCell;
}

function getCatActual(catId: string, rec: MonthlyFinancialRecord | undefined): number {
  if (!rec) return 0;
  if (catId === 'pl_revenue') return rec.revenueActual ?? (rec as any).revenue ?? 0;
  if (catId === 'pl_wages')   return (rec as any).personnel_actual ?? 0;
  const ranges: Record<string, [number, number]> = {
    pl_goods_cost:      [4000, 4999],
    pl_social:          [5010, 5799],
    pl_personnel_other: [5800, 5899],
    pl_rent:            [6000, 6199],
    pl_maintenance:     [6200, 6399],
    pl_admin:           [6400, 6999],
  };
  const r = ranges[catId];
  if (!r) return 0;
  return (rec.expenseCategories ?? [])
    .filter(c => { const n = parseInt(c.categoryId ?? ''); return !isNaN(n) && n >= r[0] && n <= r[1]; })
    .reduce((s, c) => s + (c.amount ?? 0), 0);
}

function getCatPY(catId: string, rec: MonthlyFinancialRecord | undefined): number {
  if (!rec) return 0;
  if (catId === 'pl_revenue') return (rec as any).revenuePreviousYear ?? 0;
  if (catId === 'pl_wages')   return (rec as any).personnelCostPreviousYear ?? 0;
  const ranges: Record<string, [number, number]> = {
    pl_goods_cost:      [4000, 4999],
    pl_social:          [5010, 5799],
    pl_personnel_other: [5800, 5899],
    pl_rent:            [6000, 6199],
    pl_maintenance:     [6200, 6399],
    pl_admin:           [6400, 6999],
  };
  const r = ranges[catId];
  if (!r) return 0;
  return (rec.expenseCategoriesPreviousYear ?? [])
    .filter(c => { const n = parseInt(c.categoryId ?? ''); return !isNaN(n) && n >= r[0] && n <= r[1]; })
    .reduce((s, c) => s + (c.amount ?? 0), 0);
}

function makeCell(actual: number, budget: number, prevYear: number, isExpense: boolean): BPLCell {
  const vsBudget   = isExpense ? budget - actual   : actual - budget;
  const vsPrevYear = isExpense ? prevYear - actual  : actual - prevYear;
  return {
    actual, budget, prevYear,
    vsBudget,
    vsBudgetPct:   budget    !== 0 ? (vsBudget   / Math.abs(budget))    * 100 : undefined,
    vsPrevYear,
    vsPrevYearPct: prevYear  !== 0 ? (vsPrevYear / Math.abs(prevYear))  * 100 : undefined,
  };
}

const PL_CAT_TO_BPL: Partial<Record<string, string>> = {
  revenue_food:      'pl_revenue',
  revenue_beverage:  'pl_revenue',
  revenue_catering:  'pl_revenue',
  revenue_other:     'pl_revenue',
  cogs_food:         'pl_goods_cost',
  cogs_beverage:     'pl_goods_cost',
  cogs_other:        'pl_goods_cost',
  personnel_kitchen: 'pl_wages',
  personnel_service: 'pl_wages',
  personnel_admin:   'pl_wages',
  personnel_social:  'pl_social',
  personnel_other:   'pl_personnel_other',
  rent:              'pl_rent',
  utilities:         'pl_rent',
  cleaning:          'pl_maintenance',
  maintenance:       'pl_maintenance',
  insurance:         'pl_admin',
  marketing:         'pl_admin',
  admin_costs:       'pl_admin',
  office:            'pl_admin',
  bank_fees:         'pl_admin',
  other_operating:   'pl_admin',
  depreciation:      'pl_admin',
};

function computeBPLRows(
  budget: BudgetYear,
  rec: MonthlyFinancialRecord | undefined,
  mIdx: number,
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
      const its = items.filter(i => i.categoryId === cat.id);
      catB[cat.id] = its.reduce((s, i) => s + (i.monthlyValues[mIdx] ?? 0), 0);
      catA[cat.id] = getCatActual(cat.id, rec);
      catP[cat.id] = getCatPY(cat.id, rec);
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

      const its = items.filter(i => i.categoryId === cat.id).sort((a, b) => a.sortOrder - b.sortOrder);
      for (const item of its) {
        if (item.accountNumber) {
          const acc = lookupAccount(item.accountNumber);
          if (acc.mapping?.isActive === false) continue;
        }
        const iB = item.monthlyValues[mIdx] ?? 0;
        const iA = (rec?.expenseCategories ?? []).find(c => c.categoryId === item.accountNumber)?.amount ?? 0;
        const iP = (rec?.expenseCategoriesPreviousYear ?? []).find(c => c.categoryId === item.accountNumber)?.amount ?? 0;
        if (iA === 0 && iB === 0 && iP === 0) continue;
        rows.push({
          catId: cat.id, catLabel: cat.label, catType: 'items',
          isExpense: cat.isExpense, isCategory: false,
          itemId: item.id, itemLabel: item.label, itemAccountNumber: item.accountNumber,
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
        const iP = (rec?.expenseCategoriesPreviousYear ?? []).find(c => c.categoryId === ar.accountNum)?.amount ?? 0;
        if (ar.amount === 0 && iP === 0) continue;
        rows.push({
          catId: cat.id, catLabel: cat.label, catType: 'items',
          isExpense: cat.isExpense, isCategory: false,
          itemId: `actual_${ar.accountNum}`, itemLabel: ar.label, itemAccountNumber: ar.accountNum,
          values: makeCell(ar.amount, 0, iP, cat.isExpense),
        });
      }
    } else if (cat.type === 'result') {
      rows.push({
        catId: cat.id, catLabel: cat.label, catType: 'result',
        isExpense: cat.isExpense, isCategory: true,
        values: makeCell(catA[cat.id] ?? 0, catB[cat.id] ?? 0, catP[cat.id] ?? 0, false),
      });
    }
  }
  return rows;
}

const BPLVarCell = ({ value, pct }: { value: number; pct?: number }) => {
  const pos     = value > 0;
  const neutral = Math.abs(value) < 0.5;
  return (
    <td className={cn(
      'px-2 py-1 text-right text-xs whitespace-nowrap tabular-nums',
      neutral ? 'text-muted-foreground' :
      pos     ? 'text-emerald-600 dark:text-emerald-400 font-semibold' :
                'text-red-600 dark:text-red-400 font-semibold',
    )}>
      <span className="flex items-center justify-end gap-0.5">
        {!neutral && (pos
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

const BPLRowComp = ({ row, onClick, compact, onDelete }: { row: BPLRowWithValues; onClick: () => void; compact: boolean; onDelete?: (itemId: string) => void }) => {
  const { values: v } = row;
  const py = compact ? 'py-1' : 'py-2';
  const pyResult = compact ? 'py-1' : 'py-2.5';
  const pyItem = compact ? 'py-0.5' : 'py-1.5';

  if (row.catType === 'result') {
    const isPos = v.actual >= 0;
    return (
      <tr className="bg-slate-100 dark:bg-slate-800/80 font-bold border-t-2 border-b border-slate-400 dark:border-slate-500">
        <td className={cn('px-3 text-sm', pyResult)} colSpan={2}>{row.catLabel}</td>
        <td className={cn('px-2 text-right text-sm font-mono tabular-nums font-bold', pyResult,
          isPos ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'
        )}>{fmt(v.actual)}</td>
        <td className={cn('px-2 text-right text-sm font-mono tabular-nums text-muted-foreground', pyResult)}>{fmt(v.budget)}</td>
        <BPLVarCell value={v.vsBudget} pct={v.vsBudgetPct} />
        <td className={cn('px-2 text-right text-sm font-mono tabular-nums text-muted-foreground', pyResult)}>{fmt(v.prevYear)}</td>
        <BPLVarCell value={v.vsPrevYear} pct={v.vsPrevYearPct} />
      </tr>
    );
  }

  if (row.isCategory) {
    return (
      <tr
        className="bg-slate-700 text-white dark:bg-slate-800 cursor-pointer hover:bg-slate-600 transition-colors"
        onClick={onClick}
        title="Klicken für Details"
      >
        <td className={cn('px-3 text-xs font-bold tracking-wider', py)} colSpan={2}>{row.catLabel}</td>
        <td className={cn('px-2 text-right text-sm font-mono tabular-nums', py)}>{fmt(v.actual)}</td>
        <td className={cn('px-2 text-right text-sm font-mono tabular-nums opacity-75', py)}>{fmt(v.budget)}</td>
        <BPLVarCell value={v.vsBudget} pct={v.vsBudgetPct} />
        <td className={cn('px-2 text-right text-sm font-mono tabular-nums opacity-65', py)}>{fmt(v.prevYear)}</td>
        <BPLVarCell value={v.vsPrevYear} pct={v.vsPrevYearPct} />
      </tr>
    );
  }

  const isBudgetItem = row.itemId && !row.itemId.startsWith('actual_');
  return (
    <tr
      className="hover:bg-muted/30 border-b border-slate-100 dark:border-slate-800 transition-colors group"
    >
      <td className={cn('px-3 pl-9 text-sm cursor-pointer', pyItem)} onClick={onClick}>
        <span className="text-[10px] text-muted-foreground/50 font-mono mr-1.5">{row.itemAccountNumber}</span>
        {row.itemLabel}
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
      <td className={cn('px-2 text-right text-sm font-mono tabular-nums cursor-pointer', pyItem)} onClick={onClick}>{v.actual > 0 ? fmt(v.actual) : <span className="text-muted-foreground/40">—</span>}</td>
      <td className={cn('px-2 text-right text-sm font-mono tabular-nums text-muted-foreground cursor-pointer', pyItem)} onClick={onClick}>{v.budget > 0 ? fmt(v.budget) : <span className="opacity-40">—</span>}</td>
      <BPLVarCell value={v.vsBudget} pct={v.vsBudgetPct} />
      <td className={cn('px-2 text-right text-sm font-mono tabular-nums text-muted-foreground cursor-pointer', pyItem)} onClick={onClick}>{v.prevYear > 0 ? fmt(v.prevYear) : <span className="opacity-40">—</span>}</td>
      <BPLVarCell value={v.vsPrevYear} pct={v.vsPrevYearPct} />
    </tr>
  );
};

const BudgetPLView = ({
  rows,
  onRowClick,
  onDeleteItem,
  compact,
}: {
  rows: BPLRowWithValues[];
  onRowClick: (row: BPLRowWithValues) => void;
  onDeleteItem?: (itemId: string) => void;
  compact: boolean;
}) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm border-collapse min-w-[820px]">
      <thead>
        <tr className="bg-slate-900 text-white text-xs">
          <th className={cn('text-left px-3 min-w-[230px]', compact ? 'py-1.5' : 'py-2.5')}>Position</th>
          <th className={cn('w-5', compact ? 'py-1.5' : 'py-2.5')} />
          <th className={cn('text-right px-2 min-w-[100px]', compact ? 'py-1.5' : 'py-2.5')}>Ist (CHF)</th>
          <th className={cn('text-right px-2 min-w-[100px]', compact ? 'py-1.5' : 'py-2.5')}>Budget (CHF)</th>
          <th className={cn('text-right px-2 min-w-[130px]', compact ? 'py-1.5' : 'py-2.5')}>Abw. Budget</th>
          <th className={cn('text-right px-2 min-w-[100px]', compact ? 'py-1.5' : 'py-2.5')}>Vorjahr (CHF)</th>
          <th className={cn('text-right px-2 min-w-[120px]', compact ? 'py-1.5' : 'py-2.5')}>Abw. VJ</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <BPLRowComp
            key={`${row.catId}-${row.itemId ?? 'cat'}-${i}`}
            row={row}
            onClick={() => onRowClick(row)}
            compact={compact}
            onDelete={onDeleteItem}
          />
        ))}
      </tbody>
    </table>
  </div>
);

const BudgetPLDrilldownDialog = ({
  row,
  month,
  year,
  onClose,
  onSaved,
}: {
  row: BPLRowWithValues;
  month: number;
  year: number;
  onClose: () => void;
  onSaved: () => void;
}) => {
  const label   = row.itemLabel ?? row.catLabel;
  const account = row.itemAccountNumber;
  const v       = row.values;

  const [istInput, setIstInput] = useState(v.actual !== 0 ? String(v.actual) : '');
  const [saved,    setSaved]    = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const canEdit = row.catType !== 'result';

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const handleSave = () => {
    const raw = istInput.replace(/['\s]/g, '').replace(',', '.');
    const num = parseFloat(raw);
    if (isNaN(num)) return;

    if (row.catId === 'pl_revenue') {
      saveMonth({ year, month, revenueActual: num }, 'manual_entry', 'update', { note: 'Manuelle Eingabe' });
    } else if (row.catId === 'pl_wages' && row.isCategory) {
      saveMonth({ year, month, personnelCostActual: num }, 'manual_entry', 'update', { note: 'Manuelle Eingabe' });
    } else if (!row.isCategory && account) {
      const existing = loadYear(year)[month - 1];
      const cats = (existing?.expenseCategories ?? []).filter(c => c.categoryId !== account);
      cats.push({ categoryId: account, amount: num, label: row.itemLabel ?? label });
      saveMonth({ year, month, expenseCategories: cats }, 'manual_entry', 'update', { note: `Manuelle Eingabe Konto ${account}` });
    } else {
      return;
    }

    setSaved(true);
    setTimeout(() => { onSaved(); }, 600);
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
              {row.isCategory && row.catId !== 'pl_revenue' && row.catId !== 'pl_wages' && (
                <p className="text-[10px] text-amber-600">
                  Hinweis: Kategorie-Summen werden aus Einzelkonten berechnet. Bitte die Unterkonten einzeln eingeben.
                </p>
              )}
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
                v.vsBudget >= 0 ? 'text-emerald-600' : 'text-red-600'
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
                v.vsPrevYear >= 0 ? 'text-emerald-600' : 'text-red-600'
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
              <p>Bei Aufwand-Positionen: <strong>Abw. = Budget − Ist</strong>.
                Ein positiver Wert (grün) bedeutet: weniger ausgegeben als budgetiert = gut.
                Negativ (rot) = Budgetüberschreitung.</p>
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
  onClose,
  onRefresh,
  onOpenDrilldown,
}: {
  row: BPLRowWithValues;
  year: number;
  onClose: () => void;
  onRefresh: () => void;
  onOpenDrilldown: () => void;
}) => {
  const accountNum = row.itemAccountNumber ?? '';
  const result     = lookupAccount(accountNum);
  const mapping    = result.mapping;
  const isActive   = mapping?.isActive !== false;
  const isBudgetItem = !!(row.itemId && !row.itemId.startsWith('actual_'));

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
      deletePLLineItem(year, row.itemId);
    }
    onRefresh();
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono text-muted-foreground text-sm">{accountNum}</span>
            <span className="text-base">{row.itemLabel}</span>
          </DialogTitle>
          <DialogDescription>
            Konto-Aktionen für diese Zeile in der Erfolgsrechnung
          </DialogDescription>
        </DialogHeader>

        {mapping && (
          <div className="text-xs text-muted-foreground rounded-md bg-muted/40 border border-border px-3 py-2 space-y-0.5">
            <div className="flex justify-between">
              <span>Kategorie:</span>
              <span className="font-medium">{mapping.plCategory}</span>
            </div>
            <div className="flex justify-between">
              <span>Status:</span>
              <span className={cn('font-medium', isActive ? 'text-emerald-600' : 'text-red-500')}>
                {isActive ? 'Aktiv' : 'Inaktiv'}
              </span>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Button
            variant="outline"
            className={cn('w-full justify-start gap-2 text-sm', !isActive && 'border-emerald-300 text-emerald-700')}
            onClick={handleToggleActive}
          >
            {isActive ? (
              <><X className="h-4 w-4 text-amber-500" /> Konto inaktiv setzen (ausblenden)</>
            ) : (
              <><Check className="h-4 w-4 text-emerald-500" /> Konto wieder aktivieren</>
            )}
          </Button>

          {isBudgetItem && (
            <Button
              variant="outline"
              className="w-full justify-start gap-2 text-sm text-blue-600 border-blue-200"
              onClick={() => { onClose(); setTimeout(onOpenDrilldown, 50); }}
            >
              <Pencil className="h-4 w-4" /> Budget-Werte bearbeiten
            </Button>
          )}

          <Link to={`/kontenplan?q=${accountNum}`} onClick={onClose}>
            <Button variant="outline" className="w-full justify-start gap-2 text-sm mt-0">
              <ArrowUpRight className="h-4 w-4 text-muted-foreground" /> Im Kontenplan bearbeiten
            </Button>
          </Link>

          {isBudgetItem && (
            <Button
              variant="outline"
              className="w-full justify-start gap-2 text-sm text-red-600 border-red-200"
              onClick={handleDelete}
            >
              <Trash2 className="h-4 w-4" /> Zeile aus P&L entfernen
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
const years = [currentYear - 1, currentYear, currentYear + 1];

type ViewMode = 'monthly' | 'yearly' | 'budget_pl';

const PLViewPage = () => {
  const { isAdmin } = usePermissions();
  if (!isAdmin) return <Navigate to="/" replace />;

  const [year,   setYear]   = useState(currentYear);
  const [month,  setMonth]  = useState(currentMonth);
  const [mode,   setMode]   = useState<ViewMode>('budget_pl');
  const [drilldown,       setDrilldown]       = useState<PLDrilldown | null>(null);
  const [bplDrilldown,    setBplDrilldown]    = useState<BPLRowWithValues | null>(null);
  const [accountAction,   setAccountAction]   = useState<BPLRowWithValues | null>(null);
  const [compact,         setCompact]         = useState(false);
  const [refreshKey,      setRefreshKey]       = useState(0);

  // Daten laden & P&L berechnen
  const records = useMemo(() => loadYear(year), [year, month, refreshKey]);

  const monthResult = useMemo(
    () => computePLForMonth(records[month - 1]),
    [records, month],
  );

  const yearResult = useMemo(
    () => computePLForYear(records),
    [records],
  );

  // Budget P&L laden
  const budgetData = useMemo(() => loadBudgetWithPL(year), [year, refreshKey]);

  const bplRows = useMemo(
    () => computeBPLRows(budgetData, records[month - 1], month - 1),
    [budgetData, records, month],
  );

  const handleDrilldown = useCallback((rowId: string) => {
    const dd = getDrilldown(rowId, monthResult);
    if (dd) setDrilldown(dd);
  }, [monthResult]);

  const handleYearMonthClick = useCallback((m: number) => {
    setMonth(m);
    setMode('monthly');
  }, []);

  // KPI-Karten oben
  const netRev  = monthResult.rows.find(r => r.def.id === 'net_revenue')?.values;
  const gp1     = monthResult.rows.find(r => r.def.id === 'gross_profit_1')?.values;
  const gp2     = monthResult.rows.find(r => r.def.id === 'gross_profit_2')?.values;
  const ebit    = monthResult.rows.find(r => r.def.id === 'ebit')?.values;

  const kpis = [
    { label: 'Betriebsertrag netto', values: netRev, suffix: '' },
    { label: 'Bruttogewinn 1',       values: gp1,   suffix: netRev?.actual ? ` (${((gp1?.actual ?? 0) / netRev.actual * 100).toFixed(1)} %)` : '' },
    { label: 'Deckungsbeitrag',       values: gp2,   suffix: netRev?.actual ? ` (${((gp2?.actual ?? 0) / netRev.actual * 100).toFixed(1)} %)` : '' },
    { label: 'Betriebsergebnis EBIT', values: ebit,  suffix: netRev?.actual ? ` (${((ebit?.actual ?? 0) / netRev.actual * 100).toFixed(1)} %)` : '' },
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
                className={cn('px-3 py-1.5 flex items-center gap-1',
                  mode === 'budget_pl' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'
                )}
                onClick={() => setMode('budget_pl')}
              >
                <BarChart2 className="h-3 w-3" /> Budget P&L
              </button>
              <button
                className={cn('px-3 py-1.5 flex items-center gap-1',
                  mode === 'monthly' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'
                )}
                onClick={() => setMode('monthly')}
              >
                <Calendar className="h-3 w-3" /> Klassisch
              </button>
              <button
                className={cn('px-3 py-1.5 flex items-center gap-1',
                  mode === 'yearly' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'
                )}
                onClick={() => setMode('yearly')}
              >
                <Table2 className="h-3 w-3" /> Jahr
              </button>
            </div>

            {/* Jahr */}
            <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
              <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
              </SelectContent>
            </Select>

            {/* Monat (Monatsansicht + Budget P&L) */}
            {(mode === 'monthly' || mode === 'budget_pl') && (
              <Select value={String(month)} onValueChange={v => setMonth(Number(v))}>
                <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MONTH_NAMES_DE.slice(1).map((name, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Zeilenabstand */}
            {mode === 'budget_pl' && (
              <button
                title={compact ? 'Normaler Zeilenabstand' : 'Kompakter Zeilenabstand'}
                onClick={() => setCompact(c => !c)}
                className={cn(
                  'h-8 px-2 flex items-center gap-1 rounded border text-xs transition-colors',
                  compact
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-card border-border hover:bg-muted text-muted-foreground',
                )}
              >
                {compact ? <AlignJustify className="h-3.5 w-3.5" /> : <List className="h-3.5 w-3.5" />}
                <span className="hidden sm:inline">{compact ? 'Normal' : 'Kompakt'}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 px-4 py-5 space-y-5 pb-20 max-w-full">

        {/* KPI-Karten (Monatsansicht + Budget P&L) */}
        {(mode === 'monthly' || mode === 'budget_pl') && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {kpis.map(kpi => {
              const val = kpi.values?.actual;
              const isPositive = val !== undefined && val >= 0;
              return (
                <Card key={kpi.label} className={cn(
                  'border',
                  val !== undefined
                    ? isPositive ? 'border-emerald-200 dark:border-emerald-800' : 'border-red-200 dark:border-red-800'
                    : 'border-border',
                )}>
                  <CardContent className="p-3">
                    <p className="text-[11px] text-muted-foreground mb-1 leading-tight">{kpi.label}</p>
                    {val !== undefined ? (
                      <>
                        <p className={cn('text-lg font-bold', isPositive ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600')}>
                          {fmt(val)}
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
        )}

        {/* Datenvollständigkeit-Hinweis */}
        {(mode === 'monthly' || mode === 'budget_pl') && !monthResult.hasData && (
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

        {/* P&L-Tabelle */}
        <div className="rounded-lg border border-border overflow-hidden shadow-sm">
          {/* Tabellen-Header */}
          <div className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold">
                {mode === 'budget_pl'
                  ? `Budget-P&L Vergleich – ${MONTH_NAMES_DE[month]} ${year}`
                  : mode === 'monthly'
                  ? `Erfolgsrechnung – ${MONTH_NAMES_DE[month]} ${year}`
                  : `Erfolgsrechnung – Jahresübersicht ${year}`}
              </h2>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {mode === 'budget_pl'
                  ? 'Ist · Budget · Vorjahr · Abweichungen – Budget-Hierarchie mit Kontonummern'
                  : mode === 'monthly'
                  ? 'Ist / Budget / Vorjahr inkl. Abweichungen'
                  : 'Alle 12 Monate + Jahressumme · Klick auf Monatsspalte → Monatsansicht'}
              </p>
            </div>
            <div className="text-[10px] text-slate-400">
              {(mode === 'monthly' || mode === 'budget_pl') && monthResult.hasData && (
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
                rows={bplRows}
                onRowClick={row => {
                  if (row.isCategory) {
                    setBplDrilldown(row);
                  } else {
                    setAccountAction(row);
                  }
                }}
                compact={compact}
                onDeleteItem={itemId => {
                  deletePLLineItem(year, itemId);
                  setRefreshKey(k => k + 1);
                }}
              />
            : mode === 'monthly'
            ? <MonthlyView result={monthResult} onDrilldown={handleDrilldown} />
            : <YearView results={yearResult.months} onClickMonth={handleYearMonthClick} />
          }
        </div>

        {/* Legende */}
        {(mode === 'monthly' || mode === 'budget_pl') && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Info className="h-3 w-3" />
            Klicken Sie auf eine Zeilenposition für Quelldaten und Details.
            {mode === 'budget_pl' && (
              <span className="ml-1">
                · <span className="text-emerald-600 font-semibold">Grün</span> = besser als geplant
                · <span className="text-red-600 font-semibold">Rot</span> = schlechter als geplant
              </span>
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
        />
      )}

      {/* Konto-Schnellaktionen */}
      {accountAction && (
        <AccountActionDialog
          row={accountAction}
          year={year}
          onClose={() => setAccountAction(null)}
          onRefresh={() => setRefreshKey(k => k + 1)}
          onOpenDrilldown={() => { setAccountAction(null); setBplDrilldown(accountAction); }}
        />
      )}
    </div>
  );
};

export default PLViewPage;
