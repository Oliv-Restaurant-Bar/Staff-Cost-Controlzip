/**
 * Banken & Investoren — Analyseansicht innerhalb der Erfolgsrechnung
 * ===================================================================
 * Reine ANZEIGE des zentralen BankInvestorAnalysis-Objekts
 * (bank-investor-analysis.ts). KEINE eigenen Berechnungen — Bildschirm,
 * PDF und Excel konsumieren exakt dasselbe Objekt (Vorschau ≡ Export).
 */

import { useMemo, useState } from 'react';
import { Landmark } from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip as RechartsTooltip, Legend,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { UnifiedExportButton } from '@/components/UnifiedExportButton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { HintBox } from '@/components/ui/hint-box';
import { InfoTip } from '@/components/ui/info-tip';
import { EmptyState } from '@/components/ui/page-states';
import { TABLE, TH, TH_NUM, TD, TD_NUM } from '@/components/ui/table-style';
import { TONE_TEXT, type Tone } from '@/components/ui/tones';
import {
  buildBankInvestorAnalysis, fmtPctChange, fmtPp, selectBankYears,
  type BankInvestorAnalysis, type BankPositionRow, type BankYearMode,
  type BankYearImportInfo,
} from '@/lib/bank-investor-analysis';
import { yearsWithAnyData, selectableYears, type YearSeries, type GrowthTone, type DataQualityItem } from '@/lib/multi-year-analysis';
import { BankExecutiveSection } from './bank-investor/BankExecutiveSection';
import { BankScorecardSection, type BankDrillMetric } from './bank-investor/BankScorecardSection';
import { BankBenchmarkSection } from './bank-investor/BankBenchmarkSection';
import { BankWaterfallSection } from './bank-investor/BankWaterfallSection';
import { BankEbitDriversSection } from './bank-investor/BankEbitDriversSection';
import { BankHistorieSection } from './bank-investor/BankHistorieSection';
import { BankHeatmapSection } from './bank-investor/BankHeatmapSection';
import { BankTimelineSection } from './bank-investor/BankTimelineSection';
import { BankKernaussagenSection } from './bank-investor/BankKernaussagenSection';
import { BankDrilldownDialog } from './bank-investor/BankDrilldownDialog';

// ── Format-Helfer (nur Darstellung) ──────────────────────────────────────────

const chf = (v: number | null): string =>
  v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('de-CH');
const pctS = (v: number | null): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

const toneToUi: Record<GrowthTone, Tone> = { good: 'good', critical: 'critical', neutral: 'neutral' };
const DQ_TONE: Record<DataQualityItem['severity'], Tone> = { fehler: 'critical', warnung: 'warn', hinweis: 'info' };

// ── Props ────────────────────────────────────────────────────────────────────

interface BankInvestorViewProps {
  series: YearSeries[];
  restaurantName: string;
  /** Anzahl nicht gemappter Konten (Datenqualitätshinweis) */
  unmappedAccounts?: number;
  /** Stand des letzten Imports (Anzeige im Kopf) */
  importStand?: string | null;
  /** Import-Metadaten je Jahr (Investor Timeline) */
  importInfoByYear?: Record<number, BankYearImportInfo>;
}

