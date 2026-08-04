/**
 * Personaleintritt — Übersicht (Backoffice/GF)
 * ============================================
 * Route /personaleintritt — Gate: (Admin && !Gast) oder beaulieu_manager.
 * Liste aller Eintritte des Mandanten mit Status-Badges (Personalstamm-Design).
 * Aktionen: Neuer Eintritt · Entwurf löschen.
 * (Der öffentliche Einladungslink-Flow /e/:token wurde entfernt —
 * Personalien werden eingeloggt im Detail erfasst.)
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

import { PageShell } from '@/components/layout/PageShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { HintBox } from '@/components/ui/hint-box';
import { StatusPill } from '@/components/ui/status-pill';
import { LoadingState, EmptyState } from '@/components/ui/page-states';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { STATUS_TONES } from '@/components/personaleintritt/status-tone';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import { deletePersonaleintritt, loadPersonaleintritte } from '@/lib/personaleintritt/db';
import { STATUS_LABELS, type PersonaleintrittRecord } from '@/lib/personaleintritt/types';

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('de-CH');
}

function displayName(r: PersonaleintrittRecord): string {
  const p = r.maDaten?.personalien;
  const name = [p?.vorname, p?.name].filter(Boolean).join(' ');
  return name || r.funktion || 'Ohne Namen';
}

export default function PersonaleintrittListe() {
  const navigate = useNavigate();
  const { isAdmin, isBeaulieuManager } = usePermissions();
  const { tenantId } = useTenant();
  const canManage = isAdmin || isBeaulieuManager;

  const [records, setRecords] = useState<PersonaleintrittRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [preMigration, setPreMigration] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PersonaleintrittRecord | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await loadPersonaleintritte(tenantId);
    setPreMigration(res.preMigration);
    setLoadError(res.error);
    setRecords(res.data ?? []);
    setLoading(false);
  }, [tenantId]);

  useEffect(() => {
    if (!canManage) return; // Lade-Effekt gaten (feuert vor Redirect)
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await loadPersonaleintritte(tenantId);
      if (cancelled) return;
      setPreMigration(res.preMigration);
      setLoadError(res.error);
      setRecords(res.data ?? []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [canManage, tenantId]);

  if (!canManage) {
    return (
      <PageShell width="narrow">
        <HintBox tone="critical" title="Kein Zugriff">
          Diese Seite ist der Geschäftsführung vorbehalten.
        </HintBox>
      </PageShell>
    );
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const res = await deletePersonaleintritt(deleteTarget.id, tenantId);
    setDeleteTarget(null);
    if (res.error) { toast.error(res.error); return; }
    toast.success('Entwurf gelöscht');
    void reload();
  };

  return (
    <PageShell
      width="default"
      header={
        <PageHeader
          icon={<UserPlus />}
          title="Personaleintritte"
          info="Digitaler Eintrittsprozess: GF erfasst Eckdaten und Personalien, das Backoffice prüft und übernimmt in den Personalstamm."
          actions={
            <Button size="sm" onClick={() => navigate('/personaleintritt/neu')} data-testid="button-new-eintritt">
              <Plus className="mr-1 h-4 w-4" /> Neuer Eintritt
            </Button>
          }
        />
      }
    >
      {preMigration && (
        <HintBox tone="warn" title="Datenbank noch nicht bereit">
          Die Migration <code>20260724_personaleintritt.sql</code> wurde noch nicht ausgeführt
          (Supabase SQL-Editor). Danach diese Seite neu laden.
        </HintBox>
      )}
      {loadError && (
        <HintBox
          tone="critical"
          title="Laden fehlgeschlagen"
          action={<Button size="sm" variant="outline" onClick={() => void reload()}>Erneut versuchen</Button>}
        >
          {loadError}
        </HintBox>
      )}

      {loading ? <LoadingState /> : records.length === 0 && !preMigration && !loadError ? (
        <EmptyState
          icon={UserPlus}
          title="Noch keine Personaleintritte"
          description="Erfassen Sie die Eckdaten eines neuen Mitarbeiters als Entwurf."
          action={
            <Button size="sm" onClick={() => navigate('/personaleintritt/neu')} data-testid="button-new-eintritt-empty">
              <Plus className="mr-1 h-4 w-4" /> Neuer Eintritt
            </Button>
          }
        />
      ) : records.length > 0 && (
        <div className="overflow-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Name / Funktion</th>
                <th className="px-3 py-2 font-medium">Typ</th>
                <th className="px-3 py-2 font-medium">Eintritt</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Einladung gültig bis</th>
                <th className="px-3 py-2 text-right font-medium">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {records.map(r => (
                <tr
                  key={r.id}
                  className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                  onClick={() => navigate(`/personaleintritt/${r.id}`)}
                  data-testid={`row-eintritt-${r.id}`}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium">{displayName(r)}</div>
                    {r.maDaten?.personalien?.name && r.funktion && (
                      <div className="text-xs text-muted-foreground">{r.funktion}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">{r.vertragstyp ?? '—'}</td>
                  <td className="px-3 py-2 tabular-nums">{fmtDate(r.eintritt)}</td>
                  <td className="px-3 py-2">
                    <StatusPill tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</StatusPill>
                  </td>
                  <td className="px-3 py-2 tabular-nums text-xs text-muted-foreground">
                    {r.status === 'eingeladen' ? fmtDate(r.inviteExpires) : '—'}
                  </td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      {(r.status === 'entwurf' || r.status === 'abgebrochen') && (
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => setDeleteTarget(r)}
                          data-testid={`button-delete-${r.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog open={deleteTarget != null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eintrag löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              «{deleteTarget ? displayName(deleteTarget) : ''}» wird endgültig gelöscht.
              Nur Entwürfe und abgebrochene Einträge können gelöscht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()} data-testid="button-confirm-delete">
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
