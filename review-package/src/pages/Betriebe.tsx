/**
 * Betriebe — Verwaltung (nur Admin, KEINE Gäste)
 * ==============================================
 * Route /betriebe: Betriebe sind seit Migration 20260724f DATENSÄTZE (Tabelle
 * betriebe) und speisen Vertrags-PDF, SEM-Meldung, Dossier und das
 * Mindestlohn-Stundenmodell des Personaleintritt-Moduls.
 *
 * Regeln (Betriebe-Auftrag):
 * - KEIN Hard-Delete: Betriebe sind FK-Ziel (personaleintritt.betrieb_id) —
 *   nur Deaktivieren (aktiv=false); deaktivierte bleiben für Alt-Datensätze
 *   auflösbar und werden hier sichtbar grau gelistet.
 * - SCC-Kopplung (sccIntegration + sccTenant oliv/beaulieu) verbindet einen
 *   Betrieb mit Personalstamm/Dienstplan; Dritt-Betriebe haben keine Kopplung.
 * - Pre-migration: Seite zeigt nur einen Hinweis — die zwei Legacy-Betriebe
 *   sind bis zur Migration über den Fallback aktiv und hier nicht editierbar.
 */
import { useCallback, useEffect, useState } from 'react';
import { Building2, Pencil, Plus, Power } from 'lucide-react';
import { toast } from 'sonner';

import { PageShell } from '@/components/layout/PageShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { HintBox } from '@/components/ui/hint-box';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusPill } from '@/components/ui/status-pill';
import { LoadingState, EmptyState } from '@/components/ui/page-states';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { usePermissions } from '@/hooks/usePermissions';
import { TENANTS, type TenantId } from '@/contexts/TenantContext';
import {
  createBetrieb, loadBetriebe, updateBetrieb, type BetriebPatch,
} from '@/lib/personaleintritt/db';
import {
  WOCHENSTUNDEN_MODELLE, betriebAnzeigename,
  type BetriebRecord, type WochenstundenModell,
} from '@/lib/personaleintritt/betriebs-config';

// ─── Formular-State (Dialog) ─────────────────────────────────────────────────

interface BetriebForm {
  name: string;
  anzeigename: string;
  strasse: string;
  plzOrt: string;
  uid: string;
  land: string;
  wochenstundenModell: WochenstundenModell;
  kontaktpersonName: string;
  kontaktpersonTel: string;
  kontaktpersonEmail: string;
  behoerdeEmail: string;
  sccIntegration: boolean;
  sccTenant: TenantId | '';
}

const LEERES_FORMULAR: BetriebForm = {
  name: '', anzeigename: '', strasse: '', plzOrt: '', uid: '', land: 'CH',
  wochenstundenModell: 42,
  kontaktpersonName: '', kontaktpersonTel: '', kontaktpersonEmail: '', behoerdeEmail: '',
  sccIntegration: false, sccTenant: '',
};

function formFromRecord(b: BetriebRecord): BetriebForm {
  return {
    name: b.name,
    anzeigename: b.anzeigename ?? '',
    strasse: b.strasse ?? '',
    plzOrt: b.plzOrt ?? '',
    uid: b.uid ?? '',
    land: b.land || 'CH',
    wochenstundenModell: b.wochenstundenModell,
    kontaktpersonName: b.kontaktpersonName ?? '',
    kontaktpersonTel: b.kontaktpersonTel ?? '',
    kontaktpersonEmail: b.kontaktpersonEmail ?? '',
    behoerdeEmail: b.behoerdeEmail ?? '',
    sccIntegration: b.sccIntegration,
    sccTenant: b.sccTenant ?? '',
  };
}

/** Leere Strings als null persistieren (Konsumenten warnen bei fehlenden Werten sichtbar). */
function patchFromForm(f: BetriebForm): BetriebPatch {
  return {
    name: f.name.trim(),
    anzeigename: f.anzeigename.trim() || null,
    strasse: f.strasse.trim() || null,
    plzOrt: f.plzOrt.trim() || null,
    uid: f.uid.trim() || null,
    land: f.land.trim() || 'CH',
    wochenstundenModell: f.wochenstundenModell,
    kontaktpersonName: f.kontaktpersonName.trim() || null,
    kontaktpersonTel: f.kontaktpersonTel.trim() || null,
    kontaktpersonEmail: f.kontaktpersonEmail.trim() || null,
    behoerdeEmail: f.behoerdeEmail.trim() || null,
    sccIntegration: f.sccIntegration,
    sccTenant: f.sccIntegration && f.sccTenant ? f.sccTenant : null,
  };
}

