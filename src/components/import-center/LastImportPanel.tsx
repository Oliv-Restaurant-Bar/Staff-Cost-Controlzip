/**
 * LastImportPanel — «Letzter Import» + Rückgängig + kleine Historie
 * ==================================================================
 * Wiederverwendbares Panel pro Importquelle im Import-Center (Spec):
 *  - Sichtbarer Bereich «Letzter Import» mit Datum/Uhrzeit, Zeitraum, Anzahl,
 *    Datei und Mandant.
 *  - Button «Letzten Import rückgängig machen» mit Bestätigungsdialog
 *    (Zusammenfassung dessen, was zurückgesetzt wird).
 *  - Historie der letzten 5 Läufe — nur der neueste ist rückgängig machbar.
 *  - Gäste sehen die Historie, aber keinen Rückgängig-Button.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Undo2, History, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { toast } from 'sonner';
import { useTenant, TENANTS } from '@/contexts/TenantContext';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import {
  fetchRunsForSource, undoImportRun, IMPORT_UNDO_LOG_EVENT, IMPORT_SOURCE_LABEL,
  type ImportRunEntry, type ImportSourceKey, type UndoResult,
} from '@/lib/import-undo-store';
import { undoMirusImportRun } from '@/lib/mirus-undo';

interface Props {
  source: ImportSourceKey;
  /** Zusatztext im Bestätigungsdialog (was genau zurückgesetzt wird). */
  undoHint?: string;
}

const fmtTs = (iso: string) => {
  try { return format(new Date(iso), 'dd.MM.yyyy HH:mm', { locale: de }); } catch { return iso; }
};

export function LastImportPanel({ source, undoHint }: Props) {
  const { tenantId } = useTenant();
  const tenantName = TENANTS[tenantId].name;
  const { isGuest } = useGuestSession();
  const [runs, setRuns] = useState<ImportRunEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const reload = useCallback(() => {
    fetchRunsForSource(tenantId, source)
      .then(r => { setRuns(r); setLoadError(null); })
      .catch(err => { setRuns([]); setLoadError(err instanceof Error ? err.message : String(err)); });
  }, [tenantId, source]);

  useEffect(() => {
    reload();
    window.addEventListener(IMPORT_UNDO_LOG_EVENT, reload);
    return () => window.removeEventListener(IMPORT_UNDO_LOG_EVENT, reload);
  }, [reload]);

  if (runs === null) return null; // lädt — kein Flackern
  const latest = runs[0];
  if (!latest && !loadError) return null; // noch nie importiert → nichts anzeigen

  const undoable = !!latest && !latest.undone && !!latest.snapshot && !isGuest;

  const handleUndo = async () => {
    if (!latest?.snapshot) return;
    setBusy(true);
    try {
      let res: UndoResult;
      if (latest.snapshot.kind === 'mirus-ist') {
        res = await undoMirusImportRun(tenantId, { id: latest.id, snapshot: latest.snapshot });
      } else {
        res = await undoImportRun(tenantId, latest);
      }
      if (res.ok) toast.success(`Rückgängig: ${res.message}`);
      else toast.error(res.message);
    } catch (err) {
      toast.error(`Rückgängig fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      setConfirmOpen(false);
      reload();
    }
  };

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-xs" data-testid={`last-import-${source}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="font-medium text-sm">Letzter Import</span>
        {undoable && (
          <Button
            variant="outline" size="sm" className="gap-1.5 text-destructive border-destructive/40 hover:bg-destructive/10"
            onClick={() => setConfirmOpen(true)} disabled={busy}
            data-testid={`button-undo-${source}`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
            Letzten Import rückgängig machen
          </Button>
        )}
      </div>
      {loadError && <p className="text-destructive">Import-Protokoll nicht ladbar: {loadError}</p>}
      {latest && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-muted-foreground">
          <span>Datum: <span className="text-foreground">{fmtTs(latest.timestamp)}</span></span>
          <span>Zeitraum: <span className="text-foreground">{latest.periodLabel}</span></span>
          <span>Anzahl: <span className="text-foreground">{latest.itemCount} {latest.itemLabel}</span></span>
          {latest.fileName && <span className="col-span-2 truncate">Datei: <span className="text-foreground">{latest.fileName}</span></span>}
          <span>Mandant: <span className="text-foreground">{tenantName}</span></span>
          {latest.details && <span className="col-span-full">{latest.details}</span>}
          {latest.undone && <span className="col-span-full text-amber-600">Rückgängig gemacht am {fmtTs(latest.undoneAt ?? '')}</span>}
        </div>
      )}
      {runs.length > 1 && (
        <div>
          <button
            type="button" className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => setHistoryOpen(o => !o)} data-testid={`button-history-${source}`}
          >
            <History className="h-3.5 w-3.5" /> Historie ({runs.length - 1} weitere)
          </button>
          {historyOpen && (
            <ul className="mt-1.5 space-y-1 border-l pl-3">
              {runs.slice(1).map(r => (
                <li key={r.id} className="text-muted-foreground">
                  {fmtTs(r.timestamp)} — {r.periodLabel}, {r.itemCount} {r.itemLabel}
                  {r.fileName ? ` (${r.fileName})` : ''}{r.undone ? ' — rückgängig gemacht' : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Letzten Import rückgängig machen?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Der Import «{IMPORT_SOURCE_LABEL[source]}» vom {latest ? fmtTs(latest.timestamp) : ''} wird
                  zurückgesetzt: <strong>{latest?.periodLabel}</strong>, {latest?.itemCount} {latest?.itemLabel}
                  {latest?.fileName ? <> aus «{latest.fileName}»</> : null}, Mandant {tenantName}.
                </p>
                <p>
                  Es wird exakt der Zustand VOR diesem Import wiederhergestellt — nur für diesen
                  Zeitraum und Mandanten. Andere Daten bleiben unberührt.
                </p>
                {undoHint && <p className="text-muted-foreground">{undoHint}</p>}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void handleUndo(); }} disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid={`button-undo-confirm-${source}`}>
              {busy ? 'Wird zurückgesetzt…' : 'Rückgängig machen'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
