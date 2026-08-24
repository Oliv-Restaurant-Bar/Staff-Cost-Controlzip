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
  CalendarDays, Settings2, RotateCcw, Check, Minus, Info, Lightbulb,
  ChevronLeft, ChevronRight, ChevronDown, ChevronUp, GraduationCap, Layers,
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
import { SeasonManagerDialog } from '@/components/crm/SeasonManagerDialog';
import { SeasonComparisonSection } from '@/components/crm/SeasonComparisonSection';
import { useSeasonDefinitions } from '@/hooks/useSeasonDefinitions';
import {
  aggregateByWeekday, buildWeekdayHeadlines, buildMonthComparison,
  buildMonthComparisonInsights, comparisonCellSubLabel, buildMonthWeekdayDetail,
  buildRangeWeekdayDetail, buildWeekdayComparison, exampleSeasonDefinitions,
  buildPeriodInterpretation,
  presetRange, monthLongLabel, monthKeyOf, monthRange, shiftMonthKey, rangeFromMonthKeys,
  parseSeasonSettings, serializeSeasonSettings, normalizeSeasonRange,
  DEFAULT_SEASON_SETTINGS,
  WEEKDAY_LABEL, WEEKDAY_SHORT, ISO_WEEKDAYS, PRESET_LABEL, STATUS_SCOPE_LABEL,
  METRICS, METRIC_LABEL,
  weekdayOccurrenceLabel, headlineLabel, AVG_PERSONS_PER_RESERVATION_LABEL,
  WEEKDAY_RANK_LABEL, MONTH_COMPARISON_DEFAULT_OPEN, formatIsoDateDe,
  aggregateHolidayWeekday, buildHolidayMonthComparison, buildHolidayPeriodSummary,
  bernHolidayPeriods, holidayBounds, holidayPeriodForMonth, isBernHolidaySelection,
  BERN_HOLIDAY_KINDS, BERN_HOLIDAY_SELECTION_LABEL,
  periodBounds, seasonsToComparisonPeriods, buildSeasonWeekdayRanking,
  buildSeasonChartSeries, buildSeasonRecommendations, type SeasonDefinition,
  type PresetKey, type StatusScope, type MetricKey, type IsoWeekday,
  type SeasonSettings, type SeasonRange,
  type WeekdayHeadline, type WeekdayRank,
  type ComparisonRank, type ComparisonMonthRow, type ComparisonCell,
  type BernHolidaySelection, type HolidayPeriodSummary,
  type ComparisonPeriod, type WeekdayComparisonRow, type WeekdayComparisonCell,
  type WeekdayHeat,
} from '@/lib/reservation-weekday-analytics';

// ── Formatierung ──────────────────────────────────────────────────────────────

const NUM0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const NUM1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function avg(n: number | null): string {
  return n === null ? '—' : NUM1.format(n);
}

const PRESETS: PresetKey[] = ['thisMonth', 'last3Months', 'lastMonth', 'octDec', 'winter', 'summer', 'custom'];
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
  holidayMode: boolean;
  ferienart: BernHolidaySelection;
  seasonMode: boolean;
  selectedSeasonIds: string[];
}

