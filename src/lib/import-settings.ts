/**
 * import-settings.ts — Konfigurierbare Import-Frequenzen & Cockpit-Einstellungen (REINE LOGIK).
 * =============================================================================================
 * Basis-Modul der neuen Import-Strategie: Jede Datenquelle (Aufgabentyp) erhält
 * eine konfigurierbare Import-Frequenz (täglich / wöchentlich / monatlich /
 * bei Bedarf / deaktiviert). Zusätzlich tenant-weite Ruhetage (Wochentage ohne
 * erwartete Tagesdaten) und Karenztage (delayDays) je Quelle.
 *
 * Blob 1 — `import_settings_v1` (tenant-präfixiert):
 *   { <typ>:      { frequency?, delayDays?, updatedAt, updatedBy?, deleted? },
 *     ruhetage:   { restWeekdays?, updatedAt, updatedBy?, deleted? } }
 *
 * Blob 2 — `inventur_checks_v1` (tenant-präfixiert): manuelles Monats-Häkchen
 * für die Inventur (die Inventur hat keine importierbare Datenquelle):
 *   { 'YYYY-MM': { updatedAt, updatedBy?, deleted? } }   (sichtbar = erledigt)
 *
 * Persistenz-Regeln (§2 replit.md, Muster kpi_targets_v1):
 *  - Union-Merge newer-wins je Schlüssel (updatedAt, ISO-Vergleich).
 *  - Löschen/Zurücksetzen = Tombstone (deleted + updatedAt-Bump), NIE Hard-Delete.
 *  - Dirty-Check: identischer Zielzustand ⇒ No-op (kein Write, kein Bump).
 *  - Reines Laden schreibt NIE.
 * Dieses Modul ist DOM- und Supabase-frei; IO liegt in import-settings-db.ts.
 */

// ── Aufgabentypen der neuen Import-Strategie ─────────────────────────────

/**
 * Alle konfigurierbaren Import-Aufgabentypen. Die Engine
 * (import-tasks-engine.ts) leitet ihren `ImportTaskType` hiervon ab.
 * Entfallen als Aufgaben (nur noch Datenstand): umsatz, verkaufsdaten,
 * budget, istkosten (in erfolgsrechnung verschmolzen), vorjahr.
 */
export const CONFIGURABLE_IMPORT_TYPES = [
  'zbericht',
  'gaeste_bon',
  'mirus',
  'tagesabschluss',
  'marketing',
  'reservationen',
  'erfolgsrechnung',
  'warenrechnungen',
  'inventur',
] as const;

export type ConfigurableImportType = (typeof CONFIGURABLE_IMPORT_TYPES)[number];

export function isConfigurableImportType(v: unknown): v is ConfigurableImportType {
  return typeof v === 'string' && (CONFIGURABLE_IMPORT_TYPES as readonly string[]).includes(v);
}

/**
 * Abdeckungs-Art je Typ: 'days' = Tages-Coverage (coveredDays),
 * 'month' = Monats-Flag (monthDone). Bestimmt auch die erlaubten Frequenzen.
 */
export const IMPORT_TYPE_COVERAGE_KIND: Record<ConfigurableImportType, 'days' | 'month'> = {
  zbericht: 'days',
  gaeste_bon: 'days',
  mirus: 'days',
  tagesabschluss: 'days',
  marketing: 'days',
  reservationen: 'days',
  erfolgsrechnung: 'month',
  warenrechnungen: 'month',
  inventur: 'month',
};

// ── Frequenzen ───────────────────────────────────────────────────────────

export type ImportFrequencySetting =
  | 'taeglich'
  | 'woechentlich'
  | 'monatlich'
  | 'bei_bedarf'
  | 'deaktiviert';

export const FREQUENCY_SETTING_LABEL: Record<ImportFrequencySetting, string> = {
  taeglich: 'Täglich',
  woechentlich: 'Wöchentlich',
  monatlich: 'Monatlich',
  bei_bedarf: 'Bei Bedarf',
  deaktiviert: 'Deaktiviert',
};

