import { useState } from 'react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee } from '@/types/personnel';
import { getEmployeeDisplayName } from '@/lib/personnel-utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, Minus, ChevronDown, ChevronUp, Clock, Users, TrendingUp } from 'lucide-react';
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

const calcSlotHours = (slot: { start?: string; end?: string } | null | undefined): number => {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = eh - sh + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.round(h * 100) / 100;
};

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
  const [planCompareOpen, setPlanCompareOpen] = useState(false);

  if (!date) return null;

  const dateStr = format(date, 'yyyy-MM-dd');
  const targetPct = laborCostThreshold / 100;

  // Only count productive entries (exclude all absence types: FE, FT, K, F)
  const totalIstHours = employees.reduce((s, e) => {
    const entry = actualHoursData[`${e.id}-${dateStr}`];
    if (!entry || entry.absenceType || ABSENCE_CODES.has(entry.absenceType as string)) return s;
    return s + (entry.hours ?? 0);
  }, 0);
  const totalIstCost = employees.reduce((s, e) => {
    const entry = actualHoursData[`${e.id}-${dateStr}`];
    if (!entry || entry.absenceType) return s;
    const h = entry.hours ?? 0;
    return s + h * (getEffectiveHourlyRate(e) ?? 0);
  }, 0);

  const istRevenue = (actualRevenue !== undefined && actualRevenue > 0) ? actualRevenue : null;
  const allowedCost = istRevenue ? istRevenue * targetPct : null;
  const devCHF = allowedCost !== null ? totalIstCost - allowedCost : null;
  const istPkqPct = istRevenue ? (totalIstCost / istRevenue) * 100 : null;
  const excessPct = allowedCost !== null && allowedCost > 0
    ? ((totalIstCost - allowedCost) / allowedCost) * 100
    : null;

  const avgWage = (() => {
    const rates = employees.map(e => getEffectiveHourlyRate(e) ?? 0).filter(r => r > 0);
    return rates.length ? rates.reduce((s, r) => s + r, 0) / rates.length : 0;
  })();
  const extraHours = (devCHF !== null && devCHF > 0 && avgWage > 0) ? devCHF / avgWage : 0;

  const markerStatus: 'none' | 'green' | 'yellow' | 'red' =
    excessPct === null ? 'none'
    : excessPct <= 0 ? 'green'
    : excessPct <= 5 ? 'yellow'
    : 'red';

  console.log(`[IST-DAY] date: ${dateStr}`);
  console.log(`[IST-DAY] ist revenue: ${istRevenue ?? 'n/a'}`);
  console.log(`[IST-DAY] ist hours: ${totalIstHours.toFixed(2)}`);
  console.log(`[IST-DAY] ist cost: ${totalIstCost.toFixed(2)}`);
  console.log(`[IST-DAY] target pct: ${laborCostThreshold}`);
  console.log(`[IST-DAY] allowed cost: ${allowedCost?.toFixed(2) ?? 'n/a'}`);
  console.log(`[IST-DAY] cost diff: ${devCHF?.toFixed(2) ?? 'n/a'}`);
  console.log(`[IST-DAY] approx extra hours: ${extraHours.toFixed(2)}`);
  console.log(`[IST-DAY] marker status: ${markerStatus}`);

  const empBreakdown = employees.map(e => {
    const entry = actualHoursData[`${e.id}-${dateStr}`];
    const isAbsence = !!entry?.absenceType;
    const h = (!isAbsence && entry?.hours) ? entry.hours : 0;
    const effRate = getEffectiveHourlyRate(e) ?? 0;
    const cost = h * effRate;
    const share = totalIstCost > 0 ? (cost / totalIstCost) * 100 : 0;
    return { emp: e, hours: h, cost, share };
  }).filter(r => r.hours > 0).sort((a, b) => b.cost - a.cost);

  const planRows = scheduleData
    ? employees.map(e => {
        const ds = scheduleData[`${e.id}-${dateStr}`];
        const planGross = ds ? calcSlotHours(ds.früh) + calcSlotHours(ds.spät) : 0;
        const planHours = planGross > 0 ? Math.max(0, planGross - calculateBreakDeduction(planGross)) : 0;
        const istHours = actualHoursData[`${e.id}-${dateStr}`]?.hours ?? 0;
        return { emp: e, planHours, istHours };
      }).filter(r => r.planHours > 0 || r.istHours > 0)
    : [];

  const totalPlanHours = planRows.reduce((s, r) => s + r.planHours, 0);

  const fmt = (n: number) =>
    n.toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtDec = (n: number) =>
    n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const markerConfig = {
    none:   { label: 'Keine Umsatzdaten',    colorCls: 'text-muted-foreground', bgCls: 'bg-muted/40 border-border',                          Icon: null },
    green:  { label: 'Im Ziel',              colorCls: 'text-green-700 dark:text-green-400',  bgCls: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800',   Icon: CheckCircle2 },
    yellow: { label: 'Leicht über Ziel',     colorCls: 'text-amber-700 dark:text-amber-400',  bgCls: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',   Icon: Minus },
    red:    { label: 'Über Ziel',            colorCls: 'text-red-700 dark:text-red-400',      bgCls: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',           Icon: AlertTriangle },
  };
  const mc = markerConfig[markerStatus];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto space-y-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
            IST-Tagesdetail — {format(date, 'EEEE, d. MMMM yyyy', { locale: de })}
          </DialogTitle>
        </DialogHeader>

        {/* Ampel banner */}
        <div className={cn('flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium', mc.bgCls, mc.colorCls)}>
          {mc.Icon && <mc.Icon className="h-4 w-4 shrink-0" />}
          <span>{mc.label}</span>
          {excessPct !== null && (
            <span className="ml-auto text-xs font-normal tabular-nums">
              {excessPct > 0 ? `+${excessPct.toFixed(1)} %` : `${excessPct.toFixed(1)} %`} vs. Zielquote
            </span>
          )}
        </div>

        {/* Section A: Tageszusammenfassung */}
        <div className="space-y-1.5">
          <h3 className="text-sm font-semibold flex items-center gap-1.5 text-muted-foreground uppercase tracking-wide text-[11px]">
            <TrendingUp className="h-3.5 w-3.5" />
            Tageszusammenfassung
          </h3>
          <div className="rounded-lg border divide-y text-sm">
            <Row label="IST-Umsatz">
              {istRevenue !== null ? <span className="font-mono font-medium">CHF {fmt(istRevenue)}</span> : <span className="text-muted-foreground">—</span>}
            </Row>
            {plannedRevenue !== undefined && plannedRevenue > 0 && (
              <Row label="Plan-Umsatz">
                <span className="font-mono text-muted-foreground">CHF {fmt(plannedRevenue)}</span>
              </Row>
            )}
            <Row label="IST-Stunden total">
              <span className="font-mono font-medium">{fmtDec(totalIstHours)} h</span>
            </Row>
            <Row label="IST-Kosten total">
              <span className="font-mono font-medium">CHF {fmt(totalIstCost)}</span>
            </Row>
            <Row label="IST-Personalquote">
              <span className={cn('font-mono font-semibold',
                markerStatus === 'red' ? 'text-red-600 dark:text-red-400'
                : markerStatus === 'yellow' ? 'text-amber-600 dark:text-amber-400'
                : markerStatus === 'green' ? 'text-green-600 dark:text-green-400'
                : '')}>
                {istPkqPct !== null ? `${istPkqPct.toFixed(1)} %` : '—'}
              </span>
            </Row>
            <Row label="Zielquote">
              <span className="font-mono">{laborCostThreshold.toFixed(1)} %</span>
            </Row>
            {allowedCost !== null && (
              <Row label="Erlaubte Kosten CHF">
                <span className="font-mono">CHF {fmt(allowedCost)}</span>
              </Row>
            )}
            {devCHF !== null && (
              <div className={cn(
                'flex justify-between items-center px-3 py-2',
                devCHF > 0 ? 'bg-red-50/60 dark:bg-red-900/10' : 'bg-green-50/60 dark:bg-green-900/10'
              )}>
                <span className="text-muted-foreground text-sm">Abweichung CHF</span>
                <span className={cn('font-mono font-semibold text-sm', devCHF > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400')}>
                  {devCHF > 0 ? '+' : ''}{fmt(devCHF)} CHF
                </span>
              </div>
            )}
            {extraHours > 0 && (
              <div className="flex justify-between items-center px-3 py-2 bg-red-50/60 dark:bg-red-900/10">
                <span className="text-muted-foreground text-sm">ca. zu viel gearbeitet</span>
                <span className="font-mono font-semibold text-sm text-red-600 dark:text-red-400">~{fmtDec(extraHours)} h</span>
              </div>
            )}
          </div>
        </div>

        {/* Section B: Mitarbeiterübersicht */}
        {empBreakdown.length > 0 && (
          <div className="space-y-1.5">
            <h3 className="text-sm font-semibold flex items-center gap-1.5 text-muted-foreground uppercase tracking-wide text-[11px]">
              <Users className="h-3.5 w-3.5" />
              Mitarbeiterübersicht ({empBreakdown.length})
            </h3>
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted">
                  <tr>
                    <th className="text-left px-2.5 py-1.5 font-semibold">Mitarbeiter</th>
                    <th className="text-right px-2 py-1.5 font-semibold">Std.</th>
                    <th className="text-right px-2 py-1.5 font-semibold">CHF/h</th>
                    <th className="text-right px-2 py-1.5 font-semibold">Kosten</th>
                    <th className="text-right px-2 py-1.5 font-semibold">Anteil</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {empBreakdown.map(({ emp, hours, cost, share }) => (
                    <tr key={emp.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-2.5 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0',
                            emp.department === 'service' ? 'bg-blue-500' : 'bg-orange-500'
                          )} />
                          <span className="font-medium">{getEmployeeDisplayName(emp)}</span>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtDec(hours)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{emp.hourlyWage.toFixed(2)}</td>
                      <td className="px-2 py-1.5 text-right font-mono font-medium">{fmt(cost)}</td>
                      <td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">{share.toFixed(0)} %</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-muted font-semibold border-t-2">
                  <tr>
                    <td className="px-2.5 py-1.5">Total</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmtDec(totalIstHours)}</td>
                    <td className="px-2 py-1.5" />
                    <td className="px-2 py-1.5 text-right font-mono">CHF {fmt(totalIstCost)}</td>
                    <td className="px-2 py-1.5 text-right">100 %</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* Section C: Plan vs IST (collapsible) */}
        {planRows.length > 0 && (
          <div className="space-y-1.5">
            <button
              onClick={() => setPlanCompareOpen(p => !p)}
              className="flex w-full items-center justify-between text-[11px] font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <TrendingUp className="h-3.5 w-3.5" />
                Plan vs. IST Vergleich
              </span>
              {planCompareOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            {planCompareOpen && (
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted">
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
                                emp.department === 'service' ? 'bg-blue-500' : 'bg-orange-500'
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
                      <td className="px-2 py-1.5 text-right font-mono">{fmtDec(totalIstHours)}</td>
                      <td className={cn('px-2 py-1.5 text-right font-mono font-medium',
                        totalIstHours - totalPlanHours > 0.1 ? 'text-red-600 dark:text-red-400'
                        : totalIstHours - totalPlanHours < -0.1 ? 'text-green-600 dark:text-green-400'
                        : 'text-muted-foreground')}>
                        {totalIstHours - totalPlanHours > 0 ? '+' : ''}{fmtDec(totalIstHours - totalPlanHours)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center px-3 py-2">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span>{children}</span>
    </div>
  );
}
