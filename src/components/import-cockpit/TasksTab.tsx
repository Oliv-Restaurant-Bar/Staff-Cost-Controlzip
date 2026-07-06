/**
 * TasksTab — Tab „Aufgaben" des Import-Cockpits.
 * =============================================
 * Aggregiert alle OFFENEN Punkte aus beiden Sektionen (Importe + Kontrollen) zu
 * einer priorisierten To-do-Liste, gruppiert nach Zeithorizont (Heute/Woche/
 * Monat/Jahr). Klick öffnet den Detail-Drawer. Neutrale Zustände
 * (aktuell/erledigt/nicht eingerichtet) erzeugen bewusst KEINE Aufgabe.
 *
 * NEU: Kontroll-Aufgaben können per Mehrfachauswahl manuell erledigt werden.
 * Datenimport-Aufgaben (section === 'import') sind NICHT manuell erledigbar —
 * werden sie mit-ausgewählt, erscheint ein Hinweis und sie bleiben offen.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Search,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Flame,
  CheckCircle2,
  ArrowRight,
  CheckCheck,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import { useToast } from '@/hooks/use-toast';
import type { CockpitRow, CockpitSourceId } from '@/lib/import-cockpit';
import {
  buildTasks,
  groupTasksByTimeframe,
  summarizeTasks,
  taskMatchesFilters,
  EMPTY_TASK_TAB_FILTER,
  TASK_TIMEFRAME_LABEL,
  TASK_TIMEFRAME_ORDER,
  TASK_PRIORITY_LABEL,
  TASK_PRIORITY_ORDER,
  SECTION_LABEL,
  type CockpitTask,
  type TaskTabFilterState,
  type TaskTimeframe,
} from '@/lib/import-cockpit-tabs';
import { partitionTasksForCompletion, type ManualCompletionMap } from '@/lib/import-cockpit-checks';
import { KpiCard, TaskPriorityBadge, SectionBadge } from './cockpit-ui';

const IMPORT_BLOCK_HINT = 'Datenimporte können nur durch den passenden Import abgeschlossen werden.';

const SECTION_FILTER_OPTIONS: Array<{ value: TaskTabFilterState['section']; label: string }> = [
  { value: 'all', label: 'Alle Bereiche' },
  { value: 'import', label: SECTION_LABEL.import },
  { value: 'control', label: SECTION_LABEL.control },
];

const PRIORITY_FILTER_OPTIONS: Array<{ value: TaskTabFilterState['priority']; label: string }> = [
  { value: 'all', label: 'Alle Prioritäten' },
  ...TASK_PRIORITY_ORDER.map((p) => ({ value: p, label: TASK_PRIORITY_LABEL[p] })),
];

const TIMEFRAME_FILTER_OPTIONS: Array<{ value: TaskTabFilterState['timeframe']; label: string }> = [
  { value: 'all', label: 'Alle Zeithorizonte' },
  ...TASK_TIMEFRAME_ORDER.map((t) => ({ value: t, label: TASK_TIMEFRAME_LABEL[t] })),
];

const TIMEFRAME_ICON: Record<TaskTimeframe, typeof CalendarClock> = {
  today: CalendarClock,
  week: CalendarDays,
  month: CalendarRange,
  year: CalendarRange,
};

interface Props {
  rows: CockpitRow[];
  today: string;
  onSelect: (id: CockpitSourceId) => void;
  /** Aktive manuelle Erledigungen (blenden erledigte Kontroll-Aufgaben aus). */
  completions: ManualCompletionMap;
  /** Markiert die übergebenen Kontroll-Aufgaben als erledigt (Persistenz + Toast in der Page). */
  onMarkDone: (ids: CockpitSourceId[]) => void;
}

