/**
 * Management Report (Live-Ansicht) — §13 der Mehrjahres-Spezifikation.
 *
 * Kompakter, präsentierbarer Bericht direkt in der App: Kopfbereich,
 * Executive Summary, KPI-Übersicht, Mehrjahresvergleich, Monatsentwicklung,
 * Diagramme, Top-/Schwache Monate, Datenqualität (Schweregrade) und Methodik.
 *
 * Rein darstellend: ALLE Zahlen stammen aus buildMultiYearAnalysis()
 * (dieselbe Quelle wie Mehrjahresanalyse & PDF-Export — Exportwerte sind
 * dadurch exakt identisch zur Live-Ansicht). Keine Zweitberechnungen.
 */
import { useMemo, useState } from 'react';
import { CalendarRange, FileDown, FileText } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/page-states';
import { StatusPill } from '@/components/ui/status-pill';
import { TONE_TEXT } from '@/components/ui/tones';
import {
  TABLE, TD, TD_NUM, TH, TH_NUM,
} from '@/components/ui/table-style';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis,
  CartesianGrid, Legend, Tooltip as RechartsTooltip,
} from 'recharts';
import { toast } from 'sonner';

import {
  buildMultiYearAnalysis, buildMethodikNotes, nonEmptyYears, selectYears, seriesForPosition,
  fmtChf, fmtMio, fmtPct, fmtDeltaChf,
  MULTI_YEAR_POSITIONS, DEFAULT_POSITION,
  MIN_YEAR_SELECTION, MAX_YEAR_SELECTION,
  type DataQualityItem, type DataQualitySeverity, type MultiYearAnalysis, type YearSeries,
} from '@/lib/multi-year-analysis';

const LINE_COLORS = ['#94a3b8', '#818cf8', '#0ea5e9', '#f59e0b', '#10b981'];

const TREND_LABEL: Record<string, string> = {
  steigend: 'Steigend',
  stabil: 'Stabil',
  ruecklaeufig: 'Rückläufig',
};

const SEVERITY_META: Record<DataQualitySeverity, { label: string; text: string }> = {
  fehler: { label: 'Fehler', text: 'text-red-700' },
  warnung: { label: 'Warnung', text: 'text-amber-700' },
  hinweis: { label: 'Hinweis', text: 'text-muted-foreground' },
};

