/**
 * useSocialCostRates — zentrale AG-Sozialkostensätze im React-Layer.
 * ==================================================================
 * Lädt die Sätze tenant-scoped (localStorage sofort, KV-Backup async) und
 * hält sie über das SOCIAL_COST_RATES_UPDATED_EVENT app-weit synchron
 * (Settings-Card speichert → offene Seiten ziehen nach).
 *
 * Read-only-Konsum: `const { rates } = useSocialCostRates();` — rates ist ab
 * dem ersten Render nutzbar (localStorage-Stand bzw. CH-Defaults, nie null).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import {
  loadSocialCostRates,
  loadSocialCostRatesLocal,
  saveSocialCostRates,
  SOCIAL_COST_RATES_UPDATED_EVENT,
} from '@/lib/social-costs-db';
import type { SocialCostRates, SocialCostRatesBlob } from '@/lib/social-costs';

export function useSocialCostRates() {
  const { tenantId } = useTenant();
  const [blob, setBlob] = useState<SocialCostRatesBlob>(() => loadSocialCostRatesLocal(tenantId));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Sofort den lokalen Stand des (ggf. gewechselten) Tenants zeigen …
    setBlob(loadSocialCostRatesLocal(tenantId));
    setLoading(true);
    // … dann KV-Backup nachladen (Wahrheit, falls vorhanden).
    loadSocialCostRates(tenantId)
      .then((b) => { if (!cancelled) setBlob(b); })
      .finally(() => { if (!cancelled) setLoading(false); });

    const onUpdated = () => setBlob(loadSocialCostRatesLocal(tenantId));
    window.addEventListener(SOCIAL_COST_RATES_UPDATED_EVENT, onUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(SOCIAL_COST_RATES_UPDATED_EVENT, onUpdated);
    };
  }, [tenantId]);

  const save = useCallback(async (rates: SocialCostRates) => {
    const saved = await saveSocialCostRates(tenantId, rates);
    setBlob(saved);
    return saved;
  }, [tenantId]);

  return { rates: blob.rates, updatedAt: blob.updatedAt, loading, save };
}
