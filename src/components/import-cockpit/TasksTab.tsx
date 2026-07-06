/**
 * TasksTab — Tab „Aufgaben" des Import-Cockpits.
 * =============================================
 * Aggregiert alle OFFENEN Punkte aus beiden Sektionen (Importe + Kontrollen) zu
 * einer priorisierten To-do-Liste, gruppiert nach Zeithorizont (Heute/Woche/
 * Monat/Jahr). Read-only: Klick öffnet den Detail-Drawer. Neutrale Zustände
 * (aktuell/erledigt/nicht eingerichtet) erzeugen bewusst KEINE Aufgabe.
 */

import { useCallback, useMemo, useState } from 'react';
import { Search, CalendarClock, CalendarDays, CalendarRange, Flame, CheckCircle2, ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { CockpitSourceId } from '@/lib/import-cockpit';
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
import { KpiCard, TaskPriorityBadge, SectionBadge } from './cockpit-ui';
import type { CockpitRow } from '@/lib/import-cockpit';

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
}

export function TasksTab({ rows, today, onSelect }: Props) {
  const [filters, setFilters] = useState<TaskTabFilterState>(EMPTY_TASK_TAB_FILTER);

  const patchFilter = useCallback(
    <K extends keyof TaskTabFilterState>(key: K, value: TaskTabFilterState[K]) =>
      setFilters((prev) => ({ ...prev, [key]: value })),
    [],
  );
  const resetFilters = useCallback(() => setFilters(EMPTY_TASK_TAB_FILTER), []);
  const hasActiveFilters =
    filters.section !== 'all' || filters.priority !== 'all' || filters.timeframe !== 'all' || filters.search.trim() !== '';

  const allTasks = useMemo(() => buildTasks(rows, today), [rows, today]);
  const kpis = useMemo(() => summarizeTasks(allTasks), [allTasks]);
  const filteredTasks = useMemo(() => allTasks.filter((t) => taskMatchesFilters(t, filters)), [allTasks, filters]);
  const grouped = useMemo(() => groupTasksByTimeframe(filteredTasks), [filteredTasks]);

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
            return (
              <Card key={timeframe}>
                <CardContent className="p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      {TASK_TIMEFRAME_LABEL[timeframe]}
                    </h3>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                      {items.length}
                    </span>
                  </div>
                  <ul className="space-y-1.5">
                    {items.length === 0 && <li className="py-2 text-sm text-muted-foreground">Keine offenen Punkte.</li>}
                    {items.map((task: CockpitTask) => (
                      <li key={task.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(task.id)}
                          className={cn(
                            'flex w-full items-start justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted',
                            task.priority === 'critical' ? 'border-red-200 dark:border-red-900/60' : 'border-border',
                          )}
                        >
                          <span className="min-w-0 space-y-1">
                            <span className="block truncate font-medium">{task.label}</span>
                            <span className="line-clamp-2 block text-xs text-muted-foreground">{task.reason}</span>
                            <span className="mt-0.5 flex items-center gap-1.5">
                              <SectionBadge section={task.section} />
                            </span>
                          </span>
                          <span className="flex shrink-0 flex-col items-end gap-1">
                            <TaskPriorityBadge priority={task.priority} />
                            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
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
      )}
    </div>
  );
}
