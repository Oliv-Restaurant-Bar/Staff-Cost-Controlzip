/**
 * ZeitraumSteuerung — die gemeinsame Perioden-Steuerung (FIBU-Abgleich-Muster)
 * ===========================================================================
 * EINE Komponente für alle Auswertungs-Seiten: Umschalter Woche/Monat/
 * (Quartal)/Jahr + Perioden-Auswahl mit < >-Blättern, oben rechts. Optik,
 * Labels und testids entsprechen exakt dem bisherigen FIBU-Abgleich.
 * Logik-SSOT: `src/lib/zeitraum.ts`. Seiten halten den `Zeitraum` selbst
 * (value/onChange) — so bleibt er innerhalb einer Seite über Tabs erhalten.
 *
 * `extraModes` erlaubt seitenspezifische Zusatz-Modi (z.B. Analyse: «Mehrere
 * Monate», «YTD»): sie erscheinen im selben Popover; ist einer aktiv, liefert
 * die Seite Label (`extraLabel`) und Popover-Inhalt (`extraContent`) selbst.
 */

import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  type Zeitraum, type Granularitaet, zeitraumLabel, shiftZeitraum, nextGesperrt,
  wechsleGranularitaet, mitWochenStart, getIsoWeek, isoWeekRange, wochenDesJahres, ymdLocal,
} from '@/lib/zeitraum';

const MONATE_LANG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const GRANULAR_LABEL: Record<Granularitaet, string> = {
  woche: 'Woche', monat: 'Monat', quartal: 'Quartal', jahr: 'Jahr',
};
const fmtKurzDatum = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;

export interface ZeitraumSteuerungProps {
  value: Zeitraum;
  onChange: (z: Zeitraum) => void;
  /** Angebotene Granularitäten (Reihenfolge = Anzeige). Default Woche/Monat/Jahr. */
  granularitaeten?: Granularitaet[];
  /** Erstes wählbares Jahr (Default 2024). */
  minJahr?: number;
  /** Letztes wählbares Jahr (Default aktuelles Jahr; z.B. Budget plant vorwärts). */
  maxJahr?: number;
  /** Seitenspezifische Zusatz-Modi (z.B. «Mehrere Monate», «YTD»). */
  extraModes?: Array<{ id: string; label: string }>;
  /** Aktiver Zusatz-Modus (null/undefined = normale Granularität aktiv). */
  aktiverExtraMode?: string | null;
  onExtraMode?: (id: string) => void;
  /** Trigger-Label, wenn ein Zusatz-Modus aktiv ist. */
  extraLabel?: string;
  /** Popover-Inhalt (Periodenauswahl), wenn ein Zusatz-Modus aktiv ist. */
  extraContent?: ReactNode;
  /** Blättern < > im Zusatz-Modus (fehlt = Pfeile deaktiviert). */
  onExtraShift?: (richtung: 1 | -1) => void;
  extraNextGesperrt?: boolean;
}

