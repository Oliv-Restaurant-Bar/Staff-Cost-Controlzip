import * as XLSX from 'xlsx';
import { supabase } from '@/integrations/supabase/client';

export interface ProductEntry {
  name: string;
  month: string; // 'yyyy-MM' oder 'gesamt'
  count: number;
  revenue: number;
  category: 'food' | 'beverage';
}

export interface ProdukteData {
  entries: ProductEntry[];
  importedAt: string;
  source: 'anzahl' | 'umsatz' | 'combined';
}

const STORAGE_KEY   = 'produkte_data_v2';
const IGNORED_KEY   = 'produkte_ignored_v1';
const COST_KEY      = 'produkte_cost_v1';

// ── Produktkosten (WES) ───────────────────────────────────────────────────────
export interface ProductCostEntry {
  name: string;
  category: 'food' | 'beverage';
  bruttoPrice: number;  // Brutto-Verkaufspreis
  nettoPrice: number;   // Netto-Verkaufspreis
  wes: number;          // Einkaufspreis / Wareneinsatz pro Einheit
  wesQ: number;         // Warenkostenaufwand in % (WES-Quotient)
}

export function loadProductCosts(): ProductCostEntry[] {
  try { const r = localStorage.getItem(COST_KEY); return r ? JSON.parse(r) : []; }
  catch { return []; }
}

export function saveProductCosts(list: ProductCostEntry[]): void {
  localStorage.setItem(COST_KEY, JSON.stringify(list));
}

/**
 * Merge neue Kostendaten in bestehende — überschreibt nach Name+Kategorie.
 */
export function mergeProductCosts(
  existing: ProductCostEntry[],
  incoming: ProductCostEntry[],
): ProductCostEntry[] {
  const merged = [...existing];
  for (const inc of incoming) {
    const idx = merged.findIndex(
      e => e.name.toLowerCase() === inc.name.toLowerCase() && e.category === inc.category,
    );
    if (idx >= 0) merged[idx] = inc;
    else merged.push(inc);
  }
  return merged;
}

/**
 * Parser für WES-Preislisten mit fixem Spalten-Layout (Oliv Gastro AG).
 *
 * Dateiformat: Excel mit 1–2 Tabellenblättern ("Food" / "Beverage")
 * Zeile 1 = Header (wird übersprungen)
 * Zeile 2+ = Daten mit folgenden Spalten:
 *   A (0) = Kategorie (z.B. "Beverage") — nur zur Info, Kategorie kommt vom Sheet-Namen
 *   B (1) = Titel / Produktname → Matching-Key
 *   C (2) = Brutto-Preis inkl. MWST
 *   D (3) = Netto-Preis (ohne MWST)
 *   E (4) = WES (Wareneinsatzkosten pro Einheit)
 *   F (5) = WES-Q (WES / Netto × 100, in %)
 *
 * Liest alle Sheets und bestimmt die Kategorie aus dem Sheet-Namen:
 *   Sheet-Name enthält "food" → 'food', enthält "bev" → 'beverage'
 *   Fallback: Wert in Spalte A der ersten Datenzeile
 */
