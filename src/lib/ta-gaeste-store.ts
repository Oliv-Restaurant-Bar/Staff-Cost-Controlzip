/**
 * ta-gaeste-store.ts — «Gäste Take Away» Tageswerte (aus Artikel-Anzahl-Dateien)
 * ==============================================================================
 * KV-Schlüssel pro Mandant (tenant-präfixiert via tenantKey):
 *   ta-gaeste-daily → Record<"YYYY-MM-DD", number> (TA-Gäste pro Tag)
 *
 * Quelle: Gastronovi-Artikel-Anzahl-Exporte (Verkaufsdaten-Import) — jede
 * verkaufte Einheit eines Take-Away-Artikels zählt als eine Person. Explizite 0
 * ist ein echter Tageswert («an diesem Tag keine TA-Verkäufe»), fehlende Tage
 * bedeuten «nicht geliefert» (Cockpit fällt dann auf product_sales zurück).
 *
 * Persistence wie gaeste-store: localStorage (sofort) + Supabase app_settings.
 * Schreiben ist ein Merge mit STRIKT gelesener Remote-Basis (Lesefehler ≠ leer).
 */

import { kvGet, kvGetStrict, kvSetConfirmed } from '@/lib/supabase-kv';

type KeyFn = (k: string) => string;

export const TA_GAESTE_DAILY_KEY = 'ta-gaeste-daily';
export const taGaesteKeyFor = (tk: KeyFn) => tk(TA_GAESTE_DAILY_KEY);

function sanitize(raw: unknown): Record<string, number> {
  return (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? (raw as Record<string, number>)
    : {};
}

/** Tolerantes Laden (Anzeige): Remote bevorzugt, Fallback localStorage. */
export async function loadTaGaesteDaily(tk: KeyFn): Promise<Record<string, number>> {
  const key = taGaesteKeyFor(tk);
  try {
    const remote = await kvGet(key);
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      const val = remote as Record<string, number>;
      localStorage.setItem(key, JSON.stringify(val));
      return val;
    }
  } catch { /* fall through */ }
  try {
    return sanitize(JSON.parse(localStorage.getItem(key) || '{}'));
  } catch { return {}; }
}

/**
 * Merge-Basis STRIKT vom Remote lesen — Lesefehler wirft (bricht ab statt
 * still zu wipen). Vom Import-Commit VOR dem ersten Write aufgerufen, damit
 * ein Lesefehler keinen teilweise ausgeführten Import hinterlässt.
 */
export async function readTaGaesteBaseStrict(key: string): Promise<Record<string, number>> {
  return sanitize(await kvGetStrict(key));
}

/**
 * Dublettensicherer Write (Merge je Datum, gleiche Tage werden ERSETZT, nie
 * addiert). `base` MUSS aus readTaGaesteBaseStrict stammen; `key` ist der
 * bereits tenant-präfixierte KV-Key.
 */
export async function writeTaGaesteMerged(
  key: string,
  base: Record<string, number>,
  incoming: Record<string, number>,
): Promise<void> {
  const merged = { ...base, ...incoming };
  // Database-first (Issue #5): confirm the Supabase write before caching
  // locally — `kvSet` used to swallow write errors silently while
  // localStorage was already updated, showing "saved" even when it wasn't.
  await kvSetConfirmed(key, merged, 'TA-Gäste');
}

/** Bequemer Einzel-Save (Strict-Read + Merge-Write in einem Schritt). */
export async function saveTaGaesteDailyMerged(
  key: string,
  incoming: Record<string, number>,
): Promise<void> {
  await writeTaGaesteMerged(key, await readTaGaesteBaseStrict(key), incoming);
}

/**
 * Σ TA-Gäste im Zeitraum [fromIso, toIso] (inkl. Grenzen). `null`, wenn der
 * Zeitraum KEINEN gelieferten Tag enthält (Quelle fehlt ≠ 0 — Cockpit fällt
 * dann auf die product_sales-Berechnung zurück). Explizite 0-Tage zählen als
 * geliefert.
 */
export function sumTaGaesteRange(
  map: Record<string, number>,
  fromIso: string | null,
  toIso: string | null,
): number | null {
  if (!fromIso || !toIso || fromIso > toIso) return null;
  let sum = 0, hasData = false;
  for (const [date, v] of Object.entries(map)) {
    if (date < fromIso || date > toIso) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    hasData = true;
    if (v > 0) sum += v;
  }
  return hasData ? sum : null;
}
