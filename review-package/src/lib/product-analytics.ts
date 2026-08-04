/**
 * product-analytics.ts — Pure logic for the Produkt-Analyse ranking + drill-down detail.
 * =====================================================================================
 * NO supabase / NO DOM imports (only `import type` from sales-db, erased at compile time)
 * so it is safe to unit-test under the node vitest environment.
 *
 * Datenquelle bleibt unverändert `product_sales` (aggregiert pro Produkt · Tag · Quelle).
 * Es gibt KEINE Stunden-Granularität — die Tagesansicht zeigt daher die einzelnen
 * Quellen-Einträge eines Tages (gruppierte Zusammenfassung), keine Uhrzeiten.
 *
 * Mandanten-Trennung (tenant isolation): `product_sales` besitzt KEINE restaurant_id —
 * die Ladeschicht (`loadProductSalesRows`) liefert für alle Funktionen hier die Zeilen.
 * Diese reinen Funktionen sind "boundary-faithful": sie rechnen ausschliesslich auf den
 * übergebenen Zeilen (Produkt + Periode + Kategorie) und ziehen niemals globalen Zustand
 * heran. Wer einen mandantengefilterten Zeilensatz übergibt, erhält ein mandantenreines
 * Ergebnis. Eine echte DB-seitige Isolation ist bewusst ausgeklammert (separates Projekt).
 *
 * Future-ready: `PeriodSelection` ist eine discriminated union — eigene Varianten wie
 * `{ kind: 'range' }` oder `{ kind: 'comparison' }` lassen sich später additiv ergänzen,
 * ohne die bestehenden Aggregat-Funktionen zu brechen.
 */

import type { ProductSalesRow } from './sales-db';

// ─── Typen ────────────────────────────────────────────────────────────────────

export type PeriodKind = 'day' | 'week' | 'month' | 'year' | 'range';
export type CategoryFilter = 'all' | 'food' | 'beverage';
export type Metric = 'revenue' | 'qty';

/** Discriminated union — erweiterbar (comparison) ohne Bruch. */
export type PeriodSelection =
  | { kind: 'day'; date: string }                  // date = YYYY-MM-DD
  | { kind: 'week'; year: number; week: number }   // ISO-Jahr + ISO-Kalenderwoche
  | { kind: 'month'; year: number; month: number } // month = 1..12
  | { kind: 'year'; year: number }
  | { kind: 'range'; from: string; to: string };   // inklusive, YYYY-MM-DD

export interface AnalysisFilters {
  period: PeriodSelection;
  category: CategoryFilter;
  metric: Metric;
}

export interface ProductAggregate {
  product_name: string;
  total_revenue: number;
  total_qty: number;
}

/** Ein Wochentag-Eimer (Mo–So) innerhalb der Wochen-Rangliste. */
export interface WeekdayBucket {
  /** YYYY-MM-DD des Wochentags */
  date: string;
  /** 0 = Montag … 6 = Sonntag */
  weekdayIndex: number;
  quantity: number;
  revenue: number;
}

/** Ein Produkt mit seinen 7 Wochentag-Eimern (Mo–So) + Wochen-Total. */
export interface ProductWeekAggregate {
  product_name: string;
  /** genau 7 Einträge, Mo→So in Reihenfolge */
  days: WeekdayBucket[];
  total_revenue: number;
  total_qty: number;
}

export interface BreakdownRow {
  /** stabiler React-Key */
  key: string;
  /** Hauptlabel: Datum / Wochentag / Monat — bei Tagesansicht der rohe `source`-Wert */
  label: string;
  /** Zusatzinfo (z. B. Datum unter dem Wochentag) */
  subLabel?: string;
  /** repräsentatives Datum (YYYY-MM-DD) sofern sinnvoll */
  date?: string;
  /** nur Tagesansicht: rohe Quelle für hübsches Label im UI (sourceLabel) */
  source?: string | null;
  quantity: number;
  revenue: number;
  /** Anteil 0..1 am Produkt-Total der aktiven Metrik */
  share: number;
  /** Ø Preis = Umsatz / Anzahl (null wenn Anzahl 0) */
  avgPrice: number | null;
}

