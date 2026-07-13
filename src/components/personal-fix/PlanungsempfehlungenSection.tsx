/**
 * Planungsempfehlungen (Personalcontrolling, Personal FIX).
 *
 * Reine ANZEIGE + lokale Simulation:
 *  - Empfehlungen kommen fertig berechnet aus der Seite
 *    (buildStaffingRecommendations — src/lib/staffing-recommendations.ts).
 *  - Kein Schreibpfad: weder Dienstplan noch Supabase werden verändert.
 *  - Die Simulation rechnet ausschliesslich lokal (applySimulation) und ist
 *    klar als „Simulation – noch nicht übernommen" gekennzeichnet.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, Lightbulb, RotateCcw } from 'lucide-react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { StatusPill } from '@/components/ui/status-pill';
import { HintBox } from '@/components/ui/hint-box';
import { InfoTip } from '@/components/ui/info-tip';
import { TONE_TEXT } from '@/components/ui/tones';
import { DIALOG_MD, DIALOG_LG } from '@/components/ui/dialog-size';
import { TABLE, TH, TH_NUM, TD, TD_NUM } from '@/components/ui/table-style';
import { cn } from '@/lib/utils';
import { SEASONS } from '@/lib/staffing-requirements-utils';
import type { StaffingSeason } from '@/types/staffing';
import {
  RECO_THRESHOLDS,
  MAX_VISIBLE_RECOMMENDATIONS,
  RECOMMENDATION_TYPE_LABEL,
  DATA_BASIS_LABEL,
  DEFAULT_SIMULATION_ADJUSTMENTS,
  filterRecommendations,
  visibleRecommendations,
  applySimulation,
  type StaffingRecoResult,
  type StaffingRecommendation,
  type RecommendationFilter,
  type RecommendationType,
  type SimulationAdjustments,
} from '@/lib/staffing-recommendations';

// ── Props ────────────────────────────────────────────────────────────────────

export interface PlanungsempfehlungenSectionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = noch nicht berechnet (Sektion zu / Daten laden). */
  result: StaffingRecoResult | null;
  loading: boolean;
  season: StaffingSeason;
  onSeasonChange: (season: StaffingSeason) => void;
  /** Gibt es überhaupt Personalbedarf-Definitionen (irgendeine Saison)? */
  hasRequirements: boolean;
  monthLabel: string;
  /** „Im Dienstplan öffnen" — Navigation, KEIN Schreibzugriff. */
  onOpenSchedule: () => void;
}

// ── Kleine Helfer (nur Anzeige) ──────────────────────────────────────────────

const fmtH = (n: number) =>
  n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtChf = (n: number) => `CHF ${Math.round(n).toLocaleString('de-CH')}`;
