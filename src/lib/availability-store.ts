/**
 * availability-store.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Speichert datumsspezifische Verfügbarkeitseinschränkungen pro Mitarbeiter.
 * Unterschied zu daysOff (Wochentag-Muster):
 *   - requestedFreeDays = einzelne Daten, die der MA als Wunschfrei beantragt
 *   - blockedDates      = einzelne Daten, an denen der MA vollständig gesperrt ist
 *
 * Speicherort: localStorage (device-lokal, kein DB-Schema nötig)
 */

const STORE_KEY = 'employee_availability_v1';

// ─── Typen ────────────────────────────────────────────────────────────────────

export interface EmployeeAvailability {
  requestedFreeDays: string[];  // ISO-Daten: YYYY-MM-DD
  blockedDates:      string[];  // ISO-Daten: YYYY-MM-DD
  notes:             Record<string, string>; // dateStr → optionale Notiz
}

type AvailabilityStore = Record<string, EmployeeAvailability>; // empId → data

// ─── Interne Hilfsfunktionen ──────────────────────────────────────────────────

function loadStore(): AvailabilityStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStore(store: AvailabilityStore): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

function defaultEntry(): EmployeeAvailability {
  return { requestedFreeDays: [], blockedDates: [], notes: {} };
}

// ─── Öffentliche API ──────────────────────────────────────────────────────────

/** Lädt alle Verfügbarkeitsdaten eines Mitarbeiters */
export function getAvailability(empId: string): EmployeeAvailability {
  return { ...defaultEntry(), ...loadStore()[empId] };
}

/** Speichert alle Verfügbarkeitsdaten eines Mitarbeiters */
export function saveAvailability(empId: string, data: EmployeeAvailability): void {
  const store = loadStore();
  store[empId] = data;
  saveStore(store);
}

/** Gibt true zurück, wenn das Datum als Wunschfrei markiert ist */
export function isRequestedFreeDay(empId: string, dateStr: string): boolean {
  return getAvailability(empId).requestedFreeDays.includes(dateStr);
}

/** Gibt true zurück, wenn das Datum gesperrt ist */
export function isBlockedDate(empId: string, dateStr: string): boolean {
  return getAvailability(empId).blockedDates.includes(dateStr);
}

/** Gibt den Status eines Datums zurück */
export type DateAvailStatus = 'blocked' | 'requested-free' | 'normal';

export function getDateStatus(empId: string, dateStr: string): DateAvailStatus {
  const a = getAvailability(empId);
  if (a.blockedDates.includes(dateStr))      return 'blocked';
  if (a.requestedFreeDays.includes(dateStr)) return 'requested-free';
  return 'normal';
}

/**
 * Lädt den Verfügbarkeitsstatus für mehrere Mitarbeiter und Tage auf einmal.
 * Rückgabe: { [`${empId}-${dateStr}`]: DateAvailStatus }
 * Effizient: lädt den Store nur einmal.
 */
export function buildAvailabilityMap(
  empIds: string[],
  dateStrs: string[],
): Record<string, DateAvailStatus> {
  const store = loadStore();
  const result: Record<string, DateAvailStatus> = {};
  for (const empId of empIds) {
    const a = store[empId] ?? defaultEntry();
    for (const dateStr of dateStrs) {
      const key = `${empId}-${dateStr}`;
      if (a.blockedDates.includes(dateStr))      result[key] = 'blocked';
      else if (a.requestedFreeDays.includes(dateStr)) result[key] = 'requested-free';
      else result[key] = 'normal';
    }
  }
  return result;
}

/** Gibt alle Daten zurück, an denen ein MA in einem Monat Einschränkungen hat */
export function getConstrainedDatesInMonth(
  empId: string,
  year: number,
  month: number, // 1-12
): { date: string; status: DateAvailStatus }[] {
  const a = getAvailability(empId);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const result: { date: string; status: DateAvailStatus }[] = [];
  for (const d of a.blockedDates) {
    if (d.startsWith(prefix)) result.push({ date: d, status: 'blocked' });
  }
  for (const d of a.requestedFreeDays) {
    if (d.startsWith(prefix) && !result.some(r => r.date === d)) {
      result.push({ date: d, status: 'requested-free' });
    }
  }
  return result;
}

/** Toggelt den Status eines Datums: normal → Wunschfrei → Gesperrt → normal */
export function cycleAvailabilityStatus(
  empId: string,
  dateStr: string,
): DateAvailStatus {
  const a = getAvailability(empId);
  const current = getDateStatus(empId, dateStr);
  let next: DateAvailStatus;

  if (current === 'normal') {
    // normal → requested-free
    a.requestedFreeDays = [...a.requestedFreeDays.filter(d => d !== dateStr), dateStr];
    a.blockedDates = a.blockedDates.filter(d => d !== dateStr);
    next = 'requested-free';
  } else if (current === 'requested-free') {
    // requested-free → blocked
    a.requestedFreeDays = a.requestedFreeDays.filter(d => d !== dateStr);
    a.blockedDates = [...a.blockedDates.filter(d => d !== dateStr), dateStr];
    next = 'blocked';
  } else {
    // blocked → normal
    a.blockedDates = a.blockedDates.filter(d => d !== dateStr);
    a.requestedFreeDays = a.requestedFreeDays.filter(d => d !== dateStr);
    next = 'normal';
  }

  saveAvailability(empId, a);
  return next;
}

/** Setzt einen Status direkt (ohne cycling) */
export function setAvailabilityStatus(
  empId: string,
  dateStr: string,
  status: DateAvailStatus,
): void {
  const a = getAvailability(empId);
  a.requestedFreeDays = a.requestedFreeDays.filter(d => d !== dateStr);
  a.blockedDates = a.blockedDates.filter(d => d !== dateStr);
  if (status === 'requested-free') a.requestedFreeDays.push(dateStr);
  else if (status === 'blocked')   a.blockedDates.push(dateStr);
  saveAvailability(empId, a);
}

/** Löscht alle Einschränkungen eines Mitarbeiters für einen Monat */
export function clearMonthAvailability(
  empId: string,
  year: number,
  month: number,
): void {
  const a = getAvailability(empId);
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  a.requestedFreeDays = a.requestedFreeDays.filter(d => !d.startsWith(prefix));
  a.blockedDates = a.blockedDates.filter(d => !d.startsWith(prefix));
  saveAvailability(empId, a);
}
