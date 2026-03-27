/**
 * AppNav – Zentrales Navigationsmodul
 * =====================================
 * Desktop: linke Sidebar (220px), sticky
 * Mobile: Bottom-Navigation (fixiert)
 *
 * Sichtbarkeit der Navigationspunkte wird nach Rolle gefiltert:
 *   admin           → alle Punkte
 *   service_manager → Dienstplanung (Service), Soll/Ist Analyse (Service)
 *   kueche_manager  → Dienstplanung (Küche),   Soll/Ist Analyse (Küche)
 */

import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Calendar, BarChart2, Users,
  Settings, LogOut, ChefHat, Utensils, ShieldCheck,
  TrendingUp, Upload, Truck, Calculator, CalendarClock, X, Eye, DollarSign, Package, UserX, Archive, TrendingDown, Activity, ShoppingBag, Layers, PieChart,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { usePermissions } from '@/hooks/usePermissions';
import { useStichtag } from '@/contexts/StichtagContext';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { Button } from '@/components/ui/button';
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from '@/components/ui/tooltip';

// ─── Navigationsstruktur ─────────────────────────────────────────────────────

interface NavItem {
  path: string;
  label: string;
  shortLabel: string; // für Mobile-Bottom-Bar
  icon: React.FC<{ className?: string }>;
  adminOnly?: boolean;
  comingSoon?: boolean;
  module?: import('@/hooks/usePermissions').AppModule;
}

const NAV_ITEMS: NavItem[] = [
  {
    path: '/',
    label: 'Dashboard',
    shortLabel: 'Home',
    icon: LayoutDashboard,
    module: 'dashboard',
  },
  {
    path: '/personal',
    label: 'Dienstplanung',
    shortLabel: 'Dienst',
    icon: Calendar,
    module: 'dienstplanung',
  },
  {
    path: '/analyse',
    label: 'Soll / Ist Analyse',
    shortLabel: 'Analyse',
    icon: BarChart2,
    module: 'soll_ist_analyse',
  },
  {
    path: '/personal-stamm',
    label: 'Personalstamm',
    shortLabel: 'Personal',
    icon: Users,
    adminOnly: true,
  },
  {
    path: '/settings',
    label: 'Einstellungen',
    shortLabel: 'Settings',
    icon: Settings,
    adminOnly: true,
  },
  {
    path: '/reporting',
    label: 'Reporting',
    shortLabel: 'Report',
    icon: TrendingUp,
    adminOnly: true,
  },
  {
    path: '/erfolgsrechnung',
    label: 'Erfolgsrechnung',
    shortLabel: 'P&L',
    icon: BarChart2,
    adminOnly: true,
  },
  {
    path: '/import',
    label: 'Import-Zentrale',
    shortLabel: 'Import',
    icon: Upload,
    adminOnly: true,
  },
  {
    path: '/lieferanten',
    label: 'Lieferanten',
    shortLabel: 'Lief.',
    icon: Truck,
    adminOnly: true,
  },
  {
    path: '/budget',
    label: 'Budget-Planung',
    shortLabel: 'Budget',
    icon: Calculator,
    adminOnly: true,
  },
  {
    path: '/personal-fix',
    label: 'Personal FIX',
    shortLabel: 'FIX',
    icon: DollarSign,
    adminOnly: true,
  },
  {
    path: '/produkte',
    label: 'Produkte',
    shortLabel: 'Produkte',
    icon: Package,
    adminOnly: true,
  },
  {
    path: '/artikel',
    label: 'Artikelstamm',
    shortLabel: 'Artikel',
    icon: Archive,
    adminOnly: true,
  },
  {
    path: '/artikel-tracking',
    label: 'Artikel-Tracking',
    shortLabel: 'Tracking',
    icon: Activity,
    adminOnly: true,
  },
  {
    path: '/wes-analyse',
    label: 'WES-Analyse',
    shortLabel: 'WES',
    icon: TrendingDown,
    adminOnly: true,
  },
  {
    path: '/lunch-analyse',
    label: 'Lunch-Analyse',
    shortLabel: 'Lunch',
    icon: Utensils,
    adminOnly: true,
  },
  {
    path: '/takeaway-analyse',
    label: 'Take-Away-Analyse',
    shortLabel: 'Take Away',
    icon: ShoppingBag,
    adminOnly: true,
  },
  {
    path: '/absenzen',
    label: 'Absenzen & Ersatz',
    shortLabel: 'Absenzen',
    icon: UserX,
    adminOnly: true,
  },
  {
    path: '/verkauf-dashboard',
    label: 'Verkaufs-Dashboard',
    shortLabel: 'Verkauf',
    icon: PieChart,
    adminOnly: true,
  },
  {
    path: '/sales-upload',
    label: 'Verkaufsdaten Upload',
    shortLabel: 'Upload',
    icon: Upload,
    adminOnly: true,
  },
  {
    path: '/produkt-analyse',
    label: 'Produktanalyse',
    shortLabel: 'Produkte',
    icon: Layers,
    adminOnly: true,
  },
  {
    path: '/kategorien',
    label: 'Kategorien',
    shortLabel: 'Kategorien',
    icon: BarChart2,
    adminOnly: true,
  },
];

