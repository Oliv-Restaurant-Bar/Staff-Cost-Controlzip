/**
 * Transgourmet/Prodega CSV-Positionsimport (Kundenportal-Format)
 * ==============================================================
 * Semikolon-getrennt, Kopfzeile u.a.: Kundennummer;Rechnungsnummer;Datum;
 * Markt;Warengruppe;Position;Art. Nr.;Menge;Gewicht;Einheit;
 * Artikelbezeichnung;Preis;Positionspreis;MwSt;EAN;Pfand;Aktion;MwSt. Code;…
 *
 * - `Preis`          = Einzelpreis pro Einheit, NETTO (Preisüberwachung!)
 * - `Positionspreis` = Menge × Preis (netto), kann negativ sein (Retouren)
 * - `MwSt`           = MwSt-BETRAG der Position (CHF)
 * - `MwSt. Code` 0   = Pfand/Gebinde → von der Preisüberwachung ausgenommen
 *
 * Rein parsen/aggregieren — keine Persistenz hier. Parser liefert IMMER ein
 * debug-Objekt + failureReason auf allen Fehlpfaden (nie blind raten).
 */

export interface WarenPosition {
  artNr: string;            // '' wenn fehlend
  bezeichnung: string;
  warengruppe: string;
  menge: number;
  einheit: string;
  /** Einzelpreis pro Einheit, netto (Spalte "Preis"). */
  preis: number;
  /** Positionstotal netto (Spalte "Positionspreis"). */
  positionspreis: number;
  /** MwSt-Betrag der Position (CHF). */
  mwstBetrag: number;
  /** MwSt. Code (0 = Pfand/Gebinde). */
  mwstCode: number;
}

export interface ParsedCsvRechnung {
  /**
   * Stabiler Dokumentschlüssel `rechnungsNr|datum|markt` — Portal-Exporte
   * verwenden Rechnungsnummern (z.B. "58") über Monate hinweg wieder, und
   * dieselbe Nummer kann am selben Tag in mehreren Märkten (BGH vs. Prodega)
   * auftreten; Gruppierung/Auswahl/Historie kombinieren daher alle drei.
   */
  docKey: string;
  rechnungsNr: string;
  datum: string;            // YYYY-MM-DD
  markt: string;
  positionen: WarenPosition[];
  nettoTotal: number;       // Σ Positionspreis
  mwstTotal: number;        // Σ MwSt-Betrag
  bruttoTotal: number;      // netto + mwst
}

export interface CsvParseErgebnis {
  rechnungen: ParsedCsvRechnung[];
  failureReason: string | null;
  debug: {
    zeilenTotal: number;
    zeilenVerwendet: number;
    zeilenVerworfen: number;
    spalten: string[];
    beispielZeile?: string;
    /** Unparsebare Zahlenwerte (als 0 übernommen) — MUSS dem User gemeldet werden. */
    zahlenfehler?: string[];
  };
}

const PFLICHT_SPALTEN = ['Rechnungsnummer', 'Datum', 'Artikelbezeichnung', 'Preis', 'Positionspreis'];

/**
 * Robuste Betrags-Zahl (zentrale parseAmount-Logik): Apostroph-/Leerzeichen-
 * Tausender, Komma ODER Punkt als Dezimaltrenner. `null` = unparsebar —
 * der Aufrufer MELDET das (debug.zahlenfehler), nie still 0.
 */
