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
import { useTenant } from '@/contexts/TenantContext';
import { grossToNet } from '@/types/personnel';
import { kvSet } from '@/lib/supabase-kv';
import { loadMonthInvoices, kategorieFromKonto, type WarenKategorie } from '@/lib/waren-db';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';
import {
  loadScheduleForMonth,
  loadActualHoursForMonth,
  loadEmployees as loadEmployeesFromSupabase,
  type DaySchedule,
  type ActualHourEntry,
} from '@/lib/supabase-db';
import { getEffectiveWageBatch } from '@/lib/wage-history';

// ── Typen ─────────────────────────────────────────────────────────────────────

type Period = 'woche' | 'monat' | 'jahr';
type ViewMode = 'personal' | 'waren';
type CategoryFilter = 'total' | 'food' | 'beverage';

interface EmployeeLite {
  id: string;
  hourlyWage: number;
}

/** Strukturierter Warenkosteneintrags pro Tag (netto und brutto, aufgeteilt nach Kategorie) */
interface WarenkostenDay {
  totalNet:  number; totalGross:  number;
  foodNet:   number; foodGross:   number;
  bevNet:    number; bevGross:    number;
}

interface ControllingRow {
  date:       string;    // yyyy-MM-dd
  day:        Date;
  umsatz:     number;    // Ist-Umsatz (gemäss viewMode + showNetRevenue)
  umsatzFood: number;    // Food-Umsatz (roh, für Filter)
  umsatzBev:  number;    // Beverage-Umsatz (roh, für Filter)
  umsatzTotal: number;   // Total-Umsatz (für Filter)
  pkPlanChf:  number;    // Personalkosten Plan CHF
  pkIstChf:   number;    // Personalkosten Ist CHF
  wesChf:     number;    // Wareneinsatz CHF (gemäss viewMode + showNetRevenue)
  wesTotal:   number;    // Total WES (Netto oder Brutto je nach showNetRevenue)
  wesFood:    number;    // Food WES
  wesBev:     number;    // Beverage WES
}

