/**
 * op-liste — Datenmodell des Kreditoren-OP-Listen-Tools (Phase 1).
 * ─────────────────────────────────────────────────────────────────────────────
 * Quelle: PDF "Offene Posten mit Fälligkeiten Kreditoren" (Sage-artig).
 * Persistenz: Supabase `creditor_op_imports` / `creditor_op_items`
 * (Migration supabase/migrations/20260708_creditor_op.sql).
 * KEINE personenbezogenen Daten — nur Firmen-/Behördennamen und Beträge.
 */

/** Fälligkeits-Buckets aus dem PDF (null = im PDF nicht zuordenbar). */
export interface OpBuckets {
  /** „über 29 Tage" — am längsten überfällig */
  overdue29Plus: number | null;
  /** „seit 29 Tagen" — überfällig */
  overdueSince29: number | null;
  /** „seit 14 Tagen" — überfällig */
  overdueSince14: number | null;
  /** „in 15 Tagen" — fällig in ≤15 Tagen */
  dueIn15: number | null;
  /** „in 30 Tagen" — fällig in ≤30 Tagen */
  dueIn30: number | null;
  /** „nach 30 Tagen" — fällig in >30 Tagen */
  dueAfter30: number | null;
}

export const EMPTY_BUCKETS: OpBuckets = {
  overdue29Plus: null,
  overdueSince29: null,
  overdueSince14: null,
  dueIn15: null,
  dueIn30: null,
  dueAfter30: null,
};

export const BUCKET_KEYS = [
  'overdue29Plus', 'overdueSince29', 'overdueSince14',
  'dueIn15', 'dueIn30', 'dueAfter30',
] as const;
export type BucketKey = (typeof BUCKET_KEYS)[number];

export const BUCKET_LABELS: Record<BucketKey, string> = {
  overdue29Plus: 'über 29 Tage',
  overdueSince29: 'seit 29 Tagen',
  overdueSince14: 'seit 14 Tagen',
  dueIn15: 'in 15 Tagen',
  dueIn30: 'in 30 Tagen',
  dueAfter30: 'nach 30 Tagen',
};

/** Einzelner offener Posten (geparst aus dem PDF). */
export interface OpItemParsed {
  /** OP-Datum (ISO yyyy-mm-dd) oder null wenn nicht erkennbar */
  opDate: string | null;
  opNumber: string | null;
  invoiceText: string | null;
  /** Spalte „Offen" */
  openAmount: number;
  buckets: OpBuckets;
}

/** Lieferantenblock (geparst). */
export interface OpSupplierParsed {
  name: string;
  items: OpItemParsed[];
  /** Lieferanten-Total lt. PDF (null wenn keine Total-Zeile erkannt) */
  total: number | null;
  /** Summe der Einzelposten (berechnet) */
  itemsSum: number;
  buckets: OpBuckets;
}

/** Gesamt-Totale lt. PDF. */
export interface OpTotalsParsed {
  openAmount: number | null;
  itemCount: number | null;
  accountCount: number | null;
  buckets: OpBuckets;
}

export interface OpParseDebug {
  lineCount: number;
  headerFound: boolean;
  calibratedColumns: string[];
  supplierCount: number;
  itemCount: number;
  sampleLines: string[];
  unparsedLines: string[];
}

/** Ergebnis des reinen Parsers (debug + failureReason auf ALLEN Pfaden). */
export interface OpListeParseResult {
  success: boolean;
  failureReason?: string;
  /** OP-Stichdatum (ISO yyyy-mm-dd) */
  snapshotDate: string | null;
  snapshotTime: string | null;
  suppliers: OpSupplierParsed[];
  totals: OpTotalsParsed;
  /** Summe aller Einzelposten (berechnet, für Plausibilisierung) */
  itemsSum: number;
  warnings: string[];
  debug: OpParseDebug;
}

// ── Persistenz (Supabase-Zeilen, camelCase) ──────────────────────────────────

export type OpImportStatus = 'processing' | 'active' | 'replaced' | 'deleted';

export interface OpImportRecord {
  id: string;
  restaurantId: string;
  snapshotDate: string; // ISO
  importedAt: string | null;
  sourceFilename: string | null;
  totalOpenAmount: number | null;
  totalItems: number | null;
  supplierCount: number | null;
  status: OpImportStatus;
  rawTotals: OpTotalsParsed | null;
}

export interface OpItemRecord {
  id: string;
  importId: string;
  restaurantId: string;
  supplierName: string;
  opDate: string | null;
  opNumber: string | null;
  invoiceText: string | null;
  openAmount: number;
  buckets: OpBuckets;
}
