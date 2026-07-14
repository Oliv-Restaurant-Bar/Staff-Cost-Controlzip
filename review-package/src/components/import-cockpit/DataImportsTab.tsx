/**
 * DataImportsTab — Tab „Datenimporte" des Import-Cockpits.
 * =======================================================
 * Zeigt alle ECHTEN Datenimporte (section === 'import') mit Frische-Status,
 * KPI-Kacheln, Filtern und einer nach Bereich gruppierten Tabelle. Read-only:
 * Klick öffnet den Detail-Drawer, keine Schreibaktionen.
 */

import { Fragment, useCallback, useMemo, useState } from 'react';
import {
  Search,
  CheckCircle2,
  Clock,
  AlertTriangle,
  HelpCircle,
  CalendarClock,
  Globe,
  XCircle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  summarizeCockpit,
  formatCockpitDate,
  INTERVAL_LABEL,
  STATUS_LABEL,
  IMPORT_TYPE_LABEL,
  IMPORT_TYPE_ORDER,
  type CockpitRow,
  type CockpitSourceId,
  type CockpitStatus,
  type CockpitImportType,
  type CockpitTabCategory,
  type ImportInterval,
} from '@/lib/import-cockpit';
import {
  importRowMatchesFilters,
  importFileFormats,
  toggleImportKpiFilter,
  toggleImportMonthFilter,
  buildMonthOverview,
  summarizeImportYear,
  localTodayIso,
  MONTH_SHORT_LABELS,
  EMPTY_IMPORT_TAB_FILTER,
  IMPORT_CATEGORY_ORDER,
  TAB_CATEGORY_LABEL,
  type ImportKpiFilter,
  type ImportMonthKey,
  type ImportTabFilterState,
} from '@/lib/import-cockpit-tabs';
import { KpiCard, StatusBadge, ImportTypeBadge, FileFormatBadges, formatDateTime, dataUntilOf } from './cockpit-ui';

const INTERVAL_FILTER_OPTIONS: Array<{ value: 'all' | ImportInterval; label: string }> = [
  { value: 'all', label: 'Alle Intervalle' },
  ...(['daily', 'weekly', 'monthly', 'yearly'] as ImportInterval[]).map((i) => ({ value: i, label: INTERVAL_LABEL[i] })),
];

const STATUS_FILTER_ORDER: CockpitStatus[] = ['current', 'due_soon', 'overdue', 'never', 'uncheckable'];
const STATUS_FILTER_OPTIONS: Array<{ value: 'all' | CockpitStatus; label: string }> = [
  { value: 'all', label: 'Alle Status' },
  ...STATUS_FILTER_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
];

const CATEGORY_FILTER_OPTIONS: Array<{ value: 'all' | CockpitTabCategory; label: string }> = [
  { value: 'all', label: 'Alle Bereiche' },
  ...IMPORT_CATEGORY_ORDER.map((c) => ({ value: c, label: TAB_CATEGORY_LABEL[c] })),
];

const IMPORT_TYPE_FILTER_OPTIONS: Array<{ value: 'all' | CockpitImportType; label: string }> = [
  { value: 'all', label: 'Alle Import-Arten' },
  ...IMPORT_TYPE_ORDER.map((t) => ({ value: t, label: IMPORT_TYPE_LABEL[t] })),
];

interface Props {
  importRows: CockpitRow[];
  onSelect: (id: CockpitSourceId) => void;
  /** Heutiges Datum 'yyyy-MM-dd' (nur für Tests überschreibbar). */
  today?: string;
}

