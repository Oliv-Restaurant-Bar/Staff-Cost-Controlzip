/**
 * GaesteDuplikatePage — Gäste-Duplikate erkennen & sicher zusammenführen
 * ======================================================================
 * Admin-only Ansicht (`/gaeste/duplikate`).  Erkennt potenzielle Dubletten
 * anhand der NORMALISIERTEN Telefonnummer und stellt jede Gruppe nebeneinander
 * dar (Name, Telefon, E-Mail, Reservationen, letzter Besuch, angelegt am).  Der
 * Admin wählt einen Master und führt nach einer Bestätigung verlustfrei zusammen:
 * alle Reservationen + manuelle CRM-Daten wandern auf den Master, Duplikate werden
 * gelöscht (Logik in `guest-duplicates-db.ts`).
 *
 * Datenschutz: Gästedaten sind personenbezogen — Zugriff nur für eingeloggte
 * Admins; Gast-Sessions (read-only Links) sind ausgeschlossen.  Der Fetch ist
 * hinter der Admin-/Gast-Prüfung GEGATED, damit für unberechtigte Sessions kein
 * Gäste-Read erfolgt, bevor der `Navigate`-Redirect greift.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Users, Loader2, Database, AlertTriangle, ArrowLeft, GitMerge,
  Crown, ShieldCheck, RefreshCw, Phone, CheckCircle2,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { useNavigate, Navigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { useToast } from '@/hooks/use-toast';

import { checkReservationTablesExist } from '@/lib/reservation-import-db';
import { fetchDuplicateGroups, mergeGuests } from '@/lib/guest-duplicates-db';
import { guestDisplayName, type DuplicateGroup, type DuplicateGuest } from '@/lib/guest-duplicates';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';

const NUM0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });

function fdate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return fmtDate(parseISO(iso.slice(0, 10)), 'dd.MM.yyyy', { locale: de }); }
  catch { return iso; }
}

/** Master-Auswahl je Gruppe: phoneKey → gewählte Gast-id (Default = Vorschlag). */
type MasterChoice = Record<string, string>;

