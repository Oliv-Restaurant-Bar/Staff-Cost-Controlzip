/**
 * adyen-csv-parser.ts — Parser für den Adyen-Report „Received payment details".
 * ============================================================================
 * Reine Logik: KEIN DOM, KEIN Supabase — synthetisch testbar (node-Umgebung).
 * Betrag-Parsing über die zentrale parseBetragText-Logik (tagesdaten-zahlen).
 *
 * Aufgabe (Spec Umsatzabstimmung / Adyen-Abgleich):
 *   - CSV einlesen, nach Verkaufs-/Creation-Datum gruppieren (NIE Payout-Datum).
 *   - Pro Tag je Zahlungsart (Mastercard/Visa/AMEX/TWINT + dynamisch) summieren.
 *   - Nur CHF-Zeilen berücksichtigen.
 *   - Refunds/negative Beträge vorzeichenbehaftet abziehen.
 *   - Settlement-/Payout-Reports werden als falsches Format ABGELEHNT
 *     (Payout-Date-Logik ist explizit verboten).
 *
 * Diagnose-Regel (Projekt-Konvention): Jeder Parse liefert ein `debug`-Objekt
 * und auf JEDEM Fehlpfad einen konkreten `failureReason` — nie stilles Raten.
 *
 * Datums-Regel: Der Tag wird als String-Präfix aus dem Creation-Date-Feld
 * gelesen (nie `new Date()`), damit die TimeZone-Spalte bzw. die Runtime-TZ
 * Mitternachts-Transaktionen nicht in den Nachbartag verschiebt.
 */

import { parseBetragText } from '@/lib/tagesdaten-zahlen';

// ── Typen ─────────────────────────────────────────────────────────────────────

export interface AdyenDaySummary {
  /** ISO-Tag yyyy-MM-dd (aus Creation Date, String-Präfix). */
  date: string;
  /** Summe CHF je normalisiertem Zahlungsarten-Key (vorzeichenbehaftet). */
  byMethod: Record<string, number>;
  /** Anzahl Transaktionen je Zahlungsarten-Key (Refunds zählen mit). */
  countByMethod: Record<string, number>;
  /** Total Karten/TWINT des Tages (Summe aller byMethod-Werte). */
  total: number;
  /** Anzahl verwerteter Zeilen des Tages. */
  transactionCount: number;
}

export interface AdyenParseDebug {
  fileName: string;
  delimiter: string;
  headerFields: string[];
  totalRows: number;
  usedRows: number;
  skippedNonChf: number;
  skippedNoDate: number;
  skippedNoAmount: number;
  refundRows: number;
  negativeRows: number;
  detectedDays: string[];
  currencies: string[];
  paymentMethodsRaw: string[];
  failureReason: string | null;
}

export interface AdyenParseResult {
  ok: boolean;
  /** Tage aufsteigend sortiert. Leer bei Fehler. */
  days: AdyenDaySummary[];
  /** Anzeige-Label je Zahlungsarten-Key (über alle Tage). */
  methodLabels: Record<string, string>;
  failureReason: string | null;
  warnings: string[];
  debug: AdyenParseDebug;
}

// ── Zahlungsarten-Normalisierung ──────────────────────────────────────────────

/**
 * Normalisiert einen Adyen-Payment-Method-Code auf einen stabilen Key.
 * Bekannte Karten/TWINT werden gebündelt (mc/mc_applepay → mastercard usw.),
 * alles andere bleibt dynamisch als Slug erhalten.
 */
export function normalizeAdyenMethod(raw: string): { key: string; label: string } {
  const v = raw.trim().toLowerCase();
  if (v === 'mc' || v.startsWith('mc_') || v === 'mastercard') {
    return { key: 'mastercard', label: 'Mastercard' };
  }
  if (v === 'visa' || v.startsWith('visa_') || v === 'visadankort' || v === 'electron') {
    return { key: 'visa', label: 'Visa' };
  }
  if (v === 'amex' || v.startsWith('amex_') || v === 'americanexpress') {
    return { key: 'amex', label: 'American Express' };
  }
  if (v === 'twint' || v.startsWith('twint_')) {
    return { key: 'twint', label: 'TWINT' };
  }
  if (v === 'maestro' || v.startsWith('maestro_')) {
    return { key: 'maestro', label: 'Maestro' };
  }
  const key = v.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unbekannt';
  return { key, label: raw.trim() || 'Unbekannt' };
}

