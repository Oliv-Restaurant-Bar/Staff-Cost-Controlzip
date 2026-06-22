/**
 * GaesteImportPage — Foratable *Gästeexport* importieren (CRM-Anreicherung)
 *
 * Ablauf-Assistent:  Upload → Vorschau → Anreichern → Fertig
 *
 * ZWECK: Reichert die MANUELLEN CRM-Profile bestehender Gäste
 * (`guest_crm_profiles`) mit Daten aus dem Foratable-Gästeexport an.  Es werden
 * NUR leere CRM-Felder gefüllt — bereits gepflegte Werte bleiben unangetastet
 * (Konflikte werden nur gezählt).  Reservationen, Besuchszahlen und Segmente
 * werden NICHT berührt.
 *
 * Datenschutz: nur eingeloggte Admins; in der Oberfläche werden ausschliesslich
 * Aggregat-Zahlen angezeigt (keine personenbezogenen Daten).
 */

import { useState, useRef, useCallback } from 'react';
import {
  Upload, FileText, CheckCircle2, AlertTriangle, Loader2, Database,
  Users, UserPlus, UserCheck, RotateCcw, Star, Mail, Ban, Building2,
  StickyNote, Phone, Contact, ShieldAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { Navigate, Link } from 'react-router-dom';
import { toast } from 'sonner';

import {
  parseForatableGuestsCsv, type ForatableGuestParseResult,
} from '@/lib/foratable-guest-import-parser';
import {
  previewForatableGuestImport, commitForatableGuestImport,
  type ForatableGuestImportOutcome,
} from '@/lib/foratable-guest-import-db';

const NUM0 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

type WizardStep = 'upload' | 'preview' | 'saving' | 'done';

// ── Kachel ─────────────────────────────────────────────────────────────────────

function Tile({ icon: Icon, label, value, accent }: {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className={cn('mt-1 text-xl font-bold tabular-nums', accent)}>{value}</p>
    </div>
  );
}

// ── Komponente ─────────────────────────────────────────────────────────────────

export default function GaesteImportPage() {
  const { tenantId } = useTenant();
  const { isAdmin } = usePermissions();
  const { isGuest } = useGuestSession();
  // Schreibender CRM-Import: nur echte Admins, niemals read-only Gast-Sessions
  // (usePermissions().isAdmin schliesst Gäste ein — daher hier explizit ausgeschlossen).
  const canImport = isAdmin && !isGuest;

  const [step, setStep] = useState<WizardStep>('upload');
  const [isDragging, setIsDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const [parsed, setParsed] = useState<ForatableGuestParseResult | null>(null);
  const [preview, setPreview] = useState<ForatableGuestImportOutcome | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [result, setResult] = useState<ForatableGuestImportOutcome | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  const resetWizard = useCallback(() => {
    setParsed(null);
    setPreview(null);
    setPreviewError(null);
    setParseError(null);
    setResult(null);
    setStep('upload');
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const processCSV = useCallback(async (file: File) => {
    setParseError(null);
    setParsed(null);
    setPreview(null);
    setPreviewError(null);
    try {
      const text = await file.text();
      const res = parseForatableGuestsCsv(file.name, text);
      if (!res.headerOk) {
        setParseError(res.errors[0]?.message
          ?? 'Datei konnte nicht als Foratable-Gästeexport erkannt werden.');
        return;
      }
      if (res.rows.length === 0) {
        setParseError('Keine gültigen Gästezeilen in der Datei gefunden.');
        return;
      }
      setParsed(res);
      setStep('preview');

      // Abgleich gegen die bestehenden Gäste/CRM-Profile (liest nur, schreibt nicht).
      setPreviewing(true);
      try {
        const outcome = await previewForatableGuestImport(tenantId, res);
        setPreview(outcome);
      } catch (e) {
        setPreview(null);
        setPreviewError(e instanceof Error ? e.message : String(e));
        toast.error('Vorschau nicht verfügbar: ' + (e instanceof Error ? e.message : String(e)));
      } finally {
        setPreviewing(false);
      }
    } catch (e) {
      setParseError('Fehler beim Lesen der Datei: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [tenantId]);

  if (!canImport) return <Navigate to="/" replace />;

  const handleFileSelect = (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParseError('Bitte eine CSV-Datei auswählen.');
      return;
    }
    processCSV(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files[0]);
  };

  const handleConfirm = async () => {
    if (!parsed) return;
    setStep('saving');
    try {
      const outcome = await commitForatableGuestImport(tenantId, parsed);
      setResult(outcome);
      toast.success(
        `Anreicherung abgeschlossen — ${outcome.created} neu, ${outcome.updated} ergänzt`
        + (outcome.conflicts > 0 ? `, ${outcome.conflicts} Konflikt(e) übersprungen` : ''),
      );
      setStep('done');
    } catch (e) {
      toast.error('Import fehlgeschlagen: ' + (e instanceof Error ? e.message : String(e)));
      setStep('preview');
    }
  };

  const stats = parsed?.stats ?? null;
  const willWrite = preview ? preview.created + preview.updated : 0;

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6 space-y-5">
      {/* Kopf */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Contact className="h-6 w-6 text-primary" />
            Gästeexport Import
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Foratable-<span className="font-medium">Gästeexport</span> importieren — reichert die
            CRM-Profile bestehender Gäste an (füllt nur leere Felder).
          </p>
        </div>
        <Link
          to="/gaeste"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted/60"
        >
          <Users className="h-4 w-4" />
          Zum Gäste-CRM
        </Link>
      </div>

      {/* Hinweis zur Wirkungsweise */}
      <div className="rounded-lg border border-blue-200 bg-blue-50/60 dark:border-blue-900 dark:bg-blue-950/20 p-3 flex gap-2 text-sm text-blue-800 dark:text-blue-300">
        <ShieldAlert className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <span>
          Es werden nur <strong>leere</strong> CRM-Felder bestehender Gäste gefüllt. Bereits
          gepflegte Werte bleiben unverändert. Reservationen, Besuchszahlen und Segmente werden
          nicht berührt. Gäste, die sich nicht eindeutig zuordnen lassen, werden übersprungen.
        </span>
      </div>

      {/* Schritt: Upload */}
      {step === 'upload' && (
        <div className="space-y-4">
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            className={cn(
              'rounded-xl border-2 border-dashed p-10 text-center cursor-pointer transition-colors',
              isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
            )}
          >
            <Upload className="h-10 w-10 mx-auto text-muted-foreground" />
            <p className="mt-3 font-medium">CSV-Datei hierher ziehen oder klicken</p>
            <p className="text-xs text-muted-foreground mt-1">
              Foratable-Gästeexport (Semikolon-getrennt)
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => handleFileSelect(e.target.files?.[0])}
            />
          </div>

          {parseError && (
            <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 flex gap-2 text-sm text-red-700 dark:text-red-300">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{parseError}</span>
            </div>
          )}
        </div>
      )}

      {/* Schritt: Vorschau */}
      {step === 'preview' && parsed && stats && (
        <div className="space-y-5">
          <div className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{parsed.fileName}</span>
          </div>

          {/* Anreicherungs-Projektion */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Tile icon={FileText} label="Zeilen gelesen" value={NUM0.format(stats.rowCount)} />
            <Tile icon={UserCheck} label="Gäste gematcht"
              value={previewing ? '…' : preview ? NUM0.format(preview.matchedGuests) : '—'}
              accent="text-violet-600 dark:text-violet-400" />
            <Tile icon={AlertTriangle} label="Nicht zuordenbar"
              value={previewing ? '…' : preview ? NUM0.format(preview.unassignable) : '—'}
              accent="text-amber-600 dark:text-amber-400" />
            <Tile icon={UserPlus} label="Profile neu"
              value={previewing ? '…' : preview ? NUM0.format(preview.created) : '—'}
              accent="text-blue-600 dark:text-blue-400" />
            <Tile icon={CheckCircle2} label="Profile ergänzt"
              value={previewing ? '…' : preview ? NUM0.format(preview.updated) : '—'}
              accent="text-emerald-600 dark:text-emerald-400" />
            <Tile icon={Ban} label="Konflikte (behalten)"
              value={previewing ? '…' : preview ? NUM0.format(preview.conflicts) : '—'}
              accent="text-orange-600 dark:text-orange-400" />
          </div>

          {/* Erkannter CSV-Inhalt */}
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-semibold mb-3">Erkannter CSV-Inhalt</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-sm">
              <ContentRow icon={Mail} label="Mit E-Mail" value={stats.withEmail} />
              <ContentRow icon={Phone} label="Mit Telefon" value={stats.withPhone} />
              <ContentRow icon={Contact} label="Mit Vor- & Nachname" value={stats.withName} />
              <ContentRow icon={Star} label="VIP" value={stats.vipCount} />
              <ContentRow icon={Mail} label="Newsletter" value={stats.newsletterCount} />
              <ContentRow icon={Ban} label="Blacklist" value={stats.blacklistCount} />
              <ContentRow icon={Building2} label="Firma" value={stats.withCompany} />
              <ContentRow icon={StickyNote} label="Notizen" value={stats.withNotes} />
              <ContentRow icon={UserPlus} label="Geburtsdatum" value={stats.withBirthday} />
            </div>
            {stats.withoutKey > 0 && (
              <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
                • {NUM0.format(stats.withoutKey)} Zeile(n) ohne Kennung (keine E-Mail/Telefon/Name)
                — werden übersprungen.
              </p>
            )}
          </div>

          {previewError && (
            <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 flex gap-2 text-sm text-red-700 dark:text-red-300">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>Vorschau fehlgeschlagen: {previewError}</span>
            </div>
          )}

          {/* Aktionen */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleConfirm}
              disabled={previewing || !preview || willWrite === 0}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Database className="h-4 w-4" />
              {willWrite > 0 ? `${NUM0.format(willWrite)} CRM-Profile anreichern` : 'Nichts zu importieren'}
            </button>
            <button
              onClick={resetWizard}
              className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              <RotateCcw className="h-4 w-4" /> Abbrechen
            </button>
          </div>
        </div>
      )}

      {/* Schritt: Speichern */}
      {step === 'saving' && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="mt-3 text-sm">CRM-Profile werden angereichert …</p>
        </div>
      )}

      {/* Schritt: Fertig */}
      {step === 'done' && result && (
        <div className="space-y-5">
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <CheckCircle2 className="h-12 w-12 text-emerald-500" />
            <p className="mt-3 text-lg font-semibold">Anreicherung abgeschlossen</p>
            <p className="text-sm text-muted-foreground mt-1">
              Die CRM-Profile wurden aktualisiert.
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Tile icon={FileText} label="Zeilen gelesen" value={NUM0.format(result.rowsRead)} />
            <Tile icon={UserCheck} label="Gäste gematcht" value={NUM0.format(result.matchedGuests)}
              accent="text-violet-600 dark:text-violet-400" />
            <Tile icon={UserPlus} label="Profile neu" value={NUM0.format(result.created)}
              accent="text-blue-600 dark:text-blue-400" />
            <Tile icon={CheckCircle2} label="Profile ergänzt" value={NUM0.format(result.updated)}
              accent="text-emerald-600 dark:text-emerald-400" />
            <Tile icon={Ban} label="Konflikte (behalten)" value={NUM0.format(result.conflicts)}
              accent="text-orange-600 dark:text-orange-400" />
            <Tile icon={AlertTriangle} label="Nicht zuordenbar" value={NUM0.format(result.unassignable)}
              accent="text-amber-600 dark:text-amber-400" />
          </div>

          <div className="flex gap-3">
            <button
              onClick={resetWizard}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Upload className="h-4 w-4" /> Weitere Datei
            </button>
            <Link
              to="/gaeste"
              className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              <Users className="h-4 w-4" /> Zum Gäste-CRM
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inhaltszeile (CSV-Statistik) ───────────────────────────────────────────────

function ContentRow({ icon: Icon, label, value }: {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className="font-medium tabular-nums">{NUM0.format(value)}</span>
    </div>
  );
}
