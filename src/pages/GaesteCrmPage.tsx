/**
 * GaesteCrmPage — Gäste-CRM (Liste)
 * ==================================
 * Durchsuchbare, sortierbare Übersicht aller Gäste eines Mandanten mit
 * automatischer Segmentierung.  Die Kennzahlen werden in der App aus den
 * Aggregaten der Tabelle `guest_profiles` berechnet (siehe reservation-crm.ts) —
 * es gibt KEINE separate CRM-Tabelle.
 *
 * Datenschutz: Gästedaten (Name/E-Mail/Mobile) sind personenbezogen.  Zugriff
 * nur für eingeloggte Admins; die Tabellen sind per RLS auf `authenticated`
 * beschränkt (siehe Migration).
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Users, Search, Loader2, Database, ChevronUp, ChevronDown,
  ArrowRight, BarChart3, Filter, X, TrendingDown,
  Crown, Star, Building2, Mail, Ban, AlertTriangle,
  FileDown, FileSpreadsheet, Columns3, Trophy, Calendar,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { useNavigate, Navigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';

import {
  fetchGuestProfiles, fetchCompletedVisitAggregates, fetchNoShowCountsByGuest,
  fetchActiveVisitsByGuest,
} from '@/lib/reservation-crm-db';
import { fetchGuestCrmProfilesByIds } from '@/lib/guest-crm-profile-db';
import type { GuestCrmProfile } from '@/lib/guest-crm-profile';
import { checkReservationTablesExist } from '@/lib/reservation-import-db';
import {
  guestListMetrics, countSegments, returnRiskRatio, isAtReturnRisk,
  SEGMENT_LABEL, SEGMENT_ORDER,
  type GuestListMetrics, type GuestSegment, type CompletedVisitAgg,
} from '@/lib/reservation-crm';
import {
  DEFAULT_GUEST_FILTERS, hasActiveFilters, searchAndFilterGuests, sortGuests,
  SEGMENT_FILTER_OPTIONS, VISIT_COUNT_FILTER_OPTIONS, LAST_VISIT_FILTER_OPTIONS,
  PARTY_SIZE_FILTER_OPTIONS, NO_SHOW_FILTER_OPTIONS, RETURN_RISK_FILTER_OPTIONS,
  BOOL_FILTER_OPTIONS, CRM_BOOL_FILTERS, CRM_BOOL_FILTER_KEYS,
  type GuestFilterState, type GuestSortKey, type SortDir, type FilterOption,
  type CrmMerkmal, type BoolFilter,
} from '@/lib/guest-list-filters';
import {
  GUEST_COLUMNS, GUEST_COLUMN_BY_KEY, loadVisibleColumns, saveVisibleColumns, toggleColumn,
  type GuestColumnKey,
} from '@/lib/guest-list-columns';
import {
  ZEITRAUM_OPTIONS, resolveZeitraum, inRangeVisitCounts, buildTopList, buildFlopList,
  type ZeitraumPreset, type TopFlopRow, type ActiveVisitRow,
} from '@/lib/guest-top-flop';
import { SegmentBadge, SEGMENT_ICON } from '@/components/crm/SegmentBadge';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { downloadCsv, downloadXlsx } from '@/lib/table-export';
import { guestListExportTable } from '@/lib/guest-list-export';

type TopFlopMode = 'off' | 'top10' | 'top20' | 'flop20' | 'flop50';

// ── Formatierung ──────────────────────────────────────────────────────────────

const NUM0 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const NUM1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function fdate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return fmtDate(parseISO(iso.slice(0, 10)), 'dd.MM.yyyy', { locale: de }); }
  catch { return iso; }
}

function fnum(n: number | null, fmt: Intl.NumberFormat): string {
  return n === null ? '—' : fmt.format(n);
}

// ── Rückkehr-Risiko-Zelle ─────────────────────────────────────────────────────

/**
 * Zeigt die „Überfälligkeits-Quote" (Tage seit letztem Besuch ÷ Ø-Intervall).
 * Gäste ohne belastbares Intervall (< 3 Besuche / fehlende Werte) → „—".
 * Ab dem Schwellenfaktor (gefährdet) wird die Quote farblich hervorgehoben.
 */