function parseNumStrict(s: string | undefined): number | null {
  if (s === undefined || s.trim() === '') return 0; // leer = kein Wert (0 ist ok)
  let t = s.trim().replace(/[’'\u00A0 ]/g, '');
  if (t.includes(',') && t.includes('.')) t = t.replace(/,/g, ''); // 1,234.56
  else t = t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * MwSt-Code: numerisch («0», «1», «2») oder Buchstabencode («C0», «C1») —
 * die Ziffer zählt. 0 = Pfand/Gebinde. Unbekannte/unlesbare Codes → -1
 * (NIE fälschlich als Pfand neutralisieren; Kontierung fällt auf
 * Warengruppe/«offen» zurück).
 */
function parseMwstCode(s: string | undefined): number {
  const t = (s ?? '').trim();
  if (t === '') return -1;
  const m = /^[A-Za-z]?(\d{1,2})$/.exec(t);
  return m ? parseInt(m[1], 10) : -1;
}

export function parseTransgourmetCsv(text: string): CsvParseErgebnis {
  const zeilen = text.split(/\r?\n/).filter(z => z.trim() !== '');
  const debugBasis = { zeilenTotal: zeilen.length, zeilenVerwendet: 0, zeilenVerworfen: 0, spalten: [] as string[] };
  if (zeilen.length < 2) {
    return { rechnungen: [], failureReason: 'Datei ist leer oder enthält nur die Kopfzeile.', debug: debugBasis };
  }
  const header = zeilen[0].split(';').map(h => h.trim());
  debugBasis.spalten = header;
  const idx = (name: string) => header.findIndex(h => h === name);
  const fehlend = PFLICHT_SPALTEN.filter(s => idx(s) < 0);
  if (fehlend.length > 0) {
    return {
      rechnungen: [], debug: { ...debugBasis, beispielZeile: zeilen[1]?.slice(0, 300) },
      failureReason: `Kein Transgourmet/Prodega-Format — fehlende Spalten: ${fehlend.join(', ')}. Gefundene Spalten: ${header.filter(Boolean).join(', ')}`,
    };
  }
  const iRech = idx('Rechnungsnummer'), iDat = idx('Datum'), iMarkt = idx('Markt'),
    iGrp = idx('Warengruppe'), iArt = idx('Art. Nr.'), iMenge = idx('Menge'),
    iEinh = idx('Einheit'), iBez = idx('Artikelbezeichnung'), iPreis = idx('Preis'),
    iPos = idx('Positionspreis'), iMwst = idx('MwSt'), iCode = idx('MwSt. Code');

  const proRechnung = new Map<string, ParsedCsvRechnung>();
  const zahlenfehler: string[] = [];
  let verwendet = 0, verworfen = 0;
  for (let z = 1; z < zeilen.length; z++) {
    const c = zeilen[z].split(';');
    const rechnungsNr = (c[iRech] ?? '').trim();
    const datum = (c[iDat] ?? '').trim();
    const bez = (c[iBez] ?? '').trim();
    if (!rechnungsNr || !/^\d{4}-\d{2}-\d{2}$/.test(datum) || !bez) { verworfen++; continue; }
    const markt = (c[iMarkt] ?? '').trim();
    // Markt gehört zur Dokument-Identität: kurze Portal-Rechnungsnummern können
    // am selben Tag in MEHREREN Märkten (Transgourmet BGH vs. Prodega) vorkommen —
    // ohne Markt im Schlüssel würden fremde Positionen zusammengemischt.
    const docKey = `${rechnungsNr}|${datum}|${markt.toLowerCase()}`;
    let r = proRechnung.get(docKey);
    if (!r) {
      r = { docKey, rechnungsNr, datum, markt, positionen: [], nettoTotal: 0, mwstTotal: 0, bruttoTotal: 0 };
      proRechnung.set(docKey, r);
    }
    const num = (roh: string | undefined, feld: string): number => {
      const n = parseNumStrict(roh);
      if (n === null) {
        if (zahlenfehler.length < 20) zahlenfehler.push(`Zeile ${z + 1} (${bez}): ${feld} «${roh}» unlesbar — als 0 übernommen`);
        else if (zahlenfehler.length === 20) zahlenfehler.push('… weitere Zahlenfehler unterdrückt');
        return 0;
      }
      return n;
    };
    const pos: WarenPosition = {
      artNr: (c[iArt] ?? '').trim(),
      bezeichnung: bez,
      warengruppe: iGrp >= 0 ? (c[iGrp] ?? '').trim() : '',
      menge: num(c[iMenge], 'Menge'),
      einheit: iEinh >= 0 ? (c[iEinh] ?? '').trim() : '',
      preis: num(c[iPreis], 'Preis'),
      positionspreis: num(c[iPos], 'Positionspreis'),
      mwstBetrag: iMwst >= 0 ? num(c[iMwst], 'MwSt') : 0,
      mwstCode: iCode >= 0 ? parseMwstCode(c[iCode]) : -1,
    };
    r.positionen.push(pos);
    r.nettoTotal += pos.positionspreis;
    r.mwstTotal += pos.mwstBetrag;
    verwendet++;
  }
  const rechnungen = [...proRechnung.values()].map(r => ({
    ...r,
    nettoTotal: Math.round(r.nettoTotal * 100) / 100,
    mwstTotal: Math.round(r.mwstTotal * 100) / 100,
    bruttoTotal: Math.round((r.nettoTotal + r.mwstTotal) * 100) / 100,
  })).sort((a, b) => a.datum.localeCompare(b.datum) || a.rechnungsNr.localeCompare(b.rechnungsNr));
  return {
    rechnungen,
    failureReason: rechnungen.length === 0 ? 'Keine gültigen Positionszeilen gefunden (Rechnungsnummer/Datum/Artikel fehlen).' : null,
    debug: {
      ...debugBasis, zeilenVerwendet: verwendet, zeilenVerworfen: verworfen,
      ...(zahlenfehler.length > 0 ? { zahlenfehler } : {}),
    },
  };
}

// ─── Warengruppe → Warenkonto (Kategorie folgt via kategorieFromKonto) ───────

/** Default-Zuordnung; unbekannte Gruppen → Lebensmittel 4000 (F&B-Portal). */
// ─── Warengruppe → Konto (konfigurierbare Zuordnungstabelle) ────────────────

/** Eine Zuordnungsregel: normalisierter Warengruppen-Name → Kontonummer. */
export interface WarengruppenRegel {
  /** Warengruppe wie im CSV (Anzeige-Schreibweise). */
  gruppe: string;
  /** Kontonummer, z.B. '4020'. */
  konto: string;
}
export type WarengruppenMapping = WarengruppenRegel[];

/** Vorbelegung gemäss Kontenplan (Restaurant). */
export const DEFAULT_WARENGRUPPEN_MAPPING: WarengruppenMapping = [
  { gruppe: 'Wein',                konto: '4020' },
  { gruppe: 'Bier',                konto: '4030' },
  { gruppe: 'Spirituosen',         konto: '4040' },
  { gruppe: 'Getränke',            konto: '4050' },
  { gruppe: 'Metzgerei',           konto: '4060' },
  { gruppe: 'Früchte + Gemüse',    konto: '4060' },
  { gruppe: 'Molkerei/Backwaren',  konto: '4060' },
  { gruppe: 'Food',                konto: '4060' },
  { gruppe: 'Nearfood',            konto: '4701' },
  { gruppe: 'Nonfood',             konto: '4701' },
];

const normGruppe = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// ─── Artikel → Konto (gelernte Einzel-Zuordnungen, pro Mandant) ──────────────

/**
 * In der Import-Vorschau manuell gesetzte Kontierungen werden pro Artikel
 * GEMERKT: Key = artikelKey(lieferant, p) (Art.-Nr. bevorzugt, sonst Name),
 * Wert = Kontonummer. Gilt beim nächsten Import automatisch. Vorrang:
 * Pfand (MwSt-Code 0) > Artikel-Zuordnung > Warengruppen-Tabelle.
 */
export type ArtikelKontenMapping = Record<string, string>;

export function normalizeArtikelKonten(raw: unknown): ArtikelKontenMapping {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ArtikelKontenMapping = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && /^\d{4}$/.test(v.trim()) && k.trim()) out[k] = v.trim();
  }
  return out;
}

/** Konto-Auswahl für die Vorschau-Bearbeitung (Kontenplan Restaurant). */
export const KONTO_OPTIONEN: Array<{ konto: string; label: string }> = [
  { konto: '4000', label: '4000 Lebensmittel' },
  { konto: '4020', label: '4020 Wein' },
  { konto: '4030', label: '4030 Bier' },
  { konto: '4040', label: '4040 Spirituosen' },
  { konto: '4050', label: '4050 Getränke ohne Alkohol' },
  { konto: '4060', label: '4060 Lebensmittel (Frische)' },
  { konto: '4701', label: '4701 Betriebskosten (Nearfood/Nonfood)' },
];

/** Positions-Kontierung: zugeordnet / Pfand (neutral, kein Warenkonto) / offen (unbekannte Gruppe — NIE raten). */
export type PositionsKontoStatus = 'zugeordnet' | 'pfand' | 'offen';
export interface PositionsKonto {
  konto: string | null;      // null bei pfand/offen
  status: PositionsKontoStatus;
}

/**
 * Text-Erkennung Pfand/Leergut/Gebinde (z.B. Transgourmet «Ifco»-Harasse,
 * Depot-Positionen): greift ZUSÄTZLICH zum MwSt-Code 0 — die FIBU bucht Pfand
 * auf ein separates Depot-Konto, nie auf die direkten Warenkonten. Im Zweifel
 * (Kennwort im Artikelnamen) als Depot behandeln, nie raten.
 */
/**
 * STARKE Pfand-Kennwörter: eindeutig Depot, egal welche Warengruppe/MwSt
 * (Pfand, Leergut, Depot, Ifco-Mehrwegkisten).
 */
export function istPfandBezeichnungStark(bezeichnung: string | undefined): boolean {
  if (!bezeichnung) return false;
  for (const tok of tokens(bezeichnung)) {
    if (/^(pfand|leergut)[a-zäöü]*$/.test(tok)) return true;
    if (/^ifco[a-z0-9äöü-]*$/.test(tok)) return true; // Marken-Mehrwegkisten
    if (/^depot(s|gebühr(en)?)?$/.test(tok)) return true;
    if (/^fgg$/.test(tok)) return true; // Feldschlösschen-Gebinde-Positionen («FGG Container/Fass», «FGG Harasse»)
  }
  return false;
}

/**
 * Pfand-WARENGRUPPE (z.B. Feldschlösschen «Leergut», TG «Gebinde/Pfand»):
 * die Gruppe selbst sagt Depot — sie darf NIE über die Warengruppen-Tabelle
 * oder eine gelernte Artikel-Zuordnung auf 6040/ein Warenkonto laufen.
 */
export function istPfandWarengruppe(warengruppe: string | undefined): boolean {
  if (!warengruppe) return false;
  for (const tok of tokens(warengruppe)) {
    if (/^(pfand|leergut|depot|gebinde|ladungsträger|ladungstraeger)[a-zäöü]*$/.test(tok)) return true;
  }
  return false;
}

/** Universelle Zwangs-Pfand-Erkennung (läuft VOR Artikel-/Warengruppen-Regeln). */
export function istZwingendPfand(
  p: Pick<WarenPosition, 'mwstCode'> & Partial<Pick<WarenPosition, 'bezeichnung' | 'warengruppe'>>,
): boolean {
  return p.mwstCode === 0 || istPfandBezeichnungStark(p.bezeichnung) || istPfandWarengruppe(p.warengruppe);
}

/**
 * Gebühren/Konditionen (VEG, Recycl.-Geb., Recycling-Gebühr, Logistik-
 * pauschale, Zu-/Abschläge, sonstige Gebühren) → IMMER Konto 4701
 * (Betriebsmaterial/übrige): nie auf ein Warenkonto (4020–4070) und damit
 * nie in die WKQ; auch nicht auf 4800 (das bleibt Pfand/Leergut/Gebinde).
 */
export const KONTO_GEBUEHR = '4701';

/** Token-genaue Gebühren-Erkennung auf Bezeichnung ODER Warengruppe. */
export function istGebuehrenText(s: string | undefined): boolean {
  if (!s) return false;
  const toks = tokens(s);
  for (const tok of toks) {
    if (tok === 'veg' || tok === 'vrg') return true;          // vorgezogene Entsorgungs-/Recyclinggebühr
    if (/^recycl/.test(tok)) return true;                     // «Recycl.-Geb.», «Recyclinggebühren»
    // «…gebühr(en)» nur am TOKEN-ENDE (Fassgebühr, Recyclinggebühren) —
    // «gebührenfrei» u.ä. Produktnamen-Komposita matchen NICHT.
    // Depotgebühr fängt die Pfand-Regel vorher (istZwingendGebuehr prüft Pfand zuerst).
    if (/geb(ü|ue)hr(en)?$/.test(tok)) return true;
    if (tok === 'logistikpauschale') return true;
    if (/^(zu|ab)schl(ä|ae)g/.test(tok)) return true;         // Warengruppe «Zu-/Abschläge»
  }
  if (toks.includes('logistik') && toks.includes('pauschale')) return true;
  return false;
}

/**
 * Universelle Zwangs-Gebühren-Regel: läuft VOR gelernter Artikel-Zuordnung
 * und vor der Warengruppen-Tabelle — NACH der Pfand-Regel (Pfand hat Vorrang,
 * die beiden Regeln kollidieren nie: was zwingend Pfand ist, ist nie Gebühr).
 */
export function istZwingendGebuehr(
  p: Pick<WarenPosition, 'mwstCode'> & Partial<Pick<WarenPosition, 'bezeichnung' | 'warengruppe'>>,
): boolean {
  if (istZwingendPfand(p)) return false;
  return istGebuehrenText(p.bezeichnung) || istGebuehrenText(p.warengruppe);
}

/**
 * SCHWACHE Kennwörter (Gebinde/Harasse): können auch in normalen Artikel-
 * namen vorkommen (z.B. Bier «10×33 Harass» mit 8.1 % MwSt) — sie schlagen
 * NUR im Zweifel durch, d.h. wenn die Warengruppe keinem Konto zuordenbar
 * ist (dann Depot statt «offen», nie raten).
 */
export function istPfandBezeichnungSchwach(bezeichnung: string | undefined): boolean {
  if (!bezeichnung) return false;
  for (const tok of tokens(bezeichnung)) {
    if (/^gebinde[a-zäöü]*$/.test(tok)) return true;
    if (/^harass(e|en)?$/.test(tok)) return true;
    if (/^container(s)?$/.test(tok)) return true; // z.B. «FGG Container/Fass»
    if (/^f(a|ä)ss(er)?$/.test(tok) || tok === 'fass') return true; // Leer-Fässer (Bier «Lager Fass 20L» bleibt via Warengruppe Bier)
  }
  return false;
}

/** Kombinierte Erkennung (stark ODER schwach) — token-genau, kein blindes
 *  Präfix-Matching mitten in Fremdwörtern («Deposito»/«Harissa»). */
export function istPfandBezeichnung(bezeichnung: string | undefined): boolean {
  return istPfandBezeichnungStark(bezeichnung) || istPfandBezeichnungSchwach(bezeichnung);
}

const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-zäöüéèà0-9]+/).filter(Boolean);

