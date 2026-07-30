/**
 * «Ganze Woche»-Ansicht des Personalbedarfs: Matrix Mo–So (Spalten, je Tag
 * Mittag/Abend), Zeilen = Positionen gruppiert nach Abteilung/Bereich,
 * Zelle = Soll-Anzahl ODER Bedarf-Netto-Stunden (Umschalter «Personen |
 * Stunden»); unten Tages-Summen (Personal total = Kopfzahl, Netto-Stunden, Umsatzbudget).
 * Zellen sind direkt bearbeitbar (Inline-Panel, schreibt ins aktive Profil);
 * regelbasierte Positionen (CdS/Gastgeber, Kalte Küche/Sushi) zeigen nur
 * einen Regel-Hinweis.
 */
import { Fragment, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import type { Position } from '@/types/positions';
import type { StaffingRequirement, StaffingSeason } from '@/types/staffing';
import type { StaffingProfilesConfig } from '@/lib/staffing-profiles-utils';
import { buildWeekOverview, isEveningShift, explicitDayHeadcount, type WeekCell } from '@/lib/staffing-week-utils';
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

/**
 * Tooltip-Text einer Tageszelle: WANN gearbeitet wird (durchgehend / nur
 * Mittag / nur Abend) mit Uhrzeiten — die Spalten selbst zeigen nur die Zahl.
 */
function dayCellTitle(cell: WeekCell | undefined): string {
  if (!cell || cell.shifts.length === 0) return '';
  const m = cell.shifts.filter((s) => !isEveningShift(s.shiftStart));
  const a = cell.shifts.filter((s) => isEveningShift(s.shiftStart));
  const fmt = (list: typeof m) => list.map((s) => `${s.shiftStart}–${s.shiftEnd} × ${s.requiredCount}`).join(', ');
  const parts: string[] = [];
  if (m.length > 0) parts.push(`Mittag: ${fmt(m)}`);
  if (a.length > 0) parts.push(`Abend: ${fmt(a)}`);
  const kind = m.length > 0 && a.length > 0
    ? (cell.headcountExplicit ? 'Mittag + Abend (getrennte Personen möglich)' : 'durchgehend / beide Hälften')
    : m.length > 0 ? 'nur Mittag' : 'nur Abend';
  return `${kind}\n${parts.join('\n')}\nKopfzahl: ${cell.headcount}${cell.headcountExplicit ? ' (explizit)' : ''}`;
}

function CellValue({ cell, mode }: {
  cell: WeekCell | undefined;
  mode: WeekCellMode;
}) {
  // EINE Zahl pro Tag: Personen = KOPFZAHL (keine Doppelzählung M/A),
  // Stunden = Netto-Stunden aller Blöcke (jede Person mit ihrer echten Dauer).
  const v = mode === 'hours'
    ? partNettoHours(cell, 'mittag') + partNettoHours(cell, 'abend')
    : (cell?.headcount ?? 0);
  if (v === 0) return <span className="text-muted-foreground/40">–</span>;
  return (
    <span title={dayCellTitle(cell)} className="font-medium tabular-nums">
      {mode === 'hours' ? fmtH(Math.round(v * 10) / 10) : v}
    </span>
  );
}

/**
 * Inline-Editor einer Tageszelle (Position × Wochentag, GANZER Tag): zeigt
 * alle hinterlegten Soll-Blöcke (RAW-Zeilen des aktiven Profils) chronologisch
 * und erlaubt Anpassen von Zeiten/Anzahl bzw. Hinzufügen/Entfernen. Beim
 * Speichern (part='day') werden ALLE Blöcke der Position an diesem Tag
 * ersetzt; andere Positionen/Orphans bleiben unverändert erhalten.
 */
function CellEditPanel({
  positionKey, positionName, weekday, rawShifts, sourceLabel, onSaveCell, onClose,
}: {
  positionKey: string;
  positionName: string;
  weekday: number;
  rawShifts: StaffingRequirement[];
  /** Quelle/Regel-Beschriftung, z.B. «Profil Standard». */
  sourceLabel: string;
  onSaveCell: (positionKey: string, weekday: number, part: 'mittag' | 'abend' | 'day', shifts: ShiftDraft[], dayHeadcount?: number | null) => Promise<void>;
  onClose: () => void;
}) {
  // GANZER Tag: alle Blöcke der Position (Mittag + Abend), chronologisch.
  const [drafts, setDrafts] = useState<ShiftDraft[]>(() =>
    [...rawShifts]
      .sort((x, y) => x.shiftStart.localeCompare(y.shiftStart))
      .map((s) => ({ id: s.id, shiftStart: s.shiftStart, shiftEnd: s.shiftEnd, requiredCount: s.requiredCount })));
  // Explizite KOPFZAHL des Tages (leer = Automatik max(Mittag, Abend)).
  const [headInput, setHeadInput] = useState<string>(() => {
    const v = explicitDayHeadcount(rawShifts);
    return v == null ? '' : String(v);
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const update = (i: number, patch: Partial<ShiftDraft>) =>
    setDrafts((d) => d.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const handleSave = async () => {
    for (const d of drafts) {
      const errs = validateShiftDraft(d);
      if (errs.length > 0) { setError(errs[0]); return; }
    }
    const headTrim = headInput.trim();
    const head = headTrim === '' ? null : Number(headTrim);
    if (head !== null && (!Number.isFinite(head) || head < 0 || !Number.isInteger(head))) {
      setError('Personen (Kopfzahl) muss eine ganze Zahl ≥ 0 sein — oder leer für Automatik.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      // 'day' ersetzt ALLE Blöcke der Position an diesem Tag; das Mergen mit
      // den übrigen Zeilen des Scopes passiert beim Speichern gegen den
      // FRISCHEN Stand (buildCellSaveDrafts) — kein veralteter Snapshot.
      await onSaveCell(positionKey, weekday, 'day', drafts, head);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2" data-testid={`cell-editor-${positionKey}-${weekday}`}>
      <div className="space-y-0.5">
        <p className="text-xs font-semibold">
          {positionName} · {weekdayLabel(weekday)} · ganzer Tag
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
          // Zweiter Block eines Tages ist typischerweise der Abend.
          ...(d.some((s) => !isEveningShift(s.shiftStart)) ? { shiftStart: '17:00', shiftEnd: '23:00' } : {}),
        }])}
        data-testid="cell-edit-add">
        <Plus className="h-3.5 w-3.5" /> Schicht hinzufügen
      </Button>
      <div className="flex items-end gap-2 border-t pt-2">
        <div className="flex flex-col gap-0.5">
          <Label className="text-[10px] text-muted-foreground">Personen am Tag (Kopfzahl)</Label>
          <Input type="number" min={0} step={1} className="h-7 w-20 text-xs" value={headInput}
            placeholder="auto"
            onChange={(e) => setHeadInput(e.target.value)}
            data-testid="cell-edit-headcount" />
        </div>
        <p className="pb-0.5 text-[10px] text-muted-foreground max-w-[12rem]">
          Leer = automatisch max(Mittag, Abend): eine durchgehende Person zählt 1×.
          Nur setzen, wenn Mittag und Abend VERSCHIEDENE Personen sind.
        </p>
      </div>
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
  cell, mode, positionKey, positionName, weekday, rawShifts, sourceLabel, onSaveCell,
}: {
  cell: WeekCell | undefined;
  mode: WeekCellMode;
  positionKey: string;
  positionName: string;
  weekday: number;
  rawShifts: StaffingRequirement[];
  sourceLabel: string;
  onSaveCell: (positionKey: string, weekday: number, part: 'mittag' | 'abend' | 'day', shifts: ShiftDraft[], dayHeadcount?: number | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ruleHint = RULE_BASED_POSITION_HINTS[positionKey] ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group relative w-full rounded px-0.5 py-0.5 hover:bg-muted/70"
          title={dayCellTitle(cell) || 'Zelle bearbeiten'}
          data-testid={`week-cell-btn-${positionKey}-${weekday}`}
        >
          <CellValue cell={cell} mode={mode} />
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
  /** Persistiert die kompletten Tages-Schichten der Position (+ Kopfzahl). */
  onSaveCell?: (positionKey: string, weekday: number, part: 'mittag' | 'abend' | 'day', shifts: ShiftDraft[], dayHeadcount?: number | null) => Promise<void>;
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
        <CardTitle className="text-sm">Soll-Wochenübersicht (Mo–So · eine Kopfzahl pro Tag)</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-1 pr-2 text-left font-medium">Position</th>
              {WEEKDAYS.map((w) => (
                <th key={w.value} className="py-1 px-1 text-center font-medium border-b border-r border-border/40 last:border-r-0">
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
          </thead>
          <tbody>
            {/* EINE klare Überschrift-Ebene: Bereich (Restaurant, Bar/Buffet,
                Küche, Take Away, Abwasch) — ohne redundante Abteilungs-Zeile
                darüber. Positionen ohne Bereich fallen auf die Abteilung zurück. */}
            {overview.groups.map((dep) => (
              <Fragment key={dep.department}>
                {dep.areas.map((area) => (
                  <Fragment key={`${dep.department}-${area.area?.key ?? 'none'}`}>
                    <tr className="bg-muted/40">
                      <td colSpan={8} className="py-1 pr-2 text-xs font-semibold uppercase tracking-wide">
                        {area.area?.name ?? DEPT_LABEL[dep.department]}
                      </td>
                    </tr>
                    {area.positions.map((row) => (
                      <tr key={row.positionKey} className="border-t border-border/50">
                        <td className="py-1 pr-2 whitespace-nowrap">{row.positionName}</td>
                        {WEEKDAYS.map((w) => (
                          <td key={w.value} className="py-1 px-1 text-center border-r border-border/40 last:border-r-0" data-testid={`week-cell-${row.positionKey}-${w.value}`}>
                            {canEdit ? (
                              <EditableCell
                                cell={row.cells[w.value]} mode={cellMode}
                                positionKey={row.positionKey} positionName={row.positionName}
                                weekday={w.value} rawShifts={rawShiftsFor(row.positionKey, w.value)}
                                sourceLabel={sourceLabel ?? ''} onSaveCell={onSaveCell!}
                              />
                            ) : (
                              <CellValue cell={row.cells[w.value]} mode={cellMode} />
                            )}
                          </td>
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
              <td className="py-1 pr-2 font-medium">Personal total</td>
              {WEEKDAYS.map((w) => (
                <td key={w.value} className={cn('py-1 px-1 text-center tabular-nums font-medium border-r border-border/40 last:border-r-0')} data-testid={`week-total-persons-${w.value}`}>
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
                <td key={w.value} className="py-1 px-1 text-center tabular-nums font-semibold border-r border-border/40 last:border-r-0" data-testid={`week-bedarf-h-${w.value}`}>
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
                      <td key={w.value} className="py-1 px-1 text-center tabular-nums border-r border-border/40 last:border-r-0" data-testid={`week-plan-h-${w.value}`}>
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
                      <td key={w.value} className="py-1 px-1 text-center tabular-nums border-r border-border/40 last:border-r-0" data-testid={`week-ist-h-${w.value}`}>
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
                  <td key={w.value} className="py-1 px-1 text-center tabular-nums border-r border-border/40 last:border-r-0">
                    {b != null ? b.toLocaleString('de-CH') : '–'}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Eine Zahl pro Tag = {cellMode === 'hours'
            ? 'Bedarf-Netto-Stunden (jede Person mit ihrer echten Schichtlänge, ArG-Pausenabzug)'
            : 'KOPFZAHL (Personen; eine durchgehende Person zählt 1×, keine Doppelzählung Mittag/Abend)'}.
          WANN (durchgehend / nur Mittag / nur Abend, mit Uhrzeiten) steht im Tooltip
          und im Bearbeitungs-Panel. «Personal total» = Summe der Kopfzahlen;
          Kopfzahl automatisch max(Mittag, Abend), pro Zelle explizit übersteuerbar.{' '}
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
