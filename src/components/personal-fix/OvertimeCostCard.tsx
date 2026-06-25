// ─────────────────────────────────────────────────────────────────────────────
// OvertimeCostCard — Überstundenkosten-Analyse für Festangestellte (Drill-down)
// ─────────────────────────────────────────────────────────────────────────────
// Kompakte, manager-freundliche Darstellung mit Aufklapp-Logik (Accordion):
//
//   Ebene 1 — eine Zeile pro Mitarbeiter (Monatsüberblick), sortiert nach den
//             meisten Überstunden. Klick öffnet die Detailansicht.
//   Ebene 2 — Wochenübersicht des Mitarbeiters (ISO-Wochen, anteilig im Monat)
//             + separater Zusatzkosten-Block. Klick auf eine Woche öffnet …
//   Ebene 3 — Tagesdetail der Woche (Datum, Tag, Arbeitszeit, Std. sowie die
//             rein informativen Mehrstunden/-kosten über 8.4 h, Abwesenheit).
//
// Wochen werden erst gerendert, wenn ein Mitarbeiter aufgeklappt ist; Tage erst,
// wenn eine Woche aufgeklappt ist (lazy). Aufgeklappte Zeilen bleiben erhalten,
// solange die Seite geöffnet bleibt (lokaler State).
//
// Die GESAMTE Berechnung kommt unverändert aus der puren Lib `overtime-analysis`
// (Monats- + Wochenauswertung). Diese Komponente rendert nur. Das Tagesdetail
// ist reine Anzeige (buildWeekDayRows) und verändert KEINE Berechnung.
//
// Berechtigungen (defense-in-depth):
//   - canSeeIndividualRates (canSeeHourlyWages) → individuelle Kosten/Sätze
//   - canSeeTotals (canSeePersonnelCostTotals)  → aggregierte Kosten/PKQ
// Überstunden-STUNDEN sind keine Lohndaten und immer sichtbar.
// ─────────────────────────────────────────────────────────────────────────────
import { Fragment, useMemo, useState } from 'react';
import { Clock, AlertTriangle, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  computeOvertimeTotals,
  computeWeekCumulativeBalances,
  defaultSelectedWeekKey,
  buildWeekDayRows,
  computeDailyOvertimeInfo,
  filterEmployeesByDepartment,
  sortEmployeesByOvertimeCost,
  summarizeOvertimeEmployees,
  DEPARTMENT_FILTER_OPTIONS,
  DAILY_OVERTIME_THRESHOLD,
  type DepartmentFilter,
  type OvertimeAnalysis,
  type EmployeeOvertimeResult,
  type WeeklyOvertimeAnalysis,
  type EmployeeWeeklyOvertimeResult,
  type WeekCumulativeBalance,
  type DayDetailEntry,
} from '@/lib/overtime-analysis';

// Manager-Abteilungsfilter merken (reine UI-Präferenz, kein sensibler Wert).
const DEPT_FILTER_STORAGE_KEY = 'pf-overtime-dept-filter';

const readStoredDeptFilter = (): DepartmentFilter => {
  if (typeof window === 'undefined') return 'all';
  try {
    const v = window.localStorage.getItem(DEPT_FILTER_STORAGE_KEY);
    if (v === 'all' || v === 'küche' || v === 'service') return v;
  } catch {
    /* localStorage nicht verfügbar → Default */
  }
  return 'all';
};

const writeStoredDeptFilter = (v: DepartmentFilter): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEPT_FILTER_STORAGE_KEY, v);
  } catch {
    /* ignore */
  }
};