const fmtPct = (n: number) =>
  `${n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
const fmtDay = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;

const FILTER_ORDER: RecommendationFilter[] = [
  'alle', 'unterbesetzung', 'ueberbesetzung', 'schichtzeit', 'kosten', 'datenqualitaet',
];

function filterLabel(f: RecommendationFilter): string {
  return f === 'alle' ? 'Alle' : RECOMMENDATION_TYPE_LABEL[f as RecommendationType];
}

// ── Hauptsektion ─────────────────────────────────────────────────────────────

export function PlanungsempfehlungenSection({
  open,
  onOpenChange,
  result,
  loading,
  season,
  onSeasonChange,
  hasRequirements,
  monthLabel,
  onOpenSchedule,
}: PlanungsempfehlungenSectionProps) {
  const [filter, setFilter] = useState<RecommendationFilter>('alle');
  const [showAll, setShowAll] = useState(false);
  const [detailRec, setDetailRec] = useState<StaffingRecommendation | null>(null);
  const [simRec, setSimRec] = useState<StaffingRecommendation | null>(null);

  const filtered = useMemo(
    () => (result ? filterRecommendations(result.recommendations, filter) : []),
    [result, filter],
  );
  const visible = visibleRecommendations(filtered, showAll);
  const hiddenCount = filtered.length - visible.length;

  const countByType = useMemo(() => {
    const m = new Map<RecommendationFilter, number>();
    if (result) {
      m.set('alle', result.recommendations.length);
      for (const r of result.recommendations) m.set(r.type, (m.get(r.type) ?? 0) + 1);
    }
    return m;
  }, [result]);

  return (
    <section
      data-testid="reco-section"
      className="rounded-lg border border-border bg-muted/10"
    >
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-testid="reco-trigger"
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/30 transition-colors"
          >
            <Lightbulb className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Planungsempfehlungen
            </span>
            <InfoTip
              side="top"
              text={
                <span>
                  Regelbasierte Vorschläge aus den abgeschlossenen Tagen von {monthLabel}:
                  gleiche Wochentage und Positionen werden verglichen (mindestens{' '}
                  {RECO_THRESHOLDS.minComparableDays} Vergleichstage). Jede Empfehlung zeigt
                  ihre Datenbasis und Begründung — es wird nichts geschätzt und nichts
                  automatisch in den Dienstplan geschrieben.
                </span>
              }
            />
            {result && result.recommendations.length > 0 && (
              <StatusPill tone="info" size="xs">
                {result.recommendations.length}
              </StatusPill>
            )}
            <ChevronDown
              className={cn(
                'ml-auto h-4 w-4 text-muted-foreground transition-transform',
                open && 'rotate-180',
              )}
              aria-hidden
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-3 space-y-3">
            {/* Toolbar: Saison + Typ-Filter */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Saison</span>
                <Select value={season} onValueChange={(v) => onSeasonChange(v as StaffingSeason)}>
                  <SelectTrigger data-testid="reco-season" className="h-7 w-32 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SEASONS.filter((s) => s.available).map((s) => (
                      <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Empfehlungstyp filtern">
                {FILTER_ORDER.map((f) => {
                  const count = countByType.get(f) ?? 0;
                  return (
                    <button
                      key={f}
                      type="button"
                      data-testid={`reco-filter-${f}`}
                      onClick={() => { setFilter(f); setShowAll(false); }}
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-xs transition-colors',
                        filter === f
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-card text-muted-foreground hover:bg-muted/50',
                      )}
                    >
                      {filterLabel(f)}{f !== 'alle' && count > 0 ? ` (${count})` : ''}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Zustände */}
            {loading && (
              <p data-testid="reco-loading" className="text-sm text-muted-foreground py-2">
                Empfehlungen werden berechnet …
              </p>
            )}

            {!loading && result && !hasRequirements && (
              <HintBox tone="info">
                Es sind noch keine Personalbedarf-Definitionen (SOLL) hinterlegt — Besetzungs-
                Empfehlungen sind erst mit definiertem Bedarf möglich. Stunden- und
                Kostenmuster werden trotzdem ausgewertet.
              </HintBox>
            )}

            {!loading && result && !result.hasAnyData && (
              <p data-testid="reco-empty" className="text-sm text-muted-foreground py-2">
                Keine abgeschlossenen Tage mit Plan- oder Ist-Daten in {monthLabel} — keine
                Auswertung möglich.
              </p>
            )}

            {!loading && result && result.hasAnyData && filtered.length === 0 && (
              <p data-testid="reco-empty" className="text-sm text-muted-foreground py-2">
                {result.recommendations.length === 0
                  ? `Keine auffälligen Muster in ${monthLabel} — oder zu wenig Vergleichstage (mindestens ${RECO_THRESHOLDS.minComparableDays} gleiche Wochentage nötig${result.skippedGroups > 0 ? `; ${result.skippedGroups} Gruppe(n) übersprungen` : ''}).`
                  : 'Keine Empfehlungen für diesen Typ.'}
              </p>
            )}

            {/* Karten */}
            {!loading && visible.length > 0 && (
              <div className="grid gap-2 md:grid-cols-2">
                {visible.map((rec) => (
                  <RecoCard
                    key={rec.id}
                    rec={rec}
                    onDetail={() => setDetailRec(rec)}
                    onSimulate={() => setSimRec(rec)}
                  />
                ))}
              </div>
            )}

            {!loading && hiddenCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                data-testid="reco-show-all"
                onClick={() => setShowAll(true)}
              >
                Alle anzeigen ({hiddenCount} weitere)
              </Button>
            )}
            {!loading && showAll && filtered.length > MAX_VISIBLE_RECOMMENDATIONS && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="reco-show-less"
                onClick={() => setShowAll(false)}
              >
                Weniger anzeigen
              </Button>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <RecoDetailDialog rec={detailRec} onClose={() => setDetailRec(null)} />
      <RecoSimulationDialog
        rec={simRec}
        onClose={() => setSimRec(null)}
        onOpenSchedule={onOpenSchedule}
      />
    </section>
  );
}

// ── Empfehlungs-Karte ────────────────────────────────────────────────────────

function RecoCard({
  rec,
  onDetail,
  onSimulate,
}: {
  rec: StaffingRecommendation;
  onDetail: () => void;
  onSimulate: () => void;
}) {
  return (
    <div
      data-testid={`reco-card-${rec.id}`}
      className="rounded-lg border border-border bg-card p-3 space-y-1.5"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug">{rec.title}</p>
        <StatusPill tone={rec.tone} size="xs">
          {RECOMMENDATION_TYPE_LABEL[rec.type]}
        </StatusPill>
      </div>
      <p className="text-sm text-muted-foreground">{rec.action}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{rec.positionLabel}</span>
        {rec.timeWindow && <span>{rec.timeWindow.start}–{rec.timeWindow.end} Uhr</span>}
        <span>
          {rec.hitDayCount} / {rec.comparableDayCount} Tage
        </span>
        <StatusPill tone="neutral" size="xs" showDot={false}>
          {DATA_BASIS_LABEL[rec.dataBasis]}
        </StatusPill>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          data-testid={`reco-detail-btn-${rec.id}`}
          onClick={onDetail}
        >
          Details
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          data-testid={`reco-sim-btn-${rec.id}`}
          onClick={onSimulate}
        >
          Simulation
        </Button>
      </div>
    </div>
  );
}

// ── Detail-Dialog (Begründung + Vergleichstage) ──────────────────────────────

function RecoDetailDialog({
  rec,
  onClose,
}: {
  rec: StaffingRecommendation | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={rec != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_LG} data-testid="reco-detail-dialog" aria-describedby={undefined}>
        {rec && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                {rec.title}
                <StatusPill tone={rec.tone} size="xs">
                  {RECOMMENDATION_TYPE_LABEL[rec.type]}
                </StatusPill>
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p className="font-medium">{rec.action}</p>
              <p className="text-muted-foreground" data-testid="reco-detail-reasoning">
                {rec.reasoning}
              </p>
              {rec.expectedChange && (
                <p>
                  <span className="text-muted-foreground">Erwartete Veränderung: </span>
                  {rec.expectedChange}
                </p>
              )}
              {rec.keyMetrics.length > 0 && (
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  {rec.keyMetrics.map((m) => (
                    <div key={m.label} className="text-xs">
                      <span className="text-muted-foreground">{m.label}: </span>
                      <span className="font-medium tabular-nums">{m.value}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-lg border border-border overflow-hidden">
                <div className="max-h-[40vh] overflow-auto">
                  <table className={TABLE} data-testid="reco-detail-days">
                    <thead>
                      <tr className="bg-muted">
                        <th className={TH}>Tag</th>
                        <th className={cn(TH, TH_NUM)}>Plan h</th>
                        <th className={cn(TH, TH_NUM)}>Ist h</th>
                        <th className={cn(TH, TH_NUM)}>Plan Pers.</th>
                        <th className={cn(TH, TH_NUM)}>Ist Pers.</th>
                        <th className={cn(TH, TH_NUM)}>Soll</th>
                        <th className={cn(TH, TH_NUM)}>Umsatz</th>
                        <th className={cn(TH, TH_NUM)}>Reserv. Pers.</th>
                        <th className={TH}>Befund</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rec.comparableDays.map((d) => (
                        <tr key={d.date} className={cn(d.hit && 'bg-muted/30')}>
                          <td className={TD}>{fmtDay(d.date)}</td>
                          <td className={cn(TD, TD_NUM)}>{fmtH(d.planH)}</td>
                          <td className={cn(TD, TD_NUM)}>{fmtH(d.istH)}</td>
                          <td className={cn(TD, TD_NUM)}>{d.planPersons ?? '—'}</td>
                          <td className={cn(TD, TD_NUM)}>{d.istPersons ?? '—'}</td>
                          <td className={cn(TD, TD_NUM)}>{d.required ?? '—'}</td>
                          <td className={cn(TD, TD_NUM)}>{d.revenue != null ? fmtChf(d.revenue) : '—'}</td>
                          <td className={cn(TD, TD_NUM)}>{d.persons ?? '—'}</td>
                          <td className={TD}>
                            {d.hit ? (
                              <StatusPill tone={rec.tone} size="xs" showDot={false}>betroffen</StatusPill>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {rec.limitations.length > 0 && (
                <HintBox tone="info">
                  <ul className="list-disc pl-4 space-y-0.5" data-testid="reco-detail-limitations">
                    {rec.limitations.map((l) => <li key={l}>{l}</li>)}
                  </ul>
                </HintBox>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Simulations-Dialog (rein lokal, keine Übernahme) ─────────────────────────

function RecoSimulationDialog({
  rec,
  onClose,
  onOpenSchedule,
}: {
  rec: StaffingRecommendation | null;
  onClose: () => void;
  onOpenSchedule: () => void;
}) {
  const [adj, setAdj] = useState<SimulationAdjustments>(DEFAULT_SIMULATION_ADJUSTMENTS);
  const [recId, setRecId] = useState<string | null>(null);
  // Beim Wechsel der Empfehlung Anpassungen zurücksetzen (kein useEffect nötig).
  if (rec && rec.id !== recId) {
    setRecId(rec.id);
    setAdj(DEFAULT_SIMULATION_ADJUSTMENTS);
  }

  const sim = useMemo(
    () => (rec ? applySimulation(rec.simulationBase, adj) : null),
    [rec, adj],
  );

  const changed =
    adj.deltaPeople !== 0 || adj.deltaHours !== 0 || adj.startTime != null || adj.endTime != null;

  return (
    <Dialog open={rec != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_MD} data-testid="reco-sim-dialog" aria-describedby={undefined}>
        {rec && sim && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                Simulation: {rec.weekdayLabel}, {rec.positionLabel}
                <StatusPill tone="info" size="xs" showDot={false}>
                  Simulation – noch nicht übernommen
                </StatusPill>
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p className="text-xs text-muted-foreground">
                Basis: Ø-Werte der {rec.comparableDayCount} Vergleichstage ({rec.weekdayLabel}e,{' '}
                {rec.positionLabel}). Alle Änderungen bleiben lokal — der Dienstplan wird nicht
                verändert.
              </p>

              {/* Anpassungen */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Personen ±</span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline" size="sm" className="h-7 w-7 p-0"
                      data-testid="reco-sim-people-minus"
                      onClick={() => setAdj((a) => ({ ...a, deltaPeople: a.deltaPeople - 1 }))}
                    >
                      −
                    </Button>
                    <span className="w-10 text-center tabular-nums" data-testid="reco-sim-people-value">
                      {adj.deltaPeople > 0 ? `+${adj.deltaPeople}` : adj.deltaPeople}
                    </span>
                    <Button
                      variant="outline" size="sm" className="h-7 w-7 p-0"
                      data-testid="reco-sim-people-plus"
                      onClick={() => setAdj((a) => ({ ...a, deltaPeople: a.deltaPeople + 1 }))}
                    >
                      +
                    </Button>
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Stunden ± (pro Tag)</span>
                  <Input
                    type="number"
                    step="0.5"
                    className="h-7 text-sm"
                    data-testid="reco-sim-hours"
                    value={adj.deltaHours === 0 ? '' : String(adj.deltaHours)}
                    placeholder="0"
                    onChange={(e) => {
                      const v = e.target.value === '' ? 0 : Number(e.target.value);
                      setAdj((a) => ({ ...a, deltaHours: Number.isFinite(v) ? v : 0 }));
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">
                    Startzeit {rec.simulationBase.shiftStart ? `(Soll ${rec.simulationBase.shiftStart})` : ''}
                  </span>
                  <Input
                    type="time"
                    className="h-7 text-sm"
                    data-testid="reco-sim-start"
                    value={adj.startTime ?? rec.simulationBase.shiftStart ?? ''}
                    disabled={!rec.simulationBase.shiftStart}
                    onChange={(e) => setAdj((a) => ({ ...a, startTime: e.target.value || null }))}
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">
                    Endzeit {rec.simulationBase.shiftEnd ? `(Soll ${rec.simulationBase.shiftEnd})` : ''}
                  </span>
                  <Input
                    type="time"
                    className="h-7 text-sm"
                    data-testid="reco-sim-end"
                    value={adj.endTime ?? rec.simulationBase.shiftEnd ?? ''}
                    disabled={!rec.simulationBase.shiftEnd}
                    onChange={(e) => setAdj((a) => ({ ...a, endTime: e.target.value || null }))}
                  />
                </div>
              </div>

              {/* Ergebnis */}
              <div className="rounded-lg border border-border bg-muted/20 p-3">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th className="text-left font-normal pb-1">Kennzahl</th>
                      <th className="text-right font-normal pb-1">Basis</th>
                      <th className="text-right font-normal pb-1">Simulation</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    <tr data-testid="reco-sim-hours-row">
                      <td className="py-0.5">Planstunden / Tag</td>
                      <td className="text-right">{fmtH(sim.basePlanHours)} h</td>
                      <td className={cn('text-right font-medium', changed && TONE_TEXT[sim.deltaHours > 0 ? 'warn' : sim.deltaHours < 0 ? 'good' : 'neutral'])}>
                        {fmtH(sim.newPlanHours)} h
                      </td>
                    </tr>
                    <tr data-testid="reco-sim-cost-row">
                      <td className="py-0.5">Personalkosten / Tag</td>
                      <td className="text-right">{sim.baseCostCHF != null ? fmtChf(sim.baseCostCHF) : '—'}</td>
                      <td className="text-right font-medium">
                        {sim.newCostCHF != null ? fmtChf(sim.newCostCHF) : '—'}
                        {sim.deltaCostCHF != null && sim.deltaCostCHF !== 0 && (
                          <span className={cn('ml-1 text-xs', TONE_TEXT[sim.deltaCostCHF > 0 ? 'warn' : 'good'])}>
                            ({sim.deltaCostCHF > 0 ? '+' : '−'}{fmtChf(Math.abs(sim.deltaCostCHF)).replace('CHF ', '')})
                          </span>
                        )}
                      </td>
                    </tr>
                    <tr data-testid="reco-sim-pkq-row">
                      <td className="py-0.5">Personalkostenquote</td>
                      <td className="text-right">{sim.basePkqPct != null ? fmtPct(sim.basePkqPct) : '—'}</td>
                      <td className="text-right font-medium">{sim.newPkqPct != null ? fmtPct(sim.newPkqPct) : '—'}</td>
                    </tr>
                    <tr data-testid="reco-sim-staffing-row">
                      <td className="py-0.5">Besetzung vs. Soll</td>
                      <td className="text-right">
                        {rec.simulationBase.avgPlanHeadcount != null && rec.simulationBase.requiredPersons != null
                          ? `${fmtH(rec.simulationBase.avgPlanHeadcount)} / ${rec.simulationBase.requiredPersons}`
                          : '—'}
                      </td>
                      <td className="text-right font-medium">
                        {sim.staffingDiff != null ? (
                          <span className={TONE_TEXT[sim.staffingDiff < 0 ? 'critical' : sim.staffingDiff > 0 ? 'warn' : 'good']}>
                            {sim.staffingDiff > 0 ? `+${fmtH(sim.staffingDiff)}` : fmtH(sim.staffingDiff)} Pers.
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {sim.issues.length > 0 && (
                <HintBox tone="info">
                  <ul className="list-disc pl-4 space-y-0.5" data-testid="reco-sim-issues">
                    {sim.issues.map((i) => <li key={i}>{i}</li>)}
                  </ul>
                </HintBox>
              )}

              <div className="flex items-center justify-between gap-2 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="reco-sim-reset"
                  onClick={() => setAdj(DEFAULT_SIMULATION_ADJUSTMENTS)}
                  disabled={!changed}
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" aria-hidden />
                  Zurücksetzen
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="reco-sim-open-schedule"
                  onClick={onOpenSchedule}
                >
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" aria-hidden />
                  Im Dienstplan öffnen
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
