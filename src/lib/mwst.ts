/**
 * mwst.ts — konfigurierbare MwSt-Sätze (Single Source of Truth)
 * =============================================================
 * Schweizer MwSt auf Umsatz: Standard (dine-in) 8.1 %, Take Away 2.6 %.
 * Die Sätze sind als globale (mandantenübergreifende) Konfiguration im
 * KV-Store hinterlegt (`mwst_rates_v1`) — Satzänderungen (z. B. künftige
 * MwSt-Erhöhungen) brauchen keine Codeänderung mehr.
 *
 * Nutzung:
 *   - getMwstRates()        → aktuelle Sätze (synchron, aus Cache)
 *   - mwstDivisorStandard() → 1 + Standard-Satz (z. B. 1.081)
 *   - mwstDivisorTakeaway() → 1 + TA-Satz (z. B. 1.026)
 *   - loadMwstRates()       → beim App-Start / Settings aufrufen (lädt KV)
 *   - saveMwstRates()       → Settings-UI (persistiert + aktualisiert Cache)
 *
 * Der Cache startet mit den Defaults; bis loadMwstRates() durch ist, gelten
 * 8.1 % / 2.6 % — fachlich identisch mit dem bisherigen Festwert-Verhalten.
 */

export interface MwstRates {
  /** Standard-Satz (dine-in) als Bruchteil, z. B. 0.081 = 8.1 % */
  standard: number;
  /** Take-Away-Satz als Bruchteil, z. B. 0.026 = 2.6 % */
  takeaway: number;
}

export const DEFAULT_MWST_RATES: MwstRates = { standard: 0.081, takeaway: 0.026 };

/** Globaler KV-Key (bewusst NICHT tenant-präfixiert — CH-Sätze gelten für alle Mandanten). */
export const MWST_RATES_KV_KEY = 'mwst_rates_v1';

let current: MwstRates = { ...DEFAULT_MWST_RATES };

export function getMwstRates(): MwstRates {
  return current;
}

/** 1 + Standard-Satz, z. B. 1.081 */
export function mwstDivisorStandard(): number {
  return 1 + current.standard;
}

/** 1 + Take-Away-Satz, z. B. 1.026 */
export function mwstDivisorTakeaway(): number {
  return 1 + current.takeaway;
}

/** Anzeige-Helfer: '8.1' bzw. '2.6' (ohne %-Zeichen). */
export function mwstPctLabel(rate: number): string {
  return (rate * 100).toFixed(1).replace(/\.0$/, '');
}

function sanitize(raw: unknown): MwstRates | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const std = Number(o.standard);
  const ta = Number(o.takeaway);
  // Plausibilität: 0–50 %, endlich — sonst Defaults behalten (nie mit Müll rechnen)
  if (!isFinite(std) || std < 0 || std > 0.5) return null;
  if (!isFinite(ta) || ta < 0 || ta > 0.5) return null;
  return { standard: std, takeaway: ta };
}

/**
 * Lädt die konfigurierten Sätze aus dem KV-Store in den Cache.
 * Fehler/fehlender Key → Defaults bleiben aktiv (nie blockierend).
 */
export async function loadMwstRates(): Promise<MwstRates> {
  try {
    const { kvGet } = await import('@/lib/supabase-kv');
    const raw = await kvGet(MWST_RATES_KV_KEY);
    const parsed = sanitize(raw);
    if (parsed) current = parsed;
  } catch (e) {
    console.warn('[MWST] loadMwstRates fehlgeschlagen — Defaults bleiben aktiv:', e);
  }
  return current;
}

/**
 * Persistiert neue Sätze (KV, STRIKT — wirft wenn Supabase den Write nicht
 * bestätigt; der Cache wird nur nach erfolgreichem Speichern aktualisiert).
 */
export async function saveMwstRates(rates: MwstRates): Promise<void> {
  const parsed = sanitize(rates);
  if (!parsed) throw new Error('Ungültige MwSt-Sätze (erlaubt: 0–50 %).');
  const { kvSetStrict } = await import('@/lib/supabase-kv');
  await kvSetStrict(MWST_RATES_KV_KEY, parsed);
  current = parsed;
}

/** Nur für Tests: Cache zurücksetzen/überschreiben. */
export function __setMwstRatesForTest(rates: MwstRates | null): void {
  current = rates ? { ...rates } : { ...DEFAULT_MWST_RATES };
}
