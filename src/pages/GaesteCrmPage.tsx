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
  Crown, Star, Repeat, UserPlus, Moon, CircleSlash, ArrowRight,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { useNavigate, Navigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';

import { fetchGuestProfiles, fetchCompletedVisitAggregates } from '@/lib/reservation-crm-db';
import { checkReservationTablesExist } from '@/lib/reservation-import-db';
import {
  guestListMetrics, countSegments, SEGMENT_LABEL, SEGMENT_ORDER,
  type GuestListMetrics, type GuestSegment, type CompletedVisitAgg,
} from '@/lib/reservation-crm';

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

// ── Segment-Darstellung ───────────────────────────────────────────────────────

const SEGMENT_CLASS: Record<GuestSegment, string> = {
  vip:           'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  stammgast:     'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
  wiederkehrend: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  neukunde:      'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  inaktiv:       'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  ohne_besuch:   'bg-muted text-muted-foreground',
};

const SEGMENT_ICON: Record<GuestSegment, React.FC<{ className?: string }>> = {
  vip:           Crown,
  stammgast:     Star,
  wiederkehrend: Repeat,
  neukunde:      UserPlus,
  inaktiv:       Moon,
  ohne_besuch:   CircleSlash,
};

function SegmentBadge({ segment }: { segment: GuestSegment }) {
  const Icon = SEGMENT_ICON[segment];
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
      SEGMENT_CLASS[segment],
    )}>
      <Icon className="h-3 w-3" />
      {SEGMENT_LABEL[segment]}
    </span>
  );
}

// ── Sortierung ────────────────────────────────────────────────────────────────

type SortKey = 'name' | 'segment' | 'visits' | 'firstVisit' | 'lastVisit' | 'interval' | 'sinceLast';
type SortDir = 'asc' | 'desc';

function compare(a: GuestListMetrics, b: GuestListMetrics, key: SortKey): number {
  const nullableNum = (x: number | null) => (x === null ? Number.NEGATIVE_INFINITY : x);
  const nullableStr = (x: string | null) => x ?? '';
  switch (key) {
    case 'name':       return a.displayName.localeCompare(b.displayName, 'de');
    case 'segment':    return SEGMENT_ORDER.indexOf(a.segment) - SEGMENT_ORDER.indexOf(b.segment);
    case 'visits':     return a.visits - b.visits;
    case 'firstVisit': return nullableStr(a.firstVisit).localeCompare(nullableStr(b.firstVisit));
    case 'lastVisit':  return nullableStr(a.lastVisit).localeCompare(nullableStr(b.lastVisit));
    case 'interval':   return nullableNum(a.avgDaysBetweenVisits) - nullableNum(b.avgDaysBetweenVisits);
    case 'sinceLast':  return nullableNum(a.daysSinceLastVisit) - nullableNum(b.daysSinceLastVisit);
    default:           return 0;
  }
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
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('visits');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const today = useMemo(() => fmtDate(new Date(), 'yyyy-MM-dd'), []);

  const load = useCallback(async () => {
    if (!isAdmin) { setLoading(false); return; }   // Datenschutz: keine Gäste-Reads für Nicht-Admins
    setLoading(true);
    const ok = await checkReservationTablesExist();
    setTablesOk(ok);
    if (ok) {
      const [ps, aggs] = await Promise.all([
        fetchGuestProfiles(tenantId),
        fetchCompletedVisitAggregates(tenantId),
      ]);
      setProfiles(ps);
      setVisitAggs(aggs);
    } else {
      setProfiles([]);
      setVisitAggs(new Map());
    }
    setLoading(false);
  }, [tenantId, isAdmin]);

  useEffect(() => { void load(); }, [load]);

  const allMetrics = useMemo(
    () => profiles.map(p => guestListMetrics(p, visitAggs.get(p.id), today)),
    [profiles, visitAggs, today],
  );

  const segmentCounts = useMemo(() => countSegments(allMetrics), [allMetrics]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allMetrics;
    return allMetrics.filter(m =>
      m.displayName.toLowerCase().includes(q) ||
      (m.email ?? '').toLowerCase().includes(q) ||
      (m.mobile ?? '').toLowerCase().includes(q),
    );
  }, [allMetrics, query]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const base = compare(a, b, sortKey);
      return sortDir === 'asc' ? base : -base;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Text aufsteigend, Zahlen/Daten absteigend vorbelegen.
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  if (!isAdmin) return <Navigate to="/" replace />;

  const SortHeader = ({ label, k, align = 'left' }: { label: string; k: SortKey; align?: 'left' | 'right' }) => (
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

      {/* Suche */}
      {tablesOk && (
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
            : 'Keine Gäste passen zur Suche.'}
        </div>
      ) : tablesOk ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/50">
              <tr>
                <SortHeader label="Gast" k="name" />
                <SortHeader label="Segment" k="segment" />
                <SortHeader label="Besuche" k="visits" align="right" />
                <SortHeader label="Erster Besuch" k="firstVisit" align="right" />
                <SortHeader label="Letzter Besuch" k="lastVisit" align="right" />
                <SortHeader label="Ø Intervall" k="interval" align="right" />
                <SortHeader label="Tage seit letztem" k="sinceLast" align="right" />
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
                  </td>
                  <td className="px-3 py-2"><SegmentBadge segment={m.segment} /></td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{NUM0.format(m.visits)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{fdate(m.firstVisit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fdate(m.lastVisit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {m.avgDaysBetweenVisits === null ? '—' : `${fnum(m.avgDaysBetweenVisits, NUM1)} Tage`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {m.daysSinceLastVisit === null ? '—' : `${NUM0.format(m.daysSinceLastVisit)} Tage`}
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
