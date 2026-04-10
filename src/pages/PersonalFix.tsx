import { useState, useMemo, useEffect, useCallback } from 'react';
import HourBalanceSection from '@/components/hour-balance/HourBalanceSection';
import { buildHourBalances, generatePlanningHints } from '@/lib/hour-balance-utils';
import { Navigate } from 'react-router-dom';
import {
  DollarSign, Users, BookOpen, TrendingUp, ChefHat,
  Utensils, Edit2, Check, X, Info, Building2, AlertCircle, Clock,
  ChevronLeft, ChevronRight, Calendar, BarChart2, Lightbulb, Target,
  Repeat, FileText, Download,
} from 'lucide-react';
import { exportPersonalFixToPDF, exportVarKostenvergleich } from '@/lib/personalfix-export';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { loadEmployees, upsertEmployee, loadActualHoursForMonth } from '@/lib/supabase-db';
import { Employee } from '@/types/personnel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePermissions } from '@/hooks/usePermissions';
import { useBudgetMonth } from '@/hooks/useBudgetMonth';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';

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
 * Logik:
 * - Kein Austrittsdatum → voller Monatslohn
 * - Austritt vor diesem Monat → CHF 0, Mitarbeiter wird ausgeblendet
 * - Austritt IM Monat → Lohn × (gearbeitete Tage / Tage im Monat)
 * - Austritt nach diesem Monat → voller Monatslohn
 */
function getProRataFixCost(
  emp: Employee, year: number, month: number
): { cost: number; label: string | null; excluded: boolean } {
  const full = getFixCost(emp);
  if (!full) return { cost: 0, label: null, excluded: false };
  if (!emp.employmentEndDate) return { cost: full, label: null, excluded: false };

  const exit = new Date(emp.employmentEndDate + 'T00:00:00');
  const ey = exit.getFullYear();
  const em = exit.getMonth() + 1;

  if (ey < year || (ey === year && em < month)) {
    return { cost: 0, label: 'Ausgetreten', excluded: true };
  }
  if (ey === year && em === month) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const daysWorked = exit.getDate();
    const factor = daysWorked / daysInMonth;
    const cost = Math.round(full * factor * 100) / 100;
    const dd = String(exit.getDate()).padStart(2, '0');
    const mm = String(em).padStart(2, '0');
    return { cost, label: `Pro rata bis ${dd}.${mm}.`, excluded: false };
  }
  return { cost: full, label: null, excluded: false };
}

/**
 * Jahreskosten-Berechnung für den Fixlohn eines Mitarbeiters.
 *
 * Formel für das gewählte Jahr:
 *   - Austritt vor dem Jahr           → 0
 *   - Austritt nach dem Jahr / kein Datum → Monatslohn × 12
 *   - Austritt IM Jahr               →
 *       (Austrittsmonat − 1) × volles Monatslohn    [alle vollen Monate davor]
 *     + Monatslohn × (Austrittsstag / Tage im Monat) [Pro-rata Austrittsmonat]
 *
 * Beispiel: David, Austritt 04.03.2026, Monatslohn CHF 4 000
 *   Jan (voll) + Feb (voll) + Mär (pro rata 4/31)
 *   = 2 × 4 000 + 4 000 × (4/31) = 8 000 + 516.13 = CHF 8 516
 */
