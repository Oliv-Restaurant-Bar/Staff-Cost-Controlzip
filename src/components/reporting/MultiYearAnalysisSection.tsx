/**
 * Mehrjahresanalyse (Banken-/Investorensicht) — Anzeige-Sektion der Erfolgsrechnung.
 *
 * Rein darstellend: ALLE Zahlen stammen aus buildMultiYearAnalysis()
 * (src/lib/multi-year-analysis.ts) — keine Zweitberechnungen in der UI.
 * Datenquelle: YearSeries[] aus PLView (roh loadYear → computePLForMonth).
 */
import { useMemo, useState } from 'react';
import { BarChart3, CalendarRange, FileDown, FileSpreadsheet, TrendingUp } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { KpiCard, KpiGrid, MoreKpis } from '@/components/ui/kpi-card';
import { HintBox } from '@/components/ui/hint-box';
import { InfoTip } from '@/components/ui/info-tip';
import { EmptyState } from '@/components/ui/page-states';
import { StatusPill } from '@/components/ui/status-pill';
import { DIALOG_LG } from '@/components/ui/dialog-size';
import { TONE_TEXT, type Tone } from '@/components/ui/tones';
import {
  TABLE, TABLE_SCROLL, TABLE_WRAP, TD, TD_NUM, TH, TH_NUM, TH_STICKY, ROW_CLICKABLE,
} from '@/components/ui/table-style';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis,
  CartesianGrid, Legend, Tooltip as RechartsTooltip,
} from 'recharts';
import { toast } from 'sonner';

import {
  buildMultiYearAnalysis, buildMonthDetail, buildPositionsOverview, nonEmptyYears, selectYears, seriesForPosition,
  yearsWithAnyData, buildYearKpiComparison, buildPersonnelInsights, buildComparisonDrilldown,
  fmtChf, fmtMio, fmtPct, fmtDeltaChf, fmtPpSigned, fmtQuotePct,
  MONTH_LABELS_LONG, MULTI_YEAR_POSITIONS, DEFAULT_POSITION,
  MIN_YEAR_SELECTION, MAX_YEAR_SELECTION,
  type DataQualityItem, type DataQualitySeverity,
  type GrowthTone, type MultiYearAnalysis, type YearSeries,
  type YearKpiComparison, type YearComparisonMode, type YearComparisonRowDef, type YearComparisonDelta,
} from '@/lib/multi-year-analysis';
import { EBIT_REPORT_NOTE } from '@/lib/bank-investor-analysis';

// ─── Hilfen (nur Darstellung) ─────────────────────────────────────────────────

const GROWTH_TONE: Record<GrowthTone, Tone> = {
  good: 'good',
  critical: 'critical',
  neutral: 'neutral',
};

const LINE_COLORS = ['#94a3b8', '#818cf8', '#0ea5e9', '#f59e0b', '#10b981'];
const TONE_FILL: Record<GrowthTone, string> = {
  good: '#10b981',
  critical: '#ef4444',
  neutral: '#94a3b8',
};

const TREND_LABEL: Record<string, string> = {
  steigend: 'Steigend',
  stabil: 'Stabil',
  ruecklaeufig: 'Rückläufig',
};
const TREND_TONE: Record<string, Tone> = {
  steigend: 'good',
  stabil: 'info',
  ruecklaeufig: 'critical',
};

function deltaCellText(chf: number | null, pct: number | null): string {
  if (chf == null) return '—';
  return `${fmtDeltaChf(chf)} (${fmtPct(pct)})`;
}

// Quoten-/pp-Formatierung: zentrale Helfer fmtQuotePct/fmtPpSigned (UI ≡ Export)

/**
 * Farb-Richtung einer Δ-Zelle (§11): Aufwand-CHF neutral, Quote-runter=grün
 * (Umsatzbezug ist in der Quote enthalten), fehlende Basis neutral.
 */
function cmpDeltaTone(def: YearComparisonRowDef, d: YearComparisonDelta): Tone {
  const v = def.kind === 'quote' ? d.pp : d.chf;
  if (v == null || v === 0 || def.betterWhen === 'neutral') return 'neutral';
  return (def.betterWhen === 'up') === v > 0 ? 'good' : 'critical';
}

function cmpDeltaText(def: YearComparisonRowDef, d: YearComparisonDelta): string {
  return def.kind === 'quote' ? fmtPpSigned(d.pp) : deltaCellText(d.chf, d.pct);
}

// ─── Sektion ──────────────────────────────────────────────────────────────────

