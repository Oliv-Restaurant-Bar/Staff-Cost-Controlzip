/**
 * waren-analyse.ts — pure Analyse-Helfer für Warenrechnungen (kein IO).
 * =====================================================================
 * Gruppierungen (Lieferant/Konto/Woche/Monat), Top-Einzelrechnungen und
 * Anomalie-Erkennung (> Faktor × eigener Schnitt der Vorwochen; Woche über
 * Ziel-WKQ). Basis: erfasste InvoiceEntry (NETTO-Beträge).
 */

import type { InvoiceEntry, Warenkonto } from './waren-db';
import { kategorieOf } from './warenkosten-quote';

export type AnalyseDim = 'supplier' | 'konto' | 'week' | 'month';

export interface AnalyseGroupRow {
  key: string;
  label: string;
  totalNet: number;
  count: number;
  /** true = deutlich über dem eigenen Schnitt der Vorwochen (Anomalie, rot). */
  flagged: boolean;
  /**
   * Abweichung der letzten Periode gegenüber dem eigenen Schnitt in Prozent
   * (z.B. 42 = «+42 % über Schnitt»); null wenn kein Schnitt berechenbar.
   */
  deltaPct: number | null;
}

/** Anomalie-Schwelle: > +30 % gegenüber dem eigenen Vorwochen-Schnitt. */
export const ANOMALIE_FAKTOR = 1.3;
/** Mindestanzahl Vorwochen mit Daten, damit ein Schnitt aussagekräftig ist. */
export const ANOMALIE_MIN_VORWOCHEN = 2;

// ─── ISO-Woche ────────────────────────────────────────────────────────────────

/** ISO-Wochen-Schlüssel 'GJJJ-Wnn' (ISO-Wochenjahr!) für ein ISO-Datum. */
export function isoWeekKeyOf(dateIso: string): string {
  const d = new Date(dateIso + 'T12:00:00Z');
  const day = (d.getUTCDay() + 6) % 7; // Mo=0
  d.setUTCDate(d.getUTCDate() - day + 3); // Donnerstag der Woche
  const isoYear = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** Anzeige-Label 'KW nn' aus einem Wochen-Schlüssel 'GJJJ-Wnn'. */
export function weekLabelOf(weekKey: string): string {
  return `KW ${Number(weekKey.slice(-2))}`;
}

// ─── Zuordnung Rechnung → Dimension ──────────────────────────────────────────

const OHNE_KONTO = '—';

/** Netto-Anteile einer Rechnung je Warenkonto (Split zählt pro Konto). */
export function kontoShares(e: InvoiceEntry): { konto: string; net: number }[] {
  if (e.kontoSplits && e.kontoSplits.length > 0) {
    return e.kontoSplits.map(s => ({ konto: s.warenkonto || OHNE_KONTO, net: s.amountNet }));
  }
  return [{ konto: e.warenkonto || OHNE_KONTO, net: e.amountNet }];
}

export function supplierKeyOf(e: InvoiceEntry): string {
  return e.supplierName.trim() || OHNE_KONTO;
}

// ─── Gruppierungen ────────────────────────────────────────────────────────────

/**
 * Summen je Dimension, absteigend nach Betrag (Top zuerst) — ausser
 * Woche/Monat: chronologisch. `flagged` wird hier noch nicht gesetzt
 * (siehe flagAnomalies).
 */
export function groupTotals(
  entries: InvoiceEntry[],
  dim: AnalyseDim,
  konten?: Warenkonto[],
): AnalyseGroupRow[] {
  const map = new Map<string, { totalNet: number; count: number }>();
  const add = (key: string, net: number) => {
    const cur = map.get(key) ?? { totalNet: 0, count: 0 };
    cur.totalNet += net;
    cur.count += 1;
    map.set(key, cur);
  };
  for (const e of entries) {
    if (dim === 'supplier') add(supplierKeyOf(e), e.amountNet);
    else if (dim === 'konto') for (const s of kontoShares(e)) add(s.konto, s.net);
    else if (dim === 'week') add(isoWeekKeyOf(e.date), e.amountNet);
    else add(e.date.slice(0, 7), e.amountNet);
  }
  const kontoLabel = (v: string): string =>
    konten?.find(k => k.value === v)?.label ?? (v === OHNE_KONTO ? 'Ohne Konto' : v);
  const rows: AnalyseGroupRow[] = [...map.entries()].map(([key, v]) => ({
    key,
    label: dim === 'konto' ? kontoLabel(key) : dim === 'week' ? weekLabelOf(key) : key,
    totalNet: Math.round(v.totalNet * 100) / 100,
    count: v.count,
    flagged: false,
    deltaPct: null,
  }));
  if (dim === 'week' || dim === 'month') rows.sort((a, b) => a.key.localeCompare(b.key));
  else rows.sort((a, b) => b.totalNet - a.totalNet);
  return rows;
}

/** Grösste Einzelrechnungen (netto) des Zeitraums, Top zuerst. */
export function topInvoices(entries: InvoiceEntry[], n = 10): InvoiceEntry[] {
  return [...entries].sort((a, b) => b.amountNet - a.amountNet).slice(0, n);
}

// ─── Anomalie-Erkennung ───────────────────────────────────────────────────────

/**
 * Wochen-Totale je Entität (Lieferant/Konto) bzw. gesamthaft ('*' bei week).
 * Rückgabe: Map<entityKey, Map<weekKey, totalNet>>.
 */
function perWeekTotals(entries: InvoiceEntry[], dim: AnalyseDim): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const add = (entity: string, week: string, net: number) => {
    const m = out.get(entity) ?? new Map<string, number>();
    m.set(week, (m.get(week) ?? 0) + net);
    out.set(entity, m);
  };
  for (const e of entries) {
    const wk = isoWeekKeyOf(e.date);
    if (dim === 'konto') for (const s of kontoShares(e)) add(s.konto, wk, s.net);
    else if (dim === 'supplier') add(supplierKeyOf(e), wk, e.amountNet);
    else add('*', wk, e.amountNet);
  }
  return out;
}

