/**
 * ImportChecklistTab — Tab „Checkliste" des Import-Cockpits.
 * =========================================================
 * Echte Import-Checkliste: erzeugt pro Importtyp automatisch offene Aufgaben
 * für den gewählten Monat (Engine: import-tasks-engine.ts) und bietet pro
 * Aufgabe einen „Importieren"-Button, der DIREKT in den bestehenden
 * Import-Flow navigiert (Prefill via Query-Params — advisory, nie hart).
 *
 *   - Täglich   (Z-Bericht, Foratable): eine Aufgabe pro fehlendem Tag
 *   - Zeitraum  (Umsatz, Verkaufsdaten, Mirus, Marketing): Rest-Zeiträume
 *   - Monatlich (Erfolgsrechnung, IST-Kosten) · Jährlich (Budget)
 *
 * Konflikt-Schutz: Liegt im Zielzeitraum bereits etwas vor, erscheint VOR der
 * Navigation ein Dialog (Behalten / Ersetzen / Abbrechen). Das eigentliche
 * Ersetzen bleibt im bestehenden Import-Flow der Zielseite — hier wird NIE
 * direkt geschrieben (Tab ist strikt read-only).
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays,
  CalendarRange,
  CalendarCheck,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Download,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { StatusPill } from '@/components/ui/status-pill';
import { InfoTip } from '@/components/ui/info-tip';
import { HintBox } from '@/components/ui/hint-box';
import { LoadingState, EmptyState } from '@/components/ui/page-states';
import type { Tone } from '@/components/ui/tones';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import {
  buildImportTasks,
  buildImportTarget,
  buildFullMonthTask,
  checkImportConflict,
  groupImportTasks,
  isOpenTask,
  summarizeImportTasks,
  formatIsoRange,
  monthLabel,
  FREQUENCY_LABEL,
  FREQUENCY_ORDER,
  TASK_STATUS_LABEL,
  TASK_TYPE_DEFS,
  type ImportTask,
  type ImportTaskType,
  type MonthCoverage,
  type TaskFrequency,
} from '@/lib/import-tasks-engine';

// ── Status → Ton (zentrale tones.ts-Semantik) ────────────────────────────────

const STATUS_TONE: Record<ImportTask['status'], Tone> = {
  open: 'warn',
  partial: 'warn',
  done: 'good',
  error: 'critical',
};

const GROUP_ICON: Record<TaskFrequency, typeof CalendarDays> = {
  daily: CalendarDays,
  range: CalendarRange,
  monthly: CalendarCheck,
  yearly: CalendarClock,
};

/** UI-Hinweise pro Typ (nur Anzeige — keine Logik). */
const TYPE_HINT: Partial<Record<ImportTaskType, string>> = {
  verkaufsdaten:
    'Verkaufsdaten (product_sales) haben keine Mandanten-Trennung — der Status gilt mandantenübergreifend.',
  zbericht:
    'Ruhetage ohne Umsatz bleiben als offene Tagesaufgaben stehen, solange kein Z-Bericht für den Tag importiert wurde.',
  reservationen:
    'Tage ohne Reservationen gelten als abgedeckt, sobald ein Importlauf den Zeitraum umfasste.',
};

interface PendingConflict {
  task: Pick<ImportTask, 'type' | 'frequency' | 'from' | 'to' | 'label'>;
  coveredDays: string[];
  href: string;
}

