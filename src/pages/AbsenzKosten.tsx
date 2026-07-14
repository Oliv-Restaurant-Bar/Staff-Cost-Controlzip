import { useState, useMemo, useEffect, useCallback } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, addMonths, subMonths } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  ChevronLeft, ChevronRight, Palmtree, Stethoscope, Users,
  TrendingDown, TrendingUp, Pencil, Check, X, Info, RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from '@/components/ui/tooltip';
import { toast } from 'sonner';
import type { Employee } from '@/types/personnel';
import { DaySchedule } from '@/components/schedule-planner/ScheduleGrid';
import { resolveBreakHours } from '@/hooks/useShiftConfig';
import { loadActualHoursForMonth } from '@/lib/supabase-db';
import { useTenant } from '@/contexts/TenantContext';

// ─── Constants ────────────────────────────────────────────────────────────────

const VACATION_CODES = new Set(['FE', 'FW', 'Ferien', 'Urlaub', 'U']);
const SICK_CODES     = new Set(['K', 'KO', 'Krank', 'Krankheit', 'AUF']);
const DEFAULT_ABSENCE_HOURS = 8.4; // standard day when weeklyHours unknown

const LS_OVERRIDES = 'absence_overrides_v1';

// ─── Types ────────────────────────────────────────────────────────────────────

type AbsenceKind = 'vacation' | 'sick' | 'other';

interface ReplacementInfo {
  empId: string;
  empName: string;
  hours: number;
  hourlyWage: number;
  cost: number;
  source: 'plan' | 'actual';
}

interface AbsenceEvent {
  id: string;              // `${empId}-${date}`
  empId: string;
  empName: string;
  dept: 'service' | 'küche';
  date: string;            // YYYY-MM-DD
  absenceCode: string;     // raw code e.g. 'FE', 'K'
  kind: AbsenceKind;
  plannedHours: number;    // from override or employee contract
  autoReplacements: ReplacementInfo[];
}

