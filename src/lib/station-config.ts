/**
 * station-config.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Predefined station/role lists per department.
 * These are used as suggestions — users can also enter custom stations.
 */

import { Department } from '@/types/personnel';

// ─── Vordefinierte Stationen ──────────────────────────────────────────────────

export const STATIONS_BY_DEPT: Record<Department, string[]> = {
  service: [
    'Chef de Rang',
    'Runner',
    'Bar',
    'Event',
    'Empfang',
    'Sommelier',
    'Commis de Rang',
    'Serviceleitung',
  ],
  küche: [
    'Pizzaiolo',
    'Grill',
    'Gardemanger',
    'Patisserie',
    'Entremetier',
    'Sous-Chef',
    'Küchenchef',
    'Rôtisseur',
    'Saucier',
    'Prep',
  ],
};

/** Returns all predefined stations for a dept, plus any custom ones from existing employees */
export function getStationsForDept(
  dept: Department,
  customStations: string[] = [],
): string[] {
  const predefined = STATIONS_BY_DEPT[dept] ?? [];
  const custom = customStations.filter(s => !predefined.includes(s));
  return [...predefined, ...custom];
}

/** Color coding per dept for badges */
export const DEPT_BADGE_CLASS: Record<Department, string> = {
  service: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800',
  küche:   'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800',
};

/** Dept label */
export const DEPT_LABEL: Record<Department, string> = {
  service: 'Service',
  küche:   'Küche',
};
