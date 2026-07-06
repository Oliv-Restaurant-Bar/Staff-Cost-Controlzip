/**
 * adyen-abstimmung-db.ts — Persistenz für den Adyen-Tages-Abgleich.
 * =================================================================
 * Speichert den Blob `adyenAbstimmung_v1` (importierte Adyen-Tagessummen,
 * Overrides, Kommentare, Tagesbestätigungen) über die BESTEHENDE
 * Settings-Infrastruktur — KEINE neue Tabelle, KEINE Migration, KEIN SQL:
 *
 *   - localStorage (tenant-scoped) = schneller Primärspeicher.
 *   - Supabase-KV `app_settings` = persistentes Backup (best-effort, wirft nie).
 *
 * WICHTIG: Schreibfluss ist immer load → reine Mutation (adyen-abstimmung.ts:
 * mergeAdyenImport/setOverride/setComment/setDayConfirmation) → save.
 * mergeAdyenImport ersetzt nur importierte Tage und erhält Overrides/
 * Kommentare/Bestätigungen — nie naiv einen fremden Stand überschreiben.
 *
 * Das Cockpit-Signal liest den Blob DIREKT aus localStorage (read-only,
 * import-cockpit-db.ts) — nie über diese Save-Schicht.
 */

import type { TenantId } from '@/contexts/TenantContext';
import { kvGet, kvSet } from './supabase-kv';
import { tenantKey, tlsGetJson, tlsSetJson } from './tenant-utils';
import {
  ADYEN_ABSTIMMUNG_KEY,
  normalizeAdyenBlob,
  type AdyenAbstimmungBlob,
} from './adyen-abstimmung';

/**
 * Lädt den Abgleichs-Blob: zuerst localStorage (sofort), dann KV-Backup.
 * Ist im KV ein Stand vorhanden, gilt dieser als Wahrheit und wird lokal
 * gespiegelt. Fehler werden geschluckt — im Zweifel localStorage-Stand.
 */
export async function loadAdyenAbstimmung(tenantId: TenantId): Promise<AdyenAbstimmungBlob> {
  let local: AdyenAbstimmungBlob = normalizeAdyenBlob(null);
  try {
    local = normalizeAdyenBlob(tlsGetJson<unknown>(tenantId, ADYEN_ABSTIMMUNG_KEY));
  } catch {
    // Beschädigter/gesperrter localStorage → leerer Stand.
  }
  try {
    const remote = await kvGet(tenantKey(tenantId, ADYEN_ABSTIMMUNG_KEY));
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      const normalized = normalizeAdyenBlob(remote);
      tlsSetJson(tenantId, ADYEN_ABSTIMMUNG_KEY, normalized);
      return normalized;
    }
  } catch {
    // Backup nicht erreichbar → localStorage-Stand nutzen.
  }
  return local;
}

/**
 * Speichert den Blob: localStorage sofort (durable über Reload), KV best-effort
 * als Backup. KV-Fehler brechen die Aktion NICHT ab.
 */
export async function saveAdyenAbstimmung(tenantId: TenantId, blob: AdyenAbstimmungBlob): Promise<void> {
  try {
    tlsSetJson(tenantId, ADYEN_ABSTIMMUNG_KEY, blob);
  } catch {
    // localStorage voll/gesperrt → KV-Backup bleibt einzige Persistenz.
  }
  try {
    await kvSet(tenantKey(tenantId, ADYEN_ABSTIMMUNG_KEY), blob);
  } catch {
    // Backup fehlgeschlagen — localStorage bleibt primärer Speicher.
  }
}
