/**
 * ziel-warenquote.ts — zentrale, einstellbare Ziel-Warenkostenquote (WKQ).
 * ========================================================================
 * EIN Prozentwert pro Mandant (Default 30 %): Zielanteil der Warenkosten am
 * Netto-Umsatz. Der Cockpit-Warenkosten-Block vergleicht die effektive WKQ
 * gegen dieses Ziel (Ampel grün ≤ Ziel, rot > Ziel).
 *
 * Persistenz identisch zur Ziel-Personalquote: EIN tenant-scoped Blob
 * `ziel_warenquote_v1` — localStorage (Primär) + Supabase-KV (Backup).
 * KEINE neue Tabelle, kein SQL.
 */

import type { TenantId } from '@/contexts/TenantContext';
import { kvGet, kvSet } from './supabase-kv';
import { tenantKey, tlsGetJson, tlsSetJson } from './tenant-utils';

export const ZIEL_WARENQUOTE_KEY = 'ziel_warenquote_v1';

/** Standard-Ziel-Warenkostenquote in Prozent (Vorgabe). */
export const DEFAULT_ZIEL_WARENQUOTE_PCT = 30;

export interface ZielWarenquoteBlob {
  /** Ziel-Warenkostenquote in Prozent (z.B. 30). */
  pct: number;
  updatedAt?: string;
}

/** Wird nach jedem erfolgreichen Save gefeuert (offene Cockpit-Ansichten ziehen nach). */
export const ZIEL_WARENQUOTE_UPDATED_EVENT = 'zielWarenquoteUpdated';

/** Prozentwert validieren/normalisieren (0–100, Default bei Unsinn). */
export function normalizeZielWarenquotePct(raw: unknown): number {
  if (raw == null || raw === '') return DEFAULT_ZIEL_WARENQUOTE_PCT;
  const n = typeof raw === 'string' ? parseFloat(raw.replace(',', '.')) : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return DEFAULT_ZIEL_WARENQUOTE_PCT;
  return Math.round(n * 100) / 100;
}

export function normalizeZielWarenquoteBlob(raw: unknown): ZielWarenquoteBlob {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      pct: normalizeZielWarenquotePct(obj.pct),
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : undefined,
    };
  }
  if (typeof raw === 'number' || typeof raw === 'string') {
    return { pct: normalizeZielWarenquotePct(raw) };
  }
  return { pct: DEFAULT_ZIEL_WARENQUOTE_PCT };
}

/** Lädt das Blob: localStorage sofort, KV-Backup als Wahrheit falls vorhanden. */
export async function loadZielWarenquote(tenantId: TenantId): Promise<ZielWarenquoteBlob> {
  let local = normalizeZielWarenquoteBlob(null);
  try {
    local = normalizeZielWarenquoteBlob(tlsGetJson<unknown>(tenantId, ZIEL_WARENQUOTE_KEY));
  } catch { /* beschädigter localStorage → Default */ }
  try {
    const remote = await kvGet(tenantKey(tenantId, ZIEL_WARENQUOTE_KEY));
    if (remote != null && (typeof remote === 'object' || typeof remote === 'number' || typeof remote === 'string')) {
      const normalized = normalizeZielWarenquoteBlob(remote);
      tlsSetJson(tenantId, ZIEL_WARENQUOTE_KEY, normalized);
      return normalized;
    }
  } catch { /* Backup nicht erreichbar → localStorage-Stand */ }
  return local;
}

/** Speichert die Zielquote: localStorage sofort, KV best-effort. */
export async function saveZielWarenquote(tenantId: TenantId, pct: number): Promise<ZielWarenquoteBlob> {
  const blob: ZielWarenquoteBlob = {
    pct: normalizeZielWarenquotePct(pct),
    updatedAt: new Date().toISOString(),
  };
  try { tlsSetJson(tenantId, ZIEL_WARENQUOTE_KEY, blob); } catch { /* KV bleibt Backup */ }
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ZIEL_WARENQUOTE_UPDATED_EVENT));
  } catch { /* Event darf Save nie brechen */ }
  try { await kvSet(tenantKey(tenantId, ZIEL_WARENQUOTE_KEY), blob); } catch { /* localStorage bleibt primär */ }
  return blob;
}
