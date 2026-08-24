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
import { kontoKlasse, istPfandKonto, istFibuVergleichsKonto, DEFAULT_WARENKOSTEN_GRENZE } from './waren-klassen';
import { normalizeWarenKonto } from './warenaufwand-gruppierung';
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

export interface KategorieWarenSollInput {
  /** Vorhandenes Wareneinsatz-Gesamtbudget; bleibt bei der Aufteilung autoritativ. */
  totalSoll: number | null;
  /** Kanonischer Food-Netto-Umsatz der Periode (foodBeverageSplit). */
  foodUmsatz: number | null;
  /** Kanonischer Beverage-Netto-Umsatz der Periode (foodBeverageSplit). */
  beverageUmsatz: number | null;
  /** Fallback-Zielquote in Prozent, falls kein absolutes Gesamt-Soll vorhanden ist. */
  zielPct: number | null;
}

export interface KategorieWarenSoll {
  total: number | null;
  food: number | null;
  beverage: number | null;
}

const roundChf = (v: number): number => Math.round(v * 100) / 100;
const positiveOrNull = (v: number | null): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
const nonNegativeOrNull = (v: number | null): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * Teilt den Wareneinsatz-Soll nach derselben Umsatzbasis wie die Wochenansicht:
 * Food/Beverage aus `foodBeverageSplit`, in beiden Kategorien mit derselben
 * wirksamen Quote. Ein vorhandenes Gesamt-Soll bleibt unverändert; fehlt es,
 * wird es aus Ziel-WKQ × Kategorie-Netto-Umsatz abgeleitet.
 *
 * Die Rest-Rundung wird Beverage zugewiesen, damit immer exakt gilt:
 * Food-Soll + Beverage-Soll = Total-Soll (auf Rappen gerundet).
 */
export function resolveKategorieWarenSoll(input: KategorieWarenSollInput): KategorieWarenSoll {
  // 0 ist ein gültiger Kategorie-Umsatz und darf nicht mit «nicht geladen»
  // (null) vermischt werden.
  const foodUmsatz = nonNegativeOrNull(input.foodUmsatz);
  const beverageUmsatz = nonNegativeOrNull(input.beverageUmsatz);
  const umsatzTotal = (foodUmsatz ?? 0) + (beverageUmsatz ?? 0);

  const vorgegebenesTotal = positiveOrNull(input.totalSoll);
  const zielPct = positiveOrNull(input.zielPct);
  const total = vorgegebenesTotal != null
    ? roundChf(vorgegebenesTotal)
    : zielPct != null && umsatzTotal > 0
      ? roundChf(umsatzTotal * (zielPct / 100))
      : null;

  if (total == null || umsatzTotal <= 0) {
    return { total, food: null, beverage: null };
  }

  if (foodUmsatz == null) return { total, food: null, beverage: total };
  if (beverageUmsatz == null) return { total, food: total, beverage: null };

  const food = roundChf(total * (foodUmsatz / umsatzTotal));
  const beverage = roundChf(total - food);
  return { total, food, beverage };
}

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
  /depot|leergut|pfand/i.test(warenkonto) || istPfandKonto(warenkonto);

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

/**
 * FIBU-Vergleichs-Netto einer Rechnung: NUR die FIBU-Vergleichskonten
 * 4020–4070 (istFibuVergleichsKonto) — ohne Depot/Pfand, ohne Betriebskosten-
 * Splits (4701 Non-Food, >Grenze, <4000) UND ohne 4000/4071/4090 (4000 ist
 * bei Beaulieu das Prodega-LSV-Durchlaufkonto, reines Clearing). Das ist
 * derselbe Konto-Scope, mit dem das FIBU-Lieferanten-Journal gefiltert wird —
 * Vergleich Waren gegen Waren. Rechnungen OHNE Splits: kontolos/«offen»
 * behält das volle amountNet (Legacy, kein Raten); ein gesetztes numerisches
 * Warenkosten-Konto ausserhalb des Vergleichsscopes (4000/4090) zählt 0.
 */
export function fibuVergleichsNetto(e: InvoiceEntry, grenze: number = DEFAULT_WARENKOSTEN_GRENZE): number {
  const splits = e.kontoSplits ?? [];
  if (splits.length === 0) {
    const k = e.warenkonto;
    const n = k ? normalizeWarenKonto(k) : null;
    // Vergleichskonto 4020–4070 zählt IMMER voll — unabhängig von der
    // konfigurierbaren WKQ-Grenze (sonst würde z.B. Grenze 4050 die
    // Erfasst-Seite für 4060/4070 leeren, während das Journal sie behält).
    if (n !== null && istFibuVergleichsKonto(k)) return Number.isFinite(e.amountNet) ? e.amountNet : 0;
    // Numerisches Warenkosten-Konto AUSSERHALB des Vergleichsscopes
    // (4000 Durchlauf, 4090 Übrige) → 0. Kontolos/«offen» bleibt Legacy-voll,
    // Betriebskosten-Singles (4701 etc.) bleiben unverändert (Bestand).
    if (n !== null && kontoKlasse(k, grenze) === 'warenkosten') return 0;
    return Number.isFinite(e.amountNet) ? e.amountNet : 0;
  }
  const sum = splits.reduce((s, sp) => {
    if (istDepotSplitKonto(sp.warenkonto ?? '')) return s;
    const n = normalizeWarenKonto(sp.warenkonto ?? '');
    // Numerische Konten: NUR die Vergleichskonten 4020–4070 zählen —
    // grenzen-unabhängig (4000 Durchlauf, 4090 Übrige, 4701 usw. raus).
    if (n !== null) {
      return istFibuVergleichsKonto(sp.warenkonto) ? s + (Number.isFinite(sp.amountNet) ? sp.amountNet : 0) : s;
    }
    // Nicht-numerisch («offen»/kontolos): Warenkosten-Legacy — zählt weiter.
    if (kontoKlasse(sp.warenkonto, grenze) !== 'warenkosten') return s;
    return s + (Number.isFinite(sp.amountNet) ? sp.amountNet : 0);
  }, 0);
  return Math.round(sum * 100) / 100;
}

/** Betriebskosten-Anteil (z.B. 4701 Non-Food) einer Rechnung — für den
 *  informativen Hinweis im Abgleich («separat auf 4701, nicht im Vergleich»). */
export function betriebsAnteilNet(e: InvoiceEntry, grenze: number = DEFAULT_WARENKOSTEN_GRENZE): number {
  return (e.kontoSplits ?? [])
    .filter(sp => !istDepotSplitKonto(sp.warenkonto ?? '') && kontoKlasse(sp.warenkonto, grenze) !== 'warenkosten')
    .reduce((s, sp) => s + (Number.isFinite(sp.amountNet) ? sp.amountNet : 0), 0);
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
