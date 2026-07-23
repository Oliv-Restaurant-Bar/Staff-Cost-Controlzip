/**
 * FinancialMonthSection — Finanzielle Monatsübersicht (Dashboard, Bereich 1).
 * ===========================================================================
 * REIN LESEND: Alle Werte kommen ausschliesslich aus der Financial Metrics
 * Registry (getFinancialMetricValues) — IST = Erfolgsrechnung (P&L-Engine),
 * PLAN = Budget-Spalte, VORJAHR = Vorjahres-P&L. Immer NETTO.
 *
 * Fehlende Werte bleiben „—" (fehlend ≠ 0) und werden NIE mit operativen
 * Tageswerten ersetzt. Keine eigene Berechnung, keine Rundung ausser Anzeige.
 */

import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { KpiCard, KpiGrid } from '@/components/ui/kpi-card';
import type { Tone } from '@/components/ui/tones';
import {
  getGatedFinancialMetricValues,
  type FinancialMetricId,
  type FinancialMetricRegistryInput,
  type FinancialMetricValues,
} from '@/lib/financial-metrics';

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

/** Δ in % gegenüber Budget aus Rohwerten; Basis fehlt/0 ⇒ null. */
function deltaPct(actual: number | null, base: number | null): number | null {
  if (actual === null || base === null || base === 0) return null;
  return ((actual - base) / base) * 100;
}

interface TableRow {
  id: FinancialMetricId;
  label: string;
  kind: 'amount' | 'ratio';
}

/** Zeilen der IST/Budget/Vorjahr-Tabelle (Reihenfolge = P&L-Struktur). */
const TABLE_ROWS: TableRow[] = [
  { id: 'net_revenue',     label: 'Nettoumsatz',       kind: 'amount' },
  { id: 'total_cogs',      label: 'Warenaufwand',      kind: 'amount' },
  { id: 'cogs_ratio',      label: 'Warenkostenquote',  kind: 'ratio'  },
  { id: 'total_personnel', label: 'Personalkosten',    kind: 'amount' },
  { id: 'personnel_ratio', label: 'Personalquote',     kind: 'ratio'  },
  { id: 'ebitda',          label: 'EBITDA',            kind: 'amount' },
  { id: 'ebit',            label: 'EBIT',              kind: 'amount' },
];

