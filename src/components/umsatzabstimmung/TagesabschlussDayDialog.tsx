/**
 * TagesabschlussDayDialog.tsx — Tages-Detail: manuelle Werte, Korrekturen,
 * Barausgaben, Barbestand-Bestätigung.
 * ===========================================================================
 * Die Barbestand-/Tagesbestätigung wird über den BESTEHENDEN Adyen-Store
 * (adyenAbstimmung_v1, setDayConfirmation) gesetzt — ein einziger
 * Bestätigungs-Store. Alle übrigen Eingaben landen im Blob tagesabschluss_v1.
 */

import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { DayConfirmation } from '@/lib/adyen-abstimmung';
import {
  TAGESABSCHLUSS_AUTO_FIELDS,
  TAGESABSCHLUSS_FIELD_LABEL,
  type CashExpense,
  type TagesabschlussAutoField,
  type TagesabschlussManualPatch,
  type TagesabschlussRow,
} from '@/lib/tagesabschluss';
import { diffColorClass, fmtChf, fmtDiffChf, parseAmountInput } from './adyen-ui';

interface TagesabschlussDayDialogProps {
  row: TagesabschlussRow | null;
  expenses: CashExpense[];
  readOnly: boolean;
  onClose: () => void;
  onSaveManual: (date: string, patch: TagesabschlussManualPatch) => void;
  onOverride: (date: string, field: TagesabschlussAutoField, original: number, corrected: number | null, comment: string) => void;
  onConfirm: (date: string, confirmation: DayConfirmation | null) => void;
  onUpsertExpense: (expense: CashExpense) => void;
  onRemoveExpense: (date: string, id: string) => void;
}