export function kontoFuerPosition(
  p: Pick<WarenPosition, 'warengruppe' | 'mwstCode'> & Partial<Pick<WarenPosition, 'bezeichnung'>>,
  mapping: WarengruppenMapping,
): PositionsKonto {
  if (p.mwstCode === 0) return { konto: null, status: 'pfand' }; // Pfand/Gebinde → neutral/Depot
  if (istPfandBezeichnungStark(p.bezeichnung)) return { konto: null, status: 'pfand' };
  // Pfand-Warengruppe (z.B. «Leergut») schlägt die konfigurierte Tabelle —
  // ein gespeichertes Mapping darf Pfand nie auf 6040/ein Warenkonto routen.
  if (istPfandWarengruppe(p.warengruppe)) return { konto: null, status: 'pfand' };
  // Gebühren/Konditionen → 4701, VOR der Warengruppen-Tabelle (eine
  // gespeicherte 4050-/Warenkonto-Zuordnung darf Gebühren nie überstimmen).
  if (istGebuehrenText(p.bezeichnung) || istGebuehrenText(p.warengruppe)) {
    return { konto: KONTO_GEBUEHR, status: 'zugeordnet' };
  }
  const g = normGruppe(p.warengruppe);
  if (g) {
    const regel = mapping.find(r => normGruppe(r.gruppe) === g);
    if (regel && regel.konto.trim()) return { konto: regel.konto.trim(), status: 'zugeordnet' };
  }
  // Warengruppe keinem Konto zuordenbar: SCHWACHE Kennwörter (Gebinde/Harasse)
  // → im Zweifel Depot statt «offen» (nie auf ein Warenkonto raten).
  if (istPfandBezeichnungSchwach(p.bezeichnung)) return { konto: null, status: 'pfand' };
  return { konto: null, status: 'offen' }; // unbekannt → nachfragen, nicht raten
}

