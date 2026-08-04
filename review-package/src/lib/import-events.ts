/**
 * Leichtgewichtiges UI-Event: signalisiert, dass sich Reporting-/Importdaten
 * geändert haben (z. B. Jahres-Kostenimport gespeichert/gelöscht oder
 * VJ-Tagesumsatz-Übernahme abgeschlossen). Read-only-Aggregatoren wie die
 * Jahres-Datenstand-Karte hören darauf und laden ihre Anzeige neu.
 *
 * Bewusst NUR ein Anzeige-Refresh-Signal — keine Daten im Event, keine
 * Persistenz, keine Fachlogik.
 */
export const REPORTING_DATA_CHANGED_EVENT = 'reporting-data-changed';

export function notifyReportingDataChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(REPORTING_DATA_CHANGED_EVENT));
}