export interface ProductBreakdown {
  productName: string;
  period: PeriodSelection;
  periodLabel: string;
  totalRevenue: number;
  totalQty: number;
  /** Anzahl zugrundeliegender product_sales-Zeilen (= "Verkäufe/Einträge") */
  salesCount: number;
  /** Ø Umsatz pro Verkauf (Zeile) */
  avgRevenuePerSale: number;
  /** Spalte, nach der `share` berechnet wurde */
  metric: Metric;
  rows: BreakdownRow[];
}

// ─── Konstanten ─────────────────────────────────────────────────────────────────

export const SOURCE_CATEGORY: Record<string, CategoryFilter> = {
  food_csv_export: 'food',
  beverage_csv_export: 'beverage',
  // Erweiterter Z-Bericht: Kategorie aus der Verkaufsdaten-Historie abgeleitet
  // (produkt-quellen). Unklassifizierte Positionen ('gn_extended') bleiben
  // bewusst OHNE Kategorie — sie zählen in «Alle», nie in Food/Beverage.
  gn_extended_food: 'food',
  gn_extended_beverage: 'beverage',
};

export const PERIOD_KIND_LABEL: Record<PeriodKind, string> = {
  day: 'Tag',
  week: 'Woche',
  month: 'Monat',
  year: 'Jahr',
  range: 'Von–Bis',
};

export const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export const MONTH_SHORT = [
  'Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
  'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez',
];

/** Montag-basiert (Index 0 = Montag) */
export const WEEKDAY_NAMES = [
  'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag',
];
export const WEEKDAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

