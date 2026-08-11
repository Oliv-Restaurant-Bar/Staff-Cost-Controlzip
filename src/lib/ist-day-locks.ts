/**
 * ist-day-locks.ts
 * ================
 * Tages-/Wochensperren für Ist-Stunden im Dienstplan.
 *
 * Gesperrte Tage werden von MIRUS-Import, Plan→Ist-Sync und manueller
 * Erfassung NICHT mehr überschrieben. Zum Korrigieren kurz entsperren,
 * ändern, wieder sperren. Wochensperre = Sperre aller Wochentage des
 * angezeigten Monats (Sperr-Granularität ist IMMER der Tag).
 *
 * Speicherung: Supabase app_settings (mandantenfähig, übersteht Re-Imports)
 *   key   = "ist_day_locks:{tenantId}:{YYYY-MM}"
 *   value = { tenantId, month, dates: string[], updatedAt }
 *
 * Fail-closed-Disziplin: Schreibpfade (Importe) müssen die Locks STRIKT
 * lesen (loadIstDayLocksStrict) — ein Lesefehler darf nie als «keine
 * Sperren» interpretiert werden.
 */

import { appSettingsTable } from '@/lib/app-settings-table';

export interface IstDayLockState {
  tenantId: string;
  month: string;          // 'YYYY-MM'
  dates: string[];        // gesperrte ISO-Tage, sortiert
  updatedAt: string;      // ISO timestamp
}

function lockKey(tenantId: string, month: string): string {
  return `ist_day_locks:${tenantId}:${month}`;
}

/**
 * Strikt lesen: wirft bei Lesefehler (fail-closed für Import-Guards).
 * Fehlender Eintrag = keine Sperren (leeres Set).
 */
export async function loadIstDayLocksStrict(tenantId: string, month: string): Promise<Set<string>> {
  const { data, error } = await appSettingsTable()
    .select('value')
    .eq('key', lockKey(tenantId, month))
    .maybeSingle();
  if (error) throw new Error(`Tagessperren konnten nicht geprüft werden: ${error.message}`);
  const val = (data?.value ?? null) as IstDayLockState | null;
  return new Set(Array.isArray(val?.dates) ? val!.dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : []);
}

/**
 * Strikt für MEHRERE Monate lesen (Union) — für Commit-Guards, deren
 * Schreib-Zeitraum Monatsgrenzen überschreiten kann. Wirft bei Lesefehler.
 */
export async function loadIstDayLocksForMonths(
  tenantId: string,
  months: Iterable<string>,
): Promise<Set<string>> {
  const uniq = [...new Set(months)];
  const sets = await Promise.all(uniq.map(m => loadIstDayLocksStrict(tenantId, m)));
  const union = new Set<string>();
  for (const s of sets) for (const d of s) union.add(d);
  return union;
}

/** Best-effort lesen (UI-Anzeige): Fehler → leeres Set + console.warn. */
export async function loadIstDayLocks(tenantId: string, month: string): Promise<Set<string>> {
  try {
    return await loadIstDayLocksStrict(tenantId, month);
  } catch (e) {
    console.warn(`[IST-LOCK] Laden fehlgeschlagen (${tenantId} ${month}):`, e);
    return new Set();
  }
}

/** Kompletten Sperr-Zustand eines Monats speichern (Set ersetzt den Blob). */
export async function saveIstDayLocks(
  tenantId: string,
  month: string,
  dates: Set<string>,
): Promise<{ error: string | null }> {
  const state: IstDayLockState = {
    tenantId, month,
    dates: [...dates].filter(d => d.startsWith(`${month}-`)).sort(),
    updatedAt: new Date().toISOString(),
  };
  try {
    const { error } = await appSettingsTable().upsert(
      { key: lockKey(tenantId, month), value: state as unknown as Record<string, unknown> },
      { onConflict: 'key' },
    );
    if (error) return { error: error.message };
    console.log(`[IST-LOCK] tenant: ${tenantId} | month: ${month} | ${state.dates.length} Tage gesperrt`);
    return { error: null };
  } catch (e) {
    return { error: String(e) };
  }
}
