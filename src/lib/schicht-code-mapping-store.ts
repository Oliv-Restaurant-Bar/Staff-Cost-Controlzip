/**
 * Schichtcode-Mapping Store
 * ==========================
 * Verwaltet die Zuordnung von Küchen-Schichtcodes (aus PDF-Dienstplänen)
 * zu Planstunden und Schichttypen im System.
 *
 * Gespeichert in localStorage unter 'schicht_code_mapping_v1'.
 */

const STORAGE_KEY = 'schicht_code_mapping_v1';

export type SchichtType = 'work' | 'vacation' | 'absence' | 'off';

export interface SchichtCodeEntry {
  code: string;
  label: string;
  type: SchichtType;
  start?: string;
  end?: string;
}

export function computeHours(entry: SchichtCodeEntry): number {
  if (entry.type !== 'work' || !entry.start || !entry.end) return 0;
  const [sh, sm] = entry.start.split(':').map(Number);
  const [eh, em] = entry.end.split(':').map(Number);
  const mins = (eh * 60 + em) - (sh * 60 + sm);
  return Math.max(0, mins / 60);
}

const DEFAULT_MAPPING: SchichtCodeEntry[] = [
  { code: 'A',   label: 'Schicht A',     type: 'work',     start: '07:00', end: '15:30' },
  { code: 'B',   label: 'Schicht B',     type: 'work',     start: '10:00', end: '18:30' },
  { code: 'C',   label: 'Schicht C',     type: 'work',     start: '12:00', end: '20:30' },
  { code: 'F',   label: 'Früh',          type: 'work',     start: '07:00', end: '15:30' },
  { code: 'S',   label: 'Spät',          type: 'work',     start: '11:00', end: '19:30' },
  { code: 'O',   label: 'Offen',         type: 'work',     start: '09:00', end: '17:30' },
  { code: 'O2',  label: 'Offen 2',       type: 'work',     start: '09:00', end: '17:30' },
  { code: 'F-',  label: 'Früh kurz',     type: 'work',     start: '07:00', end: '11:00' },
  { code: 'S-',  label: 'Spät kurz',     type: 'work',     start: '14:00', end: '18:00' },
  { code: 'FE',  label: 'Ferien',        type: 'vacation'                               },
  { code: 'K',   label: 'Krank',         type: 'absence'                                },
  { code: 'KK',  label: 'Kindkrank',     type: 'absence'                                },
  { code: 'U',   label: 'Urlaub',        type: 'vacation'                               },
  { code: 'X',   label: 'Frei',          type: 'off'                                    },
  { code: '-',   label: 'Frei',          type: 'off'                                    },
];

export function loadSchichtCodeMapping(): SchichtCodeEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as SchichtCodeEntry[];
  } catch {}
  return DEFAULT_MAPPING;
}

export function saveSchichtCodeMapping(mapping: SchichtCodeEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(mapping));
}

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

export { DEFAULT_MAPPING };