export function ZeitraumSteuerung({
  value, onChange, granularitaeten = ['woche', 'monat', 'jahr'], minJahr = 2024, maxJahr,
  extraModes = [], aktiverExtraMode = null, onExtraMode,
  extraLabel, extraContent, onExtraShift, extraNextGesperrt = true,
}: ZeitraumSteuerungProps) {
  const [open, setOpen] = useState(false);
  const todayStr = ymdLocal(new Date());
  const heuteJahr = Number(todayStr.slice(0, 4));
  const obersteJahr = maxJahr ?? heuteJahr;
  const pickerJahre = Array.from({ length: obersteJahr - minJahr + 1 }, (_, i) => minJahr + i);
  const vorGesperrt = maxJahr !== undefined && value.granular === 'jahr'
    ? value.year >= obersteJahr
    : nextGesperrt(value, todayStr);
  const extraAktiv = aktiverExtraMode !== null && aktiverExtraMode !== undefined;
  const alleGranular = granularitaeten.length + extraModes.length;
  const spalten = alleGranular <= 3 ? 'grid-cols-3' : alleGranular === 4 ? 'grid-cols-4' : 'grid-cols-3';

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => extraAktiv ? onExtraShift?.(-1) : onChange(shiftZeitraum(value, -1))}
        disabled={extraAktiv && !onExtraShift}
        className="h-8 w-8 rounded-md border border-border flex items-center justify-center hover:bg-muted transition-colors disabled:opacity-40"
        data-testid="periode-zurueck" aria-label="Vorherige Periode"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="h-8 px-3 rounded-md border border-border flex items-center justify-center gap-1.5 hover:bg-muted transition-colors text-sm font-semibold tabular-nums min-w-[170px]"
            data-testid="periode-dropdown"
          >
            {extraAktiv ? (extraLabel ?? '—') : zeitraumLabel(value)}
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-64 p-3 space-y-2.5">
          <div>
            <p className="text-[11px] font-medium text-muted-foreground mb-1">Granularität</p>
            <div className={cn('grid gap-1', spalten)}>
              {granularitaeten.map(g => (
                <button
                  key={g}
                  onClick={() => onChange(wechsleGranularitaet(value, g, todayStr))}
                  className={cn('h-7 rounded-md border text-xs font-medium transition-colors',
                    !extraAktiv && value.granular === g
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border hover:bg-muted')}
                  data-testid={`granular-${g}`}
                >
                  {GRANULAR_LABEL[g]}
                </button>
              ))}
              {extraModes.map(m => (
                <button
                  key={m.id}
                  onClick={() => onExtraMode?.(m.id)}
                  className={cn('h-7 rounded-md border text-xs font-medium transition-colors',
                    aktiverExtraMode === m.id
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border hover:bg-muted')}
                  data-testid={`granular-${m.id}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          {extraAktiv ? extraContent : value.granular === 'monat' ? (
            <div className="grid grid-cols-2 gap-1.5">
              <select
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                value={value.month}
                onChange={e => onChange({ ...value, month: Number(e.target.value) })}
                data-testid="periode-monat-select"
              >
                {MONATE_LANG.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <select
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                value={value.year}
                onChange={e => onChange({ ...value, year: Number(e.target.value) })}
                data-testid="periode-jahr-select"
              >
                {pickerJahre.map(j => <option key={j} value={j}>{j}</option>)}
              </select>
            </div>
          ) : value.granular === 'jahr' ? (
            <select
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
              value={value.year}
              onChange={e => onChange({ ...value, year: Number(e.target.value) })}
              data-testid="periode-jahresansicht-select"
            >
              {pickerJahre.map(j => <option key={j} value={j}>{j}</option>)}
            </select>
          ) : value.granular === 'quartal' ? (
            <div className="grid grid-cols-2 gap-1.5">
              <select
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                value={value.quartal}
                onChange={e => onChange({ ...value, quartal: Number(e.target.value) })}
                data-testid="periode-quartal-select"
              >
                {[1, 2, 3, 4].map(q => <option key={q} value={q}>Q{q}</option>)}
              </select>
              <select
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                value={value.year}
                onChange={e => onChange({ ...value, year: Number(e.target.value) })}
                data-testid="periode-quartaljahr-select"
              >
                {pickerJahre.map(j => <option key={j} value={j}>{j}</option>)}
              </select>
            </div>
          ) : (
            <div className="grid grid-cols-[1fr_auto] gap-1.5">
              <select
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                value={value.wochenStart}
                onChange={e => onChange(mitWochenStart(value, e.target.value))}
                data-testid="periode-woche-select"
              >
                {wochenDesJahres(getIsoWeek(value.wochenStart).isoYear).map(w => (
                  <option key={w.from} value={w.from}>
                    KW {String(w.week).padStart(2, '0')} · {fmtKurzDatum(w.from)}–{fmtKurzDatum(w.to)}
                  </option>
                ))}
              </select>
              <select
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                value={getIsoWeek(value.wochenStart).isoYear}
                onChange={e => onChange(mitWochenStart(value, isoWeekRange(Number(e.target.value), 1).from))}
                data-testid="periode-wochenjahr-select"
              >
                {pickerJahre.map(j => <option key={j} value={j}>{j}</option>)}
              </select>
            </div>
          )}
        </PopoverContent>
      </Popover>
      <button
        onClick={() => extraAktiv ? onExtraShift?.(1) : onChange(shiftZeitraum(value, 1))}
        disabled={extraAktiv ? (extraNextGesperrt || !onExtraShift) : vorGesperrt}
        className="h-8 w-8 rounded-md border border-border flex items-center justify-center hover:bg-muted transition-colors disabled:opacity-40"
        data-testid="periode-vor" aria-label="Nächste Periode"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
