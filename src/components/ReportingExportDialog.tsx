/**
 * ReportingExportDialog – Konfigurationsdialog für den Reporting-Jahresbericht-Export
 * Einfacher Dialog mit Maison-Toggle (analog zu PDFExportDialog in PLView).
 */

import React, { useState, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FileDown, Loader2 } from 'lucide-react';

interface ReportingExportDialogProps {
  open:             boolean;
  onClose:          () => void;
  year:             number;
  exportType:       'pdf' | 'monatsdaten';
  maisonAvailable?: boolean;
  maisonYearTotal?: number;
  onExport:         (includeMaison: boolean) => void;
}

export function ReportingExportDialog({
  open, onClose, year, exportType,
  maisonAvailable = false,
  maisonYearTotal = 0,
  onExport,
}: ReportingExportDialogProps) {
  const [includeMaison, setIncludeMaison] = useState(maisonAvailable);
  const [loading,       setLoading]       = useState(false);

  useEffect(() => {
    setIncludeMaison(maisonAvailable);
  }, [maisonAvailable]);

  const handleExport = () => {
    setLoading(true);
    setTimeout(() => {
      onExport(maisonAvailable ? includeMaison : true);
      setLoading(false);
      onClose();
    }, 50);
  };

  const title = exportType === 'pdf' ? 'Jahresbericht exportieren' : 'Monatsdaten exportieren';
  const desc  = exportType === 'pdf'
    ? `Jahresbericht ${year} als PDF`
    : `Personalkosten-Analyse ${year} als PDF`;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold text-navy-900">
            {title}
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {maisonAvailable && (
            <div className="border rounded-lg p-3 bg-violet-50 border-violet-200">
              <p className="text-xs font-semibold text-violet-700 uppercase tracking-wider mb-2">
                Marketing-Kanal (Maison)
              </p>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <Checkbox
                  checked={includeMaison}
                  onCheckedChange={v => setIncludeMaison(!!v)}
                  className="mt-0.5 border-violet-400 data-[state=checked]:bg-violet-600 data-[state=checked]:border-violet-600"
                />
                <div>
                  <p className="text-sm font-medium leading-tight text-violet-900">
                    Maison-Umsatz einschliessen
                  </p>
                  <p className="text-xs text-violet-600">
                    {maisonYearTotal > 0
                      ? `YTD: CHF ${Math.round(maisonYearTotal).toLocaleString('de-CH')} netto`
                      : 'Marketing-Umsatz in Betriebsertrag einrechnen'}
                  </p>
                </div>
              </label>
              {!includeMaison && (
                <p className="text-xs text-amber-700 mt-2 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  Umsatz wird ohne Maison-Anteil ausgewiesen. PK-Quote entsprechend höher.
                </p>
              )}
            </div>
          )}

          {!maisonAvailable && (
            <p className="text-xs text-muted-foreground">
              Kein Marketing-Kanal aktiv — alle Daten werden wie angezeigt exportiert.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs gap-1 bg-rose-700 hover:bg-rose-800 text-white"
            onClick={handleExport}
            disabled={loading}
          >
            {loading
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Erstelle PDF…</>
              : <><FileDown className="h-3.5 w-3.5" /> PDF erstellen</>
            }
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
