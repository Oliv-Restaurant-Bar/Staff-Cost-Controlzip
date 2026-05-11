import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import {
  TrendingUp, AlertTriangle, CheckCircle,
  Lightbulb, BarChart2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PfixSlice {
  fix: number;
  planWork: number; istWork: number;
  planHoliday: number; istHoliday: number;
  planTotalVar: number; istTotalVar: number;
  planTotal: number; istTotal: number;
  diffWork: number; diffHoliday: number; diffTotalVar: number; diffTotal: number;
}

export interface MgmtEmpRow {
  id: string; name: string; dept: string; hourlyWage: number;
  planH: number; istH: number;
  planWork: number; istWork: number;
  planHoliday: number; istHoliday: number;
  planTotalVar: number; istTotalVar: number;
  diffWork: number; diffHoliday: number; diffTotalVar: number;
}

export interface MgmtAbwDay {
  date: string;
  planWork: number; istWork: number;
  planTotal: number; istTotal: number;
  diff: number; diffPct: number | null;
}

export interface MgmtDeptRow {
  dept: string;
  fix: number; varArbeit: number; ferienabbau: number; variabel: number; total: number;
}

export interface ManagementInsightsProps {
  selectedYear: number;
  selectedMonth: number;
  pfix: { active: PfixSlice; month: PfixSlice; cutoff: PfixSlice | null };
  pfixPerEmp: MgmtEmpRow[];
  personnelBudget: number;
  forecastDelta: number;
  forecastStatus: 'on_track' | 'warning' | 'off_track';
  forecastFlexTotal: number;
  forecastAvailableVar: number;
  avgHourlyWage: number;
  effectiveForecastCutoff: number;
  daysInSelectedMonth: number;
  deptSummary: MgmtDeptRow[];
  abwDays: MgmtAbwDay[];
  totalFixCost: number;
  forecastIstDay: number | null;
  onForecastIstDayChange: (day: number | null) => void;
  todayDate: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtCHF = (n: number) =>
  n.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 });

// ─── Ampel Dots ───────────────────────────────────────────────────────────────

