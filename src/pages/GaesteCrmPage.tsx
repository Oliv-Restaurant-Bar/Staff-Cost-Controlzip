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

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Users, Search, Loader2, Database, ChevronUp, ChevronDown,
  ArrowRight, BarChart3, Filter, X, TrendingDown,
  Crown, Star, Building2, Mail, Ban, AlertTriangle,
  FileDown, FileSpreadsheet,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { useNavigate, Navigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';

import { fetchGuestProfiles, fetchCompletedVisitAggregates, fetchNoShowCountsByGuest } from '@/lib/reservation-crm-db';
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
  BOOL_FILTER_OPTIONS,
  type GuestFilterState, type GuestSortKey, type SortDir, type FilterOption,
} from '@/lib/guest-list-filters';
import { SegmentBadge, SEGMENT_ICON } from '@/components/crm/SegmentBadge';
import { downloadCsv, downloadXlsx } from '@/lib/table-export';
import { guestListExportTable } from '@/lib/guest-list-export';

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

// ── Komponente ────────────────────────────────────────────────────────────────

export default function GaesteCrmPage() {
  const { tenantId } = useTenant();
  const { isAdmin } = usePermissions();
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

  const today = useMemo(() => fmtDate(new Date(), 'yyyy-MM-dd'), []);

  const load = useCallback(async () => {
    if (!isAdmin) { setLoading(false); return; }   // Datenschutz: keine Gäste-Reads für Nicht-Admins
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
  }, [tenantId, isAdmin]);

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

  const filtersActive = hasActiveFilters(filters) || query.trim().length > 0;

  const resetFilters = () => {
    setFilters(DEFAULT_GUEST_FILTERS);
    setQuery('');
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

  if (!isAdmin) return <Navigate to="/" replace />;

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
        <button
          onClick={() => navigate('/gaeste/auswertung')}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/60"
        >
          <BarChart3 className="h-4 w-4 text-primary" />
          CRM Auswertung
        </button>
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

          {/* Manuelle CRM-Merkmale (aus guest_crm_profiles) */}
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Manuelle CRM-Merkmale
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <FilterSelect
                label="Manueller VIP"
                value={filters.vipManual}
                options={BOOL_FILTER_OPTIONS}
                onChange={v => setFilters(f => ({ ...f, vipManual: v }))}
              />
              <FilterSelect
                label="Manueller Stammgast"
                value={filters.stammgastManual}
                options={BOOL_FILTER_OPTIONS}
                onChange={v => setFilters(f => ({ ...f, stammgastManual: v }))}
              />
              <FilterSelect
                label="Firmenkunde"
                value={filters.companyCustomer}
                options={BOOL_FILTER_OPTIONS}
                onChange={v => setFilters(f => ({ ...f, companyCustomer: v }))}
              />
              <FilterSelect
                label="Newsletter"
                value={filters.newsletter}
                options={BOOL_FILTER_OPTIONS}
                onChange={v => setFilters(f => ({ ...f, newsletter: v }))}
              />
              <FilterSelect
                label="Sperrliste"
                value={filters.blocked}
                options={BOOL_FILTER_OPTIONS}
                onChange={v => setFilters(f => ({ ...f, blocked: v }))}
              />
              <FilterSelect
                label="Hat Allergien"
                value={filters.hasAllergies}
                options={BOOL_FILTER_OPTIONS}
                onChange={v => setFilters(f => ({ ...f, hasAllergies: v }))}
              />
              <FilterSelect
                label="Hat Geburtstag"
                value={filters.hasBirthday}
                options={BOOL_FILTER_OPTIONS}
                onChange={v => setFilters(f => ({ ...f, hasBirthday: v }))}
              />
              <FilterSelect
                label="Hat CRM-Notiz"
                value={filters.hasCrmNote}
                options={BOOL_FILTER_OPTIONS}
                onChange={v => setFilters(f => ({ ...f, hasCrmNote: v }))}
              />
            </div>
          </div>

          {/* Schnellfilter: gefährdete Stammgäste (Rückkehrpotenzial) */}
          {returnRiskCount > 0 && (
            <button
              onClick={() => setFilters(f => ({
                ...DEFAULT_GUEST_FILTERS,
                returnRisk: f.returnRisk === 'risk' ? 'alle' : 'risk',
              }))}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                filters.returnRisk === 'risk'
                  ? 'border-orange-400 bg-orange-100 text-orange-800 dark:border-orange-700 dark:bg-orange-950/40 dark:text-orange-300'
                  : 'border-border bg-background text-foreground hover:bg-muted/60',
              )}
            >
              <TrendingDown className="h-3.5 w-3.5" />
              {NUM0.format(returnRiskCount)} gefährdete Stammgäste
            </button>
          )}

          {filtersActive && (
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Filter className="h-3.5 w-3.5" />
                Filter aktiv — {NUM0.format(sorted.length)} von {NUM0.format(allMetrics.length)} Gästen
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
      )}

      {/* Export der aktuell gefilterten Liste */}
      {tablesOk && sorted.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            onClick={() => downloadCsv(guestListExportTable(sorted))}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            <FileDown className="h-4 w-4" />
            CSV
          </button>
          <button
            onClick={() => void downloadXlsx(guestListExportTable(sorted))}
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
      ) : tablesOk && sorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          {allMetrics.length === 0
            ? 'Noch keine Gäste vorhanden. Importiere zuerst Reservationen.'
            : 'Keine Gäste passen zu Suche und Filter.'}
        </div>
      ) : tablesOk ? (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/50 [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted [&_th]:border-b [&_th]:border-border">
              <tr>
                <SortHeader label="Gast" k="name" />
                <SortHeader label="Segment" k="segment" />
                <SortHeader label="Firma" k="company" />
                <SortHeader label="Geburtstag" k="birthday" align="right" />
                <SortHeader label="Besuche" k="visits" align="right" />
                <SortHeader label="Ø Gruppe" k="partySize" align="right" />
                <SortHeader label="Erster Besuch" k="firstVisit" align="right" />
                <SortHeader label="Letzter Besuch" k="lastVisit" align="right" />
                <SortHeader label="Ø Intervall" k="interval" align="right" />
                <SortHeader label="Tage seit letztem" k="sinceLast" align="right" />
                <SortHeader label="Rückkehr-Risiko" k="returnRisk" align="right" />
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {sorted.map(m => (
                <tr
                  key={m.id}
                  onClick={() => navigate(`/gaeste/${m.id}`)}
                  className="cursor-pointer border-t border-border hover:bg-muted/40"
                >
                  <td className="px-3 py-2">
                    <div className="font-medium">{m.displayName}</div>
                    {(m.email || m.mobile) && (
                      <div className="text-[11px] text-muted-foreground">
                        {m.email || m.mobile}
                      </div>
                    )}
                    <CrmBadges crm={m.crm} />
                  </td>
                  <td className="px-3 py-2"><SegmentBadge segment={m.segment} /></td>
                  <td className="px-3 py-2 text-muted-foreground">{m.crm?.company || '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{fdate(m.crm?.birthday)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{NUM0.format(m.visits)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {m.avgPartySize === null ? '—' : fnum(m.avgPartySize, NUM1)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{fdate(m.firstVisit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fdate(m.lastVisit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {m.avgDaysBetweenVisits === null ? '—' : `${fnum(m.avgDaysBetweenVisits, NUM1)} Tage`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {m.daysSinceLastVisit === null ? '—' : `${NUM0.format(m.daysSinceLastVisit)} Tage`}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ReturnRiskCell metric={m} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tablesOk && sorted.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {NUM0.format(sorted.length)} von {NUM0.format(allMetrics.length)} Gästen angezeigt.
        </p>
      )}
    </div>
  );
}
