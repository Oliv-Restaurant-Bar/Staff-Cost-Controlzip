/**
 * Personaleintritt — Phase 1: GF erfasst Eckdaten (mobil-first)
 * =============================================================
 * Route /personaleintritt/neu — Gate: (Admin && !Gast) oder beaulieu_manager
 * (Route-Guard UND Lade-Effekt, Muster admin-write-gate).
 *
 * Lohn: 3 Modi transparent (Grundlohn / L-GAV-Mindestlohn / Ziel-Total);
 * Berechnung + Mindestlohn-Prüfung zentral in lib/personaleintritt/lohn.ts.
 * (Der öffentliche Einladungslink-Flow /e/:token wurde entfernt — Personalien
 * werden eingeloggt im Detail erfasst; hier gibt es nur noch den Entwurf.)
 *
 * Pre-migration-tolerant: fehlen die Tabellen (Migration 20260724 noch nicht
 * ausgeführt), erscheint eine HintBox statt eines Crashs.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, UserPlus } from 'lucide-react';
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
import { usePermissions } from '@/hooks/usePermissions';
import { useAuth } from '@/hooks/useAuth';
import { useTenant } from '@/contexts/TenantContext';
import { createPersonaleintritt, loadBetriebe, loadLgavMindestloehne } from '@/lib/personaleintritt/db';
import {
  berechneLohn, mindestlohnJahr, rundeLohn, type MindestlohnEintrag,
} from '@/lib/personaleintritt/lohn';
import {
  LOHNKLASSEN, LOHNKLASSE_LABELS,
  type LohnModus, type Lohnklasse, type Vertragstyp,
} from '@/lib/personaleintritt/types';
import { FUNKTIONEN } from '@/lib/funktionen';
import {
  LEGACY_BETRIEB_ID_PREFIX, betriebAnzeigename, betriebFromLegacyConfig,
  type BetriebRecord,
} from '@/lib/personaleintritt/betriebs-config';

/** Probezeit-Auswahl (L-GAV: 1 Monat gesetzlich, per Abrede bis max. 3 Monate; «Keine» = 0). */
const PROBEZEIT_OPTIONEN = [
  { tage: 0, label: 'Keine' },
  { tage: 30, label: '1 Monat' },
  { tage: 60, label: '2 Monate' },
  { tage: 90, label: '3 Monate' },
] as const;

/** Pensum-Schnellwahl in 10er-Schritten (Standard 100 %). */
const PENSUM_SCHRITTE = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

const fmtCHF = (v: number) =>
  v.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MODUS_LABELS: Record<LohnModus, string> = {
  grundlohn: 'Grundlohn direkt',
  mindestlohn: 'L-GAV-Mindestlohn',
  zieltotal: 'Ziel-Total inkl. allem',
};