export function TasksTab({ rows, today, onSelect, completions, onMarkDone }: Props) {
  const { toast } = useToast();
  const [filters, setFilters] = useState<TaskTabFilterState>(EMPTY_TASK_TAB_FILTER);
  const [selectedIds, setSelectedIds] = useState<Set<CockpitSourceId>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const patchFilter = useCallback(
    <K extends keyof TaskTabFilterState>(key: K, value: TaskTabFilterState[K]) =>
      setFilters((prev) => ({ ...prev, [key]: value })),
    [],
  );
  const resetFilters = useCallback(() => setFilters(EMPTY_TASK_TAB_FILTER), []);
  const hasActiveFilters =
    filters.section !== 'all' || filters.priority !== 'all' || filters.timeframe !== 'all' || filters.search.trim() !== '';

  const allTasks = useMemo(() => buildTasks(rows, today, completions), [rows, today, completions]);
  const kpis = useMemo(() => summarizeTasks(allTasks), [allTasks]);
  const filteredTasks = useMemo(() => allTasks.filter((t) => taskMatchesFilters(t, filters)), [allTasks, filters]);
  const grouped = useMemo(() => groupTasksByTimeframe(filteredTasks), [filteredTasks]);

  // ─── Auswahl (Mehrfach) ─────────────────────────────────────────────────────
  const selectedCount = selectedIds.size;

  const toggleTask = useCallback((id: CockpitSourceId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setManySelected = useCallback((ids: CockpitSourceId[], selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const confirmMarkDone = useCallback(() => {
    const { completable, blocked } = partitionTasksForCompletion(allTasks, selectedIds);
    if (completable.length > 0) {
      onMarkDone(completable.map((t) => t.id));
    }
    if (blocked.length > 0) {
      toast({
        title: 'Datenimporte können nicht manuell erledigt werden',
        description: IMPORT_BLOCK_HINT,
      });
    }
    clearSelection();
    setConfirmOpen(false);
  }, [allTasks, selectedIds, onMarkDone, toast, clearSelection]);

  const selectionSummary = useMemo(
    () => partitionTasksForCompletion(allTasks, selectedIds),
    [allTasks, selectedIds],
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="Dringend"
          value={kpis.critical}
          icon={<Flame className="h-5 w-5 text-red-600" />}
          accent="bg-red-100 dark:bg-red-950/40"
        />
        <KpiCard
          label="Heute"
          value={kpis.todayOpen}
          icon={<CalendarClock className="h-5 w-5 text-amber-600" />}
          accent="bg-amber-100 dark:bg-amber-950/40"
        />
        <KpiCard
          label="Diese Woche"
          value={kpis.weekOpen}
          icon={<CalendarDays className="h-5 w-5 text-amber-600" />}
          accent="bg-amber-100 dark:bg-amber-950/40"
        />
        <KpiCard
          label="Diesen Monat"
          value={kpis.monthOpen}
          icon={<CalendarRange className="h-5 w-5 text-muted-foreground" />}
          accent="bg-muted"
        />
        <KpiCard
          label="Offen gesamt"
          value={kpis.total}
          icon={<CheckCircle2 className="h-5 w-5 text-muted-foreground" />}
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
        <Select value={filters.section} onValueChange={(v) => patchFilter('section', v as TaskTabFilterState['section'])}>
          <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {SECTION_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.priority} onValueChange={(v) => patchFilter('priority', v as TaskTabFilterState['priority'])}>
          <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PRIORITY_FILTER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.timeframe} onValueChange={(v) => patchFilter('timeframe', v as TaskTabFilterState['timeframe'])}>
          <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {TIMEFRAME_FILTER_OPTIONS.map((o) => (
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

      {/* Sammelaktion: ausgewählte (Kontroll-)Aufgaben erledigen */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
        <span className="text-sm text-muted-foreground">
          {selectedCount > 0 ? (
            <span className="font-medium text-foreground">{selectedCount} ausgewählt</span>
          ) : (
            'Kontroll-Aufgaben auswählen, um sie zu erledigen'
          )}
          {selectionSummary.blocked.length > 0 && (
            <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">
              ({selectionSummary.blocked.length} Datenimport{selectionSummary.blocked.length === 1 ? '' : 'e'} nicht erledigbar)
            </span>
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
                Ausgewählte erledigen
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Aufgaben als erledigt markieren?</AlertDialogTitle>
                <AlertDialogDescription>
                  {selectionSummary.completable.length > 0
                    ? `${selectionSummary.completable.length} Kontroll-Aufgabe${
                        selectionSummary.completable.length === 1 ? ' wird' : 'n werden'
                      } als heute erledigt markiert.`
                    : 'Es ist keine manuell erledigbare Kontroll-Aufgabe ausgewählt.'}
                  {selectionSummary.blocked.length > 0 && ` ${IMPORT_BLOCK_HINT}`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                <AlertDialogAction onClick={confirmMarkDone}>Erledigen</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {filteredTasks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <p className="text-sm font-medium">Keine offenen Aufgaben</p>
            <p className="text-xs text-muted-foreground">
              Alle prüfbaren Importe und Kontrollen sind aktuell — oder der Filter schränkt zu stark ein.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {TASK_TIMEFRAME_ORDER.map((timeframe) => {
            const items = grouped[timeframe];
            const Icon = TIMEFRAME_ICON[timeframe];
            const controlIds = items.filter((t) => t.section === 'control').map((t) => t.id);
            const groupAllSelected = controlIds.length > 0 && controlIds.every((id) => selectedIds.has(id));
            const groupSomeSelected = controlIds.some((id) => selectedIds.has(id));
            return (
              <Card key={timeframe}>
                <CardContent className="p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                      {controlIds.length > 0 && (
                        <Checkbox
                          checked={groupAllSelected ? true : groupSomeSelected ? 'indeterminate' : false}
                          onCheckedChange={(v) => setManySelected(controlIds, v === true)}
                          aria-label={`Alle Kontroll-Aufgaben (${TASK_TIMEFRAME_LABEL[timeframe]}) auswählen`}
                        />
                      )}
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      {TASK_TIMEFRAME_LABEL[timeframe]}
                    </h3>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                      {items.length}
                    </span>
                  </div>
                  <ul className="space-y-1.5">
                    {items.length === 0 && <li className="py-2 text-sm text-muted-foreground">Keine offenen Punkte.</li>}
                    {items.map((task: CockpitTask) => {
                      const isSelected = selectedIds.has(task.id);
                      const isImport = task.section === 'import';
                      return (
                        <li
                          key={task.id}
                          className={cn(
                            'flex items-start gap-2 rounded-md border px-2.5 py-2 transition-colors',
                            isSelected
                              ? 'border-primary/40 bg-primary/5'
                              : task.priority === 'critical'
                                ? 'border-red-200 dark:border-red-900/60'
                                : 'border-border',
                          )}
                        >
                          <Checkbox
                            className="mt-0.5"
                            checked={isSelected}
                            onCheckedChange={() => toggleTask(task.id)}
                            aria-label={`Aufgabe „${task.label}" auswählen`}
                          />
                          <button
                            type="button"
                            onClick={() => onSelect(task.id)}
                            className="flex min-w-0 flex-1 items-start justify-between gap-2 text-left text-sm"
                          >
                            <span className="min-w-0 space-y-1">
                              <span className="block truncate font-medium">{task.label}</span>
                              <span className="line-clamp-2 block text-xs text-muted-foreground">{task.reason}</span>
                              <span className="mt-0.5 flex items-center gap-1.5">
                                <SectionBadge section={task.section} />
                                {isImport && (
                                  <span className="text-[11px] text-muted-foreground">nur per Import erledigbar</span>
                                )}
                              </span>
                            </span>
                            <span className="flex shrink-0 flex-col items-end gap-1">
                              <TaskPriorityBadge priority={task.priority} />
                              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