// ─── Rollen-Konfiguration ─────────────────────────────────────────────────────

const ROLE_CONFIG = {
  admin: {
    label:     'Administrator',
    shortLabel: 'Admin',
    color:     'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-700',
    dotColor:  'bg-purple-500',
    Icon:      ShieldCheck,
  },
  service_manager: {
    label:     'Service-Manager',
    shortLabel: 'Service-Mgr',
    color:     'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700',
    dotColor:  'bg-blue-500',
    Icon:      Utensils,
  },
  kueche_manager: {
    label:     'Küchen-Manager',
    shortLabel: 'Küchen-Mgr',
    color:     'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-700',
    dotColor:  'bg-orange-500',
    Icon:      ChefHat,
  },
};

// ─── Stichtag-Picker (Sidebar-Widget) ───────────────────────────────────────

const StichtagPicker = () => {
  const { stichtag, isActive, setStichtag, clearStichtag, formatted } = useStichtag();

  const inputValue = stichtag
    ? stichtag.toISOString().split('T')[0]  // "YYYY-MM-DD"
    : '';

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (!val) {
      clearStichtag();
    } else {
      setStichtag(new Date(val + 'T12:00:00'));
    }
  };

  return (
    <div className={cn(
      'mx-3 mb-2 rounded-md border p-2.5 space-y-1.5 transition-colors',
      isActive
        ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30'
        : 'border-border bg-muted/30',
    )}>
      <div className="flex items-center gap-1.5">
        <CalendarClock className={cn('h-3.5 w-3.5 flex-shrink-0', isActive ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')} />
        <span className={cn('text-[10px] font-semibold uppercase tracking-wider', isActive ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
          Stichtag
        </span>
        {isActive && (
          <button
            onClick={clearStichtag}
            className="ml-auto h-4 w-4 flex items-center justify-center rounded-full bg-amber-200 dark:bg-amber-800 hover:bg-amber-300 dark:hover:bg-amber-700 text-amber-700 dark:text-amber-300 transition-colors"
            title="Stichtag aufheben"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        )}
      </div>

      {isActive ? (
        <p className="text-xs font-bold text-amber-800 dark:text-amber-300">
          per {formatted}
        </p>
      ) : (
        <p className="text-[10px] text-muted-foreground leading-tight">
          Auswertungen auf Datum begrenzen
        </p>
      )}

      <input
        type="date"
        value={inputValue}
        onChange={handleChange}
        max={new Date().toISOString().split('T')[0]}
        className={cn(
          'w-full text-[11px] rounded px-1.5 py-1 border bg-background transition-colors',
          isActive
            ? 'border-amber-300 dark:border-amber-700 focus:ring-amber-400'
            : 'border-border focus:ring-primary',
        )}
      />
    </div>
  );
};

// ─── Desktop-Sidebar ─────────────────────────────────────────────────────────

export const AppSidebar = () => {
  const location      = useLocation();
  const { user, signOut } = useAuth();
  const { role, isAdmin, isManager, allowedDepartment, canAccessModule } = usePermissions();
  const { isGuest, guestMinutesLeft, clearGuestSession } = useGuestSession();

  console.log('[NAV] AppSidebar render', { role, isAdmin, userEmail: user?.email });

  const roleConfig = ROLE_CONFIG[role as keyof typeof ROLE_CONFIG] ?? ROLE_CONFIG.admin;
  const RoleIcon = isGuest ? Eye : roleConfig.Icon;

  const visibleItems = NAV_ITEMS.filter(item => {
    if (item.comingSoon && !isAdmin && !isGuest) return false;
    if (item.adminOnly && !isAdmin && !isGuest) return false;
    if (item.module && !canAccessModule(item.module) && !isGuest) return false;
    return true;
  });

  const emailShort = user?.email
    ? user.email.length > 22 ? user.email.slice(0, 22) + '…' : user.email
    : '';

  const guestH = Math.floor(guestMinutesLeft / 60);
  const guestM = guestMinutesLeft % 60;
  const guestLabel = guestH > 0 ? `${guestH}h ${guestM}min` : `${guestMinutesLeft} Min.`;

  return (
    <aside className="hidden md:flex flex-col flex-shrink-0 w-[220px] min-h-screen bg-card border-r border-border sticky top-0 h-screen overflow-y-auto">

      {/* Marke */}
      <div className="px-4 pt-5 pb-4 border-b border-border">
        <p className="text-xs font-bold tracking-widest uppercase text-muted-foreground/70 mb-0.5">oLiv</p>
        <p className="text-sm font-bold leading-tight">Restaurant & Bar</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">Personalkostentracker</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {visibleItems.map(item => {
          const Icon = item.icon;
          const isActive = item.path === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(item.path);

          if (item.comingSoon) {
            return (
              <div
                key={item.path}
                className="flex items-center gap-2.5 px-3 py-2 rounded-md text-muted-foreground/40 cursor-not-allowed"
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <span className="text-sm">{item.label}</span>
                <span className="ml-auto text-[9px] font-bold uppercase tracking-wide bg-muted/50 text-muted-foreground/60 px-1.5 py-0.5 rounded">
                  Bald
                </span>
              </div>
            );
          }

          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {item.label}
            </NavLink>
          );
        })}
      </nav>

      {/* Stichtag-Picker */}
      <StichtagPicker />

      {/* Rollen-Bereich + Abmelden */}
      <div className="border-t border-border px-3 py-3 space-y-2">
        {/* Rollen-Badge / Gast-Badge */}
        {isGuest ? (
          <div className="flex items-center gap-2 rounded-md px-2.5 py-2 border text-xs font-semibold bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:border-violet-700">
            <Eye className="h-3.5 w-3.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="font-bold">Gast-Zugang</p>
              <p className="text-[10px] opacity-80 font-normal">Nur Lesen · {guestLabel}</p>
            </div>
          </div>
        ) : (
          <div className={cn(
            'flex items-center gap-2 rounded-md px-2.5 py-2 border text-xs font-semibold',
            roleConfig.color,
          )}>
            <RoleIcon className="h-3.5 w-3.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="font-bold truncate">{roleConfig.label}</p>
              {isManager && allowedDepartment !== 'all' && (
                <p className="text-[10px] opacity-80 font-normal">
                  Bereich: {allowedDepartment === 'service' ? 'Service' : 'Küche'}
                </p>
              )}
              {isAdmin && (
                <p className="text-[10px] opacity-80 font-normal">Alle Abteilungen</p>
              )}
            </div>
          </div>
        )}

        {/* E-Mail */}
        {emailShort && !isGuest && (
          <p className="text-[10px] text-muted-foreground px-1 truncate">{emailShort}</p>
        )}

        {/* Abmelden / Sitzung beenden */}
        <Button
          variant="outline"
          size="sm"
          onClick={isGuest
            ? () => { clearGuestSession(); window.location.href = '/gast'; }
            : () => { signOut(); }
          }
          className="w-full h-8 text-xs text-destructive border-destructive/30 hover:bg-destructive/10 justify-start gap-2"
        >
          <LogOut className="h-3.5 w-3.5" />
          {isGuest ? 'Sitzung beenden' : 'Abmelden'}
        </Button>
      </div>
    </aside>
  );
};

