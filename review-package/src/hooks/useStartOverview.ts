/**
 * useStartOverview — Dünner Lade-Hook für die vereinfachte Startseite.
 * ====================================================================
 * STRIKT READ-ONLY: nutzt den bestehenden Cockpit-Aggregator
 * `fetchCockpitSignals` (tenant-korrekt, Promise.allSettled-robust) und liest
 * den Tagesabschluss-Bestätigungsstand direkt aus dem localStorage-Blob
 * `adyenAbstimmung_v1` — NIE über die Save-Schicht (kein Schreibpfad, keine
 * Migration). Sichtbare Zustände loading/error/ready statt stiller Fallbacks.
 *
 * Gating: Der Hook lädt nur bei `enabled=true` (Route rendert die Startseite
 * nur für Admins inkl. Gast-Lesezugriff — Gäste sehen nur PII-freie Aggregate).
 */

import { useCallback, useEffect, useState } from 'react';
import { format } from 'date-fns';
import { useTenant } from '@/contexts/TenantContext';
import { fetchCockpitSignals } from '@/lib/import-cockpit-db';
import { normalizeAdyenBlob } from '@/lib/adyen-abstimmung';
import {
  buildStartOverview,
  tagesabschlussFromConfirmations,
  type StartOverviewResult,
} from '@/lib/start-overview-utils';

export type StartOverviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: StartOverviewResult; loadedAt: Date };

export function useStartOverview(enabled: boolean): {
  state: StartOverviewState;
  refresh: () => Promise<void>;
} {
  const { tenantId, tenantKey } = useTenant();
  const [state, setState] = useState<StartOverviewState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const signals = await fetchCockpitSignals({ tenantId, tenantKey });

      // Tagesabschluss-Bestätigungen: read-only Direkt-Read (wie adyenSignal im Cockpit).
      let raw: unknown = null;
      try {
        raw = JSON.parse(localStorage.getItem(tenantKey('adyenAbstimmung_v1')) || 'null');
      } catch {
        raw = null;
      }
      const blob = normalizeAdyenBlob(raw);
      const todayIso = format(new Date(), 'yyyy-MM-dd');

      const data = buildStartOverview({
        todayIso,
        signals: {
          zbericht: signals.zbericht,
          reservationen: signals.reservationen,
          dienstplanung: signals.dienstplanung,
        },
        tagesabschluss: tagesabschlussFromConfirmations(
          blob.confirmations,
          Object.keys(blob.days).length > 0,
          todayIso,
        ),
      });
      setState({ status: 'ready', data, loadedAt: new Date() });
    } catch (e) {
      setState({
        status: 'error',
        message: e instanceof Error ? e.message : 'Unbekannter Fehler beim Laden der Übersicht.',
      });
    }
  }, [tenantId, tenantKey]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  return { state, refresh };
}
