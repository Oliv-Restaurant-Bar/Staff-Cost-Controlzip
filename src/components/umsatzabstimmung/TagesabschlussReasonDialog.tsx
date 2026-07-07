/**
 * TagesabschlussReasonDialog.tsx — Differenzgründe für die Kassendifferenz.
 * ===========================================================================
 * Öffnet sich über den „Begründen"-Button / das „Begründet"-Badge in der
 * Cash-Diff-Zelle der Monats-Tabelle. Mehrfachauswahl aus dem festen Katalog
 * CASH_DIFF_REASON_CATALOG (persistiert werden NUR die stabilen Keys) plus
 * optionale Freitext-Notiz. Beides leer → Begründung wird entfernt.
 * Die Speicher-Semantik (setCashDiffReasons + persist) liegt in der Section.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  CASH_DIFF_REASON_CATALOG,
  type TagesabschlussRow,
} from '@/lib/tagesabschluss';
import { fmtDiffChf, diffColorClass } from './adyen-ui';

interface TagesabschlussReasonDialogProps {
  /** Zeile des Tages (Vorbelegung + Anzeige der Differenz); null = geschlossen. */
  row: TagesabschlussRow | null;
  readOnly: boolean;
  onClose: () => void;
  onSave: (date: string, reasons: string[], note: string) => void;
}

export function TagesabschlussReasonDialog({
  row, readOnly, onClose, onSave,
}: TagesabschlussReasonDialogProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!row) return;
    setSelected([...row.cashDiffReasons]);
    setNote(row.cashDiffNote ?? '');
  }, [row]);

  if (!row) return null;

  const toggle = (key: string, on: boolean) => {
    setSelected(prev => (on ? [...new Set([...prev, key])] : prev.filter(k => k !== key)));
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="ta-reason-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm">Kassendifferenz begründen — {row.date}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs">
            Cash Differenz:{' '}
            <span className={`tabular-nums font-medium ${diffColorClass(row.cashDiffStatus)}`}>
              {row.cashDiff === null ? '—' : fmtDiffChf(row.cashDiff)}
            </span>
          </p>
          <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
            {CASH_DIFF_REASON_CATALOG.map(cat => (
              <div key={cat.key}>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{cat.label}</p>
                <div className="space-y-1">
                  {cat.reasons.map(r => (
                    <label key={r.key} className="flex items-center gap-2 text-xs cursor-pointer">
                      <Checkbox
                        className="h-3.5 w-3.5"
                        checked={selected.includes(r.key)}
                        disabled={readOnly}
                        onCheckedChange={v => toggle(r.key, v === true)}
                        data-testid={`ta-reason-${r.key}`}
                      />
                      {r.label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">Notiz (Freitext)</Label>
            <Textarea
              className="text-xs min-h-[60px]"
              placeholder="z. B. Einzahlung wurde erst am Folgetag verbucht"
              value={note}
              disabled={readOnly}
              onChange={e => setNote(e.target.value)}
              data-testid="ta-reason-note"
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Grund oder Notiz macht die Differenz „begründet" — der Tag kann dann als
            „Abgeschlossen mit Differenz" bestätigt werden. Beides leeren entfernt die Begründung.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onClose} data-testid="ta-reason-cancel">
              Abbrechen
            </Button>
            {!readOnly && (
              <Button size="sm" className="h-7 text-xs"
                onClick={() => { onSave(row.date, selected, note); onClose(); }}
                data-testid="ta-reason-save">
                Speichern
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
