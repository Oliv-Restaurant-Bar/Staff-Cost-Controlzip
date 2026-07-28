/**
 * gaeste-store.ts — Gäste- & Durchschnittsverkauf-Tageswerte (manuelle Importe)
 * =============================================================================
 * Drei KV-Schlüssel pro Mandant (tenant-präfixiert via tenantKey):
 *   gaeste-daily      → Record<"YYYY-MM-DD", number>  (Gäste/Personen pro Tag)
 *   avgcheck-daily    → Record<"YYYY-MM-DD", number>  (Durchschnittsverkauf CHF pro Tag)
 *   avgcheck-monthly  → Record<"YYYY-MM", number>     (MASSGEBLICHER Zeitraum-Wert der Datei)
 *
 * Persistence wie maison-store: localStorage (sofort) + Supabase app_settings.
 * Schreiben ist ein Merge — bestehende andere Monate bleiben erhalten.
 */

import { kvGet, kvGetStrict, kvSet } from '@/lib/supabase-kv';

type KeyFn = (k: string) => string;

const gaesteKey     = (tk: KeyFn) => tk('gaeste-daily');
const avgDailyKey   = (tk: KeyFn) => tk('avgcheck-daily');
const avgMonthlyKey = (tk: KeyFn) => tk('avgcheck-monthly');

function getSync(key: string): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch { return {}; }
}

async function load(key: string): Promise<Record<string, number>> {
  try {
    const remote = await kvGet(key);
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      const val = remote as Record<string, number>;
      localStorage.setItem(key, JSON.stringify(val));
      return val;
    }
  } catch { /* fall through */ }
  return getSync(key);
}

async function saveMerged(key: string, incoming: Record<string, number>): Promise<void> {
  // Merge-Basis STRICT vom Remote lesen (Lesefehler ≠ leer!) — sonst kann ein
  // Client mit leerem localStorage andere Monate im Remote-Blob überschreiben.
  // Bei Lesefehler wird der Save abgebrochen statt still zu wipen.
  const remote = await kvGetStrict(key);
  const base = (remote && typeof remote === 'object' && !Array.isArray(remote))
    ? (remote as Record<string, number>)
    : {};
  const merged = { ...base, ...incoming };
  localStorage.setItem(key, JSON.stringify(merged));
  await kvSet(key, merged);
}

// ── Gäste ────────────────────────────────────────────────────────────────────

export const loadGaesteDaily = (tk: KeyFn) => load(gaesteKey(tk));
export const saveGaesteDaily = (tk: KeyFn, incoming: Record<string, number>) =>
  saveMerged(gaesteKey(tk), incoming);

// ── Durchschnittsverkauf ─────────────────────────────────────────────────────

export const loadAvgCheckDaily   = (tk: KeyFn) => load(avgDailyKey(tk));
export const loadAvgCheckMonthly = (tk: KeyFn) => load(avgMonthlyKey(tk));

export async function saveAvgCheck(
  tk: KeyFn,
  daily: Record<string, number>,
  /** "YYYY-MM" → massgeblicher Zeitraum-Wert; null = nicht in der Datei */
  monthly: Record<string, number> | null,
): Promise<void> {
  await saveMerged(avgDailyKey(tk), daily);
  if (monthly && Object.keys(monthly).length > 0) {
    await saveMerged(avgMonthlyKey(tk), monthly);
  }
}
