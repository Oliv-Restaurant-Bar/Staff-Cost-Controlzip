/**
 * Banken-/Investorenanalyse (Zweijahresvergleich der Erfolgsrechnung)
 * ====================================================================
 *
 * Reine Berechnungs-Lib (DOM-/Supabase-frei):
 *   YearSeries[] (P&L-Zeilenwerte pro Monat/Jahr, aus computePLForMonth)
 *     → buildBankInvestorAnalysis() → EIN Ergebnisobjekt (BankInvestorAnalysis)
 *
 * ALLE Konsumenten (Bildschirm-Ansicht, PDF-Report, Excel-Export) leiten sich
 * AUSSCHLIESSLICH aus diesem Objekt ab — Vorschau ≡ Export ist garantiert.
 *
 * Regeln (Spez. I):
 *   - Fehlende Werte bleiben null (nie 0 erfinden, nie NaN/Infinity).
 *   - Prozentveränderung = (aktuell − Basis) / |Basis|; Basis 0 → null
 *     („nicht vergleichbar").
 *   - Quote = Position / Umsatz; ohne Umsatz → null.
 *   - Prozentpunktveränderung = aktuelle Quote − Basisquote.
 *   - „Bis gleicher Monat": unvollständiges Jahr nur über gemeinsame Monate
 *     mit dem Basisjahr vergleichen (verhindert irreführende Vergleiche).
 *   - Ampellogik nach betriebswirtschaftlicher Wirkung: Umsatz/Ergebnis
 *     steigt → positiv; Quote sinkt → positiv; absolute Kosten NICHT pauschal
 *     rot — Vergleich mit dem Umsatzwachstum entscheidet.
 */

import {
  MONTH_LABELS_LONG,
  MONTH_LABELS_SHORT,
  type YearSeries,
  type GrowthTone,
  type DataQualityItem,
} from './multi-year-analysis';

// ─── P&L-Zeilen (IDs aus pl-engine.ts — KEINE Zweitberechnung) ───────────────

/** Alle P&L-Zeilen, die die Bank-Analyse benötigt (byPosition-Keys). */
export const BANK_ROW_IDS = [
  'revenue_total',
  'net_revenue',
  'total_cogs_direct',
  'total_cogs_uebrig',
  'total_cogs_einkauf',
  'cogs_lager',
  'total_cogs',
  'gross_profit_1',
  'total_personnel',
  'gross_profit_2',
  'total_opex',
  'ebitda',
  'total_depreciation',
  'ebit',
] as const;

export type BankRowId = (typeof BANK_ROW_IDS)[number];

export type BankRowSemantics = 'revenue' | 'expense' | 'result';

export interface BankRowDef {
  id: BankRowId;
  label: string;
  semantics: BankRowSemantics;
  /** Zwischentotal/Ergebnisstufe → visuell hervorheben */
  emphasis: boolean;
}

export const BANK_POSITION_ROWS: BankRowDef[] = [
  { id: 'revenue_total',      label: 'Umsatz (netto)',            semantics: 'revenue', emphasis: false },
  { id: 'net_revenue',        label: 'Betriebsertrag netto',      semantics: 'revenue', emphasis: true },
  { id: 'total_cogs_direct',  label: 'Direkter Warenaufwand',     semantics: 'expense', emphasis: false },
  { id: 'total_cogs_uebrig',  label: 'Übriger Warenaufwand',      semantics: 'expense', emphasis: false },
  { id: 'total_cogs_einkauf', label: 'Wareneinkauf (ohne Lagerveränderung)', semantics: 'expense', emphasis: false },
  { id: 'cogs_lager',         label: 'Veränderung Warenvorrat',   semantics: 'expense', emphasis: false },
  { id: 'total_cogs',         label: 'Wareneinsatz (inkl. Lagerveränderung)', semantics: 'expense', emphasis: true },
  { id: 'gross_profit_1',     label: 'Bruttogewinn 1',            semantics: 'result',  emphasis: true },
  { id: 'total_personnel',    label: 'Personalaufwand',           semantics: 'expense', emphasis: true },
  { id: 'gross_profit_2',     label: 'Bruttogewinn 2 / Deckungsbeitrag', semantics: 'result', emphasis: true },
  { id: 'total_opex',         label: 'Übriger Betriebsaufwand',   semantics: 'expense', emphasis: false },
  { id: 'ebitda',             label: 'EBITDA',                    semantics: 'result',  emphasis: true },
  { id: 'total_depreciation', label: 'Abschreibungen',            semantics: 'expense', emphasis: false },
  { id: 'ebit',               label: 'Betriebsergebnis (EBIT)',   semantics: 'result',  emphasis: true },
];

/** Zeilen der kompakten Zwischentotale-Tabelle (Spez. D6). */
export const BANK_TOTALS_ROW_IDS: BankRowId[] = [
  'net_revenue', 'total_cogs', 'gross_profit_1', 'total_personnel',
  'gross_profit_2', 'ebitda', 'ebit',
];

// ─── Phase 2: Management-Reporting (N Jahre, additiv) ────────────────────────

/**
 * USER-ENTSCHEID: Der Bericht endet bei EBIT — es gibt KEINE Jahresgewinn-
 * Zeile (Finanzergebnis/Steuern sind nicht importiert, nichts wird geschätzt).
 * Dieser Hinweis erscheint identisch in UI, PDF und Excel.
 */
export const EBIT_REPORT_NOTE =
  'Finanzergebnis und Steuern sind in dieser Auswertung nicht enthalten. Der Bericht endet daher bei EBIT.';

/** Jahresauswahl-Modi (Spez. Phase 2 §1). */
export type BankYearMode = 'two' | 'three' | 'all';

/**
 * Wählt die zu vergleichenden Jahre: chronologisch, 'two' = letzte 2,
 * 'three' = letzte 3, 'all' = alle. Fehlende Jahre (Lücken) sind erlaubt —
 * es zählt nur, welche Jahre tatsächlich Daten haben.
 */
export function selectBankYears(yearsWithData: number[], mode: BankYearMode): number[] {
  const sorted = [...new Set(yearsWithData)].sort((a, b) => a - b);
  if (mode === 'all') return sorted;
  const n = mode === 'three' ? 3 : 2;
  return sorted.slice(-n);
}

/** Scorecard-Zeilen (Spez. Phase 2 §3) — endet bei EBIT (kein Jahresgewinn). */
export const BANK_SCORECARD_ROW_IDS: BankRowId[] = [
  'net_revenue', 'gross_profit_1', 'total_cogs', 'total_personnel', 'ebitda', 'ebit',
];

/** Benchmark-Zielbereiche (Spez. Phase 2 §7) — zentral konfigurierbar. */
export interface BankBenchmarkDef {
  id: 'warenquote' | 'personalquote' | 'ebitda_marge' | 'ebit_marge' | 'bruttomarge';
  label: string;
  /** Zielwert in % */
  target: number;
  /** 'below' = Ist soll unter dem Ziel liegen, 'above' = darüber */
  direction: 'below' | 'above';
}

export const BANK_BENCHMARKS: BankBenchmarkDef[] = [
  { id: 'warenquote',    label: 'Warenquote',    target: 30, direction: 'below' },
  { id: 'personalquote', label: 'Personalquote', target: 35, direction: 'below' },
  { id: 'ebitda_marge',  label: 'EBITDA-Marge',  target: 15, direction: 'above' },
  { id: 'ebit_marge',    label: 'EBIT-Marge',    target: 10, direction: 'above' },
  { id: 'bruttomarge',   label: 'Bruttomarge',   target: 70, direction: 'above' },
];

/** Toleranzband (pp): Ziel knapp verfehlt → neutral statt kritisch. */
export const BANK_BENCHMARK_TOLERANCE_PP = 1.0;

/** Heatmap-Schwellen: CHF-Metriken relative Abweichung vom Ø in % … */
export const BANK_HEATMAP_PCT_THRESHOLDS = { strong: 10, slight: 2 } as const;
/** … Quoten-Metriken Abweichung vom Ø in Prozentpunkten. */
export const BANK_HEATMAP_PP_THRESHOLDS = { strong: 2, slight: 0.5 } as const;

// ─── Zentrale Rechenhelfer (Spez. I — einzeln getestet) ──────────────────────

/** Absolute Veränderung; null wenn ein Wert fehlt. */
export function absChange(current: number | null, base: number | null): number | null {
  if (current == null || base == null) return null;
  return current - base;
}

/**
 * Prozentuale Veränderung = (aktuell − Basis) / |Basis| × 100.
 * Basis 0 oder fehlende Werte → null (Anzeige „nicht vergleichbar").
 */
