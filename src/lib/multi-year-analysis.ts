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
  /** Wert der analysierten ER-Position pro Monat, Index 0 = Januar. null = kein Wert erfasst. */
  values: (number | null)[];
  /**
   * Optional: Monatswerte weiterer ER-Positionen (Key = Position-ID aus
   * MULTI_YEAR_POSITIONS). Erlaubt den Positionswechsel ohne Neuladen.
   */
  byPosition?: Record<string, (number | null)[]>;
  /** Optional: Personalquote (% vom Umsatz) pro Monat, aus der P&L abgeleitet. */
  personnelPct?: (number | null)[];
  /** Optional: Wareneinsatzquote (% vom Umsatz) pro Monat. */
  wesPct?: (number | null)[];
}

// ─── ER-Positionen (Semantik steuert Ton & Wortwahl, §9 der Spezifikation) ────

/**
 * revenue = Ertrag (mehr ist gut), expense = Aufwand (KEINE pauschale
 * Grün-/Rot-Logik — Veränderungen neutral darstellen), result = Ergebnisstufe
 * (mehr ist gut).
 */
export type PositionSemantics = 'revenue' | 'expense' | 'result';

export interface MultiYearPosition {
  /** Row-ID aus der P&L-Engine (pl-engine.ts) */
  id: string;
  label: string;
  /** "Der Umsatz" / "Das EBITDA" — grammatikalisch korrektes Subjekt für die Summary */
  summarySubject: string;
  semantics: PositionSemantics;
}

export const MULTI_YEAR_POSITIONS: MultiYearPosition[] = [
  { id: 'net_revenue', label: 'Umsatz (netto)', summarySubject: 'Der Umsatz', semantics: 'revenue' },
  { id: 'total_cogs_direct', label: 'Direkter Warenaufwand', summarySubject: 'Der direkte Warenaufwand', semantics: 'expense' },
  { id: 'total_cogs_uebrig', label: 'Übriger Warenaufwand', summarySubject: 'Der übrige Warenaufwand', semantics: 'expense' },
  { id: 'total_cogs', label: 'Warenaufwand', summarySubject: 'Der Warenaufwand', semantics: 'expense' },
  { id: 'gross_profit_1', label: 'Bruttogewinn 1', summarySubject: 'Der Bruttogewinn 1', semantics: 'result' },
  { id: 'total_personnel', label: 'Personalaufwand', summarySubject: 'Der Personalaufwand', semantics: 'expense' },
  { id: 'total_opex', label: 'Übriger Betriebsaufwand', summarySubject: 'Der übrige Betriebsaufwand', semantics: 'expense' },
  { id: 'ebitda', label: 'EBITDA', summarySubject: 'Das EBITDA', semantics: 'result' },
  { id: 'ebit', label: 'EBIT', summarySubject: 'Das EBIT', semantics: 'result' },
];

export const DEFAULT_POSITION: MultiYearPosition = MULTI_YEAR_POSITIONS[0];

export interface MultiYearOptions {
  position?: MultiYearPosition;
}

// ─── Datenqualität (§16: Schweregrade Hinweis / Warnung / Fehler) ─────────────

export type DataQualitySeverity = 'hinweis' | 'warnung' | 'fehler';

