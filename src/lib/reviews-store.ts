/**
 * reviews-store — Rezensionen (manuelle Erfassung, ohne API-Anbindung)
 * ====================================================================
 * Bewertungs-Kennzahlen pro Mandant in app_settings (Key `reviews_data:<tenant>`).
 *
 * Regeln:
 *  - Persistenz via Laden→Mergen→Upsert: pro Datensatz gewinnt der neuere
 *    `updatedAt` (verhindert Remote-Wipe durch stale lokale Snapshots).
 *  - Löschen = Tombstone (`deleted: true` + updatedAt), nie hartes Entfernen —
 *    Reader filtern (siehe Memory: kv-merge-tombstones).
 *  - Lesen wirft bei DB-Fehler (nie leeren Zustand vortäuschen).
 */

import { getISOWeek, getISOWeekYear } from 'date-fns';

export interface MonthlyReviewRow {
  id: string;
  /** Monat yyyy-MM */
  month: string;
  /** Plattform, frei (z. B. Google, TripAdvisor) */
  platform: string;
  /** Ø-Bewertung der NEUEN Rezensionen im Monat (0.0–5.0) */
  avgRating: number | null;
  /** Anzahl neue Rezensionen im Monat */
  newCount: number | null;
  /** Kumulierte Gesamtzahl Rezensionen (Stand Monatsende) */
  totalCount: number | null;
  /** Ø-Gesamtbewertung (Stand Monatsende, 0.0–5.0) */
  totalAvg: number | null;
  note?: string;
  updatedAt: string; // ISO
  deleted?: boolean;
}

export interface SingleReview {
  id: string;
  /** Datum yyyy-MM-dd */
  date: string;
  platform: string;
  /** Sterne 1–5 */
  stars: number;
  text: string;
  author?: string;
  answered: boolean;
  /** Storage-Pfad des Screenshot im Bucket review-screenshots (tenant/…jpg), optional. */
  screenshotPath?: string;
  // ── Felder aus dem Feedback-CSV-Import (Lunchgate) — alle optional ────────
  /** Besuchsdatum (Reservation Date) yyyy-MM-dd. */
  visitDate?: string;
  /** Personenzahl (Pax) der Reservation. */
  pax?: number;
  /** Exakter Average aus dem CSV (Sterne = kaufmännisch gerundet). */
  avgExact?: number;
  /** Teilnoten (Service/Küche/Atmosphäre/Preis-Leistung), optional. */
  subRatings?: { service?: number; kitchen?: number; atmosphere?: number; performance?: number };
  /** Stabiler Upsert-Schlüssel des Imports (Publish Date + Guest + Reservation Date bzw. Zeilen-Hash). */
  importKey?: string;
  /** Herkunft: 'feedback_csv' = importiert (Lunchgate), sonst manuell. */
  source?: 'feedback_csv';
  updatedAt: string; // ISO
  deleted?: boolean;
}

export interface ReviewsData {
  monthlyRows: MonthlyReviewRow[];
  singleReviews: SingleReview[];
}

const storeKey = (tenantId: string) => `reviews_data:${tenantId}`;

export const newReviewId = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function sanitizeMonthly(list: unknown): MonthlyReviewRow[] {
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is MonthlyReviewRow =>
    !!e && typeof e === 'object'
    && typeof (e as MonthlyReviewRow).id === 'string'
    && typeof (e as MonthlyReviewRow).month === 'string'
    && typeof (e as MonthlyReviewRow).platform === 'string',
  );
}

function sanitizeSingles(list: unknown): SingleReview[] {
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is SingleReview =>
    !!e && typeof e === 'object'
    && typeof (e as SingleReview).id === 'string'
    && typeof (e as SingleReview).date === 'string'
    && typeof (e as SingleReview).platform === 'string',
  );
}

interface RawState extends ReviewsData {
  /** Optimistic-Lock-Marker des gespeicherten Blobs (null = Key existiert nicht / Altbestand ohne rev). */
  rev: string | null;
  exists: boolean;
}

