/**
 * kpi-targets.ts — Eigene Zielwerte pro Management-KPI (REINE LOGIK).
 * ===================================================================
 * Blob-Struktur (tenant-präfixierter KV-/localStorage-Schlüssel
 * `kpi_targets_v1`):
 *   { kpiId: { value, updatedAt, updatedBy?, deleted? } }
 *
 * Zielwerte sind MONATSUNABHÄNGIG (ein Zielwert je KPI, z. B. «Warenquote
 * ≤ 29 %») und wirken NUR auf die Ampel der Startseiten-KPIs — bewusste,
 * dokumentierte Ausnahme zur Regel «Ampeln nur über bestehende Ton-Helfer»:
 * ein explizit vom User gesetzter Zielwert ersetzt für DIESE KPI die
 * Standard-Ampel (getKpiToneWithTarget in kpi-catalog). Die Personalquote
 * ist AUSGESCHLOSSEN — ihr Ziel wird weiterhin zentral im Budget gepflegt
 * (EINE Definition appweit, KPI_TARGET_EXCLUDED).
 *
 * Persistenz-Regeln (§2 replit.md, kv-persistence-rules):
 *  - Union-Merge newer-wins je KPI (updatedAt entscheidet).
 *  - Löschen = Tombstone (deleted + updatedAt-Bump), NIE Hard-Delete —
 *    sonst Wiederauferstehung aus dem Remote-KV. Alle Leser filtern deleted.
 *  - Dirty-Check: identischer Zielwert ⇒ No-op (kein Write, kein
 *    updatedAt-Bump). Reines Laden schreibt NIE.
 * Dieses Modul ist DOM- und Supabase-frei; IO liegt in kpi-targets-db.ts.
 */

export interface KpiTarget {
  value: number;
  updatedAt: string; // ISO
  updatedBy?: string;
  deleted?: boolean;
}

/** kpiId → Zielwert (Rohwert in der Einheit der KPI: CHF, %, Anzahl …). */
export type KpiTargetsBlob = Record<string, KpiTarget>;

export const KPI_TARGETS_KEY = 'kpi_targets_v1';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Unbekannte/rohe Daten defensiv in die Blob-Struktur normalisieren. */
export function normalizeKpiTargets(raw: unknown): KpiTargetsBlob {
  if (!isObj(raw)) return {};
  const out: KpiTargetsBlob = {};
  for (const [kpiId, t] of Object.entries(raw)) {
    if (!isObj(t)) continue;
    if (typeof t.value !== 'number' || !Number.isFinite(t.value)) continue;
    if (typeof t.updatedAt !== 'string') continue;
    const entry: KpiTarget = { value: t.value, updatedAt: t.updatedAt };
    if (typeof t.updatedBy === 'string') entry.updatedBy = t.updatedBy;
    if (t.deleted === true) entry.deleted = true;
    out[kpiId] = entry;
  }
  return out;
}

/**
 * Union-Merge zweier Blobs: je KPI gewinnt der neuere Eintrag
 * (updatedAt, ISO-String-Vergleich). Tombstones nehmen am Merge normal teil.
 */
export function mergeKpiTargets(a: KpiTargetsBlob, b: KpiTargetsBlob): KpiTargetsBlob {
  const out: KpiTargetsBlob = {};
  const kpiIds = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const kpiId of kpiIds) {
    const ta = a[kpiId];
    const tb = b[kpiId];
    if (ta && tb) out[kpiId] = tb.updatedAt > ta.updatedAt ? tb : ta;
    else out[kpiId] = (ta ?? tb) as KpiTarget;
  }
  return out;
}

export interface ApplyTargetResult {
  blob: KpiTargetsBlob;
  /** false = No-op (Dirty-Check): nichts geändert, NICHT schreiben. */
  changed: boolean;
}

/**
 * Zielwert setzen/ändern/löschen mit Dirty-Check.
 *  - value null ⇒ Tombstone (falls ein sichtbarer Eintrag existiert).
 *  - identischer sichtbarer Wert ⇒ No-op (kein updatedAt-Bump).
 *  - nicht-finite Werte werden abgewiesen (No-op).
 */
export function applyKpiTarget(
  blob: KpiTargetsBlob,
  kpiId: string,
  value: number | null,
  nowIso: string,
  updatedBy?: string,
): ApplyTargetResult {
  const existing = blob[kpiId];
  const visibleValue = existing && !existing.deleted ? existing.value : null;

  if (value === null) {
    // Löschen: nur wenn ein sichtbarer Eintrag existiert (sonst No-op).
    if (visibleValue === null) return { blob, changed: false };
    const entry: KpiTarget = { value: 0, updatedAt: nowIso, deleted: true };
    if (updatedBy) entry.updatedBy = updatedBy;
    return { blob: { ...blob, [kpiId]: entry }, changed: true };
  }

  if (!Number.isFinite(value)) return { blob, changed: false };
  if (visibleValue === value) return { blob, changed: false };

  const entry: KpiTarget = { value, updatedAt: nowIso };
  if (updatedBy) entry.updatedBy = updatedBy;
  return { blob: { ...blob, [kpiId]: entry }, changed: true };
}

/** Sichtbarer Zielwert (Tombstones gefiltert) — null = keiner gesetzt. */
export function getVisibleKpiTarget(blob: KpiTargetsBlob, kpiId: string): KpiTarget | null {
  const t = blob[kpiId];
  if (!t || t.deleted) return null;
  return t;
}
