/**
 * import-undo-store — «Letzter Import rückgängig machen» + kleine Historie
 * =========================================================================
 * Zentrales, mandanten-getrenntes Import-Protokoll für das Import-Center.
 * Pro Quelle werden die letzten Läufe (max. 5) in app_settings gespeichert
 * (Key `import_undo_log:<tenant>`). NUR der jeweils letzte, nicht rückgängig
 * gemachte Lauf einer Quelle trägt einen Undo-Snapshot — ältere Läufe sind
 * reine Anzeige (verhindert widersprüchliche Teil-Rücksetzungen, Spec Pkt. 3).
 *
 * Regeln:
 *  - Snapshot wird VOR dem Schreiben erhoben (Aufrufer-Pflicht) und beschreibt
 *    exakt den betroffenen Scope (Quelle + Zeitraum + Mandant) — Undo stellt
 *    nur diesen Scope wieder her, alles andere bleibt unberührt.
 *  - Läufe werden nie gelöscht, nur als `undone` markiert (tombstone-frei).
 *  - Protokollieren ist best-effort: ein Fehler bricht den Import NICHT ab,
 *    wird aber sichtbar gemeldet (Undo dann nicht verfügbar).
 *  - Undo ausschliesslich für den neuesten nicht-undone Lauf; wird beim
 *    Ausführen erneut gegen den Remote-Stand geprüft (Stale-Schutz).
 */

import { appSettingsTable } from '@/lib/app-settings-table';
import { restoreReportingFields, restoreReportingRecord } from '@/lib/reporting-store';
import type { MonthlyFinancialRecord, SageJournalEntry } from '@/types/reporting';

export type ImportSourceKey =
  | 'mirus-ist'
  | 'vj-tagesumsatz'
  | 'ist-kosten-buchhaltung'
  | 'kosten-vorjahr-monat'
  | 'vorjahr-kosten-buchhaltung'
  | 'personalkosten-vorjahr';

export const IMPORT_SOURCE_LABEL: Record<ImportSourceKey, string> = {
  'mirus-ist':                  'Ist-Stunden (MIRUS)',
  'vj-tagesumsatz':             'Vorjahres-Tagesumsatz',
  'ist-kosten-buchhaltung':     'Ist Kosten Buchhaltung',
  'kosten-vorjahr-monat':       'Kosten Vorjahr (Monat)',
  'vorjahr-kosten-buchhaltung': 'Vorjahr Kosten Buchhaltung (Jahr)',
  'personalkosten-vorjahr':     'Personalkosten Vorjahr',
};

/** Ein app_settings-Key mit seinem Zustand VOR dem Import (null = existierte nicht). */
export interface KvKeyItem { key: string; value: unknown | null }

export type ImportRunSnapshot =
  /** Wiederherstellung ganzer app_settings-Keys (z. B. vj_daily:<date>). */
  | { kind: 'kv-keys'; items: KvKeyItem[] }
  /** Einzelne Felder pro Reporting-Monat (null = Feld war nicht vorhanden). */
  | { kind: 'reporting-fields'; storeKey: string; months: Array<{ monthId: string; fields: Record<string, unknown | null> }> }
  /** Kompletter Reporting-Monatsrecord (null = Monat existierte nicht) + optional Journalzeilen. */
  | { kind: 'reporting-record'; storeKey: string; monthId: string; record: unknown | null;
      journal?: { year: number; month: number; entries: unknown[] } }
  /** MIRUS: Verweis auf das dienstplan_ist_backup + Lauf-ID der geparkten Einträge. */
  | { kind: 'mirus-ist'; month: string; backupId: string; runId: string };

export interface ImportRunEntry {
  id: string;
  source: ImportSourceKey;
  timestamp: string;        // ISO
  /** Zeitraum, z. B. «Juli 2026» oder «Jahr 2025». */
  periodLabel: string;
  itemCount: number;
  /** Einheit der Anzahl, z. B. «Mitarbeiter», «Monate», «Tage». */
  itemLabel: string;
  fileName?: string;
  details?: string;
  /** Nur beim jeweils letzten Lauf der Quelle vorhanden. */
  snapshot?: ImportRunSnapshot;
  undone?: boolean;
  undoneAt?: string;
}

const storeKey = (tenantId: string) => `import_undo_log:${tenantId}`;
const MAX_RUNS_PER_SOURCE = 5;