const DAY_KIND_FREQUENCIES: readonly ImportFrequencySetting[] = [
  'taeglich',
  'woechentlich',
  'monatlich',
  'bei_bedarf',
  'deaktiviert',
];
const MONTH_KIND_FREQUENCIES: readonly ImportFrequencySetting[] = [
  'monatlich',
  'bei_bedarf',
  'deaktiviert',
];

/** Erlaubte Frequenzen je Typ (Monats-Quellen kennen keine Tages-Abdeckung). */
export function allowedFrequencies(type: ConfigurableImportType): readonly ImportFrequencySetting[] {
  return IMPORT_TYPE_COVERAGE_KIND[type] === 'month' ? MONTH_KIND_FREQUENCIES : DAY_KIND_FREQUENCIES;
}

// ── Defaults (freigegebene Fachentscheide) ───────────────────────────────

export interface EffectiveTypeSetting {
  frequency: ImportFrequencySetting;
  /** Karenz-/Bereitstellungstage: Tag X gilt erst ab X+1+delayDays als fällig. */
  delayDays: number;
}

export const DEFAULT_TYPE_SETTINGS: Record<ConfigurableImportType, EffectiveTypeSetting> = {
  zbericht: { frequency: 'taeglich', delayDays: 0 },
  gaeste_bon: { frequency: 'taeglich', delayDays: 0 },
  mirus: { frequency: 'taeglich', delayDays: 2 }, // Mirus-Stunden liegen erfahrungsgemäss verzögert vor
  tagesabschluss: { frequency: 'taeglich', delayDays: 0 },
  marketing: { frequency: 'bei_bedarf', delayDays: 0 }, // nie mahnen
  reservationen: { frequency: 'woechentlich', delayDays: 0 }, // Foratable-Default: wöchentlich
  erfolgsrechnung: { frequency: 'monatlich', delayDays: 0 },
  warenrechnungen: { frequency: 'monatlich', delayDays: 0 },
  inventur: { frequency: 'monatlich', delayDays: 0 },
};

/** Default: keine Ruhetage (ISO-Wochentage 1=Mo … 7=So). */
export const DEFAULT_REST_WEEKDAYS: readonly number[] = [];

export const MAX_DELAY_DAYS = 14;

// ── Blob 1: Einstellungen ────────────────────────────────────────────────

export const IMPORT_SETTINGS_KEY = 'import_settings_v1';

/** Spezialschlüssel im Settings-Blob für die tenant-weiten Ruhetage. */
export const REST_DAYS_ENTRY_KEY = 'ruhetage';

export interface ImportSettingEntry {
  /** Nur bei Typ-Schlüsseln. */
  frequency?: ImportFrequencySetting;
  /** Nur bei Typ-Schlüsseln. */
  delayDays?: number;
  /** Nur beim Schlüssel `ruhetage` (ISO-Wochentage 1=Mo … 7=So). */
  restWeekdays?: number[];
  updatedAt: string; // ISO
  updatedBy?: string;
  deleted?: boolean;
}

export type ImportSettingsBlob = Record<string, ImportSettingEntry>;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFrequency(v: unknown): v is ImportFrequencySetting {
  return v === 'taeglich' || v === 'woechentlich' || v === 'monatlich' || v === 'bei_bedarf' || v === 'deaktiviert';
}

function normalizeRestWeekdays(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const days = raw
    .filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 7);
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Unbekannte/rohe Daten defensiv in die Blob-Struktur normalisieren. */
export function normalizeImportSettings(raw: unknown): ImportSettingsBlob {
  if (!isObj(raw)) return {};
  const out: ImportSettingsBlob = {};
  for (const [key, e] of Object.entries(raw)) {
    if (!isObj(e)) continue;
    if (typeof e.updatedAt !== 'string') continue;
    const isRestKey = key === REST_DAYS_ENTRY_KEY;
    if (!isRestKey && !isConfigurableImportType(key)) continue;

    const entry: ImportSettingEntry = { updatedAt: e.updatedAt };
    if (typeof e.updatedBy === 'string') entry.updatedBy = e.updatedBy;
    if (e.deleted === true) entry.deleted = true;

    if (isRestKey) {
      const days = normalizeRestWeekdays(e.restWeekdays);
      if (days !== null) entry.restWeekdays = days;
      else if (!entry.deleted) continue; // ohne gültige Tage nur als Tombstone sinnvoll
    } else {
      if (isFrequency(e.frequency)) entry.frequency = e.frequency;
      if (typeof e.delayDays === 'number' && Number.isFinite(e.delayDays)) {
        entry.delayDays = Math.min(MAX_DELAY_DAYS, Math.max(0, Math.floor(e.delayDays)));
      }
      if (entry.frequency === undefined && entry.delayDays === undefined && !entry.deleted) continue;
    }
    out[key] = entry;
  }
  return out;
}

