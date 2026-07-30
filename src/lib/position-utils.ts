/**
 * position-utils — reine Logik der Positionsverwaltung (Personalbedarf-Grundlage).
 * ──────────────────────────────────────────────────────────────────────────────
 * KEINE Supabase-/DOM-Abhängigkeiten (nur `import type` aus den Modellen).
 * Damit im Node-Env testbar.
 *
 * Zentrale Regel: Mitarbeitende speichern einen stabilen Positions-KEY, nicht
 * den Anzeigenamen. `resolvePositionKey` toleriert Alt-Daten (Anzeigename) und
 * mappt sie auf den passenden Key.
 */

import type { Department, Employee } from '@/types/personnel';
import type { Position, PositionDraft } from '@/types/positions';

export const DEPARTMENTS: Department[] = ['service', 'küche'];

/** Bereich (feinere Gruppierung) innerhalb einer Abteilung. */
export interface PositionArea {
  /** Stabiler Schlüssel — wird in `position.departmentGroup` gespeichert. */
  key: string;
  /** Anzeigename des Bereichs. */
  name: string;
}

/**
 * Bereiche je Abteilung — feste Gruppierung als Vorbereitung auf den späteren
 * Personalbedarf. Mehrere Positionen je Bereich sind möglich
 * (`Position.departmentGroup` === `PositionArea.key`); die Array-Reihenfolge ist
 * die Anzeigereihenfolge.
 */
export const AREAS_BY_DEPARTMENT: Record<Department, PositionArea[]> = {
  service: [
    { key: 'restaurant', name: 'Restaurant' },
    { key: 'bar_buffet', name: 'Bar/Buffet' },
  ],
  'küche': [
    { key: 'kueche_produktion', name: 'Küche Produktion' },
    { key: 'take_away', name: 'Take Away' },
    { key: 'abwasch', name: 'Abwasch' },
  ],
};

/** Bereiche einer Abteilung (in Anzeigereihenfolge). */
export function areasForDepartment(dept: Department): PositionArea[] {
  return AREAS_BY_DEPARTMENT[dept] ?? [];
}

/** Anzeigename eines Bereichs (Fallback = Key selbst; '' wenn leer). */
export function areaLabel(dept: Department, areaKey: string | null | undefined): string {
  const k = (areaKey ?? '').trim();
  if (!k) return '';
  const found = areasForDepartment(dept).find((a) => a.key === k);
  return found ? found.name : k;
}

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
 * Standard-Positionen = die echten Planungsbereiche aus dem Personalbedarf.
 * Stabile KEYS (Slugs), nicht Anzeigenamen. Reihenfolge je Abteilung über
 * sortOrder; sortPositions zeigt Service vor Küche. Beim Anwenden werden
 * gleichnamige (per key) aktualisiert und alle übrigen Positionen deaktiviert
 * (siehe applyDefaultPositions in positions-db.ts).
 */
export function defaultPositions(): PositionDraft[] {
  return [
    { key: 'bar_buffet_springer', name: 'BAR Buffet/Springer', department: 'service', departmentGroup: 'bar_buffet',        color: '#3b82f6', icon: 'Users',         sortOrder: 0, active: true },
    { key: 'service',             name: 'Service',             department: 'service', departmentGroup: 'restaurant',        color: '#22c55e', icon: 'ConciergeBell', sortOrder: 1, active: true },
    { key: 'springer',            name: 'Springer',            department: 'service', departmentGroup: 'restaurant',        color: '#8b5cf6', icon: 'Sparkles',      sortOrder: 2, active: true },
    { key: 'kalt_sushi',          name: 'Kalt/Sushi',          department: 'küche',   departmentGroup: 'kueche_produktion', color: '#14b8a6', icon: 'Salad',         sortOrder: 3, active: true },
    { key: 'reinigung',           name: 'Reinigung',           department: 'küche',   departmentGroup: 'abwasch',           color: '#0ea5e9', icon: 'Sparkles',      sortOrder: 4, active: true },
    { key: 'piazzolo_take_away',  name: 'Piazzolo Take Away',  department: 'küche',   departmentGroup: 'take_away',         color: '#f97316', icon: 'Pizza',         sortOrder: 0, active: true },
    { key: 'abwasch',             name: 'Abwasch',             department: 'küche',   departmentGroup: 'abwasch',           color: '#64748b', icon: 'Utensils',      sortOrder: 1, active: true },
    { key: 'kueche',              name: 'Küche',               department: 'küche',   departmentGroup: 'kueche_produktion', color: '#ef4444', icon: 'ChefHat',       sortOrder: 2, active: true },
  ];
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

/** Default-Bereich je Standard-Positions-Key (Fallback für Alt-Daten ohne departmentGroup). */
const DEFAULT_AREA_BY_KEY: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const d of defaultPositions()) {
    if (d.departmentGroup) map[d.key] = d.departmentGroup;
  }
  return map;
})();

