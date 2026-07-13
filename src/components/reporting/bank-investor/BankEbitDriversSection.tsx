/**
 * EBIT-Treiberanalyse (Spez. Phase 2 §5) — was hat die EBIT-Veränderung
 * getrieben? Beiträge in CHF (+ = verbessert EBIT), Summe ≡ EBIT-Delta.
 */
import { useMemo } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, Cell, ReferenceLine,
} from 'recharts';
import { InfoTip } from '@/components/ui/info-tip';
import { HintBox } from '@/components/ui/hint-box';
import type { BankEbitDrivers } from '@/lib/bank-investor-analysis';
import { chfFmt, pctFmt, SectionCard } from './bank-phase2-ui';

export function BankEbitDriversSection({ drivers }: { drivers: BankEbitDrivers }) {
  const chartData = useMemo(
    () => drivers.drivers.map(d => ({ label: d.label, contribution: d.contribution, pct: d.pctOfBaseEbit })),
    [drivers],
  );
  const anyData = drivers.drivers.some(d => d.contribution != null);
  return (
    <SectionCard
      title={`EBIT-Treiber ${drivers.baseYear} → ${drivers.currentYear}`}
      testId="bank-ebit-drivers"
      info={<InfoTip text="Zerlegt die EBIT-Veränderung in ihre Treiber: Umsatz (+ = mehr Ertrag) sowie Waren-, Personal-, übriger Betriebsaufwand und Abschreibungen (+ = Kosten gesunken). Die Beiträge summieren sich exakt zur EBIT-Veränderung — keine Schätzungen." />}
    >
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground" data-testid="bank-ebit-drivers-summary">
        <span>EBIT {drivers.baseYear}: <strong className="text-foreground">CHF {chfFmt(drivers.ebitBase)}</strong></span>
        <span>EBIT {drivers.currentYear}: <strong className="text-foreground">CHF {chfFmt(drivers.ebitCurrent)}</strong></span>
        <span>Veränderung: <strong className="text-foreground">
          {drivers.ebitDelta == null ? '—' : `${drivers.ebitDelta >= 0 ? '+' : '−'}CHF ${chfFmt(Math.abs(drivers.ebitDelta))}`}
        </strong></span>
      </div>
      {anyData ? (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
              <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={170} />
              <RechartsTooltip
                formatter={(val: number, _n, entry) => {
                  const p = entry?.payload as (typeof chartData)[number] | undefined;
                  const pctT = p?.pct != null ? ` (${pctFmt(p.pct)} des Basis-EBIT)` : '';
                  return [`${val >= 0 ? '+' : '−'}CHF ${chfFmt(Math.abs(val))}${pctT}`, 'Beitrag zur EBIT-Veränderung'];
                }}
              />
              <ReferenceLine x={0} stroke="hsl(var(--border))" />
              <Bar dataKey="contribution" radius={[0, 2, 2, 0]} isAnimationActive={false}>
                {chartData.map((d, i) => (
                  <Cell key={i} fill={(d.contribution ?? 0) >= 0 ? 'hsl(152 45% 42%)' : 'hsl(0 60% 50%)'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <HintBox tone="info">Für die Treiberanalyse fehlen Daten in einem der beiden Jahre.</HintBox>
      )}
      {!drivers.complete && anyData && (
        <HintBox tone="warn">Nicht alle Positionen sind in beiden Jahren vorhanden — fehlende Treiber bleiben leer und werden nicht als 0 gewertet.</HintBox>
      )}
    </SectionCard>
  );
}
