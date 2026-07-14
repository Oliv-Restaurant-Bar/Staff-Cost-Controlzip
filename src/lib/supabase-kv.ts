/**
 * Supabase Key-Value Store
 * ========================
 * Liest und schreibt Daten in die bestehende `app_settings`-Tabelle.
 * Wird als persistenter Backend-Speicher für reporting_v1, budget_v1
 * und dailyBudgets genutzt (Fallback: localStorage).
 *
 * Durch diese Schicht bleiben Daten auch nach Logout / Browser-Wechsel
 * erhalten, weil sie im Supabase-Backend gespeichert werden.
 */

import { supabase } from '@/integrations/supabase/client';
import type { TenantId } from '@/contexts/TenantContext';

type Listener = () => void;

const _listeners = new Map<string, Set<Listener>>();
let _available: boolean | null = null;

export function subscribeKV(key: string, fn: Listener): () => void {
  if (!_listeners.has(key)) _listeners.set(key, new Set());
  _listeners.get(key)!.add(fn);
  return () => _listeners.get(key)?.delete(fn);
}

function notifyKV(key: string) {
  _listeners.get(key)?.forEach(fn => fn());
}

async function isAvailable(): Promise<boolean> {
  if (_available !== null) return _available;
  try {
    const { error } = await (supabase as any)
      .from('app_settings')
      .select('key')
      .limit(1);
    _available = !error;
  } catch {
    _available = false;
  }
  return _available;
}

