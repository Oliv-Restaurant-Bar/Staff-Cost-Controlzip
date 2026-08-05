// ── AG-Sozialkosten pro Mitarbeiter ein-/ausschaltbar (global) ────────────────
// EINE Stelle der Wahrheit: getEmployerCostRate/getEffectiveHourlyRate lösen
// das Flag hier auf → ALLE Aufrufer (Flex-Übersicht, PKQ, Hochrechnung,
// Dashboards, Exporte) rechnen automatisch mit demselben Satz.
//
// Semantik: Flag AUS (Default, kein Eintrag) = MIT AG-Sozialkosten (totalHourly).
//           Flag AN  (empId in der Liste)    = OHNE AG (nur Bruttolohn).
// Persistenz: localStorage `pfix_ag_soz_off_<tenantId>` = JSON-Array der
// Basis-Mitarbeiter-IDs, mandantengetrennt (oliv/beaulieu). Der aktive Mandant
// wird aus demselben localStorage-Key gelesen, den der TenantProvider schreibt.

const TENANT_STORAGE_KEY = 'active_tenant'; // identisch zu TenantContext
const FLEX_SPLIT_SUFFIX = '::flexsplit';

/** Split-Pseudo-IDs (`<id>::flexsplit`) auf die Basis-ID normalisieren. */
export function agSozBaseId(id: string): string {
  return id.endsWith(FLEX_SPLIT_SUFFIX) ? id.slice(0, -FLEX_SPLIT_SUFFIX.length) : id;
}

function storageKey(tenantId: string): string {
  return `pfix_ag_soz_off_${tenantId}`;
}

function activeTenantId(): string {
  try {
    const t = localStorage.getItem(TENANT_STORAGE_KEY);
    return t === 'beaulieu' ? 'beaulieu' : 'oliv';
  } catch { return 'oliv'; }
}

// Mini-Cache: Raw-String-Vergleich statt JSON.parse pro Aufruf (Loops!)
let cacheKey: string | null = null;
let cacheRaw: string | null = null;
let cacheSet: Set<string> = new Set();

function readSet(tenantId: string): Set<string> {
  const key = storageKey(tenantId);
  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch { return new Set(); }
  if (key === cacheKey && raw === cacheRaw) return cacheSet;
  let set = new Set<string>();
  if (raw) {
    try {
      const ids: unknown = JSON.parse(raw);
      if (Array.isArray(ids)) set = new Set(ids.filter((x): x is string => typeof x === 'string'));
    } catch { /* korrupt → leer */ }
  }
  cacheKey = key; cacheRaw = raw; cacheSet = set;
  return set;
}

/** true = dieser Mitarbeiter wird OHNE AG-Sozialkosten gerechnet. */
export function isAgSozOff(empId: string, tenantId?: string): boolean {
  if (typeof localStorage === 'undefined') return false; // node/Tests ohne DOM
  return readSet(tenantId ?? activeTenantId()).has(agSozBaseId(empId));
}

/** Map aller «ohne AG»-IDs des Mandanten (Basis-IDs, true = ohne AG). */
export function loadAgSozOffMap(tenantId: string): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {};
  const out: Record<string, boolean> = {};
  for (const id of readSet(tenantId)) out[id] = true;
  return out;
}

/** Flag setzen/löschen; persistiert sofort (leeres Set → Key entfernt). */
export function setAgSozOffFlag(tenantId: string, empId: string, off: boolean): void {
  if (typeof localStorage === 'undefined') return;
  const set = new Set(readSet(tenantId));
  const base = agSozBaseId(empId);
  if (off) set.add(base); else set.delete(base);
  const key = storageKey(tenantId);
  try {
    if (set.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(Array.from(set)));
  } catch { /* quota */ }
  cacheKey = null; cacheRaw = null; cacheSet = new Set(); // Cache invalidieren
}