/**
 * Kontierung inkl. gelernter Artikel-Zuordnungen (Vorrang: Pfand > Artikel >
 * Warengruppe). `manuell` markiert Artikel-Treffer, damit die Auto-Zuordnung
 * sie später nicht mehr anfasst.
 */
export function kontoFuerPositionMitArtikel(
  lieferant: string,
  p: Pick<WarenPosition, 'warengruppe' | 'mwstCode' | 'artNr' | 'bezeichnung'>,
  mapping: WarengruppenMapping,
  artikelKonten?: ArtikelKontenMapping,
): PositionsKonto & { manuell?: boolean } {
  // Universelle Pfand-Regel (MwSt 0 / starke Kennwörter / Pfand-Warengruppe)
  // läuft VOR der gelernten Artikel-Zuordnung: Pfand ist IMMER 4800 —
  // eine gespeicherte 6040-/Warenkonto-Zuordnung wird überschrieben.
  if (istZwingendPfand(p)) return { konto: null, status: 'pfand' };
  // Universelle Gebühren-Regel (VEG/Recycling/Logistikpauschale/…): läuft
  // ebenfalls VOR der gelernten Artikel-Zuordnung — eine gespeicherte
  // 4050-/Warenkonto-Zuordnung wird überschrieben (immer 4701).
  if (istZwingendGebuehr(p)) return { konto: KONTO_GEBUEHR, status: 'zugeordnet' };
  const key = artikelKey(lieferant, p);
  const artikel = key ? artikelKonten?.[key] : undefined;
  if (artikel) return { konto: artikel, status: 'zugeordnet', manuell: true };
  return kontoFuerPosition(p, mapping);
}

/** Anzeige-Labels für nicht kontierte Positionen in Splits/Exporten. */
/**
 * Seit 08/2026: Pfand/Leergut/Gebinde wird als ECHTES Konto 4800 gebucht
 * (Gebinde-Verrechnung), nicht mehr als Pseudo-Split «Depot». 4800 bleibt
 * neutral (nie WKQ/direkter Warenaufwand) — siehe istPfandKonto in
 * waren-klassen.ts. Legacy-«Depot»-Splits bleiben gültig.
 */
export const KONTO_LABEL_PFAND = '4800';
export const KONTO_LABEL_OFFEN = 'offen';

