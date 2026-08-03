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
import { kvGetStrict, kvSetStrict } from '@/lib/supabase-kv';
import { restoreReportingFields, restoreReportingRecord } from '@/lib/reporting-store';
import type { MonthlyFinancialRecord, SageJournalEntry } from '@/types/reporting';

export type ImportSourceKey =
  | 'mirus-ist'
  | 'vj-tagesumsatz'
  | 'vj-er-uebernahme'
  | 'ist-kosten-buchhaltung'
  | 'kosten-vorjahr-monat'
  | 'vorjahr-kosten-buchhaltung'
  | 'personalkosten-vorjahr'
  | 'umsatz-vorjahr-jahr'
  | 'tagesdaten-einheitsimport'
  | 'verkaufsdaten-food-beverage'
  | 'feedback-rezensionen'
  | 'reservationen-foratable';

export const IMPORT_SOURCE_LABEL: Record<ImportSourceKey, string> = {
  'mirus-ist':                  'Ist-Stunden (MIRUS)',
  'vj-tagesumsatz':             'Vorjahres-Tagesumsatz',
  'vj-er-uebernahme':           'ER-Übernahme Umsatz (Tagesdaten)',
  'ist-kosten-buchhaltung':     'Ist Kosten Buchhaltung',
  'kosten-vorjahr-monat':       'Kosten Vorjahr (Monat)',
  'vorjahr-kosten-buchhaltung': 'Vorjahr Kosten Buchhaltung (Jahr)',
  'personalkosten-vorjahr':     'Personalkosten Vorjahr',
  'umsatz-vorjahr-jahr':        'Umsatz Vorjahr (Jahres-Excel)',
  'tagesdaten-einheitsimport':  'Tagesdaten-Einheitsimport',
  'verkaufsdaten-food-beverage': 'Verkaufsdaten Food/Beverage (Jahr)',
  'feedback-rezensionen':       'Feedback-Rezensionen (Lunchgate)',
  'reservationen-foratable':    'Reservationen (Foratable)',
};

/** Ein app_settings-Key mit seinem Zustand VOR dem Import (null = existierte nicht). */
export interface KvKeyItem { key: string; value: unknown | null }

export type ImportRunSnapshot =
  /** Wiederherstellung ganzer app_settings-Keys (z. B. vj_daily:<date>). */
  | { kind: 'kv-keys'; items: KvKeyItem[] }
  /** Einzelne Felder pro Reporting-Monat (null = Feld war nicht vorhanden)
   *  + optional Journal-Vorzustände pro Monat (Buchungszeilen). */
  | { kind: 'reporting-fields'; storeKey: string; months: Array<{ monthId: string; fields: Record<string, unknown | null> }>;
      journals?: Array<{ year: number; month: number; entries: unknown[]; tenantId?: string }> }
  /** Kompletter Reporting-Monatsrecord (null = Monat existierte nicht) + optional Journalzeilen. */
  | { kind: 'reporting-record'; storeKey: string; monthId: string; record: unknown | null;
      journal?: { year: number; month: number; entries: unknown[]; tenantId?: string } }
  /** MIRUS: Verweis auf das dienstplan_ist_backup + Lauf-ID der geparkten Einträge. */
  | { kind: 'mirus-ist'; month: string; backupId: string; runId: string }
  /** Reservationen (Foratable): Vorzustand der betroffenen Res.Nr. in
   *  reservation_records. extIds = ALLE importierten Res.Nr.; priorRows =
   *  vollständige Vorzustands-Zeilen (Res.Nr. ohne priorRow = war neu → löschen). */
  | { kind: 'reservation-records'; restaurantId: string; extIds: string[];
      priorRows: Array<Record<string, unknown>> }
  /** Einzelne EINTRÄGE innerhalb von KV-Blobs (z. B. dailyBudgets, gaeste-daily):
   *  pro Blob-Key eine Map Eintrag→Vorzustand (null = Eintrag existierte nicht).
   *  Optional zusätzlich ganze KV-Keys (kvItems, z. B. vj_daily:<date>). */
  | { kind: 'kv-blob-entries'; blobs: Array<{
        key: string;
        entries: Record<string, unknown | null>;
        /** Optionaler Konfliktschutz: erwarteter Zustand der betroffenen
         *  Einträge DIREKT NACH dem Import (null = Eintrag wurde entfernt).
         *  Weicht der aktuelle Remote-Stand ab (späterer manueller Edit /
         *  anderer Writer), wird der Undo VERWEIGERT statt Änderungen zu
         *  überschreiben. */
        expected?: Record<string, unknown | null>;
      }>;
      kvItems?: KvKeyItem[] };

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

