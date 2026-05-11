/**
 * Forecast & Planung nächste Woche
 * ==================================
 * Zeigt die geplanten Personalkosten, Stunden und die forecast PKQ
 * für die kommende Kalenderwoche.
 *
 * Datenquellen:
 *   - Supabase: schedule_entries (Dienstplan) + employees
 *   - localStorage: dailyBudgets (plannedRevenue, actualRevenue)
 *   - zielwerte-store: Zielquote (targetPercent)
 *
 * Sektion ist eigenständig — bestehende Reporting-Seiten unverändert.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  format, addWeeks, subWeeks,
  startOfWeek, endOfWeek, eachDayOfInterval,
  getISOWeek, getDay,
} from 'date-fns';
import { de } from 'date-fns/locale';
import {
  ChevronLeft, ChevronRight, TrendingUp, Target, Clock,
  DollarSign, AlertTriangle, CheckCircle2, Zap,
  Users, ChefHat, Utensils, Calendar,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, Cell,
} from 'recharts';

import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { loadEmployees, loadScheduleForMonth, DaySchedule } from '@/lib/supabase-db';
import { Employee } from '@/types/personnel';
import { resolveZielwert } from '@/lib/zielwerte-store';

// ─── Typen ───────────────────────────────────────────────────────────────────

type TrafficLight = 'green' | 'orange' | 'red' | 'none';

interface DayBudget {
  plannedRevenue?: number;
  actualRevenue?: number;
}

interface DayForecast {
  date: Date;
  dateStr: string;
  planHours: number;
  planHoursService: number;
  planHoursKüche: number;
  planCost: number;
  planCostService: number;
  planCostKüche: number;
  planRevenue: number | null;   // from dailyBudgets or historical avg
  planPKQ: number | null;       // planCost / planRevenue * 100
  revenueSource: 'budget' | 'historical' | 'none';
  status: TrafficLight;
}

// ─── Formatierungsfunktionen ──────────────────────────────────────────────────

function fmtCHF(v: number): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 0,
  }).format(v);
}
function fmtCHFShort(v: number): string {
  if (Math.abs(v) >= 10000) return (v / 1000).toFixed(0) + 'k';
  if (Math.abs(v) >= 1000)  return (v / 1000).toFixed(1) + 'k';
  return Math.round(v).toString();
}
function fmtH(v: number): string   { return `${v.toFixed(1)} h`; }
function fmtPct(v: number): string { return `${v.toFixed(1)} %`; }
function sign(v: number): string   { return v >= 0 ? '+' : ''; }

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function parseHours(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h + m / 60;
}
function shiftDuration(s: string, e: string): number {
  let d = parseHours(e) - parseHours(s);
  if (d < 0) d += 24;
  return Math.max(0, d);
}
function calcDayPlanHours(ds: DaySchedule): number {
  let total = 0;
  if (ds.früh && !ds.frühAbsence) total += shiftDuration(ds.früh.start, ds.früh.end);
  if (ds.spät && !ds.spätAbsence) total += shiftDuration(ds.spät.start, ds.spät.end);
  // break deduction
  const brk = total >= 7 ? 1 : total >= 5 ? 0.5 : 0;
  return Math.max(0, total - brk);
}

function trafficLight(pkq: number | null, target: number): TrafficLight {
  if (pkq === null) return 'none';
  if (pkq <= target)     return 'green';
  if (pkq <= target + 5) return 'orange';
  return 'red';
}

function statusStyle(t: TrafficLight) {
  if (t === 'green')  return 'bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300';
  if (t === 'orange') return 'bg-yellow-50 dark:bg-yellow-950/20 border-yellow-200 dark:border-yellow-800 text-yellow-700 dark:text-yellow-300';
  if (t === 'red')    return 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300';
  return 'bg-muted/30 border-border text-muted-foreground';
}

function statusLabel(t: TrafficLight) {
  if (t === 'green')  return 'Im Ziel';
  if (t === 'orange') return 'Grenzwertig';
  if (t === 'red')    return 'Zu hoch';
  return 'Kein Budget';
}

function barColor(t: TrafficLight): string {
  if (t === 'green')  return '#22c55e';
  if (t === 'orange') return '#f59e0b';
  if (t === 'red')    return '#ef4444';
  return '#94a3b8';
}

/** Compute historical average revenue for a weekday (0=Sun…6=Sat) from past 8 weeks */
function historicalAvg(
  date: Date,
  dailyBudgets: Record<string, DayBudget>,
  today: Date,
): number | null {
  const results: number[] = [];
  for (let w = 1; w <= 8; w++) {
    const past = new Date(date);
    past.setDate(date.getDate() - w * 7);
    if (past >= today) continue;
    const key = format(past, 'yyyy-MM-dd');
    const rev = dailyBudgets[key]?.actualRevenue;
    if (rev && rev > 0) results.push(rev);
  }
  if (results.length < 2) return null;
  return results.reduce((a, b) => a + b, 0) / results.length;
}

