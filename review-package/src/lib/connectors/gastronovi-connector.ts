/**
 * Gastronovi Revenue Import Connector – Vorbereitung
 * ====================================================
 *
 * Dieses Modul legt die Code-Struktur für einen späteren
 * Umsatz-Import aus dem gastronovi-Kassensystem fest.
 *
 * Stand: NUR VORBEREITUNG – keine echte API-Verbindung.
 *
 * Was gastronovi liefern kann (Quellen):
 *   1. Tagesberichte als CSV (manueller Export)
 *   2. Monatsberichte als PDF
 *   3. REST-API (gastronovi GO / gastronovi API v2) – erfordert API-Key
 *
 * Geplanter Datenfluss:
 *   gastronovi → Tages-/Monatsbericht → parseGastronoviRevenue()
 *               → RevenueImportRecord[] → buildRevenueMonthRecord()
 *               → saveMonth() (reporting-store)
 *
 * Für die erste Integration empfiehlt sich der CSV-Export-Weg,
 * weil er kein API-Key-Setup erfordert und sofort testbar ist.
 *
 * ──────────────────────────────────────────────────────────────────
 * NÄCHSTE SCHRITTE FÜR DEN ENTWICKLER:
 *   1. API-Key in Supabase Secret hinterlegen: GASTRONOVI_API_KEY
 *   2. Base-URL konfigurieren: GASTRONOVI_API_URL
 *   3. buildRevenueMonthRecord() mit echten Daten testen
 *   4. parseGastronoviCSV() mit realem Export-File testen
 * ──────────────────────────────────────────────────────────────────
 */

import type { MonthlyFinancialRecord } from '@/types/reporting';

// ─── Typen ────────────────────────────────────────────────────────────────────

/**
 * Ein einzelner Umsatzdatensatz, wie ihn gastronovi liefert.
 * Entspricht typischerweise einer Zeile im Tagesbericht.
 */
export interface GastronoviRevenueRecord {
  /** Buchungsdatum (ISO-String oder DD.MM.YYYY) */
  date: string;
  /** Umsatzkategorie aus gastronovi, z.B. "Speise", "Getränke", "Bar" */
  category: string;
  /** Nettoumsatz (ohne MwSt.) in CHF */
  netAmount: number;
  /** MWST-Betrag in CHF */
  vatAmount: number;
  /** Bruttoumsatz in CHF */
  grossAmount: number;
  /** Tisch-/Bereich-Identifier aus gastronovi (optional) */
  section?: string;
  /** Zahlungsart, z.B. "Bar", "Karte", "Rechnung" */
  paymentMethod?: string;
}

/**
 * Zusammenfassung für einen Monat nach der Aggregation.
 */
export interface GastronoviMonthSummary {
  year: number;
  month: number;
  /** Gesamtnettoumsatz Speise */
  foodRevenue: number;
  /** Gesamtnettoumsatz Getränke */
  beverageRevenue: number;
  /** Sonstiger Umsatz */
  otherRevenue: number;
  /** Gesamtnettoumsatz (alle Kategorien) */
  totalRevenue: number;
  /** Anzahl Buchungszeilen aus dem Export */
  recordCount: number;
  /** Warnungen (z.B. unbekannte Kategorien) */
  warnings: string[];
}

/**
 * Konfiguration für den gastronovi-Connector.
 * Muss aus Umgebungsvariablen/Secrets geladen werden.
 *
 * @todo Implementierung sobald API-Key verfügbar
 */
export interface GastronoviConnectorConfig {
  /** REST-API Base-URL, z.B. 'https://api.gastronovi.com/v2' */
  apiUrl: string;
  /** API-Key (aus Supabase Secret: GASTRONOVI_API_KEY) */
  apiKey: string;
  /** Standort-ID in gastronovi (Restaurant-ID) */
  locationId: string;
}

// ─── Kategorie-Mapping gastronovi → P&L ──────────────────────────────────────

