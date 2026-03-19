/**
 * useSyncStore – bidirektionale Supabase ↔ localStorage Synchronisation
 * =======================================================================
 * Wird einmalig aufgerufen, sobald der Benutzer eingeloggt ist.
 *
 * Ablauf:
 * 1. Lokale Daten → Supabase (falls localStorage Daten hat die Supabase nicht kennt)
 * 2. Supabase → localStorage (falls localStorage leer ist und Supabase Daten hat)
 *
 * So bleiben Daten persistent:
 * - Zwischen Dev-Preview und veröffentlichter App
 * - Nach Logout und erneutem Login
 * - In verschiedenen Browsern / Geräten
 */

import { useEffect, useRef } from 'react';
import { syncLocalToSupabase, syncSupabaseToLocal } from '@/lib/supabase-kv';

const SYNC_KEYS = [
  'reporting_v1', 'budget_v1', 'dailyBudgets', 'dailyRevenueOverrides',
  'account_mappings_v1', 'shift-config',
];

export function useSyncStore(authenticated: boolean) {
  const synced = useRef(false);

  useEffect(() => {
    if (!authenticated || synced.current) return;
    synced.current = true;

    (async () => {
      try {
        // 1. Lokale Daten zu Supabase hochladen (Erstbefüllung / Backup)
        await syncLocalToSupabase(SYNC_KEYS);

        // 2. Supabase-Daten lokal laden wenn localStorage leer ist
        const changed = await syncSupabaseToLocal(SYNC_KEYS);
        if (changed) {
          window.dispatchEvent(new CustomEvent('store-synced'));
        }
      } catch {
        // Supabase nicht erreichbar – localStorage-Daten bleiben bestehen
      }
    })();
  }, [authenticated]);
}