/** Rohzustand inkl. Tombstones + rev laden. Wirft bei Lesefehler. */
async function fetchRaw(tenantId: string): Promise<RawState> {
  const { appSettingsTable } = await import('@/lib/app-settings-table');
  const { data, error } = await appSettingsTable()
    .select('value')
    .eq('key', storeKey(tenantId))
    .maybeSingle();
  if (error) throw new Error(`Rezensionen konnten nicht geladen werden: ${error.message}`);
  if (!data) return { monthlyRows: [], singleReviews: [], rev: null, exists: false };
  const val = data.value as { monthlyRows?: unknown; singleReviews?: unknown; rev?: unknown } | null;
  return {
    monthlyRows: sanitizeMonthly(val?.monthlyRows),
    singleReviews: sanitizeSingles(val?.singleReviews),
    rev: typeof val?.rev === 'string' ? val.rev : null,
    exists: true,
  };
}

/** Sichtbarer Zustand (ohne Tombstones). Wirft bei Lesefehler. */
export async function fetchReviewsData(tenantId: string): Promise<ReviewsData> {
  const raw = await fetchRaw(tenantId);
  return {
    monthlyRows: raw.monthlyRows.filter(r => !r.deleted),
    singleReviews: raw.singleReviews.filter(r => !r.deleted),
  };
}

function mergeById<T extends { id: string; updatedAt: string }>(remote: T[], local: T[]): T[] {
  const byId = new Map<string, T>();
  for (const r of remote) byId.set(r.id, r);
  for (const l of local) {
    const existing = byId.get(l.id);
    if (!existing || (l.updatedAt || '') >= (existing.updatedAt || '')) byId.set(l.id, l);
  }
  return [...byId.values()];
}

const MAX_CAS_ATTEMPTS = 4;

/**
 * Laden→Mergen→Schreiben mit Optimistic Locking (Compare-and-Swap auf `rev`
 * im Blob): Der Write greift nur, wenn der Remote-Stand seit dem Lesen
 * unverändert ist; sonst wird frisch gelesen, neu gemergt und erneut
 * versucht. Verhindert Lost-Updates bei parallelen Tabs/Nutzern.
 */
async function persistMerged(tenantId: string, changed: Partial<ReviewsData>): Promise<ReviewsData> {
  const { appSettingsTable } = await import('@/lib/app-settings-table');
  const key = storeKey(tenantId);

  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    // Merge-Basis IMMER der frische Remote-Zustand (inkl. Tombstones).
    const remote = await fetchRaw(tenantId);
    const merged: ReviewsData = {
      monthlyRows: mergeById(remote.monthlyRows, changed.monthlyRows ?? []),
      singleReviews: mergeById(remote.singleReviews, changed.singleReviews ?? []),
    };
    const newRev = newReviewId('rev');
    const value = { ...merged, rev: newRev } as unknown as Record<string, unknown>;

    let conflict = false;
    if (!remote.exists) {
      // Key existiert noch nicht: Insert; Unique-Konflikt = paralleler Erst-Schreiber → Retry.
      const { error } = await appSettingsTable().insert({ key, value });
      if (error) {
        if (error.code === '23409' || error.code === '23505' || error.code === '409') conflict = true;
        else throw new Error(`Rezensionen konnten nicht gespeichert werden: ${error.message}`);
      }
    } else {
      // CAS: Update nur, wenn rev unverändert (Altbestand ohne rev via IS NULL).
      let query = appSettingsTable().update({ value }).eq('key', key);
      query = remote.rev != null
        ? query.eq('value->>rev' as 'key', remote.rev)
        : query.is('value->>rev' as 'key', null);
      const { data, error } = await query.select('key');
      if (error) throw new Error(`Rezensionen konnten nicht gespeichert werden: ${error.message}`);
      // 0 betroffene Zeilen = zwischenzeitlich von jemand anderem geschrieben → Retry.
      if (!data || data.length === 0) conflict = true;
    }

    if (!conflict) {
      return {
        monthlyRows: merged.monthlyRows.filter(r => !r.deleted),
        singleReviews: merged.singleReviews.filter(r => !r.deleted),
      };
    }
  }
  throw new Error('Rezensionen konnten nicht gespeichert werden: gleichzeitige Änderung — bitte erneut versuchen.');
}

/** Monatszeile anlegen/aktualisieren. Gibt den neuen sichtbaren Zustand zurück. */
export async function upsertMonthlyRow(tenantId: string, row: MonthlyReviewRow): Promise<ReviewsData> {
  return persistMerged(tenantId, { monthlyRows: [{ ...row, updatedAt: new Date().toISOString() }] });
}

