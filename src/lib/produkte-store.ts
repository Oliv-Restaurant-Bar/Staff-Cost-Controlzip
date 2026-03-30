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

// ── Supabase-Sync via app_settings (existierende Tabelle mit RLS) ─────────────
// Wir verwenden app_settings statt app_kv_store, da app_settings bereits in der
// Datenbank vorhanden ist. value-Spalte ist JSONB → kein JSON.stringify nötig.

async function settingsGet<T>(key: string): Promise<{ found: true; value: T } | { found: false; error?: string }> {
  const { data, error } = await supabase
    .from('app_settings').select('value').eq('key', key).maybeSingle();
  if (error) return { found: false, error: `${error.code}: ${error.message}` };
  if (!data?.value) return { found: false };
  return { found: true, value: data.value as T };
}

async function settingsSave(key: string, value: unknown): Promise<string | null> {
  const { error } = await supabase.from('app_settings')
    .upsert({ key, value: value as object }, { onConflict: 'key' });
  return error ? `${error.code}: ${error.message}` : null;
}

// ── Produktdaten ──────────────────────────────────────────────────────────────

export async function loadProdukteDataFromDB(): Promise<ProdukteData | null> {
  try {
    const result = await settingsGet<ProdukteData>(STORAGE_KEY);

    if (!result.found) {
      if ('error' in result) {
        console.error('[Produkte] Supabase Ladefehler:', result.error);
      }
      // Supabase leer oder Fehler → localStorage prüfen und ggf. sync
      const local = loadProdukteData();
      if (local && (local.entries?.length ?? 0) > 0) {
        console.log('[Produkte] Supabase leer – sync localStorage→Supabase:', local.entries.length, 'Einträge');
        saveProdukteDataToDB(local); // fire-and-forget
      } else {
        console.log('[Produkte] Keine Daten in Supabase und kein localStorage');
      }
      return local;
    }

    const dbData = result.value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dbData));
    console.log('[Produkte] Aus Supabase (app_settings) geladen:', dbData.entries?.length, 'Einträge');
    return dbData;
  } catch (err) {
    console.error('[Produkte] loadProdukteDataFromDB Exception:', err);
    return loadProdukteData();
  }
}

export async function saveProdukteDataToDB(data: ProdukteData): Promise<void> {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  try {
    const err = await settingsSave(STORAGE_KEY, data);
    if (err) console.error('[Produkte] Supabase Speicherfehler:', err);
    else console.log('[Produkte] Nach Supabase (app_settings) gespeichert:', data.entries?.length, 'Einträge');
  } catch (err) { console.error('[Produkte] saveProdukteDataToDB Exception:', err); }
}

// ── Ignorier-Liste ────────────────────────────────────────────────────────────

export async function loadIgnoredProductsFromDB(): Promise<string[]> {
  try {
    const result = await settingsGet<string[]>(IGNORED_KEY);
    if (!result.found) {
      const local = loadIgnoredProducts();
      if (local.length > 0) saveIgnoredProductsToDB(local);
      return local;
    }
    const parsed = result.value;
    localStorage.setItem(IGNORED_KEY, JSON.stringify(parsed));
    return parsed;
  } catch (err) {
    console.error('[Produkte] loadIgnoredProductsFromDB Exception:', err);
    return loadIgnoredProducts();
  }
}

export async function saveIgnoredProductsToDB(list: string[]): Promise<void> {
  localStorage.setItem(IGNORED_KEY, JSON.stringify(list));
  try {
    const err = await settingsSave(IGNORED_KEY, list);
    if (err) console.error('[Produkte] saveIgnoredProductsToDB Fehler:', err);
  } catch { /* localStorage bleibt Fallback */ }
}

// ── Gastronovi CSV-Parser (Auto-Erkennung aus Dateiname) ──────────────────────
/**
 * Parst Gastronovi TSV-CSV Exporte (tab-getrennt, Felder in Anführungszeichen).
 *
 * Der Typ (Anzahl/Umsatz) und die Kategorie (Food/Beverage) werden automatisch
 * aus dem Dateinamen ermittelt:
 *   "Anzahl_Food_..."     → type=anzahl, category=food
 *   "Anzahl_Beverage_..."  → type=anzahl, category=beverage
 *   "Umsatz_Food_..."     → type=umsatz, category=food
 *   "Umsatz_Beverage_..." → type=umsatz, category=beverage
 *
 * Das Jahr wird ebenfalls aus dem Dateinamen gelesen (z.B. "...29.03.2026").
 */
