/**
 * op-liste-compare — reine Vergleichs- und Aggregationslogik für OP-Listen.
 * ─────────────────────────────────────────────────────────────────────────────
 * REIN: kein DOM, kein Supabase — arbeitet auf minimalen Item-Shapes
 * (strukturkompatibel zu OpItemRecord aus @/types/op-liste).
 *
 * Vergleich zweier Stichtage:
 *   - Lieferanten-Matching über normalisierten Namen (Konto-Nr.-Präfix entfernt,
 *     Kleinschreibung, Whitespace kollabiert).
 *   - Status: neu / gestiegen / gesunken / unveraendert / erledigt.
 *   - Sortierung: höchste ERHÖHUNG zuerst (Liquiditätssicht), dann Betrag.
 *
 * Behörden & Sozialabgaben: festes Mapping per Namensmuster
 * (MWST / QST / AHV / BVG) — Matching tolerant via includes-Regex.
 */

import type { OpBuckets } from '@/types/op-liste';
import { BUCKET_KEYS, EMPTY_BUCKETS } from '@/types/op-liste';

/** Minimaler Item-Shape (kompatibel zu OpItemRecord und OpItemParsed+Name). */
export interface OpCompareItem {
  supplierName: string;
  openAmount: number;
  buckets?: Partial<OpBuckets> | null;
}

const EPS = 0.005;

// ── Namens-Normalisierung / Aggregation ──────────────────────────────────────

