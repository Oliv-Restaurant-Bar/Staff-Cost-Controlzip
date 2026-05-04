import { useState } from 'react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee } from '@/types/personnel';
import { getEmployeeDisplayName } from '@/lib/personnel-utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Clock,
  TrendingDown, TrendingUp, Minus,
} from 'lucide-react';
import { DaySchedule } from './ScheduleGrid';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';
import { getEffectiveHourlyRate, ABSENCE_CODES } from './ActualHoursGrid';

interface IstDayDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: Date | null;
  employees: Employee[];
  actualHoursData: Record<string, { hours: number; start?: string; end?: string; absenceType?: string }>;
  actualRevenue?: number;
  plannedRevenue?: number;
  laborCostThreshold: number;
  scheduleData?: Record<string, DaySchedule>;
  activeDepartment?: 'all' | 'service' | 'küche';
}

type DeptFilter = 'all' | 'küche' | 'service';

const calcSlotHours = (slot: { start?: string; end?: string } | null | undefined): number => {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = eh - sh + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.round(h * 100) / 100;
};

function computeDeptStats(
  dept: DeptFilter,
  employees: Employee[],
  actualHoursData: Record<string, { hours: number; start?: string; end?: string; absenceType?: string }>,
  scheduleData: Record<string, DaySchedule> | undefined,
  dateStr: string,
) {
  const filtered = dept === 'all' ? employees : employees.filter(e => e.department === dept);

  const hours = filtered.reduce((s, e) => {
    const entry = actualHoursData[`${e.id}-${dateStr}`];
    if (!entry || entry.absenceType || ABSENCE_CODES.has(entry.absenceType as string)) return s;
    return s + (entry.hours ?? 0);
  }, 0);

  const cost = filtered.reduce((s, e) => {
    const entry = actualHoursData[`${e.id}-${dateStr}`];
    if (!entry || entry.absenceType) return s;
    const h = entry.hours ?? 0;
    return s + h * (getEffectiveHourlyRate(e) ?? 0);
  }, 0);

  const empBreakdown = filtered.map(e => {
    const entry = actualHoursData[`${e.id}-${dateStr}`];
    const isAbsence = !!entry?.absenceType;
    const h = (!isAbsence && entry?.hours) ? entry.hours : 0;
    const effRate = getEffectiveHourlyRate(e) ?? 0;
    const c = h * effRate;
    return { emp: e, hours: h, cost: c };
  }).filter(r => r.hours > 0).sort((a, b) => b.cost - a.cost);

  const planRows = scheduleData
    ? filtered.map(e => {
        const ds = scheduleData[`${e.id}-${dateStr}`];
        const planGross = ds ? calcSlotHours(ds.früh) + calcSlotHours(ds.spät) : 0;
        const planHours = planGross > 0 ? Math.max(0, planGross - calculateBreakDeduction(planGross)) : 0;
        const istHours = actualHoursData[`${e.id}-${dateStr}`]?.hours ?? 0;
        return { emp: e, planHours, istHours };
      }).filter(r => r.planHours > 0 || r.istHours > 0)
    : [];

  return { hours, cost, empBreakdown, planRows };
}

