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
  removeExpense,
  setExportSettings,
  setTagesabschlussOverride,
  upsertExpense,
  upsertManualDay,
  type CashExpense,
  type GnDayClosing,
  type TagesabschlussAutoField,
  type TagesabschlussBlob,
  type TagesabschlussExportSettings,
} from '@/lib/tagesabschluss';
import { loadTagesabschluss, saveTagesabschluss } from '@/lib/tagesabschluss-db';
import { loadGnDayClosingsForMonth } from '@/lib/gn-zbericht-db';
import { fmtChf } from './adyen-ui';
import { TagesabschlussTable } from './TagesabschlussTable';
import { TagesabschlussDayDialog } from './TagesabschlussDayDialog';
import { TagesabschlussExportDialog } from './TagesabschlussExportDialog';

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
  const [exportOpen, setExportOpen] = useState(false);

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

  const persist = useCallback(async (next: TagesabschlussBlob) => {
    setBlob(next);
    const merged = await saveTagesabschluss(tenantId, next);
    setBlob(merged);
  }, [tenantId]);

  // ── Mutationen (Blob tagesabschluss_v1) ─────────────────────────────────────

  const handleSaveManual = useCallback((date: string, patch: {
    bestandKasse?: number | null; einzahlungBank?: number | null; bemerkung?: string | null;
  }) => {
    if (readOnly || !blob) return;
    void persist(upsertManualDay(blob, date, {
      bestandKasse: patch.bestandKasse ?? undefined,
      einzahlungBank: patch.einzahlungBank ?? undefined,
      bemerkung: patch.bemerkung ?? undefined,
    }, new Date().toISOString()));
  }, [readOnly, blob, persist]);

  const handleOverride = useCallback((date: string, field: TagesabschlussAutoField, original: number, corrected: number | null, comment: string) => {
    if (readOnly || !blob) return;
    void persist(setTagesabschlussOverride(blob, date, field, original, corrected, comment, new Date().toISOString()));
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
    const b = blob ?? { days: {}, expenses: {}, overrides: {}, comments: {}, exportSettings: null };
    const ab = adyenBlob ?? emptyAdyenBlob();
    return buildTagesabschlussRows(year, month, closings, b, ab.confirmations, ab);
  }, [blob, adyenBlob, closings, year, month]);

  const openRow = openDate ? monthData.rows.find(r => r.date === openDate) ?? null : null;
  const openExpenses = openDate ? (blob?.expenses[openDate] ?? []) : [];

  return (
    <Card className="mt-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-sm">Tagesabschluss-Übersicht — {MONTH_NAMES[month - 1]} {year}</CardTitle>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Z-Bericht-Werte automatisch, manuelle Eingaben/Korrekturen pro Tag, Buchhaltungs-Export analog Excel "Tabelle2".
              Zeile anklicken zum Bearbeiten.
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
            </div>
            <TagesabschlussTable
              rows={monthData.rows}
              totals={monthData.totals}
              onDayClick={setOpenDate}
            />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[10px] text-muted-foreground">
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-100 dark:bg-amber-900/30 border border-amber-300 align-middle mr-1" />korrigiert</span>
              <span className="text-sky-700 dark:text-sky-400 font-medium">manuell erfasst</span>
              <span>normale Werte = automatisch aus dem Z-Bericht</span>
              <span>Adyen- und Kassen-Differenz: grün ≤ 0.05 · orange ≤ 5 · rot &gt; 5 CHF</span>
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