/** Matching-Key: Konto-Nr.-Präfix weg, klein, Whitespace kollabiert. */
export function normalizeSupplierName(name: string): string {
  return name
    .replace(/^\d{3,8}\s+/, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface OpSupplierAgg {
  /** Anzeigename (erste vorkommende Schreibweise) */
  name: string;
  matchKey: string;
  amount: number;
  itemCount: number;
  /** Überfällig = Summe der 3 „seit/über"-Buckets; null wenn keine Bucket-Daten */
  overdueAmount: number | null;
}

const OVERDUE_KEYS = ['overdue29Plus', 'overdueSince29', 'overdueSince14'] as const;

function itemOverdue(item: OpCompareItem): number | null {
  const b = item.buckets;
  if (!b) return null;
  let any = false;
  let sum = 0;
  for (const k of OVERDUE_KEYS) {
    const v = b[k];
    if (v !== null && v !== undefined) { any = true; sum += v; }
  }
  return any ? sum : null;
}

/** Aggregiert Posten je Lieferant (Matching über normalisierten Namen). */
export function aggregateSuppliers(items: OpCompareItem[]): OpSupplierAgg[] {
  const map = new Map<string, OpSupplierAgg>();
  for (const it of items) {
    const key = normalizeSupplierName(it.supplierName);
    if (!key) continue;
    let agg = map.get(key);
    if (!agg) {
      agg = { name: it.supplierName, matchKey: key, amount: 0, itemCount: 0, overdueAmount: null };
      map.set(key, agg);
    }
    agg.amount = round2(agg.amount + it.openAmount);
    agg.itemCount += 1;
    const ov = itemOverdue(it);
    if (ov !== null) agg.overdueAmount = round2((agg.overdueAmount ?? 0) + ov);
  }
  return Array.from(map.values()).sort((a, b) => b.amount - a.amount);
}

/** Top-N Lieferanten nach offenem Betrag. */
export function topSuppliers(items: OpCompareItem[], n: number): OpSupplierAgg[] {
  return aggregateSuppliers(items).slice(0, n);
}

/** Bucket-Summen über alle Posten (null je Bucket, wenn nirgends Daten). */
export function sumBuckets(items: OpCompareItem[]): OpBuckets {
  const out: OpBuckets = { ...EMPTY_BUCKETS };
  for (const it of items) {
    const b = it.buckets;
    if (!b) continue;
    for (const k of BUCKET_KEYS) {
      const v = b[k];
      if (v !== null && v !== undefined) out[k] = round2((out[k] ?? 0) + v);
    }
  }
  return out;
}

export interface OpSnapshotSummary {
  totalOpen: number;
  itemCount: number;
  supplierCount: number;
  /** null, wenn keine Bucket-Daten vorhanden */
  overdueAmount: number | null;
  buckets: OpBuckets;
}

/** Kennzahlen eines Stichtags aus den Einzelposten. */
export function summarizeSnapshot(items: OpCompareItem[]): OpSnapshotSummary {
  const aggs = aggregateSuppliers(items);
  const buckets = sumBuckets(items);
  let overdue: number | null = null;
  for (const k of OVERDUE_KEYS) {
    const v = buckets[k];
    if (v !== null) overdue = round2((overdue ?? 0) + v);
  }
  return {
    totalOpen: round2(items.reduce((s, it) => s + it.openAmount, 0)),
    itemCount: items.length,
    supplierCount: aggs.length,
    overdueAmount: overdue,
    buckets,
  };
}

// ── Vergleich zweier Stichtage ───────────────────────────────────────────────

export type OpCompareStatus = 'neu' | 'gestiegen' | 'gesunken' | 'unveraendert' | 'erledigt';

export const COMPARE_STATUS_LABELS: Record<OpCompareStatus, string> = {
  neu: 'Neu',
  gestiegen: 'Gestiegen',
  gesunken: 'Gesunken',
  unveraendert: 'Unverändert',
  erledigt: 'Erledigt',
};

export interface OpCompareRow {
  name: string;
  matchKey: string;
  before: number | null;
  after: number | null;
  diff: number;
  status: OpCompareStatus;
}

export interface OpCompareKpi {
  before: number | null;
  after: number | null;
  diff: number | null;
}

export interface OpCompareResult {
  rows: OpCompareRow[];
  totalOpen: OpCompareKpi;
  itemCount: OpCompareKpi;
  supplierCount: OpCompareKpi;
  overdueAmount: OpCompareKpi;
}

function statusFor(before: number | null, after: number | null): OpCompareStatus {
  const b = before ?? 0;
  const a = after ?? 0;
  if (before === null) return 'neu';
  if (after === null || Math.abs(a) <= EPS) {
    return Math.abs(b) <= EPS ? 'unveraendert' : 'erledigt';
  }
  const diff = a - b;
  if (Math.abs(diff) <= EPS) return 'unveraendert';
  return diff > 0 ? 'gestiegen' : 'gesunken';
}

/**
 * Vergleicht zwei Stichtage auf Basis der Einzelposten.
 * Sortierung: grösste Erhöhung zuerst (kritisch für Liquidität), dann |Betrag|.
 */
export function compareSnapshots(beforeItems: OpCompareItem[], afterItems: OpCompareItem[]): OpCompareResult {
  const beforeAgg = aggregateSuppliers(beforeItems);
  const afterAgg = aggregateSuppliers(afterItems);
  const beforeMap = new Map(beforeAgg.map(a => [a.matchKey, a]));
  const afterMap = new Map(afterAgg.map(a => [a.matchKey, a]));

  const keys = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  const rows: OpCompareRow[] = [];
  for (const key of keys) {
    const b = beforeMap.get(key) ?? null;
    const a = afterMap.get(key) ?? null;
    const before = b ? b.amount : null;
    const after = a ? a.amount : null;
    rows.push({
      name: (a ?? b)!.name,
      matchKey: key,
      before,
      after,
      diff: round2((after ?? 0) - (before ?? 0)),
      status: statusFor(before, after),
    });
  }
  rows.sort((r1, r2) => (r2.diff - r1.diff) || (Math.abs(r2.after ?? 0) - Math.abs(r1.after ?? 0)));

  const sb = summarizeSnapshot(beforeItems);
  const sa = summarizeSnapshot(afterItems);
  const kpi = (before: number | null, after: number | null): OpCompareKpi => ({
    before,
    after,
    diff: before !== null && after !== null ? round2(after - before) : null,
  });
  return {
    rows,
    totalOpen: kpi(sb.totalOpen, sa.totalOpen),
    itemCount: kpi(sb.itemCount, sa.itemCount),
    supplierCount: kpi(sb.supplierCount, sa.supplierCount),
    overdueAmount: kpi(sb.overdueAmount, sa.overdueAmount),
  };
}

// ── Behörden & Sozialabgaben ─────────────────────────────────────────────────

export interface AuthorityGroup {
  key: 'MWST' | 'QST' | 'AHV' | 'BVG';
  label: string;
  pattern: RegExp;
}

export const AUTHORITY_GROUPS: AuthorityGroup[] = [
  { key: 'MWST', label: 'MWST — Eidg. Steuerverwaltung', pattern: /eidgen(ö|oe|o)ssische\s+steuerverwaltung/i },
  { key: 'QST', label: 'QST — Steuerverwaltung Kt. Bern', pattern: /steuerverwaltung\s+des\s+kantons\s+bern/i },
  { key: 'AHV', label: 'AHV — GastroSocial Ausgleichskasse', pattern: /gastrosocial\s+ausgleichskasse/i },
  { key: 'BVG', label: 'BVG — GastroSocial Pensionskasse', pattern: /gastrosocial\s+pensionskasse/i },
];

export interface AuthoritySummaryRow {
  key: AuthorityGroup['key'];
  label: string;
  before: number | null;
  after: number | null;
  diff: number;
}

function authorityAmount(items: OpCompareItem[], group: AuthorityGroup): number | null {
  let found = false;
  let sum = 0;
  for (const agg of aggregateSuppliers(items)) {
    if (group.pattern.test(agg.name) || group.pattern.test(agg.matchKey)) {
      found = true;
      sum += agg.amount;
    }
  }
  return found ? round2(sum) : null;
}

/** Behörden-/Sozialabgaben-Karte: MWST/QST/AHV/BVG je Stichtag + Veränderung. */
export function buildAuthoritySummary(
  beforeItems: OpCompareItem[],
  afterItems: OpCompareItem[],
): AuthoritySummaryRow[] {
  return AUTHORITY_GROUPS.map(g => {
    const before = authorityAmount(beforeItems, g);
    const after = authorityAmount(afterItems, g);
    return { key: g.key, label: g.label, before, after, diff: round2((after ?? 0) - (before ?? 0)) };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