export function pctChange(current: number | null, base: number | null): number | null {
  if (current == null || base == null || base === 0) return null;
  const v = ((current - base) / Math.abs(base)) * 100;
  return Number.isFinite(v) ? v : null;
}

/** Quote vom Umsatz in % — null ohne Wert oder ohne (0-)Umsatz, NIE 0 erfinden. */
export function quotePct(value: number | null, revenue: number | null): number | null {
  if (value == null || revenue == null || revenue === 0) return null;
  const v = (value / revenue) * 100;
  return Number.isFinite(v) ? v : null;
}

/** Veränderung in Prozentpunkten = aktuelle Quote − Basisquote. */
export function ppChange(currentQuote: number | null, baseQuote: number | null): number | null {
  if (currentQuote == null || baseQuote == null) return null;
  return currentQuote - baseQuote;
}

/** Hat der Monat IRGENDWELCHE gebuchten Daten (Umsatz ODER eine andere Zeile)? */
function monthHasData(series: YearSeries, m: number): boolean {
  if (series.values[m] != null) return true;
  if (series.byPosition) {
    for (const row of Object.values(series.byPosition)) {
      if (row[m] != null) return true;
    }
  }
  return false;
}

/**
 * Letzter Monatsindex (0-basiert) mit Daten; −1 wenn keiner.
 * Zählt JEDE gebuchte Zeile (nicht nur Umsatz) — sonst würde ein Jahr mit
 * gebuchten Kosten, aber noch fehlendem Umsatzimport, komplett leer wirken.
 */
export function lastMonthWithData(series: YearSeries | undefined): number {
  if (!series) return -1;
  for (let m = 11; m >= 0; m--) {
    if (monthHasData(series, m)) return m;
  }
  return -1;
}

/** Ist das Jahr vollständig (alle 12 Monate mit gebuchten Daten)? */
export function isYearComplete(series: YearSeries | undefined): boolean {
  if (!series) return false;
  return Array.from({ length: 12 }, (_, m) => m).every(m => monthHasData(series, m));
}

/**
 * Vergleichs-Monatsindizes: Gesamtjahr = 0–11; „bis gleicher Monat" =
 * Januar bis zum letzten Datenmonat des AKTUELLEN Jahres — begrenzt auf
 * voll vergangene Kalendermonate (der laufende Monat ist unvollständig,
 * Teilmonats-Umsatz würde den Vergleich verzerren; identisch zum
 * Standardverhalten des Jahresvergleichs in multi-year-analysis).
 * Liegen NUR laufende/unvollständige Datenmonate vor, wird nicht still
 * geleert, sondern die volle Datenspanne verwendet (Datenqualitätshinweis
 * übernimmt buildBankInvestorAnalysis).
 */
export function comparisonMonthIndices(
  current: YearSeries | undefined,
  untilSameMonth: boolean,
  today: Date = new Date(),
): number[] {
  if (!untilSameMonth) return Array.from({ length: 12 }, (_, i) => i);
  const last = lastMonthWithData(current);
  if (last < 0) return [];
  const all = Array.from({ length: last + 1 }, (_, i) => i);
  const curY = today.getFullYear();
  const curM = today.getMonth();
  const notFullyPast = (m: number): boolean =>
    current != null && (current.year > curY || (current.year === curY && m >= curM));
  const fullyPast = all.filter(m => !notFullyPast(m));
  return fullyPast.length > 0 ? fullyPast : all;
}

/** Summe einer Zeile über Monatsindizes; null wenn KEIN Monat einen Wert hat. */
export function sumRow(
  series: YearSeries | undefined,
  rowId: string,
  monthIndices: number[],
): number | null {
  if (!series) return null;
  const arr = series.byPosition?.[rowId];
  if (!arr) return null;
  let sum = 0;
  let any = false;
  for (const m of monthIndices) {
    const v = arr[m];
    if (v != null) { sum += v; any = true; }
  }
  return any ? sum : null;
}

// ─── Ampellogik nach betriebswirtschaftlicher Wirkung (Spez. D2) ─────────────

/** Schwelle in %, unter der eine Veränderung als neutral gilt. */
export const BANK_NEUTRAL_PCT = 0.5;
/** Schwelle in Prozentpunkten für Quoten-Veränderungen. */
export const BANK_NEUTRAL_PP = 0.2;

/** Ergebnis-/Ertragsgrössen: mehr = gut. */
export function toneForResultDelta(diffPct: number | null, diffChf: number | null): GrowthTone {
  if (diffPct != null) {
    if (diffPct > BANK_NEUTRAL_PCT) return 'good';
    if (diffPct < -BANK_NEUTRAL_PCT) return 'critical';
    return 'neutral';
  }
  if (diffChf != null) {
    if (diffChf > 0) return 'good';
    if (diffChf < 0) return 'critical';
  }
  return 'neutral';
}

/** Quoten (Waren-/Personalquote): sinkt = gut. */
export function toneForQuoteDelta(pp: number | null): GrowthTone {
  if (pp == null) return 'neutral';
  if (pp < -BANK_NEUTRAL_PP) return 'good';
  if (pp > BANK_NEUTRAL_PP) return 'critical';
  return 'neutral';
}

/**
 * Absolute Kosten: NICHT pauschal rot bei Anstieg — steigen sie langsamer
 * als der Umsatz, ist das positiv; schneller = kritisch; sonst neutral.
 * Ohne vergleichbares Umsatzwachstum → neutral.
 */
export function toneForCostDelta(costPct: number | null, revenuePct: number | null): GrowthTone {
  if (costPct == null || revenuePct == null) return 'neutral';
  if (costPct < revenuePct - BANK_NEUTRAL_PCT) return 'good';
  if (costPct > revenuePct + BANK_NEUTRAL_PCT) return 'critical';
  return 'neutral';
}

// ─── Format-Helfer ───────────────────────────────────────────────────────────

