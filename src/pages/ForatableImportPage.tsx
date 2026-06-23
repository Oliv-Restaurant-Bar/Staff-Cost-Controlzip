/**
 * ForatableImportPage — gebündelte Foratable-Importe
 * ===================================================
 * Fasst die beiden Foratable-Importe unter einer Route (`/foratable-import`)
 * mit Reitern zusammen:
 *  - „Reservationen": ReservationenImportPage (eingebettet)
 *  - „Gäste / CRM":   GaesteImportPage (eingebettet)
 *  - „Import-Verlauf": gemeinsame, DB-gestützte Import-Historie (beide Typen)
 *
 * Der aktive Reiter wird über den Query-Parameter `?tab=` gesteuert
 * (`reservationen` = Standard, `gaeste`, `verlauf`), damit Altlinks/Redirects
 * gezielt auf den richtigen Reiter zeigen. Die beiden Import-Seiten bleiben
 * dauerhaft gemountet (`forceMount`), damit der jeweilige Upload-/Wizard-Zustand
 * beim Reiterwechsel erhalten bleibt; der inaktive Reiter wird nur per CSS
 * ausgeblendet.
 *
 * Oberhalb der Reiter steht eine kompakte „Letzter Import"-Anzeige je Typ
 * (Zeitstempel kommt aus der DB, nicht aus dem Browserzustand).
 *
 * Admin-only (Gast-Sessions werden umgeleitet). Es werden ausschliesslich
 * Aggregat-Kennzahlen angezeigt — keine personenbezogenen Gästedaten.
 */

