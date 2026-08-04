/**
 * wes-month.ts — Verkaufsbasierter Wareneinsatz eines Monats (REINE LOGIK).
 * =========================================================================
 * SSoT für die Rezeptur-WES-Berechnung «Verkaufsmenge × Rezept-WES», extrahiert
 * aus der WES-Analyse (buildMonthRow), damit Management-Dashboard und
 * WES-Analyse DIESELBE Berechnung nutzen (keine Zweitberechnung).
 *
 * Regeln (unverändert aus der WES-Analyse):
 *  - Match Verkaufszeile ↔ Kostensatz über Name UND Kategorie.
 *  - Kostensätze ohne positiven WES werden übersprungen (kein 0-Erfinden).
 *  - Keine Treffer im Monat ⇒ Totale bleiben 0 — der Aufrufer interpretiert
 *    wesTotal <= 0 als «keine Daten» (null), NIE als echten Wert 0.
 */

export interface WesSaleEntry {
  name: string;
  category: 'food' | 'beverage';
  month: string; // 'yyyy-MM' oder 'gesamt'
  count: number;
}

export interface WesCostEntry {
  name: string;
  category: 'food' | 'beverage';
  /** Einkaufspreis / Wareneinsatz pro Einheit. */
  wes: number;
}

export interface VerkaufsWesResult {
  rezFood: number;
  rezBeverage: number;
  rezTotal: number;
}

export function computeVerkaufsWes(
  entries: ReadonlyArray<WesSaleEntry>,
  costEntries: ReadonlyArray<WesCostEntry>,
  monthKey: string, // 'yyyy-MM'
): VerkaufsWesResult {
  let rezFood = 0;
  let rezBeverage = 0;

  for (const entry of entries) {
    if (entry.month !== monthKey) continue;
    const costEntry = costEntries.find(
      c => c.name === entry.name && c.category === entry.category,
    );
    if (!costEntry || costEntry.wes <= 0) continue;
    const contribution = costEntry.wes * (entry.count || 0);
    if (entry.category === 'food') rezFood += contribution;
    else rezBeverage += contribution;
  }

  return { rezFood, rezBeverage, rezTotal: rezFood + rezBeverage };
}
