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
  Pencil, Check, X as XIcon, Scale, Printer, DollarSign,
  UserX, Palmtree, Stethoscope,
} from 'lucide-react';
import {
  computeAbsenceEvents, resolveAbsenceEvent, summarizeAbsences,
  loadAbsenceOverrides,
} from '@/lib/absence-utils';
import { cn } from '@/lib/utils';
import { useMaison } from '@/contexts/MaisonContext';
import { getMaisonEnabledSync, getMaisonDailySync, loadMaisonDaily } from '@/lib/maison-store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import { GuestLinkGenerator } from '@/components/GuestLinkGenerator';
import { useBudgetMonth } from '@/hooks/useBudgetMonth';
import { getDailyBudgetMap } from '@/lib/budget-day';
import { loadMonth, calcAnnualSummary } from '@/lib/reporting-store';
import {
  loadEmployees,
  loadScheduleForMonth,
  loadActualHoursForMonth,
  DaySchedule,
  ActualHourEntry,
} from '@/lib/supabase-db';
import { Employee, grossToNet } from '@/types/personnel';
import { isEmployeeActiveInMonth } from '@/lib/personnel-utils';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { getEffectiveHourlyRate } from '@/lib/employee-rate';
import { socialCostFactorFromRates } from '@/lib/social-costs';
import { useStichtag } from '@/contexts/StichtagContext';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';
import { StichtagBanner } from '@/components/StichtagBanner';
import { HeuteWichtigBanner } from '@/components/HeuteWichtigBanner';
import { WesMarginWidget } from '@/components/WesMarginWidget';
import { resolveZielwert } from '@/lib/zielwerte-store';
import { kvGet } from '@/lib/supabase-kv';
import { computeMonthlyIstNet } from '@/lib/revenue-sync';
import { buildFinancialMetricInput } from '@/lib/financial-metrics-input';
import { getFinancialMetricValues } from '@/lib/financial-metrics';
import { loadVjDailyYear, type VjDayRecord } from '@/lib/vj-daily-supabase';

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
  takeawayRevenue?: number;
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

