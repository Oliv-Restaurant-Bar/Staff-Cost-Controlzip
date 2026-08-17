/**
 * import-freshness.ts — «Cockpit-Bereitschaft» für das Import-Center
 * ==================================================================
 * Ermittelt je Wochen-Importquelle das «vollständig bis»-Datum = letztes
 * DATUM MIT DATEN (fachliches Datum, NICHT der Import-Zeitstempel) und
 * leitet daraus eine Ampel ab:
 *   grün   = Daten bis gestern vorhanden (bzw. innerhalb der Quellen-Toleranz)
 *   orange = Rückstand («es fehlen X Tage / bis TT.MM.»)
 *   grau   = noch nie importiert
 *
 * Quellen & Speicherorte (alles mandantengetrennt):
 *   umsatz        → KV tenantKey('dailyBudgets'), Tage mit actualRevenue>0
 *   gaeste        → KV tenantKey('gaeste-daily')
 *   avgcheck      → KV tenantKey('avgcheck-daily')
 *   verkauf       → Tabelle product_sales (restaurant_id = Tenant, max sale_date;
 *                   Take Away ist daraus ABGELEITET, keine eigene Quelle)
 *   mirus         → Tabelle actual_hours (Tenant via employee_id-Präfix b-*)
 *   reservationen → Tabelle reservation_records (reservation_date ≤ heute,
 *                   Zukunfts-Buchungen zählen nicht als «vollständig bis»)
 *   rezensionen   → reviews_data:<tenant> (max Review-Datum bzw. Monatsende
 *                   der Monats-Zeilen); Toleranz 7 Tage (Reviews sind nicht
 *                   täglich — grün, wenn höchstens eine Woche zurück)
 *
 * Reine Berechnungen (Ampel, Zusammenfassung) sind von den Ladern getrennt
 * und ohne Netz testbar.
 */

import { kvGet } from '@/lib/supabase-kv';
import { supabase } from '@/integrations/supabase/client';
import { tenantKey } from '@/lib/tenant-utils';
import { fetchReviewsData } from '@/lib/reviews-store';
import type { TenantId } from '@/contexts/TenantContext';

// ── Typen ──────────────────────────────────────────────────────────────────

export type WeeklySourceId =
  | 'umsatz' | 'gaeste' | 'avgcheck' | 'verkauf' | 'mirus' | 'reservationen' | 'rezensionen'
  | 'umsatzkategorien';

export interface WeeklySourceMeta {
  id: WeeklySourceId;
  label: string;
  /** Tage Rückstand, die noch als «grün» gelten (Default 1 = bis gestern). */
  toleranceDays: number;
}

export const WEEKLY_SOURCES: WeeklySourceMeta[] = [
  { id: 'umsatz',        label: 'Umsatz (Gastronovi)',        toleranceDays: 1 },
  { id: 'gaeste',        label: 'Gäste / Anzahl',             toleranceDays: 1 },
  { id: 'avgcheck',      label: 'Durchschnittsverkauf',       toleranceDays: 1 },
  // Take Away ist KEINE eigene Upload-Quelle — die Kennzahl wird aus Umsatz +
  // Gäste + Verkaufsdaten ABGELEITET. Als Wochenquelle zählt der echte Upload:
  // Verkaufsdaten/Sales (Gastronovi Artikel-Export; speist auch den TA-Split).
  { id: 'verkauf',       label: 'Verkaufsdaten / Sales (Gastronovi Artikel)', toleranceDays: 1 },
  { id: 'mirus',         label: 'MIRUS Ist-Stunden',          toleranceDays: 1 },
  { id: 'reservationen', label: 'Reservationen (Foratable)',  toleranceDays: 1 },
  { id: 'rezensionen',   label: 'Rezensionen (Lunchgate/Google)', toleranceDays: 7 },
  // Wochenrhythmus wie Rezensionen: Upload 1×/Woche gilt als aktuell.
  { id: 'umsatzkategorien', label: 'Umsatzanalyse Kategorien (F&B)', toleranceDays: 7 },
];

export type AmpelStatus = 'green' | 'orange' | 'gray';

export interface SourceFreshness {
  id: WeeklySourceId;
  label: string;
  /** Letztes Datum MIT Daten (ISO) oder null = noch nie importiert. */
  completeUntil: string | null;
  status: AmpelStatus;
  /** Fehlende Tage bis gestern (nur bei orange > 0). */
  missingDays: number;
}

// ── Reine Berechnungen ─────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** ISO-Datum um n Tage verschieben (UTC-sicher für reine Datums-Strings). */
export function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Differenz in ganzen Tagen (b − a) zweier ISO-Daten. */
export function diffDays(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / DAY_MS);
}

