/**
 * AppNav – Zentrales Navigationsmodul
 * =====================================
 * Desktop: linke Sidebar (220px), sticky
 * Mobile: Bottom-Navigation (fixiert)
 *
 * Struktur:
 *   Dashboard    (standalone)
 *   Verkauf      → Verkaufsdashboard · Tagesansicht · Kennzahlen Bericht · Forecast Planung
 *   Umsatz       → Umsatzabstimmung · Tagesabschlüsse · Budget · Erfolgsrechnung · Produkteanalyse
 *   Personal     → Dienstplanung · Personalkosten · Personalstamm · Datenintegrität MA
 *   Warenkosten  → Warenrechnungen · WES Analyse · Produkte
 *   Foratable    → Gäste CRM (sekundär: Gäste & Reservationen · Reservations Analyse · Duplikate)
 *   Admin        → Einstellungen
 *   Import       → Import (zentrales Import-Center /import; Cockpit nur via Header-Link/URL)
 *
 * Sekundäre Items (secondary: true) liegen pro Gruppe hinter einem
 * „Mehr"-Toggle (Desktop-Sidebar + Mobile-Sheet), Standard: eingeklappt.
 *
 * Ausgeblendet (Routen existieren weiterhin, nur nicht verlinkt):
 *   /reporting   Analyse / Reporting
 *   /artikel     Artikelstamm
 *   /artikel-tracking
 *   /lunch-analyse
 *   /takeaway-analyse
 *   /absenzen
 */

