/**
 * Küchen-Dienstplan PDF Parser
 * =============================
 * Liest einen aus Excel exportierten Küchen-Dienstplan-PDF und extrahiert:
 * - Zeitraum (Monat/Jahr), inkl. Start-Datum aus Bereichsangabe
 * - Mitarbeitende (Zeilen)
 * - Schichtcodes pro Tag (Spalten)
 *
 * Erwartet ein Tabellenformat mit Mitarbeitenden zeilenweise und Tagen spaltenweise.
 */

import { format, getYear, getMonth, getDaysInMonth } from 'date-fns';

export interface ParsedScheduleEntry {
  rawName: string;
  date: string;
  code: string;
}

export interface ParsedHeaderDay {
  day: number;
  origDate: string; // ISO date assigned by parser (based on detected month)
}

export interface ParsedKüchenplan {
  entries: ParsedScheduleEntry[];
  detectedPeriod: { from: string; to: string } | null;
  detectedMonth: string | null;
  detectedStartDate: string | null; // yyyy-MM-dd extracted from range "dd.mm.yyyy BIS …"
  headerDays: ParsedHeaderDay[];    // sorted left→right (chronological column order)
  detectedNames: string[];
  detectedCodes: string[];
  logs: string[];
  error: string | null;
}

function roundGrid(v: number, grid = 4): number {
  return Math.round(v / grid) * grid;
}

const MONTH_NAMES_DE = [
  'januar', 'februar', 'märz', 'april', 'mai', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'dezember',
];

function detectMonth(text: string): Date | null {
  const lower = text.toLowerCase();
  for (let m = 0; m < MONTH_NAMES_DE.length; m++) {
    const re = new RegExp(MONTH_NAMES_DE[m] + '\\s+(\\d{4})', 'i');
    const match = lower.match(re);
    if (match) return new Date(parseInt(match[1]), m, 1);
  }
  const shortRe = /\b(0?[1-9]|1[0-2])[./\-](20\d{2})\b/;
  const m2 = text.match(shortRe);
  if (m2) return new Date(parseInt(m2[2]), parseInt(m2[1]) - 1, 1);
  return null;
}

/** Versucht "dd.mm.yyyy" aus Freitext zu lesen. */
function parseGermanDate(text: string): string | null {
  const m = text.match(/(\d{1,2})\.(\d{1,2})\.(20\d{2})/);
  if (!m) return null;
  const d = parseInt(m[1]);
  const mo = parseInt(m[2]) - 1;
  const y = parseInt(m[3]);
  const date = new Date(y, mo, d);
  if (isNaN(date.getTime())) return null;
  return format(date, 'yyyy-MM-dd');
}

