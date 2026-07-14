/**
 * usePositions — lädt die Positionsstammdaten des aktiven Mandanten und bietet
 * Mutations-Helfer (anlegen/aktualisieren/löschen/seed), die danach neu laden.
 *
 * Tenant kommt aus dem TenantContext (tenantId = restaurant_id).
 */
import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import type { Position, PositionDraft } from '@/types/positions';
import {
  loadPositions,
  upsertPosition,
  deletePosition,
  seedDefaultPositions,
  applyDefaultPositions,
} from '@/lib/positions-db';

export function usePositions() {
  const { tenantId } = useTenant();
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPositions(await loadPositions(tenantId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Positionen konnten nicht geladen werden');
      setPositions([]);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void reload(); }, [reload]);

  const save = useCallback(
    async (draft: PositionDraft & { id?: string }) => {
      const saved = await upsertPosition(tenantId, draft);
      await reload();
      return saved;
    },
    [tenantId, reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await deletePosition(tenantId, id);
      await reload();
    },
    [tenantId, reload],
  );

  const seed = useCallback(async () => {
    const seeded = await seedDefaultPositions(tenantId);
    await reload();
    return seeded;
  }, [tenantId, reload]);

  const applyDefaults = useCallback(async () => {
    const applied = await applyDefaultPositions(tenantId);
    await reload();
    return applied;
  }, [tenantId, reload]);

  return { tenantId, positions, loading, error, reload, save, remove, seed, applyDefaults };
}
