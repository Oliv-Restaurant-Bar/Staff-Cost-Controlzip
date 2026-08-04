/**
 * Produktanalyse — Quellenpriorität (reine Logik, kein IO)
 * =========================================================
 * Entscheidet für einen Auswertungszeitraum, welche Datenquelle die
 * aggregierten Produktwerte liefert:
 *
 *   1. Erweiterter Z-Bericht (gn_extended_positions, Abschnitt «Positionen»)
 *   2. Verkaufsdatenimport (product_sales) nur als Fallback
 *
 * KEINE Doppelzählung: Tage, die von einem VERWENDETEN erweiterten Bericht
 * abgedeckt sind, werden aus den Verkaufsdaten-Zeilen ausgeschlossen.
 *
 * Mehrtagesberichte (periodFrom ≠ periodTo):
 *  - Sie sind PERIODENSUMMEN und werden NIE künstlich auf Tage verteilt.
 *  - Liegt der gesamte Berichtszeitraum innerhalb des Auswertungszeitraums,
 *    zählen sie als eine Summe (sale_date = periodTo — der Gastronovi-
 *    Geschäftstag endet am Bis-Datum) und sind über isGnExtendedPeriodSumRow
 *    als Periodensumme erkennbar.
 *  - Ragt der Bericht über den Auswertungszeitraum hinaus (z. B. Tagesansicht),
 *    wird er AUSGESCHLOSSEN und als «Nur als Periodensumme verfügbar»
 *    gemeldet — dann greift der Verkaufsdaten-Fallback für diese Tage.
 *
 * Kategoriezuordnung (Food/Beverage): Der erweiterte Bericht kennt je
 * Position keine Warengruppe. Die Zuordnung kommt aus der bestehenden
 * Verkaufsdaten-Historie (Produktname → Quelle). Ohne Historie bleibt die
 * Position unklassifiziert (zählt in «Alle», nie fälschlich in Food/Beverage).
 */

import type { ProductSalesRow } from './sales-db';
import type { CategoryFilter } from './product-analytics';

// ── Quellen-Schlüssel der synthetischen Zeilen ───────────────────────────────

export const GN_EXTENDED_SOURCE          = 'gn_extended';
export const GN_EXTENDED_SOURCE_FOOD     = 'gn_extended_food';
export const GN_EXTENDED_SOURCE_BEVERAGE = 'gn_extended_beverage';

const GN_EXT_BATCH_PREFIX = 'gn_extended:';
const GN_EXT_PERIOD_SUFFIX = ':period';

/** Zeile stammt aus einem erweiterten Z-Bericht. */
export function isGnExtendedRow(row: Pick<ProductSalesRow, 'import_batch'>): boolean {
  return (row.import_batch ?? '').startsWith(GN_EXT_BATCH_PREFIX);
}

/** Zeile ist eine Mehrtages-PERIODENSUMME (nie einem einzelnen Tag zuordenbar). */
export function isGnExtendedPeriodSumRow(row: Pick<ProductSalesRow, 'import_batch'>): boolean {
  const b = row.import_batch ?? '';
  return b.startsWith(GN_EXT_BATCH_PREFIX) && b.endsWith(GN_EXT_PERIOD_SUFFIX);
}

// ── Eingaben ─────────────────────────────────────────────────────────────────

/** Positions-Zeile eines erweiterten Z-Berichts (Abschnitt «Positionen»). */
export interface ExtendedPositionInput {
  importId: string;
  periodFrom: string | null;
  periodTo: string | null;
  name: string;
  quantity: number;
  grossAmount: number;
}

export type ProduktDatenquelle = 'extended' | 'verkaufsdaten' | 'gemischt' | 'keine';

export interface PeriodSumReport {
  importId: string;
  periodFrom: string;
  periodTo: string;
}

export interface ProduktQuellenResult {
  /** Zeilen für die bestehenden Aggregationen (synthetisch + Fallback). */
  rows: ProductSalesRow[];
  source: ProduktDatenquelle;
  /** Verwendete erweiterte Berichte (import-IDs). */
  usedExtendedImportIds: string[];
  /** Ausgeschlossene Verkaufsdaten-Zeilen (Doppelzählungs-Schutz). */
  excludedSalesRows: number;
  /** Überlappende Mehrtagesberichte, die NICHT verwendbar sind («Nur als Periodensumme verfügbar»). */
  periodSumOnlyReports: PeriodSumReport[];
}

// ── Kategorie-Ableitung aus der Verkaufsdaten-Historie ───────────────────────

/**
 * Produktname → Food/Beverage aus der GESAMTEN Verkaufsdaten-Historie.
 * Bei widersprüchlichen Quellen gewinnt der Eintrag mit dem neuesten
 * sale_date (deterministisch). Reine Klassifikation — KEINE fachliche
 * Zusammenführung unterschiedlicher Produktnamen.
 */