interface Override {
  plannedHoursOverride?: number;
  addedEmpIds: string[];       // manually added var emps
  removedAutoEmpIds: string[]; // auto-detected but user removed
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function absenceKind(code: string): AbsenceKind {
  if (VACATION_CODES.has(code)) return 'vacation';
  if (SICK_CODES.has(code))     return 'sick';
  return 'other';
}

function absenceLabel(kind: AbsenceKind): string {
  if (kind === 'vacation') return 'Ferien';
  if (kind === 'sick')     return 'Krank';
  return 'Abwesenheit';
}

function isFixed(e: Employee): boolean {
  return (e.employmentType === 'vollzeit' || e.employmentType === 'teilzeit') &&
         (e.monthlySalary ?? 0) > 0;
}

function isVariable(e: Employee): boolean {
  return e.employmentType === 'aushilfe' || e.employmentType === 'minijob' ||
         !isFixed(e);
}

function slotHours(slot: { start: string; end: string } | null | undefined): number {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return Math.round(mins / 6) / 10;
}

function netHoursFromSchedule(ds: DaySchedule): number {
  const gross = slotHours(ds.früh) + slotHours(ds.spät);
  return gross > 0 ? Math.max(0, gross - resolveBreakHours(gross, ds.breakMinutes)) : 0;
}

function formatCHF(v: number): string {
  return new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(v);
}

function scheduleKey(d: Date): string {
  return `schedule-v2-${format(d, 'yyyy-MM')}`;
}
function actualKey(d: Date): string {
  return `actual-hours-${format(d, 'yyyy-MM')}`;
}

function loadEmployees(keyFn: (k: string) => string = k => k): Employee[] {
  try {
    const raw = localStorage.getItem(keyFn('schedule-employees'));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function loadSchedule(month: Date, keyFn: (k: string) => string = k => k): Record<string, DaySchedule> {
  try {
    const raw = localStorage.getItem(keyFn(scheduleKey(month)));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function loadOverrides(keyFn: (k: string) => string = k => k): Record<string, Override> {
  try {
    const raw = localStorage.getItem(keyFn(LS_OVERRIDES));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveOverrides(o: Record<string, Override>, keyFn: (k: string) => string = k => k): void {
  localStorage.setItem(keyFn(LS_OVERRIDES), JSON.stringify(o));
}

function plannedHoursFor(emp: Employee, code: string): number {
  // Use weeklyHours-based estimate; fall back to the standard absence hours constant
  if (emp.weeklyHours && emp.weeklyHours > 0) {
    // typical hours per working day based on weekly hours over 5 days
    return Math.round((emp.weeklyHours / 5) * 10) / 10;
  }
  // FE/K configs have 8.4h hardcoded in useShiftConfig
  return DEFAULT_ABSENCE_HOURS;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AbsenzKosten() {
  const { tenantId, tenantKey } = useTenant();
  const [month, setMonth] = useState<Date>(startOfMonth(new Date()));
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [scheduleData, setScheduleData] = useState<Record<string, DaySchedule>>({});
  const [actualHours, setActualHours] = useState<Record<string, { hours: number }>>({});
  const [overrides, setOverrides] = useState<Record<string, Override>>(() => loadOverrides(tenantKey));
  const [editEvent, setEditEvent] = useState<AbsenceEvent | null>(null);
  const [editOverride, setEditOverride] = useState<Override>({ addedEmpIds: [], removedAutoEmpIds: [] });
  const [editPlannedHours, setEditPlannedHours] = useState<string>('');

  // ── Load data on month change ──────────────────────────────────────────────
  useEffect(() => {
    const emps = loadEmployees(tenantKey);
    setEmployees(emps);
    setScheduleData(loadSchedule(month, tenantKey));
    // Load actual hours: try localStorage first, then Supabase
    const localActual = localStorage.getItem(tenantKey(actualKey(month)));
    if (localActual) {
      try { setActualHours(JSON.parse(localActual)); } catch { setActualHours({}); }
    } else {
      loadActualHoursForMonth(month, tenantId).then(res => {
        if (res) setActualHours(res as Record<string, { hours: number }>);
      }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, tenantId]);

  // ── Days in month ─────────────────────────────────────────────────────────
  const daysInMonth = useMemo(
    () => eachDayOfInterval({ start: startOfMonth(month), end: endOfMonth(month) }),
    [month]
  );

  // ── Build absence events ───────────────────────────────────────────────────
  const absenceEvents = useMemo((): AbsenceEvent[] => {
    const fixedEmps = employees.filter(isFixed);
    const varEmps   = employees.filter(isVariable);
    const events: AbsenceEvent[] = [];

    for (const emp of fixedEmps) {
      for (const day of daysInMonth) {
        const dateStr  = format(day, 'yyyy-MM-dd');
        const cellKey  = `${emp.id}-${dateStr}`;
        const ds       = scheduleData[cellKey];
        if (!ds) continue;

        // Collect absence codes — treat früh/spät as same day (one event)
        const codes = new Set<string>();
        if (ds.frühAbsence) codes.add(ds.frühAbsence);
        if (ds.spätAbsence) codes.add(ds.spätAbsence);
        if (codes.size === 0) continue;

        // Use the first code (usually both slots have same absence type)
        const absenceCode = [...codes][0];
        const kind        = absenceKind(absenceCode);

        // Only track vacation and sick (not generic Frei)
        if (kind === 'other' && !VACATION_CODES.has(absenceCode) && !SICK_CODES.has(absenceCode)) {
          // Skip 'Frei' (F) and other non-absence codes
          if (absenceCode === 'F' || absenceCode === 'Frei') continue;
        }

        const plannedHours = plannedHoursFor(emp, absenceCode);

        // Auto-detect replacements: var emps in same dept with real shifts that day
        const autoReplacements: ReplacementInfo[] = [];
        for (const varEmp of varEmps) {
          if (varEmp.department !== emp.department) continue;
          const vKey   = `${varEmp.id}-${dateStr}`;
          const vDs    = scheduleData[vKey];
          const vActual = actualHours[vKey];

          let hours = 0;
          let source: 'plan' | 'actual' = 'plan';

          if (vActual?.hours && vActual.hours > 0) {
            hours  = vActual.hours;
            source = 'actual';
          } else if (vDs && !vDs.frühAbsence && !vDs.spätAbsence) {
            hours  = netHoursFromSchedule(vDs);
            source = 'plan';
          }

          if (hours > 0) {
            autoReplacements.push({
              empId:      varEmp.id,
              empName:    varEmp.name,
              hours,
              hourlyWage: varEmp.hourlyWage ?? 0,
              cost:       hours * (varEmp.hourlyWage ?? 0),
              source,
            });
          }
        }

        events.push({
          id:           `${emp.id}-${dateStr}`,
          empId:        emp.id,
          empName:      emp.name,
          dept:         emp.department,
          date:         dateStr,
          absenceCode,
          kind,
          plannedHours,
          autoReplacements,
        });
      }
    }

    return events.sort((a, b) => a.date.localeCompare(b.date));
  }, [employees, daysInMonth, scheduleData, actualHours]);

  // ── Apply overrides to get effective replacements ─────────────────────────
  const resolveEvent = useCallback((ev: AbsenceEvent) => {
    const ovr = overrides[ev.id];
    const plannedHours = ovr?.plannedHoursOverride ?? ev.plannedHours;

    // Start with auto, remove any manually removed, add manually added
    const removed = new Set(ovr?.removedAutoEmpIds ?? []);
    const effective = ev.autoReplacements.filter(r => !removed.has(r.empId));

    // Add manually added employees
    if (ovr?.addedEmpIds?.length) {
      for (const empId of ovr.addedEmpIds) {
        if (effective.some(r => r.empId === empId)) continue;
        const emp = employees.find(e => e.id === empId);
        if (!emp) continue;
        const dateStr  = ev.date;
        const vKey     = `${empId}-${dateStr}`;
        const vDs      = scheduleData[vKey];
        const vActual  = actualHours[vKey];
        let hours = 0;
        let source: 'plan' | 'actual' = 'plan';
        if (vActual?.hours && vActual.hours > 0) { hours = vActual.hours; source = 'actual'; }
        else if (vDs) { hours = netHoursFromSchedule(vDs); }
        if (hours === 0) hours = plannedHours; // fallback: assume full coverage
        effective.push({ empId, empName: emp.name, hours, hourlyWage: emp.hourlyWage ?? 0, cost: hours * (emp.hourlyWage ?? 0), source });
      }
    }

    const replacedHours = effective.reduce((s, r) => s + r.hours, 0);
    const replacedCost  = effective.reduce((s, r) => s + r.cost, 0);
    const unreplacedHours = Math.max(0, plannedHours - replacedHours);
    // Estimate saving: avg replacement wage × unreplaced hours
    const avgWage = effective.length > 0
      ? effective.reduce((s, r) => s + r.hourlyWage, 0) / effective.length
      : (employees.filter(isVariable).reduce((s, e) => s + (e.hourlyWage ?? 0), 0) / Math.max(1, employees.filter(isVariable).length));
    const saving = unreplacedHours * avgWage;

    return { ...ev, plannedHours, effectiveReplacements: effective, replacedHours, replacedCost, unreplacedHours, saving };
  }, [overrides, employees, scheduleData, actualHours]);

  const resolved = useMemo(() => absenceEvents.map(resolveEvent), [absenceEvents, resolveEvent]);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const vacation = resolved.filter(e => e.kind === 'vacation');
    const sick     = resolved.filter(e => e.kind === 'sick');
    const all      = resolved;
    return {
      vacationDays:   vacation.length,
      sickDays:       sick.length,
      vacationCost:   vacation.reduce((s, e) => s + e.replacedCost, 0),
      sickCost:       sick.reduce((s, e) => s + e.replacedCost, 0),
      totalCost:      all.reduce((s, e) => s + e.replacedCost, 0),
      totalSaving:    all.reduce((s, e) => s + e.saving, 0),
      unreplacedHrs:  all.reduce((s, e) => s + e.unreplacedHours, 0),
    };
  }, [resolved]);

  // ── Edit dialog helpers ───────────────────────────────────────────────────
  const openEdit = (ev: AbsenceEvent) => {
    const ovr = overrides[ev.id] ?? { addedEmpIds: [], removedAutoEmpIds: [] };
    setEditEvent(ev);
    setEditOverride({ addedEmpIds: [...(ovr.addedEmpIds ?? [])], removedAutoEmpIds: [...(ovr.removedAutoEmpIds ?? [])] });
    setEditPlannedHours(String(ovr.plannedHoursOverride ?? ev.plannedHours));
  };

  const saveEdit = () => {
    if (!editEvent) return;
    const parsed = parseFloat(editPlannedHours);
    const newOvr: Override = {
      ...editOverride,
      plannedHoursOverride: !isNaN(parsed) && parsed !== editEvent.plannedHours ? parsed : undefined,
    };
    const next = { ...overrides, [editEvent.id]: newOvr };
    setOverrides(next);
    saveOverrides(next, tenantKey);
    setEditEvent(null);
    toast.success('Manuelle Anpassung gespeichert');
  };

  const resetOverride = (id: string) => {
    const next = { ...overrides };
    delete next[id];
    setOverrides(next);
    saveOverrides(next, tenantKey);
    toast.success('Zurückgesetzt');
  };

  // Variable employees in same dept as editEvent
  const varEmpsForEdit = useMemo(() => {
    if (!editEvent) return [];
    return employees.filter(e => isVariable(e) && e.department === editEvent.dept);
  }, [editEvent, employees]);

  const toggleAutoRemove = (empId: string) => {
    setEditOverride(prev => {
      const removed = new Set(prev.removedAutoEmpIds);
      if (removed.has(empId)) removed.delete(empId); else removed.add(empId);
      return { ...prev, removedAutoEmpIds: [...removed] };
    });
  };

  const toggleManualAdd = (empId: string) => {
    setEditOverride(prev => {
      const added = new Set(prev.addedEmpIds);
      if (added.has(empId)) added.delete(empId); else added.add(empId);
      return { ...prev, addedEmpIds: [...added] };
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const monthLabel = format(month, 'MMMM yyyy', { locale: de });

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-6">

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Absenzen & Ersatzkosten</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Ferien- und Krankenabwesenheiten fixer Mitarbeiter — Ersatzkosten & Einsparungen
          </p>
        </div>
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setMonth(m => startOfMonth(subMonths(m, 1)))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium px-3 min-w-[140px] text-center">{monthLabel}</span>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setMonth(m => startOfMonth(addMonths(m, 1)))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard
          icon={<Palmtree className="h-4 w-4 text-amber-600" />}
          label="Ferientage"
          value={`${kpis.vacationDays} Tage`}
          bg="bg-amber-50 dark:bg-amber-950/20"
          border="border-amber-200 dark:border-amber-800"
        />
        <KpiCard
          icon={<Stethoscope className="h-4 w-4 text-blue-600" />}
          label="Kranktage"
          value={`${kpis.sickDays} Tage`}
          bg="bg-blue-50 dark:bg-blue-950/20"
          border="border-blue-200 dark:border-blue-800"
        />
        <KpiCard
          icon={<Users className="h-4 w-4 text-purple-600" />}
          label="Ferienersatzkosten"
          value={formatCHF(kpis.vacationCost)}
          sub="Krankheit: " subVal={formatCHF(kpis.sickCost)}
          bg="bg-purple-50 dark:bg-purple-950/20"
          border="border-purple-200 dark:border-purple-800"
        />
        <KpiCard
          icon={<TrendingUp className="h-4 w-4 text-rose-600" />}
          label="Total Ersatzkosten"
          value={formatCHF(kpis.totalCost)}
          bg="bg-rose-50 dark:bg-rose-950/20"
          border="border-rose-200 dark:border-rose-800"
        />
        <KpiCard
          icon={<TrendingDown className="h-4 w-4 text-green-600" />}
          label="Geschätzte Einsparung"
          value={formatCHF(kpis.totalSaving)}
          sub={`${kpis.unreplacedHrs.toFixed(1)} Std nicht ersetzt`}
          bg="bg-green-50 dark:bg-green-950/20"
          border="border-green-200 dark:border-green-800"
        />
      </div>

      {/* ── Legend / How it works ── */}
      <InfoBox />

      {/* ── Events Table ── */}
      {resolved.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
          <Palmtree className="h-10 w-10 opacity-30" />
          <p className="text-sm font-medium">Keine Abwesenheiten in {monthLabel} erfasst</p>
          <p className="text-xs opacity-70">Ferien (FE) und Krank (K) aus dem Dienstplan werden hier automatisch erkannt.</p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
                  <th className="text-left px-4 py-3 font-medium">Datum</th>
                  <th className="text-left px-4 py-3 font-medium">Mitarbeiter</th>
                  <th className="text-left px-4 py-3 font-medium">Typ</th>
                  <th className="text-left px-4 py-3 font-medium">Abt.</th>
                  <th className="text-right px-4 py-3 font-medium">Geplante Std</th>
                  <th className="text-left px-4 py-3 font-medium">Ersatz</th>
                  <th className="text-right px-4 py-3 font-medium">Ersetzte Std</th>
                  <th className="text-right px-4 py-3 font-medium">Ersatzkosten</th>
                  <th className="text-right px-4 py-3 font-medium">Einsparung</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {resolved.map(ev => {
                  const hasOverride = !!overrides[ev.id];
                  const fullyReplaced = ev.replacedHours >= ev.plannedHours * 0.95;
                  const partiallyReplaced = !fullyReplaced && ev.replacedHours > 0;
                  const notReplaced = ev.replacedHours === 0;

                  return (
                    <tr key={ev.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">
                        {format(new Date(ev.date + 'T00:00:00'), 'EEE dd.MM.', { locale: de })}
                      </td>
                      <td className="px-4 py-3 font-medium">{ev.empName}</td>
                      <td className="px-4 py-3">
                        <AbsenceBadge kind={ev.kind} code={ev.absenceCode} />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground capitalize">{ev.dept}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {ev.plannedHours.toFixed(1)} h
                        {hasOverride && <span className="ml-1 text-xs text-amber-500">*</span>}
                      </td>
                      <td className="px-4 py-3 max-w-[180px]">
                        {ev.effectiveReplacements.length === 0 ? (
                          <span className="text-muted-foreground text-xs">— kein Ersatz</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {ev.effectiveReplacements.map(r => (
                              <Tooltip key={r.empId}>
                                <TooltipTrigger>
                                  <span className="inline-flex items-center gap-1 text-xs bg-muted rounded-full px-2 py-0.5 border">
                                    {r.empName.split(' ')[0]}
                                    <span className="text-muted-foreground">({r.hours.toFixed(1)}h)</span>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {r.empName} — {r.hours.toFixed(1)} h × CHF {r.hourlyWage.toFixed(2)}/h = CHF {r.cost.toFixed(2)}
                                  <br />Quelle: {r.source === 'actual' ? 'Ist-Stunden' : 'Plan-Stunden'}
                                </TooltipContent>
                              </Tooltip>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span className={
                          fullyReplaced    ? 'text-green-600 font-medium' :
                          partiallyReplaced ? 'text-amber-600 font-medium' :
                          notReplaced       ? 'text-muted-foreground' : ''
                        }>
                          {ev.replacedHours.toFixed(1)} h
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">
                        {ev.replacedCost > 0 ? formatCHF(ev.replacedCost) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-green-600 font-medium">
                        {ev.saving > 0 ? formatCHF(ev.saving) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          {hasOverride && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => resetOverride(ev.id)}>
                                  <RotateCcw className="h-3 w-3 text-muted-foreground" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Manuelle Anpassung zurücksetzen</TooltipContent>
                            </Tooltip>
                          )}
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(ev)}>
                            <Pencil className="h-3 w-3 text-muted-foreground" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Table footer summary */}
          <div className="border-t bg-muted/30 px-4 py-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span><strong className="text-foreground">{resolved.length}</strong> Abwesenheitstage total</span>
            <span>Ferienersatz: <strong className="text-foreground">{formatCHF(kpis.vacationCost)}</strong></span>
            <span>Krankheitsersatz: <strong className="text-foreground">{formatCHF(kpis.sickCost)}</strong></span>
            <span>Einsparung (nicht ersetzt): <strong className="text-green-600">{formatCHF(kpis.totalSaving)}</strong></span>
          </div>
        </div>
      )}

      {/* ── Edit / Override Dialog ── */}
      <Dialog open={!!editEvent} onOpenChange={open => { if (!open) setEditEvent(null); }}>
        <DialogContent style={{ display: 'flex', flexDirection: 'column', maxHeight: '88vh' }}>
          <DialogHeader>
            <DialogTitle>Abwesenheit bearbeiten</DialogTitle>
            {editEvent && (
              <p className="text-sm text-muted-foreground">
                {editEvent.empName} — {format(new Date(editEvent.date + 'T00:00:00'), 'EEEE, dd. MMMM yyyy', { locale: de })}
              </p>
            )}
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-5 py-2">
            {/* Planned hours override */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Geplante Stunden (Abwesenheitstag)</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  step="0.5"
                  min="0"
                  max="24"
                  value={editPlannedHours}
                  onChange={e => setEditPlannedHours(e.target.value)}
                  className="w-28"
                />
                <span className="text-sm text-muted-foreground">Stunden</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Standard wird aus Wochenpensum abgeleitet (Std/Woche ÷ 5 Tage).
              </p>
            </div>

            <Separator />

            {/* Auto-detected replacements */}
            {editEvent && editEvent.autoReplacements.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">Automatisch erkannte Ersatzmitarbeiter</Label>
                <p className="text-xs text-muted-foreground">
                  Aushilfen in der gleichen Abteilung mit Schichten an diesem Tag. Abwählen wenn falsch.
                </p>
                <div className="space-y-1.5">
                  {editEvent.autoReplacements.map(r => {
                    const isRemoved = editOverride.removedAutoEmpIds.includes(r.empId);
                    return (
                      <label key={r.empId} className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${isRemoved ? 'opacity-50 bg-muted/20' : 'bg-muted/40 hover:bg-muted/60'}`}>
                        <Checkbox
                          checked={!isRemoved}
                          onCheckedChange={() => toggleAutoRemove(r.empId)}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm">{r.empName}</p>
                          <p className="text-xs text-muted-foreground">
                            {r.hours.toFixed(1)} h × CHF {r.hourlyWage.toFixed(2)} = CHF {r.cost.toFixed(2)}
                            &nbsp;· Quelle: {r.source === 'actual' ? 'Ist' : 'Plan'}
                          </p>
                        </div>
                        {!isRemoved && <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />}
                        {isRemoved  && <X   className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Manually add additional var employees */}
            {varEmpsForEdit.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">Weitere Ersatzmitarbeiter manuell hinzufügen</Label>
                <p className="text-xs text-muted-foreground">
                  Aushilfen der gleichen Abteilung, die nicht automatisch erkannt wurden.
                </p>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {varEmpsForEdit
                    .filter(e => !editEvent?.autoReplacements.some(r => r.empId === e.id))
                    .map(e => {
                      const isAdded = editOverride.addedEmpIds.includes(e.id);
                      return (
                        <label key={e.id} className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${isAdded ? 'bg-blue-50 dark:bg-blue-950/20 border-blue-200' : 'hover:bg-muted/40'}`}>
                          <Checkbox
                            checked={isAdded}
                            onCheckedChange={() => toggleManualAdd(e.id)}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{e.name}</p>
                            <p className="text-xs text-muted-foreground">CHF {(e.hourlyWage ?? 0).toFixed(2)}/h</p>
                          </div>
                        </label>
                      );
                    })}
                </div>
              </div>
            )}

            {editEvent?.autoReplacements.length === 0 && varEmpsForEdit.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                Keine Aushilfen in der Abteilung {editEvent?.dept} verfügbar.
              </p>
            )}
          </div>

          <DialogFooter className="pt-2 border-t">
            <Button variant="outline" onClick={() => setEditEvent(null)}>Abbrechen</Button>
            <Button onClick={saveEdit}>Speichern</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function KpiCard({ icon, label, value, sub, subVal, bg, border }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  subVal?: string;
  bg: string;
  border: string;
}) {
  return (
    <Card className={`${bg} ${border} border`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          {icon}
          <span className="text-xs font-medium text-muted-foreground leading-tight">{label}</span>
        </div>
        <p className="text-xl font-bold tracking-tight">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}{subVal}</p>}
      </CardContent>
    </Card>
  );
}

function AbsenceBadge({ kind, code }: { kind: AbsenceKind; code: string }) {
  if (kind === 'vacation') return (
    <Badge className="bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700 gap-1">
      <Palmtree className="h-3 w-3" /> Ferien
    </Badge>
  );
  if (kind === 'sick') return (
    <Badge className="bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700 gap-1">
      <Stethoscope className="h-3 w-3" /> Krank
    </Badge>
  );
  return <Badge variant="outline">{code}</Badge>;
}

function InfoBox() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border bg-muted/30 px-4 py-3">
      <button
        className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors w-full text-left"
        onClick={() => setOpen(o => !o)}
      >
        <Info className="h-4 w-4 shrink-0" />
        <span>Wie funktioniert die automatische Erkennung?</span>
        <ChevronLeft className={`h-3.5 w-3.5 ml-auto transition-transform ${open ? '-rotate-90' : 'rotate-180'}`} />
      </button>
      {open && (
        <div className="mt-3 space-y-2.5 text-sm text-muted-foreground border-t pt-3">
          <div>
            <p className="font-medium text-foreground mb-0.5">Automatische Ersatzerkennung</p>
            <p>Das System erkennt Ersatzschichten automatisch: Aushilfen derselben Abteilung, die am gleichen Tag einen geplanten oder geleisteten Dienst haben, werden als möglicher Ersatz angezeigt. Ist-Stunden haben Vorrang vor Plan-Stunden.</p>
          </div>
          <div>
            <p className="font-medium text-foreground mb-0.5">Manuelle Zuweisung</p>
            <p>Über den Bearbeiten-Button (Stift) können Sie automatisch erkannte Ersatzmitarbeiter entfernen oder zusätzliche Aushilfen manuell hinzufügen.</p>
          </div>
          <div>
            <p className="font-medium text-foreground mb-0.5">Ersatzkostenberechnung</p>
            <p>Ersatzkosten = Stunden der Aushilfe × Stundenlohn. Der Fixlohn des abwesenden Mitarbeiters wird <em>nicht</em> doppelt gezählt — er bleibt unverändert.</p>
          </div>
          <div>
            <p className="font-medium text-foreground mb-0.5">Einsparung durch Nicht-Ersatz</p>
            <p>Wenn ein Ausfall nur teilweise oder gar nicht ersetzt wurde, zeigt das System die geschätzten eingesparten Variablelohnkosten. Nicht ersetzte Stunden × durchschnittlicher Aushilfenlohn der Abteilung.</p>
          </div>
          <div>
            <p className="font-medium text-foreground mb-0.5">Abwesenheitscodes</p>
            <p><strong>FE</strong> = Ferien · <strong>K</strong> = Krank. Diese werden direkt aus dem Dienstplan gelesen — bitte dort die Abwesenheiten korrekt eintragen.</p>
          </div>
        </div>
      )}
    </div>
  );
}
