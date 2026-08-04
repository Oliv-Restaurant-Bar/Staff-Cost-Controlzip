/**
 * kpi-catalog.ts — Management-KPI-Katalog (REINE LOGIK, Ebenen-Modell).
 * =====================================================================
 * Zentrale, feste Definition aller Management-KPIs der Startseite («/») nach
 * dem 3-Ebenen-Controlling-Modell:
 *   Ebene 1 (Management)  = dieser Katalog: 16 kompakte KPIs, in < 1 Minute
 *                           erfassbar (4 Karten + Tabelle).
 *   Ebene 2 (Analyse)     = `analyseRoute`: bestehende Analyse-Seite der KPI
 *                           (Erfolgsrechnung, Kennzahlen-Bericht, WES-Analyse …).
 *   Ebene 3 (Detail)      = `detailRoute`: bestehende Detail-/Beleg-Ebene
 *                           (Tagesansicht/Z-Bericht, Warenrechnungen, Produkt,
 *                           Tagesabschluss, Dienstplan …).
 *
 * ARCHITEKTUR (verbindlich):
 *  - ADDITIVE Erweiterung der Financial-Metrics-Registry: alle P&L-KPIs
 *    delegieren 1:1 an `getFinancialMetricValues` (EIN computePLForMonth) —
 *    die Registry selbst wird NICHT verändert.
 *  - Nicht-P&L-KPIs (Gäste, Durchschnittsbon, Umsatz/Gast, Verkaufs-WES,
 *    Produktivität, Tagesabschluss) lesen NUR bestehende Quellen; sämtliches
 *    IO liegt beim Aufrufer (Hook) — dieses Modul ist DOM- und Supabase-frei.
 *  - Fehlend = null («—»), NIE 0. Quellen, die 0 als «keine Daten» liefern
 *    (gn-personen-db), werden hier auf null abgebildet.
 *  - Ampeln NUR über bestehende Ton-Regeln (warenPctTone, personalPctTone,
 *    vollstaendigkeitTone, Bank-Benchmark-Regel). KPIs ohne bestehende
 *    Schwelle bleiben neutral — es werden KEINE neuen Schwellen erfunden.
 *  - Zielwerte: Die Ziel-Personalquote wird WEITER zentral im Budget gepflegt
 *    (EINE Definition appweit) — dieser Katalog zeigt sie nur an. Fixe
 *    Schwellen stammen wörtlich aus den zentralen Ton-Helfern/Benchmarks.
 */

import {
  getFinancialMetricValues,
  getGatedFinancialMetricValues,
  getFinancialMetricMissingDependencies,
  getFinancialMetricLabel,
  type FinancialMetricId,
  type FinancialMetricRegistryInput,
  type FinancialMetricValues,
} from './financial-metrics';
import { warenPctTone, personalPctTone, vollstaendigkeitTone, type ExportTone } from './reporting-export';
import { BANK_BENCHMARKS, BANK_BENCHMARK_TOLERANCE_PP } from './bank-investor-analysis';

// ─── Typen ───────────────────────────────────────────────────────────────────

export type KpiId =
  | 'umsatz'
  | 'warenkosten'
  | 'warenquote'
  | 'bruttogewinn'
  | 'personalkosten'
  | 'personalquote'
  | 'ebitda'
  | 'ebitda_marge'
  | 'ebit'
  | 'ebit_marge'
  | 'gaeste'
  | 'durchschnittsbon'
  | 'umsatz_pro_gast'
  | 'wes_quote_verkauf'
  | 'produktivitaet'
  | 'tagesabschluss_quote';

export type KpiEinheit = 'chf' | 'pct' | 'anzahl' | 'chf_pro_gast' | 'chf_pro_stunde';

/** Quellen-Badge (Anzeige) — woher stammt der IST-Wert fachlich. */
export type KpiQuelle =
  | 'erfolgsrechnung' // FIBU / P&L-Engine (Financial-Metrics-Registry)
  | 'gastronovi'      // Gastronovi KPI-/Personen-Importe (Supabase gn_*)
  | 'dienstplan'      // Arbeitszeiten (Mirus/manuell erfasste Ist-Stunden)
  | 'tagesabschluss'  // Tagesabschluss-/Adyen-Abstimmungs-Blob
  | 'berechnet';      // Abgeleitet aus mehreren bestehenden Quellen

export const KPI_QUELLE_LABEL: Record<KpiQuelle, string> = {
  erfolgsrechnung: 'Erfolgsrechnung',
  gastronovi: 'Gastronovi',
  dienstplan: 'Arbeitszeiten',
  tagesabschluss: 'Tagesabschluss',
  berechnet: 'Berechnet',
};

