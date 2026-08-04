/**
 * Reservationen — zentrale Cockpit-Einstellungen (Zählregel + Gruppen-Schwelle)
 * =============================================================================
 * EINE zentrale Stelle, die festlegt, welche Reservationen in die Cockpit-
 * Kennzahlen «Reservierte Gäste» und «Gruppen ab N Pax» einfliessen:
 *
 *  1) Zähl-Status: welche (normalisierten) Status als gültige Reservation zählen.
 *     Default = Abgeschlossen (completed) + Bestätigt (confirmed).
 *     Ausgeschlossen (Default) = Storniert (cancelled), No-show (noshow),
 *     Abgelehnt (→ cancelled) und «Nicht beantwortet» (→ pending).
 *
 *  2) Gruppen-Schwelle: ab wie vielen Personen eine Reservation als «grosse
 *     Gruppe» zählt (>= Schwelle, die Schwelle selbst zählt mit). Default 20.
 *
 * Persistenz pro Tenant über app_settings (loadSetting/saveSetting +
 * tenantKey). Fehlertolerant: bei Lese-/Parse-Fehlern gelten die Defaults; ein
 * Lesefehler überschreibt nichts.
 *
 * Rein von DB entkoppelt bis auf die dünnen load/save-Wrapper — die Auswert-
 * Logik (`statusCounts`) ist eine reine Funktion und ohne Datenbank testbar.
 */

import { loadSetting, saveSetting } from '@/lib/supabase-db';
import type { ReservationStatusNormalized } from '@/lib/reservation-import-parser';

// ── Persistenz-Keys (pro Tenant via tenantKey) ───────────────────────────────

/** app_settings-Key (roh, vor tenantKey) der Reservations-Zählregel. */
export const RESERVATION_COUNTING_KEY = 'reservation_counting_v1';

// ── Typen ─────────────────────────────────────────────────────────────────────

/** Normalisierte Status, die überhaupt konfigurierbar sind (stabile Slugs). */
export const COUNTABLE_STATUS_KEYS: ReservationStatusNormalized[] = [
  'completed', 'confirmed', 'cancelled', 'noshow', 'pending', 'unknown',
];

/** Deutsche Labels der Status (für die Einstellungs-UI). */
export const STATUS_LABELS: Record<ReservationStatusNormalized, string> = {
  completed: 'Abgeschlossen',
  confirmed: 'Bestätigt',
  cancelled: 'Storniert / Abgelehnt',
  noshow: 'No-show',
  pending: 'Nicht beantwortet / Offen',
  unknown: 'Unbekannt',
};

/** Zentrale Reservations-Zählregel (persistiert). */
export interface ReservationCountingSettings {
  /** Normalisierte Status, die als gültige Reservation ZÄHLEN. */
  countedStatuses: ReservationStatusNormalized[];
  /** Gruppen-Schwelle in Personen (>=, die Schwelle zählt mit). */
  groupThreshold: number;
  /** ISO-Zeitstempel der letzten Änderung (Diagnose). */
  updatedAt?: string;
}

/** Default: zählen = Abgeschlossen + Bestätigt; Schwelle 20. */
export const DEFAULT_RESERVATION_COUNTING: ReservationCountingSettings = {
  countedStatuses: ['completed', 'confirmed'],
  groupThreshold: 20,
};

// ── Reine Auswert-Logik ────────────────────────────────────────────────────────

/**
 * Entscheidet, ob ein (normalisierter) Status gemäss Einstellung ZÄHLT.
 * Rein & testbar.
 */
export function statusCounts(
  status: ReservationStatusNormalized,
  settings: ReservationCountingSettings,
): boolean {
  return settings.countedStatuses.includes(status);
}

/**
 * Normalisiert/repariert ein geladenes Setting auf einen gültigen Zustand:
 *  - fehlende/leere countedStatuses → Default (nie «alles ausgeschlossen» durch Defekt)
 *  - unbekannte Status-Slugs verworfen, Duplikate entfernt
 *  - Schwelle: ganze Zahl >= 1, sonst Default
 * Rein & testbar.
 */
export function normalizeCountingSettings(
  raw: Partial<ReservationCountingSettings> | null | undefined,
): ReservationCountingSettings {
  const valid = new Set<ReservationStatusNormalized>(COUNTABLE_STATUS_KEYS);
  const rawList = Array.isArray(raw?.countedStatuses) ? raw!.countedStatuses : [];
  const counted = [...new Set(rawList.filter((s): s is ReservationStatusNormalized => valid.has(s as ReservationStatusNormalized)))];
  const countedStatuses = counted.length > 0 ? counted : [...DEFAULT_RESERVATION_COUNTING.countedStatuses];

  const t = Number(raw?.groupThreshold);
  const groupThreshold = Number.isFinite(t) && t >= 1 ? Math.floor(t) : DEFAULT_RESERVATION_COUNTING.groupThreshold;

  return { countedStatuses, groupThreshold, updatedAt: raw?.updatedAt };
}

// ── Persistenz (fehlertolerant) ─────────────────────────────────────────────────

/**
 * Lädt die Zählregel des Tenants. Bei Fehler/leer → Defaults (nie Datenverlust).
 * @param tenantKey aus useTenant() (oliv = key, sonst `tenant:key`).
 */
export async function loadReservationCounting(
  tenantKey: (key: string) => string,
): Promise<ReservationCountingSettings> {
  const raw = await loadSetting<Partial<ReservationCountingSettings>>(tenantKey(RESERVATION_COUNTING_KEY));
  return normalizeCountingSettings(raw);
}

/** Speichert die Zählregel des Tenants (normalisiert + updatedAt). */
export async function saveReservationCounting(
  tenantKey: (key: string) => string,
  settings: ReservationCountingSettings,
  nowIso: string,
): Promise<void> {
  const norm = normalizeCountingSettings(settings);
  await saveSetting<ReservationCountingSettings>(tenantKey(RESERVATION_COUNTING_KEY), {
    ...norm,
    updatedAt: nowIso,
  });
}
