/**
 * useStaffingRequirements — lädt den Personalbedarf (SOLL-Besetzung) des aktiven
 * Mandanten und bietet einen scope-weisen Speicher-Helfer.
 *
 * Tenant kommt aus dem TenantContext (tenantId = restaurant_id).
 *
 * Es werden ALLE Bedarfs-Zeilen des Mandanten geladen (3 Saisons × 7 Tage ×
 * wenige Positionen/Schichten = unkritisch wenige Zeilen); die Seite filtert
 * den aktiven Geltungsbereich in-memory. Gespeichert wird immer genau EIN
 * Geltungsbereich (Saison × Wochentag) über `saveStaffingScope`.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import type {
  StaffingRequirement,
  StaffingRequirementDraft,
  StaffingScope,
} from '@/types/staffing';
import { loadStaffingRequirements, saveStaffingScope } from '@/lib/staffing-requirements-db';

export function useStaffingRequirements() {
  const { tenantId } = useTenant();
  const [requirements, setRequirements] = useState<StaffingRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Generation-Guard: eine späte Antwort (z.B. nach Mandantenwechsel) darf den
  // State des neueren Ladevorgangs nicht überschreiben.
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const loaded = await loadStaffingRequirements(tenantId);
      if (gen !== generation.current) return;
      setRequirements(loaded);
    } catch (e) {
      if (gen !== generation.current) return;
      setError(e instanceof Error ? e.message : 'Personalbedarf konnte nicht geladen werden');
      setRequirements([]);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void reload(); }, [reload]);

  const saveScope = useCallback(
    async (scope: StaffingScope, drafts: (StaffingRequirementDraft & { id?: string })[]) => {
      const saved = await saveStaffingScope(tenantId, scope, drafts);
      await reload();
      return saved;
    },
    [tenantId, reload],
  );

  return { tenantId, requirements, loading, error, reload, saveScope };
}
