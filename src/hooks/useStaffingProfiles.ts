/**
 * useStaffingProfiles — lädt/speichert die Personalbedarf-Profil-Konfiguration
 * des aktiven Mandanten (Profile inkl. Datumsbereich + Festsetzen, CdS-Priorität,
 * Umsatzbudget je Wochentag). Quelle: app_settings (staffing-profiles-db).
 */
import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import {
  defaultStaffingProfilesConfig,
  type StaffingProfilesConfig,
} from '@/lib/staffing-profiles-utils';
import {
  loadStaffingProfilesConfig,
  saveStaffingProfilesConfig,
} from '@/lib/staffing-profiles-db';

export function useStaffingProfiles() {
  const { tenantId } = useTenant();
  const [config, setConfig] = useState<StaffingProfilesConfig>(() =>
    defaultStaffingProfilesConfig(tenantId),
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setConfig(defaultStaffingProfilesConfig(tenantId));
    (async () => {
      const loaded = await loadStaffingProfilesConfig(tenantId);
      if (!cancelled) {
        setConfig(loaded);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId]);

  /** Speichert die komplette Konfiguration und übernimmt sie lokal. WIRFT bei Fehlern. */
  const save = useCallback(
    async (next: StaffingProfilesConfig) => {
      await saveStaffingProfilesConfig(tenantId, next);
      setConfig(next);
    },
    [tenantId],
  );

  return { tenantId, config, loading, save };
}
