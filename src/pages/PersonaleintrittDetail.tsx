/**
 * Personaleintritt — Detailansicht (Backoffice/GF)
 * ================================================
 * Route /personaleintritt/:id — Gate: (Admin && !Gast) oder beaulieu_manager.
 * Zeigt Eckdaten + alle vom Mitarbeiter erfassten Daten (Phase 2), Dokumente
 * über signierte URLs; Aktionen: Als geprüft markieren · Vertrag (PDF)
 * erstellen (editierbar + flach in den privaten Bucket) · Übernahme in den
 * Personalstamm (dokumentierte 2. sanktionierte employees-Schreibstelle) ·
 * Abbrechen. Skribble ist vorbereitet, aber deaktiviert.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, FileSpreadsheet, FileText, PenLine, ShieldAlert, UserCheck, XCircle } from 'lucide-react';
import { toast } from 'sonner';

import { PageShell } from '@/components/layout/PageShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { HintBox } from '@/components/ui/hint-box';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusPill } from '@/components/ui/status-pill';
import { LoadingState } from '@/components/ui/page-states';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { STATUS_TONES } from '@/components/personaleintritt/status-tone';
import { usePermissions } from '@/hooks/usePermissions';
import { useAuth } from '@/hooks/useAuth';
import { useTenant } from '@/contexts/TenantContext';
import {
  getDokumentUrl, loadPersonaleintritt, updatePersonaleintritt, uploadDokument,
} from '@/lib/personaleintritt/db';
import {
  LOHNKLASSE_LABELS, MA_DOKUMENT_TYPEN, STATUS_LABELS,
  type PersonaleintrittRecord, type PersonaleintrittStatus,
} from '@/lib/personaleintritt/types';
import { erzeugeVertragsPdf } from '@/lib/personaleintritt/pdf-fill';
import {
  bewilligungErforderlichEffektiv, buildBehoerdenGesuch, istBewilligungspflichtigerAusweis,
} from '@/lib/personaleintritt/behoerden-meldung';
import { erzeugeMirusExcel } from '@/lib/personaleintritt/mirus-export';
import { buildEmployeeFromEintritt, findeNamensDuplikate } from '@/lib/personaleintritt/uebernahme';
import { loadEmployees, loadAllBeaulieuIds, upsertEmployee } from '@/lib/supabase-db';
import type { Department, Employee } from '@/types/personnel';

// ─── Anzeige-Helfer ──────────────────────────────────────────────────────────

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('de-CH');
}

function fmtChf(wert: number | undefined | null): string {
  if (wert == null) return '—';
  return wert.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Row({ label, value, testId }: { label: string; value: React.ReactNode; testId?: string }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium" data-testid={testId}>{value ?? '—'}</span>
    </div>
  );
}

const PDF_ERLAUBT: PersonaleintrittStatus[] = ['geprueft', 'vertrag_gesendet', 'unterzeichnet'];
const UEBERNAHME_ERLAUBT: PersonaleintrittStatus[] = ['geprueft', 'vertrag_gesendet', 'unterzeichnet'];
const MIRUS_ERLAUBT: PersonaleintrittStatus[] = ['geprueft', 'vertrag_gesendet', 'unterzeichnet', 'uebernommen'];

export default function PersonaleintrittDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isAdmin, isGuest, isBeaulieuManager } = usePermissions();
  const { user } = useAuth();
  const { tenantId } = useTenant();
  const canManage = (isAdmin && !isGuest) || isBeaulieuManager;

  const [record, setRecord] = useState<PersonaleintrittRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [preMigration, setPreMigration] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [pdfWarnungen, setPdfWarnungen] = useState<string[]>([]);
  const [mirusHinweise, setMirusHinweise] = useState<string[]>([]);
  const [cancelOpen, setCancelOpen] = useState(false);

  // Übernahme-Dialog
  const [uebOpen, setUebOpen] = useState(false);
  const [uebDepartment, setUebDepartment] = useState<Department | ''>('');
  const [uebEmployees, setUebEmployees] = useState<Employee[] | null>(null);
  const [uebBeaulieuIds, setUebBeaulieuIds] = useState<string[]>([]);
  const [uebTrotzdem, setUebTrotzdem] = useState(false);

  const reload = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    // WICHTIG: Datensatz am Ladebeginn zurücksetzen (Seite wird bei :id-Wechsel
    // wiederverwendet — sonst kurzzeitig fremde Personendaten sichtbar).
    setRecord(null);
    setLoadError(null);
    try {
      const res = await loadPersonaleintritt(id, tenantId);
      setPreMigration(res.preMigration);
      setLoadError(res.error);
      setRecord(res.data);
    } catch (e) {
      setRecord(null);
      setLoadError(e instanceof Error ? e.message : 'Unbekannter Fehler');
    } finally {
      setLoading(false);
    }
  }, [id, tenantId]);

  useEffect(() => {
    if (!canManage || !id) return; // Lade-Effekt gaten (feuert vor Redirect)
    let cancelled = false;
    (async () => {
      setLoading(true);
      setRecord(null);
      setLoadError(null);
      try {
        const res = await loadPersonaleintritt(id, tenantId);
        if (cancelled) return;
        setPreMigration(res.preMigration);
        setLoadError(res.error);
        setRecord(res.data);
      } catch (e) {
        if (cancelled) return;
        setRecord(null);
        setLoadError(e instanceof Error ? e.message : 'Unbekannter Fehler');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canManage, id, tenantId]);

  if (!canManage) {
    return (
      <PageShell width="narrow">
        <HintBox tone="critical" title="Kein Zugriff">
          Diese Seite ist der Geschäftsführung vorbehalten.
        </HintBox>
      </PageShell>
    );
  }

  const p = record?.maDaten?.personalien;
  const v = record?.maDaten?.vertrag;
  const l = record?.maDaten?.lohnprogramm;
  const dok = record?.maDaten?.dokumente;
  const anzeigeName = [p?.vorname, p?.name].filter(Boolean).join(' ') || record?.funktion || 'Personaleintritt';

  // ── Aktionen ──────────────────────────────────────────────────────────────

  const markGeprueft = async () => {
    if (!record) return;
    setBusy(true);
    const res = await updatePersonaleintritt(record.id, tenantId, { status: 'geprueft' }, 'ausgefuellt');
    setBusy(false);
    if (res.error || !res.data) { toast.error(res.error ?? 'Fehler'); return; }
    setRecord(res.data);
    toast.success('Als geprüft markiert');
  };

  const createPdf = async () => {
    if (!record) return;
    setBusy(true);
    setPdfWarnungen([]);
    try {
      const { editierbar, flach, warnungen } = await erzeugeVertragsPdf(record);
      const basePath = `${tenantId}/${record.id}`;
      const editPath = await uploadDokument(`${basePath}/vertrag_editierbar.pdf`, new Blob([editierbar as BlobPart], { type: 'application/pdf' }), 'application/pdf');
      const flatPath = await uploadDokument(`${basePath}/vertrag.pdf`, new Blob([flach as BlobPart], { type: 'application/pdf' }), 'application/pdf');
      if (!editPath || !flatPath) {
        toast.error('Upload in den Dokumente-Bucket fehlgeschlagen — PDF wurde nicht gespeichert.');
        return;
      }
      const res = await updatePersonaleintritt(record.id, tenantId, { pdfPath: editPath, pdfFlatPath: flatPath });
      if (res.error || !res.data) { toast.error(res.error ?? 'Speichern fehlgeschlagen'); return; }
      setRecord(res.data);
      setPdfWarnungen(warnungen);
      toast.success('Vertrags-PDF erstellt (editierbar + flach)');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'PDF-Erstellung fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  const exportMirus = async () => {
    if (!record) return;
    setBusy(true);
    setMirusHinweise([]);
    try {
      const { bytes, dateiname, hinweise } = await erzeugeMirusExcel(record);
      const blob = new Blob([bytes as BlobPart], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      // Kopie in den privaten Bucket (Nachvollziehbarkeit) — Fehler nur als Hinweis,
      // der lokale Download funktioniert unabhängig davon.
      const path = await uploadDokument(`${tenantId}/${record.id}/mirus_export.xlsx`, blob, blob.type);
      if (path) {
        const res = await updatePersonaleintritt(record.id, tenantId, { mirusExportPath: path });
        if (res.data) setRecord(res.data);
      } else {
        toast.warning('Ablage im Dokumente-Bucket fehlgeschlagen — Datei wurde nur lokal heruntergeladen.');
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = dateiname;
      a.click();
      URL.revokeObjectURL(url);
      setMirusHinweise(hinweise);
      toast.success('MIRUS-Export erstellt');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'MIRUS-Export fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  const openDokument = async (path: string) => {
    const url = await getDokumentUrl(path);
    if (!url) { toast.error('Signierte URL konnte nicht erstellt werden.'); return; }
    window.open(url, '_blank', 'noopener');
  };

  // ── Behörden-Meldung (Arbeitsbewilligung, Backoffice-Aktion) ─────────────

  const meldungAusloesen = async () => {
    if (!record) return;
    const gesuch = buildBehoerdenGesuch(record);
    const blob = new Blob([gesuch.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = gesuch.dateiname;
    a.click();
    URL.revokeObjectURL(url);
    if (gesuch.fehlend.length > 0) {
      toast.warning(`Im Gesuch fehlen noch Angaben: ${gesuch.fehlend.join(', ')}`);
    }
    if (!record.behoerdeMeldungAm) {
      setBusy(true);
      const res = await updatePersonaleintritt(record.id, tenantId, {
        behoerdeMeldungAm: new Date().toISOString(),
        behoerdeMeldungVon: user?.email ?? user?.id ?? 'unbekannt',
      });
      setBusy(false);
      if (res.error || !res.data) {
        toast.error(`Gesuch heruntergeladen, aber der Auslöse-Vermerk konnte nicht gespeichert werden: ${res.error ?? 'unbekannter Fehler'}`);
        return;
      }
      setRecord(res.data);
      toast.success('Meldung an Behörde ausgelöst (Gesuch heruntergeladen)');
    }
  };

  const abbrechen = async () => {
    if (!record) return;
    setCancelOpen(false);
    const res = await updatePersonaleintritt(record.id, tenantId, { status: 'abgebrochen' });
    if (res.error || !res.data) { toast.error(res.error ?? 'Fehler'); return; }
    setRecord(res.data);
    toast.success('Eintritt abgebrochen');
  };

  // ── Übernahme ─────────────────────────────────────────────────────────────

  const openUebernahme = async () => {
    if (!record) return;
    setUebOpen(true);
    setUebDepartment('');
    setUebTrotzdem(false);
    setUebEmployees(null);
    const emps = await loadEmployees(tenantId);
    setUebEmployees(emps ?? []);
    if (tenantId === 'beaulieu') {
      // ALLE b-IDs inkl. archivierter, sonst ID-Kollisionen
      setUebBeaulieuIds(await loadAllBeaulieuIds());
    }
  };

  const kandidatName = [p?.vorname, p?.name].filter(Boolean).join(' ').trim();
  const duplikate = uebEmployees ? findeNamensDuplikate(kandidatName, uebEmployees) : [];

  // In-Session-Merker gegen Doppel-Insert, falls der Mitarbeiter angelegt wurde,
  // der Statuswechsel aber fehlschlug (dann steht personalstammId NICHT in der DB).
  const uebCreatedRef = useRef<{ recordId: string; employeeId: string } | null>(null);

  const confirmUebernahme = async () => {
    if (!record || !uebDepartment || uebEmployees == null) return;
    if (uebCreatedRef.current?.recordId === record.id) {
      toast.error(`Mitarbeiter ${uebCreatedRef.current.employeeId} wurde bereits angelegt — bitte den Statuswechsel nicht per Neu-Übernahme wiederholen (Personalstamm prüfen).`);
      return;
    }
    setBusy(true);
    try {
      // Beaulieu: NIE auf aktive-only-IDs zurückfallen — Kollisionsgefahr mit
      // archivierten b-IDs. Leerer Pool = Ladefehler ⇒ abbrechen statt raten.
      if (tenantId === 'beaulieu' && uebBeaulieuIds.length === 0) {
        toast.error('Beaulieu-ID-Liste konnte nicht geladen werden — Übernahme abgebrochen. Dialog bitte erneut öffnen.');
        return;
      }
      // Retry-Schutz: unmittelbar vor dem Anlegen den frischen Stand prüfen —
      // wurde bereits übernommen (z. B. nach Teil-Fehlschlag), KEIN zweiter Insert.
      const fresh = await loadPersonaleintritt(record.id, tenantId);
      if (fresh.data) {
        setRecord(fresh.data);
        if (fresh.data.personalstammId || fresh.data.status === 'uebernommen') {
          toast.info(`Bereits übernommen (Personalstamm-ID ${fresh.data.personalstammId ?? 'unbekannt'}) — kein zweiter Mitarbeiter angelegt.`);
          setUebOpen(false);
          return;
        }
        if (!UEBERNAHME_ERLAUBT.includes(fresh.data.status)) {
          toast.error(`Übernahme im Status «${STATUS_LABELS[fresh.data.status] ?? fresh.data.status}» nicht möglich.`);
          return;
        }
      } else if (fresh.error) {
        toast.error(`Aktueller Stand konnte nicht geprüft werden: ${fresh.error}`);
        return;
      }
      const basis = fresh.data ?? record;
      const idPool = tenantId === 'beaulieu'
        ? uebBeaulieuIds
        : uebEmployees.map(e => String(e.id));
      const { employee, hinweise } = buildEmployeeFromEintritt(basis, uebDepartment, idPool);
      const ok = await upsertEmployee(employee, tenantId);
      if (!ok) {
        toast.error('Mitarbeiter konnte nicht angelegt werden (siehe Konsole).');
        return;
      }
      uebCreatedRef.current = { recordId: record.id, employeeId: employee.id };
      const res = await updatePersonaleintritt(
        record.id, tenantId,
        { status: 'uebernommen', personalstammId: employee.id },
        UEBERNAHME_ERLAUBT,
      );
      if (res.error || !res.data) {
        toast.error(`Mitarbeiter ${employee.id} angelegt, aber Statuswechsel fehlgeschlagen: ${res.error ?? ''}`);
      } else {
        setRecord(res.data);
        toast.success(`In den Personalstamm übernommen (ID ${employee.id})`);
        hinweise.forEach(h => toast.info(h));
      }
      setUebOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const status = record?.status;

  return (
    <PageShell
      width="default"
      header={
        <PageHeader
          icon={<UserCheck />}
          title={anzeigeName}
          info="Detailansicht eines Personaleintritts: geprüfte Daten, Dokumente, Vertrags-PDF und Übernahme in den Personalstamm."
          actions={
            <Button size="sm" variant="outline" onClick={() => navigate('/personaleintritt')} data-testid="button-back">
              <ArrowLeft className="mr-1 h-4 w-4" /> Zur Übersicht
            </Button>
          }
        />
      }
    >
      {preMigration && (
        <HintBox tone="warn" title="Datenbank noch nicht bereit">
          Die Migration <code>20260724_personaleintritt.sql</code> wurde noch nicht ausgeführt.
        </HintBox>
      )}
      {loadError && (
        <HintBox
          tone="critical" title="Laden fehlgeschlagen"
          action={<Button size="sm" variant="outline" onClick={() => void reload()}>Erneut versuchen</Button>}
        >
          {loadError}
        </HintBox>
      )}

      {loading ? <LoadingState /> : !record ? (
        !preMigration && !loadError && (
          <HintBox tone="warn" title="Nicht gefunden">
            Dieser Personaleintritt existiert nicht (mehr) für den aktuellen Betrieb.
          </HintBox>
        )
      ) : (
        <div className="space-y-4">
          {/* Status + Aktionen */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 pt-4">
              <StatusPill tone={STATUS_TONES[record.status]}>{STATUS_LABELS[record.status]}</StatusPill>
              {record.personalstammId && (
                <span className="text-xs text-muted-foreground">Personalstamm-ID: {record.personalstammId}</span>
              )}
              <div className="ml-auto flex flex-wrap justify-end gap-2">
                {status === 'ausgefuellt' && (
                  <Button size="sm" disabled={busy} onClick={() => void markGeprueft()} data-testid="button-mark-geprueft">
                    <CheckCircle2 className="mr-1 h-4 w-4" /> Als geprüft markieren
                  </Button>
                )}
                <Button
                  size="sm" variant="outline"
                  disabled={busy || !PDF_ERLAUBT.includes(record.status)}
                  title={PDF_ERLAUBT.includes(record.status) ? undefined : 'Zuerst den Eintritt prüfen (Status «Geprüft»).'}
                  onClick={() => void createPdf()}
                  data-testid="button-create-pdf"
                >
                  <FileText className="mr-1 h-4 w-4" /> Vertrag (PDF) erstellen
                </Button>
                <Button
                  size="sm" variant="outline"
                  disabled={busy || !MIRUS_ERLAUBT.includes(record.status)}
                  title={MIRUS_ERLAUBT.includes(record.status) ? undefined : 'Zuerst den Eintritt prüfen (Status «Geprüft»).'}
                  onClick={() => void exportMirus()}
                  data-testid="button-mirus-export"
                >
                  <FileSpreadsheet className="mr-1 h-4 w-4" /> MIRUS-Export (Excel)
                </Button>
                <Button
                  size="sm" variant="outline" disabled
                  title="Skribble-Signatur ist vorbereitet, aber noch nicht aktiviert."
                  data-testid="button-skribble"
                >
                  <PenLine className="mr-1 h-4 w-4" /> Zur Signatur senden
                </Button>
                {UEBERNAHME_ERLAUBT.includes(record.status) && (
                  <Button size="sm" disabled={busy} onClick={() => void openUebernahme()} data-testid="button-uebernahme">
                    <UserCheck className="mr-1 h-4 w-4" /> In Personalstamm übernehmen
                  </Button>
                )}
                {record.status !== 'uebernommen' && record.status !== 'abgebrochen' && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCancelOpen(true)} data-testid="button-abbrechen">
                    <XCircle className="mr-1 h-4 w-4 text-destructive" /> Abbrechen
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {pdfWarnungen.length > 0 && (
            <HintBox tone="warn" title="PDF erstellt — bitte prüfen">
              <ul className="list-disc pl-4">
                {pdfWarnungen.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </HintBox>
          )}

          {mirusHinweise.length > 0 && (
            <HintBox tone="info" title="MIRUS-Export erstellt — Hinweise">
              <ul className="list-disc pl-4">
                {mirusHinweise.map((h, i) => <li key={i}>{h}</li>)}
              </ul>
            </HintBox>
          )}

          {/* Arbeitsbewilligung (Anpassung 5) — nur wenn effektiv erforderlich */}
          {bewilligungErforderlichEffektiv(record) && (
            <Card data-testid="card-bewilligung">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldAlert className="h-4 w-4 text-amber-600" /> Arbeitsbewilligung erforderlich
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusPill tone={record.behoerdeMeldungAm ? 'good' : 'warn'}>
                    {record.behoerdeMeldungAm ? 'Meldung ausgelöst' : 'Meldung ausstehend'}
                  </StatusPill>
                  <span className="text-xs text-muted-foreground">
                    {record.bewilligungErforderlich
                      ? 'Von der GF bei den Eckdaten als erforderlich markiert.'
                      : istBewilligungspflichtigerAusweis(l?.aufenthaltsbewilligung)
                        ? `Automatisch erkannt: Ausweis «${l?.aufenthaltsbewilligung}» (Phase 2).`
                        : ''}
                  </span>
                </div>
                {record.behoerdeMeldungAm ? (
                  <p className="text-sm text-muted-foreground" data-testid="text-behoerde-meldung">
                    Ausgelöst von {record.behoerdeMeldungVon ?? 'unbekannt'} am{' '}
                    {new Date(record.behoerdeMeldungAm).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' })}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Das Gesuch an die zuständige Behörde ist mit den Mitarbeiterdaten vorbereitet.
                    Der Vertrag enthält automatisch den Zusatz «Dieser Arbeitsvertrag erreicht seine
                    Gültigkeit erst bei einer Arbeitserlaubnis.»
                  </p>
                )}
                <Button size="sm" variant={record.behoerdeMeldungAm ? 'outline' : 'default'}
                  disabled={busy} onClick={() => void meldungAusloesen()} data-testid="button-behoerde-meldung">
                  <ShieldAlert className="mr-1 h-4 w-4" />
                  {record.behoerdeMeldungAm ? 'Gesuch erneut herunterladen' : 'Meldung an Behörde auslösen'}
                </Button>
              </CardContent>
            </Card>
          )}

          {(record.pdfPath || record.pdfFlatPath) && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Vertrags-PDF</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {record.pdfPath && (
                  <Button size="sm" variant="outline" onClick={() => void openDokument(record.pdfPath!)} data-testid="button-open-pdf-edit">
                    <FileText className="mr-1 h-4 w-4" /> Editierbare Version öffnen
                  </Button>
                )}
                {record.pdfFlatPath && (
                  <Button size="sm" variant="outline" onClick={() => void openDokument(record.pdfFlatPath!)} data-testid="button-open-pdf-flat">
                    <FileText className="mr-1 h-4 w-4" /> Flache Version öffnen
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            {/* Eckdaten (GF) */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Eckdaten (GF)</CardTitle></CardHeader>
              <CardContent>
                <Row label="Betrieb" value={record.betrieb ?? '—'} />
                <Row label="Vertragstyp" value={record.vertragstyp === 'SL' ? 'Stundenlohn (SL)' : record.vertragstyp === 'ML' ? 'Monatslohn (ML)' : '—'} />
                <Row label="Funktion" value={record.funktion ?? '—'} />
                <Row label="Eintritt" value={fmtDate(record.eintritt)} testId="text-eintritt" />
                {record.vertragstyp === 'ML' && <Row label="Pensum" value={record.pensumProzent != null ? `${record.pensumProzent} %` : '—'} />}
                <Row
                  label="Probezeit"
                  value={record.probezeitTage != null
                    ? (record.probezeitTage > 0 && record.probezeitTage % 30 === 0
                      ? `${record.probezeitTage / 30} ${record.probezeitTage === 30 ? 'Monat' : 'Monate'}`
                      : `${record.probezeitTage} Tage`)
                    : '—'}
                />
                <Row label="Vertragsdauer" value={record.vertragsdauer === 'befristet' ? `befristet bis ${fmtDate(record.befristetBis)}` : 'unbefristet'} />
                <Row
                  label="Lohn (berechnet)"
                  value={record.lohnBerechnet != null
                    ? `CHF ${fmtChf(record.lohnBerechnet)} / ${record.lohnEinheit === 'stunde' ? 'Std.' : 'Monat'}`
                    : '—'}
                  testId="text-lohn"
                />
                {record.lohnklasse && <Row label="Lohnklasse" value={LOHNKLASSE_LABELS[record.lohnklasse]} />}
                {record.einfuehrungszeit && <Row label="Einführungszeit" value="ja (−8 %)" />}
                {record.grundlohnInkl13 && (
                  <Row label="Grundlohn-Eingabe" value="inkl. 13. (Basislohn = Eingabe × 12⁄13)" />
                )}
                {bewilligungErforderlichEffektiv(record) && (
                  <Row label="Arbeitsbewilligung" value={record.behoerdeMeldungAm ? 'erforderlich · Meldung ausgelöst' : 'erforderlich · Meldung ausstehend'} />
                )}
              </CardContent>
            </Card>

            {/* Personalien (MA) */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Personalien (Mitarbeiter)</CardTitle></CardHeader>
              <CardContent>
                <Row label="Anrede" value={p?.anrede || '—'} />
                <Row label="Name" value={p?.name || '—'} testId="text-name" />
                <Row label="Vorname" value={p?.vorname || '—'} />
                <Row label="Adresse" value={[p?.strasse, [p?.plz, p?.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—'} />
                <Row label="Geburtsdatum" value={fmtDate(p?.geburtsdatum)} />
                <Row label="Heimatort / Nationalität" value={p?.heimatort_nationalitaet || '—'} />
                <Row label="Telefon" value={p?.telefon || '—'} />
                <Row label="E-Mail" value={p?.email || '—'} />
                {record.vertragstyp === 'ML' && <Row label="Wochenstunden" value={v?.wochenstunden != null ? `${v.wochenstunden} h` : '—'} />}
              </CardContent>
            </Card>

            {/* Lohnprogramm (MA) */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Angaben fürs Lohnprogramm</CardTitle></CardHeader>
              <CardContent>
                <Row label="Zivilstand" value={l?.zivilstand || '—'} />
                <Row label="AHV-Nr." value={l?.ahv_nr || '—'} />
                <Row label="IBAN" value={l?.iban || '—'} />
                <Row label="Bank" value={l?.bank || '—'} />
                <Row label="Ausweis" value={[l?.ausweisart, l?.ausweis_nr].filter(Boolean).join(' · ') || '—'} />
                <Row label="Aufenthaltsbewilligung" value={l?.aufenthaltsbewilligung || '—'} />
                <Row label="Konfession" value={l?.konfession || '—'} />
                {l?.ehepartner?.name && (
                  <Row label="Ehepartner" value={`${l.ehepartner.name}${l.ehepartner.erwerbstaetig ? ' (erwerbstätig)' : ''}`} />
                )}
                {(l?.kinder ?? []).length > 0 && (
                  <div className="pt-2">
                    <div className="mb-1 text-sm text-muted-foreground">Kinder</div>
                    {(l?.kinder ?? []).map((k, i) => (
                      <div key={i} className="border-b py-1 text-sm last:border-0">
                        <span className="font-medium">{k.name || `Kind ${i + 1}`}</span>
                        <span className="text-muted-foreground"> · {fmtDate(k.geburtsdatum)}{k.familienzulage_bei ? ` · Familienzulage bei: ${k.familienzulage_bei}` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Dokumente (MA) */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Dokumente</CardTitle></CardHeader>
              <CardContent>
                {MA_DOKUMENT_TYPEN.map(({ typ, label, pflicht }) => {
                  const path = dok?.[typ];
                  return (
                    <div key={typ} className="flex items-center justify-between border-b py-1.5 text-sm last:border-0">
                      <span className="text-muted-foreground">{label}{pflicht ? ' *' : ''}</span>
                      {path ? (
                        <Button size="sm" variant="outline" onClick={() => void openDokument(path)} data-testid={`button-open-dok-${typ}`}>
                          Öffnen
                        </Button>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  );
                })}
                {v?.besondere_vereinbarungen && (
                  <div className="pt-2 text-sm">
                    <div className="text-muted-foreground">Besondere Vereinbarungen</div>
                    <div className="whitespace-pre-wrap">{v.besondere_vereinbarungen}</div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="text-xs text-muted-foreground">
            Erstellt {fmtDate(record.createdAt)} · Ausgefüllt {fmtDate(record.ausgefuelltAm)} · Zuletzt geändert {fmtDate(record.updatedAt)}
          </div>
        </div>
      )}

      {/* Abbrechen */}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eintritt abbrechen?</AlertDialogTitle>
            <AlertDialogDescription>
              Der Eintrag wird auf «Abgebrochen» gesetzt. Der Einladungslink wird dadurch ungültig;
              der Eintrag kann anschliessend in der Übersicht gelöscht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Zurück</AlertDialogCancel>
            <AlertDialogAction onClick={() => void abbrechen()} data-testid="button-confirm-abbrechen">
              Abbrechen bestätigen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Übernahme */}
      <Dialog open={uebOpen} onOpenChange={(o) => { if (!o) setUebOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>In den Personalstamm übernehmen</DialogTitle>
            <DialogDescription>
              Legt «{kandidatName || 'diesen Mitarbeiter'}» als neuen Mitarbeiter im Personalstamm an
              und markiert den Eintritt als übernommen.
            </DialogDescription>
          </DialogHeader>

          {uebEmployees == null ? <LoadingState /> : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Abteilung *</Label>
                <Select value={uebDepartment} onValueChange={(val) => setUebDepartment(val as Department)}>
                  <SelectTrigger data-testid="select-department">
                    <SelectValue placeholder="Abteilung wählen…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="service">Service</SelectItem>
                    <SelectItem value="küche">Küche</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {duplikate.length > 0 && (
                <>
                  <HintBox tone="warn" title="Möglicher Doppeleintrag">
                    Im Personalstamm existiert bereits: {duplikate.map(d => `${d.name} (ID ${d.id})`).join(', ')}.
                    Bitte prüfen, ob es sich um dieselbe Person handelt.
                  </HintBox>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={uebTrotzdem} onCheckedChange={(c) => setUebTrotzdem(c === true)} data-testid="checkbox-trotzdem" />
                    Trotzdem als neuen Mitarbeiter anlegen
                  </label>
                </>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setUebOpen(false)}>Abbrechen</Button>
            <Button
              disabled={busy || uebEmployees == null || !uebDepartment || (duplikate.length > 0 && !uebTrotzdem)}
              onClick={() => void confirmUebernahme()}
              data-testid="button-confirm-uebernahme"
            >
              Übernehmen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