interface OvertimeCostCardProps {
  /** Monatsauswertung (Ebene 1 + Werte je Mitarbeiter) */
  analysis: OvertimeAnalysis;
  /** Wochenauswertung (Ebene 2, ISO-Wochen anteilig im Monat) */
  weeklyAnalysis: WeeklyOvertimeAnalysis;
  /** Tagesdaten des Monats inkl. Abwesenheiten + Zeiten (Ebene 3, reine Anzeige) */
  dayDetailEntries: DayDetailEntry[];
  /** Reguläre Personalkosten (IST) des Monats — Basis für Total/PKQ (inkl. Zusatzkosten) */
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
  /** Status-Umschalter (Checkbox) anzeigen (vom Parent gegated) */
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

const dmShort = (isoDate: string): string => `${isoDate.slice(8, 10)}.${isoDate.slice(5, 7)}.`;

// Kompakte Tabellen-Darstellung (kleinere Zeilenhöhe/Padding) — auf alle drei
// Drill-down-Ebenen angewandt. Aufgeklappte Detailzellen behalten via `!p-0` ihr
// randloses Layout (Descendant-Selektoren würden sonst Padding hinzufügen).
const COMPACT_TABLE = 'text-sm [&_th]:h-9 [&_th]:px-2 [&_td]:px-2 [&_td]:py-1.5';
// Noch kompaktere Variante für die manager-fokussierte Ebene-1-Übersicht.
const OVERVIEW_TABLE = 'text-sm [&_th]:h-8 [&_th]:px-2 [&_td]:px-2 [&_td]:py-1';

export function OvertimeCostCard({
  analysis,
  weeklyAnalysis,
  dayDetailEntries,
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
  const [expandedEmployees, setExpandedEmployees] = useState<Set<string>>(new Set());
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set());
  // Pro Mitarbeiter ausgewählte "aktuelle Woche" (employeeId → "isoYear-isoWeek").
  // Leer = Default (ISO-Woche von heute im Monat). Klick auf eine Woche setzt sie.
  const [selectedWeekByEmployee, setSelectedWeekByEmployee] = useState<Map<string, string>>(new Map());
  // Manager-Abteilungsfilter (Alle/Küche/Service), aus localStorage gemerkt.
  const [deptFilter, setDeptFilter] = useState<DepartmentFilter>(readStoredDeptFilter);
  // Geöffnetes Mitarbeiter-Modal (Klick auf den Namen). null = geschlossen.
  const [modalEmployeeId, setModalEmployeeId] = useState<string | null>(null);

  const showCostCol = canSeeIndividualRates;
  const showStatusToggle = canManageDisable && !!onToggleEmployeeDisabled;

  const changeDeptFilter = (v: DepartmentFilter) => {
    setDeptFilter(v);
    writeStoredDeptFilter(v);
  };

  const toggleEmployee = (id: string) =>
    setExpandedEmployees((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const toggleWeek = (key: string) =>
    setExpandedWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  const selectWeek = (employeeId: string, isoYear: number, isoWeek: number) =>
    setSelectedWeekByEmployee((prev) => {
      const next = new Map(prev);
      next.set(employeeId, `${isoYear}-${isoWeek}`);
      return next;
    });

  // Wochenauswertung je Mitarbeiter (für die aufgeklappte Ebene 2).
  const weeklyByEmployee = useMemo(
    () => new Map<string, EmployeeWeeklyOvertimeResult>(
      weeklyAnalysis.employees.map((w) => [w.employeeId, w]),
    ),
    [weeklyAnalysis],
  );

  // Laufende Wochen-Salden (kumulierte Überstunden + Kosten) je Mitarbeiter —
  // reine Aggregation der bereits berechneten Wochenwerte (keine neue Logik).
  const balancesByEmployee = useMemo(() => {
    const m = new Map<string, WeekCumulativeBalance[]>();
    for (const w of weeklyAnalysis.employees) {
      m.set(w.employeeId, computeWeekCumulativeBalances(w.weeks));
    }
    return m;
  }, [weeklyAnalysis]);

  // Default-"aktuelle Woche" je Mitarbeiter: ISO-Woche von heute (im Monat),
  // sonst erste/letzte Woche. Wird genutzt, solange der Nutzer keine Woche klickt.
  const today = useMemo(() => new Date(), []);
  const defaultWeekByEmployee = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of weeklyAnalysis.employees) {
      const k = defaultSelectedWeekKey(w.weeks, today);
      if (k) m.set(w.employeeId, `${k.isoYear}-${k.isoWeek}`);
    }
    return m;
  }, [weeklyAnalysis, today]);