/** Abschnittstitel im Berichts-Stil (nummeriert, dezente Linie). */
function ReportSection({
  nr, title, children, testId,
}: { nr: number; title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <h3 className="flex items-baseline gap-2 border-b border-border pb-1.5 text-sm font-bold">
        <span className="text-xs font-semibold text-indigo-600 tabular-nums">{nr}.</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

export function ManagementReportView({
  series,
  restaurantName,
  dataSourceHints,
}: {
  /** Alle verfügbaren Jahre (gleiche Rohdaten wie MultiYearAnalysisSection). */
  series: YearSeries[];
  /** Firmenname für Kopf & Export (z. B. "Oliv"). */
  restaurantName?: string;
  /** Seitenspezifische Datenquellen-Hinweise (fliessen in die Methodik ein). */
  dataSourceHints?: string[];
}) {
  const [positionId, setPositionId] = useState<string>(DEFAULT_POSITION.id);
  const [selectedYears, setSelectedYears] = useState<number[] | null>(null);
  const [exporting, setExporting] = useState(false);

  const position = MULTI_YEAR_POSITIONS.find((p) => p.id === positionId) ?? DEFAULT_POSITION;
  const isExpense = position.semantics === 'expense';
  const isRevenue = position.semantics === 'revenue';

  const usable = useMemo(
    () => nonEmptyYears(seriesForPosition(series, position.id)),
    [series, position.id],
  );
  const availableYearsList = useMemo(() => usable.map((s) => s.year), [usable]);

  // Gleiche Auswahl-Logik wie in der Mehrjahresanalyse (§6).
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
  const { kpis, monthRows, totals, years, baseYear, chart, yearSummaries } = analysis;

  const dqBySeverity = useMemo(() => {
    const g: Record<DataQualitySeverity, DataQualityItem[]> = { fehler: [], warnung: [], hinweis: [] };
    for (const item of analysis.dataQuality) g[item.severity].push(item);
    return g;
  }, [analysis.dataQuality]);

  const methodik = useMemo(() => buildMethodikNotes({ dataSourceHints }), [dataSourceHints]);

  // Kopf-Metadaten: Periode, Datenstand (letzter Datenmonat), Volljahr/YTD.
  const latestTotal = totals.length > 0 ? totals[totals.length - 1] : null;
  const periode = years.length > 0 ? `${years[0]}–${years[years.length - 1]}` : '—';
  const erstelltAm = useMemo(() => {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  }, []);
  const datenstand = latestTotal
    ? latestTotal.isPartial && latestTotal.partialLabel
      ? `${latestTotal.year}: ${latestTotal.partialLabel}`
      : latestTotal.total != null ? `${latestTotal.year}: vollständig` : '—'
    : '—';

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const { exportManagementReportPDF } = await import('@/lib/management-report-pdf');
      exportManagementReportPDF(analysis, { restaurantName, dataSourceHints });
      toast.success('Management-Report (PDF) erstellt');
    } catch (e) {
      console.error('Management-Report PDF fehlgeschlagen:', e);
      toast.error('PDF-Export fehlgeschlagen');
    } finally {
      setExporting(false);
    }
  };

  if (!analysis.hasAnyData) {
    return (
      <div className="rounded-lg border border-border bg-card" data-testid="mrv-empty">
        <EmptyState
          icon={FileText}
          title="Keine Daten für den Management Report"
          description="Es sind noch keine Monatswerte im Reporting erfasst. Erfassen Sie Monatsdaten unter Reporting → Monatsdaten, danach erscheint hier der Bericht."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6" data-testid="mrv-report">
      {/* Toolbar (nicht Teil des Berichts) */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={position.id} onValueChange={(v) => setPositionId(v)}>
          <SelectTrigger className="h-8 w-48 text-xs" data-testid="mrv-position">
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
              data-testid="mrv-years"
              title="Jahre für den Bericht auswählen (min. 2, max. 5)"
            >
              <CalendarRange className="h-3.5 w-3.5" />
              {effectiveYears.length <= 3 ? effectiveYears.join(' · ') : `${effectiveYears.length} Jahre`}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-52 p-3" data-testid="mrv-years-popover">
            <p className="mb-2 text-xs font-semibold">Jahre im Bericht</p>
            <div className="space-y-1.5">
              {availableYearsList.map((y) => {
                const checked = effectiveYears.includes(y);
                const disabled =
                  (checked && effectiveYears.length <= MIN_YEAR_SELECTION) ||
                  (!checked && effectiveYears.length >= MAX_YEAR_SELECTION);
                return (
                  <label key={y} className={cn('flex items-center gap-2 text-xs', disabled ? 'opacity-50' : 'cursor-pointer')}>
                    <Checkbox
                      checked={checked}
                      disabled={disabled}
                      onCheckedChange={() => toggleYear(y)}
                      data-testid={`mrv-year-checkbox-${y}`}
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
          variant="outline" size="sm" className="ml-auto h-8 gap-1 text-xs"
          onClick={handleExportPDF} disabled={exporting}
          data-testid="mrv-export-pdf"
          title="Diesen Bericht als PDF exportieren (identische Werte)"
        >
          <FileDown className="h-3.5 w-3.5" />
          {exporting ? 'Erstelle…' : 'Management Report PDF'}
        </Button>
      </div>

      {/* Berichts-Dokument */}
      <div className="rounded-lg border border-border bg-card px-6 py-6 shadow-sm sm:px-10 sm:py-8">
        {/* Kopfbereich */}
        <header className="border-b-2 border-slate-900 pb-4" data-testid="mrv-header">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {restaurantName ?? 'Restaurant'}
          </p>
          <h2 className="mt-1 text-xl font-bold">
            Management Report — {isRevenue ? 'Umsatzentwicklung' : position.label} {periode}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
            <span>Berichtsperiode: <span className="font-medium text-foreground tabular-nums">{periode}</span></span>
            <span>Erstellt am: <span className="font-medium text-foreground tabular-nums">{erstelltAm}</span></span>
            <span>Datenstand: <span className="font-medium text-foreground">{datenstand}</span></span>
            {latestTotal && (
              <StatusPill tone={latestTotal.isPartial ? 'info' : 'good'} size="xs" showDot={false}>
                {latestTotal.isPartial ? `YTD (Teiljahr ${latestTotal.year})` : `Volljahr ${latestTotal.year}`}
              </StatusPill>
            )}
          </div>
        </header>

        <div className="mt-6 space-y-7">
          {/* 1. Executive Summary */}
          <ReportSection nr={1} title="Executive Summary" testId="mrv-summary">
            {analysis.executiveSummary.length === 0 ? (
              <p className="text-xs text-muted-foreground">Keine Zusammenfassung verfügbar.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-5 text-[13px] leading-relaxed">
                {analysis.executiveSummary.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            )}
          </ReportSection>

          {/* 2. KPI-Übersicht */}
          <ReportSection nr={2} title="Kennzahlen im Überblick" testId="mrv-kpis">
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs sm:grid-cols-2">
              {[
                {
                  label: `${position.label} ${kpis.latestYear ?? '—'}${kpis.latestYearPartialLabel ? ` (${kpis.latestYearPartialLabel})` : ''}`,
                  value: `CHF ${fmtChf(kpis.latestYearValue)}`,
                },
                {
                  label: `${isRevenue ? 'Wachstum' : 'Veränderung'} vs. ${kpis.prevYear ?? 'Vorjahr'}${kpis.growthCommonMonths > 0 && kpis.growthCommonMonths < 12 ? ` (${kpis.growthCommonMonths} gemeinsame Monate)` : ''}`,
                  value: kpis.growthPct == null ? '—' : `${fmtPct(kpis.growthPct)} (${fmtDeltaChf(kpis.growthChf)} CHF)`,
                },
                {
                  label: kpis.cagrFromYear != null ? `CAGR ${kpis.cagrFromYear}–${kpis.cagrToYear} (volle Jahre)` : 'CAGR',
                  value: kpis.cagrPct == null ? '—' : fmtPct(kpis.cagrPct),
                },
                { label: isRevenue ? 'Ø monatliches Wachstum' : 'Ø monatliche Veränderung', value: fmtPct(kpis.avgMonthlyGrowthPct) },
                {
                  label: `${isExpense ? 'Höchster' : 'Bester'} Monat ${kpis.latestYear ?? ''}`.trim(),
                  value: kpis.bestMonth ? `${kpis.bestMonth.label} (CHF ${fmtChf(kpis.bestMonth.value)})` : '—',
                },
                {
                  label: `${isExpense ? 'Tiefster' : 'Schwächster'} Monat ${kpis.latestYear ?? ''}`.trim(),
                  value: kpis.worstMonth ? `${kpis.worstMonth.label} (CHF ${fmtChf(kpis.worstMonth.value)})` : '—',
                },
                {
                  label: isExpense ? 'Höchster Jahreswert' : 'Bestes Jahresergebnis',
                  value: kpis.highestAnnual
                    ? `${kpis.highestAnnual.year}: CHF ${fmtChf(kpis.highestAnnual.total)}${kpis.highestAnnual.isPartial ? ' (Teiljahr)' : ''}`
                    : '—',
                },
                { label: 'Trend', value: kpis.trend ? TREND_LABEL[kpis.trend] : '—' },
              ].map((kv, i) => (
                <div key={i} className="flex items-baseline justify-between gap-3 border-b border-dashed border-border/70 pb-1">
                  <span className="text-muted-foreground">{kv.label}</span>
                  <span className="font-semibold tabular-nums">{kv.value}</span>
                </div>
              ))}
            </div>
          </ReportSection>

          {/* 3. Mehrjahresvergleich */}
          <ReportSection nr={3} title="Mehrjahresvergleich" testId="mrv-years-table">
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={TH}>Jahr</th>
                  <th className={cn(TH, TH_NUM)}>{position.label} CHF</th>
                  <th className={cn(TH, TH_NUM)}>Δ Vorjahr</th>
                  <th className={cn(TH, TH_NUM)}>Δ Basisjahr {baseYear}</th>
                  <th className={TH}>Datenbasis</th>
                </tr>
              </thead>
              <tbody>
                {totals.map((t) => (
                  <tr key={t.year}>
                    <td className={cn(TD, 'font-medium tabular-nums')}>{t.year}{t.year === baseYear ? ' (Basisjahr)' : ''}</td>
                    <td className={cn(TD, TD_NUM, 'font-semibold')}>{fmtChf(t.total)}</td>
                    <td className={cn(TD, TD_NUM, 'text-xs',
                      t.year === baseYear || t.vsPrevYearCommon.pct == null || isExpense
                        ? 'text-muted-foreground'
                        : t.vsPrevYearCommon.pct >= 0 ? TONE_TEXT.good : TONE_TEXT.critical)}>
                      {t.year === baseYear ? '—' : (
                        <>
                          {fmtPct(t.vsPrevYearCommon.pct)}
                          {t.vsPrevYearCommon.commonMonths > 0 && t.vsPrevYearCommon.commonMonths < 12 && (
                            <span className="ml-0.5 text-[10px] text-muted-foreground">({t.vsPrevYearCommon.commonMonths} Mte.)</span>
                          )}
                        </>
                      )}
                    </td>
                    <td className={cn(TD, TD_NUM, 'text-xs text-muted-foreground')}>
                      {t.year === baseYear ? '—' : fmtPct(t.vsBaseYearCommon.pct)}
                    </td>
                    <td className={cn(TD, 'text-xs')}>
                      {t.isPartial && t.partialLabel ? `Teiljahr: ${t.partialLabel}` : `${t.monthsWithData} Monate`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ReportSection>

          {/* 4. Monatsentwicklung */}
          <ReportSection nr={4} title={isRevenue ? 'Monatsumsätze im Vergleich (CHF netto)' : `${position.label} pro Monat im Vergleich (CHF)`} testId="mrv-months-table">
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr>
                    <th className={TH}>Monat</th>
                    {years.map((y) => <th key={y} className={cn(TH, TH_NUM)}>{y}</th>)}
                    <th className={cn(TH, TH_NUM)}>Δ VJ</th>
                  </tr>
                </thead>
                <tbody>
                  {monthRows.map((row) => {
                    const lastCell = row.cells[row.cells.length - 1];
                    return (
                      <tr key={row.monthIdx}>
                        <td className={cn(TD, 'font-medium')}>{row.label}</td>
                        {row.cells.map((c) => (
                          <td key={c.year} className={cn(TD, TD_NUM)}>{fmtChf(c.value)}</td>
                        ))}
                        <td className={cn(TD, TD_NUM, 'text-xs',
                          lastCell?.vsPrevYear.pct == null || isExpense
                            ? 'text-muted-foreground'
                            : lastCell.vsPrevYear.pct >= 0 ? TONE_TEXT.good : TONE_TEXT.critical)}>
                          {row.cells.length > 1 ? fmtPct(lastCell?.vsPrevYear.pct ?? null) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-border bg-muted/60 font-semibold">
                    <td className={TD}>Total</td>
                    {totals.map((t) => (
                      <td key={t.year} className={cn(TD, TD_NUM)}>
                        {fmtChf(t.total)}
                        {t.isPartial && t.partialLabel && (
                          <span className="ml-1 font-normal text-[10px] text-muted-foreground">({t.partialLabel})</span>
                        )}
                      </td>
                    ))}
                    <td className={cn(TD, TD_NUM, 'text-xs')}>
                      {totals.length > 1 && latestTotal ? fmtPct(latestTotal.vsPrevYearCommon.pct) : '—'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </ReportSection>

          {/* 5. Diagramme */}
          <ReportSection nr={5} title="Entwicklung im Zeitverlauf" testId="mrv-charts">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-md border border-border p-3">
                <p className="mb-2 text-[11px] font-semibold text-muted-foreground">
                  {position.label} pro Monat, eine Linie pro Jahr
                </p>
                <ResponsiveContainer width="100%" height={230}>
                  <LineChart data={chart.line} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="month" tick={{ fontSize: 10 }} />
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
              <div className="rounded-md border border-border p-3">
                <p className="mb-2 text-[11px] font-semibold text-muted-foreground">
                  {position.label} pro Jahr (Summe der erfassten Monate)
                </p>
                <ResponsiveContainer width="100%" height={230}>
                  <BarChart data={chart.bars} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="year" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => fmtMio(v)} width={64} />
                    <RechartsTooltip formatter={(v: number) => [`CHF ${fmtChf(v)}`, position.label]} />
                    <Bar dataKey="total" name={position.label} radius={[4, 4, 0, 0]}>
                      {chart.bars.map((b) => (
                        <Cell key={b.year} fill={b.year === kpis.latestYear ? '#4f46e5' : '#a5b4fc'} opacity={b.isPartial ? 0.65 : 1} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </ReportSection>

          {/* 6. Stärkste und schwächste Monate je Jahr */}
          <ReportSection nr={6} title={isExpense ? 'Höchste und tiefste Monate je Jahr' : 'Stärkste und schwächste Monate je Jahr'} testId="mrv-top-flop">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {yearSummaries.map((ys) => (
                <div key={ys.year} className="rounded-md border border-border p-3" data-testid={`mrv-year-detail-${ys.year}`}>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold tabular-nums">{ys.year}{ys.isPartial && ys.partialLabel ? ` · ${ys.partialLabel}` : ''}</p>
                    {ys.growthPct != null && (
                      <span className={cn('text-[11px] font-semibold tabular-nums',
                        isExpense ? 'text-muted-foreground' : ys.growthPct >= 0 ? TONE_TEXT.good : TONE_TEXT.critical)}>
                        {fmtPct(ys.growthPct)} vs. VJ
                      </span>
                    )}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 text-[11px]">
                    <div>
                      <p className="font-semibold text-muted-foreground">{isExpense ? 'Höchste' : 'Top'}</p>
                      {ys.bestMonths.length === 0 && <p className="text-muted-foreground/60">—</p>}
                      {ys.bestMonths.map((m) => (
                        <p key={m.monthIdx} className="flex justify-between gap-1">
                          <span>{m.label}</span>
                          <span className="tabular-nums">{fmtChf(m.value)}</span>
                        </p>
                      ))}
                    </div>
                    <div>
                      <p className="font-semibold text-muted-foreground">{isExpense ? 'Tiefste' : 'Schwächste'}</p>
                      {ys.worstMonths.length === 0 && <p className="text-muted-foreground/60">—</p>}
                      {ys.worstMonths.map((m) => (
                        <p key={m.monthIdx} className="flex justify-between gap-1">
                          <span>{m.label}</span>
                          <span className="tabular-nums">{fmtChf(m.value)}</span>
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ReportSection>

          {/* 7. Datenqualität (§16 — Fehler nie stillschweigend) */}
          <ReportSection nr={7} title="Datenqualität und Einschränkungen" testId="mrv-data-quality">
            {analysis.dataQuality.length === 0 ? (
              <p className="text-xs text-muted-foreground">Keine Auffälligkeiten in der Datenbasis erkannt.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {(['fehler', 'warnung', 'hinweis'] as DataQualitySeverity[]).flatMap((sev) =>
                  dqBySeverity[sev].map((d, i) => (
                    <li key={`${sev}-${i}`} className="flex gap-2">
                      <span className={cn('w-16 shrink-0 font-semibold', SEVERITY_META[sev].text)}>
                        {SEVERITY_META[sev].label}
                      </span>
                      <span>{d.text}</span>
                    </li>
                  )),
                )}
              </ul>
            )}
          </ReportSection>

          {/* 8. Methodik */}
          <ReportSection nr={8} title="Methodik" testId="mrv-methodik">
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {methodik.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          </ReportSection>
        </div>
      </div>
    </div>
  );
}
