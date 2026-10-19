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

import { kvGet, kvGetStrict, kvSetConfirmed } from '@/lib/supabase-kv';

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
  // Database-first (Issue #5): cache locally only after Supabase confirms.
  await kvSetConfirmed(key, merged, 'Gäste');
}

// ── Gäste ────────────────────────────────────────────────────────────────────

export const loadGaesteDaily = (tk: KeyFn) => load(gaesteKey(tk));
export const saveGaesteDaily = (tk: KeyFn, incoming: Record<string, number>) =>
  saveMerged(gaesteKey(tk), incoming);

/**
 * Dublettensicherer Gäste-Save mit MONATS-Scope: Innerhalb der importierten
 * Monate («YYYY-MM») gilt die Datei 1:1 — bestehende Tage dieser Monate, die
 * NICHT in der Datei sind (z.B. aus einem früheren Fehl-/Doppelimport), werden
 * ENTFERNT; gleiche Tage werden ersetzt, nie addiert. Andere Monate bleiben
 * unberührt (Merge wie gehabt).
 */
export async function saveGaesteDailyReplaceMonths(
  tk: KeyFn,
  incoming: Record<string, number>,
  months: string[],
): Promise<void> {
  const key = gaesteKey(tk);
  const remote = await kvGetStrict(key);
  const base = (remote && typeof remote === 'object' && !Array.isArray(remote))
    ? (remote as Record<string, number>)
    : {};
  const monthSet = new Set(months);
  const kept = Object.fromEntries(
    Object.entries(base).filter(([iso]) => !monthSet.has(iso.slice(0, 7))),
  );
  const merged = { ...kept, ...incoming };
  // Database-first (Issue #5): cache locally only after Supabase confirms.
  await kvSetConfirmed(key, merged, 'Gäste');
}

/** Diff-Vorschau «X neu · Y aktualisiert · Z unverändert (· W entfernt)». */
export interface GaesteDiff { neu: number; aktualisiert: number; unveraendert: number; entfernt: string[] }

/**
 * Vergleicht den Import (1:1-Ersatz innerhalb seiner Monate) mit dem Bestand.
 * `entfernt` = Bestands-Tage der betroffenen Monate, die die Datei nicht enthält.
 */
export function diffGaesteDaily(
  prior: Record<string, number>,
  incoming: Record<string, number>,
  months: string[],
): GaesteDiff {
  let neu = 0, aktualisiert = 0, unveraendert = 0;
  for (const [iso, val] of Object.entries(incoming)) {
    const old = prior[iso];
    if (old === undefined) neu++;
    else if (old === val) unveraendert++;
    else aktualisiert++;
  }
  const monthSet = new Set(months);
  const entfernt = Object.keys(prior)
    .filter(iso => monthSet.has(iso.slice(0, 7)) && incoming[iso] === undefined)
    .sort();
  return { neu, aktualisiert, unveraendert, entfernt };
}

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

// ── Umsatz pro Gast (CHF pro Person) ─────────────────────────────────────────
// NICHT verwechseln mit dem Durchschnittsbon (avgcheck-*, CHF pro BON):
// «Umsatz/Gast» ist der Gastronovi-Tagesexport «Durchschnitt» in CHF PRO
// PERSON (z.B. Beaulieu ~20.56) und dient der ABLEITUNG der Gästezahl
// (Gäste = Brutto ÷ Umsatz/Gast, siehe gaeste-derived.ts). Der Durchschnitts-
// bon (~66.71) bleibt die Basis der Bon-Statistik. Save = Merge pro Tag
// (gleiche Tage ersetzen, andere bleiben) — dublettensicher wie avgcheck.

const uppDailyKey   = (tk: KeyFn) => tk('umsatzprogast-daily');
const uppMonthlyKey = (tk: KeyFn) => tk('umsatzprogast-monthly');

export const loadUmsatzProGastDaily   = (tk: KeyFn) => load(uppDailyKey(tk));
export const loadUmsatzProGastMonthly = (tk: KeyFn) => load(uppMonthlyKey(tk));

export async function saveUmsatzProGast(
  tk: KeyFn,
  daily: Record<string, number>,
  /** "YYYY-MM" → Zeitraum-Wert der Datei (nur Info); null = nicht in der Datei */
  monthly: Record<string, number> | null,
): Promise<void> {
  await saveMerged(uppDailyKey(tk), daily);
  if (monthly && Object.keys(monthly).length > 0) {
    await saveMerged(uppMonthlyKey(tk), monthly);
  }
}
