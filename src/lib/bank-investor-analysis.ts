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
  { id: 'total_cogs',         label: 'Gesamtwarenaufwand',        semantics: 'expense', emphasis: true },
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
 * Januar bis zum letzten Datenmonat des AKTUELLEN Jahres.
 */
export function comparisonMonthIndices(
  current: YearSeries | undefined,
  untilSameMonth: boolean,
): number[] {
  if (!untilSameMonth) return Array.from({ length: 12 }, (_, i) => i);
  const last = lastMonthWithData(current);
  if (last < 0) return [];
  return Array.from({ length: last + 1 }, (_, i) => i);
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

  const monthIndices = comparisonMonthIndices(current, untilSameMonth);
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
