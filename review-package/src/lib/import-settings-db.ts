/**
 * import-settings-db.ts — IO-Schicht der Import-Einstellungen + Inventur-Häkchen.
 * ===============================================================================
 * localStorage = schneller Primärspeicher (tenant-präfixierte Schlüssel),
 * Supabase-KV = Backup. Persistenz-Regeln (§2, Muster kpi-targets-db):
 *  - Laden: localStorage sofort; KV-Backup wird dazu-GEMERGT (Union, newer-wins)
 *    und das Ergebnis lokal gespiegelt. Reines Laden schreibt NIE ins KV.
 *  - Speichern: read→merge→write — vor dem KV-Write wird der Remote-Stand
 *    strikt gelesen (kvGetStrict: Lesefehler ≠ leer!) und gemergt.
 *  - Backup-Fehler sichtbar über notifyKVBackupProblem (kein stiller Fallback).
 */

import type { TenantId } from '@/contexts/TenantContext';
import { tenantKey } from '@/lib/tenant-utils';
import { kvGet, kvGetStrict, kvSetStrict, notifyKVBackupProblem } from '@/lib/supabase-kv';
import {
  IMPORT_SETTINGS_KEY,
  INVENTUR_CHECKS_KEY,
  mergeImportSettings,
  mergeInventurChecks,
  normalizeImportSettings,
  normalizeInventurChecks,
  type ImportSettingsBlob,
  type InventurChecksBlob,
} from '@/lib/import-settings';

// ── Import-Einstellungen (import_settings_v1) ────────────────────────────

function settingsKey(tenantId: TenantId): string {
  return tenantKey(tenantId, IMPORT_SETTINGS_KEY);
}

export function loadImportSettingsLocal(tenantId: TenantId): ImportSettingsBlob {
  try {
    const raw = localStorage.getItem(settingsKey(tenantId));
    return raw ? normalizeImportSettings(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function writeSettingsLocal(tenantId: TenantId, blob: ImportSettingsBlob): void {
  try {
    localStorage.setItem(settingsKey(tenantId), JSON.stringify(blob));
  } catch {
    /* localStorage voll/gesperrt — KV bleibt Backup */
  }
}

/** Laden mit KV-Merge (best-effort). Schreibt NIE ins KV. */
export async function loadImportSettings(tenantId: TenantId): Promise<ImportSettingsBlob> {
  const local = loadImportSettingsLocal(tenantId);
  try {
    const remoteRaw = await kvGet(settingsKey(tenantId));
    if (remoteRaw === null) return local;
    const remote = normalizeImportSettings(remoteRaw);
    const merged = mergeImportSettings(local, remote);
    writeSettingsLocal(tenantId, merged);
    return merged;
  } catch {
    return local;
  }
}

/** Speichern: lokal sofort, KV-Backup über read→merge→write. */
export async function saveImportSettings(tenantId: TenantId, blob: ImportSettingsBlob): Promise<void> {
  writeSettingsLocal(tenantId, blob);
  const key = settingsKey(tenantId);
  try {
    const remoteRaw = await kvGetStrict(key);
    const remote = remoteRaw === null ? {} : normalizeImportSettings(remoteRaw);
    const merged = mergeImportSettings(remote, blob);
    await kvSetStrict(key, merged);
    writeSettingsLocal(tenantId, merged);
  } catch (err) {
    void notifyKVBackupProblem(err, 'Import-Einstellungen', {
      toastId: 'import-settings-backup',
      retry: () => saveImportSettings(tenantId, loadImportSettingsLocal(tenantId)),
    });
  }
}

// ── Inventur-Häkchen (inventur_checks_v1) ────────────────────────────────

function inventurKey(tenantId: TenantId): string {
  return tenantKey(tenantId, INVENTUR_CHECKS_KEY);
}

export function loadInventurChecksLocal(tenantId: TenantId): InventurChecksBlob {
  try {
    const raw = localStorage.getItem(inventurKey(tenantId));
    return raw ? normalizeInventurChecks(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function writeInventurLocal(tenantId: TenantId, blob: InventurChecksBlob): void {
  try {
    localStorage.setItem(inventurKey(tenantId), JSON.stringify(blob));
  } catch {
    /* localStorage voll/gesperrt — KV bleibt Backup */
  }
}

/** Laden mit KV-Merge (best-effort). Schreibt NIE ins KV. */
export async function loadInventurChecks(tenantId: TenantId): Promise<InventurChecksBlob> {
  const local = loadInventurChecksLocal(tenantId);
  try {
    const remoteRaw = await kvGet(inventurKey(tenantId));
    if (remoteRaw === null) return local;
    const remote = normalizeInventurChecks(remoteRaw);
    const merged = mergeInventurChecks(local, remote);
    writeInventurLocal(tenantId, merged);
    return merged;
  } catch {
    return local;
  }
}

/** Speichern: lokal sofort, KV-Backup über read→merge→write. */
export async function saveInventurChecks(tenantId: TenantId, blob: InventurChecksBlob): Promise<void> {
  writeInventurLocal(tenantId, blob);
  const key = inventurKey(tenantId);
  try {
    const remoteRaw = await kvGetStrict(key);
    const remote = remoteRaw === null ? {} : normalizeInventurChecks(remoteRaw);
    const merged = mergeInventurChecks(remote, blob);
    await kvSetStrict(key, merged);
    writeInventurLocal(tenantId, merged);
  } catch (err) {
    void notifyKVBackupProblem(err, 'Inventur-Häkchen', {
      toastId: 'inventur-checks-backup',
      retry: () => saveInventurChecks(tenantId, loadInventurChecksLocal(tenantId)),
    });
  }
}
