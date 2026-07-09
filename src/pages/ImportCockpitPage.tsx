/**
 * ImportCockpitPage — Admin-Seite „Import-Checkliste" (3 Tabs).
 * =============================================================
 * Gliedert die Datenpflege in drei Sichten:
 *   1. „Checkliste" (Default) — automatisch erzeugte offene Import-Aufgaben
 *      pro Monat (Engine import-tasks-engine + Abdeckung import-tasks-db)
 *      mit Import-Button, der direkt in den bestehenden Import-Flow springt.
 *   2. „Status"      — Datei-/Erfassungs-Importe mit Frische-Status (bisheriger
 *                      Tab „Datenimporte").
 *   3. „Kontrollen"  — wiederkehrende organisatorische Checks mit Fälligkeit.
 *
 * STRIKT READ-ONLY: keine Schreibaktionen an Importdaten, keine Migration,
 * keine Änderung an Importprozessen — die Seite liest nur bestehende Signale
 * (`fetchCockpitSignals`) und die Monats-Abdeckung (`fetchMonthCoverage`).
 *
 * Zugriff: nur Admin und KEINE Gast-Session (isAdmin && !isGuest). Das Gate
 * greift auf dem Render-Pfad (Navigate) UND in den Lade-Effekten (kein Fetch
 * für Gäste), zusätzlich zur Route-Guard in App.tsx.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { ClipboardCheck, RefreshCw, Loader2, Table2, ShieldCheck, ListChecks } from 'lucide-react';
import { usePermissions } from '@/hooks/usePermissions';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { useTenant } from '@/contexts/TenantContext';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PageShell } from '@/components/layout/PageShell';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  COCKPIT_SOURCES,
  computeSourceStatus,
  type CockpitRow,
  type CockpitSignal,
  type CockpitSourceId,
} from '@/lib/import-cockpit';
import { buildImportRows, buildControlRows } from '@/lib/import-cockpit-tabs';
import { fetchCockpitSignals } from '@/lib/import-cockpit-db';
import { fetchMonthCoverage } from '@/lib/import-tasks-db';
import type { MonthCoverage } from '@/lib/import-tasks-engine';
import { useImportMonthProgress } from '@/hooks/useImportMonthProgress';
import { markControlsDone, type ManualCompletionMap } from '@/lib/import-cockpit-checks';
import { loadManualChecks, saveManualChecks } from '@/lib/import-cockpit-checks-db';
import { useToast } from '@/hooks/use-toast';
import { DataImportsTab } from '@/components/import-cockpit/DataImportsTab';
import { ControlsTab } from '@/components/import-cockpit/ControlsTab';
import { ImportChecklistTab } from '@/components/import-cockpit/ImportChecklistTab';
import { CockpitDetailDrawer } from '@/components/import-cockpit/CockpitDetailDrawer';

export default function ImportCockpitPage() {
  const { isAdmin } = usePermissions();
  const { isGuest } = useGuestSession();
  const { tenantId, tenantKey, tenant } = useTenant();
  const { toast } = useToast();
  const allowed = isAdmin && !isGuest;

  const [signals, setSignals] = useState<Record<CockpitSourceId, CockpitSignal> | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [selectedId, setSelectedId] = useState<CockpitSourceId | null>(null);
  const [manualChecks, setManualChecks] = useState<ManualCompletionMap>({});

  // Checkliste: gewählter Monat + Abdeckung (separat vom Frische-Signal-Fetch).
  const [period, setPeriod] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [coverage, setCoverage] = useState<MonthCoverage | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(true);

  // Fortschritt pro Monat für die Monatsauswahl (lazy, gecacht, tenant-scoped).
  const {
    map: monthProgressMap,
    loading: monthProgressLoading,
    seed: seedMonthProgress,
    loadYear: loadYearProgress,
    invalidate: invalidateMonthProgress,
  } = useImportMonthProgress({ allowed, tenantId, tenantKey });

  // Manuelle Kontroll-Erledigungen (tenant-scoped) laden — best-effort, wirft nie.
  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    loadManualChecks(tenantId).then((map) => {
      if (!cancelled) setManualChecks(map);
    });
    return () => {
      cancelled = true;
    };
  }, [allowed, tenantId]);

  const load = useCallback(async () => {
    // Fetch-Gate: Gäste/Nicht-Admins lösen NIE eine Abfrage aus.
    if (!allowed) return;
    setLoading(true);
    try {
      const result = await fetchCockpitSignals({ tenantId, tenantKey });
      setSignals(result);
      setLastRefresh(new Date());
    } finally {
      setLoading(false);
    }
  }, [allowed, tenantId, tenantKey]);

  const loadCoverage = useCallback(async () => {
    // Fetch-Gate wie oben: kein Coverage-Fetch für Gäste/Nicht-Admins.
    if (!allowed) return;
    setCoverageLoading(true);
    try {
      const result = await fetchMonthCoverage({ tenantId, tenantKey }, period.year, period.month);
      setCoverage(result);
      // Frisch geladene Coverage in den Monats-Fortschritts-Cache übernehmen
      // (kein zweiter Fetch für den Auswahl-Monat in der Monatsauswahl).
      seedMonthProgress(period.year, period.month, result, format(new Date(), 'yyyy-MM-dd'));
    } finally {
      setCoverageLoading(false);
    }
  }, [allowed, tenantId, tenantKey, period.year, period.month, seedMonthProgress]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadCoverage();
  }, [loadCoverage]);

  const refreshAll = useCallback(() => {
    invalidateMonthProgress();
    void load();
    void loadCoverage();
  }, [load, loadCoverage, invalidateMonthProgress]);

  // Statuszeilen + heutiges Datum aus Deskriptoren + Signalen (ein now pro Zyklus).
  const { rows, today } = useMemo(() => {
    const now = new Date();
    const todayIso = format(now, 'yyyy-MM-dd');
    const built: CockpitRow[] = COCKPIT_SOURCES.map((def) => {
      const signal = signals?.[def.id] ?? { latestDataDate: null };
      const result = computeSourceStatus(def, signal, now);
      return { def, signal, result };
    });
    return { rows: built, today: todayIso };
  }, [signals]);

  const importRows = useMemo(() => buildImportRows(rows), [rows]);
  const controlRows = useMemo(() => buildControlRows(rows, today, manualChecks), [rows, today, manualChecks]);

  const selectedRow = useMemo(
    () => (selectedId ? rows.find((r) => r.def.id === selectedId) ?? null : null),
    [rows, selectedId],
  );

  // Kontrollen manuell als „heute erledigt" markieren. NUR Kontrollen (section
  // 'control') — echte Datenimporte werden hier defensiv ignoriert. Persistiert
  // best-effort (localStorage + KV-Backup) und bestätigt per Toast.
  const handleMarkDone = useCallback(
    (ids: CockpitSourceId[]) => {
      const idSet = new Set(ids);
      const controls = rows
        .filter((r) => r.def.section === 'control' && idSet.has(r.def.id))
        .map((r) => ({ id: r.def.id, interval: r.def.interval }));
      if (controls.length === 0) return;
      const nextMap = markControlsDone(manualChecks, controls, today);
      setManualChecks(nextMap);
      void saveManualChecks(tenantId, nextMap);
      toast({
        title: `${controls.length} ${controls.length === 1 ? 'Eintrag' : 'Einträge'} als erledigt markiert`,
        description: 'Die nächste Fälligkeit wurde anhand des Rhythmus neu berechnet.',
      });
    },
    [rows, manualChecks, today, tenantId, toast],
  );

  if (!allowed) return <Navigate to="/" replace />;

  const busy = loading || coverageLoading;

  return (
    <TooltipProvider delayDuration={200}>
      <PageShell
        width="default"
        header={
          <PageHeader
            icon={<ClipboardCheck />}
            title="Import-Checkliste"
            info="Offene Import-Aufgaben pro Monat, Frische-Status der Datenquellen und wiederkehrende Kontrollen. Nur Ansicht — Importe laufen über die bestehenden Import-Seiten."
            meta={tenant ? tenant.name : undefined}
            actions={
              <>
                {lastRefresh && (
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    Stand: {format(lastRefresh, 'dd.MM.yyyy HH:mm', { locale: de })}
                  </span>
                )}
                <Button variant="outline" size="sm" onClick={refreshAll} disabled={busy}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  Aktualisieren
                </Button>
              </>
            }
          />
        }
      >
        <Tabs defaultValue="checklist" className="space-y-4">
          <TabsList>
            <TabsTrigger value="checklist" className="gap-1.5">
              <ListChecks className="h-4 w-4" /> Checkliste
            </TabsTrigger>
            <TabsTrigger value="imports" className="gap-1.5">
              <Table2 className="h-4 w-4" /> Status
            </TabsTrigger>
            <TabsTrigger value="controls" className="gap-1.5">
              <ShieldCheck className="h-4 w-4" /> Kontrollen
            </TabsTrigger>
          </TabsList>

          <TabsContent value="checklist" className="mt-0">
            <ImportChecklistTab
              year={period.year}
              month={period.month}
              today={today}
              coverage={coverage}
              loading={coverageLoading}
              onPeriodChange={(year, month) => setPeriod({ year, month })}
              monthProgress={monthProgressMap}
              monthProgressLoading={monthProgressLoading}
              onLoadYearProgress={(y) => void loadYearProgress(y, today)}
            />
          </TabsContent>

          <TabsContent value="imports" className="mt-0">
            <DataImportsTab importRows={importRows} onSelect={setSelectedId} />
          </TabsContent>

          <TabsContent value="controls" className="mt-0">
            <ControlsTab controlRows={controlRows} onSelect={setSelectedId} onMarkDone={handleMarkDone} />
          </TabsContent>
        </Tabs>

        <CockpitDetailDrawer
          row={selectedRow}
          today={today}
          onClose={() => setSelectedId(null)}
          completion={selectedId ? manualChecks[selectedId] ?? null : null}
        />
      </PageShell>
    </TooltipProvider>
  );
}
