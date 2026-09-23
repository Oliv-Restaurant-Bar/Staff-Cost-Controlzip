/**
 * useSyncStore – bidirektionale Supabase ↔ localStorage Synchronisation
 * =======================================================================
 * Mandantenfähig: synct für den aktiven Mandanten (Oliv / Beaulieu).
 *
 * Ablauf (bei jedem Mandantenwechsel):
 * 1. Supabase → localStorage (Master-Stand zuerst holen — Issue #5: die
 *    Datenbank ist die Quelle der Wahrheit, das Gerät wird zuerst auf
 *    diesen Stand gebracht)
 * 2. Lokale Daten → Supabase (Backup / Erstbefüllung — verliert nichts, da
 *    dieser Schritt für die gemergten Keys mergt bzw. nur bei leerem
 *    Remote-Stand hochlädt)
 *
 * Der Sync läuft bei JEDEM Mandantenwechsel — auch wenn der Mandant
 * zuvor schon einmal aktiv war. So sind die Zahlen immer aktuell.
 *
 * Debug-Logs: [TENANT]
 */

import { useEffect, useRef } from 'react';
import { syncLocalToSupabase, syncSupabaseToLocal } from '@/lib/supabase-kv';
import { useTenant } from '@/contexts/TenantContext';
import type { TenantId } from '@/contexts/TenantContext';

const SYNC_KEYS = [
  'reporting_v1', 'budget_v1', 'dailyBudgets', 'dailyRevenueOverrides',
  'account_mappings_v1', 'shift-config',
];

export function useSyncStore(authenticated: boolean) {
  const { tenantId } = useTenant();

  // Welcher Tenant wurde zuletzt synchronisiert?
  // (nicht Set — damit bei jedem Tenant-Wechsel neu gesyncт wird)
  const lastSyncedTenant = useRef<TenantId | null>(null);

  useEffect(() => {
    if (!authenticated) return;

    // Bereits für diesen Tenant gesyncт — kein doppelter Sync beim gleichen Tenant
    if (lastSyncedTenant.current === tenantId) return;

    lastSyncedTenant.current = tenantId;
    console.log(`[TENANT] useSyncStore: starte Sync für Mandant "${tenantId}"`);

    (async () => {
      try {
        // Pull before push (Issue #5): bring the device up to the
        // authoritative remote state first, then push local-only data.
        // syncLocalToSupabase already merges (reporting_v1/dailyBudgets) or
        // only uploads when remote is empty for a key, so pushing second
        // never re-loses anything the pull just brought down.
        const changed = await syncSupabaseToLocal(SYNC_KEYS, tenantId);
        await syncLocalToSupabase(SYNC_KEYS, tenantId);
        console.log(`[TENANT] useSyncStore: Sync abgeschlossen für "${tenantId}" (changed=${changed})`);

        // Immer Event auslösen damit alle Komponenten aktualisieren
        window.dispatchEvent(new CustomEvent('store-synced'));
      } catch {
        // Supabase nicht erreichbar – localStorage-Daten bleiben bestehen
        console.warn(`[TENANT] useSyncStore: Sync fehlgeschlagen für "${tenantId}" – localStorage bleibt aktiv`);
        // Trotzdem Event auslösen damit UI sich neu initialisiert
        window.dispatchEvent(new CustomEvent('store-synced'));
      }
    })();
  // Re-run bei jedem Tenant-Wechsel
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, tenantId]);
}
