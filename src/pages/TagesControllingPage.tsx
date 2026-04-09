/**
 * TagesControllingPage – Operatives Tages-Controlling
 * ====================================================
 * Route:  /tages-controlling   |  Nav: Verkauf → Tages-Controlling (adminOnly)
 *
 * Zeitraum-Modi: Woche · Monat · Jahr
 *
 * Spalten pro Tag:
 *   Datum | WT | Ist-Umsatz | PK Plan CHF | PK Ist CHF |
 *   PK Plan % | PK Ist % | WES CHF | WES %
 *
 * Datenquellen:
 *   Umsatz     → dailyBudgets (localStorage / Supabase-KV)
 *   PK Plan    → schedule-v2-YYYY-MM (localStorage) × Stundenlohn
 *   PK Ist     → timeEntries (localStorage) × Stundenlohn
 *   WES        → getMonthSummary() (Lieferantendokumente) als pro-rata pro Tag
 *
 * Total-Zeile:
 *   CHF-Spalten = Summe; %-Spalten = Total Kosten / Total Umsatz (gewichtet)
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear,
  eachDayOfInterval, format, addWeeks, subWeeks, addMonths, subMonths,
  addYears, subYears, isSameMonth,
} from 'date-fns';
import { de } from 'date-fns/locale';
import {
  ChevronLeft, ChevronRight, CalendarDays, Calendar, CalendarRange,
  TrendingUp, TrendingDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';
import { grossToNet } from '@/types/personnel';
import { getMonthSummary } from '@/lib/supplier-documents-store';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';

// ── Typen ─────────────────────────────────────────────────────────────────────

type Period = 'woche' | 'monat' | 'jahr';

interface EmployeeLite {
  id: string;
  hourlyWage: number;
}

interface TimeSlot {
  start?: string;
  end?: string;
}

interface DaySchedule {
  früh?: TimeSlot | null;
  spät?: TimeSlot | null;
  frühAbsence?: string | null;
  spätAbsence?: string | null;
}

interface ControllingRow {
  date:       string;    // yyyy-MM-dd
  day:        Date;
  umsatz:     number;    // Ist-Umsatz Brutto
  pkPlanChf:  number;    // Personalkosten Plan CHF
  pkIstChf:   number;    // Personalkosten Ist CHF
  wesChf:     number;    // Wareneinsatz CHF (pro-rata aus Monatswert)
}

// ── Konstanten ────────────────────────────────────────────────────────────────

const WT_ABBR = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;
const EMPLOYEES_KEY = 'employees';

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

const NUM  = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const NUM1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtN   = (v: number) => NUM.format(Math.round(v));
const fmtPct = (v: number, active = true) =>
  active ? NUM1.format(v) + ' %' : '–';

function slotHours(slot: TimeSlot | null | undefined): number {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = (eh - sh) + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.round(h * 100) / 100;
}

function dayNetHours(ds: DaySchedule): number {
  const gross = slotHours(ds.früh) + slotHours(ds.spät);
  const deduction = calculateBreakDeduction(gross);
  return Math.max(0, Math.round((gross - deduction) * 100) / 100);
}

// ── Daten laden ───────────────────────────────────────────────────────────────

function loadEmployees(): EmployeeLite[] {
  try {
    const raw = localStorage.getItem(EMPLOYEES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Array<{ id: string; hourlyWage: number }>;
      return parsed.map(e => ({ id: e.id, hourlyWage: Number(e.hourlyWage) || 0 }));
    }
  } catch { /* ignore */ }
  // Hard-coded fallback wage map (matches defaultEmployees)
  return [
    { id: '1', hourlyWage: 36.92 }, { id: '2', hourlyWage: 33.85 },
    { id: '3', hourlyWage: 28.00 }, { id: '4', hourlyWage: 31.33 },
    { id: '5', hourlyWage: 34.46 }, { id: '6', hourlyWage: 28.31 },
    { id: '7', hourlyWage: 24.70 }, { id: '8', hourlyWage: 30.77 },
    { id: '9', hourlyWage: 28.67 }, { id: '10', hourlyWage: 26.37 },
    { id: '11', hourlyWage: 31.33 }, { id: '12', hourlyWage: 26.00 },
    { id: '13', hourlyWage: 20.50 }, { id: '14', hourlyWage: 49.33 },
    { id: '15', hourlyWage: 34.46 }, { id: '16', hourlyWage: 47.33 },
    { id: '17', hourlyWage: 30.67 }, { id: '18', hourlyWage: 27.69 },
    { id: '19', hourlyWage: 28.92 }, { id: '20', hourlyWage: 20.36 },
    { id: '21', hourlyWage: 20.36 }, { id: '22', hourlyWage: 30.00 },
    { id: '23', hourlyWage: 30.00 },
  ];
}

