/**
 * ImportCockpitPage — Read-only Admin-Übersicht „Import-Cockpit" (3 Tabs).
 * =======================================================================
 * Gliedert die Datenpflege in drei Sichten:
 *   1. „Datenimporte" — echte Datei-/Erfassungs-Importe mit Frische-Status.
 *   2. „Kontrollen"   — wiederkehrende organisatorische Checks (Dienstplan,
 *                       Forecast, Monatsabschluss …) mit Fälligkeits-Status.
 *   3. „Aufgaben"     — aggregierte OFFENE Punkte aus beiden Sektionen, nach
 *                       Zeithorizont gruppiert und priorisiert.
 *
 * STRIKT READ-ONLY: keine Schreibaktionen, keine Migration, keine Änderung an
 * Importprozessen — die Seite liest nur bestehende Signale über
 * `fetchCockpitSignals` und leitet daraus reine Anzeige-Zustände ab.
 *
 * Zugriff: nur Admin und KEINE Gast-Session (isAdmin && !isGuest). Das Gate
 * greift auf dem Render-Pfad (Navigate) UND im Lade-Effekt (kein Fetch für
 * Gäste), zusätzlich zur Route-Guard in App.tsx.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { ClipboardCheck, RefreshCw, Loader2, Table2, ShieldCheck, ListTodo } from 'lucide-react';
import { usePermissions } from '@/hooks/usePermissions';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { useTenant } from '@/contexts/TenantContext';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  COCKPIT_SOURCES,
  computeSourceStatus,
  type CockpitRow,
  type CockpitSignal,
  type CockpitSourceId,
} from '@/lib/import-cockpit';
import { buildImportRows, buildControlRows } from '@/lib/import-cockpit-tabs';
import { fetchCockpitSignals } from '@/lib/import-cockpit-db';
import { markControlsDone, type ManualCompletionMap } from '@/lib/import-cockpit-checks';
import { loadManualChecks, saveManualChecks } from '@/lib/import-cockpit-checks-db';
import { useToast } from '@/hooks/use-toast';
import { DataImportsTab } from '@/components/import-cockpit/DataImportsTab';
import { ControlsTab } from '@/components/import-cockpit/ControlsTab';
import { TasksTab } from '@/components/import-cockpit/TasksTab';
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

  useEffect(() => {
    load();
  }, [load]);

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

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-background">
        {/* Kopf */}
        <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-3">
              <ClipboardCheck className="h-5 w-5 text-muted-foreground" />
              <div>
                <h1 className="text-base font-bold leading-tight">Import-Cockpit</h1>
                <p className="text-xs text-muted-foreground">
                  Datenimporte, Kontrollen &amp; offene Aufgaben im Überblick (nur Ansicht)
                </p>
              </div>
              {tenant && (
                <span
                  className="hidden items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 sm:inline-flex"
                  style={{
                    backgroundColor: `${tenant.color}18`,
                    color: tenant.color,
                    boxShadow: `inset 0 0 0 1px ${tenant.color}40`,
                  }}
                >
                  {tenant.name}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {lastRefresh && (
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  Stand: {format(lastRefresh, 'dd.MM.yyyy HH:mm', { locale: de })}
                </span>
              )}
              <Button variant="outline" size="sm" onClick={load} disabled={loading}>
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Aktualisieren
              </Button>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
          <Tabs defaultValue="imports" className="space-y-4">
            <TabsList>
              <TabsTrigger value="imports" className="gap-1.5">
                <Table2 className="h-4 w-4" /> Datenimporte
              </TabsTrigger>
              <TabsTrigger value="controls" className="gap-1.5">
                <ShieldCheck className="h-4 w-4" /> Kontrollen
              </TabsTrigger>
              <TabsTrigger value="tasks" className="gap-1.5">
                <ListTodo className="h-4 w-4" /> Aufgaben
              </TabsTrigger>
            </TabsList>

            <TabsContent value="imports" className="mt-0">
              <DataImportsTab importRows={importRows} onSelect={setSelectedId} />
            </TabsContent>

            <TabsContent value="controls" className="mt-0">
              <ControlsTab controlRows={controlRows} onSelect={setSelectedId} onMarkDone={handleMarkDone} />
            </TabsContent>

            <TabsContent value="tasks" className="mt-0">
              <TasksTab
                rows={rows}
                today={today}
                onSelect={setSelectedId}
                completions={manualChecks}
                onMarkDone={handleMarkDone}
              />
            </TabsContent>
          </Tabs>
        </main>

        <CockpitDetailDrawer
          row={selectedRow}
          today={today}
          onClose={() => setSelectedId(null)}
          completion={selectedId ? manualChecks[selectedId] ?? null : null}
        />
      </div>
    </TooltipProvider>
  );
}
