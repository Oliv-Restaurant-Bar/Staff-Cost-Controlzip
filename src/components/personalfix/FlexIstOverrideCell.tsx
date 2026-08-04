/**
 * FlexIstOverrideCell
 * ===================
 * Editierbare «Flex Ist»-Zelle in der Tabelle «Flex Kosten pro Mitarbeiter».
 *
 * - Ohne Override: berechneter Wert (klickbar für Tagesdetails, wie bisher)
 *   plus dezenter Stift zum Übersteuern.
 * - Mit Override: Betrag kursiv + Badge «manuell», Tooltip mit Rechenweg,
 *   «Zurücksetzen»-Button (zurück auf berechnet).
 * - Editor-Popover = Vorschau vor dem Speichern: Betrag + Häkchen
 *   «AG-Arbeitgeberkosten aufschlagen» mit Live-Zeile
 *   «eingegeben CHF X × AG-Faktor Y = CHF Z». Gespeichert wird erst bei
 *   «Übernehmen».
 */

import React, { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Pencil, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FlexIstOverride, effectiveFlexIst } from '@/lib/personalfix-flex-overrides';

interface Props {
  /** Automatisch berechneter Wert (Ist-Std × AG/h). */
  computed: number;
  override: FlexIstOverride | null;
  agFactor: number;
  fmtCHF: (n: number) => string;
  onSave: (o: FlexIstOverride) => void;
  onReset: () => void;
  /** Anzeige des berechneten Werts (z.B. klickbarer Breakdown-Button). */
  children?: React.ReactNode;
  testId?: string;
  /** Kompakte Darstellung (Total-Zeile). */
  bold?: boolean;
}

export function FlexIstOverrideCell({
  computed, override, agFactor, fmtCHF, onSave, onReset, children, testId, bold,
}: Props) {
  const [open, setOpen] = useState(false);
  const [amountStr, setAmountStr] = useState('');
  const [addAg, setAddAg] = useState(false);

  const parsed = parseFloat(amountStr.replace(/['\s]/g, '').replace(',', '.'));
  const valid = isFinite(parsed) && parsed >= 0;
  const previewValue = valid ? effectiveFlexIst({ amount: parsed, addAg }, agFactor) : null;

  const openEditor = () => {
    setAmountStr(override ? String(override.amount) : '');
    setAddAg(override ? override.addAg : false);
    setOpen(true);
  };

  const effective = override ? effectiveFlexIst(override, agFactor) : computed;

  return (
    <div className="flex items-center justify-end gap-1" data-testid={testId}>
      {override ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn('font-mono italic text-orange-700 dark:text-orange-400 cursor-help', bold && 'font-bold')}>
              {fmtCHF(effective)}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs">
            {override.addAg
              ? `eingegeben CHF ${fmtCHF(override.amount)} × AG-Faktor ${agFactor.toFixed(4)} = CHF ${fmtCHF(effective)}`
              : `manuell eingegeben: CHF ${fmtCHF(override.amount)} (gilt 1:1 als volle AG-Kosten)`}
            <br />berechnet wäre: CHF {fmtCHF(computed)}
          </TooltipContent>
        </Tooltip>
      ) : (
        children ?? <span className={cn('font-mono', bold && 'font-bold')}>{fmtCHF(computed)}</span>
      )}

      {override && (
        <>
          <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 whitespace-nowrap">
            manuell
          </span>
          <button
            type="button"
            onClick={onReset}
            title="Zurücksetzen (zurück auf berechnet)"
            data-testid={testId ? `${testId}-reset` : undefined}
            className="h-4 w-4 flex items-center justify-center rounded text-muted-foreground hover:text-red-600 transition-colors"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        </>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            onClick={openEditor}
            title="Flex Ist manuell überschreiben"
            data-testid={testId ? `${testId}-edit` : undefined}
            className="h-4 w-4 flex items-center justify-center rounded text-muted-foreground/50 hover:text-orange-600 transition-colors"
          >
            <Pencil className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-3 space-y-2.5" onClick={e => e.stopPropagation()}>
          <div className="text-xs font-semibold">Flex Ist manuell überschreiben</div>
          <div className="text-[11px] text-muted-foreground">
            Berechnet: CHF {fmtCHF(computed)} — der eingegebene Betrag ersetzt diesen Wert.
          </div>
          <Input
            type="text"
            inputMode="decimal"
            placeholder="CHF-Betrag"
            value={amountStr}
            onChange={e => setAmountStr(e.target.value)}
            className="h-8 text-sm font-mono"
            autoFocus
          />
          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <Checkbox checked={addAg} onCheckedChange={v => setAddAg(v === true)} className="mt-0.5" />
            <span>
              AG-Arbeitgeberkosten aufschlagen
              <span className="block text-[10px] text-muted-foreground">
                Betrag ist Bruttolohn ohne AG-Kosten → × Faktor {agFactor.toFixed(4)}
              </span>
            </span>
          </label>
          {/* Vorschau vor dem Speichern */}
          <div className="rounded bg-muted/40 px-2 py-1.5 text-[11px] font-mono" data-testid={testId ? `${testId}-preview` : undefined}>
            {valid
              ? addAg
                ? <>eingegeben CHF {fmtCHF(parsed)} × AG-Faktor {agFactor.toFixed(4)} = <strong>CHF {fmtCHF(previewValue!)}</strong></>
                : <>Flex Ist = <strong>CHF {fmtCHF(parsed)}</strong> (1:1, volle AG-Kosten)</>
              : <span className="text-muted-foreground">Betrag eingeben …</span>}
          </div>
          <div className="flex justify-end gap-2 pt-0.5">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpen(false)}>
              Abbrechen
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs bg-orange-600 hover:bg-orange-700 text-white"
              disabled={!valid}
              onClick={() => { onSave({ amount: parsed, addAg }); setOpen(false); }}
            >
              Übernehmen
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
