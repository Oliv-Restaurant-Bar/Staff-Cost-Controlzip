/**
 * feldschloesschen.ts — Feldschlösschen (Getränkelieferant) PDF-Import (REINE Logik)
 * ===================================================================================
 * Arbeitet auf rekonstruierten PDF-Zeilen (Zellen), wie sie `reconstructGnPdfLines`
 * aus pdfjs-Text-Items liefert. Kein DOM, kein pdfjs, kein Supabase — vollständig
 * mit Fixtures testbar.
 *
 * Dokumenttypen (inhaltsbasiert, nie über den Dateinamen):
 *  - LIEFERSCHEIN (Einzelrechnung): Kopf «Lieferschein», «Lieferung: <Nr>»,
 *    Positionsliste mit MWST-Codes 3C (8.1%), 4C (2.6%), C0 (0% Pfand/Leergut),
 *    «Zwischentotal Warenwert», «Zwischentotal Leergut», «Total Lieferung».
 *  - SAMMELRECHNUNG (Monatsrechnung): «Sammelrechnung: <Nr>», Faktura-Liste,
 *    «Zusammenfassung MwSt.» (Kategorien Bier/Spirituosen/…), im Anhang die
 *    einzelnen Rechnungen inkl. Lieferschein-Positionslisten.
 *
 * Kontierung: Position → FS-Kategorie (Getränkeart, keyword-basiert; MWST-Satz
 * als hartes Signal: 2.6% = alkoholfrei) → Konto über die konfigurierbare
 * Warengruppen-Tabelle (gleiche Tabelle wie der Transgourmet-CSV-Import).
 * Unbekannte Position = «Konto offen» — es wird NIE geraten.
 */

import type { GnPdfLine } from './gn-pdf-lines';
import type {
  WarenPosition, ParsedCsvRechnung, WarengruppenMapping,
} from './waren-positionen';
import { KONTO_LABEL_PFAND, KONTO_GEBUEHR, KONTO_REINIGUNG, istGebuehrenText, istZwingendGebuehr, istZwingendReinigung } from './waren-positionen';

// ── Zahlen/Datum ──────────────────────────────────────────────────────────────