/**
 * Markiert Zeilen, deren Kosten deutlich über dem eigenen Schnitt liegen:
 * - supplier/konto: letzte Woche mit Daten > Faktor × Schnitt der Vorwochen
 *   (mind. ANOMALIE_MIN_VORWOCHEN Vorwochen mit Daten).
 * - week: Wochen-Total > Faktor × Schnitt aller früheren Wochen im Zeitraum.
 * - month: keine Markierung (zu wenig Vergleichsbasis auf Monatsebene).
 * Gibt die MUTIERTE rows-Liste zurück (flagged gesetzt).
 */
export function flagAnomalies(
  rows: AnalyseGroupRow[],
  entries: InvoiceEntry[],
  dim: AnalyseDim,
  faktor: number = ANOMALIE_FAKTOR,
): AnalyseGroupRow[] {
  if (dim === 'month') return rows;
  const weekly = perWeekTotals(entries, dim);
  if (dim === 'week') {
    const series = [...(weekly.get('*') ?? new Map<string, number>()).entries()]
      .sort((a, b) => a[0].localeCompare(b[0]));
    for (const row of rows) {
      const idx = series.findIndex(([wk]) => wk === row.key);
      const prev = series.slice(0, idx).map(([, t]) => t);
      if (prev.length >= ANOMALIE_MIN_VORWOCHEN) {
        const avg = prev.reduce((s, t) => s + t, 0) / prev.length;
        if (avg > 0) {
          row.deltaPct = Math.round(((row.totalNet / avg) - 1) * 100);
          row.flagged = row.totalNet > avg * faktor;
        }
      }
    }
    return rows;
  }
  for (const row of rows) {
    const m = weekly.get(row.key);
    if (!m) continue;
    const series = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (series.length < ANOMALIE_MIN_VORWOCHEN + 1) continue;
    const last = series[series.length - 1][1];
    const prev = series.slice(0, -1).map(([, t]) => t);
    const avg = prev.reduce((s, t) => s + t, 0) / prev.length;
    if (avg > 0) {
      row.deltaPct = Math.round(((last / avg) - 1) * 100);
      row.flagged = last > avg * faktor;
    }
  }
  return rows;
}

// ─── WKQ je Woche ─────────────────────────────────────────────────────────────

export interface WochenWkqRow {
  weekKey: string;
  label: string;
  warenNet: number;
  umsatzNet: number | null; // null = kein Umsatz erfasst → keine WKQ
  wkqPct: number | null;
  /** 'red' über Ziel, 'green' unter/gleich Ziel, null ohne WKQ. */
  ampel: 'green' | 'red' | null;
}

/**
 * WKQ je ISO-Woche: Warenkosten (netto) ÷ Netto-Umsatz derselben Woche.
 * revenueByDate: ISO-Datum → Netto-Umsatz. Wochen ohne Umsatz → wkq null.
 */
export function wochenWkq(
  entries: InvoiceEntry[],
  revenueByDate: Record<string, number>,
  zielPct: number,
): WochenWkqRow[] {
  const waren = new Map<string, number>();
  for (const e of entries) {
    const wk = isoWeekKeyOf(e.date);
    waren.set(wk, (waren.get(wk) ?? 0) + e.amountNet);
  }
  const umsatz = new Map<string, number>();
  for (const [date, rev] of Object.entries(revenueByDate)) {
    if (!Number.isFinite(rev) || rev <= 0) continue;
    const wk = isoWeekKeyOf(date);
    umsatz.set(wk, (umsatz.get(wk) ?? 0) + rev);
  }
  return [...waren.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekKey, warenNet]) => {
      const u = umsatz.get(weekKey) ?? null;
      const wkq = u !== null && u > 0 ? Math.round((warenNet / u) * 1000) / 10 : null;
      return {
        weekKey,
        label: weekLabelOf(weekKey),
        warenNet: Math.round(warenNet * 100) / 100,
        umsatzNet: u,
        wkqPct: wkq,
        ampel: wkq === null ? null : wkq > zielPct ? 'red' : 'green',
      };
    });
}

// ─── Kennzahlen-Kopf ─────────────────────────────────────────────────────────

export interface AnalyseKpis {
  totalNet: number;
  foodNet: number;
  beverageNet: number;
  /** Anteil Food/Beverage am Total in % (null wenn Total 0). */
  foodSharePct: number | null;
  beverageSharePct: number | null;
  top3: { label: string; totalNet: number }[];
}

export function analyseKpis(entries: InvoiceEntry[]): AnalyseKpis {
  let total = 0, food = 0, bev = 0;
  for (const e of entries) {
    total += e.amountNet;
    // Effektive Kategorie (Konto autoritativ) statt roher gespeicherter
    // e.kategorie — sonst weichen Analyse-Food/Bev von der WKQ-Basis ab.
    const kat = kategorieOf(e);
    if (kat === 'Food') food += e.amountNet;
    else if (kat === 'Beverage') bev += e.amountNet;
  }
  const top3 = groupTotals(entries, 'supplier').slice(0, 3)
    .map(r => ({ label: r.key, totalNet: r.totalNet }));
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    totalNet: r2(total), foodNet: r2(food), beverageNet: r2(bev),
    foodSharePct: total > 0 ? Math.round((food / total) * 1000) / 10 : null,
    beverageSharePct: total > 0 ? Math.round((bev / total) * 1000) / 10 : null,
    top3,
  };
}
