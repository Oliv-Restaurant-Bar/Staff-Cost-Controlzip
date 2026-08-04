/**
 * staffing-requirements-utils — reine Logik für den Personalbedarf (SOLL-Besetzung).
 * ──────────────────────────────────────────────────────────────────────────────
 * KEINE Supabase-/DOM-Abhängigkeiten (nur `import type`), damit die Funktionen
 * isoliert testbar sind (node-Umgebung).
 *
 * Verantwortlich für:
 *   - Saison-/Wochentags-Stammwerte + Labels,
 *   - Zeit-Helfer ('HH:MM'),
 *   - Validierung einer Schicht,
 *   - Aufbau der hierarchischen Bedarfsmatrix (Abteilung → Bereich → Position →
 *     Schichten) durch WIEDERVERWENDUNG von `groupPositionsByArea`.
 *
 * Die Funktionen verändern KEINE Dienstplan-/Kosten-/Überstunden-Berechnung.
 */
import type { Department } from '@/types/personnel';
import type { Position } from '@/types/positions';
import type { PositionArea, PositionAreaGroup } from '@/lib/position-utils';
import { DEPARTMENTS, groupPositionsByArea } from '@/lib/position-utils';
import type {
  StaffingRequirement,
  StaffingScopeType,
  StaffingSeason,
} from '@/types/staffing';

// ─── Saison ───────────────────────────────────────────────────────────────────

export interface SeasonOption {
  key: StaffingSeason;
  label: string;
  /** false = im UI sichtbar, aber deaktiviert (noch nicht verfügbar). */
  available: boolean;
}

/**
 * Auswählbare Saisons. 'standard' | 'sommer' | 'winter' sind aktiv;
 * 'custom' (Individuelle Saison) ist vorgesehen, aber noch deaktiviert.
 */
export const SEASONS: SeasonOption[] = [
  { key: 'standard', label: 'Standard', available: true },
  { key: 'sommer', label: 'Sommer', available: true },
  { key: 'winter', label: 'Winter/UG', available: true },
  { key: 'custom', label: 'Individuelle Saison', available: false },
];

export const DEFAULT_SEASON: StaffingSeason = 'standard';

/** Aktuell genutzter Geltungsbereich-Typ. */
export const SCOPE_WEEKLY: StaffingScopeType = 'weekly';

export function seasonLabel(season: StaffingSeason): string {
  return SEASONS.find((s) => s.key === season)?.label ?? String(season);
}

/** true, wenn die Saison aktuell auswählbar ist. */
export function isSeasonAvailable(season: StaffingSeason): boolean {
  return SEASONS.find((s) => s.key === season)?.available ?? false;
}

// ─── Wochentag (ISO 1..7, Mo..So) ─────────────────────────────────────────────

export interface WeekdayOption {
  /** ISO-Wochentag 1..7 (1 = Montag … 7 = Sonntag). */
  value: number;
  label: string;
  short: string;
}

export const WEEKDAYS: WeekdayOption[] = [
  { value: 1, label: 'Montag', short: 'Mo' },
  { value: 2, label: 'Dienstag', short: 'Di' },
  { value: 3, label: 'Mittwoch', short: 'Mi' },
  { value: 4, label: 'Donnerstag', short: 'Do' },
  { value: 5, label: 'Freitag', short: 'Fr' },
  { value: 6, label: 'Samstag', short: 'Sa' },
  { value: 7, label: 'Sonntag', short: 'So' },
];

export function weekdayLabel(weekday: number | null | undefined): string {
  return WEEKDAYS.find((w) => w.value === weekday)?.label ?? '';
}

export function weekdayShort(weekday: number | null | undefined): string {
  return WEEKDAYS.find((w) => w.value === weekday)?.short ?? '';
}

// ─── Zeit-Helfer ('HH:MM') ────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** true, wenn `value` exakt 'HH:MM' im Bereich 00:00..23:59 ist. */
export function isValidTime(value: string | null | undefined): boolean {
  return typeof value === 'string' && TIME_RE.test(value);
}

/** 'HH:MM' → Minuten seit Mitternacht (NaN bei ungültig). */
export function timeToMinutes(value: string | null | undefined): number {
  if (!isValidTime(value)) return NaN;
  const [h, m] = (value as string).split(':').map(Number);
  return h * 60 + m;
}

