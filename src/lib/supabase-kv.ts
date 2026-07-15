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

import { appSettingsTable } from '@/lib/app-settings-table';
import type { TenantId } from '@/contexts/TenantContext';
import { asRecordBlob, readLocalRecord } from './kv-blob-utils';

type Listener = () => void;

const _listeners = new Map<string, Set<Listener>>();
let _available: boolean | null = null;
let _unavailableUntil = 0;

/**
 * Typisierter Fehler: Supabase ist nicht konfiguriert oder aktuell nicht
 * erreichbar (offline). Konsumenten unterscheiden damit «kein Backup möglich»
 * (dezenter Hinweis) von einem echten Lese-/Schreibfehler (sichtbarer Fehler).
 */
export class KVUnavailableError extends Error {
  constructor(message = 'Supabase nicht verfügbar') {
    super(message);
    this.name = 'KVUnavailableError';
  }
}

const NETWORK_ERROR_RE =
  /failed to fetch|networkerror|network request failed|fetch failed|load failed|err_internet_disconnected|err_network|err_name_not_resolved|err_connection|err_timed_out|econnrefused|econnreset|etimedout|enotfound|timed out|timeout|abort|dns|socket hang up|supabaseurl is required|supabasekey is required/i;

// Server-seitige Timeouts (Postgres statement timeout) bedeuten: Verbindung
// steht, die OPERATION war zu langsam — das ist ein echter DB-Fehler (Fall B),
// kein Offline-Signal.
const SERVER_SIDE_TIMEOUT_RE =
  /statement timeout|canceling statement|transaction is aborted|idle.?in.?transaction/i;

/**
 * Klassifiziert einen Fehler als «Supabase nicht verfügbar» (Fall A: offline /
 * nicht konfiguriert / Netzwerkausfall / Timeout) — alles andere ist ein echter
 * Lese-/Schreibfehler trotz Verbindung (Fall B).
 */
export function isKvUnavailable(err: unknown): boolean {
  if (err instanceof KVUnavailableError) return true;
  // Browser meldet explizit offline → jede fehlgeschlagene Operation ist Fall A.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg =
    err instanceof Error
      ? err.message
      : err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);
  if (SERVER_SIDE_TIMEOUT_RE.test(msg)) return false;
  return NETWORK_ERROR_RE.test(msg);
}

/**
 * Setzt den Verfügbarkeits-Cache zurück (für «Erneut versuchen» und Tests):
 * die nächste KV-Operation prüft die Verbindung neu.
 */
export function resetKVAvailabilityCache(): void {
  _available = null;
  _unavailableUntil = 0;
}

/**
 * Aktueller Verfügbarkeits-Zustand (T002-Semantik) — read-only, für Tests
 * und Diagnose. 'unknown' = noch nie geprüft, 'available' = erreichbar,
 * 'unavailable' = zuletzt nicht erreichbar (Negativ-Cache-Fenster aktiv oder
 * abgelaufen — der nächste Zugriff prüft nach Ablauf neu).
 */
export function getKVAvailabilityState(): 'unknown' | 'available' | 'unavailable' {
  if (_available === null) return 'unknown';
  return _available ? 'available' : 'unavailable';
}

/**
 * Erfolgreicher Supabase-Zugriff → Verfügbarkeit bestätigen.
 * Verfügbarkeit ist FLÜCHTIG: sie gilt nur bis zum nächsten Netzwerkfehler.
 */
function markKVSuccess(): void {
  _available = true;
  _unavailableUntil = 0;
}

/**
 * Fehlgeschlagener Supabase-Zugriff klassifizieren:
 * - Netzwerk-/Timeout-/Offline-Fehler (Fall A) → Cache invalidieren
 *   (unavailable + 30s-Negativ-Fenster), damit ein einmal gesetztes
 *   «verfügbar» NIE dauerhaft eingefroren bleibt.
 * - Echter DB-Fehler (Fall B, z. B. RLS/Constraint): Verbindung steht —
 *   Verfügbarkeit bleibt unangetastet, der Fehler bleibt sichtbar.
 */
