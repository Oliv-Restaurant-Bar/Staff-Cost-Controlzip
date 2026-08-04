/**
 * Zell-Detail «Bedarf vs. Planung» — Pop-up beim Klick auf eine einzelne Zelle
 * (Position × Tag) der Wochen-Vergleichsmatrix.
 *
 * Reine Anzeige (read-only). Alle Zahlen kommen aus derselben Berechnung wie
 * die Matrix (DayPositionHint inkl. assigned-Drill-down aus computeDayPlanHints)
 * — dadurch stimmen Kopfzahl und Personenliste per Konstruktion mit der Zelle
 * überein. Netto-Plan-Stunden mit ArG-Pausenabzug via nettoMinutesForSlots.
 */
import { useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Info, UserPlus, UserMinus, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { addProposal, type SchedulePlanProposal } from '@/lib/schedule-proposal-store';
import { employeeCanCover } from '@/lib/position-utils';
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
  tenantId, conflictFor, openProposals, onProposalsChanged, readOnly,
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
  /** Aktiviert die Vorschlags-Aktionen (einplanen/streichen); ohne tenantId nur Anzeige. */
  tenantId?: string;
  /**
   * Konfliktprüfung: bestehende Planung/Absenz der Person an DIESEM Tag als
   * Beschreibung («bereits geplant: Service, 11:00–14:00» / «als FE eingetragen»),
   * null = frei.
   */
  conflictFor?: (employeeId: string) => string | null;
  /** Offene Vorschläge DIESER Zelle (Anzeige + Dedupe-Hinweis). */
  openProposals?: SchedulePlanProposal[];
  /** Nach Anlegen eines Vorschlags (Badge/Matrix-Marker aktualisieren). */
  onProposalsChanged?: () => void;
  readOnly?: boolean;
}) {
  const nameById = useMemo(
    () => new Map(employees.map((e) => [e.id, e.name])),
    [employees],
  );

  // ── Vorschlags-UI-State («+ Person einplanen») ────────────────────────────
  const [pickValue, setPickValue] = useState<string>('');
  const [pendingConflict, setPendingConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!hint || !dateStr) return null;

  const actionsEnabled = !!tenantId && !readOnly;
  const cellProposals = (openProposals ?? []).filter(
    (p) => p.date === dateStr && p.positionKey === hint.positionKey && p.status === 'open');

  const createProposal = async (input: {
    type: 'add' | 'remove'; employeeId: string | null; employeeName: string | null; conflictNote?: string | null;
  }) => {
    if (!tenantId) return;
    setSaving(true);
    try {
      const { created } = await addProposal(tenantId, {
        type: input.type, date: dateStr, positionKey: hint.positionKey, positionName: hint.positionName,
        employeeId: input.employeeId, employeeName: input.employeeName, conflictNote: input.conflictNote ?? null,
      });
      if (created) {
        toast.success(input.type === 'add'
          ? `Vorschlag vorgemerkt: ${input.employeeName ?? 'Offener Platz'} einplanen — im Dienstplan unter «Offene Punkte» bestätigen.`
          : `Vorschlag vorgemerkt: ${input.employeeName} streichen — im Dienstplan unter «Offene Punkte» bestätigen.`);
      } else {
        toast.info('Dieser Vorschlag ist bereits vorgemerkt.');
      }
      setPickValue('');
      setPendingConflict(null);
      onProposalsChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Vorschlag konnte nicht gespeichert werden');
    } finally {
      setSaving(false);
    }
  };

  const handlePickConfirm = () => {
    if (!pickValue) return;
    if (pickValue === '__open__') {
      void createProposal({ type: 'add', employeeId: null, employeeName: null });
      return;
    }
    const emp = employees.find((e) => e.id === pickValue);
    if (!emp) return;
    const conflict = conflictFor?.(emp.id) ?? null;
    if (conflict && pendingConflict === null) {
      // Warnung, keine Sperre: erst nach «Trotzdem zuteilen» wird vorgemerkt.
      setPendingConflict(conflict);
      return;
    }
    void createProposal({
      type: 'add', employeeId: emp.id, employeeName: emp.name,
      conflictNote: pendingConflict ?? conflict ?? null,
    });
  };

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
                  {actionsEnabled && diff > 0 && (
                    <td className="py-1 pl-1.5 text-right">
                      <Button
                        type="button" size="sm" variant="ghost"
                        className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-red-600"
                        disabled={saving || cellProposals.some((q) => q.type === 'remove' && q.employeeId === p.id)}
                        title={`${p.name} für diesen Tag zum Entfernen vormerken (Bestätigung im Dienstplan)`}
                        onClick={() => void createProposal({ type: 'remove', employeeId: p.id, employeeName: p.name })}
                        data-testid={`button-propose-remove-${p.id}`}
                      >
                        <UserMinus className="h-3 w-3" /> streichen
                      </Button>
                    </td>
                  )}
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

        {/* ── Offene Vorschläge dieser Zelle (noch nicht geplant) ─────────── */}
        {cellProposals.length > 0 && (
          <div className="rounded-md border border-sky-200 dark:border-sky-800 bg-sky-50/60 dark:bg-sky-950/20 px-2.5 py-1.5 space-y-0.5" data-testid="cell-dialog-proposals">
            {cellProposals.map((p) => (
              <p key={p.id} className="text-[11px] text-sky-800 dark:text-sky-300">
                {p.type === 'add'
                  ? `+ ${p.employeeName ?? 'Offener Platz'} vorgeschlagen`
                  : `− ${p.employeeName} zum Streichen vorgemerkt`}
                {' — '}im Dienstplan bestätigen (zählt noch nicht als geplant)
              </p>
            ))}
          </div>
        )}

        {/* ── «+ Person einplanen» bei Unterdeckung (Vorschlag, kein Eintrag) ─ */}
        {actionsEnabled && diff < 0 && (
          <div className="rounded-md border px-2.5 py-2 space-y-2" data-testid="cell-dialog-add-block">
            <p className="text-xs font-medium flex items-center gap-1">
              <UserPlus className="h-3.5 w-3.5" /> Person einplanen (Vorschlag)
            </p>
            <div className="flex items-center gap-1.5">
              <Select
                value={pickValue}
                onValueChange={(v) => { setPickValue(v); setPendingConflict(null); }}
              >
                <SelectTrigger className="h-8 text-sm flex-1" data-testid="select-propose-employee">
                  <SelectValue placeholder="Qualifizierte Person wählen…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__open__">Offener Platz (Person später im Dienstplan wählen)</SelectItem>
                  {employees
                    .filter((e) => e.isActive !== false && employeeCanCover(e, hint.positionKey)
                      && !hint.assigned.some((a) => a.id === e.id))
                    .map((e) => (
                      <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {pendingConflict === null && (
                <Button type="button" size="sm" className="h-8 px-2 text-xs" disabled={!pickValue || saving}
                  onClick={handlePickConfirm} data-testid="button-propose-add">
                  Vormerken
                </Button>
              )}
            </div>
            {pendingConflict !== null && (
              <Alert className="border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
                <AlertTriangle className="h-4 w-4 text-amber-700" />
                <AlertDescription className="space-y-1.5">
                  <p className="text-xs" data-testid="text-conflict-warning">{pendingConflict}</p>
                  <div className="flex gap-1.5">
                    <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={saving}
                      onClick={handlePickConfirm} data-testid="button-conflict-anyway">
                      Trotzdem zuteilen
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs"
                      onClick={() => { setPendingConflict(null); setPickValue(''); }} data-testid="button-conflict-cancel">
                      Abbrechen
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}
            <p className="text-[10px] text-muted-foreground">
              Erzeugt einen Vorschlag («offener Punkt») — der Dienstplan-Eintrag entsteht erst
              bei der Bestätigung im Dienstplan (mit Schichtzeit). Ist/Kosten bleiben unverändert.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
