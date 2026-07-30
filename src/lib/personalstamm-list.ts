/**
 * personalstamm-list — Reine Logik der Personalstamm-Liste (View-Model).
 * ─────────────────────────────────────────────────────────────────────────────
 * KEINE Supabase-/DOM-Abhängigkeiten (nur `import type`) → im Node-Env testbar.
 *
 * EINE zentrale Ableitung für Zeilen (Liste) UND Kacheln:
 *  - Status: dünner Wrapper um die bestehende SSoT `isEmployeeActiveForDate`
 *    (personnel-utils) — hier wird NICHT neu über Datumsgrenzen entschieden.
 *    Quelle sind ausschliesslich Supabase-Felder (isActive, employmentEndDate,
 *    contractStart) — der Legacy-localStorage-Puffer `local.active` fliesst
 *    bewusst NICHT ein (Supabase = SSoT laut Architekturregeln).
 *  - Eintritt: TT.MM.JJJJ; fehlend/ungültig = «—», NIE das heutige Datum.
 *  - Pensum: weeklyHours / 42 (gleiche Formel wie das Bearbeiten-Formular);
 *    fehlend/0 = «—», nie stillschweigend 100 %.
 */

import type { Department, Employee, EmploymentType } from '@/types/personnel';
import type { Position } from '@/types/positions';
import { isEmployeeActiveForDate } from './personnel-utils';
import { positionDisplayName } from './position-utils';

// ── Labels (zentral für Seite + Komponenten) ────────────────────────────────

export const DEPT_LABELS: Record<Department, string> = {
  service: 'Service',
  'küche': 'Küche',
};

export const TYPE_LABELS: Record<EmploymentType, string> = {
  vollzeit: 'Vollzeit',
  teilzeit: 'Teilzeit',
  minijob: 'Minijob',
  aushilfe: 'Aushilfe',
};

// ── Status ──────────────────────────────────────────────────────────────────

export type EmployeeListStatus = 'aktiv' | 'eintritt_geplant' | 'ausgetreten' | 'inaktiv';

export const STATUS_LABELS: Record<EmployeeListStatus, string> = {
  aktiv: 'Aktiv',
  eintritt_geplant: 'Eintritt geplant',
  ausgetreten: 'Ausgetreten',
  inaktiv: 'Inaktiv',
};

/**
 * Listenstatus eines Mitarbeiters — Reihenfolge der Regeln:
 *  1. isActive === false          → «Inaktiv» (explizit archiviert)
 *  2. nicht aktiv per Austritt    → «Ausgetreten» (SSoT isEmployeeActiveForDate)
 *  3. Eintritt liegt in Zukunft   → «Eintritt geplant»
 *  4. sonst                       → «Aktiv»
 */
export function employeeListStatus(
  emp: Pick<Employee, 'isActive' | 'employmentEndDate' | 'contractStart'>,
  today: Date,
): EmployeeListStatus {
  if (emp.isActive === false) return 'inaktiv';
  if (!isEmployeeActiveForDate(emp, today)) return 'ausgetreten';
  if (emp.contractStart) {
    const start = parseIsoDay(emp.contractStart);
    if (start) {
      const ref = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      if (start.getTime() > ref.getTime()) return 'eintritt_geplant';
    }
  }
  return 'aktiv';
}

