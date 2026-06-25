// ─────────────────────────────────────────────────────────────────────────────
// OvertimeCostCard — Überstundenkosten-Analyse für Festangestellte
// ─────────────────────────────────────────────────────────────────────────────
// Eigenständige, in PersonalFix eingebettete Karte mit ZWEI Ansichten:
//   • Monat  — Überstunden über dem Monatssoll (42 h × Wochen im Monat × Pensum)
//   • Woche  — Überstunden je ISO-Kalenderwoche, anteilig nach Tagen im Monat
//             (Wochensoll = 42 h × Pensum × Tage der Woche im Monat ÷ 7)
//
// Beide Ansichten zeigen:
//   - reguläre Personalkosten, zusätzliche Überstundenkosten, Total inkl./exkl.
//     Überstunden + lokal neu berechnete PKQ (Summen nutzen die AKTIVE Ansicht)
//   - Toggle "Überstundenkosten einbeziehen" (steuert Total + PKQ)
//   - manuelle Zusatzkosten als Unterzeile (reine Anzeige; bereits im regulären
//     Total enthalten, NICHT in den Überstunden)
//
// Berechnung kommt vollständig aus der puren Lib `overtime-analysis`. Diese
// Komponente rendert nur. Berechtigungen (defense-in-depth):
//   - canSeeIndividualRates (canSeeHourlyWages) → individuelle Kosten/Sätze
//   - canSeeTotals (canSeePersonnelCostTotals)  → aggregierte Kosten/PKQ
// Überstunden-STUNDEN sind keine Lohndaten und immer sichtbar.
// ─────────────────────────────────────────────────────────────────────────────
import { Fragment, useState } from 'react';
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
  type WeeklyOvertimeAnalysis,
} from '@/lib/overtime-analysis';

type OvertimeView = 'month' | 'week';

interface OvertimeCostCardProps {
  /** Monatsauswertung (bestehende Logik) */
  analysis: OvertimeAnalysis;
  /** Wochenauswertung (ISO-Wochen anteilig im Monat) */
  weeklyAnalysis: WeeklyOvertimeAnalysis;
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
  weeklyAnalysis,
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
  const [view, setView] = useState<OvertimeView>('month');

  const showCostCol = canSeeIndividualRates;
  const showDisableCol = canManageDisable && !!onToggleEmployeeDisabled;

  // Summen / Kontextzeile nutzen immer die AKTIVE Ansicht.
  const activeOvertimeCost = view === 'week' ? weeklyAnalysis.totalOvertimeCost : analysis.totalOvertimeCost;
  const activeOvertimeHours = view === 'week' ? weeklyAnalysis.totalOvertimeHours : analysis.totalOvertimeHours;
  const activeAffected = view === 'week' ? weeklyAnalysis.affectedEmployeeCount : analysis.affectedEmployeeCount;
  const activeHasUnavailableRates = view === 'week' ? weeklyAnalysis.hasUnavailableRates : analysis.hasUnavailableRates;