interface MonthRow {
  monthKey:     string;   // yyyy-MM
  label:        string;   // "Januar 2025"
  umsatz:       number;   // gemäss viewMode
  umsatzTotal:  number;
  umsatzFood:   number;
  umsatzBev:    number;
  pkPlanChf:    number;   // CHF gesamt (alle Tage)
  pkIstChf:     number;
  wesChf:       number;   // gemäss viewMode
  wesFood:      number;
  wesBev:       number;
  // Nur Tage mit Umsatz > 0 (für korrekte %-Berechnung)
  pkPlanChfRev: number;
  pkIstChfRev:  number;
  wesChfRev:    number;
  wesFoodRev:   number;
  wesBevRev:    number;
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
  // Waren-Ansicht
  umsatzTotal: 130,
  umsatzFood:  120,
  umsatzBev:   120,
  wkFoodChf:   110,
  wkFoodPct:   90,
  wkBevChf:    110,
  wkBevPct:    90,
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
function loadLocalEmployees(keyFn: (k: string) => string = k => k): EmployeeLite[] {
  try {
    const raw = localStorage.getItem(keyFn('schedule-employees'));
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

function readDailyBudgets(keyFn: (k: string) => string = k => k): Record<string, { actualRevenue?: number; takeawayRevenue?: number }> {
  try { return JSON.parse(localStorage.getItem(keyFn('dailyBudgets')) || '{}'); }
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

/** Hilfsfunktion: Kategorie-Bucket für einen Tag initialisieren wenn nötig */
function ensureDayBucket(map: Record<string, WarenkostenDay>, date: string) {
  if (!map[date]) {
    map[date] = { totalNet: 0, totalGross: 0, foodNet: 0, foodGross: 0, bevNet: 0, bevGross: 0 };
  }
}

/** Hilfsfunktion: Betrag in den richtigen Kategorie-Bucket addieren */
function addToBucket(bucket: WarenkostenDay, kat: WarenKategorie, net: number, gross: number) {
  bucket.totalNet   += net;
  bucket.totalGross += gross;
  if (kat === 'Food') {
    bucket.foodNet   += net;
    bucket.foodGross += gross;
  } else if (kat === 'Beverage') {
    bucket.bevNet   += net;
    bucket.bevGross += gross;
  }
}

/**
 * Lädt echte Warenkosten (Tageswerte) aus den manuell erfassten
 * Lieferantenrechnungen (waren-db: supplier_invoice_entries).
 *
 * Kategorie-Quelle (Priorität):
 *   1. kontoSplits → jeder Split einzeln via kategorieFromKonto(split.warenkonto)
 *   2. Einzel-Rechnung → e.kategorie (explizit gespeichert), Fallback auf kategorieFromKonto(warenkonto)
 *
 * Rückgabe: Map { 'yyyy-MM-dd' → WarenkostenDay (Food/Bev/Total, netto+brutto) }
 */
async function loadWarenkostenMap(
  tenantId: import('@/contexts/TenantContext').TenantId,
  monthKeys: string[],
): Promise<Record<string, WarenkostenDay>> {
  const map: Record<string, WarenkostenDay> = {};
  for (const mk of monthKeys) {
    const entries = await loadMonthInvoices(tenantId, mk);
    for (const e of entries) {
      ensureDayBucket(map, e.date);

      if (e.kontoSplits && e.kontoSplits.length > 0) {
        // Split-Rechnung: jeder Split hat eigenes Warenkonto → Kategorie daraus ableiten
        for (const split of e.kontoSplits) {
          const kat = kategorieFromKonto(split.warenkonto);
          addToBucket(map[e.date], kat, split.amountNet, split.amountGross);
        }
      } else {
        // Einfache Rechnung: explizite Kategorie hat Vorrang, dann Konto-Ableitung
        const kat: WarenKategorie = e.kategorie ?? kategorieFromKonto(e.warenkonto);
        addToBucket(map[e.date], kat, e.amountNet, e.amountGross);
      }
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
      map.set(mk, {
        monthKey: mk, label,
        umsatz: 0, umsatzTotal: 0, umsatzFood: 0, umsatzBev: 0,
        pkPlanChf: 0, pkIstChf: 0, wesChf: 0, wesFood: 0, wesBev: 0,
        pkPlanChfRev: 0, pkIstChfRev: 0, wesChfRev: 0, wesFoodRev: 0, wesBevRev: 0,
      });
    }
    const mr = map.get(mk)!;
    mr.umsatz      += r.umsatz;
    mr.umsatzTotal += r.umsatzTotal;
    mr.umsatzFood  += r.umsatzFood;
    mr.umsatzBev   += r.umsatzBev;
    mr.pkPlanChf   += r.pkPlanChf;
    mr.pkIstChf    += r.pkIstChf;
    mr.wesChf      += r.wesChf;
    mr.wesFood     += r.wesFood;
    mr.wesBev      += r.wesBev;
    // Nur Tage mit Umsatz für %-Berechnung
    if (r.umsatz > 0) {
      mr.pkPlanChfRev += r.pkPlanChf;
      mr.pkIstChfRev  += r.pkIstChf;
      mr.wesChfRev    += r.wesChf;
    }
    if (r.umsatzFood > 0) mr.wesFoodRev += r.wesFood;
    if (r.umsatzBev  > 0) mr.wesBevRev  += r.wesBev;
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
  const { tenantId, tenantKey } = useTenant();
  const { showNetRevenue } = useRevenueDisplay();
  const today = useMemo(() => new Date(), []);

  const [period, setPeriod]   = useState<Period>('monat');
  const [anchor, setAnchor]   = useState(today);
  const [dailyBudgets, setDailyBudgets] = useState(() => readDailyBudgets(tenantKey));
  const [employees, setEmployees]     = useState<EmployeeLite[]>([]);
  const [scheduleMap, setScheduleMap] = useState<Record<string, DaySchedule>>({});
  const [actualHoursMap, setActualHoursMap] = useState<Record<string, ActualHourEntry>>({});
  const [loadingPK, setLoadingPK]           = useState(false);
  const [warenkostenMap, setWarenkostenMap] = useState<Record<string, WarenkostenDay>>({});
  const [viewMode,       setViewMode]       = useState<ViewMode>('personal');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('total');
  const loadGenRef = useRef(0);
  const warenGenRef = useRef(0);

  // ── Pro-Rata (Monatsansicht) ───────────────────────────────────────────────
  const [proRataMode, setProRataMode]       = useState<'off' | 'auto' | 'manual'>('off');
  const [manualCutoffDay, setManualCutoffDay] = useState<number>(1);

  // ── PDF-Export-Einstellungen ───────────────────────────────────────────────
  const [showWesInExport, setShowWesInExport] = useState(false);

  // ── Inline-Umsatz-Bearbeitung ─────────────────────────────────────────────
  const [editingDate, setEditingDate]   = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  const startEditUmsatz = (date: string) => {
    const db = dailyBudgets[date] as Record<string, number> | undefined;
    const current = categoryFilter === 'food'     ? (db?.foodRevenue     ?? 0)
      : categoryFilter === 'beverage'  ? (db?.beverageRevenue ?? 0)
      : (db?.actualRevenue   ?? 0);
    setEditingDate(date);
    setEditingValue(current > 0 ? String(Math.round(current)) : '');
    setTimeout(() => { editInputRef.current?.select(); }, 30);
  };

  const commitUmsatzEdit = (date: string) => {
    const raw = editingValue.replace(/['''`\s]/g, '').replace(',', '.');
    const gross = parseFloat(raw);
    if (!isNaN(gross) && gross >= 0) {
      const field = categoryFilter === 'food'    ? 'foodRevenue'
        : categoryFilter === 'beverage' ? 'beverageRevenue'
        : 'actualRevenue';
      const updated = {
        ...dailyBudgets,
        [date]: { ...dailyBudgets[date], [field]: gross },
      };
      setDailyBudgets(updated);
      localStorage.setItem(tenantKey('dailyBudgets'), JSON.stringify(updated));
      kvSet(tenantKey('dailyBudgets'), updated).catch(() => {});
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

  // Employees: zuerst localStorage, dann Supabase (mandantenfähig)
  useEffect(() => {
    setEmployees(loadLocalEmployees(tenantKey));
    // ─── TENANT FILTER: tenantId übergeben → nur Mitarbeiter des Mandanten ──
    loadEmployeesFromSupabase(tenantId).then(async emps => {
      if (emps && emps.length > 0) {
        const today = new Date().toISOString().split('T')[0];
        const wageHistory = await getEffectiveWageBatch(emps.map(e => e.id), today, tenantId);
        const mapped = emps.map(e => {
          // VZ/TZ employees may have hourlyWage=0 and use monthlySalary instead.
          // Compute effective hourly wage so plan-cost calculation works.
          let hw = wageHistory[e.id]?.hourlyWage || (e.hourlyWage ?? 0);
          if (hw === 0) {
            const monthly = e.monthlySalaryWith13th ?? e.monthlySalary ?? 0;
            const wh = e.weeklyHours ?? 42;
            if (monthly > 0 && wh > 0) hw = monthly / (wh * 4.3333);
          }
          return { id: e.id, hourlyWage: hw };
        });
        setEmployees(mapped);
        console.log(`[CONSISTENCY] tages_controlling employees: ${mapped.length}`);
        console.log(`[CONSISTENCY] tenant: ${tenantId}`);
        // Hard-block: Oliv-Leak in Beaulieu erkennen
        if (tenantId === 'beaulieu') {
          const olivNames = ['arber', 'artin', 'carlos', 'mendim', 'joana', 'husein'];
          const empsFromSupabase = emps.filter(e => e.name && olivNames.some(o => e.name.toLowerCase().includes(o)));
          if (empsFromSupabase.length > 0) {
            console.error(`[CONSISTENCY] mismatch: yes – Tages-Controlling hat Oliv-Mitarbeiter: ${empsFromSupabase.map(e => e.name).join(', ')}`);
          } else {
            console.log('[CONSISTENCY] mismatch: no');
          }
        }
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // dailyBudgets: sofort + bei Sync/Mandantenwechsel neu laden
  useEffect(() => {
    const local = readDailyBudgets(tenantKey);
    const localKeys = Object.keys(local).filter(k => (local[k]?.actualRevenue ?? 0) > 0).sort();
    console.log(`[UMSATZ][${tenantId}] localStorage keys with actualRevenue: [${localKeys.slice(-10).join(', ')}]`);
    setDailyBudgets(local);
    import('@/lib/supabase-kv').then(({ kvGet }) =>
      kvGet(tenantKey('dailyBudgets')).then(r => {
        if (r && typeof r === 'object') {
          const kvKeys = Object.keys(r as object).filter(k => ((r as Record<string, { actualRevenue?: number }>)[k]?.actualRevenue ?? 0) > 0).sort();
          console.log(`[UMSATZ][${tenantId}] Supabase KV keys: [${kvKeys.slice(-10).join(', ')}]`);
          const latestLocal = localKeys.at(-1) ?? '–';
          const latestKV    = kvKeys.at(-1) ?? '–';
          if (latestKV < latestLocal) {
            console.warn(`[UMSATZ][${tenantId}] Supabase KV STALE (${latestKV}) < localStorage (${latestLocal}) — using localStorage`);
            return;
          }
          setDailyBudgets(r as Record<string, { actualRevenue?: number; takeawayRevenue?: number }>);
        }
      }).catch(() => {}),
    );
    const onSync = () => {
      const synced = readDailyBudgets(tenantKey);
      const syncedKeys = Object.keys(synced).filter(k => (synced[k]?.actualRevenue ?? 0) > 0).sort();
      console.log(`[UMSATZ][${tenantId}] supabase-kv-synced: ${syncedKeys.length} Tage, latest=${syncedKeys.at(-1) ?? '–'}`);
      setDailyBudgets(synced);
    };
    window.addEventListener('supabase-kv-synced', onSync);
    return () => window.removeEventListener('supabase-kv-synced', onSync);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

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

  // Echte Warenkosten aus supplier_invoice_entries laden
  useEffect(() => {
    const gen = ++warenGenRef.current;
    const monthKeys = Array.from(new Set(dates.map(d => format(d, 'yyyy-MM'))));
    console.log(`[TAGES-CONTROLLING] warenkosten source: supplier_invoice_entries`);
    loadWarenkostenMap(tenantId, monthKeys).then(map => {
      if (warenGenRef.current !== gen) return;
      setWarenkostenMap(map);
      const totalChf = Object.values(map).reduce((s, v) => s + v.totalGross, 0);
      const days = Object.keys(map).filter(d => map[d].totalGross > 0).length;
      console.log(`[TAGES-CONTROLLING] wes columns replaced: yes`);
      console.log(`[WAREN] day total chf: ${totalChf.toFixed(2)} CHF über ${days} Tage`);
    }).catch((err) => {
      console.error('[WAREN] loadWarenkostenMap failed:', err);
      if (warenGenRef.current === gen) setWarenkostenMap({});
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dates, tenantId]);

  // WageMap aus employees
  const wageMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of employees) m[e.id] = e.hourlyWage;
    return m;
  }, [employees]);

  // Plan / Ist / Warenkosten-Maps berechnen
  const planMap   = useMemo(() => buildPlanCostFromSchedule(scheduleMap, wageMap),   [scheduleMap, wageMap]);
  const actualMap = useMemo(() => buildActualCostFromHours(actualHoursMap, wageMap), [actualHoursMap, wageMap]);

  // ── Pro-Rata: letzter Tag mit Umsatz im gewählten Monat (auto-Erkennung) ────
  const lastRevenueDayInMonth = useMemo(() => {
    if (period !== 'monat') return null;
    const prefix = format(anchor, 'yyyy-MM');
    let lastDay = 0;
    for (const [date, entry] of Object.entries(dailyBudgets)) {
      if (!date.startsWith(prefix)) continue;
      if ((entry?.actualRevenue ?? 0) > 0) {
        const day = parseInt(date.slice(8), 10);
        if (day > lastDay) lastDay = day;
      }
    }
    return lastDay > 0 ? lastDay : null;
  }, [period, anchor, dailyBudgets]);

  // ── Pro-Rata: effektiver Stichtag ─────────────────────────────────────────
  const effectiveCutoffDay = useMemo(() => {
    if (proRataMode === 'off')     return null;
    if (proRataMode === 'manual')  return manualCutoffDay;
    return lastRevenueDayInMonth;
  }, [proRataMode, manualCutoffDay, lastRevenueDayInMonth]);

  // Zeilenberechnung (wesChf = echte Warenkosten aus supplier_invoice_entries)
  const rows = useMemo((): ControllingRow[] => {
    return dates.map(day => {
      const d         = format(day, 'yyyy-MM-dd');
      const grossRev  = dailyBudgets[d]?.actualRevenue   ?? 0;
      const takeaway  = dailyBudgets[d]?.takeawayRevenue ?? 0;
      const foodGross = dailyBudgets[d]?.foodRevenue     ?? 0;
      const bevGross  = dailyBudgets[d]?.beverageRevenue ?? 0;

      // Umsätze (netto oder brutto)
      const umsatzTotal = showNetRevenue ? grossToNet(grossRev, takeaway) : grossRev;
      const umsatzFood  = showNetRevenue ? foodGross / (1 + 0.081) : foodGross;
      const umsatzBev   = showNetRevenue ? bevGross  / (1 + 0.081) : bevGross;

      // Warenkosten
      const wk        = warenkostenMap[d] ?? { totalNet: 0, totalGross: 0, foodNet: 0, foodGross: 0, bevNet: 0, bevGross: 0 };
      const wesTotal  = showNetRevenue ? wk.totalNet : wk.totalGross;
      const wesFood   = showNetRevenue ? wk.foodNet  : wk.foodGross;
      const wesBev    = showNetRevenue ? wk.bevNet   : wk.bevGross;

      // Gefilterte Werte für die Anzeige (abhängig von categoryFilter)
      const umsatz = categoryFilter === 'food'     ? umsatzFood
        : categoryFilter === 'beverage' ? umsatzBev
        : umsatzTotal;
      const wesChf = categoryFilter === 'food'     ? wesFood
        : categoryFilter === 'beverage' ? wesBev
        : wesTotal;

      const pkPlanChf = planMap[d]   ?? 0;
      const pkIstChf  = actualMap[d] ?? 0;
      return { date: d, day, umsatz, umsatzFood, umsatzBev, umsatzTotal, pkPlanChf, pkIstChf, wesChf, wesTotal, wesFood, wesBev };
    });
  }, [dates, dailyBudgets, planMap, actualMap, warenkostenMap, showNetRevenue, viewMode, categoryFilter]);

  // Total-Zeile (gewichtete Prozente; bei aktivem Pro-Rata nur bis Stichtag)
  // Wichtig: %-Werte nur auf Basis von Tagen mit vorhandenem Umsatz berechnen,
  // damit zukünftige Tage mit PK-Plan aber ohne Umsatz die Quote nicht verfälschen.
  const total = useMemo(() => {
    const baseRows = effectiveCutoffDay !== null
      ? rows.filter(r => parseInt(r.date.slice(8), 10) <= effectiveCutoffDay)
      : rows;
    const sumUmsatz     = baseRows.reduce((s, r) => s + r.umsatz, 0);
    const sumUmsatzTotal= baseRows.reduce((s, r) => s + r.umsatzTotal, 0);
    const sumUmsatzFood = baseRows.reduce((s, r) => s + r.umsatzFood, 0);
    const sumUmsatzBev  = baseRows.reduce((s, r) => s + r.umsatzBev, 0);
    const sumPkPlan     = baseRows.reduce((s, r) => s + r.pkPlanChf, 0);
    const sumPkIst      = baseRows.reduce((s, r) => s + r.pkIstChf, 0);
    const sumWes        = baseRows.reduce((s, r) => s + r.wesChf, 0);
    const sumWesFood    = baseRows.reduce((s, r) => s + r.wesFood, 0);
    const sumWesBev     = baseRows.reduce((s, r) => s + r.wesBev, 0);
    // Nur Tage mit Umsatz für %-Berechnung
    const revRows       = baseRows.filter(r => r.umsatz > 0);
    const revUmsatz     = revRows.reduce((s, r) => s + r.umsatz, 0);
    const revPkPlan     = revRows.reduce((s, r) => s + r.pkPlanChf, 0);
    const revPkIst      = revRows.reduce((s, r) => s + r.pkIstChf, 0);
    const revWes        = revRows.reduce((s, r) => s + r.wesChf, 0);
    const revRowsFood   = baseRows.filter(r => r.umsatzFood > 0);
    const revUmsatzFood = revRowsFood.reduce((s, r) => s + r.umsatzFood, 0);
    const revWesFood    = revRowsFood.reduce((s, r) => s + r.wesFood, 0);
    const revRowsBev    = baseRows.filter(r => r.umsatzBev > 0);
    const revUmsatzBev  = revRowsBev.reduce((s, r) => s + r.umsatzBev, 0);
    const revWesBev     = revRowsBev.reduce((s, r) => s + r.wesBev, 0);
    const pkPlanPct     = revUmsatz > 0 ? (revPkPlan / revUmsatz) * 100 : 0;
    const pkIstPct      = revUmsatz > 0 ? (revPkIst  / revUmsatz) * 100 : 0;
    const wesPct        = revUmsatz > 0 ? (revWes    / revUmsatz) * 100 : 0;
    const wesFoodPct    = revUmsatzFood > 0 ? (revWesFood / revUmsatzFood) * 100 : 0;
    const wesBevPct     = revUmsatzBev  > 0 ? (revWesBev  / revUmsatzBev)  * 100 : 0;
    return {
      sumUmsatz, sumUmsatzTotal, sumUmsatzFood, sumUmsatzBev,
      sumPkPlan, sumPkIst, sumWes, sumWesFood, sumWesBev,
      pkPlanPct, pkIstPct, wesPct, wesFoodPct, wesBevPct,
    };
  }, [rows, effectiveCutoffDay]);

  // Monatszeilen für Jahresansicht
  const monthRows = useMemo((): MonthRow[] => {
    if (period !== 'jahr') return [];
    return buildMonthRows(rows);
  }, [period, rows]);

  // ── Pro-Rata Debug-Logging ─────────────────────────────────────────────────
  useEffect(() => {
    if (proRataMode === 'off' || period !== 'monat') return;
    const monthLabel = format(anchor, 'MMMM yyyy', { locale: de });
    console.log(`[PRO-RATA] mode: ${proRataMode}`);
    console.log(`[PRO-RATA] Monat: ${monthLabel}`);
    console.log(`[PRO-RATA] letzter Umsatz-Tag (auto): ${lastRevenueDayInMonth ?? 'nicht erkannt'}`);
    console.log(`[PRO-RATA] effektiver Stichtag: ${effectiveCutoffDay ?? 'keiner'}`);
    const cutoffRows = effectiveCutoffDay !== null
      ? rows.filter(r => parseInt(r.date.slice(8), 10) <= effectiveCutoffDay)
      : rows;
    console.log(`[PRO-RATA] Zeilen eingeschlossen: ${cutoffRows.length} / ${rows.length}`);
    const tRev  = cutoffRows.reduce((s, r) => s + r.umsatz, 0);
    const tPlan = cutoffRows.reduce((s, r) => s + r.pkPlanChf, 0);
    const tIst  = cutoffRows.reduce((s, r) => s + r.pkIstChf, 0);
    const tWes  = cutoffRows.reduce((s, r) => s + r.wesChf, 0);
    console.log(`[PRO-RATA] Total Umsatz (cutoff): ${tRev.toFixed(0)} CHF`);
    console.log(`[PRO-RATA] Total PK Plan (cutoff): ${tPlan.toFixed(0)} CHF`);
    console.log(`[PRO-RATA] Total PK Ist (cutoff): ${tIst.toFixed(0)} CHF`);
    console.log(`[PRO-RATA] Total Warenkosten (cutoff): ${tWes.toFixed(0)} CHF`);
    console.log(`[WAREN] month total chf: ${tWes.toFixed(0)} CHF (pro-rata cutoff)`);
    const monthPct = tRev > 0 ? (tWes / tRev) * 100 : 0;
    console.log(`[WAREN] month total pct: ${monthPct.toFixed(1)}%`);
  }, [proRataMode, period, anchor, lastRevenueDayInMonth, effectiveCutoffDay, rows]);

  const navigate = useCallback((dir: 1 | -1) => {
    setAnchor(a => navAnchor(period, a, dir));
  }, [period]);

  // ── Export PDF ───────────────────────────────────────────────────────────────

  const handleExportPDF = useCallback(async () => {
    console.log('[PDF-EXPORT] Start | period:', period, '| anchor:', format(anchor, 'yyyy-MM-dd'), '| WES:', showWesInExport);
    const { default: jsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = 297; const M = 14;

    // ── Farben (analog Webapp) ─────────────────────────────────────────────
    const C_HEADER_BG: [number, number, number]  = [30, 41, 59];
    const C_HEADER_TXT: [number, number, number] = [255, 255, 255];
    const C_BLUE_TXT: [number, number, number]   = [29, 78, 216];
    const C_KPI_BG: [number, number, number]     = [248, 250, 252];
    const C_KPI_BORDER: [number, number, number] = [226, 232, 240];
    const C_GREEN_TXT: [number, number, number]  = [4, 120, 87];
    const C_RED_TXT: [number, number, number]    = [185, 28, 28];
    const C_MUTED: [number, number, number]      = [100, 116, 139];
    const C_TOTAL_BG: [number, number, number]   = [241, 245, 249];
    const C_TOTAL_TXT: [number, number, number]  = [15, 23, 42];
    const C_TEAL_TXT: [number, number, number]   = [15, 118, 110];

    const fmtV   = (v: number) => v > 0 ? NUM.format(Math.round(v)) : '–';
    const fmtP   = (v: number, show: boolean) => show ? NUM1.format(v) + ' %' : '–';
    const fmtD   = (ist: number, plan: number) => {
      if (ist === 0 || plan === 0) return '–';
      const d = ist - plan;
      return (d > 0 ? '+' : '') + NUM.format(Math.round(d));
    };
    const fmtCHF = (v: number) => v.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 });

    // ── Header Banner ──────────────────────────────────────────────────────
    doc.setFillColor(...C_HEADER_BG);
    doc.rect(0, 0, W, 22, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(...C_HEADER_TXT);
    doc.text('Tages-Controlling', M, 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text('Oliv Gastro AG', M, 16);
    doc.setFontSize(8);
    doc.setTextColor(...C_HEADER_TXT);
    doc.text(getPeriodLabel(period, anchor), W / 2, 10, { align: 'center' });
    const catSuffix = categoryFilter === 'food' ? ' · Food' : categoryFilter === 'beverage' ? ' · Beverage' : '';
    if (viewMode === 'waren') {
      doc.setFontSize(6.5);
      doc.setTextColor(45, 212, 191);
      doc.text(`Warenkostenansicht${catSuffix}`, W / 2, 16, { align: 'center' });
    } else if (categoryFilter !== 'total') {
      doc.setFontSize(6.5);
      doc.setTextColor(categoryFilter === 'food' ? 34 : 59, categoryFilter === 'food' ? 197 : 130, categoryFilter === 'food' ? 94 : 246);
      doc.text(`Kategorie: ${categoryFilter === 'food' ? 'Food' : 'Beverage'}`, W / 2, 16, { align: 'center' });
    } else if (showWesInExport) {
      doc.setFontSize(6.5);
      doc.setTextColor(180, 210, 180);
      doc.text('inkl. WES', W / 2, 16, { align: 'center' });
    }
    doc.setTextColor(...C_MUTED);
    doc.setFontSize(7);
    doc.text(`Export: ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`, W - M, 10, { align: 'right' });

    // ── KPI-Block ──────────────────────────────────────────────────────────
    let y = 28;
    const kpis: { label: string; value: string; accent: [number, number, number] }[] =
      viewMode === 'waren' ? [
        { label: 'Ist-Umsatz Total', value: fmtCHF(total.sumUmsatzTotal), accent: C_BLUE_TXT },
        { label: 'Ist-Umsatz Food',  value: total.sumUmsatzFood > 0 ? fmtCHF(total.sumUmsatzFood) : '–', accent: [22,163,74] as [number,number,number] },
        { label: 'Ist-Umsatz Bev',   value: total.sumUmsatzBev  > 0 ? fmtCHF(total.sumUmsatzBev)  : '–', accent: C_BLUE_TXT },
        { label: 'WK Food CHF', value: total.sumWesFood > 0 ? fmtCHF(total.sumWesFood) : '–', accent: C_TEAL_TXT },
        { label: 'WK Food %',   value: fmtP(total.wesFoodPct, total.sumWesFood > 0 && total.sumUmsatzFood > 0), accent: C_TEAL_TXT },
        { label: 'WK Bev CHF',  value: total.sumWesBev  > 0 ? fmtCHF(total.sumWesBev)  : '–', accent: C_TEAL_TXT },
        { label: 'WK Bev %',    value: fmtP(total.wesBevPct,  total.sumWesBev  > 0 && total.sumUmsatzBev  > 0), accent: C_TEAL_TXT },
      ] : [
        { label: 'Ist-Umsatz Total', value: fmtCHF(total.sumUmsatz), accent: C_BLUE_TXT },
        { label: 'PK Plan Total',    value: fmtCHF(total.sumPkPlan), accent: C_BLUE_TXT },
        { label: 'PK Ist Total',     value: total.sumPkIst > 0 ? fmtCHF(total.sumPkIst) : '–', accent: total.sumPkIst > 0 ? C_BLUE_TXT : C_MUTED },
        { label: 'PK Plan %',        value: fmtP(total.pkPlanPct, total.sumUmsatz > 0), accent: C_MUTED },
        { label: 'PK Ist %',         value: fmtP(total.pkIstPct, total.sumPkIst > 0 && total.sumUmsatz > 0), accent: total.pkIstPct > total.pkPlanPct && total.sumPkIst > 0 ? C_RED_TXT : C_GREEN_TXT },
        ...(showWesInExport ? [
          { label: 'Warenkosten Total', value: total.sumWes > 0 ? fmtCHF(total.sumWes) : '–', accent: C_TEAL_TXT },
          { label: 'Warenkosten %',     value: fmtP(total.wesPct, total.sumWes > 0 && total.sumUmsatz > 0), accent: C_TEAL_TXT },
        ] : []),
      ];
    const kW = (W - 2 * M - (kpis.length - 1) * 3) / kpis.length;
    kpis.forEach((k, i) => {
      const kx = M + i * (kW + 3);
      doc.setFillColor(...C_KPI_BG);
      doc.setDrawColor(...C_KPI_BORDER);
      doc.setLineWidth(0.3);
      doc.roundedRect(kx, y, kW, 18, 1.5, 1.5, 'FD');
      doc.setFillColor(...k.accent);
      doc.rect(kx, y + 2, 1.5, 14, 'F');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6);
      doc.setTextColor(...C_MUTED);
      doc.text(k.label.toUpperCase(), kx + 4, y + 6);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...k.accent);
      doc.text(k.value, kx + 4, y + 13);
    });

    y += 24;

    // ── Haupttabelle ──────────────────────────────────────────────────────
    console.log('[PDF-EXPORT] Tabelle | Zeilen:', period === 'jahr' ? monthRows.length : rows.length, '| WES-Spalten:', showWesInExport);

    if (period === 'jahr') {
      const C_GREEN_TXT_PDF: [number,number,number] = [22, 163, 74];
      if (viewMode === 'waren') {
        // ── Waren-Ansicht Jahrestabelle ──────────────────────────────────
        const head = [['Monat', 'Ist-Umsatz Total', 'Ist-Umsatz Food', 'Ist-Umsatz Bev', 'WK Food CHF', 'WK Food %', 'WK Bev CHF', 'WK Bev %']];
        const body: string[][] = [
          ['TOTAL', fmtV(total.sumUmsatzTotal), fmtV(total.sumUmsatzFood), fmtV(total.sumUmsatzBev), fmtV(total.sumWesFood), fmtP(total.wesFoodPct, total.sumWesFood > 0 && total.sumUmsatzFood > 0), fmtV(total.sumWesBev), fmtP(total.wesBevPct, total.sumWesBev > 0 && total.sumUmsatzBev > 0)],
          ...monthRows.map(mr => {
            const wfp = mr.umsatzFood > 0 && mr.wesFood > 0 ? (mr.wesFood / mr.umsatzFood) * 100 : 0;
            const wbp = mr.umsatzBev  > 0 && mr.wesBev  > 0 ? (mr.wesBev  / mr.umsatzBev)  * 100 : 0;
            return [mr.label, fmtV(mr.umsatzTotal), fmtV(mr.umsatzFood), fmtV(mr.umsatzBev), mr.wesFood > 0 ? fmtV(mr.wesFood) : '–', mr.umsatzFood > 0 && mr.wesFood > 0 ? fmtP(wfp, true) : '–', mr.wesBev > 0 ? fmtV(mr.wesBev) : '–', mr.umsatzBev > 0 && mr.wesBev > 0 ? fmtP(wbp, true) : '–'];
          }),
        ];
        autoTable(doc, {
          head, body, startY: y,
          styles: { fontSize: 7.5, cellPadding: { top: 2.5, right: 3, bottom: 2.5, left: 3 }, font: 'helvetica', valign: 'middle' },
          headStyles: { fillColor: C_HEADER_BG, textColor: C_HEADER_TXT, fontStyle: 'bold', halign: 'right' },
          columnStyles: { 0: { halign: 'left', fontStyle: 'normal' } },
          alternateRowStyles: { fillColor: [250, 251, 252] },
          didParseCell: (data) => {
            if (data.row.index === 0) { data.cell.styles.fillColor = C_TOTAL_BG; data.cell.styles.textColor = C_TOTAL_TXT; data.cell.styles.fontStyle = 'bold'; }
            if ([2, 4, 5].includes(data.column.index) && data.row.index > 0) data.cell.styles.textColor = C_GREEN_TXT_PDF;
            if ([3, 6, 7].includes(data.column.index) && data.row.index > 0) data.cell.styles.textColor = C_BLUE_TXT;
          },
        });
      } else {
        // ── Total-Ansicht Jahrestabelle ────────────────────────────────────
        const head = [['Monat', 'Ist-Umsatz', 'PK Plan CHF', 'PK Ist CHF', 'Δ PK CHF', 'PK Plan %', 'PK Ist %', ...(showWesInExport ? ['Warenkosten CHF', 'Warenkosten %'] : [])]];
        const body: string[][] = [
          // %-Werte aus total (bereits auf Umsatz-Tage beschränkt)
          ['TOTAL', fmtV(total.sumUmsatz), fmtV(total.sumPkPlan), fmtV(total.sumPkIst), fmtD(total.sumPkIst, total.sumPkPlan), fmtP(total.pkPlanPct, total.sumUmsatz > 0), fmtP(total.pkIstPct, total.sumPkIst > 0 && total.sumUmsatz > 0), ...(showWesInExport ? [fmtV(total.sumWes), fmtP(total.wesPct, total.sumWes > 0 && total.sumUmsatz > 0)] : [])],
          ...monthRows.map(mr => {
            const pp = mr.umsatz > 0 ? (mr.pkPlanChfRev / mr.umsatz) * 100 : 0;
            const pi = mr.umsatz > 0 && mr.pkIstChfRev > 0 ? (mr.pkIstChfRev / mr.umsatz) * 100 : 0;
            const wp = mr.umsatz > 0 && mr.wesChfRev   > 0 ? (mr.wesChfRev   / mr.umsatz) * 100 : 0;
            return [mr.label, fmtV(mr.umsatz), fmtV(mr.pkPlanChf), fmtV(mr.pkIstChf), fmtD(mr.pkIstChf, mr.pkPlanChf), fmtP(pp, mr.umsatz > 0 && mr.pkPlanChfRev > 0), fmtP(pi, mr.umsatz > 0 && mr.pkIstChfRev > 0), ...(showWesInExport ? [fmtV(mr.wesChf), fmtP(wp, mr.umsatz > 0 && mr.wesChfRev > 0)] : [])];
          }),
        ];
        autoTable(doc, {
          head, body, startY: y,
          styles: { fontSize: 7.5, cellPadding: { top: 2.5, right: 3, bottom: 2.5, left: 3 }, font: 'helvetica', valign: 'middle' },
          headStyles: { fillColor: C_HEADER_BG, textColor: C_HEADER_TXT, fontStyle: 'bold', halign: 'right' },
          columnStyles: { 0: { halign: 'left', fontStyle: 'normal' } },
          alternateRowStyles: { fillColor: [250, 251, 252] },
          didParseCell: (data) => {
            if (data.row.index === 0) { data.cell.styles.fillColor = C_TOTAL_BG; data.cell.styles.textColor = C_TOTAL_TXT; data.cell.styles.fontStyle = 'bold'; }
            if (data.column.index === 4 && data.row.index > 0) {
              const v = data.cell.raw as string;
              if (v && v !== '–') data.cell.styles.textColor = v.startsWith('+') ? C_RED_TXT : C_GREEN_TXT;
            }
            if (showWesInExport && data.column.index >= 7 && data.row.index > 0) data.cell.styles.textColor = C_TEAL_TXT;
          },
        });
      }
    } else {
      const C_GREEN_TXT_PDF: [number,number,number] = [22, 163, 74];
      if (viewMode === 'waren') {
        // ── Waren-Ansicht Tages-/Wochentabelle ────────────────────────────
        const head = [['Datum', 'WT', 'Ist-Umsatz Total', 'Ist-Umsatz Food', 'Ist-Umsatz Bev', 'WK Food CHF', 'WK Food %', 'WK Bev CHF', 'WK Bev %']];
        const body: string[][] = [
          ['TOTAL', '', fmtV(total.sumUmsatzTotal), fmtV(total.sumUmsatzFood), fmtV(total.sumUmsatzBev), fmtV(total.sumWesFood), fmtP(total.wesFoodPct, total.sumWesFood > 0 && total.sumUmsatzFood > 0), fmtV(total.sumWesBev), fmtP(total.wesBevPct, total.sumWesBev > 0 && total.sumUmsatzBev > 0)],
          ...rows.map(r => {
            const wfp = r.umsatzFood > 0 && r.wesFood > 0 ? (r.wesFood / r.umsatzFood) * 100 : 0;
            const wbp = r.umsatzBev  > 0 && r.wesBev  > 0 ? (r.wesBev  / r.umsatzBev)  * 100 : 0;
            return [format(r.day, 'dd.MM.yyyy'), WT_ABBR[r.day.getDay()], fmtV(r.umsatzTotal), r.umsatzFood > 0 ? fmtV(r.umsatzFood) : '–', r.umsatzBev > 0 ? fmtV(r.umsatzBev) : '–', r.wesFood > 0 ? fmtV(r.wesFood) : '–', r.umsatzFood > 0 && r.wesFood > 0 ? fmtP(wfp, true) : '–', r.wesBev > 0 ? fmtV(r.wesBev) : '–', r.umsatzBev > 0 && r.wesBev > 0 ? fmtP(wbp, true) : '–'];
          }),
        ];
        autoTable(doc, {
          head, body, startY: y,
          styles: { fontSize: 7.5, cellPadding: { top: 2.5, right: 3, bottom: 2.5, left: 3 }, font: 'helvetica', valign: 'middle' },
          headStyles: { fillColor: C_HEADER_BG, textColor: C_HEADER_TXT, fontStyle: 'bold', halign: 'right' },
          columnStyles: { 0: { halign: 'left' }, 1: { halign: 'center', textColor: C_MUTED } },
          alternateRowStyles: { fillColor: [250, 251, 252] },
          didParseCell: (data) => {
            if (data.row.index === 0) { data.cell.styles.fillColor = C_TOTAL_BG; data.cell.styles.textColor = C_TOTAL_TXT; data.cell.styles.fontStyle = 'bold'; }
            if ([3, 5, 6].includes(data.column.index) && data.row.index > 0) data.cell.styles.textColor = C_GREEN_TXT_PDF;
            if ([4, 7, 8].includes(data.column.index) && data.row.index > 0) data.cell.styles.textColor = C_BLUE_TXT;
          },
        });
      } else {
        // ── Total-Ansicht Tages-/Wochentabelle ────────────────────────────
        const head = [['Datum', 'WT', 'Ist-Umsatz', 'PK Plan CHF', 'PK Ist CHF', 'Δ PK CHF', 'PK Plan %', 'PK Ist %', ...(showWesInExport ? ['Warenkosten CHF', 'Warenkosten %'] : [])]];
        const body: string[][] = [
          ['TOTAL', '', fmtV(total.sumUmsatz), fmtV(total.sumPkPlan), total.sumPkIst > 0 ? fmtV(total.sumPkIst) : '–', fmtD(total.sumPkIst, total.sumPkPlan), fmtP(total.pkPlanPct, total.sumUmsatz > 0), fmtP(total.pkIstPct, total.sumPkIst > 0 && total.sumUmsatz > 0), ...(showWesInExport ? [total.sumWes > 0 ? fmtV(total.sumWes) : '–', fmtP(total.wesPct, total.sumWes > 0 && total.sumUmsatz > 0)] : [])],
          ...rows.map(r => {
            const pp = r.umsatz > 0 ? (r.pkPlanChf / r.umsatz) * 100 : 0;
            const pi = r.umsatz > 0 && r.pkIstChf > 0 ? (r.pkIstChf / r.umsatz) * 100 : 0;
            const wp = r.umsatz > 0 && r.wesChf   > 0 ? (r.wesChf   / r.umsatz) * 100 : 0;
            return [format(r.day, 'dd.MM.yyyy'), WT_ABBR[r.day.getDay()], fmtV(r.umsatz), fmtV(r.pkPlanChf), r.pkIstChf > 0 ? fmtV(r.pkIstChf) : '–', fmtD(r.pkIstChf, r.pkPlanChf), r.umsatz > 0 && r.pkPlanChf > 0 ? fmtP(pp, true) : '–', r.umsatz > 0 && r.pkIstChf > 0 ? fmtP(pi, true) : '–', ...(showWesInExport ? [r.wesChf > 0 ? fmtV(r.wesChf) : '–', r.umsatz > 0 && r.wesChf > 0 ? fmtP(wp, true) : '–'] : [])];
          }),
        ];
        autoTable(doc, {
          head, body, startY: y,
          styles: { fontSize: 7.5, cellPadding: { top: 2.5, right: 3, bottom: 2.5, left: 3 }, font: 'helvetica', valign: 'middle' },
          headStyles: { fillColor: C_HEADER_BG, textColor: C_HEADER_TXT, fontStyle: 'bold', halign: 'right' },
          columnStyles: {
            0: { halign: 'left' }, 1: { halign: 'center', textColor: C_MUTED },
            2: { textColor: C_BLUE_TXT }, 3: { textColor: C_BLUE_TXT },
          },
          alternateRowStyles: { fillColor: [250, 251, 252] },
          didParseCell: (data) => {
            if (data.row.index === 0) { data.cell.styles.fillColor = C_TOTAL_BG; data.cell.styles.textColor = C_TOTAL_TXT; data.cell.styles.fontStyle = 'bold'; }
            if (data.column.index === 5 && data.row.index > 0) {
              const v = data.cell.raw as string;
              if (v && v !== '–') data.cell.styles.textColor = v.startsWith('+') ? C_RED_TXT : C_GREEN_TXT;
            }
            if (data.column.index === 4 && data.row.index > 0) data.cell.styles.textColor = C_BLUE_TXT;
            if (showWesInExport && data.column.index >= 8 && data.row.index > 0) data.cell.styles.textColor = C_TEAL_TXT;
          },
        });
      }
    }

    // ── Footer ─────────────────────────────────────────────────────────────
    const pageCount = (doc as jsPDF & { getNumberOfPages(): number }).getNumberOfPages();
    const PH = doc.internal.pageSize.getHeight();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFillColor(...C_HEADER_BG);
      doc.rect(0, PH - 10, W, 10, 'F');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6);
      doc.setTextColor(180, 190, 210);
      doc.text('Oliv Gastro AG · Tages-Controlling · vertraulich', M, PH - 4);
      doc.text(`Seite ${i} / ${pageCount}`, W - M, PH - 4, { align: 'right' });
    }

    const filename = `tages-controlling-${format(anchor, 'yyyy-MM')}${viewMode === 'waren' ? '-warenkosten' : showWesInExport ? '-mit-WES' : ''}.pdf`;
    console.log('[PDF-EXPORT] Speichern:', filename, '| Seiten:', pageCount);
    doc.save(filename);
  }, [period, anchor, rows, monthRows, total, showWesInExport, viewMode, categoryFilter]);

  // ── Export Excel ─────────────────────────────────────────────────────────────

  const handleExportExcel = useCallback(async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Oliv Gastro AG';
    wb.created = new Date();

    // ── Farben ────────────────────────────────────────────────────────────
    const HEADER_BG  = '1E293B';
    const HEADER_FG  = 'FFFFFF';
    const TOTAL_BG   = 'F1F5F9';
    const TOTAL_FG   = '0F172A';
    const BLUE_FG    = '1D4ED8';
    const GREEN_FG   = '047857';
    const RED_FG     = 'B91C1C';
    const ALT_BG     = 'FAFBFC';

    const fmtV = (v: number) => v > 0 ? Math.round(v) : 0;
    const fmtP = (v: number, show: boolean) => show ? Math.round(v * 10) / 10 : 0;

    const ws = wb.addWorksheet('Tages-Controlling', { views: [{ state: 'frozen', ySplit: 3 }] });

    // ── Titel-Zeilen ─────────────────────────────────────────────────────
    ws.addRow(['Tages-Controlling — Oliv Gastro AG']);
    ws.addRow([getPeriodLabel(period, anchor), '', '', '', '', `Export: ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`]);
    ws.addRow([]);

    // Style Titelzeile
    const titleRow = ws.getRow(1);
    titleRow.height = 20;
    titleRow.font = { bold: true, size: 13, color: { argb: 'FF' + HEADER_BG } };

    const GREEN_FG_XLSX = '15803012'; // emerald
    const addHeaderStyle = (hRow: ReturnType<typeof ws.addRow>) => {
      hRow.height = 16;
      hRow.eachCell(cell => {
        cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + HEADER_BG } };
        cell.font   = { bold: true, color: { argb: 'FF' + HEADER_FG }, size: 9 };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FF94A3B8' } } };
        cell.alignment = { horizontal: 'right' };
      });
    };
    const addTotalStyle = (tRow: ReturnType<typeof ws.addRow>) => {
      tRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + TOTAL_BG } };
        cell.font = { bold: true, color: { argb: 'FF' + TOTAL_FG }, size: 9 };
        cell.alignment = { horizontal: 'right' };
      });
    };

    if (period === 'jahr') {
      if (viewMode === 'waren') {
        // ── Waren-Ansicht Jahres-Excel ────────────────────────────────────
        const hRow = ws.addRow(['Monat', 'Ist-Umsatz Total', 'Ist-Umsatz Food', 'Ist-Umsatz Bev', 'WK Food CHF', 'WK Food %', 'WK Bev CHF', 'WK Bev %']);
        addHeaderStyle(hRow);
        hRow.getCell(1).alignment = { horizontal: 'left' };

        const tRow = ws.addRow(['TOTAL', fmtV(total.sumUmsatzTotal), fmtV(total.sumUmsatzFood), fmtV(total.sumUmsatzBev), fmtV(total.sumWesFood), Math.round(total.wesFoodPct * 10) / 10, fmtV(total.sumWesBev), Math.round(total.wesBevPct * 10) / 10]);
        addTotalStyle(tRow);
        tRow.getCell(1).alignment = { horizontal: 'left' };

        monthRows.forEach((mr, idx) => {
          const wfp = mr.umsatzFood > 0 && mr.wesFood > 0 ? (mr.wesFood / mr.umsatzFood) * 100 : 0;
          const wbp = mr.umsatzBev  > 0 && mr.wesBev  > 0 ? (mr.wesBev  / mr.umsatzBev)  * 100 : 0;
          const r = ws.addRow([mr.label, fmtV(mr.umsatzTotal), fmtV(mr.umsatzFood), fmtV(mr.umsatzBev), mr.wesFood > 0 ? fmtV(mr.wesFood) : 0, Math.round(wfp * 10) / 10, mr.wesBev > 0 ? fmtV(mr.wesBev) : 0, Math.round(wbp * 10) / 10]);
          if (idx % 2 === 0) r.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + ALT_BG } }; });
          r.eachCell(c => { c.alignment = { horizontal: 'right' }; });
          r.getCell(1).alignment = { horizontal: 'left' };
          [3, 5, 6].forEach(i => { r.getCell(i).font = { color: { argb: 'FF' + GREEN_FG_XLSX } }; });
          [4, 7, 8].forEach(i => { r.getCell(i).font = { color: { argb: 'FF' + BLUE_FG } }; });
        });
        ws.columns = [{ width: 18 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 10 }, { width: 14 }, { width: 10 }];

        // Number formats
        const numFmt = '#,##0'; const pctFmt = '0.0"%"';
        ws.eachRow((row, rowNum) => {
          if (rowNum < 4) return;
          row.eachCell((cell, colNum) => {
            if (typeof cell.value === 'number') {
              if ([2, 3, 4, 5, 7].includes(colNum)) cell.numFmt = numFmt;
              if ([6, 8].includes(colNum))           cell.numFmt = pctFmt;
            }
          });
        });
      } else {
        // ── Personal-Ansicht Jahres-Excel ──────────────────────────────────
        const hRow = ws.addRow(['Monat', 'Ist-Umsatz CHF', 'PK Plan CHF', 'PK Ist CHF', 'Δ PK CHF', 'PK Plan %', 'PK Ist %', 'Warenkosten CHF', 'Warenkosten %']);
        addHeaderStyle(hRow);
        hRow.getCell(1).alignment = { horizontal: 'left' };

        // %-Werte aus total (bereits auf Umsatz-Tage beschränkt)
        const tRow = ws.addRow(['TOTAL', fmtV(total.sumUmsatz), fmtV(total.sumPkPlan), fmtV(total.sumPkIst), Math.round(total.sumPkIst - total.sumPkPlan), Math.round(total.pkPlanPct * 10) / 10, Math.round(total.pkIstPct * 10) / 10, fmtV(total.sumWes), Math.round(total.wesPct * 10) / 10]);
        addTotalStyle(tRow);
        tRow.getCell(1).alignment = { horizontal: 'left' };

        monthRows.forEach((mr, idx) => {
          const pp = mr.umsatz > 0 ? (mr.pkPlanChfRev / mr.umsatz) * 100 : 0;
          const pi = mr.umsatz > 0 && mr.pkIstChfRev > 0 ? (mr.pkIstChfRev / mr.umsatz) * 100 : 0;
          const wp = mr.umsatz > 0 && mr.wesChfRev   > 0 ? (mr.wesChfRev   / mr.umsatz) * 100 : 0;
          const delta = mr.pkIstChf > 0 && mr.pkPlanChf > 0 ? Math.round(mr.pkIstChf - mr.pkPlanChf) : 0;
          const r = ws.addRow([mr.label, fmtV(mr.umsatz), fmtV(mr.pkPlanChf), mr.pkIstChf > 0 ? fmtV(mr.pkIstChf) : 0, delta, fmtP(pp, mr.umsatz > 0 && mr.pkPlanChfRev > 0), fmtP(pi, mr.umsatz > 0 && mr.pkIstChfRev > 0), fmtV(mr.wesChf), fmtP(wp, mr.umsatz > 0 && mr.wesChfRev > 0)]);
          if (idx % 2 === 0) r.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + ALT_BG } }; });
          r.getCell(5).font = { color: { argb: 'FF' + (delta > 0 ? RED_FG : delta < 0 ? GREEN_FG : TOTAL_FG) } };
          r.eachCell(c => { c.alignment = { horizontal: 'right' }; });
          r.getCell(1).alignment = { horizontal: 'left' };
        });
        ws.columns = [{ width: 18 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 11 }, { width: 11 }, { width: 13 }, { width: 10 }];

        const numFmt = '#,##0'; const pctFmt = '0.0"%"';
        ws.eachRow((row, rowNum) => {
          if (rowNum < 4) return;
          row.eachCell((cell, colNum) => {
            if (typeof cell.value === 'number') {
              if ([2, 3, 4, 5, 8].includes(colNum)) cell.numFmt = numFmt;
              if ([6, 7, 9].includes(colNum))        cell.numFmt = pctFmt;
            }
          });
        });
      }
    } else {
      if (viewMode === 'waren') {
        // ── Waren-Ansicht Tages-/Wochen-Excel ────────────────────────────
        const hRow = ws.addRow(['Datum', 'WT', 'Ist-Umsatz Total', 'Ist-Umsatz Food', 'Ist-Umsatz Bev', 'WK Food CHF', 'WK Food %', 'WK Bev CHF', 'WK Bev %']);
        addHeaderStyle(hRow);
        hRow.getCell(1).alignment = { horizontal: 'left' };
        hRow.getCell(2).alignment = { horizontal: 'center' };

        const tRow = ws.addRow(['TOTAL', '', fmtV(total.sumUmsatzTotal), fmtV(total.sumUmsatzFood), fmtV(total.sumUmsatzBev), fmtV(total.sumWesFood), Math.round(total.wesFoodPct * 10) / 10, fmtV(total.sumWesBev), Math.round(total.wesBevPct * 10) / 10]);
        addTotalStyle(tRow);
        tRow.getCell(1).alignment = { horizontal: 'left' };

        rows.forEach((r, idx) => {
          const wfp = r.umsatzFood > 0 && r.wesFood > 0 ? (r.wesFood / r.umsatzFood) * 100 : 0;
          const wbp = r.umsatzBev  > 0 && r.wesBev  > 0 ? (r.wesBev  / r.umsatzBev)  * 100 : 0;
          const eRow = ws.addRow([format(r.day, 'dd.MM.yyyy'), WT_ABBR[r.day.getDay()], fmtV(r.umsatzTotal), r.umsatzFood > 0 ? fmtV(r.umsatzFood) : 0, r.umsatzBev > 0 ? fmtV(r.umsatzBev) : 0, r.wesFood > 0 ? fmtV(r.wesFood) : 0, Math.round(wfp * 10) / 10, r.wesBev > 0 ? fmtV(r.wesBev) : 0, Math.round(wbp * 10) / 10]);
          if (idx % 2 === 0) eRow.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + ALT_BG } }; });
          eRow.eachCell(c => { c.alignment = { horizontal: 'right' }; });
          eRow.getCell(1).alignment = { horizontal: 'left' };
          eRow.getCell(2).alignment = { horizontal: 'center' };
          [4, 6, 7].forEach(i => { eRow.getCell(i).font = { color: { argb: 'FF' + GREEN_FG_XLSX } }; });
          [5, 8, 9].forEach(i => { eRow.getCell(i).font = { color: { argb: 'FF' + BLUE_FG } }; });
        });
        ws.columns = [{ width: 13 }, { width: 5 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 10 }, { width: 14 }, { width: 10 }];

        const numFmt = '#,##0'; const pctFmt = '0.0"%"';
        ws.eachRow((row, rowNum) => {
          if (rowNum < 4) return;
          row.eachCell((cell, colNum) => {
            if (typeof cell.value === 'number') {
              if ([3, 4, 5, 6, 8].includes(colNum)) cell.numFmt = numFmt;
              if ([7, 9].includes(colNum))           cell.numFmt = pctFmt;
            }
          });
        });
      } else {
        // ── Personal-Ansicht Tages-/Wochen-Excel ──────────────────────────
        const hRow = ws.addRow(['Datum', 'WT', 'Ist-Umsatz CHF', 'PK Plan CHF', 'PK Ist CHF', 'Δ PK CHF', 'PK Plan %', 'PK Ist %', 'Warenkosten CHF', 'Warenkosten %']);
        addHeaderStyle(hRow);
        hRow.getCell(1).alignment = { horizontal: 'left' };
        hRow.getCell(2).alignment = { horizontal: 'center' };

        const tRow = ws.addRow(['TOTAL', '', fmtV(total.sumUmsatz), fmtV(total.sumPkPlan), fmtV(total.sumPkIst), Math.round(total.sumPkIst - total.sumPkPlan), Math.round(total.pkPlanPct * 10) / 10, Math.round(total.pkIstPct * 10) / 10, fmtV(total.sumWes), Math.round(total.wesPct * 10) / 10]);
        addTotalStyle(tRow);
        tRow.getCell(1).alignment = { horizontal: 'left' };

        rows.forEach((r, idx) => {
          const pp = r.umsatz > 0 ? (r.pkPlanChf / r.umsatz) * 100 : 0;
          const pi = r.umsatz > 0 && r.pkIstChf > 0 ? (r.pkIstChf / r.umsatz) * 100 : 0;
          const wp = r.umsatz > 0 && r.wesChf   > 0 ? (r.wesChf   / r.umsatz) * 100 : 0;
          const delta = r.pkIstChf > 0 && r.pkPlanChf > 0 ? Math.round(r.pkIstChf - r.pkPlanChf) : 0;
          const eRow = ws.addRow([format(r.day, 'dd.MM.yyyy'), WT_ABBR[r.day.getDay()], fmtV(r.umsatz), fmtV(r.pkPlanChf), r.pkIstChf > 0 ? fmtV(r.pkIstChf) : 0, delta, fmtP(pp, r.umsatz > 0 && r.pkPlanChf > 0), fmtP(pi, r.umsatz > 0 && r.pkIstChf > 0), r.wesChf > 0 ? fmtV(r.wesChf) : 0, fmtP(wp, r.umsatz > 0 && r.wesChf > 0)]);
          if (idx % 2 === 0) eRow.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + ALT_BG } }; });
          eRow.getCell(3).font = { color: { argb: 'FF' + BLUE_FG } };
          eRow.getCell(4).font = { color: { argb: 'FF' + BLUE_FG } };
          eRow.getCell(6).font = { color: { argb: 'FF' + (delta > 0 ? RED_FG : delta < 0 ? GREEN_FG : TOTAL_FG) } };
          eRow.eachCell(c => { c.alignment = { horizontal: 'right' }; });
          eRow.getCell(1).alignment = { horizontal: 'left' };
          eRow.getCell(2).alignment = { horizontal: 'center' };
        });
        ws.columns = [{ width: 13 }, { width: 5 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 11 }, { width: 11 }, { width: 13 }, { width: 10 }];

        const numFmt = '#,##0'; const pctFmt = '0.0"%"';
        ws.eachRow((row, rowNum) => {
          if (rowNum < 4) return;
          row.eachCell((cell, colNum) => {
            if (typeof cell.value === 'number') {
              if ([3, 4, 5, 6, 9].includes(colNum)) cell.numFmt = numFmt;
              if ([7, 8, 10].includes(colNum))       cell.numFmt = pctFmt;
            }
          });
        });
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `tages-controlling-${format(anchor, 'yyyy-MM')}${viewMode === 'waren' ? '-warenkosten' : ''}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [period, anchor, rows, monthRows, total, viewMode, categoryFilter]);

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
              Umsatz · Personalkosten Plan/Ist · Warenkosten
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

          {/* Ansichts-Toggle: Personal | Warenkosten */}
          <div className="flex rounded-lg border border-border overflow-hidden text-xs font-medium">
            {([
              { key: 'personal', label: 'Personal',    active: 'bg-primary text-primary-foreground' },
              { key: 'waren',    label: 'Warenkosten', active: 'bg-teal-600 text-white' },
            ] as { key: ViewMode; label: string; active: string }[]).map(btn => (
              <button
                key={btn.key}
                onClick={() => setViewMode(btn.key)}
                className={cn(
                  'px-2.5 py-1.5 transition-colors border-l border-border first:border-l-0',
                  viewMode === btn.key ? btn.active : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {btn.label}
              </button>
            ))}
          </div>

          {/* Kategorie-Filter: Total | Food | Beverage */}
          <div className="flex rounded-lg border border-border overflow-hidden text-xs font-medium">
            {([
              { key: 'total',    label: 'Total',    active: 'bg-slate-700 text-white' },
              { key: 'food',     label: 'Food',     active: 'bg-emerald-600 text-white' },
              { key: 'beverage', label: 'Beverage', active: 'bg-blue-600 text-white' },
            ] as { key: CategoryFilter; label: string; active: string }[]).map(btn => (
              <button
                key={btn.key}
                onClick={() => setCategoryFilter(btn.key)}
                title={
                  btn.key === 'total'    ? 'Alle Kategorien (Total-Umsatz + Total-Warenkosten)'
                  : btn.key === 'food'  ? 'Nur Food: Food-Umsatz + Food-Warenkosten (ohne Diverses)'
                  : 'Nur Beverage: Bev-Umsatz + Bev-Warenkosten (ohne Diverses)'
                }
                className={cn(
                  'px-2.5 py-1.5 transition-colors border-l border-border first:border-l-0',
                  categoryFilter === btn.key ? btn.active : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {btn.label}
              </button>
            ))}
          </div>

          {/* Export-Buttons */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowWesInExport(v => !v)}
              title="Warenkosten-Spalten im Export ein-/ausblenden"
              className={cn(
                'h-8 px-2.5 text-xs rounded border transition-colors font-medium',
                showWesInExport
                  ? 'bg-teal-600 text-white border-teal-600 hover:bg-teal-700'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              Waren
            </button>
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

          {/* ── Pro-Rata Stichtag (nur Monatsansicht) ─────────────────────── */}
          {period === 'monat' && (
            <div className="flex items-center gap-2 border-l border-border pl-3">
              <span className="text-xs text-muted-foreground font-medium hidden sm:inline">Pro Rata</span>
              <div className="flex rounded border border-border overflow-hidden text-xs">
                {(['off', 'auto', 'manual'] as const).map(mode => (
                  <button
                    key={mode}
                    onClick={() => setProRataMode(mode)}
                    className={cn(
                      'px-2.5 py-1 transition-colors',
                      proRataMode === mode
                        ? 'bg-amber-500 text-white font-semibold'
                        : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {mode === 'off' ? 'Aus' : mode === 'auto' ? 'Auto' : 'Manuell'}
                  </button>
                ))}
              </div>
              {proRataMode === 'manual' && (
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={manualCutoffDay}
                  onChange={e => setManualCutoffDay(Math.max(1, Math.min(31, parseInt(e.target.value) || 1)))}
                  className="w-14 h-7 text-xs border border-border rounded px-2 bg-background tabular-nums"
                  placeholder="Tag"
                />
              )}
              {proRataMode !== 'off' && effectiveCutoffDay !== null && (
                <span className="text-xs text-amber-600 dark:text-amber-400 font-medium whitespace-nowrap">
                  bis {effectiveCutoffDay}. {format(anchor, 'MMMM', { locale: de })}
                  {proRataMode === 'auto' ? ' (auto)' : ''}
                </span>
              )}
              {proRataMode === 'auto' && lastRevenueDayInMonth === null && (
                <span className="text-xs text-red-500 whitespace-nowrap">kein Umsatz erkannt</span>
              )}
            </div>
          )}

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
                    {viewMode === 'personal' ? (<>
                      {/* ── Personal-Ansicht: Umsatz + PK + WES ─────────────────── */}
                      <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground" style={colStyle('umsatz')} title="Klicken zum Bearbeiten (Brutto CHF)">
                        <span className="inline-flex items-center gap-1 justify-end">
                          {categoryFilter === 'food' ? 'Ist-Umsatz Food' : categoryFilter === 'beverage' ? 'Ist-Umsatz Bev' : 'Ist-Umsatz CHF'}
                          <Pencil className="h-2.5 w-2.5 opacity-40" />
                        </span>
                        <ResizeHandle col="umsatz" />
                      </th>
                      <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground border-l border-border/50" style={colStyle('pkPlan')}>
                        <span>PK Plan CHF</span><ResizeHandle col="pkPlan" />
                      </th>
                      <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground" style={colStyle('pkIst')}>
                        <span>PK Ist CHF</span><ResizeHandle col="pkIst" />
                      </th>
                      <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground border-l border-border/50" style={colStyle('delta')}>
                        <span>Δ PK CHF</span><ResizeHandle col="delta" />
                      </th>
                      <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground border-l border-border/50" style={colStyle('pkPlanPct')}>
                        <span>PK Plan %</span><ResizeHandle col="pkPlanPct" />
                      </th>
                      <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground" style={colStyle('pkIstPct')}>
                        <span>PK Ist %</span><ResizeHandle col="pkIstPct" />
                      </th>
                      <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground border-l border-border/50" style={colStyle('wesChf')}>
                        <span>
                          {categoryFilter === 'food' ? 'WK Food CHF' : categoryFilter === 'beverage' ? 'WK Bev CHF' : 'Warenkosten CHF'}
                        </span>
                        <ResizeHandle col="wesChf" />
                      </th>
                      <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground" style={colStyle('wesPct')}>
                        <span>
                          {categoryFilter === 'food' ? 'WK Food %' : categoryFilter === 'beverage' ? 'WK Bev %' : 'Warenkosten %'}
                        </span>
                        <ResizeHandle col="wesPct" />
                      </th>
                    </>) : (<>
                      {/* ── Waren-Ansicht: Umsatz-Split + WK Food/Bev ────────── */}
                      <th className="relative group px-3 py-2 text-right font-medium text-muted-foreground" style={colStyle('umsatzTotal')} title="Klicken zum Bearbeiten (Brutto CHF)">
                        <span className="inline-flex items-center gap-1 justify-end">Ist-Umsatz Total<Pencil className="h-2.5 w-2.5 opacity-40" /></span>
                        <ResizeHandle col="umsatzTotal" />
                      </th>
                      <th className="relative group px-3 py-2 text-right font-medium text-emerald-700 dark:text-emerald-400 border-l border-border/50" style={colStyle('umsatzFood')}>
                        <span>Ist-Umsatz Food</span><ResizeHandle col="umsatzFood" />
                      </th>
                      <th className="relative group px-3 py-2 text-right font-medium text-blue-700 dark:text-blue-400" style={colStyle('umsatzBev')}>
                        <span>Ist-Umsatz Beverage</span><ResizeHandle col="umsatzBev" />
                      </th>
                      <th className="relative group px-3 py-2 text-right font-medium text-emerald-700 dark:text-emerald-400 border-l border-border/50" style={colStyle('wkFoodChf')}>
                        <span>WK Food CHF</span><ResizeHandle col="wkFoodChf" />
                      </th>
                      <th className="relative group px-3 py-2 text-right font-medium text-emerald-700 dark:text-emerald-400" style={colStyle('wkFoodPct')}>
                        <span>WK Food %</span><ResizeHandle col="wkFoodPct" />
                      </th>
                      <th className="relative group px-3 py-2 text-right font-medium text-blue-700 dark:text-blue-400 border-l border-border/50" style={colStyle('wkBevChf')}>
                        <span>WK Bev CHF</span><ResizeHandle col="wkBevChf" />
                      </th>
                      <th className="relative group px-3 py-2 text-right font-medium text-blue-700 dark:text-blue-400" style={colStyle('wkBevPct')}>
                        <span>WK Bev %</span><ResizeHandle col="wkBevPct" />
                      </th>
                    </>)}
                  </tr>

                  {/* ── Total-Zeile (sticky, direkt unter Header) ──────────── */}
                  <tr className={cn(
                    'border-b-2 font-semibold',
                    effectiveCutoffDay !== null
                      ? 'bg-amber-50/60 dark:bg-amber-900/20 border-amber-300/50'
                      : 'bg-primary/5 dark:bg-primary/10 border-primary/20',
                  )}>
                    <td className="px-3 py-2 text-left" colSpan={period === 'jahr' ? 1 : 2} style={period === 'jahr' ? colStyle('datum') : { width: (colWidths.datum ?? 110) + (colWidths.wt ?? 40) }}>
                      <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Total</span>
                      {effectiveCutoffDay !== null && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-700 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                          bis {effectiveCutoffDay}.
                        </span>
                      )}
                    </td>
                    {viewMode === 'personal' ? (<>
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
                    </>) : (<>
                      {/* Waren-Ansicht Total */}
                      <td className="px-3 py-2 text-right tabular-nums" style={colStyle('umsatzTotal')}>
                        {fmtN(total.sumUmsatzTotal)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums border-l border-border/50 text-emerald-700 dark:text-emerald-400" style={colStyle('umsatzFood')}>
                        {total.sumUmsatzFood > 0 ? fmtN(total.sumUmsatzFood) : <span className="text-muted-foreground font-normal">–</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-blue-700 dark:text-blue-400" style={colStyle('umsatzBev')}>
                        {total.sumUmsatzBev > 0 ? fmtN(total.sumUmsatzBev) : <span className="text-muted-foreground font-normal">–</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums border-l border-border/50 text-emerald-700 dark:text-emerald-400" style={colStyle('wkFoodChf')}>
                        {total.sumWesFood > 0 ? fmtN(total.sumWesFood) : <span className="text-muted-foreground font-normal">–</span>}
                      </td>
                      <td className={cn('px-3 py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-400', pctCls(total.wesFoodPct))} style={colStyle('wkFoodPct')}>
                        {fmtPct(total.wesFoodPct, total.sumWesFood > 0 && total.sumUmsatzFood > 0)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums border-l border-border/50 text-blue-700 dark:text-blue-400" style={colStyle('wkBevChf')}>
                        {total.sumWesBev > 0 ? fmtN(total.sumWesBev) : <span className="text-muted-foreground font-normal">–</span>}
                      </td>
                      <td className={cn('px-3 py-2 text-right tabular-nums text-blue-700 dark:text-blue-400', pctCls(total.wesBevPct))} style={colStyle('wkBevPct')}>
                        {fmtPct(total.wesBevPct, total.sumWesBev > 0 && total.sumUmsatzBev > 0)}
                      </td>
                    </>)}
                  </tr>
                </thead>

                <tbody>
                  {period === 'jahr'
                    /* ── Jahresansicht: 12 Monatszeilen ──────────────────────── */
                    ? monthRows.map(mr => {
                        // Nur Tage mit Umsatz für %-Berechnung verwenden
                        const pkPlanPct  = mr.umsatz > 0 ? (mr.pkPlanChfRev / mr.umsatz) * 100 : 0;
                        const pkIstPct   = mr.umsatz > 0 && mr.pkIstChfRev > 0 ? (mr.pkIstChfRev / mr.umsatz) * 100 : 0;
                        const wesPct     = mr.umsatz > 0 && mr.wesChfRev > 0 ? (mr.wesChfRev / mr.umsatz) * 100 : 0;
                        const wesFoodPct = mr.umsatzFood > 0 && mr.wesFoodRev > 0 ? (mr.wesFoodRev / mr.umsatzFood) * 100 : 0;
                        const wesBevPct  = mr.umsatzBev  > 0 && mr.wesBevRev  > 0 ? (mr.wesBevRev  / mr.umsatzBev)  * 100 : 0;
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
                            {viewMode === 'personal' ? (<>
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
                            </>) : (<>
                              {/* Waren-Ansicht */}
                              <td className="px-3 py-2 text-right tabular-nums" style={colStyle('umsatzTotal')}>
                                {mr.umsatzTotal > 0 ? fmtN(mr.umsatzTotal) : '–'}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums border-l border-border/30 text-emerald-700 dark:text-emerald-400" style={colStyle('umsatzFood')}>
                                {mr.umsatzFood > 0 ? fmtN(mr.umsatzFood) : '–'}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-blue-700 dark:text-blue-400" style={colStyle('umsatzBev')}>
                                {mr.umsatzBev > 0 ? fmtN(mr.umsatzBev) : '–'}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums border-l border-border/30 text-emerald-700 dark:text-emerald-400" style={colStyle('wkFoodChf')}>
                                {mr.wesFood > 0 ? fmtN(mr.wesFood) : '–'}
                              </td>
                              <td className={cn('px-3 py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-400', pctCls(wesFoodPct))} style={colStyle('wkFoodPct')}>
                                {mr.umsatzFood > 0 && mr.wesFood > 0 ? fmtPct(wesFoodPct) : '–'}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums border-l border-border/30 text-blue-700 dark:text-blue-400" style={colStyle('wkBevChf')}>
                                {mr.wesBev > 0 ? fmtN(mr.wesBev) : '–'}
                              </td>
                              <td className={cn('px-3 py-2 text-right tabular-nums text-blue-700 dark:text-blue-400', pctCls(wesBevPct))} style={colStyle('wkBevPct')}>
                                {mr.umsatzBev > 0 && mr.wesBev > 0 ? fmtPct(wesBevPct) : '–'}
                              </td>
                            </>)}
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
                                  onClick={() => startEditUmsatz(row.date)}
                                  title="Klicken zum Bearbeiten (Brutto CHF)"
                                  className="w-full px-3 py-1.5 text-right hover:bg-blue-50 dark:hover:bg-blue-950/20 rounded transition-colors cursor-text"
                                >
                                  {row.umsatz > 0 ? fmtN(row.umsatz) : '–'}
                                </button>
                              )}
                            </td>
                            {viewMode === 'personal' ? (<>
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
                            </>) : (() => {
                              const wkFoodPct = row.umsatzFood > 0 && row.wesFood > 0 ? (row.wesFood / row.umsatzFood) * 100 : 0;
                              const wkBevPct  = row.umsatzBev  > 0 && row.wesBev  > 0 ? (row.wesBev  / row.umsatzBev)  * 100 : 0;
                              return (<>
                                <td className="px-3 py-1.5 text-right tabular-nums border-l border-border/30 text-emerald-700 dark:text-emerald-400" style={colStyle('umsatzFood')}>
                                  {row.umsatzFood > 0 ? fmtN(row.umsatzFood) : '–'}
                                </td>
                                <td className="px-3 py-1.5 text-right tabular-nums text-blue-700 dark:text-blue-400" style={colStyle('umsatzBev')}>
                                  {row.umsatzBev > 0 ? fmtN(row.umsatzBev) : '–'}
                                </td>
                                <td className="px-3 py-1.5 text-right tabular-nums border-l border-border/30 text-emerald-700 dark:text-emerald-400" style={colStyle('wkFoodChf')}>
                                  {row.wesFood > 0 ? fmtN(row.wesFood) : '–'}
                                </td>
                                <td className={cn('px-3 py-1.5 text-right tabular-nums text-emerald-700 dark:text-emerald-400', pctCls(wkFoodPct))} style={colStyle('wkFoodPct')}>
                                  {row.umsatzFood > 0 && row.wesFood > 0 ? fmtPct(wkFoodPct) : '–'}
                                </td>
                                <td className="px-3 py-1.5 text-right tabular-nums border-l border-border/30 text-blue-700 dark:text-blue-400" style={colStyle('wkBevChf')}>
                                  {row.wesBev > 0 ? fmtN(row.wesBev) : '–'}
                                </td>
                                <td className={cn('px-3 py-1.5 text-right tabular-nums text-blue-700 dark:text-blue-400', pctCls(wkBevPct))} style={colStyle('wkBevPct')}>
                                  {row.umsatzBev > 0 && row.wesBev > 0 ? fmtPct(wkBevPct) : '–'}
                                </td>
                              </>);
                            })()}
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
              PK / Waren – erhöht
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-red-600 dark:text-red-400 font-medium">&gt; 35 %</span>
              PK / Waren – kritisch
            </div>
            <div className="ml-auto">
              PK Plan = Dienstplan × Stundenlohn &nbsp;·&nbsp;
              Warenkosten = erfasste Lieferantenrechnungen (Netto) &nbsp;·&nbsp;
              % = gewichtete Gesamtquote
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