/** Monatszeile löschen (Tombstone). */
export async function deleteMonthlyRow(tenantId: string, row: MonthlyReviewRow): Promise<ReviewsData> {
  return persistMerged(tenantId, {
    monthlyRows: [{ ...row, deleted: true, updatedAt: new Date().toISOString() }],
  });
}

/** Einzelrezension anlegen/aktualisieren. */
export async function upsertSingleReview(tenantId: string, review: SingleReview): Promise<ReviewsData> {
  return persistMerged(tenantId, { singleReviews: [{ ...review, updatedAt: new Date().toISOString() }] });
}

/**
 * MEHRERE Einzelrezensionen in EINEM Schreibvorgang anlegen/aktualisieren
 * (Feedback-CSV-Import). Ein einziger CAS-Write für den ganzen Batch —
 * idempotent, weil die IDs der bestehenden Einträge wiederverwendet werden.
 */
export async function upsertSingleReviews(tenantId: string, reviews: SingleReview[]): Promise<ReviewsData> {
  const now = new Date().toISOString();
  return persistMerged(tenantId, { singleReviews: reviews.map(r => ({ ...r, updatedAt: now })) });
}

/**
 * Roh-Wert des reviews_data-Blobs (inkl. Tombstones/rev) für Import-Backups;
 * null = Key existiert nicht. Wirft bei Lesefehler (nie leeren Zustand vortäuschen).
 */
export async function fetchReviewsRawValue(tenantId: string): Promise<unknown | null> {
  const { appSettingsTable } = await import('@/lib/app-settings-table');
  const { data, error } = await appSettingsTable()
    .select('value').eq('key', storeKey(tenantId)).maybeSingle();
  if (error) throw new Error(`Rezensionen konnten nicht geladen werden: ${error.message}`);
  return data ? (data as { value: unknown }).value : null;
}

/** Einzelrezension löschen (Tombstone). */
export async function deleteSingleReview(tenantId: string, review: SingleReview): Promise<ReviewsData> {
  return persistMerged(tenantId, {
    singleReviews: [{ ...review, deleted: true, updatedAt: new Date().toISOString() }],
  });
}

// ── Screenshots (Supabase Storage, Bucket review-screenshots) ────────────────
//    Pfad IMMER tenant-präfixiert: <tenantId>/<reviewId>.<ext> — Mandantentrennung.

const SCREENSHOT_BUCKET = 'review-screenshots';
const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
const SCREENSHOT_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
};

/** Wirft, wenn der Pfad nicht zum aktuellen Mandanten gehört (Tenant-Grenze). */
function assertTenantPath(tenantId: string, path: string): void {
  if (!path.startsWith(`${tenantId}/`) || path.includes('..')) {
    throw new Error('Screenshot-Pfad gehört nicht zu diesem Mandanten.');
  }
}

/** Screenshot hochladen (nur JPEG/PNG/WebP, max. 5 MB); gibt den Storage-Pfad zurück. */
export async function uploadReviewScreenshot(tenantId: string, reviewId: string, file: File): Promise<string> {
  const ext = SCREENSHOT_MIME_EXT[file.type];
  if (!ext) throw new Error('Nur Bilddateien (JPEG, PNG, WebP) sind als Screenshot erlaubt.');
  if (file.size > SCREENSHOT_MAX_BYTES) throw new Error('Screenshot zu gross (max. 5 MB).');
  const path = `${tenantId}/${reviewId}.${ext}`;
  const { supabase } = await import('@/integrations/supabase/client');
  const { error } = await supabase.storage.from(SCREENSHOT_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: true });
  if (error) throw new Error(`Screenshot-Upload fehlgeschlagen: ${error.message}`);
  return path;
}

/** Kurzlebige Anzeige-URL (1 h); nur für Pfade des aktuellen Mandanten. */
export async function getReviewScreenshotUrl(tenantId: string, path: string): Promise<string> {
  assertTenantPath(tenantId, path);
  const { supabase } = await import('@/integrations/supabase/client');
  const { data, error } = await supabase.storage.from(SCREENSHOT_BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) throw new Error(`Screenshot-URL fehlgeschlagen: ${error?.message ?? 'unbekannt'}`);
  return data.signedUrl;
}

