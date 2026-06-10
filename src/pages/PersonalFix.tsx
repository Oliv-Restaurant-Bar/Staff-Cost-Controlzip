import { useState, useMemo, useEffect, useCallback } from 'react';
import ManagementInsights from '@/components/personal-fix/ManagementInsights';
import HourBalanceSection from '@/components/hour-balance/HourBalanceSection';
import { buildHourBalances, generatePlanningHints } from '@/lib/hour-balance-utils';
import { Navigate } from 'react-router-dom';
import {
  DollarSign, Users, BookOpen, TrendingUp, ChefHat,
  Utensils, Edit2, Check, X, Info, Building2, AlertCircle, Clock,
  ChevronLeft, ChevronRight, ChevronDown, Calendar, BarChart2, Lightbulb, Target,
  Repeat, FileText, Download, TrendingDown,
} from 'lucide-react';
import {
  exportPersonalFixToPDF,
  exportVarKostenvergleich,
  exportFlexAuswertungToPDF,
  exportFlexAuswertungToExcel,
} from '@/lib/personalfix-export';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { loadEmployees, upsertEmployee, loadActualHoursForMonth, loadScheduleForMonth } from '@/lib/supabase-db';
import type { ActualHourEntry } from '@/lib/supabase-db';
import { loadAllContractHistory, getMidMonthSwitchInMonth } from '@/lib/contract-history-store';
import { applyEffectiveWages, firstOfMonth } from '@/lib/wage-history';
import { Employee, grossToNet } from '@/types/personnel';
import { getEffectiveHourlyRate } from '@/components/schedule-planner/ActualHoursGrid';
import { isEmployeeActiveInMonth } from '@/lib/personnel-utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import { useMaison } from '@/contexts/MaisonContext';
import { getMaisonEnabledSync } from '@/lib/maison-store';
import { useBudgetMonth } from '@/hooks/useBudgetMonth';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';
import { loadWeekdayWeights, computeProRataBudget, logBudgetDayDebug } from '@/lib/budget-day';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

// ── Helpers ────────────────────────────────────────────────────────────────────

const fmtCHF = (n: number) =>
  n.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 });

const fmtCHFDec = (n: number) =>
  n.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', minimumFractionDigits: 2, maximumFractionDigits: 2 });

function getMonthLabel(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleString('de-CH', { month: 'long', year: 'numeric' });
}

function prevMonth(year: number, month: number): [number, number] {
  return month === 1 ? [year - 1, 12] : [year, month - 1];
}

function nextMonth(year: number, month: number): [number, number] {
  return month === 12 ? [year + 1, 1] : [year, month + 1];
}

/** Basis-Monatslohn eines Mitarbeiters */
function getFixCost(emp: Employee): number {
  if (emp.monthlySalaryWith13th && emp.monthlySalaryWith13th > 0)
    return emp.monthlySalaryWith13th;
  if (emp.monthlySalary && emp.monthlySalary > 0)
    return emp.monthlySalary;
  return 0;
}

/** Ob der Mitarbeiter einen fixen Monatslohn hat */
function hasFixedSalary(emp: Employee): boolean {
  return (emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit')
    && (emp.monthlySalary ?? 0) > 0;
}

/**
 * Pro-rata-Berechnung des Fixlohns für einen Monat.
 *
 * Logik Eintritt (contractStart):
 * - Kein Eintrittsdatum → voller Monatslohn
 * - Eintritt nach diesem Monat → CHF 0, ausgeblendet
 * - Eintritt IM Monat → Lohn × ((Tage im Monat − Eintrittst. + 1) / Tage im Monat)
 * - Eintritt vor oder im Monatsersten → voller Monatslohn
 *
 * Logik Austritt (employmentEndDate):
 * - Kein Austrittsdatum → voller Monatslohn
 * - Austritt vor diesem Monat → CHF 0, ausgeblendet
 * - Austritt IM Monat → Lohn × (Austrittstag / Tage im Monat)
 * - Austritt nach diesem Monat → voller Monatslohn
 *
 * Beide Pro-rata-Faktoren werden multipliziert falls Eintritt und Austritt im selben Monat.
 */
function getProRataFixCost(
  emp: Employee, year: number, month: number
): { cost: number; label: string | null; excluded: boolean } {
  const full = getFixCost(emp);
  if (!full) return { cost: 0, label: null, excluded: false };

  const daysInMonth = new Date(year, month, 0).getDate();
  const labels: string[] = [];
  let entryFactor = 1;
  let exitFactor  = 1;

  // ── Eintrittsdatum ──────────────────────────────────────────────────────
  if (emp.contractStart) {
    const entry = new Date(emp.contractStart + 'T00:00:00');
    const eny = entry.getFullYear();
    const enm = entry.getMonth() + 1;
    const end = entry.getDate();

    if (eny > year || (eny === year && enm > month)) {
      return { cost: 0, label: 'Noch nicht eingetreten', excluded: true };
    }
    if (eny === year && enm === month && end > 1) {
      entryFactor = (daysInMonth - end + 1) / daysInMonth;
      const dd = String(end).padStart(2, '0');
      const mm = String(enm).padStart(2, '0');
      labels.push(`Pro rata ab ${dd}.${mm}.`);
    }
  }

  // ── Austrittsdatum ──────────────────────────────────────────────────────
  if (emp.employmentEndDate) {
    const exit = new Date(emp.employmentEndDate + 'T00:00:00');
    const ey = exit.getFullYear();
    const em = exit.getMonth() + 1;
    const ed = exit.getDate();

    if (ey < year || (ey === year && em < month)) {
      return { cost: 0, label: 'Ausgetreten', excluded: true };
    }
    if (ey === year && em === month) {
      exitFactor = ed / daysInMonth;
      const dd = String(ed).padStart(2, '0');
      const mm = String(em).padStart(2, '0');
      labels.push(`Pro rata bis ${dd}.${mm}.`);
    }
  }

  const factor = entryFactor * exitFactor;
  if (factor >= 1) return { cost: full, label: null, excluded: false };

  const cost = Math.round(full * factor * 100) / 100;
  return { cost, label: labels.join(' / '), excluded: false };
}

/**
 * Jahreskosten-Berechnung für den Fixlohn eines Mitarbeiters.
 *
 * Berücksichtigt sowohl Eintrittsdatum (contractStart) als auch Austrittsdatum (employmentEndDate).
 *
 * Formel: Summe über alle 12 Monate, wobei jeder Monat den pro-rata-Faktor aus
 * getProRataFixCost verwendet.
 */
function getYearlyFixCost(emp: Employee, year: number): number {
  const full = getFixCost(emp);
  if (!full) return 0;

  let total = 0;
  for (let m = 1; m <= 12; m++) {
    const { cost, excluded } = getProRataFixCost(emp, year, m);
    if (!excluded) total += cost;
  }
  return Math.round(total * 100) / 100;
}

// ── Slot-Stunden-Rechner (für schedule-v2 Plan-Stunden) ───────────────────────

function calcSlotHours(slot: { start: string; end: string } | null | undefined): number {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = (eh - sh) + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.max(0, h);
}

/**
 * Liest Plan-Stunden aus localStorage (schedule-v2-YYYY-MM).
 * Gibt eine Map empId → Gesamtstunden im Monat zurück.
 */
function loadPlanHoursFromStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, number> {
  const key = keyFn(`schedule-v2-${year}-${String(month).padStart(2, '0')}`);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, number> = {};
    for (const [cellKey, ds] of Object.entries(data)) {
      // cellKey = "${empId}-YYYY-MM-DD" → empId = alles außer letzten 11 Zeichen
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      const früh = calcSlotHours(ds?.früh);
      const spät = calcSlotHours(ds?.spät);
      const gross = früh + spät;
      const net = Math.max(0, gross - calculateBreakDeduction(gross));
      if (net > 0) out[empId] = (out[empId] ?? 0) + Math.round(net * 100) / 100;
    }
    return out;
  } catch { return {}; }
}

/**
 * Liest FE-Ferientage aus localStorage (actual-hours-YYYY-MM).
 * Gibt eine Map empId → Anzahl FE-Einträge im Monat zurück.
 * FE-Einträge haben hours=0 und absenceType='FE' — werden hier gezählt.
 */
function loadFerienDaysFromStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, number> {
  const key = keyFn(`actual-hours-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, number> = {};
    for (const [cellKey, val] of Object.entries(data)) {
      const entryDate = cellKey.slice(-10);
      if (!entryDate.startsWith(monthPrefix)) continue;
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      const absenceType = typeof val === 'object' ? val?.absenceType : undefined;
      if (absenceType === 'FE') {
        out[empId] = (out[empId] ?? 0) + 1;
      }
    }
    return out;
  } catch { return {}; }
}

/**
 * Liest FE-Ferientage aus dem PLAN-Dienstplan (schedule-v2-YYYY-MM).
 * Gibt eine Map empId → Anzahl Plan-FE-Tage im Monat zurück.
 * Ein Plan-FE-Tag liegt vor, wenn frühAbsence === 'FE' ODER spätAbsence === 'FE'.
 */
function loadFerienDaysFromPlanStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, number> {
  const key = keyFn(`schedule-v2-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, number> = {};
    for (const [cellKey, ds] of Object.entries(data)) {
      const entryDate = cellKey.slice(-10);
      if (!entryDate.startsWith(monthPrefix)) continue;
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      const hasFE = ds?.frühAbsence === 'FE' || ds?.spätAbsence === 'FE';
      if (hasFE) {
        out[empId] = (out[empId] ?? 0) + 1;
        console.log(`[FERIEN] loaded existing entry: plan ${cellKey} absenceType=FE`);
      }
    }
    return out;
  } catch { return {}; }
}

/**
 * Liest Ist-Stunden aus localStorage (actual-hours-YYYY-MM = Mirus-Import).
 * Gibt eine Map empId → Gesamtstunden im Monat zurück.
 */
function loadIstHoursFromStorage(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, number> {
  const key = keyFn(`actual-hours-${year}-${String(month).padStart(2, '0')}`);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  console.log(`[IST] month selected: ${monthPrefix} (key: ${key})`);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      console.log(`[IST] persisted rows: 0 (key not found in localStorage)`);
      return {};
    }
    const data: Record<string, any> = JSON.parse(raw);
    const allRows = Object.keys(data);
    // Filter: only count entries whose date matches this month (guards against old corrupted data)
    const out: Record<string, number> = {};
    const mismatched: string[] = [];
    for (const [cellKey, val] of Object.entries(data)) {
      // key format: "{employeeId}-YYYY-MM-DD" → date is last 10 chars
      const entryDate = cellKey.slice(-10);
      if (!entryDate.startsWith(monthPrefix)) {
        mismatched.push(cellKey);
        continue; // skip entries from other months that ended up in this key (old bug)
      }
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      // Skip FE (Ferien/vacation) absences — same as loadDailyIstDetails
      const absenceType = typeof val === 'object' ? (val as any)?.absenceType : undefined;
      if (absenceType === 'FE') continue;
      const h = typeof val === 'number' ? val : (val?.hours ?? 0);
      if (h > 0) out[empId] = (out[empId] ?? 0) + Math.round(h * 100) / 100;
    }
    const totalHours = Object.values(out).reduce((s, h) => s + h, 0);
    console.log(`[IST] persisted rows: ${allRows.length} total, ${mismatched.length} from wrong month (filtered out)`);
    console.log(`[IST] personal-fix rows loaded: ${Object.keys(out).length} Mitarbeiter / ${Math.round(totalHours * 10) / 10} Stunden`);
    if (mismatched.length > 0) {
      console.warn(`[IST] missing employees / cross-month entries filtered:`, mismatched.slice(0, 10));
    }
    return out;
  } catch { return {}; }
}

// ── Bezeichnungen ─────────────────────────────────────────────────────────────

const DEPT_LABEL: Record<string, string> = { service: 'Service', küche: 'Küche' };
const DEPT_ICON: Record<string, React.ReactNode> = {
  service: <Utensils className="h-4 w-4" />,
  küche:   <ChefHat  className="h-4 w-4" />,
};
const EMP_TYPE_LABEL: Record<string, string> = {
  vollzeit: 'Vollzeit', teilzeit: 'Teilzeit',
  minijob: 'Minijob', aushilfe: 'Aushilfe',
};

type VarView = 'plan' | 'ist' | 'manual';

const VAR_HOURS_KEY = 'personal_fix_var_hours_v1';
function loadVarHours(keyFn: (k: string) => string = k => k): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(keyFn(VAR_HOURS_KEY)) ?? '{}'); }
  catch { return {}; }
}
function saveVarHours(data: Record<string, number>, keyFn: (k: string) => string = k => k) {
  localStorage.setItem(keyFn(VAR_HOURS_KEY), JSON.stringify(data));
}

// ── Wöchentliches Basismodell (Std/Wo, Tage/Wo) ───────────────────────────────

interface WeeklyBaseline { hours?: number; days?: number; }
const VAR_WEEKLY_KEY = 'personal_fix_weekly_v1';

function loadVarWeekly(keyFn: (k: string) => string = k => k): Record<string, WeeklyBaseline> {
  try { return JSON.parse(localStorage.getItem(keyFn(VAR_WEEKLY_KEY)) ?? '{}'); }
  catch { return {}; }
}
function saveVarWeekly(data: Record<string, WeeklyBaseline>, keyFn: (k: string) => string = k => k) {
  localStorage.setItem(keyFn(VAR_WEEKLY_KEY), JSON.stringify(data));
}

/** Durchschnittliche Wochen pro Monat */
const WEEKS_PER_MONTH = 4.333;

// ── Tagessatz (Tages-Pauschale) ────────────────────────────────────────────────

type PricingMode = 'hourly' | 'daily';

interface DayRateData { ratePerDay: number; daysPerWeek?: number; daysPerMonth?: number; }

const VAR_PRICING_MODE_KEY = 'personal_fix_pricing_mode_v1';
function loadVarPricingMode(keyFn: (k: string) => string = k => k): Record<string, PricingMode> {
  try { return JSON.parse(localStorage.getItem(keyFn(VAR_PRICING_MODE_KEY)) ?? '{}'); }
  catch { return {}; }
}
function saveVarPricingMode(data: Record<string, PricingMode>, keyFn: (k: string) => string = k => k) {
  localStorage.setItem(keyFn(VAR_PRICING_MODE_KEY), JSON.stringify(data));
}

const VAR_DAYRATE_KEY = 'personal_fix_dayrate_v1';
function loadVarDayRate(keyFn: (k: string) => string = k => k): Record<string, DayRateData> {
  try { return JSON.parse(localStorage.getItem(keyFn(VAR_DAYRATE_KEY)) ?? '{}'); }
  catch { return {}; }
}
function saveVarDayRate(data: Record<string, DayRateData>, keyFn: (k: string) => string = k => k) {
  localStorage.setItem(keyFn(VAR_DAYRATE_KEY), JSON.stringify(data));
}

// ── Umsatz-Annahme (manuelle Revenue-Eingabe für PKQ) ─────────────────────────

const REVENUE_ASSUMPTION_KEY = 'personal_fix_revenue_assumption_v1';
function loadRevenueAssumption(year: number, month: number, keyFn: (k: string) => string = k => k): number | null {
  try {
    const raw = localStorage.getItem(keyFn(`${REVENUE_ASSUMPTION_KEY}_${year}_${String(month).padStart(2, '0')}`));
    if (!raw) return null;
    const v = parseFloat(raw);
    return isNaN(v) || v <= 0 ? null : v;
  } catch { return null; }
}
function saveRevenueAssumption(year: number, month: number, value: number | null, keyFn: (k: string) => string = k => k) {
  const key = keyFn(`${REVENUE_ASSUMPTION_KEY}_${year}_${String(month).padStart(2, '0')}`);
  if (value === null || value <= 0) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
  else { try { localStorage.setItem(key, String(value)); } catch { /* ignore */ } }
}

// ── Budget-Umsatz (manuelle Revenue-Eingabe für PKQ-Budget-Ableitung) ──────────

const BUDGET_REVENUE_KEY = 'personal_fix_budget_revenue_v1';
function loadBudgetRevenue(year: number, month: number, keyFn: (k: string) => string = k => k): number | null {
  try {
    const raw = localStorage.getItem(keyFn(`${BUDGET_REVENUE_KEY}_${year}_${String(month).padStart(2, '0')}`));
    if (!raw) return null;
    const v = parseFloat(raw);
    return isNaN(v) || v <= 0 ? null : v;
  } catch { return null; }
}
function saveBudgetRevenue(year: number, month: number, value: number | null, keyFn: (k: string) => string = k => k) {
  const key = keyFn(`${BUDGET_REVENUE_KEY}_${year}_${String(month).padStart(2, '0')}`);
  if (value === null || value <= 0) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
  else { try { localStorage.setItem(key, String(value)); } catch { /* ignore */ } }
}