/**
 * Ampel je Quelle: grün, wenn `completeUntil` höchstens `toleranceDays`
 * vor `todayIso` liegt; grau ohne Daten; sonst orange mit Fehl-Tagen
 * (gemessen bis GESTERN — der heutige Tag gilt nie als fehlend).
 */
export function computeAmpel(
  completeUntil: string | null,
  todayIso: string,
  toleranceDays = 1,
): { status: AmpelStatus; missingDays: number } {
  if (!completeUntil) return { status: 'gray', missingDays: 0 };
  const behind = diffDays(completeUntil, todayIso); // 0 = heute, 1 = gestern …
  if (behind <= toleranceDays) return { status: 'green', missingDays: 0 };
  // fehlende Tage bis gestern (completeUntil+1 … gestern)
  return { status: 'orange', missingDays: behind - 1 };
}

export interface ReadinessSummary {
  /** true = alle Quellen grün (und mindestens eine hat Daten). */
  allCurrent: boolean;
  /** Bei allCurrent: minimales «vollständig bis» über alle Quellen mit Daten. */
  currentUntil: string | null;
  /** Labels der Quellen mit Rückstand (orange). */
  behind: string[];
  /** Labels der Quellen ohne Daten (grau). */
  never: string[];
}

/** Kopfzeile: «Alle Wochenquellen aktuell bis TT.MM.» bzw. «Rückstand bei: …». */
export function summarizeReadiness(rows: SourceFreshness[]): ReadinessSummary {
  const behind = rows.filter(r => r.status === 'orange').map(r => r.label);
  const never  = rows.filter(r => r.status === 'gray').map(r => r.label);
  const withData = rows.filter(r => r.completeUntil !== null);
  const allCurrent = behind.length === 0 && never.length === 0 && withData.length > 0;
  const currentUntil = withData.length
    ? withData.map(r => r.completeUntil as string).sort()[0]
    : null;
  return { allCurrent, currentUntil, behind, never };
}

/** «TT.MM.JJJJ» aus ISO; leere Eingabe → «—». */
export function fmtIsoShort(iso: string | null, withYear = true): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return withYear ? `${d}.${m}.${y}` : `${d}.${m}.`;
}

/** Max-Key eines Tages-Records (nur Werte, die als «Daten vorhanden» zählen). */
export function maxDateKey(
  rec: Record<string, unknown> | null | undefined,
  accept: (v: unknown) => boolean = () => true,
  maxIso?: string,
): string | null {
  if (!rec || typeof rec !== 'object') return null;
  let max: string | null = null;
  for (const [k, v] of Object.entries(rec)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    if (maxIso && k > maxIso) continue;
    if (!accept(v)) continue;
    if (!max || k > max) max = k;
  }
  return max;
}

// ── Lader (mandantengetrennt) ──────────────────────────────────────────────

async function kvRecord(key: string): Promise<Record<string, unknown>> {
  try {
    const raw = await kvGet(key);
    return (raw && typeof raw === 'object' && !Array.isArray(raw))
      ? raw as Record<string, unknown> : {};
  } catch { return {}; }
}

async function loadUmsatzUntil(tenantId: TenantId): Promise<string | null> {
  const rec = await kvRecord(tenantKey(tenantId, 'dailyBudgets'));
  return maxDateKey(rec, v => Number((v as Record<string, unknown>)?.actualRevenue ?? 0) > 0);
}

/** Verkaufsdaten/Sales: letztes sale_date im product_sales-Import (Gastronovi
    Artikel-Export), tenant-gefiltert und auf heute gedeckelt. */
async function loadVerkaufUntil(tenantId: TenantId, todayIso: string): Promise<string | null> {
  try {
    const { data, error } = await fromUntyped('product_sales')
      .select('sale_date')
      .eq('restaurant_id', tenantId)
      .lte('sale_date', todayIso)
      .order('sale_date', { ascending: false })
      .limit(1);
    if (error || !data?.length) return null;
    return data[0].sale_date?.slice(0, 10) ?? null;
  } catch { return null; }
}

async function loadGaesteUntil(tenantId: TenantId): Promise<string | null> {
  const rec = await kvRecord(tenantKey(tenantId, 'gaeste-daily'));
  return maxDateKey(rec, v => Number(v) > 0);
}

async function loadAvgCheckUntil(tenantId: TenantId): Promise<string | null> {
  const rec = await kvRecord(tenantKey(tenantId, 'avgcheck-daily'));
  return maxDateKey(rec, v => Number(v) > 0);
}

