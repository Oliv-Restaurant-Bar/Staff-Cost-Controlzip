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

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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

import { parseReservationsCsv, checkTenantMatch, TENANT_LABELS } from '@/lib/reservation-import-parser';
import { CsvPasteBox } from '@/components/import/CsvPasteBox';
import type {
  ReservationParseResult, ReservationStatusNormalized,
} from '@/lib/reservation-import-parser';
import {
  checkReservationTablesExist, classifyGuests, saveReservationImport,
  fetchReservationImports, previewReservationDiff, fetchPriorReservationRows,
} from '@/lib/reservation-import-db';
import type { GuestClassification, ReservationImportRow, ReservationDiffPreview } from '@/lib/reservation-import-db';
import { recordImportRun } from '@/lib/import-undo-store';
import { LastImportPanel } from '@/components/import-center/LastImportPanel';
import { logImportRun } from '@/lib/import-runs-db';
import { buildReservationRunStats } from '@/lib/import-runs';
import { ReservationSummary, fdate } from '@/components/reservations/ReservationSummary';
import { ReservationCountingSettingsCard } from '@/components/reservations/ReservationCountingSettingsCard';
import {
  monatsAggregateAusDatei, selfCheckNachImport,
} from '@/lib/reservation-import-selfcheck';
import type { MonatsAggregat, SelfCheckResult } from '@/lib/reservation-import-selfcheck';
import {
  loadReservationCounting, DEFAULT_RESERVATION_COUNTING, STATUS_LABELS,
} from '@/lib/reservation-cockpit-settings';
import type { ReservationCountingSettings } from '@/lib/reservation-cockpit-settings';
import { TakeAwayOfferedSettingsCard } from '@/components/reservations/TakeAwayOfferedSettingsCard';

type WizardStep = 'upload' | 'preview' | 'saving' | 'done';
type Tab = 'import' | 'history';

// ── Komponente ────────────────────────────────────────────────────────────────

