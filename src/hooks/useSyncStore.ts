/**
 * useSyncStore – bidirektionale Supabase ↔ localStorage Synchronisation
 * =======================================================================
 * Mandantenfähig: synct für den aktiven Mandanten (Oliv / Beaulieu).
 *
 * Ablauf (pro Mandant, einmalig nach Login und bei Mandantenwechsel):
 * 1. Lokale Daten → Supabase (Backup / Erstbefüllung)
 * 2. Supabase → localStorage (Master-Stand in den lokalen Speicher)
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

  // Welche Mandanten wurden bereits synchronisiert?
  const syncedTenants = useRef<Set<TenantId>>(new Set());

  useEffect(() => {
    if (!authenticated) return;
    if (syncedTenants.current.has(tenantId)) return;

    syncedTenants.current.add(tenantId);
    console.log(`[TENANT] useSyncStore: starte Sync für Mandant "${tenantId}"`);

    (async () => {
      try {
        await syncLocalToSupabase(SYNC_KEYS, tenantId);

        const changed = await syncSupabaseToLocal(SYNC_KEYS, tenantId);
        if (changed) {
          console.log(`[TENANT] useSyncStore: Sync abgeschlossen für "${tenantId}" – store-synced Event`);
          window.dispatchEvent(new CustomEvent('store-synced'));
        }
      } catch {
        // Supabase nicht erreichbar – localStorage-Daten bleiben bestehen
      }
    })();
  // Re-run wenn authenticated status oder tenantId sich ändert
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, tenantId]);
}
