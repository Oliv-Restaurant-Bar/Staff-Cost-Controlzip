/**
 * kpi-comments.ts — Monatskommentare zu Management-KPIs (REINE LOGIK).
 * ====================================================================
 * Blob-Struktur (tenant-präfixierter KV-/localStorage-Schlüssel
 * `kpi_comments_v1`):
 *   { 'YYYY-MM': { kpiId: { text, updatedAt, updatedBy?, deleted? } } }
 *
 * Persistenz-Regeln (§2 replit.md, kv-persistence-rules):
 *  - Union-Merge newer-wins je Monat×KPI (updatedAt entscheidet).
 *  - Löschen = Tombstone (deleted + updatedAt-Bump), NIE Hard-Delete —
 *    sonst Wiederauferstehung aus dem Remote-KV. Alle Leser filtern deleted.
 *  - Dirty-Check: identischer Zieltext ⇒ No-op (kein Write, kein
 *    updatedAt-Bump). Reines Laden schreibt NIE.
 * Dieses Modul ist DOM- und Supabase-frei; IO liegt in kpi-comments-db.ts.
 */

export interface KpiComment {
  text: string;
  updatedAt: string; // ISO
  updatedBy?: string;
  deleted?: boolean;
}

/** monthKey ('YYYY-MM') → kpiId → Kommentar. */
export type KpiCommentsBlob = Record<string, Record<string, KpiComment>>;

export const KPI_COMMENTS_KEY = 'kpi_comments_v1';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Unbekannte/rohe Daten defensiv in die Blob-Struktur normalisieren. */
export function normalizeKpiComments(raw: unknown): KpiCommentsBlob {
  if (!isObj(raw)) return {};
  const out: KpiCommentsBlob = {};
  for (const [monthKey, monthVal] of Object.entries(raw)) {
    if (!isObj(monthVal)) continue;
    const monthOut: Record<string, KpiComment> = {};
    for (const [kpiId, c] of Object.entries(monthVal)) {
      if (!isObj(c)) continue;
      if (typeof c.text !== 'string' || typeof c.updatedAt !== 'string') continue;
      const entry: KpiComment = { text: c.text, updatedAt: c.updatedAt };
      if (typeof c.updatedBy === 'string') entry.updatedBy = c.updatedBy;
      if (c.deleted === true) entry.deleted = true;
      monthOut[kpiId] = entry;
    }
    if (Object.keys(monthOut).length > 0) out[monthKey] = monthOut;
  }
  return out;
}

/**
 * Union-Merge zweier Blobs: je Monat×KPI gewinnt der neuere Eintrag
 * (updatedAt, ISO-String-Vergleich). Tombstones nehmen am Merge normal teil.
 */
export function mergeKpiComments(a: KpiCommentsBlob, b: KpiCommentsBlob): KpiCommentsBlob {
  const out: KpiCommentsBlob = {};
  const monthKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const monthKey of monthKeys) {
    const merged: Record<string, KpiComment> = {};
    const kpiIds = new Set([
      ...Object.keys(a[monthKey] ?? {}),
      ...Object.keys(b[monthKey] ?? {}),
    ]);
    for (const kpiId of kpiIds) {
      const ca = a[monthKey]?.[kpiId];
      const cb = b[monthKey]?.[kpiId];
      if (ca && cb) merged[kpiId] = cb.updatedAt > ca.updatedAt ? cb : ca;
      else merged[kpiId] = (ca ?? cb) as KpiComment;
    }
    out[monthKey] = merged;
  }
  return out;
}

export interface ApplyCommentResult {
  blob: KpiCommentsBlob;
  /** false = No-op (Dirty-Check): nichts geändert, NICHT schreiben. */
  changed: boolean;
}

/**
 * Kommentar setzen/ändern/löschen mit Dirty-Check.
 *  - text leer/nur Whitespace ⇒ Tombstone (falls ein sichtbarer Eintrag existiert).
 *  - identischer sichtbarer Text ⇒ No-op (kein updatedAt-Bump).
 */
export function applyKpiComment(
  blob: KpiCommentsBlob,
  monthKey: string,
  kpiId: string,
  text: string,
  nowIso: string,
  updatedBy?: string,
): ApplyCommentResult {
  const trimmed = text.trim();
  const existing = blob[monthKey]?.[kpiId];
  const visibleText = existing && !existing.deleted ? existing.text : null;

  if (trimmed === '') {
    // Löschen: nur wenn ein sichtbarer Eintrag existiert (sonst No-op).
    if (visibleText === null) return { blob, changed: false };
    const entry: KpiComment = { text: '', updatedAt: nowIso, deleted: true };
    if (updatedBy) entry.updatedBy = updatedBy;
    return {
      blob: { ...blob, [monthKey]: { ...(blob[monthKey] ?? {}), [kpiId]: entry } },
      changed: true,
    };
  }

  if (visibleText === trimmed) return { blob, changed: false };

  const entry: KpiComment = { text: trimmed, updatedAt: nowIso };
  if (updatedBy) entry.updatedBy = updatedBy;
  return {
    blob: { ...blob, [monthKey]: { ...(blob[monthKey] ?? {}), [kpiId]: entry } },
    changed: true,
  };
}

/** Sichtbarer Kommentar (Tombstones gefiltert) — null = keiner. */
export function getVisibleKpiComment(
  blob: KpiCommentsBlob,
  monthKey: string,
  kpiId: string,
): KpiComment | null {
  const c = blob[monthKey]?.[kpiId];
  if (!c || c.deleted) return null;
  return c;
}
