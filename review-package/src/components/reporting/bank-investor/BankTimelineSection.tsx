/**
 * Investor Timeline (Spez. Phase 2 §10) — Datenlage je Geschäftsjahr:
 * Vollständigkeit, Umsatz, EBIT und Importdatum aus der Import-Registry.
 */
import { InfoTip } from '@/components/ui/info-tip';
import { StatusPill } from '@/components/ui/status-pill';
import { TABLE, TH, TH_NUM, TD, TD_NUM } from '@/components/ui/table-style';
import type { Tone } from '@/components/ui/tones';
import type { BankTimelineEntry } from '@/lib/bank-investor-analysis';
import { chfFmt, fmtDateCH, SectionCard } from './bank-phase2-ui';

const STATUS_TONE: Record<BankTimelineEntry['status'], Tone> = {
  vollständig: 'good', teilweise: 'warn', leer: 'neutral',
};

export function BankTimelineSection({ timeline }: { timeline: BankTimelineEntry[] }) {
  return (
    <SectionCard
      title="Datenbasis je Geschäftsjahr"
      testId="bank-timeline"
      info={<InfoTip text="Übersicht der importierten Erfolgsrechnungsdaten: Anzahl Monate mit Daten, Jahres-Umsatz und -EBIT (Summe der vorhandenen Monate) sowie das Importdatum aus dem Import-Center. Ohne Import-Eintrag bleibt das Datum leer." />}
    >
      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>Jahr</th>
              <th className={TH}>Status</th>
              <th className={TH_NUM}>Monate mit Daten</th>
              <th className={TH_NUM}>Umsatz</th>
              <th className={TH_NUM}>EBIT</th>
              <th className={TH}>Importiert am</th>
            </tr>
          </thead>
          <tbody>
            {timeline.map(t => (
              <tr key={t.year} data-testid={`bank-timeline-${t.year}`}>
                <td className={`${TD} font-medium`}>{t.year}</td>
                <td className={TD}>
                  <StatusPill tone={STATUS_TONE[t.status]} size="xs">{t.status}</StatusPill>
                </td>
                <td className={TD_NUM}>{t.monthsWithData} / 12</td>
                <td className={TD_NUM}>{chfFmt(t.umsatz)}</td>
                <td className={TD_NUM}>{chfFmt(t.ebit)}</td>
                <td className={TD}>{fmtDateCH(t.importedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