/**
 * Netto/MwSt je Konto aggregieren (für kontoSplits).
 * Pfand → Pseudo-Split «Depot», unbekannte Gruppen → «offen»
 * (nicht-numerische Splits zählen in der Kontoklassen-Logik wie bisher
 * als Legacy-Warenkosten — Totale/WKQ bleiben unverändert).
 */
export function kontoSplitsFuerRechnung(
  r: ParsedCsvRechnung,
  mapping: WarengruppenMapping = DEFAULT_WARENGRUPPEN_MAPPING,
  /** Optionale manuelle Overrides je Positions-Index. */
  overrides?: Record<number, string>,
): Array<{ warenkonto: string; amountNet: number; amountGross: number }> {
  const m = new Map<string, { net: number; gross: number }>();
  r.positionen.forEach((p, i) => {
    const ov = overrides?.[i]?.trim();
    const pk = ov ? { konto: ov, status: 'zugeordnet' as const } : kontoFuerPosition(p, mapping);
    const key = pk.status === 'zugeordnet' ? pk.konto! : pk.status === 'pfand' ? KONTO_LABEL_PFAND : KONTO_LABEL_OFFEN;
    const cur = m.get(key) ?? { net: 0, gross: 0 };
    cur.net += p.positionspreis;
    cur.gross += p.positionspreis + p.mwstBetrag;
    m.set(key, cur);
  });
  return [...m.entries()]
    .map(([warenkonto, v]) => ({ warenkonto, amountNet: Math.round(v.net * 100) / 100, amountGross: Math.round(v.gross * 100) / 100 }))
    .sort((a, b) => b.amountNet - a.amountNet);
}

/** Unbekannte Warengruppen einer Rechnungsliste (für den «Konto offen»-Hinweis vor dem Import). */
export function offeneWarengruppen(rechnungen: ParsedCsvRechnung[], mapping: WarengruppenMapping): string[] {
  const set = new Map<string, string>();
  for (const r of rechnungen) for (const p of r.positionen) {
    if (kontoFuerPosition(p, mapping).status === 'offen') {
      const key = normGruppe(p.warengruppe) || '(leer)';
      if (!set.has(key)) set.set(key, p.warengruppe.trim() || '(leer)');
    }
  }
  return [...set.values()].sort((a, b) => a.localeCompare(b, 'de-CH'));
}

export function normalizeWarengruppenMapping(raw: unknown): WarengruppenMapping {
  if (!Array.isArray(raw)) return DEFAULT_WARENGRUPPEN_MAPPING;
  const out: WarengruppenMapping = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const gruppe = typeof (r as WarengruppenRegel).gruppe === 'string' ? (r as WarengruppenRegel).gruppe.trim() : '';
    const konto = typeof (r as WarengruppenRegel).konto === 'string' ? (r as WarengruppenRegel).konto.trim() : '';
    if (gruppe && konto) out.push({ gruppe, konto });
  }
  return out.length > 0 ? out : DEFAULT_WARENGRUPPEN_MAPPING;
}

// ─── Persistierte Rechnungspositionen (pro InvoiceEntry) ─────────────────────

/** Eine gespeicherte Position inkl. Kontierung (manuell überschreibbar). */
export interface GespeichertePosition {
  artNr: string;
  bezeichnung: string;
  warengruppe: string;
  menge: number;
  einheit: string;
  preis: number;           // Einzelpreis netto
  positionspreis: number;  // Netto der Position
  mwstBetrag: number;
  mwstCode: number;
  konto: string | null;    // null = Pfand/offen
  status: PositionsKontoStatus;
  /** true, wenn das Konto manuell überschrieben wurde (Auto-Zuordnung fasst es nicht mehr an). */
  manuell?: boolean;
}
/** Record<invoiceId, Positionen> — pro Monat persistiert. */
export type PositionenProRechnung = Record<string, GespeichertePosition[]>;

export function positionenAusRechnung(
  r: ParsedCsvRechnung,
  mapping: WarengruppenMapping,
  /** Gelernte Artikel-Zuordnungen des Lieferanten (haben Vorrang vor der Warengruppen-Tabelle). */
  artikel?: { lieferant: string; konten: ArtikelKontenMapping },
): GespeichertePosition[] {
  return r.positionen.map(p => {
    const pk = artikel
      ? kontoFuerPositionMitArtikel(artikel.lieferant, p, mapping, artikel.konten)
      : kontoFuerPosition(p, mapping);
    return {
      artNr: p.artNr, bezeichnung: p.bezeichnung, warengruppe: p.warengruppe,
      menge: p.menge, einheit: p.einheit, preis: p.preis,
      positionspreis: p.positionspreis, mwstBetrag: p.mwstBetrag, mwstCode: p.mwstCode,
      konto: pk.konto, status: pk.status,
      ...('manuell' in pk && pk.manuell ? { manuell: true } : {}),
    };
  }).map(erzwingeRegelPosition);
}

/**
 * Zwangs-Pfand auf GESPEICHERTEN Positionen: läuft nach JEDER Kontierungs-
 * Quelle (Auto, gelernte Artikel, übernommene manuelle Alt-Kontierung) —
 * Pfand/Leergut steht IMMER auf 4800, nie auf 6040/einem Warenkonto.
 */
export function erzwingePfandPosition(p: GespeichertePosition): GespeichertePosition {
  if (!istZwingendPfand(p)) return p;
  // Kanonisch normalisieren — auch bereits als «pfand» markierte Altbestände
  // mit gesetztem Konto (z.B. 6040) oder manuell-Flag werden bereinigt.
  if (p.konto === null && p.status === 'pfand' && !p.manuell) return p;
  const { manuell: _m, ...rest } = p;
  void _m;
  return { ...rest, konto: null, status: 'pfand' };
}

