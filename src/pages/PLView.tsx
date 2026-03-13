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

import { useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Navigate } from 'react-router-dom';
import {
  LayoutDashboard, TrendingUp, ChevronRight, Info,
  ChevronDown, X, BarChart2, Table2, Calendar,
  AlertCircle, CheckCircle2, ArrowUpRight, ArrowDownRight,
  Minus, Database,
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
import { usePermissions } from '@/hooks/usePermissions';
import { loadYear } from '@/lib/reporting-store';
import { computePLForMonth, computePLForYear, getDrilldown, PL_STRUCTURE } from '@/lib/pl-engine';
import { PLComputedRow, PLDrilldown, PLMonthResult } from '@/types/pl';
import { MONTH_NAMES_DE, MONTH_NAMES_SHORT_DE } from '@/types/reporting';

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
      {/* Jahressumme */}
      <td className={cn(
        'px-2 py-1.5 text-right text-sm font-mono border-l-2 border-slate-300 dark:border-slate-600',
        def.type === 'result' ? 'font-bold' : 'font-semibold',
      )}>
        {(() => {
          const totalActual = rows
            .map(r => r[rowIndex]?.values.actual)
            .filter(v => v !== undefined)
            .reduce((a, b) => a! + b!, 0);
          return totalActual !== undefined && rows.some(r => r[rowIndex]?.values.actual !== undefined)
            ? fmt(totalActual)
            : '—';
        })()}
      </td>
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
            <th className="text-right px-2 py-2 border-l-2 border-slate-500 whitespace-nowrap font-bold">
              Total
            </th>
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

// ─── Haupt-Seite ──────────────────────────────────────────────────────────────

const currentYear  = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;
const years = [currentYear - 1, currentYear, currentYear + 1];

type ViewMode = 'monthly' | 'yearly';

const PLViewPage = () => {
  const { isAdmin } = usePermissions();
  if (!isAdmin) return <Navigate to="/" replace />;

  const [year,   setYear]   = useState(currentYear);
  const [month,  setMonth]  = useState(currentMonth);
  const [mode,   setMode]   = useState<ViewMode>('monthly');
  const [drilldown, setDrilldown] = useState<PLDrilldown | null>(null);

  // Daten laden & P&L berechnen
  const records = useMemo(() => loadYear(year), [year, month]);

  const monthResult = useMemo(
    () => computePLForMonth(records[month - 1]),
    [records, month],
  );

  const yearResult = useMemo(
    () => computePLForYear(records),
    [records],
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
                  mode === 'monthly' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'
                )}
                onClick={() => setMode('monthly')}
              >
                <Calendar className="h-3 w-3" /> Monat
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

            {/* Monat (nur Monatsansicht) */}
            {mode === 'monthly' && (
              <Select value={String(month)} onValueChange={v => setMonth(Number(v))}>
                <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MONTH_NAMES_DE.slice(1).map((name, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 px-4 py-5 space-y-5 pb-20 max-w-full">

        {/* KPI-Karten (nur Monatsansicht) */}
        {mode === 'monthly' && (
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
        {mode === 'monthly' && !monthResult.hasData && (
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
                {mode === 'monthly'
                  ? `Erfolgsrechnung – ${MONTH_NAMES_DE[month]} ${year}`
                  : `Erfolgsrechnung – Jahresübersicht ${year}`}
              </h2>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {mode === 'monthly'
                  ? 'Ist / Budget / Vorjahr inkl. Abweichungen'
                  : 'Alle 12 Monate + Jahressumme · Klick auf Monatsspalte → Monatsansicht'}
              </p>
            </div>
            <div className="text-[10px] text-slate-400">
              {mode === 'monthly' && monthResult.hasData && (
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                  Daten vorhanden
                </span>
              )}
            </div>
          </div>

          {/* Tabelle */}
          {mode === 'monthly'
            ? <MonthlyView result={monthResult} onDrilldown={handleDrilldown} />
            : <YearView results={yearResult.months} onClickMonth={handleYearMonthClick} />
          }
        </div>

        {/* Legende */}
        {mode === 'monthly' && monthResult.hasData && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Info className="h-3 w-3" />
            Klicken Sie auf eine Zeilenposition für Quelldaten und Details.
          </p>
        )}
      </div>

      {/* Drilldown-Dialog */}
      {drilldown && (
        <DrilldownDialog drilldown={drilldown} onClose={() => setDrilldown(null)} />
      )}
    </div>
  );
};

export default PLViewPage;
