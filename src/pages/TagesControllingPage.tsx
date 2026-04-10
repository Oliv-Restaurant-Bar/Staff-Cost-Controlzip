/**
 * TagesControllingPage – Operatives Tages-Controlling
 * ====================================================
 * Route:  /tages-controlling   |  Nav: Verkauf → Tages-Controlling (adminOnly)
 *
 * Zeitraum-Modi: Woche · Monat · Jahr
 *
 * Spalten pro Tag:
 *   Datum | WT | Ist-Umsatz | PK Plan CHF | PK Ist CHF |
 *   Δ PK CHF | PK Plan % | PK Ist % | WES CHF | WES %
 *
 * Datenquellen:
 *   Umsatz     → dailyBudgets (localStorage / Supabase-KV)
 *   PK Plan    → schedule-v2-YYYY-MM (localStorage) × Stundenlohn
 *   PK Ist     → timeEntries (localStorage) × Stundenlohn
 *   WES        → getMonthSummary() (Lieferantendokumente) oder Buchhaltung (reporting_v1)
 *
 * Total-Zeile:
 *   CHF-Spalten = Summe; %-Spalten = Total Kosten / Total Umsatz (gewichtet)
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear,
  eachDayOfInterval, format, addWeeks, subWeeks, addMonths, subMonths,
  addYears, subYears, isSameMonth,
} from 'date-fns';
import { de } from 'date-fns/locale';
import {
  ChevronLeft, ChevronRight, CalendarDays, Calendar, CalendarRange,
  TrendingUp, TrendingDown, Loader2, FileDown, FileSpreadsheet, Pencil,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';
import { grossToNet } from '@/types/personnel';
import { kvSet } from '@/lib/supabase-kv';
import { getMonthSummary } from '@/lib/supplier-documents-store';
import { loadMonth, loadJournalEntries, loadJournalEntriesFromDB } from '@/lib/reporting-store';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';
import {
  loadScheduleForMonth,
  loadActualHoursForMonth,
  loadEmployees as loadEmployeesFromSupabase,
  type DaySchedule,
  type ActualHourEntry,
} from '@/lib/supabase-db';

// ── Typen ─────────────────────────────────────────────────────────────────────

type Period = 'woche' | 'monat' | 'jahr';

interface EmployeeLite {
  id: string;
  hourlyWage: number;
}

interface ControllingRow {
  date:       string;    // yyyy-MM-dd
  day:        Date;
  umsatz:     number;    // Ist-Umsatz Brutto
  pkPlanChf:  number;    // Personalkosten Plan CHF
  pkIstChf:   number;    // Personalkosten Ist CHF
  wesChf:     number;    // Wareneinsatz CHF (pro-rata aus Monatswert)
}

interface MonthRow {
  monthKey:  string;   // yyyy-MM
  label:     string;   // "Januar 2025"
  umsatz:    number;
  pkPlanChf: number;
  pkIstChf:  number;
  wesChf:    number;
}

// ── Konstanten ────────────────────────────────────────────────────────────────

const WT_ABBR = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;

// Default-Spaltenbreiten (px)
const DEFAULT_COL_WIDTHS: Record<string, number> = {
  datum: 110,
  wt: 40,
  umsatz: 130,
  pkPlan: 120,
  pkIst: 120,
  delta: 110,
  pkPlanPct: 100,
  pkIstPct: 100,
  wesChf: 110,
  wesPct: 90,
};

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

const NUM  = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const NUM1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtN   = (v: number) => NUM.format(Math.round(v));
const fmtPct = (v: number, active = true) =>
  active ? NUM1.format(v) + ' %' : '–';

function slotHours(slot: { start?: string; end?: string } | null | undefined): number {
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

/**
 * Liest Mitarbeiter — zuerst aus 'schedule-employees' localStorage, dann Fallback.
 */
function loadLocalEmployees(): EmployeeLite[] {
  try {
    const raw = localStorage.getItem('schedule-employees');
    if (raw) {
      const parsed = JSON.parse(raw) as Array<{ id: string; hourlyWage?: number; hourly_wage?: number }>;
      return parsed.map(e => ({ id: e.id, hourlyWage: Number(e.hourlyWage ?? e.hourly_wage) || 0 }));
    }
  } catch { /* ignore */ }
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
    { id: '21', hourlyWage: 20.36 }, { id: '24', hourlyWage: 20.36 },
    { id: '22', hourlyWage: 30.00 }, { id: '23', hourlyWage: 30.00 },
  ];
}

function readDailyBudgets(): Record<string, { actualRevenue?: number; takeawayRevenue?: number }> {
  try { return JSON.parse(localStorage.getItem('dailyBudgets') || '{}'); }
  catch { return {}; }
}

/**
 * Berechnet Plan-Personalkosten pro Tag aus Supabase-Schedule-Map.
 * Rückgabe: Map { 'yyyy-MM-dd' → CHF }
 */
