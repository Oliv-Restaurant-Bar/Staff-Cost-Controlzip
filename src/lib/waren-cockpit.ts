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

import { kontoKategorie, type WarenKategorie } from './warenkosten-quote';
import type { InvoiceEntry, Warenkonto } from './waren-db';
import type { TenantId } from './cockpit-budget';

/**
 * Soll-WEQ je Warenkategorie und Mandant in % des KATEGORIE-Umsatzes
 * (Food-WEQ × Food-Umsatz = Soll-Warenkosten Küche; analog Beverage/Bar).
 * Quelle: Gastronovi-WEQ-Auswertung (Oliv) bzw. User-Vorgabe 08/2026
 * (Beaulieu). Feste Jahreswerte, mandantengetrennt — reine Analyse-Ziele,
 * KEINE Budget-Positionen.
 */
export const KATEGORIE_WEQ_DEFAULT: Record<TenantId, { food: number; beverage: number }> = {
  oliv: { food: 24.7, beverage: 15.2 },
  beaulieu: { food: 27.0, beverage: 19.0 },
};

/**
 * Effektive Kategorie-Anteile einer Rechnung (netto):
 * - Split-Rechnung: je Split-Konto dessen Konto-Kategorie (explizit vor Heuristik).
 * - Sonst: persistierte kategorie; fehlt sie (Altbestand/Import), Kategorie des
 *   Warenkontos (explizite Konto-Kategorie vor kategorieFromKonto-Heuristik).
 */
export function kategorieShares(
  e: InvoiceEntry, konten: Warenkonto[],
): { kategorie: WarenKategorie; net: number }[] {
  if (e.kontoSplits && e.kontoSplits.length > 0) {
    // Depot-/Pfand-Splits sind KEIN Warenaufwand — gleiche Regel wie
    // nettoOhneDepot, damit Food+Beverage exakt zum Total (ohne Pfand) passt.
    return e.kontoSplits
      .filter(s => !istDepotSplitKonto(s.warenkonto ?? ''))
      .map(s => ({
        kategorie: kontoKategorie(s.warenkonto ?? '', konten),
        net: Number.isFinite(s.amountNet) ? s.amountNet : 0,
      }));
  }
  // Konto autoritativ (wie kategorieOf): liefert das Konto Food/Beverage,
  // zählt eine alt gespeicherte kategorie («Sonstiges» aus Importen) nicht.
  const vomKonto = kontoKategorie(e.warenkonto ?? '', konten);
  return [{
    kategorie: vomKonto !== 'Sonstiges' ? vomKonto : (e.kategorie ?? vomKonto),
    net: Number.isFinite(e.amountNet) ? e.amountNet : 0,
  }];
}

/** Netto-Summe einer Kategorie über Rechnungen (effektive Kategorie, s. kategorieShares). */
export function sumNetByKategorie(
  invoices: InvoiceEntry[], kat: WarenKategorie, konten: Warenkonto[],
): number {
  let s = 0;
  for (const e of invoices) {
    for (const sh of kategorieShares(e, konten)) if (sh.kategorie === kat) s += sh.net;
  }
  return s;
}

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

/** Rechnungen im ISO-Datumsbereich [fromIso..toIso] (beide inklusiv). */
export function filterInvoicesByRange(
  invoices: InvoiceEntry[], fromIso: string, toIso: string,
): InvoiceEntry[] {
  return invoices.filter(e => e.date >= fromIso && e.date <= toIso);
}

/**
 * Stabiler Zeilen-Slug aus dem Lieferantennamen (Basis der Cockpit-Zeilen-IDs,
 * z.B. «Growa CC» → 'growa_cc'). Umlaute transliteriert, Rest → '_'.
 */
export function supplierSlug(name: string): string {
  const s = name.trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'unbenannt';
}

/**
 * Kollisionssichere Zeilen-IDs für eine Lieferanten-Liste (Reihenfolge der
 * Eingabe = Reihenfolge der Ausgabe). supplierSlug ist verlustbehaftet
 * («Migros» und «MIGROS!» → 'migros'); bei Kollision bekommen weitere
 * Lieferanten deterministisch ein Suffix ('migros', 'migros_2', 'migros_3' …),
 * damit keine zwei Zeilen dieselbe ID teilen (applyRowOrder/React-Keys).
 */
export function supplierRowIds(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map(name => {
    const base = supplierSlug(name);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}

/**
 * Pfand/Leergut ist KEIN direkter Warenaufwand: die FIBU bucht Depot auf ein
 * separates Konto. Alle Warenkosten-Summen (Cockpit/WKQ/FIBU-Abgleich) rechnen
 * deshalb OHNE die Depot-Pseudo-Splits einer Rechnung. Rechnungen ohne Splits
 * behalten ihr volles amountNet (kein Raten).
 */
export const istDepotSplitKonto = (warenkonto: string): boolean =>
  /depot|leergut|pfand/i.test(warenkonto);

/** Depot-/Leergut-Anteil einer Rechnung (0 ohne entsprechende Splits). */
export function depotAnteilNet(e: InvoiceEntry): number {
  return (e.kontoSplits ?? [])
    .filter(s => istDepotSplitKonto(s.warenkonto))
    .reduce((s, x) => s + (Number.isFinite(x.amountNet) ? x.amountNet : 0), 0);
}

/** Netto einer Rechnung ohne Depot/Pfand (Basis aller Warenkosten-Summen). */
export function nettoOhneDepot(e: InvoiceEntry): number {
  const n = Number.isFinite(e.amountNet) ? e.amountNet : 0;
  return Math.round((n - depotAnteilNet(e)) * 100) / 100;
}

/** Netto-Total aller Rechnungen (CHF) — OHNE Pfand/Depot-Anteile. */
export function sumInvoicesNet(invoices: InvoiceEntry[]): number {
  return invoices.reduce((s, e) => s + nettoOhneDepot(e), 0);
}

/** Aufteilung nach Lieferant, absteigend nach Betrag (Top-Lieferanten zuerst). */
export function aggregateBySupplier(invoices: InvoiceEntry[]): SupplierAggRow[] {
  const map = new Map<string, { totalNet: number; count: number }>();
  for (const e of invoices) {
    const key = (e.supplierName || '—').trim() || '—';
    const cur = map.get(key) ?? { totalNet: 0, count: 0 };
    cur.totalNet += nettoOhneDepot(e);
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
