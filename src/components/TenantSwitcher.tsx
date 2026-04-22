/**
 * TenantSwitcher – Mandantenauswahl
 * ====================================
 * Erlaubt das Wechseln zwischen Oliv und Beaulieu.
 * Zeigt den aktiven Mandanten farblich hervorgehoben an.
 *
 * Für beaulieu_manager: Mandant nur lesbar anzeigen (kein Wechsel möglich).
 */

import { useTenant, TENANTS, TenantId } from '@/contexts/TenantContext';
import { Building2, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TenantSwitcherProps {
  /** Kompakte Darstellung für Sidebar-Footer */
  compact?: boolean;
}

export const TenantSwitcher = ({ compact = false }: TenantSwitcherProps) => {
  const { tenantId, setTenant, tenantLocked, tenant } = useTenant();

  const tenantList = Object.values(TENANTS) as typeof TENANTS[TenantId][];

  // Wenn Tenant gesperrt: nur aktiven Mandanten als read-only Badge anzeigen
  if (tenantLocked) {
    return (
      <div className="mx-3 mb-2 rounded-md border border-border p-2 flex items-center gap-2">
        <Lock className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        <span
          className="text-xs font-semibold"
          style={{ color: tenant.color }}
        >
          {tenant.shortName}
        </span>
        <span className="ml-auto text-[9px] text-muted-foreground">gesperrt</span>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="mx-3 mb-2 rounded-md border border-border p-1.5 space-y-1">
        <div className="flex items-center gap-1.5 mb-1">
          <Building2 className="h-3 w-3 text-muted-foreground flex-shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Restaurant
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          {tenantList.map(t => (
            <button
              key={t.id}
              onClick={() => setTenant(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors text-left w-full',
                tenantId === t.id
                  ? 'text-white shadow-sm'
                  : 'text-muted-foreground hover:bg-muted',
              )}
              style={tenantId === t.id ? { backgroundColor: t.color } : undefined}
              title={t.name}
            >
              <span
                className="h-2 w-2 rounded-full flex-shrink-0 ring-1 ring-white/20"
                style={{ backgroundColor: t.color }}
              />
              {t.shortName}
              {tenantId === t.id && (
                <span className="ml-auto text-[9px] opacity-80">✓ aktiv</span>
              )}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 mb-2">
        <Building2 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <span className="text-sm font-medium">Restaurant wechseln</span>
      </div>
      <div className="flex gap-2">
        {tenantList.map(t => (
          <button
            key={t.id}
            onClick={() => setTenant(t.id)}
            className={cn(
              'flex-1 flex flex-col items-center gap-1 py-2 px-3 rounded-lg border text-sm font-medium transition-colors',
              tenantId === t.id
                ? 'text-white border-transparent shadow-md'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
            style={tenantId === t.id ? { backgroundColor: t.color, borderColor: t.color } : undefined}
          >
            <span
              className="h-3 w-3 rounded-full ring-2 ring-white/30"
              style={{ backgroundColor: tenantId === t.id ? 'rgba(255,255,255,0.8)' : t.color }}
            />
            {t.shortName}
          </button>
        ))}
      </div>
    </div>
  );
};
