/**
 * Saisonalitäts-Heatmap (Spez. Phase 2 §8) — Jahr × Monat je Metrik.
 * Beschreibende Einordnung relativ zum Durchschnitt (bewusst keine
 * gut/schlecht-Ampel); fehlende Monate bleiben leer.
 */
import { useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { InfoTip } from '@/components/ui/info-tip';
import type { BankHeatmap, BankHeatmapMetricId } from '@/lib/bank-investor-analysis';
import { chfFmt, pctFmt, HEATMAP_BUCKET_STYLE, HEATMAP_BUCKET_LABEL, SectionCard } from './bank-phase2-ui';

const MONTH_LABELS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const METRIC_ORDER: BankHeatmapMetricId[] = ['umsatz', 'ebit', 'warenquote', 'personalquote'];

export function BankHeatmapSection({ heatmaps }: { heatmaps: Record<BankHeatmapMetricId, BankHeatmap> }) {
  const [metric, setMetric] = useState<BankHeatmapMetricId>('umsatz');
  const hm = heatmaps[metric];
  const fmt = hm.unit === 'chf' ? chfFmt : pctFmt;
  return (
    <SectionCard
      title="Saisonalität (Jahr × Monat)"
      testId="bank-heatmap"
      info={<InfoTip text="Monatswerte aller gewählten Jahre, eingefärbt relativ zum Durchschnitt aller vorhandenen Monate (beschreibend, keine Bewertung). Fehlende Monate bleiben leer — es wird nichts geschätzt." />}
      actions={
        <Select value={metric} onValueChange={v => setMetric(v as BankHeatmapMetricId)}>
          <SelectTrigger className="h-8 w-[180px] text-xs" data-testid="bank-heatmap-metric">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METRIC_ORDER.map(id => (
              <SelectItem key={id} value={id}>{heatmaps[id].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr>
              <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Jahr</th>
              {MONTH_LABELS.map(m => (
                <th key={m} className="text-right px-2 py-1.5 font-medium text-muted-foreground">{m}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {hm.rows.map(row => (
              <tr key={row.year} data-testid={`bank-heatmap-row-${row.year}`}>
                <td className="px-2 py-1 font-medium">{row.year}</td>
                {row.cells.map((c, i) => (
                  <td
                    key={i}
                    className={`px-2 py-1 text-right tabular-nums ${c.bucket ? HEATMAP_BUCKET_STYLE[c.bucket] : 'text-muted-foreground'}`}
                    title={c.bucket ? HEATMAP_BUCKET_LABEL[c.bucket] : undefined}
                  >
                    {c.value == null ? '' : hm.unit === 'chf' ? chfFmt(c.value) : fmt(c.value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>Ø: <strong className="text-foreground">{hm.average == null ? '—' : hm.unit === 'chf' ? `CHF ${chfFmt(hm.average)}` : pctFmt(hm.average)}</strong></span>
        {(Object.keys(HEATMAP_BUCKET_LABEL) as (keyof typeof HEATMAP_BUCKET_LABEL)[]).map(b => (
          <span key={b} className="inline-flex items-center gap-1">
            <span className={`inline-block h-3 w-3 rounded-sm border border-border ${HEATMAP_BUCKET_STYLE[b]}`} />
            {HEATMAP_BUCKET_LABEL[b]}
          </span>
        ))}
      </div>
    </SectionCard>
  );
}
