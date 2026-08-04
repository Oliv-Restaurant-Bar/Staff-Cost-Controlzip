/**
 * useStartPrefs — Personalisierung der Startseite (localStorage, pro Benutzer).
 * =============================================================================
 * Schlüssel: tenant- UND benutzer-präfixiert (`start_prefs_v1_<userId>`) —
 * jede Benutzerin personalisiert ihre eigene Startseite je Betrieb.
 * Bewusst NUR localStorage (kein KV-Backup): reine Anzeige-Präferenz ohne
 * Fachdaten; Verlust ⇒ Defaults. Gäste sehen immer die Defaults (read-only,
 * savePrefs ist für Gast-Sessions ein No-op).
 * Speichern = read→modify→write des GANZEN Objekts (zwei Verbraucher —
 * KPI-Sektion und Heute-Sektion — überschreiben einander nie).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import { useAuth } from '@/hooks/useAuth';
import {
  defaultStartPrefs,
  normalizeStartPrefs,
  START_PREFS_KEY,
  type StartPrefs,
} from '@/lib/start-prefs';

/** Gleiches Fenster-Event für alle Verbraucher — Sektionen bleiben synchron. */
export const START_PREFS_UPDATED_EVENT = 'start-prefs-updated';

export function useStartPrefs(): {
  prefs: StartPrefs;
  /** false = Gast-Session: keine Personalisierung anbieten. */
  canCustomize: boolean;
  /** Teil-Update (read→modify→write); Gast = No-op. */
  savePrefs: (patch: Partial<StartPrefs>) => void;
} {
  const { tenantKey } = useTenant();
  const { user } = useAuth();

  const storageKey = tenantKey(`${START_PREFS_KEY}_${user?.id ?? 'anon'}`);

  const read = useCallback((): StartPrefs => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? normalizeStartPrefs(JSON.parse(raw)) : defaultStartPrefs();
    } catch {
      return defaultStartPrefs();
    }
  }, [storageKey]);

  const [prefs, setPrefs] = useState<StartPrefs>(read);

  // Tenant-/Userwechsel: Präferenzen neu lesen; fremde Saves via Event spiegeln.
  useEffect(() => {
    setPrefs(read());
    const handler = () => setPrefs(read());
    window.addEventListener(START_PREFS_UPDATED_EVENT, handler);
    return () => window.removeEventListener(START_PREFS_UPDATED_EVENT, handler);
  }, [read]);

  const savePrefs = useCallback(
    (patch: Partial<StartPrefs>) => {
      const next = normalizeStartPrefs({ ...read(), ...patch });
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* localStorage voll/gesperrt — Anzeige-Präferenz, kein harter Fehler */
      }
      setPrefs(next);
      window.dispatchEvent(new Event(START_PREFS_UPDATED_EVENT));
    },
    [read, storageKey],
  );

  return { prefs, canCustomize: true, savePrefs };
}