export async function parseCostExcel(
  file: File,
): Promise<ProductCostEntry[]> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array' });

  const getNum = (v: unknown): number => {
    if (typeof v === 'number') return v;
    if (v === undefined || v === null || v === '') return 0;
    return parseGastronomyNumber(v);
  };

  const parseSheet = (
    ws: XLSX.WorkSheet,
    sheetName: string,
  ): ProductCostEntry[] => {
    const rowsRaw: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(ws, {
      header: 1, defval: undefined, raw: true,
    });

    // Kategorie aus Sheet-Namen ableiten
    const sn = sheetName.toLowerCase();
    let sheetCategory: 'food' | 'beverage' | null =
      sn.includes('food') ? 'food' : sn.includes('bev') ? 'beverage' : null;

    const entries: ProductCostEntry[] = [];

    // Zeile 0 = Header → Daten ab Zeile 1 (Index 1)
    for (let r = 1; r < rowsRaw.length; r++) {
      const row = rowsRaw[r];
      if (!row || row.length < 2) continue;

      // Spalte A (0): Kategorie (Fallback wenn Sheet-Name nicht eindeutig)
      const colAStr = String(row[0] ?? '').toLowerCase().trim();
      let rowCategory: 'food' | 'beverage' | null = sheetCategory;
      if (!rowCategory) {
        if (colAStr.includes('food') || colAStr.includes('speise')) rowCategory = 'food';
        else if (colAStr.includes('bev') || colAStr.includes('getränk')) rowCategory = 'beverage';
      }
      if (!rowCategory) continue; // Kategorie unbekannt → überspringen

      // Spalte B (1): Produktname
      const nameRaw = String(row[1] ?? '').trim();
      if (!nameRaw || nameRaw.length < 2) continue;
      const nameLower = nameRaw.toLowerCase();
      if (nameLower.startsWith('total') || nameLower.startsWith('gesamt') ||
          nameLower.startsWith('summe') || /^\d+$/.test(nameRaw)) continue;

      // Spalten C–F (2–5): Preise
      const brutto = getNum(row[2]);
      const netto  = getNum(row[3]);
      const wes    = getNum(row[4]);
      let wesQ     = getNum(row[5]);

      // WES-Q berechnen falls fehlt
      if (wesQ <= 0 && wes > 0 && netto > 0) wesQ = (wes / netto) * 100;
      if (wesQ <= 0 && wes > 0 && brutto > 0) wesQ = (wes / brutto) * 100;

      // Mindestens ein Preis muss vorhanden sein
      if (wes <= 0 && brutto <= 0 && netto <= 0) continue;

      entries.push({
        name: nameRaw,
        category: rowCategory,
        bruttoPrice: brutto,
        nettoPrice: netto,
        wes,
        wesQ,
      });
    }
    return entries;
  };

  // Alle Sheets verarbeiten und Einträge sammeln
  const all: ProductCostEntry[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const entries = parseSheet(ws, name);
    all.push(...entries);
  }
  return all;
}

// ── Werksseitige Ignorier-Liste ────────────────────────────────────────────────
export const DEFAULT_IGNORE_TERMS: string[] = [
  'küche',
  'à point',
  'a point',
  'mc donalds',
  'mcdonald',
  'bien cuit',
  'ohne alkohol',
  'extra rahm',
  'extra beilagen',
  'mittel',
  'nicht scharf',
  'scharf',
  'mit schinken',
  'abfrage pizza extra',
  'abfrage pizza',
  'geburtstagsmenu',
  'creme fraiche',
  'crème fraiche',
  'assassin',
  'diverse pizza salami',
  'gipfeli',
  'extra ei',
  'aufpreis gamberi',
  'ohne',
];

export function shouldIgnoreProduct(name: string, extraIgnored: string[] = []): boolean {
  const lower = name.toLowerCase().trim();
  if (!lower || lower.length < 2) return true;
  const allTerms = [...DEFAULT_IGNORE_TERMS, ...extraIgnored.map(s => s.toLowerCase())];
  return allTerms.some(term => lower.includes(term));
}

