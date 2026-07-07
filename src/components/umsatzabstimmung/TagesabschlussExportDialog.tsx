/**
 * TagesabschlussExportDialog.tsx — Export-Einstellungen + Tabelle2-CSV-Download.
 * ==============================================================================
 * Der Export ist BLOCKIERT, bis das Konto-Mapping vollständig ist und als
 * geprüft markiert wurde (reviewed) — kein stiller Fallback auf erfundene
 * Konten. Barausgaben werden einzeln exportiert.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { normalizeGnPaymentName } from '@/lib/adyen-abstimmung';
import {
  collectUnclassifiedZahlarten,
  defaultExportSettings,
  type GnDayClosing,
  type TagesabschlussBlob,
  type TagesabschlussExportSettings,
  type TagesabschlussRow,
} from '@/lib/tagesabschluss';
import { buildTabelle2Rows, tabelle2ToExportTable } from '@/lib/tagesabschluss-export';
import { downloadCsv } from '@/lib/table-export';

/** Brutto-Modell: kein Umsatz-(Ertrag)-Konto, keine MWST-Codes mehr. */
const ROLE_LABELS: Array<[keyof TagesabschlussExportSettings['konten'], string]> = [
  ['kasse', 'Kasse'],
  ['bank', 'Bank (Einzahlungen)'],
  ['debitoren', 'Debitoren / Rechnung'],
  ['gutscheine', 'Gutschein-Konto'],
  ['kartenSammel', 'Kreditkarten-Sammelkonto'],
  ['umsatzTransit', 'Umsatz brutto (Haben)'],
];

interface TagesabschlussExportDialogProps {
  open: boolean;
  onClose: () => void;
  year: number;
  month: number;
  rows: TagesabschlussRow[];
  closings: Record<string, GnDayClosing>;
  blob: TagesabschlussBlob;
  readOnly: boolean;
  onSaveSettings: (settings: TagesabschlussExportSettings) => void;
}

