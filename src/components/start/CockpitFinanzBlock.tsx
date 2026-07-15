/**
 * CockpitFinanzBlock — Finanzblock des Executive Cockpits (Startseite).
 * =====================================================================
 * REIN LESEND: Alle Werte kommen AUSSCHLIESSLICH aus der Financial-Metrics-
 * Registry (getFinancialMetricValues) — IST = Erfolgsrechnung (P&L-Engine),
 * Budget = Budget-Spalte, VJ = Vorjahres-P&L, immer NETTO. Fehlende Werte
 * bleiben «—» (fehlend ≠ 0), NIE operative Ersatzwerte.
 *
 * Kompakte Tabelle mit 5 Kennzahlen (Umsatz, Warenquote, Personalquote,
 * EBITDA, EBIT) × IST/Budget/VJ/Abw.:
 *  - Abw. = IST − Budget aus ROHWERTEN (Beträge in CHF, Quoten in pp);
 *    eine Seite fehlt ⇒ «—». BEWUSST ohne Ampel — es existiert keine
 *    bestehende Warnschwelle für Budget-Abweichungen (nichts erfinden).
 *  - Ampel NUR wo bestehende Regeln existieren: Warenquote via warenPctTone,
 *    Personalquote via personalPctTone mit Budget-Ziel (ohne Ziel keine
 *    Färbung). Ton entscheidet auf dem Rohwert, gerundet wird nur die Anzeige.
 */

import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { TONE_TEXT, type Tone } from '@/components/ui/tones';
import { warenPctTone, personalPctTone } from '@/lib/reporting-export';
import {
  getFinancialMetricValues,
  type FinancialMetricId,
  type FinancialMetricRegistryInput,
} from '@/lib/financial-metrics';
import { cn } from '@/lib/utils';

const DASH = '—';

function fmtCHF(v: number | null): string {
  if (v === null) return DASH;
  return new Intl.NumberFormat('de-CH', {
    style: 'currency',
    currency: 'CHF',
    maximumFractionDigits: 0,
  }).format(v);
}

function fmtPct(v: number | null): string {
  if (v === null) return DASH;
  return `${v.toFixed(1)} %`;
}

/** Abw. = IST − Budget aus Rohwerten; eine Seite fehlt ⇒ null (nie 0 erfinden). */
function deviation(actual: number | null, budget: number | null): number | null {
  if (actual === null || budget === null) return null;
  return actual - budget;
}

function fmtDeviation(v: number | null, kind: 'amount' | 'ratio'): string {
  if (v === null) return DASH;
  const sign = v > 0 ? '+' : '';
  return kind === 'amount' ? `${sign}${fmtCHF(v)}` : `${sign}${v.toFixed(1)} pp`;
}

interface RowDef {
  id: FinancialMetricId;
  label: string;
  kind: 'amount' | 'ratio';
  /** Drilldown auf die bestehende Arbeitsfläche der Kennzahl. */
  route: string;
}

/** Die 5 Cockpit-Kennzahlen (Reihenfolge = P&L-Struktur). */
const ROWS: RowDef[] = [
  { id: 'net_revenue',     label: 'Nettoumsatz',   kind: 'amount', route: '/erfolgsrechnung' },
  { id: 'cogs_ratio',      label: 'Warenquote',    kind: 'ratio',  route: '/erfolgsrechnung' },
  { id: 'personnel_ratio', label: 'Personalquote', kind: 'ratio',  route: '/personal-fix' },
  { id: 'ebitda',          label: 'EBITDA',        kind: 'amount', route: '/erfolgsrechnung' },
  { id: 'ebit',            label: 'EBIT',          kind: 'amount', route: '/erfolgsrechnung' },
];

export function CockpitFinanzBlock({
  input,
  monthLabel,
  personnelRatioTarget,
  isGuest,
}: {
  /** Registry-Input (EIN computePLForMonth) — null = nicht berechenbar. */
  input: FinancialMetricRegistryInput | null;
  /** Anzeige-Label des Monats, z. B. «Juli 2026». */
  monthLabel: string;
  /** Ziel-Personalquote (%) aus dem Budget — null = keine Ampel. */
  personnelRatioTarget: number | null;
  /** Gast-Sessions: keine Drilldown-Links auf gesperrte Flächen. */
  isGuest: boolean;
}) {
  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="cockpit-finanzen" className="text-base font-semibold">
        Finanzen · {monthLabel}
      </h2>
      <span className="text-[11px] text-muted-foreground">
        Erfolgsrechnung (IST) · Budget · Vorjahr — netto
      </span>
    </div>
  );

  if (!input) {
    return (
      <section aria-labelledby="cockpit-finanzen" className="space-y-2" data-testid="cockpit-finanz">
        {header}
        <div
          className="rounded-lg border border-dashed border-border bg-muted/10 p-4 text-xs text-muted-foreground"
          data-testid="cockpit-finanz-empty"
        >
          Finanzdaten für {monthLabel} konnten nicht berechnet werden. Die Kennzahlen bleiben
          leer — es werden keine operativen Ersatzwerte angezeigt.
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="cockpit-finanzen" className="space-y-2" data-testid="cockpit-finanz">
      {header}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-muted-foreground">
              <th className="px-3 py-1.5 text-left font-medium">Kennzahl</th>
              <th className="px-3 py-1.5 text-right font-medium">IST</th>
              <th className="px-3 py-1.5 text-right font-medium">Budget</th>
              <th className="px-3 py-1.5 text-right font-medium">Vorjahr</th>
              <th className="px-3 py-1.5 text-right font-medium">Abw. Budget</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(row => {
              const v = getFinancialMetricValues(row.id, input);
              const fmt = row.kind === 'ratio' ? fmtPct : fmtCHF;
              const dev = deviation(v.actual, v.budget);

              // Ampel NUR aus bestehenden Regeln (Rohwert entscheidet):
              let istTone: Tone | null = null;
              if (row.id === 'cogs_ratio' && v.actual !== null) {
                istTone = warenPctTone(v.actual);
              } else if (
                row.id === 'personnel_ratio' &&
                v.actual !== null &&
                personnelRatioTarget !== null
              ) {
                istTone = personalPctTone(v.actual, personnelRatioTarget);
              }

              return (
                <tr
                  key={row.id}
                  className="border-b border-border/60 last:border-0"
                  data-testid={`cockpit-fin-row-${row.id}`}
                >
                  <td className="px-3 py-1.5 text-left">
                    {isGuest ? (
                      <span className="text-muted-foreground">{row.label}</span>
                    ) : (
                      <Link
                        to={row.route}
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-primary hover:underline"
                      >
                        {row.label}
                        <ArrowRight className="h-3 w-3" />
                      </Link>
                    )}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-1.5 text-right font-medium tabular-nums',
                      istTone !== null && istTone !== 'good' && TONE_TEXT[istTone],
                    )}
                    data-testid={`cockpit-fin-${row.id}-actual`}
                  >
                    {fmt(v.actual)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums" data-testid={`cockpit-fin-${row.id}-budget`}>
                    {fmt(v.budget)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums" data-testid={`cockpit-fin-${row.id}-vj`}>
                    {fmt(v.priorYear)}
                  </td>
                  <td
                    className="px-3 py-1.5 text-right tabular-nums text-muted-foreground"
                    data-testid={`cockpit-fin-${row.id}-abw`}
                  >
                    {fmtDeviation(dev, row.kind)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
