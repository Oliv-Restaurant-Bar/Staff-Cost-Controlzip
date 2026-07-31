/**
 * mirus-open-hours-store — «Offene Stunden» aus dem MIRUS-Import
 * ===============================================================
 * Nicht zuordenbare Stunden werden GEPARKT statt verworfen: persistent pro
 * Mandant in app_settings (Key `mirus_open_hours:<tenant>`), bis sie einem
 * Mitarbeiter zugewiesen oder explizit verworfen werden.
 *
 * Regeln:
 *  - Parken schreibt NICHTS in die Ist-Werte — Stunden zählen erst nach
 *    der Zuweisung (die durch die normale Reconcile-Pipeline läuft).
 *  - Dedupe: gleicher Name (normalisiert) + Monat + Quelle → kein Duplikat.
 *  - Auflösen/Verwerfen markiert den Eintrag (Status), löscht ihn nicht —
 *    Reader filtern auf 'open'. So gibt es keine Tombstone-Probleme beim
 *    Merge (siehe Memory: kv-merge-tombstones).
 *  - Persistenz via Laden→Mergen→Upsert (best-effort, nicht atomar —
 *    gleiche bekannte Grenze wie bei den MIRUS-Aliassen).
 */

import { foldDiacritics } from '@/lib/mirus-name-mapping-store';
import type { Department } from '@/types/personnel';

export type ParkedHoursStatus = 'open' | 'resolved' | 'discarded';

export interface ParkedHoursEntry {
  id: string;
  /** MIRUS-Name exakt wie in der Datei */
  name: string;
  department: Department;
  /** Monat yyyy-MM */
  month: string;
  /** Tageswerte, Key = yyyy-MM-dd, Wert = Stunden */
  days: Record<string, number>;
  totalHours: number;
  sourceFile: string;
  importedAt: string; // ISO
  status: ParkedHoursStatus;
  resolvedAt?: string;
  resolvedEmployeeId?: string;
  resolvedNote?: string;
}

const storeKey = (tenantId: string) => `mirus_open_hours:${tenantId}`;

/** Normalisierter Vergleichs-Key für Namen (reihenfolge-tolerant, Umlaute gefaltet). */
export function parkedNameKey(name: string): string {
  return foldDiacritics(name.toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean).sort().join(' ');
}

function sanitize(list: unknown): ParkedHoursEntry[] {
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is ParkedHoursEntry =>
    !!e && typeof e === 'object'
    && typeof (e as ParkedHoursEntry).id === 'string'
    && typeof (e as ParkedHoursEntry).name === 'string'
    && typeof (e as ParkedHoursEntry).month === 'string'
    && !!(e as ParkedHoursEntry).days && typeof (e as ParkedHoursEntry).days === 'object',
  );
}

/** Alle geparkten Einträge des Mandanten laden. Wirft bei Lesefehler (nie leeres Array vortäuschen). */
export async function fetchParkedEntries(tenantId: string): Promise<ParkedHoursEntry[]> {
  const { appSettingsTable } = await import('@/lib/app-settings-table');
  const { data, error } = await appSettingsTable()
    .select('value')
    .eq('key', storeKey(tenantId))
    .maybeSingle();
  if (error) throw new Error(`Offene Stunden konnten nicht geladen werden: ${error.message}`);
  if (!data) return [];
  const val = data.value as { entries?: unknown } | null;
  return sanitize(val?.entries);
}

/** Nur offene Einträge (Status 'open'). */
export async function fetchOpenParkedEntries(tenantId: string): Promise<ParkedHoursEntry[]> {
  return (await fetchParkedEntries(tenantId)).filter(e => e.status === 'open');
}

async function persist(tenantId: string, entries: ParkedHoursEntry[]): Promise<void> {
  const { appSettingsTable } = await import('@/lib/app-settings-table');
  const { error } = await appSettingsTable().upsert(
    { key: storeKey(tenantId), value: { entries } as unknown as Record<string, unknown> },
    { onConflict: 'key' },
  );
  if (error) throw new Error(`Offene Stunden konnten nicht gespeichert werden: ${error.message}`);
}

export interface ParkInput {
  name: string;
  department: Department;
  month: string;
  days: Record<string, number>;
  sourceFile: string;
}

/**
 * Einträge parken (Laden→Mergen→Upsert). Dedupe: existiert bereits ein
 * OFFENER Eintrag mit gleichem Namens-Key + Monat + Quelle, wird er NICHT
 * doppelt angelegt. Gibt die Anzahl neu geparkter Einträge zurück.
 */
