/**
 * «Ganze Woche»-Ansicht des Personalbedarfs: Matrix Mo–So (Spalten, je Tag
 * Mittag/Abend), Zeilen = Positionen gruppiert nach Abteilung/Bereich,
 * Zelle = Soll-Anzahl ODER Bedarf-Netto-Stunden (Umschalter «Personen |
 * Stunden»); unten Tages-Summen (Einsätze, Netto-Stunden, Umsatzbudget).
 * Zellen sind direkt bearbeitbar (Inline-Panel, schreibt ins aktive Profil);
 * regelbasierte Positionen (CdS/Gastgeber, Kalte Küche/Sushi) zeigen nur
 * einen Regel-Hinweis.
 */
import { Fragment, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import type { Position } from '@/types/positions';
import type { StaffingRequirement, StaffingSeason } from '@/types/staffing';
import type { StaffingProfilesConfig } from '@/lib/staffing-profiles-utils';
import { buildWeekOverview, isEveningShift, type WeekCell } from '@/lib/staffing-week-utils';
import { diffToBedarf } from '@/lib/bedarf-stunden-utils';
import { nettoSegmentMinutes } from '@/lib/staffing-check-utils';
import {
  WEEKDAYS,
  weekdayLabel,
  shiftsForScope,
  defaultShiftDraft,
  validateShiftDraft,
  type ShiftDraft,
} from '@/lib/staffing-requirements-utils';
import { DEPT_LABEL } from '@/lib/station-config';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/** Anzeigemodus der Zellen: Personen-Anzahl oder Bedarf-Netto-Stunden. */
export type WeekCellMode = 'persons' | 'hours';

/**
 * Regelbasierte Positionen: Besetzung wird durch dynamische Regeln bestimmt —
 * keine direkte Zahl-Übersteuerung aus der Wochenansicht (Regel bleibt führend).
 */
export const RULE_BASED_POSITION_HINTS: Record<string, string> = {
  chef_de_service:
    'Regelbasiert: Der Chef de Service wird über die Prioritätenliste bestimmt (höchste geplante Priorität übernimmt). Die Regel bleibt führend — hier keine direkte Übersteuerung.',
  gastgeber_gf:
    'Regelbasiert: Gastgeber/GF ergibt sich aus der CdS-Prioritätenliste (zweite Priorität an Do–Sa, wenn die erste geplant ist). Die Regel bleibt führend — hier keine direkte Übersteuerung.',
  kalte_kueche:
    'Regelbasiert: Kalte Küche wird über die Küchen-Regel besetzt (Stamm-Besetzung zuerst, sonst Vertretung ab genügend Herd-Köchen). Die Regel bleibt führend — hier keine direkte Übersteuerung.',
  sushi:
    'Regelbasiert: Sushi wird über die Küchen-Regel besetzt (Stamm-Besetzung zuerst, sonst Vertretung ab genügend Herd-Köchen). Die Regel bleibt führend — hier keine direkte Übersteuerung.',
};

/** Netto-Stunden (ArG-Pausenstaffel) der Blöcke einer Zellen-Hälfte. */
function partNettoHours(cell: WeekCell | undefined, part: 'mittag' | 'abend'): number {
  if (!cell) return 0;
  let minutes = 0;
  for (const s of cell.shifts) {
    if ((part === 'abend') !== isEveningShift(s.shiftStart)) continue;
    minutes += nettoSegmentMinutes(s.shiftStart, s.shiftEnd) * s.requiredCount;
  }
  return Math.round((minutes / 60) * 10) / 10;
}

function CellValue({ cell, part, mode }: {
  cell: WeekCell | undefined;
  part: 'mittag' | 'abend';
  mode: WeekCellMode;
}) {
  const v = mode === 'hours' ? partNettoHours(cell, part) : (cell?.[part] ?? 0);
  if (v === 0) return <span className="text-muted-foreground/40">–</span>;
  const title = cell?.shifts
    .filter((s) => (part === 'abend') === isEveningShift(s.shiftStart))
    .map((s) => `${s.shiftStart}–${s.shiftEnd} × ${s.requiredCount}`)
    .join(', ');
  return (
    <span title={title} className="font-medium tabular-nums">
      {mode === 'hours' ? fmtH(v) : v}
    </span>
  );
}

/**
 * Inline-Editor einer Zelle (Position × Wochentag × Mittag/Abend): zeigt die
 * hinterlegten Soll-Schichten (RAW-Zeilen des aktiven Profils) und erlaubt
 * Anpassen von Zeiten/Anzahl bzw. Hinzufügen/Entfernen. Die Schichten der
 * ANDEREN Tageshälfte bleiben beim Speichern unverändert erhalten.
 */
function CellEditPanel({
  positionKey, positionName, weekday, part, rawShifts, sourceLabel, onSaveCell, onClose,
}: {
  positionKey: string;
  positionName: string;
  weekday: number;
  part: 'mittag' | 'abend';
  rawShifts: StaffingRequirement[];
  /** Quelle/Regel-Beschriftung, z.B. «Profil Standard». */
  sourceLabel: string;
  onSaveCell: (positionKey: string, weekday: number, part: 'mittag' | 'abend', shifts: ShiftDraft[]) => Promise<void>;
  onClose: () => void;
}) {
  const partShifts = rawShifts.filter((s) => (part === 'abend') === isEveningShift(s.shiftStart));
  const [drafts, setDrafts] = useState<ShiftDraft[]>(() =>
    partShifts.map((s) => ({ id: s.id, shiftStart: s.shiftStart, shiftEnd: s.shiftEnd, requiredCount: s.requiredCount })));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const update = (i: number, patch: Partial<ShiftDraft>) =>
    setDrafts((d) => d.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const handleSave = async () => {
    for (const d of drafts) {
      const errs = validateShiftDraft(d);
      if (errs.length > 0) { setError(errs[0]); return; }
    }
    setError(null);
    setSaving(true);
    try {
      // NUR die bearbeitete Tageshälfte übergeben — das Mergen mit der anderen
      // Hälfte passiert beim Speichern gegen den FRISCHEN Scope-Stand
      // (buildCellSaveDrafts), damit kein veralteter Snapshot zurückschreibt.
      await onSaveCell(positionKey, weekday, part, drafts);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2" data-testid={`cell-editor-${positionKey}-${weekday}-${part === 'abend' ? 'a' : 'm'}`}>
      <div className="space-y-0.5">
        <p className="text-xs font-semibold">
          {positionName} · {weekdayLabel(weekday)} · {part === 'abend' ? 'Abend' : 'Mittag'}
        </p>
        <p className="text-[10px] text-muted-foreground">Quelle: {sourceLabel}</p>
      </div>
      {drafts.length === 0 && (
        <p className="text-[11px] text-muted-foreground italic">Keine Soll-Schicht hinterlegt.</p>
      )}
      {drafts.map((s, i) => (
        <div key={s.id ?? `neu-${i}`} className="flex items-end gap-1.5">
          <div className="flex flex-col gap-0.5">
            <Label className="text-[10px] text-muted-foreground">Von</Label>
            <Input type="time" className="h-7 w-[6.2rem] text-xs" value={s.shiftStart}
              onChange={(e) => update(i, { shiftStart: e.target.value })}
              data-testid={`cell-edit-start-${i}`} />
          </div>
          <div className="flex flex-col gap-0.5">
            <Label className="text-[10px] text-muted-foreground">Bis</Label>
            <Input type="time" className="h-7 w-[6.2rem] text-xs" value={s.shiftEnd}
              onChange={(e) => update(i, { shiftEnd: e.target.value })}
              data-testid={`cell-edit-end-${i}`} />
          </div>
          <div className="flex flex-col gap-0.5">
            <Label className="text-[10px] text-muted-foreground">Anzahl</Label>
            <Input type="number" min={0} className="h-7 w-14 text-xs" value={Number.isFinite(s.requiredCount) ? s.requiredCount : ''}
              onChange={(e) => update(i, { requiredCount: e.target.value === '' ? NaN : Number(e.target.value) })}
              data-testid={`cell-edit-count-${i}`} />
          </div>
          <Button type="button" size="icon" variant="ghost" className="h-7 w-7 shrink-0"
            onClick={() => setDrafts((d) => d.filter((_, idx) => idx !== i))}
            title="Schicht entfernen">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs"
        onClick={() => setDrafts((d) => [...d, {
          ...defaultShiftDraft(),
          // Sinnvoller Default je Tageshälfte (Abend-Zelle → Abend-Zeiten).
          ...(part === 'abend' ? { shiftStart: '17:00', shiftEnd: '23:00' } : {}),
        }])}
        data-testid="cell-edit-add">
        <Plus className="h-3.5 w-3.5" /> Schicht hinzufügen
      </Button>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
      <div className="flex justify-end gap-1.5 pt-1">
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onClose}>
          Abbrechen
        </Button>
        <Button type="button" size="sm" className="h-7 px-2 text-xs" onClick={handleSave} disabled={saving}
          data-testid="cell-edit-save">
          {saving ? 'Speichert…' : 'Speichern'}
        </Button>
      </div>
    </div>
  );
}

/** Zelle mit Klick-Editor (Popover) + Stift-Hinweis; read-only nur Anzeige. */
function EditableCell({
  cell, part, mode, positionKey, positionName, weekday, rawShifts, sourceLabel, onSaveCell,
}: {
  cell: WeekCell | undefined;
  part: 'mittag' | 'abend';
  mode: WeekCellMode;
  positionKey: string;
  positionName: string;
  weekday: number;
  rawShifts: StaffingRequirement[];
  sourceLabel: string;
  onSaveCell: (positionKey: string, weekday: number, part: 'mittag' | 'abend', shifts: ShiftDraft[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ruleHint = RULE_BASED_POSITION_HINTS[positionKey] ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group relative w-full rounded px-0.5 py-0.5 hover:bg-muted/70"
          title="Zelle bearbeiten"
          data-testid={`week-cell-btn-${positionKey}-${weekday}-${part === 'abend' ? 'a' : 'm'}`}
        >
          <CellValue cell={cell} part={part} mode={mode} />
          <Pencil className="pointer-events-none absolute -right-0.5 -top-0.5 h-2.5 w-2.5 text-muted-foreground/0 group-hover:text-muted-foreground/70" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-auto max-w-[22rem] p-3">
        {ruleHint ? (
          <div className="space-y-1.5 max-w-[18rem]">
            <p className="text-xs font-semibold">{positionName} · {weekdayLabel(weekday)}</p>
            {rawShifts.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Hinterlegt: {rawShifts.map((s) => `${s.shiftStart}–${s.shiftEnd} × ${s.requiredCount}`).join(', ')}
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">{ruleHint}</p>
          </div>
        ) : (
          <CellEditPanel
            positionKey={positionKey}
            positionName={positionName}
            weekday={weekday}
            part={part}
            rawShifts={rawShifts}
            sourceLabel={sourceLabel}
            onSaveCell={onSaveCell}
            onClose={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Stunden je ISO-Wochentag aus einer konkreten Kalenderwoche (null = leer). */
export interface WeekHoursStack {
  /** Beschriftung der Kalenderwoche, z.B. «KW 31 · 27.07.–02.08.2026». */
  weekLabel: string;
  /** Dienstplan-Plan-Netto-Stunden je Wochentag (ArG-Pausen); null = leer. */
  plan: Record<number, number | null>;
  /** Ist-Stunden (MIRUS/gestempelt) je Wochentag; null = kein Import (nie 0). */
  ist: Record<number, number | null>;
}

const fmtH = (v: number) =>
  v.toLocaleString('de-CH', { maximumFractionDigits: 1 });

/** Δ zum Bedarf mit Vorzeichen + Ampel (grün = im/unter Bedarf, rot = über). */
function DiffBadge({ value, bedarf }: { value: number | null; bedarf: number | null }) {
  const diff = diffToBedarf(value, bedarf);
  if (diff == null) return null;
  return (
    <span
      className={cn(
        'block text-[10px] tabular-nums',
        diff > 0 ? 'text-red-600' : 'text-emerald-600',
      )}
    >
      {diff > 0 ? '+' : ''}{fmtH(diff)}
    </span>
  );
}

export function StaffingWeekMatrix({
  positions,
  requirements,
  config,
  season,
  onSelectWeekday,
  hoursStack,
  cellMode = 'persons',
  editable = false,
  editSeason,
  sourceLabel,
  onSaveCell,
}: {
  positions: Position[];
  requirements: StaffingRequirement[];
  config: StaffingProfilesConfig;
  season: StaffingSeason;
  /** Klick auf eine Tagesspalte → in die Tagesansicht dieses Wochentags. */
  onSelectWeekday?: (weekday: number) => void;
  /** Dienstplan-/Ist-Stunden einer konkreten Kalenderwoche (optional). */
  hoursStack?: WeekHoursStack | null;
  /** Zellen zeigen Personen-Anzahl oder Bedarf-Netto-Stunden. */
  cellMode?: WeekCellMode;
  /** Zellen per Klick bearbeitbar (Inline-Panel). */
  editable?: boolean;
  /** Saison, in deren RAW-Zeilen geschrieben wird (aktives Profil). */
  editSeason?: StaffingSeason;
  /** Quelle/Regel-Beschriftung im Editor, z.B. «Profil Standard». */
  sourceLabel?: string;
  /** Persistiert die kompletten Tages-Schichten der Position. */
  onSaveCell?: (positionKey: string, weekday: number, part: 'mittag' | 'abend', shifts: ShiftDraft[]) => Promise<void>;
}) {
  const overview = buildWeekOverview({ positions, requirements, config, season });
  const canEdit = editable && !!onSaveCell && !!editSeason;
  /** RAW-Zeilen (ohne UG-Zuschlag/Ableitung) einer Position an einem Wochentag. */
  const rawShiftsFor = (positionKey: string, weekday: number): StaffingRequirement[] =>
    canEdit
      ? shiftsForScope(requirements, editSeason!, weekday).filter((r) => r.positionKey === positionKey)
      : [];

  if (!overview.hasAny) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Für dieses Profil ist noch kein Bedarf hinterlegt.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="staffing-week-matrix">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm">Soll-Wochenübersicht (Mo–So · M = Mittag, A = Abend)</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-1 pr-2 text-left font-medium">Position</th>
              {WEEKDAYS.map((w) => (
                <th key={w.value} colSpan={2} className="py-1 px-1 text-center font-medium">
                  {onSelectWeekday ? (
                    <button
                      type="button"
                      onClick={() => onSelectWeekday(w.value)}
                      className="rounded px-1 hover:bg-muted hover:text-foreground"
                      title={`${w.label}: Tagesansicht öffnen`}
                      data-testid={`week-col-${w.value}`}
                    >
                      {w.short}
                    </button>
                  ) : (
                    w.short
                  )}
                </th>
              ))}
            </tr>
            <tr className="text-[10px] text-muted-foreground border-b">
              <th />
              {WEEKDAYS.map((w) => (
                <Fragment key={w.value}>
                  <th className="pb-1 px-1 text-center font-normal">M</th>
                  <th className="pb-1 px-1 text-center font-normal border-r border-border/40 last:border-r-0">A</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {overview.groups.map((dep) => (
              <Fragment key={dep.department}>
                <tr className="bg-muted/40">
                  <td colSpan={15} className="py-1 pr-2 text-xs font-semibold">
                    {DEPT_LABEL[dep.department]}
                  </td>
                </tr>
                {dep.areas.map((area) => (
                  <Fragment key={`${dep.department}-${area.area?.key ?? 'none'}`}>
                    {area.area && dep.areas.length > 1 && (
                      <tr>
                        <td colSpan={15} className="pt-1 pr-2 text-[11px] text-muted-foreground">
                          {area.area.name}
                        </td>
                      </tr>
                    )}
                    {area.positions.map((row) => (
                      <tr key={row.positionKey} className="border-t border-border/50">
                        <td className="py-1 pr-2 whitespace-nowrap">{row.positionName}</td>
                        {WEEKDAYS.map((w) => (
                          <Fragment key={w.value}>
                            <td className="py-1 px-1 text-center" data-testid={`week-cell-${row.positionKey}-${w.value}-m`}>
                              {canEdit ? (
                                <EditableCell
                                  cell={row.cells[w.value]} part="mittag" mode={cellMode}
                                  positionKey={row.positionKey} positionName={row.positionName}
                                  weekday={w.value} rawShifts={rawShiftsFor(row.positionKey, w.value)}
                                  sourceLabel={sourceLabel ?? ''} onSaveCell={onSaveCell!}
                                />
                              ) : (
                                <CellValue cell={row.cells[w.value]} part="mittag" mode={cellMode} />
                              )}
                            </td>
                            <td className="py-1 px-1 text-center border-r border-border/40 last:border-r-0">
                              {canEdit ? (
                                <EditableCell
                                  cell={row.cells[w.value]} part="abend" mode={cellMode}
                                  positionKey={row.positionKey} positionName={row.positionName}
                                  weekday={w.value} rawShifts={rawShiftsFor(row.positionKey, w.value)}
                                  sourceLabel={sourceLabel ?? ''} onSaveCell={onSaveCell!}
                                />
                              ) : (
                                <CellValue cell={row.cells[w.value]} part="abend" mode={cellMode} />
                              )}
                            </td>
                          </Fragment>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </tbody>
          <tfoot className="border-t-2">
            <tr className="text-xs">
              <td className="py-1 pr-2 font-medium">Einsätze total</td>
              {WEEKDAYS.map((w) => (
                <td key={w.value} colSpan={2} className={cn('py-1 px-1 text-center tabular-nums font-medium border-r border-border/40 last:border-r-0')} data-testid={`week-total-persons-${w.value}`}>
                  {overview.totals[w.value]?.persons ?? 0}
                </td>
              ))}
            </tr>
            {/* Stapel Bedarf → Dienstplan → Ist: Bedarf = Leitplanke (kräftig),
                Dienstplan darunter abgeschwächt, Ist zuunterst am leisesten.
                Dienstplan/Ist zeigen zusätzlich Δ zum Bedarf (grün/rot). */}
            <tr className="text-xs">
              <td className="py-1 pr-2 font-semibold">Bedarf-Stunden (Soll)</td>
              {WEEKDAYS.map((w) => (
                <td key={w.value} colSpan={2} className="py-1 px-1 text-center tabular-nums font-semibold border-r border-border/40 last:border-r-0" data-testid={`week-bedarf-h-${w.value}`}>
                  {fmtH(overview.totals[w.value]?.nettoHours ?? 0)}
                </td>
              ))}
            </tr>
            {hoursStack && (
              <>
                <tr className="text-[11px] text-muted-foreground">
                  <td className="py-1 pr-2">Dienstplan (Plan)</td>
                  {WEEKDAYS.map((w) => {
                    const plan = hoursStack.plan[w.value] ?? null;
                    const bedarf = overview.totals[w.value]?.nettoHours ?? 0;
                    return (
                      <td key={w.value} colSpan={2} className="py-1 px-1 text-center tabular-nums border-r border-border/40 last:border-r-0" data-testid={`week-plan-h-${w.value}`}>
                        {plan != null ? fmtH(plan) : '–'}
                        <DiffBadge value={plan} bedarf={bedarf} />
                      </td>
                    );
                  })}
                </tr>
                <tr className="text-[11px] text-muted-foreground/70">
                  <td className="py-1 pr-2">Ist (MIRUS)</td>
                  {WEEKDAYS.map((w) => {
                    const ist = hoursStack.ist[w.value] ?? null;
                    const bedarf = overview.totals[w.value]?.nettoHours ?? 0;
                    return (
                      <td key={w.value} colSpan={2} className="py-1 px-1 text-center tabular-nums border-r border-border/40 last:border-r-0" data-testid={`week-ist-h-${w.value}`}>
                        {ist != null ? fmtH(ist) : ''}
                        <DiffBadge value={ist} bedarf={bedarf} />
                      </td>
                    );
                  })}
                </tr>
              </>
            )}
            <tr className="text-xs text-muted-foreground">
              <td className="py-1 pr-2">Umsatzbudget (CHF)</td>
              {WEEKDAYS.map((w) => {
                const b = overview.totals[w.value]?.budget;
                return (
                  <td key={w.value} colSpan={2} className="py-1 px-1 text-center tabular-nums border-r border-border/40 last:border-r-0">
                    {b != null ? b.toLocaleString('de-CH') : '–'}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Mittag = Schichtbeginn vor 16:00, Abend = ab 16:00. Zahlen = {cellMode === 'hours'
            ? 'Bedarf-Netto-Stunden (Soll-Schichten × Dauer, ArG-Pausenabzug)'
            : 'benötigte Personen'}; Zeiten im Tooltip.{' '}
          {canEdit
            ? 'Klick auf eine Zelle öffnet das Bearbeitungs-Panel (schreibt ins aktive Profil); regelbasierte Positionen zeigen nur den Regel-Hinweis.'
            : 'Bearbeiten in der Tagesansicht (Klick auf einen Wochentag).'}
        </p>
        {hoursStack && (
          <p className="text-[11px] text-muted-foreground">
            Stunden-Stapel ({hoursStack.weekLabel}): Bedarf (Soll, netto mit
            ArG-Pausen) = Leitplanke · Dienstplan (Plan) und Ist (MIRUS) mit Δ zum
            Bedarf — grün = im/unter Bedarf, rot = über Bedarf. Ist bleibt leer,
            solange kein MIRUS-Import vorliegt.
          </p>
        )}
        {season !== 'standard' && (
          <p className="text-[11px] text-muted-foreground">
            UG-Zuschlag ist an seinen Regeltagen eingerechnet; tagesbezogene
            «UG/Event offen»-Flags erscheinen hier nicht.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
