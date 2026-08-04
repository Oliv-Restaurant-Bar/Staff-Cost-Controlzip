/**
 * warenkosten-quote – Single Source of Truth für die Warenkostenquote
 * ===================================================================
 * ZENTRALE, reine Berechnungslogik der Warenkostenquote. DOM-/Supabase-frei
 * (nur `import type`), damit sie synthetisch getestet und überall (Seiten,
 * Export, Vergleiche) IDENTISCH verwendet werden kann.
 *
 * Fachregel (verbindlich):
 *   relevante Warenkosten = Food + Beverage
 *   Warenkostenquote      = relevante Warenkosten / Umsatz   (Sonstige AUSGESCHLOSSEN)
 *   "Sonstiges" wird separat ausgewiesen, fliesst NIE in Quote/relevante Summe.
 *
 * Rundung: Diese Lib rundet NICHT. Aufrufer runden erst bei Anzeige/Export
 * (CHF auf 2 Stellen, Prozent auf 1 Stelle).
 *
 * Kontenplan (seit Aug 2026 EIN Schema, identisch zum FIBU-Kontenplan):
 *   - Warenkosten = Konten 4000–Grenze (Default 4090, s. waren-klassen).
 *     Food:     4000 Lebensmittel, 4060 Küche, 4070 Kaffee/Tee, 4090
 *               Handelswaren sowie alle übrigen Konten im Warenbereich.
 *     Beverage: 4020 Wein, 4030 Bier, 4040 Spirituosen, 4050 Mineral/Getränke.
 *   - Das KONTO ist autoritativ: liegt ein Warenkonto (4000–Grenze) vor,
 *     wird die Kategorie IMMER daraus abgeleitet — eine (alt) gespeicherte
 *     `kategorie` zählt nur noch für Einträge OHNE ableitbares Konto.
 *     Invariante: relevantNet (Food+Beverage) über eine mit nurWarenAnteil
 *     gefilterte Liste == sumWarenNet — keine Warenkosten-Position fällt
 *     mehr in «Sonstiges».
 *   - FIBU-/Erfolgsrechnungs-Seite: ausschliesslich über die Reporting-/
 *     pl-engine-Kategorisierung (cogs_food / cogs_bev / cogs_other).
 *
 * Debug-Logs: keine (reine Lib).
 */

// ─── Kategorie ────────────────────────────────────────────────────────────────

/**
 * Kategorie einer Warenrechnung für die Kostenaufteilung Food/Beverage/Sonstiges.
 * (Hier zentral definiert; `waren-db` re-exportiert den Typ aus Kompatibilität.)
 */
export type WarenKategorie = 'Food' | 'Beverage' | 'Sonstiges';

/**
 * Default-Obergrenze der Warenkosten-Konten. MUSS mit
 * DEFAULT_WARENKOSTEN_GRENZE (waren-klassen.ts) übereinstimmen — hier
 * dupliziert, damit diese Lib import-frei/pur bleibt (kein Zyklus über
 * waren-db, das kategorieFromKonto re-exportiert).
 */
const WARENKOSTEN_GRENZE_DEFAULT = 4090;

/** Beverage-Konten des (FIBU-identischen) Kontenplans. */
const BEVERAGE_KONTEN = new Set([4020, 4030, 4040, 4050]);

/**
 * Leitet die WarenKategorie vom Warenkonto ab (Kontenplan = FIBU-Schema):
 *   Beverage: 4020 Wein, 4030 Bier, 4040 Spirituosen, 4050 Mineral/Getränke
 *   Food:     ALLE übrigen Konten 4000–Grenze (4000 Lebensmittel, 4060 Küche,
 *             4070 Kaffee/Tee, 4090 Handelswaren, …) — damit fällt KEIN
 *             Warenkosten-Konto aus der Quote.
 *   Sonstiges: kein/nicht-numerisches Konto oder ausserhalb 4000–Grenze
 *              (Betriebskosten wie 4701/6040 — nie in der WKQ).
 */
export function kategorieFromKonto(
  konto: string | undefined,
  grenze: number = WARENKOSTEN_GRENZE_DEFAULT,
): WarenKategorie {
  if (!konto) return 'Sonstiges';
  const n = parseInt(konto, 10);
  if (!Number.isFinite(n) || n < 4000 || n > grenze) return 'Sonstiges';
  return BEVERAGE_KONTEN.has(n) ? 'Beverage' : 'Food';
}

/** Minimal-Form eines Rechnungseintrags für die Quoten-Berechnung. */
export interface WarenkostenEntryInput {
  id: string;
  amountNet: number;
  kategorie?: WarenKategorie;
  warenkonto?: string;
}

