/**
 * Soll / Ist Analyse
 * ==================
 * Vergleich von Planung vs. Realität für Stunden, Personalkosten,
 * Umsatz und Kostenquote.
 *
 * Filter: Tag / Kalenderwoche / Monat × Abteilung
 * Rollen:
 *   admin           → alle Abteilungen + vollständige Finanzdaten
 *   service_manager → nur Service, keine Einzellöhne
 *   kueche_manager  → nur Küche, keine Einzellöhne
 */

import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  format, addDays, subDays, addWeeks, subWeeks, addMonths, subMonths,
  startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval,
  getISOWeek,
} from 'date-fns';
import { de } from 'date-fns/locale';
import {
  ChevronLeft, ChevronRight, LayoutDashboard, Calendar,
  Clock, Users, TrendingUp, Target, ChefHat, Utensils,
  ArrowUp, ArrowDown, Minus, BookOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { usePermissions } from '@/hooks/usePermissions';
import { useBudgetMonth } from '@/hooks/useBudgetMonth';
import {
  loadEmployees,
  loadScheduleForMonth,
  loadActualHoursForMonth,
  DaySchedule,
  ActualHourEntry,
} from '@/lib/supabase-db';
import { Employee } from '@/types/personnel';

// ─── Typen ───────────────────────────────────────────────────────────────────

type Period = 'tag' | 'woche' | 'monat';
type Dept   = 'service' | 'küche' | 'all';

interface DailyBudget {
  plannedRevenue: number;
  actualRevenue: number;
  previousYearRevenue: number;
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function parseHours(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h + m / 60;
}
function shiftDuration(start: string, end: string): number {
  const s = parseHours(start);
  let   e = parseHours(end);
  if (e < s) e += 24;
  return Math.max(0, e - s);
}
function calcDayHours(schedule: DaySchedule): number {
  let total = 0;
  if (schedule.früh && !schedule.frühAbsence)
    total += shiftDuration(schedule.früh.start, schedule.früh.end);
  if (schedule.spät && !schedule.spätAbsence)
    total += shiftDuration(schedule.spät.start, schedule.spät.end);
  return total;
}

function formatCHF(v: number): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 0,
  }).format(v);
}
function fmtHours(v: number): string { return `${v.toFixed(1)} h`; }
function fmtPct(v: number): string   { return `${v.toFixed(1)} %`; }

function pctVariance(plan: number, ist: number): number | null {
  if (plan === 0) return null;
  return ((ist - plan) / plan) * 100;
}

// ─── Vergleichskarte ─────────────────────────────────────────────────────────

interface ComparisonCardProps {
  title: string;
  icon?: React.ReactNode;
  plan: string;
  planLabel?: string;
  ist: string;
  istLabel?: string;
  varianceFmt: string;
  variancePct?: string | null;
  /** true=gut (Ist besser als Plan), false=schlecht, null=neutral */
  goodIfPositive?: boolean; // wenn true: positive Abweichung = grün
  goodIfNegative?: boolean; // wenn true: negative Abweichung = grün
  rawVariance?: number | null;
  noIst?: boolean;
  extra?: React.ReactNode;
}

