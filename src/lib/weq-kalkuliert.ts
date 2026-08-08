/**
 * Kalkulierter Wareneinsatz (WEQ-Quelle) aus Kassen-Export-Dateien.
 *
 * Quelle: XLSX-Exporte im Format «Bezeichnung | Zeitraum | 01.01. | 02.01. | …»
 *  - CHF-Datei: Zeile «Gesamt» mit Tageswerten «CHF 1784,56» = kalkulierter
 *    Wareneinsatz pro Tag (Food+Beverage). DIESE Datei ist die Datenbasis.
 *  - %-Datei: Zeilen Food/Durchschnitt/Beverage mit Tages-WEQ in % (BRUTTO-
 *    Quote der Kasse). Wird erkannt und NICHT übernommen — die massgebliche
 *    WEQ wird gegen den NETTO-Umsatz (umsatz-SSOT) gerechnet, nie die
 *    Brutto-Quote 1:1 (Entscheid 08/2026).
 *
 * Ablage: KV `weq-kalkuliert:<jahr>` (tenant-präfixiert) mit CHF-Summen je
 * Monat. Nur Monate mit ausreichender Tagesabdeckung (≥ 20 Tage) zählen als
 * vollständig — Teilmonate (z.B. Export mitten im Monat) bleiben null und
 * laufen über die Ø-Näherung der vorhandenen Monate.
 */
import * as XLSX from 'xlsx';
import { kvGet, kvSetStrict } from '@/lib/supabase-kv';

type KeyFn = (key: string) => string;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface WeqKalkBlob {
  year: number;
  /** Kalkulierter Wareneinsatz CHF je Monat (null = kein/unvollständiger Monat). */
  chfMonate: (number | null)[];
  /** Erfasste Tage je Monat (Transparenz/Diagnose). */
  tageMonate: number[];
  /**
   * Direkt hinterlegte NETTO-WEQ je Monat in % (kalkulierter Wareneinsatz-CHF
   * ÷ Netto-Umsatz — NIE die Brutto-Kassenquote). Wenn gesetzt, hat sie
   * VORRANG vor chfMonate: Budget = Quote × ER-Netto-Budget des Monats.
   */
  weqNettoMonate?: (number | null)[];
  /** true = Monat ist eine Näherung (z.B. Ø der belegten Monate). */
  naeherungMonate?: boolean[];
  quelleDateien: string[];
  updatedAt: string;
}

export const weqKalkKvKey = (tenantKey: KeyFn, year: number) =>
  tenantKey(`weq-kalkuliert:${year}`);

export async function loadWeqKalk(
  tenantKey: KeyFn, year: number,
): Promise<WeqKalkBlob | null> {
  const raw = await kvGet(weqKalkKvKey(tenantKey, year)).catch(() => null);
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Partial<WeqKalkBlob>;
  if (!Array.isArray(b.chfMonate) || b.chfMonate.length !== 12) return null;
  return {
    year,
    chfMonate: b.chfMonate.map(v => (typeof v === 'number' ? v : null)),
    tageMonate: Array.isArray(b.tageMonate) && b.tageMonate.length === 12
      ? b.tageMonate.map(v => (typeof v === 'number' ? v : 0)) : Array(12).fill(0),
    weqNettoMonate: Array.isArray(b.weqNettoMonate) && b.weqNettoMonate.length === 12
      ? b.weqNettoMonate.map(v => (typeof v === 'number' ? v : null)) : undefined,
    naeherungMonate: Array.isArray(b.naeherungMonate) && b.naeherungMonate.length === 12
      ? b.naeherungMonate.map(v => v === true) : undefined,
    quelleDateien: Array.isArray(b.quelleDateien) ? b.quelleDateien.map(String) : [],
    updatedAt: String(b.updatedAt ?? ''),
  };
}

export async function saveWeqKalk(tenantKey: KeyFn, blob: WeqKalkBlob): Promise<void> {
  await kvSetStrict(weqKalkKvKey(tenantKey, blob.year), {
    ...blob, updatedAt: new Date().toISOString(),
  });
}

export interface WeqParseErgebnis {
  /** 'chf' = Datenbasis übernommen · 'pct' = %-Datei erkannt und übersprungen. */
  typ: 'chf' | 'pct';
  chfMonate: (number | null)[];
  tageMonate: number[];
  debug: string;
}

/** Mindest-Tagesabdeckung, damit ein Monat als vollständig gilt. */
export const WEQ_MIN_TAGE = 20;

/**
 * Parst eine WEQ-Export-Datei (ArrayBuffer). Wirft mit klarer Meldung, wenn
 * das Format nicht erkannt wird (nie blind an ein geratenes Format anpassen).
 * NIE `cellDates:true` (Excel-1904-Bug verschiebt Daten um +4 Jahre).
 */