/**
 * Ordnet gastronovi-Kategorienamen der P&L-Kontonummer zu.
 * Kann später im Admin-UI konfigurierbar gemacht werden.
 *
 * Typische gastronovi-Kategorien für ein Restaurant:
 *   Speise, Essen, Food, Kitchen → 3000 (Speiseumsatz)
 *   Getränke, Drinks, Bar, Wein  → 3001 (Getränkeumsatz)
 *   Sonstiges, Diverses          → 3008 (Sonstiger Betriebsertrag)
 */
export const GASTRONOVI_CATEGORY_MAP: Record<string, string> = {
  // Speise
  speise:    '3000',
  essen:     '3000',
  food:      '3000',
  kitchen:   '3000',
  küche:     '3000',
  kueche:    '3000',
  // Getränke
  getränke:  '3001',
  getraenke: '3001',
  drinks:    '3001',
  bar:       '3001',
  wein:      '3001',
  wine:      '3001',
  bier:      '3001',
  // Diverses
  sonstiges: '3008',
  diverses:  '3008',
  other:     '3008',
  catering:  '3008',
  take_away: '3008',
};

/**
 * Löst eine gastronovi-Kategorie in eine Kontonummer auf.
 * Fallback: '3008' (Sonstiger Betriebsertrag).
 */
export function resolveGastronoviCategory(category: string): string {
  const key = category.toLowerCase().trim().replace(/[\s-]/g, '_');
  return GASTRONOVI_CATEGORY_MAP[key] ?? '3008';
}

// ─── CSV-Parser (gastronovi Tagesbericht-Export) ──────────────────────────────

/**
 * Typisches CSV-Format des gastronovi Tagesberichts:
 *
 *   Datum;Kategorie;Netto;MwSt;Brutto;Zahlungsart
 *   01.03.2026;Speise;1250.00;95.00;1345.00;Karte
 *   01.03.2026;Getränke;480.00;38.40;518.40;Bar
 *
 * HINWEIS: Das genaue Format hängt von der gastronovi-Version ab.
 * Diese Funktion muss mit einem echten Export-File validiert werden.
 *
 * @param csvText - Roher CSV-Inhalt
 * @returns Geparste Datensätze
 */
