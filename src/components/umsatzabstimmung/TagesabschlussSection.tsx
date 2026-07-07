/**
 * TagesabschlussSection.tsx — Monatsübersicht Tagesabschlüsse (analog "UMSATZ Oliv").
 * ====================================================================================
 * Orchestriert: Z-Bericht-Tageswerte (read-only aus gn_*-Tabellen), manuelle
 * Eingaben/Korrekturen/Barausgaben (Blob `tagesabschluss_v1`, localStorage +
 * KV-Backup mit merge-on-save) und die gemeinsame Tagesbestätigung aus dem
 * Adyen-Blob `adyenAbstimmung_v1`. Buchhaltungs-CSV analog Excel "Tabelle2".
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { usePermissions } from '@/hooks/usePermissions';
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
  mergeTagesabschlussBlobs,
  removeExpense,
  resolveKassensaldoStart,
  setAnfangsbestand,
  setCashDiffReasons,
  setExportSettings,
  setTagesabschlussComment,
  setTagesabschlussOverride,
  tagesabschlussMonthKey,
  upsertExpense,
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
import { TagesabschlussTable } from './TagesabschlussTable';
import { TagesabschlussDayDialog } from './TagesabschlussDayDialog';
import { TagesabschlussExpenseDialog } from './TagesabschlussExpenseDialog';
import { TagesabschlussExportDialog } from './TagesabschlussExportDialog';
import { TagesabschlussReasonDialog } from './TagesabschlussReasonDialog';
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
  const { isGuest } = usePermissions();
  const readOnly = isGuest;

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
  const [exportOpen, setExportOpen] = useState(false);
  const [reasonDate, setReasonDate] = useState<string | null>(null);
  /** null = Auflösung läuft noch; startSaldo null = kein Anker gefunden. */
  const [saldoResolution, setSaldoResolution] = useState<KassensaldoStartResolution | null>(null);
  const [anfangsbestandText, setAnfangsbestandText] = useState('');

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
  // Vormonats-Kette (max. 12 Monate). KEINE stille 0-Annahme — ohne Anker
  // bleiben alle Saldi „—" und der Banner fordert einen Anfangsbestand an.
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

  const handleSaveManual = useCallback((date: string, patch: TagesabschlussManualPatch) => {
    if (readOnly || !blob) return;
    // Patch 1:1 durchreichen: upsertManualDay fasst NUR vorhandene Keys an —
    // Inline-Edits eines einzelnen Felds löschen so keine anderen Werte.
    void persist(upsertManualDay(blob, date, patch, new Date().toISOString()));
  }, [readOnly, blob, persist]);

  const handleOverride = useCallback((date: string, field: TagesabschlussAutoField, original: number, corrected: number | null, comment: string) => {
    if (readOnly || !blob) return;
    void persist(setTagesabschlussOverride(blob, date, field, original, corrected, comment, new Date().toISOString()));
  }, [readOnly, blob, persist]);

  /**
   * Inline-Korrektur Debitoren aus der Tabelle: Wert gleich Original (oder
   * Leereingabe) entfernt die Korrektur; der bestehende Override-Kommentar
   * bleibt erhalten (prevComment wird durchgereicht).
   */
  const handleCorrectRechnung = useCallback((date: string, original: number, corrected: number | null, prevComment: string | undefined) => {
    if (readOnly || !blob) return;
    const next = corrected !== null && Math.abs(corrected - original) < 0.005 ? null : corrected;
    void persist(setTagesabschlussOverride(blob, date, 'rechnung', original, next, prevComment, new Date().toISOString()));
  }, [readOnly, blob, persist]);

  const handleUpsertExpense = useCallback((expense: CashExpense) => {
    if (readOnly || !blob) return;
    void persist(upsertExpense(blob, expense));
  }, [readOnly, blob, persist]);

  const handleRemoveExpense = useCallback((date: string, id: string) => {
    if (readOnly || !blob) return;
    void persist(removeExpense(blob, date, id));
  }, [readOnly, blob, persist]);

  const handleSaveSettings = useCallback((settings: TagesabschlussExportSettings) => {
    if (readOnly || !blob) return;
    void persist(setExportSettings(blob, settings));
  }, [readOnly, blob, persist]);

  /** Differenzgründe + Notiz eines Tages speichern (beides leer = entfernen). */
  const handleSaveReasons = useCallback((date: string, reasons: string[], note: string) => {
    if (readOnly || !blob) return;
    void persist(setCashDiffReasons(blob, date, reasons, note, new Date().toISOString()));
  }, [readOnly, blob, persist]);

  /** Kassensaldo-Anfangsbestand für DIESEN Monat erfassen (Banner). */
  const handleSaveAnfangsbestand = useCallback(() => {
    if (readOnly || !blob) return;
    const parsed = parseAmountInput(anfangsbestandText);
    if (parsed === null) return;
    const monthKey = tagesabschlussMonthKey(year, month);
    void persist(setAnfangsbestand(blob, monthKey, parsed, new Date().toISOString()));
    setAnfangsbestandText('');
  }, [readOnly, blob, anfangsbestandText, year, month, persist]);

  // ── Bestätigung (gemeinsamer Adyen-Store) ───────────────────────────────────

  const handleConfirm = useCallback(async (date: string, confirmation: DayConfirmation | null) => {
    if (readOnly) return;
    // IMMER den frischen Primärspeicher-Stand mutieren — NIE den Mount-Zeit-
    // State: sonst überschreibt diese Section stille Änderungen des
    // Adyen-Abgleichs (Importe/Overrides/Kommentare) auf derselben Seite.
    const next = setDayConfirmation(loadAdyenAbstimmungLocal(tenantId), date, confirmation);
    setAdyenBlob(next);
    await saveAdyenAbstimmung(tenantId, next);
  }, [readOnly, tenantId]);

  // ── Zeilen bauen ────────────────────────────────────────────────────────────

  const monthData = useMemo(() => {
    const b = blob ?? {
      days: {}, expenses: {}, overrides: {}, comments: {},
      cashDiffReasons: {}, anfangsbestand: {}, exportSettings: null,
    };
    const ab = adyenBlob ?? emptyAdyenBlob();
    return buildTagesabschlussRows(
      year, month, closings, b, ab.confirmations, ab,
      saldoResolution?.startSaldo ?? null,
    );
  }, [blob, adyenBlob, closings, year, month, saldoResolution]);

  const openRow = openDate ? monthData.rows.find(r => r.date === openDate) ?? null : null;
  const openExpenses = openDate ? (blob?.expenses[openDate] ?? []) : [];
  const voucherRow = voucherCtx ? monthData.rows.find(r => r.date === voucherCtx.date) ?? null : null;
  const dialogExpenses = openExpensesDate ? (blob?.expenses[openExpensesDate] ?? []) : [];

  /**
   * Gutschein-Dialog speichert Betrag (Override), Nummern (manuelles Feld)
   * und Feld-Kommentar in EINEM persist auf EINEM Blob-Zwischenstand —
   * kein Dreifach-Save, keine Race zwischen den Teil-Mutationen.
   */
  const handleVoucherSave = useCallback((date: string, kind: VoucherKind, payload: VoucherDialogPayload) => {
    if (readOnly || !blob) { setVoucherCtx(null); return; }
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
  }, [readOnly, blob, monthData, persist]);

  return (
    <Card className="mt-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-sm">Tagesabschluss-Übersicht — {MONTH_NAMES[month - 1]} {year}</CardTitle>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Z-Bericht-Werte automatisch, manuelle Eingaben/Korrekturen pro Tag, Buchhaltungs-Export analog Excel "Tabelle2".
              Cash, Einzahlung Bank und Debitoren direkt in der Tabelle erfassen; Gutschein- und Barausgaben-Zellen
              öffnen ihren eigenen Dialog — Datum anklicken für das komplette Tagesdetail (Bemerkung, Korrekturen).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                onClick={() => setMonth(m => Math.max(1, m - 1))} disabled={month <= 1}
                aria-label="Vormonat">
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs font-medium w-24 text-center">{MONTH_NAMES[month - 1]}</span>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                onClick={() => setMonth(m => Math.min(12, m + 1))} disabled={month >= 12}
                aria-label="Folgemonat">
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Button variant="outline" size="sm" className="h-7 text-xs"
              onClick={() => setExportOpen(true)} data-testid="ta-open-export">
              <FileSpreadsheet className="h-3.5 w-3.5 mr-1" />
              Buchhaltungs-Export
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading || !blob || !adyenBlob ? (
          <p className="text-xs text-muted-foreground py-4 text-center">Lade Tagesabschlüsse…</p>
        ) : (
          <>
            {saldoResolution !== null && saldoResolution.startSaldo === null && (
              <div
                className="mb-3 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2"
                data-testid="ta-anfangsbestand-banner"
              >
                <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                  Kassensaldo unbekannt — Anfangsbestand für {MONTH_NAMES[month - 1]} {year} erfassen
                </p>
                <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-0.5">
                  Ohne Anfangsbestand (Bargeld in der Kasse am Monatsbeginn) kann kein fortlaufender
                  Kassensaldo berechnet werden — Kassensaldo Soll und Cash Diff bleiben leer.
                  Es wird bewusst KEINE 0 angenommen.
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
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-3">
              <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-confirmed">
                <p className="text-[10px] text-muted-foreground">Tage abgeschlossen</p>
                <p className="text-sm font-semibold tabular-nums">
                  {monthData.totals.daysConfirmed}
                  <span className="text-[10px] font-normal text-muted-foreground"> / {monthData.totals.daysWithZbericht} mit Z-Bericht</span>
                </p>
              </div>
              <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-open">
                <p className="text-[10px] text-muted-foreground">Tage offen</p>
                <p className={`text-sm font-semibold tabular-nums ${monthData.totals.daysOpen > 0 ? 'text-amber-700 dark:text-amber-400' : ''}`}>
                  {monthData.totals.daysOpen}
                </p>
              </div>
              <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-diff">
                <p className="text-[10px] text-muted-foreground">Tage mit Differenzen</p>
                <p className={`text-sm font-semibold tabular-nums ${monthData.totals.daysWithDiff > 0 ? 'text-red-700 dark:text-red-400' : ''}`}>
                  {monthData.totals.daysWithDiff}
                </p>
              </div>
              <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-barausgaben">
                <p className="text-[10px] text-muted-foreground">Total Barausgaben</p>
                <p className="text-sm font-semibold tabular-nums">CHF {fmtChf(monthData.totals.barausgaben)}</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-einzahlung">
                <p className="text-[10px] text-muted-foreground">Total Einzahlung Bank</p>
                <p className="text-sm font-semibold tabular-nums">CHF {fmtChf(monthData.totals.values.einzahlungBank)}</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-saldo-ende">
                <p className="text-[10px] text-muted-foreground">Kassensaldo Ende Monat</p>
                <p className="text-sm font-semibold tabular-nums">
                  {monthData.totals.kassensaldoEnde === null
                    ? <span className="text-muted-foreground font-normal">—</span>
                    : <>CHF {fmtChf(monthData.totals.kassensaldoEnde)}</>}
                </p>
              </div>
              <div className="rounded-md border border-border px-3 py-2" data-testid="ta-kpi-bargeld">
                <p className="text-[10px] text-muted-foreground">Total Bargeld (Soll)</p>
                <p className="text-sm font-semibold tabular-nums">CHF {fmtChf(monthData.totals.bargeldSoll)}</p>
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
            </div>
            <TagesabschlussTable
              rows={monthData.rows}
              totals={monthData.totals}
              onDayClick={setOpenDate}
              readOnly={readOnly}
              onSaveManual={handleSaveManual}
              onCorrectRechnung={handleCorrectRechnung}
              onVoucherClick={(date, kind) => setVoucherCtx({ date, kind })}
              onExpensesClick={setOpenExpensesDate}
              onConfirm={handleConfirm}
              onReasonsClick={setReasonDate}
            />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[10px] text-muted-foreground">
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-100 dark:bg-amber-900/30 border border-amber-300 align-middle mr-1" />korrigiert</span>
              <span className="text-sky-700 dark:text-sky-400 font-medium">manuell erfasst</span>
              <span className="text-red-600 dark:text-red-400">negative Beträge</span>
              <span>normale Werte = automatisch aus dem Z-Bericht</span>
              <span>Adyen- und Cash-Differenz: grün ≤ 0.05 · orange ≤ 5 · rot &gt; 5 CHF</span>
              <span>Bargeld Soll = Umsatz − KK − Rechnung − Barausgaben − eingelöste Gutscheine + verkaufte Gutscheine</span>
              <span>Kassensaldo Soll = Saldo Vortag + Bargeld Soll − Einzahlung Bank · Cash Diff = Cash Ist − Kassensaldo Soll</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-50 border border-green-300 align-middle mr-1" />Tag bestätigt</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-50 border border-amber-300 align-middle mr-1" />offen</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-50 border border-red-300 align-middle mr-1" />Differenz</span>
            </div>
          </>
        )}
      </CardContent>

      <TagesabschlussDayDialog
        row={openRow}
        expenses={openExpenses}
        readOnly={readOnly}
        onClose={() => setOpenDate(null)}
        onSaveManual={handleSaveManual}
        onOverride={handleOverride}
        onConfirm={handleConfirm}
        onUpsertExpense={handleUpsertExpense}
        onRemoveExpense={handleRemoveExpense}
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
  );
}
