/**
 * import-runs — gemeinsame, reine Logik für die Import-Historie
 * ============================================================
 * Beide Foratable-Importe (Reservationen + Gästeexport/CRM) protokollieren
 * jeden Lauf über DENSELBEN Mechanismus in der Tabelle `import_runs`.
 *
 * Dieses Modul ist BEWUSST frei von Supabase-/DOM-Abhängigkeiten (rein, gut
 * testbar). Die DB-Anbindung liegt in `import-runs-db.ts`.
 *
 * DATENSCHUTZ: Hier werden ausschliesslich Aggregat-Kennzahlen, Dateiname und
 * der Importtyp verarbeitet — KEINE personenbezogenen Gästedaten.
 */

export type ImportRunType = 'reservations' | 'guest_export';
export type ImportRunStatus = 'success' | 'failed';

/** Normalisierte Kennzahlen eines Importlaufs (in `stats_json` gespeichert). */
export interface ImportRunStats {
  /** Anzahl verarbeiteter Datensätze (Reservationen bzw. gelesene Zeilen). */
  recordCount?: number | null;
  /** Neu eingefügt. */
  inserted?: number | null;
  /** Aktualisiert / ersetzt. */
  updated?: number | null;
  /** Übersprungen / fehlerhaft. */
  skipped?: number | null;
  /** Innerhalb der CSV dedupliziert (gleiche Kennung mehrfach). */
  dedupedInCsv?: number | null;
  // ── Reservationen-spezifisch ──
  newGuests?: number | null;
  returningGuests?: number | null;
  // ── Gästeexport-spezifisch ──
  matchedGuests?: number | null;
  unassignable?: number | null;
  conflicts?: number | null;
}

/** Datenbankzeile (wie aus `import_runs` gelesen, bereits gemappt). */
export interface ImportRunRow {
  id: string;
  restaurant_id: string;
  import_type: ImportRunType;
  file_name: string | null;
  status: ImportRunStatus;
  record_count: number | null;
  period_from: string | null;
  period_to: string | null;
  error_message: string | null;
  stats_json: ImportRunStats | null;
  created_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
}

export const IMPORT_TYPE_LABEL: Record<ImportRunType, string> = {
  reservations: 'Reservationen',
  guest_export: 'Gästeexport',
};

export const IMPORT_STATUS_LABEL: Record<ImportRunStatus, string> = {
  success: 'Erfolgreich',
  failed: 'Fehlgeschlagen',
};

const IMPORT_TYPES: ImportRunType[] = ['reservations', 'guest_export'];

/** Unbekannte/fehlende Werte tolerant auf einen gültigen Typ abbilden. */
export function coerceImportType(value: unknown): ImportRunType {
  return value === 'guest_export' ? 'guest_export' : 'reservations';
}

export function coerceStatus(value: unknown): ImportRunStatus {
  return value === 'failed' ? 'failed' : 'success';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Kennzahlen eines Reservationen-Imports normalisieren. */
export function buildReservationRunStats(input: {
  reservationCount?: number | null;
  inserted?: number | null;
  updated?: number | null;
  duplicateKeyMerged?: number | null;
  skippedRows?: number | null;
  newGuests?: number | null;
  returningGuests?: number | null;
}): ImportRunStats {
  return {
    recordCount: num(input.reservationCount),
    inserted: num(input.inserted),
    updated: num(input.updated),
    skipped: num(input.skippedRows),
    dedupedInCsv: num(input.duplicateKeyMerged),
    newGuests: num(input.newGuests),
    returningGuests: num(input.returningGuests),
  };
}

/** Kennzahlen eines Gästeexport-Imports (CRM-Anreicherung) normalisieren. */
export function buildGuestRunStats(input: {
  rowsRead?: number | null;
  matchedGuests?: number | null;
  created?: number | null;
  updated?: number | null;
  conflicts?: number | null;
  unassignable?: number | null;
  errorRows?: number | null;
}): ImportRunStats {
  const unassignable = num(input.unassignable) ?? 0;
  const errorRows = num(input.errorRows) ?? 0;
  return {
    recordCount: num(input.rowsRead),
    inserted: num(input.created),
    updated: num(input.updated),
    // „übersprungen/fehlerhaft" = nicht zuordenbar + fehlerhafte Zeilen
    skipped: unassignable + errorRows,
    dedupedInCsv: null,
    matchedGuests: num(input.matchedGuests),
    unassignable: num(input.unassignable),
    conflicts: num(input.conflicts),
  };
}

/**
 * Letzten Lauf je Importtyp ermitteln. Sortiert intern nach `finished_at`
 * (bzw. `created_at`) absteigend, damit die Reihenfolge der Eingabe egal ist.
 */
export function latestRunByType(
  rows: ImportRunRow[],
): Record<ImportRunType, ImportRunRow | null> {
  const sorted = [...rows].sort((a, b) => runTime(b) - runTime(a));
  const out: Record<ImportRunType, ImportRunRow | null> = {
    reservations: null,
    guest_export: null,
  };
  for (const r of sorted) {
    if (out[r.import_type] == null) out[r.import_type] = r;
  }
  return out;
}

function runTime(r: ImportRunRow): number {
  const t = r.finished_at ?? r.created_at;
  const ms = t ? Date.parse(t) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** DB-Rohzeile defensiv in eine `ImportRunRow` überführen. */
export function rowToImportRun(raw: Record<string, unknown>): ImportRunRow {
  const stats = raw.stats_json;
  return {
    id: String(raw.id ?? ''),
    restaurant_id: String(raw.restaurant_id ?? ''),
    import_type: coerceImportType(raw.import_type),
    file_name: (raw.file_name as string | null) ?? null,
    status: coerceStatus(raw.status),
    record_count: num(raw.record_count),
    period_from: (raw.period_from as string | null) ?? null,
    period_to: (raw.period_to as string | null) ?? null,
    error_message: (raw.error_message as string | null) ?? null,
    stats_json: stats && typeof stats === 'object' ? (stats as ImportRunStats) : null,
    created_by: (raw.created_by as string | null) ?? null,
    started_at: (raw.started_at as string | null) ?? null,
    finished_at: (raw.finished_at as string | null) ?? null,
    created_at: (raw.created_at as string | null) ?? null,
  };
}

/**
 * Kompakte Kennzahlen-Liste für die Anzeige einer Verlaufszeile.
 * Liefert nur belegte (nicht-null) Werte, in sinnvoller Reihenfolge.
 */
export function runStatChips(row: ImportRunRow): Array<{ label: string; value: number }> {
  const s = row.stats_json;
  if (!s) return [];
  const chips: Array<{ label: string; value: number }> = [];
  const push = (label: string, v: number | null | undefined) => {
    if (typeof v === 'number') chips.push({ label, value: v });
  };
  if (row.import_type === 'reservations') {
    push('neu', s.inserted);
    push('aktualisiert', s.updated);
    push('übersprungen', s.skipped);
    push('CSV-Doppel', s.dedupedInCsv);
    push('neue Gäste', s.newGuests);
    push('wiederk.', s.returningGuests);
  } else {
    push('gematcht', s.matchedGuests);
    push('neu', s.inserted);
    push('ergänzt', s.updated);
    push('Konflikte', s.conflicts);
    push('nicht zugeordnet', s.unassignable);
  }
  return chips;
}

export { IMPORT_TYPES };