/** Minuten → 'HH:MM' (clamp 0..1439). */
export function minutesToTime(minutes: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Dauer einer Schicht in Minuten. Liefert NaN, wenn Start/Ende ungültig oder
 * Ende nicht NACH Start liegt (Schichten über Mitternacht werden hier bewusst
 * nicht unterstützt — die Betriebszeiten liegen innerhalb eines Tages).
 */
export function shiftDuration(start: string, end: string): number {
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return NaN;
  const d = e - s;
  return d > 0 ? d : NaN;
}

// ─── Schicht-Entwurf + Validierung ────────────────────────────────────────────

/** Editierbarer Teil einer Schicht (UI-Zeile). */
export interface ShiftDraft {
  id?: string;
  shiftStart: string;
  shiftEnd: string;
  requiredCount: number;
}

export function defaultShiftDraft(): ShiftDraft {
  return { shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1 };
}

/**
 * Validiert eine Schicht-Zeile. Liefert eine Liste deutscher Fehlermeldungen
 * (leer = gültig).
 */
export function validateShiftDraft(d: ShiftDraft): string[] {
  const errors: string[] = [];
  if (!isValidTime(d.shiftStart)) errors.push('Schichtbeginn ist keine gültige Uhrzeit (HH:MM).');
  if (!isValidTime(d.shiftEnd)) errors.push('Schichtende ist keine gültige Uhrzeit (HH:MM).');
  if (isValidTime(d.shiftStart) && isValidTime(d.shiftEnd) && timeToMinutes(d.shiftEnd) <= timeToMinutes(d.shiftStart)) {
    errors.push('Schichtende muss nach dem Schichtbeginn liegen.');
  }
  if (!Number.isInteger(d.requiredCount) || d.requiredCount < 0) {
    errors.push('Anzahl benötigter Mitarbeitender muss 0 oder grösser sein.');
  }
  return errors;
}

export function isShiftDraftValid(d: ShiftDraft): boolean {
  return validateShiftDraft(d).length === 0;
}

// ─── Filtern / Sortieren ──────────────────────────────────────────────────────

/** Sortiert Schichten nach sortOrder, dann Startzeit, dann Endzeit. */
export function sortShifts(shifts: StaffingRequirement[]): StaffingRequirement[] {
  return [...shifts].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const sa = timeToMinutes(a.shiftStart);
    const sb = timeToMinutes(b.shiftStart);
    if (sa !== sb) return (Number.isNaN(sa) ? Infinity : sa) - (Number.isNaN(sb) ? Infinity : sb);
    const ea = timeToMinutes(a.shiftEnd);
    const eb = timeToMinutes(b.shiftEnd);
    return (Number.isNaN(ea) ? Infinity : ea) - (Number.isNaN(eb) ? Infinity : eb);
  });
}

/**
 * Schichten eines weekly-Geltungsbereichs (Saison × Wochentag), optional auf
 * eine Position eingegrenzt. Sortiert.
 */
export function shiftsForScope(
  requirements: StaffingRequirement[],
  season: StaffingSeason,
  weekday: number,
  positionKey?: string,
): StaffingRequirement[] {
  const filtered = requirements.filter(
    (r) =>
      r.scopeType === SCOPE_WEEKLY &&
      r.season === season &&
      r.weekday === weekday &&
      (positionKey === undefined || r.positionKey === positionKey),
  );
  return sortShifts(filtered);
}

/** Summe der benötigten Mitarbeitenden über eine Schicht-Liste. */
export function totalRequired(shifts: StaffingRequirement[]): number {
  return shifts.reduce((sum, s) => sum + (Number.isFinite(s.requiredCount) ? s.requiredCount : 0), 0);
}

// ─── Hierarchische Bedarfsmatrix (Abteilung → Bereich → Position → Schichten) ──

export interface PositionRequirement {
  position: Position;
  shifts: StaffingRequirement[];
}

export interface AreaRequirementGroup {
  area: PositionArea | null;
  positions: PositionRequirement[];
}

export interface DepartmentRequirementGroup {
  department: Department;
  areas: AreaRequirementGroup[];
}

/**
 * Baut die hierarchische Bedarfsmatrix für einen weekly-Geltungsbereich.
 *
 *   - Nutzt NUR aktive Positionen (groupPositionsByArea includeInactive:false).
 *   - Reihenfolge: kanonisch (DEPARTMENTS → AREAS_BY_DEPARTMENT → sortOrder/Name)
 *     wie bei den Positionen.
 *   - Leere Bereiche und leere Abteilungen (ohne Positionen) werden
 *     ausgeblendet — es gibt dort nichts zu besetzen.
 *   - Jeder Position werden ihre Schichten dieses (Saison × Wochentag) zugeordnet.
 */
export function buildRequirementMatrix(
  positions: Position[],
  requirements: StaffingRequirement[],
  season: StaffingSeason,
  weekday: number,
): DepartmentRequirementGroup[] {
  const result: DepartmentRequirementGroup[] = [];

  for (const dept of DEPARTMENTS) {
    const areaGroups: PositionAreaGroup[] = groupPositionsByArea(positions, dept, { includeInactive: false });
    const areas: AreaRequirementGroup[] = [];

    for (const group of areaGroups) {
      if (group.positions.length === 0) continue; // leeren Bereich überspringen
      areas.push({
        area: group.area,
        positions: group.positions.map((position) => ({
          position,
          shifts: shiftsForScope(requirements, season, weekday, position.key),
        })),
      });
    }

    if (areas.length > 0) result.push({ department: dept, areas });
  }

  return result;
}