export function TagesabschlussExportDialog({
  open, onClose, year, month, rows, closings, blob, readOnly, onSaveSettings,
}: TagesabschlussExportDialogProps) {
  const [draft, setDraft] = useState<TagesabschlussExportSettings>(
    () => blob.exportSettings ?? defaultExportSettings(new Date().toISOString()),
  );

  useEffect(() => {
    if (open) setDraft(blob.exportSettings ?? defaultExportSettings(new Date().toISOString()));
  }, [open, blob.exportSettings]);

  const paymentKeys = useMemo(() => {
    const keys = new Set<string>(Object.keys(draft.kontoJeZahlungsart));
    for (const row of rows) {
      const closing = closings[row.date];
      for (const pm of closing?.payments ?? []) {
        const norm = normalizeGnPaymentName(pm.name);
        // isKkCard = alle kartenähnlichen Zahlarten (inkl. PostCard/
        // Lunch-Check/Stripe ohne Adyen-Abwicklung) — jede davon ist im
        // Export separat kontierbar.
        if (norm.isKkCard) keys.add(norm.key);
      }
      // Unklassifizierte Zahlarten (z. B. KD Tisch 5000) MÜSSEN kontiert
      // werden — ohne Konto blockiert der Export.
      for (const z of collectUnclassifiedZahlarten(closing)) keys.add(z.key);
    }
    return [...keys].sort();
  }, [rows, closings, draft.kontoJeZahlungsart]);

  /** Vorschau/Validierung immer gegen den DRAFT — der Benutzer sieht sofort, was fehlt. */
  const result = useMemo(
    () => buildTabelle2Rows(rows, closings, blob, draft),
    [rows, closings, blob, draft],
  );

  const handleSave = () => {
    onSaveSettings({ ...draft, updatedAt: new Date().toISOString() });
    toast.success('Export-Einstellungen gespeichert.');
  };

  const handleDownload = () => {
    if (result.errors.length > 0 || result.rows.length === 0) return;
    const mm = String(month).padStart(2, '0');
    downloadCsv(tabelle2ToExportTable(result.rows, `tagesabschluss-tabelle2-${year}-${mm}`));
    toast.success(`Buchungs-CSV mit ${result.rows.length} Zeilen erstellt.`);
  };

  const setKonto = (role: keyof TagesabschlussExportSettings['konten'], v: string) =>
    setDraft(d => ({ ...d, konten: { ...d.konten, [role]: v } }));

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">Buchhaltungs-Export (Tabelle2) — {String(month).padStart(2, '0')}/{year}</DialogTitle>
        </DialogHeader>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold">Konten (Rollen)</h3>
          <div className="grid grid-cols-2 gap-2">
            {ROLE_LABELS.map(([role, label]) => (
              <div key={role}>
                <Label className="text-[11px]">{label}</Label>
                <Input className="h-7 text-xs" value={draft.konten[role]} disabled={readOnly}
                  onChange={e => setKonto(role, e.target.value)}
                  data-testid={`ta-exp-konto-${role}`} />
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-2 border-t border-border pt-3">
          <h3 className="text-xs font-semibold">Konto je Zahlungsart</h3>
          <p className="text-[10px] text-muted-foreground">
            Karten: leer = Kreditkarten-Sammelkonto ({draft.konten.kartenSammel || '—'}).
            Unklassifizierte Zahlarten (z. B. KD Tisch 5000) brauchen zwingend ein Konto.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {paymentKeys.map(key => (
              <div key={key}>
                <Label className="text-[11px] capitalize">{key}</Label>
                <Input className="h-7 text-xs" value={draft.kontoJeZahlungsart[key] ?? ''} disabled={readOnly}
                  onChange={e => setDraft(d => ({
                    ...d,
                    kontoJeZahlungsart: { ...d.kontoJeZahlungsart, [key]: e.target.value },
                  }))} />
              </div>
            ))}
            {paymentKeys.length === 0 && (
              <p className="text-[11px] text-muted-foreground col-span-3">Keine Kartenzahlungen im Monat gefunden.</p>
            )}
          </div>
        </section>

        <section className="space-y-2 border-t border-border pt-3">
          <div className="grid grid-cols-2 gap-2 items-end">
            <div>
              <Label className="text-[11px]">Erste Belegnummer (optional)</Label>
              <Input className="h-7 text-xs" placeholder="z. B. 1001"
                value={draft.blgStart ?? ''} disabled={readOnly}
                onChange={e => setDraft(d => ({ ...d, blgStart: e.target.value }))} />
            </div>
            <label className="flex items-center gap-2 text-xs pb-1.5">
              <Checkbox checked={draft.reviewed} disabled={readOnly}
                onCheckedChange={v => setDraft(d => ({ ...d, reviewed: v === true }))}
                data-testid="ta-exp-reviewed" />
              Konto-Mapping geprüft
            </label>
          </div>
        </section>

        {result.errors.length > 0 && (
          <div className="rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-2 space-y-0.5">
            <p className="flex items-center gap-1 text-[11px] font-medium text-amber-800 dark:text-amber-300">
              <AlertTriangle className="h-3 w-3" /> Export blockiert:
            </p>
            {result.errors.map((e, i) => (
              <p key={i} className="text-[11px] text-amber-800 dark:text-amber-300">• {e}</p>
            ))}
          </div>
        )}

        {result.warnings.length > 0 && (
          <div className="rounded border border-orange-300 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/20 p-2 space-y-0.5"
            data-testid="ta-exp-warnings">
            <p className="flex items-center gap-1 text-[11px] font-medium text-orange-800 dark:text-orange-300">
              <AlertTriangle className="h-3 w-3" /> Korrekturen sind NICHT im Export enthalten:
            </p>
            {result.warnings.map((w, i) => (
              <p key={i} className="text-[11px] text-orange-800 dark:text-orange-300">• {w}</p>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          {!readOnly && (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleSave}
              data-testid="ta-exp-save-settings">
              Einstellungen speichern
            </Button>
          )}
          <Button size="sm" className="h-8 text-xs ml-auto"
            disabled={result.errors.length > 0 || result.rows.length === 0}
            onClick={handleDownload} data-testid="ta-exp-download">
            <Download className="h-3.5 w-3.5 mr-1" />
            CSV herunterladen ({result.rows.length} Zeilen)
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
