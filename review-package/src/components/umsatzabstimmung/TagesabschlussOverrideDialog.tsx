/**
 * TagesabschlussOverrideDialog.tsx — generisches Override-Popup der Übersicht.
 * ===========================================================================
 * Öffnet sich über die Edit-Buttons der Monats-Tabelle (KK Adyen, Umsatz).
 * Erfasst einen IST-Wert als KORREKTUR des Z-Bericht-Werts (bestehendes
 * Override-Modell: Erst-Original bleibt verankert, gelbe Markierung in der
 * Übersicht, Effektivwert fliesst in Anzeige UND Buchhaltungs-Export).
 *
 * WICHTIG (Doppelsemantik „KK Adyen"): Das Feld „KK Adyen Ist" schreibt auf
 * das bestehende Z-Bericht-Feld `karten` (Kreditkarten OHNE TWINT — TWINT ist
 * ein eigenes Auto-Feld). Die Adyen-Vergleichsanzeige (Import) bleibt
 * unberührt; Original-KK, TWINT und Adyen-Total werden zur Orientierung
 * angezeigt. Leeres Feld entfernt die Korrektur (Z-Bericht gilt wieder).
 * Die Speicher-Semantik (Override + Kommentar in EINEM persist) liegt in der
 * Section.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { TagesabschlussRow } from '@/lib/tagesabschluss';
import { fmtChf, parseAmountInput } from './adyen-ui';

/** Felder, die über das Popup übersteuert werden können. */
export type TagesabschlussOverrideField = 'karten' | 'umsatz';

export interface OverrideDialogContext {
  date: string; // yyyy-MM-dd
  field: TagesabschlussOverrideField;
}

export interface OverrideDialogPayload {
  /** Geparster Ist-Wert; null = Feld leer → Korrektur entfernen (Z-Bericht gilt). */
  betrag: number | null;
  /** Feld-Kommentar; leer = Kommentar löschen. */
  kommentar: string;
}

/** Popup-Titel/Feld-Label — bewusst NICHT TAGESABSCHLUSS_FIELD_LABEL
 *  (das hängt am Export und bleibt unverändert). */
const OVERRIDE_UI_LABEL: Record<TagesabschlussOverrideField, string> = {
  karten: 'KK Adyen Ist',
  umsatz: 'Umsatz Ist',
};

interface TagesabschlussOverrideDialogProps {
  ctx: OverrideDialogContext | null;
  /** Zeile des Tages (Vorbelegung + Original/Orientierungswerte). */
  row: TagesabschlussRow | null;
  readOnly: boolean;
  onClose: () => void;
  onSave: (date: string, field: TagesabschlussOverrideField, payload: OverrideDialogPayload) => void;
}

export function TagesabschlussOverrideDialog({
  ctx, row, readOnly, onClose, onSave,
}: TagesabschlussOverrideDialogProps) {
  const [betrag, setBetrag] = useState('');
  const [kommentar, setKommentar] = useState('');
  const [error, setError] = useState<string | null>(null);

  const cell = ctx && row ? row.cells[ctx.field] : null;

  useEffect(() => {
    if (!ctx || !row) return;
    const c = row.cells[ctx.field];
    setBetrag(c.value === null ? '' : String(c.value));
    setKommentar(c.comment ?? '');
    setError(null);
  }, [ctx, row]);

  if (!ctx || !row || !cell) return null;
  const label = OVERRIDE_UI_LABEL[ctx.field];
  // Erst-Original bleibt auch bei Mehrfach-Override verankert.
  const original = cell.override?.originalValue ?? cell.auto;

  const handleSave = () => {
    const trimmed = betrag.trim();
    let parsed: number | null = null;
    if (trimmed !== '') {
      parsed = parseAmountInput(trimmed);
      if (parsed === null) { setError('Betrag ist nicht lesbar.'); return; }
    }
    setError(null);
    onSave(ctx.date, ctx.field, { betrag: parsed, kommentar: kommentar.trim() });
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
            <span className="tabular-nums font-medium text-foreground" data-testid="ta-override-original">
              {original === null || original === undefined ? '—' : `CHF ${fmtChf(original)}`}
            </span>
            {cell.source === 'corrected' && (
              <span className="ml-2 rounded bg-amber-100 dark:bg-amber-900/30 px-1 py-0.5 text-[10px] text-amber-800 dark:text-amber-300">korrigiert</span>
            )}
          </div>

          {ctx.field === 'karten' && (
            /* Orientierung: Das Override zielt auf das Z-Bericht-Feld
               „Kreditkarten" (OHNE TWINT) — Adyen-Import bleibt unberührt. */
            <div className="rounded-md border border-border px-2.5 py-2 text-[11px] space-y-0.5" data-testid="ta-override-context">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">TWINT laut Z-Bericht (separat)</span>
                <span className="tabular-nums">{row.cells.twint.value === null ? '—' : `CHF ${fmtChf(row.cells.twint.value)}`}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">KK laut Adyen (Import)</span>
                <span className="tabular-nums">{row.adyenTotal === null ? '—' : `CHF ${fmtChf(row.adyenTotal)}`}</span>
              </div>
              <p className="text-[10px] text-muted-foreground pt-0.5">
                Der Ist-Wert korrigiert die Kreditkarten laut Z-Bericht (ohne TWINT);
                der Adyen-Import wird dadurch nicht verändert.
              </p>
            </div>
          )}

          <div>
            <Label className="text-[11px]">{label} (CHF)</Label>
            <Input className="h-8 text-xs text-right tabular-nums" inputMode="decimal"
              value={betrag} disabled={readOnly}
              onChange={e => setBetrag(e.target.value)}
              data-testid="ta-override-betrag" />
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Abweichender Betrag = Korrektur (gelb markiert) — gilt in der Übersicht
              UND im Buchhaltungs-Export. Leeres Feld entfernt die Korrektur —
              der Z-Bericht-Wert gilt wieder.
            </p>
          </div>

          <div>
            <Label className="text-[11px]">Kommentar</Label>
            <Textarea className="text-xs min-h-[40px]" value={kommentar} disabled={readOnly}
              onChange={e => setKommentar(e.target.value)}
              data-testid="ta-override-kommentar" />
          </div>

          {error && <p className="text-[11px] text-destructive">{error}</p>}

          {!readOnly && (
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onClose}>
                Abbrechen
              </Button>
              <Button size="sm" className="h-7 text-xs" onClick={handleSave} data-testid="ta-override-save">
                Speichern
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