export function buildSalesCategoryMap(
  salesRows: ProductSalesRow[],
  categoryOfSource: (source: string | null | undefined) => CategoryFilter | null,
): Map<string, Exclude<CategoryFilter, 'all'>> {
  const latest = new Map<string, { date: string; cat: Exclude<CategoryFilter, 'all'> }>();
  for (const r of salesRows) {
    const cat = categoryOfSource(r.source);
    if (cat !== 'food' && cat !== 'beverage') continue;
    const prev = latest.get(r.product_name);
    if (!prev || r.sale_date > prev.date) {
      latest.set(r.product_name, { date: r.sale_date, cat });
    }
  }
  const out = new Map<string, Exclude<CategoryFilter, 'all'>>();
  for (const [name, e] of latest) out.set(name, e.cat);
  return out;
}

// ── Kern: Quellen zusammenführen ─────────────────────────────────────────────

export function mergeProduktQuellen(params: {
  /** Verkaufsdaten-Zeilen (dürfen ungefiltert sein — Bounds-Filter hier). */
  salesRows: ProductSalesRow[];
  /** Positions-Zeilen aktiver erweiterter Berichte (beliebiger Zeitraum). */
  extendedPositions: ExtendedPositionInput[];
  /** Auswertungszeitraum (inklusive Grenzen, ISO-Daten). */
  bounds: { from: string; to: string };
  /** Produktname → Kategorie (aus buildSalesCategoryMap). */
  categoryByProduct: Map<string, Exclude<CategoryFilter, 'all'>>;
}): ProduktQuellenResult {
  const { salesRows, extendedPositions, bounds, categoryByProduct } = params;

  // 1. Erweiterte Berichte nach Import gruppieren
  const byImport = new Map<string, { periodFrom: string | null; periodTo: string | null; positions: ExtendedPositionInput[] }>();
  for (const p of extendedPositions) {
    const g = byImport.get(p.importId);
    if (g) g.positions.push(p);
    else byImport.set(p.importId, { periodFrom: p.periodFrom, periodTo: p.periodTo, positions: [p] });
  }

  // 2. Verwendbare Berichte (Zeitraum vollständig im Auswertungszeitraum)
  const usedIds: string[] = [];
  const periodSumOnly: PeriodSumReport[] = [];
  const coveredRanges: Array<{ from: string; to: string }> = [];
  const synthetic: ProductSalesRow[] = [];

  for (const [importId, g] of byImport) {
    const pf = g.periodFrom;
    const pt = g.periodTo;
    if (!pf || !pt) continue; // ohne Zeitraum nie zuordenbar — zählt nirgends
    const overlaps = pf <= bounds.to && pt >= bounds.from;
    if (!overlaps) continue;
    const usable = pf >= bounds.from && pt <= bounds.to;
    if (!usable) {
      // Überlappt, ragt aber hinaus (z. B. Mehrtagesbericht in Tagesansicht):
      // NIE anteilig zählen — nur als Periodensumme verfügbar.
      periodSumOnly.push({ importId, periodFrom: pf, periodTo: pt });
      continue;
    }
    usedIds.push(importId);
    coveredRanges.push({ from: pf, to: pt });
    const isPeriodSum = pf !== pt;
    // Geschäftstag endet am Bis-Datum → Mehrtagessummen am periodTo verankert.
    const saleDate = isPeriodSum ? pt : pf;
    const batch = `${GN_EXT_BATCH_PREFIX}${importId}${isPeriodSum ? GN_EXT_PERIOD_SUFFIX : ''}`;
    for (const p of g.positions) {
      const cat = categoryByProduct.get(p.name);
      const source = cat === 'food' ? GN_EXTENDED_SOURCE_FOOD
        : cat === 'beverage' ? GN_EXTENDED_SOURCE_BEVERAGE
        : GN_EXTENDED_SOURCE;
      synthetic.push({
        product_name: p.name,
        quantity: p.quantity,
        revenue: p.grossAmount,
        sale_date: saleDate,
        source,
        import_batch: batch,
      });
    }
  }

  // 3. Verkaufsdaten im Zeitraum — abzüglich der durch VERWENDETE erweiterte
  //    Berichte abgedeckten Tage (Doppelzählungs-Schutz)
  const inBounds = salesRows.filter(r => r.sale_date >= bounds.from && r.sale_date <= bounds.to);
  const isCovered = (d: string) => coveredRanges.some(c => d >= c.from && d <= c.to);
  const fallback = inBounds.filter(r => !isCovered(r.sale_date));
  const excludedSalesRows = inBounds.length - fallback.length;

  const rows = [...synthetic, ...fallback];
  const source: ProduktDatenquelle =
    synthetic.length > 0 && fallback.length > 0 ? 'gemischt'
    : synthetic.length > 0 ? 'extended'
    : fallback.length > 0 ? 'verkaufsdaten'
    : 'keine';

  return { rows, source, usedExtendedImportIds: usedIds, excludedSalesRows, periodSumOnlyReports: periodSumOnly };
}

/** Anzeige-Label der Datenquelle («Datenquelle: …»). */
export function produktQuellenLabel(source: ProduktDatenquelle): string | null {
  switch (source) {
    case 'extended':      return 'Datenquelle: Erweiterter Z-Bericht PDF';
    case 'verkaufsdaten': return 'Datenquelle: Verkaufsdatenimport (Fallback)';
    case 'gemischt':      return 'Datenquellen: Erweiterter Z-Bericht PDF + Verkaufsdatenimport';
    case 'keine':         return null;
  }
}
