/**
 * Zielwerte-Store
 * ================
 * Verwaltet Zielwerte (Personalkostenquote) nach Jahr, Monat und Abteilung.
 *
 * Prioritätslogik beim Auflösen:
 *  1. Monat + Abteilung
 *  2. Jahr  + Abteilung
 *  3. Monat + global ('all')
 *  4. Jahr  + global ('all')
 *  5. Fallback → legacy 'labor_cost_threshold' aus localStorage
 */

export type ZielwertDepartment = 'service' | 'küche' | 'all';

export interface ZielwertEntry {
  id: string;
  year: number;
  month?: number;            // 1–12, undefined = ganzes Jahr
  department: ZielwertDepartment;
  targetPercent: number;
  targetChf?: number;
  createdAt: string;
}

export interface ResolvedZielwert {
  targetPercent: number;
  targetChf: number | undefined;
  source: 'month+dept' | 'year+dept' | 'month+global' | 'year+global' | 'fallback';
}

const STORAGE_KEY = 'zielwerte_v1';
const LEGACY_KEY  = 'labor_cost_threshold';
const DEFAULT_PCT = 40;
const DEFAULT_PCT_DEPT = 20; // Default für Service / Küche einzeln

// ── Persistenz ──────────────────────────────────────────────────────────────

export function loadZielwerte(): ZielwertEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as ZielwertEntry[];
  } catch {
    return [];
  }
}

function persist(entries: ZielwertEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function saveZielwert(
  entry: Omit<ZielwertEntry, 'id' | 'createdAt'>,
  existingId?: string,
): ZielwertEntry {
  const all = loadZielwerte();
  const now = new Date().toISOString();

  if (existingId) {
    const idx = all.findIndex(e => e.id === existingId);
    if (idx !== -1) {
      all[idx] = { ...entry, id: existingId, createdAt: all[idx].createdAt };
      persist(all);
      return all[idx];
    }
  }

  const newEntry: ZielwertEntry = {
    ...entry,
    id: `zw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: now,
  };
  all.push(newEntry);
  persist(all);
  return newEntry;
}

export function deleteZielwert(id: string): void {
  persist(loadZielwerte().filter(e => e.id !== id));
}

export function clearAllZielwerte(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// ── Auflösung mit Prioritätslogik ───────────────────────────────────────────

export function resolveZielwert(
  year: number,
  month: number,
  department?: ZielwertDepartment,
  debug = false,
): ResolvedZielwert {
  const all = loadZielwerte();
  const dept = department ?? 'all';

  const match = (e: ZielwertEntry, yr: number, mo: number | undefined, dp: ZielwertDepartment) =>
    e.year === yr &&
    (mo === undefined ? e.month === undefined : e.month === mo) &&
    e.department === dp;

  // 1. Monat + Abteilung (nur wenn eine spezifische Abteilung angefragt wird)
  if (dept !== 'all') {
    const found = all.find(e => match(e, year, month, dept));
    if (found) {
      if (debug) {
        console.log(`[ZIELWERTE] resolved target for department '${dept}': ${found.targetPercent}%`);
        console.log(`[ZIELWERTE] source: month+dept (year=${year}, month=${month})`);
      }
      return { targetPercent: found.targetPercent, targetChf: found.targetChf, source: 'month+dept' };
    }

    // 2. Jahr + Abteilung
    const foundY = all.find(e => match(e, year, undefined, dept));
    if (foundY) {
      if (debug) {
        console.log(`[ZIELWERTE] resolved target for department '${dept}': ${foundY.targetPercent}%`);
        console.log(`[ZIELWERTE] source: year+dept (year=${year})`);
      }
      return { targetPercent: foundY.targetPercent, targetChf: foundY.targetChf, source: 'year+dept' };
    }
  }

  // 3. Monat + global
  const foundM = all.find(e => match(e, year, month, 'all'));
  if (foundM) {
    if (debug) {
      console.log(`[ZIELWERTE] resolved target for department '${dept}': ${foundM.targetPercent}%`);
      console.log(`[ZIELWERTE] source: month+global (year=${year}, month=${month})`);
    }
    return { targetPercent: foundM.targetPercent, targetChf: foundM.targetChf, source: 'month+global' };
  }

  // 4. Jahr + global
  const foundYG = all.find(e => match(e, year, undefined, 'all'));
  if (foundYG) {
    if (debug) {
      console.log(`[ZIELWERTE] resolved target for department '${dept}': ${foundYG.targetPercent}%`);
      console.log(`[ZIELWERTE] source: year+global (year=${year})`);
    }
    return { targetPercent: foundYG.targetPercent, targetChf: foundYG.targetChf, source: 'year+global' };
  }

  // 5. Fallback: Global → legacy localStorage-Wert (oder 40%), Abteilung → 20%
  const legacyGlobal = Number(localStorage.getItem(LEGACY_KEY) || DEFAULT_PCT);
  const fallbackPct  = dept === 'all' ? legacyGlobal : DEFAULT_PCT_DEPT;
  if (debug) {
    console.log(`[ZIELWERTE] resolved target for department '${dept}': ${fallbackPct}% (fallback)`);
    console.log(`[ZIELWERTE] source: fallback`);
  }
  return { targetPercent: fallbackPct, targetChf: undefined, source: 'fallback' };
}
