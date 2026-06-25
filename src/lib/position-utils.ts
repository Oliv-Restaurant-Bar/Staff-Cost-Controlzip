/**
 * position-utils — reine Logik der Positionsverwaltung (Personalbedarf-Grundlage).
 * ──────────────────────────────────────────────────────────────────────────────
 * KEINE Supabase-/DOM-Abhängigkeiten (nur `import type` aus den Modellen +
 * STATIONS_BY_DEPT aus station-config). Damit im Node-Env testbar.
 *
 * Zentrale Regel: Mitarbeitende speichern einen stabilen Positions-KEY, nicht
 * den Anzeigenamen. `resolvePositionKey` toleriert Alt-Daten (Anzeigename) und
 * mappt sie auf den passenden Key.
 */

import type { Department, Employee } from '@/types/personnel';
import type { Position, PositionDraft } from '@/types/positions';
import { STATIONS_BY_DEPT } from '@/lib/station-config';

export const DEPARTMENTS: Department[] = ['service', 'küche'];

/** Standard-Farbe je Abteilung (für geseedete Positionen). */
export const DEPT_DEFAULT_COLOR: Record<Department, string> = {
  service: '#3b82f6', // blue-500
  'küche': '#f97316',  // orange-500
};

/** Standard-Icon je Abteilung (für geseedete Positionen). */
export const DEPT_DEFAULT_ICON: Record<Department, string> = {
  service: 'Users',
  'küche': 'ChefHat',
};

/** Auswahl-Palette für den Positions-Editor. */
export const POSITION_COLORS: string[] = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6',
  '#a855f7', '#ec4899', '#f43f5e', '#64748b',
];

/** Kuratierte Lucide-Icons für den Positions-Editor. */
export const POSITION_ICONS: string[] = [
  'ChefHat', 'Utensils', 'UtensilsCrossed', 'Pizza', 'Soup', 'Beef',
  'Wine', 'Beer', 'Coffee', 'GlassWater', 'CakeSlice', 'Salad',
  'Users', 'User', 'UserCheck', 'ConciergeBell', 'Bell', 'Sparkles',
  'Flame', 'Refrigerator', 'Brush', 'Star',
];

const UMLAUTS: Record<string, string> = {
  'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'ae', 'Ö': 'oe', 'Ü': 'ue', 'ß': 'ss',
  'à': 'a', 'á': 'a', 'â': 'a', 'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
  'ì': 'i', 'í': 'i', 'î': 'i', 'ò': 'o', 'ó': 'o', 'ô': 'o',
  'ù': 'u', 'ú': 'u', 'û': 'u', 'ç': 'c', 'ñ': 'n',
};

/**
 * Erzeugt einen stabilen Schlüssel aus einem Anzeigenamen.
 * "Chef de Rang" → "chef_de_rang", "Pizzaiolo" → "pizzaiolo",
 * "Küche Warm" → "kueche_warm".
 */
export function slugifyKey(name: string): string {
  const replaced = (name ?? '')
    .split('')
    .map((ch) => UMLAUTS[ch] ?? ch)
    .join('');
  return replaced
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Standard-Positionen, abgeleitet aus den bisher fix hinterlegten Stationen
 * (station-config.ts). Reihenfolge = sortOrder je Abteilung.
 */
export function defaultPositions(): PositionDraft[] {
  const drafts: PositionDraft[] = [];
  for (const dept of DEPARTMENTS) {
    const names = STATIONS_BY_DEPT[dept] ?? [];
    names.forEach((name, idx) => {
      drafts.push({
        key: slugifyKey(name),
        name,
        department: dept,
        color: DEPT_DEFAULT_COLOR[dept],
        icon: DEPT_DEFAULT_ICON[dept],
        sortOrder: idx,
        active: true,
      });
    });
  }
  return drafts;
}

export function positionByKey(positions: Position[], key: string | null | undefined): Position | undefined {
  if (!key) return undefined;
  return positions.find((p) => p.key === key);
}

/**
 * Toleranter Lookup: akzeptiert einen Key ODER (für Alt-Daten) einen
 * Anzeigenamen und liefert den passenden Key zurück. Unbekannte Werte werden
 * unverändert zurückgegeben (getrimmt).
 */
export function resolvePositionKey(positions: Position[], value: string | null | undefined): string | undefined {
  const v = (value ?? '').trim();
  if (!v) return undefined;
  if (positions.some((p) => p.key === v)) return v;
  const byName = positions.find((p) => p.name.toLowerCase() === v.toLowerCase());
  if (byName) return byName.key;
  return v;
}

/** Anzeigename zu einem Key (mit Toleranz für Alt-Daten); Fallback = Key selbst. */
export function positionDisplayName(positions: Position[], key: string | null | undefined): string {
  const v = (key ?? '').trim();
  if (!v) return '';
  const byKey = positions.find((p) => p.key === v);
  if (byKey) return byKey.name;
  const byName = positions.find((p) => p.name.toLowerCase() === v.toLowerCase());
  if (byName) return byName.name;
  return v;
}

/** Alle Positions-Keys, die ein Mitarbeiter abdecken kann (Haupt + Zweit), dedupliziert. */
export function employeeCoverableKeys(
  emp: Pick<Employee, 'primaryStation' | 'secondaryStations'>,
): string[] {
  const keys: string[] = [];
  if (emp.primaryStation) keys.push(emp.primaryStation);
  for (const s of emp.secondaryStations ?? []) {
    if (s && !keys.includes(s)) keys.push(s);
  }
  return keys;
}

/** Kann der Mitarbeiter die Position abdecken (Haupt- oder Zweitposition)? */
export function employeeCanCover(
  emp: Pick<Employee, 'primaryStation' | 'secondaryStations'>,
  key: string,
): boolean {
  if (!key) return false;
  return employeeCoverableKeys(emp).includes(key);
}

/** Positionen einer Abteilung (optional nur aktive), sortiert. */
export function positionsForDepartment(
  positions: Position[],
  dept: Department,
  opts: { activeOnly?: boolean } = {},
): Position[] {
  return sortPositions(
    positions.filter((p) => p.department === dept && (!opts.activeOnly || p.active)),
  );
}

export function activePositions(positions: Position[]): Position[] {
  return positions.filter((p) => p.active);
}

/** Stabile Sortierung: Abteilung → sortOrder → Name. */
export function sortPositions(positions: Position[]): Position[] {
  const deptRank: Record<Department, number> = { service: 0, 'küche': 1 };
  return [...positions].sort((a, b) => {
    if (a.department !== b.department) return deptRank[a.department] - deptRank[b.department];
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name, 'de');
  });
}
