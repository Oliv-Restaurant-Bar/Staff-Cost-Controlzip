/**
 * useDayDemandContext — lädt Reservationszahlen als Nachfrage-Kontext für einen
 * Tag im Personalbedarf-SOLL/Ist-Abgleich (NUR Anzeige, read-only).
 *
 * EIN mandantengefilterter Range-Fetch (ältestes Lookback-Vorkommen → Zieltag);
 * die Detail-Zeilen werden SOFORT auf {date, partySize, status} projiziert —
 * ReservationDetailRow enthält Gast-PII (Name/Telefon/E-Mail), die hier nie in
 * State, Props oder Logs landen darf.
 *
 * Gating: Reservations-Flächen sind admin-only (isAdmin && !isGuest) — für
 * andere Rollen liefert der Hook 'hidden' und lädt NICHTS.
 */

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import { fetchReservationsInRange } from '@/lib/reservation-crm-db';
import { checkReservationTablesExist } from '@/lib/reservation-import-db';
import {
  buildDayDemandContext,
  demandContextLoadFrom,
  type DayDemandContext,
  type DemandContextRow,
} from '@/lib/staffing-demand-context';

export type DayDemandState =
  /** Nicht berechtigt / kein gültiges Datum — nichts anzeigen. */
  | { status: 'hidden' }
  | { status: 'loading' }
  /** Reservations-Tabellen nicht eingerichtet — Feature still ausblenden. */
  | { status: 'unavailable' }
  /** Ladefehler — sichtbarer Hinweis statt stiller 0. */
  | { status: 'error' }
  | { status: 'ready'; context: DayDemandContext };

/** Tabellen-Existenz einmalig pro App-Lauf prüfen (Panel + Card teilen sich das Ergebnis). */
let tablesExistPromise: Promise<boolean> | null = null;
function cachedTablesExist(): Promise<boolean> {
  if (!tablesExistPromise) {
    tablesExistPromise = checkReservationTablesExist().catch(() => {
      tablesExistPromise = null; // nächster Versuch darf erneut prüfen
      return false;
    });
  }
  return tablesExistPromise;
}

export function useDayDemandContext(dateStr: string | null | undefined): DayDemandState {
  const { isAdmin, isGuest } = usePermissions();
  const { tenantId } = useTenant();
  const [state, setState] = useState<DayDemandState>({ status: 'hidden' });

  const allowed = isAdmin && !isGuest;
  const loadFrom = dateStr ? demandContextLoadFrom(dateStr) : null;

  useEffect(() => {
    // Fetch-Effekt selbst gaten (feuert sonst vor einem Route-<Navigate>).
    if (!allowed || !dateStr || !loadFrom) {
      setState({ status: 'hidden' });
      return;
    }
    let alive = true;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const ok = await cachedTablesExist();
        if (!alive) return;
        if (!ok) { setState({ status: 'unavailable' }); return; }
        const detailRows = await fetchReservationsInRange(tenantId, loadFrom, dateStr);
        if (!alive) return;
        // PII sofort abstreifen — nur Datum/Personenzahl/Status behalten.
        const rows: DemandContextRow[] = detailRows.map((r) => ({
          date: r.date,
          partySize: r.partySize,
          status: r.status,
        }));
        const context = buildDayDemandContext({
          rows,
          targetDate: dateStr,
          today: format(new Date(), 'yyyy-MM-dd'),
        });
        setState(context ? { status: 'ready', context } : { status: 'hidden' });
      } catch (err) {
        console.error('[PERSONALBEDARF] Nachfrage-Kontext konnte nicht geladen werden:', err);
        if (alive) setState({ status: 'error' });
      }
    })();
    return () => { alive = false; };
  }, [allowed, tenantId, dateStr, loadFrom]);

  return state;
}
