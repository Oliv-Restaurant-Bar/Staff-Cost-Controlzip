/**
 * maison-store.ts — Maison Umsatzkanal
 * =====================================
 * Speichert zwei Werte pro Mandant:
 *   maison-enabled  → boolean  (aktiviert/deaktiviert)
 *   maison-monthly  → Record<"YYYY-MM", number>  (Brutto-CHF pro Monat)
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