export interface DataQualityItem {
  severity: DataQualitySeverity;
  text: string;
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
  latestYearValue: number | null;
  latestYearPartialLabel: string | null;
  prevYear: number | null;
  prevYearValue: number | null;
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
  /** Analysierte ER-Position (Semantik steuert Ton & Wortwahl) */
  position: MultiYearPosition;
  /** Ausgewählte Jahre, aufsteigend */
  years: number[];
  baseYear: number | null;
  monthRows: MonthRow[];
  totals: YearTotalCell[];
  kpis: MultiYearKpis;
  yearSummaries: YearSummary[];
  chart: MultiYearChartData;
  executiveSummary: string[];
  /** Datenqualität mit Schweregraden (Fehler nie stillschweigend ignorieren) */
  dataQuality: DataQualityItem[];
  /** Nur die Texte aus dataQuality (Rückwärtskompatibilität) */
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

/** Explizite Jahresauswahl: mindestens 2, höchstens 5 Jahre (§6) */
export const MIN_YEAR_SELECTION = 2;
export const MAX_YEAR_SELECTION = 5;

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

/**
 * Ton einer Veränderung abhängig von der Positions-Semantik (§9):
 * Aufwandpositionen bekommen KEINE pauschale Grün-/Rot-Färbung — dort bleibt
 * der Ton neutral (Vorzeichen/Pfeile tragen die Information).
 */
export function toneForDeltaPct(pct: number | null, semantics: PositionSemantics): GrowthTone {
  if (semantics === 'expense') return 'neutral';
  return toneFromPct(pct);
}

/** Ton der Trendrichtung abhängig von der Semantik (steigend ist bei Aufwand nicht automatisch gut). */
export function toneForTrend(trend: TrendDirection | null, semantics: PositionSemantics): GrowthTone {
  if (trend == null || semantics === 'expense') return 'neutral';
  if (trend === 'steigend') return 'good';
  if (trend === 'ruecklaeufig') return 'critical';
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

/** Filtert leere Jahre heraus, entfernt Jahres-Dubletten (erste gewinnt) und sortiert aufsteigend. */
export function nonEmptyYears(series: YearSeries[]): YearSeries[] {
  const seen = new Set<number>();
  const unique: YearSeries[] = [];
  for (const s of series) {
    if (seen.has(s.year)) continue;
    seen.add(s.year);
    unique.push(s);
  }
  return unique
    .map((s) => ({ ...s, values: normalize12(s.values), personnelPct: normalize12(s.personnelPct), wesPct: normalize12(s.wesPct) }))
    .filter((s) => monthIndices(s.values).length > 0)
    .sort((a, b) => a.year - b.year);
}

/**
 * Jahre mit IRGENDWELCHEN Daten (Umsatz ODER byPosition-Zeilen), aufsteigend.
 * Für die Jahresauswahl-Basis: ein reines Kosten-Jahr (Jahres-Kontoblatt ohne
 * Umsatzdaten) muss wählbar bleiben — nonEmptyYears würde es verschlucken.
 */
export function yearsWithAnyData(series: YearSeries[]): number[] {
  const seen = new Set<number>();
  const years: number[] = [];
  for (const s of series) {
    if (seen.has(s.year)) continue;
    seen.add(s.year);
    const hasAny =
      s.values.some((v) => v != null) ||
      Object.values(s.byPosition ?? {}).some((row) => (row ?? []).some((v) => v != null));
    if (hasAny) years.push(s.year);
  }
  return years.sort((a, b) => a - b);
}

/** Wählt die letzten `count` Jahre mit Daten (aufsteigend zurückgegeben). */
export function selectLastYears(series: YearSeries[], count: number): YearSeries[] {
  const clean = nonEmptyYears(series);
  return clean.slice(Math.max(0, clean.length - count));
}

/**
 * Explizite Jahresauswahl (§6): behält nur die gewählten Jahre, chronologisch
 * sortiert, auf MAX_YEAR_SELECTION begrenzt (die neuesten gewinnen).
 * Das älteste verbleibende Jahr ist das Basisjahr.
 */
export function selectYears(series: YearSeries[], years: number[]): YearSeries[] {
  const wanted = new Set(years);
  const clean = nonEmptyYears(series).filter((s) => wanted.has(s.year));
  return clean.slice(Math.max(0, clean.length - MAX_YEAR_SELECTION));
}

/**
 * Liefert die Serie für eine ER-Position (§9): Default-Position nutzt `values`,
 * andere Positionen ziehen ihre Monatswerte aus `byPosition`.
 */
export function seriesForPosition(series: YearSeries[], positionId: string): YearSeries[] {
  if (positionId === DEFAULT_POSITION.id) return series;
  return series.map((s) => ({ ...s, values: normalize12(s.byPosition?.[positionId]) }));
}

/** Jahres-Totale aller ER-Positionen (Excel Tab «ER-Positionen», §15). */
export function buildPositionsOverview(
  series: YearSeries[],
  years: number[],
): { position: MultiYearPosition; totals: YearTotalCell[] }[] {
  return MULTI_YEAR_POSITIONS
    .map((p) => {
      const a = buildMultiYearAnalysis(selectYears(seriesForPosition(series, p.id), years), { position: p });
      return a.hasAnyData ? { position: p, totals: a.totals } : null;
    })
    .filter((e): e is { position: MultiYearPosition; totals: YearTotalCell[] } => e != null);
}

// ─── Hauptfunktion ────────────────────────────────────────────────────────────

export function buildMultiYearAnalysis(input: YearSeries[], opts?: MultiYearOptions): MultiYearAnalysis {
  const position = opts?.position ?? DEFAULT_POSITION;
  const semantics = position.semantics;
  const dataQuality: DataQualityItem[] = [];
  const addDq = (severity: DataQualitySeverity, text: string) => { dataQuality.push({ severity, text }); };

  const series = nonEmptyYears(input);
  const years = series.map((s) => s.year);

  if (series.length === 0) {
    const emptyDq: DataQualityItem[] = [{ severity: 'fehler', text: 'Keine Erfolgsrechnungs-Daten vorhanden.' }];
    return {
      position, years: [], baseYear: null, monthRows: [], totals: [],
      kpis: emptyKpis(), yearSummaries: [],
      chart: { line: [], lineYearKeys: [], bars: [], waterfall: [], waterfallYears: null },
      executiveSummary: [], dataQuality: emptyDq,
      limitations: emptyDq.map((d) => d.text), hasAnyData: false,
    };
  }

  // Jahres-Dubletten im Input (nonEmptyYears behält die erste Reihe)
  const seenInput = new Set<number>();
  for (const s of input) {
    if (seenInput.has(s.year)) {
      addDq('fehler', `Jahr ${s.year} ist mehrfach vorhanden — es wird nur die erste Datenreihe verwendet.`);
    }
    seenInput.add(s.year);
  }
  if (series.length === 1) {
    addDq('warnung', 'Nur ein Jahr mit Daten vorhanden — Vergleiche und Wachstumskennzahlen sind nicht verfügbar.');
  }

  const byYear = new Map<number, YearSeries>(series.map((s) => [s.year, s]));
  const baseYear = years[0];
  const base = byYear.get(baseYear)!;

  const indicesByYear = new Map<number, number[]>(series.map((s) => [s.year, monthIndices(s.values)]));
  const totalsByYear = new Map<number, number | null>(
    series.map((s) => [s.year, sumMonths(s.values, indicesByYear.get(s.year)!)]),
  );
  const ranksByYear = new Map<number, (number | null)[]>(series.map((s) => [s.year, computeRanks(s.values)]));

  // Teiljahre / Lücken als Datenqualität ausweisen
  // (zusammenhängendes YTD-Teiljahr = Hinweis; Lücken mitten im Jahr = Warnung)
  for (const s of series) {
    const idx = indicesByYear.get(s.year)!;
    if (idx.length < 12) {
      const label = partialRangeLabel(idx);
      const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
      addDq(contiguous ? 'hinweis' : 'warnung',
        `${s.year} ist ein Teiljahr (${label ?? `${idx.length} Monate`}) — Jahresvergleiche nutzen nur gemeinsame Monate.`);
    }
  }
  for (let i = 1; i < years.length; i++) {
    if (years[i] - years[i - 1] > 1) {
      addDq('warnung', `Zwischen ${years[i - 1]} und ${years[i]} fehlen Jahre — Δ Vorjahr ist dort nicht verfügbar.`);
    }
  }

  // ── Monatszeilen ──
  const zeroRefMonths = new Set<string>();
  const nonPositiveTotalYears = new Set<number>();
  const monthRows: MonthRow[] = [];
  for (let m = 0; m < 12; m++) {
    const cells: MonthYearCell[] = series.map((s) => {
      const value = s.values[m];
      const prev = byYear.get(s.year - 1) ?? null;
      const prevValue = prev ? prev.values[m] : null;
      const baseValue = s.year !== baseYear ? base.values[m] : null;
      const total = totalsByYear.get(s.year) ?? null;
      const deltaPrevPct = safeDeltaPct(value, prevValue);
      if (value != null && prevValue === 0) zeroRefMonths.add(`${MONTH_LABELS_SHORT[m]} ${s.year}`);
      // Anteil nur bei positiver Jahressumme ausweisbar (Ergebnispositionen können negativ sein)
      if (value != null && total != null && total <= 0) nonPositiveTotalYears.add(s.year);
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
        shareOfYearPct: value != null && total != null && total > 0 ? (value / total) * 100 : null,
        tone: toneForDeltaPct(deltaPrevPct, semantics),
        personnelPct: num(s.personnelPct?.[m]),
        wesPct: num(s.wesPct?.[m]),
      };
    });
    monthRows.push({ monthIdx: m, label: MONTH_LABELS_SHORT[m], cells });
  }
  if (zeroRefMonths.size > 0) {
    addDq('hinweis', `Vorjahreswert 0 in ${zeroRefMonths.size} Monat(en) (${[...zeroRefMonths].slice(0, 3).join(', ')}${zeroRefMonths.size > 3 ? ', …' : ''}) — prozentuale Veränderung dort nicht berechenbar.`);
  }
  if (nonPositiveTotalYears.size > 0) {
    addDq('hinweis', `Jahressumme ${[...nonPositiveTotalYears].sort().join(', ')} ist nicht positiv — Monatsanteile am Jahreswert sind dort nicht ausweisbar.`);
  }

  // ── Jahres-Totale (Δ über gemeinsame Monate) ──
  const commonDelta = (a: YearSeries | null, b: YearSeries | null): DeltaValue & { commonMonths: number } => {
    if (!a || !b) return { chf: null, pct: null, commonMonths: 0 };
    const common = monthIndices(a.values).filter((i) => b.values[i] != null);
    if (common.length === 0) return { chf: null, pct: null, commonMonths: 0 };
    const sumA = sumMonths(a.values, common);
    const sumB = sumMonths(b.values, common);
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
    addDq('hinweis', 'CAGR erfordert mindestens zwei vollständige Jahre mit positiven Endwerten — nicht berechenbar.');
  }

  // Ø monatliches Vorjahres-Wachstum (letztes vs. Vorjahr)
  let avgMonthlyGrowthPct: number | null = null;
  if (prevOfLatest) {
    const rates: number[] = [];
    for (let m = 0; m < 12; m++) {
      const r = safeDeltaPct(latest.values[m], prevOfLatest.values[m]);
      if (r != null) rates.push(r);
    }
    if (rates.length > 0) avgMonthlyGrowthPct = rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  const bestWorst = (s: YearSeries) => {
    const entries = monthIndices(s.values)
      .map((i) => ({ monthIdx: i, label: MONTH_LABELS_LONG[i], value: s.values[i] as number }));
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
    latestYearValue: latestTotalCell.total,
    latestYearPartialLabel: latestTotalCell.partialLabel,
    prevYear: prevOfLatest?.year ?? null,
    prevYearValue: prevOfLatest ? totalsByYear.get(prevOfLatest.year) ?? null : null,
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
      const qTotal = sumMonths(s.values, qIdx);
      return {
        label: `Q${q + 1}`,
        total: qTotal,
        sharePct: qTotal != null && total != null && total > 0 ? (qTotal / total) * 100 : null,
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
    for (const s of series) point[`y${s.year}`] = s.values[m];
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
      const a = latest.values[m];
      const b = prevOfLatest.values[m];
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
        tone: semantics === 'expense' ? 'neutral' : delta > 0 ? 'good' : delta < 0 ? 'critical' : 'neutral',
        isTotal: false,
      });
    }
    if (waterfall.length > 0) {
      waterfall.push({
        label: 'Total', delta: cum, cumStart: 0, cumEnd: cum,
        base: Math.min(0, cum), height: Math.abs(cum),
        tone: semantics === 'expense' ? 'neutral' : cum > 0 ? 'good' : cum < 0 ? 'critical' : 'neutral',
        isTotal: true,
      });
    }
  }

