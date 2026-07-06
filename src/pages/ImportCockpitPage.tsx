/**
 * ImportCockpitPage — Read-only Admin-Übersicht „Import-Cockpit".
 * ==============================================================
 * Zeigt je Datenquelle den Frische-/Import-Status (Übersichtstabelle,
 * KPI-Kacheln, Checklisten-Ansicht, Filter, Detail-Drawer). STRIKT READ-ONLY:
 * keine Schreibaktionen, keine Migration, keine Änderung an Importprozessen —
 * die Seite liest nur bestehende Tabellen/Speicher über `fetchCockpitSignals`.
 *
 * Zugriff: nur Admin und KEINE Gast-Session (isAdmin && !isGuest). Das Gate
 * greift auf dem Render-Pfad (Navigate) UND im Lade-Effekt (kein Fetch für
 * Gäste), zusätzlich zur Route-Guard in App.tsx.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  ClipboardCheck,
  RefreshCw,
  Search,
  CheckCircle2,
  Clock,
  AlertTriangle,
  HelpCircle,
  CalendarClock,
  ArrowRight,
  Loader2,
  Globe,
  ListChecks,
  Table2,
  XCircle,
  UploadCloud,
  Info,
} from 'lucide-react';
import { usePermissions } from '@/hooks/usePermissions';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { useTenant } from '@/contexts/TenantContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  COCKPIT_SOURCES,
  computeSourceStatus,
  summarizeCockpit,
  groupChecklist,
  formatCockpitDate,
  rowMatchesFilters,
  EMPTY_COCKPIT_FILTER,
  INTERVAL_LABEL,
  CHECKLIST_GROUP_LABEL,
  STATUS_LABEL,
  STATUS_BADGE_CLASS,
  STATUS_DOT_CLASS,
  STATUS_HINT,
  CHECKLIST_LABEL,
  CHECKLIST_BADGE_CLASS,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  IMPORT_TYPE_LABEL,
  IMPORT_TYPE_ORDER,
  IMPORT_TYPE_BADGE_CLASS,
  type CockpitRow,
  type CockpitSignal,
  type CockpitSourceId,
  type CockpitFilterState,
  type CockpitCategory,
  type CockpitImportType,
  type CockpitStatus,
  type ImportInterval,
} from '@/lib/import-cockpit';
import { fetchCockpitSignals } from '@/lib/import-cockpit-db';

// ─── Filter ──────────────────────────────────────────────────────────────────────

/** Filter-Dropdown-Optionen (jeweils mit „Alle" als erste Option). */
const INTERVAL_FILTER_OPTIONS: Array<{ value: 'all' | ImportInterval; label: string }> = [
  { value: 'all', label: 'Alle Intervalle' },
  ...(['daily', 'weekly', 'monthly', 'yearly'] as ImportInterval[]).map((i) => ({
    value: i,
    label: INTERVAL_LABEL[i],
  })),
];

const STATUS_FILTER_ORDER: CockpitStatus[] = ['current', 'due_soon', 'overdue', 'never', 'uncheckable'];
const STATUS_FILTER_OPTIONS: Array<{ value: 'all' | CockpitStatus; label: string }> = [
  { value: 'all', label: 'Alle Status' },
  ...STATUS_FILTER_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
];

const CATEGORY_FILTER_OPTIONS: Array<{ value: 'all' | CockpitCategory; label: string }> = [
  { value: 'all', label: 'Alle Kategorien' },
  ...CATEGORY_ORDER.map((c) => ({ value: c, label: CATEGORY_LABEL[c] })),
];

const IMPORT_TYPE_FILTER_OPTIONS: Array<{ value: 'all' | CockpitImportType; label: string }> = [
  { value: 'all', label: 'Alle Import-Arten' },
  ...IMPORT_TYPE_ORDER.map((t) => ({ value: t, label: IMPORT_TYPE_LABEL[t] })),
];

// ─── Datums-Helfer (nur Anzeige) ───────────────────────────────────────────────────

function formatDateTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    const d = parseISO(ts);
    return Number.isNaN(d.getTime()) ? '—' : format(d, 'dd.MM.yyyy HH:mm', { locale: de });
  } catch {
    return '—';
  }
}

function dataUntilOf(signal: CockpitSignal): string | null {
  return signal.dataUntil ?? signal.latestDataDate ?? null;
}

