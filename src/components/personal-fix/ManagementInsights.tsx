import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import {
  TrendingUp, AlertTriangle, CheckCircle,
  Lightbulb, Users, BarChart2, Zap, Target,
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtCHF = (n: number) =>
  n.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 });

const fmtCHFDec = (n: number) =>
  n.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}.`;
}

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
  abwDays,
  totalFixCost,
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

  // ── Kritische Tage ──────────────────────────────────────────────────────────
  const criticalDays = useMemo(() =>
    [...abwDays]
      .filter(d => d.diff > 0.01)
      .sort((a, b) => b.diff - a.diff)
      .slice(0, 7),
    [abwDays],
  );

  // ── Top Kostentreiber ───────────────────────────────────────────────────────
  const topDrivers = useMemo(() =>
    [...pfixPerEmp]
      .filter(e => e.diffWork > 0.01)
      .sort((a, b) => b.diffWork - a.diffWork)
      .slice(0, 5),
    [pfixPerEmp],
  );

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

  // ── Handlungsempfehlungen (regelbasiert) ────────────────────────────────────
  const recommendations = useMemo(() => {
    const items: { icon: string; text: string; severity: 'red' | 'amber' | 'green' | 'neutral' }[] = [];

    if (personnelBudget > 0) {
      if (forecastStatus === 'off_track') {
        items.push({
          icon: '🔴',
          text: `Wenn keine Anpassung erfolgt, wird das Budget voraussichtlich um ${fmtCHF(Math.abs(forecastDelta))} überschritten.`,
          severity: 'red',
        });
        if (avgHourlyWage > 0 && hoursSaved > 0) {
          items.push({
            icon: '⚙️',
            text: `Reduziere in der verbleibenden Monatsplanung ca. ${hoursSaved} Flex-Stunden, um im Budget zu bleiben.`,
            severity: 'red',
          });
        }
      } else if (forecastStatus === 'warning') {
        items.push({
          icon: '🟡',
          text: `Leichte Budgetüberschreitung möglich (${fmtCHF(Math.abs(forecastDelta))}). Flex-Stunden beobachten.`,
          severity: 'amber',
        });
      } else {
        items.push({
          icon: '🟢',
          text: `Der Monat liegt aktuell ${fmtCHF(Math.abs(forecastDelta))} unter Budget. Spielraum vorhanden.`,
          severity: 'green',
        });
      }
    }

    if (criticalDays.length > 0) {
      const top3 = criticalDays.slice(0, 3).map(d => fmtDate(d.date)).join(', ');
      items.push({
        icon: '📅',
        text: `Prüfe die Tage ${top3}: dort liegen die Ist-Kosten über Plan.`,
        severity: criticalDays.length >= 3 ? 'amber' : 'neutral',
      });
    }

    const sortedDepts = [...deptRows].sort((a, b) => b.diffWork - a.diffWork);
    const worstDept = sortedDepts[0];
    const bestDept  = sortedDepts[sortedDepts.length - 1];
    if (worstDept && worstDept.diffWork > 50) {
      const lbl = worstDept.dept === 'service' ? 'Service' : 'Küche';
      items.push({
        icon: '🍳',
        text: `${lbl} verursacht aktuell die grösste Abweichung (${fmtCHF(worstDept.diffWork)} über Plan). Prüfe Schichtlängen und Aushilfen.`,
        severity: 'amber',
      });
    }
    if (bestDept && bestDept !== worstDept && bestDept.diffWork < -10) {
      const lbl = bestDept.dept === 'service' ? 'Service' : 'Küche';
      items.push({
        icon: '✅',
        text: `${lbl} liegt im Plan. Fokus zuerst auf die andere Abteilung.`,
        severity: 'green',
      });
    }

    if (topDrivers.length > 0) {
      const names = topDrivers.slice(0, 2).map(e => e.name).join(' und ');
      items.push({
        icon: '👤',
        text: `${names} haben die höchsten Abweichungen zwischen Plan und Ist.`,
        severity: 'neutral',
      });
    }

    if (items.length === 0) {
      items.push({
        icon: 'ℹ️',
        text: 'Noch keine Ist-Daten erfasst. Empfehlungen erscheinen sobald Ist-Stunden importiert sind.',
        severity: 'neutral',
      });
    }

    return items;
  }, [forecastStatus, forecastDelta, personnelBudget, criticalDays, deptRows, topDrivers, avgHourlyWage, hoursSaved]);

  const hasAnyData = personnelBudget > 0 || abwDays.length > 0 || pfixPerEmp.length > 0;

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
        Automatische Handlungsempfehlungen aus Fixkosten, Flexkosten, Ist-Stunden, Plan-Stunden und Budget · {monthLabel}
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
                <p className="text-[10px] text-muted-foreground/70">
                  {effectiveForecastCutoff > 0
                    ? `Ist bis ${effectiveForecastCutoff}. + geplante Restkosten ab ${Math.min(effectiveForecastCutoff + 1, daysInSelectedMonth)}.`
                    : 'Vollständiger Monatsplan (noch keine Ist-Daten)'}
                </p>
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

          {/* ── Row 2: Kritische Tage + Top Kostentreiber ───────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

            {/* Kritische Tage */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Kritische Tage
                </CardTitle>
                <p className="text-[10px] text-muted-foreground/70">
                  Tage mit Ist-Kosten über Plan — sortiert nach Abweichung.
                </p>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {criticalDays.length === 0 ? (
                  <div className="py-6 text-center">
                    <CheckCircle className="h-7 w-7 text-emerald-500 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">Keine kritischen Tage — Ist liegt überall im Plan.</p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {criticalDays.map(d => {
                      const pct = d.diffPct ?? 0;
                      const sev = pct > 20 ? 'red' : pct > 8 ? 'amber' : 'yellow';
                      return (
                        <div key={d.date} className={cn(
                          'flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs border',
                          sev === 'red'
                            ? 'bg-red-50/60 dark:bg-red-950/20 border-red-200 dark:border-red-800'
                            : sev === 'amber'
                              ? 'bg-amber-50/60 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800'
                              : 'bg-yellow-50/40 dark:bg-yellow-950/10 border-yellow-200 dark:border-yellow-900',
                        )}>
                          <div className="flex items-center gap-2">
                            <span className={cn('w-2 h-2 rounded-full shrink-0',
                              sev === 'red' ? 'bg-red-500' : sev === 'amber' ? 'bg-amber-500' : 'bg-yellow-400')} />
                            <span className="font-mono font-semibold">{fmtDate(d.date)}</span>
                          </div>
                          <div className="flex items-center gap-3 text-right">
                            <div className="text-muted-foreground text-[10px]">
                              <span>Plan {fmtCHF(d.planWork)}</span>
                              <span className="mx-1">·</span>
                              <span>Ist {fmtCHF(d.istWork)}</span>
                            </div>
                            <span className={cn('font-mono font-bold whitespace-nowrap',
                              sev === 'red'   ? 'text-red-600 dark:text-red-400'
                              : sev === 'amber' ? 'text-amber-600 dark:text-amber-400'
                                              : 'text-yellow-700 dark:text-yellow-400')}>
                              +{fmtCHF(d.diff)}
                            </span>
                            {d.diffPct != null && (
                              <span className="text-muted-foreground text-[10px] w-14 text-right">
                                +{d.diffPct.toFixed(1)} %
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Top Kostentreiber */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  Top Kostentreiber
                </CardTitle>
                <p className="text-[10px] text-muted-foreground/70">
                  Flex-Mitarbeiter mit höchster Ist-Abweichung vs. Plan (Arbeit).
                </p>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {topDrivers.length === 0 ? (
                  <div className="py-6 text-center">
                    <CheckCircle className="h-7 w-7 text-emerald-500 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground">Alle Mitarbeiter liegen im Plan.</p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {topDrivers.map((e, i) => {
                      const diffH    = e.istH - e.planH;
                      const deptLabel = e.dept === 'service' ? 'Service' : e.dept === 'küche' ? 'Küche' : e.dept;
                      return (
                        <div key={e.id} className="flex items-center gap-3 rounded-lg border border-border bg-background/60 px-3 py-2 text-xs">
                          <div className={cn(
                            'h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0',
                            i === 0 ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                            : i === 1 ? 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300'
                                      : 'bg-muted text-muted-foreground',
                          )}>
                            {i + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold truncate">{e.name}</p>
                            <p className="text-muted-foreground text-[10px]">{deptLabel} · {fmtCHFDec(e.hourlyWage)}/h</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-mono font-bold text-red-600 dark:text-red-400">+{fmtCHF(e.diffWork)}</p>
                            {diffH > 0.05 && (
                              <p className="text-[10px] text-muted-foreground">+{diffH.toFixed(1)} h</p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Row 3: Service vs. Küche + Stundenoptimierung ───────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

            {/* Abteilungsvergleich */}
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
                {deptRows.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic py-4 text-center">
                    Keine Abteilungsdaten verfügbar.
                  </p>
                ) : (
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
                          {/* Progress bar */}
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
                )}
              </CardContent>
            </Card>

            {/* Stundenoptimierung */}
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Zap className="h-4 w-4 text-muted-foreground" />
                  Stundenoptimierung
                </CardTitle>
                <p className="text-[10px] text-muted-foreground/70">
                  Notwendige Reduktion oder vorhandener Spielraum.
                </p>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                {personnelBudget === 0 ? (
                  <p className="text-xs text-muted-foreground italic py-4 text-center">Kein Budget hinterlegt.</p>
                ) : avgHourlyWage === 0 ? (
                  <p className="text-xs text-muted-foreground italic py-4 text-center">Kein Ø-Stundenlohn berechnet.</p>
                ) : (
                  <>
                    <div className="rounded-lg bg-muted/40 border border-border px-3 py-2.5 space-y-1.5 text-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Ø Flex-Stundenlohn</span>
                        <span className="font-mono font-semibold">{fmtCHFDec(avgHourlyWage)}/h</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Budgetabweichung (Forecast)</span>
                        <span className={cn('font-mono font-semibold',
                          forecastDelta >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                          {forecastDelta >= 0 ? '−' : '+'}{fmtCHF(Math.abs(forecastDelta))}
                        </span>
                      </div>
                    </div>
                    <div className={cn(
                      'rounded-lg border px-4 py-4 text-center',
                      forecastDelta >= 0
                        ? 'bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800'
                        : 'bg-red-50/60 dark:bg-red-950/20 border-red-200 dark:border-red-800',
                    )}>
                      <p className={cn('text-3xl font-bold font-mono',
                        forecastDelta >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>
                        {forecastDelta >= 0 ? `+${hoursHeadroom}` : `−${hoursSaved}`} h
                      </p>
                      <p className={cn('text-xs mt-1.5',
                        forecastDelta >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400')}>
                        {forecastDelta >= 0
                          ? `Spielraum — noch ca. ${hoursHeadroom} Flex-Stunden planbar`
                          : `Reduktion nötig — ca. ${hoursSaved} Flex-Stunden zu viel`}
                      </p>
                    </div>
                    <p className="text-[10px] text-muted-foreground text-center">
                      Formel: Budgetabweichung ÷ Ø Stundenlohn ({fmtCHFDec(avgHourlyWage)}/h)
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Row 4: Handlungsempfehlungen (full width) ───────────────── */}
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Lightbulb className="h-4 w-4 text-amber-500" />
                Empfohlene Massnahmen
              </CardTitle>
              <p className="text-[10px] text-muted-foreground/70">
                Regelbasierte Handlungsempfehlungen aus aktuellen Personaldaten.
              </p>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <ul className="space-y-2">
                {recommendations.map((r, i) => (
                  <li key={i} className={cn(
                    'flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-sm border',
                    r.severity === 'red'    ? 'bg-red-50/60 dark:bg-red-950/20 border-red-200 dark:border-red-800'
                    : r.severity === 'amber'  ? 'bg-amber-50/60 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800'
                    : r.severity === 'green'  ? 'bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800'
                                              : 'bg-muted/30 border-border',
                  )}>
                    <span className="text-base shrink-0 mt-0.5 leading-none">{r.icon}</span>
                    <span className={cn(
                      r.severity === 'red'   ? 'text-red-800 dark:text-red-200'
                      : r.severity === 'amber' ? 'text-amber-800 dark:text-amber-200'
                      : r.severity === 'green' ? 'text-emerald-800 dark:text-emerald-200'
                                              : 'text-foreground',
                    )}>
                      {r.text}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {/* ── Optional: Monats-Heatmap ─────────────────────────────────── */}
          {abwDays.length > 0 && (
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Target className="h-4 w-4 text-muted-foreground" />
                  Monatstatus — Tagesübersicht
                </CardTitle>
                <p className="text-[10px] text-muted-foreground/70">
                  Grün = im Plan · Gelb = leicht über Plan · Orange = über Plan · Rot = stark über Plan · Grau = keine Daten
                </p>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="flex flex-wrap gap-1.5">
                  {Array.from({ length: daysInSelectedMonth }, (_, i) => {
                    const day     = i + 1;
                    const dateStr = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const entry   = abwDays.find(d => d.date === dateStr);
                    const diff    = entry?.diff ?? 0;
                    const pct     = entry?.diffPct ?? 0;
                    const hasData = !!entry;
                    const tile    = !hasData
                      ? 'bg-muted/40 text-muted-foreground'
                      : pct > 20 ? 'bg-red-500 text-white'
                      : pct > 8  ? 'bg-amber-500 text-white'
                      : diff > 0.01 ? 'bg-yellow-400 text-yellow-900 dark:text-white dark:bg-yellow-600'
                                   : 'bg-emerald-500 text-white';
                    return (
                      <div
                        key={day}
                        className={cn(
                          'h-9 w-9 rounded-md flex items-center justify-center text-[11px] font-bold cursor-default transition-transform hover:scale-110 hover:z-10 relative',
                          tile,
                        )}
                        title={hasData
                          ? `${fmtDate(dateStr)}: Plan ${fmtCHF(entry!.planWork)} · Ist ${fmtCHF(entry!.istWork)} · Diff ${diff > 0.01 ? '+' : ''}${fmtCHF(diff)}`
                          : `${day}. — keine Daten`}
                      >
                        {day}
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-4 mt-3 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-500 inline-block" />Im Plan</span>
                  <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-yellow-400 inline-block" />Leicht über</span>
                  <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-500 inline-block" />Über Plan</span>
                  <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-red-500 inline-block" />Stark über</span>
                  <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-muted/40 inline-block border border-border" />Keine Daten</span>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </section>
  );
}
