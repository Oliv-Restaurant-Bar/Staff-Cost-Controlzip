/**
 * Import-Center-Karte «Gastronovi Z-Berichte (täglich per Mail)»
 * ===============================================================
 *
 * Macht den E-Mail-Eingang (zbericht_inbox) im Import-Center sichtbar:
 * «Pending: N · zuletzt importiert: <Datum>», Button «Jetzt importieren»
 * (verarbeitet alle pending über den Auto-Import-Runner) und Direktlink
 * zur Z-Bericht-Seite (/gastronovi-import).
 *
 * Auto-Import: beim Öffnen des Import-Centers wird EINMAL pro Mandant
 * automatisch importiert (derselbe Runner wie auf der Z-Bericht-Seite —
 * Cross-Tab-sicher über den atomaren pending→processing-Claim, nur
 * eindeutige Tagesberichte; alles andere ⇒ «Prüfung nötig»).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Mail, Loader2, AlertCircle, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { useTenant } from '@/contexts/TenantContext';
import {
  loadPendingZberichtInbox, loadZberichtInboxLastImported,
} from '@/lib/zbericht-inbox-db';
import type { ZberichtInboxRow } from '@/lib/zbericht-inbox-db';
import {
  runZberichtAutoImport, autoImportSummary, isZberichtRowClaimable,
} from '@/lib/zbericht-auto-import';

function fdate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
}

interface Props {
  /** Nach erfolgreichen Importen (z.B. Datenstand-Refresh der Seite). */
  onImported?: (importedDays: string[]) => void;
  /** Auto-Import beim Mount (Default true); false = nur Anzeige + Button. */
  autoRun?: boolean;
}

const ZberichtInboxCard = ({ onImported, autoRun = true }: Props) => {
  const { tenantId } = useTenant();
  const [rows, setRows] = useState<ZberichtInboxRow[]>([]);
  const [lastImportedAt, setLastImportedAt] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const autoRanForTenant = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const [inbox, last] = await Promise.all([
      loadPendingZberichtInbox(tenantId),
      loadZberichtInboxLastImported(tenantId),
    ]);
    setRows(inbox.rows);
    setLoadError(inbox.error);
    setAvailable(!inbox.missingSchema && !last.missingSchema);
    setLastImportedAt(last.lastImportedAt);
  }, [tenantId]);

  useEffect(() => {
    autoRanForTenant.current = null; // Mandantenwechsel: neuer Auto-Lauf erlaubt
    void refresh();
  }, [refresh]);

  const runImport = useCallback(async (candidates: ZberichtInboxRow[]) => {
    const claimable = candidates.filter(isZberichtRowClaimable);
    if (claimable.length === 0 || running) return;
    setRunning(true);
    setProgress({ done: 0, total: claimable.length });
    try {
      const result = await runZberichtAutoImport(tenantId, claimable,
        (done, total) => setProgress({ done, total }));
      const summary = autoImportSummary(result);
      if (result.errorCount > 0 || result.skippedCount > 0) toast.warning(summary, { duration: 10000 });
      else if (result.importedCount > 0 || result.duplicateCount > 0) toast.success(summary);
      if (result.importedCount > 0) onImported?.(result.importedDays);
    } finally {
      setRunning(false);
      setProgress(null);
      void refresh();
    }
  }, [tenantId, running, refresh, onImported]);

  // Auto-Import beim Öffnen — einmal pro Mandant je Seitenbesuch.
  useEffect(() => {
    if (!autoRun) return;
    if (autoRanForTenant.current === tenantId) return;
    if (rows.some(r => isZberichtRowClaimable(r))) {
      autoRanForTenant.current = tenantId;
      void runImport(rows);
    }
  }, [rows, tenantId, autoRun, runImport]);

  if (!available) return null; // Migration fehlt → Karte ausblenden

  const pendingCount = rows.filter(r => r.status === 'pending' || r.status === 'processing').length;
  const errorCount = rows.filter(r => r.status === 'error').length;

  return (
    <Card className="border-l-4 border-l-teal-500 border-border bg-card shadow-sm" data-testid="card-zbericht-inbox">
      <CardHeader className="pb-2 pt-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-sm flex items-center gap-2">
            <Mail className="h-4 w-4 text-teal-600" />
            Gastronovi Z-Berichte (täglich per Mail)
            {pendingCount > 0 && (
              <span className="rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 px-2 py-0.5 text-xs font-medium"
                data-testid="badge-zbericht-card-pending">
                Pending: {pendingCount}
              </span>
            )}
            {errorCount > 0 && (
              <span className="rounded-full bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300 px-2 py-0.5 text-xs font-medium"
                data-testid="badge-zbericht-card-error">
                Prüfung nötig: {errorCount}
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {pendingCount > 0 && (
              <Button size="sm" className="h-8 text-xs"
                onClick={() => void runImport(rows)}
                disabled={running}
                data-testid="button-zbericht-card-import">
                {running && <Loader2 className="h-3 w-3 animate-spin mr-1.5" />}
                {running && progress ? `Importiere… ${progress.done}/${progress.total}` : 'Jetzt importieren'}
              </Button>
            )}
            <Link to="/gastronovi-import">
              <Button variant="outline" size="sm" className="h-8 text-xs" data-testid="link-zbericht-page">
                Z-Bericht-Seite
                <ExternalLink className="h-3 w-3 ml-1.5" />
              </Button>
            </Link>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pb-4 pt-0 space-y-1.5">
        <p className="text-xs text-muted-foreground" data-testid="text-zbericht-card-status">
          {pendingCount > 0
            ? `${pendingCount} PDF${pendingCount === 1 ? '' : 's'} ausstehend`
            : 'Keine ausstehenden Z-Berichte'}
          {' · zuletzt importiert: '}
          {lastImportedAt ? fdate(lastImportedAt) : '—'}
        </p>
        <p className="text-xs text-muted-foreground">
          Eingang per E-Mail (n8n) läuft automatisch; ausstehende Tagesberichte werden beim Öffnen
          dieser Seite importiert. Nicht eindeutige Fälle landen als «Prüfung nötig» auf der Z-Bericht-Seite.
        </p>
        {loadError && (
          <p className="text-xs text-red-700 dark:text-red-400 flex items-start gap-1">
            <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
            E-Mail-Eingang konnte nicht geladen werden: {loadError}
          </p>
        )}
        {errorCount > 0 && (
          <p className="text-xs text-red-700 dark:text-red-400 flex items-start gap-1">
            <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
            {errorCount} PDF{errorCount === 1 ? '' : 's'} brauch{errorCount === 1 ? 't' : 'en'} manuelle
            Prüfung — Details und Gründe auf der Z-Bericht-Seite.
          </p>
        )}
      </CardContent>
    </Card>
  );
};

export default ZberichtInboxCard;