/** Feste KPI-Definition (User-Vorgabe: alle Felder Pflicht, «—» wo nicht definiert). */
export interface KpiDefinition {
  id: KpiId;
  name: string;
  beschreibung: string;
  einheit: KpiEinheit;
  quelle: KpiQuelle;
  /** Datenquelle (SSOT) als lesbarer Text. */
  datenquelle: string;
  /** Berechnungsformel als lesbarer Text. */
  formel: string;
  /** Wann aktualisiert sich der Wert. */
  aktualisierung: string;
  /** Fachlich verantwortlich. */
  verantwortlich: string;
  /** Zielwert-Text (aus bestehenden Regeln); null = kein Ziel definiert. */
  zielText: string | null;
  /** Warnschwelle-Text; null = keine definiert. */
  warnText: string | null;
  /** Kritische Schwelle-Text; null = keine definiert. */
  kritischText: string | null;
  /** Ebene 2: bestehende Analyse-Seite. */
  analyseRoute: string | null;
  analyseLabel: string | null;
  /** Ebene 3: bestehende Detail-/Beleg-Ebene. */
  detailRoute: string | null;
  detailLabel: string | null;
  /** Delegation an die Financial-Metrics-Registry (P&L-KPIs). */
  registryId?: FinancialMetricId;
  /** Budget-/VJ-Spalten fachlich vorhanden? (Registry-KPIs: ja) */
  hatBudgetVj: boolean;
  /** Export-Profile, in denen die KPI erscheint. */
  export: { geschaeftsleitung: boolean; bank: boolean; investoren: boolean };
  /** Eine der 4 sichtbaren KPI-Karten (Rest in der Tabelle/MoreKpis). */
  istKarte: boolean;
}

/** Eingaben des Katalogs — sämtliches IO macht der Aufrufer (Hook). */
export interface KpiCatalogInput {
  /** Registry-Input (EIN computePLForMonth) — null = Monat nicht berechenbar. */
  financialInput: FinancialMetricRegistryInput | null;
  /** Gäste-Kennzahlen des Monats (gn-personen-db); 0/rowCount 0 = keine Daten. */
  guests: { totalGuests: number; avgRevPerGuest: number; rowCount: number } | null;
  /** Gäste-Kennzahlen des Vorjahresmonats (optional, nur Anzeige VJ-Spalte). */
  guestsVj?: { totalGuests: number; avgRevPerGuest: number; rowCount: number } | null;
  /** Durchschnittsbon des Monats (gn-personen-db). */
  avgReceipt: { avgReceipt: number; rowCount: number } | null;
  avgReceiptVj?: { avgReceipt: number; rowCount: number } | null;
  /** Produktive Ist-Stunden des Monats (Arbeitszeiten); null = keine Daten. */
  productiveHours: number | null;
  /** Verkaufsbasierter Wareneinsatz des Monats (wes-month); null = keine Daten. */
  verkaufsWes: { wesTotal: number } | null;
  /** Tagesabschluss-Stand des Monats; null = kein Abstimmungs-Blob. */
  cash: { confirmedDays: number; expectedDays: number } | null;
  /** Ziel-Personalquote (%) aus dem Budget — null = kein Ziel hinterlegt. */
  personnelRatioTarget: number | null;
}

export interface KpiValues {
  actual: number | null;
  budget: number | null;
  priorYear: number | null;
}

const NO_VALUES: KpiValues = { actual: null, budget: null, priorYear: null };

// ─── Reine Berechnungen (einzeln getestet) ───────────────────────────────────

/**
 * Produktivität = Nettoumsatz ÷ produktive Ist-Stunden (CHF/h).
 * Fehlt eine Seite oder sind die Stunden 0 → null (nie 0 erfinden).
 */
export function computeProductivity(
  netRevenue: number | null,
  productiveHours: number | null,
): number | null {
  if (netRevenue === null || productiveHours === null) return null;
  if (!(productiveHours > 0)) return null;
  return netRevenue / productiveHours;
}

/**
 * Produktive Ist-Stunden eines Monats aus Arbeitszeit-Einträgen.
 * Gleiche Semantik wie die Überstundenauswertung: produktiv = Stunden > 0
 * (Abwesenheiten liegen nicht in den Arbeitszeit-Einträgen). Keine Einträge
 * im Monat → null («keine Daten»), NIE 0.
 */
export function sumProductiveHoursForMonth(
  entries: ReadonlyArray<{ date: string; hours: number }>,
  monthKey: string, // 'YYYY-MM'
): number | null {
  let sum = 0;
  let any = false;
  for (const e of entries) {
    if (!e.date.startsWith(monthKey)) continue;
    if (!(e.hours > 0)) continue;
    sum += e.hours;
    any = true;
  }
  return any ? sum : null;
}

/**
 * Tagesabschluss-Quote (%) = bestätigte Tage ÷ erwartete Tage × 100.
 * Erwartet = Tage mit Z-Bericht-Daten (Aufrufer deckelt auf gestern).
 * 0 erwartete Tage → null (kein «100 % von nichts»).
 */
export function computeCashCompletion(
  confirmedDays: number,
  expectedDays: number,
): number | null {
  if (!(expectedDays > 0)) return null;
  return (confirmedDays / expectedDays) * 100;
}

/**
 * Bank-Benchmark-Ampel (bestehende Regel aus dem Banken-/Investorenbericht):
 * Ziel erreicht = good, innerhalb Toleranz (1.0 pp) = neutral, sonst critical.
 */
