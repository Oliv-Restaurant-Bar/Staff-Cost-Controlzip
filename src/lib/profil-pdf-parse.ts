/**
 * PDF-Rechnungsparser über Lieferanten-Profile (Mandant Beaulieu).
 *
 * STUFE 1 (alle Lieferanten): Lieferant via MWST-Nr, Rechnungs-Nr, Rechnungs-
 * datum, Netto-Total (exkl. MwSt), MwSt-Betrag/-Satz; Lieferdatum wenn ein
 * Liefer-/LS-Datum im PDF steht, sonst Rechnungsdatum.
 *
 * STUFE 2 (per Profil-Parser): Sammelrechnungen mit mehreren Lieferungen —
 * pro Lieferung mit deren LS-Datum erfassen inkl. Positionen (Artikel, Menge,
 * Einzelpreis, Betrag) für die Preisüberwachung:
 * - spahni:     «LS-Nr. 5201729 vom 19.06.26»
 * - fideco:     «*** LIEFERSCHEIN 7728203 VOM 08.06.26» (deutsches Zahlenformat 3.416,45)
 * - terravigna: «Lieferungsnr. 287319 vom 09.07.26:»
 *
 * Grundsatz: nie raten — was nicht sicher erkannt wird, bleibt leer/null und
 * wird in der Vorschau korrigiert; `hinweise` erklärt, was fehlte.
 */
import type { ParsedCsvRechnung, WarenPosition } from '@/lib/waren-positionen';
import { findeProfilImText, type LieferantenProfil } from '@/lib/lieferanten-profile';

export interface ProfilPdfErgebnis {
  /** Erkanntes Profil (null = «Lieferant offen», via Vorschau zuordnen). */
  profil: LieferantenProfil | null;
  /** Im PDF gefundene fremde MWST-Nrn (für die manuelle Zuordnung). */
  mwstNrn: string[];
  rechnungsNr: string | null;
  rechnungsdatum: string | null;   // YYYY-MM-DD
  /** Liefer-/LS-Datum, wenn EIN eindeutiges im PDF steht (Einzellieferung). */
  lieferdatum: string | null;
  netto: number | null;
  mwst: number | null;
  mwstSatz: number | null;
  brutto: number | null;
  /** Stufe 2: eine ParsedCsvRechnung pro Lieferung (LS-Datum als datum). */
  lieferungen: ParsedCsvRechnung[];
  /** true = echte Positionen erkannt (Preisüberwachung möglich). */
  positionenErkannt: boolean;
  /** Belegart-Sperre (gilt für ALLE Lieferanten): nur 'rechnung' ist buchbar.
   *  Auftragsbestätigungen/Offerten/Bestellungen werden erkannt, NIE gebucht. */
  belegart: 'rechnung' | 'auftragsbestaetigung' | 'offerte' | 'bestellung';
  /**
   * INHALTSBASIERTER Dokumenttyp für Dual-Lieferanten (Belegüberschrift):
   * 'monatsrechnung' = «Sammelrechnung»/«Monatsrechnung» im Kopf (massgeblich/
   * final), 'lieferschein' = «Lieferschein»-Überschrift bzw. AB/Offerte/
   * Bestellung (provisorisch), null = kein eindeutiges Signal — dann darf der
   * Aufrufer `lieferungen.length` NUR als Zusatzsignal zusammen mit
   * belegart==='rechnung' verwenden, nie allein.
   */
  dokumenttyp: 'monatsrechnung' | 'lieferschein' | null;
  hinweise: string[];
}

/** Belegart aus der Belegüberschrift: «Rechnung» vs «(Verkauf) Auftrags-
 *  bestätigung» / «Offerte»/«Angebot» / «Bestellung». Ein expliziter
 *  Rechnungs-Kopf («Rechnung <Nr>» o.ä.) gewinnt immer — Zahlungs-/Fusstexte
 *  dürfen die Sperre nicht auslösen. */