export function MultiYearAnalysisSection({
  series,
  restaurantName,
  dataSourceHints,
}: {
  /** Alle verfügbaren Jahre (roh, aufsteigend oder unsortiert). */
  series: YearSeries[];
  /** Für Export-Dateinamen/Titel (z. B. "Oliv"). */
  restaurantName?: string;
  /** Zusätzliche seitenspezifische Hinweise zur Datenbasis (vor den Lib-Hinweisen). */
  dataSourceHints?: string[];
}) {
  const [positionId, setPositionId] = useState<string>(DEFAULT_POSITION.id);
  const [selectedYears, setSelectedYears] = useState<number[] | null>(null);
  const [detailMonthIdx, setDetailMonthIdx] = useState<number | null>(null);
  const [exporting, setExporting] = useState<'pdf' | 'excel' | null>(null);
  // Vergleichsmodus (§4 der Vorgabe): «bis gleicher Monat» (Default) oder Ganzjahr;
  // throughMonth = 1–12 bzw. null = automatisch (alle gemeinsamen Monate).
  const [cmpMode, setCmpMode] = useState<YearComparisonMode>('commonMonth');
  const [throughMonth, setThroughMonth] = useState<number | null>(null);

  const position = MULTI_YEAR_POSITIONS.find((p) => p.id === positionId) ?? DEFAULT_POSITION;
  const isExpense = position.semantics === 'expense';
  const isRevenue = position.semantics === 'revenue';

  const usable = useMemo(
    () => nonEmptyYears(seriesForPosition(series, position.id)),
    [series, position.id],
  );
  // Jahresauswahl-Basis: Jahre mit IRGENDWELCHEN Daten (Umsatz ODER Kosten-Zeilen) —
  // ein reines Kosten-Jahr (z. B. 2024 aus dem Jahres-Kontoblatt) bleibt wählbar.
  const availableYearsList = useMemo(() => yearsWithAnyData(series), [series]);

  // §6: Standard = aktuelles Jahr + Vorjahr + Basisjahr (die letzten 3 verfügbaren).
  // Explizite Auswahl wird mit den verfügbaren Jahren geschnitten; fällt sie
  // unter das Minimum, greift wieder der Standard.
  const effectiveYears = useMemo(() => {
    const fallback = availableYearsList.slice(-3);
    if (selectedYears == null) return fallback;
    const kept = selectedYears.filter((y) => availableYearsList.includes(y));
    return kept.length >= Math.min(MIN_YEAR_SELECTION, availableYearsList.length) ? kept : fallback;
  }, [selectedYears, availableYearsList]);

  const toggleYear = (y: number) => {
    const cur = new Set(effectiveYears);
    if (cur.has(y)) {
      if (cur.size <= MIN_YEAR_SELECTION) return;
      cur.delete(y);
    } else {
      if (cur.size >= MAX_YEAR_SELECTION) return;
      cur.add(y);
    }
    setSelectedYears([...cur].sort((a, b) => a - b));
    // Monats-Selector zurücksetzen: die gemeinsamen Monate der neuen Auswahl
    // können den alten Monat nicht mehr enthalten (sonst sichtbarer Fehler).
    setThroughMonth(null);
  };

  const analysis: MultiYearAnalysis = useMemo(
    () => buildMultiYearAnalysis(selectYears(usable, effectiveYears), { position }),
    [usable, effectiveYears, position],
  );
  const detail = useMemo(
    () => (detailMonthIdx == null ? null : buildMonthDetail(analysis, detailMonthIdx)),
    [analysis, detailMonthIdx],
  );

  // Jahresvergleich (§5–§8): rohe Serien mit byPosition — NICHT seriesForPosition,
  // sonst fehlen die übrigen Vergleichszeilen. Dasselbe cmp-Objekt geht an die
  // Exporte (UI ≡ Export, §10).
  const [cmpDrillRowId, setCmpDrillRowId] = useState<string | null>(null);
  const cmp: YearKpiComparison = useMemo(
    () => buildYearKpiComparison(series, effectiveYears, {
      mode: cmpMode,
      throughMonth: cmpMode === 'commonMonth' ? throughMonth : null,
    }),
    [series, effectiveYears, cmpMode, throughMonth],
  );
  // Anzeige-Wert des Monats-Selectors: gewählter Monat oder automatisch der
  // letzte gemeinsame Datenmonat (Index 0-basiert → Wert 1–12).
  const lastCommonMonth = cmp.availableCommonMonths.length > 0
    ? cmp.availableCommonMonths[cmp.availableCommonMonths.length - 1] + 1
    : null;
  const throughMonthValue = throughMonth ?? lastCommonMonth;
  // Die 4 Entwicklungsblöcke (§5 der Vorgabe) — NUR aus den cmp-Zeilen, keine Zweitberechnung.
  const devBlocks = useMemo(() => {
    const defs: { id: string; label: string }[] = [
      { id: 'net_revenue', label: 'Umsatzentwicklung' },
      { id: 'total_personnel', label: 'Personalkosten' },
      { id: 'personnel_quote', label: 'Personalquote' },
      { id: 'ebit', label: 'EBIT' },
    ];
    return defs.map(({ id, label }) => {
      const row = cmp.rows.find((r) => r.def.id === id) ?? null;
      const lastIdx = cmp.years.length - 1;
      const value = row?.valueByYear[lastIdx] ?? null;
      const delta = row && row.deltas.length > 0 ? row.deltas[row.deltas.length - 1] : null;
      return { id, label, row, value, delta };
    });
  }, [cmp]);
  const cmpInsights = useMemo(() => buildPersonnelInsights(cmp), [cmp]);
  const cmpDrill = useMemo(
    () => (cmpDrillRowId == null ? null : buildComparisonDrilldown(series, effectiveYears, cmpDrillRowId)),
    [series, effectiveYears, cmpDrillRowId],
  );
  const cmpDrillHasComponents = cmpDrill?.perYear.some((y) => y.components != null) ?? false;

  const { kpis, monthRows, totals, years, baseYear, chart, yearSummaries } = analysis;

  // §16: Datenqualität nach Schweregrad gruppiert (Fehler nie stillschweigend).
  const dqBySeverity = useMemo(() => {
    const g: Record<DataQualitySeverity, DataQualityItem[]> = { fehler: [], warnung: [], hinweis: [] };
    for (const item of analysis.dataQuality) g[item.severity].push(item);
    return g;
  }, [analysis.dataQuality]);

  const handleExportPDF = async () => {
    setExporting('pdf');
    try {
      const { exportManagementReportPDF } = await import('@/lib/management-report-pdf');
      exportManagementReportPDF(analysis, {
        restaurantName, dataSourceHints,
        yearComparison: cmp, personnelInsights: cmpInsights,
      });
      toast.success('Management-Report (PDF) erstellt');
    } catch (e) {
      console.error('Management-Report PDF fehlgeschlagen:', e);
      toast.error('PDF-Export fehlgeschlagen');
    } finally {
      setExporting(null);
    }
  };

  const handleExportExcel = async () => {
    setExporting('excel');
    try {
      const { exportMultiYearToExcel } = await import('@/lib/multi-year-excel');
      await exportMultiYearToExcel(analysis, {
        restaurantName,
        positionsOverview: buildPositionsOverview(series, effectiveYears),
        yearComparison: cmp,
        personnelInsights: cmpInsights,
      });
      toast.success('Mehrjahresanalyse (Excel) erstellt');
    } catch (e) {
      console.error('Mehrjahres-Excel fehlgeschlagen:', e);
      toast.error('Excel-Export fehlgeschlagen');
    } finally {
      setExporting(null);
    }
  };

  if (!analysis.hasAnyData) {
    return (
      <div className="rounded-lg border border-border bg-card" data-testid="mya-empty">
        <EmptyState
          icon={BarChart3}
          title="Keine Umsatzdaten für die Mehrjahresanalyse"
          description="Es sind noch keine Monatsumsätze im Reporting erfasst. Erfassen Sie Monatsdaten unter Reporting → Monatsdaten, danach erscheint hier der Mehrjahresvergleich."
        />
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="mya-section">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-bold">
          <TrendingUp className="h-4 w-4 text-indigo-600" />
          Mehrjahresanalyse
          <InfoTip text="Banken-/Investorensicht: eine ER-Position über mehrere Jahre. Datenquelle sind die im Reporting erfassten Monatswerte (gleiche Basis wie die Erfolgsrechnung). Teiljahre werden fair über gemeinsame Monate verglichen." />
        </h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            value={position.id}
            onValueChange={(v) => setPositionId(v)}
          >
            <SelectTrigger className="h-8 w-48 text-xs" data-testid="mya-position">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MULTI_YEAR_POSITIONS.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline" size="sm" className="h-8 gap-1 text-xs"
                data-testid="mya-years"
                title="Jahre für den Vergleich auswählen (min. 2, max. 5)"
              >
                <CalendarRange className="h-3.5 w-3.5" />
                {effectiveYears.length <= 3 ? effectiveYears.join(' · ') : `${effectiveYears.length} Jahre`}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-3" data-testid="mya-years-popover">
              <p className="mb-2 text-xs font-semibold">Jahre im Vergleich</p>
              <div className="space-y-1.5">
                {availableYearsList.map((y) => {
                  const checked = effectiveYears.includes(y);
                  const disabled =
                    (checked && effectiveYears.length <= MIN_YEAR_SELECTION) ||
                    (!checked && effectiveYears.length >= MAX_YEAR_SELECTION);
                  return (
                    <label
                      key={y}
                      className={cn('flex items-center gap-2 text-xs', disabled ? 'opacity-50' : 'cursor-pointer')}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={() => toggleYear(y)}
                        data-testid={`mya-year-checkbox-${y}`}
                      />
                      <span className="tabular-nums">{y}</span>
                    </label>
                  );
                })}
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                Min. {MIN_YEAR_SELECTION}, max. {MAX_YEAR_SELECTION} Jahre. Das älteste gewählte Jahr ist das Basisjahr.
              </p>
            </PopoverContent>
          </Popover>
          <Button
            variant="outline" size="sm" className="h-8 gap-1 text-xs"
            onClick={handleExportPDF} disabled={exporting !== null}
            data-testid="mya-export-pdf"
            title="Management-Report als PDF (Executive Summary, KPIs, Jahresvergleich)"
          >
            <FileDown className="h-3.5 w-3.5" />
            {exporting === 'pdf' ? 'Erstelle…' : 'Report (PDF)'}
          </Button>
          <Button
            variant="outline" size="sm" className="h-8 gap-1 text-xs"
            onClick={handleExportExcel} disabled={exporting !== null}
            data-testid="mya-export-excel"
            title="Mehrjahresanalyse als Excel-Arbeitsmappe (5 Blätter)"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            {exporting === 'excel' ? 'Erstelle…' : 'Excel'}
          </Button>
        </div>
      </div>

      {/* Datenqualität (§16) — nach Schweregrad, Fehler nie stillschweigend */}
      {((dataSourceHints?.length ?? 0) > 0 || analysis.dataQuality.length > 0) && (
        <div className="space-y-2" data-testid="mya-limitations">
          {dqBySeverity.fehler.length > 0 && (
            <div data-testid="mya-dq-fehler">
              <HintBox tone="critical" title="Datenqualität — Fehler">
                <ul className="list-disc space-y-0.5 pl-4">
                  {dqBySeverity.fehler.map((d, i) => <li key={i}>{d.text}</li>)}
                </ul>
              </HintBox>
            </div>
          )}
          {dqBySeverity.warnung.length > 0 && (
            <div data-testid="mya-dq-warnung">
              <HintBox tone="warn" title="Datenqualität — Warnungen">
                <ul className="list-disc space-y-0.5 pl-4">
                  {dqBySeverity.warnung.map((d, i) => <li key={i}>{d.text}</li>)}
                </ul>
              </HintBox>
            </div>
          )}
          {((dataSourceHints?.length ?? 0) > 0 || dqBySeverity.hinweis.length > 0) && (
            <div data-testid="mya-dq-hinweis">
              <HintBox tone="info" title="Hinweise zur Datenbasis">
                <ul className="list-disc space-y-0.5 pl-4">
                  {(dataSourceHints ?? []).map((l, i) => <li key={`h-${i}`}>{l}</li>)}
                  {dqBySeverity.hinweis.map((d, i) => <li key={i}>{d.text}</li>)}
                </ul>
              </HintBox>
            </div>
          )}
        </div>
      )}

      {/* Vergleichsmodus (§4 der Vorgabe): Ganzjahr vs. «bis gleicher Monat» + Monatsselector */}
      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-card px-4 py-2.5"
        data-testid="mya-cmp-mode"
      >
        <span className="text-xs font-semibold">Vergleichsmodus</span>
        <RadioGroup
          value={cmpMode}
          onValueChange={(v) => setCmpMode(v as YearComparisonMode)}
          className="flex flex-wrap items-center gap-x-5 gap-y-1.5"
        >
          <label className="flex cursor-pointer items-center gap-1.5 text-xs">
            <RadioGroupItem value="commonMonth" data-testid="mya-mode-common" />
            Vergleich bis gleicher Monat
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs">
            <RadioGroupItem value="fullYear" data-testid="mya-mode-fullyear" />
            Ganzes Jahr
          </label>
        </RadioGroup>
        {cmpMode === 'commonMonth' && cmp.availableCommonMonths.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Vergleich bis:</span>
            <Select
              value={throughMonthValue != null ? String(throughMonthValue) : undefined}
              onValueChange={(v) => setThroughMonth(Number(v))}
            >
              <SelectTrigger className="h-7 w-32 text-xs" data-testid="mya-through-month">
                <SelectValue placeholder="Monat" />
              </SelectTrigger>
              <SelectContent>
                {cmp.availableCommonMonths.map((mIdx) => (
                  <SelectItem key={mIdx} value={String(mIdx + 1)}>
                    {MONTH_LABELS_LONG[mIdx]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <InfoTip text="Alle Kennzahlen des Jahresvergleichs werden je Jahr über Januar bis zum gewählten Monat summiert — nur Monate mit Daten in allen gewählten Jahren sind wählbar. Keine Hochrechnung." />
          </div>
        )}
        {cmpMode === 'fullYear' && !cmp.isFullYears && (
          <InfoTip text="Ganzjahresmodus: je Jahr die Summe der vorhandenen Datenmonate. Teiljahre sind markiert und nur eingeschränkt direkt vergleichbar — keine Hochrechnung." />
        )}
      </div>

      {/* Jahresvergleich (§5–§7): Kennzahlen × Jahre + Δ je Jahrespaar — endet bei EBIT */}
      {cmp.hasAnyData ? (
        <div className={TABLE_WRAP} data-testid="mya-cmp">
          <div className="flex flex-wrap items-center gap-2 bg-slate-900 px-4 py-3 text-white">
            <div>
              <h3 className="text-sm font-bold">Jahresvergleich {cmp.years.join(' · ')}</h3>
              <p className="mt-0.5 text-[11px] text-slate-400">
                Umsatz-, Kosten- und Ergebnisentwicklung über alle gewählten Jahre.
                Klick auf eine CHF-Zeile zeigt die Zusammensetzung nach Monat.
              </p>
            </div>
            {cmp.mode === 'fullYear' ? (
              <div className="ml-auto" data-testid="mya-cmp-mode-pill">
                <StatusPill tone="info" size="xs" showDot={false}>
                  Ganzes Jahr{cmp.partialYears.length > 0 ? ' (Teiljahre markiert)' : ''}
                </StatusPill>
              </div>
            ) : cmp.commonMonthsLabel && (
              <div className="ml-auto" data-testid="mya-cmp-partial-pill">
                <StatusPill tone="info" size="xs" showDot={false}>
                  Vergleich bis gleicher Monat: {cmp.commonMonthsLabel}
                </StatusPill>
              </div>
            )}
          </div>
          <div className={TABLE_SCROLL}>
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={cn(TH, TH_STICKY, 'left-0 z-20 sticky bg-muted')}>Kennzahl</th>
                  {cmp.years.map((y) => (
                    <th key={y} className={cn(TH, TH_NUM, TH_STICKY)}>
                      {y}{cmp.partialYears.includes(y) ? ' *' : ''}
                    </th>
                  ))}
                  {cmp.years.slice(1).map((y, i) => (
                    <th key={`d-${y}`} className={cn(TH, TH_NUM, TH_STICKY)}>Δ {y} vs. {cmp.years[i]}</th>
                  ))}
                  {cmp.years.length >= 3 && (
                    <th className={cn(TH, TH_NUM, TH_STICKY)}>
                      Δ {cmp.years[cmp.years.length - 1]} vs. {cmp.years[0]}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {cmp.rows.map((r) => {
                  const clickable = r.def.kind === 'chf';
                  return (
                    <tr
                      key={r.def.id}
                      className={clickable ? ROW_CLICKABLE : undefined}
                      onClick={clickable ? () => setCmpDrillRowId(r.def.id) : undefined}
                      data-testid={`mya-cmp-row-${r.def.id}`}
                    >
                      <td className={cn(TD, 'sticky left-0 z-[5] bg-card font-medium')}>{r.def.label}</td>
                      {r.valueByYear.map((v, i) => (
                        <td key={cmp.years[i]} className={cn(TD, TD_NUM)}>
                          {r.def.kind === 'quote' ? fmtQuotePct(v) : fmtChf(v)}
                        </td>
                      ))}
                      {r.deltas.map((d) => (
                        <td
                          key={`${d.fromYear}-${d.toYear}`}
                          className={cn(TD, TD_NUM, 'text-xs', TONE_TEXT[cmpDeltaTone(r.def, d)])}
                        >
                          {cmpDeltaText(r.def, d)}
                        </td>
                      ))}
                      {cmp.years.length >= 3 && (
                        <td className={cn(TD, TD_NUM, 'text-xs',
                          r.firstToLast ? TONE_TEXT[cmpDeltaTone(r.def, r.firstToLast)] : 'text-muted-foreground')}>
                          {r.firstToLast ? cmpDeltaText(r.def, r.firstToLast) : '—'}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground" data-testid="mya-cmp-dq">
              <ul className="list-disc space-y-0.5 pl-4">
                {cmp.partialNote && <li>{cmp.partialNote}</li>}
                <li>{EBIT_REPORT_NOTE}</li>
                {cmp.dataQuality.map((d, i) => (
                  <li key={i} className={d.severity === 'fehler' ? TONE_TEXT.critical : d.severity === 'warnung' ? TONE_TEXT.warn : undefined}>
                    {d.text}
                  </li>
                ))}
              </ul>
          </div>
        </div>
      ) : cmp.dataQuality.length > 0 && (
        <div data-testid="mya-cmp-empty">
          <HintBox tone="critical" title="Jahresvergleich nicht möglich">
            <ul className="list-disc space-y-0.5 pl-4">
              {cmp.dataQuality.map((d, i) => <li key={i}>{d.text}</li>)}
            </ul>
          </HintBox>
        </div>
      )}

      {/* Die 4 Entwicklungsblöcke (§5 der Vorgabe): Umsatz, Personalkosten, Personalquote, EBIT —
          Werte 1:1 aus den Jahresvergleichs-Zeilen (cmp), keine Zweitberechnung */}
      {cmp.hasAnyData && cmp.years.length >= 2 && (
        <div data-testid="mya-dev-blocks">
          <KpiGrid>
            {devBlocks.map(({ id, label, row, value, delta }) => {
              const latestYear = cmp.years[cmp.years.length - 1];
              const isQuote = row?.def.kind === 'quote';
              const deltaMetric = delta == null ? null : isQuote ? delta.pp : delta.chf;
              return (
                <KpiCard
                  key={id}
                  data-testid={`mya-dev-${id}`}
                  label={`${label} ${latestYear}${cmp.partialYears.includes(latestYear) ? ' *' : ''}`}
                  value={row == null ? '—' : isQuote ? fmtQuotePct(value) : fmtChf(value)}
                  sub={delta ? `vs. ${delta.fromYear}` : 'Kein Vorjahresvergleich möglich'}
                  tone={row && delta ? cmpDeltaTone(row.def, delta) : 'neutral'}
                  trend={row && delta && deltaMetric != null ? {
                    direction: deltaMetric > 0 ? 'up' : deltaMetric < 0 ? 'down' : 'flat',
                    tone: cmpDeltaTone(row.def, delta),
                    label: cmpDeltaText(row.def, delta),
                  } : undefined}
                />
              );
            })}
          </KpiGrid>
        </div>
      )}

      {/* Personalkosten-Entwicklung (§7) — regelbasierte Aussagen, keine Schätzungen */}
      {cmp.hasAnyData && cmpInsights.length > 0 && (
        <div data-testid="mya-cmp-insights">
          <HintBox tone="info" title="Personalkosten-Entwicklung">
            <ul className="list-disc space-y-0.5 pl-4">
              {cmpInsights.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          </HintBox>
        </div>
      )}

      {/* Umsatztabelle */}
      <div className={TABLE_WRAP} data-testid="mya-table">
        <div className="flex items-center justify-between bg-slate-900 px-4 py-3 text-white">
          <div>
            <h3 className="text-sm font-bold">{position.label} im Mehrjahresvergleich</h3>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {years.join(' · ')} — Klick auf einen Monat öffnet den Detailvergleich.
              Δ VJ = Veränderung zum Vorjahr, Δ {baseYear ?? 'Basis'} = Veränderung zum Basisjahr.
            </p>
          </div>
        </div>
        <div className={TABLE_SCROLL}>
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={cn(TH, TH_STICKY, 'left-0 z-20 sticky bg-muted')}>Monat</th>
                {years.map((y) => (
                  <th key={y} className={cn(TH, TH_NUM, TH_STICKY)} colSpan={y === baseYear ? 1 : 3}>
                    {y}
                  </th>
                ))}
              </tr>
              <tr>
                <th className={cn(TH, TH_STICKY, 'left-0 z-20 sticky bg-muted top-[33px]')} />
                {years.map((y) => (
                  y === baseYear ? (
                    <th key={y} className={cn(TH, TH_NUM, TH_STICKY, 'top-[33px]')}>{isRevenue ? 'Umsatz' : 'Wert'}</th>
                  ) : (
                    <th key={y} colSpan={3} className={cn(TH, TH_STICKY, 'top-[33px] p-0')}>
                      <div className="grid grid-cols-3">
                        <span className={cn(TH, TH_NUM, 'px-3')}>{isRevenue ? 'Umsatz' : 'Wert'}</span>
                        <span className={cn(TH, TH_NUM, 'px-3')}>Δ VJ</span>
                        <span className={cn(TH, TH_NUM, 'px-3')}>Δ {baseYear}</span>
                      </div>
                    </th>
                  )
                ))}
              </tr>
            </thead>
            <tbody>
              {monthRows.map((row) => (
                <tr
                  key={row.monthIdx}
                  className={ROW_CLICKABLE}
                  onClick={() => setDetailMonthIdx(row.monthIdx)}
                  data-testid={`mya-row-${row.monthIdx}`}
                >
                  <td className={cn(TD, 'sticky left-0 z-[5] bg-card font-medium')}>{row.label}</td>
                  {row.cells.map((cell) => (
                    cell.year === baseYear ? (
                      <td key={cell.year} className={cn(TD, TD_NUM)}>{fmtChf(cell.value)}</td>
                    ) : (
                      <td key={cell.year} colSpan={3} className="p-0 align-middle border-b border-border/50">
                        <div className="grid grid-cols-3">
                          <span className={cn('px-3 py-1.5', TD_NUM)}>{fmtChf(cell.value)}</span>
                          <span className={cn('px-3 py-1.5 text-xs', TD_NUM, TONE_TEXT[GROWTH_TONE[cell.tone]])}>
                            {fmtPct(cell.vsPrevYear.pct)}
                          </span>
                          <span className={cn('px-3 py-1.5 text-xs text-muted-foreground', TD_NUM)}>
                            {fmtPct(cell.vsBaseYear.pct)}
                          </span>
                        </div>
                      </td>
                    )
                  ))}
                </tr>
              ))}
              {/* Jahressummen */}
              <tr className="border-t-2 border-border bg-muted/60 font-semibold" data-testid="mya-totals-row">
                <td className={cn(TD, 'sticky left-0 z-[5] bg-muted')}>
                  Total
                </td>
                {totals.map((t) => (
                  t.year === baseYear ? (
                    <td key={t.year} className={cn(TD, TD_NUM)}>
                      {fmtChf(t.total)}
                      {t.isPartial && t.partialLabel && (
                        <span className="ml-1 font-normal text-[10px] text-muted-foreground">({t.partialLabel})</span>
                      )}
                    </td>
                  ) : (
                    <td key={t.year} colSpan={3} className="p-0 align-middle">
                      <div className="grid grid-cols-3">
                        <span className={cn('px-3 py-1.5', TD_NUM)}>
                          {fmtChf(t.total)}
                          {t.isPartial && t.partialLabel && (
                            <span className="ml-1 font-normal text-[10px] text-muted-foreground">({t.partialLabel})</span>
                          )}
                        </span>
                        <span className={cn('px-3 py-1.5 text-xs', TD_NUM,
                          t.vsPrevYearCommon.pct == null ? 'text-muted-foreground'
                            : t.vsPrevYearCommon.pct >= 0 ? TONE_TEXT.good : TONE_TEXT.critical)}>
                          {fmtPct(t.vsPrevYearCommon.pct)}
                          {t.vsPrevYearCommon.commonMonths > 0 && t.vsPrevYearCommon.commonMonths < 12 && (
                            <span className="ml-0.5 text-[10px] text-muted-foreground">({t.vsPrevYearCommon.commonMonths} Mte.)</span>
                          )}
                        </span>
                        <span className={cn('px-3 py-1.5 text-xs text-muted-foreground', TD_NUM)}>
                          {fmtPct(t.vsBaseYearCommon.pct)}
                        </span>
                      </div>
                    </td>
                  )
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Executive Summary */}
      {analysis.executiveSummary.length > 0 && (
        <div data-testid="mya-summary">
          <HintBox tone="neutral" title="Executive Summary">
            <ul className="list-disc space-y-0.5 pl-4">
              {analysis.executiveSummary.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </HintBox>
        </div>
      )}

      {/* KPI-Karten (max. 4 sichtbar) */}
      <KpiGrid>
        <KpiCard
          data-testid="mya-kpi-revenue"
          label={`${position.label} ${kpis.latestYear ?? '—'}${kpis.latestYearPartialLabel ? ` (${kpis.latestYearPartialLabel})` : ''}`}
          value={fmtChf(kpis.latestYearValue)}
          sub={kpis.latestYearValue != null ? fmtMio(kpis.latestYearValue) : undefined}
          tone="info"
        />
        <KpiCard
          data-testid="mya-kpi-growth"
          label={`Veränderung vs. ${kpis.prevYear ?? 'Vorjahr'}${kpis.growthCommonMonths > 0 && kpis.growthCommonMonths < 12 ? ` (${kpis.growthCommonMonths} Mte.)` : ''}`}
          value={fmtPct(kpis.growthPct)}
          tone={kpis.growthPct == null || isExpense ? 'neutral' : kpis.growthPct >= 0 ? 'good' : 'critical'}
          trend={kpis.growthChf != null ? {
            direction: kpis.growthChf > 0 ? 'up' : kpis.growthChf < 0 ? 'down' : 'flat',
            tone: isExpense ? 'neutral' : kpis.growthChf >= 0 ? 'good' : 'critical',
            label: `${fmtDeltaChf(kpis.growthChf)} CHF`,
          } : undefined}
        />
        <KpiCard
          data-testid="mya-kpi-cagr"
          label={kpis.cagrFromYear != null ? `CAGR ${kpis.cagrFromYear}–${kpis.cagrToYear}` : 'CAGR'}
          value={fmtPct(kpis.cagrPct)}
          sub={kpis.cagrPct == null ? 'Braucht ≥2 vollständige Jahre' : 'Ø Veränderung p. a. (volle Jahre)'}
          tone={kpis.cagrPct == null || isExpense ? 'neutral' : kpis.cagrPct >= 0 ? 'good' : 'critical'}
        />
        <KpiCard
          data-testid="mya-kpi-trend"
          label={isRevenue ? 'Umsatztrend' : `Trend ${position.label}`}
          value={kpis.trend ? TREND_LABEL[kpis.trend] : '—'}
          sub="Basis: Veränderung letztes vs. Vorjahr"
          tone={kpis.trend == null || isExpense ? 'neutral' : TREND_TONE[kpis.trend]}
        />
      </KpiGrid>
      <div data-testid="mya-kpi-more">
      <MoreKpis storageKey="mya-more-kpis">
        <KpiGrid>
          <KpiCard
            label="Ø monatliche Veränderung"
            value={fmtPct(kpis.avgMonthlyGrowthPct)}
            sub="Ø der monatlichen VJ-Veränderungen"
            tone={kpis.avgMonthlyGrowthPct == null || isExpense ? 'neutral' : kpis.avgMonthlyGrowthPct >= 0 ? 'good' : 'critical'}
          />
          <KpiCard
            label={`${isExpense ? 'Höchster Monat' : 'Bester Monat'} ${kpis.latestYear ?? ''}`}
            value={kpis.bestMonth ? kpis.bestMonth.label : '—'}
            sub={kpis.bestMonth ? fmtChf(kpis.bestMonth.value) : undefined}
            tone={isExpense ? 'neutral' : 'good'}
          />
          <KpiCard
            label={`${isExpense ? 'Tiefster Monat' : 'Schwächster Monat'} ${kpis.latestYear ?? ''}`}
            value={kpis.worstMonth ? kpis.worstMonth.label : '—'}
            sub={kpis.worstMonth ? fmtChf(kpis.worstMonth.value) : undefined}
            tone={isExpense ? 'neutral' : 'warn'}
          />
          <KpiCard
            label={isExpense ? 'Höchster Jahreswert' : 'Bestes Jahresergebnis'}
            value={kpis.highestAnnual ? String(kpis.highestAnnual.year) : '—'}
            sub={kpis.highestAnnual ? `${fmtChf(kpis.highestAnnual.total)}${kpis.highestAnnual.isPartial ? ' (Teiljahr)' : ''}` : undefined}
            tone="info"
          />
        </KpiGrid>
      </MoreKpis>
      </div>

      {/* Diagramme */}
      <div className="grid gap-4 xl:grid-cols-2">
        {/* Monatsverlauf (Linien) */}
        <div className="rounded-lg border border-border bg-card p-4" data-testid="mya-chart-line">
          <h3 className="mb-2 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
            {isRevenue ? 'Monatsumsätze im Jahresvergleich' : `${position.label} pro Monat im Jahresvergleich`}
            <InfoTip text={`${position.label} pro Monat, eine Linie pro Jahr. Lücken = Monate ohne erfasste Daten.`} />
          </h3>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chart.line} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} width={44} />
              <RechartsTooltip formatter={(v: number) => [`CHF ${fmtChf(v)}`, undefined]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {chart.lineYearKeys.map((k, i) => (
                <Line
                  key={k.key} type="monotone" dataKey={k.key} name={String(k.year)}
                  stroke={LINE_COLORS[i % LINE_COLORS.length]}
                  strokeWidth={k.year === kpis.latestYear ? 2.5 : 1.5}
                  dot={{ r: 2 }} connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Jahresumsätze (Balken) */}
        <div className="rounded-lg border border-border bg-card p-4" data-testid="mya-chart-bars">
          <h3 className="mb-2 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
            {isRevenue ? 'Jahresumsätze' : `${position.label} pro Jahr`}
            <InfoTip text={`${position.label} pro Jahr (Summe der erfassten Monate). Teiljahre sind entsprechend markiert.`} />
          </h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chart.bars} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="year" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => fmtMio(v)} width={64} />
              <RechartsTooltip formatter={(v: number) => [`CHF ${fmtChf(v)}`, position.label]} />
              <Bar dataKey="total" name={position.label} radius={[4, 4, 0, 0]}>
                {chart.bars.map((b, i) => (
                  <Cell key={b.year} fill={b.year === kpis.latestYear ? '#4f46e5' : '#a5b4fc'} opacity={b.isPartial ? 0.65 : 1} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Jahres-Zusammenfassungen */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="mya-year-cards">
        {yearSummaries.map((ys) => (
          <div key={ys.year} className="rounded-lg border border-border bg-card p-3" data-testid={`mya-year-card-${ys.year}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-bold">{ys.year}</p>
              <div className="flex items-center gap-1.5">
                {ys.isPartial && ys.partialLabel && (
                  <StatusPill tone="info" size="xs" showDot={false}>Teiljahr: {ys.partialLabel}</StatusPill>
                )}
                {ys.growthPct != null && (
                  <StatusPill tone={isExpense ? 'neutral' : ys.growthPct >= 0 ? 'good' : 'critical'} size="xs">
                    {fmtPct(ys.growthPct)} vs. VJ
                  </StatusPill>
                )}
              </div>
            </div>
            <p className="mt-1 text-lg font-bold tabular-nums">{fmtChf(ys.total)}</p>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
              <div>
                <p className="font-semibold text-muted-foreground">Top-Monate</p>
                {ys.bestMonths.length === 0 && <p className="text-muted-foreground/60">—</p>}
                {ys.bestMonths.map((m) => (
                  <p key={m.monthIdx} className="flex justify-between gap-2">
                    <span>{m.label}</span>
                    <span className="tabular-nums">{fmtChf(m.value)}</span>
                  </p>
                ))}
              </div>
              <div>
                <p className="font-semibold text-muted-foreground">Schwächste Monate</p>
                {ys.worstMonths.length === 0 && <p className="text-muted-foreground/60">—</p>}
                {ys.worstMonths.map((m) => (
                  <p key={m.monthIdx} className="flex justify-between gap-2">
                    <span>{m.label}</span>
                    <span className="tabular-nums">{fmtChf(m.value)}</span>
                  </p>
                ))}
              </div>
            </div>
            <div className="mt-2 flex gap-1">
              {ys.quarters.map((q) => (
                <div key={q.label} className="flex-1 rounded bg-muted/60 px-1.5 py-1 text-center">
                  <p className="text-[10px] font-semibold text-muted-foreground">{q.label}</p>
                  <p className="text-[10px] tabular-nums">{q.sharePct != null ? `${q.sharePct.toFixed(0)} %` : '—'}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Wachstums-Wasserfall */}
      {chart.waterfall.length > 0 && chart.waterfallYears && (
        <div className="rounded-lg border border-border bg-card p-4" data-testid="mya-chart-waterfall">
          <h3 className="mb-2 flex items-center gap-1 text-xs font-semibold text-muted-foreground">
            {isRevenue ? 'Wachstums-Wasserfall' : 'Veränderungs-Wasserfall'} {chart.waterfallYears.from} → {chart.waterfallYears.to}
            <InfoTip text={isExpense
              ? `Monatliche Veränderung von «${position.label}» zum Vorjahr, kumuliert (neutral dargestellt — mehr Aufwand ist nicht automatisch gut oder schlecht). Der letzte Balken zeigt die Gesamtveränderung. Nur Monate mit Werten in beiden Jahren.`
              : 'Monatliche Veränderung zum Vorjahr, kumuliert. Grün = Zuwachs, Rot = Rückgang; der letzte Balken zeigt die Gesamtveränderung. Nur Monate mit Werten in beiden Jahren.'} />
          </h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chart.waterfall} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} width={44} />
              <RechartsTooltip
                formatter={(v: number, name: string) => (name === 'Sockel' ? [null, null] : [`CHF ${fmtDeltaChf(v)}`, `Δ ${position.label}`])}
                labelFormatter={(label: string) => {
                  const entry = chart.waterfall.find((w) => w.label === label);
                  return entry ? `${label} — Δ ${fmtDeltaChf(entry.delta)} (kumuliert ${fmtDeltaChf(entry.cumEnd)})` : label;
                }}
              />
              <Bar dataKey="base" name="Sockel" stackId="wf" fill="transparent" isAnimationActive={false} />
              <Bar dataKey="height" name={`Δ ${position.label}`} stackId="wf" radius={[2, 2, 0, 0]}>
                {chart.waterfall.map((w) => (
                  <Cell key={w.label} fill={w.isTotal ? '#4f46e5' : TONE_FILL[w.tone]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Monats-Detail-Dialog */}
      <Dialog open={detail != null} onOpenChange={(open) => { if (!open) setDetailMonthIdx(null); }}>
        <DialogContent className={DIALOG_LG} data-testid="mya-month-dialog">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>{detail.label} im Mehrjahresvergleich</DialogTitle>
                <DialogDescription>
                  {position.label}, Veränderungen und Quoten je Jahr.
                  Ø über {detail.yearsWithValue} Jahr{detail.yearsWithValue === 1 ? '' : 'e'} mit Daten: {fmtChf(detail.avgValue)} CHF.
                </DialogDescription>
              </DialogHeader>
              <div className="overflow-x-auto">
                <table className={TABLE}>
                  <thead>
                    <tr>
                      <th className={TH}>Jahr</th>
                      <th className={cn(TH, TH_NUM)}>{position.label} (CHF)</th>
                      <th className={cn(TH, TH_NUM)}>Δ Vorjahr</th>
                      <th className={cn(TH, TH_NUM)}>Δ Basisjahr {baseYear}</th>
                      <th className={cn(TH, TH_NUM)}>Rang im Jahr</th>
                      <th className={cn(TH, TH_NUM)}>Anteil Jahr</th>
                      <th className={cn(TH, TH_NUM)}>
                        <span className="inline-flex items-center gap-1">Personalquote
                          <InfoTip text="Personalaufwand (Total Arbeitgeberkosten) in % vom Nettoumsatz — aus der Erfolgsrechnung desselben Monats." />
                        </span>
                      </th>
                      <th className={cn(TH, TH_NUM)}>
                        <span className="inline-flex items-center gap-1">WES-Quote
                          <InfoTip text="Warenaufwand in % vom Nettoumsatz — aus der Erfolgsrechnung desselben Monats." />
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.perYear.map((cell) => (
                      <tr key={cell.year} data-testid={`mya-month-dialog-row-${cell.year}`}>
                        <td className={cn(TD, 'font-medium')}>{cell.year}</td>
                        <td className={cn(TD, TD_NUM)}>{fmtChf(cell.value)}</td>
                        <td className={cn(TD, TD_NUM, 'text-xs', TONE_TEXT[GROWTH_TONE[cell.tone]])}>
                          {deltaCellText(cell.vsPrevYear.chf, cell.vsPrevYear.pct)}
                        </td>
                        <td className={cn(TD, TD_NUM, 'text-xs text-muted-foreground')}>
                          {deltaCellText(cell.vsBaseYear.chf, cell.vsBaseYear.pct)}
                        </td>
                        <td className={cn(TD, TD_NUM)}>{cell.rankInYear != null ? `${cell.rankInYear}.` : '—'}</td>
                        <td className={cn(TD, TD_NUM)}>{cell.shareOfYearPct != null ? `${cell.shareOfYearPct.toFixed(1)} %` : '—'}</td>
                        <td className={cn(TD, TD_NUM)}>{cell.personnelPct != null ? `${cell.personnelPct.toFixed(1)} %` : '—'}</td>
                        <td className={cn(TD, TD_NUM)}>{cell.wesPct != null ? `${cell.wesPct.toFixed(1)} %` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Drilldown des Jahresvergleichs (§8) — Zusammensetzung + sichtbare Summenabstimmung */}
      <Dialog open={cmpDrill != null} onOpenChange={(open) => { if (!open) setCmpDrillRowId(null); }}>
        <DialogContent className={DIALOG_LG} data-testid="mya-cmp-drill-dialog">
          {cmpDrill && (
            <>
              <DialogHeader>
                <DialogTitle>{cmpDrill.label} — Zusammensetzung {cmpDrill.years.join(' · ')}</DialogTitle>
                <DialogDescription>
                  Werte über die gemeinsamen Vergleichsmonate
                  {cmpDrill.commonMonthsLabel ? ` (${cmpDrill.commonMonthsLabel})` : ''} — dieselbe Datenbasis
                  wie die Vergleichstabelle. Budgetwerte sind in der Mehrjahres-Datenbasis nicht enthalten.
                </DialogDescription>
              </DialogHeader>

              <div className="overflow-x-auto">
                <table className={TABLE}>
                  <thead>
                    <tr>
                      <th className={TH}>{cmpDrillHasComponents ? 'Komponente' : 'Kennzahl'}</th>
                      {cmpDrill.perYear.map((y) => (
                        <th key={y.year} className={cn(TH, TH_NUM)}>
                          {y.year}
                          {y.isPartial && y.partialLabel && (
                            <span className="ml-1 font-normal text-[10px] text-muted-foreground">({y.partialLabel})</span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cmpDrillHasComponents && (
                      <>
                        {(cmpDrill.perYear[0].components ?? []).map((c, ci) => (
                          <tr key={c.id} data-testid={`mya-cmp-drill-comp-${c.id}`}>
                            <td className={cn(TD)}>{c.label}</td>
                            {cmpDrill.perYear.map((y) => (
                              <td key={y.year} className={cn(TD, TD_NUM)}>{fmtChf(y.components?.[ci]?.total ?? null)}</td>
                            ))}
                          </tr>
                        ))}
                        <tr className="border-t border-border bg-muted/40 font-medium" data-testid="mya-cmp-drill-compsum">
                          <td className={TD}>Summe Komponenten</td>
                          {cmpDrill.perYear.map((y) => (
                            <td key={y.year} className={cn(TD, TD_NUM)}>{fmtChf(y.componentSum)}</td>
                          ))}
                        </tr>
                      </>
                    )}
                    <tr className="border-t-2 border-border bg-muted/60 font-semibold" data-testid="mya-cmp-drill-total">
                      <td className={TD}>{cmpDrill.label} (Vergleichsmonate)</td>
                      {cmpDrill.perYear.map((y) => (
                        <td key={y.year} className={cn(TD, TD_NUM)}>{fmtChf(y.commonTotal)}</td>
                      ))}
                    </tr>
                    {cmpDrillHasComponents && (
                      <tr data-testid="mya-cmp-drill-reconciliation">
                        <td className={cn(TD, 'text-xs text-muted-foreground')}>Summenabstimmung</td>
                        {cmpDrill.perYear.map((y) => (
                          <td key={y.year} className={cn(TD, TD_NUM, 'text-xs')}>
                            {y.reconciliationDiff == null ? (
                              <span className="text-muted-foreground">— (unvollständig)</span>
                            ) : Math.abs(y.reconciliationDiff) <= 0.5 ? (
                              <span className="inline-flex justify-end">
                                <StatusPill tone="good" size="xs">stimmt überein</StatusPill>
                              </span>
                            ) : (
                              <span className={TONE_TEXT.warn}>Abweichung {fmtDeltaChf(y.reconciliationDiff)} CHF</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div>
                <h4 className="mb-1 text-xs font-semibold text-muted-foreground">Monatswerte</h4>
                <div className="max-h-[40vh] overflow-auto rounded border border-border">
                  <table className={TABLE}>
                    <thead>
                      <tr>
                        <th className={cn(TH, TH_STICKY)}>Monat</th>
                        {cmpDrill.years.map((y) => (
                          <th key={y} className={cn(TH, TH_NUM, TH_STICKY)}>{y}</th>
                        ))}
                        {cmpDrill.years.slice(1).map((y, i) => (
                          <th key={`d-${y}`} className={cn(TH, TH_NUM, TH_STICKY)}>Δ {y} vs. {cmpDrill.years[i]}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {cmpDrill.monthRows.map((m) => (
                        <tr key={m.monthIdx} data-testid={`mya-cmp-drill-month-${m.monthIdx}`}>
                          <td className={cn(TD, 'font-medium')}>{m.label}</td>
                          {m.valueByYear.map((v, i) => (
                            <td key={cmpDrill.years[i]} className={cn(TD, TD_NUM)}>{fmtChf(v)}</td>
                          ))}
                          {m.deltaPrev.slice(1).map((d, i) => (
                            <td key={`d-${cmpDrill.years[i + 1]}`} className={cn(TD, TD_NUM, 'text-xs text-muted-foreground')}>
                              {deltaCellText(d.chf, d.pct)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {cmpDrill.dataQuality.length > 0 && (
                <p className="text-[11px] text-muted-foreground" data-testid="mya-cmp-drill-dq">
                  {cmpDrill.dataQuality.map((d) => d.text).join(' · ')}
                </p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