/** Union-Merge zweier Blobs: je Schlüssel gewinnt der neuere Eintrag. */
export function mergeImportSettings(a: ImportSettingsBlob, b: ImportSettingsBlob): ImportSettingsBlob {
  const out: ImportSettingsBlob = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const ea = a[key];
    const eb = b[key];
    if (ea && eb) out[key] = eb.updatedAt > ea.updatedAt ? eb : ea;
    else out[key] = (ea ?? eb) as ImportSettingEntry;
  }
  return out;
}

export interface ApplySettingsResult {
  blob: ImportSettingsBlob;
  /** false = No-op (Dirty-Check): nichts geändert, NICHT schreiben. */
  changed: boolean;
}

/** Sichtbare (nicht-tombstoned) Einstellung eines Typs — null = Default aktiv. */
export function getVisibleTypeSetting(
  blob: ImportSettingsBlob,
  type: ConfigurableImportType,
): ImportSettingEntry | null {
  const e = blob[type];
  if (!e || e.deleted) return null;
  return e;
}

/**
 * Frequenz/Karenz eines Typs setzen (setting) oder auf Default zurücksetzen
 * (setting = null ⇒ Tombstone). Ungültige Frequenzen für den Typ werden
 * abgewiesen (No-op). Dirty-Check gegen den EFFEKTIVEN Ist-Zustand.
 */
export function applyImportTypeSetting(
  blob: ImportSettingsBlob,
  type: ConfigurableImportType,
  setting: { frequency: ImportFrequencySetting; delayDays: number } | null,
  nowIso: string,
  updatedBy?: string,
): ApplySettingsResult {
  const visible = getVisibleTypeSetting(blob, type);
  const effective = resolveTypeSetting(blob, type);

  if (setting === null) {
    if (visible === null) return { blob, changed: false };
    const entry: ImportSettingEntry = { updatedAt: nowIso, deleted: true };
    if (updatedBy) entry.updatedBy = updatedBy;
    return { blob: { ...blob, [type]: entry }, changed: true };
  }

  if (!allowedFrequencies(type).includes(setting.frequency)) return { blob, changed: false };
  const delayDays = Math.min(MAX_DELAY_DAYS, Math.max(0, Math.floor(setting.delayDays)));
  if (!Number.isFinite(delayDays)) return { blob, changed: false };

  if (effective.frequency === setting.frequency && effective.delayDays === delayDays) {
    return { blob, changed: false };
  }

  const entry: ImportSettingEntry = { frequency: setting.frequency, delayDays, updatedAt: nowIso };
  if (updatedBy) entry.updatedBy = updatedBy;
  return { blob: { ...blob, [type]: entry }, changed: true };
}

/** Tenant-weite Ruhetage setzen (Set-Gleichheit = No-op). Leeres Array ist gültig. */
export function applyRestWeekdays(
  blob: ImportSettingsBlob,
  days: readonly number[],
  nowIso: string,
  updatedBy?: string,
): ApplySettingsResult {
  const normalized = normalizeRestWeekdays([...days]) ?? [];
  const current = resolveRestWeekdays(blob);
  if (normalized.length === current.length && normalized.every((d, i) => d === current[i])) {
    return { blob, changed: false };
  }
  const entry: ImportSettingEntry = { restWeekdays: normalized, updatedAt: nowIso };
  if (updatedBy) entry.updatedBy = updatedBy;
  return { blob: { ...blob, [REST_DAYS_ENTRY_KEY]: entry }, changed: true };
}

// ── Effektive Einstellungen (Blob + Defaults) ────────────────────────────