export async function kvGet(key: string): Promise<unknown | null> {
  if (!(await isAvailable())) return null;
  try {
    const { data, error } = await (supabase as any)
      .from('app_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) return null;
    return data?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Wie kvGet, wirft aber bei Nichtverfügbarkeit oder Lesefehler statt still
 * null zu liefern. Für Merge-Schreibpfade, die den Remote-Stand als Basis
 * brauchen: ein Lesefehler darf dort NIE wie «Remote ist leer» aussehen.
 */
export async function kvGetStrict(key: string): Promise<unknown | null> {
  if (!(await isAvailable())) {
    throw new Error('Supabase nicht verfügbar');
  }
  const { data, error } = await (supabase as any)
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  if (!(await isAvailable())) return;
  try {
    await (supabase as any)
      .from('app_settings')
      .upsert({ key, value }, { onConflict: 'key' });
    notifyKV(key);
  } catch {
    // silently fail – localStorage bleibt primärer Speicher
  }
}

/**
 * Wie kvSet, wirft aber einen Fehler wenn Supabase nicht erreichbar ist
 * oder der Schreibvorgang fehlschlägt. Für kritische Finanzdaten
 * (Umsatz, Budget, Buchungszeilen), deren Backup-Fehler sichtbar sein müssen.
 */
export async function kvSetStrict(key: string, value: unknown): Promise<void> {
  if (!(await isAvailable())) {
    throw new Error('Supabase nicht verfügbar');
  }
  const { error } = await (supabase as any)
    .from('app_settings')
    .upsert({ key, value }, { onConflict: 'key' });
  if (error) throw error;
  notifyKV(key);
}

/**
 * Sicherer Tages-Upsert für dailyBudgets.
 * =========================================
 * PROBLEM: Alle naiven Schreibpfade lesen aus localStorage, ergänzen Tage,
 *          und schreiben den ganzen Blob zurück. Wenn localStorage stale ist
 *          (frischer Login, anderer Browser, gelöschter Cache), werden dabei
 *          bestehende Supabase-Daten überschrieben – Umsätze verschwinden.
 *
 * LÖSUNG: Immer zuerst den aktuellen Stand aus Supabase KV laden,
 *         dann per-Tag mergen, dann zurückschreiben.
 *
 * Ablauf:
 *   1. localStorage lesen (schnell, Offline-Fallback)
 *   2. KV lesen (Master – enthält den korrekten Stand aller Geräte)
 *   3. Merge: KV als Basis, localStorage-Werte > 0 gewinnen
 *   4. Updates anwenden (nur die übergebenen Tage, onlyIfZero optional)
 *   5. Zurückschreiben: localStorage + KV
 *
 * @param storageKey  Vollständiger localStorage-/KV-Schlüssel (inkl. Tenant-Prefix)
 * @param updates     Map { 'YYYY-MM-DD' → DailyBudget-Felder } – nur diese Tage werden geändert
 * @param onlyIfZero  Wenn true: Tag wird nur gesetzt wenn kein Wert (> 0) vorhanden
 */
export async function safeUpsertDailyBudgets(
  storageKey: string,
  updates: Record<string, Record<string, unknown>>,
  onlyIfZero = false,
): Promise<Record<string, Record<string, unknown>>> {
  type Blob = Record<string, Record<string, unknown>>;

  // 1. localStorage (Schnellpfad)
  let local: Blob = {};
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) local = JSON.parse(raw) as Blob;
  } catch { /* ignore */ }

  // 2. KV (Master-Stand)
  let remote: Blob = {};
  try {
    const kv = await kvGet(storageKey);
    if (kv && typeof kv === 'object' && !Array.isArray(kv)) {
      remote = kv as Blob;
    }
  } catch { /* ignore – localStorage bleibt Fallback */ }

  // 3. Merge: KV als Basis, Local-Werte > 0 gewinnen
  const base = mergeDailyBudgets(local, remote);

  // 4. Updates anwenden
  for (const [date, data] of Object.entries(updates)) {
    const existing = base[date] ?? ({} as Record<string, unknown>);
    if (onlyIfZero) {
      const patched: Record<string, unknown> = { ...existing };
      for (const [field, value] of Object.entries(data)) {
        const cur = existing[field];
        const curNum = typeof cur === 'number' ? cur : 0;
        if (curNum > 0) continue;
        patched[field] = value;
      }
      base[date] = patched;
    } else {
      base[date] = { ...existing, ...data };
    }
  }

  // 5. Zurückschreiben: localStorage sofort (schnell), dann KV (persistent)
  const merged = base;
  try {
    localStorage.setItem(storageKey, JSON.stringify(merged));
    // Alle abonnierten Views (PLView, Dashboard etc.) sofort benachrichtigen
    window.dispatchEvent(new Event('store-synced'));
  } catch { /* ignore */ }

  try {
    await kvSetStrict(storageKey, merged);
    console.log(
      `[SAFE-UPSERT] ${storageKey}: ${Object.keys(updates).length} Tage aktualisiert` +
      ` (total: ${Object.keys(merged).length}, onlyIfZero=${onlyIfZero}) ✓ KV gespeichert`,
    );
  } catch (kvError) {
    console.error(`[SAFE-UPSERT] KV-Schreibfehler für ${storageKey}:`, kvError);
    // Toast über dynamischen Import — verhindert Kreisabhängigkeit (UI → lib → UI)
    try {
      const { toast } = await import('sonner');
      toast.error(
        'Umsatz konnte nicht dauerhaft gespeichert werden. Bitte Verbindung prüfen.',
        { duration: 10000, id: 'kv-write-failed' },
      );
    } catch { /* Sonner nicht verfügbar */ }
  }

  return merged;
}

/**
 * Tages-Level-Merge zweier dailyBudgets-Objekte.
 *
 * WICHTIG – Merge-Strategie: KV (remote) gewinnt für numerische Felder.
 *
 * Frühere Logik „local > 0 gewinnt" war fehlerhaft: ein staler localStorage-Wert
 * (z. B. 539) konnte einen korrekt importierten KV-Wert (23 767.30) dauerhaft
 * überschreiben, weil 539 > 0 als Bedingung erfüllt war.
 *
 * Neue Regel: KV ist der Master. local füllt nur Lücken (KV-Wert = 0 / fehlt).
 * Alle Schreibpfade gehen über safeUpsertDailyBudgets → KV wird immer zuerst
 * geschrieben, bevor local aktualisiert wird. Damit ist KV stets ≥ local.
 */
function mergeDailyBudgets(
  local: Record<string, Record<string, unknown>>,
  remote: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const allDates = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const result: Record<string, Record<string, unknown>> = {};
  for (const date of allDates) {
    const l = local[date] ?? {};
    const r = remote[date] ?? {};
    // Start from local, then let remote fields win (KV is master)
    const merged: Record<string, unknown> = { ...l };
    // Alle Felder aus remote übernehmen — remote gewinnt
    for (const field of Object.keys(r)) {
      const lv = l[field];
      const rv = r[field];
      if (typeof rv === 'number' && typeof lv === 'number') {
        // Remote gewinnt wenn > 0; sonst local als Fallback
        merged[field] = rv > 0 ? rv : lv;
      } else {
        // Non-numeric: remote gewinnt wenn definiert
        merged[field] = rv !== undefined && rv !== null ? rv : lv;
      }
    }
    result[date] = merged;
  }
  return result;
}

/**
 * Sicherer Monats-Upsert für reporting_v1.
 * ==========================================
 * PROBLEM: saveAll() in reporting-store.ts schreibt den gesamten localStorage-Blob
 *   direkt nach Supabase (kvSet = komplettes Ersetzen). Wenn localStorage beim
 *   Import nicht vollständig synchronisiert war (frischer Login, anderer Browser,
 *   Race-Condition beim Startup-Sync), überschreibt saveAll() Supabase mit
 *   unvollständigen Daten — bestehende Monate (z.B. April) werden dauerhaft gelöscht.
 *
 * LÖSUNG: Immer zuerst den aktuellen Supabase-Stand laden, dann NUR den einen
 *   veränderten Monat aktualisieren, dann zurückschreiben.
 *
 * Ablauf:
 *   1. Supabase KV lesen (Master – enthält alle Monate aller Geräte/Sessions)
 *   2. Nur monthId aktualisieren (alle anderen Monate bleiben unberührt)
 *   3. Zurückschreiben: Supabase + localStorage (mit vollständigen Daten)
 */
export async function safeUpsertReportingMonth(
  monthId: string,
  monthRecord: unknown,
  storeKey: string,
): Promise<void> {
  if (!(await isAvailable())) return;
  try {
    // 1. Aktuellen Supabase-Stand laden (Master)
    const remote = await kvGet(storeKey);
    const base: Record<string, unknown> =
      remote && typeof remote === 'object' && !Array.isArray(remote)
        ? (remote as Record<string, unknown>)
        : {};
    // 1b. Schutz: kvGet liefert bei Lese-Fehlern null (nicht unterscheidbar von
    //     «noch kein Blob»). Damit ein fehlgeschlagener Remote-Read nie Monate
    //     verwirft, werden lokale Monate als Basis-Union ergänzt (remote gewinnt
    //     pro Monat — nur der Ziel-Monat wird ersetzt).
    let localBase: Record<string, unknown> = {};
    try {
      const rawLocal = JSON.parse(localStorage.getItem(storeKey) || '{}');
      if (rawLocal && typeof rawLocal === 'object' && !Array.isArray(rawLocal)) {
        localBase = rawLocal as Record<string, unknown>;
      }
    } catch { /* localStorage unlesbar → nur remote als Basis */ }
    // 2. Nur den einen Monat aktualisieren — alle anderen Monate bleiben erhalten
    const merged = { ...localBase, ...base, [monthId]: monthRecord };
    // 3. Nach Supabase schreiben — Fehler explizit prüfen (Supabase wirft nicht)
    const { error } = await (supabase as any)
      .from('app_settings')
      .upsert({ key: storeKey, value: merged }, { onConflict: 'key' });
    if (error) throw error;
    // 4. localStorage mit dem vollständigen Stand synchronisieren
    localStorage.setItem(storeKey, JSON.stringify(merged));
    notifyKV(storeKey);
    console.log(`[REPORTING] safeUpsertReportingMonth: ${storeKey} / ${monthId} ✓`);
  } catch (err) {
    console.error(`[REPORTING] safeUpsertReportingMonth Fehler für ${storeKey}/${monthId}:`, err);
    // KEIN Fallback-kvSet: Ein direkter Blob-Write mit nur EINEM Monat würde
    // alle anderen Monate/Jahre in Supabase löschen (verbotener kompletter
    // Blob-Replace). localStorage bleibt Primärspeicher — der Fehler wird
    // weitergereicht, damit der Aufrufer ihn sichtbar machen kann.
    throw err;
  }
}

/**
 * Sicheres Löschen eines Monats aus reporting_v1.
 * Liest Supabase-Stand, entfernt NUR den angegebenen Monat, schreibt zurück.
 * Verhindert, dass andere Monate verschwinden.
 */
export async function safeDeleteReportingMonth(
  monthId: string,
  storeKey: string,
): Promise<void> {
  if (!(await isAvailable())) return;
  try {
    const remote = await kvGet(storeKey);
    const base: Record<string, unknown> =
      remote && typeof remote === 'object' && !Array.isArray(remote)
        ? (remote as Record<string, unknown>)
        : {};
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { [monthId]: _removed, ...rest } = base;
    // WICHTIG: Supabase wirft bei Schreibfehlern NICHT — { error } explizit prüfen,
    // sonst gilt ein fehlgeschlagenes Löschen still als Erfolg (T007).
    const { error } = await (supabase as any)
      .from('app_settings')
      .upsert({ key: storeKey, value: rest }, { onConflict: 'key' });
    if (error) throw error;
    localStorage.setItem(storeKey, JSON.stringify(rest));
    notifyKV(storeKey);
    console.log(`[REPORTING] safeDeleteReportingMonth: ${storeKey} / ${monthId} ✓`);
  } catch (err) {
    console.error(`[REPORTING] safeDeleteReportingMonth Fehler für ${storeKey}/${monthId}:`, err);
    // Fehler weiterreichen — der Aufrufer muss ihn sichtbar machen (nie still scheitern).
    throw err;
  }
}

/**
 * Feld-Level-Merge zweier reporting_v1-Objekte.
 * Für jeden Monatsdatensatz gewinnt das Feld mit dem "mehr Inhalt":
 * - arrays: längere Liste gewinnt
 * - numbers: Wert > 0 gewinnt; wenn beide > 0 → local gewinnt
 * - sonstige: local gewinnt wenn definiert, sonst remote
 */
function mergeReportingV1(
  local: Record<string, Record<string, unknown>>,
  remote: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const result: Record<string, Record<string, unknown>> = {};
  for (const monthKey of allKeys) {
    const l = local[monthKey] ?? {};
    const r = remote[monthKey] ?? {};
    const merged: Record<string, unknown> = { ...r };
    for (const field of Object.keys(l)) {
      const lv = l[field];
      const rv = r[field];
      if (Array.isArray(lv) && Array.isArray(rv)) {
        merged[field] = lv.length >= rv.length ? lv : rv;
      } else if (typeof lv === 'number' && typeof rv === 'number') {
        merged[field] = (lv > 0 ? lv : rv);
      } else {
        merged[field] = lv !== undefined && lv !== null ? lv : rv;
      }
    }
    result[monthKey] = merged;
  }
  return result;
}

/**
 * Sync bekannte localStorage-Schlüssel zu Supabase.
 *
 * Für 'reporting_v1': Feld-Level-Merge (local + remote vereinigt),
 *   damit VJ-Daten aus Preview nie durch einen stalen Published-Stand
 *   überschrieben werden.
 * Für alle anderen Schlüssel: nur hochladen wenn Supabase leer ist
 *   (verhindert Überschreiben mit veralteten Daten).
 */
/** Berechnet den mandantenspezifischen KV-/localStorage-Key für Sync-Operationen. */
function syncKey(baseKey: string, tenantId: TenantId): string {
  return tenantId === 'oliv' ? baseKey : `${tenantId}:${baseKey}`;
}

/**
 * Sync bekannte localStorage-Schlüssel zu Supabase (mandantenfähig).
 * `keys` enthält die BASE-Schlüssel (ohne Mandanten-Präfix).
 * `tenantId` bestimmt das Präfix für localStorage und KV-Store.
 * Oliv = kein Präfix (Rückwärtskompatibel), Beaulieu = "beaulieu:".
 */
export async function syncLocalToSupabase(keys: string[], tenantId: TenantId = 'oliv'): Promise<void> {
  for (const key of keys) {
    const pKey = syncKey(key, tenantId);
    const raw = localStorage.getItem(pKey);
    if (!raw) continue;
    try {
      const local = JSON.parse(raw);
      const remote = await kvGet(pKey);
      const remoteIsEmpty = remote === null
        || remote === undefined
        || JSON.stringify(remote) === '{}'
        || JSON.stringify(remote) === '[]';

      if (key === 'reporting_v1' && !remoteIsEmpty) {
        const merged = mergeReportingV1(
          local as Record<string, Record<string, unknown>>,
          remote as Record<string, Record<string, unknown>>,
        );
        const mergedStr = JSON.stringify(merged);
        const remoteStr = JSON.stringify(remote);
        if (mergedStr !== remoteStr) {
          await kvSet(pKey, merged);
          localStorage.setItem(pKey, mergedStr);
          console.log(`[KV][${tenantId}] syncLocalToSupabase: 'reporting_v1' → Merge hochgeladen`);
        } else {
          console.log(`[KV][${tenantId}] syncLocalToSupabase: 'reporting_v1' – kein Merge-Unterschied`);
        }
        continue;
      }

      if (key === 'dailyBudgets' && !remoteIsEmpty) {
        const merged = mergeDailyBudgets(
          local as Record<string, Record<string, unknown>>,
          remote as Record<string, Record<string, unknown>>,
        );
        const mergedStr = JSON.stringify(merged);
        const remoteStr = JSON.stringify(remote);
        const localDates  = Object.keys(local as object);
        const remoteDates = Object.keys(remote as object);
        const newDates = localDates.filter(d => !remoteDates.includes(d));
        if (mergedStr !== remoteStr) {
          await kvSet(pKey, merged);
          localStorage.setItem(pKey, mergedStr);
          console.log(`[UMSATZ][${tenantId}] syncLocalToSupabase: 'dailyBudgets' → Merge: ${newDates.length} neue Tage, gesamt ${Object.keys(merged).length}`);
          if (newDates.length > 0) {
            console.log(`[UMSATZ] neue Tage: [${newDates.sort().join(', ')}]`);
          }
        } else {
          console.log(`[UMSATZ][${tenantId}] syncLocalToSupabase: 'dailyBudgets' – kein Merge-Unterschied`);
        }
        continue;
      }

      if (!remoteIsEmpty) {
        console.log(`[KV][${tenantId}] syncLocalToSupabase: überspringe '${key}' – Supabase hat bereits Daten`);
        continue;
      }
      await kvSet(pKey, local);
      console.log(`[KV][${tenantId}] syncLocalToSupabase: '${key}' → Supabase (Erstmigration)`);
    } catch {
      // skip if not valid JSON
    }
  }
}

/**
 * Lädt alle bekannten Schlüssel aus Supabase in localStorage (mandantenfähig).
 * `keys` enthält BASE-Schlüssel, `tenantId` bestimmt das Präfix.
 * Supabase ist der Master-Speicher.
 * Gibt true zurück wenn mindestens ein Schlüssel aktualisiert wurde.
 */
export async function syncSupabaseToLocal(keys: string[], tenantId: TenantId = 'oliv'): Promise<boolean> {
  let changed = false;
  for (const key of keys) {
    const pKey = syncKey(key, tenantId);
    const remote = await kvGet(pKey);
    if (remote === null || remote === undefined) {
      console.log(`[KV][${tenantId}] syncSupabaseToLocal: '${key}' – kein Eintrag in Supabase`);
      continue;
    }
    const remoteStr = JSON.stringify(remote);
    if (remoteStr === '{}' || remoteStr === '[]' || remoteStr === 'null') {
      console.log(`[KV][${tenantId}] syncSupabaseToLocal: '${key}' – Supabase leer, überspringe`);
      continue;
    }

    const localStr = localStorage.getItem(pKey) ?? '';
    if (localStr === remoteStr) {
      console.log(`[KV][${tenantId}] syncSupabaseToLocal: '${key}' – identisch, kein Update nötig`);
      continue;
    }

    if (key === 'reporting_v1') {
      try {
        const obj = remote as Record<string, { revenuePreviousYear?: number }>;
        const pyCount = Object.values(obj).filter(m => m?.revenuePreviousYear !== undefined && m.revenuePreviousYear > 0).length;
        const totalCount = Object.keys(obj).length;
        console.log(`[KV][${tenantId}] syncSupabaseToLocal: 'reporting_v1' – ${totalCount} Monate total, ${pyCount} mit revenuePreviousYear > 0`);
      } catch { /* ignore */ }
    }

    localStorage.setItem(pKey, remoteStr);
    notifyKV(pKey);
    changed = true;
    console.log(`[KV][${tenantId}] syncSupabaseToLocal: '${key}' → localStorage (${remoteStr.length} Zeichen)`);
  }
  return changed;
}

// ─── Absence (FE/K/F) Persistenz ─────────────────────────────────────────────
// FE/K/F entries are not stored in actual_hours Supabase table (no absence_type column),
// so they are persisted here in the app_settings KV store.
// Key format: "absence-ist-YYYY-MM"
// Value: Record<"empId-YYYY-MM-DD", "FE"|"K"|"F">

const ABSENCE_KV_PREFIX = 'absence-ist-';

/** Berechnet den mandantenspezifischen Absence-KV-Key. Oliv = kein Präfix. */
function absenceKey(yearMonth: string, tenantId: TenantId = 'oliv'): string {
  const base = `${ABSENCE_KV_PREFIX}${yearMonth}`;
  return tenantId === 'oliv' ? base : `${tenantId}:${base}`;
}

/**
 * Persist the full absence map for a month to Supabase KV store.
 * Pass an empty object to clear all absences for that month.
 * Pass tenantId to isolate data per mandant (default: 'oliv' = backward compatible).
 */
export async function saveMonthAbsences(
  yearMonth: string,
  entries: Record<string, string>,
  tenantId: TenantId = 'oliv',
): Promise<void> {
  await kvSet(absenceKey(yearMonth, tenantId), entries);
}

/**
 * Load all persisted FE/K/F entries for a month from Supabase KV store.
 * Returns an empty object if nothing is stored or on error.
 * Pass tenantId to isolate data per mandant (default: 'oliv' = backward compatible).
 */
export async function loadMonthAbsences(
  yearMonth: string,
  tenantId: TenantId = 'oliv',
): Promise<Record<string, string>> {
  const data = await kvGet(absenceKey(yearMonth, tenantId));
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return data as Record<string, string>;
}

// ─── Mitarbeiter-Sortierreihenfolge ──────────────────────────────────────────
// Key format: "sort-order:{tenantId}:{department}"
// Value: ordered array of employee IDs
// localStorage is used as fast cache; Supabase KV is source of truth.

function sortOrderKey(tenantId: string, department: string): string {
  return `sort-order:${tenantId}:${department}`;
}

/**
 * Load the display sort order for a department.
 * Returns null if no order has been saved yet (use default alphabetical).
 */
export async function loadEmployeeSortOrder(
  tenantId: string,
  department: 'service' | 'küche',
): Promise<string[] | null> {
  const key = sortOrderKey(tenantId, department);
  // Fast path: localStorage cache
  try {
    const cached = localStorage.getItem(key);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`[SORT] order loaded from cache: tenant=${tenantId} dept=${department} (${parsed.length} IDs)`);
        return parsed as string[];
      }
    }
  } catch { /* ignore */ }
  // Slow path: Supabase KV
  const data = await kvGet(key);
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* ignore */ }
  console.log(`[SORT] order loaded from Supabase: tenant=${tenantId} dept=${department} (${data.length} IDs)`);
  return data as string[];
}

