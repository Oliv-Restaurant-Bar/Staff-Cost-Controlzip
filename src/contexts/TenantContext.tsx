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
 * Debug-Logs: [TENANT]
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
}

const TenantContext = createContext<TenantContextValue | null>(null);

export const TenantProvider = ({ children }: { children: ReactNode }) => {
  const [tenantId, setTenantId] = useState<TenantId>(() => {
    const stored = localStorage.getItem(TENANT_STORAGE_KEY);
    const valid: TenantId[] = ['oliv', 'beaulieu'];
    return valid.includes(stored as TenantId) ? (stored as TenantId) : 'oliv';
  });

  const setTenant = (id: TenantId) => {
    localStorage.setItem(TENANT_STORAGE_KEY, id);
    setTenantId(id);
    console.log(`[TENANT] active tenant switched to: ${id} (${TENANTS[id].name})`);
  };

  const tenantKey = (key: string): string =>
    tenantId === 'oliv' ? key : `${tenantId}:${key}`;

  useEffect(() => {
    console.log(`[TENANT] active tenant: ${tenantId} (${TENANTS[tenantId].name})`);
  }, [tenantId]);

  return (
    <TenantContext.Provider value={{ tenantId, tenant: TENANTS[tenantId], setTenant, tenantKey }}>
      {children}
    </TenantContext.Provider>
  );
};

export const useTenant = (): TenantContextValue => {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error('useTenant must be used inside TenantProvider');
  return ctx;
};