  const totals = computeOvertimeTotals(regularCost, activeOvertimeCost, netRevenue, includeOvertime);

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
              {view === 'week'
                ? 'Wochen-Überstunden über dem anteiligen Wochensoll (42 h × Pensum, anteilig nach Tagen im Monat).'
                : 'Monats-Überstunden über dem Monatssoll (42 h × Wochen im Monat × Pensum).'}
              {activeAffected > 0 && (
                <>
                  {' '}
                  {activeAffected} Mitarbeiter betroffen ·{' '}
                  {hrs(activeOvertimeHours)} Überstunden gesamt.
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
        {/* ── Ansichts-Umschalter (Monat | Woche) ──────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-md border bg-muted/40 p-0.5" role="tablist" aria-label="Ansicht">
            <ViewButton active={view === 'month'} onClick={() => setView('month')}>Monat</ViewButton>
            <ViewButton active={view === 'week'} onClick={() => setView('week')}>Woche</ViewButton>
          </div>
          {view === 'week' && (
            <p className="text-xs text-muted-foreground">
              In der Wochenansicht wird jede Kalenderwoche anteilig für den ausgewählten Monat berechnet.
            </p>
          )}
        </div>

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

        {activeHasUnavailableRates && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Für mindestens einen betroffenen Mitarbeiter ist kein Stundensatz hinterlegt —
              die Überstunden-STUNDEN sind ausgewiesen, die Kosten nicht berechenbar.
            </span>
          </div>
        )}

        {/* ── Tabelle (je nach Ansicht) ────────────────────────────────────── */}
        {view === 'month' ? (
          <MonthlyTable
            analysis={analysis}
            showCostCol={showCostCol}
            showDisableCol={showDisableCol}
            onToggleEmployeeDisabled={onToggleEmployeeDisabled}
          />
        ) : (
          <WeeklyTable
            analysis={weeklyAnalysis}
            showCostCol={showCostCol}
            showDisableCol={showDisableCol}
            onToggleEmployeeDisabled={onToggleEmployeeDisabled}
          />
        )}

        {/* ── Fussnote ─────────────────────────────────────────────────────── */}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {view === 'week' ? (
            <>
              In der Wochenansicht entstehen Überstunden, wenn die produktiven Ist-Stunden einer
              Kalenderwoche über dem anteiligen Wochensoll (42 h × Pensum × Tage der Woche im Monat ÷ 7)
              liegen. Randwochen am Monatsanfang/-ende werden anteilig berechnet.
            </>
          ) : (
            <>
              Überstunden entstehen ausschliesslich, wenn die produktiven Ist-Stunden des Monats über
              dem Monatssoll (42 h × Wochen im Monat × Pensum) liegen. Die Auswertung bezieht sich immer
              auf den Vollmonat (unabhängig vom Stichtag).
            </>
          )}
          {' '}Abwesenheiten (FE/K/U) und manuelle Zusatzkosten zählen nicht als Überstunden. Tage über{' '}
          {DAILY_OVERTIME_THRESHOLD}h sind nur informativ. Manuelle Zusatzkosten sind bereits im regulären
          Personalkosten-Total enthalten.
        </p>
      </CardContent>
    </Card>
  );
}

// ── Monatstabelle (bestehende Ansicht) ───────────────────────────────────────
function MonthlyTable({
  analysis,
  showCostCol,
  showDisableCol,
  onToggleEmployeeDisabled,
}: {
  analysis: OvertimeAnalysis;
  showCostCol: boolean;
  showDisableCol: boolean;
  onToggleEmployeeDisabled?: (employeeId: string, disabled: boolean) => void;
}) {
  if (analysis.employees.length === 0) {
    return (
      <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
        Keine festangestellten Mitarbeiter mit produktiven Ist-Stunden in diesem Monat.
      </p>
    );
  }

  return (
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
  );
}

// ── Wochentabelle (ISO-Wochen, gruppiert je Mitarbeiter) ─────────────────────
function WeeklyTable({
  analysis,
  showCostCol,
  showDisableCol,
  onToggleEmployeeDisabled,
}: {
  analysis: WeeklyOvertimeAnalysis;
  showCostCol: boolean;
  showDisableCol: boolean;
  onToggleEmployeeDisabled?: (employeeId: string, disabled: boolean) => void;
}) {
  if (analysis.employees.length === 0) {
    return (
      <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
        Keine festangestellten Mitarbeiter mit produktiven Ist-Stunden in diesem Monat.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Mitarbeiter</TableHead>
            <TableHead>Abteilung</TableHead>
            <TableHead className="text-right">Pensum</TableHead>
            <TableHead>Kalenderwoche</TableHead>
            <TableHead>Zeitraum</TableHead>
            <TableHead className="text-right">Soll Woche</TableHead>
            <TableHead className="text-right">Ist Woche produktiv</TableHead>
            <TableHead className="text-right">Differenz</TableHead>
            <TableHead className="text-right">Überstunden Woche</TableHead>
            {showCostCol && <TableHead className="text-right">Überstundenkosten</TableHead>}
            {showDisableCol && <TableHead className="text-center">Deaktivieren</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {analysis.employees.map((e) => (
            <Fragment key={e.employeeId}>
              {/* Gruppen-Kopfzeile je Mitarbeiter */}
              <TableRow className={cn('border-t-2 bg-muted/40', e.overtimeDisabled && 'opacity-60')}>
                <TableCell className="font-semibold">{e.name}</TableCell>
                <TableCell className="capitalize text-muted-foreground">{e.department}</TableCell>
                <TableCell className="text-right tabular-nums">{wl(e.workloadPercent)}</TableCell>
                <TableCell colSpan={5} className="text-right text-xs text-muted-foreground">
                  Σ Monat (alle Wochen)
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {e.overtimeDisabled ? (
                    <span className="text-xs font-normal text-muted-foreground">deaktiviert</span>
                  ) : (
                    hrs(e.totalOvertimeHours)
                  )}
                </TableCell>
                {showCostCol && (
                  <TableCell className="text-right font-semibold tabular-nums">
                    {e.overtimeDisabled ? (
                      <span className="font-normal text-muted-foreground">{chf(0)}</span>
                    ) : e.totalOvertimeCost === null ? (
                      <span className="font-normal text-amber-600">kein Satz</span>
                    ) : (
                      chf(e.totalOvertimeCost)
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

              {/* Wochenzeilen */}
              {e.weeks.map((w) => {
                const hasOvertime = w.overtimeHours > 0;
                const isPartial = w.daysInMonth < 7;
                return (
                  <Fragment key={`${e.employeeId}-${w.isoYear}-${w.isoWeek}`}>
                    <TableRow className={cn(e.overtimeDisabled && 'opacity-60')}>
                      <TableCell />
                      <TableCell />
                      <TableCell />
                      <TableCell className="whitespace-nowrap">
                        {w.weekLabel}
                        {w.daysOver84Count > 0 && (
                          <span className="ml-1 text-[11px] text-muted-foreground">
                            · {w.daysOver84Count} Tag{w.daysOver84Count === 1 ? '' : 'e'} über{' '}
                            {DAILY_OVERTIME_THRESHOLD}h
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {w.rangeLabel}
                        {isPartial && (
                          <span className="ml-1">· {w.daysInMonth}/7 Tage im Monat</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{hrs(w.weeklyTargetHours)}</TableCell>
                      <TableCell className="text-right tabular-nums">{hrs(w.productiveHours)}</TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          w.difference > 0 ? 'text-amber-600' : w.difference < 0 ? 'text-muted-foreground' : '',
                        )}
                      >
                        {signedHrs(w.difference)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {e.overtimeDisabled ? (
                          <span className="text-xs text-muted-foreground">deaktiviert</span>
                        ) : hasOvertime ? (
                          <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
                            {hrs(w.overtimeHours)}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">{hrs(0)}</span>
                        )}
                      </TableCell>
                      {showCostCol && (
                        <TableCell className="text-right tabular-nums">
                          {e.overtimeDisabled ? (
                            <span className="text-muted-foreground">{chf(0)}</span>
                          ) : w.overtimeCost === null ? (
                            <span className="text-amber-600">kein Satz</span>
                          ) : (
                            chf(w.overtimeCost)
                          )}
                        </TableCell>
                      )}
                      {showDisableCol && <TableCell />}
                    </TableRow>
                    {w.additionalCostHours > 0 && (
                      <TableRow className="bg-muted/20">
                        <TableCell colSpan={6} className="pl-10 text-xs text-muted-foreground">
                          ↳ Zusatzkosten ({w.additionalCostDays} Tag{w.additionalCostDays === 1 ? '' : 'e'},
                          bereits im regulären Total)
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                          {hrs(w.additionalCostHours)}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">—</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">—</TableCell>
                        {showCostCol && (
                          <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                            {w.additionalCost === null ? '—' : chf(w.additionalCost)}
                          </TableCell>
                        )}
                        {showDisableCol && <TableCell />}
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={8} className="text-right font-medium">
              Total Überstunden (alle Wochen)
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
  );
}

function ViewButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded px-3 py-1 text-sm font-medium transition-colors',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
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