/**
 * Ermittelt den Bereichs-Key einer Position innerhalb ihrer Abteilung:
 *   1) gesetzter, gültiger `departmentGroup`-Key,
 *   2) Fallback: Default-Bereich der gleichnamigen Standard-Position
 *      (damit bereits angewendete Positionen ohne `departmentGroup` korrekt
 *      einsortiert werden),
 *   3) sonst `''` (= "Ohne Bereich" / Sammelgruppe).
 */
export function resolvePositionArea(
  p: Pick<Position, 'key' | 'department' | 'departmentGroup'>,
): string {
  const known = areasForDepartment(p.department).map((a) => a.key);
  const direct = (p.departmentGroup ?? '').trim();
  if (direct && known.includes(direct)) return direct;
  const fallback = DEFAULT_AREA_BY_KEY[p.key];
  if (fallback && known.includes(fallback)) return fallback;
  return '';
}

/** Sortierung innerhalb eines Bereichs: aktive zuerst, dann sortOrder, dann Name. */
function sortWithinArea(positions: Position[]): Position[] {
  return [...positions].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name, 'de');
  });
}

export interface PositionAreaGroup {
  /** null = Sammelgruppe "Ohne Bereich" (Positionen ohne gültigen Bereich). */
  area: PositionArea | null;
  positions: Position[];
}

/**
 * Positionen einer Abteilung hierarchisch nach Bereich gruppieren.
 *
 * Alle definierten Bereiche werden (in Reihenfolge) zurückgegeben — auch leere,
 * damit die Struktur sichtbar und erweiterbar bleibt. Positionen ohne gültigen
 * Bereich landen in einer abschließenden Sammelgruppe (`area: null`), die nur
 * erscheint, wenn sie Einträge enthält. Innerhalb eines Bereichs stehen aktive
 * Positionen vor inaktiven.
 *
 * `includeInactive=false` (Standard) blendet inaktive Positionen vollständig aus.
 */
export function groupPositionsByArea(
  positions: Position[],
  dept: Department,
  opts: { includeInactive?: boolean } = {},
): PositionAreaGroup[] {
  const inDept = positions.filter(
    (p) => p.department === dept && (opts.includeInactive || p.active),
  );
  const groups: PositionAreaGroup[] = [];
  const used = new Set<string>();
  for (const area of areasForDepartment(dept)) {
    const ps = sortWithinArea(inDept.filter((p) => resolvePositionArea(p) === area.key));
    ps.forEach((p) => used.add(p.id));
    groups.push({ area, positions: ps });
  }
  const rest = sortWithinArea(inDept.filter((p) => !used.has(p.id)));
  if (rest.length > 0) groups.push({ area: null, positions: rest });
  return groups;
}

// ─── Mitarbeiter-Qualifikationen (Haupt-/Zweitpositionen) ─────────────────────
//
// Reine Logik für die Personalstamm-Sektion „Positionen / Qualifikationen".
// Gespeichert werden stabile KEYS (Slugs) in `primaryStation` (Hauptposition)
// und `secondaryStations` (zusätzlich abdeckbare Positionen). Diese Helfer
// erzwingen die Invarianten und sind im Node-Env testbar (kein Supabase/DOM).