export async function parseProdukteCSV(file: File): Promise<{
  entries: ProductEntry[];
  type: 'anzahl' | 'umsatz';
  category: 'food' | 'beverage';
}> {
  const nameLower = file.name.toLowerCase();

  // Auto-Erkennung aus Dateiname
  const type: 'anzahl' | 'umsatz'      = nameLower.includes('umsatz') ? 'umsatz' : 'anzahl';
  const category: 'food' | 'beverage'  =
    nameLower.includes('beverage') || nameLower.includes('getränk') ? 'beverage' : 'food';

  // Jahr aus Dateiname (z.B. "2026")
  const yearMatch = file.name.match(/(\d{4})/);
  const year = yearMatch ? yearMatch[1] : String(new Date().getFullYear());

  // Datei als Text lesen
  const text = await file.text();
  const lines = text.split(/\r?\n/);

  // TSV-Zeilen parsen: Tab-getrennt, Anführungszeichen entfernen
  const rows: string[][] = lines
    .filter(l => l.trim().length > 0)
    .map(line => line.split('\t').map(cell => cell.replace(/^"|"$/g, '').trim()));

  if (rows.length < 2) return { entries: [], type, category };

  // Header-Zeile finden: Spalten im Format "DD.MM."
  const DAY_COL_RE = /^(\d{1,2})\.(\d{2})\.?$/;
  let headerRowIdx = -1;
  const colMonthMap = new Map<number, string>();

  for (let r = 0; r < Math.min(rows.length, 5); r++) {
    const row = rows[r];
    let dayColCount = 0;
    const tempMap = new Map<number, string>();

    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      const dayMatch = cell.match(DAY_COL_RE);
      if (dayMatch) {
        const mm = dayMatch[2].padStart(2, '0');
        tempMap.set(c, `${year}-${mm}`);
        dayColCount++;
      }
    }

    if (dayColCount >= 3) {
      headerRowIdx = r;
      tempMap.forEach((v, k) => colMonthMap.set(k, v));
      break;
    }
  }

  const entries: ProductEntry[] = [];

  if (colMonthMap.size > 0 && headerRowIdx >= 0) {
    for (let r = headerRowIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length < 2) continue;

      const nameRaw = row[0];
      if (!nameRaw || nameRaw.length < 2) continue;

      // Gesamt-Zeilen überspringen
      const nl = nameRaw.toLowerCase();
      if (nl.startsWith('gesamt') || nl.startsWith('total') ||
          nl.startsWith('summe') || nl === 'alle') continue;

      for (const [colIdx, month] of colMonthMap) {
        const val = parseGastronomyNumber(row[colIdx]);
        if (val <= 0) continue;
        upsertEntry(entries, nameRaw, month, type, val, category);
      }
    }
  }

  return { entries, type, category };
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
  overwriteMonths: string[] = [],
): ProductEntry[] {
  // Monate die überschrieben werden sollen: alle vorhandenen Einträge für
  // diese Monat+Kategorie-Kombination werden zuerst vollständig gelöscht.
  // So bleiben keine veralteten Produkte übrig, wenn sich die Auswahl ändert.
  const overwriteSet = new Set(overwriteMonths);
  const incomingCategories = new Set(incoming.map(e => e.category ?? 'food'));

  let base: ProductEntry[];
  if (overwriteSet.size > 0) {
    base = existing.filter(e => {
      const cat = e.category ?? 'food';
      // Behalte den Eintrag nur, wenn er NICHT in einem zu überschreibenden
      // Monat + einer der eingehenden Kategorien liegt.
      if (overwriteSet.has(e.month) && incomingCategories.has(cat)) return false;
      return true;
    });
  } else {
    base = [...existing];
  }

  // Eingehende Einträge einfügen.
  // Für Monate ohne Überschreiben: nur den spezifischen Feld-Wert (count/revenue)
  // name-basiert aktualisieren (ursprüngliches Verhalten für neue Monate).
  for (const inc of incoming) {
    const incCat = inc.category ?? 'food';
    if (overwriteSet.has(inc.month) && incomingCategories.has(incCat)) {
      // Monat wurde vollständig geleert → direkt einfügen
      base.push({ ...inc, category: incCat });
    } else {
      // Normaler name-basierter Merge für Monate ohne Überschreiben
      const idx = base.findIndex(
        e => e.name === inc.name && e.month === inc.month && (e.category ?? 'food') === incCat,
      );
      if (idx >= 0) {
        if (type === 'anzahl') base[idx].count   = inc.count;
        else                    base[idx].revenue = inc.revenue;
        base[idx].category = incCat;
      } else {
        base.push({ ...inc, category: incCat });
      }
    }
  }
  return base;
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

// ── Produktgruppen ────────────────────────────────────────────────────────────

export interface ProductGroup {
  id: string;
  name: string;
  category: 'food' | 'beverage' | 'all';
  color: string;
  productNames: string[];   // manually assigned names (lowercase)
  keywords: string[];        // auto-classification keywords (lowercase)
}

const GROUP_KEY = 'produkte_groups_v1';

export const DEFAULT_GROUPS_FOOD: Omit<ProductGroup, 'productNames'>[] = [
  { id: 'pizza',     name: 'Pizza',       category: 'food', color: 'orange',
    keywords: ['pizza'] },
  { id: 'pasta',     name: 'Pasta/Risotto', category: 'food', color: 'yellow',
    keywords: ['pasta', 'penne', 'rigatoni', 'spaghetti', 'tagliatelle', 'linguine', 'fettuccine', 'gnocchi', 'risotto', 'ravioli', 'tortellini'] },
  { id: 'fleisch',   name: 'Fleisch',     category: 'food', color: 'red',
    keywords: ['steak', 'schnitzel', 'poulet', 'hähnchen', 'kalb', 'rind', 'lamm', 'schwein', 'burger', 'ossobuco', 'entrecôte', 'entrecote'] },
  { id: 'fisch',     name: 'Fisch',       category: 'food', color: 'blue',
    keywords: ['fisch', 'lachs', 'thon', 'gamberi', 'crevetten', 'garnelen', 'calamari', 'muschel', 'branzino', 'dorade', 'seezunge', 'wolfsbarsch'] },
  { id: 'vorspeise', name: 'Vorspeisen',  category: 'food', color: 'teal',
    keywords: ['antipasto', 'bruschetta', 'carpaccio', 'suppe', 'cremesuppe', 'minestrone', 'vorspeise', 'starter', 'salat', 'caesar', 'insalata'] },
  { id: 'menu',        name: 'Menu',        category: 'food', color: 'grey',
    keywords: ['menu', 'menü', 'tagesmenü', 'tagesmenu', 'lunch menu', 'business lunch'] },
  { id: 'fruehstueck', name: 'Frühstück',  category: 'food', color: 'yellow',
    keywords: ['frühstück', 'fruhstuck', 'breakfast', 'brunch', 'müesli', 'muesli', 'porridge', 'rührei', 'omelette', 'croissant', 'toast'] },
  { id: 'sushi',       name: 'Sushi',      category: 'food', color: 'cyan',
    keywords: ['sushi', 'maki', 'nigiri', 'temaki', 'sashimi', 'uramaki', 'gunkan', 'onigiri', 'edamame', 'miso'] },
  { id: 'kinder',      name: 'Kinderkarte', category: 'food', color: 'amber',
    keywords: ['kinder', 'kids', 'junior', 'kindermenu', 'kindermenü', 'kindermenü', 'bambini'] },
  { id: 'takeaway',    name: 'Take Away',   category: 'food', color: 'orange',
    keywords: ['take away', 'takeaway', 'take-away', 'to go', 'mitnahme', 'mitnehmen', 'delivery', 'box'] },
  { id: 'beilage',     name: 'Beilage / Extra', category: 'food', color: 'green',
    keywords: ['beilage', 'extra', 'beilagen', 'supplement', 'zusatz', 'pommes', 'reis', 'gemüse', 'rösti', 'kartoffel', 'salat beilage', 'bread', 'brot'] },
  { id: 'dessert',   name: 'Dessert',     category: 'food', color: 'pink',
    keywords: ['dessert', 'tiramisu', 'panna cotta', 'sorbet', 'gelato', 'mousse', 'torte', 'kuchen', 'waffel', 'crêpe'] },
];

export const DEFAULT_GROUPS_BEVERAGE: Omit<ProductGroup, 'productNames'>[] = [
  { id: 'wein',        name: 'Wein',        category: 'beverage', color: 'purple',
    keywords: ['wein', 'wine', 'prosecco', 'champagne', 'champagner', 'rosé', 'rouge', 'blanc', 'primitivo', 'barolo', 'chianti', 'pinot', 'sauvignon', 'riesling', 'merlot'] },
  { id: 'bier',        name: 'Bier',        category: 'beverage', color: 'amber',
    keywords: ['bier', 'beer', 'lager', 'hefeweizen', 'ipa', 'stout', 'weizen'] },
  { id: 'spirituosen', name: 'Spirituosen', category: 'beverage', color: 'orange',
    keywords: ['whisky', 'whiskey', 'gin', 'rum', 'vodka', 'tequila', 'grappa', 'marc', 'schnaps', 'amaro', 'digestif', 'cognac', 'armagnac', 'calvados'] },
  { id: 'cocktails',   name: 'Cocktails',   category: 'beverage', color: 'pink',
    keywords: ['cocktail', 'aperol', 'spritz', 'mojito', 'margarita', 'hugo', 'negroni', 'longdrink', 'mocktail'] },
  { id: 'softdrinks',  name: 'Softdrinks',  category: 'beverage', color: 'cyan',
    keywords: ['cola', 'fanta', 'sprite', 'limonade', 'ice tea', 'eistee', 'saft', 'mineral', 'wasser', 'perrier', 'pellegrino', 'rivella', 'orangina'] },
  { id: 'kaffee',      name: 'Kaffee/Tee',  category: 'beverage', color: 'brown',
    keywords: ['kaffee', 'espresso', 'cappuccino', 'latte', 'americano', 'macchiato', 'tee', 'tea', 'chai'] },
];

export function initDefaultProductGroups(): ProductGroup[] {
  return [
    ...[...DEFAULT_GROUPS_FOOD, ...DEFAULT_GROUPS_BEVERAGE].map(g => ({ ...g, productNames: [] })),
  ];
}

function migrateLegacyGroups(stored: ProductGroup[]): ProductGroup[] {
  const map = new Map(stored.map(g => [g.id, g]));
  // Migrate: merge old 'salate' group into 'vorspeise'
  if (map.has('salate')) {
    const salate = map.get('salate')!;
    const vorspeise = map.get('vorspeise');
    if (vorspeise) {
      const merged = Array.from(new Set([...vorspeise.productNames, ...salate.productNames]));
      map.set('vorspeise', { ...vorspeise, productNames: merged });
    }
    map.delete('salate');
  }
  // Rename 'Fisch/Meer' → 'Fisch'
  if (map.has('fisch')) {
    const f = map.get('fisch')!;
    if (f.name === 'Fisch/Meer') map.set('fisch', { ...f, name: 'Fisch' });
  }
  // Ensure all current defaults exist
  for (const def of [...DEFAULT_GROUPS_FOOD, ...DEFAULT_GROUPS_BEVERAGE]) {
    if (!map.has(def.id)) map.set(def.id, { ...def, productNames: [] });
    else {
      // Sync keywords from defaults (user can still override name/color)
      const existing = map.get(def.id)!;
      map.set(def.id, { ...existing, keywords: def.keywords });
    }
  }
  return Array.from(map.values());
}

export function loadProductGroups(): ProductGroup[] {
  try {
    const raw = localStorage.getItem(GROUP_KEY);
    if (!raw) return initDefaultProductGroups();
    const stored: ProductGroup[] = JSON.parse(raw);
    return migrateLegacyGroups(stored);
  } catch { return initDefaultProductGroups(); }
}

export function saveProductGroups(groups: ProductGroup[]): void {
  localStorage.setItem(GROUP_KEY, JSON.stringify(groups));
}

export async function loadProductGroupsFromDB(): Promise<ProductGroup[]> {
  try {
    const result = await settingsGet<ProductGroup[]>(GROUP_KEY);
    if (!result.found) return loadProductGroups();
    const stored = result.value;
    const migrated = migrateLegacyGroups(stored);
    localStorage.setItem(GROUP_KEY, JSON.stringify(migrated));
    return migrated;
  } catch { return loadProductGroups(); }
}

export async function saveProductGroupsToDB(groups: ProductGroup[]): Promise<void> {
  localStorage.setItem(GROUP_KEY, JSON.stringify(groups));
  try {
    const err = await settingsSave(GROUP_KEY, groups);
    if (err) console.error('[Produkte] saveProductGroupsToDB Fehler:', err);
  } catch { /* localStorage bleibt Fallback */ }
}

// ── Gruppen-Lookup: Welcher Gruppe gehört ein Produkt an? ─────────────────────

export function resolveProductGroup(
  name: string,
  groups: ProductGroup[],
): ProductGroup | null {
  const lower = name.toLowerCase();
  // 1. Manual assignment takes priority
  for (const g of groups) {
    if (g.productNames.some(pn => pn.toLowerCase() === lower)) return g;
  }
  // 2. Keyword auto-detection
  for (const g of groups) {
    if (g.keywords.some(kw => lower.includes(kw))) return g;
  }
  return null;
}

// ── Margen & Performance ──────────────────────────────────────────────────────

export interface ProductPerformanceRow {
  name: string;
  category: 'food' | 'beverage';
  count: number;
  revenue: number;
  revenueShare: number;
  bruttoPrice: number;
  wes: number;
  hasCost: boolean;
  margeCHF: number;        // per unit
  margePct: number;        // % margin (0-100)
  totalMargeCHF: number;   // total period margin = margeCHF * count
  groupId: string | null;
  groupName: string | null;
  groupColor: string | null;
}

export function computeProductPerformance(
  entries: ProductEntry[],
  costs: ProductCostEntry[],
  groups: ProductGroup[],
  month: string,
  category: 'food' | 'beverage',
  ignoredByUser: string[],
): ProductPerformanceRow[] {
  const byCat    = entries.filter(e => (e.category ?? 'food') === category);
  const filtered = month === 'alle' ? byCat : byCat.filter(e => e.month === month);

  const agg = new Map<string, { count: number; revenue: number }>();
  for (const e of filtered) {
    if (shouldIgnoreProduct(e.name, ignoredByUser)) continue;
    const cur = agg.get(e.name) ?? { count: 0, revenue: 0 };
    cur.count   += e.count;
    cur.revenue += e.revenue;
    agg.set(e.name, cur);
  }

  const totalRevenue = [...agg.values()].reduce((s, v) => s + v.revenue, 0);

  const costMap = new Map<string, ProductCostEntry>();
  for (const c of costs) {
    if (c.category === category) costMap.set(c.name.toLowerCase(), c);
  }

  const rows: ProductPerformanceRow[] = [];
  for (const [name, vals] of agg) {
    const cost        = costMap.get(name.toLowerCase());
    const hasCost     = !!(cost && (cost.bruttoPrice > 0 || cost.wes > 0));
    const bruttoPrice = cost?.bruttoPrice ?? 0;
    const wes         = cost?.wes         ?? 0;
    const margeCHF    = hasCost && bruttoPrice > 0 ? bruttoPrice - wes : 0;
    const margePct    = hasCost && bruttoPrice > 0 ? (margeCHF / bruttoPrice) * 100 : 0;

    const group = resolveProductGroup(name, groups);

    rows.push({
      name,
      category,
      count:          vals.count,
      revenue:        vals.revenue,
      revenueShare:   totalRevenue > 0 ? (vals.revenue / totalRevenue) * 100 : 0,
      bruttoPrice,
      wes,
      hasCost,
      margeCHF,
      margePct,
      totalMargeCHF:  margeCHF * vals.count,
      groupId:        group?.id   ?? null,
      groupName:      group?.name ?? null,
      groupColor:     group?.color ?? null,
    });
  }

  return rows.sort((a, b) => b.revenue - a.revenue);
}

export interface GroupPerformanceRow {
  groupId: string;
  groupName: string;
  category: 'food' | 'beverage' | 'all';
  color: string;
  productCount: number;
  totalCount: number;
  totalRevenue: number;
  revenueShare: number;
  withCostCount: number;
  avgMargePct: number;
  totalMargeCHF: number;
}

export function computeGroupPerformance(
  rows: ProductPerformanceRow[],
  groups: ProductGroup[],
): GroupPerformanceRow[] {
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);

  const map = new Map<string, GroupPerformanceRow>();
  for (const g of groups) {
    map.set(g.id, {
      groupId: g.id, groupName: g.name, category: g.category, color: g.color,
      productCount: 0, totalCount: 0, totalRevenue: 0, revenueShare: 0,
      withCostCount: 0, avgMargePct: 0, totalMargeCHF: 0,
    });
  }
  map.set('__other__', {
    groupId: '__other__', groupName: 'Sonstiges', category: 'all', color: 'grey',
    productCount: 0, totalCount: 0, totalRevenue: 0, revenueShare: 0,
    withCostCount: 0, avgMargePct: 0, totalMargeCHF: 0,
  });

  for (const row of rows) {
    const gId = row.groupId ?? '__other__';
    const g   = map.get(gId) ?? map.get('__other__')!;
    g.productCount++;
    g.totalCount   += row.count;
    g.totalRevenue += row.revenue;
    if (row.hasCost) { g.withCostCount++; g.totalMargeCHF += row.totalMargeCHF; }
  }

  for (const g of map.values()) {
    g.revenueShare = totalRevenue > 0 ? (g.totalRevenue / totalRevenue) * 100 : 0;
    if (g.withCostCount > 0 && g.totalRevenue > 0) {
      g.avgMargePct = (g.totalMargeCHF / g.totalRevenue) * 100;
    }
  }

  return [...map.values()]
    .filter(g => g.productCount > 0)
    .sort((a, b) => b.totalRevenue - a.totalRevenue);
}

