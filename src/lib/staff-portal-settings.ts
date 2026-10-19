/**
 * Staff Portal Settings
 * ─────────────────────
 * Central config for all Mitarbeiterportal features.
 * Admins toggle settings in the Settings page.
 * Settings are embedded in published schedule payloads so the public
 * portal page respects them without needing an additional Supabase RLS policy.
 *
 * Pattern: localStorage (fast) → Supabase KV (persistent, cross-device).
 */

import { kvGet, kvSetConfirmed } from '@/lib/supabase-kv';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StaffPortalCommunicationSettings {
  /** Employees can send Rückfragen (questions) to management */
  allowQuestions: boolean;
  /** Employees can send wishes / Hinweise */
  allowRequests: boolean;
  /** Show "Bestätigt" confirmation button */
  requireConfirmation: boolean;
  /** Show "Gesehen" seen-status button */
  enableSeenStatus: boolean;
  /** Highlight changed days with orange border and "Geändert" badge */
  showChangeHighlights: boolean;
  /** Show "Zum Startbildschirm hinzufügen" hint banner */
  showHomeScreenHint: boolean;
}

export interface StaffPortalVisibilitySettings {
  /** Show the "Woche" (week grid) tab in the department view */
  enableWeekView: boolean;
  /** Show the "Nach Tag" (by-day) tab */
  enableDayView: boolean;
  /** Show the employee name search bar */
  enableEmployeeSearch: boolean;
  /** Show days with no shift ("Kein Dienst") */
  showFreeDays: boolean;
  /** Show department section labels (Service / Küche) */
  showDepartments: boolean;
  /** Show shift hours (e.g. 10:00–18:00) */
  showHours: boolean;
}

export interface StaffPortalNotificationSettings {
  /** WhatsApp share button for links (future) */
  enableWhatsApp: boolean;
  /** QR-Code generation for links (future) */
  enableQRCode: boolean;
  /** Prepare browser push notification infrastructure (future) */
  enablePushPreparation: boolean;
  /** Show orange "Aktualisiert" badge when schedule has changes */
  showUpdateBadges: boolean;
}

export interface StaffPortalSecuritySettings {
  /** Allow publishing personal (employee-specific) links */
  allowPersonalLinks: boolean;
  /** Allow publishing department-wide links */
  allowDepartmentLinks: boolean;
  /** Keep older published schedules accessible (not yet active) */
  keepOldSchedulesVisible: boolean;
  /** Auto-expire published links after N days (0 = never) */
  linkExpiryDays: number;
}

export interface StaffPortalFutureSettings {
  /** Prepare data model for shift-swap requests (no active UI yet) */
  prepareShiftSwap: boolean;
  /** Prepare data model for availability submissions (future) */
  prepareAvailability: boolean;
  /** Prepare data model for wish-days (future) */
  prepareWishDays: boolean;
}

export interface StaffPortalSettings {
  communication: StaffPortalCommunicationSettings;
  visibility: StaffPortalVisibilitySettings;
  notifications: StaffPortalNotificationSettings;
  security: StaffPortalSecuritySettings;
  future: StaffPortalFutureSettings;
}

// ─── Defaults (all current features enabled = backwards compatible) ───────────

export const DEFAULT_STAFF_PORTAL_SETTINGS: StaffPortalSettings = {
  communication: {
    allowQuestions: true,
    allowRequests: true,
    requireConfirmation: true,
    enableSeenStatus: true,
    showChangeHighlights: true,
    showHomeScreenHint: true,
  },
  visibility: {
    enableWeekView: true,
    enableDayView: true,
    enableEmployeeSearch: true,
    showFreeDays: true,
    showDepartments: true,
    showHours: true,
  },
  notifications: {
    enableWhatsApp: false,
    enableQRCode: false,
    enablePushPreparation: false,
    showUpdateBadges: true,
  },
  security: {
    allowPersonalLinks: true,
    allowDepartmentLinks: true,
    keepOldSchedulesVisible: false,
    linkExpiryDays: 0,
  },
  future: {
    prepareShiftSwap: false,
    prepareAvailability: false,
    prepareWishDays: false,
  },
};

// ─── Storage ──────────────────────────────────────────────────────────────────

const KV_KEY = 'staff-portal-settings';
const LS_KEY = 'staff-portal-settings';

/** Deep-merge b into a (one level of nesting). */
function deepMerge(base: StaffPortalSettings, override: Partial<StaffPortalSettings>): StaffPortalSettings {
  return {
    communication: { ...base.communication, ...(override.communication ?? {}) },
    visibility:    { ...base.visibility,    ...(override.visibility    ?? {}) },
    notifications: { ...base.notifications, ...(override.notifications ?? {}) },
    security:      { ...base.security,      ...(override.security      ?? {}) },
    future:        { ...base.future,        ...(override.future        ?? {}) },
  };
}

/** Synchronous read from localStorage — instant, used on page load. */
export function getStaffPortalSettingsSync(): StaffPortalSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return deepMerge(DEFAULT_STAFF_PORTAL_SETTINGS, JSON.parse(raw) as Partial<StaffPortalSettings>);
  } catch { /* ignore */ }
  return DEFAULT_STAFF_PORTAL_SETTINGS;
}

/**
 * Load with Supabase fallback.
 * Fast path: localStorage.  Slow path: Supabase KV.
 */
export async function loadStaffPortalSettings(): Promise<StaffPortalSettings> {
  // Fast path
  const sync = getStaffPortalSettingsSync();
  const hasLocal = !!localStorage.getItem(LS_KEY);
  if (hasLocal) return sync;

  // Slow path — Supabase
  try {
    const remote = await kvGet(KV_KEY);
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      const merged = deepMerge(DEFAULT_STAFF_PORTAL_SETTINGS, remote as Partial<StaffPortalSettings>);
      try { localStorage.setItem(LS_KEY, JSON.stringify(merged)); } catch { /* ignore */ }
      return merged;
    }
  } catch { /* ignore */ }

  return DEFAULT_STAFF_PORTAL_SETTINGS;
}

/**
 * Persist to localStorage + Supabase KV.
 * Call from admin Settings UI after every toggle.
 */
export async function saveStaffPortalSettings(settings: StaffPortalSettings): Promise<void> {
  // Database-first (Issue #5): the caller (StaffPortalSettingsPanel) already
  // awaits and shows an error toast on failure, so it's safe to throw here
  // and only cache locally after Supabase confirms the write.
  await kvSetConfirmed(KV_KEY, settings, 'Personal-Portal-Einstellungen');
}
