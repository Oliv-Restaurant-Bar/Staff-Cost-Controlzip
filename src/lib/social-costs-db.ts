/**
 * social-costs-db.ts — Persistenz für die zentralen AG-Sozialkostensätze.
 * =======================================================================
 * Speichert das Blob `socialCostRates_v1` über die BESTEHENDE Settings-
 * Infrastruktur — KEINE neue Tabelle, KEINE Migration, KEIN SQL:
 *
 *   - localStorage (tenant-scoped) = schneller Primärspeicher.
 *   - Supabase-KV `app_settings` = persistentes Backup (best-effort, wirft nie).
 *
 * Muster identisch zu adyen-abstimmung-db.ts. Schreibfluss immer:
 *   loadSocialCostRatesLocal → reine Mutation → saveSocialCostRates.
 */

import type { TenantId } from '@/contexts/TenantContext';
import { kvGet, notifyKVBackupProblem } from './supabase-kv';
import { tenantKey, tlsGetJson, tlsSetJson } from './tenant-utils';
import {
  SOCIAL_COST_RATES_KEY,
  normalizeSocialCostRatesBlob,
  migrateLegacyDefaultRates,
  type SocialCostRatesBlob,
  type SocialCostRates,
} from './social-costs';

/**
 * Wendet die einmalige Default-Migration (14.2 % → 15.7 %) auf ein Blob an.
 * Nur exakte Alt-Defaults werden gehoben; bewusste User-Werte bleiben intakt.
 */
function withRatesMigration(blob: SocialCostRatesBlob): SocialCostRatesBlob {
  const migrated = migrateLegacyDefaultRates(blob.rates);
  return migrated === blob.rates ? blob : { ...blob, rates: migrated };
}

/**
 * Wird nach jedem erfolgreichen Save gefeuert, damit offene Seiten
 * (Dienstplan, Personalstamm, Kennzahlen) die neuen Sätze nachziehen.
 */
export const SOCIAL_COST_RATES_UPDATED_EVENT = 'socialCostRatesUpdated';

/** Synchroner Frisch-Stand aus dem localStorage-Primärspeicher. */
export function loadSocialCostRatesLocal(tenantId: TenantId): SocialCostRatesBlob {
  try {
    return withRatesMigration(normalizeSocialCostRatesBlob(tlsGetJson<unknown>(tenantId, SOCIAL_COST_RATES_KEY)));
  } catch {
    return normalizeSocialCostRatesBlob(null);
  }
}

/**
 * Lädt das Sätze-Blob: zuerst localStorage (sofort), dann KV-Backup.
 * Ist im KV ein Stand vorhanden, gilt dieser als Wahrheit und wird lokal
 * gespiegelt. Fehler werden geschluckt — im Zweifel localStorage-Stand
 * (bzw. die CH-Default-Richtwerte).
 */
export async function loadSocialCostRates(tenantId: TenantId): Promise<SocialCostRatesBlob> {
  let local = normalizeSocialCostRatesBlob(null);
  try {
    local = withRatesMigration(normalizeSocialCostRatesBlob(tlsGetJson<unknown>(tenantId, SOCIAL_COST_RATES_KEY)));
  } catch {
    // Beschädigter/gesperrter localStorage → Defaults.
  }
  try {
    const remote = await kvGet(tenantKey(tenantId, SOCIAL_COST_RATES_KEY));
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      const normalized = withRatesMigration(normalizeSocialCostRatesBlob(remote));
      tlsSetJson(tenantId, SOCIAL_COST_RATES_KEY, normalized);
      return normalized;
    }
  } catch {
    // Backup nicht erreichbar → localStorage-Stand nutzen.
  }
  return local;
}

/**
 * Speichert neue Sätze: localStorage sofort, KV best-effort als Backup.
 * KV-Fehler brechen die Aktion NICHT ab.
 */
export async function saveSocialCostRates(tenantId: TenantId, rates: SocialCostRates): Promise<SocialCostRatesBlob> {
  const prev = loadSocialCostRatesLocal(tenantId);
  const blob: SocialCostRatesBlob = normalizeSocialCostRatesBlob({
    ...prev,
    rates,
    updatedAt: new Date().toISOString(),
  });
  try {
    tlsSetJson(tenantId, SOCIAL_COST_RATES_KEY, blob);
  } catch {
    // localStorage voll/gesperrt → KV-Backup bleibt einzige Persistenz.
  }
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(SOCIAL_COST_RATES_UPDATED_EVENT));
    }
  } catch {
    // Event-Dispatch darf das Speichern nie brechen.
  }
  // Issue #5: plain `kvSet` never throws (swallows errors internally), so
  // the previous try/catch around it never actually ran — a failed backup
  // was completely invisible. Switched to `kvSetStrict` so failures surface
  // via the same toast+retry used elsewhere in the app.
  try {
    const { kvSetStrict } = await import('./supabase-kv');
    await kvSetStrict(tenantKey(tenantId, SOCIAL_COST_RATES_KEY), blob);
  } catch (err) {
    void notifyKVBackupProblem(err, 'Sozialabgaben-Sätze', {
      toastId: 'social-cost-rates-backup',
      retry: () => saveSocialCostRates(tenantId, rates).then(() => undefined),
    });
  }
  return blob;
}
