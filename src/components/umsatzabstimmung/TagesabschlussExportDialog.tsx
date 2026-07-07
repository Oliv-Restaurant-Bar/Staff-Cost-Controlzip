/**
 * TagesabschlussExportDialog.tsx — Buchungsregeln (Konten + Bezeichnungen).
 * ==============================================================================
 * Der Export ist BLOCKIERT, bis das Konto-Mapping vollständig ist und als
 * geprüft markiert wurde (reviewed) — kein stiller Fallback auf erfundene
 * Konten. Bezeichnungen sind je KONTONUMMER gespeichert (`kontoBezeichnungen`)
 * und rein Anzeige (Buchungsvorschau) — sie ändern NIE die CSV-Bytes.
 * Der CSV-Export läuft AUSSCHLIESSLICH über die Buchhaltungs-Export-Section
 * (Export-Protokoll/Versionierung) — hier gibt es bewusst KEINEN Download.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
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
  DEFAULT_KONTO_BEZEICHNUNGEN,
  type GnDayClosing,
  type TagesabschlussBlob,
  type TagesabschlussExportSettings,
  type TagesabschlussRow,
} from '@/lib/tagesabschluss';
import { buildTabelle2Rows } from '@/lib/tagesabschluss-export';

/**
 * Brutto-Modell: kein Umsatz-(Ertrag)-Konto, keine MWST-Codes mehr.
 * `bank` fehlt bewusst: Einzahlung Bank wird nicht exportiert (nur Kassensaldo),
 * die Bankbuchung kommt separat aus dem Bankbeleg/Bankimport.
 */
const ROLE_LABELS: Array<[keyof TagesabschlussExportSettings['konten'], string]> = [
  ['kasse', 'Kasse'],
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
    // Leere Bezeichnungen nicht persistieren (Fallback = Default-Katalog).
    const bez = Object.fromEntries(
      Object.entries(draft.kontoBezeichnungen ?? {})
        .map(([k, v]) => [k.trim(), v.trim()] as const)
        .filter(([k, v]) => k !== '' && v !== ''),
    );
    onSaveSettings({ ...draft, kontoBezeichnungen: bez, updatedAt: new Date().toISOString() });
    toast.success('Buchungsregeln gespeichert.');
  };

  const setKonto = (role: keyof TagesabschlussExportSettings['konten'], v: string) =>
    setDraft(d => ({ ...d, konten: { ...d.konten, [role]: v } }));

  /** Bezeichnung je KONTONUMMER (leer = Fallback auf den Default-Katalog). */
  const bezeichnungFor = (konto: string): string =>
    draft.kontoBezeichnungen?.[konto.trim()] ?? '';

  const setBezeichnung = (konto: string, v: string) => {
    const nr = konto.trim();
    if (nr === '') return;
    setDraft(d => ({ ...d, kontoBezeichnungen: { ...(d.kontoBezeichnungen ?? {}), [nr]: v } }));
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">Buchungsregeln — {String(month).padStart(2, '0')}/{year}</DialogTitle>
        </DialogHeader>
        <p className="text-[10px] text-muted-foreground -mt-1">
          Kontonummern steuern den CSV-Export; Bezeichnungen erscheinen nur in der
          Buchungsvorschau (leer = Standard-Bezeichnung).
        </p>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold">Konten (Rollen)</h3>
          <div className="grid grid-cols-2 gap-2">
            {ROLE_LABELS.map(([role, label]) => (
              <div key={role}>
                <Label className="text-[11px]">{label}</Label>
                <div className="flex gap-1.5">
                  <Input className="h-7 text-xs w-20 shrink-0" value={draft.konten[role]} disabled={readOnly}
                    onChange={e => setKonto(role, e.target.value)}
                    data-testid={`ta-exp-konto-${role}`} />
                  <Input className="h-7 text-xs" value={bezeichnungFor(draft.konten[role])}
                    placeholder={DEFAULT_KONTO_BEZEICHNUNGEN[draft.konten[role].trim()] ?? 'Bezeichnung'}
                    disabled={readOnly || draft.konten[role].trim() === ''}
                    onChange={e => setBezeichnung(draft.konten[role], e.target.value)}
                    data-testid={`ta-exp-bez-${role}`} />
                </div>
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
          <div className="grid grid-cols-2 gap-2">
            {paymentKeys.map(key => (
              <div key={key}>
                <Label className="text-[11px] capitalize">{key}</Label>
                <div className="flex gap-1.5">
                  <Input className="h-7 text-xs w-20 shrink-0" value={draft.kontoJeZahlungsart[key] ?? ''} disabled={readOnly}
                    onChange={e => setDraft(d => ({
                      ...d,
                      kontoJeZahlungsart: { ...d.kontoJeZahlungsart, [key]: e.target.value },
                    }))}
                    data-testid={`ta-exp-za-${key}`} />
                  <Input className="h-7 text-xs" value={bezeichnungFor(draft.kontoJeZahlungsart[key] ?? '')}
                    placeholder={DEFAULT_KONTO_BEZEICHNUNGEN[(draft.kontoJeZahlungsart[key] ?? '').trim()] ?? 'Bezeichnung'}
                    disabled={readOnly || (draft.kontoJeZahlungsart[key] ?? '').trim() === ''}
                    onChange={e => setBezeichnung(draft.kontoJeZahlungsart[key] ?? '', e.target.value)}
                    data-testid={`ta-exp-bez-za-${key}`} />
                </div>
              </div>
            ))}
            {paymentKeys.length === 0 && (
              <p className="text-[11px] text-muted-foreground col-span-2">Keine Kartenzahlungen im Monat gefunden.</p>
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

        {/* CSV-Export bewusst NUR über die Buchhaltungs-Export-Section
            (Export-Protokoll/Versionierung) — hier kein Download-Button. */}
        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          {!readOnly && (
            <Button size="sm" className="h-8 text-xs" onClick={handleSave}
              data-testid="ta-exp-save-settings">
              Buchungsregeln speichern
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