/** UI-Refresh-Event nach jeder Protokoll-Änderung. */
export const IMPORT_UNDO_LOG_EVENT = 'import-undo-log-changed';
const notifyChanged = () => { try { window.dispatchEvent(new Event(IMPORT_UNDO_LOG_EVENT)); } catch { /* SSR/Test */ } };

function sanitize(list: unknown): ImportRunEntry[] {
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is ImportRunEntry =>
    !!e && typeof e === 'object'
    && typeof (e as ImportRunEntry).id === 'string'
    && typeof (e as ImportRunEntry).source === 'string'
    && typeof (e as ImportRunEntry).timestamp === 'string',
  );
}

/** Alle Läufe des Mandanten laden. Wirft bei Lesefehler (Lesefehler ≠ leer). */
export async function fetchImportRuns(tenantId: string): Promise<ImportRunEntry[]> {
  const { data, error } = await appSettingsTable()
    .select('value').eq('key', storeKey(tenantId)).maybeSingle();
  if (error) throw new Error(`Import-Protokoll konnte nicht geladen werden: ${error.message}`);
  if (!data) return [];
  return sanitize((data.value as { entries?: unknown } | null)?.entries);
}

/** Läufe einer Quelle, neueste zuerst. */
export async function fetchRunsForSource(tenantId: string, source: ImportSourceKey): Promise<ImportRunEntry[]> {
  return (await fetchImportRuns(tenantId))
    .filter(e => e.source === source)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

async function persist(tenantId: string, entries: ImportRunEntry[]): Promise<void> {
  const { error } = await appSettingsTable().upsert(
    { key: storeKey(tenantId), value: { entries } as unknown as Record<string, unknown> },
    { onConflict: 'key' },
  );
  if (error) throw new Error(`Import-Protokoll konnte nicht gespeichert werden: ${error.message}`);
}

export interface RecordImportRunInput {
  source: ImportSourceKey;
  periodLabel: string;
  itemCount: number;
  itemLabel: string;
  fileName?: string;
  details?: string;
  snapshot?: ImportRunSnapshot;
  /** Vorgegebene Lauf-ID (z. B. um geparkte MIRUS-Einträge zu verknüpfen). */
  id?: string;
}

/**
 * Lauf protokollieren (Laden→Mergen→Upsert). Ältere Läufe derselben Quelle
 * verlieren ihren Snapshot (nur der letzte ist rückgängig machbar) und die
 * Liste wird pro Quelle auf MAX_RUNS_PER_SOURCE gekürzt.
 * Wirft bei Fehler — Aufrufer fängt und meldet, bricht den Import aber nicht ab.
 */
export async function recordImportRun(tenantId: string, input: RecordImportRunInput): Promise<ImportRunEntry> {
  const current = await fetchImportRuns(tenantId);
  const entry: ImportRunEntry = {
    id: input.id ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    source: input.source,
    timestamp: new Date().toISOString(),
    periodLabel: input.periodLabel,
    itemCount: input.itemCount,
    itemLabel: input.itemLabel,
    ...(input.fileName ? { fileName: input.fileName } : {}),
    ...(input.details ? { details: input.details } : {}),
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
  };
  // Ältere Läufe der Quelle: Snapshot entfernen (nicht mehr rückgängig machbar).
  const stripped = current.map(e =>
    e.source === input.source && e.snapshot ? (({ snapshot: _s, ...rest }) => rest)(e) : e,
  );
  const sameSource = stripped.filter(e => e.source === input.source)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_RUNS_PER_SOURCE - 1);
  const others = stripped.filter(e => e.source !== input.source);
  await persist(tenantId, [entry, ...sameSource, ...others]);
  notifyChanged();
  return entry;
}

/** Lauf als rückgängig gemacht markieren (Snapshot wird entfernt). */
export async function markRunUndone(tenantId: string, runId: string): Promise<void> {
  const current = await fetchImportRuns(tenantId);
  const idx = current.findIndex(e => e.id === runId);
  if (idx < 0) return;
  const next = [...current];
  const { snapshot: _s, ...rest } = next[idx];
  next[idx] = { ...rest, undone: true, undoneAt: new Date().toISOString() };
  await persist(tenantId, next);
  notifyChanged();
}

