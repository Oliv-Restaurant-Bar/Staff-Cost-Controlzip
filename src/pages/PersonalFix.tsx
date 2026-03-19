import { useState, useMemo, useEffect } from 'react';
import {
  DollarSign, Users, BookOpen, TrendingUp, ChefHat,
  Utensils, Edit2, Check, X, Info, Building2, AlertCircle,
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

// ── Helpers ────────────────────────────────────────────────────────────────────

const fmtCHF = (n: number) =>
  n.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 });

const fmtCHFDec = (n: number) =>
  n.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Fix-Monatslohn eines Mitarbeiters: inkl. 13. falls vorhanden, sonst Basis */
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

const DEPT_LABEL: Record<string, string> = { service: 'Service', küche: 'Küche' };
const DEPT_ICON: Record<string, React.ReactNode> = {
  service: <Utensils className="h-4 w-4" />,
  küche:   <ChefHat  className="h-4 w-4" />,
};

const EMP_TYPE_LABEL: Record<string, string> = {
  vollzeit: 'Vollzeit', teilzeit: 'Teilzeit',
  minijob: 'Minijob', aushilfe: 'Aushilfe',
};

// ── KPI-Card ──────────────────────────────────────────────────────────────────

interface KpiProps {
  title: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  color?: 'blue' | 'green' | 'red' | 'yellow' | 'default';
  delta?: number | null;
  deltaLabel?: string;
}

