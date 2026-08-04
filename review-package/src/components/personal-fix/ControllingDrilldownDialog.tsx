/**
 * Personalcontrolling-Drilldown-Dialog (Personal FIX).
 *
 * Zeigt die Ursachenanalyse zum Flex-Personalaufwand mit Tagesgranularität:
 * Gruppierung Tage / Positionen / Mitarbeitende, Periode Tag / Woche / Monat,
 * Suche, Sortierung, Ursachen-Pills, Erklärungssätze und CSV-Export.
 *
 * Abstimmungs-Prinzip (SSOT): die Tabelle deckt NUR variable Arbeit + Zusatz-
 * kosten ab (einzige Ebene mit Tagesdaten). Fixlöhne + Ferienabbau werden als
 * Monatslinien aus `bridge` (= pfix.active, von der Seite durchgereicht — hier
 * NIE neu berechnet) zur Brücke auf das Total ergänzt.
 * Fokus 'er' rendert stattdessen die monatliche Überleitung App ↔ Erfolgsrechnung.
 */
import { useMemo, useState } from 'react';
import { ArrowLeft, CalendarDays, Download, Search } from 'lucide-react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KpiCard, KpiGrid } from '@/components/ui/kpi-card';
import { StatusPill } from '@/components/ui/status-pill';
import { HintBox } from '@/components/ui/hint-box';
import { InfoTip } from '@/components/ui/info-tip';
import { TONE_TEXT } from '@/components/ui/tones';
import { TABLE, TH, TH_NUM, TD, TD_NUM, ROW_CLICKABLE } from '@/components/ui/table-style';
import { cn } from '@/lib/utils';
import {
  buildFactCells,
  buildDrilldownRows,
  buildDrilldownCsv,
  buildMainCauseSentence,
  summarizeDrilldownCells,
  buildDetailShiftRows,
  buildDetailKpis,
  buildDetailContext,
  filterCellsForSelection,
  reconcileDetail,
  sortShiftRows,
  buildShiftCsv,
  detailTitleForSelection,
  DRILLDOWN_CAUSE_LABEL,
  DRILLDOWN_SHIFT_FLAG_LABEL,
  type DrilldownInput,
  type DrilldownGroup,
  type DrilldownPeriod,
  type DrilldownRow,
  type DrilldownDetailSelection,
  type DrilldownFactCell,
  type ShiftSortCol,
} from '@/lib/personal-controlling-drilldown';
import {
  fmtChfWhole,
  type ComparisonTone,
  type ErfolgsrechnungVergleich,
} from '@/lib/personal-fix-reconciliation';

// ── Typen ────────────────────────────────────────────────────────────────────

export type DrilldownFocus = 'ist' | 'budget' | 'abweichung' | 'quote' | 'er';

/** Monatswerte aus pfix.active — SSOT der Seite, hier nur angezeigt. */
export interface DrilldownBridge {
  fixCHF: number;
  varArbeitPlanCHF: number;
  varArbeitIstCHF: number;
  ferienPlanCHF: number;
  ferienIstCHF: number;
  planTotalCHF: number;
  istTotalCHF: number;
}

export interface ControllingDrilldownDialogProps {
  focus: DrilldownFocus;
  onClose: () => void;
  monthLabel: string;
  cutoffDay: number | null;
  input: DrilldownInput;
  bridge: DrilldownBridge;
  pkqIst: number | null;
  pkqBudget: number | null;
  effectiveRevenue: number;
  revenueIsAssumed: boolean;
  /** true = manuelle variable Stunden (varHours) aktiv → Tagesdaten ≠ KPI-Basis. */
  manualVarHours: boolean;
  /** Überstundenkosten des Monats (separat ausgewiesen, nicht im Flex-Total). */
  overtimeCostCHF: number;
  er: ErfolgsrechnungVergleich;
  /**
   * ER-Überleitung: Kern-Zerlegung (pkZentral.kHr) der App-Hochrechnung —
   * Fix + Flex = er.berechnetCHF (dieselbe SSOT wie Kopf/Block B). NICHT die
   * alte pfix-Zerlegung (Fix + VarArbeit + Ferien), deren Total abweichen kann.
   */
  coreFixCHF: number;
  coreFlexCHF: number;
  /** Navigation zum Dienstplan (bestehende Route) — optional, ohne Router-Kopplung. */
  onOpenSchedule?: () => void;
}

