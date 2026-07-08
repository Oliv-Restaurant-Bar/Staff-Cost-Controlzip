/**
 * TagesabschlussSection.tsx — Monatsübersicht Tagesabschlüsse (analog "UMSATZ Oliv").
 * ====================================================================================
 * Orchestriert: Z-Bericht-Tageswerte (read-only aus gn_*-Tabellen), manuelle
 * Eingaben/Korrekturen/Barausgaben (Blob `tagesabschluss_v1`, localStorage +
 * KV-Backup mit merge-on-save) und die gemeinsame Tagesbestätigung aus dem
 * Adyen-Blob `adyenAbstimmung_v1`. Buchhaltungs-CSV analog Excel "Tabelle2".
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Download, FileSpreadsheet, Info, Lock, LockOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { usePermissions } from '@/hooks/usePermissions';
import { useAuth } from '@/hooks/useAuth';
import type { TenantId } from '@/contexts/TenantContext';
import {
  ADYEN_ABSTIMMUNG_UPDATED_EVENT,
  loadAdyenAbstimmung, loadAdyenAbstimmungLocal, saveAdyenAbstimmung,
} from '@/lib/adyen-abstimmung-db';
import {
  emptyAdyenBlob, setDayConfirmation,
  type AdyenAbstimmungBlob, type DayConfirmation,
} from '@/lib/adyen-abstimmung';
import {
  buildTagesabschlussRows,
  canCloseMonth,
  closeDay,
  closeMonth,
  isMonthClosed,
  mergeTagesabschlussBlobs,
  readyForBuchhaltung,
  removeExpense,
  reopenDay,
  reopenMonth,
  resolveKassensaldoStart,
  setAnfangsbestand,
  emptyTagesabschlussBlob,
  setCashDiffReasons,
  setExportSettings,
  setSaldoAnker,
  setTagesabschlussComment,
  setTagesabschlussOverride,
  tagesabschlussMonthKey,
  upsertExpense,
  upsertInlineExpense,
  upsertManualDay,
  type CashExpense,
  type GnDayClosing,
  type KassensaldoStartResolution,
  type TagesabschlussAutoField,
  type TagesabschlussBlob,
  type TagesabschlussExportSettings,
  type TagesabschlussManualPatch,
} from '@/lib/tagesabschluss';
import { loadTagesabschluss, saveTagesabschluss } from '@/lib/tagesabschluss-db';
import { loadGnDayClosingsForMonth } from '@/lib/gn-zbericht-db';
import { fmtChf, fmtDiffChf, parseAmountInput } from './adyen-ui';
import { exportTagesabschlussExcel } from '@/lib/tagesabschluss-excel-export';
import { BuchhaltungsExportSection } from './BuchhaltungsExportSection';
import { TagesabschlussTable, formatClosedStamp } from './TagesabschlussTable';
import { TagesabschlussDayDialog } from './TagesabschlussDayDialog';
import { TagesabschlussExpenseDialog } from './TagesabschlussExpenseDialog';
import { TagesabschlussExportDialog } from './TagesabschlussExportDialog';
import { TagesabschlussReasonDialog } from './TagesabschlussReasonDialog';
import {
  TagesabschlussOverrideDialog,
  type OverrideDialogContext,
  type OverrideDialogPayload,
  type TagesabschlussOverrideField,
} from './TagesabschlussOverrideDialog';
import {
  TagesabschlussVoucherDialog,
  type VoucherDialogContext,
  type VoucherDialogPayload,
  type VoucherKind,
} from './TagesabschlussVoucherDialog';

const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

interface TagesabschlussSectionProps {
  tenantId: TenantId;
  year: number;
}

export function TagesabschlussSection({ tenantId, year }: TagesabschlussSectionProps) {
  const { isAdmin, isGuest } = usePermissions();
  const { user } = useAuth();
  const readOnly = isGuest;
  /** Wiederöffnen abgeschlossener Tage/Monate: NUR echte Admins, keine Gäste. */
  const canReopen = isAdmin && !isGuest;
  /** Benutzer für Abschluss-Historie/Audit (E-Mail). */
  const currentUser = user?.email ?? 'unbekannt';

  const today = new Date();
  const [month, setMonth] = useState<number>(() =>
    year === today.getFullYear() ? today.getMonth() + 1 : 12,
  );
  const [blob, setBlob] = useState<TagesabschlussBlob | null>(null);
  const [adyenBlob, setAdyenBlob] = useState<AdyenAbstimmungBlob | null>(null);
  const [closings, setClosings] = useState<Record<string, GnDayClosing>>({});
  const [loading, setLoading] = useState(true);
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [openExpensesDate, setOpenExpensesDate] = useState<string | null>(null);
  const [voucherCtx, setVoucherCtx] = useState<VoucherDialogContext | null>(null);
  const [overrideCtx, setOverrideCtx] = useState<OverrideDialogContext | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [reasonDate, setReasonDate] = useState<string | null>(null);
  /** null = Auflösung läuft noch; startSaldo null = kein Anker gefunden. */
  const [saldoResolution, setSaldoResolution] = useState<KassensaldoStartResolution | null>(null);
  const [anfangsbestandText, setAnfangsbestandText] = useState('');
  /** Anfangsbestand nachträglich bearbeiten (Banner sichtbar trotz Anker). */
  const [editAnfangsbestand, setEditAnfangsbestand] = useState(false);
  /** Voll-Ansicht (alle Spalten) — Standard ist die kompakte Ansicht. */
  const [showAllColumns, setShowAllColumns] = useState(false);
  /** Aufklappbereich „Weitere Kennzahlen" (Detail-KPIs, standardmässig zu). */
  const [showMoreKpis, setShowMoreKpis] = useState(false);
  /** Kompakte Anfangsbestand-Warnung aufgeklappt (Eingabe + Details sichtbar). */
  const [anfangsbestandOpen, setAnfangsbestandOpen] = useState(false);

  // Jahr-Wechsel: Monat sinnvoll nachziehen.
  useEffect(() => {
    setMonth(year === today.getFullYear() ? today.getMonth() + 1 : 12);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  // Blobs laden (tenant-scoped).
  useEffect(() => {
    let alive = true;
    setBlob(null);
    setAdyenBlob(null);
    loadTagesabschluss(tenantId).then(b => { if (alive) setBlob(b); });
    loadAdyenAbstimmung(tenantId).then(b => { if (alive) setAdyenBlob(b); });
    return () => { alive = false; };
  }, [tenantId]);

  // Z-Bericht-Tagesabschlüsse des Monats laden (read-only).
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setClosings({});
    setEditAnfangsbestand(false);
    setAnfangsbestandOpen(false);
    setAnfangsbestandText('');
    loadGnDayClosingsForMonth(tenantId, year, month).then(data => {
      if (!alive) return;
      setClosings(data);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [tenantId, year, month]);

  // Adyen-Blob-Stand nachziehen, wenn IRGENDEINE Section ihn speichert
  // (AdyenAbgleichSection teilt sich denselben Blob auf derselben Seite).
  useEffect(() => {
    const onUpdated = () => setAdyenBlob(loadAdyenAbstimmungLocal(tenantId));
    window.addEventListener(ADYEN_ABSTIMMUNG_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(ADYEN_ABSTIMMUNG_UPDATED_EVENT, onUpdated);
  }, [tenantId]);

  // Kassensaldo-Anker auflösen: expliziter Anfangsbestand dieses Monats oder
  // Kette vom jüngsten früheren Anfangsbestand vorwärts — lückenlos über
  // Monats- UND Jahreswechsel. KEINE stille 0-Annahme — ohne Anker bleiben
  // alle Saldi „—" und der Banner fordert einen Anfangsbestand an.
  useEffect(() => {
    if (!blob) { setSaldoResolution(null); return; }
    let alive = true;
    setSaldoResolution(null);
    resolveKassensaldoStart(year, month, blob, (y, m) => loadGnDayClosingsForMonth(tenantId, y, m))
      .then(res => { if (alive) setSaldoResolution(res); });
    return () => { alive = false; };
  }, [tenantId, year, month, blob]);

  const persist = useCallback(async (next: TagesabschlussBlob) => {
    setBlob(next);
    const merged = await saveTagesabschluss(tenantId, next);
    // Funktional gegen den AKTUELLEN State mergen: bei schnellen
    // aufeinanderfolgenden Inline-Edits darf ein früherer (langsamer) Save
    // einen neueren Edit nicht aus dem React-State verdrängen.
    setBlob(prev => (prev ? mergeTagesabschlussBlobs(prev, merged) : merged));
  }, [tenantId]);

  // ── Mutationen (Blob tagesabschluss_v1) ─────────────────────────────────────

  /**
   * Definitiv abgeschlossene (nicht wieder geöffnete) Tage sind GESPERRT —
   * jede Wert-Mutation prüft das zusätzlich zur ausgeblendeten UI (Guard
   * gegen veraltete Dialoge/Race mit gerade erfolgtem Abschluss).
   */
  const isDayLocked = useCallback((date: string): boolean => {
    const c = blob?.abschluesse[date];
    return !!c && c.status !== 'wieder_geoeffnet';
  }, [blob]);

  const handleSaveManual = useCallback((date: string, patch: TagesabschlussManualPatch) => {
    if (readOnly || !blob || isDayLocked(date)) return;
    // Patch 1:1 durchreichen: upsertManualDay fasst NUR vorhandene Keys an —
    // Inline-Edits eines einzelnen Felds löschen so keine anderen Werte.
    void persist(upsertManualDay(blob, date, patch, new Date().toISOString()));
  }, [readOnly, blob, isDayLocked, persist]);

  const handleOverride = useCallback((date: string, field: TagesabschlussAutoField, original: number, corrected: number | null, comment: string) => {
    if (readOnly || !blob || isDayLocked(date)) return;
    void persist(setTagesabschlussOverride(blob, date, field, original, corrected, comment, new Date().toISOString()));
  }, [readOnly, blob, isDayLocked, persist]);

  /**
   * Inline-Korrektur Debitoren aus der Tabelle: Wert gleich Original (oder
   * Leereingabe) entfernt die Korrektur; der bestehende Override-Kommentar
   * bleibt erhalten (prevComment wird durchgereicht).
   */
  const handleCorrectRechnung = useCallback((date: string, original: number, corrected: number | null, prevComment: string | undefined) => {
    if (readOnly || !blob || isDayLocked(date)) return;
    const next = corrected !== null && Math.abs(corrected - original) < 0.005 ? null : corrected;
    void persist(setTagesabschlussOverride(blob, date, 'rechnung', original, next, prevComment, new Date().toISOString()));
  }, [readOnly, blob, isDayLocked, persist]);

  /**
   * Inline-Korrektur weiterer Auto-Felder aus der Tabelle (KK „karten",
   * Gutschein-Beträge) — identische Semantik wie Debitoren: Wert gleich
   * Original (oder Leereingabe) entfernt die Korrektur, der bestehende
   * Override-Kommentar bleibt erhalten.
   */
  const handleInlineCorrect = useCallback((
    date: string,
    field: 'karten' | 'gutscheinVerkauft' | 'gutscheinEingeloest',
    original: number,
    corrected: number | null,
    prevComment: string | undefined,
  ) => {
    if (readOnly || !blob || isDayLocked(date)) return;
    const next = corrected !== null && Math.abs(corrected - original) < 0.005 ? null : corrected;
    void persist(setTagesabschlussOverride(blob, date, field, original, next, prevComment, new Date().toISOString()));
  }, [readOnly, blob, isDayLocked, persist]);

  /**
   * Barausgaben-Total inline (generische Inline-Ausgabe) — nur solange keine
   * itemisierten Ausgaben existieren (Tabelle gated via row.inlineExpenseOnly,
   * upsertInlineExpense fasst andere Ausgaben ohnehin nie an).
   */
  const handleInlineExpense = useCallback((date: string, amount: number | null) => {
    if (readOnly || !blob || isDayLocked(date)) return;
    void persist(upsertInlineExpense(blob, date, amount, new Date().toISOString()));
  }, [readOnly, blob, isDayLocked, persist]);

  /** Manueller Kassensaldo-Tagesanker (null = Anker entfernen, Kette gilt wieder). */
  const handleSetSaldoAnker = useCallback((date: string, value: number | null) => {
    if (readOnly || !blob || isDayLocked(date)) return;
    void persist(setSaldoAnker(blob, date, value, new Date().toISOString()));
  }, [readOnly, blob, isDayLocked, persist]);

  const handleUpsertExpense = useCallback((expense: CashExpense) => {
    if (readOnly || !blob || isDayLocked(expense.date)) return;
    void persist(upsertExpense(blob, expense));
  }, [readOnly, blob, isDayLocked, persist]);

  const handleRemoveExpense = useCallback((date: string, id: string) => {
    if (readOnly || !blob || isDayLocked(date)) return;
    void persist(removeExpense(blob, date, id, new Date().toISOString()));
  }, [readOnly, blob, isDayLocked, persist]);

  const handleSaveSettings = useCallback((settings: TagesabschlussExportSettings) => {
    if (readOnly || !blob) return;
    void persist(setExportSettings(blob, settings));
  }, [readOnly, blob, persist]);

  /** Differenzgründe + Notiz eines Tages speichern (beides leer = entfernen). */
  const handleSaveReasons = useCallback((date: string, reasons: string[], note: string) => {
    if (readOnly || !blob || isDayLocked(date)) return;
    void persist(setCashDiffReasons(blob, date, reasons, note, new Date().toISOString()));
  }, [readOnly, blob, isDayLocked, persist]);

  /** Kassensaldo-Anfangsbestand für DIESEN Monat erfassen/bearbeiten (Banner). */
  const handleSaveAnfangsbestand = useCallback(() => {
    if (readOnly || !blob) return;
    const parsed = parseAmountInput(anfangsbestandText);
    if (parsed === null) return;
    const monthKey = tagesabschlussMonthKey(year, month);
    void persist(setAnfangsbestand(blob, monthKey, parsed, new Date().toISOString()));
    setAnfangsbestandText('');
    setEditAnfangsbestand(false);
  }, [readOnly, blob, anfangsbestandText, year, month, persist]);

  /** Anfangsbestand nachträglich bearbeiten (nur Admin — Seite ist admin-gated,
   *  Gäste sind readOnly): öffnet den Banner vorbefüllt; Speichern setzt einen
   *  expliziten Anker für DIESEN Monat (überschreibt die Ketten-Ableitung). */
  const handleEditAnfangsbestand = useCallback(() => {
    if (readOnly || !blob) return;
    const monthKey = tagesabschlussMonthKey(year, month);
    // Tombstone (deleted) = kein expliziter Anfangsbestand mehr.
    const entry = blob.anfangsbestand[monthKey];
    const explicit = (entry && !entry.deleted ? entry.value : null) ?? saldoResolution?.startSaldo ?? null;
    setAnfangsbestandText(explicit === null ? '' : explicit.toFixed(2));
    setEditAnfangsbestand(true);
  }, [readOnly, blob, year, month, saldoResolution]);

  // ── Bestätigung (gemeinsamer Adyen-Store) ───────────────────────────────────

  const handleConfirm = useCallback(async (date: string, confirmation: DayConfirmation | null) => {
    if (readOnly || isDayLocked(date)) return;
    // IMMER den frischen Primärspeicher-Stand mutieren — NIE den Mount-Zeit-
    // State: sonst überschreibt diese Section stille Änderungen des
    // Adyen-Abgleichs (Importe/Overrides/Kommentare) auf derselben Seite.
    const next = setDayConfirmation(loadAdyenAbstimmungLocal(tenantId), date, confirmation);
    setAdyenBlob(next);
    await saveAdyenAbstimmung(tenantId, next);
  }, [readOnly, isDayLocked, tenantId]);

  // ── Zeilen bauen ────────────────────────────────────────────────────────────

  const monthData = useMemo(() => {
    const b = blob ?? emptyTagesabschlussBlob();
    const ab = adyenBlob ?? emptyAdyenBlob();
    return buildTagesabschlussRows(
      year, month, closings, b, ab.confirmations, ab,
      saldoResolution?.startSaldo ?? null,
    );
  }, [blob, adyenBlob, closings, year, month, saldoResolution]);

  // ── Tages-/Monatsabschluss (Sperr-Mechanismus) ──────────────────────────────

  const handleCloseDay = useCallback((date: string) => {
    if (readOnly || !blob) return;
    const row = monthData.rows.find(r => r.date === date);
    if (!row) return;
    try {
      void persist(closeDay(blob, row, currentUser, new Date().toISOString()));
    } catch (e) {
      // canCloseDay gate liegt in der UI (Button disabled) — Race/Alt-Dialog.
      console.error('[Tagesabschluss] Tagesabschluss nicht möglich:', e);
    }
  }, [readOnly, blob, monthData, currentUser, persist]);

  const handleReopenDay = useCallback((date: string, reason: string) => {
    if (!canReopen || !blob) return;
    try {
      void persist(reopenDay(blob, date, currentUser, reason, new Date().toISOString()));
    } catch (e) {
      console.error('[Tagesabschluss] Wiederöffnen nicht möglich:', e);
    }
  }, [canReopen, blob, currentUser, persist]);

  const monthKey = tagesabschlussMonthKey(year, month);
  const monthClosure = blob?.monatsabschluesse[monthKey] ?? null;
  const monthClosed = !!blob && isMonthClosed(blob, monthKey);
  const closeMonthCheck = useMemo(
    () => canCloseMonth(monthData, monthClosed),
    [monthData, monthClosed],
  );
  const monthReady = useMemo(() => readyForBuchhaltung(monthData), [monthData]);

  const handleCloseMonth = useCallback(() => {
    if (readOnly || !blob) return;
    try {
      void persist(closeMonth(blob, monthKey, monthData, currentUser, new Date().toISOString()));
    } catch (e) {
      console.error('[Tagesabschluss] Monatsabschluss nicht möglich:', e);
    }
  }, [readOnly, blob, monthKey, monthData, currentUser, persist]);

  const handleReopenMonth = useCallback(() => {
    if (!canReopen || !blob) return;
    try {
      void persist(reopenMonth(blob, monthKey, currentUser, new Date().toISOString()));
    } catch (e) {
      console.error('[Tagesabschluss] Monat wiederöffnen nicht möglich:', e);
    }
  }, [canReopen, blob, monthKey, currentUser, persist]);

  const openRow = openDate ? monthData.rows.find(r => r.date === openDate) ?? null : null;
  const openExpenses = openDate ? (blob?.expenses[openDate] ?? []).filter(e => !e.deleted) : [];
  const voucherRow = voucherCtx ? monthData.rows.find(r => r.date === voucherCtx.date) ?? null : null;
  const overrideRow = overrideCtx ? monthData.rows.find(r => r.date === overrideCtx.date) ?? null : null;
  const dialogExpenses = openExpensesDate ? (blob?.expenses[openExpensesDate] ?? []).filter(e => !e.deleted) : [];

  /**
   * Gutschein-Dialog speichert Betrag (Override), Nummern (manuelles Feld)
   * und Feld-Kommentar in EINEM persist auf EINEM Blob-Zwischenstand —
   * kein Dreifach-Save, keine Race zwischen den Teil-Mutationen.
   */
  const handleVoucherSave = useCallback((date: string, kind: VoucherKind, payload: VoucherDialogPayload) => {
    if (readOnly || !blob || isDayLocked(date)) { setVoucherCtx(null); return; }
    const field: TagesabschlussAutoField = kind === 'eingeloest' ? 'gutscheinEingeloest' : 'gutscheinVerkauft';
    const cell = monthData.rows.find(r => r.date === date)?.cells[field];
    const now = new Date().toISOString();
    const original = cell?.override?.originalValue ?? cell?.auto ?? 0;
    // Betrag gleich Original (oder leer) → Korrektur entfernen, Z-Bericht gilt.
    const corrected = payload.betrag !== null && Math.abs(payload.betrag - original) < 0.005 ? null : payload.betrag;
    let next = setTagesabschlussOverride(blob, date, field, original, corrected, cell?.override?.comment, now);
    next = upsertManualDay(next, date,
      kind === 'eingeloest'
        ? { gutscheinNummernEingeloest: payload.nummern }
        : { gutscheinNummernVerkauft: payload.nummern },
      now);
    next = setTagesabschlussComment(next, date, field, payload.kommentar, now);
    void persist(next);
    setVoucherCtx(null);
  }, [readOnly, blob, isDayLocked, monthData, persist]);

  /** Override-Popup speichern („KK Adyen Ist" → `karten`, „Umsatz Ist" →
   *  `umsatz`): Erst-Original verankert, Betrag == Original (oder leer)
   *  entfernt die Korrektur; Override + Kommentar in EINEM persist. */
  const handleOverrideSave = useCallback((date: string, field: TagesabschlussOverrideField, payload: OverrideDialogPayload) => {
    if (readOnly || !blob || isDayLocked(date)) { setOverrideCtx(null); return; }
    const cell = monthData.rows.find(r => r.date === date)?.cells[field];
    const now = new Date().toISOString();
    const original = cell?.override?.originalValue ?? cell?.auto ?? 0;
    const corrected = payload.betrag !== null && Math.abs(payload.betrag - original) < 0.005 ? null : payload.betrag;
    let next = setTagesabschlussOverride(blob, date, field, original, corrected, cell?.override?.comment, now);
    next = setTagesabschlussComment(next, date, field, payload.kommentar, now);
    void persist(next);
    setOverrideCtx(null);
  }, [readOnly, blob, isDayLocked, monthData, persist]);

  /** „+ Tagesabschluss": Tagesdetail für heute (im angezeigten Monat), sonst
      für den ersten offenen/in Bearbeitung befindlichen Tag öffnen. */
  const handleAddTagesabschluss = useCallback(() => {
    const p = (n: number) => String(n).padStart(2, '0');
    const todayStr = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    const target = monthData.rows.find(r => r.date === todayStr)
      ?? monthData.rows.find(r => r.status === 'offen' || r.status === 'in_bearbeitung')
      ?? monthData.rows[0];
    if (target) setOpenDate(target.date);
  }, [monthData, today]);

  return (
    <>
    <Card className="mt-2">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-sm">Tagesabschluss-Übersicht</CardTitle>
            <span
              title={'Z-Bericht-Werte automatisch, manuelle Eingaben/Korrekturen pro Tag, Buchhaltungs-Export analog Excel "Tabelle2". Cash, Einzahlung Bank und Debitoren direkt in der Tabelle erfassen; Gutschein- und Barausgaben-Zellen öffnen ihren eigenen Dialog — Datum anklicken für das komplette Tagesdetail (Bemerkung, Korrekturen).'}
              className="text-muted-foreground cursor-help"
              data-testid="ta-section-info"
            >
              <Info className="h-3.5 w-3.5" aria-label="Hinweise zur Bedienung" />
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1 rounded-md border border-border px-1 py-0.5">
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0"
                onClick={() => setMonth(m => Math.max(1, m - 1))} disabled={month <= 1}
                aria-label="Vormonat">
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs font-medium w-24 text-center">{MONTH_NAMES[month - 1]} {year}</span>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0"
                onClick={() => setMonth(m => Math.min(12, m + 1))} disabled={month >= 12}
                aria-label="Folgemonat">
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs"
                onClick={() => setMonth(today.getMonth() + 1)}
                disabled={year !== today.getFullYear() || month === today.getMonth() + 1}
                title={year === today.getFullYear()
                  ? 'Zum aktuellen Monat springen'
                  : 'Heute liegt nicht im gewählten Jahr (Jahr oben rechts wechseln)'}
                data-testid="ta-heute">
                Heute
              </Button>
            </div>
            <Button variant="outline" size="sm" className="h-7 text-xs"
              onClick={() => exportTagesabschlussExcel(monthData, monthKey)}
              disabled={loading || !monthData.rows.some(r => r.status !== 'fehlt')}
              title="Übersicht des Monats als Excel-Datei (.xlsx) herunterladen"
              data-testid="ta-excel-export">
              <Download className="h-3.5 w-3.5 mr-1" />
              Excel
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs"
              onClick={() => setExportOpen(true)} data-testid="ta-open-export">
              <FileSpreadsheet className="h-3.5 w-3.5 mr-1" />
              Buchhaltung
            </Button>
            {!readOnly && (
              <Button size="sm" className="h-7 text-xs"
                onClick={handleAddTagesabschluss}
                disabled={loading || monthData.rows.length === 0}
                title="Tagesdetail für heute bzw. den ersten offenen Tag öffnen"
                data-testid="ta-add-abschluss">
                <Plus className="h-3.5 w-3.5 mr-1" />
                Tagesabschluss
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading || !blob || !adyenBlob ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Lade Tagesabschlüsse…</p>
        ) : (
          <>
            {saldoResolution !== null && (saldoResolution.startSaldo === null || editAnfangsbestand) && (() => {
              const expanded = anfangsbestandOpen || editAnfangsbestand || readOnly;
              return (
                <div
                  className="mb-2 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-1.5"
                  data-testid="ta-anfangsbestand-banner"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                      {saldoResolution.startSaldo === null
                        ? <>Anfangsbestand fehlt — Kassensaldo für {MONTH_NAMES[month - 1]} {year} kann nicht berechnet werden</>
                        : <>Kassen-Anfangsbestand für {MONTH_NAMES[month - 1]} {year} bearbeiten</>}
                    </p>
                    {!readOnly && !expanded && (
                      <Button size="sm" className="h-6 text-xs shrink-0"
                        onClick={() => setAnfangsbestandOpen(true)}
                        data-testid="ta-anfangsbestand-erfassen">
                        Erfassen
                      </Button>
                    )}
                  </div>
                  {expanded && (
                    <>
                      <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-0.5">
                        {saldoResolution.startSaldo === null
                          ? <>Ohne Anfangsbestand (Bargeld in der Kasse am Monatsbeginn) kann kein fortlaufender
                              Kassensaldo berechnet werden — Kassensaldo Soll und Cash Diff bleiben leer.
                              Es wird bewusst KEINE 0 angenommen.</>
                          : <>Speichern setzt einen expliziten Anfangsbestand für diesen Monat und übersteuert
                              den aus den Vormonaten fortgeschriebenen Saldo. Alle Folgesalden werden
                              automatisch neu berechnet.</>}
                      </p>
                      {!readOnly && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <input
                            type="text"
                            inputMode="decimal"
                            className="h-7 w-32 rounded border border-input bg-background px-2 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
                            placeholder="z. B. 500.00"
                            value={anfangsbestandText}
                            onChange={e => setAnfangsbestandText(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleSaveAnfangsbestand(); }}
                            aria-label={`Anfangsbestand ${MONTH_NAMES[month - 1]} ${year}`}
                            data-testid="ta-anfangsbestand-input"
                          />
                          <Button size="sm" className="h-7 text-xs"
                            onClick={handleSaveAnfangsbestand}
                            disabled={parseAmountInput(anfangsbestandText) === null}
                            data-testid="ta-anfangsbestand-save">
                            Anfangsbestand speichern
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs"
                            onClick={() => { setEditAnfangsbestand(false); setAnfangsbestandOpen(false); setAnfangsbestandText(''); }}
                            data-testid="ta-anfangsbestand-cancel">
                            Abbrechen
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}
            {/* ── KPI-Chips (kompakt) + Aufklappbereich „Weitere Kennzahlen" ── */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-baseline gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs" data-testid="ta-kpi-confirmed">
                <span className="text-muted-foreground">Abgeschlossen</span>
                <span className="font-semibold tabular-nums">
                  {monthData.totals.daysAbgeschlossen + monthData.totals.daysAbgeschlossenMitDifferenz}/{monthData.totals.daysWithZbericht}
                </span>
              </span>
              <span className="inline-flex items-baseline gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs" data-testid="ta-kpi-open">
                <span className="text-muted-foreground">Offen</span>
                <span className={`font-semibold tabular-nums ${monthData.totals.daysOpen > 0 ? 'text-red-700 dark:text-red-400' : ''}`}>
                  {monthData.totals.daysOpen}
                </span>
              </span>
              <span className="inline-flex items-baseline gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs" data-testid="ta-kpi-diff">
                <span className="text-muted-foreground">Differenzen</span>
                <span className={`font-semibold tabular-nums ${monthData.totals.daysWithDiff > 0 ? 'text-red-700 dark:text-red-400' : ''}`}>
                  {monthData.totals.daysWithDiff}
                </span>
              </span>
              <span className="inline-flex items-baseline gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs"
                title={'Kassensaldo (Soll) am Monatsende; „—" solange kein Anfangsbestand bekannt ist'}
                data-testid="ta-kpi-saldo-ende">
                <span className="text-muted-foreground">Kassensaldo Ende</span>
                <span className="font-semibold tabular-nums">
                  {monthData.totals.kassensaldoEnde === null
                    ? <span className="text-muted-foreground font-normal">—</span>
                    : <>CHF {fmtChf(monthData.totals.kassensaldoEnde)}</>}
                </span>
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
                onClick={() => setShowMoreKpis(v => !v)}
                aria-expanded={showMoreKpis}
                data-testid="ta-kpi-more-toggle"
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showMoreKpis ? 'rotate-180' : ''}`} aria-hidden="true" />
                Weitere Kennzahlen
              </button>
              <button
                type="button"
                className="ml-auto rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent hover:text-accent-foreground cursor-pointer"
                onClick={() => setShowAllColumns(v => !v)}
                title={showAllColumns
                  ? 'Kompakte Ansicht: blendet KK, Einzahlung Bank, Cash Ist und Cash Diff aus'
                  : 'Voll-Ansicht: zeigt zusätzlich KK, Einzahlung Bank, Cash Ist und Cash Diff'}
                data-testid="ta-columns-toggle"
              >
                {showAllColumns ? 'Kompakte Ansicht' : 'Alle Spalten anzeigen'}
              </button>
            </div>
            {showMoreKpis && (
              <div className="mb-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2" data-testid="ta-kpi-more">
                <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-in-bearbeitung">
                  <p className="text-[10px] text-muted-foreground">Tage in Bearbeitung</p>
                  <p className="text-sm font-semibold tabular-nums">{monthData.totals.daysInBearbeitung}</p>
                </div>
                <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-wieder-geoeffnet">
                  <p className="text-[10px] text-muted-foreground">Tage wieder geöffnet</p>
                  <p className={`text-sm font-semibold tabular-nums ${monthData.totals.daysWiederGeoeffnet > 0 ? 'text-orange-700 dark:text-orange-400' : ''}`}>
                    {monthData.totals.daysWiederGeoeffnet}
                  </p>
                </div>
                <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-begruendet">
                  <p className="text-[10px] text-muted-foreground">Tage mit begründeter Differenz</p>
                  <p className={`text-sm font-semibold tabular-nums ${monthData.totals.daysBegruendet > 0 ? 'text-teal-700 dark:text-teal-400' : ''}`}>
                    {monthData.totals.daysBegruendet}
                  </p>
                </div>
                <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-unbegruendet">
                  <p className="text-[10px] text-muted-foreground">Tage mit unbegründeter Differenz</p>
                  <p className={`text-sm font-semibold tabular-nums ${monthData.totals.daysUnbegruendet > 0 ? 'text-red-700 dark:text-red-400' : ''}`}>
                    {monthData.totals.daysUnbegruendet}
                  </p>
                </div>
                <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-needs-review">
                  <p className="text-[10px] text-muted-foreground">Tage mit Saldo-Überprüfung</p>
                  <p className={`text-sm font-semibold tabular-nums ${monthData.totals.daysNeedsReview > 0 ? 'text-amber-700 dark:text-amber-400' : ''}`}>
                    {monthData.totals.daysNeedsReview}
                  </p>
                </div>
                <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-saldo-anfang">
                  <div className="flex items-center justify-between gap-1">
                    <p className="text-[10px] text-muted-foreground">Kassensaldo Anfang Monat</p>
                    {!readOnly && (
                      <button
                        type="button"
                        className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                        onClick={handleEditAnfangsbestand}
                        title="Kassen-Anfangsbestand dieses Monats bearbeiten (nur Admin)"
                        data-testid="ta-anfangsbestand-edit"
                      >
                        ändern
                      </button>
                    )}
                  </div>
                  <p className="text-sm font-semibold tabular-nums">
                    {saldoResolution === null || saldoResolution.startSaldo === null
                      ? <span className="text-muted-foreground font-normal">—</span>
                      : <>CHF {fmtChf(saldoResolution.startSaldo)}</>}
                  </p>
                </div>
                <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-bargeld">
                  <p className="text-[10px] text-muted-foreground">Total Bargeld (Soll)</p>
                  <p className="text-sm font-semibold tabular-nums">CHF {fmtChf(monthData.totals.bargeldSoll)}</p>
                </div>
                <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-barausgaben">
                  <p className="text-[10px] text-muted-foreground">Total Barausgaben</p>
                  <p className="text-sm font-semibold tabular-nums">CHF {fmtChf(monthData.totals.barausgaben)}</p>
                </div>
                <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-einzahlung">
                  <p className="text-[10px] text-muted-foreground">Total Einzahlung Bank</p>
                  <p className="text-sm font-semibold tabular-nums">CHF {fmtChf(monthData.totals.values.einzahlungBank)}</p>
                </div>
              </div>
            )}
            <TagesabschlussTable
              rows={monthData.rows}
              totals={monthData.totals}
              onDayClick={setOpenDate}
              readOnly={readOnly}
              onSaveManual={handleSaveManual}
              onCorrectRechnung={handleCorrectRechnung}
              onInlineCorrect={handleInlineCorrect}
              onInlineExpense={handleInlineExpense}
              onSetSaldoAnker={handleSetSaldoAnker}
              onVoucherClick={(date, kind) => setVoucherCtx({ date, kind })}
              onOverrideClick={(date, field) => setOverrideCtx({ date, field })}
              onExpensesClick={setOpenExpensesDate}
              onConfirm={handleConfirm}
              onReasonsClick={setReasonDate}
              onCloseDay={handleCloseDay}
              showAllColumns={showAllColumns}
            />
            <details className="mt-2 text-[10px] text-muted-foreground">
              <summary className="cursor-pointer select-none font-medium hover:text-foreground" data-testid="ta-legend-toggle">
                Legende &amp; Formeln
              </summary>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-[10px] text-muted-foreground">
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-100 dark:bg-amber-900/30 border border-amber-300 align-middle mr-1" />korrigiert</span>
              <span className="text-sky-700 dark:text-sky-400 font-medium">manuell erfasst</span>
              <span className="text-red-600 dark:text-red-400">negative Beträge</span>
              <span>normale Werte = automatisch aus dem Z-Bericht</span>
              <span>Adyen- und Cash-Differenz: grün ≤ 0.05 · orange ≤ 5 · rot &gt; 5 CHF</span>
              <span>Bargeld Soll = Umsatz − KK − Rechnung − Barausgaben − eingelöste Gutscheine + verkaufte Gutscheine</span>
              <span>Kassensaldo Soll = Saldo Vortag + Bargeld Soll − Einzahlung Bank · Cash Diff = Cash Ist − Kassensaldo Soll</span>
              <span>Kassensaldo Soll inline überschreiben = manueller Tages-Anker (gelb; Leereingabe entfernt ihn)</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-50 border border-green-300 align-middle mr-1" />Tag abgeschlossen (gesperrt)</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-yellow-50 border border-yellow-300 align-middle mr-1" />abgeschlossen mit Differenz</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-orange-50 border border-orange-300 align-middle mr-1" />wieder geöffnet</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-50 border border-red-300 align-middle mr-1" />offen / Differenz</span>
            </div>
            </details>

            {/* ── Monatsabschluss — Snapshot einfrieren, Monat sperren ── */}
            <div
              className={`mt-4 rounded-md border px-3 py-2.5 ${monthClosed
                ? 'border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/30'
                : monthClosure?.status === 'wieder_geoeffnet'
                  ? 'border-orange-300 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/30'
                  : 'border-border'}`}
              data-testid="ta-monatsabschluss"
            >
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  {monthClosed
                    ? <Lock className="h-3.5 w-3.5 text-green-700 dark:text-green-400" aria-hidden="true" />
                    : <LockOpen className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
                  <p className="text-xs font-semibold">
                    Monatsabschluss {MONTH_NAMES[month - 1]} {year}
                  </p>
                  {monthReady && !monthClosed && (
                    <span
                      className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                      data-testid="ta-monat-bereit"
                    >
                      Bereit für Buchhaltung
                    </span>
                  )}
                  {monthClosure?.status === 'wieder_geoeffnet' && (
                    <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300">
                      wieder geöffnet
                    </span>
                  )}
                </div>
                {!readOnly && (monthClosed
                  ? (canReopen && (
                    <Button variant="outline" size="sm" className="h-7 text-xs"
                      onClick={handleReopenMonth}
                      data-testid="ta-monat-reopen">
                      <LockOpen className="h-3.5 w-3.5 mr-1" />
                      Monat wieder öffnen (Admin)
                    </Button>
                  ))
                  : (
                    <Button size="sm" className="h-7 text-xs"
                      onClick={handleCloseMonth}
                      disabled={!closeMonthCheck.ok}
                      title={closeMonthCheck.ok
                        ? 'Monat abschließen — Kennzahlen werden eingefroren'
                        : closeMonthCheck.blockers.join(' ')}
                      data-testid="ta-monat-close">
                      <Lock className="h-3.5 w-3.5 mr-1" />
                      Monat abschließen
                    </Button>
                  ))}
              </div>
              {monthClosed && monthClosure && (
                <>
                  <p className="text-[10px] text-muted-foreground mt-1" data-testid="ta-monat-stamp">
                    Abgeschlossen {formatClosedStamp(monthClosure.closedAt)} von {monthClosure.closedBy} — Kennzahlen eingefroren, alle Tage gesperrt.
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 mt-2 text-[11px]" data-testid="ta-monat-snapshot">
                    <span>Anfangsbestand: <span className="font-medium tabular-nums">{monthClosure.snapshot.anfangsbestand === null ? '—' : fmtChf(monthClosure.snapshot.anfangsbestand)}</span></span>
                    <span>Endbestand: <span className="font-medium tabular-nums">{monthClosure.snapshot.endbestand === null ? '—' : fmtChf(monthClosure.snapshot.endbestand)}</span></span>
                    <span>Umsatz: <span className="font-medium tabular-nums">{fmtChf(monthClosure.snapshot.umsatzTotal)}</span></span>
                    <span>Bargeld Soll: <span className="font-medium tabular-nums">{fmtChf(monthClosure.snapshot.bargeldTotal)}</span></span>
                    <span>Barausgaben: <span className="font-medium tabular-nums">{fmtChf(monthClosure.snapshot.barausgabenTotal)}</span></span>
                    <span>Bankeinzahlungen: <span className="font-medium tabular-nums">{fmtChf(monthClosure.snapshot.bankeinzahlungenTotal)}</span></span>
                    <span>Cash-Differenzen: <span className="font-medium tabular-nums">{fmtDiffChf(monthClosure.snapshot.cashDiffTotal)}</span></span>
                    <span>begründete Differenzen: <span className="font-medium tabular-nums">{monthClosure.snapshot.begruendeteDifferenzen}</span></span>
                  </div>
                </>
              )}
              {!monthClosed && !closeMonthCheck.ok && (
                <p className="text-[10px] text-muted-foreground mt-1" data-testid="ta-monat-blockers">
                  {closeMonthCheck.blockers.join(' ')}
                </p>
              )}
              {monthClosure?.status === 'wieder_geoeffnet' && monthClosure.reopenedAt && (
                <p className="text-[10px] text-orange-700 dark:text-orange-400 mt-1">
                  Wieder geöffnet {formatClosedStamp(monthClosure.reopenedAt)} von {monthClosure.reopenedBy ?? '—'} — Tage können erneut abgeschlossen werden.
                </p>
              )}
            </div>
          </>
        )}
      </CardContent>

      <TagesabschlussDayDialog
        row={openRow}
        expenses={openExpenses}
        readOnly={readOnly}
        canReopen={canReopen}
        onClose={() => setOpenDate(null)}
        onSaveManual={handleSaveManual}
        onOverride={handleOverride}
        onConfirm={handleConfirm}
        onUpsertExpense={handleUpsertExpense}
        onRemoveExpense={handleRemoveExpense}
        onCloseDay={handleCloseDay}
        onReopenDay={handleReopenDay}
      />

      <TagesabschlussExpenseDialog
        date={openExpensesDate}
        expenses={dialogExpenses}
        readOnly={readOnly}
        onClose={() => setOpenExpensesDate(null)}
        onUpsertExpense={handleUpsertExpense}
        onRemoveExpense={handleRemoveExpense}
      />

      <TagesabschlussVoucherDialog
        ctx={voucherCtx}
        row={voucherRow}
        readOnly={readOnly}
        onClose={() => setVoucherCtx(null)}
        onSave={handleVoucherSave}
      />

      <TagesabschlussOverrideDialog
        ctx={overrideCtx}
        row={overrideRow}
        readOnly={readOnly || (overrideCtx ? isDayLocked(overrideCtx.date) : false)}
        onClose={() => setOverrideCtx(null)}
        onSave={handleOverrideSave}
      />

      <TagesabschlussReasonDialog
        row={reasonDate ? monthData.rows.find(r => r.date === reasonDate) ?? null : null}
        readOnly={readOnly}
        onClose={() => setReasonDate(null)}
        onSave={handleSaveReasons}
      />

      {blob && (
        <TagesabschlussExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          year={year}
          month={month}
          rows={monthData.rows}
          closings={closings}
          blob={blob}
          readOnly={readOnly}
          onSaveSettings={handleSaveSettings}
        />
      )}
    </Card>

    {/* ── Buchhaltungs-Export-Assistent — eigener Abschnitt UNTER der Übersicht ── */}
    {!loading && blob && adyenBlob && (
      <BuchhaltungsExportSection
        tenantId={tenantId}
        year={year}
        month={month}
        monthKey={monthKey}
        monthData={monthData}
        closings={closings}
        blob={blob}
        readOnly={readOnly}
        currentUser={currentUser}
        persist={persist}
        onOpenMapping={() => setExportOpen(true)}
      />
    )}
    </>
  );
}
