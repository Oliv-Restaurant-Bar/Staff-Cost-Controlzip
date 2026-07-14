/**
 * import-cockpit-checks-db.ts — Persistenz für manuell erledigte Kontrollen.
 * =========================================================================
 * Isolierte, mandantengetrennte Speicherung der manuellen „Erledigt"-Markierungen
 * (siehe import-cockpit-checks.ts). Nutzt bewusst die BESTEHENDE Settings-/
 * Preferences-Infrastruktur der App — KEINE neue Tabelle, KEINE Migration, KEIN SQL:
 *
 *   - localStorage (tenant-scoped) = schneller Primärspeicher → überlebt Reloads.
 *   - Supabase-KV `app_settings` (bestehende Tabelle) = persistentes Backup →
 *     überlebt Browser-/Gerätewechsel. Best-effort, wirft nie.
 *
 * Der KEY ist einzig für diese Funktion reserviert (nichts anderes liest/schreibt
 * ihn), daher ist ein einfacher Voll-Write ohne Merge sicher.
 *
 * Dieser Schreibpfad ist die EINZIGE Ausnahme vom sonst strikt read-only Cockpit
 * und betrifft ausschliesslich manuelle Kontroll-Markierungen — niemals echte
 * Import-/Umsatz-/CRM-/Mirus-/Budget-/Dienstplan-Daten.
 */

import type { TenantId } from '@/contexts/TenantContext';
import { kvGet, kvSet } from './supabase-kv';
import { tenantKey, tlsGetJson, tlsSetJson } from './tenant-utils';
import { MANUAL_CHECKS_KEY, type ManualCompletionMap } from './import-cockpit-checks';

function isMap(value: unknown): value is ManualCompletionMap {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Lädt die manuellen Erledigungen: zuerst localStorage (sofort), dann KV-Backup.
 * Ist im KV ein Stand vorhanden, gilt dieser als Wahrheit und wird lokal gespiegelt.
 * Fehler werden geschluckt — im Zweifel gilt der localStorage-Stand (oder leer).
 */
export async function loadManualChecks(tenantId: TenantId): Promise<ManualCompletionMap> {
  let local: ManualCompletionMap = {};
  try {
    local = tlsGetJson<ManualCompletionMap>(tenantId, MANUAL_CHECKS_KEY) ?? {};
  } catch {
    // Beschädigter/gesperrter localStorage → leerer Stand.
  }
  try {
    const remote = await kvGet(tenantKey(tenantId, MANUAL_CHECKS_KEY));
    if (isMap(remote)) {
      tlsSetJson(tenantId, MANUAL_CHECKS_KEY, remote);
      return remote;
    }
  } catch {
    // Backup nicht erreichbar → localStorage-Stand nutzen.
  }
  return local;
}

/**
 * Speichert die manuellen Erledigungen: localStorage sofort (durable über Reload),
 * KV best-effort als Backup. KV-Fehler brechen die Aktion NICHT ab.
 */
export async function saveManualChecks(tenantId: TenantId, map: ManualCompletionMap): Promise<void> {
  try {
    tlsSetJson(tenantId, MANUAL_CHECKS_KEY, map);
  } catch {
    // localStorage voll/gesperrt → KV-Backup bleibt einzige Persistenz.
  }
  try {
    await kvSet(tenantKey(tenantId, MANUAL_CHECKS_KEY), map);
  } catch {
    // Backup fehlgeschlagen — localStorage bleibt primärer, persistenter Speicher.
  }
}
