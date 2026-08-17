/**
 * umsatz-kategorien.ts — «Umsatzanalyse Kategorien» (Produkteanalyse + Cockpit-PDF)
 * =================================================================================
 * Neuer, eigenständiger Import-Kanal: Excel im BREITEN Format
 *   Spalte A = "Bezeichnung", Spalte B = Zeitraum-Total (IGNORIERT, wird neu
 *   berechnet), danach Tagesspalten mit Datum (TT.MM.JJJJ oder Excel-Serial).
 *
 * Zeilen-Typen:
 *   • Gruppen-Kopf: "Food (Speisen)" / "Beverage (Getränke)" (ohne "> ")
 *   • Unterkategorie: beginnt mit "> " → gehört zur zuletzt gelesenen Gruppe
 *   • Sonderzeilen (Rabatte, Aufladung Kundenkarten, Rundungsdifferenzen,
 *     Non-Foods, Trinkgeld, Gesamt …) → NICHT ins Ranking (ignoriert)
 *
 * Persistenz: EIN tenant-scoped KV-Blob `umsatz_kategorien_v1`
 *   (Oliv unpräfixiert, Beaulieu `beaulieu:` — via tenantKey).
 *   werte: Record<"YYYY-MM-DD|gruppe|kategorie", number>
 *   DUBLETTENSICHER: Ersetzen statt Addieren — ein erneuter Upload überschreibt
 *   die Schlüssel der enthaltenen Tage/Kategorien (kein Aufsummieren).
 *
 * Undo: EIN Slot je Mandant (`umsatz_kategorien_undo_v1`) mit Vorher/Nachher-
 * Snapshot; Undo verweigert bei zwischenzeitlicher Abweichung (kein CAS im KV).
 *
 * WICHTIG: XLSX.read IMMER mit cellDates:false (1904-Datumssystem-Bug).
 */

import * as XLSX from 'xlsx';
import type { TenantId } from '@/contexts/TenantContext';
import { kvGetStrict, kvSetStrict } from './supabase-kv';
import { tenantKey } from './tenant-utils';

export const UMSATZ_KATEGORIEN_KEY = 'umsatz_kategorien_v1';
export const UMSATZ_KATEGORIEN_UNDO_KEY = 'umsatz_kategorien_undo_v1';
/** Offene Ansichten ziehen nach erfolgreichem Import/Undo nach. */
export const UMSATZ_KATEGORIEN_UPDATED_EVENT = 'umsatzKategorienUpdated';

export type KatGruppe = 'food' | 'beverage';

export interface UmsatzKategorienBlob {
  /** Schlüssel "YYYY-MM-DD|food|Pasta" → Tagesumsatz (CHF, brutto wie geliefert). */
  werte: Record<string, number>;
  updatedAt?: string;
}

export interface KatEintrag {
  datum: string;      // YYYY-MM-DD
  gruppe: KatGruppe;
  kategorie: string;  // ohne "> "-Präfix, getrimmt
  umsatz: number;
}

export interface KatParseErgebnis {
  eintraege: KatEintrag[];
  /** Diagnose: was wurde erkannt (immer gefüllt, auch bei Fehler). */
  debug: {
    zeilenGesamt: number;
    tagesSpalten: number;
    gruppenGefunden: string[];
    kategorienGefunden: number;
    sonderzeilenIgnoriert: string[];
    kopfBeispiele: string[];
  };
  failureReason: string | null;
}

// ─── Parsen ───────────────────────────────────────────────────────────────────

const SONDERZEILEN_RE =
  /^(rabatt|aufladung|rundungsdifferenz|non[- ]?foods?|trinkgeld|gesamt|total)\b/i;

function gruppeAusKopf(text: string): KatGruppe | null {
  const t = text.toLowerCase();
  if (/^food\b|speisen/.test(t)) return 'food';
  if (/^beverage\b|getränke|getraenke/.test(t)) return 'beverage';
  return null;
}

/**
 * Header-Zelle → ISO-Datum (TT.MM.JJJJ, TT.MM.JJ oder Excel-Serial), sonst null.
 * `date1904`: Workbook-Flag — 1904-System-Serials sind um 1462 Tage versetzt
 * (cellDates:false liefert rohe Zahlen; der Versatz muss manuell rein).
 */
