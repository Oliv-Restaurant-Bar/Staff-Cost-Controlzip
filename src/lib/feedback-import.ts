/**
 * feedback-import — Feedback-CSV (Lunchgate) parsen + Upsert-Vorschau
 * ===================================================================
 * REIN & testbar (keine I/O). Format fix: Trennzeichen «;», UTF-8 (mit BOM),
 * mehrzeilige Kommentare in Anführungszeichen. Spalten: «Publish Date»,
 * «Pax», «Guest», «Reservation Date», «Average», «Service», «Kitchen»,
 * «Atmosphere», «Performance», «Comment».
 *
 * Regeln:
 *  - Pro Zeile eine Bewertung: Datum = Publish Date; Sterne = Average
 *    kaufmännisch gerundet (4.5→5, 3.8→4, 2.3→2); exakter Average zusätzlich;
 *    Plattform = Lunchgate; Reservation Date als Besuchsdatum.
 *  - Upsert-Schlüssel: Publish Date + Guest + Reservation Date; fehlen Guest
 *    UND Reservation Date, dient ein stabiler Zeilen-Hash als Schlüssel.
 *    Erneuter Import ERSETZT bestehende Einträge (idempotent) — nie doppelt.
 *  - Vorschau: «X neu · Y aktualisiert · Z unverändert» + Verteilung 1–5.
 *  - Parser liefert IMMER ein debug-Objekt + failureReason auf allen Pfaden
 *    (Memory: gn-parser-diagnostics) — nie blind an ein geratenes Format anpassen.
 */

import type { SingleReview } from '@/lib/reviews-store';

/** Plattform-Label des Reservationstool-Feedbacks (Rückfrage geklärt). */
export const FEEDBACK_PLATFORM = 'Lunchgate';

export interface ParsedFeedbackRow {
  /** yyyy-MM-dd (Publish Date) — Pflicht. */
  publishDate: string;
  /** yyyy-MM-dd (Reservation Date, Besuchsdatum), optional. */
  visitDate?: string;
  guest: string;
  pax?: number;
  /** Exakter Average (0–5). */
  average: number;
  /** Sterne 1–5 = Average kaufmännisch gerundet (min. 1). */
  stars: number;
  subRatings?: { service?: number; kitchen?: number; atmosphere?: number; performance?: number };
  comment: string;
  /** Stabiler Upsert-Schlüssel. */
  importKey: string;
}

export interface FeedbackParseResult {
  rows: ParsedFeedbackRow[];
  /** Übersprungene Zeilen mit Grund (1-basierte CSV-Datenzeile). */
  skipped: { line: number; reason: string }[];
  /** null = ok; sonst Gesamtscheitern mit Grund. */
  failureReason: string | null;
  /** Diagnose: erkannte Header, Zeilenzahlen. */
  debug: { headers: string[]; totalRecords: number; delimiter: string };
}

// ── CSV-Grundparser (BOM, «;», Quotes inkl. mehrzeiliger Felder, "" -Escape) ──

export function parseCsvRecords(text: string, delimiter = ';'): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let field = '', record: string[] = [], inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } // "" → "
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      record.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      record.push(field); field = '';
      // Ganz leere Zeilen überspringen
      if (record.length > 1 || record[0].trim() !== '') records.push(record);
      record = [];
    } else field += ch;
  }
  record.push(field);
  if (record.length > 1 || record[0].trim() !== '') records.push(record);
  return records;
}

// ── Feld-Parser ───────────────────────────────────────────────────────────────

/** Datum tolerant: dd.MM.yyyy / yyyy-MM-dd / dd.MM.yy, optional mit Uhrzeit. */
export function parseFeedbackDate(raw: string): string | null {
  const s = raw.trim().split(/[ T]/)[0];
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const mm = m[2].padStart(2, '0'), dd = m[1].padStart(2, '0');
    if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
    return `${y}-${mm}-${dd}`;
  }
  return null;
}