function markKVFailure(err: unknown): void {
  if (isKvUnavailable(err)) {
    _available = false;
    _unavailableUntil = Date.now() + 30_000;
  }
}

/**
 * Zentraler Backup-Problem-Hinweis (Fall A/B-Unterscheidung, Befund 2):
 * - Fall A «nicht verfügbar» (offline / nicht konfiguriert): dezenter
 *   Info-Hinweis — Daten sind lokal gespeichert, kein Backup möglich.
 * - Fall B «echter Fehler trotz Verbindung»: roter Fehler-Toast mit
 *   optionalem «Erneut versuchen» (setzt den Verfügbarkeits-Cache zurück).
 * Es wird NIE Erfolg gemeldet, wenn das Backup nicht bestätigt wurde.
 */
export async function notifyKVBackupProblem(
  err: unknown,
  label: string,
  opts?: { toastId?: string; retry?: () => void | Promise<void> },
): Promise<void> {
  try {
    const { toast } = await import('sonner');
    if (isKvUnavailable(err)) {
      toast.info(
        `${label}: lokal gespeichert — Supabase ist offline oder nicht konfiguriert (noch kein Backup).`,
        { duration: 6000, id: `${opts?.toastId ?? 'kv-backup'}-offline` },
      );
      return;
    }
    toast.error(
      `${label}: Backup nach Supabase fehlgeschlagen — lokal gespeichert. Bitte Verbindung prüfen.`,
      {
        duration: 10000,
        id: opts?.toastId ?? 'kv-backup-failed',
        ...(opts?.retry
          ? {
              action: {
                label: 'Erneut versuchen',
                onClick: () => {
                  resetKVAvailabilityCache();
                  void Promise.resolve()
                    .then(opts.retry)
                    .catch(e => notifyKVBackupProblem(e, label, opts));
                },
              },
            }
          : {}),
      },
    );
  } catch { /* Sonner nicht verfügbar */ }
}

export function subscribeKV(key: string, fn: Listener): () => void {
  if (!_listeners.has(key)) _listeners.set(key, new Set());
  _listeners.get(key)!.add(fn);
  return () => _listeners.get(key)?.delete(fn);
}

function notifyKV(key: string) {
  _listeners.get(key)?.forEach(fn => fn());
}

async function isAvailable(): Promise<boolean> {
  // Verfügbarkeit ist FLÜCHTIG: «verfügbar» gilt nur, bis eine spätere
  // Operation an einem Netzwerkfehler scheitert (markKVFailure invalidiert);
  // «nicht verfügbar» wird nur 30 s gecacht — danach wird neu geprüft,
  // damit sich die App nach einem transienten Ausfall wieder erholt.
  if (_available === true) return true;
  if (_available === false && Date.now() < _unavailableUntil) return false;
  try {
    const { error } = await appSettingsTable()
      .select('key')
      .limit(1);
    if (!error || !isKvUnavailable(error)) {
      // Kein Fehler ODER echter DB-Fehler (z. B. RLS): Verbindung steht —
      // Supabase ist erreichbar, der fachliche Fehler bleibt Sache der Operation.
      markKVSuccess();
    } else {
      _available = false;
    }
  } catch {
    // Geworfene Fehler im Probe-Pfad sind praktisch immer Netzwerk-/Fetch-Fehler.
    _available = false;
  }
  if (_available === false) _unavailableUntil = Date.now() + 30_000;
  return _available;
}

export async function kvGet(key: string): Promise<unknown | null> {
  if (!(await isAvailable())) return null;
  try {
    const { data, error } = await appSettingsTable()
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) {
      markKVFailure(error);
      return null;
    }
    markKVSuccess();
    return data?.value ?? null;
  } catch (err) {
    markKVFailure(err);
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
    throw new KVUnavailableError();
  }
  let res: { data: { value: unknown } | null; error: unknown };
  try {
    res = await appSettingsTable()
      .select('value')
      .eq('key', key)
      .maybeSingle();
  } catch (err) {
    markKVFailure(err);
    throw err;
  }
  if (res.error) {
    markKVFailure(res.error);
    throw res.error;
  }
  markKVSuccess();
  return res.data?.value ?? null;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  if (!(await isAvailable())) return;
  try {
    const { error } = await appSettingsTable()
      .upsert({ key, value }, { onConflict: 'key' });
    if (error) {
      markKVFailure(error);
      return;
    }
    markKVSuccess();
    notifyKV(key);
  } catch (err) {
    // still scheitern (localStorage bleibt Primärspeicher) — aber Netzwerkfehler
    // invalidieren den Availability-Cache, damit «verfügbar» nie einfriert.
    markKVFailure(err);
  }
}