// ─── kleine Helfer ────────────────────────────────────────────────────────────

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD → UTC-Date (Mitternacht), TZ-stabil. */
function parseISO(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

/** UTC-Date → YYYY-MM-DD */
function toISO(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Lokales heute (für Defaults) als YYYY-MM-DD. */
export function localISODate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Tage im Monat (month = 1..12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Montag-basierter Wochentag-Index (0 = Montag … 6 = Sonntag). */
export function weekdayIndexMonday(dateStr: string): number {
  return (parseISO(dateStr).getUTCDay() + 6) % 7;
}

export function formatDayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

export function formatDayShort(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  return `${d}.${m}.`;
}

// ─── ISO-Kalenderwoche ──────────────────────────────────────────────────────────

/** ISO-8601 Woche + zugehöriges ISO-Jahr für ein Datum. */
export function isoWeekInfo(dateStr: string): { year: number; week: number } {
  const d = parseISO(dateStr);
  const dayNum = d.getUTCDay() || 7;       // Sonntag = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // nächster Donnerstag bestimmt das ISO-Jahr
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: isoYear, week };
}

/** Montag (00:00 UTC) der angegebenen ISO-Woche. */
export function isoWeekStart(isoYear: number, week: number): Date {
  // Der 4. Januar liegt per Definition immer in Woche 1.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Mon = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4.getTime());
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Mon);
  const monday = new Date(week1Monday.getTime());
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday;
}

/** Anzahl ISO-Wochen eines ISO-Jahres (52 oder 53). */
export function isoWeeksInYear(isoYear: number): number {
  return isoWeekInfo(`${isoYear}-12-28`).week;
}

/**
 * ISO-Woche um `delta` Wochen verschieben (vor/zurück) — jahresübergreifend sicher.
 * Rechnet über den Montag der Woche (+ delta·7 Tage) und liest die ISO-Info neu,
 * so dass KW1↔KW52/53 und Jahreswechsel korrekt rollen.
 */
export function shiftIsoWeek(
  year: number,
  week: number,
  delta: number,
): { year: number; week: number } {
  const monday = isoWeekStart(year, week);
  monday.setUTCDate(monday.getUTCDate() + delta * 7);
  return isoWeekInfo(toISO(monday));
}

// ─── Periode → Grenzen / Label ──────────────────────────────────────────────────

/** Inklusive Datumsgrenzen (YYYY-MM-DD) der Periode. */
export function periodBounds(sel: PeriodSelection): { from: string; to: string } {
  switch (sel.kind) {
    case 'day':
      return { from: sel.date, to: sel.date };
    case 'month': {
      const last = daysInMonth(sel.year, sel.month);
      return {
        from: `${sel.year}-${pad2(sel.month)}-01`,
        to: `${sel.year}-${pad2(sel.month)}-${pad2(last)}`,
      };
    }
    case 'year':
      return { from: `${sel.year}-01-01`, to: `${sel.year}-12-31` };
    case 'week': {
      const monday = isoWeekStart(sel.year, sel.week);
      const sunday = new Date(monday.getTime());
      sunday.setUTCDate(monday.getUTCDate() + 6);
      return { from: toISO(monday), to: toISO(sunday) };
    }
    case 'range':
      // Normalisiert: from <= to, auch wenn verkehrt herum übergeben.
      return sel.from <= sel.to
        ? { from: sel.from, to: sel.to }
        : { from: sel.to, to: sel.from };
  }
}

export function periodLabel(sel: PeriodSelection): string {
  switch (sel.kind) {
    case 'day': {
      const wd = WEEKDAY_NAMES[weekdayIndexMonday(sel.date)];
      return `${wd}, ${formatDayLabel(sel.date)}`;
    }
    case 'week': {
      const { from, to } = periodBounds(sel);
      return `KW ${sel.week} ${sel.year} (${formatDayShort(from)}–${formatDayShort(to)})`;
    }
    case 'month':
      return `${MONTH_NAMES[sel.month - 1]} ${sel.year}`;
    case 'year':
      return String(sel.year);
    case 'range': {
      const { from, to } = periodBounds(sel);
      return `${formatDayLabel(from)} – ${formatDayLabel(to)}`;
    }
  }
}

/**
 * Kompaktes Wochen-Label für die Navigation, z. B. „KW 26 · 22.06.–28.06.2026".
 * Das Start-Datum zeigt das Jahr nur bei jahresübergreifenden Wochen
 * (z. B. „KW 1 · 29.12.2025–04.01.2026").
 */
export function weekRangeLabel(year: number, week: number): string {
  const { from, to } = periodBounds({ kind: 'week', year, week });
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const fromStr = sameYear ? formatDayShort(from) : formatDayLabel(from);
  return `KW ${week} · ${fromStr}–${formatDayLabel(to)}`;
}

// ─── Filter & Aggregation ───────────────────────────────────────────────────────

export function categoryOf(source: string | null | undefined): CategoryFilter | null {
  return source ? (SOURCE_CATEGORY[source] ?? null) : null;
}

export function matchesCategory(row: ProductSalesRow, category: CategoryFilter): boolean {
  if (category === 'all') return true;
  return categoryOf(row.source) === category;
}

/** Zeilen auf Periode + Kategorie eingrenzen. */
export function filterRows(
  rows: ProductSalesRow[],
  sel: PeriodSelection,
  category: CategoryFilter,
): ProductSalesRow[] {
  const { from, to } = periodBounds(sel);
  return rows.filter(
    (r) => r.sale_date >= from && r.sale_date <= to && matchesCategory(r, category),
  );
}

/** Pro Produkt aufsummieren (Rangliste). Keine Filter, keine Sortierung — rein. */
export function aggregateProducts(rows: ProductSalesRow[]): ProductAggregate[] {
  const map = new Map<string, ProductAggregate>();
  for (const r of rows) {
    const e = map.get(r.product_name);
    if (e) {
      e.total_revenue += num(r.revenue);
      e.total_qty += num(r.quantity);
    } else {
      map.set(r.product_name, {
        product_name: r.product_name,
        total_revenue: num(r.revenue),
        total_qty: num(r.quantity),
      });
    }
  }
  return Array.from(map.values());
}

/**
 * Pro Produkt nach Wochentag (Mo–So) der angegebenen ISO-Woche aufsummieren —
 * für die Wochen-Rangliste mit Wochentag-Spalten. Rein, keine Sortierung.
 *
 * Robust gegenüber ungefilterten Eingaben: berücksichtigt ausschliesslich Zeilen,
 * deren `sale_date` exakt auf einen der 7 Tage der ISO-Woche fällt (eine fremde
 * Woche mit gleichem Wochentag wird NICHT fälschlich eingeordnet).
 */
export function aggregateProductsByWeekday(
  rows: ProductSalesRow[],
  year: number,
  week: number,
): ProductWeekAggregate[] {
  const monday = isoWeekStart(year, week);
  const dates: string[] = [];
  const dateIndex = new Map<string, number>();
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday.getTime());
    day.setUTCDate(monday.getUTCDate() + i);
    const iso = toISO(day);
    dates.push(iso);
    dateIndex.set(iso, i);
  }

  const map = new Map<string, ProductWeekAggregate>();
  for (const r of rows) {
    const idx = dateIndex.get(r.sale_date);
    if (idx === undefined) continue; // ausserhalb dieser ISO-Woche
    let e = map.get(r.product_name);
    if (!e) {
      e = {
        product_name: r.product_name,
        days: dates.map((d, i) => ({ date: d, weekdayIndex: i, quantity: 0, revenue: 0 })),
        total_revenue: 0,
        total_qty: 0,
      };
      map.set(r.product_name, e);
    }
    e.days[idx].quantity += num(r.quantity);
    e.days[idx].revenue += num(r.revenue);
    e.total_qty += num(r.quantity);
    e.total_revenue += num(r.revenue);
  }
  return Array.from(map.values());
}

