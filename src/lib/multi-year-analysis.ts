/**
 * Mehrjahresanalyse der Erfolgsrechnung (Bank-/Investoren-Ansicht)
 * =================================================================
 *
 * Reine Berechnungs-Lib (DOM-/Supabase-frei):
 *   YearSeries[] (Netto-Umsatz pro Monat und Jahr, aus computePLForMonth)
 *     → buildMultiYearAnalysis() → EIN Ergebnisobjekt (MultiYearAnalysis)
 *
 * Alle Konsumenten (UI-Tabelle, Monats-Dialog, Diagramme, PDF-Report,
 * Excel-Export) leiten sich AUSSCHLIESSLICH aus diesem Objekt ab —
 * Vorschau ≡ Export ist damit garantiert.
 *
 * Regeln:
 *   - Fehlende Werte bleiben null (nie 0 erfinden, nie NaN/Infinity).
 *   - Δ Vorjahr nur, wenn das direkte Kalender-Vorjahr in der Auswahl ist.
 *   - Jahres-Wachstum/KPIs bei Teiljahren NUR über gemeinsame Monate,
 *     mit expliziter Kennzeichnung (limitations).
 *   - CAGR nur über vollständige Jahre (12 Datenmonate), sonst null.
 *   - Stabile Sortierung (bei Gleichstand entscheidet der Monatsindex).
 */

// ─── Eingabe ──────────────────────────────────────────────────────────────────

export interface YearSeries {
  year: number;
  /** Netto-Umsatz pro Monat, Index 0 = Januar. null = kein Wert erfasst. */
  netRevenue: (number | null)[];
  /** Optional: Personalquote (% vom Umsatz) pro Monat, aus der P&L abgeleitet. */
  personnelPct?: (number | null)[];
  /** Optional: Wareneinsatzquote (% vom Umsatz) pro Monat. */
  wesPct?: (number | null)[];
}

// ─── Ergebnis-Typen ───────────────────────────────────────────────────────────

export type GrowthTone = 'good' | 'critical' | 'neutral';
export type TrendDirection = 'steigend' | 'stabil' | 'ruecklaeufig';

export interface DeltaValue {
  chf: number | null;
  pct: number | null;
}

export interface MonthYearCell {
  year: number;
  value: number | null;
  /** Δ zum direkten Kalender-Vorjahr (null wenn nicht in Auswahl / kein Wert) */
  vsPrevYear: DeltaValue;
  /** Δ zum Basisjahr (ältestes Jahr der Auswahl; null für das Basisjahr selbst) */
  vsBaseYear: DeltaValue;
  /** Rang innerhalb des Jahres (1 = umsatzstärkster Monat), stabil sortiert */
  rankInYear: number | null;
  /** Anteil am Jahresumsatz in % (Basis = Summe der Datenmonate) */
  shareOfYearPct: number | null;
  /** Ton der Vorjahresveränderung (good/critical/neutral, ±Schwelle) */
  tone: GrowthTone;
  personnelPct: number | null;
  wesPct: number | null;
}

export interface MonthRow {
  monthIdx: number; // 0 = Januar
  label: string;
  cells: MonthYearCell[]; // eine Zelle pro Jahr, aufsteigend sortiert
}

export interface YearTotalCell {
  year: number;
  total: number | null;
  monthsWithData: number;
  isPartial: boolean;
  /** Label der Datenmonate, z.B. "Januar–Juni" (nur bei Teiljahr) */
  partialLabel: string | null;
  /** Δ zum Vorjahr über GEMEINSAME Monate (fair bei Teiljahren) */
  vsPrevYearCommon: DeltaValue & { commonMonths: number };
  /** Δ zum Basisjahr über GEMEINSAME Monate */
  vsBaseYearCommon: DeltaValue & { commonMonths: number };
}