function readDailyBudgets(): Record<string, { actualRevenue?: number; takeawayRevenue?: number }> {
  try { return JSON.parse(localStorage.getItem('dailyBudgets') || '{}'); }
  catch { return {}; }
}

/**
 * Berechnet Plan-Personalkosten pro Tag aus schedule-v2-YYYY-MM.
 * Rückgabe: Map { 'yyyy-MM-dd' → CHF }
 */
function buildPlanCostMap(
  dates: Date[],
  employees: EmployeeLite[],
): Record<string, number> {
  // Betroffene Monate ermitteln
  const monthKeys = new Set<string>();
  for (const d of dates) monthKeys.add(format(d, 'yyyy-MM'));

  const wageMap: Record<string, number> = {};
  for (const e of employees) wageMap[e.id] = e.hourlyWage;

  // dayKey → planCost CHF
  const map: Record<string, number> = {};
  for (const mk of monthKeys) {
    try {
      const raw = localStorage.getItem(`schedule-v2-${mk}`);
      if (!raw) continue;
      const scheduleData: Record<string, DaySchedule> = JSON.parse(raw);
      for (const [cellKey, ds] of Object.entries(scheduleData)) {
        if (!ds) continue;
        // cellKey = "${employeeId}-${yyyy-MM-dd}"
        const dashIdx = cellKey.indexOf('-');
        if (dashIdx === -1) continue;
        const empId  = cellKey.slice(0, dashIdx);
        const dateStr = cellKey.slice(dashIdx + 1);
        const wage   = wageMap[empId] ?? 0;
        if (wage === 0) continue;
        const netH   = dayNetHours(ds);
        if (netH <= 0) continue;
        map[dateStr] = (map[dateStr] ?? 0) + netH * wage;
      }
    } catch { /* ignore parse errors */ }
  }
  return map;
}

/**
 * Berechnet Ist-Personalkosten pro Tag aus timeEntries (localStorage).
 * Rückgabe: Map { 'yyyy-MM-dd' → CHF }
 */
function buildActualCostMap(
  dates: Date[],
  employees: EmployeeLite[],
): Record<string, number> {
  const dateSet = new Set(dates.map(d => format(d, 'yyyy-MM-dd')));
  const wageMap: Record<string, number> = {};
  for (const e of employees) wageMap[e.id] = e.hourlyWage;

  const map: Record<string, number> = {};
  try {
    const raw = localStorage.getItem('timeEntries');
    if (!raw) return map;
    const entries: Array<{ employeeId?: string; date?: string; actualHours?: number }> = JSON.parse(raw);
    for (const te of entries) {
      if (!te.date || !dateSet.has(te.date)) continue;
      const hours = te.actualHours ?? 0;
      if (hours <= 0) continue;
      const wage = wageMap[te.employeeId ?? ''] ?? 0;
      map[te.date] = (map[te.date] ?? 0) + hours * wage;
    }
  } catch { /* ignore */ }
  return map;
}

/**
 * WES pro-rata: monatliche Gesamtkosten / Tage-im-Monat pro Tag.
 * Rückgabe: Map { 'yyyy-MM-dd' → CHF }
 */
function buildWesMap(dates: Date[]): Record<string, number> {
  // Monate ermitteln
  const monthGroups = new Map<string, Date[]>();
  for (const d of dates) {
    const mk = format(d, 'yyyy-MM');
    if (!monthGroups.has(mk)) monthGroups.set(mk, []);
    monthGroups.get(mk)!.push(d);
  }
  const map: Record<string, number> = {};
  for (const [mk, days] of monthGroups) {
    const [y, m] = mk.split('-').map(Number);
    const summary = getMonthSummary(y, m);
    const total = summary.totalCost ?? 0;
    if (total <= 0) continue;
    // Pro-rata: monatlicher WES / Anzahl Tage im Monat (nicht nur in Selektion)
    const daysInMonth = endOfMonth(new Date(y, m - 1, 1)).getDate();
    const perDay = total / daysInMonth;
    for (const d of days) {
      map[format(d, 'yyyy-MM-dd')] = perDay;
    }
  }
  return map;
}

// ── Periode navigieren ────────────────────────────────────────────────────────

