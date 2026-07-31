/**
 * Zell-Detail «Bedarf vs. Planung» — Pop-up beim Klick auf eine einzelne Zelle
 * (Position × Tag) der Wochen-Vergleichsmatrix.
 *
 * Reine Anzeige (read-only). Alle Zahlen kommen aus derselben Berechnung wie
 * die Matrix (DayPositionHint inkl. assigned-Drill-down aus computeDayPlanHints)
 * — dadurch stimmen Kopfzahl und Personenliste per Konstruktion mit der Zelle
 * überein. Netto-Plan-Stunden mit ArG-Pausenabzug via nettoMinutesForSlots.
 */
import { useMemo } from 'react';
import { format, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { nettoMinutesForSlots } from '@/lib/staffing-check-utils';
import type { AssignedPersonDetail, DayPositionHint } from '@/lib/staffing-day-hints';
import type { PlannedSlot } from '@/lib/staffing-comparison-utils';
import type { Employee } from '@/types/personnel';

const r1 = (v: number) => Math.round(v * 10) / 10;

function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** Schicht-Etikett aus den Slots: Mittag / Abend / durchgehend / Mittag + Abend. */
export function shiftLabelForSlots(slots: PlannedSlot[]): string {
  if (slots.length === 0) return '—';
  if (slots.length === 1) {
    const s = slots[0];
    const start = timeToMin(s.start);
    const end = timeToMin(s.end);
    // Ein Einsatz, der Mittag UND Abend abdeckt → durchgehend.
    if (start < 16 * 60 && end > 18 * 60) return 'durchgehend';
    return start < 16 * 60 ? 'Mittag' : 'Abend';
  }
  return 'Mittag + Abend';
}

const VIA_LABEL: Record<AssignedPersonDetail['via'], string | null> = {
  regel: 'per Regel',
  haupt: null,
  zweit: 'Zweitposition',
  alias: 'Alias',
};

export function WeekCompareCellDialog({
  open, onOpenChange, dateStr, hint, employees, dynamicRuleHint,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** yyyy-MM-dd des angeklickten Tages. */
  dateStr: string | null;
  /** Zeilen-Hinweis der Position an diesem Tag (Quelle = Matrix-Berechnung). */
  hint: DayPositionHint | null;
  /** Für Namensauflösung der zugeordneten Personen. */
  employees: Employee[];
  /** Hinweistext bei Positionen mit dynamischer Regel (CdS, Kalt/Sushi). */
  dynamicRuleHint?: string | null;
}) {
  const nameById = useMemo(
    () => new Map(employees.map((e) => [e.id, e.name])),
    [employees],
  );

  if (!hint || !dateStr) return null;

  const dayLabel = format(parseISO(dateStr), 'EEEE dd.MM.yyyy', { locale: de });
  const diff = hint.diff;
  const diffTone = diff === 0
    ? 'text-emerald-600 dark:text-emerald-400'
    : diff > 0
      ? 'text-red-600 dark:text-red-400'
      : 'text-amber-600 dark:text-amber-400';
  const diffLabel = diff === 0 ? '±0' : diff > 0 ? `+${diff}` : `${diff}`;

  const rows = hint.assigned.map((a) => ({
    ...a,
    name: nameById.get(a.id) ?? a.id,
    nettoMin: nettoMinutesForSlots(a.slots),
  }));
  // Total aus Roh-Minuten, EINMAL gerundet (keine Zeile/Footer-Rundungsdrift).
  const totalNetto = r1(rows.reduce((s, x) => s + x.nettoMin, 0) / 60);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="week-compare-cell-dialog">
        <DialogHeader>
          <DialogTitle>{hint.positionName} — {dayLabel}</DialogTitle>
          <DialogDescription className="sr-only">
            Dienstplan-Detail dieser Position an diesem Tag (nur Anzeige).
          </DialogDescription>
        </DialogHeader>

        {/* Kopfzeile Bedarf vs. Plan mit Ampelfarbe */}
        <div className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm" data-testid="cell-dialog-summary">
          <span>Bedarf <b className="tabular-nums">{hint.soll}</b></span>
          <span className="text-muted-foreground">·</span>
          <span>Plan <b className="tabular-nums">{hint.planned}</b></span>
          <Badge variant="outline" className={cn('ml-auto tabular-nums', diffTone)}>
            {diffLabel}
          </Badge>
        </div>

        {dynamicRuleHint && (
          <div className="flex items-start gap-2 rounded-md border border-sky-300 bg-sky-50 dark:bg-sky-950/20 px-3 py-2 text-xs">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-sky-600" />
            <span>{dynamicRuleHint}</span>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            Für diese Position ist an diesem Tag niemand eingeplant.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground text-left">
                <th className="py-1 pr-2 font-medium">Mitarbeiter</th>
                <th className="py-1 pr-2 font-medium">Zeit</th>
                <th className="py-1 pr-2 font-medium">Schicht</th>
                <th className="py-1 text-right font-medium">Netto h</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-border/50" data-testid={`cell-dialog-emp-${p.id}`}>
                  <td className="py-1 pr-2">
                    <span className="font-medium">{p.name}</span>
                    {VIA_LABEL[p.via] && (
                      <Badge variant="secondary" className="ml-1.5 text-[10px] align-middle">
                        {VIA_LABEL[p.via]}
                      </Badge>
                    )}
                  </td>
                  <td className="py-1 pr-2 tabular-nums whitespace-nowrap">
                    {p.slots.map((s) => `${s.start}–${s.end}`).join(', ')}
                  </td>
                  <td className="py-1 pr-2">{shiftLabelForSlots(p.slots)}</td>
                  <td className="py-1 text-right tabular-nums">{r1(p.nettoMin / 60).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 font-medium" data-testid="cell-dialog-total">
                <td className="py-1 pr-2">{rows.length} Person{rows.length === 1 ? '' : 'en'} (Kopfzahl)</td>
                <td />
                <td className="py-1 pr-2 text-right text-xs text-muted-foreground">Total</td>
                <td className="py-1 text-right tabular-nums">{totalNetto.toFixed(1)}</td>
              </tr>
            </tfoot>
          </table>
        )}

        {diff !== 0 && (
          <p className={cn('text-xs font-medium', diffTone)} data-testid="cell-dialog-diff-hint">
            {diff < 0
              ? `${Math.abs(diff)} Person${Math.abs(diff) === 1 ? '' : 'en'} unter Bedarf`
              : `${diff} Person${diff === 1 ? '' : 'en'} über Bedarf`}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