// ─── Seite ───────────────────────────────────────────────────────────────────

export default function Betriebe() {
  const { isAdmin } = usePermissions();
  const canManage = isAdmin;

  const [betriebe, setBetriebe] = useState<BetriebRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [preMigration, setPreMigration] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Dialog-State: null = zu, 'neu' = anlegen, sonst = Betrieb bearbeiten
  const [dialog, setDialog] = useState<'neu' | BetriebRecord | null>(null);
  const [form, setForm] = useState<BetriebForm>(LEERES_FORMULAR);
  const [saving, setSaving] = useState(false);

  // Deaktivieren-Bestätigung
  const [deaktiviereBetrieb, setDeaktiviereBetrieb] = useState<BetriebRecord | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await loadBetriebe();
    setPreMigration(res.preMigration);
    setLoadError(res.error);
    setBetriebe(res.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!canManage) return; // Lade-Effekt gaten (feuert vor Redirect)
    void reload();
  }, [canManage, reload]);

  if (!canManage) {
    return (
      <PageShell width="narrow">
        <HintBox tone="critical" title="Kein Zugriff">
          Die Betriebe-Verwaltung ist der Geschäftsführung vorbehalten.
        </HintBox>
      </PageShell>
    );
  }

  const openNeu = () => { setForm(LEERES_FORMULAR); setDialog('neu'); };
  const openEdit = (b: BetriebRecord) => { setForm(formFromRecord(b)); setDialog(b); };

  const save = async () => {
    if (!form.name.trim()) { toast.error('Firmenname ist erforderlich.'); return; }
    if (form.sccIntegration && !form.sccTenant) {
      toast.error('Für die SCC-Kopplung muss ein Mandant (Oliv/Beaulieu) gewählt sein.');
      return;
    }
    setSaving(true);
    const patch = patchFromForm(form);
    const res = dialog === 'neu'
      ? await createBetrieb(patch)
      : await updateBetrieb((dialog as BetriebRecord).id, patch);
    setSaving(false);
    if (res.preMigration) { setPreMigration(true); setDialog(null); return; }
    if (res.error || !res.data) { toast.error(`Speichern fehlgeschlagen: ${res.error}`); return; }
    toast.success(dialog === 'neu' ? 'Betrieb angelegt' : 'Betrieb gespeichert');
    setDialog(null);
    await reload();
  };

  const setAktiv = async (b: BetriebRecord, aktiv: boolean) => {
    const res = await updateBetrieb(b.id, { aktiv });
    if (res.error || !res.data) { toast.error(`Änderung fehlgeschlagen: ${res.error}`); return; }
    toast.success(aktiv ? 'Betrieb reaktiviert' : 'Betrieb deaktiviert');
    await reload();
  };

  const aktive = betriebe.filter(b => b.aktiv);
  const inaktive = betriebe.filter(b => !b.aktiv);

  return (
    <PageShell
      width="default"
      header={
        <PageHeader
          icon={<Building2 />}
          title="Betriebe"
          info="Betriebe als Datensätze: Grundlage für Verträge, SEM-Meldungen und Dossiers im Personaleintritt. Deaktivieren statt löschen — Alt-Datensätze bleiben auflösbar."
          actions={
            <Button size="sm" onClick={openNeu} disabled={preMigration} data-testid="button-betrieb-neu">
              <Plus className="mr-1 h-4 w-4" /> Neuer Betrieb
            </Button>
          }
        />
      }
    >
      {preMigration && (
        <HintBox tone="warn" title="Datenbank noch nicht bereit">
          Die Migration <code>20260724f_betriebe.sql</code> wurde noch nicht ausgeführt
          (Supabase SQL-Editor). Bis dahin arbeitet der Personaleintritt mit den zwei
          fest hinterlegten Übergangs-Betrieben (Oliv, Beaulieu) — hier ist nichts editierbar.
        </HintBox>
      )}
      {loadError && (
        <HintBox
          tone="critical" title="Betriebe konnten nicht geladen werden"
          action={<Button size="sm" variant="outline" onClick={() => void reload()}>Erneut versuchen</Button>}
        >
          {loadError}
        </HintBox>
      )}

      {loading ? <LoadingState /> : (
        <div className="space-y-4">
          {!preMigration && betriebe.length === 0 && !loadError && (
            <EmptyState
              title="Noch keine Betriebe"
              description="Mit «Neuer Betrieb» den ersten Betrieb anlegen."
            />
          )}

          {aktive.map(b => (
            <BetriebKarte key={b.id} betrieb={b}
              onEdit={() => openEdit(b)}
              onDeaktivieren={() => setDeaktiviereBetrieb(b)}
            />
          ))}

          {inaktive.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Deaktivierte Betriebe</p>
              {inaktive.map(b => (
                <BetriebKarte key={b.id} betrieb={b}
                  onEdit={() => openEdit(b)}
                  onReaktivieren={() => void setAktiv(b, true)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Anlegen/Bearbeiten ── */}
      <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{dialog === 'neu' ? 'Neuer Betrieb' : 'Betrieb bearbeiten'}</DialogTitle>
            <DialogDescription>
              Juristische Angaben erscheinen 1:1 in Verträgen und Behörden-Dokumenten —
              fehlende Felder werden dort sichtbar als Warnung gemeldet.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="bf-name">Firmenname (juristisch) *</Label>
              <Input id="bf-name" value={form.name} placeholder="z. B. Oliv Gastro AG"
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} data-testid="input-betrieb-name" />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="bf-anzeigename">Anzeigename (UI/Betreff)</Label>
              <Input id="bf-anzeigename" value={form.anzeigename} placeholder="z. B. Oliv Restaurant & Bar"
                onChange={e => setForm(f => ({ ...f, anzeigename: e.target.value }))} data-testid="input-betrieb-anzeigename" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bf-strasse">Strasse</Label>
              <Input id="bf-strasse" value={form.strasse}
                onChange={e => setForm(f => ({ ...f, strasse: e.target.value }))} data-testid="input-betrieb-strasse" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bf-plzort">PLZ / Ort</Label>
              <Input id="bf-plzort" value={form.plzOrt} placeholder="z. B. 3011 Bern"
                onChange={e => setForm(f => ({ ...f, plzOrt: e.target.value }))} data-testid="input-betrieb-plzort" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bf-uid">UID (CHE-…)</Label>
              <Input id="bf-uid" value={form.uid} placeholder="CHE-123.456.789"
                onChange={e => setForm(f => ({ ...f, uid: e.target.value }))} data-testid="input-betrieb-uid" />
            </div>
            <div className="space-y-1">
              <Label>Wochenstunden-Modell (L-GAV)</Label>
              <Select
                value={String(form.wochenstundenModell)}
                onValueChange={v => setForm(f => ({ ...f, wochenstundenModell: Number(v) as WochenstundenModell }))}
              >
                <SelectTrigger data-testid="select-betrieb-wochenstunden"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WOCHENSTUNDEN_MODELLE.map(m => (
                    <SelectItem key={m} value={String(m)}>{m} Std./Woche</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bf-kontakt-name">Kontaktperson (Behörden)</Label>
              <Input id="bf-kontakt-name" value={form.kontaktpersonName}
                onChange={e => setForm(f => ({ ...f, kontaktpersonName: e.target.value }))} data-testid="input-betrieb-kontakt-name" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bf-kontakt-tel">Kontakt-Telefon</Label>
              <Input id="bf-kontakt-tel" value={form.kontaktpersonTel}
                onChange={e => setForm(f => ({ ...f, kontaktpersonTel: e.target.value }))} data-testid="input-betrieb-kontakt-tel" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bf-kontakt-email">Kontakt-E-Mail</Label>
              <Input id="bf-kontakt-email" type="email" value={form.kontaktpersonEmail}
                onChange={e => setForm(f => ({ ...f, kontaktpersonEmail: e.target.value }))} data-testid="input-betrieb-kontakt-email" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bf-behoerde-email">Behörden-E-Mail (SEM-Zustellung)</Label>
              <Input id="bf-behoerde-email" type="email" value={form.behoerdeEmail} placeholder="meldeverfahren.midi@be.ch"
                onChange={e => setForm(f => ({ ...f, behoerdeEmail: e.target.value }))} data-testid="input-betrieb-behoerde-email" />
            </div>
            <div className="space-y-2 sm:col-span-2 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="bf-scc"
                  checked={form.sccIntegration}
                  onCheckedChange={c => setForm(f => ({ ...f, sccIntegration: c === true, sccTenant: c === true ? f.sccTenant : '' }))}
                  data-testid="checkbox-betrieb-scc"
                />
                <Label htmlFor="bf-scc" className="cursor-pointer">
                  Mit Personalstamm/Dienstplan gekoppelt (SCC)
                </Label>
              </div>
              {form.sccIntegration && (
                <div className="space-y-1">
                  <Label>Mandant</Label>
                  <Select
                    value={form.sccTenant || undefined}
                    onValueChange={v => setForm(f => ({ ...f, sccTenant: v as TenantId }))}
                  >
                    <SelectTrigger data-testid="select-betrieb-scc-tenant"><SelectValue placeholder="Wählen…" /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(TENANTS) as TenantId[]).map(id => (
                        <SelectItem key={id} value={id}>{TENANTS[id].name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Personaleinträge dieses Betriebs landen im gewählten Mandanten;
                    die Personalstamm-Übernahme ist nur mit Kopplung möglich.
                  </p>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={saving}>Abbrechen</Button>
            <Button onClick={() => void save()} disabled={saving} data-testid="button-betrieb-speichern">
              {saving ? 'Speichert…' : 'Speichern'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Deaktivieren-Bestätigung ── */}
      <AlertDialog open={deaktiviereBetrieb !== null} onOpenChange={open => { if (!open) setDeaktiviereBetrieb(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Betrieb deaktivieren?</AlertDialogTitle>
            <AlertDialogDescription>
              «{deaktiviereBetrieb ? betriebAnzeigename(deaktiviereBetrieb) : ''}» steht danach bei neuen
              Personaleintritten nicht mehr zur Auswahl. Bestehende Datensätze und Dokumente bleiben
              unverändert und weiterhin auflösbar. Der Betrieb kann jederzeit reaktiviert werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const b = deaktiviereBetrieb;
                setDeaktiviereBetrieb(null);
                if (b) void setAktiv(b, false);
              }}
              data-testid="button-betrieb-deaktivieren-bestaetigen"
            >
              Deaktivieren
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}

// ─── Betriebs-Karte ──────────────────────────────────────────────────────────

function BetriebKarte({ betrieb: b, onEdit, onDeaktivieren, onReaktivieren }: {
  betrieb: BetriebRecord;
  onEdit: () => void;
  onDeaktivieren?: () => void;
  onReaktivieren?: () => void;
}) {
  const adresse = [b.strasse, b.plzOrt].filter(Boolean).join(', ');
  return (
    <Card className={b.aktiv ? undefined : 'opacity-60'} data-testid={`card-betrieb-${b.id}`}>
      <CardContent className="flex flex-wrap items-start justify-between gap-3 pt-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{betriebAnzeigename(b)}</span>
            {b.sccIntegration && b.sccTenant && (
              <StatusPill tone="info">SCC: {TENANTS[b.sccTenant]?.name ?? b.sccTenant}</StatusPill>
            )}
            {!b.aktiv && <StatusPill tone="neutral">deaktiviert</StatusPill>}
          </div>
          <p className="text-sm text-muted-foreground">
            {b.name}{adresse ? ` · ${adresse}` : ''}{b.uid ? ` · ${b.uid}` : ''}
          </p>
          <p className="text-xs text-muted-foreground">
            {b.wochenstundenModell} Std./Woche
            {b.kontaktpersonName ? ` · Kontakt: ${b.kontaktpersonName}` : ''}
            {b.behoerdeEmail ? ` · Behörde: ${b.behoerdeEmail}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={onEdit} data-testid={`button-betrieb-edit-${b.id}`}>
            <Pencil className="mr-1 h-4 w-4" /> Bearbeiten
          </Button>
          {b.aktiv && onDeaktivieren && (
            <Button size="sm" variant="ghost" onClick={onDeaktivieren} data-testid={`button-betrieb-deaktivieren-${b.id}`}>
              <Power className="mr-1 h-4 w-4 text-destructive" /> Deaktivieren
            </Button>
          )}
          {!b.aktiv && onReaktivieren && (
            <Button size="sm" variant="ghost" onClick={onReaktivieren} data-testid={`button-betrieb-reaktivieren-${b.id}`}>
              <Power className="mr-1 h-4 w-4" /> Reaktivieren
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