type DashView = 'alle' | 'umsatz' | 'personal' | 'budget' | 'vorjahr';

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
  const { showNetRevenue } = useRevenueDisplay();
  const { rates: socialCostRates } = useSocialCostRates();
  const { tenantId, tenantKey } = useTenant();
  const { maisonExclude } = useMaison();
  const maisonOn = getMaisonEnabledSync(tenantKey);
  const [maisonDaily, setMaisonDaily] = useState<Record<string, number>>(() => getMaisonDailySync(tenantKey));
  useEffect(() => { loadMaisonDaily(tenantKey).then(setMaisonDaily); }, [tenantKey]);

  const deptLabel = allowedDepartment === 'service' ? 'Service'
    : allowedDepartment === 'küche' ? 'Küche'
    : 'Gesamt';
  const deptIcon = allowedDepartment === 'service' ? <Utensils className="h-4 w-4" />
    : allowedDepartment === 'küche' ? <ChefHat className="h-4 w-4" />
    : <Users className="h-4 w-4" />;

  // ── Dashboard-Ansicht ───────────────────────────────────────────────────────
  const [dashView, setDashView] = useState<DashView>('alle');

  // ── Rohdaten ────────────────────────────────────────────────────────────────
  const [employees, setEmployees]       = useState<Employee[]>([]);
  const [scheduleData, setScheduleData] = useState<Record<string, DaySchedule>>({});
  const [actualData, setActualData]     = useState<Record<string, ActualHourEntry>>({});
  const [loading, setLoading]           = useState(true);

  useEffect(() => {
    const load = async () => {
      // Pass tenantId so only the correct tenant's employees are loaded
      const [emps, sched, actual] = await Promise.all([
        loadEmployees(tenantId),
        loadScheduleForMonth(referenceDate, tenantId),
        loadActualHoursForMonth(referenceDate, tenantId),
      ]);
      if (emps)   setEmployees(emps);
      if (sched)  setScheduleData(sched);
      if (actual) setActualData(actual);
      setLoading(false);
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey, tenantId]);

  // DailyBudgets aus localStorage (Umsatz-Daten) — schreibbar für Schnelleingabe
  const [dailyBudgets, setDailyBudgets] = useState<Record<string, DailyBudget>>(() => {
    try { return JSON.parse(localStorage.getItem(tenantKey('dailyBudgets')) || '{}'); }
    catch { return {}; }
  });

  // Tick-Zähler: wird hochgezählt wenn Supabase→localStorage-Sync 'reporting_v1' aktualisiert hat.
  // Dadurch re-berechnen alle useMemos die loadMonth/loadYear nutzen – auch nach dem Sync.
  const [reportingTick, setReportingTick] = useState(0);

  // Mandantenwechsel: dailyBudgets + reportingTick neu laden
  useEffect(() => {
    console.log(`[TENANT] Dashboard: Mandant gewechselt → "${tenantId}", dailyBudgets neu laden`);
    try {
      const storageKey = tenantKey('dailyBudgets');
      const data = JSON.parse(localStorage.getItem(storageKey) || '{}') as Record<string, { actualRevenue?: number }>;
      setDailyBudgets(data);
      if (tenantId === 'beaulieu') {
        const revenueEntries = Object.entries(data).filter(([, v]) => (v?.actualRevenue ?? 0) > 0);
        const latestDate = revenueEntries.map(([k]) => k).sort().at(-1) ?? 'none';
        console.log(`[REVENUE-CHECK] tenant: ${tenantId}`);
        console.log(`[REVENUE-CHECK] rows loaded: ${revenueEntries.length}`);
        console.log(`[REVENUE-CHECK] visible in dashboard: ${revenueEntries.length > 0 ? 'yes' : 'no'}`);
        console.log(`[REVENUE-CHECK] latest date: ${latestDate}`);
        console.log(`[REVENUE-CHECK] mismatch: ${revenueEntries.length === 0 ? 'yes – keine Ist-Umsätze' : 'no – Daten vorhanden'}`);
      }
    } catch { /* ignore */ }
    setReportingTick(t => t + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // Nach Supabase-Sync dailyBudgets + reporting_v1 neu laden
  useEffect(() => {
    const handler = () => {
      try {
        const data = JSON.parse(localStorage.getItem(tenantKey('dailyBudgets')) || '{}');
        setDailyBudgets(data);
      } catch { /* ignore */ }

      try {
        const raw = localStorage.getItem(tenantKey('reporting_v1')) ?? '{}';
        const obj = JSON.parse(raw) as Record<string, { revenuePreviousYear?: number; revenueActual?: number }>;
        const months = Object.keys(obj);
        const pyMonths = Object.values(obj).filter(m => (m?.revenuePreviousYear ?? 0) > 0).length;
        console.log('[DASH] store-synced – reporting_v1 neu geladen',
          { totalMonths: months.length, monthsWithPY: pyMonths });
      } catch { /* ignore */ }

      setReportingTick(t => t + 1);
    };
    window.addEventListener('store-synced', handler);
    return () => window.removeEventListener('store-synced', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

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
    // Optimistisches UI-Update sofort
    const optimistic = {
      ...dailyBudgets,
      [refDateStr]: { ...dailyBudgets[refDateStr], actualRevenue: amount },
    };
    setDailyBudgets(optimistic);
    setEditingRevenue(false);
    setPendingRevenue('');
    // Sicherer Upsert: KV (Master) lesen → mergen → zurückschreiben
    import('@/lib/supabase-kv').then(({ safeUpsertDailyBudgets }) => {
      safeUpsertDailyBudgets(
        tenantKey('dailyBudgets'),
        { [refDateStr]: { actualRevenue: amount } },
        false,
      ).then(merged => {
        setDailyBudgets(merged as typeof dailyBudgets);
      }).catch(() => {});
    });
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

  // ── Budget-Daten (aus Budget-Modul, budget_v1) ───────────────────────────────
  const currentYear  = referenceDate.getFullYear();
  const currentMonth = referenceDate.getMonth() + 1;

  // ── Monatliches Take-Away (Kto. 3010 Netto) – für Umsatz-Korrektur ──────────
  // Wird unabhängig von der gewählten Periode geladen, damit die monatlichen
  // Finanzkarten (Registry) und revenueMonthB in allen Perioden identisch sind.
  const [monthlyTakeaway, setMonthlyTakeaway] = useState(0);
  useEffect(() => {
    const mm = String(currentMonth).padStart(2, '0');
    kvGet(tenantKey(`takeaway-monthly-${currentYear}`)).then(raw => {
      const val = (raw as Record<string, number> | null)?.[`${currentYear}-${mm}`] ?? 0;
      setMonthlyTakeaway(val);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentYear, currentMonth, tenantId]);

  const laborCostThreshold = resolveZielwert(currentYear, currentMonth).targetPercent;
  const budgetData   = useBudgetMonth(currentYear, currentMonth);

  // ── VJ-Tagesumsätze (Vorjahr) — für die VJ-Spalte der Finanzkarten ──────────
  // Identische Quelle wie die Erfolgsrechnung (applyVjRevenueRule im Builder).
  const [vjDailyData, setVjDailyData] = useState<Record<string, VjDayRecord>>({});
  useEffect(() => {
    let alive = true;
    loadVjDailyYear(currentYear - 1, tenantId)
      .then(data => { if (alive) setVjDailyData(data); })
      .catch(() => { if (alive) setVjDailyData({}); });
    return () => { alive = false; };
  }, [currentYear, tenantId]);

  // ── Financial Metrics Registry (Monat) ──────────────────────────────────────
  // Finanzkarten kommen aus der Erfolgsrechnung: IST = P&L-Engine, PLAN =
  // Budget-Spalte, VORJAHR = P&L des Vorjahres — EIN computePLForMonth,
  // immer NETTO, Quoten aus Rohwerten (Nenner fehlt/0 ⇒ null). Rein lesend.
  const financialInput = useMemo(() => {
    try {
      return buildFinancialMetricInput(currentYear, currentMonth, {
        reportingStoreKey: tenantKey('reporting_v1'),
        budgetStoreKey:    tenantKey('budget_v1'),
        dailyBudgets,
        vjDaily:           vjDailyData,
        maisonDaily:       maisonOn && !maisonExclude ? maisonDaily : undefined,
        takeawayMonthly:   monthlyTakeaway > 0
          ? { [`${currentYear}-${String(currentMonth).padStart(2, '0')}`]: monthlyTakeaway }
          : undefined,
      });
    } catch (e) {
      console.error('[FINANZKARTEN] Registry-Input fehlgeschlagen:', e);
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentYear, currentMonth, dailyBudgets, vjDailyData, maisonOn, maisonExclude, maisonDaily, monthlyTakeaway, reportingTick, tenantId]);

  const finRevenue        = financialInput ? getFinancialMetricValues('net_revenue',     financialInput) : null;
  const finPersonnel      = financialInput ? getFinancialMetricValues('total_personnel', financialInput) : null;
  const finPersonnelRatio = financialInput ? getFinancialMetricValues('personnel_ratio', financialInput) : null;

  // Abweichungen der Finanzkarten — aus DENSELBEN Registry-Rohwerten
  const finRevVsBudgetAbs = finRevenue && finRevenue.actual !== null && finRevenue.budget !== null && finRevenue.budget > 0
    ? finRevenue.actual - finRevenue.budget
    : null;
  const finRevVsBudgetPct = finRevVsBudgetAbs !== null && finRevenue?.budget
    ? (finRevVsBudgetAbs / finRevenue.budget) * 100
    : null;
  const finRevVsPrevYearPct = finRevenue && finRevenue.actual !== null && finRevenue.priorYear !== null && finRevenue.priorYear > 0
    ? ((finRevenue.actual - finRevenue.priorYear) / finRevenue.priorYear) * 100
    : null;
  const finPkVsBudgetPct = finPersonnel && finPersonnel.actual !== null && finPersonnel.budget !== null && finPersonnel.budget > 0
    ? ((finPersonnel.actual - finPersonnel.budget) / finPersonnel.budget) * 100
    : null;

  // ── Mitarbeiter nach Abteilung UND aktivem Monat filtern ────────────────────
  const visibleEmployees = useMemo(() => {
    const monthActive = (e: Employee) => isEmployeeActiveInMonth(e, currentYear, currentMonth);
    if (isAdmin) return employees.filter(monthActive);
    return employees.filter(e => monthActive(e) && e.department === allowedDepartment);
  }, [employees, isAdmin, allowedDepartment, currentYear, currentMonth]);

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
  // reportingTick als Dep damit der Memo nach Supabase-Sync neu berechnet wird
  const reportingActualRevenue = useMemo(
    () => loadMonth(currentYear, currentMonth, tenantKey('reporting_v1')).revenueActual ?? 0,
    [currentYear, currentMonth, reportingTick, tenantId] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const revenueMonthBase = revenueMonthDaily > 0 ? revenueMonthDaily : reportingActualRevenue;

  // Maison-Aufschlag: Marketing-Tageswerte werden zum Basisumsatz addiert
  // (Das reguläre Umsatzfile enthält KEIN Marketing — es wird separat importiert)
  const maisonSumGross = (days: string[]) =>
    maisonOn && !maisonExclude
      ? days.reduce((s, d) => s + (maisonDaily[d] ?? 0), 0)
      : 0;
  const maisonActiveGross = maisonSumGross(activeDays);
  const maisonMonthGross  = maisonSumGross(monthDays);
  // Marketing MWST-Satz: 8.1% (Restaurationsumsatz)
  const maisonActiveNet = showNetRevenue ? maisonActiveGross / 1.081 : maisonActiveGross;
  const maisonMonthNet  = showNetRevenue ? maisonMonthGross  / 1.081 : maisonMonthGross;

  const revenueMonth = revenueMonthBase + maisonMonthNet;

  // Fallback Vorjahr: zuerst revenuePreviousYear im aktuellen Datensatz (manuell eingegeben),
  // dann Vorjahres-Ist aus reporting_v1 des Vorjahres.
  // reportingTick als Dep damit der Memo nach Supabase-Sync neu berechnet wird.
  const reportingPrevYearRevenue = useMemo(() => {
    const storeKey = tenantKey('reporting_v1');
    if (period === 'month') {
      const rec = loadMonth(currentYear, currentMonth, storeKey);
      if (rec.revenuePreviousYear) return rec.revenuePreviousYear;
      return loadMonth(currentYear - 1, currentMonth, storeKey).revenueActual ?? 0;
    }
    if (period === 'year') {
      // SSoT: Jahresaggregation zentral über calcAnnualSummary (reporting-store) —
      // keine eigene reduce-Zweitberechnung (identische Semantik: fehlende Monate = 0).
      const cur = calcAnnualSummary(currentYear, storeKey);
      if (cur.totalRevenuePreviousYear > 0) return cur.totalRevenuePreviousYear;
      return calcAnnualSummary(currentYear - 1, storeKey).totalRevenueActual;
    }
    return 0;
  }, [period, currentYear, currentMonth, reportingTick, tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Periodenspezifische Umsatz-Werte
  // Für 'month' nutzen wir denselben Fallback; für today/week nur Tagesdaten
  const revenueActiveDailyRaw = sumRevenue(activeDays, 'actualRevenue');
  const revenueActiveBase = (period === 'month' && revenueActiveDailyRaw === 0)
    ? reportingActualRevenue
    : revenueActiveDailyRaw;
  const revenueActive = revenueActiveBase + maisonActiveNet;
  const revenuePrevYearDailyRaw = sumRevenuePrevYear(activeDays);
  const revenuePrevYearActive = revenuePrevYearDailyRaw > 0
    ? revenuePrevYearDailyRaw
    : reportingPrevYearRevenue;

  const daysInRefMonth = getDaysInMonth(referenceDate);

  // Weekday-gewichtete Tagesbudgets (Single Source of Truth: getDailyBudgetMap)
  const revBudgetMap = useMemo(
    () => getDailyBudgetMap(budgetData.revenueBudget, currentYear, currentMonth),
    [budgetData.revenueBudget, currentYear, currentMonth],
  );

  // Budget pro Periode: weekday-gewichtet (NICHT mehr: revenueBudget / daysInRefMonth)
  const budgetActive = budgetData.revenueBudget > 0
    ? period === 'month'
      ? budgetData.revenueBudget
      : period === 'today'
      ? (revBudgetMap[refDateStr] ?? 0)
      : period === 'week'
      ? weekDays.reduce((s, d) => s + (revBudgetMap[d] ?? 0), 0)
      : budgetData.revenueBudget * 12   // Jahr: Monatsbudget × 12
    : 0;

  // ── Umsatzbasis-Konvertierung ─────────────────────────────────────────────────
  // toBase(): gibt Netto (exkl. MWST) oder Brutto zurück je nach globalem Switch.
  // - Restaurant: ÷ 1.081  |  Take Away: ÷ 1.026
  const toBase = (gross: number, takeaway = 0): number => {
    if (!showNetRevenue) return gross;
    return grossToNet(gross, takeaway);
  };
  const takeawayActiveSum  = sumRevenue(activeDays, 'takeawayRevenue');
  const takeawayMonthSum   = sumRevenue(monthDays,  'takeawayRevenue');
  console.log('[UMSATZBASIS] mode:', showNetRevenue ? 'netto' : 'brutto');
  if (showNetRevenue && revenueActive > 0) {
    const ta  = takeawayActiveSum;
    const reg = revenueActive - ta;
    console.log('[UMSATZBASIS] restaurant gross ->', reg.toFixed(0), '-> net:', (reg / 1.081).toFixed(0));
    if (ta > 0) console.log('[UMSATZBASIS] takeaway gross ->', ta.toFixed(0), '-> net:', (ta / 1.026).toFixed(0));
  }
  // Monatliches Take-Away Korrektur (Kto. 3010 Netto)
  // Wenn ein buchhaltungsseitiger Monats-Take-Away bekannt ist, überschreibt der
  // korrekt berechnete Netto-Wert die per-Tag-Summe (identisch zu TagesansichtPage).
  const maisonArg = maisonOn && !maisonExclude ? maisonDaily : undefined;
  const revenueMonthCorrected = showNetRevenue && monthlyTakeaway > 0
    ? computeMonthlyIstNet(currentYear, currentMonth, dailyBudgets as Record<string, { actualRevenue?: number; takeawayRevenue?: number }>, undefined, maisonArg, monthlyTakeaway)
    : 0;

  let revenueActiveB = toBase(revenueActive, takeawayActiveSum);
  if (showNetRevenue && period === 'month' && revenueMonthCorrected > 0) revenueActiveB = revenueMonthCorrected;
  const revenuePrevYearActiveB = toBase(revenuePrevYearActive);
  const budgetActiveB          = toBase(budgetActive);
  const revenueMonthB          = revenueMonthCorrected > 0 ? revenueMonthCorrected : toBase(revenueMonth, takeawayMonthSum);
  const revenuePlannedMonthB   = toBase(revenuePlannedMonth, takeawayMonthSum);

  // ── Personalkosten-Berechnungen ─────────────────────────────────────────────
  // Alle Kosten = Total Arbeitgeberkosten (Brutto inkl. anteil. 13. + AG-Sozialkosten).
  const monthDateSet = new Set(monthDays);
  const agFactor = useMemo(() => socialCostFactorFromRates(socialCostRates), [socialCostRates]);
  const agRate = useCallback(
    (emp: Employee) => getEffectiveHourlyRate(emp, socialCostRates) ?? 0,
    [socialCostRates]
  );
  const agMonthly = useCallback(
    (emp: Employee) => (emp.monthlySalaryWith13th ?? emp.monthlySalary ?? 0) * agFactor,
    [agFactor]
  );

  const plannedLaborCost = useMemo(() => {
    return visibleEmployees.reduce((sum, emp) => {
      if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
        return sum + agMonthly(emp);
      }
      const hrs = Object.entries(scheduleData)
        .filter(([key]) => {
          const date = key.slice(-(10));
          const empId = key.slice(0, key.length - 11);
          return empId === emp.id && monthDateSet.has(date);
        })
        .reduce((s, [, day]) => s + calcDayHours(day), 0);
      return sum + hrs * agRate(emp);
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEmployees, scheduleData, agRate, agMonthly]);

  const actualLaborCost = useMemo(() => {
    return visibleEmployees.reduce((sum, emp) => {
      const hrs = Object.entries(actualData)
        .filter(([key]) => {
          const date = key.slice(-10);
          const empId = key.slice(0, key.length - 11);
          return empId === emp.id && monthDateSet.has(date);
        })
        .reduce((s, [, e]) => s + e.hours, 0);
      return sum + hrs * agRate(emp);
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEmployees, actualData, agRate]);

  // Personal FIX: garantierter Monatslohn inkl. 13. + AG-Sozialkosten für Vollzeit/Teilzeit
  const personalFixCost = useMemo(() => {
    return visibleEmployees
      .filter(e => (e.employmentType === 'vollzeit' || e.employmentType === 'teilzeit') && (e.monthlySalary ?? 0) > 0)
      .reduce((sum, e) => sum + agMonthly(e), 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEmployees, agMonthly]);

  // ── Absenzen-KPIs (admin only) ────────────────────────────────────────────
  const absenceData = useMemo(() => {
    if (!isAdmin || employees.length === 0) return null;
    const days = eachDayOfInterval({ start: startOfMonth(referenceDate), end: endOfMonth(referenceDate) });
    const overrides = loadAbsenceOverrides();
    const events = computeAbsenceEvents(employees, scheduleData, actualData, days);
    if (events.length === 0) return null;
    const resolved = events.map(ev => resolveAbsenceEvent(ev, overrides, employees, scheduleData, actualData));
    return summarizeAbsences(resolved);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, scheduleData, actualData, monthKey, isAdmin]);

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

  const plannedCostRatio = revenuePlannedMonthB > 0
    ? (plannedLaborCost / revenuePlannedMonthB) * 100
    : null;
  const actualCostRatio = revenueMonthB > 0 && actualLaborCost > 0
    ? (actualLaborCost / revenueMonthB) * 100
    : null;

  // ── Buchhaltungs-Personalkosten (aus P&L-Import, 5xxx Konten) ───────────────
  const accountingMonthRecord = useMemo(
    () => loadMonth(currentYear, currentMonth, tenantKey('reporting_v1')),
    [currentYear, currentMonth, reportingTick, tenantId] // eslint-disable-line react-hooks/exhaustive-deps
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
  // Die monatlichen Finanzkarten (Umsatz/Personalkosten vs. Budget/Vorjahr)
  // beziehen ihre Werte und Abweichungen aus der Financial Metrics Registry
  // (finRevenue/finPersonnel/finPersonnelRatio, siehe oben) — keine eigene
  // Budget-Zweitberechnung mehr an dieser Stelle.

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

  // Budget pro-rata per Stichtag — weekday-gewichtet (NICHT mehr linear × Tag/Monat)
  const budgetProRataStichtag = stichtagInMonth && stichtagDay && budgetData.revenueBudget > 0
    ? Math.round(
        Object.entries(revBudgetMap)
          .filter(([k]) => parseInt(k.slice(8), 10) <= stichtagDay)
          .reduce((s, [, v]) => s + v, 0)
      )
    : null;
  const budgetProRataStichtagB = budgetProRataStichtag !== null ? toBase(budgetProRataStichtag) : null;

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

  // Umsatzbasis-Stichtag
  const takeawayStichtagSum    = stichtagDateStr ? sumRevenue(daysUpToStichtag, 'takeawayRevenue') : 0;
  const revenueIstStichtagB    = revenueIstStichtag !== null ? toBase(revenueIstStichtag, takeawayStichtagSum) : null;
  const revenuePrevYearStichtagB = revenuePrevYearStichtag !== null ? toBase(revenuePrevYearStichtag) : null;

  // Personalkosten bis Stichtag (aus Ist-Stunden × Total-AG-Stundensatz)
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
      return sum + hrs * agRate(emp);
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEmployees, actualData, stichtagDateStr, agRate]);

  // ── Effektiver Stichtag: letzter Tag mit Ist-Umsatz (oder expliziter Stichtag) ──
  // Für den "zweiten Budget pro rata"-Vergleich
  const lastRevenueDay = monthDays.reduce<string | null>((last, d) => {
    return (dailyBudgets[d]?.actualRevenue ?? 0) > 0 ? d : last;
  }, null);

  // Wir bevorzugen den expliziten Stichtag (wenn im aktuellen Monat), sonst letzten Ist-Tag
  const effectiveCutoff = stichtagDateStr ?? lastRevenueDay;
  const effectiveDayNum = effectiveCutoff ? parseInt(effectiveCutoff.slice(-2), 10) : null;
  const effectiveDays   = effectiveCutoff ? monthDays.filter(d => d <= effectiveCutoff) : [];

  // budgetEffective: weekday-gewichtet bis effectiveDayNum (NICHT mehr linear × Tag/Monat)
  const budgetEffective = effectiveDayNum && budgetData.revenueBudget > 0
    ? Math.round(
        Object.entries(revBudgetMap)
          .filter(([k]) => parseInt(k.slice(8), 10) <= effectiveDayNum)
          .reduce((s, [, v]) => s + v, 0)
      )
    : null;

  const revenueIstEffective = effectiveCutoff
    ? sumRevenue(effectiveDays, 'actualRevenue')
    : null;

  // Umsatzbasis-Effective
  const takeawayEffectiveSum  = effectiveDays.length > 0 ? sumRevenue(effectiveDays, 'takeawayRevenue') : 0;
  const revenueIstEffectiveB  = revenueIstEffective !== null ? toBase(revenueIstEffective, takeawayEffectiveSum) : null;
  const budgetEffectiveB      = budgetEffective !== null ? toBase(budgetEffective) : null;

  const revEffectiveVsBudgetAbs = budgetEffectiveB !== null && revenueIstEffectiveB !== null
    ? revenueIstEffectiveB - budgetEffectiveB
    : null;

  const revEffectiveVsBudgetPct = budgetEffectiveB && revenueIstEffectiveB !== null && budgetEffectiveB > 0
    ? ((revenueIstEffectiveB - budgetEffectiveB) / budgetEffectiveB) * 100
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
      return sum + hrs * agRate(emp);
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEmployees, actualData, effectiveCutoff, agRate]);

  const plannedLaborCostEffective = useMemo(() => {
    if (!effectiveCutoff || !effectiveDayNum || effectiveDays.length === 0) return null;
    const daySet = new Set(effectiveDays);
    return visibleEmployees.reduce((sum, emp) => {
      if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
        return sum + agMonthly(emp) * effectiveDayNum / daysInRefMonth;
      }
      const hrs = Object.entries(scheduleData)
        .filter(([key]) => {
          const date  = key.slice(-10);
          const empId = key.slice(0, key.length - 11);
          return empId === emp.id && daySet.has(date);
        })
        .reduce((s, [, day]) => s + calcDayHours(day), 0);
      return sum + hrs * agRate(emp);
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEmployees, scheduleData, effectiveCutoff, effectiveDayNum, daysInRefMonth, agRate, agMonthly]);

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
  const prevYearEffectiveB = prevYearEffective > 0 ? toBase(prevYearEffective) : 0;
  const istVsPrevYearPct = prevYearEffectiveB > 0 && revenueIstEffectiveB !== null
    ? ((revenueIstEffectiveB - prevYearEffectiveB) / prevYearEffectiveB) * 100
    : null;
  const istVsPrevYearAbs = prevYearEffectiveB > 0 && revenueIstEffectiveB !== null
    ? revenueIstEffectiveB - prevYearEffectiveB
    : null;

  // ── Ansicht-Filter-Helfer ────────────────────────────────────────────────────
  const showUmsatz       = ['alle', 'umsatz', 'vorjahr'].includes(dashView);
  const showJbv          = ['alle', 'umsatz', 'budget', 'vorjahr'].includes(dashView);
  const showPersonal     = ['alle', 'personal', 'budget'].includes(dashView);
  const showStunden      = ['alle', 'personal'].includes(dashView);
  const showPkVergl      = ['alle', 'personal', 'budget'].includes(dashView);
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

          {/* ── Ansicht-Filter ─────────────────────────────────────────────── */}
          <div className="border-t border-border/60 pt-2 pb-0.5 flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground font-medium mr-1">Ansicht:</span>
            {([
              { id: 'alle',          label: 'Alle',            icon: <LayoutDashboard className="h-3.5 w-3.5" /> },
              { id: 'umsatz',        label: 'Umsatz',          icon: <TrendingUp className="h-3.5 w-3.5" /> },
              { id: 'budget',        label: 'Ist vs. Budget',  icon: <BookOpen className="h-3.5 w-3.5" /> },
              { id: 'vorjahr',       label: 'Ist vs. Vorjahr', icon: <CalendarDays className="h-3.5 w-3.5" /> },
              { id: 'personal',      label: 'Personal',        icon: <Users className="h-3.5 w-3.5" /> },
            ] as { id: DashView; label: string; icon: React.ReactNode }[]).map(v => (
              <button
                key={v.id}
                onClick={() => setDashView(v.id)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all border',
                  dashView === v.id
                    ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                    : 'bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground',
                )}
              >
                {v.icon}
                {v.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main ref={dashboardMainRef} className="max-w-6xl mx-auto px-4 py-6 pb-24 space-y-2">

        {/* ── Heute wichtig (nur echte Handlungsbedarfe + Schnellaktionen) ── */}
        <HeuteWichtigBanner />

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
            {showPersonal && canSeePersonnelCostTotals && plannedRatioStatus === 'high' && (
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

            {showPersonal && canSeePersonnelCostTotals && plannedRatioStatus === 'good' && plannedCostRatio !== null && (
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
            {isAdmin && showUmsatz && (
              <>
                <SectionTitle icon={<TrendingUp className="h-4 w-4" />}>
                  Umsatz · {PERIOD_LABELS[period]}
                  <span className="ml-2 font-normal text-muted-foreground normal-case">{periodLabel}</span>
                  <span className={`ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${showNetRevenue ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'}`}>
                    {showNetRevenue ? '✓ Netto · Controlling-Basis' : '⚠ Brutto · Kontrollansicht'}
                  </span>
                </SectionTitle>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <KpiCard
                    title={`Umsatz Ist · ${PERIOD_LABELS[period]}`}
                    value={revenueActiveB > 0 ? formatCHF(revenueActiveB) : '–'}
                    subtitle="Tagesumsatz gemäss Z-Bericht"
                    icon={<TrendingUp className="h-5 w-5" />}
                    color={revenueActiveB > 0 ? 'green' : 'default'}
                  />
                  <KpiCard
                    title={`Budget · ${PERIOD_LABELS[period]}`}
                    value={budgetActiveB > 0 ? formatCHF(Math.round(budgetActiveB)) : '–'}
                    subtitle={period === 'month' ? 'Monatsbudget 2026' : period === 'year' ? 'Jahresbudget (×12)' : 'Anteiliges Budget'}
                    delta={budgetActiveB > 0 ? ((revenueActiveB - budgetActiveB) / budgetActiveB) * 100 : null}
                    deltaLabel="% vs. Budget"
                    icon={<CalendarDays className="h-5 w-5" />}
                    color="blue"
                  />
                  <KpiCard
                    title={`Vorjahr · ${PERIOD_LABELS[period]}`}
                    value={revenuePrevYearActiveB > 0 ? formatCHF(revenuePrevYearActiveB) : '–'}
                    subtitle="Tagesumsatz Vorjahr gemäss Z-Bericht"
                    delta={revenuePrevYearActiveB > 0 ? ((revenueActiveB - revenuePrevYearActiveB) / revenuePrevYearActiveB) * 100 : null}
                    deltaLabel="% vs. Vorjahr"
                    icon={<TrendingUp className="h-5 w-5" />}
                    color={revenuePrevYearActiveB > 0 ? (revenueActiveB >= revenuePrevYearActiveB ? 'green' : 'red') : 'default'}
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
                            {revenueActiveB > 0 ? (
                              <>
                                <span className="text-sm font-bold tabular-nums">{formatCHF(revenueActiveB)}</span>
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
            {budgetData.hasBudget && showJbv && (
              <>
                <SectionTitle icon={<BookOpen className="h-4 w-4" />}>
                  Jahresbudget-Vergleich · {monthName}
                </SectionTitle>

                {/* Umsatz-Finanzkarten (nur Admin) — Financial Metrics Registry:
                    IST = Erfolgsrechnung, PLAN = Budget, VJ = P&L Vorjahr, immer NETTO */}
                {isAdmin && (
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <KpiCard
                        title="Umsatz gemäss Erfolgsrechnung"
                        value={finRevenue?.actual != null ? formatCHF(finRevenue.actual) : '–'}
                        subtitle="Monat · netto"
                        icon={<TrendingUp className="h-5 w-5" />}
                        color={
                          finRevVsBudgetPct === null ? 'default' :
                          finRevVsBudgetPct >= 0 ? 'green' : 'red'
                        }
                        delta={finRevVsBudgetPct}
                        deltaLabel="% vs. Budget"
                      />
                      <KpiCard
                        title="Budget Umsatz"
                        value={finRevenue?.budget != null ? formatCHF(finRevenue.budget) : '–'}
                        subtitle={`Monatsbudget ${currentYear} · netto`}
                        icon={<BookOpen className="h-5 w-5" />}
                        color="blue"
                      />
                      <KpiCard
                        title="Vorjahr gemäss Erfolgsrechnung"
                        value={finRevenue?.priorYear != null ? formatCHF(finRevenue.priorYear) : '–'}
                        subtitle="P&L Vorjahresmonat · netto"
                        icon={<TrendingUp className="h-5 w-5" />}
                        color={
                          finRevVsPrevYearPct === null ? 'default' :
                          finRevVsPrevYearPct >= 0 ? 'green' : 'red'
                        }
                        delta={finRevVsPrevYearPct}
                        deltaLabel="% vs. Vorjahr"
                      />
                      {finRevVsBudgetAbs !== null && (
                        <KpiCard
                          title="Abweichung CHF"
                          value={`${finRevVsBudgetAbs >= 0 ? '+' : ''}${formatCHF(finRevVsBudgetAbs)}`}
                          subtitle={finRevVsBudgetAbs >= 0 ? 'Über Budget' : 'Unter Budget'}
                          icon={finRevVsBudgetAbs >= 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
                          color={finRevVsBudgetAbs >= 0 ? 'green' : 'red'}
                          badge={finRevVsBudgetAbs >= 0 ? '✓ Über Budget' : '↓ Unter Budget'}
                          badgeColor={
                            finRevVsBudgetAbs >= 0
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
                            value={revenueIstEffectiveB !== null && revenueIstEffectiveB > 0
                              ? formatCHF(revenueIstEffectiveB) : '–'}
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
                            value={budgetEffectiveB !== null ? formatCHF(budgetEffectiveB) : '–'}
                            subtitle={`${effectiveDayNum} von ${daysInRefMonth} Tagen`}
                            icon={<CalendarDays className="h-5 w-5" />}
                            color="blue"
                            small
                          />
                          {/* 3. Vorjahr pro rata (immer anzeigen, auch wenn 0) */}
                          <KpiCard
                            title="Vorjahr p.r."
                            value={prevYearEffectiveB > 0 ? formatCHF(prevYearEffectiveB) : '–'}
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
                        {revenuePrevYearStichtagB !== null && revenuePrevYearStichtagB > 0 && revenueIstStichtagB !== null && (
                          <>
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                              Umsatz vs. Vorjahr pro rata
                            </p>
                            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
                              <KpiCard
                                title="Ist Umsatz"
                                value={revenueIstStichtagB > 0 ? formatCHF(revenueIstStichtagB) : '–'}
                                subtitle={`bis ${stichtagFormatted}`}
                                icon={<TrendingUp className="h-5 w-5" />}
                                color={(revenueIstStichtagB - revenuePrevYearStichtagB) >= 0 ? 'green' : 'red'}
                                small
                              />
                              <KpiCard
                                title="Vorjahr bis Stichtag"
                                value={formatCHF(revenuePrevYearStichtagB)}
                                subtitle={`Vorjahr bis ${stichtagFormatted}`}
                                icon={<TrendingUp className="h-5 w-5" />}
                                color="default"
                                small
                              />
                              <KpiCard
                                title="Abw. vs. Vorjahr"
                                value={`${(revenueIstStichtagB - revenuePrevYearStichtagB) >= 0 ? '+' : ''}${formatCHF(revenueIstStichtagB - revenuePrevYearStichtagB)}`}
                                subtitle={`Ist vs. Vorjahr · ${revenuePrevYearStichtagB > 0
                                  ? `${(((revenueIstStichtagB - revenuePrevYearStichtagB) / revenuePrevYearStichtagB) * 100).toFixed(1)} %`
                                  : '–'}`}
                                icon={(revenueIstStichtagB - revenuePrevYearStichtagB) >= 0
                                  ? <TrendingUp className="h-5 w-5" />
                                  : <TrendingDown className="h-5 w-5" />}
                                color={(revenueIstStichtagB - revenuePrevYearStichtagB) >= 0 ? 'green' : 'red'}
                                badge={(revenueIstStichtagB - revenuePrevYearStichtagB) >= 0 ? '✓ Über Vorjahr' : '↓ Unter Vorjahr'}
                                badgeColor={(revenueIstStichtagB - revenuePrevYearStichtagB) >= 0
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
                                value={revenueIstStichtagB !== null && revenueIstStichtagB > 0 ? formatCHF(revenueIstStichtagB) : '–'}
                                subtitle={`bis ${stichtagFormatted}`}
                                icon={<TrendingUp className="h-5 w-5" />}
                                color={revenueIstStichtagB !== null && budgetProRataStichtagB !== null && revenueIstStichtagB >= budgetProRataStichtagB ? 'green' : 'red'}
                                small
                              />
                              <KpiCard
                                title="Budget pro rata"
                                value={budgetProRataStichtagB !== null ? formatCHF(budgetProRataStichtagB) : '–'}
                                subtitle={`Monatsbudget × ${stichtagDay}/${daysInRefMonth}`}
                                icon={<CalendarDays className="h-5 w-5" />}
                                color="blue"
                                small
                              />
                              {revenueIstStichtagB !== null && budgetProRataStichtagB !== null && (
                                <KpiCard
                                  title="Abw. vs. Budget p.r."
                                  value={`${(revenueIstStichtagB - budgetProRataStichtagB) >= 0 ? '+' : ''}${formatCHF(revenueIstStichtagB - budgetProRataStichtagB)}`}
                                  subtitle={`Ist vs. Budget pro rata · ${budgetProRataStichtagB > 0
                                    ? `${(((revenueIstStichtagB - budgetProRataStichtagB) / budgetProRataStichtagB) * 100).toFixed(1)} %`
                                    : '–'}`}
                                  icon={(revenueIstStichtagB - budgetProRataStichtagB) >= 0
                                    ? <TrendingUp className="h-5 w-5" />
                                    : <TrendingDown className="h-5 w-5" />}
                                  color={(revenueIstStichtagB - budgetProRataStichtagB) >= 0 ? 'green' : 'red'}
                                  badge={(revenueIstStichtagB - budgetProRataStichtagB) >= 0 ? '✓ Über Budget' : '↓ Unter Budget'}
                                  badgeColor={(revenueIstStichtagB - budgetProRataStichtagB) >= 0
                                    ? 'bg-green-50 text-green-700 border-green-300 dark:bg-green-950/30'
                                    : 'bg-red-50 text-red-700 border-red-300 dark:bg-red-950/30'}
                                  small
                                />
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* Brutto-Warnung: Verhältniskennzahlen auf Brutto-Basis */}
                {!showNetRevenue && canSeePersonnelCostTotals && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 mt-1">
                    <span className="shrink-0 mt-0.5">⚠</span>
                    <span>
                      <span className="font-semibold">Kontrollansicht (Bruttoumsatz):</span> Personalquoten (PKQ, FIX-Quote) werden tiefer dargestellt, da der Nenner inkl. MWST ist. Personalkosten bleiben unverändert. Für Controlling-Vergleiche <span className="font-semibold">Netto</span> verwenden.
                    </span>
                  </div>
                )}

                {/* Personalkosten: Erfolgsrechnung vs. Dienstplan vs. Budget —
                    Finanzwerte (Ist/Budget/Quote) aus der Registry, Dienstplan bleibt operativ */}
                {canSeePersonnelCostTotals && budgetData.personnelBudget > 0 && (
                  <div className="mt-3">
                    {/* Zeile 1: Dreiweg-Vergleich Erfolgsrechnung · Dienstplan · Budget */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <KpiCard
                        title="Personalkosten gemäss Erfolgsrechnung"
                        value={finPersonnel?.actual != null ? formatCHF(finPersonnel.actual) : '–'}
                        subtitle={finPersonnelRatio?.actual != null
                          ? `${finPersonnelRatio.actual.toFixed(1)} % v. Umsatz (netto)`
                          : 'Noch kein Lohn-/Buchhaltungswert'}
                        icon={<Users className="h-5 w-5" />}
                        color={
                          finPkVsBudgetPct === null ? 'default' :
                          finPkVsBudgetPct <= 0 ? 'green' : 'red'
                        }
                        delta={finPkVsBudgetPct}
                        deltaLabel="% vs. Budget"
                      />
                      {plannedLaborCost > 0 && (
                        <KpiCard
                          title="Geplante Personalkosten"
                          value={formatCHF(plannedLaborCost)}
                          subtitle="gemäss Dienstplan"
                          icon={<CalendarDays className="h-5 w-5" />}
                          color="default"
                          delta={actualLaborCost > 0 && plannedLaborCost > 0
                            ? ((actualLaborCost - plannedLaborCost) / plannedLaborCost) * 100
                            : null}
                          deltaLabel="% Ist (Dienstplan) vs. Plan"
                        />
                      )}
                      <KpiCard
                        title="Budget Personalkosten"
                        value={finPersonnel?.budget != null ? formatCHF(finPersonnel.budget) : '–'}
                        subtitle="Budget-Spalte der Erfolgsrechnung"
                        icon={<BookOpen className="h-5 w-5" />}
                        color="blue"
                      />
                      {finPersonnelRatio?.actual != null && budgetData.personnelRatioTarget !== null && (
                        <KpiCard
                          title="Ist-Quote vs. Ziel"
                          value={`${finPersonnelRatio.actual.toFixed(1)} %`}
                          subtitle={`Ziel: ≤ ${budgetData.personnelRatioTarget.toFixed(1)} % v. Umsatz`}
                          icon={<Target className="h-5 w-5" />}
                          color={budgetRatioColor(
                            finPersonnelRatio.actual,
                            budgetData.personnelRatioTarget,
                          )}
                          badge={
                            finPersonnelRatio.actual <= budgetData.personnelRatioTarget
                              ? '✓ Im Ziel'
                              : finPersonnelRatio.actual <= budgetData.personnelRatioTarget + 5
                              ? '~ Grenzwertig'
                              : '↑ Über Ziel'
                          }
                          badgeColor={
                            finPersonnelRatio.actual <= budgetData.personnelRatioTarget
                              ? 'bg-green-50 text-green-700 border-green-300 dark:bg-green-950/30'
                              : finPersonnelRatio.actual <= budgetData.personnelRatioTarget + 5
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
                          subtitle={revenueIstStichtagB !== null && revenueIstStichtagB > 0
                            ? `${((actualLaborCostStichtag / revenueIstStichtagB) * 100).toFixed(1)} % v. Ist-Umsatz`
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
                      {revenueIstStichtagB !== null && revenueIstStichtagB > 0 && actualLaborCostStichtag !== null && actualLaborCostStichtag > 0 && (
                        <KpiCard
                          title="Ist-Quote bis Stichtag"
                          value={`${((actualLaborCostStichtag / revenueIstStichtagB) * 100).toFixed(1)} %`}
                          subtitle="Personalkosten / Umsatz"
                          icon={<Target className="h-5 w-5" />}
                          color={budgetData.personnelRatioTarget !== null
                            ? budgetRatioColor(
                                (actualLaborCostStichtag / revenueIstStichtagB) * 100,
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
            {canSeePersonnelCostTotals && showPersonal && (
              <>
                <SectionTitle icon={deptIcon}>
                  Personalkosten {deptLabel} · {monthName}
                </SectionTitle>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <KpiCard
                    title="Geplante Kosten"
                    value={plannedLaborCost > 0 ? formatCHF(plannedLaborCost) : '–'}
                    subtitle={`gemäss Dienstplan · ${visibleEmployees.length} Mitarbeiter`}
                    icon={<Users className="h-5 w-5" />}
                    color="blue"
                  />
                  {actualLaborCost > 0 && (
                    <KpiCard
                      title="Ist-Kosten"
                      value={formatCHF(actualLaborCost)}
                      subtitle="gemäss Ist-Stunden (Dienstplan)"
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
                      subtitle="Dienstplan-Kosten / Umsatz"
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
                          subtitle="gemäss Dienstplan"
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
                      {actualLaborCostEffective !== null && actualLaborCostEffective > 0 && revenueIstEffectiveB !== null && revenueIstEffectiveB > 0 && (
                        <KpiCard
                          title="PKQ pro rata"
                          value={`${((actualLaborCostEffective / revenueIstEffectiveB) * 100).toFixed(1)} %`}
                          subtitle="Ist-Kosten / Ist-Umsatz p.r."
                          icon={<Target className="h-5 w-5" />}
                          color={budgetData.personnelRatioTarget !== null
                            ? budgetRatioColor(
                                (actualLaborCostEffective / revenueIstEffectiveB) * 100,
                                budgetData.personnelRatioTarget,
                              )
                            : ratioStatus((actualLaborCostEffective / revenueIstEffectiveB) * 100) === 'good' ? 'green'
                            : ratioStatus((actualLaborCostEffective / revenueIstEffectiveB) * 100) === 'ok' ? 'yellow'
                            : 'red'}
                          small
                        />
                      )}
                    </div>
                  </div>
                )}

                {/* Personal FIX – Fixlohn-Vergleich */}
                {personalFixCost > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                      <DollarSign className="h-3.5 w-3.5" />
                      Personal FIX · Monat
                    </p>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <KpiCard
                        title="Personal FIX"
                        value={formatCHF(personalFixCost)}
                        subtitle="Fixlohn inkl. 13. / Monat"
                        icon={<DollarSign className="h-5 w-5" />}
                        color="blue"
                        small
                      />
                      {actualLaborCost > 0 && (
                        <KpiCard
                          title="Ist vs. FIX"
                          value={formatCHF(actualLaborCost - personalFixCost)}
                          subtitle={`${actualLaborCost >= personalFixCost ? '↑ Ist über Fix' : '↓ Ist unter Fix'}`}
                          icon={<Users className="h-5 w-5" />}
                          color={actualLaborCost <= personalFixCost ? 'green' : 'red'}
                          delta={(actualLaborCost - personalFixCost) / personalFixCost * 100}
                          deltaLabel="% Ist vs. FIX"
                          small
                        />
                      )}
                      {budgetData.personnelBudget > 0 && (
                        <KpiCard
                          title="FIX vs. Budget"
                          value={formatCHF(personalFixCost - budgetData.personnelBudget)}
                          subtitle={`${personalFixCost <= budgetData.personnelBudget ? '✓ FIX im Budget' : '↑ FIX über Budget'}`}
                          icon={<BookOpen className="h-5 w-5" />}
                          color={personalFixCost <= budgetData.personnelBudget ? 'green' : 'red'}
                          small
                        />
                      )}
                      {actualLaborCost > 0 && revenueMonthB > 0 && (
                        <KpiCard
                          title="FIX-Quote"
                          value={`${((personalFixCost / revenueMonthB) * 100).toFixed(1)} %`}
                          subtitle="FIX-Lohn / Ist-Umsatz"
                          icon={<Target className="h-5 w-5" />}
                          color={budgetData.personnelRatioTarget !== null
                            ? budgetRatioColor((personalFixCost / revenueMonthB) * 100, budgetData.personnelRatioTarget)
                            : 'default'}
                          small
                        />
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ── Stunden ──────────────────────────────────────────────────── */}
            {canSeePersonnelCostTotals && showStunden && (
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
                    subtitle="Arbeitsstunden gemäss Mirus"
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
            {canSeePersonnelCostTotals && showPkVergl && (actualLaborCost > 0 || accountingPersonnelCost > 0) && (
              <>
                <SectionTitle icon={<Scale className="h-4 w-4" />}>
                  Personalkosten-Vergleich · {monthName}
                </SectionTitle>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <KpiCard
                    title="Personalkosten gemäss Dienstplan"
                    value={actualLaborCost > 0 ? formatCHF(actualLaborCost) : '–'}
                    subtitle="Aus Ist-Stunden × Lohn"
                    icon={<Users className="h-5 w-5" />}
                    color="blue"
                  />
                  <KpiCard
                    title="Personalkosten gemäss Erfolgsrechnung"
                    value={accountingPersonnelCost > 0 ? formatCHF(accountingPersonnelCost) : '–'}
                    subtitle="Total Personalaufwand (5xxx)"
                    icon={<BookOpen className="h-5 w-5" />}
                    color={accountingPersonnelCost > 0 ? 'default' : 'default'}
                  />
                  {pkDiff !== null && (
                    <KpiCard
                      title="Abweichung CHF"
                      value={`${pkDiff >= 0 ? '+' : ''}${formatCHF(pkDiff)}`}
                      subtitle="Erfolgsrechnung − Dienstplan"
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

            {/* ── Absenzen & Ersatzkosten (Admin) ──────────────────────────── */}
            {isAdmin && absenceData && (
              <>
                <SectionTitle icon={<UserX className="h-4 w-4" />}>
                  Absenzen &amp; Ersatzkosten · {monthName}
                </SectionTitle>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  <KpiCard
                    title="Ferienersatzkosten"
                    value={absenceData.vacationCost > 0 ? formatCHF(absenceData.vacationCost) : '–'}
                    subtitle={`${absenceData.vacationDays} Ferientage`}
                    icon={<Palmtree className="h-5 w-5" />}
                    color={absenceData.vacationCost > 0 ? 'yellow' : 'default'}
                  />
                  <KpiCard
                    title="Krankheitsersatzkosten"
                    value={absenceData.sickCost > 0 ? formatCHF(absenceData.sickCost) : '–'}
                    subtitle={`${absenceData.sickDays} Kranktage`}
                    icon={<Stethoscope className="h-5 w-5" />}
                    color={absenceData.sickCost > 0 ? 'red' : 'default'}
                  />
                  {absenceData.accidentDays > 0 && (
                    <KpiCard
                      title="Unfallersatzkosten"
                      value={absenceData.accidentCost > 0 ? formatCHF(absenceData.accidentCost) : '–'}
                      subtitle={`${absenceData.accidentDays} Unfalltage`}
                      icon={<Stethoscope className="h-5 w-5" />}
                      color="red"
                    />
                  )}
                  <KpiCard
                    title="Total Ersatzkosten"
                    value={absenceData.totalCost > 0 ? formatCHF(absenceData.totalCost) : '–'}
                    subtitle="Zusatzkosten durch Absenzen"
                    icon={<UserX className="h-5 w-5" />}
                    color={absenceData.totalCost > 0 ? 'red' : 'default'}
                  />
                  <KpiCard
                    title="Einsparung"
                    value={absenceData.totalSaving > 0 ? formatCHF(absenceData.totalSaving) : '–'}
                    subtitle={`${absenceData.unreplacedHrs.toFixed(1)} h nicht ersetzt`}
                    icon={<TrendingDown className="h-5 w-5" />}
                    color={absenceData.totalSaving > 0 ? 'green' : 'default'}
                  />
                  <KpiCard
                    title="Top Abteilung"
                    value={
                      absenceData.byDept.service.days >= absenceData.byDept.küche.days
                        ? 'Service'
                        : 'Küche'
                    }
                    subtitle={
                      absenceData.byDept.service.days >= absenceData.byDept.küche.days
                        ? `${absenceData.byDept.service.days}d · ${formatCHF(absenceData.byDept.service.cost)}`
                        : `${absenceData.byDept.küche.days}d · ${formatCHF(absenceData.byDept.küche.cost)}`
                    }
                    icon={<Users className="h-5 w-5" />}
                    color="yellow"
                  />
                </div>
                {/* Dept breakdown strip */}
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Service', dept: absenceData.byDept.service, icon: <Utensils className="h-3.5 w-3.5" /> },
                    { label: 'Küche',   dept: absenceData.byDept.küche,   icon: <ChefHat  className="h-3.5 w-3.5" /> },
                  ].map(({ label, dept, icon }) => (
                    <div key={label} className="rounded-lg border border-border bg-muted/30 px-4 py-2.5 flex items-center justify-between gap-4 flex-wrap text-xs">
                      <div className="flex items-center gap-1.5 font-semibold text-foreground">
                        {icon}
                        {label}
                      </div>
                      <div className="flex items-center gap-4 text-muted-foreground">
                        <span><strong className="text-foreground">{dept.days}</strong> Absenztage</span>
                        {dept.cost > 0 && <span><strong className="text-red-600 dark:text-red-400 font-mono">{formatCHF(dept.cost)}</strong> Ersatz</span>}
                        {dept.saving > 0 && <span><strong className="text-green-600 dark:text-green-400 font-mono">{formatCHF(dept.saving)}</strong> Einsparung</span>}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-right">
                  <Link to="/absenzen" className="text-xs text-primary hover:underline">
                    Absenzen &amp; Ersatz im Detail →
                  </Link>
                </div>
              </>
            )}


            {/* ── Margenkontrolle – WES-Ampel ──────────────────────────────── */}
            {isAdmin && <WesMarginWidget />}

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