function getPeriodDates(period: Period, anchor: Date): Date[] {
  switch (period) {
    case 'woche':
      return eachDayOfInterval({
        start: startOfWeek(anchor, { weekStartsOn: 1 }),
        end:   endOfWeek(anchor,   { weekStartsOn: 1 }),
      });
    case 'monat':
      return eachDayOfInterval({
        start: startOfMonth(anchor),
        end:   endOfMonth(anchor),
      });
    case 'jahr':
      return eachDayOfInterval({
        start: startOfYear(anchor),
        end:   endOfYear(anchor),
      });
  }
}

function getPeriodLabel(period: Period, anchor: Date): string {
  switch (period) {
    case 'woche': {
      const ws = startOfWeek(anchor, { weekStartsOn: 1 });
      const we = endOfWeek(anchor,   { weekStartsOn: 1 });
      return `KW ${format(ws, 'II', { locale: de })} · ${format(ws, 'd.M.', { locale: de })}–${format(we, 'd.M.yyyy', { locale: de })}`;
    }
    case 'monat':
      return format(anchor, 'MMMM yyyy', { locale: de });
    case 'jahr':
      return format(anchor, 'yyyy');
  }
}

function navAnchor(period: Period, anchor: Date, dir: 1 | -1): Date {
  switch (period) {
    case 'woche':  return dir === 1 ? addWeeks(anchor, 1)  : subWeeks(anchor, 1);
    case 'monat':  return dir === 1 ? addMonths(anchor, 1) : subMonths(anchor, 1);
    case 'jahr':   return dir === 1 ? addYears(anchor, 1)  : subYears(anchor, 1);
  }
}

// ── Deviance-Klasse ───────────────────────────────────────────────────────────

const pctCls = (pct: number) =>
  pct > 35  ? 'text-red-600 dark:text-red-400 font-medium' :
  pct > 28  ? 'text-amber-600 dark:text-amber-400 font-medium' :
  pct > 0   ? 'text-emerald-600 dark:text-emerald-400' :
  '';

// ── Hauptkomponente ───────────────────────────────────────────────────────────