// ── localStorage Helpers ───────────────────────────────────────────────────────
export function loadProdukteData(): ProdukteData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveProdukteData(data: ProdukteData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function loadIgnoredProducts(): string[] {
  try {
    const raw = localStorage.getItem(IGNORED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveIgnoredProducts(list: string[]): void {
  localStorage.setItem(IGNORED_KEY, JSON.stringify(list));
}

// ── Gastronovi Excel-Parser ────────────────────────────────────────────────────
/**
 * Gastronovi "Anzahl Rezepte" / "Umsatz Rezepte" Export.
 *
 * Zeile 1 (Row 0): Ab Spalte C (Index 2) stehen Tages-Header im Format "DD.MM."
 *   z.B. "01.01.", "02.01.", ..., "31.01.", "01.02.", ...
 *   Die ersten zwei Ziffern = Tag, die nächsten zwei Ziffern = Monat.
 *   Das Jahr fehlt im Header und wird aus dem Dateinamen oder dem aktuellen Jahr abgeleitet.
 *
 * Ab Zeile 2: Datenzeilen — Spalte A = Produktname, Spalten C+ = Tageswerte.
 *
 * Aggregation: Alle Tageswerte desselben Monats werden pro Produkt summiert.
 */
export async function parseProdukteExcel(
  file: File,
  type: 'anzahl' | 'umsatz',
  category: 'food' | 'beverage' = 'food',
): Promise<ProductEntry[]> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: undefined,
    raw: false,
  });

  if (rows.length < 2) return [];

  // Jahr aus Dateinamen extrahieren (z.B. "Anzahl_Rezepte_01.01.-19.03.2026")
  const yearMatch = file.name.match(/(\d{4})/);
  const year = yearMatch ? yearMatch[1] : String(new Date().getFullYear());

  // ── Header-Zeile analysieren ───────────────────────────────────────────────
  // Suche die Zeile mit den Datumsangaben (DD.MM.) — meistens Zeile 0 oder 1
  // Regex: "01.01." = Tag.Monat. (mit oder ohne trailing point)
  const DAY_COL_RE = /^(\d{1,2})\.(\d{2})\.?$/;

  // Monatsname-Fallback für alternative Formate
  const MONTH_NAME_MAP: Record<string, string> = {
    januar: '01', jänner: '01', jan: '01',
    februar: '02', feb: '02',
    märz: '03', maerz: '03', mar: '03',
    april: '04', apr: '04',
    mai: '05',
    juni: '06', jun: '06',
    juli: '07', jul: '07',
    august: '08', aug: '08',
    september: '09', sep: '09',
    oktober: '10', okt: '10', oct: '10',
    november: '11', nov: '11',
    dezember: '12', dez: '12',
  };

  let headerRowIdx = -1;
  // colMap: Spaltenindex → Monat 'YYYY-MM'
  const colMonthMap: Map<number, string> = new Map();

  for (let r = 0; r < Math.min(rows.length, 5); r++) {
    const row = rows[r];
    if (!row) continue;

    let dayColCount = 0;
    let monthColCount = 0;
    const tempMap: Map<number, string> = new Map();

    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] ?? '').trim();
      if (!cell) continue;

      // Format "DD.MM." → Tages-Spalten (Gastronovi-typisch)
      const dayMatch = cell.match(DAY_COL_RE);
      if (dayMatch) {
        const mm = dayMatch[2].padStart(2, '0');
        tempMap.set(c, `${year}-${mm}`);
        dayColCount++;
        continue;
      }

      // Fallback: Monatsnamen
      const cellLower = cell.toLowerCase();
      for (const [mName, mNum] of Object.entries(MONTH_NAME_MAP)) {
        if (cellLower.startsWith(mName)) {
          tempMap.set(c, `${year}-${mNum}`);
          monthColCount++;
          break;
        }
      }
    }

    if (dayColCount >= 3 || monthColCount >= 2) {
      headerRowIdx = r;
      tempMap.forEach((v, k) => colMonthMap.set(k, v));
      break;
    }
  }

  const entries: ProductEntry[] = [];

  // ── Datenzeilen verarbeiten ────────────────────────────────────────────────
  if (colMonthMap.size > 0 && headerRowIdx >= 0) {
    // Tages-/Monats-Spalten gefunden → aggregiere pro Monat
    for (let r = headerRowIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;

      const nameRaw = String(row[0] ?? '').trim();
      if (!nameRaw || nameRaw.length < 2) continue;
      const nameLower = nameRaw.toLowerCase();
      if (nameLower.startsWith('total') || nameLower.startsWith('gesamt') ||
          nameLower.startsWith('summe') || nameLower === 'alle') continue;

      // Summiere Tageswerte pro Monat
      for (const [colIdx, month] of colMonthMap) {
        const val = parseGastronomyNumber(row[colIdx]);
        if (val <= 0) continue;
        upsertEntry(entries, nameRaw, month, type, val, category);
      }
    }
  } else {
    // Fallback: Keine erkannten Spalten → alles als "gesamt" importieren
    const dataStart = headerRowIdx >= 0 ? headerRowIdx + 1 : 1;
    for (let r = dataStart; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const nameRaw = String(row[0] ?? '').trim();
      if (!nameRaw || nameRaw.length < 2) continue;
      const nameLower = nameRaw.toLowerCase();
      if (nameLower.startsWith('total') || nameLower.startsWith('gesamt') ||
          nameLower.startsWith('summe') || nameLower === 'alle') continue;

      let total = 0;
      for (let c = 1; c < row.length; c++) {
        total += parseGastronomyNumber(row[c]);
      }
      if (total > 0) upsertEntry(entries, nameRaw, 'gesamt', type, total, category);
    }
  }

  return entries;
}