export interface EffectiveImportSettings {
  types: Record<ConfigurableImportType, EffectiveTypeSetting>;
  /** ISO-Wochentage 1=Mo … 7=So ohne erwartete Tagesdaten (aufsteigend sortiert). */
  restWeekdays: readonly number[];
}

function resolveTypeSetting(blob: ImportSettingsBlob, type: ConfigurableImportType): EffectiveTypeSetting {
  const def = DEFAULT_TYPE_SETTINGS[type];
  const e = getVisibleTypeSetting(blob, type);
  if (!e) return def;
  const frequency =
    e.frequency !== undefined && allowedFrequencies(type).includes(e.frequency) ? e.frequency : def.frequency;
  const delayDays = e.delayDays !== undefined ? e.delayDays : def.delayDays;
  return { frequency, delayDays };
}

function resolveRestWeekdays(blob: ImportSettingsBlob): readonly number[] {
  const e = blob[REST_DAYS_ENTRY_KEY];
  if (!e || e.deleted || !e.restWeekdays) return DEFAULT_REST_WEEKDAYS;
  return e.restWeekdays;
}

/** Blob → vollständige effektive Einstellungen (fehlend/ungültig ⇒ Default). */
export function resolveImportSettings(blob: ImportSettingsBlob): EffectiveImportSettings {
  const types = {} as Record<ConfigurableImportType, EffectiveTypeSetting>;
  for (const type of CONFIGURABLE_IMPORT_TYPES) types[type] = resolveTypeSetting(blob, type);
  return { types, restWeekdays: resolveRestWeekdays(blob) };
}

/** Bequemer Default-Zustand (z. B. für Tests und als Lade-Fallback). */
export function defaultImportSettings(): EffectiveImportSettings {
  return resolveImportSettings({});
}

// ── Blob 2: Inventur-Monats-Häkchen ──────────────────────────────────────

export const INVENTUR_CHECKS_KEY = 'inventur_checks_v1';

export interface InventurCheckEntry {
  updatedAt: string; // ISO
  updatedBy?: string;
  deleted?: boolean;
}

/** 'YYYY-MM' → Häkchen (sichtbarer Eintrag = Inventur erledigt). */
export type InventurChecksBlob = Record<string, InventurCheckEntry>;

const RE_MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

export function normalizeInventurChecks(raw: unknown): InventurChecksBlob {
  if (!isObj(raw)) return {};
  const out: InventurChecksBlob = {};
  for (const [key, e] of Object.entries(raw)) {
    if (!RE_MONTH_KEY.test(key)) continue;
    if (!isObj(e) || typeof e.updatedAt !== 'string') continue;
    const entry: InventurCheckEntry = { updatedAt: e.updatedAt };
    if (typeof e.updatedBy === 'string') entry.updatedBy = e.updatedBy;
    if (e.deleted === true) entry.deleted = true;
    out[key] = entry;
  }
  return out;
}

export function mergeInventurChecks(a: InventurChecksBlob, b: InventurChecksBlob): InventurChecksBlob {
  const out: InventurChecksBlob = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const ea = a[key];
    const eb = b[key];
    if (ea && eb) out[key] = eb.updatedAt > ea.updatedAt ? eb : ea;
    else out[key] = (ea ?? eb) as InventurCheckEntry;
  }
  return out;
}

export function isInventurDone(blob: InventurChecksBlob, monthKey: string): boolean {
  const e = blob[monthKey];
  return !!e && !e.deleted;
}

export interface ApplyInventurResult {
  blob: InventurChecksBlob;
  changed: boolean;
}

/** Inventur-Häkchen setzen/entfernen mit Dirty-Check (entfernen = Tombstone). */
export function applyInventurCheck(
  blob: InventurChecksBlob,
  monthKey: string,
  done: boolean,
  nowIso: string,
  updatedBy?: string,
): ApplyInventurResult {
  if (!RE_MONTH_KEY.test(monthKey)) return { blob, changed: false };
  const current = isInventurDone(blob, monthKey);
  if (current === done) return { blob, changed: false };
  const entry: InventurCheckEntry = { updatedAt: nowIso };
  if (updatedBy) entry.updatedBy = updatedBy;
  if (!done) entry.deleted = true;
  return { blob: { ...blob, [monthKey]: entry }, changed: true };
}
