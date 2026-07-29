/**
 * ziel-personalquote.ts — zentrale, einstellbare Ziel-Personalquote.
 * ===================================================================
 * EIN Prozentwert (Default 35.5 %), aus dem sich das Personalkosten-BUDGET
 * eines Monats mit dem Umsatz skaliert:
 *
 *   PK-Budget(Monat) = ZielQuote × Netto-Umsatz-Budget(Monat)
 *
 * Die harte Obergrenze (40 %) bleibt separat/fix und wird NICHT hier gepflegt.
 *
 * Persistenz analog zu den AG-Sozialkostensätzen: EIN tenant-scoped Blob
 * `ziel_personalquote_v1` über die BESTEHENDE Settings-Infrastruktur —
 * localStorage (Primär) + Supabase-KV (Backup). KEINE neue Tabelle, kein SQL.
 */

import type { TenantId } from '@/contexts/TenantContext';
import { kvGet, kvSet } from './supabase-kv';
import { tenantKey, tlsGetJson, tlsSetJson } from './tenant-utils';

export const ZIEL_PERSONALQUOTE_KEY = 'ziel_personalquote_v1';

/** Standard-Ziel-Personalquote in Prozent (Vorgabe). */
export const DEFAULT_ZIEL_PERSONALQUOTE_PCT = 35.5;

export interface ZielPersonalquoteBlob {
  /** Ziel-Personalquote in Prozent (z.B. 35.5). */
  pct: number;
  /** ISO-Zeitstempel des letzten Speicherns (optional). */
  updatedAt?: string;
}

/**
 * Wird nach jedem erfolgreichen Save gefeuert, damit offene Seiten
 * (Personalkosten, PersonalFix, Dienstplan) die neue Quote nachziehen.
 */
export const ZIEL_PERSONALQUOTE_UPDATED_EVENT = 'zielPersonalquoteUpdated';

/** Prozentwert validieren/normalisieren (0–100, Default bei Unsinn). */
export function normalizeZielPersonalquotePct(raw: unknown): number {
  // null/undefined/leer → Default (nicht als 0 interpretieren).
  if (raw == null || raw === '') return DEFAULT_ZIEL_PERSONALQUOTE_PCT;
  const n = typeof raw === 'string' ? parseFloat(raw.replace(',', '.')) : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return DEFAULT_ZIEL_PERSONALQUOTE_PCT;
  return Math.round(n * 100) / 100;
}

/** Ein beliebiges gespeichertes Objekt in ein gültiges Blob normalisieren. */
export function normalizeZielPersonalquoteBlob(raw: unknown): ZielPersonalquoteBlob {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      pct: normalizeZielPersonalquotePct(obj.pct),
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : undefined,
    };
  }
  // Auch ein blanker Zahlenwert wird akzeptiert (Abwärtskompatibilität).
  if (typeof raw === 'number' || typeof raw === 'string') {
    return { pct: normalizeZielPersonalquotePct(raw) };
  }
  return { pct: DEFAULT_ZIEL_PERSONALQUOTE_PCT };
}

/** Synchroner Frisch-Stand aus dem localStorage-Primärspeicher. */
export function loadZielPersonalquoteLocal(tenantId: TenantId): ZielPersonalquoteBlob {
  try {
    return normalizeZielPersonalquoteBlob(tlsGetJson<unknown>(tenantId, ZIEL_PERSONALQUOTE_KEY));
  } catch {
    return normalizeZielPersonalquoteBlob(null);
  }
}

/**
 * Lädt das Blob: zuerst localStorage (sofort), dann KV-Backup.
 * Ist im KV ein Stand vorhanden, gilt dieser als Wahrheit und wird lokal
 * gespiegelt. Fehler werden geschluckt — im Zweifel localStorage-Stand
 * (bzw. der Default 35.5 %).
 */
export async function loadZielPersonalquote(tenantId: TenantId): Promise<ZielPersonalquoteBlob> {
  let local = normalizeZielPersonalquoteBlob(null);
  try {
    local = normalizeZielPersonalquoteBlob(tlsGetJson<unknown>(tenantId, ZIEL_PERSONALQUOTE_KEY));
  } catch {
    // Beschädigter/gesperrter localStorage → Default.
  }
  try {
    const remote = await kvGet(tenantKey(tenantId, ZIEL_PERSONALQUOTE_KEY));
    if (remote != null && (typeof remote === 'object' || typeof remote === 'number' || typeof remote === 'string')) {
      const normalized = normalizeZielPersonalquoteBlob(remote);
      tlsSetJson(tenantId, ZIEL_PERSONALQUOTE_KEY, normalized);
      return normalized;
    }
  } catch {
    // Backup nicht erreichbar → localStorage-Stand nutzen.
  }
  return local;
}

/**
 * Speichert eine neue Ziel-Personalquote: localStorage sofort, KV best-effort.
 * KV-Fehler brechen die Aktion NICHT ab.
 */
export async function saveZielPersonalquote(tenantId: TenantId, pct: number): Promise<ZielPersonalquoteBlob> {
  const blob: ZielPersonalquoteBlob = {
    pct: normalizeZielPersonalquotePct(pct),
    updatedAt: new Date().toISOString(),
  };
  try {
    tlsSetJson(tenantId, ZIEL_PERSONALQUOTE_KEY, blob);
  } catch {
    // localStorage voll/gesperrt → KV-Backup bleibt einzige Persistenz.
  }
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(ZIEL_PERSONALQUOTE_UPDATED_EVENT));
    }
  } catch {
    // Event-Dispatch darf das Speichern nie brechen.
  }
  try {
    await kvSet(tenantKey(tenantId, ZIEL_PERSONALQUOTE_KEY), blob);
  } catch {
    // Backup fehlgeschlagen — localStorage bleibt primärer Speicher.
  }
  return blob;
}
