/**
 * useVj2025Import
 * ===============
 * Importiert die Vorjahres-Tagesumsätze 2025 (aus Gastronovi-Export)
 * einmalig in dailyBudgets, wenn noch keine 2025-Daten vorhanden sind.
 *
 * Wird in TagesansichtPage gemountet.
 * Setzt dailyBudgets[2025-XX-XX].actualRevenue für alle 365 Tage.
 * Überschreibt bestehende 2025-Einträge nur wenn sie 0 sind.
 * 2026-Einträge werden nicht angetastet.
 *
 * Tenant-Isolation: Diese Seed-Daten (VJ2025_DAILY) sind Oliv-spezifisch.
 * Der Hook läuft nur wenn tenantId === 'oliv'.
 */

import { useEffect } from 'react';
import { VJ2025_DAILY } from '@/data/vj2025-daily';

const IMPORT_DONE_KEY = 'vj2025_imported_v1';

function readDailyBudgets(storageKey = 'dailyBudgets'): Record<string, { actualRevenue?: number; takeawayRevenue?: number; previousYearRevenue?: number; plannedRevenue?: number }> {
  try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); }
  catch { return {}; }
}

export function useVj2025Import(tenantId?: string, onDone?: () => void) {
  useEffect(() => {
    // Nur für Oliv — VJ2025_DAILY enthält Oliv-spezifische Daten
    if (tenantId && tenantId !== 'oliv') return;

    // Nur einmal ausführen (sessionStorage-Flag verhindert Wiederholung)
    if (sessionStorage.getItem(IMPORT_DONE_KEY)) return;

    // Prüfen ob April-2025-Daten bereits vorhanden
    const existing = readDailyBudgets();
    const alreadyHas2025 = Object.keys(existing).filter(k => k.startsWith('2025-')).length >= 300;
    if (alreadyHas2025) {
      sessionStorage.setItem(IMPORT_DONE_KEY, '1');
      return;
    }

    // Import durchführen
    (async () => {
      try {
        const db = readDailyBudgets();
        let count = 0;
        for (const [iso, revenue] of Object.entries(VJ2025_DAILY)) {
          // Nur leere / fehlende Einträge befüllen; nicht manuell gesetzte überschreiben
          const cur = db[iso];
          if (!cur || (cur.actualRevenue ?? 0) === 0) {
            db[iso] = { ...(cur ?? {}), actualRevenue: revenue };
            count++;
          }
        }
        if (count === 0) { sessionStorage.setItem(IMPORT_DONE_KEY, '1'); return; }

        localStorage.setItem('dailyBudgets', JSON.stringify(db));
        console.log(`[VJ2025 IMPORT] ${count} Tage in dailyBudgets gesetzt (tenant: oliv)`);

        // Supabase-Sync (async, fire-and-forget)
        const { kvSet } = await import('@/lib/supabase-kv');
        await kvSet('dailyBudgets', db);
        console.log('[VJ2025 IMPORT] Supabase sync abgeschlossen');

        sessionStorage.setItem(IMPORT_DONE_KEY, '1');

        // Sync-Event auslösen damit TagesansichtPage sich neu rendert
        window.dispatchEvent(new Event('supabase-kv-synced'));
        onDone?.();
      } catch (err) {
        console.warn('[VJ2025 IMPORT] Fehler:', err);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);
}