export function bankBenchmarkTone(
  benchmarkId: 'warenquote' | 'personalquote' | 'ebitda_marge' | 'ebit_marge' | 'bruttomarge',
  ist: number | null,
): 'good' | 'neutral' | 'critical' | null {
  if (ist === null) return null;
  const def = BANK_BENCHMARKS.find(b => b.id === benchmarkId);
  if (!def) return null;
  const abweichungPp = def.direction === 'below' ? def.target - ist : ist - def.target;
  if (abweichungPp >= 0) return 'good';
  if (abweichungPp >= -BANK_BENCHMARK_TOLERANCE_PP) return 'neutral';
  return 'critical';
}

// ─── Katalog ────────────────────────────────────────────────────────────────

const D = (def: KpiDefinition): KpiDefinition => def;

/**
 * Reihenfolge = Anzeige-Reihenfolge (P&L-Struktur, dann operative KPIs).
 * WICHTIG: `zielText`/`warnText`/`kritischText` geben die BESTEHENDEN
 * zentralen Schwellen wörtlich wieder — die Regel selbst lebt weiterhin
 * ausschliesslich im jeweiligen Ton-Helfer/Benchmark.
 */
export const KPI_CATALOG: ReadonlyArray<KpiDefinition> = [
  D({
    id: 'umsatz',
    name: 'Nettoumsatz',
    beschreibung: 'Gesamter Nettoumsatz des Monats (ohne MWST).',
    einheit: 'chf',
    quelle: 'erfolgsrechnung',
    datenquelle: 'Financial-Metrics-Registry (P&L-Engine, effektive ER-Monats-Records)',
    formel: 'Summe aller Ertragskonten, netto (EIN computePLForMonth)',
    aktualisierung: 'Täglich nach Z-Bericht-Import; monatlich nach ER-Import',
    verantwortlich: 'Geschäftsführung',
    zielText: 'Budget des Monats',
    warnText: null,
    kritischText: null,
    analyseRoute: '/erfolgsrechnung',
    analyseLabel: 'Erfolgsrechnung',
    detailRoute: '/tagesansicht',
    detailLabel: 'Tagesansicht (Z-Berichte)',
    registryId: 'net_revenue',
    hatBudgetVj: true,
    export: { geschaeftsleitung: true, bank: true, investoren: true },
    istKarte: true,
  }),
  D({
    id: 'warenkosten',
    name: 'Warenaufwand',
    beschreibung: 'Warenaufwand gemäss Buchhaltung (direkt + übrig).',
    einheit: 'chf',
    quelle: 'erfolgsrechnung',
    datenquelle: 'Financial-Metrics-Registry (SSoT Warenaufwand-Gruppierung)',
    formel: 'Summe Warenaufwand direkt + übrig (Kontobereiche)',
    aktualisierung: 'Monatlich nach Kosten-/ER-Import (Sage)',
    verantwortlich: 'Küchenleitung / Buchhaltung',
    zielText: 'Budget des Monats',
    warnText: null,
    kritischText: null,
    analyseRoute: '/wes-analyse',
    analyseLabel: 'WES-Analyse',
    detailRoute: '/warenrechnungen',
    detailLabel: 'Warenrechnungen (Lieferanten)',
    registryId: 'total_cogs',
    hatBudgetVj: true,
    export: { geschaeftsleitung: true, bank: true, investoren: false },
    istKarte: false,
  }),
  D({
    id: 'warenquote',
    name: 'Warenquote',
    beschreibung: 'Warenaufwand in Prozent des Nettoumsatzes.',
    einheit: 'pct',
    quelle: 'erfolgsrechnung',
    datenquelle: 'Financial-Metrics-Registry (Quote aus Rohwerten, EIN computePLForMonth)',
    formel: 'Warenaufwand ÷ Nettoumsatz × 100',
    aktualisierung: 'Monatlich nach Kosten-/ER-Import (Sage)',
    verantwortlich: 'Küchenleitung',
    zielText: '≤ 30 % (Bank-Benchmark)',
    warnText: '> 28 %',
    kritischText: '> 33 %',
    analyseRoute: '/wes-analyse',
    analyseLabel: 'WES-Analyse',
    detailRoute: '/warenrechnungen',
    detailLabel: 'Warenrechnungen (Lieferanten)',
    registryId: 'cogs_ratio',
    hatBudgetVj: true,
    export: { geschaeftsleitung: true, bank: true, investoren: false },
    istKarte: true,
  }),
  D({
    id: 'bruttogewinn',
    name: 'Bruttogewinn 1',
    beschreibung: 'Nettoumsatz abzüglich gesamter Warenaufwand.',
    einheit: 'chf',
    quelle: 'erfolgsrechnung',
    datenquelle: 'Financial-Metrics-Registry (P&L-Engine)',
    formel: 'Nettoumsatz − Warenaufwand (direkt + übrig)',
    aktualisierung: 'Monatlich nach Kosten-/ER-Import (Sage)',
    verantwortlich: 'Geschäftsführung',
    zielText: null,
    warnText: null,
    kritischText: null,
    analyseRoute: '/erfolgsrechnung',
    analyseLabel: 'Erfolgsrechnung',
    detailRoute: null,
    detailLabel: null,
    registryId: 'gross_profit_1',
    hatBudgetVj: true,
    export: { geschaeftsleitung: true, bank: true, investoren: false },
    istKarte: false,
  }),
  D({
    id: 'personalkosten',
    name: 'Personalaufwand',
    beschreibung: 'Gesamter Personalaufwand (Löhne + Sozialkosten + übriger Personalaufwand).',
    einheit: 'chf',
    quelle: 'erfolgsrechnung',
    datenquelle: 'Financial-Metrics-Registry (Buchhaltung > Dienstplan, effektive ER-Regeln)',
    formel: 'Löhne + AG-Sozialkosten + übriger Personalaufwand',
    aktualisierung: 'Monatlich nach Kosten-/ER-Import; laufend aus Dienstplan',
    verantwortlich: 'Geschäftsführung',
    zielText: 'Budget des Monats',
    warnText: null,
    kritischText: null,
    analyseRoute: '/personal-fix',
    analyseLabel: 'FIX + VARIABEL',
    detailRoute: '/personal',
    detailLabel: 'Dienstplan',
    registryId: 'total_personnel',
    hatBudgetVj: true,
    export: { geschaeftsleitung: true, bank: true, investoren: false },
    istKarte: false,
  }),
  D({
    id: 'personalquote',
    name: 'Personalquote',
    beschreibung: 'Personalaufwand in Prozent des Nettoumsatzes.',
    einheit: 'pct',
    quelle: 'erfolgsrechnung',
    datenquelle: 'Financial-Metrics-Registry (Quote aus Rohwerten, EIN computePLForMonth)',
    formel: 'Personalaufwand ÷ Nettoumsatz × 100',
    aktualisierung: 'Monatlich nach Kosten-/ER-Import; laufend aus Dienstplan',
    verantwortlich: 'Geschäftsführung',
    zielText: 'Ziel-Personalquote aus dem Budget (dort zentral pflegbar)',
    warnText: '> Ziel',
    kritischText: '> Ziel + 5 pp',
    analyseRoute: '/personal-fix',
    analyseLabel: 'FIX + VARIABEL',
    detailRoute: '/analyse',
    detailLabel: 'Soll-Ist-Analyse',
    registryId: 'personnel_ratio',
    hatBudgetVj: true,
    export: { geschaeftsleitung: true, bank: true, investoren: false },
    istKarte: true,
  }),
  D({
    id: 'ebitda',
    name: 'EBITDA',
    beschreibung: 'Betriebsergebnis vor Zinsen, Steuern und Abschreibungen.',
    einheit: 'chf',
    quelle: 'erfolgsrechnung',
    datenquelle: 'Financial-Metrics-Registry (P&L-Engine)',
    formel: 'Bruttogewinn 2 − übriger Betriebsaufwand',
    aktualisierung: 'Monatlich nach Kosten-/ER-Import (Sage)',
    verantwortlich: 'Geschäftsführung',
    zielText: 'Budget des Monats',
    warnText: null,
    kritischText: null,
    analyseRoute: '/erfolgsrechnung',
    analyseLabel: 'Erfolgsrechnung',
    detailRoute: null,
    detailLabel: null,
    registryId: 'ebitda',
    hatBudgetVj: true,
    export: { geschaeftsleitung: true, bank: true, investoren: true },
    istKarte: false,
  }),
  D({
    id: 'ebitda_marge',
    name: 'EBITDA-Marge',
    beschreibung: 'EBITDA in Prozent des Nettoumsatzes.',
    einheit: 'pct',
    quelle: 'erfolgsrechnung',
    datenquelle: 'Financial-Metrics-Registry (Quote aus Rohwerten)',
    formel: 'EBITDA ÷ Nettoumsatz × 100',
    aktualisierung: 'Monatlich nach Kosten-/ER-Import (Sage)',
    verantwortlich: 'Geschäftsführung',
    zielText: '≥ 15 % (Bank-Benchmark)',
    warnText: '< 15 % (Toleranz 1.0 pp)',
    kritischText: '< 14 %',
    analyseRoute: '/reporting',
    analyseLabel: 'Reporting',
    detailRoute: null,
    detailLabel: null,
    registryId: 'ebitda_margin',
    hatBudgetVj: true,
    export: { geschaeftsleitung: true, bank: true, investoren: true },
    istKarte: false,
  }),
  D({
    id: 'ebit',
    name: 'EBIT',
    beschreibung: 'Betriebsergebnis vor Zinsen und Steuern.',
    einheit: 'chf',
    quelle: 'erfolgsrechnung',
    datenquelle: 'Financial-Metrics-Registry (P&L-Engine)',
    formel: 'EBITDA − Abschreibungen',
    aktualisierung: 'Monatlich nach Kosten-/ER-Import (Sage)',
    verantwortlich: 'Geschäftsführung',
    zielText: 'Budget des Monats',
    warnText: null,
    kritischText: null,
    analyseRoute: '/erfolgsrechnung',
    analyseLabel: 'Erfolgsrechnung',
    detailRoute: null,
    detailLabel: null,
    registryId: 'ebit',
    hatBudgetVj: true,
    export: { geschaeftsleitung: true, bank: true, investoren: true },
    istKarte: true,
  }),
  D({
    id: 'ebit_marge',
    name: 'EBIT-Marge',
    beschreibung: 'EBIT in Prozent des Nettoumsatzes.',
    einheit: 'pct',
    quelle: 'erfolgsrechnung',
    datenquelle: 'Financial-Metrics-Registry (Quote aus Rohwerten)',
    formel: 'EBIT ÷ Nettoumsatz × 100',
    aktualisierung: 'Monatlich nach Kosten-/ER-Import (Sage)',
    verantwortlich: 'Geschäftsführung',
    zielText: '≥ 10 % (Bank-Benchmark)',
    warnText: '< 10 % (Toleranz 1.0 pp)',
    kritischText: '< 9 %',
    analyseRoute: '/reporting',
    analyseLabel: 'Reporting',
    detailRoute: null,
    detailLabel: null,
    registryId: 'ebit_margin',
    hatBudgetVj: true,
    export: { geschaeftsleitung: true, bank: true, investoren: true },
    istKarte: false,
  }),
  D({
    id: 'gaeste',
    name: 'Gäste',
    beschreibung: 'Anzahl Gäste im Monat (Gastronovi «Anzahl Personen»).',
    einheit: 'anzahl',
    quelle: 'gastronovi',
    datenquelle: 'gn_person_metrics (Import «Anzahl Personen»)',
    formel: 'Summe der Tages-Gästezahlen im Monat',
    aktualisierung: 'Wöchentlich nach Gastronovi-KPI-Import',
    verantwortlich: 'Serviceleitung',
    zielText: null,
    warnText: null,
    kritischText: null,
    analyseRoute: '/gaeste/auswertung',
    analyseLabel: 'Gäste & Reservationen',
    detailRoute: '/gaeste',
    detailLabel: 'Gäste-CRM',
    hatBudgetVj: false,
    export: { geschaeftsleitung: true, bank: false, investoren: false },
    istKarte: false,
  }),
  D({
    id: 'durchschnittsbon',
    name: 'Durchschnittsbon',
    beschreibung: 'Durchschnittlicher Bonwert (Gastronovi «Durchschnittsbon»).',
    einheit: 'chf',
    quelle: 'gastronovi',
    datenquelle: 'gn_person_metrics (Import «Durchschnittsbon»)',
    formel: 'Ø der Tageswerte «Durchschnittsbon» im Monat',
    aktualisierung: 'Wöchentlich nach Gastronovi-KPI-Import',
    verantwortlich: 'Serviceleitung',
    zielText: null,
    warnText: null,
    kritischText: null,
    analyseRoute: '/kennzahlen-bericht',
    analyseLabel: 'Kennzahlen-Bericht',
    detailRoute: null,
    detailLabel: null,
    hatBudgetVj: false,
    export: { geschaeftsleitung: true, bank: false, investoren: false },
    istKarte: false,
  }),
  D({
    id: 'umsatz_pro_gast',
    name: 'Umsatz pro Gast',
    beschreibung: 'Nettoumsatz pro Gast (Gastronovi-Personendaten).',
    einheit: 'chf_pro_gast',
    quelle: 'gastronovi',
    datenquelle: 'gn_person_metrics (Umsatz ÷ Gäste des Zeitraums)',
    formel: 'Umsatz total ÷ Anzahl Gäste',
    aktualisierung: 'Wöchentlich nach Gastronovi-KPI-Import',
    verantwortlich: 'Serviceleitung',
    zielText: null,
    warnText: null,
    kritischText: null,
    analyseRoute: '/kennzahlen-bericht',
    analyseLabel: 'Kennzahlen-Bericht',
    detailRoute: null,
    detailLabel: null,
    hatBudgetVj: false,
    export: { geschaeftsleitung: true, bank: false, investoren: false },
    istKarte: false,
  }),
  D({
    id: 'wes_quote_verkauf',
    name: 'Wareneinsatz (verkaufsbasiert)',
    beschreibung: 'Rezeptur-Wareneinsatz der verkauften Produkte in % des Nettoumsatzes — unabhängig von der FIBU-Warenquote.',
    einheit: 'pct',
    quelle: 'berechnet',
    datenquelle: 'Produkt-Verkäufe × Rezeptkosten (wes-month) ÷ Nettoumsatz (Registry)',
    formel: 'Σ (Verkaufsmenge × Rezept-WES) ÷ Nettoumsatz × 100',
    aktualisierung: 'Nach Produkt-/Verkaufsdaten-Import',
    verantwortlich: 'Küchenleitung',
    zielText: null,
    warnText: null,
    kritischText: null,
    analyseRoute: '/wes-analyse',
    analyseLabel: 'WES-Analyse',
    detailRoute: '/produkt-analyse',
    detailLabel: 'Produkt-Analyse',
    hatBudgetVj: false,
    export: { geschaeftsleitung: true, bank: false, investoren: false },
    istKarte: false,
  }),
  D({
    id: 'produktivitaet',
    name: 'Produktivität',
    beschreibung: 'Nettoumsatz pro produktiver Ist-Arbeitsstunde.',
    einheit: 'chf_pro_stunde',
    quelle: 'dienstplan',
    datenquelle: 'Nettoumsatz (Registry) ÷ produktive Ist-Stunden (Arbeitszeiten Mirus/manuell)',
    formel: 'Nettoumsatz ÷ produktive Ist-Stunden (Stunden > 0, ohne Abwesenheiten)',
    aktualisierung: 'Nach Mirus-Import bzw. Arbeitszeit-Erfassung',
    verantwortlich: 'Geschäftsführung',
    zielText: null,
    warnText: null,
    kritischText: null,
    analyseRoute: '/kennzahlen-bericht',
    analyseLabel: 'Kennzahlen-Bericht',
    detailRoute: '/personal',
    detailLabel: 'Dienstplan',
    hatBudgetVj: false,
    export: { geschaeftsleitung: true, bank: false, investoren: false },
    istKarte: false,
  }),
  D({
    id: 'tagesabschluss_quote',
    name: 'Tagesabschlüsse geprüft',
    beschreibung: 'Anteil der bestätigten Tagesabschlüsse an den erfassten Tagen des Monats (Cash-Kontrolle).',
    einheit: 'pct',
    quelle: 'tagesabschluss',
    datenquelle: 'Tagesabschluss-/Adyen-Abstimmungs-Blob (Bestätigungen «Abschluss geprüft»)',
    formel: 'Bestätigte Tage ÷ erfasste Tage (bis gestern) × 100',
    aktualisierung: 'Laufend beim Bestätigen der Tagesabschlüsse',
    verantwortlich: 'Buchhaltung / Serviceleitung',
    zielText: '100 %',
    warnText: '< 80 %',
    kritischText: '< 50 %',
    analyseRoute: '/tagesabschluesse',
    analyseLabel: 'Tagesabschlüsse',
    detailRoute: '/umsatzabstimmung',
    detailLabel: 'Umsatzabstimmung',
    hatBudgetVj: false,
    export: { geschaeftsleitung: true, bank: false, investoren: false },
    istKarte: false,
  }),
];

