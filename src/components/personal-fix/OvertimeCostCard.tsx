// ─────────────────────────────────────────────────────────────────────────────
// OvertimeCostCard — Überstundenkosten-Analyse für Festangestellte (MONATSBASIS)
// ─────────────────────────────────────────────────────────────────────────────
// Eigenständige, in PersonalFix eingebettete Karte. Zeigt:
//   - reguläre Personalkosten, zusätzliche Überstundenkosten,
//     Total inkl./exkl. Überstunden + lokal neu berechnete PKQ
//   - Toggle "Überstundenkosten einbeziehen" (steuert Total + PKQ)
//   - Tabelle je Festangestelltem: Pensum, Soll Monat, Ist Monat produktiv,
//     Differenz, Überstunden, Überstundenkosten + Deaktivieren-Checkbox
//   - manuelle Zusatzkosten als Unterzeile (reine Anzeige; bereits im regulären
//     Total enthalten, NICHT in den Überstunden)
//
// Berechnung kommt vollständig aus der puren Lib `overtime-analysis`. Diese
// Komponente rendert nur. Berechtigungen (defense-in-depth):
//   - canSeeIndividualRates (canSeeHourlyWages) → individuelle Kosten/Sätze
//   - canSeeTotals (canSeePersonnelCostTotals)  → aggregierte Kosten/PKQ
// Überstunden-STUNDEN sind keine Lohndaten und immer sichtbar.
// ─────────────────────────────────────────────────────────────────────────────
import { Fragment } from 'react';
import { Clock, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  computeOvertimeTotals,
  DAILY_OVERTIME_THRESHOLD,
  type OvertimeAnalysis,
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
  /** Überstundenberechnung pro Mitarbeiter (de)aktivieren (vom Parent persistiert) */
  onToggleEmployeeDisabled?: (employeeId: string, disabled: boolean) => void;
  /** Deaktivieren-Checkbox anzeigen (vom Parent gegated) */
  canManageDisable?: boolean;
}

