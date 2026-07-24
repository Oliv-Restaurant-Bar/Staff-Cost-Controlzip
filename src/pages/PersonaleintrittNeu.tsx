/**
 * Personaleintritt — Phase 1: GF erfasst Eckdaten (mobil-first)
 * =============================================================
 * Route /personaleintritt/neu — Gate: (Admin && !Gast) oder beaulieu_manager
 * (Route-Guard UND Lade-Effekt, Muster admin-write-gate).
 *
 * Lohn: 3 Modi transparent (Grundlohn / L-GAV-Mindestlohn / Ziel-Total);
 * Berechnung + Mindestlohn-Prüfung zentral in lib/personaleintritt/lohn.ts.
 * «Einladung erstellen» erzeugt den Token client-seitig (nur der sha256-Hash
 * geht in die DB) und zeigt den Link genau einmal im Dialog.
 *
 * Pre-migration-tolerant: fehlen die Tabellen (Migration 20260724 noch nicht
 * ausgeführt), erscheint eine HintBox statt eines Crashs.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Send, Save, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

import { PageShell } from '@/components/layout/PageShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HintBox } from '@/components/ui/hint-box';
import { StatusPill } from '@/components/ui/status-pill';
import { LoadingState } from '@/components/ui/page-states';
import { InviteLinkDialog } from '@/components/personaleintritt/InviteLinkDialog';
import { usePermissions } from '@/hooks/usePermissions';
import { useAuth } from '@/hooks/useAuth';
import { useTenant } from '@/contexts/TenantContext';
import { createPersonaleintritt, loadLgavMindestloehne } from '@/lib/personaleintritt/db';
import {
  berechneLohn, mindestlohnJahr, rundeLohn, type MindestlohnEintrag,
} from '@/lib/personaleintritt/lohn';
import {
  LOHNKLASSEN, LOHNKLASSE_LABELS,
  type LohnModus, type Lohnklasse, type Vertragstyp,
} from '@/lib/personaleintritt/types';
import { generateInviteToken, hashInviteToken, inviteExpiryIso, inviteLink } from '@/lib/personaleintritt/token';

const fmtCHF = (v: number) =>
  v.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MODUS_LABELS: Record<LohnModus, string> = {
  grundlohn: 'Grundlohn direkt',
  mindestlohn: 'L-GAV-Mindestlohn',
  zieltotal: 'Ziel-Total inkl. allem',
};

export default function PersonaleintrittNeu() {
  const navigate = useNavigate();
  const { isAdmin, isGuest, isBeaulieuManager } = usePermissions();
  const { user } = useAuth();
  const { tenantId, tenant } = useTenant();
  const canManage = (isAdmin && !isGuest) || isBeaulieuManager;

  // ── Mindestlohn-Tabelle laden (gated, read-only) ──────────────────────────
  const [minLoehne, setMinLoehne] = useState<MindestlohnEintrag[] | null>(null);
  const [preMigration, setPreMigration] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!canManage) return; // Lade-Effekt ebenfalls gaten (feuert vor Redirect)
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await loadLgavMindestloehne();
      if (cancelled) return;
      setPreMigration(res.preMigration);
      setLoadError(res.error);
      setMinLoehne(res.data ?? []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [canManage]);

  // ── Formular-State ────────────────────────────────────────────────────────
  const [vertragstyp, setVertragstyp] = useState<Vertragstyp | null>(null);
  const [betrieb, setBetrieb] = useState('');
  const [funktion, setFunktion] = useState('');
  const [eintritt, setEintritt] = useState('');
  const [pensum, setPensum] = useState('100');
  const [probezeit, setProbezeit] = useState('90');
  const [vertragsdauer, setVertragsdauer] = useState<'unbefristet' | 'befristet'>('unbefristet');
  const [befristetBis, setBefristetBis] = useState('');
  const [lohnModus, setLohnModus] = useState<LohnModus>('grundlohn');
  const [lohnklasse, setLohnklasse] = useState<Lohnklasse | ''>('');
  const [grundlohn, setGrundlohn] = useState('');
  const [zielTotal, setZielTotal] = useState('');
  const [einfuehrungszeit, setEinfuehrungszeit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  useEffect(() => { setBetrieb(tenant.name); }, [tenant.name]);

  const lohn = useMemo(() => {
    if (!vertragstyp) return null;
    return berechneLohn({
      vertragstyp,
      modus: lohnModus,
      grundlohn: grundlohn ? Number(grundlohn) : undefined,
      zielTotal: zielTotal ? Number(zielTotal) : undefined,
      lohnklasse: lohnklasse || undefined,
      einfuehrungszeit,
      jahr: mindestlohnJahr(eintritt || undefined),
      mindestloehne: minLoehne ?? [],
    });
  }, [vertragstyp, lohnModus, grundlohn, zielTotal, lohnklasse, einfuehrungszeit, eintritt, minLoehne]);

  if (!canManage) {
    return (
      <PageShell width="narrow">
        <HintBox tone="critical" title="Kein Zugriff">
          Diese Seite ist der Geschäftsführung vorbehalten.
        </HintBox>
      </PageShell>
    );
  }

  const einheitLabel = vertragstyp === 'SL' ? 'CHF/Std.' : 'CHF/Monat';

  const fehlendeFelder = (): string[] => {
    const f: string[] = [];
    if (!vertragstyp) f.push('Vertragstyp');
    if (!funktion.trim()) f.push('Funktion');
    if (!eintritt) f.push('Eintrittsdatum');
    if (vertragstyp === 'ML' && !(Number(pensum) > 0)) f.push('Pensum');
    if (vertragsdauer === 'befristet' && !befristetBis) f.push('Befristet bis');
    if (lohn?.lohnBerechnet == null) f.push('Lohn');
    return f;
  };

  const buildPatch = (status: 'entwurf' | 'eingeladen') => ({
    status,
    vertragstyp: vertragstyp ?? undefined,
    betrieb: betrieb.trim() || tenant.name,
    funktion: funktion.trim() || undefined,
    eintritt: eintritt || null,
    pensumProzent: vertragstyp === 'ML' && pensum ? Number(pensum) : null,
    probezeitTage: probezeit ? Number(probezeit) : 90,
    vertragsdauer,
    befristetBis: vertragsdauer === 'befristet' && befristetBis ? befristetBis : null,
    lohnModus,
    lohnklasse: lohnklasse || null,
    grundlohn: lohnModus === 'grundlohn' && grundlohn ? Number(grundlohn) : null,
    zielTotal: lohnModus === 'zieltotal' && zielTotal ? Number(zielTotal) : null,
    lohnBerechnet: lohn?.lohnBerechnet != null ? rundeLohn(lohn.lohnBerechnet) : null,
    lohnEinheit: lohn?.lohnEinheit ?? null,
    einfuehrungszeit,
  });

  const saveDraft = async () => {
    setSaving(true);
    const res = await createPersonaleintritt(tenantId, buildPatch('entwurf'), user?.email ?? user?.id);
    setSaving(false);
    if (res.preMigration) { setPreMigration(true); return; }
    if (res.error || !res.data) { toast.error(`Speichern fehlgeschlagen: ${res.error}`); return; }
    toast.success('Entwurf gespeichert');
    navigate('/personaleintritt');
  };

  const createInvitation = async () => {
    const fehlend = fehlendeFelder();
    if (fehlend.length > 0) {
      toast.error(`Bitte ergänzen: ${fehlend.join(', ')}`);
      return;
    }
    if (lohn?.blockierend) {
      toast.error('Der Lohn liegt unter dem L-GAV-Mindestlohn — Einladung nicht möglich.');
      return;
    }
    setSaving(true);
    const token = generateInviteToken();
    const tokenHash = await hashInviteToken(token);
    const res = await createPersonaleintritt(tenantId, {
      ...buildPatch('eingeladen'),
      inviteTokenHash: tokenHash,
      inviteExpires: inviteExpiryIso(),
      eingeladenAm: new Date().toISOString(),
    }, user?.email ?? user?.id);
    setSaving(false);
    if (res.preMigration) { setPreMigration(true); return; }
    if (res.error || !res.data) { toast.error(`Einladung fehlgeschlagen: ${res.error}`); return; }
    setInviteUrl(inviteLink(window.location.origin, token));
  };

  return (
    <PageShell
      width="narrow"
      header={
        <PageHeader
          icon={<UserPlus />}
          title="Neuer Personaleintritt"
          info="Eckdaten erfassen und den Mitarbeiter per Link einladen. Der Mitarbeiter füllt seine Personalien selbst aus (Handy)."
          width="narrow"
          actions={
            <Button variant="ghost" size="sm" onClick={() => navigate('/personaleintritt')} data-testid="button-back-to-list">
              <ArrowLeft className="mr-1 h-4 w-4" /> Übersicht
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
        <HintBox tone="critical" title="Mindestlohn-Tabelle konnte nicht geladen werden">
          {loadError} — die Mindestlohn-Prüfung ist ohne Tabelle nicht möglich.
        </HintBox>
      )}

      {loading ? <LoadingState /> : (
        <div className="space-y-4">
          {/* ── Vertragstyp ── */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Vertragstyp</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-2">
              {(['SL', 'ML'] as Vertragstyp[]).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setVertragstyp(t)}
                  data-testid={`button-vertragstyp-${t.toLowerCase()}`}
                  className={`rounded-lg border-2 p-3 text-left transition-colors ${
                    vertragstyp === t ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
                  }`}
                >
                  <div className="text-sm font-semibold">{t === 'SL' ? 'Stundenlohn (SL)' : 'Monatslohn (ML)'}</div>
                  <div className="text-xs text-muted-foreground">
                    {t === 'SL' ? 'Aushilfen, flexible Einsätze' : 'Fest angestellt, Pensum in %'}
                  </div>
                </button>
              ))}
            </CardContent>
          </Card>

          {/* ── Eckdaten ── */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Eckdaten</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pe-betrieb">Betrieb</Label>
                <Input id="pe-betrieb" value={betrieb} onChange={e => setBetrieb(e.target.value)} data-testid="input-betrieb" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pe-funktion">Funktion *</Label>
                <Input id="pe-funktion" value={funktion} onChange={e => setFunktion(e.target.value)}
                  placeholder="z. B. Servicemitarbeiter/in" data-testid="input-funktion" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pe-eintritt">Eintritt (Beginn) *</Label>
                <Input id="pe-eintritt" type="date" value={eintritt} onChange={e => setEintritt(e.target.value)} data-testid="input-eintritt" />
              </div>
              {vertragstyp === 'ML' && (
                <div className="space-y-1">
                  <Label htmlFor="pe-pensum">Pensum % *</Label>
                  <Input id="pe-pensum" type="number" min="1" max="100" value={pensum}
                    onChange={e => setPensum(e.target.value)} data-testid="input-pensum" />
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="pe-probezeit">Probezeit (Tage)</Label>
                <Input id="pe-probezeit" type="number" min="0" value={probezeit}
                  onChange={e => setProbezeit(e.target.value)} data-testid="input-probezeit" />
              </div>
              <div className="space-y-1">
                <Label>Vertragsdauer</Label>
                <Select value={vertragsdauer} onValueChange={v => setVertragsdauer(v as 'unbefristet' | 'befristet')}>
                  <SelectTrigger data-testid="select-vertragsdauer"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unbefristet">Unbefristet</SelectItem>
                    <SelectItem value="befristet">Befristet</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {vertragsdauer === 'befristet' && (
                <div className="space-y-1">
                  <Label htmlFor="pe-befristet">Befristet bis *</Label>
                  <Input id="pe-befristet" type="date" value={befristetBis}
                    onChange={e => setBefristetBis(e.target.value)} data-testid="input-befristet-bis" />
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Lohn (3 Modi) ── */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Lohn</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(Object.keys(MODUS_LABELS) as LohnModus[]).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setLohnModus(m)}
                    data-testid={`button-lohnmodus-${m}`}
                    className={`rounded-lg border-2 px-3 py-2 text-left text-xs font-medium transition-colors ${
                      lohnModus === m ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
                    }`}
                  >
                    {MODUS_LABELS[m]}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>L-GAV-Lohnklasse {lohnModus === 'mindestlohn' ? '*' : '(für die Mindestlohn-Prüfung)'}</Label>
                  <Select value={lohnklasse} onValueChange={v => setLohnklasse(v as Lohnklasse)}>
                    <SelectTrigger data-testid="select-lohnklasse"><SelectValue placeholder="Wählen…" /></SelectTrigger>
                    <SelectContent>
                      {LOHNKLASSEN.map(k => (
                        <SelectItem key={k} value={k}>{LOHNKLASSE_LABELS[k]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {lohnModus === 'grundlohn' && (
                  <div className="space-y-1">
                    <Label htmlFor="pe-grundlohn">Grundlohn ({einheitLabel}) *</Label>
                    <Input id="pe-grundlohn" type="number" min="0" step="0.05" value={grundlohn}
                      onChange={e => setGrundlohn(e.target.value)} data-testid="input-grundlohn" />
                  </div>
                )}
                {lohnModus === 'zieltotal' && (
                  <div className="space-y-1">
                    <Label htmlFor="pe-zieltotal">Ziel-Total inkl. allem ({einheitLabel}) *</Label>
                    <Input id="pe-zieltotal" type="number" min="0" step="0.05" value={zielTotal}
                      onChange={e => setZielTotal(e.target.value)} data-testid="input-zieltotal" />
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={einfuehrungszeit} onCheckedChange={c => setEinfuehrungszeit(c === true)}
                  data-testid="checkbox-einfuehrungszeit" />
                Einführungszeit (Mindestlohn −8 % zulässig)
              </label>

              {/* Live-Berechnung */}
              {vertragstyp && lohn && (
                <div className="space-y-2 rounded-lg border bg-muted/40 p-3" data-testid="box-lohn-result">
                  {lohn.lohnBerechnet != null ? (
                    <>
                      <div className="flex items-baseline justify-between">
                        <span className="text-sm font-medium">Basislohn</span>
                        <span className="text-base font-semibold tabular-nums" data-testid="text-lohn-berechnet">
                          {fmtCHF(rundeLohn(lohn.lohnBerechnet))} {einheitLabel}
                        </span>
                      </div>
                      {lohn.slZuschlaege && (
                        <div className="space-y-0.5 text-xs text-muted-foreground">
                          <div className="flex justify-between"><span>+ 10.65 % Ferien</span><span className="tabular-nums">{fmtCHF(lohn.slZuschlaege.ferien)}</span></div>
                          <div className="flex justify-between"><span>+ 2.27 % Feiertage</span><span className="tabular-nums">{fmtCHF(lohn.slZuschlaege.feiertag)}</span></div>
                          <div className="flex justify-between"><span>+ 8.33 % 13. Monatslohn</span><span className="tabular-nums">{fmtCHF(lohn.slZuschlaege.dreizehnter)}</span></div>
                          <div className="flex justify-between font-medium text-foreground"><span>Total inkl. allem</span><span className="tabular-nums">{fmtCHF(lohn.slZuschlaege.total)} {einheitLabel}</span></div>
                        </div>
                      )}
                      {lohn.mindestlohn != null && (
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-muted-foreground">
                            L-GAV-Mindestlohn{einfuehrungszeit ? ' (−8 % Einführung)' : ''}: {fmtCHF(rundeLohn(lohn.mindestlohn))} {einheitLabel}
                          </span>
                          <StatusPill tone={lohn.unterMindestlohn ? 'critical' : 'good'}>
                            {lohn.unterMindestlohn ? 'Unter Mindestlohn' : 'Mindestlohn eingehalten'}
                          </StatusPill>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">Noch kein Lohn berechnet.</p>
                  )}
                  {lohn.hinweis && <p className="text-xs text-amber-700 dark:text-amber-400">{lohn.hinweis}</p>}
                  {lohn.blockierend && (
                    <HintBox tone="critical" title="Einladung blockiert">
                      Der Lohn liegt unter dem L-GAV-Mindestlohn.
                    </HintBox>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Aktionen ── */}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={saveDraft} disabled={saving || preMigration} data-testid="button-save-draft">
              <Save className="mr-1.5 h-4 w-4" /> Als Entwurf speichern
            </Button>
            <Button onClick={createInvitation} disabled={saving || preMigration || (lohn?.blockierend ?? false)}
              data-testid="button-create-invite">
              <Send className="mr-1.5 h-4 w-4" /> Einladung an Mitarbeiter erstellen
            </Button>
          </div>
        </div>
      )}

      <InviteLinkDialog
        open={inviteUrl != null}
        link={inviteUrl}
        onClose={() => { setInviteUrl(null); navigate('/personaleintritt'); }}
      />
    </PageShell>
  );
}
