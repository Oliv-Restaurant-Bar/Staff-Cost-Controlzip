/**
 * Foratable Report — Zukunfts-Datenzugriff (read-only)
 * ====================================================
 * Lädt die Rohzeilen für die Zukunftsübersicht + Kalender über EXAKT dieselbe
 * CRM-Ladefunktion (`fetchFutureReservations`) wie die CRM-Auswertung, damit die
 * Werte identisch sind (roher `status_normalized`, KEIN erneutes Kollabieren via
 * `normStatus` wie im Report-Loader — dort würden seated/arrived → unknown).
 *
 * Deckt IMMER [today, max(to, today+29)] ab, damit sowohl der (auf die Zukunft
 * geklammerte) Auswahlbereich als auch die absoluten 7/14/30-Tage-Kacheln
 * vollständig sind.  Mandantengefiltert (in `fetchFutureReservations`), wirft bei
 * Lesefehler.  Verändert nichts an Import-/CRM-Logik, keine Migration.
 */

import { fetchFutureReservations } from './reservation-crm-db';
import { addIsoDays, type ReservationDetailRow } from './reservation-dashboard';

/**
 * Zukunfts-Rohzeilen (mit PII-Feldern — im Report werden nur Aggregate gezeigt)
 * ab heute bis zur spätesten benötigten Grenze (max(to, heute+29)).
 */
export async function loadFutureReservationRows(
  restaurantId: string,
  today: string,
  to: string,
): Promise<ReservationDetailRow[]> {
  const t = today.slice(0, 10);
  const plus29 = addIsoDays(t, 29);
  const upper = to > plus29 ? to.slice(0, 10) : plus29;
  return fetchFutureReservations(restaurantId, t, upper);
}
