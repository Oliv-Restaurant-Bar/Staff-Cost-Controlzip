/**
 * useSeasonDefinitions — lädt die frei definierten, datumsfixen Saisons des
 * aktiven Mandanten (Saisonvergleich der Wochentags-Analyse) und bietet einen
 * `save`-Helfer (ersetzt die gesamte Liste optimistisch + persistiert per KV).
 *
 * Tenant kommt aus dem TenantContext (tenantId = restaurant_id). Persistenz:
 * `season-definitions-db` (KV + localStorage, KEINE Tabelle/Migration).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import {
  loadSeasonDefinitions,
  saveSeasonDefinitions,
} from '@/lib/season-definitions-db';
import type { SeasonDefinition } from '@/lib/reservation-weekday-analytics';

export interface UseSeasonDefinitions {
  tenantId: string;
  seasons: SeasonDefinition[];
  loading: boolean;
  /** true, wenn der letzte Speichervorgang nicht persistiert werden konnte. */
  saveError: boolean;
  reload: () => Promise<void>;
  /** Ersetzt die gesamte Liste (optimistisch) + persistiert. Gibt Erfolg zurück. */
  save: (next: SeasonDefinition[]) => Promise<boolean>;
}

export function useSeasonDefinitions(): UseSeasonDefinitions {
  const { tenantId } = useTenant();
  const [seasons, setSeasons] = useState<SeasonDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState(false);
  // Generation-Guard: eine späte Antwort (z.B. nach Mandantenwechsel) darf den
  // State des neueren Ladevorgangs nicht überschreiben.
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    try {
      const loaded = await loadSeasonDefinitions(tenantId);
      if (gen !== generation.current) return;
      setSeasons(loaded);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void reload(); }, [reload]);

  const save = useCallback(
    async (next: SeasonDefinition[]) => {
      setSeasons(next); // optimistisch
      const ok = await saveSeasonDefinitions(tenantId, next);
      setSaveError(!ok);
      return ok;
    },
    [tenantId],
  );

  return { tenantId, seasons, loading, saveError, reload, save };
}
