/**
 * NEUE Personalkosten-Schlagzeile (Etappe 4, «vom Groben ins Feine»).
 * Reine Darstellung — ALLE Zahlen kommen fertig aus dem zentralen Kern
 * (personalkosten.ts) über die Props. Hier findet KEINE Rechnung statt.
 *
 * Aufbau (oben → unten):
 *  1) Schlagzeile: «Personalkosten <Monat> (Hochrechnung) = CHF X» + Chips
 *     (Abweichung Budget, PKQ) + Zusatzzeile (Budget, Ziel/Obergrenze, Ist-Tage).
 *  2) Vier Kacheln: Hochrechnung / Budget / Abweichung / PKQ-Hochrechnung.
 *  3) Ist-Zeile: Personalkosten Ist · Netto-Umsatz Ist · PKQ Ist (bis <Datum>).
 */
import { KpiCard as DsKpiCard, KpiGrid } from '@/components/ui/kpi-card';
import { InfoTip } from '@/components/ui/info-tip';
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

  return (
    <section data-testid="pk-headline" className="space-y-4">
      {/* 1) Schlagzeile ------------------------------------------------------- */}
      <div className="rounded-xl border border-border bg-gradient-to-br from-card to-muted/30 p-5 shadow-sm space-y-3">
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
          <span data-testid="pk-headline-isttage">Stand: {istTage} von {daysInMonth} Tagen als Ist erfasst</span>
        </p>
      </div>

      {/* 2) Vier Kacheln ------------------------------------------------------ */}
      <KpiGrid>
        <DsKpiCard
          label="Hochrechnung"
          value={fmtCHF(hrTotalCHF)}
          sub={`FIX ${fmtCHF(hrFixCHF)} + FLEX ${fmtCHF(hrFlexCHF)}`}
          tone={hasBudget ? (hrTotalCHF <= budgetCHF ? 'good' : 'critical') : 'neutral'}
          onClick={onFocus ? () => onFocus('ist') : undefined}
        />
        <DsKpiCard
          label="Budget"
          value={hasBudget ? fmtCHF(budgetCHF) : '—'}
          sub={hasBudget
            ? `${zielPct.toFixed(1)} % von Umsatz-Budget ${fmtCHF(umsatzBudgetCHF)}`
            : `Kein Umsatz-Budget ${monthLabel} hinterlegt`}
          tone="info"
          onClick={onFocus ? () => onFocus('budget') : undefined}
        />
        <DsKpiCard
          label="Abweichung (HR − Budget)"
          value={hasBudget ? `${abwHr >= 0 ? '+' : '−'}${fmtCHF(Math.abs(abwHr))}` : '—'}
          sub={hasBudget ? (ueberBudget ? 'über Budget' : abwHr < -0.5 ? 'unter Budget' : 'im Budget') : 'Kein Budget hinterlegt'}
          tone={hasBudget ? (abwHr <= 0.5 ? 'good' : 'critical') : 'neutral'}
          onClick={onFocus ? () => onFocus('abweichung') : undefined}
        />
        <DsKpiCard
          label="PKQ Hochrechnung"
          value={pkqHrPct != null ? `${pkqHrPct.toFixed(1)} %` : '—'}
          sub={
            <span className="inline-flex items-center gap-1">
              {`Umsatz HR ${fmtCHF(umsatzHochrechnungCHF)}`}
              <InfoTip
                side="top"
                text={
                  <span>
                    <b>PKQ = Personalkosten ÷ Nettoumsatz</b> (immer gleiche Basis).
                    {pkqHrPct != null && (
                      <>
                        <br />Hochrechnung: {fmtCHF(hrTotalCHF)} ÷ {fmtCHF(umsatzHochrechnungCHF)} = {pkqHrPct.toFixed(1)} %
                        <br />Ziel {zielPct.toFixed(1)} %, Obergrenze {OBERGRENZE_PCT} %.
                      </>
                    )}
                  </span>
                }
              />
            </span>
          }
          tone={pkqHrPct != null
            ? (pkqHrPct > OBERGRENZE_PCT ? 'critical' : pkqHrPct > zielPct ? 'warn' : 'good')
            : 'neutral'}
          onClick={onFocus ? () => onFocus('quote') : undefined}
        />
      </KpiGrid>

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