/**
 * Zwangs-Gebühr auf GESPEICHERTEN Positionen (analog erzwingePfandPosition):
 * VEG/Recycling/Logistikpauschale/… steht IMMER auf 4701 — auch beim
 * Re-Import und beim manuellen Speichern im Positionen-Dialog. Läuft NACH
 * der Pfand-Regel (istZwingendGebuehr schliesst Pfand aus).
 */
export function erzwingeGebuehrPosition(p: GespeichertePosition): GespeichertePosition {
  if (!istZwingendGebuehr(p)) return p;
  if (p.konto === KONTO_GEBUEHR && p.status === 'zugeordnet' && !p.manuell) return p;
  const { manuell: _m, ...rest } = p;
  void _m;
  return { ...rest, konto: KONTO_GEBUEHR, status: 'zugeordnet' };
}

/** Beide Zwangs-Regeln (Pfand→4800, Gebühr→4701) als EIN Post-Pass. */
export function erzwingeRegelPosition(p: GespeichertePosition): GespeichertePosition {
  return erzwingeGebuehrPosition(erzwingePfandPosition(p));
}

/** kontoSplits aus GESPEICHERTEN Positionen (nach manuellen Overrides) neu ableiten. */
export function kontoSplitsAusPositionen(
  positionen: GespeichertePosition[],
): Array<{ warenkonto: string; amountNet: number; amountGross: number }> {
  const m = new Map<string, { net: number; gross: number }>();
  for (const p of positionen) {
    const key = p.konto && p.konto.trim()
      ? p.konto.trim()
      : p.status === 'pfand' ? KONTO_LABEL_PFAND : KONTO_LABEL_OFFEN;
    const cur = m.get(key) ?? { net: 0, gross: 0 };
    cur.net += p.positionspreis;
    cur.gross += p.positionspreis + p.mwstBetrag;
    m.set(key, cur);
  }
  return [...m.entries()]
    .map(([warenkonto, v]) => ({ warenkonto, amountNet: Math.round(v.net * 100) / 100, amountGross: Math.round(v.gross * 100) / 100 }))
    .sort((a, b) => b.amountNet - a.amountNet);
}

/**
 * Re-Import: manuelle Konto-Overrides aus dem Altbestand übernehmen.
 * Identität einer Position = Art.-Nr. (bevorzugt) bzw. normalisierte
 * Bezeichnung. Nur `manuell`-markierte Alt-Kontierungen überleben; alles
 * andere folgt der (ggf. aktualisierten) Zuordnungstabelle.
 */
export function uebernehmeManuelleKontierung(
  neu: GespeichertePosition[],
  alt: GespeichertePosition[] | undefined,
): GespeichertePosition[] {
  if (!alt || alt.length === 0) return neu;
  const posKey = (p: GespeichertePosition) =>
    p.artNr.trim() ? `nr:${p.artNr.trim().toLowerCase()}` : `name:${p.bezeichnung.trim().toLowerCase().replace(/\s+/g, ' ')}`;
  const manuelle = new Map<string, GespeichertePosition>();
  for (const p of alt) if (p.manuell) manuelle.set(posKey(p), p);
  if (manuelle.size === 0) return neu;
  return neu.map(p => {
    // Bereits manuell kontierte NEUE Positionen (Artikel-Zuordnung/Vorschau-
    // Override) behalten ihre Wahl — die ist aktueller als der Altbestand.
    if (p.manuell) return p;
    const m = manuelle.get(posKey(p));
    return m ? { ...p, konto: m.konto, status: m.status, manuell: true } : p;
  }).map(erzwingeRegelPosition); // Alt-Kontierung darf Pfand/Gebühr nie auf ein Warenkonto zurückholen
}

export function normalizePositionenProRechnung(raw: unknown): PositionenProRechnung {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PositionenProRechnung = {};
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(val)) continue;
    const liste = val.filter((p): p is GespeichertePosition =>
      !!p && typeof p === 'object'
      && typeof (p as GespeichertePosition).bezeichnung === 'string'
      && Number.isFinite((p as GespeichertePosition).positionspreis));
    if (liste.length > 0) out[id] = liste;
  }
  return out;
}

// ─── Preis-Historie & Preisänderungs-Hinweise ────────────────────────────────

/** Letzter erfasster Einzelpreis pro (Lieferant + Artikel-Identität). */
export interface PreisEintrag {
  preis: number;         // Einzelpreis netto
  datum: string;         // YYYY-MM-DD der Rechnung
  name: string;          // Artikelbezeichnung (Anzeige)
  /** Quell-DOKUMENT (docKey `rechnungsNr|datum`) — Re-Import derselben Rechnung vergleicht NICHT neu. */
  rechnungsNr: string;
}
export type PreisHistorie = Record<string, PreisEintrag>;

export interface PreisSchwelle {
  /** Prozent-Schwelle für deutliche Warnung (Default 10). */
  pct: number;
  /** Mindest-Franken-Differenz, darunter kein Hinweis (Default 0.20). */
  minChf: number;
}
export const DEFAULT_PREIS_SCHWELLE: PreisSchwelle = { pct: 10, minChf: 0.2 };

/**
 * Artikel-Identität: Art.-Nr. wenn vorhanden, sonst normalisierte Bezeichnung;
 * beides fehlend → null (kein Hinweis möglich — kein Fehlalarm, Spez. 8).
 */
export function artikelKey(lieferant: string, pos: { artNr: string; bezeichnung: string }): string | null {
  const l = lieferant.trim().toLowerCase();
  if (pos.artNr.trim() !== '') return `${l}|nr:${pos.artNr.trim()}`;
  const name = pos.bezeichnung.trim().toLowerCase().replace(/\s+/g, ' ');
  return name ? `${l}|name:${name}` : null;
}