  // Effektiv ausgewählte Woche eines MA: explizit geklickt > Default.
  // Eine explizite Auswahl bleibt über Monatswechsel im State; existiert sie im
  // aktuellen Monat nicht mehr, fällt sie auf die Default-Woche zurück (sonst
  // zeigte die Hauptzeile „—" statt der aktuellen Woche).
  const effectiveWeekKey = (employeeId: string): string | undefined => {
    const sel = selectedWeekByEmployee.get(employeeId);
    if (sel) {
      const balances = balancesByEmployee.get(employeeId);
      if (balances?.some((b) => `${b.isoYear}-${b.isoWeek}` === sel)) return sel;
    }
    return defaultWeekByEmployee.get(employeeId);
  };

  // Top-Summen: Fixlohnkosten / Überstundenkosten / Zusatzkosten / Total / PKQ.
  // Zusatzkosten sind bereits in `regularCost` enthalten → Fixlohn = regulär − Zusatz
  // (reine Aufgliederung, keine geänderte Berechnung). Total/PKQ via computeOvertimeTotals.
  const totalAdditionalCost = useMemo(
    () => Math.round(analysis.employees.reduce((s, e) => s + (e.additionalCost ?? 0), 0) * 100) / 100,
    [analysis],
  );
  const fixlohnCost = Math.round((regularCost - totalAdditionalCost) * 100) / 100;
  const totals = computeOvertimeTotals(regularCost, analysis.totalOvertimeCost, netRevenue, includeOvertime);

  // Abteilungs-gefilterte Zeilen + Fusszeilen-Summe (rein clientseitig, KEINE
  // Berechnungsänderung). Die Monats-Kacheln oben bleiben monatsweit.
  const displayedEmployees = useMemo(
    () => sortEmployeesByOvertimeCost(filterEmployeesByDepartment(analysis.employees, deptFilter)),
    [analysis.employees, deptFilter],
  );
  const summary = useMemo(() => summarizeOvertimeEmployees(displayedEmployees), [displayedEmployees]);

  const modalEmployee = useMemo(
    () => analysis.employees.find((e) => e.employeeId === modalEmployeeId) ?? null,
    [analysis.employees, modalEmployeeId],
  );