/** Screenshot löschen (best effort); nur für Pfade des aktuellen Mandanten. */
export async function deleteReviewScreenshot(tenantId: string, path: string): Promise<void> {
  assertTenantPath(tenantId, path);
  const { supabase } = await import('@/integrations/supabase/client');
  await supabase.storage.from(SCREENSHOT_BUCKET).remove([path]);
}

// ── Kennzahlen (pure, testbar) ────────────────────────────────────────────────

export interface ReviewKpis {
  /** Ø-Gesamtbewertung (letzter gepflegter Monatsstand; über Plattformen gewichtet nach Gesamtzahl) */
  overallAvg: number | null;
  /** Kumulierte Gesamtzahl Rezensionen (Summe der letzten Stände je Plattform) */
  totalCount: number | null;
  /** Neue Rezensionen im angegebenen Monat */
  newInMonth: number | null;
  /** Antwortquote 0–1 aus Einzelrezensionen (null wenn keine gepflegt) */
  responseRate: number | null;
}

/** Letzte (neueste) Monatszeile je Plattform. */
export function latestRowsPerPlatform(rows: MonthlyReviewRow[]): Map<string, MonthlyReviewRow> {
  const out = new Map<string, MonthlyReviewRow>();
  for (const r of rows) {
    const prev = out.get(r.platform);
    if (!prev || r.month > prev.month) out.set(r.platform, r);
  }
  return out;
}

/**
 * Kennzahlen berechnen. `platform` = null → über alle Plattformen
 * (Ø gewichtet nach kumulierter Gesamtzahl, sonst ungewichtet).
 */
export function computeReviewKpis(
  data: ReviewsData, currentMonth: string, platform: string | null,
): ReviewKpis {
  const rows = platform ? data.monthlyRows.filter(r => r.platform === platform) : data.monthlyRows;
  const latest = [...latestRowsPerPlatform(rows).values()];

  let overallAvg: number | null = null;
  const withAvg = latest.filter(r => r.totalAvg != null);
  if (withAvg.length > 0) {
    const allWeighted = withAvg.every(r => (r.totalCount ?? 0) > 0);
    if (allWeighted) {
      const w = withAvg.reduce((s, r) => s + (r.totalCount as number), 0);
      overallAvg = withAvg.reduce((s, r) => s + (r.totalAvg as number) * (r.totalCount as number), 0) / w;
    } else {
      overallAvg = withAvg.reduce((s, r) => s + (r.totalAvg as number), 0) / withAvg.length;
    }
  }

  const withCount = latest.filter(r => r.totalCount != null);
  const totalCount = withCount.length > 0
    ? withCount.reduce((s, r) => s + (r.totalCount as number), 0)
    : null;

  const monthRows = rows.filter(r => r.month === currentMonth && r.newCount != null);
  const newInMonth = monthRows.length > 0
    ? monthRows.reduce((s, r) => s + (r.newCount as number), 0)
    : null;

  const singles = platform
    ? data.singleReviews.filter(r => r.platform === platform)
    : data.singleReviews;
  const responseRate = singles.length > 0
    ? singles.filter(r => r.answered).length / singles.length
    : null;

  return { overallAvg, totalCount, newInMonth, responseRate };
}

// ── Wochentracking nach Sternen (Einzelrezensionen) ──────────────────────────

export type StarValue = 1 | 2 | 3 | 4 | 5;
export const STAR_VALUES: StarValue[] = [5, 4, 3, 2, 1];

export interface WeekStarColumn {
  /** ISO-Wochen-Key, z. B. 2026-W31 (Wochenjahr!) */
  weekKey: string;
  /** Anzeige-Label, z. B. KW 31 */
  label: string;
  /** Anzahl Rezensionen je Sternwert */
  counts: Record<StarValue, number>;
  total: number;
}

