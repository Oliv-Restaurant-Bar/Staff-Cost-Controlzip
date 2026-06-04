/**
 * PDFExportDialog – Konfigurationsdialog für den PDF-Export der Erfolgsrechnung
 */

import React, { useState, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FileDown, Loader2 } from 'lucide-react';
import { MONTH_NAMES_SHORT_DE, MONTH_NAMES_DE } from '@/types/reporting';
import type { PLExportOptions } from '@/lib/pl-export';

interface PDFExportDialogProps {
  open:     boolean;
  onClose:  () => void;
  year:     number;
  month:    number;
  mode:     'budget_pl' | 'monthly' | 'yearly';
  onExport: (opts: PLExportOptions) => void;
}

export function PDFExportDialog({
  open, onClose, year, month, mode, onExport,
}: PDFExportDialogProps) {
  const [includeMonthReport,    setIncludeMonthReport]    = useState(true);
  const [includePrevMonth,      setIncludePrevMonth]      = useState(month > 1);
  const [includeCumulative,     setIncludeCumulative]     = useState(month > 1);
  const [includeSelectedMonths, setIncludeSelectedMonths] = useState(false);
  const [selectedMonths,        setSelectedMonths]        = useState<number[]>(
    Array.from({ length: month }, (_, i) => i + 1),
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setIncludePrevMonth(month > 1);
    setIncludeCumulative(month > 1);
    setSelectedMonths(Array.from({ length: month }, (_, i) => i + 1));
  }, [month]);

  const toggleMonth = (m: number) => {
    setSelectedMonths(prev =>
      prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m].sort((a, b) => a - b),
    );
  };

  const handleExport = () => {
    if (!includeMonthReport && !includePrevMonth && !includeCumulative && !includeSelectedMonths) return;
    setLoading(true);
    setTimeout(() => {
      onExport({
        includeMonthReport,
        includePrevMonth:      includePrevMonth && month > 1,
        includeCumulative:     includeCumulative && month > 1,
        includeSelectedMonths: includeSelectedMonths && selectedMonths.length > 0,
        selectedMonths,
      });
      setLoading(false);
      onClose();
    }, 50);
  };

  const monthName = MONTH_NAMES_DE[month] ?? '';

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold text-navy-900">
            PDF Export konfigurieren
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {monthName} {year} · {mode === 'budget_pl' ? 'Budget P&L' : mode === 'monthly' ? 'Monatsansicht' : 'Jahresübersicht'}
          </p>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Inhalte</p>
            <div className="space-y-2.5">

              <label className="flex items-start gap-2.5 cursor-pointer">
                <Checkbox checked={includeMonthReport} onCheckedChange={v => setIncludeMonthReport(!!v)} className="mt-0.5" />
                <div>
                  <p className="text-sm font-medium leading-tight">Monatsreport</p>
                  <p className="text-xs text-muted-foreground">{monthName} {year} – vollständige Erfolgsrechnung</p>
                </div>
              </label>

              <label className={`flex items-start gap-2.5 cursor-pointer ${month <= 1 ? 'opacity-40 pointer-events-none' : ''}`}>
                <Checkbox checked={includePrevMonth && month > 1} onCheckedChange={v => setIncludePrevMonth(!!v)} disabled={month <= 1} className="mt-0.5" />
                <div>
                  <p className="text-sm font-medium leading-tight">Vormonatsvergleich</p>
                  <p className="text-xs text-muted-foreground">
                    {month > 1 ? `${monthName} vs. ${MONTH_NAMES_DE[month - 1]} ${year}` : 'Kein Vormonat (Januar)'}
                  </p>
                </div>
              </label>

              <label className={`flex items-start gap-2.5 cursor-pointer ${month <= 1 ? 'opacity-40 pointer-events-none' : ''}`}>
                <Checkbox checked={includeCumulative && month > 1} onCheckedChange={v => setIncludeCumulative(!!v)} disabled={month <= 1} className="mt-0.5" />
                <div>
                  <p className="text-sm font-medium leading-tight">Kumulierte Übersicht</p>
                  <p className="text-xs text-muted-foreground">
                    {month > 1 ? `Januar bis ${monthName} ${year}` : 'Kein Vormonat (Januar)'}
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <Checkbox checked={includeSelectedMonths} onCheckedChange={v => setIncludeSelectedMonths(!!v)} className="mt-0.5" />
                <div>
                  <p className="text-sm font-medium leading-tight">Monatsvergleich</p>
                  <p className="text-xs text-muted-foreground">Ausgewählte Monate nebeneinander als Verlauf</p>
                </div>
              </label>
            </div>
          </div>

          {includeSelectedMonths && (
            <div className="border rounded-lg p-3 bg-slate-50">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Monatsauswahl</p>
              <div className="grid grid-cols-4 gap-1.5">
                {Array.from({ length: 12 }, (_, i) => {
                  const m = i + 1;
                  const checked = selectedMonths.includes(m);
                  return (
                    <label key={m} className={`flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer text-xs border transition-colors
                      ${checked ? 'bg-blue-50 border-blue-300 font-medium text-blue-800' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'}`}>
                      <Checkbox checked={checked} onCheckedChange={() => toggleMonth(m)} className="h-3.5 w-3.5" />
                      {MONTH_NAMES_SHORT_DE[m]}
                    </label>
                  );
                })}
              </div>
              {selectedMonths.length === 0 && (
                <p className="text-xs text-amber-600 mt-1.5">Mindestens einen Monat auswählen.</p>
              )}
              {selectedMonths.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  {selectedMonths.length} Monat{selectedMonths.length !== 1 ? 'e' : ''} ausgewählt:&nbsp;
                  {selectedMonths.map(m => MONTH_NAMES_SHORT_DE[m]).join(', ')}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose}>Abbrechen</Button>
          <Button
            size="sm"
            className="h-8 text-xs gap-1 bg-rose-700 hover:bg-rose-800 text-white"
            onClick={handleExport}
            disabled={
              loading ||
              (!includeMonthReport && !includePrevMonth && !includeCumulative && !includeSelectedMonths) ||
              (includeSelectedMonths && selectedMonths.length === 0)
            }
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