const FOCUS_TITLE: Record<DrilldownFocus, string> = {
  ist:        'Drilldown: Personalaufwand Ist',
  budget:     'Drilldown: Budget vs. Ist',
  abweichung: 'Drilldown: Abweichung Ist − Budget',
  quote:      'Drilldown: Personalquote',
  er:         'Überleitung: App vs. Erfolgsrechnung',
};

const GROUP_LABEL: Record<DrilldownGroup, string> = {
  day: 'Tage', employee: 'Mitarbeitende', position: 'Positionen',
};
const PERIOD_LABEL: Record<DrilldownPeriod, string> = {
  day: 'Tag', week: 'Woche', month: 'Monat',
};

type SortCol = 'label' | 'planH' | 'istH' | 'diffH' | 'planCHF' | 'istCHF' | 'diffCHF' | 'revenue' | 'pkqPct';

const fmtH = (n: number) =>
  n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const signH = (n: number) => `${n >= 0 ? '+' : '−'}${fmtH(Math.abs(n))}`;
// fmtChfWhole liefert "CHF 1'234" mit geschütztem Leerzeichen (de-CH) — Präfix via Regex entfernen
const chfNumber = (n: number) => fmtChfWhole(n).replace(/CHF\s*/u, '');
const signChf = (n: number) => `${n >= 0 ? '+' : '−'}${chfNumber(Math.abs(n))}`;