export function fmtPp(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const s = value.toLocaleString('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${value > 0 ? '+' : ''}${s} pp`;
}

/** Prozentveränderung mit expliziter „nicht vergleichbar"-Anzeige (Basis 0). */
export function fmtPctChange(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'nicht vergleichbar';
  const s = value.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${value > 0 ? '+' : ''}${s} %`;
}

// ─── Ergebnis-Typen ──────────────────────────────────────────────────────────

export interface BankKpi {
  id: string;
  label: string;
  /** Formatierter Hauptwert (CHF oder %) */
  value: string;
  /** Formatierte Veränderung (Δ CHF / Δ % / Δ pp) — '' wenn keine */
  delta: string;
  tone: GrowthTone;
  /** Roh-Werte für Tests/Export */
  raw: { current: number | null; base: number | null; diffChf: number | null; diffPct: number | null; diffPp: number | null };
}

export interface BankMonthPoint {
  monthIdx: number;
  label: string;       // Kurzlabel (Jan…)
  base: number | null;
  current: number | null;
  diffChf: number | null;
  diffPct: number | null;
  /** Quote in % des Monatsumsatzes (nur Waren-/Personal-Charts) */
  baseQuote: number | null;
  currentQuote: number | null;
}

export interface BankCostSummary {
  baseTotal: number | null;
  currentTotal: number | null;
  diffChf: number | null;
  diffPct: number | null;
  baseQuote: number | null;
  currentQuote: number | null;
  quotePp: number | null;
}

export interface BankRevenueInsights {
  strongestMonth: { label: string; value: number } | null;
  weakestMonth: { label: string; value: number } | null;
  largestGain: { label: string; diffChf: number } | null;
  largestDecline: { label: string; diffChf: number } | null;
  growthPct: number | null;
}

export interface BankPositionRow {
  id: BankRowId;
  label: string;
  semantics: BankRowSemantics;
  emphasis: boolean;
  base: number | null;
  current: number | null;
  diffChf: number | null;
  diffPct: number | null;
  /** Anteil am Umsatz (net_revenue) je Jahr in % */
  baseQuote: number | null;
  currentQuote: number | null;
  quotePp: number | null;
}

export interface BankCostStructureYear {
  year: number;
  revenue: number | null;
  /** Anteile am Umsatz in % (null = nicht vorhanden, NIE 0 erfinden) */
  shares: {
    ware: number | null;
    personal: number | null;
    uebrig: number | null;
    abschreibungen: number | null;
    ebit: number | null;
  };
}

// ─── Phase-2-Ergebnistypen (N Jahre, additiv) ────────────────────────────────

/** Trend über die gewählten Jahre (regelbasiert, Neutralband BANK_NEUTRAL_PCT). */
export type BankTrend = 'steigend' | 'fallend' | 'stabil' | 'gemischt';

export interface BankMultiYearRow {
  id: BankRowId;
  label: string;
  semantics: BankRowSemantics;
  emphasis: boolean;
  /** Wert je gewähltem Jahr (chronologisch, Index = years-Index); fehlend = null */
  values: (number | null)[];
  /** Quote vom Umsatz je Jahr in % (null bei revenue-Zeilen/fehlendem Umsatz) */
  quotes: (number | null)[];
  /** Neuestes Jahr vs. Vorjahr in der Auswahl */
  diffChf: number | null;
  diffPct: number | null;
  trend: BankTrend | null;
  /** Ampel nach Wirkung (expense via toneForCostDelta relativ zum Umsatz) */
  tone: GrowthTone;
}

export interface BankMultiYearTable {
  /** Gewählte Jahre, chronologisch */
  years: number[];
  rows: BankMultiYearRow[];
}

export interface BankExecutiveSummary {
  /** 9 KPI-Karten (Spez. Phase 2 §2), Vergleich neuestes Jahr vs. Vorjahr */
  kpis: BankKpi[];
  /** Regelbasierter Gesamttrend (keine KI-Texte) */
  gesamtTrend: { tone: GrowthTone; label: 'positiv' | 'stabil' | 'kritisch'; reasons: string[] };
}

export interface BankWaterfallStep {
  id: BankRowId;
  label: string;
  kind: 'start' | 'cost' | 'subtotal';
  /** Betrag der Stufe (Kosten als positive Zahl, wie in der P&L gespeichert) */
  value: number | null;
  /**
   * Zwischenstand NACH der Stufe. Subtotale übernehmen den Engine-Wert
   * (gross_profit_1 usw.) — KEINE Zweitberechnung.
   */
  cumulative: number | null;
}

export interface BankWaterfall {
  year: number;
  steps: BankWaterfallStep[];
  /** Alle Stufen vorhanden? (fehlend ≠ 0) */
  complete: boolean;
  /** EBIT-Hinweis (identisch UI/PDF/Excel) */
  note: string;
}

export interface BankEbitDriver {
  id: 'umsatz' | 'waren' | 'personal' | 'uebrig' | 'abschreibungen';
  label: string;
  /** Beitrag zur EBIT-Veränderung in CHF (+ = verbessert EBIT); null = fehlend */
  contribution: number | null;
  /** Beitrag in % des Basis-EBIT (|Basis|); null bei Basis 0/fehlend */
  pctOfBaseEbit: number | null;
}

export interface BankEbitDrivers {
  baseYear: number;
  currentYear: number;
  ebitBase: number | null;
  ebitCurrent: number | null;
  ebitDelta: number | null;
  drivers: BankEbitDriver[];
  /** ebitDelta − Summe der Beiträge (Kontrollwert, sollte ≈ 0 sein) */
  residual: number | null;
  complete: boolean;
}

export type BankHistoryMetricId =
  | 'umsatz' | 'warenquote' | 'personalquote' | 'bruttomarge' | 'ebit' | 'ebit_marge';

export interface BankHistoryPoint {
  year: number;
  value: number | null;
  /** Jahr vollständig (12 Datenmonate)? Teiljahre werden markiert, nie geschätzt. */
  complete: boolean;
}

export interface BankHistorySeries {
  id: BankHistoryMetricId;
  label: string;
  unit: 'chf' | 'pct';
  points: BankHistoryPoint[];
}

export interface BankBenchmarkRow extends BankBenchmarkDef {
  /** Ist-Wert des neuesten Jahres in % (Vergleichszeitraum) */
  ist: number | null;
  /** Abweichung in pp, VORZEICHEN: positiv = besser als Ziel */
  abweichungPp: number | null;
  tone: GrowthTone;
}

export type BankHeatmapMetricId = 'umsatz' | 'ebit' | 'warenquote' | 'personalquote';

/** Beschreibende Einordnung relativ zum Ø (nicht gut/schlecht gefärbt). */
export type BankHeatmapBucket =
  | 'deutlich_ueber' | 'leicht_ueber' | 'durchschnitt' | 'unter' | 'stark_unter';

export interface BankHeatmapCell {
  value: number | null;
  bucket: BankHeatmapBucket | null;
}

export interface BankHeatmapYearRow {
  year: number;
  /** 12 Zellen (Index = Monatsindex 0–11) */
  cells: BankHeatmapCell[];
}

export interface BankHeatmap {
  metric: BankHeatmapMetricId;
  label: string;
  unit: 'chf' | 'pct';
  /** Ø über alle vorhandenen Zellen (null wenn keine Daten) */
  average: number | null;
  rows: BankHeatmapYearRow[];
}

export interface BankYearImportInfo {
  importedAt: string | null;
  fileName?: string | null;
}

export interface BankTimelineEntry {
  year: number;
  umsatz: number | null;
  ebit: number | null;
  /** Anzahl Monate mit gebuchten Daten (0–12) */
  monthsWithData: number;
  status: 'vollständig' | 'teilweise' | 'leer';
  /** Importdatum aus der Import-Registry (null = unbekannt) */
  importedAt: string | null;
}

export interface BankKernaussagenPlus {
  positive: string[];
  potenziale: string[];
}

export interface BankInvestorAnalysis {
  baseYear: number;
  currentYear: number;
  /** Verglichene Monatsindizes (0-basiert) + menschenlesbares Label */
  comparison: {
    untilSameMonth: boolean;
    monthIndices: number[];
    /** z. B. „Vergleich Januar–August 2025 mit Januar–August 2024" */
    label: string;
    isPartial: boolean;
  };
  header: {
    title: string;      // „Geschäftsentwicklung 2024–2025"
    restaurantName: string;
    dataSource: string;
    importStand: string | null;
  };
  kpis: BankKpi[];
  revenueMonths: BankMonthPoint[];
  revenueInsights: BankRevenueInsights;
  wareMonths: BankMonthPoint[];
  wareSummary: BankCostSummary;
  personalMonths: BankMonthPoint[];
  personalSummary: BankCostSummary;
  /** EBIT je Monat (Index = Monatsindex 0–11) für den Excel-Monatsvergleich */
  ebitMonthsBase: (number | null)[] | null;
  ebitMonthsCurrent: (number | null)[] | null;
  /** Zwischentotale & Margen (Spez. D6) — Teilmenge von positionRows */
  totalsRows: BankPositionRow[];
  /** Mehrjahresvergleich alle Positionen (Spez. B) */
  positionRows: BankPositionRow[];
  costStructure: BankCostStructureYear[];
  /** Max. 5 regelbasierte Kernaussagen */
  kernaussagen: string[];
  dataQuality: DataQualityItem[];
  /** Beide Jahre mit Daten vorhanden? */
  hasData: boolean;

  // ── Phase 2: Management-Reporting (N Jahre, alle Felder additiv) ──────────
  /** Gewählte Jahre (chronologisch, ≥2); Fallback [baseYear, currentYear] */
  years: number[];
  /** Alle P&L-Positionen über die gewählten Jahre */
  multiYear: BankMultiYearTable;
  /** Kompakte Scorecard (Spez. §3) — endet bei EBIT */
  scorecard: BankMultiYearTable;
  /** Executive Summary (Spez. §2): 9 KPIs + regelbasierter Gesamttrend */
  executive: BankExecutiveSummary;
  /** Waterfall Umsatz→EBIT des neuesten Jahres (Spez. §4) */
  waterfall: BankWaterfall;
  /** EBIT-Treiberanalyse neuestes Jahr vs. Vorjahr (Spez. §5) */
  ebitDrivers: BankEbitDrivers;
  /** Kennzahlenhistorie über alle gewählten Jahre (Spez. §6) */
  historie: BankHistorySeries[];
  /** Benchmark Ist/Ziel/Abweichung/Ampel (Spez. §7) */
  benchmarks: BankBenchmarkRow[];
  /** Heatmaps Jahr×Monat je Metrik (Spez. §8) */
  heatmaps: Record<BankHeatmapMetricId, BankHeatmap>;
  /** Investor Timeline (Spez. §10) */
  timeline: BankTimelineEntry[];
  /** Kernaussagen 5+5 (Spez. §9) — `kernaussagen` bleibt unverändert */
  kernaussagenPlus: BankKernaussagenPlus;
  /** EBIT-Hinweis (USER-ENTSCHEID) — identisch in UI/PDF/Excel */
  ebitNote: string;
}

export interface BankInvestorOptions {
  baseYear: number;
  currentYear: number;
  untilSameMonth: boolean;
  restaurantName?: string;
  /** Anzahl nicht gemappter Konten (aus dem Import) — Datenqualitätshinweis */
  unmappedAccounts?: number;
  /** Stand des letzten Imports (Anzeige im Kopf) */
  importStand?: string | null;
  dataSource?: string;
  /**
   * Phase 2: gewählte Jahre (chronologisch, ≥2). Fehlt das Feld, wird
   * [baseYear, currentYear] verwendet — bestehende Aufrufer unverändert.
   */
  years?: number[];
  /** Phase 2: Import-Metadaten je Jahr für die Investor Timeline */
  importInfoByYear?: Record<number, BankYearImportInfo>;
  /** Referenzdatum für „voll vergangene Monate" (Tests); Default: jetzt. */
  today?: Date;
}

// ─── Format (de-CH) ──────────────────────────────────────────────────────────

function chf(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `CHF ${Math.round(value).toLocaleString('de-CH')}`;
}

function chfDelta(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const s = Math.round(Math.abs(value)).toLocaleString('de-CH');
  return `${value >= 0 ? '+' : '−'}CHF ${s}`;
}

function pctFmt(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
}

// ─── Hauptfunktion ───────────────────────────────────────────────────────────

export function buildBankInvestorAnalysis(
  series: YearSeries[],
  opts: BankInvestorOptions,
): BankInvestorAnalysis {
  const { baseYear, currentYear, untilSameMonth } = opts;
  const base = series.find(s => s.year === baseYear);
  const current = series.find(s => s.year === currentYear);

  const cmpToday = opts.today ?? new Date();
  const monthIndices = comparisonMonthIndices(current, untilSameMonth, cmpToday);
  const isPartialRange = monthIndices.length > 0 && monthIndices.length < 12;
  const rangeLabel = monthIndices.length === 0
    ? '—'
    : monthIndices.length === 12
      ? `Vergleich Gesamtjahr ${currentYear} mit ${baseYear}`
      : `Vergleich ${MONTH_LABELS_LONG[monthIndices[0]]}–${MONTH_LABELS_LONG[monthIndices[monthIndices.length - 1]]} ${currentYear} mit ${MONTH_LABELS_LONG[monthIndices[0]]}–${MONTH_LABELS_LONG[monthIndices[monthIndices.length - 1]]} ${baseYear}`;

  // ── Jahreswerte je Zeile (über den Vergleichszeitraum) ─────────────────────
  const rowTotal = (s: YearSeries | undefined, id: string) => sumRow(s, id, monthIndices);

  const revBase = rowTotal(base, 'net_revenue');
  const revCur = rowTotal(current, 'net_revenue');
  const revDiffPct = pctChange(revCur, revBase);

  const buildRow = (def: BankRowDef): BankPositionRow => {
    const b = rowTotal(base, def.id);
    const c = rowTotal(current, def.id);
    const qb = def.semantics === 'revenue' ? null : quotePct(b, revBase);
    const qc = def.semantics === 'revenue' ? null : quotePct(c, revCur);
    return {
      id: def.id, label: def.label, semantics: def.semantics, emphasis: def.emphasis,
      base: b, current: c,
      diffChf: absChange(c, b), diffPct: pctChange(c, b),
      baseQuote: qb, currentQuote: qc, quotePp: ppChange(qc, qb),
    };
  };

  const positionRows = BANK_POSITION_ROWS.map(buildRow);
  const rowById = new Map(positionRows.map(r => [r.id, r]));
  const totalsRows = BANK_TOTALS_ROW_IDS
    .map(id => rowById.get(id))
    .filter((r): r is BankPositionRow => r != null);

  const ware = rowById.get('total_cogs')!;
  const personal = rowById.get('total_personnel')!;
  const bg1 = rowById.get('gross_profit_1')!;
  const ebit = rowById.get('ebit')!;

  // ── Executive-KPIs (Spez. D2) ───────────────────────────────────────────────
  const kpis: BankKpi[] = [
    {
      id: 'umsatz', label: `Umsatz ${currentYear}`,
      value: chf(revCur),
      delta: revDiffPct != null || absChange(revCur, revBase) != null
        ? `${fmtPctChange(revDiffPct)} vs. ${baseYear}` : '',
      tone: toneForResultDelta(revDiffPct, absChange(revCur, revBase)),
      raw: { current: revCur, base: revBase, diffChf: absChange(revCur, revBase), diffPct: revDiffPct, diffPp: null },
    },
    {
      id: 'bg1', label: 'Bruttogewinn 1',
      value: chf(bg1.current),
      delta: bg1.diffChf != null ? `${chfDelta(bg1.diffChf)} vs. ${baseYear}` : '',
      tone: toneForResultDelta(bg1.diffPct, bg1.diffChf),
      raw: { current: bg1.current, base: bg1.base, diffChf: bg1.diffChf, diffPct: bg1.diffPct, diffPp: null },
    },
    {
      id: 'bg1_marge', label: 'Bruttomarge',
      value: pctFmt(quotePct(bg1.current, revCur)),
      delta: fmtPpDelta(ppChange(quotePct(bg1.current, revCur), quotePct(bg1.base, revBase)), baseYear),
      tone: (() => {
        const pp = ppChange(quotePct(bg1.current, revCur), quotePct(bg1.base, revBase));
        // Marge = Ergebnisgrösse: mehr ist gut
        if (pp == null) return 'neutral' as GrowthTone;
        if (pp > BANK_NEUTRAL_PP) return 'good' as GrowthTone;
        if (pp < -BANK_NEUTRAL_PP) return 'critical' as GrowthTone;
        return 'neutral' as GrowthTone;
      })(),
      raw: { current: quotePct(bg1.current, revCur), base: quotePct(bg1.base, revBase), diffChf: null, diffPct: null, diffPp: ppChange(quotePct(bg1.current, revCur), quotePct(bg1.base, revBase)) },
    },
    {
      id: 'personal', label: 'Personalaufwand',
      value: chf(personal.current),
      delta: personal.diffChf != null ? `${chfDelta(personal.diffChf)} vs. ${baseYear}` : '',
      tone: toneForCostDelta(personal.diffPct, revDiffPct),
      raw: { current: personal.current, base: personal.base, diffChf: personal.diffChf, diffPct: personal.diffPct, diffPp: null },
    },
    {
      id: 'personal_quote', label: 'Personalquote',
      value: pctFmt(personal.currentQuote),
      delta: fmtPpDelta(personal.quotePp, baseYear),
      tone: toneForQuoteDelta(personal.quotePp),
      raw: { current: personal.currentQuote, base: personal.baseQuote, diffChf: null, diffPct: null, diffPp: personal.quotePp },
    },
    {
      id: 'ware', label: 'Warenaufwand',
      value: chf(ware.current),
      delta: ware.diffChf != null ? `${chfDelta(ware.diffChf)} vs. ${baseYear}` : '',
      tone: toneForCostDelta(ware.diffPct, revDiffPct),
      raw: { current: ware.current, base: ware.base, diffChf: ware.diffChf, diffPct: ware.diffPct, diffPp: null },
    },
    {
      id: 'ware_quote', label: 'Warenquote',
      value: pctFmt(ware.currentQuote),
      delta: fmtPpDelta(ware.quotePp, baseYear),
      tone: toneForQuoteDelta(ware.quotePp),
      raw: { current: ware.currentQuote, base: ware.baseQuote, diffChf: null, diffPct: null, diffPp: ware.quotePp },
    },
    {
      id: 'ebit', label: 'Betriebsergebnis (EBIT)',
      value: chf(ebit.current),
      delta: ebit.diffChf != null ? `${chfDelta(ebit.diffChf)} vs. ${baseYear}` : '',
      tone: toneForResultDelta(ebit.diffPct, ebit.diffChf),
      raw: { current: ebit.current, base: ebit.base, diffChf: ebit.diffChf, diffPct: ebit.diffPct, diffPp: null },
    },
    {
      id: 'ebit_marge', label: 'EBIT-Marge',
      value: pctFmt(ebit.currentQuote),
      delta: fmtPpDelta(ebit.quotePp, baseYear),
      tone: (() => {
        if (ebit.quotePp == null) return 'neutral' as GrowthTone;
        if (ebit.quotePp > BANK_NEUTRAL_PP) return 'good' as GrowthTone;
        if (ebit.quotePp < -BANK_NEUTRAL_PP) return 'critical' as GrowthTone;
        return 'neutral' as GrowthTone;
      })(),
      raw: { current: ebit.currentQuote, base: ebit.baseQuote, diffChf: null, diffPct: null, diffPp: ebit.quotePp },
    },
  ];

  // ── Monatsreihen ────────────────────────────────────────────────────────────
  const monthPoints = (rowId: string, withQuote: boolean): BankMonthPoint[] =>
    monthIndices.map(m => {
      const b = base?.byPosition?.[rowId]?.[m] ?? null;
      const c = current?.byPosition?.[rowId]?.[m] ?? null;
      const revB = base?.byPosition?.['net_revenue']?.[m] ?? null;
      const revC = current?.byPosition?.['net_revenue']?.[m] ?? null;
      return {
        monthIdx: m,
        label: MONTH_LABELS_SHORT[m],
        base: b, current: c,
        diffChf: absChange(c, b), diffPct: pctChange(c, b),
        baseQuote: withQuote ? quotePct(b, revB) : null,
        currentQuote: withQuote ? quotePct(c, revC) : null,
      };
    });

  const revenueMonths = monthPoints('net_revenue', false);
  const wareMonths = monthPoints('total_cogs', true);
  const personalMonths = monthPoints('total_personnel', true);

  // ── Umsatz-Erkenntnisse (deterministisch, Spez. D3) ─────────────────────────
  let strongest: { label: string; value: number } | null = null;
  let weakest: { label: string; value: number } | null = null;
  let gain: { label: string; diffChf: number } | null = null;
  let decline: { label: string; diffChf: number } | null = null;
  for (const p of revenueMonths) {
    if (p.current != null) {
      if (!strongest || p.current > strongest.value) strongest = { label: MONTH_LABELS_LONG[p.monthIdx], value: p.current };
      if (!weakest || p.current < weakest.value) weakest = { label: MONTH_LABELS_LONG[p.monthIdx], value: p.current };
    }
    if (p.diffChf != null) {
      if (!gain || p.diffChf > gain.diffChf) gain = { label: MONTH_LABELS_LONG[p.monthIdx], diffChf: p.diffChf };
      if (!decline || p.diffChf < decline.diffChf) decline = { label: MONTH_LABELS_LONG[p.monthIdx], diffChf: p.diffChf };
    }
  }
  const revenueInsights: BankRevenueInsights = {
    strongestMonth: strongest,
    weakestMonth: weakest,
    largestGain: gain && gain.diffChf > 0 ? gain : null,
    largestDecline: decline && decline.diffChf < 0 ? decline : null,
    growthPct: revDiffPct,
  };

  // ── Kosten-Zusammenfassungen ───────────────────────────────────────────────
  const costSummary = (row: BankPositionRow): BankCostSummary => ({
    baseTotal: row.base, currentTotal: row.current,
    diffChf: row.diffChf, diffPct: row.diffPct,
    baseQuote: row.baseQuote, currentQuote: row.currentQuote, quotePp: row.quotePp,
  });

  // ── Kostenstruktur (Anteile am Umsatz je Jahr, Spez. D7) ────────────────────
  const structureFor = (s: YearSeries | undefined, year: number): BankCostStructureYear => {
    const rev = rowTotal(s, 'net_revenue');
    return {
      year,
      revenue: rev,
      shares: {
        ware: quotePct(rowTotal(s, 'total_cogs'), rev),
        personal: quotePct(rowTotal(s, 'total_personnel'), rev),
        uebrig: quotePct(rowTotal(s, 'total_opex'), rev),
        abschreibungen: quotePct(rowTotal(s, 'total_depreciation'), rev),
        ebit: quotePct(rowTotal(s, 'ebit'), rev),
      },
    };
  };
  const costStructure = [structureFor(base, baseYear), structureFor(current, currentYear)];

  // ── Kernaussagen (regelbasiert, max. 5, Spez. D8) ───────────────────────────
  const kernaussagen: string[] = [];
  if (revDiffPct != null) {
    kernaussagen.push(
      `Der Umsatz ist gegenüber ${baseYear} um ${pctFmt(Math.abs(revDiffPct))} ${revDiffPct >= 0 ? 'gestiegen' : 'gesunken'}.`,
    );
  }
  if (ware.quotePp != null && Math.abs(ware.quotePp) >= 0.05) {
    kernaussagen.push(
      ware.quotePp < 0
        ? `Die Warenquote hat sich um ${fmtPpAbs(ware.quotePp)} verbessert.`
        : `Die Warenquote liegt ${fmtPpAbs(ware.quotePp)} über dem Vorjahr.`,
    );
  }
  if (personal.quotePp != null && Math.abs(personal.quotePp) >= 0.05) {
    kernaussagen.push(
      personal.quotePp < 0
        ? `Die Personalquote hat sich um ${fmtPpAbs(personal.quotePp)} verbessert.`
        : `Die Personalquote liegt ${fmtPpAbs(personal.quotePp)} über dem Vorjahr.`,
    );
  }
  if (ebit.diffChf != null && Math.abs(ebit.diffChf) >= 500) {
    kernaussagen.push(
      `Das Betriebsergebnis hat sich um CHF ${Math.round(Math.abs(ebit.diffChf)).toLocaleString('de-CH')} ${ebit.diffChf >= 0 ? 'verbessert' : 'verschlechtert'}.`,
    );
  }
  if (revDiffPct != null && personal.diffPct != null) {
    // Neutralband wie beim KPI-Ton (toneForCostDelta): Grenzfälle nahe
    // Gleichstand erzeugen KEINE „wachsen schneller"-Aussage.
    const gap = revDiffPct - personal.diffPct;
    if (gap > BANK_NEUTRAL_PCT) {
      kernaussagen.push('Das Umsatzwachstum liegt über dem Wachstum der Personalkosten.');
    } else if (gap < -BANK_NEUTRAL_PCT) {
      kernaussagen.push('Die Personalkosten wachsen schneller als der Umsatz.');
    }
  }
  const kernaussagenMax5 = kernaussagen.slice(0, 5);

  // ── Datenqualität (Spez. F) ─────────────────────────────────────────────────
  const dataQuality: DataQualityItem[] = [];
  const baseHasData = base != null && lastMonthWithData(base) >= 0;
  const curHasData = current != null && lastMonthWithData(current) >= 0;
  if (!baseHasData) dataQuality.push({ severity: 'fehler', text: `${baseYear} enthält keine Erfolgsrechnungsdaten.` });
  if (!curHasData) dataQuality.push({ severity: 'fehler', text: `${currentYear} enthält keine Erfolgsrechnungsdaten.` });

  if (curHasData) {
    const last = lastMonthWithData(current);
    // Laufender (unvollständiger) Monat aus dem Vergleich ausgeschlossen? Nie still.
    if (untilSameMonth && monthIndices.length > 0 && monthIndices[monthIndices.length - 1] < last) {
      dataQuality.push({
        severity: 'hinweis',
        text: `Der laufende Monat ist noch unvollständig und wird im Vergleich „bis gleicher Monat" nicht mitgezählt — die Vergleichsbasis endet bei ${MONTH_LABELS_LONG[monthIndices[monthIndices.length - 1]]}.`,
      });
    }
    // Fallback-Fall: KEIN Datenmonat liegt voll in der Vergangenheit — die
    // volle Datenspanne wird gezeigt statt still geleert. Nie ohne Warnung.
    const notFullyPastFirst = current != null && (
      current.year > cmpToday.getFullYear() ||
      (current.year === cmpToday.getFullYear() && (monthIndices[0] ?? 0) >= cmpToday.getMonth())
    );
    if (untilSameMonth && monthIndices.length > 0 && notFullyPastFirst) {
      dataQuality.push({
        severity: 'warnung',
        text: 'Alle Datenmonate des aktuellen Jahres liegen im laufenden, noch unvollständigen Monat — die Werte sind nur eingeschränkt vergleichbar.',
      });
    }
  }
  if (curHasData && !isYearComplete(current)) {
    const last = lastMonthWithData(current);
    dataQuality.push({ severity: 'hinweis', text: `${currentYear} enthält Daten bis ${MONTH_LABELS_LONG[last]}.` });
    if (!untilSameMonth) {
      dataQuality.push({
        severity: 'warnung',
        text: `${currentYear} ist unvollständig — Gesamtjahresvergleich kann irreführend sein. Option „Bis gleicher Monat" verwenden.`,
      });
    }
  }
  if (baseHasData && !isYearComplete(base)) {
    const last = lastMonthWithData(base);
    dataQuality.push({ severity: 'hinweis', text: `${baseYear} enthält Daten bis ${MONTH_LABELS_LONG[last]}.` });
  }
  if (opts.unmappedAccounts != null && opts.unmappedAccounts > 0) {
    dataQuality.push({
      severity: 'hinweis',
      text: `${opts.unmappedAccounts} ${opts.unmappedAccounts === 1 ? 'Konto ist' : 'Konten sind'} noch keiner Erfolgsrechnungsposition zugeordnet.`,
    });
  }
  // Zentrale Positionen fehlen, obwohl Umsatz vorhanden?
  const centralChecks: Array<{ id: BankRowId; label: string }> = [
    { id: 'total_personnel', label: 'Personalaufwand' },
    { id: 'total_cogs', label: 'Warenaufwand' },
  ];
  for (const chk of centralChecks) {
    if (revBase != null && rowTotal(base, chk.id) == null) {
      dataQuality.push({ severity: 'warnung', text: `${chk.label} ${baseYear} ist nicht vollständig vorhanden.` });
    }
    if (revCur != null && rowTotal(current, chk.id) == null) {
      dataQuality.push({ severity: 'warnung', text: `${chk.label} ${currentYear} ist nicht vollständig vorhanden.` });
    }
  }

  // ═══ Phase 2: Management-Reporting (N Jahre, additiv) ══════════════════════
  const selectedYears = (opts.years && opts.years.length >= 2
    ? [...new Set(opts.years)].sort((a, b) => a - b)
    : [baseYear, currentYear]);
  const seriesByYear = new Map(series.map(s => [s.year, s]));
  const newestYear = selectedYears[selectedYears.length - 1];
  const prevYear = selectedYears[selectedYears.length - 2];
  const yearSeries = (y: number) => seriesByYear.get(y);
  /** Jahreswert über den Vergleichszeitraum (gleiche monthIndices wie 2-Jahres-Teil) */
  const yearTotal = (y: number, id: string) => sumRow(yearSeries(y), id, monthIndices);
  /** Jahreswert über ALLE 12 Monate (Historie/Timeline — Teiljahre werden markiert) */
  const ALL_MONTHS = Array.from({ length: 12 }, (_, i) => i);
  const fullYearTotal = (y: number, id: string) => sumRow(yearSeries(y), id, ALL_MONTHS);

  const revPerYear = selectedYears.map(y => yearTotal(y, 'net_revenue'));
  const revNew = revPerYear[revPerYear.length - 1];
  const revPrev = revPerYear[revPerYear.length - 2];
  const revGrowthPct = pctChange(revNew, revPrev);

  // ── Mehrjahres-Tabelle + Scorecard (Spez. §1/§3) ───────────────────────────
  const trendForValues = (values: (number | null)[]): BankTrend | null => {
    const present = values.filter((v): v is number => v != null);
    if (present.length < 2) return null;
    let up = 0, down = 0;
    for (let i = 1; i < present.length; i++) {
      const p = pctChange(present[i], present[i - 1]);
      if (p == null) return 'gemischt'; // Basis 0 → nicht vergleichbar
      if (p > BANK_NEUTRAL_PCT) up++;
      else if (p < -BANK_NEUTRAL_PCT) down++;
    }
    if (up > 0 && down === 0) return 'steigend';
    if (down > 0 && up === 0) return 'fallend';
    if (up === 0 && down === 0) return 'stabil';
    return 'gemischt';
  };

  const buildMultiYearRow = (def: BankRowDef): BankMultiYearRow => {
    const values = selectedYears.map(y => yearTotal(y, def.id));
    const quotes = selectedYears.map((y, i) =>
      def.semantics === 'revenue' ? null : quotePct(values[i], revPerYear[i]));
    const vNew = values[values.length - 1];
    const vPrev = values[values.length - 2];
    const diffChf = absChange(vNew, vPrev);
    const diffPct = pctChange(vNew, vPrev);
    const tone: GrowthTone = def.semantics === 'expense'
      ? toneForCostDelta(diffPct, revGrowthPct)
      : toneForResultDelta(diffPct, diffChf);
    return {
      id: def.id, label: def.label, semantics: def.semantics, emphasis: def.emphasis,
      values, quotes, diffChf, diffPct, trend: trendForValues(values), tone,
    };
  };

  const multiYearRows = BANK_POSITION_ROWS.map(buildMultiYearRow);
  const multiYearById = new Map(multiYearRows.map(r => [r.id, r]));
  const multiYear: BankMultiYearTable = { years: selectedYears, rows: multiYearRows };
  const scorecard: BankMultiYearTable = {
    years: selectedYears,
    rows: BANK_SCORECARD_ROW_IDS
      .map(id => multiYearById.get(id))
      .filter((r): r is BankMultiYearRow => r != null),
  };

  // ── Executive Summary (Spez. §2): neuestes Jahr vs. Vorjahr der Auswahl ───
  const my = (id: BankRowId) => multiYearById.get(id)!;
  const nyVal = (id: BankRowId) => my(id).values[selectedYears.length - 1];
  const pvVal = (id: BankRowId) => my(id).values[selectedYears.length - 2];
  const nyQuote = (id: BankRowId) => quotePct(nyVal(id), revNew);
  const pvQuote = (id: BankRowId) => quotePct(pvVal(id), revPrev);
  const toneForMargin = (pp: number | null): GrowthTone => {
    if (pp == null) return 'neutral';
    if (pp > BANK_NEUTRAL_PP) return 'good';
    if (pp < -BANK_NEUTRAL_PP) return 'critical';
    return 'neutral';
  };
  const chfKpi = (id: string, label: string, rowId: BankRowId, resultTone: boolean): BankKpi => {
    const c = nyVal(rowId); const b = pvVal(rowId);
    const dChf = absChange(c, b); const dPct = pctChange(c, b);
    return {
      id, label,
      value: chf(c),
      delta: dChf != null ? `${chfDelta(dChf)} vs. ${prevYear}` : '',
      tone: resultTone ? toneForResultDelta(dPct, dChf) : toneForCostDelta(dPct, revGrowthPct),
      raw: { current: c, base: b, diffChf: dChf, diffPct: dPct, diffPp: null },
    };
  };
  const quoteKpi = (id: string, label: string, rowId: BankRowId, marginTone: boolean): BankKpi => {
    const c = nyQuote(rowId); const b = pvQuote(rowId);
    const pp = ppChange(c, b);
    return {
      id, label,
      value: pctFmt(c),
      delta: fmtPpDelta(pp, prevYear),
      tone: marginTone ? toneForMargin(pp) : toneForQuoteDelta(pp),
      raw: { current: c, base: b, diffChf: null, diffPct: null, diffPp: pp },
    };
  };
  const executiveKpis: BankKpi[] = [
    chfKpi('umsatz', `Umsatz ${newestYear}`, 'net_revenue', true),
    {
      id: 'umsatz_wachstum', label: 'Umsatzwachstum',
      value: fmtPctChange(revGrowthPct),
      delta: revGrowthPct != null ? `vs. ${prevYear}` : '',
      tone: toneForResultDelta(revGrowthPct, absChange(revNew, revPrev)),
      raw: { current: revNew, base: revPrev, diffChf: absChange(revNew, revPrev), diffPct: revGrowthPct, diffPp: null },
    },
    chfKpi('bruttogewinn', 'Bruttogewinn 1', 'gross_profit_1', true),
    quoteKpi('bruttomarge', 'Bruttomarge', 'gross_profit_1', true),
    quoteKpi('warenquote', 'Warenquote', 'total_cogs', false),
    quoteKpi('personalquote', 'Personalquote', 'total_personnel', false),
    chfKpi('ebitda', 'EBITDA', 'ebitda', true),
    chfKpi('ebit', 'Betriebsergebnis (EBIT)', 'ebit', true),
    quoteKpi('ebit_marge', 'EBIT-Marge', 'ebit', true),
  ];
  // Gesamttrend: 5 Signale, rein regelbasiert (keine KI-Texte)
  const trendSignals: Array<{ tone: GrowthTone; good: string; bad: string }> = [
    { tone: executiveKpis[1].tone, good: 'Der Umsatz wächst.', bad: 'Der Umsatz ist rückläufig.' },
    { tone: executiveKpis[7].tone, good: 'Das Betriebsergebnis (EBIT) hat sich verbessert.', bad: 'Das Betriebsergebnis (EBIT) hat sich verschlechtert.' },
    { tone: executiveKpis[4].tone, good: 'Die Warenquote hat sich verbessert.', bad: 'Die Warenquote ist gestiegen.' },
    { tone: executiveKpis[5].tone, good: 'Die Personalquote hat sich verbessert.', bad: 'Die Personalquote ist gestiegen.' },
    { tone: executiveKpis[8].tone, good: 'Die EBIT-Marge hat sich verbessert.', bad: 'Die EBIT-Marge ist gesunken.' },
  ];
  const goods = trendSignals.filter(s => s.tone === 'good').length;
  const crits = trendSignals.filter(s => s.tone === 'critical').length;
  // Score-Regel: deutliches Übergewicht (≥2) entscheidet, sonst stabil
  const trendScore = goods - crits;
  const trendLabel: 'positiv' | 'stabil' | 'kritisch' =
    trendScore >= 2 ? 'positiv' : trendScore <= -2 ? 'kritisch' : 'stabil';
  const executive: BankExecutiveSummary = {
    kpis: executiveKpis,
    gesamtTrend: {
      label: trendLabel,
      tone: trendLabel === 'positiv' ? 'good' : trendLabel === 'kritisch' ? 'critical' : 'neutral',
      reasons: trendSignals
        .filter(s => s.tone !== 'neutral')
        .map(s => (s.tone === 'good' ? s.good : s.bad)),
    },
  };

  // ── Waterfall Umsatz→EBIT, neuestes Jahr (Spez. §4; endet bei EBIT) ────────
  const WATERFALL_DEFS: Array<{ id: BankRowId; label: string; kind: 'start' | 'cost' | 'subtotal' }> = [
    { id: 'net_revenue',        label: 'Umsatz',                     kind: 'start' },
    { id: 'total_cogs',         label: 'Warenaufwand',               kind: 'cost' },
    { id: 'gross_profit_1',     label: 'Bruttogewinn 1',             kind: 'subtotal' },
    { id: 'total_personnel',    label: 'Personalaufwand',            kind: 'cost' },
    { id: 'gross_profit_2',     label: 'Deckungsbeitrag (BG 2)',     kind: 'subtotal' },
    { id: 'total_opex',         label: 'Übriger Betriebsaufwand',    kind: 'cost' },
    { id: 'ebitda',             label: 'EBITDA',                     kind: 'subtotal' },
    { id: 'total_depreciation', label: 'Abschreibungen',             kind: 'cost' },
    { id: 'ebit',               label: 'EBIT',                       kind: 'subtotal' },
  ];
  let running: number | null = null;
  const waterfallSteps: BankWaterfallStep[] = WATERFALL_DEFS.map(def => {
    const v = nyVal(def.id);
    if (def.kind === 'start') running = v;
    else if (def.kind === 'subtotal') running = v; // Engine-Wert, keine Zweitberechnung
    else running = running != null && v != null ? running - v : null;
    return { id: def.id, label: def.label, kind: def.kind, value: v, cumulative: running };
  });
  const waterfall: BankWaterfall = {
    year: newestYear,
    steps: waterfallSteps,
    complete: waterfallSteps.every(s => s.value != null),
    note: EBIT_REPORT_NOTE,
  };

  // ── EBIT-Treiberanalyse (Spez. §5): neuestes Jahr vs. Vorjahr ──────────────
  const ebitNew = nyVal('ebit');
  const ebitPrev = pvVal('ebit');
  const ebitDelta = absChange(ebitNew, ebitPrev);
  const driverDefs: Array<{ id: BankEbitDriver['id']; label: string; rowId: BankRowId; sign: 1 | -1 }> = [
    { id: 'umsatz',          label: 'Umsatzentwicklung',   rowId: 'net_revenue',        sign: 1 },
    { id: 'waren',           label: 'Warenkosten',         rowId: 'total_cogs',         sign: -1 },
    { id: 'personal',        label: 'Personalkosten',      rowId: 'total_personnel',    sign: -1 },
    { id: 'uebrig',          label: 'Übrige Kosten',       rowId: 'total_opex',         sign: -1 },
    { id: 'abschreibungen',  label: 'Abschreibungen',      rowId: 'total_depreciation', sign: -1 },
  ];
  const drivers: BankEbitDriver[] = driverDefs.map(d => {
    const delta = absChange(nyVal(d.rowId), pvVal(d.rowId));
    const contribution = delta == null ? null : d.sign * delta;
    const pctOfBaseEbit = contribution != null && ebitPrev != null && ebitPrev !== 0
      ? (contribution / Math.abs(ebitPrev)) * 100
      : null;
    return { id: d.id, label: d.label, contribution, pctOfBaseEbit };
  });
  const driversComplete = drivers.every(d => d.contribution != null) && ebitDelta != null;
  const contributionSum = driversComplete
    ? drivers.reduce((s, d) => s + (d.contribution ?? 0), 0)
    : null;
  const ebitDrivers: BankEbitDrivers = {
    baseYear: prevYear,
    currentYear: newestYear,
    ebitBase: ebitPrev,
    ebitCurrent: ebitNew,
    ebitDelta,
    drivers,
    residual: ebitDelta != null && contributionSum != null ? ebitDelta - contributionSum : null,
    complete: driversComplete,
  };

  // ── Kennzahlenhistorie (Spez. §6): volle Jahre, Teiljahre markiert ─────────
  const historyDefs: Array<{ id: BankHistoryMetricId; label: string; unit: 'chf' | 'pct';
    calc: (y: number) => number | null }> = [
    { id: 'umsatz',        label: 'Umsatz',        unit: 'chf', calc: y => fullYearTotal(y, 'net_revenue') },
    { id: 'warenquote',    label: 'Warenquote',    unit: 'pct', calc: y => quotePct(fullYearTotal(y, 'total_cogs'), fullYearTotal(y, 'net_revenue')) },
    { id: 'personalquote', label: 'Personalquote', unit: 'pct', calc: y => quotePct(fullYearTotal(y, 'total_personnel'), fullYearTotal(y, 'net_revenue')) },
    { id: 'bruttomarge',   label: 'Bruttomarge',   unit: 'pct', calc: y => quotePct(fullYearTotal(y, 'gross_profit_1'), fullYearTotal(y, 'net_revenue')) },
    { id: 'ebit',          label: 'EBIT',          unit: 'chf', calc: y => fullYearTotal(y, 'ebit') },
    { id: 'ebit_marge',    label: 'EBIT-Marge',    unit: 'pct', calc: y => quotePct(fullYearTotal(y, 'ebit'), fullYearTotal(y, 'net_revenue')) },
  ];
  const historie: BankHistorySeries[] = historyDefs.map(def => ({
    id: def.id, label: def.label, unit: def.unit,
    points: selectedYears.map(y => ({
      year: y,
      value: def.calc(y),
      complete: isYearComplete(yearSeries(y)),
    })),
  }));

  // ── Benchmark (Spez. §7): neuestes Jahr, Vergleichszeitraum ────────────────
  const benchmarkIst: Record<BankBenchmarkDef['id'], number | null> = {
    warenquote:    nyQuote('total_cogs'),
    personalquote: nyQuote('total_personnel'),
    ebitda_marge:  nyQuote('ebitda'),
    ebit_marge:    nyQuote('ebit'),
    bruttomarge:   nyQuote('gross_profit_1'),
  };
  const benchmarks: BankBenchmarkRow[] = BANK_BENCHMARKS.map(def => {
    const ist = benchmarkIst[def.id];
    // Vorzeichen: positiv = besser als Ziel
    const abweichungPp = ist == null ? null
      : def.direction === 'below' ? def.target - ist : ist - def.target;
    let tone: GrowthTone = 'neutral';
    if (abweichungPp != null) {
      if (abweichungPp >= 0) tone = 'good';
      else if (abweichungPp >= -BANK_BENCHMARK_TOLERANCE_PP) tone = 'neutral';
      else tone = 'critical';
    }
    return { ...def, ist, abweichungPp, tone };
  });

  // ── Heatmaps Jahr×Monat (Spez. §8): beschreibend relativ zum Ø ─────────────
  const heatmapDefs: Array<{ id: BankHeatmapMetricId; label: string; unit: 'chf' | 'pct';
    cellValue: (s: YearSeries | undefined, m: number) => number | null }> = [
    { id: 'umsatz', label: 'Umsatz', unit: 'chf',
      cellValue: (s, m) => s?.byPosition?.['net_revenue']?.[m] ?? null },
    { id: 'ebit', label: 'EBIT', unit: 'chf',
      cellValue: (s, m) => s?.byPosition?.['ebit']?.[m] ?? null },
    { id: 'warenquote', label: 'Warenquote', unit: 'pct',
      cellValue: (s, m) => quotePct(s?.byPosition?.['total_cogs']?.[m] ?? null, s?.byPosition?.['net_revenue']?.[m] ?? null) },
    { id: 'personalquote', label: 'Personalquote', unit: 'pct',
      cellValue: (s, m) => quotePct(s?.byPosition?.['total_personnel']?.[m] ?? null, s?.byPosition?.['net_revenue']?.[m] ?? null) },
  ];
  const heatBucket = (value: number | null, avg: number | null, unit: 'chf' | 'pct'): BankHeatmapBucket | null => {
    if (value == null || avg == null) return null;
    let dev: number;
    let strong: number; let slight: number;
    if (unit === 'chf') {
      if (avg === 0) return null;
      dev = ((value - avg) / Math.abs(avg)) * 100;
      strong = BANK_HEATMAP_PCT_THRESHOLDS.strong; slight = BANK_HEATMAP_PCT_THRESHOLDS.slight;
    } else {
      dev = value - avg;
      strong = BANK_HEATMAP_PP_THRESHOLDS.strong; slight = BANK_HEATMAP_PP_THRESHOLDS.slight;
    }
    if (dev >= strong) return 'deutlich_ueber';
    if (dev >= slight) return 'leicht_ueber';
    if (dev > -slight) return 'durchschnitt';
    if (dev > -strong) return 'unter';
    return 'stark_unter';
  };
  const buildHeatmap = (def: (typeof heatmapDefs)[number]): BankHeatmap => {
    const rawRows = selectedYears.map(y => ({
      year: y,
      values: ALL_MONTHS.map(m => def.cellValue(yearSeries(y), m)),
    }));
    const allValues = rawRows.flatMap(r => r.values).filter((v): v is number => v != null);
    const average = allValues.length > 0
      ? allValues.reduce((s, v) => s + v, 0) / allValues.length
      : null;
    return {
      metric: def.id, label: def.label, unit: def.unit, average,
      rows: rawRows.map(r => ({
        year: r.year,
        cells: r.values.map(v => ({ value: v, bucket: heatBucket(v, average, def.unit) })),
      })),
    };
  };
  const heatmaps = Object.fromEntries(
    heatmapDefs.map(def => [def.id, buildHeatmap(def)]),
  ) as Record<BankHeatmapMetricId, BankHeatmap>;

  // ── Investor Timeline (Spez. §10) ──────────────────────────────────────────
  const timeline: BankTimelineEntry[] = selectedYears.map(y => {
    const s = yearSeries(y);
    const monthsWithDataCount = s
      ? ALL_MONTHS.filter(m => monthHasData(s, m)).length
      : 0;
    return {
      year: y,
      umsatz: fullYearTotal(y, 'net_revenue'),
      ebit: fullYearTotal(y, 'ebit'),
      monthsWithData: monthsWithDataCount,
      status: monthsWithDataCount === 12 ? 'vollständig' : monthsWithDataCount > 0 ? 'teilweise' : 'leer',
      importedAt: opts.importInfoByYear?.[y]?.importedAt ?? null,
    };
  });

  // ── Kernaussagen 5+5 (Spez. §9): rein regelbasiert ─────────────────────────
  const positive: string[] = [];
  const potenziale: string[] = [];
  const wareQuotePpNew = ppChange(nyQuote('total_cogs'), pvQuote('total_cogs'));
  const persQuotePpNew = ppChange(nyQuote('total_personnel'), pvQuote('total_personnel'));
  if (revGrowthPct != null) {
    if (revGrowthPct > BANK_NEUTRAL_PCT) {
      positive.push(`Der Umsatz ist gegenüber ${prevYear} um ${pctFmt(Math.abs(revGrowthPct))} gestiegen.`);
    } else if (revGrowthPct < -BANK_NEUTRAL_PCT) {
      potenziale.push(`Der Umsatz ist gegenüber ${prevYear} um ${pctFmt(Math.abs(revGrowthPct))} gesunken.`);
    }
  }
  if (wareQuotePpNew != null && Math.abs(wareQuotePpNew) >= 0.05) {
    (wareQuotePpNew < 0 ? positive : potenziale).push(
      wareQuotePpNew < 0
        ? `Die Warenquote hat sich um ${fmtPpAbs(wareQuotePpNew)} verbessert.`
        : `Die Warenquote liegt ${fmtPpAbs(wareQuotePpNew)} über dem Vorjahr.`,
    );
  }
  if (persQuotePpNew != null && Math.abs(persQuotePpNew) >= 0.05) {
    (persQuotePpNew < 0 ? positive : potenziale).push(
      persQuotePpNew < 0
        ? `Die Personalquote hat sich um ${fmtPpAbs(persQuotePpNew)} verbessert.`
        : `Die Personalquote liegt ${fmtPpAbs(persQuotePpNew)} über dem Vorjahr.`,
    );
  }
  if (ebitDelta != null && Math.abs(ebitDelta) >= 500) {
    (ebitDelta >= 0 ? positive : potenziale).push(
      `Das Betriebsergebnis hat sich um CHF ${Math.round(Math.abs(ebitDelta)).toLocaleString('de-CH')} ${ebitDelta >= 0 ? 'verbessert' : 'verschlechtert'}.`,
    );
  }
  {
    const persDiffPct = pctChange(nyVal('total_personnel'), pvVal('total_personnel'));
    if (revGrowthPct != null && persDiffPct != null) {
      const gap = revGrowthPct - persDiffPct;
      if (gap > BANK_NEUTRAL_PCT) {
        positive.push('Das Umsatzwachstum liegt über dem Wachstum der Personalkosten.');
      } else if (gap < -BANK_NEUTRAL_PCT) {
        potenziale.push('Die Personalkosten wachsen schneller als der Umsatz.');
      }
    }
  }
  for (const b of benchmarks) {
    if (b.ist == null) continue;
    if (b.tone === 'good') {
      positive.push(`${b.label} (${pctFmt(b.ist)}) erfüllt den Zielwert von ${b.direction === 'below' ? 'unter' : 'über'} ${pctFmt(b.target, 0)}.`);
    } else if (b.tone === 'critical') {
      potenziale.push(`${b.label} (${pctFmt(b.ist)}) verfehlt den Zielwert von ${b.direction === 'below' ? 'unter' : 'über'} ${pctFmt(b.target, 0)}.`);
    }
  }
  const kernaussagenPlus: BankKernaussagenPlus = {
    positive: positive.slice(0, 5),
    potenziale: potenziale.slice(0, 5),
  };

  // ── Datenqualität: unvollständige weitere Jahre der Auswahl (additiv) ──────
  for (const y of selectedYears) {
    if (y === baseYear || y === currentYear) continue; // bereits oben abgedeckt
    const s = yearSeries(y);
    const hasAny = s != null && lastMonthWithData(s) >= 0;
    if (!hasAny) {
      dataQuality.push({ severity: 'fehler', text: `${y} enthält keine Erfolgsrechnungsdaten.` });
    } else if (!isYearComplete(s)) {
      dataQuality.push({ severity: 'hinweis', text: `${y} enthält Daten bis ${MONTH_LABELS_LONG[lastMonthWithData(s)]}.` });
    }
  }

  return {
    baseYear,
    currentYear,
    comparison: { untilSameMonth, monthIndices, label: rangeLabel, isPartial: isPartialRange },
    header: {
      title: `Geschäftsentwicklung ${baseYear}–${currentYear}`,
      restaurantName: opts.restaurantName ?? 'Restaurant',
      dataSource: opts.dataSource ?? 'Erfolgsrechnung (importierte Buchhaltungsdaten)',
      importStand: opts.importStand ?? null,
    },
    kpis,
    revenueMonths,
    revenueInsights,
    wareMonths,
    wareSummary: costSummary(ware),
    personalMonths,
    personalSummary: costSummary(personal),
    ebitMonthsBase: base?.byPosition?.['ebit'] ?? null,
    ebitMonthsCurrent: current?.byPosition?.['ebit'] ?? null,
    totalsRows,
    positionRows,
    costStructure,
    kernaussagen: kernaussagenMax5,
    dataQuality,
    hasData: baseHasData && curHasData,
    // Phase 2 (additiv)
    years: selectedYears,
    multiYear,
    scorecard,
    executive,
    waterfall,
    ebitDrivers,
    historie,
    benchmarks,
    heatmaps,
    timeline,
    kernaussagenPlus,
    ebitNote: EBIT_REPORT_NOTE,
  };
}

// ── kleine interne Format-Helfer (nach buildBankInvestorAnalysis genutzt) ─────

function fmtPpDelta(pp: number | null, baseYear: number): string {
  if (pp == null || !Number.isFinite(pp)) return '';
  return `${fmtPp(pp)} vs. ${baseYear}`;
}

function fmtPpAbs(pp: number | null): string {
  if (pp == null) return '—';
  const s = Math.abs(pp).toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${s} Prozentpunkte`;
}