// ─── Mobile Bottom-Navigation ─────────────────────────────────────────────────

export const AppBottomNav = () => {
  const location = useLocation();
  const { isAdmin, canAccessModule } = usePermissions();
  const { isGuest } = useGuestSession();

  // Mobile zeigt max. 4 Hauptpunkte
  const mobileItems = NAV_ITEMS.filter(item => {
    if (item.comingSoon) return false;
    if (item.adminOnly && !isAdmin && !isGuest) return false;
    if (item.module && !canAccessModule(item.module) && !isGuest) return false;
    // Einstellungen auf Mobile weglassen (zu wenig Platz)
    if (item.path === '/settings') return false;
    return true;
  }).slice(0, 5);

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border flex">
      {mobileItems.map(item => {
        const Icon = item.icon;
        const isActive = item.path === '/'
          ? location.pathname === '/'
          : location.pathname.startsWith(item.path);

        return (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={cn(
              'flex-1 flex flex-col items-center gap-0.5 py-2 px-1 text-[10px] font-medium transition-colors',
              isActive
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className={cn('h-5 w-5', isActive && 'stroke-[2.5]')} />
            {item.shortLabel}
          </NavLink>
        );
      })}
    </nav>
  );
};

// ─── Kombiniertes Export (für App.tsx) ───────────────────────────────────────

export const AppNav = () => (
  <>
    <AppSidebar />
    <AppBottomNav />
  </>
);
