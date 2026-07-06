/**
 * ControlsTab — Tab „Kontrollen" des Import-Cockpits.
 * ==================================================
 * Zeigt alle wiederkehrenden organisatorischen Kontrollen (section === 'control')
 * mit abgeleitetem Kontroll-Status, KPI-Kacheln, Filtern und einer nach Bereich
 * gruppierten Tabelle. Read-only: Klick öffnet den Detail-Drawer.
 */

import { Fragment, useCallback, useMemo, useState } from 'react';
import { Search, CheckCircle2, CalendarClock, Clock, AlertTriangle, HelpCircle, ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  formatCockpitDate,
  INTERVAL_LABEL,
  type CockpitSourceId,
  type CockpitTabCategory,
  type ImportInterval,
} from '@/lib/import-cockpit';
import {
  controlRowMatchesFilters,
  summarizeControls,
  EMPTY_CONTROL_TAB_FILTER,
  CONTROL_CATEGORY_ORDER,
  TAB_CATEGORY_LABEL,
  CONTROL_STATUS_LABEL,
  CONTROL_STATUS_ORDER,
  type ControlRow,
  type ControlStatus,
  type ControlTabFilterState,
} from '@/lib/import-cockpit-tabs';
import { KpiCard, ControlStatusBadge } from './cockpit-ui';

const INTERVAL_FILTER_OPTIONS: Array<{ value: 'all' | ImportInterval; label: string }> = [
  { value: 'all', label: 'Alle Intervalle' },
  ...(['weekly', 'monthly', 'yearly'] as ImportInterval[]).map((i) => ({ value: i, label: INTERVAL_LABEL[i] })),
];

const STATUS_FILTER_OPTIONS: Array<{ value: 'all' | ControlStatus; label: string }> = [
  { value: 'all', label: 'Alle Status' },
  ...CONTROL_STATUS_ORDER.map((s) => ({ value: s, label: CONTROL_STATUS_LABEL[s] })),
];

const CATEGORY_FILTER_OPTIONS: Array<{ value: 'all' | CockpitTabCategory; label: string }> = [
  { value: 'all', label: 'Alle Bereiche' },
  ...CONTROL_CATEGORY_ORDER.map((c) => ({ value: c, label: TAB_CATEGORY_LABEL[c] })),
];

interface Props {
  controlRows: ControlRow[];
  onSelect: (id: CockpitSourceId) => void;
}

export function ControlsTab({ controlRows, onSelect }: Props) {
  const [filters, setFilters] = useState<ControlTabFilterState>(EMPTY_CONTROL_TAB_FILTER);

  const patchFilter = useCallback(
    <K extends keyof ControlTabFilterState>(key: K, value: ControlTabFilterState[K]) =>
      setFilters((prev) => ({ ...prev, [key]: value })),
    [],
  );
  const resetFilters = useCallback(() => setFilters(EMPTY_CONTROL_TAB_FILTER), []);
  const hasActiveFilters =
    filters.category !== 'all' || filters.interval !== 'all' || filters.status !== 'all' || filters.search.trim() !== '';

  const kpis = useMemo(() => summarizeControls(controlRows), [controlRows]);
  const filteredRows = useMemo(
    () => controlRows.filter((r) => controlRowMatchesFilters(r, filters)),
    [controlRows, filters],
  );

  const groupedRows = useMemo(() => {
    const byCategory = new Map<CockpitTabCategory, ControlRow[]>();
    for (const r of filteredRows) {
      const list = byCategory.get(r.def.tabCategory);
      if (list) list.push(r);
      else byCategory.set(r.def.tabCategory, [r]);
    }
    return CONTROL_CATEGORY_ORDER.map((category) => ({ category, rows: byCategory.get(category) ?? [] })).filter(
      (g) => g.rows.length > 0,
    );
  }, [filteredRows]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="Erledigt"
          value={kpis.done}
          icon={<CheckCircle2 className="h-5 w-5 text-emerald-600" />}
          accent="bg-emerald-100 dark:bg-emerald-950/40"
        />
        <KpiCard
          label="Heute fällig"
          value={kpis.dueToday}
          icon={<CalendarClock className="h-5 w-5 text-red-600" />}
          accent="bg-red-100 dark:bg-red-950/40"
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
          label="Nicht eingerichtet"
          value={kpis.notConfigured}
          icon={<HelpCircle className="h-5 w-5 text-muted-foreground" />}
          accent="bg-muted"
        />
      </div>

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
        <Select value={filters.category} onValueChange={(v) => patchFilter('category', v as ControlTabFilterState['category'])}>
          <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CATEGORY_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.interval} onValueChange={(v) => patchFilter('interval', v as ControlTabFilterState['interval'])}>
          <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {INTERVAL_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.status} onValueChange={(v) => patchFilter('status', v as ControlTabFilterState['status'])}>
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
                  <TableHead>Kontrolle</TableHead>
                  <TableHead className="hidden lg:table-cell">Was ist zu tun?</TableHead>
                  <TableHead className="hidden md:table-cell">Verantwortlich</TableHead>
                  <TableHead className="hidden sm:table-cell">Rhythmus</TableHead>
                  <TableHead className="hidden lg:table-cell">Nächste Fälligkeit</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Aktion</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groupedRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                      Keine Kontrollen für diesen Filter.
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
                      <TableRow key={row.def.id} className="cursor-pointer" onClick={() => onSelect(row.def.id)}>
                        <TableCell className="font-medium">{row.def.label}</TableCell>
                        <TableCell className="hidden max-w-[18rem] text-muted-foreground lg:table-cell">
                          <span className="line-clamp-2">{row.def.uploadLabel}</span>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">
                          {row.def.responsible ?? '—'}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <Badge variant="outline" className="font-normal">{INTERVAL_LABEL[row.def.interval]}</Badge>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground lg:table-cell">
                          {row.result.nextDue ? formatCockpitDate(row.result.nextDue) : '—'}
                        </TableCell>
                        <TableCell>
                          <ControlStatusBadge status={row.controlStatus} />
                        </TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <Button variant="ghost" size="sm" onClick={() => onSelect(row.def.id)}>
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
    </div>
  );
}