// ─── Drill-down Breakdown (ein Produkt) ─────────────────────────────────────────

function mkRow(
  key: string,
  label: string,
  qty: number,
  rev: number,
  denom: number,
  metric: Metric,
  extra?: Partial<BreakdownRow>,
): BreakdownRow {
  const metricVal = metric === 'revenue' ? rev : qty;
  return {
    key,
    label,
    quantity: qty,
    revenue: rev,
    share: denom > 0 ? metricVal / denom : 0,
    avgPrice: qty > 0 ? rev / qty : null,
    ...extra,
  };
}

function aggregateByDate(rows: ProductSalesRow[]): Map<string, { qty: number; rev: number }> {
  const m = new Map<string, { qty: number; rev: number }>();
  for (const r of rows) {
    const e = m.get(r.sale_date) ?? { qty: 0, rev: 0 };
    e.qty += num(r.quantity);
    e.rev += num(r.revenue);
    m.set(r.sale_date, e);
  }
  return m;
}

function monthDayBuckets(
  scoped: ProductSalesRow[], year: number, month: number, denom: number, metric: Metric,
): BreakdownRow[] {
  const byDate = aggregateByDate(scoped);
  const out: BreakdownRow[] = [];
  const days = daysInMonth(year, month);
  for (let d = 1; d <= days; d++) {
    const dateStr = `${year}-${pad2(month)}-${pad2(d)}`;
    const a = byDate.get(dateStr) ?? { qty: 0, rev: 0 };
    out.push(mkRow(dateStr, formatDayLabel(dateStr), a.qty, a.rev, denom, metric, {
      date: dateStr,
      subLabel: WEEKDAY_SHORT[weekdayIndexMonday(dateStr)],
    }));
  }
  return out;
}

/**
 * Von–Bis-Bereich: eine Zeile pro Tag (inkl. Null-Tage).
 * Sicherheitsgrenze 1000 Tage gegen absurde URL-Eingaben.
 */