/** ISO-Datum (JJJJ-MM-TT…) als lokalen Tagesbeginn parsen; ungültig ⇒ null. */
function parseIsoDay(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

// ── Formatierung ────────────────────────────────────────────────────────────

/** Eintrittsdatum TT.MM.JJJJ; fehlend/ungültig = «—» (nie heutiges Datum). */
export function formatEintritt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return '—';
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** Pensum in % aus Wochenstunden (42 h = 100 %); fehlend/0 ⇒ undefined. */
export function pensumPercent(weeklyHours: number | null | undefined): number | undefined {
  if (typeof weeklyHours !== 'number' || !isFinite(weeklyHours) || weeklyHours <= 0) return undefined;
  return Math.round((weeklyHours / 42) * 100);
}

/** Anzeige «80 %» bzw. «—» wenn kein Pensum hinterlegt. */
export function pensumLabel(weeklyHours: number | null | undefined): string {
  const p = pensumPercent(weeklyHours);
  return p === undefined ? '—' : `${p} %`;
}

// ── Zeilen-View-Model ───────────────────────────────────────────────────────

export interface EmployeeListRow {
  id: string;
  name: string;
  department: Department;
  deptLabel: string;
  /** Anzeigename der Hauptposition ('' wenn keine hinterlegt). */
  positionLabel: string;
  employmentType: EmploymentType;
  typeLabel: string;
  /** ISO-Eintrittsdatum (fürs Sortieren/Jahr-Filter); undefined wenn fehlt. */
  eintrittIso?: string;
  eintrittLabel: string;
  pensumLabel: string;
  status: EmployeeListStatus;
  statusLabel: string;
  /** Lokal hinterlegter Vertrag vorhanden (reines Anzeige-Icon). */
  hasContractFile: boolean;
  /** MIRUS-Import-Kennzeichnung: 'MIRUS' = gestempelt, 'MANUELL' = Aushilfe/Default. */
  erfassungsart: 'MIRUS' | 'MANUELL';
}

/** View-Model einer Listenzeile/Kachel — Liste und Kacheln nutzen DIESELBEN Rows. */
export function buildEmployeeRow(
  emp: Employee,
  positions: Position[],
  today: Date,
  hasContractFile = false,
): EmployeeListRow {
  const status = employeeListStatus(emp, today);
  const posFromKey = positionDisplayName(positions, emp.primaryStation);
  const positionLabel = posFromKey || (emp.positionTitle ?? '').trim();
  return {
    id: emp.id,
    name: emp.name,
    department: emp.department,
    deptLabel: DEPT_LABELS[emp.department] ?? emp.department,
    positionLabel,
    employmentType: emp.employmentType,
    typeLabel: TYPE_LABELS[emp.employmentType] ?? emp.employmentType,
    eintrittIso: emp.contractStart || undefined,
    eintrittLabel: formatEintritt(emp.contractStart),
    pensumLabel: pensumLabel(emp.weeklyHours),
    status,
    statusLabel: STATUS_LABELS[status],
    hasContractFile,
    erfassungsart: emp.erfassungsart ?? 'MANUELL',
  };
}

// ── Sortierung (zentral, EINE Stelle) ───────────────────────────────────────

export type EmployeeSortKey = 'name' | 'eintritt_neu' | 'eintritt_alt' | 'abteilung' | 'status';

export const EMPLOYEE_SORT_OPTIONS: { key: EmployeeSortKey; label: string }[] = [
  { key: 'name', label: 'Name A–Z' },
  { key: 'eintritt_neu', label: 'Eintritt (neueste zuerst)' },
  { key: 'eintritt_alt', label: 'Eintritt (älteste zuerst)' },
  { key: 'abteilung', label: 'Abteilung' },
  { key: 'status', label: 'Status' },
];

export function isEmployeeSortKey(v: unknown): v is EmployeeSortKey {
  return typeof v === 'string' && EMPLOYEE_SORT_OPTIONS.some((o) => o.key === v);
}

const STATUS_SORT_ORDER: Record<EmployeeListStatus, number> = {
  aktiv: 0,
  eintritt_geplant: 1,
  ausgetreten: 2,
  inaktiv: 3,
};

function byName(a: EmployeeListRow, b: EmployeeListRow): number {
  return a.name.localeCompare(b.name, 'de-CH');
}

/** Eintritt vergleichen; fehlende Eintritte IMMER ans Ende (beide Richtungen). */
function byEintritt(a: EmployeeListRow, b: EmployeeListRow, dir: 1 | -1): number {
  if (!a.eintrittIso && !b.eintrittIso) return byName(a, b);
  if (!a.eintrittIso) return 1;
  if (!b.eintrittIso) return -1;
  const cmp = a.eintrittIso.localeCompare(b.eintrittIso);
  return cmp !== 0 ? cmp * dir : byName(a, b);
}

/** Zeilen sortieren (Kopie, Original bleibt unverändert). */
export function sortEmployeeRows(rows: readonly EmployeeListRow[], key: EmployeeSortKey): EmployeeListRow[] {
  const copy = [...rows];
  switch (key) {
    case 'eintritt_neu':
      return copy.sort((a, b) => byEintritt(a, b, -1));
    case 'eintritt_alt':
      return copy.sort((a, b) => byEintritt(a, b, 1));
    case 'abteilung':
      return copy.sort((a, b) => a.deptLabel.localeCompare(b.deptLabel, 'de-CH') || byName(a, b));
    case 'status':
      return copy.sort((a, b) => (STATUS_SORT_ORDER[a.status] - STATUS_SORT_ORDER[b.status]) || byName(a, b));
    case 'name':
    default:
      return copy.sort(byName);
  }
}

// ── Zusatzfilter Position / Eintrittsjahr ───────────────────────────────────

/** Verfügbare Positions-Labels (alphabetisch, nur nicht-leere). */
export function buildPositionOptions(rows: readonly EmployeeListRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) if (r.positionLabel) set.add(r.positionLabel);
  return [...set].sort((a, b) => a.localeCompare(b, 'de-CH'));
}

/** Verfügbare Eintrittsjahre (absteigend, nur aus vorhandenen Daten). */
export function buildEintrittsjahrOptions(rows: readonly EmployeeListRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const y = r.eintrittIso?.slice(0, 4);
    if (y && /^\d{4}$/.test(y)) set.add(y);
  }
  return [...set].sort((a, b) => b.localeCompare(a));
}

/** Zusatzfilter anwenden ('all' = kein Filter). Fehlender Eintritt matcht kein Jahr. */
export function filterEmployeeRows(
  rows: readonly EmployeeListRow[],
  opts: { position?: string; eintrittsjahr?: string },
): EmployeeListRow[] {
  return rows.filter((r) => {
    if (opts.position && opts.position !== 'all' && r.positionLabel !== opts.position) return false;
    if (opts.eintrittsjahr && opts.eintrittsjahr !== 'all') {
      if (!r.eintrittIso || r.eintrittIso.slice(0, 4) !== opts.eintrittsjahr) return false;
    }
    return true;
  });
}
