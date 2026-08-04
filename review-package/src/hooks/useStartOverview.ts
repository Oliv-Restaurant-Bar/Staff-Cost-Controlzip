/**
 * useStartOverview — Dünner Lade-Hook für die vereinfachte Startseite.
 * ====================================================================
 * STRIKT READ-ONLY: nutzt den bestehenden Cockpit-Aggregator
 * `fetchCockpitSignals` (tenant-korrekt, Promise.allSettled-robust) und liest
 * den Tagesabschluss-Bestätigungsstand direkt aus dem localStorage-Blob
 * `adyenAbstimmung_v1` — NIE über die Save-Schicht (kein Schreibpfad, keine
 * Migration). Sichtbare Zustände loading/error/ready statt stiller Fallbacks.
 *
 * Zusätzlich lädt der Hook die Import-Abdeckung des AKTUELLEN Monats
 * (fetchMonthCoverage, read-only) und leitet daraus über die zentralen
 * SSoT-Bausteine (buildImportTasks → getTodayTasks / summarizeTypeCompletion)
 * die «Als Nächstes»-Aufgaben und den kompakten Datenstand ab — KEINE eigene
 * Status- oder Frische-Berechnung. Scheitert NUR dieser Teil, bleibt die Seite
 * mit den Statuskarten nutzbar und zeigt den Teilfehler sichtbar an
 * (`coverageError`), statt still zu verschwinden.
 *
 * Gating: Der Hook lädt nur bei `enabled=true` (Route rendert die Startseite
 * nur für Admins inkl. Gast-Lesezugriff — Gäste sehen nur PII-freie Aggregate).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import { useTenant } from '@/contexts/TenantContext';
import { fetchCockpitSignals } from '@/lib/import-cockpit-db';
import { fetchMonthCoverage } from '@/lib/import-tasks-db';
import { normalizeAdyenBlob } from '@/lib/adyen-abstimmung';
import { buildImportTasks } from '@/lib/import-tasks-engine';
import { resolveImportSettings } from '@/lib/import-settings';
import { loadImportSettings } from '@/lib/import-settings-db';
import {
  getTodayTasks,
  summarizeTypeCompletion,
  type PrioritizedTask,
  type TypeCompletion,
} from '@/lib/import-tasks-priority';
import {
  buildStartOverview,
  tagesabschlussFromConfirmations,
  type StartOverviewResult,
} from '@/lib/start-overview-utils';

export type StartOverviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      data: StartOverviewResult;
      /** Priorisierte „heute anstehende" Import-Aufgaben (SSoT getTodayTasks); null bei coverageError. */
      todayTasks: PrioritizedTask[] | null;
      /** Typ-Zusammenfassung (summarizeTypeCompletion) desselben Aufgabenstands; null bei coverageError. */
      typeCompletions: TypeCompletion[] | null;
      /** Sichtbarer Teilfehler: Aufgaben/Datenstand konnten nicht geladen werden. */
      coverageError: string | null;
      loadedAt: Date;
    };

export function useStartOverview(enabled: boolean): {
  state: StartOverviewState;
  refresh: () => Promise<void>;
} {
  const { tenantId, tenantKey } = useTenant();
  const [state, setState] = useState<StartOverviewState>({ status: 'loading' });
  // Stale-Guard: nach Tenant-/Userwechsel dürfen noch laufende alte Requests
  // den neuen Zustand NICHT überschreiben (D007) — nur die jüngste Generation
  // darf setState aufrufen.
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++generation.current;
    setState({ status: 'loading' });
    const todayIso = format(new Date(), 'yyyy-MM-dd');
    try {
      // Karten (Pflichtteil) und Monats-Abdeckung (optionaler Teil) parallel laden;
      // ein Coverage-Fehler darf die Karten NICHT mitreissen (sichtbarer Teilfehler).
      const now = new Date();
      const [signalsResult, coverageResult, settingsResult] = await Promise.allSettled([
        fetchCockpitSignals({ tenantId, tenantKey }),
        fetchMonthCoverage({ tenantId, tenantKey }, now.getFullYear(), now.getMonth() + 1),
        // Effektive Import-Einstellungen (Frequenz/Karenz/Ruhetage) — wirft nie
        // (Fallback auf localStorage), damit Aufgaben identisch zum Cockpit sind.
        loadImportSettings(tenantId),
      ]);
      if (signalsResult.status === 'rejected') throw signalsResult.reason;
      const signals = signalsResult.value;

      // Tagesabschluss-Bestätigungen: read-only Direkt-Read (wie adyenSignal im Cockpit).
      let raw: unknown = null;
      try {
        raw = JSON.parse(localStorage.getItem(tenantKey('adyenAbstimmung_v1')) || 'null');
      } catch {
        raw = null;
      }
      const blob = normalizeAdyenBlob(raw);

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

      let todayTasks: PrioritizedTask[] | null = null;
      let typeCompletions: TypeCompletion[] | null = null;
      let coverageError: string | null = null;
      if (coverageResult.status === 'fulfilled') {
        // Reine SSoT-Ableitung — identische Bausteine wie Import-Checkliste/Cockpit.
        const settings = resolveImportSettings(
          settingsResult.status === 'fulfilled' ? settingsResult.value : {},
        );
        const tasks = buildImportTasks(
          { year: now.getFullYear(), month: now.getMonth() + 1, today: todayIso },
          coverageResult.value,
          settings,
        );
        todayTasks = getTodayTasks(tasks, todayIso);
        typeCompletions = summarizeTypeCompletion(tasks, todayIso);
      } else {
        coverageError =
          coverageResult.reason instanceof Error
            ? coverageResult.reason.message
            : 'Import-Aufgaben konnten nicht geladen werden.';
      }

      if (gen !== generation.current) return; // veralteter Request → verwerfen
      setState({
        status: 'ready',
        data,
        todayTasks,
        typeCompletions,
        coverageError,
        loadedAt: new Date(),
      });
    } catch (e) {
      if (gen !== generation.current) return; // veralteter Request → verwerfen
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