export function ImportChecklistTab({
  year,
  month,
  today,
  coverage,
  loading,
  onPeriodChange,
}: {
  year: number;
  /** 1–12 */
  month: number;
  /** yyyy-MM-dd */
  today: string;
  coverage: MonthCoverage | null;
  loading: boolean;
  onPeriodChange: (year: number, month: number) => void;
}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [showDone, setShowDone] = useState(false);
  const [conflict, setConflict] = useState<PendingConflict | null>(null);

  const tasks = useMemo(
    () => (coverage ? buildImportTasks({ year, month, today }, coverage) : []),
    [coverage, year, month, today],
  );
  const groups = useMemo(() => groupImportTasks(tasks), [tasks]);
  const kpis = useMemo(() => summarizeImportTasks(tasks), [tasks]);

  const isCurrentMonth = useMemo(() => {
    const now = today.slice(0, 7);
    return now === `${year}-${String(month).padStart(2, '0')}`;
  }, [today, year, month]);

  const shiftMonth = (delta: number) => {
    const idx = year * 12 + (month - 1) + delta;
    onPeriodChange(Math.floor(idx / 12), (idx % 12) + 1);
  };

  /** Import starten: Konflikt prüfen → Dialog ODER direkt navigieren. */
  const startImport = (task: Pick<ImportTask, 'type' | 'frequency' | 'from' | 'to' | 'label'>) => {
    const target = buildImportTarget(task);
    const check = coverage ? checkImportConflict(task, coverage) : { hasConflict: false, coveredDays: [] };
    if (check.hasConflict) {
      setConflict({ task, coveredDays: check.coveredDays, href: target.href });
      return;
    }
    navigate(target.href);
  };

  const fullMonthImport = (type: ImportTaskType) => {
    startImport(buildFullMonthTask(type, { year, month }));
  };

  return (
    <div className="space-y-4" data-testid="import-checklist">
      {/* Toolbar: Monat/Jahr + Erledigte-Umschalter */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => shiftMonth(-1)}
            aria-label="Vorheriger Monat"
            data-testid="checklist-prev-month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[9.5rem] text-center text-sm font-semibold tabular-nums" data-testid="checklist-month-label">
            {monthLabel(year, month)}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => shiftMonth(1)}
            aria-label="Nächster Monat"
            data-testid="checklist-next-month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => onPeriodChange(Number(today.slice(0, 4)), Number(today.slice(5, 7)))}
            disabled={isCurrentMonth}
            data-testid="checklist-today"
          >
            Heute
          </Button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Switch
            id="checklist-show-done"
            checked={showDone}
            onCheckedChange={setShowDone}
            data-testid="checklist-show-done"
          />
          <Label htmlFor="checklist-show-done" className="text-xs text-muted-foreground">
            Erledigte anzeigen
          </Label>
        </div>
      </div>

      {/* Zusammenfassung */}
      {coverage && (
        <div className="flex flex-wrap items-center gap-2" data-testid="checklist-kpis">
          <StatusPill tone={kpis.open + kpis.partial > 0 ? 'warn' : 'good'}>
            {kpis.open + kpis.partial} offen
          </StatusPill>
          <StatusPill tone="good">{kpis.done} erledigt</StatusPill>
          {kpis.error > 0 && <StatusPill tone="critical">{kpis.error} Fehler</StatusPill>}
        </div>
      )}

      {loading && !coverage ? (
        <LoadingState label="Abdeckung wird ermittelt …" />
      ) : !coverage ? (
        <EmptyState title="Keine Daten" description="Die Abdeckung konnte nicht geladen werden." />
      ) : (
        FREQUENCY_ORDER.map((freq) => (
          <ChecklistGroup
            key={freq}
            frequency={freq}
            tasks={groups[freq]}
            showDone={showDone}
            onStartImport={startImport}
            onFullMonthImport={freq === 'range' ? fullMonthImport : undefined}
          />
        ))
      )}

      {/* Konflikt-Dialog VOR der Navigation (Behalten / Ersetzen / Abbrechen) */}
      <AlertDialog open={conflict !== null} onOpenChange={(open) => !open && setConflict(null)}>
        <AlertDialogContent data-testid="checklist-conflict-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Zeitraum bereits (teilweise) importiert</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Für «{conflict?.task.label}» liegen bereits Daten vor
                  {conflict && conflict.coveredDays.length > 0 && (
                    <>
                      {' '}
                      ({conflict.coveredDays.length} Tag{conflict.coveredDays.length === 1 ? '' : 'e'}
                      {conflict.coveredDays.length > 1 && (
                        <>, {formatIsoRange(conflict.coveredDays[0], conflict.coveredDays[conflict.coveredDays.length - 1])}</>
                      )}
                      )
                    </>
                  )}
                  .
                </p>
                <p>
                  «Ersetzen» öffnet den Import — dort entscheidest du im bestehenden Ablauf
                  (mit Vorschau), was mit den vorhandenen Daten geschieht. Hier wird nichts
                  gelöscht oder überschrieben.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="conflict-cancel">Abbrechen</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                setConflict(null);
                toast({ title: 'Bestehende Daten bleiben unverändert.' });
              }}
              data-testid="conflict-keep"
            >
              Bestehende behalten
            </Button>
            <Button
              onClick={() => {
                const href = conflict?.href;
                setConflict(null);
                if (href) navigate(href);
              }}
              data-testid="conflict-replace"
            >
              Zum Import (Ersetzen)
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Gruppen-Karte (eine Frequenz) ────────────────────────────────────────────