function AmpelDots({ status }: { status: 'on_track' | 'warning' | 'off_track' }) {
  return (
    <div className="flex flex-col gap-1 items-center shrink-0">
      <div className={cn('h-3.5 w-3.5 rounded-full transition-all',
        status === 'off_track' ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]' : 'bg-red-200 dark:bg-red-900')} />
      <div className={cn('h-3.5 w-3.5 rounded-full transition-all',
        status === 'warning' ? 'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.6)]' : 'bg-amber-200 dark:bg-amber-900')} />
      <div className={cn('h-3.5 w-3.5 rounded-full transition-all',
        status === 'on_track' ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]' : 'bg-emerald-200 dark:bg-emerald-900')} />
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ManagementInsights({
  selectedYear,
  selectedMonth,
  pfix,
  pfixPerEmp,
  personnelBudget,
  forecastDelta,
  forecastStatus,
  forecastFlexTotal,
  avgHourlyWage,
  effectiveForecastCutoff,
  daysInSelectedMonth,
  deptSummary,
  totalFixCost,
  forecastIstDay,
  onForecastIstDayChange,
  todayDate,
}: ManagementInsightsProps) {
  const monthLabel = new Date(selectedYear, selectedMonth - 1, 1)
    .toLocaleString('de-CH', { month: 'long', year: 'numeric' });

  // ── Derived values ──────────────────────────────────────────────────────────
  const forecastTotal     = totalFixCost + forecastFlexTotal;
  const forecastDeltaPct  = personnelBudget > 0 ? (forecastDelta / personnelBudget) * 100 : 0;
  const currentIstTotal   = pfix.active.fix + pfix.active.istWork;
  const remainingPlanFlex = Math.max(0, forecastFlexTotal - pfix.active.istWork);
  const hoursSaved        = avgHourlyWage > 0 ? Math.ceil(Math.abs(forecastDelta) / avgHourlyWage) : 0;
  const hoursHeadroom     = avgHourlyWage > 0 && forecastDelta > 0 ? Math.floor(forecastDelta / avgHourlyWage) : 0;

  // ── Status styles ────────────────────────────────────────────────────────────
  const S = {
    on_track: {
      bg: 'bg-emerald-50/60 dark:bg-emerald-950/20',
      border: 'border-emerald-200 dark:border-emerald-800',
      text: 'text-emerald-700 dark:text-emerald-400',
      label: 'Im Plan',
      icon: <CheckCircle className="h-5 w-5 text-emerald-500" />,
    },
    warning: {
      bg: 'bg-amber-50/60 dark:bg-amber-950/20',
      border: 'border-amber-200 dark:border-amber-800',
      text: 'text-amber-700 dark:text-amber-400',
      label: 'Risiko',
      icon: <AlertTriangle className="h-5 w-5 text-amber-500" />,
    },
    off_track: {
      bg: 'bg-red-50/60 dark:bg-red-950/20',
      border: 'border-red-200 dark:border-red-800',
      text: 'text-red-700 dark:text-red-400',
      label: 'Budgetüberschreitung',
      icon: <TrendingUp className="h-5 w-5 text-red-500" />,
    },
  }[forecastStatus];

  // ── Abteilungsvergleich ─────────────────────────────────────────────────────
  const deptRows = useMemo(() => {
    const depts = ['service', 'küche'];
    return depts.map(dept => {
      const row      = deptSummary.find(d => d.dept === dept);
      const empRows  = pfixPerEmp.filter(e => e.dept === dept);
      const planWork = empRows.reduce((s, e) => s + e.planWork, 0);
      const istWork  = empRows.reduce((s, e) => s + e.istWork, 0);
      const diffWork = istWork - planWork;
      const diffPct  = planWork > 0 ? (diffWork / planWork) * 100 : null;
      return { dept, fix: row?.fix ?? 0, planWork, istWork, diffWork, diffPct };
    }).filter(d => d.planWork > 0 || d.istWork > 0 || d.fix > 0);
  }, [deptSummary, pfixPerEmp]);

  const hasAnyData = personnelBudget > 0 || pfixPerEmp.length > 0;

  return (
    <section className="space-y-4">
      {/* ── Section Divider ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 pt-2">
        <div className="h-px flex-1 bg-border" />
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-border bg-card text-xs font-semibold text-muted-foreground">
          <Lightbulb className="h-3.5 w-3.5 text-amber-500" />
          Management Insights (Beta)
        </div>
        <div className="h-px flex-1 bg-border" />
      </div>
      <p className="text-[11px] text-muted-foreground text-center -mt-2">
        Forecast Monatsende · Risiko-Ampel · Abteilungsvergleich · {monthLabel}
      </p>

      {!hasAnyData ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
          Keine Daten für Management Insights vorhanden.
        </div>
      ) : (
        <>
          {/* ── Row 1: Forecast + Risiko-Ampel ──────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

            {/* Forecast Monatsende */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  Forecast Monatsende
                </CardTitle>
                {/* Inline Ist-bis-Tag picker */}
                <div className="flex items-center gap-2 flex-wrap mt-0.5">
                  <span className="text-[10px] text-muted-foreground/70">Ist bis Tag</span>
                  <input
                    type="number"
                    min={1}
                    max={daysInSelectedMonth}
                    value={forecastIstDay ?? ''}
                    onChange={e => {
                      const v = parseInt(e.target.value, 10);
                      if (!isNaN(v) && v >= 1 && v <= daysInSelectedMonth) onForecastIstDayChange(v);
                      else if (e.target.value === '') onForecastIstDayChange(null);
                    }}
                    placeholder={String(todayDate)}
                    className="w-11 text-center rounded border border-violet-300 dark:border-violet-600 bg-background text-[11px] font-semibold px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-violet-400"
                  />
                  {forecastIstDay !== null && (
                    <button
                      onClick={() => onForecastIstDayChange(null)}
                      className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground leading-none"
                      title="Zurücksetzen auf heute"
                    >×</button>
                  )}
                  <span className="text-[10px] text-muted-foreground/70">
                    {effectiveForecastCutoff > 0
                      ? `→ Restkosten ab ${Math.min(effectiveForecastCutoff + 1, daysInSelectedMonth)}.`
                      : '(kein Ist)'}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-2.5">
                {personnelBudget === 0 ? (
                  <p className="text-xs text-muted-foreground italic py-4 text-center">
                    Kein Budget hinterlegt — Forecast nicht berechenbar.
                  </p>
                ) : (
                  <>
                    <div className="space-y-1.5 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">
                          Personal Ist{effectiveForecastCutoff > 0 ? ` bis ${effectiveForecastCutoff}.` : ''}
                        </span>
                        <span className="font-mono font-semibold">{fmtCHF(currentIstTotal)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">+ Geplante Restkosten Flex</span>
                        <span className="font-mono font-semibold">{fmtCHF(remainingPlanFlex)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">+ Fix gesamt (Monat)</span>
                        <span className="font-mono font-semibold">{fmtCHF(totalFixCost)}</span>
                      </div>
                      <div className="h-px bg-border my-1" />
                      <div className="flex justify-between items-center">
                        <span className="font-semibold">Forecast Ende {monthLabel.split(' ')[0]}</span>
                        <span className="font-mono font-bold text-sm">{fmtCHF(forecastTotal)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Budget</span>
                        <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">{fmtCHF(personnelBudget)}</span>
                      </div>
                    </div>

                    {/* Delta highlight */}
                    <div className={cn(
                      'rounded-lg border px-3 py-2.5 flex items-center justify-between gap-3',
                      S.border, S.bg,
                    )}>
                      <div>
                        <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Erwartete Abweichung</p>
                        <p className={cn('text-lg font-bold font-mono mt-0.5', S.text)}>
                          {forecastDelta >= 0 ? '−' : '+'}{fmtCHF(Math.abs(forecastDelta))}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {Math.abs(forecastDeltaPct).toFixed(1)} % des Budgets ·{' '}
                          {forecastDelta >= 0 ? 'unter Budget' : 'über Budget'}
                        </p>
                      </div>
                      <div className="flex items-center gap-2.5 self-center">
                        {S.icon}
                        <AmpelDots status={forecastStatus} />
                      </div>
                    </div>

                    {/* Spielraum / Reduktion */}
                    {avgHourlyWage > 0 && (
                      <p className={cn(
                        'text-xs rounded-lg border px-3 py-2',
                        forecastDelta >= 0
                          ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400'
                          : 'border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 text-red-700 dark:text-red-400',
                      )}>
                        {forecastDelta >= 0
                          ? `✓ Spielraum von ca. ${hoursHeadroom} Flex-Stunden.`
                          : `→ Ca. ${hoursSaved} Flex-Stunden müssten reduziert werden.`}
                      </p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            {/* Risiko-Ampel */}
            <Card className={cn('border-2', S.border)}>
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  {S.icon}
                  Risiko-Ampel — {S.label}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                {/* Status text */}
                <div className={cn('rounded-lg p-3 text-sm font-semibold', S.bg, S.text)}>
                  {forecastStatus === 'on_track' &&
                    `Der Monat liegt aktuell ${fmtCHF(Math.abs(forecastDelta))} unter Budget.`}
                  {forecastStatus === 'warning' &&
                    `Leichte Überschreitung möglich: ca. ${fmtCHF(Math.abs(forecastDelta))} über Budget.`}
                  {forecastStatus === 'off_track' &&
                    `Bei unverändertem Plan wird das Monatsbudget voraussichtlich um ${fmtCHF(Math.abs(forecastDelta))} überschritten.`}
                </div>

                {/* Ampel visual */}
                <div className="flex items-center gap-5 justify-center py-1">
                  {(['off_track', 'warning', 'on_track'] as const).map(s => (
                    <div key={s} className="flex flex-col items-center gap-1.5">
                      <div className={cn(
                        'h-7 w-7 rounded-full border-2 transition-all',
                        forecastStatus === s
                          ? s === 'on_track'  ? 'bg-emerald-500 border-emerald-600 shadow-[0_0_10px_rgba(16,185,129,0.5)]'
                          : s === 'warning'   ? 'bg-amber-500 border-amber-600 shadow-[0_0_10px_rgba(245,158,11,0.5)]'
                                              : 'bg-red-500 border-red-600 shadow-[0_0_10px_rgba(239,68,68,0.5)]'
                          : 'bg-muted border-border opacity-40',
                      )} />
                      <span className="text-[9px] text-muted-foreground font-medium">
                        {s === 'on_track' ? 'Grün' : s === 'warning' ? 'Orange' : 'Rot'}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Abteilung Kurzinfo */}
                {deptRows.length > 0 && (
                  <div className="space-y-1.5 pt-1 border-t border-border">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Abweichung je Abteilung</p>
                    {deptRows.map(d => {
                      const label  = d.dept === 'service' ? '🍽 Service' : '🍳 Küche';
                      const isOver = d.diffWork > 10;
                      return (
                        <div key={d.dept} className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium">{label}</span>
                          <span className={cn('font-mono font-semibold',
                            isOver ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                            {d.diffWork > 0.01 ? '+' : d.diffWork < -0.01 ? '−' : '±'}
                            {fmtCHF(Math.abs(d.diffWork))}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Service vs. Küche — Abteilungsvergleich (full-width) ─────── */}
          {deptRows.length > 0 && (
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <BarChart2 className="h-4 w-4 text-muted-foreground" />
                  Service vs. Küche
                </CardTitle>
                <p className="text-[10px] text-muted-foreground/70">
                  Flex-Arbeit Plan vs. Ist je Abteilung.
                </p>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="space-y-4">
                  {deptRows.map(d => {
                    const label  = d.dept === 'service' ? '🍽 Service' : '🍳 Küche';
                    const isOver = d.diffWork > 10;
                    const barIst = d.planWork > 0
                      ? Math.min(120, (d.istWork / d.planWork) * 100)
                      : d.istWork > 0 ? 100 : 0;
                    return (
                      <div key={d.dept} className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold">{label}</span>
                          <div className={cn(
                            'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold border',
                            isOver
                              ? 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-800 dark:text-red-400'
                              : 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950/30 dark:border-emerald-800 dark:text-emerald-400',
                          )}>
                            <span className={cn('h-1.5 w-1.5 rounded-full inline-block',
                              isOver ? 'bg-red-500' : 'bg-emerald-500')} />
                            {isOver ? 'Über Plan' : 'Im Plan'}
                          </div>
                        </div>
                        <div className="relative h-6 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn('h-full rounded-full transition-all', isOver ? 'bg-red-400/70' : 'bg-emerald-400/70')}
                            style={{ width: `${Math.min(100, barIst)}%` }}
                          />
                          <div className="absolute inset-0 flex items-center justify-between px-2.5 text-[10px] font-mono font-bold text-foreground">
                            <span>Plan {fmtCHF(d.planWork)}</span>
                            <span>Ist {fmtCHF(d.istWork)}</span>
                          </div>
                        </div>
                        <div className="flex justify-between text-[10px] px-1">
                          <span className="text-muted-foreground">Fix: {fmtCHF(d.fix)}</span>
                          <span className={cn('font-semibold',
                            isOver ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                            {d.diffWork > 0.01 ? '+' : d.diffWork < -0.01 ? '−' : '±'}
                            {fmtCHF(Math.abs(d.diffWork))}
                            {d.diffPct != null && ` (${d.diffPct > 0 ? '+' : ''}${d.diffPct.toFixed(1)} %)`}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </section>
  );
}