/** Eine Abteilung mit ihren (nicht-leeren) Bereichsgruppen aktiver Positionen. */
export interface DepartmentQualificationGroup {
  department: Department;
  areas: PositionAreaGroup[];
}

/**
 * Alle AKTIVEN Positionen, hierarchisch nach Abteilung → Bereich, für die
 * Auswahl-UIs (Hauptposition-Dropdown + „Kann zusätzlich abdecken"-Checkboxen).
 * Leere Bereiche und Abteilungen ohne aktive Positionen werden ausgeblendet.
 */
export function activeQualificationGroups(positions: Position[]): DepartmentQualificationGroup[] {
  const result: DepartmentQualificationGroup[] = [];
  for (const dept of DEPARTMENTS) {
    const areas = groupPositionsByArea(positions, dept, { includeInactive: false }).filter(
      (g) => g.positions.length > 0,
    );
    if (areas.length > 0) result.push({ department: dept, areas });
  }
  return result;
}

/** Ist der Key eine AKTIVE Position? (leer/unbekannt/inaktiv → false) */
export function isActivePositionKey(
  positions: Position[],
  key: string | null | undefined,
): boolean {
  const v = (key ?? '').trim();
  if (!v) return false;
  return positions.some((p) => p.key === v && p.active);
}

/**
 * Setzt die Hauptposition: liefert die bereinigten Zweitpositionen zurück
 * (Hauptposition wird entfernt, dedupliziert, Leereinträge raus). Verändert die
 * Eingabe nicht.
 */
export function setPrimaryStation(
  secondary: string[] | null | undefined,
  newPrimary: string | null | undefined,
): string[] {
  const p = (newPrimary ?? '').trim();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of secondary ?? []) {
    const k = (s ?? '').trim();
    if (!k || k === p || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * Toggelt eine Zweitposition. Die Hauptposition kann nie als Zweitposition
 * gesetzt werden; Duplikate werden vermieden. Verändert die Eingabe nicht.
 */
export function toggleSecondaryStation(
  secondary: string[] | null | undefined,
  key: string,
  primary: string | null | undefined,
): string[] {
  const k = (key ?? '').trim();
  const p = (primary ?? '').trim();
  const cur = (secondary ?? []).filter((s) => !!(s ?? '').trim());
  if (!k || k === p) return [...cur];
  if (cur.includes(k)) return cur.filter((s) => s !== k);
  return [...cur, k];
}

/**
 * Normalisiert Haupt-/Zweitpositionen für das Speichern:
 *   - Hauptposition niemals zusätzlich in den Zweitpositionen,
 *   - Zweitpositionen dedupliziert, Leereinträge entfernt,
 *   - leere Listen → undefined (nicht `[]`), leere Hauptposition → undefined.
 * Inaktive/alte Keys bleiben ERHALTEN (kein stilles Löschen von Bestandsdaten).
 */
export function normalizeStationsForSave(
  primary: string | null | undefined,
  secondary: string[] | null | undefined,
): { primaryStation?: string; secondaryStations?: string[] } {
  const p = (primary ?? '').trim() || undefined;
  const seen = new Set<string>();
  const sec: string[] = [];
  for (const s of secondary ?? []) {
    const k = (s ?? '').trim();
    if (!k || k === p || seen.has(k)) continue;
    seen.add(k);
    sec.push(k);
  }
  return { primaryStation: p, secondaryStations: sec.length ? sec : undefined };
}

/**
 * Gespeicherte Positions-Keys (Haupt + Zweit), die NICHT (mehr) aktiv sind
 * (inaktiv oder unbekannt) — nur als Hinweis anzeigen, nicht neu auswählbar.
 */
export function inactiveStoredStationKeys(
  emp: Pick<Employee, 'primaryStation' | 'secondaryStations'>,
  positions: Position[],
): string[] {
  return employeeCoverableKeys(emp).filter((k) => !isActivePositionKey(positions, k));
}
