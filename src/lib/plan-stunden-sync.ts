/**
 * SSoT-Synchronisation der Plan-Stunden für die Personalkosten-Seite.
 *
 * Kanonische Quelle für den Dienstplan ist Supabase (`schedule_entries`).
 * localStorage `schedule-v2-YYYY-MM` ist ein REINER Cache: beim Spiegeln wird
 * er VOLLSTÄNDIG durch die Supabase-Einträge des Monats ersetzt (kein Merge,
 * keine Reste). Dadurch entspricht «Plan Std» in Personalkosten exakt den
 * Netto-Stunden, die der Dienstplan (SchedulePlanner) zeigt — gleiche Quelle,
 * gleiche Berechnung (calculateDayNetHours).
 */

import { calculateDayNetHours, slotGrossHours } from '@/hooks/useShiftConfig';

/** Zellschlüssel-Format: `${empId}-YYYY-MM-DD` → empId = alles außer den letzten 11 Zeichen. */
function splitCellKey(cellKey: string): { empId: string; date: string } {
  return {
    empId: cellKey.slice(0, cellKey.length - 11),
    date: cellKey.slice(-10),
  };
}

/**
 * Aggregiert Plan-Netto-Stunden pro Mitarbeiter aus einem schedule-v2-Blob.
 *
 * Regeln (identisch zur Dienstplan-Anzeige):
 *  - NUR Einträge, deren Datum im angegebenen Monat liegt (Fremdmonats-Reste
 *    im Blob werden ignoriert — Defense-in-depth gegen veraltete Caches).
 *  - FE-markierte Tage zählen nicht als Arbeit (Ferien).
 *  - Netto via calculateDayNetHours (Pausen pro Einsatz abgezogen).
 */
export function aggregatePlanHours(
  data: Record<string, unknown>,
  year: number,
  month: number,
): Record<string, number> {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const out: Record<string, number> = {};
  for (const [cellKey, ds] of Object.entries(data)) {
    const { empId, date } = splitCellKey(cellKey);
    if (!empId) continue;
    if (!date.startsWith(prefix)) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = ds as any;
    if (entry?.frühAbsence === 'FE' || entry?.spätAbsence === 'FE') continue;
    const net = calculateDayNetHours(entry);
    if (net > 0) out[empId] = (out[empId] ?? 0) + Math.round(net * 100) / 100;
  }
  return out;
}

/** Diagnose-Detail je Mitarbeiter (für Debug-Log + Invariante). */
export interface PlanHoursDebugRow {
  empId: string;
  /** Gezählte Arbeits-Einträge (netto > 0) im Monat. */
  entries: number;
  /** Brutto-Summe (Zeitspannen ohne Pausenabzug) der gezählten Einträge. */
  grossHours: number;
  /** Netto-Summe (= Wert der «Plan Std»-Spalte). */
  netHours: number;
  /** Monats-Präfixe ALLER Blob-Einträge dieses Mitarbeiters (auch übersprungene). */
  monthPrefixes: string[];
  /** Übersprungene Fremdmonats-Einträge (würden ohne Filter mitzählen). */
  skippedForeignMonth: number;
}

/**
 * Diagnose zur «Plan Std»-Aggregation: pro Mitarbeiter gezählte Einträge,
 * Brutto/Netto und alle im Blob gesehenen Monats-Präfixe. INVARIANTE:
 * netHours ≤ grossHours (Netto kann nie über der Summe der Zeitspannen
 * des Monats liegen). Verletzungen deuten auf Fremdmonats-Reste oder
 * Doppelzählung hin und werden vom Aufrufer geloggt.
 */
export function debugPlanHours(
  data: Record<string, unknown>,
  year: number,
  month: number,
): PlanHoursDebugRow[] {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const byEmp = new Map<string, PlanHoursDebugRow>();
  for (const [cellKey, ds] of Object.entries(data)) {
    const { empId, date } = splitCellKey(cellKey);
    if (!empId) continue;
    let row = byEmp.get(empId);
    if (!row) {
      row = { empId, entries: 0, grossHours: 0, netHours: 0, monthPrefixes: [], skippedForeignMonth: 0 };
      byEmp.set(empId, row);
    }
    const mp = date.slice(0, 7);
    if (!row.monthPrefixes.includes(mp)) row.monthPrefixes.push(mp);
    if (!date.startsWith(prefix)) { row.skippedForeignMonth++; continue; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = ds as any;
    if (entry?.frühAbsence === 'FE' || entry?.spätAbsence === 'FE') continue;
    const net = calculateDayNetHours(entry);
    if (net > 0) {
      row.entries++;
      row.netHours = Math.round((row.netHours + net) * 100) / 100;
      row.grossHours = Math.round((row.grossHours + slotGrossHours(entry?.früh) + slotGrossHours(entry?.spät)) * 100) / 100;
    }
  }
  return [...byEmp.values()];
}

/**
 * Ersetzt den localStorage-Cache eines Monats VOLLSTÄNDIG durch die
 * Supabase-Einträge (Supabase gewinnt immer, auch bei leerem Monat).
 *
 * Rückgabe false nur bei Schreibfehler (z. B. Quota) — dann bleibt der alte
 * Cache stehen und der Aufrufer soll die Supabase-Daten direkt verwenden.
 */
export function mirrorPlanMonthToLocalStorage(
  supabaseSchedule: Record<string, unknown>,
  storageKey: string,
  storage: Pick<Storage, 'setItem'> = localStorage,
): boolean {
  try {
    storage.setItem(storageKey, JSON.stringify(supabaseSchedule));
    return true;
  } catch {
    return false;
  }
}
