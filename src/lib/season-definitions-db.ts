/**
 * Persistenz frei definierter Saisons (Saisonvergleich der Wochentags-Analyse).
 * ============================================================================
 * Speichert die pro Mandant frei anpassbaren, datumsfixen Saisons (Name +
 * from/to + optionale Farbe + aktiv). Bewusst NUR im KV-Store (`app_settings`)
 * plus localStorage-Cache — KEINE eigene Tabelle, KEINE Migration.
 *
 * localStorage = schneller Cache, KV = Master (geräteübergreifend). Da `kvSet`
 * Fehler verschluckt, wird der Schreibvorgang per Read-back verifiziert; kann er
 * nicht bestätigt werden, gibt `saveSeasonDefinitions` `false` zurück, damit der
 * Aufrufer einen Hinweis zeigen kann (sonst glaubte der Nutzer, es sei gespeichert).
 *
 * Key-Format analog `overtime-disabled`: „reservation-seasons" (Oliv) bzw.
 * „<tenant>:reservation-seasons".
 */
import { kvGet, kvSet } from './supabase-kv';
import { isValidIsoDate, type SeasonDefinition } from './reservation-weekday-analytics';

const BASE = 'reservation-seasons';

/** KV-/localStorage-Schlüssel je Mandant (Oliv ohne Prefix, sonst „<tenant>:…"). */
export function reservationSeasonsKey(tenantId: string): string {
  return tenantId === 'oliv' ? BASE : `${tenantId}:${BASE}`;
}

/**
 * Tolerante Umwandlung eines unbekannten (KV-/localStorage-)Werts in gültige
 * Saisons: nur Einträge mit id + Name + gültigem from/to überleben; `active`
 * defaultet auf true, `color` ist optional.
 */
export function toSeasonDefinitions(value: unknown): SeasonDefinition[] {
  if (!Array.isArray(value)) return [];
  const out: SeasonDefinition[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    const name = typeof o.name === 'string' ? o.name : '';
    const from = typeof o.from === 'string' ? o.from : '';
    const to = typeof o.to === 'string' ? o.to : '';
    if (!id || !name.trim() || !isValidIsoDate(from) || !isValidIsoDate(to)) continue;
    const color = typeof o.color === 'string' ? o.color : undefined;
    const active = o.active !== false; // fehlend/true → aktiv
    out.push({ id, name, from, to, color, active });
  }
  return out;
}

function readCache(key: string): SeasonDefinition[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return toSeasonDefinitions(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeCache(key: string, defs: SeasonDefinition[]): void {
  try { localStorage.setItem(key, JSON.stringify(defs)); } catch { /* ignore */ }
}

/**
 * Lädt die Saisons eines Mandanten. Cache-first NUR wenn nicht leer — ein staler
 * leerer Cache (frischer Login, anderes Gerät) darf echte KV-Daten nicht
 * verdecken (analog `loadOvertimeDisabledIds`).
 */
export async function loadSeasonDefinitions(tenantId: string): Promise<SeasonDefinition[]> {
  const key = reservationSeasonsKey(tenantId);
  const cached = readCache(key);
  if (cached && cached.length > 0) return cached;
  const remote = toSeasonDefinitions(await kvGet(key));
  writeCache(key, remote);
  return remote;
}

/** Vergleichs-Serialisierung (id-sortiert, feste Felder) für den Read-back. */
function serializeForCompare(defs: SeasonDefinition[]): string {
  return JSON.stringify(
    defs
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((d) => ({
        id: d.id,
        name: d.name,
        from: d.from,
        to: d.to,
        color: d.color ?? null,
        active: d.active,
      })),
  );
}

/**
 * Speichert die Saisons eines Mandanten: localStorage sofort (optimistisch) + KV
 * (Master) mit Read-back-Verifikation. Wirft NICHT; gibt `false` zurück, wenn
 * die persistente Speicherung nicht bestätigt werden konnte.
 */
export async function saveSeasonDefinitions(
  tenantId: string,
  defs: SeasonDefinition[],
): Promise<boolean> {
  const key = reservationSeasonsKey(tenantId);
  writeCache(key, defs);
  await kvSet(key, defs);
  try {
    const check = toSeasonDefinitions(await kvGet(key));
    return serializeForCompare(check) === serializeForCompare(defs);
  } catch {
    return false;
  }
}
