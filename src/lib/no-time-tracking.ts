/**
 * no-time-tracking.ts
 * =====================
 * Mitarbeiter ohne Zeiterfassungspflicht («Keine Zeiterfassung erforderlich»,
 * Haken im Personalstamm).
 *
 * Persistenz: KV `no_time_tracking_v1` (MANDANTENGETRENNT via tenant-Präfix),
 * Wert = Record<employeeId, true>. Gepflegt ausschliesslich über den
 * Personalstamm-Haken (reversibel).
 *
 * Wirkung:
 *  - Mirus-Import: 0 Stunden werden als 100 % verifiziert akzeptiert
 *    (Legacy-Namensliste unten, MirusReview/MirusImportPreview).
 *  - Überstunden: MA mit Flag sind vom Überstundenkonto AUSGENOMMEN
 *    (alle Wochen/Monate/Laufend leer, zählen nicht ins Total; Badge in der UI).
 */

import { kvGet, kvGetStrict, kvSetStrict } from '@/lib/supabase-kv';
import type { TenantId } from '@/contexts/TenantContext';

const BASE_KEY = 'no_time_tracking_v1';

/** Tenant-Präfix-Konvention: Oliv = unpräfixiert, andere Mandanten `<id>:`. */
function keyFor(tenantId: TenantId): string {
  return tenantId === 'oliv' ? BASE_KEY : `${tenantId}:${BASE_KEY}`;
}

export type NoTimeTrackingMap = Record<string, true>;

/**
 * Lädt die Flag-Map des Mandanten. Fehler/leer → {} (Feature ist additiv:
 * ohne Map wird niemand ausgenommen — nie ein stiller Voll-Ausschluss).
 */
export async function ladeNoTimeTracking(tenantId: TenantId): Promise<NoTimeTrackingMap> {
  try {
    const raw = await kvGet(keyFor(tenantId));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: NoTimeTrackingMap = {};
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === true) out[id] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function parseMap(raw: unknown): NoTimeTrackingMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: NoTimeTrackingMap = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === true) out[id] = true;
  }
  return out;
}

/**
 * Setzt/entfernt das Flag eines Mitarbeiters.
 *
 * Schreibsicherheit (KV hat kein CAS):
 *  - STRIKTES Lesen der Merge-Basis (Lesefehler wirft — ein Ausfall darf NIE
 *    als «leere Map» interpretiert werden, sonst löscht der Save alle
 *    bestehenden Ausnahmen).
 *  - STRIKTES Schreiben (kvSetStrict wirft bei Schreibfehlern — der
 *    Personalstamm meldet den Fehler sichtbar).
 *  - Verify-Read danach: eigenes Flag muss den Zielzustand haben, sonst hat
 *    ein paralleler Save gewonnen → Fehler statt stiller Verlust.
 */
export async function setzeNoTimeTracking(
  tenantId: TenantId,
  employeeId: string,
  flag: boolean,
): Promise<NoTimeTrackingMap> {
  const key = keyFor(tenantId);
  const map = parseMap(await kvGetStrict(key)); // wirft bei Lesefehler
  if (flag) map[employeeId] = true;
  else delete map[employeeId];
  await kvSetStrict(key, map);
  const check = parseMap(await kvGetStrict(key));
  if ((check[employeeId] === true) !== flag) {
    throw new Error('no_time_tracking_v1: paralleler Schreibkonflikt — bitte erneut speichern');
  }
  return check;
}

/**
 * Legacy-Namensliste (nur Mirus-Import-Verifikation; TODO: durch die
 * KV-Map oben ersetzen, sobald der Import employeeIds durchreicht).
 */
export const NO_TIME_TRACKING_EMPLOYEES: string[] = [
  'Lokaj Mendim',
];

/**
 * Prüft ob ein Mitarbeiter keine Zeiterfassung benötigt (Legacy, Name-Match).
 * Nur exakter Name-Match (case-insensitive, trim) — keine Heuristik.
 */
export function isNoTimeTracking(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.trim().toLowerCase();
  return NO_TIME_TRACKING_EMPLOYEES.some(n => n.trim().toLowerCase() === lower);
}