export function DataImportsTab({ importRows, onSelect, today = localTodayIso() }: Props) {
  const [filters, setFilters] = useState<ImportTabFilterState>(EMPTY_IMPORT_TAB_FILTER);
  const [year, setYear] = useState(() => Number(today.slice(0, 4)));

  const patchFilter = useCallback(
    <K extends keyof ImportTabFilterState>(key: K, value: ImportTabFilterState[K]) =>
      setFilters((prev) => ({ ...prev, [key]: value })),
    [],
  );
  const resetFilters = useCallback(() => setFilters(EMPTY_IMPORT_TAB_FILTER), []);
  const toggleKpi = useCallback(
    (kpi: ImportKpiFilter) => setFilters((prev) => ({ ...prev, kpi: toggleImportKpiFilter(prev.kpi, kpi) })),
    [],
  );
  const toggleMonth = useCallback(
    (key: ImportMonthKey) => setFilters((prev) => ({ ...prev, month: toggleImportMonthFilter(prev.month, key) })),
    [],
  );
  const clearMonth = useCallback(() => setFilters((prev) => (prev.month === null ? prev : { ...prev, month: null })), []);
  const changeYear = useCallback(
    (delta: number) => {
      const nextYear = year + delta;
      setYear(nextYear);
      // Aktiven Monatsfilter aufs neue Jahr übertragen (gleicher Monat).
      setFilters((prev) =>
        prev.month === null ? prev : { ...prev, month: `${nextYear}${prev.month.slice(4)}` },
      );
    },
    [year],
  );
  const hasActiveFilters =
    filters.category !== 'all' ||
    filters.importType !== 'all' ||
    filters.interval !== 'all' ||
    filters.status !== 'all' ||
    filters.kpi !== null ||
    filters.month !== null ||
    filters.search.trim() !== '';

  const kpis = useMemo(() => summarizeCockpit(importRows), [importRows]);
  const monthCells = useMemo(() => buildMonthOverview(importRows, year, today), [importRows, year, today]);
  const yearSummary = useMemo(() => summarizeImportYear(importRows, year, today), [importRows, year, today]);
  const filteredRows = useMemo(
    () => importRows.filter((r) => importRowMatchesFilters(r, filters, today)),
    [importRows, filters, today],
  );

  const groupedRows = useMemo(() => {
    const byCategory = new Map<CockpitTabCategory, CockpitRow[]>();
    for (const r of filteredRows) {
      const list = byCategory.get(r.def.tabCategory);
      if (list) list.push(r);
      else byCategory.set(r.def.tabCategory, [r]);
    }
    return IMPORT_CATEGORY_ORDER.map((category) => ({ category, rows: byCategory.get(category) ?? [] })).filter(
      (g) => g.rows.length > 0,
    );
  }, [filteredRows]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="Aktuell"
          value={kpis.current}
          icon={<CheckCircle2 className="h-5 w-5 text-emerald-600" />}
          accent="bg-emerald-100 dark:bg-emerald-950/40"
          onClick={() => toggleKpi('current')}
          active={filters.kpi === 'current'}
        />
        <KpiCard
          label="Bald fällig"
          value={kpis.dueSoon}
          icon={<Clock className="h-5 w-5 text-amber-600" />}
          accent="bg-amber-100 dark:bg-amber-950/40"
          onClick={() => toggleKpi('due_soon')}
          active={filters.kpi === 'due_soon'}
        />
        <KpiCard
          label="Überfällig"
          value={kpis.overdue}
          icon={<AlertTriangle className="h-5 w-5 text-red-600" />}
          accent="bg-red-100 dark:bg-red-950/40"
          onClick={() => toggleKpi('overdue')}
          active={filters.kpi === 'overdue'}
        />
        <KpiCard
          label="Nie / Nicht prüfbar"
          value={kpis.never + kpis.uncheckable}
          icon={<HelpCircle className="h-5 w-5 text-muted-foreground" />}
          accent="bg-muted"
          onClick={() => toggleKpi('never_uncheckable')}
          active={filters.kpi === 'never_uncheckable'}
        />
        <KpiCard
          label="Datenlücken"
          value={kpis.dataGaps}
          icon={<CalendarClock className="h-5 w-5 text-amber-600" />}
          accent="bg-amber-100 dark:bg-amber-950/40"
          onClick={() => toggleKpi('gaps')}
          active={filters.kpi === 'gaps'}
        />
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => changeYear(-1)}
                aria-label="Vorjahr"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="w-12 text-center text-sm font-semibold tabular-nums" data-testid="month-overview-year">
                {year}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => changeYear(1)}
                aria-label="Nächstes Jahr"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant={filters.month === null ? 'secondary' : 'ghost'}
                size="sm"
                className="ml-1 h-8"
                aria-pressed={filters.month === null}
                onClick={clearMonth}
              >
                Ganzes Jahr
              </Button>
            </div>
            <div className="text-xs text-muted-foreground" data-testid="year-summary">
              Jahr {year}: <span className="font-medium text-emerald-600">{yearSummary.current} aktuell</span>
              {' · '}
              <span className="font-medium text-red-600">{yearSummary.overdue} überfällig</span>
              {' · '}
              <span className="font-medium">{yearSummary.never} nie importiert</span>
              {' · '}
              <span className="font-medium text-amber-600">{yearSummary.gapDays} Lücken-Tage</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-12">
            {monthCells.map((cell) => {
              const active = filters.month === cell.key;
              const quiet = !cell.hasProblems && cell.current === 0;
              return (
                <button
                  key={cell.key}
                  type="button"
                  aria-pressed={active}
                  aria-label={`${MONTH_SHORT_LABELS[cell.month - 1]} ${year}: ${cell.current} aktuell, ${cell.overdue} überfällig, ${cell.never} nie importiert, ${cell.gapDays} Lücken-Tage`}
                  onClick={() => toggleMonth(cell.key)}
                  className={[
                    'rounded-md border p-2 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'border-primary ring-2 ring-primary/40' : 'hover:bg-muted/60',
                    !active && cell.hasProblems
                      ? cell.overdue > 0 || cell.never > 0
                        ? 'border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/20'
                        : 'border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20'
                      : '',
                    quiet ? 'opacity-60' : '',
                  ].join(' ')}
                >
                  <div className="text-xs font-semibold">{MONTH_SHORT_LABELS[cell.month - 1]}</div>
                  {quiet ? (
                    <div className="mt-0.5 text-xs text-muted-foreground">–</div>
                  ) : (
                    <div className="mt-0.5 space-y-0 text-[11px] leading-4 tabular-nums">
                      {cell.current > 0 && <div className="text-emerald-600">{cell.current} aktuell</div>}
                      {cell.overdue > 0 && <div className="font-medium text-red-600">{cell.overdue} überfällig</div>}
                      {cell.never > 0 && <div className="text-muted-foreground">{cell.never} nie</div>}
                      {cell.gapDays > 0 && <div className="text-amber-600">{cell.gapDays} Lücken</div>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.search}
            onChange={(e) => patchFilter('search', e.target.value)}
            placeholder="Suchen…"
            className="h-9 w-40 pl-8"
          />
        </div>
        <Select value={filters.category} onValueChange={(v) => patchFilter('category', v as ImportTabFilterState['category'])}>
          <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CATEGORY_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.importType} onValueChange={(v) => patchFilter('importType', v as ImportTabFilterState['importType'])}>
          <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {IMPORT_TYPE_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.interval} onValueChange={(v) => patchFilter('interval', v as ImportTabFilterState['interval'])}>
          <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {INTERVAL_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.status} onValueChange={(v) => patchFilter('status', v as ImportTabFilterState['status'])}>
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

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Datenquelle</TableHead>
                  <TableHead className="hidden md:table-cell">Import-Art</TableHead>
                  <TableHead className="hidden xl:table-cell">Letzter Import</TableHead>
                  <TableHead>Ist-Daten bis</TableHead>
                  <TableHead className="hidden sm:table-cell">Intervall</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Nächste Fälligkeit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groupedRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                      Keine Datenimporte für diesen Filter.
                    </TableCell>
                  </TableRow>
                )}
                {groupedRows.map((group) => (
                  <Fragment key={group.category}>
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableCell colSpan={7} className="py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {TAB_CATEGORY_LABEL[group.category]}
                        <span className="ml-2 font-normal normal-case">({group.rows.length})</span>
                      </TableCell>
                    </TableRow>
                    {group.rows.map((row) => (
                      <TableRow
                        key={row.def.id}
                        className="cursor-pointer transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => onSelect(row.def.id)}
                        tabIndex={0}
                        aria-label={`Details zu ${row.def.label} öffnen`}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelect(row.def.id);
                          }
                        }}
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
                        <TableCell className="hidden md:table-cell">
                          {importFileFormats(row.def).length > 0 ? (
                            <FileFormatBadges formats={importFileFormats(row.def)} />
                          ) : (
                            <ImportTypeBadge type={row.def.importType} />
                          )}
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground xl:table-cell">
                          {formatDateTime(row.signal.lastImport?.at)}
                        </TableCell>
                        <TableCell>{formatCockpitDate(dataUntilOf(row.signal))}</TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <Badge variant="outline" className="font-normal">{INTERVAL_LABEL[row.def.interval]}</Badge>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={row.result.status} />
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground lg:table-cell">
                          {row.result.nextDue ? formatCockpitDate(row.result.nextDue) : '—'}
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
    </div>
  );
}
