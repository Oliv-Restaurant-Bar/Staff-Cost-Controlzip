/**
 * waren-cockpit.ts — pure Aggregations-Helfer für den Cockpit-Warenkosten-Block.
 * ==============================================================================
 * Basis: erfasste Warenrechnungen (waren-db InvoiceEntry, NETTO-Beträge).
 * - Total Warenkosten (CHF netto) im Zeitraum
 * - Warenkostenquote (WKQ) = Warenkosten ÷ Netto-Umsatz
 * - Aufteilung nach Lieferant (Betrag, Anteil %, Anzahl Rechnungen), Top zuerst
 *
 * Kontroll-Total aus der Buchhaltung (pl-engine total_cogs) wird vom Aufrufer
 * geliefert — hier nur Zahlenlogik, keine IO.
 */

import type { InvoiceEntry } from './waren-db';

export interface SupplierAggRow {
  supplierName: string;
  /** Summe Netto-CHF im Zeitraum. */
  totalNet: number;
  /** Anteil an den Gesamt-Warenkosten in Prozent (0 wenn Total 0). */
  sharePct: number;
  /** Anzahl Rechnungen. */
  count: number;
}

/** Kalenderkorrekter Monatsbereich [erster, letzter Tag] als ISO-Strings (YYYY-MM-DD). */
export function monthDateRange(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate(); // Tag 0 des Folgemonats = Monatsletzter
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

/** Netto-Total aller Rechnungen (CHF). */
export function sumInvoicesNet(invoices: InvoiceEntry[]): number {
  return invoices.reduce((s, e) => s + (Number.isFinite(e.amountNet) ? e.amountNet : 0), 0);
}

/** Aufteilung nach Lieferant, absteigend nach Betrag (Top-Lieferanten zuerst). */
export function aggregateBySupplier(invoices: InvoiceEntry[]): SupplierAggRow[] {
  const map = new Map<string, { totalNet: number; count: number }>();
  for (const e of invoices) {
    const key = (e.supplierName || '—').trim() || '—';
    const cur = map.get(key) ?? { totalNet: 0, count: 0 };
    cur.totalNet += Number.isFinite(e.amountNet) ? e.amountNet : 0;
    cur.count += 1;
    map.set(key, cur);
  }
  const total = sumInvoicesNet(invoices);
  return Array.from(map.entries())
    .map(([supplierName, v]) => ({
      supplierName,
      totalNet: v.totalNet,
      sharePct: total > 0 ? (v.totalNet / total) * 100 : 0,
      count: v.count,
    }))
    .sort((a, b) => b.totalNet - a.totalNet || a.supplierName.localeCompare(b.supplierName, 'de'));
}

/** WKQ in Prozent; null wenn kein Umsatz (keine sinnlose Division). */
export function warenkostenquote(warenNet: number, umsatzNet: number): number | null {
  if (!(umsatzNet > 0)) return null;
  return (warenNet / umsatzNet) * 100;
}

/** Ampel gegen die Zielquote: grün ≤ Ziel, rot > Ziel; null ohne WKQ. */
export function wkqAmpel(wkqPct: number | null, zielPct: number): 'green' | 'red' | null {
  if (wkqPct == null) return null;
  return wkqPct <= zielPct ? 'green' : 'red';
}