/**
 * Wie kvSet, wirft aber einen Fehler wenn Supabase nicht erreichbar ist
 * oder der Schreibvorgang fehlschlägt. Für kritische Finanzdaten
 * (Umsatz, Budget, Buchungszeilen), deren Backup-Fehler sichtbar sein müssen.
 */
export async function kvSetStrict(key: string, value: unknown): Promise<void> {
  if (!(await isAvailable())) {
    throw new KVUnavailableError();
  }
  let res: { error: unknown };
  try {
    res = await appSettingsTable()
      .upsert({ key, value }, { onConflict: 'key' });
  } catch (err) {
    markKVFailure(err);
    throw err;
  }
  if (res.error) {
    markKVFailure(res.error);
    throw res.error;
  }
  markKVSuccess();
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

  // 1. localStorage (Schnellpfad) — Parse-/Shape-Guard zentral (kv-blob-utils)
  const local = readLocalRecord(storageKey) as Blob;

  // 2. KV (Master-Stand) — STRIKT lesen: ein Lesefehler darf NIE wie
  //    «Remote ist leer» aussehen, sonst würden remote-only Tage beim
  //    Zurückschreiben gelöscht. Bei Lesefehler wird der KV-Write übersprungen
  //    (localStorage bleibt Primärspeicher).
  let remote: Blob = {};
  let remoteReadError: unknown = null;
  try {
    remote = asRecordBlob(await kvGetStrict(storageKey)) as Blob;
  } catch (err) {
    remoteReadError = err;
  }

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

  if (remoteReadError !== null) {
    // Remote-Basis fehlt → KV-Write überspringen (nie Blob ohne Remote-Basis
    // ersetzen). Retry führt den kompletten sicheren Upsert erneut aus.
    console.error(`[SAFE-UPSERT] KV-Lesefehler für ${storageKey} — KV-Write übersprungen:`, remoteReadError);
    await notifyKVBackupProblem(remoteReadError, 'Umsatz', {
      toastId: 'kv-write-failed',
      retry: async () => { await safeUpsertDailyBudgets(storageKey, updates, onlyIfZero); },
    });
    return merged;
  }

  try {
    await kvSetStrict(storageKey, merged);
    console.log(
      `[SAFE-UPSERT] ${storageKey}: ${Object.keys(updates).length} Tage aktualisiert` +
      ` (total: ${Object.keys(merged).length}, onlyIfZero=${onlyIfZero}) ✓ KV gespeichert`,
    );
  } catch (kvError) {
    console.error(`[SAFE-UPSERT] KV-Schreibfehler für ${storageKey}:`, kvError);
    await notifyKVBackupProblem(kvError, 'Umsatz', {
      toastId: 'kv-write-failed',
      retry: async () => { await safeUpsertDailyBudgets(storageKey, updates, onlyIfZero); },
    });
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
  return mergeAndWriteReportingBlob(
    storeKey,
    `safeUpsertReportingMonth`,
    monthId,
    base => ({ ...base, [monthId]: monthRecord }),
  );
}

/**
 * Sicheres Löschen eines Monats aus reporting_v1.
 * Gleicher Kern wie der Upsert: Basis = Remote-Stand ∪ lokale Monate,
 * dann wird NUR der angegebene Monat entfernt. Verhindert, dass andere
 * Monate verschwinden — auch wenn der Remote-Read still fehlschlägt
 * (kvGet → null): ohne die Basis-Union würde dann ein leerer Blob
 * geschrieben und ALLE übrigen Monate remote gelöscht (Befund Runde 2.7).
 */
export async function safeDeleteReportingMonth(
  monthId: string,
  storeKey: string,
): Promise<void> {
  return mergeAndWriteReportingBlob(
    storeKey,
    `safeDeleteReportingMonth`,
    monthId,
    base => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [monthId]: _removed, ...rest } = base;
      return rest;
    },
  );
}

