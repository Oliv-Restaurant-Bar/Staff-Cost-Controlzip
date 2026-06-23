/**
 * ReservationSummary — gemeinsame Zusammenfassung für Foratable-Reservationen
 * ==========================================================================
 * Rendert exakt dieselben Kacheln/Listen wie die CSV-Vorschau im
 * Reservationen-Import.  Wird sowohl vom Import (`ReservationenImportPage`) als
 * auch vom `Foratable Report` verwendet, damit Layout UND Zahlen identisch sind
 * (die Zahlen stammen aus `computeReservationStats`).
 *
 * Die Formatierer und Status-Maps werden mit-exportiert, damit Aufrufer (z. B.
 * der PDF-Export des Reports) dieselbe Darstellung nutzen können.
 */

import {
  FileText, Users, Clock, MapPin, CalendarRange,
  CheckCircle2, UserPlus, UserCheck, Ban,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import type {
  ReservationPreviewStats, ReservationStatusNormalized,
} from '@/lib/reservation-import-parser';

// ── Formatierung ──────────────────────────────────────────────────────────────

export const NUM0 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
export const NUM1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function fdate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return fmtDate(parseISO(iso.slice(0, 10)), 'dd.MM.yyyy', { locale: de }); }
  catch { return iso; }
}

// ── Status-Darstellung ────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<ReservationStatusNormalized, string> = {
  completed: 'Abgeschlossen',
  cancelled: 'Storniert',
  noshow:    'No-Show',
  confirmed: 'Bestätigt',
  pending:   'Offen',
  unknown:   'Unbekannt',
};

export const STATUS_CLASS: Record<ReservationStatusNormalized, string> = {
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  noshow:    'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
  confirmed: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  pending:   'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
  unknown:   'bg-muted text-muted-foreground',
};

// ── Kachel ────────────────────────────────────────────────────────────────────

export function Tile({ icon: Icon, label, value, accent }: {
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

// ── Zusammenfassung ─────────────────────────────────────────────────────────

interface ReservationSummaryProps {
  stats: ReservationPreviewStats;
  /** Anzahl neuer Gäste; `null` = unbekannt (zeigt „—“ bzw. „…“). */
  newGuests: number | null;
  /** Anzahl wiederkehrender Gäste; `null` = unbekannt. */
  returningGuests: number | null;
  /** Während die Gäste noch geladen/klassifiziert werden → „…“. */
  guestsLoading?: boolean;
  /** Optionaler zusätzlicher Hinweis (z. B. übersprungene CSV-Zeilen). */
  extraNote?: React.ReactNode;
  className?: string;
}

export function ReservationSummary({
  stats, newGuests, returningGuests, guestsLoading = false, extraNote, className,
}: ReservationSummaryProps) {
  const guestValue = (n: number | null) =>
    guestsLoading ? '…' : n !== null ? NUM0.format(n) : '—';

  const showNotes = !!extraNote || stats.unknownStatusCount > 0 || stats.reservationsWithoutGuestKey > 0;

  return (
    <div className={cn('space-y-5', className)}>
      {/* Kacheln */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile icon={CalendarRange} label="Zeitraum"
          value={stats.periodFrom ? `${fdate(stats.periodFrom)} – ${fdate(stats.periodTo)}` : '—'} />
        <Tile icon={FileText} label="Reservationen" value={NUM0.format(stats.reservationCount)} />
        <Tile icon={Users} label="Personen" value={NUM0.format(stats.totalPersons)} />
        <Tile icon={Users} label="Ø Gruppe"
          value={stats.avgPartySize !== null ? NUM1.format(stats.avgPartySize) : '—'} />
        <Tile icon={CheckCircle2} label="Abgeschlossen" value={NUM0.format(stats.completedCount)}
          accent="text-emerald-600 dark:text-emerald-400" />
        <Tile icon={Ban} label="Storniert" value={NUM0.format(stats.cancelledCount)}
          accent="text-red-600 dark:text-red-400" />
        <Tile icon={UserPlus} label="Neue Gäste" value={guestValue(newGuests)}
          accent="text-blue-600 dark:text-blue-400" />
        <Tile icon={UserCheck} label="Wiederkehrend" value={guestValue(returningGuests)}
          accent="text-violet-600 dark:text-violet-400" />
      </div>

      {/* Hinweise */}
      {showNotes && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 p-3 text-sm text-amber-800 dark:text-amber-300 space-y-1">
          {extraNote}
          {stats.unknownStatusCount > 0 && <p>• {stats.unknownStatusCount} Reservation(en) mit unbekanntem Status.</p>}
          {stats.reservationsWithoutGuestKey > 0 && <p>• {stats.reservationsWithoutGuestKey} Reservation(en) ohne Gast-Kennung — nicht einem Gast zugeordnet.</p>}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-5">
        {/* Status-Verteilung */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3">Status-Verteilung</h3>
          <div className="space-y-1.5">
            {stats.statusDistribution.map((s) => (
              <div key={s.status} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', STATUS_CLASS[s.normalized])}>
                    {STATUS_LABEL[s.normalized]}
                  </span>
                  <span className="text-muted-foreground truncate max-w-[160px]">{s.status}</span>
                </span>
                <span className="font-medium tabular-nums">{NUM0.format(s.count)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Top-Zeiten */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <Clock className="h-4 w-4" /> Häufigste Zeiten
          </h3>
          {stats.topTimes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Keine Zeiten erkannt.</p>
          ) : (
            <div className="space-y-1.5">
              {stats.topTimes.map((t) => (
                <div key={t.time} className="flex items-center justify-between text-sm">
                  <span className="font-medium tabular-nums">{t.time}</span>
                  <span className="text-muted-foreground">
                    {NUM0.format(t.count)} Res. · {NUM0.format(t.persons)} Pers.
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Räume */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <MapPin className="h-4 w-4" /> Räume
          </h3>
          {stats.rooms.length === 0 ? (
            <p className="text-sm text-muted-foreground">Keine Räume erkannt.</p>
          ) : (
            <div className="space-y-1.5">
              {stats.rooms.slice(0, 10).map((r) => (
                <div key={r.name} className="flex items-center justify-between text-sm">
                  <span className="truncate max-w-[200px]">{r.name}</span>
                  <span className="font-medium tabular-nums">{NUM0.format(r.count)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Bereiche */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <MapPin className="h-4 w-4" /> Bereiche
          </h3>
          {stats.areas.length === 0 ? (
            <p className="text-sm text-muted-foreground">Keine Bereiche erkannt.</p>
          ) : (
            <div className="space-y-1.5">
              {stats.areas.slice(0, 10).map((a) => (
                <div key={a.name} className="flex items-center justify-between text-sm">
                  <span className="truncate max-w-[200px]">{a.name}</span>
                  <span className="font-medium tabular-nums">{NUM0.format(a.count)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
