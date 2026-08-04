/**
 * Take Away — pro Mandant konfigurierbar («Betrieb bietet Take Away»)
 * ===================================================================
 * EINE zentrale, pro Tenant persistierte Einstellung, ob der Betrieb überhaupt
 * ein Take-Away-Angebot führt. Steuert die Cockpit-Zeilen «Gäste Take Away»
 * (id `gaeste_take_away`), «Take Away Anteil» (id `take_away_anteil`) und
 * «Take Away Umsatz» (id `take_away_umsatz`):
 *   - true  → Zeilen werden in Monats- und Wochenübersicht gebaut/angezeigt
 *             (und damit auch exportiert).
 *   - false → Zeilen werden GAR NICHT erst erzeugt (Anzeige, Excel/PDF-Export
 *             und Umsortier-Liste bleiben dadurch automatisch konsistent).
 *
 * Defaults (bei fehlendem/ungültigem gespeichertem Wert):
 *   - oliv     → true  (bietet Take Away)
 *   - beaulieu → false (kein Take Away)
 *
 * Persistenz pro Tenant über app_settings (loadSetting/saveSetting + tenantKey).
 * Fehlertolerant: bei Lese-/Parse-Fehlern gilt der Mandanten-Default; ein
 * Lesefehler überschreibt nichts. `normalize`/`default` sind reine, testbare
 * Funktionen ohne Datenbank-Bindung.
 *
 * ACHTUNG tenantKey: oliv ist UNPRÄFIXIERT (Bestandsmuster) — die load/save-
 * Wrapper reichen den tenantKey unverändert durch, daher gilt das automatisch.
 */

import { loadSetting, saveSetting } from '@/lib/supabase-db';
import type { TenantId } from '@/contexts/TenantContext';

// ── Persistenz-Key (pro Tenant via tenantKey) ────────────────────────────────

/** app_settings-Key (roh, vor tenantKey) der Take-Away-Angebot-Einstellung. */
export const TAKEAWAY_OFFERED_KEY = 'takeaway_offered_v1';

/** Row-IDs der Take-Away-Cockpit-Zeilen (bei «nein» nicht gebaut). */
export const TAKEAWAY_ROW_IDS = ['gaeste_take_away', 'take_away_anteil', 'take_away_umsatz'] as const;

// ── Typen & Defaults ─────────────────────────────────────────────────────────

/** Persistierte Struktur (bewusst minimal, nur das Flag + Diagnose). */
export interface TakeAwayOfferedSettings {
  /** Bietet der Betrieb Take Away an? */
  offered: boolean;
  /** ISO-Zeitstempel der letzten Änderung (Diagnose). */
  updatedAt?: string;
}

/**
 * Mandanten-Default: oliv = ja (true), beaulieu = nein (false).
 * Rein & testbar.
 */
export function defaultTakeAwayOffered(tenantId: TenantId): boolean {
  return tenantId === 'oliv';
}

/**
 * Normalisiert/repariert ein geladenes Setting: liegt kein gültiger boolean-Wert
 * vor (fehlend/null/kein Boolean), gilt der Mandanten-Default. Ein gespeicherter
 * boolean-Wert gewinnt (auch `false`). Rein & testbar.
 */
export function normalizeTakeAwayOffered(
  raw: Partial<TakeAwayOfferedSettings> | null | undefined,
  tenantId: TenantId,
): TakeAwayOfferedSettings {
  const offered = typeof raw?.offered === 'boolean' ? raw.offered : defaultTakeAwayOffered(tenantId);
  return { offered, updatedAt: raw?.updatedAt };
}

// ── Persistenz (fehlertolerant) ──────────────────────────────────────────────

/**
 * Lädt die Einstellung des Tenants. Bei Fehler/leer → Mandanten-Default.
 * @param tenantKey aus useTenant() (oliv = key, sonst `tenant:key`).
 * @param tenantId  aktiver Mandant (für den Default).
 */
export async function loadTakeAwayOffered(
  tenantKey: (key: string) => string,
  tenantId: TenantId,
): Promise<TakeAwayOfferedSettings> {
  const raw = await loadSetting<Partial<TakeAwayOfferedSettings>>(tenantKey(TAKEAWAY_OFFERED_KEY));
  return normalizeTakeAwayOffered(raw, tenantId);
}

/** Speichert die Einstellung des Tenants (normalisiert + updatedAt). */
export async function saveTakeAwayOffered(
  tenantKey: (key: string) => string,
  tenantId: TenantId,
  offered: boolean,
  nowIso: string,
): Promise<void> {
  const norm = normalizeTakeAwayOffered({ offered }, tenantId);
  await saveSetting<TakeAwayOfferedSettings>(tenantKey(TAKEAWAY_OFFERED_KEY), {
    ...norm,
    updatedAt: nowIso,
  });
}

/**
 * Reine Filter-Funktion: entfernt die Take-Away-Zeilen, wenn der Betrieb kein
 * Take Away anbietet. Bei `offered=true` bleiben die Zeilen unverändert.
 * Trennzeilen (ohne id) bleiben immer erhalten. Rein & testbar.
 */
export function filterTakeAwayRows<T extends { id?: string }>(
  rows: T[],
  offered: boolean,
): T[] {
  if (offered) return rows;
  const remove = new Set<string>(TAKEAWAY_ROW_IDS);
  return rows.filter(r => !(r.id && remove.has(r.id)));
}
