import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ProductivityDay } from '@/lib/control-list-productivity';

export function ProductivityChart({ days, onSelect }: { days: ProductivityDay[]; onSelect: (day: ProductivityDay) => void }) {
  const hasRevenue = days.some(day => day.revenue !== undefined);
  const data = days.map(day => ({
    ...day,
    label: new Date(`${day.date}T12:00:00`).toLocaleDateString('de-CH', { weekday: 'short' }),
    barValue: hasRevenue ? day.revenue : day.netHours,
  }));
  if (!data.length) return <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">Keine Tage in dieser Kalenderwoche.</div>;
  return <div className="h-80 w-full min-w-[620px]">
    <ResponsiveContainer>
      <ComposedChart data={data} margin={{ top: 28, right: 24, left: 4, bottom: 0 }} onClick={state => {
        const index = state?.activeTooltipIndex;
        if (typeof index === 'number' && data[index]) onSelect(data[index]);
      }}>
        <CartesianGrid strokeDasharray="3 5" vertical={false} stroke="hsl(var(--border))" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} />
        <YAxis yAxisId="primary" tickLine={false} axisLine={false} tickFormatter={value => hasRevenue ? `${Math.round(value / 1000)}k` : `${value}h`} />
        <YAxis yAxisId="productivity" orientation="right" domain={[0, 'auto']} tickLine={false} axisLine={false} />
        <Tooltip
          formatter={(value, name) => name === 'barValue'
            ? [`${Number(value).toLocaleString('de-CH')} ${hasRevenue ? 'CHF' : 'Std'}`, hasRevenue ? 'Netto-Umsatz' : 'Besatzung']
            : [`${Math.round(Number(value))} CHF/Std`, 'Produktivität']}
          labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ''}
        />
        <ReferenceLine
          yAxisId="productivity"
          y={100}
          stroke="#c9a227"
          strokeDasharray="5 5"
          label={{ value: 'Budget 100', position: 'insideTopRight', fill: '#765f16', fontSize: 11 }}
        />
        <Bar
          yAxisId="primary"
          dataKey="barValue"
          fill="#d7b65d"
          radius={[4, 4, 0, 0]}
          cursor="pointer"
          label={({ x, y, width, index }: { x?: number; y?: number; width?: number; index?: number }) => {
            const item = typeof index === 'number' ? data[index] : undefined;
            if (!item || x === undefined || y === undefined || width === undefined) return null;
            return <text x={x + width / 2} y={y + 14} textAnchor="middle" fill="#594911" fontSize="10" fontWeight="600">
              {item.netHours.toLocaleString('de-CH', { maximumFractionDigits: 1 })} Std
            </text>;
          }}
        />
        <Line
          yAxisId="productivity"
          type="monotone"
          dataKey="productivity"
          stroke="#165f58"
          strokeWidth={2.5}
          connectNulls={false}
          dot={({ cx, cy, payload }: { cx?: number; cy?: number; payload?: { productivity?: number } }) => {
            if (cx === undefined || cy === undefined || payload?.productivity === undefined) return <g />;
            const label = String(Math.round(payload.productivity));
            const good = Math.round(payload.productivity) >= 100;
            const width = Math.max(34, label.length * 7 + 14);
            return <g>
              <rect x={cx - width / 2} y={cy - 12} width={width} height={22} rx={11} fill={good ? '#176a4c' : '#9f3f38'} />
              <text x={cx} y={cy + 3} textAnchor="middle" fill="#fff" fontSize="10" fontWeight="700">{label}</text>
            </g>;
          }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  </div>;
}