export function BankInvestorView({ series, restaurantName, unmappedAccounts, importStand, importInfoByYear }: BankInvestorViewProps) {
  // Jahresbasis der Selektoren: ALLE Serien-Jahre (auch ohne Daten — z. B.
  // aktuelles Jahr −2 vor dem Import) — identisch zu Mehrjahresanalyse und
  // Management Report (selectableYears). Jahre ohne Daten erscheinen als
  // «—» mit Datenqualitätshinweis, nie still verschluckt.
  const allYears = useMemo(() => selectableYears(series), [series]);
  // Jahre mit tatsächlichen Daten: nur für sinnvolle Defaults + Empty-State.
  const yearsWithData = useMemo(() => yearsWithAnyData(series), [series]);

  const defaultCurrent = yearsWithData[yearsWithData.length - 1] ?? new Date().getFullYear();
  const defaultBase = yearsWithData.filter(y => y < defaultCurrent).pop() ?? defaultCurrent - 1;

  const [baseYear, setBaseYear] = useState<number>(defaultBase);
  const [currentYear, setCurrentYear] = useState<number>(defaultCurrent);
  // null = automatisch: «Letzte 3 Jahre», sobald drei Jahre wählbar sind
  // (robust gegen nachträglich fertig geladene Serien), sonst 2 Jahre.
  const [yearModeSel, setYearModeSel] = useState<BankYearMode | null>(null);
  const yearMode: BankYearMode = yearModeSel ?? (allYears.length >= 3 ? 'three' : 'two');
  const [untilSameMonth, setUntilSameMonth] = useState(true);
  const [exporting, setExporting] = useState<'pdf' | 'excel' | null>(null);
  const [drillMetric, setDrillMetric] = useState<BankDrillMetric | null>(null);

  /** Gewählte Jahre: manuell (2 Jahre) oder automatisch letzte 3/alle. */
  const selectedYears = useMemo(() => {
    if (yearMode === 'two') return [baseYear, currentYear].sort((a, b) => a - b);
    return selectBankYears(allYears, yearMode);
  }, [yearMode, baseYear, currentYear, allYears]);

  // Im 3-Jahres-/Alle-Modus vergleichen die 2-Jahres-Teile (Charts, Treiber)
  // immer das neueste Jahr mit seinem Vorjahr in der Auswahl.
  const effCurrentYear = yearMode === 'two' ? currentYear : selectedYears[selectedYears.length - 1] ?? currentYear;
  const effBaseYear = yearMode === 'two' ? baseYear : selectedYears[selectedYears.length - 2] ?? baseYear;

  const analysis: BankInvestorAnalysis = useMemo(
    () => buildBankInvestorAnalysis(series, {
      baseYear: effBaseYear, currentYear: effCurrentYear, untilSameMonth,
      restaurantName, unmappedAccounts, importStand,
      years: selectedYears, importInfoByYear,
    }),
    [series, effBaseYear, effCurrentYear, untilSameMonth, restaurantName, unmappedAccounts, importStand, selectedYears, importInfoByYear],
  );

  const handlePdf = async () => {
    setExporting('pdf');
    try {
      const { exportBankInvestorPDF } = await import('@/lib/bank-investor-pdf');
      exportBankInvestorPDF(analysis);
    } finally { setExporting(null); }
  };
  const handleExcel = async () => {
    setExporting('excel');
    try {
      const { exportBankInvestorToExcel } = await import('@/lib/bank-investor-excel');
      await exportBankInvestorToExcel(analysis);
    } finally { setExporting(null); }
  };

  // ── Chart-Daten (reine Umformung des Analysis-Objekts) ─────────────────────
  const revenueChart = useMemo(() => analysis.revenueMonths.map(p => ({
    label: p.label, [`y${analysis.baseYear}`]: p.base, [`y${analysis.currentYear}`]: p.current,
    diffChf: p.diffChf, diffPct: p.diffPct,
  })), [analysis]);

  const costChart = (months: BankInvestorAnalysis['wareMonths']) => months.map(p => ({
    label: p.label,
    [`abs${analysis.baseYear}`]: p.base, [`abs${analysis.currentYear}`]: p.current,
    [`q${analysis.baseYear}`]: p.baseQuote, [`q${analysis.currentYear}`]: p.currentQuote,
  }));
  const wareChart = useMemo(() => costChart(analysis.wareMonths), [analysis]);
  const persChart = useMemo(() => costChart(analysis.personalMonths), [analysis]);

  const structChart = useMemo(() => analysis.costStructure.map(cs => ({
    year: String(cs.year),
    Warenaufwand: cs.shares.ware, Personalaufwand: cs.shares.personal,
    'Übriger Betriebsaufwand': cs.shares.uebrig, Abschreibungen: cs.shares.abschreibungen,
    Betriebsergebnis: cs.shares.ebit,
  })), [analysis]);

  if (yearsWithData.length < 2) {
    return (
      <EmptyState
        icon={Landmark}
        title="Mindestens zwei Geschäftsjahre benötigt"
        description="Für die Banken-/Investorenanalyse müssen Erfolgsrechnungsdaten aus mindestens zwei Jahren importiert sein (z. B. 2024 und 2025 im Import-Center hochladen)."
      />
    );
  }

  return (
    <div className="space-y-6" data-testid="bank-investor-view">
      {/* ── Kopf + Filter ── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Landmark className="h-5 w-5 text-muted-foreground" />
            {analysis.header.title}
            <InfoTip text="Zweijahresvergleich der Erfolgsrechnung für Banken, Finanzierungspartner und Investoren. Alle Zahlen stammen aus den importierten Erfolgsrechnungsdaten und den bestehenden P&L-Zwischentotalen — Bildschirm, PDF und Excel verwenden dieselbe Berechnung." />
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {analysis.header.restaurantName}
            {' · '}{analysis.comparison.label}
            {analysis.header.importStand ? <> {' · '}Importstand: {analysis.header.importStand}</> : null}
            {' · '}{analysis.header.dataSource}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={yearMode} onValueChange={v => setYearModeSel(v as BankYearMode)}>
            <SelectTrigger className="h-8 w-[130px] text-xs" data-testid="bank-year-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="two">2 Jahre</SelectItem>
              <SelectItem value="three" disabled={allYears.length < 3}>Letzte 3 Jahre</SelectItem>
              <SelectItem value="all" disabled={allYears.length < 3}>Alle Jahre</SelectItem>
            </SelectContent>
          </Select>
          {yearMode === 'two' && (
            <>
              <Select value={String(baseYear)} onValueChange={v => setBaseYear(Number(v))}>
                <SelectTrigger className="h-8 w-[110px] text-xs" data-testid="bank-base-year">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {allYears.map(y => (
                    <SelectItem key={y} value={String(y)} disabled={y === currentYear}>Basis {y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={String(currentYear)} onValueChange={v => setCurrentYear(Number(v))}>
                <SelectTrigger className="h-8 w-[110px] text-xs" data-testid="bank-current-year">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {allYears.map(y => (
                    <SelectItem key={y} value={String(y)} disabled={y === baseYear}>Aktuell {y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
          <div className="flex items-center gap-1.5 pl-1">
            <Switch id="bank-same-month" checked={untilSameMonth} onCheckedChange={setUntilSameMonth} data-testid="bank-same-month" />
            <Label htmlFor="bank-same-month" className="text-xs cursor-pointer">Bis gleicher Monat</Label>
            <InfoTip text="Vergleicht nur die Monate, für die im aktuellen Jahr Daten vorliegen (z. B. Januar–August 2025 mit Januar–August 2024). Verhindert irreführende Vergleiche eines unvollständigen Jahres mit einem vollständigen Vorjahr." />
          </div>
          <UnifiedExportButton
            data-testid="bank-export"
            disabled={exporting != null || !analysis.hasData}
            actions={[
              { key: 'pdf', label: 'PDF-Bericht', kind: 'pdf', onSelect: () => { void handlePdf(); } },
              { key: 'excel', label: 'Excel', kind: 'excel', onSelect: () => { void handleExcel(); } },
            ]}
          />
        </div>
      </div>

      {/* ── Datenqualität ── */}
      {analysis.dataQuality.length > 0 && (
        <div className="space-y-1.5" data-testid="bank-data-quality">
          {analysis.dataQuality.map((d, i) => (
            <HintBox key={i} tone={DQ_TONE[d.severity]}>{d.text}</HintBox>
          ))}
        </div>
      )}

      {!analysis.hasData ? (
        <EmptyState
          icon={Landmark}
          title="Datenbasis unvollständig"
          description="Für den gewählten Vergleich fehlen Erfolgsrechnungsdaten. Bitte beide Jahre im Import-Center importieren."
        />
      ) : (
        <>
          {/* ── Umsatzentwicklung ── */}
          <section className="rounded-lg border border-border bg-card p-4 space-y-3" data-testid="bank-revenue-section">
            <h3 className="text-sm font-semibold">Umsatzentwicklung nach Monat</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={revenueChart} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
                  <RechartsTooltip
                    formatter={(value: number | null, name: string) => [value != null ? `CHF ${chf(value)}` : '—', name.replace(/^y/, '')]}
                    labelFormatter={(label: string) => {
                      const p = analysis.revenueMonths.find(m => m.label === label);
                      if (!p) return label;
                      const diff = p.diffChf != null ? ` · Δ CHF ${chf(p.diffChf)}` : '';
                      const pctT = p.diffPct != null ? ` (${fmtPctChange(p.diffPct)})` : p.base === 0 || p.base == null ? ' (nicht vergleichbar)' : '';
                      return `${label}${diff}${pctT}`;
                    }}
                  />
                  <Legend formatter={(v: string) => v.replace(/^y/, '')} wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey={`y${analysis.baseYear}`} fill="hsl(215 16% 65%)" radius={[2, 2, 0, 0]} />
                  <Bar dataKey={`y${analysis.currentYear}`} fill="hsl(221 60% 45%)" radius={[2, 2, 0, 0]} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground" data-testid="bank-revenue-insights">
              <span>Stärkster Monat: <strong className="text-foreground">{analysis.revenueInsights.strongestMonth ? `${analysis.revenueInsights.strongestMonth.label} (CHF ${chf(analysis.revenueInsights.strongestMonth.value)})` : '—'}</strong></span>
              <span>Schwächster Monat: <strong className="text-foreground">{analysis.revenueInsights.weakestMonth ? `${analysis.revenueInsights.weakestMonth.label} (CHF ${chf(analysis.revenueInsights.weakestMonth.value)})` : '—'}</strong></span>
              <span>Grösster Zuwachs: <strong className="text-foreground">{analysis.revenueInsights.largestGain ? `${analysis.revenueInsights.largestGain.label} (+CHF ${chf(analysis.revenueInsights.largestGain.diffChf)})` : '—'}</strong></span>
              <span>Grösster Rückgang: <strong className="text-foreground">{analysis.revenueInsights.largestDecline ? `${analysis.revenueInsights.largestDecline.label} (−CHF ${chf(Math.abs(analysis.revenueInsights.largestDecline.diffChf))})` : '—'}</strong></span>
              <span>Jahreswachstum: <strong className="text-foreground">{fmtPctChange(analysis.revenueInsights.growthPct)}</strong></span>
            </div>
          </section>

          {/* ── Waren- & Personalkosten ── */}
          {[
            { id: 'ware', title: 'Warenaufwand und Warenquote', chart: wareChart, months: analysis.wareMonths, summary: analysis.wareSummary, name: 'Warenaufwand', quoteName: 'Warenquote' },
            { id: 'personal', title: 'Personalaufwand und Personalquote', chart: persChart, months: analysis.personalMonths, summary: analysis.personalSummary, name: 'Personalaufwand', quoteName: 'Personalquote' },
          ].map(sec => (
            <section key={sec.id} className="rounded-lg border border-border bg-card p-4 space-y-3" data-testid={`bank-${sec.id}-section`}>
              <h3 className="text-sm font-semibold">{sec.title}</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={sec.chart} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="abs" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
                    <YAxis yAxisId="quote" orientation="right" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${Math.round(v)}%`} />
                    <RechartsTooltip
                      formatter={(value: number | null, name: string) => {
                        const isQuote = name.startsWith('q');
                        const year = name.replace(/^(abs|q)/, '');
                        return [
                          value == null ? '—' : isQuote ? pctS(value) : `CHF ${chf(value)}`,
                          `${isQuote ? sec.quoteName : sec.name} ${year}`,
                        ];
                      }}
                    />
                    <Legend
                      formatter={(v: string) => `${v.startsWith('q') ? sec.quoteName : sec.name} ${v.replace(/^(abs|q)/, '')}`}
                      wrapperStyle={{ fontSize: 12 }}
                    />
                    <Bar yAxisId="abs" dataKey={`abs${analysis.baseYear}`} fill="hsl(215 16% 65%)" radius={[2, 2, 0, 0]} />
                    <Bar yAxisId="abs" dataKey={`abs${analysis.currentYear}`} fill="hsl(221 60% 45%)" radius={[2, 2, 0, 0]} />
                    <Line yAxisId="quote" type="monotone" dataKey={`q${analysis.baseYear}`} stroke="hsl(215 16% 47%)" strokeDasharray="4 3" dot={false} strokeWidth={1.5} />
                    <Line yAxisId="quote" type="monotone" dataKey={`q${analysis.currentYear}`} stroke="hsl(24 74% 45%)" dot={false} strokeWidth={2} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground" data-testid={`bank-${sec.id}-summary`}>
                <span>{sec.name} {analysis.baseYear}: <strong className="text-foreground">CHF {chf(sec.summary.baseTotal)}</strong></span>
                <span>{sec.name} {analysis.currentYear}: <strong className="text-foreground">CHF {chf(sec.summary.currentTotal)}</strong></span>
                <span>Veränderung: <strong className="text-foreground">{sec.summary.diffChf != null ? `${sec.summary.diffChf >= 0 ? '+' : '−'}CHF ${chf(Math.abs(sec.summary.diffChf))}` : '—'} ({fmtPctChange(sec.summary.diffPct)})</strong></span>
                <span>{sec.quoteName} {analysis.baseYear}: <strong className="text-foreground">{pctS(sec.summary.baseQuote)}</strong></span>
                <span>{sec.quoteName} {analysis.currentYear}: <strong className="text-foreground">{pctS(sec.summary.currentQuote)}</strong></span>
                <span>Δ Quote: <strong className="text-foreground">{sec.summary.quotePp != null ? fmtPp(sec.summary.quotePp) : '—'}</strong></span>
              </div>
            </section>
          ))}

          {/* ── EBIT-Treiber (Phase 2 §5) ── */}
          <BankEbitDriversSection drivers={analysis.ebitDrivers} />

          {/* ── Executive Summary (Phase 2 §2): Gesamttrend + 9 KPIs ── */}
          <BankExecutiveSection executive={analysis.executive} />

          {/* ── Mehrjahres-Scorecard (Phase 2 §3) ── */}
          <BankScorecardSection scorecard={analysis.scorecard} onDrill={setDrillMetric} />

          {/* ── Zwischentotale und Margen ── */}
          <section className="rounded-lg border border-border bg-card overflow-hidden" data-testid="bank-totals-table">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold">Zwischentotale und Margen</h3>
            </div>
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr>
                    <th className={TH}>Kennzahl</th>
                    <th className={TH_NUM}>{analysis.baseYear}</th>
                    <th className={TH_NUM}>{analysis.currentYear}</th>
                    <th className={TH_NUM}>Δ CHF</th>
                    <th className={TH_NUM}>Δ %</th>
                    <th className={TH_NUM}>Quote {analysis.baseYear}</th>
                    <th className={TH_NUM}>Quote {analysis.currentYear}</th>
                    <th className={TH_NUM}>Δ Quote</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.totalsRows.map(r => <TotalsRow key={r.id} row={r} />)}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-2 text-xs text-muted-foreground border-t border-border" data-testid="bank-ebit-note">
              {analysis.ebitNote}
            </p>
          </section>

          {/* ── Mehrjahresvergleich nach Position ── */}
          <section className="rounded-lg border border-border bg-card overflow-hidden" data-testid="bank-position-table">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <h3 className="text-sm font-semibold">Mehrjahresvergleich nach Position</h3>
              <InfoTip text="Alle Erfolgsrechnungspositionen und Zwischentotale aus der bestehenden P&L-Struktur — dieselben Werte wie in der Erfolgsrechnung, keine Zweitberechnung." />
            </div>
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr>
                    <th className={TH}>Position</th>
                    <th className={TH_NUM}>{analysis.baseYear}</th>
                    <th className={TH_NUM}>{analysis.currentYear}</th>
                    <th className={TH_NUM}>Δ CHF</th>
                    <th className={TH_NUM}>Δ %</th>
                    <th className={TH_NUM}>Anteil Umsatz {analysis.baseYear}</th>
                    <th className={TH_NUM}>Anteil Umsatz {analysis.currentYear}</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.positionRows.map(r => (
                    <tr key={r.id} className={r.emphasis ? 'bg-muted/50' : undefined} data-testid={`bank-pos-${r.id}`}>
                      <td className={`${TD} ${r.emphasis ? 'font-semibold' : ''}`}>{r.label}</td>
                      <td className={`${TD_NUM} ${r.emphasis ? 'font-semibold' : ''}`}>{chf(r.base)}</td>
                      <td className={`${TD_NUM} ${r.emphasis ? 'font-semibold' : ''}`}>{chf(r.current)}</td>
                      <td className={TD_NUM}>{chf(r.diffChf)}</td>
                      <td className={TD_NUM}>{r.diffPct == null ? 'n. vgl.' : fmtPctChange(r.diffPct)}</td>
                      <td className={TD_NUM}>{pctS(r.baseQuote)}</td>
                      <td className={TD_NUM}>{pctS(r.currentQuote)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── Kostenstruktur ── */}
          <section className="rounded-lg border border-border bg-card p-4 space-y-3" data-testid="bank-cost-structure">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              Kostenstruktur (Anteil am Umsatz)
              <InfoTip text="Gestapelte Anteile pro Jahr: Warenaufwand, Personalaufwand, übriger Betriebsaufwand, Abschreibungen und Betriebsergebnis in % des Betriebsertrags. Fehlende Positionen werden nicht als 0 dargestellt." />
            </h3>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={structChart} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${v}%`} domain={[0, 100]} />
                  <YAxis type="category" dataKey="year" tick={{ fontSize: 12 }} width={44} />
                  <RechartsTooltip formatter={(value: number | null, name: string) => [value == null ? 'nicht vorhanden' : pctS(value), name]} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Warenaufwand" stackId="s" fill="hsl(24 60% 55%)" />
                  <Bar dataKey="Personalaufwand" stackId="s" fill="hsl(221 55% 50%)" />
                  <Bar dataKey="Übriger Betriebsaufwand" stackId="s" fill="hsl(215 16% 62%)" />
                  <Bar dataKey="Abschreibungen" stackId="s" fill="hsl(262 30% 60%)" />
                  <Bar dataKey="Betriebsergebnis" stackId="s" fill="hsl(152 45% 42%)" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* ── Benchmark (Phase 2 §7) ── */}
          <BankBenchmarkSection benchmarks={analysis.benchmarks} year={analysis.currentYear} />

          {/* ── Kennzahlenhistorie (Phase 2 §6) ── */}
          <BankHistorieSection historie={analysis.historie} />

          {/* ── Saisonalitäts-Heatmap (Phase 2 §8) ── */}
          <BankHeatmapSection heatmaps={analysis.heatmaps} />

          {/* ── Investor Timeline (Phase 2 §10) ── */}
          <BankTimelineSection timeline={analysis.timeline} />

          {/* ── Kernaussagen 5+5 (Phase 2 §9) ── */}
          <BankKernaussagenSection kernaussagen={analysis.kernaussagenPlus} />

          {/* ── Waterfall Umsatz→EBIT (Phase 2 §4) — zuletzt (Vorgabe: ganz ans Ende) ── */}
          <BankWaterfallSection waterfall={analysis.waterfall} />

          {/* ── Drilldown Monatsdetail (Phase 2 §11) ── */}
          <BankDrilldownDialog metric={drillMetric} analysis={analysis} onClose={() => setDrillMetric(null)} />
        </>
      )}
    </div>
  );
}

function TotalsRow({ row }: { row: BankPositionRow }) {
  const emph = row.emphasis;
  const chfTone = (v: number | null): string => {
    if (v == null || row.semantics === 'expense') return '';
    return v > 0 ? TONE_TEXT.good : v < 0 ? TONE_TEXT.critical : '';
  };
  return (
    <tr className={emph ? 'bg-muted/50' : undefined} data-testid={`bank-total-${row.id}`}>
      <td className={`${TD} ${emph ? 'font-semibold' : ''}`}>{row.label}</td>
      <td className={`${TD_NUM} ${emph ? 'font-semibold' : ''}`}>{chf(row.base)}</td>
      <td className={`${TD_NUM} ${emph ? 'font-semibold' : ''}`}>{chf(row.current)}</td>
      <td className={`${TD_NUM} ${chfTone(row.diffChf)}`}>{chf(row.diffChf)}</td>
      <td className={TD_NUM}>{row.diffPct == null ? 'n. vgl.' : fmtPctChange(row.diffPct)}</td>
      <td className={TD_NUM}>{pctS(row.baseQuote)}</td>
      <td className={TD_NUM}>{pctS(row.currentQuote)}</td>
      <td className={TD_NUM}>{row.quotePp == null ? '—' : fmtPp(row.quotePp)}</td>
    </tr>
  );
}
