/**
 * staffing-profiles-db — Persistenz der Personalbedarf-Profile (app_settings).
 * ──────────────────────────────────────────────────────────────────────────────
 * Key je Mandant: `staffing_profiles:<tenantId>` (explizit für BEIDE Mandanten,
 * damit keine Präfix-Sonderfälle entstehen). Zugriff ausschliesslich über den
 * typisierten Wrapper appSettingsTable().
 *
 * Lesen: best-effort — bei Fehlern/fehlendem Key werden die Mandanten-Defaults
 * geliefert (Anzeige bleibt funktionsfähig). Schreiben: WIRFT bei Fehlern.
 */
import { appSettingsTable } from '@/lib/app-settings-table';
import {
  normalizeStaffingProfilesConfig,
  type StaffingProfilesConfig,
} from '@/lib/staffing-profiles-utils';

export function staffingProfilesKey(tenantId: string): string {
  return `staffing_profiles:${tenantId}`;
}

export async function loadStaffingProfilesConfig(tenantId: string): Promise<StaffingProfilesConfig> {
  try {
    const { data, error } = await appSettingsTable()
      .select('value')
      .eq('key', staffingProfilesKey(tenantId))
      .maybeSingle();
    if (error) throw error;
    return normalizeStaffingProfilesConfig(data?.value ?? null, tenantId);
  } catch {
    return normalizeStaffingProfilesConfig(null, tenantId);
  }
}

export async function saveStaffingProfilesConfig(
  tenantId: string,
  config: StaffingProfilesConfig,
): Promise<void> {
  const { error } = await appSettingsTable().upsert(
    { key: staffingProfilesKey(tenantId), value: config as unknown },
    { onConflict: 'key' },
  );
  if (error) {
    throw new Error(`Profil-Konfiguration konnte nicht gespeichert werden: ${error.message}`);
  }
}