const KpiCard = ({ title, value, sub, icon, color = 'default', delta, deltaLabel }: KpiProps) => {
  const border = {
    blue:    'border-blue-200 dark:border-blue-800',
    green:   'border-emerald-200 dark:border-emerald-800',
    red:     'border-red-200 dark:border-red-800',
    yellow:  'border-yellow-200 dark:border-yellow-800',
    default: 'border-border',
  }[color];
  const iconBg = {
    blue:    'bg-blue-50 text-blue-600 dark:bg-blue-950/40',
    green:   'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40',
    red:     'bg-red-50 text-red-600 dark:bg-red-950/40',
    yellow:  'bg-yellow-50 text-yellow-600 dark:bg-yellow-950/40',
    default: 'bg-muted text-muted-foreground',
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

// ── Inline-Editor für eine Zelle ──────────────────────────────────────────────

interface InlineSalaryEditorProps {
  empId: string;
  field: 'monthlySalary' | 'monthlySalaryWith13th';
  value: number | undefined;
  onSaved: (empId: string, field: 'monthlySalary' | 'monthlySalaryWith13th', val: number) => void;
}

const InlineSalaryEditor = ({ empId, field, value, onSaved }: InlineSalaryEditorProps) => {
  const [editing, setEditing] = useState(false);
  const [input, setInput]   = useState('');

  const start = () => { setInput(value ? String(value) : ''); setEditing(true); };
  const cancel = () => setEditing(false);
  const save  = () => {
    const num = parseFloat(input.replace(/['\s]/g, '').replace(',', '.'));
    if (!isNaN(num) && num >= 0) { onSaved(empId, field, num); }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          className="h-7 w-28 text-right font-mono text-sm"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
        />
        <Button size="icon" variant="ghost" className="h-6 w-6 text-emerald-600" onClick={save}>
          <Check className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" onClick={cancel}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <button
      className="group flex items-center gap-1.5 text-right tabular-nums hover:text-primary transition-colors"
      onClick={start}
    >
      <span className="font-mono text-sm">{value ? fmtCHFDec(value) : <span className="text-muted-foreground italic text-xs">–</span>}</span>
      <Edit2 className="h-3 w-3 opacity-0 group-hover:opacity-50 transition-opacity shrink-0" />
    </button>
  );
};

// ── Hauptseite ────────────────────────────────────────────────────────────────

export default function PersonalFixPage() {
  const { isAdmin } = usePermissions();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState<string | null>(null);
  const currentYear  = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  useEffect(() => {
    loadEmployees().then(emps => {
      if (emps) setEmployees(emps);
      setLoading(false);
    });
  }, []);

  // ── Budget-Personalkosten für Vergleich ──────────────────────────────────
  const budgetData = useBudgetMonth(currentYear, currentMonth);
  const personnelBudget = budgetData.personnelBudget;

  // ── Berechnungen ─────────────────────────────────────────────────────────
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

  const fixedEmployees = useMemo(() =>
    employees.filter(hasFixedSalary).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [employees],
  );

  const variableEmployees = useMemo(() =>
    employees.filter(e => !hasFixedSalary(e)).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [employees],
  );

  const totalFixCost     = fixedEmployees.reduce((s, e) => s + getFixCost(e), 0);
  const totalFixBase     = fixedEmployees.reduce((s, e) => s + (e.monthlySalary ?? 0), 0);
  const totalFixAnnual   = totalFixCost * 12;

  const byDept = useMemo(() => {
    const map: Record<string, Employee[]> = {};
    for (const e of fixedEmployees) {
      if (!map[e.department]) map[e.department] = [];
      map[e.department].push(e);
    }
    return map;
  }, [fixedEmployees]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <DollarSign className="h-5 w-5 text-muted-foreground shrink-0" />
          <div>
            <h1 className="text-base font-bold leading-tight">Personal FIX</h1>
            <p className="text-xs text-muted-foreground">Fixe Monatslöhne · Übersicht & Vergleich {currentYear}</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">

        {/* ── KPI-Zusammenfassung ─────────────────────────────────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            title="Personal FIX / Monat"
            value={fmtCHF(totalFixCost)}
            sub={`${fixedEmployees.length} Mitarbeiter mit Fixlohn`}
            icon={<DollarSign className="h-5 w-5" />}
            color="blue"
          />
          <KpiCard
            title="Personal FIX / Jahr"
            value={fmtCHF(totalFixAnnual)}
            sub="12 × Monats-Fixkosten"
            icon={<TrendingUp className="h-5 w-5" />}
            color="default"
          />
          <KpiCard
            title="Basis (ohne 13.)"
            value={fmtCHF(totalFixBase)}
            sub="Monatslohn netto"
            icon={<Users className="h-5 w-5" />}
            color="default"
          />
          {personnelBudget > 0 && (
            <KpiCard
              title="Budget Personalkosten"
              value={fmtCHF(personnelBudget)}
              sub={`Jahresplan ${currentYear}`}
              icon={<BookOpen className="h-5 w-5" />}
              color={totalFixAnnual > personnelBudget ? 'red' : 'green'}
              delta={totalFixAnnual - personnelBudget}
              deltaLabel="FIX vs. Budget/Jahr"
            />
          )}
        </div>

        {/* ── Erklärung ───────────────────────────────────────────────────── */}
        <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20 p-3 text-xs text-blue-800 dark:text-blue-200">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <p>
            <strong>Personal FIX</strong> zeigt die garantierten monatlichen Lohnkosten unabhängig von geplanten oder effektiven Stunden.
            Die «Fix-Kosten» entsprechen dem Monatslohn <em>inkl. 13. Monatslohn</em> (amortisiert, falls zutreffend).
            Klicke auf einen Wert um ihn direkt zu bearbeiten.
          </p>
        </div>

        {/* ── Tabelle nach Abteilung ──────────────────────────────────────── */}
        {Object.entries(byDept).map(([dept, emps]) => {
          const deptTotal    = emps.reduce((s, e) => s + getFixCost(e), 0);
          const deptBase     = emps.reduce((s, e) => s + (e.monthlySalary ?? 0), 0);
          return (
            <section key={dept} className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
              {/* Abteilungs-Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  {DEPT_ICON[dept]}
                  {DEPT_LABEL[dept] ?? dept}
                  <Badge variant="secondary" className="text-xs">{emps.length}</Badge>
                </div>
                <div className="flex items-center gap-6 text-xs text-muted-foreground">
                  <span>Basis: <strong className="text-foreground font-mono">{fmtCHF(deptBase)}</strong>/Mt</span>
                  <span>FIX (inkl. 13.): <strong className="text-foreground font-mono">{fmtCHF(deptTotal)}</strong>/Mt</span>
                </div>
              </div>

              {/* Tabelle */}
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
                    {emps.map(emp => {
                      const fix = getFixCost(emp);
                      const isSavingThis = saving === emp.id;
                      return (
                        <tr
                          key={emp.id}
                          className={cn('hover:bg-muted/30 transition-colors', isSavingThis && 'opacity-50')}
                        >
                          <td className="px-4 py-2.5 font-medium">{emp.name}</td>
                          <td className="px-4 py-2.5">
                            <Badge variant="outline" className="text-xs">{EMP_TYPE_LABEL[emp.employmentType]}</Badge>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {isAdmin ? (
                              <InlineSalaryEditor
                                empId={emp.id}
                                field="monthlySalary"
                                value={emp.monthlySalary}
                                onSaved={handleSaved}
                              />
                            ) : (
                              <span className="font-mono text-sm">{emp.monthlySalary ? fmtCHFDec(emp.monthlySalary) : '–'}</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {isAdmin ? (
                              <InlineSalaryEditor
                                empId={emp.id}
                                field="monthlySalaryWith13th"
                                value={emp.monthlySalaryWith13th}
                                onSaved={handleSaved}
                              />
                            ) : (
                              <span className="font-mono text-sm">{emp.monthlySalaryWith13th ? fmtCHFDec(emp.monthlySalaryWith13th) : '–'}</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right font-semibold font-mono text-blue-700 dark:text-blue-400">
                            {fix > 0 ? fmtCHF(fix) : <span className="text-muted-foreground">–</span>}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-muted-foreground text-sm">
                            {fix > 0 ? fmtCHF(fix * 12) : '–'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {/* Abteilungs-Total */}
                  <tfoot>
                    <tr className="bg-muted/20 font-semibold border-t-2 border-border">
                      <td className="px-4 py-2.5 text-sm" colSpan={2}>Total {DEPT_LABEL[dept] ?? dept}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{fmtCHF(deptBase)}</td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        {fmtCHF(emps.reduce((s, e) => s + (e.monthlySalaryWith13th ?? 0), 0))}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-blue-700 dark:text-blue-400">{fmtCHF(deptTotal)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{fmtCHF(deptTotal * 12)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          );
        })}

        {/* ── Gesamt-Total ────────────────────────────────────────────────── */}
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

        {/* ── Variable / ohne Fixlohn ──────────────────────────────────────── */}
        {variableEmployees.length > 0 && (
          <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Variable Mitarbeiter — kein Fixlohn</span>
              <Badge variant="outline" className="text-xs">{variableEmployees.length}</Badge>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium">Name</th>
                    <th className="text-left px-4 py-2 font-medium">Abteilung</th>
                    <th className="text-left px-4 py-2 font-medium">Anstellung</th>
                    <th className="text-right px-4 py-2 font-medium">Stundenlohn</th>
                    <th className="text-right px-4 py-2 font-medium">Wochenstunden</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {variableEmployees.map(emp => (
                    <tr key={emp.id} className="hover:bg-muted/30 transition-colors text-muted-foreground">
                      <td className="px-4 py-2 font-medium text-foreground">{emp.name}</td>
                      <td className="px-4 py-2">{DEPT_LABEL[emp.department] ?? emp.department}</td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-xs">{EMP_TYPE_LABEL[emp.employmentType]}</Badge>
                      </td>
                      <td className="px-4 py-2 text-right font-mono">{fmtCHFDec(emp.hourlyWage)}/h</td>
                      <td className="px-4 py-2 text-right font-mono">{emp.weeklyHours ?? '–'} h/W</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

      </main>
    </div>
  );
}