import { useCallback, useEffect, useState } from 'react';
import { Navigate, Link, useSearchParams } from 'react-router-dom';
import {
  Upload, Users, CalendarRange, Contact, History, Clock, FileText,
  CheckCircle2, XCircle, Loader2, Database,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/hooks/usePermissions';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { useTenant } from '@/contexts/TenantContext';
import ReservationenImportPage from './ReservationenImportPage';
import GaesteImportPage from './GaesteImportPage';
import {
  fetchImportRuns, fetchLatestImportRuns, checkImportRunsTableExist,
} from '@/lib/import-runs-db';
import {
  IMPORT_TYPE_LABEL, runStatChips,
  type ImportRunRow, type ImportRunType,
} from '@/lib/import-runs';

type ImportTab = 'reservationen' | 'gaeste' | 'verlauf';
type HistoryFilter = 'alle' | ImportRunType;

function fmtTs(ts: string | null): string {
  if (!ts) return '—';
  try {
    return fmtDate(parseISO(ts), 'dd.MM.yyyy HH:mm', { locale: de });
  } catch {
    return '—';
  }
}

function fmtPeriod(from: string | null, to: string | null): string {
  if (!from) return '—';
  const f = (d: string) => {
    try { return fmtDate(parseISO(d), 'dd.MM.yy', { locale: de }); } catch { return d; }
  };
  return to && to !== from ? `${f(from)} – ${f(to)}` : f(from);
}

// ── „Letzter Import"-Karte ───────────────────────────────────────────────────

function LastImportCard({
  icon: Icon, label, run,
}: {
  icon: React.FC<{ className?: string }>;
  label: string;
  run: ImportRunRow | null;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      {run ? (
        <div className="mt-1.5 space-y-0.5">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            {fmtTs(run.finished_at)}
            {run.status === 'failed' && (
              <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 text-xs font-medium">
                <XCircle className="h-3.5 w-3.5" /> fehlgeschlagen
              </span>
            )}
          </div>
          {run.file_name && (
            <p className="text-xs text-muted-foreground truncate" title={run.file_name}>
              {run.file_name}
            </p>
          )}
          {typeof run.record_count === 'number' && (
            <p className="text-xs text-muted-foreground">
              {run.record_count} Datensätze
            </p>
          )}
        </div>
      ) : (
        <p className="mt-1.5 text-sm text-muted-foreground">Noch kein Import</p>
      )}
    </div>
  );
}

// ── Komponente ───────────────────────────────────────────────────────────────

export default function ForatableImportPage() {
  const { isAdmin } = usePermissions();
  const { isGuest } = useGuestSession();
  const { tenantId } = useTenant();
  const [searchParams, setSearchParams] = useSearchParams();

  const [latest, setLatest] = useState<Record<ImportRunType, ImportRunRow | null>>({
    reservations: null, guest_export: null,
  });
  const [history, setHistory] = useState<ImportRunRow[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [filter, setFilter] = useState<HistoryFilter>('alle');
  const [tableOk, setTableOk] = useState<boolean | null>(null);

  const tab: ImportTab =
    searchParams.get('tab') === 'gaeste' ? 'gaeste'
      : searchParams.get('tab') === 'verlauf' ? 'verlauf'
        : 'reservationen';

  const refreshLatest = useCallback(() => {
    fetchLatestImportRuns(tenantId).then(setLatest).catch(() => {});
  }, [tenantId]);

  const loadHistory = useCallback(async () => {
    setHistLoading(true);
    const rows = await fetchImportRuns(tenantId, { limit: 200 });
    setHistory(rows);
    setHistLoading(false);
  }, [tenantId]);

  useEffect(() => {
    checkImportRunsTableExist().then(setTableOk);
    refreshLatest();
  }, [refreshLatest]);

  // Verlauf laden, sobald der Reiter aktiv ist — auch bei direktem Aufruf via ?tab=verlauf.
  useEffect(() => {
    if (tab === 'verlauf') { loadHistory(); refreshLatest(); }
  }, [tab, loadHistory, refreshLatest]);

  // usePermissions().isAdmin schliesst Gäste ein — daher hier explizit ausschliessen.
  if (!isAdmin || isGuest) return <Navigate to="/" replace />;

  const setTab = (t: ImportTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', t);
    setSearchParams(next, { replace: true });
  };

  const onImported = () => { refreshLatest(); if (tab === 'verlauf') loadHistory(); };

  const filtered = filter === 'alle'
    ? history
    : history.filter(h => h.import_type === filter);

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6 space-y-5">
      {/* Kopf */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Upload className="h-6 w-6 text-primary" />
            Foratable Import
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Foratable-Exporte importieren — Reservationen für Gäste- und
            Auslastungsanalysen sowie den Gästeexport zur CRM-Anreicherung.
          </p>
        </div>
        <Link
          to="/gaeste"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted/60"
        >
          <Users className="h-4 w-4" />
          Zum Gäste-CRM
        </Link>
      </div>

      {/* „Letzter Import"-Anzeige (DB-Zeitstempel) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <LastImportCard icon={CalendarRange} label="Letzter Reservationen-Import" run={latest.reservations} />
        <LastImportCard icon={Contact} label="Letzter Gästeimport" run={latest.guest_export} />
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as ImportTab)}>
        <TabsList>
          <TabsTrigger value="reservationen" className="gap-1.5">
            <CalendarRange className="h-4 w-4" />
            Reservationen
          </TabsTrigger>
          <TabsTrigger value="gaeste" className="gap-1.5">
            <Contact className="h-4 w-4" />
            Gäste / CRM
          </TabsTrigger>
          <TabsTrigger value="verlauf" className="gap-1.5">
            <History className="h-4 w-4" />
            Import-Verlauf
          </TabsTrigger>
        </TabsList>

        <TabsContent value="reservationen" forceMount className={cn('mt-4', tab !== 'reservationen' && 'hidden')}>
          <ReservationenImportPage embedded onImported={onImported} />
        </TabsContent>
        <TabsContent value="gaeste" forceMount className={cn('mt-4', tab !== 'gaeste' && 'hidden')}>
          <GaesteImportPage embedded onImported={onImported} />
        </TabsContent>

        <TabsContent value="verlauf" className="mt-4">
          {tableOk === false && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 p-4 flex gap-3 mb-4">
              <Database className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-semibold text-amber-800 dark:text-amber-300">Tabelle für die Import-Historie fehlt</p>
                <p className="mt-1 text-amber-700 dark:text-amber-400">
                  Bitte das Migrationsskript{' '}
                  <code className="rounded bg-amber-100 dark:bg-amber-900/50 px-1 py-0.5 text-xs">
                    supabase/migrations/20260623_import_runs.sql
                  </code>{' '}
                  im Supabase SQL-Editor ausführen und die Seite neu laden.
                </p>
              </div>
            </div>
          )}

          {/* Filter */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            {([['alle', 'Alle'], ['reservations', 'Reservationen'], ['guest_export', 'Gästeexport']] as Array<[HistoryFilter, string]>).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  filter === key
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted/60',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {histLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-10 text-center text-muted-foreground">
              <FileText className="h-8 w-8 mx-auto mb-2" />
              Noch keine Importe vorhanden.
            </div>
          ) : (
            <div className="max-h-[70vh] overflow-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted [&_th]:border-b [&_th]:border-border">
                  <tr>
                    <th className="px-3 py-2 font-medium">Typ</th>
                    <th className="px-3 py-2 font-medium">Datei</th>
                    <th className="px-3 py-2 font-medium">Zeitraum</th>
                    <th className="px-3 py-2 font-medium text-right">Datensätze</th>
                    <th className="px-3 py-2 font-medium">Kennzahlen</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Zeitpunkt</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map(h => (
                    <tr key={h.id} className="hover:bg-muted/30 align-top">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 text-xs font-medium">
                          {h.import_type === 'reservations'
                            ? <CalendarRange className="h-3.5 w-3.5 text-muted-foreground" />
                            : <Contact className="h-3.5 w-3.5 text-muted-foreground" />}
                          {IMPORT_TYPE_LABEL[h.import_type]}
                        </span>
                      </td>
                      <td className="px-3 py-2 max-w-[180px] truncate" title={h.file_name ?? ''}>
                        {h.file_name ?? '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground text-xs">
                        {fmtPeriod(h.period_from, h.period_to)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{h.record_count ?? '—'}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {runStatChips(h).map((c, i) => (
                            <span
                              key={i}
                              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                            >
                              <span className="font-medium tabular-nums">{c.value}</span>
                              {c.label}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {h.status === 'success' ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Erfolg
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 text-xs font-medium"
                            title={h.error_message ?? ''}
                          >
                            <XCircle className="h-3.5 w-3.5" /> Fehler
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground text-xs">
                        {fmtTs(h.finished_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
