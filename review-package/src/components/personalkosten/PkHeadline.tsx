/**
 * Personalkosten-Schlagzeile (vereinfacht).
 * Reine Darstellung — ALLE Zahlen kommen fertig aus dem zentralen Kern
 * (personalkosten.ts) über die Props. Hier findet KEINE Rechnung statt.
 *
 * Aufbau:
 *  1) Hero: links «Personalkosten <Monat> (Hochrechnung) = CHF X» + Chips
 *     + Kontextzeile; RECHTS kompakte Kernzahlen-Zeilen (Budget, Abweichung,
 *     PKQ-Hochrechnung inkl. Umsatz HR, FIX + FLEX) — keine separaten Boxen.
 *  2) Ist-Zeile: Personalkosten Ist · Netto-Umsatz Ist · PKQ Ist (bis <Datum>).
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

export interface PkHeadlineProps {
  monthLabel: string;
  /** Kernwerte (Hochrechnung). */
  hrTotalCHF: number;
  hrFixCHF: number;
  hrFlexCHF: number;
  /** PK-Budget des Monats (null = kein Umsatz-Budget hinterlegt). */
  budgetCHF: number | null;
  /** Netto-Umsatz-Budget des Monats (für den Untertitel der Budget-Kachel). */
  umsatzBudgetCHF: number;
  /** Ziel-Personalquote als Bruch (z.B. 0.355) — zentrale Einstellung. */
  zielQuote: number;
  /** PKQ-Hochrechnung als Bruch (kHr ÷ umsatzHR) oder null. */
  pkqHochrechnung: number | null;
  umsatzHochrechnungCHF: number;
  /** Ist-Zeile. */
  istTotalCHF: number;
  umsatzIstCHF: number;
  pkqIst: number | null;
  /** Stand: X von Y Tagen als Ist erfasst. */
  istTage: number;
  daysInMonth: number;
  /** Letzter abgeschlossener Ist-Tag (für «bis <Datum>»). */
  stichtag: number;
  year: number;
  month: number;
  /** Formatierer (bestehende Schweizer Helfer der Seite). */
  fmtCHF: (n: number) => string;
  /** Drilldown-Öffner der Seite (Kacheln bleiben klickbar). */
  onFocus?: (focus: 'ist' | 'budget' | 'abweichung' | 'quote') => void;
}

const OBERGRENZE_PCT = 40;

function stichtagDatum(year: number, month: number, stichtag: number): string {
  if (stichtag <= 0) return '—';
  return new Date(year, month - 1, stichtag).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' });
}