/**
 * Hinweis, welche Daten je Quelle für die Vollständigkeit zählen (Drawer).
 * Reiner Anzeigetext — keine Prozesslogik.
 */
const COMPLETENESS_NOTE: Partial<Record<CockpitSourceId, string>> = {
  mirus:
    'Für Mirus zählen nur echte Ist-Arbeitszeiten mit Arbeitsdauer oder Start-/Endzeit. Ferien, freie Tage, Plan-Schichten und Zukunftszeilen werden nicht als vollständiger Import gewertet.',
  tagesumsatz:
    'Es zählen nur Tage mit echtem Ist-Umsatz (> 0). Zukünftige Tage werden nicht als vollständiger Import gewertet.',
};

// ─── KPI-Kachel ────────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: number;
  icon: React.ReactNode;
  accent: string;
}

function KpiCard({ label, value, icon, accent }: KpiCardProps) {
  return (
    <Card className="border-border/70">
      <CardContent className="flex items-center gap-3 p-4">
        <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', accent)}>{icon}</div>
        <div className="min-w-0">
          <div className="text-2xl font-bold leading-none tabular-nums">{value}</div>
          <div className="mt-1 truncate text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Status-Badge ────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: CockpitStatus }) {
  const badge = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        STATUS_BADGE_CLASS[status],
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT_CLASS[status])} />
      {STATUS_LABEL[status]}
    </span>
  );

  const hint = STATUS_HINT[status];
  if (!hint) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">{badge}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-snug">{hint}</TooltipContent>
    </Tooltip>
  );
}

/** Kleines Import-Art-Badge (unabhängig von den Status-Farben). */
function ImportTypeBadge({ type }: { type: CockpitImportType }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        IMPORT_TYPE_BADGE_CLASS[type],
      )}
    >
      {IMPORT_TYPE_LABEL[type]}
    </span>
  );
}

// ─── Hauptseite ────────────────────────────────────────────────────────────────────