/** ISO-Wochen-Key (Wochenjahr, nicht Kalenderjahr — 29.12.–03.01.-Falle). */
export function isoWeekKeyOf(date: Date): string {
  // getISOWeekYear/getISOWeek via date-fns
  // (import hier statisch, damit Node-Tests ohne Supabase-Kette laufen)
  const w = getISOWeek(date);
  const y = getISOWeekYear(date);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

/**
 * Wochenspalten (aufsteigend) für Einzelrezensionen aufbauen.
 * `weekKeys` bestimmt Zeitraum + Reihenfolge; Rezensionen ausserhalb werden ignoriert.
 * Sterne werden NICHT gerundet/gebucketed: nur ganzzahlige Werte 1–5 zählen.
 */
export function computeWeeklyStarColumns(
  reviews: SingleReview[], weekKeys: string[], platform: string | null,
): WeekStarColumn[] {
  const emptyCounts = (): Record<StarValue, number> => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  const byWeek = new Map<string, WeekStarColumn>(
    weekKeys.map(k => [k, {
      weekKey: k,
      label: `KW ${Number(k.slice(6))}`,
      counts: emptyCounts(),
      total: 0,
    }]),
  );
  const filtered = platform ? reviews.filter(r => r.platform === platform) : reviews;
  for (const r of filtered) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    if (!Number.isInteger(r.stars) || r.stars < 1 || r.stars > 5) continue;
    const col = byWeek.get(isoWeekKeyOf(new Date(`${r.date}T12:00:00`)));
    if (!col) continue;
    col.counts[r.stars as StarValue]++;
    col.total++;
  }
  return weekKeys.map(k => byWeek.get(k) as WeekStarColumn);
}

/** Sterne-Verteilung + Total über die (bereits gefilterten) Wochenspalten. */
export function summarizeStarColumns(cols: WeekStarColumn[]): { counts: Record<StarValue, number>; total: number } {
  const counts: Record<StarValue, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  for (const c of cols) {
    for (const s of STAR_VALUES) counts[s] += c.counts[s];
    total += c.total;
  }
  return { counts, total };
}

/**
 * Zählt Google-Einzelrezensionen einer Sternzahl im ISO-Datumsbereich
 * [fromIso..toIso] (beide inklusiv). Plattform-Vergleich case-insensitiv;
 * gelöschte Einträge zählen nie. REIN & testbar (keine I/O).
 */
export function countGoogleReviewsByStar(
  reviews: SingleReview[],
  fromIso: string,
  toIso: string,
  star: number,
): number {
  return countReviewsByStar(reviews, 'google', fromIso, toIso, star);
}

/**
 * Wie countGoogleReviewsByStar, aber für eine beliebige Plattform
 * (case-insensitiv). Google und Lunchgate werden so NIE vermischt.
 */
export function countReviewsByStar(
  reviews: SingleReview[],
  platform: string,
  fromIso: string,
  toIso: string,
  star: number,
): number {
  const p = platform.trim().toLowerCase();
  let n = 0;
  for (const r of reviews) {
    if (r.deleted) continue;
    if (r.platform.trim().toLowerCase() !== p) continue;
    if (r.stars !== star) continue;
    if (r.date < fromIso || r.date > toIso) continue;
    n++;
  }
  return n;
}

export interface ReviewTrendPoint {
  month: string;
  /** Ø-Bewertung des Monats (über Plattformen nach newCount gewichtet, sonst ungewichtet) */
  avgRating: number | null;
  /** Summe neue Rezensionen im Monat */
  newCount: number | null;
}

/** Verlaufsreihe (aufsteigend nach Monat) für das Diagramm. */
export function computeReviewTrend(rows: MonthlyReviewRow[], platform: string | null): ReviewTrendPoint[] {
  const filtered = platform ? rows.filter(r => r.platform === platform) : rows;
  const byMonth = new Map<string, MonthlyReviewRow[]>();
  for (const r of filtered) {
    const list = byMonth.get(r.month) ?? [];
    list.push(r);
    byMonth.set(r.month, list);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, list]) => {
      const withAvg = list.filter(r => r.avgRating != null);
      let avgRating: number | null = null;
      if (withAvg.length > 0) {
        const allWeighted = withAvg.every(r => (r.newCount ?? 0) > 0);
        avgRating = allWeighted
          ? withAvg.reduce((s, r) => s + (r.avgRating as number) * (r.newCount as number), 0)
            / withAvg.reduce((s, r) => s + (r.newCount as number), 0)
          : withAvg.reduce((s, r) => s + (r.avgRating as number), 0) / withAvg.length;
      }
      const withNew = list.filter(r => r.newCount != null);
      const newCount = withNew.length > 0 ? withNew.reduce((s, r) => s + (r.newCount as number), 0) : null;
      return { month, avgRating, newCount };
    });
}
