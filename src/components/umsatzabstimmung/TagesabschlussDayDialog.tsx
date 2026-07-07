/**
 * TagesabschlussDayDialog.tsx — Tages-Detail: manuelle Werte, Korrekturen,
 * Barausgaben, Barbestand-Bestätigung.
 * ===========================================================================
 * Die Barbestand-/Tagesbestätigung wird über den BESTEHENDEN Adyen-Store
 * (adyenAbstimmung_v1, setDayConfirmation) gesetzt — ein einziger
 * Bestätigungs-Store. Alle übrigen Eingaben landen im Blob tagesabschluss_v1.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Lock, LockOpen } from 'lucide-react';
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
  canCloseDay,
  cashDiffReasonLabel,
  TAGESABSCHLUSS_AUTO_FIELDS,
  TAGESABSCHLUSS_FIELD_LABEL,
  type CashExpense,
  type TagesabschlussAutoField,
  type TagesabschlussManualPatch,
  type TagesabschlussRow,
} from '@/lib/tagesabschluss';
import { diffColorClass, fmtChf, fmtDiffChf, parseAmountInput } from './adyen-ui';
import { formatClosedStamp } from './TagesabschlussTable';
import { TagesabschlussExpenseEditor } from './TagesabschlussExpenseEditor';

interface TagesabschlussDayDialogProps {
  row: TagesabschlussRow | null;
  expenses: CashExpense[];
  readOnly: boolean;
  /** Wiederöffnen abgeschlossener Tage — NUR echte Admins (keine Gäste). */
  canReopen: boolean;
  onClose: () => void;
  onSaveManual: (date: string, patch: TagesabschlussManualPatch) => void;
  onOverride: (date: string, field: TagesabschlussAutoField, original: number, corrected: number | null, comment: string) => void;
  onConfirm: (date: string, confirmation: DayConfirmation | null) => void;
  onUpsertExpense: (expense: CashExpense) => void;
  onRemoveExpense: (date: string, id: string) => void;
  onCloseDay: (date: string) => void;
  onReopenDay: (date: string, reason: string) => void;
}