function buildPlanCostFromSchedule(
  scheduleMap: Record<string, DaySchedule>,
  wageMap: Record<string, number>,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const [cellKey, ds] of Object.entries(scheduleMap)) {
    if (!ds) continue;
    const dateStr = cellKey.slice(-10);       // yyyy-MM-dd (last 10 chars)
    const empId   = cellKey.slice(0, -11);    // strip '-yyyy-MM-dd'
    const wage    = wageMap[empId] ?? 0;
    if (wage === 0) continue;
    const netH    = dayNetHours(ds);
    if (netH <= 0) continue;
    map[dateStr] = (map[dateStr] ?? 0) + netH * wage;
  }
  return map;
}

/**
 * Berechnet Ist-Personalkosten pro Tag aus Supabase-ActualHours-Map.
 * Rückgabe: Map { 'yyyy-MM-dd' → CHF }
 */
function buildActualCostFromHours(
  actualHoursMap: Record<string, ActualHourEntry>,
  wageMap: Record<string, number>,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const [cellKey, entry] of Object.entries(actualHoursMap)) {
    if (!entry || entry.hours <= 0) continue;
    const dateStr = cellKey.slice(-10);
    const empId   = cellKey.slice(0, -11);
    const wage    = wageMap[empId] ?? 0;
    if (wage === 0) continue;
    map[dateStr] = (map[dateStr] ?? 0) + entry.hours * wage;
  }
  return map;
}

/**
 * WES pro-rata: monatliche Gesamtkosten / Tage-im-Monat pro Tag.
 * Primär: Lieferantendokumente (supplier_docs_v1)
 * Fallback: Buchhaltungsdaten (reporting_v1) → wareneinsatz_* Kategorien
 * Rückgabe: Map { 'yyyy-MM-dd' → CHF }
 */
function buildWesMap(dates: Date[]): Record<string, number> {
  const monthGroups = new Map<string, Date[]>();
  for (const d of dates) {
    const mk = format(d, 'yyyy-MM');
    if (!monthGroups.has(mk)) monthGroups.set(mk, []);
    monthGroups.get(mk)!.push(d);
  }
  const map: Record<string, number> = {};
  for (const [mk, days] of monthGroups) {
    const [y, m] = mk.split('-').map(Number);

    // Primär: Lieferantendokumente (supplier_docs_v1)
    let total = 0;
    const summary = getMonthSummary(y, m);
    if (summary.totalCost > 0) {
      total = summary.totalCost;
    }

    // Fallback 1: reporting_v1 – wareneinsatz_* Kategorien
    if (total <= 0) {
      try {
        const rec = loadMonth(y, m);
        const warCats = rec.expenseCategories.filter(c =>
          c.categoryId.startsWith('wareneinsatz'),
        );
        total = warCats.reduce((s, c) => s + (c.amount ?? 0), 0);
      } catch { /* ignore */ }
    }

    // Fallback 2: Sage-Journal (sage_journal_v1) – Konten 4000–4999 (Wareneinsatz)
    if (total <= 0) {
      try {
        const entries = loadJournalEntries(y, m);
        total = entries
          .filter(e => {
            const nr = parseInt(e.accountNumber, 10);
            return nr >= 4000 && nr <= 4999;
          })
          .reduce((s, e) => s + (e.amount ?? 0), 0);
        if (total > 0) {
          console.log(`[WES] sage_journal Fallback ${mk}: ${entries.length} Einträge → ${total.toFixed(0)} CHF`);
        }
      } catch { /* ignore */ }
    }

    if (total <= 0) continue;
    const daysInMonth = endOfMonth(new Date(y, m - 1, 1)).getDate();
    const perDay = total / daysInMonth;
    for (const d of days) {
      map[format(d, 'yyyy-MM-dd')] = perDay;
    }
  }
  return map;
}

/**
 * Aggregiert ControllingRows monatsweise für die Jahresansicht.
 */
