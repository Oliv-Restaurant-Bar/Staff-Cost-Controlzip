/**
 * useVj2025BeaulieuImport
 * =======================
 * Importiert die Vorjahres-Tagesumsätze 2025 für Beaulieu einmalig
 * in Supabase (vj_daily:beaulieu:YYYY-MM-DD Keys), wenn noch keine
 * 2025-Daten vorhanden sind.
 *
 * Nur aktiv wenn tenantId === 'beaulieu'.
 * Prüft vor dem Import ob Daten bereits vorhanden sind (countVjDailyYear).
 * Überschreibt KEINE bestehenden Daten falls bereits >= 200 Tage vorhanden.
 */

import { useEffect } from 'react';
import { VJ2025_DAILY_BEAULIEU } from '@/data/vj2025-daily-beaulieu';
import { upsertVjDailyBatch, countVjDailyYear } from '@/lib/vj-daily-supabase';
import type { VjDayRecord } from '@/lib/vj-daily-supabase';

const IMPORT_DONE_KEY = 'vj2025_beaulieu_imported_v1';
const TENANT_ID = 'beaulieu';
const VJ_YEAR = 2025;

export function useVj2025BeaulieuImport(tenantId?: string, onDone?: () => void) {
  useEffect(() => {
    // Nur für Beaulieu ausführen
    if (tenantId !== TENANT_ID) return;

    // Nur einmal pro Session (sessionStorage-Flag verhindert Wiederholung)
    if (sessionStorage.getItem(IMPORT_DONE_KEY)) return;

    (async () => {
      try {
        // Prüfen ob Daten bereits in Supabase vorhanden
        const existing = await countVjDailyYear(VJ_YEAR, TENANT_ID);
        if (existing >= 200) {
          console.log(`[VJ2025 BEAULIEU IMPORT] Bereits ${existing} Tage vorhanden – kein Import nötig`);
          sessionStorage.setItem(IMPORT_DONE_KEY, '1');
          return;
        }

        // Records aufbauen
        const records: VjDayRecord[] = Object.entries(VJ2025_DAILY_BEAULIEU).map(([date, revenue]) => ({
          date,
          year:          VJ_YEAR,
          actualRevenue: revenue,
          source:        'seed_2025',
        }));

        console.log(`[VJ2025 BEAULIEU IMPORT] Starte Seed: ${records.length} Tage → Supabase vj_daily:beaulieu:`);
        const { upserted, error } = await upsertVjDailyBatch(records, TENANT_ID);

        if (error) {
          console.warn('[VJ2025 BEAULIEU IMPORT] Fehler beim Seed:', error);
          return;
        }

        console.log(`[VJ2025 BEAULIEU IMPORT] ${upserted} Tage gespeichert`);
        sessionStorage.setItem(IMPORT_DONE_KEY, '1');

        // TagesansichtPage neu laden
        window.dispatchEvent(new Event('supabase-kv-synced'));
        onDone?.();
      } catch (err) {
        console.warn('[VJ2025 BEAULIEU IMPORT] Exception:', err);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);
}
