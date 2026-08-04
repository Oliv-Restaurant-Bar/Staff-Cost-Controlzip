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

    // Find date-header band: look for a Y-band of rows (within ±14px of each other)
    // that together contain ≥5 distinct integers in range 1–31.
    // This handles PDFs where the date row is split across multiple sub-rows due to
    // the complex multi-week-column layout (Excel export quirk).
    let headerRowIdx = -1;
    let headerDayCols: Array<{ x: number; day: number }> = [];
    let headerBandMaxIdx = -1; // last row index that is part of the header band

    const isDayItem = (it: { x: number; text: string }) => {
      const trimmed = it.text.trim();
      const n = parseInt(trimmed, 10);
      // Accept exact integer match: "5", "10", "31" — not "10 11" or "05"
      return !isNaN(n) && n >= 1 && n <= 31 && trimmed === String(n);
    };

    const Y_BAND = 14; // px tolerance for merging rows into the date header band

    for (let i = 0; i < rows.length; i++) {
      // Collect all items from rows within ±Y_BAND y-distance of rows[i]
      const bandItems: { x: number; text: string }[] = [];
      let maxBandIdx = i;
      for (let j = 0; j < rows.length; j++) {
        if (Math.abs(rows[j].y - rows[i].y) <= Y_BAND) {
          bandItems.push(...rows[j].items);
          if (j > maxBandIdx) maxBandIdx = j;
        }
      }

      const dayItems = bandItems.filter(isDayItem);

      // Deduplicate by x-position (same item might appear from multiple rows in band)
      const seenX = new Set<number>();
      const uniqueDayItems = dayItems.filter(it => {
        const rx = Math.round(it.x / 2) * 2; // round to nearest 2px
        if (seenX.has(rx)) return false;
        seenX.add(rx);
        return true;
      });

      if (uniqueDayItems.length >= 5) {
        headerRowIdx = i;
        headerBandMaxIdx = maxBandIdx;
        headerDayCols = uniqueDayItems.map(it => ({ x: it.x, day: parseInt(it.text, 10) }));
        logs.push(
          `Datum-Headerband bei y≈${rows[i].y} (±${Y_BAND}px): ` +
          `${uniqueDayItems.length} Tagesspalten erkannt`,
        );
        logs.push(`Tage: ${uniqueDayItems.sort((a, b) => a.day - b.day).map(d => d.day).join(', ')}`);
        break;
      }
    }

    if (headerRowIdx === -1) {
      logs.push('❌ Keine Datum-Headerzeile gefunden (erwartet: Zeile mit Zahlen 1–31)');
      // Extra diagnostic: list largest day-number count per row to help debug
      for (let i = 0; i < Math.min(rows.length, 20); i++) {
        const cnt = rows[i].items.filter(isDayItem).length;
        if (cnt > 0) {
          logs.push(`  Zeile y=${rows[i].y}: ${cnt} Tageszahlen, Inhalt: ${rows[i].items.map(t => t.text).slice(0, 15).join(' ')}`);
        }
      }
      return {
        entries: [], detectedPeriod: null, detectedMonth: null,
        detectedStartDate: null, headerDays: [],
        detectedNames: [], detectedCodes: [], logs,
        error: 'Keine Datum-Kopfzeile gefunden. Bitte prüfen ob das PDF das richtige Format hat.',
      };
    }

    // Sort by x so colGap and firstDayX are always computed from ordered columns
    headerDayCols.sort((a, b) => a.x - b.x);

    const firstDayX = headerDayCols[0].x;
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

    // ── Datenbereich per Y-KOORDINATEN abgrenzen (nicht per Zeilen-Index) ──
    // Name und Schicht-Codes eines Mitarbeiters liegen im PDF oft auf leicht
    // versetzten Grundlinien (~3px, Richtung uneinheitlich): FE-Ferienzellen
    // auf der Namens-Grundlinie, Arbeits-Codes (A/B/E/O1/O2) daneben. Feste
    // y-Buckets zerlegen solche Mitarbeiter in eine Namens- und eine namenlose
    // Code-Zeile — deshalb: Namens-ANKER bestimmen und jedem Anker alle
    // Schicht-Zellen seines Bandes zuordnen. Der Bereich wird über die
    // Unterkante des Header-INHALTS (Tageszahlen + Wochentage) bestimmt, damit
    // der oberste Mitarbeiter nicht vom Header-Band-Skip verschluckt wird.
    const headerDayItemYs: number[] = [];
    for (let j = 0; j < rows.length; j++) {
      if (Math.abs(rows[j].y - rows[headerRowIdx].y) <= Y_BAND) {
        for (const it of rows[j].items) if (isDayItem(it)) headerDayItemYs.push(it.y);
      }
    }
    let headerBottomY = headerDayItemYs.length > 0
      ? Math.min(...headerDayItemYs)
      : rows[headerRowIdx].y;

    // Wochentag-Zeile (Mo Di Mi …) direkt unter den Tageszahlen gehört noch
    // zum Header — Unterkante entsprechend nachziehen.
    for (let j = headerBandMaxIdx + 1; j < Math.min(rows.length, headerBandMaxIdx + 3); j++) {
      const t = rows[j].items.map(i => i.text.toLowerCase()).join(' ');
      if (/\bmo\b|\bdi\b|\bmi\b|\bdo\b|\bfr\b|\bsa\b|\bso\b/.test(t) && rows[j].y < headerBottomY) {
        headerBottomY = rows[j].y;
        logs.push('Wochentag-Zeile übersprungen');
        break;
      }
    }

    // Legenden-Block: ab «DIENSTE LEGENDE» ist Schluss — alles darunter ist
    // Nachschlagetabelle (Zeiten, «KO= Kompensation» …) und erzeugt NIE Codes.
    let legendY = -Infinity;
    for (const row of rows) {
      if (row.y >= headerBottomY) continue;
      if (/LEGENDE/i.test(row.items.map(it => it.text).join(' '))) {
        legendY = row.y;
        logs.push(`Legenden-Block ab y=${row.y} erkannt — Raster-Parsing beendet`);
        break;
      }
    }

    // Alle Items des Datenbereichs (PDF-y ist bottom-up: kleiner = weiter unten)
    const regionItems: TextItem[] = allItems.filter(
      it => it.y < headerBottomY - 2 && it.y > legendY,
    );

    const nameXLimit = firstDayX - colGap * 0.3;
    const SKIP_NAMES = /total|summe|gesamt|stunden|legende|mitarbeiter/i;

    // ── 1) Namens-Anker: Namensspalten-Items nach y clustern (Gap ≤ 6px) ──
    // Auch Total-/Summen-Zeilen werden als (ungültige) Anker geführt: sie
    // absorbieren ihre Zahlen-Items, statt dass diese dem nächsten echten
    // Mitarbeiter zugeschlagen würden.
    const nameColItems = regionItems
      .filter(it => it.x < nameXLimit)
      .sort((a, b) => b.y - a.y); // oben → unten
    type Anker = { y: number; parts: TextItem[]; rawName: string; valid: boolean };
    const anker: Anker[] = [];
    for (const it of nameColItems) {
      const last = anker[anker.length - 1];
      if (last && Math.abs(last.parts[last.parts.length - 1].y - it.y) <= 6) {
        last.parts.push(it);
      } else {
        anker.push({ y: it.y, parts: [it], rawName: '', valid: false });
      }
    }
    for (const a of anker) {
      a.y = a.parts.reduce((s, p) => s + p.y, 0) / a.parts.length;
      a.rawName = a.parts.slice().sort((p, q) => p.x - q.x).map(p => p.text).join(' ').trim();
      a.valid = a.rawName.length >= 2 && !SKIP_NAMES.test(a.rawName) && !/^\d+([.,]\d+)?$/.test(a.rawName);
    }

    const detectedNames: string[] = [];
    for (const a of anker) {
      if (a.valid && !detectedNames.includes(a.rawName)) detectedNames.push(a.rawName);
    }

    // ── 2) Schicht-Zellen dem NÄCHSTGELEGENEN Anker zuordnen ──────────────
    // Band = Name-Grundlinie ± versetzte Code-Unterzeilen (typ. ±8px). Als
    // Sicherheitsgrenze dient der halbe Zeilenabstand der Anker; Zellen
    // ausserhalb jeder plausiblen Distanz werden NICHT still verworfen,
    // sondern als Warnung protokolliert.
    const pitches: number[] = [];
    for (let k = 1; k < anker.length; k++) pitches.push(Math.abs(anker[k - 1].y - anker[k].y));
    const medianPitch = pitches.length > 0
      ? pitches.slice().sort((a, b) => a - b)[Math.floor(pitches.length / 2)]
      : 16;
    const maxDist = Math.max(10, medianPitch * 0.75);

    const codesSet = new Set<string>();
    let verwaist = 0;
    const shiftCells = regionItems.filter(it => it.x >= nameXLimit);
    for (const si of shiftCells) {
      const day = nearestDay(si.x);
      if (day === null) continue;
      const date = dayToDate.get(day);
      if (!date) continue;
      // Normalisieren: Leerzeichen entfernen («B a»→«Ba»), trailing «=» strippen («FE=»→«FE»)
      const code = si.text.replace(/\s+/g, '').replace(/=+$/, '');
      if (!code) continue;

      let best: Anker | null = null;
      let bestDist = Infinity;
      for (const a of anker) {
        const d = Math.abs(si.y - a.y);
        if (d < bestDist) { bestDist = d; best = a; }
      }
      if (!best || bestDist > maxDist) {
        verwaist++;
        logs.push(`⚠️ Schicht-Zelle ohne Namens-Zuordnung: «${si.text}» (Tag ${day}, y=${si.y.toFixed(1)}, nächster Anker ${bestDist.toFixed(1)}px entfernt)`);
        continue;
      }
      if (!best.valid) continue; // Total-/Summen-Zeile — bewusst kein Eintrag

      codesSet.add(code);
      entries.push({ rawName: best.rawName, date, code });
    }
    if (verwaist > 0) {
      logs.push(`⚠️ ${verwaist} Schicht-Zelle(n) konnten keinem Mitarbeiter zugeordnet werden — bitte Vorschau prüfen`);
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