/**
 * Einträge innerhalb von KV-Blobs auf den Vorzustand zurücksetzen.
 * STRICT: Merge-Basis wird remote gelesen (Lesefehler ≠ leer) — bei Lesefehler
 * wird der Undo abgebrochen, damit kein Blob ohne Remote-Basis ersetzt wird.
 * null = Eintrag existierte vor dem Import nicht → wird entfernt.
 */
async function restoreKvBlobEntries(
  blobs: Array<{ key: string; entries: Record<string, unknown | null>; expected?: Record<string, unknown | null> }>,
): Promise<number> {
  let restored = 0;
  // Konfliktprüfung ZUERST über ALLE Blobs (kein Teil-Undo bei Konflikt).
  for (const blob of blobs) {
    if (!blob.expected) continue;
    const remote = await kvGetStrict(blob.key);
    const base: Record<string, unknown> =
      (remote && typeof remote === 'object' && !Array.isArray(remote))
        ? (remote as Record<string, unknown>)
        : {};
    for (const [entryKey, exp] of Object.entries(blob.expected)) {
      const cur = base[entryKey] ?? null;
      const same = exp === null ? cur === null : JSON.stringify(cur) === JSON.stringify(exp);
      if (!same) {
        throw new Error(
          `Konflikt: «${entryKey}» wurde seit dem Import verändert (manuell oder durch einen anderen Import) — Rückgängig abgebrochen, nichts geändert.`,
        );
      }
    }
  }
  for (const blob of blobs) {
    const remote = await kvGetStrict(blob.key);
    const base: Record<string, unknown> =
      (remote && typeof remote === 'object' && !Array.isArray(remote))
        ? { ...(remote as Record<string, unknown>) }
        : {};
    for (const [entryKey, prior] of Object.entries(blob.entries)) {
      if (prior === null) delete base[entryKey];
      else base[entryKey] = prior;
      restored++;
    }
    try { localStorage.setItem(blob.key, JSON.stringify(base)); } catch { /* voll */ }
    await kvSetStrict(blob.key, base);
  }
  try {
    window.dispatchEvent(new Event('store-synced'));
    window.dispatchEvent(new Event('supabase-kv-synced'));
  } catch { /* SSR/Test */ }
  return restored;
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
  if (snap.kind === 'kv-blob-entries') {
    let restored: number;
    try {
      restored = await restoreKvBlobEntries(snap.blobs);
    } catch (err) {
      // Konflikt oder KV-Fehler: NICHTS wurde geändert — Lauf bleibt undo-bar.
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    if (snap.kvItems && snap.kvItems.length > 0) await restoreKvKeys(snap.kvItems);
    await markRunUndone(tenantId, run.id);
    try { window.dispatchEvent(new Event('supabase-kv-synced')); } catch { /* noop */ }
    return { ok: true, message: `${restored} Einträge auf den Stand vor dem Import zurückgesetzt.` };
  }
  if (snap.kind === 'reporting-fields') {
    const res = await restoreReportingFields(snap.storeKey, snap.months);
    if (res.failedMonths.length > 0) {
      return { ok: false, message: `Rückgängig unvollständig: ${res.failedMonths.length} Monat(e) konnten nicht nach Supabase gesichert werden — bitte erneut versuchen.` };
    }
    // Journal-Vorzustände wiederherstellen (strikt: Fehler → Undo als unvollständig melden)
    if (snap.journals && snap.journals.length > 0) {
      const { saveJournalEntriesStrict } = await import('@/lib/reporting-store');
      for (const j of snap.journals) {
        try {
          await saveJournalEntriesStrict(j.year, j.month, j.entries as SageJournalEntry[], j.tenantId ?? 'oliv');
        } catch (err) {
          console.error('[IMPORT-UNDO] Journal-Wiederherstellung fehlgeschlagen:', j.year, j.month, err);
          return { ok: false, message: `Rückgängig unvollständig: Buchungszeilen ${String(j.month).padStart(2, '0')}.${j.year} konnten nicht wiederhergestellt werden — bitte erneut versuchen.` };
        }
      }
    }
    await markRunUndone(tenantId, run.id);
    return { ok: true, message: `${snap.months.length} Monat(e) auf den Stand vor dem Import zurückgesetzt.` };
  }
  if (snap.kind === 'reporting-record') {
    const res = await restoreReportingRecord(
      snap.storeKey, snap.monthId, snap.record as MonthlyFinancialRecord | null,
      snap.journal as { year: number; month: number; entries: SageJournalEntry[]; tenantId?: string } | undefined,
    );
    if (!res.ok) return { ok: false, message: res.error ?? 'Wiederherstellung fehlgeschlagen.' };
    await markRunUndone(tenantId, run.id);
    return { ok: true, message: `Monat ${snap.monthId} auf den Stand vor dem Import zurückgesetzt.` };
  }
  if (snap.kind === 'reservation-records') {
    const res = await restoreReservationRecords(snap.restaurantId, snap.extIds, snap.priorRows);
    if (!res.ok) return { ok: false, message: res.error ?? 'Wiederherstellung fehlgeschlagen.' };
    await markRunUndone(tenantId, run.id);
    return {
      ok: true,
      message: `${snap.extIds.length} Reservationen auf den Stand vor dem Import zurückgesetzt`
        + (res.deleted > 0 ? ` (${res.deleted} neu importierte entfernt)` : '') + '.',
    };
  }
  return { ok: false, message: 'Dieser Import-Typ wird hier nicht direkt zurückgesetzt.' };
}

/**
 * Reservationen (Foratable) zurücksetzen: neu importierte Res.Nr. löschen,
 * zuvor bestehende Zeilen verbatim wiederherstellen, Gast-Aggregate der
 * betroffenen Gäste neu berechnen. Tenant-gescopt über restaurant_id.
 */
async function restoreReservationRecords(
  restaurantId: string, extIds: string[], priorRows: Array<Record<string, unknown>>,
): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const { supabase } = await import('@/integrations/supabase/client');
  const priorByExt = new Set(priorRows.map(r => String(r.external_reservation_id)));
  const toDelete = [...new Set(extIds)].filter(id => !priorByExt.has(id));
  const affectedGuests = new Set<string>();
  try {
    // Betroffene Gäste VOR dem Löschen einsammeln (aktuelle + vorherige guest_ids).
    for (let i = 0; i < extIds.length; i += 200) {
      const part = [...new Set(extIds)].slice(i, i + 200);
      if (part.length === 0) break;
      const { data, error } = await (supabase as any)
        .from('reservation_records')
        .select('guest_id')
        .eq('restaurant_id', restaurantId)
        .in('external_reservation_id', part);
      if (error) return { ok: false, deleted: 0, error: `Lesen fehlgeschlagen: ${error.message ?? error}` };
      for (const row of (data ?? []) as Array<{ guest_id: string | null }>) {
        if (row.guest_id) affectedGuests.add(row.guest_id);
      }
    }
    for (const r of priorRows) if (r.guest_id) affectedGuests.add(String(r.guest_id));

    // 1) Neu importierte Res.Nr. entfernen (existierten vor dem Import nicht).
    for (let i = 0; i < toDelete.length; i += 200) {
      const part = toDelete.slice(i, i + 200);
      if (part.length === 0) break;
      const { error } = await (supabase as any)
        .from('reservation_records')
        .delete()
        .eq('restaurant_id', restaurantId)
        .in('external_reservation_id', part);
      if (error) return { ok: false, deleted: 0, error: `Löschen fehlgeschlagen: ${error.message ?? error}` };
    }
    // 2) Vorherige Zeilen verbatim wiederherstellen (Upsert über den Conflict-Key).
    for (let i = 0; i < priorRows.length; i += 200) {
      const part = priorRows.slice(i, i + 200);
      if (part.length === 0) break;
      const { error } = await (supabase as any)
        .from('reservation_records')
        .upsert(part, { onConflict: 'restaurant_id,external_reservation_id' });
      if (error) return { ok: false, deleted: toDelete.length, error: `Wiederherstellen fehlgeschlagen: ${error.message ?? error}` };
    }
    // 3) Gast-Aggregate der betroffenen Gäste neu berechnen (best effort mit Meldung).
    if (affectedGuests.size > 0) {
      const { recomputeGuestAggregates } = await import('@/lib/reservation-import-db');
      const err = await recomputeGuestAggregates(restaurantId, [...affectedGuests]);
      if (err) return { ok: false, deleted: toDelete.length, error: `Reservationen zurückgesetzt, aber Gäste-Statistik fehlgeschlagen: ${err}` };
    }
    return { ok: true, deleted: toDelete.length };
  } catch (e) {
    return { ok: false, deleted: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