/**
 * Persist the display sort order for a department.
 * Writes to localStorage immediately (cache) and Supabase KV (source of truth).
 */
export async function saveEmployeeSortOrder(
  tenantId: string,
  department: 'service' | 'küche',
  orderedIds: string[],
): Promise<void> {
  const key = sortOrderKey(tenantId, department);
  try { localStorage.setItem(key, JSON.stringify(orderedIds)); } catch { /* ignore */ }
  await kvSet(key, orderedIds);
  console.log(`[SORT] order saved: tenant=${tenantId} dept=${department} (${orderedIds.length} IDs)`);
}

// ─── Zellfarben (Dienstplan) ──────────────────────────────────────────────────
// Key format: "cell-colors-{YYYY-MM}" (Oliv) or "beaulieu:cell-colors-{YYYY-MM}"
// Value: Record<"empId-YYYY-MM-DD-früh" | "empId-YYYY-MM-DD-spät", hex string>

function cellColorsKey(monthKey: string, tenantId: TenantId): string {
  const base = `cell-colors-${monthKey}`;
  return tenantId === 'oliv' ? base : `${tenantId}:${base}`;
}

/**
 * Load cell colors for a month from Supabase KV.
 * Returns empty object if none saved.
 */
export async function loadCellColors(
  monthKey: string,
  tenantId: TenantId,
): Promise<Record<string, string>> {
  const data = await kvGet(cellColorsKey(monthKey, tenantId));
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return data as Record<string, string>;
}