/** «4'258.00» / «-217.00» / «CHF 9'723.00» → Zahl (null wenn nicht numerisch). */
export function parseChf(raw: string): number | null {
  const s = raw.replace(/CHF/gi, '').replace(/['\u2019\u00A0\s]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** «17.07.2026» → «2026-07-17» (null wenn kein CH-Datum). */
export function parseDatumCH(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// ── Zeilen-Hilfen ─────────────────────────────────────────────────────────────

/** Zeilentext für Label-Erkennung: Zellen zusammenfügen; Ligatur-Splits («Di|ff|erenz») tolerieren. */
function zText(cells: Array<{ text: string }>): string {
  return cells.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim();
}
function zKompakt(cells: Array<{ text: string }>): string {
  return cells.map(c => c.text).join('').replace(/\s+/g, '').toLowerCase();
}

export interface FsZeile { page: number; cells: string[]; text: string; kompakt: string }

export function toFsZeilen(lines: GnPdfLine[]): FsZeile[] {
  return lines.map(l => ({
    page: l.pageNumber,
    cells: l.cells.map(c => c.text.trim()).filter(t => t !== ''),
    text: zText(l.cells),
    kompakt: zKompakt(l.cells),
  }));
}

// ── Dokumenttyp ───────────────────────────────────────────────────────────────

export type FsPdfTyp = 'lieferschein' | 'sammelrechnung' | 'faktura';

export function detectFsPdfTyp(zeilen: FsZeile[]): FsPdfTyp | null {
  const kopf = zeilen.slice(0, 40);
  if (kopf.some(z => z.kompakt.includes('sammelrechnung:'))) return 'sammelrechnung';
  if (kopf.some(z => z.kompakt === 'lieferschein') && zeilen.some(z => z.kompakt.startsWith('lieferung:'))) {
    return 'lieferschein';
  }
  // Einzelne FS-Faktura: «Rechnung: <Nr>» im Kopf + eigene «Zusammenfassung MwSt.»
  if (kopf.some(z => z.kompakt.includes('rechnung:'))
      && zeilen.some(z => z.kompakt.startsWith('zusammenfassungmwst'))) {
    return 'faktura';
  }
  return null;
}

/** Feldschlösschen-Dokument? (Absender im Kopf) */
export function istFeldschloesschenPdf(zeilen: FsZeile[]): boolean {
  return zeilen.slice(0, 60).some(z => z.kompakt.includes('feldschlösschen') || z.kompakt.includes('feldschloesschen'));
}

// ── FS-Kategorien & Konto-Zuordnung ──────────────────────────────────────────

/** Kategorien wie auf der Monatsrechnung («Zusammenfassung MwSt.»). */
export const FS_KATEGORIEN = [
  'Bier', 'Alkoholfreies Bier', 'Mineralwasser', 'Andere alk. freie Getränke',
  'Spirituosen', 'Wein', 'Andere Güter', 'Zu-/Abschläge',
] as const;
export type FsKategorie = typeof FS_KATEGORIEN[number];

/**
 * Standard-Kontierung der FS-Kategorien (in der Einstellungen-Tabelle
 * «Warengruppen → Konto» editierbar; gespeicherte Einträge gewinnen):
 * Bier→4030, Spirituosen→4040, Wein→4020, alle alkoholfreien→4050 (Warenkosten);
 * Andere Güter / Zu-/Abschläge→4701 (Betriebskosten, NICHT WKQ).
 * Leergut/Pfand läuft über MwSt-Code 0 → neutral (Depot), braucht keinen Eintrag.
 */
export const DEFAULT_FS_KATEGORIEN_MAPPING: WarengruppenMapping = [
  { gruppe: 'Bier', konto: '4030' },
  { gruppe: 'Alkoholfreies Bier', konto: '4050' },
  { gruppe: 'Mineralwasser', konto: '4050' },
  { gruppe: 'Andere alk. freie Getränke', konto: '4050' },
  { gruppe: 'Spirituosen', konto: '4040' },
  { gruppe: 'Wein', konto: '4020' },
  { gruppe: 'Andere Güter', konto: '4701' },
  { gruppe: 'Zu-/Abschläge', konto: '4701' },
  // Weitere Kategorien der «Zusammenfassung MwSt.» — NICHT Wareneinsatz:
  { gruppe: 'Mietmaterial', konto: '4701' },
  { gruppe: 'Recyclinggebühren', konto: '4701' },
  { gruppe: 'POS-Promo Material', konto: '4701' },
];

/** Effektives Mapping: gespeicherte Tabelle ∪ FS-Standards (gespeicherte Gruppen gewinnen). */
export function mitFsDefaults(mapping: WarengruppenMapping): WarengruppenMapping {
  const vorhanden = new Set(mapping.map(r => r.gruppe.trim().toLowerCase()));
  return [...mapping, ...DEFAULT_FS_KATEGORIEN_MAPPING.filter(r => !vorhanden.has(r.gruppe.toLowerCase()))];
}

/**
 * Konto-VORSCHLAG für eine unbekannte ZSF-Kategorie (nur Vorbelegung des
 * Dropdowns in der Vorschau — wird NIE automatisch gebucht, der Nutzer
 * bestätigt/ändert vor dem Buchen): Material-Kategorien («Event Material»,
 * «Mietmaterial» …) → 4701 Betriebsmaterial. Sonst kein Vorschlag (null).
 */
export function fsKontoVorschlag(kategorie: string): string | null {
  return /material/i.test(kategorie) ? '4701' : null;
}

const SPIRITUOSEN_RX = /grappa|vodka|wodka|\bgin\b|whisk|\brum\b|likör|liqueur|aperitif|bitter|campari|aperol|tequila|amaretto|cognac|armagnac|calvados|ouzo|sambuca|limoncello|vermouth|vermut|kirsch\b|träsch|williamine|absinth|baileys|jägermeister|ramazzotti|averna|fernet|cynar|martini|spirituose|brand\b|obstbrand|zwetschgen|aprikosen|vieille prune/i;
const WEIN_RX = /\bwein\b|prosecco|champagn|spumante|cava\b|riesling|merlot|pinot|chardonnay(?!.*grappa)|sauvignon|chasselas|dôle|federweiss|rosé\b|rioja|barolo|chianti|primitivo|amarone/i;
// Moscht/Cider gehört laut FGG-Monatsrechnung («Zusammenfassung MwSt.») zu
// «Andere alk. freie Getränke» (auch die 8.1%-Variante), NICHT zu Bier.
const CIDER_RX = /moscht|apfelwein|cidre|cider/i;
const BIER_RX = /bier|lager\b|weisse|weizen|\bipa\b|stout|zwickel|amber\b|panach|spez\b|bulk|tanksystem|feldschlösschen|valaisanne|gurten\b|cardinal|carlsberg|1664|grimbergen|hürlimann|eichhof|schneider\b/i;
/** Alkohol-Volumenprozent ≥15 in der Bezeichnung («40% 1X0,70») ⇒ Spirituose. */
function hatSpirituosenProzent(b: string): boolean {
  const m = b.match(/\b(\d{1,2}(?:\.\d)?)\s?%/);
  return m !== null && Number(m[1]) >= 15;
}
const MINERAL_RX = /arkina|rhäzünser(?!.*(citro|premix))|valser|henniez|aproz|eptinger|passugger|san pellegrino|acqua panna|evian|vittel|mineralwasser|\bmit co2\b|\bohne co2\b/i;

/**
 * FS-Kategorie einer Position: MWST-Satz ist das harte Signal
 * (2.6% ⇒ alkoholfrei, 0% ⇒ Leergut/Pfand), Getränkeart per Stichwort.
 * Unbekannt (8.1% ohne Treffer) ⇒ null — Aufrufer markiert «Konto offen».
 */
export function fsKategorie(bezeichnung: string, mwstSatz: number): FsKategorie | 'Leergut' | null {
  if (mwstSatz === 0) return 'Leergut';
  const b = bezeichnung;
  if (mwstSatz === 2.6) {
    if (SPIRITUOSEN_RX.test(b)) return 'Andere alk. freie Getränke'; // alkoholfreie Aperitifs etc.
    if (CIDER_RX.test(b)) return 'Andere alk. freie Getränke';       // Moscht/Cider (auch alk.frei) lt. FGG
    if (BIER_RX.test(b)) return 'Alkoholfreies Bier';
    if (MINERAL_RX.test(b)) return 'Mineralwasser';
    return 'Andere alk. freie Getränke';
  }
  // 8.1% — alkoholisch oder Nicht-Getränk:
  if (SPIRITUOSEN_RX.test(b)) return 'Spirituosen';
  if (WEIN_RX.test(b)) return 'Wein';
  if (CIDER_RX.test(b)) return 'Andere alk. freie Getränke'; // SuureMoscht 8.1% lt. FGG NICHT Bier
  if (BIER_RX.test(b)) return 'Bier';
  if (hatSpirituosenProzent(b)) return 'Spirituosen'; // Obstbrände etc. («40% 1X0,70»)
  if (/logistikpauschale|\bpauschale\b/i.test(b)) return 'Zu-/Abschläge';
  if (/gas\b|protadur|innenhüllen|co2.*flasche|kohlensäure|zapf|reinig|schlauch|becher|glas\b|gläser|karton|pos-|promo/i.test(b)) {
    return 'Andere Güter';
  }
  return null; // Konto offen — nie raten
}

// ── Lieferschein (Einzelrechnung) ────────────────────────────────────────────

export interface FsLieferschein {
  lieferungNr: string;
  lieferdatum: string;           // YYYY-MM-DD
  auftrag: string;
  positionen: WarenPosition[];   // Getränkepositionen + Zu-/Abschläge + Leergut (mwstCode 0)
  zwischentotalWarenwert: number | null;
  leergutTotal: number | null;   // kann negativ sein (Rückgabe-Überhang)
  zuAbschlaegeTotal: number | null;
  totalNetto: number | null;     // «Total netto Lieferung» (inkl. Leergut, inkl. Zu-/Abschläge)
  totalMwst: number | null;
  totalLieferung: number | null; // Brutto-Endbetrag
  failureReason?: string;
  debug: { positionszeilen: number; seiten: number };
}

const MWST_CODE_MAP: Record<string, { code: number; satz: number }> = {
  '3C': { code: 1, satz: 8.1 },
  '4C': { code: 2, satz: 2.6 },
  'C0': { code: 0, satz: 0 },
};

/** Aus Bezeichnung + MWST-Satz die Warengruppe (FS-Kategorie) bestimmen; unbekannt ⇒ ''. */
function fsWarengruppe(bezeichnung: string, satz: number): string {
  const kat = fsKategorie(bezeichnung, satz);
  return kat === 'Leergut' ? 'Leergut' : (kat ?? '');
}

/**
 * VEG-Einweg-Glasgebühren UND Recycling-Gebühren (Recycl.-Geb. PET,
 * Recycling-Geb., …) zählt FGG in der «Zusammenfassung MwSt.» zur
 * WARENkategorie (nicht zu Zu-/Abschlägen): 2.6% ⇒ alkoholfreie Getränke,
 * 8.1% ⇒ Spirituosen/Wein-EW-Flaschen (heuristisch Spirituosen).
 * Nur mit dieser Warengruppe rechnet kontoSplitsAusFsKategorien die Gebühr
 * aus dem richtigen Satz-Bucket heraus (→ 4701) — sonst bleibt sie im
 * Warenkonto stecken (Vorfall Beleg 87791818: 4.96 im 4050-Bucket).
 * Logistikpauschalen etc. bleiben «Zu-/Abschläge».
 */
function gebuehrWarengruppe(bezeichnung: string, satz: number): string {
  const b = bezeichnung.trim();
  if (/^veg\b/i.test(b) || /recycl/i.test(b)) {
    return satz === 2.6 ? 'Andere alk. freie Getränke' : 'Spirituosen';
  }
  return 'Zu-/Abschläge';
}

/**
 * Nachklassifizierung pro Artikel-Nr: Zeilen mit abgeschnittener Bezeichnung
 * («24X0,33 (AKTION)») übernehmen die Warengruppe der aussagekräftigsten
 * (längsten) Bezeichnung derselben Artikel-Nr im selben Dokument.
 */
function nachklassifiziereProArtikel(positionen: WarenPosition[]): void {
  const best = new Map<string, { len: number; wg: string }>();
  for (const p of positionen) {
    if (!p.artNr || p.mwstCode === 0 || !p.warengruppe || p.warengruppe === 'Leergut') continue;
    const cur = best.get(p.artNr);
    if (!cur || p.bezeichnung.length > cur.len) best.set(p.artNr, { len: p.bezeichnung.length, wg: p.warengruppe });
  }
  for (const p of positionen) {
    if (!p.artNr || p.mwstCode === 0 || p.warengruppe === 'Leergut') continue;
    const b = best.get(p.artNr);
    if (b && b.wg && p.bezeichnung.length < b.len) p.warengruppe = b.wg;
  }
}

export function parseFsLieferschein(zeilen: FsZeile[]): FsLieferschein {
  const out: FsLieferschein = {
    lieferungNr: '', lieferdatum: '', auftrag: '', positionen: [],
    zwischentotalWarenwert: null, leergutTotal: null, zuAbschlaegeTotal: null,
    totalNetto: null, totalMwst: null, totalLieferung: null,
    debug: { positionszeilen: 0, seiten: Math.max(0, ...zeilen.map(z => z.page)) },
  };

  let sektion: 'kopf' | 'positionen' | 'leergut' | 'ladung' | 'konditionen' | 'ende' = 'kopf';
  let pendingBez = '';
  for (let i = 0; i < zeilen.length; i++) {
    const z = zeilen[i];
    const k = z.kompakt;

    // Kopffelder
    if (k.startsWith('lieferung:')) { out.lieferungNr = z.cells[z.cells.length - 1] ?? ''; sektion = 'positionen'; continue; }
    if (k.startsWith('lieferdatum:')) { out.lieferdatum = parseDatumCH(z.cells[z.cells.length - 1] ?? '') ?? ''; continue; }
    if (k.startsWith('auftrag:')) { out.auftrag = z.cells[z.cells.length - 1] ?? ''; continue; }

    // Sektionswechsel
    if (k.startsWith('zwischentotalwarenwert')) {
      out.zwischentotalWarenwert = parseChf(z.cells[z.cells.length - 1] ?? '');
      sektion = 'kopf'; continue;
    }
    if (k === 'leergut') { sektion = 'leergut'; continue; }
    if (k === 'ladungsträger') { sektion = 'ladung'; continue; }
    if (k.startsWith('zwischentotalleergut')) { out.leergutTotal = parseChf(z.cells[z.cells.length - 1] ?? ''); sektion = 'kopf'; continue; }
    if (k.startsWith('zwischentotalladungsträger')) { sektion = 'kopf'; continue; }
    if (k === 'konditionen' || k.startsWith('konditionen|') || k.startsWith('konditionenpreis')) { sektion = 'konditionen'; continue; }
    if (k.startsWith('zu/abschläge') || k.startsWith('zu-/abschläge')) {
      out.zuAbschlaegeTotal = parseChf(z.cells[z.cells.length - 1] ?? '');
      sektion = 'kopf'; continue;
    }
    if (k.startsWith('mwstübersicht')) { sektion = 'ende'; continue; }
    if (k.startsWith('totalnettolieferung')) { out.totalNetto = parseChf(z.cells[z.cells.length - 1] ?? ''); continue; }
    if (k.startsWith('totalmwst')) { out.totalMwst = parseChf(z.cells[z.cells.length - 1] ?? ''); continue; }
    if (k.startsWith('totallieferung')) { out.totalLieferung = parseChf(z.cells[z.cells.length - 1] ?? ''); continue; }

    // Positionszeilen
    if (sektion === 'positionen') {
      const code = z.cells[z.cells.length - 1];
      const mc = MWST_CODE_MAP[code ?? ''];
      const matIdx = z.cells.findIndex(c => /^\d{5,6}$/.test(c));
      if (mc && matIdx >= 0 && matIdx <= 1 && z.cells.length >= matIdx + 8) {
        // [KD?] material bez… einh inh stkPreis auftr lief preisChf code
        const preis = parseChf(z.cells[z.cells.length - 2] ?? '');
        const lief = parseChf(z.cells[z.cells.length - 3] ?? '');
        const stkPreis = parseChf(z.cells[z.cells.length - 5] ?? '');
        const inh = parseChf(z.cells[z.cells.length - 6] ?? '');
        const einh = z.cells[z.cells.length - 7] ?? '';
        const bez = [pendingBez, z.cells.slice(matIdx + 1, z.cells.length - 7).join(' ').trim()]
          .join(' ').replace(/\s+/g, ' ').trim();
        pendingBez = '';
        if (preis !== null) {
          const satz = mc.satz;
          out.positionen.push({
            artNr: z.cells[matIdx], bezeichnung: bez, warengruppe: fsWarengruppe(bez, satz),
            menge: lief ?? 0, einheit: einh, preis: stkPreis ?? 0,
            positionspreis: preis, mwstBetrag: Math.round(preis * satz) / 100,
            mwstCode: mc.code,
          });
          out.debug.positionszeilen++;
          void inh;
          continue;
        }
      }
      // Folgezeile (umgebrochene Bezeichnung): steht direkt DANACH eine
      // Materialzeile, ist dies deren Bezeichnungs-ANFANG → pendingBez;
      // sonst an die letzte Position anhängen.
      if (z.cells.length > 0 && !/^KD-|^Material/i.test(z.cells[0])) {
        const naechste = zeilen[i + 1];
        // Verpackungs-Suffixe («TAP7 Harass 20X0,50», «1X20,00») gehören zur
        // VORHERIGEN Position; reine Markentexte VOR einer Materialzeile sind
        // deren Bezeichnungs-ANFANG.
        const istVerpackungsSuffix = /\d+X\d/i.test(z.text) || /^\d/.test(z.text.trim());
        const naechsteIstMaterial = naechste !== undefined
          && MWST_CODE_MAP[naechste.cells[naechste.cells.length - 1] ?? ''] !== undefined
          && naechste.cells.findIndex(c => /^\d{5,6}$/.test(c)) >= 0
          && naechste.cells.findIndex(c => /^\d{5,6}$/.test(c)) <= 1;
        if (naechsteIstMaterial && !istVerpackungsSuffix) {
          pendingBez = `${pendingBez} ${z.text}`.replace(/\s+/g, ' ').trim();
        } else if (out.positionen.length > 0) {
          const p = out.positionen[out.positionen.length - 1];
          p.bezeichnung = `${p.bezeichnung} ${z.text}`.replace(/\s+/g, ' ').trim();
          p.warengruppe = fsWarengruppe(p.bezeichnung, MWST_CODE_MAP[p.mwstCode === 0 ? 'C0' : p.mwstCode === 2 ? '4C' : '3C'].satz);
        }
      }
      continue;
    }

    // Leergut-Zeilen → EINE neutrale Depot-Position pro Zeile (mwstCode 0)
    if ((sektion === 'leergut' || sektion === 'ladung') && /^\d{6}$/.test(z.cells[0] ?? '') && z.cells[z.cells.length - 1] === 'C0') {
      const preis = parseChf(z.cells[z.cells.length - 2] ?? '');
      if (preis !== null && preis !== 0) {
        const bez = z.cells.slice(1, z.cells.length - 6).join(' ').trim() || 'Leergut';
        out.positionen.push({
          artNr: z.cells[0], bezeichnung: bez, warengruppe: 'Leergut',
          menge: 1, einheit: 'ST', preis: 0,
          positionspreis: preis, mwstBetrag: 0, mwstCode: 0,
        });
      }
      continue;
    }

    // Konditionen (Logistikpauschale, VEG, …) → Zu-/Abschläge-Positionen
    if (sektion === 'konditionen') {
      const code = z.cells[z.cells.length - 1];
      const mc = MWST_CODE_MAP[code ?? ''];
      const preis = parseChf(z.cells[z.cells.length - 2] ?? '');
      if (mc && preis !== null && z.cells.length >= 3) {
        const bez = z.cells.slice(0, z.cells.length - 2).join(' ').trim();
        out.positionen.push({
          artNr: '', bezeichnung: bez, warengruppe: gebuehrWarengruppe(bez, mc.satz),
          menge: 1, einheit: '', preis: preis,
          positionspreis: preis, mwstBetrag: Math.round(preis * mc.satz) / 100, mwstCode: mc.code,
        });
      }
      continue;
    }
  }

  nachklassifiziereProArtikel(out.positionen);
  if (!out.lieferungNr) out.failureReason = 'Keine «Lieferung: <Nr>» gefunden — ist das ein Feldschlösschen-Lieferschein?';
  else if (!out.lieferdatum) out.failureReason = 'Kein Lieferdatum gefunden.';
  else if (out.debug.positionszeilen === 0) out.failureReason = 'Keine Positionszeilen erkannt (Layout unbekannt?).';
  return out;
}

/** Lieferschein → ParsedCsvRechnung-Form (für Preisüberwachung & Positionspipeline). */
export function fsLieferscheinAlsRechnung(ls: FsLieferschein): ParsedCsvRechnung {
  const netto = ls.positionen.reduce((a, p) => a + p.positionspreis, 0);
  const mwst = ls.positionen.reduce((a, p) => a + p.mwstBetrag, 0);
  return {
    docKey: `${ls.lieferungNr}|${ls.lieferdatum}`,
    rechnungsNr: ls.lieferungNr,
    datum: ls.lieferdatum,
    markt: 'Feldschlösschen',
    positionen: ls.positionen,
    nettoTotal: Math.round(netto * 100) / 100,
    mwstTotal: Math.round(mwst * 100) / 100,
    bruttoTotal: Math.round((netto + mwst) * 100) / 100,
  };
}

// ── Sammelrechnung (Monatsrechnung) ──────────────────────────────────────────

export interface FsFaktura {
  nr: string;
  datum: string;            // YYYY-MM-DD
  wert81: number; wert26: number; wert00: number;
  endbetrag: number;
}

export interface FsKategorieSumme {
  name: string;
  netto81: number; netto26: number; netto00: number;
  nettoTotal: number;
}

/** Eingebetteter Lieferschein aus dem Anhang der Sammelrechnung. */
export interface FsAnhangLieferschein {
  fakturaNr: string;
  lieferscheinNr: string;
  datum: string;            // Lieferschein-Datum (YYYY-MM-DD)
  positionen: WarenPosition[];
  warenwertNetto: number | null;  // «Zwischentotal Warenwert / Pfand» (Warenwert-Teil)
  pfandTotal: number | null;
  /** Offizieller «Endbetrag CHF» der zugehörigen Einzelrechnung (Faktura). */
  fakturaEndbetrag: number | null;
}

export interface FsSammelrechnung {
  nr: string;
  datum: string;            // YYYY-MM-DD
  endbetrag: number | null;
  fakturen: FsFaktura[];
  kategorien: FsKategorieSumme[];   // globale «Zusammenfassung MwSt.»
  /** «Zusammenfassung MwSt.» der EINZELNEN Fakturen im Anhang (Beleg-Nr → Kategorien). */
  fakturaKategorien: Record<string, FsKategorieSumme[]>;
  anhangLieferscheine: FsAnhangLieferschein[];
  failureReason?: string;
  debug: { seiten: number; fakturaZeilen: number; anhangSeiten: number };
}

export function parseFsSammelrechnung(zeilen: FsZeile[]): FsSammelrechnung {
  const out: FsSammelrechnung = {
    nr: '', datum: '', endbetrag: null, fakturen: [], kategorien: [],
    fakturaKategorien: {},
    anhangLieferscheine: [],
    debug: { seiten: Math.max(0, ...zeilen.map(z => z.page)), fakturaZeilen: 0, anhangSeiten: 0 },
  };

  let sektion: 'kopf' | 'fakturen' | 'kategorien' | 'anhang' = 'kopf';
  let inAnhang = false;
  let aktFaktura = '';
  let aktLs: FsAnhangLieferschein | null = null;
  let pendingText = '';
  let pfandGeliefert = 0;               // Σ Pfand-Spalte der Positionszeilen
  let anhangModus: 'positionen' | 'leergutrueckgabe' | 'zuabschlaege' = 'positionen';
  let zsfModus = false;                 // «Zusammenfassung MwSt.» der aktuellen Einzel-Faktura

  const pushLs = () => {
    if (aktLs) {
      if (Math.abs(pfandGeliefert) >= 0.005) {
        aktLs.positionen.push({
          artNr: '', bezeichnung: 'Pfand geliefert', warengruppe: 'Leergut',
          menge: 1, einheit: '', preis: 0,
          positionspreis: Math.round(pfandGeliefert * 100) / 100, mwstBetrag: 0, mwstCode: 0,
        });
      }
      if (aktLs.positionen.length > 0) out.anhangLieferscheine.push(aktLs);
    }
    aktLs = null;
    pfandGeliefert = 0;
    anhangModus = 'positionen';
  };

  for (let i = 0; i < zeilen.length; i++) {
    const z = zeilen[i];
    const k = z.kompakt;

    if (!inAnhang) {
      if (k.includes('sammelrechnung:') && !out.nr) { out.nr = z.cells[z.cells.length - 1] ?? ''; continue; }
      if (k.includes('datum:') && !out.datum) { out.datum = parseDatumCH(z.cells[z.cells.length - 1] ?? '') ?? ''; continue; }
      if (k.includes('endbetrag:') && out.endbetrag === null) { out.endbetrag = parseChf(z.cells[z.cells.length - 1] ?? ''); continue; }

      if (k.startsWith('faktura')) { sektion = 'fakturen'; continue; }
      if (sektion === 'fakturen') {
        if (/^\d{7,9}$/.test(z.cells[0] ?? '') && parseDatumCH(z.cells[1] ?? '')) {
          const nums = z.cells.slice(2).map(parseChf).filter((n): n is number => n !== null);
          // … | auftraggeber | [filiale] | w81 | w26 | w00 | endbetrag
          if (nums.length >= 5) {
            const [w81, w26, w00, endb] = nums.slice(nums.length - 4);
            out.fakturen.push({
              nr: z.cells[0], datum: parseDatumCH(z.cells[1]) ?? '',
              wert81: w81, wert26: w26, wert00: w00, endbetrag: endb,
            });
            out.debug.fakturaZeilen++;
          }
          continue;
        }
        if (k.startsWith('endbetrag')) { sektion = 'kopf'; continue; }
      }

      if (k.startsWith('zusammenfassungmwst')) { sektion = 'kategorien'; continue; }
      if (sektion === 'kategorien') {
        // «Bier | Nettowert | a | b | c | total» — MwSt/Total-Zeilen überspringen
        const idxNetto = z.cells.findIndex(c => /^Nettowert$/i.test(c));
        if (idxNetto > 0) {
          const name = z.cells.slice(0, idxNetto).join(' ').trim();
          const nums = z.cells.slice(idxNetto + 1).map(parseChf).filter((n): n is number => n !== null);
          if (nums.length >= 4 && name && !/^endbetrag$/i.test(name)) {
            out.kategorien.push({ name, netto81: nums[0], netto26: nums[1], netto00: nums[2], nettoTotal: nums[3] });
          }
          continue;
        }
        if (k.startsWith('totalbrutto')) { sektion = 'kopf'; continue; }
      }

      // Anhang beginnt mit der ersten Einzel-«Rechnung:»
      if (k.includes('rechnung:') && !k.includes('sammelrechnung:')) {
        inAnhang = true;
        out.debug.anhangSeiten++;
        aktFaktura = z.cells[z.cells.length - 1] ?? '';
        continue;
      }
      continue;
    }

    // ── Anhang: einzelne Rechnungen mit Lieferschein-Positionslisten ──
    if (k.includes('rechnung:') && !k.includes('sammelrechnung:')) {
      pushLs();
      zsfModus = false;
      aktFaktura = z.cells[z.cells.length - 1] ?? '';
      continue;
    }
    // «Zusammenfassung MwSt.» der Einzel-Faktura: Kategorien je Beleg-Nr sammeln
    // (massgeblich für die Kontierung — Werte wie auf der Rechnung ausgewiesen).
    if (k.startsWith('zusammenfassungmwst')) { zsfModus = true; continue; }
    if (zsfModus) {
      if (k.startsWith('totalbrutto')) { zsfModus = false; continue; }
      if (k.startsWith('endbetragchf')) {
        zsfModus = false; // echte «Endbetrag CHF»-Zeile den bestehenden Handlern überlassen
      } else {
        const idxNetto = z.cells.findIndex(c => /^Nettowert$/i.test(c));
        if (idxNetto > 0 && aktFaktura) {
          const name = z.cells.slice(0, idxNetto).join(' ').trim();
          const nums = z.cells.slice(idxNetto + 1).map(parseChf).filter((n): n is number => n !== null);
          if (nums.length >= 4 && name && !/^endbetrag$/i.test(name)) {
            (out.fakturaKategorien[aktFaktura] ??= []).push({
              name, netto81: nums[0], netto26: nums[1], netto00: nums[2], nettoTotal: nums[3],
            });
          }
        }
        continue; // MwSt-/Total-/Kopfzeilen der Zusammenfassung überspringen
      }
    }
    if (k.startsWith('lieferschein')) {
      pushLs();
      zsfModus = false;
      // «Lieferschein | 479114588 | vom | 02.06.2026»
      const nr = z.cells.find(c => /^\d{8,10}$/.test(c)) ?? '';
      const dat = z.cells.map(c => parseDatumCH(c)).find(d => d !== null) ?? '';
      aktLs = { fakturaNr: aktFaktura, lieferscheinNr: nr, datum: dat, positionen: [], warenwertNetto: null, pfandTotal: null, fakturaEndbetrag: null };
      pendingText = '';
      continue;
    }
    if (aktLs) {
      if (k.startsWith('leergutrückgabe')) { anhangModus = 'leergutrueckgabe'; continue; }
      if (k.startsWith('zu-/abschläge') || k.startsWith('zu/abschläge') || k.startsWith('recyclinggebühren')) {
        // Header «… | Anzahl | Gebühr | Wert | MwSt» ODER Abschlusszeile «… | 15.00»
        anhangModus = z.cells.length <= 2 ? 'positionen' : 'zuabschlaege';
        continue;
      }
      if (k.startsWith('endbetragchf')) {
        // Offizieller Rechnungs-Endbetrag → allen Lieferscheinen dieser Faktura zuweisen
        const val = parseChf(z.cells[z.cells.length - 1] ?? '');
        const fakt = aktFaktura;
        pushLs();
        if (val !== null) {
          for (const a of out.anhangLieferscheine) if (a.fakturaNr === fakt) a.fakturaEndbetrag = val;
        }
        continue;
      }
      if (anhangModus === 'leergutrueckgabe') {
        // «300007 | FGG Container/Fass a 50,00 | 6 | 50.00 | -300.00»
        if (/^\d{6}$/.test(z.cells[0] ?? '')) {
          const wert = parseChf(z.cells[z.cells.length - 1] ?? '');
          if (wert !== null && wert !== 0) {
            aktLs.positionen.push({
              artNr: z.cells[0], bezeichnung: z.cells.slice(1, z.cells.length - 3).join(' ').trim() || 'Leergutrückgabe',
              warengruppe: 'Leergut', menge: 1, einheit: '', preis: 0,
              positionspreis: wert, mwstBetrag: 0, mwstCode: 0,
            });
          }
        }
        continue;
      }
      if (anhangModus === 'zuabschlaege') {
        // «Logistikpauschale | 1 | 15.0000 | 15.00 | 8.1%»
        const pct = z.cells[z.cells.length - 1]?.match(/^(\d{1,2}\.\d)%$/);
        const wert = parseChf(z.cells[z.cells.length - 2] ?? '');
        if (pct && wert !== null) {
          const satz = Number(pct[1]);
          const bezZa = z.cells.slice(0, z.cells.length - 4).join(' ').trim();
          aktLs.positionen.push({
            artNr: '', bezeichnung: bezZa,
            warengruppe: gebuehrWarengruppe(bezZa, satz), menge: 1, einheit: '', preis: wert,
            positionspreis: wert, mwstBetrag: Math.round(wert * satz * 10) / 1000,
            mwstCode: satz === 2.6 ? 2 : 1,
          });
        }
        continue;
      }
      if (k.startsWith('zwischentotalwarenwert/pfand') || k.startsWith('zwischentotalwarenwert')) {
        const nums = z.cells.map(parseChf).filter((n): n is number => n !== null);
        // «… / Pfand | 45 Stk | 1'864.38 | 939.20» — die Folgezeile «inkl. Pfand» darf NICHT überschreiben
        if (k.includes('inkl')) continue;
        if (nums.length >= 2) { aktLs.warenwertNetto = nums[nums.length - 2]; aktLs.pfandTotal = nums[nums.length - 1]; }
        else if (nums.length === 1 && aktLs.warenwertNetto === null) { aktLs.warenwertNetto = nums[0]; }
        continue;
      }
      // Gebührenzeile auch ausserhalb des Header-Blocks: «VEG … | 48 | 0.0200 | 0.96 | 2.6%»
      const feePct = z.cells[z.cells.length - 1]?.match(/^(\d{1,2}\.\d)%$/);
      if (feePct && !/^\d{5,6}$/.test(z.cells[0] ?? '') && z.cells.length >= 4
          && parseChf(z.cells[z.cells.length - 2] ?? '') !== null
          && parseChf(z.cells[z.cells.length - 3] ?? '') !== null) {
        const satz = Number(feePct[1]);
        const wert = parseChf(z.cells[z.cells.length - 2] ?? '');
        if (wert !== null) {
          const bezGeb = z.cells.slice(0, z.cells.length - 4).join(' ').trim() || 'Gebühr';
          aktLs.positionen.push({
            artNr: '', bezeichnung: bezGeb,
            warengruppe: gebuehrWarengruppe(bezGeb, satz), menge: 1, einheit: '', preis: wert,
            positionspreis: wert, mwstBetrag: Math.round(wert * satz * 10) / 1000,
            mwstCode: satz === 0 ? 0 : satz === 2.6 ? 2 : 1,
          });
        }
        continue;
      }
      // Positionszeile: material … wert mwst% pfand
      const matIdx0 = /^\d{5,6}$/.test(z.cells[0] ?? '') ? 0 : -1;
      const pctIdx = z.cells.findIndex(c => /^\d{1,2}\.\d%$/.test(c));
      if (matIdx0 === 0 && pctIdx >= 3) {
        const satz = Number(z.cells[pctIdx].replace('%', ''));
        const wert = parseChf(z.cells[pctIdx - 1] ?? '');
        const preisRaw = z.cells[pctIdx - 2] ?? '';
        const preis = /gratis/i.test(preisRaw) ? 0 : parseChf(preisRaw);
        const stk = parseChf(z.cells[pctIdx - 3] ?? '');
        const bezTeile = z.cells.slice(1, Math.max(1, pctIdx - 4));
        const bez = [pendingText, ...bezTeile].join(' ').replace(/\s+/g, ' ').trim();
        pendingText = '';
        // Pfand-Spalte NACH dem Prozentsatz («36.60» oder «-»)
        const pfandVal = pctIdx + 1 < z.cells.length ? parseChf(z.cells[pctIdx + 1]) : null;
        if (pfandVal !== null) pfandGeliefert += pfandVal;
        if (wert !== null) {
          aktLs.positionen.push({
            artNr: z.cells[0], bezeichnung: bez, warengruppe: fsWarengruppe(bez, satz === 0 ? 0 : satz),
            menge: stk ?? 0, einheit: '', preis: preis ?? 0,
            positionspreis: wert, mwstBetrag: Math.round(wert * satz * 10) / 1000,
            mwstCode: satz === 0 ? 0 : satz === 2.6 ? 2 : 1,
          });
        }
        continue;
      }
      // reine Textzeile (umgebrochene Bezeichnung — kann VOR oder NACH der Zahlzeile stehen)
      if (z.cells.length > 0 && !/^(material|auftrag|warenempfänger|zu-\/abschläge|mehrwertsteuer|endbetrag|datum\/beleg|restaurantbeaulieu|feldschlösschengetränke|ch-4310|\*fürpfand|ohneihren|zahlungsbedingung)/.test(k)
          && z.cells.every(c => parseChf(c) === null || c.length > 12)) {
        // Steht direkt DANACH eine Materialzeile, ist dies deren umgebrochener
        // Bezeichnungs-ANFANG («Feldschlösschen Weizenfrisch alkoholfrei» vor
        // «20257 | 24X0,33 | …») → pendingText, NICHT an die letzte Position.
        const naechste = zeilen[i + 1];
        const istVerpackungsSuffix = /\d+X\d/i.test(z.text) || /^\d/.test(z.text.trim());
        const naechsteIstMaterial = naechste !== undefined
          && /^\d{5,6}$/.test(naechste.cells[0] ?? '')
          && naechste.cells.findIndex(c => /^\d{1,2}\.\d%$/.test(c)) >= 3;
        if (naechsteIstMaterial && !istVerpackungsSuffix) {
          pendingText = `${pendingText} ${z.text}`.replace(/\s+/g, ' ').trim();
        } else if (aktLs.positionen.length > 0 && pendingText === '') {
          const p = aktLs.positionen[aktLs.positionen.length - 1];
          // Heuristik: kurz nach einer Position → gehört zur letzten Bezeichnung
          p.bezeichnung = `${p.bezeichnung} ${z.text}`.replace(/\s+/g, ' ').trim();
          const satz = p.mwstCode === 0 ? 0 : p.mwstCode === 2 ? 2.6 : 8.1;
          p.warengruppe = fsWarengruppe(p.bezeichnung, satz);
        } else {
          pendingText = `${pendingText} ${z.text}`.replace(/\s+/g, ' ').trim();
        }
        continue;
      }
    }
  }
  pushLs();

  // Rundungs-Ausgleich je Faktura: offizieller «Endbetrag CHF» vs. Σ Positions-Brutto —
  // Differenzen (Rappen-Rundung, 0.05-Rundung) als NEUTRALE Position (mwstCode 0 → Depot)
  // an den letzten Lieferschein der Faktura hängen, damit Übernahmen den Faktura-Betrag treffen.
  const proFaktura = new Map<string, FsAnhangLieferschein[]>();
  for (const a of out.anhangLieferscheine) {
    proFaktura.set(a.fakturaNr, [...(proFaktura.get(a.fakturaNr) ?? []), a]);
  }
  for (const gruppe of proFaktura.values()) {
    const ziel = gruppe[0]?.fakturaEndbetrag;
    if (ziel === null || ziel === undefined) continue;
    const brutto = gruppe.reduce((a, ls) =>
      a + ls.positionen.reduce((b, p) => b + p.positionspreis + p.mwstBetrag, 0), 0);
    const diff = Math.round((ziel - brutto) * 100) / 100;
    if (diff !== 0 && Math.abs(diff) <= 2) {
      gruppe[gruppe.length - 1].positionen.push({
        artNr: '', bezeichnung: 'Rundungsdifferenz', warengruppe: 'Leergut',
        menge: 1, einheit: '', preis: 0,
        positionspreis: diff, mwstBetrag: 0, mwstCode: 0,
      });
    }
  }

  // Nachklassifizierung über ALLE Anhang-Positionen (dokumentweit: Zeilen mit
  // abgeschnittener Bezeichnung erben die Kategorie derselben Artikel-Nr).
  nachklassifiziereProArtikel(out.anhangLieferscheine.flatMap(a => a.positionen));

  if (!out.nr) out.failureReason = 'Keine «Sammelrechnung: <Nr>» gefunden.';
  else if (out.fakturen.length === 0) out.failureReason = 'Keine Faktura-Zeilen erkannt.';
  return out;
}

// ── Einzelne FS-Faktura (Kopf «Rechnung: <Nr>», eigene Zusammenfassung MwSt.) ─

/**
 * Einzelnes Faktura-PDF parsen — gleiche Zustandsmaschine wie der Anhang der
 * Sammelrechnung (das Layout ist identisch), aber mit eigenen Erfolgs-Kriterien:
 * es gibt keine «Sammelrechnung:»-Kopfzeile und keine Faktura-Tabelle.
 */
export function parseFsFaktura(zeilen: FsZeile[]): FsSammelrechnung {
  const out = parseFsSammelrechnung(zeilen);
  out.failureReason = undefined;
  const nrn = Object.keys(out.fakturaKategorien);
  if (out.anhangLieferscheine.length === 0) {
    out.failureReason = 'Keine Lieferschein-Positionen erkannt — ist das eine Feldschlösschen-Rechnung?';
  } else if (nrn.length === 0) {
    out.failureReason = 'Keine «Zusammenfassung MwSt.» gefunden — Kontierung wäre nicht belegbar.';
  } else {
    out.nr = out.anhangLieferscheine[0].fakturaNr;
    // Rechnungsdatum aus dem Kopf («Datum: …» folgt NACH der «Rechnung:»-Zeile,
    // die bereits in den Anhang-Modus schaltet — darum hier separat lesen).
    if (!out.datum) {
      for (const z of zeilen.slice(0, 40)) {
        if (z.kompakt.includes('datum:')) {
          out.datum = parseDatumCH(z.cells[z.cells.length - 1] ?? '') ?? '';
          if (out.datum) break;
        }
      }
    }
    if (!out.datum) out.datum = [...out.anhangLieferscheine].map(a => a.datum).sort().at(-1) ?? '';
    if (out.endbetrag === null) out.endbetrag = out.anhangLieferscheine[0].fakturaEndbetrag ?? null;
    // Ohne Beleg-Nr kein Dedupe/Kreditoren-Match, ohne offiziellen Endbetrag
    // keine belastbare Buchung — beides ist Pflicht.
    if (!out.nr) out.failureReason = 'Keine Rechnungs-Nummer («Rechnung: <Nr>») gefunden.';
    else if (out.endbetrag === null) out.failureReason = 'Kein «Endbetrag CHF» gefunden — offizieller Rechnungsbetrag fehlt.';
  }
  return out;
}

/**
 * Fakturen eines geparsten FS-Dokuments als buchbare Rechnungen — EINE Buchung
 * je Faktura (alle Lieferscheine zusammengelegt; die Beleg-Nr = Faktura-Nr
 * matcht die Kreditoren-Übernahme). Die Faktura-eigene «Zusammenfassung MwSt.»
 * wird als massgebliche Kontierung mitgegeben (hier IMMER eindeutig, weil die
 * Buchung die ganze Faktura umfasst — auch bei mehreren Lieferscheinen).
 */
export function fsFakturenAlsRechnungen(s: FsSammelrechnung): Array<{
  r: ParsedCsvRechnung;
  fsKategorien?: FsKategorieSumme[];
  nettoOffiziell?: number | null;
  bruttoOffiziell?: number | null;
}> {
  const proFaktura = new Map<string, FsAnhangLieferschein[]>();
  for (const a of s.anhangLieferscheine) {
    proFaktura.set(a.fakturaNr, [...(proFaktura.get(a.fakturaNr) ?? []), a]);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return [...proFaktura.entries()].map(([nr, lss]) => {
    const positionen = lss.flatMap(l => l.positionen);
    const netto = positionen.reduce((a, p) => a + p.positionspreis, 0);
    const mwst = positionen.reduce((a, p) => a + p.mwstBetrag, 0);
    const datum = lss.map(l => l.datum).filter(Boolean).sort().at(-1) ?? s.datum;
    const kats = (s.fakturaKategorien[nr] ?? []).filter(k =>
      Math.abs(k.nettoTotal) >= 0.005 || Math.abs(k.netto81) >= 0.005
      || Math.abs(k.netto26) >= 0.005 || Math.abs(k.netto00) >= 0.005);
    return {
      r: {
        docKey: `${nr}|${datum}`,
        rechnungsNr: nr,
        datum,
        markt: 'Feldschlösschen',
        positionen,
        nettoTotal: r2(netto),
        mwstTotal: r2(mwst),
        bruttoTotal: r2(netto + mwst),
      },
      fsKategorien: kats.length > 0 ? kats : undefined,
      // Offizielle Beträge der Faktura: Netto = Σ Zusammenfassung, Brutto = «Endbetrag CHF»
      nettoOffiziell: kats.length > 0 ? r2(kats.reduce((a, k) => a + k.nettoTotal, 0)) : undefined,
      bruttoOffiziell: lss[0]?.fakturaEndbetrag ?? undefined,
    };
  });
}

// ── Faktura-Abgleich (Kontrolle, kein Doppelzählen) ──────────────────────────

export interface FakturaMatch {
  faktura: FsFaktura;
  status: 'vorhanden' | 'fehlt';
  /** IDs der gematchten erfassten Rechnungen (InvoiceEntry.id). */
  invoiceIds: string[];
  /** Summe der gematchten Brutto-Beträge. */
  erfasstBrutto: number | null;
}

export interface FakturaAbgleich {
  matches: FakturaMatch[];
  vorhanden: number;
  gesamt: number;
  summeErfasst: number;    // Σ gematchte Brutto-Beträge
  summeMonatsrechnung: number; // Σ Faktura-Endbeträge
}

/**
 * Fakturas der Monatsrechnung gegen erfasste Einzel-Lieferungen matchen:
 * Datum (±7 Tage — Faktura-Datum kann dem Lieferdatum nachlaufen) + Betrag (Toleranz 0.10 CHF).
 * Eine Faktura kann MEHRERE Lieferscheine bündeln → auch Summen-Match je Datum.
 */
export function matchFakturen(
  fakturen: FsFaktura[],
  invoices: Array<{ id: string; date: string; amountGross: number }>,
  tolChf = 0.10,
): FakturaAbgleich {
  const belegt = new Set<string>();
  const matches: FakturaMatch[] = [];

  const tageDiff = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

  for (const f of fakturen) {
    const kandidaten = invoices.filter(iv => !belegt.has(iv.id) && f.datum && iv.date && tageDiff(iv.date, f.datum) <= 7);
    // 1) Einzel-Match
    const einzel = kandidaten.find(iv => Math.abs(iv.amountGross - f.endbetrag) <= tolChf);
    if (einzel) {
      belegt.add(einzel.id);
      matches.push({ faktura: f, status: 'vorhanden', invoiceIds: [einzel.id], erfasstBrutto: einzel.amountGross });
      continue;
    }
    // 2) Teilmengen-Match: eine Faktura bündelt oft MEHRERE Lieferscheine
    //    (auch mit negativen Leergut-Scheinen) — kleinste passende Teilmenge suchen.
    let gefunden: Array<{ id: string; amountGross: number }> | null = null;
    if (kandidaten.length >= 2 && kandidaten.length <= 12) {
      for (let bits = 3; bits < (1 << kandidaten.length); bits++) {
        const teil = kandidaten.filter((_, idx) => (bits >> idx) & 1);
        if (teil.length < 2) continue;
        if (gefunden && teil.length >= gefunden.length) continue;
        const summe = teil.reduce((a, iv) => a + iv.amountGross, 0);
        if (Math.abs(summe - f.endbetrag) <= tolChf) gefunden = teil;
      }
    }
    if (gefunden) {
      gefunden.forEach(iv => belegt.add(iv.id));
      const summe = Math.round(gefunden.reduce((a, iv) => a + iv.amountGross, 0) * 100) / 100;
      matches.push({ faktura: f, status: 'vorhanden', invoiceIds: gefunden.map(iv => iv.id), erfasstBrutto: summe });
      continue;
    }
    matches.push({ faktura: f, status: 'fehlt', invoiceIds: [], erfasstBrutto: null });
  }

  const vorhanden = matches.filter(m => m.status === 'vorhanden').length;
  return {
    matches,
    vorhanden,
    gesamt: fakturen.length,
    summeErfasst: Math.round(matches.reduce((a, m) => a + (m.erfasstBrutto ?? 0), 0) * 100) / 100,
    summeMonatsrechnung: Math.round(fakturen.reduce((a, f) => a + f.endbetrag, 0) * 100) / 100,
  };
}

/**
 * Duplikat-Wache für die Anhang-Übernahme: existiert bereits eine (noch keiner
 * Faktura zugeordnete) Rechnung, die dem zu übernehmenden Lieferschein nach den
 * KONTROLL-Kriterien (Datum ±7 Tage, Betrag ±0.10) nahekommt, wird NICHT
 * importiert — vermutlich dieselbe Lieferung unter anderer Referenz/Datum.
 * Exakte Referenz+Datum-Treffer sind erlaubt (idempotenter Upsert).
 */
export function findeNaheRechnung(
  invoices: Array<{ id: string; date: string; amountGross: number; reference?: string }>,
  ls: { lieferscheinNr: string; datum: string; brutto: number },
  bereitsZugeordnet: Set<string>,
  tolChf = 0.10,
): { id: string; date: string; amountGross: number } | null {
  const tageDiff = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
  for (const iv of invoices) {
    if (bereitsZugeordnet.has(iv.id)) continue;
    const exakt = (iv.reference ?? '').trim().toLowerCase() === ls.lieferscheinNr.toLowerCase() && iv.date === ls.datum;
    if (exakt) continue; // wird vom Upsert ersetzt, kein Duplikat
    if (ls.datum && iv.date && tageDiff(iv.date, ls.datum) <= 7 && Math.abs(iv.amountGross - ls.brutto) <= tolChf) {
      return iv;
    }
  }
  return null;
}

// ── Anhang-Lieferschein → Rechnung (Komfort-Übernahme) ───────────────────────

/** Anhang-Lieferschein in die ParsedCsvRechnung-Form bringen (gleiche Import-Pipeline). */
export function fsAnhangAlsRechnung(ls: FsAnhangLieferschein): ParsedCsvRechnung {
  const netto = ls.positionen.reduce((a, p) => a + p.positionspreis, 0);
  const mwst = ls.positionen.reduce((a, p) => a + p.mwstBetrag, 0);
  return {
    docKey: `${ls.lieferscheinNr}|${ls.datum}`,
    rechnungsNr: ls.lieferscheinNr,
    datum: ls.datum,
    markt: 'Feldschlösschen',
    positionen: ls.positionen,
    nettoTotal: Math.round(netto * 100) / 100,
    mwstTotal: Math.round(mwst * 100) / 100,
    bruttoTotal: Math.round((netto + mwst) * 100) / 100,
  };
}

// ── Konto-Splits direkt aus der «Zusammenfassung MwSt.» (massgeblich) ────────

/**
 * Kontierung je Kategorie der Rechnungs-eigenen «Zusammenfassung MwSt.»:
 * Warenkategorien über das Warengruppen-Mapping (Bier→4030, Spirituosen→4040,
 * Wein→4020, alkoholfreie→4050, Zu-/Abschläge/Mietmaterial etc.→4701),
 * 0%-Kategorien (Leergut, Ladungsträger) → neutrales Pseudo-Konto «Depot».
 * Unbekannte Kategorien → «offen» (nie raten), Namen in `offen` gemeldet.
 * Rückgabe-Summe = Σ nettoTotal aller nicht-leeren Kategorien.
 */
export function kontoSplitsAusFsKategorien(
  kategorien: FsKategorieSumme[],
  mapping: WarengruppenMapping,
  /**
   * Optionale Einzelpositionen der Rechnung: Gebühren-Zeilen (VEG/VRG,
   * Recycl.-Geb., Logistikpauschale, «…gebühr») stecken in der Zusammenfassung
   * MwSt. INNERHALB der Warenkategorien (FGG zählt VEG z.B. zu «Andere alk.
   * freie Getränke»). Werden Positionen übergeben, wird ihr Betrag je Kategorie
   * und MwSt-Satz aus dem Warenkonto-Bucket HERAUSGERECHNET und auf 4701 gelegt
   * — BEVOR der Rest nach Kategorie verteilt wird. Pfand (MwSt 0/Depot) bleibt
   * unberührt (istZwingendGebuehr schliesst Pfand aus).
   */
  positionen?: Array<{ bezeichnung: string; warengruppe: string; mwstCode: number; positionspreis: number }>,
): {
  splits: Array<{ warenkonto: string; amountNet: number; amountGross: number }>;
  offen: string[];
  /**
   * Netto-Summe der Zwangs-Gebühren, die NICHT sauber aus einem Warenkonto-
   * Bucket herausgerechnet werden konnten (keine passende ZSF-Kategorie, oder
   * Betrag übersteigt den Satz-Bucket). > 0 heisst: der ZSF-Split würde
   * Gebühren auf einem Warenkonto belassen — Aufrufer muss sichtbar auf die
   * Positions-Kontierung ausweichen (die 4701 erzwingt), nie still übernehmen.
   */
  gebuehrenRest: number;
} {
  const effektiv = mitFsDefaults(mapping);
  const proKonto = new Map<string, { net: number; gross: number }>();
  const offen: string[] = [];
  // Zwangs-Positionen (Gebühren→4701, Reinigung→6040) je ZSF-Kategorie
  // (warengruppe), ZIEL-Konto und Satz sammeln — beide werden identisch aus
  // den Warenkonto-Buckets herausgerechnet.
  const gebProKat = new Map<string, Map<string, { n81: number; n26: number }>>();
  for (const p of positionen ?? []) {
    let ziel: string;
    if (istZwingendGebuehr(p)) ziel = KONTO_GEBUEHR;            // schliesst Pfand/Depot aus
    else if (istZwingendReinigung(p)) ziel = KONTO_REINIGUNG;
    else continue;
    const key = p.warengruppe.trim().toLowerCase();
    const proZiel = gebProKat.get(key) ?? new Map<string, { n81: number; n26: number }>();
    const cur = proZiel.get(ziel) ?? { n81: 0, n26: 0 };
    if (p.mwstCode === 2) cur.n26 += p.positionspreis;
    else if (p.mwstCode === 1) cur.n81 += p.positionspreis;
    proZiel.set(ziel, cur);
    gebProKat.set(key, proZiel);
  }
  const verrechnet = new Set<string>();
  let gebuehrenRest = 0;
  const addKonto = (konto: string, net: number, gross: number) => {
    const cur = proKonto.get(konto) ?? { net: 0, gross: 0 };
    cur.net += net; cur.gross += gross;
    proKonto.set(konto, cur);
  };
  for (const kat of kategorien) {
    const leer = Math.abs(kat.nettoTotal) < 0.005
      && Math.abs(kat.netto81) < 0.005 && Math.abs(kat.netto26) < 0.005 && Math.abs(kat.netto00) < 0.005;
    if (leer) continue;
    const name = kat.name.trim();
    const nurNull = Math.abs(kat.netto81) < 0.005 && Math.abs(kat.netto26) < 0.005;
    let konto: string;
    // ALLE Depot-Typen der Zusammenfassung (Leergut, Gebinde/Harasse,
    // Ladungsträger, Pfand/Depot) → Depot, NIE auf 4030/4040/4050.
    // Recyclinggebühren bleiben bewusst im Mapping (echte Gebühr, kein Depot).
    // Pfand/Leergut/Gebinde → Konto 4800 (Gebinde-Verrechnung, neutral).
    // Token-Match statt exaktem Namen: Kategorien wie «Pfand geliefert»,
    // «FGG Container/Fass», «FGG Harasse», «Harasse 5+20» zählen alle dazu.
    if (/(^|[^a-zäöü])(leergut|ladungsträger|pfand|depot|gebinde|container|harass)/i.test(name)) konto = KONTO_LABEL_PFAND;
    // Gebühren/Konditionen-Kategorien (Recyclinggebühren, Zu-/Abschläge, VEG)
    // → IMMER 4701, VOR dem konfigurierten Mapping: ein gespeichertes Mapping
    // darf Gebühren nie auf ein Warenkonto (4020–4070) routen.
    else if (istGebuehrenText(name)) konto = KONTO_GEBUEHR;
    else {
      const regel = effektiv.find(r => r.gruppe.trim().toLowerCase() === name.toLowerCase());
      if (regel) konto = regel.konto;
      else if (nurNull) konto = KONTO_LABEL_PFAND; // reine 0%-Kategorie = Pfand-artig → 4800
      else { konto = 'offen'; offen.push(name); } // nie raten
    }
    // Gebühren-Anteil dieser Kategorie ZUERST herausrechnen und auf 4701 legen —
    // nur wenn die Kategorie selbst auf ein anderes Konto läuft (sonst wäre der
    // Betrag doppelt gezählt; Pfand-Kategorien enthalten via istZwingendGebuehr
    // nie Gebühren-Positionen).
    let n81 = kat.netto81, n26 = kat.netto26, netTotal = kat.nettoTotal;
    const katKey = kat.name.trim().toLowerCase();
    const proZiel = gebProKat.get(katKey);
    if (proZiel) {
      for (const [ziel, geb] of proZiel) {
        if (konto === ziel || konto === KONTO_LABEL_PFAND) {
          // Kategorie läuft selbst auf das Ziel-Konto/Pfand — nichts umzuhängen,
          // aber die Positionen gelten als verrechnet (keine Doppelzählung).
          continue;
        }
        // NIE über den Satz-Bucket hinaus subtrahieren (kein negativer Rest-
        // Warenbucket); was nicht passt, wird als Rest gemeldet (Toleranz ½ Rp).
        const take81 = Math.min(Math.max(geb.n81, 0), Math.max(n81, 0));
        const take26 = Math.min(Math.max(geb.n26, 0), Math.max(n26, 0));
        gebuehrenRest += (geb.n81 - take81) + (geb.n26 - take26);
        if (take81 + take26 > 0) {
          n81 -= take81; n26 -= take26;
          netTotal -= take81 + take26;
          addKonto(ziel, take81 + take26, take81 * 1.081 + take26 * 1.026);
        }
      }
      verrechnet.add(katKey);
    }
    addKonto(konto, netTotal, n81 * 1.081 + n26 * 1.026 + kat.netto00);
  }
  // Zwangs-Positionen OHNE passende ZSF-Kategorie (abweichender Name) → Rest melden.
  for (const [key, proZiel] of gebProKat) {
    if (verrechnet.has(key)) continue;
    for (const geb of proZiel.values()) gebuehrenRest += geb.n81 + geb.n26;
  }
  gebuehrenRest = Math.abs(gebuehrenRest) < 0.005 ? 0 : Math.round(gebuehrenRest * 100) / 100;
  const splits = [...proKonto.entries()].map(([warenkonto, v]) => ({
    warenkonto,
    amountNet: Math.round(v.net * 100) / 100,
    amountGross: Math.round(v.gross * 100) / 100,
  }));
  return { splits, offen, gebuehrenRest };
}

// ── Kategorien-Gegenprobe (Zusammenfassung MwSt vs. erfasste Konto-Summen) ───

export interface KategorienGegenprobeZeile {
  kategorie: string;
  monatsrechnung: number;      // Nettowert lt. Sammelrechnung
  erfasst: number | null;      // Σ Positionsnetto der erfassten FS-Rechnungen dieser Kategorie
  diff: number | null;
}

export function kategorienGegenprobe(
  kategorien: FsKategorieSumme[],
  positionen: Array<{ warengruppe: string; positionspreis: number }>,
): KategorienGegenprobeZeile[] {
  const erfasstProKat = new Map<string, number>();
  for (const p of positionen) {
    const key = p.warengruppe.trim().toLowerCase();
    if (!key) continue;
    erfasstProKat.set(key, (erfasstProKat.get(key) ?? 0) + p.positionspreis);
  }
  return kategorien
    .filter(kat => Math.abs(kat.nettoTotal) >= 0.005 || erfasstProKat.has(kat.name.trim().toLowerCase()))
    .map(kat => {
      const erf = erfasstProKat.get(kat.name.trim().toLowerCase());
      const erfasst = erf === undefined ? null : Math.round(erf * 100) / 100;
      return {
        kategorie: kat.name,
        monatsrechnung: kat.nettoTotal,
        erfasst,
        diff: erfasst === null ? null : Math.round((erfasst - kat.nettoTotal) * 100) / 100,
      };
    });
}

// ── Historie (Teil C) ─────────────────────────────────────────────────────────

export interface FsHistorienEintrag {
  sammelNr: string;
  datum: string;               // YYYY-MM-DD
  monat: string;               // YYYY-MM
  endbetrag: number | null;
  fakturaAnzahl: number;
  kategorien: Record<string, number>;   // Kategorie → Nettowert
  /** Material → letzter bekannter Stückpreis + Aggregat (für Preisentwicklung/Volumen). */
  material: Record<string, { bezeichnung: string; menge: number; wert: number; letzterPreis: number }>;
}

export function sammelrechnungZuHistorie(s: FsSammelrechnung): FsHistorienEintrag {
  const kategorien: Record<string, number> = {};
  for (const kat of s.kategorien) {
    if (Math.abs(kat.nettoTotal) >= 0.005) kategorien[kat.name] = kat.nettoTotal;
  }
  const material: FsHistorienEintrag['material'] = {};
  for (const ls of s.anhangLieferscheine) {
    for (const p of ls.positionen) {
      if (p.mwstCode === 0 || !p.artNr) continue;
      const cur = material[p.artNr] ?? { bezeichnung: p.bezeichnung, menge: 0, wert: 0, letzterPreis: 0 };
      cur.menge += p.menge;
      cur.wert = Math.round((cur.wert + p.positionspreis) * 100) / 100;
      if (p.preis > 0) cur.letzterPreis = p.preis;
      if (p.bezeichnung.length > cur.bezeichnung.length) cur.bezeichnung = p.bezeichnung;
      material[p.artNr] = cur;
    }
  }
  return {
    sammelNr: s.nr,
    datum: s.datum,
    monat: s.datum.slice(0, 7),
    endbetrag: s.endbetrag,
    fakturaAnzahl: s.fakturen.length,
    kategorien,
    material,
  };
}