export const KPI_IDS: ReadonlyArray<KpiId> = KPI_CATALOG.map(d => d.id);

export function getKpiDefinition(id: KpiId): KpiDefinition {
  const def = KPI_CATALOG.find(d => d.id === id);
  if (!def) throw new Error(`Unbekannte KPI: ${id}`);
  return def;
}

// ─── Wert-Auflösung (fehlend = null, NIE 0) ─────────────────────────────────

/** gn-personen-db liefert 0 bei «keine Daten» → hier auf null abbilden. */
function positiveOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && v > 0 ? v : null;
}

export function getKpiValues(id: KpiId, input: KpiCatalogInput): KpiValues {
  const def = getKpiDefinition(id);

  // P&L-KPIs: 1:1-Delegation an die Registry (EIN computePLForMonth),
  // mit Dependency-Gate PRO SPALTE (financial-metrics): fehlt eine
  // erforderliche Kostenkomponente, ist die Kennzahl «—» — NIE ein aus
  // impliziten Nullen entstandener Scheinwert (z. B. EBIT ≡ Umsatz).
  if (def.registryId) {
    if (!input.financialInput) return NO_VALUES;
    const v: FinancialMetricValues = getGatedFinancialMetricValues(def.registryId, input.financialInput);
    return { actual: v.actual, budget: v.budget, priorYear: v.priorYear };
  }

  switch (id) {
    case 'gaeste': {
      const g = input.guests;
      const vj = input.guestsVj ?? null;
      return {
        actual: g && g.rowCount > 0 ? positiveOrNull(g.totalGuests) : null,
        budget: null,
        priorYear: vj && vj.rowCount > 0 ? positiveOrNull(vj.totalGuests) : null,
      };
    }
    case 'durchschnittsbon': {
      const b = input.avgReceipt;
      const vj = input.avgReceiptVj ?? null;
      return {
        actual: b && b.rowCount > 0 ? positiveOrNull(b.avgReceipt) : null,
        budget: null,
        priorYear: vj && vj.rowCount > 0 ? positiveOrNull(vj.avgReceipt) : null,
      };
    }
    case 'umsatz_pro_gast': {
      const g = input.guests;
      const vj = input.guestsVj ?? null;
      return {
        actual: g && g.rowCount > 0 ? positiveOrNull(g.avgRevPerGuest) : null,
        budget: null,
        priorYear: vj && vj.rowCount > 0 ? positiveOrNull(vj.avgRevPerGuest) : null,
      };
    }
    case 'wes_quote_verkauf': {
      const wes = input.verkaufsWes;
      const netRevenue = input.financialInput
        ? getFinancialMetricValues('net_revenue', input.financialInput).actual
        : null;
      if (!wes || !(wes.wesTotal > 0) || netRevenue === null || !(netRevenue > 0)) return NO_VALUES;
      return { actual: (wes.wesTotal / netRevenue) * 100, budget: null, priorYear: null };
    }
    case 'produktivitaet': {
      const netRevenue = input.financialInput
        ? getFinancialMetricValues('net_revenue', input.financialInput).actual
        : null;
      return {
        actual: computeProductivity(netRevenue, input.productiveHours),
        budget: null,
        priorYear: null,
      };
    }
    case 'tagesabschluss_quote': {
      const c = input.cash;
      if (!c) return NO_VALUES;
      return {
        actual: computeCashCompletion(c.confirmedDays, c.expectedDays),
        budget: null,
        priorYear: null,
      };
    }
    default:
      return NO_VALUES;
  }
}

