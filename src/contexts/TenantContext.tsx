/**
 * TenantContext – Mandantenverwaltung
 * =====================================
 * Verwaltet den aktiven Mandanten (Oliv | Beaulieu).
 * Speichert die Auswahl in localStorage für persistente Anzeige.
 *
 * Schlüsselprinzip zur Datentrennung:
 *   - Oliv      → nutzt bestehende localStorage-Keys unverändert (Rückwärtskompatibilität)
 *   - Beaulieu  → nutzt Präfix "beaulieu:" vor allen Keys
 *
 * Tenant-Lock (beaulieu_manager):
 *   - lockTenant(id)  → setzt tenantLocked=true und erzwingt den Mandanten
 *   - unlockTenant()  → setzt tenantLocked=false (z.B. nach Logout oder Admin-Login)
 *   - setTenant()     → blockiert Wechsel wenn gesperrt
 *
 * WICHTIG: TenantProvider wird nie neu gemountet zwischen Logins.
 * Deshalb muss TenantLockEnforcer in App.tsx den Lock auch aktiv
 * aufheben wenn die Rolle nicht mehr beaulieu_manager ist.
 *
 * Debug-Logs: [TENANT], [AUTH]
 */

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export type TenantId = 'oliv' | 'beaulieu';

export interface TenantConfig {
  id: TenantId;
  name: string;
  shortName: string;
  color: string;
  textColor: string;
  bgColor: string;
  borderColor: string;
}

export const TENANTS: Record<TenantId, TenantConfig> = {
  oliv: {
    id: 'oliv',
    name: 'Oliv Restaurant & Bar',
    shortName: 'Oliv',
    color: '#0d9488',
    textColor: 'text-teal-700',
    bgColor: 'bg-teal-50',
    borderColor: 'border-teal-300',
  },
  beaulieu: {
    id: 'beaulieu',
    name: 'Restaurant Beaulieu',
    shortName: 'Beaulieu',
    color: '#7c3aed',
    textColor: 'text-violet-700',
    bgColor: 'bg-violet-50',
    borderColor: 'border-violet-300',
  },
};

const TENANT_STORAGE_KEY = 'active_tenant';

interface TenantContextValue {
  tenantId: TenantId;
  tenant: TenantConfig;
  setTenant: (id: TenantId) => void;
  /**
   * Gibt den tenant-spezifischen localStorage-Key zurück.
   * Oliv:     key unveraendert (Rückwärtskompatibilität)
   * Beaulieu: "beaulieu:{key}"
   */
  tenantKey: (key: string) => string;
  /**
   * Setzt den Mandanten und sperrt ihn (kein weiterer Wechsel möglich).
   * Wird von TenantLockEnforcer aufgerufen wenn Rolle = beaulieu_manager.
   */
  lockTenant: (id: TenantId) => void;
  /**
   * Hebt den Tenant-Lock auf.
   * Wird von TenantLockEnforcer aufgerufen wenn Rolle nicht mehr beaulieu_manager ist
   * (z.B. nach Logout oder beim Login als Admin).
   */
  unlockTenant: () => void;
  /** true wenn der aktuelle User auf einen Mandanten fest gebunden ist */
  tenantLocked: boolean;
  /**
   * Setzt den Tenant-State vollständig zurück (Logout/Benutzerwechsel):
   * entfernt die persistierte Auswahl, hebt den Lock auf, State → 'oliv'.
   * Ein neuer Login übernimmt so nie die Tenant-Auswahl des vorherigen Benutzers.
   */
  resetTenant: () => void;
}

const TenantContext = createContext<TenantContextValue | null>(null);

export const TenantProvider = ({ children }: { children: ReactNode }) => {
  const [tenantId, setTenantId] = useState<TenantId>(() => {
    const stored = localStorage.getItem(TENANT_STORAGE_KEY);
    const valid: TenantId[] = ['oliv', 'beaulieu'];
    return valid.includes(stored as TenantId) ? (stored as TenantId) : 'oliv';
  });
  const [tenantLocked, setTenantLocked] = useState(false);

  const setTenant = (id: TenantId) => {
    if (tenantLocked) {
      console.warn(`[AUTH] tenant switch blocked: user is locked to "${tenantId}", attempted switch to "${id}" denied`);
      return;
    }
    localStorage.setItem(TENANT_STORAGE_KEY, id);
    setTenantId(id);
    console.log(`[TENANT] active tenant switched to: ${id} (${TENANTS[id].name})`);
  };

  const lockTenant = (id: TenantId) => {
    localStorage.setItem(TENANT_STORAGE_KEY, id);
    setTenantId(id);
    setTenantLocked(true);
    console.log(`[AUTH] tenant lock applied: "${id}" – Mandantenwechsel gesperrt`);
  };

  const unlockTenant = () => {
    setTenantLocked(false);
    console.log('[AUTH] tenant lock released – Mandantenwechsel freigegeben');
  };

  const resetTenant = () => {
    try { localStorage.removeItem(TENANT_STORAGE_KEY); } catch { /* ignore */ }
    setTenantLocked(false);
    setTenantId('oliv');
    console.log('[TENANT] tenant state reset (Logout/Benutzerwechsel) → oliv');
  };

  const tenantKey = (key: string): string =>
    tenantId === 'oliv' ? key : `${tenantId}:${key}`;

  useEffect(() => {
    console.log(`[TENANT] active tenant: ${tenantId} (${TENANTS[tenantId].name})${tenantLocked ? ' [LOCKED]' : ''}`);
  }, [tenantId, tenantLocked]);

  return (
    <TenantContext.Provider value={{ tenantId, tenant: TENANTS[tenantId], setTenant, tenantKey, lockTenant, unlockTenant, tenantLocked, resetTenant }}>
      {children}
    </TenantContext.Provider>
  );
};

export const useTenant = (): TenantContextValue => {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error('useTenant must be used inside TenantProvider');
  return ctx;
};
