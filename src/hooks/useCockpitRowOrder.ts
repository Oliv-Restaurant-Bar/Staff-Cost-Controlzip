/**
 * useCockpitRowOrder — benutzerdefinierte Reihenfolge der Cockpit-Report-Zeilen.
 *
 * EINE gespeicherte Reihenfolge für Monats- UND Wochenübersicht (gleiche Zeilen).
 * Persistenz pro Tenant in app_settings via tenantKey('cockpit_row_order_v1').
 *
 * Fehlertoleranz:
 *  - Lesefehler (loadSetting → null) überschreibt NICHT den gespeicherten Wert;
 *    es wird erst geschrieben, wenn der User wirklich umsortiert (saveOrder()).
 *  - `ready` signalisiert das abgeschlossene (erste) Laden, damit die UI nicht
 *    kurz die Standardreihenfolge zeigt und dann springt.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import { loadSetting, saveSetting } from '@/lib/supabase-db';
import type { CockpitRowOrder } from '@/lib/monatsreport';

const ROW_ORDER_KEY = 'cockpit_row_order_v1';

export function useCockpitRowOrder() {
  const { tenantKey } = useTenant();
  const storageKey = tenantKey(ROW_ORDER_KEY);
  const [savedIds, setSavedIds] = useState<string[] | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    setReady(false);
    loadSetting<CockpitRowOrder>(storageKey)
      .then(v => {
        if (!alive) return;
        // Nur ein gültiges Array übernehmen; sonst Standard (null).
        setSavedIds(Array.isArray(v?.ids) ? v!.ids : null);
      })
      .catch(() => { if (alive) setSavedIds(null); })
      .finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [storageKey]);

  /** Neue Reihenfolge sofort anwenden (optimistisch) und persistieren. */
  const saveOrder = useCallback((ids: string[]) => {
    setSavedIds(ids);
    const payload: CockpitRowOrder = { ids, updatedAt: new Date().toISOString() };
    void saveSetting(storageKey, payload);
  }, [storageKey]);

  /** Standard wiederherstellen: Setting leeren → Standardreihenfolge. */
  const resetOrder = useCallback(() => {
    setSavedIds(null);
    const payload: CockpitRowOrder = { ids: [], updatedAt: new Date().toISOString() };
    void saveSetting(storageKey, payload);
  }, [storageKey]);

  return { savedIds, ready, saveOrder, resetOrder };
}
