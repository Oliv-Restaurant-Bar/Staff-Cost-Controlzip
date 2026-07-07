/**
 * TagesabschlussVoucherDialog.tsx — kleiner Gutschein-Dialog (verkauft/eingelöst).
 * ===========================================================================
 * Öffnet sich über die Gutschein-Zellen der Monats-Tabelle. Erfasst:
 *   · Betrag — wirkt als KORREKTUR des Z-Bericht-Werts (Override, gelb
 *     markiert); leeres Feld entfernt die Korrektur (Z-Bericht gilt wieder).
 *   · Gutscheinnummern (kommagetrennt) — nur im Tagesdetail sichtbar,
 *     NIE in der Übersicht.
 *   · Kommentar — Feld-Kommentar (Icon in der Zelle).
 * In der Übersicht bleibt nur der Betrag sichtbar. Die Speicher-Semantik
 * (Override/Manual/Kommentar in EINEM persist) liegt in der Section.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  TAGESABSCHLUSS_FIELD_LABEL,
  type TagesabschlussRow,
} from '@/lib/tagesabschluss';
import { fmtChf, parseAmountInput } from './adyen-ui';

export type VoucherKind = 'verkauft' | 'eingeloest';

export interface VoucherDialogContext {
  date: string; // yyyy-MM-dd
  kind: VoucherKind;
}

export interface VoucherDialogPayload {
  /** Geparster Betrag; null = Feld leer → Korrektur entfernen (Z-Bericht gilt). */
  betrag: number | null;
  /** Gutscheinnummern; null = keine → Feld im Tag löschen. */
  nummern: string[] | null;
  /** Feld-Kommentar; leer = Kommentar löschen. */
  kommentar: string;
}

interface TagesabschlussVoucherDialogProps {
  ctx: VoucherDialogContext | null;
  /** Zeile des Tages (für Vorbelegung + Z-Bericht-Original). */
  row: TagesabschlussRow | null;
  readOnly: boolean;
  onClose: () => void;
  onSave: (date: string, kind: VoucherKind, payload: VoucherDialogPayload) => void;
}

function numToInput(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Kommagetrennte Gutscheinnummern → Array (leer → null = Feld löschen). */
function parseGutscheinNummern(raw: string): string[] | null {
  const list = raw.split(/[,;\n]+/).map(s => s.trim()).filter(s => s !== '');
  return list.length > 0 ? list : null;
}

export function TagesabschlussVoucherDialog({
  ctx, row, readOnly, onClose, onSave,
}: TagesabschlussVoucherDialogProps) {
  const [betrag, setBetrag] = useState('');
  const [nummern, setNummern] = useState('');
  const [kommentar, setKommentar] = useState('');
  const [error, setError] = useState<string | null>(null);

  const field = ctx?.kind === 'eingeloest' ? 'gutscheinEingeloest' : 'gutscheinVerkauft';
  const cell = ctx && row ? row.cells[field] : null;

  useEffect(() => {
    if (!ctx || !row) return;
    const c = row.cells[ctx.kind === 'eingeloest' ? 'gutscheinEingeloest' : 'gutscheinVerkauft'];
    setBetrag(numToInput(c.value));
    setNummern((ctx.kind === 'eingeloest' ? row.gutscheinNummernEingeloest : row.gutscheinNummernVerkauft)?.join(', ') ?? '');
    setKommentar(c.comment ?? '');
    setError(null);
  }, [ctx, row]);

  if (!ctx || !row || !cell) return null;
  const label = TAGESABSCHLUSS_FIELD_LABEL[field];

  const handleSave = () => {
    const trimmed = betrag.trim();
    let parsed: number | null = null;
    if (trimmed !== '') {
      parsed = parseAmountInput(trimmed);
      if (parsed === null) { setError('Betrag ist nicht lesbar.'); return; }
    }
    setError(null);
    onSave(ctx.date, ctx.kind, {
      betrag: parsed,
      nummern: parseGutscheinNummern(nummern),
      kommentar: kommentar.trim(),
    });
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {label} {ctx.date.split('-').reverse().join('.')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="text-xs text-muted-foreground">
            Laut Z-Bericht:{' '}
            <span className="tabular-nums font-medium text-foreground" data-testid="ta-voucher-original">
              {cell.auto === null ? '—' : `CHF ${fmtChf(cell.auto)}`}
            </span>
            {cell.source === 'corrected' && (
              <span className="ml-2 rounded bg-amber-100 dark:bg-amber-900/30 px-1 py-0.5 text-[10px] text-amber-800 dark:text-amber-300">korrigiert</span>
            )}
          </div>

          <div>
            <Label className="text-[11px]">Betrag (CHF)</Label>
            <Input className="h-8 text-xs text-right tabular-nums" inputMode="decimal"
              value={betrag} disabled={readOnly}
              onChange={e => setBetrag(e.target.value)}
              data-testid="ta-voucher-betrag" />
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Abweichender Betrag = Korrektur (gelb markiert). Leeres Feld entfernt die Korrektur — der Z-Bericht-Wert gilt wieder.
            </p>
          </div>

          <div>
            <Label className="text-[11px]">Gutscheinnummern</Label>
            <Input className="h-8 text-xs" placeholder="z. B. GS-101, GS-102"
              value={nummern} disabled={readOnly}
              onChange={e => setNummern(e.target.value)}
              data-testid="ta-voucher-nummern" />
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Nur im Tagesdetail gespeichert — erscheint nicht in der Übersicht.
            </p>
          </div>

          <div>
            <Label className="text-[11px]">Kommentar</Label>
            <Textarea className="text-xs min-h-[40px]" value={kommentar} disabled={readOnly}
              onChange={e => setKommentar(e.target.value)}
              data-testid="ta-voucher-kommentar" />
          </div>

          {error && <p className="text-[11px] text-destructive">{error}</p>}

          {!readOnly && (
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onClose}>
                Abbrechen
              </Button>
              <Button size="sm" className="h-7 text-xs" onClick={handleSave} data-testid="ta-voucher-save">
                Speichern
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
