/**
 * useImportMonthProgress — Fortschritt pro Monat für die Monatsauswahl der
 * Import-Checkliste (lazy, gecacht, read-only).
 *
 * - `seed`: verrechnet eine bereits geladene Monats-Coverage (aktueller
 *   Auswahl-Monat der Seite) OHNE zusätzlichen Fetch in den Cache.
 * - `loadYear`: lädt beim Öffnen der Monatsauswahl fehlende Monate eines
 *   Jahres nach — NUR Monate ≤ aktueller Monat (Zukunft = „Noch nicht
 *   begonnen" ohne Fetch), begrenzte Parallelität.
 * - Cache-Key `yyyy-MM`, tenant-scoped: Tenant-Wechsel leert den Cache.
 * - `invalidate` für „Aktualisieren" (refreshAll) der Seite.
 *
 * Fetch-Gate: ohne `allowed` wird NIE eine Abfrage ausgelöst.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCoverageForMonths, type ImportTasksFetchContext, type MonthRef } from '@/lib/import-tasks-db';
import { buildImportTasks, type MonthCoverage } from '@/lib/import-tasks-engine';
import { computeMonthProgress, monthKey, type MonthProgress } from '@/lib/import-tasks-priority';
import type { EffectiveImportSettings } from '@/lib/import-settings';

/** null = Monat konnte nicht geladen werden (sichtbarer Fehlerzustand). */
export type MonthProgressMap = Record<string, MonthProgress | null>;

function progressFromCoverage(
  year: number,
  month: number,
  coverage: MonthCoverage,
  today: string,
  settings: EffectiveImportSettings,
): MonthProgress {
  const tasks = buildImportTasks({ year, month, today }, coverage, settings);
  return computeMonthProgress(tasks, { year, month, today });
}

export function useImportMonthProgress({
  allowed,
  tenantId,
  tenantKey,
  settings,
}: {
  allowed: boolean;
  tenantId: string;
  tenantKey: (key: string) => string;
  /** Effektive Import-Einstellungen (Frequenzen/Karenz/Ruhetage) für die Aufgaben-Ableitung. */
  settings: EffectiveImportSettings;
}) {
  const [map, setMap] = useState<MonthProgressMap>({});
  const [loading, setLoading] = useState(false);
  /** Monate, die geladen sind ODER gerade laden (verhindert Doppel-Fetches). */
  const inFlight = useRef<Set<string>>(new Set());
  /** Generation gegen Races: laufende loadYear-Ergebnisse nach invalidate/Tenant-Wechsel verwerfen. */
  const generation = useRef(0);

  // Tenant-Wechsel ODER geänderte Einstellungen: Cache vollständig verwerfen
  // (andere Frequenzen/Ruhetage ⇒ andere Aufgaben ⇒ anderer Fortschritt).
  useEffect(() => {
    generation.current += 1;
    setMap({});
    inFlight.current = new Set();
  }, [tenantId, settings]);

  /** Bereits geladene Coverage (Auswahl-Monat der Seite) in den Cache übernehmen. */
  const seed = useCallback((year: number, month: number, coverage: MonthCoverage, today: string) => {
    const key = monthKey(year, month);
    inFlight.current.add(key);
    setMap((prev) => ({ ...prev, [key]: progressFromCoverage(year, month, coverage, today, settings) }));
  }, [settings]);

  /** Fehlende Monate eines Jahres nachladen (nur Vergangenheit + aktueller Monat). */
  const loadYear = useCallback(
    async (year: number, today: string) => {
      if (!allowed) return;
      const currentKey = today.slice(0, 7);
      const missing: MonthRef[] = [];
      for (let month = 1; month <= 12; month++) {
        const key = monthKey(year, month);
        if (key > currentKey) continue; // Zukunft: „Noch nicht begonnen" ohne Fetch
        if (inFlight.current.has(key)) continue;
        inFlight.current.add(key);
        missing.push({ year, month });
      }
      if (missing.length === 0) return;
      const startedGeneration = generation.current;
      setLoading(true);
      try {
        const ctx: ImportTasksFetchContext = { tenantId, tenantKey };
        const coverages = await fetchCoverageForMonths(ctx, missing, 3);
        // Veraltete Antwort (invalidate/Tenant-Wechsel während des Fetches) verwerfen.
        if (generation.current !== startedGeneration) return;
        setMap((prev) => {
          const next = { ...prev };
          for (const m of missing) {
            const key = monthKey(m.year, m.month);
            const cov = coverages[key];
            next[key] = cov ? progressFromCoverage(m.year, m.month, cov, today, settings) : null;
          }
          return next;
        });
        // Fehlgeschlagene Monate wieder freigeben → erneuter Versuch möglich.
        for (const m of missing) {
          const key = monthKey(m.year, m.month);
          if (!coverages[key]) inFlight.current.delete(key);
        }
      } finally {
        setLoading(false);
      }
    },
    [allowed, tenantId, tenantKey, settings],
  );

  /** Für „Aktualisieren": Cache leeren (Auswahl-Monat wird danach neu geseedet). */
  const invalidate = useCallback(() => {
    generation.current += 1;
    setMap({});
    inFlight.current = new Set();
  }, []);

  return { map, loading, seed, loadYear, invalidate };
}