export function parseGastronoviCSV(csvText: string): {
  records: GastronoviRevenueRecord[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const records: GastronoviRevenueRecord[] = [];

  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    warnings.push('CSV ist leer oder enthält nur die Kopfzeile');
    return { records, warnings };
  }

  const separator = lines[0].includes(';') ? ';' : ',';
  const headers   = lines[0].split(separator).map(h => h.trim().toLowerCase());

  // Spaltenindices erkennen
  const dateIdx    = headers.findIndex(h => /datum|date/.test(h));
  const catIdx     = headers.findIndex(h => /kategorie|category|art/.test(h));
  const netIdx     = headers.findIndex(h => /netto|net/.test(h));
  const vatIdx     = headers.findIndex(h => /mwst|vat|steuer/.test(h));
  const grossIdx   = headers.findIndex(h => /brutto|gross|gesamt/.test(h));
  const payIdx     = headers.findIndex(h => /zahlung|payment|method/.test(h));

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(separator).map(c => c.trim().replace(/^["']|["']$/g, ''));
    if (cells.length < 3) continue;

    const parseNum = (raw: string) => {
      if (!raw) return 0;
      return parseFloat(raw.replace(/[''']/g, '').replace(',', '.')) || 0;
    };

    const net   = netIdx   >= 0 ? parseNum(cells[netIdx])   : 0;
    const vat   = vatIdx   >= 0 ? parseNum(cells[vatIdx])   : 0;
    const gross = grossIdx >= 0 ? parseNum(cells[grossIdx]) : net + vat;

    if (net === 0 && gross === 0) continue;

    records.push({
      date:          dateIdx >= 0 ? cells[dateIdx] : '',
      category:      catIdx  >= 0 ? cells[catIdx]  : 'Sonstiges',
      netAmount:     net,
      vatAmount:     vat,
      grossAmount:   gross,
      paymentMethod: payIdx >= 0 ? cells[payIdx] : undefined,
    });
  }

  if (records.length === 0) {
    warnings.push('Keine Umsatzdaten gefunden. Prüfen Sie das CSV-Format.');
  }

  return { records, warnings };
}

// ─── Monatliche Aggregation ───────────────────────────────────────────────────

/**
 * Aggregiert gastronovi-Umsatzdatensätze zu einer Monats-Zusammenfassung.
 * Alle Datensätze müssen aus demselben Monat stammen.
 */
export function aggregateGastronoviMonth(
  records: GastronoviRevenueRecord[],
  year: number,
  month: number,
): GastronoviMonthSummary {
  const warnings: string[] = [];

  let foodRevenue      = 0;
  let beverageRevenue  = 0;
  let otherRevenue     = 0;

  for (const rec of records) {
    const accountNo = resolveGastronoviCategory(rec.category);
    if (accountNo === '3000') {
      foodRevenue += rec.netAmount;
    } else if (accountNo === '3001') {
      beverageRevenue += rec.netAmount;
    } else {
      otherRevenue += rec.netAmount;
      if (!GASTRONOVI_CATEGORY_MAP[rec.category.toLowerCase()]) {
        if (!warnings.includes(`Unbekannte Kategorie: '${rec.category}'`)) {
          warnings.push(`Unbekannte Kategorie: '${rec.category}' → Sonstiger Betriebsertrag`);
        }
      }
    }
  }

  return {
    year,
    month,
    foodRevenue,
    beverageRevenue,
    otherRevenue,
    totalRevenue: foodRevenue + beverageRevenue + otherRevenue,
    recordCount: records.length,
    warnings,
  };
}

/**
 * Baut einen Partial<MonthlyFinancialRecord> aus einer gastronovi-Zusammenfassung.
 * Dieser Record kann direkt in saveMonth() übergeben werden.
 *
 * Umsatz wird in revenueActual gespeichert (Top-Level-Summe).
 * Aufschlüsselung nach Kategorie wird in expenseCategories gespeichert
 * (mit Konto-Prefix 'gnv_' damit keine Kollision mit Buchhaltungskonten).
 */
export function buildGastronoviMonthRecord(
  summary: GastronoviMonthSummary,
): Partial<MonthlyFinancialRecord> & { year: number; month: number } {
  const categories = [];

  if (summary.foodRevenue > 0) {
    categories.push({
      categoryId: 'gnv_food',
      label: 'Speiseumsatz (gastronovi)',
      amount: summary.foodRevenue,
    });
  }
  if (summary.beverageRevenue > 0) {
    categories.push({
      categoryId: 'gnv_beverage',
      label: 'Getränkeumsatz (gastronovi)',
      amount: summary.beverageRevenue,
    });
  }
  if (summary.otherRevenue > 0) {
    categories.push({
      categoryId: 'gnv_other',
      label: 'Sonstiger Umsatz (gastronovi)',
      amount: summary.otherRevenue,
    });
  }

  return {
    year:          summary.year,
    month:         summary.month,
    revenueActual: summary.totalRevenue,
    expenseCategories: categories,
  };
}

// ─── API-Connector (Stub – noch nicht implementiert) ─────────────────────────

/**
 * Placeholder für den zukünftigen REST-API-Connector zu gastronovi.
 *
 * Sobald ein API-Key verfügbar ist, kann hier die echte HTTP-Anfrage
 * implementiert werden.
 *
 * Beispiel-Endpunkte (gastronovi GO API v2):
 *   GET /reports/daily?from=2026-03-01&to=2026-03-31
 *   GET /reports/monthly?year=2026&month=3
 *
 * @todo Implementierung mit echtem API-Key
 */
export async function fetchGastronoviMonthlyReport(
  _config: GastronoviConnectorConfig,
  _year: number,
  _month: number,
): Promise<GastronoviRevenueRecord[]> {
  throw new Error(
    'Gastronovi API-Connector noch nicht implementiert. ' +
    'Bitte erst den API-Key in Supabase Secrets hinterlegen (GASTRONOVI_API_KEY) ' +
    'und die Base-URL konfigurieren (GASTRONOVI_API_URL).',
  );
}

// ─── Export-Übersicht ─────────────────────────────────────────────────────────
// Alle öffentlichen Funktionen und Typen sind bereits oben exportiert.
// Diese Datei dient als zentrale Schnittstelle für alle gastronovi-Operationen.
