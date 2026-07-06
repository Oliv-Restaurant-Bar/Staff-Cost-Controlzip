/**
 * cockpit-ui.tsx — Geteilte, reine Anzeige-Bausteine des Import-Cockpits.
 * =======================================================================
 * Kleine, zustandslose Präsentationskomponenten + Formatter, die von allen drei
 * Tabs (Datenimporte / Kontrollen / Aufgaben) und dem Detail-Drawer genutzt
 * werden. KEINE Datenlogik, KEINE Schreibaktionen — nur Darstellung.
 */

import type { ReactNode } from 'react';
import { format, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  STATUS_LABEL,
  STATUS_BADGE_CLASS,
  STATUS_DOT_CLASS,
  STATUS_HINT,
  IMPORT_TYPE_LABEL,
  IMPORT_TYPE_BADGE_CLASS,
  type CockpitSignal,
  type CockpitSourceId,
  type CockpitStatus,
  type CockpitImportType,
} from '@/lib/import-cockpit';
import {
  CONTROL_STATUS_LABEL,
  CONTROL_STATUS_BADGE_CLASS,
  CONTROL_STATUS_DOT_CLASS,
  CONTROL_STATUS_HINT,
  TASK_PRIORITY_LABEL,
  TASK_PRIORITY_BADGE_CLASS,
  TASK_PRIORITY_DOT_CLASS,
  SECTION_LABEL,
  type ControlStatus,
  type TaskPriority,
  type ImportFileFormat,
} from '@/lib/import-cockpit-tabs';
import type { CockpitSection } from '@/lib/import-cockpit';

// ─── Formatter (nur Anzeige) ──────────────────────────────────────────────────

/** Formatiert einen ISO-Zeitstempel als „dd.MM.yyyy HH:mm" (oder „—"). */
export function formatDateTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    const d = parseISO(ts);
    return Number.isNaN(d.getTime()) ? '—' : format(d, 'dd.MM.yyyy HH:mm', { locale: de });
  } catch {
    return '—';
  }
}

/** „Ist-Daten bis" eines Signals (dataUntil → latestDataDate → null). */
export function dataUntilOf(signal: CockpitSignal): string | null {
  return signal.dataUntil ?? signal.latestDataDate ?? null;
}

/**
 * Hinweis, welche Daten je Quelle für die Vollständigkeit zählen (Drawer).
 * Reiner Anzeigetext — keine Prozesslogik.
 */
export const COMPLETENESS_NOTE: Partial<Record<CockpitSourceId, string>> = {
  mirus:
    '„Ist-Daten bis" ist das Ende der zuletzt erfolgreich importierten Mirus-Periode aus der Import-Historie — nicht das späteste einzelne Tagesdatum. Einzelne, spätere Tageszeilen (z. B. nach dem Monatsende) gelten NICHT als vollständig importierte Periode.',
  tagesumsatz:
    'Es zählen nur Tage mit echtem Ist-Umsatz (> 0). Zukünftige Tage werden nicht als vollständiger Import gewertet.',
};

// ─── KPI-Kachel ───────────────────────────────────────────────────────────────

export interface KpiCardProps {
  label: string;
  value: number;
  icon: ReactNode;
  accent: string;
  /** Optional: macht die Kachel klickbar (Toggle-Filter). */
  onClick?: () => void;
  /** Optional: markiert die Kachel als aktiven Filter. */
  active?: boolean;
}

export function KpiCard({ label, value, icon, accent, onClick, active = false }: KpiCardProps) {
  const content = (
    <CardContent className="flex items-center gap-3 p-4">
      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', accent)}>{icon}</div>
      <div className="min-w-0 text-left">
        <div className="text-2xl font-bold leading-none tabular-nums">{value}</div>
        <div className="mt-1 truncate text-xs text-muted-foreground">{label}</div>
      </div>
    </CardContent>
  );

  if (!onClick) {
    return <Card className="border-border/70">{content}</Card>;
  }

  return (
    <Card
      className={cn(
        'border-border/70 transition-colors',
        active ? 'border-primary ring-2 ring-primary/60 bg-primary/5' : 'hover:border-primary/40 hover:bg-muted/40',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        title={active ? 'Filter aufheben' : `Nur „${label}" anzeigen`}
        className="block w-full cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {content}
      </button>
    </Card>
  );
}

// ─── Badges ───────────────────────────────────────────────────────────────────

/** Frische-Status einer Import-Datenquelle (grün/gelb/rot/grau) mit Tooltip. */
export function StatusBadge({ status }: { status: CockpitStatus }) {
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

/** Status einer wiederkehrenden Kontrolle mit Tooltip. */
export function ControlStatusBadge({ status }: { status: ControlStatus }) {
  const badge = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        CONTROL_STATUS_BADGE_CLASS[status],
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', CONTROL_STATUS_DOT_CLASS[status])} />
      {CONTROL_STATUS_LABEL[status]}
    </span>
  );

  const hint = CONTROL_STATUS_HINT[status];
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

/** Priorität einer offenen Aufgabe (Dringend / Offen). */
export function TaskPriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        TASK_PRIORITY_BADGE_CLASS[priority],
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', TASK_PRIORITY_DOT_CLASS[priority])} />
      {TASK_PRIORITY_LABEL[priority]}
    </span>
  );
}

/**
 * Kompakte Dateiformat-Badges eines Datei-Uploads (z. B. „CSV" + „PDF").
 * Formate kommen aus der reinen Ableitung `importFileFormats` — hier nur Anzeige.
 */
export function FileFormatBadges({ formats }: { formats: ImportFileFormat[] }) {
  if (formats.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {formats.map((f) => (
        <span
          key={f}
          className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground whitespace-nowrap"
        >
          {f}
        </span>
      ))}
    </span>
  );
}

/** Kleines Import-Art-Badge (unabhängig von den Status-Farben). */
export function ImportTypeBadge({ type }: { type: CockpitImportType }) {
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

/** Herkunfts-Sektion einer Aufgabe (Datenimport / Kontrolle). */
export function SectionBadge({ section }: { section: CockpitSection }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground whitespace-nowrap">
      {SECTION_LABEL[section]}
    </span>
  );
}

// ─── Detail-Zeile (Drawer) ────────────────────────────────────────────────────

export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