export function IstDayDetailDialog({
  open,
  onOpenChange,
  date,
  employees,
  actualHoursData,
  actualRevenue,
  plannedRevenue,
  laborCostThreshold,
  scheduleData,
}: IstDayDetailDialogProps) {
  const [dept, setDept] = useState<DeptFilter>('all');
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (!date) return null;

  const dateStr = format(date, 'yyyy-MM-dd');
  const targetPct = laborCostThreshold;

  const { hours, cost, empBreakdown, planRows } = computeDeptStats(
    dept, employees, actualHoursData, scheduleData, dateStr,
  );

  const istRevenue = (actualRevenue !== undefined && actualRevenue > 0) ? actualRevenue : null;

  const pkqPct = istRevenue ? (cost / istRevenue) * 100 : null;
  const diffPct = pkqPct !== null ? pkqPct - targetPct : null;
  const allowedCost = istRevenue ? istRevenue * (targetPct / 100) : null;
  const devCHF = allowedCost !== null ? cost - allowedCost : null;

  const avgWage = (() => {
    const rates = employees.map(e => getEffectiveHourlyRate(e) ?? 0).filter(r => r > 0);
    return rates.length ? rates.reduce((s, r) => s + r, 0) / rates.length : 0;
  })();
  const extraHours = (devCHF !== null && devCHF > 0 && avgWage > 0) ? devCHF / avgWage : 0;

  const status: 'none' | 'ok' | 'warn' | 'over' =
    diffPct === null ? 'none'
    : diffPct <= 0 ? 'ok'
    : diffPct <= 5 ? 'warn'
    : 'over';

  const totalPlanHours = planRows.reduce((s, r) => s + r.planHours, 0);

  const fmt = (n: number) =>
    n.toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtDec = (n: number) =>
    n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)} %`;

  const statusCfg = {
    none:  { label: 'Keine Umsatzdaten',  color: 'text-muted-foreground',                         bg: 'bg-muted/40 border-border',                                                    Icon: null,          ring: 'border-border' },
    ok:    { label: 'Im Ziel',            color: 'text-green-700 dark:text-green-400',             bg: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800',    Icon: CheckCircle2,  ring: 'border-green-300 dark:border-green-700' },
    warn:  { label: 'Leicht über Ziel',   color: 'text-amber-700 dark:text-amber-400',             bg: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',    Icon: Minus,         ring: 'border-amber-300 dark:border-amber-700' },
    over:  { label: 'Über Ziel',          color: 'text-red-700 dark:text-red-400',                 bg: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',            Icon: AlertTriangle, ring: 'border-red-300 dark:border-red-700' },
  };
  const sc = statusCfg[status];

  const deptButtons: { key: DeptFilter; label: string }[] = [
    { key: 'all',     label: 'Gesamt'  },
    { key: 'küche',   label: 'Küche'   },
    { key: 'service', label: 'Service' },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[92vh] overflow-y-auto p-0">

        {/* Header */}
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Clock className="h-4 w-4 shrink-0" />
            {format(date, 'EEEE, d. MMMM yyyy', { locale: de })}
          </DialogTitle>
        </DialogHeader>

        <div className="px-5 pb-5 space-y-4 mt-3">

          {/* ── 1. KPI Block ─────────────────────────────────────────────── */}
          <div className={cn('rounded-xl border-2 p-4 space-y-3', sc.ring)}>

            {/* Hauptzahl: IST PKQ */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">
                  IST Personalquote
                </p>
                <p className={cn('text-5xl font-black tabular-nums leading-none', sc.color)}>
                  {pkqPct !== null ? `${pkqPct.toFixed(1)}%` : '—'}
                </p>
              </div>

              {/* Ziel + Differenz */}
              <div className="text-right space-y-1.5 pt-1">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Ziel</p>
                  <p className="text-xl font-bold tabular-nums">{targetPct.toFixed(1)}%</p>
                </div>
                {diffPct !== null && (
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Differenz</p>
                    <p className={cn('text-xl font-bold tabular-nums',
                      diffPct > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                    )}>
                      {fmtPct(diffPct)}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Umsatz + Kosten klein */}
            <div className="flex gap-4 pt-1 border-t border-border/50">
              <div className="flex-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Umsatz</p>
                <p className="text-sm font-semibold tabular-nums">
                  {istRevenue !== null ? `CHF ${fmt(istRevenue)}` : '—'}
                </p>
              </div>
              <div className="flex-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Kosten</p>
                <p className="text-sm font-semibold tabular-nums">CHF {fmt(cost)}</p>
              </div>
              <div className="flex-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Stunden</p>
                <p className="text-sm font-semibold tabular-nums">{fmtDec(hours)} h</p>
              </div>
            </div>
          </div>

          {/* ── 2. Bewertung ─────────────────────────────────────────────── */}
          <div className={cn('flex items-center gap-3 rounded-lg border px-4 py-3', sc.bg)}>
            {sc.Icon && <sc.Icon className={cn('h-5 w-5 shrink-0', sc.color)} />}
            <div className="flex-1 min-w-0">
              <p className={cn('font-semibold text-sm', sc.color)}>{sc.label}</p>
              {devCHF !== null && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {devCHF > 0
                    ? <>Zu viel: <span className="font-semibold text-red-600 dark:text-red-400">CHF {fmt(devCHF)}</span>{extraHours > 0 && <> (≈ {fmtDec(extraHours)} h)</>}</>
                    : <>Einsparung: <span className="font-semibold text-green-600 dark:text-green-400">CHF {fmt(Math.abs(devCHF))}</span></>
                  }
                </p>
              )}
            </div>
            {diffPct !== null && (
              <div className={cn('text-right shrink-0')}>
                {diffPct > 0
                  ? <TrendingUp className="h-5 w-5 text-red-500 dark:text-red-400" />
                  : <TrendingDown className="h-5 w-5 text-green-500 dark:text-green-400" />
                }
              </div>
            )}
          </div>

          {/* ── 3. Abteilungs Toggle ─────────────────────────────────────── */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
              Abteilung
            </p>
            <div className="flex rounded-lg border overflow-hidden text-sm font-medium">
              {deptButtons.map(btn => (
                <button
                  key={btn.key}
                  onClick={() => { setDept(btn.key); setDetailsOpen(false); }}
                  className={cn(
                    'flex-1 py-2 text-center transition-colors',
                    dept === btn.key
                      ? 'bg-foreground text-background'
                      : 'bg-background text-muted-foreground hover:bg-muted',
                    btn.key !== 'all' && 'border-l border-border',
                  )}
                >
                  {btn.label}
                </button>
              ))}
            </div>

            {/* Mini-Abteilungsvergleich (nur bei Gesamt) */}
            {dept === 'all' && (() => {
              const k = computeDeptStats('küche',   employees, actualHoursData, scheduleData, dateStr);
              const s = computeDeptStats('service', employees, actualHoursData, scheduleData, dateStr);
              const total = k.cost + s.cost;
              if (total === 0) return null;
              const kShare = (k.cost / total) * 100;
              const sShare = (s.cost / total) * 100;
              const kPkq = istRevenue ? (k.cost / istRevenue) * 100 : null;
              const sPkq = istRevenue ? (s.cost / istRevenue) * 100 : null;
              return (
                <div className="mt-2 rounded-lg border divide-y text-xs">
                  <div className="flex items-center px-3 py-2 gap-2">
                    <span className="w-2 h-2 rounded-full bg-orange-400 shrink-0" />
                    <span className="flex-1 text-muted-foreground font-medium">Küche</span>
                    <span className="tabular-nums font-semibold">
                      {kPkq !== null ? `${kPkq.toFixed(1)}%` : '—'}
                    </span>
                    <span className="tabular-nums text-muted-foreground w-16 text-right">CHF {fmt(k.cost)}</span>
                    <div className="w-16 bg-muted rounded-full h-1.5 overflow-hidden ml-1">
                      <div className="h-full bg-orange-400 rounded-full" style={{ width: `${kShare}%` }} />
                    </div>
                  </div>
                  <div className="flex items-center px-3 py-2 gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />
                    <span className="flex-1 text-muted-foreground font-medium">Service</span>
                    <span className="tabular-nums font-semibold">
                      {sPkq !== null ? `${sPkq.toFixed(1)}%` : '—'}
                    </span>
                    <span className="tabular-nums text-muted-foreground w-16 text-right">CHF {fmt(s.cost)}</span>
                    <div className="w-16 bg-muted rounded-full h-1.5 overflow-hidden ml-1">
                      <div className="h-full bg-blue-400 rounded-full" style={{ width: `${sShare}%` }} />
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* ── 4. Details (ausgeblendet) ─────────────────────────────────── */}
          <div>
            <button
              onClick={() => setDetailsOpen(p => !p)}
              className="flex w-full items-center justify-between text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors py-1"
            >
              <span className="flex items-center gap-1.5">
                {detailsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                Details {detailsOpen ? 'ausblenden' : 'anzeigen'}
                {!detailsOpen && empBreakdown.length > 0 && (
                  <span className="text-[10px] font-normal text-muted-foreground">
                    ({empBreakdown.length} Mitarbeiter)
                  </span>
                )}
              </span>
              {!detailsOpen && allowedCost !== null && (
                <span className="text-[10px] font-normal">
                  Erlaubt: CHF {fmt(allowedCost)}
                </span>
              )}
            </button>

            {detailsOpen && (
              <div className="space-y-3 mt-2">

                {/* Kennzahlen */}
                <div className="rounded-lg border divide-y text-xs">
                  {istRevenue !== null && plannedRevenue !== undefined && plannedRevenue > 0 && (
                    <DetailRow label="Plan-Umsatz">
                      <span className="font-mono text-muted-foreground">CHF {fmt(plannedRevenue)}</span>
                    </DetailRow>
                  )}
                  {allowedCost !== null && (
                    <DetailRow label="Erlaubte Kosten">
                      <span className="font-mono">CHF {fmt(allowedCost)}</span>
                    </DetailRow>
                  )}
                  {devCHF !== null && (
                    <DetailRow label="Abweichung CHF">
                      <span className={cn('font-mono font-semibold',
                        devCHF > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                      )}>
                        {devCHF > 0 ? '+' : ''}{fmt(devCHF)} CHF
                      </span>
                    </DetailRow>
                  )}
                </div>

                {/* Mitarbeiter-Tabelle */}
                {empBreakdown.length > 0 && (
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted">
                        <tr>
                          <th className="text-left px-2.5 py-1.5 font-semibold">Mitarbeiter</th>
                          <th className="text-right px-2 py-1.5 font-semibold">Std.</th>
                          <th className="text-right px-2 py-1.5 font-semibold">CHF/h</th>
                          <th className="text-right px-2 py-1.5 font-semibold">Kosten</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {empBreakdown.map(({ emp, hours: h, cost: c }) => (
                          <tr key={emp.id} className="hover:bg-muted/30 transition-colors">
                            <td className="px-2.5 py-1.5">
                              <div className="flex items-center gap-1.5">
                                <span className={cn('w-1.5 h-1.5 rounded-full shrink-0',
                                  emp.department === 'service' ? 'bg-blue-400' : 'bg-orange-400'
                                )} />
                                <span className="font-medium">{getEmployeeDisplayName(emp)}</span>
                              </div>
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono">{fmtDec(h)}</td>
                            <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
                              {(getEffectiveHourlyRate(emp) ?? 0).toFixed(2)}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono font-medium">{fmt(c)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-muted font-semibold border-t-2">
                        <tr>
                          <td className="px-2.5 py-1.5">Total</td>
                          <td className="px-2 py-1.5 text-right font-mono">{fmtDec(hours)}</td>
                          <td className="px-2 py-1.5" />
                          <td className="px-2 py-1.5 text-right font-mono">CHF {fmt(cost)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}

                {/* Plan vs. IST */}
                {planRows.length > 0 && (
                  <div className="rounded-lg border overflow-hidden">
                    <div className="px-2.5 py-1.5 bg-muted text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Plan vs. IST
                    </div>
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left px-2.5 py-1.5 font-semibold">Mitarbeiter</th>
                          <th className="text-right px-2 py-1.5 font-semibold">Plan h</th>
                          <th className="text-right px-2 py-1.5 font-semibold">IST h</th>
                          <th className="text-right px-2 py-1.5 font-semibold">Diff</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {planRows.map(({ emp, planHours, istHours }) => {
                          const diff = istHours - planHours;
                          return (
                            <tr key={emp.id} className="hover:bg-muted/30 transition-colors">
                              <td className="px-2.5 py-1.5">
                                <div className="flex items-center gap-1.5">
                                  <span className={cn('w-1.5 h-1.5 rounded-full shrink-0',
                                    emp.department === 'service' ? 'bg-blue-400' : 'bg-orange-400'
                                  )} />
                                  <span className="font-medium">{getEmployeeDisplayName(emp)}</span>
                                </div>
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{fmtDec(planHours)}</td>
                              <td className="px-2 py-1.5 text-right font-mono">{fmtDec(istHours)}</td>
                              <td className={cn('px-2 py-1.5 text-right font-mono font-medium',
                                diff > 0.1 ? 'text-red-600 dark:text-red-400'
                                : diff < -0.1 ? 'text-green-600 dark:text-green-400'
                                : 'text-muted-foreground')}>
                                {diff > 0 ? '+' : ''}{fmtDec(diff)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot className="bg-muted font-semibold border-t-2">
                        <tr>
                          <td className="px-2.5 py-1.5">Total</td>
                          <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{fmtDec(totalPlanHours)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{fmtDec(hours)}</td>
                          <td className={cn('px-2 py-1.5 text-right font-mono font-medium',
                            hours - totalPlanHours > 0.1 ? 'text-red-600 dark:text-red-400'
                            : hours - totalPlanHours < -0.1 ? 'text-green-600 dark:text-green-400'
                            : 'text-muted-foreground')}>
                            {hours - totalPlanHours > 0 ? '+' : ''}{fmtDec(hours - totalPlanHours)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

        </div>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}
