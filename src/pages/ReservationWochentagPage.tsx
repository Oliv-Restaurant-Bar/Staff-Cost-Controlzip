/**
 * ReservationWochentagPage — Reservationen nach Wochentag
 * ========================================================
 * Admin-only Management-Dashboard: an welchen Wochentagen wird am meisten/
 * wenigsten reserviert?  Für einen frei wählbaren Zeitraum (mit Schnell-Auswahl
 * inkl. anpassbarer Saisons + Monatsnavigation) zeigt die Seite:
 *
 *  1. Umschalter (Reservationen / Personen / Personen pro Reservation).
 *  2. Erklärbox: was die grosse Durchschnittszahl je Wochentag bedeutet.
 *  3. Drei Kennzahlen-Karten: stärkster / schwächster Wochentag (nach Modus)
 *     sowie der Referenz-Durchschnitt für „über/unter Durchschnitt".
 *  4. Je Wochentag eine kompakte Karte: EINE grosse, modusabhängige Durch-
 *     schnittszahl (Ø pro Wochentag bzw. Ø pro Reservation), darunter klein die
 *     übrigen Werte + ein Mini-Balken + eine klare Einordnung (stärkster/
 *     schwächster Wochentag, über/unter Durchschnitt).
 *  5. Monatsvergleich: kompakter Block für den aktuell gewählten Monat, die
 *     detaillierte Tabelle (alle Monate × Wochentage) liegt hinter einem Button
 *     und ist standardmässig eingeklappt.
 *
 * Liest ausschliesslich aus der bestehenden Tabelle `reservation_records`
 * (mandantengefiltert via `fetchReservationsInRange`) — KEINE neue Migration,
 * KEINE Schreibzugriffe.  Berechnung in `reservation-weekday-analytics.ts`.
 * Saisons werden pro Mandant in localStorage gehalten (frei anpassbar).
 *
 * Datenschutz: nur für Admins (nicht für Gast-Sessions) erreichbar — Route-Guard
 * UND Lade-Effekt sind doppelt abgesichert.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import {
  CalendarRange, Loader2, Database, ArrowLeft, TrendingUp, TrendingDown,
  CalendarDays, Settings2, RotateCcw, Check, Minus, Info,
  ChevronLeft, ChevronRight, ChevronDown, ChevronUp,
} from 'lucide-react';
import { format as fmtDate } from 'date-fns';
import { useNavigate, Navigate, useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { fetchReservationsInRange } from '@/lib/reservation-crm-db';
import { checkReservationTablesExist } from '@/lib/reservation-import-db';
import type { ReservationDetailRow } from '@/lib/reservation-dashboard';
import { MonthWeekdayDetailDialog } from '@/components/crm/MonthWeekdayDetailDialog';
import {
  aggregateByWeekday, buildWeekdayHeadlines, buildMonthComparison,
  buildMonthComparisonInsights, comparisonCellSubLabel, buildMonthWeekdayDetail,
  presetRange, monthLongLabel, monthKeyOf, monthRange, shiftMonthKey,
  parseSeasonSettings, serializeSeasonSettings, normalizeSeasonRange,
  DEFAULT_SEASON_SETTINGS,
  WEEKDAY_LABEL, WEEKDAY_SHORT, ISO_WEEKDAYS, PRESET_LABEL, STATUS_SCOPE_LABEL,
  METRICS, METRIC_LABEL,
  weekdayOccurrenceLabel, headlineLabel, AVG_PERSONS_PER_RESERVATION_LABEL,
  WEEKDAY_RANK_LABEL, MONTH_COMPARISON_DEFAULT_OPEN,
  type PresetKey, type StatusScope, type MetricKey, type IsoWeekday,
  type SeasonSettings, type SeasonRange,
  type WeekdayHeadline, type WeekdayRank,
  type ComparisonRank, type ComparisonMonthRow, type ComparisonCell,
} from '@/lib/reservation-weekday-analytics';

// ── Formatierung ──────────────────────────────────────────────────────────────

const NUM0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const NUM1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function avg(n: number | null): string {
  return n === null ? '—' : NUM1.format(n);
}

const PRESETS: PresetKey[] = ['thisMonth', 'lastMonth', 'octDec', 'winter', 'summer', 'custom'];
const STATUS_SCOPES: StatusScope[] = ['booked', 'active', 'all'];
const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const SEASON_PRESETS: PresetKey[] = ['octDec', 'winter', 'summer'];

const seasonsKey = (tenantId: string) => `pkt:reservation-weekday-seasons:${tenantId}`;

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

// Subtile Hintergrund-Einfärbung einer Vergleichszelle je Einordnung.
const CMP_CELL_BG: Record<ComparisonRank, string> = {
  above: 'bg-emerald-50 dark:bg-emerald-950/20',
  below: 'bg-amber-50 dark:bg-amber-950/20',
  average: '',
  none: '',
};

// Stilvarianten je Einordnung (Badge, grosse Zahl, Mini-Balken).
const RANK_STYLES: Record<WeekdayRank, { badge: string; big: string; bar: string }> = {
  strongest: {
    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
    big: 'text-emerald-600 dark:text-emerald-400',
    bar: 'bg-emerald-500',
  },
  above: {
    badge: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300',
    big: 'text-foreground',
    bar: 'bg-emerald-400/70',
  },
  average: {
    badge: 'bg-muted text-muted-foreground',
    big: 'text-foreground',
    bar: 'bg-primary/50',
  },
  below: {
    badge: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300',
    big: 'text-foreground',
    bar: 'bg-amber-400/70',
  },
  weakest: {
    badge: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
    big: 'text-red-600 dark:text-red-400',
    bar: 'bg-red-500',
  },
  none: {
    badge: 'bg-muted text-muted-foreground',
    big: 'text-muted-foreground',
    bar: 'bg-muted',
  },
};

/**
 * Sekundärwerte (Label + Wert) einer Wochentags-Karte je Modus.  Die grosse
 * Zahl ist immer ein Durchschnitt; hier stehen darunter die übrigen Werte.
 */