/** Zahl tolerant («4,5» / «4.5»); null wenn keine Zahl. */
function parseNum(raw: string | undefined): number | null {
  if (raw == null) return null;
  const s = raw.trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Kaufmännische Rundung auf Sterne 1–5 (Average 0 → keine gültige Bewertung). */
export function roundToStars(avg: number): number | null {
  if (!Number.isFinite(avg) || avg <= 0 || avg > 5) return null;
  return Math.min(5, Math.max(1, Math.round(avg)));
}

/** Stabiler Zeilen-Hash (djb2, hex) als Schlüssel-Fallback. */
export function lineHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * Upsert-Schlüssel: Publish Date + Guest + Reservation Date. OHNE Gast ist
 * der natürliche Schlüssel nicht eindeutig (zwei anonyme Feedbacks am selben
 * Tag wären sonst EIN Datensatz) → dann immer stabiler Zeilen-Hash.
 */
export function feedbackImportKey(
  publishDate: string, guest: string, visitDate: string | undefined, rawLine: string,
): string {
  const g = guest.trim().toLowerCase().replace(/\s+/g, ' ');
  if (g === '') return `fb|hash|${lineHash(rawLine)}`;
  return `fb|${publishDate}|${g}|${visitDate ?? ''}`;
}

// ── Hauptparser ───────────────────────────────────────────────────────────────

const REQUIRED_HEADERS = ['publish date', 'average'];

export function parseFeedbackCsv(text: string): FeedbackParseResult {
  const empty = (reason: string, headers: string[] = [], total = 0): FeedbackParseResult => ({
    rows: [], skipped: [], failureReason: reason,
    debug: { headers, totalRecords: total, delimiter: ';' },
  });
  if (!text || text.trim() === '') return empty('Datei ist leer.');

  const records = parseCsvRecords(text, ';');
  if (records.length === 0) return empty('Keine Zeilen gefunden.');

  const headers = records[0].map(h => h.trim());
  const hIdx = new Map(headers.map((h, i) => [h.toLowerCase(), i]));
  const missing = REQUIRED_HEADERS.filter(h => !hIdx.has(h));
  if (missing.length > 0) {
    return empty(
      `Erwartete Spalten fehlen: ${missing.join(', ')}. Gefundene Spalten: ${headers.join(' | ') || '—'}. `
      + 'Format: Feedback-CSV mit «;»-Trennzeichen und Kopfzeile «Publish Date;Pax;Guest;Reservation Date;Average;Service;Kitchen;Atmosphere;Performance;Comment».',
      headers, records.length,
    );
  }
  const col = (name: string, rec: string[]): string => {
    const i = hIdx.get(name);
    return i != null && i < rec.length ? rec[i] : '';
  };

  const rows: ParsedFeedbackRow[] = [];
  const skipped: { line: number; reason: string }[] = [];
  const seen = new Map<string, number>(); // importKey → Index in rows (letzte Zeile gewinnt)

  for (let li = 1; li < records.length; li++) {
    const rec = records[li];
    if (rec.every(c => c.trim() === '')) continue;
    const publishDate = parseFeedbackDate(col('publish date', rec));
    if (!publishDate) { skipped.push({ line: li, reason: `Ungültiges Publish Date «${col('publish date', rec)}»` }); continue; }
    const average = parseNum(col('average', rec));
    const stars = average != null ? roundToStars(average) : null;
    if (average == null || stars == null) {
      skipped.push({ line: li, reason: `Ungültiger Average «${col('average', rec)}»` }); continue;
    }
    const visitDate = parseFeedbackDate(col('reservation date', rec)) ?? undefined;
    const guest = col('guest', rec).trim();
    const pax = parseNum(col('pax', rec));
    const sub: NonNullable<ParsedFeedbackRow['subRatings']> = {};
    const service = parseNum(col('service', rec));
    const kitchen = parseNum(col('kitchen', rec));
    const atmosphere = parseNum(col('atmosphere', rec));
    const performance = parseNum(col('performance', rec));
    if (service != null) sub.service = service;
    if (kitchen != null) sub.kitchen = kitchen;
    if (atmosphere != null) sub.atmosphere = atmosphere;
    if (performance != null) sub.performance = performance;

    const row: ParsedFeedbackRow = {
      publishDate,
      ...(visitDate ? { visitDate } : {}),
      guest,
      ...(pax != null && pax > 0 ? { pax: Math.round(pax) } : {}),
      average, stars,
      ...(Object.keys(sub).length > 0 ? { subRatings: sub } : {}),
      comment: col('comment', rec).trim(),
      importKey: feedbackImportKey(publishDate, guest, visitDate, rec.join(';')),
    };
    // Datei-interne Dubletten (gleicher Schlüssel): letzte Zeile gewinnt —
    // ein Batch darf denselben Eintrag nicht zweimal upserten.
    const prev = seen.get(row.importKey);
    if (prev != null) rows[prev] = row;
    else { seen.set(row.importKey, rows.length); rows.push(row); }
  }

  if (rows.length === 0) {
    return {
      rows: [], skipped,
      failureReason: skipped.length > 0
        ? `Keine gültigen Zeilen — ${skipped.length} übersprungen (erste: Zeile ${skipped[0].line}: ${skipped[0].reason}).`
        : 'Keine Datenzeilen gefunden.',
      debug: { headers, totalRecords: records.length, delimiter: ';' },
    };
  }
  return { rows, skipped, failureReason: null, debug: { headers, totalRecords: records.length, delimiter: ';' } };
}

// ── Upsert-Vorschau («X neu · Y aktualisiert · Z unverändert») ────────────────

export interface FeedbackPreview {
  neu: number;
  aktualisiert: number;
  unveraendert: number;
  /** Sterne-Verteilung ALLER importierten Zeilen (1–5). */
  starDist: Record<1 | 2 | 3 | 4 | 5, number>;
  /** Fertige Reviews für den Schreibvorgang (nur neu + aktualisiert). */
  toWrite: SingleReview[];
}

/** Feldweiser Gleichheitsvergleich der import-relevanten Werte. */
function sameReview(a: SingleReview, row: ParsedFeedbackRow): boolean {
  const subEq = JSON.stringify(a.subRatings ?? {}) === JSON.stringify(row.subRatings ?? {});
  return a.date === row.publishDate
    && a.stars === row.stars
    && (a.avgExact ?? null) === row.average
    && a.text === row.comment
    && (a.author ?? '') === row.guest
    && (a.visitDate ?? null) === (row.visitDate ?? null)
    && (a.pax ?? null) === (row.pax ?? null)
    && subEq;
}

function rowToReview(row: ParsedFeedbackRow, existing: SingleReview | undefined, newId: () => string): SingleReview {
  return {
    // Bestehende ID wiederverwenden = ERSETZEN statt zweiter Eintrag (idempotent).
    id: existing?.id ?? newId(),
    date: row.publishDate,
    platform: FEEDBACK_PLATFORM,
    stars: row.stars,
    text: row.comment,
    ...(row.guest ? { author: row.guest } : {}),
    answered: existing?.answered ?? false,
    ...(existing?.screenshotPath ? { screenshotPath: existing.screenshotPath } : {}),
    ...(row.visitDate ? { visitDate: row.visitDate } : {}),
    ...(row.pax != null ? { pax: row.pax } : {}),
    avgExact: row.average,
    ...(row.subRatings ? { subRatings: row.subRatings } : {}),
    importKey: row.importKey,
    source: 'feedback_csv',
    updatedAt: new Date(0).toISOString(), // wird beim Schreiben gesetzt
  };
}

/**
 * Vorschau gegen den Bestand: Match über importKey (Import-Altbestand)
 * — bestehende Einträge werden AKTUALISIERT (gleiche ID), nie dupliziert.
 */
export function buildFeedbackPreview(
  parsed: ParsedFeedbackRow[], existing: SingleReview[], newId: () => string,
): FeedbackPreview {
  const byKey = new Map<string, SingleReview>();
  for (const r of existing) {
    if (r.importKey && !r.deleted) byKey.set(r.importKey, r);
  }
  const starDist: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let neu = 0, aktualisiert = 0, unveraendert = 0;
  const toWrite: SingleReview[] = [];
  for (const row of parsed) {
    starDist[row.stars as 1 | 2 | 3 | 4 | 5]++;
    const ex = byKey.get(row.importKey);
    if (!ex) { neu++; toWrite.push(rowToReview(row, undefined, newId)); continue; }
    if (sameReview(ex, row)) { unveraendert++; continue; }
    aktualisiert++;
    toWrite.push(rowToReview(row, ex, newId));
  }
  return { neu, aktualisiert, unveraendert, starDist, toWrite };
}
