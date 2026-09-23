/**
 * annual-cost-imports-store – Registry der Jahres-Kontoblatt-Importe
 * ===================================================================
 * Kleine Verwaltungs-Metadaten für die Import-Verwaltungstabelle im
 * Import-Center: pro Geschäftsjahr genau EIN Eintrag (letzter Import).
 *
 * Persistenz: localStorage (schnell) + Supabase-KV-Backup.
 * Merge-Regel beim Speichern: pro Jahr gewinnt der Eintrag mit dem
 * neueren `updatedAt` (read→merge→write, kein naiver Blob-Write).
 * Löschen = Tombstone (deleted:true) — Hard-Delete würde aus dem
 * Remote-KV wieder auferstehen. Leser filtern `deleted`.
 *
 * Der storeKey wird vom Aufrufer tenant-präfixiert übergeben
 * (tenantKey(ANNUAL_COST_IMPORTS_KEY)).
 */

import { kvGet, kvSetConfirmed } from './supabase-kv';
import type { AnnualCostImportMode } from './annual-cost-preview';

export const ANNUAL_COST_IMPORTS_KEY = 'annualCostImports_v1';

export interface AnnualCostImportEntry {
  /** Geschäftsjahr (Schlüssel des Eintrags) */
  year: number;
  fileName: string;
  /** Zeitpunkt des Imports (ISO) */
  importedAt: string;
  /** Zeitraum aus dem Dateikopf */
  periodFrom?: string;
  periodTo?: string;
  accountCount: number;
  bookingCount: number;
  /** Monate mit Daten (1–12) */
  monthsWithData: number;
  /** Nicht zugeordnete Konten (Anzahl) — 0 = vollständig zugeordnet */
  unmappedCount: number;
  /** Übersprungene Buchungen ausserhalb des Jahres */
  skippedOutOfYear: number;
  /** Summe Aufwand / Ertrag (CHF, Vorzeichen bereits normalisiert) */
  sumExpense: number;
  sumIncome: number;
  /** Konfliktmodus des Imports (fehlt bei Alt-Einträgen = 'replace') */
  mode?: AnnualCostImportMode;
  /** Monate, deren Datei-Daten wegen des Modus übersprungen wurden */
  monthsSkipped?: number;
  /** Tombstone: Import wurde gelöscht (Daten aus reporting_v1 entfernt) */
  deleted?: boolean;
  /** Für Merge-Konfliktauflösung (neuester gewinnt) */
  updatedAt: string;
}

interface RegistryBlob {
  /** String(year) → Eintrag */
  entries: Record<string, AnnualCostImportEntry>;
}

function emptyBlob(): RegistryBlob {
  return { entries: {} };
}

function parseBlob(raw: unknown): RegistryBlob {
  if (!raw || typeof raw !== 'object') return emptyBlob();
  const entries = (raw as RegistryBlob).entries;
  if (!entries || typeof entries !== 'object') return emptyBlob();
  return { entries: { ...entries } };
}

function loadLocal(storeKey: string): RegistryBlob {
  try {
    return parseBlob(JSON.parse(localStorage.getItem(storeKey) || 'null'));
  } catch {
    return emptyBlob();
  }
}

function saveLocal(storeKey: string, blob: RegistryBlob): void {
  localStorage.setItem(storeKey, JSON.stringify(blob));
}

/** Pro Jahr gewinnt der Eintrag mit dem neueren updatedAt (Tombstones inklusive). */
function mergeBlobs(a: RegistryBlob, b: RegistryBlob): RegistryBlob {
  const merged: RegistryBlob = { entries: { ...a.entries } };
  for (const [year, entry] of Object.entries(b.entries)) {
    const existing = merged.entries[year];
    if (!existing || (entry.updatedAt ?? '') > (existing.updatedAt ?? '')) {
      merged.entries[year] = entry;
    }
  }
  return merged;
}

/**
 * Registry laden: localStorage sofort, KV-Backup async mergen.
 * Gibt die aktiven (nicht gelöschten) Einträge sortiert nach Jahr (absteigend).
 */
export async function loadAnnualCostImports(storeKey: string): Promise<AnnualCostImportEntry[]> {
  let blob = loadLocal(storeKey);
  try {
    const remote = parseBlob(await kvGet(storeKey));
    blob = mergeBlobs(blob, remote);
    saveLocal(storeKey, blob);
  } catch (err) {
    console.warn('[ANNUAL-IMPORTS] KV-Read fehlgeschlagen, nutze localStorage', err);
  }
  return Object.values(blob.entries)
    .filter(e => !e.deleted)
    .sort((a, b) => b.year - a.year);
}

/** Read→merge→write nach localStorage + KV (verhindert Clobber bei stale local). */
async function persistEntry(storeKey: string, entry: AnnualCostImportEntry): Promise<void> {
  let blob = loadLocal(storeKey);
  try {
    const remote = parseBlob(await kvGet(storeKey));
    blob = mergeBlobs(blob, remote);
  } catch {
    // KV nicht erreichbar → lokal weiterarbeiten, Backup beim nächsten Save
  }
  blob.entries[String(entry.year)] = entry;
  // Database-first (Issue #5): kvSetConfirmed caches locally itself, only
  // after the write is confirmed — no separate saveLocal() call needed.
  try {
    await kvSetConfirmed(storeKey, blob, 'Jahreskosten-Import-Registry');
  } catch (err) {
    console.error('[ANNUAL-IMPORTS] KV-Backup fehlgeschlagen', err);
    throw err;
  }
}

/** Import-Eintrag anlegen/ersetzen (ein Eintrag pro Jahr). */
export async function upsertAnnualCostImport(
  storeKey: string,
  entry: Omit<AnnualCostImportEntry, 'updatedAt' | 'deleted'>,
): Promise<void> {
  await persistEntry(storeKey, { ...entry, deleted: false, updatedAt: new Date().toISOString() });
}

/** Import-Eintrag löschen (Tombstone — Daten-Entfernung macht removeAnnualCostYear). */
export async function markAnnualCostImportDeleted(storeKey: string, year: number): Promise<void> {
  const blob = loadLocal(storeKey);
  const existing = blob.entries[String(year)];
  const base: AnnualCostImportEntry = existing ?? {
    year,
    fileName: '',
    importedAt: '',
    accountCount: 0,
    bookingCount: 0,
    monthsWithData: 0,
    unmappedCount: 0,
    skippedOutOfYear: 0,
    sumExpense: 0,
    sumIncome: 0,
    updatedAt: '',
  };
  await persistEntry(storeKey, { ...base, deleted: true, updatedAt: new Date().toISOString() });
}