const ComparisonCard = ({
  title, icon, plan, planLabel = 'Soll', ist, istLabel = 'Ist',
  varianceFmt, variancePct, goodIfPositive, goodIfNegative,
  rawVariance, noIst, extra,
}: ComparisonCardProps) => {
  const hasVariance = rawVariance !== null && rawVariance !== undefined && !noIst;
  const isPositive  = hasVariance && (rawVariance ?? 0) > 0;
  const isNegative  = hasVariance && (rawVariance ?? 0) < 0;
  const isNeutral   = !hasVariance || (rawVariance ?? 0) === 0;

  const varianceColor =
    isNeutral      ? 'text-muted-foreground' :
    goodIfPositive ? (isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400') :
    goodIfNegative ? (isNegative ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400') :
    'text-muted-foreground';

  const VarianceIcon = isNeutral ? Minus : isPositive ? ArrowUp : ArrowDown;

  return (
    <Card className="border border-border hover:shadow-sm transition-shadow">
      <CardContent className="p-4">
        {/* Titel */}
        <div className="flex items-center gap-2 mb-3">
          {icon && <span className="text-muted-foreground">{icon}</span>}
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
        </div>

        {/* Soll / Ist nebeneinander */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          {/* Soll */}
          <div className="rounded-md bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 p-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400 mb-0.5">
              {planLabel}
            </p>
            <p className="text-lg font-bold tabular-nums text-blue-700 dark:text-blue-300 leading-tight">
              {plan}
            </p>
          </div>

          {/* Ist */}
          <div className={cn(
            'rounded-md border p-2.5',
            noIst
              ? 'bg-muted/30 border-border'
              : 'bg-card border-border',
          )}>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">
              {istLabel}
            </p>
            <p className="text-lg font-bold tabular-nums leading-tight">
              {noIst ? <span className="text-muted-foreground text-base">–</span> : ist}
            </p>
          </div>
        </div>

        {/* Abweichung */}
        {!noIst && (
          <div className={cn(
            'flex items-center justify-between rounded-md px-3 py-1.5 text-sm font-semibold',
            isNeutral   ? 'bg-muted/40 text-muted-foreground' :
            varianceColor.includes('green') ? 'bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800' :
            varianceColor.includes('red')   ? 'bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800' :
            'bg-muted/40',
          )}>
            <span className={cn('flex items-center gap-1', varianceColor)}>
              <VarianceIcon className="h-3.5 w-3.5 flex-shrink-0" />
              Abweichung: {varianceFmt}
            </span>
            {variancePct && (
              <span className={cn('text-xs font-medium', varianceColor)}>
                {isPositive ? '+' : ''}{variancePct}
              </span>
            )}
          </div>
        )}

        {extra}
      </CardContent>
    </Card>
  );
};

// ─── Kostenquoten-Karte ───────────────────────────────────────────────────────

interface RatioCardProps {
  plannedRatio: number | null;
  actualRatio:  number | null;
  targetRatio:  number;
}

const RatioCard = ({ plannedRatio, actualRatio, targetRatio }: RatioCardProps) => {
  const ratioColor = (ratio: number | null) => {
    if (ratio === null) return 'text-muted-foreground';
    if (ratio <= targetRatio)     return 'text-green-600 dark:text-green-400';
    if (ratio <= targetRatio + 5) return 'text-yellow-600 dark:text-yellow-400';
    return 'text-red-600 dark:text-red-400';
  };

  const ratioStatus = (ratio: number | null) => {
    if (ratio === null) return { label: 'Keine Daten', bg: 'bg-muted/30 border-border text-muted-foreground' };
    if (ratio <= targetRatio)
      return { label: '✓ Im Ziel', bg: 'bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300' };
    if (ratio <= targetRatio + 5)
      return { label: '~ Grenzwertig', bg: 'bg-yellow-50 dark:bg-yellow-950/20 border-yellow-200 dark:border-yellow-800 text-yellow-700 dark:text-yellow-300' };
    return { label: '↑ Über Ziel', bg: 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300' };
  };

  const plannedStatus = ratioStatus(plannedRatio);
  const actualStatus  = ratioStatus(actualRatio);

  return (
    <Card className="border border-border hover:shadow-sm transition-shadow">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Target className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Personalkostenquote
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-3">
          {/* Soll-Quote */}
          <div className="rounded-md bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 p-2.5 text-center">
            <p className="text-[10px] font-bold uppercase tracking-wide text-blue-600 dark:text-blue-400 mb-0.5">Soll</p>
            <p className={cn('text-xl font-bold tabular-nums', ratioColor(plannedRatio))}>
              {plannedRatio !== null ? fmtPct(plannedRatio) : '–'}
            </p>
          </div>

          {/* Ist-Quote */}
          <div className="rounded-md border border-border p-2.5 text-center">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-0.5">Ist</p>
            <p className={cn('text-xl font-bold tabular-nums', ratioColor(actualRatio))}>
              {actualRatio !== null ? fmtPct(actualRatio) : '–'}
            </p>
          </div>

          {/* Ziel */}
          <div className="rounded-md bg-muted/30 border border-border p-2.5 text-center">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-0.5">Ziel</p>
            <p className="text-xl font-bold tabular-nums text-muted-foreground">
              {fmtPct(targetRatio)}
            </p>
          </div>
        </div>

        {/* Status-Badges */}
        <div className="grid grid-cols-2 gap-2">
          <div className={cn('text-center text-xs font-semibold px-2 py-1 rounded border', plannedStatus.bg)}>
            Soll: {plannedStatus.label}
          </div>
          <div className={cn('text-center text-xs font-semibold px-2 py-1 rounded border', actualStatus.bg)}>
            Ist: {actualStatus.label}
          </div>
        </div>

        {/* Abweichung vom Ziel */}
        {plannedRatio !== null && (
          <p className={cn(
            'text-xs mt-2 text-center font-medium',
            ratioColor(plannedRatio),
          )}>
            Soll-Abweichung vom Ziel: {(plannedRatio - targetRatio) >= 0 ? '+' : ''}{(plannedRatio - targetRatio).toFixed(1)} %
          </p>
        )}
      </CardContent>
    </Card>
  );
};

// ─── Hauptseite ───────────────────────────────────────────────────────────────

const SollIstAnalyse = () => {
  const today = new Date();

  const {
    isAdmin, isManager, allowedDepartment,
    canSeePersonnelCostTotals, canSeeFullFinancials,
    canSwitchDepartment,
  } = usePermissions();

  // ── Filter-Zustände ─────────────────────────────────────────────────────────
  const [period, setPeriod]   = useState<Period>('monat');
  const [selDate, setSelDate] = useState<Date>(today);
  const [dept, setDept]       = useState<Dept>(
    isAdmin ? 'all' : allowedDepartment as Dept,
  );

  // Manager: Abteilung unveränderbar
  const activeDept: Dept = isAdmin ? dept : allowedDepartment as Dept;

  // ── Daten laden ─────────────────────────────────────────────────────────────
  const [employees, setEmployees]       = useState<Employee[]>([]);
  const [scheduleData, setScheduleData] = useState<Record<string, DaySchedule>>({});
  const [actualData, setActualData]     = useState<Record<string, ActualHourEntry>>({});
  const [loading, setLoading]           = useState(true);
  const [loadedMonth, setLoadedMonth]   = useState('');

  // Monat aus selDate ableiten – bei Monatswechsel neu laden
  const monthKey = format(
    period === 'tag'   ? selDate :
    period === 'woche' ? selDate :
    selDate,
    'yyyy-MM',
  );

  useEffect(() => {
    if (monthKey === loadedMonth) return;
    const load = async () => {
      setLoading(true);
      const [emps, sched, actual] = await Promise.all([
        loadEmployees(),
        loadScheduleForMonth(selDate),
        loadActualHoursForMonth(selDate),
      ]);
      if (emps)   setEmployees(emps);
      if (sched)  setScheduleData(sched);
      if (actual) setActualData(actual);
      setLoadedMonth(monthKey);
      setLoading(false);
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey]);

  // dailyBudgets aus localStorage
  const dailyBudgets = useMemo<Record<string, DailyBudget>>(() => {
    try { return JSON.parse(localStorage.getItem('dailyBudgets') || '{}'); }
    catch { return {}; }
  }, []);

  const laborCostThreshold = Number(localStorage.getItem('labor_cost_threshold') || 40);

  // ── Budget-Daten für den gewählten Monat ─────────────────────────────────────
  const budgetYear  = selDate.getFullYear();
  const budgetMonth = selDate.getMonth() + 1;
  const budgetData  = useBudgetMonth(budgetYear, budgetMonth);

  // ── Mitarbeiter filtern ─────────────────────────────────────────────────────
  const visibleEmployees = useMemo(() => {
    if (activeDept === 'all') return employees;
    return employees.filter(e => e.department === activeDept);
  }, [employees, activeDept]);

  const visibleIds = useMemo(() => new Set(visibleEmployees.map(e => e.id)), [visibleEmployees]);

  // ── Datumsbereich je Periode ────────────────────────────────────────────────
  const periodDays = useMemo((): string[] => {
    if (period === 'tag') {
      return [format(selDate, 'yyyy-MM-dd')];
    }
    if (period === 'woche') {
      return eachDayOfInterval({
        start: startOfWeek(selDate, { weekStartsOn: 1 }),
        end:   endOfWeek(selDate,   { weekStartsOn: 1 }),
      }).map(d => format(d, 'yyyy-MM-dd'));
    }
    // monat
    return eachDayOfInterval({
      start: startOfMonth(selDate),
      end:   endOfMonth(selDate),
    }).map(d => format(d, 'yyyy-MM-dd'));
  }, [period, selDate]);

  const periodDaySet = useMemo(() => new Set(periodDays), [periodDays]);

  // ── Perioden-Label ──────────────────────────────────────────────────────────
  const periodLabel = useMemo(() => {
    if (period === 'tag') {
      return format(selDate, 'EEEE, d. MMMM yyyy', { locale: de });
    }
    if (period === 'woche') {
      const ws = startOfWeek(selDate, { weekStartsOn: 1 });
      const we = endOfWeek(selDate,   { weekStartsOn: 1 });
      return `KW ${getISOWeek(selDate)} · ${format(ws, 'd. MMM', { locale: de })} – ${format(we, 'd. MMM yyyy', { locale: de })}`;
    }
    return format(selDate, 'MMMM yyyy', { locale: de });
  }, [period, selDate]);

  // ── Navigation ──────────────────────────────────────────────────────────────
  const navigate = (dir: 'prev' | 'next') => {
    const d = dir === 'prev' ? -1 : 1;
    if (period === 'tag')   setSelDate(prev => addDays(prev, d));
    if (period === 'woche') setSelDate(prev => addWeeks(prev, d));
    if (period === 'monat') setSelDate(prev => addMonths(prev, d));
  };

  // ── Stunden-Berechnungen ────────────────────────────────────────────────────
  const plannedHours = useMemo(() =>
    Object.entries(scheduleData)
      .filter(([key]) => {
        const date  = key.slice(-10);
        const empId = key.slice(0, key.length - 11);
        return visibleIds.has(empId) && periodDaySet.has(date);
      })
      .reduce((s, [, day]) => s + calcDayHours(day), 0),
  [scheduleData, visibleIds, periodDaySet]);

  const actualHours = useMemo(() =>
    Object.entries(actualData)
      .filter(([key]) => {
        const date  = key.slice(-10);
        const empId = key.slice(0, key.length - 11);
        return visibleIds.has(empId) && periodDaySet.has(date);
      })
      .reduce((s, [, e]) => s + e.hours, 0),
  [actualData, visibleIds, periodDaySet]);

  const hasActualHours = actualHours > 0;
  const hoursVariance  = hasActualHours ? actualHours - plannedHours : null;
  const hoursVarPct    = pctVariance(plannedHours, actualHours);

  // ── Personalkosten-Berechnungen ─────────────────────────────────────────────
  // Geplante Kosten: Monat → Gehalt für Festangestellte; sonst Stunden × Lohn
  const plannedLaborCost = useMemo(() => {
    if (period === 'monat') {
      return visibleEmployees.reduce((sum, emp) => {
        if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
          return sum + emp.monthlySalary;
        }
        const hrs = Object.entries(scheduleData)
          .filter(([key]) => {
            const date  = key.slice(-10);
            const empId = key.slice(0, key.length - 11);
            return empId === emp.id && periodDaySet.has(date);
          })
          .reduce((s, [, day]) => s + calcDayHours(day), 0);
        return sum + hrs * emp.hourlyWage;
      }, 0);
    }
    // Tag / Woche: immer Stunden × Stundenlohn
    return visibleEmployees.reduce((sum, emp) => {
      const hrs = Object.entries(scheduleData)
        .filter(([key]) => {
          const date  = key.slice(-10);
          const empId = key.slice(0, key.length - 11);
          return empId === emp.id && periodDaySet.has(date);
        })
        .reduce((s, [, day]) => s + calcDayHours(day), 0);
      return sum + hrs * emp.hourlyWage;
    }, 0);
  }, [visibleEmployees, scheduleData, periodDaySet, period]);

  // Ist-Kosten: immer Ist-Stunden × Stundenlohn
  const actualLaborCost = useMemo(() => {
    if (!hasActualHours) return 0;
    return visibleEmployees.reduce((sum, emp) => {
      const hrs = Object.entries(actualData)
        .filter(([key]) => {
          const date  = key.slice(-10);
          const empId = key.slice(0, key.length - 11);
          return empId === emp.id && periodDaySet.has(date);
        })
        .reduce((s, [, e]) => s + e.hours, 0);
      return sum + hrs * emp.hourlyWage;
    }, 0);
  }, [visibleEmployees, actualData, periodDaySet, hasActualHours]);

  const costVariance    = hasActualHours ? actualLaborCost - plannedLaborCost : null;
  const costVariancePct = hasActualHours ? pctVariance(plannedLaborCost, actualLaborCost) : null;

  // ── Umsatz-Berechnungen ─────────────────────────────────────────────────────
  const sumRev = (field: keyof DailyBudget) =>
    periodDays.reduce((s, d) => s + (dailyBudgets[d]?.[field] ?? 0), 0);

  const plannedRevenue  = sumRev('plannedRevenue');
  const actualRevenue   = sumRev('actualRevenue');
  const prevYearRevenue = sumRev('previousYearRevenue');

  const hasRevenue        = plannedRevenue > 0 || actualRevenue > 0;
  const hasActualRevenue  = actualRevenue > 0;
  const hasPrevYear       = prevYearRevenue > 0;

  const revVsBudget  = hasActualRevenue && plannedRevenue > 0
    ? pctVariance(plannedRevenue, actualRevenue) : null;
  const revVsPrevYear = hasActualRevenue && hasPrevYear
    ? pctVariance(prevYearRevenue, actualRevenue) : null;

  // ── Kostenquoten ────────────────────────────────────────────────────────────
  const plannedRatio = plannedRevenue > 0 && plannedLaborCost > 0
    ? (plannedLaborCost / plannedRevenue) * 100 : null;
  const actualRatio  = actualRevenue > 0 && actualLaborCost > 0
    ? (actualLaborCost  / actualRevenue)  * 100 : null;

  // ── Budget-Vergleichs-Berechnungen (nur Monat-Periode) ────────────────────
  // Ist-Umsatz vs. Budget-Umsatz
  const budgetRevVariance    = budgetData.revenueBudget > 0 && hasActualRevenue
    ? actualRevenue - budgetData.revenueBudget : null;
  const budgetRevVariancePct = budgetData.revenueBudget > 0 && hasActualRevenue
    ? pctVariance(budgetData.revenueBudget, actualRevenue) : null;

  // Ist-Personalkosten vs. Budget-Personalkosten
  const budgetLaborVariance    = budgetData.personnelBudget > 0 && hasActualHours
    ? actualLaborCost - budgetData.personnelBudget : null;
  const budgetLaborVariancePct = budgetData.personnelBudget > 0 && hasActualHours
    ? pctVariance(budgetData.personnelBudget, actualLaborCost) : null;

  // Ist-Personalkostenquote vs. Budget-Zielquote
  // Basis: Ist-Umsatz (wenn vorhanden), sonst Budget-Umsatz
  const budgetRatioActual = budgetData.revenueBudget > 0 && actualLaborCost > 0
    ? (actualLaborCost / (actualRevenue > 0 ? actualRevenue : budgetData.revenueBudget)) * 100
    : actualRatio;

  // Ampelfarbe für Ratio
  const budgetRatioStatus = (ratio: number | null): 'good' | 'ok' | 'high' | 'none' => {
    if (ratio === null || budgetData.personnelRatioTarget === null) return 'none';
    if (ratio <= budgetData.personnelRatioTarget)     return 'good';
    if (ratio <= budgetData.personnelRatioTarget + 5) return 'ok';
    return 'high';
  };

  // ── Abteilungs-Label ────────────────────────────────────────────────────────
  const deptLabel = activeDept === 'service' ? 'Service'
    : activeDept === 'küche' ? 'Küche' : 'Alle Abteilungen';
  const deptIcon  = activeDept === 'service' ? <Utensils className="h-3.5 w-3.5" />
    : activeDept === 'küche' ? <ChefHat className="h-3.5 w-3.5" />
    : <Users className="h-3.5 w-3.5" />;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            {/* Links + Titel */}
            <div className="flex items-center gap-2">
              <Link to="/">
                <Button variant="ghost" size="sm" className="h-8 px-2">
                  <LayoutDashboard className="h-3.5 w-3.5 mr-1" />
                  <span className="text-xs">Dashboard</span>
                </Button>
              </Link>
              <span className="text-muted-foreground text-xs">/</span>
              <h1 className="text-sm font-bold">Soll / Ist Analyse</h1>
            </div>

            {/* Dienstplan-Link */}
            <Link to="/personal">
              <Button variant="outline" size="sm" className="h-8">
                <Calendar className="h-3.5 w-3.5 mr-1.5" />
                <span className="text-xs">Dienstplan</span>
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Filter-Bar */}
      <div className="bg-card border-b border-border">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3">

          {/* Perioden-Auswahl */}
          <div className="flex rounded-md overflow-hidden border border-border">
            {(['tag', 'woche', 'monat'] as Period[]).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={cn(
                  'px-3 py-1.5 text-xs font-semibold transition-colors',
                  period === p
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {p === 'tag' ? 'Tag' : p === 'woche' ? 'Woche' : 'Monat'}
              </button>
            ))}
          </div>

          {/* Periode Navigation */}
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate('prev')}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium min-w-0 text-center px-1" style={{ minWidth: '200px' }}>
              {periodLabel}
            </span>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate('next')}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex-1" />

          {/* Abteilungs-Filter (nur Admin) */}
          {isAdmin && canSwitchDepartment ? (
            <div className="flex rounded-md overflow-hidden border border-border">
              {(['all', 'service', 'küche'] as Dept[]).map(d => (
                <button
                  key={d}
                  onClick={() => setDept(d)}
                  className={cn(
                    'px-3 py-1.5 text-xs font-semibold transition-colors flex items-center gap-1',
                    dept === d
                      ? d === 'service' ? 'bg-blue-500 text-white'
                        : d === 'küche' ? 'bg-orange-500 text-white'
                        : 'bg-primary text-primary-foreground'
                      : 'hover:bg-muted text-muted-foreground',
                  )}
                >
                  {d === 'all' ? 'Alle' : d === 'service' ? 'Service' : 'Küche'}
                </button>
              ))}
            </div>
          ) : (
            <Badge
              variant="outline"
              className={cn(
                'text-xs flex items-center gap-1',
                activeDept === 'service'
                  ? 'border-blue-300 text-blue-700 bg-blue-50 dark:bg-blue-950/20'
                  : 'border-orange-300 text-orange-700 bg-orange-50 dark:bg-orange-950/20',
              )}
            >
              {deptIcon}
              {deptLabel}
            </Badge>
          )}
        </div>
      </div>

      {/* Inhalt */}
      <main className="max-w-5xl mx-auto px-4 py-5 pb-24">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
            Daten werden geladen…
          </div>
        ) : (
          <div className="space-y-6">

            {/* Zusammenfassung-Header */}
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              {deptIcon}
              <span className="font-medium">{deptLabel}</span>
              <span>·</span>
              <span>{periodLabel}</span>
              <span>·</span>
              <span>{visibleEmployees.length} Mitarbeiter</span>
              {!hasActualHours && (
                <>
                  <span>·</span>
                  <span className="text-yellow-600 dark:text-yellow-400 italic">Keine Ist-Stunden erfasst</span>
                </>
              )}
            </div>

            {/* ── 1. STUNDEN ─────────────────────────────────────────────── */}
            <section>
              <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-2">
                <Clock className="h-3.5 w-3.5" /> Stunden
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <ComparisonCard
                  title="Geplante vs. Ist-Stunden"
                  icon={<Clock className="h-4 w-4" />}
                  plan={plannedHours > 0 ? fmtHours(plannedHours) : '–'}
                  ist={hasActualHours ? fmtHours(actualHours) : '–'}
                  varianceFmt={hoursVariance !== null ? fmtHours(Math.abs(hoursVariance)) : '–'}
                  variancePct={hoursVarPct !== null ? fmtPct(Math.abs(hoursVarPct)) : undefined}
                  rawVariance={hoursVariance}
                  goodIfNegative // weniger Ist-Stunden als geplant = besser (günstig)
                  noIst={!hasActualHours}
                />
              </div>
            </section>

            {/* ── 2. PERSONALKOSTEN ──────────────────────────────────────── */}
            {canSeePersonnelCostTotals && (
              <section>
                <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-2">
                  <Users className="h-3.5 w-3.5" /> Personalkosten
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <ComparisonCard
                    title="Personalkosten"
                    icon={<Users className="h-4 w-4" />}
                    plan={plannedLaborCost > 0 ? formatCHF(plannedLaborCost) : '–'}
                    ist={hasActualHours && actualLaborCost > 0 ? formatCHF(actualLaborCost) : '–'}
                    varianceFmt={costVariance !== null ? formatCHF(Math.abs(costVariance)) : '–'}
                    variancePct={costVariancePct !== null ? fmtPct(Math.abs(costVariancePct)) : undefined}
                    rawVariance={costVariance}
                    goodIfNegative // weniger Kosten als geplant = gut
                    noIst={!hasActualHours}
                  />
                  {/* Kostenquote Karte */}
                  {hasRevenue ? (
                    <RatioCard
                      plannedRatio={plannedRatio}
                      actualRatio={actualRatio}
                      targetRatio={laborCostThreshold}
                    />
                  ) : (
                    <Card className="border border-border">
                      <CardContent className="p-4 flex items-center justify-center text-sm text-muted-foreground h-full min-h-[120px]">
                        Kein Umsatz erfasst – Kostenquote nicht berechenbar
                      </CardContent>
                    </Card>
                  )}
                </div>
                {isManager && (
                  <p className="text-[11px] text-muted-foreground mt-2 italic">
                    Einzellöhne sind aus Datenschutzgründen nur für den Administrator sichtbar.
                  </p>
                )}
              </section>
            )}

            {/* ── 3. UMSATZ (nur Admin) ──────────────────────────────────── */}
            {canSeeFullFinancials && (
              <section>
                <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-2">
                  <TrendingUp className="h-3.5 w-3.5" /> Umsatz
                </h2>
                {!hasRevenue ? (
                  <Card className="border border-dashed border-border">
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      Kein Umsatz für diesen Zeitraum erfasst.<br />
                      <span className="text-xs">Umsatzdaten im Dienstplan oder in der alten Übersicht eintragen.</span>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {/* Budget vs. Ist */}
                    <ComparisonCard
                      title="Umsatz Budget vs. Ist"
                      icon={<TrendingUp className="h-4 w-4" />}
                      planLabel="Budget"
                      plan={plannedRevenue > 0 ? formatCHF(plannedRevenue) : '–'}
                      istLabel="Ist"
                      ist={hasActualRevenue ? formatCHF(actualRevenue) : '–'}
                      varianceFmt={
                        hasActualRevenue && plannedRevenue > 0
                          ? formatCHF(Math.abs(actualRevenue - plannedRevenue))
                          : '–'
                      }
                      variancePct={revVsBudget !== null ? fmtPct(Math.abs(revVsBudget)) : undefined}
                      rawVariance={hasActualRevenue && plannedRevenue > 0 ? actualRevenue - plannedRevenue : null}
                      goodIfPositive // mehr Umsatz als Budget = gut
                      noIst={!hasActualRevenue}
                    />

                    {/* Vorjahresvergleich */}
                    {hasPrevYear && (
                      <ComparisonCard
                        title="Umsatz vs. Vorjahr"
                        icon={<TrendingUp className="h-4 w-4" />}
                        planLabel="Vorjahr"
                        plan={formatCHF(prevYearRevenue)}
                        istLabel="Dieses Jahr"
                        ist={hasActualRevenue ? formatCHF(actualRevenue) : '–'}
                        varianceFmt={
                          hasActualRevenue
                            ? formatCHF(Math.abs(actualRevenue - prevYearRevenue))
                            : '–'
                        }
                        variancePct={revVsPrevYear !== null ? fmtPct(Math.abs(revVsPrevYear)) : undefined}
                        rawVariance={hasActualRevenue ? actualRevenue - prevYearRevenue : null}
                        goodIfPositive
                        noIst={!hasActualRevenue}
                      />
                    )}
                  </div>
                )}
              </section>
            )}

            {/* ── 4. JAHRESBUDGET-VERGLEICH (nur Monat-Ansicht) ─────────────── */}
            {period === 'monat' && budgetData.hasBudget && (
              <section>
                <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-2">
                  <BookOpen className="h-3.5 w-3.5" />
                  Jahresbudget {budgetYear} · Vergleich
                  <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-700">
                    Budget-Modul
                  </span>
                </h2>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">

                  {/* Budget-Umsatz vs. Ist (nur Admin) */}
                  {canSeeFullFinancials && budgetData.revenueBudget > 0 && (
                    <ComparisonCard
                      title="Umsatz Budget vs. Ist"
                      icon={<TrendingUp className="h-4 w-4" />}
                      planLabel="Budget"
                      plan={formatCHF(budgetData.revenueBudget)}
                      istLabel="Ist"
                      ist={hasActualRevenue ? formatCHF(actualRevenue) : '–'}
                      varianceFmt={
                        budgetRevVariance !== null
                          ? formatCHF(Math.abs(budgetRevVariance))
                          : '–'
                      }
                      variancePct={
                        budgetRevVariancePct !== null
                          ? fmtPct(Math.abs(budgetRevVariancePct))
                          : undefined
                      }
                      rawVariance={budgetRevVariance}
                      goodIfPositive
                      noIst={!hasActualRevenue}
                    />
                  )}

                  {/* Budget-Personalkosten vs. Ist */}
                  {canSeePersonnelCostTotals && budgetData.personnelBudget > 0 && (
                    <ComparisonCard
                      title="Personalkosten Budget vs. Ist"
                      icon={<Users className="h-4 w-4" />}
                      planLabel="Budget"
                      plan={formatCHF(budgetData.personnelBudget)}
                      istLabel="Ist"
                      ist={hasActualHours && actualLaborCost > 0 ? formatCHF(actualLaborCost) : '–'}
                      varianceFmt={
                        budgetLaborVariance !== null
                          ? formatCHF(Math.abs(budgetLaborVariance))
                          : '–'
                      }
                      variancePct={
                        budgetLaborVariancePct !== null
                          ? fmtPct(Math.abs(budgetLaborVariancePct))
                          : undefined
                      }
                      rawVariance={budgetLaborVariance}
                      goodIfNegative
                      noIst={!hasActualHours}
                    />
                  )}

                  {/* Budget-Personalkostenquote vs. Ist-Quote */}
                  {canSeePersonnelCostTotals && budgetData.personnelRatioTarget !== null && (
                    <Card className="border border-border hover:shadow-sm transition-shadow">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Target className="h-4 w-4 text-muted-foreground" />
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Quote Budget vs. Ist
                          </p>
                        </div>

                        <div className="grid grid-cols-3 gap-2 mb-3">
                          {/* Budget-Zielquote */}
                          <div className="rounded-md bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 p-2.5 text-center">
                            <p className="text-[10px] font-bold uppercase tracking-wide text-blue-600 dark:text-blue-400 mb-0.5">Budget</p>
                            <p className="text-xl font-bold tabular-nums text-blue-700 dark:text-blue-300">
                              {fmtPct(budgetData.personnelRatioTarget)}
                            </p>
                          </div>

                          {/* Ist-Quote */}
                          <div className={cn('rounded-md border p-2.5 text-center', 'border-border')}>
                            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-0.5">Ist</p>
                            <p className={cn(
                              'text-xl font-bold tabular-nums',
                              budgetRatioStatus(budgetRatioActual) === 'good' ? 'text-green-600 dark:text-green-400' :
                              budgetRatioStatus(budgetRatioActual) === 'ok'   ? 'text-yellow-600 dark:text-yellow-400' :
                              budgetRatioStatus(budgetRatioActual) === 'high' ? 'text-red-600 dark:text-red-400' :
                              'text-muted-foreground',
                            )}>
                              {budgetRatioActual !== null ? fmtPct(budgetRatioActual) : '–'}
                            </p>
                          </div>

                          {/* Abweichung */}
                          <div className="rounded-md bg-muted/30 border border-border p-2.5 text-center">
                            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-0.5">Abw.</p>
                            <p className={cn(
                              'text-xl font-bold tabular-nums',
                              budgetRatioActual !== null && budgetRatioActual > budgetData.personnelRatioTarget
                                ? 'text-red-600 dark:text-red-400'
                                : 'text-green-600 dark:text-green-400',
                            )}>
                              {budgetRatioActual !== null
                                ? `${(budgetRatioActual - budgetData.personnelRatioTarget) >= 0 ? '+' : ''}${(budgetRatioActual - budgetData.personnelRatioTarget).toFixed(1)} %`
                                : '–'}
                            </p>
                          </div>
                        </div>

                        {/* Status */}
                        {budgetRatioActual !== null && (
                          <div className={cn(
                            'text-center text-xs font-semibold px-2 py-1 rounded border',
                            budgetRatioStatus(budgetRatioActual) === 'good'
                              ? 'bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
                              : budgetRatioStatus(budgetRatioActual) === 'ok'
                              ? 'bg-yellow-50 dark:bg-yellow-950/20 border-yellow-200 dark:border-yellow-800 text-yellow-700 dark:text-yellow-300'
                              : 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300',
                          )}>
                            {budgetRatioStatus(budgetRatioActual) === 'good' ? '✓ Im Budget-Ziel'
                              : budgetRatioStatus(budgetRatioActual) === 'ok' ? '~ Grenzwertig'
                              : '↑ Über Budget-Ziel'}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}
                </div>

                {isManager && (
                  <p className="text-[11px] text-muted-foreground mt-2 italic">
                    Budget-Umsatz und Finanzdaten sind nur für den Administrator sichtbar.
                  </p>
                )}
              </section>
            )}

            {/* Budget-Hinweis: Kein Budget vorhanden (nur Monat + Admin) */}
            {period === 'monat' && !budgetData.hasBudget && isAdmin && (
              <div className="flex items-start gap-3 rounded-lg border border-dashed border-border bg-muted/10 p-4">
                <BookOpen className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Kein Jahresbudget für {budgetYear}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Erstelle ein Budget unter «Budget-Planung», um hier Budget-Soll/Ist-Vergleiche zu sehen.
                  </p>
                </div>
              </div>
            )}

            {/* ── 5. KOSTENQUOTE DETAIL (nur sichtbar wenn Revenue vorhanden) ── */}
            {canSeePersonnelCostTotals && !canSeeFullFinancials && hasRevenue && (
              <section>
                <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-2">
                  <Target className="h-3.5 w-3.5" /> Kostenquote (Detail)
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <RatioCard
                    plannedRatio={plannedRatio}
                    actualRatio={actualRatio}
                    targetRatio={laborCostThreshold}
                  />
                </div>
              </section>
            )}

            {/* Hinweis: Keine Daten */}
            {!loading && plannedHours === 0 && !hasRevenue && (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 p-8 text-center">
                <p className="text-sm font-medium text-muted-foreground">
                  Keine Daten für diesen Zeitraum
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Bitte zuerst den Dienstplan für diesen Monat ausfüllen.
                </p>
                <Link to="/personal" className="mt-3 inline-block">
                  <Button variant="outline" size="sm">Zum Dienstplan</Button>
                </Link>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default SollIstAnalyse;