import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import {
  LayoutDashboard, Calendar, PieChart,
  DollarSign, TrendingDown,
  Package, Users,
  Settings, Inbox,
  LogOut, ChefHat, Utensils, ShieldCheck,
  CalendarClock, Contact, X, Eye, Table2, Activity,
  Wallet, BarChart2, BarChart3, ShoppingCart, TrendingUp,
  Menu, ClipboardCheck, ShieldAlert, Scale, GitMerge,
  Tags, ClipboardList, FileText, ChevronDown, UserPlus, Building2,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { usePermissions } from '@/hooks/usePermissions';
import { useStichtag } from '@/contexts/StichtagContext';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';
import { useMaison } from '@/contexts/MaisonContext';
import { Button } from '@/components/ui/button';
import { useTenant } from '@/contexts/TenantContext';
import { TenantSwitcher } from '@/components/TenantSwitcher';

// ─── Typen ───────────────────────────────────────────────────────────────────

interface NavItem {
  path: string;
  label: string;
  shortLabel: string;
  icon: React.FC<{ className?: string }>;
  adminOnly?: boolean;
  /** Explizit auch für beaulieu_manager sichtbar machen, auch wenn adminOnly=true */
  beaulieuAllowed?: boolean;
  /** Auch für beaulieu_viewer sichtbar machen (parallel zu beaulieuAllowed). */
  beaulieuViewerAllowed?: boolean;
  /** Für Gast-Sessions ausblenden, obwohl isAdmin für Gäste true ist. */
  hideForGuest?: boolean;
  /**
   * Sekundärer Menüpunkt: erscheint pro Gruppe hinter einem „Mehr"-Toggle
   * (standardmässig eingeklappt), um die Navigation zu entlasten. Klappt
   * automatisch auf, wenn die Route gerade aktiv ist.
   */
  secondary?: boolean;
  module?: import('@/hooks/usePermissions').AppModule;
}

interface NavGroup {
  groupLabel: string;
  adminOnly?: boolean;
  items: NavItem[];
}

// ─── Navigationsstruktur ─────────────────────────────────────────────────────

// Standalone top item (kein Gruppen-Label)
const DASHBOARD_ITEM: NavItem = {
  path: '/',
  label: 'Start',
  shortLabel: 'Start',
  icon: LayoutDashboard,
  module: 'dashboard',
};

export const NAV_GROUPS: NavGroup[] = [
  {
    groupLabel: 'Verkauf',
    items: [
      // '/dashboard' (Ausführliches Dashboard): Route + Guard bleiben bestehen,
      // aber bewusst KEIN Nav-Eintrag mehr — erreichbar über den Button
      // «Ausführliches Dashboard» auf der Startübersicht und direkt per URL;
      // für Manager-Rollen bleibt es die Startroute «/».
      {
        path: '/verkauf-dashboard',
        label: 'Verkaufsdashboard',
        shortLabel: 'Verkauf',
        icon: PieChart,
        adminOnly: true,
        beaulieuAllowed: true,
        secondary: true,
      },
      {
        path: '/tagesansicht',
        label: 'Tagesansicht',
        shortLabel: 'Tage',
        icon: Table2,
        module: 'tagesansicht' as import('@/hooks/usePermissions').AppModule,
      },
      {
        path: '/kennzahlen-bericht',
        label: 'Kennzahlen Bericht',
        shortLabel: 'KPI',
        icon: BarChart2,
        adminOnly: true,
        beaulieuAllowed: true,
        secondary: true,
      },
      {
        path: '/forecast',
        label: 'Forecast Planung',
        shortLabel: 'Forecast',
        icon: TrendingUp,
        adminOnly: true,
        beaulieuAllowed: true,
      },
    ],
  },
  {
    groupLabel: 'Umsatz',
    adminOnly: true,
    items: [
      {
        path: '/umsatzabstimmung',
        label: 'Umsatzabstimmung',
        shortLabel: 'Abstimmung',
        icon: Scale,
        adminOnly: true,
      },
      {
        path: '/tagesabschluesse',
        label: 'Tagesabschlüsse',
        shortLabel: 'Tagesabschl.',
        icon: ClipboardCheck,
        adminOnly: true,
      },
      {
        path: '/op-liste',
        label: 'OP-Liste Kreditoren',
        shortLabel: 'OP-Liste',
        icon: FileText,
        adminOnly: true,
        // beaulieuAllowed bewusst absent: beaulieu_manager sieht die OP-Liste nicht
      },
      {
        path: '/budget',
        label: 'Budget',
        shortLabel: 'Budget',
        icon: Wallet,
        adminOnly: true,
        // beaulieuAllowed: false — intentionally absent: beaulieu_manager darf Budget nicht sehen
      },
      {
        path: '/erfolgsrechnung',
        label: 'Erfolgsrechnung',
        shortLabel: 'ER',
        icon: BarChart3,
        adminOnly: true,
        // beaulieuAllowed: false — intentionally absent: beaulieu_manager darf Erfolgsrechnung nicht sehen
      },
      {
        path: '/produkt-analyse',
        label: 'Produktanalyse',
        shortLabel: 'Produkte',
        icon: BarChart3,
        adminOnly: true,
        beaulieuAllowed: true,
      },
    ],
  },
  {
    groupLabel: 'Personal',
    items: [
      {
        path: '/personal',
        label: 'Dienstplanung',
        shortLabel: 'Dienst',
        icon: Calendar,
        module: 'dienstplanung',
      },
      {
        path: '/personal-fix',
        label: 'Personalkosten',
        shortLabel: 'Kosten',
        icon: DollarSign,
        module: 'personal_fix' as import('@/hooks/usePermissions').AppModule,
      },
      {
        path: '/personal-stamm',
        label: 'Personalstamm',
        shortLabel: 'Personal',
        icon: Users,
        module: 'personalstamm' as import('@/hooks/usePermissions').AppModule,
      },
      {
        path: '/personaleintritt',
        label: 'Personaleintritt',
        shortLabel: 'Eintritt',
        icon: UserPlus,
        adminOnly: true,
        beaulieuAllowed: true,
        hideForGuest: true,
        secondary: true,
      },
      {
        path: '/betriebe',
        label: 'Betriebe',
        shortLabel: 'Betriebe',
        icon: Building2,
        adminOnly: true,
        hideForGuest: true,
        secondary: true,
      },
      {
        path: '/positionen',
        label: 'Positionen',
        shortLabel: 'Position',
        icon: Tags,
        adminOnly: true,
        module: 'positionen' as import('@/hooks/usePermissions').AppModule,
      },
      {
        path: '/personalbedarf',
        label: 'Personalbedarf',
        shortLabel: 'Bedarf',
        icon: ClipboardList,
        adminOnly: true,
        module: 'personalbedarf' as import('@/hooks/usePermissions').AppModule,
      },
      {
        path: '/employee-integrity',
        label: 'Datenintegrität MA',
        shortLabel: 'Integrität',
        icon: ShieldAlert,
        adminOnly: true,
        secondary: true,
      },
    ],
  },
  {
    groupLabel: 'Warenkosten',
    items: [
      {
        path: '/warenrechnungen',
        label: 'Warenrechnungen',
        shortLabel: 'Waren',
        icon: ShoppingCart,
        module: 'warenrechnungen' as import('@/hooks/usePermissions').AppModule,
      },
      {
        path: '/wes-analyse',
        label: 'WES Analyse',
        shortLabel: 'WES',
        icon: TrendingDown,
        adminOnly: true,
        beaulieuAllowed: true,
      },
      {
        path: '/produkt-stamm',
        label: 'Produkte',
        shortLabel: 'Produkte',
        icon: Package,
        adminOnly: true,
        beaulieuAllowed: true,
      },
    ],
  },
  {
    groupLabel: 'Foratable',
    adminOnly: true,
    items: [
      // Gäste-PII: alle Foratable-Seiten leiten Gast-Sessions um (isAdmin && !isGuest)
      // → Menüpunkte für Gäste komplett ausblenden (keine toten Links, kein PII-Hinweis).
      {
        path: '/gaeste',
        label: 'Gäste CRM',
        shortLabel: 'Gäste',
        icon: Contact,
        adminOnly: true,
        hideForGuest: true,
      },
      {
        path: '/gaeste/auswertung',
        label: 'Gäste & Reservationen',
        shortLabel: 'Auswertung',
        icon: BarChart3,
        adminOnly: true,
        hideForGuest: true,
        secondary: true,
      },
      {
        path: '/gaeste/analyse',
        label: 'Reservations Analyse',
        shortLabel: 'Analyse',
        icon: TrendingUp,
        adminOnly: true,
        hideForGuest: true,
        secondary: true,
      },
      {
        path: '/gaeste/duplikate',
        label: 'Gäste Duplikate',
        shortLabel: 'Duplikate',
        icon: GitMerge,
        adminOnly: true,
        hideForGuest: true,
        secondary: true,
      },
    ],
  },
  {
    groupLabel: 'Admin',
    adminOnly: true,
    items: [
      {
        path: '/settings',
        label: 'Einstellungen',
        shortLabel: 'Settings',
        icon: Settings,
        adminOnly: true,
        beaulieuAllowed: true,
      },
    ],
  },
  {
    groupLabel: 'Import',
    adminOnly: true,
    items: [
      {
        path: '/import',
        label: 'Import',
        shortLabel: 'Import',
        icon: Inbox,
        adminOnly: true,
        // Beaulieu-GF/Viewer dürfen das Import-Center öffnen (sehen dort nur ihre Route-Karten);
        // Gäste sind ausgeschlossen (Import = Schreibaktion, Seite leitet Gäste ohnehin um).
        beaulieuAllowed: true,
        beaulieuViewerAllowed: true,
        hideForGuest: true,
      },
      // Import-Cockpit: Route + Guard bleiben bestehen, aber bewusst KEIN
      // Nav-Eintrag mehr — erreichbar über den Header-Link im Import-Center
      // („Alle Quellen & Kontrollen") und direkt per URL /import-cockpit.
    ],
  },
];

// Flache Liste (für Mobile-Nav)
const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap(g => g.items);

// Alle gruppierten Pfade (ohne Dashboard '/', das exakt geprüft wird).
const ALL_NAV_PATHS: string[] = ALL_NAV_ITEMS.map(i => i.path);

/**
 * Liefert den am besten passenden (längsten) Navigationspfad für den aktuellen
 * Standort — oder null. Über die Längen-Priorisierung wird genau EIN Menüpunkt
 * aktiv markiert, auch bei verschachtelten Routen (z. B. `/gaeste` vs.
 * `/gaeste/auswertung`, oder `/personal` vs. `/personal-fix` / `/personal-stamm`).
 */
function activeNavPath(pathname: string): string | null {
  let best: string | null = null;
  for (const p of ALL_NAV_PATHS) {
    if (pathname === p || pathname.startsWith(p + '/')) {
      if (best === null || p.length > best.length) best = p;
    }
  }
  return best;
}

// ─── Gruppen mit „Mehr"-Toggle (sekundäre Menüpunkte) ────────────────────────

/**
 * Teilt sichtbare Items in primär/sekundär und hält den Auf/Zu-Zustand des
 * „Mehr"-Toggles. Klappt automatisch auf, wenn eine sekundäre Route aktiv ist.
 */
function useSecondarySplit(items: NavItem[], currentActivePath: string | null) {
  const primary = items.filter(i => !i.secondary);
  const secondary = items.filter(i => i.secondary);
  const secondaryActive = secondary.some(i => i.path === currentActivePath);
  const [moreOpen, setMoreOpen] = useState(secondaryActive);
  useEffect(() => {
    if (secondaryActive) setMoreOpen(true);
  }, [secondaryActive]);
  return { primary, secondary, moreOpen, toggle: () => setMoreOpen(o => !o) };
}

const NavMoreToggle = ({ open, onClick, count }: { open: boolean; onClick: () => void; count: number }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
    aria-expanded={open}
  >
    <ChevronDown className={cn('h-3.5 w-3.5 flex-shrink-0 transition-transform', !open && '-rotate-90')} />
    Mehr {!open && <span className="text-muted-foreground/50">({count})</span>}
  </button>
);

/** Desktop-Sidebar: eine Gruppe mit primären Items + „Mehr"-Toggle. */
const SidebarNavGroup = ({
  group,
  items,
  currentActivePath,
}: {
  group: NavGroup;
  items: NavItem[];
  currentActivePath: string | null;
}) => {
  const { primary, secondary, moreOpen, toggle } = useSecondarySplit(items, currentActivePath);

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active = item.path === currentActivePath;
    return (
      <NavLink
        key={item.path}
        to={item.path}
        className={cn(
          'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
          active
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <Icon className="h-4 w-4 flex-shrink-0" />
        {item.label}
      </NavLink>
    );
  };

  return (
    <div className="mt-5">
      <div className="mx-3 mb-2 border-t border-border/50" />
      <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
        {group.groupLabel}
      </p>
      <div className="space-y-0.5">
        {primary.map(renderItem)}
        {secondary.length > 0 && (
          <>
            <NavMoreToggle open={moreOpen} onClick={toggle} count={secondary.length} />
            {moreOpen && secondary.map(renderItem)}
          </>
        )}
      </div>
    </div>
  );
};

/** Mobile-Sheet: eine Gruppe mit primären Items + „Mehr"-Toggle. */
const SheetNavGroup = ({
  group,
  items,
  currentActivePath,
  pathname,
  onNavigate,
}: {
  group: NavGroup;
  items: NavItem[];
  currentActivePath: string | null;
  pathname: string;
  onNavigate: (path: string) => void;
}) => {
  const { primary, secondary, moreOpen, toggle } = useSecondarySplit(items, currentActivePath);

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active = item.path === '/' ? pathname === '/' : item.path === currentActivePath;
    return (
      <button
        key={item.path}
        onClick={() => onNavigate(item.path)}
        className={cn(
          'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left',
          active ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted',
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {item.label}
      </button>
    );
  };

  return (
    <div className="pt-3">
      <div className="mx-1 mb-1.5 border-t border-border/50" />
      <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        {group.groupLabel}
      </p>
      <div className="space-y-0.5">
        {primary.map(renderItem)}
        {secondary.length > 0 && (
          <>
            <NavMoreToggle open={moreOpen} onClick={toggle} count={secondary.length} />
            {moreOpen && secondary.map(renderItem)}
          </>
        )}
      </div>
    </div>
  );
};

// ─── Rollen-Konfiguration ─────────────────────────────────────────────────────

const ROLE_CONFIG = {
  admin: {
    label:      'Administrator',
    color:      'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-700',
    Icon:       ShieldCheck,
  },
  service_manager: {
    label:      'Service-Manager',
    color:      'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700',
    Icon:       Utensils,
  },
  kueche_manager: {
    label:      'Küchen-Manager',
    color:      'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-700',
    Icon:       ChefHat,
  },
  beaulieu_manager: {
    label:      'Beaulieu – Geschäftsführer',
    color:      'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-700',
    Icon:       ShieldCheck,
  },
};

// ─── Stichtag-Picker ─────────────────────────────────────────────────────────

const StichtagPicker = () => {
  const { stichtag, isActive, setStichtag, clearStichtag, formatted } = useStichtag();
  const inputValue = stichtag ? stichtag.toISOString().split('T')[0] : '';

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (!val) clearStichtag();
    else setStichtag(new Date(val + 'T12:00:00'));
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
      {isActive
        ? <p className="text-xs font-bold text-amber-800 dark:text-amber-300">per {formatted}</p>
        : <p className="text-[10px] text-muted-foreground leading-tight">Auswertungen auf Datum begrenzen</p>
      }
      <input
        type="date"
        value={inputValue}
        onChange={handleChange}
        max={new Date().toISOString().split('T')[0]}
        className={cn(
          'w-full text-[11px] rounded px-1.5 py-1 border bg-background transition-colors',
          isActive ? 'border-amber-300 dark:border-amber-700' : 'border-border',
        )}
      />
    </div>
  );
};

// ─── Desktop-Sidebar ─────────────────────────────────────────────────────────

export const AppSidebar = () => {
  const location = useLocation();
  const { user, signOut } = useAuth();
  const { role, isAdmin, isManager, isBeaulieuManager, isBeaulieuViewer, allowedDepartment, canAccessModule } = usePermissions();
  const { isGuest, guestMinutesLeft, clearGuestSession } = useGuestSession();

  const { showMarketingCol, setShowMarketingCol, maisonExclude, setMaisonExclude } = useMaison();
  const { tenant } = useTenant();

  // Auto-hide sidebar on schedule planner — it has its own inline panel
  const isSchedulePlannerRoute = location.pathname === '/personal' || location.pathname === '/schedule-planner';
  if (isSchedulePlannerRoute) return null;

  const roleConfig = ROLE_CONFIG[role as keyof typeof ROLE_CONFIG] ?? ROLE_CONFIG.admin;
  const RoleIcon = isGuest ? Eye : roleConfig.Icon;

  const emailShort = user?.email
    ? user.email.length > 22 ? user.email.slice(0, 22) + '…' : user.email
    : '';

  const guestH = Math.floor(guestMinutesLeft / 60);
  const guestM = guestMinutesLeft % 60;
  const guestLabel = guestH > 0 ? `${guestH}h ${guestM}min` : `${guestMinutesLeft} Min.`;

  function isItemVisible(item: NavItem): boolean {
    // Gast-Sessions: explizit markierte Items (z.B. Import-Center) ausblenden, obwohl isAdmin(Gast)=true
    if (item.hideForGuest && isGuest) return false;
    // adminOnly items: sichtbar für admin/guest, oder für beaulieu_manager/-viewer wenn erlaubt
    if (item.adminOnly && !isAdmin && !isGuest) {
      if (!(isBeaulieuManager && item.beaulieuAllowed) && !(isBeaulieuViewer && item.beaulieuViewerAllowed)) return false;
    }
    // module-based items: canAccessModule (beaulieu_manager korrekt abgedeckt)
    if (item.module && !canAccessModule(item.module) && !isGuest) return false;
    return true;
  }

  const currentActivePath = activeNavPath(location.pathname);

  return (
    <aside className="hidden md:flex flex-col flex-shrink-0 w-[220px] min-h-screen bg-card border-r border-border sticky top-0 h-screen overflow-y-auto">

      {/* Marke */}
      <div className="px-4 pt-5 pb-4 border-b border-border">
        {isBeaulieuManager ? (
          <div className="flex flex-col items-start gap-1">
            <img
              src="/beaulieu-logo.png"
              alt="Beaulieu – Deheime ir Länggass"
              className="w-full max-w-[172px] object-contain"
              style={{ maxHeight: 52 }}
            />
            <p className="text-[10px] text-muted-foreground mt-0.5">Personalkostentracker</p>
          </div>
        ) : (
          <>
            <p
              className="text-xs font-bold tracking-widest uppercase mb-0.5"
              style={{ color: tenant.color }}
            >
              {tenant.shortName}
            </p>
            <p className="text-sm font-bold leading-tight">{tenant.name.replace(tenant.shortName, '').trim() || tenant.name}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Personalkostentracker</p>
          </>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3">

        {/* Dashboard — standalone, kein Gruppen-Label */}
        {isItemVisible(DASHBOARD_ITEM) && (() => {
          const Icon = DASHBOARD_ITEM.icon;
          const active = location.pathname === '/';
          return (
            <NavLink
              to={DASHBOARD_ITEM.path}
              end
              className={cn(
                'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {DASHBOARD_ITEM.label}
            </NavLink>
          );
        })()}

        {/* Gruppen mit Trennlinie (sekundäre Items hinter „Mehr") */}
        {NAV_GROUPS.map((group, gi) => {
          const visibleItems = group.items.filter(isItemVisible);
          if (visibleItems.length === 0) return null;
          return (
            <SidebarNavGroup
              key={gi}
              group={group}
              items={visibleItems}
              currentActivePath={currentActivePath}
            />
          );
        })}
      </nav>

      {/* Stichtag-Picker */}
      <StichtagPicker />

      {/* Marketing / Maison Toggle */}
      <div className="border-t border-border px-3 py-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 px-0.5">
          Marketing / Maison
        </p>
        <div className="flex rounded-md overflow-hidden border border-border text-xs h-7">
          <button
            type="button"
            onClick={() => setShowMarketingCol(true)}
            className={cn(
              'flex-1 transition-colors font-medium',
              showMarketingCol ? 'bg-violet-600 text-white' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            Anzeigen
          </button>
          <button
            type="button"
            onClick={() => setShowMarketingCol(false)}
            className={cn(
              'flex-1 transition-colors font-medium',
              !showMarketingCol ? 'bg-muted text-foreground font-semibold' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            Ausblenden
          </button>
        </div>
        <p className="text-[9px] mt-1 px-0.5 leading-tight">
          {!showMarketingCol
            ? <span className="text-muted-foreground">Überall ausgeblendet</span>
            : <span className="text-violet-700 dark:text-violet-400 font-medium">✓ Sichtbar · in Betriebsertrag eingerechnet</span>
          }
        </p>
      </div>

      {/* Mandantenauswahl */}
      <TenantSwitcher compact />

      {/* Rolle + Abmelden */}
      <div className="border-t border-border px-3 py-3 space-y-2">
        {isGuest ? (
          <div className="flex items-center gap-2 rounded-md px-2.5 py-2 border text-xs font-semibold bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:border-violet-700">
            <Eye className="h-3.5 w-3.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="font-bold">Gast-Zugang</p>
              <p className="text-[10px] opacity-80 font-normal">Nur Lesen · {guestLabel}</p>
            </div>
          </div>
        ) : (
          <div className={cn('flex items-center gap-2 rounded-md px-2.5 py-2 border text-xs font-semibold', roleConfig.color)}>
            <RoleIcon className="h-3.5 w-3.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="font-bold truncate">{roleConfig.label}</p>
              {isManager && allowedDepartment !== 'all' && (
                <p className="text-[10px] opacity-80 font-normal">
                  {allowedDepartment === 'service' ? 'Service' : 'Küche'}
                </p>
              )}
              {isAdmin && <p className="text-[10px] opacity-80 font-normal">Alle Abteilungen</p>}
              {isBeaulieuManager && (
                <p className="text-[10px] opacity-80 font-normal">Beaulieu · gesperrt</p>
              )}
            </div>
          </div>
        )}

        {emailShort && !isGuest && (
          <p className="text-[10px] text-muted-foreground px-1 truncate">{emailShort}</p>
        )}

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

// Die 4 fixen Schnellzugriffe in der Bottom-Bar
const PINNED_PATHS = ['/', '/tages-controlling', '/personal', '/personal-fix'];

export const AppBottomNav = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAdmin, isBeaulieuManager, isBeaulieuViewer, canAccessModule } = usePermissions();
  const { isGuest } = useGuestSession();

  const { showMarketingCol, setShowMarketingCol, maisonExclude, setMaisonExclude } = useMaison();
  const { tenant } = useTenant();
  const { user, signOut } = useAuth();
  const { isActive: stichtagActive, stichtagYear, stichtagMonth, stichtagDay, stichtag, formatted: stichtagFormatted, setStichtag, clearStichtag } = useStichtag();

  const [open, setOpen] = useState(false);

  // Sheet schließen bei Routenwechsel
  useEffect(() => { setOpen(false); }, [location.pathname]);

  function isItemVisible(item: NavItem): boolean {
    if (item.hideForGuest && isGuest) return false;
    if (item.adminOnly && !isAdmin && !isGuest) {
      if (!(isBeaulieuManager && item.beaulieuAllowed) && !(isBeaulieuViewer && item.beaulieuViewerAllowed)) return false;
    }
    if (item.module && !canAccessModule(item.module) && !isGuest) return false;
    return true;
  }

  // Pinned-Items filtern (nur sichtbare)
  const pinnedItems = [DASHBOARD_ITEM, ...ALL_NAV_ITEMS]
    .filter(item => PINNED_PATHS.includes(item.path) && isItemVisible(item));

  const currentActivePath = activeNavPath(location.pathname);
  const anySubpageActive = currentActivePath !== null && !PINNED_PATHS.includes(currentActivePath);

  const stichtagInputValue = stichtag ? stichtag.toISOString().split('T')[0] : '';

  return (
    <>
      {/* Bottom Bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border flex safe-area-bottom">
        {pinnedItems.map(item => {
          const Icon = item.icon;
          const isActive = item.path === '/'
            ? location.pathname === '/'
            : item.path === currentActivePath;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              className={cn(
                'flex-1 flex flex-col items-center gap-0.5 py-2 px-1 text-[10px] font-medium transition-colors',
                isActive ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <Icon className={cn('h-5 w-5', isActive && 'stroke-[2.5]')} />
              {item.shortLabel}
            </NavLink>
          );
        })}

        {/* Mehr-Button */}
        <button
          onClick={() => setOpen(true)}
          className={cn(
            'flex-1 flex flex-col items-center gap-0.5 py-2 px-1 text-[10px] font-medium transition-colors',
            (open || anySubpageActive) ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <Menu className={cn('h-5 w-5', (open || anySubpageActive) && 'stroke-[2.5]')} />
          Mehr
        </button>
      </nav>

      {/* Vollständiges Nav-Sheet */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="h-[85vh] flex flex-col p-0 rounded-t-2xl">
          <SheetHeader className="px-4 pt-4 pb-2 border-b border-border shrink-0">
            <SheetTitle className="text-sm font-bold text-left">Navigation</SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
            {/* Dashboard standalone */}
            {isItemVisible(DASHBOARD_ITEM) && (() => {
              const Icon = DASHBOARD_ITEM.icon;
              const active = location.pathname === '/';
              return (
                <button
                  key={DASHBOARD_ITEM.path}
                  onClick={() => navigate(DASHBOARD_ITEM.path)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left',
                    active ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {DASHBOARD_ITEM.label}
                </button>
              );
            })()}

            {/* Gruppen (sekundäre Items hinter „Mehr") */}
            {NAV_GROUPS.map((group, gi) => {
              const visibleItems = group.items.filter(isItemVisible);
              if (visibleItems.length === 0) return null;
              return (
                <SheetNavGroup
                  key={gi}
                  group={group}
                  items={visibleItems}
                  currentActivePath={currentActivePath}
                  pathname={location.pathname}
                  onNavigate={navigate}
                />
              );
            })}
          </div>

          {/* Stichtag + Umsatzbasis im Sheet-Footer */}
          <div className="shrink-0 border-t border-border px-4 py-3 space-y-3">
            {/* Marketing / Maison Toggle (Mobile) */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                Marketing / Maison
              </p>
              <div className="flex rounded-md overflow-hidden border border-border text-xs h-8">
                <button
                  onClick={() => setShowMarketingCol(true)}
                  className={cn(
                    'flex-1 transition-colors font-medium',
                    showMarketingCol ? 'bg-violet-600 text-white' : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  Anzeigen
                </button>
                <button
                  onClick={() => setShowMarketingCol(false)}
                  className={cn(
                    'flex-1 transition-colors font-medium',
                    !showMarketingCol ? 'bg-muted text-foreground font-semibold' : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  Ausblenden
                </button>
              </div>
            </div>

            {/* Stichtag */}
            <div className={cn(
              'rounded-lg border p-2.5 space-y-1.5',
              stichtagActive
                ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30'
                : 'border-border bg-muted/30',
            )}>
              <div className="flex items-center gap-1.5">
                <CalendarClock className={cn('h-3.5 w-3.5', stichtagActive ? 'text-amber-600' : 'text-muted-foreground')} />
                <span className={cn('text-[10px] font-semibold uppercase tracking-wider', stichtagActive ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
                  Stichtag
                </span>
                {stichtagActive && (
                  <button
                    onClick={clearStichtag}
                    className="ml-auto h-4 w-4 flex items-center justify-center rounded-full bg-amber-200 dark:bg-amber-800 text-amber-700 dark:text-amber-300"
                    title="Stichtag aufheben"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>
              {stichtagActive
                ? <p className="text-xs font-bold text-amber-800 dark:text-amber-300">per {stichtagFormatted}</p>
                : <p className="text-[10px] text-muted-foreground">Auswertungen auf Datum begrenzen</p>
              }
              <input
                type="date"
                value={stichtagInputValue}
                onChange={e => {
                  const val = e.target.value;
                  if (!val) clearStichtag();
                  else setStichtag(new Date(val + 'T12:00:00'));
                }}
                max={new Date().toISOString().split('T')[0]}
                className={cn(
                  'w-full text-[11px] rounded px-1.5 py-1 border bg-background',
                  stichtagActive ? 'border-amber-300 dark:border-amber-700' : 'border-border',
                )}
              />
            </div>

            {/* Abmelden */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setOpen(false); signOut(); }}
              className="w-full h-8 text-xs text-destructive border-destructive/30 hover:bg-destructive/10 justify-start gap-2"
            >
              <LogOut className="h-3.5 w-3.5" />
              Abmelden
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
};

// ─── Kombiniertes Export ──────────────────────────────────────────────────────

export const AppNav = () => (
  <>
    <AppSidebar />
    <AppBottomNav />
  </>
);
