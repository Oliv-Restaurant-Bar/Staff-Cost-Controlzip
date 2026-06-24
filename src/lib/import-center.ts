/**
 * import-center.ts — Pure descriptor + status logic for the centralized Import Center.
 * ===================================================================================
 * NO React / supabase / DOM here. This module is the single source of truth for:
 *   - WHICH import categories exist and where each one lives (route vs. inline anchor)
 *   - WHO may see each category (canAccess predicate — mirrors the real route/page guard)
 *   - HOW a raw "last import" signal maps to a display status
 *
 * Tenant/permission posture: the visibility predicates take a minimal plain-object
 * ImportAccessContext so the logic stays trivially testable and decoupled from the
 * usePermissions hook. The Import-Center PAGE itself remains admin-only at runtime;
 * these predicates additionally hide cards a given role must not see (defense in depth).
 *
 * IMPORTANT (no invented timestamps): a status with no real signal returns
 * `lastImportedAt: null`. We never fabricate a date.
 */

export type ImportCategoryId =
  | 'foratable'
  | 'gastronovi'
  | 'produktumsaetze'
  | 'warenrechnungen'
  | 'wes'
  | 'erfolgsrechnung'
  | 'budget'
  | 'mitarbeitende'
  | 'vorjahreswerte';

/**
 * Minimal role context (subset of usePermissions) for card visibility.
 * NOTE: usePermissions().isAdmin is TRUE for guest sessions too, so `isGuest`
 * is carried separately and every predicate excludes guests explicitly.
 */
export interface ImportAccessContext {
  isAdmin: boolean;
  isGuest: boolean;
  isBeaulieuManager: boolean;
  isBeaulieuViewer: boolean;
}

/** Where the "last import" signal (if any) comes from. */
export type ImportStatusSource = 'import_runs' | 'gn_imports' | 'product_batches' | 'none';

export interface ImportCategory {
  id: ImportCategoryId;
  label: string;
  description: string;
  /** 'route' → navigate to `route`; 'inline' → scroll to `anchor` on the Import-Center page. */
  kind: 'route' | 'inline';
  /** Present for kind === 'route'. An existing app route (the card reuses it). */
  route?: string;
  /** Present for kind === 'inline'. An existing element id on the ImportHub page. */
  anchor?: string;
  statusSource: ImportStatusSource;
  /** Mirrors the real route/page guard. */
  canAccess: (ctx: ImportAccessContext) => boolean;
}

// Guests (isAdmin=true at the hook level) must NEVER see an import launcher → exclude first.
const adminOnly = (c: ImportAccessContext): boolean => c.isAdmin && !c.isGuest;
const adminOrBeaulieu = (c: ImportAccessContext): boolean =>
  !c.isGuest && (c.isAdmin || c.isBeaulieuManager);
// Warenrechnungen: mirrors canAccessModule('warenrechnungen') = admin | beaulieu_manager | beaulieu_viewer
const warenAccess = (c: ImportAccessContext): boolean =>
  !c.isGuest && (c.isAdmin || c.isBeaulieuManager || c.isBeaulieuViewer);

/**
 * The 9 import categories, in the order requested for the Import Center.
 * Routes/anchors below are verified against src/App.tsx and src/pages/ImportHub.tsx.
 */
export const IMPORT_CATEGORIES: ImportCategory[] = [
  {
    id: 'foratable',
    label: 'Foratable Import',
    description: 'Reservationen & Gästeexport (CRM) aus Foratable importieren.',
    kind: 'route',
    route: '/foratable-import',
    statusSource: 'import_runs',
    canAccess: adminOnly,
  },
  {
    id: 'gastronovi',
    label: 'Gastronovi Z-Bericht',
    description: 'Tages- und Perioden-Z-Berichte (Umsatz) aus Gastronovi importieren.',
    kind: 'route',
    route: '/gastronovi-import',
    statusSource: 'gn_imports',
    canAccess: adminOnly,
  },
  {
    id: 'produktumsaetze',
    label: 'Produktumsätze / Produktanalyse',
    description: 'Artikel-Verkaufsdaten (Anzahl & Umsatz) aus Gastronovi-CSV importieren.',
    kind: 'route',
    route: '/sales-upload',
    statusSource: 'product_batches',
    canAccess: adminOrBeaulieu,
  },
  {
    id: 'warenrechnungen',
    label: 'Warenrechnungen',
    description: 'Lieferanten-Rechnungen erfassen und Warenkosten importieren.',
    kind: 'route',
    route: '/warenrechnungen',
    statusSource: 'none',
    canAccess: warenAccess,
  },
  {
    id: 'wes',
    label: 'WES / Wareneinsatz',
    description: 'Wareneinsatz-Analyse und Bestandsdaten importieren.',
    kind: 'route',
    route: '/wes-analyse',
    statusSource: 'none',
    canAccess: adminOrBeaulieu,
  },
  {
    id: 'erfolgsrechnung',
    label: 'Erfolgsrechnung / Kontoblätter',
    description: 'Sage-Kontoblätter (Kosten) als CSV/PDF importieren.',
    kind: 'route',
    route: '/csv-import',
    statusSource: 'none',
    canAccess: adminOnly,
  },
  {
    id: 'budget',
    label: 'Budget',
    description: 'Jahresbudget erfassen und importieren.',
    kind: 'route',
    route: '/budget',
    statusSource: 'none',
    canAccess: adminOnly,
  },
  {
    id: 'mitarbeitende',
    label: 'Mitarbeitende / Mirus',
    description: 'Ist-Stunden und Mitarbeitende aus Mirus/CSV importieren.',
    kind: 'inline',
    anchor: 'ist-stunden',
    statusSource: 'none',
    // Inline section renders only for real admins on the Import-Center page → admin-only.
    canAccess: adminOnly,
  },
  {
    id: 'vorjahreswerte',
    label: 'Vorjahreswerte',
    description: 'Vorjahres-Umsatz und -Kosten für den P&L-Vergleich importieren.',
    kind: 'inline',
    anchor: 'umsatz-vorjahr',
    statusSource: 'none',
    // Inline section renders only for real admins on the Import-Center page → admin-only.
    canAccess: adminOnly,
  },
];

