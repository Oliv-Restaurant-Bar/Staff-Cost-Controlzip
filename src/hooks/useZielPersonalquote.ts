/**
 * useZielPersonalquote — zentrale Ziel-Personalquote im React-Layer.
 * ===================================================================
 * Lädt die Quote tenant-scoped (localStorage sofort, KV-Backup async) und hält
 * sie über das ZIEL_PERSONALQUOTE_UPDATED_EVENT app-weit synchron (Settings-Card
 * speichert → offene Seiten ziehen nach).
 *
 * Read-only-Konsum: `const { pct } = useZielPersonalquote();` — `pct` ist ab dem
 * ersten Render nutzbar (localStorage-Stand bzw. Default 35.5, nie null).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import {
  loadZielPersonalquote,
  loadZielPersonalquoteLocal,
  saveZielPersonalquote,
  ZIEL_PERSONALQUOTE_UPDATED_EVENT,
  type ZielPersonalquoteBlob,
} from '@/lib/ziel-personalquote';

export function useZielPersonalquote() {
  const { tenantId } = useTenant();
  const [blob, setBlob] = useState<ZielPersonalquoteBlob>(() => loadZielPersonalquoteLocal(tenantId));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setBlob(loadZielPersonalquoteLocal(tenantId));
    setLoading(true);
    loadZielPersonalquote(tenantId)
      .then((b) => { if (!cancelled) setBlob(b); })
      .finally(() => { if (!cancelled) setLoading(false); });

    const onUpdated = () => setBlob(loadZielPersonalquoteLocal(tenantId));
    window.addEventListener(ZIEL_PERSONALQUOTE_UPDATED_EVENT, onUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(ZIEL_PERSONALQUOTE_UPDATED_EVENT, onUpdated);
    };
  }, [tenantId]);

  const save = useCallback(async (pct: number) => {
    const saved = await saveZielPersonalquote(tenantId, pct);
    setBlob(saved);
    return saved;
  }, [tenantId]);

  return { pct: blob.pct, updatedAt: blob.updatedAt, loading, save };
}