export async function parkEntries(tenantId: string, inputs: ParkInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  const current = await fetchParkedEntries(tenantId);
  const openKeys = new Set(
    current.filter(e => e.status === 'open')
      .map(e => `${parkedNameKey(e.name)}|${e.month}|${e.sourceFile}`),
  );
  let added = 0;
  const next = [...current];
  for (const inp of inputs) {
    const key = `${parkedNameKey(inp.name)}|${inp.month}|${inp.sourceFile}`;
    if (openKeys.has(key)) continue;
    openKeys.add(key);
    const total = Object.values(inp.days).reduce((s, h) => s + h, 0);
    next.push({
      id: `park_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: inp.name,
      department: inp.department,
      month: inp.month,
      days: inp.days,
      totalHours: Math.round(total * 100) / 100,
      sourceFile: inp.sourceFile,
      importedAt: new Date().toISOString(),
      status: 'open',
    });
    added++;
  }
  if (added > 0) await persist(tenantId, next);
  return added;
}

/** Status eines Eintrags setzen (resolved/discarded). Laden→Ändern→Upsert. */
async function setStatus(
  tenantId: string, id: string, status: ParkedHoursStatus,
  extra?: Partial<Pick<ParkedHoursEntry, 'resolvedEmployeeId' | 'resolvedNote'>>,
): Promise<void> {
  const current = await fetchParkedEntries(tenantId);
  const idx = current.findIndex(e => e.id === id);
  if (idx < 0) throw new Error('Geparkter Eintrag nicht gefunden (evtl. bereits aufgelöst).');
  const next = [...current];
  next[idx] = { ...next[idx], status, resolvedAt: new Date().toISOString(), ...extra };
  await persist(tenantId, next);
}

export async function markParkedResolved(
  tenantId: string, id: string, employeeId: string, note?: string,
): Promise<void> {
  await setStatus(tenantId, id, 'resolved', { resolvedEmployeeId: employeeId, ...(note ? { resolvedNote: note } : {}) });
}

export async function discardParkedEntry(tenantId: string, id: string): Promise<void> {
  await setStatus(tenantId, id, 'discarded');
}

/** Toleranz beim Tageswert-Vergleich für die Auto-Auflösung (Rundung). */
const RESOLVE_COVERAGE_TOLERANCE_H = 0.05;

/**
 * Re-Import-Dedupe (Spec 4): Nach einem erfolgreichen Import werden offene
 * geparkte Einträge des gleichen Monats aufgelöst, deren Name jetzt einem
 * importierten Namen entspricht UND deren Tageswerte vom Import ABGEDECKT
 * sind (jeder geparkte Tag mit Stunden ist in der Datei mit praktisch
 * gleichem Wert enthalten). Ein Teil-Import derselben Person löst einen
 * anders gelagerten geparkten Eintrag NICHT stillschweigend auf.
 * Best-effort: Fehler werden geloggt, der Import selbst ist davon unabhängig.
 */
export async function resolveParkedByImport(
  tenantId: string, month: string,
  imported: Array<{ importedName: string; employeeId: string; days: Record<string, number> }>,
): Promise<number> {
  if (imported.length === 0) return 0;
  try {
    const current = await fetchParkedEntries(tenantId);
    const byKey = new Map(imported.map(i => [parkedNameKey(i.importedName), i]));
    let changed = 0;
    const next = current.map(e => {
      if (e.status !== 'open' || e.month !== month) return e;
      const match = byKey.get(parkedNameKey(e.name));
      if (!match) return e;
      // Abdeckungs-Check: alle geparkten Tage mit Stunden müssen im Import
      // mit (praktisch) gleichem Wert vorkommen — sonst offen lassen.
      const covered = Object.entries(e.days).every(([date, hours]) =>
        hours <= RESOLVE_COVERAGE_TOLERANCE_H
        || Math.abs((match.days[date] ?? 0) - hours) <= RESOLVE_COVERAGE_TOLERANCE_H,
      );
      if (!covered) return e;
      const empId = match.employeeId;
      changed++;
      return {
        ...e, status: 'resolved' as const, resolvedAt: new Date().toISOString(),
        resolvedEmployeeId: empId, resolvedNote: 'Durch erneuten Import automatisch aufgelöst',
      };
    });
    if (changed > 0) await persist(tenantId, next);
    return changed;
  } catch (err) {
    console.warn('[MIRUS-PARK] Auto-Auflösung nach Import fehlgeschlagen:', err);
    return 0;
  }
}