export interface MultiYearKpis {
  latestYear: number | null;
  latestYearRevenue: number | null;
  latestYearPartialLabel: string | null;
  prevYear: number | null;
  prevYearRevenue: number | null;
  /** Wachstum letztes vs. Vorjahr über gemeinsame Monate */
  growthChf: number | null;
  growthPct: number | null;
  growthCommonMonths: number;
  /** CAGR über vollständige Jahre (12 Datenmonate); null wenn <2 volle Jahre */
  cagrPct: number | null;
  cagrFromYear: number | null;
  cagrToYear: number | null;
  /** Ø der monatlichen Vorjahres-Wachstumsraten (letztes vs. Vorjahr) */
  avgMonthlyGrowthPct: number | null;
  bestMonth: { monthIdx: number; label: string; value: number } | null;
  worstMonth: { monthIdx: number; label: string; value: number } | null;
  highestAnnual: { year: number; total: number; isPartial: boolean } | null;
  trend: TrendDirection | null;
}

export interface QuarterProfile {
  label: string; // Q1..Q4
  total: number | null;
  sharePct: number | null;
}

export interface YearSummary {
  year: number;
  total: number | null;
  monthsWithData: number;
  isPartial: boolean;
  partialLabel: string | null;
  growthPct: number | null; // vs. Vorjahr, gemeinsame Monate
  bestMonths: { monthIdx: number; label: string; value: number }[]; // Top 3
  worstMonths: { monthIdx: number; label: string; value: number }[]; // Flop 3
  quarters: QuarterProfile[];
}

export interface WaterfallEntry {
  label: string;
  delta: number;
  /** Startwert der kumulierten Wachstumssumme vor diesem Monat */
  cumStart: number;
  cumEnd: number;
  /** Unsichtbarer Sockel für gestapelte recharts-Bars */
  base: number;
  height: number;
  tone: GrowthTone;
  isTotal: boolean;
}

export interface MultiYearChartData {
  /** Linienchart: ein Punkt pro Monat, Werte je Jahr unter Schlüssel `y<Jahr>` */
  line: Array<Record<string, number | string | null>>;
  lineYearKeys: { year: number; key: string }[];
  /** Balken: Jahresumsatz + Wachstum % */
  bars: { year: number; total: number | null; growthPct: number | null; isPartial: boolean }[];
  /** Wasserfall: Vorjahres-Wachstum pro Monat (letztes vs. Vorjahr) */
  waterfall: WaterfallEntry[];
  waterfallYears: { from: number; to: number } | null;
}

export interface MonthDetail {
  monthIdx: number;
  label: string;
  perYear: MonthYearCell[];
  /** Ø Umsatz dieses Monats über alle Jahre mit Wert */
  avgValue: number | null;
  yearsWithValue: number;
}

export interface MultiYearAnalysis {
  /** Ausgewählte Jahre, aufsteigend */
  years: number[];
  baseYear: number | null;
  monthRows: MonthRow[];
  totals: YearTotalCell[];
  kpis: MultiYearKpis;
  yearSummaries: YearSummary[];
  chart: MultiYearChartData;
  executiveSummary: string[];
  limitations: string[];
  hasAnyData: boolean;
}

// ─── Konstanten ───────────────────────────────────────────────────────────────

export const MONTH_LABELS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
export const MONTH_LABELS_LONG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** ±Schwelle in %, innerhalb derer eine Veränderung als "stabil/neutral" gilt */
export const STABLE_THRESHOLD_PCT = 2;

/** Auswahlmöglichkeiten für die Jahresanzahl (5 erscheint erst wenn vorhanden) */
export const YEAR_COUNT_OPTIONS = [2, 3, 5] as const;
export type YearCountOption = (typeof YEAR_COUNT_OPTIONS)[number];

// ─── Format-Helfer (de-CH, deterministisch) ──────────────────────────────────

export function fmtChf(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `CHF ${Math.round(value).toLocaleString('de-CH')}`;
}

export function fmtMio(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `CHF ${(value / 1_000_000).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Mio.`;
}

