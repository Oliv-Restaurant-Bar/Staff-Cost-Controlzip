/**
 * IstDayDetailDialog — Entscheidungs-orientiertes Tages-KPI-Popup
 *
 * Struktur:
 *   1. Hero KPI:  IST PKQ gross  →  Ziel  →  Abweichung (PP + CHF)
 *   2. Status-Banner: Im Ziel / Leicht über / Über Ziel
 *   3. Abteilungs-Toggle: [Gesamt] [Küche] [Service]
 *      — bei Gesamt: Split-Übersicht Küche vs. Service
 *   4. Details (collapsed): Mitarbeiter-Tabelle + Plan vs. IST
 *
 * Revenue-Modell für Abteilungen:
 *   Es gibt keinen separaten Abteilungsumsatz in den Quelldaten.
 *   → Küche/Service-PKQ = Abteilungskosten / Gesamtumsatz
 *     (= prozentualer Kostenbeitrag zum Gesamtumsatz)
 *     Küche-PKQ + Service-PKQ = Gesamt-PKQ  ✓
 */

import { useState } from 'react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee } from '@/types/personnel';
import { getEmployeeDisplayName } from '@/lib/personnel-utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp,
  Clock, Minus, TrendingDown, TrendingUp,
} from 'lucide-react';
import { DaySchedule } from './ScheduleGrid';
import { resolveDayBreakHours } from '@/hooks/useShiftConfig';
import { getEffectiveHourlyRate, ABSENCE_CODES } from './ActualHoursGrid';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import type { SocialCostRates } from '@/lib/social-costs';

// ── Types ──────────────────────────────────────────────────────────────────────

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

