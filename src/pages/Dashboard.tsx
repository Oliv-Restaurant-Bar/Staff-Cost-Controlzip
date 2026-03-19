import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
  Pencil, Check, X as XIcon, Scale, Printer,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { usePermissions } from '@/hooks/usePermissions';
import { GuestLinkGenerator } from '@/components/GuestLinkGenerator';
import { useBudgetMonth } from '@/hooks/useBudgetMonth';
import { loadMonth, loadYear } from '@/lib/reporting-store';
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
            <p className={cn('font-bold tabular-nums leading-tight', small ? 'text-lg sm:text-xl' : 'text-xl sm:text-2xl')}>
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

  const monthKey   = format(referenceDate, 'yyyy-MM');
  const refDateStr = format(referenceDate, 'yyyy-MM-dd');

  const {
    isAdmin, isManager, allowedDepartment,
    canSeeHourlyWages, canSeeFullFinancials, canSeePersonnelCostTotals,
  } = usePermissions();
  const {
    isActive: stichtagActive, stichtagYear, stichtagMonth, stichtagDay,
    stichtag, formatted: stichtagFormatted,
  } = useStichtag();

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
        loadScheduleForMonth(referenceDate),
        loadActualHoursForMonth(referenceDate),
      ]);
      if (emps)   setEmployees(emps);
      if (sched)  setScheduleData(sched);
      if (actual) setActualData(actual);
      setLoading(false);
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey]);

  // DailyBudgets aus localStorage (Umsatz-Daten) — schreibbar für Schnelleingabe
  const [dailyBudgets, setDailyBudgets] = useState<Record<string, DailyBudget>>(() => {
    try { return JSON.parse(localStorage.getItem('dailyBudgets') || '{}'); }
    catch { return {}; }
  });

  // Nach Supabase-Sync dailyBudgets neu laden
  useEffect(() => {
    const handler = () => {
      try {
        const data = JSON.parse(localStorage.getItem('dailyBudgets') || '{}');
        setDailyBudgets(data);
      } catch { /* ignore */ }
    };
    window.addEventListener('store-synced', handler);
    return () => window.removeEventListener('store-synced', handler);
  }, []);

  // Schnelleingabe-State
  const [editingRevenue, setEditingRevenue] = useState(false);
  const [pendingRevenue, setPendingRevenue] = useState('');
  const revenueInputRef = useRef<HTMLInputElement>(null);
  const dashboardMainRef = useRef<HTMLDivElement>(null);
  const [exportingPDF, setExportingPDF] = useState(false);

  const handleExportPDF = useCallback(async () => {
    const el = dashboardMainRef.current;
    if (!el) { window.print(); return; }
    setExportingPDF(true);
    try {
      const [html2canvas, { default: jsPDF }] = await Promise.all([
        import('html2canvas').then(m => m.default),
        import('jspdf'),
      ]);
      const canvas = await html2canvas(el, {
        scale: 1.5,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        logging: false,
        windowWidth: el.scrollWidth,
        windowHeight: el.scrollHeight,
      });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const pdfW = pdf.internal.pageSize.getWidth();
      const pdfH = pdf.internal.pageSize.getHeight();
      const imgH = pdfW * (canvas.height / canvas.width);
      const pages = Math.ceil(imgH / pdfH);
      for (let i = 0; i < pages; i++) {
        if (i > 0) pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, -(i * pdfH), pdfW, imgH);
      }
      const now = new Date();
      pdf.save(`Dashboard_${now.toISOString().slice(0,10)}.pdf`);
    } catch (err) {
      console.error('PDF export error', err);
      window.print();
    } finally {
      setExportingPDF(false);
    }
  }, []);

  const openRevenueEdit = useCallback(() => {
    const existing = dailyBudgets[refDateStr]?.actualRevenue;
    setPendingRevenue(existing ? String(existing) : '');
    setEditingRevenue(true);
    setTimeout(() => revenueInputRef.current?.focus(), 50);
  }, [dailyBudgets, refDateStr]);

  const saveRevenue = useCallback(() => {
    const amount = parseFloat(pendingRevenue.replace(/[^0-9.]/g, '')) || 0;
    const updated = {
      ...dailyBudgets,
      [refDateStr]: {
        plannedRevenue: dailyBudgets[refDateStr]?.plannedRevenue ?? 0,
        previousYearRevenue: dailyBudgets[refDateStr]?.previousYearRevenue ?? 0,
        ...dailyBudgets[refDateStr],
        actualRevenue: amount,
      },
    };
    localStorage.setItem('dailyBudgets', JSON.stringify(updated));
    import('@/lib/supabase-kv').then(({ kvSet }) => kvSet('dailyBudgets', updated).catch(() => {}));
    setDailyBudgets(updated);
    setEditingRevenue(false);
    setPendingRevenue('');
  }, [dailyBudgets, refDateStr, pendingRevenue]);

  const cancelRevenueEdit = useCallback(() => {
    setEditingRevenue(false);
    setPendingRevenue('');
  }, []);

  // Eingabe schliessen wenn Tag/Periode wechselt
  useEffect(() => {
    setEditingRevenue(false);
    setPendingRevenue('');
  }, [refDateStr, period]);

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

  // Vorjahr-Umsatz: erst 'previousYearRevenue' des aktuellen Datums prüfen,
  // Fallback: 'actualRevenue' vom gleichen Tag im Vorjahr (z.B. 2025-02-15)
  const sumRevenuePrevYear = (days: string[]) =>
    days.reduce((s, d) => {
      const direct = dailyBudgets[d]?.previousYearRevenue ?? 0;
      if (direct > 0) return s + direct;
      const prevYearDate = d.replace(/^(\d{4})/, (_, y) => String(parseInt(y) - 1));
      return s + (dailyBudgets[prevYearDate]?.actualRevenue ?? 0);
    }, 0);

  const revenueMonthDaily    = sumRevenue(monthDays,  'actualRevenue');
  const revenuePlannedMonth  = sumRevenue(monthDays,  'plannedRevenue');

  // Fallback: wenn keine Gastronovi-Tagesdaten, lese Ist-Umsatz aus Reporting-Modul
  const reportingActualRevenue = useMemo(
    () => loadMonth(currentYear, currentMonth).revenueActual ?? 0,
    [currentYear, currentMonth]
  );
  const revenueMonth = revenueMonthDaily > 0 ? revenueMonthDaily : reportingActualRevenue;

  // Fallback Vorjahr: zuerst revenuePreviousYear im aktuellen Datensatz (manuell eingegeben),
  // dann Vorjahres-Ist aus reporting_v1 des Vorjahres
  const reportingPrevYearRevenue = useMemo(() => {
    if (period === 'month') {
      const directPY = loadMonth(currentYear, currentMonth).revenuePreviousYear;
      if (directPY) return directPY;
      return loadMonth(currentYear - 1, currentMonth).revenueActual ?? 0;
    }
    if (period === 'year') {
      const currentYearRecs = loadYear(currentYear);
      const directPYSum = currentYearRecs.reduce((s, m) => s + (m.revenuePreviousYear ?? 0), 0);
      if (directPYSum > 0) return directPYSum;
      return loadYear(currentYear - 1).reduce((s, m) => s + (m.revenueActual ?? 0), 0);
    }
    return 0;
  }, [period, currentYear, currentMonth]);

  // Periodenspezifische Umsatz-Werte
  // Für 'month' nutzen wir denselben Fallback; für today/week nur Tagesdaten
  const revenueActiveDailyRaw = sumRevenue(activeDays, 'actualRevenue');
  const revenueActive = (period === 'month' && revenueActiveDailyRaw === 0)
    ? reportingActualRevenue
    : revenueActiveDailyRaw;
  const revenuePrevYearDailyRaw = sumRevenuePrevYear(activeDays);
  const revenuePrevYearActive = revenuePrevYearDailyRaw > 0
    ? revenuePrevYearDailyRaw
    : reportingPrevYearRevenue;

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

  // ── Buchhaltungs-Personalkosten (aus P&L-Import, 5xxx Konten) ───────────────
  const accountingMonthRecord = useMemo(
    () => loadMonth(currentYear, currentMonth),
    [currentYear, currentMonth]
  );
  const accountingPersonnelCost = useMemo(() => {
    const fromCategories = accountingMonthRecord.expenseCategories
      .filter(cat => {
        const n = parseInt(cat.categoryId);
        return !isNaN(n) && n >= 5000 && n <= 5999;
      })
      .reduce((sum, cat) => sum + (cat.amount ?? 0), 0);
    if (fromCategories > 0) return fromCategories;
    return accountingMonthRecord.personnelCostActual ?? 0;
  }, [accountingMonthRecord]);
  const pkDiff = accountingPersonnelCost > 0 && actualLaborCost > 0
    ? accountingPersonnelCost - actualLaborCost
    : null;
  const pkDiffPct = pkDiff !== null && actualLaborCost > 0
    ? (pkDiff / actualLaborCost) * 100
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

  // Hilfsfunktion: Ratio-Statusfarbe (Budget-Target als Basis)
  const budgetRatioColor = (ratio: number | null, target: number | null): 'green' | 'yellow' | 'red' | 'default' => {
    if (ratio === null || target === null) return 'default';
    if (ratio <= target)     return 'green';
    if (ratio <= target + 5) return 'yellow';
    return 'red';
  };

  // ── Stichtag pro-rata Berechnungen ───────────────────────────────────────────
  // Gilt der Stichtag für den aktuell angezeigten Monat?
  const stichtagInMonth = stichtagActive
    && stichtagYear === currentYear
    && stichtagMonth === currentMonth;

  const stichtagDateStr = stichtagInMonth && stichtag
    ? format(stichtag as Date, 'yyyy-MM-dd')
    : null;

  const daysUpToStichtag = stichtagDateStr
    ? monthDays.filter(d => d <= stichtagDateStr)
    : [];

  // Budget pro-rata per Stichtag (= Anteil am Monatsbudget)
  const budgetProRataStichtag = stichtagInMonth && stichtagDay && budgetData.revenueBudget > 0
    ? Math.round(budgetData.revenueBudget * stichtagDay / daysInRefMonth)
    : null;

  const personnelBudgetProRata = stichtagInMonth && stichtagDay && budgetData.personnelBudget > 0
    ? Math.round(budgetData.personnelBudget * stichtagDay / daysInRefMonth)
    : null;

  // Ist-Umsatz bis Stichtag
  const revenueIstStichtag = stichtagDateStr
    ? sumRevenue(daysUpToStichtag, 'actualRevenue')
    : null;

  // Vorjahr bis Stichtag
  const revenuePrevYearStichtag = stichtagDateStr
    ? sumRevenuePrevYear(daysUpToStichtag)
    : null;

  // Personalkosten bis Stichtag (aus Ist-Stunden × Stundenlohn)
  const actualLaborCostStichtag = useMemo(() => {
    if (!stichtagDateStr) return null;
    const set = new Set(daysUpToStichtag);
    return visibleEmployees.reduce((sum, emp) => {
      const hrs = Object.entries(actualData)
        .filter(([key]) => {
          const date = key.slice(-10);
          const empId = key.slice(0, key.length - 11);
          return empId === emp.id && set.has(date);
        })
        .reduce((s, [, e]) => s + e.hours, 0);
      return sum + hrs * emp.hourlyWage;
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEmployees, actualData, stichtagDateStr]);

  // ── Effektiver Stichtag: letzter Tag mit Ist-Umsatz (oder expliziter Stichtag) ──
  // Für den "zweiten Budget pro rata"-Vergleich
  const lastRevenueDay = monthDays.reduce<string | null>((last, d) => {
    return (dailyBudgets[d]?.actualRevenue ?? 0) > 0 ? d : last;
  }, null);

  // Wir bevorzugen den expliziten Stichtag (wenn im aktuellen Monat), sonst letzten Ist-Tag
  const effectiveCutoff = stichtagDateStr ?? lastRevenueDay;
  const effectiveDayNum = effectiveCutoff ? parseInt(effectiveCutoff.slice(-2), 10) : null;
  const effectiveDays   = effectiveCutoff ? monthDays.filter(d => d <= effectiveCutoff) : [];

  const budgetEffective = effectiveDayNum && budgetData.revenueBudget > 0
    ? Math.round(budgetData.revenueBudget * effectiveDayNum / daysInRefMonth)
    : null;

  const revenueIstEffective = effectiveCutoff
    ? sumRevenue(effectiveDays, 'actualRevenue')
    : null;

  const revEffectiveVsBudgetAbs = budgetEffective !== null && revenueIstEffective !== null
    ? revenueIstEffective - budgetEffective
    : null;

  const revEffectiveVsBudgetPct = budgetEffective && revenueIstEffective !== null && budgetEffective > 0
    ? ((revenueIstEffective - budgetEffective) / budgetEffective) * 100
    : null;

  const effectiveCutoffLabel = effectiveCutoff
    ? format(new Date(effectiveCutoff), 'd. MMM', { locale: de })
    : null;

  // ── Personalkosten pro rata (bis effectiveCutoff) ───────────────────────────
  const personnelBudgetEffective = effectiveDayNum && budgetData.personnelBudget > 0
    ? Math.round(budgetData.personnelBudget * effectiveDayNum / daysInRefMonth)
    : null;

  const actualLaborCostEffective = useMemo(() => {
    if (!effectiveCutoff || effectiveDays.length === 0) return null;
    const daySet = new Set(effectiveDays);
    return visibleEmployees.reduce((sum, emp) => {
      const hrs = Object.entries(actualData)
        .filter(([key]) => {
          const date  = key.slice(-10);
          const empId = key.slice(0, key.length - 11);
          return empId === emp.id && daySet.has(date);
        })
        .reduce((s, [, e]) => s + e.hours, 0);
      return sum + hrs * emp.hourlyWage;
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEmployees, actualData, effectiveCutoff]);

  const plannedLaborCostEffective = useMemo(() => {
    if (!effectiveCutoff || !effectiveDayNum || effectiveDays.length === 0) return null;
    const daySet = new Set(effectiveDays);
    return visibleEmployees.reduce((sum, emp) => {
      if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
        return sum + emp.monthlySalary * effectiveDayNum / daysInRefMonth;
      }
      const hrs = Object.entries(scheduleData)
        .filter(([key]) => {
          const date  = key.slice(-10);
          const empId = key.slice(0, key.length - 11);
          return empId === emp.id && daySet.has(date);
        })
        .reduce((s, [, day]) => s + calcDayHours(day), 0);
      return sum + hrs * emp.hourlyWage;
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEmployees, scheduleData, effectiveCutoff, effectiveDayNum, daysInRefMonth]);

  // Vorjahr pro rata: gleicher Cutoff-Tag, aber Vorjahresdaten
  // Fallback-Kette: 1. Tagesdaten Vorjahr (dailyBudgets), 2. Monatswert aus reporting_v1 pro rata
  const prevYearEffective = (() => {
    const daily = effectiveDays.length > 0 ? sumRevenuePrevYear(effectiveDays) : 0;
    if (daily > 0) return daily;
    if (effectiveDayNum && reportingPrevYearRevenue > 0) {
      return Math.round(reportingPrevYearRevenue * effectiveDayNum / daysInRefMonth);
    }
    return 0;
  })();
  const istVsPrevYearPct = prevYearEffective > 0 && revenueIstEffective !== null
    ? ((revenueIstEffective - prevYearEffective) / prevYearEffective) * 100
    : null;
  const istVsPrevYearAbs = prevYearEffective > 0 && revenueIstEffective !== null
    ? revenueIstEffective - prevYearEffective
    : null;

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
            <div className="flex items-center gap-1.5 flex-wrap">
              {/* Perioden-Typ */}
              <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
                {(['today', 'week', 'month', 'year'] as Period[]).map(p => (
                  <button
                    key={p}
                    onClick={() => { setPeriod(p); setReferenceDate(new Date()); }}
                    className={cn(
                      'px-2 sm:px-3 py-1 text-xs font-medium rounded-md transition-all',
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
                <>
                  <GuestLinkGenerator />
                  <Link to="/import">
                    <Button variant="outline" size="sm" className="h-8">
                      <Upload className="h-3.5 w-3.5 mr-1.5" />
                      <span className="hidden sm:inline">Import</span>
                    </Button>
                  </Link>
                </>
              )}
              <Link to="/personal">
                <Button variant="outline" size="sm" className="h-8">
                  <Calendar className="h-3.5 w-3.5 mr-1.5" />
                  Dienstplan
                </Button>
              </Link>
              <Button
                variant="outline" size="sm"
                className="h-8 print:hidden"
                onClick={handleExportPDF}
                disabled={exportingPDF}
                title="Dashboard als PDF speichern (mit Farben & Charts)"
              >
                {exportingPDF ? (
                  <span className="h-3.5 w-3.5 mr-1.5 inline-block animate-spin border-2 border-current border-t-transparent rounded-full" />
                ) : (
                  <Printer className="h-3.5 w-3.5 mr-1.5" />
                )}
                <span className="hidden sm:inline">{exportingPDF ? 'PDF…' : 'PDF'}</span>
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main ref={dashboardMainRef} className="max-w-6xl mx-auto px-4 py-6 pb-24 space-y-2">

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

                {/* ── Schnelleingabe Tagesumsatz ─────────────────────────────── */}
                {period === 'today' && (
                  <Card className={cn(
                    'border-l-4 transition-all',
                    revenueActive > 0
                      ? 'border-l-green-400 dark:border-l-green-600 bg-green-50/30 dark:bg-green-950/10'
                      : 'border-l-blue-400 dark:border-l-blue-600 bg-blue-50/30 dark:bg-blue-950/10',
                  )}>
                    <CardContent className="p-3">
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-2 min-w-0">
                          <Pencil className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Tagesumsatz
                          </span>
                          <span className="text-xs text-muted-foreground hidden sm:inline">
                            · {format(referenceDate, 'EEEE, d. MMMM', { locale: de })}
                          </span>
                        </div>

                        {editingRevenue ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium text-muted-foreground">CHF</span>
                            <input
                              ref={revenueInputRef}
                              type="number"
                              value={pendingRevenue}
                              onChange={e => setPendingRevenue(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveRevenue();
                                if (e.key === 'Escape') cancelRevenueEdit();
                              }}
                              className="w-36 px-2 py-1 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 tabular-nums"
                              placeholder="0"
                              min="0"
                              step="100"
                            />
                            <button
                              onClick={saveRevenue}
                              className="p-1.5 rounded-md bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-950/40 dark:text-green-400 transition-colors"
                              title="Speichern (Enter)"
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={cancelRevenueEdit}
                              className="p-1.5 rounded-md bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
                              title="Abbrechen (Esc)"
                            >
                              <XIcon className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={openRevenueEdit}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border bg-background hover:bg-muted transition-colors group"
                          >
                            {revenueActive > 0 ? (
                              <>
                                <span className="text-sm font-bold tabular-nums">{formatCHF(revenueActive)}</span>
                                <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                              </>
                            ) : (
                              <>
                                <span className="text-sm text-muted-foreground">Umsatz eingeben…</span>
                                <Pencil className="h-3 w-3 text-muted-foreground" />
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}

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
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
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
                      <KpiCard
                        title="Budget Umsatz"
                        value={formatCHF(budgetData.revenueBudget)}
                        subtitle={`Monatsbudget ${currentYear}`}
                        icon={<BookOpen className="h-5 w-5" />}
                        color="blue"
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
                    </div>

                    {/* ── Pro-rata Vergleich (nur wenn KEIN Stichtag gesetzt): bis letztem Ist-Tag ── */}
                    {!stichtagInMonth && budgetEffective !== null && effectiveCutoffLabel && (
                      <div className="mt-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                          <CalendarDays className="h-3.5 w-3.5" />
                          Pro rata bis {effectiveCutoffLabel} (letzter Ist-Tag)
                        </p>
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                          {/* 1. IST Umsatz – zuerst links */}
                          <KpiCard
                            title="Ist Umsatz"
                            value={revenueIstEffective !== null && revenueIstEffective > 0
                              ? formatCHF(revenueIstEffective) : '–'}
                            subtitle={`bis ${effectiveCutoffLabel}`}
                            icon={<TrendingUp className="h-5 w-5" />}
                            color={
                              revEffectiveVsBudgetPct === null ? 'default' :
                              revEffectiveVsBudgetPct >= 0 ? 'green' : 'red'
                            }
                            delta={revEffectiveVsBudgetPct}
                            deltaLabel="% vs. Budget p.r."
                            small
                          />
                          {/* 2. Budget pro rata */}
                          <KpiCard
                            title="Budget pro rata"
                            value={formatCHF(budgetEffective)}
                            subtitle={`${effectiveDayNum} von ${daysInRefMonth} Tagen`}
                            icon={<CalendarDays className="h-5 w-5" />}
                            color="blue"
                            small
                          />
                          {/* 3. Vorjahr pro rata (immer anzeigen, auch wenn 0) */}
                          <KpiCard
                            title="Vorjahr p.r."
                            value={prevYearEffective > 0 ? formatCHF(prevYearEffective) : '–'}
                            subtitle={`Vorjahr bis ${effectiveCutoffLabel}`}
                            icon={<TrendingUp className="h-5 w-5" />}
                            color={
                              istVsPrevYearPct === null ? 'default' :
                              istVsPrevYearPct >= 0 ? 'green' : 'red'
                            }
                            delta={istVsPrevYearPct}
                            deltaLabel="% Ist vs. VJ"
                            small
                          />
                          {/* 4. Abweichung IST vs. Vorjahr */}
                          {istVsPrevYearAbs !== null && (
                            <KpiCard
                              title="Abw. Ist vs. VJ p.r."
                              value={`${istVsPrevYearAbs >= 0 ? '+' : ''}${formatCHF(istVsPrevYearAbs)}`}
                              subtitle={`Ist vs. Vorjahr pro rata · ${istVsPrevYearAbs >= 0 ? 'über Vorjahr' : 'unter Vorjahr'}`}
                              icon={istVsPrevYearAbs >= 0
                                ? <TrendingUp className="h-5 w-5" />
                                : <TrendingDown className="h-5 w-5" />}
                              color={istVsPrevYearAbs >= 0 ? 'green' : 'red'}
                              badge={istVsPrevYearAbs >= 0 ? '✓ Über Vorjahr' : '↓ Unter Vorjahr'}
                              badgeColor={
                                istVsPrevYearAbs >= 0
                                  ? 'bg-green-50 text-green-700 border-green-300 dark:bg-green-950/30'
                                  : 'bg-red-50 text-red-700 border-red-300 dark:bg-red-950/30'
                              }
                              small
                            />
                          )}
                        </div>
                      </div>
                    )}

                    {/* ── Stichtag-Vergleich (nur wenn Stichtag im aktuellen Monat gesetzt) ── */}
                    {stichtagInMonth && budgetProRataStichtag !== null && (
                      <div className="mt-4 rounded-lg border border-border bg-muted/20 p-4">
                        {/* Abschnitts-Header */}
                        <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border">
                          <CalendarDays className="h-4 w-4 text-primary flex-shrink-0" />
                          <div>
                            <p className="text-sm font-semibold text-foreground">
                              Pro-rata-Vergleich per Stichtag {stichtagFormatted}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Basis: {stichtagDay} von {daysInRefMonth} Tagen
                              ({((stichtagDay! / daysInRefMonth) * 100).toFixed(0)} % des Monats)
                            </p>
                          </div>
                        </div>

                        {/* Zeile 1: vs. Vorjahr (zuerst) */}
                        {revenuePrevYearStichtag !== null && revenuePrevYearStichtag > 0 && revenueIstStichtag !== null && (
                          <>
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                              Umsatz vs. Vorjahr pro rata
                            </p>
                            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
                              <KpiCard
                                title="Ist Umsatz"
                                value={revenueIstStichtag > 0 ? formatCHF(revenueIstStichtag) : '–'}
                                subtitle={`bis ${stichtagFormatted}`}
                                icon={<TrendingUp className="h-5 w-5" />}
                                color={(revenueIstStichtag - revenuePrevYearStichtag) >= 0 ? 'green' : 'red'}
                                small
                              />
                              <KpiCard
                                title="Vorjahr bis Stichtag"
                                value={formatCHF(revenuePrevYearStichtag)}
                                subtitle={`Vorjahr bis ${stichtagFormatted}`}
                                icon={<TrendingUp className="h-5 w-5" />}
                                color="default"
                                small
                              />
                              <KpiCard
                                title="Abw. vs. Vorjahr"
                                value={`${(revenueIstStichtag - revenuePrevYearStichtag) >= 0 ? '+' : ''}${formatCHF(revenueIstStichtag - revenuePrevYearStichtag)}`}
                                subtitle={`Ist vs. Vorjahr · ${revenuePrevYearStichtag > 0
                                  ? `${(((revenueIstStichtag - revenuePrevYearStichtag) / revenuePrevYearStichtag) * 100).toFixed(1)} %`
                                  : '–'}`}
                                icon={(revenueIstStichtag - revenuePrevYearStichtag) >= 0
                                  ? <TrendingUp className="h-5 w-5" />
                                  : <TrendingDown className="h-5 w-5" />}
                                color={(revenueIstStichtag - revenuePrevYearStichtag) >= 0 ? 'green' : 'red'}
                                badge={(revenueIstStichtag - revenuePrevYearStichtag) >= 0 ? '✓ Über Vorjahr' : '↓ Unter Vorjahr'}
                                badgeColor={(revenueIstStichtag - revenuePrevYearStichtag) >= 0
                                  ? 'bg-green-50 text-green-700 border-green-300 dark:bg-green-950/30'
                                  : 'bg-red-50 text-red-700 border-red-300 dark:bg-red-950/30'}
                                small
                              />
                            </div>
                          </>
                        )}

                        {/* Zeile 2: vs. Budget */}
                        {revenueIstStichtag !== null && (
                          <>
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                              Umsatz vs. Budget pro rata
                            </p>
                            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                              <KpiCard
                                title="Ist Umsatz"
                                value={revenueIstStichtag > 0 ? formatCHF(revenueIstStichtag) : '–'}
                                subtitle={`bis ${stichtagFormatted}`}
                                icon={<TrendingUp className="h-5 w-5" />}
                                color={revenueIstStichtag >= budgetProRataStichtag ? 'green' : 'red'}
                                small
                              />
                              <KpiCard
                                title="Budget pro rata"
                                value={formatCHF(budgetProRataStichtag)}
                                subtitle={`Monatsbudget × ${stichtagDay}/${daysInRefMonth}`}
                                icon={<CalendarDays className="h-5 w-5" />}
                                color="blue"
                                small
                              />
                              <KpiCard
                                title="Abw. vs. Budget p.r."
                                value={`${(revenueIstStichtag - budgetProRataStichtag) >= 0 ? '+' : ''}${formatCHF(revenueIstStichtag - budgetProRataStichtag)}`}
                                subtitle={`Ist vs. Budget pro rata · ${budgetProRataStichtag > 0
                                  ? `${(((revenueIstStichtag - budgetProRataStichtag) / budgetProRataStichtag) * 100).toFixed(1)} %`
                                  : '–'}`}
                                icon={(revenueIstStichtag - budgetProRataStichtag) >= 0
                                  ? <TrendingUp className="h-5 w-5" />
                                  : <TrendingDown className="h-5 w-5" />}
                                color={(revenueIstStichtag - budgetProRataStichtag) >= 0 ? 'green' : 'red'}
                                badge={(revenueIstStichtag - budgetProRataStichtag) >= 0 ? '✓ Über Budget' : '↓ Unter Budget'}
                                badgeColor={(revenueIstStichtag - budgetProRataStichtag) >= 0
                                  ? 'bg-green-50 text-green-700 border-green-300 dark:bg-green-950/30'
                                  : 'bg-red-50 text-red-700 border-red-300 dark:bg-red-950/30'}
                                small
                              />
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* Personalkosten: Ist vs. Plan vs. Budget */}
                {canSeePersonnelCostTotals && budgetData.personnelBudget > 0 && (
                  <div className="mt-3">
                    {/* Zeile 1: Dreiweg-Vergleich Ist · Plan · Budget */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      {actualLaborCost > 0 && (
                        <KpiCard
                          title="Ist Personalkosten"
                          value={formatCHF(actualLaborCost)}
                          subtitle={actualCostRatio !== null
                            ? `${actualCostRatio.toFixed(1)} % v. Ist-Umsatz`
                            : 'Effektive Kosten'}
                          icon={<Users className="h-5 w-5" />}
                          color={laborVsBudgetAbs !== null && laborVsBudgetAbs <= 0 ? 'green' : 'red'}
                          delta={laborVsBudgetPct}
                          deltaLabel="% vs. Budget"
                        />
                      )}
                      {plannedLaborCost > 0 && (
                        <KpiCard
                          title="Plan-Kosten"
                          value={formatCHF(plannedLaborCost)}
                          subtitle="Aus Dienstplanung"
                          icon={<CalendarDays className="h-5 w-5" />}
                          color="default"
                          delta={actualLaborCost > 0 && plannedLaborCost > 0
                            ? ((actualLaborCost - plannedLaborCost) / plannedLaborCost) * 100
                            : null}
                          deltaLabel="% Ist vs. Plan"
                        />
                      )}
                      <KpiCard
                        title="Budget Personalkosten"
                        value={formatCHF(budgetData.personnelBudget)}
                        subtitle="Aus Jahresplanung"
                        icon={<BookOpen className="h-5 w-5" />}
                        color="blue"
                      />
                      {actualRatioVsBudgetRevenue !== null && budgetData.personnelRatioTarget !== null && (
                        <KpiCard
                          title="Ist-Quote vs. Ziel"
                          value={`${actualCostRatio !== null ? actualCostRatio.toFixed(1) : actualRatioVsBudgetRevenue.toFixed(1)} %`}
                          subtitle={`Ziel: ≤ ${budgetData.personnelRatioTarget.toFixed(1)} % v. Umsatz`}
                          icon={<Target className="h-5 w-5" />}
                          color={budgetRatioColor(
                            actualCostRatio ?? actualRatioVsBudgetRevenue,
                            budgetData.personnelRatioTarget,
                          )}
                          badge={
                            (actualCostRatio ?? actualRatioVsBudgetRevenue) <= budgetData.personnelRatioTarget
                              ? '✓ Im Ziel'
                              : (actualCostRatio ?? actualRatioVsBudgetRevenue) <= budgetData.personnelRatioTarget + 5
                              ? '~ Grenzwertig'
                              : '↑ Über Ziel'
                          }
                          badgeColor={
                            (actualCostRatio ?? actualRatioVsBudgetRevenue) <= budgetData.personnelRatioTarget
                              ? 'bg-green-50 text-green-700 border-green-300 dark:bg-green-950/30'
                              : (actualCostRatio ?? actualRatioVsBudgetRevenue) <= budgetData.personnelRatioTarget + 5
                              ? 'bg-yellow-50 text-yellow-700 border-yellow-300 dark:bg-yellow-950/30'
                              : 'bg-red-50 text-red-700 border-red-300 dark:bg-red-950/30'
                          }
                        />
                      )}
                    </div>
                  </div>
                )}

                {/* Personalkosten Stichtag-Vergleich */}
                {canSeePersonnelCostTotals && stichtagInMonth && personnelBudgetProRata !== null && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5" />
                      Personalkosten bis Stichtag {stichtagFormatted}
                    </p>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <KpiCard
                        title="Budget pro rata"
                        value={formatCHF(personnelBudgetProRata)}
                        subtitle={`${stichtagDay} / ${daysInRefMonth} Tage`}
                        icon={<BookOpen className="h-5 w-5" />}
                        color="blue"
                        small
                      />
                      {actualLaborCostStichtag !== null && actualLaborCostStichtag > 0 && (
                        <KpiCard
                          title="Ist Personalkosten"
                          value={formatCHF(actualLaborCostStichtag)}
                          subtitle={revenueIstStichtag && revenueIstStichtag > 0
                            ? `${((actualLaborCostStichtag / revenueIstStichtag) * 100).toFixed(1)} % v. Ist-Umsatz`
                            : `bis ${stichtagFormatted}`}
                          icon={<Users className="h-5 w-5" />}
                          color={actualLaborCostStichtag <= personnelBudgetProRata ? 'green' : 'red'}
                          delta={personnelBudgetProRata > 0
                            ? ((actualLaborCostStichtag - personnelBudgetProRata) / personnelBudgetProRata) * 100
                            : null}
                          deltaLabel="% vs. Budget p.r."
                          small
                        />
                      )}
                      {revenueIstStichtag !== null && revenueIstStichtag > 0 && actualLaborCostStichtag !== null && actualLaborCostStichtag > 0 && (
                        <KpiCard
                          title="Ist-Quote bis Stichtag"
                          value={`${((actualLaborCostStichtag / revenueIstStichtag) * 100).toFixed(1)} %`}
                          subtitle="Personalkosten / Umsatz"
                          icon={<Target className="h-5 w-5" />}
                          color={budgetData.personnelRatioTarget !== null
                            ? budgetRatioColor(
                                (actualLaborCostStichtag / revenueIstStichtag) * 100,
                                budgetData.personnelRatioTarget,
                              )
                            : 'default'}
                          small
                        />
                      )}
                    </div>
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

                {/* Pro-Rata-Vergleich bis effektivem Stichtag */}
                {period === 'month' && effectiveCutoffLabel && (
                  personnelBudgetEffective !== null || actualLaborCostEffective !== null
                ) && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                      <TrendingUp className="h-3.5 w-3.5" />
                      Personalkosten pro rata · bis {effectiveCutoffLabel}
                      <span className="normal-case font-normal ml-1">({effectiveDayNum} / {daysInRefMonth} Tage)</span>
                    </p>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      {plannedLaborCostEffective !== null && plannedLaborCostEffective > 0 && (
                        <KpiCard
                          title="Plan pro rata"
                          value={formatCHF(plannedLaborCostEffective)}
                          subtitle="Aus Dienstplanung"
                          icon={<Users className="h-5 w-5" />}
                          color="blue"
                          small
                        />
                      )}
                      {actualLaborCostEffective !== null && actualLaborCostEffective > 0 && (
                        <KpiCard
                          title="Ist pro rata"
                          value={formatCHF(actualLaborCostEffective)}
                          subtitle={plannedLaborCostEffective && plannedLaborCostEffective > 0
                            ? `${actualLaborCostEffective <= plannedLaborCostEffective ? '✓' : '↑'} vs. Plan p.r.`
                            : `bis ${effectiveCutoffLabel}`}
                          icon={<Users className="h-5 w-5" />}
                          color={plannedLaborCostEffective && plannedLaborCostEffective > 0
                            ? actualLaborCostEffective <= plannedLaborCostEffective ? 'green' : 'red'
                            : 'default'}
                          delta={plannedLaborCostEffective && plannedLaborCostEffective > 0
                            ? actualLaborCostEffective - plannedLaborCostEffective
                            : null}
                          deltaLabel="CHF vs. Plan"
                          small
                        />
                      )}
                      {personnelBudgetEffective !== null && (
                        <KpiCard
                          title="Budget pro rata"
                          value={formatCHF(personnelBudgetEffective)}
                          subtitle={`${effectiveDayNum} / ${daysInRefMonth} Tage`}
                          icon={<BookOpen className="h-5 w-5" />}
                          color={actualLaborCostEffective !== null && actualLaborCostEffective > 0
                            ? actualLaborCostEffective <= personnelBudgetEffective ? 'green' : 'red'
                            : 'blue'}
                          delta={actualLaborCostEffective !== null && actualLaborCostEffective > 0
                            ? ((actualLaborCostEffective - personnelBudgetEffective) / personnelBudgetEffective) * 100
                            : null}
                          deltaLabel="% Ist vs. Budget"
                          small
                        />
                      )}
                      {actualLaborCostEffective !== null && actualLaborCostEffective > 0 && revenueIstEffective !== null && revenueIstEffective > 0 && (
                        <KpiCard
                          title="PKQ pro rata"
                          value={`${((actualLaborCostEffective / revenueIstEffective) * 100).toFixed(1)} %`}
                          subtitle="Ist-Kosten / Ist-Umsatz p.r."
                          icon={<Target className="h-5 w-5" />}
                          color={budgetData.personnelRatioTarget !== null
                            ? budgetRatioColor(
                                (actualLaborCostEffective / revenueIstEffective) * 100,
                                budgetData.personnelRatioTarget,
                              )
                            : ratioStatus((actualLaborCostEffective / revenueIstEffective) * 100) === 'good' ? 'green'
                            : ratioStatus((actualLaborCostEffective / revenueIstEffective) * 100) === 'ok' ? 'yellow'
                            : 'red'}
                          small
                        />
                      )}
                    </div>
                  </div>
                )}
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

            {/* ── Personalkosten-Vergleich: Dienstplan vs. Buchhaltung ─────── */}
            {canSeePersonnelCostTotals && (actualLaborCost > 0 || accountingPersonnelCost > 0) && (
              <>
                <SectionTitle icon={<Scale className="h-4 w-4" />}>
                  Personalkosten-Vergleich · {monthName}
                </SectionTitle>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <KpiCard
                    title="Ist-Dienstplan"
                    value={actualLaborCost > 0 ? formatCHF(actualLaborCost) : '–'}
                    subtitle="Aus Ist-Stunden × Lohn"
                    icon={<Users className="h-5 w-5" />}
                    color="blue"
                  />
                  <KpiCard
                    title="Buchhaltung Ist"
                    value={accountingPersonnelCost > 0 ? formatCHF(accountingPersonnelCost) : '–'}
                    subtitle="Total Personalaufwand (5xxx)"
                    icon={<BookOpen className="h-5 w-5" />}
                    color={accountingPersonnelCost > 0 ? 'default' : 'default'}
                  />
                  {pkDiff !== null && (
                    <KpiCard
                      title="Abweichung CHF"
                      value={`${pkDiff >= 0 ? '+' : ''}${formatCHF(pkDiff)}`}
                      subtitle="Buchhaltung − Dienstplan"
                      icon={pkDiff >= 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
                      color={Math.abs(pkDiff) / Math.max(actualLaborCost, 1) < 0.05 ? 'green' : Math.abs(pkDiff) / Math.max(actualLaborCost, 1) < 0.15 ? 'yellow' : 'red'}
                    />
                  )}
                  {pkDiffPct !== null && (
                    <KpiCard
                      title="Abweichung %"
                      value={`${pkDiffPct >= 0 ? '+' : ''}${pkDiffPct.toFixed(1)} %`}
                      subtitle="Relativ zum Dienstplan"
                      icon={<TrendingUp className="h-5 w-5" />}
                      color={Math.abs(pkDiffPct) < 5 ? 'green' : Math.abs(pkDiffPct) < 15 ? 'yellow' : 'red'}
                    />
                  )}
                  {accountingPersonnelCost === 0 && actualLaborCost > 0 && (
                    <div className="col-span-2 lg:col-span-2 flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3">
                      <BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                      <p className="text-xs text-muted-foreground">
                        Kein Buchhaltungsimport für {monthName} vorhanden. Importiere die Sage-Kontoblatt-Datei unter «Reporting», um den Vergleich zu aktivieren.
                      </p>
                    </div>
                  )}
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