export function fmtPct(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const s = value.toLocaleString('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${value > 0 ? '+' : ''}${s} %`;
}

export function fmtDeltaChf(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const s = Math.round(Math.abs(value)).toLocaleString('de-CH');
  return `${value < 0 ? '−' : '+'}${s}`;
}

// ─── interne Helfer ───────────────────────────────────────────────────────────

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normalize12(arr: (number | null)[] | undefined): (number | null)[] {
  const out: (number | null)[] = Array(12).fill(null);
  if (!arr) return out;
  for (let i = 0; i < 12; i++) out[i] = num(arr[i]);
  return out;
}

function safeDeltaPct(value: number | null, reference: number | null): number | null {
  if (value == null || reference == null || reference === 0) return null;
  const pct = ((value - reference) / Math.abs(reference)) * 100;
  return Number.isFinite(pct) ? pct : null;
}

function toneFromPct(pct: number | null): GrowthTone {
  if (pct == null) return 'neutral';
  if (pct > STABLE_THRESHOLD_PCT) return 'good';
  if (pct < -STABLE_THRESHOLD_PCT) return 'critical';
  return 'neutral';
}

function monthIndices(revenue: (number | null)[]): number[] {
  const idx: number[] = [];
  for (let i = 0; i < 12; i++) if (revenue[i] != null) idx.push(i);
  return idx;
}

function sumMonths(revenue: (number | null)[], indices: number[]): number | null {
  if (indices.length === 0) return null;
  let total = 0;
  for (const i of indices) total += revenue[i] ?? 0;
  return total;
}

/** "Januar–Juni" für zusammenhängende Datenmonate, sonst "6 Monate" */
export function partialRangeLabel(indices: number[]): string | null {
  if (indices.length === 0 || indices.length === 12) return null;
  const contiguous = indices.every((v, i) => i === 0 || v === indices[i - 1] + 1);
  if (contiguous) {
    if (indices.length === 1) return MONTH_LABELS_LONG[indices[0]];
    return `${MONTH_LABELS_LONG[indices[0]]}–${MONTH_LABELS_LONG[indices[indices.length - 1]]}`;
  }
  return `${indices.length} Monate`;
}

/** Rang pro Jahr: 1 = höchster Umsatz; stabile Sortierung (Gleichstand → früherer Monat) */
function computeRanks(revenue: (number | null)[]): (number | null)[] {
  const entries = monthIndices(revenue).map((i) => ({ i, v: revenue[i] as number }));
  entries.sort((a, b) => (b.v !== a.v ? b.v - a.v : a.i - b.i));
  const ranks: (number | null)[] = Array(12).fill(null);
  entries.forEach((e, pos) => { ranks[e.i] = pos + 1; });
  return ranks;
}

// ─── Jahresauswahl ────────────────────────────────────────────────────────────

/** Filtert leere Jahre heraus und sortiert aufsteigend. */
export function nonEmptyYears(series: YearSeries[]): YearSeries[] {
  return series
    .map((s) => ({ ...s, netRevenue: normalize12(s.netRevenue), personnelPct: normalize12(s.personnelPct), wesPct: normalize12(s.wesPct) }))
    .filter((s) => monthIndices(s.netRevenue).length > 0)
    .sort((a, b) => a.year - b.year);
}

/** Wählt die letzten `count` Jahre mit Daten (aufsteigend zurückgegeben). */
export function selectLastYears(series: YearSeries[], count: number): YearSeries[] {
  const clean = nonEmptyYears(series);
  return clean.slice(Math.max(0, clean.length - count));
}

// ─── Hauptfunktion ────────────────────────────────────────────────────────────

export function buildMultiYearAnalysis(input: YearSeries[]): MultiYearAnalysis {
  const series = nonEmptyYears(input);
  const years = series.map((s) => s.year);
  const limitations: string[] = [];

  if (series.length === 0) {
    return {
      years: [], baseYear: null, monthRows: [], totals: [],
      kpis: emptyKpis(), yearSummaries: [],
      chart: { line: [], lineYearKeys: [], bars: [], waterfall: [], waterfallYears: null },
      executiveSummary: [], limitations: ['Keine Erfolgsrechnungs-Daten vorhanden.'], hasAnyData: false,
    };
  }

  const byYear = new Map<number, YearSeries>(series.map((s) => [s.year, s]));
  const baseYear = years[0];
  const base = byYear.get(baseYear)!;

  const indicesByYear = new Map<number, number[]>(series.map((s) => [s.year, monthIndices(s.netRevenue)]));
  const totalsByYear = new Map<number, number | null>(
    series.map((s) => [s.year, sumMonths(s.netRevenue, indicesByYear.get(s.year)!)]),
  );
  const ranksByYear = new Map<number, (number | null)[]>(series.map((s) => [s.year, computeRanks(s.netRevenue)]));

  // Teiljahre / Lücken als Limitations ausweisen
  for (const s of series) {
    const idx = indicesByYear.get(s.year)!;
    if (idx.length < 12) {
      const label = partialRangeLabel(idx);
      limitations.push(`${s.year} ist ein Teiljahr (${label ?? `${idx.length} Monate`}) — Jahresvergleiche nutzen nur gemeinsame Monate.`);
    }
  }
  for (let i = 1; i < years.length; i++) {
    if (years[i] - years[i - 1] > 1) {
      limitations.push(`Zwischen ${years[i - 1]} und ${years[i]} fehlen Jahre — Δ Vorjahr ist dort nicht verfügbar.`);
    }
  }

  // ── Monatszeilen ──
  const monthRows: MonthRow[] = [];
  for (let m = 0; m < 12; m++) {
    const cells: MonthYearCell[] = series.map((s) => {
      const value = s.netRevenue[m];
      const prev = byYear.get(s.year - 1) ?? null;
      const prevValue = prev ? prev.netRevenue[m] : null;
      const baseValue = s.year !== baseYear ? base.netRevenue[m] : null;
      const total = totalsByYear.get(s.year) ?? null;
      const deltaPrevPct = safeDeltaPct(value, prevValue);
      return {
        year: s.year,
        value,
        vsPrevYear: {
          chf: value != null && prevValue != null ? value - prevValue : null,
          pct: deltaPrevPct,
        },
        vsBaseYear: {
          chf: value != null && baseValue != null ? value - baseValue : null,
          pct: safeDeltaPct(value, baseValue),
        },
        rankInYear: ranksByYear.get(s.year)![m],
        shareOfYearPct: value != null && total != null && total !== 0 ? (value / total) * 100 : null,
        tone: toneFromPct(deltaPrevPct),
        personnelPct: num(s.personnelPct?.[m]),
        wesPct: num(s.wesPct?.[m]),
      };
    });
    monthRows.push({ monthIdx: m, label: MONTH_LABELS_SHORT[m], cells });
  }

  // ── Jahres-Totale (Δ über gemeinsame Monate) ──
  const commonDelta = (a: YearSeries | null, b: YearSeries | null): DeltaValue & { commonMonths: number } => {
    if (!a || !b) return { chf: null, pct: null, commonMonths: 0 };
    const common = monthIndices(a.netRevenue).filter((i) => b.netRevenue[i] != null);
    if (common.length === 0) return { chf: null, pct: null, commonMonths: 0 };
    const sumA = sumMonths(a.netRevenue, common);
    const sumB = sumMonths(b.netRevenue, common);
    if (sumA == null || sumB == null) return { chf: null, pct: null, commonMonths: common.length };
    return { chf: sumA - sumB, pct: safeDeltaPct(sumA, sumB), commonMonths: common.length };
  };

  const totals: YearTotalCell[] = series.map((s) => {
    const idx = indicesByYear.get(s.year)!;
    return {
      year: s.year,
      total: totalsByYear.get(s.year) ?? null,
      monthsWithData: idx.length,
      isPartial: idx.length < 12,
      partialLabel: partialRangeLabel(idx),
      vsPrevYearCommon: commonDelta(s, byYear.get(s.year - 1) ?? null),
      vsBaseYearCommon: s.year === baseYear
        ? { chf: null, pct: null, commonMonths: 0 }
        : commonDelta(s, base),
    };
  });

  // ── KPIs ──
  const latest = series[series.length - 1];
  const latestIdx = indicesByYear.get(latest.year)!;
  const prevOfLatest = byYear.get(latest.year - 1) ?? null;
  const latestTotalCell = totals[totals.length - 1];

  const growth = latestTotalCell.vsPrevYearCommon;

  // CAGR: nur vollständige Jahre
  const fullYears = series.filter((s) => indicesByYear.get(s.year)!.length === 12);
  let cagrPct: number | null = null;
  let cagrFromYear: number | null = null;
  let cagrToYear: number | null = null;
  if (fullYears.length >= 2) {
    const first = fullYears[0];
    const last = fullYears[fullYears.length - 1];
    const firstTotal = totalsByYear.get(first.year);
    const lastTotal = totalsByYear.get(last.year);
    const span = last.year - first.year;
    if (firstTotal != null && firstTotal > 0 && lastTotal != null && lastTotal > 0 && span >= 1) {
      const c = (Math.pow(lastTotal / firstTotal, 1 / span) - 1) * 100;
      if (Number.isFinite(c)) { cagrPct = c; cagrFromYear = first.year; cagrToYear = last.year; }
    }
  }
  if (cagrPct == null && series.length >= 2) {
    limitations.push('CAGR erfordert mindestens zwei vollständige Jahre — nicht berechenbar.');
  }

  // Ø monatliches Vorjahres-Wachstum (letztes vs. Vorjahr)
  let avgMonthlyGrowthPct: number | null = null;
  if (prevOfLatest) {
    const rates: number[] = [];
    for (let m = 0; m < 12; m++) {
      const r = safeDeltaPct(latest.netRevenue[m], prevOfLatest.netRevenue[m]);
      if (r != null) rates.push(r);
    }
    if (rates.length > 0) avgMonthlyGrowthPct = rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  const bestWorst = (s: YearSeries) => {
    const entries = monthIndices(s.netRevenue)
      .map((i) => ({ monthIdx: i, label: MONTH_LABELS_LONG[i], value: s.netRevenue[i] as number }));
    const sorted = [...entries].sort((a, b) => (b.value !== a.value ? b.value - a.value : a.monthIdx - b.monthIdx));
    return { best: sorted[0] ?? null, worst: sorted.length > 0 ? sorted[sorted.length - 1] : null, sorted };
  };
  const bwLatest = bestWorst(latest);

  let highestAnnual: MultiYearKpis['highestAnnual'] = null;
  for (const t of totals) {
    if (t.total != null && (highestAnnual == null || t.total > highestAnnual.total)) {
      highestAnnual = { year: t.year, total: t.total, isPartial: t.isPartial };
    }
  }

  const trend: TrendDirection | null = growth.pct == null
    ? null
    : growth.pct > STABLE_THRESHOLD_PCT ? 'steigend'
    : growth.pct < -STABLE_THRESHOLD_PCT ? 'ruecklaeufig'
    : 'stabil';

  const kpis: MultiYearKpis = {
    latestYear: latest.year,
    latestYearRevenue: latestTotalCell.total,
    latestYearPartialLabel: latestTotalCell.partialLabel,
    prevYear: prevOfLatest?.year ?? null,
    prevYearRevenue: prevOfLatest ? totalsByYear.get(prevOfLatest.year) ?? null : null,
    growthChf: growth.chf,
    growthPct: growth.pct,
    growthCommonMonths: growth.commonMonths,
    cagrPct, cagrFromYear, cagrToYear,
    avgMonthlyGrowthPct,
    bestMonth: bwLatest.best,
    worstMonth: bwLatest.worst,
    highestAnnual,
    trend,
  };

  // ── Jahresanalysen ──
  const yearSummaries: YearSummary[] = series.map((s, i) => {
    const idx = indicesByYear.get(s.year)!;
    const bw = bestWorst(s);
    const total = totalsByYear.get(s.year) ?? null;
    const quarters: QuarterProfile[] = [0, 1, 2, 3].map((q) => {
      const qIdx = [q * 3, q * 3 + 1, q * 3 + 2].filter((m) => idx.includes(m));
      const qTotal = sumMonths(s.netRevenue, qIdx);
      return {
        label: `Q${q + 1}`,
        total: qTotal,
        sharePct: qTotal != null && total != null && total !== 0 ? (qTotal / total) * 100 : null,
      };
    });
    return {
      year: s.year,
      total,
      monthsWithData: idx.length,
      isPartial: idx.length < 12,
      partialLabel: partialRangeLabel(idx),
      growthPct: totals[i].vsPrevYearCommon.pct,
      bestMonths: bw.sorted.slice(0, 3),
      worstMonths: [...bw.sorted].reverse().slice(0, 3),
      quarters,
    };
  });

  // ── Diagrammdaten ──
  const lineYearKeys = series.map((s) => ({ year: s.year, key: `y${s.year}` }));
  const line = MONTH_LABELS_SHORT.map((label, m) => {
    const point: Record<string, number | string | null> = { month: label };
    for (const s of series) point[`y${s.year}`] = s.netRevenue[m];
    return point;
  });
  const bars = totals.map((t) => ({
    year: t.year, total: t.total, growthPct: t.vsPrevYearCommon.pct, isPartial: t.isPartial,
  }));

  const waterfall: WaterfallEntry[] = [];
  let waterfallYears: MultiYearChartData['waterfall'] extends never ? never : { from: number; to: number } | null = null;
  if (prevOfLatest) {
    waterfallYears = { from: prevOfLatest.year, to: latest.year };
    let cum = 0;
    for (let m = 0; m < 12; m++) {
      const a = latest.netRevenue[m];
      const b = prevOfLatest.netRevenue[m];
      if (a == null || b == null) continue;
      const delta = a - b;
      const cumStart = cum;
      cum += delta;
      waterfall.push({
        label: MONTH_LABELS_SHORT[m],
        delta,
        cumStart,
        cumEnd: cum,
        base: Math.min(cumStart, cum),
        height: Math.abs(delta),
        tone: delta > 0 ? 'good' : delta < 0 ? 'critical' : 'neutral',
        isTotal: false,
      });
    }
    if (waterfall.length > 0) {
      waterfall.push({
        label: 'Total', delta: cum, cumStart: 0, cumEnd: cum,
        base: Math.min(0, cum), height: Math.abs(cum),
        tone: cum > 0 ? 'good' : cum < 0 ? 'critical' : 'neutral', isTotal: true,
      });
    }
  }

  // ── Executive Summary (nur eindeutig ableitbare Aussagen) ──
  const executiveSummary = buildExecutiveSummary({
    series, totals, kpis, latestIdx, prevOfLatest, baseYear,
  });

  return {
    years, baseYear, monthRows, totals, kpis, yearSummaries,
    chart: { line, lineYearKeys, bars, waterfall, waterfallYears },
    executiveSummary, limitations, hasAnyData: true,
  };
}

function emptyKpis(): MultiYearKpis {
  return {
    latestYear: null, latestYearRevenue: null, latestYearPartialLabel: null,
    prevYear: null, prevYearRevenue: null,
    growthChf: null, growthPct: null, growthCommonMonths: 0,
    cagrPct: null, cagrFromYear: null, cagrToYear: null,
    avgMonthlyGrowthPct: null,
    bestMonth: null, worstMonth: null, highestAnnual: null, trend: null,
  };
}

// ─── Executive Summary ────────────────────────────────────────────────────────

function buildExecutiveSummary(args: {
  series: YearSeries[];
  totals: YearTotalCell[];
  kpis: MultiYearKpis;
  latestIdx: number[];
  prevOfLatest: YearSeries | null;
  baseYear: number;
}): string[] {
  const { series, totals, kpis, prevOfLatest } = args;
  const lines: string[] = [];
  if (series.length === 0) return lines;

  // Umsatzentwicklung über alle Jahre
  const parts = totals
    .filter((t) => t.total != null)
    .map((t) => `${fmtMio(t.total)} (${t.year}${t.partialLabel ? `, ${t.partialLabel}` : ''})`);
  if (parts.length >= 2) {
    lines.push(`Der Umsatz entwickelte sich von ${parts[0]}${parts.length > 2 ? ` über ${parts.slice(1, -1).join(', ')}` : ''} auf ${parts[parts.length - 1]}.`);
  } else if (parts.length === 1) {
    lines.push(`Es liegen Umsatzdaten für ein Jahr vor: ${parts[0]}.`);
  }

  // Wachstum vs. Vorjahr (gemeinsame Monate) und vs. Basisjahr
  const latestTotal = totals[totals.length - 1];
  if (kpis.growthPct != null && kpis.prevYear != null) {
    const basis = latestTotal.isPartial || (prevOfLatest && totals.find(t => t.year === prevOfLatest.year)?.isPartial)
      ? ` (Vergleich über ${kpis.growthCommonMonths} gemeinsame Monate)` : '';
    let s = `Dies entspricht einem Wachstum von ${fmtPct(kpis.growthPct)} gegenüber ${kpis.prevYear}${basis}`;
    const vsBase = latestTotal.vsBaseYearCommon;
    if (vsBase.pct != null && args.baseYear !== kpis.prevYear) {
      s += ` und ${fmtPct(vsBase.pct)} gegenüber ${args.baseYear}`;
    }
    lines.push(`${s}.`);
  }

  // Monate über Vorjahresniveau (nur belegbare Aussagen)
  if (prevOfLatest) {
    const latest = series[series.length - 1];
    let common = 0;
    let above = 0;
    for (let m = 0; m < 12; m++) {
      const a = latest.netRevenue[m];
      const b = prevOfLatest.netRevenue[m];
      if (a == null || b == null) continue;
      common++;
      if (a > b) above++;
    }
    if (common > 0) {
      if (above === common) {
        lines.push(`Sämtliche ${common} vergleichbaren Monate liegen über dem Vorjahresniveau, was auf ein nachhaltiges operatives Wachstum hindeutet.`);
      } else {
        lines.push(`${above} von ${common} vergleichbaren Monaten liegen über dem Vorjahresniveau.`);
      }
    }
  }

  // CAGR
  if (kpis.cagrPct != null && kpis.cagrFromYear != null && kpis.cagrToYear != null) {
    lines.push(`Das durchschnittliche jährliche Wachstum (CAGR ${kpis.cagrFromYear}–${kpis.cagrToYear}) beträgt ${fmtPct(kpis.cagrPct)}.`);
  }

  return lines;
}

// ─── Monats-Detail ────────────────────────────────────────────────────────────

export function buildMonthDetail(analysis: MultiYearAnalysis, monthIdx: number): MonthDetail | null {
  if (monthIdx < 0 || monthIdx > 11) return null;
  const row = analysis.monthRows[monthIdx];
  if (!row) return null;
  const values = row.cells.map((c) => c.value).filter((v): v is number => v != null);
  return {
    monthIdx,
    label: MONTH_LABELS_LONG[monthIdx],
    perYear: row.cells,
    avgValue: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null,
    yearsWithValue: values.length,
  };
}
