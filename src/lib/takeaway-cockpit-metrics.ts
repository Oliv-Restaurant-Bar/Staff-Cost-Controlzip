/**
 * Produktanalyse — Cockpit-Kennzahl «Gäste Take Away»
 * ===================================================
 * Berechnet aus den BEREITS importierten Produktverkaufsdaten (Tabelle
 * `product_sales`, Gastronovi-Produktanalyse-CSV via `gastronovi-csv-parser` +
 * `SalesUpload`) die Cockpit-Kennzahl «Gäste Take Away» für einen Zeitraum.
 * WEITERVERWENDUNG der bestehenden Produkt-Pipeline, KEINE Parallelpipeline:
 * dieselbe TAB-getrennte CSV (Bezeichnung · Zeitraum · Tagesspalten TT.MM.),
 * dieselbe Jahr-Dropdown-Mechanik beim Import, dieselbe Speicherung/Merge-Regel
 * (`product_sales`, `insertProductSales` nach `deleteProductSalesForPeriod`).
 *
 * Fachregel:
 *   «Gäste Take Away» pro Tag = Σ Stückzahlen (quantity) ALLER Take-Away-
 *   Produkte des Tages (1 Stück = 1 TA-Gast). Aggregation auf Woche (gewählte
 *   Cockpit-Woche) und Monat.
 *
 * TA-Erkennung (case-SENSITIVE, Wortgrenzen): ein Produkt ist Take-Away, wenn
 * seine Bezeichnung den eigenständigen GROSSGESCHRIEBENEN Token «TA» enthält.
 * Regex: (^|\s)TA($|\s). Positiv: «Pizza Prosciutto TA». NEGATIV (zählen NICHT):
 * Pasta, Tatar, Burrata, Bruschetta, Torte, Ratatouille, kleingeschriebenes
 * «ta». So bleibt die Kennzahl robust gegen zufällige «ta»-Teilstrings.
 *
 * Fehlt die Quelle für einen Zeitraum GAR KEINE Produktzeile → `null` («—», nie
 * still 0). PostgREST-Row-Cap: paginiert (range), Aggregation clientseitig über
 * die schlanken Spalten (product_name, quantity, sale_date). Die reinen
 * Funktionen (`isTakeAwayProduct`, `aggregateTakeAwayGuests`,
 * `mergeTakeAwayDays`) sind ohne DB testbar.
 */

import { supabase } from '@/integrations/supabase/client';

/**
 * Case-SENSITIVE TA-Erkennung mit Wortgrenzen: der eigenständige Token «TA»
 * (Grossbuchstaben) irgendwo im Produktnamen, umgeben von Zeilenanfang/-ende
 * oder Whitespace. Deckt «Pizza Prosciutto TA», «Pasta Pollo TA» ab; schliesst
 * Pasta, Tatar, Burrata, Bruschetta, Torte, Ratatouille sowie kleines «ta» aus.
 */
const TA_TOKEN_REGEX = /(^|\s)TA($|\s)/;

/** true ⇔ Produktbezeichnung enthält den eigenständigen Grossbuchstaben-Token «TA». */
export function isTakeAwayProduct(productName: string | null | undefined): boolean {
  if (!productName) return false;
  return TA_TOKEN_REGEX.test(productName);
}

/** Schlanke Produkt-Verkaufszeile für die TA-Aggregation. */
export interface TakeAwaySalesRow {
  product_name: string | null;
  quantity: number | null;
  /** ISO-Datum YYYY-MM-DD (nur für die Tag-Merge-Logik relevant). */
  sale_date?: string | null;
}

/**
 * Reine Aggregation: Σ Stückzahlen aller Take-Away-Produkte über die
 * übergebenen Zeilen (Zeitraum-Filterung erfolgt vorgelagert in der Ladeschicht
 * bzw. beim Merge). `hasData=false` → `null` (Quelle fehlt, «—» statt 0).
 * Nicht-TA-Produkte werden ignoriert; negative/ungültige Mengen als 0 gewertet.
 */
export function aggregateTakeAwayGuests(
  rows: TakeAwaySalesRow[],
  hasData: boolean,
): number | null {
  if (!hasData) return null;
  let sum = 0;
  for (const row of rows) {
    if (!isTakeAwayProduct(row.product_name)) continue;
    const qty = typeof row.quantity === 'number' && Number.isFinite(row.quantity) ? row.quantity : 0;
    if (qty > 0) sum += qty;
  }
  return sum;
}

/**
 * Tag-genaue Merge-Regel: ein erneuter Import ERSETZT nur die tatsächlich
 * enthaltenen Tage, alle übrigen Tage bleiben unverändert. Modelliert die
 * fachliche Merge-Semantik der Produktanalyse (die DB-Speicherung selbst
 * erfolgt über die bestehende `product_sales`-Pipeline). Reine Funktion:
 *   - `existing`: bereits gespeicherte Zeilen (mit `sale_date`).
 *   - `incoming`: neu importierte Zeilen (mit `sale_date`).
 * Ergebnis: alle `existing`-Zeilen, deren Tag NICHT im Import vorkommt, plus
 * alle `incoming`-Zeilen (die ihre Tage vollständig ersetzen).
 */
export function mergeTakeAwayDays<T extends { sale_date?: string | null }>(
  existing: T[],
  incoming: T[],
): T[] {
  const incomingDays = new Set(
    incoming.map(r => r.sale_date).filter((d): d is string => !!d),
  );
  const kept = existing.filter(r => !r.sale_date || !incomingDays.has(r.sale_date));
  return [...kept, ...incoming];
}

const PAGE = 1000;

/**
 * Lädt die schlanken Produkt-Verkaufszeilen eines Zeitraums aus `product_sales`
 * (nur product_name + quantity), paginiert gegen den PostgREST-Row-Cap.
 * `product_sales` besitzt KEINE restaurant_id — Mandanten-Trennung erfolgt (wie
 * in `loadProductSalesRows`) nicht DB-seitig. Rückgabe: alle Zeilen ODER `null`
 * bei DB-Fehler (Aufrufer behandelt `null` als «keine Daten»).
 */
async function fetchTakeAwayRows(
  fromIso: string, toIso: string,
): Promise<TakeAwaySalesRow[] | null> {
  try {
    const all: TakeAwaySalesRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await (supabase as any)
        .from('product_sales')
        .select('product_name, quantity')
        .not('source', 'is', null)
        .not('import_batch', 'is', null)
        .gte('sale_date', fromIso)
        .lte('sale_date', toIso)
        .range(offset, offset + PAGE - 1);
      if (error) return null;
      const batch = (data ?? []) as TakeAwaySalesRow[];
      all.push(...batch);
      if (batch.length < PAGE) break;
    }
    return all;
  } catch {
    return null;
  }
}

/**
 * Cockpit-Kennzahl «Gäste Take Away» für einen Zeitraum [fromIso, toIso] (inkl.
 * beider Grenzen). Leerer/ungültiger Zeitraum → `null`. DB-Fehler → `null`.
 * Enthält der Zeitraum GAR KEINE Produktzeile → `null` (Quelle fehlt ≠ 0).
 * Zukünftige Perioden zählen mit (nicht auf «heute» geklemmt).
 */
export async function loadTakeAwayGuests(
  fromIso: string | null,
  toIso: string | null,
): Promise<number | null> {
  if (!fromIso || !toIso || fromIso > toIso) return null;
  const rows = await fetchTakeAwayRows(fromIso, toIso);
  if (rows === null) return null;
  return aggregateTakeAwayGuests(rows, rows.length > 0);
}
