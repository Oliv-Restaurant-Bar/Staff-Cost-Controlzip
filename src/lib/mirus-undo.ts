/**
 * mirus-undo — MIRUS-Import rückgängig machen (Import-Center)
 * ============================================================
 * Stellt den Ist-Stunden-Stand aus dem beim Import angelegten
 * dienstplan_ist_backup wieder her — komponentenlos, damit das Import-Center
 * (ohne Dienstplan-State) denselben Undo ausführen kann wie der Dienstplan.
 *
 * Regeln (identisch zum Dienstplan-Undo):
 *  - Scope = Backup-Scope (employeeIds × dates): fehlende Row = Zelle war leer.
 *  - Jeder Write awaited + geprüft; bei Teilfehler bleibt das Backup erhalten.
 *  - Backup erst NACH vollständigem Erfolg löschen.
 *  - Zusätzlich (Spec): offene geparkte «Offene Stunden»-Einträge dieses
 *    Laufs verwerfen — kein Rest bleibt hängen. Aliasse bleiben erhalten.
 */

import { supabase } from '@/integrations/supabase/client';
import {
  loadDienstplanIstBackupById, deleteDienstplanIstBackup,
  saveActualHourEntry, type ActualHourEntry,
} from '@/lib/supabase-db';
import { discardParkedByRun } from '@/lib/mirus-open-hours-store';
import { markRunUndone, fetchRunsForSource } from '@/lib/import-undo-store';

interface ActualRow {
  employee_id: string; date: string; hours: number;
  start_time: string | null; end_time: string | null;
  absence_type: string | null; is_additional_cost_ist: boolean | null; source: string | null;
}

const entryFromRow = (r: {
  hours: number; start_time?: string | null; end_time?: string | null;
  absence_type?: string | null; is_additional_cost_ist?: boolean | null; source?: string | null;
} | undefined | null): ActualHourEntry | null => r ? {
  hours: Number(r.hours),
  ...(r.start_time ? { start: r.start_time } : {}),
  ...(r.end_time ? { end: r.end_time } : {}),
  ...(r.absence_type ? { absenceType: r.absence_type as ActualHourEntry['absenceType'] } : {}),
  ...(r.is_additional_cost_ist ? { isAdditionalCost: true } : {}),
  ...(r.source ? { source: r.source as ActualHourEntry['source'] } : {}),
} : null;

export interface MirusUndoResult { ok: boolean; message: string; restored?: number }

/**
 * Undo eines MIRUS-Laufs anhand seines Snapshots.
 * Markiert bei Erfolg den Lauf im Import-Protokoll als undone.
 */
export async function undoMirusImportRun(
  tenantId: string,
  run: { id: string; snapshot: { month: string; backupId: string; runId: string } },
): Promise<MirusUndoResult> {
  // Stale-Schutz (wie undoImportRun): der Lauf muss remote noch der NEUESTE
  // nicht-undone MIRUS-Lauf sein — sonst würde ein älteres Backup einen
  // neueren Import überschreiben (z. B. zweiter Tab / zwischenzeitlicher Import).
  const fresh = await fetchRunsForSource(tenantId, 'mirus-ist');
  const latest = fresh.find(r => !r.undone);
  if (!latest || latest.id !== run.id) {
    return { ok: false, message: 'Dieser Lauf ist nicht (mehr) der letzte MIRUS-Import — Rückgängig nicht möglich.' };
  }

  const backup = await loadDienstplanIstBackupById(run.snapshot.backupId);
  if (!backup) {
    return { ok: false, message: 'Backup dieses Imports nicht gefunden — wurde es bereits über den Dienstplan rückgängig gemacht?' };
  }

  // Aktuellen Ist-Stand des Scopes lesen (Diff: nur veränderte Zellen schreiben).
  // Untypisierter Zugriff wie in supabase-db.ts (actual_hours fehlt in den generierten Typen).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: currentRows, error: readErr } = await (supabase as any)
    .from('actual_hours')
    .select('employee_id,date,hours,start_time,end_time,absence_type,is_additional_cost_ist,source')
    .in('employee_id', backup.scope.employeeIds)
    .in('date', backup.scope.dates);
  if (readErr) {
    return { ok: false, message: `Aktueller Ist-Stand konnte nicht gelesen werden: ${readErr.message}` };
  }
  const currentMap = new Map((currentRows as ActualRow[] ?? []).map(r => [`${r.employee_id}-${r.date}`, r]));
  const backupMap = new Map(backup.rows.map(r => [`${r.employee_id}-${r.date}`, r]));

  let restored = 0;
  const failed: string[] = [];
  for (const empId of backup.scope.employeeIds) {
    for (const date of backup.scope.dates) {
      const target = entryFromRow(backupMap.get(`${empId}-${date}`));
      const current = entryFromRow(currentMap.get(`${empId}-${date}`));
      if (JSON.stringify(current) === JSON.stringify(target)) continue;
      const res = await saveActualHourEntry(empId, date, target);
      if (res.ok) restored++;
      else failed.push(`${empId} ${date}`);
    }
  }
  if (failed.length > 0) {
    // Backup NICHT löschen — Wiederherstellung war unvollständig.
    return {
      ok: false,
      message: `Rückgängig unvollständig: ${failed.length} Zellen konnten nicht zurückgesetzt werden. Backup bleibt erhalten — bitte erneut versuchen.`,
    };
  }

  await deleteDienstplanIstBackup(backup.id);

  // Geparkte «Offene Stunden» dieses Laufs verwerfen (best-effort, sichtbar loggen).
  let discarded = 0;
  try {
    discarded = await discardParkedByRun(tenantId, run.snapshot.runId);
  } catch (err) {
    console.warn('[MIRUS-UNDO] Geparkte Einträge konnten nicht verworfen werden:', err);
  }

  // Lokalen Abgleichs-Report des Monats entfernen (er beschreibt einen
  // zurückgesetzten Import). Key-Schema = tenantKey(reportStorageKey(month)):
  // Oliv ohne Präfix, andere Mandanten mit `${tenantId}:`.
  const reportKey = `mirus-import-report-${run.snapshot.month}`;
  try { localStorage.removeItem(tenantId === 'oliv' ? reportKey : `${tenantId}:${reportKey}`); } catch { /* noop */ }

  await markRunUndone(tenantId, run.id);
  try { window.dispatchEvent(new CustomEvent('schedule-updated')); } catch { /* noop */ }

  return {
    ok: true, restored,
    message: `${restored} Zellen auf den Stand vor dem Import zurückgesetzt` +
      (discarded > 0 ? `, ${discarded} geparkte «Offene Stunden»-Einträge entfernt.` : '.'),
  };
}
