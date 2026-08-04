/**
 * usePersonalstammPrefs — Ansicht/Sortierung der Personalstamm-Liste
 * (localStorage, pro Benutzer — Muster useStartPrefs).
 * =============================================================================
 * Schlüssel: tenant- UND benutzer-präfixiert (`personalstamm_prefs_v1_<userId>`).
 * Bewusst NUR localStorage (kein KV-Backup): reine Anzeige-Präferenz ohne
 * Fachdaten; Verlust ⇒ Defaults. Gäste sehen immer die Defaults (savePrefs
 * ist für Gast-Sessions ein No-op).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import { useAuth } from '@/hooks/useAuth';
import {
  defaultPersonalstammPrefs,
  normalizePersonalstammPrefs,
  PERSONALSTAMM_PREFS_KEY,
  type PersonalstammPrefs,
} from '@/lib/personalstamm-prefs';

export function usePersonalstammPrefs(): {
  prefs: PersonalstammPrefs;
  /** Teil-Update (read→modify→write); Gast = No-op. */
  savePrefs: (patch: Partial<PersonalstammPrefs>) => void;
} {
  const { tenantKey } = useTenant();
  const { user } = useAuth();

  const storageKey = tenantKey(`${PERSONALSTAMM_PREFS_KEY}_${user?.id ?? 'anon'}`);

  const read = useCallback((): PersonalstammPrefs => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? normalizePersonalstammPrefs(JSON.parse(raw)) : defaultPersonalstammPrefs();
    } catch {
      return defaultPersonalstammPrefs();
    }
  }, [storageKey]);

  const [prefs, setPrefs] = useState<PersonalstammPrefs>(read);

  // Tenant-/Userwechsel: Präferenzen neu lesen.
  useEffect(() => {
    setPrefs(read());
  }, [read]);

  const savePrefs = useCallback(
    (patch: Partial<PersonalstammPrefs>) => {
      const next = normalizePersonalstammPrefs({ ...read(), ...patch });
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* localStorage voll/gesperrt — Anzeige-Präferenz, kein harter Fehler */
      }
      setPrefs(next);
    },
    [read, storageKey],
  );

  return { prefs, savePrefs };
}