// ─── Trend (Anzeige-Ableitung auf Rohwerten) ────────────────────────────────

/**
 * Fachliche Wirkungsrichtung der KPI (analog Jahresvergleich):
 *  - hoch_gut   → mehr ist besser (Umsatz, Ergebnis, Produktivität …)
 *  - runter_gut → weniger ist besser (Quoten: Warenquote, Personalquote, WES)
 *  - neutral    → absolute Aufwand-CHF ohne Bewertung (Waren-/Personalkosten)
 */
export type KpiWirkung = 'hoch_gut' | 'runter_gut' | 'neutral';

export const KPI_WIRKUNG: Record<KpiId, KpiWirkung> = {
  umsatz: 'hoch_gut',
  warenkosten: 'neutral',
  warenquote: 'runter_gut',
  bruttogewinn: 'hoch_gut',
  personalkosten: 'neutral',
  personalquote: 'runter_gut',
  ebitda: 'hoch_gut',
  ebitda_marge: 'hoch_gut',
  ebit: 'hoch_gut',
  ebit_marge: 'hoch_gut',
  gaeste: 'hoch_gut',
  durchschnittsbon: 'hoch_gut',
  umsatz_pro_gast: 'hoch_gut',
  wes_quote_verkauf: 'runter_gut',
  produktivitaet: 'hoch_gut',
  tagesabschluss_quote: 'hoch_gut',
};

