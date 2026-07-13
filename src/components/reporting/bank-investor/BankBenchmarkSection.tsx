/**
 * Benchmark-Vergleich (Spez. Phase 2 §7) — Ist vs. Branchen-Zielwert mit
 * Ampel. Zielwerte sind zentrale Konstanten (BANK_BENCHMARKS), Abweichung
 * positiv = besser als Ziel.
 */
import { InfoTip } from '@/components/ui/info-tip';
import { StatusPill } from '@/components/ui/status-pill';
import { TABLE, TH, TH_NUM, TD, TD_NUM } from '@/components/ui/table-style';
import { fmtPp, type BankBenchmarkRow } from '@/lib/bank-investor-analysis';
import { pctFmt, toneToUi, SectionCard } from './bank-phase2-ui';

const TONE_WORD = { good: 'erfüllt', critical: 'verfehlt', neutral: 'im Toleranzband' } as const;

export function BankBenchmarkSection({ benchmarks, year }: { benchmarks: BankBenchmarkRow[]; year: number }) {
  return (
    <SectionCard
      title={`Benchmark-Vergleich ${year}`}
      testId="bank-benchmarks"
      info={<InfoTip text="Vergleich der wichtigsten Quoten mit branchenüblichen Zielwerten für die Gastronomie (feste Zielwerte, keine Schätzungen). Abweichung positiv = besser als Ziel; kleine Abweichungen innerhalb des Toleranzbands gelten als neutral. Fehlende Daten werden als — ausgewiesen, nie als 0." />}
    >
      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>Kennzahl</th>
              <th className={TH_NUM}>Ist</th>
              <th className={TH_NUM}>Ziel</th>
              <th className={TH_NUM}>Abweichung</th>
              <th className={TH}>Bewertung</th>
            </tr>
          </thead>
          <tbody>
            {benchmarks.map(b => (
              <tr key={b.id} data-testid={`bank-benchmark-${b.id}`}>
                <td className={TD}>{b.label}</td>
                <td className={TD_NUM}>{pctFmt(b.ist)}</td>
                <td className={TD_NUM}>{b.direction === 'below' ? '≤' : '≥'} {pctFmt(b.target)}</td>
                <td className={TD_NUM}>{b.abweichungPp == null ? '—' : fmtPp(b.abweichungPp)}</td>
                <td className={TD}>
                  <StatusPill tone={toneToUi[b.tone]} size="xs">
                    {b.ist == null ? 'keine Daten' : TONE_WORD[b.tone]}
                  </StatusPill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
