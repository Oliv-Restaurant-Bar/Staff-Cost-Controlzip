import { useState, useMemo, useEffect } from 'react';
import { format, isWithinInterval } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  CheckCircle2, XCircle, Clock3, TrendingDown, TrendingUp,
  ShieldAlert, Star, ArrowRight, Users, Lightbulb, ChevronDown, ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Employee } from '@/types/personnel';
import { DaySchedule, TimeSlot } from './ScheduleGrid';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';
import {
  buildHourBalances,
  generatePlanningHints,
  fmtBalanceHours,
  normalizeStation,
} from '@/lib/hour-balance-utils';

// ─── Typen ───────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  actualHoursData: Record<string, { hours: number }>;
  displayDays: Date[];          // currently visible days (week or month)
  allMonthDays: Date[];         // all days in the current month
  personnelBudget: number;      // from settings
  totalFixCost: number;         // computed from FIX employees
}

type HintStatus = 'pending' | 'accepted' | 'ignored' | 'later';

const STORAGE_KEY = 'planning_assistant_v1';

function loadStatuses(): Record<string, HintStatus> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'); }
  catch { return {}; }
}
function saveStatuses(data: Record<string, HintStatus>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ─── Slot-Stunden ─────────────────────────────────────────────────────────────

function calcSlotHours(slot: TimeSlot | null | undefined): number {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = (eh - sh) + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.max(0, h);
}

function getMonthHours(
  empId: string,
  monthDays: Date[],
  data: Record<string, DaySchedule>,
): number {
  return monthDays.reduce((s, day) => {
    const key = `${empId}-${format(day, 'yyyy-MM-dd')}`;
    const ds  = data[key];
    if (!ds) return s;
    const gross = calcSlotHours(ds.früh) + calcSlotHours(ds.spät);
    return s + Math.max(0, gross - calculateBreakDeduction(gross));
  }, 0);
}

function getActualMonthHours(
  empId: string,
  monthDays: Date[],
  actual: Record<string, { hours: number }>,
): number {
  return monthDays.reduce((s, day) => {
    const key = `${empId}-${format(day, 'yyyy-MM-dd')}`;
    return s + (actual[key]?.hours ?? 0);
  }, 0);
}

// Stunden in sichtbarer Periode (Woche/Tag)
function getPeriodHours(
  empId: string,
  days: Date[],
  data: Record<string, DaySchedule>,
): number {
  return getMonthHours(empId, days, data);
}

// ─── Farben & Labels ──────────────────────────────────────────────────────────

function balancePillClass(b: number): string {
  if (b <= -15) return 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400';
  if (b < -8)   return 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400';
  if (b < 0)    return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
  if (b === 0)  return 'bg-muted text-muted-foreground';
  if (b <= 15)  return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
  if (b <= 25)  return 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400';
  return 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400';
}

// ─── Status-Aktionen ──────────────────────────────────────────────────────────

function StatusActions({
  hintId,
  status,
  onChange,
}: {
  hintId: string;
  status: HintStatus;
  onChange: (id: string, s: HintStatus) => void;
}) {
  if (status === 'accepted') {
    return (
      <button
        onClick={() => onChange(hintId, 'pending')}
        className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium"
        title="Zurücksetzen"
      >
        <CheckCircle2 className="h-4 w-4" />
        Übernommen
      </button>
    );
  }
  if (status === 'ignored') {
    return (
      <button
        onClick={() => onChange(hintId, 'pending')}
        className="flex items-center gap-1 text-xs text-muted-foreground"
        title="Zurücksetzen"
      >
        <XCircle className="h-4 w-4" />
        Ignoriert
      </button>
    );
  }
  if (status === 'later') {
    return (
      <button
        onClick={() => onChange(hintId, 'pending')}
        className="flex items-center gap-1 text-xs text-blue-500 dark:text-blue-400"
        title="Zurücksetzen"
      >
        <Clock3 className="h-4 w-4" />
        Später
      </button>
    );
  }
  // pending
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onChange(hintId, 'accepted')}
        className="p-1 rounded hover:bg-emerald-100 dark:hover:bg-emerald-950/50 text-emerald-600 transition-colors"
        title="Übernehmen"
      >
        <CheckCircle2 className="h-4 w-4" />
      </button>
      <button
        onClick={() => onChange(hintId, 'later')}
        className="p-1 rounded hover:bg-blue-100 dark:hover:bg-blue-950/50 text-blue-500 transition-colors"
        title="Später prüfen"
      >
        <Clock3 className="h-4 w-4" />
      </button>
      <button
        onClick={() => onChange(hintId, 'ignored')}
        className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-950/50 text-muted-foreground transition-colors"
        title="Ignorieren"
      >
        <XCircle className="h-4 w-4" />
      </button>
    </div>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function PlanningAssistant({
  open,
  onClose,
  employees,
  scheduleData,
  actualHoursData,
  displayDays,
  allMonthDays,
  personnelBudget,
  totalFixCost,
}: Props) {
  const [tab, setTab]           = useState<'einplanen' | 'reduzieren'>('einplanen');
  const [statuses, setStatuses] = useState<Record<string, HintStatus>>(loadStatuses);
  const [showIgnored, setShowIgnored] = useState(false);

  useEffect(() => { if (!open) setTab('einplanen'); }, [open]);

  const updateStatus = (id: string, s: HintStatus) => {
    setStatuses(prev => {
      const next = { ...prev, [id]: s };
      saveStatuses(next);
      return next;
    });
  };

  // ── Budget-Rechnung ──────────────────────────────────────────────────────

  const availableVarBudget = personnelBudget > 0
    ? Math.max(0, personnelBudget - totalFixCost)
    : 0;

  // ── Plan/Ist-Stunden aus vorhandenen Daten aggregieren ───────────────────

  const planHoursMap = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const emp of employees) {
      const h = getMonthHours(emp.id, allMonthDays, scheduleData);
      if (h > 0) map[emp.id] = h;
    }
    return map;
  }, [employees, allMonthDays, scheduleData]);

  const istHoursMap = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const emp of employees) {
      const h = getActualMonthHours(emp.id, allMonthDays, actualHoursData);
      if (h > 0) map[emp.id] = h;
    }
    return map;
  }, [employees, allMonthDays, actualHoursData]);

  // ── Stundensaldi ─────────────────────────────────────────────────────────

  const balances = useMemo(() =>
    buildHourBalances(
      employees,
      planHoursMap,
      istHoursMap,
      (empId) => planHoursMap[empId] ?? 0,
    ),
    [employees, planHoursMap, istHoursMap],
  );

  const balanceByEmpId = useMemo(() => {
    const map: Record<string, typeof balances[0]> = {};
    for (const b of balances) map[b.emp.id] = b;
    return map;
  }, [balances]);

  // Ø Stundenlohn Variable
  const avgVarWage = useMemo(() => {
    const varEmps = employees.filter(e => (e.hourlyWage ?? 0) > 0 && !e.monthlySalary);
    if (!varEmps.length) return 0;
    return varEmps.reduce((s, e) => s + e.hourlyWage, 0) / varEmps.length;
  }, [employees]);

  const remainingVarHours = useMemo(() => {
    const totalVarCost = employees.reduce((s, e) => {
      if (e.monthlySalary) return s;
      return s + (planHoursMap[e.id] ?? 0) * (e.hourlyWage ?? 0);
    }, 0);
    if (availableVarBudget <= 0 || avgVarWage <= 0) return 0;
    const maxH = availableVarBudget / avgVarWage;
    const usedH = employees.reduce((s, e) => {
      if (e.monthlySalary) return s;
      return s + (planHoursMap[e.id] ?? 0);
    }, 0);
    return Math.max(0, maxH - usedH);
  }, [employees, planHoursMap, availableVarBudget, avgVarWage]);

  const hints = useMemo(() =>
    generatePlanningHints(balances, availableVarBudget, remainingVarHours),
    [balances, availableVarBudget, remainingVarHours],
  );

  // ── Periode-Info ─────────────────────────────────────────────────────────

  const periodLabel = useMemo(() => {
    if (!displayDays.length) return '';
    if (displayDays.length === 1)
      return format(displayDays[0], 'EEEE, d. MMMM yyyy', { locale: de });
    return `${format(displayDays[0], 'd.M.')} – ${format(displayDays[displayDays.length - 1], 'd.M.yyyy', { locale: de })}`;
  }, [displayDays]);

  // ── Tab-Inhalte ──────────────────────────────────────────────────────────

  // "Einplanen": alle MA sortiert nach Saldo (negativstes zuerst)
  const einplanenRows = useMemo(() => {
    return balances
      .filter(b => b.hasTarget || b.emp.hourlyWage > 0)
      .map(b => {
        const periodH = getPeriodHours(b.emp.id, displayDays, scheduleData);
        const hintId  = `einplanen-${b.emp.id}`;
        return { b, periodH, hintId };
      })
      .sort((a, b) => a.b.cumulativeBalance - b.b.cumulativeBalance);
  }, [balances, displayDays, scheduleData]);

  // "Reduzieren": MA mit positivem Saldo und Schichten in der aktuellen Periode
  const reduzierenRows = useMemo(() => {
    return balances
      .filter(b => {
        const periodH = getPeriodHours(b.emp.id, displayDays, scheduleData);
        return b.cumulativeBalance >= 10 && periodH > 0;
      })
      .map(b => {
        const periodH = getPeriodHours(b.emp.id, displayDays, scheduleData);
        const hintId  = `reduzieren-${b.emp.id}`;
        return { b, periodH, hintId };
      })
      .sort((a, b) => b.b.cumulativeBalance - a.b.cumulativeBalance);
  }, [balances, displayDays, scheduleData]);

  const einplanenPending  = einplanenRows.filter(r => (statuses[r.hintId] ?? 'pending') === 'pending').length;
  const reduzierenPending = reduzierenRows.filter(r => (statuses[r.hintId] ?? 'pending') === 'pending').length;
  const totalPending = einplanenPending + reduzierenPending;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <TooltipProvider delayDuration={300}>
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent
        className="max-w-2xl w-full"
        style={{ display: 'flex', flexDirection: 'column', maxHeight: '88vh' }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lightbulb className="h-5 w-5 text-indigo-500" />
            Planungshilfe
            {totalPending > 0 && (
              <Badge className="text-[10px] bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300">
                {totalPending} offen
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {periodLabel && <span>{periodLabel} · </span>}
            Regelbasierte Empfehlungen auf Basis von Stundensaldo, Budget und Stationseignung
          </DialogDescription>
        </DialogHeader>

        {/* Budget-Schnellinfo */}
        {personnelBudget > 0 && (
          <div className="flex flex-wrap items-center gap-4 px-3 py-2 rounded-lg border bg-muted/30 text-xs text-muted-foreground">
            <span>
              Variabel-Budget:
              <strong className={cn('ml-1 font-mono',
                availableVarBudget > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
              )}>
                {availableVarBudget.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 })}
              </strong>
              {' '}verfügbar
            </span>
            {remainingVarHours > 0 && (
              <span>
                ≈ <strong className="text-foreground font-mono">{Math.round(remainingVarHours)} h</strong> noch planbar
              </span>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 bg-muted/60 rounded-lg p-0.5 shrink-0">
          {([
            { id: 'einplanen',  label: 'Einplanen',  count: einplanenPending,  icon: <TrendingDown className="h-3.5 w-3.5" /> },
            { id: 'reduzieren', label: 'Reduzieren', count: reduzierenPending, icon: <TrendingUp    className="h-3.5 w-3.5" /> },
          ] as const).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors',
                tab === t.id
                  ? 'bg-white dark:bg-slate-800 shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.icon}
              {t.label}
              {t.count > 0 && (
                <span className={cn(
                  'px-1.5 py-0.5 rounded-full text-[10px] font-bold',
                  tab === t.id
                    ? t.id === 'einplanen' ? 'bg-orange-100 text-orange-700' : 'bg-violet-100 text-violet-700'
                    : 'bg-muted text-muted-foreground',
                )}>{t.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* Tab-Inhalt */}
        <div className="overflow-y-auto flex-1 min-h-0 space-y-2 pr-1">

          {/* ── TAB: Einplanen ────────────────────────────────────────── */}
          {tab === 'einplanen' && (
            <>
              <p className="text-xs text-muted-foreground px-1">
                Mitarbeiter mit Minussaldo sind bevorzugt einzuplanen. Mitarbeiter mit hohem Plussaldo
                sollten geschont werden. Station/Positionseignung wird separat ausgewiesen.
              </p>

              {einplanenRows.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">
                  Keine Mitarbeiter gefunden (Wochenstunden hinterlegen im Personalstamm).
                </p>
              )}

              {einplanenRows
                .filter(r => showIgnored || (statuses[r.hintId] ?? 'pending') !== 'ignored')
                .map(({ b, periodH, hintId }) => {
                  const status   = statuses[hintId] ?? 'pending';
                  const balance  = b.cumulativeBalance;
                  const isMinus  = balance < -8;
                  const isPlus   = balance > 15;
                  const isNeutral = !isMinus && !isPlus;
                  const dept     = b.emp.department === 'küche' ? 'Küche' : 'Service';

                  return (
                    <div
                      key={hintId}
                      className={cn(
                        'rounded-lg border px-3 py-2.5 flex flex-wrap items-start gap-3',
                        status === 'accepted' ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/10 opacity-70'
                        : status === 'ignored' ? 'border-border bg-muted/20 opacity-40'
                        : status === 'later'   ? 'border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/10 opacity-80'
                        : isMinus ? 'border-orange-200 dark:border-orange-800 bg-orange-50/40 dark:bg-orange-950/10'
                        : isPlus  ? 'border-violet-200 dark:border-violet-800 bg-violet-50/30 dark:bg-violet-950/10'
                        : 'border-border bg-card',
                      )}
                    >
                      {/* Icon */}
                      <div className="mt-0.5 shrink-0">
                        {isMinus ? <TrendingDown className={cn('h-4 w-4', balance < -15 ? 'text-red-500' : 'text-orange-500')} />
                        : isPlus ? <TrendingUp className="h-4 w-4 text-violet-500" />
                        : <Users className="h-4 w-4 text-muted-foreground" />}
                      </div>

                      {/* Inhalt */}
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold">{b.emp.name}</span>
                          <Badge variant="outline" className="text-[10px]">{dept}</Badge>
                          {b.station && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  variant="outline"
                                  className={cn('text-[10px] cursor-help',
                                    b.isUniqueInStation
                                      ? 'border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300'
                                      : 'border-indigo-200 text-indigo-700 bg-indigo-50 dark:bg-indigo-950/30 dark:text-indigo-300'
                                  )}
                                >
                                  {b.isUniqueInStation && <ShieldAlert className="h-2.5 w-2.5 mr-0.5" />}
                                  {b.emp.positionTitle}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                {b.isUniqueInStation
                                  ? `Einzige ${b.emp.positionTitle} in ${dept} — kein gleichwertiger Ersatz`
                                  : `Mögliche Alternativen: ${b.stationPeers.join(', ')}`}
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {b.hasTarget && (
                            <span className={cn('text-xs font-mono font-semibold px-1.5 py-0.5 rounded', balancePillClass(balance))}>
                              {fmtBalanceHours(balance)}
                            </span>
                          )}
                        </div>

                        {/* Empfehlung */}
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {isMinus && balance < -15
                            ? `Dringend einplanen — ${Math.abs(balance).toFixed(1)} h Minussaldo${b.station ? ` (${b.emp.positionTitle})` : ''}. Aktuell ${periodH > 0 ? `${periodH.toFixed(1)} h geplant` : 'keine Schichten geplant'}.`
                          : isMinus
                            ? `Bevorzugt einplanen — ${Math.abs(balance).toFixed(1)} h Minussaldo. Aktuell ${periodH > 0 ? `${periodH.toFixed(1)} h` : 'keine Schichten'}.`
                          : isPlus && balance > 25
                            ? `Freier Tag dringend empfohlen — ${balance.toFixed(1)} h Plussaldo${b.isUniqueInStation && b.station ? `; einzige ${b.emp.positionTitle} → Besetzung sicherstellen` : ''}.`
                          : isPlus
                            ? `Freier Tag empfohlen — ${balance.toFixed(1)} h Plussaldo. Schichten wenn möglich reduzieren.`
                          : `Ausgeglichener Saldo (${fmtBalanceHours(balance)}). Normale Planung.`}
                        </p>

                        {/* Stations-Alternativen */}
                        {b.station && b.stationPeers.length > 0 && (
                          <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                            <ArrowRight className="h-2.5 w-2.5" />
                            Positionsgeeignete Alternativen: <strong>{b.stationPeers.join(', ')}</strong>
                          </p>
                        )}
                        {b.station && b.isUniqueInStation && (
                          <p className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                            <ShieldAlert className="h-2.5 w-2.5" />
                            Einzige {b.emp.positionTitle} in {dept} — kein gleichwertiger Ersatz
                          </p>
                        )}
                        {!b.station && (
                          <p className="text-[10px] text-muted-foreground">
                            Keine Station hinterlegt — Ersatzbarkeit nicht beurteilbar
                          </p>
                        )}
                      </div>

                      {/* Aktionen */}
                      <StatusActions hintId={hintId} status={status} onChange={updateStatus} />
                    </div>
                  );
                })}

              {/* Budget-Hinweis am Ende */}
              {availableVarBudget > 0 && remainingVarHours > 0 && (
                <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/10 px-3 py-2 flex items-start gap-2">
                  <Star className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-emerald-700 dark:text-emerald-300">
                    Noch ca. <strong className="font-mono">{Math.round(remainingVarHours)} h</strong> Variabel-Budget verfügbar —
                    bevorzugt bei Mitarbeitern im Minus einplanen.
                  </p>
                </div>
              )}
            </>
          )}

          {/* ── TAB: Reduzieren ───────────────────────────────────────── */}
          {tab === 'reduzieren' && (
            <>
              <p className="text-xs text-muted-foreground px-1">
                Mitarbeiter mit hohem Plussaldo und Schichten in der aktuellen Periode.
                Eine Reduktion schont den Saldo ohne Lohnkosten zu erhöhen.
              </p>

              {reduzierenRows.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">
                  Keine Mitarbeiter mit positivem Saldo und aktiven Schichten in dieser Periode.
                </p>
              )}

              {reduzierenRows
                .filter(r => showIgnored || (statuses[r.hintId] ?? 'pending') !== 'ignored')
                .map(({ b, periodH, hintId }) => {
                  const status  = statuses[hintId] ?? 'pending';
                  const balance = b.cumulativeBalance;
                  const dept    = b.emp.department === 'küche' ? 'Küche' : 'Service';

                  return (
                    <div
                      key={hintId}
                      className={cn(
                        'rounded-lg border px-3 py-2.5 flex flex-wrap items-start gap-3',
                        status === 'accepted' ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/10 opacity-70'
                        : status === 'ignored' ? 'border-border bg-muted/20 opacity-40'
                        : status === 'later'   ? 'border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/10 opacity-80'
                        : balance > 25 ? 'border-violet-200 dark:border-violet-800 bg-violet-50/30 dark:bg-violet-950/10'
                        : 'border-blue-200 dark:border-blue-800 bg-blue-50/20 dark:bg-blue-950/10',
                      )}
                    >
                      <TrendingUp className={cn('h-4 w-4 mt-0.5 shrink-0', balance > 25 ? 'text-violet-500' : 'text-blue-500')} />

                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold">{b.emp.name}</span>
                          <Badge variant="outline" className="text-[10px]">{dept}</Badge>
                          {b.station && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  variant="outline"
                                  className={cn('text-[10px] cursor-help',
                                    b.isUniqueInStation
                                      ? 'border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300'
                                      : 'border-indigo-200 text-indigo-700 bg-indigo-50 dark:bg-indigo-950/30 dark:text-indigo-300'
                                  )}
                                >
                                  {b.isUniqueInStation && <ShieldAlert className="h-2.5 w-2.5 mr-0.5" />}
                                  {b.emp.positionTitle}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                {b.isUniqueInStation
                                  ? `Einzige ${b.emp.positionTitle} in ${dept} — Reduktion nur wenn absolut nötig`
                                  : `Positionsgeeignete Alternativen: ${b.stationPeers.join(', ')}`}
                              </TooltipContent>
                            </Tooltip>
                          )}
                          <span className={cn('text-xs font-mono font-semibold px-1.5 py-0.5 rounded', balancePillClass(balance))}>
                            {fmtBalanceHours(balance)}
                          </span>
                        </div>

                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {balance > 25
                            ? `${periodH.toFixed(1)} h geplant — freier Tag wäre sinnvoll (${balance.toFixed(1)} h Plussaldo)`
                            : `${periodH.toFixed(1)} h geplant — Schichten könnten reduziert werden (${balance.toFixed(1)} h Plussaldo)`}
                          {b.isUniqueInStation && b.station
                            ? ` — Achtung: einzige ${b.emp.positionTitle}, Besetzung prüfen.`
                            : b.stationPeers.length > 0
                              ? ` — Ersatz durch ${b.stationPeers.join(' oder ')} möglich.`
                              : ''}
                        </p>

                        {/* Empfehlung */}
                        {!b.isUniqueInStation && b.stationPeers.length > 0 && (
                          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                            <CheckCircle2 className="h-2.5 w-2.5" />
                            Reduktion möglich: Ersatz durch {b.stationPeers.join(', ')} verfügbar
                          </p>
                        )}
                        {b.isUniqueInStation && b.station && (
                          <p className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                            <ShieldAlert className="h-2.5 w-2.5" />
                            Vorsicht: Einzige {b.emp.positionTitle} — Ausfall wäre nicht kompensierbar
                          </p>
                        )}
                      </div>

                      <StatusActions hintId={hintId} status={status} onChange={updateStatus} />
                    </div>
                  );
                })}
            </>
          )}

          {/* Ignorierte anzeigen */}
          <button
            onClick={() => setShowIgnored(v => !v)}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {showIgnored ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {showIgnored ? 'Ignorierte ausblenden' : 'Ignorierte anzeigen'}
          </button>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-2 border-t border-border shrink-0">
          <p className="text-[10px] text-muted-foreground">
            Regelbasiert · Saldo = Vortrag + Monat-Δ · Station aus Personalstamm
          </p>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Schliessen
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </TooltipProvider>
  );
}