export interface KpiTrend {
  direction: 'up' | 'down' | 'flat';
  /** Bewertung der Richtung nach KPI_WIRKUNG (Aufwand-CHF bleibt neutral). */
  tone: 'good' | 'critical' | 'neutral';
  /** Roh-Delta: pp bei Prozent-KPIs, sonst relative Veränderung in % (Basis ≠ 0). */
  delta: number;
  deltaKind: 'pp' | 'pct';
  basis: 'budget' | 'vorjahr';
}

/**
 * Trend der KPI gegen Budget (bevorzugt) bzw. Vorjahr — reine Anzeige-
 * Ableitung auf Rohwerten (Rundung erst in der UI):
 *  - Prozent-KPIs: Δ in pp (keine Division — bestehende Quoten-Regel).
 *  - Übrige: relative Veränderung in %; Basis 0 ⇒ null (bestehende
 *    «Δ% mit Basis 0 → null»-Regel), nie Scheinwerte.
 *  - IST oder Basis fehlt ⇒ null (fehlend ≠ 0, kein Trend erfinden).
 */
export function getKpiTrend(id: KpiId, values: KpiValues): KpiTrend | null {
  if (values.actual === null) return null;
  const def = getKpiDefinition(id);
  let basisKind: 'budget' | 'vorjahr';
  let base: number;
  if (values.budget !== null) {
    basisKind = 'budget';
    base = values.budget;
  } else if (values.priorYear !== null) {
    basisKind = 'vorjahr';
    base = values.priorYear;
  } else {
    return null;
  }

  let delta: number;
  let deltaKind: 'pp' | 'pct';
  if (def.einheit === 'pct') {
    delta = values.actual - base;
    deltaKind = 'pp';
  } else {
    if (base === 0) return null;
    delta = ((values.actual - base) / Math.abs(base)) * 100;
    deltaKind = 'pct';
  }

  const direction: KpiTrend['direction'] = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const wirkung = KPI_WIRKUNG[id];
  const tone: KpiTrend['tone'] =
    direction === 'flat' || wirkung === 'neutral'
      ? 'neutral'
      : (direction === 'up') === (wirkung === 'hoch_gut')
        ? 'good'
        : 'critical';
  return { direction, tone, delta, deltaKind, basis: basisKind };
}

