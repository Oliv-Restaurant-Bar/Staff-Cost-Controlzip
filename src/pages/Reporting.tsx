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
  FileDown, FileSpreadsheet, UserX, Palmtree, Stethoscope,
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
import { loadVjDailyYear } from '@/lib/vj-daily-supabase';
import type { VjDayRecord } from '@/lib/vj-daily-supabase';

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
  // Personalkosten
  pkIst:            number | null;
  pkBudget:         number | null;
  // Warenaufwand
  warenIst:         number | null;
  warenBudget:      number | null;
  // Quoten (null wenn Umsatz fehlt oder < 1'000 CHF)
  pkQuoteIst:       number | null;
  pkQuoteBudget:    number | null;
  warenQuoteIst:    number | null;
  warenQuoteBudget: number | null;
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
): MonthlyKPI[] {
  return effectiveMonths.map((m, idx) => {
    const umsatzIst     = m.revenueActual        ?? null;
    const umsatzBudget  = m.revenueBudget        ?? null;
    const umsatzVorjahr = m.revenuePreviousYear  ?? null;
    const pkIst         = m.personnelCostActual  ?? null;
    const pkBudget      = m.personnelCostPlanned ?? null;
    const warenRaw      = sumWarenaufwand(m);
    const warenIst      = warenRaw > 0 ? warenRaw : null;

    return {
      month:            idx + 1,
      label:            MONTH_NAMES_SHORT_DE[idx + 1],
      umsatzIst,
      umsatzBudget,
      umsatzVorjahr,
      pkIst,
      pkBudget,
      warenIst,
      warenBudget:      null,  // Budget-Warenaufwand noch nicht in budget_v1 abgebildet
      pkQuoteIst:       safeQuote(pkIst,    umsatzIst),
      pkQuoteBudget:    safeQuote(pkBudget, umsatzIst),
      warenQuoteIst:    safeQuote(warenIst, umsatzIst),
      warenQuoteBudget: null,
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

const RevenueComparisonChart = ({ data }: { data: MonthlyKPI[] }) => {
  const hasData = data.some(d => d.umsatzIst || d.umsatzBudget || d.umsatzVorjahr);
  if (!hasData) return <NoDataOverlay message="Noch keine Umsatzdaten vorhanden." />;

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} barGap={2} barCategoryGap="28%">
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis dataKey="label" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
        <YAxis
          tick={AXIS_STYLE} axisLine={false} tickLine={false} width={68}
          tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
        />
        <ReTooltip content={<ChfTooltip />} cursor={{ fill: 'hsl(var(--muted)/0.4)' }} />
        <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          formatter={v => <span style={{ color: 'hsl(var(--muted-foreground))' }}>{v}</span>} />
        <Bar dataKey="umsatzIst"     name="Umsatz Ist (Netto)"  fill={C_ACTUAL} radius={[3,3,0,0]} />
        <Bar dataKey="umsatzBudget"  name="Budget"              fill={C_BUDGET} radius={[3,3,0,0]} />
        <Bar dataKey="umsatzVorjahr" name="Vorjahr"             fill={C_PREV}   radius={[3,3,0,0]} />
      </BarChart>
    </ResponsiveContainer>
  );
};

// ─── Chart 2: PK-Quote pro Monat ─────────────────────────────────────────────

const PKQuoteChart = ({ data, threshold }: { data: MonthlyKPI[]; threshold: number }) => {
  const hasData = data.some(d => d.pkQuoteIst !== null || d.pkQuoteBudget !== null);
  if (!hasData) return <NoDataOverlay message="Keine PK-Quote berechenbar – bitte Umsatz und Personalkosten erfassen." />;

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} barCategoryGap="30%">
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis dataKey="label" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
        <YAxis
          tick={AXIS_STYLE} axisLine={false} tickLine={false} width={44}
          tickFormatter={v => `${v}%`}
          domain={[0, Math.max(threshold + 15, 50)]}
        />
        <ReTooltip
          content={<PctTooltip extraLabel={`Ziel: ≤ ${threshold} %`} />}
          cursor={{ fill: 'hsl(var(--muted)/0.4)' }}
        />
        <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          formatter={v => <span style={{ color: 'hsl(var(--muted-foreground))' }}>{v}</span>} />

        <ReferenceLine
          y={threshold}
          stroke={C_RED}
          strokeDasharray="6 3"
          strokeWidth={1.5}
          label={{ value: `Ziel ${threshold}%`, position: 'insideTopRight', fontSize: 10, fill: C_RED, dy: -4 }}
        />

        {/* PK Plan – heller Balken im Hintergrund */}
        <Bar dataKey="pkQuoteBudget" name="PK Plan %" fill={C_PK_PLAN} radius={[3,3,0,0]} opacity={0.65} />

        {/* PK Ist – farbige Balken + Label */}
        <Bar dataKey="pkQuoteIst" name="PK Ist %" radius={[3,3,0,0]}
          label={renderPctLabel as any}>
          {data.map((entry, i) => (
            <Cell key={i} fill={pkBarColor(entry.pkQuoteIst, threshold)} />
          ))}
        </Bar>

        {/* Verbindungslinie */}
        <Line
          dataKey="pkQuoteIst"
          stroke={C_ACTUAL}
          strokeWidth={1.5}
          dot={{ r: 3, fill: C_ACTUAL, stroke: 'white', strokeWidth: 1.5 }}
          connectNulls
          legendType="none"
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

// ─── Chart 3: Umsatz vs. Personalkosten ──────────────────────────────────────

const RevenuePKChart = ({ data }: { data: MonthlyKPI[] }) => {
  const hasData = data.some(d => d.umsatzIst || d.pkIst);
  if (!hasData) return <NoDataOverlay message="Noch keine Daten für dieses Diagramm vorhanden." />;

  const renderPKLabel = (props: Record<string, unknown>) => {
    const { x, y, width, value, index } = props as { x: number; y: number; width: number; value: number; index: number };
    const quote = data[index]?.pkQuoteIst;
    if (!value || !quote) return null;
    return (
      <text x={x + width / 2} y={y - 3} textAnchor="middle" fontSize={9} fontWeight="600" fill={C_RED}>
        {`${quote.toFixed(1)}%`}
      </text>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} barGap={3} barCategoryGap="28%">
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis dataKey="label" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
        <YAxis
          tick={AXIS_STYLE} axisLine={false} tickLine={false} width={68}
          tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
        />
        <ReTooltip content={<ChfTooltip />} cursor={{ fill: 'hsl(var(--muted)/0.4)' }} />
        <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          formatter={v => <span style={{ color: 'hsl(var(--muted-foreground))' }}>{v}</span>} />
        <Bar dataKey="umsatzIst" name="Umsatz Ist"      fill={C_ACTUAL}  radius={[3,3,0,0]} />
        <Bar dataKey="pkIst"     name="PK Ist"          fill={C_PK}      radius={[3,3,0,0]}
          label={renderPKLabel as any} />
        <Bar dataKey="pkBudget"  name="PK Plan"         fill={C_PK_PLAN} radius={[3,3,0,0]} opacity={0.65} />
      </BarChart>
    </ResponsiveContainer>
  );
};

// ─── Chart 4: Warenaufwand-Quote ──────────────────────────────────────────────

const WarenQuoteChart = ({ data }: { data: MonthlyKPI[] }) => {
  const hasData = data.some(d => d.warenQuoteIst !== null);
  if (!hasData) return <NoDataOverlay message="Kein Warenaufwand erfasst. Bitte Sage-CSV mit 4xxx-Konten importieren." />;

  const WAREN_THRESHOLD = 30;

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} barCategoryGap="32%">
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis dataKey="label" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
        <YAxis
          tick={AXIS_STYLE} axisLine={false} tickLine={false} width={44}
          tickFormatter={v => `${v}%`}
          domain={[0, Math.max(WAREN_THRESHOLD + 15, 45)]}
        />
        <ReTooltip
          content={<PctTooltip extraLabel={`Ziel: ≤ ${WAREN_THRESHOLD} %`} />}
          cursor={{ fill: 'hsl(var(--muted)/0.4)' }}
        />
        <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          formatter={v => <span style={{ color: 'hsl(var(--muted-foreground))' }}>{v}</span>} />

        <ReferenceLine
          y={WAREN_THRESHOLD}
          stroke={C_WAREN}
          strokeDasharray="6 3"
          strokeWidth={1.5}
          label={{ value: `Ziel ${WAREN_THRESHOLD}%`, position: 'insideTopRight', fontSize: 10, fill: C_WAREN, dy: -4 }}
        />

        <Bar dataKey="warenQuoteIst" name="Warenquote Ist %" radius={[3,3,0,0]}
          label={renderPctLabel as any}>
          {data.map((entry, i) => (
            <Cell key={i} fill={warenBarColor(entry.warenQuoteIst)} />
          ))}
        </Bar>

        <Line
          dataKey="warenQuoteIst"
          stroke={C_WAREN}
          strokeWidth={1.5}
          dot={{ r: 3, fill: C_WAREN, stroke: 'white', strokeWidth: 1.5 }}
          connectNulls
          legendType="none"
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

// ─── Chart 5: Umsatz vs. Warenaufwand ────────────────────────────────────────

const RevenueWarenChart = ({ data }: { data: MonthlyKPI[] }) => {
  const hasData = data.some(d => d.warenIst || d.umsatzIst);
  if (!hasData) return <NoDataOverlay message="Noch keine Daten vorhanden." />;

  const renderWarenLabel = (props: Record<string, unknown>) => {
    const { x, y, width, value, index } = props as { x: number; y: number; width: number; value: number; index: number };
    const quote = data[index]?.warenQuoteIst;
    if (!value || !quote) return null;
    return (
      <text x={x + width / 2} y={y - 3} textAnchor="middle" fontSize={9} fontWeight="600" fill={C_WAREN}>
        {`${quote.toFixed(1)}%`}
      </text>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} barGap={3} barCategoryGap="28%">
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis dataKey="label" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
        <YAxis
          tick={AXIS_STYLE} axisLine={false} tickLine={false} width={68}
          tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
        />
        <ReTooltip content={<ChfTooltip />} cursor={{ fill: 'hsl(var(--muted)/0.4)' }} />
        <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          formatter={v => <span style={{ color: 'hsl(var(--muted-foreground))' }}>{v}</span>} />
        <Bar dataKey="umsatzIst" name="Umsatz Ist"    fill={C_ACTUAL} radius={[3,3,0,0]} />
        <Bar dataKey="warenIst"  name="Warenaufwand"  fill={C_WAREN}  radius={[3,3,0,0]}
          label={renderWarenLabel as any} />
      </BarChart>
    </ResponsiveContainer>
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
        {!absenceSummary || Object.keys(absenceSummary).length === 0 ? (
          <p className="text-xs text-muted-foreground/60 italic py-2">
            Keine Absenzen im Dienstplan erfasst.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Object.entries(absenceSummary).map(([type, count]) => {
              const icon = type === 'vacation' ? <Palmtree className="h-3.5 w-3.5" />
                : type === 'sick' ? <Stethoscope className="h-3.5 w-3.5" />
                : <UserX className="h-3.5 w-3.5" />;
              const label = type === 'vacation' ? 'Ferien'
                : type === 'sick' ? 'Krankheit'
                : type;
              return (
                <div key={type} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
                    {icon}
                    <span className="text-[10px] uppercase tracking-wide">{label}</span>
                  </div>
                  <p className="text-lg font-bold">{count}</p>
                  <p className="text-[10px] text-muted-foreground">Einträge</p>
                </div>
              );
            })}
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
  kpis:           MonthlyKPI[];
  selected:       Set<number>;
  onToggle:       (month: number) => void;
  onSelectAll:    () => void;
  onSelectNone:   () => void;
}

const MonthSelectorPanel = ({ kpis, selected, onToggle, onSelectAll, onSelectNone }: MonthSelectorProps) => {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold text-foreground flex items-center gap-1.5">
          <BarChart2 className="h-3.5 w-3.5 text-muted-foreground" />
          Monatsauswahl für Kumuliert-Berechnung
        </h3>
        <div className="flex items-center gap-1.5">
          <button onClick={onSelectAll}  className="text-[10px] text-blue-600 hover:underline">Alle</button>
          <span className="text-muted-foreground/40">·</span>
          <button onClick={onSelectNone} className="text-[10px] text-muted-foreground hover:underline">Keine</button>
        </div>
      </div>
      <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5">
        {kpis.map(k => {
          const isChecked = selected.has(k.month);
          const hasData   = (k.umsatzIst ?? 0) > 0 || (k.pkIst ?? 0) > 0;
          return (
            <label
              key={k.month}
              className={cn(
                'flex flex-col items-center gap-0.5 rounded border px-1.5 py-1 cursor-pointer transition-colors text-[10px]',
                isChecked
                  ? 'bg-primary/10 border-primary/40 text-primary font-semibold'
                  : 'bg-card border-border text-muted-foreground hover:bg-muted/50',
                !hasData && 'opacity-50',
              )}
            >
              <input
                type="checkbox"
                checked={isChecked}
                onChange={() => onToggle(k.month)}
                className="sr-only"
              />
              <span>{k.label}</span>
              {hasData && (
                <span className={cn('w-1.5 h-1.5 rounded-full', isChecked ? 'bg-primary' : 'bg-muted-foreground/40')} />
              )}
            </label>
          );
        })}
      </div>
      <p className="text-[10px] text-muted-foreground/60">
        ☑ {selected.size} Monat{selected.size !== 1 ? 'e' : ''} ausgewählt – Prozentwerte werden aus Summen berechnet (nicht Durchschnitt der Monatsquoten).
      </p>
    </div>
  );
};

// ─── Kumuliert-Zusammenfassung ────────────────────────────────────────────────

interface CumulatedTotals {
  umsatzIst:    number;
  umsatzBudget: number;
  pkIst:        number;
  pkBudget:     number;
  warenIst:     number;
  pkQuote:      number | null;
  pkQuoteBudget: number | null;
  warenQuote:   number | null;
  months:       number;
}

function calcCumulated(kpis: MonthlyKPI[], selected: Set<number>): CumulatedTotals {
  const sel = kpis.filter(k => selected.has(k.month));
  const sumU  = sel.reduce((s, k) => s + (k.umsatzIst ?? 0), 0);
  const sumUB = sel.reduce((s, k) => s + (k.umsatzBudget ?? 0), 0);
  const sumPK = sel.reduce((s, k) => s + (k.pkIst ?? 0), 0);
  const sumPKB= sel.reduce((s, k) => s + (k.pkBudget ?? 0), 0);
  const sumW  = sel.reduce((s, k) => s + (k.warenIst ?? 0), 0);
  return {
    umsatzIst:     sumU,
    umsatzBudget:  sumUB,
    pkIst:         sumPK,
    pkBudget:      sumPKB,
    warenIst:      sumW,
    pkQuote:       sumU >= 1000 && sumPK > 0 ? parseFloat(((sumPK / sumU) * 100).toFixed(1)) : null,
    pkQuoteBudget: sumU >= 1000 && sumPKB > 0 ? parseFloat(((sumPKB / sumU) * 100).toFixed(1)) : null,
    warenQuote:    sumU >= 1000 && sumW > 0 ? parseFloat(((sumW / sumU) * 100).toFixed(1)) : null,
    months:        sel.length,
  };
}

// ─── Haupt-Seite ──────────────────────────────────────────────────────────────

const Reporting = () => {
  const { isAdmin }          = usePermissions();
  const { tenantId, tenantKey } = useTenant();

  if (!isAdmin) return <Navigate to="/" replace />;

  const { isInScope, isActive: stichtagActive } = useStichtag();
  const years = availableYears();
  const [year,        setYear]        = useState(currentYear);
  const [months,      setMonths]      = useState<MonthlyFinancialRecord[]>(() => loadYear(year));
  const [editRecord,  setEditRecord]  = useState<MonthlyFinancialRecord | null>(null);
  const [highlightVariance, setHighlightVariance] = useState(false);

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

      // 1) IST-Umsatz: computeMonthlyIstNet (NETTO – identisch mit PLView)
      const hasIndivRev = r.expenseCategories.some(c => {
        const n = parseInt(c.categoryId);
        return !isNaN(n) && n >= 3000 && n <= 3999;
      });
      if (!hasIndivRev) {
        const net = computeMonthlyIstNet(year, m, dailyBudgetsData);
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
  }, [months, year, dailyBudgetsData, vjDailyData, resolvedBudget, prevYearMonths]);

  // ── Zentrales KPI-Array (alle Charts nutzen dasselbe Objekt) ────────────
  const monthlyKPIs = useMemo(() => buildMonthlyKPIs(effectiveMonths), [effectiveMonths]);

  // ── Monatsauswahl ────────────────────────────────────────────────────────
  const [selectedMonths, setSelectedMonths] = useState<Set<number>>(() => new Set(Array.from({ length: 12 }, (_, i) => i + 1)));

  const toggleMonth    = (m: number) => setSelectedMonths(prev => {
    const next = new Set(prev);
    next.has(m) ? next.delete(m) : next.add(m);
    return next;
  });
  const selectAllMonths  = () => setSelectedMonths(new Set(Array.from({ length: 12 }, (_, i) => i + 1)));
  const selectNoMonths   = () => setSelectedMonths(new Set());

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

  const handleExportExcel = () => {
    try {
      exportReportingToExcel(effectiveMonths, totals, year);
      toast.success('Excel exportiert');
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
              <RevenueComparisonChart data={monthlyKPIs} />
            </CardContent>
          </Card>
        </section>

        {/* ── Diagramme: Personalkosten ── */}
        <section className="space-y-4">
          <h2 className="text-sm font-bold">Personalkosten-Analyse {year}</h2>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* PK-Quote */}
            <Card>
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  Personalkostenquote pro Monat (%)
                </CardTitle>
                <div className="flex items-center gap-3 text-[10px] mt-0.5">
                  <span className="inline-flex items-center gap-1 text-green-600 font-medium">■ unter Ziel</span>
                  <span className="inline-flex items-center gap-1 text-amber-600 font-medium">■ nahe Ziel</span>
                  <span className="inline-flex items-center gap-1 text-red-600 font-medium">■ über Ziel</span>
                  <span className="text-muted-foreground/60">· Ziel: ≤ {threshold} %</span>
                </div>
              </CardHeader>
              <CardContent className="pt-0 pr-2">
                <PKQuoteChart data={monthlyKPIs} threshold={threshold} />
              </CardContent>
            </Card>

            {/* Umsatz vs. PK */}
            <Card>
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <BarChart2 className="h-4 w-4 text-muted-foreground" />
                  Umsatz vs. Personalkosten (CHF)
                </CardTitle>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  PK%-Wert wird direkt auf dem Personalkosten-Balken angezeigt.
                </p>
              </CardHeader>
              <CardContent className="pt-0 pr-2">
                <RevenuePKChart data={monthlyKPIs} />
              </CardContent>
            </Card>
          </div>
        </section>

        {/* ── Diagramme: Warenaufwand ── */}
        <section className="space-y-4">
          <h2 className="text-sm font-bold">Warenaufwand-Analyse {year}</h2>
          <p className="text-xs text-muted-foreground -mt-2">
            Warenaufwand wird aus importierten Sage-Konten (4xxx) oder manuell hinterlegten Kategorien berechnet.
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  Warenaufwandquote pro Monat (%)
                </CardTitle>
                <div className="flex items-center gap-3 text-[10px] mt-0.5">
                  <span className="inline-flex items-center gap-1 text-green-600 font-medium">■ ≤ 28%</span>
                  <span className="inline-flex items-center gap-1 text-amber-600 font-medium">■ 28–33%</span>
                  <span className="inline-flex items-center gap-1 text-red-600 font-medium">■ &gt; 33%</span>
                  <span className="text-muted-foreground/60">· Ziel: ≤ 30%</span>
                </div>
              </CardHeader>
              <CardContent className="pt-0 pr-2">
                <WarenQuoteChart data={monthlyKPIs} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm flex items-center gap-2">
                  <BarChart2 className="h-4 w-4 text-muted-foreground" />
                  Umsatz vs. Warenaufwand (CHF)
                </CardTitle>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Warenquote (%) wird direkt auf dem Warenaufwand-Balken angezeigt.
                </p>
              </CardHeader>
              <CardContent className="pt-0 pr-2">
                <RevenueWarenChart data={monthlyKPIs} />
              </CardContent>
            </Card>
          </div>
        </section>

        {/* ── Absenzen ── */}
        <AbsenzMonatsBlock year={year} />

        {/* ── Monatsauswahl ── */}
        <MonthSelectorPanel
          kpis={monthlyKPIs}
          selected={selectedMonths}
          onToggle={toggleMonth}
          onSelectAll={selectAllMonths}
          onSelectNone={selectNoMonths}
        />

        {/* ── Kumuliert-Zusammenfassung ── */}
        {selectedMonths.size > 0 && cumulated.umsatzIst > 0 && (
          <section>
            <h2 className="text-sm font-bold mb-3">
              Kumuliert – {selectedMonths.size} ausgewählte Monate
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
          </section>
        )}

        {/* ── Haupttabelle ── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold">Monatsdaten {year}</h2>
            <div className="flex items-center gap-2">
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
            </div>
          </div>

          <div className="rounded-lg border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/50 border-b border-border">
                    <th className="text-left px-3 py-2.5 font-semibold text-muted-foreground w-20">Monat</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">Umsatz Ist</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">Budget</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">Vorjahr</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">PK Ist</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">PK %</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">Waren</th>
                    <th className="text-right px-3 py-2.5 font-semibold text-muted-foreground">Waren %</th>
                    <th className="text-center px-3 py-2.5 font-semibold text-muted-foreground w-16">Vollst.</th>
                    <th className="text-center px-3 py-2.5 font-semibold text-muted-foreground w-20">Aktion</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {effectiveMonths.map((m, idx) => {
                    const kpi         = monthlyKPIs[idx];
                    const completeness = calcCompleteness(m);
                    const isEmpty     = !m.revenueActual && !m.revenueBudget && !m.personnelCostActual && !m.personnelCostPlanned && m.expenseCategories.length === 0;
                    const isCurrent   = m.year === currentYear && m.month === currentMonth;
                    const isFuture    = m.year > currentYear || (m.year === currentYear && m.month > currentMonth);
                    const isOutOfScope = stichtagActive && !isInScope(m.year, m.month);
                    const isSelected  = selectedMonths.has(m.month);

                    const revPct = m.revenueActual != null && m.revenueBudget != null && m.revenueBudget !== 0
                      ? ((m.revenueActual - m.revenueBudget) / Math.abs(m.revenueBudget)) * 100
                      : undefined;
                    const isVarHighlighted = highlightVariance && revPct !== undefined && Math.abs(revPct) > 10;
                    const varRowClass = isVarHighlighted
                      ? revPct! < 0
                        ? 'bg-red-50 dark:bg-red-950/20 border-l-4 border-l-red-400'
                        : 'bg-green-50 dark:bg-green-950/20 border-l-4 border-l-green-400'
                      : '';

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
                        <td className="px-3 py-2 font-semibold">
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
                        <td className="px-3 py-2 text-right font-mono">
                          {m.revenueActual !== undefined
                            ? <span className={varianceColor(m.revenueActual, m.revenueBudget)}>{fmtCHF(m.revenueActual)}</span>
                            : <span className="text-muted-foreground/40">–</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                          {m.revenueBudget !== undefined ? fmtCHF(m.revenueBudget) : '–'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                          {m.revenuePreviousYear !== undefined
                            ? <>{fmtCHF(m.revenuePreviousYear)}{m.revenueActual && <span className="ml-1 text-[9px]">{formatVariance(m.revenueActual, m.revenuePreviousYear)}</span>}</>
                            : '–'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {m.personnelCostActual !== undefined ? fmtCHF(m.personnelCostActual) : <span className="text-muted-foreground/40">–</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {kpi.pkQuoteIst !== null
                            ? <span className={cn('font-semibold', kpi.pkQuoteIst > threshold ? 'text-red-600' : kpi.pkQuoteIst > threshold - 3 ? 'text-amber-600' : 'text-green-600')}>
                                {fmtPct(kpi.pkQuoteIst)}
                              </span>
                            : <span className="text-muted-foreground/40">–</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-amber-700 dark:text-amber-400">
                          {kpi.warenIst !== null ? fmtCHF(kpi.warenIst) : <span className="text-muted-foreground/40">–</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {kpi.warenQuoteIst !== null
                            ? <span className={cn('font-semibold', kpi.warenQuoteIst > 33 ? 'text-red-600' : kpi.warenQuoteIst > 28 ? 'text-amber-600' : 'text-green-600')}>
                                {fmtPct(kpi.warenQuoteIst)}
                              </span>
                            : <span className="text-muted-foreground/40">–</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <CompletenessBadge pct={completeness.completenessPercent} />
                        </td>
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
                      <td className="px-3 py-2.5 text-xs font-bold text-blue-800 dark:text-blue-300">
                        Σ Auswahl ({selectedMonths.size} Mo.)
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">{fmtCHF(cumulated.umsatzIst)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">{cumulated.umsatzBudget > 0 ? fmtCHF(cumulated.umsatzBudget) : '–'}</td>
                      <td className="px-3 py-2.5 text-center text-muted-foreground">–</td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">{fmtCHF(cumulated.pkIst)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">
                        {cumulated.pkQuote != null ? (
                          <span className={cumulated.pkQuote > threshold ? 'text-red-600' : 'text-green-600'}>
                            {fmtPct(cumulated.pkQuote)}
                          </span>
                        ) : '–'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-amber-700">{cumulated.warenIst > 0 ? fmtCHF(cumulated.warenIst) : '–'}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">
                        {cumulated.warenQuote != null ? (
                          <span className={cumulated.warenQuote > 30 ? 'text-red-600' : 'text-green-600'}>
                            {fmtPct(cumulated.warenQuote)}
                          </span>
                        ) : '–'}
                      </td>
                      <td />
                      <td />
                    </tr>
                  )}

                  {/* ── Total-Zeile ── */}
                  {hasAnyData && (
                    <tr className="bg-slate-100 dark:bg-slate-800 border-t-2 border-border font-bold">
                      <td className="px-3 py-2.5 text-sm font-bold">Σ Total {year}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">{totals.revenueActual > 0 ? fmtCHF(totals.revenueActual) : '–'}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">{totals.revenueBudget > 0 ? fmtCHF(totals.revenueBudget) : '–'}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-muted-foreground">
                        {totals.revenuePreviousYear > 0 ? <>
                          {fmtCHF(totals.revenuePreviousYear)}
                          {totals.revenueActual > 0 && <span className="ml-1 text-[9px] font-normal">{formatVariance(totals.revenueActual, totals.revenuePreviousYear)}</span>}
                        </> : '–'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">
                        {totals.personnelCostActual > 0 ? <>
                          {fmtCHF(totals.personnelCostActual)}
                          {totals.revenueActual > 0 && <span className="ml-1 text-[9px] font-normal text-muted-foreground">{fmtPct(safeQuote(totals.personnelCostActual, totals.revenueActual))}</span>}
                        </> : '–'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm">
                        {safeQuote(totals.personnelCostActual, totals.revenueActual) != null
                          ? fmtPct(safeQuote(totals.personnelCostActual, totals.revenueActual))
                          : '–'}
                      </td>
                      <td className="px-3 py-2.5 text-center text-muted-foreground">–</td>
                      <td className="px-3 py-2.5 text-center text-muted-foreground">–</td>
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