/** Categories the given role may see, in canonical order. */
export function visibleCategories(ctx: ImportAccessContext): ImportCategory[] {
  return IMPORT_CATEGORIES.filter((c) => c.canAccess(ctx));
}

export function getCategory(id: ImportCategoryId): ImportCategory | undefined {
  return IMPORT_CATEGORIES.find((c) => c.id === id);
}

// ─── Status ──────────────────────────────────────────────────────────────────

export type ImportStatusState =
  | 'none' // no import recorded yet (Nicht gestartet)
  | 'imported' // last import succeeded (Importiert)
  | 'attention' // last import failed / needs attention (Achtung)
  | 'unknown'; // no central log available for this type (Kein Protokoll)

export interface ImportStatus {
  state: ImportStatusState;
  /** ISO timestamp of the last import — NEVER invented; null when unknown. */
  lastImportedAt: string | null;
  /** Operator identifier of the last import, if available (only import_runs has it). */
  lastImportedBy: string | null;
  /** Optional human detail (e.g. failure note). */
  detail: string | null;
}

export const EMPTY_STATUS: ImportStatus = {
  state: 'none',
  lastImportedAt: null,
  lastImportedBy: null,
  detail: null,
};

export const UNKNOWN_STATUS: ImportStatus = {
  state: 'unknown',
  lastImportedAt: null,
  lastImportedBy: null,
  detail: null,
};

/** Shape of an import_runs row needed for status derivation. */
export interface RunLike {
  status: 'success' | 'failed';
  finished_at: string | null;
  created_at?: string | null;
  created_by: string | null;
  record_count?: number | null;
}

function runTimestamp(run: RunLike): string | null {
  return run.finished_at ?? run.created_at ?? null;
}

/** Map an import_runs row (or null) to a status. */
export function deriveStatusFromRun(run: RunLike | null): ImportStatus {
  if (!run) return EMPTY_STATUS;
  const ts = runTimestamp(run);
  if (run.status === 'failed') {
    return {
      state: 'attention',
      lastImportedAt: ts,
      lastImportedBy: run.created_by ?? null,
      detail: 'Letzter Import fehlgeschlagen',
    };
  }
  return { state: 'imported', lastImportedAt: ts, lastImportedBy: run.created_by ?? null, detail: null };
}

/** Map a bare "last imported at" timestamp to a status (no user info). */
export function deriveStatusFromTimestamp(ts: string | null, detail: string | null = null): ImportStatus {
  if (!ts) return EMPTY_STATUS;
  return { state: 'imported', lastImportedAt: ts, lastImportedBy: null, detail };
}

/** Pick the most-recently-finished run among several (e.g. reservations + guest_export). */
export function pickLatestRun(runs: Array<RunLike | null>): RunLike | null {
  let best: RunLike | null = null;
  let bestMs = -Infinity;
  for (const r of runs) {
    if (!r) continue;
    const ts = runTimestamp(r);
    const ms = ts ? Date.parse(ts) : NaN;
    const v = Number.isNaN(ms) ? -Infinity : ms;
    if (best === null || v > bestMs) {
      best = r;
      bestMs = v;
    }
  }
  return best;
}

export const STATUS_LABEL: Record<ImportStatusState, string> = {
  none: 'Nicht gestartet',
  imported: 'Importiert',
  attention: 'Achtung',
  unknown: 'Kein Protokoll',
};

export const STATUS_BADGE_CLASS: Record<ImportStatusState, string> = {
  none: 'bg-muted text-muted-foreground border-border',
  imported:
    'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  attention:
    'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  unknown: 'bg-muted text-muted-foreground border-border',
};