export interface PreisAenderung {
  key: string;
  artikel: string;
  artNr: string;
  alt: number;
  neu: number;
  diffAbs: number;          // neu − alt
  /** Prozent-Änderung; null wenn alter Preis ≤ 0 (nie durch 0 teilen). */
  diffPct: number | null;
  /** true = |Δ%| ≥ Schwelle → deutliche Warnung. */
  stark: boolean;
  erhoehung: boolean;
  /** Datum des alten Preises ("seit wann"). */
  seit: string;
}

/**
 * Vergleicht die Positionen einer Rechnung mit der Historie.
 * - Pfand/Gebinde (MwSt-Code 0) ausgenommen.
 * - Re-Import derselben Rechnung (gleiche rechnungsNr in der Historie) → kein Vergleich.
 * - Rundungs-Schutz: |Δ CHF| < minChf → kein Hinweis.
 * - Pro Artikel nur EIN Hinweis (erste abweichende Position zählt).
 */
/**
 * Nicht-Produkt-Zeilen von der PREISÜBERWACHUNG ausschliessen (wie Pfand):
 * - Pfand/Gebinde (MwSt-Code 0 / «C0»)
 * - VEG / «VEG EW Glas» (vorgezogene Entsorgungsgebühr)
 * - Recycl.-Geb. / Recyclinggebühr
 * - Logistikpauschale
 * - Zu-/Abschläge (auch als Warengruppe, z. B. Feldschlösschen-Konditionen)
 * Diese Zeilen erzeugen keine Preis-Hinweise und keinen Artikel-Preisverlauf —
 * nur echte Warenpositionen werden überwacht. (Buchhaltung bleibt unberührt.)
 */
export function istGebuehrenPosition(
  p: Pick<WarenPosition, 'bezeichnung' | 'warengruppe' | 'mwstCode'>,
): boolean {
  if (p.mwstCode === 0) return true; // Pfand/Gebinde (C0)
  if ((p.warengruppe ?? '').trim().toLowerCase() === 'zu-/abschläge') return true;
  const b = (p.bezeichnung ?? '').toLowerCase();
  return /(^|[^a-zäöü])veg([^a-zäöü]|$)/.test(b)          // VEG, VEG EW Glas
    || b.includes('vorgezogene entsorgung')
    || b.includes('recycl')                                 // Recycl.-Geb., Recyclinggebühr
    || b.includes('logistikpauschale')
    || /zu-?\s*\/\s*abschl|zuschlag|abschlag/.test(b);
}

export function berechnePreisAenderungen(
  rechnung: ParsedCsvRechnung,
  lieferant: string,
  historie: PreisHistorie,
  schwelle: PreisSchwelle = DEFAULT_PREIS_SCHWELLE,
): PreisAenderung[] {
  const out: PreisAenderung[] = [];
  const gesehen = new Set<string>();
  for (const p of rechnung.positionen) {
    if (istGebuehrenPosition(p)) continue;      // Pfand/Gebinde + Gebühren-/Abschlag-Zeilen
    if (!(p.preis > 0)) continue;               // Gutschriften/0-Preise nicht bewerten
    const key = artikelKey(lieferant, p);
    if (!key || gesehen.has(key)) continue;
    gesehen.add(key);
    const alt = historie[key];
    if (!alt || alt.rechnungsNr === rechnung.docKey) continue; // neu bzw. Re-Import desselben Dokuments
    const diffAbs = Math.round((p.preis - alt.preis) * 100) / 100;
    if (Math.abs(diffAbs) < schwelle.minChf) continue;
    const diffPct = alt.preis > 0 ? Math.round(((p.preis - alt.preis) / alt.preis) * 1000) / 10 : null;
    out.push({
      key, artikel: p.bezeichnung, artNr: p.artNr,
      alt: alt.preis, neu: p.preis, diffAbs, diffPct,
      stark: diffPct !== null && Math.abs(diffPct) >= schwelle.pct,
      erhoehung: diffAbs > 0,
      seit: alt.datum,
    });
  }
  // Deutliche zuerst, Erhöhungen vor Senkungen, dann grösste Abweichung.
  return out.sort((a, b) =>
    Number(b.stark) - Number(a.stark)
    || Number(b.erhoehung) - Number(a.erhoehung)
    || Math.abs(b.diffAbs) - Math.abs(a.diffAbs));
}

/**
 * Historie nach Import fortschreiben (immutable). Dublettensicher:
 * - Gleiche rechnungsNr → Eintrag ERSETZEN (Re-Import verfälscht nichts).
 * - Sonst gewinnt nur ein neueres/gleiches Datum (alte Dateien überschreiben
 *   keinen aktuelleren Preis).
 */
export function aktualisierePreisHistorie(
  historie: PreisHistorie,
  rechnungen: ParsedCsvRechnung[],
  lieferant: string,
): PreisHistorie {
  const next: PreisHistorie = { ...historie };
  for (const r of rechnungen) {
    for (const p of r.positionen) {
      if (istGebuehrenPosition(p) || !(p.preis > 0)) continue;
      const key = artikelKey(lieferant, p);
      if (!key) continue;
      const alt = next[key];
      if (alt && alt.rechnungsNr !== r.docKey && alt.datum > r.datum) continue;
      next[key] = { preis: p.preis, datum: r.datum, name: p.bezeichnung, rechnungsNr: r.docKey };
    }
  }
  return next;
}

/** Tolerante Normalisierung gespeicherter Blobs (nie werfen). */
export function normalizePreisHistorie(raw: unknown): PreisHistorie {
  if (!raw || typeof raw !== 'object') return {};
  const out: PreisHistorie = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const preis = Number(o.preis);
    if (!Number.isFinite(preis) || preis <= 0) continue;
    out[k] = {
      preis,
      datum: typeof o.datum === 'string' ? o.datum : '',
      name: typeof o.name === 'string' ? o.name : '',
      rechnungsNr: typeof o.rechnungsNr === 'string' ? o.rechnungsNr : '',
    };
  }
  return out;
}