function parseInit(sp: URLSearchParams, todayStr: string, currentYear: number): InitView {
  const f = sp.get('f');
  const t = sp.get('t');
  const presetRaw = sp.get('p') as PresetKey | null;
  const scopeRaw = sp.get('sc') as StatusScope | null;
  const yearRaw = Number(sp.get('y'));
  const metricRaw = sp.get('m') as MetricKey | null;
  const modeRaw = sp.get('mode');
  const holRaw = sp.get('hol');

  const scope: StatusScope =
    scopeRaw === 'active' || scopeRaw === 'all' || scopeRaw === 'booked' ? scopeRaw : 'booked';
  const year = Number.isInteger(yearRaw) && yearRaw >= 2000 && yearRaw <= 2100 ? yearRaw : currentYear;
  const metric: MetricKey =
    metricRaw && METRICS.includes(metricRaw) ? metricRaw : 'reservations';
  const ferienart: BernHolidaySelection = isBernHolidaySelection(holRaw) ? holRaw : 'all';
  // Gewählte Saison-IDs: „seasons" (Spezifikation); „sel" als Alt-Param toleriert.
  const selRaw = sp.get('seasons') ?? sp.get('sel');
  const selectedSeasonIds = selRaw
    ? selRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  // Saison-Modus: frei definierte, datumsfixe Saisons. Datumsgrenzen aus der URL
  // (Superset) haben Vorrang; sonst „heute" als Platzhalter, bis die Saisons
  // geladen sind (ein Effekt setzt danach den umschliessenden Bereich).
  if (modeRaw === 'saison') {
    const validFrom = f && /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : todayStr;
    const validTo = t && /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : todayStr;
    return {
      preset: 'custom',
      from: validFrom,
      to: validTo,
      scope,
      year,
      metric,
      holidayMode: false,
      ferienart,
      seasonMode: true,
      selectedSeasonIds,
    };
  }

  // Schulferien-Modus: Datumsgrenzen ergeben sich aus der Ferien-Auswahl (der
  // umschliessende Datumsbereich für EINEN Superset-Fetch), refresh-fest.
  if (modeRaw === 'ferienBE') {
    const bounds = holidayBounds(bernHolidayPeriods(year, ferienart));
    return {
      preset: 'custom',
      from: bounds?.from ?? todayStr,
      to: bounds?.to ?? todayStr,
      scope,
      year,
      metric,
      holidayMode: true,
      ferienart,
      seasonMode: false,
      selectedSeasonIds: [],
    };
  }

  // Konkrete Datumsgrenzen aus der URL haben Vorrang (refresh-fest). Ohne sie
  // greift der Standard „Dieser Monat".
  if (f && t && /^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const preset: PresetKey = presetRaw && PRESETS.includes(presetRaw) ? presetRaw : 'custom';
    return {
      preset, from: f, to: t, scope, year, metric,
      holidayMode: false, ferienart, seasonMode: false, selectedSeasonIds: [],
    };
  }
  const range = presetRange('thisMonth', { today: todayStr, year, seasons: DEFAULT_SEASON_SETTINGS })!;
  return {
    preset: 'thisMonth',
    from: range.from,
    to: range.to,
    scope,
    year,
    metric,
    holidayMode: false,
    ferienart,
    seasonMode: false,
    selectedSeasonIds: [],
  };
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
  const { canManageGuests } = usePermissions();
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
  // Schulferien-Modus (Kanton Bern): eigener Analyse-Zweig; `from`/`to` sind
  // dann der umschliessende Datumsbereich der gewählten Ferien-Auswahl.
  const [holidayMode, setHolidayMode] = useState(init.holidayMode);
  const [ferienart, setFerienart] = useState<BernHolidaySelection>(init.ferienart);
  // Saisonvergleich-Modus: frei definierte, datumsfixe Saisons; `from`/`to` sind
  // dann der umschliessende Bereich aller ausgewählten Saisons (Superset-Fetch).
  const [seasonMode, setSeasonMode] = useState(init.seasonMode);
  const [selectedSeasonIds, setSelectedSeasonIds] = useState<string[]>(init.selectedSeasonIds);
  const [seasonMgrOpen, setSeasonMgrOpen] = useState(false);
  const {
    seasons: seasonDefs,
    saveError: seasonSaveError,
    save: saveSeasonDefs,
  } = useSeasonDefinitions();

  // Monatsvergleich-Matrix: standardmässig eingeklappt (siehe Konstante).
  const [showComparison, setShowComparison] = useState(MONTH_COMPARISON_DEFAULT_OPEN);
  // Fokus-Wochentag für den Spalten-Vergleich (Mini-Balken je Monat). Default Mo.
  const [focusWeekday, setFocusWeekday] = useState<IsoWeekday>(1);
  // Detail-Popup: geklickte Vergleichszelle (Monat × Wochentag) oder null.
  const [detailCell, setDetailCell] = useState<{ monthKey: string; weekday: IsoWeekday } | null>(null);
  // Detail-Popup des Wochentagsvergleichs (Zeitraum-Index × Wochentag) oder null.
  const [wcDetail, setWcDetail] = useState<{ periodIndex: number; weekday: IsoWeekday } | null>(null);

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
    if (!canManageGuests) return;
    let alive = true;
    void checkReservationTablesExist().then((ok) => { if (alive) setTablesOk(ok); });
    return () => { alive = false; };
  }, [canManageGuests]);

  // Reservationen für den gewählten Zeitraum laden (mandantengefiltert).
  useEffect(() => {
    if (!canManageGuests) { setLoading(false); return; }
    if (tablesOk === null) return;            // auf Tabellen-Prüfung warten
    if (tablesOk === false) { setRows([]); setLoading(false); return; }
    if (rangeInvalid) { setRows([]); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    void fetchReservationsInRange(tenantId, from, to).then((data) => {
      if (alive) { setRows(data); setLoading(false); }
    });
    return () => { alive = false; };
  }, [tenantId, canManageGuests, tablesOk, from, to, rangeInvalid]);

  // ── Berechnungen ─────────────────────────────────────────────────────────────
  // Schulferien-Perioden (Kanton Bern) für Jahr + Ferienart; leer wenn kein
  // Ferien-Modus. Treiben Aggregation, Matrix, Detail und Perioden-Zusammenfassung.
  const holidayPeriods = useMemo(
    () => (holidayMode ? bernHolidayPeriods(year, ferienart) : []),
    [holidayMode, year, ferienart],
  );

  // ── Saisonvergleich ────────────────────────────────────────────────────────
  // Ausgewählte, aktive, datumsgültige Saisons. Nur im Saison-Modus relevant;
  // treiben Aggregation, Wochentags-Perioden, Rangliste, Diagramm, Empfehlungen.
  const seasonSelected = useMemo(
    () => seasonDefs.filter((d) => d.active && selectedSeasonIds.includes(d.id)),
    [seasonDefs, selectedSeasonIds],
  );
  const seasonPeriods = useMemo(
    () => seasonsToComparisonPeriods(seasonSelected),
    [seasonSelected],
  );
  const seasonColorMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of seasonSelected) if (d.color) m[d.id] = d.color;
    return m;
  }, [seasonSelected]);

  // Saison-Modus: Datumsgrenzen = umschliessender Bereich aller gewählten Saisons
  // (EIN Superset-Fetch). Reagiert auch auf spätes Laden/Ändern der Saisons.
  useEffect(() => {
    if (!seasonMode) return;
    const bounds = periodBounds(seasonSelected);
    if (!bounds) return;
    if (bounds.from !== from) setFrom(bounds.from);
    if (bounds.to !== to) setTo(bounds.to);
  }, [seasonMode, seasonSelected, from, to]);

  const agg = useMemo(
    () => (seasonMode
      ? aggregateHolidayWeekday(rows, seasonSelected, scope)
      : holidayMode
        ? aggregateHolidayWeekday(rows, holidayPeriods, scope)
        : aggregateByWeekday(rows, from, to, scope)),
    [seasonMode, seasonSelected, holidayMode, holidayPeriods, rows, from, to, scope],
  );
  const headlines = useMemo(
    () => buildWeekdayHeadlines(agg, metric),
    [agg, metric],
  );
  // Kompakte Vergleichsmatrix (Monate × Wochentage) für die gewählte Kennzahl.
  // Im Ferien-Modus zählen NUR Reservationen innerhalb der Ferien-Perioden.
  const comparison = useMemo(
    () => (seasonMode
      ? buildHolidayMonthComparison(rows, seasonSelected, scope, metric)
      : holidayMode
        ? buildHolidayMonthComparison(rows, holidayPeriods, scope, metric)
        : buildMonthComparison(rows, from, to, scope, metric)),
    [seasonMode, seasonSelected, holidayMode, holidayPeriods, rows, from, to, scope, metric],
  );
  // Perioden-Zusammenfassung (nur Ferien-Modus): je Ferienperiode Kennzahlen,
  // stärkster/schwächster Wochentag, Zukunft-Flag + kurze Interpretation.
  const periodSummaries = useMemo(
    () => (holidayMode
      ? holidayPeriods.map((p) => buildHolidayPeriodSummary(rows, p, scope, metric, todayStr))
      : []),
    [holidayMode, holidayPeriods, rows, scope, metric, todayStr],
  );
  // 3–5 kurze, modusabhängige Insights über der Matrix.
  const insights = useMemo(
    () => buildMonthComparisonInsights(headlines, comparison, focusWeekday, metric),
    [headlines, comparison, focusWeekday, metric],
  );
  // Kurze automatische Zeitraum-Interpretation (bester/schwächster Wochentag,
  // auffällige Monate, Handlungsempfehlung) — immer sichtbar über der Matrix.
  const interpretation = useMemo(
    () => buildPeriodInterpretation(headlines, comparison, metric),
    [headlines, comparison, metric],
  );

  // Aktuell betrachteter Monat (Monatsnavigation) = Monat des „Von"-Datums.
  const currentMonthKey = monthKeyOf(from) ?? todayStr.slice(0, 7);
  // Start-/Endmonat für die Zeitraumsteuerung (type="month"-Eingaben).
  const startMonthKey = monthKeyOf(from) ?? currentMonthKey;
  const endMonthKey = monthKeyOf(to) ?? currentMonthKey;
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

  // Detail-Popup: Aufschlüsselung + Spalten-Ø der geklickten Zelle. Im Ferien-
  // Modus grenzen wir auf die Ferienperiode ein, die den geklickten Monat trägt,
  // damit das Popup NUR Ferientage zeigt.
  const detail = useMemo(() => {
    if (!detailCell) return null;
    if (holidayMode) {
      const p = holidayPeriodForMonth(holidayPeriods, detailCell.monthKey);
      if (!p) return null;
      return buildMonthWeekdayDetail(rows, p.from, p.to, detailCell.monthKey, detailCell.weekday, scope);
    }
    return buildMonthWeekdayDetail(rows, from, to, detailCell.monthKey, detailCell.weekday, scope);
  }, [detailCell, holidayMode, holidayPeriods, rows, from, to, scope]);
  const detailColumnAverage = detailCell ? comparison.columns[detailCell.weekday].average : null;
  const openDetail = (cell: ComparisonCell) =>
    setDetailCell({ monthKey: cell.monthKey, weekday: cell.weekday });

  // ── Wochentagsvergleich (Zeilen = Zeiträume, Zeilen-relative Heatmap) ──────────
  // Zeiträume je Modus: Monats-Modus → ein Zeitraum je Monat (auf [from,to]
  // geklemmt); Ferien-Modus → ein Zeitraum je Ferienperiode. Generisch: neue
  // Saisons liefern einfach eine andere Perioden-Liste.
  const weekdayComparisonPeriods = useMemo<ComparisonPeriod[]>(() => {
    if (seasonMode) return seasonPeriods;
    if (holidayMode) {
      return holidayPeriods.map((p) => ({
        key: `${p.kind}-${p.year}`,
        label: `${p.label} ${p.year}`,
        from: p.from,
        to: p.to,
      }));
    }
    // Monats-Modus: EINE Zeile je Monat im Bereich [startMonthKey, endMonthKey] —
    // auch Monate OHNE Reservationen erscheinen (Null-Zeile), damit die Tabelle
    // lückenlos „1 Zeile/Monat" bleibt (comparison.months würde leere Monate
    // weglassen). Jeder Monat auf [from,to] geklemmt.
    const keys: string[] = [];
    if (
      /^\d{4}-\d{2}$/.test(startMonthKey) &&
      /^\d{4}-\d{2}$/.test(endMonthKey) &&
      startMonthKey <= endMonthKey
    ) {
      let k = startMonthKey;
      for (let i = 0; i < 240 && k <= endMonthKey; i++) {
        keys.push(k);
        k = shiftMonthKey(k, 1);
      }
    }
    return keys.map((mk) => {
      const r = monthRange(mk);
      const pFrom = r.from && r.from > from ? r.from : from;
      const pTo = r.to && r.to < to ? r.to : to;
      return { key: mk, label: monthLongLabel(mk), from: pFrom, to: pTo };
    });
  }, [seasonMode, seasonPeriods, holidayMode, holidayPeriods, startMonthKey, endMonthKey, from, to]);

  const weekdayComparison = useMemo(
    () => buildWeekdayComparison(rows, weekdayComparisonPeriods, scope, metric),
    [rows, weekdayComparisonPeriods, scope, metric],
  );

  // Saison-Ansichten (nur Saison-Modus): Rangliste je Wochentag, Diagramm-Serien
  // (eine Linie je Saison) und automatische Empfehlungen. Alle rein abgeleitet
  // aus `weekdayComparison`; leer/neutral ausserhalb des Saison-Modus.
  const seasonRanking = useMemo(
    () => (seasonMode ? buildSeasonWeekdayRanking(weekdayComparison) : []),
    [seasonMode, weekdayComparison],
  );
  const seasonChart = useMemo(
    () => (seasonMode
      ? buildSeasonChartSeries(weekdayComparison)
      : { points: [], series: [] }),
    [seasonMode, weekdayComparison],
  );
  const seasonRecommendations = useMemo(
    () => (seasonMode ? buildSeasonRecommendations(weekdayComparison, seasonRanking) : []),
    [seasonMode, weekdayComparison, seasonRanking],
  );

  // Detail-Popup des Wochentagsvergleichs: Aufschlüsselung + Spalten-Ø (über alle
  // Zeiträume) der geklickten Zelle.
  const wcDetailData = useMemo(() => {
    if (!wcDetail) return null;
    const row = weekdayComparison.rows[wcDetail.periodIndex];
    if (!row) return null;
    return buildRangeWeekdayDetail(rows, row.period.from, row.period.to, wcDetail.weekday, scope, {
      monthKey: row.period.key,
      label: row.period.label,
      rangeLabel: `${formatIsoDateDe(row.period.from)} – ${formatIsoDateDe(row.period.to)}`,
    });
  }, [wcDetail, weekdayComparison.rows, rows, scope]);
  const wcDetailColumnAverage = wcDetail
    ? weekdayComparison.weekdayAverages[wcDetail.weekday]
    : null;
  const openWcDetail = (periodIndex: number, weekday: IsoWeekday) =>
    setWcDetail({ periodIndex, weekday });

  // Grösster Hauptwert (für die Mini-Balken-Skalierung).
  const maxHeadline = useMemo(
    () => Math.max(0, ...headlines.headlines.map((h) => h.value ?? 0)),
    [headlines],
  );

  // ── Aktionen ─────────────────────────────────────────────────────────────────
  const applyPreset = (key: PresetKey) => {
    setHolidayMode(false); // eine Schnell-Auswahl verlässt den Ferien-Modus
    setSeasonMode(false);  // … und den Saison-Modus
    setPreset(key);
    if (key === 'custom') return; // Datumsfelder bleiben frei wählbar
    const range = presetRange(key, { today: todayStr, year, seasons });
    if (range) { setFrom(range.from); setTo(range.to); }
  };

  // Schulferien-Modus aktivieren: Datumsgrenzen = umschliessender Bereich der
  // aktuell gewählten Ferien-Auswahl (Superset-Fetch); Präzision übernimmt die
  // ferien-genaue Aggregation.
  const enterHolidayMode = () => {
    setSeasonMode(false);
    setHolidayMode(true);
    setPreset('custom');
    const bounds = holidayBounds(bernHolidayPeriods(year, ferienart));
    if (bounds) { setFrom(bounds.from); setTo(bounds.to); }
  };
  const changeFerienart = (sel: BernHolidaySelection) => {
    setFerienart(sel);
    const bounds = holidayBounds(bernHolidayPeriods(year, sel));
    if (bounds) { setFrom(bounds.from); setTo(bounds.to); }
  };

  // Saisonvergleich aktivieren: verlässt Ferien-/Preset-Modus. Ohne bestehende
  // Auswahl werden alle aktiven Saisons vorausgewählt; der Superset-Effekt setzt
  // danach die Datumsgrenzen.
  const enterSeasonMode = () => {
    setHolidayMode(false);
    setSeasonMode(true);
    setPreset('custom');
    setSelectedSeasonIds((prev) =>
      prev.length > 0 ? prev : seasonDefs.filter((d) => d.active).map((d) => d.id),
    );
  };
  const toggleSeasonSelected = (id: string) =>
    setSelectedSeasonIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  // Nach dem Speichern der Saison-Definitionen: Auswahl auf noch existierende,
  // aktive Saisons eingrenzen; fällt sie leer, alle aktiven vorauswählen.
  const handleSaveSeasonDefs = async (next: SeasonDefinition[]) => {
    await saveSeasonDefs(next);
    const activeIds = next.filter((d) => d.active).map((d) => d.id);
    const valid = new Set(activeIds);
    setSelectedSeasonIds((prev) => {
      const kept = prev.filter((id) => valid.has(id));
      return kept.length > 0 ? kept : activeIds;
    });
  };
  // Leerzustand: die fünf Beispiel-Saisons aus der Spezifikation einfügen
  // (normaler Speicherpfad; wählt danach alle aktiven Saisons vor).
  const seedExampleSeasons = () => {
    void handleSaveSeasonDefs(exampleSeasonDefinitions());
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
    if (holidayMode) {
      const bounds = holidayBounds(bernHolidayPeriods(y, ferienart));
      if (bounds) { setFrom(bounds.from); setTo(bounds.to); }
      return;
    }
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

  // Startmonat/Endmonat setzen BEIDE Grenzen auf Monatsanfang/-ende (die
  // Auswertung ist monatsbasiert; Tag-Granularität wird bewusst gerundet). Wir
  // schnappen bei jeder Eingabe auch die jeweils andere Grenze auf ganze Monate,
  // damit eine z.B. per URL übergebene Nicht-Monatsgrenze nicht teilmonatig bleibt.
  const editStartMonth = (key: string) => {
    const r = rangeFromMonthKeys(key, endMonthKey);
    if (!r.from) return;
    setFrom(r.from);
    if (r.to) setTo(r.to);
    setPreset('custom');
  };
  const editEndMonth = (key: string) => {
    const r = rangeFromMonthKeys(startMonthKey, key);
    if (!r.to) return;
    if (r.from) setFrom(r.from);
    setTo(r.to);
    setPreset('custom');
  };

  // ── URL-Spiegelung ───────────────────────────────────────────────────────────
  useEffect(() => {
    const next = new URLSearchParams();
    if (seasonMode) {
      next.set('mode', 'saison');
      if (selectedSeasonIds.length > 0) next.set('seasons', selectedSeasonIds.join(','));
    } else if (holidayMode) {
      next.set('mode', 'ferienBE');
      next.set('hol', ferienart);
    } else {
      next.set('p', preset);
    }
    next.set('f', from);
    next.set('t', to);
    next.set('sc', scope);
    next.set('y', String(year));
    next.set('m', metric);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [seasonMode, selectedSeasonIds, holidayMode, ferienart, preset, from, to, scope, year, metric, searchParams, setSearchParams]);

  if (!canManageGuests) return <Navigate to="/" replace />;

  const hasData = agg.totalReservations > 0;
  const yearRelevant = holidayMode || SEASON_PRESETS.includes(preset);

  const strongestH = headlines.headlines.find((h) => h.weekday === headlines.strongest) ?? null;
  const weakestH = headlines.headlines.find((h) => h.weekday === headlines.weakest) ?? null;
  const scopeLabel = seasonMode
    ? (seasonSelected.length === 1
        ? seasonSelected[0].name
        : seasonSelected.length > 1
          ? `${seasonSelected.length} Saisons`
          : 'Keine Saison ausgewählt')
    : holidayMode
      ? `${BERN_HOLIDAY_SELECTION_LABEL[ferienart]} ${year}`
      : isSingleMonth
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
                aria-pressed={!holidayMode && !seasonMode && preset === key}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-sm transition-colors',
                  !holidayMode && !seasonMode && preset === key
                    ? 'border-primary bg-primary/10 font-medium text-primary'
                    : 'border-border hover:border-primary/60 hover:bg-muted/40',
                )}
              >
                {PRESET_LABEL[key]}
              </button>
            ))}
            <button
              type="button"
              onClick={enterHolidayMode}
              aria-pressed={holidayMode}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors',
                holidayMode
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-border hover:border-primary/60 hover:bg-muted/40',
              )}
            >
              <GraduationCap className="h-4 w-4" />
              Schulferien BE
            </button>
            <button
              type="button"
              onClick={enterSeasonMode}
              aria-pressed={seasonMode}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors',
                seasonMode
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-border hover:border-primary/60 hover:bg-muted/40',
              )}
            >
              <Layers className="h-4 w-4" />
              Saisonvergleich
            </button>
          </div>
        </div>

        {/* Monatsnavigation + Zeitraum + Jahr + Status */}
        <div className="flex flex-wrap items-end gap-4">
          {seasonMode ? (
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Saisons auswählen
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {seasonDefs.filter((d) => d.active).length === 0 ? (
                  <>
                    <span className="text-sm text-muted-foreground">
                      Noch keine Saison definiert — mit „Saisons verwalten" anlegen.
                    </span>
                    {seasonDefs.length === 0 && (
                      <button
                        type="button"
                        onClick={seedExampleSeasons}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:border-primary/60 hover:bg-muted/40"
                      >
                        <Layers className="h-3.5 w-3.5" />
                        Beispiel-Saisons einfügen
                      </button>
                    )}
                  </>
                ) : (
                  seasonDefs
                    .filter((d) => d.active)
                    .map((d) => {
                      const on = selectedSeasonIds.includes(d.id);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => toggleSeasonSelected(d.id)}
                          aria-pressed={on}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors',
                            on
                              ? 'border-primary bg-primary/10 font-medium text-primary'
                              : 'border-border hover:border-primary/60 hover:bg-muted/40',
                          )}
                        >
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: d.color ?? '#2563eb' }}
                          />
                          {d.name}
                        </button>
                      );
                    })
                )}
              </div>
            </div>
          ) : holidayMode ? (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Ferienart</label>
              <select
                value={ferienart}
                onChange={(e) => changeFerienart(e.target.value as BernHolidaySelection)}
                className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
              >
                <option value="all">{BERN_HOLIDAY_SELECTION_LABEL.all}</option>
                {BERN_HOLIDAY_KINDS.map((k) => (
                  <option key={k} value={k}>{BERN_HOLIDAY_SELECTION_LABEL[k]}</option>
                ))}
              </select>
            </div>
          ) : (
            <>
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
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Startmonat</label>
                <input
                  type="month"
                  value={startMonthKey}
                  onChange={(e) => editStartMonth(e.target.value)}
                  className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Endmonat</label>
                <input
                  type="month"
                  value={endMonthKey}
                  onChange={(e) => editEndMonth(e.target.value)}
                  className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                />
              </div>
            </>
          )}

          {!seasonMode && (
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
          )}

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

          {!holidayMode && !seasonMode && (
            <button
              type="button"
              onClick={editorOpen ? () => setEditorOpen(false) : openEditor}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/40"
            >
              <Settings2 className="h-4 w-4" />
              Saisons anpassen
            </button>
          )}
          {seasonMode && (
            <button
              type="button"
              onClick={() => setSeasonMgrOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/40"
            >
              <Settings2 className="h-4 w-4" />
              Saisons verwalten
            </button>
          )}
        </div>

        {rangeInvalid && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Bitte einen gültigen Zeitraum wählen (Von darf nicht nach Bis liegen).
          </p>
        )}

        {/* Saison-Editor */}
        {editorOpen && !holidayMode && !seasonMode && (
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
      ) : (
        <>
          {/* ── Schulferien-Perioden-Zusammenfassung (nur Ferien-Modus) ─────── */}
          {holidayMode && (
            <HolidaySummarySection summaries={periodSummaries} metric={metric} />
          )}

          {!hasData ? (
            seasonMode ? (
              <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                {seasonSelected.length === 0
                  ? 'Bitte mindestens eine Saison auswählen (oder mit „Saisons verwalten" eine anlegen).'
                  : 'Keine Reservationen in den gewählten Saisons.'}
              </div>
            ) : (
            // Im Ferien-Modus übernehmen die Perioden-Karten die Leer-/Zukunft-
            // Meldung; nur im normalen Modus die generische Leer-Meldung zeigen.
            !holidayMode && (
              <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                Keine Reservationen im gewählten Zeitraum.
              </div>
            )
            )
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

          {/* ── Wochentagsvergleich (Heatmap je Zeile/Zeitraum) ────────────── */}
          {weekdayComparison.rows.length > 0 && (
            <WeekdayComparisonSection
              comparison={weekdayComparison}
              metric={metric}
              scopeLabel={scopeLabel}
              onSelect={openWcDetail}
              emptyRowHint={seasonMode ? 'Für diese Saison sind noch keine Reservationen vorhanden.' : undefined}
            />
          )}

          {/* ── Saisonvergleich: Diagramm + Rangliste + Empfehlungen (≥ 2) ─── */}
          {seasonMode && seasonSelected.length >= 2 && (
            <SeasonComparisonSection
              ranking={seasonRanking}
              chart={seasonChart}
              recommendations={seasonRecommendations}
              metric={metric}
              colorMap={seasonColorMap}
              onSelect={(key, wd) => {
                const idx = weekdayComparison.rows.findIndex((r) => r.period.key === key);
                if (idx >= 0) openWcDetail(idx, wd);
              }}
            />
          )}

          {/* ── Automatische Interpretation des Zeitraums ──────────────────── */}
          <section>
            <SectionTitle icon={Lightbulb}>Interpretation</SectionTitle>
            <p className="mb-2 text-xs text-muted-foreground">
              Kurze automatische Auswertung für den gewählten Zeitraum
              (Kennzahl: <span className="font-medium text-foreground">{METRIC_LABEL[metric]}</span>).
            </p>
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Bester Wochentag
                  </p>
                  <p className="mt-0.5 font-semibold text-emerald-600 dark:text-emerald-400">
                    {interpretation.bestWeekday ? WEEKDAY_LABEL[interpretation.bestWeekday.weekday] : '—'}
                  </p>
                  {interpretation.bestWeekday && (
                    <p className="text-[11px] tabular-nums text-muted-foreground">
                      {headlineLabel(interpretation.bestWeekday.weekday, metric)}: {avg(interpretation.bestWeekday.value)}
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Schwächster Wochentag
                  </p>
                  <p className="mt-0.5 font-semibold text-red-600 dark:text-red-400">
                    {interpretation.worstWeekday ? WEEKDAY_LABEL[interpretation.worstWeekday.weekday] : '—'}
                  </p>
                  {interpretation.worstWeekday && (
                    <p className="text-[11px] tabular-nums text-muted-foreground">
                      {headlineLabel(interpretation.worstWeekday.weekday, metric)}: {avg(interpretation.worstWeekday.value)}
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Auffällige Monate
                  </p>
                  {interpretation.notableMonths.length > 0 ? (
                    <ul className="mt-0.5 space-y-0.5 text-sm">
                      {interpretation.notableMonths.map((n) => (
                        <li key={n.monthKey} className="flex flex-wrap items-baseline gap-x-1.5">
                          <span
                            className={cn(
                              'text-[11px] font-medium',
                              n.kind === 'best'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-red-600 dark:text-red-400',
                            )}
                          >
                            {n.kind === 'best' ? 'Stärkster' : 'Schwächster'}
                          </span>
                          <span className="font-medium">{monthLongLabel(n.monthKey)}</span>
                          <span className="tabular-nums text-muted-foreground">
                            ({metric === 'avgPersons' ? NUM1.format(n.value) : NUM0.format(n.value)})
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-0.5 text-sm text-muted-foreground">Kein Monat sticht klar heraus.</p>
                  )}
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                <Lightbulb className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <p>
                  <span className="font-medium">Handlungsempfehlung:</span> {interpretation.recommendation}
                </p>
              </div>
            </div>
          </section>

          {/* ── Monatsvergleich (nicht im Saison-Modus) ────────────────────── */}
          {!seasonMode && (
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
          )}
          </>
          )}
        </>
      )}

      <MonthWeekdayDetailDialog
        open={detailCell !== null}
        onOpenChange={(o) => { if (!o) setDetailCell(null); }}
        detail={detail}
        metric={metric}
        columnAverage={detailColumnAverage}
      />

      <MonthWeekdayDetailDialog
        open={wcDetail !== null}
        onOpenChange={(o) => { if (!o) setWcDetail(null); }}
        detail={wcDetailData}
        metric={metric}
        columnAverage={wcDetailColumnAverage}
        columnAverageLabel={seasonMode ? 'über alle Saisons' : holidayMode ? 'über alle Ferienperioden' : 'über alle Monate'}
        singleColumnLabel={seasonMode ? 'nur eine Saison' : holidayMode ? 'nur eine Ferienperiode' : 'nur ein Monat im Zeitraum'}
      />

      <SeasonManagerDialog
        open={seasonMgrOpen}
        onOpenChange={setSeasonMgrOpen}
        seasons={seasonDefs}
        onSave={handleSaveSeasonDefs}
        saveError={seasonSaveError}
      />
    </div>
  );
}

// ── Schulferien-Zusammenfassung ────────────────────────────────────────────────

/** Exakte Zukunfts-Meldung für eine leere Ferienperiode (Anforderung). */
const HOLIDAY_FUTURE_EMPTY =
  'Für diese zukünftige Ferienperiode sind noch keine Reservationen vorhanden.';

/** Leer-/Zukunftstext einer Ferienperiode ohne Reservationen. */
function holidayEmptyMessage(s: HolidayPeriodSummary): string {
  return s.isFuture ? HOLIDAY_FUTURE_EMPTY : s.interpretation;
}

/** Datumsbereich + Kalenderwochen + Ferientage einer Periode als Kurztext. */
function holidayPeriodMeta(s: HolidayPeriodSummary): string {
  const kw = s.period.weeks.length === 1
    ? `KW ${s.period.weeks[0]}`
    : `KW ${s.period.weeks[0]}–${s.period.weeks[s.period.weeks.length - 1]}`;
  return `${formatIsoDateDe(s.period.from)} – ${formatIsoDateDe(s.period.to)} · ${kw} · ${s.period.days} Ferientage`;
}

/** Wochentag-Label + Wert (oder „–") für stärkster/schwächster Wochentag. */
function weekdayValueLabel(h: WeekdayHeadline | null): string {
  return h ? `${WEEKDAY_LABEL[h.weekday]} (${avg(h.value)})` : '–';
}

/** Kleine Kennzahl-Kachel innerhalb einer Ferien-Perioden-Karte. */
function HolidayStat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-lg font-bold tabular-nums', accent)}>{value}</p>
    </div>
  );
}

/** Vollständige Karte EINER Ferienperiode (Kennzahlen + WD + Interpretation). */
function HolidayPeriodCard({ s, metric }: { s: HolidayPeriodSummary; metric: MetricKey }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold">{s.period.label} {s.period.year}</h3>
        <span className="text-xs tabular-nums text-muted-foreground">{holidayPeriodMeta(s)}</span>
      </div>

      {s.hasReservations ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <HolidayStat label="Reservationen" value={NUM0.format(s.totalReservations)} />
            <HolidayStat label="Personen" value={NUM0.format(s.totalPersons)} />
            <HolidayStat label={AVG_PERSONS_PER_RESERVATION_LABEL} value={avg(s.avgPersonsPerReservation)} />
            <HolidayStat label="Ø Res./Ferientag" value={avg(s.avgReservationsPerDay)} />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <HolidayStat
              label="Stärkster Wochentag"
              value={weekdayValueLabel(s.strongest)}
              accent="text-emerald-600 dark:text-emerald-400"
            />
            <HolidayStat
              label="Schwächster Wochentag"
              value={weekdayValueLabel(s.weakest)}
              accent="text-red-600 dark:text-red-400"
            />
          </div>
          <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-2.5 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
            <Lightbulb className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p>{s.interpretation}</p>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Kennzahl der Wochentags-Werte: <span className="font-medium text-foreground">{METRIC_LABEL[metric]}</span> (Ø pro Wochentag).
          </p>
        </>
      ) : (
        <div
          className={cn(
            'flex items-start gap-2 rounded-md border p-3 text-sm',
            s.isFuture
              ? 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200'
              : 'border-border bg-muted/30 text-muted-foreground',
          )}
        >
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <p>{holidayEmptyMessage(s)}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Schulferien-Zusammenfassung: bei EINER Periode eine vollständige Karte, bei
 * MEHREREN eine Vergleichstabelle (Periode/von/bis/Ferientage/Res/Personen/Ø +
 * stärkster/schwächster Wochentag) samt kurzer Interpretation je Periode.
 */
function HolidaySummarySection({ summaries, metric }: {
  summaries: HolidayPeriodSummary[];
  metric: MetricKey;
}) {
  if (summaries.length === 0) return null;

  if (summaries.length === 1) {
    return (
      <section>
        <SectionTitle icon={GraduationCap}>Ferien-Auswertung</SectionTitle>
        <HolidayPeriodCard s={summaries[0]} metric={metric} />
      </section>
    );
  }

  return (
    <section>
      <SectionTitle icon={GraduationCap}>Ferienperioden im Vergleich</SectionTitle>
      <p className="mb-2 text-xs text-muted-foreground">
        Nur Reservationen innerhalb der Schulferien (Kanton Bern).
        {' '}Wochentag-Werte als Kennzahl: <span className="font-medium text-foreground">{METRIC_LABEL[metric]}</span>.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Periode</th>
              <th className="px-2 py-2 text-left">von</th>
              <th className="px-2 py-2 text-left">bis</th>
              <th className="px-2 py-2 text-right">Ferientage</th>
              <th className="px-2 py-2 text-right">Res.</th>
              <th className="px-2 py-2 text-right">Personen</th>
              <th className="px-2 py-2 text-right">Ø Pers./Res.</th>
              <th className="px-2 py-2 text-left">Stärkster WD</th>
              <th className="px-2 py-2 text-left">Schwächster WD</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((s) => (
              <tr key={s.period.kind} className="border-t border-border">
                <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium">
                  {s.period.label}
                </th>
                <td className="whitespace-nowrap px-2 py-2 tabular-nums">{formatIsoDateDe(s.period.from)}</td>
                <td className="whitespace-nowrap px-2 py-2 tabular-nums">{formatIsoDateDe(s.period.to)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{NUM0.format(s.period.days)}</td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {s.hasReservations ? NUM0.format(s.totalReservations) : '–'}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {s.hasReservations ? NUM0.format(s.totalPersons) : '–'}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {s.hasReservations ? avg(s.avgPersonsPerReservation) : '–'}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-emerald-700 dark:text-emerald-400">
                  {s.hasReservations ? weekdayValueLabel(s.strongest) : '–'}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-red-700 dark:text-red-400">
                  {s.hasReservations ? weekdayValueLabel(s.weakest) : '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Kurze automatische Interpretation je Periode (inkl. Zukunft/Leer). */}
      <ul className="mt-3 space-y-1.5">
        {summaries.map((s) => (
          <li key={s.period.kind} className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
            <span className="font-medium">{s.period.label}:</span>
            <span className={cn(!s.hasReservations && 'text-muted-foreground')}>
              {s.hasReservations ? s.interpretation : holidayEmptyMessage(s)}
            </span>
          </li>
        ))}
      </ul>
    </section>
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

// ── Wochentagsvergleich (Heatmap-Tabelle je Zeitraum) ─────────────────────────

/**
 * Hintergrundfarbe je Heatmap-Stufe (relativ zum ZEILEN-Durchschnitt).
 * 5 Stufen: dunkelgrün (deutlich über) · hellgrün (über) · neutral (im Schnitt) ·
 * orange (unter) · rot (deutlich unter). `none` = kein Wert.
 */
const HEAT_CELL_BG: Record<WeekdayHeat, string> = {
  veryStrong: 'bg-emerald-200 text-emerald-950 dark:bg-emerald-900/60 dark:text-emerald-50',
  aboveAverage: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100',
  average: 'bg-muted/40 text-foreground',
  belowAverage: 'bg-orange-100 text-orange-900 dark:bg-orange-950/40 dark:text-orange-100',
  veryWeak: 'bg-red-100 text-red-900 dark:bg-red-950/40 dark:text-red-100',
  none: 'text-muted-foreground',
};

/**
 * „Wochentagsvergleich": eine Zeile je Zeitraum (Monat / Ferienperiode / künftig
 * Saison), Spalten Mo–So mit dem Wert der gewählten Kennzahl, dazu drei Summen-
 * Spalten. Die Heatmap jeder Zelle bezieht sich auf den DURCHSCHNITT IHRER ZEILE
 * (nicht der Spalte). Zellen sind klickbar und öffnen dasselbe Detail-Popup wie
 * die Monatsvergleichs-Matrix.
 */
function WeekdayComparisonSection({ comparison, metric, scopeLabel, onSelect, emptyRowHint }: {
  comparison: WeekdayComparison;
  metric: MetricKey;
  scopeLabel: string;
  onSelect: (periodIndex: number, weekday: IsoWeekday) => void;
  /**
   * Optionaler Hinweistext für Zeilen ohne Reservationen (nur Saison-Modus):
   * die Zeile bleibt mit 0-Werten sichtbar, darunter erscheint dieser Satz.
   */
  emptyRowHint?: string;
}) {
  const emptyRows = emptyRowHint
    ? comparison.rows.filter((r) => r.totalReservations === 0)
    : [];
  return (
    <section>
      <SectionTitle icon={CalendarRange}>Wochentagsvergleich</SectionTitle>
      <p className="mb-1 text-xs text-muted-foreground">
        Jede Zeile ist ein Zeitraum, jede Wochentagsspalte zeigt die gewählte Kennzahl;
        klicke eine farbige Zelle für die Aufschlüsselung.
      </p>
      <p className="mb-1 text-xs text-muted-foreground">
        Zeitraum: <span className="font-medium text-foreground">{scopeLabel}</span>.
        {' '}Wochentagswerte ={' '}
        <span className="font-medium text-foreground">{METRIC_LABEL[metric]}</span>{' '}
        als Durchschnitt pro Wochentag.
      </p>
      <p className="mb-2 text-xs text-muted-foreground">
        Die Farben vergleichen jeden Wochentag mit dem Durchschnitt <strong>seiner eigenen
        Zeile</strong> (des Zeitraums): dunkelgrün = deutlich über, hellgrün = über,
        neutral = im Schnitt, orange = unter, rot = deutlich unter dem Zeilendurchschnitt.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-2 text-left font-medium">Zeitraum</th>
              {ISO_WEEKDAYS.map((wd) => (
                <th key={wd} className="border-l border-border px-2 py-2 text-center font-medium">
                  {WEEKDAY_SHORT[wd]}
                </th>
              ))}
              <th className="border-l border-border px-2 py-2 text-right font-medium">Reservationen&nbsp;total</th>
              <th className="border-l border-border px-2 py-2 text-right font-medium">Personen&nbsp;total</th>
              <th className="border-l border-border px-2 py-2 text-right font-medium">Ø&nbsp;Personen&nbsp;pro&nbsp;Reservation</th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row, periodIndex) => (
              <tr key={row.period.key} className="border-t border-border">
                <td className="px-2 py-2 font-medium">{row.period.label}</td>
                {ISO_WEEKDAYS.map((wd) => (
                  <WeekdayHeatCell
                    key={wd}
                    cell={row.cells[wd]}
                    periodLabel={row.period.label}
                    onSelect={() => onSelect(periodIndex, wd)}
                  />
                ))}
                <td className="border-l border-border px-2 py-2 text-right tabular-nums">
                  {NUM0.format(row.totalReservations)}
                </td>
                <td className="border-l border-border px-2 py-2 text-right tabular-nums">
                  {NUM0.format(row.totalPersons)}
                </td>
                <td className="border-l border-border px-2 py-2 text-right tabular-nums">
                  {row.avgPersons !== null ? NUM1.format(row.avgPersons) : '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {emptyRows.length > 0 && (
        <div className="mt-2 space-y-0.5 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {emptyRows.map((r) => (
            <p key={r.period.key}>
              <span className="font-medium">{r.period.label}:</span> {emptyRowHint}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

/** Eine klickbare Wochentagszelle mit Heatmap-Farbe (relativ zur Zeile). */
function WeekdayHeatCell({ cell, periodLabel, onSelect }: {
  cell: WeekdayComparisonCell;
  periodLabel: string;
  onSelect: () => void;
}) {
  if (cell.value === null) {
    return <td className={cn('border-l border-border px-2 py-2 text-center', HEAT_CELL_BG.none)}>–</td>;
  }
  return (
    <td
      className={cn(
        'border-l border-border px-2 py-2 text-center tabular-nums cursor-pointer transition-colors hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60',
        HEAT_CELL_BG[cell.heat],
      )}
      role="button"
      tabIndex={0}
      title="Details anzeigen"
      aria-label={`Details anzeigen: ${WEEKDAY_LABEL[cell.weekday]} in ${periodLabel}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {NUM1.format(cell.value)}
    </td>
  );
}