function numToInput(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Kommagetrennte Gutscheinnummern → Array (leer → null = Feld löschen). */
function parseGutscheinNummern(raw: string): string[] | null {
  const list = raw.split(/[,;\n]+/).map(s => s.trim()).filter(s => s !== '');
  return list.length > 0 ? list : null;
}

const EMPTY_EXPENSE_FORM = {
  amount: '', konto: '', gegenkonto: '', text: '', mwstCode: '', belegNr: '', kommentar: '',
};

export function TagesabschlussDayDialog({
  row, expenses, readOnly, onClose,
  onSaveManual, onOverride, onConfirm, onUpsertExpense, onRemoveExpense,
}: TagesabschlussDayDialogProps) {
  const [bestand, setBestand] = useState('');
  const [einzahlung, setEinzahlung] = useState('');
  const [bemerkung, setBemerkung] = useState('');
  const [gsVerkauft, setGsVerkauft] = useState('');
  const [gsEingeloest, setGsEingeloest] = useState('');
  const [corrections, setCorrections] = useState<Record<string, { value: string; comment: string }>>({});
  const [expenseForm, setExpenseForm] = useState(EMPTY_EXPENSE_FORM);
  const [expenseError, setExpenseError] = useState<string | null>(null);

  useEffect(() => {
    if (!row) return;
    setBestand(numToInput(row.cells.bestandKasse.value));
    setEinzahlung(numToInput(row.cells.einzahlungBank.value));
    setBemerkung(row.bemerkung ?? '');
    setGsVerkauft(row.gutscheinNummernVerkauft?.join(', ') ?? '');
    setGsEingeloest(row.gutscheinNummernEingeloest?.join(', ') ?? '');
    const corr: Record<string, { value: string; comment: string }> = {};
    for (const f of TAGESABSCHLUSS_AUTO_FIELDS) {
      const cell = row.cells[f];
      corr[f] = {
        value: cell.source === 'corrected' ? numToInput(cell.value) : '',
        comment: cell.override?.comment ?? '',
      };
    }
    setCorrections(corr);
    setExpenseForm(EMPTY_EXPENSE_FORM);
    setExpenseError(null);
  }, [row]);

  if (!row) return null;
  const date = row.date;

  const handleSaveManual = () => {
    onSaveManual(date, {
      bestandKasse: bestand.trim() === '' ? null : parseAmountInput(bestand),
      einzahlungBank: einzahlung.trim() === '' ? null : parseAmountInput(einzahlung),
      bemerkung: bemerkung.trim() === '' ? null : bemerkung,
      gutscheinNummernVerkauft: parseGutscheinNummern(gsVerkauft),
      gutscheinNummernEingeloest: parseGutscheinNummern(gsEingeloest),
    });
  };

  const handleCorrection = (field: TagesabschlussAutoField) => {
    const cell = row.cells[field];
    const entry = corrections[field] ?? { value: '', comment: '' };
    const original = cell.auto ?? 0;
    if (entry.value.trim() === '') {
      if (cell.source === 'corrected') onOverride(date, field, original, null, '');
      return;
    }
    const parsed = parseAmountInput(entry.value);
    if (parsed === null) return;
    onOverride(date, field, original, parsed, entry.comment);
  };

  const handleAddExpense = () => {
    const amount = parseAmountInput(expenseForm.amount);
    if (amount === null || amount === 0) { setExpenseError('Betrag fehlt oder ist 0.'); return; }
    if (expenseForm.konto.trim() === '') { setExpenseError('Konto fehlt.'); return; }
    if (expenseForm.text.trim() === '') { setExpenseError('Text/Beschreibung fehlt.'); return; }
    setExpenseError(null);
    onUpsertExpense({
      id: `exp-${date}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date,
      amount,
      konto: expenseForm.konto.trim(),
      ...(expenseForm.gegenkonto.trim() ? { gegenkonto: expenseForm.gegenkonto.trim() } : {}),
      text: expenseForm.text.trim(),
      ...(expenseForm.mwstCode.trim() ? { mwstCode: expenseForm.mwstCode.trim() } : {}),
      ...(expenseForm.belegNr.trim() ? { belegNr: expenseForm.belegNr.trim() } : {}),
      ...(expenseForm.kommentar.trim() ? { kommentar: expenseForm.kommentar.trim() } : {}),
      updatedAt: new Date().toISOString(),
    });
    setExpenseForm(EMPTY_EXPENSE_FORM);
  };

  const confirmation = row.confirmation;
  const cashCounted = confirmation?.cashCounted ?? false;
  const confirmed = confirmation?.confirmed ?? false;

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">Tagesabschluss {date.split('-').reverse().join('.')}</DialogTitle>
        </DialogHeader>

        {/* Manuelle Tageswerte */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold">Manuelle Eingaben</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[11px]">Bestand Kasse (CHF)</Label>
              <Input className="h-8 text-xs" inputMode="decimal" value={bestand}
                disabled={readOnly} onChange={e => setBestand(e.target.value)}
                data-testid="ta-input-bestand" />
            </div>
            <div>
              <Label className="text-[11px]">Einzahlung Bank (CHF)</Label>
              <Input className="h-8 text-xs" inputMode="decimal" value={einzahlung}
                disabled={readOnly} onChange={e => setEinzahlung(e.target.value)}
                data-testid="ta-input-einzahlung" />
            </div>
          </div>
          <div>
            <Label className="text-[11px]">Bemerkung</Label>
            <Textarea className="text-xs min-h-[48px]" value={bemerkung}
              disabled={readOnly} onChange={e => setBemerkung(e.target.value)}
              data-testid="ta-input-bemerkung" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[11px]">Gutscheinnummern (verkauft)</Label>
              <Input className="h-8 text-xs" placeholder="z. B. GS-101, GS-102" value={gsVerkauft}
                disabled={readOnly} onChange={e => setGsVerkauft(e.target.value)}
                data-testid="ta-input-gutschein-nr-verkauft" />
            </div>
            <div>
              <Label className="text-[11px]">Gutscheinnummern (eingelöst)</Label>
              <Input className="h-8 text-xs" placeholder="z. B. GS-088" value={gsEingeloest}
                disabled={readOnly} onChange={e => setGsEingeloest(e.target.value)}
                data-testid="ta-input-gutschein-nr-eingeloest" />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Gutscheinnummern werden nur hier im Tagesdetail gespeichert und erscheinen nicht in der Übersicht.
          </p>
          {!readOnly && (
            <Button size="sm" className="h-7 text-xs" onClick={handleSaveManual} data-testid="ta-save-manual">
              Manuelle Werte speichern
            </Button>
          )}
        </section>

        {/* Adyen-Abgleich (nur Anzeige — Korrekturen im Adyen-Abgleich selbst) */}
        {(row.hasAdyen || row.adyenZTotal !== null) && (
          <section className="space-y-1.5 border-t border-border pt-3" data-testid="ta-dialog-adyen">
            <h3 className="text-xs font-semibold">Adyen-Abgleich (Karten/TWINT)</h3>
            <div className="grid grid-cols-3 gap-3 text-xs">
              <div>
                <p className="text-[10px] text-muted-foreground">laut Z-Bericht</p>
                <p className="tabular-nums font-medium">
                  {row.adyenZTotal === null ? '—' : fmtChf(row.adyenZTotal)}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">laut Adyen</p>
                <p className="tabular-nums font-medium" data-testid="ta-dialog-adyen-total">
                  {row.adyenTotal === null ? '—' : fmtChf(row.adyenTotal)}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">Differenz</p>
                <p className={`tabular-nums font-medium ${diffColorClass(row.adyenDiffStatus)}`} data-testid="ta-dialog-adyen-diff">
                  {row.adyenDiff === null ? '—' : fmtDiffChf(row.adyenDiff)}
                </p>
              </div>
            </div>
            {!row.hasAdyen && (
              <p className="text-[10px] text-muted-foreground">Kein Adyen-Import für diesen Tag.</p>
            )}
            <p className="text-[10px] text-muted-foreground">
              Details, Overrides und Kommentare im Adyen-Abgleich weiter unten auf dieser Seite.
            </p>
          </section>
        )}

        {/* Bestätigung Barbestand (gemeinsamer Store mit Adyen-Abgleich) */}
        <section className="space-y-1.5 border-t border-border pt-3">
          <h3 className="text-xs font-semibold">Bestätigung</h3>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={cashCounted} disabled={readOnly}
              onCheckedChange={v => onConfirm(date, {
                confirmed: confirmed && v === true,
                cashCounted: v === true,
                ...(confirmation?.confirmedAt ? { confirmedAt: confirmation.confirmedAt } : {}),
                ...(confirmation?.comment ? { comment: confirmation.comment } : {}),
              })}
              data-testid="ta-check-cash" />
            Barbestand gezählt und bestätigt
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={confirmed} disabled={readOnly || !cashCounted}
              onCheckedChange={v => onConfirm(date, {
                confirmed: v === true,
                cashCounted,
                ...(v === true ? { confirmedAt: new Date().toISOString() } : {}),
                ...(confirmation?.comment ? { comment: confirmation.comment } : {}),
              })}
              data-testid="ta-check-confirm" />
            Tag bestätigt (abgeschlossen)
          </label>
          <p className="text-[10px] text-muted-foreground">
            Gemeinsame Bestätigung mit dem Adyen-Abgleich — dort gelten zusätzliche Prüfregeln.
          </p>
        </section>

        {/* Korrekturen */}
        <section className="space-y-1.5 border-t border-border pt-3">
          <h3 className="text-xs font-semibold">Korrekturen (mit Kommentar)</h3>
          {!row.hasZbericht && (
            <p className="text-[11px] text-muted-foreground">Kein Z-Bericht für diesen Tag — Korrekturen sind trotzdem möglich (Original = 0).</p>
          )}
          <div className="space-y-1">
            {TAGESABSCHLUSS_AUTO_FIELDS.map(f => {
              const cell = row.cells[f];
              const entry = corrections[f] ?? { value: '', comment: '' };
              return (
                <div key={f} className="grid grid-cols-[1fr_90px_90px_1fr_60px] items-center gap-2 text-[11px]">
                  <span className="truncate">{TAGESABSCHLUSS_FIELD_LABEL[f]}</span>
                  <span className="text-right tabular-nums text-muted-foreground">
                    {cell.auto === null ? '—' : fmtChf(cell.auto)}
                  </span>
                  <Input className="h-7 text-[11px] text-right" inputMode="decimal" placeholder="korrigiert"
                    value={entry.value} disabled={readOnly}
                    onChange={e => setCorrections(c => ({ ...c, [f]: { ...entry, value: e.target.value } }))}
                    data-testid={`ta-corr-${f}`} />
                  <Input className="h-7 text-[11px]" placeholder="Kommentar"
                    value={entry.comment} disabled={readOnly}
                    onChange={e => setCorrections(c => ({ ...c, [f]: { ...entry, comment: e.target.value } }))} />
                  {!readOnly && (
                    <Button variant="outline" size="sm" className="h-7 text-[10px] px-2"
                      onClick={() => handleCorrection(f)} data-testid={`ta-corr-save-${f}`}>
                      OK
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Leeres Korrekturfeld + OK entfernt die Korrektur. Das Original bleibt immer sichtbar.
          </p>
        </section>

        {/* Barausgaben */}
        <section className="space-y-2 border-t border-border pt-3">
          <h3 className="text-xs font-semibold">Barausgaben ({expenses.length})</h3>
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
                  value={expenseForm.amount} onChange={e => setExpenseForm(f => ({ ...f, amount: e.target.value }))}
                  data-testid="ta-exp-amount" />
                <Input className="h-7 text-[11px]" placeholder="Konto *"
                  value={expenseForm.konto} onChange={e => setExpenseForm(f => ({ ...f, konto: e.target.value }))}
                  data-testid="ta-exp-konto" />
                <Input className="h-7 text-[11px]" placeholder="Gegenkonto (optional)"
                  value={expenseForm.gegenkonto} onChange={e => setExpenseForm(f => ({ ...f, gegenkonto: e.target.value }))} />
              </div>
              <Input className="h-7 text-[11px]" placeholder="Text / Beschreibung *"
                value={expenseForm.text} onChange={e => setExpenseForm(f => ({ ...f, text: e.target.value }))}
                data-testid="ta-exp-text" />
              <div className="grid grid-cols-3 gap-2">
                <Input className="h-7 text-[11px]" placeholder="MWST-Code (optional)"
                  value={expenseForm.mwstCode} onChange={e => setExpenseForm(f => ({ ...f, mwstCode: e.target.value }))} />
                <Input className="h-7 text-[11px]" placeholder="Belegnummer (optional)"
                  value={expenseForm.belegNr} onChange={e => setExpenseForm(f => ({ ...f, belegNr: e.target.value }))} />
                <Input className="h-7 text-[11px]" placeholder="Kommentar (optional)"
                  value={expenseForm.kommentar} onChange={e => setExpenseForm(f => ({ ...f, kommentar: e.target.value }))} />
              </div>
              {expenseError && <p className="text-[11px] text-destructive">{expenseError}</p>}
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleAddExpense}
                data-testid="ta-exp-add">
                <Plus className="h-3 w-3 mr-1" /> Barausgabe hinzufügen
              </Button>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">
            In der Übersicht erscheint nur das Total — im Buchhaltungs-CSV wird jede Ausgabe einzeln exportiert.
          </p>
        </section>
      </DialogContent>
    </Dialog>
  );
}