function getYearlyFixCost(emp: Employee, year: number): number {
  const full = getFixCost(emp);
  if (!full) return 0;
  if (!emp.employmentEndDate) return full * 12;

  const exit = new Date(emp.employmentEndDate + 'T00:00:00');
  const ey = exit.getFullYear();
  const em = exit.getMonth() + 1; // 1-based
  const ed = exit.getDate();

  if (ey < year) return 0;               // schon vor dem Jahr ausgetreten
  if (ey > year) return full * 12;       // tritt erst nach dem Jahr aus

  // Austritt im gewählten Jahr
  const fullMonths  = em - 1;                               // Jan … (Austrittsmonat-1)
  const daysInExitMonth = new Date(year, em, 0).getDate();  // Tage im Austrittsmonat
  const proRata     = full * (ed / daysInExitMonth);
  return Math.round((fullMonths * full + proRata) * 100) / 100;
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
function loadPlanHoursFromStorage(year: number, month: number): Record<string, number> {
  const key = `schedule-v2-${year}-${String(month).padStart(2, '0')}`;
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
function loadFerienDaysFromStorage(year: number, month: number): Record<string, number> {
  const key = `actual-hours-${year}-${String(month).padStart(2, '0')}`;
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
function loadFerienDaysFromPlanStorage(year: number, month: number): Record<string, number> {
  const key = `schedule-v2-${year}-${String(month).padStart(2, '0')}`;
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
function loadIstHoursFromStorage(year: number, month: number): Record<string, number> {
  const key = `actual-hours-${year}-${String(month).padStart(2, '0')}`;
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
function loadVarHours(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(VAR_HOURS_KEY) ?? '{}'); }
  catch { return {}; }
}
function saveVarHours(data: Record<string, number>) {
  localStorage.setItem(VAR_HOURS_KEY, JSON.stringify(data));
}

// ── Wöchentliches Basismodell (Std/Wo, Tage/Wo) ───────────────────────────────

interface WeeklyBaseline { hours?: number; days?: number; }
const VAR_WEEKLY_KEY = 'personal_fix_weekly_v1';

function loadVarWeekly(): Record<string, WeeklyBaseline> {
  try { return JSON.parse(localStorage.getItem(VAR_WEEKLY_KEY) ?? '{}'); }
  catch { return {}; }
}
function saveVarWeekly(data: Record<string, WeeklyBaseline>) {
  localStorage.setItem(VAR_WEEKLY_KEY, JSON.stringify(data));
}

/** Durchschnittliche Wochen pro Monat */
const WEEKS_PER_MONTH = 4.333;

// ── Tagessatz (Tages-Pauschale) ────────────────────────────────────────────────

type PricingMode = 'hourly' | 'daily';

interface DayRateData { ratePerDay: number; daysPerWeek?: number; daysPerMonth?: number; }

const VAR_PRICING_MODE_KEY = 'personal_fix_pricing_mode_v1';
function loadVarPricingMode(): Record<string, PricingMode> {
  try { return JSON.parse(localStorage.getItem(VAR_PRICING_MODE_KEY) ?? '{}'); }
  catch { return {}; }
}
function saveVarPricingMode(data: Record<string, PricingMode>) {
  localStorage.setItem(VAR_PRICING_MODE_KEY, JSON.stringify(data));
}

const VAR_DAYRATE_KEY = 'personal_fix_dayrate_v1';
function loadVarDayRate(): Record<string, DayRateData> {
  try { return JSON.parse(localStorage.getItem(VAR_DAYRATE_KEY) ?? '{}'); }
  catch { return {}; }
}
function saveVarDayRate(data: Record<string, DayRateData>) {
  localStorage.setItem(VAR_DAYRATE_KEY, JSON.stringify(data));
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

// ── Hauptseite ────────────────────────────────────────────────────────────────

export default function PersonalFixPage() {
  const { isAdmin } = usePermissions();
  if (!isAdmin) return <Navigate to="/personal" replace />;

  const today = new Date();
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [varHours, setVarHours] = useState<Record<string, number>>(() => loadVarHours());
  const [varWeekly, setVarWeekly] = useState<Record<string, WeeklyBaseline>>(() => loadVarWeekly());
  const [varPricingMode, setVarPricingMode] = useState<Record<string, PricingMode>>(() => loadVarPricingMode());
  const [varDayRate, setVarDayRate] = useState<Record<string, DayRateData>>(() => loadVarDayRate());
  const [varView, setVarView] = useState<VarView>('plan');
  const [planHours, setPlanHours] = useState<Record<string, number>>({});
  const [istHours, setIstHours] = useState<Record<string, number>>({});
  // empId → Anzahl FE-Tage im Ist (absenceType='FE' in actual-hours-* localStorage)
  const [ferienIstDays, setFerienIstDays] = useState<Record<string, number>>({});
  // empId → Anzahl FE-Tage im PLAN (frühAbsence/spätAbsence='FE' in schedule-v2-* localStorage)
  const [ferienPlanDays, setFerienPlanDays] = useState<Record<string, number>>({});

  // ── Pro-Rata-Abgrenzung ────────────────────────────────────────────────────
  // null = aus; Zahl = Stichtag (1–letzter Tag des Monats)
  const [proRataDay, setProRataDay] = useState<number | null>(null);

  useEffect(() => {
    loadEmployees().then(emps => {
      if (emps) setEmployees(emps);
      setLoading(false);
    });
  }, []);

  // Reload Plan/Ist hours whenever month changes.
  // Ist-Stunden: read localStorage first (fast), then enrich with Supabase data.
  // Supabase is the canonical source when both planners write there; localStorage
  // is the fallback/cache for entries that haven't round-tripped through Supabase.
  useEffect(() => {
    setPlanHours(loadPlanHoursFromStorage(selectedYear, selectedMonth));
    // FE-Ferientage immer aus localStorage (Supabase speichert kein absenceType)
    const istFE = loadFerienDaysFromStorage(selectedYear, selectedMonth);
    setFerienIstDays(istFE);
    const planFE = loadFerienDaysFromPlanStorage(selectedYear, selectedMonth);
    setFerienPlanDays(planFE);
    console.log(`[FERIEN] preserved on reload: ist=${Object.values(istFE).reduce((s, v) => s + v, 0)} plan=${Object.values(planFE).reduce((s, v) => s + v, 0)} FE-Tage gesamt`);

    // Fast local read first
    const localIst = loadIstHoursFromStorage(selectedYear, selectedMonth);
    setIstHours(localIst);

    // Then enrich with Supabase (async)
    const monthDate = new Date(selectedYear, selectedMonth - 1, 1);
    loadActualHoursForMonth(monthDate).then(supabaseRaw => {
      if (!supabaseRaw) return; // Supabase error – keep local result
      // Aggregate by empId (same logic as loadIstHoursFromStorage)
      const supabaseAgg: Record<string, number> = {};
      for (const [cellKey, entry] of Object.entries(supabaseRaw)) {
        const empId = cellKey.slice(0, cellKey.length - 11);
        if (!empId) continue;
        const h = entry?.hours ?? 0;
        if (h > 0) supabaseAgg[empId] = (supabaseAgg[empId] ?? 0) + Math.round(h * 100) / 100;
      }
      // Merge: Supabase wins on conflict
      const merged = { ...localIst, ...supabaseAgg };
      const totalH = Object.values(merged).reduce((s, h) => s + h, 0);
      console.log(
        `[IST] personal-fix rows loaded (merged): ${Object.keys(merged).length} Mitarbeiter / ${Math.round(totalH * 10) / 10} h`,
        { localStorage: Object.keys(localIst).length, supabase: Object.keys(supabaseAgg).length },
      );
      setIstHours(merged);

      // Write merged back to localStorage — smart merge: FE/K/F absenceType entries must NEVER be
      // overwritten by Supabase data (Supabase has no absenceType column; FE are localStorage-only).
      if (Object.keys(supabaseRaw).length > 0) {
        const monthKey = `actual-hours-${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
        const existingLocal: Record<string, unknown> = (() => {
          try { return JSON.parse(localStorage.getItem(monthKey) || '{}'); } catch { return {}; }
        })();
        // Start from local (preserves absenceType metadata), let Supabase win only for real hours
        const mergedRaw: Record<string, unknown> = { ...existingLocal };
        let fePreserved = 0;
        for (const [key, val] of Object.entries(supabaseRaw)) {
          const localEntry = mergedRaw[key] as Record<string, unknown> | undefined;
          if ((val as { hours?: number })?.hours > 0 || !localEntry?.absenceType) {
            // Supabase wins: real working hours OR no FE in local
            mergedRaw[key] = val;
          } else {
            // Local FE/K/F entry protected — Supabase must not erase it
            fePreserved++;
            console.log(`[FERIEN] preserved on navigation: ${key} absenceType=${localEntry?.absenceType}`);
          }
        }
        if (fePreserved > 0) {
          console.log(`[FERIEN] PersonalFix load: preserved ${fePreserved} FE/K/F entries`);
        }
        localStorage.setItem(monthKey, JSON.stringify(mergedRaw));
        console.log(`[FERIEN] saved persistently: source=supabase+local merged=${Object.keys(mergedRaw).length}`);
      }
    }).catch(err => console.error('[IST] Supabase load failed in PersonalFix:', err));
  }, [selectedYear, selectedMonth]);

  const budgetData = useBudgetMonth(selectedYear, selectedMonth);
  const personnelBudget = budgetData.personnelBudget;

  const handleVarHoursChange = useCallback((empId: string, hours: number) => {
    setVarHours(prev => {
      const next = { ...prev, [empId]: hours };
      saveVarHours(next);
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
      saveVarWeekly(next);
      return next;
    });
  }, []);

  const handlePricingModeToggle = useCallback((empId: string) => {
    setVarPricingMode(prev => {
      const current = prev[empId] ?? 'hourly';
      const next = { ...prev, [empId]: current === 'hourly' ? 'daily' : 'hourly' as PricingMode };
      saveVarPricingMode(next);
      return next;
    });
  }, []);

  const handleDayRateChange = useCallback((empId: string, field: keyof DayRateData, val: number | undefined) => {
    setVarDayRate(prev => {
      const existing = prev[empId] ?? { ratePerDay: 0 };
      const next = { ...prev, [empId]: { ...existing, [field]: val ?? 0 } };
      saveVarDayRate(next);
      return next;
    });
  }, []);

  const handleHourlyWageSaved = useCallback(async (empId: string, val: number) => {
    setSaving(empId);
    const emp = employees.find(e => e.id === empId);
    if (!emp) { setSaving(null); return; }
    const updated: Employee = { ...emp, hourlyWage: val };
    await upsertEmployee(updated);
    setEmployees(prev => prev.map(e => e.id === empId ? updated : e));
    setSaving(null);
  }, [employees]);

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
    await upsertEmployee(updated);
    setEmployees(prev => prev.map(e => e.id === empId ? updated : e));
    setSaving(null);
  };

  // ── Sortierte Listen ───────────────────────────────────────────────────────

  const fixedEmployees = useMemo(() =>
    employees.filter(hasFixedSalary).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [employees],
  );

  const variableEmployees = useMemo(() =>
    employees.filter(e => !hasFixedSalary(e)).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [employees],
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
    fixedEmployees.map(emp => ({
      emp,
      ...getProRataFixCost(emp, selectedYear, selectedMonth),
      yearlyCost: getYearlyFixCost(emp, selectedYear),
    })),
    [fixedEmployees, selectedYear, selectedMonth],
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

  const totalVarArbeitCHF = totalVarCost;           // FE hat hours=0 → nicht in Var-Kosten
  // Ferienabbau reduziert die variablen Kosten (Abzug, da Ferien keine Arbeitsstunden sind)
  const totalVariabelCHF  = Math.max(0, totalVarCost - totalFerienabbauCHF);

  // ── Pro-Rata-Berechnungen ──────────────────────────────────────────────────
  const daysInSelectedMonth = new Date(selectedYear, selectedMonth, 0).getDate();
  const proRataFactor = proRataDay !== null
    ? Math.min(proRataDay, daysInSelectedMonth) / daysInSelectedMonth
    : 1;
  const proRataFixCost      = totalFixCost          * proRataFactor;
  const proRataVarCost      = totalVariabelCHF      * proRataFactor;
  const proRataTotal        = (totalFixCost + totalVariabelCHF) * proRataFactor;
  const proRataBudget       = personnelBudget        * proRataFactor;
  const proRataAvailableVar = personnelBudget > 0
    ? Math.max(0, proRataBudget - proRataFixCost) : 0;
  const proRataVarArbeit    = totalVarArbeitCHF     * proRataFactor;
  const proRataFerienabbau  = totalFerienabbauCHF   * proRataFactor;
  const proRataVarDelta     = personnelBudget > 0
    ? proRataAvailableVar - proRataVarArbeit : 0;
  const proRataVarOverrun   = proRataVarDelta < 0;

  // Pro-Rata pro variablen Mitarbeiter (für UI-Tabelle + Export)
  // ferienCHF: IST-Basis im Ist-Modus, PLAN-Basis im Plan/Manuell-Modus
  const proRataVarByEmp = useMemo(() => {
    return variableEmployees.map(emp => {
      const monthlyCost = getVarMonthlyCostFor(emp.id, emp);
      const ferienCHF   = varView === 'ist' ? getEmpFerienCHF(emp) : getEmpFerienPlanCHF(emp);
      const netCost     = Math.max(0, monthlyCost - ferienCHF);
      return {
        name:         emp.name,
        dept:         emp.department ?? '–',
        hours:        getVarHoursFor(emp.id),
        monthlyCost:  netCost,
        proRataCost:  netCost * proRataFactor,
        ferienCHF,
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
      const variabel    = Math.max(0, varArbeit - ferienabbau);
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
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <DollarSign className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <h1 className="text-base font-bold leading-tight">Personal FIX + VARIABEL</h1>
              <p className="text-xs text-muted-foreground">Lohnkosten-Übersicht & Hochrechnung</p>
            </div>
          </div>

          {/* PDF Export Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportPDF}
            className="h-8 gap-1.5 text-xs border-rose-200 text-rose-700 hover:bg-rose-50 hover:border-rose-300 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950/30"
          >
            <FileText className="h-3.5 w-3.5" />
            PDF Export
          </Button>

          {/* Monatsnavigation */}
          <div className="flex items-center gap-1.5 bg-muted/40 rounded-lg px-2 py-1">
            <Button
              size="icon" variant="ghost"
              className="h-7 w-7"
              onClick={() => { const [y, m] = prevMonth(selectedYear, selectedMonth); setSelectedYear(y); setSelectedMonth(m); }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1.5 min-w-[130px] justify-center">
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
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">

        {/* ── KPI-Zusammenfassung ──────────────────────────────────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <KpiCard
            title="Personal FIX / Monat"
            value={fmtCHF(totalFixCost)}
            sub={`${activeFixedEmployees.length} Mitarbeiter mit Fixlohn`}
            icon={<DollarSign className="h-5 w-5" />}
            color="blue"
          />
          <KpiCard
            title="Variable Arbeit / Monat"
            value={fmtCHF(totalVarArbeitCHF)}
            sourceBadge={varView === 'plan' ? '● Plan-Stunden' : varView === 'ist' ? '● Ist-Stunden' : '● Manuell'}
            sub={totalVarHours > 0
              ? `${Math.round(totalVarHours * 10) / 10} h × Stundenlohn`
              : `${variableEmployees.length} MA · Stunden wählen ↓`}
            icon={<Clock className="h-5 w-5" />}
            color={totalVarArbeitCHF > 0 ? 'orange' : 'default'}
          />
          <KpiCard
            title="Total Personal / Monat"
            value={fmtCHF(totalFixCost + totalVariabelCHF)}
            sub={totalFerienabbauCHF > 0
              ? `FIX + Variabel − ${fmtCHF(totalFerienabbauCHF)} Ferienabbau`
              : 'FIX + VARIABEL'}
            icon={<Users className="h-5 w-5" />}
            color={totalFixCost + totalVariabelCHF > 0 ? 'green' : 'default'}
          />
        </div>

        {/* ── Pro-Rata-Abgrenzung ──────────────────────────────────────────── */}
        <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Target className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Pro-Rata-Abgrenzung</span>
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
                    // Standard: heutiger Tag wenn aktueller Monat, sonst letzter Tag
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

          {proRataDay !== null && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg border bg-muted/30 p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">FIX bis {proRataDay}.</p>
                  <p className="text-xl font-bold tabular-nums text-blue-600">{fmtCHF(proRataFixCost)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">von {fmtCHF(totalFixCost)}</p>
                </div>
                <div className="rounded-lg border bg-muted/30 p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">VARIABEL bis {proRataDay}.</p>
                  <p className="text-xl font-bold tabular-nums text-orange-600">{fmtCHF(proRataVarCost)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">von {fmtCHF(totalVariabelCHF)}</p>
                </div>
                <div className="rounded-lg border bg-primary/5 border-primary/20 p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Total bis {proRataDay}.</p>
                  <p className="text-xl font-bold tabular-nums text-primary">{fmtCHF(proRataTotal)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">von {fmtCHF(totalFixCost + totalVariabelCHF)}</p>
                </div>
              </div>
              {/* Variable Mitarbeiter-Auflistung pro rata */}
              {proRataVarByEmp.length > 0 && (
                <div className="rounded-lg border border-border overflow-hidden">
                  <div className="px-3 py-2 bg-orange-50 dark:bg-orange-950/20 border-b border-orange-100 dark:border-orange-900">
                    <p className="text-xs font-semibold text-orange-700 dark:text-orange-400 uppercase tracking-wide">
                      Variable Kosten pro Mitarbeiter — bis {proRataDay}. ({Math.round(proRataFactor * 100)} %)
                    </p>
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/30 border-b border-border">
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">Name</th>
                        <th className="px-3 py-2 text-center font-medium text-muted-foreground">Abt.</th>
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">Stunden</th>
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">Netto/Mt</th>
                        <th className="px-3 py-2 text-right font-medium text-muted-foreground">bis {proRataDay}.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {proRataVarByEmp.map((row, i) => (
                        <tr key={i} className={i % 2 === 0 ? 'bg-background' : 'bg-muted/20'}>
                          <td className="px-3 py-1.5 font-medium">{row.name}</td>
                          <td className="px-3 py-1.5 text-center text-muted-foreground capitalize">{row.dept}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                            {row.hours > 0 ? `${Math.round(row.hours * 10) / 10} h` : '–'}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono">
                            {fmtCHF(row.monthlyCost)}
                            {row.ferienCHF > 0 && (
                              <span className="ml-1 text-blue-500 text-[10px]">−{fmtCHF(row.ferienCHF)} FE</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono font-semibold text-orange-700 dark:text-orange-400">
                            {fmtCHF(row.proRataCost)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-orange-200 dark:border-orange-800 bg-orange-50/50 dark:bg-orange-950/20">
                        <td className="px-3 py-2 font-bold text-orange-800 dark:text-orange-300" colSpan={3}>Total Variable</td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-orange-800 dark:text-orange-300">{fmtCHF(totalVariabelCHF)}</td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-orange-700 dark:text-orange-400">{fmtCHF(proRataVarCost)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}

          {proRataDay === null && (
            <p className="text-xs text-muted-foreground">
              Berechnet die aufgelaufenen Personalkosten bis zu einem bestimmten Tag des Monats.
              Formel: Monatskosten × (Stichtag ÷ {daysInSelectedMonth} Tage).
            </p>
          )}
        </div>

        {/* ── Pro-Rata Vollansicht ──────────────────────────────────────────── */}
        {proRataDay !== null && (
          <>
            {/* Pro-Rata KPI-Karten */}
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <KpiCard
                title={`Personal FIX — bis ${proRataDay}.`}
                value={fmtCHF(proRataFixCost)}
                sub={`von ${fmtCHF(totalFixCost)} / Monat (${Math.round(proRataFactor * 100)} %)`}
                icon={<DollarSign className="h-5 w-5" />}
                color="blue"
              />
              <KpiCard
                title={`Variable Arbeit — bis ${proRataDay}.`}
                value={fmtCHF(proRataVarArbeit)}
                sourceBadge={varView === 'plan' ? '● Plan-Stunden' : varView === 'ist' ? '● Ist-Stunden' : '● Manuell'}
                sub={`von ${fmtCHF(totalVarArbeitCHF)} / Monat (${Math.round(proRataFactor * 100)} %)`}
                icon={<Clock className="h-5 w-5" />}
                color={proRataVarArbeit > 0 ? 'orange' : 'default'}
              />
              <KpiCard
                title={`Total Personal — bis ${proRataDay}.`}
                value={fmtCHF(proRataTotal)}
                sub={proRataFerienabbau > 0
                  ? `FIX + Variabel − ${fmtCHF(proRataFerienabbau)} Ferienabbau`
                  : `von ${fmtCHF(totalFixCost + totalVariabelCHF)} / Monat`}
                icon={<Users className="h-5 w-5" />}
                color={proRataTotal > 0 ? 'green' : 'default'}
              />
            </div>

            {/* Pro-Rata Budget-Planung */}
            {personnelBudget > 0 && (
              <section className="rounded-xl border-2 border-violet-200 dark:border-violet-800 bg-card shadow-sm overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-violet-50/40 dark:bg-violet-950/20">
                  <Target className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                  <span className="text-sm font-bold">
                    Budget-Planung Personal — bis {proRataDay}. {getMonthLabel(selectedYear, selectedMonth)}
                  </span>
                  <Badge variant="secondary" className="text-xs tabular-nums ml-auto">
                    {proRataDay}/{daysInSelectedMonth} · {Math.round(proRataFactor * 100)} % Pro-Rata
                  </Badge>
                </div>

                <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Budgetverteilung pro rata */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Budgetverteilung</p>
                    <div className="flex justify-between items-center py-1.5 border-b border-dashed border-border">
                      <span className="text-sm text-muted-foreground">Personalbudget gesamt</span>
                      <span className="font-mono font-semibold">{fmtCHF(proRataBudget)}</span>
                    </div>
                    <div className="flex justify-between items-baseline py-1.5 border-b border-dashed border-border">
                      <span className="text-sm text-muted-foreground">− Personal FIX</span>
                      <span className="font-mono text-blue-700 dark:text-blue-400 shrink-0">− {fmtCHF(proRataFixCost)}</span>
                    </div>
                    <div className={cn(
                      'flex justify-between items-center py-2 px-3 rounded-lg',
                      proRataAvailableVar > 0
                        ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
                        : 'bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300'
                    )}>
                      <span className="text-sm font-bold">= Verfügbar für Variabel</span>
                      <span className="font-mono font-bold text-base">{fmtCHF(proRataAvailableVar)}</span>
                    </div>
                  </div>

                  {/* Schätzung vs. Budget pro rata */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Schätzung vs. Budget</p>
                    <div className="flex justify-between items-center py-1.5 border-b border-dashed border-border">
                      <span className="text-sm text-muted-foreground">Verfügbar für Variabel</span>
                      <span className="font-mono font-semibold">{fmtCHF(proRataAvailableVar)}</span>
                    </div>
                    <div className="flex justify-between items-baseline gap-2 py-1.5 border-b border-dashed border-border">
                      <div className="flex items-center gap-1.5 flex-wrap text-sm text-muted-foreground">
                        <span className="whitespace-nowrap">− Variable Arbeit</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 whitespace-nowrap">
                          {varView === 'plan' ? 'Plan' : varView === 'ist' ? 'Ist' : 'Manuell'}
                        </span>
                      </div>
                      <span className="font-mono text-orange-700 dark:text-orange-400 shrink-0">− {fmtCHF(proRataVarArbeit)}</span>
                    </div>
                    {proRataFerienabbau > 0 && (
                      <div className="flex justify-between items-baseline gap-2 py-1.5 border-b border-dashed border-border">
                        <span className="text-sm text-muted-foreground">
                          + Ferienabbau-Abzug (FE {varView === 'ist' ? 'Ist' : 'Plan'})
                        </span>
                        <span className="font-mono text-blue-600 dark:text-blue-400 shrink-0">− {fmtCHF(proRataFerienabbau)}</span>
                      </div>
                    )}
                    {proRataFerienabbau > 0 && (
                      <div className="flex justify-between items-baseline gap-2 py-1 border-b border-dashed border-border">
                        <span className="text-sm font-medium text-muted-foreground">= Netto Variabel</span>
                        <span className="font-mono font-semibold text-orange-800 dark:text-orange-300 shrink-0">{fmtCHF(proRataVarCost)}</span>
                      </div>
                    )}
                    <div className={cn(
                      'flex justify-between items-center py-2 px-3 rounded-lg',
                      !proRataVarOverrun
                        ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
                        : 'bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300'
                    )}>
                      <span className="text-sm font-bold">
                        {proRataVarOverrun ? '⚠ Überziehung' : '✓ Verbleibend'}
                      </span>
                      <span className="font-mono font-bold text-base">
                        {proRataVarOverrun ? '– ' : '+ '}{fmtCHF(Math.abs(proRataVarDelta))}
                      </span>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* Pro-Rata Personalkosten-Übersicht nach Abteilung */}
            {deptSummary.length > 0 && (
              <section className="rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-card shadow-sm overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/20">
                  <BarChart2 className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-bold">
                    Personalkosten nach Abteilung — bis {proRataDay}. {getMonthLabel(selectedYear, selectedMonth)}
                  </span>
                  <Badge variant="secondary" className="text-xs tabular-nums ml-auto">
                    {Math.round(proRataFactor * 100)} % Pro-Rata
                  </Badge>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground border-b border-border bg-muted/10">
                        <th className="text-left px-4 py-2 font-medium">Kategorie</th>
                        {deptSummary.map(ds => (
                          <th key={ds.dept} className="text-right px-4 py-2 font-medium">
                            <div className="flex items-center justify-end gap-1.5">
                              {DEPT_ICON[ds.dept]}
                              {DEPT_LABEL[ds.dept] ?? ds.dept}
                            </div>
                          </th>
                        ))}
                        <th className="text-right px-4 py-2 font-medium">Gesamt</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      <tr className="hover:bg-muted/20">
                        <td className="px-4 py-2.5 font-medium text-blue-700 dark:text-blue-400">FIX</td>
                        {deptSummary.map(ds => (
                          <td key={ds.dept} className="px-4 py-2.5 text-right font-mono text-blue-700 dark:text-blue-400">
                            {ds.fix > 0 ? fmtCHF(ds.fix * proRataFactor) : <span className="text-muted-foreground">–</span>}
                          </td>
                        ))}
                        <td className="px-4 py-2.5 text-right font-mono font-semibold text-blue-700 dark:text-blue-400">
                          {fmtCHF(proRataFixCost)}
                        </td>
                      </tr>
                      <tr className="hover:bg-muted/20">
                        <td className="px-4 py-2.5 font-medium text-orange-700 dark:text-orange-400">VARIABLE ARBEIT</td>
                        {deptSummary.map(ds => (
                          <td key={ds.dept} className="px-4 py-2.5 text-right font-mono text-orange-700 dark:text-orange-400">
                            {ds.varArbeit > 0 ? fmtCHF(ds.varArbeit * proRataFactor) : <span className="text-muted-foreground">–</span>}
                          </td>
                        ))}
                        <td className="px-4 py-2.5 text-right font-mono font-semibold text-orange-700 dark:text-orange-400">
                          {fmtCHF(proRataVarArbeit)}
                        </td>
                      </tr>
                      {totalFerienabbauCHF > 0 && (
                        <tr className="hover:bg-muted/20 bg-blue-50/30 dark:bg-blue-950/10">
                          <td className="px-4 py-2.5 font-medium text-blue-600 dark:text-blue-400">
                            − FERIENABBAU <span className="text-[10px] font-normal opacity-70">({varView === 'ist' ? 'Ist' : 'Plan'})</span>
                          </td>
                          {deptSummary.map(ds => (
                            <td key={ds.dept} className="px-4 py-2.5 text-right font-mono text-blue-600 dark:text-blue-400">
                              {ds.ferienabbau > 0 ? `− ${fmtCHF(ds.ferienabbau * proRataFactor)}` : <span className="text-muted-foreground">–</span>}
                            </td>
                          ))}
                          <td className="px-4 py-2.5 text-right font-mono font-semibold text-blue-600 dark:text-blue-400">
                            {proRataFerienabbau > 0 ? `− ${fmtCHF(proRataFerienabbau)}` : <span className="text-muted-foreground">–</span>}
                          </td>
                        </tr>
                      )}
                      <tr className="hover:bg-muted/20 border-t border-orange-200 dark:border-orange-800">
                        <td className="px-4 py-2.5 font-semibold text-orange-800 dark:text-orange-300">TOTAL VARIABEL</td>
                        {deptSummary.map(ds => (
                          <td key={ds.dept} className="px-4 py-2.5 text-right font-mono font-semibold text-orange-800 dark:text-orange-300">
                            {ds.variabel > 0 ? fmtCHF(ds.variabel * proRataFactor) : <span className="text-muted-foreground">–</span>}
                          </td>
                        ))}
                        <td className="px-4 py-2.5 text-right font-mono font-bold text-orange-800 dark:text-orange-300">
                          {fmtCHF(proRataVarCost)}
                        </td>
                      </tr>
                    </tbody>
                    <tfoot>
                      <tr className="bg-emerald-50/50 dark:bg-emerald-950/20 border-t-2 border-emerald-300 dark:border-emerald-700">
                        <td className="px-4 py-2.5 font-bold text-emerald-800 dark:text-emerald-300">TOTAL PERSONAL</td>
                        {deptSummary.map(ds => (
                          <td key={ds.dept} className="px-4 py-2.5 text-right font-mono font-bold text-emerald-700 dark:text-emerald-400">
                            {fmtCHF(ds.total * proRataFactor)}
                          </td>
                        ))}
                        <td className="px-4 py-2.5 text-right font-mono font-bold text-emerald-800 dark:text-emerald-300">
                          {fmtCHF(proRataTotal)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>
            )}
          </>
        )}

        {/* ── Budget-Vergleich ─────────────────────────────────────────────── */}
        {personnelBudget > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <KpiCard
              title="FIX vs. Budget / Monat"
              value={fmtCHF(totalFixCost - personnelBudget)}
              sub={totalFixCost <= personnelBudget
                ? `FIX liegt ${fmtCHF(personnelBudget - totalFixCost)} unter Budget`
                : `FIX übersteigt Budget um ${fmtCHF(totalFixCost - personnelBudget)}`}
              icon={<BookOpen className="h-5 w-5" />}
              color={totalFixCost <= personnelBudget ? 'green' : 'red'}
              delta={totalFixCost - personnelBudget} deltaLabel="FIX − Budget"
            />
            <KpiCard
              title="Total vs. Budget / Monat"
              value={fmtCHF(totalCombined - personnelBudget)}
              sub={totalCombined <= personnelBudget
                ? `Total liegt ${fmtCHF(personnelBudget - totalCombined)} unter Budget`
                : `Total übersteigt Budget um ${fmtCHF(totalCombined - personnelBudget)}`}
              icon={<TrendingUp className="h-5 w-5" />}
              color={totalCombined <= personnelBudget ? 'green' : 'red'}
              delta={totalCombined - personnelBudget} deltaLabel="Total − Budget"
            />
            <KpiCard
              title="Budget Personalkosten"
              value={fmtCHF(personnelBudget)}
              sub={`Monatsbudget ${getMonthLabel(selectedYear, selectedMonth)}`}
              icon={<BookOpen className="h-5 w-5" />}
              color="default"
            />
          </div>
        )}

        {/* ── Ferienabbau-Hinweis ───────────────────────────────────────────── */}
        {totalFerienabbauCHF > 0 && (
          <div className="flex items-start gap-2.5 rounded-lg border border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/30 p-3 text-xs text-blue-800 dark:text-blue-200">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <p>
              <strong>Ferienabbau-Abzug:</strong>{' '}
              {fmtCHF(totalFerienabbauCHF)} werden von den variablen Kosten abgezogen (FE-Einträge im Ist).
              Ferientage sind keine Arbeitsstunden — der Abzug reduziert die Netto-Variabelkosten entsprechend.
            </p>
          </div>
        )}

        {/* ── Erklärung ────────────────────────────────────────────────────── */}
        <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20 p-3 text-xs text-blue-800 dark:text-blue-200">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <p>
            <strong>Personal FIX</strong>: Garantierter Monatslohn inkl. amortisiertem 13. Monatslohn.
            Mitarbeiter die im gewählten Monat austreten werden <em>pro rata</em> (Arbeitstage ÷ Monatstage) abgerechnet.
            Bereits ausgetretene Mitarbeiter werden ausgeblendet.{' '}
            <strong>Personal VARIABEL</strong>: Stunden × Stundenlohn.
            Wähle Plan- oder Ist-Stunden direkt aus dem Dienstplan — oder trage Stunden manuell ein.
          </p>
        </div>

        {/* ── FIX-Tabellen nach Abteilung ──────────────────────────────────── */}
        {Object.entries(byDept).map(([dept, rows]) => {
          const deptTotal = rows.reduce((s, r) => s + r.cost, 0);
          const deptBase  = rows.reduce((s, r) => s + (r.emp.monthlySalary ?? 0), 0);
          return (
            <section key={dept} className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  {DEPT_ICON[dept]}
                  {DEPT_LABEL[dept] ?? dept} — FIX
                  <Badge variant="secondary" className="text-xs">{rows.length}</Badge>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                  <span className="whitespace-nowrap">Basis: <strong className="text-foreground font-mono">{fmtCHF(deptBase)}/Mt</strong></span>
                  <span className="whitespace-nowrap">FIX: <strong className="text-foreground font-mono">{fmtCHF(deptTotal)}/Mt</strong></span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
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
                            {isAdmin ? (
                              <InlineSalaryEditor empId={emp.id} field="monthlySalary" value={emp.monthlySalary} onSaved={handleSaved} />
                            ) : (
                              <span className="font-mono text-sm">{emp.monthlySalary ? fmtCHFDec(emp.monthlySalary) : '–'}</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {isAdmin ? (
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
            </section>
          );
        })}

        {/* ── Gesamt-Total FIX ─────────────────────────────────────────────── */}
        {activeFixedEmployees.length > 0 && (
          <div className="rounded-xl border-2 border-blue-300 dark:border-blue-700 bg-blue-50/50 dark:bg-blue-950/20 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-bold">
              <Building2 className="h-4 w-4 text-blue-600" />
              Total Personal FIX · alle Abteilungen
            </div>
            <div className="flex flex-wrap items-center gap-6 text-sm">
              <span className="text-muted-foreground">Basis: <strong className="font-mono text-foreground">{fmtCHF(totalFixBase)}/Mt</strong></span>
              <span className="text-blue-700 dark:text-blue-300 font-bold text-base font-mono">{fmtCHF(totalFixCost)}/Mt</span>
              <span className="text-muted-foreground">|</span>
              <span className="text-muted-foreground">Jahr: <strong className="font-mono text-foreground">{fmtCHF(totalFixAnnual)}</strong></span>
            </div>
          </div>
        )}

        {/* ── Variable Mitarbeiter ─────────────────────────────────────────── */}
        {variableEmployees.length > 0 && (
          <section className="rounded-xl border border-orange-200 dark:border-orange-800 bg-card shadow-sm overflow-hidden">

            {/* Abschnitts-Header + Toggle */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-orange-200 dark:border-orange-800 bg-orange-50/40 dark:bg-orange-950/20">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-orange-600" />
                <span className="text-sm font-semibold">Variable Mitarbeiter — Stunden-Hochrechnung</span>
                <Badge variant="outline" className="text-xs">{variableEmployees.length}</Badge>
              </div>

              {/* Export-Buttons Plan / Ist */}
              <div className="flex items-center gap-1 border-r border-orange-200 dark:border-orange-800 pr-2 mr-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleVarExport('plan')}
                  className="h-7 px-2 text-xs gap-1 text-blue-600 hover:bg-blue-50 hover:text-blue-700 dark:text-blue-400 dark:hover:bg-blue-950/30"
                  title="Plan-Kostenvergleich exportieren"
                >
                  <Download className="h-3 w-3" />Plan
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleVarExport('ist')}
                  className="h-7 px-2 text-xs gap-1 text-orange-600 hover:bg-orange-50 hover:text-orange-700 dark:text-orange-400 dark:hover:bg-orange-950/30"
                  title="Ist-Kostenvergleich exportieren"
                >
                  <Download className="h-3 w-3" />Ist
                </Button>
              </div>

              {/* Plan / Ist / Manuell Schalter */}
              <div className="flex items-center gap-1 bg-muted/60 rounded-lg p-0.5">
                {(['plan', 'ist', 'manual'] as VarView[]).map(v => {
                  const labels = { plan: 'Plan', ist: 'Ist', manual: 'Manuell' };
                  const active = varView === v;
                  const unavail = (v === 'plan' && !planHasDaten) || (v === 'ist' && !istHasDaten);
                  return (
                    <button
                      key={v}
                      onClick={() => setVarView(v)}
                      className={cn(
                        'px-3 py-1 text-xs font-semibold rounded-md transition-colors',
                        active
                          ? 'bg-white dark:bg-slate-800 shadow-sm text-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                        unavail && !active && 'opacity-40',
                      )}
                    >
                      {labels[v]}
                      {unavail && !active && <span className="ml-1 text-[10px]">–</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Restbudget Schnellinfo ─────────────────────────────────── */}
            {personnelBudget > 0 && (
              <div className={cn(
                'px-4 py-2 border-b flex flex-wrap items-center justify-between gap-3 text-xs',
                varBudgetOverrun
                  ? 'border-red-200 dark:border-red-800 bg-red-50/40 dark:bg-red-950/15'
                  : varBudgetDelta < availableVarBudget * 0.15
                    ? 'border-yellow-200 dark:border-yellow-800 bg-yellow-50/40 dark:bg-yellow-950/15'
                    : 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/15'
              )}>
                {/* Left: status text */}
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex gap-1 items-center shrink-0">
                    <div className={cn('h-2.5 w-2.5 rounded-full transition-all', varBudgetOverrun ? 'bg-red-500 shadow-[0_0_4px_rgba(239,68,68,0.6)]' : 'bg-red-200 dark:bg-red-900')} />
                    <div className={cn('h-2.5 w-2.5 rounded-full transition-all', !varBudgetOverrun && varBudgetDelta < availableVarBudget * 0.15 ? 'bg-yellow-500 shadow-[0_0_4px_rgba(234,179,8,0.6)]' : 'bg-yellow-200 dark:bg-yellow-900')} />
                    <div className={cn('h-2.5 w-2.5 rounded-full transition-all', !varBudgetOverrun && varBudgetDelta >= availableVarBudget * 0.15 ? 'bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.6)]' : 'bg-emerald-200 dark:bg-emerald-900')} />
                  </div>
                  <span className="text-muted-foreground">Restbudget Variabel:</span>
                  <span className={cn('font-mono font-bold',
                    varBudgetOverrun ? 'text-red-600 dark:text-red-400'
                      : varBudgetDelta < availableVarBudget * 0.15 ? 'text-yellow-600 dark:text-yellow-500'
                      : 'text-emerald-600 dark:text-emerald-400'
                  )}>
                    {varBudgetOverrun
                      ? `⚠ ${fmtCHF(Math.abs(varBudgetDelta))} überschritten`
                      : `${fmtCHF(varBudgetDelta)} noch verfügbar`}
                  </span>
                  {avgHourlyWage > 0 && !varBudgetOverrun && maxVarHours > 0 && (
                    <span className="text-muted-foreground">
                      ≈ <strong className="text-foreground font-mono">
                        {Math.max(0, maxVarHours - Math.round(totalVarHours))} h
                      </strong> noch planbar
                    </span>
                  )}
                  {varBudgetOverrun && avgHourlyWage > 0 && (
                    <span className="text-red-600 dark:text-red-400">
                      → ca. <strong className="font-mono">{Math.ceil(Math.abs(varBudgetDelta) / avgHourlyWage)} h</strong> reduzieren
                    </span>
                  )}
                </div>
                {/* Right: progress bar */}
                {availableVarBudget > 0 && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-muted-foreground tabular-nums">
                      {Math.min(100, Math.round((totalVarCost / availableVarBudget) * 100))} %
                    </span>
                    <div className="w-28 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={cn('h-full rounded-full transition-all duration-300',
                          varBudgetOverrun ? 'bg-red-500' : varBudgetDelta < availableVarBudget * 0.15 ? 'bg-yellow-500' : 'bg-emerald-500'
                        )}
                        style={{ width: `${Math.min(100, (totalVarCost / availableVarBudget) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Quellenangabe */}
            <div className="px-4 py-2 bg-orange-50/30 dark:bg-orange-950/10 border-b border-orange-100 dark:border-orange-900 text-xs text-orange-700 dark:text-orange-300 flex items-center gap-1.5">
              <BarChart2 className="h-3.5 w-3.5 shrink-0" />
              <strong>{varViewLabel[varView]}</strong>
              {varView === 'plan' && !planHasDaten && (
                <span className="ml-2 text-muted-foreground italic">— Keine Plan-Stunden für diesen Monat im Dienstplan gefunden</span>
              )}
              {varView === 'ist' && !istHasDaten && (
                <span className="ml-2 text-muted-foreground italic">— Keine Ist-Stunden für {selectedYear}-{String(selectedMonth).padStart(2,'0')} im Dienstplan vorhanden</span>
              )}
              {varView === 'ist' && istHasDaten && (
                <span className="ml-2 text-xs text-muted-foreground">
                  Ist {selectedYear}-{String(selectedMonth).padStart(2,'0')}:&nbsp;
                  {Object.keys(istHours).length} Mitarbeiter&nbsp;/&nbsp;
                  {Math.round(Object.values(istHours).reduce((s,h) => s+h, 0) * 10) / 10} h&nbsp;
                  <span className="opacity-60">(Dienstplan + Supabase)</span>
                </span>
              )}
              {varView === 'manual' && (
                <span className="ml-2 text-muted-foreground">— Klicke auf eine Stundenzahl zum Bearbeiten</span>
              )}
            </div>

            {/* Tabellen pro Abteilung */}
            {(['service', 'küche'] as const).map(dept => {
              const deptEmps = varByDept[dept];
              if (!deptEmps || deptEmps.length === 0) return null;
              const deptHours = deptEmps.reduce((s, e) => {
                if (varView === 'manual' && (varPricingMode[e.id] ?? 'hourly') === 'daily') return s;
                return s + getVarHoursFor(e.id);
              }, 0);
              const deptCost  = deptEmps.reduce((s, e) => s + getVarMonthlyCostFor(e.id, e), 0);

              return (
                <div key={dept} className="border-b border-orange-100 dark:border-orange-900 last:border-b-0">
                  {/* Abteilungs-Unterüberschrift */}
                  <div className="flex items-center justify-between px-4 py-2 bg-muted/10 border-b border-orange-100 dark:border-orange-900">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      {DEPT_ICON[dept]}
                      {DEPT_LABEL[dept]}
                      <Badge variant="outline" className="text-xs normal-case font-normal">{deptEmps.length}</Badge>
                    </div>
                    {deptHours > 0 && (
                      <span className="text-xs text-muted-foreground">
                        <strong className="font-mono text-foreground">{Math.round(deptHours * 10) / 10} h</strong>
                        {' → '}
                        <strong className="font-mono text-orange-700 dark:text-orange-400">{fmtCHF(deptCost)}</strong>
                      </span>
                    )}
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground border-b border-border bg-muted/10">
                          <th className="text-left px-4 py-2 font-medium">Name</th>
                          <th className="text-left px-4 py-2 font-medium">Anstellung</th>
                          {varView === 'manual'
                            ? <th className="text-center px-3 py-2 font-medium">Modus</th>
                            : <th className="text-right px-4 py-2 font-medium">Stundenlohn</th>}
                          <th className="text-right px-4 py-2 font-medium">
                            {varView === 'manual' ? 'Kalkulation' : varView === 'plan' ? 'Plan-Std./Mt' : 'Ist-Std./Mt'}
                          </th>
                          <th className="text-right px-4 py-2 font-medium">Kosten/Mt</th>
                          <th className="text-right px-4 py-2 font-medium">Kosten/Jahr</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {deptEmps.map(emp => {
                          const mode      = varPricingMode[emp.id] ?? 'hourly';
                          const isDaily   = varView === 'manual' && mode === 'daily';
                          const hours     = getVarHoursFor(emp.id);
                          const projected = getVarMonthlyCostFor(emp.id, emp);
                          const weekly    = varWeekly[emp.id] ?? {};
                          const dr        = varDayRate[emp.id] ?? {} as DayRateData;
                          const hasManualOverride = (varHours[emp.id] ?? 0) > 0;
                          const hasWeeklyBaseline = (weekly.hours ?? 0) > 0;
                          const isAutoCalcH = varView === 'manual' && !isDaily && !hasManualOverride && hasWeeklyBaseline;
                          // Tagessatz: resolved monthly days
                          const autoMonthlyDays = (dr.daysPerWeek ?? 0) > 0 && !(dr.daysPerMonth ?? 0)
                            ? Math.round(dr.daysPerWeek! * WEEKS_PER_MONTH * 10) / 10 : 0;
                          const resolvedDays = (dr.daysPerMonth ?? 0) > 0 ? dr.daysPerMonth! : autoMonthlyDays;
                          return (
                            <tr key={emp.id} className="hover:bg-muted/30 transition-colors">
                              <td className="px-4 py-2.5 font-medium">{emp.name}</td>
                              <td className="px-4 py-2.5">
                                <Badge variant="outline" className="text-xs">{EMP_TYPE_LABEL[emp.employmentType]}</Badge>
                              </td>

                              {/* ── Modus-Spalte (manual) oder Stundenlohn (plan/ist) ── */}
                              {varView === 'manual' ? (
                                <td className="px-3 py-2.5 text-center">
                                  <button
                                    onClick={() => handlePricingModeToggle(emp.id)}
                                    title={mode === 'hourly' ? 'Umschalten auf Tagessatz' : 'Umschalten auf Stundenlohn'}
                                    className={cn(
                                      'text-[10px] font-bold px-2 py-1 rounded border transition-colors',
                                      mode === 'hourly'
                                        ? 'border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 dark:border-blue-700 dark:text-blue-300 dark:bg-blue-950/40'
                                        : 'border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 dark:border-emerald-700 dark:text-emerald-300 dark:bg-emerald-950/40'
                                    )}
                                  >
                                    {mode === 'hourly' ? 'SL' : 'TS'}
                                  </button>
                                </td>
                              ) : (
                                <td className={cn('px-4 py-2.5 text-right', saving === emp.id && 'opacity-50')}>
                                  {isAdmin ? (
                                    <InlineHourlyWageEditor empId={emp.id} value={emp.hourlyWage} onSaved={handleHourlyWageSaved} />
                                  ) : (
                                    <span className="font-mono text-sm text-muted-foreground">
                                      {emp.hourlyWage ? `${fmtCHFDec(emp.hourlyWage)}/h` : '–'}
                                    </span>
                                  )}
                                </td>
                              )}

                              {/* ── Kalkulations-Spalte ── */}
                              <td className="px-4 py-2.5 text-right">
                                {varView === 'manual' ? (
                                  isDaily ? (
                                    /* ── Tagessatz-Modus ── */
                                    <div className="flex items-center gap-1.5 justify-end flex-wrap">
                                      <InlineWeeklyEditor
                                        value={dr.ratePerDay || undefined}
                                        unit="CHF/T"
                                        max={5000}
                                        onSave={val => handleDayRateChange(emp.id, 'ratePerDay', val)}
                                      />
                                      <span className="text-muted-foreground text-xs">·</span>
                                      <InlineWeeklyEditor
                                        value={dr.daysPerWeek || undefined}
                                        unit="T/Wo"
                                        max={7}
                                        onSave={val => handleDayRateChange(emp.id, 'daysPerWeek', val ?? 0)}
                                      />
                                      <span className="text-muted-foreground text-[10px]">/</span>
                                      <InlineWeeklyEditor
                                        value={dr.daysPerMonth || undefined}
                                        unit="T/Mt"
                                        max={31}
                                        onSave={val => handleDayRateChange(emp.id, 'daysPerMonth', val ?? 0)}
                                      />
                                      {resolvedDays > 0 && (
                                        <span className="text-[9px] text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                                          → {resolvedDays}T/Mt{autoMonthlyDays > 0 && dr.daysPerMonth === undefined ? ' (auto)' : ''}
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    /* ── Stundenlohn-Modus ── */
                                    <div className="flex items-center gap-1.5 justify-end flex-wrap">
                                      <span className={cn(saving === emp.id && 'opacity-50')}>
                                        {isAdmin
                                          ? <InlineHourlyWageEditor empId={emp.id} value={emp.hourlyWage} onSaved={handleHourlyWageSaved} />
                                          : <span className="font-mono text-xs text-muted-foreground">{emp.hourlyWage ? `${fmtCHFDec(emp.hourlyWage)}/h` : '–'}</span>}
                                      </span>
                                      <span className="text-muted-foreground text-xs">·</span>
                                      <InlineWeeklyEditor value={weekly.hours} unit="h/Wo" max={60}
                                        onSave={val => handleVarWeeklyChange(emp.id, 'hours', val)} />
                                      <span className="text-muted-foreground text-[10px]">/</span>
                                      <InlineWeeklyEditor value={weekly.days} unit="T/Wo" max={7}
                                        onSave={val => handleVarWeeklyChange(emp.id, 'days', val)} />
                                      <span className="text-muted-foreground text-xs">·</span>
                                      <div className="flex flex-col items-end gap-0">
                                        <InlineHoursEditor
                                          empId={emp.id}
                                          value={hasManualOverride ? (varHours[emp.id] ?? 0) : 0}
                                          onChange={handleVarHoursChange}
                                        />
                                        {isAutoCalcH && (
                                          <span className="text-[9px] text-violet-500 dark:text-violet-400 whitespace-nowrap">
                                            ↑ auto {Math.round(hours * 10) / 10}h
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  )
                                ) : (
                                  /* ── Plan/Ist-Ansicht ── */
                                  <span className={cn('font-mono text-sm', hours > 0 ? '' : 'text-muted-foreground italic text-xs')}>
                                    {hours > 0 ? `${Math.round(hours * 10) / 10} h` : '–'}
                                  </span>
                                )}
                              </td>

                              <td className="px-4 py-2.5 text-right font-semibold font-mono">
                                {projected > 0
                                  ? <span className="text-orange-700 dark:text-orange-400">{fmtCHF(projected)}</span>
                                  : <span className="text-muted-foreground italic text-xs">–</span>}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono text-muted-foreground text-sm">
                                {projected > 0 ? fmtCHF(projected * 12) : '–'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      {deptCost > 0 && (
                        <tfoot>
                          <tr className="bg-orange-50/40 dark:bg-orange-950/20 font-semibold border-t-2 border-orange-200 dark:border-orange-800">
                            <td className="px-4 py-2.5 text-sm" colSpan={3}>Total {DEPT_LABEL[dept]} Variabel</td>
                            <td className="px-4 py-2.5 text-right font-mono text-sm text-muted-foreground">
                              {deptHours > 0 ? `${Math.round(deptHours * 10) / 10} h` : '–'}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-orange-700 dark:text-orange-400">{fmtCHF(deptCost)}</td>
                            <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{fmtCHF(deptCost * 12)}</td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>
              );
            })}

            {/* Gesamt-Variabel-Footer */}
            {totalVarHours > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-orange-100/40 dark:bg-orange-950/30 border-t-2 border-orange-300 dark:border-orange-700">
                <span className="text-sm font-bold text-orange-800 dark:text-orange-300">Total Variabel · alle Abteilungen</span>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-muted-foreground font-mono">{Math.round(totalVarHours * 10) / 10} h</span>
                  <span className="font-bold font-mono text-orange-700 dark:text-orange-400">{fmtCHF(totalVarCost)}/Mt</span>
                </div>
              </div>
            )}
          </section>
        )}

        {/* ── Variable Budget-Planung ──────────────────────────────────────── */}
        {personnelBudget > 0 && (
          <section className="rounded-xl border-2 border-violet-200 dark:border-violet-800 bg-card shadow-sm overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-violet-50/40 dark:bg-violet-950/20">
              <Target className="h-4 w-4 text-violet-600 dark:text-violet-400" />
              <span className="text-sm font-bold">Budget-Planung Personal — {getMonthLabel(selectedYear, selectedMonth)}</span>
            </div>

            {/* Budget-Rechnung */}
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Budgetverteilung</p>
                <div className="flex justify-between items-center py-1.5 border-b border-dashed border-border">
                  <span className="text-sm text-muted-foreground">Personalbudget gesamt</span>
                  <span className="font-mono font-semibold">{fmtCHF(personnelBudget)}</span>
                </div>
                <div className="flex justify-between items-baseline py-1.5 border-b border-dashed border-border">
                  <span className="text-sm text-muted-foreground">− Personal FIX</span>
                  <span className="font-mono text-blue-700 dark:text-blue-400 shrink-0">− {fmtCHF(totalFixCost)}</span>
                </div>
                <div className={cn(
                  'flex justify-between items-center py-2 px-3 rounded-lg',
                  availableVarBudget > 0
                    ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
                    : 'bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300'
                )}>
                  <span className="text-sm font-bold">= Verfügbar für Variabel</span>
                  <span className="font-mono font-bold text-base">{fmtCHF(availableVarBudget)}</span>
                </div>
              </div>

              {/* Vergleich: Schätzung vs. Verfügbar */}
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Schätzung vs. Budget</p>
                <div className="flex justify-between items-center py-1.5 border-b border-dashed border-border">
                  <span className="text-sm text-muted-foreground">Verfügbar für Variabel</span>
                  <span className="font-mono font-semibold">{fmtCHF(availableVarBudget)}</span>
                </div>
                <div className="flex justify-between items-baseline gap-2 py-1.5 border-b border-dashed border-border">
                  <div className="flex items-center gap-1.5 flex-wrap text-sm text-muted-foreground">
                    <span className="whitespace-nowrap">− Variable Arbeit</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 whitespace-nowrap">
                      {varView === 'plan' ? 'Plan' : varView === 'ist' ? 'Ist' : 'Manuell'}
                    </span>
                  </div>
                  <span className="font-mono text-orange-700 dark:text-orange-400 shrink-0">− {fmtCHF(totalVarArbeitCHF)}</span>
                </div>
                {totalFerienabbauCHF > 0 && (
                  <div className="flex justify-between items-baseline gap-2 py-1.5 border-b border-dashed border-border">
                    <span className="text-sm text-muted-foreground">+ Ferienabbau-Abzug (FE Ist)</span>
                    <span className="font-mono text-blue-600 dark:text-blue-400 shrink-0">− {fmtCHF(totalFerienabbauCHF)}</span>
                  </div>
                )}
                {totalFerienabbauCHF > 0 && (
                  <div className="flex justify-between items-baseline gap-2 py-1 border-b border-dashed border-border">
                    <span className="text-sm font-medium text-muted-foreground">= Netto Variabel</span>
                    <span className="font-mono font-semibold text-orange-800 dark:text-orange-300 shrink-0">{fmtCHF(totalVariabelCHF)}</span>
                  </div>
                )}
                <div className={cn(
                  'flex justify-between items-center py-2 px-3 rounded-lg',
                  !varBudgetOverrun
                    ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
                    : 'bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300'
                )}>
                  <span className="text-sm font-bold">
                    {varBudgetOverrun ? '⚠ Überziehung' : '✓ Verbleibend'}
                  </span>
                  <span className="font-mono font-bold text-base">
                    {varBudgetOverrun ? '– ' : '+ '}{fmtCHF(Math.abs(varBudgetDelta))}
                  </span>
                </div>
              </div>
            </div>

            {/* ── Planungsempfehlung ────────────────────────────────────── */}
            {avgHourlyWage > 0 && (
              <div className={cn(
                'mx-4 mb-4 p-3 rounded-lg border flex flex-wrap items-start gap-3',
                varBudgetOverrun
                  ? 'border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20'
                  : varBudgetDelta < availableVarBudget * 0.15
                    ? 'border-yellow-200 dark:border-yellow-800 bg-yellow-50/60 dark:bg-yellow-950/20'
                    : 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20'
              )}>
                <Lightbulb className={cn('h-4 w-4 mt-0.5 shrink-0',
                  varBudgetOverrun ? 'text-red-600' : varBudgetDelta < availableVarBudget * 0.15 ? 'text-yellow-600' : 'text-emerald-600'
                )} />
                <div className="flex-1 min-w-0 space-y-1.5">
                  {/* Hauptstatus */}
                  <p className="text-sm font-semibold">
                    {totalVarHours === 0 && !varBudgetOverrun
                      ? `Noch kein Variabel geplant — Budget: ${fmtCHF(availableVarBudget)} verfügbar`
                      : varBudgetOverrun
                        ? `⚠ Budgetüberschreitung: ${fmtCHF(Math.abs(varBudgetDelta))} zu viel geplant`
                        : varBudgetDelta < availableVarBudget * 0.15
                          ? `Achtung: Budget fast ausgeschöpft — noch ${fmtCHF(varBudgetDelta)} Puffer`
                          : `Budget im grünen Bereich — Puffer ${fmtCHF(varBudgetDelta)}`}
                  </p>

                  {/* Stunden-Info */}
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <p>
                      Ø Stundenlohn Variabel: <strong className="font-mono text-foreground">{fmtCHFDec(avgHourlyWage)}/h</strong>
                      {maxVarHours > 0 && (
                        <> · Budget reicht für max. <strong className="font-mono text-foreground">{maxVarHours} h</strong></>
                      )}
                    </p>
                    {totalVarHours > 0 && maxVarHours > 0 && (
                      <p>
                        Aktuell geplant: <strong className="font-mono text-foreground">{Math.round(totalVarHours * 10) / 10} h</strong>
                        {totalVarHours <= maxVarHours
                          ? <span className="text-emerald-600 dark:text-emerald-400"> · Reserve: {Math.max(0, maxVarHours - Math.round(totalVarHours))} h (≈ {fmtCHF(varBudgetDelta)})</span>
                          : <span className="text-red-600 dark:text-red-400"> · {Math.round(totalVarHours) - maxVarHours} h zu viel (≈ {fmtCHF(Math.abs(varBudgetDelta))})</span>}
                      </p>
                    )}
                  </div>

                  {/* Regelbasierte Handlungsempfehlung */}
                  <p className={cn('text-xs font-medium mt-0.5',
                    varBudgetOverrun ? 'text-red-600 dark:text-red-400'
                      : varBudgetDelta < availableVarBudget * 0.15 ? 'text-yellow-600 dark:text-yellow-500'
                      : 'text-emerald-600 dark:text-emerald-400'
                  )}>
                    {totalVarHours === 0 && !varBudgetOverrun
                      ? `→ Stunden planen: Noch ca. ${maxVarHours} h verfügbar — trage unten Stunden ein.`
                      : varBudgetOverrun
                        ? `→ Reduziere variable Stunden um ca. ${Math.ceil(Math.abs(varBudgetDelta) / avgHourlyWage)} h, um das Budget einzuhalten.`
                        : varBudgetDelta < availableVarBudget * 0.15
                          ? `→ Vorsicht: Noch ${Math.max(0, maxVarHours - Math.round(totalVarHours))} h Spielraum — zusätzliche Schichten könnten das Budget sprengen.`
                          : `→ Kapazität vorhanden: Noch ca. ${Math.max(0, maxVarHours - Math.round(totalVarHours))} h planbar ohne Budgetüberschreitung.`}
                  </p>
                </div>

                {/* Ampel */}
                <div className="flex flex-col gap-1 items-center shrink-0 self-center">
                  <div className={cn('h-3.5 w-3.5 rounded-full transition-all', varBudgetOverrun ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.7)]' : 'bg-red-200 dark:bg-red-900')} />
                  <div className={cn('h-3.5 w-3.5 rounded-full transition-all', !varBudgetOverrun && varBudgetDelta < availableVarBudget * 0.15 ? 'bg-yellow-500 shadow-[0_0_6px_rgba(234,179,8,0.7)]' : 'bg-yellow-200 dark:bg-yellow-900')} />
                  <div className={cn('h-3.5 w-3.5 rounded-full transition-all', !varBudgetOverrun && varBudgetDelta >= availableVarBudget * 0.15 ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.7)]' : 'bg-emerald-200 dark:bg-emerald-900')} />
                </div>
              </div>
            )}
          </section>
        )}

        {/* ── Abteilungs-Zusammenfassung FIX + VARIABEL ────────────────────── */}
        {deptSummary.length > 0 && (totalFixCost > 0 || totalVarCost > 0) && (
          <section className="rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-card shadow-sm overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/20">
              <BarChart2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-bold">Personalkosten-Übersicht nach Abteilung — {getMonthLabel(selectedYear, selectedMonth)}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium">Kategorie</th>
                    {deptSummary.map(ds => (
                      <th key={ds.dept} className="text-right px-4 py-2 font-medium">
                        <div className="flex items-center justify-end gap-1.5">
                          {DEPT_ICON[ds.dept]}
                          {DEPT_LABEL[ds.dept] ?? ds.dept}
                        </div>
                      </th>
                    ))}
                    <th className="text-right px-4 py-2 font-medium">Gesamt</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <tr className="hover:bg-muted/20">
                    <td className="px-4 py-2.5 font-medium text-blue-700 dark:text-blue-400">FIX</td>
                    {deptSummary.map(ds => (
                      <td key={ds.dept} className="px-4 py-2.5 text-right font-mono text-blue-700 dark:text-blue-400">
                        {ds.fix > 0 ? fmtCHF(ds.fix) : <span className="text-muted-foreground">–</span>}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-blue-700 dark:text-blue-400">
                      {fmtCHF(totalFixCost)}
                    </td>
                  </tr>
                  <tr className="hover:bg-muted/20">
                    <td className="px-4 py-2.5 font-medium text-orange-700 dark:text-orange-400">VARIABLE ARBEIT</td>
                    {deptSummary.map(ds => (
                      <td key={ds.dept} className="px-4 py-2.5 text-right font-mono text-orange-700 dark:text-orange-400">
                        {ds.varArbeit > 0 ? fmtCHF(ds.varArbeit) : <span className="text-muted-foreground">–</span>}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-orange-700 dark:text-orange-400">
                      {fmtCHF(totalVarArbeitCHF)}
                    </td>
                  </tr>
                  <tr className="hover:bg-muted/20 bg-blue-50/30 dark:bg-blue-950/10">
                    <td className="px-4 py-2.5 font-medium text-blue-600 dark:text-blue-400">− FERIENABBAU</td>
                    {deptSummary.map(ds => (
                      <td key={ds.dept} className="px-4 py-2.5 text-right font-mono text-blue-600 dark:text-blue-400">
                        {ds.ferienabbau > 0 ? `− ${fmtCHF(ds.ferienabbau)}` : <span className="text-muted-foreground">–</span>}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-blue-600 dark:text-blue-400">
                      {totalFerienabbauCHF > 0 ? `− ${fmtCHF(totalFerienabbauCHF)}` : <span className="text-muted-foreground">–</span>}
                    </td>
                  </tr>
                  <tr className="hover:bg-muted/20 border-t border-orange-200 dark:border-orange-800">
                    <td className="px-4 py-2.5 font-semibold text-orange-800 dark:text-orange-300">TOTAL VARIABEL</td>
                    {deptSummary.map(ds => (
                      <td key={ds.dept} className="px-4 py-2.5 text-right font-mono font-semibold text-orange-800 dark:text-orange-300">
                        {ds.variabel > 0 ? fmtCHF(ds.variabel) : <span className="text-muted-foreground">–</span>}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-right font-mono font-bold text-orange-800 dark:text-orange-300">
                      {fmtCHF(totalVariabelCHF)}
                    </td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr className="bg-emerald-50/50 dark:bg-emerald-950/20 border-t-2 border-emerald-300 dark:border-emerald-700">
                    <td className="px-4 py-2.5 font-bold text-emerald-800 dark:text-emerald-300">TOTAL PERSONAL</td>
                    {deptSummary.map(ds => (
                      <td key={ds.dept} className="px-4 py-2.5 text-right font-mono font-bold text-emerald-700 dark:text-emerald-400">
                        {fmtCHF(ds.total)}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-right font-mono font-bold text-lg text-emerald-700 dark:text-emerald-400">
                      {fmtCHF(totalFixCost + totalVariabelCHF)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {personnelBudget > 0 && (
              <div className={cn(
                'px-4 py-2 text-xs font-medium flex items-center gap-2',
                totalCombined <= personnelBudget
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300'
                  : 'bg-red-50 text-red-700 dark:bg-red-950/20 dark:text-red-300',
              )}>
                {totalCombined <= personnelBudget
                  ? `✓ Total liegt ${fmtCHF(personnelBudget - totalCombined)} unter Monatsbudget (${fmtCHF(personnelBudget)})`
                  : `↑ Total übersteigt Monatsbudget (${fmtCHF(personnelBudget)}) um ${fmtCHF(totalCombined - personnelBudget)}`}
              </div>
            )}
          </section>
        )}

        {/* ── Stundensaldo & Planungshinweise ──────────────────────────────── */}
        {allEmployees.length > 0 && (
          <HourBalanceSection
            balances={hourBalances}
            hints={planningHints}
            mode={varView}
            modeLabel={varModeLabelShort}
          />
        )}

        {/* ── Gesamt-Total FIX + VARIABEL ──────────────────────────────────── */}
        {totalVarCost > 0 && (
          <div className="rounded-xl border-2 border-emerald-300 dark:border-emerald-700 bg-emerald-50/50 dark:bg-emerald-950/20 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-bold">
              <Users className="h-4 w-4 text-emerald-600" />
              Total Personal FIX + VARIABEL · {getMonthLabel(selectedYear, selectedMonth)}
            </div>
            <div className="flex flex-wrap items-center gap-6 text-sm">
              <span className="text-muted-foreground">
                FIX: <strong className="font-mono text-blue-700 dark:text-blue-300">{fmtCHF(totalFixCost)}</strong>
              </span>
              <span className="text-muted-foreground">+</span>
              <span className="text-muted-foreground">
                VARIABEL: <strong className="font-mono text-orange-700 dark:text-orange-400">{fmtCHF(totalVarCost)}</strong>
              </span>
              <span className="text-muted-foreground">=</span>
              <span className="text-emerald-700 dark:text-emerald-300 font-bold text-lg font-mono">{fmtCHF(totalCombined)}/Mt</span>
              {personnelBudget > 0 && (
                <span className={cn(
                  'text-xs font-medium px-2 py-0.5 rounded-full',
                  totalCombined <= personnelBudget
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
                )}>
                  {totalCombined <= personnelBudget ? '✓ im Budget' : `↑ ${fmtCHF(totalCombined - personnelBudget)} über Budget`}
                </span>
              )}
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