function ToggleGroup<T extends string>({ value, options, labels, onChange, testidPrefix }: {
  value: T; options: T[]; labels: Record<T, string>; onChange: (v: T) => void; testidPrefix: string;
}) {
  return (
    <div className="inline-flex rounded-md border border-border p-0.5">
      {options.map(o => (
        <button
          key={o}
          type="button"
          data-testid={`${testidPrefix}-${o}`}
          onClick={() => onChange(o)}
          className={cn(
            'rounded px-2 py-1 text-xs transition-colors',
            o === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {labels[o]}
        </button>
      ))}
    </div>
  );
}

// ── Hauptkomponente ──────────────────────────────────────────────────────────

export function ControllingDrilldownDialog(props: ControllingDrilldownDialogProps) {
  const { focus, onClose, monthLabel, cutoffDay, input, bridge } = props;

  const [group, setGroup] = useState<DrilldownGroup>('day');
  const [period, setPeriod] = useState<DrilldownPeriod>('day');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ col: SortCol; dir: 1 | -1 } | null>(null);
  /** Zweite Drilldown-Stufe: angeklickte Zeile (Snapshot für Filter + Abstimmung). */
  const [detail, setDetail] = useState<{ sel: DrilldownDetailSelection; row: DrilldownRow } | null>(null);

  const openDetail = (row: DrilldownRow, g: DrilldownGroup, p: DrilldownPeriod) =>
    setDetail({
      sel: { group: g, period: p, key: row.key, label: row.label, sublabel: row.sublabel },
      row,
    });

  const cells = useMemo(() => buildFactCells(input), [input]);
  const totals = useMemo(() => summarizeDrilldownCells(cells, input), [cells, input]);
  const rows = useMemo(
    () => buildDrilldownRows(input, cells, { group, period }),
    [input, cells, group, period],
  );
  /** Hauptursachen-Satz immer auf Tagesbasis (unabhängig von der aktuellen Gruppierung). */
  const daySentence = useMemo(() => {
    const dayRows = group === 'day' && period === 'day'
      ? rows
      : buildDrilldownRows(input, cells, { group: 'day', period: 'day' });
    return buildMainCauseSentence(dayRows);
  }, [input, cells, rows, group, period]);

  const visibleRows = useMemo(() => {
    let out = rows;
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter(r =>
        r.label.toLowerCase().includes(q)
        || (r.sublabel ?? '').toLowerCase().includes(q)
        || r.explanation.toLowerCase().includes(q)
        || r.causes.some(c => DRILLDOWN_CAUSE_LABEL[c.cause].toLowerCase().includes(q)));
    }
    if (sort) {
      out = [...out].sort((a, b) => {
        if (sort.col === 'label') return sort.dir * a.label.localeCompare(b.label, 'de-CH');
        const av = a[sort.col] ?? Number.NEGATIVE_INFINITY;
        const bv = b[sort.col] ?? Number.NEGATIVE_INFINITY;
        return sort.dir * ((av as number) - (bv as number));
      });
    }
    return out;
  }, [rows, search, sort]);

  const toggleSort = (col: SortCol) =>
    setSort(prev => (prev?.col === col ? (prev.dir === 1 ? { col, dir: -1 } : null) : { col, dir: 1 }));
  const sortMark = (col: SortCol) => (sort?.col === col ? (sort.dir === 1 ? ' ↑' : ' ↓') : '');

  const isTimeGroup = group === 'day';
  const groupHeader = isTimeGroup ? (period === 'day' ? 'Tag' : period === 'week' ? 'Woche' : 'Monat') : GROUP_LABEL[group];

  const handleExport = () => {
    const csv = buildDrilldownCsv(visibleRows, groupHeader);
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `personalcontrolling-drilldown-${input.year}-${String(input.month).padStart(2, '0')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const cutoffSuffix = cutoffDay !== null ? ` (bis ${cutoffDay}.)` : '';
  const diffFlexCHF = totals.diffCHF;
  const diffTotalCHF = bridge.istTotalCHF - bridge.planTotalCHF;
  const kpiTone: ComparisonTone = diffTotalCHF > 0 ? (diffTotalCHF > 500 ? 'critical' : 'warn') : 'good';

  // Abstimmungskontrolle: Tabellen-Summe (Ist) ↔ pfix-Flex-Ist. Bei manueller
  // Stundenanpassung weicht das bewusst ab (Hinweisbox), sonst nur Rundung.
  const reconDiff = Math.round((totals.istCHF - bridge.varArbeitIstCHF) * 100) / 100;
  const reconOk = Math.abs(reconDiff) < 1;

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent
        data-testid="pfix-dd-dialog"
        aria-describedby={undefined}
        className="w-[min(1100px,95vw)] max-w-none max-h-[88vh] overflow-y-auto"
        onEscapeKeyDown={e => {
          // Escape schliesst nur die Detailstufe, nicht den ganzen Dialog.
          if (detail) { e.preventDefault(); setDetail(null); }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {FOCUS_TITLE[focus]}
            <span className="text-sm font-normal text-muted-foreground">
              {monthLabel}{cutoffSuffix}
            </span>
          </DialogTitle>
        </DialogHeader>

        {focus === 'er' ? (
          <ErBridgeView {...props} />
        ) : detail ? (
          <DetailView
            input={input}
            cells={cells}
            sel={detail.sel}
            parentRow={detail.row}
            onBack={() => setDetail(null)}
            onOpenSchedule={props.onOpenSchedule}
          />
        ) : (
          <div className="space-y-4">
            {(props.revenueIsAssumed || props.manualVarHours) && (
              <div data-testid="pfix-dd-hint-manual">
                <HintBox tone="warn" title="Manuelle Anpassung aktiv">
                  {props.manualVarHours
                    ? 'Die variablen Stunden sind manuell übersteuert — die Tagesdaten unten zeigen die Dienstplan-/Stempel-Basis, nicht die manuelle Eingabe. '
                    : ''}
                  {props.revenueIsAssumed
                    ? 'Der Umsatz ist eine manuelle Annahme — Tagesquoten basieren auf den erfassten Tagesumsätzen.'
                    : ''}
                </HintBox>
              </div>
            )}

            <div data-testid="pfix-dd-kpis">
              <KpiGrid>
                <KpiCard
                  label="Flex-Aufwand Ist"
                  value={fmtChfWhole(totals.istCHF)}
                  sub={`Plan ${fmtChfWhole(totals.planCHF)} (variable Arbeit + Zusatz)`}
                  tone={diffFlexCHF > 0 ? 'warn' : 'good'}
                />
                <KpiCard
                  label="Abweichung Flex"
                  value={`${signChf(diffFlexCHF)} CHF`}
                  sub={`${signH(totals.diffH)} h gegenüber Soll`}
                  tone={diffFlexCHF > 0 ? (diffFlexCHF > 500 ? 'critical' : 'warn') : 'good'}
                />
                <KpiCard
                  label="Total Ist (inkl. FIX)"
                  value={fmtChfWhole(bridge.istTotalCHF)}
                  sub={`Budget ${fmtChfWhole(bridge.planTotalCHF)} · ${signChf(diffTotalCHF)} CHF`}
                  tone={kpiTone}
                />
                <KpiCard
                  label="Personalquote Ist"
                  value={props.pkqIst !== null ? `${props.pkqIst.toFixed(1)} %` : '—'}
                  sub={props.pkqBudget !== null ? `Budget ${props.pkqBudget.toFixed(1)} %` : 'Kein Umsatz erfasst'}
                  tone={props.pkqIst !== null && props.pkqBudget !== null
                    ? (props.pkqIst > props.pkqBudget + 1 ? 'critical' : props.pkqIst < props.pkqBudget - 1 ? 'good' : 'neutral')
                    : 'neutral'}
                />
              </KpiGrid>
            </div>

            {daySentence && (
              <p data-testid="pfix-dd-sentence" className="text-sm text-muted-foreground">
                {daySentence}
              </p>
            )}

            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                value={group}
                options={['day', 'position', 'employee'] as DrilldownGroup[]}
                labels={GROUP_LABEL}
                onChange={g => { setGroup(g); setSort(null); }}
                testidPrefix="pfix-dd-group"
              />
              {isTimeGroup && (
                <ToggleGroup
                  value={period}
                  options={['day', 'week', 'month'] as DrilldownPeriod[]}
                  labels={PERIOD_LABEL}
                  onChange={p => { setPeriod(p); setSort(null); }}
                  testidPrefix="pfix-dd-period"
                />
              )}
              <div className="relative ml-auto">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  data-testid="pfix-dd-search"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Suchen (Name, Ursache …)"
                  className="h-8 w-48 pl-7 text-xs"
                />
              </div>
              <Button
                data-testid="pfix-dd-export"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={handleExport}
              >
                <Download className="h-3.5 w-3.5" />
                CSV
              </Button>
            </div>

            {/* Tabelle */}
            <div className="max-h-[45vh] overflow-auto rounded-md border border-border">
              <table className={TABLE} data-testid="pfix-dd-table">
                <thead className="sticky top-0 z-10 bg-muted">
                  <tr>
                    <th className={cn(TH, 'cursor-pointer select-none bg-muted')} onClick={() => toggleSort('label')}>
                      {groupHeader}{sortMark('label')}
                    </th>
                    <th className={cn(TH, TH_NUM, 'cursor-pointer select-none bg-muted')} onClick={() => toggleSort('planH')}>Plan h{sortMark('planH')}</th>
                    <th className={cn(TH, TH_NUM, 'cursor-pointer select-none bg-muted')} onClick={() => toggleSort('istH')}>Ist h{sortMark('istH')}</th>
                    <th className={cn(TH, TH_NUM, 'cursor-pointer select-none bg-muted')} onClick={() => toggleSort('diffH')}>Diff h{sortMark('diffH')}</th>
                    <th className={cn(TH, TH_NUM, 'cursor-pointer select-none bg-muted')} onClick={() => toggleSort('planCHF')}>Plan CHF{sortMark('planCHF')}</th>
                    <th className={cn(TH, TH_NUM, 'cursor-pointer select-none bg-muted')} onClick={() => toggleSort('istCHF')}>Ist CHF{sortMark('istCHF')}</th>
                    <th className={cn(TH, TH_NUM, 'cursor-pointer select-none bg-muted')} onClick={() => toggleSort('diffCHF')}>Diff CHF{sortMark('diffCHF')}</th>
                    {isTimeGroup && (
                      <>
                        <th className={cn(TH, TH_NUM, 'cursor-pointer select-none bg-muted')} onClick={() => toggleSort('revenue')}>Umsatz{sortMark('revenue')}</th>
                        <th className={cn(TH, TH_NUM, 'cursor-pointer select-none bg-muted')} onClick={() => toggleSort('pkqPct')}>
                          <span className="inline-flex items-center gap-1">
                            Quote %{sortMark('pkqPct')}
                            <InfoTip side="top" text="Näherung: Flex-Ist des Tages + anteilige Fixkosten (gleichmässig pro Tag verteilt), geteilt durch den Netto-Tagesumsatz." />
                          </span>
                        </th>
                      </>
                    )}
                    <th className={cn(TH, 'bg-muted')}>Ursachen</th>
                    <th className={cn(TH, 'bg-muted')}>Erklärung</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 && (
                    <tr>
                      <td className={cn(TD, 'text-muted-foreground')} colSpan={isTimeGroup ? 11 : 9}>
                        Keine Zeilen — Suchfilter anpassen oder Daten importieren.
                      </td>
                    </tr>
                  )}
                  {visibleRows.map(r => (
                    <tr
                      key={r.key}
                      data-testid={`pfix-dd-row-${r.key}`}
                      tabIndex={0}
                      aria-label={`Details zu ${r.label} öffnen`}
                      className={cn(
                        'border-t border-border/60',
                        ROW_CLICKABLE,
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      )}
                      onClick={() => openDetail(r, group, period)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openDetail(r, group, period);
                        }
                      }}
                    >
                      <td className={TD}>
                        <span className="font-medium">{r.label}</span>
                        {r.sublabel && <span className="ml-1.5 text-[11px] text-muted-foreground">{r.sublabel}</span>}
                      </td>
                      <td className={cn(TD, TD_NUM)}>{fmtH(r.planH)}</td>
                      <td className={cn(TD, TD_NUM)}>{fmtH(r.istH)}</td>
                      <td className={cn(TD, TD_NUM, r.diffH > 0 ? TONE_TEXT[r.tone] : undefined)}>{signH(r.diffH)}</td>
                      <td className={cn(TD, TD_NUM)}>{chfNumber(r.planCHF)}</td>
                      <td className={cn(TD, TD_NUM)}>{chfNumber(r.istCHF)}</td>
                      <td className={cn(TD, TD_NUM, 'font-semibold', TONE_TEXT[r.tone])}>{signChf(r.diffCHF)}</td>
                      {isTimeGroup && (
                        <>
                          <td className={cn(TD, TD_NUM)}>{r.revenue !== null ? chfNumber(r.revenue) : '—'}</td>
                          <td className={cn(TD, TD_NUM)}>{r.pkqPct !== null ? `${r.pkqPct.toFixed(1)} %` : '—'}</td>
                        </>
                      )}
                      <td className={TD}>
                        <span className="flex flex-wrap gap-1">
                          {r.causes.slice(0, 3).map(c => (
                            <StatusPill
                              key={c.cause}
                              size="xs"
                              tone={c.cause === 'fehlende_stempelung' || c.cause === 'ungeplant' ? 'critical'
                                : c.cause === 'ferien' ? 'info'
                                : c.cause === 'weniger_stunden' ? 'neutral'
                                : 'warn'}
                            >
                              {DRILLDOWN_CAUSE_LABEL[c.cause]}{c.count > 1 ? ` ×${c.count}` : ''}
                            </StatusPill>
                          ))}
                          {r.causes.length > 3 && (
                            <span className="text-[11px] text-muted-foreground">+{r.causes.length - 3}</span>
                          )}
                        </span>
                      </td>
                      <td className={cn(TD, 'max-w-[260px] text-[11px] text-muted-foreground')}>{r.explanation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Abstimmungs-Brücke auf das Total (SSOT: pfix.active) */}
            <div data-testid="pfix-dd-footer" className="rounded-md border border-border bg-muted/20 p-3 text-xs">
              <p className="mb-1.5 font-semibold text-muted-foreground">
                Brücke zum Total Personalaufwand{cutoffSuffix}
                <InfoTip
                  side="top"
                  text="Nur variable Arbeit + Zusatzkosten haben Tagesdaten. Fixlöhne und Ferienabbau liegen monatlich vor und werden hier als Monatslinien ergänzt — die Werte stammen 1:1 aus der Personal-FIX-Berechnung."
                />
              </p>
              <table className="w-full tabular-nums">
                <tbody>
                  <tr>
                    <td className="py-0.5">Variable Arbeit + Zusatz (Tabelle)</td>
                    <td className="py-0.5 text-right">{fmtChfWhole(bridge.varArbeitIstCHF)}</td>
                  </tr>
                  <tr>
                    <td className="py-0.5">Ferienabbau (Monatslinie)</td>
                    <td className="py-0.5 text-right">{fmtChfWhole(bridge.ferienIstCHF)}</td>
                  </tr>
                  <tr>
                    <td className="py-0.5">Personal FIX (Monatslinie)</td>
                    <td className="py-0.5 text-right">{fmtChfWhole(bridge.fixCHF)}</td>
                  </tr>
                  <tr className="border-t border-border font-semibold">
                    <td className="py-1">Total Personalaufwand Ist</td>
                    <td className="py-1 text-right" data-testid="pfix-dd-footer-total">{fmtChfWhole(bridge.istTotalCHF)}</td>
                  </tr>
                </tbody>
              </table>
              {!reconOk && !props.manualVarHours && (
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400" data-testid="pfix-dd-recon-warn">
                  Hinweis: Tabellen-Summe ({fmtChfWhole(totals.istCHF)}) weicht {signChf(reconDiff)} CHF von der
                  Personal-FIX-Flexsumme ab (Rundung/Datenstand).
                </p>
              )}
              {props.overtimeCostCHF > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground" data-testid="pfix-dd-overtime-note">
                  Überstundenkosten Festangestellte: {fmtChfWhole(props.overtimeCostCHF)} — separat ausgewiesen,
                  nicht Teil des Flex-Totals (Monatssicht, keine Tageszuordnung).
                </p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── ER-Überleitung (monatlich, keine Tagesdaten) ─────────────────────────────

function ErBridgeView(props: ControllingDrilldownDialogProps) {
  const { er, coreFixCHF, coreFlexCHF } = props;
  if (er.status !== 'ok') {
    return (
      <HintBox tone="info" title="Erfolgsrechnung fehlt">
        Für diesen Monat ist kein Personalaufwand in der Erfolgsrechnung erfasst —
        die Überleitung kann nicht angezeigt werden. Erfolgsrechnung importieren unter „Reporting".
      </HintBox>
    );
  }
  // Kern-Zerlegung (SSOT): Fix + Flex = er.berechnetCHF (= pkZentral.kHr.total).
  // Rundungsrest gegen die angezeigte Summe der Vollständigkeit halber ausweisen.
  const rest = Math.round((er.berechnetCHF - coreFixCHF - coreFlexCHF) * 100) / 100;
  const rows: Array<{ label: string; value: number; sub?: string }> = [
    { label: 'Personal FIX (Monatslöhne inkl. AG-Kosten)', value: coreFixCHF },
    { label: 'Flex (variable Arbeit + Zusatzkosten, Hochrechnung)', value: coreFlexCHF },
    ...(Math.abs(rest) >= 0.5 ? [{ label: 'Rundung', value: rest }] : []),
  ];
  return (
    <div className="space-y-3" data-testid="pfix-dd-er-bridge">
      <HintBox tone="info" title="Monatliche Kontrolle">
        Die Erfolgsrechnung liegt nur monatlich vor — hier gibt es bewusst keine Tagesaufschlüsselung.
        Verglichen wird die App-Hochrechnung des Personalaufwands (Fix + Flex aus dem
        Personalkosten-Kern) mit „Löhne (Total)" + „Sozialleistungen" der FIBU.
      </HintBox>
      <table className="w-full text-sm tabular-nums">
        <tbody>
          {rows.map(r => (
            <tr key={r.label} className="border-t border-border/60">
              <td className="py-1.5">{r.label}</td>
              <td className="py-1.5 text-right">{fmtChfWhole(r.value)}</td>
            </tr>
          ))}
          <tr className="border-t border-border font-semibold">
            <td className="py-1.5">App: Total Personalaufwand (Hochrechnung)</td>
            <td className="py-1.5 text-right" data-testid="pfix-dd-er-app-total">{fmtChfWhole(er.berechnetCHF)}</td>
          </tr>
          <tr className="border-t border-border/60">
            <td className="py-1.5">Erfolgsrechnung: Löhne + Sozialleistungen</td>
            <td className="py-1.5 text-right">{fmtChfWhole(er.fibuCHF)}</td>
          </tr>
          <tr className="border-t border-border font-semibold">
            <td className="py-1.5">Differenz App − ER</td>
            <td className={cn('py-1.5 text-right', TONE_TEXT[er.tone])} data-testid="pfix-dd-er-diff">
              {signChf(er.diffCHF)} CHF
            </td>
          </tr>
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        Typische Gründe für Differenzen: 13. Monatslohn-Abgrenzung, Sozialkosten-Sätze,
        noch nicht verbuchte Löhne oder manuell angepasste Stunden in der App.
      </p>
    </div>
  );
}

// ── Detailstufe: Tages-/Schichtansicht einer angeklickten Zeile ──────────────

const TONE_STATUS_LABEL: Record<ComparisonTone, string> = {
  good: 'Im Plan',
  warn: 'Über Plan',
  critical: 'Deutlich über Plan',
  neutral: 'Neutral',
};

function DetailView({ input, cells, sel, parentRow, onBack, onOpenSchedule }: {
  input: DrilldownInput;
  cells: DrilldownFactCell[];
  sel: DrilldownDetailSelection;
  parentRow: DrilldownRow;
  onBack: () => void;
  onOpenSchedule?: () => void;
}) {
  const [shiftSort, setShiftSort] = useState<{ col: ShiftSortCol; dir: 1 | -1 } | null>(null);

  const baseRows = useMemo(() => buildDetailShiftRows(input, cells, sel), [input, cells, sel]);
  const shiftRows = useMemo(() => sortShiftRows(baseRows, shiftSort), [baseRows, shiftSort]);
  const kpis = useMemo(() => buildDetailKpis(baseRows), [baseRows]);
  const context = useMemo(
    () => buildDetailContext(input, filterCellsForSelection(input, cells, sel)),
    [input, cells, sel],
  );
  const recon = useMemo(() => reconcileDetail(baseRows, parentRow), [baseRows, parentRow]);

  const multiDay = context.dates.length > 1;
  const mainCause = parentRow.causes.length > 0 ? DRILLDOWN_CAUSE_LABEL[parentRow.causes[0].cause] : null;

  const toggleShiftSort = (col: ShiftSortCol) =>
    setShiftSort(prev => (prev?.col === col ? (prev.dir === 1 ? { col, dir: -1 } : null) : { col, dir: 1 }));
  const shiftSortMark = (col: ShiftSortCol) =>
    shiftSort?.col === col ? (shiftSort.dir === 1 ? ' ↑' : ' ↓') : '';

  const handleShiftExport = () => {
    const csv = buildShiftCsv(shiftRows);
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `personalcontrolling-detail-${input.year}-${String(input.month).padStart(2, '0')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const thSort = (col: ShiftSortCol, label: string, num = true) => (
    <th
      className={cn(TH, num && TH_NUM, 'cursor-pointer select-none bg-muted')}
      onClick={() => toggleShiftSort(col)}
    >
      {label}{shiftSortMark(col)}
    </th>
  );

  return (
    <div className="space-y-4" data-testid="pfix-dd-detail">
      {/* Kopf: Zurück + Aktionen */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          data-testid="pfix-dd-back"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={onBack}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Zurück zur Übersicht
        </Button>
        <div className="flex items-center gap-2">
          {onOpenSchedule && (
            <Button
              data-testid="pfix-dd-open-schedule"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={onOpenSchedule}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Im Dienstplan öffnen
            </Button>
          )}
          <Button
            data-testid="pfix-dd-detail-export"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={handleShiftExport}
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </Button>
        </div>
      </div>

      {/* Kopfbereich der Auswahl */}
      <div className="space-y-1" data-testid="pfix-dd-detail-header">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{detailTitleForSelection(sel)}</span>
          {sel.sublabel && <span className="text-xs text-muted-foreground">{sel.sublabel}</span>}
          <StatusPill size="xs" tone={parentRow.tone}>{TONE_STATUS_LABEL[parentRow.tone]}</StatusPill>
        </div>
        {mainCause && (
          <p className="text-xs text-muted-foreground" data-testid="pfix-dd-detail-cause">
            Hauptursache: {mainCause}
          </p>
        )}
      </div>

      {/* KPIs (≤4 Karten) + kompakte Kontextzeile */}
      <div data-testid="pfix-dd-detail-kpis">
        <KpiGrid>
          <KpiCard
            label="Ist-Stunden"
            value={fmtH(kpis.istH)}
            sub={`Plan ${fmtH(kpis.planH)} h`}
            tone={kpis.diffH > 0 ? 'warn' : 'good'}
          />
          <KpiCard
            label="Diff Stunden"
            value={`${signH(kpis.diffH)} h`}
            sub={`${kpis.shiftCount} Einsätze`}
            tone={kpis.diffH > 0 ? 'warn' : 'good'}
          />
          <KpiCard
            label="Ist-Kosten"
            value={fmtChfWhole(kpis.istCHF)}
            sub={`Plan ${fmtChfWhole(kpis.planCHF)}`}
            tone={kpis.diffCHF > 0 ? 'warn' : 'good'}
          />
          <KpiCard
            label="Diff Kosten"
            value={`${signChf(kpis.diffCHF)} CHF`}
            sub={`${kpis.issueCount} Auffälligkeit${kpis.issueCount === 1 ? '' : 'en'}`}
            tone={kpis.diffCHF > 0 ? (kpis.diffCHF > 200 ? 'critical' : 'warn') : 'good'}
          />
        </KpiGrid>
      </div>

      {/* Tageskontext — nur vorhandene Daten, nichts wird geschätzt */}
      <p className="text-xs text-muted-foreground" data-testid="pfix-dd-detail-context">
        {context.revenue !== null && <>Umsatz {fmtChfWhole(context.revenue)} · </>}
        Besetzung: {context.plannedStaff} MA geplant · {context.actualStaff} MA im Einsatz
        {multiDay && <> · {context.dates.length} Tage</>}
      </p>

      {/* Schichttabelle */}
      {shiftRows.length === 0 ? (
        <div data-testid="pfix-dd-detail-empty">
          <HintBox tone="info" title="Keine Schichtdaten">
            Für diese Auswahl liegen keine Plan- oder Ist-Einsätze vor.
          </HintBox>
        </div>
      ) : (
        <div className="max-h-[45vh] overflow-auto rounded-md border border-border">
          <table className={TABLE} data-testid="pfix-dd-detail-table">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                {multiDay && thSort('date', 'Tag', false)}
                {thSort('empName', 'Mitarbeitende', false)}
                {thSort('position', 'Position', false)}
                <th className={cn(TH, 'bg-muted')}>
                  <span className="inline-flex items-center gap-1">
                    Plan-Zeiten
                    <InfoTip side="top" text="Zeiten aus dem Dienstplan. „—“ = keine Zeiten hinterlegt — es wird nichts geschätzt." />
                  </span>
                </th>
                <th className={cn(TH, 'bg-muted')}>Ist-Zeiten</th>
                <th className={cn(TH, TH_NUM, 'bg-muted')}>
                  <span className="inline-flex items-center gap-1">
                    Pause h
                    <InfoTip side="top" text="Pausenabzug gemäss Plan (brutto − netto). Ist-Pausen werden nicht erfasst." />
                  </span>
                </th>
                {thSort('planH', 'Plan h')}
                {thSort('istH', 'Ist h')}
                {thSort('diffH', 'Diff h')}
                {thSort('planCHF', 'Plan CHF')}
                {thSort('istCHF', 'Ist CHF')}
                {thSort('diffCHF', 'Diff CHF')}
                <th className={cn(TH, 'bg-muted')}>Status</th>
              </tr>
            </thead>
            <tbody>
              {shiftRows.map(r => (
                <tr key={r.key} data-testid={`pfix-dd-shift-${r.key}`} className="border-t border-border/60">
                  {multiDay && <td className={cn(TD, 'whitespace-nowrap')}>{r.dateLabel}</td>}
                  <td className={TD}><span className="font-medium">{r.empName}</span></td>
                  <td className={cn(TD, 'text-xs text-muted-foreground')}>{r.position}</td>
                  <td className={cn(TD, 'whitespace-nowrap text-xs tabular-nums')}>{r.planTimes ?? '—'}</td>
                  <td className={cn(TD, 'whitespace-nowrap text-xs tabular-nums')}>{r.istTimes ?? '—'}</td>
                  <td className={cn(TD, TD_NUM)}>{r.pauseH !== null ? fmtH(r.pauseH) : '—'}</td>
                  <td className={cn(TD, TD_NUM)}>{fmtH(r.planH)}</td>
                  <td className={cn(TD, TD_NUM)}>{fmtH(r.istH)}</td>
                  <td className={cn(TD, TD_NUM, r.diffH !== 0 && TONE_TEXT[r.diffH > 0 ? 'warn' : 'good'])}>
                    {signH(r.diffH)}
                  </td>
                  <td className={cn(TD, TD_NUM)}>{chfNumber(r.planCHF)}</td>
                  <td className={cn(TD, TD_NUM)}>{chfNumber(r.istCHF)}</td>
                  <td className={cn(TD, TD_NUM, 'font-medium', TONE_TEXT[r.tone])}>{signChf(r.diffCHF)}</td>
                  <td className={TD}>
                    <span className="flex flex-wrap gap-1">
                      {r.causes.length === 0 && r.flags.length === 0 ? (
                        <span className="text-xs text-muted-foreground">Im Plan</span>
                      ) : (
                        <>
                          {r.causes.slice(0, 2).map(c => (
                            <StatusPill
                              key={c.cause}
                              size="xs"
                              tone={c.cause === 'ungeplant' || c.cause === 'fehlende_stempelung' ? 'critical' : 'warn'}
                            >
                              {DRILLDOWN_CAUSE_LABEL[c.cause]}
                            </StatusPill>
                          ))}
                          {r.flags.map(f => (
                            <StatusPill key={f} size="xs" tone="info">
                              {DRILLDOWN_SHIFT_FLAG_LABEL[f]}
                            </StatusPill>
                          ))}
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Abstimmung Detail ↔ angeklickte Zeile */}
      <div
        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
        data-testid="pfix-dd-detail-recon"
      >
        {recon.ok ? (
          <StatusPill size="xs" tone="good">Abgestimmt</StatusPill>
        ) : (
          <StatusPill size="xs" tone="warn">Abweichung zur Übersicht</StatusPill>
        )}
        <span className="text-muted-foreground">
          Summe Detail: {fmtH(recon.sumIstH)} h Ist ({fmtH(recon.sumPlanH)} h Plan) ·
          {' '}{signChf(recon.sumDiffCHF)} CHF — Zeile: {fmtH(recon.parentIstH)} h Ist ({fmtH(recon.parentPlanH)} h Plan) ·
          {' '}{signChf(recon.parentDiffCHF)} CHF
        </span>
        {!recon.ok && (
          <span className={TONE_TEXT.warn} data-testid="pfix-dd-detail-recon-warn">
            Differenz {signChf(recon.diffCHF)} CHF / {signH(recon.diffH)} h
          </span>
        )}
      </div>
    </div>
  );
}