export function erkenneBelegart(text: string): ProfilPdfErgebnis['belegart'] {
  const bewerte = (t: string): ProfilPdfErgebnis['belegart'] | null => {
    const hatRechnungsKopf =
      /(?:^|\n)[^\n]{0,60}\bRECHNUNG(?:\b|\s*[:.]|s?-?\s*(?:Nr|nummer))/i.test(t) ||
      /\bRechnung\s+(?:Nr\.?\s*)?\d{3,}/i.test(t) ||
      /\bFaktura\b/i.test(t);
    if (hatRechnungsKopf) return 'rechnung';
    if (/Auftragsbest(?:ä|ae)tigung/i.test(t)) return 'auftragsbestaetigung';
    if (/\b(?:Offerte|Angebot)\b/i.test(t)) return 'offerte';
    if (/(?:^|\n)\s*(?:Verkauf\s+)?Bestellung\b/i.test(t)) return 'bestellung';
    return null;
  };
  // KOPFZONE zuerst: die Belegüberschrift entscheidet. Eine AB/Offerte mit
  // «Rechnung» nur im Fuss-/Zahltext darf NICHT als Rechnung buchbar werden.
  // Ohne jedes Kopf-Signal (Layout-Sonderfälle) zählt der Gesamttext wie bisher.
  return bewerte(kopfzone(text)) ?? bewerte(text) ?? 'rechnung';
}

/**
 * Dokumenttyp aus der Belegüberschrift/Kopfzone (erste Zeilen des PDFs):
 * «Sammelrechnung»/«Monatsrechnung» → Monatsrechnung (final); eine
 * «Lieferschein»-ÜBERSCHRIFT (nicht «LS-Nr. …»-Blockmarker!) bzw. eine
 * Nicht-Rechnung (AB/Offerte/Bestellung) → provisorischer Lieferschein.
 * Kein Signal → null (Aufrufer entscheidet mit Zusatzsignalen).
 */
/** Kopfzone: die ersten ~25 nicht-leeren Zeilen (Belegüberschrift steht oben;
 *  Fusstexte/Zahlteil dürfen Typ/Belegart nicht bestimmen). */
function kopfzone(text: string): string {
  return text.split('\n').map(z => z.trim()).filter(Boolean).slice(0, 25).join('\n');
}

export function erkenneDokumenttyp(
  text: string,
  belegart: ProfilPdfErgebnis['belegart'],
): ProfilPdfErgebnis['dokumenttyp'] {
  const kopf = kopfzone(text);
  // Auch Kombiformen wie «Sammel-/Monatsrechnung» oder «Sammel- bzw. Monatsrechnung».
  if (/\b(?:Sammel|Monats)-?(?:\s*\/\s*|\s)?(?:Monats-?\s?)?rechnung\b/i.test(kopf)) return 'monatsrechnung';
  if (belegart !== 'rechnung') return 'lieferschein';
  // «Lieferschein» als eigenständige Überschrift (Zeilenanfang, kein «LS-Nr.»
  // und keine Kombis wie «Liefersch./Kd.-Nr.» aus Positionszeilen).
  if (/(?:^|\n)\s*Lieferschein\b(?!\s*[\/.])/i.test(kopf) && !/\bRechnung\b/i.test(kopf)) return 'lieferschein';
  return null;
}

const BELEGART_LABEL: Record<Exclude<ProfilPdfErgebnis['belegart'], 'rechnung'>, string> = {
  auftragsbestaetigung: 'Auftragsbestätigung',
  offerte: 'Offerte/Angebot',
  bestellung: 'Bestellung',
};

// ─── Zahlen / Daten ───────────────────────────────────────────────────────────

