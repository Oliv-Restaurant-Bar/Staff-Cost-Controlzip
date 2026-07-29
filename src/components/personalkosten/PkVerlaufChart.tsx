/**
 * Verlaufsgrafik (Etappe 4): kumulierte Personalkosten über den Monat.
 *  - Ist (durchgezogen) bis heute
 *  - Plan-Hochrechnung (gestrichelt) ab morgen
 *  - gerade Budget-Linie
 * Reine Darstellung — Datenpunkte kommen aus buildKumulierterVerlauf (Kern).
 */
import {
  LineChart, Line as RLine, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { PK_COLORS } from './pk-colors';
import type { VerlaufPunkt } from '@/lib/personalkosten-darstellung';

export interface PkVerlaufChartProps {
  punkte: VerlaufPunkt[];
  fmtCHF: (n: number) => string;
}

export function PkVerlaufChart({ punkte, fmtCHF }: PkVerlaufChartProps) {
  if (punkte.length === 0) return null;
  const rows = punkte.map(p => ({
    label: `${String(p.day).padStart(2, '0')}.`,
    ist: p.istKum,
    plan: p.planKum,
    budget: p.budgetKum,
  }));
  const hasBudget = punkte.some(p => p.budgetKum != null);

  return (
    <section
      data-testid="pk-verlauf-chart"
      className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-2"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Verlauf: kumulierte Personalkosten</h2>
        <span className="text-[11px] text-muted-foreground">Ist durchgezogen · Plan gestrichelt · Budget gerade</span>
      </div>
      <div style={{ width: '100%', height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted/50" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis
              tick={{ fontSize: 10 }}
              tickFormatter={(v: number) => fmtCHF(v)}
              width={64}
            />
            <RTooltip
              formatter={(v: number | null, name: string) => [v == null ? '—' : fmtCHF(v), name]}
              labelFormatter={(l: string) => `Tag ${l}`}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {hasBudget && (
              <RLine
                type="monotone" dataKey="budget" name="Budget"
                stroke={PK_COLORS.budget} strokeWidth={2} dot={false} connectNulls
              />
            )}
            <RLine
              type="monotone" dataKey="plan" name="Plan (Hochrechnung)"
              stroke={PK_COLORS.plan} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls
            />
            <RLine
              type="monotone" dataKey="ist" name="Ist"
              stroke={PK_COLORS.ist} strokeWidth={2.5} dot={false} connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