function ReturnRiskCell({ metric }: { metric: GuestListMetrics }) {
  const ratio = returnRiskRatio(metric);
  if (ratio === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  const atRisk = isAtReturnRisk(metric);
  return (
    <span
      className={cn(
        'inline-flex items-center justify-end gap-1 tabular-nums',
        atRisk
          ? 'font-semibold text-orange-600 dark:text-orange-400'
          : 'text-muted-foreground',
      )}
      title={atRisk ? 'Überfällig gegenüber dem persönlichen Besuchsrhythmus' : undefined}
    >
      {atRisk && <TrendingDown className="h-3.5 w-3.5" />}
      {NUM1.format(ratio)}×
    </span>
  );
}

// ── Filter-Auswahl (kompaktes Select) ─────────────────────────────────────────

function FilterSelect<T extends string>({
  label, value, options, onChange,
}: {
  label: string;
  value: T;
  options: FilterOption<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={e => onChange(e.target.value as T)}
        className="rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/40"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

// ── Manuelle CRM-Badges (rein darstellend, aus guest_crm_profiles) ─────────────

const CRM_CHIP = 'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium';

/**
 * Zeigt die manuell gepflegten CRM-Merkmale eines Gastes als kompakte Chips.
 * Völlig unabhängig vom automatisch berechneten Segment; fehlt das Profil oder
 * ist kein Merkmal gesetzt, wird nichts gerendert.
 */
function CrmBadges({ crm }: { crm?: GuestCrmProfile | null }) {
  if (!crm) return null;
  const chips: JSX.Element[] = [];
  if (crm.vipManual) chips.push(
    <span key="vip" className={cn(CRM_CHIP, 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300')}>
      <Crown className="h-3 w-3" /> VIP
    </span>,
  );
  if (crm.stammgastManual) chips.push(
    <span key="stamm" className={cn(CRM_CHIP, 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-300')}>
      <Star className="h-3 w-3" /> Stammgast
    </span>,
  );
  if (crm.companyCustomer) chips.push(
    <span key="firma" className={cn(CRM_CHIP, 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300')}>
      <Building2 className="h-3 w-3" /> Firmenkunde
    </span>,
  );
  if (crm.newsletterOptIn) chips.push(
    <span key="news" className={cn(CRM_CHIP, 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300')}>
      <Mail className="h-3 w-3" /> Newsletter
    </span>,
  );
  if (crm.blockedGuest) chips.push(
    <span key="block" className={cn(CRM_CHIP, 'border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300')}>
      <Ban className="h-3 w-3" /> Sperrliste
    </span>,
  );
  if (chips.length === 0) return null;
  return <div className="mt-1 flex flex-wrap gap-1">{chips}</div>;
}

// ── Tabellenzellen (spaltengesteuert) ─────────────────────────────────────────

/** Ja/—-Zelle für manuelle CRM-Booleans. */
function BoolCell({ on }: { on: boolean }) {
  return on
    ? <span className="font-medium text-emerald-600 dark:text-emerald-400">Ja</span>
    : <span className="text-muted-foreground">—</span>;
}

/**
 * Rendert den Inhalt EINER Tabellenzelle anhand des Spaltenschlüssels.  Der
 * `<td>`-Wrapper inkl. Ausrichtung wird vom Aufrufer gesetzt; hier steht nur
 * der Zellinhalt.  Manuelle CRM-Felder (`m.crm`) sind defensiv optional.
 */
function GuestCell({ colKey, m }: { colKey: GuestColumnKey; m: GuestListMetrics }) {
  switch (colKey) {
    case 'name':
      return (
        <>
          <div className="font-medium">{m.displayName}</div>
          {(m.email || m.mobile) && (
            <div className="text-[11px] text-muted-foreground">{m.email || m.mobile}</div>
          )}
          <CrmBadges crm={m.crm} />
        </>
      );
    case 'segment':
      return <SegmentBadge segment={m.segment} />;
    case 'company':
      return <span className="text-muted-foreground">{m.crm?.company || '—'}</span>;
    case 'birthday':
      return <span className="tabular-nums text-muted-foreground">{fdate(m.crm?.birthday)}</span>;
    case 'visits':
      return <span className="font-semibold tabular-nums">{NUM0.format(m.visits)}</span>;
    case 'partySize':
      return (
        <span className="tabular-nums text-muted-foreground">
          {m.avgPartySize === null ? '—' : fnum(m.avgPartySize, NUM1)}
        </span>
      );
    case 'firstVisit':
      return <span className="tabular-nums text-muted-foreground">{fdate(m.firstVisit)}</span>;
    case 'lastVisit':
      return <span className="tabular-nums">{fdate(m.lastVisit)}</span>;
    case 'interval':
      return (
        <span className="tabular-nums">
          {m.avgDaysBetweenVisits === null ? '—' : `${fnum(m.avgDaysBetweenVisits, NUM1)} Tage`}
        </span>
      );
    case 'sinceLast':
      return (
        <span className="tabular-nums text-muted-foreground">
          {m.daysSinceLastVisit === null ? '—' : `${NUM0.format(m.daysSinceLastVisit)} Tage`}
        </span>
      );
    case 'returnRisk':
      return <ReturnRiskCell metric={m} />;
    case 'vipManual':
      return <BoolCell on={!!m.crm?.vipManual} />;
    case 'stammgastManual':
      return <BoolCell on={!!m.crm?.stammgastManual} />;
    case 'companyCustomer':
      return <BoolCell on={!!m.crm?.companyCustomer} />;
    case 'newsletter':
      return <BoolCell on={!!m.crm?.newsletterOptIn} />;
    case 'blocked':
      return <BoolCell on={!!m.crm?.blockedGuest} />;
    default:
      return null;
  }
}

// ── Komponente ────────────────────────────────────────────────────────────────

export default function GaesteCrmPage() {
  const { tenantId } = useTenant();
  const { isAdmin, isGuest } = usePermissions();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [tablesOk, setTablesOk] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<Awaited<ReturnType<typeof fetchGuestProfiles>>>([]);
  const [visitAggs, setVisitAggs] = useState<Map<string, CompletedVisitAgg>>(new Map());
  const [noShowCounts, setNoShowCounts] = useState<Map<string, number>>(new Map());
  const [crmProfiles, setCrmProfiles] = useState<Map<string, GuestCrmProfile>>(new Map());
  const [crmError, setCrmError] = useState(false);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<GuestFilterState>(DEFAULT_GUEST_FILTERS);
  const [sortKey, setSortKey] = useState<GuestSortKey>('visits');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Spaltenauswahl (persistiert in localStorage; SSR-/Storage-sicher gekapselt).
  const [visibleColumns, setVisibleColumns] = useState<GuestColumnKey[]>(() => loadVisibleColumns());
  useEffect(() => { saveVisibleColumns(visibleColumns); }, [visibleColumns]);

  // Top/Flop-Ranglisten + Zeitraum. Aktiv ⇒ Filter pausieren (Suche bleibt).
  const [topFlopMode, setTopFlopMode] = useState<TopFlopMode>('off');
  const [zeitraum, setZeitraum] = useState<ZeitraumPreset>('akt_monat');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [rangeRows, setRangeRows] = useState<ActiveVisitRow[]>([]);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [rangeError, setRangeError] = useState(false);
  const rangeCacheRef = useRef<Map<string, ActiveVisitRow[]>>(new Map());

  const now = useMemo(() => new Date(), []);
  const today = useMemo(() => fmtDate(now, 'yyyy-MM-dd'), [now]);
  const isTopFlop = topFlopMode !== 'off';
  // Top = Besuche im Zeitraum (braucht den Reservations-Read); Flop = Stand-heute
  // Überfälligkeit (zeitraum-unabhängig, kein Read).
  const isTopMode = topFlopMode === 'top10' || topFlopMode === 'top20';
  const isFlopMode = topFlopMode === 'flop20' || topFlopMode === 'flop50';

  const range = useMemo(
    () => resolveZeitraum(zeitraum, now, { from: customFrom, to: customTo }),
    [zeitraum, now, customFrom, customTo],
  );

  const load = useCallback(async () => {
    if (!isAdmin || isGuest) { setLoading(false); return; }   // Datenschutz: keine Gäste-Reads für Nicht-Admins / Gast-Sessions
    setLoading(true);
    const ok = await checkReservationTablesExist();
    setTablesOk(ok);
    if (ok) {
      const [ps, aggs, noShows] = await Promise.all([
        fetchGuestProfiles(tenantId),
        fetchCompletedVisitAggregates(tenantId),
        fetchNoShowCountsByGuest(tenantId),
      ]);
      setProfiles(ps);
      setVisitAggs(aggs);
      setNoShowCounts(noShows);
      // Manuelle CRM-Profile additiv nachladen. Schlägt das fehl, bleibt die
      // Liste voll funktionsfähig (leere Map) und es erscheint ein Hinweis —
      // kein stilles Verschlucken des Fehlers.
      try {
        const crm = await fetchGuestCrmProfilesByIds(ps.map(p => p.id));
        setCrmProfiles(crm);
        setCrmError(false);
      } catch {
        setCrmProfiles(new Map());
        setCrmError(true);
      }
    } else {
      setProfiles([]);
      setVisitAggs(new Map());
      setNoShowCounts(new Map());
      setCrmProfiles(new Map());
      setCrmError(false);
    }
    setLoading(false);
  }, [tenantId, isAdmin, isGuest]);

  useEffect(() => { void load(); }, [load]);

  const allMetrics = useMemo(
    () => profiles.map(p => guestListMetrics(
      p, visitAggs.get(p.id), today, noShowCounts.get(p.id) ?? 0, crmProfiles.get(p.id) ?? null,
    )),
    [profiles, visitAggs, noShowCounts, today, crmProfiles],
  );

  const segmentCounts = useMemo(() => countSegments(allMetrics), [allMetrics]);

  const returnRiskCount = useMemo(
    () => allMetrics.reduce((n, m) => n + (isAtReturnRisk(m) ? 1 : 0), 0),
    [allMetrics],
  );

  const filtered = useMemo(
    () => searchAndFilterGuests(allMetrics, query, filters),
    [allMetrics, query, filters],
  );

  const sorted = useMemo(
    () => sortGuests(filtered, sortKey, sortDir),
    [filtered, sortKey, sortDir],
  );

  // Aktive Reservationen für den gewählten Zeitraum lazy laden (nur im Top/Flop-
  // Modus). Ergebnis je (Mandant|von|bis) cachen, damit ein erneutes Umschalten
  // der Rangliste keine erneute Abfrage auslöst. Fehler → sichtbarer Hinweis,
  // kein stilles Verschlucken.
  useEffect(() => {
    if (!isTopMode || !tablesOk) return;
    const key = `${tenantId}|${range.from}|${range.to}`;
    const cached = rangeCacheRef.current.get(key);
    if (cached) { setRangeRows(cached); setRangeError(false); setRangeLoading(false); return; }
    let cancelled = false;
    setRangeLoading(true);
    fetchActiveVisitsByGuest(tenantId, range.from, range.to)
      .then(rows => {
        if (cancelled) return;
        rangeCacheRef.current.set(key, rows);
        setRangeRows(rows);
        setRangeError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRangeRows([]);
        setRangeError(true);
      })
      .finally(() => { if (!cancelled) setRangeLoading(false); });
    return () => { cancelled = true; };
  }, [isTopMode, tablesOk, tenantId, range]);

  const rangeCounts = useMemo(
    () => inRangeVisitCounts(rangeRows, range.from, range.to),
    [rangeRows, range],
  );

  // Top/Flop-Liste über die NUR durchsuchte (Filter pausiert) Gästemenge.
  // Top = meiste Besuche im Zeitraum; Flop = höchstes Rückkehrpotenzial
  // (am stärksten überfällig, Stand heute — zeitraum-unabhängig).
  const topFlopRows = useMemo(() => {
    if (!isTopFlop) return [];
    const base = searchAndFilterGuests(allMetrics, query, DEFAULT_GUEST_FILTERS);
    if (topFlopMode === 'flop20') return buildFlopList(base, 20);
    if (topFlopMode === 'flop50') return buildFlopList(base, 50);
    return buildTopList(base, rangeCounts, topFlopMode === 'top20' ? 20 : 10);
  }, [isTopFlop, topFlopMode, allMetrics, query, rangeCounts]);

  const topFlopById = useMemo(() => {
    const m = new Map<string, TopFlopRow>();
    for (const r of topFlopRows) m.set(r.metric.id, r);
    return m;
  }, [topFlopRows]);

  // Die tatsächlich angezeigten Zeilen: im Top/Flop-Modus die Rangliste (eigene
  // Reihenfolge, Sortierung deaktiviert), sonst die gefilterte+sortierte Liste.
  const displayRows = isTopFlop ? topFlopRows.map(r => r.metric) : sorted;

  const filtersActive = hasActiveFilters(filters) || query.trim().length > 0;

  // Anzahl aktiver manueller CRM-Filter (Badge am „Weitere Filter"-Knopf).
  const activeCrmCount = useMemo(
    () => CRM_BOOL_FILTER_KEYS.filter(k => filters[k] !== 'alle').length,
    [filters],
  );

  const resetCrmFilters = () => {
    setFilters(f => {
      const next = { ...f };
      for (const k of CRM_BOOL_FILTER_KEYS) next[k] = 'alle';
      return next;
    });
  };

  const resetFilters = () => {
    setFilters(DEFAULT_GUEST_FILTERS);
    setQuery('');
  };

  const toggleTopFlop = (mode: Exclude<TopFlopMode, 'off'>) => {
    setTopFlopMode(m => (m === mode ? 'off' : mode));
  };

  const setCrmBool = (k: CrmMerkmal, v: BoolFilter) => {
    setFilters(f => ({ ...f, [k]: v }));
  };

  const toggleSort = (key: GuestSortKey) => {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Text aufsteigend, Zahlen/Daten absteigend vorbelegen.
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  if (!isAdmin || isGuest) return <Navigate to="/" replace />;

  const SortHeader = ({ label, k, align = 'left' }: { label: string; k: GuestSortKey; align?: 'left' | 'right' }) => (
    <th
      className={cn(
        'cursor-pointer select-none px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground',
        align === 'right' ? 'text-right' : 'text-left',
      )}
      onClick={() => toggleSort(k)}
    >
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
        {label}
        {sortKey === k && (sortDir === 'asc'
          ? <ChevronUp className="h-3 w-3" />
          : <ChevronDown className="h-3 w-3" />)}
      </span>
    </th>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      {/* Kopf */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Users className="h-6 w-6 text-primary" />
            Gäste-CRM
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Besuchsverhalten und Segmente — berechnet aus den importierten
            Reservationen ({tenantId === 'beaulieu' ? 'Beaulieu' : 'Oliv'}).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => navigate('/gaeste/auswertung')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/60"
          >
            <BarChart3 className="h-4 w-4 text-primary" />
            CRM Auswertung
          </button>
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

      {crmError && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            Die manuellen CRM-Profile konnten nicht geladen werden. Die Gästeliste
            wird ohne manuelle Merkmale (VIP/Stammgast manuell, Firmenkunde usw.)
            angezeigt.
          </span>
        </div>
      )}

      {/* Segment-Kacheln */}
      {tablesOk && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {SEGMENT_ORDER.map(seg => {
            const Icon = SEGMENT_ICON[seg];
            return (
              <div key={seg} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" />
                  {SEGMENT_LABEL[seg]}
                </div>
                <p className="mt-1 text-xl font-bold tabular-nums">{NUM0.format(segmentCounts[seg])}</p>
              </div>
            );
          })}
        </div>
      )}

      {/* Suche + Filter */}
      {tablesOk && (
        <div className="space-y-3 rounded-lg border border-border bg-card p-3">
          {/* Suche */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Suche nach Name, E-Mail oder Telefon…"
              className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {/* Ranglisten (Top/Flop) + Zeitraum — pausiert die Filter, Suche bleibt */}
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Trophy className="h-3.5 w-3.5" /> Ranglisten
              </span>
              {([['top10', 'Top 10'], ['top20', 'Top 20'], ['flop20', 'Flop 20'], ['flop50', 'Flop 50']] as const).map(([mode, label]) => {
                const flop = mode === 'flop20' || mode === 'flop50';
                return (
                  <button
                    key={mode}
                    onClick={() => toggleTopFlop(mode)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                      topFlopMode === mode
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background text-foreground hover:bg-muted/60',
                    )}
                  >
                    {flop
                      ? <TrendingDown className="h-3.5 w-3.5" />
                      : <Trophy className="h-3.5 w-3.5" />}
                    {label}
                  </button>
                );
              })}
              {/* Zeitraum nur für Top-Listen (Besuche im Zeitraum); Flop ist Stand heute. */}
              {isTopMode && (
                <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Calendar className="h-3.5 w-3.5" />
                  <select
                    value={zeitraum}
                    onChange={e => setZeitraum(e.target.value as ZeitraumPreset)}
                    className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    {ZEITRAUM_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {isTopMode && zeitraum === 'individuell' && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <label className="flex items-center gap-1">
                  von
                  <input
                    type="date"
                    value={customFrom}
                    onChange={e => setCustomFrom(e.target.value)}
                    className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
                <label className="flex items-center gap-1">
                  bis
                  <input
                    type="date"
                    value={customTo}
                    onChange={e => setCustomTo(e.target.value)}
                    className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </label>
              </div>
            )}

            {isTopFlop && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  {isTopMode && rangeLoading ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Zeitraum-Daten werden geladen…</>
                  ) : isTopMode ? (
                    <>Besuche im Zeitraum {fdate(range.from)} – {fdate(range.to)} (bestätigt + abgeschlossen). Filter pausiert; Suche bleibt aktiv.</>
                  ) : (
                    <>Höchstes Rückkehrpotenzial — am stärksten überfällige Gäste (Stand heute, Ø-Intervall × 1,5). Filter pausiert; Suche bleibt aktiv.</>
                  )}
                </span>
                <button
                  onClick={() => setTopFlopMode('off')}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60"
                >
                  <X className="h-3.5 w-3.5" /> Rangliste schliessen
                </button>
              </div>
            )}

            {isTopMode && rangeError && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                Die Besuche für den gewählten Zeitraum konnten nicht geladen werden.
              </div>
            )}
          </div>

          {/* Filter — pausiert, sobald eine Rangliste aktiv ist (Suche bleibt) */}
          {!isTopFlop && (
            <>
              {/* Filterleiste — auf Mobile untereinander, auf Desktop kompakt nebeneinander */}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <FilterSelect
                  label="Segment"
                  value={filters.segment}
                  options={SEGMENT_FILTER_OPTIONS}
                  onChange={v => setFilters(f => ({ ...f, segment: v }))}
                />
                <FilterSelect
                  label="Besuchsanzahl"
                  value={filters.visitCount}
                  options={VISIT_COUNT_FILTER_OPTIONS}
                  onChange={v => setFilters(f => ({ ...f, visitCount: v }))}
                />
                <FilterSelect
                  label="Letzter Besuch"
                  value={filters.lastVisit}
                  options={LAST_VISIT_FILTER_OPTIONS}
                  onChange={v => setFilters(f => ({ ...f, lastVisit: v }))}
                />
                <FilterSelect
                  label="Gruppengrösse"
                  value={filters.partySize}
                  options={PARTY_SIZE_FILTER_OPTIONS}
                  onChange={v => setFilters(f => ({ ...f, partySize: v }))}
                />
                <FilterSelect
                  label="No-Show-Risiko"
                  value={filters.noShow}
                  options={NO_SHOW_FILTER_OPTIONS}
                  onChange={v => setFilters(f => ({ ...f, noShow: v }))}
                />
                <FilterSelect
                  label="Rückkehrpotenzial"
                  value={filters.returnRisk}
                  options={RETURN_RISK_FILTER_OPTIONS}
                  onChange={v => setFilters(f => ({ ...f, returnRisk: v }))}
                />
              </div>

              {/* Zusatzfilter (manuelle CRM-Merkmale) gesammelt in einem Dropdown
                  + Aktiv-Status/Reset — hält den Hauptbereich kompakt. */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/60">
                      <Filter className="h-4 w-4" />
                      Weitere Filter
                      {activeCrmCount > 0 && (
                        <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold leading-4 text-primary">
                          {activeCrmCount}
                        </span>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="max-h-[26rem] w-72 space-y-3 overflow-auto p-3">
                    {/* gefährdete Stammgäste — nur sichtbar, wenn relevant (≥1) */}
                    {returnRiskCount > 0 && (
                      <button
                        onClick={() => setFilters(f => ({
                          ...f,
                          returnRisk: f.returnRisk === 'risk' ? 'alle' : 'risk',
                        }))}
                        className={cn(
                          'flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs font-medium transition-colors',
                          filters.returnRisk === 'risk'
                            ? 'border-orange-400 bg-orange-100 text-orange-800 dark:border-orange-700 dark:bg-orange-950/40 dark:text-orange-300'
                            : 'border-border bg-background text-foreground hover:bg-muted/60',
                        )}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <TrendingDown className="h-3.5 w-3.5" />
                          Gefährdete Stammgäste
                        </span>
                        <span className="tabular-nums">{NUM0.format(returnRiskCount)}</span>
                      </button>
                    )}

                    <div className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Manuelle CRM-Merkmale
                      </p>
                      {CRM_BOOL_FILTERS.map(({ key, label }) => (
                        <FilterSelect<BoolFilter>
                          key={key}
                          label={label}
                          value={filters[key]}
                          options={BOOL_FILTER_OPTIONS}
                          onChange={v => setCrmBool(key, v)}
                        />
                      ))}
                    </div>

                    {activeCrmCount > 0 && (
                      <button
                        onClick={resetCrmFilters}
                        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                        CRM-Filter zurücksetzen
                      </button>
                    )}
                  </PopoverContent>
                </Popover>

                {filtersActive && (
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Filter className="h-3.5 w-3.5" />
                      {NUM0.format(sorted.length)} von {NUM0.format(allMetrics.length)} Gästen
                    </span>
                    <button
                      onClick={resetFilters}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60"
                    >
                      <X className="h-3.5 w-3.5" />
                      Filter zurücksetzen
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Spaltenauswahl + Export der aktuell angezeigten Liste */}
      {tablesOk && displayRows.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/60">
                <Columns3 className="h-4 w-4" />
                Spalten
                <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold leading-4 text-muted-foreground">
                  {visibleColumns.length}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="max-h-80 w-56 overflow-auto p-2">
              <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Sichtbare Spalten
              </p>
              <div className="space-y-0.5">
                {GUEST_COLUMNS.map(c => {
                  const checked = visibleColumns.includes(c.key);
                  const lastOne = checked && visibleColumns.length === 1;
                  return (
                    <label
                      key={c.key}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-1.5 py-1.5 text-sm',
                        lastOne ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-muted/60',
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={lastOne}
                        onCheckedChange={() => setVisibleColumns(v => toggleColumn(v, c.key))}
                      />
                      {c.label}
                    </label>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
          <button
            onClick={() => downloadCsv(guestListExportTable(displayRows, visibleColumns))}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            <FileDown className="h-4 w-4" />
            CSV
          </button>
          <button
            onClick={() => void downloadXlsx(guestListExportTable(displayRows, visibleColumns))}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <FileSpreadsheet className="h-4 w-4" />
            Excel
          </button>
        </div>
      )}

      {/* Tabelle */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Gäste werden geladen…
        </div>
      ) : tablesOk && displayRows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          {allMetrics.length === 0
            ? 'Noch keine Gäste vorhanden. Importiere zuerst Reservationen.'
            : isTopMode
              ? 'Keine Gäste mit Besuchen im gewählten Zeitraum.'
              : isFlopMode
                ? 'Keine überfälligen Gäste — niemand liegt über dem persönlichen Ø-Besuchsintervall.'
                : 'Keine Gäste passen zu Suche und Filter.'}
        </div>
      ) : tablesOk ? (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/50 [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted [&_th]:border-b [&_th]:border-border">
              <tr>
                {isTopFlop && (
                  <th
                    className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                    title={isTopMode
                      ? 'Bestätigte + abgeschlossene Reservationen im gewählten Zeitraum'
                      : 'Tage über dem persönlichen Ø-Besuchsintervall (× 1,5)'}
                  >
                    {isTopMode ? 'Besuche Zeitraum' : 'Überfällig'}
                  </th>
                )}
                {visibleColumns.map(key => {
                  const col = GUEST_COLUMN_BY_KEY[key];
                  // Im Top/Flop-Modus ist die Reihenfolge fix → keine Sortierung.
                  return col.sortKey && !isTopFlop
                    ? <SortHeader key={key} label={col.label} k={col.sortKey} align={col.align} />
                    : (
                      <th
                        key={key}
                        className={cn(
                          'px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
                          col.align === 'right' ? 'text-right' : 'text-left',
                        )}
                      >
                        {col.label}
                      </th>
                    );
                })}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {displayRows.map(m => {
                const rc = topFlopById.get(m.id);
                return (
                  <tr
                    key={m.id}
                    onClick={() => navigate(`/gaeste/${m.id}`)}
                    className="cursor-pointer border-t border-border hover:bg-muted/40"
                  >
                    {isTopFlop && (
                      isTopMode ? (
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className="font-semibold">{NUM0.format(rc?.rangeVisits ?? 0)}</span>
                          {rc && rc.rangePersons > 0 && (
                            <span className="ml-1 text-[11px] text-muted-foreground">
                              ({NUM0.format(rc.rangePersons)} P.)
                            </span>
                          )}
                        </td>
                      ) : (
                        <td className="px-3 py-2 text-right tabular-nums">
                          {rc && rc.overdueDays != null ? (
                            <span className="font-semibold text-orange-600 dark:text-orange-400">
                              {NUM0.format(Math.round(rc.overdueDays))} Tage
                            </span>
                          ) : (
                            <span className="text-muted-foreground">–</span>
                          )}
                        </td>
                      )
                    )}
                    {visibleColumns.map(key => (
                      <td
                        key={key}
                        className={cn(
                          'px-3 py-2',
                          GUEST_COLUMN_BY_KEY[key].align === 'right' ? 'text-right' : 'text-left',
                        )}
                      >
                        <GuestCell colKey={key} m={m} />
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right">
                      <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {tablesOk && displayRows.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {isTopFlop
            ? `${NUM0.format(displayRows.length)} Gäste in der Rangliste.`
            : `${NUM0.format(displayRows.length)} von ${NUM0.format(allMetrics.length)} Gästen angezeigt.`}
        </p>
      )}
    </div>
  );
}
