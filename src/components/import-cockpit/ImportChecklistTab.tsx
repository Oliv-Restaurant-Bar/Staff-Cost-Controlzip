/**
 * ImportChecklistTab — die drei Aufgaben-Bereiche des Import-Cockpits.
 * ====================================================================
 * Ruhige Cockpit-Ansicht in drei gestapelten Bereichen (der vierte Bereich
 * «Datenstand» liegt auf der Page):
 *
 *   1. «Heute»        — jetzt fällige Aufgaben (Fehler → überfällig → heute),
 *                       nur im aktuellen Monat. Unterdrückte Aufgaben (z. B.
 *                       Tagesabschluss wartet auf Z-Bericht) mahnen nicht.
 *   2. «Diese Woche»  — wöchentliche Aufgaben, die erst später fällig werden,
 *                       plus wöchentliche Kontrollen.
 *   3. «Dieser Monat» — Monats-Fortschritt, alle Aufgaben des gewählten Monats
 *                       nach Rhythmus gruppiert, Inventur-Häkchen und
 *                       monatliche Kontrollen. Monatsauswahl zum Nachprüfen
 *                       vergangener Monate (dann werden «Heute»/«Diese Woche»
 *                       ausgeblendet — sie beziehen sich auf den aktuellen Monat).
 *
 * Aufgaben entstehen aus Abdeckung (import-tasks-db) + effektiven Einstellungen
 * (import-settings: Frequenz, Karenz, Ruhetage) über die Engine
 * import-tasks-engine — hier wird NIE direkt geschrieben (einzige Ausnahme:
 * das Inventur-Häkchen läuft über den Page-Handler, nicht über Importdaten).
 *
 * Konflikt-Schutz: Liegt im Zielzeitraum bereits etwas vor, erscheint VOR der
 * Navigation ein Dialog (Behalten / Ersetzen / Abbrechen). Das eigentliche
 * Ersetzen bleibt im bestehenden Import-Flow der Zielseite.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays,
  CalendarRange,
  CalendarCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  ChevronDown,
  Loader2,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
import { TONE_DOT, TONE_TEXT, type Tone } from '@/components/ui/tones';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import {
  buildImportTasks,
  buildImportTarget,
  buildFullMonthTask,
  checkImportConflict,
  getTaskTypeDef,
  groupImportTasks,
  isOpenTask,
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
import {
  computeMonthProgress,
  getTodayTasks,
  prioritizeTasks,
  summarizeTypeCompletion,
  monthKey,
  CLOSURE_LABEL,
  CLOSURE_TONE,
  type TaskDueInfo,
  type TypeCompletionStatus,
} from '@/lib/import-tasks-priority';
import type { EffectiveImportSettings } from '@/lib/import-settings';
import { formatCockpitDate, type CockpitSourceId } from '@/lib/import-cockpit';
import type { ControlRow } from '@/lib/import-cockpit-tabs';
import { ControlStatusBadge } from './cockpit-ui';
import type { MonthProgressMap } from '@/hooks/useImportMonthProgress';

// ── Status → Ton (zentrale tones.ts-Semantik) ────────────────────────────────

const STATUS_TONE: Record<ImportTask['status'], Tone> = {
  open: 'warn',
  partial: 'warn',
  done: 'good',
  error: 'critical',
};

const GROUP_ICON: Record<TaskFrequency, typeof CalendarDays> = {
  daily: CalendarDays,
  weekly: CalendarRange,
  monthly: CalendarCheck,
};

const TYPE_SUMMARY_TONE: Record<TypeCompletionStatus, Tone> = {
  done: 'good',
  open: 'warn',
  later: 'neutral',
  error: 'critical',
};

const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/** UI-Hinweise pro Typ (nur Anzeige — keine Logik). */
const TYPE_HINT: Partial<Record<ImportTaskType, string>> = {
  zbericht:
    'Konfigurierte Ruhetage (Einstellungen) erzeugen keine Tagesaufgaben. Alle anderen Tage bleiben offen, solange kein Z-Bericht für den Tag importiert wurde.',
  tagesabschluss:
    'Wartet pro Tag auf den importierten Z-Bericht — Tage ohne Z-Bericht mahnen hier nicht, die Hauptwarnung trägt der Z-Bericht.',
  reservationen:
    'Tage ohne Reservationen gelten als abgedeckt, sobald ein Importlauf den Zeitraum umfasste.',
  inventur:
    'Manuelles Monats-Häkchen — es gibt keinen Datei-Import. Erledigt heisst: Inventur für den Monat durchgeführt.',
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
  settings,
  onPeriodChange,
  monthProgress,
  monthProgressLoading,
  onLoadYearProgress,
  weeklyControls,
  monthlyControls,
  onSelectControl,
  onMarkControlDone,
  onToggleInventur,
  inventurSaving,
}: {
  year: number;
  /** 1–12 */
  month: number;
  /** yyyy-MM-dd */
  today: string;
  coverage: MonthCoverage | null;
  loading: boolean;
  /** Effektive Import-Einstellungen (Frequenzen/Karenz/Ruhetage). */
  settings: EffectiveImportSettings;
  onPeriodChange: (year: number, month: number) => void;
  /** Fortschritt pro Monat (Key yyyy-MM); null = Ladefehler des Monats. */
  monthProgress?: MonthProgressMap;
  monthProgressLoading?: boolean;
  /** Lazy-Loader für die Monatsauswahl (lädt fehlende Monate eines Jahres). */
  onLoadYearProgress?: (year: number) => void;
  /** Wöchentliche Kontrollen → Bereich «Diese Woche». */
  weeklyControls: ControlRow[];
  /** Monatliche Kontrollen → Bereich «Dieser Monat». */
  monthlyControls: ControlRow[];
  onSelectControl: (id: CockpitSourceId) => void;
  onMarkControlDone: (ids: CockpitSourceId[]) => void;
  /** Inventur-Häkchen für den ANGEZEIGTEN Monat setzen/entfernen. */
  onToggleInventur: (done: boolean) => void;
  inventurSaving?: boolean;
}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [showDone, setShowDone] = useState(false);
  const [conflict, setConflict] = useState<PendingConflict | null>(null);

  const tasks = useMemo(
    () => (coverage ? buildImportTasks({ year, month, today }, coverage, settings) : []),
    [coverage, year, month, today, settings],
  );
  const groups = useMemo(() => groupImportTasks(tasks), [tasks]);
  const progress = useMemo(
    () => computeMonthProgress(tasks, { year, month, today }),
    [tasks, year, month, today],
  );
  const typeSummary = useMemo(() => summarizeTypeCompletion(tasks, today), [tasks, today]);
  const todayTasks = useMemo(() => getTodayTasks(tasks, today), [tasks, today]);

  /** Unterdrückte offene Aufgaben (warten auf Basis-Quelle) — Info, keine Mahnung. */
  const suppressedOpen = useMemo(
    () => tasks.filter((t) => t.suppressedBy && t.status !== 'done' && t.status !== 'error'),
    [tasks],
  );

  /** Wöchentliche Aufgaben, die erst später fällig werden (laufende Woche). */
  const weekLaterTasks = useMemo(
    () =>
      prioritizeTasks(groups.weekly.filter(isOpenTask), today).filter(
        (p) => p.due.urgency === 'later',
      ),
    [groups.weekly, today],
  );

  const isCurrentMonth = useMemo(() => {
    const now = today.slice(0, 7);
    return now === monthKey(year, month);
  }, [today, year, month]);

  const shiftMonth = (delta: number) => {
    const idx = year * 12 + (month - 1) + delta;
    onPeriodChange(Math.floor(idx / 12), (idx % 12) + 1);
  };

  const goToCurrentMonth = () =>
    onPeriodChange(Number(today.slice(0, 4)), Number(today.slice(5, 7)));

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

  if (loading && !coverage) {
    return <LoadingState label="Abdeckung wird ermittelt …" />;
  }
  if (!coverage) {
    return <EmptyState title="Keine Daten" description="Die Abdeckung konnte nicht geladen werden." />;
  }

  return (
    <div className="space-y-6" data-testid="import-checklist">
      {!isCurrentMonth && (
        <div data-testid="checklist-past-month-hint">
          <HintBox tone="info">
            <span className="flex flex-wrap items-center gap-2">
              Monatsansicht {monthLabel(year, month)} — «Heute» und «Diese Woche» beziehen sich
              auf den aktuellen Monat.
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                onClick={goToCurrentMonth}
                data-testid="checklist-today"
              >
                Zum aktuellen Monat
              </Button>
            </span>
          </HintBox>
        </div>
      )}

      {/* ── Bereich «Heute» ──────────────────────────────────────────────── */}
      {isCurrentMonth && (
        <section className="space-y-2" data-testid="cockpit-section-heute">
          <SectionHeading icon={Sun} label="Heute" />
          <Card data-testid="checklist-today-card">
            <CardContent className="pt-4">
              {todayTasks.length === 0 ? (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="checklist-today-empty">
                  <CheckCircle2 className={cn('h-4 w-4', TONE_TEXT.good)} aria-hidden />
                  Für heute ist alles erledigt.
                </p>
              ) : (
                <ul className={cn('space-y-1', todayTasks.length > 8 && 'max-h-72 overflow-auto pr-1')}>
                  {todayTasks.map((p) => (
                    <TaskRow key={p.task.id} task={p.task} due={p.due} onStartImport={startImport} />
                  ))}
                </ul>
              )}
              {suppressedOpen.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground" data-testid="checklist-suppressed-hint">
                  {suppressedOpen.length} Aufgabe{suppressedOpen.length === 1 ? '' : 'n'} wartet
                  {suppressedOpen.length === 1 ? '' : 'en'} auf eine Basis-Quelle (z. B.
                  Tagesabschluss auf den Z-Bericht) und {suppressedOpen.length === 1 ? 'mahnt' : 'mahnen'} nicht.
                </p>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      {/* ── Bereich «Diese Woche» ────────────────────────────────────────── */}
      {isCurrentMonth && (
        <section className="space-y-2" data-testid="cockpit-section-woche">
          <SectionHeading icon={CalendarRange} label="Diese Woche" />
          <Card data-testid="checklist-week-card">
            <CardContent className="space-y-3 pt-4">
              {weekLaterTasks.length === 0 && weeklyControls.length === 0 ? (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="checklist-week-empty">
                  <CheckCircle2 className={cn('h-4 w-4', TONE_TEXT.good)} aria-hidden />
                  Diese Woche steht nichts weiter an.
                </p>
              ) : (
                <>
                  {weekLaterTasks.length > 0 && (
                    <ul className="space-y-1">
                      {weekLaterTasks.map((p) => (
                        <TaskRow key={p.task.id} task={p.task} due={p.due} onStartImport={startImport} />
                      ))}
                    </ul>
                  )}
                  <ControlChecklistList
                    rows={weeklyControls}
                    onSelect={onSelectControl}
                    onMarkDone={onMarkControlDone}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      {/* ── Bereich «Dieser Monat» ───────────────────────────────────────── */}
      <section className="space-y-2" data-testid="cockpit-section-monat">
        <div className="flex flex-wrap items-center gap-2">
          <SectionHeading icon={CalendarCheck} label="Dieser Monat" />
          <div className="ml-auto flex flex-wrap items-center gap-2">
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
              <MonthPicker
                year={year}
                month={month}
                today={today}
                monthProgress={monthProgress}
                monthProgressLoading={monthProgressLoading}
                onLoadYearProgress={onLoadYearProgress}
                onPeriodChange={onPeriodChange}
              />
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
            </div>
            <div className="flex items-center gap-2">
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
        </div>

        {/* Fortschrittskarte: Importstatus des Monats */}
        <Card data-testid="checklist-progress-card">
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              Importstatus {monthLabel(year, month)}
              <span data-testid="checklist-closure-pill">
                <StatusPill tone={CLOSURE_TONE[progress.closure]} size="xs">
                  {CLOSURE_LABEL[progress.closure]}
                </StatusPill>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            <div className="flex items-center gap-3">
              <Progress value={progress.percent ?? 0} className="h-2 flex-1" />
              <span className="shrink-0 text-sm font-semibold tabular-nums">
                {progress.percent ?? 0} %
              </span>
            </div>
            <p className="text-xs text-muted-foreground" data-testid="checklist-progress-label">
              {progress.done} von {progress.total} fälligen Aufgaben erledigt
              {progress.laterOpen > 0 && (
                <> · {progress.laterOpen} noch nicht fällig</>
              )}
            </p>

            {/* Kompakte Typ-Zusammenfassung */}
            <div className="flex flex-wrap gap-x-4 gap-y-1" data-testid="checklist-type-summary">
              {typeSummary.map((s) => (
                <span key={s.type} className="inline-flex items-center gap-1.5 text-xs">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', TONE_DOT[TYPE_SUMMARY_TONE[s.status]])} aria-hidden />
                  <span className={s.status === 'done' ? 'text-muted-foreground' : undefined}>{s.label}</span>
                  {s.detail && (
                    <span className={cn('tabular-nums', TONE_TEXT[TYPE_SUMMARY_TONE[s.status]])}>{s.detail}</span>
                  )}
                </span>
              ))}
            </div>

            {progress.allDone ? (
              <div data-testid="checklist-complete-message">
                <HintBox tone="good">
                  Alle Importaufgaben für {monthLabel(year, month)} abgeschlossen.
                  {progress.monthOver && ' Der Monat ist vollständig importiert und kann abgeschlossen werden.'}
                </HintBox>
              </div>
            ) : progress.monthOver && progress.done > 0 ? (
              <div data-testid="checklist-closure-hint">
                <HintBox tone="warn">
                  {monthLabel(year, month)} kann noch nicht abgeschlossen werden —{' '}
                  {progress.openNow} Aufgabe{progress.openNow === 1 ? '' : 'n'} offen.
                </HintBox>
              </div>
            ) : progress.percent === 100 && progress.laterOpen > 0 ? (
              <div data-testid="checklist-due-done-message">
                <HintBox tone="info">
                  Alle fälligen Aufgaben erledigt — Monatsimporte folgen nach Monatsende.
                </HintBox>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Aufgaben nach Rhythmus gruppiert */}
        {FREQUENCY_ORDER.map((freq) => (
          <ChecklistGroup
            key={freq}
            frequency={freq}
            tasks={groups[freq]}
            today={today}
            showDone={showDone}
            onStartImport={startImport}
            onFullMonthImport={fullMonthImport}
            onToggleInventur={onToggleInventur}
            inventurSaving={inventurSaving}
          />
        ))}

        {/* Monatliche Kontrollen — beziehen sich auf «jetzt», nur im aktuellen Monat. */}
        {isCurrentMonth && monthlyControls.length > 0 && (
          <Card data-testid="checklist-monthly-controls">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
                Monatliche Kontrollen
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ControlChecklistList
                rows={monthlyControls}
                onSelect={onSelectControl}
                onMarkDone={onMarkControlDone}
              />
            </CardContent>
          </Card>
        )}
      </section>

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

// ── Bereichs-Überschrift ─────────────────────────────────────────────────────

function SectionHeading({ icon: Icon, label }: { icon: typeof Sun; label: string }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold">
      <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
      {label}
    </h2>
  );
}

// ── Kompakte Kontroll-Liste (Bereiche «Diese Woche»/«Dieser Monat»/«Datenstand») ──

export function ControlChecklistList({
  rows,
  onSelect,
  onMarkDone,
}: {
  rows: ControlRow[];
  onSelect: (id: CockpitSourceId) => void;
  onMarkDone: (ids: CockpitSourceId[]) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-1" data-testid="control-checklist">
      {rows.map((row) => {
        const canMarkDone =
          row.def.checkable &&
          (row.controlStatus === 'overdue' ||
            row.controlStatus === 'due_today' ||
            row.controlStatus === 'due_soon');
        return (
          <li
            key={row.def.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 py-1.5"
            data-testid={`control-item-${row.def.id}`}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
              onClick={() => onSelect(row.def.id)}
              data-testid={`control-open-${row.def.id}`}
            >
              {row.def.label}
            </button>
            {row.result.nextDue && (
              <span className="text-xs tabular-nums text-muted-foreground">
                fällig {formatCockpitDate(row.result.nextDue)}
              </span>
            )}
            <ControlStatusBadge status={row.controlStatus} />
            {canMarkDone && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => onMarkDone([row.def.id])}
                data-testid={`control-done-${row.def.id}`}
              >
                <CheckCircle2 className="mr-1 h-3 w-3" /> Erledigt
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── Monatsauswahl mit Fortschritt pro Monat ──────────────────────────────────

function MonthPicker({
  year,
  month,
  today,
  monthProgress,
  monthProgressLoading,
  onLoadYearProgress,
  onPeriodChange,
}: {
  year: number;
  month: number;
  today: string;
  monthProgress?: MonthProgressMap;
  monthProgressLoading?: boolean;
  onLoadYearProgress?: (year: number) => void;
  onPeriodChange: (year: number, month: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(year);
  const currentKey = today.slice(0, 7);
  const selectedKey = monthKey(year, month);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setPickerYear(year);
      onLoadYearProgress?.(year);
    }
  };

  const changePickerYear = (delta: number) => {
    const next = pickerYear + delta;
    setPickerYear(next);
    onLoadYearProgress?.(next);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 min-w-[10.5rem] justify-between gap-1 px-2.5 text-sm font-semibold tabular-nums"
          data-testid="checklist-month-label"
        >
          {monthLabel(year, month)}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start" data-testid="checklist-month-picker">
        <div className="mb-1 flex items-center justify-between px-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => changePickerYear(-1)}
            aria-label="Vorheriges Jahr"
            data-testid="checklist-picker-prev-year"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-semibold tabular-nums">{pickerYear}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => changePickerYear(1)}
            aria-label="Nächstes Jahr"
            data-testid="checklist-picker-next-year"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <ul className="space-y-0.5">
          {MONTH_NAMES.map((name, i) => {
            const m = i + 1;
            const key = monthKey(pickerYear, m);
            const isFuture = key > currentKey;
            const entry = monthProgress?.[key];
            return (
              <li key={key}>
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent',
                    key === selectedKey && 'bg-accent font-semibold',
                  )}
                  onClick={() => {
                    setOpen(false);
                    onPeriodChange(pickerYear, m);
                  }}
                  data-testid={`checklist-month-option-${key}`}
                >
                  <span>{name}</span>
                  <span className="inline-flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                    {isFuture ? (
                      <>Noch nicht begonnen</>
                    ) : entry === undefined ? (
                      monthProgressLoading ? (
                        <Loader2 className="h-3 w-3 animate-spin" aria-label="lädt" />
                      ) : (
                        <>–</>
                      )
                    ) : entry === null ? (
                      <span className={TONE_TEXT.critical}>Fehler</span>
                    ) : (
                      <>
                        <span
                          className={cn('h-2 w-2 rounded-full', TONE_DOT[CLOSURE_TONE[entry.closure]])}
                          aria-hidden
                        />
                        {entry.percent ?? 0} %
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

// ── Gruppen-Karte (eine Frequenz) ────────────────────────────────────────────

function ChecklistGroup({
  frequency,
  tasks,
  today,
  showDone,
  onStartImport,
  onFullMonthImport,
  onToggleInventur,
  inventurSaving,
}: {
  frequency: TaskFrequency;
  tasks: ImportTask[];
  today: string;
  showDone: boolean;
  onStartImport: (task: ImportTask) => void;
  onFullMonthImport: (type: ImportTaskType) => void;
  onToggleInventur: (done: boolean) => void;
  inventurSaving?: boolean;
}) {
  if (tasks.length === 0) return null;
  const Icon = GROUP_ICON[frequency];
  const open = tasks.filter((t) => isOpenTask(t) || (t.suppressedBy && t.status !== 'done'));
  const done = tasks.filter((t) => t.status === 'done');
  const typesInGroup = TASK_TYPE_DEFS.filter((d) => tasks.some((t) => t.type === d.type));

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
            today={today}
            showDone={showDone}
            onStartImport={onStartImport}
            onFullMonthImport={onFullMonthImport}
            onToggleInventur={onToggleInventur}
            inventurSaving={inventurSaving}
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
  today,
  showDone,
  onStartImport,
  onFullMonthImport,
  onToggleInventur,
  inventurSaving,
}: {
  type: ImportTaskType;
  typeLabel: string;
  tasks: ImportTask[];
  today: string;
  showDone: boolean;
  onStartImport: (task: ImportTask) => void;
  onFullMonthImport: (type: ImportTaskType) => void;
  onToggleInventur: (done: boolean) => void;
  inventurSaving?: boolean;
}) {
  // Offene Aufgaben priorisiert: Fehler → überfällig → heute → später.
  // Unterdrückte Aufgaben («wartet auf Basis-Quelle») erscheinen dezent mit.
  const open = prioritizeTasks(
    tasks.filter((t) => isOpenTask(t) || (t.suppressedBy && t.status !== 'done')),
    today,
  );
  const done = tasks.filter((t) => t.status === 'done');
  const hint = TYPE_HINT[type];
  const allDone = open.length === 0;
  // «Ganzer Monat»-Import nur für Tages-Quellen (Monats-Quellen haben keinen Tages-Upload).
  const canFullMonth = getTaskTypeDef(type).coverageKind === 'days';

  return (
    <div data-testid={`checklist-type-${type}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {typeLabel}
        </span>
        {hint && <InfoTip text={hint} />}
        {allDone && <StatusPill tone="good" size="xs">Vollständig</StatusPill>}
        {canFullMonth && (
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
          {open.map((p) => (
            <TaskRow
              key={p.task.id}
              task={p.task}
              due={p.due}
              onStartImport={onStartImport}
              onToggleInventur={onToggleInventur}
              inventurSaving={inventurSaving}
            />
          ))}
        </ul>
      )}

      {done.length > 0 &&
        (showDone ? (
          <ul className="mt-1 space-y-1">
            {done.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onStartImport={onStartImport}
                onToggleInventur={onToggleInventur}
                inventurSaving={inventurSaving}
              />
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
                  <TaskRow
                    key={task.id}
                    task={task}
                    onStartImport={onStartImport}
                    onToggleInventur={onToggleInventur}
                    inventurSaving={inventurSaving}
                  />
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
  due,
  onStartImport,
  onToggleInventur,
  inventurSaving,
}: {
  task: ImportTask;
  /** Fälligkeits-Info (nur für offene Aufgaben übergeben). */
  due?: TaskDueInfo;
  onStartImport: (task: ImportTask) => void;
  /** Nur für die Inventur-Zeile: manuelles Monats-Häkchen statt Import-Button. */
  onToggleInventur?: (done: boolean) => void;
  inventurSaving?: boolean;
}) {
  const suppressed = !!task.suppressedBy && task.status !== 'done';
  const tone: Tone = suppressed
    ? 'neutral'
    : task.status !== 'done' && task.notYetDue
      ? 'neutral'
      : STATUS_TONE[task.status];
  const pillLabel = suppressed
    ? 'Wartet'
    : task.status !== 'done' && task.notYetDue
      ? 'Monat läuft noch'
      : TASK_STATUS_LABEL[task.status];
  const dueLabel = task.status !== 'done' && task.status !== 'error' ? due?.dueLabel : null;
  const isInventur = task.type === 'inventur' && onToggleInventur !== undefined;

  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 py-1.5',
        suppressed && 'opacity-70',
      )}
      data-testid={`checklist-task-${task.id}`}
    >
      <span className="min-w-0 flex-1 truncate text-sm">{task.label}</span>
      {task.status === 'partial' && task.expectedDayCount != null && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {task.coveredDayCount}/{task.expectedDayCount} Tagen
        </span>
      )}
      {dueLabel && (
        <span
          className={cn(
            'text-xs tabular-nums',
            TONE_TEXT[due?.urgency === 'overdue' && !suppressed ? 'warn' : due?.urgency === 'today' ? 'info' : 'neutral'],
          )}
        >
          {dueLabel}
        </span>
      )}
      <StatusPill tone={tone} size="xs">
        {pillLabel}
      </StatusPill>
      {task.status === 'error' ? (
        <HintBox tone="critical" className="w-full">
          {task.error ?? 'Abdeckung konnte nicht ermittelt werden.'}
        </HintBox>
      ) : isInventur ? (
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <Checkbox
            checked={task.status === 'done'}
            disabled={inventurSaving}
            onCheckedChange={(checked) => onToggleInventur(checked === true)}
            data-testid="checklist-inventur-check"
          />
          Erledigt
        </label>
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