function parseGastronomyNumber(cell: string | number | undefined): number {
  if (cell === undefined || cell === null || cell === '') return 0;
  if (typeof cell === 'number') return cell;
  // "1'234.56" or "1.234,56" or "1234,56" or "1234.56"
  const str = String(cell).trim().replace(/[^0-9.,'-]/g, '');
  if (!str) return 0;
  // Apostroph als Tausender-Trennzeichen (CH)
  const noApostrophe = str.replace(/'/g, '');
  // Letztes Komma oder Punkt als Dezimaltrennzeichen
  const lastComma = noApostrophe.lastIndexOf(',');
  const lastDot   = noApostrophe.lastIndexOf('.');
  let normalized: string;
  if (lastComma > lastDot) {
    normalized = noApostrophe.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = noApostrophe.replace(/,/g, '');
  }
  return parseFloat(normalized) || 0;
}

function extractMonth(dateStr: string, fallbackYear: string): string {
  // Try dd.MM.yyyy
  const m1 = dateStr.match(/\d{1,2}\.(\d{1,2})\.(\d{4})/);
  if (m1) return `${m1[2]}-${m1[1].padStart(2, '0')}`;
  // Try yyyy-MM
  const m2 = dateStr.match(/(\d{4})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}`;
  return 'gesamt';
}

function upsertEntry(
  entries: ProductEntry[],
  name: string,
  month: string,
  type: 'anzahl' | 'umsatz',
  val: number,
  category: 'food' | 'beverage' = 'food',
): void {
  const existing = entries.find(e => e.name === name && e.month === month && e.category === category);
  if (existing) {
    if (type === 'anzahl') existing.count  += val;
    else                    existing.revenue += val;
  } else {
    entries.push({
      name,
      month,
      category,
      count:   type === 'anzahl' ? val : 0,
      revenue: type === 'umsatz' ? val : 0,
    });
  }
}

// ── Merge neu importierte Daten in bestehende ──────────────────────────────────
export function mergeProdukteData(
  existing: ProductEntry[],
  incoming: ProductEntry[],
  type: 'anzahl' | 'umsatz',
): ProductEntry[] {
  const merged = [...existing];
  for (const inc of incoming) {
    const idx = merged.findIndex(
      e => e.name === inc.name && e.month === inc.month && (e.category ?? 'food') === (inc.category ?? 'food'),
    );
    if (idx >= 0) {
      if (type === 'anzahl') merged[idx].count   = inc.count;
      else                    merged[idx].revenue = inc.revenue;
      merged[idx].category = inc.category ?? 'food';
    } else {
      merged.push({ ...inc, category: inc.category ?? 'food' });
    }
  }
  return merged;
}

// ── Ranking-Berechnung ─────────────────────────────────────────────────────────
export interface RankedProduct {
  rank: number;
  name: string;
  count: number;
  revenue: number;
}

function filterByCategory(entries: ProductEntry[], category: 'food' | 'beverage'): ProductEntry[] {
  return entries.filter(e => (e.category ?? 'food') === category);
}

export function getTopProducts(
  entries: ProductEntry[],
  month: string,
  sortBy: 'count' | 'revenue',
  limit: number,
  ignoredByUser: string[],
  category: 'food' | 'beverage' = 'food',
): RankedProduct[] {
  const byCat = filterByCategory(entries, category);
  const agg: Record<string, { count: number; revenue: number }> = {};
  const filtered = month === 'alle' ? byCat : byCat.filter(e => e.month === month);

  for (const e of filtered) {
    if (shouldIgnoreProduct(e.name, ignoredByUser)) continue;
    if (!agg[e.name]) agg[e.name] = { count: 0, revenue: 0 };
    agg[e.name].count   += e.count;
    agg[e.name].revenue += e.revenue;
  }

  return Object.entries(agg)
    .sort((a, b) => b[1][sortBy] - a[1][sortBy])
    .slice(0, limit)
    .map(([name, vals], i) => ({
      rank: i + 1,
      name,
      count: vals.count,
      revenue: vals.revenue,
    }));
}

// ── Flop-Ranking (schlechteste Produkte zuerst) ────────────────────────────────
export function getFlopProducts(
  entries: ProductEntry[],
  month: string,
  sortBy: 'count' | 'revenue',
  limit: number,
  ignoredByUser: string[],
  category: 'food' | 'beverage' = 'food',
): RankedProduct[] {
  const byCat = filterByCategory(entries, category);
  const agg: Record<string, { count: number; revenue: number }> = {};
  const filtered = month === 'alle' ? byCat : byCat.filter(e => e.month === month);

  for (const e of filtered) {
    if (shouldIgnoreProduct(e.name, ignoredByUser)) continue;
    if (type_hasValue(e, sortBy)) {
      if (!agg[e.name]) agg[e.name] = { count: 0, revenue: 0 };
      agg[e.name].count   += e.count;
      agg[e.name].revenue += e.revenue;
    }
  }

  return Object.entries(agg)
    .filter(([, v]) => v[sortBy] > 0)
    .sort((a, b) => a[1][sortBy] - b[1][sortBy])
    .slice(0, limit)
    .map(([name, vals], i) => ({
      rank: i + 1,
      name,
      count: vals.count,
      revenue: vals.revenue,
    }));
}

function type_hasValue(e: ProductEntry, sortBy: 'count' | 'revenue'): boolean {
  return sortBy === 'count' ? e.count > 0 : e.revenue > 0;
}

// ── Verfügbare Monate ermitteln ────────────────────────────────────────────────
export function getAvailableMonths(entries: ProductEntry[], category: 'food' | 'beverage' = 'food'): string[] {
  const filtered = entries.filter(e => (e.category ?? 'food') === category);
  const set = new Set(filtered.map(e => e.month));
  return Array.from(set).filter(m => m !== 'gesamt').sort();
}

// ── Supabase-Sync für Produktkosten ───────────────────────────────────────────
const DB_KV_KEY = 'produkte_cost_v1';

/**
 * Lädt Produktkosten aus Supabase (app_kv_store).
 * Fällt auf localStorage zurück wenn nicht eingeloggt oder kein Netz.
 */
export async function loadProductCostsFromDB(): Promise<ProductCostEntry[]> {
  try {
    const { data, error } = await supabase
      .from('app_kv_store')
      .select('value')
      .eq('key', DB_KV_KEY)
      .maybeSingle();
    if (error || !data?.value) return loadProductCosts(); // localStorage-Fallback
    const parsed: ProductCostEntry[] = JSON.parse(data.value);
    // Lokalen Cache aktualisieren
    localStorage.setItem(DB_KV_KEY, data.value);
    return parsed;
  } catch {
    return loadProductCosts();
  }
}

/**
 * Speichert Produktkosten in Supabase (app_kv_store) UND localStorage.
 */
export async function saveProductCostsToDB(costs: ProductCostEntry[]): Promise<void> {
  const value = JSON.stringify(costs);
  // Immer sofort lokal speichern (kein Warten auf Netz)
  localStorage.setItem(DB_KV_KEY, value);
  try {
    await supabase
      .from('app_kv_store')
      .upsert({ key: DB_KV_KEY, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  } catch {
    // Netzfehler → nur localStorage
  }
}