/**
 * Persist the full cell color map for a month.
 * Pass an empty object to clear all colors for that month.
 */
export async function saveCellColors(
  monthKey: string,
  colors: Record<string, string>,
  tenantId: TenantId,
): Promise<void> {
  await kvSet(cellColorsKey(monthKey, tenantId), colors);
}

// ─── Überstunden-Deaktivierung pro Mitarbeiter ───────────────────────────────
// Persistente, mandantenfähige Liste der Mitarbeiter-IDs, für die die
// Überstundenberechnung auf /personal-fix deaktiviert ist (→ 0 Überstundenkosten).
// Bewusst NICHT auf der employees-Tabelle gespeichert: respektiert das
// Employees-Write-Gate (nur das Personalstamm-Formular schreibt employees) und
// vermeidet eine DB-Migration. localStorage ist schneller Cache, KV ist Master.
// Key format: "overtime-disabled" (Oliv) bzw. "beaulieu:overtime-disabled".

const OVERTIME_DISABLED_BASE = 'overtime-disabled';

function overtimeDisabledKey(tenantId: TenantId): string {
  return tenantId === 'oliv' ? OVERTIME_DISABLED_BASE : `${tenantId}:${OVERTIME_DISABLED_BASE}`;
}

function toStringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string');
}

/**
 * Lädt die Liste der Mitarbeiter-IDs mit deaktivierter Überstundenberechnung.
 * Cache-first (localStorage) NUR wenn nicht leer — sonst KV (Master) abfragen,
 * damit ein staler leerer Cache keine echten KV-Daten verdeckt.
 */