  // ── Executive Summary (nur eindeutig ableitbare Aussagen) ──
  const executiveSummary = buildExecutiveSummary({
    series, totals, kpis, latestIdx, prevOfLatest, baseYear, position,
  });

  return {
    position, years, baseYear, monthRows, totals, kpis, yearSummaries,
    chart: { line, lineYearKeys, bars, waterfall, waterfallYears },
    executiveSummary, dataQuality,
    limitations: dataQuality.map((d) => d.text), hasAnyData: true,
  };
}

function emptyKpis(): MultiYearKpis {
  return {
    latestYear: null, latestYearValue: null, latestYearPartialLabel: null,
    prevYear: null, prevYearValue: null,
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
  position: MultiYearPosition;
}): string[] {
  const { series, totals, kpis, prevOfLatest, position } = args;
  const isExpense = position.semantics === 'expense';
  const lines: string[] = [];
  if (series.length === 0) return lines;

  // Entwicklung der Position über alle Jahre
  const parts = totals
    .filter((t) => t.total != null)
    .map((t) => `${fmtMio(t.total)} (${t.year}${t.partialLabel ? `, ${t.partialLabel}` : ''})`);
  if (parts.length >= 2) {
    lines.push(`${position.summarySubject} entwickelte sich von ${parts[0]}${parts.length > 2 ? ` über ${parts.slice(1, -1).join(', ')}` : ''} auf ${parts[parts.length - 1]}.`);
  } else if (parts.length === 1) {
    lines.push(`Es liegen ${position.semantics === 'revenue' ? 'Umsatzdaten' : `Daten zu «${position.label}»`} für ein Jahr vor: ${parts[0]}.`);
  }

  // Wachstum vs. Vorjahr (gemeinsame Monate) und vs. Basisjahr
  const latestTotal = totals[totals.length - 1];
  if (kpis.growthPct != null && kpis.prevYear != null) {
    const basis = latestTotal.isPartial || (prevOfLatest && totals.find(t => t.year === prevOfLatest.year)?.isPartial)
      ? ` (Vergleich über ${kpis.growthCommonMonths} gemeinsame Monate)` : '';
    let s = `Dies entspricht ${isExpense ? 'einer Veränderung' : 'einem Wachstum'} von ${fmtPct(kpis.growthPct)} gegenüber ${kpis.prevYear}${basis}`;
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
      const a = latest.values[m];
      const b = prevOfLatest.values[m];
      if (a == null || b == null) continue;
      common++;
      if (a > b) above++;
    }
    if (common > 0) {
      if (above === common) {
        lines.push(isExpense
          ? `Sämtliche ${common} vergleichbaren Monate liegen über dem Vorjahreswert.`
          : `Sämtliche ${common} vergleichbaren Monate liegen über dem Vorjahresniveau, was auf ein nachhaltiges operatives Wachstum hindeutet.`);
      } else {
        lines.push(`${above} von ${common} vergleichbaren Monaten liegen über dem Vorjahresniveau.`);
      }
    }
  }

  // CAGR
  if (kpis.cagrPct != null && kpis.cagrFromYear != null && kpis.cagrToYear != null) {
    lines.push(isExpense
      ? `Die durchschnittliche jährliche Veränderung (CAGR ${kpis.cagrFromYear}–${kpis.cagrToYear}) beträgt ${fmtPct(kpis.cagrPct)}.`
      : `Das durchschnittliche jährliche Wachstum (CAGR ${kpis.cagrFromYear}–${kpis.cagrToYear}) beträgt ${fmtPct(kpis.cagrPct)}.`);
  }

  return lines;
}

