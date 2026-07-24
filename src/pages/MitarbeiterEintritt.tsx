/**
 * MitarbeiterEintritt — Phase 2: Mitarbeiter füllt seine Daten aus
 * ================================================================
 * Öffentliche Route /e/:token (KEIN Login). Der Token ist die einzige
 * Berechtigung; alle Zugriffe laufen über die Edge Function
 * personaleintritt-public (kein direkter Tabellenzugriff, RLS bleibt zu).
 *
 * Mobil-first: eine Spalte, grosse Eingabefelder, Kamera-Uploads
 * (accept + capture), Zwischenspeichern + Absenden (⇒ status ausgefuellt).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Camera, Check, ClipboardList, Loader2, Plus, Save, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HintBox } from '@/components/ui/hint-box';
import { LoadingState } from '@/components/ui/page-states';
import {
  publicGet, publicSave, publicSubmit, publicUpload, type PublicEckdaten,
} from '@/lib/personaleintritt/public-api';
import {
  MA_DOKUMENT_TYPEN,
  type MaDaten, type MaDokumentTyp, type MaKind,
} from '@/lib/personaleintritt/types';
import { formatAhv, formatIban, pruefePflichtfelder } from '@/lib/personaleintritt/validation';
import { zemisPflicht } from '@/lib/personaleintritt/behoerden-meldung';

const ZIVILSTAENDE = ['ledig', 'verheiratet', 'geschieden', 'verwitwet', 'eingetragene Partnerschaft'];
const AUSWEISARTEN = ['ID', 'Pass', 'Ausländerausweis'];
// S/F lösen die Arbeitsbewilligungs-Pflicht aus (behoerden-meldung.ts, Anpassung 5)
const BEWILLIGUNGEN = ['CH (Schweizer/in)', 'C', 'B', 'L', 'G', 'N', 'S', 'F', 'andere'];

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('de-CH');
}

export default function MitarbeiterEintritt() {
  const { token = '' } = useParams<{ token: string }>();

  const [phase, setPhase] = useState<'loading' | 'invalid' | 'expired' | 'submitted' | 'form'>('loading');
  const [record, setRecord] = useState<PublicEckdaten | null>(null);
  const [maDaten, setMaDaten] = useState<MaDaten>({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<MaDokumentTyp | null>(null);
  const [fehlerListe, setFehlerListe] = useState<string[]>([]);
  const fileInputs = useRef<Partial<Record<MaDokumentTyp, HTMLInputElement | null>>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await publicGet(token);
      if (cancelled) return;
      if (res.kind === 'ok') {
        setRecord(res.record);
        setMaDaten(res.record.maDaten ?? {});
        setPhase('form');
      } else if (res.kind === 'submitted') {
        setPhase('submitted');
      } else if (res.kind === 'expired') {
        setPhase('expired');
      } else if (res.kind === 'invalid') {
        setPhase('invalid');
      } else {
        toast.error(res.message);
        setPhase('invalid');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const setP = (patch: Partial<NonNullable<MaDaten['personalien']>>) =>
    setMaDaten(d => ({ ...d, personalien: { ...d.personalien, ...patch } }));
  const setV = (patch: Partial<NonNullable<MaDaten['vertrag']>>) =>
    setMaDaten(d => ({ ...d, vertrag: { ...d.vertrag, ...patch } }));
  const setL = (patch: Partial<NonNullable<MaDaten['lohnprogramm']>>) =>
    setMaDaten(d => ({ ...d, lohnprogramm: { ...d.lohnprogramm, ...patch } }));

  const p = maDaten.personalien ?? {};
  const v = maDaten.vertrag ?? {};
  const l = maDaten.lohnprogramm ?? {};
  const docs = maDaten.dokumente ?? {};
  const kinder = l.kinder ?? [];

  const ehepartnerNoetig = useMemo(() => {
    const z = (l.zivilstand ?? '').toLowerCase();
    return z === 'verheiratet' || z.includes('partnerschaft');
  }, [l.zivilstand]);

  const save = async (silent = false) => {
    setSaving(true);
    const res = await publicSave(token, maDaten);
    setSaving(false);
    if (res.ok) {
      if (!silent) toast.success('Zwischengespeichert — Sie können später weiterfahren.');
      return true;
    }
    if (res.alreadySubmitted) { setPhase('submitted'); return false; }
    if (res.expired) { setPhase('expired'); return false; }
    toast.error(res.error ?? 'Speichern fehlgeschlagen');
    return false;
  };

  const submit = async () => {
    if (!record?.vertragstyp) return;
    const fehler = pruefePflichtfelder(maDaten, record.vertragstyp);
    if (fehler.length > 0) {
      setFehlerListe(fehler.map(f => f.label));
      toast.error(`Es fehlen noch ${fehler.length} Angaben.`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setFehlerListe([]);
    setSaving(true);
    const res = await publicSubmit(token, maDaten);
    setSaving(false);
    if (res.ok) { setPhase('submitted'); return; }
    if (res.alreadySubmitted) { setPhase('submitted'); return; }
    if (res.expired) { setPhase('expired'); return; }
    toast.error(res.error ?? 'Absenden fehlgeschlagen');
  };

  const onUpload = async (typ: MaDokumentTyp, file: File | null) => {
    if (!file) return;
    setUploading(typ);
    const res = await publicUpload(token, typ, file);
    setUploading(null);
    if (res.ok && res.path) {
      setMaDaten(d => ({ ...d, dokumente: { ...d.dokumente, [typ]: res.path } }));
      toast.success('Hochgeladen');
    } else if (res.alreadySubmitted) {
      setPhase('submitted');
    } else if (res.expired) {
      setPhase('expired');
    } else {
      toast.error(res.error ?? 'Upload fehlgeschlagen');
    }
  };

  // ── Sonderzustände ─────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return <div className="mx-auto max-w-lg px-4 py-10"><LoadingState label="Lade Ihre Daten…" /></div>;
  }
  if (phase !== 'form') {
    const inhalt = phase === 'submitted' ? (
      <HintBox tone="good" title="Vielen Dank!">
        Ihre Angaben wurden übermittelt. Das Team meldet sich bei Ihnen —
        Sie müssen nichts weiter tun.
      </HintBox>
    ) : phase === 'expired' ? (
      <HintBox tone="warn" title="Link abgelaufen">
        Dieser Einladungslink ist nicht mehr gültig. Bitte melden Sie sich bei
        Ihrer Ansprechperson im Betrieb — sie kann Ihnen einen neuen Link senden.
      </HintBox>
    ) : (
      <HintBox tone="critical" title="Link ungültig">
        Dieser Link ist nicht (mehr) gültig. Bitte prüfen Sie, ob er vollständig
        kopiert wurde, oder melden Sie sich bei Ihrer Ansprechperson im Betrieb.
      </HintBox>
    );
    return <div className="mx-auto max-w-lg px-4 py-10">{inhalt}</div>;
  }

  // ── Formular ───────────────────────────────────────────────────────────────
  const field = (id: string, label: string, value: string, onChange: (s: string) => void,
    opts?: { type?: string; placeholder?: string; onBlur?: () => void; required?: boolean }) => (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}{opts?.required !== false ? ' *' : ''}</Label>
      <Input id={id} type={opts?.type ?? 'text'} value={value} placeholder={opts?.placeholder}
        onChange={e => onChange(e.target.value)} onBlur={opts?.onBlur}
        data-testid={`input-${id}`} className="h-11" />
    </div>
  );

  return (
    <div className="min-h-screen bg-background pb-28">
      <header className="border-b bg-card px-4 py-3">
        <div className="mx-auto flex max-w-lg items-center gap-2">
          <ClipboardList className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-base font-semibold">Ihre Angaben zum Stellenantritt</h1>
            <p className="text-xs text-muted-foreground">{record?.betrieb ?? ''}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-lg space-y-4 px-4 py-4">
        {fehlerListe.length > 0 && (
          <HintBox tone="critical" title={`Es fehlen noch ${fehlerListe.length} Angaben`}>
            <ul className="list-disc pl-4">
              {fehlerListe.slice(0, 8).map(f => <li key={f}>{f}</li>)}
              {fehlerListe.length > 8 && <li>… und {fehlerListe.length - 8} weitere</li>}
            </ul>
          </HintBox>
        )}

        {/* Eckdaten (read-only) */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Ihre Stelle</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <span className="text-muted-foreground">Funktion</span><span className="font-medium">{record?.funktion ?? '—'}</span>
            <span className="text-muted-foreground">Vertrag</span>
            <span className="font-medium">{record?.vertragstyp === 'SL' ? 'Stundenlohn' : record?.vertragstyp === 'ML' ? 'Monatslohn' : '—'}</span>
            <span className="text-muted-foreground">Eintritt</span><span className="font-medium">{fmtDate(record?.eintritt)}</span>
            {record?.vertragstyp === 'ML' && (
              <><span className="text-muted-foreground">Pensum</span><span className="font-medium">{record?.pensumProzent ?? '—'} %</span></>
            )}
          </CardContent>
        </Card>

        {/* Personalien */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Personalien</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label>Anrede *</Label>
              <Select value={p.anrede ?? ''} onValueChange={val => setP({ anrede: val })}>
                <SelectTrigger className="h-11" data-testid="select-anrede"><SelectValue placeholder="Wählen…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Frau">Frau</SelectItem>
                  <SelectItem value="Herr">Herr</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {field('vorname', 'Vorname', p.vorname ?? '', s => setP({ vorname: s }))}
              {field('name', 'Name', p.name ?? '', s => setP({ name: s }))}
            </div>
            {field('strasse', 'Strasse / Nr.', p.strasse ?? '', s => setP({ strasse: s }))}
            <div className="grid grid-cols-[1fr_2fr] gap-3">
              {field('plz', 'PLZ', p.plz ?? '', s => setP({ plz: s }), { type: 'text' })}
              {field('ort', 'Ort', p.ort ?? '', s => setP({ ort: s }))}
            </div>
            {field('geburtsdatum', 'Geburtsdatum', p.geburtsdatum ?? '', s => setP({ geburtsdatum: s }), { type: 'date' })}
            {field('heimatort', 'Heimatort / Nationalität', p.heimatort_nationalitaet ?? '', s => setP({ heimatort_nationalitaet: s }))}
            {field('telefon', 'Telefon (Mobile)', p.telefon ?? '', s => setP({ telefon: s }), { type: 'tel', placeholder: '079 …' })}
            {field('email', 'E-Mail', p.email ?? '', s => setP({ email: s }), { type: 'email' })}
          </CardContent>
        </Card>

        {/* Vertrag (nur ML: Wochenstunden) */}
        {record?.vertragstyp === 'ML' && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Arbeitszeit</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-1">
                <Label htmlFor="wochenstunden">Wochenstunden *</Label>
                <Input id="wochenstunden" type="number" min="1" max="50" step="0.5" className="h-11"
                  value={v.wochenstunden ?? ''} data-testid="input-wochenstunden"
                  placeholder={record?.pensumProzent ? String(Math.round(42 * record.pensumProzent) / 100) : '42'}
                  onChange={e => setV({ wochenstunden: e.target.value === '' ? undefined : Number(e.target.value) })} />
                <p className="text-xs text-muted-foreground">Vollzeit im Betrieb = 42 Std./Woche.</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Lohnprogramm */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Angaben für die Lohnabrechnung</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label>Zivilstand *</Label>
              <Select value={l.zivilstand ?? ''} onValueChange={val => setL({ zivilstand: val })}>
                <SelectTrigger className="h-11" data-testid="select-zivilstand"><SelectValue placeholder="Wählen…" /></SelectTrigger>
                <SelectContent>
                  {ZIVILSTAENDE.map(z => <SelectItem key={z} value={z}>{z}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {field('ahv', 'AHV-Nummer', l.ahv_nr ?? '', s => setL({ ahv_nr: s }),
              { placeholder: '756.____.____.__', onBlur: () => l.ahv_nr && setL({ ahv_nr: formatAhv(l.ahv_nr) }) })}
            {field('iban', 'IBAN', l.iban ?? '', s => setL({ iban: s }),
              { placeholder: 'CH__ ____ ____ ____ ____ _', onBlur: () => l.iban && setL({ iban: formatIban(l.iban) }) })}
            {field('bank', 'Bank', l.bank ?? '', s => setL({ bank: s }), { required: false, placeholder: 'z. B. Raiffeisen' })}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Ausweisart *</Label>
                <Select value={l.ausweisart ?? ''} onValueChange={val => setL({ ausweisart: val })}>
                  <SelectTrigger className="h-11" data-testid="select-ausweisart"><SelectValue placeholder="Wählen…" /></SelectTrigger>
                  <SelectContent>
                    {AUSWEISARTEN.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {field('ausweisnr', 'Ausweis-Nr.', l.ausweis_nr ?? '', s => setL({ ausweis_nr: s }))}
            </div>
            <div className="space-y-1">
              <Label>Aufenthaltsbewilligung *</Label>
              <Select value={l.aufenthaltsbewilligung ?? ''} onValueChange={val => setL({ aufenthaltsbewilligung: val })}>
                <SelectTrigger className="h-11" data-testid="select-bewilligung"><SelectValue placeholder="Wählen…" /></SelectTrigger>
                <SelectContent>
                  {BEWILLIGUNGEN.map(b => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {zemisPflicht(l.aufenthaltsbewilligung) && (
              <div className="space-y-1">
                <Label htmlFor="me-zemis">ZEMIS-Nr. *</Label>
                <Input id="me-zemis" className="h-11" value={l.zemis_nr ?? ''}
                  onChange={e => setL({ zemis_nr: e.target.value })}
                  placeholder="z. B. 12345678.9" data-testid="input-zemis" />
                <p className="text-xs text-muted-foreground">
                  Bei Ausweis F, S oder B erforderlich (steht auf dem Ausweis).
                </p>
              </div>
            )}
            {field('konfession', 'Konfession', l.konfession ?? '', s => setL({ konfession: s }), { required: false })}

            {ehepartnerNoetig && (
              <div className="space-y-3 rounded-lg border p-3">
                <p className="text-sm font-medium">Ehepartner/in</p>
                {field('ehepartner-name', 'Name, Vorname', l.ehepartner?.name ?? '',
                  s => setL({ ehepartner: { ...l.ehepartner, name: s } }))}
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={l.ehepartner?.erwerbstaetig ?? false}
                    onCheckedChange={c => setL({ ehepartner: { ...l.ehepartner, erwerbstaetig: c === true } })}
                    data-testid="checkbox-ehepartner-erwerb" />
                  Ehepartner/in ist erwerbstätig
                </label>
              </div>
            )}

            {/* Kinder */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Kinder (Familienzulagen)</Label>
                <Button type="button" size="sm" variant="outline" data-testid="button-add-kind"
                  onClick={() => setL({ kinder: [...kinder, {}] })}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Kind
                </Button>
              </div>
              {kinder.length === 0 && (
                <p className="text-xs text-muted-foreground">Keine Kinder erfasst.</p>
              )}
              {kinder.map((kind: MaKind, i: number) => (
                <div key={i} className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">Kind {i + 1}</p>
                    <Button type="button" size="sm" variant="ghost" data-testid={`button-remove-kind-${i}`}
                      onClick={() => setL({ kinder: kinder.filter((_, j) => j !== i) })}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                  {field(`kind-${i}-name`, 'Name, Vorname', kind.name ?? '',
                    s => setL({ kinder: kinder.map((k, j) => j === i ? { ...k, name: s } : k) }))}
                  {field(`kind-${i}-geb`, 'Geburtsdatum', kind.geburtsdatum ?? '',
                    s => setL({ kinder: kinder.map((k, j) => j === i ? { ...k, geburtsdatum: s } : k) }), { type: 'date' })}
                  {field(`kind-${i}-zulage`, 'Familienzulage bezogen bei', kind.familienzulage_bei ?? '',
                    s => setL({ kinder: kinder.map((k, j) => j === i ? { ...k, familienzulage_bei: s } : k) }),
                    { required: false, placeholder: 'z. B. Arbeitgeber Mutter' })}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Dokumente */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Dokumente fotografieren oder hochladen</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {MA_DOKUMENT_TYPEN.map(({ typ, label, pflicht }) => {
              const done = Boolean(docs[typ]);
              return (
                <div key={typ} className="flex items-center justify-between gap-2 rounded-lg border p-2.5">
                  <div className="flex items-center gap-2">
                    {done
                      ? <Check className="h-4 w-4 text-green-600" />
                      : <Camera className="h-4 w-4 text-muted-foreground" />}
                    <span className="text-sm">{label}{pflicht ? ' *' : ''}</span>
                  </div>
                  <input
                    ref={el => { fileInputs.current[typ] = el; }}
                    type="file"
                    accept="image/*,application/pdf"
                    capture="environment"
                    className="hidden"
                    onChange={e => {
                      void onUpload(typ, e.target.files?.[0] ?? null);
                      e.target.value = '';
                    }}
                    data-testid={`input-file-${typ}`}
                  />
                  <Button type="button" size="sm" variant={done ? 'ghost' : 'outline'}
                    disabled={uploading != null}
                    onClick={() => fileInputs.current[typ]?.click()}
                    data-testid={`button-upload-${typ}`}>
                    {uploading === typ
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : done ? 'Ersetzen' : 'Aufnehmen'}
                  </Button>
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">
              Mit * markierte Dokumente sind für das Absenden erforderlich.
            </p>
          </CardContent>
        </Card>
      </main>

      {/* Sticky-Aktionsleiste */}
      <div className="fixed inset-x-0 bottom-0 border-t bg-card p-3">
        <div className="mx-auto flex max-w-lg gap-2">
          <Button variant="outline" className="h-11 flex-1" disabled={saving}
            onClick={() => void save()} data-testid="button-save-progress">
            <Save className="mr-1.5 h-4 w-4" /> Zwischenspeichern
          </Button>
          <Button className="h-11 flex-1" disabled={saving}
            onClick={() => void submit()} data-testid="button-submit">
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}
            Absenden
          </Button>
        </div>
      </div>
    </div>
  );
}