export function normalizePreisSchwelle(raw: unknown): PreisSchwelle {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pct = Number(o.pct), minChf = Number(o.minChf);
  return {
    pct: Number.isFinite(pct) && pct >= 0 ? pct : DEFAULT_PREIS_SCHWELLE.pct,
    minChf: Number.isFinite(minChf) && minChf >= 0 ? minChf : DEFAULT_PREIS_SCHWELLE.minChf,
  };
}

// ─── Markt → Lieferant (Transgourmet/Prodega getrennt, konfigurierbar) ───────
// Der Portal-Export mischt Rechnungen mehrerer Märkte in einer Datei. Der
// Lieferant wird pro Rechnung aus der Spalte «Markt» abgeleitet: BGH ist der
// Transgourmet-Abholmarkt, alle Prodega-Märkte (Bern, Moosseedorf, …) gehören
// zu Prodega. Unbekannte Märkte werden NIE geraten → «Lieferant offen».

export type MarktLieferantenMapping = Array<{ markt: string; lieferant: string }>;

export const DEFAULT_MARKT_LIEFERANTEN: MarktLieferantenMapping = [
  { markt: 'BGH', lieferant: 'Transgourmet' },
  { markt: 'Bern', lieferant: 'Prodega' },
  { markt: 'Moosseedorf', lieferant: 'Prodega' },
];

export function normalizeMarktLieferantenMapping(raw: unknown): MarktLieferantenMapping {
  if (!Array.isArray(raw)) return DEFAULT_MARKT_LIEFERANTEN;
  const out: MarktLieferantenMapping = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const markt = String((r as Record<string, unknown>).markt ?? '').trim();
    const lieferant = String((r as Record<string, unknown>).lieferant ?? '').trim();
    if (markt && lieferant) out.push({ markt, lieferant });
  }
  return out.length > 0 ? out : DEFAULT_MARKT_LIEFERANTEN;
}

/**
 * Bestandstreffer für den CSV-Re-Import (Upsert-Schlüssel):
 * Lieferant + Rechnungs-Nr + Datum + MARKT — konsistent zum docKey.
 * Bern und Moosseedorf mappen beide auf «Prodega»; zwei echte Rechnungen mit
 * gleicher kurzer Portal-Nr. am selben Tag dürfen sich NIE überschreiben.
 * Alt-Einträge OHNE markt werden tolerant gematcht (bekommen den Markt beim
 * Update gesetzt — der zweite Markt desselben Tags legt danach neu an).
 */
/**
 * Transgourmet und Prodega sind EIN Firmenverbund: Bar-Rechnungen aus einem
 * Prodega-Markt können in der FIBU als Transgourmet laufen (Nummernkreis
 * 2607…) und werden im Bestand entsprechend umgehängt. Für die Bestands-
 * Erkennung beim Re-Import zählen beide Namen als derselbe Lieferant —
 * die Dokument-Identität bleibt Nr+Datum+Markt.
 */
const TG_FAMILIE = /^(transgourmet|prodega)$/i;
function lieferantPasst(a: string, b: string): boolean {
  const an = a.trim().toLowerCase(), bn = b.trim().toLowerCase();
  if (an === bn) return true;
  return TG_FAMILIE.test(an) && TG_FAMILIE.test(bn);
}

export function findeCsvBestandsTreffer<T extends {
  reference?: string; date: string; supplierName: string; markt?: string;
}>(
  bestand: T[],
  r: { rechnungsNr: string; datum: string; markt: string },
  lieferant: string,
): T | undefined {
  const marktNorm = r.markt.trim().toLowerCase();
  return bestand.find(e => {
    if ((e.reference ?? '').trim().toLowerCase() !== r.rechnungsNr.toLowerCase()) return false;
    if (e.date !== r.datum) return false; // Portal-Nummern werden über Monate wiederverwendet
    const marktExakt = e.markt != null && e.markt.trim().toLowerCase() === marktNorm;
    // Familien-Toleranz NUR bei exakt gleichem Markt — Alt-Einträge ohne Markt
    // brauchen den exakten Lieferanten (Cross-Markt-Kollisionsschutz).
    const lieferantOk = marktExakt
      ? lieferantPasst(e.supplierName, lieferant)
      : e.supplierName.trim().toLowerCase() === lieferant.trim().toLowerCase();
    return lieferantOk && (e.markt == null || marktExakt);
  });
}

/** Lieferant für einen Markt-Wert; null = nicht zugeordnet («Lieferant offen»). */
export function lieferantFuerMarkt(markt: string, mapping: MarktLieferantenMapping): string | null {
  const m = markt.trim().toLowerCase();
  if (!m) return null;
  return mapping.find(r => r.markt.trim().toLowerCase() === m)?.lieferant ?? null;
}

/**
 * Plausibilitäts-Warnung Markt ↔ Rechnungsnummer: BGH/Transgourmet nutzt
 * 8-stellige Nummern (6xxxxxxx), Prodega-Märkte kurze (1–4-stellig).
 * Bei Widerspruch GEWINNT der Markt — aber mit Warnung (kein Blocker).
 */
export function marktNummernWarnung(lieferant: string | null, rechnungsNr: string): string | null {
  if (!lieferant) return null;
  const nr = rechnungsNr.trim();
  const istLang = /^6\d{7}$/.test(nr);
  const istKurz = /^\d{1,4}$/.test(nr);
  if (/transgourmet/i.test(lieferant) && istKurz) {
    return `Rechnungsnr. ${nr} sieht nach Prodega aus (kurz) — Markt sagt Transgourmet. Markt gewinnt, bitte prüfen.`;
  }
  if (/prodega/i.test(lieferant) && istLang) {
    return `Rechnungsnr. ${nr} sieht nach Transgourmet aus (8-stellig) — Markt sagt Prodega. Markt gewinnt, bitte prüfen.`;
  }
  return null;
}
