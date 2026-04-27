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
 *   beaulieu_manager   → Beaulieu GF: alle Module ausser Budget + Erfolgsrechnung
 *                        Fest auf Mandant Beaulieu gesperrt, kein Tenant-Wechsel
 *
 * Modul-Zugriff im Überblick:
 *   Modul                admin  service_mgr  kueche_mgr  beaulieu_mgr  beaulieu_viewer
 *   ──────────────────   ─────  ───────────  ──────────  ────────────  ───────────────
 *   Dashboard             ✓      –            –           ✓             –
 *   Dienstplanung         ✓      ✓ (Service)  ✓ (Küche)   ✓ (alle)      –
 *   Soll/Ist Analyse      ✓      ✓ (Service)  ✓ (Küche)   –             –
 *   Personal FIX          ✓      –            –           ✓             –
 *   Tagesansicht          ✓      –            –           ✓             –
 *   Tages-Controlling     ✓      –            –           ✓             –
 *   Personalstamm         ✓      –            –           ✓             –
 *   Warenrechnungen       ✓      –            –           ✓ (voll)      ✓ (lesen)
 *   Verkaufs-Dashboard    ✓      –            –           ✓             –
 *   Produktanalyse        ✓      –            –           ✓             –
 *   WES-Analyse           ✓      –            –           ✓             –
 *   Import-Zentrale       ✓      –            –           ✓             –
 *   Verkaufsdaten Upload  ✓      –            –           ✓             –
 *   Produkte / Stamm      ✓      –            –           ✓             –
 *   Budget                ✓      –            –           ✗ (gesperrt)  –
 *   Erfolgsrechnung       ✓      –            –           ✗ (gesperrt)  –
 *   Reporting             ✓      –            –           –             –
 *
 * Warenrechnungen – Feingranulare Rechte (WarenrechnungenPerms):
 *   Aktion     admin  beaulieu_mgr  beaulieu_viewer
 *   ────────   ─────  ────────────  ───────────────
 *   view        ✓      ✓             ✓
 *   create      ✓      ✓             –
 *   edit        ✓      ✓             –
 *   delete      ✓      ✓             –
 *   export      ✓      ✓             ✓  (konfigurierbar, siehe VIEWER_CAN_EXPORT)
 *
 * Neue Rolle hinzufügen:
 *   1. UserRole in AuthContext.tsx ergänzen
 *   2. isXxx Flag hier in usePermissions.ts via useAuth() destructuren
 *   3. canAccessModule + warenrechnungenPerms um neuen Fall erweitern
 */

import { useAuth } from './useAuth';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import type { UserRole } from '@/contexts/AuthContext';

// ─── Konfigurations-Konstante ─────────────────────────────────────────────────
// Darf beaulieu_viewer Daten exportieren?
// true = Viewer kann exportieren, false = kein Export für Viewer
const VIEWER_CAN_EXPORT = true;

export type AppModule =
  | 'dashboard'
  | 'dienstplanung'
  | 'soll_ist_analyse'
  | 'personalstamm'
  | 'reporting'
  | 'personal_fix'
  | 'tagesansicht'
  | 'tages_controlling'
  | 'warenrechnungen';

/** Feingranulare Rechte für das Warenrechnungen-Modul */
export interface WarenrechnungenPerms {
  /** Modul sehen, KPI, Tabellen, Analyse */
  canView: boolean;
  /** Neue Einträge erstellen, Lieferanten hinzufügen */
  canCreate: boolean;
  /** Bestehende Einträge bearbeiten */
  canEdit: boolean;
  /** Einträge löschen */
  canDelete: boolean;
  /** CSV/Excel-Export (konfigurierbar via VIEWER_CAN_EXPORT) */
  canExport: boolean;
}

export type Department = 'service' | 'küche' | 'all';

export interface Permissions {
  // ── Rolle ────────────────────────────────────────────────
  role: UserRole;
  isAdmin: boolean;
  isManager: boolean;
  isBeaulieuManager: boolean;
  /** Beaulieu-Leser: Vollzugriff auf Warenrechnungen (view + export), kein Schreiben */
  isBeaulieuViewer: boolean;

  // ── Modul-Zugriff ────────────────────────────────────────
  /** Darf der User auf dieses Modul zugreifen? */
  canAccessModule: (module: AppModule) => boolean;
  /** Feingranulare Rechte für das Warenrechnungen-Modul */
  warenrechnungenPerms: WarenrechnungenPerms;

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
  const {
    role,
    isAdmin: isAdminUser,
    isServiceManager,
    isKuecheManager,
    isBeaulieuManager: isBeaulieuMgr,
    isBeaulieuViewer: isBeaulieuViewerRaw,
  } = useAuth();
  const { isGuest } = useGuestSession();

  // Gäste erhalten vollständige Admin-Rechte (Lese-Zugriff)
  const isAdmin = isAdminUser || isGuest;

  const isManager = isServiceManager || isKuecheManager || isGuest;
  const isBeaulieuManager = isBeaulieuMgr;
  const isBeaulieuViewer  = isBeaulieuViewerRaw;

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
        return isAdmin || isBeaulieuManager;
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
      case 'warenrechnungen':
        return isAdmin || isBeaulieuManager || isBeaulieuViewer;
      default:
        return isAdmin;
    }
  };

  // ─── Feingranulare Warenrechnungen-Berechtigungen ─────────────────────────
  const warenrechnungenPerms: WarenrechnungenPerms = (() => {
    if (isAdmin || isBeaulieuManager) {
      return { canView: true, canCreate: true, canEdit: true, canDelete: true, canExport: true };
    }
    if (isBeaulieuViewer) {
      return {
        canView:   true,
        canCreate: false,
        canEdit:   false,
        canDelete: false,
        canExport: VIEWER_CAN_EXPORT, // konfigurierbar via VIEWER_CAN_EXPORT
      };
    }
    // alle anderen Rollen: kein Zugriff
    return { canView: false, canCreate: false, canEdit: false, canDelete: false, canExport: false };
  })();

  return {
    // Rolle
    role,
    isAdmin,
    isManager,
    isBeaulieuManager,
    isBeaulieuViewer,

    // Modul + feingranulare Rechte
    canAccessModule,
    warenrechnungenPerms,

    // Abteilung
    allowedDepartment,
    canSeeDepartment,
    canSwitchDepartment: isAdmin || isBeaulieuManager,

    // Lohn & Kosten
    canSeeHourlyWages:          isAdmin || isBeaulieuManager,
    canSeePersonnelCostTotals:  true,
    canToggleCostView:           isAdmin || isBeaulieuManager,

    // Finanzen
    canSeeFullFinancials: isAdmin,
    canEditBudgets:       isAdmin,

    // Personal — Beaulieu GF darf Lohn/Stammdaten eigener Mitarbeiter pflegen
    canEditEmployees:  isAdmin || isBeaulieuManager,
    canAccessSettings: isAdmin,

    // Dienstplan
    canEditSchedule: true,
    canCopyWeek:     true,
  };
};