function subValues(h: WeekdayHeadline, metric: MetricKey): { label: string; value: string }[] {
  const occ = { label: weekdayOccurrenceLabel(h.weekday), value: NUM0.format(h.occurrences) };
  const res = { label: 'Reservationen total', value: NUM0.format(h.reservations) };
  const per = { label: 'Personen total', value: NUM0.format(h.persons) };
  const avgP = { label: AVG_PERSONS_PER_RESERVATION_LABEL, value: avg(h.avgPersons) };
  switch (metric) {
    case 'persons':
      return [per, res, occ, avgP];
    case 'avgPersons':
      return [res, per, occ];
    case 'reservations':
    default:
      return [res, occ, per, avgP];
  }
}

// ── Initialer Anzeigezustand aus der URL ───────────────────────────────────────

interface InitView {
  preset: PresetKey;
  from: string;
  to: string;
  scope: StatusScope;
  year: number;
  metric: MetricKey;
}

function parseInit(sp: URLSearchParams, todayStr: string, currentYear: number): InitView {
  const f = sp.get('f');
  const t = sp.get('t');
  const presetRaw = sp.get('p') as PresetKey | null;
  const scopeRaw = sp.get('sc') as StatusScope | null;
  const yearRaw = Number(sp.get('y'));
  const metricRaw = sp.get('m') as MetricKey | null;

  const scope: StatusScope =
    scopeRaw === 'active' || scopeRaw === 'all' || scopeRaw === 'booked' ? scopeRaw : 'booked';
  const year = Number.isInteger(yearRaw) && yearRaw >= 2000 && yearRaw <= 2100 ? yearRaw : currentYear;
  const metric: MetricKey =
    metricRaw && METRICS.includes(metricRaw) ? metricRaw : 'reservations';

  // Konkrete Datumsgrenzen aus der URL haben Vorrang (refresh-fest). Ohne sie
  // greift der Standard „Dieser Monat".
  if (f && t && /^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const preset: PresetKey = presetRaw && PRESETS.includes(presetRaw) ? presetRaw : 'custom';
    return { preset, from: f, to: t, scope, year, metric };
  }
  const range = presetRange('thisMonth', { today: todayStr, year, seasons: DEFAULT_SEASON_SETTINGS })!;
  return { preset: 'thisMonth', from: range.from, to: range.to, scope, year, metric };
}

// ── Kleine Bausteine ───────────────────────────────────────────────────────────

