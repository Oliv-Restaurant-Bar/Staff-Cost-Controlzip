/**
 * GaesteDetailPage — Gäste-CRM (Kundenakte)
 * ==========================================
 * Vollständige CRM-Kundenakte eines einzelnen Gastes: Besuchsverhalten,
 * Präferenzen, Risiko, Besuchstrend, CRM-Score und die filterbare
 * Reservierungs-Historie.  Alle Kennzahlen werden live aus den
 * Einzelreservationen (`reservation_records`) berechnet (siehe
 * reservation-crm.ts / reservation-guest-profile.ts) — reine Lese-/
 * Analyseansicht, keine Bearbeitung.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ArrowLeft, Loader2, CalendarCheck, CalendarX, Ban, Users as UsersIcon,
  Clock, CalendarRange, Repeat, Mail, Phone, MapPin, StickyNote,
  Sigma, Gauge, TrendingUp, TrendingDown, Minus, AlertTriangle,
  ShieldCheck, ShieldAlert, CalendarDays, Hash, Hourglass,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';

import { fetchGuestById, fetchGuestReservations, type GuestReservationDisplay } from '@/lib/reservation-crm-db';
import {
  guestDetailMetrics, guestDisplayName, guestListMetricsFromDetail,
  type GuestProfile,
} from '@/lib/reservation-crm';
import { overdueByDays, isOverdue, isAtRiskTier } from '@/lib/reservation-dashboard';
import {
  computeGuestPreferences, computeVisitTrend, computeCrmScore, totalPersonsOnVisits,
  filterReservationHistory, CRM_SCORE_TIER_LABEL,
  type HistoryFilter, type CrmScoreTier, type TrendDirection,
} from '@/lib/reservation-guest-profile';
import { SegmentBadge } from '@/components/crm/SegmentBadge';
import type { ReservationStatusNormalized } from '@/lib/reservation-import-parser';

// ── Formatierung ──────────────────────────────────────────────────────────────

const NUM0 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const NUM1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function fdate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return fmtDate(parseISO(iso.slice(0, 10)), 'dd.MM.yyyy', { locale: de }); }
  catch { return iso; }
}

// ── Status-Darstellung ────────────────────────────────────────────────────────

const STATUS_LABEL: Record<ReservationStatusNormalized, string> = {
  completed: 'Abgeschlossen',
  cancelled: 'Storniert',
  noshow:    'No-Show',
  confirmed: 'Bestätigt',
  pending:   'Offen',
  unknown:   'Unbekannt',
};

const STATUS_CLASS: Record<ReservationStatusNormalized, string> = {
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  noshow:    'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
  confirmed: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  pending:   'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
  unknown:   'bg-muted text-muted-foreground',
};

// ── CRM-Score-Stufen ──────────────────────────────────────────────────────────

const TIER_CLASS: Record<CrmScoreTier, string> = {
  niedrig:       'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
  mittel:        'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  hoch:          'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  vip_potenzial: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
};

const TIER_BAR: Record<CrmScoreTier, string> = {
  niedrig:       'bg-slate-400',
  mittel:        'bg-blue-500',
  hoch:          'bg-emerald-500',
  vip_potenzial: 'bg-amber-500',
};

// ── Trend-Darstellung ─────────────────────────────────────────────────────────

const TREND_META: Record<TrendDirection, { label: string; icon: React.FC<{ className?: string }>; cls: string }> = {
  steigend:   { label: 'Steigend',   icon: TrendingUp,   cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' },
  stabil:     { label: 'Stabil',     icon: Minus,        cls: 'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300' },
  rückläufig: { label: 'Rückläufig', icon: TrendingDown, cls: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300' },
};

// ── Bausteine ─────────────────────────────────────────────────────────────────

function Section({ icon: Icon, title, children }: {
  icon: React.FC<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <Icon className="h-5 w-5 text-primary" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Tile({ icon: Icon, label, value, accent }: {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className={cn('mt-1 text-xl font-bold tabular-nums', accent)}>{value}</p>
    </div>
  );
}

function ScoreComponentBar({ label, value, tier }: { label: string; value: number; tier: CrmScoreTier }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{NUM0.format(value)}</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full', TIER_BAR[tier])} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

const HISTORY_FILTERS: { id: HistoryFilter; label: string }[] = [
  { id: 'alle',      label: 'Alle' },
  { id: 'besuche',   label: 'Nur Besuche' },
  { id: 'storniert', label: 'Nur Storniert' },
  { id: 'noshow',    label: 'Nur No-Show' },
];

// ── Komponente ────────────────────────────────────────────────────────────────

export default function GaesteDetailPage() {
  const { guestId } = useParams<{ guestId: string }>();
  const { tenantId } = useTenant();
  const { isAdmin } = usePermissions();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<GuestProfile | null>(null);
  const [reservations, setReservations] = useState<GuestReservationDisplay[]>([]);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('alle');

  const today = useMemo(() => fmtDate(new Date(), 'yyyy-MM-dd'), []);

  const load = useCallback(async () => {
    if (!guestId) return;
    if (!isAdmin) { setLoading(false); return; }   // Datenschutz: keine Gäste-Reads für Nicht-Admins
    setLoading(true);
    const [p, recs] = await Promise.all([
      fetchGuestById(tenantId, guestId),
      fetchGuestReservations(tenantId, guestId),
    ]);
    setProfile(p);
    setReservations(recs);
    setLoading(false);
  }, [tenantId, guestId, isAdmin]);

  useEffect(() => { void load(); }, [load]);

  const metrics = useMemo(() => guestDetailMetrics(reservations, today), [reservations, today]);
  const preferences = useMemo(() => computeGuestPreferences(reservations), [reservations]);
  const trend = useMemo(() => computeVisitTrend(reservations, today), [reservations, today]);
  const totalPersons = useMemo(() => totalPersonsOnVisits(reservations), [reservations]);
  const crmScore = useMemo(() => computeCrmScore({
    visits: metrics.visits,
    daysSinceLastVisit: metrics.daysSinceLastVisit,
    avgDaysBetweenVisits: metrics.avgDaysBetweenVisits,
    avgPartySize: metrics.avgPartySize,
  }), [metrics]);
  const risk = useMemo(() => {
    if (!profile) return null;
    const lm = guestListMetricsFromDetail(profile, metrics);
    return {
      overdue: isOverdue(lm),
      overdueDays: overdueByDays(lm),
      atRisk: isAtRiskTier(lm, 'stammgast') || isAtRiskTier(lm, 'vip'),
    };
  }, [profile, metrics]);
  const filteredReservations = useMemo(
    () => filterReservationHistory(reservations, historyFilter),
    [reservations, historyFilter],
  );

  if (!isAdmin) return <Navigate to="/" replace />;

  const name = profile ? guestDisplayName(profile) : 'Gast';
  const trendMeta = TREND_META[trend.direction];
  const TrendIcon = trendMeta.icon;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <button
        onClick={() => navigate('/gaeste')}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Zurück zur Gästeliste
      </button>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Gast wird geladen…
        </div>
      ) : !profile ? (
        <div className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          Dieser Gast wurde nicht gefunden.
        </div>
      ) : (
        <>
          {/* Kopf */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">{name}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                {profile.email && (
                  <span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5" />{profile.email}</span>
                )}
                {profile.mobile && (
                  <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{profile.mobile}</span>
                )}
              </div>
            </div>
            <SegmentBadge segment={metrics.segment} />
          </div>

          {/* CRM-Score */}
          <Section icon={Gauge} title="CRM-Score">
            <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
              <div className="flex items-center gap-4">
                <div className="flex h-24 w-24 flex-col items-center justify-center rounded-full border-4 border-border">
                  <span className="text-3xl font-bold tabular-nums leading-none">{NUM0.format(crmScore.score)}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">von 100</span>
                </div>
                <span className={cn('inline-flex items-center rounded-md px-2.5 py-1 text-sm font-semibold', TIER_CLASS[crmScore.tier])}>
                  {CRM_SCORE_TIER_LABEL[crmScore.tier]}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                <ScoreComponentBar label="Besuchsanzahl (40%)" value={crmScore.components.visits} tier={crmScore.tier} />
                <ScoreComponentBar label="Aktualität (25%)" value={crmScore.components.recency} tier={crmScore.tier} />
                <ScoreComponentBar label="Regelmässigkeit (20%)" value={crmScore.components.regularity} tier={crmScore.tier} />
                <ScoreComponentBar label="Gruppengrösse (15%)" value={crmScore.components.partySize} tier={crmScore.tier} />
              </div>
            </div>
          </Section>

          {/* Besuchsverhalten */}
          <Section icon={CalendarCheck} title="Besuchsverhalten">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Segment</div>
                <div className="mt-1"><SegmentBadge segment={metrics.segment} /></div>
              </div>
              <Tile icon={CalendarCheck} label="Total Besuche" value={NUM0.format(metrics.visits)} accent="text-emerald-600 dark:text-emerald-400" />
              <Tile icon={CalendarRange} label="Reservationen total" value={NUM0.format(metrics.totalReservations)} />
              <Tile icon={CalendarRange} label="Erster Besuch" value={fdate(metrics.firstVisit)} />
              <Tile icon={CalendarRange} label="Letzter Besuch" value={fdate(metrics.lastVisit)} />
              <Tile icon={Clock} label="Tage seit letztem Besuch" value={metrics.daysSinceLastVisit === null ? '—' : `${NUM0.format(metrics.daysSinceLastVisit)} Tage`} />
              <Tile icon={Repeat} label="Ø Besuchsintervall" value={metrics.avgDaysBetweenVisits === null ? '—' : `${NUM1.format(metrics.avgDaysBetweenVisits)} Tage`} />
              <Tile icon={UsersIcon} label="Ø Gruppengrösse" value={metrics.avgPartySize === null ? '—' : NUM1.format(metrics.avgPartySize)} />
              <Tile icon={Sigma} label="Total Personen (Besuche)" value={NUM0.format(totalPersons)} />
            </div>
          </Section>

          {/* Präferenzen */}
          <Section icon={MapPin} title="Präferenzen">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile icon={MapPin} label="Lieblingsbereich" value={preferences.favoriteArea ?? '—'} />
              <Tile icon={CalendarDays} label="Lieblingswochentag" value={preferences.favoriteWeekday ?? '—'} />
              <Tile icon={Clock} label="Lieblingszeit" value={preferences.favoriteTime ?? '—'} />
              <Tile icon={Hash} label="Häufigste Gruppengrösse" value={preferences.mostCommonPartySize === null ? '—' : NUM0.format(preferences.mostCommonPartySize)} />
            </div>
          </Section>

          {/* Risiko */}
          <Section icon={AlertTriangle} title="Risiko">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <Tile icon={Ban} label="No-Shows" value={NUM0.format(metrics.noShowCount)} accent={metrics.noShowCount > 0 ? 'text-orange-600 dark:text-orange-400' : undefined} />
              <Tile icon={CalendarX} label="Stornierungen" value={NUM0.format(metrics.cancelledCount)} accent={metrics.cancelledCount > 0 ? 'text-red-600 dark:text-red-400' : undefined} />
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Hourglass className="h-3.5 w-3.5" />
                  Überfällig
                </div>
                <p className={cn('mt-1 text-xl font-bold', risk?.overdue ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                  {risk?.overdue ? 'Ja' : 'Nein'}
                </p>
              </div>
              <Tile
                icon={Hourglass}
                label="Überfällig seit"
                value={risk?.overdue && risk.overdueDays !== null ? `${NUM0.format(Math.round(risk.overdueDays))} Tage` : '—'}
                accent={risk?.overdue ? 'text-red-600 dark:text-red-400' : undefined}
              />
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {risk?.atRisk ? <ShieldAlert className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                  Gefährdet
                </div>
                <p className={cn('mt-1 text-xl font-bold', risk?.atRisk ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                  {risk?.atRisk ? 'Ja' : 'Nein'}
                </p>
              </div>
            </div>
          </Section>

          {/* Trend */}
          <Section icon={TrendingUp} title="Besuchstrend (90 Tage)">
            <div className="flex flex-wrap items-center gap-3">
              <Tile icon={CalendarCheck} label="Letzte 90 Tage" value={NUM0.format(trend.last90)} />
              <Tile icon={CalendarRange} label="Vorherige 90 Tage" value={NUM0.format(trend.previous90)} />
              <span className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold', trendMeta.cls)}>
                <TrendIcon className="h-4 w-4" />
                {trendMeta.label}
              </span>
            </div>
          </Section>

          {/* Reservierungshistorie */}
          <Section icon={CalendarRange} title={`Reservierungshistorie (${NUM0.format(filteredReservations.length)})`}>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {HISTORY_FILTERS.map(f => (
                <button
                  key={f.id}
                  onClick={() => setHistoryFilter(f.id)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
                    historyFilter === f.id
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/70',
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {filteredReservations.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
                Keine Reservationen für diese Auswahl.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Datum</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Uhrzeit</th>
                      <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Personen</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Bereich</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Notiz</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReservations.map(r => {
                      const roomArea = [r.room, r.area].filter(Boolean).join(' · ');
                      const note = [r.note, r.comment].filter(Boolean).join(' — ');
                      return (
                        <tr key={r.id} className="border-t border-border">
                          <td className="px-3 py-2 tabular-nums">{fdate(r.reservationDate)}</td>
                          <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.reservationTime ?? '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.partySize ?? '—'}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {roomArea ? (
                              <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{roomArea}</span>
                            ) : '—'}
                          </td>
                          <td className="px-3 py-2">
                            <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', STATUS_CLASS[r.statusNormalized])}>
                              {STATUS_LABEL[r.statusNormalized]}
                            </span>
                          </td>
                          <td className="max-w-[24rem] px-3 py-2 text-muted-foreground">
                            {note ? (
                              <span className="inline-flex items-start gap-1"><StickyNote className="mt-0.5 h-3 w-3 flex-shrink-0" />{note}</span>
                            ) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