export function PkHeadline(props: PkHeadlineProps) {
  const {
    monthLabel, hrTotalCHF, hrFixCHF, hrFlexCHF, budgetCHF, umsatzBudgetCHF,
    zielQuote, pkqHochrechnung, umsatzHochrechnungCHF, istTotalCHF, umsatzIstCHF,
    pkqIst, istTage, daysInMonth, stichtag, year, month, fmtCHF, onFocus,
  } = props;

  const hasBudget = budgetCHF != null;
  const abwHr = hasBudget ? hrTotalCHF - budgetCHF : 0;
  const abwPct = hasBudget && budgetCHF > 0 ? (abwHr / budgetCHF) * 100 : null;
  const ueberBudget = hasBudget && abwHr > 0.5;
  const pkqHrPct = pkqHochrechnung != null ? pkqHochrechnung * 100 : null;
  const zielPct = zielQuote * 100;
  const istDatum = stichtagDatum(year, month, stichtag);

  const focusBtn = (focus: 'ist' | 'budget' | 'abweichung' | 'quote') =>
    onFocus ? { role: 'button' as const, tabIndex: 0, onClick: () => onFocus(focus),
      onKeyDown: (e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') onFocus(focus); },
      className: 'cursor-pointer hover:bg-muted/40 rounded transition-colors' } : {};

  return (
    <section data-testid="pk-headline" className="space-y-4">
      {/* 1) Hero: Schlagzeile links · Kernzahlen rechts ----------------------- */}
      <div className="rounded-xl border border-border bg-gradient-to-br from-card to-muted/30 p-5 shadow-sm flex flex-col lg:flex-row lg:items-stretch gap-4">
        <div className="space-y-3 min-w-0 flex-1">
        <p className="text-sm font-medium text-muted-foreground">
          Personalkosten {monthLabel} <span className="text-xs">(Hochrechnung)</span>
        </p>
        <p data-testid="pk-headline-value" className="text-3xl sm:text-4xl font-black tabular-nums tracking-tight">
          {fmtCHF(hrTotalCHF)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {hasBudget && (
            <span
              data-testid="pk-headline-chip-abw"
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold',
                ueberBudget
                  ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300'
                  : 'bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300',
              )}
            >
              {abwHr > 0.5 ? '▲' : abwHr < -0.5 ? '▼' : '='} {abwHr >= 0 ? '+' : '−'}{fmtCHF(Math.abs(abwHr))}
              {abwPct != null && ` (${abwHr >= 0 ? '+' : '−'}${Math.abs(abwPct).toFixed(1)} %)`}
              <span className="font-normal opacity-80"> zum Budget</span>
            </span>
          )}
          {pkqHrPct != null && (
            <span
              data-testid="pk-headline-chip-pkq"
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold',
                pkqHrPct > OBERGRENZE_PCT
                  ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300'
                  : pkqHrPct > zielPct
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'
                    : 'bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300',
              )}
            >
              PKQ {pkqHrPct.toFixed(1)} %
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Budget {hasBudget ? fmtCHF(budgetCHF) : '—'} · Ziel {zielPct.toFixed(1)} % / Obergrenze {OBERGRENZE_PCT} %
          {' · '}
          <span data-testid="pk-headline-isttage">
            Stand: {stichtag} von {daysInMonth} Tagen abgeschlossen
            {istTage < stichtag && `, davon ${istTage} mit Ist-Umsatz`}
          </span>
        </p>
        </div>

        {/* Rechts: kompakte Kernzahlen (keine separaten Boxen) --------------- */}
        <div
          data-testid="pk-headline-keyfigures"
          className="lg:w-[340px] shrink-0 lg:border-l lg:border-border/70 lg:pl-5 flex flex-col justify-center gap-1.5 text-sm"
        >
          <div {...focusBtn('budget')} data-testid="pk-key-budget">
            <div className="flex items-baseline justify-between gap-3 px-1 py-0.5">
              <span className="text-muted-foreground">Budget</span>
              <span className="font-bold font-mono tabular-nums">{hasBudget ? fmtCHF(budgetCHF) : '—'}</span>
            </div>
            <p className="px-1 -mt-0.5 text-[10px] text-muted-foreground">
              {hasBudget
                ? `${zielPct.toFixed(1)} % von Umsatz-Budget ${fmtCHF(umsatzBudgetCHF)}`
                : `Kein Umsatz-Budget ${monthLabel} hinterlegt`}
            </p>
          </div>
          <div {...focusBtn('abweichung')} data-testid="pk-key-abweichung">
            <div className="flex items-baseline justify-between gap-3 px-1 py-0.5">
              <span className="text-muted-foreground">Abweichung (HR − Budget)</span>
              <span className={cn('font-bold font-mono tabular-nums',
                hasBudget ? (ueberBudget ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400') : '')}>
                {hasBudget ? `${abwHr >= 0 ? '+' : '−'}${fmtCHF(Math.abs(abwHr))}` : '—'}
              </span>
            </div>
            <p className="px-1 -mt-0.5 text-[10px] text-muted-foreground">
              {hasBudget ? (ueberBudget ? 'über Budget' : abwHr < -0.5 ? 'unter Budget' : 'im Budget') : 'Kein Budget hinterlegt'}
            </p>
          </div>
          <div {...focusBtn('quote')} data-testid="pk-key-pkq">
            <div className="flex items-baseline justify-between gap-3 px-1 py-0.5">
              <span className="text-muted-foreground">PKQ Hochrechnung</span>
              <span className={cn('font-bold font-mono tabular-nums',
                pkqHrPct != null
                  ? (pkqHrPct > OBERGRENZE_PCT ? 'text-red-600 dark:text-red-400'
                    : pkqHrPct > zielPct ? 'text-amber-600 dark:text-amber-400'
                    : 'text-emerald-600 dark:text-emerald-400')
                  : '')}>
                {pkqHrPct != null ? `${pkqHrPct.toFixed(1)} %` : '—'}
              </span>
            </div>
            <p className="px-1 -mt-0.5 text-[10px] text-muted-foreground">
              Umsatz HR {fmtCHF(umsatzHochrechnungCHF)}
            </p>
          </div>
          <div {...focusBtn('ist')} data-testid="pk-key-fixflex">
            <div className="flex items-baseline justify-between gap-3 px-1 py-0.5 border-t border-border/60 pt-1.5">
              <span className="text-muted-foreground">FIX + FLEX</span>
              <span className="font-mono tabular-nums text-xs">
                <span className="font-semibold text-blue-700 dark:text-blue-400">{fmtCHF(hrFixCHF)}</span>
                <span className="text-muted-foreground"> + </span>
                <span className="font-semibold text-orange-700 dark:text-orange-400">{fmtCHF(hrFlexCHF)}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
      {/* 3) Ist-Zeile --------------------------------------------------------- */}
      <div
        data-testid="pk-ist-row"
        className="rounded-lg border border-border/70 bg-muted/20 px-4 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-1"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Ist bis {istDatum}
        </span>
        <span className="text-sm">
          <span className="text-muted-foreground">Personalkosten Ist </span>
          <span className="font-bold tabular-nums">{fmtCHF(istTotalCHF)}</span>
        </span>
        <span className="text-sm">
          <span className="text-muted-foreground">Netto-Umsatz Ist </span>
          <span className="font-bold tabular-nums">{fmtCHF(umsatzIstCHF)}</span>
        </span>
        <span className="text-sm">
          <span className="text-muted-foreground">PKQ Ist </span>
          <span className="font-bold tabular-nums">
            {pkqIst != null ? `${(pkqIst * 100).toFixed(1)} %` : '—'}
          </span>
        </span>
      </div>
    </section>
  );
}