export async function parseKüchenplanPDF(file: File): Promise<ParsedKüchenplan> {
  const logs: string[] = [];
  const entries: ParsedScheduleEntry[] = [];

  try {
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    logs.push(`PDF geladen: ${pdf.numPages} Seite(n)`);

    type TextItem = { x: number; y: number; text: string };
    const allItems: TextItem[] = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      tc.items.forEach((item: any) => {
        const text = (item.str ?? '').trim();
        if (!text) return;
        allItems.push({ x: item.transform[4], y: item.transform[5], text });
      });
    }

    logs.push(`Textitems: ${allItems.length}`);

    // Group into rows by rounded y (PDF y is bottom-up, so descending = top-to-bottom)
    const rowMap = new Map<number, TextItem[]>();
    for (const item of allItems) {
      const ry = roundGrid(item.y, 4);
      if (!rowMap.has(ry)) rowMap.set(ry, []);
      rowMap.get(ry)!.push(item);
    }

    const sortedYs = Array.from(rowMap.keys()).sort((a, b) => b - a); // top first
    const rows = sortedYs.map(y => ({
      y,
      items: rowMap.get(y)!.sort((a, b) => a.x - b.x),
    }));

    // Detect month + start date from title rows (first 8 rows)
    let detectedMonth: Date | null = null;
    let detectedStartDate: string | null = null;

    for (const row of rows.slice(0, 8)) {
      const joined = row.items.map(i => i.text).join(' ');

      // Try to extract date range like "30.03.2026 BIS 26.04.2026"
      if (!detectedStartDate) {
        const rangeMatch = joined.match(/(\d{1,2}\.\d{1,2}\.20\d{2})\s+BIS\b/i);
        if (rangeMatch) {
          detectedStartDate = parseGermanDate(rangeMatch[1]);
          if (detectedStartDate) {
            logs.push(`Start-Datum aus Bereich erkannt: ${detectedStartDate}`);
          }
        }
      }

      if (!detectedMonth) {
        detectedMonth = detectMonth(joined);
        if (detectedMonth) {
          logs.push(`Monat erkannt: ${MONTH_NAMES_DE[getMonth(detectedMonth)]} ${getYear(detectedMonth)}`);
        }
      }

      if (detectedStartDate && detectedMonth) break;
    }

    // If we have a start date but no month, derive month from start date
    if (detectedStartDate && !detectedMonth) {
      const sd = new Date(detectedStartDate + 'T00:00:00');
      detectedMonth = new Date(sd.getFullYear(), sd.getMonth(), 1);
      logs.push(`Monat aus Start-Datum abgeleitet: ${MONTH_NAMES_DE[getMonth(detectedMonth)]} ${getYear(detectedMonth)}`);
    }

    if (!detectedMonth) {
      detectedMonth = new Date();
      detectedMonth.setDate(1);
      logs.push('⚠️ Zeitraum nicht erkannt – verwende aktuellen Monat');
    }

    // Find date-header row: row with ≥7 integers 1–31
    let headerRowIdx = -1;
    let headerDayCols: Array<{ x: number; day: number }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const dayItems = row.items.filter(it => {
        const n = parseInt(it.text, 10);
        return !isNaN(n) && n >= 1 && n <= 31 && it.text.trim() === String(n);
      });
      if (dayItems.length >= 7) {
        headerRowIdx = i;
        headerDayCols = dayItems.map(it => ({ x: it.x, day: parseInt(it.text, 10) }));
        logs.push(`Datum-Headerzeile bei y=${rows[i].y}: ${dayItems.length} Tagesspalten`);
        logs.push(`Tage: ${dayItems.map(d => d.day).join(', ')}`);
        break;
      }
    }

    if (headerRowIdx === -1) {
      logs.push('❌ Keine Datum-Headerzeile gefunden (erwartet: Zeile mit Zahlen 1–31)');
      return {
        entries: [], detectedPeriod: null, detectedMonth: null,
        detectedStartDate: null, headerDays: [],
        detectedNames: [], detectedCodes: [], logs,
        error: 'Keine Datum-Kopfzeile gefunden. Bitte prüfen ob das PDF das richtige Format hat.',
      };
    }

    const firstDayX = Math.min(...headerDayCols.map(d => d.x));
    const colGap = headerDayCols.length > 1
      ? (headerDayCols[headerDayCols.length - 1].x - headerDayCols[0].x) / (headerDayCols.length - 1)
      : 20;
    const colTol = colGap * 0.55;
    logs.push(`Spaltengrösse: ~${colGap.toFixed(1)}px, Toleranz: ±${colTol.toFixed(1)}px`);

    // Map day number → ISO date (using detectedMonth, handles single-month plans)
    const year = getYear(detectedMonth);
    const month = getMonth(detectedMonth);
    const daysInMonth = getDaysInMonth(detectedMonth);
    const dayToDate = new Map<number, string>();
    for (const { day } of headerDayCols) {
      if (day >= 1 && day <= daysInMonth) {
        dayToDate.set(day, format(new Date(year, month, day), 'yyyy-MM-dd'));
      }
    }

    // Build headerDays sorted left→right (chronological)
    const headerDays: ParsedHeaderDay[] = headerDayCols
      .slice()
      .sort((a, b) => a.x - b.x)
      .map(col => ({
        day: col.day,
        origDate: dayToDate.get(col.day) ?? format(new Date(year, month, col.day), 'yyyy-MM-dd'),
      }));

    function nearestDay(x: number): number | null {
      let best: number | null = null;
      let bestDist = Infinity;
      for (const { x: cx, day } of headerDayCols) {
        const d = Math.abs(x - cx);
        if (d < bestDist && d <= colTol) { bestDist = d; best = day; }
      }
      return best;
    }

    // Skip weekday row immediately after header (contains Mo, Di, Mi …)
    let dataStart = headerRowIdx + 1;
    if (dataStart < rows.length) {
      const nextRowText = rows[dataStart].items.map(i => i.text.toLowerCase()).join(' ');
      if (/\bmo\b|\bdi\b|\bmi\b|\bdo\b|\bfr\b|\bsa\b|\bso\b/.test(nextRowText)) {
        dataStart++;
        logs.push('Wochentag-Zeile übersprungen');
      }
    }

    const detectedNames: string[] = [];
    const codesSet = new Set<string>();
    const SKIP_NAMES = /total|summe|gesamt|stunden|legende|mitarbeiter/i;

    for (let i = dataStart; i < rows.length; i++) {
      const row = rows[i];
      if (row.items.length < 2) continue;

      const nameItems = row.items.filter(it => it.x < firstDayX - colGap * 0.3);
      const shiftItems = row.items.filter(it => it.x >= firstDayX - colGap * 0.3);

      if (nameItems.length === 0) continue;

      const rawName = nameItems.map(i => i.text).join(' ').trim();
      if (!rawName || rawName.length < 2) continue;
      if (SKIP_NAMES.test(rawName)) continue;
      if (/^\d+$/.test(rawName)) continue;

      if (!detectedNames.includes(rawName)) {
        detectedNames.push(rawName);
      }

      for (const si of shiftItems) {
        const day = nearestDay(si.x);
        if (day === null) continue;
        const date = dayToDate.get(day);
        if (!date) continue;
        const code = si.text.trim();
        if (!code || code === ' ') continue;
        codesSet.add(code);
        entries.push({ rawName, date, code });
      }
    }

    logs.push(`Mitarbeitende (${detectedNames.length}): ${detectedNames.join(', ')}`);
    logs.push(`Erkannte Codes: ${[...codesSet].join(', ')}`);
    logs.push(`Importierbare Einträge: ${entries.length}`);

    const allDates = [...dayToDate.values()].sort();
    const detectedPeriod = allDates.length > 0
      ? { from: allDates[0], to: allDates[allDates.length - 1] }
      : null;

    if (detectedPeriod) {
      logs.push(`Zeitraum: ${detectedPeriod.from} → ${detectedPeriod.to}`);
    }

    // Use detectedStartDate from range if available; fallback to detectedPeriod.from
    const finalStartDate = detectedStartDate ?? detectedPeriod?.from ?? null;

    return {
      entries,
      detectedPeriod,
      detectedMonth: detectedMonth ? format(detectedMonth, 'yyyy-MM') : null,
      detectedStartDate: finalStartDate,
      headerDays,
      detectedNames,
      detectedCodes: [...codesSet],
      logs,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(`❌ Fehler beim Parsen: ${msg}`);
    console.error('[küchenplan-parser]', err);
    return {
      entries: [],
      detectedPeriod: null,
      detectedMonth: null,
      detectedStartDate: null,
      headerDays: [],
      detectedNames: [],
      detectedCodes: [],
      logs,
      error: msg,
    };
  }
}
