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
import { kvGet, kvGetStrict, kvSetStrict, notifyKVBackupProblem } from './supabase-kv';
import { tenantKey, tlsGetJson, tlsSetJson } from './tenant-utils';
import {
  ADYEN_ABSTIMMUNG_KEY,
  normalizeAdyenBlob,
  mergeAdyenBlobs,
  type AdyenAbstimmungBlob,
} from './adyen-abstimmung';

/**
 * Wird nach JEDEM erfolgreichen localStorage-Write gefeuert, damit mehrere
 * Sections auf derselben Seite (Adyen-Abgleich + Tagesabschluss-Übersicht)
 * ihren Blob-Stand nachziehen können — sonst überschreibt die eine Section
 * mit ihrem Mount-Zeit-Stand die Änderungen der anderen (Datenverlust).
 */
export const ADYEN_ABSTIMMUNG_UPDATED_EVENT = 'adyenAbstimmungUpdated';

/**
 * Synchroner Frisch-Stand aus dem localStorage-Primärspeicher.
 * Für Mutationen IMMER dieses Muster verwenden:
 *   loadAdyenAbstimmungLocal → reine Mutation → saveAdyenAbstimmung
 * — nie einen im React-State gehaltenen (potenziell veralteten) Blob mutieren
 * und zurückschreiben.
 */
export function loadAdyenAbstimmungLocal(tenantId: TenantId): AdyenAbstimmungBlob {
  try {
    return normalizeAdyenBlob(tlsGetJson<unknown>(tenantId, ADYEN_ABSTIMMUNG_KEY));
  } catch {
    return normalizeAdyenBlob(null);
  }
}

/**
 * Lädt den Abgleichs-Blob: zuerst localStorage (sofort), dann KV-Backup.
 * Ist im KV ein Stand vorhanden, wird er mit dem lokalen Stand GEMERGT
 * (jüngster Stand je Key gewinnt — nicht ersetzt) und das Ergebnis lokal
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
      const merged = mergeAdyenBlobs(local, normalizeAdyenBlob(remote));
      tlsSetJson(tenantId, ADYEN_ABSTIMMUNG_KEY, merged);
      return merged;
    }
  } catch {
    // Backup nicht erreichbar → localStorage-Stand nutzen.
  }
  return local;
}

/**
 * Speichert den Blob: KV-Stand STRIKT erneut lesen → mergen (jüngster Stand
 * je Key gewinnt) → localStorage sofort, dann KV-Write.
 *
 * kvGetStrict statt kvGet: Ein transienter LESEFEHLER (Netz-Blip) ist NICHT
 * dasselbe wie «Remote ist leer». Bei einem Lesefehler wird der KV-Write
 * ÜBERSPRUNGEN (sonst würde der rein lokale Stand Overrides/Bestätigungen
 * anderer Geräte komplett ersetzen) und ein sichtbarer Fehler mit «Erneut
 * versuchen» gemeldet — gleiches Muster wie saveTagesabschluss. Der Retry
 * bindet den toWrite-SNAPSHOT (nie erneut localStorage lesen — der könnte
 * inzwischen anders sein). Nur ein BESTÄTIGT leerer Remote-Stand darf
 * unverändert geschrieben werden.
 */
export async function saveAdyenAbstimmung(tenantId: TenantId, blob: AdyenAbstimmungBlob): Promise<AdyenAbstimmungBlob> {
  const key = tenantKey(tenantId, ADYEN_ABSTIMMUNG_KEY);
  let toWrite = blob;
  let remoteReadFailed: unknown = null;
  try {
    const remote = await kvGetStrict(key);
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      toWrite = mergeAdyenBlobs(blob, normalizeAdyenBlob(remote));
    }
    // remote === null ⇒ bestätigt leer → blob darf unverändert geschrieben werden.
  } catch (err) {
    remoteReadFailed = err;
  }
  try {
    tlsSetJson(tenantId, ADYEN_ABSTIMMUNG_KEY, toWrite);
  } catch {
    // localStorage voll/gesperrt → KV-Backup bleibt einzige Persistenz.
  }
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(ADYEN_ABSTIMMUNG_UPDATED_EVENT));
    }
  } catch {
    // Event-Dispatch darf das Speichern nie brechen.
  }
  if (remoteReadFailed !== null) {
    // KEIN KV-Write mit unklarem Remote-Zustand — sichtbar melden statt
    // Overrides/Bestätigungen anderer Geräte zu überschreiben.
    void notifyKVBackupProblem(remoteReadFailed, 'Adyen-Abstimmung', {
      toastId: 'adyen-abstimmung-backup',
      retry: async () => { await saveAdyenAbstimmung(tenantId, toWrite); },
    });
    return toWrite;
  }
  try {
    await kvSetStrict(key, toWrite);
  } catch (err) {
    void notifyKVBackupProblem(err, 'Adyen-Abstimmung', {
      toastId: 'adyen-abstimmung-backup',
      retry: async () => { await saveAdyenAbstimmung(tenantId, toWrite); },
    });
  }
  return toWrite;
}
