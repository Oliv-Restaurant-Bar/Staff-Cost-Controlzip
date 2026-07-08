/**
 * OpImportDialog — PDF-Upload mit Vorschau für die Kreditoren-OP-Liste.
 * Ablauf: Datei wählen → Parser-Vorschau (Stichtag, Lieferanten, Posten,
 * Gesamtsaldo, Top 10, Warnungen) → Bestätigen / Abbrechen.
 * Gleicher Stichtag bereits vorhanden → expliziter Ersetzen-Hinweis,
 * KEIN stilles Überschreiben.
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileUp, Loader2, RefreshCcw } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { extractPdfTextLines } from '@/lib/pdf-import-engine';
import { parseOpListe } from '@/lib/op-liste-parser';
import { topSuppliers, type OpCompareItem } from '@/lib/op-liste-compare';
import { findActiveImport, saveOpImport } from '@/lib/op-liste-db';
import type { OpImportRecord, OpListeParseResult } from '@/types/op-liste';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  /** Nach erfolgreichem Import (Liste neu laden). */
  onImported: () => void;
}

const chf = (v: number) =>
  v.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDate = (iso: string | null) => {
  if (!iso) return '–';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

function flattenItems(parsed: OpListeParseResult): OpCompareItem[] {
  return parsed.suppliers.flatMap(sup =>
    sup.items.map(it => ({ supplierName: sup.name, openAmount: it.openAmount, buckets: it.buckets })),
  );
}

export function OpImportDialog({ open, onOpenChange, tenantId, onImported }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<'idle' | 'parsing' | 'preview' | 'saving'>('idle');
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<OpListeParseResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [debugLines, setDebugLines] = useState<string[]>([]);
  const [existing, setExisting] = useState<OpImportRecord | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPhase('idle');
      setFileName(null);
      setParsed(null);
      setParseError(null);
      setDebugLines([]);
      setExisting(null);
      setSaveError(null);
    }
  }, [open]);

  const handleFile = async (file: File) => {
    setPhase('parsing');
    setParseError(null);
    setSaveError(null);
    setParsed(null);
    setExisting(null);
    setFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const { lines, warnings: pdfWarnings } = await extractPdfTextLines(buffer);
      const result = parseOpListe(lines);
      if (!result.success) {
        setParseError(result.failureReason ?? 'PDF konnte nicht interpretiert werden.');
        setDebugLines(result.debug.sampleLines.slice(0, 15));
        setPhase('idle');
        return;
      }
      if (pdfWarnings.length > 0) result.warnings.unshift(...pdfWarnings);
      setParsed(result);
      if (result.snapshotDate) {
        setExisting(await findActiveImport(tenantId, result.snapshotDate));
      }
      setPhase('preview');
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  };

  const handleSave = async () => {
    if (!parsed) return;
    setPhase('saving');
    setSaveError(null);
    let createdBy: string | null = null;
    try {
      createdBy = (await supabase.auth.getUser()).data.user?.id ?? null;
    } catch { /* optional */ }
    const { error } = await saveOpImport({
      restaurantId: tenantId,
      fileName,
      parsed,
      replaceImportId: existing?.id ?? null,
      createdBy,
    });
    if (error) {
      setSaveError(error);
      setPhase('preview');
      return;
    }
    onImported();
    onOpenChange(false);
  };

  const top10 = parsed ? topSuppliers(flattenItems(parsed), 10) : [];
  const totalOpen = parsed ? (parsed.totals.openAmount ?? parsed.itemsSum) : 0;
  const itemCount = parsed ? parsed.suppliers.reduce((s, sup) => s + sup.items.length, 0) : 0;

  return (
    <Dialog open={open} onOpenChange={o => { if (phase !== 'saving') onOpenChange(o); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">OP-Liste importieren</DialogTitle>
          <DialogDescription className="text-xs">
            PDF „Offene Posten mit Fälligkeiten Kreditoren" hochladen — vor dem Speichern wird eine Vorschau angezeigt.
          </DialogDescription>
        </DialogHeader>

        {phase === 'idle' && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full border-2 border-dashed border-border rounded-lg p-8 text-center hover:border-primary/50 transition-colors"
              data-testid="op-upload-zone"
            >
              <FileUp className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">PDF auswählen (Klick)</p>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = '';
              }}
            />
            {parseError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs space-y-2" data-testid="op-parse-error">
                <p className="font-medium text-destructive flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {parseError}
                </p>
                {debugLines.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">Erkannte Zeilen (Diagnose)</summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[10px] text-muted-foreground">
                      {debugLines.join('\n')}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </div>
        )}

        {phase === 'parsing' && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> PDF wird gelesen …
          </div>
        )}

        {(phase === 'preview' || phase === 'saving') && parsed && (
          <div className="space-y-3 text-xs">
            {/* KPI-Vorschau */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded-md border border-border p-2">
                <p className="text-[10px] text-muted-foreground">Stichtag</p>
                <p className="font-semibold" data-testid="op-preview-stichtag">{fmtDate(parsed.snapshotDate)}</p>
              </div>
              <div className="rounded-md border border-border p-2">
                <p className="text-[10px] text-muted-foreground">Lieferanten</p>
                <p className="font-semibold">{parsed.suppliers.length}</p>
              </div>
              <div className="rounded-md border border-border p-2">
                <p className="text-[10px] text-muted-foreground">Posten</p>
                <p className="font-semibold">{itemCount}</p>
              </div>
              <div className="rounded-md border border-border p-2">
                <p className="text-[10px] text-muted-foreground">Gesamtsaldo</p>
                <p className="font-semibold">{chf(totalOpen)}</p>
              </div>
            </div>

            {parsed.warnings.length > 0 && (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 space-y-1" data-testid="op-preview-warnings">
                {parsed.warnings.map((w, i) => (
                  <p key={i} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {w}
                  </p>
                ))}
              </div>
            )}

            {existing && (
              <div className="rounded-md border border-orange-500/60 bg-orange-500/10 p-2" data-testid="op-preview-replace-hint">
                <p className="flex items-start gap-1.5 font-medium text-orange-700 dark:text-orange-400">
                  <RefreshCcw className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  Für den Stichtag {fmtDate(parsed.snapshotDate)} existiert bereits ein Import
                  ({existing.totalItems ?? '–'} Posten, {existing.totalOpenAmount !== null ? chf(existing.totalOpenAmount) : '–'}).
                  Beim Speichern wird er ERSETZT.
                </p>
              </div>
            )}

            {/* Top 10 */}
            <div>
              <p className="font-semibold mb-1">Top 10 Lieferanten</p>
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-2 py-1 font-medium">Lieferant</th>
                      <th className="text-right px-2 py-1 font-medium">Posten</th>
                      <th className="text-right px-2 py-1 font-medium">Offen CHF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {top10.map(s => (
                      <tr key={s.matchKey} className="border-t border-border">
                        <td className="px-2 py-1">{s.name}</td>
                        <td className="px-2 py-1 text-right">{s.itemCount}</td>
                        <td className="px-2 py-1 text-right font-medium">{chf(s.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {saveError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-destructive" data-testid="op-save-error">
                <AlertTriangle className="h-3.5 w-3.5 inline mr-1" /> {saveError}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={phase === 'saving'}>
            Abbrechen
          </Button>
          {(phase === 'preview' || phase === 'saving') && (
            <Button size="sm" onClick={() => void handleSave()} disabled={phase === 'saving'} data-testid="op-import-confirm">
              {phase === 'saving' && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              {existing ? 'Ersetzen & Importieren' : 'Importieren'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