// ── Interne Helfer ────────────────────────────────────────────────────────────

/** Header-Namen, die einen Settlement-/Payout-Report verraten (→ Ablehnung). */
const PAYOUT_HEADER_MARKERS = [
  'payout date',
  'payable date',
  'gross debit',
  'gross credit',
  'net debit',
  'net credit',
  'batch number',
  'settlement',
];

const REQUIRED_COLUMNS: Array<{ id: 'creationDate' | 'paymentMethod' | 'currency' | 'amount'; names: string[] }> = [
  { id: 'creationDate',  names: ['creation date', 'creationdate', 'transaction date', 'sales date', 'booking date'] },
  { id: 'paymentMethod', names: ['payment method', 'paymentmethod'] },
  { id: 'currency',      names: ['currency', 'payment currency'] },
  { id: 'amount',        names: ['amount', 'payment amount'] },
];

/** Eine CSV-Zeile mit Quote-Handling in Felder zerlegen. */
function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(cur); cur = '';
    } else cur += ch;
  }
  fields.push(cur);
  return fields.map(f => f.trim());
}

/** Delimiter (Komma vs. Semikolon vs. Tab) anhand der Headerzeile erkennen. */
function detectDelimiter(headerLine: string): string {
  const counts: Array<[string, number]> = [',', ';', '\t'].map(d => [d, headerLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** ISO-Tag als String-Präfix aus dem Creation-Date-Feld (nie Date-Objekt). */
function extractIsoDay(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})[./](\d{2})[./](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

/**
 * Betrag parsen: 1'234.50 / 1234,50 / "6471.60" → number, sonst null.
 * Delegiert an die zentrale Betrag-Logik (parseBetragText: Apostroph-Tausender,
 * Komma- ODER Punkt-Dezimal, EU/US-Formate) — nie stilles 0.
 */
function parseAmount(raw: string): number | null {
  const z = parseBetragText(raw);
  return z.ok ? z.value : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Hauptfunktion ─────────────────────────────────────────────────────────────

export function parseAdyenPaymentsCsv(text: string, fileName = ''): AdyenParseResult {
  const warnings: string[] = [];
  const debug: AdyenParseDebug = {
    fileName,
    delimiter: '',
    headerFields: [],
    totalRows: 0,
    usedRows: 0,
    skippedNonChf: 0,
    skippedNoDate: 0,
    skippedNoAmount: 0,
    refundRows: 0,
    negativeRows: 0,
    detectedDays: [],
    currencies: [],
    paymentMethodsRaw: [],
    failureReason: null,
  };

  const fail = (reason: string): AdyenParseResult => {
    debug.failureReason = reason;
    return { ok: false, days: [], methodLabels: {}, failureReason: reason, warnings, debug };
  };

  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\n|\r/)
    .filter(l => l.trim() !== '');
  if (lines.length === 0) return fail('Die Datei ist leer.');

  const delimiter = detectDelimiter(lines[0]);
  debug.delimiter = delimiter === '\t' ? 'TAB' : delimiter;

  const header = splitCsvLine(lines[0], delimiter);
  debug.headerFields = header;
  const headerLower = header.map(h => h.toLowerCase());

  // Payout-/Settlement-Report erkennen und ABLEHNEN (keine Payout-Date-Logik).
  const payoutMarker = headerLower.find(h => PAYOUT_HEADER_MARKERS.some(m => h.includes(m)));
  if (payoutMarker) {
    const original = header[headerLower.indexOf(payoutMarker)];
    return fail(
      `Dies ist ein Settlement-/Payout-Report (Spalte „${original}" gefunden). ` +
      `Der Abgleich erfolgt nach Verkaufsdatum — bitte den Adyen-Report „Received payment details" exportieren.`,
    );
  }

  // Pflichtspalten auflösen.
  const colIdx: Record<string, number> = {};
  for (const req of REQUIRED_COLUMNS) {
    const idx = headerLower.findIndex(h => req.names.includes(h));
    if (idx === -1) {
      return fail(
        `Pflichtspalte „${req.names[0]}" nicht gefunden. ` +
        `Gefundene Spalten: ${header.slice(0, 12).join(', ')}${header.length > 12 ? ', …' : ''}. ` +
        `Erwartet wird der Adyen-Report „Received payment details" (CSV).`,
      );
    }
    colIdx[req.id] = idx;
  }
  const typeIdx = headerLower.findIndex(h => h === 'type' || h === 'record type');

  if (lines.length === 1) return fail('Die Datei enthält nur eine Kopfzeile, aber keine Datenzeilen.');

  // Zeilen verarbeiten.
  const dayMap = new Map<string, AdyenDaySummary>();
  const methodLabels: Record<string, string> = {};
  const currencies = new Set<string>();
  const methodsRaw = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i], delimiter);
    debug.totalRows++;

    const currency = (fields[colIdx.currency] ?? '').trim().toUpperCase();
    if (currency) currencies.add(currency);
    if (currency !== 'CHF') { debug.skippedNonChf++; continue; }

    const day = extractIsoDay(fields[colIdx.creationDate] ?? '');
    if (!day) { debug.skippedNoDate++; continue; }

    const amount = parseAmount(fields[colIdx.amount] ?? '');
    if (amount === null) { debug.skippedNoAmount++; continue; }

    const rawMethod = (fields[colIdx.paymentMethod] ?? '').trim();
    if (rawMethod) methodsRaw.add(rawMethod);
    const { key, label } = normalizeAdyenMethod(rawMethod);
    if (!methodLabels[key]) methodLabels[key] = label;

    // Refunds/Chargebacks abziehen: Typ-basiert negieren, negative Beträge bleiben negativ.
    const typeRaw = typeIdx >= 0 ? (fields[typeIdx] ?? '').trim().toLowerCase() : '';
    const isRefundType = /refund|chargeback/.test(typeRaw);
    if (isRefundType) debug.refundRows++;
    if (amount < 0) debug.negativeRows++;
    const signed = isRefundType && amount > 0 ? -amount : amount;

    let entry = dayMap.get(day);
    if (!entry) {
      entry = { date: day, byMethod: {}, countByMethod: {}, total: 0, transactionCount: 0 };
      dayMap.set(day, entry);
    }
    entry.byMethod[key] = round2((entry.byMethod[key] ?? 0) + signed);
    entry.countByMethod[key] = (entry.countByMethod[key] ?? 0) + 1;
    entry.total = round2(entry.total + signed);
    entry.transactionCount++;
    debug.usedRows++;
  }

  debug.currencies = [...currencies].sort();
  debug.paymentMethodsRaw = [...methodsRaw].sort();

  if (dayMap.size === 0) {
    if (debug.skippedNonChf > 0 && debug.usedRows === 0) {
      return fail(
        `Keine CHF-Zeilen gefunden (Währungen in der Datei: ${debug.currencies.join(', ') || '—'}). ` +
        `Es werden nur CHF-Zahlungen abgeglichen.`,
      );
    }
    return fail('Keine verwertbaren Datenzeilen gefunden (Datum/Betrag fehlen oder sind unlesbar).');
  }

  if (debug.skippedNonChf > 0) {
    warnings.push(`${debug.skippedNonChf} Nicht-CHF-Zeile(n) übersprungen (nur CHF wird abgeglichen).`);
  }
  if (debug.skippedNoDate > 0) {
    warnings.push(`${debug.skippedNoDate} Zeile(n) ohne lesbares Creation Date übersprungen.`);
  }
  if (debug.skippedNoAmount > 0) {
    warnings.push(`${debug.skippedNoAmount} Zeile(n) ohne lesbaren Betrag übersprungen.`);
  }

  const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  debug.detectedDays = days.map(d => d.date);

  return { ok: true, days, methodLabels, failureReason: null, warnings, debug };
}