// ─── Sub-Komponenten ─────────────────────────────────────────────────────────

interface KPICardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  status?: TrafficLight;
  large?: boolean;
}

const KPICard = ({ label, value, sub, icon, status = 'none', large }: KPICardProps) => {
  const textCol =
    status === 'green'  ? 'text-green-700 dark:text-green-300' :
    status === 'orange' ? 'text-yellow-700 dark:text-yellow-300' :
    status === 'red'    ? 'text-red-700 dark:text-red-300' :
    'text-foreground';
  const borderCol =
    status === 'green'  ? 'border-l-green-400' :
    status === 'orange' ? 'border-l-yellow-400' :
    status === 'red'    ? 'border-l-red-400' :
    'border-l-border';

  return (
    <Card className={cn('border border-border border-l-4', borderCol)}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
          <span className="text-muted-foreground">{icon}</span>
        </div>
        <p className={cn('font-bold tabular-nums leading-tight', large ? 'text-2xl' : 'text-xl', textCol)}>
          {value}
        </p>
        {sub && <p className="text-[11px] text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
};

// Compact day card
interface DayCardProps {
  day: DayForecast;
  target: number;
}

const DayCard = ({ day, target }: DayCardProps) => {
  const dayName   = format(day.date, 'EEEE', { locale: de });
  const dateLabel = format(day.date, 'd. MMMM', { locale: de });
  const isToday   = format(day.date, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
  const diffPct   = day.planPKQ !== null ? day.planPKQ - target : null;

  return (
    <Card className={cn(
      'border transition-shadow hover:shadow-sm',
      isToday ? 'border-primary/50 shadow-sm' : 'border-border',
    )}>
      <CardContent className="p-3.5">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-sm font-bold">{dayName}</p>
            <p className="text-[11px] text-muted-foreground">{dateLabel}</p>
          </div>
          <span className={cn('text-[10px] font-bold px-2 py-1 rounded-full border', statusStyle(day.status))}>
            {statusLabel(day.status)}
          </span>
        </div>

        {/* KPI rows */}
        <div className="space-y-1.5">
          {day.planRevenue !== null && (
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Budget Umsatz</span>
              <span className="font-semibold tabular-nums">
                {fmtCHF(day.planRevenue)}
                {day.revenueSource === 'historical' && (
                  <span className="text-muted-foreground font-normal ml-1">~</span>
                )}
              </span>
            </div>
          )}
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Geplante Kosten</span>
            <span className="font-bold tabular-nums">{fmtCHF(day.planCost)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Geplante Stunden</span>
            <span className="font-semibold tabular-nums">{fmtH(day.planHours)}</span>
          </div>
          {day.planPKQ !== null && (
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Forecast PKQ</span>
              <span className={cn('font-bold tabular-nums',
                day.status === 'green'  ? 'text-green-600 dark:text-green-400' :
                day.status === 'orange' ? 'text-yellow-600 dark:text-yellow-400' :
                day.status === 'red'    ? 'text-red-600 dark:text-red-400' : '',
              )}>
                {fmtPct(day.planPKQ)}
              </span>
            </div>
          )}
        </div>

        {/* Diff vs target */}
        {diffPct !== null && (
          <div className={cn(
            'mt-3 px-2.5 py-1.5 rounded text-[11px] font-semibold text-center border',
            diffPct > 5 ? 'bg-red-50 dark:bg-red-950/20 border-red-200 text-red-700 dark:text-red-300' :
            diffPct > 0 ? 'bg-yellow-50 dark:bg-yellow-950/20 border-yellow-200 text-yellow-700 dark:text-yellow-300' :
            'bg-green-50 dark:bg-green-950/20 border-green-200 text-green-700 dark:text-green-300',
          )}>
            {sign(diffPct)}{diffPct.toFixed(1)} % {diffPct > 0 ? 'über' : 'unter'} Ziel
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// Optimization hint card
interface HintProps {
  level: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
}

const OptHint = ({ level, title, detail }: HintProps) => {
  const styles = {
    info:     { bg: 'bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800', text: 'text-blue-700 dark:text-blue-300', Icon: CheckCircle2 },
    warning:  { bg: 'bg-yellow-50 dark:bg-yellow-950/20 border-yellow-200 dark:border-yellow-800', text: 'text-yellow-700 dark:text-yellow-300', Icon: AlertTriangle },
    critical: { bg: 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800', text: 'text-red-700 dark:text-red-300', Icon: AlertTriangle },
  }[level];
  const { Icon } = styles;

  return (
    <div className={cn('flex gap-3 p-3 rounded-md border', styles.bg)}>
      <Icon className={cn('h-4 w-4 flex-shrink-0 mt-0.5', styles.text)} />
      <div>
        <p className={cn('text-xs font-bold', styles.text)}>{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>
      </div>
    </div>
  );
};

// ─── Hauptseite ───────────────────────────────────────────────────────────────

const ForecastPlanung = () => {
  const today = new Date();
  const { tenantId, tenantKey } = useTenant();
  const { isAdmin, allowedDepartment, canSeePersonnelCostTotals } = usePermissions();

  // ── Woche navigieren (default: nächste Woche) ──────────────────────────────
  const [weekOffset, setWeekOffset] = useState(1); // 1 = next week
  const weekBase  = addWeeks(today, weekOffset);
  const weekStart = startOfWeek(weekBase, { weekStartsOn: 1 });
  const weekEnd   = endOfWeek(weekBase,   { weekStartsOn: 1 });
  const kw        = getISOWeek(weekStart);
  const kwLabel   = `KW ${kw} · ${format(weekStart, 'd.M.', { locale: de })} – ${format(weekEnd, 'd.M.yyyy', { locale: de })}`;
  const days      = eachDayOfInterval({ start: weekStart, end: weekEnd });

  // ── Daten laden ─────────────────────────────────────────────────────────────
  const [employees,    setEmployees]    = useState<Employee[]>([]);
  const [scheduleData, setScheduleData] = useState<Record<string, DaySchedule>>({});
  const [loading,      setLoading]      = useState(true);

  // dailyBudgets aus localStorage (immer tenant-korrekt)
  const dailyBudgets = useMemo<Record<string, DayBudget>>(() => {
    try { return JSON.parse(localStorage.getItem(tenantKey('dailyBudgets')) || '{}'); }
    catch { return {}; }
  }, [tenantKey, weekOffset]);

  // Target-PKQ (resolveZielwert)
  const target = useMemo(() => {
    const { targetPercent } = resolveZielwert(weekStart.getFullYear(), weekStart.getMonth() + 1);
    return targetPercent;
  }, [weekStart]);

  // Schedule laden (beide Monate wenn Woche übergreift)
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const months = [weekStart];
      // wenn Woche in zwei Monate fällt, auch zweiten Monat laden
      if (weekStart.getMonth() !== weekEnd.getMonth()) months.push(weekEnd);

      const [emps, ...scheds] = await Promise.all([
        loadEmployees(tenantId === 'beaulieu' ? 'beaulieu' : 'oliv'),
        ...months.map(m => loadScheduleForMonth(m)),
      ]);
      if (cancelled) return;
      if (emps) setEmployees(emps);
      // merge schedule data from both months if needed
      const merged: Record<string, DaySchedule> = {};
      scheds.forEach(s => { if (s) Object.assign(merged, s); });
      setScheduleData(merged);
      setLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, [tenantId, weekStart.toISOString()]);

  // ── Forecast pro Tag berechnen ────────────────────────────────────────────
  const forecasts = useMemo<DayForecast[]>(() => {
    const dept = isAdmin ? 'all' : allowedDepartment;
    return days.map(date => {
      const dateStr = format(date, 'yyyy-MM-dd');
      const relevantEmps = employees.filter(e =>
        dept === 'all' || e.department === dept
      );

      let planH = 0, planC = 0, planHS = 0, planHK = 0, planCS = 0, planCK = 0;
      relevantEmps.forEach(emp => {
        const key = `${emp.id}-${dateStr}`;
        const ds  = scheduleData[key];
        if (!ds) return;
        const h = calcDayPlanHours(ds);
        const w = emp.hourlyWage ?? 0;
        planH += h; planC += h * w;
        if (emp.department === 'service') { planHS += h; planCS += h * w; }
        else                              { planHK += h; planCK += h * w; }
      });

      // Planned revenue: prefer explicit budget, then historical avg
      const budgetRev = dailyBudgets[dateStr]?.plannedRevenue;
      const histRev   = historicalAvg(date, dailyBudgets, today);

      let planRevenue: number | null = null;
      let revenueSource: DayForecast['revenueSource'] = 'none';

      if (budgetRev && budgetRev > 0) {
        planRevenue  = budgetRev;
        revenueSource = 'budget';
      } else if (histRev !== null) {
        planRevenue  = histRev;
        revenueSource = 'historical';
      }

      const planPKQ = planRevenue !== null && planRevenue > 0
        ? (planC / planRevenue) * 100
        : null;

      return {
        date, dateStr,
        planHours: planH, planHoursService: planHS, planHoursKüche: planHK,
        planCost: planC,  planCostService: planCS,  planCostKüche: planCK,
        planRevenue, planPKQ, revenueSource,
        status: trafficLight(planPKQ, target),
      };
    });
  }, [employees, scheduleData, dailyBudgets, target, isAdmin, allowedDepartment, days]);

  // ── Wochen-Summenwerte ────────────────────────────────────────────────────
  const weekTotals = useMemo(() => {
    const totH  = forecasts.reduce((s,d) => s + d.planHours, 0);
    const totC  = forecasts.reduce((s,d) => s + d.planCost,  0);
    const totHs = forecasts.reduce((s,d) => s + d.planHoursService, 0);
    const totHk = forecasts.reduce((s,d) => s + d.planHoursKüche, 0);
    const totCs = forecasts.reduce((s,d) => s + d.planCostService, 0);
    const totCk = forecasts.reduce((s,d) => s + d.planCostKüche,  0);
    const hasBudget = forecasts.some(d => d.planRevenue !== null);
    const totRev = hasBudget
      ? forecasts.reduce((s,d) => s + (d.planRevenue ?? 0), 0)
      : null;
    const forecastPKQ = totRev && totRev > 0 ? (totC / totRev) * 100 : null;
    const pkqDiff     = forecastPKQ !== null ? forecastPKQ - target : null;
    const riskCHF     = forecastPKQ !== null && totRev
      ? (forecastPKQ - target) / 100 * totRev : null;
    return {
      totH, totC, totHs, totHk, totCs, totCk,
      totRev, forecastPKQ, pkqDiff, riskCHF,
      hasBudget,
      weekStatus: trafficLight(forecastPKQ, target),
    };
  }, [forecasts, target]);

  // ── Recharts data ──────────────────────────────────────────────────────────
  const chartData = forecasts.map(d => ({
    day:     format(d.date, 'EEE', { locale: de }).slice(0, 2),
    date:    format(d.date, 'd.M.'),
    pkq:     d.planPKQ !== null ? +d.planPKQ.toFixed(1) : null,
    revenue: d.planRevenue !== null ? Math.round(d.planRevenue) : null,
    cost:    Math.round(d.planCost),
    status:  d.status,
  }));

  // ── Optimierungshinweise generieren ───────────────────────────────────────
  const hints = useMemo<HintProps[]>(() => {
    const list: HintProps[] = [];

    // Week total forecast
    if (weekTotals.forecastPKQ !== null) {
      if (weekTotals.forecastPKQ <= target) {
        list.push({
          level: 'info',
          title: `Woche im Ziel — Forecast PKQ ${fmtPct(weekTotals.forecastPKQ)}`,
          detail: `Geplante Kosten ${fmtCHF(weekTotals.totC)} bei Budget ${weekTotals.totRev ? fmtCHF(weekTotals.totRev) : '–'}.`,
        });
      } else {
        const risk = weekTotals.riskCHF ?? 0;
        list.push({
          level: risk > 1000 ? 'critical' : 'warning',
          title: `Forecast PKQ ${fmtPct(weekTotals.forecastPKQ)} — ${sign(weekTotals.pkqDiff!)}${fmtPct(weekTotals.pkqDiff!)} über Ziel`,
          detail: `Entspricht einem Risiko von ca. ${fmtCHF(Math.abs(risk))}. Besetzung kritisch prüfen.`,
        });
      }
    }

    // Per-day critical
    forecasts.forEach(d => {
      const dayName = format(d.date, 'EEEE', { locale: de });
      if (d.planPKQ !== null && d.planPKQ > target + 5) {
        const over = d.planPKQ - target;
        list.push({
          level: 'warning',
          title: `${dayName}: Forecast PKQ ${fmtPct(d.planPKQ)} — ${sign(over)}${fmtPct(over)} über Ziel`,
          detail: `Geplante Kosten ${fmtCHF(d.planCost)} bei Budget ${d.planRevenue ? fmtCHF(d.planRevenue) : '–'}${d.revenueSource === 'historical' ? ' (Histor. Schnitt)' : ''}. 1–2 Mitarbeiter prüfen.`,
        });
      }
      if (d.planRevenue === null && d.planCost > 500) {
        list.push({
          level: 'info',
          title: `${dayName}: Kein Budget hinterlegt`,
          detail: `Geplante Kosten ${fmtCHF(d.planCost)}. Budget in Tages-Controlling erfassen, um PKQ zu berechnen.`,
        });
      }
    });

    // Dept-level
    if (isAdmin && weekTotals.totCk > weekTotals.totCs * 1.5 && weekTotals.totCk > 2000) {
      list.push({
        level: 'info',
        title: `Küche hat ${fmtPct((weekTotals.totCk / Math.max(weekTotals.totC, 1)) * 100)} der Personalkosten`,
        detail: `Küche ${fmtCHF(weekTotals.totCk)} vs Service ${fmtCHF(weekTotals.totCs)}. Früh-/Spätschichten Küche prüfen.`,
      });
    }

    // Days with high planned hours on low revenue
    forecasts.forEach(d => {
      if (d.planRevenue !== null && d.planRevenue < 3000 && d.planHours > 15) {
        const dayName = format(d.date, 'EEEE', { locale: de });
        list.push({
          level: 'warning',
          title: `${dayName}: Tiefer Umsatz bei hoher Besetzung`,
          detail: `Budget ${fmtCHF(d.planRevenue)} bei ${fmtH(d.planHours)} geplanten Stunden — Minimalbesetzung erwägen.`,
        });
      }
    });

    return list.slice(0, 8); // max 8 hints
  }, [forecasts, weekTotals, target, isAdmin]);

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  const { weekStatus, forecastPKQ, totC, totRev, totH, pkqDiff, riskCHF } = weekTotals;

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1400px] mx-auto">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 bg-primary/10 text-primary px-2.5 py-1 rounded-md">
            <Calendar className="h-4 w-4" />
            <span className="text-sm font-bold">Forecast</span>
          </div>
          <div>
            <h1 className="text-xl font-bold leading-tight">Planung nächste Woche</h1>
            <p className="text-sm text-muted-foreground">{kwLabel}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline" size="sm"
            onClick={() => setWeekOffset(w => w - 1)}
            className="h-8 w-8 p-0"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-semibold text-muted-foreground min-w-[48px] text-center">
            {weekOffset === 1 ? 'Nächste' : weekOffset === 0 ? 'Diese' : weekOffset > 0 ? `+${weekOffset}W` : `${weekOffset}W`}
          </span>
          <Button
            variant="outline" size="sm"
            onClick={() => setWeekOffset(w => w + 1)}
            className="h-8 w-8 p-0"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline" size="sm"
            onClick={() => setWeekOffset(1)}
            className="h-8 text-xs px-3"
          >
            Nächste Woche
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground gap-3">
          <div className="h-5 w-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Dienstplan wird geladen…</span>
        </div>
      ) : (
        <>
          {/* ── Forecast KPI Summary ─────────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KPICard
              label="Forecast Umsatz"
              value={totRev !== null ? fmtCHF(totRev) : '–'}
              sub={totRev ? 'Budget-Umsatz Woche' : 'Kein Budget erfasst'}
              icon={<DollarSign className="h-4 w-4" />}
              large
            />
            <KPICard
              label="Geplante Personalkosten"
              value={canSeePersonnelCostTotals ? fmtCHF(totC) : '–'}
              sub={fmtH(totH) + ' geplant'}
              icon={<Users className="h-4 w-4" />}
              large
            />
            <KPICard
              label="Forecast PKQ"
              value={forecastPKQ !== null ? fmtPct(forecastPKQ) : '–'}
              sub={forecastPKQ !== null ? `Ziel: ${fmtPct(target)}` : 'Budget erfassen für Berechnung'}
              icon={<Target className="h-4 w-4" />}
              status={weekStatus}
              large
            />
            <Card className={cn('border border-l-4',
              weekStatus === 'green'  ? 'border-l-green-400' :
              weekStatus === 'orange' ? 'border-l-yellow-400' :
              weekStatus === 'red'    ? 'border-l-red-400' :
              'border-l-border',
            )}>
              <CardContent className="p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Status & Risiko</p>
                <div className={cn('inline-flex items-center gap-1.5 text-sm font-bold px-2.5 py-1.5 rounded-md border mb-2',
                  statusStyle(weekStatus)
                )}>
                  {weekStatus === 'green' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  {statusLabel(weekStatus)}
                </div>
                {pkqDiff !== null && (
                  <p className={cn('text-xs font-semibold',
                    weekStatus === 'red' ? 'text-red-600 dark:text-red-400' :
                    weekStatus === 'orange' ? 'text-yellow-600 dark:text-yellow-400' :
                    'text-green-600 dark:text-green-400',
                  )}>
                    {sign(pkqDiff)}{fmtPct(pkqDiff)} vs. Ziel
                    {riskCHF !== null && Math.abs(riskCHF) > 100 && (
                      <span className="text-muted-foreground font-normal ml-1">
                        ({sign(riskCHF)}{fmtCHFShort(riskCHF)})
                      </span>
                    )}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Diagramme ────────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">

            {/* Chart A: Forecast PKQ pro Tag */}
            <Card className="border border-border">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-4">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  <p className="text-sm font-bold">Forecast Personalquote pro Tag</p>
                  <Badge variant="outline" className="ml-auto text-[10px]">
                    Ziel: {fmtPct(target)}
                  </Badge>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartData} margin={{ top: 18, right: 28, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 11, fontWeight: 600 }}
                      axisLine={false} tickLine={false}
                    />
                    <YAxis
                      domain={[0, Math.max((Math.ceil(target * 2.5 / 10) * 10), 60)]}
                      unit="%"
                      tick={{ fontSize: 10 }}
                      axisLine={false} tickLine={false}
                      width={36}
                    />
                    <Tooltip
                      formatter={(v: number | null) => v != null ? [fmtPct(v), 'Forecast PKQ'] : ['–', 'Forecast PKQ']}
                      labelFormatter={(_, p) => p[0]?.payload?.date ?? ''}
                    />
                    <ReferenceLine
                      y={target}
                      stroke="#6366f1"
                      strokeWidth={2}
                      strokeDasharray="6 3"
                      label={{ value: `Ziel ${target}%`, position: 'right', fontSize: 10, fill: '#6366f1', fontWeight: 700 }}
                    />
                    <Bar dataKey="pkq" radius={[3, 3, 0, 0]} label={{ position: 'top', fontSize: 10, fontWeight: 700, formatter: (v: number | null) => v != null ? v.toFixed(0) + '%' : '' }}>
                      {chartData.map((entry, i) => (
                        <Cell key={i} fill={barColor(entry.status)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Chart B: Umsatz vs Kosten pro Tag */}
            <Card className="border border-border">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <DollarSign className="h-4 w-4 text-primary" />
                  <p className="text-sm font-bold">Umsatz vs. Personalkosten pro Tag</p>
                </div>
                <div className="flex items-center gap-4 mb-3">
                  <div className="flex items-center gap-1.5">
                    <div className="h-2.5 w-5 rounded-sm bg-blue-400" />
                    <span className="text-[10px] text-muted-foreground">Budget Umsatz</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="h-2.5 w-5 rounded-sm bg-slate-400" />
                    <span className="text-[10px] text-muted-foreground">Personalkosten</span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartData} margin={{ top: 18, right: 10, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 11, fontWeight: 600 }}
                      axisLine={false} tickLine={false}
                    />
                    <YAxis
                      tickFormatter={v => v >= 1000 ? (v/1000).toFixed(0)+'k' : v}
                      tick={{ fontSize: 10 }}
                      axisLine={false} tickLine={false}
                      width={36}
                    />
                    <Tooltip
                      formatter={(v: number, name: string) => [fmtCHF(v), name === 'revenue' ? 'Budget Umsatz' : 'Personalkosten']}
                      labelFormatter={(_, p) => p[0]?.payload?.date ?? ''}
                    />
                    <Bar dataKey="revenue" fill="#60a5fa" radius={[3, 3, 0, 0]} label={{ position: 'top', fontSize: 9, formatter: (v: number | null) => v ? fmtCHFShort(v) : '' }} />
                    <Bar dataKey="cost"    fill="#94a3b8" radius={[3, 3, 0, 0]} label={{ position: 'top', fontSize: 9, formatter: (v: number) => fmtCHFShort(v) }} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          {/* ── 7 Tageskarten ─────────────────────────────────────────────────── */}
          <div>
            <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Tagesdetail
              {weekTotals.hasBudget && (
                <span className="text-[10px] font-normal normal-case tracking-normal text-muted-foreground ml-2">
                  ~ = Historischer Durchschnitt (kein Budget hinterlegt)
                </span>
              )}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
              {forecasts.map(d => (
                <DayCard key={d.dateStr} day={d} target={target} />
              ))}
            </div>
          </div>

          {/* ── Service vs Küche ──────────────────────────────────────────────── */}
          {isAdmin && (
            <div>
              <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                <Users className="h-4 w-4" />
                Service vs. Küche — Woche
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Card className="border border-border border-l-4 border-l-blue-400">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Utensils className="h-4 w-4 text-blue-500" />
                      <p className="font-semibold text-sm">Service</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Stunden</p>
                        <p className="text-lg font-bold tabular-nums">{fmtH(weekTotals.totHs)}</p>
                      </div>
                      {canSeePersonnelCostTotals && (
                        <div>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Kosten</p>
                          <p className="text-lg font-bold tabular-nums">{fmtCHF(weekTotals.totCs)}</p>
                        </div>
                      )}
                    </div>
                    {canSeePersonnelCostTotals && weekTotals.totC > 0 && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Anteil: {fmtPct((weekTotals.totCs / weekTotals.totC) * 100)} der Gesamtkosten
                      </p>
                    )}
                  </CardContent>
                </Card>

                <Card className="border border-border border-l-4 border-l-orange-400">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <ChefHat className="h-4 w-4 text-orange-500" />
                      <p className="font-semibold text-sm">Küche</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Stunden</p>
                        <p className="text-lg font-bold tabular-nums">{fmtH(weekTotals.totHk)}</p>
                      </div>
                      {canSeePersonnelCostTotals && (
                        <div>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Kosten</p>
                          <p className="text-lg font-bold tabular-nums">{fmtCHF(weekTotals.totCk)}</p>
                        </div>
                      )}
                    </div>
                    {canSeePersonnelCostTotals && weekTotals.totC > 0 && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Anteil: {fmtPct((weekTotals.totCk / weekTotals.totC) * 100)} der Gesamtkosten
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* ── Optimierungshinweise ──────────────────────────────────────────── */}
          <div>
            <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Automatische Optimierungshinweise
            </h2>
            {hints.length === 0 ? (
              <div className="bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 rounded-md p-4 flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0" />
                <p className="text-sm font-medium text-green-700 dark:text-green-300">
                  Alles im grünen Bereich — aktuelle Planung liegt im Ziel.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {hints.map((hint, i) => (
                  <OptHint key={i} {...hint} />
                ))}
              </div>
            )}
          </div>

          {/* ── Datenquellen-Info ─────────────────────────────────────────────── */}
          <p className="text-[11px] text-muted-foreground/60 text-center pb-2">
            Dienstplan-Daten aus Supabase · Budgetumsatz aus Tages-Controlling
            {forecasts.some(d => d.revenueSource === 'historical') && ' · ~ Historischer Wochentag-Durchschnitt (letzten 8 Wochen)'}
          </p>
        </>
      )}
    </div>
  );
};

export default ForecastPlanung;