function numToInput(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Kommagetrennte Gutscheinnummern → Array (leer → null = Feld löschen). */
function parseGutscheinNummern(raw: string): string[] | null {
  const list = raw.split(/[,;\n]+/).map(s => s.trim()).filter(s => s !== '');
  return list.length > 0 ? list : null;
}

export function TagesabschlussDayDialog({
  row, expenses, readOnly, canReopen, onClose,
  onSaveManual, onOverride, onConfirm, onUpsertExpense, onRemoveExpense,
  onCloseDay, onReopenDay,
}: TagesabschlussDayDialogProps) {
  const [bestand, setBestand] = useState('');
  const [einzahlung, setEinzahlung] = useState('');
  const [bemerkung, setBemerkung] = useState('');
  const [gsVerkauft, setGsVerkauft] = useState('');
  const [gsEingeloest, setGsEingeloest] = useState('');
  const [corrections, setCorrections] = useState<Record<string, { value: string; comment: string }>>({});
  /** Pflicht-Grund für das Admin-Wiederöffnen eines abgeschlossenen Tages. */
  const [reopenReason, setReopenReason] = useState('');

  useEffect(() => {
    if (!row) return;
    setBestand(numToInput(row.cells.bestandKasse.value));
    setEinzahlung(numToInput(row.cells.einzahlungBank.value));
    setBemerkung(row.bemerkung ?? '');
    setGsVerkauft(row.gutscheinNummernVerkauft?.join(', ') ?? '');
    setGsEingeloest(row.gutscheinNummernEingeloest?.join(', ') ?? '');
    setReopenReason('');
    const corr: Record<string, { value: string; comment: string }> = {};
    for (const f of TAGESABSCHLUSS_AUTO_FIELDS) {
      const cell = row.cells[f];
      corr[f] = {
        value: cell.source === 'corrected' ? numToInput(cell.value) : '',
        comment: cell.override?.comment ?? '',
      };
    }
    setCorrections(corr);
  }, [row]);

  if (!row) return null;
  const date = row.date;
  // Definitiv abgeschlossene Tage sind KOMPLETT gesperrt — alle Edit-Flächen
  // rendern read-only; nur der Admin-Reopen-Bereich bleibt aktiv.
  const locked = row.locked;
  const dialogReadOnly = readOnly || locked;
  const closeCheck = !locked && row.hasZbericht ? canCloseDay(row) : null;
  const closure = row.closure;

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
              <Label className="text-[11px]">Cash Ist — gezählter Kassenbestand (CHF)</Label>
              <Input className="h-8 text-xs" inputMode="decimal" value={bestand}
                disabled={dialogReadOnly} onChange={e => setBestand(e.target.value)}
                data-testid="ta-input-bestand" />
            </div>
            <div>
              <Label className="text-[11px]">Einzahlung Bank (CHF)</Label>
              <Input className="h-8 text-xs" inputMode="decimal" value={einzahlung}
                disabled={dialogReadOnly} onChange={e => setEinzahlung(e.target.value)}
                data-testid="ta-input-einzahlung" />
            </div>
          </div>
          <div>
            <Label className="text-[11px]">Bemerkung</Label>
            <Textarea className="text-xs min-h-[48px]" value={bemerkung}
              disabled={dialogReadOnly} onChange={e => setBemerkung(e.target.value)}
              data-testid="ta-input-bemerkung" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[11px]">Gutscheinnummern (verkauft)</Label>
              <Input className="h-8 text-xs" placeholder="z. B. GS-101, GS-102" value={gsVerkauft}
                disabled={dialogReadOnly} onChange={e => setGsVerkauft(e.target.value)}
                data-testid="ta-input-gutschein-nr-verkauft" />
            </div>
            <div>
              <Label className="text-[11px]">Gutscheinnummern (eingelöst)</Label>
              <Input className="h-8 text-xs" placeholder="z. B. GS-088" value={gsEingeloest}
                disabled={dialogReadOnly} onChange={e => setGsEingeloest(e.target.value)}
                data-testid="ta-input-gutschein-nr-eingeloest" />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Gutscheinnummern werden nur hier im Tagesdetail gespeichert und erscheinen nicht in der Übersicht.
          </p>
          {!dialogReadOnly && (
            <Button size="sm" className="h-7 text-xs" onClick={handleSaveManual} data-testid="ta-save-manual">
              Manuelle Werte speichern
            </Button>
          )}
        </section>

        {/* Kasse / Cash: Formelbestandteile + Saldo/Ist/Differenz (nur Anzeige) */}
        <section className="space-y-1.5 border-t border-border pt-3" data-testid="ta-dialog-cash">
          <h3 className="text-xs font-semibold">Kasse (Bargeld Soll / Kassensaldo)</h3>
          <div className="text-[11px] space-y-0.5 tabular-nums">
            {([
              ['Barumsatz (Umsatz − KK − Rechnung − eingelöste Gutscheine)', row.barumsatz, '+'],
              ['Verkaufte Gutscheine', row.cells.gutscheinVerkauft.value ?? 0, '+'],
              ['Barausgaben', row.barausgabenTotal, '−'],
            ] as [string, number | null, string][]).map(([label, value, sign]) => (
              <div key={label} className="flex justify-between gap-4">
                <span className="text-muted-foreground">{sign} {label}</span>
                <span>{value === null ? '—' : fmtChf(value)}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs border-t border-border pt-1.5">
            <div>
              <p className="text-[10px] text-muted-foreground">Bargeld Soll</p>
              <p className="tabular-nums font-medium" data-testid="ta-dialog-bargeld-soll">
                {row.bargeldSoll === null ? '—' : fmtChf(row.bargeldSoll)}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Kassensaldo Soll</p>
              <p className="tabular-nums font-medium" data-testid="ta-dialog-saldo">
                {row.kassensaldoSoll === null ? '—' : fmtChf(row.kassensaldoSoll)}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Cash Ist (gezählt)</p>
              <p className="tabular-nums font-medium" data-testid="ta-dialog-cash-ist">
                {row.cashIst === null ? '—' : fmtChf(row.cashIst)}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Cash Differenz</p>
              <p className={`tabular-nums font-medium ${diffColorClass(row.cashDiffStatus)}`} data-testid="ta-dialog-cash-diff">
                {row.cashDiff === null ? '—' : fmtDiffChf(row.cashDiff)}
              </p>
            </div>
          </div>
          {row.cashDiffBegruendet && (
            <p className="text-[10px] text-muted-foreground" data-testid="ta-dialog-diff-reasons">
              Differenz begründet: {[
                ...row.cashDiffReasons.map(cashDiffReasonLabel),
                ...(row.cashDiffNote ? [row.cashDiffNote] : []),
              ].join(', ')}
            </p>
          )}
          <p className="text-[10px] text-muted-foreground">
            Bargeld Soll = Umsatz − KK − Rechnung − Barausgaben − eingelöste Gutscheine + verkaufte Gutscheine.
            Kassensaldo Soll = Saldo Vortag + Bargeld Soll − Einzahlung Bank; Cash Differenz = Cash Ist − Kassensaldo Soll.
          </p>
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
            <Checkbox checked={cashCounted} disabled={dialogReadOnly}
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
            <Checkbox checked={confirmed} disabled={dialogReadOnly || !cashCounted}
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
                    value={entry.value} disabled={dialogReadOnly}
                    onChange={e => setCorrections(c => ({ ...c, [f]: { ...entry, value: e.target.value } }))}
                    data-testid={`ta-corr-${f}`} />
                  <Input className="h-7 text-[11px]" placeholder="Kommentar"
                    value={entry.comment} disabled={dialogReadOnly}
                    onChange={e => setCorrections(c => ({ ...c, [f]: { ...entry, comment: e.target.value } }))} />
                  {!dialogReadOnly && (
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

        {/* Barausgaben — gemeinsamer Editor (auch im eigenständigen Barausgaben-Dialog) */}
        <section className="space-y-2 border-t border-border pt-3">
          <h3 className="text-xs font-semibold">Barausgaben ({expenses.length})</h3>
          <TagesabschlussExpenseEditor
            date={date}
            expenses={expenses}
            readOnly={dialogReadOnly}
            onUpsertExpense={onUpsertExpense}
            onRemoveExpense={onRemoveExpense}
          />
          <p className="text-[10px] text-muted-foreground">
            In der Übersicht erscheint nur das Total — im Buchhaltungs-CSV wird jede Ausgabe einzeln exportiert.
          </p>
        </section>

        {/* ── Abschluss — Status, Abschließen, Admin-Reopen, Historie ── */}
        <section className="space-y-2 border-t border-border pt-3" data-testid="ta-dialog-abschluss">
          <h3 className="text-xs font-semibold">Abschluss</h3>

          {locked && closure && (
            <div className="rounded-md border border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/30 px-3 py-2" data-testid="ta-dialog-locked-info">
              <p className="text-xs font-medium text-green-800 dark:text-green-300 inline-flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Tag abgeschlossen{closure.status === 'abgeschlossen_mit_differenz' ? ' (mit begründeter Differenz)' : ''} — alle Felder gesperrt
              </p>
              <p className="text-[10px] text-green-700 dark:text-green-400 mt-0.5">
                Abgeschlossen {formatClosedStamp(closure.closedAt)} von {closure.closedBy}
                {closure.fixedKassensaldo !== null && <> · fixierter Kassensaldo {fmtChf(closure.fixedKassensaldo)}</>}
              </p>
              {row.needsReview && (
                <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-0.5 inline-flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                  Der aktuell berechnete Kassensaldo ({row.kassensaldoSoll === null ? '—' : fmtChf(row.kassensaldoSoll)}) weicht vom fixierten ab — Tag überprüfen (Änderung an einem früheren Tag).
                </p>
              )}
            </div>
          )}

          {locked && canReopen && (
            <div className="space-y-1.5" data-testid="ta-dialog-reopen">
              <Label className="text-[11px]">Wiederöffnungsgrund (Pflicht, nur Admin)</Label>
              <Textarea className="text-xs min-h-[48px]" value={reopenReason}
                placeholder="Warum muss dieser Tag wieder geöffnet werden?"
                onChange={e => setReopenReason(e.target.value)}
                data-testid="ta-reopen-reason" />
              <Button variant="outline" size="sm" className="h-7 text-xs"
                disabled={reopenReason.trim() === ''}
                onClick={() => onReopenDay(date, reopenReason)}
                data-testid="ta-reopen-day">
                <LockOpen className="h-3.5 w-3.5 mr-1" />
                Tag wieder öffnen
              </Button>
            </div>
          )}

          {!locked && closure?.status === 'wieder_geoeffnet' && (
            <p className="text-[10px] text-orange-700 dark:text-orange-400" data-testid="ta-dialog-reopened-info">
              Wieder geöffnet {closure.reopenedAt ? formatClosedStamp(closure.reopenedAt) : '—'} von {closure.reopenedBy ?? '—'}
              {closure.reopenReason && <> — Grund: {closure.reopenReason}</>}. Der Tag kann erneut abgeschlossen werden.
            </p>
          )}

          {!readOnly && !locked && closeCheck && (
            <div className="space-y-1">
              <Button size="sm" className="h-7 text-xs"
                disabled={!closeCheck.ok}
                onClick={() => onCloseDay(date)}
                title={closeCheck.ok ? 'Tag definitiv abschließen und sperren' : closeCheck.blockers.join(' ')}
                data-testid="ta-dialog-close-day">
                <Lock className="h-3.5 w-3.5 mr-1" />
                Tagesabschluss abschließen
              </Button>
              {!closeCheck.ok && (
                <ul className="text-[10px] text-muted-foreground list-disc pl-4" data-testid="ta-dialog-close-blockers">
                  {closeCheck.blockers.map(b => <li key={b}>{b}</li>)}
                </ul>
              )}
            </div>
          )}
          {!locked && !row.hasZbericht && (
            <p className="text-[10px] text-muted-foreground">
              Abschluss erst möglich, wenn ein Z-Bericht für diesen Tag importiert ist.
            </p>
          )}

          {closure && closure.history.length > 0 && (
            <div className="space-y-0.5" data-testid="ta-dialog-closure-history">
              <p className="text-[10px] font-medium text-muted-foreground">Abschluss-Historie</p>
              <ul className="text-[10px] text-muted-foreground space-y-0.5">
                {closure.history.map(h => (
                  <li key={`${h.at}-${h.action}`}>
                    {formatClosedStamp(h.at)} — {h.action === 'abschluss'
                      ? <>abgeschlossen{h.status === 'abgeschlossen_mit_differenz' ? ' (mit Differenz)' : ''} von {h.by}</>
                      : <>wieder geöffnet von {h.by}{h.reason ? <> — Grund: {h.reason}</> : null}</>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