  // Spalten Ebene 1: Chevron · Mitarbeiter · Soll · Ist · ÜS Monat · ÜS Kosten · Zusatzkosten.
  const colCount = 7;

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
              Kompakter Überblick pro Mitarbeiter. Zeile aufklappen für Wochen, Woche aufklappen
              für Tage.
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
        {/* ── Top-Summen / PKQ (nur bei aggregierter Kostensicht) ──────────────── */}
        {canSeeTotals && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatTile label="Fixlohnkosten" value={chf(fixlohnCost)} />
            <StatTile
              label="Überstundenkosten"
              value={chf(analysis.totalOvertimeCost)}
              accent={analysis.totalOvertimeCost > 0 ? 'amber' : 'default'}
            />
            <StatTile label="Zusatzkosten" value={chf(totalAdditionalCost)} />
            <StatTile
              label={includeOvertime ? 'Total Personalkosten (inkl. ÜS)' : 'Total Personalkosten (exkl. ÜS)'}
              value={chf(totals.effectiveTotal)}
              accent="blue"
            />
            <StatTile
              label={includeOvertime ? 'PKQ (inkl. ÜS)' : 'PKQ (exkl. ÜS)'}
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

        {/* ── Abteilungsfilter (Alle / Küche / Service) ────────────────────────── */}
        <div className="flex flex-wrap items-center gap-1.5">
          {DEPARTMENT_FILTER_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              type="button"
              size="sm"
              variant={deptFilter === opt.value ? 'default' : 'outline'}
              className="h-7 px-3 text-xs"
              onClick={() => changeDeptFilter(opt.value)}
              aria-pressed={deptFilter === opt.value}
            >
              {opt.label}
            </Button>
          ))}
        </div>

        {/* ── Ebene 1: Mitarbeiter-Übersicht ───────────────────────────────────── */}
        {displayedEmployees.length === 0 ? (
          <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
            {analysis.employees.length === 0
              ? 'Keine festangestellten Mitarbeiter mit produktiven Ist-Stunden in diesem Monat.'
              : 'Keine Mitarbeiter in dieser Abteilung.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table className={OVERVIEW_TABLE}>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-7" />
                  <TableHead>Mitarbeiter</TableHead>
                  <TableHead className="text-right">Soll Monat</TableHead>
                  <TableHead className="text-right">Ist Monat</TableHead>
                  <TableHead className="text-right">ÜS Monat</TableHead>
                  <TableHead className="text-right">ÜS Kosten</TableHead>
                  <TableHead className="text-right">Zusatzkosten</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayedEmployees.map((e) => {
                  const isOpen = expandedEmployees.has(e.employeeId);
                  const weekly = weeklyByEmployee.get(e.employeeId);
                  const balances = balancesByEmployee.get(e.employeeId) ?? [];
                  const selKey = effectiveWeekKey(e.employeeId);
                  const selBal = balances.find((b) => `${b.isoYear}-${b.isoWeek}` === selKey) ?? null;
                  const enabled = !e.overtimeDisabled;
                  return (
                    <Fragment key={e.employeeId}>
                      <TableRow
                        className={cn('cursor-pointer hover:bg-muted/40', !enabled && 'opacity-60')}
                        onClick={() => toggleEmployee(e.employeeId)}
                      >
                        <TableCell className="align-middle">
                          <ChevronRight
                            className={cn('h-4 w-4 text-muted-foreground transition-transform', isOpen && 'rotate-90')}
                          />
                        </TableCell>
                        <TableCell>
                          <button
                            type="button"
                            onClick={(ev) => { ev.stopPropagation(); setModalEmployeeId(e.employeeId); }}
                            className="inline-flex items-center gap-1.5 text-left hover:underline"
                            aria-label={`Einstellungen für ${e.name}`}
                          >
                            {enabled && (
                              <span
                                className="inline-block h-2 w-2 shrink-0 rounded-full bg-blue-500"
                                aria-hidden="true"
                              />
                            )}
                            <span className={cn(enabled ? 'font-semibold' : 'font-normal text-muted-foreground')}>
                              {e.name}
                            </span>
                          </button>
                          {e.daysOver84Count > 0 && (
                            <span className="ml-1 text-[11px] text-muted-foreground">
                              · {e.daysOver84Count} Tag{e.daysOver84Count === 1 ? '' : 'e'} über{' '}
                              {DAILY_OVERTIME_THRESHOLD}h
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{hrs(e.monthlyTargetHours)}</TableCell>
                        <TableCell className="text-right tabular-nums">{hrs(e.productiveHours)}</TableCell>
                        <TableCell className="text-right">
                          {e.overtimeDisabled ? (
                            <span className="text-xs text-muted-foreground">deaktiviert</span>
                          ) : (
                            <OvertimeBadge hours={e.overtimeHours} />
                          )}
                        </TableCell>
                        <UeberstundenKostenCell
                          monthHours={e.overtimeHours}
                          monthCost={e.overtimeCost}
                          disabled={e.overtimeDisabled}
                          bal={selBal}
                          showCost={showCostCol}
                        />
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {e.additionalCostHours <= 0
                            ? '—'
                            : !showCostCol
                              ? `${e.additionalCostDays} Tag${e.additionalCostDays === 1 ? '' : 'e'}`
                              : e.additionalCost === null
                                ? 'kein Satz'
                                : chf(e.additionalCost)}
                        </TableCell>
                      </TableRow>

                      {/* Ebene 2 + 3 (lazy: nur wenn aufgeklappt) */}
                      {isOpen && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={colCount} className="bg-muted/20 !p-0">
                            <EmployeeDetail
                              employeeId={e.employeeId}
                              weekly={weekly}
                              balances={balances}
                              selectedWeekKey={selKey}
                              onSelectWeek={selectWeek}
                              additionalCostDays={e.additionalCostDays}
                              additionalCost={e.additionalCost}
                              additionalCostHours={e.additionalCostHours}
                              dayDetailEntries={dayDetailEntries}
                              expandedWeeks={expandedWeeks}
                              onToggleWeek={toggleWeek}
                              showCostCol={showCostCol}
                              rate={e.hourlyRate}
                              disabled={e.overtimeDisabled}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={4} className="text-right font-medium">
                    Total
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {hrs(summary.totalOvertimeHours)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {showCostCol ? chf(summary.totalOvertimeCost) : '—'}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {showCostCol ? chf(summary.totalAdditionalCost) : '—'}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}

        {/* ── Fussnote ─────────────────────────────────────────────────────────── */}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Überstunden entstehen, wenn die produktiven Ist-Stunden des Monats über dem Monatssoll
          (42 h × Wochen im Monat × Pensum) liegen; die Wochenansicht rechnet jede Kalenderwoche
          anteilig nach Tagen im Monat. Abwesenheiten (FE/K/U) und manuelle Zusatzkosten zählen nicht
          als Überstunden. Tage über {DAILY_OVERTIME_THRESHOLD}h sind nur informativ. Manuelle
          Zusatzkosten sind bereits im regulären Personalkosten-Total enthalten.
        </p>

        {modalEmployee && (
          <EmployeeOvertimeModal
            employee={modalEmployee}
            canManage={showStatusToggle}
            onSave={(disabled) => {
              onToggleEmployeeDisabled?.(modalEmployee.employeeId, disabled);
              setModalEmployeeId(null);
            }}
            onClose={() => setModalEmployeeId(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ── Ebene 2 + 3: Detailansicht eines Mitarbeiters ────────────────────────────
function EmployeeDetail({
  employeeId,
  weekly,
  balances,
  selectedWeekKey,
  onSelectWeek,
  additionalCostDays,
  additionalCost,
  additionalCostHours,
  dayDetailEntries,
  expandedWeeks,
  onToggleWeek,
  showCostCol,
  rate,
  disabled,
}: {
  employeeId: string;
  weekly?: EmployeeWeeklyOvertimeResult;
  balances: WeekCumulativeBalance[];
  selectedWeekKey?: string;
  onSelectWeek: (employeeId: string, isoYear: number, isoWeek: number) => void;
  additionalCostDays: number;
  additionalCost: number | null;
  additionalCostHours: number;
  dayDetailEntries: DayDetailEntry[];
  expandedWeeks: Set<string>;
  onToggleWeek: (key: string) => void;
  showCostCol: boolean;
  /** Effektiver Stundensatz des MA (für die Tages-Info; enthält Sozialkosten bereits) */
  rate: number | null;
  /** Überstunden des MA deaktiviert → Tages-Mehrkosten 0 */
  disabled: boolean;
}) {
  const balanceByKey = useMemo(
    () => new Map(balances.map((b) => [`${b.isoYear}-${b.isoWeek}`, b])),
    [balances],
  );
  const additionalDays = useMemo(
    () =>
      additionalCostHours > 0
        ? dayDetailEntries
            .filter((d) => d.employeeId === employeeId && d.isAdditionalCost && !d.absenceType && (d.hours ?? 0) > 0)
            .sort((a, b) => a.date.localeCompare(b.date))
        : [],
    [dayDetailEntries, employeeId, additionalCostHours],
  );

  // Chevron · KW · Zeitraum · Soll · Ist · ÜS · Kosten / Saldo.
  const weekColCount = 7;

  return (
    <div className="space-y-4 px-4 py-3">
      {/* Wochenübersicht (Ebene 2) */}
      <div>
        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Wochen
        </div>
        {!weekly || weekly.weeks.length === 0 ? (
          <p className="text-xs text-muted-foreground">Keine Wochendaten in diesem Monat.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border bg-background">
            <Table className={COMPACT_TABLE}>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>KW</TableHead>
                  <TableHead>Zeitraum</TableHead>
                  <TableHead className="text-right">Soll</TableHead>
                  <TableHead className="text-right">Ist</TableHead>
                  <TableHead className="text-right">ÜS</TableHead>
                  <TableHead className="text-right">{showCostCol ? 'Kosten / Saldo' : 'Saldo'}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {weekly.weeks.map((w) => {
                  const weekKey = `${w.isoYear}-${w.isoWeek}`;
                  const key = `${employeeId}::${weekKey}`;
                  const open = expandedWeeks.has(key);
                  const isPartial = w.daysInMonth < 7;
                  const isSelected = selectedWeekKey === weekKey;
                  const bal = balanceByKey.get(weekKey) ?? null;
                  return (
                    <Fragment key={key}>
                      <TableRow
                        className={cn(
                          'cursor-pointer hover:bg-muted/40',
                          weekly.overtimeDisabled && 'opacity-60',
                          isSelected && 'bg-primary/10 hover:bg-primary/15',
                        )}
                        onClick={() => { onSelectWeek(employeeId, w.isoYear, w.isoWeek); onToggleWeek(key); }}
                      >
                        <TableCell>
                          <ChevronRight
                            className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-90')}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-medium">{w.weekLabel}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {w.rangeLabel}
                          {isPartial && <span className="ml-1">· {w.daysInMonth}/7 Tage</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{hrs(w.weeklyTargetHours)}</TableCell>
                        <TableCell className="text-right tabular-nums">{hrs(w.productiveHours)}</TableCell>
                        <TableCell className="text-right">
                          {weekly.overtimeDisabled ? (
                            <span className="text-xs text-muted-foreground">deaktiviert</span>
                          ) : (
                            <OvertimeBadge hours={w.overtimeHours} />
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          {showCostCol && (
                            <div>
                              {weekly.overtimeDisabled ? (
                                <span className="text-muted-foreground">{chf(0)}</span>
                              ) : w.overtimeCost === null ? (
                                <span className="text-amber-600">kein Satz</span>
                              ) : (
                                chf(w.overtimeCost)
                              )}
                            </div>
                          )}
                          <div className="text-[11px] text-muted-foreground">
                            Saldo {bal ? hrs(bal.cumulativeOvertimeHours) : '—'}
                            {showCostCol && bal && (
                              <>
                                {' · '}
                                {bal.cumulativeOvertimeCost === null
                                  ? 'kein Satz'
                                  : chf(bal.cumulativeOvertimeCost)}
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>

                      {/* Ebene 3: Tagesdetail (lazy) */}
                      {open && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={weekColCount} className="bg-muted/30 !p-0">
                            <DayDetailTable
                              employeeId={employeeId}
                              isoYear={w.isoYear}
                              isoWeek={w.isoWeek}
                              dayDetailEntries={dayDetailEntries}
                              rate={rate}
                              disabled={disabled}
                              showCost={showCostCol}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Zusatzkosten-Block (separat, NICHT in den Überstundenzeilen) */}
      {additionalCostHours > 0 && (
        <div className="rounded-md border border-dashed bg-background p-3">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Zusatzkosten
          </div>
          <ul className="space-y-0.5 text-sm">
            {additionalDays.map((d) => (
              <li key={d.date} className="flex items-center justify-between gap-4 text-muted-foreground">
                <span>• {dmShort(d.date)} · {hrs(d.hours ?? 0)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between border-t pt-2 text-sm font-medium">
            <span>
              Total Zusatzkosten ({additionalCostDays} Tag{additionalCostDays === 1 ? '' : 'e'})
            </span>
            {showCostCol && (
              <span className="tabular-nums">
                {additionalCost === null ? 'kein Satz' : chf(additionalCost)}
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Zusatzkosten sind bereits im regulären Personalkosten-Total enthalten und zählen nicht als
            Überstunden.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Ebene 3: Tagesdetail einer Woche ─────────────────────────────────────────
// REINE ANZEIGE. Die Spalten „+Std Info" (Mehrstunden Tag = max(0, produktiv − 8.4))
// und „+CHF Info" (Mehrkosten Tag) sind rein informativ und fliessen NICHT in die
// offizielle (monatliche) Überstundenberechnung ein. „+CHF Info" nutzt denselben
// effektiven Satz wie die offiziellen Kosten (inkl. Sozialkosten) und ist als
// Lohndaten nur bei Kostensicht (showCost) sichtbar; „+Std Info" ist immer sichtbar.
function DayDetailTable({
  employeeId,
  isoYear,
  isoWeek,
  dayDetailEntries,
  rate,
  disabled,
  showCost,
}: {
  employeeId: string;
  isoYear: number;
  isoWeek: number;
  dayDetailEntries: DayDetailEntry[];
  rate: number | null;
  disabled: boolean;
  showCost: boolean;
}) {
  const rows = useMemo(
    () =>
      buildWeekDayRows(dayDetailEntries, employeeId, isoYear, isoWeek).map((d) => ({
        ...d,
        info: computeDailyOvertimeInfo(d.productiveHours, rate, disabled),
      })),
    [dayDetailEntries, employeeId, isoYear, isoWeek, rate, disabled],
  );

  if (rows.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">Keine Tagesdaten für diese Woche.</p>;
  }

  return (
    <div className="overflow-x-auto px-2 py-2">
      <Table className={COMPACT_TABLE}>
        <TableHeader>
          <TableRow>
            <TableHead>Datum</TableHead>
            <TableHead>Tag</TableHead>
            <TableHead>Arbeitszeit</TableHead>
            <TableHead className="text-right">Std.</TableHead>
            <TableHead className="text-right">+Std Info</TableHead>
            {showCost && <TableHead className="text-right">+CHF Info</TableHead>}
            <TableHead>Abw.</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((d) => {
            const hasDayOvertime = !d.absenceType && !d.isAdditionalCost && d.info.overtimeHours > 0;
            return (
              <TableRow key={d.date}>
                <TableCell className="whitespace-nowrap tabular-nums">{d.dayLabel}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{d.weekday}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                  {d.timeRange || '—'}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  {d.absenceType ? '—' : hrs(d.productiveHours)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  {hasDayOvertime ? (
                    <span className="text-amber-600">{signedHrs(d.info.overtimeHours)}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                {showCost && (
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    {!hasDayOvertime ? (
                      <span className="text-muted-foreground">—</span>
                    ) : disabled ? (
                      <span className="text-muted-foreground">{chf(0)}</span>
                    ) : d.info.overtimeCost === null ? (
                      <span className="text-amber-600">kein Satz</span>
                    ) : (
                      <span className="text-amber-600">{chf(d.info.overtimeCost)}</span>
                    )}
                  </TableCell>
                )}
                <TableCell>
                  {d.absenceType ? (
                    <Badge variant="outline" className="border-blue-300 bg-blue-50 text-blue-700">
                      {d.absenceType}
                    </Badge>
                  ) : d.isAdditionalCost ? (
                    <span className="text-xs text-muted-foreground">Zusatzkosten</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ── ÜS-Kosten-Zelle (Ebene 1) ────────────────────────────────────────────────
// ÜS-Kosten-Zelle (gestapelt, 3 Zeilen): oben fett die Monatskosten (Monats-ÜS-
// Stunden + CHF), darunter kleiner/grau die ausgewählte Woche (KW + Stunden + CHF)
// und der kumulierte Saldo bis zu dieser Woche. CHF-Beträge nur bei `showCost`
// (canSeeIndividualRates); Stunden(-Salden) sind keine Lohndaten und immer sichtbar.
function UeberstundenKostenCell({
  monthHours,
  monthCost,
  disabled,
  bal,
  showCost,
}: {
  monthHours: number;
  monthCost: number | null;
  disabled: boolean;
  bal: WeekCumulativeBalance | null;
  showCost: boolean;
}) {
  const costStr = (c: number | null): string => (c === null ? 'kein Satz' : chf(c));
  const monthCostDisplay = disabled ? 0 : monthCost;
  const saldoTitle = bal
    ? `Saldo bis KW ${bal.isoWeek}: ${hrs(bal.cumulativeOvertimeHours)}` +
      (showCost ? ` / ${costStr(bal.cumulativeOvertimeCost)}` : '')
    : undefined;
  return (
    <TableCell className="text-right tabular-nums" title={saldoTitle}>
      {/* Monatskosten (Hauptwert) */}
      <div className="text-xs font-semibold">
        <span className="text-muted-foreground">Monat:</span>{' '}
        {hrs(monthHours)}
        {showCost && <> · {costStr(monthCostDisplay)}</>}
      </div>
      {/* Ausgewählte Woche + kumulierter Saldo bis zu dieser Woche */}
      {bal && (
        <>
          <div className="text-[11px] text-muted-foreground">
            KW {bal.isoWeek}: {hrs(bal.overtimeHours)}
            {showCost && <> · {costStr(bal.overtimeCost)}</>}
          </div>
          <div className="text-[11px] text-muted-foreground">
            Saldo: {hrs(bal.cumulativeOvertimeHours)}
            {showCost && <> · {costStr(bal.cumulativeOvertimeCost)}</>}
          </div>
        </>
      )}
    </TableCell>
  );
}

// ── Mitarbeiter-Einstellungs-Modal (Klick auf den Namen) ──────────────────────
// Zeigt Name + Infos (aktuelle Einstellung/Pensum/Soll/Überstunden) und — sofern
// erlaubt — die Checkbox „Überstundenkosten für diesen Mitarbeiter berechnen"
// (angehakt = NICHT deaktiviert). Speichern ruft onSave(disabled). KEINE
// Berechnungsänderung; spiegelt nur das bestehende Deaktivieren-Flag.
function EmployeeOvertimeModal({
  employee,
  canManage,
  onSave,
  onClose,
}: {
  employee: EmployeeOvertimeResult;
  canManage: boolean;
  onSave: (disabled: boolean) => void;
  onClose: () => void;
}) {
  const [calc, setCalc] = useState(!employee.overtimeDisabled);
  // calc(true) = "Überstundenkosten berechnen" → neuer Deaktiviert-Status = !calc.
  // Unverändert, wenn der neue Status dem aktuellen entspricht → Speichern gesperrt.
  const unchanged = !calc === employee.overtimeDisabled;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{employee.name}</DialogTitle>
        </DialogHeader>

        {canManage && (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3">
            <Checkbox
              checked={calc}
              onCheckedChange={(v) => setCalc(v === true)}
              aria-label="Überstundenkosten für diesen Mitarbeiter berechnen"
              className="mt-0.5"
            />
            <span className="text-sm leading-snug">Überstundenkosten für diesen Mitarbeiter berechnen</span>
          </label>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Aktuelle Einstellung</dt>
          <dd className="text-right font-medium">
            {employee.overtimeDisabled ? 'Deaktiviert' : 'Aktiviert'}
          </dd>
          <dt className="text-muted-foreground">Pensum</dt>
          <dd className="text-right tabular-nums">{wl(employee.workloadPercent)}</dd>
          <dt className="text-muted-foreground">Soll Monat</dt>
          <dd className="text-right tabular-nums">{hrs(employee.monthlyTargetHours)}</dd>
          <dt className="text-muted-foreground">Ist Monat</dt>
          <dd className="text-right tabular-nums">{hrs(employee.productiveHours)}</dd>
          <dt className="text-muted-foreground">Überstunden Monat</dt>
          <dd className="text-right tabular-nums">{hrs(employee.overtimeHours)}</dd>
        </dl>

        <DialogFooter>
          {canManage ? (
            <>
              <Button type="button" variant="outline" onClick={onClose}>Abbrechen</Button>
              <Button type="button" disabled={unchanged} onClick={() => onSave(!calc)}>Speichern</Button>
            </>
          ) : (
            <Button type="button" onClick={onClose}>Schließen</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Überstunden-Badge (grün 0 / orange 1–5h / rot >5h) ────────────────────────
function OvertimeBadge({ hours }: { hours: number }) {
  const cls =
    hours <= 0
      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
      : hours <= 5
        ? 'border-amber-300 bg-amber-50 text-amber-700'
        : 'border-red-300 bg-red-50 text-red-700';
  return (
    <Badge variant="outline" className={cn('tabular-nums', cls)}>
      {hrs(hours)}
    </Badge>
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