/**
 * Gemeinsamer technischer Kern von safeUpsertReportingMonth und
 * safeDeleteReportingMonth (Runde 2.7). Kapselt NUR den identischen Ablauf —
 * die fachliche Mutation (Monat ersetzen bzw. entfernen) liefert der Aufrufer:
 *
 *   1. Verfügbarkeits-Gate (offline → no-op, localStorage bleibt Primärspeicher)
 *   2. Remote-Stand laden (kvGet) + Shape-Guard
 *   3. Basis-Union mit lokalen Monaten: kvGet liefert bei Lese-Fehlern null
 *      (nicht unterscheidbar von «noch kein Blob») — damit ein fehlgeschlagener
 *      Remote-Read nie Monate verwirft, ergänzen lokale Monate die Basis
 *      (remote gewinnt pro Monat); erst DANACH wirkt die Mutation auf den
 *      Ziel-Monat.
 *   4. Nach Supabase schreiben — Fehler explizit prüfen (Supabase wirft nicht;
 *      sonst gälte ein fehlgeschlagener Write still als Erfolg, T007)
 *   5. Erst NACH Remote-Erfolg: localStorage synchronisieren + Listener
 *      benachrichtigen (Reihenfolge verbindlich — notifyKV nie vor setItem)
 *   6. Fehler: markKVFailure + weiterwerfen (kein destruktiver Fallback-Write;
 *      der Aufrufer macht den Fehler sichtbar)
 */
async function mergeAndWriteReportingBlob(
  storeKey: string,
  label: string,
  monthId: string,
  mutate: (base: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  if (!(await isAvailable())) return;
  try {
    // 1. Aktuellen Supabase-Stand laden (Master) + Shape-Guard
    const base = asRecordBlob(await kvGet(storeKey));
    // 2. Basis-Union: lokale Monate ergänzen, remote gewinnt pro Monat
    const localBase = readLocalRecord(storeKey);
    // 3. Fachliche Mutation NUR auf dem Ziel-Monat
    const merged = mutate({ ...localBase, ...base });
    // 4. Nach Supabase schreiben — Fehler explizit prüfen
    const { error } = await appSettingsTable()
      .upsert({ key: storeKey, value: merged }, { onConflict: 'key' });
    if (error) throw error;
    markKVSuccess();
    // 5. localStorage mit dem vollständigen Stand synchronisieren
    localStorage.setItem(storeKey, JSON.stringify(merged));
    notifyKV(storeKey);
    console.log(`[REPORTING] ${label}: ${storeKey} / ${monthId} ✓`);
  } catch (err) {
    markKVFailure(err);
    console.error(`[REPORTING] ${label} Fehler für ${storeKey}/${monthId}:`, err);
    // KEIN Fallback-kvSet: Ein direkter Blob-Write mit nur EINEM Monat würde
    // alle anderen Monate/Jahre in Supabase löschen (verbotener kompletter
    // Blob-Replace). localStorage bleibt Primärspeicher — der Fehler wird
    // weitergereicht, damit der Aufrufer ihn sichtbar machen kann.
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
    await notifyKVBackupProblem(err, 'Überstunden-Einstellung', {
      toastId: 'overtime-disabled-write-failed',
      retry: () => {
        // Beim Retry FRISCH aus localStorage lesen — kein eingefrorener
        // Snapshot, sonst würde ein inzwischen neuerer Stand zurückgedreht.
        // Der Key ist zur Save-Zeit gebunden (tenant-spezifisch) und bleibt
        // auch nach einem späteren Tenant-Wechsel korrekt.
        let fresh = clean;
        try {
          fresh = toStringIds(JSON.parse(localStorage.getItem(key) ?? '[]'));
        } catch { /* localStorage unlesbar → Snapshot als letzter Fallback */ }
        return kvSetStrict(key, fresh);
      },
    });
  }
}
