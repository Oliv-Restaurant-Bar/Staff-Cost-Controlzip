/**
 * TagesabschlussExpenseDialog.tsx — eigenständiger Barausgaben-Dialog.
 * ===========================================================================
 * Öffnet sich über die Barausgaben-Zelle der Monats-Tabelle (NICHT das
 * komplette Tagesdetail). Erfasst mehrere Einträge pro Tag über den
 * gemeinsamen TagesabschlussExpenseEditor; das Total wird automatisch
 * berechnet und in der Übersicht angezeigt. Keine eigene Persistenz —
 * alles läuft über die bestehenden upsertExpense/removeExpense-Callbacks.
 */

import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import type { CashExpense } from '@/lib/tagesabschluss';
import { fmtChf } from './adyen-ui';
import { TagesabschlussExpenseEditor } from './TagesabschlussExpenseEditor';

interface TagesabschlussExpenseDialogProps {
  /** Tag (yyyy-MM-dd) — null = Dialog geschlossen. */
  date: string | null;
  expenses: CashExpense[];
  readOnly: boolean;
  onClose: () => void;
  onUpsertExpense: (expense: CashExpense) => void;
  onRemoveExpense: (date: string, id: string) => void;
}

export function TagesabschlussExpenseDialog({
  date, expenses, readOnly, onClose, onUpsertExpense, onRemoveExpense,
}: TagesabschlussExpenseDialogProps) {
  if (!date) return null;
  const total = Math.round(expenses.reduce((s, e) => s + e.amount, 0) * 100) / 100;

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Barausgaben {date.split('-').reverse().join('.')}
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{expenses.length} {expenses.length === 1 ? 'Eintrag' : 'Einträge'}</span>
          <span className="font-semibold tabular-nums" data-testid="ta-expdlg-total">
            Total CHF {fmtChf(total)}
          </span>
        </div>
        <TagesabschlussExpenseEditor
          date={date}
          expenses={expenses}
          readOnly={readOnly}
          onUpsertExpense={onUpsertExpense}
          onRemoveExpense={onRemoveExpense}
        />
        <p className="text-[10px] text-muted-foreground">
          In der Übersicht erscheint nur das Total — im Buchhaltungs-CSV wird jede Ausgabe einzeln exportiert.
        </p>
      </DialogContent>
    </Dialog>
  );
}
