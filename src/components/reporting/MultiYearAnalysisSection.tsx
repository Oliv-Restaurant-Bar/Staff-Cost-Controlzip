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
  fmtChf, fmtMio, fmtPct, fmtDeltaChf,
  MONTH_LABELS_LONG, MULTI_YEAR_POSITIONS, DEFAULT_POSITION,
  MIN_YEAR_SELECTION, MAX_YEAR_SELECTION,
  type DataQualityItem, type DataQualitySeverity,
  type GrowthTone, type MultiYearAnalysis, type YearSeries,
} from '@/lib/multi-year-analysis';

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

  const position = MULTI_YEAR_POSITIONS.find((p) => p.id === positionId) ?? DEFAULT_POSITION;
  const isExpense = position.semantics === 'expense';
  const isRevenue = position.semantics === 'revenue';

  const usable = useMemo(
    () => nonEmptyYears(seriesForPosition(series, position.id)),
    [series, position.id],
  );
  const availableYearsList = useMemo(() => usable.map((s) => s.year), [usable]);

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
  };

  const analysis: MultiYearAnalysis = useMemo(
    () => buildMultiYearAnalysis(selectYears(usable, effectiveYears), { position }),
    [usable, effectiveYears, position],
  );
  const detail = useMemo(
    () => (detailMonthIdx == null ? null : buildMonthDetail(analysis, detailMonthIdx)),
    [analysis, detailMonthIdx],
  );

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
      exportManagementReportPDF(analysis, { restaurantName, dataSourceHints });
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
    </div>
  );
}
