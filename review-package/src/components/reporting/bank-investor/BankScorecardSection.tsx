/**
 * Mehrjahres-Scorecard (Spez. Phase 2 §3) — kompakte Kennzahlentabelle über
 * die gewählten Jahre. Endet bei EBIT (USER-ENTSCHEID, kein Jahresgewinn).
 * Zeilen mit Monatsdetail (Umsatz/Waren/Personal) sind klickbar → Drilldown.
 */
import { InfoTip } from '@/components/ui/info-tip';
import { StatusPill } from '@/components/ui/status-pill';
import { TABLE, TH, TH_NUM, TD, TD_NUM, ROW_CLICKABLE } from '@/components/ui/table-style';
import {
  fmtPctChange, type BankMultiYearTable, type BankRowId,
} from '@/lib/bank-investor-analysis';
import { chfFmt, pctFmt, toneToUi, TREND_META, SectionCard } from './bank-phase2-ui';

export type BankDrillMetric = 'umsatz' | 'ware' | 'personal';

/** Zeilen mit vorhandenem Monatsdetail im Analysis-Objekt. */
export const DRILLABLE_ROWS: Partial<Record<BankRowId, BankDrillMetric>> = {
  net_revenue: 'umsatz',
  total_cogs: 'ware',
  total_personnel: 'personal',
};

export function BankScorecardSection({
  scorecard, onDrill,
}: {
  scorecard: BankMultiYearTable;
  onDrill: (metric: BankDrillMetric) => void;
}) {
  const years = scorecard.years;
  const newest = years[years.length - 1];
  const prev = years.length >= 2 ? years[years.length - 2] : null;
  return (
    <SectionCard
      title="Mehrjahres-Scorecard"
      testId="bank-scorecard"
      info={<InfoTip text={`Kennzahlen über die gewählten Jahre im Vergleichszeitraum. Veränderung = ${newest} gegenüber ${prev ?? 'Vorjahr'}. Zeilen mit Lupensymbol öffnen das Monatsdetail. Der Bericht endet bei EBIT — Finanzergebnis und Steuern sind nicht enthalten.`} />}
    >
      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>Kennzahl</th>
              {years.map(y => <th key={y} className={TH_NUM}>{y}</th>)}
              {years.map(y => <th key={`q${y}`} className={TH_NUM}>Quote {y}</th>)}
              <th className={TH_NUM}>Δ CHF</th>
              <th className={TH_NUM}>Δ %</th>
              <th className={TH}>Trend</th>
            </tr>
          </thead>
          <tbody>
            {scorecard.rows.map(r => {
              const drill = DRILLABLE_ROWS[r.id];
              return (
                <tr
                  key={r.id}
                  className={`${r.emphasis ? 'bg-muted/50' : ''} ${drill ? ROW_CLICKABLE : ''}`}
                  onClick={drill ? () => onDrill(drill) : undefined}
                  data-testid={`bank-score-${r.id}`}
                >
                  <td className={`${TD} ${r.emphasis ? 'font-semibold' : ''}`}>
                    {r.label}{drill ? <span className="ml-1.5 text-xs text-muted-foreground">🔍</span> : null}
                  </td>
                  {r.values.map((v, i) => (
                    <td key={i} className={`${TD_NUM} ${r.emphasis ? 'font-semibold' : ''}`}>{chfFmt(v)}</td>
                  ))}
                  {r.quotes.map((q, i) => (
                    <td key={`q${i}`} className={TD_NUM}>{pctFmt(q)}</td>
                  ))}
                  <td className={TD_NUM}>{chfFmt(r.diffChf)}</td>
                  <td className={TD_NUM}>{r.diffPct == null ? 'n. vgl.' : fmtPctChange(r.diffPct)}</td>
                  <td className={TD}>
                    {r.trend ? (
                      <StatusPill tone={toneToUi[r.tone]} size="xs" showDot={false}>
                        {TREND_META[r.trend].symbol} {TREND_META[r.trend].label}
                      </StatusPill>
                    ) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
