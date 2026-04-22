/**
 * usePermissions – Zentrales Berechtigungssystem
 * ================================================
 * Alle Sichtbarkeits- und Zugriffsregeln für alle Module werden hier definiert.
 * Jede Seite und jede Komponente importiert nur diesen Hook –
 * niemals direkt die Rolle aus useAuth.
 *
 * Rollen:
 *   admin              → Inhaber / Admin: sieht alles
 *   service_manager    → Service-Manager: Dienstplanung (Service) + Soll/Ist-Analyse
 *   kueche_manager     → Küchen-Manager:  Dienstplanung (Küche)  + Soll/Ist-Analyse
 *   beaulieu_manager   → Beaulieu GF: Dienstplanung + Personal FIX + Personalstamm (lesen) + Tagesansicht + Controlling
 *                        Fest auf Mandant Beaulieu gesperrt, kein Tenant-Wechsel
 *
 * Modul-Zugriff im Überblick:
 *   Modul                admin  service_mgr  kueche_mgr  beaulieu_mgr
 *   ──────────────────   ─────  ───────────  ──────────  ────────────
 *   Dashboard             ✓      –            –           –
 *   Dienstplanung         ✓      ✓ (Service)  ✓ (Küche)   ✓ (alle)
 *   Soll/Ist Analyse      ✓      ✓ (Service)  ✓ (Küche)   –
 *   Personal FIX          ✓      –            –           ✓
 *   Tagesansicht          ✓      –            –           ✓
 *   Tages-Controlling     ✓      –            –           ✓
 *   Personalstamm         ✓      –            –           ✓ (lesen)
 *   Reporting / P&L       ✓      –            –           –
 *   Budget / Import       ✓      –            –           –
 */

import { useAuth } from './useAuth';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import type { UserRole } from '@/contexts/AuthContext';

export type AppModule =
  | 'dashboard'
  | 'dienstplanung'
  | 'soll_ist_analyse'
  | 'personalstamm'
  | 'reporting'
  | 'personal_fix'
  | 'tagesansicht'
  | 'tages_controlling';

export type Department = 'service' | 'küche' | 'all';

export interface Permissions {
  // ── Rolle ────────────────────────────────────────────────
  role: UserRole;
  isAdmin: boolean;
  isManager: boolean;
  isBeaulieuManager: boolean;

  // ── Modul-Zugriff ────────────────────────────────────────
  /** Darf der User auf dieses Modul zugreifen? */
  canAccessModule: (module: AppModule) => boolean;

  // ── Abteilungs-Sichtbarkeit ──────────────────────────────
  /** Welche Abteilung(en) darf dieser User sehen? */
  allowedDepartment: Department;
  /** Darf der User eine bestimmte Abteilung sehen? */
  canSeeDepartment: (dept: 'service' | 'küche') => boolean;
  /** Darf der User zwischen Abteilungen wechseln? (nur Admin) */
  canSwitchDepartment: boolean;

  // ── Lohn- und Kostensichtbarkeit ─────────────────────────
  /** Darf der User Einzellöhne pro Mitarbeiter sehen? (nur Admin) */
  canSeeHourlyWages: boolean;
  /** Darf der User Gesamtkosten und Kostenquote sehen? (alle) */
  canSeePersonnelCostTotals: boolean;
  /** Darf der User den Kosten-Knopf (€-Symbol) verwenden? (nur Admin) */
  canToggleCostView: boolean;

  // ── Finanz-Daten ─────────────────────────────────────────
  /** Darf der User vollständige Finanzdaten sehen? (nur Admin) */
  canSeeFullFinancials: boolean;
  /** Darf der User Umsatzziele und Budgets bearbeiten? (nur Admin) */
  canEditBudgets: boolean;

  // ── Personalstamm ────────────────────────────────────────
  /** Darf der User Mitarbeiter anlegen / bearbeiten / löschen? (nur Admin) */
  canEditEmployees: boolean;
  /** Darf der User Einstellungen ändern? (nur Admin) */
  canAccessSettings: boolean;

  // ── Dienstplan ───────────────────────────────────────────
  /** Darf der User den Dienstplan bearbeiten? (alle, aber nur ihre Abt.) */
  canEditSchedule: boolean;
  /** Darf der User Wochen kopieren? (alle, aber nur ihre Abt.) */
  canCopyWeek: boolean;
}

export const usePermissions = (): Permissions => {
  const { role, isAdmin: isAdminUser, isServiceManager, isKuecheManager, isBeaulieuManager: isBeaulieuMgr } = useAuth();
  const { isGuest } = useGuestSession();

  // Gäste erhalten vollständige Admin-Rechte (Lese-Zugriff)
  const isAdmin = isAdminUser || isGuest;

  const isManager = isServiceManager || isKuecheManager || isGuest;
  const isBeaulieuManager = isBeaulieuMgr;

  // Welche Abteilung darf dieser User sehen?
  const allowedDepartment: Department = isAdmin
    ? 'all'
    : isServiceManager
    ? 'service'
    : isBeaulieuManager
    ? 'all'   // Beaulieu GF sieht alle Abteilungen seines Mandanten
    : 'küche';

  const canSeeDepartment = (dept: 'service' | 'küche'): boolean => {
    if (isAdmin) return true;
    if (isServiceManager) return dept === 'service';
    if (isKuecheManager)  return dept === 'küche';
    if (isBeaulieuManager) return true; // alle Abteilungen für Beaulieu-GF
    return false;
  };

  // Modul-Zugriff
  const canAccessModule = (module: AppModule): boolean => {
    switch (module) {
      case 'dashboard':
        return isAdmin;
      case 'dienstplanung':
        return true; // alle (aber gefiltert nach Abteilung)
      case 'soll_ist_analyse':
        return isAdmin || isServiceManager || isKuecheManager; // nicht für beaulieu_manager
      case 'personalstamm':
        return isAdmin || isBeaulieuManager;
      case 'reporting':
        return isAdmin;
      case 'personal_fix':
        return isAdmin || isBeaulieuManager;
      case 'tagesansicht':
        return isAdmin || isBeaulieuManager;
      case 'tages_controlling':
        return isAdmin || isBeaulieuManager;
      default:
        return isAdmin;
    }
  };

  return {
    // Rolle
    role,
    isAdmin,
    isManager,
    isBeaulieuManager,

    // Abteilung
    allowedDepartment,
    canSeeDepartment,
    canSwitchDepartment: isAdmin,

    // Lohn & Kosten
    canSeeHourlyWages:          isAdmin,
    canSeePersonnelCostTotals:  true,
    canToggleCostView:           isAdmin,

    // Finanzen
    canSeeFullFinancials: isAdmin,
    canEditBudgets:       isAdmin,

    // Personal
    canEditEmployees:  isAdmin,
    canAccessSettings: isAdmin,

    // Dienstplan
    canEditSchedule: true,
    canCopyWeek:     true,
    canAccessModule,
  };
};