export function FinancialMonthSection({
  input,
  monthLabel,
  personnelRatioTarget = null,
}: {
  /** Registry-Input (EIN computePLForMonth) — null = Berechnung fehlgeschlagen. */
  input: FinancialMetricRegistryInput | null;
  /** Anzeige-Label des Monats, z. B. „Juli 2026". */
  monthLabel: string;
  /** Ziel-Personalquote in % (aus Budget) — nur für die Ampel, optional. */
  personnelRatioTarget?: number | null;
}) {
  const navigate = useNavigate();

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Finanzielle Monatsübersicht · {monthLabel}
        </h2>
        <p className="text-[11px] text-muted-foreground">
          Quelle: Erfolgsrechnung (IST) · Budget (Plan) · Vorjahres-P&L — netto
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/erfolgsrechnung')}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          data-testid="fin-link-erfolgsrechnung"
        >
          Erfolgsrechnung <ArrowRight className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={() => navigate('/budget')}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          data-testid="fin-link-budget"
        >
          Budget <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );

  if (!input) {
    return (
      <section aria-label="Finanzielle Monatsübersicht" className="space-y-2" data-testid="financial-month-section">
        {header}
        <div className="rounded-lg border border-dashed border-border bg-muted/10 p-4 text-xs text-muted-foreground">
          Finanzdaten für {monthLabel} konnten nicht berechnet werden. Die Kennzahlen
          bleiben leer — es werden keine operativen Ersatzwerte angezeigt.
        </div>
      </section>
    );
  }

  const values: Record<FinancialMetricId, FinancialMetricValues> = {} as Record<
    FinancialMetricId,
    FinancialMetricValues
  >;
  // Dependency-Gate (financial-metrics): Ergebnis-Kennzahlen nur, wenn ALLE
  // erforderlichen Komponenten der Spalte vorhanden sind — fehlt z. B. der
  // Kostenimport, ist EBIT «—» und NIE ein Scheinwert (EBIT ≡ Umsatz).
  for (const row of TABLE_ROWS) values[row.id] = getGatedFinancialMetricValues(row.id, input);

  const rev  = values.net_revenue;
  const pers = values.total_personnel;
  const persQ = values.personnel_ratio;
  const ebitda = values.ebitda;
  const ebit = values.ebit;

  const revDelta  = deltaPct(rev.actual, rev.budget);
  const persDelta = deltaPct(pers.actual, pers.budget);

  const persQTone: Tone =
    persQ.actual === null ? 'neutral'
    : personnelRatioTarget === null ? 'info'
    : persQ.actual <= personnelRatioTarget ? 'good'
    : persQ.actual <= personnelRatioTarget + 5 ? 'warn'
    : 'critical';

  return (
    <section aria-label="Finanzielle Monatsübersicht" className="space-y-2" data-testid="financial-month-section">
      {header}

      <KpiGrid>
        <KpiCard
          label="Umsatz gemäss Erfolgsrechnung"
          value={fmtCHF(rev.actual)}
          tone={rev.actual === null ? 'neutral' : revDelta === null ? 'info' : revDelta >= 0 ? 'good' : 'critical'}
          trend={revDelta !== null ? {
            direction: revDelta >= 0 ? 'up' : 'down',
            tone: revDelta >= 0 ? 'good' : 'critical',
            label: `${revDelta >= 0 ? '+' : ''}${revDelta.toFixed(1)} % vs. Budget`,
          } : undefined}
          sub={`Budget ${fmtCHF(rev.budget)} · Vorjahr ${fmtCHF(rev.priorYear)}`}
          data-testid="fin-kpi-net_revenue"
        />
        <KpiCard
          label="Personalkosten gemäss Erfolgsrechnung"
          value={fmtCHF(pers.actual)}
          tone={persQTone}
          trend={persDelta !== null ? {
            direction: persDelta >= 0 ? 'up' : 'down',
            tone: persDelta <= 0 ? 'good' : 'critical',
            label: `${persDelta >= 0 ? '+' : ''}${persDelta.toFixed(1)} % vs. Budget`,
          } : undefined}
          sub={persQ.actual !== null
            ? `Personalquote ${fmtPct(persQ.actual)}${personnelRatioTarget !== null ? ` · Ziel ≤ ${personnelRatioTarget.toFixed(1)} %` : ''}`
            : 'Personalquote —'}
          data-testid="fin-kpi-total_personnel"
        />
        <KpiCard
          label="EBITDA"
          value={fmtCHF(ebitda.actual)}
          tone={ebitda.actual === null ? 'neutral' : ebitda.actual >= 0 ? 'good' : 'critical'}
          sub={`Budget ${fmtCHF(ebitda.budget)} · Vorjahr ${fmtCHF(ebitda.priorYear)}`}
          data-testid="fin-kpi-ebitda"
        />
        <KpiCard
          label="EBIT"
          value={fmtCHF(ebit.actual)}
          tone={ebit.actual === null ? 'neutral' : ebit.actual >= 0 ? 'good' : 'critical'}
          sub={`Budget ${fmtCHF(ebit.budget)} · Vorjahr ${fmtCHF(ebit.priorYear)}`}
          data-testid="fin-kpi-ebit"
        />
      </KpiGrid>

      {/* Kompakte IST/Budget/Vorjahr-Tabelle — identische Registry-Rohwerte */}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-muted-foreground">
              <th className="px-3 py-1.5 text-left font-medium">Kennzahl</th>
              <th className="px-3 py-1.5 text-right font-medium">IST (Erfolgsrechnung)</th>
              <th className="px-3 py-1.5 text-right font-medium">Budget</th>
              <th className="px-3 py-1.5 text-right font-medium">Vorjahr</th>
            </tr>
          </thead>
          <tbody>
            {TABLE_ROWS.map(row => {
              const v = values[row.id];
              const fmt = row.kind === 'ratio' ? fmtPct : fmtCHF;
              return (
                <tr key={row.id} className="border-b border-border/60 last:border-0" data-testid={`fin-row-${row.id}`}>
                  <td className="px-3 py-1.5 text-left text-muted-foreground">{row.label}</td>
                  <td className="px-3 py-1.5 text-right font-medium tabular-nums" data-testid={`fin-${row.id}-actual`}>{fmt(v.actual)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums" data-testid={`fin-${row.id}-budget`}>{fmt(v.budget)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums" data-testid={`fin-${row.id}-prioryear`}>{fmt(v.priorYear)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
