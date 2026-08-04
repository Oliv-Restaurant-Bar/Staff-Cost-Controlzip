/**
 * ImportCockpitPage — ruhiges Import-Cockpit in vier Bereichen.
 * =============================================================
 *   1. «Heute»        — jetzt fällige Import-Aufgaben (nur aktueller Monat)
 *   2. «Diese Woche»  — wöchentliche Aufgaben + wöchentliche Kontrollen
 *   3. «Dieser Monat» — Monats-Fortschritt, alle Aufgaben des gewählten Monats,
 *                       Inventur-Häkchen, monatliche Kontrollen
 *   4. «Datenstand»   — Frische-Status aller Datenquellen (computeSourceStatus,
 *                       SSoT) + jährliche Kontrollen
 *
 * Aufgaben entstehen aus Abdeckung (import-tasks-db) + effektiven Einstellungen
 * (import-settings: Frequenz/Karenz/Ruhetage, Zahnrad-Dialog). Die Seite liest
 * Importdaten nur (fetchCockpitSignals, fetchMonthCoverage); geschrieben werden
 * ausschliesslich die eigenen Cockpit-Blobs: Einstellungen, Inventur-Häkchen
 * und manuelle Kontroll-Erledigungen (Union-Merge + Tombstones + Dirty-Check).
 *
 * Zugriff: nur Admin (isAdmin). Das Gate greift auf dem Render-Pfad (Navigate)
 * UND in den Lade-Effekten, zusätzlich zur Route-Guard in App.tsx.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { ClipboardCheck, RefreshCw, Loader2, Settings2, Table2, ShieldCheck } from 'lucide-react';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { monthKey } from '@/lib/import-tasks-priority';
import { useImportMonthProgress } from '@/hooks/useImportMonthProgress';
import { markControlsDone, type ManualCompletionMap } from '@/lib/import-cockpit-checks';
import { loadManualChecks, saveManualChecks } from '@/lib/import-cockpit-checks-db';
import {
  applyInventurCheck,
  resolveImportSettings,
  type ImportSettingsBlob,
  type InventurChecksBlob,
} from '@/lib/import-settings';
import {
  loadImportSettings,
  loadImportSettingsLocal,
  saveImportSettings,
  loadInventurChecks,
  loadInventurChecksLocal,
  saveInventurChecks,
} from '@/lib/import-settings-db';
import { useToast } from '@/hooks/use-toast';
import { DataImportsTab } from '@/components/import-cockpit/DataImportsTab';
import { ImportChecklistTab, ControlChecklistList } from '@/components/import-cockpit/ImportChecklistTab';
import { ImportSettingsDialog } from '@/components/import-cockpit/ImportSettingsDialog';
import { CockpitDetailDrawer } from '@/components/import-cockpit/CockpitDetailDrawer';

export default function ImportCockpitPage() {
  const { isAdmin } = usePermissions();
  const { tenantId, tenantKey, tenant } = useTenant();
  const { toast } = useToast();
  const allowed = isAdmin;

  const [signals, setSignals] = useState<Record<CockpitSourceId, CockpitSignal> | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [selectedId, setSelectedId] = useState<CockpitSourceId | null>(null);
  const [manualChecks, setManualChecks] = useState<ManualCompletionMap>({});

  // Einstellungen (Frequenz/Karenz/Ruhetage) + Inventur-Häkchen — lokal sofort,
  // Merge mit dem KV-Backup asynchron (localStorage = Primärspeicher, §Regeln).
  const [settingsBlob, setSettingsBlob] = useState<ImportSettingsBlob>(() => loadImportSettingsLocal(tenantId));
  const [inventurBlob, setInventurBlob] = useState<InventurChecksBlob>(() => loadInventurChecksLocal(tenantId));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [inventurSaving, setInventurSaving] = useState(false);

  const effectiveSettings = useMemo(() => resolveImportSettings(settingsBlob), [settingsBlob]);

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
  } = useImportMonthProgress({ allowed, tenantId, tenantKey, settings: effectiveSettings });

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

  // Einstellungen + Inventur-Häkchen laden (lokal sofort, dann KV-Merge).
  useEffect(() => {
    setSettingsBlob(loadImportSettingsLocal(tenantId));
    setInventurBlob(loadInventurChecksLocal(tenantId));
    if (!allowed) return;
    let cancelled = false;
    loadImportSettings(tenantId).then((blob) => {
      if (!cancelled) setSettingsBlob(blob);
    });
    loadInventurChecks(tenantId).then((blob) => {
      if (!cancelled) setInventurBlob(blob);
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

  // Kontrollen nach Rhythmus in die Bereiche einsortieren:
  // wöchentlich → «Diese Woche», monatlich → «Dieser Monat», jährlich → «Datenstand».
  const weeklyControls = useMemo(
    () => controlRows.filter((r) => r.def.interval === 'daily' || r.def.interval === 'weekly'),
    [controlRows],
  );
  const monthlyControls = useMemo(
    () => controlRows.filter((r) => r.def.interval === 'monthly'),
    [controlRows],
  );
  const yearlyControls = useMemo(
    () => controlRows.filter((r) => r.def.interval === 'yearly'),
    [controlRows],
  );

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

  // Einstellungen speichern (Dialog reicht nur bei echter Änderung hierher).
  const handleSaveSettings = useCallback(
    async (next: ImportSettingsBlob) => {
      setSettingsSaving(true);
      try {
        setSettingsBlob(next);
        await saveImportSettings(tenantId, next);
        setSettingsOpen(false);
        toast({ title: 'Import-Einstellungen gespeichert' });
      } finally {
        setSettingsSaving(false);
      }
    },
    [tenantId, toast],
  );

  // Inventur-Häkchen für den ANGEZEIGTEN Monat setzen/entfernen (Dirty-Check
  // in applyInventurCheck; Abdeckung optimistisch nachführen, kein Refetch).
  const handleToggleInventur = useCallback(
    async (done: boolean) => {
      const key = monthKey(period.year, period.month);
      const res = applyInventurCheck(inventurBlob, key, done, new Date().toISOString());
      if (!res.changed) return;
      setInventurSaving(true);
      try {
        setInventurBlob(res.blob);
        setCoverage((prev) => {
          if (!prev) return prev;
          const next: MonthCoverage = { ...prev, inventur: { ...(prev.inventur ?? {}), monthDone: done } };
          seedMonthProgress(period.year, period.month, next, today);
          return next;
        });
        await saveInventurChecks(tenantId, res.blob);
        toast({
          title: done ? 'Inventur als erledigt markiert' : 'Inventur-Häkchen entfernt',
        });
      } finally {
        setInventurSaving(false);
      }
    },
    [inventurBlob, period.year, period.month, tenantId, today, seedMonthProgress, toast],
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
            title="Import-Cockpit"
            info="Was heute, diese Woche und diesen Monat zu tun ist — plus Datenstand aller Quellen. Importe laufen über die bestehenden Import-Seiten; hier wird nichts an Importdaten geschrieben."
            meta={tenant ? tenant.name : undefined}
            actions={
              <>
                {lastRefresh && (
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    Stand: {format(lastRefresh, 'dd.MM.yyyy HH:mm', { locale: de })}
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSettingsOpen(true)}
                  data-testid="cockpit-open-settings"
                >
                  <Settings2 className="mr-2 h-4 w-4" />
                  Einstellungen
                </Button>
                <Button variant="outline" size="sm" onClick={refreshAll} disabled={busy}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  Aktualisieren
                </Button>
              </>
            }
          />
        }
      >
        <div className="space-y-6">
          {/* Bereiche «Heute», «Diese Woche», «Dieser Monat» */}
          <ImportChecklistTab
            year={period.year}
            month={period.month}
            today={today}
            coverage={coverage}
            loading={coverageLoading}
            settings={effectiveSettings}
            onPeriodChange={(year, month) => setPeriod({ year, month })}
            monthProgress={monthProgressMap}
            monthProgressLoading={monthProgressLoading}
            onLoadYearProgress={(y) => void loadYearProgress(y, today)}
            weeklyControls={weeklyControls}
            monthlyControls={monthlyControls}
            onSelectControl={setSelectedId}
            onMarkControlDone={handleMarkDone}
            onToggleInventur={(done) => void handleToggleInventur(done)}
            inventurSaving={inventurSaving}
          />

          {/* Bereich «Datenstand» */}
          <section className="space-y-2" data-testid="cockpit-section-datenstand">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Table2 className="h-4 w-4 text-muted-foreground" aria-hidden />
              Datenstand
            </h2>
            <DataImportsTab importRows={importRows} onSelect={setSelectedId} />
            {yearlyControls.length > 0 && (
              <Card data-testid="cockpit-yearly-controls">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
                    Jährliche Kontrollen
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <ControlChecklistList
                    rows={yearlyControls}
                    onSelect={setSelectedId}
                    onMarkDone={handleMarkDone}
                  />
                </CardContent>
              </Card>
            )}
          </section>
        </div>

        <ImportSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          blob={settingsBlob}
          saving={settingsSaving}
          onSave={(next) => void handleSaveSettings(next)}
        />

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