function buildMonthRows(rows: ControllingRow[]): MonthRow[] {
  const map = new Map<string, MonthRow>();
  for (const r of rows) {
    const mk = r.date.slice(0, 7); // yyyy-MM
    if (!map.has(mk)) {
      const [y, m] = mk.split('-').map(Number);
      const label = format(new Date(y, m - 1, 1), 'MMMM yyyy', { locale: de });
      map.set(mk, { monthKey: mk, label, umsatz: 0, pkPlanChf: 0, pkIstChf: 0, wesChf: 0 });
    }
    const mr = map.get(mk)!;
    mr.umsatz    += r.umsatz;
    mr.pkPlanChf += r.pkPlanChf;
    mr.pkIstChf  += r.pkIstChf;
    mr.wesChf    += r.wesChf;
  }
  return Array.from(map.values()).sort((a, b) => a.monthKey.localeCompare(b.monthKey));
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
  const [employees, setEmployees]     = useState<EmployeeLite[]>([]);
  const [scheduleMap, setScheduleMap] = useState<Record<string, DaySchedule>>({});
  const [actualHoursMap, setActualHoursMap] = useState<Record<string, ActualHourEntry>>({});
  const [loadingPK, setLoadingPK]     = useState(false);
  const [journalTick, setJournalTick] = useState(0);
  const loadGenRef = useRef(0);

  // ── Inline-Umsatz-Bearbeitung ─────────────────────────────────────────────
  const [editingDate, setEditingDate]   = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  const startEditUmsatz = (date: string, currentGross: number) => {
    setEditingDate(date);
    setEditingValue(currentGross > 0 ? String(Math.round(currentGross)) : '');
    setTimeout(() => { editInputRef.current?.select(); }, 30);
  };

  const commitUmsatzEdit = (date: string) => {
    const raw = editingValue.replace(/['''`\s]/g, '').replace(',', '.');
    const gross = parseFloat(raw);
    if (!isNaN(gross) && gross >= 0) {
      const updated = {
        ...dailyBudgets,
        [date]: { ...dailyBudgets[date], actualRevenue: gross },
      };
      setDailyBudgets(updated);
      localStorage.setItem('dailyBudgets', JSON.stringify(updated));
      kvSet('dailyBudgets', updated).catch(() => {});
    }
    setEditingDate(null);
  };

  // Spaltenbreiten (resizable)
  const [colWidths, setColWidths] = useState(DEFAULT_COL_WIDTHS);
  const resizingRef = useRef<{ col: string; startX: number; startW: number } | null>(null);

  function startResize(col: string, e: React.MouseEvent) {
    const startW = colWidths[col] ?? 100;
    resizingRef.current = { col, startX: e.clientX, startW };
    const onMove = (me: MouseEvent) => {
      if (!resizingRef.current) return;
      const { col: c, startX, startW: sw } = resizingRef.current;
      const newW = Math.max(50, sw + (me.clientX - startX));
      setColWidths(prev => ({ ...prev, [c]: newW }));
    };
    const onUp = () => {
      resizingRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  }

  // Employees: zuerst localStorage, dann Supabase
  useEffect(() => {
    setEmployees(loadLocalEmployees());
    loadEmployeesFromSupabase().then(emps => {
      if (emps && emps.length > 0) {
        setEmployees(emps.map(e => ({ id: e.id, hourlyWage: e.hourlyWage })));
      }
    }).catch(() => {});
  }, []);

  // dailyBudgets: sofort + bei Sync neu laden
  useEffect(() => {
    setDailyBudgets(readDailyBudgets());
    import('@/lib/supabase-kv').then(({ kvGet }) =>
      kvGet('dailyBudgets').then(r => {
        if (r && typeof r === 'object') setDailyBudgets(r as Record<string, { actualRevenue?: number; takeawayRevenue?: number }>);
      }).catch(() => {}),
    );
    const onSync = () => setDailyBudgets(readDailyBudgets());
    window.addEventListener('supabase-kv-synced', onSync);
    return () => window.removeEventListener('supabase-kv-synced', onSync);
  }, []);

  // Tage der Periode
  const dates = useMemo(() => getPeriodDates(period, anchor), [period, anchor]);

  // Plan & Ist-Stunden aus Supabase laden wenn sich Periode ändert
  useEffect(() => {
    const gen = ++loadGenRef.current;
    setLoadingPK(true);

    const monthSet = new Set<string>();
    for (const d of dates) monthSet.add(format(d, 'yyyy-MM'));
    const monthDates = Array.from(monthSet).map(mk => {
      const [y, m] = mk.split('-').map(Number);
      return new Date(y, m - 1, 1);
    });

    Promise.all([
      Promise.all(monthDates.map(md => loadScheduleForMonth(md))),
      Promise.all(monthDates.map(md => loadActualHoursForMonth(md))),
    ]).then(([schedules, actuals]) => {
      if (loadGenRef.current !== gen) return;
      const combined: Record<string, DaySchedule> = {};
      for (const s of schedules) if (s) Object.assign(combined, s);
      setScheduleMap(combined);

      const combinedAct: Record<string, ActualHourEntry> = {};
      for (const a of actuals) if (a) Object.assign(combinedAct, a);
      setActualHoursMap(combinedAct);
      setLoadingPK(false);
    }).catch(() => { if (loadGenRef.current === gen) setLoadingPK(false); });
  }, [dates]);

  // Sage-Journal für WES: bei jeder Periodenänderung aus Supabase laden
  useEffect(() => {
    const monthSet = new Set<string>();
    for (const d of dates) monthSet.add(format(d, 'yyyy-MM'));
    const pairs = Array.from(monthSet).map(mk => {
      const [y, m] = mk.split('-').map(Number);
      return { y, m };
    });
    Promise.all(pairs.map(({ y, m }) => loadJournalEntriesFromDB(y, m))).then(() => {
      setJournalTick(t => t + 1);
    }).catch(() => {});
  }, [dates]);

  // WageMap aus employees
  const wageMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of employees) m[e.id] = e.hourlyWage;
    return m;
  }, [employees]);

  // Plan / Ist / WES-Maps berechnen
  const planMap   = useMemo(() => buildPlanCostFromSchedule(scheduleMap, wageMap),   [scheduleMap, wageMap]);
  const actualMap = useMemo(() => buildActualCostFromHours(actualHoursMap, wageMap), [actualHoursMap, wageMap]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wesMap    = useMemo(() => buildWesMap(dates), [dates, journalTick]);

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

  // Monatszeilen für Jahresansicht
  const monthRows = useMemo((): MonthRow[] => {
    if (period !== 'jahr') return [];
    return buildMonthRows(rows);
  }, [period, rows]);

  const navigate = useCallback((dir: 1 | -1) => {
    setAnchor(a => navAnchor(period, a, dir));
  }, [period]);

  // ── Export PDF ───────────────────────────────────────────────────────────────

  const handleExportPDF = useCallback(async () => {
    const { default: jsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    doc.setFontSize(13);
    doc.text('Tages-Controlling', 14, 14);
    doc.setFontSize(9);
    doc.text(getPeriodLabel(period, anchor), 14, 20);
    doc.text(`Export: ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`, 14, 25);

    const fmtV = (v: number) => v > 0 ? NUM.format(Math.round(v)) : '–';
    const fmtP = (v: number, show: boolean) => show ? NUM1.format(v) + ' %' : '–';
    const fmtD = (ist: number, plan: number) => {
      if (ist === 0 || plan === 0) return '–';
      const d = ist - plan;
      return (d > 0 ? '+' : '') + NUM.format(Math.round(d));
    };

    if (period === 'jahr') {
      const head = [['Monat', 'Ist-Umsatz', 'PK Plan', 'PK Ist', 'Δ PK', 'PK Plan %', 'PK Ist %', 'WES CHF', 'WES %']];
      const totalPkPlanPct = total.sumUmsatz > 0 ? (total.sumPkPlan / total.sumUmsatz) * 100 : 0;
      const totalPkIstPct  = total.sumUmsatz > 0 && total.sumPkIst > 0 ? (total.sumPkIst / total.sumUmsatz) * 100 : 0;
      const totalWesPct    = total.sumUmsatz > 0 && total.sumWes > 0 ? (total.sumWes / total.sumUmsatz) * 100 : 0;
      const body = [
        ['TOTAL', fmtV(total.sumUmsatz), fmtV(total.sumPkPlan), fmtV(total.sumPkIst), fmtD(total.sumPkIst, total.sumPkPlan), fmtP(totalPkPlanPct, total.sumUmsatz > 0), fmtP(totalPkIstPct, total.sumPkIst > 0 && total.sumUmsatz > 0), fmtV(total.sumWes), fmtP(totalWesPct, total.sumWes > 0 && total.sumUmsatz > 0)],
        ...monthRows.map(mr => {
          const pp = mr.umsatz > 0 ? (mr.pkPlanChf / mr.umsatz) * 100 : 0;
          const pi = mr.umsatz > 0 && mr.pkIstChf > 0 ? (mr.pkIstChf / mr.umsatz) * 100 : 0;
          const wp = mr.umsatz > 0 && mr.wesChf   > 0 ? (mr.wesChf   / mr.umsatz) * 100 : 0;
          return [mr.label, fmtV(mr.umsatz), fmtV(mr.pkPlanChf), fmtV(mr.pkIstChf), fmtD(mr.pkIstChf, mr.pkPlanChf), fmtP(pp, mr.umsatz > 0 && mr.pkPlanChf > 0), fmtP(pi, mr.umsatz > 0 && mr.pkIstChf > 0), fmtV(mr.wesChf), fmtP(wp, mr.umsatz > 0 && mr.wesChf > 0)];
        }),
      ];
      autoTable(doc, { head, body, startY: 30, styles: { fontSize: 7, cellPadding: 2 }, headStyles: { fillColor: [55, 65, 81] }, bodyStyles: { valign: 'middle' }, alternateRowStyles: { fillColor: [248, 248, 250] } });
    } else {
      const head = [['Datum', 'WT', 'Ist-Umsatz', 'PK Plan', 'PK Ist', 'Δ PK', 'PK Plan %', 'PK Ist %', 'WES CHF', 'WES %']];
      const body = [
        ['TOTAL', '', fmtV(total.sumUmsatz), fmtV(total.sumPkPlan), total.sumPkIst > 0 ? fmtV(total.sumPkIst) : '–', fmtD(total.sumPkIst, total.sumPkPlan), fmtP(total.pkPlanPct, total.sumUmsatz > 0), fmtP(total.pkIstPct, total.sumPkIst > 0 && total.sumUmsatz > 0), total.sumWes > 0 ? fmtV(total.sumWes) : '–', fmtP(total.wesPct, total.sumWes > 0 && total.sumUmsatz > 0)],
        ...rows.map(r => {
          const pp = r.umsatz > 0 ? (r.pkPlanChf / r.umsatz) * 100 : 0;
          const pi = r.umsatz > 0 && r.pkIstChf > 0 ? (r.pkIstChf / r.umsatz) * 100 : 0;
          const wp = r.umsatz > 0 && r.wesChf   > 0 ? (r.wesChf   / r.umsatz) * 100 : 0;
          return [format(r.day, 'dd.MM.yyyy'), WT_ABBR[r.day.getDay()], fmtV(r.umsatz), fmtV(r.pkPlanChf), r.pkIstChf > 0 ? fmtV(r.pkIstChf) : '–', fmtD(r.pkIstChf, r.pkPlanChf), r.umsatz > 0 && r.pkPlanChf > 0 ? fmtP(pp, true) : '–', r.umsatz > 0 && r.pkIstChf > 0 ? fmtP(pi, true) : '–', r.wesChf > 0 ? fmtV(r.wesChf) : '–', r.umsatz > 0 && r.wesChf > 0 ? fmtP(wp, true) : '–'];
        }),
      ];
      autoTable(doc, { head, body, startY: 30, styles: { fontSize: 7, cellPadding: 2 }, headStyles: { fillColor: [55, 65, 81] }, bodyStyles: { valign: 'middle' }, alternateRowStyles: { fillColor: [248, 248, 250] } });
    }

    doc.save(`tages-controlling-${format(anchor, 'yyyy-MM')}.pdf`);
  }, [period, anchor, rows, monthRows, total]);

  // ── Export Excel ─────────────────────────────────────────────────────────────

  const handleExportExcel = useCallback(async () => {
    const XLSX = await import('xlsx');

    const fmtV = (v: number) => v > 0 ? Math.round(v) : 0;
    const fmtP = (v: number, show: boolean) => show ? Math.round(v * 10) / 10 : 0;
    const fmtD = (ist: number, plan: number) => ist > 0 && plan > 0 ? Math.round(ist - plan) : 0;

    const rows2d: (string | number)[][] = [];

    if (period === 'jahr') {
      rows2d.push(['Monat', 'Ist-Umsatz CHF', 'PK Plan CHF', 'PK Ist CHF', 'Δ PK CHF', 'PK Plan %', 'PK Ist %', 'WES CHF', 'WES %']);
      rows2d.push(['TOTAL', fmtV(total.sumUmsatz), fmtV(total.sumPkPlan), fmtV(total.sumPkIst), fmtD(total.sumPkIst, total.sumPkPlan), fmtP(total.pkPlanPct, total.sumUmsatz > 0), fmtP(total.pkIstPct, total.sumPkIst > 0 && total.sumUmsatz > 0), fmtV(total.sumWes), fmtP(total.wesPct, total.sumWes > 0 && total.sumUmsatz > 0)]);
      for (const mr of monthRows) {
        const pp = mr.umsatz > 0 ? (mr.pkPlanChf / mr.umsatz) * 100 : 0;
        const pi = mr.umsatz > 0 && mr.pkIstChf > 0 ? (mr.pkIstChf / mr.umsatz) * 100 : 0;
        const wp = mr.umsatz > 0 && mr.wesChf   > 0 ? (mr.wesChf   / mr.umsatz) * 100 : 0;
        rows2d.push([mr.label, fmtV(mr.umsatz), fmtV(mr.pkPlanChf), fmtV(mr.pkIstChf), fmtD(mr.pkIstChf, mr.pkPlanChf), fmtP(pp, mr.umsatz > 0 && mr.pkPlanChf > 0), fmtP(pi, mr.umsatz > 0 && mr.pkIstChf > 0), fmtV(mr.wesChf), fmtP(wp, mr.umsatz > 0 && mr.wesChf > 0)]);
      }
    } else {
      rows2d.push(['Datum', 'WT', 'Ist-Umsatz CHF', 'PK Plan CHF', 'PK Ist CHF', 'Δ PK CHF', 'PK Plan %', 'PK Ist %', 'WES CHF', 'WES %']);
      rows2d.push(['TOTAL', '', fmtV(total.sumUmsatz), fmtV(total.sumPkPlan), fmtV(total.sumPkIst), fmtD(total.sumPkIst, total.sumPkPlan), fmtP(total.pkPlanPct, total.sumUmsatz > 0), fmtP(total.pkIstPct, total.sumPkIst > 0 && total.sumUmsatz > 0), fmtV(total.sumWes), fmtP(total.wesPct, total.sumWes > 0 && total.sumUmsatz > 0)]);
      for (const r of rows) {
        const pp = r.umsatz > 0 ? (r.pkPlanChf / r.umsatz) * 100 : 0;
        const pi = r.umsatz > 0 && r.pkIstChf > 0 ? (r.pkIstChf / r.umsatz) * 100 : 0;
        const wp = r.umsatz > 0 && r.wesChf   > 0 ? (r.wesChf   / r.umsatz) * 100 : 0;
        rows2d.push([format(r.day, 'dd.MM.yyyy'), WT_ABBR[r.day.getDay()], fmtV(r.umsatz), fmtV(r.pkPlanChf), fmtV(r.pkIstChf), fmtD(r.pkIstChf, r.pkPlanChf), fmtP(pp, r.umsatz > 0 && r.pkPlanChf > 0), fmtP(pi, r.umsatz > 0 && r.pkIstChf > 0), fmtV(r.wesChf), fmtP(wp, r.umsatz > 0 && r.wesChf > 0)]);
      }
    }

    const ws = XLSX.utils.aoa_to_sheet(rows2d);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Tages-Controlling');
    XLSX.writeFile(wb, `tages-controlling-${format(anchor, 'yyyy-MM')}.xlsx`);
  }, [period, anchor, rows, monthRows, total]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  const PERIOD_BTNS: { key: Period; label: string; Icon: React.ElementType }[] = [
    { key: 'woche', label: 'Woche',  Icon: CalendarDays   },
    { key: 'monat', label: 'Monat',  Icon: Calendar       },
    { key: 'jahr',  label: 'Jahr',   Icon: CalendarRange  },
  ];

  // Hilfsfunktion: Resize-Handle
  function ResizeHandle({ col }: { col: string }) {
    return (
      <span
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize opacity-0 group-hover:opacity-100 hover:bg-primary/50 transition-opacity"
        onMouseDown={e => startResize(col, e)}
        style={{ userSelect: 'none' }}
      />
    );
  }

  function colStyle(col: string): React.CSSProperties {
    const w = colWidths[col] ?? 100;
    return { width: w, minWidth: w, maxWidth: w };
  }

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

          {/* Export-Buttons */}
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={handleExportPDF}
            >
              <FileDown className="h-3.5 w-3.5" />
              PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={handleExportExcel}
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              Excel
            </Button>
          </div>

          {/* Ladeanzeige PK */}
          {loadingPK && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="hidden sm:inline">PK lädt…</span>
            </div>
          )}
        </div>
      </header>

      {/* ── Tabelle ──────────────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-[1600px] px-2 sm:px-4 py-4">
          <div className="rounded-xl border border-border overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="text-xs sm:text-sm border-collapse" style={{ tableLayout: 'fixed', minWidth: '100%' }}>
                <thead className="sticky top-0 z-10">
                  {/* ── Spalten-Header ──────────────────────────────────────── */}
                  <tr className="bg-muted/80 dark:bg-muted/50 border-b border-border">
                    <th className="relative group px-3 py-2 text-left font-medium text-muted-foreground" style={colStyle('datum')}>
                      <span>{period === 'jahr' ? 'Monat' : 'Datum'}</span>
                      <ResizeHandle col="datum" />
                    </th>
                    {period !== 'jahr' && (
                      <th className="relative group px-2 py-2 text-center font-medium text-muted-foreground" style={colStyle('wt')}>
                        <span>WT</span>
                        <ResizeHandle col="wt" />
                      </th>
                    )}
                    <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground" style={colStyle('umsatz')} title="Klicken zum Bearbeiten (Brutto CHF)">
                      <span className="inline-flex items-center gap-1 justify-end">Ist-Umsatz CHF<Pencil className="h-2.5 w-2.5 opacity-40" /></span>
                      <ResizeHandle col="umsatz" />
                    </th>
                    <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground border-l border-border/50" style={colStyle('pkPlan')}>
                      <span>PK Plan CHF</span>
                      <ResizeHandle col="pkPlan" />
                    </th>
                    <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground" style={colStyle('pkIst')}>
                      <span>PK Ist CHF</span>
                      <ResizeHandle col="pkIst" />
                    </th>
                    <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground border-l border-border/50" style={colStyle('delta')}>
                      <span>Δ PK CHF</span>
                      <ResizeHandle col="delta" />
                    </th>
                    <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground border-l border-border/50" style={colStyle('pkPlanPct')}>
                      <span>PK Plan %</span>
                      <ResizeHandle col="pkPlanPct" />
                    </th>
                    <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground" style={colStyle('pkIstPct')}>
                      <span>PK Ist %</span>
                      <ResizeHandle col="pkIstPct" />
                    </th>
                    <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground border-l border-border/50" style={colStyle('wesChf')}>
                      <span>WES CHF</span>
                      <ResizeHandle col="wesChf" />
                    </th>
                    <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground" style={colStyle('wesPct')}>
                      <span>WES %</span>
                      <ResizeHandle col="wesPct" />
                    </th>
                  </tr>

                  {/* ── Total-Zeile (sticky, direkt unter Header) ──────────── */}
                  <tr className="bg-primary/5 dark:bg-primary/10 border-b-2 border-primary/20 font-semibold">
                    <td className="px-3 py-2 text-left text-[11px] text-muted-foreground uppercase tracking-wide" colSpan={period === 'jahr' ? 1 : 2} style={period === 'jahr' ? colStyle('datum') : { width: (colWidths.datum ?? 110) + (colWidths.wt ?? 40) }}>
                      Total
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums" style={colStyle('umsatz')}>
                      {fmtN(total.sumUmsatz)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums border-l border-border/50" style={colStyle('pkPlan')}>
                      {fmtN(total.sumPkPlan)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums" style={colStyle('pkIst')}>
                      {total.sumPkIst > 0 ? fmtN(total.sumPkIst) : <span className="text-muted-foreground font-normal">–</span>}
                    </td>
                    <td className={cn('px-3 py-2 text-right tabular-nums border-l border-border/50 font-semibold', (() => {
                      const d = total.sumPkIst - total.sumPkPlan;
                      if (total.sumPkIst === 0 || total.sumPkPlan === 0) return 'text-muted-foreground';
                      return d > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400';
                    })())} style={colStyle('delta')}>
                      {(() => {
                        if (total.sumPkIst === 0 || total.sumPkPlan === 0) return '–';
                        const d = total.sumPkIst - total.sumPkPlan;
                        return (d > 0 ? '+' : '') + fmtN(d);
                      })()}
                    </td>
                    <td className={cn('px-3 py-2 text-right tabular-nums border-l border-border/50', pctCls(total.pkPlanPct))} style={colStyle('pkPlanPct')}>
                      {fmtPct(total.pkPlanPct, total.sumUmsatz > 0)}
                    </td>
                    <td className={cn('px-3 py-2 text-right tabular-nums', pctCls(total.pkIstPct))} style={colStyle('pkIstPct')}>
                      {fmtPct(total.pkIstPct, total.sumPkIst > 0 && total.sumUmsatz > 0)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums border-l border-border/50" style={colStyle('wesChf')}>
                      {total.sumWes > 0 ? fmtN(total.sumWes) : <span className="text-muted-foreground font-normal">–</span>}
                    </td>
                    <td className={cn('px-3 py-2 text-right tabular-nums', pctCls(total.wesPct))} style={colStyle('wesPct')}>
                      {fmtPct(total.wesPct, total.sumWes > 0 && total.sumUmsatz > 0)}
                    </td>
                  </tr>
                </thead>

                <tbody>
                  {period === 'jahr'
                    /* ── Jahresansicht: 12 Monatszeilen ──────────────────────── */
                    ? monthRows.map(mr => {
                        const pkPlanPct = mr.umsatz > 0 ? (mr.pkPlanChf / mr.umsatz) * 100 : 0;
                        const pkIstPct  = mr.umsatz > 0 && mr.pkIstChf > 0 ? (mr.pkIstChf / mr.umsatz) * 100 : 0;
                        const wesPct    = mr.umsatz > 0 && mr.wesChf   > 0 ? (mr.wesChf   / mr.umsatz) * 100 : 0;
                        const isCurrentMonth = mr.monthKey === format(today, 'yyyy-MM');
                        return (
                          <tr
                            key={mr.monthKey}
                            className={cn(
                              'border-b border-border/40 transition-colors hover:bg-muted/30',
                              isCurrentMonth && 'bg-blue-50/60 dark:bg-blue-950/20',
                            )}
                          >
                            <td className="px-3 py-2 font-medium text-sm whitespace-nowrap" style={colStyle('datum')}>
                              {mr.label}
                              {isCurrentMonth && <span className="ml-1.5 text-blue-600 dark:text-blue-400 text-xs">◀</span>}
                            </td>
                            <td className={cn('px-3 py-2 text-right tabular-nums font-medium', mr.umsatz === 0 && 'text-muted-foreground')} style={colStyle('umsatz')}>
                              {mr.umsatz > 0 ? fmtN(mr.umsatz) : '–'}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums border-l border-border/30 text-muted-foreground" style={colStyle('pkPlan')}>
                              {mr.pkPlanChf > 0 ? fmtN(mr.pkPlanChf) : '–'}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums" style={colStyle('pkIst')}>
                              {mr.pkIstChf > 0
                                ? <span className={cn(mr.pkIstChf > mr.pkPlanChf && mr.pkPlanChf > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground')}>{fmtN(mr.pkIstChf)}</span>
                                : <span className="text-muted-foreground">–</span>}
                            </td>
                            {(() => {
                              const d = mr.pkIstChf - mr.pkPlanChf;
                              const show = mr.pkIstChf > 0 && mr.pkPlanChf > 0;
                              return (
                                <td className={cn('px-3 py-2 text-right tabular-nums border-l border-border/30', show ? (d > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400') : 'text-muted-foreground')} style={colStyle('delta')}>
                                  {show ? (d > 0 ? '+' : '') + fmtN(d) : '–'}
                                </td>
                              );
                            })()}
                            <td className={cn('px-3 py-2 text-right tabular-nums border-l border-border/30', pctCls(pkPlanPct))} style={colStyle('pkPlanPct')}>
                              {mr.umsatz > 0 && mr.pkPlanChf > 0 ? fmtPct(pkPlanPct) : '–'}
                            </td>
                            <td className={cn('px-3 py-2 text-right tabular-nums', pctCls(pkIstPct))} style={colStyle('pkIstPct')}>
                              {mr.umsatz > 0 && mr.pkIstChf > 0 ? fmtPct(pkIstPct) : '–'}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums border-l border-border/30 text-muted-foreground" style={colStyle('wesChf')}>
                              {mr.wesChf > 0 ? fmtN(mr.wesChf) : '–'}
                            </td>
                            <td className={cn('px-3 py-2 text-right tabular-nums', pctCls(wesPct))} style={colStyle('wesPct')}>
                              {mr.umsatz > 0 && mr.wesChf > 0 ? fmtPct(wesPct) : '–'}
                            </td>
                          </tr>
                        );
                      })
                    /* ── Wochen- / Monatsansicht: einzelne Tage ─────────────── */
                    : rows.map(row => {
                        const isWeekend  = row.day.getDay() === 0 || row.day.getDay() === 6;
                        const isToday    = format(row.day, 'yyyy-MM-dd') === format(today, 'yyyy-MM-dd');
                        const otherMonth = period === 'woche' ? false : !isSameMonth(row.day, anchor);
                        const pkPlanPct  = row.umsatz > 0 ? (row.pkPlanChf / row.umsatz) * 100 : 0;
                        const pkIstPct   = row.umsatz > 0 && row.pkIstChf > 0 ? (row.pkIstChf / row.umsatz) * 100 : 0;
                        const wesPct     = row.umsatz > 0 && row.wesChf   > 0 ? (row.wesChf   / row.umsatz) * 100 : 0;
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
                            <td className="px-3 py-1.5 font-mono text-[11px] sm:text-xs text-muted-foreground whitespace-nowrap" style={colStyle('datum')}>
                              {format(row.day, 'dd.MM.yyyy')}
                              {isToday && <span className="ml-1 text-blue-600 dark:text-blue-400">◀</span>}
                            </td>
                            <td className={cn('px-2 py-1.5 text-center text-[11px] font-medium', isWeekend ? 'text-muted-foreground' : 'text-foreground')} style={colStyle('wt')}>
                              {WT_ABBR[row.day.getDay()]}
                            </td>
                            <td
                              className={cn('px-0 py-0 text-right tabular-nums font-medium', row.umsatz === 0 && 'text-muted-foreground')}
                              style={colStyle('umsatz')}
                            >
                              {editingDate === row.date ? (
                                <input
                                  ref={editInputRef}
                                  type="text"
                                  inputMode="numeric"
                                  value={editingValue}
                                  onChange={e => setEditingValue(e.target.value)}
                                  onBlur={() => commitUmsatzEdit(row.date)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') { e.currentTarget.blur(); }
                                    if (e.key === 'Escape') { setEditingDate(null); }
                                  }}
                                  placeholder="Brutto CHF"
                                  className="w-full h-full px-3 py-1.5 text-right bg-blue-50 dark:bg-blue-950/40 border border-blue-400 dark:border-blue-600 rounded focus:outline-none font-medium tabular-nums text-xs"
                                  autoFocus
                                />
                              ) : (
                                <button
                                  onClick={() => startEditUmsatz(row.date, dailyBudgets[row.date]?.actualRevenue ?? 0)}
                                  title="Klicken zum Bearbeiten (Brutto CHF)"
                                  className="w-full px-3 py-1.5 text-right hover:bg-blue-50 dark:hover:bg-blue-950/20 rounded transition-colors cursor-text"
                                >
                                  {row.umsatz > 0 ? fmtN(row.umsatz) : '–'}
                                </button>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums border-l border-border/30 text-muted-foreground" style={colStyle('pkPlan')}>
                              {row.pkPlanChf > 0 ? fmtN(row.pkPlanChf) : '–'}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums" style={colStyle('pkIst')}>
                              {row.pkIstChf > 0
                                ? <span className={cn(row.pkIstChf > row.pkPlanChf && row.pkPlanChf > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground')}>{fmtN(row.pkIstChf)}</span>
                                : <span className="text-muted-foreground">–</span>}
                            </td>
                            {(() => {
                              const d = row.pkIstChf - row.pkPlanChf;
                              const show = row.pkIstChf > 0 && row.pkPlanChf > 0;
                              return (
                                <td className={cn('px-3 py-1.5 text-right tabular-nums border-l border-border/30', show ? (d > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400') : 'text-muted-foreground')} style={colStyle('delta')}>
                                  {show ? (d > 0 ? '+' : '') + fmtN(d) : '–'}
                                </td>
                              );
                            })()}
                            <td className={cn('px-3 py-1.5 text-right tabular-nums border-l border-border/30', pctCls(pkPlanPct))} style={colStyle('pkPlanPct')}>
                              {row.umsatz > 0 && row.pkPlanChf > 0 ? fmtPct(pkPlanPct) : '–'}
                            </td>
                            <td className={cn('px-3 py-1.5 text-right tabular-nums', pctCls(pkIstPct))} style={colStyle('pkIstPct')}>
                              {row.umsatz > 0 && row.pkIstChf > 0 ? fmtPct(pkIstPct) : '–'}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums border-l border-border/30 text-muted-foreground" style={colStyle('wesChf')}>
                              {row.wesChf > 0 ? fmtN(row.wesChf) : '–'}
                            </td>
                            <td className={cn('px-3 py-1.5 text-right tabular-nums', pctCls(wesPct))} style={colStyle('wesPct')}>
                              {row.umsatz > 0 && row.wesChf > 0 ? fmtPct(wesPct) : '–'}
                            </td>
                          </tr>
                        );
                      })
                  }
                </tbody>
              </table>
            </div>
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
              <span className="text-amber-600 dark:text-amber-400 font-medium">28–35 %</span>
              PK/WES – erhöht
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-red-600 dark:text-red-400 font-medium">&gt; 35 %</span>
              PK/WES – kritisch
            </div>
            <div className="ml-auto">
              PK Plan = Dienstplan × Stundenlohn &nbsp;·&nbsp;
              WES = Lieferantendoks. / Buchhaltung pro-rata &nbsp;·&nbsp;
              % = gewichtete Gesamtquote
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