/**
 * Effektive Kategorie eines Eintrags — das KONTO ist autoritativ:
 *   1. Warenkonto 4000–Grenze → Kategorie IMMER aus dem Konto (eine alt
 *      gespeicherte `kategorie` — z.B. «Sonstiges» aus früheren Importen —
 *      kann keine Warenkosten mehr aus der Quote drängen).
 *   2. Kein Konto ODER nicht-numerisches Pseudo-Konto («offen», nicht
 *      «Depot»): gespeicherte kategorie; fehlt sie → 'Food'. Diese Einträge
 *      zählen per Legacy-Regel (waren-klassen.kontoKlasse) als Warenkosten
 *      und dürfen deshalb nicht in «Sonstiges» (ausserhalb der Quote) landen.
 *   3. Numerisches Konto ausserhalb 4000–Grenze (Betriebskosten) oder
 *      «Depot» (neutral) → 'Sonstiges', gespeicherte kategorie zählt nicht.
 */
export function kategorieOf(
  entry: WarenkostenEntryInput,
  grenze: number = WARENKOSTEN_GRENZE_DEFAULT,
): WarenKategorie {
  const vomKonto = kategorieFromKonto(entry.warenkonto, grenze);
  if (vomKonto !== 'Sonstiges') return vomKonto; // Warenkonto → autoritativ
  const konto = entry.warenkonto;
  if (konto === 'Depot') return 'Sonstiges'; // Pfand: neutral, nie in Quote
  if (!konto || !Number.isFinite(parseInt(konto, 10))) {
    // Legacy-/Pseudo-Konto («offen»): zählt als Warenkosten → in die Quote.
    return entry.kategorie ?? 'Food';
  }
  return 'Sonstiges'; // numerisch, aber ausserhalb 4000–Grenze
}

/**
 * Kategorie eines Kontos: explizite Konto-Kategorie (Stammdaten) vor
 * Nummernkreis-Heuristik. Pure — nimmt die Konten-Liste als Parameter.
 */
export function kontoKategorie(
  value: string,
  konten: { value: string; kategorie?: WarenKategorie }[],
  grenze: number = WARENKOSTEN_GRENZE_DEFAULT,
): WarenKategorie {
  return konten.find(k => k.value === value)?.kategorie ?? kategorieFromKonto(value, grenze);
}

/** Gehört die Kategorie in die Warenkostenquote? (Food/Beverage = ja) */
export function istInQuote(kategorie: WarenKategorie): boolean {
  return kategorie === 'Food' || kategorie === 'Beverage';
}

// ─── Summen ───────────────────────────────────────────────────────────────────

export interface WarenkostenPerEntry {
  id: string;
  kategorie: WarenKategorie;
  /** Fliesst dieser Eintrag in die Warenkostenquote ein? (Food/Beverage) */
  imQuote: boolean;
}

export interface WarenkostenTotals {
  foodNet: number;
  beverageNet: number;
  sonstigeNet: number;
  /** relevante Warenkosten = Food + Beverage (Basis der Quote) */
  relevantNet: number;
  /** Gesamtsumme inkl. Sonstiges (nur für Info/„Total", NICHT für die Quote) */
  totalNet: number;
  perEntry: WarenkostenPerEntry[];
}

/**
 * Aggregiert Netto-Beträge je Kategorie. `relevantNet` = Food + Beverage ist
 * die alleinige Basis der Warenkostenquote; `sonstigeNet` wird separat geführt
 * und fliesst NICHT in `relevantNet` ein.
 */
export function computeWarenkostenTotals(
  entries: WarenkostenEntryInput[],
  grenze: number = WARENKOSTEN_GRENZE_DEFAULT,
): WarenkostenTotals {
  let foodNet = 0;
  let beverageNet = 0;
  let sonstigeNet = 0;
  const perEntry: WarenkostenPerEntry[] = [];

  for (const e of entries) {
    const kategorie = kategorieOf(e, grenze);
    const net = e.amountNet ?? 0;
    if (kategorie === 'Food') foodNet += net;
    else if (kategorie === 'Beverage') beverageNet += net;
    else sonstigeNet += net;
    perEntry.push({ id: e.id, kategorie, imQuote: istInQuote(kategorie) });
  }

  const relevantNet = foodNet + beverageNet;
  return {
    foodNet,
    beverageNet,
    sonstigeNet,
    relevantNet,
    totalNet: relevantNet + sonstigeNet,
    perEntry,
  };
}

/**
 * Warenkostenquote in PROZENT (unrundiert). `null`, wenn keine gültige
 * Umsatzbasis vorliegt (Umsatz ≤ 0 / nicht gesetzt) — NIE 0 % als Ersatz.
 */
export function warenkostenQuote(
  relevantNet: number,
  revenue: number | null | undefined,
): number | null {
  if (revenue == null || !Number.isFinite(revenue) || revenue <= 0) return null;
  return (relevantNet / revenue) * 100;
}

/**
 * VERKAUFSBASIERTE WES-Quote in PROZENT (unrundiert): Stammdaten-WES der
 * VERKAUFTEN Artikel ÷ Verkaufsumsatz (Verkaufs-Dashboard, Produkt-Sichten).
 *
 * BEWUSST eine ANDERE Kennzahl als die operative `warenkostenQuote`
 * (erfasste Rechnungen Food+Beverage ÷ Umsatz) — nie gleichsetzen, nie
 * quer-mappen. Zentral hier definiert, damit alle Verkaufsansichten
 * (KPI-Karten, Tabellen, Excel-/PDF-Export) IDENTISCH rechnen.
 *
 * `null`, wenn keine gültige Basis vorliegt (Umsatz ≤ 0 oder WES ≤ 0) —
 * NIE 0 % als Ersatz (fehlend ≠ 0).
 */
