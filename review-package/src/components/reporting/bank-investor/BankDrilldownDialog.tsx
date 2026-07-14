/**
 * Drilldown-Dialog (Spez. Phase 2 §11) — Monatsdetail für Umsatz, Waren-
 * oder Personalaufwand aus den VORHANDENEN Monatsreihen des zentralen
 * Analysis-Objekts (neuestes Jahr vs. Vorjahr). Keine neuen Berechnungen.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DIALOG_MD } from '@/components/ui/dialog-size';
import { TABLE, TH, TH_NUM, TD, TD_NUM } from '@/components/ui/table-style';
import { fmtPctChange, type BankInvestorAnalysis } from '@/lib/bank-investor-analysis';
import { chfFmt, pctFmt } from './bank-phase2-ui';
import type { BankDrillMetric } from './BankScorecardSection';

const META: Record<BankDrillMetric, { title: string; withQuote: boolean }> = {
  umsatz: { title: 'Umsatz nach Monat', withQuote: false },
  ware: { title: 'Warenaufwand nach Monat', withQuote: true },
  personal: { title: 'Personalaufwand nach Monat', withQuote: true },
};

export function BankDrilldownDialog({
  metric, analysis, onClose,
}: {
  metric: BankDrillMetric | null;
  analysis: BankInvestorAnalysis;
  onClose: () => void;
}) {
  const months = metric === 'umsatz' ? analysis.revenueMonths
    : metric === 'ware' ? analysis.wareMonths
    : metric === 'personal' ? analysis.personalMonths
    : [];
  const meta = metric ? META[metric] : null;
  return (
    <Dialog open={metric != null} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className={DIALOG_MD} data-testid="bank-drilldown-dialog">
        <DialogHeader>
          <DialogTitle>{meta?.title ?? ''}</DialogTitle>
          <DialogDescription>
            {analysis.comparison.label} — dieselben Werte wie in den Monats-Charts, fehlende Monate bleiben leer.
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-x-auto max-h-[60vh]">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Monat</th>
                <th className={TH_NUM}>{analysis.baseYear}</th>
                <th className={TH_NUM}>{analysis.currentYear}</th>
                <th className={TH_NUM}>Δ CHF</th>
                <th className={TH_NUM}>Δ %</th>
                {meta?.withQuote && <th className={TH_NUM}>Quote {analysis.baseYear}</th>}
                {meta?.withQuote && <th className={TH_NUM}>Quote {analysis.currentYear}</th>}
              </tr>
            </thead>
            <tbody>
              {months.map(m => (
                <tr key={m.monthIdx} data-testid={`bank-drill-${m.monthIdx}`}>
                  <td className={TD}>{m.label}</td>
                  <td className={TD_NUM}>{chfFmt(m.base)}</td>
                  <td className={TD_NUM}>{chfFmt(m.current)}</td>
                  <td className={TD_NUM}>{chfFmt(m.diffChf)}</td>
                  <td className={TD_NUM}>{m.diffPct == null ? '—' : fmtPctChange(m.diffPct)}</td>
                  {meta?.withQuote && <td className={TD_NUM}>{pctFmt(m.baseQuote)}</td>}
                  {meta?.withQuote && <td className={TD_NUM}>{pctFmt(m.currentQuote)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
