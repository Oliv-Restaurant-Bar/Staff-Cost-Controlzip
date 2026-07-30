/**
 * ug-event-days-db — Tages-Flags «UG/Event offen» (Teil C).
 * ──────────────────────────────────────────────────────────────────────────────
 * Ist das Flag für ein Datum gesetzt, greift der UG-Zuschlag auch ausserhalb
 * des Winter/UG-Regelbetriebs (externe/geschlossene Firmenevents) — ganzjährig,
 * unabhängig vom Saisonprofil.
 *
 * Persistenz: app_settings, Key `ug_event_days:<tenantId>`, Wert
 * { dates: ['yyyy-MM-dd', …] }. Lesen best-effort (leer bei Fehler),
 * Schreiben wirft.
 */
import { appSettingsTable } from '@/lib/app-settings-table';

export function ugEventDaysKey(tenantId: string): string {
  return `ug_event_days:${tenantId}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function loadUgEventDays(tenantId: string): Promise<Set<string>> {
  try {
    const { data, error } = await appSettingsTable()
      .select('value')
      .eq('key', ugEventDaysKey(tenantId))
      .maybeSingle();
    if (error) throw error;
    const raw = (data?.value as { dates?: unknown } | null)?.dates;
    const dates = Array.isArray(raw)
      ? raw.filter((d): d is string => typeof d === 'string' && DATE_RE.test(d))
      : [];
    return new Set(dates);
  } catch {
    return new Set();
  }
}

export async function saveUgEventDays(tenantId: string, dates: Set<string>): Promise<void> {
  const { error } = await appSettingsTable().upsert(
    { key: ugEventDaysKey(tenantId), value: { dates: [...dates].sort() } },
    { onConflict: 'key' },
  );
  if (error) {
    throw new Error(`Event-Tage konnten nicht gespeichert werden: ${error.message}`);
  }
}
