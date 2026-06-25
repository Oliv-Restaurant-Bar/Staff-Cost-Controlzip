// ─────────────────────────────────────────────────────────────────────────────
// OvertimeCostCard — Überstundenkosten-Analyse für Festangestellte
// ─────────────────────────────────────────────────────────────────────────────
// Eigenständige, in PersonalFix eingebettete Karte. Zeigt:
//   - reguläre Personalkosten, zusätzliche Überstundenkosten,
//     Total inkl./exkl. Überstunden + lokal neu berechnete PKQ
//   - Toggle "Überstundenkosten einbeziehen" (steuert Total + PKQ)
//   - Tages- und Wochen-Aufschlüsselung je betroffenem Mitarbeiter
//
// Berechnung kommt vollständig aus der puren Lib `overtime-analysis`. Diese
// Komponente rendert nur. Berechtigungen (defense-in-depth):
//   - canSeeIndividualRates (canSeeHourlyWages) → individuelle Kosten/Sätze
//   - canSeeTotals (canSeePersonnelCostTotals)  → aggregierte Kosten/PKQ
// Überstunden-STUNDEN sind keine Lohndaten und immer sichtbar.
// ─────────────────────────────────────────────────────────────────────────────
import { useState } from 'react';
import { Clock, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  computeOvertimeTotals,
  DAILY_OVERTIME_THRESHOLD,
  type OvertimeAnalysis,
  type EmployeeOvertimeResult,
} from '@/lib/overtime-analysis';

interface OvertimeCostCardProps {
  analysis: OvertimeAnalysis;
  /** Reguläre Personalkosten (IST) des Zeitraums — Basis für Total/PKQ */
  regularCost: number;
  /** Netto-Umsatz des Zeitraums (für PKQ) */
  netRevenue: number;
  includeOvertime: boolean;
  onIncludeOvertimeChange: (value: boolean) => void;
  /** Individuelle Lohnsätze/-kosten sichtbar (canSeeHourlyWages) */
  canSeeIndividualRates: boolean;
  /** Aggregierte Kosten/PKQ sichtbar (canSeePersonnelCostTotals) */
  canSeeTotals: boolean;
  /** z.B. "Juni 2026" */
  periodLabel?: string;
}