function rangeDayBuckets(
  scoped: ProductSalesRow[], from: string, to: string, denom: number, metric: Metric,
): BreakdownRow[] {
  const byDate = aggregateByDate(scoped);
  const out: BreakdownRow[] = [];
  const end = parseISO(to).getTime();
  const cursor = parseISO(from);
  while (cursor.getTime() <= end && out.length < 1000) {
    const dateStr = toISO(cursor);
    const a = byDate.get(dateStr) ?? { qty: 0, rev: 0 };
    out.push(mkRow(dateStr, formatDayLabel(dateStr), a.qty, a.rev, denom, metric, {
      date: dateStr,
      subLabel: WEEKDAY_SHORT[weekdayIndexMonday(dateStr)],
    }));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function weekdayBuckets(
  scoped: ProductSalesRow[], year: number, week: number, denom: number, metric: Metric,
): BreakdownRow[] {
  const byDate = aggregateByDate(scoped);
  const monday = isoWeekStart(year, week);
  const out: BreakdownRow[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday.getTime());
    day.setUTCDate(monday.getUTCDate() + i);
    const dateStr = toISO(day);
    const a = byDate.get(dateStr) ?? { qty: 0, rev: 0 };
    out.push(mkRow(dateStr, WEEKDAY_NAMES[i], a.qty, a.rev, denom, metric, {
      date: dateStr,
      subLabel: formatDayShort(dateStr),
    }));
  }
  return out;
}

function monthBuckets(
  scoped: ProductSalesRow[], year: number, denom: number, metric: Metric,
): BreakdownRow[] {
  const byMonth = new Map<number, { qty: number; rev: number }>();
  for (const r of scoped) {
    const m = parseInt(r.sale_date.slice(5, 7), 10);
    const e = byMonth.get(m) ?? { qty: 0, rev: 0 };
    e.qty += num(r.quantity);
    e.rev += num(r.revenue);
    byMonth.set(m, e);
  }
  const out: BreakdownRow[] = [];
  for (let m = 1; m <= 12; m++) {
    const a = byMonth.get(m) ?? { qty: 0, rev: 0 };
    out.push(mkRow(`${year}-${pad2(m)}`, MONTH_NAMES[m - 1], a.qty, a.rev, denom, metric, {
      date: `${year}-${pad2(m)}-01`,
      subLabel: String(year),
    }));
  }
  return out;
}

/** Tagesansicht: ein Eintrag pro Quelle (gruppierte Zusammenfassung, keine Uhrzeiten). */
function dayEntryBuckets(
  scoped: ProductSalesRow[], denom: number, metric: Metric,
): BreakdownRow[] {
  const out = scoped.map((r) =>
    mkRow(
      `${r.sale_date}|${r.source ?? 'none'}`,
      r.source ?? '—',
      num(r.quantity),
      num(r.revenue),
      denom,
      metric,
      { date: r.sale_date, source: r.source },
    ),
  );
  out.sort((a, b) => (metric === 'revenue' ? b.revenue - a.revenue : b.quantity - a.quantity));
  return out;
}

/**
 * Aufschlüsselung eines einzelnen Produkts über die gewählte Periode.
 * - month → eine Zeile pro Tag des Monats (inkl. Null-Tage)
 * - week  → eine Zeile pro Wochentag Mo–So (inkl. Null-Tage)
 * - year  → eine Zeile pro Monat Jan–Dez (inkl. Null-Monate)
 * - day   → eine Zeile pro Quellen-Eintrag des Tages (oder leer)
 */
export function buildBreakdown(
  rows: ProductSalesRow[],
  productName: string,
  sel: PeriodSelection,
  category: CategoryFilter,
  metric: Metric,
): ProductBreakdown {
  const scoped = filterRows(rows, sel, category).filter((r) => r.product_name === productName);

  const totalRevenue = scoped.reduce((s, r) => s + num(r.revenue), 0);
  const totalQty = scoped.reduce((s, r) => s + num(r.quantity), 0);
  const salesCount = scoped.length;
  const denom = metric === 'revenue' ? totalRevenue : totalQty;

  let breakdownRows: BreakdownRow[];
  switch (sel.kind) {
    case 'month':
      breakdownRows = monthDayBuckets(scoped, sel.year, sel.month, denom, metric);
      break;
    case 'week':
      breakdownRows = weekdayBuckets(scoped, sel.year, sel.week, denom, metric);
      break;
    case 'year':
      breakdownRows = monthBuckets(scoped, sel.year, denom, metric);
      break;
    case 'day':
      breakdownRows = dayEntryBuckets(scoped, denom, metric);
      break;
    case 'range': {
      const { from, to } = periodBounds(sel);
      breakdownRows = rangeDayBuckets(scoped, from, to, denom, metric);
      break;
    }
  }

  return {
    productName,
    period: sel,
    periodLabel: periodLabel(sel),
    totalRevenue,
    totalQty,
    salesCount,
    avgRevenuePerSale: salesCount > 0 ? totalRevenue / salesCount : 0,
    metric,
    rows: breakdownRows,
  };
}

// ─── URL-Serialisierung (gemeinsam Rangliste ↔ Detailseite) ─────────────────────

function isPeriodKind(v: string | null): v is PeriodKind {
  return v === 'day' || v === 'week' || v === 'month' || v === 'year' || v === 'range';
}
function isCategory(v: string | null): v is CategoryFilter {
  return v === 'all' || v === 'food' || v === 'beverage';
}
function isValidISODate(v: string | null): v is string {
  return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** Filter → query-param Objekt (für navigate / setSearchParams). */
export function filtersToParams(f: AnalysisFilters): Record<string, string> {
  const p: Record<string, string> = {
    period: f.period.kind,
    cat: f.category,
    metric: f.metric,
  };
  switch (f.period.kind) {
    case 'day':
      p.date = f.period.date;
      break;
    case 'week':
      p.year = String(f.period.year);
      p.week = String(f.period.week);
      break;
    case 'month':
      p.year = String(f.period.year);
      p.month = String(f.period.month);
      break;
    case 'year':
      p.year = String(f.period.year);
      break;
    case 'range':
      p.from = f.period.from;
      p.to = f.period.to;
      break;
  }
  return p;
}

/**
 * query-param getter → Filter, mit robusten Defaults auf "heute".
 * `get` ist typischerweise `(k) => searchParams.get(k)`.
 */
export function filtersFromParams(
  get: (key: string) => string | null,
  today: Date = new Date(),
): AnalysisFilters {
  const kindRaw = get('period');
  const kind: PeriodKind = isPeriodKind(kindRaw) ? kindRaw : 'month';

  const catRaw = get('cat');
  const category: CategoryFilter = isCategory(catRaw) ? catRaw : 'all';

  const metric: Metric = get('metric') === 'qty' ? 'qty' : 'revenue';

  const curYear = today.getFullYear();
  const curMonth = today.getMonth() + 1;
  const yearN = parseInt(get('year') ?? '', 10);
  const monthN = parseInt(get('month') ?? '', 10);
  const weekN = parseInt(get('week') ?? '', 10);
  const dateRaw = get('date');

  let period: PeriodSelection;
  switch (kind) {
    case 'day':
      period = { kind: 'day', date: isValidISODate(dateRaw) ? dateRaw : localISODate(today) };
      break;
    case 'week': {
      const fallback = isoWeekInfo(localISODate(today));
      period = {
        kind: 'week',
        year: Number.isFinite(yearN) && yearN > 0 ? yearN : fallback.year,
        week: weekN >= 1 && weekN <= 53 ? weekN : fallback.week,
      };
      break;
    }
    case 'year':
      period = { kind: 'year', year: Number.isFinite(yearN) && yearN > 0 ? yearN : curYear };
      break;
    case 'range': {
      const fromRaw = get('from');
      const toRaw = get('to');
      if (isValidISODate(fromRaw) && isValidISODate(toRaw)) {
        period = fromRaw <= toRaw
          ? { kind: 'range', from: fromRaw, to: toRaw }
          : { kind: 'range', from: toRaw, to: fromRaw };
      } else {
        // Unvollständiger/ungültiger Bereich → robuster Monats-Default
        period = { kind: 'month', year: curYear, month: curMonth };
      }
      break;
    }
    default:
      period = {
        kind: 'month',
        year: Number.isFinite(yearN) && yearN > 0 ? yearN : curYear,
        month: monthN >= 1 && monthN <= 12 ? monthN : curMonth,
      };
  }

  return { period, category, metric };
}
