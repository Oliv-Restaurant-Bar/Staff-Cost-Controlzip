/**
 * no-time-tracking.ts
 * =====================
 * Konfiguration für Mitarbeiter ohne Zeiterfassungspflicht.
 *
 * TODO: Nach Aktivierung der Spalte `no_time_tracking_required` in Supabase
 *       diese Mock-Liste durch einen echten Supabase-Lookup ersetzen.
 *       Bis dahin: Admin pflegt diese Liste manuell.
 *       Keine automatische Erkennung anhand Name-Heuristik, Rolle oder Kostenstelle.
 *
 * TODO (Schritt 2): Wenn `no_time_tracking_required` in Personalstamm/Supabase
 *       aktiviert ist, stattdessen `loadEmployees()` aufrufen und das Feld direkt
 *       aus der DB lesen. Diese Datei kann dann gelöscht werden.
 */

/**
 * Manuelle Liste — durch Admin im Personalstamm konfiguriert.
 * TODO: Aus Supabase lesen wenn `no_time_tracking_required`-Spalte live ist.
 */
export const NO_TIME_TRACKING_EMPLOYEES: string[] = [
  'Lokaj Mendim',
];

/**
 * Prüft ob ein Mitarbeiter keine Zeiterfassung benötigt.
 * Nur exakter Name-Match (case-insensitive, trim) — keine Heuristik.
 */
export function isNoTimeTracking(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.trim().toLowerCase();
  return NO_TIME_TRACKING_EMPLOYEES.some(n => n.trim().toLowerCase() === lower);
}