// ── Supabase-Sync für Produktkosten (via app_settings) ───────────────────────
const DB_KV_KEY = 'produkte_cost_v1';

export async function loadProductCostsFromDB(): Promise<ProductCostEntry[]> {
  try {
    const result = await settingsGet<ProductCostEntry[]>(DB_KV_KEY);
    if (!result.found) {
      if ('error' in result) console.error('[Produkte] WES Ladefehler:', result.error);
      const local = loadProductCosts();
      if (local.length > 0) saveProductCostsToDB(local); // einmalige Migration
      return local;
    }
    localStorage.setItem(DB_KV_KEY, JSON.stringify(result.value));
    return result.value;
  } catch {
    return loadProductCosts();
  }
}

export async function saveProductCostsToDB(costs: ProductCostEntry[]): Promise<void> {
  localStorage.setItem(DB_KV_KEY, JSON.stringify(costs));
  try {
    const err = await settingsSave(DB_KV_KEY, costs);
    if (err) console.error('[Produkte] WES Speicherfehler:', err);
  } catch { /* localStorage bleibt Fallback */ }
  // Gleichzeitig in produkte_kosten synchronisieren (für VerkaufsDashboard)
  syncWesToProduktKosten(costs).catch(e =>
    console.warn('[Produkte] Sync zu produkte_kosten fehlgeschlagen:', e),
  );
}

/**
 * Synchronisiert WES-Werte aus ProductCostEntry in die Tabelle produkte_kosten.
 * Wird nach jedem saveProductCostsToDB aufgerufen (fire-and-forget).
 * Nur Einträge mit wes > 0 werden synchronisiert.
 */
export async function syncWesToProduktKosten(costs: ProductCostEntry[]): Promise<void> {
  const records = costs
    .filter(e => e.wes > 0)
    .map(e => ({
      name:     e.name.trim(),
      category: e.category,
      wes:      e.wes,
      wes_q:    e.wesQ ?? 0,
    }));
  if (records.length === 0) return;

  const { error } = await (supabase as any)
    .from('produkte_kosten')
    .upsert(records, { onConflict: 'name,category' });

  if (error) console.warn('[Produkte] syncWesToProduktKosten Fehler:', error.message, error.code);
  else console.log(`[Produkte] syncWesToProduktKosten: ${records.length} Einträge synchronisiert`);
}
