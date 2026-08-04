/**
 * tagesabschluss-db.ts — Persistenz für die Tagesabschluss-Übersicht.
 * ===================================================================
 * Speichert den Blob `tagesabschluss_v1` (manuelle Tageswerte, Barausgaben,
 * Korrektur-Overrides, Kommentare, Export-Einstellungen) über die BESTEHENDE
 * Settings-Infrastruktur — KEINE neue Tabelle, KEINE Migration, KEIN SQL:
 *
 *   - localStorage (tenant-scoped) = schneller Primärspeicher.
 *   - Supabase-KV `app_settings` = persistentes Backup (best-effort, wirft nie).
 *
 * WICHTIG (Finanzdaten): Der Save-Pfad ist KEIN naiver Blob-Write. Vor dem
 * Schreiben wird der KV-Stand erneut gelesen und per
 * `mergeTagesabschlussBlobs` (jüngster updatedAt je Schlüssel gewinnt)
 * zusammengeführt — ein Gerät mit veraltetem localStorage überschreibt so nie
 * die Eingaben eines anderen Geräts (safeUpsert-Prinzip).
 *
 * Tagesbestätigungen (Barbestand) leben bewusst NICHT hier, sondern im
 * Adyen-Blob `adyenAbstimmung_v1` (ein einziger Bestätigungs-Store).
 */

import type { TenantId } from '@/contexts/TenantContext';
import { kvGet, kvGetStrict, kvSetStrict, notifyKVBackupProblem } from './supabase-kv';
import { tenantKey, tlsGetJson, tlsSetJson } from './tenant-utils';
import {
  TAGESABSCHLUSS_KEY,
  normalizeTagesabschlussBlob,
  mergeTagesabschlussBlobs,
  type TagesabschlussBlob,
} from './tagesabschluss';

/**
 * Lädt den Blob: zuerst localStorage (sofort), dann KV-Backup. Ist im KV ein
 * Stand vorhanden, wird er mit dem lokalen Stand GEMERGT (nicht ersetzt) und
 * das Ergebnis lokal gespiegelt. Fehler werden geschluckt.
 */
export async function loadTagesabschluss(tenantId: TenantId): Promise<TagesabschlussBlob> {
  let local: TagesabschlussBlob = normalizeTagesabschlussBlob(null);
  try {
    local = normalizeTagesabschlussBlob(tlsGetJson<unknown>(tenantId, TAGESABSCHLUSS_KEY));
  } catch {
    // Beschädigter/gesperrter localStorage → leerer Stand.
  }
  try {
    const remote = await kvGet(tenantKey(tenantId, TAGESABSCHLUSS_KEY));
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      const merged = mergeTagesabschlussBlobs(local, normalizeTagesabschlussBlob(remote));
      tlsSetJson(tenantId, TAGESABSCHLUSS_KEY, merged);
      return merged;
    }
  } catch {
    // Backup nicht erreichbar → localStorage-Stand nutzen.
  }
  return local;
}

/**
 * Synchroner localStorage-Stand (Primärspeicher) — für Sperr-Prüfungen zur
 * Mutationszeit in anderen Sections (z. B. Adyen-Abgleich: keine Overrides
 * für definitiv abgeschlossene Tage). Wirft nie.
 */
export function loadTagesabschlussLocal(tenantId: TenantId): TagesabschlussBlob {
  try {
    return normalizeTagesabschlussBlob(tlsGetJson<unknown>(tenantId, TAGESABSCHLUSS_KEY));
  } catch {
    return normalizeTagesabschlussBlob(null);
  }
}

/**
 * Speichert den Blob: KV-Stand STRIKT erneut lesen → mergen → localStorage
 * sofort, dann KV-Write.
 *
 * kvGetStrict statt kvGet: Ein transienter LESEFEHLER (Netz-Blip) ist NICHT
 * dasselbe wie «Remote ist leer». Bei einem Lesefehler wird der KV-Write
 * ÜBERSPRUNGEN (sonst würde der rein lokale Stand Eingaben anderer Geräte
 * komplett ersetzen) und ein sichtbarer Fehler mit «Erneut versuchen»
 * gemeldet — gleiches Muster wie safeUpsertDailyBudgets/Import-Einstellungen.
 * Nur ein BESTÄTIGT leerer Remote-Stand darf normal geschrieben werden.
 */
export async function saveTagesabschluss(tenantId: TenantId, blob: TagesabschlussBlob): Promise<TagesabschlussBlob> {
  const key = tenantKey(tenantId, TAGESABSCHLUSS_KEY);
  let toWrite = blob;
  let remoteReadFailed: unknown = null;
  try {
    const remote = await kvGetStrict(key);
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      toWrite = mergeTagesabschlussBlobs(blob, normalizeTagesabschlussBlob(remote));
    }
    // remote === null ⇒ bestätigt leer → blob darf unverändert geschrieben werden.
  } catch (err) {
    remoteReadFailed = err;
  }
  try {
    tlsSetJson(tenantId, TAGESABSCHLUSS_KEY, toWrite);
  } catch {
    // localStorage voll/gesperrt → KV-Backup bleibt einzige Persistenz.
  }
  if (remoteReadFailed !== null) {
    // KEIN KV-Write mit unklarem Remote-Zustand — sichtbar melden statt
    // Tagesabschlüsse/Korrekturen anderer Geräte zu überschreiben.
    void notifyKVBackupProblem(remoteReadFailed, 'Tagesabschluss', {
      toastId: 'tagesabschluss-backup',
      retry: async () => { await saveTagesabschluss(tenantId, toWrite); },
    });
    return toWrite;
  }
  try {
    await kvSetStrict(key, toWrite);
  } catch (err) {
    void notifyKVBackupProblem(err, 'Tagesabschluss', {
      toastId: 'tagesabschluss-backup',
      retry: async () => { await saveTagesabschluss(tenantId, toWrite); },
    });
  }
  return toWrite;
}
