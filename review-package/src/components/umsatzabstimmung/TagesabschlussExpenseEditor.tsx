/**
 * TagesabschlussExpenseEditor.tsx — gemeinsamer Barausgaben-Editor.
 * ===========================================================================
 * Liste + Erfassungsformular für die Barausgaben EINES Tages (mehrere
 * Einträge: Betrag, Konto, Gegenkonto, Beschreibung, MWST-Code, Belegnummer,
 * Kommentar). Wird vom Tagesdetail UND vom eigenständigen Barausgaben-Dialog
 * verwendet — eine einzige Formular-Implementierung, identische Test-IDs.
 * Persistenz läuft über die Callbacks (upsertExpense/removeExpense im Blob
 * tagesabschluss_v1); dieser Editor hält nur den Formular-Entwurf.
 */

import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CashExpense } from '@/lib/tagesabschluss';
import { fmtChf, parseAmountInput } from './adyen-ui';

const EMPTY_EXPENSE_FORM = {
  amount: '', konto: '', gegenkonto: '', text: '', mwstCode: '', belegNr: '', kommentar: '',
};

interface TagesabschlussExpenseEditorProps {
  date: string;
  expenses: CashExpense[];
  readOnly: boolean;
  onUpsertExpense: (expense: CashExpense) => void;
  onRemoveExpense: (date: string, id: string) => void;
}

export function TagesabschlussExpenseEditor({
  date, expenses, readOnly, onUpsertExpense, onRemoveExpense,
}: TagesabschlussExpenseEditorProps) {
  const [form, setForm] = useState(EMPTY_EXPENSE_FORM);
  const [error, setError] = useState<string | null>(null);

  // Tageswechsel: Entwurf verwerfen (kein Übertragen auf einen anderen Tag).
  useEffect(() => {
    setForm(EMPTY_EXPENSE_FORM);
    setError(null);
  }, [date]);

  const handleAdd = () => {
    const amount = parseAmountInput(form.amount);
    if (amount === null || amount === 0) { setError('Betrag fehlt oder ist 0.'); return; }
    if (form.konto.trim() === '') { setError('Konto fehlt.'); return; }
    if (form.text.trim() === '') { setError('Text/Beschreibung fehlt.'); return; }
    setError(null);
    onUpsertExpense({
      id: `exp-${date}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date,
      amount,
      konto: form.konto.trim(),
      ...(form.gegenkonto.trim() ? { gegenkonto: form.gegenkonto.trim() } : {}),
      text: form.text.trim(),
      ...(form.mwstCode.trim() ? { mwstCode: form.mwstCode.trim() } : {}),
      ...(form.belegNr.trim() ? { belegNr: form.belegNr.trim() } : {}),
      ...(form.kommentar.trim() ? { kommentar: form.kommentar.trim() } : {}),
      updatedAt: new Date().toISOString(),
    });
    setForm(EMPTY_EXPENSE_FORM);
  };

  return (
    <div className="space-y-2">
      {expenses.length > 0 && (
        <div className="space-y-1">
          {expenses.map(e => (
            <div key={e.id} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-[11px]"
              data-testid={`ta-expense-${e.id}`}>
              <span className="truncate">
                <span className="font-medium">{fmtChf(e.amount)}</span>
                {' · '}{e.text}
                {' · Kto '}{e.konto}{e.gegenkonto ? ` / GKto ${e.gegenkonto}` : ''}
                {e.belegNr ? ` · Beleg ${e.belegNr}` : ''}{e.mwstCode ? ` · ${e.mwstCode}` : ''}
                {e.kommentar ? ` · ${e.kommentar}` : ''}
              </span>
              {!readOnly && (
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0"
                  onClick={() => onRemoveExpense(date, e.id)} aria-label="Barausgabe löschen"
                  data-testid={`ta-expense-delete-${e.id}`}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {!readOnly && (
        <div className="rounded border border-dashed border-border p-2 space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <Input className="h-7 text-[11px]" inputMode="decimal" placeholder="Betrag (CHF) *"
              value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              data-testid="ta-exp-amount" />
            <Input className="h-7 text-[11px]" placeholder="Konto *"
              value={form.konto} onChange={e => setForm(f => ({ ...f, konto: e.target.value }))}
              data-testid="ta-exp-konto" />
            <Input className="h-7 text-[11px]" placeholder="Gegenkonto (optional)"
              value={form.gegenkonto} onChange={e => setForm(f => ({ ...f, gegenkonto: e.target.value }))} />
          </div>
          <Input className="h-7 text-[11px]" placeholder="Text / Beschreibung *"
            value={form.text} onChange={e => setForm(f => ({ ...f, text: e.target.value }))}
            data-testid="ta-exp-text" />
          <div className="grid grid-cols-3 gap-2">
            <Input className="h-7 text-[11px]" placeholder="MWST-Code (optional)"
              value={form.mwstCode} onChange={e => setForm(f => ({ ...f, mwstCode: e.target.value }))} />
            <Input className="h-7 text-[11px]" placeholder="Belegnummer (optional)"
              value={form.belegNr} onChange={e => setForm(f => ({ ...f, belegNr: e.target.value }))}
              data-testid="ta-exp-belegnr" />
            <Input className="h-7 text-[11px]" placeholder="Kommentar (optional)"
              value={form.kommentar} onChange={e => setForm(f => ({ ...f, kommentar: e.target.value }))}
              data-testid="ta-exp-kommentar" />
          </div>
          {error && <p className="text-[11px] text-destructive">{error}</p>}
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleAdd}
            data-testid="ta-exp-add">
            <Plus className="h-3 w-3 mr-1" /> Barausgabe hinzufügen
          </Button>
        </div>
      )}
    </div>
  );
}