// ─── Methodik (§13/§14: Management Report, PDF, Excel) ───────────────────────

/**
 * Nachvollziehbare Methodik-Hinweise für Report-Ansicht und Exporte.
 * Statische Regeln + optionale Datenquellen-Hinweise des Aufrufers.
 */
export function buildMethodikNotes(opts?: { dataSourceHints?: string[] }): string[] {
  return [
    'Vergleiche bei Teiljahren erfolgen ausschliesslich über gemeinsame Datenmonate der beteiligten Jahre (YTD-Prinzip).',
    'Basisjahr ist das älteste ausgewählte Jahr; das neueste ausgewählte Jahr ist das aktuelle Vergleichsjahr.',
    'CAGR wird nur über vollständige Jahre (12 Datenmonate) mit positiven Endwerten berechnet.',
    'Jahreswerte sind stets Summen der erfassten Monatswerte; separate gespeicherte Jahrestotale existieren im System nicht (eine Total-Abstimmung entfällt daher).',
    'Zwischenberechnungen werden nicht gerundet; die Rundung (CHF ganzzahlig, Prozent mit einer Dezimalstelle) erfolgt erst bei der Darstellung.',
    'Fehlende Monatswerte werden als «—» ausgewiesen und nie geschätzt oder mit 0 ersetzt.',
    ...(opts?.dataSourceHints ?? []),
  ];
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

// ─── Jahresvergleich (KPI × Jahre) + Personalkosten-Analyse (§5–§8) ──────────
//
// EINE Vergleichsbasis für die ganze Tabelle: die Schnittmenge der Datenmonate
// ALLER ausgewählten Jahre („Vergleich bis gleicher Monat", keine Hochrechnung).
// Paarweise Common-Months würden je Jahr mehrere widersprüchliche Werte erzeugen
// und die Δ-Kette (Δ25−24 + Δ26−25 = Δ26−24) bräche — bewusster Trade-off.
// Fehlend ≠ 0: ist ein Zeilenwert in einem Vergleichsmonat null, wird der
// Jahreswert der Zeile null (nie still untersummiert) + Datenqualitätshinweis.

export type ComparisonBetterWhen = 'up' | 'down' | 'neutral';

export interface YearComparisonRowDef {
  /** P&L-Zeilen-ID (pl-engine) bzw. abgeleitete Quote-ID */
  id: string;
  label: string;
  kind: 'chf' | 'quote';
  /** Farb-Richtung: up=mehr ist gut, down=weniger ist gut, neutral=Aufwand (§9-Regel) */
  betterWhen: ComparisonBetterWhen;
  /** Nur Quoten: Zähler/Nenner-Zeilen-IDs */
  quoteOf?: { numerator: string; denominator: string };
}

/** Kennzahlen-Set des Jahresvergleichs (§5) — endet bei EBIT, kein Jahresgewinn (§6-Entscheid). */
export const YEAR_COMPARISON_ROWS: YearComparisonRowDef[] = [
  { id: 'net_revenue', label: 'Umsatz (netto)', kind: 'chf', betterWhen: 'up' },
  { id: 'total_cogs', label: 'Warenaufwand', kind: 'chf', betterWhen: 'neutral' },
  { id: 'gross_profit_1', label: 'Bruttogewinn 1', kind: 'chf', betterWhen: 'up' },
  { id: 'total_personnel', label: 'Personalaufwand', kind: 'chf', betterWhen: 'neutral' },
  { id: 'personnel_quote', label: 'Personalquote', kind: 'quote', betterWhen: 'down', quoteOf: { numerator: 'total_personnel', denominator: 'net_revenue' } },
  { id: 'ebitda', label: 'EBITDA', kind: 'chf', betterWhen: 'up' },
  { id: 'ebit', label: 'EBIT', kind: 'chf', betterWhen: 'up' },
  { id: 'ebit_margin', label: 'EBIT-Marge', kind: 'quote', betterWhen: 'up', quoteOf: { numerator: 'ebit', denominator: 'net_revenue' } },
];

export interface YearComparisonDelta {
  fromYear: number;
  toYear: number;
  /** CHF-Differenz (bei Quoten null) */
  chf: number | null;
  /** Veränderung in % — (neu − alt) / |alt|, Basis 0/fehlend → null (EBIT kann negativ sein) */
  pct: number | null;
  /** Veränderung in Prozentpunkten (nur Quoten) */
  pp: number | null;
}

export interface YearComparisonRow {
  def: YearComparisonRowDef;
  /** Wert je Jahr (Reihenfolge = years) über die gemeinsamen Monate; fehlend = null */
  valueByYear: (number | null)[];
  /** Δ je konsekutivem Jahrespaar (years.length − 1 Einträge) */
  deltas: YearComparisonDelta[];
  /** Δ erstes → letztes Jahr (nur bei ≥3 Jahren, sonst null) */
  firstToLast: YearComparisonDelta | null;
}

/** Vergleichsmodus: Schnittmenge («bis gleicher Monat») oder Ganzjahressummen. */
export type YearComparisonMode = 'commonMonth' | 'fullYear';

export interface YearKpiComparisonOptions {
  /** Default 'commonMonth' (bisheriges Verhalten: Schnittmenge aller Jahre) */
  mode?: YearComparisonMode;
  /**
   * Nur mode='commonMonth': Vergleich zusätzlich auf Monate ≤ throughMonth
   * (1–12) begrenzen. undefined/null = automatisch: alle gemeinsamen Monate,
   * die vollständig in der Vergangenheit liegen (laufender Monat ist
   * unvollständig und würde den Vergleich verzerren — «fehlend ≠ 0»).
   */
  throughMonth?: number | null;
  /** Referenzdatum für die Laufender-Monat-Erkennung (Default: heute; für Tests). */
  today?: Date;
}

export interface YearKpiComparison {
  /** Verwendeter Vergleichsmodus */
  mode: YearComparisonMode;
  /** Ausgewählte Jahre, aufsteigend — auch Jahre OHNE Daten (sichtbare «—»-Spalten) */
  years: number[];
  /** Gewählte Jahre ohne jegliche ER-Daten — werden als «—»-Spalte gezeigt, nie gedroppt */
  emptyYears: number[];
  /** Fussnote zur Kennzeichnung leerer Jahre («† keine Daten»); null wenn keine */
  emptyNote: string | null;
  /**
   * Effektiv angewendeter «Vergleich bis»-Monat (1–12) im commonMonth-Modus —
   * explizit gewählt ODER Standard (letzter voll vergangener gemeinsamer Monat).
   * UI und Exporte zeigen DENSELBEN Wert. null im fullYear-Modus / ohne Basis.
   */
  appliedThroughMonth: number | null;
  /**
   * Datenmonats-Indizes der Vergleichsbasis: commonMonth = gemeinsame Monate
   * (ggf. auf throughMonth begrenzt); fullYear = Vereinigung der Datenmonate.
   */
  commonMonths: number[];
  /** Gemeinsame Monate OHNE throughMonth-Begrenzung (Basis des Monats-Selectors) */
  availableCommonMonths: number[];
  /** "Januar–Juni" bzw. null bei vollem Jahr / keiner Schnittmenge */
  commonMonthsLabel: string | null;
  /** true = alle Jahre haben 12 Datenmonate (echte Ganzjahressummen) */
  isFullYears: boolean;
  /** Jahre mit weniger als 12 Datenmonaten (sichtbare Teiljahr-Kennzeichnung) */
  partialYears: number[];
  /**
   * Zentrale Fussnote zur Teiljahr-Kennzeichnung («* Teiljahr — …»), identisch
   * in UI, Excel und PDF; null wenn keine Teiljahre vorhanden sind.
   */
  partialNote: string | null;
  rows: YearComparisonRow[];
  dataQuality: DataQualityItem[];
  hasAnyData: boolean;
}

/** Monatswerte einer P&L-Zeile aus einer YearSeries (values = net_revenue-Fallback). */
function rowMonthValues(s: YearSeries, rowId: string): (number | null)[] {
  const fromByPosition = s.byPosition?.[rowId];
  if (fromByPosition) return normalize12(fromByPosition);
  if (rowId === DEFAULT_POSITION.id) return normalize12(s.values);
  return Array(12).fill(null);
}

/**
 * Jahresauswahl für den Vergleich — bewusst NICHT nonEmptyYears: das filtert
 * nach Umsatzmonaten und würde ein reines Kosten-Jahr (Jahres-Kontoblatt ohne
 * Umsatzdaten) still verschwinden lassen. Hier zählt jede Vergleichszeile.
 */
function dedupeComparisonYears(series: YearSeries[], wanted: Set<number>): YearSeries[] {
  const seen = new Set<number>();
  const clean: YearSeries[] = [];
  for (const s of series) {
    if (!wanted.has(s.year) || seen.has(s.year)) continue;
    seen.add(s.year);
    clean.push({ ...s, values: normalize12(s.values) });
  }
  // Gewählte Jahre OHNE Serie (z. B. Vorvorjahr vor dem Import) als leere
  // «—»-Spalte synthetisieren — nie still droppen (fehlend ≠ 0).
  for (const y of wanted) {
    if (!seen.has(y)) clean.push({ year: y, values: Array(12).fill(null), byPosition: {} });
  }
  return clean.sort((a, b) => a.year - b.year);
}

function comparisonDelta(
  def: YearComparisonRowDef,
  fromYear: number, toYear: number,
  from: number | null, to: number | null,
): YearComparisonDelta {
  if (def.kind === 'quote') {
    return {
      fromYear, toYear, chf: null, pct: null,
      pp: from != null && to != null ? to - from : null,
    };
  }
  return {
    fromYear, toYear,
    chf: from != null && to != null ? to - from : null,
    pct: safeDeltaPct(to, from),
    pp: null,
  };
}

/**
 * Jahresvergleichs-Tabelle (§5/§6): Kennzahlen × Jahre + Δ je Jahrespaar.
 * `series` = Roh-Serien mit byPosition (PLView), `years` = gewählte Jahre.
 *
 * Vergleichsmodi (opts.mode):
 *   'commonMonth' (Default) — EINE Vergleichsbasis: Schnittmenge der Daten-
 *     monate ALLER Jahre («bis gleicher Monat»), optional zusätzlich auf
 *     Monate ≤ opts.throughMonth begrenzt. Keine Hochrechnung.
 *   'fullYear' — je Jahr die Summe über die EIGENEN Datenmonate (Ganzjahr).
 *     Teiljahre bleiben sichtbar markiert; bei ungleicher Abdeckung warnt ein
 *     Datenqualitätshinweis (Summen nicht direkt vergleichbar). Keine Hochrechnung.
 */
export function buildYearKpiComparison(
  series: YearSeries[],
  years: number[],
  opts: YearKpiComparisonOptions = {},
): YearKpiComparison {
  const mode: YearComparisonMode = opts.mode ?? 'commonMonth';
  const dataQuality: DataQualityItem[] = [];
  const wanted = new Set(years);
  const chfRowIds = YEAR_COMPARISON_ROWS.filter((r) => r.kind === 'chf').map((r) => r.id);

  // Datenmonate je Jahr = Monate, in denen MINDESTENS eine Vergleichszeile
  // einen Wert hat (reine Kosten-Monate aus dem Jahres-Kontoblatt zählen mit).
  // Jahre OHNE Daten bleiben als sichtbare «—»-Spalte erhalten (nie droppen),
  // werden aber von der Schnittmengen-Berechnung ausgeschlossen.
  const dataMonthsByYear = new Map<number, number[]>();
  const clean = dedupeComparisonYears(series, wanted);
  for (const s of clean) {
    const idx: number[] = [];
    for (let m = 0; m < 12; m++) {
      if (chfRowIds.some((id) => rowMonthValues(s, id)[m] != null)) idx.push(m);
    }
    if (idx.length === 0) {
      dataQuality.push({
        severity: 'warnung',
        text: `${s.year}: keine Erfolgsrechnungs-Daten vorhanden — das Jahr wird mit «—» angezeigt. Jahresdaten importieren (z. B. Jahres-Kontoblatt ${s.year}), damit es vergleichbar wird.`,
      });
    } else {
      dataMonthsByYear.set(s.year, idx);
    }
  }
  const selYears = clean.map((s) => s.year);
  const emptyYears = selYears.filter((y) => !dataMonthsByYear.has(y));
  const dataYears = selYears.filter((y) => dataMonthsByYear.has(y));
  const emptyNote = emptyYears.length > 0
    ? `† ${emptyYears.join(', ')}: keine Erfolgsrechnungs-Daten vorhanden — Werte werden als «—» angezeigt, keine Schätzung.`
    : null;

  const empty: YearKpiComparison = {
    mode, years: selYears, emptyYears, emptyNote, appliedThroughMonth: null,
    commonMonths: [], availableCommonMonths: [],
    commonMonthsLabel: null, isFullYears: false, partialYears: [],
    partialNote: null, rows: [], dataQuality, hasAnyData: false,
  };
  if (dataYears.length === 0) {
    dataQuality.push({ severity: 'fehler', text: 'Keine Erfolgsrechnungs-Daten für den Jahresvergleich vorhanden.' });
    return empty;
  }

  // Schnittmenge über alle Jahre MIT Daten (auch im Ganzjahresmodus als Selector-Basis)
  let intersect: number[] = dataMonthsByYear.get(dataYears[0]) ?? [];
  for (const y of dataYears.slice(1)) {
    const set = new Set(dataMonthsByYear.get(y) ?? []);
    intersect = intersect.filter((m) => set.has(m));
  }
  const availableCommonMonths = intersect;

  const partialYears = dataYears.filter((y) => (dataMonthsByYear.get(y) ?? []).length < 12);
  const isFullYears = partialYears.length === 0 && emptyYears.length === 0;

  // Vergleichsbasis je Modus
  let common: number[];
  if (mode === 'fullYear') {
    // Ganzjahr: Vereinigung aller Datenmonate (nur für Anzeige/Label) —
    // summiert wird je Jahr über die EIGENEN Datenmonate (s. chfValue).
    const union = new Set<number>();
    for (const y of dataYears) for (const m of dataMonthsByYear.get(y) ?? []) union.add(m);
    common = Array.from(union).sort((a, b) => a - b);
  } else {
    const tm = opts.throughMonth;
    if (tm != null && tm >= 1 && tm <= 12) {
      common = intersect.filter((m) => m < tm); // Monats-Indizes 0-basiert: m ≤ tm−1
    } else {
      // Standard: nur gemeinsame Monate, die vollständig in der Vergangenheit
      // liegen — der laufende Kalendermonat ist unvollständig und würde den
      // Vergleich verzerren (Teilmonats-Umsatz, fehlende Kosten → «—»-Kaskade).
      const today = opts.today ?? new Date();
      const curY = today.getFullYear();
      const curM = today.getMonth();
      const notFullyPast = (m: number): boolean =>
        dataYears.some((y) => y > curY || (y === curY && m >= curM));
      const fullyPast = intersect.filter((m) => !notFullyPast(m));
      if (fullyPast.length > 0) {
        if (fullyPast.length < intersect.length) {
          const lastIdx = fullyPast[fullyPast.length - 1];
          dataQuality.push({
            severity: 'hinweis',
            text: `Der laufende Monat ist noch unvollständig und wird im Standardvergleich nicht mitgezählt — die Vergleichsbasis endet bei ${MONTH_LABELS_LONG[lastIdx]}. Bei Bedarf über «Vergleich bis» erweiterbar.`,
          });
        }
        common = fullyPast;
      } else {
        // Nur laufende/unvollständige Monate vorhanden: lieber zeigen als leeren
        // Vergleich — mit sichtbarer Warnung (nie still).
        common = intersect;
        if (intersect.length > 0) {
          dataQuality.push({
            severity: 'warnung',
            text: 'Alle gemeinsamen Datenmonate liegen im laufenden, noch unvollständigen Monat — die Werte sind nur eingeschränkt vergleichbar.',
          });
        }
      }
    }
    if (common.length === 0) {
      dataQuality.push({
        severity: 'fehler',
        text: tm != null && intersect.length > 0
          ? 'Bis zum gewählten Monat haben die ausgewählten Jahre keine gemeinsamen Datenmonate — ein Vergleich ist aufgrund fehlender Daten nicht möglich.'
          : 'Die ausgewählten Jahre haben keine gemeinsamen Datenmonate — ein Vergleich ist aufgrund fehlender Daten nicht möglich.',
      });
      return { ...empty, availableCommonMonths, partialYears, hasAnyData: false };
    }
  }
  const appliedThroughMonth = mode === 'commonMonth' && common.length > 0
    ? common[common.length - 1] + 1
    : null;

  let partialNote: string | null = null;
  if (!isFullYears) {
    if (mode === 'fullYear') {
      partialNote = `* Teiljahr — Summe über die vorhandenen Datenmonate des Jahres, keine Hochrechnung auf zwölf Monate.`;
      dataQuality.push({
        severity: 'warnung',
        text: `Ganzjahresmodus mit Teiljahr(en) ${partialYears.join(', ')}: Die Jahressummen decken unterschiedlich viele Monate ab und sind nur eingeschränkt direkt vergleichbar.`,
      });
    } else {
      const label = partialRangeLabel(common) ?? `${common.length} Monate`;
      partialNote = `* Teiljahr — alle Werte über die gemeinsamen Monate (${label}), keine Hochrechnung.`;
      dataQuality.push({
        severity: 'hinweis',
        text: `Teiljahr(e) ${partialYears.join(', ')} — Vergleich bis gleicher Monat (${label}), keine Hochrechnung auf zwölf Monate.`,
      });
    }
  }

  // CHF-Zeilen: Summe über die Vergleichsmonate; ein null-Monat macht den
  // Jahreswert null (fehlend ≠ 0, nie still untersummieren).
  // fullYear: je Jahr die EIGENEN Datenmonate; commonMonth: gemeinsame Monate.
  const chfValue = (s: YearSeries, rowId: string): number | null => {
    const vals = rowMonthValues(s, rowId);
    const monthsForYear = mode === 'fullYear' ? (dataMonthsByYear.get(s.year) ?? []) : common;
    if (monthsForYear.length === 0) return null; // Jahr ohne Daten: «—», nie 0
    let sum = 0;
    for (const m of monthsForYear) {
      const v = vals[m];
      if (v == null) return null;
      sum += v;
    }
    return sum;
  };

  const chfByRow = new Map<string, (number | null)[]>();
  for (const id of chfRowIds) {
    const perYear = clean.map((s) => chfValue(s, id));
    chfByRow.set(id, perYear);
    perYear.forEach((v, i) => {
      // Leere Jahre haben bereits eine eigene Warnung — nicht je Zeile wiederholen.
      if (v == null && dataMonthsByYear.has(selYears[i])) {
        const label = YEAR_COMPARISON_ROWS.find((r) => r.id === id)?.label ?? id;
        dataQuality.push({
          severity: 'warnung',
          text: `${label} ${selYears[i]}: Wert fehlt in mindestens einem Vergleichsmonat — Zeile wird als «—» ausgewiesen (kein Vergleich möglich).`,
        });
      }
    });
  }

  const rows: YearComparisonRow[] = YEAR_COMPARISON_ROWS.map((def) => {
    let valueByYear: (number | null)[];
    if (def.kind === 'quote' && def.quoteOf) {
      const nums = chfByRow.get(def.quoteOf.numerator) ?? [];
      const dens = chfByRow.get(def.quoteOf.denominator) ?? [];
      valueByYear = clean.map((_, i) => {
        const n = nums[i];
        const d = dens[i];
        if (n == null || d == null || d === 0) return null;
        const q = (n / d) * 100;
        return Number.isFinite(q) ? q : null;
      });
    } else {
      valueByYear = chfByRow.get(def.id) ?? clean.map(() => null);
    }

    const deltas: YearComparisonDelta[] = [];
    for (let i = 1; i < selYears.length; i++) {
      deltas.push(comparisonDelta(def, selYears[i - 1], selYears[i], valueByYear[i - 1], valueByYear[i]));
    }
    const firstToLast = selYears.length >= 3
      ? comparisonDelta(def, selYears[0], selYears[selYears.length - 1], valueByYear[0], valueByYear[selYears.length - 1])
      : null;

    return { def, valueByYear, deltas, firstToLast };
  });

  return {
    mode,
    years: selYears,
    emptyYears,
    emptyNote,
    appliedThroughMonth,
    commonMonths: common,
    availableCommonMonths,
    commonMonthsLabel: mode === 'fullYear' ? null : partialRangeLabel(common),
    isFullYears,
    partialYears,
    partialNote,
    rows,
    dataQuality,
    hasAnyData: rows.some((r) => r.valueByYear.some((v) => v != null)),
  };
}

/**
 * Wählbare Jahre für die Jahres-Selektoren der Mehrjahres-/Report-Ansichten:
 * ALLE Serien-Jahre (auch ohne Daten — z. B. aktuelles Jahr −2 vor dem Import),
 * aufsteigend. Eine Zweitfilterung nach Umsatz (nonEmptyYears) würde reine
 * Kosten-Jahre bzw. leere, aber fachlich relevante Jahre still verstecken.
 */
export function selectableYears(series: YearSeries[]): number[] {
  return Array.from(new Set(series.map((s) => s.year))).sort((a, b) => a - b);
}

// ─── Personalkosten-Analyseblock (§7): regelbasierte Aussagen ─────────────────

/** ±Toleranz in %-Punkten der Wachstumsraten, innerhalb derer «ähnlich» gilt */
const INSIGHT_EQUAL_EPS_PCT = 0.05;
/** ±Toleranz in Prozentpunkten, innerhalb derer die Personalquote als stabil gilt */
const INSIGHT_QUOTE_EPS_PP = 0.1;

/** Prozentpunkte mit Vorzeichen, de-CH, 1 Dezimalstelle (zentral für UI + Exporte). */
export function fmtPpSigned(pp: number | null): string {
  if (pp == null || !Number.isFinite(pp)) return '—';
  const s = Math.abs(pp).toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${pp < 0 ? '−' : '+'}${s} pp`;
}

/** Quotenwert ohne Vorzeichen, de-CH, 1 Dezimalstelle (zentral für UI + Exporte). */
export function fmtQuotePct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}

/**
 * Sachliche, ausschliesslich aus vorhandenen Werten abgeleitete Aussagen zur
 * Personalentwicklung — je konsekutivem Jahrespaar. Keine Schätzungen.
 */
export function buildPersonnelInsights(cmp: YearKpiComparison): string[] {
  const revenue = cmp.rows.find((r) => r.def.id === 'net_revenue');
  const personnel = cmp.rows.find((r) => r.def.id === 'total_personnel');
  const quote = cmp.rows.find((r) => r.def.id === 'personnel_quote');
  if (!revenue || !personnel || cmp.years.length < 2) {
    return ['Ein Vergleich ist aufgrund fehlender Daten nicht möglich.'];
  }

  const lines: string[] = [];
  for (let i = 1; i < cmp.years.length; i++) {
    const fromYear = cmp.years[i - 1];
    const toYear = cmp.years[i];
    const prefix = `${toYear} vs. ${fromYear}: `;
    const revPct = revenue.deltas[i - 1]?.pct ?? null;
    const persPct = personnel.deltas[i - 1]?.pct ?? null;
    const quotePp = quote?.deltas[i - 1]?.pp ?? null;

    if (revPct == null || persPct == null) {
      lines.push(`${prefix}Ein Vergleich ist aufgrund fehlender Daten nicht möglich.`);
      continue;
    }

    let s: string;
    if (Math.abs(revPct - persPct) <= INSIGHT_EQUAL_EPS_PCT) {
      s = 'Umsatz und Personalkosten haben sich ähnlich entwickelt.';
    } else if (revPct > persPct) {
      if (persPct < 0 && revPct >= 0) s = 'Der Umsatz ist gestiegen, während die Personalkosten gesunken sind.';
      else if (revPct < 0) s = 'Die Personalkosten sind stärker gesunken als der Umsatz.';
      else s = 'Der Umsatz ist stärker gestiegen als die Personalkosten.';
    } else {
      if (revPct < 0 && persPct >= 0) s = 'Die Personalkosten sind gestiegen, während der Umsatz gesunken ist.';
      else if (persPct < 0) s = 'Der Umsatz ist stärker gesunken als die Personalkosten.';
      else s = 'Die Personalkosten sind stärker gestiegen als der Umsatz.';
    }
    lines.push(prefix + s);

    if (quotePp != null) {
      if (quotePp <= -INSIGHT_QUOTE_EPS_PP) {
        lines.push(`${prefix}Die Personalquote hat sich verbessert (${fmtPpSigned(quotePp)}).`);
      } else if (quotePp >= INSIGHT_QUOTE_EPS_PP) {
        lines.push(`${prefix}Die Personalquote hat sich verschlechtert (${fmtPpSigned(quotePp)}).`);
      } else {
        lines.push(`${prefix}Die Personalquote ist nahezu unverändert (${fmtPpSigned(quotePp)}).`);
      }
    }
  }
  return lines;
}

// ─── Drilldown des Jahresvergleichs (§8) ──────────────────────────────────────

/** Personal-Komponenten der P&L-Engine (Löhne + Sozialleistungen + übriger PA = Total Personal). */
export const PERSONNEL_COMPONENT_ROWS = [
  { id: 'personnel_wages', label: 'Löhne (Total)' },
  { id: 'personnel_social', label: 'Sozialleistungen' },
  { id: 'personnel_other', label: 'Übriger Personalaufwand' },
] as const;

export interface DrilldownComponent {
  id: string;
  label: string;
  /** Summe über die gemeinsamen Vergleichsmonate; fehlend = null */
  total: number | null;
}

export interface ComparisonDrilldownYearColumn {
  year: number;
  isPartial: boolean;
  partialLabel: string | null;
  /** Wert der Kennzahl über die gemeinsamen Monate (≡ Vergleichstabelle) */
  commonTotal: number | null;
  /** Nur Personalaufwand: Komponenten + sichtbare Summenabstimmung */
  components: DrilldownComponent[] | null;
  /** Summe der Komponenten (null sobald eine Komponente fehlt) */
  componentSum: number | null;
  /** componentSum − commonTotal (nur wenn beide vorhanden) — sichtbare Abstimmung */
  reconciliationDiff: number | null;
}

export interface ComparisonDrilldownMonthRow {
  monthIdx: number;
  label: string;
  /** Wert je Jahr (Reihenfolge = years) */
  valueByYear: (number | null)[];
  /** Δ zum direkten Vorjahr in der Auswahl (Index i vergleicht Jahr i mit i−1) */
  deltaPrev: DeltaValue[];
}

export interface ComparisonDrilldown {
  rowId: string;
  label: string;
  years: number[];
  commonMonths: number[];
  commonMonthsLabel: string | null;
  perYear: ComparisonDrilldownYearColumn[];
  monthRows: ComparisonDrilldownMonthRow[];
  dataQuality: DataQualityItem[];
}

/**
 * Drilldown einer Vergleichszeile: Zusammensetzung nach Jahr und Monat aus
 * DENSELBEN byPosition-Serien (keine neue Datenquelle, keine Zweitberechnung).
 * Die Summenabstimmung (Komponenten vs. Kennzahl) ist im Ergebnis sichtbar.
 */
export function buildComparisonDrilldown(
  series: YearSeries[],
  years: number[],
  rowId: string,
  opts: YearKpiComparisonOptions = {},
): ComparisonDrilldown | null {
  const def = YEAR_COMPARISON_ROWS.find((r) => r.id === rowId && r.kind === 'chf');
  if (!def) return null;

  const cmp = buildYearKpiComparison(series, years, opts);
  const clean = dedupeComparisonYears(series, new Set(cmp.years));
  const row = cmp.rows.find((r) => r.def.id === rowId);
  if (!row || clean.length === 0) return null;

  const dataQuality: DataQualityItem[] = [...cmp.dataQuality];
  const commonSet = new Set(cmp.commonMonths);
  const isPersonnel = rowId === 'total_personnel';

  const perYear: ComparisonDrilldownYearColumn[] = clean.map((s, i) => {
    const commonTotal = row.valueByYear[i];

    let components: DrilldownComponent[] | null = null;
    let componentSum: number | null = null;
    let reconciliationDiff: number | null = null;
    if (isPersonnel) {
      components = PERSONNEL_COMPONENT_ROWS.map((c) => {
        const vals = rowMonthValues(s, c.id);
        let sum = 0;
        let missing = false;
        for (const m of cmp.commonMonths) {
          const v = vals[m];
          if (v == null) { missing = true; break; }
          sum += v;
        }
        return { id: c.id, label: c.label, total: missing ? null : sum };
      });
      if (components.every((c) => c.total != null)) {
        componentSum = components.reduce((acc, c) => acc + (c.total as number), 0);
        if (commonTotal != null) {
          reconciliationDiff = componentSum - commonTotal;
          if (Math.abs(reconciliationDiff) > 0.5) {
            dataQuality.push({
              severity: 'warnung',
              text: `Summenabstimmung ${s.year}: Komponenten (${fmtChf(componentSum)}) weichen um ${fmtDeltaChf(reconciliationDiff)} CHF vom Personalaufwand (${fmtChf(commonTotal)}) ab.`,
            });
          }
        }
      }
    }

    const dataMonths = monthIndices(rowMonthValues(s, rowId));
    return {
      year: s.year,
      isPartial: cmp.partialYears.includes(s.year),
      partialLabel: partialRangeLabel(dataMonths),
      commonTotal,
      components,
      componentSum,
      reconciliationDiff,
    };
  });

  const monthRows: ComparisonDrilldownMonthRow[] = [];
  for (let m = 0; m < 12; m++) {
    const valueByYear = clean.map((s) => rowMonthValues(s, rowId)[m]);
    if (valueByYear.every((v) => v == null)) continue;
    const deltaPrev: DeltaValue[] = valueByYear.map((v, i) => {
      if (i === 0) return { chf: null, pct: null };
      const prev = valueByYear[i - 1];
      return {
        chf: v != null && prev != null ? v - prev : null,
        pct: safeDeltaPct(v, prev),
      };
    });
    monthRows.push({
      monthIdx: m,
      label: `${MONTH_LABELS_LONG[m]}${commonSet.has(m) ? '' : ' (ausserhalb Vergleich)'}`,
      valueByYear,
      deltaPrev,
    });
  }

  return {
    rowId,
    label: def.label,
    years: cmp.years,
    commonMonths: cmp.commonMonths,
    commonMonthsLabel: cmp.commonMonthsLabel,
    perYear,
    monthRows,
    dataQuality,
  };
}
