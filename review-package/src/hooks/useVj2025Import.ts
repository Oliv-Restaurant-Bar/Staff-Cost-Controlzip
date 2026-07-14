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
 *
 * Lock-Schutz: Wenn prior_year_locked:oliv:2025 gesperrt ist,
 * wird kein Seed durchgeführt.
 */

import { useEffect } from 'react';
import { VJ2025_DAILY } from '@/data/vj2025-daily';
import { isLocked } from '@/lib/prior-year-lock';

const IMPORT_DONE_KEY = 'vj2025_imported_v1';
const TENANT_ID = 'oliv';
const VJ_YEAR = 2025;

function readDailyBudgets(storageKey = 'dailyBudgets'): Record<string, { actualRevenue?: number; takeawayRevenue?: number; previousYearRevenue?: number; plannedRevenue?: number }> {
  try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); }
  catch { return {}; }
}

export function useVj2025Import(tenantId?: string, onDone?: () => void) {
  useEffect(() => {
    // Nur für Oliv — VJ2025_DAILY enthält Oliv-spezifische Daten
    if (tenantId && tenantId !== TENANT_ID) return;

    // Nur einmal ausführen (sessionStorage-Flag verhindert Wiederholung)
    if (sessionStorage.getItem(IMPORT_DONE_KEY)) return;

    (async () => {
      try {
        // Lock-Check: Keine Seed-Daten importieren wenn VJ gesperrt
        const locked = await isLocked(TENANT_ID, VJ_YEAR);
        if (locked) {
          console.log(`[PRIOR-YEAR] tenant: ${TENANT_ID} | year: ${VJ_YEAR} | locked: true`);
          console.log(`[PRIOR-YEAR] import blocked: locked | values preserved: yes`);
          sessionStorage.setItem(IMPORT_DONE_KEY, '1');
          return;
        }

        // Prüfen ob April-2025-Daten bereits vorhanden
        const existing = readDailyBudgets();
        const alreadyHas2025 = Object.keys(existing).filter(k => k.startsWith('2025-')).length >= 300;
        if (alreadyHas2025) {
          sessionStorage.setItem(IMPORT_DONE_KEY, '1');
          return;
        }

        // Sichere Schreiboperation: immer zuerst KV-Stand laden, dann mergen.
        // So können VJ-2025-Seeds niemals bestehende 2026-Umsätze überschreiben.
        const { safeUpsertDailyBudgets } = await import('@/lib/supabase-kv');

        const updates: Record<string, Record<string, unknown>> = {};
        let count = 0;
        for (const [iso, revenue] of Object.entries(VJ2025_DAILY)) {
          updates[iso] = { actualRevenue: revenue };
          count++;
        }
        if (count === 0) { sessionStorage.setItem(IMPORT_DONE_KEY, '1'); return; }

        // onlyIfZero=true → nur Tage setzen die noch 0 sind (schützt manuelle Einträge)
        await safeUpsertDailyBudgets('dailyBudgets', updates, true);
        console.log(`[VJ2025 IMPORT] ${count} VJ-Tage sicher in dailyBudgets gesetzt (onlyIfZero, nie 2026 überschrieben)`);

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
