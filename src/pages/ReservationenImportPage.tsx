/**
 * ReservationenImportPage — Import von Foratable-Reservationen (CSV)
 *
 * Ablauf-Assistent:  Upload → Vorschau → Speichern → Fertig
 * Zusätzlich:         Importverlauf (ein Eintrag pro Datei)
 *
 * Datenschutz: Die Reservationsdaten enthalten personenbezogene Daten
 * (E-Mail, Mobile, Name).  Zugriff nur für eingeloggte Admins; die Tabellen
 * sind per RLS auf `authenticated` beschränkt (siehe Migration).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload, FileText, CheckCircle2, AlertTriangle, Loader2,
  Database, Users, Clock, MapPin, CalendarRange, UserPlus, UserCheck,
  RotateCcw, XCircle, Ban,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { Navigate, Link } from 'react-router-dom';
import { toast } from 'sonner';

import { parseReservationsCsv } from '@/lib/reservation-import-parser';
import type {
  ReservationParseResult, ReservationStatusNormalized,
} from '@/lib/reservation-import-parser';
import {
  checkReservationTablesExist, classifyGuests, saveReservationImport,
  fetchReservationImports,
} from '@/lib/reservation-import-db';
import type { GuestClassification, ReservationImportRow } from '@/lib/reservation-import-db';
import { ReservationSummary, fdate } from '@/components/reservations/ReservationSummary';

type WizardStep = 'upload' | 'preview' | 'saving' | 'done';
type Tab = 'import' | 'history';

// ── Komponente ────────────────────────────────────────────────────────────────

export default function ReservationenImportPage() {
  const { tenantId } = useTenant();
  const { isAdmin } = usePermissions();

  if (!isAdmin) return <Navigate to="/" replace />;

  const [tab, setTab] = useState<Tab>('import');
  const [step, setStep] = useState<WizardStep>('upload');
  const [isDragging, setIsDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [tablesOk, setTablesOk] = useState<boolean | null>(null);

  const [parsed, setParsed] = useState<ReservationParseResult | null>(null);
  const [guestClass, setGuestClass] = useState<GuestClassification | null>(null);
  const [classifying, setClassifying] = useState(false);

  const [history, setHistory] = useState<ReservationImportRow[]>([]);
  const [histLoading, setHistLoading] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  // ── Setup prüfen ────────────────────────────────────────────────────────────
  useEffect(() => {
    checkReservationTablesExist().then(setTablesOk);
  }, []);

  // ── Verlauf laden ─────────────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    setHistLoading(true);
    const rows = await fetchReservationImports(tenantId);
    setHistory(rows);
    setHistLoading(false);
  }, [tenantId]);

  useEffect(() => {
    if (tab === 'history') loadHistory();
  }, [tab, loadHistory]);

  // ── Reset ─────────────────────────────────────────────────────────────────
  const resetWizard = useCallback(() => {
    setParsed(null);
    setGuestClass(null);
    setParseError(null);
    setStep('upload');
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  // ── CSV verarbeiten ─────────────────────────────────────────────────────────
  const processCSV = useCallback(async (file: File) => {
    setParseError(null);
    setParsed(null);
    setGuestClass(null);
    try {
      const text = await file.text();
      const result = parseReservationsCsv(file.name, text);
      if (!result.headerOk) {
        setParseError(result.errors[0]?.message
          ?? 'Datei konnte nicht als Foratable-Reservationsexport erkannt werden.');
        return;
      }
      if (result.reservations.length === 0) {
        setParseError('Keine gültigen Reservationen in der Datei gefunden.');
        return;
      }
      setParsed(result);
      setStep('preview');

      // Neue / wiederkehrende Gäste klassifizieren (DB-Abfrage, ohne zu schreiben).
      setClassifying(true);
      try {
        const cls = await classifyGuests(tenantId, result.reservations);
        setGuestClass(cls);
      } catch (e) {
        // Klassifizierung ist optional für die Vorschau — Import bleibt möglich.
        setGuestClass(null);
        toast.error('Gäste-Vorschau nicht verfügbar: ' + (e instanceof Error ? e.message : String(e)));
      } finally {
        setClassifying(false);
      }
    } catch (e) {
      setParseError('Fehler beim Lesen der Datei: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [tenantId]);

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

  // ── Speichern ─────────────────────────────────────────────────────────────
  const handleConfirm = async () => {
    if (!parsed) return;
    setStep('saving');
    const result = await saveReservationImport(tenantId, parsed);
    if (result.error) {
      toast.error('Import fehlgeschlagen: ' + result.error);
      setStep('preview');
      return;
    }
    toast.success(
      `Import erfolgreich — ${result.reservationCount} Reservationen `
      + `(${result.newGuests} neue, ${result.returningGuests} wiederkehrende Gäste)`
      + (result.duplicateKeyMerged > 0
        ? ` · ${result.duplicateKeyMerged} Doppel-Res.Nr. zusammengeführt`
        : ''),
    );
    setStep('done');
    loadHistory();
  };

  // ── Vorschau-Werte ──────────────────────────────────────────────────────────
  const stats = parsed?.stats ?? null;
  const skippedRows = parsed?.errors.filter(e => e.rowNumber > 0).length ?? 0;

  // ── Tabellen fehlen → Hinweisbanner ─────────────────────────────────────────
  const tablesMissingBanner = tablesOk === false && (
    <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 p-4 flex gap-3">
      <Database className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
      <div className="text-sm">
        <p className="font-semibold text-amber-800 dark:text-amber-300">Datenbank-Tabellen fehlen</p>
        <p className="mt-1 text-amber-700 dark:text-amber-400">
          Die Tabellen für Reservationen wurden noch nicht angelegt. Bitte das Migrationsskript{' '}
          <code className="rounded bg-amber-100 dark:bg-amber-900/50 px-1 py-0.5 text-xs">
            supabase/migrations/20260621_reservations.sql
          </code>{' '}
          im Supabase SQL-Editor ausführen und die Seite neu laden.
        </p>
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6 space-y-5">
      {/* Kopf */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarRange className="h-6 w-6 text-primary" />
            Reservationen Import
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Foratable-CSV-Export importieren — für Gäste- und Auslastungsanalysen.
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

      {tablesMissingBanner}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {([['import', 'Import'], ['history', 'Verlauf']] as Array<[Tab, string]>).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Import-Tab ─────────────────────────────────────────────────────── */}
      {tab === 'import' && (
        <>
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
                  tablesOk === false && 'pointer-events-none opacity-50',
                )}
              >
                <Upload className="h-10 w-10 mx-auto text-muted-foreground" />
                <p className="mt-3 font-medium">CSV-Datei hierher ziehen oder klicken</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Foratable-Export (Semikolon-getrennt)
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

              <ReservationSummary
                stats={stats}
                newGuests={guestClass ? guestClass.newGuests : null}
                returningGuests={guestClass ? guestClass.returningGuests : null}
                guestsLoading={classifying}
                extraNote={skippedRows > 0
                  ? <p>• {skippedRows} Zeile(n) mit Hinweisen (z. B. ohne Res.Nr. oder unklares Datum).</p>
                  : undefined}
              />

              {/* Aktionen */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleConfirm}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  <Database className="h-4 w-4" />
                  {stats.reservationCount} Reservationen importieren
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
              <p className="mt-3 text-sm">Reservationen werden gespeichert …</p>
            </div>
          )}

          {/* Schritt: Fertig */}
          {step === 'done' && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <CheckCircle2 className="h-12 w-12 text-emerald-500" />
              <p className="mt-3 text-lg font-semibold">Import abgeschlossen</p>
              <p className="text-sm text-muted-foreground mt-1">Die Reservationen wurden gespeichert.</p>
              <div className="flex gap-3 mt-5">
                <button
                  onClick={resetWizard}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  <Upload className="h-4 w-4" /> Weitere Datei
                </button>
                <button
                  onClick={() => setTab('history')}
                  className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                  <FileText className="h-4 w-4" /> Zum Verlauf
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Verlauf-Tab ────────────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div className="space-y-3">
          {histLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : history.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-10 text-center text-muted-foreground">
              <FileText className="h-8 w-8 mx-auto mb-2" />
              Noch keine Importe vorhanden.
            </div>
          ) : (
            <div className="max-h-[70vh] overflow-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted [&_th]:border-b [&_th]:border-border">
                  <tr>
                    <th className="px-3 py-2 font-medium">Datei</th>
                    <th className="px-3 py-2 font-medium">Zeitraum</th>
                    <th className="px-3 py-2 font-medium text-right">Res.</th>
                    <th className="px-3 py-2 font-medium text-right">Pers.</th>
                    <th className="px-3 py-2 font-medium text-right">Abg.</th>
                    <th className="px-3 py-2 font-medium text-right">Storno</th>
                    <th className="px-3 py-2 font-medium text-right">Neu</th>
                    <th className="px-3 py-2 font-medium text-right">Wiederk.</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Importiert</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {history.map((h) => (
                    <tr key={h.id} className="hover:bg-muted/30">
                      <td className="px-3 py-2 max-w-[200px] truncate" title={h.file_name}>{h.file_name}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {h.period_from ? `${fdate(h.period_from)} – ${fdate(h.period_to)}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{h.reservation_count ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{h.total_persons ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{h.completed_count ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{h.cancelled_count ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{h.new_guests ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{h.returning_guests ?? '—'}</td>
                      <td className="px-3 py-2">
                        {h.status === 'active' ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Aktiv
                          </span>
                        ) : h.status === 'failed' ? (
                          <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 text-xs font-medium" title={h.error_message ?? ''}>
                            <XCircle className="h-3.5 w-3.5" /> Fehler
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 text-xs font-medium">
                            <Loader2 className="h-3.5 w-3.5" /> {h.status}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground text-xs">
                        {h.imported_at ? fmtDate(parseISO(h.imported_at), 'dd.MM.yy HH:mm', { locale: de }) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
