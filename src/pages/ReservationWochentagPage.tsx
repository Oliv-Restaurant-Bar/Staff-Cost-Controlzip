/**
 * ReservationWochentagPage — Reservationen nach Wochentag
 * ========================================================
 * Admin-only Auswertung: an welchen Wochentagen wird am meisten/wenigsten
 * reserviert?  Für einen frei wählbaren Zeitraum (mit Schnell-Auswahl inkl.
 * anpassbarer Saisons) zeigt die Seite:
 *
 *  1. Zusammenfassung: stärkster/schwächster Wochentag + bester/schwächster
 *     Monat für einen wählbaren Fokus-Wochentag (Standard: Montag).
 *  2. Kennzahlen je Wochentag (Mo–So): Reservationen, Personen,
 *     Ø Personen/Reservation, Anteil % am Gesamtzeitraum.
 *  3. Matrix „Wochentage nach Monat": Zeile = Monat, Spalte = Wochentag; jede
 *     Zelle zeigt Reservationen (oben) und Personen (kleiner darunter).
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
  CalendarDays, Settings2, RotateCcw, Check, Trophy, Frown,
} from 'lucide-react';
import { format as fmtDate } from 'date-fns';
import { useNavigate, Navigate, useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { fetchReservationsInRange } from '@/lib/reservation-crm-db';
import { checkReservationTablesExist } from '@/lib/reservation-import-db';
import type { ReservationDetailRow } from '@/lib/reservation-dashboard';
import {
  aggregateByWeekday, buildMonthWeekdayMatrix, buildWeekdaySummary,
  presetRange, monthLabel, monthLongLabel,
  parseSeasonSettings, serializeSeasonSettings, normalizeSeasonRange,
  DEFAULT_SEASON_SETTINGS,
  ISO_WEEKDAYS, WEEKDAY_LABEL, WEEKDAY_SHORT, PRESET_LABEL, STATUS_SCOPE_LABEL,
  type IsoWeekday, type PresetKey, type StatusScope,
  type SeasonSettings, type SeasonRange,
} from '@/lib/reservation-weekday-analytics';

// ── Formatierung ──────────────────────────────────────────────────────────────

const NUM0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const NUM1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function pct(n: number): string {
  return `${NUM1.format(n)} %`;
}

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

// ── Initialer Anzeigezustand aus der URL ───────────────────────────────────────

interface InitView {
  preset: PresetKey;
  from: string;
  to: string;
  weekday: IsoWeekday;
  scope: StatusScope;
  year: number;
}

function parseInit(sp: URLSearchParams, todayStr: string, currentYear: number): InitView {
  const f = sp.get('f');
  const t = sp.get('t');
  const presetRaw = sp.get('p') as PresetKey | null;
  const wdRaw = Number(sp.get('wd'));
  const scopeRaw = sp.get('sc') as StatusScope | null;
  const yearRaw = Number(sp.get('y'));

  const weekday: IsoWeekday = ISO_WEEKDAYS.includes(wdRaw as IsoWeekday) ? (wdRaw as IsoWeekday) : 1;
  const scope: StatusScope =
    scopeRaw === 'active' || scopeRaw === 'all' || scopeRaw === 'booked' ? scopeRaw : 'booked';
  const year = Number.isInteger(yearRaw) && yearRaw >= 2000 && yearRaw <= 2100 ? yearRaw : currentYear;

  // Konkrete Datumsgrenzen aus der URL haben Vorrang (refresh-fest). Ohne sie
  // greift der Standard „Dieser Monat".
  if (f && t && /^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const preset: PresetKey = presetRaw && PRESETS.includes(presetRaw) ? presetRaw : 'custom';
    return { preset, from: f, to: t, weekday, scope, year };
  }
  const range = presetRange('thisMonth', { today: todayStr, year, seasons: DEFAULT_SEASON_SETTINGS })!;
  return { preset: 'thisMonth', from: range.from, to: range.to, weekday, scope, year };
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
  const [focusWeekday, setFocusWeekday] = useState<IsoWeekday>(init.weekday);
  const [scope, setScope] = useState<StatusScope>(init.scope);
  const [year, setYear] = useState(init.year);

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
  const matrix = useMemo(
    () => buildMonthWeekdayMatrix(rows, from, to, scope),
    [rows, from, to, scope],
  );
  const summary = useMemo(
    () => buildWeekdaySummary(agg, matrix, focusWeekday),
    [agg, matrix, focusWeekday],
  );

  // ── Aktionen ─────────────────────────────────────────────────────────────────
  const applyPreset = (key: PresetKey) => {
    setPreset(key);
    if (key === 'custom') return; // Datumsfelder bleiben frei wählbar
    const range = presetRange(key, { today: todayStr, year, seasons });
    if (range) { setFrom(range.from); setTo(range.to); }
  };

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
    next.set('wd', String(focusWeekday));
    next.set('sc', scope);
    next.set('y', String(year));
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [preset, from, to, focusWeekday, scope, year, searchParams, setSearchParams]);

  if (!isAdmin || isGuest) return <Navigate to="/" replace />;

  const hasData = matrix.grandTotal.reservations > 0;
  const yearRelevant = SEASON_PRESETS.includes(preset);

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

        {/* Zeitraum + Jahr + Status */}
        <div className="flex flex-wrap items-end gap-4">
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
          {/* ── Zusammenfassung ───────────────────────────────────────────── */}
          <section>
            <SectionTitle icon={Trophy}>Zusammenfassung</SectionTitle>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <SummaryCard
                icon={TrendingUp}
                label="Stärkster Wochentag"
                value={summary.strongestWeekday ? WEEKDAY_LABEL[summary.strongestWeekday.weekday] : '—'}
                sub={summary.strongestWeekday ? `${NUM0.format(summary.strongestWeekday.reservations)} Reservationen` : undefined}
                accent="text-emerald-600 dark:text-emerald-400"
              />
              <SummaryCard
                icon={TrendingDown}
                label="Schwächster Wochentag"
                value={summary.weakestWeekday ? WEEKDAY_LABEL[summary.weakestWeekday.weekday] : '—'}
                sub={summary.weakestWeekday ? `${NUM0.format(summary.weakestWeekday.reservations)} Reservationen` : undefined}
                accent="text-red-600 dark:text-red-400"
              />
              <SummaryCard
                icon={Trophy}
                label={`Bester Monat (${WEEKDAY_SHORT[focusWeekday]})`}
                value={summary.bestMonthForWeekday ? monthLongLabel(summary.bestMonthForWeekday.monthKey) : '—'}
                sub={summary.bestMonthForWeekday ? `${NUM0.format(summary.bestMonthForWeekday.reservations)} Reservationen` : undefined}
                accent="text-emerald-600 dark:text-emerald-400"
              />
              <SummaryCard
                icon={Frown}
                label={`Schwächster Monat (${WEEKDAY_SHORT[focusWeekday]})`}
                value={summary.worstMonthForWeekday ? monthLongLabel(summary.worstMonthForWeekday.monthKey) : '—'}
                sub={summary.worstMonthForWeekday ? `${NUM0.format(summary.worstMonthForWeekday.reservations)} Reservationen` : undefined}
                accent="text-red-600 dark:text-red-400"
              />
            </div>
            <div className="mt-2 flex items-center gap-2 text-sm">
              <label htmlFor="focus-wd" className="text-muted-foreground">Wochentag für Monatsvergleich:</label>
              <select
                id="focus-wd"
                value={focusWeekday}
                onChange={(e) => setFocusWeekday(Number(e.target.value) as IsoWeekday)}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              >
                {ISO_WEEKDAYS.map((wd) => (
                  <option key={wd} value={wd}>{WEEKDAY_LABEL[wd]}</option>
                ))}
              </select>
            </div>
          </section>

          {/* ── Kennzahlen je Wochentag ───────────────────────────────────── */}
          <section>
            <SectionTitle icon={CalendarDays}>Kennzahlen je Wochentag</SectionTitle>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Wochentag</th>
                    <th className="px-3 py-2 text-right">Reservationen</th>
                    <th className="px-3 py-2 text-right">Personen</th>
                    <th className="px-3 py-2 text-right">Ø Personen</th>
                    <th className="px-3 py-2 text-right">Anteil</th>
                  </tr>
                </thead>
                <tbody>
                  {agg.weekdays.map((w) => {
                    const isStrong = summary.strongestWeekday?.weekday === w.weekday && w.reservations > 0;
                    const isWeak = summary.weakestWeekday?.weekday === w.weekday && w.reservations > 0;
                    return (
                      <tr key={w.weekday} className="border-t border-border">
                        <td className="px-3 py-2 font-medium">
                          {WEEKDAY_LABEL[w.weekday]}
                          {isStrong && <span className="ml-1.5 text-emerald-600 dark:text-emerald-400">▲</span>}
                          {isWeak && <span className="ml-1.5 text-red-600 dark:text-red-400">▼</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{NUM0.format(w.reservations)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{NUM0.format(w.persons)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{avg(w.avgPersons)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{pct(w.sharePct)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                    <td className="px-3 py-2">Gesamt</td>
                    <td className="px-3 py-2 text-right tabular-nums">{NUM0.format(agg.totalReservations)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{NUM0.format(agg.totalPersons)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {avg(agg.totalReservations > 0 ? agg.totalPersons / agg.totalReservations : null)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">100,0 %</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {/* ── Matrix Monat × Wochentag ──────────────────────────────────── */}
          <section>
            <SectionTitle icon={CalendarRange}>Wochentage nach Monat</SectionTitle>
            <p className="mb-2 text-xs text-muted-foreground">
              Je Zelle: Anzahl Reservationen (oben), Anzahl Personen (kleiner darunter).
            </p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Monat</th>
                    {ISO_WEEKDAYS.map((wd) => (
                      <th
                        key={wd}
                        className={cn(
                          'px-3 py-2 text-right',
                          wd === focusWeekday && 'bg-primary/10 text-primary',
                        )}
                      >
                        {WEEKDAY_SHORT[wd]}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {matrix.months.map((m) => (
                    <tr key={m.monthKey} className="border-t border-border">
                      <td className="whitespace-nowrap px-3 py-2 font-medium">{monthLabel(m.monthKey)}</td>
                      {ISO_WEEKDAYS.map((wd) => (
                        <td
                          key={wd}
                          className={cn(
                            'px-3 py-2 text-right tabular-nums',
                            wd === focusWeekday && 'bg-primary/5',
                          )}
                        >
                          <MatrixCell reservations={m.cells[wd].reservations} persons={m.cells[wd].persons} />
                        </td>
                      ))}
                      <td className="px-3 py-2 text-right tabular-nums font-medium">
                        <MatrixCell reservations={m.total.reservations} persons={m.total.persons} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                    <td className="px-3 py-2">Gesamt</td>
                    {ISO_WEEKDAYS.map((wd) => (
                      <td
                        key={wd}
                        className={cn(
                          'px-3 py-2 text-right tabular-nums',
                          wd === focusWeekday && 'bg-primary/10',
                        )}
                      >
                        <MatrixCell reservations={matrix.weekdayTotals[wd].reservations} persons={matrix.weekdayTotals[wd].persons} />
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right tabular-nums">
                      <MatrixCell reservations={matrix.grandTotal.reservations} persons={matrix.grandTotal.persons} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

// ── Matrix-Zelle: Reservationen oben, Personen kleiner darunter ────────────────

function MatrixCell({ reservations, persons }: { reservations: number; persons: number }) {
  if (reservations === 0) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{NUM0.format(reservations)}</span>
      <span className="text-[11px] text-muted-foreground">{NUM0.format(persons)} P.</span>
    </span>
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
