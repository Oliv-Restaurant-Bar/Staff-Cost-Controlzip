/**
 * useManagementKpis — READ-ONLY IO-Hook der Management-KPIs (Startseite).
 * =======================================================================
 * Sammelt die Eingaben des KPI-Katalogs (kpi-catalog.ts) für einen wählbaren
 * Monat — AUSSCHLIESSLICH aus bestehenden Quellen, keine Zweitberechnung:
 *  - P&L-KPIs: useCockpitFinancials(period) → Financial-Metrics-Registry
 *    (DASSELBE Wiring wie Dashboard/Cockpit, EIN computePLForMonth).
 *  - Gäste/Bon/Umsatz pro Gast: gn-personen-db (read-only Aggregate, kein PII).
 *  - Produktivität: erfasste Ist-Stunden aus dem Arbeitszeiten-Store
 *    ('timeEntries', globaler Key; Tenant-Filter über die Mitarbeiter-ID —
 *    'b-'-Präfix = Beaulieu, wie überall im Personalbereich).
 *  - Verkaufs-WES: computeVerkaufsWes (SSoT, identisch zur WES-Analyse).
 *  - Tagesabschluss-Quote: Adyen-Abstimmungs-Blob (read-only, localStorage).
 *  - Monatskommentare: kpi_comments_v1 (localStorage primär, KV-Backup über
 *    sicheren Merge-Schreibpfad). Reines Laden schreibt NIE.
 * Fehlend = null («—»), NIE 0. Stale-Guards bei Tenant-/Monatswechsel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import { useAuth } from '@/hooks/useAuth';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { useCockpitFinancials } from '@/hooks/useCockpitFinancials';
import { getGuestsForPeriod, getAvgReceiptForPeriod, type GuestPeriodResult, type AvgReceiptResult } from '@/lib/gn-personen-db';
import { loadProductCosts, loadProdukteData } from '@/lib/produkte-store';
import { computeVerkaufsWes } from '@/lib/wes-month';
import { loadAdyenAbstimmungLocal, ADYEN_ABSTIMMUNG_UPDATED_EVENT } from '@/lib/adyen-abstimmung-db';
import { sumProductiveHoursForMonth, type KpiCatalogInput } from '@/lib/kpi-catalog';
import { loadKpiComments, loadKpiCommentsLocal, saveKpiComments } from '@/lib/kpi-comments-db';
import { applyKpiComment, type KpiCommentsBlob } from '@/lib/kpi-comments';
import { loadKpiTargets, loadKpiTargetsLocal, saveKpiTargets } from '@/lib/kpi-targets-db';
import { applyKpiTarget, type KpiTargetsBlob } from '@/lib/kpi-targets';
import type { TimeEntry } from '@/types/personnel';

export interface ManagementKpisResult {
  /** 'YYYY-MM' des gewählten Monats. */
  monthKey: string;
  /** Eingaben für getKpiValues/getKpiTone (kpi-catalog). */
  input: KpiCatalogInput;
  /** Asynchrone Quellen (Gäste/Kommentare) noch am Laden. */
  loading: boolean;
  /** Sichtbarer Teilfehler (Gäste-Kennzahlen) — Registry-KPIs bleiben nutzbar. */
  loadError: string | null;
  retry: () => void;
  comments: KpiCommentsBlob;
  /** Kommentar setzen/löschen (Dirty-Check: No-op ⇒ kein Write). */
  saveComment: (kpiId: string, text: string) => Promise<void>;
  /** Eigene Zielwerte (kpi_targets_v1, Tombstones ungefiltert — Leser via getVisibleKpiTarget). */
  targets: KpiTargetsBlob;
  /** Zielwert setzen (null = löschen); Dirty-Check: No-op ⇒ kein Write. */
  saveTarget: (kpiId: string, value: number | null) => Promise<void>;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function useManagementKpis(
  enabled: boolean,
  year: number,
  month: number,
): ManagementKpisResult {
  const { tenantId } = useTenant();
  const { user } = useAuth();
  const { isGuest } = useGuestSession();
  const fin = useCockpitFinancials(enabled, { year, month });

  const monthKey = `${year}-${pad2(month)}`;
  const fromIso = `${monthKey}-01`;
  const toIso = `${monthKey}-${pad2(lastDayOfMonth(year, month))}`;

  // ── Gäste-Kennzahlen (gn-personen-db, read-only Aggregate) ────────────────
  const [gn, setGn] = useState<{
    guests: GuestPeriodResult | null;
    guestsVj: GuestPeriodResult | null;
    avgReceipt: AvgReceiptResult | null;
    avgReceiptVj: AvgReceiptResult | null;
  }>({ guests: null, guestsVj: null, avgReceipt: null, avgReceiptVj: null });
  const [gnLoading, setGnLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const retry = useCallback(() => setRetryTick(t => t + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Stale-Guard: Zustand beim Tenant-/Monatswechsel sofort zurücksetzen.
    setGn({ guests: null, guestsVj: null, avgReceipt: null, avgReceiptVj: null });
    setGnLoading(true);
    setLoadError(null);

    const vjFromIso = `${year - 1}-${pad2(month)}-01`;
    const vjToIso = `${year - 1}-${pad2(month)}-${pad2(lastDayOfMonth(year - 1, month))}`;

    Promise.all([
      getGuestsForPeriod(tenantId, fromIso, toIso),
      getGuestsForPeriod(tenantId, vjFromIso, vjToIso),
      getAvgReceiptForPeriod(tenantId, fromIso, toIso),
      getAvgReceiptForPeriod(tenantId, vjFromIso, vjToIso),
    ])
      .then(([guests, guestsVj, avgReceipt, avgReceiptVj]) => {
        if (cancelled) return;
        setGn({ guests, guestsVj, avgReceipt, avgReceiptVj });
        setGnLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        setGnLoading(false);
        setLoadError(err instanceof Error ? err.message : 'Gäste-Kennzahlen konnten nicht geladen werden.');
      });

    return () => { cancelled = true; };
  }, [enabled, tenantId, fromIso, toIso, year, month, retryTick]);

  // ── Produktive Ist-Stunden (Arbeitszeiten-Store, globaler Key) ────────────
  const productiveHours = useMemo<number | null>(() => {
    if (!enabled) return null;
    try {
      const raw = localStorage.getItem('timeEntries');
      if (!raw) return null;
      const entries: TimeEntry[] = JSON.parse(raw);
      if (!Array.isArray(entries)) return null;
      const tenantEntries = entries.filter(e =>
        tenantId === 'beaulieu'
          ? String(e.employeeId ?? '').startsWith('b-')
          : !String(e.employeeId ?? '').startsWith('b-'),
      );
      return sumProductiveHoursForMonth(
        tenantEntries.map(e => ({ date: e.date, hours: e.actualHours ?? 0 })),
        monthKey,
      );
    } catch {
      return null;
    }
  }, [enabled, tenantId, monthKey]);

  // ── Verkaufsbasierter WES (SSoT wes-month, identisch zur WES-Analyse) ─────
  const verkaufsWes = useMemo<{ wesTotal: number } | null>(() => {
    if (!enabled) return null;
    const prodData = loadProdukteData();
    const { rezTotal } = computeVerkaufsWes(prodData ? prodData.entries : [], loadProductCosts(), monthKey);
    return rezTotal > 0 ? { wesTotal: rezTotal } : null;
  }, [enabled, monthKey]);

  // ── Tagesabschluss-Quote (Adyen-Abstimmungs-Blob, read-only) ──────────────
  const [adyenTick, setAdyenTick] = useState(0);
  useEffect(() => {
    const handler = () => setAdyenTick(t => t + 1);
    window.addEventListener(ADYEN_ABSTIMMUNG_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ADYEN_ABSTIMMUNG_UPDATED_EVENT, handler);
  }, []);

  const cash = useMemo<{ confirmedDays: number; expectedDays: number } | null>(() => {
    if (!enabled) return null;
    const blob = loadAdyenAbstimmungLocal(tenantId);
    const today = new Date();
    const todayIso = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
    // Erwartet = Tage des Monats mit erfasstem Z-Bericht-Umsatz, bis gestern
    // (heutiger Tag zählt nie als «fällig»).
    let expected = 0;
    let confirmed = 0;
    for (const [date, db] of Object.entries(fin.dailyBudgets)) {
      if (!date.startsWith(monthKey)) continue;
      if (date >= todayIso) continue; // < heute ⇒ bis gestern
      if (typeof db?.actualRevenue !== 'number' || db.actualRevenue <= 0) continue;
      expected += 1;
      if (blob.confirmations[date]?.confirmed) confirmed += 1;
    }
    return { confirmedDays: confirmed, expectedDays: expected };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tenantId, monthKey, fin.dailyBudgets, adyenTick]);

  // ── Monatskommentare (kpi_comments_v1) ────────────────────────────────────
  const [comments, setComments] = useState<KpiCommentsBlob>({});
  const commentsTenantRef = useRef(tenantId);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    commentsTenantRef.current = tenantId;
    setComments(loadKpiCommentsLocal(tenantId));
    loadKpiComments(tenantId).then(blob => {
      if (!cancelled && commentsTenantRef.current === tenantId) setComments(blob);
    });
    return () => { cancelled = true; };
  }, [enabled, tenantId]);

  const saveComment = useCallback(async (kpiId: string, text: string) => {
    // Harter Schreib-Guard (UI blendet die Aktion für Gäste bereits aus):
    // Gast-Sessions sind rein lesend — nie in KV/localStorage schreiben.
    if (isGuest) throw new Error('Gast-Sitzungen können keine Kommentare speichern.');
    const current = loadKpiCommentsLocal(tenantId);
    const result = applyKpiComment(
      current,
      monthKey,
      kpiId,
      text,
      new Date().toISOString(),
      user?.email ?? undefined,
    );
    if (!result.changed) return; // Dirty-Check: identisch ⇒ kein Write.
    setComments(result.blob);
    await saveKpiComments(tenantId, result.blob);
  }, [isGuest, tenantId, monthKey, user?.email]);

  // ── Eigene Zielwerte (kpi_targets_v1) — gleiches Muster wie Kommentare ────
  const [targets, setTargets] = useState<KpiTargetsBlob>({});
  const targetsTenantRef = useRef(tenantId);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    targetsTenantRef.current = tenantId;
    setTargets(loadKpiTargetsLocal(tenantId));
    loadKpiTargets(tenantId).then(blob => {
      if (!cancelled && targetsTenantRef.current === tenantId) setTargets(blob);
    });
    return () => { cancelled = true; };
  }, [enabled, tenantId]);

  const saveTarget = useCallback(async (kpiId: string, value: number | null) => {
    // Harter Schreib-Guard: Gast-Sessions sind rein lesend.
    if (isGuest) throw new Error('Gast-Sitzungen können keine Zielwerte speichern.');
    const current = loadKpiTargetsLocal(tenantId);
    const result = applyKpiTarget(
      current,
      kpiId,
      value,
      new Date().toISOString(),
      user?.email ?? undefined,
    );
    if (!result.changed) return; // Dirty-Check: identisch ⇒ kein Write.
    setTargets(result.blob);
    await saveKpiTargets(tenantId, result.blob);
  }, [isGuest, tenantId, user?.email]);

  const input = useMemo<KpiCatalogInput>(() => ({
    financialInput: fin.financialInput,
    guests: gn.guests,
    guestsVj: gn.guestsVj,
    avgReceipt: gn.avgReceipt,
    avgReceiptVj: gn.avgReceiptVj,
    productiveHours,
    verkaufsWes,
    cash,
    personnelRatioTarget: fin.personnelRatioTarget,
  }), [fin.financialInput, fin.personnelRatioTarget, gn, productiveHours, verkaufsWes, cash]);

  return {
    monthKey,
    input,
    loading: gnLoading,
    loadError,
    retry,
    comments,
    saveComment,
    targets,
    saveTarget,
  };
}
