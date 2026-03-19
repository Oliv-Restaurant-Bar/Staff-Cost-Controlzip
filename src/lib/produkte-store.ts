import * as XLSX from 'xlsx';

export interface ProductEntry {
  name: string;
  month: string; // 'yyyy-MM' oder 'gesamt'
  count: number;
  revenue: number;
}

export interface ProdukteData {
  entries: ProductEntry[];
  importedAt: string;
  source: 'anzahl' | 'umsatz' | 'combined';
}

const STORAGE_KEY   = 'produkte_data_v2';
const IGNORED_KEY   = 'produkte_ignored_v1';

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
 * Gastronovi "Anzahl Rezepte" oder "Umsatz Rezepte" Export.
 *
 * Typisches Format:
 *   Zeile 1-N: Header-Info (Firmenname, Zeitraum, etc.)
 *   Dann eine Zeile mit Spaltentiteln
 *   Dann Datenzeilen: Produktname | Wert1 | Wert2 | ...
 *
 * Strategie:
 *   1. Alle Zeilen als rohe Arrays einlesen
 *   2. Erste Zeile finden, in der Spalte 0 Text ist UND Spalte 1+ Zahlen enthält → das ist Datenbeginn
 *   3. Falls es Monats-Spalten gibt (Spaltentitel = Monatsnamen), diese verwenden
 *   4. Ansonsten: alle Zeilen summieren → Spalte "gesamt"
 */
export async function parseProdukteExcel(
  file: File,
  type: 'anzahl' | 'umsatz',
): Promise<ProductEntry[]> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: undefined,
    raw: false,
  });

  // Monats-Name → yyyy-MM Mapping (Deutsch)
  const MONTH_MAP: Record<string, string> = {
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

  // Jahr aus Dateinamen oder aktuell ableiten
  const yearMatch = file.name.match(/(\d{4})/);
  const year = yearMatch ? yearMatch[1] : String(new Date().getFullYear());

  // Finde Header-Zeile (Zeile mit Spaltentiteln)
  let headerRowIdx = -1;
  let dataColMap: { colIdx: number; month: string }[] = []; // Spalten mit Monatszuordnung

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    // Suche Zeile die "Artikel" / "Rezept" / "Produkt" oder Monatsnamen enthält
    const cellsLower = row.map(c => String(c ?? '').toLowerCase().trim());
    const hasMonthCol = cellsLower.some(c => Object.keys(MONTH_MAP).some(m => c.startsWith(m)));
    const hasProductCol = cellsLower.some(c =>
      c.includes('rezept') || c.includes('artikel') || c.includes('produkt') || c.includes('bezeich'),
    );

    if (hasMonthCol || hasProductCol) {
      headerRowIdx = r;
      // Analysiere Spalten
      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] ?? '').toLowerCase().trim();
        if (!cell) continue;
        for (const [mName, mNum] of Object.entries(MONTH_MAP)) {
          if (cell.startsWith(mName)) {
            dataColMap.push({ colIdx: c, month: `${year}-${mNum}` });
            break;
          }
        }
      }
      break;
    }
  }

  // Wenn keine Monatsspalten gefunden → alle numerischen Spalten als "gesamt"
  const hasMonthColumns = dataColMap.length > 0;

  const entries: ProductEntry[] = [];
  const dataStartRow = headerRowIdx >= 0 ? headerRowIdx + 1 : 0;

  for (let r = dataStartRow; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;

    // Produktname ist typischerweise erste nicht-leere Text-Spalte
    const nameRaw = String(row[0] ?? '').trim();
    if (!nameRaw || nameRaw.length < 2) continue;
    // Überspringe Summen-/Total-Zeilen
    const nameLower = nameRaw.toLowerCase();
    if (nameLower.startsWith('total') || nameLower.startsWith('gesamt') ||
        nameLower.startsWith('summe') || nameLower === 'alle') continue;

    if (hasMonthColumns) {
      for (const { colIdx, month } of dataColMap) {
        const val = parseGastronomyNumber(row[colIdx]);
        if (val <= 0) continue;
        upsertEntry(entries, nameRaw, month, type, val);
      }
    } else {
      // Suche ersten numerischen Wert in den Spalten 1+
      let foundVal = 0;
      for (let c = 1; c < row.length; c++) {
        const v = parseGastronomyNumber(row[c]);
        if (v > 0) { foundVal = v; break; }
      }
      if (foundVal > 0) {
        // Versuche Datum aus zweiter Spalte zu lesen
        const dateCell = String(row[1] ?? '').trim();
        const month = extractMonth(dateCell, year);
        upsertEntry(entries, nameRaw, month, type, foundVal);
      }
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
): void {
  const existing = entries.find(e => e.name === name && e.month === month);
  if (existing) {
    if (type === 'anzahl') existing.count  += val;
    else                    existing.revenue += val;
  } else {
    entries.push({
      name,
      month,
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
    const idx = merged.findIndex(e => e.name === inc.name && e.month === inc.month);
    if (idx >= 0) {
      if (type === 'anzahl') merged[idx].count   = inc.count;
      else                    merged[idx].revenue = inc.revenue;
    } else {
      merged.push({ ...inc });
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

export function getTopProducts(
  entries: ProductEntry[],
  month: string,
  sortBy: 'count' | 'revenue',
  limit: number,
  ignoredByUser: string[],
): RankedProduct[] {
  // Aggregiere nach Produktname für den Monat (oder alle Monate wenn 'alle')
  const agg: Record<string, { count: number; revenue: number }> = {};
  const filtered = month === 'alle' ? entries : entries.filter(e => e.month === month);

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

// ── Verfügbare Monate ermitteln ────────────────────────────────────────────────
export function getAvailableMonths(entries: ProductEntry[]): string[] {
  const set = new Set(entries.map(e => e.month));
  return Array.from(set).sort();
}