export default function ReservationenImportPage(
  { embedded = false, onImported }: { embedded?: boolean; onImported?: () => void } = {},
) {
  const { tenantId, tenantKey } = useTenant();
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
  /** Upsert-Vorschau «X neu · Y aktualisiert · Z unverändert» (Diff gegen DB). */
  const [diff, setDiff] = useState<ReservationDiffPreview | null>(null);

  const [history, setHistory] = useState<ReservationImportRow[]>([]);
  const [histLoading, setHistLoading] = useState(false);

  /** Zentrale Zählregel (für Selbstkontrolle je Monat). */
  const [counting, setCounting] = useState<ReservationCountingSettings>(DEFAULT_RESERVATION_COUNTING);
  /** Selbstkontrolle nach dem Import (Datei ↔ DB ↔ gemergtes Monats-Total). */
  const [selfCheck, setSelfCheck] = useState<SelfCheckResult | null>(null);
  const [selfCheckLoading, setSelfCheckLoading] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  // ── Setup prüfen ────────────────────────────────────────────────────────────
  useEffect(() => {
    checkReservationTablesExist().then(setTablesOk);
  }, []);

  // Zentrale Zählregel laden (bestimmt die Selbstkontrolle je Monat).
  useEffect(() => {
    let alive = true;
    loadReservationCounting(tenantKey)
      .then(s => { if (alive) setCounting(s); })
      .catch(() => { /* Defaults bleiben */ });
    return () => { alive = false; };
  }, [tenantKey]);

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
    setDiff(null);
    setSelfCheck(null);
    setParseError(null);
    setStep('upload');
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  // ── CSV verarbeiten (gemeinsamer Kern für Datei, Drag & Drop und Einfügen) ──
  const processText = useCallback(async (text: string, sourceName: string) => {
    setParseError(null);
    setParsed(null);
    setGuestClass(null);
    setDiff(null);
    setSelfCheck(null);
    try {
      const result = parseReservationsCsv(sourceName, text);
      if (!result.headerOk) {
        setParseError(result.errors[0]?.message
          ?? 'Datei konnte nicht als Foratable-Reservationsexport erkannt werden.');
        return;
      }
      if (result.reservations.length === 0) {
        setParseError('Keine gültigen Reservationen in der Datei gefunden.');
        return;
      }
      // Zählregel FRISCH laden und als Snapshot verwenden — Vorschau und
      // Selbstkontrolle rechnen garantiert mit derselben, aktuellen Regel
      // (kein Stale-State vom Seitenmount oder von der Einstellungs-Karte).
      try {
        const fresh = await loadReservationCounting(tenantKey);
        setCounting(fresh);
      } catch { /* zuletzt geladener Stand bleibt */ }

      setParsed(result);
      setStep('preview');

      // Upsert-Vorschau (Diff über Res.Nr. gegen den DB-Bestand, ohne zu schreiben).
      previewReservationDiff(tenantId, result.reservations)
        .then(setDiff)
        .catch(() => setDiff(null)); // Vorschau optional — Import bleibt möglich.

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
      setParseError('Fehler beim Verarbeiten der Daten: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [tenantId, tenantKey]);

  const handleFileSelect = (file: File | undefined) => {
    if (!file) {
      setParseError('Keine Datei erkannt — bitte eine .csv-Datei wählen oder hierher ziehen.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParseError('Bitte eine CSV-Datei auswählen.');
      return;
    }
    file.text()
      .then(text => processText(text, file.name))
      .catch(e => setParseError('Fehler beim Lesen der Datei: ' + (e instanceof Error ? e.message : String(e))));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelect(e.dataTransfer.files[0]);
  };

  // ── Speichern ─────────────────────────────────────────────────────────────
  const handleConfirm = async () => {
    if (!parsed) return;
    // Mandanten-Schutz: erkannter, abweichender Mandant blockiert den Import
    // hart — auch als letzter Riegel, falls der Button-disabled umgangen würde.
    const guard = checkTenantMatch(parsed.dominantRestaurantName, tenantId);
    if (guard.block) {
      toast.error(guard.message ?? 'Import blockiert: Datei gehört zu einem anderen Mandanten.');
      return;
    }
    const startedAt = new Date().toISOString();
    setStep('saving');

    // Backup VOR dem Schreiben: Vorzustand aller betroffenen Res.Nr. sichern
    // UND im Undo-Protokoll ablegen — Grundlage für «Letzter Import rückgängig
    // machen». Scheitert Backup oder Protokoll, wird NICHT importiert
    // (kein Import ohne Rückweg).
    const extIds = [...new Set(parsed.reservations.map(r => r.externalReservationId))];
    try {
      const priorRows = await fetchPriorReservationRows(tenantId, extIds);
      const snapshot = {
        kind: 'reservation-records' as const,
        restaurantId: tenantId, extIds, priorRows,
      };
      // Grössen-Schutz: der Snapshot landet in einem app_settings-Blob —
      // unbegrenzt grosse Backups würden dort scheitern (und der Import hätte
      // keinen Rückweg). Lieber sauber abbrechen mit Handlungsanweisung.
      if (JSON.stringify(snapshot).length > 2_000_000) {
        toast.error('Import abgebrochen — die Datei betrifft zu viele bestehende Reservationen für ein Undo-Backup. Bitte den Export in kleinere Zeiträume aufteilen.');
        setStep('preview');
        return;
      }
      await recordImportRun(tenantId, {
        source: 'reservationen-foratable',
        periodLabel: parsed.stats?.periodFrom && parsed.stats?.periodTo
          ? `${parsed.stats.periodFrom} – ${parsed.stats.periodTo}` : '—',
        itemCount: extIds.length,
        itemLabel: 'Reservationen',
        fileName: parsed.fileName,
        details: diff ? `${diff.neu} neu · ${diff.aktualisiert} aktualisiert · ${diff.unveraendert} unverändert` : undefined,
        snapshot,
      });
    } catch (e) {
      toast.error('Import abgebrochen — Undo-Backup konnte nicht erstellt werden: '
        + (e instanceof Error ? e.message : String(e)));
      setStep('preview');
      return;
    }

    const result = await saveReservationImport(tenantId, parsed);
    if (result.error) {
      void logImportRun(tenantId, {
        importType: 'reservations',
        status: 'failed',
        fileName: parsed.fileName,
        recordCount: parsed.stats?.reservationCount ?? null,
        periodFrom: parsed.stats?.periodFrom ?? null,
        periodTo: parsed.stats?.periodTo ?? null,
        errorMessage: result.error,
        startedAt,
      });
      toast.error('Import fehlgeschlagen: ' + result.error);
      setStep('preview');
      return;
    }
    await logImportRun(tenantId, {
      importType: 'reservations',
      status: 'success',
      fileName: parsed.fileName,
      recordCount: result.reservationCount,
      periodFrom: parsed.stats?.periodFrom ?? null,
      periodTo: parsed.stats?.periodTo ?? null,
      stats: buildReservationRunStats(result),
      startedAt,
    });
    onImported?.();
    toast.success(
      `Import erfolgreich — ${result.reservationCount} Reservationen `
      + `(${result.inserted} neu, ${result.updated} aktualisiert)`
      + (result.duplicateKeyMerged > 0
        ? ` · ${result.duplicateKeyMerged} Doppel-Res.Nr. in der CSV zusammengeführt`
        : '')
      + (result.skippedRows > 0
        ? ` · ${result.skippedRows} Zeile(n) übersprungen`
        : '')
      + ` · ${result.newGuests} neue / ${result.returningGuests} wiederkehrende Gäste`,
    );
    setStep('done');
    loadHistory();

    // Selbstkontrolle NACH dem Import: Datei-Summen je Monat gegen die DB
    // (Res.Nr. der Datei) + gemergte Monats-Totale. Abweichung → Warnung.
    setSelfCheckLoading(true);
    try {
      const check = await selfCheckNachImport(tenantId, parsed.reservations, counting);
      setSelfCheck(check);
      if (!check.allOk) {
        toast.warning('Selbstkontrolle: Abweichung zwischen Datei und Datenbank — Details unten. Der Import kann rückgängig gemacht werden.');
      }
    } finally {
      setSelfCheckLoading(false);
    }
  };

  // ── Selbstkontrolle: Monats-Aggregate der Datei (Vorschau) ─────────────────
  const fileMonths = useMemo<MonatsAggregat[]>(
    () => parsed ? monatsAggregateAusDatei(parsed.reservations, counting) : [],
    [parsed, counting],
  );
  const nf = useMemo(() => new Intl.NumberFormat('de-CH'), []);
  const fmtN = (v: number | null) => v === null ? '—' : nf.format(v);
  const fmtMonth = (m: string) => {
    const [y, mo] = m.split('-');
    return `${mo}.${y}`;
  };

  /** Monats-Tabelle (Datei-Werte, optional mit DB-Kontrolle). */
  const monthTable = (rows: MonatsAggregat[], check?: SelfCheckResult | null) => (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm" data-testid="table-selfcheck-months">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Monat</th>
            <th className="px-3 py-2 font-medium text-right">Res. gezählt</th>
            <th className="px-3 py-2 font-medium text-right">Reservierte Gäste</th>
            <th className="px-3 py-2 font-medium text-right">Gruppen ≥{counting.groupThreshold} Pax</th>
            <th className="px-3 py-2 font-medium text-right">Σ Pers. Gruppen</th>
            {check && <th className="px-3 py-2 font-medium text-right">Monat gesamt (nach Merge)</th>}
            {check && <th className="px-3 py-2 font-medium">Kontrolle</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(m => {
            const k = check?.rows.find(r => r.month === m.month);
            return (
              <tr key={m.month} data-testid={`row-selfcheck-${m.month}`}>
                <td className="px-3 py-2 font-medium whitespace-nowrap">{fmtMonth(m.month)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{m.countedReservations}</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold" data-testid={`text-file-guests-${m.month}`}>{fmtN(m.reservedGuests)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtN(m.groupCount)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtN(m.groupPersons)}</td>
                {check && (
                  <td className="px-3 py-2 text-right tabular-nums font-semibold" data-testid={`text-merged-guests-${m.month}`}>
                    {k ? fmtN(k.merged.reservedGuests) : '—'}
                    {k && k.merged.largeGroupCount !== null && (
                      <span className="text-xs text-muted-foreground font-normal">
                        {' '}· {fmtN(k.merged.largeGroupCount)} Grp / {fmtN(k.merged.largeGroupPersons)} P
                      </span>
                    )}
                  </td>
                )}
                {check && (
                  <td className="px-3 py-2">
                    {k?.ok ? (
                      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-xs font-medium" data-testid={`status-check-${m.month}`}>
                        <CheckCircle2 className="h-3.5 w-3.5" /> OK
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 text-xs font-medium" data-testid={`status-check-${m.month}`}>
                        <AlertTriangle className="h-3.5 w-3.5" /> Abweichung
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  // ── Vorschau-Werte ──────────────────────────────────────────────────────────
  const stats = parsed?.stats ?? null;
  const skippedRows = parsed?.errors.filter(e => e.rowNumber > 0).length ?? 0;

  // ── Mandanten-Schutz ──────────────────────────────────────────────────────
  // Abgleich Datei-Restaurant ↔ aktiver Mandant. Erkannter, abweichender
  // Mandant → harter Stopp (Import-Button blockiert). Unbekannter/fehlender
  // Restaurant-Name → nur Warnung (Import bleibt möglich). Reine Logik.
  const tenantMatch = useMemo(
    () => parsed ? checkTenantMatch(parsed.dominantRestaurantName, tenantId) : null,
    [parsed, tenantId],
  );
  const importBlocked = tenantMatch?.block ?? false;

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
    <div className={embedded ? 'space-y-5' : 'mx-auto max-w-5xl p-4 md:p-6 space-y-5'}>
      {/* Kopf */}
      {!embedded && (
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
      )}

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

              {/* «CSV einfügen» — Alternative, falls der Datei-Dialog in der
                  eingebetteten Vorschau blockiert ist. */}
              <div className="rounded-xl border p-4 space-y-2">
                <p className="text-sm font-medium">… oder CSV-Inhalt einfügen</p>
                <CsvPasteBox
                  disabled={tablesOk === false}
                  testIdPrefix="reservation-csv-paste"
                  onText={(text, label) => processText(text, label)}
                />
              </div>

              {parseError && (
                <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 flex gap-2 text-sm text-red-700 dark:text-red-300">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>{parseError}</span>
                </div>
              )}

              {/* Letzter Import + «Rückgängig» (Snapshot der betroffenen Res.Nr.). */}
              <LastImportPanel
                source="reservationen-foratable"
                undoHint="Setzt die beim letzten Import geschriebenen Res.Nr. auf ihren Vorzustand zurück (neu importierte werden entfernt, ersetzte wiederhergestellt) und berechnet die Gäste-Statistik neu."
              />

              {/* Zentrale Zählregel für die Cockpit-Kennzahlen (pro Tenant). */}
              <ReservationCountingSettingsCard />

              {/* Take-Away-Angebot pro Tenant (steuert die TA-Cockpit-Zeilen). */}
              <TakeAwayOfferedSettingsCard />
            </div>
          )}

          {/* Schritt: Vorschau */}
          {step === 'preview' && parsed && stats && (
            <div className="space-y-5">
              <div className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{parsed.fileName}</span>
              </div>

              {/* Mandanten-Schutz: IMMER Datei-Restaurant + Ziel-Mandant zeigen. */}
              {tenantMatch && (
                <div
                  data-testid="banner-tenant-check"
                  className={cn(
                    'rounded-lg border p-3 text-sm',
                    tenantMatch.block
                      ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950/30 dark:text-red-200'
                      : tenantMatch.warn
                        ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200'
                        : 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200',
                  )}
                >
                  <div className="flex items-start gap-2">
                    {tenantMatch.block
                      ? <Ban className="h-4 w-4 flex-shrink-0 mt-0.5" />
                      : tenantMatch.warn
                        ? <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                        : <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5" />}
                    <div className="space-y-0.5">
                      <p>
                        Datei-Restaurant:{' '}
                        <span className="font-semibold" data-testid="text-file-restaurant">
                          {tenantMatch.fileRestaurant ?? '— (kein Wert)'}
                        </span>
                        {' · '}Ziel-Mandant:{' '}
                        <span className="font-semibold" data-testid="text-target-tenant">
                          {TENANT_LABELS[tenantId]}
                        </span>
                      </p>
                      {tenantMatch.message && (
                        <p className="font-medium" data-testid="text-tenant-message">{tenantMatch.message}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Upsert-Vorschau: dublettensicher über Res.Nr. (Ersetzen statt Duplikat) */}
              {diff && (
                <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="banner-upsert-preview">
                  <p className="font-semibold" data-testid="text-upsert-counts">
                    {diff.neu} neu · {diff.aktualisiert} aktualisiert · {diff.unveraendert} unverändert
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Schlüssel = Res.Nr. — dieselbe Res.Nr. wird ERSETZT, nie doppelt angelegt
                    (wiederholter Import ist gefahrlos). Vor dem Schreiben wird ein Backup erstellt.
                  </p>
                </div>
              )}

              {/* Selbstkontrolle (Vorschau): Datei-Summen je Monat nach zentraler Zählregel */}
              {fileMonths.length > 0 && (
                <div className="space-y-1.5" data-testid="section-selfcheck-preview">
                  <p className="text-sm font-semibold">Selbstkontrolle — Datei-Summen je Monat</p>
                  <p className="text-xs text-muted-foreground">
                    Gezählt werden nur Status {counting.countedStatuses.map(s => STATUS_LABELS[s]).join(' + ')};
                    storniert/abgelehnt/No-show/nicht beantwortet zählen nicht. Nach dem Import wird
                    jede Monatssumme gegen die Datenbank geprüft.
                  </p>
                  {monthTable(fileMonths)}
                </div>
              )}

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
                  disabled={importBlocked}
                  data-testid="button-import-reservations"
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
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

              {/* Selbstkontrolle nach dem Import */}
              <div className="w-full max-w-4xl mt-6 text-left space-y-2" data-testid="section-selfcheck-result">
                <p className="text-sm font-semibold">Selbstkontrolle — Datei ↔ Datenbank je Monat</p>
                {selfCheckLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Kontrolle läuft …
                  </div>
                ) : selfCheck ? (
                  <>
                    {selfCheck.error && (
                      <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 p-3 text-sm text-amber-800 dark:text-amber-300" data-testid="banner-selfcheck-error">
                        Kontrolle konnte nicht vollständig durchgeführt werden: {selfCheck.error}
                      </div>
                    )}
                    {!selfCheck.error && !selfCheck.allOk && (
                      <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300 flex gap-2" data-testid="banner-selfcheck-warning">
                        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                        <span>
                          Abweichung zwischen Datei und Datenbank — bitte prüfen. Der Import kann
                          im Bereich «Letzter Import» rückgängig gemacht werden.
                        </span>
                      </div>
                    )}
                    {!selfCheck.error && selfCheck.allOk && (
                      <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium" data-testid="text-selfcheck-ok">
                        Alle Monatssummen der Datei sind exakt in der Datenbank angekommen.
                      </p>
                    )}
                    {monthTable(selfCheck.rows.map(r => r.file), selfCheck)}
                    <p className="text-xs text-muted-foreground">
                      «Monat gesamt (nach Merge)» = alle Reservationen des Monats in der Datenbank
                      (bestehende + diese Datei, gleiche Res.Nr. ersetzt, nie doppelt) — entspricht
                      den Kennzahlen im Monatsreport/Cockpit.
                    </p>
                  </>
                ) : null}
              </div>

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
