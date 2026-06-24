/**
 * ReservationDetailList — aufklappbare Detailliste der CRM-Auswertung
 * ===================================================================
 * Zeigt die Reservationen einer angeklickten Zukunfts- bzw. Zeitraum-Kachel:
 * Datum, Uhrzeit, Gastname, Personen, Status, Raum/Bereich, Telefon/E-Mail und
 * (optional) Kommentar. Sortierung/Filterung erfolgt in der reinen Logik
 * (reservation-dashboard.ts), damit Kachelzahl und Listenlänge exakt passen.
 * Tabelle auf Desktop, Karten auf Mobile. Nur Anzeige (admin-gated Aufrufer).
 */

import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { CalendarClock, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STATUS_LABEL, STATUS_CLASS } from '@/components/reservations/ReservationSummary';
import { GuestProfileLink } from '@/components/crm/GuestProfileLink';
import type { ReservationStatusNormalized } from '@/lib/reservation-import-parser';
import type { ReservationDetailRow } from '@/lib/reservation-dashboard';

const NUM0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });

const KNOWN_STATUSES: ReservationStatusNormalized[] = [
  'completed', 'cancelled', 'noshow', 'confirmed', 'pending', 'unknown',
];

function asKnownStatus(raw: string): ReservationStatusNormalized | null {
  const k = raw.trim().toLowerCase();
  return KNOWN_STATUSES.includes(k as ReservationStatusNormalized)
    ? (k as ReservationStatusNormalized)
    : null;
}

function statusLabel(raw: string): string {
  const k = asKnownStatus(raw);
  return k ? STATUS_LABEL[k] : (raw.trim() || 'Unbekannt');
}

function statusClass(raw: string): string {
  const k = asKnownStatus(raw);
  return k ? STATUS_CLASS[k] : 'bg-muted text-muted-foreground';
}

function fdate(iso: string | null): string {
  if (!iso) return '—';
  try { return fmtDate(parseISO(iso.slice(0, 10)), 'dd.MM.yyyy', { locale: de }); }
  catch { return iso; }
}

function roomArea(r: ReservationDetailRow): string {
  const parts = Array.from(new Set([r.area, r.room].map(s => (s ?? '').trim()).filter(Boolean)));
  return parts.length ? parts.join(' · ') : '—';
}

function contact(r: ReservationDetailRow): string {
  const phone = (r.phone ?? '').trim();
  if (phone) return phone;
  const email = (r.email ?? '').trim();
  return email || '—';
}

function noteText(r: ReservationDetailRow): string {
  return [r.comment, r.note].map(s => (s ?? '').trim()).filter(Boolean).join(' — ');
}

export function ReservationDetailList({ title, rows, persons, onSelectGuest }: {
  title: string;
  rows: ReservationDetailRow[];
  persons: number;
  onSelectGuest?: (guestId: string) => void;
}) {
  return (
    <div className="mt-3 rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <CalendarClock className="h-4 w-4 text-primary" />
          {title}
        </h3>
        <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
          <Users className="h-3.5 w-3.5" />
          {NUM0.format(rows.length)} {rows.length === 1 ? 'Reservation' : 'Reservationen'}
          {' · '}
          {NUM0.format(persons)} {persons === 1 ? 'Person' : 'Personen'}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          Keine Reservationen in dieser Auswahl.
        </div>
      ) : (
        <>
          {/* Desktop-Tabelle */}
          <div className="hidden max-h-[60vh] overflow-auto md:block">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted [&_th]:border-b [&_th]:border-border">
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Datum</th>
                  <th className="px-3 py-2 font-medium">Uhrzeit</th>
                  <th className="px-3 py-2 font-medium">Gast</th>
                  <th className="px-3 py-2 text-right font-medium">Personen</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Raum / Bereich</th>
                  <th className="px-3 py-2 font-medium">Telefon / E-Mail</th>
                  <th className="px-3 py-2 font-medium">Kommentar</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const note = noteText(r);
                  return (
                    <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                      <td className="px-3 py-2 tabular-nums">{fdate(r.date)}</td>
                      <td className="px-3 py-2 tabular-nums">{r.time ?? '—'}</td>
                      <td className="px-3 py-2">
                        <GuestProfileLink name={r.displayName} guestId={r.guestId} onSelect={onSelectGuest} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.partySize ?? '—'}</td>
                      <td className="px-3 py-2">
                        <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', statusClass(r.status))}>
                          {statusLabel(r.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{roomArea(r)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{contact(r)}</td>
                      <td className="px-3 py-2 max-w-[240px] truncate text-muted-foreground" title={note || undefined}>
                        {note || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile-Karten */}
          <div className="divide-y divide-border md:hidden">
            {rows.map(r => {
              const note = noteText(r);
              const ra = roomArea(r);
              const c = contact(r);
              const ps = r.partySize ?? 0;
              return (
                <div key={r.id} className="space-y-1 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <GuestProfileLink name={r.displayName} guestId={r.guestId} onSelect={onSelectGuest} />
                    <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', statusClass(r.status))}>
                      {statusLabel(r.status)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
                    <span>{fdate(r.date)}{r.time ? `, ${r.time}` : ''}</span>
                    <span>{NUM0.format(ps)} {ps === 1 ? 'Person' : 'Personen'}</span>
                    {ra !== '—' && <span>{ra}</span>}
                  </div>
                  {c !== '—' && <div className="text-xs text-muted-foreground">{c}</div>}
                  {note && <div className="text-xs text-muted-foreground">{note}</div>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