export function verkaufsWesQuote(
  wes: number | null | undefined,
  revenue: number | null | undefined,
): number | null {
  if (revenue == null || !Number.isFinite(revenue) || revenue <= 0) return null;
  if (wes == null || !Number.isFinite(wes) || wes <= 0) return null;
  return (wes / revenue) * 100;
}

// ─── Vergleich Warenkosten vs. Erfolgsrechnung ────────────────────────────────

/**
 * Status-Schwellen für die Abweichung (in PROZENTPUNKTEN der Quote):
 *   |diff| ≤ okPp    → 'ok'      (Übereinstimmend)
 *   |diff| ≤ warnPp  → 'warn'    (geringe Abweichung)
 *   sonst            → 'critical'(auffällige Abweichung)
 */
export const ER_VERGLEICH_THRESHOLDS = { okPp: 0.5, warnPp: 2.0 } as const;

export type ErVergleichStatus = 'ok' | 'warn' | 'critical' | 'none';

/** FIBU-/Erfolgsrechnungs-Werte (aus der pl-engine, NICHT nachträglich faktorisiert). */
export interface ErInput {
  /** Wareneinsatz Küche (cogs_food) */
  cogsFood: number;
  /** Wareneinsatz Getränke (cogs_bev) */
  cogsBev: number;
  /** Warenaufwand Diverses (cogs_other) — nur Info, NICHT in relevanter Quote */
  cogsOther: number;
  /** Betriebsertrag netto (net_revenue) — gemeinsame Umsatzbasis; null = unbekannt */
  revenue: number | null;
}

export interface ErVergleich {
  // A) Berechnete Warenkosten (operativ, Food+Beverage)
  calcFood: number;
  calcBev: number;
  calcTotal: number;
  calcQuote: number | null;
  // B) Erfolgsrechnung Warenaufwand (FIBU, Food+Beverage; Diverses separat)
  erFood: number;
  erBev: number;
  erOther: number;
  erTotal: number;
  erQuote: number | null;
  // C) Differenz (ER − berechnet)
  diffChf: number | null;
  diffPp: number | null;
  status: ErVergleichStatus;
  /** Gemeinsame Umsatzbasis (Betriebsertrag netto) */
  revenue: number | null;
  /** Ist eine Erfolgsrechnung für den Zeitraum importiert? */
  hasEr: boolean;
}

/**
 * Stellt berechnete Warenkosten (operativ, Food+Beverage) dem FIBU-Warenaufwand
 * (cogs_food + cogs_bev) gegenüber. BEIDE Quoten nutzen dieselbe Umsatzbasis
 * (Betriebsertrag netto der Erfolgsrechnung) — so misst die Differenz die
 * Kostenabweichung, nicht eine Umsatz-Verzerrung.
 *
 * @param calcFood/calcBev  berechnete (operative) Warenkosten netto
 * @param er                FIBU-Werte; `null` = keine Erfolgsrechnung importiert
 */
export function buildErVergleich(params: {
  calcFood: number;
  calcBev: number;
  er: ErInput | null;
}): ErVergleich {
  const { calcFood, calcBev, er } = params;
  const calcTotal = calcFood + calcBev;
  const hasEr = er !== null;
  const revenue = er?.revenue ?? null;

  const erFood = er?.cogsFood ?? 0;
  const erBev = er?.cogsBev ?? 0;
  const erOther = er?.cogsOther ?? 0;
  const erTotal = erFood + erBev;

  const calcQuote = warenkostenQuote(calcTotal, revenue);
  const erQuote = warenkostenQuote(erTotal, revenue);

  let diffChf: number | null = null;
  let diffPp: number | null = null;
  let status: ErVergleichStatus = 'none';

  if (hasEr) {
    diffChf = erTotal - calcTotal;
    if (calcQuote !== null && erQuote !== null) {
      diffPp = erQuote - calcQuote;
      const abs = Math.abs(diffPp);
      status =
        abs <= ER_VERGLEICH_THRESHOLDS.okPp
          ? 'ok'
          : abs <= ER_VERGLEICH_THRESHOLDS.warnPp
            ? 'warn'
            : 'critical';
    }
  }

  return {
    calcFood,
    calcBev,
    calcTotal,
    calcQuote,
    erFood,
    erBev,
    erOther,
    erTotal,
    erQuote,
    diffChf,
    diffPp,
    status,
    revenue,
    hasEr,
  };
}

/** Deutsches Status-Label für die Abweichung. */
export function erVergleichStatusLabel(status: ErVergleichStatus): string {
  switch (status) {
    case 'ok':       return 'Übereinstimmend';
    case 'warn':     return 'geringe Abweichung';
    case 'critical': return 'auffällige Abweichung';
    default:         return 'Keine Erfolgsrechnung';
  }
}