const chf = (n: number): string =>
  `CHF ${n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const hrs = (n: number): string =>
  `${n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} h`;

const pct = (n: number | null): string => (n === null ? '—' : `${n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`);

function fmtDate(iso: string): string {
  // YYYY-MM-DD → DD.MM.
  const [, m, d] = iso.split('-');
  return `${d}.${m}.`;
}

export function OvertimeCostCard({
  analysis,
  regularCost,
  netRevenue,
  includeOvertime,
  onIncludeOvertimeChange,
  canSeeIndividualRates,
  canSeeTotals,
  periodLabel,
}: OvertimeCostCardProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleRow = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const totals = computeOvertimeTotals(
    regularCost,
    analysis.totalOvertimeCost,
    netRevenue,
    includeOvertime,
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4 text-amber-600" />
              Überstundenkosten (Festangestellte)
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Wochen-Überstunden über dem Wochensoll (42h × Pensum)
              {periodLabel ? ` · ${periodLabel}` : ''}
            </p>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch
              checked={includeOvertime}
              onCheckedChange={onIncludeOvertimeChange}
              aria-label="Überstundenkosten einbeziehen"
            />
            <span className="text-muted-foreground">Überstundenkosten einbeziehen</span>
          </label>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {analysis.affectedEmployeeCount === 0 ? (
          <p className="rounded-md bg-muted/50 px-3 py-6 text-center text-sm text-muted-foreground">
            Keine Überstunden im Zeitraum.
          </p>
        ) : (
          <>
            {/* ── Aggregat-Kacheln ─────────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <SummaryTile label="Überstunden" value={hrs(analysis.totalOvertimeHours)} />
              <SummaryTile
                label="Betroffene Mitarbeiter"
                value={String(analysis.affectedEmployeeCount)}
              />
              {canSeeTotals ? (
                <>
                  <SummaryTile
                    label="Zusätzliche Kosten"
                    value={chf(analysis.totalOvertimeCost)}
                    accent="amber"
                  />
                  <SummaryTile
                    label={includeOvertime ? 'PKQ inkl. ÜS' : 'PKQ exkl. ÜS'}
                    value={pct(totals.effectivePkq)}
                  />
                </>
              ) : (
                <div className="col-span-2 flex items-center rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  Kosten für Ihre Rolle nicht sichtbar.
                </div>
              )}
            </div>

            {/* ── Kosten-Übersicht regulär / ÜS / Total ────────────────────── */}
            {canSeeTotals && (
              <div className="rounded-md border">
                <CostRow label="Reguläre Personalkosten" value={chf(totals.regularCost)} />
                <CostRow
                  label="+ Zusätzliche Überstundenkosten"
                  value={chf(totals.overtimeCost)}
                  accent="amber"
                />
                <CostRow
                  label="Total inkl. Überstunden"
                  value={chf(totals.totalInclOvertime)}
                  sub={`PKQ ${pct(totals.pkqInclOvertime)}`}
                  muted={!includeOvertime}
                  emphasize={includeOvertime}
                />
                <CostRow
                  label="Total exkl. Überstunden"
                  value={chf(totals.totalExclOvertime)}
                  sub={`PKQ ${pct(totals.pkqExclOvertime)}`}
                  muted={includeOvertime}
                  emphasize={!includeOvertime}
                  last
                />
              </div>
            )}

            {analysis.hasUnavailableRates && (
              <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-500">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Für einzelne Mitarbeiter ist kein Stundensatz hinterlegt — deren Überstunden
                werden in Stunden ausgewiesen, die Kosten sind nicht verfügbar.
              </p>
            )}

            {/* ── Mitarbeiter-Tabelle ──────────────────────────────────────── */}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Mitarbeiter</TableHead>
                  <TableHead className="text-right">Überstunden</TableHead>
                  {canSeeIndividualRates && <TableHead className="text-right">Kosten</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {analysis.employees.map((emp) => (
                  <EmployeeRows
                    key={emp.employeeId}
                    emp={emp}
                    expanded={expanded.has(emp.employeeId)}
                    onToggle={() => toggleRow(emp.employeeId)}
                    canSeeIndividualRates={canSeeIndividualRates}
                  />
                ))}
              </TableBody>
            </Table>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Kalkulatorische Auswertung auf Basis der erfassten produktiven Ist-Stunden
              (Abwesenheiten wie Ferien/Krankheit/Unfall werden nicht mitgezählt). Überstunden
              werden ausschliesslich wöchentlich berechnet: pro Mitarbeiter und ISO-Woche
              Wochen-Ist − Wochensoll (42h × Pensum). Tage über {DAILY_OVERTIME_THRESHOLD}h werden
              nur informativ angezeigt und fliessen NICHT in die Überstundenkosten ein. Wochen am
              Monatsrand werden nur mit den geladenen Tagen berechnet. Diese Auswertung ist
              unabhängig von manuell markierten Zusatzkosten (isAdditionalCost) — bei gleichzeitig
              als Zusatzkosten markierten Überstundentagen kann es zu einer Überschneidung mit den
              regulären Kosten kommen.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Sub-Komponenten ──────────────────────────────────────────────────────────

function SummaryTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'amber';
}) {
  return (
    <div className="rounded-md border bg-card px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-0.5 font-mono text-sm font-semibold tabular-nums',
          accent === 'amber' && 'text-amber-700 dark:text-amber-500',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function CostRow({
  label,
  value,
  sub,
  accent,
  emphasize,
  muted,
  last,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: 'amber';
  emphasize?: boolean;
  muted?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between px-3 py-2',
        !last && 'border-b',
        emphasize && 'bg-muted/50',
        muted && 'opacity-60',
      )}
    >
      <span className={cn('text-sm', emphasize ? 'font-semibold' : 'text-muted-foreground')}>
        {label}
      </span>
      <span className="text-right">
        <span
          className={cn(
            'font-mono text-sm tabular-nums',
            emphasize && 'font-semibold',
            accent === 'amber' && 'text-amber-700 dark:text-amber-500',
          )}
        >
          {value}
        </span>
        {sub && <span className="ml-2 text-xs text-muted-foreground">{sub}</span>}
      </span>
    </div>
  );
}

function EmployeeRows({
  emp,
  expanded,
  onToggle,
  canSeeIndividualRates,
}: {
  emp: EmployeeOvertimeResult;
  expanded: boolean;
  onToggle: () => void;
  canSeeIndividualRates: boolean;
}) {
  const colSpan = canSeeIndividualRates ? 4 : 3;
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="py-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </TableCell>
        <TableCell className="py-2">
          <div className="font-medium">{emp.name}</div>
          <div className="text-xs text-muted-foreground">{emp.department}</div>
        </TableCell>
        <TableCell className="py-2 text-right font-mono tabular-nums">
          {hrs(emp.overtimeHours)}
        </TableCell>
        {canSeeIndividualRates && (
          <TableCell className="py-2 text-right font-mono tabular-nums">
            {emp.overtimeCost === null ? (
              <Badge variant="outline" className="text-amber-700 dark:text-amber-500">
                Satz fehlt
              </Badge>
            ) : (
              chf(emp.overtimeCost)
            )}
          </TableCell>
        )}
      </TableRow>

      {expanded && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell />
          <TableCell colSpan={colSpan - 1} className="py-3">
            {/* Wochen-Aufschlüsselung */}
            <div className="mb-3">
              <div className="mb-1 text-xs font-semibold text-muted-foreground">Wochen</div>
              <div className="space-y-1">
                {emp.weeks
                  .filter((w) => w.effectiveOvertime > 0)
                  .map((w) => (
                    <div
                      key={w.weekKey}
                      className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs"
                    >
                      <span className="font-medium">
                        KW {String(w.isoWeek).padStart(2, '0')}/{w.isoYear}
                      </span>
                      <span className="text-muted-foreground">
                        Wochen-Ist {hrs(w.weekHours)}
                      </span>
                      <span className="text-muted-foreground">Soll {hrs(w.targetHours)}</span>
                      <span className="font-medium text-amber-700 dark:text-amber-500">
                        Überstunden {hrs(w.effectiveOvertime)}
                      </span>
                      {w.dailyOvertimeSum > 0 && (
                        <span className="text-[10px] text-muted-foreground/70">
                          (Tage über {DAILY_OVERTIME_THRESHOLD}h: {hrs(w.dailyOvertimeSum)}, nur Info)
                        </span>
                      )}
                      {canSeeIndividualRates && w.cost !== null && (
                        <span className="font-mono tabular-nums">{chf(w.cost)}</span>
                      )}
                    </div>
                  ))}
              </div>
            </div>

            {/* Tages-Aufschlüsselung (nur Tage mit Tages-Überstunden) */}
            {emp.days.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-semibold text-muted-foreground">
                  Tage über {DAILY_OVERTIME_THRESHOLD}h, nur Info
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {emp.days.map((d) => (
                    <span key={d.date} className="text-muted-foreground">
                      {fmtDate(d.date)}{' '}
                      <span className="font-medium text-foreground">{hrs(d.actualHours)}</span>{' '}
                      <span className="text-amber-700 dark:text-amber-500">
                        (+{hrs(d.dailyOvertime)})
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