interface DeptStats {
  hours: number;
  cost: number;
  empBreakdown: { emp: Employee; hours: number; cost: number }[];
  planRows: { emp: Employee; planHours: number; istHours: number }[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function calcSlotHours(slot: { start?: string; end?: string } | null | undefined): number {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = eh - sh + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.round(h * 100) / 100;
}

function computeStats(
  dept: DeptFilter,
  employees: Employee[],
  actualHoursData: Record<string, { hours: number; start?: string; end?: string; absenceType?: string }>,
  scheduleData: Record<string, DaySchedule> | undefined,
  dateStr: string,
  socialCostRates: SocialCostRates,
): DeptStats {
  const emps = dept === 'all' ? employees : employees.filter(e => e.department === dept);

  const hours = emps.reduce((s, e) => {
    const entry = actualHoursData[`${e.id}-${dateStr}`];
    if (!entry || entry.absenceType || ABSENCE_CODES.has(entry.absenceType as string)) return s;
    return s + (entry.hours ?? 0);
  }, 0);

  const cost = emps.reduce((s, e) => {
    const entry = actualHoursData[`${e.id}-${dateStr}`];
    if (!entry || entry.absenceType) return s;
    return s + (entry.hours ?? 0) * (getEffectiveHourlyRate(e, socialCostRates) ?? 0);
  }, 0);

  const empBreakdown = emps
    .map(e => {
      const entry = actualHoursData[`${e.id}-${dateStr}`];
      if (!entry || entry.absenceType) return null;
      const h = entry.hours ?? 0;
      if (h === 0) return null;
      return { emp: e, hours: h, cost: h * (getEffectiveHourlyRate(e, socialCostRates) ?? 0) };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.cost - a.cost);

  const planRows = scheduleData
    ? emps.map(e => {
        const ds = scheduleData[`${e.id}-${dateStr}`];
        const gross = ds ? calcSlotHours(ds.früh) + calcSlotHours(ds.spät) : 0;
        const planHours = gross > 0 ? Math.max(0, gross - resolveDayBreakHours(ds, gross)) : 0;
        const istHours = actualHoursData[`${e.id}-${dateStr}`]?.hours ?? 0;
        return { emp: e, planHours, istHours };
      }).filter(r => r.planHours > 0 || r.istHours > 0)
    : [];

  return { hours, cost, empBreakdown, planRows };
}

// ── Formatters ─────────────────────────────────────────────────────────────────

const fmtChf = (n: number) =>
  n.toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtH = (n: number) =>
  n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const fmtPP = (n: number) =>
  `${n >= 0 ? '+' : ''}${Math.abs(n).toFixed(1)} PP`;

// ── Main Component ─────────────────────────────────────────────────────────────

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
  const { rates: socialCostRates } = useSocialCostRates();

  if (!date) return null;

  const dateStr = format(date, 'yyyy-MM-dd');
  const istRevenue = (actualRevenue ?? 0) > 0 ? (actualRevenue as number) : null;
  const hasRevenue = istRevenue !== null;

  // Gesamt-Stats (Küche + Service zusammen) — immer Basis für Hero, Status-Banner und Zielprüfung
  const gesamtStats = computeStats('all', employees, actualHoursData, scheduleData, dateStr, socialCostRates);

  // Stats für den Drilldown (Abteilungs-Detail-Tabelle)
  const stats = computeStats(dept, employees, actualHoursData, scheduleData, dateStr, socialCostRates);

  // PKQ immer auf Basis Gesamt (Küche + Service / Gesamtumsatz)
  const pkqPct = hasRevenue ? (gesamtStats.cost / istRevenue!) * 100 : null;
  const diffPP  = pkqPct !== null ? pkqPct - laborCostThreshold : null;

  const allowedCost = hasRevenue ? istRevenue! * (laborCostThreshold / 100) : null;
  const devCHF = allowedCost !== null ? gesamtStats.cost - allowedCost : null;

  // Für Drilldown-Detail: erlaubte Kosten anteilig zur gewählten Abteilung
  const deptShare = gesamtStats.cost > 0 ? stats.cost / gesamtStats.cost : 1;
  const deptAllowedCost = allowedCost !== null ? allowedCost * (dept === 'all' ? 1 : deptShare) : null;
  const deptDevCHF = deptAllowedCost !== null ? stats.cost - deptAllowedCost : null;

  // For avg-wage based extra hours estimate (use all employees)
  const avgWage = (() => {
    const rates = employees.map(e => getEffectiveHourlyRate(e, socialCostRates) ?? 0).filter(r => r > 0);
    return rates.length ? rates.reduce((a, b) => a + b) / rates.length : 0;
  })();
  const extraHours = devCHF !== null && devCHF > 0 && avgWage > 0 ? devCHF / avgWage : 0;

  // Status
  type Status = 'none' | 'ok' | 'warn' | 'over';
  const status: Status =
    diffPP === null ? 'none'
    : diffPP <= 0    ? 'ok'
    : diffPP <= 5    ? 'warn'
    : 'over';

  const statusCfg: Record<Status, {
    label: string; subLabel?: string;
    textCls: string; bgCls: string; borderCls: string; heroCls: string;
    Icon: typeof CheckCircle2 | null;
  }> = {
    none: {
      label: 'Keine Umsatzdaten',
      textCls: 'text-muted-foreground', bgCls: 'bg-muted/30', borderCls: 'border-border',
      heroCls: 'text-foreground', Icon: null,
    },
    ok: {
      label: 'Im Ziel',
      textCls: 'text-green-700 dark:text-green-400',
      bgCls: 'bg-green-50 dark:bg-green-900/20',
      borderCls: 'border-green-200 dark:border-green-800',
      heroCls: 'text-green-600 dark:text-green-400',
      Icon: CheckCircle2,
    },
    warn: {
      label: 'Leicht über Ziel',
      textCls: 'text-amber-700 dark:text-amber-400',
      bgCls: 'bg-amber-50 dark:bg-amber-900/20',
      borderCls: 'border-amber-200 dark:border-amber-800',
      heroCls: 'text-amber-600 dark:text-amber-400',
      Icon: Minus,
    },
    over: {
      label: 'Über Ziel',
      textCls: 'text-red-700 dark:text-red-400',
      bgCls: 'bg-red-50 dark:bg-red-900/20',
      borderCls: 'border-red-200 dark:border-red-800',
      heroCls: 'text-red-600 dark:text-red-400',
      Icon: AlertTriangle,
    },
  };
  const sc = statusCfg[status];

  // Dept-split for overview bar (always computed from total)
  const kücheSt   = computeStats('küche',   employees, actualHoursData, scheduleData, dateStr, socialCostRates);
  const serviceSt = computeStats('service', employees, actualHoursData, scheduleData, dateStr, socialCostRates);
  const splitTotal = kücheSt.cost + serviceSt.cost;
  const kShare = splitTotal > 0 ? (kücheSt.cost / splitTotal) * 100 : 0;
  const sShare = splitTotal > 0 ? (serviceSt.cost / splitTotal) * 100 : 0;
  const kPkq   = hasRevenue ? (kücheSt.cost   / istRevenue!) * 100 : null;
  const sPkq   = hasRevenue ? (serviceSt.cost / istRevenue!) * 100 : null;

  const planTotal = stats.planRows.reduce((s, r) => s + r.planHours, 0);

  const deptLabel = dept === 'all' ? 'Gesamt' : dept === 'küche' ? 'Küche' : 'Service';

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setDept('all'); setDetailsOpen(false); } onOpenChange(v); }}>
      <DialogContent className="max-w-sm w-full max-h-[92vh] overflow-y-auto p-0 gap-0">

        {/* ── Header ────────────────────────────────────────────────────── */}
        <DialogHeader className="px-5 pt-4 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            {format(date, 'EEEE, d. MMMM yyyy', { locale: de })}
          </DialogTitle>
        </DialogHeader>

        <div className="px-5 pb-5 space-y-4 pt-4">

          {/* ── 1. Hero KPI Block — immer Gesamt (Küche + Service) ────────── */}
          <div className={cn(
            'rounded-xl border px-5 py-4 space-y-4',
            sc.borderCls, sc.bgCls,
          )}>
            {/* IST PKQ Gesamt — Hauptzahl */}
            <div className="text-center space-y-0.5">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                IST Personalquote Gesamt
              </p>
              <p className={cn('text-6xl font-black tabular-nums leading-none tracking-tight', sc.heroCls)}>
                {pkqPct !== null ? `${pkqPct.toFixed(1)}%` : '—'}
              </p>
              <p className="text-[10px] text-muted-foreground/60">Küche + Service / Gesamtumsatz</p>
            </div>

            {/* Ziel + Abweichung — tabellarisch */}
            {hasRevenue && (
              <div className="grid grid-cols-2 gap-3 text-center">
                <div className="rounded-lg bg-background/60 border border-border/50 px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-0.5">Zielquote</p>
                  <p className="text-2xl font-bold tabular-nums">{laborCostThreshold.toFixed(1)}%</p>
                </div>
                <div className={cn(
                  'rounded-lg border px-3 py-2.5',
                  diffPP !== null && diffPP > 0
                    ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
                    : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800',
                )}>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-0.5">Abweichung</p>
                  {diffPP !== null ? (
                    <>
                      <p className={cn('text-2xl font-bold tabular-nums leading-tight',
                        diffPP > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                      )}>
                        {fmtPP(diffPP)}
                      </p>
                      {devCHF !== null && (
                        <p className={cn('text-[11px] font-semibold tabular-nums mt-0.5',
                          devCHF > 0 ? 'text-red-500 dark:text-red-400' : 'text-green-500 dark:text-green-400'
                        )}>
                          {devCHF > 0 ? '+' : ''}CHF {fmtChf(devCHF)}
                        </p>
                      )}
                    </>
                  ) : <p className="text-xl font-bold text-muted-foreground">—</p>}
                </div>
              </div>
            )}

            {/* Umsatz · Gesamtkosten · Gesamtstunden */}
            <div className="grid grid-cols-3 gap-2 pt-1 border-t border-border/40 text-center">
              <MetaKpi label="Umsatz" value={hasRevenue ? `CHF ${fmtChf(istRevenue!)}` : '—'} />
              <MetaKpi label="PK Gesamt" value={`CHF ${fmtChf(gesamtStats.cost)}`} />
              <MetaKpi label="Std. Gesamt" value={`${fmtH(gesamtStats.hours)} h`} />
            </div>
          </div>

          {/* ── 2. Status-Banner ───────────────────────────────────────────── */}
          <div className={cn(
            'flex items-center gap-3 rounded-lg border px-4 py-3',
            sc.bgCls, sc.borderCls,
          )}>
            {sc.Icon && <sc.Icon className={cn('h-5 w-5 shrink-0', sc.textCls)} />}
            <div className="flex-1 min-w-0">
              <p className={cn('font-bold text-sm leading-tight', sc.textCls)}>{sc.label}</p>
              {devCHF !== null && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {devCHF > 0 ? (
                    <>
                      <span className={cn('font-semibold', sc.textCls)}>
                        CHF {fmtChf(devCHF)} zu viel
                      </span>
                      {extraHours > 0.1 && (
                        <span> · ≈ {fmtH(extraHours)} h zu viel gearbeitet</span>
                      )}
                    </>
                  ) : (
                    <span className="font-semibold text-green-600 dark:text-green-400">
                      CHF {fmtChf(Math.abs(devCHF))} unter Budget
                    </span>
                  )}
                </p>
              )}
            </div>
            {diffPP !== null && (
              diffPP > 0
                ? <TrendingUp className="h-5 w-5 text-red-500 dark:text-red-400 shrink-0" />
                : <TrendingDown className="h-5 w-5 text-green-500 dark:text-green-400 shrink-0" />
            )}
          </div>

          {/* ── 3. Küche / Service Aufschlüsselung (immer sichtbar) ────────── */}
          {splitTotal > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                Aufschlüsselung · Küche + Service
              </p>
              <div className="rounded-lg border divide-y text-xs overflow-hidden">
                <DeptSplitRow
                  color="bg-orange-400"
                  label="Küche"
                  pkq={kPkq}
                  cost={kücheSt.cost}
                  hours={kücheSt.hours}
                  share={kShare}
                  isOver={false}
                  onDrill={() => { setDept('küche'); setDetailsOpen(true); }}
                />
                <DeptSplitRow
                  color="bg-blue-400"
                  label="Service"
                  pkq={sPkq}
                  cost={serviceSt.cost}
                  hours={serviceSt.hours}
                  share={sShare}
                  isOver={false}
                  onDrill={() => { setDept('service'); setDetailsOpen(true); }}
                />
                {(kShare > 0 || sShare > 0) && (
                  <div className="flex h-1.5">
                    <div className="bg-orange-400 transition-all" style={{ width: `${kShare}%` }} />
                    <div className="bg-blue-400 transition-all flex-1" />
                  </div>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground/50">
                Küche % + Service % = Gesamt PKQ (Drilldown: Details anzeigen)
              </p>
            </div>
          )}

          {/* ── 4. Abteilungs-Drilldown (Details, collapsed) ───────────────── */}
          <div className="border rounded-lg overflow-hidden">
            <button
              onClick={() => setDetailsOpen(p => !p)}
              className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-semibold text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
            >
              <span className="flex items-center gap-1.5">
                {detailsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                Details {detailsOpen ? 'ausblenden' : 'anzeigen'}
                {!detailsOpen && gesamtStats.empBreakdown.length > 0 && (
                  <span className="font-normal text-muted-foreground/70">
                    ({gesamtStats.empBreakdown.length} Mitarbeitende)
                  </span>
                )}
              </span>
              {!detailsOpen && allowedCost !== null && (
                <span className="font-normal text-muted-foreground/70">
                  Erlaubt: CHF {fmtChf(allowedCost)}
                </span>
              )}
            </button>

            {detailsOpen && (
              <div className="border-t divide-y text-xs">

                {/* Abteilungs-Filter für Tabelle */}
                <div className="px-3 py-2 bg-muted/30">
                  <p className="text-[10px] font-semibold text-muted-foreground mb-1.5">Mitarbeiter filtern nach Abteilung</p>
                  <div className="flex rounded-md border overflow-hidden text-xs font-medium h-7">
                    {(['all', 'küche', 'service'] as DeptFilter[]).map((key, i) => {
                      const label = key === 'all' ? 'Alle' : key === 'küche' ? 'Küche' : 'Service';
                      return (
                        <button
                          key={key}
                          onClick={() => setDept(key)}
                          className={cn(
                            'flex-1 transition-colors',
                            dept === key
                              ? 'bg-foreground text-background'
                              : 'bg-background text-muted-foreground hover:bg-muted',
                            i > 0 && 'border-l border-border',
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Kennzahlen */}
                <div className="divide-y">
                  {hasRevenue && plannedRevenue !== undefined && plannedRevenue > 0 && (
                    <KVRow label="Plan-Umsatz">
                      <span className="font-mono text-muted-foreground">CHF {fmtChf(plannedRevenue)}</span>
                    </KVRow>
                  )}
                  {allowedCost !== null && (
                    <KVRow label="Erlaubte Gesamtkosten">
                      <span className="font-mono">CHF {fmtChf(allowedCost)}</span>
                    </KVRow>
                  )}
                  {deptAllowedCost !== null && dept !== 'all' && (
                    <KVRow label={`Erlaubte Kosten (${deptLabel})`}>
                      <span className="font-mono">CHF {fmtChf(deptAllowedCost)}</span>
                    </KVRow>
                  )}
                  {deptDevCHF !== null && (
                    <KVRow label={dept === 'all' ? 'Abweichung Gesamt CHF' : `Abweichung (${deptLabel}) CHF`}>
                      <span className={cn('font-mono font-semibold',
                        deptDevCHF > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                      )}>
                        {deptDevCHF > 0 ? '+' : ''}CHF {fmtChf(deptDevCHF)}
                      </span>
                    </KVRow>
                  )}
                </div>

                {/* Mitarbeiter-Tabelle */}
                {stats.empBreakdown.length > 0 && (
                  <table className="w-full">
                    <thead className="bg-muted">
                      <tr>
                        <th className="text-left px-3 py-1.5 font-semibold">Mitarbeiter</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Std.</th>
                        <th className="text-right px-2 py-1.5 font-semibold">CHF/h</th>
                        <th className="text-right px-3 py-1.5 font-semibold">Kosten</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {stats.empBreakdown.map(({ emp, hours: h, cost: c }) => (
                        <tr key={emp.id} className="hover:bg-muted/30 transition-colors">
                          <td className="px-3 py-1.5">
                            <span className={cn('inline-block w-1.5 h-1.5 rounded-full mr-1.5 shrink-0 align-middle',
                              emp.department === 'service' ? 'bg-blue-400' : 'bg-orange-400'
                            )} />
                            <span className="font-medium">{getEmployeeDisplayName(emp)}</span>
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">{fmtH(h)}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
                            {(getEffectiveHourlyRate(emp, socialCostRates) ?? 0).toFixed(2)}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono font-semibold">
                            {fmtChf(c)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-muted font-bold border-t-2">
                      <tr>
                        <td className="px-3 py-1.5">Total</td>
                        <td className="px-2 py-1.5 text-right font-mono">{fmtH(stats.hours)}</td>
                        <td />
                        <td className="px-3 py-1.5 text-right font-mono">CHF {fmtChf(stats.cost)}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}

                {/* Plan vs. IST */}
                {stats.planRows.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 bg-muted/50 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                      Plan vs. IST
                    </div>
                    <table className="w-full">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left px-3 py-1.5 font-semibold">Mitarbeiter</th>
                          <th className="text-right px-2 py-1.5 font-semibold">Plan</th>
                          <th className="text-right px-2 py-1.5 font-semibold">IST</th>
                          <th className="text-right px-3 py-1.5 font-semibold">Diff</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {stats.planRows.map(({ emp, planHours, istHours }) => {
                          const diff = istHours - planHours;
                          return (
                            <tr key={emp.id} className="hover:bg-muted/30 transition-colors">
                              <td className="px-3 py-1.5">
                                <span className={cn('inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle',
                                  emp.department === 'service' ? 'bg-blue-400' : 'bg-orange-400'
                                )} />
                                <span className="font-medium">{getEmployeeDisplayName(emp)}</span>
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{fmtH(planHours)}</td>
                              <td className="px-2 py-1.5 text-right font-mono">{fmtH(istHours)}</td>
                              <td className={cn('px-3 py-1.5 text-right font-mono font-semibold',
                                diff > 0.1 ? 'text-red-600 dark:text-red-400'
                                : diff < -0.1 ? 'text-green-600 dark:text-green-400'
                                : 'text-muted-foreground'
                              )}>
                                {diff > 0 ? '+' : ''}{fmtH(diff)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot className="bg-muted font-bold border-t-2">
                        <tr>
                          <td className="px-3 py-1.5">Total</td>
                          <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{fmtH(planTotal)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{fmtH(stats.hours)}</td>
                          <td className={cn('px-3 py-1.5 text-right font-mono font-semibold',
                            stats.hours - planTotal > 0.1 ? 'text-red-600 dark:text-red-400'
                            : stats.hours - planTotal < -0.1 ? 'text-green-600 dark:text-green-400'
                            : 'text-muted-foreground'
                          )}>
                            {stats.hours - planTotal > 0 ? '+' : ''}{fmtH(stats.hours - planTotal)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </>
                )}

                {stats.empBreakdown.length === 0 && stats.planRows.length === 0 && (
                  <p className="px-4 py-3 text-muted-foreground text-xs">Keine Daten für diesen Tag.</p>
                )}
              </div>
            )}
          </div>

        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function MetaKpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground/70">{label}</p>
      <p className="text-[11px] font-semibold tabular-nums leading-snug">{value}</p>
    </div>
  );
}

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center px-3 py-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function DeptSplitRow({
  color, label, pkq, cost, hours, share, onDrill,
}: {
  color: string; label: string; pkq: number | null; cost: number;
  hours: number; share: number; isOver: boolean; onDrill: () => void;
}) {
  return (
    <button
      onClick={onDrill}
      className="flex items-center w-full px-3 py-2 gap-2.5 hover:bg-muted/40 transition-colors text-left"
    >
      <span className={cn('w-2 h-2 rounded-full shrink-0', color)} />
      <span className="flex-1 font-semibold text-foreground">{label}</span>
      <span className="tabular-nums font-bold w-14 text-right">
        {pkq !== null ? `${pkq.toFixed(1)}%` : '—'}
      </span>
      <span className="tabular-nums text-muted-foreground w-20 text-right text-[11px]">
        CHF {fmtChf(cost)}
      </span>
      <span className="tabular-nums text-muted-foreground w-12 text-right text-[11px]">
        {fmtH(hours)} h
      </span>
      <span className="text-muted-foreground/50 text-[10px] w-8 text-right">
        {share.toFixed(0)}%
      </span>
    </button>
  );
}