export default function PersonaleintrittNeu() {
  const navigate = useNavigate();
  const { isAdmin, isBeaulieuManager } = usePermissions();
  const { user } = useAuth();
  const { tenantId, setTenant } = useTenant();
  const canManage = isAdmin || isBeaulieuManager;

  // ── Mindestlohn-Tabelle laden (gated, read-only) ──────────────────────────
  const [minLoehne, setMinLoehne] = useState<MindestlohnEintrag[] | null>(null);
  const [preMigration, setPreMigration] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Betriebe laden (Migration 20260724f; pre-migration: Legacy-Fallback) ──
  const [betriebe, setBetriebe] = useState<BetriebRecord[]>([]);
  const [betriebeError, setBetriebeError] = useState<string | null>(null);

  useEffect(() => {
    if (!canManage) return; // Lade-Effekt ebenfalls gaten (feuert vor Redirect)
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [res, resBet] = await Promise.all([loadLgavMindestloehne(), loadBetriebe()]);
      if (cancelled) return;
      setPreMigration(res.preMigration);
      setLoadError(res.error);
      setMinLoehne(res.data ?? []);
      if (resBet.data) {
        setBetriebe(resBet.data.filter(b => b.aktiv));
        setBetriebeError(null);
      } else if (resBet.preMigration) {
        // EINZIGER pre-migration-Fallback: die zwei Legacy-Betriebe.
        setBetriebe([betriebFromLegacyConfig('oliv'), betriebFromLegacyConfig('beaulieu')]);
        setBetriebeError(null);
      } else {
        setBetriebe([]);
        setBetriebeError(resBet.error ?? 'Betriebe konnten nicht geladen werden.');
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [canManage]);

  // ── Formular-State ────────────────────────────────────────────────────────
  const [vertragstyp, setVertragstyp] = useState<Vertragstyp | null>(null);
  /** Betriebswahl (Punkt 8): gewählter Betrieb-Datensatz; beaulieu_manager ist tenant-locked. */
  const [betriebSelId, setBetriebSelId] = useState<string>('');

  /** beaulieu_manager sieht nur den an «beaulieu» gekoppelten Betrieb. */
  const waehlbareBetriebe = useMemo(
    () => (isBeaulieuManager ? betriebe.filter(b => b.sccTenant === 'beaulieu') : betriebe),
    [betriebe, isBeaulieuManager],
  );

  // Default-Auswahl: Betrieb des aktiv gewählten Restaurants (SCC-Umschalter,
  // bzw. beaulieu für den tenant-gesperrten Manager). Folgt einem Mandanten-
  // Wechsel; eine manuelle (Dritt-)Betriebswahl bleibt bestehen, solange der
  // Mandant unverändert ist.
  const appliedTenantRef = useRef<string | null>(null);
  useEffect(() => {
    if (waehlbareBetriebe.length === 0) return;
    const zielTenant = isBeaulieuManager ? 'beaulieu' : tenantId;
    const tenantChanged = appliedTenantRef.current !== zielTenant;
    appliedTenantRef.current = zielTenant;
    setBetriebSelId(prev => {
      const prevGueltig = prev !== '' && waehlbareBetriebe.some(b => b.id === prev);
      if (!tenantChanged && prevGueltig) return prev;
      const match = waehlbareBetriebe.find(b => b.sccTenant === zielTenant);
      if (match) return match.id;
      return prevGueltig ? prev : waehlbareBetriebe[0].id;
    });
  }, [waehlbareBetriebe, isBeaulieuManager, tenantId]);

  const betrieb = useMemo(
    () => waehlbareBetriebe.find(b => b.id === betriebSelId) ?? null,
    [waehlbareBetriebe, betriebSelId],
  );
  /** Heimat-Mandant des Datensatzes: SCC-Tenant des Betriebs, Dritt-Betriebe erben den aktiven Mandanten. */
  const zielTenantId = betrieb?.sccTenant ?? tenantId;
  const [funktion, setFunktion] = useState('');
  const [eintritt, setEintritt] = useState('');
  const [pensum, setPensum] = useState('100');
  const [probezeit, setProbezeit] = useState('90');
  const [vertragsdauer, setVertragsdauer] = useState<'unbefristet' | 'befristet'>('unbefristet');
  const [befristetBis, setBefristetBis] = useState('');
  const [lohnModus, setLohnModus] = useState<LohnModus>('grundlohn');
  // Default Ia (ohne Berufslehre) — häufigster Fall; für die Mindestlohn-Prüfung anpassbar.
  const [lohnklasse, setLohnklasse] = useState<Lohnklasse | ''>('Ia');
  const [grundlohn, setGrundlohn] = useState('');
  const [grundlohnInkl13, setGrundlohnInkl13] = useState(false);
  const [zielTotal, setZielTotal] = useState('');
  const [einfuehrungszeit, setEinfuehrungszeit] = useState(false);
  // Bewilligungs-Mehrfachauswahl (Punkt 4) — ersetzt die alte Ja/Nein-Frage:
  const [bewAusweisF, setBewAusweisF] = useState(false);
  const [bewAusweisS, setBewAusweisS] = useState(false);
  const [bewArbeitsbewilligung, setBewArbeitsbewilligung] = useState(false);
  const [saving, setSaving] = useState(false);

  const lohn = useMemo(() => {
    if (!vertragstyp) return null;
    return berechneLohn({
      vertragstyp,
      modus: lohnModus,
      grundlohn: grundlohn ? Number(grundlohn) : undefined,
      grundlohnInkl13,
      zielTotal: zielTotal ? Number(zielTotal) : undefined,
      lohnklasse: lohnklasse || undefined,
      einfuehrungszeit,
      jahr: mindestlohnJahr(eintritt || undefined),
      mindestloehne: minLoehne ?? [],
      wochenstundenModell: betrieb?.wochenstundenModell ?? 42,
    });
  }, [vertragstyp, lohnModus, grundlohn, grundlohnInkl13, zielTotal, lohnklasse, einfuehrungszeit, eintritt, minLoehne, betrieb]);

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

  const buildPatch = (status: 'entwurf') => ({
    status,
    vertragstyp: vertragstyp ?? undefined,
    betrieb: betrieb ? betriebAnzeigename(betrieb) : undefined,
    // FK nur setzen, wenn ein ECHTER Betrieb-Datensatz gewählt ist — synthetische
    // Legacy-Fallback-IDs dürfen NIE in betrieb_id persistiert werden (42703-tolerant).
    ...(betrieb && !betrieb.id.startsWith(LEGACY_BETRIEB_ID_PREFIX)
      ? { betriebId: betrieb.id } : {}),
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
    // Spalten aus Migrationen 20260724b/c: nur bei aktivem Wert mitschicken —
    // pre-migration bleibt der Standardfall (false) so weiter speicherbar (42703).
    ...(lohnModus === 'grundlohn' && vertragstyp === 'ML' && grundlohnInkl13
      ? { grundlohnInkl13: true } : {}),
    ...(bewAusweisF ? { bewilligungAusweisF: true } : {}),
    ...(bewAusweisS ? { bewilligungAusweisS: true } : {}),
    ...(bewArbeitsbewilligung ? { bewilligungArbeitsbewilligung: true } : {}),
  });

  /** Nach dem Speichern: Hinweis, wenn der Datensatz in einem anderen Mandanten liegt als der aktive. */
  const hinweisBeiMandantAbweichung = () => {
    if (zielTenantId === tenantId) return;
    toast.info(`Der Eintritt wurde im Betrieb «${betrieb ? betriebAnzeigename(betrieb) : zielTenantId}» angelegt.`, {
      description: 'Die Übersicht zeigt den aktiven Mandanten — zum Anzeigen wechseln.',
      action: { label: 'Wechseln', onClick: () => setTenant(zielTenantId) },
    });
  };

  const saveDraft = async () => {
    if (!betrieb) { toast.error('Bitte zuerst einen Betrieb wählen.'); return; }
    setSaving(true);
    // created_by ist eine uuid-Spalte: IMMER die Auth-User-UUID, nie die E-Mail.
    const res = await createPersonaleintritt(zielTenantId, buildPatch('entwurf'), user?.id);
    setSaving(false);
    if (res.preMigration) { setPreMigration(true); return; }
    if (res.error || !res.data) { toast.error(`Speichern fehlgeschlagen: ${res.error}`); return; }
    toast.success('Entwurf gespeichert');
    hinweisBeiMandantAbweichung();
    navigate('/personaleintritt');
  };

  return (
    <PageShell
      width="narrow"
      header={
        <PageHeader
          icon={<UserPlus />}
          title="Neuer Personaleintritt"
          info="Eckdaten als Entwurf erfassen. Personalien werden anschliessend eingeloggt in der Detailansicht ergänzt."
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
      {betriebeError && (
        <HintBox tone="critical" title="Betriebe konnten nicht geladen werden">
          {betriebeError} — ohne Betrieb kann kein Eintritt erfasst werden. Seite neu laden oder später erneut versuchen.
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
                <Label>Betrieb *</Label>
                <Select
                  value={betriebSelId}
                  onValueChange={setBetriebSelId}
                  disabled={isBeaulieuManager || waehlbareBetriebe.length === 0}
                >
                  <SelectTrigger data-testid="select-betrieb">
                    <SelectValue placeholder={waehlbareBetriebe.length === 0 ? 'Keine Betriebe verfügbar' : 'Wählen…'} />
                  </SelectTrigger>
                  <SelectContent>
                    {waehlbareBetriebe.map(b => (
                      <SelectItem key={b.id} value={b.id}>{betriebAnzeigename(b)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Vertrag, Meldung und Personalstamm-Übernahme landen in diesem Betrieb.
                </p>
              </div>
              <div className="space-y-1">
                <Label>Funktion *</Label>
                <Select value={funktion} onValueChange={setFunktion}>
                  <SelectTrigger data-testid="select-funktion"><SelectValue placeholder="Wählen…" /></SelectTrigger>
                  <SelectContent>
                    {FUNKTIONEN.map(f => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pe-eintritt">Eintritt (Beginn) *</Label>
                <Input id="pe-eintritt" type="date" value={eintritt} onChange={e => setEintritt(e.target.value)} data-testid="input-eintritt" />
              </div>
              {vertragstyp === 'ML' && (
                <div className="space-y-1">
                  <Label>Pensum % *</Label>
                  <Select value={pensum} onValueChange={setPensum}>
                    <SelectTrigger data-testid="select-pensum">
                      <SelectValue placeholder="Wahl…" />
                    </SelectTrigger>
                    <SelectContent>
                      {PENSUM_SCHRITTE.map(s => (
                        <SelectItem key={s} value={String(s)}>{s} %</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Schnellwahl in 10-%-Schritten (Standard 100 %).</p>
                </div>
              )}
              <div className="space-y-1">
                <Label>Probezeit</Label>
                <Select value={probezeit} onValueChange={setProbezeit}>
                  <SelectTrigger data-testid="select-probezeit"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROBEZEIT_OPTIONEN.map(o => (
                      <SelectItem key={o.tage} value={String(o.tage)}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">L-GAV: 1 Monat gesetzlich, per Abrede bis max. 3 Monate.</p>
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
              <div className="space-y-2 sm:col-span-2">
                <Label>Arbeitsbewilligung (Mehrfachauswahl)</Label>
                <div className="flex flex-col gap-2">
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox checked={bewAusweisF} onCheckedChange={c => setBewAusweisF(c === true)}
                      data-testid="checkbox-bewilligung-f" className="mt-0.5" />
                    <span>Ausweis F (vorläufig aufgenommen) — löst die Behörden-Meldung (SEM) aus</span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox checked={bewAusweisS} onCheckedChange={c => setBewAusweisS(c === true)}
                      data-testid="checkbox-bewilligung-s" className="mt-0.5" />
                    <span>Ausweis S (Schutzstatus) — löst die Behörden-Meldung (SEM) aus</span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox checked={bewArbeitsbewilligung} onCheckedChange={c => setBewArbeitsbewilligung(c === true)}
                      data-testid="checkbox-bewilligung-arbeitsbewilligung" className="mt-0.5" />
                    <span>Arbeitsbewilligung nötig (übrige Fälle, z.&nbsp;B. Ausweis N) — ohne SEM-Formular</span>
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Wird zusätzlich automatisch angenommen, wenn der Mitarbeiter in Phase 2 Ausweis S/F/N angibt.
                  Jede Auswahl setzt den Gültigkeits-Zusatz im Vertrag; die Meldung löst das Backoffice
                  später auf der Detailseite aus.
                </p>
              </div>
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
                    {vertragstyp === 'ML' && (
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        {([false, true] as const).map(inkl => (
                          <button
                            key={String(inkl)}
                            type="button"
                            onClick={() => setGrundlohnInkl13(inkl)}
                            data-testid={`button-grundlohn-${inkl ? 'inkl13' : 'ohne13'}`}
                            className={`rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                              grundlohnInkl13 === inkl ? 'border-primary bg-primary/5 font-medium' : 'border-border hover:border-muted-foreground/40'
                            }`}
                          >
                            {inkl ? 'inkl. 13. Monatslohn' : 'ohne 13. (Standard)'}
                          </button>
                        ))}
                        <p className="col-span-2 text-xs text-muted-foreground">
                          {grundlohnInkl13
                            ? 'Eingabe enthält den 13. bereits — Basislohn = Eingabe × 12⁄13.'
                            : 'Eingabe = Monats-Basislohn; der 13. wird zusätzlich ausbezahlt.'}
                        </p>
                      </div>
                    )}
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
                    <HintBox tone="critical" title="Unter Mindestlohn">
                      Der Lohn liegt unter dem L-GAV-Mindestlohn.
                    </HintBox>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Aktionen ── */}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button onClick={saveDraft} disabled={saving || preMigration} data-testid="button-save-draft">
              <Save className="mr-1.5 h-4 w-4" /> Als Entwurf speichern
            </Button>
          </div>
        </div>
      )}
    </PageShell>
  );
}