/** CH/DE-Betrag: 3'796.25 · 2’339.69 · 3.416,45 · 88,85 · 584.40 · 1'419.90 */
export function parseBetrag(s: string): number | null {
  let t = s.replace(/[’'′`\s]/g, '').replace(/CHF/gi, '').trim();
  if (!t) return null;
  const neg = /^-/.test(t) || /-$/.test(t);
  t = t.replace(/[+-]/g, '');
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // letztes Trennzeichen = Dezimaltrenner
    t = lastComma > lastDot
      ? t.replace(/\./g, '').replace(',', '.')
      : t.replace(/,/g, '');
  } else if (lastComma >= 0) {
    t = t.replace(',', '.');
  } else if (lastDot >= 0 && t.length - lastDot - 1 === 3 && t.length > 4) {
    // «3.416» ohne Nachkommastellen wäre mehrdeutig — bei Beträgen mit
    // Rappen (unser Fall) kommt das nicht vor; Punkt hier als Dezimal belassen.
  }
  const n = Number(t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** dd.mm.yy(yy) → YYYY-MM-DD (yy ⇒ 20yy). */
export function parseDatumCH(s: string): string | null {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})/.exec(s);
  if (!m) return null;
  const [, d, mo, y] = m;
  const jahr = y.length === 2 ? 2000 + Number(y) : Number(y);
  const dd = Number(d), mm = Number(mo);
  if (jahr < 2000 || jahr > 2099 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${jahr}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

const BETRAG_RE = /-?[\d’'.,]+\d/;

function suche(text: string, res: RegExp[]): string | null {
  for (const re of res) {
    const m = re.exec(text);
    if (m) return (m[1] ?? m[0]).trim();
  }
  return null;
}

function sucheBetrag(text: string, res: RegExp[]): number | null {
  const s = suche(text, res);
  return s === null ? null : parseBetrag(s);
}

// ─── Stufe-2-Positionsparser ─────────────────────────────────────────────────

interface LieferungBlock { nr: string; datum: string; zeilen: string[] }

/** Text in Lieferungs-Blöcke teilen (Header-Regex mit Gruppen nr, datum). */
function teileInBloecke(lines: string[], header: RegExp): { vorlauf: string[]; bloecke: LieferungBlock[] } {
  const bloecke: LieferungBlock[] = [];
  const vorlauf: string[] = [];
  let aktuell: LieferungBlock | null = null;
  for (const line of lines) {
    const m = header.exec(line);
    if (m) {
      const datum = parseDatumCH(m[2] ?? '');
      if (datum) { aktuell = { nr: m[1], datum, zeilen: [] }; bloecke.push(aktuell); continue; }
    }
    if (aktuell) aktuell.zeilen.push(line); else vorlauf.push(line);
  }
  return { vorlauf, bloecke };
}

function rundung2(n: number): number { return Math.round(n * 100) / 100; }

function baueLieferung(
  lieferant: string, nr: string, datum: string, positionen: WarenPosition[], mwstSatz: number,
): ParsedCsvRechnung {
  const nettoTotal = rundung2(positionen.reduce((s, p) => s + p.positionspreis, 0));
  const mwstTotal = rundung2(positionen.reduce((s, p) => s + p.mwstBetrag, 0));
  return {
    docKey: `${nr}|${datum}|${lieferant}`,
    rechnungsNr: nr, datum, markt: lieferant, positionen,
    nettoTotal, mwstTotal, bruttoTotal: rundung2(nettoTotal + mwstTotal),
  };
}

function position(
  kategorie: string, mwstSatz: number,
  p: { artNr: string; bezeichnung: string; menge: number; einheit: string; preis: number; positionspreis: number },
): WarenPosition {
  return {
    artNr: p.artNr, bezeichnung: p.bezeichnung, warengruppe: kategorie,
    menge: p.menge, einheit: p.einheit, preis: p.preis, positionspreis: rundung2(p.positionspreis),
    mwstBetrag: rundung2(p.positionspreis * mwstSatz / 100), mwstCode: 1,
  };
}

/** Spahni: «01250  Rindsentrecôte   6.000 KG  43.10  [Rab]  258.60 1» */
function parseSpahniLieferungen(lines: string[], profil: LieferantenProfil, mwstSatz: number): ParsedCsvRechnung[] {
  let { bloecke } = teileInBloecke(lines, /LS-Nr\.\s*(\d+)\s+vom\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i);
  // Einzel-Lieferschein-Layout: keine «LS-Nr. … vom …»-Blöcke, dafür
  // «Liefersch./Kd.-Nr. : <LS-Nr> / XBEA» + «Lieferdatum» → EIN Block übers Ganze.
  if (bloecke.length === 0) {
    const text = lines.join('\n');
    const ls = /Liefersch\.?\s*\/?\s*Kd\.-?Nr\.?\s*:?\s*(\d{4,10})\s*\/\s*\w+/i.exec(text);
    const datum = /Lieferdatum\s*:?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i.exec(text);
    const iso = datum ? parseDatumCH(datum[1]) : null;
    if (ls && iso) bloecke = [{ nr: ls[1], datum: iso, zeilen: lines }];
  }
  const zeileRe = /^\s*([A-Z]?\d{4,6})\s+(.+?)\s+(-?[\d’'.,]+)\s+(KG|STK?|PC|LT)\b\s+([\d’'.,]+)\s+(?:([\d’'.,]+)\s+)?(-?[\d’'.,]+)\s+(\d)\s*$/i;
  return bloecke.map(b => {
    const positionen: WarenPosition[] = [];
    for (const z of b.zeilen) {
      const m = zeileRe.exec(z);
      if (!m) continue;
      const menge = parseBetrag(m[3]) ?? 0;
      const preis = parseBetrag(m[5]) ?? 0;
      const total = parseBetrag(m[7]) ?? 0;
      positionen.push(position(profil.kategorie, mwstSatz,
        { artNr: m[1], bezeichnung: m[2].trim(), menge, einheit: m[4].toUpperCase(), preis, positionspreis: total }));
    }
    return baueLieferung(profil.name, b.nr, b.datum, positionen, mwstSatz);
  }).filter(l => l.positionen.length > 0);
}

/** Fideco: «4851  TK *Rindsentrecôte…  10,470 KG  29,90 CHF  313,05 CHF  1» */
function parseFidecoLieferungen(lines: string[], profil: LieferantenProfil, mwstSatz: number): ParsedCsvRechnung[] {
  const { vorlauf, bloecke } = teileInBloecke(lines, /LIEFERSCHEIN\s+(\d+)\s+VOM\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i);
  const zeileRe = /^\s*([A-Z]?\d{3,6})\s+(.+?)\s+(-?[\d.,]+)\s+(KG|STK|PC)\b\s+(-?[\d.,]+)\s*CHF\s+(-?[\d.,]+)\s*CHF\s+(\d)\s*$/i;
  const parseZeilen = (zeilen: string[]) => {
    const positionen: WarenPosition[] = [];
    for (const z of zeilen) {
      const m = zeileRe.exec(z);
      if (!m) continue;
      positionen.push(position(profil.kategorie, mwstSatz, {
        artNr: m[1], bezeichnung: m[2].trim(), menge: parseBetrag(m[3]) ?? 0,
        einheit: m[4].toUpperCase(), preis: parseBetrag(m[5]) ?? 0, positionspreis: parseBetrag(m[6]) ?? 0,
      }));
    }
    return positionen;
  };
  const out = bloecke
    .map(b => baueLieferung(profil.name, b.nr, b.datum, parseZeilen(b.zeilen), mwstSatz))
    .filter(l => l.positionen.length > 0);
  // GUTSCHRIFT-Block vor dem ersten Lieferschein: als eigene (negative) Position
  // der ERSTEN Lieferung zuschlagen, damit das Total stimmt.
  const gutschriftIdx = vorlauf.findIndex(z => /GUTSCHRIFT\s*:?\s*\d+/i.test(z));
  if (gutschriftIdx >= 0 && out.length > 0) {
    const gPos = parseZeilen(vorlauf.slice(gutschriftIdx + 1));
    if (gPos.length > 0) {
      const erste = out[0];
      const positionen = [...gPos.map(p => ({ ...p, bezeichnung: `Gutschrift: ${p.bezeichnung}` })), ...erste.positionen];
      out[0] = baueLieferung(profil.name, erste.rechnungsNr, erste.datum, positionen, mwstSatz);
    }
  }
  return out;
}

/** Terravigna: «1  21111-24-075  12 75 cl  14.50  15  147.90» (Folgezeile = Weinname). */
function parseTerravignaLieferungen(lines: string[], profil: LieferantenProfil, mwstSatz: number): ParsedCsvRechnung[] {
  const { bloecke } = teileInBloecke(lines, /Lieferungsnr\.\s*(\d+)\s+vom\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i);
  // Betrag MUSS Rappen haben (x.xx) — schützt vor QR-Zahlteil-Referenzzeilen.
  const zeileRe = /^\s*\d{1,3}\s+(\d[\w-]*)\s+(\d+)\s+(.+?)\s+([\d’'.,]+)\s+(?:(\d{1,2})\s+)?(-?[\d’',]*\d[.,]\d{2})\s*$/;
  return bloecke.map(b => {
    const positionen: WarenPosition[] = [];
    for (let i = 0; i < b.zeilen.length; i++) {
      const m = zeileRe.exec(b.zeilen[i]);
      if (!m) continue;
      const menge = Number(m[2]);
      const betrag = parseBetrag(m[6]) ?? 0;
      // Effektiver Netto-Stückpreis (nach Rabatt) für die Preisüberwachung.
      const preis = menge > 0 ? rundung2(betrag / menge) : 0;
      const naechste = (b.zeilen[i + 1] ?? '').trim();
      const bezeichnung = naechste && !zeileRe.test(b.zeilen[i + 1]) && !/^Lieferungsnr\./i.test(naechste)
        ? naechste : m[1];
      positionen.push(position(profil.kategorie, mwstSatz,
        { artNr: m[1], bezeichnung, menge, einheit: m[3].trim(), preis, positionspreis: betrag }));
    }
    return baueLieferung(profil.name, b.nr, b.datum, positionen, mwstSatz);
  }).filter(l => l.positionen.length > 0);
}

// ─── Kopf-Erkennung pro Profil ───────────────────────────────────────────────

interface KopfFelder {
  rechnungsNr: string | null;
  rechnungsdatum: string | null;
  lieferdatum: string | null;
  netto: number | null;
  mwst: number | null;
  mwstSatz: number | null;
}

function generischerKopf(text: string): KopfFelder {
  const rechnungsNr = suche(text, [
    /Rechnung[s]?-?\s?(?:Nr|nummer)\.?\s*:?\s*([A-Z]?\d{3,12})/i,
    /RECHNUNG\s*:?\s*(\d{3,12})/i,
    /Faktura\s+(\d{3,12})/i,
  ]);
  const rechnungsdatum = parseDatumCH(suche(text, [
    /Rechnungsdatum\s*:?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
    /Belegdatum\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
    /\bDatum\s*:?\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
    /(\d{1,2}\.\d{1,2}\.\d{4})/,
  ]) ?? '');
  const netto = sucheBetrag(text, [
    new RegExp(`(?:Gesamtbetrag|Total)[^\\n]*(?:exkl\\.|ohne)\\s*MwSt\\.?(?:\\s*CHF)?\\s*(${BETRAG_RE.source})`, 'i'),
    new RegExp(`Zwischensumme ohne MwSt\\s*CHF\\s*(${BETRAG_RE.source})`, 'i'),
    new RegExp(`Warenwert\\s+(${BETRAG_RE.source})(?:\\s*CHF)?`, 'i'),
  ]);
  const mwst = sucheBetrag(text, [
    new RegExp(`MwSt\\.?\\s*CHF\\s*(${BETRAG_RE.source})`, 'i'),
    new RegExp(`MwSt\\.?\\s+[\\d.]+\\s*%\\s*von\\s+[\\d’'.,]+\\s+(?:CHF\\s+)?(${BETRAG_RE.source})`, 'i'),
  ]);
  const satzS = suche(text, [/(\d{1,2}[.,]\d{1,2})\s*%/]);
  const mwstSatz = satzS ? parseBetrag(satzS) : null;
  return { rechnungsNr, rechnungsdatum, lieferdatum: null, netto, mwst, mwstSatz };
}

/** Satz aus netto/mwst ableiten und auf bekannte CH-Sätze runden. */
function satzAusBetraegen(netto: number | null, mwst: number | null): number | null {
  if (!netto || netto <= 0 || mwst === null) return null;
  const roh = (mwst / netto) * 100;
  for (const s of [0, 2.6, 3.8, 8.1]) if (Math.abs(roh - s) < 0.35) return s;
  return Math.round(roh * 10) / 10;
}

type KopfParser = (text: string, lines: string[]) => KopfFelder;

const KOPF_PARSER: Record<string, KopfParser> = {
  obrist: (text) => ({
    ...generischerKopf(text),
    rechnungsNr: suche(text, [/Rechnung-?Nr\.?\s*:?\s*(\d{3,10})/i]),
    netto: sucheBetrag(text, [new RegExp(`Zwischensumme ohne MwSt\\s*CHF\\s*(${BETRAG_RE.source})`, 'i')]),
    mwst: sucheBetrag(text, [new RegExp(`MwSt\\.\\s*CHF\\s*(${BETRAG_RE.source})`, 'i')]),
  }),
  rutishauser: (text) => {
    const g = generischerKopf(text);
    // «MWST B7 = 8.10 % von 584.40 47.34» — Satz≠0-Zeilen summieren.
    let netto = 0, mwst = 0, gefunden = false;
    const re = /MWST\s+\S+\s*=\s*([\d.]+)\s*%\s*von\s+([\d’'.,]+)\s+([\d’'.,]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const n = parseBetrag(m[2]) ?? 0;
      if ((parseBetrag(m[1]) ?? 0) > 0 && n > 0) { netto += n; mwst += parseBetrag(m[3]) ?? 0; gefunden = true; }
    }
    const ls = /Lieferscheinnummer\/Datum\s*\n?\s*(\d+)\s*\/\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i.exec(text);
    return {
      ...g,
      rechnungsNr: suche(text, [/Rechnung\s*(?:Nr\.?|nummer)?\s*:?\s*(\d{5,12})/i]) ?? g.rechnungsNr,
      lieferdatum: ls ? parseDatumCH(ls[2]) : null,
      netto: gefunden ? rundung2(netto) : g.netto,
      mwst: gefunden ? rundung2(mwst) : g.mwst,
      mwstSatz: 8.1,
    };
  },
  terravigna: (text) => ({
    ...generischerKopf(text),
    rechnungsNr: suche(text, [/Rechnung\s+(\d{4,10})/i]),
    rechnungsdatum: parseDatumCH(suche(text, [/Belegdatum\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? ''),
    netto: sucheBetrag(text, [new RegExp(`Total\\s*CHF\\s*ohne\\s*MwSt\\.?\\s+(${BETRAG_RE.source})`, 'i')]),
    mwst: sucheBetrag(text, [new RegExp(`[\\d.]+\\s*%\\s*MwSt\\.?\\s+(${BETRAG_RE.source})`, 'i')]),
    mwstSatz: 8.1,
  }),
  spahni: (text) => {
    const g = generischerKopf(text);
    // Einzel-Lieferschein: «Liefersch./Kd.-Nr. : 5210840 / XBEA» + «Lieferdatum».
    const ls = /Liefersch\.?\s*\/?\s*Kd\.-?Nr\.?\s*:?\s*(\d{4,10})\s*\/\s*\w+/i.exec(text);
    const lieferdatum = parseDatumCH(suche(text, [/Lieferdatum\s*:?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? '');
    return {
      ...g,
      rechnungsNr: suche(text, [/RECHNUNG\s*:?\s*(\d{4,10})/i]) ?? (ls ? ls[1] : null),
      lieferdatum: lieferdatum ?? g.lieferdatum,
      // «Total CHF 3'796.25» (netto) und «1 MWST 2.60 % 98.70»
      netto: sucheBetrag(text, [new RegExp(`Total\\s*CHF\\s+(${BETRAG_RE.source})\\s*$`, 'im')]),
      mwst: sucheBetrag(text, [new RegExp(`MWST\\s+[\\d.]+\\s*%\\s+(${BETRAG_RE.source})\\s*$`, 'im')]),
      mwstSatz: 2.6,
    };
  },
  fideco: (text) => {
    const g = generischerKopf(text);
    // «MwSt.-Kz. 1: Netto 2.60% 3.416,45 CHF MwSt. 2.60% 88,85 CHF» — Kz-Zeilen summieren.
    let netto = 0, mwst = 0, gefunden = false;
    const re = /MwSt\.-Kz\.\s*\d+\s*:\s*Netto\s+[\d.,]+%\s+([\d.,]+)\s*CHF\s+MwSt\.\s+[\d.,]+%\s+([\d.,]+)\s*CHF/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      netto += parseBetrag(m[1]) ?? 0; mwst += parseBetrag(m[2]) ?? 0; gefunden = true;
    }
    return {
      ...g,
      rechnungsNr: suche(text, [/RECHNUNG\s+Nr\.\s*(\d{4,10})/i]),
      netto: gefunden ? rundung2(netto) : g.netto,
      mwst: gefunden ? rundung2(mwst) : g.mwst,
      mwstSatz: 2.6,
    };
  },
  gourmador: (text) => ({
    ...generischerKopf(text),
    rechnungsNr: (suche(text, [/Faktura\s+0*(\d{4,12})/i]) ?? '').replace(/^0+/, '') || null,
    netto: sucheBetrag(text, [new RegExp(`Gesamtbetrag exkl\\. MwSt\\.\\s*CHF\\s*(${BETRAG_RE.source})`, 'i')]),
    mwst: sucheBetrag(text, [new RegExp(`MwSt\\.\\s+[\\d.]+\\s*%\\s*von\\s+[\\d’'.,]+\\s+CHF\\s+(${BETRAG_RE.source})`, 'i')]),
    mwstSatz: 2.6,
  }),
  bohnenblust: (text) => {
    const g = generischerKopf(text);
    // Nettobetrags-Rechnung: Summe der «Lieferschein/Nachlieferung … Total x.xx»-Blöcke = netto.
    let netto = 0, gefunden = false;
    const re = /(?:Lieferschein|Nachlieferung)\s+Nr\.\s*\d+\s+vom\s+\d{1,2}\.\d{1,2}\.\d{2,4}\s+Total\s+([\d’'.,]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) { netto += parseBetrag(m[1]) ?? 0; gefunden = true; }
    // «2.6% MwSt. aus Betrag von CHF 823.37   CHF 21.41»
    const zeile = /([\d.,]+)\s*%\s*MwSt\.?\s+aus\s+Betrag\s+von\s+CHF\s+([\d’'.,]+)\s+CHF\s+([\d’'.,]+)/i.exec(text);
    const expl = zeile ? parseBetrag(zeile[2]) : null;
    const mwst = zeile ? parseBetrag(zeile[3]) : null;
    return {
      ...g,
      rechnungsNr: suche(text, [/Rechnungsnummer\s*:?\s*(\d{3,10})/i]),
      netto: expl ?? (gefunden ? rundung2(netto) : g.netto),
      mwst: mwst ?? g.mwst,
      mwstSatz: 2.6,
    };
  },
  gasser: (text) => {
    const g = generischerKopf(text);
    // Totalzeile unter «MwSt-Satz  Belegbetrag  Porto  MwSt CHF  Total»:
    // «2.60  1'419.90  [Porto]  36.90  1'456.80» — Belegbetrag = netto.
    const m = /MwSt-Satz\s+Belegbetrag[^\n]*\n\s*([\d.,]+)\s+([\d’'.,]+)\s+(?:([\d’'.,]+)\s+)?([\d’'.,]+)\s+([\d’'.,]+)/i.exec(text);
    return {
      ...g,
      rechnungsNr: suche(text, [/\bF?0*(\d{6,8})\b\s*$/m, /Rechnung\s+(?:Nr\.?\s*)?F?0*(\d{5,10})/i]) ?? g.rechnungsNr,
      rechnungsdatum: parseDatumCH(suche(text, [/Rechnungsdatum\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? '') ?? g.rechnungsdatum,
      netto: m ? parseBetrag(m[2]) : g.netto,
      mwst: m ? parseBetrag(m[4]) : g.mwst,
      mwstSatz: m ? parseBetrag(m[1]) : g.mwstSatz,
    };
  },
  blaser: (text) => {
    const g = generischerKopf(text);
    // «Warenwert  Nettowert  MWST  MWST-Betrag  MWST-Total  Total» + Wertzeile
    const m = /Warenwert\s+Nettowert[^\n]*\n\s*([\d’'.,]+)\s+([\d’'.,]+)\s+([\d.,]+)\s*%\s+([\d’'.,]+)\s+([\d’'.,]+)/i.exec(text);
    return {
      ...g,
      rechnungsNr: suche(text, [/Rechnung(?:s-Nr\.?)?\s+(\d{5,10})/i]),
      rechnungsdatum: parseDatumCH(suche(text, [/Rechnungsdatum\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? '') ?? g.rechnungsdatum,
      netto: m ? parseBetrag(m[2]) : g.netto,
      mwst: m ? parseBetrag(m[4]) : g.mwst,
      mwstSatz: m ? parseBetrag(m[3]) : g.mwstSatz,
    };
  },
  hofamstutz: (text) => {
    const g = generischerKopf(text);
    const total = sucheBetrag(text, [new RegExp(`Rechnungstotal\\s*\\n?\\s*(${BETRAG_RE.source})`, 'i')]);
    // Lieferdaten aus den Zeilen «11.07.26  Freilandeier … geliefert»
    return {
      ...g,
      rechnungsNr: suche(text, [/Rechnung\s+Nr\.\s*(\d{2,8})/i]),
      netto: total, mwst: 0, mwstSatz: 0,
    };
  },
};

const LIEFERUNG_PARSER: Record<string, (lines: string[], p: LieferantenProfil, satz: number) => ParsedCsvRechnung[]> = {
  spahni: parseSpahniLieferungen,
  fideco: parseFidecoLieferungen,
  terravigna: parseTerravignaLieferungen,
};

// ─── Hauptfunktion ───────────────────────────────────────────────────────────

export function parseProfilPdf(text: string, profile: LieferantenProfil[]): ProfilPdfErgebnis {
  const lines = text.split('\n');
  const { profil, mwstNrn } = findeProfilImText(text, profile);
  const hinweise: string[] = [];
  const belegart = erkenneBelegart(text);
  const kopfFn = profil ? KOPF_PARSER[profil.id] : undefined;
  const kopf = kopfFn ? kopfFn(text, lines) : generischerKopf(text);
  let { netto, mwst } = kopf;
  let mwstSatz = kopf.mwstSatz ?? satzAusBetraegen(netto, mwst) ?? profil?.mwstSatz ?? null;
  if (netto !== null && mwst === null && mwstSatz !== null) mwst = rundung2(netto * mwstSatz / 100);
  if (netto === null && mwst !== null && mwstSatz) netto = rundung2(mwst / (mwstSatz / 100));

  // Stufe 2: Positionen je Lieferung (wo Profil-Parser vorhanden)
  let lieferungen: ParsedCsvRechnung[] = [];
  if (profil?.parser && mwstSatz !== null) {
    try { lieferungen = LIEFERUNG_PARSER[profil.parser](lines, profil, mwstSatz); }
    catch { hinweise.push('Positionen konnten nicht gelesen werden — Kopf-Buchung als Ganzes.'); }
  }
  const positionenErkannt = lieferungen.length > 0;
  if (positionenErkannt && netto !== null) {
    const summe = rundung2(lieferungen.reduce((s, l) => s + l.nettoTotal, 0));
    if (Math.abs(summe - netto) > 0.05) {
      hinweise.push(`Positionssumme ${summe.toFixed(2)} ≠ Rechnungs-Netto ${netto.toFixed(2)} — bitte prüfen.`);
    }
  }

  // Eindeutiges Lieferdatum (Einzellieferung): genau EIN LS-Datum im PDF.
  let lieferdatum = kopf.lieferdatum;
  if (!lieferdatum && positionenErkannt && lieferungen.length === 1) lieferdatum = lieferungen[0].datum;

  // Belegart-Sperre: Nicht-Rechnungen werden NIE gebucht — AUSNAHME:
  // Profile mit «Auftragsbestätigung = Lieferschein» (z.B. Terravigna) buchen
  // die AB als PROVISORISCHE Lieferung; die Monatsrechnung ersetzt sie später.
  let rechnungsNr = kopf.rechnungsNr;
  const abBuchbar = belegart === 'auftragsbestaetigung' && profil?.abAlsLieferschein === true;
  if (belegart !== 'rechnung' && !abBuchbar) {
    rechnungsNr = rechnungsNr
      ?? suche(text, [/(?:Auftragsbest(?:ä|ae)tigung|Offerte|Angebot|Bestellung)\s*(?:Nr\.?\s*)?:?\s*(\d{3,12})/i]);
    hinweise.length = 0;
    hinweise.push(`${BELEGART_LABEL[belegart]} ${rechnungsNr ?? ''} — keine Rechnung, wird nicht gebucht`.replace(/\s+—/, ' —'));
  } else {
    if (abBuchbar) {
      rechnungsNr = rechnungsNr
        ?? suche(text, [/Auftragsbest(?:ä|ae)tigung\s*(?:Nr\.?\s*)?:?\s*(\d{3,12})/i]);
      hinweise.push('Auftragsbestätigung — wird als provisorische Lieferung gebucht; die Monatsrechnung ersetzt/korrigiert sie.');
    }
    if (!profil) hinweise.push('Lieferant nicht erkannt — bitte in der Vorschau zuordnen (wird dauerhaft gespeichert).');
    if (netto === null) hinweise.push('Netto-Betrag nicht erkannt — bitte in der Vorschau erfassen.');
    if (!rechnungsNr) hinweise.push('Rechnungs-Nr nicht erkannt.');
    if (!kopf.rechnungsdatum) hinweise.push('Rechnungsdatum nicht erkannt.');
  }

  return {
    profil, mwstNrn,
    rechnungsNr,
    rechnungsdatum: kopf.rechnungsdatum,
    lieferdatum,
    netto, mwst, mwstSatz,
    brutto: netto !== null && mwst !== null ? rundung2(netto + mwst) : null,
    lieferungen, positionenErkannt, belegart,
    dokumenttyp: erkenneDokumenttyp(text, belegart),
    hinweise,
  };
}
