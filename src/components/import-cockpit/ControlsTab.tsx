/**
 * ControlsTab — Tab „Kontrollen" des Import-Cockpits.
 * ==================================================
 * Zeigt alle wiederkehrenden organisatorischen Kontrollen (section === 'control')
 * mit abgeleitetem Kontroll-Status, KPI-Kacheln, Filtern und einer nach Bereich
 * gruppierten Tabelle. Klick auf eine Zeile öffnet den Detail-Drawer.
 *
 * NEU: Kontrollen können MANUELL als „erledigt" markiert werden (Mehrfachauswahl
 * per Checkbox + Sammelaktion mit Bestätigung). Das setzt die letzte Durchführung
 * auf heute und berechnet die nächste Fälligkeit aus dem Rhythmus neu. Echte
 * Datenimporte sind hiervon NICHT betroffen (eigener Tab, kein manuelles Erledigen).
 */

import { Fragment, useCallback, useMemo, useState } from 'react';
import {
  Search,
  CheckCircle2,
  CalendarClock,
  Clock,
  AlertTriangle,
  HelpCircle,
  ArrowRight,
  CheckCheck,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
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
  /** Markiert die übergebenen Kontrollen als erledigt (Persistenz + Toast in der Page). */
  onMarkDone: (ids: CockpitSourceId[]) => void;
}

export function ControlsTab({ controlRows, onSelect, onMarkDone }: Props) {
  const [filters, setFilters] = useState<ControlTabFilterState>(EMPTY_CONTROL_TAB_FILTER);
  const [selectedIds, setSelectedIds] = useState<Set<CockpitSourceId>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

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

  // ─── Auswahl (Mehrfach) ─────────────────────────────────────────────────────
  const visibleIds = useMemo(() => filteredRows.map((r) => r.def.id), [filteredRows]);
  const selectedCount = selectedIds.size;
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id));

  const toggleRow = useCallback((id: CockpitSourceId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setGroupSelection = useCallback((ids: CockpitSourceId[], selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const toggleAllVisible = useCallback(() => {
    setGroupSelection(visibleIds, !allVisibleSelected);
  }, [setGroupSelection, visibleIds, allVisibleSelected]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const confirmMarkDone = useCallback(() => {
    onMarkDone([...selectedIds]);
    clearSelection();
    setConfirmOpen(false);
  }, [onMarkDone, selectedIds, clearSelection]);

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

      {/* Sammelaktion: Auswahl als erledigt markieren */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
        <span className="text-sm text-muted-foreground">
          {selectedCount > 0 ? (
            <span className="font-medium text-foreground">{selectedCount} ausgewählt</span>
          ) : (
            'Kontrollen auswählen, um sie als erledigt zu markieren'
          )}
        </span>
        <div className="flex items-center gap-2">
          {selectedCount > 0 && (
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              Auswahl aufheben
            </Button>
          )}
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger asChild>
              <Button size="sm" disabled={selectedCount === 0}>
                <CheckCheck className="mr-1.5 h-4 w-4" />
                Als erledigt markieren
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Kontrollen als erledigt markieren?</AlertDialogTitle>
                <AlertDialogDescription>
                  {selectedCount === 1
                    ? 'Die ausgewählte Kontrolle wird als heute erledigt markiert.'
                    : `${selectedCount} Kontrollen werden als heute erledigt markiert.`}{' '}
                  Die letzte Durchführung wird auf heute gesetzt und die nächste Fälligkeit anhand des Rhythmus neu berechnet.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                <AlertDialogAction onClick={confirmMarkDone}>Als erledigt markieren</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                      onCheckedChange={toggleAllVisible}
                      aria-label="Alle sichtbaren Kontrollen auswählen"
                      disabled={visibleIds.length === 0}
                    />
                  </TableHead>
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
                    <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                      Keine Kontrollen für diesen Filter.
                    </TableCell>
                  </TableRow>
                )}
                {groupedRows.map((group) => {
                  const groupIds = group.rows.map((r) => r.def.id);
                  const groupAllSelected = groupIds.every((id) => selectedIds.has(id));
                  const groupSomeSelected = groupIds.some((id) => selectedIds.has(id));
                  return (
                    <Fragment key={group.category}>
                      <TableRow className="bg-muted/50 hover:bg-muted/50">
                        <TableCell className="py-2">
                          <Checkbox
                            checked={groupAllSelected ? true : groupSomeSelected ? 'indeterminate' : false}
                            onCheckedChange={(v) => setGroupSelection(groupIds, v === true)}
                            aria-label={`Alle Kontrollen im Bereich ${TAB_CATEGORY_LABEL[group.category]} auswählen`}
                          />
                        </TableCell>
                        <TableCell colSpan={7} className="py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {TAB_CATEGORY_LABEL[group.category]}
                          <span className="ml-2 font-normal normal-case">({group.rows.length})</span>
                        </TableCell>
                      </TableRow>
                      {group.rows.map((row) => {
                        const isSelected = selectedIds.has(row.def.id);
                        return (
                          <TableRow
                            key={row.def.id}
                            className={cn('cursor-pointer', isSelected && 'bg-primary/5 hover:bg-primary/10')}
                            onClick={() => onSelect(row.def.id)}
                          >
                            <TableCell className="py-2" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={() => toggleRow(row.def.id)}
                                aria-label={`Kontrolle „${row.def.label}" auswählen`}
                              />
                            </TableCell>
                            <TableCell className="font-medium">
                              <div className="flex flex-col">
                                <span>{row.def.label}</span>
                                {row.manuallyCompleted && row.completedAt && (
                                  <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400">
                                    Manuell erledigt am {formatCockpitDate(row.completedAt)}
                                  </span>
                                )}
                              </div>
                            </TableCell>
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
                        );
                      })}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
