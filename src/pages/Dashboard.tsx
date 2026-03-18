import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  format, startOfWeek, endOfWeek, eachDayOfInterval,
  startOfMonth, endOfMonth, startOfYear, endOfYear,
  addDays, addWeeks, addMonths, addYears,
  subDays, subWeeks, subMonths, subYears,
  getDaysInMonth, isSameDay, isSameMonth, isSameYear,
} from 'date-fns';
import { de } from 'date-fns/locale';
import {
  TrendingUp, TrendingDown, Minus,
  Users, Clock, ChefHat, Utensils,
  CalendarDays, AlertTriangle, CheckCircle2,
  LayoutDashboard, Calendar, BarChart2,
  BookOpen, Target, Upload, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import { useStichtag } from '@/contexts/StichtagContext';
import { StichtagBanner } from '@/components/StichtagBanner';

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function parseTimeToHours(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h + m / 60;
}

function shiftHours(start: string, end: string): number {
  const s = parseTimeToHours(start);
  let e = parseTimeToHours(end);
  if (e < s) e += 24;
  return Math.max(0, e - s);
}

function calcDayHours(schedule: DaySchedule): number {
  let total = 0;
  if (schedule.früh && !schedule.frühAbsence) {
    total += shiftHours(schedule.früh.start, schedule.früh.end);
  }
  if (schedule.spät && !schedule.spätAbsence) {
    total += shiftHours(schedule.spät.start, schedule.spät.end);
  }
  return total;
}

function formatCHF(value: number, decimals = 0): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency',
    currency: 'CHF',
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatHours(h: number): string {
  return `${h.toFixed(1)} h`;
}

interface DailyBudget {
  plannedRevenue: number;
  actualRevenue: number;
  previousYearRevenue: number;
}

// ─── KPI-Karte ────────────────────────────────────────────────────────────────

interface KpiCardProps {
  title: string;
  value: string;
  subtitle?: string;
  delta?: number | null;
  deltaLabel?: string;
  icon?: React.ReactNode;
  color?: 'default' | 'green' | 'yellow' | 'red' | 'blue' | 'orange';
  badge?: string;
  badgeColor?: string;
  small?: boolean;
}

const colorMap = {
  default: 'border-border',
  green:   'border-green-400 dark:border-green-600',
  yellow:  'border-yellow-400 dark:border-yellow-600',
  red:     'border-red-400 dark:border-red-600',
  blue:    'border-blue-400 dark:border-blue-600',
  orange:  'border-orange-400 dark:border-orange-600',
};

const KpiCard = ({
  title, value, subtitle, delta, deltaLabel, icon, color = 'default', badge, badgeColor, small,
}: KpiCardProps) => {
  const hasDelta = delta !== null && delta !== undefined;
  const deltaPositive = hasDelta && delta > 0;
  const deltaNeutral  = hasDelta && delta === 0;

  return (
    <Card className={cn('border-l-4 transition-shadow hover:shadow-md', colorMap[color])}>
      <CardContent className={cn('p-4', small && 'p-3')}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground truncate mb-1">
              {title}
            </p>
            <p className={cn('font-bold tabular-nums leading-tight', small ? 'text-xl' : 'text-2xl')}>
              {value}
            </p>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
            )}
            {hasDelta && (
              <div className={cn(
                'flex items-center gap-1 mt-1 text-xs font-medium',
                deltaNeutral ? 'text-muted-foreground' :
                deltaPositive ? 'text-green-600 dark:text-green-400' :
                'text-red-600 dark:text-red-400',
              )}>
                {deltaNeutral ? <Minus className="h-3 w-3" /> :
                 deltaPositive ? <TrendingUp className="h-3 w-3" /> :
                 <TrendingDown className="h-3 w-3" />}
                <span>{deltaPositive ? '+' : ''}{delta.toFixed(1)} {deltaLabel}</span>
              </div>
            )}
          </div>
          {icon && (
            <div className="text-muted-foreground/60 flex-shrink-0 mt-0.5">
              {icon}
            </div>
          )}
        </div>
        {badge && (
          <div className="mt-2">
            <span className={cn(
              'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border',
              badgeColor,
            )}>
              {badge}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ─── Abschnitt-Überschrift ────────────────────────────────────────────────────

const SectionTitle = ({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) => (
  <div className="flex items-center gap-2 mt-6 mb-3">
    {icon && <span className="text-muted-foreground">{icon}</span>}
    <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{children}</h2>
  </div>
);

// ─── Dashboard ────────────────────────────────────────────────────────────────

type Period = 'today' | 'week' | 'month' | 'year';

const PERIOD_LABELS: Record<Period, string> = {
  today: 'Heute',
  week:  'Woche',
  month: 'Monat',
  year:  'Jahr',
};

const Dashboard = () => {
  const today = useMemo(() => new Date(), []);
  const [referenceDate, setReferenceDate] = useState<Date>(() => new Date());
  const [period, setPeriod] = useState<Period>('month');

  // Navigation: vor/zurück je nach Periode
  const navigatePrev = () => setReferenceDate(d =>
    period === 'today' ? subDays(d, 1)
    : period === 'week'  ? subWeeks(d, 1)
    : period === 'month' ? subMonths(d, 1)
    : subYears(d, 1),
  );
  const navigateNext = () => setReferenceDate(d =>
    period === 'today' ? addDays(d, 1)
    : period === 'week'  ? addWeeks(d, 1)
    : period === 'month' ? addMonths(d, 1)
    : addYears(d, 1),
  );
  const navigateToday = () => setReferenceDate(new Date());

  // Ist das referenceDate in der aktuellen Periode?
  const isCurrentPeriod =
    period === 'today' ? isSameDay(referenceDate, today)
    : period === 'week'  ? isSameDay(
        startOfWeek(referenceDate, { weekStartsOn: 1 }),
        startOfWeek(today, { weekStartsOn: 1 }),
      )
    : period === 'month' ? isSameMonth(referenceDate, today)
    : isSameYear(referenceDate, today);

  const monthKey = format(referenceDate, 'yyyy-MM');

  const {
    isAdmin, isManager, allowedDepartment,
    canSeeHourlyWages, canSeeFullFinancials, canSeePersonnelCostTotals,
  } = usePermissions();
  const { isActive: stichtagActive, stichtagYear, stichtagMonth, formatted: stichtagFormatted } = useStichtag();

  const deptLabel = allowedDepartment === 'service' ? 'Service'
    : allowedDepartment === 'küche' ? 'Küche'
    : 'Gesamt';
  const deptIcon = allowedDepartment === 'service' ? <Utensils className="h-4 w-4" />
    : allowedDepartment === 'küche' ? <ChefHat className="h-4 w-4" />
    : <Users className="h-4 w-4" />;

  // ── Rohdaten ────────────────────────────────────────────────────────────────
  const [employees, setEmployees]       = useState<Employee[]>([]);
  const [scheduleData, setScheduleData] = useState<Record<string, DaySchedule>>({});
  const [actualData, setActualData]     = useState<Record<string, ActualHourEntry>>({});
  const [loading, setLoading]           = useState(true);

  useEffect(() => {
    const load = async () => {
      const [emps, sched, actual] = await Promise.all([
        loadEmployees(),
        loadScheduleForMonth(today),
        loadActualHoursForMonth(today),
      ]);
      if (emps)   setEmployees(emps);
      if (sched)  setScheduleData(sched);
      if (actual) setActualData(actual);
      setLoading(false);
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey]);

  // DailyBudgets aus localStorage (Umsatz-Daten)
  const dailyBudgets = useMemo<Record<string, DailyBudget>>(() => {
    try {
      return JSON.parse(localStorage.getItem('dailyBudgets') || '{}');
    } catch {
      return {};
    }
  }, []);

  const laborCostThreshold = Number(localStorage.getItem('labor_cost_threshold') || 40);

  // ── Budget-Daten (aus Budget-Modul, budget_v1) ───────────────────────────────
  const currentYear  = referenceDate.getFullYear();
  const currentMonth = referenceDate.getMonth() + 1;
  const budgetData   = useBudgetMonth(currentYear, currentMonth);

  // ── Mitarbeiter nach Abteilung filtern ──────────────────────────────────────
  const visibleEmployees = useMemo(() => {
    if (isAdmin) return employees;
    return employees.filter(e => e.department === allowedDepartment);
  }, [employees, isAdmin, allowedDepartment]);

  const visibleIds = useMemo(() => new Set(visibleEmployees.map(e => e.id)), [visibleEmployees]);

  // ── Datumslisten (basierend auf referenceDate) ───────────────────────────────
  const refDateStr = format(referenceDate, 'yyyy-MM-dd');
  const weekDays   = eachDayOfInterval({
    start: startOfWeek(referenceDate, { weekStartsOn: 1 }),
    end:   endOfWeek(referenceDate,   { weekStartsOn: 1 }),
  }).map(d => format(d, 'yyyy-MM-dd'));
  const monthDays  = eachDayOfInterval({
    start: startOfMonth(referenceDate),
    end:   endOfMonth(referenceDate),
  }).map(d => format(d, 'yyyy-MM-dd'));
  const yearDays   = eachDayOfInterval({
    start: startOfYear(referenceDate),
    end:   endOfYear(referenceDate),
  }).map(d => format(d, 'yyyy-MM-dd'));

  // Aktive Tage abhängig von der gewählten Periode
  const activeDays = period === 'today' ? [refDateStr]
    : period === 'week'  ? weekDays
    : period === 'month' ? monthDays
    : yearDays;

  // ── Umsatz-Berechnungen ─────────────────────────────────────────────────────
  const sumRevenue = (days: string[], field: keyof DailyBudget) =>
    days.reduce((s, d) => s + (dailyBudgets[d]?.[field] ?? 0), 0);

  const revenueMonth        = sumRevenue(monthDays,  'actualRevenue');
  const revenuePlannedMonth = sumRevenue(monthDays,  'plannedRevenue');

  // Periodenspezifische Umsatz-Werte
  const revenueActive         = sumRevenue(activeDays, 'actualRevenue');
  const revenuePrevYearActive = sumRevenue(activeDays, 'previousYearRevenue');

  // Budget pro Periode: aus budget_v1 Monatsbudget anteilig berechnen
  const daysInRefMonth = getDaysInMonth(referenceDate);
  const budgetActive = budgetData.revenueBudget > 0
    ? period === 'month' ? budgetData.revenueBudget
      : period === 'today' ? budgetData.revenueBudget / daysInRefMonth
      : period === 'week'  ? budgetData.revenueBudget / daysInRefMonth * 7
      : budgetData.revenueBudget * 12  // Jahr: Monatsbudget × 12
    : 0;

  // ── Personalkosten-Berechnungen ─────────────────────────────────────────────
  const monthDateSet = new Set(monthDays);

  const plannedLaborCost = useMemo(() => {
    return visibleEmployees.reduce((sum, emp) => {
      if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
        return sum + emp.monthlySalary;
      }
      const hrs = Object.entries(scheduleData)
        .filter(([key]) => {
          const date = key.slice(-(10));
          const empId = key.slice(0, key.length - 11);
          return empId === emp.id && monthDateSet.has(date);
        })
        .reduce((s, [, day]) => s + calcDayHours(day), 0);
      return sum + hrs * emp.hourlyWage;
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEmployees, scheduleData]);

  const actualLaborCost = useMemo(() => {
    return visibleEmployees.reduce((sum, emp) => {
      const hrs = Object.entries(actualData)
        .filter(([key]) => {
          const date = key.slice(-10);
          const empId = key.slice(0, key.length - 11);
          return empId === emp.id && monthDateSet.has(date);
        })
        .reduce((s, [, e]) => s + e.hours, 0);
      return sum + hrs * emp.hourlyWage;
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEmployees, actualData]);

  const plannedHours = useMemo(() => {
    return Object.entries(scheduleData)
      .filter(([key]) => {
        const date = key.slice(-10);
        const empId = key.slice(0, key.length - 11);
        return visibleIds.has(empId) && monthDateSet.has(date);
      })
      .reduce((s, [, day]) => s + calcDayHours(day), 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleData, visibleIds]);

  const actualHours = useMemo(() => {
    return Object.entries(actualData)
      .filter(([key]) => {
        const date = key.slice(-10);
        const empId = key.slice(0, key.length - 11);
        return visibleIds.has(empId) && monthDateSet.has(date);
      })
      .reduce((s, [, e]) => s + e.hours, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actualData, visibleIds]);

  const hoursVariance = actualHours > 0 ? actualHours - plannedHours : null;

  const plannedCostRatio = revenuePlannedMonth > 0
    ? (plannedLaborCost / revenuePlannedMonth) * 100
    : null;
  const actualCostRatio = revenueMonth > 0 && actualLaborCost > 0
    ? (actualLaborCost / revenueMonth) * 100
    : null;

  // ── Kostenquote-Status ───────────────────────────────────────────────────────
  const ratioStatus = (ratio: number | null): 'good' | 'ok' | 'high' | 'unknown' => {
    if (ratio === null) return 'unknown';
    if (ratio <= laborCostThreshold) return 'good';
    if (ratio <= laborCostThreshold + 5) return 'ok';
    return 'high';
  };
  const plannedRatioStatus = ratioStatus(plannedCostRatio);
  const ratioCardColor = plannedRatioStatus === 'good' ? 'green'
    : plannedRatioStatus === 'ok' ? 'yellow'
    : plannedRatioStatus === 'high' ? 'red'
    : 'default';

  const monthName = format(referenceDate, 'MMMM yyyy', { locale: de });

  // ── Perioden-Label für Header und Sektionen ──────────────────────────────────
  const periodLabel = period === 'today'
    ? format(referenceDate, 'EEEE, d. MMMM yyyy', { locale: de })
    : period === 'week'
      ? `KW ${format(referenceDate, 'w', { locale: de })} · ${format(startOfWeek(referenceDate, { weekStartsOn: 1 }), 'd. MMM', { locale: de })} – ${format(endOfWeek(referenceDate, { weekStartsOn: 1 }), 'd. MMM yyyy', { locale: de })}`
      : period === 'month'
        ? format(referenceDate, 'MMMM yyyy', { locale: de })
        : `${referenceDate.getFullYear()}`;

  // ── Budget-Vergleichs-Berechnungen ───────────────────────────────────────────
  // Abweichung Umsatz: Ist (aus dailyBudgets) vs. Jahresbudget
  const revVsBudgetAbs = budgetData.revenueBudget > 0
    ? revenueMonth - budgetData.revenueBudget
    : null;
  const revVsBudgetPct = budgetData.revenueBudget > 0
    ? ((revenueMonth - budgetData.revenueBudget) / budgetData.revenueBudget) * 100
    : null;

  // Abweichung Personalkosten: Ist vs. Jahresbudget
  const laborVsBudgetAbs = budgetData.personnelBudget > 0
    ? actualLaborCost - budgetData.personnelBudget
    : null;
  const laborVsBudgetPct = budgetData.personnelBudget > 0
    ? ((actualLaborCost - budgetData.personnelBudget) / budgetData.personnelBudget) * 100
    : null;

  // Ist-Personalkostenquote (vs. budgetiertem Umsatz)
  const actualRatioVsBudgetRevenue = budgetData.revenueBudget > 0 && actualLaborCost > 0
    ? (actualLaborCost / budgetData.revenueBudget) * 100
    : null;

  // Budget-Betriebsergebnis-Vergleich: Ist-Ergebnis = Ist-Umsatz - Ist-Personalkosten
  const actualOperatingApprox = revenueMonth - actualLaborCost;
  const budgetResultVariance   = budgetData.operatingResultBudget !== 0
    ? actualOperatingApprox - budgetData.operatingResultBudget
    : null;

  // Hilfsfunktion: Ratio-Statusfarbe (Budget-Target als Basis)
  const budgetRatioColor = (ratio: number | null, target: number | null): 'green' | 'yellow' | 'red' | 'default' => {
    if (ratio === null || target === null) return 'default';
    if (ratio <= target)     return 'green';
    if (ratio <= target + 5) return 'yellow';
    return 'red';
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <LayoutDashboard className="h-5 w-5 text-muted-foreground flex-shrink-0" />
              <div>
                <h1 className="text-base font-bold leading-tight">Dashboard</h1>
                <p className="text-xs text-muted-foreground">oLiv Restaurant & Bar · {monthName}</p>
              </div>
            </div>

            {/* Zeitraum-Auswahl + Navigation */}
            <div className="flex items-center gap-1.5">
              {/* Perioden-Typ */}
              <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
                {(['today', 'week', 'month', 'year'] as Period[]).map(p => (
                  <button
                    key={p}
                    onClick={() => { setPeriod(p); setReferenceDate(new Date()); }}
                    className={cn(
                      'px-3 py-1 text-xs font-medium rounded-md transition-all',
                      period === p
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {PERIOD_LABELS[p]}
                  </button>
                ))}
              </div>

              {/* Navigation: ← Heute → */}
              <div className="flex items-center gap-0.5">
                <button
                  onClick={navigatePrev}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Zurück"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                {!isCurrentPeriod && (
                  <button
                    onClick={navigateToday}
                    className="px-2 py-1 text-xs font-medium rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    title="Zur aktuellen Periode"
                  >
                    Heute
                  </button>
                )}
                <button
                  onClick={navigateNext}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Weiter"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {isAdmin && (
                <Badge variant="outline" className="text-xs hidden lg:flex">
                  {deptIcon}
                  <span className="ml-1">Alle Abteilungen</span>
                </Badge>
              )}
              {isManager && (
                <Badge
                  variant="outline"
                  className={cn(
                    'text-xs hidden lg:flex items-center gap-1',
                    allowedDepartment === 'service'
                      ? 'border-blue-300 text-blue-700 bg-blue-50 dark:bg-blue-950/30'
                      : 'border-orange-300 text-orange-700 bg-orange-50 dark:bg-orange-950/30',
                  )}
                >
                  {deptIcon}
                  <span>{deptLabel}</span>
                </Badge>
              )}
              {isAdmin && (
                <Link to="/import">
                  <Button variant="outline" size="sm" className="h-8">
                    <Upload className="h-3.5 w-3.5 mr-1.5" />
                    <span className="hidden sm:inline">Import</span>
                  </Button>
                </Link>
              )}
              <Link to="/personal">
                <Button variant="outline" size="sm" className="h-8">
                  <Calendar className="h-3.5 w-3.5 mr-1.5" />
                  Dienstplan
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 pb-24 space-y-2">

        {loading && (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
            Daten werden geladen…
          </div>
        )}

        {!loading && (
          <>
            {/* ── Stichtag-Hinweisbanner ────────────────────────────────────── */}
            <StichtagBanner />

            {/* ── Warnung: Kostenquote überschritten ───────────────────────── */}
            {canSeePersonnelCostTotals && plannedRatioStatus === 'high' && (
              <div className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/20 dark:border-red-800 p-4">
                <AlertTriangle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-red-700 dark:text-red-400">
                    Kostenquote überschritten
                  </p>
                  <p className="text-xs text-red-600 dark:text-red-500 mt-0.5">
                    Die geplante Personalkostenquote ({plannedCostRatio?.toFixed(1)} %) liegt über dem
                    Ziel von {laborCostThreshold} %. Bitte Dienstplan prüfen.
                  </p>
                </div>
              </div>
            )}

            {canSeePersonnelCostTotals && plannedRatioStatus === 'good' && plannedCostRatio !== null && (
              <div className="flex items-start gap-3 rounded-lg border border-green-300 bg-green-50 dark:bg-green-950/20 dark:border-green-800 p-4">
                <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-green-700 dark:text-green-400">
                    Kostenquote im Zielbereich
                  </p>
                  <p className="text-xs text-green-600 dark:text-green-500 mt-0.5">
                    Geplante Kostenquote {plannedCostRatio?.toFixed(1)} % — Ziel: ≤ {laborCostThreshold} %
                  </p>
                </div>
              </div>
            )}

            {/* ── Admin: Umsatz ────────────────────────────────────────────── */}
            {isAdmin && (
              <>
                <SectionTitle icon={<TrendingUp className="h-4 w-4" />}>
                  Umsatz · {PERIOD_LABELS[period]}
                  <span className="ml-2 font-normal text-muted-foreground normal-case">{periodLabel}</span>
                </SectionTitle>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <KpiCard
                    title={`Umsatz Ist · ${PERIOD_LABELS[period]}`}
                    value={revenueActive > 0 ? formatCHF(revenueActive) : '–'}
                    subtitle="Tatsächlicher Umsatz"
                    icon={<TrendingUp className="h-5 w-5" />}
                    color={revenueActive > 0 ? 'green' : 'default'}
                  />
                  <KpiCard
                    title={`Budget · ${PERIOD_LABELS[period]}`}
                    value={budgetActive > 0 ? formatCHF(Math.round(budgetActive)) : '–'}
                    subtitle={period === 'month' ? 'Monatsbudget 2026' : period === 'year' ? 'Jahresbudget (×12)' : 'Anteiliges Budget'}
                    delta={budgetActive > 0 ? ((revenueActive - budgetActive) / budgetActive) * 100 : null}
                    deltaLabel="% vs. Budget"
                    icon={<CalendarDays className="h-5 w-5" />}
                    color="blue"
                  />
                  <KpiCard
                    title={`Vorjahr · ${PERIOD_LABELS[period]}`}
                    value={revenuePrevYearActive > 0 ? formatCHF(revenuePrevYearActive) : '–'}
                    subtitle="Vergleich Vorjahr"
                    delta={revenuePrevYearActive > 0 ? ((revenueActive - revenuePrevYearActive) / revenuePrevYearActive) * 100 : null}
                    deltaLabel="% vs. Vorjahr"
                    icon={<TrendingUp className="h-5 w-5" />}
                    color={revenuePrevYearActive > 0 ? (revenueActive >= revenuePrevYearActive ? 'green' : 'red') : 'default'}
                  />
                </div>

              </>
            )}

            {/* ── Jahresbudget-Vergleich ───────────────────────────────────── */}
            {budgetData.hasBudget && (
              <>
                <SectionTitle icon={<BookOpen className="h-4 w-4" />}>
                  Jahresbudget-Vergleich · {monthName}
                </SectionTitle>

                {/* Umsatz: Budget vs. Ist (nur Admin) */}
                {isAdmin && (
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <KpiCard
                      title="Budget Umsatz"
                      value={formatCHF(budgetData.revenueBudget)}
                      subtitle={`Jahresplanung ${currentYear}`}
                      icon={<BookOpen className="h-5 w-5" />}
                      color="blue"
                    />
                    <KpiCard
                      title="Ist Umsatz"
                      value={revenueMonth > 0 ? formatCHF(revenueMonth) : '–'}
                      subtitle="Tatsächlich erfasst"
                      icon={<TrendingUp className="h-5 w-5" />}
                      color={
                        revVsBudgetPct === null ? 'default' :
                        revVsBudgetPct >= 0 ? 'green' : 'red'
                      }
                      delta={revVsBudgetPct}
                      deltaLabel="% vs. Budget"
                    />
                    {revVsBudgetAbs !== null && (
                      <KpiCard
                        title="Abweichung CHF"
                        value={`${revVsBudgetAbs >= 0 ? '+' : ''}${formatCHF(revVsBudgetAbs)}`}
                        subtitle={revVsBudgetAbs >= 0 ? 'Über Budget' : 'Unter Budget'}
                        icon={revVsBudgetAbs >= 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
                        color={revVsBudgetAbs >= 0 ? 'green' : 'red'}
                        badge={revVsBudgetAbs >= 0 ? '✓ Über Budget' : '↓ Unter Budget'}
                        badgeColor={
                          revVsBudgetAbs >= 0
                            ? 'bg-green-50 text-green-700 border-green-300 dark:bg-green-950/30'
                            : 'bg-red-50 text-red-700 border-red-300 dark:bg-red-950/30'
                        }
                      />
                    )}
                    {budgetData.operatingResultBudget !== 0 && (
                      <KpiCard
                        title="Ergebnis Budget"
                        value={formatCHF(budgetData.operatingResultBudget)}
                        subtitle="Geplantes Betriebsergebnis"
                        icon={<Target className="h-5 w-5" />}
                        color="default"
                        delta={budgetResultVariance}
                        deltaLabel="CHF Abw."
                      />
                    )}
                  </div>
                )}

                {/* Personalkosten: Budget vs. Ist */}
                {canSeePersonnelCostTotals && budgetData.personnelBudget > 0 && (
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                    <KpiCard
                      title="Budget Personalkosten"
                      value={formatCHF(budgetData.personnelBudget)}
                      subtitle="Aus Jahresplanung"
                      icon={<BookOpen className="h-5 w-5" />}
                      color="blue"
                    />
                    {actualLaborCost > 0 && (
                      <KpiCard
                        title="Ist Personalkosten"
                        value={formatCHF(actualLaborCost)}
                        subtitle="Effektive Kosten"
                        icon={<Users className="h-5 w-5" />}
                        color={laborVsBudgetAbs !== null && laborVsBudgetAbs <= 0 ? 'green' : 'red'}
                        delta={laborVsBudgetPct}
                        deltaLabel="% vs. Budget"
                      />
                    )}
                    {budgetData.personnelRatioTarget !== null && (
                      <KpiCard
                        title="Budget-Zielquote"
                        value={`${budgetData.personnelRatioTarget.toFixed(1)} %`}
                        subtitle="Personalkostenquote Budget"
                        icon={<Target className="h-5 w-5" />}
                        color="blue"
                      />
                    )}
                    {actualRatioVsBudgetRevenue !== null && budgetData.personnelRatioTarget !== null && (
                      <KpiCard
                        title="Ist-Quote vs. Budget"
                        value={`${actualRatioVsBudgetRevenue.toFixed(1)} %`}
                        subtitle={`Ziel: ≤ ${budgetData.personnelRatioTarget.toFixed(1)} %`}
                        icon={<Target className="h-5 w-5" />}
                        color={budgetRatioColor(actualRatioVsBudgetRevenue, budgetData.personnelRatioTarget)}
                        badge={
                          actualRatioVsBudgetRevenue <= budgetData.personnelRatioTarget
                            ? '✓ Im Ziel'
                            : actualRatioVsBudgetRevenue <= budgetData.personnelRatioTarget + 5
                            ? '~ Grenzwertig'
                            : '↑ Über Ziel'
                        }
                        badgeColor={
                          actualRatioVsBudgetRevenue <= budgetData.personnelRatioTarget
                            ? 'bg-green-50 text-green-700 border-green-300 dark:bg-green-950/30'
                            : actualRatioVsBudgetRevenue <= budgetData.personnelRatioTarget + 5
                            ? 'bg-yellow-50 text-yellow-700 border-yellow-300 dark:bg-yellow-950/30'
                            : 'bg-red-50 text-red-700 border-red-300 dark:bg-red-950/30'
                        }
                      />
                    )}
                  </div>
                )}

                {/* Hinweis falls kein Budget-Betrag eingetragen */}
                {!isAdmin && !canSeePersonnelCostTotals && (
                  <p className="text-xs text-muted-foreground italic">
                    Budget-Werte sind eingetragen – Details nur für Administrator und Manager sichtbar.
                  </p>
                )}
              </>
            )}

            {/* Kein Budget vorhanden → Link zum Budget-Modul (nur Admin) */}
            {!budgetData.hasBudget && isAdmin && (
              <div className="flex items-start gap-3 rounded-lg border border-dashed border-border bg-muted/10 p-4">
                <BookOpen className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Kein Jahresbudget für {currentYear}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Erstelle ein Budget unter «Budget-Planung», um hier Soll/Budget-Vergleiche zu sehen.
                  </p>
                </div>
              </div>
            )}

            {/* ── Personalkosten ───────────────────────────────────────────── */}
            {canSeePersonnelCostTotals && (
              <>
                <SectionTitle icon={deptIcon}>
                  Personalkosten {deptLabel} · {monthName}
                </SectionTitle>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <KpiCard
                    title="Geplante Kosten"
                    value={plannedLaborCost > 0 ? formatCHF(plannedLaborCost) : '–'}
                    subtitle={`${visibleEmployees.length} Mitarbeiter`}
                    icon={<Users className="h-5 w-5" />}
                    color="blue"
                  />
                  {actualLaborCost > 0 && (
                    <KpiCard
                      title="Ist-Kosten"
                      value={formatCHF(actualLaborCost)}
                      subtitle="Effektive Kosten"
                      delta={plannedLaborCost > 0 ? actualLaborCost - plannedLaborCost : null}
                      deltaLabel="CHF"
                      icon={<Users className="h-5 w-5" />}
                      color={
                        actualLaborCost <= plannedLaborCost ? 'green' : 'red'
                      }
                    />
                  )}
                  <KpiCard
                    title="Kostenquote (Soll)"
                    value={plannedCostRatio !== null ? `${plannedCostRatio.toFixed(1)} %` : '–'}
                    subtitle={`Ziel: ≤ ${laborCostThreshold} %`}
                    icon={<TrendingUp className="h-5 w-5" />}
                    color={ratioCardColor as 'green' | 'yellow' | 'red' | 'default'}
                    badge={
                      plannedRatioStatus === 'good' ? '✓ Im Ziel' :
                      plannedRatioStatus === 'ok'   ? '~ Grenzwertig' :
                      plannedRatioStatus === 'high'  ? '↑ Über Ziel' : undefined
                    }
                    badgeColor={
                      plannedRatioStatus === 'good' ? 'bg-green-50 text-green-700 border-green-300 dark:bg-green-950/30' :
                      plannedRatioStatus === 'ok'   ? 'bg-yellow-50 text-yellow-700 border-yellow-300 dark:bg-yellow-950/30' :
                      'bg-red-50 text-red-700 border-red-300 dark:bg-red-950/30'
                    }
                  />
                  {actualCostRatio !== null && (
                    <KpiCard
                      title="Kostenquote (Ist)"
                      value={`${actualCostRatio.toFixed(1)} %`}
                      subtitle="Effektive Quote"
                      icon={<TrendingUp className="h-5 w-5" />}
                      color={ratioStatus(actualCostRatio) === 'good' ? 'green' : ratioStatus(actualCostRatio) === 'ok' ? 'yellow' : 'red'}
                    />
                  )}
                </div>
              </>
            )}

            {/* ── Stunden ──────────────────────────────────────────────────── */}
            {canSeePersonnelCostTotals && (
              <>
                <SectionTitle icon={<Clock className="h-4 w-4" />}>
                  Stunden {deptLabel} · {monthName}
                </SectionTitle>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  <KpiCard
                    title="Geplante Stunden"
                    value={plannedHours > 0 ? formatHours(plannedHours) : '–'}
                    subtitle="Aus Dienstplan"
                    icon={<Clock className="h-5 w-5" />}
                    color="blue"
                  />
                  <KpiCard
                    title="Ist-Stunden"
                    value={actualHours > 0 ? formatHours(actualHours) : '–'}
                    subtitle="Erfasste Stunden"
                    delta={hoursVariance}
                    deltaLabel="h vs. Plan"
                    icon={<Clock className="h-5 w-5" />}
                    color={
                      actualHours === 0 ? 'default' :
                      hoursVariance !== null && hoursVariance <= 0 ? 'green' : 'yellow'
                    }
                  />
                  <KpiCard
                    title="Mitarbeiter"
                    value={String(visibleEmployees.length)}
                    subtitle={deptLabel}
                    icon={deptIcon}
                    color="default"
                  />
                </div>
              </>
            )}

            {/* ── Schnellzugriff ───────────────────────────────────────────── */}
            <SectionTitle>Schnellzugriff</SectionTitle>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <Link to="/personal">
                <Card className="hover:shadow-md transition-shadow cursor-pointer border-border hover:border-primary/40">
                  <CardHeader className="pb-2 pt-4">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      Dienstplan {monthName}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pb-4">
                    <p className="text-xs text-muted-foreground">
                      Plan- und Ist-Dienstplan verwalten, Stunden erfassen.
                    </p>
                  </CardContent>
                </Card>
              </Link>

              <Link to="/analyse">
                <Card className="hover:shadow-md transition-shadow cursor-pointer border-border hover:border-primary/40">
                  <CardHeader className="pb-2 pt-4">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <BarChart2 className="h-4 w-4 text-muted-foreground" />
                      Soll / Ist Analyse
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pb-4">
                    <p className="text-xs text-muted-foreground">
                      Stunden, Kosten und Umsatz im Vergleich — Tag, Woche oder Monat.
                    </p>
                  </CardContent>
                </Card>
              </Link>

              {isAdmin && (
                <Link to="/personal-stamm">
                  <Card className="hover:shadow-md transition-shadow cursor-pointer border-border hover:border-primary/40">
                    <CardHeader className="pb-2 pt-4">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        Personalstamm
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pb-4">
                      <p className="text-xs text-muted-foreground">
                        Mitarbeiterdaten, Löhne, Verträge und Stammdaten verwalten.
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              )}
            </div>

            {/* Info für Manager: keine Einzellöhne */}
            {isManager && (
              <p className="text-xs text-muted-foreground text-center pt-4">
                Einzellöhne sind aus Datenschutzgründen nur für den Administrator sichtbar.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default Dashboard;