export function parseTagKopf(raw: unknown, date1904 = false): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const serial = date1904 ? raw + 1462 : raw;
    if (serial <= 20000 || serial >= 80000) return null;
    const d = XLSX.SSF.parse_date_code(serial);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (m) {
    const tag = parseInt(m[1], 10), mon = parseInt(m[2], 10);
    let jahr = parseInt(m[3], 10);
    if (jahr < 100) jahr += 2000;
    if (tag < 1 || tag > 31 || mon < 1 || mon > 12) return null;
    return `${jahr}-${String(mon).padStart(2, '0')}-${String(tag).padStart(2, '0')}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

function zahl(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (raw == null || raw === '') return null;
  // «CHF 5'027.50» (auch mit NBSP) → 5027.50: Währungspräfix + Trennzeichen weg.
  const s = String(raw)
    .replace(/CHF/giu, '')
    .replace(/['\u2019\u00A0\s]/g, '')
    .replace(',', '.');
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Parst die Excel-Datei (ArrayBuffer) ins Eintrags-Format. */
export function parseUmsatzKategorienExcel(buffer: ArrayBuffer): KatParseErgebnis {
  const debug: KatParseErgebnis['debug'] = {
    zeilenGesamt: 0, tagesSpalten: 0, gruppenGefunden: [],
    kategorienGefunden: 0, sonderzeilenIgnoriert: [], kopfBeispiele: [],
  };
  let rows: unknown[][];
  let date1904 = false;
  try {
    // NIE cellDates:true (1904-Flag verschiebt Daten um +4 Jahre).
    const wb = XLSX.read(buffer, { type: 'array', cellDates: false });
    date1904 = Boolean(wb.Workbook?.WBProps?.date1904);
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: true });
  } catch (e) {
    return { eintraege: [], debug, failureReason: `Excel nicht lesbar: ${e instanceof Error ? e.message : String(e)}` };
  }
  debug.zeilenGesamt = rows.length;

  // Kopfzeile finden: Zeile mit ≥ 2 Tages-Spalten ab Spalte C (Index 2).
  let kopfIdx = -1;
  let tagSpalten: { col: number; datum: string }[] = [];
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i] ?? [];
    const gefunden: { col: number; datum: string }[] = [];
    for (let c = 2; c < row.length; c++) {
      const d = parseTagKopf(row[c], date1904);
      if (d) gefunden.push({ col: c, datum: d });
    }
    if (gefunden.length >= 2) { kopfIdx = i; tagSpalten = gefunden; break; }
  }
  debug.kopfBeispiele = (rows[Math.max(kopfIdx, 0)] ?? []).slice(0, 6).map(v => String(v));
  if (kopfIdx < 0) {
    return { eintraege: [], debug, failureReason: 'Keine Kopfzeile mit Tages-Datumsspalten (TT.MM.JJJJ) ab Spalte C gefunden.' };
  }
  debug.tagesSpalten = tagSpalten.length;

  const eintraege: KatEintrag[] = [];
  const summen = new Map<string, number>(); // gleiche Kategorie mehrfach → summieren (Duplikat-Zeilen)
  let aktGruppe: KatGruppe | null = null;
  const kategorien = new Set<string>();

  for (let i = kopfIdx + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const bez = String(row[0] ?? '').trim();
    if (!bez) continue;
    if (bez.startsWith('> ') || bez.startsWith('>')) {
      const kategorie = bez.replace(/^>\s*/, '').trim();
      if (!kategorie || !aktGruppe) continue;
      if (SONDERZEILEN_RE.test(kategorie)) { debug.sonderzeilenIgnoriert.push(kategorie); continue; }
      kategorien.add(`${aktGruppe}|${kategorie}`);
      for (const t of tagSpalten) {
        const n = zahl(row[t.col]);
        // Explizite 0 ist ein Tageswert (ersetzt beim Re-Upload einen alten
        // Wert!) — nur leere/unlesbare Zellen überspringen.
        if (n == null) continue;
        const key = `${t.datum}|${aktGruppe}|${kategorie}`;
        summen.set(key, (summen.get(key) ?? 0) + n);
      }
    } else {
      // Zeile ohne "> ": Gruppen-Kopf oder Sonderzeile
      const g = gruppeAusKopf(bez);
      if (g) {
        aktGruppe = g;
        if (!debug.gruppenGefunden.includes(bez)) debug.gruppenGefunden.push(bez);
      } else {
        aktGruppe = null; // Sonderblock (Rabatte, Trinkgeld, Gesamt …) — Folgezeilen ignorieren
        debug.sonderzeilenIgnoriert.push(bez);
      }
    }
  }
  debug.kategorienGefunden = kategorien.size;

  for (const [key, umsatz] of summen) {
    const [datum, gruppe, ...rest] = key.split('|');
    eintraege.push({
      datum, gruppe: gruppe as KatGruppe, kategorie: rest.join('|'),
      umsatz: Math.round(umsatz * 100) / 100,
    });
  }
  if (eintraege.length === 0) {
    return {
      eintraege, debug,
      failureReason: debug.gruppenGefunden.length === 0
        ? 'Keine Gruppen-Köpfe «Food (Speisen)» / «Beverage (Getränke)» gefunden.'
        : 'Keine Unterkategorie-Zeilen («> …») mit Tageswerten gefunden.',
    };
  }
  return { eintraege, debug, failureReason: null };
}

// ─── Persistenz (KV, strict) ─────────────────────────────────────────────────

function normalizeBlob(raw: unknown): UmsatzKategorienBlob {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const werte: Record<string, number> = {};
    if (obj.werte && typeof obj.werte === 'object' && !Array.isArray(obj.werte)) {
      for (const [k, v] of Object.entries(obj.werte as Record<string, unknown>)) {
        const n = typeof v === 'number' ? v : NaN;
        if (Number.isFinite(n)) werte[k] = n;
      }
    }
    return { werte, updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : undefined };
  }
  return { werte: {} };
}

/** Lädt den Blob STRICT (Lesefehler ≠ leer — wirft bei KV-Problemen). */
export async function loadUmsatzKategorien(tenantId: TenantId): Promise<UmsatzKategorienBlob> {
  const raw = await kvGetStrict(tenantKey(tenantId, UMSATZ_KATEGORIEN_KEY));
  return normalizeBlob(raw);
}

export interface KatImportErgebnis {
  neu: number;        // Schlüssel, die es vorher nicht gab
  ersetzt: number;    // vorhandene Schlüssel überschrieben
  tage: number;
  blob: UmsatzKategorienBlob;
}

/** Wendet einen Import an: Ersetzen statt Addieren; Undo-Snapshot davor. */
export async function applyUmsatzKategorienImport(
  tenantId: TenantId, eintraege: KatEintrag[], fileName: string,
): Promise<KatImportErgebnis> {
  const vorher = await loadUmsatzKategorien(tenantId); // strict: Lesefehler bricht ab
  const werte = { ...vorher.werte };
  let neu = 0, ersetzt = 0;
  const tage = new Set<string>();
  for (const e of eintraege) {
    const key = `${e.datum}|${e.gruppe}|${e.kategorie}`;
    if (key in werte) ersetzt++; else neu++;
    werte[key] = e.umsatz;
    tage.add(e.datum);
  }
  const blob: UmsatzKategorienBlob = { werte, updatedAt: new Date().toISOString() };
  // Undo-Snapshot VOR dem Schreiben sichern (Vorher/Nachher).
  await kvSetStrict(tenantKey(tenantId, UMSATZ_KATEGORIEN_UNDO_KEY), {
    fileName, at: blob.updatedAt, vorher, nachher: blob,
  });
  await kvSetStrict(tenantKey(tenantId, UMSATZ_KATEGORIEN_KEY), blob);
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(UMSATZ_KATEGORIEN_UPDATED_EVENT));
  } catch { /* Event darf Save nie brechen */ }
  return { neu, ersetzt, tage: tage.size, blob };
}

export interface KatUndoInfo { fileName: string; at: string }

/** Liest den Undo-Slot (nur Info, ohne Blobs). */
export async function loadUmsatzKategorienUndoInfo(tenantId: TenantId): Promise<KatUndoInfo | null> {
  const raw = await kvGetStrict(tenantKey(tenantId, UMSATZ_KATEGORIEN_UNDO_KEY));
  if (raw && typeof raw === 'object' && 'vorher' in (raw as object)) {
    const o = raw as { fileName?: unknown; at?: unknown };
    return { fileName: typeof o.fileName === 'string' ? o.fileName : '?', at: typeof o.at === 'string' ? o.at : '' };
  }
  return null;
}

/**
 * Macht den letzten Import rückgängig. Verweigert (Fehler), wenn der aktuelle
 * Stand nicht mehr dem Nachher-Snapshot entspricht (kein CAS im KV).
 */
export async function undoUmsatzKategorienImport(tenantId: TenantId): Promise<void> {
  const raw = await kvGetStrict(tenantKey(tenantId, UMSATZ_KATEGORIEN_UNDO_KEY));
  if (!raw || typeof raw !== 'object' || !('vorher' in (raw as object)) || !('nachher' in (raw as object))) {
    throw new Error('Kein rückgängig machbarer Import vorhanden.');
  }
  const slot = raw as { vorher: unknown; nachher: unknown };
  const aktuell = await loadUmsatzKategorien(tenantId);
  const nachher = normalizeBlob(slot.nachher);
  if (JSON.stringify(aktuell.werte) !== JSON.stringify(nachher.werte)) {
    throw new Error('Daten wurden seit dem Import verändert — Undo abgebrochen (nichts überschrieben).');
  }
  await kvSetStrict(tenantKey(tenantId, UMSATZ_KATEGORIEN_KEY), normalizeBlob(slot.vorher));
  await kvSetStrict(tenantKey(tenantId, UMSATZ_KATEGORIEN_UNDO_KEY), null);
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(UMSATZ_KATEGORIEN_UPDATED_EVENT));
  } catch { /* noop */ }
}

// ─── Auswertung ───────────────────────────────────────────────────────────────

export interface KatZeile { kategorie: string; umsatz: number; anteilPct: number | null }
export interface KatGruppenAuswertung { total: number | null; zeilen: KatZeile[] }
export interface KatAuswertung {
  /** min–max der vorhandenen Tage im Jahr (ISO), null wenn keine Daten. */
  zeitraum: { von: string; bis: string } | null;
  jahr: number;
  food: KatGruppenAuswertung;
  beverage: KatGruppenAuswertung;
}

/** Summiert je Gruppe/Kategorie über alle Tage des Jahres. Leer statt 0. */
export function berechneKatAuswertung(blob: UmsatzKategorienBlob, jahr: number): KatAuswertung {
  const proGruppe: Record<KatGruppe, Map<string, number>> = { food: new Map(), beverage: new Map() };
  let von: string | null = null, bis: string | null = null;
  for (const [key, umsatz] of Object.entries(blob.werte)) {
    const [datum, gruppe, ...rest] = key.split('|');
    if (!datum.startsWith(`${jahr}-`)) continue;
    if (gruppe !== 'food' && gruppe !== 'beverage') continue;
    const kategorie = rest.join('|');
    if (!kategorie) continue;
    const map = proGruppe[gruppe as KatGruppe];
    map.set(kategorie, (map.get(kategorie) ?? 0) + umsatz);
    if (von === null || datum < von) von = datum;
    if (bis === null || datum > bis) bis = datum;
  }
  const auswerten = (map: Map<string, number>): KatGruppenAuswertung => {
    const zeilen = Array.from(map.entries())
      .map(([kategorie, umsatz]) => ({ kategorie, umsatz: Math.round(umsatz * 100) / 100 }))
      .sort((a, b) => b.umsatz - a.umsatz);
    if (zeilen.length === 0) return { total: null, zeilen: [] };
    const total = Math.round(zeilen.reduce((s, z) => s + z.umsatz, 0) * 100) / 100;
    return {
      total,
      // nie durch 0 teilen — Anteil nur bei Total > 0
      zeilen: zeilen.map(z => ({ ...z, anteilPct: total > 0 ? Math.round((z.umsatz / total) * 1000) / 10 : null })),
    };
  };
  return {
    zeitraum: von && bis ? { von, bis } : null,
    jahr,
    food: auswerten(proGruppe.food),
    beverage: auswerten(proGruppe.beverage),
  };
}
