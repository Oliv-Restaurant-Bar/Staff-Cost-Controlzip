/**
 * TenantBanner – Mandantenindikator im Hauptbereich
 * ===================================================
 * Zeigt eine farbige Leiste am oberen Rand des Inhaltsbereichs an,
 * wenn ein Mandant aktiv ist (standard: Oliv = kein Banner).
 * Sicherheitsindikator: verhindert versehentliches Arbeiten im falschen Restaurant.
 */

import { useTenant } from '@/contexts/TenantContext';
import { Building2 } from 'lucide-react';

export const TenantBanner = () => {
  const { tenantId, tenant, setTenant } = useTenant();

  if (tenantId === 'oliv') return null;

  return (
    <div
      className="sticky top-0 z-40 flex items-center justify-between gap-3 px-4 py-2 text-white text-sm font-medium shadow-sm"
      style={{ backgroundColor: tenant.color }}
    >
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 flex-shrink-0" />
        <span>
          Aktiver Mandant: <strong>{tenant.name}</strong>
          <span className="ml-2 opacity-80 font-normal text-xs">– alle Daten beziehen sich auf dieses Restaurant</span>
        </span>
      </div>
      <button
        onClick={() => setTenant('oliv')}
        className="flex-shrink-0 text-xs opacity-80 hover:opacity-100 underline underline-offset-2 transition-opacity"
      >
        zu Oliv wechseln
      </button>
    </div>
  );
};
