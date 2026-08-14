/**
 * maison-store.ts — Maison Umsatzkanal
 * =====================================
 * Speichert drei Werte pro Mandant:
 *   maison-enabled  → boolean  (aktiviert/deaktiviert)
 *   maison-monthly  → Record<"YYYY-MM", number>  (Brutto-CHF pro Monat, manuell in PLView)
 *   maison-daily    → Record<"YYYY-MM-DD", number> (Brutto-CHF pro Tag, aus XLSX-Import)
 *
 * Persistence: localStorage (sofort) + Supabase app_settings (dauerhaft).
 */

import { kvGet, kvSet } from '@/lib/supabase-kv';

// ── Schlüssel ─────────────────────────────────────────────────────────────────

const enabledKey  = (tk: (k: string) => string) => tk('maison-enabled');
const monthlyKey  = (tk: (k: string) => string) => tk('maison-monthly');

// ── Enabled: Lesen ───────────────────────────────────────────────────────────

export function getMaisonEnabledSync(tk: (k: string) => string): boolean {
  try {
    const raw = localStorage.getItem(enabledKey(tk));
    return raw === 'true' || raw === '"true"';
  } catch { return false; }
}

export async function loadMaisonEnabled(tk: (k: string) => string): Promise<boolean> {
  try {
    const remote = await kvGet(enabledKey(tk));
    const val = remote === true || remote === 'true';
    localStorage.setItem(enabledKey(tk), String(val));
    return val;
  } catch {
    return getMaisonEnabledSync(tk);
  }
}

// ── Enabled: Schreiben ────────────────────────────────────────────────────────

export async function saveMaisonEnabled(tk: (k: string) => string, enabled: boolean): Promise<void> {
  localStorage.setItem(enabledKey(tk), String(enabled));
  await kvSet(enabledKey(tk), enabled);
}

// ── Monthly: Lesen ────────────────────────────────────────────────────────────

export function getMaisonMonthlySync(tk: (k: string) => string): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(monthlyKey(tk)) || '{}');
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch { return {}; }
}

export async function loadMaisonMonthly(tk: (k: string) => string): Promise<Record<string, number>> {
  try {
    const remote = await kvGet(monthlyKey(tk));
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      const val = remote as Record<string, number>;
      localStorage.setItem(monthlyKey(tk), JSON.stringify(val));
      return val;
    }
  } catch { /* fall through */ }
  return getMaisonMonthlySync(tk);
}

// ── Daily: Lesen ──────────────────────────────────────────────────────────────

const dailyKey = (tk: (k: string) => string) => tk('maison-daily');

export function getMaisonDailySync(tk: (k: string) => string): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(dailyKey(tk)) || '{}');
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch { return {}; }
}

export async function loadMaisonDaily(tk: (k: string) => string): Promise<Record<string, number>> {
  try {
    const remote = await kvGet(dailyKey(tk));
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      const val = remote as Record<string, number>;
      localStorage.setItem(dailyKey(tk), JSON.stringify(val));
      return val;
    }
  } catch { /* fall through */ }
  return getMaisonDailySync(tk);
}

// ── Daily: Schreiben (merge — bestehende andere Monate bleiben erhalten) ──────

export async function saveMaisonDaily(
  tk: (k: string) => string,
  incoming: Record<string, number>,
): Promise<void> {
  const current = getMaisonDailySync(tk);
  const merged  = { ...current, ...incoming };
  localStorage.setItem(dailyKey(tk), JSON.stringify(merged));
  await kvSet(dailyKey(tk), merged);
}

/**
 * Import-Save: ERSETZEN PRO TAG (dublettensicher, wie der Umsatz-Import).
 * Nur die Tage, die in der Datei stehen, werden aktualisiert (nie addieren);
 * bestehende Tage AUSSERHALB des Datei-Zeitraums bleiben unberührt —
 * KEIN Full-Year-Replace (Datenverlust-Risiko bei Teilperioden-Uploads).
 *
 * Merge-Basis wird STRIKT frisch aus dem KV gelesen (Lesefehler ≠ leer):
 * schlägt das Lesen fehl, wird NICHT geschrieben — sonst würde eine leere/
 * stale Basis die übrigen Tage im Remote-Blob wegwischen.
 */
export async function saveMaisonDailyMergeStrict(
  tk: (k: string) => string,
  incoming: Record<string, number>,
): Promise<void> {
  const remote = await kvGet(dailyKey(tk)); // wirft bei KV-Fehler → kein Write
  const base: Record<string, number> =
    remote && typeof remote === 'object' && !Array.isArray(remote)
      ? { ...(remote as Record<string, number>) }
      : {};
  const next = { ...base, ...incoming };
  localStorage.setItem(dailyKey(tk), JSON.stringify(next));
  await kvSet(dailyKey(tk), next);
}

// ── Monthly: Schreiben ────────────────────────────────────────────────────────

export async function saveMaisonMonth(
  tk: (k: string) => string,
  yearMonth: string,
  amount: number,
): Promise<void> {
  const current = getMaisonMonthlySync(tk);
  const updated = amount > 0
    ? { ...current, [yearMonth]: amount }
    : Object.fromEntries(Object.entries(current).filter(([k]) => k !== yearMonth));
  localStorage.setItem(monthlyKey(tk), JSON.stringify(updated));
  await kvSet(monthlyKey(tk), updated);
}