export default function GaesteDuplikatePage() {
  const { tenantId } = useTenant();
  const { isAdmin, isGuest } = usePermissions();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [tablesOk, setTablesOk] = useState<boolean | null>(null);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [masterChoice, setMasterChoice] = useState<MasterChoice>({});

  // Bestätigungsdialog + laufende Zusammenführung
  const [confirmGroup, setConfirmGroup] = useState<DuplicateGroup | null>(null);
  const [merging, setMerging] = useState<string | null>(null); // phoneKey der laufenden Zusammenführung

  const load = useCallback(async () => {
    if (!isAdmin || isGuest) { setLoading(false); return; }  // Datenschutz: kein Gäste-Read für Nicht-Admins / Gast-Sessions
    setLoading(true);
    setLoadError(null);
    const ok = await checkReservationTablesExist();
    setTablesOk(ok);
    if (!ok) { setGroups([]); setLoading(false); return; }
    try {
      const g = await fetchDuplicateGroups(tenantId);
      setGroups(g);
      // Master-Vorauswahl je Gruppe übernehmen (vom Helper vorgeschlagen).
      setMasterChoice(Object.fromEntries(g.map(grp => [grp.phoneKey, grp.suggestedMasterId])));
    } catch (e) {
      setGroups([]);
      setLoadError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, [tenantId, isAdmin, isGuest]);

  useEffect(() => { void load(); }, [load]);

  const pickMaster = (phoneKey: string, guestId: string) => {
    setMasterChoice(c => ({ ...c, [phoneKey]: guestId }));
  };

  const runMerge = async (group: DuplicateGroup) => {
    const masterId = masterChoice[group.phoneKey] ?? group.suggestedMasterId;
    const dupIds = group.guests.map(g => g.id).filter(id => id !== masterId);
    setMerging(group.phoneKey);
    const res = await mergeGuests(tenantId, masterId, dupIds);
    setMerging(null);
    setConfirmGroup(null);
    if (res.error) {
      toast({ title: 'Zusammenführung fehlgeschlagen', description: res.error, variant: 'destructive' });
      return;
    }
    toast({
      title: 'Gäste zusammengeführt',
      description: `${NUM0.format(res.mergedCount)} Duplikat${res.mergedCount === 1 ? '' : 'e'} entfernt · ${NUM0.format(res.reservationsMoved)} Reservation${res.reservationsMoved === 1 ? '' : 'en'} übernommen${res.crmMerged ? ' · CRM-Daten vereint' : ''}.`,
    });
    await load();   // Liste neu aufbauen (Gruppe verschwindet, wenn nur noch 1 Gast)
  };

  if (!isAdmin || isGuest) return <Navigate to="/" replace />;

  const masterId = confirmGroup ? (masterChoice[confirmGroup.phoneKey] ?? confirmGroup.suggestedMasterId) : null;
  const masterGuest = confirmGroup?.guests.find(g => g.id === masterId) ?? null;
  const dupCount = confirmGroup ? confirmGroup.guests.length - 1 : 0;

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      {/* Kopf */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <button
            onClick={() => navigate('/gaeste')}
            className="mb-2 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> Zurück zum Gäste-CRM
          </button>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <GitMerge className="h-6 w-6 text-primary" />
            Gäste-Duplikate
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Gäste mit identischer Telefonnummer erkennen und verlustfrei zusammenführen
            ({tenantId === 'beaulieu' ? 'Beaulieu' : 'Oliv'}).
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          Aktualisieren
        </button>
      </div>

      {tablesOk === false && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
          <Database className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            Die Reservationstabellen existieren noch nicht. Bitte zuerst die
            Migration ausführen und Reservationen importieren.
          </span>
        </div>
      )}

      {loadError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/30 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>Die Gäste konnten nicht geladen werden: {loadError}</span>
        </div>
      )}

      {/* Hinweis zur Erkennungslogik */}
      {tablesOk && !loading && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p>
            Erkennung über die normalisierte Telefonnummer (Leerzeichen/Format/Landesvorwahl
            werden vereinheitlicht). Beim Zusammenführen wandern <strong>alle Reservationen</strong> und
            <strong> manuelle CRM-Daten</strong> auf den gewählten Master; boolesche Merkmale (VIP, Sperrliste …)
            bleiben erhalten, Notizen/Allergien werden vereint, leere Stammdaten ergänzt. Die Duplikate
            werden danach gelöscht. <strong>Diese Aktion kann nicht rückgängig gemacht werden.</strong>
          </p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Gäste werden geprüft…
        </div>
      ) : tablesOk && groups.length === 0 && !loadError ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card py-16 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald-500" />
          <p className="text-sm font-medium">Keine Duplikate gefunden</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Es gibt aktuell keine Gäste, die sich eine Telefonnummer teilen.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {NUM0.format(groups.length)} mögliche Duplikat-Gruppe{groups.length === 1 ? '' : 'n'} gefunden.
            </p>
          )}
          {groups.map(group => (
            <DuplicateGroupCard
              key={group.phoneKey}
              group={group}
              selectedMasterId={masterChoice[group.phoneKey] ?? group.suggestedMasterId}
              onPickMaster={id => pickMaster(group.phoneKey, id)}
              onMerge={() => setConfirmGroup(group)}
              busy={merging === group.phoneKey}
            />
          ))}
        </div>
      )}

      {/* Bestätigungsdialog */}
      <AlertDialog open={!!confirmGroup} onOpenChange={open => { if (!open) setConfirmGroup(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <GitMerge className="h-5 w-5 text-primary" />
              Gäste zusammenführen?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  {NUM0.format(dupCount)} Duplikat{dupCount === 1 ? '' : 'e'} werden in den Master
                  <strong> {masterGuest ? guestDisplayName(masterGuest) : '—'}</strong> zusammengeführt.
                  Alle Reservationen und manuellen CRM-Daten wandern auf den Master, die Duplikate
                  werden anschliessend gelöscht.
                </p>
                <p className="font-medium text-red-600 dark:text-red-400">
                  Diese Aktion kann nicht rückgängig gemacht werden.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!merging}>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={e => { e.preventDefault(); if (confirmGroup) void runMerge(confirmGroup); }}
              disabled={!!merging}
              className="bg-primary"
            >
              {merging ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-4 w-4 animate-spin" /> Wird zusammengeführt…
                </span>
              ) : 'Zusammenführen'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Gruppen-Karte ──────────────────────────────────────────────────────────────

function DuplicateGroupCard({
  group, selectedMasterId, onPickMaster, onMerge, busy,
}: {
  group: DuplicateGroup;
  selectedMasterId: string;
  onPickMaster: (id: string) => void;
  onMerge: () => void;
  busy: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
        <div className="inline-flex items-center gap-2 text-sm font-semibold">
          <Phone className="h-4 w-4 text-primary" />
          {group.displayPhone}
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {group.guests.length} Gäste
          </span>
        </div>
        <button
          onClick={onMerge}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
          Zusammenführen
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 text-left font-semibold">Master</th>
              <th className="px-3 py-2 text-left font-semibold">Name</th>
              <th className="px-3 py-2 text-left font-semibold">Telefon</th>
              <th className="px-3 py-2 text-left font-semibold">E-Mail</th>
              <th className="px-3 py-2 text-right font-semibold">Reservationen</th>
              <th className="px-3 py-2 text-right font-semibold">Letzter Besuch</th>
              <th className="px-3 py-2 text-right font-semibold">Angelegt</th>
            </tr>
          </thead>
          <tbody>
            {group.guests.map(g => (
              <GuestRow
                key={g.id}
                guest={g}
                isMaster={g.id === selectedMasterId}
                onPick={() => onPickMaster(g.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GuestRow({ guest, isMaster, onPick }: { guest: DuplicateGuest; isMaster: boolean; onPick: () => void }) {
  return (
    <tr
      className={cn(
        'cursor-pointer border-b border-border/60 transition-colors last:border-0',
        isMaster ? 'bg-primary/5' : 'hover:bg-muted/40',
      )}
      onClick={onPick}
    >
      <td className="px-3 py-2.5">
        <label className="inline-flex items-center gap-2" onClick={e => e.stopPropagation()}>
          <input
            type="radio"
            checked={isMaster}
            onChange={onPick}
            className="h-4 w-4 accent-primary"
            aria-label="Als Master wählen"
          />
          {isMaster && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              <Crown className="h-3 w-3" /> Master
            </span>
          )}
        </label>
      </td>
      <td className="px-3 py-2.5">
        <div className="font-medium">{guestDisplayName(guest)}</div>
      </td>
      <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{guest.mobile || '—'}</td>
      <td className="px-3 py-2.5 text-muted-foreground">{guest.email || '—'}</td>
      <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{NUM0.format(guest.reservationCount)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{fdate(guest.lastReservationDate)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{fdate(guest.createdAt)}</td>
    </tr>
  );
}