const WEEK_IST_KEY = 'personal_fix_week_ist_v1';
function loadWeekIstSet(year: number, month: number, keyFn: (k: string) => string = k => k): string[] {
  try {
    const raw = localStorage.getItem(keyFn(`${WEEK_IST_KEY}_${year}_${String(month).padStart(2, '0')}`));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveWeekIstSet(year: number, month: number, weeks: string[], keyFn: (k: string) => string = k => k) {
  const key = keyFn(`${WEEK_IST_KEY}_${year}_${String(month).padStart(2, '0')}`);
  try { localStorage.setItem(key, JSON.stringify(weeks)); } catch { /* ignore */ }
}

const WEEK_REV_OVERRIDE_KEY = 'personal_fix_week_rev_overrides_v1';
function loadWeekRevOverrides(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, number> {
  try {
    const raw = localStorage.getItem(keyFn(`${WEEK_REV_OVERRIDE_KEY}_${year}_${String(month).padStart(2, '0')}`));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch { return {}; }
}
function saveWeekRevOverrides(year: number, month: number, data: Record<string, number>, keyFn: (k: string) => string = k => k) {
  const key = keyFn(`${WEEK_REV_OVERRIDE_KEY}_${year}_${String(month).padStart(2, '0')}`);
  try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* ignore */ }
}

const SCENARIO_PK_KEY = 'personal_fix_scenario_pk_v1';
function loadScenarioPkCost(year: number, month: number, keyFn: (k: string) => string = k => k): number | null {
  try {
    const raw = localStorage.getItem(keyFn(`${SCENARIO_PK_KEY}_${year}_${String(month).padStart(2, '0')}`));
    if (!raw) return null;
    const v = parseFloat(raw);
    return isNaN(v) || v <= 0 ? null : v;
  } catch { return null; }
}
function saveScenarioPkCost(year: number, month: number, value: number | null, keyFn: (k: string) => string = k => k) {
  const key = keyFn(`${SCENARIO_PK_KEY}_${year}_${String(month).padStart(2, '0')}`);
  if (value === null || value <= 0) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
  else { try { localStorage.setItem(key, String(value)); } catch { /* ignore */ } }
}

// ── Tagesumsätze aus localStorage (dailyBudgets) ──────────────────────────────

function readDailyBudgetsLocal(year: number, month: number, keyFn: (k: string) => string = k => k): Record<string, { actualRevenue?: number; takeawayRevenue?: number }> {
  try {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const all: Record<string, { actualRevenue?: number; takeawayRevenue?: number }> =
      JSON.parse(localStorage.getItem(keyFn('dailyBudgets')) || '{}');
    const out: Record<string, { actualRevenue?: number; takeawayRevenue?: number }> = {};
    for (const [date, val] of Object.entries(all)) {
      if (date.startsWith(prefix)) out[date] = val;
    }
    return out;
  } catch { return {}; }
}

// ── KPI-Card ──────────────────────────────────────────────────────────────────

interface KpiProps {
  title: string; value: string; sub?: string; icon: React.ReactNode;
  color?: 'blue' | 'green' | 'red' | 'yellow' | 'orange' | 'default';
  delta?: number | null; deltaLabel?: string;
  sourceBadge?: string;
}

const KpiCard = ({ title, value, sub, icon, color = 'default', delta, deltaLabel, sourceBadge }: KpiProps) => {
  const border = {
    blue: 'border-blue-200 dark:border-blue-800', green: 'border-emerald-200 dark:border-emerald-800',
    red: 'border-red-200 dark:border-red-800', yellow: 'border-yellow-200 dark:border-yellow-800',
    orange: 'border-orange-200 dark:border-orange-800', default: 'border-border',
  }[color];
  const iconBg = {
    blue: 'bg-blue-50 text-blue-600 dark:bg-blue-950/40', green: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40',
    red: 'bg-red-50 text-red-600 dark:bg-red-950/40', yellow: 'bg-yellow-50 text-yellow-600 dark:bg-yellow-950/40',
    orange: 'bg-orange-50 text-orange-600 dark:bg-orange-950/40', default: 'bg-muted text-muted-foreground',
  }[color];
  return (
    <div className={cn('rounded-xl border bg-card p-4 flex flex-col gap-2 shadow-sm', border)}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</p>
        <div className={cn('p-1.5 rounded-lg', iconBg)}>{icon}</div>
      </div>
      <p className="text-2xl font-bold tracking-tight">{value}</p>
      {sourceBadge && (
        <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 w-fit">
          {sourceBadge}
        </span>
      )}
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      {delta !== undefined && delta !== null && (
        <p className={cn('text-xs font-medium flex items-center gap-1', delta >= 0 ? 'text-red-600' : 'text-emerald-600')}>
          {delta >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingUp className="h-3 w-3 rotate-180" />}
          {delta >= 0 ? '+' : ''}{fmtCHF(delta)} {deltaLabel}
        </p>
      )}
    </div>
  );
};

// ── Inline-Editors ─────────────────────────────────────────────────────────────

interface InlineSalaryEditorProps {
  empId: string; field: 'monthlySalary' | 'monthlySalaryWith13th';
  value: number | undefined;
  onSaved: (empId: string, field: 'monthlySalary' | 'monthlySalaryWith13th', val: number) => void;
}

const InlineSalaryEditor = ({ empId, field, value, onSaved }: InlineSalaryEditorProps) => {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const start = () => { setInput(value ? String(value) : ''); setEditing(true); };
  const cancel = () => setEditing(false);
  const save = () => {
    const num = parseFloat(input.replace(/['\s]/g, '').replace(',', '.'));
    if (!isNaN(num) && num >= 0) onSaved(empId, field, num);
    setEditing(false);
  };
  if (editing) return (
    <div className="flex items-center gap-1">
      <Input autoFocus className="h-7 w-28 text-right font-mono text-sm" value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }} />
      <Button size="icon" variant="ghost" className="h-6 w-6 text-emerald-600" onClick={save}><Check className="h-3.5 w-3.5" /></Button>
      <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" onClick={cancel}><X className="h-3.5 w-3.5" /></Button>
    </div>
  );
  return (
    <button className="group flex items-center gap-1.5 text-right tabular-nums hover:text-primary transition-colors" onClick={start}>
      <span className="font-mono text-sm">{value ? fmtCHFDec(value) : <span className="text-muted-foreground italic text-xs">–</span>}</span>
      <Edit2 className="h-3 w-3 opacity-0 group-hover:opacity-50 transition-opacity shrink-0" />
    </button>
  );
};

interface InlineHourlyWageEditorProps {
  empId: string; value: number | undefined;
  onSaved: (empId: string, val: number) => void;
}

const InlineHourlyWageEditor = ({ empId, value, onSaved }: InlineHourlyWageEditorProps) => {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const start = () => { setInput(value ? String(value) : ''); setEditing(true); };
  const cancel = () => setEditing(false);
  const save = () => {
    const num = parseFloat(input.replace(/['\s]/g, '').replace(',', '.'));
    if (!isNaN(num) && num >= 0) onSaved(empId, num);
    setEditing(false);
  };
  if (editing) return (
    <div className="flex items-center gap-1 justify-end">
      <Input autoFocus className="h-7 w-20 text-right font-mono text-sm" value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
        placeholder="0.00" />
      <span className="text-xs text-muted-foreground">/h</span>
      <Button size="icon" variant="ghost" className="h-6 w-6 text-emerald-600" onClick={save}><Check className="h-3.5 w-3.5" /></Button>
      <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" onClick={cancel}><X className="h-3.5 w-3.5" /></Button>
    </div>
  );
  return (
    <button className="group flex items-center justify-end gap-1.5 hover:text-primary transition-colors w-full" onClick={start}>
      <span className="font-mono text-sm text-muted-foreground">
        {value ? `${fmtCHFDec(value)}/h` : <span className="italic text-xs">–</span>}
      </span>
      <Edit2 className="h-3 w-3 opacity-0 group-hover:opacity-50 transition-opacity shrink-0" />
    </button>
  );
};

interface InlineHoursEditorProps {
  empId: string; value: number;
  onChange: (empId: string, val: number) => void;
}

const InlineHoursEditor = ({ empId, value, onChange }: InlineHoursEditorProps) => {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const start = () => { setInput(value > 0 ? String(value) : ''); setEditing(true); };
  const cancel = () => setEditing(false);
  const save = () => {
    const num = parseFloat(input.replace(/['\s]/g, '').replace(',', '.'));
    if (!isNaN(num) && num >= 0) onChange(empId, num);
    setEditing(false);
  };
  if (editing) return (
    <div className="flex items-center gap-1 justify-end">
      <Input autoFocus className="h-7 w-20 text-right font-mono text-sm" value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
        placeholder="0" />
      <span className="text-xs text-muted-foreground">h</span>
      <Button size="icon" variant="ghost" className="h-6 w-6 text-emerald-600" onClick={save}><Check className="h-3.5 w-3.5" /></Button>
      <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" onClick={cancel}><X className="h-3.5 w-3.5" /></Button>
    </div>
  );
  return (
    <button className="group flex items-center justify-end gap-1.5 hover:text-primary transition-colors w-full" onClick={start}>
      {value > 0
        ? <span className="font-mono text-sm">{value} h</span>
        : <span className="text-muted-foreground italic text-xs">Eingabe</span>}
      <Edit2 className="h-3 w-3 opacity-0 group-hover:opacity-50 transition-opacity shrink-0" />
    </button>
  );
};

// ── Kleiner Inline-Editor für Wochenwerte (Std/Wo, Tage/Wo) ──────────────────

interface InlineWeeklyEditorProps {
  value: number | undefined;
  unit: string;
  max: number;
  onSave: (val: number | undefined) => void;
}

const InlineWeeklyEditor = ({ value, unit, max, onSave }: InlineWeeklyEditorProps) => {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const start  = () => { setInput(value != null ? String(value) : ''); setEditing(true); };
  const cancel = () => setEditing(false);
  const save   = () => {
    const trimmed = input.trim();
    if (trimmed === '' || trimmed === '0') { onSave(undefined); setEditing(false); return; }
    const num = parseFloat(trimmed.replace(',', '.'));
    if (!isNaN(num) && num >= 0 && num <= max) onSave(num);
    setEditing(false);
  };
  if (editing) return (
    <div className="flex items-center gap-0.5 justify-end">
      <Input autoFocus className="h-6 w-14 text-right font-mono text-xs py-0 px-1" value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
        placeholder="–" />
      <span className="text-[10px] text-muted-foreground">{unit}</span>
      <Button size="icon" variant="ghost" className="h-5 w-5 text-emerald-600" onClick={save}><Check className="h-3 w-3" /></Button>
      <Button size="icon" variant="ghost" className="h-5 w-5 text-muted-foreground" onClick={cancel}><X className="h-3 w-3" /></Button>
    </div>
  );
  return (
    <button className="group flex items-center justify-end gap-1 hover:text-primary transition-colors w-full" onClick={start}>
      {value != null
        ? <span className="font-mono text-xs text-violet-700 dark:text-violet-400">{value}{unit}</span>
        : <span className="text-muted-foreground italic text-[10px]">–</span>}
      <Edit2 className="h-2.5 w-2.5 opacity-0 group-hover:opacity-40 transition-opacity shrink-0" />
    </button>
  );
};

// ── Flex-Breakdown: Typen ──────────────────────────────────────────────────────

type BreakdownField =
  | 'planWork' | 'istWork'
  | 'planHoliday' | 'istHoliday'
  | 'planTotalVar' | 'istTotalVar';

interface BreakdownTarget {
  empId:       string;
  empName:     string;
  field:       BreakdownField;
  hourlyWage:  number;
  weeklyHours: number;
  year:        number;
  month:       number;
  cutoffDay:   number | null;
  factor:      number;
}

interface DayEntry  { date: string; hours: number; cost: number; }
interface FerienDay { date: string; dailyH: number; cost: number; }

/** Zusatzkosten plan-tagged days for a fixed-salary employee (isAdditionalCostPlan) */
function loadZusatzPlanDetails(
  empId: string, year: number, month: number, cutoffDay: number | null, wage: number,
  keyFn: (k: string) => string = k => k,
): DayEntry[] {
  const key = keyFn(`schedule-v2-${year}-${String(month).padStart(2, '0')}`);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data: Record<string, any> = JSON.parse(raw);
    const entries: DayEntry[] = [];
    for (const [cellKey, ds] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      if (cellKey.slice(0, cellKey.length - 11) !== empId) continue;
      if (typeof ds !== 'object' || !ds?.isAdditionalCostPlan) continue;
      const day = parseInt(date.slice(-2), 10);
      if (cutoffDay !== null && day > cutoffDay) continue;
      const gross = calcSlotHours(ds?.früh) + calcSlotHours(ds?.spät);
      const net = Math.max(0, gross - calculateBreakDeduction(gross));
      if (net > 0) entries.push({ date, hours: Math.round(net * 100) / 100, cost: Math.round(net * wage * 100) / 100 });
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

/** Daily plan hours for one employee from schedule-v2-YYYY-MM */
function loadDailyPlanDetails(
  empId: string, year: number, month: number, cutoffDay: number | null, wage: number,
  keyFn: (k: string) => string = k => k,
): DayEntry[] {
  const key = keyFn(`schedule-v2-${year}-${String(month).padStart(2, '0')}`);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data: Record<string, any> = JSON.parse(raw);
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const entries: DayEntry[] = [];
    for (const [cellKey, ds] of Object.entries(data)) {
      const date  = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      if (cellKey.slice(0, cellKey.length - 11) !== empId) continue;
      const day = parseInt(date.slice(-2), 10);
      if (cutoffDay !== null && day > cutoffDay) continue;
      // Skip vacation-tagged entries — these are counted in ferien, not work
      if (ds?.frühAbsence === 'FE' || ds?.spätAbsence === 'FE') continue;
      const gross = calcSlotHours(ds?.früh) + calcSlotHours(ds?.spät);
      const net   = Math.max(0, gross - calculateBreakDeduction(gross));
      if (net > 0) entries.push({ date, hours: Math.round(net * 100) / 100, cost: Math.round(net * wage * 100) / 100 });
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

/** Daily ist hours for one employee from actual-hours-YYYY-MM */
function loadDailyIstDetails(
  empId: string, year: number, month: number, cutoffDay: number | null, wage: number,
  keyFn: (k: string) => string = k => k,
): DayEntry[] {
  const key = keyFn(`actual-hours-${year}-${String(month).padStart(2, '0')}`);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data: Record<string, any> = JSON.parse(raw);
    const entries: DayEntry[] = [];
    for (const [cellKey, val] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      if (cellKey.slice(0, cellKey.length - 11) !== empId) continue;
      const day = parseInt(date.slice(-2), 10);
      if (cutoffDay !== null && day > cutoffDay) continue;
      const absenceType = typeof val === 'object' ? val?.absenceType : undefined;
      if (absenceType === 'FE') continue; // FE is vacation, not work
      const h = typeof val === 'number' ? val : (val?.hours ?? 0);
      if (h > 0) entries.push({ date, hours: Math.round(h * 100) / 100, cost: Math.round(h * wage * 100) / 100 });
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

/**
 * Liest Zusatzkosten-IST-Einträge für einen Mitarbeiter (isAdditionalCost: true).
 * Identisch zu loadDailyIstDetails, aber nur Einträge mit isAdditionalCost = true.
 */
function loadZusatzIstDetails(
  empId: string, year: number, month: number, cutoffDay: number | null, wage: number,
  keyFn: (k: string) => string = k => k,
): DayEntry[] {
  const key = keyFn(`actual-hours-${year}-${String(month).padStart(2, '0')}`);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data: Record<string, any> = JSON.parse(raw);
    const entries: DayEntry[] = [];
    for (const [cellKey, val] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      if (cellKey.slice(0, cellKey.length - 11) !== empId) continue;
      if (typeof val !== 'object' || !val?.isAdditionalCost) continue;
      const day = parseInt(date.slice(-2), 10);
      if (cutoffDay !== null && day > cutoffDay) continue;
      const h = val?.hours ?? 0;
      if (h > 0) entries.push({ date, hours: Math.round(h * 100) / 100, cost: Math.round(h * wage * 100) / 100 });
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

/** FE vacation days from actual-hours-YYYY-MM (Ist) */
function loadFerienIstDayDetails(
  empId: string, year: number, month: number, cutoffDay: number | null, dailyH: number, wage: number,
  keyFn: (k: string) => string = k => k,
): FerienDay[] {
  const key = keyFn(`actual-hours-${year}-${String(month).padStart(2, '0')}`);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data: Record<string, any> = JSON.parse(raw);
    const entries: FerienDay[] = [];
    for (const [cellKey, val] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      if (cellKey.slice(0, cellKey.length - 11) !== empId) continue;
      const day = parseInt(date.slice(-2), 10);
      if (cutoffDay !== null && day > cutoffDay) continue;
      const absenceType = typeof val === 'object' ? val?.absenceType : undefined;
      if (absenceType === 'FE') entries.push({ date, dailyH: Math.round(dailyH * 100) / 100, cost: Math.round(dailyH * wage * 100) / 100 });
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

/** FE vacation days from schedule-v2-YYYY-MM (Plan) */
function loadFerienPlanDayDetails(
  empId: string, year: number, month: number, cutoffDay: number | null, dailyH: number, wage: number,
  keyFn: (k: string) => string = k => k,
): FerienDay[] {
  const key = keyFn(`schedule-v2-${year}-${String(month).padStart(2, '0')}`);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data: Record<string, any> = JSON.parse(raw);
    const entries: FerienDay[] = [];
    for (const [cellKey, ds] of Object.entries(data)) {
      const date = cellKey.slice(-10);
      if (!date.startsWith(prefix)) continue;
      if (cellKey.slice(0, cellKey.length - 11) !== empId) continue;
      const day = parseInt(date.slice(-2), 10);
      if (cutoffDay !== null && day > cutoffDay) continue;
      const hasFE = ds?.frühAbsence === 'FE' || ds?.spätAbsence === 'FE';
      if (hasFE) entries.push({ date, dailyH: Math.round(dailyH * 100) / 100, cost: Math.round(dailyH * wage * 100) / 100 });
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// ── Abweichungsanalyse helpers ─────────────────────────────────────────────────

interface AbwDay {
  date:        string;
  planWork:    number;
  istWork:     number;
  planFerien:  number;
  istFerien:   number;
  planTotal:   number;
  istTotal:    number;
  diff:        number;
  diffPct:     number | null;
}

interface AbwRow {
  period:    string;
  planTotal: number;
  istTotal:  number;
  diff:      number;
  diffPct:   number | null;
  dates:     string[];
}

type AbwMode = 'day' | 'week' | 'month' | 'year';

interface FlexPeriodTarget {
  label:     string;
  dates:     string[];
  planTotal: number;
  istTotal:  number;
  year:      number;
  month:     number;
}

function isoWeekLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  d.setHours(0, 0, 0, 0);
  const day = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() + 4 - day);
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `KW ${String(weekNo).padStart(2, '0')} / ${d.getFullYear()}`;
}

// ── Ampel-Logik ────────────────────────────────────────────────────────────────

type AmpelStatus = 'green' | 'yellow' | 'red' | 'neutral';

/** Einheitliche Ampel-Logik: Grün ≤0%, Gelb 0–5%, Rot >5% über Plan. Neutral wenn kein Plan. */
function ampelStatus(diff: number, plan: number): AmpelStatus {
  if (plan <= 0) return 'neutral';
  const pct = diff / plan;
  if (diff <= 0.005) return 'green';
  if (pct <= 0.05)   return 'yellow';
  return 'red';
}

const AMPEL: Record<AmpelStatus, {
  dot:    string;
  border: string;
  bg:     string;
  label:  string;
  text:   string;
}> = {
  green:   { dot: 'bg-emerald-500',                   border: 'border-emerald-400 dark:border-emerald-600', bg: 'bg-emerald-50/60 dark:bg-emerald-950/20', label: 'Im Plan',          text: 'text-emerald-700 dark:text-emerald-400' },
  yellow:  { dot: 'bg-amber-400',                     border: 'border-amber-400 dark:border-amber-600',     bg: 'bg-amber-50/60 dark:bg-amber-950/20',     label: 'Leicht über Plan', text: 'text-amber-700 dark:text-amber-400'    },
  red:     { dot: 'bg-red-500',                       border: 'border-red-400 dark:border-red-600',         bg: 'bg-red-50/60 dark:bg-red-950/20',         label: 'Über Plan',        text: 'text-red-700 dark:text-red-400'        },
  neutral: { dot: 'bg-gray-300 dark:bg-gray-600',     border: 'border-border',                              bg: '',                                        label: 'Kein Vergleich',   text: 'text-muted-foreground'                 },
};

// ── FlexPeriodPopup ────────────────────────────────────────────────────────────

function FlexPeriodPopup({
  target,
  employees,
  onClose,
}: {
  target:    FlexPeriodTarget | null;
  employees: Array<{ id: string; name: string; hourlyWage: number; weeklyHours: number }>;
  onClose:   () => void;
}) {
  const { tenantKey } = useTenant();
  if (!target) return null;
  const { label, dates, planTotal, istTotal, year, month } = target;
  const diff    = istTotal - planTotal;
  const diffPct = planTotal > 0 ? (diff / planTotal) * 100 : null;
  const st = ampelStatus(diff, planTotal);
  const A  = AMPEL[st];

  type EmpRow = {
    id: string; name: string;
    planH: number; istH: number;
    planWork: number; istWork: number;
    diff: number;
  };

  // Only Flex Arbeit (work) — same logic as pfixAbw (no ferien)
  const rows: EmpRow[] = employees.map(emp => {
    const wage  = emp.hourlyWage;
    const planW = loadDailyPlanDetails(emp.id, year, month, null, wage, tenantKey).filter(r => dates.includes(r.date));
    const istW  = loadDailyIstDetails(emp.id, year, month, null, wage, tenantKey).filter(r => dates.includes(r.date));
    const planWork = planW.reduce((s, r) => s + r.cost, 0);
    const istWork  = istW.reduce((s, r)  => s + r.cost, 0);
    const planH    = planW.reduce((s, r) => s + r.hours, 0);
    const istH     = istW.reduce((s, r)  => s + r.hours, 0);

    // FLEX-SYNC log — these values must match pfixPerEmp row for the same employee & period
    console.log(`[FLEX-SYNC] popup ist hours: ${istH.toFixed(2)} (${emp.name})`);
    console.log(`[FLEX-SYNC] popup ist chf:   ${istWork.toFixed(2)} (${emp.name})`);
    console.log(`[FLEX-SYNC] popup plan hours: ${planH.toFixed(2)} (${emp.name})`);
    console.log(`[FLEX-SYNC] popup plan chf:   ${planWork.toFixed(2)} (${emp.name})`);

    return { id: emp.id, name: emp.name, planH, istH, planWork, istWork, diff: istWork - planWork };
  }).filter(r => r.planWork > 0 || r.istWork > 0)
    .sort((a, b) => {
      // 1) positive deviations first (Ist > Plan), largest first
      // 2) then negative deviations (Ist < Plan), largest absolute first
      // 3) zeros last
      const aPos = a.diff > 0.005;
      const bPos = b.diff > 0.005;
      const aNeg = a.diff < -0.005;
      const bNeg = b.diff < -0.005;
      if (aPos && !bPos) return -1;
      if (!aPos && bPos) return  1;
      if (aNeg && !bNeg) return -1;
      if (!aNeg && bNeg) return  1;
      return Math.abs(b.diff) - Math.abs(a.diff);
    });

  // Top-3 rows by absolute deviation for visual highlight
  const top3Ids = new Set(
    [...rows].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 3).map(r => r.id)
  );

  const sumPlan = rows.reduce((s, r) => s + r.planWork, 0);
  const sumIst  = rows.reduce((s, r) => s + r.istWork,  0);
  const sumDiff = sumIst - sumPlan;

  console.log(`[FLEX] day popup total plan: ${planTotal.toFixed(2)}`);
  console.log(`[FLEX] day popup total ist: ${istTotal.toFixed(2)}`);
  console.log(`[FLEX] day popup diff: ${diff.toFixed(2)}`);
  if (Math.abs(sumPlan - planTotal) > 0.02) console.error(`[FLEX] popup plan mismatch: empTable=${sumPlan.toFixed(2)} header=${planTotal.toFixed(2)} Δ=${(sumPlan-planTotal).toFixed(2)}`);
  if (Math.abs(sumIst  - istTotal)  > 0.02) console.error(`[FLEX] popup ist  mismatch: empTable=${sumIst.toFixed(2)} header=${istTotal.toFixed(2)} Δ=${(sumIst-istTotal).toFixed(2)}`);

  const fmtD = (v: number) => {
    const s = fmtCHF(Math.abs(v));
    return v > 0.005 ? `+${s}` : v < -0.005 ? `−${s}` : s;
  };
  const diffCls = (v: number) =>
    v > 0.005  ? 'text-red-600 dark:text-red-400' :
    v < -0.005 ? 'text-emerald-600 dark:text-emerald-400' :
                 'text-muted-foreground';
  const thCls = 'sticky top-0 z-10 bg-muted/80 backdrop-blur-sm px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground border-b border-border';

  return (
    <Dialog open={!!target} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="p-0 gap-0 max-w-none w-[min(960px,95vw)] flex flex-col max-h-[88vh] overflow-hidden">
        {/* Sticky Header */}
        <div className={cn('shrink-0 px-6 py-4 border-b', A.border, A.bg || 'bg-muted/20')}>
          <div className="flex items-start gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-bold leading-tight">Flex-Auswertung — {label}</h2>
              <div className="flex flex-wrap gap-3 mt-2">
                <span className="text-xs text-muted-foreground">Plan <span className="text-blue-700 dark:text-blue-400 font-mono font-semibold">{fmtCHF(planTotal)}</span></span>
                <span className="text-xs text-muted-foreground">Ist <span className="text-orange-700 dark:text-orange-400 font-mono font-semibold">{fmtCHF(istTotal)}</span></span>
                <span className={cn('text-xs font-bold font-mono', diffCls(diff))}>{fmtD(diff)}</span>
                {diffPct !== null && <span className={cn('text-xs font-mono', diffCls(diff))}>({diffPct > 0.005 ? '+' : ''}{diffPct.toFixed(1)} %)</span>}
              </div>
            </div>
            <div className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold shrink-0', A.border, A.text)}>
              <span className={cn('w-2.5 h-2.5 rounded-full inline-block', A.dot)} />
              {A.label}
            </div>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {rows.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-8">
              Keine Flex-Daten für diesen Zeitraum.
            </div>
          ) : (
            <div className="rounded-md border border-border">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr>
                    <th className={cn(thCls, 'text-left')}>Mitarbeiter</th>
                    <th className={cn(thCls, 'text-right text-muted-foreground')}>Plan Std</th>
                    <th className={cn(thCls, 'text-right text-muted-foreground')}>Ist Std</th>
                    <th className={cn(thCls, 'text-right text-blue-600')}>Flex Plan CHF</th>
                    <th className={cn(thCls, 'text-right text-orange-600')}>Flex Ist CHF</th>
                    <th className={cn(thCls, 'text-right')}>Diff CHF</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const isTop = top3Ids.has(r.id) && Math.abs(r.diff) > 0.005;
                    return (
                    <tr key={r.id} className={cn(
                      i % 2 === 0 ? 'bg-background' : 'bg-muted/15',
                      isTop && 'outline outline-1 outline-amber-300 dark:outline-amber-600 bg-amber-50/50 dark:bg-amber-950/20',
                    )}>
                      <td className={cn('px-3 py-1.5', isTop ? 'font-bold' : 'font-medium')}>
                        {r.name}
                        {isTop && <span className="ml-1.5 inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">Top</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{r.planH > 0 ? `${r.planH.toFixed(1)} h` : '–'}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{r.istH > 0 ? `${r.istH.toFixed(1)} h` : '–'}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums font-semibold text-blue-700 dark:text-blue-400">{r.planWork > 0 ? fmtCHF(r.planWork) : '–'}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums font-semibold text-orange-700 dark:text-orange-400">{r.istWork > 0 ? fmtCHF(r.istWork) : '–'}</td>
                      <td className={cn('px-3 py-1.5 text-right font-mono tabular-nums font-bold', diffCls(r.diff))}>{fmtD(r.diff)}</td>
                    </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className={cn('border-t-2 border-border font-bold text-xs', A.bg)}>
                    <td className="px-3 py-2">Total ({rows.length} MA)</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{rows.reduce((s,r)=>s+r.planH,0).toFixed(1)} h</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{rows.reduce((s,r)=>s+r.istH,0).toFixed(1)} h</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-blue-700 dark:text-blue-400">{fmtCHF(sumPlan)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-orange-700 dark:text-orange-400">{fmtCHF(sumIst)}</td>
                    <td className={cn('px-3 py-2 text-right font-mono tabular-nums', diffCls(sumDiff))}>{fmtD(sumDiff)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* ── Haupttreiber-Zusammenfassung ────────────────────────────────── */}
        {(() => {
          const drivers = [...rows]
            .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
            .slice(0, 3)
            .filter(r => Math.abs(r.diff) > 0.005);
          console.log('[FLEX POPUP] drivers:', drivers.map(r => ({ name: r.name, diffCHF: r.diff })));
          return (
            <div className="shrink-0 border-t border-border bg-muted/25 px-6 py-3">
              <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs">
                <span className="font-semibold text-muted-foreground shrink-0">Haupttreiber:</span>
                {drivers.length === 0 ? (
                  <span className="text-muted-foreground italic">Keine relevanten Abweichungen</span>
                ) : drivers.map((r, i) => (
                  <span key={r.id} className="flex items-baseline gap-x-1">
                    {i > 0 && <span className="text-muted-foreground">·</span>}
                    <span className="font-medium text-foreground">{r.name}</span>
                    <span className={cn('font-mono font-semibold', r.diff > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                      {r.diff > 0 ? '+' : '−'}CHF {fmtCHF(Math.abs(r.diff)).replace('CHF\u00a0', '')}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Sticky Footer */}
        <div className={cn('shrink-0 border-t px-6 py-3 flex items-center justify-between gap-4', A.border, A.bg || 'bg-muted/40')}>
          <span className="text-xs text-muted-foreground">bezieht sich auf: <strong>{label}</strong></span>
          <div className="flex items-center gap-4 text-xs font-mono flex-wrap">
            <span className="text-muted-foreground">Plan <span className="text-blue-700 dark:text-blue-400 font-bold">{fmtCHF(planTotal)}</span></span>
            <span className="text-muted-foreground">Ist <span className="text-orange-700 dark:text-orange-400 font-bold">{fmtCHF(istTotal)}</span></span>
            <span className={cn('font-bold text-sm', A.text)}>{fmtD(diff)}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── WeekDetailPopup ────────────────────────────────────────────────────────────

interface WeekDetailData {
  weekLabel: string;
  dateRange: string;
  dates: string[];
  daysInWeek: number;
  daysInMonth: number;
  fixEmps: Array<{ name: string; dept: string; monthlyCost: number; weeklyCost: number }>;
  flexEmps: Array<{ id: string; name: string; hourlyWage: number }>;
  year: number;
  month: number;
}

function WeekDetailPopup({ data, onClose }: { data: WeekDetailData | null; onClose: () => void }) {
  const { tenantKey } = useTenant();
  if (!data) return null;
  const { weekLabel, dateRange, dates, daysInWeek, daysInMonth, fixEmps, flexEmps, year, month } = data;

  // Flex per employee for this week
  const flexRows = flexEmps.map(emp => {
    const wage = emp.hourlyWage ?? 0;
    if (!wage) return null;
    const planW = loadDailyPlanDetails(emp.id, year, month, null, wage, tenantKey).filter(r => dates.includes(r.date));
    const istW  = loadDailyIstDetails(emp.id, year, month, null, wage, tenantKey).filter(r => dates.includes(r.date));
    const planH = planW.reduce((s, r) => s + r.hours, 0);
    const istH  = istW.reduce((s, r) => s + r.hours, 0);
    const planCost = planW.reduce((s, r) => s + r.cost, 0);
    const istCost  = istW.reduce((s, r) => s + r.cost, 0);
    if (planH === 0 && istH === 0) return null;
    return { name: emp.name, planH, istH, planCost, istCost, diff: istCost - planCost };
  }).filter(Boolean) as Array<{ name: string; planH: number; istH: number; planCost: number; istCost: number; diff: number }>;

  const totalFixWeek  = fixEmps.reduce((s, e) => s + e.weeklyCost, 0);
  const totalFlexPlan = flexRows.reduce((s, r) => s + r.planCost, 0);
  const totalFlexIst  = flexRows.reduce((s, r) => s + r.istCost, 0);
  const totalPlan = totalFixWeek + totalFlexPlan;
  const totalIst  = totalFixWeek + totalFlexIst;

  const diffCls = (v: number) => v > 0.005 ? 'text-red-600 dark:text-red-400' : v < -0.005 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground';
  const fmtD = (v: number) => `${v > 0.005 ? '+' : v < -0.005 ? '−' : ''}${fmtCHF(Math.abs(v))}`;

  return (
    <Dialog open={!!data} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="p-0 gap-0 max-w-none w-[min(780px,95vw)] flex flex-col max-h-[85vh] overflow-hidden">
        {/* Header */}
        <div className="shrink-0 px-5 py-4 border-b border-border bg-violet-50/40 dark:bg-violet-950/20">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold">{weekLabel} — Kostendetail</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{dateRange} · {daysInWeek} von {daysInMonth} Tagen</p>
            </div>
            <div className="flex gap-4 text-xs font-mono">
              <span className="text-muted-foreground">Plan Total <span className="text-foreground font-bold">{fmtCHF(totalPlan)}</span></span>
              <span className="text-muted-foreground">Ist Total <span className="text-foreground font-bold">{fmtCHF(totalIst)}</span></span>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* FIX Section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
                Personal FIX (pro-rata {daysInWeek}/{daysInMonth} Tage)
              </p>
              <span className="text-xs font-mono font-semibold text-blue-700 dark:text-blue-300">{fmtCHF(totalFixWeek)}</span>
            </div>
            {fixEmps.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Keine Fix-Mitarbeiter</p>
            ) : (
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/60">
                      <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground">Mitarbeiter</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-muted-foreground">Monat</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-muted-foreground">Woche ({daysInWeek}T)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fixEmps.map((e, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-1.5 font-medium">{e.name} <span className="text-muted-foreground font-normal">({e.dept})</span></td>
                        <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmtCHF(e.monthlyCost)}</td>
                        <td className="px-3 py-1.5 text-right font-mono font-semibold">{fmtCHF(e.weeklyCost)}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-border bg-muted/40 font-bold">
                      <td className="px-3 py-1.5">Total FIX</td>
                      <td className="px-3 py-1.5 text-right font-mono"></td>
                      <td className="px-3 py-1.5 text-right font-mono text-blue-700 dark:text-blue-300">{fmtCHF(totalFixWeek)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* FLEX Section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-orange-600 dark:text-orange-400">Personal FLEX</p>
              <div className="flex gap-3 text-xs font-mono">
                <span className="text-blue-600 dark:text-blue-400">Plan {fmtCHF(totalFlexPlan)}</span>
                <span className="text-orange-600 dark:text-orange-400">Ist {fmtCHF(totalFlexIst)}</span>
                <span className={cn('font-semibold', diffCls(totalFlexIst - totalFlexPlan))}>{fmtD(totalFlexIst - totalFlexPlan)}</span>
              </div>
            </div>
            {flexRows.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Kein Flex-Einsatz in dieser Woche</p>
            ) : (
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/60">
                      <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground">Mitarbeiter</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-blue-600 dark:text-blue-400">Plan Std</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-blue-600 dark:text-blue-400">Plan CHF</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-orange-600 dark:text-orange-400">Ist Std</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-orange-600 dark:text-orange-400">Ist CHF</th>
                      <th className="px-3 py-1.5 text-right font-semibold text-muted-foreground">Δ CHF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flexRows.map((r, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-1.5 font-medium">{r.name}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{r.planH.toFixed(1)}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{fmtCHF(r.planCost)}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{r.istH.toFixed(1)}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{fmtCHF(r.istCost)}</td>
                        <td className={cn('px-3 py-1.5 text-right font-mono font-semibold', diffCls(r.diff))}>{fmtD(r.diff)}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-border bg-muted/40 font-bold">
                      <td className="px-3 py-1.5">Total FLEX</td>
                      <td className="px-3 py-1.5 text-right font-mono"></td>
                      <td className="px-3 py-1.5 text-right font-mono text-blue-600 dark:text-blue-400">{fmtCHF(totalFlexPlan)}</td>
                      <td className="px-3 py-1.5 text-right font-mono"></td>
                      <td className="px-3 py-1.5 text-right font-mono text-orange-600 dark:text-orange-400">{fmtCHF(totalFlexIst)}</td>
                      <td className={cn('px-3 py-1.5 text-right font-mono font-semibold', diffCls(totalFlexIst - totalFlexPlan))}>{fmtD(totalFlexIst - totalFlexPlan)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Total row */}
          <div className="rounded-lg border-2 border-violet-200 dark:border-violet-800 bg-violet-50/30 dark:bg-violet-950/20 px-4 py-3">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-[10px] uppercase font-semibold text-muted-foreground mb-0.5">FIX (Woche)</p>
                <p className="font-mono font-bold text-blue-700 dark:text-blue-300">{fmtCHF(totalFixWeek)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-semibold text-muted-foreground mb-0.5">Total Plan</p>
                <p className="font-mono font-bold">{fmtCHF(totalPlan)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-semibold text-muted-foreground mb-0.5">Total Ist</p>
                <p className={cn('font-mono font-bold', diffCls(totalIst - totalPlan))}>{fmtCHF(totalIst)}</p>
                {Math.abs(totalIst - totalPlan) > 0.5 && (
                  <p className={cn('text-[10px] font-semibold font-mono', diffCls(totalIst - totalPlan))}>
                    {fmtD(totalIst - totalPlan)} vs. Plan
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── FlexBreakdownModal ─────────────────────────────────────────────────────────

function FlexBreakdownModal({ target, onClose }: {
  target: BreakdownTarget | null;
  onClose: () => void;
}) {
  const { tenantKey } = useTenant();
  if (!target) return null;

  const { empId, empName, field, hourlyWage, weeklyHours, year, month, cutoffDay, factor } = target;
  const dailyH      = weeklyHours ? weeklyHours / 5 : 8.4;
  const monthLabel  = new Date(year, month - 1, 1).toLocaleString('de-CH', { month: 'long', year: 'numeric' });
  const cutoffLabel = cutoffDay !== null
    ? `${cutoffDay}.${String(month).padStart(2, '0')}.${year}`
    : null;

  // ── Always load all 4 data sources ─────────────────────────────────────────
  const planWorkDays = loadDailyPlanDetails(empId, year, month, cutoffDay, hourlyWage, tenantKey);
  const istWorkDays  = loadDailyIstDetails(empId, year, month, cutoffDay, hourlyWage, tenantKey);
  const ferPlanDays  = loadFerienPlanDayDetails(empId, year, month, cutoffDay, dailyH, hourlyWage, tenantKey);
  const ferIstDays   = loadFerienIstDayDetails(empId, year, month, cutoffDay, dailyH, hourlyWage, tenantKey);

  // ── Unified work day map ────────────────────────────────────────────────────
  type WorkRow = { date: string; planH: number; planCHF: number; istH: number; istCHF: number };
  const workMap = new Map<string, WorkRow>();
  for (const r of planWorkDays) {
    const e = workMap.get(r.date) ?? { date: r.date, planH: 0, planCHF: 0, istH: 0, istCHF: 0 };
    e.planH += r.hours; e.planCHF += r.cost; workMap.set(r.date, e);
  }
  for (const r of istWorkDays) {
    const e = workMap.get(r.date) ?? { date: r.date, planH: 0, planCHF: 0, istH: 0, istCHF: 0 };
    e.istH += r.hours; e.istCHF += r.cost; workMap.set(r.date, e);
  }
  const workRows = Array.from(workMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // ── Unified ferien day map ──────────────────────────────────────────────────
  type FerRow = { date: string; planCHF: number; istCHF: number };
  const ferMap = new Map<string, FerRow>();
  for (const r of ferPlanDays) {
    const e = ferMap.get(r.date) ?? { date: r.date, planCHF: 0, istCHF: 0 };
    e.planCHF += r.cost; ferMap.set(r.date, e);
  }
  for (const r of ferIstDays) {
    const e = ferMap.get(r.date) ?? { date: r.date, planCHF: 0, istCHF: 0 };
    e.istCHF += r.cost; ferMap.set(r.date, e);
  }
  const ferRows = Array.from(ferMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // ── Totals ─────────────────────────────────────────────────────────────────
  const totalPlanWork = workRows.reduce((s, r) => s + r.planCHF, 0);
  const totalIstWork  = workRows.reduce((s, r) => s + r.istCHF,  0);
  const totalPlanH    = workRows.reduce((s, r) => s + r.planH,   0);
  const totalIstH     = workRows.reduce((s, r) => s + r.istH,    0);
  const totalPlanFer  = ferRows.reduce((s, r) => s + r.planCHF, 0);
  const totalIstFer   = ferRows.reduce((s, r) => s + r.istCHF,  0);
  const totalPlan     = totalPlanWork + totalPlanFer;
  const totalIst      = totalIstWork  + totalIstFer;
  const diffWork      = totalIstWork  - totalPlanWork;
  const diffFer       = totalIstFer   - totalPlanFer;
  const diffTotal     = totalIst - totalPlan;
  const diffWorkPct   = totalPlanWork > 0 ? (diffWork / totalPlanWork) * 100 : 0;
  const diffTotalPct  = totalPlan > 0 ? (diffTotal / totalPlan) * 100 : 0;
  const noData        = totalPlan === 0 && totalIst === 0;

  // ── Kumulierte Abweichung über workRows ────────────────────────────────────
  let _cumPopup = 0;
  const workRowsWithCum = workRows.map(r => {
    const dCHF = r.istCHF - r.planCHF;
    _cumPopup += dCHF;
    console.log(`[POPUP-CUM] employee: ${empName}`);
    console.log(`[POPUP-CUM] row diff: ${dCHF.toFixed(2)} (${r.date})`);
    console.log(`[POPUP-CUM] running diff total: ${_cumPopup.toFixed(2)}`);
    return { ...r, dCHF, cumDiff: _cumPopup };
  });
  const cumDiffTotal = _cumPopup;

  // ── Ampel ──────────────────────────────────────────────────────────────────
  const overallSt = ampelStatus(diffTotal, totalPlan);
  const overallA  = AMPEL[overallSt];

  // ── Debug logs ─────────────────────────────────────────────────────────────
  const popupMode = cutoffDay !== null ? `cutoff:${cutoffDay}` : 'month';
  console.log(`[POPUP] employee: ${empName}`);
  console.log(`[POPUP] mode: ${popupMode}`);
  console.log(`[POPUP] plan work total: ${totalPlanWork.toFixed(2)}`);
  console.log(`[POPUP] ist work total: ${totalIstWork.toFixed(2)}`);
  console.log(`[POPUP] diff total chf: ${diffTotal.toFixed(2)}`);
  console.log(`[POPUP] daily rows count: ${workRows.length}`);

  // ── Inline helpers ─────────────────────────────────────────────────────────
  const fmtD = (v: number) => {
    const s = fmtCHF(Math.abs(v));
    return v > 0.005 ? `+${s}` : v < -0.005 ? `−${s}` : s;
  };
  const fmtDH = (v: number) => {
    const s = `${Math.abs(v).toFixed(2)} h`;
    return v > 0.005 ? `+${s}` : v < -0.005 ? `−${s}` : s;
  };
  const diffCls = (v: number) =>
    v > 0.005  ? 'text-red-600 dark:text-red-400' :
    v < -0.005 ? 'text-emerald-600 dark:text-emerald-400' :
                 'text-muted-foreground';
  const thCls = 'sticky top-0 z-10 bg-muted/80 backdrop-blur-sm px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground border-b border-border';

  const fieldLabels: Record<BreakdownField, string> = {
    planWork: 'Flex Arbeit Plan', istWork: 'Flex Arbeit Ist',
    planHoliday: 'Ferien Plan',   istHoliday: 'Ferien Ist',
    planTotalVar: 'Total Flex Plan', istTotalVar: 'Total Flex Ist',
  };

  return (
    <Dialog open={!!target} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="p-0 gap-0 max-w-none w-[min(1000px,95vw)] flex flex-col max-h-[88vh] overflow-hidden">

        {/* ── Sticky Header ─────────────────────────────────────────────── */}
        <div className={cn('shrink-0 px-6 py-4 border-b', overallA.border,
          overallA.bg || 'bg-indigo-50/60 dark:bg-indigo-950/20')}>
          {/* Row 1: Name + meta + Ampel badge */}
          <div className="flex items-start gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-bold leading-tight truncate">{empName}</h2>
              <div className="flex items-center gap-2 flex-wrap mt-0.5">
                <span className="text-sm text-muted-foreground">{monthLabel}</span>
                {cutoffLabel && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 text-[11px] font-semibold px-2.5 py-0.5 border border-violet-300 dark:border-violet-700">
                    Stichtag {cutoffLabel} · {Math.round(factor * 100)} %
                  </span>
                )}
                {hourlyWage > 0 && (
                  <span className="rounded-full bg-muted border border-border px-2 py-0.5 text-[11px] font-mono text-muted-foreground">
                    {fmtCHFDec(hourlyWage)}/h
                  </span>
                )}
                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                  ← {fieldLabels[field]}
                </span>
              </div>
            </div>
            <div className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold shrink-0', overallA.border, overallA.text)}>
              <span className={cn('inline-block w-2.5 h-2.5 rounded-full', overallA.dot)} />
              {overallA.label}
            </div>
          </div>

          {/* Row 2: KPI comparison chips */}
          {!noData && (
            <div className="flex flex-wrap gap-2 mt-3">
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-background/80 px-3 py-1.5 text-xs">
                <span className="text-muted-foreground font-medium">Flex Arbeit:</span>
                <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">{fmtCHF(totalPlanWork)}</span>
                <span className="text-muted-foreground">→</span>
                <span className="font-mono font-semibold text-orange-700 dark:text-orange-400">{fmtCHF(totalIstWork)}</span>
                <span className={cn('font-mono font-bold ml-0.5', diffCls(diffWork))}>{fmtD(diffWork)}</span>
                {totalPlanWork > 0 && <span className={cn('text-[10px]', diffCls(diffWork))}>({diffWorkPct > 0.005 ? '+' : ''}{diffWorkPct.toFixed(1)} %)</span>}
              </div>
              {(totalPlanFer > 0 || totalIstFer > 0) && (
                <div className="flex items-center gap-1.5 rounded-lg border border-border bg-background/80 px-3 py-1.5 text-xs">
                  <span className="text-muted-foreground font-medium">Ferien:</span>
                  <span className="font-mono font-semibold text-blue-500 dark:text-blue-300">{fmtCHF(totalPlanFer)}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="font-mono font-semibold text-orange-500 dark:text-orange-300">{fmtCHF(totalIstFer)}</span>
                  <span className={cn('font-mono font-bold ml-0.5', diffCls(diffFer))}>{fmtD(diffFer)}</span>
                </div>
              )}
              <div className={cn('flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold', overallA.border, overallA.bg)}>
                <span className="text-muted-foreground font-medium">Total Flex:</span>
                <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">{fmtCHF(totalPlan)}</span>
                <span className="text-muted-foreground">→</span>
                <span className="font-mono font-semibold text-orange-700 dark:text-orange-400">{fmtCHF(totalIst)}</span>
                <span className={cn('font-mono font-bold ml-0.5', overallA.text)}>{fmtD(diffTotal)}</span>
                {totalPlan > 0 && <span className={cn('text-[10px]', overallA.text)}>({diffTotalPct > 0.005 ? '+' : ''}{diffTotalPct.toFixed(1)} %)</span>}
              </div>
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-background/80 px-3 py-1.5 text-xs">
                <span className="text-muted-foreground font-medium">Kum. Abw.:</span>
                <span className={cn('font-mono font-bold', diffCls(cumDiffTotal))}>
                  {cumDiffTotal > 0.005 ? '+' : cumDiffTotal < -0.005 ? '−' : ''}{fmtCHF(Math.abs(cumDiffTotal))}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* ── Scrollable Body ───────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 text-sm">

          {noData ? (
            <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
              Keine Plan- oder Ist-Daten für diesen Mitarbeiter im gewählten Zeitraum.
            </div>
          ) : (
            <>
              {/* ── Flex Arbeit Plan vs. Ist ──────────────────────────── */}
              {workRows.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Flex Arbeit — Plan vs. Ist
                  </p>
                  <div className="rounded-md border border-border">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr>
                          <th className={cn(thCls, 'text-center w-7')}>●</th>
                          <th className={cn(thCls, 'text-left')}>Datum</th>
                          <th className={cn(thCls, 'text-right text-blue-600')}>Plan Std.</th>
                          <th className={cn(thCls, 'text-right text-orange-600')}>Ist Std.</th>
                          <th className={cn(thCls, 'text-right')}>Diff Std.</th>
                          <th className={cn(thCls, 'text-right text-blue-600')}>Plan CHF</th>
                          <th className={cn(thCls, 'text-right text-orange-600')}>Ist CHF</th>
                          <th className={cn(thCls, 'text-right')}>Diff CHF</th>
                          <th className={cn(thCls, 'text-right')}>Kum. Diff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workRowsWithCum.map((r, i) => {
                          const dH   = r.istH   - r.planH;
                          const rSt  = (r.planCHF === 0 && r.istCHF === 0) ? 'neutral' as AmpelStatus : ampelStatus(r.dCHF, r.planCHF);
                          const rA   = AMPEL[rSt];
                          const cumCls = r.cumDiff > 0.005 ? 'text-red-600 dark:text-red-400'
                            : r.cumDiff < -0.005 ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-muted-foreground';
                          return (
                            <tr key={i} className={cn(i % 2 === 0 ? 'bg-background' : 'bg-muted/15', rA.bg)}>
                              <td className="px-2 py-1.5 text-center"><span className={cn('inline-block w-2 h-2 rounded-full', rA.dot)} /></td>
                              <td className="px-3 py-1.5 font-mono">{fmtDate(r.date)}</td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-blue-600">{r.planH > 0 ? `${r.planH.toFixed(2)} h` : '–'}</td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-orange-600">{r.istH > 0 ? `${r.istH.toFixed(2)} h` : '–'}</td>
                              <td className={cn('px-3 py-1.5 text-right font-mono tabular-nums', diffCls(dH))}>{(r.planH === 0 && r.istH === 0) ? '–' : fmtDH(dH)}</td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-blue-700 dark:text-blue-400">{r.planCHF > 0 ? fmtCHFDec(r.planCHF) : '–'}</td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-orange-700 dark:text-orange-400">{r.istCHF > 0 ? fmtCHFDec(r.istCHF) : '–'}</td>
                              <td className={cn('px-3 py-1.5 text-right font-mono tabular-nums font-semibold', diffCls(r.dCHF))}>{(r.planCHF === 0 && r.istCHF === 0) ? '–' : fmtD(r.dCHF)}</td>
                              <td className={cn('px-3 py-1.5 text-right font-mono tabular-nums font-semibold text-[11px]', cumCls)}>
                                {r.cumDiff > 0.005 ? '+' : r.cumDiff < -0.005 ? '−' : ''}{fmtCHF(Math.abs(r.cumDiff))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className={cn('border-t-2 border-border font-bold text-xs', overallA.bg)}>
                          <td className="px-2 py-2 text-center"><span className={cn('inline-block w-2 h-2 rounded-full', overallA.dot)} /></td>
                          <td className="px-3 py-2">Total ({workRows.length} T.)</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-blue-600">{totalPlanH > 0 ? `${(Math.round(totalPlanH * 10) / 10).toFixed(1)} h` : '–'}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-orange-600">{totalIstH > 0 ? `${(Math.round(totalIstH * 10) / 10).toFixed(1)} h` : '–'}</td>
                          <td className={cn('px-3 py-2 text-right font-mono tabular-nums', diffCls(totalIstH - totalPlanH))}>{fmtDH(totalIstH - totalPlanH)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-blue-700 dark:text-blue-400">{fmtCHF(totalPlanWork)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-orange-700 dark:text-orange-400">{fmtCHF(totalIstWork)}</td>
                          <td className={cn('px-3 py-2 text-right font-mono tabular-nums', diffCls(diffWork))}>{fmtD(diffWork)}</td>
                          <td className={cn('px-3 py-2 text-right font-mono tabular-nums', diffCls(cumDiffTotal))}>
                            {cumDiffTotal > 0.005 ? '+' : cumDiffTotal < -0.005 ? '−' : ''}{fmtCHF(Math.abs(cumDiffTotal))}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Ferien Plan vs. Ist ─────────────────────────────── */}
              {ferRows.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Ferienabbau (FE) — Plan vs. Ist
                  </p>
                  <div className="rounded-md border border-border">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr>
                          <th className={cn(thCls, 'text-center w-7')}>●</th>
                          <th className={cn(thCls, 'text-left')}>Datum</th>
                          <th className={cn(thCls, 'text-right text-blue-500')}>Plan Ferien CHF</th>
                          <th className={cn(thCls, 'text-right text-orange-500')}>Ist Ferien CHF</th>
                          <th className={cn(thCls, 'text-right')}>Diff CHF</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ferRows.map((r, i) => {
                          const dCHF = r.istCHF - r.planCHF;
                          const rSt  = (r.planCHF === 0 && r.istCHF === 0) ? 'neutral' as AmpelStatus : ampelStatus(dCHF, r.planCHF);
                          const rA   = AMPEL[rSt];
                          return (
                            <tr key={i} className={cn(i % 2 === 0 ? 'bg-background' : 'bg-muted/15', rA.bg)}>
                              <td className="px-2 py-1.5 text-center"><span className={cn('inline-block w-2 h-2 rounded-full', rA.dot)} /></td>
                              <td className="px-3 py-1.5 font-mono">{fmtDate(r.date)}</td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-blue-500 dark:text-blue-300">{r.planCHF > 0 ? fmtCHFDec(r.planCHF) : '–'}</td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-orange-500 dark:text-orange-300">{r.istCHF > 0 ? fmtCHFDec(r.istCHF) : '–'}</td>
                              <td className={cn('px-3 py-1.5 text-right font-mono tabular-nums font-semibold', diffCls(dCHF))}>{fmtD(dCHF)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-border bg-muted/40 font-bold text-xs">
                          <td className="px-2 py-2" />
                          <td className="px-3 py-2 text-muted-foreground">Total ({ferRows.length} Tag{ferRows.length !== 1 ? 'e' : ''})</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-blue-500 dark:text-blue-300">{fmtCHF(totalPlanFer)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-orange-500 dark:text-orange-300">{fmtCHF(totalIstFer)}</td>
                          <td className={cn('px-3 py-2 text-right font-mono tabular-nums', diffCls(diffFer))}>{fmtD(diffFer)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <p className="text-[10px] text-muted-foreground px-1">
                    Basis: {fmtCHFDec(hourlyWage)}/h × {dailyH.toFixed(2)} h/Tag = {fmtCHFDec(dailyH * hourlyWage)}/Ferientag
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Sticky Footer — Grand Total ───────────────────────────────── */}
        {(totalPlan > 0 || totalIst > 0) && (
          <div className={cn('shrink-0 border-t px-6 py-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-1',
            overallA.bg || 'bg-muted/50', overallA.border)}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Grand Total</span>
              <span className={cn('inline-flex items-center gap-1 rounded-full text-[10px] font-semibold px-2 py-0.5 border', overallA.border, overallA.text)}>
                <span className={cn('w-1.5 h-1.5 rounded-full inline-block', overallA.dot)} />
                {overallA.label}
              </span>
            </div>
            <div className="flex items-center gap-4 text-xs font-mono flex-wrap">
              {(totalPlanH > 0 || totalIstH > 0) && (
                <span className="text-muted-foreground text-[11px]">
                  {(Math.round(totalPlanH * 10)/10).toFixed(1)} h Plan / {(Math.round(totalIstH * 10)/10).toFixed(1)} h Ist
                </span>
              )}
              <span className="text-muted-foreground">Plan <span className="text-blue-700 dark:text-blue-400 font-semibold">{fmtCHF(totalPlan)}</span></span>
              <span className="text-muted-foreground">Ist <span className="text-orange-700 dark:text-orange-400 font-semibold">{fmtCHF(totalIst)}</span></span>
              <span className={cn('font-bold text-sm', overallA.text)}>{fmtD(diffTotal)}</span>
            </div>
          </div>
        )}

      </DialogContent>
    </Dialog>
  );
}

// ── Hauptseite ────────────────────────────────────────────────────────────────

export default function PersonalFixPage() {
  const { isAdmin, isBeaulieuManager, canEditEmployees } = usePermissions();
  const { tenantId, tenantKey } = useTenant();
  const { maisonExclude } = useMaison();
  const maisonOn = getMaisonEnabledSync(tenantKey);
  if (!isAdmin && !isBeaulieuManager) return <Navigate to="/personal" replace />;

  const today = new Date();
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);
  const [employees, setEmployees] = useState<Employee[]>([]);
  // Vollständige Supabase IST-Einträge (inkl. isAdditionalCost-Flag) für persistente Zusatzkosten-Berechnung
  const [supabaseActualHours, setSupabaseActualHours] = useState<Record<string, ActualHourEntry>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [varHours, setVarHours] = useState<Record<string, number>>(() => loadVarHours(tenantKey));
  const [varWeekly, setVarWeekly] = useState<Record<string, WeeklyBaseline>>(() => loadVarWeekly(tenantKey));
  const [varPricingMode, setVarPricingMode] = useState<Record<string, PricingMode>>(() => loadVarPricingMode(tenantKey));
  const [varDayRate, setVarDayRate] = useState<Record<string, DayRateData>>(() => loadVarDayRate(tenantKey));
  const [varView, setVarView] = useState<VarView>('plan');
  const [planHours, setPlanHours] = useState<Record<string, number>>({});
  const [istHours, setIstHours] = useState<Record<string, number>>({});
  // empId → Anzahl FE-Tage im Ist (absenceType='FE' in actual-hours-* localStorage)
  const [ferienIstDays, setFerienIstDays] = useState<Record<string, number>>({});
  // empId → Anzahl FE-Tage im PLAN (frühAbsence/spätAbsence='FE' in schedule-v2-* localStorage)
  const [ferienPlanDays, setFerienPlanDays] = useState<Record<string, number>>({});
  // Tagesumsätze für den gewählten Monat (für Stichtag Controlling)
  const [monthlyRevenues, setMonthlyRevenues] = useState<Record<string, { actualRevenue?: number; takeawayRevenue?: number }>>({});
  // Manuelle Umsatz-Annahme für PKQ-Berechnung (gespeichert per Monat/Tenant)
  const [revenueAssumption, setRevenueAssumption] = useState<number | null>(() =>
    loadRevenueAssumption(today.getFullYear(), today.getMonth() + 1, tenantKey),
  );
  const [revenueAssumptionInput, setRevenueAssumptionInput] = useState(() => {
    const v = loadRevenueAssumption(today.getFullYear(), today.getMonth() + 1, tenantKey);
    return v != null ? String(v) : '';
  });
  const [budgetRevenue, setBudgetRevenue] = useState<number | null>(() =>
    loadBudgetRevenue(today.getFullYear(), today.getMonth() + 1, tenantKey),
  );
  const [budgetRevenueInput, setBudgetRevenueInput] = useState(() => {
    const v = loadBudgetRevenue(today.getFullYear(), today.getMonth() + 1, tenantKey);
    return v != null ? String(v) : '';
  });
  const [weekIstSet, setWeekIstSet] = useState<Set<string>>(() =>
    new Set(loadWeekIstSet(today.getFullYear(), today.getMonth() + 1, tenantKey)),
  );
  const [weekRevOverrides, setWeekRevOverrides] = useState<Record<string, number>>(() =>
    loadWeekRevOverrides(today.getFullYear(), today.getMonth() + 1, tenantKey),
  );
  const [weekRevEditKey, setWeekRevEditKey] = useState<string | null>(null);
  const [weekRevEditVal, setWeekRevEditVal] = useState('');
  const [scenarioPkCost, setScenarioPkCost] = useState<number | null>(() =>
    loadScenarioPkCost(today.getFullYear(), today.getMonth() + 1, tenantKey),
  );
  const [scenarioPkCostInput, setScenarioPkCostInput] = useState(() => {
    const v = loadScenarioPkCost(today.getFullYear(), today.getMonth() + 1, tenantKey);
    return v != null ? String(v) : '';
  });
  const [scenarioPkqInput, setScenarioPkqInput] = useState('');
  const [weekDetailTarget, setWeekDetailTarget] = useState<string | null>(null);
  const [showWeekSummary, setShowWeekSummary] = useState(false);

  // ── Pro-Rata-Abgrenzung ────────────────────────────────────────────────────
  // null = aus; Zahl = Stichtag (1–letzter Tag des Monats)
  const [proRataDay, setProRataDay] = useState<number | null>(null);

  // ── Flex-Breakdown-Popup ──────────────────────────────────────────────────
  const [breakdown, setBreakdown] = useState<BreakdownTarget | null>(null);
  const [abwMode,   setAbwMode]   = useState<AbwMode>('day');
  const [forecastViewMode, setForecastViewMode] = useState<'actual' | 'forecast'>('actual');
  const [dayDetailModal, setDayDetailModal] = useState<AbwDay | null>(null);
  const [forecastIstDay,   setForecastIstDay]   = useState<number | null>(null);
  const [flexPeriodPopup,  setFlexPeriodPopup]  = useState<FlexPeriodTarget | null>(null);
  const [expandedFixDepts, setExpandedFixDepts] = useState<Set<string>>(new Set());
  // Incremented whenever schedule-v2-* localStorage changes (schedule-updated event)
  // so that pfixPerEmp and planHours re-read the latest data without a page reload.
  const [scheduleRefreshTick, setScheduleRefreshTick] = useState(0);

  useEffect(() => {
    const handler = () => setScheduleRefreshTick(t => t + 1);
    window.addEventListener('schedule-updated', handler);
    return () => window.removeEventListener('schedule-updated', handler);
  }, []);

  // Contract history for mid-month switch detection
  const contractHistoryMap = useMemo(
    () => loadAllContractHistory(tenantKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tenantId],
  );

  useEffect(() => {
    setLoading(true);
    console.log(`[EMPLOYEE LOAD] tenant: ${tenantId}`);
    loadEmployees(tenantId).then(async emps => {
      if (emps) {
        const effectiveDate = firstOfMonth(selectedYear, selectedMonth);
        const enriched = await applyEffectiveWages(emps, effectiveDate, tenantId);
        setEmployees(enriched);
        console.log(`[EMPLOYEE LOAD] count: ${enriched.length}`);
        // ─── [CONSISTENCY] Standardformat-Logs ───────────────────────────
        console.log(`[CONSISTENCY] tenant: ${tenantId}`);
        console.log(`[CONSISTENCY] personal_fix employees: ${emps.length}`);
        console.log(`[CONSISTENCY] employee names personal_fix: ${emps.map(e => e.name).join(', ')}`);
        if (tenantId === 'beaulieu') {
          const olivNames = ['arber', 'artin', 'carlos', 'mendim', 'joana', 'husein', 'mejdi', 'miro', 'culi', 'eduard', 'nahuel', 'nina'];
          const leak = emps.filter(e => olivNames.some(o => e.name.toLowerCase().includes(o)));
          console.log(`[CONSISTENCY] mismatch: ${leak.length > 0 ? 'yes – Oliv-Leak: ' + leak.map(e => e.name).join(', ') : 'no'}`);
          const küche   = emps.filter(e => e.department === 'küche');
          const service = emps.filter(e => e.department === 'service');
          console.log(`[CONSISTENCY] personal_fix breakdown: Küche=${küche.length}, Service=${service.length}`);
          // ─── [BEAULIEU-WAGE] Lohnvollständigkeit ─────────────────────────
          const missingWage = emps.filter(e => (e.hourlyWage ?? 0) === 0 && (e.monthlySalary ?? 0) === 0);
          console.log(`[BEAULIEU-WAGE] Mitarbeiter ohne Lohn: ${missingWage.length}/${emps.length}`);
          if (missingWage.length > 0) {
            console.log(`[BEAULIEU-WAGE] Fehlende Löhne bei: ${missingWage.map(e => e.name).join(', ')}`);
          } else {
            console.log(`[BEAULIEU-WAGE] Alle Löhne hinterlegt – OK`);
          }
        } else {
          const beaulieuLeak = emps.filter(e => String(e.id).startsWith('b-'));
          console.log(`[CONSISTENCY] mismatch: ${beaulieuLeak.length > 0 ? 'yes – Beaulieu-Leak in Oliv' : 'no'}`);
        }
      } else {
        setEmployees([]);
        console.log(`[CONSISTENCY] personal_fix employees: 0 (keine Daten von Supabase)`);
      }
      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);


  // Tagesumsätze bei Monatswechsel neu laden
  useEffect(() => {
    setMonthlyRevenues(readDailyBudgetsLocal(selectedYear, selectedMonth, tenantKey));
    const onSync = () => setMonthlyRevenues(readDailyBudgetsLocal(selectedYear, selectedMonth, tenantKey));
    window.addEventListener('supabase-kv-synced', onSync);
    return () => window.removeEventListener('supabase-kv-synced', onSync);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, selectedMonth, tenantId]);

  // Reload Plan/Ist hours whenever month changes OR schedule-updated fires.
  // Plan-Stunden: read localStorage first (fast), then enrich with Supabase schedule data.
  // Ist-Stunden: read localStorage first (fast), then enrich with Supabase data.
  // Supabase is the canonical source when both planners write there; localStorage
  // is the fallback/cache for entries that haven't round-tripped through Supabase.
  // scheduleRefreshTick: incremented by schedule-updated listener → triggers re-read
  // without full Supabase round-trip (skip the async enrichment on tick-only changes).
  useEffect(() => {
    // Fast local read first (instant, no flicker)
    setPlanHours(loadPlanHoursFromStorage(selectedYear, selectedMonth, tenantKey));
    setFerienPlanDays(loadFerienDaysFromPlanStorage(selectedYear, selectedMonth, tenantKey));
    if (scheduleRefreshTick > 0) return; // tick-only refresh: localStorage is already current
    // FE-Ferientage immer aus localStorage (Supabase speichert kein absenceType)
    const istFE = loadFerienDaysFromStorage(selectedYear, selectedMonth, tenantKey);
    setFerienIstDays(istFE);
    const planFE = loadFerienDaysFromPlanStorage(selectedYear, selectedMonth, tenantKey);
    setFerienPlanDays(planFE);
    console.log(`[FERIEN] preserved on reload: ist=${Object.values(istFE).reduce((s, v) => s + v, 0)} plan=${Object.values(planFE).reduce((s, v) => s + v, 0)} FE-Tage gesamt`);

    // Enrich plan hours from Supabase (schedule_entries) — same pattern as ist-hours below.
    // This ensures plan data is always current even if the user never opened Dienstplanung
    // on this device (Supabase is the canonical write path for the schedule planner).
    const scheduleMonthDate = new Date(selectedYear, selectedMonth - 1, 1);
    loadScheduleForMonth(scheduleMonthDate, tenantId).then(supabaseSchedule => {
      if (!supabaseSchedule) return; // Supabase error – keep local result
      const totalEntries = Object.keys(supabaseSchedule).length;
      console.log(`[PLAN] personal-fix schedule loaded from Supabase: ${totalEntries} Einträge für ${selectedYear}-${String(selectedMonth).padStart(2, '0')}`);
      if (totalEntries === 0) {
        // Guard: never overwrite a populated localStorage cache with an empty Supabase result.
        // An empty result can mean transient RLS/auth timing issues (not a genuinely empty month).
        const scheduleKey = tenantKey(`schedule-v2-${selectedYear}-${String(selectedMonth).padStart(2, '0')}`);
        try {
          const existing = localStorage.getItem(scheduleKey);
          const existingCount = existing ? Object.keys(JSON.parse(existing)).length : 0;
          if (existingCount > 0) {
            console.warn(`[PLAN] personal-fix: Supabase returned 0 rows but localStorage has ${existingCount} entries – skipping overwrite`);
            return;
          }
        } catch { /* ignore parse errors */ }
        // Both empty – ok to skip write (no point writing {})
        return;
      }
      const scheduleKey = tenantKey(`schedule-v2-${selectedYear}-${String(selectedMonth).padStart(2, '0')}`);
      try {
        // Merge existing isAdditionalCostPlan / isAdditionalCost flags from localStorage
        // before overwriting — these are stored locally only and must survive a Supabase reload.
        const existingRaw = localStorage.getItem(scheduleKey);
        const existing: Record<string, Record<string, unknown>> = existingRaw ? JSON.parse(existingRaw) : {};
        const merged: Record<string, unknown> = { ...supabaseSchedule };
        for (const [cellKey, val] of Object.entries(existing)) {
          if (val?.isAdditionalCostPlan) {
            (merged[cellKey] as Record<string, unknown>) = { ...((merged[cellKey] as Record<string, unknown>) ?? {}), isAdditionalCostPlan: true };
          }
          if (val?.isAdditionalCost) {
            (merged[cellKey] as Record<string, unknown>) = { ...((merged[cellKey] as Record<string, unknown>) ?? {}), isAdditionalCost: true };
          }
        }
        localStorage.setItem(scheduleKey, JSON.stringify(merged));
      } catch { /* quota exceeded */ }
      // Re-read plan hours and ferien plan from the freshly written cache
      setPlanHours(loadPlanHoursFromStorage(selectedYear, selectedMonth, tenantKey));
      setFerienPlanDays(loadFerienDaysFromPlanStorage(selectedYear, selectedMonth, tenantKey));
    });

    // Fast local read first
    const localIst = loadIstHoursFromStorage(selectedYear, selectedMonth, tenantKey);
    setIstHours(localIst);

    // Then enrich with Supabase (async)
    const monthDate = new Date(selectedYear, selectedMonth - 1, 1);
    loadActualHoursForMonth(monthDate, tenantId).then(supabaseRaw => {
      if (!supabaseRaw) return; // Supabase error – keep local result
      // Vollständige Einträge speichern (inkl. isAdditionalCost für Zusatzkosten-Berechnung)
      setSupabaseActualHours(supabaseRaw);

      // Read localStorage now — needed for FE absence check and write-back
      const monthKey = tenantKey(`actual-hours-${selectedYear}-${String(selectedMonth).padStart(2, '0')}`);
      const existingLocal: Record<string, unknown> = (() => {
        try { return JSON.parse(localStorage.getItem(monthKey) || '{}'); } catch { return {}; }
      })();

      // Aggregate by empId — skip days where localStorage has FE absence.
      // Admin FE marking is authoritative over Mirus import data.
      const supabaseAgg: Record<string, number> = {};
      for (const [cellKey, entry] of Object.entries(supabaseRaw)) {
        const empId = cellKey.slice(0, cellKey.length - 11);
        if (!empId) continue;
        const localEntry = existingLocal[cellKey] as Record<string, unknown> | undefined;
        if ((localEntry as any)?.absenceType === 'FE') continue; // FE override wins
        const h = entry?.hours ?? 0;
        if (h > 0) supabaseAgg[empId] = (supabaseAgg[empId] ?? 0) + Math.round(h * 100) / 100;
      }
      // Merge: Supabase (FE-filtered) wins over localStorage aggregation on conflict
      const merged = { ...localIst, ...supabaseAgg };
      const totalH = Object.values(merged).reduce((s, h) => s + h, 0);
      console.log(
        `[IST] personal-fix rows loaded (merged): ${Object.keys(merged).length} Mitarbeiter / ${Math.round(totalH * 10) / 10} h`,
        { localStorage: Object.keys(localIst).length, supabase: Object.keys(supabaseAgg).length },
      );
      setIstHours(merged);

      // Write merged back to localStorage — FE/K/F absenceType entries must NEVER be
      // overwritten by Supabase data (Supabase has no absenceType column; FE are localStorage-only).
      if (Object.keys(supabaseRaw).length > 0) {
        // Start from local (preserves absenceType metadata), let Supabase win only for real hours
        const mergedRaw: Record<string, unknown> = { ...existingLocal };
        let fePreserved = 0;
        for (const [key, val] of Object.entries(supabaseRaw)) {
          const localEntry = mergedRaw[key] as Record<string, unknown> | undefined;
          if (localEntry?.absenceType) {
            // Local FE/K/F entry protected — admin override wins over Mirus data
            fePreserved++;
            console.log(`[FERIEN] preserved on navigation: ${key} absenceType=${localEntry?.absenceType}`);
          } else {
            // No local absence — Supabase wins, preserve localStorage-only flags
            mergedRaw[key] = localEntry?.isAdditionalCost
              ? { ...(val as object), isAdditionalCost: true }
              : val;
          }
        }
        if (fePreserved > 0) {
          console.log(`[FERIEN] PersonalFix load: preserved ${fePreserved} FE/K/F entries`);
        }
        localStorage.setItem(monthKey, JSON.stringify(mergedRaw));
        console.log(`[FERIEN] saved persistently: source=supabase+local merged=${Object.keys(mergedRaw).length}`);
      }
    }).catch(err => console.error('[IST] Supabase load failed in PersonalFix:', err));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, selectedMonth, tenantId, scheduleRefreshTick]);

  // Mandantenwechsel: varHours/varWeekly/etc. neu laden
  useEffect(() => {
    console.log(`[TENANT] PersonalFix: Mandant gewechselt → "${tenantId}", Var-Daten neu laden`);
    setVarHours(loadVarHours(tenantKey));
    setVarWeekly(loadVarWeekly(tenantKey));
    setVarPricingMode(loadVarPricingMode(tenantKey));
    setVarDayRate(loadVarDayRate(tenantKey));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // Umsatz-Annahme & Budget-Umsatz bei Monat- oder Mandantenwechsel neu laden
  useEffect(() => {
    const saved = loadRevenueAssumption(selectedYear, selectedMonth, tenantKey);
    setRevenueAssumption(saved);
    setRevenueAssumptionInput(saved != null ? String(saved) : '');
    const savedBudgetRev = loadBudgetRevenue(selectedYear, selectedMonth, tenantKey);
    setBudgetRevenue(savedBudgetRev);
    setBudgetRevenueInput(savedBudgetRev != null ? String(savedBudgetRev) : '');
    setWeekIstSet(new Set(loadWeekIstSet(selectedYear, selectedMonth, tenantKey)));
    setWeekRevOverrides(loadWeekRevOverrides(selectedYear, selectedMonth, tenantKey));
    setWeekRevEditKey(null);
    const savedScPk = loadScenarioPkCost(selectedYear, selectedMonth, tenantKey);
    setScenarioPkCost(savedScPk);
    setScenarioPkCostInput(savedScPk != null ? String(savedScPk) : '');
    setScenarioPkqInput('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, selectedMonth, tenantId]);

  const budgetData = useBudgetMonth(selectedYear, selectedMonth);
  const personnelBudget = budgetData.personnelBudget;

  const handleVarHoursChange = useCallback((empId: string, hours: number) => {
    setVarHours(prev => {
      const next = { ...prev, [empId]: hours };
      saveVarHours(next, tenantKey);
      return next;
    });
  }, []);

  const handleVarWeeklyChange = useCallback((empId: string, field: 'hours' | 'days', val: number | undefined) => {
    setVarWeekly(prev => {
      const existing = prev[empId] ?? {};
      const updated = val != null
        ? { ...existing, [field]: val }
        : { ...existing, [field]: undefined };
      const next = { ...prev, [empId]: updated };
      saveVarWeekly(next, tenantKey);
      return next;
    });
  }, []);

  const handlePricingModeToggle = useCallback((empId: string) => {
    setVarPricingMode(prev => {
      const current = prev[empId] ?? 'hourly';
      const next = { ...prev, [empId]: current === 'hourly' ? 'daily' : 'hourly' as PricingMode };
      saveVarPricingMode(next, tenantKey);
      return next;
    });
  }, []);

  const handleDayRateChange = useCallback((empId: string, field: keyof DayRateData, val: number | undefined) => {
    setVarDayRate(prev => {
      const existing = prev[empId] ?? { ratePerDay: 0 };
      const next = { ...prev, [empId]: { ...existing, [field]: val ?? 0 } };
      saveVarDayRate(next, tenantKey);
      return next;
    });
  }, []);

  const handleHourlyWageSaved = useCallback(async (empId: string, val: number) => {
    setSaving(empId);
    const emp = employees.find(e => e.id === empId);
    if (!emp) { setSaving(null); return; }
    const updated: Employee = { ...emp, hourlyWage: val };
    await upsertEmployee(updated, tenantId);
    setEmployees(prev => prev.map(e => e.id === empId ? updated : e));
    setSaving(null);
  }, [employees, tenantId]);

  const handleSaved = async (empId: string, field: 'monthlySalary' | 'monthlySalaryWith13th', val: number) => {
    setSaving(empId);
    const emp = employees.find(e => e.id === empId);
    if (!emp) { setSaving(null); return; }
    let updated: Employee;
    if (field === 'monthlySalary') {
      const with13 = emp.has13thSalary ? (val * 13) / 12 : undefined;
      updated = { ...emp, monthlySalary: val, monthlySalaryWith13th: with13 ?? emp.monthlySalaryWith13th };
    } else {
      updated = { ...emp, monthlySalaryWith13th: val };
    }
    await upsertEmployee(updated, tenantId);
    setEmployees(prev => prev.map(e => e.id === empId ? updated : e));
    setSaving(null);
  };

  // ── Sortierte Listen ───────────────────────────────────────────────────────

  const fixedEmployees = useMemo(() =>
    employees
      .filter(e => hasFixedSalary(e) && isEmployeeActiveInMonth(e, selectedYear, selectedMonth))
      .sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [employees, selectedYear, selectedMonth],
  );

  const variableEmployees = useMemo(() =>
    employees
      .filter(e => !hasFixedSalary(e) && isEmployeeActiveInMonth(e, selectedYear, selectedMonth))
      .sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [employees, selectedYear, selectedMonth],
  );

  // Beaulieu: Mitarbeiter ohne hinterlegten Lohn (weder Stunden- noch Monatslohn)
  const missingWageEmployees = useMemo(() =>
    employees.filter(e =>
      isEmployeeActiveInMonth(e, selectedYear, selectedMonth) &&
      (e.hourlyWage ?? 0) === 0 && (e.monthlySalary ?? 0) === 0,
    ),
    [employees, selectedYear, selectedMonth],
  );

  // ── Hilfsfunktion: Stunden je nach Ansicht ─────────────────────────────────

  const getVarHoursFor = useCallback((empId: string): number => {
    if (varView === 'plan') return planHours[empId] ?? 0;
    if (varView === 'ist')  return istHours[empId] ?? 0;
    // Manuell: manual monthly entry takes priority; weekly baseline as fallback
    const manual  = varHours[empId];
    const weekly  = varWeekly[empId];
    if (manual != null && manual > 0) return manual;
    if (weekly?.hours)  return Math.round(weekly.hours * WEEKS_PER_MONTH * 10) / 10;
    return 0;
  }, [varView, planHours, istHours, varHours, varWeekly]);

  /** Returns monthly cost regardless of pricing mode. */
  const getVarMonthlyCostFor = useCallback((empId: string, emp?: Employee): number => {
    const mode = varPricingMode[empId] ?? 'hourly';
    if (varView !== 'manual' || mode === 'hourly') {
      const foundEmp = emp ?? variableEmployees.find(e => e.id === empId);
      return getVarHoursFor(empId) * (foundEmp?.hourlyWage ?? 0);
    }
    // Tagessatz
    const dr = varDayRate[empId];
    if (!dr?.ratePerDay) return 0;
    const days = (dr.daysPerMonth ?? 0) > 0
      ? dr.daysPerMonth!
      : (dr.daysPerWeek ?? 0) > 0
        ? Math.round(dr.daysPerWeek! * WEEKS_PER_MONTH * 10) / 10
        : 0;
    return days * dr.ratePerDay;
  }, [varView, varPricingMode, varDayRate, variableEmployees, getVarHoursFor]);

  // ── Fix-Kosten mit Pro-rata je ausgewähltem Monat ─────────────────────────

  const fixedWithCost = useMemo(() =>
    fixedEmployees.map(emp => {
      const phases     = contractHistoryMap[emp.id] ?? [];
      const midSwitch  = getMidMonthSwitchInMonth(phases, selectedYear, selectedMonth);

      // Employee switched TO monthly mid-month → pro-rata from switch day
      if (midSwitch && midSwitch.contractType === 'monthly') {
        const switchDay   = parseInt(midSwitch.effectiveFrom.slice(8, 10), 10);
        const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
        const daysAsFixed = daysInMonth - switchDay + 1;
        const full        = getFixCost(emp);
        const cost        = Math.round(full * (daysAsFixed / daysInMonth) * 100) / 100;
        return {
          emp,
          cost,
          label: `Pro rata ab ${String(switchDay).padStart(2, '0')}.${String(selectedMonth).padStart(2, '0')}. (Vertragswechsel)`,
          excluded: false,
          yearlyCost: getYearlyFixCost(emp, selectedYear),
          hasMidMonthSwitch: true,
        };
      }

      return {
        ...getProRataFixCost(emp, selectedYear, selectedMonth),
        emp,
        yearlyCost: getYearlyFixCost(emp, selectedYear),
        hasMidMonthSwitch: false,
      };
    }),
    [fixedEmployees, selectedYear, selectedMonth, contractHistoryMap],
  );

  const activeFixedEmployees = useMemo(() =>
    fixedWithCost.filter(r => !r.excluded),
    [fixedWithCost],
  );

  const byDept = useMemo(() => {
    const map: Record<string, typeof fixedWithCost> = {};
    for (const r of activeFixedEmployees) {
      const d = r.emp.department;
      if (!map[d]) map[d] = [];
      map[d].push(r);
    }
    return map;
  }, [activeFixedEmployees]);

  const varByDept = useMemo(() => {
    const map: Record<string, Employee[]> = {};
    for (const e of variableEmployees) {
      const d = e.department;
      if (!map[d]) map[d] = [];
      map[d].push(e);
    }
    return map;
  }, [variableEmployees]);

  // ── Gesamtberechnungen ─────────────────────────────────────────────────────

  const totalFixCost = useMemo(() => activeFixedEmployees.reduce((s, r) => s + r.cost, 0), [activeFixedEmployees]);
  const totalFixBase = useMemo(() => activeFixedEmployees.reduce((s, r) => s + (r.emp.monthlySalary ?? 0), 0), [activeFixedEmployees]);
  const totalFixAnnual = useMemo(() =>
    activeFixedEmployees.reduce((s, r) => s + r.yearlyCost, 0),
    [activeFixedEmployees],
  );

  const totalVarCost = useMemo(() =>
    variableEmployees.reduce((s, e) => s + getVarMonthlyCostFor(e.id, e), 0),
    [variableEmployees, getVarMonthlyCostFor],
  );
  // totalVarHours counts only hourly-mode employees (Tagessatz has no hours)
  const totalVarHours = useMemo(() =>
    variableEmployees.reduce((s, e) => {
      if (varView === 'manual' && (varPricingMode[e.id] ?? 'hourly') === 'daily') return s;
      return s + getVarHoursFor(e.id);
    }, 0),
    [variableEmployees, varView, varPricingMode, getVarHoursFor],
  );
  const totalCombined = totalFixCost + totalVarCost;

  // ── Stichtag-Controlling: Plan + Ist getrennt (varView-unabhängig) ─────────
  // Variable Kosten immer aus Plan-Stunden (Dienstplan) bzw. Ist-Stunden (Mirus)
  const varPlanTotalCHF = useMemo(() =>
    variableEmployees.reduce((s, e) => s + (planHours[e.id] ?? 0) * (e.hourlyWage ?? 0), 0),
    [variableEmployees, planHours],
  );
  const varIstTotalCHF = useMemo(() =>
    variableEmployees.reduce((s, e) => s + (istHours[e.id] ?? 0) * (e.hourlyWage ?? 0), 0),
    [variableEmployees, istHours],
  );

  // Zusatzkosten-IST: Fixlohn-MA Tage mit isAdditionalCost=true → fliessen als variable Flex-Kosten ein
  // Liest direkt aus supabaseActualHours (persistent nach Reload, keine localStorage-Abhängigkeit)
  const zusatzIstCHF = useMemo(() => {
    const yearMonthPrefix = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    let total = 0;
    for (const emp of fixedEmployees) {
      const wage = getEffectiveHourlyRate(emp);
      if (!wage) continue;
      let cost = 0;
      let dayCount = 0;
      for (const [cellKey, entry] of Object.entries(supabaseActualHours)) {
        const empIdFromKey = cellKey.slice(0, cellKey.length - 11);
        const date = cellKey.slice(-10);
        if (empIdFromKey !== emp.id) continue;
        if (!date.startsWith(yearMonthPrefix)) continue;
        if (!entry.isAdditionalCost) continue;
        const h = entry.hours ?? 0;
        if (h <= 0) continue;
        cost += Math.round(h * wage * 100) / 100;
        dayCount++;
      }
      if (cost > 0) console.log(`[ZUSATZ-IST] ${emp.name}: ${dayCount} Tage / ${cost.toFixed(2)} CHF`);
      total += cost;
    }
    return total;
  }, [fixedEmployees, selectedYear, selectedMonth, supabaseActualHours]);

  // ── Ferienabbau-Berechnungen ───────────────────────────────────────────────
  // FE-Tage × (weeklyHours/5 oder 8.4h) × Stundenlohn
  // IST: aus actual-hours-* (localStorage), PLAN: aus schedule-v2-* (localStorage)
  // Supabase hat kein absenceType-Feld → Ferien immer aus localStorage
  // IST-Ferienabbau pro Mitarbeiter
  const getEmpFerienCHF = useCallback((emp: Employee): number => {
    const days = ferienIstDays[emp.id] ?? 0;
    if (!days) return 0;
    const dailyH = emp.weeklyHours ? emp.weeklyHours / 5 : 8.4;
    return days * dailyH * (emp.hourlyWage ?? 0);
  }, [ferienIstDays]);

  // PLAN-Ferienabbau pro Mitarbeiter
  const getEmpFerienPlanCHF = useCallback((emp: Employee): number => {
    const days = ferienPlanDays[emp.id] ?? 0;
    if (!days) return 0;
    const dailyH = emp.weeklyHours ? emp.weeklyHours / 5 : 8.4;
    return days * dailyH * (emp.hourlyWage ?? 0);
  }, [ferienPlanDays]);

  // Ferienabbau Plan + Ist gesamt (für Stichtag-Controlling)
  const ferienIstTotalCHF = useMemo(() =>
    variableEmployees.reduce((s, e) => s + getEmpFerienCHF(e), 0),
    [variableEmployees, getEmpFerienCHF],
  );
  const ferienPlanTotalCHF = useMemo(() =>
    variableEmployees.reduce((s, e) => s + getEmpFerienPlanCHF(e), 0),
    [variableEmployees, getEmpFerienPlanCHF],
  );

  // Ferienabbau nach Abteilung: IST-Basis
  const ferienabbauByDept = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const [dept, emps] of Object.entries(varByDept)) {
      const chf = emps.reduce((s, e) => s + getEmpFerienCHF(e), 0);
      map[dept] = chf;
      if (chf > 0) console.log(`[FERIEN] ferienabbau IST ${dept} chf: ${chf.toFixed(2)}`);
    }
    return map;
  }, [varByDept, getEmpFerienCHF]);

  // Ferienabbau nach Abteilung: PLAN-Basis
  const ferienabbauPlanByDept = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const [dept, emps] of Object.entries(varByDept)) {
      const chf = emps.reduce((s, e) => s + getEmpFerienPlanCHF(e), 0);
      map[dept] = chf;
      if (chf > 0) console.log(`[FERIEN] ferienabbau PLAN ${dept} chf: ${chf.toFixed(2)}`);
    }
    return map;
  }, [varByDept, getEmpFerienPlanCHF]);

  // Ferienabbau gesamt: IST im Ist-Modus, PLAN im Plan/Manuell-Modus
  const totalFerienabbauCHF = useMemo(() => {
    const total = varView === 'ist'
      ? variableEmployees.reduce((s, e) => s + getEmpFerienCHF(e), 0)
      : variableEmployees.reduce((s, e) => s + getEmpFerienPlanCHF(e), 0);
    if (total > 0) {
      console.log(`[FERIEN] ferienabbau (${varView}): ${total.toFixed(2)} CHF`);
      console.log(`[FERIEN] variable arbeit chf: ${totalVarCost.toFixed(2)}`);
      console.log(`[FERIEN] total variabel chf: ${(totalVarCost + total).toFixed(2)}`);
    }
    return total;
  }, [variableEmployees, getEmpFerienCHF, getEmpFerienPlanCHF, varView, totalVarCost]);

  // ── Kanonische 3-Ebenen-Definitionen (view-mode-unabhängig) ──────────────
  // Ebene 1: Variable Arbeit  = echte Arbeitsstunden × Stundenlohn (FE = 0 h)
  // Ebene 2: Ferienabbau       = FE-Tage × Tagessatz (separat)
  // Ebene 3: Total Variabel    = Variable Arbeit + Ferienabbau  (Addition!)
  //
  // «View-mode»-abhängige Aggregate (Plan / Ist / Manuell Schalter oben):
  const totalVarArbeitCHF = totalVarCost;                           // Ebene 1
  // Ebene 3 (view-mode): Variable Arbeit + Ferienabbau
  const totalVariabelCHF  = totalVarCost + totalFerienabbauCHF;

  // Stichtag-unabhängige Plan- und Ist-Totale (für Stichtag-Controlling):
  // Variable Arbeit Plan (immer Dienstplan-Plan-Stunden)
  const varArbeitPlanMonat  = varPlanTotalCHF;
  // Variable Arbeit Ist = variable MA-Stunden + Zusatzkosten von Fixlohn-MA (isAdditionalCost-Tage)
  const varArbeitIstMonat   = varIstTotalCHF + zusatzIstCHF;
  // Total Variabel Plan = Variable Arbeit Plan + Ferienabbau Plan
  const totalVarPlanMonat   = varArbeitPlanMonat + ferienPlanTotalCHF;
  // Total Variabel Ist  = Variable Arbeit Ist  + Ferienabbau Ist
  const totalVarIstMonat    = varArbeitIstMonat  + ferienIstTotalCHF;



  // ── Pro-Rata-Berechnungen ──────────────────────────────────────────────────
  const daysInSelectedMonth = new Date(selectedYear, selectedMonth, 0).getDate();
  const proRataFactor = proRataDay !== null
    ? Math.min(proRataDay, daysInSelectedMonth) / daysInSelectedMonth
    : 1;
  // Wochentagsgewichte aus Einstellungen (einmalig geladen, überall verwendet)
  const weekdayWeights = loadWeekdayWeights();
  const proRataFixCost      = totalFixCost          * proRataFactor;
  const proRataVarCost      = totalVariabelCHF      * proRataFactor;
  const proRataTotal        = (totalFixCost + totalVariabelCHF) * proRataFactor;
  // Weekday-gewichtetes Pro-Rata-Budget (ersetzt lineare Verteilung)
  const proRataBudget       = personnelBudget > 0
    ? computeProRataBudget(personnelBudget, selectedYear, selectedMonth, proRataDay, weekdayWeights)
    : 0;
  const proRataAvailableVar = personnelBudget > 0
    ? Math.max(0, proRataBudget - proRataFixCost) : 0;
  const proRataVarArbeit    = totalVarArbeitCHF     * proRataFactor;
  const proRataFerienabbau  = totalFerienabbauCHF   * proRataFactor;
  const proRataVarDelta     = personnelBudget > 0
    ? proRataAvailableVar - proRataVarArbeit : 0;
  const proRataVarOverrun   = proRataVarDelta < 0;

  // ── PFIX Master Compute Object ─────────────────────────────────────────────
  // Single source of truth for all KPIs, tables, budget block, and export.
  // .month  = full-month values (always proportional, no cutoff)
  // .cutoff = cutoff values using ACTUAL day filtering for work (same method as
  //           FlexPeriodPopup + pfixAbw), proportional scaling for FIX + holiday
  // .active = cutoff ?? month  (always use .active in the UI)
  //
  // KEY: In cutoff mode, work costs are computed by filtering actual calendar
  // days ≤ proRataDay, NOT by multiplying the full-month total by proRataFactor.
  // This is the only method that produces consistent values across table, popup
  // and pfixAbw (because employee hours are NOT uniformly distributed).
  const pfix = useMemo(() => {
    // Helper: build a cost slice from components
    const buildSlice = (
      fix: number, planWork: number, istWork: number,
      planHol: number, istHol: number,
    ) => {
      const planTotalVar = planWork + planHol;
      const istTotalVar  = istWork  + istHol;
      return {
        fix,
        planWork,     istWork,
        planHoliday:  planHol,   istHoliday: istHol,
        planTotalVar, istTotalVar,
        planTotal:    fix + planTotalVar,
        istTotal:     fix + istTotalVar,
        diffWork:     istWork     - planWork,
        diffHoliday:  istHol      - planHol,
        diffTotalVar: istTotalVar  - planTotalVar,
        diffTotal:    (fix + istTotalVar) - (fix + planTotalVar),
      };
    };

    // Month slice — always full-month, no cutoff
    const month = buildSlice(
      totalFixCost, varArbeitPlanMonat, varArbeitIstMonat,
      ferienPlanTotalCHF, ferienIstTotalCHF,
    );

    // Cutoff slice — actual day filtering for work, proportional for rest
    let active = month;
    let cutoff: typeof month | null = null;
    if (proRataDay !== null) {
      // Work costs: sum actual hours up to proRataDay for each employee
      // (identical method to FlexPeriodPopup rows + pfixAbw dayMap)
      let cutoffPlanWork = 0;
      let cutoffIstWork  = 0;
      for (const emp of variableEmployees) {
        const wage = emp.hourlyWage ?? 0;
        if (!wage) continue;
        const planW = loadDailyPlanDetails(emp.id, selectedYear, selectedMonth, proRataDay, wage, tenantKey);
        const istW  = loadDailyIstDetails(emp.id, selectedYear, selectedMonth, proRataDay, wage, tenantKey);
        cutoffPlanWork += planW.reduce((s, r) => s + r.cost, 0);
        cutoffIstWork  += istW.reduce((s, r)  => s + r.cost, 0);
      }
      // Zusatzkosten von Fixlohn-MA bis Stichtag ebenfalls einrechnen (direkt aus Supabase-Daten)
      const yearMonthPrefix = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
      for (const emp of fixedEmployees) {
        const wage = getEffectiveHourlyRate(emp);
        if (!wage) continue;
        for (const [cellKey, entry] of Object.entries(supabaseActualHours)) {
          const empIdFromKey = cellKey.slice(0, cellKey.length - 11);
          const date = cellKey.slice(-10);
          if (empIdFromKey !== emp.id) continue;
          if (!date.startsWith(yearMonthPrefix)) continue;
          if (!entry.isAdditionalCost) continue;
          const day = parseInt(date.slice(-2), 10);
          if (proRataDay !== null && day > proRataDay) continue;
          const h = entry.hours ?? 0;
          if (h > 0) cutoffIstWork += Math.round(h * wage * 100) / 100;
        }
      }
      // Holiday + FIX: proportional (calendar-uniform costs)
      const f = proRataFactor;
      cutoff = buildSlice(
        totalFixCost       * f,
        cutoffPlanWork,
        cutoffIstWork,
        ferienPlanTotalCHF * f,
        ferienIstTotalCHF  * f,
      );
      active = cutoff;
    }

    const modeStr = proRataDay !== null
      ? `cutoff day=${proRataDay} factor=${proRataFactor.toFixed(4)}`
      : 'month';
    console.log(`[PFIX] mode: ${modeStr}`);
    console.log(`[PFIX] fix:           ${active.fix.toFixed(2)}`);
    console.log(`[PFIX] plan work:     ${active.planWork.toFixed(2)}`);
    console.log(`[PFIX] ist work:      ${active.istWork.toFixed(2)}`);
    console.log(`[PFIX] plan holiday:  ${active.planHoliday.toFixed(2)}`);
    console.log(`[PFIX] ist holiday:   ${active.istHoliday.toFixed(2)}`);
    console.log(`[PFIX] plan totalVar: ${active.planTotalVar.toFixed(2)}`);
    console.log(`[PFIX] ist totalVar:  ${active.istTotalVar.toFixed(2)}`);
    console.log(`[PFIX] plan total:    ${active.planTotal.toFixed(2)}`);
    console.log(`[PFIX] ist total:     ${active.istTotal.toFixed(2)}`);
    console.log(`[PFIX] diff total:    ${active.diffTotal.toFixed(2)}`);

    return { month, cutoff, active };
  }, [variableEmployees, fixedEmployees, selectedYear, selectedMonth,
      varArbeitPlanMonat, varArbeitIstMonat, ferienPlanTotalCHF, ferienIstTotalCHF,
      totalFixCost, proRataDay, proRataFactor, tenantKey, scheduleRefreshTick,
      supabaseActualHours]);

  // ── Monatsumsatz für PKQ-Berechnung ──────────────────────────────────────
  // Summiert Netto-Umsatz (actualRevenue – MWST 8.1%) für PKQ-Berechnung.
  // Takeaway-Anteil (val.takeawayRevenue) wird mit 2.6% MWST konvertiert.
  // Marketing (maisonExclude) wird berücksichtigt.
  // Bei Stichtag nur bis proRataDay.
  const monthRevenue = useMemo(() => {
    let total = 0;
    const prefix = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-`;
    for (const [date, val] of Object.entries(monthlyRevenues)) {
      if (!date.startsWith(prefix)) continue;
      if (proRataDay !== null) {
        const day = parseInt(date.slice(-2), 10);
        if (day > proRataDay) continue;
      }
      const gross    = val.actualRevenue   ?? 0;
      const takeaway = maisonExclude ? 0 : (val.takeawayRevenue ?? 0);
      // Nettoumsatz: takeaway@2.6%, Rest@8.1%
      total += grossToNet(gross, takeaway);
    }
    return total;
  }, [monthlyRevenues, proRataDay, maisonExclude, selectedYear, selectedMonth]);

  // Effektiver Umsatz für PKQ: manuelle Annahme überschreibt Ist-Wert wenn kein Ist vorhanden,
  // oder wird als Override genutzt wenn explizit gesetzt
  const effectiveRevenue = (revenueAssumption !== null && revenueAssumption > 0)
    ? revenueAssumption
    : monthRevenue;
  const revenueIsAssumed = revenueAssumption !== null && revenueAssumption > 0;

  // PKQ = Personalkosten / Umsatz × 100
  const pkqPlan = effectiveRevenue > 0 ? (pfix.active.planTotal / effectiveRevenue) * 100 : null;
  const pkqIst  = effectiveRevenue > 0 ? (pfix.active.istTotal  / effectiveRevenue) * 100 : null;
  const pkqFlexPlan = effectiveRevenue > 0 ? (pfix.active.planWork / effectiveRevenue) * 100 : null;
  const pkqFlexIst  = effectiveRevenue > 0 ? (pfix.active.istWork  / effectiveRevenue) * 100 : null;
  const pkqFix      = effectiveRevenue > 0 ? (pfix.active.fix      / effectiveRevenue) * 100 : null;
  const revenueLabel = revenueIsAssumed
    ? 'Annahme'
    : maisonOn
      ? (maisonExclude ? 'exkl. Marketing' : 'inkl. Marketing')
      : 'Ist-Umsatz';

  // ── pfix-derived budget comparison (always uses Ist actuals as "spend") ────
  // When a cutoff (Stichtag) is active, scale the budget pro rata to that day
  // so that "Ist bis Stichtag" is compared against "Budget bis Stichtag".
  // ── Helper: format cutoff date label ──────────────────────────────────────
  const cutoffLabel = proRataDay !== null
    ? `${String(proRataDay).padStart(2, '0')}.${String(selectedMonth).padStart(2, '0')}.${selectedYear}`
    : null;
  const budgetLabel = cutoffLabel ? `bis ${cutoffLabel}` : 'gesamt';

  // pfixBudget = proRataBudget (weekday-gewichtet, Stichtag = proRataDay)
  const pfixBudget = proRataBudget;

  const pfixAvailableVar  = pfixBudget > 0 ? Math.max(0, pfixBudget - pfix.active.fix) : 0;
  // Budget comparison uses only Flex Arbeit Ist — Ferienabbau is NOT budget-relevant
  const pfixIstVarDelta   = pfixBudget > 0 ? pfixAvailableVar - pfix.active.istWork : 0;
  const pfixIstVarOverrun = pfixIstVarDelta < 0;

  // ── ISO-Wochennummer ──────────────────────────────────────────────────────
  function getISOWeek(d: Date): number {
    const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    return Math.ceil((((dt.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }

  // ── Flex-Aufstellung pro Woche (für Budget-Auswertung) ───────────────────
  const flexByWeek = useMemo((): Array<{ weekKey: string; label: string; planFlex: number; istFlex: number; dateRange: string; dates: string[]; daysInWeek: number }> => {
    const weekMap = new Map<string, { planFlex: number; istFlex: number; minDay: number; maxDay: number; days: number }>();
    const weekOrder: string[] = [];
    const mm = String(selectedMonth).padStart(2, '0');
    for (let day = 1; day <= daysInSelectedMonth; day++) {
      const wk = `KW${getISOWeek(new Date(selectedYear, selectedMonth - 1, day))}`;
      if (!weekMap.has(wk)) { weekMap.set(wk, { planFlex: 0, istFlex: 0, minDay: day, maxDay: day, days: 1 }); weekOrder.push(wk); }
      else { const e = weekMap.get(wk)!; e.maxDay = day; e.days++; }
    }
    for (const emp of variableEmployees) {
      const wage = emp.hourlyWage ?? 0;
      if (!wage) continue;
      const planDays = loadDailyPlanDetails(emp.id, selectedYear, selectedMonth, null, wage, tenantKey);
      const istDays  = loadDailyIstDetails(emp.id, selectedYear, selectedMonth, null, wage, tenantKey);
      for (const d of planDays) {
        const wk = `KW${getISOWeek(new Date(selectedYear, selectedMonth - 1, parseInt(d.date.slice(-2), 10)))}`;
        const e = weekMap.get(wk); if (e) e.planFlex += d.cost;
      }
      for (const d of istDays) {
        const wk = `KW${getISOWeek(new Date(selectedYear, selectedMonth - 1, parseInt(d.date.slice(-2), 10)))}`;
        const e = weekMap.get(wk); if (e) e.istFlex += d.cost;
      }
    }
    return weekOrder.map(wk => {
      const e = weekMap.get(wk)!;
      const dateRange = `${String(e.minDay).padStart(2,'0')}.${mm}–${String(e.maxDay).padStart(2,'0')}.${mm}`;
      const dates: string[] = [];
      for (let d = e.minDay; d <= e.maxDay; d++) dates.push(`${selectedYear}-${mm}-${String(d).padStart(2,'0')}`);
      return { weekKey: wk, label: `KW ${wk.slice(2)}`, planFlex: e.planFlex, istFlex: e.istFlex, dateRange, dates, daysInWeek: e.days };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variableEmployees, selectedYear, selectedMonth, daysInSelectedMonth, tenantKey]);

  // ── Fix-Kosten pro Woche (pro-rata nach Tagen) ────────────────────────────
  const fixByWeek = useMemo(() =>
    flexByWeek.map(w => ({
      weekKey: w.weekKey,
      fixCost: daysInSelectedMonth > 0 ? totalFixCost * (w.daysInWeek / daysInSelectedMonth) : 0,
      empCosts: activeFixedEmployees.map(r => ({
        name: r.emp.name,
        dept: r.emp.department,
        monthlyCost: r.cost,
        weeklyCost: daysInSelectedMonth > 0 ? r.cost * (w.daysInWeek / daysInSelectedMonth) : 0,
      })),
    })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [flexByWeek, totalFixCost, daysInSelectedMonth, activeFixedEmployees]);

  // ── Wochenweise Ist-Umsatz netto aus dailyBudgets (Brutto ÷ 1.081) ────────
  // Fallback: Wenn keine Ist-Daten vorhanden, Budget-Umsatz pro rata verwenden.
  const weekActualNetRevenue = useMemo((): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const w of flexByWeek) {
      const gross = w.dates.reduce(
        (sum, d) => sum + (monthlyRevenues[d]?.actualRevenue ?? 0), 0,
      );
      if (gross > 0) {
        result[w.weekKey] = gross / 1.081;
      } else if (weekRevOverrides[w.weekKey] != null) {
        result[w.weekKey] = weekRevOverrides[w.weekKey];
      } else {
        const budgetRev = budgetRevenue ?? budgetData.revenueBudget;
        if (budgetRev > 0 && daysInSelectedMonth > 0) {
          result[w.weekKey] = budgetRev * (w.daysInWeek / daysInSelectedMonth);
        }
      }
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flexByWeek, monthlyRevenues, weekRevOverrides, budgetRevenue, budgetData.revenueBudget, daysInSelectedMonth]);

  // Welche Wochen haben keinen Ist-Umsatz (Fallback oder manuell)?
  const weekRevenueIsEstimate = useMemo((): Record<string, boolean> => {
    const result: Record<string, boolean> = {};
    for (const w of flexByWeek) {
      const gross = w.dates.reduce(
        (sum, d) => sum + (monthlyRevenues[d]?.actualRevenue ?? 0), 0,
      );
      result[w.weekKey] = gross <= 0;
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flexByWeek, monthlyRevenues]);

  // Welche Wochen haben einen manuellen Umsatz-Override?
  const weekRevenueIsManual = useMemo((): Record<string, boolean> => {
    const result: Record<string, boolean> = {};
    for (const w of flexByWeek) {
      result[w.weekKey] = weekRevOverrides[w.weekKey] != null;
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flexByWeek, weekRevOverrides]);

  const hasAnyWeekRevenue = Object.keys(weekActualNetRevenue).length > 0;

  // Manuellen Umsatz-Override speichern / löschen
  const commitWeekRevEdit = (weekKey: string, rawVal: string) => {
    const num = parseFloat(rawVal.replace(/[^0-9.,]/g, '').replace(',', '.'));
    setWeekRevOverrides(prev => {
      const next = { ...prev };
      if (!isNaN(num) && num > 0) { next[weekKey] = num; }
      else { delete next[weekKey]; }
      saveWeekRevOverrides(selectedYear, selectedMonth, next, tenantKey);
      return next;
    });
    setWeekRevEditKey(null);
    setWeekRevEditVal('');
  };

  // ── Budget-Umsatz abgeleitete Werte ───────────────────────────────────────
  // basePkqPct: PKQ% aus der Budget-Planung (Basis für Szenario-Berechnungen)
  const basePkqPct = personnelBudget > 0 && budgetData.revenueBudget > 0
    ? (personnelBudget / budgetData.revenueBudget) * 100 : null;
  // effectiveBudgetRevenue: Szenario-Umsatz überschreibt Budget-Planung
  const effectiveBudgetRevenue = budgetRevenue ?? budgetData.revenueBudget;
  // adjustedPersonnelBudget (= Szenario-PK):
  //   1. Manuell gesetzter PK-Betrag (scenarioPkCost)
  //   2. Umsatz-Szenario × Basis-PKQ% (wenn nur Umsatz angepasst)
  //   3. Budget-Plan PK (kein Szenario)
  const adjustedPersonnelBudget =
    scenarioPkCost != null && scenarioPkCost > 0 ? scenarioPkCost
    : budgetRevenue != null && budgetRevenue > 0 && basePkqPct != null ? budgetRevenue * (basePkqPct / 100)
    : personnelBudget;
  // effectiveScenarioPkqPct: PKQ% des Szenarios (für Anzeige)
  const effectiveScenarioPkqPct = effectiveBudgetRevenue > 0 && adjustedPersonnelBudget > 0
    ? (adjustedPersonnelBudget / effectiveBudgetRevenue) * 100 : basePkqPct;
  const totalFlexForBudget = flexByWeek.reduce(
    (sum, w) => sum + (weekIstSet.has(w.weekKey) ? w.istFlex : w.planFlex), 0,
  );
  const verfügbarFlexBudget = adjustedPersonnelBudget > 0 ? adjustedPersonnelBudget - pfix.active.fix : 0;
  const budgetResultat       = verfügbarFlexBudget - totalFlexForBudget;
  // Szenario aktiv wenn Umsatz oder PK überschrieben
  const scenarioActive = budgetRevenue != null || scenarioPkCost != null;

  // Operative Status-Logik:
  //   on_track  → Flex Arbeit Ist ≤ verfügbares Flex-Budget (delta ≥ 0)
  //   warning   → leicht darüber: 0 – 5 % von pfixAvailableVar
  //   off_track → deutlich darüber: > 5 % von pfixAvailableVar
  const flexBudgetStatus: 'on_track' | 'warning' | 'off_track' =
    pfixIstVarDelta >= 0
      ? 'on_track'
      : Math.abs(pfixIstVarDelta) <= pfixAvailableVar * 0.05
        ? 'warning'
        : 'off_track';

  // ── Effective cutoff for forecast ────────────────────────────────────────────
  // Priority: Stichtag > forecastIstDay (manual) > today (current month) > last day (past) > 0 (future)
  const isCurrentMonthForForecast = selectedYear === today.getFullYear() && selectedMonth === today.getMonth() + 1;
  const isPastMonth = selectedYear < today.getFullYear()
    || (selectedYear === today.getFullYear() && selectedMonth < today.getMonth() + 1);
  const effectiveForecastCutoff: number = proRataDay !== null
    ? proRataDay
    : isCurrentMonthForForecast
      ? (forecastIstDay !== null ? forecastIstDay : today.getDate())
      : isPastMonth
        ? daysInSelectedMonth  // past month: all days elapsed, no remaining plan
        : 0;                   // future month: no days elapsed, full plan is remaining

  const forecastIstLabel = proRataDay !== null
    ? `bis ${cutoffLabel}`
    : forecastIstDay !== null && isCurrentMonthForForecast
      ? `bis ${forecastIstDay}.`
      : `bis ${effectiveForecastCutoff}.`;

  // ── Forecast Monatsende: geplante Restkosten ab Tag nach Stichtag/heute ─────
  const forecastRemainingPlanFlex = useMemo(() => {
    const cutoffStr = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(effectiveForecastCutoff).padStart(2, '0')}`;
    let remaining = 0;
    for (const emp of variableEmployees) {
      const wage = emp.hourlyWage ?? 0;
      if (!wage) continue;
      // Full month plan (no cutoff), dann filtern auf Tage NACH dem Stichtag/heute
      const planW = loadDailyPlanDetails(emp.id, selectedYear, selectedMonth, null, wage, tenantKey);
      remaining += planW.filter(r => r.date > cutoffStr).reduce((s, r) => s + r.cost, 0);
    }
    console.log(`[FLEX-FORECAST] mode: ${proRataDay !== null ? 'stichtag' : forecastIstDay !== null ? 'manual-ist-day' : 'today-as-cutoff'}`);
    console.log(`[FLEX-FORECAST] cutoff date: ${cutoffStr}`);
    console.log(`[FLEX-FORECAST] ist until cutoff: ${pfix.active.istWork.toFixed(2)}`);
    console.log(`[FLEX-FORECAST] remaining planned flex: ${remaining.toFixed(2)}`);
    return remaining;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variableEmployees, selectedYear, selectedMonth, effectiveForecastCutoff, forecastIstDay, pfix.active.istWork]);

  // Forecast Monatsende derived values
  // Gesamter Monat: Budget gesamt minus FIX gesamt (= pfix.month.fix)
  const forecastAvailableVar  = personnelBudget > 0 ? Math.max(0, personnelBudget - pfix.month.fix) : 0;
  const forecastFlexTotal     = pfix.active.istWork + forecastRemainingPlanFlex;
  const forecastDelta         = forecastAvailableVar > 0 ? forecastAvailableVar - forecastFlexTotal : 0;
  const forecastStatus: 'on_track' | 'warning' | 'off_track' =
    forecastDelta >= 0
      ? 'on_track'
      : Math.abs(forecastDelta) <= forecastAvailableVar * 0.05
        ? 'warning'
        : 'off_track';

  if (personnelBudget > 0 && proRataDay !== null) {
    console.log(`[FLEX-FORECAST] forecast month total: ${forecastFlexTotal.toFixed(2)}`);
    console.log(`[FLEX-FORECAST] budget remaining / status: ${forecastDelta.toFixed(2)} / ${forecastStatus}`);
  }

  // [FLEX-BUDGET] + [BUDGET-DAY] debug logs
  if (personnelBudget > 0) {
    const cd = cutoffLabel ?? 'full month';
    logBudgetDayDebug(personnelBudget, selectedYear, selectedMonth, weekdayWeights, proRataDay);
    console.log(`[FLEX-BUDGET] cutoff date: ${cd}`);
    console.log(`[FLEX-BUDGET] budget until cutoff (weekday-weighted): ${pfixBudget.toFixed(2)}`);
    console.log(`[FLEX-BUDGET] fix ist until cutoff: ${pfix.active.fix.toFixed(2)}`);
    console.log(`[FLEX-BUDGET] flex work ist until cutoff: ${pfix.active.istWork.toFixed(2)}`);
    console.log(`[FLEX-BUDGET] remaining flex budget: ${pfixIstVarDelta >= 0 ? '+' : ''}${pfixIstVarDelta.toFixed(2)}`);
    console.log(`[FLEX-BUDGET] status: ${flexBudgetStatus}`);
  }

  // Per-employee Plan vs Ist table — synchronized to pfix and FlexPeriodPopup
  // KEY FIX: In cutoff mode, hours are computed with ACTUAL day filtering
  // (same loadDailyPlanDetails/loadDailyIstDetails as the popup), NOT by scaling
  // full-month hours by proRataFactor. This eliminates the table ≠ popup discrepancy.
  const pfixPerEmp = useMemo(() => {
    const modeStr  = proRataDay !== null ? 'cutoff' : 'month';
    const factor   = proRataDay !== null ? proRataFactor : 1;

    const rows = variableEmployees.map(emp => {
      const wage = emp.hourlyWage ?? 0;
      let planH: number, istH: number, planWork: number, istWork: number;

      if (proRataDay !== null) {
        // ── Cutoff mode: actual day filtering (identical to FlexPeriodPopup) ──
        const planW = loadDailyPlanDetails(emp.id, selectedYear, selectedMonth, proRataDay, wage, tenantKey);
        const istW  = loadDailyIstDetails(emp.id, selectedYear, selectedMonth, proRataDay, wage, tenantKey);
        planH    = planW.reduce((s, r) => s + r.hours, 0);
        istH     = istW.reduce((s, r) => s + r.hours, 0);
        planWork = planW.reduce((s, r) => s + r.cost,  0);
        istWork  = istW.reduce((s, r) => s + r.cost,   0);
      } else {
        // ── Full-month mode: pre-aggregated totals ─────────────────────────
        planH    = planHours[emp.id] ?? 0;
        istH     = istHours[emp.id]  ?? 0;
        planWork = planH * wage;
        istWork  = istH  * wage;
      }

      // Holiday: proportional scaling in both modes (calendar-uniform)
      const planHoliday  = getEmpFerienPlanCHF(emp) * factor;
      const istHoliday   = getEmpFerienCHF(emp)     * factor;
      const planTotalVar = planWork + planHoliday;
      const istTotalVar  = istWork  + istHoliday;

      // FLEX-SYNC log (matches what FlexPeriodPopup shows per employee)
      console.log(`[FLEX-SYNC] employee: ${emp.name}`);
      console.log(`[FLEX-SYNC] mode: ${modeStr}`);
      if (proRataDay !== null) {
        console.log(`[FLEX-SYNC] cutoff date: ${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${proRataDay}`);
      }
      console.log(`[FLEX-SYNC] row plan hours: ${planH.toFixed(2)}`);
      console.log(`[FLEX-SYNC] row ist hours: ${istH.toFixed(2)}`);
      console.log(`[FLEX-SYNC] row plan chf: ${planWork.toFixed(2)}`);
      console.log(`[FLEX-SYNC] row ist chf: ${istWork.toFixed(2)}`);

      return {
        id:           emp.id,
        name:         emp.name,
        dept:         emp.department ?? '–',
        hourlyWage:   wage,
        weeklyHours:  emp.weeklyHours ?? 42,
        planH, istH,
        planWork, istWork,
        planHoliday, istHoliday,
        planTotalVar, istTotalVar,
        diffWork:     istWork     - planWork,
        diffHoliday:  istHoliday  - planHoliday,
        diffTotalVar: istTotalVar - planTotalVar,
      };
    });

    // ── Zusatzkosten-Zeilen für Fixlohn-MA ─────────────────────────────────
    // Fixlohn-MA mit isAdditionalCost=true Einträgen erscheinen als eigene Zeile
    // im Flex-Kosten-Block (Plan = 0, Ist = berechnete Zusatzkosten)
    for (const emp of fixedEmployees) {
      const wage = getEffectiveHourlyRate(emp);
      if (!wage) continue;
      const cutoff = proRataDay;
      // Zusatzkosten IST: direkt aus Supabase-Daten (persistent, nicht localStorage)
      const yearMonthPrefix = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
      const zusatzW: DayEntry[] = Object.entries(supabaseActualHours)
        .flatMap(([cellKey, entry]) => {
          const empIdFromKey = cellKey.slice(0, cellKey.length - 11);
          const date = cellKey.slice(-10);
          if (empIdFromKey !== emp.id) return [];
          if (!date.startsWith(yearMonthPrefix)) return [];
          if (!entry.isAdditionalCost) return [];
          const day = parseInt(date.slice(-2), 10);
          if (cutoff !== null && day > cutoff) return [];
          const h = entry.hours ?? 0;
          if (h <= 0) return [];
          return [{ date, hours: Math.round(h * 100) / 100, cost: Math.round(h * wage * 100) / 100 }];
        })
        .sort((a, b) => a.date.localeCompare(b.date));
      const zusatzPlanW = loadZusatzPlanDetails(emp.id, selectedYear, selectedMonth, cutoff, wage, tenantKey);
      if (zusatzW.length === 0 && zusatzPlanW.length === 0) continue;
      const istH    = zusatzW.reduce((s, r) => s + r.hours, 0);
      const istWork = zusatzW.reduce((s, r) => s + r.cost, 0);
      const planH   = zusatzPlanW.reduce((s, r) => s + r.hours, 0);
      const planWork = zusatzPlanW.reduce((s, r) => s + r.cost, 0);
      console.log(`[ZUSATZ-ROW] ${emp.name}: IST ${zusatzW.length}T/${istH.toFixed(1)}h/${istWork.toFixed(2)} CHF | PLAN ${zusatzPlanW.length}T/${planH.toFixed(1)}h/${planWork.toFixed(2)} CHF`);
      rows.push({
        id:           emp.id,
        name:         emp.name,
        dept:         emp.department ?? '–',
        hourlyWage:   wage,
        weeklyHours:  emp.weeklyHours ?? 42,
        planH,   istH,
        planWork, istWork,
        planHoliday: 0, istHoliday: 0,
        planTotalVar: planWork, istTotalVar: istWork,
        diffWork:     istWork - planWork,
        diffHoliday:  0,
        diffTotalVar: istWork - planWork,
        isFixedAdditional: true,
      });
    }

    // ── [PERSONAL FIX] Debug ────────────────────────────────────────────────
    console.log(`[PERSONAL FIX] employees total: ${rows.length}`);
    console.log(`[PERSONAL FIX] flex employees: ${rows.length}`);
    console.log(`[CHECK] flex employees visible: ${rows.length > 0 ? 'OK' : 'none'}`);

    // ── Cross-check: table sums must match pfix master ──────────────────────
    const ref         = proRataDay !== null ? pfix.cutoff! : pfix.month;
    const sumPlanWork = rows.reduce((s, r) => s + r.planWork,    0);
    const sumIstWork  = rows.reduce((s, r) => s + r.istWork,     0);
    const sumPlanHol  = rows.reduce((s, r) => s + r.planHoliday, 0);
    const sumIstHol   = rows.reduce((s, r) => s + r.istHoliday,  0);
    const sumPlanVar  = rows.reduce((s, r) => s + r.planTotalVar, 0);
    const sumIstVar   = rows.reduce((s, r) => s + r.istTotalVar,  0);

    console.log(`[FLEX-SYNC] === TABLE SUMMARY mode=${modeStr} ===`);
    console.log(`[FLEX-SYNC] table sum planWork: ${sumPlanWork.toFixed(2)} | pfix: ${ref.planWork.toFixed(2)}`);
    console.log(`[FLEX-SYNC] table sum istWork:  ${sumIstWork.toFixed(2)} | pfix: ${ref.istWork.toFixed(2)}`);
    console.log(`[FLEX-SYNC] table sum planHol:  ${sumPlanHol.toFixed(2)} | pfix: ${ref.planHoliday.toFixed(2)}`);
    console.log(`[FLEX-SYNC] table sum istHol:   ${sumIstHol.toFixed(2)} | pfix: ${ref.istHoliday.toFixed(2)}`);
    console.log(`[FLEX-SYNC] table sum planVar:  ${sumPlanVar.toFixed(2)} | pfix: ${ref.planTotalVar.toFixed(2)}`);
    console.log(`[FLEX-SYNC] table sum istVar:   ${sumIstVar.toFixed(2)} | pfix: ${ref.istTotalVar.toFixed(2)}`);

    if (Math.abs(sumPlanWork - ref.planWork) > 0.10)
      console.error(`[FLEX-SYNC] MISMATCH planWork: table=${sumPlanWork.toFixed(2)} vs pfix=${ref.planWork.toFixed(2)} diff=${(sumPlanWork - ref.planWork).toFixed(2)}`);
    if (Math.abs(sumIstWork - ref.istWork) > 0.10)
      console.error(`[FLEX-SYNC] MISMATCH istWork: table=${sumIstWork.toFixed(2)} vs pfix=${ref.istWork.toFixed(2)} diff=${(sumIstWork - ref.istWork).toFixed(2)}`);

    return rows;
  }, [variableEmployees, fixedEmployees, selectedYear, selectedMonth, planHours, istHours,
      getEmpFerienPlanCHF, getEmpFerienCHF, proRataDay, proRataFactor, pfix, tenantKey,
      scheduleRefreshTick, supabaseActualHours]);

  // ── Abweichungsanalyse: tägliche Aggregation aller Flex-Mitarbeiter ──────────
  const pfixAbw = useMemo((): {
    days:      AbwDay[];
    weeks:     AbwRow[];
    monthPlan: number;
    monthIst:  number;
    monthDiff: number;
  } => {
    const cutoff = proRataDay;
    // Only Flex Arbeit (work hours × wage) — no ferien in this view
    const dayMap = new Map<string, { pw: number; iw: number }>();

    for (const emp of variableEmployees) {
      const wage = emp.hourlyWage ?? 0;
      if (!wage) continue;

      const planW = loadDailyPlanDetails(emp.id, selectedYear, selectedMonth, cutoff, wage, tenantKey);
      const istW  = loadDailyIstDetails(emp.id, selectedYear, selectedMonth, cutoff, wage, tenantKey);

      for (const r of planW) {
        const e = dayMap.get(r.date) ?? { pw: 0, iw: 0 };
        e.pw += r.cost; dayMap.set(r.date, e);
      }
      for (const r of istW) {
        const e = dayMap.get(r.date) ?? { pw: 0, iw: 0 };
        e.iw += r.cost; dayMap.set(r.date, e);
      }
    }

    const days: AbwDay[] = Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => {
        const planTotal = v.pw;
        const istTotal  = v.iw;
        const diff      = istTotal - planTotal;
        return {
          date,
          planWork:   v.pw,
          istWork:    v.iw,
          planFerien: 0,
          istFerien:  0,
          planTotal,
          istTotal,
          diff,
          diffPct: planTotal > 0 ? (diff / planTotal) * 100 : null,
        };
      });

    const weekMap = new Map<string, { p: number; i: number; dates: string[] }>();
    for (const d of days) {
      const wk = isoWeekLabel(d.date);
      const e  = weekMap.get(wk) ?? { p: 0, i: 0, dates: [] };
      e.p += d.planTotal; e.i += d.istTotal; e.dates.push(d.date);
      weekMap.set(wk, e);
    }
    const weeks: AbwRow[] = Array.from(weekMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, v]) => ({
        period,
        planTotal: v.p,
        istTotal:  v.i,
        diff:      v.i - v.p,
        diffPct:   v.p > 0 ? ((v.i - v.p) / v.p) * 100 : null,
        dates:     v.dates,
      }));

    const monthPlan = days.reduce((s, d) => s + d.planTotal, 0);
    const monthIst  = days.reduce((s, d) => s + d.istTotal,  0);
    const monthDiff = monthIst - monthPlan;

    const monthStatus = ampelStatus(monthDiff, monthPlan);
    const monthPctVal = monthPlan > 0 ? (monthDiff / monthPlan) * 100 : 0;

    console.log(`[FLEX] mode: ${abwMode}`);
    console.log(`[FLEX] plan total: ${monthPlan.toFixed(2)}`);
    console.log(`[FLEX] ist total: ${monthIst.toFixed(2)}`);
    console.log(`[FLEX] diff: ${monthDiff.toFixed(2)}`);
    console.log(`[FLEX] daily rows: ${days.length}, week rows: ${weeks.length}`);
    console.log(`[AMPEL] status: ${monthStatus} | plan: ${monthPlan.toFixed(2)} | pct: ${monthPctVal.toFixed(2)}`);

    return { days, weeks, monthPlan, monthIst, monthDiff };
  }, [variableEmployees, selectedYear, selectedMonth, proRataDay, planHours, istHours, abwMode]);

  // Pro-Rata pro variablen Mitarbeiter (für UI-Tabelle + Export)
  // ferienCHF: IST-Basis im Ist-Modus, PLAN-Basis im Plan/Manuell-Modus
  const proRataVarByEmp = useMemo(() => {
    return variableEmployees.map(emp => {
      const varArbeit = getVarMonthlyCostFor(emp.id, emp);
      const ferienCHF = varView === 'ist' ? getEmpFerienCHF(emp) : getEmpFerienPlanCHF(emp);
      // Total Variabel = Variable Arbeit + Ferienabbau (Addition!)
      const totalCost = varArbeit + ferienCHF;
      return {
        name:        emp.name,
        dept:        emp.department ?? '–',
        hours:       getVarHoursFor(emp.id),
        varArbeit,
        ferienCHF,
        monthlyCost: totalCost,
        proRataCost: totalCost * proRataFactor,
      };
    }).filter(r => r.monthlyCost > 0 || r.proRataCost > 0);
  }, [variableEmployees, getVarMonthlyCostFor, getEmpFerienCHF, getEmpFerienPlanCHF, getVarHoursFor, proRataFactor, varView]);

  // ── Departement-Zusammenfassung ────────────────────────────────────────────

  const deptSummary = useMemo(() => {
    const depts = Array.from(new Set([...Object.keys(byDept), ...Object.keys(varByDept)]));
    return depts.map(dept => {
      const fix = (byDept[dept] ?? []).reduce((s, r) => s + r.cost, 0);
      const varEmpList = varByDept[dept] ?? [];
      const varArbeit   = varEmpList.reduce((s, e) => s + getVarMonthlyCostFor(e.id, e), 0);
      // Ferienabbau: IST-Basis im Ist-Modus, PLAN-Basis im Plan/Manuell-Modus
      const ferienabbau = varView === 'ist'
        ? (ferienabbauByDept[dept] ?? 0)
        : (ferienabbauPlanByDept[dept] ?? 0);
      // Total Variabel = Variable Arbeit + Ferienabbau (Addition!)
      const variabel    = varArbeit + ferienabbau;
      return { dept, fix, varArbeit, ferienabbau, variabel, total: fix + variabel };
    });
  }, [byDept, varByDept, getVarMonthlyCostFor, ferienabbauByDept, ferienabbauPlanByDept, varView]);

  // ── Budget für variable Mitarbeiter ───────────────────────────────────────

  const availableVarBudget = personnelBudget > 0 ? Math.max(0, personnelBudget - totalFixCost) : 0;
  const varBudgetDelta     = personnelBudget > 0 ? availableVarBudget - totalVarCost : 0;
  const varBudgetOverrun   = varBudgetDelta < 0;

  // Ø Stundenlohn aller variablen Mitarbeiter mit Lohn hinterlegt
  const avgHourlyWage = useMemo(() => {
    const empsWithWage = variableEmployees.filter(e => (e.hourlyWage ?? 0) > 0);
    if (!empsWithWage.length) return 0;
    return empsWithWage.reduce((s, e) => s + e.hourlyWage, 0) / empsWithWage.length;
  }, [variableEmployees]);

  // Maximal mögliche Stunden mit verfügbarem Variabel-Budget
  const maxVarHours = availableVarBudget > 0 && avgHourlyWage > 0
    ? Math.round(availableVarBudget / avgHourlyWage)
    : 0;
  // Pro-rata version for the budget block (uses pfixAvailableVar which is already scaled)
  const pfixMaxVarHours = pfixAvailableVar > 0 && avgHourlyWage > 0
    ? Math.floor(pfixAvailableVar / avgHourlyWage) : 0;

  // ── Stundensaldo aller Mitarbeiter ────────────────────────────────────────

  const allEmployees = useMemo(() => [...fixedEmployees, ...variableEmployees], [fixedEmployees, variableEmployees]);

  const hourBalances = useMemo(() =>
    buildHourBalances(
      allEmployees,
      planHours,
      istHours,
      (empId) => {
        // Für FIX-MA: nutze Plan-Stunden als Effektiv-Wert (oder Ist wenn verfügbar)
        const isFix = fixedEmployees.some(e => e.id === empId);
        if (isFix) {
          if (varView === 'ist' && istHours[empId]) return istHours[empId];
          return planHours[empId] ?? 0;
        }
        return getVarHoursFor(empId);
      },
    ),
    [allEmployees, planHours, istHours, fixedEmployees, varView, getVarHoursFor],
  );

  const planningHints = useMemo(() => {
    const remainingVarHours = maxVarHours > 0
      ? Math.max(0, maxVarHours - Math.round(totalVarHours))
      : 0;
    return generatePlanningHints(hourBalances, availableVarBudget, remainingVarHours);
  }, [hourBalances, availableVarBudget, maxVarHours, totalVarHours]);

  const varModeLabelShort = varView === 'plan' ? 'Plan' : varView === 'ist' ? 'Ist' : 'Manuell';

  // ── Quellen-Labels ────────────────────────────────────────────────────────

  const planHasDaten = Object.keys(planHours).length > 0;
  const istHasDaten  = Object.keys(istHours).length > 0;

  const varViewLabel: Record<VarView, string> = {
    plan:   'Quelle: Dienstplan Plan',
    ist:    'Quelle: Dienstplan Ist (Mirus-Import)',
    manual: 'Quelle: Manuelle Eingabe (lokal gespeichert)',
  };

  // ── PDF-Export ────────────────────────────────────────────────────────────

  const handleExportPDF = () => {
    try {
      const varRowsByDept: Record<string, Array<{ emp: Employee; hours: number; monthlyCost: number; hourlyWage: number }>> = {};
      for (const [dept, emps] of Object.entries(varByDept)) {
        varRowsByDept[dept] = emps.map(emp => ({
          emp,
          hours: getVarHoursFor(emp.id),
          monthlyCost: getVarMonthlyCostFor(emp.id, emp),
          hourlyWage: emp.hourlyWage ?? 0,
        }));
      }

      exportPersonalFixToPDF({
        selectedYear,
        selectedMonth,
        byDept,
        totalFixCost,
        totalFixBase,
        totalFixAnnual,
        varByDept: varRowsByDept,
        totalVarCost,
        totalVarHours,
        totalCombined,
        personnelBudget: personnelBudget ?? 0,
        availableVarBudget,
        varBudgetDelta,
        varBudgetOverrun,
        varView,
        avgHourlyWage,
        maxVarHours,
        // Ferienabbau
        totalVarArbeitCHF,
        totalFerienabbauCHF,
        totalVariabelCHF,
        ferienabbauByDept,
        deptSummary,
        // Pro-Rata
        proRataDay,
        proRataFactor,
        proRataFixCost,
        proRataVarCost,
        proRataTotal,
        proRataVarByEmp,
        daysInSelectedMonth,
        // PKQ
        pkqPlan,
        pkqIst,
        pkqFlexPlan,
        pkqFlexIst,
        pkqFix,
        monthRevenue,
        revenueLabel,
        pfixPlanWork:  pfix.active.planWork,
        pfixIstWork:   pfix.active.istWork,
        pfixPlanTotal: pfix.active.planTotal,
        pfixIstTotal:  pfix.active.istTotal,
      });
      toast.success('PDF erfolgreich exportiert');
    } catch (err) {
      console.error('[PersonalFix] PDF-Export Fehler:', err);
      toast.error('Fehler beim PDF-Export');
    }
  };

  const handleVarExport = (source: 'plan' | 'ist') => {
    try {
      const varRowsByDept: Record<string, Array<{ emp: Employee; hours: number; monthlyCost: number; hourlyWage: number }>> = {};
      for (const [dept, emps] of Object.entries(varByDept)) {
        varRowsByDept[dept] = emps.map(emp => {
          const hrs = source === 'plan' ? (planHours[emp.id] ?? 0) : (istHours[emp.id] ?? 0);
          return {
            emp,
            hours: hrs,
            monthlyCost: hrs * (emp.hourlyWage ?? 0),
            hourlyWage: emp.hourlyWage ?? 0,
          };
        });
      }
      const allRows = Object.values(varRowsByDept).flat();
      exportVarKostenvergleich({
        selectedYear,
        selectedMonth,
        varByDept: varRowsByDept,
        totalVarHours: allRows.reduce((s, r) => s + r.hours, 0),
        totalVarCost:  allRows.reduce((s, r) => s + r.monthlyCost, 0),
        source,
      });
      toast.success(`${source === 'plan' ? 'Plan' : 'Ist'}-Kostenvergleich exportiert`);
    } catch (err) {
      console.error('[PersonalFix] Var-Export Fehler:', err);
      toast.error('Fehler beim Export');
    }
  };

  // ── Flex-Auswertung Export ─────────────────────────────────────────────────

  function buildFlexExportData() {
    const periodRows = abwMode === 'day'
      ? pfixAbw.days.map(d => ({
          period:    d.date,
          planTotal: d.planTotal,
          istTotal:  d.istTotal,
          diff:      d.diff,
          diffPct:   d.diffPct,
        }))
      : abwMode === 'week'
      ? pfixAbw.weeks.map(w => ({
          period:    w.period,
          planTotal: w.planTotal,
          istTotal:  w.istTotal,
          diff:      w.diff,
          diffPct:   w.diffPct,
        }))
      : [{
          period:    `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`,
          planTotal: pfixAbw.monthPlan,
          istTotal:  pfixAbw.monthIst,
          diff:      pfixAbw.monthDiff,
          diffPct:   pfixAbw.monthPlan > 0 ? (pfixAbw.monthDiff / pfixAbw.monthPlan) * 100 : null,
        }];

    const empRows = pfixPerEmp.map(r => ({
      name:        r.name,
      dept:        r.dept,
      planWork:    r.planWork,
      istWork:     r.istWork,
      planHoliday: r.planHoliday,
      istHoliday:  r.istHoliday,
      planTotal:   r.planTotalVar,
      istTotal:    r.istTotalVar,
      diffTotal:   r.diffTotalVar,
    }));

    return {
      selectedYear,
      selectedMonth,
      abwMode,
      periodRows,
      empRows,
      monthPlan:     pfixAbw.monthPlan,
      monthIst:      pfixAbw.monthIst,
      monthDiff:     pfixAbw.monthDiff,
      proRataDay,
      proRataFactor,
      daysInMonth:   daysInSelectedMonth,
    };
  }

  const handleFlexExportPDF = () => {
    try {
      exportFlexAuswertungToPDF(buildFlexExportData());
      toast.success('Flex-Auswertung PDF exportiert');
    } catch (err) {
      console.error('[PersonalFix] Flex-PDF-Export Fehler:', err);
      toast.error('Fehler beim PDF-Export');
    }
  };

  const handleFlexExportExcel = async () => {
    try {
      await exportFlexAuswertungToExcel(buildFlexExportData());
      toast.success('Flex-Auswertung Excel exportiert');
    } catch (err) {
      console.error('[PersonalFix] Flex-Excel-Export Fehler:', err);
      toast.error('Fehler beim Excel-Export');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <DollarSign className="h-5 w-5 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <h1 className="text-base font-bold leading-tight">Personal FIX + VARIABEL</h1>
              <p className="text-xs text-muted-foreground hidden sm:block">Lohnkosten-Übersicht & Hochrechnung</p>
            </div>
          </div>

          {/* Monatsnavigation */}
          <div className="flex items-center gap-1.5 bg-muted/40 rounded-lg px-2 py-1 order-last sm:order-none">
            <Button
              size="icon" variant="ghost"
              className="h-7 w-7"
              onClick={() => { const [y, m] = prevMonth(selectedYear, selectedMonth); setSelectedYear(y); setSelectedMonth(m); }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1.5 min-w-[120px] justify-center">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-semibold tabular-nums">{getMonthLabel(selectedYear, selectedMonth)}</span>
            </div>
            <Button
              size="icon" variant="ghost"
              className="h-7 w-7"
              onClick={() => { const [y, m] = nextMonth(selectedYear, selectedMonth); setSelectedYear(y); setSelectedMonth(m); }}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {/* PDF Export Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportPDF}
            className="h-8 gap-1.5 text-xs border-rose-200 text-rose-700 hover:bg-rose-50 hover:border-rose-300 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950/30"
          >
            <FileText className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">PDF Export</span>
          </Button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">

        {/* ── [BEAULIEU-WAGE] Fehlende-Lohn-Banner ─────────────────────────── */}
        {tenantId === 'beaulieu' && missingWageEmployees.length > 0 && (
          <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 flex items-start gap-3">
            <span className="text-amber-600 dark:text-amber-400 text-lg leading-none mt-0.5">⚠</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                Lohn fehlt bei {missingWageEmployees.length} Mitarbeiter{missingWageEmployees.length !== 1 ? 'n' : ''}
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                {missingWageEmployees.map(e => e.name).join(', ')} — bitte im Personalstamm hinterlegen, damit Personal FIX korrekt rechnet.
              </p>
            </div>
          </div>
        )}

        {/* ── Modus-Steuerung (Pro-Rata Toggle) ────────────────────────────── */}
        <div className="rounded-xl border border-border bg-card shadow-sm p-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">
              {proRataDay !== null
                ? `Stichtag — bis ${proRataDay}. ${getMonthLabel(selectedYear, selectedMonth)}`
                : `Monatsansicht — ${getMonthLabel(selectedYear, selectedMonth)}`}
            </span>
            {proRataDay !== null && (
              <Badge variant="secondary" className="text-xs tabular-nums">
                {proRataDay}/{daysInSelectedMonth} · {Math.round(proRataFactor * 100)} %
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {proRataDay !== null && (
              <>
                <span className="text-xs text-muted-foreground">Tag:</span>
                <input
                  type="number"
                  min={1}
                  max={daysInSelectedMonth}
                  value={proRataDay}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v) && v >= 1 && v <= daysInSelectedMonth) setProRataDay(v);
                  }}
                  className="w-16 h-8 rounded border border-border text-center text-sm font-mono bg-background"
                />
                <span className="text-xs text-muted-foreground">/ {daysInSelectedMonth}</span>
              </>
            )}
            <Button
              size="sm"
              variant={proRataDay !== null ? 'default' : 'outline'}
              className="h-8 text-xs gap-1.5"
              onClick={() => {
                if (proRataDay !== null) {
                  setProRataDay(null);
                } else {
                  const isCurrentMonth = selectedYear === today.getFullYear() && selectedMonth === today.getMonth() + 1;
                  setProRataDay(isCurrentMonth ? today.getDate() : daysInSelectedMonth);
                }
              }}
            >
              <Repeat className="h-3.5 w-3.5" />
              {proRataDay !== null ? 'Abgrenzung aus' : 'Abgrenzen'}
            </Button>
          </div>
        </div>

        {/* ── Budget-Auswertung ───────────────────────────────────────────────── */}
        <section className="rounded-xl border-2 border-violet-200 dark:border-violet-800 bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 bg-violet-50/40 dark:bg-violet-950/20 border-b border-border">
            <div className="flex items-center gap-2">
              <Target className="h-4 w-4 text-violet-600 dark:text-violet-400" />
              <span className="text-sm font-bold">Budget-Auswertung — {getMonthLabel(selectedYear, selectedMonth)}</span>
              {budgetRevenue != null && (
                <span className="ml-1 text-[10px] font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-2 py-0.5 rounded-full border border-amber-300 dark:border-amber-700">
                  Szenario aktiv
                </span>
              )}
            </div>
            {flexByWeek.length > 0 && (
              <button
                onClick={() => setShowWeekSummary(v => !v)}
                className={cn(
                  'text-[10px] font-semibold px-2.5 py-1 rounded border transition-colors cursor-pointer flex items-center gap-1',
                  showWeekSummary
                    ? 'border-violet-400 dark:border-violet-600 bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300'
                    : 'border-border bg-background text-muted-foreground hover:text-foreground hover:border-violet-300',
                )}
              >
                <BarChart2 className="h-3 w-3" />
                Wochenansicht
              </button>
            )}
          </div>

          {/* ── 3-Spalten-Vergleichstabelle ──────────────────────────────────── */}
          <div className="px-4 pt-4 pb-2">
            {/* Spalten-Header */}
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 mb-2 pb-1.5 border-b border-border">
              <div />
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground text-right min-w-[110px]">Geplantes Budget</div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400 text-right min-w-[180px]">Szenario</div>
            </div>

            {/* Zeile: Umsatz */}
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-start py-2.5 border-b border-dashed border-border">
              <span className="text-sm text-muted-foreground self-center">Umsatz</span>
              {/* Plan */}
              <div className="text-right self-center">
                <span className="font-mono font-semibold text-sm">
                  {budgetData.revenueBudget > 0 ? fmtCHF(budgetData.revenueBudget) : <span className="italic text-xs text-muted-foreground">—</span>}
                </span>
              </div>
              {/* Szenario: quick buttons + input */}
              <div className="min-w-[180px] space-y-1.5">
                <div className="flex flex-wrap justify-end gap-1">
                  {[-20000, -10000, +10000, +20000].map(delta => {
                    const base = budgetRevenue ?? budgetData.revenueBudget;
                    const target = base + delta;
                    if (target <= 0) return null;
                    return (
                      <button key={delta} onClick={() => {
                        setBudgetRevenue(target); setBudgetRevenueInput(String(target));
                        saveBudgetRevenue(selectedYear, selectedMonth, target, tenantKey);
                      }} className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded border transition-colors cursor-pointer',
                        delta > 0 ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100'
                          : 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 hover:bg-red-100')}>
                        {delta > 0 ? '+' : ''}{(delta / 1000).toFixed(0)}k
                      </button>
                    );
                  })}
                  {budgetRevenue != null && (
                    <button onClick={() => { setBudgetRevenue(null); setBudgetRevenueInput(''); saveBudgetRevenue(selectedYear, selectedMonth, null, tenantKey); }}
                      className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-border bg-muted text-muted-foreground hover:text-foreground cursor-pointer">
                      ↩
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="relative flex-1">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">CHF</span>
                    <Input className="pl-8 h-7 text-xs font-mono" placeholder={String(Math.round(budgetData.revenueBudget || 0))}
                      value={budgetRevenueInput} onChange={e => setBudgetRevenueInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { const v = parseFloat(budgetRevenueInput.replace(/['\s]/g,'').replace(',','.')); const val = !isNaN(v) && v > 0 ? v : null; setBudgetRevenue(val); saveBudgetRevenue(selectedYear, selectedMonth, val, tenantKey); } }} />
                  </div>
                  <button
                    type="button"
                    title="Wert übernehmen"
                    onClick={() => { const v = parseFloat(budgetRevenueInput.replace(/['\s]/g,'').replace(',','.')); const val = !isNaN(v) && v > 0 ? v : null; setBudgetRevenue(val); saveBudgetRevenue(selectedYear, selectedMonth, val, tenantKey); }}
                    className={cn(
                      'h-7 w-7 shrink-0 rounded border-2 flex items-center justify-center transition-colors cursor-pointer',
                      budgetRevenue != null
                        ? 'border-emerald-500 bg-emerald-500 text-white'
                        : 'border-border bg-background text-transparent hover:border-emerald-400',
                    )}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                </div>
                {budgetRevenue != null && (
                  <div className="text-right">
                    <span className={cn('text-[10px] font-semibold font-mono', budgetRevenue > budgetData.revenueBudget ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                      {budgetRevenue > budgetData.revenueBudget ? '+' : ''}{fmtCHF(budgetRevenue - budgetData.revenueBudget)} vs. Plan
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Zeile: Personalkosten */}
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-start py-2.5 border-b border-dashed border-border">
              <span className="text-sm text-muted-foreground self-center">Personalkosten</span>
              {/* Plan */}
              <div className="text-right self-center space-y-0.5">
                <div className="font-mono font-semibold text-sm">{personnelBudget > 0 ? fmtCHF(personnelBudget) : '—'}</div>
                {basePkqPct != null && (
                  <div className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded text-right',
                    basePkqPct < 30 ? 'text-emerald-600 dark:text-emerald-400' : basePkqPct < 40 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400')}>
                    {basePkqPct.toFixed(1)} % des Umsatzes
                  </div>
                )}
              </div>
              {/* Szenario: CHF-Eingabe + %-Eingabe (linked) */}
              <div className="min-w-[180px] space-y-1.5">
                {/* CHF-Eingabe */}
                <div className="flex items-center gap-1.5">
                  <div className="relative flex-1">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">CHF</span>
                    <Input className={cn('pl-8 h-7 text-xs font-mono', scenarioPkCost != null && 'border-amber-400 dark:border-amber-600')}
                      placeholder={String(Math.round(adjustedPersonnelBudget || 0))}
                      value={scenarioPkCostInput}
                      onChange={e => {
                        setScenarioPkCostInput(e.target.value);
                        const v = parseFloat(e.target.value.replace(/['\s]/g,'').replace(',','.'));
                        if (!isNaN(v) && v > 0 && effectiveBudgetRevenue > 0) {
                          setScenarioPkqInput(((v / effectiveBudgetRevenue) * 100).toFixed(2));
                        }
                      }}
                      onKeyDown={e => { if (e.key === 'Enter') { const v = parseFloat(scenarioPkCostInput.replace(/['\s]/g,'').replace(',','.')); const val = !isNaN(v) && v > 0 ? v : null; setScenarioPkCost(val); saveScenarioPkCost(selectedYear, selectedMonth, val, tenantKey); } }} />
                  </div>
                  <button
                    type="button"
                    title="CHF-Wert übernehmen"
                    onClick={() => { const v = parseFloat(scenarioPkCostInput.replace(/['\s]/g,'').replace(',','.')); const val = !isNaN(v) && v > 0 ? v : null; setScenarioPkCost(val); saveScenarioPkCost(selectedYear, selectedMonth, val, tenantKey); }}
                    className={cn(
                      'h-7 w-7 shrink-0 rounded border-2 flex items-center justify-center transition-colors cursor-pointer',
                      scenarioPkCost != null
                        ? 'border-amber-500 bg-amber-500 text-white'
                        : 'border-border bg-background text-transparent hover:border-amber-400',
                    )}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                </div>
                {/* %-Eingabe */}
                <div className="flex items-center gap-1.5">
                  <div className="relative flex-1">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                    <Input className="pl-6 h-7 text-xs font-mono"
                      placeholder={basePkqPct != null ? basePkqPct.toFixed(1) : ''}
                      value={scenarioPkqInput}
                      onChange={e => {
                        setScenarioPkqInput(e.target.value);
                        const pct = parseFloat(e.target.value.replace(',','.'));
                        if (!isNaN(pct) && pct > 0 && effectiveBudgetRevenue > 0) {
                          const chf = Math.round(effectiveBudgetRevenue * pct / 100);
                          setScenarioPkCostInput(String(chf));
                        }
                      }}
                      onKeyDown={e => { if (e.key === 'Enter') { const pct = parseFloat(scenarioPkqInput.replace(',','.')); if (!isNaN(pct) && pct > 0 && effectiveBudgetRevenue > 0) { const chf = Math.round(effectiveBudgetRevenue * pct / 100); setScenarioPkCost(chf); setScenarioPkCostInput(String(chf)); saveScenarioPkCost(selectedYear, selectedMonth, chf, tenantKey); } } }} />
                  </div>
                  <button
                    type="button"
                    title="%-Wert übernehmen"
                    onClick={() => { const pct = parseFloat(scenarioPkqInput.replace(',','.')); if (!isNaN(pct) && pct > 0 && effectiveBudgetRevenue > 0) { const chf = Math.round(effectiveBudgetRevenue * pct / 100); setScenarioPkCost(chf); setScenarioPkCostInput(String(chf)); saveScenarioPkCost(selectedYear, selectedMonth, chf, tenantKey); } }}
                    className={cn(
                      'h-7 w-7 shrink-0 rounded border-2 flex items-center justify-center transition-colors cursor-pointer',
                      scenarioPkCost != null
                        ? 'border-amber-500 bg-amber-500 text-white'
                        : 'border-border bg-background text-transparent hover:border-amber-400',
                    )}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                </div>
                {scenarioPkCost != null && (
                  <div className="flex items-center justify-between">
                    <span className={cn('text-[10px] font-semibold font-mono', adjustedPersonnelBudget - personnelBudget >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                      {adjustedPersonnelBudget - personnelBudget >= 0 ? '+' : ''}{fmtCHF(adjustedPersonnelBudget - personnelBudget)} vs. Plan
                    </span>
                    <button onClick={() => { setScenarioPkCost(null); setScenarioPkCostInput(''); setScenarioPkqInput(''); saveScenarioPkCost(selectedYear, selectedMonth, null, tenantKey); }}
                      className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer">↩ Reset</button>
                  </div>
                )}
              </div>
            </div>

            {/* Zeile: PKQ % */}
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-center py-2">
              <span className="text-sm text-muted-foreground">PKQ %</span>
              {/* Plan */}
              <div className="text-right">
                {basePkqPct != null ? (
                  <span className={cn('text-sm font-bold font-mono',
                    basePkqPct < 30 ? 'text-emerald-600 dark:text-emerald-400' : basePkqPct < 40 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400')}>
                    {basePkqPct.toFixed(1)} %
                  </span>
                ) : <span className="text-muted-foreground text-xs italic">—</span>}
              </div>
              {/* Szenario */}
              <div className="min-w-[180px] text-right">
                {effectiveScenarioPkqPct != null ? (
                  <div className="flex items-center justify-end gap-2">
                    {scenarioActive && basePkqPct != null && Math.abs(effectiveScenarioPkqPct - basePkqPct) > 0.05 && (
                      <span className={cn('text-[10px] font-semibold',
                        effectiveScenarioPkqPct < basePkqPct ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                        {effectiveScenarioPkqPct < basePkqPct ? '▼' : '▲'} {Math.abs(effectiveScenarioPkqPct - basePkqPct).toFixed(1)} Pkt
                      </span>
                    )}
                    <span className={cn('text-sm font-bold font-mono',
                      effectiveScenarioPkqPct < 30 ? 'text-emerald-600 dark:text-emerald-400'
                        : effectiveScenarioPkqPct < 40 ? 'text-amber-600 dark:text-amber-400'
                        : 'text-red-600 dark:text-red-400')}>
                      {effectiveScenarioPkqPct.toFixed(1)} %
                    </span>
                  </div>
                ) : <span className="text-muted-foreground text-xs italic">—</span>}
              </div>
            </div>
          </div>

          {/* ── Aufstellung ──────────────────────────────────────────────────── */}
          {(personnelBudget > 0 || effectiveBudgetRevenue > 0) && (
            <div className="border-t border-border px-4 pt-3 pb-4 space-y-0">

              {/* Spalten-Header der Aufstellung */}
              <div className="grid grid-cols-[1fr_52px_120px] items-center pb-1 mb-0.5">
                <div />
                <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/60 text-right pr-3">%</div>
                <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/60 text-right">CHF</div>
              </div>

              {/* Zeile 1: Budget Personalkosten */}
              <div className="grid grid-cols-[1fr_52px_120px] items-center py-1.5 border-b border-border/40">
                <span className="text-xs text-muted-foreground">Budget Personalkosten</span>
                <span className="text-right pr-3 text-[10px] font-mono tabular-nums text-muted-foreground/70">
                  {effectiveBudgetRevenue > 0 && adjustedPersonnelBudget > 0
                    ? `${((adjustedPersonnelBudget / effectiveBudgetRevenue) * 100).toFixed(1)} %`
                    : ''}
                </span>
                <span className="text-right text-xs font-mono font-semibold tabular-nums">
                  {adjustedPersonnelBudget > 0 ? fmtCHF(adjustedPersonnelBudget) : '—'}
                </span>
              </div>

              {/* Zeile 2: Personal FIX Ist gesamt */}
              <div className="grid grid-cols-[1fr_52px_120px] items-center py-1.5 border-b border-border/40">
                <span className="text-xs text-muted-foreground">− Personal FIX Ist</span>
                <span className="text-right pr-3 text-[10px] font-mono tabular-nums text-muted-foreground/70">
                  {effectiveBudgetRevenue > 0 && pfix.active.fix > 0
                    ? `${((pfix.active.fix / effectiveBudgetRevenue) * 100).toFixed(1)} %`
                    : ''}
                </span>
                <span className="text-right text-xs font-mono tabular-nums text-blue-600 dark:text-blue-400">
                  − {fmtCHF(pfix.active.fix)}
                </span>
              </div>

              {/* Zeile 3: Verfügbar für Flex */}
              <div className={cn(
                'grid grid-cols-[1fr_52px_120px] items-center py-1.5 px-2 mt-1 rounded',
                verfügbarFlexBudget >= 0
                  ? 'bg-emerald-50/60 dark:bg-emerald-950/20'
                  : 'bg-red-50/60 dark:bg-red-950/20',
              )}>
                <span className={cn('text-xs font-semibold',
                  verfügbarFlexBudget >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                  = Verfügbar Flex
                </span>
                <span className={cn('text-right pr-3 text-[10px] font-mono tabular-nums',
                  verfügbarFlexBudget >= 0 ? 'text-emerald-600/70 dark:text-emerald-500/70' : 'text-red-500/70 dark:text-red-400/70')}>
                  {effectiveBudgetRevenue > 0
                    ? `${((verfügbarFlexBudget / effectiveBudgetRevenue) * 100).toFixed(1)} %`
                    : ''}
                </span>
                <span className={cn('text-right text-xs font-mono font-bold tabular-nums',
                  verfügbarFlexBudget >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                  {fmtCHF(verfügbarFlexBudget)}
                </span>
              </div>

              {/* Wochen-Übersicht — KW-Boxen + Zusammenfassung + aufklappbare Tabelle */}
              {flexByWeek.length > 0 && (
                <div className="pt-3 pb-1 space-y-3">

                  {/* 1. Personal Flex Zusammenfassung */}
                  <div className="grid grid-cols-[1fr_52px_120px] items-center py-1.5 border-b border-dashed border-border/50 mt-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">− Personal Flex</span>
                      <span className="text-[10px] text-muted-foreground/50">
                        ({weekIstSet.size === 0 ? 'Plan' : weekIstSet.size === flexByWeek.length ? 'Ist' : `${weekIstSet.size}×Ist`})
                      </span>
                    </div>
                    <span className="text-right pr-3 text-[10px] font-mono tabular-nums text-muted-foreground/70">
                      {effectiveBudgetRevenue > 0 && totalFlexForBudget > 0
                        ? `${((totalFlexForBudget / effectiveBudgetRevenue) * 100).toFixed(1)} %`
                        : ''}
                    </span>
                    <span className={cn('text-right text-xs font-mono tabular-nums',
                      totalFlexForBudget > verfügbarFlexBudget ? 'text-red-600 dark:text-red-400' : 'text-foreground')}>
                      − {fmtCHF(totalFlexForBudget)}
                    </span>
                  </div>

                  {/* 2. Resultat */}
                  <div className={cn(
                    'grid grid-cols-[1fr_52px_120px] items-center py-2 px-2.5 rounded-lg mt-1',
                    budgetResultat >= 0
                      ? 'bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800'
                      : 'bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800',
                  )}>
                    <span className={cn('text-sm font-bold',
                      budgetResultat >= 0 ? 'text-emerald-800 dark:text-emerald-300' : 'text-red-700 dark:text-red-400')}>
                      {budgetResultat >= 0 ? '✓ Im Budget' : '⛔ Überschreitung'}
                    </span>
                    <span className={cn('text-right pr-3 text-[10px] font-mono tabular-nums font-semibold',
                      budgetResultat >= 0 ? 'text-emerald-600/80 dark:text-emerald-400/80' : 'text-red-500/80 dark:text-red-400/80')}>
                      {effectiveBudgetRevenue > 0
                        ? `${((Math.abs(budgetResultat) / effectiveBudgetRevenue) * 100).toFixed(1)} %`
                        : ''}
                    </span>
                    <span className={cn('text-right font-mono font-bold text-base tabular-nums',
                      budgetResultat >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400')}>
                      {budgetResultat >= 0 ? '' : '+'}{fmtCHF(Math.abs(budgetResultat))}
                    </span>
                  </div>

                  {/* 3. KW-Boxen */}
                  <div className="flex flex-wrap gap-2">
                    {flexByWeek.map((w, i) => {
                      const useIst  = weekIstSet.has(w.weekKey);
                      const pctDiff = w.planFlex > 0 ? ((w.istFlex - w.planFlex) / w.planFlex) * 100 : null;
                      const fixW    = fixByWeek[i]?.fixCost ?? 0;
                      const toggleWeek = (e: React.MouseEvent) => {
                        e.stopPropagation();
                        const next = new Set(weekIstSet);
                        if (next.has(w.weekKey)) next.delete(w.weekKey); else next.add(w.weekKey);
                        setWeekIstSet(next);
                        saveWeekIstSet(selectedYear, selectedMonth, [...next], tenantKey);
                      };
                      const openDetail = (e: React.MouseEvent) => {
                        e.stopPropagation();
                        setWeekDetailTarget(w.weekKey);
                      };
                      return (
                        <div
                          key={w.weekKey}
                          className={cn(
                            'flex flex-col items-start rounded-lg border-2 px-3 py-2 text-xs font-semibold min-w-[120px] relative',
                            useIst
                              ? 'border-orange-400 bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-300'
                              : 'border-blue-300 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300',
                          )}
                        >
                          <div className="flex items-center justify-between w-full gap-1 mb-0.5">
                            <span className="font-bold">{w.label}</span>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={openDetail}
                                title="Kostendetail anzeigen"
                                className={cn('p-0.5 rounded transition-colors cursor-pointer',
                                  useIst ? 'hover:bg-orange-200 dark:hover:bg-orange-900/40' : 'hover:bg-blue-200 dark:hover:bg-blue-900/40')}
                              >
                                <Info className="h-3 w-3 opacity-70" />
                              </button>
                              <button
                                onClick={toggleWeek}
                                className={cn('text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded cursor-pointer transition-colors',
                                  useIst ? 'bg-orange-200 dark:bg-orange-900/40 hover:bg-orange-300' : 'bg-blue-200 dark:bg-blue-900/40 hover:bg-blue-300')}
                              >
                                {useIst ? 'Ist ✓' : 'Plan'}
                              </button>
                            </div>
                          </div>
                          <span className="text-[10px] font-normal text-muted-foreground">{w.dateRange}</span>
                          {(() => {
                            const budgetW   = adjustedPersonnelBudget > 0 && daysInSelectedMonth > 0
                              ? adjustedPersonnelBudget * (w.daysInWeek / daysInSelectedMonth) : 0;
                            const totalIst  = fixW + w.istFlex;
                            const totalPlan = fixW + w.planFlex;
                            const deltaB    = budgetW > 0 ? (useIst ? totalIst : totalPlan) - budgetW : null;
                            return (
                              <div className="mt-1.5 w-full space-y-0.5">
                                <div className="flex justify-between text-[10px] text-muted-foreground">
                                  <span>Fix</span><span className="font-mono">{fmtCHF(fixW)}</span>
                                </div>
                                <div className={cn('flex justify-between text-[10px]', !useIst && 'font-bold')}>
                                  <span className="text-blue-600 dark:text-blue-400">Plan Flex</span>
                                  <span className="font-mono">{fmtCHF(w.planFlex)}</span>
                                </div>
                                <div className={cn('flex justify-between text-[10px]', useIst && 'font-bold')}>
                                  <span className="text-orange-600 dark:text-orange-400">Ist Flex</span>
                                  <span className="font-mono">{fmtCHF(w.istFlex)}</span>
                                </div>
                                {budgetW > 0 && (
                                  <div className="flex justify-between text-[10px] text-violet-600 dark:text-violet-400 border-t border-dashed border-current/20 pt-0.5 mt-0.5">
                                    <span>Budget</span><span className="font-mono">{fmtCHF(budgetW)}</span>
                                  </div>
                                )}
                                <div className="flex justify-end gap-1 flex-wrap pt-0.5">
                                  {pctDiff != null && (
                                    <span className={cn('text-[9px] font-semibold px-1 py-0.5 rounded',
                                      pctDiff > 5 ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400'
                                        : pctDiff < -5 ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400'
                                        : 'bg-muted text-muted-foreground')}>
                                      Flex {pctDiff >= 0 ? '+' : ''}{pctDiff.toFixed(1)} %
                                    </span>
                                  )}
                                  {deltaB != null && (
                                    <span className={cn('text-[9px] font-semibold px-1 py-0.5 rounded',
                                      deltaB > 0.5  ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400'
                                      : deltaB < -0.5 ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400'
                                      : 'bg-muted text-muted-foreground')}>
                                      vs Bdg {deltaB > 0.5 ? '+' : deltaB < -0.5 ? '−' : ''}{Math.abs(deltaB) < 1000 ? Math.round(Math.abs(deltaB)) : `${(Math.abs(deltaB)/1000).toFixed(1)}k`}
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>

                  {/* 4. Wochenübersicht Tabelle (toggle im Header) */}
                  {showWeekSummary && (
                  <div className="rounded-lg border border-border overflow-hidden text-xs">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-muted/60 border-b border-border">
                          <th className="px-3 py-2 text-left font-semibold text-muted-foreground w-[90px]">Woche</th>
                          <th className="px-2 py-2 text-left font-semibold text-muted-foreground">Zeitraum</th>
                          {hasAnyWeekRevenue && (
                            <th className="px-2 py-2 text-right font-semibold text-emerald-600 dark:text-emerald-400 text-[10px]">
                              Ist-Ums.<br />netto
                            </th>
                          )}
                          <th className="px-2 py-2 text-right font-semibold text-muted-foreground">
                            Fix
                            {hasAnyWeekRevenue && <div className="text-[9px] font-normal text-muted-foreground/60">% Ist-Ums.</div>}
                          </th>
                          <th className="px-2 py-2 text-right font-semibold text-blue-600 dark:text-blue-400">
                            Flex Plan
                            {hasAnyWeekRevenue && <div className="text-[9px] font-normal text-blue-400/70 dark:text-blue-500/70">% Ist-Ums.</div>}
                          </th>
                          <th className="px-2 py-2 text-right font-semibold text-orange-500 dark:text-orange-400">
                            Flex Ist
                            {hasAnyWeekRevenue && <div className="text-[9px] font-normal text-orange-400/70 dark:text-orange-500/70">% Ist-Ums.</div>}
                          </th>
                          <th className="px-2 py-2 text-right font-semibold text-foreground">
                            Total
                            {hasAnyWeekRevenue && <div className="text-[9px] font-normal text-muted-foreground/70">% Ist-Ums.</div>}
                          </th>
                          {adjustedPersonnelBudget > 0 && (
                            <>
                              <th className="px-2 py-2 text-right font-semibold text-violet-600 dark:text-violet-400">Budget</th>
                              <th className="px-2 py-2 text-right font-semibold text-muted-foreground">Δ Budget</th>
                            </>
                          )}
                          <th className="px-2 py-2 text-center font-semibold text-muted-foreground w-[60px]">Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {flexByWeek.map((w, i) => {
                          const fix      = fixByWeek[i]?.fixCost ?? 0;
                          const totalP   = fix + w.planFlex;
                          const totalI   = fix + w.istFlex;
                          const useIst   = weekIstSet.has(w.weekKey);
                          const activeTotal = useIst ? totalI : totalP;
                          const budgetW  = adjustedPersonnelBudget > 0 && daysInSelectedMonth > 0
                            ? adjustedPersonnelBudget * (w.daysInWeek / daysInSelectedMonth) : 0;
                          const deltaB   = budgetW > 0 ? activeTotal - budgetW : null;
                          const weekNetRev  = weekActualNetRevenue[w.weekKey] ?? null;
                          const isEstimate  = weekRevenueIsEstimate[w.weekKey] ?? false;
                          const isManual    = weekRevenueIsManual[w.weekKey] ?? false;

                          const toggleWeek = () => {
                            const next = new Set(weekIstSet);
                            if (next.has(w.weekKey)) next.delete(w.weekKey); else next.add(w.weekKey);
                            setWeekIstSet(next);
                            saveWeekIstSet(selectedYear, selectedMonth, [...next], tenantKey);
                          };

                          return (
                            <tr
                              key={w.weekKey}
                              className={cn(
                                'border-t border-border transition-colors',
                                useIst ? 'bg-orange-50/40 dark:bg-orange-950/10' : '',
                              )}
                            >
                              {/* KW + Toggle */}
                              <td className="px-3 py-2">
                                <div className="flex flex-col gap-1">
                                  <span className="font-bold text-foreground">{w.label}</span>
                                  <button
                                    onClick={toggleWeek}
                                    title="Zwischen Plan und Ist wechseln"
                                    className={cn(
                                      'text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border cursor-pointer transition-colors w-fit',
                                      useIst
                                        ? 'border-orange-400 bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 hover:bg-orange-200'
                                        : 'border-blue-300 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 hover:bg-blue-100',
                                    )}
                                  >
                                    {useIst ? '● Ist' : '○ Plan'}
                                  </button>
                                </div>
                              </td>

                              {/* Zeitraum */}
                              <td className="px-2 py-2 text-muted-foreground">{w.dateRange}</td>

                              {/* Ist-Umsatz netto (Berechnungsbasis) — ganz links, editierbar für Schätzwochen */}
                              {hasAnyWeekRevenue && (
                                <td className="px-2 py-1.5 text-right font-mono">
                                  {weekRevEditKey === w.weekKey ? (
                                    /* ── Inline-Editor ── */
                                    <div className="flex items-center justify-end gap-1">
                                      <input
                                        type="text"
                                        inputMode="decimal"
                                        className="w-24 text-xs text-right font-mono border border-border rounded px-1.5 py-0.5 bg-background focus:outline-none focus:ring-1 focus:ring-emerald-400"
                                        value={weekRevEditVal}
                                        autoFocus
                                        placeholder="z.B. 42000"
                                        onChange={e => setWeekRevEditVal(e.target.value)}
                                        onKeyDown={e => {
                                          if (e.key === 'Enter')  commitWeekRevEdit(w.weekKey, weekRevEditVal);
                                          if (e.key === 'Escape') { setWeekRevEditKey(null); setWeekRevEditVal(''); }
                                        }}
                                        onBlur={() => commitWeekRevEdit(w.weekKey, weekRevEditVal)}
                                      />
                                    </div>
                                  ) : (
                                    /* ── Anzeige ── */
                                    <div className={cn(
                                      'flex flex-col items-end gap-0.5',
                                      isManual
                                        ? 'text-blue-700 dark:text-blue-300'
                                        : isEstimate
                                          ? 'text-muted-foreground/60'
                                          : 'text-emerald-700 dark:text-emerald-400',
                                    )}>
                                      {weekNetRev != null ? (
                                        <>
                                          <span className="text-xs">{fmtCHF(weekNetRev)}</span>
                                          {isManual && (
                                            <div className="flex items-center gap-1">
                                              <span className="text-[9px] italic opacity-80">Manuell</span>
                                              <button
                                                title="Umsatz bearbeiten"
                                                className="opacity-50 hover:opacity-100 cursor-pointer transition-opacity"
                                                onClick={() => { setWeekRevEditKey(w.weekKey); setWeekRevEditVal(String(Math.round(weekNetRev))); }}
                                              >✎</button>
                                              <button
                                                title="Override löschen (zurück zu Budget)"
                                                className="opacity-40 hover:opacity-100 hover:text-red-500 cursor-pointer transition-opacity text-[10px]"
                                                onClick={() => commitWeekRevEdit(w.weekKey, '')}
                                              >✕</button>
                                            </div>
                                          )}
                                          {isEstimate && !isManual && (
                                            <div className="flex items-center gap-1">
                                              <span className="text-[9px] italic opacity-70">Budget p.r.</span>
                                              <button
                                                title="Umsatz manuell setzen"
                                                className="opacity-40 hover:opacity-100 cursor-pointer transition-opacity text-[10px]"
                                                onClick={() => { setWeekRevEditKey(w.weekKey); setWeekRevEditVal(String(Math.round(weekNetRev))); }}
                                              >✎</button>
                                            </div>
                                          )}
                                        </>
                                      ) : (
                                        isEstimate ? (
                                          <button
                                            title="Umsatz manuell setzen"
                                            className="text-[10px] opacity-40 hover:opacity-100 cursor-pointer transition-opacity text-muted-foreground"
                                            onClick={() => { setWeekRevEditKey(w.weekKey); setWeekRevEditVal(''); }}
                                          >+ Umsatz</button>
                                        ) : (
                                          <span className="opacity-30">—</span>
                                        )
                                      )}
                                    </div>
                                  )}
                                </td>
                              )}

                              {/* Fix */}
                              <td className="px-2 py-2 text-right font-mono text-muted-foreground">
                                <div className="flex flex-col items-end gap-0.5">
                                  <span>{fmtCHF(fix)}</span>
                                  {weekNetRev != null && weekNetRev > 0 && fix > 0 && (
                                    <span className="text-[9px] font-normal tabular-nums text-muted-foreground/60">
                                      {((fix / weekNetRev) * 100).toFixed(1)} %
                                    </span>
                                  )}
                                </div>
                              </td>

                              {/* Flex Plan */}
                              <td className={cn('px-2 py-2 text-right font-mono', !useIst ? 'font-semibold text-blue-700 dark:text-blue-300' : 'text-muted-foreground')}>
                                <div className="flex flex-col items-end gap-0.5">
                                  <span>{fmtCHF(w.planFlex)}</span>
                                  {weekNetRev != null && weekNetRev > 0 && w.planFlex > 0 && (
                                    <span className="text-[9px] font-normal tabular-nums text-blue-500/80 dark:text-blue-400/70">
                                      {((w.planFlex / weekNetRev) * 100).toFixed(1)} %
                                    </span>
                                  )}
                                </div>
                              </td>

                              {/* Flex Ist */}
                              <td className={cn('px-2 py-2 text-right font-mono', useIst ? 'font-semibold text-orange-700 dark:text-orange-300' : 'text-muted-foreground')}>
                                <div className="flex flex-col items-end gap-0.5">
                                  {w.istFlex > 0 ? <span>{fmtCHF(w.istFlex)}</span> : <span className="opacity-40">—</span>}
                                  {weekNetRev != null && weekNetRev > 0 && w.istFlex > 0 && (
                                    <span className="text-[9px] font-normal tabular-nums text-orange-500/80 dark:text-orange-400/70">
                                      {((w.istFlex / weekNetRev) * 100).toFixed(1)} %
                                    </span>
                                  )}
                                </div>
                              </td>

                              {/* Total (aktiver Wert) */}
                              <td className="px-2 py-2 text-right font-mono">
                                <div className="flex flex-col items-end gap-0.5">
                                  <span className={cn('font-bold', useIst ? 'text-orange-700 dark:text-orange-300' : 'text-blue-700 dark:text-blue-300')}>
                                    {fmtCHF(activeTotal)}
                                  </span>
                                  {weekNetRev != null && weekNetRev > 0 ? (
                                    <span className={cn(
                                      'text-[11px] font-bold tabular-nums px-1 py-0.5 rounded',
                                      deltaB == null
                                        ? 'text-muted-foreground'
                                        : deltaB <= 0
                                          ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40'
                                          : deltaB <= budgetW * 0.03
                                            ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40'
                                            : 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40',
                                    )}>
                                      {((activeTotal / weekNetRev) * 100).toFixed(1)} %
                                    </span>
                                  ) : (
                                    <span className="text-[9px] text-muted-foreground opacity-60">{useIst ? 'Ist' : 'Plan'}</span>
                                  )}
                                </div>
                              </td>

                              {/* Budget + Δ */}
                              {adjustedPersonnelBudget > 0 && (
                                <>
                                  <td className="px-2 py-2 text-right font-mono text-violet-700 dark:text-violet-300">
                                    {fmtCHF(budgetW)}
                                  </td>
                                  <td className={cn('px-2 py-2 text-right font-mono',
                                    deltaB == null ? 'text-muted-foreground'
                                      : deltaB > 0.5 ? 'text-red-600 dark:text-red-400'
                                      : deltaB < -0.5 ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-muted-foreground')}>
                                    {deltaB == null ? '—' : (
                                      <span className="font-semibold">
                                        {deltaB > 0.5 ? '+' : deltaB < -0.5 ? '−' : ''}{fmtCHF(Math.abs(deltaB)).replace('CHF\u00a0','')}
                                      </span>
                                    )}
                                  </td>
                                </>
                              )}

                              {/* Detail-Popup */}
                              <td className="px-2 py-2 text-center">
                                <button
                                  onClick={() => setWeekDetailTarget(w.weekKey)}
                                  title="Kostendetail anzeigen"
                                  className="p-1 rounded hover:bg-muted transition-colors cursor-pointer text-muted-foreground hover:text-foreground"
                                >
                                  <Info className="h-3.5 w-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}

                        {/* Total-Zeile */}
                        {(() => {
                          const totalFlexPlan    = flexByWeek.reduce((s, w) => s + w.planFlex, 0);
                          const totalFlexIst     = flexByWeek.reduce((s, w) => s + w.istFlex, 0);
                          const grandTotal       = totalFixCost + totalFlexForBudget;
                          const grandDeltaB      = adjustedPersonnelBudget > 0 ? grandTotal - adjustedPersonnelBudget : null;
                          const totalNetRevenue  = hasAnyWeekRevenue
                            ? Object.values(weekActualNetRevenue).reduce((s, v) => s + v, 0)
                            : null;
                          return (
                            <tr className="border-t-2 border-border bg-muted/50 font-bold">
                              <td className="px-3 py-2.5 text-foreground" colSpan={2}>Total Monat</td>
                              {/* Ist-Umsatz netto total — ganz links */}
                              {hasAnyWeekRevenue && (
                                <td className="px-2 py-2.5 text-right font-mono text-emerald-700 dark:text-emerald-400">
                                  {totalNetRevenue != null ? fmtCHF(totalNetRevenue) : '—'}
                                </td>
                              )}
                              {/* Fix total + % */}
                              <td className="px-2 py-2.5 text-right font-mono text-muted-foreground">
                                <div className="flex flex-col items-end gap-0.5">
                                  <span>{fmtCHF(totalFixCost)}</span>
                                  {totalNetRevenue != null && totalNetRevenue > 0 && totalFixCost > 0 && (
                                    <span className="text-[9px] font-normal tabular-nums text-muted-foreground/60">
                                      {((totalFixCost / totalNetRevenue) * 100).toFixed(1)} %
                                    </span>
                                  )}
                                </div>
                              </td>
                              {/* Flex Plan total + % */}
                              <td className="px-2 py-2.5 text-right font-mono text-blue-700 dark:text-blue-300">
                                <div className="flex flex-col items-end gap-0.5">
                                  <span>{fmtCHF(totalFlexPlan)}</span>
                                  {totalNetRevenue != null && totalNetRevenue > 0 && totalFlexPlan > 0 && (
                                    <span className="text-[9px] font-normal tabular-nums text-blue-500/70 dark:text-blue-400/60">
                                      {((totalFlexPlan / totalNetRevenue) * 100).toFixed(1)} %
                                    </span>
                                  )}
                                </div>
                              </td>
                              {/* Flex Ist total + % */}
                              <td className="px-2 py-2.5 text-right font-mono text-orange-700 dark:text-orange-300">
                                <div className="flex flex-col items-end gap-0.5">
                                  <span>{fmtCHF(totalFlexIst)}</span>
                                  {totalNetRevenue != null && totalNetRevenue > 0 && totalFlexIst > 0 && (
                                    <span className="text-[9px] font-normal tabular-nums text-orange-500/70 dark:text-orange-400/60">
                                      {((totalFlexIst / totalNetRevenue) * 100).toFixed(1)} %
                                    </span>
                                  )}
                                </div>
                              </td>
                              {/* Grand Total + % */}
                              <td className="px-2 py-2.5 text-right font-mono text-foreground">
                                <div className="flex flex-col items-end gap-0.5">
                                  <span>{fmtCHF(grandTotal)}</span>
                                  {totalNetRevenue != null && totalNetRevenue > 0 ? (
                                    <span className={cn(
                                      'text-xs font-bold tabular-nums px-1.5 py-0.5 rounded',
                                      grandDeltaB == null
                                        ? 'text-muted-foreground'
                                        : grandDeltaB <= 0
                                          ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40'
                                          : grandDeltaB <= adjustedPersonnelBudget * 0.03
                                            ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40'
                                            : 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40',
                                    )}>
                                      {((grandTotal / totalNetRevenue) * 100).toFixed(1)} %
                                    </span>
                                  ) : (
                                    <span className="text-[9px] font-normal text-muted-foreground">
                                      {weekIstSet.size === 0 ? 'Plan' : weekIstSet.size === flexByWeek.length ? 'Ist' : `${weekIstSet.size}×Ist`}
                                    </span>
                                  )}
                                </div>
                              </td>
                              {adjustedPersonnelBudget > 0 && (
                                <>
                                  <td className="px-2 py-2.5 text-right font-mono text-violet-700 dark:text-violet-300">{fmtCHF(adjustedPersonnelBudget)}</td>
                                  <td className={cn('px-2 py-2.5 text-right font-mono',
                                    grandDeltaB == null ? 'text-muted-foreground'
                                      : grandDeltaB > 0.5 ? 'text-red-600 dark:text-red-400'
                                      : grandDeltaB < -0.5 ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-muted-foreground')}>
                                    {grandDeltaB == null ? '—' : `${grandDeltaB > 0.5 ? '+' : grandDeltaB < -0.5 ? '−' : ''}${fmtCHF(Math.abs(grandDeltaB)).replace('CHF\u00a0','')}`}
                                  </td>
                                </>
                              )}
                              <td />
                            </tr>
                          );
                        })()}
                      </tbody>
                    </table>
                  </div>
                  )}

                </div>
              )}
            </div>
          )}
        </section>

        {/* ── KPI-Block (8 Karten: Plan + Ist für alle 4 Ebenen) ───────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard
            title={proRataDay !== null ? `Flex Arbeit Plan bis ${proRataDay}.` : 'Flex Arbeit Plan'}
            value={fmtCHF(pfix.active.planWork)}
            sub="Dienstplan-Stunden × Lohn"
            icon={<Clock className="h-5 w-5" />}
            color="blue"
          />
          <KpiCard
            title={proRataDay !== null ? `Flex Arbeit Ist bis ${proRataDay}.` : 'Flex Arbeit Ist'}
            value={fmtCHF(pfix.active.istWork)}
            sub="Mirus-Ist-Stunden × Lohn"
            icon={<Clock className="h-5 w-5" />}
            color={pfix.active.istWork > 0 ? 'orange' : 'default'}
          />
          <KpiCard
            title={proRataDay !== null ? `PKQ Plan bis ${proRataDay}.` : 'PKQ Plan'}
            value={pkqPlan !== null ? `${pkqPlan.toFixed(1)} %` : '—'}
            sub={effectiveRevenue > 0 ? `${fmtCHF(pfix.active.planTotal)} / ${fmtCHF(effectiveRevenue)}${revenueIsAssumed ? ' (Annahme)' : ''}` : 'Kein Umsatz erfasst'}
            icon={<TrendingDown className="h-5 w-5" />}
            color="blue"
          />
          <KpiCard
            title={proRataDay !== null ? `PKQ Ist bis ${proRataDay}.` : 'PKQ Ist'}
            value={pkqIst !== null ? `${pkqIst.toFixed(1)} %` : '—'}
            sub={effectiveRevenue > 0 ? `${fmtCHF(pfix.active.istTotal)} / ${fmtCHF(effectiveRevenue)} · ${revenueLabel}` : 'Kein Umsatz erfasst'}
            icon={<TrendingDown className="h-5 w-5" />}
            color={pkqIst !== null && pkqPlan !== null ? (pkqIst > pkqPlan + 1 ? 'red' : pkqIst < pkqPlan - 1 ? 'green' : 'default') : 'default'}
          />
          <KpiCard
            title={proRataDay !== null ? `Total Flex Plan bis ${proRataDay}.` : 'Total Flex Plan'}
            value={fmtCHF(pfix.active.planTotalVar)}
            sub="Flex Arbeit + Ferien (Plan)"
            icon={<TrendingUp className="h-5 w-5" />}
            color="blue"
          />
          <KpiCard
            title={proRataDay !== null ? `Total Flex Ist bis ${proRataDay}.` : 'Total Flex Ist'}
            value={fmtCHF(pfix.active.istTotalVar)}
            sub="Flex Arbeit + Ferien (Ist)"
            icon={<TrendingUp className="h-5 w-5" />}
            color={pfix.active.istTotalVar > 0 ? 'orange' : 'default'}
          />
          <KpiCard
            title={proRataDay !== null ? `Diff. Arbeit bis ${proRataDay}.` : 'Diff. Arbeit'}
            value={fmtCHF(Math.abs(pfix.active.diffWork))}
            sub={pfix.active.diffWork === 0 ? 'Plan = Ist' : pfix.active.diffWork > 0 ? '↑ Ist über Plan' : '✓ Ist unter Plan'}
            icon={<BarChart2 className="h-5 w-5" />}
            color={pfix.active.diffWork > 0 ? 'red' : pfix.active.diffWork < 0 ? 'green' : 'default'}
            delta={pfix.active.diffWork}
            deltaLabel="Ist − Plan (Arbeit)"
          />
          <KpiCard
            title={proRataDay !== null ? `Personal FIX bis ${proRataDay}.` : 'Personal FIX / Monat'}
            value={fmtCHF(pfix.active.fix)}
            sub={`${activeFixedEmployees.length} MA · Fixlohn`}
            icon={<DollarSign className="h-5 w-5" />}
            color="blue"
          />
        </div>


        {/* ── Einheitliche Flex-Auswertung ───────────────────────────────────── */}
        {(pfixAbw.days.length > 0 || pfixPerEmp.length > 0) && (() => {
          const { days, weeks, monthPlan, monthIst, monthDiff } = pfixAbw;
          const monthPct    = monthPlan > 0 ? (monthDiff / monthPlan) * 100 : null;
          const avgWeekDiff = weeks.length > 0 ? monthDiff / weeks.length : 0;
          const avgDayDiff  = days.length  > 0 ? monthDiff / days.length  : 0;
          const monthStatus = ampelStatus(monthDiff, monthPlan);
          const mA          = AMPEL[monthStatus];

          const fmtDiff = (v: number) => {
            const s = fmtCHF(Math.abs(v));
            return v > 0.005 ? `+${s}` : v < -0.005 ? `−${s}` : s;
          };
          const fmtPct = (v: number | null) => {
            if (v === null) return '–';
            const s = `${Math.abs(v).toFixed(1)} %`;
            return v > 0.05 ? `+${s}` : v < -0.05 ? `−${s}` : s;
          };

          const allDates = days.map(d => d.date);
          const monthLabel = getMonthLabel(selectedYear, selectedMonth);

          type PeriodRow = { period: string; plan: number; ist: number; diff: number; diffPct: number | null; dates: string[] };
          const tableRows: PeriodRow[] =
            abwMode === 'year'  ? [{ period: monthLabel, plan: monthPlan, ist: monthIst, diff: monthDiff, diffPct: monthPct, dates: allDates }] :
            abwMode === 'month' ? [{ period: monthLabel, plan: monthPlan, ist: monthIst, diff: monthDiff, diffPct: monthPct, dates: allDates }] :
            abwMode === 'week'  ? weeks.map(w => ({ period: w.period, plan: w.planTotal, ist: w.istTotal, diff: w.diff, diffPct: w.diffPct, dates: w.dates })) :
            days.map(d => ({ period: fmtDate(d.date), plan: d.planTotal, ist: d.istTotal, diff: d.diff, diffPct: d.diffPct, dates: [d.date] }));

          const kpiChips = [
            { label: 'Abweichung Monat', val: monthDiff,   plan: monthPlan,                                          pct: monthPct },
            { label: 'Ø Abw./Woche',     val: avgWeekDiff, plan: weeks.length > 0 ? monthPlan / weeks.length : 0,   pct: weeks.length > 0 ? (avgWeekDiff / (monthPlan / weeks.length)) * 100 : null },
            { label: 'Ø Abw./Tag',        val: avgDayDiff,  plan: days.length  > 0 ? monthPlan / days.length  : 0,  pct: days.length  > 0 ? (avgDayDiff  / (monthPlan / days.length))  * 100 : null },
          ];

          const empTotal = pfixPerEmp.reduce((s, r) => s + r.planWork, 0);
          const empIst   = pfixPerEmp.reduce((s, r) => s + r.istWork, 0);
          console.log(`[FLEX] summary total plan: ${monthPlan.toFixed(2)}`);
          console.log(`[FLEX] summary total ist: ${monthIst.toFixed(2)}`);
          console.log(`[FLEX] employee table total plan: ${empTotal.toFixed(2)}`);
          console.log(`[FLEX] employee table total ist: ${empIst.toFixed(2)}`);
          if (monthPlan > 0 && Math.abs(empTotal - monthPlan) > 0.10)
            console.error(`[FLEX] plan cross-check MISMATCH: periodTable=${monthPlan.toFixed(2)} empTable=${empTotal.toFixed(2)} Δ=${(empTotal-monthPlan).toFixed(2)}`);
          if (monthIst > 0 && Math.abs(empIst - monthIst) > 0.10)
            console.error(`[FLEX] ist cross-check MISMATCH: periodTable=${monthIst.toFixed(2)} empTable=${empIst.toFixed(2)} Δ=${(empIst-monthIst).toFixed(2)}`);

          return (
            <section className={cn('rounded-xl border-2 bg-card shadow-sm overflow-hidden', mA.border)}>
              {/* ── Header ────────────────────────────────────────────────────── */}
              <div className={cn('flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border', mA.bg || 'bg-amber-50/60 dark:bg-amber-950/20')}>
                <TrendingDown className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <span className="text-sm font-bold text-amber-900 dark:text-amber-200">
                  Flex-Auswertung — Plan vs. Ist
                </span>
                <div className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ml-1', mA.border, mA.bg, mA.text)}>
                  <span className={cn('inline-block w-2 h-2 rounded-full shrink-0', mA.dot)} />
                  {mA.label}
                </div>
                <div className="flex items-center gap-1 ml-auto">
                  <Button size="sm" variant="ghost" onClick={handleFlexExportPDF}
                    className="h-7 px-2 text-xs gap-1 text-blue-600 hover:bg-blue-50 hover:text-blue-700 dark:text-blue-400 dark:hover:bg-blue-950/30"
                    title="Flex-Auswertung als PDF exportieren">
                    <Download className="h-3 w-3" />PDF
                  </Button>
                  <Button size="sm" variant="ghost" onClick={handleFlexExportExcel}
                    className="h-7 px-2 text-xs gap-1 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                    title="Flex-Auswertung als Excel exportieren">
                    <Download className="h-3 w-3" />Excel
                  </Button>
                </div>
                {proRataDay !== null && (
                  <Badge variant="secondary" className="text-xs">bis {proRataDay}. · {Math.round(proRataFactor * 100)} %</Badge>
                )}
              </div>

              {/* ── KPI Chips ─────────────────────────────────────────────────── */}
              <div className="flex flex-wrap gap-3 px-4 py-3 border-b border-border bg-muted/10">
                {kpiChips.map(({ label, val, plan: chipPlan, pct }) => {
                  const st = ampelStatus(val, chipPlan);
                  const a  = AMPEL[st];
                  return (
                    <div key={label} className={cn('flex flex-col items-start rounded-lg border px-3 py-2 min-w-[148px]', a.border, a.bg || 'bg-background')}>
                      <div className="flex items-center gap-1.5 w-full">
                        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide flex-1">{label}</span>
                        <span className={cn('inline-block w-2 h-2 rounded-full shrink-0', a.dot)} />
                      </div>
                      <span className={cn('text-base font-bold font-mono tabular-nums mt-0.5', a.text)}>{fmtDiff(val)}</span>
                      <div className="flex items-center gap-2 mt-0.5">
                        {pct !== null && <span className={cn('text-xs font-mono tabular-nums', a.text)}>{fmtPct(pct)}</span>}
                        <span className={cn('text-[9px] font-semibold uppercase', a.text)}>{a.label}</span>
                      </div>
                    </div>
                  );
                })}
                <div className="flex flex-col items-start rounded-lg border border-border bg-background px-3 py-2 min-w-[140px]">
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Total Plan</span>
                  <span className="text-base font-bold font-mono tabular-nums text-blue-700 dark:text-blue-400 mt-0.5">{fmtCHF(monthPlan)}</span>
                </div>
                <div className="flex flex-col items-start rounded-lg border border-border bg-background px-3 py-2 min-w-[140px]">
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Total Ist</span>
                  <span className="text-base font-bold font-mono tabular-nums text-orange-700 dark:text-orange-400 mt-0.5">{fmtCHF(monthIst)}</span>
                </div>
              </div>

              {/* ── Toggle + Legende ──────────────────────────────────────────── */}
              <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-border bg-muted/5">
                <span className="text-xs text-muted-foreground font-medium">Aggregation:</span>
                <div className="flex gap-1 rounded-lg bg-muted p-0.5">
                  {(['day', 'week', 'month', 'year'] as AbwMode[]).map(m => (
                    <button key={m} onClick={() => setAbwMode(m)}
                      className={cn('rounded px-3 py-1 text-xs font-medium transition-colors',
                        abwMode === m ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                      {m === 'day' ? 'Tag' : m === 'week' ? 'Woche' : m === 'month' ? 'Monat' : 'Jahr'}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-3 ml-auto text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-emerald-500" /> Im Plan</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-amber-400" /> Leicht über Plan (&le;5 %)</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-red-500" /> Über Plan (&gt;5 %)</span>
                  <span className="text-[10px] italic text-muted-foreground/60 ml-2">Zeile anklicken → Details</span>
                </div>
              </div>

              {/* ── Periodenübersicht (clickable rows → FlexPeriodPopup) ──────── */}
              {tableRows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground border-b border-border bg-muted/10">
                        <th className="text-center px-3 py-2 font-medium w-8">●</th>
                        <th className="text-left px-4 py-2 font-medium">Zeitraum</th>
                        <th className="text-right px-4 py-2 font-medium text-blue-600">Total Flex Plan</th>
                        <th className="text-right px-4 py-2 font-medium text-orange-600">Total Flex Ist</th>
                        <th className="text-right px-4 py-2 font-medium">Diff. CHF</th>
                        <th className="text-right px-4 py-2 font-medium">Diff. %</th>
                        <th className="text-left px-3 py-2 font-medium">Status</th>
                        <th className="text-right px-4 py-2 font-medium">Kum. Abw. CHF</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(() => {
                        let cumDiff = 0;
                        return tableRows.map((row, i) => {
                          cumDiff += row.diff;
                          console.log(`[FLEX-CUM] aggregation: ${abwMode}`);
                          console.log(`[FLEX-CUM] row diff: ${row.diff.toFixed(2)}`);
                          console.log(`[FLEX-CUM] running diff total: ${cumDiff.toFixed(2)}`);
                          const st = ampelStatus(row.diff, row.plan);
                          const a  = AMPEL[st];
                          const cumCls = cumDiff > 0.005 ? 'text-red-600 dark:text-red-400'
                            : cumDiff < -0.005 ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-muted-foreground';
                          return (
                            <tr
                              key={i}
                              className={cn('hover:bg-muted/30 cursor-pointer transition-colors', a.bg)}
                              onClick={() => setFlexPeriodPopup({
                                label:     row.period,
                                dates:     row.dates,
                                planTotal: row.plan,
                                istTotal:  row.ist,
                                year:      selectedYear,
                                month:     selectedMonth,
                              })}
                              title="Klicken für MA-Aufschlüsselung"
                            >
                              <td className="px-3 py-2 text-center">
                                <span className={cn('inline-block w-2.5 h-2.5 rounded-full', a.dot)} />
                              </td>
                              <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{row.period}</td>
                              <td className="px-4 py-2 text-right font-mono tabular-nums text-blue-700 dark:text-blue-400">{fmtCHF(row.plan)}</td>
                              <td className="px-4 py-2 text-right font-mono tabular-nums text-orange-700 dark:text-orange-400">{fmtCHF(row.ist)}</td>
                              <td className={cn('px-4 py-2 text-right font-mono tabular-nums font-semibold', a.text)}>{fmtDiff(row.diff)}</td>
                              <td className={cn('px-4 py-2 text-right font-mono tabular-nums text-xs', a.text)}>{fmtPct(row.diffPct)}</td>
                              <td className={cn('px-3 py-2 text-xs font-medium', a.text)}>{a.label}</td>
                              <td className={cn('px-4 py-2 text-right font-mono tabular-nums font-semibold text-xs', cumCls)}>
                                {cumDiff > 0.005 ? '+' : cumDiff < -0.005 ? '−' : ''}{fmtCHF(Math.abs(cumDiff))}
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                    {tableRows.length > 1 && (
                      <tfoot>
                        <tr className={cn('border-t-2 border-border', mA.bg || 'bg-muted/20')}>
                          <td className="px-3 py-2.5 text-center"><span className={cn('inline-block w-2.5 h-2.5 rounded-full', mA.dot)} /></td>
                          <td className="px-4 py-2.5 font-bold text-xs">Total</td>
                          <td className="px-4 py-2.5 text-right font-mono font-bold text-blue-700 dark:text-blue-400">{fmtCHF(monthPlan)}</td>
                          <td className="px-4 py-2.5 text-right font-mono font-bold text-orange-700 dark:text-orange-400">{fmtCHF(monthIst)}</td>
                          <td className={cn('px-4 py-2.5 text-right font-mono font-bold', mA.text)}>{fmtDiff(monthDiff)}</td>
                          <td className={cn('px-4 py-2.5 text-right font-mono text-xs', mA.text)}>{fmtPct(monthPct)}</td>
                          <td className={cn('px-3 py-2.5 text-xs font-semibold', mA.text)}>{mA.label}</td>
                          <td className={cn('px-4 py-2.5 text-right font-mono font-bold text-xs', mA.text)}>
                            {monthDiff > 0.005 ? '+' : monthDiff < -0.005 ? '−' : ''}{fmtCHF(Math.abs(monthDiff))}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}

              {/* ── Mitarbeiter-Vergleichstabelle ─────────────────────────────── */}
              {pfixPerEmp.length > 0 && (
                <>
                  <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border bg-muted/20">
                    <Users className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Flex Kosten pro Mitarbeiter
                      {proRataDay !== null && ` — bis ${proRataDay}.`}
                    </span>
                    <Badge variant="secondary" className="text-xs ml-auto">{pfixPerEmp.length} MA</Badge>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border-t border-border min-w-[580px]">
                      <thead>
                        <tr className="bg-muted/30 border-b border-border text-muted-foreground">
                          <th className="px-3 py-2 text-left font-medium">Name</th>
                          <th className="px-3 py-2 text-center font-medium">Abt.</th>
                          <th className="px-3 py-2 text-right font-medium">CHF/h</th>
                          <th className="px-3 py-2 text-right font-medium text-blue-500">Plan Std</th>
                          <th className="px-3 py-2 text-right font-medium text-orange-500">Ist Std</th>
                          <th className="px-3 py-2 text-right font-medium text-blue-700">Flex Plan</th>
                          <th className="px-3 py-2 text-right font-medium text-orange-700">Flex Ist</th>
                          <th className="px-3 py-2 text-right font-medium">Diff.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pfixPerEmp.map((row, i) => {
                          const dc = (v: number) => v === 0 ? 'text-muted-foreground' : v > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400';
                          const openBreakdown = (field: BreakdownField) => setBreakdown({
                            empId:       row.id,
                            empName:     row.name,
                            field,
                            hourlyWage:  row.hourlyWage,
                            weeklyHours: row.weeklyHours,
                            year:        selectedYear,
                            month:       selectedMonth,
                            cutoffDay:   proRataDay,
                            factor:      proRataDay !== null ? proRataFactor : 1,
                          });
                          const clickCell = (field: BreakdownField, amount: number, colorClass: string) => (
                            <td className="px-3 py-1.5 text-right">
                              {amount > 0
                                ? <button onClick={() => openBreakdown(field)}
                                    className={cn('font-mono font-semibold underline underline-offset-2 decoration-dotted hover:opacity-80 transition-opacity cursor-pointer', colorClass)}
                                    title="Tagesdetails anzeigen">
                                    {fmtCHF(amount)}
                                  </button>
                                : <span className="text-muted-foreground font-mono">–</span>}
                            </td>
                          );
                          const isZusatz = (row as any).isFixedAdditional === true;
                          return (
                            <tr key={row.id + (isZusatz ? '-zusatz' : '')} className={
                              isZusatz
                                ? 'bg-orange-50/60 dark:bg-orange-900/10 hover:bg-orange-100/50 dark:hover:bg-orange-900/20 border-l-2 border-orange-400'
                                : i % 2 === 0 ? 'bg-background hover:bg-muted/20' : 'bg-muted/10 hover:bg-muted/20'
                            }>
                              <td className="px-3 py-1.5 font-medium">
                                <div className="flex items-center gap-2">
                                  {row.name}
                                  {isZusatz && (
                                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 whitespace-nowrap">
                                      Zusatzkosten
                                    </span>
                                  )}
                                  {!isZusatz && row.hourlyWage === 0 && (
                                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 whitespace-nowrap">
                                      Lohn fehlt
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-1.5 text-center text-muted-foreground capitalize">{row.dept}</td>
                              <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{row.hourlyWage > 0 ? `${row.hourlyWage.toFixed(2)}` : '–'}</td>
                              <td className="px-3 py-1.5 text-right font-mono text-blue-500 dark:text-blue-400">{row.planH > 0 ? `${row.planH.toFixed(1)} h` : '–'}</td>
                              <td className="px-3 py-1.5 text-right font-mono text-orange-500 dark:text-orange-400">{row.istH > 0 ? `${row.istH.toFixed(1)} h` : '–'}</td>
                              {clickCell('planWork', row.planWork, 'text-blue-700 dark:text-blue-400')}
                              {clickCell('istWork',  row.istWork,  'text-orange-700 dark:text-orange-400')}
                              <td className={cn('px-3 py-1.5 text-right font-mono font-semibold', dc(row.diffWork))}>{row.diffWork === 0 ? '–' : `${row.diffWork > 0 ? '+' : ''}${fmtCHF(row.diffWork)}`}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-border bg-muted/30 font-bold text-xs">
                          <td className="px-3 py-2" colSpan={3}>Total</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-500 dark:text-blue-400">{pfixPerEmp.reduce((s,r)=>s+r.planH,0).toFixed(1)} h</td>
                          <td className="px-3 py-2 text-right font-mono text-orange-500 dark:text-orange-400">{pfixPerEmp.reduce((s,r)=>s+r.istH,0).toFixed(1)} h</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-700 dark:text-blue-400">{fmtCHF(pfixPerEmp.reduce((s, r) => s + r.planWork, 0))}</td>
                          <td className="px-3 py-2 text-right font-mono text-orange-700 dark:text-orange-400">{fmtCHF(pfixPerEmp.reduce((s, r) => s + r.istWork, 0))}</td>
                          <td className="px-3 py-2" />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </>
              )}
            </section>
          );
        })()}


        {/* ── Erklärung ────────────────────────────────────────────────────── */}
        <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20 p-3 text-xs text-blue-800 dark:text-blue-200">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <p>
            <strong>Personal FIX</strong>: Garantierter Monatslohn inkl. amortisiertem 13. Monatslohn.
            Mitarbeiter die im gewählten Monat austreten werden <em>pro rata</em> (Arbeitstage ÷ Monatstage) abgerechnet.
            Bereits ausgetretene Mitarbeiter werden ausgeblendet.{' '}
            <strong>Personal FLEX</strong>: Stunden × Stundenlohn.
            Wähle Plan- oder Ist-Stunden direkt aus dem Dienstplan — oder trage Stunden manuell ein.
          </p>
        </div>

        {/* ── FIX-Tabellen nach Abteilung ──────────────────────────────────── */}
        {Object.entries(byDept).map(([dept, rows]) => {
          const deptTotal   = rows.reduce((s, r) => s + r.cost, 0);
          const deptBase    = rows.reduce((s, r) => s + (r.emp.monthlySalary ?? 0), 0);
          const isCollapsed = expandedFixDepts.has(dept);
          const toggleDept  = () => setExpandedFixDepts(prev => {
            const next = new Set(prev);
            if (next.has(dept)) next.delete(dept); else next.add(dept);
            return next;
          });
          return (
            <section key={dept} className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
              <button
                onClick={toggleDept}
                className="w-full flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                aria-expanded={!isCollapsed}
              >
                <div className="flex items-center gap-2 text-sm font-semibold">
                  {DEPT_ICON[dept]}
                  {DEPT_LABEL[dept] ?? dept} — FIX
                  <Badge variant="secondary" className="text-xs">{rows.length}</Badge>
                  {isCollapsed && <span className="text-[10px] font-normal text-muted-foreground ml-1">(eingeklappt)</span>}
                </div>
                <div className="flex items-center gap-2 sm:gap-4 text-xs text-muted-foreground shrink-0">
                  <span className="hidden sm:inline whitespace-nowrap">Basis: <strong className="text-foreground font-mono">{fmtCHF(deptBase)}/Mt</strong></span>
                  <span className="whitespace-nowrap">FIX: <strong className="text-foreground font-mono">{fmtCHF(deptTotal)}/Mt</strong></span>
                  <ChevronDown className={cn('h-4 w-4 transition-transform duration-200', isCollapsed && '-rotate-90')} />
                </div>
              </button>

              {!isCollapsed && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[540px]">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border bg-muted/10">
                      <th className="text-left px-4 py-2 font-medium">Name</th>
                      <th className="text-left px-4 py-2 font-medium">Anstellung</th>
                      <th className="text-right px-4 py-2 font-medium">Basis-Lohn/Mt</th>
                      <th className="text-right px-4 py-2 font-medium">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help underline decoration-dotted">inkl. 13. /Mt</span>
                          </TooltipTrigger>
                          <TooltipContent>Monatslohn amortisiert inkl. 13. Monatslohn</TooltipContent>
                        </Tooltip>
                      </th>
                      <th className="text-right px-4 py-2 font-medium">FIX-Kosten/Mt</th>
                      <th className="text-right px-4 py-2 font-medium">FIX-Kosten/Jahr</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map(({ emp, cost, label, yearlyCost }) => {
                      const isSavingThis = saving === emp.id;
                      const isProRata = label !== null;
                      return (
                        <tr
                          key={emp.id}
                          className={cn('hover:bg-muted/30 transition-colors', isSavingThis && 'opacity-50')}
                        >
                          <td className="px-4 py-2.5 font-medium">
                            <div className="flex items-center gap-2">
                              {emp.name}
                              {isProRata && (
                                <span className="text-xs font-normal px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 whitespace-nowrap">
                                  {label}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge variant="outline" className="text-xs">{EMP_TYPE_LABEL[emp.employmentType]}</Badge>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {canEditEmployees ? (
                              <InlineSalaryEditor empId={emp.id} field="monthlySalary" value={emp.monthlySalary} onSaved={handleSaved} />
                            ) : (
                              <span className="font-mono text-sm">{emp.monthlySalary ? fmtCHFDec(emp.monthlySalary) : '–'}</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {canEditEmployees ? (
                              <InlineSalaryEditor empId={emp.id} field="monthlySalaryWith13th" value={emp.monthlySalaryWith13th} onSaved={handleSaved} />
                            ) : (
                              <span className="font-mono text-sm">{emp.monthlySalaryWith13th ? fmtCHFDec(emp.monthlySalaryWith13th) : '–'}</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right font-semibold font-mono text-blue-700 dark:text-blue-400">
                            {cost > 0
                              ? <span>{fmtCHF(cost)}{isProRata && <span className="text-xs font-normal text-amber-600 ml-1">*</span>}</span>
                              : <span className="text-muted-foreground">–</span>}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-muted-foreground text-sm">
                            {yearlyCost > 0 ? fmtCHF(yearlyCost) : '–'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/20 font-semibold border-t-2 border-border">
                      <td className="px-4 py-2.5 text-sm" colSpan={2}>Total {DEPT_LABEL[dept] ?? dept}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{fmtCHF(deptBase)}</td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        {fmtCHF(rows.reduce((s, r) => s + (r.emp.monthlySalaryWith13th ?? 0), 0))}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-blue-700 dark:text-blue-400">{fmtCHF(deptTotal)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{fmtCHF(rows.reduce((s, r) => s + r.yearlyCost, 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              )}
            </section>
          );
        })}



        {/* ── Gesamt-Total FIX + VARIABEL ──────────────────────────────────── */}
        {pfix.active.istTotalVar > 0 && (
          <div className="rounded-xl border-2 border-emerald-300 dark:border-emerald-700 bg-emerald-50/50 dark:bg-emerald-950/20 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-bold">
              <Users className="h-4 w-4 text-emerald-600" />
              Total Personal FIX + VARIABEL Ist{proRataDay !== null ? ` bis ${proRataDay}.` : ''} · {getMonthLabel(selectedYear, selectedMonth)}
            </div>
            <div className="flex flex-wrap items-center gap-6 text-sm">
              <span className="text-muted-foreground">
                FIX: <strong className="font-mono text-blue-700 dark:text-blue-300">{fmtCHF(pfix.active.fix)}</strong>
              </span>
              <span className="text-muted-foreground">+</span>
              <span className="text-muted-foreground">
                VARIABEL: <strong className="font-mono text-orange-700 dark:text-orange-400">{fmtCHF(pfix.active.istTotalVar)}</strong>
              </span>
              <span className="text-muted-foreground">=</span>
              <span className="text-emerald-700 dark:text-emerald-300 font-bold text-lg font-mono">{fmtCHF(pfix.active.istTotal)}/Mt</span>
              {personnelBudget > 0 && (() => {
                const budget = personnelBudget * (proRataDay !== null ? proRataFactor : 1);
                return (
                  <span className={cn(
                    'text-xs font-medium px-2 py-0.5 rounded-full',
                    pfix.active.istTotal <= budget
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                      : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
                  )}>
                    {pfix.active.istTotal <= budget ? '✓ im Budget' : `↑ ${fmtCHF(pfix.active.istTotal - budget)} über Budget`}
                  </span>
                );
              })()}
            </div>
          </div>
        )}


      </main>

      <FlexPeriodPopup
        target={flexPeriodPopup}
        employees={variableEmployees.map(e => ({ id: e.id, name: e.name, hourlyWage: e.hourlyWage ?? 0, weeklyHours: e.weeklyHours ?? 42 }))}
        onClose={() => setFlexPeriodPopup(null)}
      />
      <FlexBreakdownModal target={breakdown} onClose={() => setBreakdown(null)} />

      {/* ── KW-Detail-Popup (Fix + Flex pro Woche) ───────────────────────── */}
      {weekDetailTarget && (() => {
        const idx = flexByWeek.findIndex(w => w.weekKey === weekDetailTarget);
        const w   = flexByWeek[idx];
        const fix = fixByWeek[idx];
        if (!w || !fix) return null;
        const detailData: WeekDetailData = {
          weekLabel:   w.label,
          dateRange:   w.dateRange,
          dates:       w.dates,
          daysInWeek:  w.daysInWeek,
          daysInMonth: daysInSelectedMonth,
          fixEmps:     fix.empCosts,
          flexEmps:    variableEmployees.map(e => ({ id: e.id, name: e.name, hourlyWage: e.hourlyWage ?? 0 })),
          year:        selectedYear,
          month:       selectedMonth,
        };
        return <WeekDetailPopup data={detailData} onClose={() => setWeekDetailTarget(null)} />;
      })()}

      {/* ── Tag-Detail-Modal ──────────────────────────────────────────────── */}
      <Dialog open={dayDetailModal !== null} onOpenChange={open => { if (!open) setDayDetailModal(null); }}>
        <DialogContent className="max-w-sm">
          {dayDetailModal && (() => {
            const d             = dayDetailModal;
            const [, mm, dd]    = d.date.split('-');
            const dateLabel     = `${dd}.${mm}.${selectedYear}`;
            const pct           = d.diffPct ?? 0;
            const isRed         = pct > 20;
            const isOrange      = pct > 8 && pct <= 20;
            const isYellow      = d.diff > 0.01 && pct <= 8;

            // Per-day derived values
            const fixPerDay     = daysInSelectedMonth > 0 ? totalFixCost / daysInSelectedMonth : 0;
            const flexPlanAnteil = d.planWork;
            const gesamtPlanTag = fixPerDay + flexPlanAnteil;
            const budgetPerDay  = daysInSelectedMonth > 0 ? pfixBudget / daysInSelectedMonth : 0;
            const personalquote = budgetPerDay > 0 ? (gesamtPlanTag / budgetPerDay) * 100 : null;
            const planHours     = avgHourlyWage > 0 ? d.planWork / avgHourlyWage : null;
            const istHours      = avgHourlyWage > 0 ? d.istWork / avgHourlyWage : null;

            const verdictBg    = isRed
              ? 'bg-red-50/60 dark:bg-red-950/20 border-red-200 dark:border-red-800'
              : isOrange
                ? 'bg-amber-50/60 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800'
                : isYellow
                  ? 'bg-yellow-50/60 dark:bg-yellow-950/20 border-yellow-200 dark:border-yellow-800'
                  : 'bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800';
            const verdictColor = isRed ? 'text-red-700 dark:text-red-400'
              : isOrange ? 'text-amber-700 dark:text-amber-400'
              : isYellow ? 'text-yellow-700 dark:text-yellow-600'
              : 'text-emerald-700 dark:text-emerald-400';
            const verdictTitle = isRed
              ? '⛔ Kritisch — deutlich über Plan'
              : isOrange
                ? '⚠ Erhöht — über Planwert'
                : isYellow
                  ? '⚠ Leicht erhöht — im vertretbaren Bereich'
                  : '✓ Im Zielbereich';
            const verdictText = isRed
              ? 'Die Flex-Ist-Kosten überschreiten den Plan deutlich (> 20 %). Schichtlängen und Einsätze prüfen.'
              : isOrange
                ? 'Die Flex-Ist-Kosten liegen 8–20 % über Plan. Einsparpotenzial vorhanden.'
                : isYellow
                  ? 'Die Flex-Ist-Kosten liegen knapp über Plan (bis 8 %) — noch vertretbar.'
                  : 'Dieser Tag liegt im Zielbereich. Die Flex-Kosten entsprechen dem Plan oder sind darunter.';
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="text-base">Tagesdetail — {dateLabel}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3 pt-1">

                  {/* Planungsstruktur des Tages */}
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Planung</p>
                    <div className="rounded-lg border border-border bg-muted/20 divide-y divide-border text-sm">
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-muted-foreground">Personalbudget (anteilig)</span>
                        <span className="font-mono font-semibold">{fmtCHF(budgetPerDay)}</span>
                      </div>
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-muted-foreground">FIX Anteil (Tagesmittel)</span>
                        <span className="font-mono text-blue-700 dark:text-blue-400">{fmtCHF(fixPerDay)}</span>
                      </div>
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-muted-foreground">Flex Plan Anteil</span>
                        <span className="font-mono">{fmtCHF(flexPlanAnteil)}</span>
                      </div>
                      <div className="flex justify-between px-3 py-2 font-semibold">
                        <span className="text-muted-foreground">Geplante Personalkosten</span>
                        <span className="font-mono">{fmtCHF(gesamtPlanTag)}</span>
                      </div>
                      {personalquote !== null && (
                        <div className="flex justify-between px-3 py-2">
                          <span className="text-muted-foreground">Personalquote (Plan)</span>
                          <span className={cn('font-mono font-semibold',
                            personalquote > 105 ? 'text-red-600 dark:text-red-400'
                              : personalquote > 95 ? 'text-amber-600 dark:text-amber-400'
                              : 'text-emerald-600 dark:text-emerald-400')}>
                            {personalquote.toFixed(1)} %
                          </span>
                        </div>
                      )}
                      {planHours !== null && (
                        <div className="flex justify-between px-3 py-2">
                          <span className="text-muted-foreground">Geplante Flex-Stunden</span>
                          <span className="font-mono">{planHours.toFixed(1)} h</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Plan vs. Ist Abweichung */}
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Plan vs. Ist (Flex)</p>
                    <div className="rounded-lg border border-border bg-muted/20 divide-y divide-border text-sm">
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-muted-foreground">Flex Plan</span>
                        <span className="font-mono">{fmtCHF(d.planWork)}</span>
                      </div>
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-muted-foreground">Flex Ist</span>
                        <span className="font-mono text-orange-700 dark:text-orange-400">{fmtCHF(d.istWork)}</span>
                      </div>
                      {istHours !== null && (
                        <div className="flex justify-between px-3 py-2">
                          <span className="text-muted-foreground">Flex-Stunden Ist</span>
                          <span className="font-mono">{istHours.toFixed(1)} h</span>
                        </div>
                      )}
                      <div className="flex justify-between px-3 py-2 font-bold">
                        <span className="text-muted-foreground">Budgetabweichung</span>
                        <span className={cn('font-mono', verdictColor)}>
                          {d.diff > 0.01 ? '+' : d.diff < -0.01 ? '−' : '±'}
                          {fmtCHF(Math.abs(d.diff))}
                          {d.diffPct !== null && ` (${d.diffPct > 0 ? '+' : ''}${d.diffPct.toFixed(1)} %)`}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Bewertung */}
                  <div className={cn('rounded-lg border px-3 py-2.5', verdictBg)}>
                    <p className={cn('text-sm font-bold', verdictColor)}>{verdictTitle}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{verdictText}</p>
                  </div>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
