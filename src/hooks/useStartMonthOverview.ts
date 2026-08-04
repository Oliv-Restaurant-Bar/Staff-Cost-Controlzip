/**
 * useStartMonthOverview — Lade-Hook der kompakten Monatsübersicht (Startseite).
 * =============================================================================
 * STRIKT READ-ONLY (T503): lädt die Import-Abdeckung des GEWÄHLTEN Monats über
 * den bestehenden Aggregator `fetchMonthCoverage` und leitet die Zeilen rein
 * über die SSoT-Bausteine ab (buildImportTasks → summarizeTypeCompletion →
 * buildMonthOverviewRows) — KEINE eigene Coverage-/Status-/Frische-Berechnung.
 *
 * Regeln (identisch zu den bestehenden Coverage-Ladeprozessen, §2 replit.md):
 *  - Cache pro `${tenantId}:${year}-${month}` (nur Hook-Lebensdauer, keine
 *    neue Persistenz) — Monatswechsel per Pfeil bleibt flott.
 *  - Zukunftsmonate werden NIE gefetcht: alle Zeilen «Noch nicht fällig».
 *  - Stale-Guard: veraltete Antworten nach Tenant-/Monatswechsel verwerfen.
 *
 * Umsatzabstimmungs-Status (T507): rein lesender Direkt-Read der bestehenden
 * localStorage-Blobs (`reporting_v1` Monats-Records + `dailyBudgets`
 * Tagessummen) und Bewertung über die AUS UmsatzAbstimmung.tsx extrahierte
 * Statuslogik (umsatzabstimmung-status.ts) — keine Zweitberechnung, kein
 * Store-Loader, kein Write.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import { useTenant } from '@/contexts/TenantContext';
import { fetchMonthCoverage } from '@/lib/import-tasks-db';
import { buildImportTasks, type MonthCoverage } from '@/lib/import-tasks-engine';
import { summarizeTypeCompletion } from '@/lib/import-tasks-priority';
import { resolveImportSettings } from '@/lib/import-settings';
import { loadImportSettingsLocal } from '@/lib/import-settings-db';
import { readLocalRecord } from '@/lib/kv-blob-utils';
import {
  buildMonthOverviewRows,
  isFutureMonthPeriod,
  shiftMonth,
  type MonthOverviewRow,
  type MonthPeriod,
} from '@/lib/start-overview-utils';
import {
  describeUmsatzMonth,
  sumDailyGrossForMonth,
  type UmsatzMonthSummary,
} from '@/lib/umsatzabstimmung-status';
import { monthId } from '@/types/reporting';

export type StartMonthOverviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; rows: MonthOverviewRow[] };

/** Read-only Kurzstatus der Umsatzabstimmung aus den bestehenden localStorage-Blobs. */
function readUmsatzSummary(
  tenantKey: (key: string) => string,
  period: MonthPeriod,
  todayIso: string,
): UmsatzMonthSummary {
  const months = readLocalRecord(tenantKey('reporting_v1'));
  const rec = months[monthId(period.year, period.month)] as
    | { grossRevenueManual?: unknown }
    | undefined;
  const manualRaw = rec?.grossRevenueManual;
  const manual = typeof manualRaw === 'number' ? manualRaw : undefined;
  const daily = sumDailyGrossForMonth(
    readLocalRecord(tenantKey('dailyBudgets')),
    period.year,
    period.month,
  );
  return describeUmsatzMonth(manual, daily, isFutureMonthPeriod(period, todayIso));
}

export function useStartMonthOverview(
  enabled: boolean,
): {
  period: MonthPeriod;
  setPeriod: (p: MonthPeriod) => void;
  shiftBy: (delta: number) => void;
  state: StartMonthOverviewState;
} {
  const { tenantId, tenantKey } = useTenant();
  const [period, setPeriod] = useState<MonthPeriod>(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [state, setState] = useState<StartMonthOverviewState>({ status: 'loading' });
  const cacheRef = useRef(new Map<string, MonthCoverage>());
  const runRef = useRef(0);

  const load = useCallback(async () => {
    const token = ++runRef.current;
    const todayIso = format(new Date(), 'yyyy-MM-dd');
    const umsatz = readUmsatzSummary(tenantKey, period, todayIso);

    // Zukunftsmonat: NIE fetchen — alles «Noch nicht fällig», nie „fehlend".
    if (isFutureMonthPeriod(period, todayIso)) {
      setState({
        status: 'ready',
        rows: buildMonthOverviewRows({
          period,
          tasks: null,
          completions: null,
          umsatzabstimmung: umsatz,
        }),
      });
      return;
    }

    const buildFromCoverage = (coverage: MonthCoverage): MonthOverviewRow[] => {
      // Einstellungen sync aus dem lokalen Primärspeicher (Cockpit/Startseite
      // mergen das KV-Backup bereits beim Laden) — kein zusätzlicher Fetch.
      const settings = resolveImportSettings(loadImportSettingsLocal(tenantId));
      const tasks = buildImportTasks(
        { year: period.year, month: period.month, today: todayIso },
        coverage,
        settings,
      );
      return buildMonthOverviewRows({
        period,
        tasks,
        completions: summarizeTypeCompletion(tasks, todayIso),
        umsatzabstimmung: umsatz,
      });
    };

    const cacheKey = `${tenantId}:${period.year}-${period.month}`;
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setState({ status: 'ready', rows: buildFromCoverage(cached) });
      return;
    }

    setState({ status: 'loading' });
    try {
      const coverage = await fetchMonthCoverage({ tenantId, tenantKey }, period.year, period.month);
      if (runRef.current !== token) return; // veraltete Antwort (Tenant-/Monatswechsel)
      cacheRef.current.set(cacheKey, coverage);
      setState({ status: 'ready', rows: buildFromCoverage(coverage) });
    } catch (e) {
      if (runRef.current !== token) return;
      setState({
        status: 'error',
        message: e instanceof Error ? e.message : 'Monatsübersicht konnte nicht geladen werden.',
      });
    }
  }, [tenantId, tenantKey, period]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  // Tenant-Wechsel: Cache leeren (Schlüssel sind zwar tenant-präfixiert,
  // aber ein frischer Stand vermeidet jede Verwechslungsgefahr).
  useEffect(() => {
    cacheRef.current.clear();
  }, [tenantId]);

  const shiftBy = useCallback((delta: number) => {
    setPeriod((p) => shiftMonth(p, delta));
  }, []);

  return { period, setPeriod, shiftBy, state };
}
