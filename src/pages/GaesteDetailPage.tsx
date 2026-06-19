/**
 * GaesteDetailPage — Gäste-CRM (Detail)
 * ======================================
 * Kennzahlen-Übersicht eines einzelnen Gastes plus alle Reservationen
 * chronologisch.  Alle Kennzahlen werden aus den Einzelreservationen
 * (`reservation_records`) berechnet (siehe reservation-crm.ts) — reine
 * Lese-/Analyseansicht, keine Bearbeitung.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ArrowLeft, Loader2, CalendarCheck, CalendarX, Ban, Users as UsersIcon,
  Clock, CalendarRange, Repeat, Mail, Phone, MapPin, StickyNote,
  Crown, Star, UserPlus, Moon, CircleSlash,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';

import { fetchGuestById, fetchGuestReservations, type GuestReservationDisplay } from '@/lib/reservation-crm-db';
import {
  guestDetailMetrics, guestDisplayName, SEGMENT_LABEL,
  type GuestProfile, type GuestSegment,
} from '@/lib/reservation-crm';
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

// ── Kachel ────────────────────────────────────────────────────────────────────

function Tile({ icon: Icon, label, value, accent }: {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className={cn('mt-1 text-xl font-bold tabular-nums', accent)}>{value}</p>
    </div>
  );
}

// ── Komponente ────────────────────────────────────────────────────────────────

export default function GaesteDetailPage() {
  const { guestId } = useParams<{ guestId: string }>();
  const { tenantId } = useTenant();
  const { isAdmin } = usePermissions();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<GuestProfile | null>(null);
  const [reservations, setReservations] = useState<GuestReservationDisplay[]>([]);

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

  if (!isAdmin) return <Navigate to="/" replace />;

  const name = profile ? guestDisplayName(profile) : 'Gast';
  const SegIcon = SEGMENT_ICON[metrics.segment];

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
            <span className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-semibold',
              SEGMENT_CLASS[metrics.segment],
            )}>
              <SegIcon className="h-4 w-4" />
              {SEGMENT_LABEL[metrics.segment]}
            </span>
          </div>

          {/* Kennzahlen */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            <Tile icon={CalendarCheck} label="Besuche" value={NUM0.format(metrics.visits)} accent="text-emerald-600 dark:text-emerald-400" />
            <Tile icon={CalendarRange} label="Reservationen total" value={NUM0.format(metrics.totalReservations)} />
            <Tile icon={CalendarX} label="Storniert" value={NUM0.format(metrics.cancelledCount)} accent="text-red-600 dark:text-red-400" />
            <Tile icon={Ban} label="No-Show" value={NUM0.format(metrics.noShowCount)} accent="text-orange-600 dark:text-orange-400" />
            <Tile icon={UsersIcon} label="Ø Gruppengrösse" value={metrics.avgPartySize === null ? '—' : NUM1.format(metrics.avgPartySize)} />
            <Tile icon={Repeat} label="Ø Besuchsintervall" value={metrics.avgDaysBetweenVisits === null ? '—' : `${NUM1.format(metrics.avgDaysBetweenVisits)} Tage`} />
            <Tile icon={Clock} label="Tage seit letztem Besuch" value={metrics.daysSinceLastVisit === null ? '—' : `${NUM0.format(metrics.daysSinceLastVisit)} Tage`} />
            <Tile icon={CalendarRange} label="Erster / letzter Besuch" value={`${fdate(metrics.firstVisit)} – ${fdate(metrics.lastVisit)}`} />
          </div>

          {/* Reservationen */}
          <div>
            <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
              <CalendarRange className="h-5 w-5 text-primary" />
              Reservationen ({NUM0.format(reservations.length)})
            </h2>
            {reservations.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
                Keine Reservationen für diesen Gast.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Datum</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Zeit</th>
                      <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Personen</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Raum / Bereich</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Notiz</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reservations.map(r => {
                      const roomArea = [r.room, r.area].filter(Boolean).join(' · ');
                      const note = [r.note, r.comment].filter(Boolean).join(' — ');
                      return (
                        <tr key={r.id} className="border-t border-border">
                          <td className="px-3 py-2 tabular-nums">{fdate(r.reservationDate)}</td>
                          <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.reservationTime ?? '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.partySize ?? '—'}</td>
                          <td className="px-3 py-2">
                            <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', STATUS_CLASS[r.statusNormalized])}>
                              {STATUS_LABEL[r.statusNormalized]}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {roomArea ? (
                              <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{roomArea}</span>
                            ) : '—'}
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
          </div>
        </>
      )}
    </div>
  );
}
