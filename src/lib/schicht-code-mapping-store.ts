/**
 * Schichtcode-Mapping Store
 * ==========================
 * Verwaltet die Zuordnung von Küchen-Schichtcodes (aus PDF-Dienstplänen)
 * zu Planstunden und Schichttypen im System.
 *
 * Gespeichert in localStorage unter 'schicht_code_mapping_v2'.
 *
 * Legende (Referenz aus dem Küchen-Dienstplan):
 *   A  = 7.0h   10:00–17:30 minus 30 Min Pause
 *   B  = 9.0h   11:30–21:30 minus 1h Pause
 *   C  = 3.5h   10:00–14:00 minus 30 Min Pause
 *   O2 = 4.25h  07:00–11:30 minus 15 Min Pause
 *   H  = 5.0h   18:00–23:30 minus 30 Min Pause
 *   D  = 8.5h   14:00–23:00 minus 30 Min Pause
 *   O1 = 8.5h   11:00–14:00 + 18:00–23:30 (Splitschicht)
 *   F  = 0      Frei
 *   FE = 0      Ferien
 *   FT = 0      Feiertag
 *   K  = 0      Krank
 *   M  = 0      Militär
 *   FW = 0      Feuerwehr
 *   MS = 0      Mutterschaft
 */

const STORAGE_KEY = 'schicht_code_mapping_v2';

export type SchichtType = 'work' | 'vacation' | 'absence' | 'off';

export interface SchichtCodeEntry {
  code: string;
  label: string;
  type: SchichtType;
  /** Autoritative Planstunden für diesen Code (editierbar). */
  hours: number;
  /** Start der 1. Schicht für TimeSlot-Eintrag (HH:mm). */
  start?: string;
  /** Ende der 1. Schicht für TimeSlot-Eintrag (HH:mm). */
  end?: string;
  /** Start der 2. Schicht bei Splitschichten (HH:mm). */
  start2?: string;
  /** Ende der 2. Schicht bei Splitschichten (HH:mm). */
  end2?: string;
}

/** Gibt die definierten Planstunden zurück (immer aus dem hours-Feld). */
export function computeHours(entry: SchichtCodeEntry): number {
  return entry.hours;
}

export const DEFAULT_MAPPING: SchichtCodeEntry[] = [
  // ── Arbeitsschichten ───────────────────────────────────────────────────────
  { code: 'A',  label: 'Schicht A',   type: 'work',     hours: 7.0,  start: '10:00', end: '17:30' },
  { code: 'B',  label: 'Schicht B',   type: 'work',     hours: 9.0,  start: '11:30', end: '21:30' },
  { code: 'C',  label: 'Schicht C',   type: 'work',     hours: 3.5,  start: '10:00', end: '14:00' },
  { code: 'O2', label: 'Offen 2',     type: 'work',     hours: 4.25, start: '07:00', end: '11:30' },
  { code: 'H',  label: 'Abend',       type: 'work',     hours: 5.0,  start: '18:00', end: '23:30' },
  { code: 'D',  label: 'Spät',        type: 'work',     hours: 8.5,  start: '14:00', end: '23:00' },
  // Splitschicht O1: früh-Slot 11:00–14:00, spät-Slot 18:00–23:30
  { code: 'O1', label: 'Offen 1 (Split)', type: 'work', hours: 8.5,  start: '11:00', end: '14:00', start2: '18:00', end2: '23:30' },
  // ── Abwesenheiten / Frei ───────────────────────────────────────────────────
  { code: 'F',  label: 'Frei',        type: 'off',      hours: 0 },
  { code: 'FE', label: 'Ferien',      type: 'vacation', hours: 0 },
  { code: 'FT', label: 'Feiertag',    type: 'vacation', hours: 0 },
  { code: 'K',  label: 'Krank',       type: 'absence',  hours: 0 },
  { code: 'M',  label: 'Militär',     type: 'absence',  hours: 0 },
  { code: 'FW', label: 'Feuerwehr',   type: 'absence',  hours: 0 },
  { code: 'MS', label: 'Mutterschaft',type: 'absence',  hours: 0 },
];

export function loadSchichtCodeMapping(): SchichtCodeEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as SchichtCodeEntry[];
  } catch {}
  return [...DEFAULT_MAPPING];
}

export function saveSchichtCodeMapping(mapping: SchichtCodeEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(mapping));
}

/** Gibt den Mapping-Eintrag für einen Code zurück (case-insensitive). */
export function getMappingForCode(
  code: string,
  mapping: SchichtCodeEntry[],
): SchichtCodeEntry | null {
  const upper = code.trim().toUpperCase();
  return (
    mapping.find(e => e.code.toUpperCase() === upper) ??
    DEFAULT_MAPPING.find(e => e.code.toUpperCase() === upper) ??
    null
  );
}