export function parseWeqExport(data: ArrayBuffer, dateiName: string): WeqParseErgebnis {
  const wb = XLSX.read(data, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error(`${dateiName}: kein Arbeitsblatt gefunden.`);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
  const hdr = rows[0] ?? [];
  if (String(hdr[0] ?? '') !== 'Bezeichnung' || String(hdr[1] ?? '') !== 'Zeitraum') {
    throw new Error(
      `${dateiName}: erwartet Kopfzeile «Bezeichnung | Zeitraum | 01.01. | …», `
      + `gefunden: ${JSON.stringify(hdr.slice(0, 4))}.`);
  }
  // Spalten → Tag (Header «TT.MM.», Jahr implizit = Auswahl des Nutzers).
  // Doppelte Tagesspalten sind ein hartes Format-Problem: sie würden CHF
  // doppelt zählen UND die Tagesabdeckung künstlich über die Schwelle heben
  // → Import ablehnen statt still verfälschen.
  const spalteTag = new Map<number, string>(); // colIndex → 'TT.MM.'
  const gesehen = new Set<string>();
  const doppelt = new Set<string>();
  for (let c = 2; c < hdr.length; c++) {
    const m = String(hdr[c] ?? '').match(/^(\d{2})\.(\d{2})\.$/);
    if (!m) continue;
    const tag = m[0];
    const mm = Number(m[2]), dd = Number(m[1]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue; // kein gültiges Datum
    if (gesehen.has(tag)) doppelt.add(tag); else gesehen.add(tag);
    spalteTag.set(c, tag);
  }
  if (spalteTag.size === 0) throw new Error(`${dateiName}: keine Tagesspalten «TT.MM.» erkannt.`);
  if (doppelt.size > 0) {
    throw new Error(
      `${dateiName}: doppelte Tagesspalten (${Array.from(doppelt).slice(0, 5).join(', ')}`
      + `${doppelt.size > 5 ? ', …' : ''}) — Import abgelehnt, Datei prüfen.`);
  }

  // %-Datei erkennen: den DATENBEREICH scannen (nicht nur eine Zelle) — jede
  // nicht-leere Zelle, die auf «%» endet, zählt. Gemischte Einheiten (CHF und
  // %) sind mehrdeutig → fail closed. So wird die Brutto-Kassenquote nie
  // versehentlich als CHF-Budget übernommen.
  let pctZellen = 0, chfZellen = 0;
  for (const r of rows.slice(1)) {
    for (let c = 1; c < (r?.length ?? 0); c++) {
      const t = String(r[c] ?? '').trim();
      if (t === '') continue;
      if (t.endsWith('%')) pctZellen++;
      else if (typeof r[c] === 'number' || /\d/.test(t)) chfZellen++;
    }
  }
  if (pctZellen > 0 && chfZellen > 0) {
    throw new Error(
      `${dateiName}: gemischte Einheiten erkannt (${pctZellen} %-Zellen, ${chfZellen} Zahl-Zellen) `
      + `— Einheit mehrdeutig, Import abgelehnt.`);
  }
  if (pctZellen > 0) {
    return {
      typ: 'pct', chfMonate: Array(12).fill(null), tageMonate: Array(12).fill(0),
      debug: `${dateiName}: %-Datei (Brutto-WEQ der Kasse) erkannt — übersprungen; massgebliche WEQ wird gegen Netto gerechnet.`,
    };
  }
  const gesamt = rows.find(r => String(r?.[0] ?? '').startsWith('Gesamt'));
  if (!gesamt) {
    throw new Error(
      `${dateiName}: Zeile «Gesamt» fehlt. Vorhandene Zeilen: `
      + rows.slice(1, 5).map(r => String(r?.[0] ?? '?')).join(', '));
  }
  const sums = Array(12).fill(0) as number[];
  const cnt = Array(12).fill(0) as number[];
  for (const [c, tag] of spalteTag) {
    const monat = Number(tag.slice(3, 5)) - 1;
    const roh = gesamt[c];
    if (roh === null || roh === undefined || roh === '') continue;
    const n = typeof roh === 'number'
      ? roh
      : parseFloat(String(roh).replace(/[^0-9,.\-]/g, '').replace(',', '.'));
    if (!isFinite(n)) continue;
    sums[monat] += n; cnt[monat]++;
  }
  const chfMonate = sums.map((s, i) => (cnt[i] >= WEQ_MIN_TAGE ? r2(s) : null));
  const teil = cnt
    .map((c, i) => (c > 0 && c < WEQ_MIN_TAGE ? `M${i + 1} (${c} Tage)` : null))
    .filter(Boolean);
  return {
    typ: 'chf', chfMonate, tageMonate: cnt,
    debug: `${dateiName}: ${chfMonate.filter(v => v !== null).length} vollständige Monate übernommen`
      + (teil.length ? ` · unvollständig ignoriert: ${teil.join(', ')}` : '') + '.',
  };
}