/** Ergebnisform der Max-Datum-Queries (isolierter Cast — Tabellen fehlen in den generierten Typen). */
type DateRowsResult = { data: Array<Record<string, string | null>> | null; error: unknown };
/** Minimaler untypisierter Query-Builder für Tabellen ausserhalb der generierten Typen. */
interface UntypedQuery {
  select(cols: string): UntypedQuery;
  gt(col: string, v: number): UntypedQuery;
  eq(col: string, v: string): UntypedQuery;
  lte(col: string, v: string): UntypedQuery;
  like(col: string, v: string): UntypedQuery;
  not(col: string, op: string, v: string): UntypedQuery;
  order(col: string, opts: { ascending: boolean }): UntypedQuery;
  limit(n: number): Promise<DateRowsResult>;
}
const fromUntyped = (table: string): UntypedQuery =>
  (supabase as unknown as { from(t: string): UntypedQuery }).from(table);

async function loadMirusUntil(tenantId: TenantId, todayIso: string): Promise<string | null> {
  try {
    // Auf heute gedeckelt: vorerfasste Zukunfts-Stunden zählen nicht als «vollständig bis».
    let q = fromUntyped('actual_hours').select('date').gt('hours', 0).lte('date', todayIso);
    q = tenantId === 'beaulieu' ? q.like('employee_id', 'b-%') : q.not('employee_id', 'like', 'b-%');
    const { data, error } = await q.order('date', { ascending: false }).limit(1);
    if (error || !data?.length) return null;
    return data[0].date?.slice(0, 10) ?? null;
  } catch { return null; }
}

async function loadReservationenUntil(tenantId: TenantId, todayIso: string): Promise<string | null> {
  try {
    const { data, error } = await fromUntyped('reservation_records')
      .select('reservation_date')
      .eq('restaurant_id', tenantId)
      .lte('reservation_date', todayIso)
      .order('reservation_date', { ascending: false })
      .limit(1);
    if (error || !data?.length) return null;
    return data[0].reservation_date?.slice(0, 10) ?? null;
  } catch { return null; }
}

async function loadRezensionenUntil(tenantId: TenantId, todayIso: string): Promise<string | null> {
  try {
    const data = await fetchReviewsData(tenantId);
    let max: string | null = null;
    for (const s of data.singleReviews ?? []) {
      const d = (s.date ?? '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= todayIso && (!max || d > max)) max = d;
    }
    for (const m of data.monthlyRows ?? []) {
      if (!/^\d{4}-\d{2}$/.test(m.month ?? '')) continue;
      // Monats-Zeile zählt bis Monatsende (gedeckelt auf heute).
      const lastDay = new Date(Date.UTC(Number(m.month.slice(0, 4)), Number(m.month.slice(5, 7)), 0))
        .toISOString().slice(0, 10);
      const capped = lastDay <= todayIso ? lastDay : todayIso;
      if (!max || capped > max) max = capped;
    }
    return max;
  } catch { return null; }
}

/** Letzter Tag mit Werten im «Umsatzanalyse Kategorien»-Blob (Produkteanalyse-Upload). */
async function loadUmsatzKategorienUntil(tenantId: TenantId): Promise<string | null> {
  try {
    const { loadUmsatzKategorien } = await import('@/lib/umsatz-kategorien');
    const blob = await loadUmsatzKategorien(tenantId);
    let max: string | null = null;
    for (const key of Object.keys(blob.werte)) {
      const datum = key.slice(0, 10);
      if (!max || datum > max) max = datum;
    }
    return max;
  } catch { return null; }
}

/** Lädt alle Wochenquellen parallel und berechnet die Ampeln. */
export async function loadWeeklyFreshness(
  tenantId: TenantId,
  todayIso: string,
): Promise<SourceFreshness[]> {
  const [umsatz, gaeste, avg, verkauf, mirus, res, rez, kat] = await Promise.all([
    loadUmsatzUntil(tenantId),
    loadGaesteUntil(tenantId),
    loadAvgCheckUntil(tenantId),
    loadVerkaufUntil(tenantId, todayIso),
    loadMirusUntil(tenantId, todayIso),
    loadReservationenUntil(tenantId, todayIso),
    loadRezensionenUntil(tenantId, todayIso),
    loadUmsatzKategorienUntil(tenantId),
  ]);
  const values: Record<WeeklySourceId, string | null> = {
    umsatz, gaeste, avgcheck: avg, verkauf, mirus, reservationen: res, rezensionen: rez,
    umsatzkategorien: kat,
  };
  return WEEKLY_SOURCES.map(meta => {
    const completeUntil = values[meta.id];
    const { status, missingDays } = computeAmpel(completeUntil, todayIso, meta.toleranceDays);
    return { id: meta.id, label: meta.label, completeUntil, status, missingDays };
  });
}