/** MIRUS-Sonderfall: Lauf anhand der Backup-ID als undone markieren (Undo im Dienstplan). */
export async function markMirusRunUndoneByBackup(tenantId: string, backupId: string): Promise<string | null> {
  try {
    const runs = await fetchRunsForSource(tenantId, 'mirus-ist');
    const hit = runs.find(r => r.snapshot?.kind === 'mirus-ist' && r.snapshot.backupId === backupId);
    if (!hit) return null;
    await markRunUndone(tenantId, hit.id);
    return hit.snapshot?.kind === 'mirus-ist' ? hit.snapshot.runId : null;
  } catch (err) {
    console.warn('[IMPORT-UNDO] markMirusRunUndoneByBackup fehlgeschlagen:', err);
    return null;
  }
}

// ── Undo-Ausführung ──────────────────────────────────────────────────────────

const CHUNK = 100;

async function restoreKvKeys(items: KvKeyItem[]): Promise<void> {
  const upserts = items.filter(i => i.value !== null)
    .map(i => ({ key: i.key, value: i.value as Record<string, unknown> }));
  const deletes = items.filter(i => i.value === null).map(i => i.key);
  for (let i = 0; i < upserts.length; i += CHUNK) {
    const { error } = await appSettingsTable().upsert(upserts.slice(i, i + CHUNK), { onConflict: 'key' });
    if (error) throw new Error(`Wiederherstellung fehlgeschlagen (Upsert): ${error.message}`);
  }
  for (let i = 0; i < deletes.length; i += CHUNK) {
    const { error } = await appSettingsTable().delete().in('key', deletes.slice(i, i + CHUNK));
    if (error) throw new Error(`Wiederherstellung fehlgeschlagen (Delete): ${error.message}`);
  }
}

export interface UndoResult { ok: boolean; message: string }

/**
 * Undo des angegebenen Laufs. Stale-Schutz: der Lauf muss remote noch der
 * NEUESTE nicht-undone Lauf seiner Quelle sein und einen Snapshot tragen.
 * `mirus-ist`-Snapshots werden vom Aufrufer behandelt (siehe mirus-undo.ts) —
 * hier kommen nur die generischen Snapshot-Arten an.
 */
export async function undoImportRun(tenantId: string, run: ImportRunEntry): Promise<UndoResult> {
  const fresh = await fetchRunsForSource(tenantId, run.source);
  const latest = fresh.find(r => !r.undone);
  if (!latest || latest.id !== run.id) {
    return { ok: false, message: 'Dieser Lauf ist nicht (mehr) der letzte Import dieser Quelle — Rückgängig nicht möglich.' };
  }
  const snap = latest.snapshot;
  if (!snap) return { ok: false, message: 'Für diesen Lauf ist kein Wiederherstellungs-Snapshot vorhanden.' };

  if (snap.kind === 'kv-keys') {
    await restoreKvKeys(snap.items);
    await markRunUndone(tenantId, run.id);
    try { window.dispatchEvent(new Event('supabase-kv-synced')); } catch { /* noop */ }
    return { ok: true, message: `${snap.items.length} Einträge auf den Stand vor dem Import zurückgesetzt.` };
  }
  if (snap.kind === 'reporting-fields') {
    const res = await restoreReportingFields(snap.storeKey, snap.months);
    if (res.failedMonths.length > 0) {
      return { ok: false, message: `Rückgängig unvollständig: ${res.failedMonths.length} Monat(e) konnten nicht nach Supabase gesichert werden — bitte erneut versuchen.` };
    }
    await markRunUndone(tenantId, run.id);
    return { ok: true, message: `${snap.months.length} Monat(e) auf den Stand vor dem Import zurückgesetzt.` };
  }
  if (snap.kind === 'reporting-record') {
    const res = await restoreReportingRecord(
      snap.storeKey, snap.monthId, snap.record as MonthlyFinancialRecord | null,
      snap.journal as { year: number; month: number; entries: SageJournalEntry[] } | undefined,
    );
    if (!res.ok) return { ok: false, message: res.error ?? 'Wiederherstellung fehlgeschlagen.' };
    await markRunUndone(tenantId, run.id);
    return { ok: true, message: `Monat ${snap.monthId} auf den Stand vor dem Import zurückgesetzt.` };
  }
  return { ok: false, message: 'Dieser Import-Typ wird hier nicht direkt zurückgesetzt.' };
}
