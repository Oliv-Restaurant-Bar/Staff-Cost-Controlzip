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
import { kvGet, kvSet } from './supabase-kv';
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
 * Speichert den Blob: KV-Stand erneut lesen → mergen → localStorage sofort,
 * KV best-effort. KV-Fehler brechen die Aktion NICHT ab.
 */
export async function saveTagesabschluss(tenantId: TenantId, blob: TagesabschlussBlob): Promise<TagesabschlussBlob> {
  let toWrite = blob;
  try {
    const remote = await kvGet(tenantKey(tenantId, TAGESABSCHLUSS_KEY));
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      toWrite = mergeTagesabschlussBlobs(blob, normalizeTagesabschlussBlob(remote));
    }
  } catch {
    // KV nicht lesbar → lokalen Stand schreiben (Backup bleibt best-effort).
  }
  try {
    tlsSetJson(tenantId, TAGESABSCHLUSS_KEY, toWrite);
  } catch {
    // localStorage voll/gesperrt → KV-Backup bleibt einzige Persistenz.
  }
  try {
    await kvSet(tenantKey(tenantId, TAGESABSCHLUSS_KEY), toWrite);
  } catch {
    // Backup fehlgeschlagen — localStorage bleibt primärer Speicher.
  }
  return toWrite;
}
