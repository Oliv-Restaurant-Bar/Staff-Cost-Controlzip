/**
 * Waterfall Umsatz → EBIT (Spez. Phase 2 §4) des neuesten Jahres.
 * Klassischer Waterfall über unsichtbare Basis-Balken; Subtotale übernehmen
 * die Engine-Werte (keine Zweitberechnung). Bei unvollständigen Daten wird
 * die Tabelle gezeigt, kein Chart mit erfundenen Nullen.
 */
import { useMemo } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, Cell,
} from 'recharts';
import { InfoTip } from '@/components/ui/info-tip';
import { HintBox } from '@/components/ui/hint-box';
import { TABLE, TH, TH_NUM, TD, TD_NUM } from '@/components/ui/table-style';
import type { BankWaterfall } from '@/lib/bank-investor-analysis';
import { chfFmt, SectionCard } from './bank-phase2-ui';

const STEP_COLOR: Record<'start' | 'cost' | 'subtotal', string> = {
  start: 'hsl(221 60% 45%)',
  cost: 'hsl(24 60% 55%)',
  subtotal: 'hsl(152 45% 42%)',
};

export function BankWaterfallSection({ waterfall }: { waterfall: BankWaterfall }) {
  const chartData = useMemo(() => {
    if (!waterfall.complete) return null;
    let prev = 0;
    return waterfall.steps.map(s => {
      const cum = s.cumulative ?? 0;
      const row = s.kind === 'cost'
        ? { label: s.label, base: cum, bar: prev - cum, kind: s.kind, value: s.value, cumulative: s.cumulative }
        : { label: s.label, base: 0, bar: cum, kind: s.kind, value: s.value, cumulative: s.cumulative };
      prev = cum;
      return row;
    });
  }, [waterfall]);

  return (
    <SectionCard
      title={`Vom Umsatz zum EBIT ${waterfall.year}`}
      testId="bank-waterfall"
      info={<InfoTip text="Stufenweise Überleitung vom Betriebsertrag über Waren-, Personal- und übrigen Betriebsaufwand sowie Abschreibungen zum EBIT. Zwischentotale (Bruttogewinn 1/2, EBITDA) stammen direkt aus der Erfolgsrechnung — keine Zweitberechnung." />}
    >
      {chartData ? (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 24, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
              <RechartsTooltip
                formatter={(val: number, name: string, entry) => {
                  if (name === 'base') return [null, null];
                  const p = entry?.payload as (typeof chartData)[number] | undefined;
                  if (!p) return [chfFmt(val), ''];
                  return [
                    `${p.kind === 'cost' ? '−' : ''}CHF ${chfFmt(Math.abs(p.value ?? 0))} · Zwischenstand CHF ${chfFmt(p.cumulative)}`,
                    p.label,
                  ];
                }}
              />
              <Bar dataKey="base" stackId="wf" fill="transparent" isAnimationActive={false} />
              <Bar dataKey="bar" stackId="wf" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                {chartData.map((d, i) => (
                  <Cell key={i} fill={STEP_COLOR[d.kind as keyof typeof STEP_COLOR]} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <HintBox tone="warn">
          Für {waterfall.year} sind nicht alle Stufen vorhanden — der Waterfall wird als Tabelle gezeigt (fehlende Werte bleiben leer, es wird nichts geschätzt).
        </HintBox>
      )}
      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>Stufe</th>
              <th className={TH_NUM}>Betrag</th>
              <th className={TH_NUM}>Zwischenstand</th>
            </tr>
          </thead>
          <tbody>
            {waterfall.steps.map(s => (
              <tr key={s.id} className={s.kind !== 'cost' ? 'bg-muted/50' : undefined} data-testid={`bank-wf-${s.id}`}>
                <td className={`${TD} ${s.kind !== 'cost' ? 'font-semibold' : ''}`}>{s.label}</td>
                <td className={TD_NUM}>{s.value == null ? '—' : `${s.kind === 'cost' ? '−' : ''}${chfFmt(Math.abs(s.value))}`}</td>
                <td className={`${TD_NUM} ${s.kind !== 'cost' ? 'font-semibold' : ''}`}>{chfFmt(s.cumulative)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="bank-waterfall-note">{waterfall.note}</p>
    </SectionCard>
  );
}