export default function TagesControllingPage() {
  const { showNetRevenue } = useRevenueDisplay();
  const today = useMemo(() => new Date(), []);

  const [period, setPeriod]   = useState<Period>('monat');
  const [anchor, setAnchor]   = useState(today);
  const [dailyBudgets, setDailyBudgets] = useState(readDailyBudgets);
  const [employees, setEmployees]       = useState<EmployeeLite[]>([]);
  const [tick, setTick] = useState(0);

  // Employees einmalig laden (aus localStorage)
  useEffect(() => {
    setEmployees(loadEmployees());
  }, []);

  // dailyBudgets: sofort + bei Sync neu laden
  useEffect(() => {
    setDailyBudgets(readDailyBudgets());
    import('@/lib/supabase-kv').then(({ kvGet }) =>
      kvGet('dailyBudgets').then(r => {
        if (r && typeof r === 'object') setDailyBudgets(r as Record<string, { actualRevenue?: number; takeawayRevenue?: number }>);
      }).catch(() => {}),
    );
    const onSync = () => {
      setDailyBudgets(readDailyBudgets());
      setTick(t => t + 1);
    };
    window.addEventListener('supabase-kv-synced', onSync);
    return () => window.removeEventListener('supabase-kv-synced', onSync);
  }, []);

  // Tage der Periode
  const dates = useMemo(() => getPeriodDates(period, anchor), [period, anchor]);

  // Plan / Ist / WES-Maps berechnen
  const planMap   = useMemo(() => buildPlanCostMap(dates, employees),   [dates, employees, tick]);
  const actualMap = useMemo(() => buildActualCostMap(dates, employees), [dates, employees, tick]);
  const wesMap    = useMemo(() => buildWesMap(dates),                   [dates, tick]);

  // Zeilenberechnung
  const rows = useMemo((): ControllingRow[] => {
    return dates.map(day => {
      const d   = format(day, 'yyyy-MM-dd');
      const grossRev  = dailyBudgets[d]?.actualRevenue   ?? 0;
      const takeaway  = dailyBudgets[d]?.takeawayRevenue ?? 0;
      const umsatz    = showNetRevenue ? grossToNet(grossRev, takeaway) : grossRev;
      const pkPlanChf = planMap[d]   ?? 0;
      const pkIstChf  = actualMap[d] ?? 0;
      const wesChf    = wesMap[d]    ?? 0;
      return { date: d, day, umsatz, pkPlanChf, pkIstChf, wesChf };
    });
  }, [dates, dailyBudgets, planMap, actualMap, wesMap, showNetRevenue]);

  // Total-Zeile (gewichtete Prozente)
  const total = useMemo(() => {
    const sumUmsatz  = rows.reduce((s, r) => s + r.umsatz, 0);
    const sumPkPlan  = rows.reduce((s, r) => s + r.pkPlanChf, 0);
    const sumPkIst   = rows.reduce((s, r) => s + r.pkIstChf, 0);
    const sumWes     = rows.reduce((s, r) => s + r.wesChf, 0);
    const pkPlanPct  = sumUmsatz > 0 ? (sumPkPlan / sumUmsatz) * 100 : 0;
    const pkIstPct   = sumUmsatz > 0 ? (sumPkIst  / sumUmsatz) * 100 : 0;
    const wesPct     = sumUmsatz > 0 ? (sumWes    / sumUmsatz) * 100 : 0;
    return { sumUmsatz, sumPkPlan, sumPkIst, sumWes, pkPlanPct, pkIstPct, wesPct };
  }, [rows]);

  const navigate = useCallback((dir: 1 | -1) => {
    setAnchor(a => navAnchor(period, a, dir));
  }, [period]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  const PERIOD_BTNS: { key: Period; label: string; Icon: React.ElementType }[] = [
    { key: 'woche', label: 'Woche',  Icon: CalendarDays   },
    { key: 'monat', label: 'Monat',  Icon: Calendar       },
    { key: 'jahr',  label: 'Jahr',   Icon: CalendarRange  },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto max-w-[1600px] px-4 sm:px-6 py-3 flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold truncate">Tages-Controlling</h1>
            <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">
              Umsatz · Personalkosten Plan/Ist · Wareneinsatz
            </p>
          </div>

          {/* Periode-Auswahl */}
          <div className="flex rounded-lg border border-border overflow-hidden text-xs">
            {PERIOD_BTNS.map(({ key, label, Icon }) => (
              <button
                key={key}
                onClick={() => { setPeriod(key); setAnchor(today); }}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 transition-colors',
                  period === key
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Navigation */}
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium min-w-[180px] text-center">
              {getPeriodLabel(period, anchor)}
            </span>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {/* Heute-Button */}
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => setAnchor(today)}
          >
            Heute
          </Button>
        </div>
      </header>

      {/* ── Tabelle ──────────────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-[1600px] px-2 sm:px-4 py-4">
          <div className="rounded-xl border border-border overflow-hidden shadow-sm">
            <table className="w-full text-xs sm:text-sm border-collapse">
              <thead>
                {/* ── Spalten-Header ──────────────────────────────────────── */}
                <tr className="bg-muted/60 dark:bg-muted/30">
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground w-24">Datum</th>
                  <th className="px-2 py-2 text-center font-medium text-muted-foreground w-10">WT</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                    Ist-Umsatz CHF
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground border-l border-border/50">
                    PK Plan CHF
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                    PK Ist CHF
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground border-l border-border/50">
                    PK Plan %
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                    PK Ist %
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground border-l border-border/50">
                    WES CHF
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                    WES %
                  </th>
                </tr>

                {/* ── Total-Zeile (oben) ──────────────────────────────────── */}
                <tr className="bg-primary/5 dark:bg-primary/10 border-b-2 border-primary/20 font-semibold">
                  <td className="px-3 py-2 text-left text-[11px] text-muted-foreground uppercase tracking-wide" colSpan={2}>
                    Total
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtN(total.sumUmsatz)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums border-l border-border/50">
                    {fmtN(total.sumPkPlan)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {total.sumPkIst > 0 ? fmtN(total.sumPkIst) : <span className="text-muted-foreground font-normal">–</span>}
                  </td>
                  <td className={cn('px-3 py-2 text-right tabular-nums border-l border-border/50', pctCls(total.pkPlanPct))}>
                    {fmtPct(total.pkPlanPct, total.sumUmsatz > 0)}
                  </td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', pctCls(total.pkIstPct))}>
                    {fmtPct(total.pkIstPct, total.sumPkIst > 0 && total.sumUmsatz > 0)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums border-l border-border/50">
                    {total.sumWes > 0 ? fmtN(total.sumWes) : <span className="text-muted-foreground font-normal">–</span>}
                  </td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', pctCls(total.wesPct))}>
                    {fmtPct(total.wesPct, total.sumWes > 0 && total.sumUmsatz > 0)}
                  </td>
                </tr>
              </thead>

              <tbody>
                {rows.map(row => {
                  const isWeekend = row.day.getDay() === 0 || row.day.getDay() === 6;
                  const isToday   = format(row.day, 'yyyy-MM-dd') === format(today, 'yyyy-MM-dd');
                  const otherMonth = period === 'woche' ? false : !isSameMonth(row.day, anchor);
                  const pkPlanPct = row.umsatz > 0 ? (row.pkPlanChf / row.umsatz) * 100 : 0;
                  const pkIstPct  = row.umsatz > 0 && row.pkIstChf > 0 ? (row.pkIstChf  / row.umsatz) * 100 : 0;
                  const wesPct    = row.umsatz > 0 && row.wesChf  > 0 ? (row.wesChf   / row.umsatz) * 100 : 0;

                  return (
                    <tr
                      key={row.date}
                      className={cn(
                        'border-b border-border/40 transition-colors hover:bg-muted/30',
                        isToday && 'bg-blue-50/60 dark:bg-blue-950/20',
                        isWeekend && !isToday && 'bg-muted/20 dark:bg-muted/10',
                        otherMonth && 'opacity-40',
                      )}
                    >
                      {/* Datum */}
                      <td className="px-3 py-1.5 font-mono text-[11px] sm:text-xs text-muted-foreground whitespace-nowrap">
                        {format(row.day, 'dd.MM.yyyy')}
                        {isToday && <span className="ml-1 text-blue-600 dark:text-blue-400">◀</span>}
                      </td>

                      {/* Wochentag */}
                      <td className={cn(
                        'px-2 py-1.5 text-center text-[11px] font-medium',
                        isWeekend ? 'text-muted-foreground' : 'text-foreground',
                      )}>
                        {WT_ABBR[row.day.getDay()]}
                      </td>

                      {/* Ist-Umsatz */}
                      <td className={cn(
                        'px-3 py-1.5 text-right tabular-nums font-medium',
                        row.umsatz === 0 && 'text-muted-foreground',
                      )}>
                        {row.umsatz > 0 ? fmtN(row.umsatz) : '–'}
                      </td>

                      {/* PK Plan CHF */}
                      <td className="px-3 py-1.5 text-right tabular-nums border-l border-border/30 text-muted-foreground">
                        {row.pkPlanChf > 0 ? fmtN(row.pkPlanChf) : '–'}
                      </td>

                      {/* PK Ist CHF */}
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {row.pkIstChf > 0
                          ? <span className={cn(
                              row.pkIstChf > row.pkPlanChf && row.pkPlanChf > 0
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-foreground',
                            )}>{fmtN(row.pkIstChf)}</span>
                          : <span className="text-muted-foreground">–</span>}
                      </td>

                      {/* PK Plan % */}
                      <td className={cn('px-3 py-1.5 text-right tabular-nums border-l border-border/30', pctCls(pkPlanPct))}>
                        {row.umsatz > 0 && row.pkPlanChf > 0 ? fmtPct(pkPlanPct) : '–'}
                      </td>

                      {/* PK Ist % */}
                      <td className={cn('px-3 py-1.5 text-right tabular-nums', pctCls(pkIstPct))}>
                        {row.umsatz > 0 && row.pkIstChf > 0 ? fmtPct(pkIstPct) : '–'}
                      </td>

                      {/* WES CHF */}
                      <td className="px-3 py-1.5 text-right tabular-nums border-l border-border/30 text-muted-foreground">
                        {row.wesChf > 0 ? fmtN(row.wesChf) : '–'}
                      </td>

                      {/* WES % */}
                      <td className={cn('px-3 py-1.5 text-right tabular-nums', pctCls(wesPct))}>
                        {row.umsatz > 0 && row.wesChf > 0 ? fmtPct(wesPct) : '–'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Legende / Hinweise ──────────────────────────────────────────── */}
          <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-muted-foreground px-1">
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800" />
              Heute
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-muted/60 border border-border" />
              Wochenende
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-amber-600 dark:text-amber-400 font-medium">30–35 %</span>
              PK/WES – erhöht
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-red-600 dark:text-red-400 font-medium">&gt; 35 %</span>
              PK/WES – kritisch
            </div>
            <div className="ml-auto">
              PK Plan = Dienstplan × Stundenlohn &nbsp;·&nbsp;
              WES = Lieferantendokumente pro-rata &nbsp;·&nbsp;
              % = gewichtete Gesamtquote in Total-Zeile
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
