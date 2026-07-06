/**
 * AdyenAbgleichSection.tsx — Täglicher Abgleich Z-Bericht ↔ Adyen.
 * ================================================================
 * Orchestriert Import (Adyen "Received Payment Details"-CSV), Laden der
 * Z-Bericht-Zahlungsarten (read-only aus gn_payment_methods, nur Tagesimporte)
 * und die Tages-Tabelle. Persistenz: Blob `adyenAbstimmung_v1` via
 * adyen-abstimmung-db.ts (localStorage + KV-Backup) — Overrides schreiben NIE
 * in gn_*-Tabellen zurück.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { usePermissions } from '@/hooks/usePermissions';
import type { TenantId } from '@/contexts/TenantContext';
import { parseAdyenPaymentsCsv } from '@/lib/adyen-csv-parser';
import {
  buildDayComparison,
  emptyAdyenBlob,
  mergeAdyenImport,
  setComment,
  setDayConfirmation,
  setOverride,
  type AdyenAbstimmungBlob,
  type DayComparison,
  type DayConfirmation,
} from '@/lib/adyen-abstimmung';
import {
  ADYEN_ABSTIMMUNG_UPDATED_EVENT,
  loadAdyenAbstimmung, loadAdyenAbstimmungLocal, saveAdyenAbstimmung,
} from '@/lib/adyen-abstimmung-db';
import { loadGnPaymentMethodsForMonth, type GnDayPaymentRow } from '@/lib/gn-zbericht-db';
import { AdyenDayTable } from './AdyenDayTable';

const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

interface AdyenAbgleichSectionProps {
  tenantId: TenantId;
  year: number;
}

export function AdyenAbgleichSection({ tenantId, year }: AdyenAbgleichSectionProps) {
  const { isGuest } = usePermissions();
  const readOnly = isGuest;

  const today = new Date();
  const [month, setMonth] = useState<number>(() =>
    year === today.getFullYear() ? today.getMonth() + 1 : 12,
  );
  const [blob, setBlob] = useState<AdyenAbstimmungBlob | null>(null);
  const [gnByDay, setGnByDay] = useState<Record<string, GnDayPaymentRow[]>>({});
  const [loading, setLoading] = useState(true);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Jahr-Wechsel: Monat sinnvoll nachziehen.
  useEffect(() => {
    setMonth(year === today.getFullYear() ? today.getMonth() + 1 : 12);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  // Blob laden (tenant-scoped).
  useEffect(() => {
    let alive = true;
    setBlob(null);
    loadAdyenAbstimmung(tenantId).then(b => { if (alive) setBlob(b); });
    return () => { alive = false; };
  }, [tenantId]);

  // Blob-Stand nachziehen, wenn IRGENDEINE Section ihn speichert
  // (TagesabschlussSection teilt sich die Bestätigungen im selben Blob).
  useEffect(() => {
    const onUpdated = () => setBlob(loadAdyenAbstimmungLocal(tenantId));
    window.addEventListener(ADYEN_ABSTIMMUNG_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(ADYEN_ABSTIMMUNG_UPDATED_EVENT, onUpdated);
  }, [tenantId]);

  // Z-Bericht-Zahlungsarten des Monats laden (read-only).
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setGnByDay({});
    loadGnPaymentMethodsForMonth(tenantId, year, month).then(data => {
      if (!alive) return;
      setGnByDay(data);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [tenantId, year, month]);

  const persist = useCallback(async (next: AdyenAbstimmungBlob) => {
    setBlob(next);
    await saveAdyenAbstimmung(tenantId, next);
  }, [tenantId]);

  // ── Import ──────────────────────────────────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    if (readOnly) return;
    setImporting(true);
    setImportError(null);
    try {
      const text = await file.text();
      const parsed = parseAdyenPaymentsCsv(text);
      if (!parsed.ok) {
        setImportError(parsed.failureReason);
        return;
      }
      // Frischen Stand laden → mergen → speichern (nie fremden Stand überschreiben).
      // BEWUSST das KV-bewusste loadAdyenAbstimmung (nicht das lokale): vor dem
      // grossen Import-Merge soll auch ein evtl. neuerer Cross-Device-Stand rein.
      const current = await loadAdyenAbstimmung(tenantId);
      const merged = mergeAdyenImport(current, parsed, file.name, new Date().toISOString());
      await persist(merged);

      const dayCount = parsed.days.length;
      const first = parsed.days[0]?.date;
      const last = parsed.days[dayCount - 1]?.date;
      toast.success(
        `Adyen-Import: ${dayCount} Tag(e) übernommen` +
        (first && last ? ` (${first} bis ${last})` : ''),
      );
      for (const w of parsed.warnings) toast.info(w);
      // Ansicht auf den importierten Zeitraum stellen (gleiches Jahr).
      if (first) {
        const [fy, fm] = first.split('-').map(Number);
        if (fy === year) setMonth(fm);
        else toast.info(`Hinweis: Import betrifft ${fy} — oben das Jahr wechseln.`);
      }
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Datei konnte nicht gelesen werden.');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [readOnly, tenantId, persist, year]);

  // ── Mutationen ──────────────────────────────────────────────────────────────

  // Mutationen IMMER auf dem frischen Primärspeicher-Stand ausführen — NIE auf
  // dem Mount-Zeit-State: die Tagesabschluss-Übersicht schreibt denselben Blob
  // (gemeinsame Bestätigungen) auf derselben Seite.
  const handleOverride = useCallback((fieldKey: string, originalValue: number, corrected: number | null, comment: string) => {
    if (readOnly) return;
    void persist(setOverride(loadAdyenAbstimmungLocal(tenantId), fieldKey, originalValue, corrected, comment, new Date().toISOString()));
  }, [readOnly, tenantId, persist]);

  const handleComment = useCallback((fieldKey: string, text: string) => {
    if (readOnly) return;
    void persist(setComment(loadAdyenAbstimmungLocal(tenantId), fieldKey, text, new Date().toISOString()));
  }, [readOnly, tenantId, persist]);

  const handleConfirm = useCallback((date: string, confirmation: DayConfirmation | null) => {
    if (readOnly) return;
    void persist(setDayConfirmation(loadAdyenAbstimmungLocal(tenantId), date, confirmation));
  }, [readOnly, tenantId, persist]);

  // ── Tagesliste des Monats ───────────────────────────────────────────────────

  const days: DayComparison[] = useMemo(() => {
    if (!blob) return [];
    const mm = `${year}-${String(month).padStart(2, '0')}`;
    const dayKeys = new Set<string>();
    for (const d of Object.keys(gnByDay)) if (d.startsWith(mm)) dayKeys.add(d);
    for (const d of Object.keys(blob.days)) if (d.startsWith(mm)) dayKeys.add(d);
    return [...dayKeys].sort().map(date =>
      buildDayComparison(date, gnByDay[date] ?? null, blob.days[date] ?? null, blob),
    );
  }, [blob, gnByDay, year, month]);

  const confirmedCount = days.filter(d => d.confirmation?.confirmed).length;

  return (
    <Card className="mt-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-sm">Täglicher Abgleich — Z-Bericht ↔ Adyen</CardTitle>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Kartenzahlungen/TWINT je Tag vergleichen, Differenzen klären, Tage bestätigen.
              {days.length > 0 && ` ${confirmedCount}/${days.length} Tage bestätigt.`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                onClick={() => setMonth(m => Math.max(1, m - 1))} disabled={month <= 1}
                aria-label="Vormonat">
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs font-medium w-24 text-center">{MONTH_NAMES[month - 1]} {year}</span>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                onClick={() => setMonth(m => Math.min(12, m + 1))} disabled={month >= 12}
                aria-label="Folgemonat">
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
            />
            <Button size="sm" className="h-7 text-xs" disabled={readOnly || importing}
              onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-3.5 w-3.5 mr-1" />
              {importing ? 'Importiere…' : 'Adyen-CSV importieren'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {importError && (
          <div className="mb-3 rounded-md border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800 p-3 text-xs text-red-800 dark:text-red-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Import fehlgeschlagen</p>
              <p className="mt-0.5">{importError}</p>
            </div>
          </div>
        )}

        {loading || blob === null ? (
          <p className="text-xs text-muted-foreground/60 italic py-4 text-center">Lade Abgleichsdaten…</p>
        ) : (
          <div className="overflow-x-auto">
            <AdyenDayTable
              days={days}
              disabled={readOnly}
              onOverride={handleOverride}
              onComment={handleComment}
              onConfirm={handleConfirm}
            />
          </div>
        )}

        <p className="text-[10px] text-muted-foreground/60 mt-3">
          Quelle Adyen: „Received Payment Details"-CSV (Settled/SentForSettle, Refunds abgezogen, nur CHF).
          Differenz-Ampel: grün ≤ 0.05 · orange ≤ 5.00 · rot &gt; 5.00 CHF. Manuelle Korrekturen ändern nur
          diesen Abgleich — nie die importierten Z-Bericht-Daten.
        </p>
      </CardContent>
    </Card>
  );
}