const chf = (n: number): string =>
  `CHF ${n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const hrs = (n: number): string =>
  `${n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} h`;

const signedHrs = (n: number): string =>
  `${n > 0 ? '+' : ''}${n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} h`;

const pct = (n: number | null): string =>
  n === null ? '—' : `${n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

const wl = (n: number): string =>
  `${n.toLocaleString('de-CH', { maximumFractionDigits: 1 })} %`;

export function OvertimeCostCard({
  analysis,
  regularCost,
  netRevenue,
  includeOvertime,
  onIncludeOvertimeChange,
  canSeeIndividualRates,
  canSeeTotals,
  periodLabel,
  onToggleEmployeeDisabled,
  canManageDisable = false,
}: OvertimeCostCardProps) {
  const totals = computeOvertimeTotals(
    regularCost,
    analysis.totalOvertimeCost,
    netRevenue,
    includeOvertime,
  );

  const showCostCol = canSeeIndividualRates;
  const showDisableCol = canManageDisable && !!onToggleEmployeeDisabled;
  // Mitarbeiter | Abteilung | Pensum | Soll | Ist | Diff | ÜS [| Kosten] [| Deakt.]
  const baseCols = 7;
  const colCount = baseCols + (showCostCol ? 1 : 0) + (showDisableCol ? 1 : 0);

  const hasRows = analysis.employees.length > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4 text-amber-600" />
              Überstundenkosten (Festangestellte)
              {periodLabel && (
                <span className="text-sm font-normal text-muted-foreground">· {periodLabel}</span>
              )}
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Monats-Überstunden über dem Monatssoll (42 h × Wochen im Monat × Pensum).
              {analysis.affectedEmployeeCount > 0 && (
                <>
                  {' '}
                  {analysis.affectedEmployeeCount} Mitarbeiter betroffen ·{' '}
                  {hrs(analysis.totalOvertimeHours)} Überstunden gesamt.
                </>
              )}
            </p>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <span className="text-muted-foreground">Überstundenkosten einbeziehen</span>
            <Switch checked={includeOvertime} onCheckedChange={onIncludeOvertimeChange} />
          </label>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ── Summen / PKQ (nur bei aggregierter Kostensicht) ──────────────── */}
        {canSeeTotals && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Reguläre Kosten" value={chf(totals.regularCost)} />
            <StatTile
              label="Überstundenkosten"
              value={chf(totals.overtimeCost)}
              accent={totals.overtimeCost > 0 ? 'amber' : 'default'}
            />
            <StatTile
              label={includeOvertime ? 'Total inkl. ÜS' : 'Total exkl. ÜS'}
              value={chf(totals.effectiveTotal)}
              accent="blue"
            />
            <StatTile
              label={includeOvertime ? 'PKQ inkl. ÜS' : 'PKQ exkl. ÜS'}
              value={pct(totals.effectivePkq)}
              accent="blue"
            />
          </div>
        )}

        {analysis.hasUnavailableRates && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Für mindestens einen betroffenen Mitarbeiter ist kein Stundensatz hinterlegt —
              die Überstunden-STUNDEN sind ausgewiesen, die Kosten nicht berechenbar.
            </span>
          </div>
        )}

        {/* ── Mitarbeiter-Tabelle ──────────────────────────────────────────── */}
        {!hasRows ? (
          <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
            Keine festangestellten Mitarbeiter mit produktiven Ist-Stunden in diesem Monat.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mitarbeiter</TableHead>
                  <TableHead>Abteilung</TableHead>
                  <TableHead className="text-right">Pensum</TableHead>
                  <TableHead className="text-right">Soll Monat</TableHead>
                  <TableHead className="text-right">Ist Monat produktiv</TableHead>
                  <TableHead className="text-right">Differenz</TableHead>
                  <TableHead className="text-right">Überstunden</TableHead>
                  {showCostCol && <TableHead className="text-right">Überstundenkosten</TableHead>}
                  {showDisableCol && <TableHead className="text-center">Deaktivieren</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {analysis.employees.map((e) => {
                  const hasOvertime = e.overtimeHours > 0;
                  return (
                    <Fragment key={e.employeeId}>
                      <TableRow className={cn(e.overtimeDisabled && 'opacity-60')}>
                        <TableCell className="font-medium">
                          {e.name}
                          {e.daysOver84Count > 0 && (
                            <span className="ml-1 text-[11px] text-muted-foreground">
                              · {e.daysOver84Count} Tag{e.daysOver84Count === 1 ? '' : 'e'} über{' '}
                              {DAILY_OVERTIME_THRESHOLD}h (Info)
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="capitalize text-muted-foreground">{e.department}</TableCell>
                        <TableCell className="text-right tabular-nums">{wl(e.workloadPercent)}</TableCell>
                        <TableCell className="text-right tabular-nums">{hrs(e.monthlyTargetHours)}</TableCell>
                        <TableCell className="text-right tabular-nums">{hrs(e.productiveHours)}</TableCell>
                        <TableCell
                          className={cn(
                            'text-right tabular-nums',
                            e.difference > 0 ? 'text-amber-600' : e.difference < 0 ? 'text-muted-foreground' : '',
                          )}
                        >
                          {signedHrs(e.difference)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {e.overtimeDisabled ? (
                            <span className="text-xs text-muted-foreground">deaktiviert</span>
                          ) : hasOvertime ? (
                            <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
                              {hrs(e.overtimeHours)}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">{hrs(0)}</span>
                          )}
                        </TableCell>
                        {showCostCol && (
                          <TableCell className="text-right tabular-nums">
                            {e.overtimeDisabled ? (
                              <span className="text-muted-foreground">{chf(0)}</span>
                            ) : e.overtimeCost === null ? (
                              <span className="text-amber-600">kein Satz</span>
                            ) : (
                              chf(e.overtimeCost)
                            )}
                          </TableCell>
                        )}
                        {showDisableCol && (
                          <TableCell className="text-center">
                            <Checkbox
                              checked={e.overtimeDisabled}
                              onCheckedChange={(v) => onToggleEmployeeDisabled?.(e.employeeId, v === true)}
                              aria-label={`Überstunden für ${e.name} deaktivieren`}
                            />
                          </TableCell>
                        )}
                      </TableRow>
                      {e.additionalCostHours > 0 && (
                        <TableRow key={`${e.employeeId}-zusatz`} className="bg-muted/30">
                          <TableCell className="pl-6 text-xs text-muted-foreground" colSpan={4}>
                            ↳ Zusatzkosten ({e.additionalCostDays} Tag{e.additionalCostDays === 1 ? '' : 'e'},
                            bereits im regulären Total)
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                            {hrs(e.additionalCostHours)}
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">—</TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">—</TableCell>
                          {showCostCol && (
                            <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                              {e.additionalCost === null ? '—' : chf(e.additionalCost)}
                            </TableCell>
                          )}
                          {showDisableCol && <TableCell />}
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={6} className="text-right font-medium">
                    Total Überstunden
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {hrs(analysis.totalOvertimeHours)}
                  </TableCell>
                  {showCostCol && (
                    <TableCell className="text-right font-semibold tabular-nums">
                      {chf(analysis.totalOvertimeCost)}
                    </TableCell>
                  )}
                  {showDisableCol && <TableCell />}
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}

        {/* ── Fussnote ─────────────────────────────────────────────────────── */}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Überstunden entstehen ausschliesslich, wenn die produktiven Ist-Stunden des Monats über
          dem Monatssoll (42 h × Wochen im Monat × Pensum) liegen. Abwesenheiten (FE/K/U) und
          manuelle Zusatzkosten zählen nicht als Überstunden. Tage über {DAILY_OVERTIME_THRESHOLD}h
          sind nur informativ. Die Auswertung bezieht sich immer auf den Vollmonat (unabhängig vom
          Stichtag). Manuelle Zusatzkosten sind bereits im regulären Personalkosten-Total enthalten.
        </p>
      </CardContent>
    </Card>
  );
}

function StatTile({
  label,
  value,
  accent = 'default',
}: {
  label: string;
  value: string;
  accent?: 'default' | 'amber' | 'blue';
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        accent === 'amber' && 'border-amber-200 bg-amber-50',
        accent === 'blue' && 'border-blue-200 bg-blue-50',
        accent === 'default' && 'bg-muted/30',
      )}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-base font-semibold tabular-nums',
          accent === 'amber' && 'text-amber-700',
          accent === 'blue' && 'text-blue-700',
        )}
      >
        {value}
      </div>
    </div>
  );
}