// ─── Ampel (NUR bestehende Regeln, Rohwert entscheidet) ─────────────────────

export type KpiTone = ExportTone | 'neutral';

/**
 * Ampel-Ton der KPI aus den BESTEHENDEN zentralen Regeln:
 *  - Warenquote → warenPctTone (> 33 kritisch, > 28 Achtung)
 *  - Personalquote → personalPctTone mit Budget-Ziel (ohne Ziel keine Ampel)
 *  - Tagesabschluss-Quote → vollstaendigkeitTone (≥ 80 gut, ≥ 50 Achtung)
 *  - EBITDA-/EBIT-Marge → Bank-Benchmark-Regel (Ziel ± Toleranz 1.0 pp)
 * Alle übrigen KPIs: neutral (keine bestehende Schwelle — nichts erfinden).
 */
export function getKpiTone(id: KpiId, actual: number | null, input: KpiCatalogInput): KpiTone {
  if (actual === null) return 'neutral';
  switch (id) {
    case 'warenquote':
      return warenPctTone(actual);
    case 'personalquote':
      return input.personnelRatioTarget !== null
        ? personalPctTone(actual, input.personnelRatioTarget)
        : 'neutral';
    case 'tagesabschluss_quote':
      return vollstaendigkeitTone(actual);
    case 'ebitda_marge': {
      const t = bankBenchmarkTone('ebitda_marge', actual);
      return t === null ? 'neutral' : t === 'neutral' ? 'warn' : t;
    }
    case 'ebit_marge': {
      const t = bankBenchmarkTone('ebit_marge', actual);
      return t === null ? 'neutral' : t === 'neutral' ? 'warn' : t;
    }
    default:
      return 'neutral';
  }
}