function SummaryCard({ icon: Icon, label, value, sub, accent }: {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5 flex-shrink-0" />
        {label}
      </div>
      <p className={cn('mt-1 text-xl font-bold', accent)}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SectionTitle({ icon: Icon, children }: { icon: React.FC<{ className?: string }>; children: React.ReactNode }) {
  return (
    <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
      <Icon className="h-5 w-5 text-primary" />
      {children}
    </h2>
  );
}

/** Kompakte Karte je Wochentag: grosse Ø-Zahl (modusabhängig) + Einordnung. */
function WeekdayCard({ h, metric, maxValue }: {
  h: WeekdayHeadline;
  metric: MetricKey;
  maxValue: number;
}) {
  const style = RANK_STYLES[h.rank];
  const big = h.rank === 'none' ? '—' : avg(h.value);
  const barPct = maxValue > 0 && h.value ? Math.max((h.value / maxValue) * 100, 2) : 0;
  const subs = subValues(h, metric);

  return (
    <div className={cn('rounded-lg border border-border p-3', h.rank === 'none' ? 'bg-muted/20' : 'bg-card')}>
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold">{WEEKDAY_LABEL[h.weekday]}</span>
        <span className={cn('whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium', style.badge)}>
          {WEEKDAY_RANK_LABEL[h.rank]}
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-tight text-muted-foreground">{headlineLabel(h.weekday, metric)}</p>
      <p className={cn('text-2xl font-bold tabular-nums', style.big)}>{big}</p>

      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full transition-all', style.bar)} style={{ width: `${barPct}%` }} />
      </div>

      <dl className="mt-2.5 space-y-1 text-[11px]">
        {subs.map((s) => (
          <div key={s.label} className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">{s.label}</dt>
            <dd className="tabular-nums font-medium">{s.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ── Komponente ────────────────────────────────────────────────────────────────

export default function ReservationWochentagPage() {
  const { tenantId } = useTenant();
  const { isAdmin, isGuest } = usePermissions();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const today = useMemo(() => new Date(), []);
  const todayStr = useMemo(() => fmtDate(today, 'yyyy-MM-dd'), [today]);
  const currentYear = today.getFullYear();

  // Anzeigezustand EINMALIG aus der URL lesen (refresh-fest).
  const initRef = useRef<InitView | null>(null);
  if (initRef.current === null) initRef.current = parseInit(searchParams, todayStr, currentYear);
  const init = initRef.current;

  const [preset, setPreset] = useState<PresetKey>(init.preset);
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const [scope, setScope] = useState<StatusScope>(init.scope);
  const [year, setYear] = useState(init.year);
  const [metric, setMetric] = useState<MetricKey>(init.metric);

  // Monatsvergleich-Matrix: standardmässig eingeklappt (siehe Konstante).
  const [showComparison, setShowComparison] = useState(MONTH_COMPARISON_DEFAULT_OPEN);
  // Fokus-Wochentag für den Spalten-Vergleich (Mini-Balken je Monat). Default Mo.
  const [focusWeekday, setFocusWeekday] = useState<IsoWeekday>(1);
  // Detail-Popup: geklickte Vergleichszelle (Monat × Wochentag) oder null.
  const [detailCell, setDetailCell] = useState<{ monthKey: string; weekday: IsoWeekday } | null>(null);

  // Saisons je Mandant aus localStorage (frei anpassbar).
  const [seasons, setSeasons] = useState<SeasonSettings>(DEFAULT_SEASON_SETTINGS);
  useEffect(() => {
    setSeasons(parseSeasonSettings(safeGet(seasonsKey(tenantId))));
  }, [tenantId]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<SeasonSettings>(DEFAULT_SEASON_SETTINGS);

  const [tablesOk, setTablesOk] = useState<boolean | null>(null);
  const [rows, setRows] = useState<ReservationDetailRow[]>([]);
  const [loading, setLoading] = useState(true);

  const rangeInvalid = !from || !to || from > to;

  // Tabellen-Existenz EINMALIG prüfen.
  useEffect(() => {
    if (!isAdmin || isGuest) return;
    let alive = true;
    void checkReservationTablesExist().then((ok) => { if (alive) setTablesOk(ok); });
    return () => { alive = false; };
  }, [isAdmin, isGuest]);

  // Reservationen für den gewählten Zeitraum laden (mandantengefiltert).
  useEffect(() => {
    if (!isAdmin || isGuest) { setLoading(false); return; }
    if (tablesOk === null) return;            // auf Tabellen-Prüfung warten
    if (tablesOk === false) { setRows([]); setLoading(false); return; }
    if (rangeInvalid) { setRows([]); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    void fetchReservationsInRange(tenantId, from, to).then((data) => {
      if (alive) { setRows(data); setLoading(false); }
    });
    return () => { alive = false; };
  }, [tenantId, isAdmin, isGuest, tablesOk, from, to, rangeInvalid]);

  // ── Berechnungen ─────────────────────────────────────────────────────────────
  const agg = useMemo(
    () => aggregateByWeekday(rows, from, to, scope),
    [rows, from, to, scope],
  );
  const headlines = useMemo(
    () => buildWeekdayHeadlines(agg, metric),
    [agg, metric],
  );
  // Kompakte Vergleichsmatrix (Monate × Wochentage) für die gewählte Kennzahl.
  const comparison = useMemo(
    () => buildMonthComparison(rows, from, to, scope, metric),
    [rows, from, to, scope, metric],
  );
  // 3–5 kurze, modusabhängige Insights über der Matrix.
  const insights = useMemo(
    () => buildMonthComparisonInsights(headlines, comparison, focusWeekday, metric),
    [headlines, comparison, focusWeekday, metric],
  );

  // Aktuell betrachteter Monat (Monatsnavigation) = Monat des „Von"-Datums.
  const currentMonthKey = monthKeyOf(from) ?? todayStr.slice(0, 7);
  const currentMonthBounds = monthRange(currentMonthKey);
  const isSingleMonth =
    !!currentMonthBounds.from && from === currentMonthBounds.from && to === currentMonthBounds.to;

  // Fokus-Wochentag: Spalten-Statistik + Mini-Balken-Werte je Monat.
  const focusCol = comparison.columns[focusWeekday];
  const focusValues = comparison.months.map((m) => ({
    monthKey: m.monthKey,
    value: m.cells[focusWeekday].value,
  }));
  const focusMax = Math.max(0, ...focusValues.map((f) => f.value ?? 0));

  // Detail-Popup: Aufschlüsselung + Spalten-Ø der geklickten Zelle.
  const detail = useMemo(
    () =>
      detailCell
        ? buildMonthWeekdayDetail(rows, from, to, detailCell.monthKey, detailCell.weekday, scope)
        : null,
    [detailCell, rows, from, to, scope],
  );
  const detailColumnAverage = detailCell ? comparison.columns[detailCell.weekday].average : null;
  const openDetail = (cell: ComparisonCell) =>
    setDetailCell({ monthKey: cell.monthKey, weekday: cell.weekday });

  // Grösster Hauptwert (für die Mini-Balken-Skalierung).
  const maxHeadline = useMemo(
    () => Math.max(0, ...headlines.headlines.map((h) => h.value ?? 0)),
    [headlines],
  );

  // ── Aktionen ─────────────────────────────────────────────────────────────────
  const applyPreset = (key: PresetKey) => {
    setPreset(key);
    if (key === 'custom') return; // Datumsfelder bleiben frei wählbar
    const range = presetRange(key, { today: todayStr, year, seasons });
    if (range) { setFrom(range.from); setTo(range.to); }
  };

  // Monatsnavigation: setzt Von/Bis auf Anfang/Ende des Zielmonats.
  const goToMonth = (monthKey: string) => {
    const range = monthRange(monthKey);
    if (!range.from) return;
    setFrom(range.from);
    setTo(range.to);
    const tm = presetRange('thisMonth', { today: todayStr, year, seasons });
    const lm = presetRange('lastMonth', { today: todayStr, year, seasons });
    if (tm && range.from === tm.from && range.to === tm.to) setPreset('thisMonth');
    else if (lm && range.from === lm.from && range.to === lm.to) setPreset('lastMonth');
    else setPreset('custom');
  };
  const goPrevMonth = () => goToMonth(shiftMonthKey(currentMonthKey, -1));
  const goNextMonth = () => goToMonth(shiftMonthKey(currentMonthKey, 1));

  const changeYear = (y: number) => {
    setYear(y);
    if (SEASON_PRESETS.includes(preset)) {
      const range = presetRange(preset, { today: todayStr, year: y, seasons });
      if (range) { setFrom(range.from); setTo(range.to); }
    }
  };

  const persistSeasons = (next: SeasonSettings) => {
    setSeasons(next);
    safeSet(seasonsKey(tenantId), serializeSeasonSettings(next));
    if (preset === 'winter' || preset === 'summer') {
      const range = presetRange(preset, { today: todayStr, year, seasons: next });
      if (range) { setFrom(range.from); setTo(range.to); }
    }
  };

  const openEditor = () => { setDraft(seasons); setEditorOpen(true); };
  const saveEditor = () => { persistSeasons(draft); setEditorOpen(false); };
  const resetEditor = () => setDraft(DEFAULT_SEASON_SETTINGS);

  const editFrom = (v: string) => { setFrom(v); setPreset('custom'); };
  const editTo = (v: string) => { setTo(v); setPreset('custom'); };

  // ── URL-Spiegelung ───────────────────────────────────────────────────────────
  useEffect(() => {
    const next = new URLSearchParams();
    next.set('p', preset);
    next.set('f', from);
    next.set('t', to);
    next.set('sc', scope);
    next.set('y', String(year));
    next.set('m', metric);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [preset, from, to, scope, year, metric, searchParams, setSearchParams]);

  if (!isAdmin || isGuest) return <Navigate to="/" replace />;

  const hasData = agg.totalReservations > 0;
  const yearRelevant = SEASON_PRESETS.includes(preset);

  const strongestH = headlines.headlines.find((h) => h.weekday === headlines.strongest) ?? null;
  const weakestH = headlines.headlines.find((h) => h.weekday === headlines.weakest) ?? null;
  const scopeLabel = isSingleMonth
    ? monthLongLabel(currentMonthKey)
    : `${from} – ${to}`;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      {/* Kopf */}
      <div className="space-y-2">
        <button
          onClick={() => navigate('/gaeste')}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Zurück zur Gästeliste
        </button>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <CalendarRange className="h-6 w-6 text-primary" />
            Reservationen nach Wochentag
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            An welchen Wochentagen wird am meisten reserviert? Frei wählbarer
            Zeitraum, berechnet aus den importierten Reservationen
            ({tenantId === 'beaulieu' ? 'Beaulieu' : 'Oliv'}).
          </p>
        </div>
      </div>

      {tablesOk === false && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
          <Database className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            Die Reservationstabellen existieren noch nicht. Bitte zuerst die
            Migration ausführen und Reservationen importieren.
          </span>
        </div>
      )}

      {/* ── Filter ──────────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-4">
        {/* Schnell-Auswahl */}
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Schnell-Auswahl
          </p>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => applyPreset(key)}
                aria-pressed={preset === key}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-sm transition-colors',
                  preset === key
                    ? 'border-primary bg-primary/10 font-medium text-primary'
                    : 'border-border hover:border-primary/60 hover:bg-muted/40',
                )}
              >
                {PRESET_LABEL[key]}
              </button>
            ))}
          </div>
        </div>

        {/* Monatsnavigation + Zeitraum + Jahr + Status */}
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Monat</label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={goPrevMonth}
                className="rounded-md border border-border p-1.5 hover:bg-muted/40"
                aria-label="Vorheriger Monat"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[8.5rem] text-center text-sm font-medium">
                {monthLongLabel(currentMonthKey)}
              </span>
              <button
                type="button"
                onClick={goNextMonth}
                className="rounded-md border border-border p-1.5 hover:bg-muted/40"
                aria-label="Nächster Monat"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Von</label>
            <input
              type="date"
              value={from}
              onChange={(e) => editFrom(e.target.value)}
              className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Bis</label>
            <input
              type="date"
              value={to}
              onChange={(e) => editTo(e.target.value)}
              className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Jahr {yearRelevant ? '' : '(für Saison-Auswahl)'}
            </label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => changeYear(year - 1)}
                className="rounded-md border border-border px-2 py-1.5 text-sm hover:bg-muted/40"
                aria-label="Jahr zurück"
              >
                ◀
              </button>
              <span className="min-w-[3.5rem] text-center text-sm font-medium tabular-nums">{year}</span>
              <button
                type="button"
                onClick={() => changeYear(year + 1)}
                className="rounded-md border border-border px-2 py-1.5 text-sm hover:bg-muted/40"
                aria-label="Jahr vor"
              >
                ▶
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Status</label>
            <div className="inline-flex rounded-md border border-border p-0.5">
              {STATUS_SCOPES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  aria-pressed={scope === s}
                  className={cn(
                    'rounded px-2.5 py-1 text-xs transition-colors',
                    scope === s ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/40',
                  )}
                >
                  {STATUS_SCOPE_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={editorOpen ? () => setEditorOpen(false) : openEditor}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/40"
          >
            <Settings2 className="h-4 w-4" />
            Saisons anpassen
          </button>
        </div>

        {rangeInvalid && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Bitte einen gültigen Zeitraum wählen (Von darf nicht nach Bis liegen).
          </p>
        )}

        {/* Saison-Editor */}
        {editorOpen && (
          <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              Saison-Zeiträume sind frei anpassbar (werden pro Mandant gespeichert).
              Liegt das Ende vor dem Beginn, läuft die Saison ins Folgejahr
              (z. B. Winter Okt → Mär).
            </p>
            {(['winter', 'summer'] as const).map((key) => (
              <SeasonEditorRow
                key={key}
                label={key === 'winter' ? 'Wintersaison' : 'Sommersaison'}
                value={draft[key]}
                onChange={(next) => setDraft((d) => ({ ...d, [key]: next }))}
              />
            ))}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={saveEditor}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Check className="h-4 w-4" />
                Speichern
              </button>
              <button
                type="button"
                onClick={resetEditor}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/40"
              >
                <RotateCcw className="h-4 w-4" />
                Standard
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── Umschalter: Auswertungs-Kennzahl ────────────────────────────────── */}
      <section className="rounded-lg border border-border bg-card p-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Auswertung nach
        </p>
        <div className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-muted/30 p-1">
          {METRICS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMetric(m)}
              aria-pressed={metric === m}
              className={cn(
                'rounded-md px-4 py-2 text-sm font-medium transition-colors',
                metric === m
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-muted/60',
              )}
            >
              {METRIC_LABEL[m]}
            </button>
          ))}
        </div>
      </section>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Auswertung wird geladen…
        </div>
      ) : !hasData ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Keine Reservationen im gewählten Zeitraum.
        </div>
      ) : (
        <>
          {/* ── Erklärbox ─────────────────────────────────────────────────── */}
          <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p>
              Die grosse Zahl je Wochentag ist ein <strong>Durchschnitt</strong>,
              der sich auf genau diesen Wochentag bezieht. Beispiel: Hat ein Monat
              4&nbsp;Montage und es gab an Montagen total 47&nbsp;Reservationen,
              ergibt das Ø&nbsp;11.8&nbsp;Reservationen pro Montag (47&nbsp;÷&nbsp;4).
            </p>
          </div>

          {/* ── Kennzahlen-Karten (stärkster / schwächster / Referenz) ──────── */}
          <section>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <SummaryCard
                icon={TrendingUp}
                label="Stärkster Wochentag"
                value={strongestH ? WEEKDAY_LABEL[strongestH.weekday] : '—'}
                sub={strongestH ? `${headlineLabel(strongestH.weekday, metric)}: ${avg(strongestH.value)}` : undefined}
                accent="text-emerald-600 dark:text-emerald-400"
              />
              <SummaryCard
                icon={TrendingDown}
                label="Schwächster Wochentag"
                value={weakestH ? WEEKDAY_LABEL[weakestH.weekday] : '—'}
                sub={weakestH ? `${headlineLabel(weakestH.weekday, metric)}: ${avg(weakestH.value)}` : undefined}
                accent="text-red-600 dark:text-red-400"
              />
              <SummaryCard
                icon={Minus}
                label="Durchschnitt aller Wochentage"
                value={avg(headlines.average)}
                sub='Referenz für „über / unter Durchschnitt"'
              />
            </div>
          </section>

          {/* ── Kompakte Karten je Wochentag ───────────────────────────────── */}
          <section>
            <SectionTitle icon={CalendarDays}>Auswertung nach Wochentag</SectionTitle>
            <p className="mb-2 text-xs text-muted-foreground">
              Zeitraum: <span className="font-medium text-foreground">{scopeLabel}</span>.
              {' '}Grosse Zahl ={' '}
              <span className="font-medium text-foreground">{METRIC_LABEL[metric]}</span>{' '}
              als Durchschnitt pro Wochentag.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {headlines.headlines.map((h) => (
                <WeekdayCard key={h.weekday} h={h} metric={metric} maxValue={maxHeadline} />
              ))}
            </div>
          </section>

          {/* ── Monatsvergleich ────────────────────────────────────────────── */}
          <section>
            <SectionTitle icon={CalendarRange}>Monatsvergleich</SectionTitle>
            <p className="mb-2 text-xs text-muted-foreground">
              Monate im Vergleich — grosse Zahl ={' '}
              <span className="font-medium text-foreground">{METRIC_LABEL[metric]}</span>{' '}
              als Durchschnitt pro Wochentag.
            </p>

            <button
              type="button"
              onClick={() => setShowComparison((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/40"
              aria-expanded={showComparison}
            >
              {showComparison ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {showComparison ? 'Monatsvergleich ausblenden' : 'Monatsvergleich anzeigen'}
            </button>

            {showComparison && (comparison.months.length === 0 ? (
              <div className="mt-3 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
                Keine Reservationen im gewählten Zeitraum.
              </div>
            ) : (
              <div className="mt-3 space-y-4">
                {/* Insights über der Matrix */}
                {insights.length > 0 && (
                  <ul className="space-y-1 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
                    {insights.map((s, i) => (
                      <li key={i} className="flex gap-2">
                        <span aria-hidden className="text-blue-400">•</span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {/* Kompakte Matrix: Monate (Zeilen) × Wochentage (Spalten) */}
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full border-collapse text-sm">
                    <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left">Monat</th>
                        {ISO_WEEKDAYS.map((wd) => (
                          <th key={wd} className="px-2 py-2 text-center">{WEEKDAY_SHORT[wd]}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.months.map((m) => (
                        <tr key={m.monthKey} className="border-t border-border align-top">
                          <th
                            scope="row"
                            title={monthTooltip(m)}
                            className="whitespace-nowrap border-r border-border px-3 py-2 text-left font-medium"
                          >
                            {monthLongLabel(m.monthKey)}
                            <span className="mt-0.5 block text-[10px] font-normal tabular-nums text-muted-foreground">
                              {NUM0.format(m.totalReservations)} Res. · {NUM0.format(m.totalPersons)} Pers.
                            </span>
                          </th>
                          {ISO_WEEKDAYS.map((wd) => (
                            <ComparisonMatrixCell key={wd} cell={m.cells[wd]} metric={metric} onSelect={openDetail} />
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Farbe = über (grün) / unter (gelb) dem Schnitt dieses Wochentags über alle Monate.
                  {' '}<span className="font-medium text-emerald-600 dark:text-emerald-400">Top</span>{' / '}
                  <span className="font-medium text-red-600 dark:text-red-400">Tief</span>{' '}
                  = bester / schwächster Monat je Wochentag.
                </p>

                {/* Wochentag-Fokus: ein Wochentag über alle Monate verglichen */}
                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">Wochentag vergleichen:</span>
                    {ISO_WEEKDAYS.map((wd) => (
                      <button
                        key={wd}
                        type="button"
                        onClick={() => setFocusWeekday(wd)}
                        aria-pressed={focusWeekday === wd}
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-sm transition-colors',
                          focusWeekday === wd
                            ? 'border-primary bg-primary/10 font-medium text-primary'
                            : 'border-border hover:border-primary/60 hover:bg-muted/40',
                        )}
                      >
                        {WEEKDAY_SHORT[wd]}
                      </button>
                    ))}
                  </div>

                  <p className="mt-2 text-xs text-muted-foreground">
                    {headlineLabel(focusWeekday, metric)} — Vergleich über die Monate.
                  </p>

                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <FocusStat
                      label="Bester Monat"
                      accent="text-emerald-600 dark:text-emerald-400"
                      month={focusCol.best ? monthLongLabel(focusCol.best.monthKey) : null}
                      value={focusCol.best ? NUM1.format(focusCol.best.value) : null}
                    />
                    <FocusStat
                      label="Schwächster Monat"
                      accent="text-red-600 dark:text-red-400"
                      month={focusCol.worst ? monthLongLabel(focusCol.worst.monthKey) : null}
                      value={focusCol.worst ? NUM1.format(focusCol.worst.value) : null}
                    />
                    <FocusStat
                      label="Ø über alle Monate"
                      accent="text-foreground"
                      month={null}
                      value={focusCol.average !== null ? NUM1.format(focusCol.average) : null}
                    />
                  </div>

                  {/* Mini-Balken je Monat für den Fokus-Wochentag */}
                  <div className="mt-3 space-y-1.5">
                    {focusValues.map((f) => (
                      <div key={f.monthKey} className="flex items-center gap-2">
                        <span className="w-28 flex-shrink-0 truncate text-xs text-muted-foreground">
                          {monthLongLabel(f.monthKey)}
                        </span>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                          {f.value !== null && focusMax > 0 && (
                            <div
                              className="h-full rounded-full bg-primary/60"
                              style={{ width: `${Math.max(2, (f.value / focusMax) * 100)}%` }}
                            />
                          )}
                        </div>
                        <span className="w-12 flex-shrink-0 text-right text-xs font-medium tabular-nums">
                          {f.value !== null ? NUM1.format(f.value) : '–'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </section>
        </>
      )}

      <MonthWeekdayDetailDialog
        open={detailCell !== null}
        onOpenChange={(o) => { if (!o) setDetailCell(null); }}
        detail={detail}
        metric={metric}
        columnAverage={detailColumnAverage}
      />
    </div>
  );
}

// ── Monatsvergleich-Bausteine ──────────────────────────────────────────────────

/** Tooltip-Text für den Zeilenkopf eines Monats (Totale + stärkster/schwächster). */
function monthTooltip(m: ComparisonMonthRow): string {
  const parts = [
    `${NUM0.format(m.totalReservations)} Reservationen`,
    `${NUM0.format(m.totalPersons)} Personen`,
    `Ø ${avg(m.avgPersons)} Pers./Res.`,
  ];
  if (m.strongestWeekday) parts.push(`Stärkster: ${WEEKDAY_LABEL[m.strongestWeekday]}`);
  if (m.weakestWeekday) parts.push(`Schwächster: ${WEEKDAY_LABEL[m.weakestWeekday]}`);
  return parts.join(' · ');
}

/** Eine Matrix-Zelle: grosse Ø-Zahl + Sekundärzeile + Farbe/Top/Tief je Einordnung. */
function ComparisonMatrixCell({ cell, metric, onSelect }: {
  cell: ComparisonCell;
  metric: MetricKey;
  onSelect: (cell: ComparisonCell) => void;
}) {
  if (cell.value === null) {
    return <td className="border-l border-border px-2 py-2 text-center text-muted-foreground">–</td>;
  }
  return (
    <td
      className={cn(
        'border-l border-border px-2 py-2 text-center align-top cursor-pointer transition-colors hover:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60',
        CMP_CELL_BG[cell.rank],
      )}
      role="button"
      tabIndex={0}
      title="Details anzeigen"
      aria-label={`Details anzeigen: ${WEEKDAY_LABEL[cell.weekday]} im ${monthLongLabel(cell.monthKey)}`}
      onClick={() => onSelect(cell)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(cell);
        }
      }}
    >
      <div className="flex items-center justify-center gap-1">
        <span className="text-base font-semibold tabular-nums">{NUM1.format(cell.value)}</span>
        {cell.isTop && (
          <span className="rounded bg-emerald-100 px-1 text-[9px] font-semibold uppercase text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
            Top
          </span>
        )}
        {cell.isLow && (
          <span className="rounded bg-red-100 px-1 text-[9px] font-semibold uppercase text-red-700 dark:bg-red-950/50 dark:text-red-300">
            Tief
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
        {comparisonCellSubLabel(cell, metric)}
      </div>
    </td>
  );
}

/** Kleine Kennzahl-Kachel im Wochentag-Fokus (Bester/Schwächster Monat, Ø). */
function FocusStat({ label, month, value, accent }: {
  label: string;
  month: string | null;
  value: string | null;
  accent?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-background p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-lg font-bold tabular-nums', accent)}>
        {value !== null ? `Ø ${value}` : '–'}
      </p>
      {month && <p className="text-[11px] text-muted-foreground">{month}</p>}
    </div>
  );
}

// ── Saison-Editor-Zeile ────────────────────────────────────────────────────────

function SeasonEditorRow({ label, value, onChange }: {
  label: string;
  value: SeasonRange;
  onChange: (next: SeasonRange) => void;
}) {
  const set = (patch: Partial<SeasonRange>) => onChange(normalizeSeasonRange({ ...value, ...patch }));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-28 text-sm font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">von</span>
      <MonthSelect value={value.startMonth} onChange={(m) => set({ startMonth: m })} />
      <DayInput value={value.startDay} onChange={(d) => set({ startDay: d })} />
      <span className="text-xs text-muted-foreground">bis</span>
      <MonthSelect value={value.endMonth} onChange={(m) => set({ endMonth: m })} />
      <DayInput value={value.endDay} onChange={(d) => set({ endDay: d })} />
    </div>
  );
}

function MonthSelect({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-md border border-input bg-background px-2 py-1 text-sm"
    >
      {MONTHS.map((name, i) => (
        <option key={i} value={i + 1}>{name}</option>
      ))}
    </select>
  );
}

function DayInput({ value, onChange }: { value: number; onChange: (d: number) => void }) {
  return (
    <input
      type="number"
      min={1}
      max={31}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm tabular-nums"
    />
  );
}