function ChecklistGroup({
  frequency,
  tasks,
  showDone,
  onStartImport,
  onFullMonthImport,
}: {
  frequency: TaskFrequency;
  tasks: ImportTask[];
  showDone: boolean;
  onStartImport: (task: ImportTask) => void;
  onFullMonthImport?: (type: ImportTaskType) => void;
}) {
  if (tasks.length === 0) return null;
  const Icon = GROUP_ICON[frequency];
  const open = tasks.filter(isOpenTask);
  const done = tasks.filter((t) => !isOpenTask(t));
  const typesInGroup = TASK_TYPE_DEFS.filter(
    (d) => d.frequency === frequency && tasks.some((t) => t.type === d.type),
  );

  return (
    <Card data-testid={`checklist-group-${frequency}`}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          {FREQUENCY_LABEL[frequency]}
          <span className="text-xs font-normal text-muted-foreground">
            {open.length} offen · {done.length} erledigt
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {typesInGroup.map((def) => (
          <TypeSection
            key={def.type}
            typeLabel={def.label}
            type={def.type}
            tasks={tasks.filter((t) => t.type === def.type)}
            showDone={showDone}
            onStartImport={onStartImport}
            onFullMonthImport={onFullMonthImport}
          />
        ))}
      </CardContent>
    </Card>
  );
}

// ── Typ-Abschnitt innerhalb einer Gruppe ─────────────────────────────────────

function TypeSection({
  type,
  typeLabel,
  tasks,
  showDone,
  onStartImport,
  onFullMonthImport,
}: {
  type: ImportTaskType;
  typeLabel: string;
  tasks: ImportTask[];
  showDone: boolean;
  onStartImport: (task: ImportTask) => void;
  onFullMonthImport?: (type: ImportTaskType) => void;
}) {
  const open = tasks.filter(isOpenTask);
  const done = tasks.filter((t) => !isOpenTask(t));
  const hint = TYPE_HINT[type];
  const allDone = open.length === 0;

  return (
    <div data-testid={`checklist-type-${type}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {typeLabel}
        </span>
        {hint && <InfoTip text={hint} />}
        {allDone && <StatusPill tone="good" size="xs">Vollständig</StatusPill>}
        {onFullMonthImport && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-xs"
            onClick={() => onFullMonthImport(type)}
            data-testid={`checklist-full-month-${type}`}
          >
            <Download className="mr-1 h-3 w-3" /> Ganzer Monat
          </Button>
        )}
      </div>

      {open.length > 0 && (
        <ul className={cn('space-y-1', open.length > 8 && 'max-h-64 overflow-auto pr-1')}>
          {open.map((task) => (
            <TaskRow key={task.id} task={task} onStartImport={onStartImport} />
          ))}
        </ul>
      )}

      {done.length > 0 &&
        (showDone ? (
          <ul className="mt-1 space-y-1">
            {done.map((task) => (
              <TaskRow key={task.id} task={task} onStartImport={onStartImport} />
            ))}
          </ul>
        ) : (
          <Collapsible>
            <CollapsibleTrigger
              className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              data-testid={`checklist-done-toggle-${type}`}
            >
              <ChevronDown className="h-3 w-3" aria-hidden />
              {done.length} erledigt anzeigen
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-1 space-y-1">
                {done.map((task) => (
                  <TaskRow key={task.id} task={task} onStartImport={onStartImport} />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ))}
    </div>
  );
}

// ── Einzelne Aufgaben-Zeile ──────────────────────────────────────────────────

function TaskRow({
  task,
  onStartImport,
}: {
  task: ImportTask;
  onStartImport: (task: ImportTask) => void;
}) {
  const tone: Tone = task.status !== 'done' && task.notYetDue ? 'neutral' : STATUS_TONE[task.status];
  const pillLabel =
    task.status !== 'done' && task.notYetDue ? 'Monat läuft noch' : TASK_STATUS_LABEL[task.status];

  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 py-1.5"
      data-testid={`checklist-task-${task.id}`}
    >
      <span className="min-w-0 flex-1 truncate text-sm">{task.label}</span>
      {task.status === 'partial' && task.expectedDayCount != null && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {task.coveredDayCount}/{task.expectedDayCount} Tagen
        </span>
      )}
      <StatusPill tone={tone} size="xs">
        {pillLabel}
      </StatusPill>
      {task.status === 'error' ? (
        <HintBox tone="critical" className="w-full">
          {task.error ?? 'Abdeckung konnte nicht ermittelt werden.'}
        </HintBox>
      ) : (
        <Button
          variant={isOpenTask(task) ? 'default' : 'outline'}
          size="sm"
          className="h-7 px-2.5 text-xs"
          onClick={() => onStartImport(task)}
          data-testid={`checklist-import-${task.id}`}
        >
          <Download className="mr-1 h-3 w-3" /> Importieren
        </Button>
      )}
    </li>
  );
}