export default function ImportCockpitPage() {
  const { isAdmin } = usePermissions();
  const { isGuest } = useGuestSession();
  const { tenantId, tenantKey, tenant } = useTenant();
  const allowed = isAdmin && !isGuest;

  const [signals, setSignals] = useState<Record<CockpitSourceId, CockpitSignal> | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [filters, setFilters] = useState<CockpitFilterState>(EMPTY_COCKPIT_FILTER);
  const [selectedId, setSelectedId] = useState<CockpitSourceId | null>(null);

  const patchFilter = useCallback(
    <K extends keyof CockpitFilterState>(key: K, value: CockpitFilterState[K]) =>
      setFilters((prev) => ({ ...prev, [key]: value })),
    [],
  );
  const resetFilters = useCallback(() => setFilters(EMPTY_COCKPIT_FILTER), []);
  const hasActiveFilters =
    filters.category !== 'all' ||
    filters.importType !== 'all' ||
    filters.interval !== 'all' ||
    filters.status !== 'all' ||
    filters.search.trim() !== '';

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

  // Statuszeilen aus Deskriptoren + Signalen (ein now pro Render-Zyklus).
  const rows = useMemo<CockpitRow[]>(() => {
    const now = new Date();
    return COCKPIT_SOURCES.map((def) => {
      const signal = signals?.[def.id] ?? { latestDataDate: null };
      const result = computeSourceStatus(def, signal, now);
      return { def, signal, result };
    });
  }, [signals]);

  const kpis = useMemo(() => summarizeCockpit(rows), [rows]);
  const checklist = useMemo(() => groupChecklist(rows), [rows]);

  const filteredRows = useMemo(
    () => rows.filter((r) => rowMatchesFilters(r, filters)),
    [rows, filters],
  );

  // Übersichtstabelle nach Kategorie gruppiert (stabile CATEGORY_ORDER).
  const groupedRows = useMemo(() => {
    const byCategory = new Map<CockpitCategory, CockpitRow[]>();
    for (const r of filteredRows) {
      const list = byCategory.get(r.def.category);
      if (list) list.push(r);
      else byCategory.set(r.def.category, [r]);
    }
    return CATEGORY_ORDER
      .map((category) => ({ category, rows: byCategory.get(category) ?? [] }))
      .filter((g) => g.rows.length > 0);
  }, [filteredRows]);

  // Sichtbare IDs, damit die Checklisten-Ansicht dieselben Filter respektiert.
  const visibleIds = useMemo(
    () => new Set<CockpitSourceId>(filteredRows.map((r) => r.def.id)),
    [filteredRows],
  );

  const selectedRow = useMemo(
    () => (selectedId ? rows.find((r) => r.def.id === selectedId) ?? null : null),
    [rows, selectedId],
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
                  Frische &amp; Fälligkeit aller Datenimporte im Überblick (nur Ansicht)
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

        <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
          {/* KPI-Kacheln */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <KpiCard
              label="Aktuell"
              value={kpis.current}
              icon={<CheckCircle2 className="h-5 w-5 text-emerald-600" />}
              accent="bg-emerald-100 dark:bg-emerald-950/40"
            />
            <KpiCard
              label="Bald fällig"
              value={kpis.dueSoon}
              icon={<Clock className="h-5 w-5 text-amber-600" />}
              accent="bg-amber-100 dark:bg-amber-950/40"
            />
            <KpiCard
              label="Überfällig"
              value={kpis.overdue}
              icon={<AlertTriangle className="h-5 w-5 text-red-600" />}
              accent="bg-red-100 dark:bg-red-950/40"
            />
            <KpiCard
              label="Nicht prüfbar"
              value={kpis.uncheckable}
              icon={<HelpCircle className="h-5 w-5 text-muted-foreground" />}
              accent="bg-muted"
            />
            <KpiCard
              label="Datenlücken"
              value={kpis.dataGaps}
              icon={<CalendarClock className="h-5 w-5 text-amber-600" />}
              accent="bg-amber-100 dark:bg-amber-950/40"
            />
          </div>

          <Tabs defaultValue="overview" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <TabsList>
                <TabsTrigger value="overview" className="gap-1.5">
                  <Table2 className="h-4 w-4" /> Übersicht
                </TabsTrigger>
                <TabsTrigger value="checklist" className="gap-1.5">
                  <ListChecks className="h-4 w-4" /> Checkliste
                </TabsTrigger>
              </TabsList>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={filters.search}
                    onChange={(e) => patchFilter('search', e.target.value)}
                    placeholder="Suchen…"
                    className="h-9 w-40 pl-8"
                  />
                </div>
                <Select
                  value={filters.category}
                  onValueChange={(v) => patchFilter('category', v as CockpitFilterState['category'])}
                >
                  <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORY_FILTER_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={filters.importType}
                  onValueChange={(v) => patchFilter('importType', v as CockpitFilterState['importType'])}
                >
                  <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {IMPORT_TYPE_FILTER_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={filters.interval}
                  onValueChange={(v) => patchFilter('interval', v as CockpitFilterState['interval'])}
                >
                  <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {INTERVAL_FILTER_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={filters.status}
                  onValueChange={(v) => patchFilter('status', v as CockpitFilterState['status'])}
                >
                  <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUS_FILTER_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {hasActiveFilters && (
                  <Button variant="ghost" size="sm" className="h-9" onClick={resetFilters}>
                    Filter zurücksetzen
                  </Button>
                )}
              </div>
            </div>

            {/* Übersichtstabelle */}
            <TabsContent value="overview" className="mt-0">
              <Card>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Datenquelle</TableHead>
                          <TableHead className="hidden lg:table-cell">Was hochladen?</TableHead>
                          <TableHead className="hidden md:table-cell">Import-Art</TableHead>
                          <TableHead className="hidden xl:table-cell">Letzter Import</TableHead>
                          <TableHead>Ist-Daten bis</TableHead>
                          <TableHead className="hidden sm:table-cell">Intervall</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="hidden lg:table-cell">Nächste Fälligkeit</TableHead>
                          <TableHead className="text-right">Aktion</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {groupedRows.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                              Keine Datenquellen für diesen Filter.
                            </TableCell>
                          </TableRow>
                        )}
                        {groupedRows.map((group) => (
                          <Fragment key={group.category}>
                            <TableRow className="bg-muted/50 hover:bg-muted/50">
                              <TableCell
                                colSpan={9}
                                className="py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                              >
                                {CATEGORY_LABEL[group.category]}
                                <span className="ml-2 font-normal normal-case">({group.rows.length})</span>
                              </TableCell>
                            </TableRow>
                            {group.rows.map((row) => (
                              <TableRow
                                key={row.def.id}
                                className="cursor-pointer"
                                onClick={() => setSelectedId(row.def.id)}
                              >
                                <TableCell className="font-medium">
                                  <div className="flex items-center gap-1.5">
                                    {row.def.label}
                                    {row.def.tenantNeutral && (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                                        </TooltipTrigger>
                                        <TooltipContent>Mandantenübergreifende Datenquelle</TooltipContent>
                                      </Tooltip>
                                    )}
                                    {row.result.failed && (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <XCircle className="h-3.5 w-3.5 text-red-500" />
                                        </TooltipTrigger>
                                        <TooltipContent>Letzter Import fehlgeschlagen</TooltipContent>
                                      </Tooltip>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="hidden max-w-[16rem] text-muted-foreground lg:table-cell">
                                  <span className="line-clamp-2">{row.def.uploadLabel}</span>
                                </TableCell>
                                <TableCell className="hidden md:table-cell">
                                  <ImportTypeBadge type={row.def.importType} />
                                </TableCell>
                                <TableCell className="hidden text-muted-foreground xl:table-cell">
                                  {formatDateTime(row.signal.lastImport?.at)}
                                </TableCell>
                                <TableCell>{formatCockpitDate(dataUntilOf(row.signal))}</TableCell>
                                <TableCell className="hidden sm:table-cell">
                                  <Badge variant="outline" className="font-normal">
                                    {INTERVAL_LABEL[row.def.interval]}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <StatusBadge status={row.result.status} />
                                </TableCell>
                                <TableCell className="hidden text-muted-foreground lg:table-cell">
                                  {row.result.nextDue ? formatCockpitDate(row.result.nextDue) : '—'}
                                </TableCell>
                                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setSelectedId(row.def.id)}
                                  >
                                    Details <ArrowRight className="ml-1 h-3.5 w-3.5" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                          </Fragment>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Checkliste */}
            <TabsContent value="checklist" className="mt-0">
              <div className="grid gap-4 md:grid-cols-2">
                {(['daily', 'weekly', 'monthly', 'yearly'] as ImportInterval[]).map((interval) => {
                  // Checkliste respektiert dieselben Filter wie die Tabelle (über visibleIds).
                  const items = checklist[interval].filter((i) => visibleIds.has(i.id));
                  return (
                    <Card key={interval}>
                      <CardContent className="p-4">
                        <div className="mb-3 flex items-center justify-between">
                          <h3 className="text-sm font-semibold">{CHECKLIST_GROUP_LABEL[interval]}</h3>
                          <Badge variant="outline" className="font-normal">
                            {INTERVAL_LABEL[interval]}
                          </Badge>
                        </div>
                        <ul className="space-y-1.5">
                          {items.length === 0 && (
                            <li className="py-2 text-sm text-muted-foreground">Keine Einträge.</li>
                          )}
                          {items.map((item) => (
                            <li key={item.id}>
                              <button
                                type="button"
                                onClick={() => setSelectedId(item.id)}
                                className="flex w-full items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                              >
                                <span className="min-w-0 space-y-0.5">
                                  <span className="block truncate font-medium">{item.label}</span>
                                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    {item.importType === 'file_upload' ? (
                                      <UploadCloud className="h-3 w-3 shrink-0" />
                                    ) : (
                                      <Info className="h-3 w-3 shrink-0" />
                                    )}
                                    <span className="truncate">{item.uploadLabel}</span>
                                  </span>
                                </span>
                                <span
                                  className={cn(
                                    'mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium',
                                    CHECKLIST_BADGE_CLASS[item.state],
                                  )}
                                >
                                  {CHECKLIST_LABEL[item.state]}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </TabsContent>
          </Tabs>
        </main>

        {/* Detail-Drawer */}
        <Sheet open={!!selectedRow} onOpenChange={(open) => !open && setSelectedId(null)}>
          <SheetContent className="w-full overflow-y-auto sm:max-w-md">
            {selectedRow && (
              <>
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2">
                    {selectedRow.def.label}
                    {selectedRow.def.tenantNeutral && <Globe className="h-4 w-4 text-muted-foreground" />}
                  </SheetTitle>
                  <SheetDescription>{selectedRow.def.description}</SheetDescription>
                </SheetHeader>

                <div className="mt-5 space-y-4 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Status</span>
                    <StatusBadge status={selectedRow.result.status} />
                  </div>
                  {selectedRow.result.reason && (
                    <p className="rounded-md bg-muted/60 p-2.5 text-xs text-muted-foreground">
                      {selectedRow.result.reason}
                    </p>
                  )}

                  {/* Was hochladen? — prominent hervorgehoben */}
                  <div className="rounded-md border border-border bg-muted/40 p-3">
                    <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      {selectedRow.def.importType === 'file_upload' ? (
                        <UploadCloud className="h-4 w-4" />
                      ) : (
                        <Info className="h-4 w-4" />
                      )}
                      Was hochladen?
                    </div>
                    <p className="text-sm text-muted-foreground">{selectedRow.def.uploadLabel}</p>
                    <div className="mt-2">
                      <ImportTypeBadge type={selectedRow.def.importType} />
                    </div>
                  </div>

                  <dl className="divide-y divide-border rounded-md border border-border">
                    <DetailRow label="Kategorie" value={CATEGORY_LABEL[selectedRow.def.category]} />
                    <DetailRow label="Bereich" value={selectedRow.def.module} />
                    <DetailRow label="Import-Art" value={IMPORT_TYPE_LABEL[selectedRow.def.importType]} />
                    {selectedRow.def.sourceHint && (
                      <DetailRow label="Quelle" value={selectedRow.def.sourceHint} />
                    )}
                    {selectedRow.def.exampleFormat && (
                      <DetailRow label="Beispiel-Format" value={selectedRow.def.exampleFormat} />
                    )}
                    <DetailRow label="Empfohlener Rhythmus" value={INTERVAL_LABEL[selectedRow.def.interval]} />
                    <DetailRow label="Letzter Import" value={formatDateTime(selectedRow.signal.lastImport?.at)} />
                    <DetailRow
                      label="Daten von"
                      value={formatCockpitDate(selectedRow.signal.dataFrom)}
                    />
                    <DetailRow label="Ist-Daten bis" value={formatCockpitDate(dataUntilOf(selectedRow.signal))} />
                    {selectedRow.def.detectGaps && (
                      <DetailRow
                        label="Vollständig importiert bis"
                        value={formatCockpitDate(selectedRow.result.completeUntil)}
                      />
                    )}
                    <DetailRow
                      label="Nächste Fälligkeit"
                      value={selectedRow.result.nextDue ? formatCockpitDate(selectedRow.result.nextDue) : '—'}
                    />
                    {typeof selectedRow.signal.recordCount === 'number' && (
                      <DetailRow label="Datensätze" value={String(selectedRow.signal.recordCount)} />
                    )}
                    {typeof selectedRow.result.daysBehind === 'number' && (
                      <DetailRow label="Tage hinter Plan" value={String(selectedRow.result.daysBehind)} />
                    )}
                  </dl>

                  {selectedRow.result.missingDays.length > 0 && (
                    <div>
                      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                        <CalendarClock className="h-4 w-4" />
                        Fehlende Tage ({selectedRow.result.missingDays.length})
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedRow.result.missingDays.map((d) => (
                          <span
                            key={d}
                            className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                          >
                            {formatCockpitDate(d)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedRow.result.ignoredFutureDate && (
                    <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                      <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        Zukunftszeilen bis {formatCockpitDate(selectedRow.result.ignoredFutureDate)} gefunden — diese
                        werden für die Vollständigkeit nicht berücksichtigt.
                      </span>
                    </p>
                  )}

                  {COMPLETENESS_NOTE[selectedRow.def.id] && (
                    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {COMPLETENESS_NOTE[selectedRow.def.id]}
                    </p>
                  )}

                  {selectedRow.def.tenantNeutral && (
                    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                      <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      Diese Datenquelle ist mandantenübergreifend — die Frische gilt nicht mandantenspezifisch.
                    </p>
                  )}

                  {selectedRow.def.route && (
                    <Button asChild className="w-full">
                      <Link to={selectedRow.def.route}>
                        {selectedRow.def.actionLabel ?? 'Zur Importseite'}
                        <ArrowRight className="ml-1.5 h-4 w-4" />
                      </Link>
                    </Button>
                  )}
                </div>
              </>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
