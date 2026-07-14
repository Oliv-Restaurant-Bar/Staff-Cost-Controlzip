/**
 * Executive Summary (Spez. Phase 2 §2) — 9 KPI-Karten + regelbasierter
 * Gesamttrend. Reine Anzeige des zentralen Analysis-Objekts.
 */
import { KpiCard, KpiGrid, MoreKpis } from '@/components/ui/kpi-card';
import { StatusPill } from '@/components/ui/status-pill';
import { InfoTip } from '@/components/ui/info-tip';
import type { Tone } from '@/components/ui/tones';
import { TONE_BOX } from '@/components/ui/tones';
import type { BankExecutiveSummary, BankKpi } from '@/lib/bank-investor-analysis';
import { toneToUi } from './bank-phase2-ui';

function kpiTrend(k: BankKpi): { direction: 'up' | 'down' | 'flat'; tone: Tone; label: string } | undefined {
  if (!k.delta) return undefined;
  const diff = k.raw.diffPp ?? k.raw.diffPct ?? k.raw.diffChf;
  const direction = diff == null || diff === 0 ? 'flat' : diff > 0 ? 'up' : 'down';
  return { direction, tone: toneToUi[k.tone], label: k.delta };
}

const TREND_LABEL: Record<BankExecutiveSummary['gesamtTrend']['label'], string> = {
  positiv: 'Gesamttrend: positiv',
  stabil: 'Gesamttrend: stabil',
  kritisch: 'Gesamttrend: kritisch',
};

export function BankExecutiveSection({ executive }: { executive: BankExecutiveSummary }) {
  const main = executive.kpis.slice(0, 4);
  const more = executive.kpis.slice(4);
  const tone = toneToUi[executive.gesamtTrend.tone];
  return (
    <div className="space-y-3">
      <div
        className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${TONE_BOX[tone]}`}
        data-testid="bank-gesamttrend"
      >
        <StatusPill tone={tone}>{TREND_LABEL[executive.gesamtTrend.label]}</StatusPill>
        <span className="text-xs">
          {executive.gesamtTrend.reasons.join(' · ')}
        </span>
        <InfoTip text="Regelbasierte Einordnung aus Umsatzwachstum, EBIT-Entwicklung, Waren- und Personalquote sowie EBIT-Marge (neuestes Jahr vs. Vorjahr im Vergleichszeitraum). Keine Schätzungen." />
      </div>
      <div data-testid="bank-kpis">
        <KpiGrid>
          {main.map(k => (
            <KpiCard
              key={k.id}
              label={k.label}
              value={k.value}
              tone={toneToUi[k.tone]}
              trend={kpiTrend(k)}
              data-testid={`bank-kpi-${k.id}`}
            />
          ))}
        </KpiGrid>
        {more.length > 0 && (
          <MoreKpis storageKey="bank-investor-more-kpis" className="mt-3">
            <KpiGrid>
              {more.map(k => (
                <KpiCard
                  key={k.id}
                  label={k.label}
                  value={k.value}
                  tone={toneToUi[k.tone]}
                  trend={kpiTrend(k)}
                  data-testid={`bank-kpi-${k.id}`}
                />
              ))}
            </KpiGrid>
          </MoreKpis>
        )}
      </div>
    </div>
  );
}
