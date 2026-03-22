import { useState } from 'react';
import {
  ChevronDown, ChevronUp, TrendingDown, TrendingUp, ShieldAlert,
  Lightbulb, Star, Minus, ArrowRight, AlertTriangle, Briefcase,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  EmployeeHourBalance,
  PlanningHint,
  fmtBalanceHours,
} from '@/lib/hour-balance-utils';

// ─── Typen ───────────────────────────────────────────────────────────────────

interface Props {
  balances: EmployeeHourBalance[];
  hints: PlanningHint[];
  mode: 'plan' | 'ist' | 'manual';
  /** Label für den aktuell gewählten Modus (Plan / Ist / Manuell) */
  modeLabel: string;
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function balanceColor(b: number, hasTarget: boolean): string {
  if (!hasTarget) return 'text-muted-foreground';
  if (b <= -15)  return 'text-red-600 dark:text-red-400 font-bold';
  if (b < -8)    return 'text-orange-600 dark:text-orange-400 font-semibold';
  if (b < 0)     return 'text-amber-600 dark:text-amber-400';
  if (b === 0)   return 'text-muted-foreground';
  if (b <= 15)   return 'text-emerald-600 dark:text-emerald-400';
  if (b <= 25)   return 'text-blue-600 dark:text-blue-400 font-semibold';
  return 'text-violet-600 dark:text-violet-400 font-bold';
}

function balanceBg(b: number, hasTarget: boolean): string {
  if (!hasTarget) return '';
  if (b <= -15) return 'bg-red-50/50 dark:bg-red-950/10';
  if (b < -8)   return 'bg-orange-50/40 dark:bg-orange-950/10';
  if (b >= 25)  return 'bg-violet-50/40 dark:bg-violet-950/10';
  if (b >= 15)  return 'bg-blue-50/30 dark:bg-blue-950/10';
  return '';
}

function BalancePill({ b, hasTarget }: { b: number; hasTarget: boolean }) {
  if (!hasTarget) return <span className="text-muted-foreground text-xs italic">–</span>;
  const cls = cn(
    'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-mono font-semibold',
    b < -15 ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400'
    : b < -8 ? 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400'
    : b < 0  ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
    : b === 0 ? 'bg-muted text-muted-foreground'
    : b <= 15 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
    : b <= 25 ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400'
    : 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400'
  );
  return <span className={cls}>{fmtBalanceHours(b)}</span>;
}

const HINT_ICON: Record<string, React.ReactNode> = {
  prefer_high:    <TrendingDown className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />,
  prefer_med:     <TrendingDown className="h-3.5 w-3.5 text-orange-500 shrink-0 mt-0.5" />,
  protect_high:   <TrendingUp className="h-3.5 w-3.5 text-violet-500 shrink-0 mt-0.5" />,
  protect_med:    <TrendingUp className="h-3.5 w-3.5 text-blue-500 shrink-0 mt-0.5" />,
  budget_opport:  <Star className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />,
  unique_station: <ShieldAlert className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />,
  on_track:       <Lightbulb className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />,
};

const HINT_BG: Record<string, string> = {
  prefer_high:    'border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20',
  prefer_med:     'border-orange-200 dark:border-orange-800 bg-orange-50/60 dark:bg-orange-950/20',
  protect_high:   'border-violet-200 dark:border-violet-800 bg-violet-50/60 dark:bg-violet-950/20',
  protect_med:    'border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/20',
  budget_opport:  'border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20',
  unique_station: 'border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20',
  on_track:       'border-border bg-muted/30',
};

const DEPT_ORDER = ['service', 'küche'];

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function HourBalanceSection({ balances, hints, mode, modeLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'table' | 'hints'>('hints');

  const hasAnyTarget = balances.some(b => b.hasTarget);
  const totalMinus  = balances.filter(b => b.cumulativeBalance < 0).length;
  const totalPlus   = balances.filter(b => b.cumulativeBalance > 15).length;
  const highHints   = hints.filter(h => h.priority === 'high').length;

  const serviceBalances = balances.filter(b => b.emp.department === 'service');
  const kueche_balances = balances.filter(b => b.emp.department === 'küche');

  const deptBalances: [string, EmployeeHourBalance[]][] = [
    ['Service', serviceBalances],
    ['Küche', kueche_balances],
  ].filter(([, emps]) => (emps as EmployeeHourBalance[]).length > 0) as [string, EmployeeHourBalance[]][];

  return (
    <section className="rounded-xl border-2 border-indigo-200 dark:border-indigo-800 bg-card shadow-sm overflow-hidden">

      {/* ── Kopfzeile (immer sichtbar) ────────────────────────────────────── */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-indigo-50/40 dark:bg-indigo-950/20 hover:bg-indigo-50/70 dark:hover:bg-indigo-950/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <Briefcase className="h-4 w-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
          <span className="text-sm font-bold">Stundensaldo & Planungshinweise</span>
          {highHints > 0 && (
            <Badge className="text-[10px] bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 border-red-200 dark:border-red-800">
              {highHints} dringend
            </Badge>
          )}
          {hints.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {hints.length} Hinweis{hints.length !== 1 ? 'e' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {hasAnyTarget && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {totalMinus > 0 && (
                <span className="flex items-center gap-1 text-orange-600 dark:text-orange-400">
                  <TrendingDown className="h-3 w-3" />
                  {totalMinus} im Minus
                </span>
              )}
              {totalPlus > 0 && (
                <span className="flex items-center gap-1 text-violet-600 dark:text-violet-400">
                  <TrendingUp className="h-3 w-3" />
                  {totalPlus} im Plus
                </span>
              )}
            </div>
          )}
          {open
            ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
            : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
        </div>
      </button>

      {/* ── Inhalt ──────────────────────────────────────────────────────────── */}
      {open && (
        <>
          {/* Tab-Wechsel */}
          <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-muted/20">
            {(['hints', 'table'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'px-3 py-1 text-xs font-semibold rounded-md transition-colors',
                  tab === t
                    ? 'bg-white dark:bg-slate-800 shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t === 'hints' ? `Planungshinweise (${hints.length})` : 'Stundensaldo-Tabelle'}
              </button>
            ))}
            <span className="ml-auto text-[10px] text-muted-foreground">
              Quelle: {modeLabel}
            </span>
          </div>

          {/* ── TAB: Hinweise ─────────────────────────────────────────────── */}
          {tab === 'hints' && (
            <div className="p-4 space-y-2">
              {hints.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Keine Planungshinweise — entweder sind noch keine Stunden geplant
                  oder alle Saldi sind ausgeglichen.
                </p>
              )}
              {hints.map((h, i) => (
                <div
                  key={`${h.empId}-${h.type}-${i}`}
                  className={cn(
                    'flex items-start gap-2 px-3 py-2 rounded-lg border text-sm',
                    HINT_BG[h.type] ?? 'border-border bg-muted/20'
                  )}
                >
                  {HINT_ICON[h.type]}
                  <div className="flex-1 min-w-0">
                    <p className="leading-snug">{h.message}</p>
                    {h.station && (
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {h.dept} · Station: {h.station}
                      </p>
                    )}
                  </div>
                  {h.priority === 'high' && (
                    <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                  )}
                </div>
              ))}

              {/* Legende */}
              <div className="pt-2 border-t border-border">
                <p className="text-[10px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                  <span className="flex items-center gap-1"><TrendingDown className="h-3 w-3 text-red-500" /> Minus-Saldo: bevorzugt einplanen</span>
                  <span className="flex items-center gap-1"><TrendingUp className="h-3 w-3 text-violet-500" /> Plus-Saldo: Auszeit empfohlen</span>
                  <span className="flex items-center gap-1"><Star className="h-3 w-3 text-emerald-500" /> Restbudget-Opportunität</span>
                  <span className="flex items-center gap-1"><ShieldAlert className="h-3 w-3 text-amber-500" /> Einzige Kraft in Station</span>
                </p>
              </div>
            </div>
          )}

          {/* ── TAB: Tabelle ──────────────────────────────────────────────── */}
          {tab === 'table' && (
            <div className="divide-y divide-border">
              {deptBalances.map(([deptLabel, rows]) => (
                <div key={deptLabel}>
                  {/* Abteilungsüberschrift */}
                  <div className="px-4 py-2 bg-muted/10 border-b border-border">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {deptLabel} — {rows.length} Mitarbeiter
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground border-b border-border bg-muted/10">
                          <th className="text-left px-4 py-2 font-medium">Name</th>
                          <th className="text-left px-3 py-2 font-medium">Station / Rolle</th>
                          <th className="text-right px-3 py-2 font-medium">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help underline decoration-dotted">Soll/Mt</span>
                              </TooltipTrigger>
                              <TooltipContent>Monatliches Stunden-Soll aus Vertrag (Wochenstunden × 4.333)</TooltipContent>
                            </Tooltip>
                          </th>
                          <th className="text-right px-3 py-2 font-medium">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help underline decoration-dotted">{modeLabel}</span>
                              </TooltipTrigger>
                              <TooltipContent>Effektiv verwendete Stunden im gewählten Modus ({modeLabel})</TooltipContent>
                            </Tooltip>
                          </th>
                          {mode !== 'plan' && (
                            <th className="text-right px-3 py-2 font-medium">Plan</th>
                          )}
                          <th className="text-right px-3 py-2 font-medium">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help underline decoration-dotted">Monat Δ</span>
                              </TooltipTrigger>
                              <TooltipContent>Differenz: Effektive Stunden − Soll-Stunden im aktuellen Monat</TooltipContent>
                            </Tooltip>
                          </th>
                          <th className="text-right px-3 py-2 font-medium">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-help underline decoration-dotted">Gesamt-Saldo</span>
                              </TooltipTrigger>
                              <TooltipContent>Vortrag (hoursBalance) + Monat-Delta = Gesamtsaldo</TooltipContent>
                            </Tooltip>
                          </th>
                          <th className="text-right px-3 py-2 font-medium">Ersatz?</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {rows.map(b => {
                          const hasPlan = b.planHours > 0;
                          const hasIst  = b.actualHours > 0;
                          return (
                            <tr
                              key={b.emp.id}
                              className={cn('hover:bg-muted/20 transition-colors', balanceBg(b.cumulativeBalance, b.hasTarget))}
                            >
                              {/* Name */}
                              <td className="px-4 py-2.5 font-medium">
                                <div className="flex items-center gap-1.5">
                                  {b.cumulativeBalance < -8 && b.hasTarget && (
                                    <TrendingDown className="h-3.5 w-3.5 text-orange-500 shrink-0" />
                                  )}
                                  {b.cumulativeBalance >= 25 && b.hasTarget && (
                                    <TrendingUp className="h-3.5 w-3.5 text-violet-500 shrink-0" />
                                  )}
                                  {b.emp.name}
                                </div>
                              </td>

                              {/* Station */}
                              <td className="px-3 py-2.5">
                                {b.station ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="inline-flex items-center gap-1 cursor-help">
                                        <Badge
                                          variant="outline"
                                          className={cn(
                                            'text-[10px] normal-case font-normal',
                                            b.isUniqueInStation
                                              ? 'border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300'
                                              : 'border-indigo-200 text-indigo-700 bg-indigo-50 dark:bg-indigo-950/30 dark:text-indigo-300'
                                          )}
                                        >
                                          {b.emp.positionTitle}
                                        </Badge>
                                        {b.isUniqueInStation && (
                                          <ShieldAlert className="h-3 w-3 text-amber-500 shrink-0" />
                                        )}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {b.isUniqueInStation
                                        ? `Einzige ${b.emp.positionTitle} in ${deptLabel} — kein gleichwertiger Ersatz`
                                        : `Mögliche Alternativen: ${b.stationPeers.join(', ')}`}
                                    </TooltipContent>
                                  </Tooltip>
                                ) : (
                                  <span className="text-muted-foreground text-xs italic">–</span>
                                )}
                              </td>

                              {/* Soll */}
                              <td className="px-3 py-2.5 text-right font-mono text-sm">
                                {b.hasTarget
                                  ? <span>{b.monthlyTarget.toFixed(1)} h</span>
                                  : <span className="text-muted-foreground italic text-xs">–</span>}
                              </td>

                              {/* Effektiv (je Modus) */}
                              <td className="px-3 py-2.5 text-right font-mono text-sm">
                                {b.effectiveHours > 0
                                  ? <span>{b.effectiveHours.toFixed(1)} h</span>
                                  : <span className="text-muted-foreground">0 h</span>}
                              </td>

                              {/* Plan (nur wenn Modus != plan) */}
                              {mode !== 'plan' && (
                                <td className="px-3 py-2.5 text-right font-mono text-xs text-muted-foreground">
                                  {hasPlan ? `${b.planHours.toFixed(1)} h` : '–'}
                                </td>
                              )}

                              {/* Monat-Delta */}
                              <td className="px-3 py-2.5 text-right">
                                {b.hasTarget ? (
                                  <span className={cn('font-mono text-xs font-semibold',
                                    b.monthDelta < 0 ? 'text-orange-600 dark:text-orange-400'
                                    : b.monthDelta > 0 ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-muted-foreground'
                                  )}>
                                    {b.monthDelta === 0 ? '± 0' : (b.monthDelta > 0 ? '+' : '') + b.monthDelta.toFixed(1)} h
                                  </span>
                                ) : <span className="text-muted-foreground text-xs">–</span>}
                              </td>

                              {/* Gesamt-Saldo */}
                              <td className="px-3 py-2.5 text-right">
                                <BalancePill b={b.cumulativeBalance} hasTarget={b.hasTarget} />
                              </td>

                              {/* Ersatz */}
                              <td className="px-3 py-2.5 text-right">
                                {b.station === null ? (
                                  <span className="text-muted-foreground text-xs">–</span>
                                ) : b.isUniqueInStation ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="text-xs text-amber-600 dark:text-amber-400 cursor-help flex items-center justify-end gap-1">
                                        <ShieldAlert className="h-3 w-3" /> Einzig
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      Keine andere Kraft mit gleicher Station in {deptLabel}
                                    </TooltipContent>
                                  </Tooltip>
                                ) : (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="text-xs text-emerald-600 dark:text-emerald-400 cursor-help flex items-center justify-end gap-1">
                                        <ArrowRight className="h-3 w-3" /> {b.stationPeers.length}×
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {b.stationPeers.join(', ')}
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}

              {/* Erklärungszeile */}
              <div className="px-4 py-2.5 bg-muted/10 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                <span>Soll = Wochenstunden × 4.333</span>
                <span className="flex items-center gap-1"><Minus className="h-2.5 w-2.5" /> Gesamt-Saldo = Vortrag + Monat-Δ</span>
                <span className="flex items-center gap-1">
                  <Badge variant="outline" className="text-[9px] border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300 px-1 py-0">Station</Badge>
                  Einzige Kraft in Rolle
                </span>
                <span className="flex items-center gap-1">
                  <Badge variant="outline" className="text-[9px] border-indigo-200 text-indigo-700 bg-indigo-50 dark:bg-indigo-950/30 dark:text-indigo-300 px-1 py-0">Station</Badge>
                  Ersatz verfügbar (Hover für Namen)
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
