/**
 * Kennzahlenhistorie (Spez. Phase 2 §6) — 6 Mini-Charts über alle gewählten
 * Jahre (volle Jahressummen). Teiljahre sind markiert, nie hochgerechnet.
 */
import { useMemo } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip as RechartsTooltip, Cell,
} from 'recharts';
import { InfoTip } from '@/components/ui/info-tip';
import type { BankHistorySeries } from '@/lib/bank-investor-analysis';
import { chfFmt, pctFmt, SectionCard } from './bank-phase2-ui';

function HistoryChart({ series }: { series: BankHistorySeries }) {
  const data = useMemo(() => series.points.map(p => ({
    label: p.complete ? String(p.year) : `${p.year}*`,
    value: p.value,
    complete: p.complete,
  })), [series]);
  const fmt = series.unit === 'chf' ? chfFmt : pctFmt;
  const hasPartial = series.points.some(p => !p.complete && p.value != null);
  return (
    <div className="rounded-md border border-border p-3 space-y-1.5" data-testid={`bank-history-${series.id}`}>
      <div className="text-xs font-medium">{series.label}</div>
      <div className="h-36">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis
              tick={{ fontSize: 10 }}
              width={42}
              tickFormatter={(v: number) => series.unit === 'chf' ? `${Math.round(v / 1000)}k` : `${Math.round(v)}%`}
            />
            <RechartsTooltip
              formatter={(v: number) => [series.unit === 'chf' ? `CHF ${chfFmt(v)}` : pctFmt(v), series.label]}
              labelFormatter={(l: string) => l.endsWith('*') ? `${l.slice(0, -1)} (Teiljahr)` : l}
            />
            {series.unit === 'chf' ? (
              <Bar dataKey="value" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                {data.map((d, i) => (
                  <Cell key={i} fill={d.complete ? 'hsl(221 60% 45%)' : 'hsl(221 40% 70%)'} />
                ))}
              </Bar>
            ) : (
              <Line dataKey="value" type="monotone" stroke="hsl(24 74% 45%)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {hasPartial && <div className="text-[10px] text-muted-foreground">* Teiljahr — Summe der vorhandenen Monate, nicht hochgerechnet</div>}
    </div>
  );
}

export function BankHistorieSection({ historie }: { historie: BankHistorySeries[] }) {
  return (
    <SectionCard
      title="Kennzahlenhistorie"
      testId="bank-historie"
      info={<InfoTip text="Entwicklung der wichtigsten Kennzahlen über alle gewählten Jahre als volle Jahressummen (unabhängig vom Vergleichszeitraum). Unvollständige Jahre sind mit * markiert und werden nie hochgerechnet." />}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {historie.map(s => <HistoryChart key={s.id} series={s} />)}
      </div>
    </SectionCard>
  );
}
