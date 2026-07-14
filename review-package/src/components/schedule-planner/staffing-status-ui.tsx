/**
 * staffing-status-ui — geteilte Darstellungsbausteine für den
 * Personalbedarf-Abgleich (Warnlogik NUR Anzeige).
 *
 * 2-Farben-Warnlogik: „optimal" ist grün, JEDE Abweichung (über- ODER
 * unterbesetzt) ist rot. Die Richtung wird über das Status-Label
 * (Überbesetzt / Unterbesetzt) und den Differenztext unterschieden.
 *
 * Enthält: Status-Stilklassen, Status-Badge, Differenz-Tooltip und die
 * KPI-Kacheln. Alle Zahlen kommen aus den reinen Funktionen in
 * `staffing-comparison-utils` — hier wird nichts berechnet oder geladen.
 */
import type { ReactNode } from 'react';

import {
  statusLabel,
  formatStaffingDiffPersons,
  staffingTooltipLines,
  type ComparisonStatus,
  type StaffingKpiSummary,
  type StaffingTooltipData,
} from '@/lib/staffing-comparison-utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// ─── Status-Stile (über- & unterbesetzt teilen sich Rot) ──────────────────────

export const STATUS_PILL: Record<ComparisonStatus, string> = {
  optimal:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  overstaffed:
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  understaffed:
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
};

export const STATUS_DOT: Record<ComparisonStatus, string> = {
  optimal: 'bg-emerald-500',
  overstaffed: 'bg-red-500',
  understaffed: 'bg-red-500',
};

export const STATUS_TEXT: Record<ComparisonStatus, string> = {
  optimal: 'text-emerald-700 dark:text-emerald-300',
  overstaffed: 'text-red-700 dark:text-red-300',
  understaffed: 'text-red-700 dark:text-red-300',
};

// ─── Status-Badge (Optimal / Überbesetzt / Unterbesetzt) ──────────────────────

export function StaffingStatusBadge({
  status,
  diff,
  size = 'sm',
  showDiff = false,
}: {
  status: ComparisonStatus;
  diff: number;
  size?: 'sm' | 'xs';
  showDiff?: boolean;
}) {
  const sizing =
    size === 'xs' ? 'gap-1 px-1.5 py-px text-[10px]' : 'gap-1.5 px-2 py-0.5 text-xs';
  const dot = size === 'xs' ? 'h-1.5 w-1.5' : 'h-2 w-2';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border font-medium whitespace-nowrap',
        sizing,
        STATUS_PILL[status],
      )}
    >
      <span className={cn('rounded-full', dot, STATUS_DOT[status])} aria-hidden />
      {statusLabel(status)}
      {showDiff && diff !== 0 && (
        <span className="tabular-nums">· {formatStaffingDiffPersons(diff)}</span>
      )}
    </span>
  );
}

// ─── Differenz-Tooltip ────────────────────────────────────────────────────────

/**
 * Umschließt einen Trigger (z.B. die Differenz-Zelle) mit einem Tooltip, der
 * Benötigt/Geplant/Differenz/Berechnungsgrundlage zeigt (Umsatz/Produktivität
 * nur, wenn Werte in `data` vorhanden sind — dieses Modul führt keine
 * Umsatzquelle). TooltipProvider ist app-weit gemountet.
 */
export function StaffingDiffTooltip({
  data,
  children,
}: {
  data: StaffingTooltipData;
  children: ReactNode;
}) {
  const lines = staffingTooltipLines(data);
  const basis = lines.find((l) => l.label === 'Berechnungsgrundlage');
  const rows = lines.filter((l) => l.label !== 'Berechnungsgrundlage');
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-[16rem] p-0">
        <div className="space-y-1 px-3 py-2">
          {rows.map((l) => (
            <div
              key={l.label}
              className="flex items-baseline justify-between gap-4 text-xs"
            >
              <span className="text-muted-foreground">{l.label}</span>
              <span className="font-medium tabular-nums">{l.value}</span>
            </div>
          ))}
          {basis && (
            <p className="border-t pt-1 text-[11px] leading-snug text-muted-foreground">
              {basis.value}
            </p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Differenz als Text mit Tooltip (gepunktete Unterstreichung als Hinweis). */
export function StaffingDiffCell({
  data,
  className,
}: {
  data: StaffingTooltipData;
  className?: string;
}) {
  return (
    <StaffingDiffTooltip data={data}>
      <span
        tabIndex={0}
        className={cn(
          'cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 tabular-nums outline-none',
          className,
        )}
      >
        {formatStaffingDiffPersons(data.diff)}
      </span>
    </StaffingDiffTooltip>
  );
}

// ─── KPI-Kacheln ──────────────────────────────────────────────────────────────

type Tone = 'green' | 'red' | 'neutral';

const TONE_STYLE: Record<Tone, { card: string; value: string; label: string }> = {
  green: {
    card: 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20',
    value: 'text-emerald-700 dark:text-emerald-300',
    label: 'text-emerald-800/70 dark:text-emerald-300/70',
  },
  red: {
    card: 'border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20',
    value: 'text-red-700 dark:text-red-300',
    label: 'text-red-800/70 dark:text-red-300/70',
  },
  neutral: {
    card: 'border-border bg-muted/30',
    value: 'text-foreground',
    label: 'text-muted-foreground',
  },
};

function formatHours(h: number): string {
  const rounded = Math.round(h * 10) / 10;
  const str = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',');
  return `${str} h`;
}

function KpiCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub: string;
  tone: Tone;
}) {
  const s = TONE_STYLE[tone];
  return (
    <div className={cn('rounded-lg border px-3 py-2', s.card)}>
      <p className={cn('text-[11px] font-medium uppercase tracking-wide', s.label)}>{label}</p>
      <p className={cn('mt-0.5 text-xl font-semibold tabular-nums leading-none', s.value)}>
        {value}
      </p>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{sub}</p>
    </div>
  );
}

/**
 * Vier KPI-Kacheln über dem Abgleich: Optimal / Überbesetzt / Unterbesetzt
 * (Anzahl Bedarfs-Schichten des Tages) + Überstunden-Potenzial (Personen-
 * Stunden aus Unterbesetzung). Reine Anzeige der `StaffingKpiSummary`.
 */
export function StaffingKpiCards({ kpis }: { kpis: StaffingKpiSummary }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <KpiCard
        label="Optimal"
        value={kpis.optimal}
        sub="Bedarfs-Schichten exakt erfüllt"
        tone={kpis.optimal > 0 ? 'green' : 'neutral'}
      />
      <KpiCard
        label="Überbesetzt"
        value={kpis.overstaffed}
        sub={
          kpis.overstaffPersonShifts > 0
            ? `${kpis.overstaffPersonShifts} Personen-Schichten zu viel`
            : 'keine Überbesetzung'
        }
        tone={kpis.overstaffed > 0 ? 'red' : 'neutral'}
      />
      <KpiCard
        label="Unterbesetzt"
        value={kpis.understaffed}
        sub={
          kpis.understaffPersonShifts > 0
            ? `${kpis.understaffPersonShifts} Personen-Schichten zu wenig`
            : 'keine Unterbesetzung'
        }
        tone={kpis.understaffed > 0 ? 'red' : 'neutral'}
      />
      <KpiCard
        label="Überstunden-Potenzial"
        value={formatHours(kpis.overtimePotentialHours)}
        sub="fehlende Personen-Stunden (Unterbesetzung)"
        tone={kpis.overtimePotentialHours > 0 ? 'red' : 'neutral'}
      />
    </div>
  );
}
