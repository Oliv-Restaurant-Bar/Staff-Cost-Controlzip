import { useState, useMemo, useEffect, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import {
  DollarSign, Users, BookOpen, TrendingUp, ChefHat,
  Utensils, Edit2, Check, X, Info, Building2, AlertCircle, Clock,
  ChevronLeft, ChevronRight, Calendar, BarChart2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { loadEmployees, upsertEmployee } from '@/lib/supabase-db';
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
 * Liest Ist-Stunden aus localStorage (actual-hours-YYYY-MM = Mirus-Import).
 * Gibt eine Map empId → Gesamtstunden im Monat zurück.
 */
function loadIstHoursFromStorage(year: number, month: number): Record<string, number> {
  const key = `actual-hours-${year}-${String(month).padStart(2, '0')}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const data: Record<string, any> = JSON.parse(raw);
    const out: Record<string, number> = {};
    for (const [cellKey, val] of Object.entries(data)) {
      const empId = cellKey.slice(0, cellKey.length - 11);
      if (!empId) continue;
      const h = typeof val === 'number' ? val : (val?.hours ?? 0);
      if (h > 0) out[empId] = (out[empId] ?? 0) + Math.round(h * 100) / 100;
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

// ── KPI-Card ──────────────────────────────────────────────────────────────────

interface KpiProps {
  title: string; value: string; sub?: string; icon: React.ReactNode;
  color?: 'blue' | 'green' | 'red' | 'yellow' | 'orange' | 'default';
  delta?: number | null; deltaLabel?: string;
}

const KpiCard = ({ title, value, sub, icon, color = 'default', delta, deltaLabel }: KpiProps) => {
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
  const [varView, setVarView] = useState<VarView>('manual');
  const [planHours, setPlanHours] = useState<Record<string, number>>({});
  const [istHours, setIstHours] = useState<Record<string, number>>({});

  useEffect(() => {
    loadEmployees().then(emps => {
      if (emps) setEmployees(emps);
      setLoading(false);
    });
  }, []);

  // Reload Plan/Ist hours whenever month changes
  useEffect(() => {
    setPlanHours(loadPlanHoursFromStorage(selectedYear, selectedMonth));
    setIstHours(loadIstHoursFromStorage(selectedYear, selectedMonth));
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
    return varHours[empId] ?? 0;
  }, [varView, planHours, istHours, varHours]);

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
    variableEmployees.reduce((s, e) => s + getVarHoursFor(e.id) * (e.hourlyWage ?? 0), 0),
    [variableEmployees, getVarHoursFor],
  );
  const totalVarHours = useMemo(() =>
    variableEmployees.reduce((s, e) => s + getVarHoursFor(e.id), 0),
    [variableEmployees, getVarHoursFor],
  );
  const totalCombined = totalFixCost + totalVarCost;

  // ── Departement-Zusammenfassung ────────────────────────────────────────────

  const deptSummary = useMemo(() => {
    const depts = Array.from(new Set([...Object.keys(byDept), ...Object.keys(varByDept)]));
    return depts.map(dept => {
      const fix = (byDept[dept] ?? []).reduce((s, r) => s + r.cost, 0);
      const varEmpList = varByDept[dept] ?? [];
      const variabel = varEmpList.reduce((s, e) => s + getVarHoursFor(e.id) * (e.hourlyWage ?? 0), 0);
      return { dept, fix, variabel, total: fix + variabel };
    });
  }, [byDept, varByDept, getVarHoursFor]);

  // ── Quellen-Labels ────────────────────────────────────────────────────────

  const planHasDaten = Object.keys(planHours).length > 0;
  const istHasDaten  = Object.keys(istHours).length > 0;

  const varViewLabel: Record<VarView, string> = {
    plan:   'Quelle: Dienstplan Plan',
    ist:    'Quelle: Dienstplan Ist (Mirus-Import)',
    manual: 'Quelle: Manuelle Eingabe (lokal gespeichert)',
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
            title="Personal VARIABEL / Monat"
            value={fmtCHF(totalVarCost)}
            sub={totalVarHours > 0
              ? `${Math.round(totalVarHours * 10) / 10} h × Stundenlohn`
              : `${variableEmployees.length} MA · Stunden wählen ↓`}
            icon={<Clock className="h-5 w-5" />}
            color={totalVarCost > 0 ? 'orange' : 'default'}
          />
          <KpiCard
            title="Total Personal / Monat"
            value={fmtCHF(totalCombined)}
            sub="FIX + VARIABEL"
            icon={<Users className="h-5 w-5" />}
            color={totalCombined > 0 ? 'green' : 'default'}
          />
        </div>

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
                <div className="flex items-center gap-6 text-xs text-muted-foreground">
                  <span>Basis: <strong className="text-foreground font-mono">{fmtCHF(deptBase)}/Mt</strong></span>
                  <span>FIX (inkl. 13.): <strong className="text-foreground font-mono">{fmtCHF(deptTotal)}/Mt</strong></span>
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
                    {rows.map(({ emp, cost, label }) => {
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

            {/* Quellenangabe */}
            <div className="px-4 py-2 bg-orange-50/30 dark:bg-orange-950/10 border-b border-orange-100 dark:border-orange-900 text-xs text-orange-700 dark:text-orange-300 flex items-center gap-1.5">
              <BarChart2 className="h-3.5 w-3.5 shrink-0" />
              <strong>{varViewLabel[varView]}</strong>
              {varView === 'plan' && !planHasDaten && (
                <span className="ml-2 text-muted-foreground italic">— Keine Plan-Stunden für diesen Monat im Dienstplan gefunden</span>
              )}
              {varView === 'ist' && !istHasDaten && (
                <span className="ml-2 text-muted-foreground italic">— Keine Ist-Stunden für diesen Monat importiert (Mirus)</span>
              )}
              {varView === 'manual' && (
                <span className="ml-2 text-muted-foreground">— Klicke auf eine Stundenzahl zum Bearbeiten</span>
              )}
            </div>

            {/* Tabellen pro Abteilung */}
            {(['service', 'küche'] as const).map(dept => {
              const deptEmps = varByDept[dept];
              if (!deptEmps || deptEmps.length === 0) return null;
              const deptHours = deptEmps.reduce((s, e) => s + getVarHoursFor(e.id), 0);
              const deptCost  = deptEmps.reduce((s, e) => s + getVarHoursFor(e.id) * (e.hourlyWage ?? 0), 0);

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
                          <th className="text-right px-4 py-2 font-medium">Stundenlohn</th>
                          <th className="text-right px-4 py-2 font-medium">
                            {varView === 'plan' ? 'Plan-Std./Mt' : varView === 'ist' ? 'Ist-Std./Mt' : 'Gesch. Std./Mt'}
                          </th>
                          <th className="text-right px-4 py-2 font-medium">Hochrechnung/Mt</th>
                          <th className="text-right px-4 py-2 font-medium">Hochrechnung/Jahr</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {deptEmps.map(emp => {
                          const hours = getVarHoursFor(emp.id);
                          const projected = hours * (emp.hourlyWage ?? 0);
                          return (
                            <tr key={emp.id} className="hover:bg-muted/30 transition-colors">
                              <td className="px-4 py-2.5 font-medium">{emp.name}</td>
                              <td className="px-4 py-2.5">
                                <Badge variant="outline" className="text-xs">{EMP_TYPE_LABEL[emp.employmentType]}</Badge>
                              </td>
                              <td className={cn('px-4 py-2.5 text-right', saving === emp.id && 'opacity-50')}>
                                {isAdmin ? (
                                  <InlineHourlyWageEditor empId={emp.id} value={emp.hourlyWage} onSaved={handleHourlyWageSaved} />
                                ) : (
                                  <span className="font-mono text-sm text-muted-foreground">
                                    {emp.hourlyWage ? `${fmtCHFDec(emp.hourlyWage)}/h` : '–'}
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                {varView === 'manual' ? (
                                  <InlineHoursEditor empId={emp.id} value={hours} onChange={handleVarHoursChange} />
                                ) : (
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
                      {deptHours > 0 && (
                        <tfoot>
                          <tr className="bg-orange-50/40 dark:bg-orange-950/20 font-semibold border-t-2 border-orange-200 dark:border-orange-800">
                            <td className="px-4 py-2.5 text-sm" colSpan={3}>Total {DEPT_LABEL[dept]} Variabel</td>
                            <td className="px-4 py-2.5 text-right font-mono text-sm">{Math.round(deptHours * 10) / 10} h</td>
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
                    <td className="px-4 py-2.5 font-medium text-orange-700 dark:text-orange-400">VARIABEL</td>
                    {deptSummary.map(ds => (
                      <td key={ds.dept} className="px-4 py-2.5 text-right font-mono text-orange-700 dark:text-orange-400">
                        {ds.variabel > 0 ? fmtCHF(ds.variabel) : <span className="text-muted-foreground">–</span>}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-orange-700 dark:text-orange-400">
                      {fmtCHF(totalVarCost)}
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
                      {fmtCHF(totalCombined)}
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