export async function loadOvertimeDisabledIds(tenantId: TenantId = 'oliv'): Promise<string[]> {
  const key = overtimeDisabledKey(tenantId);
  try {
    const cached = localStorage.getItem(key);
    if (cached) {
      const parsed = toStringIds(JSON.parse(cached));
      if (parsed.length > 0) return parsed;
    }
  } catch { /* ignore */ }
  const ids = toStringIds(await kvGet(key));
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* ignore */ }
  return ids;
}

/**
 * Persistiert die Liste der Mitarbeiter-IDs mit deaktivierter
 * Überstundenberechnung. Schreibt localStorage sofort (optimistisch) und KV
 * (persistent); zeigt bei KV-Schreibfehler einen Toast.
 */
export async function saveOvertimeDisabledIds(tenantId: TenantId, ids: string[]): Promise<void> {
  const key = overtimeDisabledKey(tenantId);
  const clean = Array.from(new Set(toStringIds(ids)));
  try { localStorage.setItem(key, JSON.stringify(clean)); } catch { /* ignore */ }
  try {
    await kvSetStrict(key, clean);
  } catch (err) {
    console.error(`[OVERTIME-DISABLED] KV-Schreibfehler für ${key}:`, err);
    try {
      const { toast } = await import('sonner');
      toast.error(
        'Überstunden-Einstellung konnte nicht dauerhaft gespeichert werden. Bitte Verbindung prüfen.',
        { duration: 8000, id: 'overtime-disabled-write-failed' },
      );
    } catch { /* Sonner nicht verfügbar */ }
  }
}