// ─── Eigene Zielwerte (kpi_targets_v1) — bewusste, dokumentierte Ausnahme ───

/**
 * KPIs OHNE eigenen Zielwert: Die Ziel-Personalquote wird WEITER zentral im
 * Budget gepflegt (EINE Definition appweit) — hier kein zweites Ziel.
 */
export const KPI_TARGET_EXCLUDED: ReadonlySet<KpiId> = new Set<KpiId>(['personalquote']);

export type KpiZielRichtung = 'mindestens' | 'hoechstens';

/**
 * Richtung des eigenen Zielwerts aus der Wirkungsrichtung:
 * hoch_gut → «mindestens erreichen»; runter_gut/neutral (Aufwand-CHF als
 * Kostendach) → «höchstens».
 */
export function getKpiZielRichtung(id: KpiId): KpiZielRichtung {
  return KPI_WIRKUNG[id] === 'hoch_gut' ? 'mindestens' : 'hoechstens';
}

/**
 * Ampel mit optionalem eigenem Zielwert (kpi_targets_v1): Ein explizit vom
 * User gesetzter Zielwert ersetzt für DIESE KPI die Standard-Ampel
 * (Ziel erreicht = good, verfehlt = warn) — bewusste, dokumentierte Ausnahme
 * zur Regel «Ampeln nur über bestehende Ton-Helfer». Ohne Zielwert (oder für
 * ausgeschlossene KPIs) gilt unverändert getKpiTone. Der Rohwert entscheidet;
 * der Aufrufer löst den Zielwert auf (dieses Modul bleibt Blob-frei).
 */
export function getKpiToneWithTarget(
  id: KpiId,
  actual: number | null,
  input: KpiCatalogInput,
  userTarget: number | null,
): KpiTone {
  if (actual !== null && userTarget !== null && !KPI_TARGET_EXCLUDED.has(id)) {
    const erreicht =
      getKpiZielRichtung(id) === 'mindestens' ? actual >= userTarget : actual <= userTarget;
    return erreicht ? 'good' : 'warn';
  }
  return getKpiTone(id, actual, input);
}

// ─── Laufender Monat + Unvollständigkeits-Hinweise (reine Anzeige-Helfer) ───

/**
 * Laufender Monat = gewählter Monat ist der Kalendermonat von `now`.
 * User-Vorgabe: keine anteilige Budget-Hochrechnung — das vollständige
 * Monatsbudget bleibt sichtbar, wird aber klar gekennzeichnet
 * («Laufender Monat – Vergleich mit vollständigem Monatsbudget»).
 */
export function isRunningMonth(year: number, month: number, now: Date): boolean {
  return year === now.getFullYear() && month === now.getMonth() + 1;
}

/**
 * «Noch nicht vollständig»-Hinweis für eine P&L-KPI: Labels der fehlenden
 * IST-Komponenten (Dependency-Gate der Registry). null = kein Hinweis
 * (vollständig, keine Registry-KPI oder gar kein Registry-Input — dann
 * fehlt schlicht der ganze Monat, kein Komponenten-Hinweis).
 */
export function getKpiIncompleteHint(id: KpiId, input: KpiCatalogInput): string | null {
  const def = getKpiDefinition(id);
  if (!def.registryId || !input.financialInput) return null;
  const missing = getFinancialMetricMissingDependencies(def.registryId, input.financialInput, 'actual');
  if (missing.length === 0) return null;
  const labels = missing.map(getFinancialMetricLabel);
  return `Noch nicht vollständig — es ${labels.length === 1 ? 'fehlt' : 'fehlen'}: ${labels.join(', ')}`;
}
