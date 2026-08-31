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

/** Gedruckte, prüfbare MwSt-Zusammenfassung einer Rechnung. */
export interface MwstKlasse {
  satz: number;
  basis: number;
  betrag: number;
}

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
  /**
   * Gedruckte MwSt-Klassen. Bei gemischten Sätzen ist dies die autoritative
   * Darstellung; `mwstSatz` bleibt bewusst null und darf nie ein Mittelwert sein.
   */
  mwstKlassen: MwstKlasse[];
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
  if (/(?:^|\n)\s*Lieferschein\b(?!\s*[/.])/i.test(kopf) && !/\bRechnung\b/i.test(kopf)) return 'lieferschein';
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

/**
 * Spahni-Kopfzeile «Lieferdatum : Di 04.08.26 / 201»: optionaler WOCHENTAG
 * (explizit nur Mo–So, nie beliebige Tokens oder Monatsnamen wie «Mai») vor
 * dem Datum; «/ <Code>» dahinter wird ignoriert. Kein Fund → kein Datum.
 */
const SPAHNI_LIEFERDATUM_RE =
  /Lieferdatum\s*:?\s*(?:(?:Mo|Di|Mi|Do|Fr|Sa|So)\.?\s+)?(\d{1,2}\.\d{1,2}\.\d{2,4})/i;

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
    mwstBetrag: rundung2(p.positionspreis * mwstSatz / 100),
    mwstCode: mwstSatz === 0 ? 0 : mwstSatz === 2.6 ? 1 : 2,
    ...(mwstSatz === 0 || mwstSatz === 2.6 || mwstSatz === 8.1 ? { mwstSatz } : {}),
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
    // Optionaler Wochentag («Di 04.08.26 / 201») vor dem Datum zulassen.
    const datum = SPAHNI_LIEFERDATUM_RE.exec(text);
    const iso = datum ? parseDatumCH(datum[1]) : null;
    if (ls && iso) bloecke = [{ nr: ls[1], datum: iso, zeilen: lines }];
  }
  // Optionale Spalten zwischen Preis und Totalpreis: Rabatt-BETRAG (Zahl)
  // und/oder Rabatt-KÜRZEL (einzelner Buchstabe, z.B. «A») — beide zulassen,
  // sonst werden Rabatt-Positionen verschluckt (Σ Positionen ≠ Netto).
  const zeileRe = /^\s*([A-Z]?\d{4,6})\s+(.+?)\s+(-?[\d’'.,]+)\s+(KG|STK?|PC|LT)\b\s+([\d’'.,]+)\s+(?:([\d’'.,]+)\s+)?(?:[A-Z]\s+)?(-?[\d’'.,]+)\s+(\d)\s*$/i;
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
  const { vorlauf, bloecke: erkannteBloecke } = teileInBloecke(lines, /LIEFERSCHEIN\s+(\d+)\s+VOM\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i);
  let bloecke = erkannteBloecke;
  // Einzel-Lieferschein (auch OCR): «Lieferschein 7750842» und
  // «LS-Datum 24.08.26». Anders als bei der Monatsrechnung stehen Nr. und
  // Datum in separaten Feldern und die Positionswerte tragen oft kein «CHF».
  // Beide Felder sind Pflicht, damit keine Referenznummer zur Lieferung wird.
  if (bloecke.length === 0) {
    const text = lines.join('\n');
    const nr = suche(text, [
      /Lieferschein[\s-]*(?:Nr\.?)?\s*:?\s*(\d{6,10})/i,
      /\bLS[\s-]*Nr\.?\s*:?\s*(\d{6,10})/i,
    ]);
    const datum = parseDatumCH(suche(text, [/LS[\s-]*Datum\s*:?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? '');
    if (nr && datum) bloecke = [{ nr, datum, zeilen: lines }];
  }
  // Monatsrechnung: «… 29,90 CHF 313,05 CHF 1»; Einzel-Lieferschein/OCR:
  // «… 43.10 101.29 1». Beide Varianten enthalten Art-Nr, Menge, Einheit,
  // Preis und Betrag und werden daher gleich streng erfasst.
  const zeileRe = /^\s*([A-Z]?\d{3,6})\s+(.+?)\s+(-?[\d.,]+)\s+(KG|STK|PC)\b\s+(-?[\d.,]+)(?:\s*CHF)?\s+(-?[\d.,]+)(?:\s*CHF)?\s+(\d)\s*$/i;
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
  if (erkannteBloecke.length > 0 && gutschriftIdx >= 0 && out.length > 0) {
    const gPos = parseZeilen(vorlauf.slice(gutschriftIdx + 1));
    if (gPos.length > 0) {
      const erste = out[0];
      const positionen = [...gPos.map(p => ({ ...p, bezeichnung: `Gutschrift: ${p.bezeichnung}` })), ...erste.positionen];
      out[0] = baueLieferung(profil.name, erste.rechnungsNr, erste.datum, positionen, mwstSatz);
    }
  }
  return out;
}

/**
 * Gasser Gourmet SAMMELRECHNUNG: Lieferschein-Blöcke je Tag (wie Fideco,
 * eigenes Layout). Blockkopf «2184897  01.06.26  [Mo/Zeichen] …  119.70»,
 * Positionszeile «2210  Frischrösti … 2x2kg  5 Crt  [10.00]  5.99  23.94  119.70»
 * (optionale %-Spalte; letzte Zahl = Positionsbetrag, davor der Preis).
 * «Übertrag»-/Kopfzeilen der Folgeseiten matchen nicht und stören nicht.
 */
function parseGasserLieferungen(lines: string[], profil: LieferantenProfil, mwstSatz: number): ParsedCsvRechnung[] {
  // Blockkopf: LS-Nr (6-8 Ziffern) + LS-Datum; Positions-ArtNrn sind kürzer.
  const { bloecke } = teileInBloecke(lines, /^\s*(\d{6,8})\s+(\d{1,2}\.\d{1,2}\.\d{2,4})\b/);
  const zeileRe = /^\s*(\d{3,6})\s+(.+?)\s+(-?\d+)\s+(Crt|Stk|Kg|Krt|Ei|Pkt?|St)\b\.?\s+(?:([\d’'.,]+)\s+)?([\d’'.,]+)\s+([\d’'.,]+)\s+(-?[\d’'.,]+)\s*$/i;
  return bloecke.map(b => {
    const positionen: WarenPosition[] = [];
    for (const z of b.zeilen) {
      if (/Übertrag/i.test(z)) continue;
      const m = zeileRe.exec(z);
      if (!m) continue;
      positionen.push(position(profil.kategorie, mwstSatz, {
        artNr: m[1], bezeichnung: m[2].trim(), menge: parseBetrag(m[3]) ?? 0,
        einheit: m[4], preis: parseBetrag(m[7]) ?? 0, positionspreis: parseBetrag(m[8]) ?? 0,
      }));
    }
    return baueLieferung(profil.name, b.nr, b.datum, positionen, mwstSatz);
  }).filter(l => l.positionen.length > 0);
}

/**
 * Gourmador (frigemo): Faktura mit «Beleg-Nr. <LS-Nr> vom <Datum>»-Blöcken je
 * Lieferung; Positionszeile «204316  FGO TK … SGA 4x2.5kg  CH  1,2  40  KG
 * 6.65  266.00  2.60 %  [N]» (HK/Merkmal optional, PA-Buchstabe optional).
 * Mehrseitensicher (Seitenkopf/-fuss unterbricht Blöcke nicht).
 */
function parseGourmadorLieferungen(lines: string[], profil: LieferantenProfil, mwstSatz: number): ParsedCsvRechnung[] {
  const { bloecke } = teileInBloecke(lines, /^\s*Beleg-Nr\.\s+(\d{6,10})\s+vom\s+(\d{1,2}\.\d{1,2}\.\d{2,4})\b/i);
  // Menge + PE + Preis + Betrag + Satz % am Zeilenende; HK/Merkmal stecken im
  // Beschreibungs-Rest (nicht benötigt). Betrag/Preis MIT Rappen (QR-Schutz).
  // Art-Nr ab 3 Ziffern («834 Peperoni», «131 Salat» sind echte frigemo-Nrn);
  // Preis/Betrag dürfen NEGATIV sein (IFCO-Gebinde-Retourzeilen «-1 ST -3.20
  // -3.20 0.00 %») — sonst fehlen ganze Belege bzw. die Zeilensumme stimmt
  // nicht mit «Gesamtbetrag exkl. MwSt.» (Warenwert + Gebindewert) überein.
  const zeileRe = /^\s*(\d{3,7})\s+(.+?)\s+(-?[\d.,]+)\s+([A-Z]{2,4})\s+(-?[\d’'.,]*\d[.,]\d{2})\s+(-?[\d’',]*\d[.,]\d{2})\s+([\d.,]+)\s*%\s*(?:[A-Z])?\s*$/;
  return bloecke.map(b => {
    const positionen: WarenPosition[] = [];
    for (const z of b.zeilen) {
      const m = zeileRe.exec(z);
      if (!m) continue;
      // Beschreibung ohne HK/Merkmal-Schwanz (« CH  1,2» / « FR  2,3» …).
      const bezeichnung = m[2].replace(/\s+[A-Z]{2}(?:\s+[\d,]+)?\s*$/, '').trim();
      positionen.push(position(profil.kategorie, parseBetrag(m[7]) ?? mwstSatz, {
        artNr: m[1], bezeichnung, menge: parseBetrag(m[3]) ?? 0,
        einheit: m[4], preis: parseBetrag(m[5]) ?? 0, positionspreis: parseBetrag(m[6]) ?? 0,
      }));
    }
    return baueLieferung(profil.name, b.nr, b.datum, positionen, mwstSatz);
  }).filter(l => l.positionen.length > 0);
}

/**
 * Bäckerei Bohnenblust (Monatsrechnung): Blöcke «Lieferschein Nr. NNNNNN vom
 * DD.MM.YYYY  Total XX.XX» ODER «Nachlieferung Nr. …» — beide eigenständige
 * Lieferungen (Identität = Beleg-Nr, KEIN Zusammenfassen bei gleichem Tag).
 * Das «Total» auf der Kopfzeile ist die Beleg-Summe, keine Position (steht auf
 * der Header-Zeile und landet nie in den Blockzeilen).
 * Positionszeile: «Menge  Bezeichnung  Artikel-Nr(BW.08.06/KB.24.04, optional 4. Segment: BW.90.00.3)  Nettopreis
 * Nettobetrag» — umgebrochene Bezeichnungs-Folgezeilen («Sesam») und wiederholte
 * Seitenköpfe matchen nicht und werden ignoriert.
 */
function parseBohnenblustLieferungen(lines: string[], profil: LieferantenProfil, mwstSatz: number): ParsedCsvRechnung[] {
  const { bloecke } = teileInBloecke(lines,
    /^\s*(?:Lieferschein|Nachlieferung)\s+Nr\.\s+(\d{4,10})\s+vom\s+(\d{1,2}\.\d{1,2}\.\d{2,4})\b/i);
  // Artikel-Nr «XX.NN.NN» (optional «.N»-4.-Segment, z.B. BW.90.00.3 auf
  // Rechnung 48162) als hartes Struktur-Signal; Preis/Betrag MIT Rappen
  // (QR-/Summenzeilen-Schutz), Menge darf negativ sein (Gutschrift-Zeilen).
  // Nur \s+ als Spaltentrenner: die produktive Zeilenrekonstruktion liefert
  // EINZEL-Leerzeichen zwischen den Spalten (pdftotext-Layouts breite Lücken).
  const zeileRe = /^\s*(-?\d{1,5})\s+(.+?)\s+([A-Z]{1,4}(?:\.\d{2}){2}(?:\.\d+)?)\s+(-?[\d’'.,]*\d[.,]\d{2})\s+(-?[\d’',]*\d[.,]\d{2})\s*$/;
  return bloecke.map(b => {
    const positionen: WarenPosition[] = [];
    for (const z of b.zeilen) {
      const m = zeileRe.exec(z);
      if (!m) continue;
      positionen.push(position(profil.kategorie, mwstSatz, {
        artNr: m[3], bezeichnung: m[2].trim(), menge: parseBetrag(m[1]) ?? 0,
        einheit: 'STK', preis: parseBetrag(m[4]) ?? 0, positionspreis: parseBetrag(m[5]) ?? 0,
      }));
    }
    return baueLieferung(profil.name, b.nr, b.datum, positionen, mwstSatz);
  }).filter(l => l.positionen.length > 0);
}

/** Terravigna: «1  21111-24-075  12 75 cl  14.50  15  147.90» (Folgezeile = Weinname). */
function parseTerravignaLieferungen(lines: string[], profil: LieferantenProfil, mwstSatz: number): ParsedCsvRechnung[] {
  const { bloecke } = teileInBloecke(lines, /Lieferungsnr\.\s*(\d+)\s+vom\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i);
  // Betrag MUSS Rappen haben (x.xx) — schützt vor QR-Zahlteil-Referenzzeilen.
  // Menge und Betrag dürfen NEGATIV sein (Retouren-Block, z.B. «-36 75 cl»);
  // negative Positionen werden mitgeführt und subtrahieren sich im Total.
  const zeileRe = /^\s*\d{1,3}\s+(\d[\w-]*)\s+(-?\d+)\s+(.+?)\s+([\d’'.,]+)\s+(?:(\d{1,2})\s+)?(-?[\d’',]*\d[.,]\d{2})\s*$/;
  if (bloecke.length === 0) return parseTerravignaAB(lines, profil, mwstSatz);
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

/**
 * Terravigna AUFTRAGSBESTÄTIGUNG (keine «Lieferungsnr.»-Blöcke): EINE
 * provisorische Lieferung übers ganze Dokument.
 * - Nr = Auftragsbestätigungs-Nr (Upsert-Identität beim Re-Import).
 * - Datum = «Lieferdatum» (Feld kann LEER sein) → Fallback «Belegdatum».
 * - Positionszeile «1  21111-24-075  12 75 cl  Wein  14.50  [Rab%]  [8.1|2.6]  174.00»
 *   — MwSt-Satz JE POSITION (8.1 Wein / 2.6 alkoholfrei), Spalte optional.
 */
function parseTerravignaAB(lines: string[], profil: LieferantenProfil, mwstSatz: number): ParsedCsvRechnung[] {
  const text = lines.join('\n');
  // NUR echte Auftragsbestätigungen: eine RECHNUNG ohne erkannte
  // «Lieferungsnr.»-Blöcke darf NIE über eine bloss referenzierte AB-Nr
  // als Lieferung geparst werden (falsche Upsert-Identität/Historie).
  if (erkenneBelegart(text) !== 'auftragsbestaetigung') return [];
  const nr = suche(text, [/Auftragsbest(?:ä|ae)tigung\s*(?:Nr\.?\s*)?:?\s*(\d{4,10})/i]);
  const datum = parseDatumCH(suche(text, [/Lieferdatum[ \t]+(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? '')
    ?? parseDatumCH(suche(text, [/Belegdatum\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? '');
  if (!nr || !datum) return [];
  // Optionale Spalten zwischen Preis und Betrag: Rabatt-% (ganzzahlig)
  // und/oder MwSt-Satz (8.1/2.6 — nur diese beiden, sonst kapert eine
  // Preisspalte den Satz). Betrag MUSS Rappen haben (QR-Zahlteil-Schutz).
  const abZeileRe = /^\s*\d{1,3}\s+(\d[\w-]*)\s+(-?\d+)\s+(.+?)\s+([\d’'.,]+)\s+(?:(\d{1,2})\s+)?(?:(8\.1|2\.6)\s*%?\s+)?(-?[\d’',]*\d[.,]\d{2})\s*$/;
  const positionen: WarenPosition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = abZeileRe.exec(lines[i]);
    if (!m) continue;
    const menge = Number(m[2]);
    const betrag = parseBetrag(m[7]) ?? 0;
    const preis = menge > 0 ? rundung2(betrag / menge) : 0;
    const posSatz = m[6] ? Number(m[6]) : mwstSatz;
    // Mittelteil «75 cl  Chardonnay Réserve» = Einheit + INLINE-Bezeichnung;
    // ohne erkennbare Einheit: Bezeichnung ggf. auf der Folgezeile (wie Rechnung).
    const mitte = /^([\d.,]*\s*(?:cl|lt?|kg|stk?|fl|kt))\b\s*(.*)$/i.exec(m[3].trim());
    let einheit = m[3].trim();
    let bezeichnung = '';
    if (mitte) { einheit = mitte[1].trim(); bezeichnung = mitte[2].trim(); }
    if (!bezeichnung) {
      const naechste = (lines[i + 1] ?? '').trim();
      bezeichnung = naechste && !abZeileRe.test(lines[i + 1]) && !/^Total|^Gesamt/i.test(naechste)
        ? naechste : m[1];
    }
    positionen.push(position(profil.kategorie, posSatz,
      { artNr: m[1], bezeichnung, menge, einheit, preis, positionspreis: betrag }));
  }
  if (positionen.length === 0) return [];
  return [baueLieferung(profil.name, nr, datum, positionen, mwstSatz)];
}

/** Zelle in \s{2,}-getrennte Spalten teilen (Zeilenrekonstruktion verbindet
 *  PDF-Zellen mit Doppel-Leerzeichen — robust gegen Leerzeichen IN Zellen). */
function zellen(line: string): string[] {
  return line.split(/\s{2,}/).map(z => z.trim()).filter(Boolean);
}

const istBetragZelle = (z: string) => /^-?[\d’'.,]*\d(?:[.,]\d{1,2})?$/.test(z) && /\d/.test(z);

/**
 * Ambro: Blöcke «Basierend auf Lieferschein <nr> vom <dd.mm.yy>. Lieferdatum
 * <dd.mm.yy>. …» — das LIEFERDATUM (2. Datum) ist massgeblich. Positionszeile:
 * «1  540.402  [Bezeichnung]  24.000  SCA  12.40  15.00  10.54  252.96»
 * (Bezeichnung teils inline, teils auf eigener Zeile davor).
 */
function parseAmbroLieferungen(lines: string[], profil: LieferantenProfil, mwstSatz: number): ParsedCsvRechnung[] {
  const header = /Basierend auf Lieferschein\s+(\d+)\s+vom\s+\d{1,2}\.\d{1,2}\.\d{2,4}\.\s*Lieferdatum\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i;
  const parsePositionen = (zeilenListe: string[]): WarenPosition[] => {
    const positionen: WarenPosition[] = [];
    let vorherige = '';
    for (const z of zeilenListe) {
      const c = zellen(z);
      // [pos, artNr, (bez), menge, einheit, listpreis, rabatt%, nettopreis, betrag]
      const ok = (c.length === 8 || c.length === 9)
        && /^\d{1,4}$/.test(c[0]) && /^\d{3}\.\d{3}$/.test(c[1])
        && /^[A-ZÄÖÜ]{1,5}$/i.test(c[c.length - 5])
        && c.slice(-4).every(istBetragZelle) && istBetragZelle(c[c.length - 6]);
      if (!ok) { if (/[A-Za-zÄÖÜäöü]{3}/.test(z) && !header.test(z)) vorherige = z.trim(); continue; }
      const bezInline = c.length === 9 ? c[2] : '';
      const preis = parseBetrag(c[c.length - 2]) ?? 0;
      const positionspreis = parseBetrag(c[c.length - 1]) ?? 0;
      // Voll rabattierte Gratiszeilen sind keine belastbare Preisbeobachtung
      // und tragen 0.00 zur Rechnung bei.
      if (preis <= 0 || positionspreis === 0) { vorherige = ''; continue; }
      positionen.push(position(profil.kategorie, mwstSatz, {
        artNr: c[1],
        bezeichnung: bezInline || vorherige || c[1],
        menge: parseBetrag(c[c.length - 6]) ?? 0,
        einheit: c[c.length - 5].toUpperCase(),
        preis,           // Nettopreis nach Rabatt
        positionspreis, // Zeilenbetrag
      }));
      vorherige = '';
    }
    return positionen;
  };
  const { bloecke } = teileInBloecke(lines, header);
  // Blöcke gleicher LS-Nr (Seitenumbruch) zusammenführen.
  const proNr = new Map<string, LieferungBlock>();
  for (const b of bloecke) {
    const alt = proNr.get(`${b.nr}|${b.datum}`);
    if (alt) alt.zeilen.push(...b.zeilen); else proNr.set(`${b.nr}|${b.datum}`, b);
  }
  if (proNr.size > 0) {
    return [...proNr.values()]
      .map(b => baueLieferung(profil.name, b.nr, b.datum, parsePositionen(b.zeilen), mwstSatz))
      .filter(l => l.positionen.length > 0);
  }
  // EINZEL-LIEFERSCHEIN (eigener Beleg, keine «Basierend auf Lieferschein»-
  // Blöcke): Belegnummer + Daten stehen in der Kopftabelle «Belegnummer
  // Datum  Lieferdatum  Seite» — z.B. «Oliv Gastro AG  26116806  05.08.26
  // 05.08.26  1 / 1». Massgeblich ist das LIEFERDATUM (2. Datum), NIE das
  // «Basierend auf Auftrag … vom …»-Auftragsdatum. Die Belegnummer wird als
  // Rechnungs-Nr geführt (Dedup + späterer Monatsabgleich über LS-Nr).
  // WACHE: Fallback NUR bei expliziter «Lieferschein»-Überschrift in der
  // Kopfzone — eine Monatsrechnung mit unlesbaren Blöcken darf NIE als eine
  // einzelne provisorische Lieferung durchrutschen (lieber Kopf-Buchung).
  const kopfzone = lines.slice(0, 30);
  const istLieferschein = kopfzone.some(z => /^\s*Lieferschein\b(?!\s*[/.])/i.test(z))
    && !lines.some(z => /\b(?:Sammel|Monats)-?rechnung\b/i.test(z));
  if (!istLieferschein) return [];
  const kopfRe = /(\d{7,9})\s{2,}(\d{1,2}\.\d{1,2}\.\d{2,4})\s{2,}(\d{1,2}\.\d{1,2}\.\d{2,4})\s{2,}\d+\s*\/\s*\d+/;
  for (const line of kopfzone) {
    const m = kopfRe.exec(line);
    if (!m) continue;
    const lieferdatum = parseDatumCH(m[3]);
    if (!lieferdatum) break;
    const l = baueLieferung(profil.name, m[1], lieferdatum, parsePositionen(lines), mwstSatz);
    return l.positionen.length > 0 ? [l] : [];
  }
  return [];
}

/** Transgourmet-Sparten (Rechnung, «Aufteilung Spartung»): Food vs Non-Food. */
export const TG_SPARTEN_FOOD = ['42020', '42030', '42040', '42060'];
export const TG_SPARTEN_NONFOOD = ['42880', '43010', '47010', '61520', '64110'];

/**
 * Transgourmet: EIN Lieferschein je Rechnung («Lieferschein <nr> / <datum>»
 * bzw. «… vom <datum>»). Positionszeile endet mit «… preis [rabatt%] [Kz]
 * exkl inkl satz» — die MWST-Klasse je Position bestimmt Food (2.6 %) vs
 * Non-Food (8.1 %/0 %), exakt wie die Sparten-Tabelle (42020/42030/42040/
 * 42060 = Food; 42880/43010/47010/61520/64110 = Non-Food).
 */
function parseTransgourmetLieferungen(lines: string[], profil: LieferantenProfil, _satz: number): ParsedCsvRechnung[] {
  const header = /Lieferschein\s+(\d+)\s+(?:\/|vom)\s+(\d{1,2}\.\d{1,2}\.\d{4})/i;
  const { bloecke } = teileInBloecke(lines, header);
  const proNr = new Map<string, LieferungBlock>();
  for (const b of bloecke) {
    const alt = proNr.get(`${b.nr}|${b.datum}`);
    if (alt) alt.zeilen.push(...b.zeilen); else proNr.set(`${b.nr}|${b.datum}`, b);
  }
  return [...proNr.values()].map(b => {
    const positionen: WarenPosition[] = [];
    for (const z of b.zeilen) {
      if (/Aufteilung Spartung|Total Warenwert|Total Rechnung|MWST\s+\d/i.test(z)) continue;
      const c = zellen(z);
      if (c.length < 6 || !/^\d{1,4}$/.test(c[0]) || !/^\d{5,7}$/.test(c[1])) continue;
      // Von hinten: satz («2.60»), inkl, exkl, [Kennzeichen], [rabatt%], preis.
      let i = c.length - 1;
      if (!/^\d{1,2}\.\d{2}$/.test(c[i])) continue;
      const satz = parseBetrag(c[i--]) ?? 0;
      if (!istBetragZelle(c[i]) || !istBetragZelle(c[i - 1])) continue;
      const inkl = parseBetrag(c[i--]) ?? 0;
      const exkl = parseBetrag(c[i--]) ?? 0;
      if (i >= 2 && /^[A-Z]{1,2}$/.test(c[i])) i--;          // Online/Aktions-Kz
      if (i >= 2 && /%$/.test(c[i])) i--;                     // Rabatt-%
      const preis = i >= 2 && istBetragZelle(c[i]) ? (parseBetrag(c[i--]) ?? 0) : 0;
      // Bezeichnung = letzte Textzelle vor dem Preis-Teil.
      let bez = '';
      for (let j = i; j >= 2; j--) {
        if (/[A-Za-zÄÖÜäöü]{2}/.test(c[j])) { bez = c[j]; break; }
      }
      positionen.push({
        artNr: c[1], bezeichnung: bez || c[1],
        warengruppe: satz === 2.6 ? 'Food' : 'Nonfood',
        menge: 0, einheit: '', preis, positionspreis: rundung2(exkl),
        mwstBetrag: rundung2(inkl - exkl),
        mwstCode: satz === 0 ? 0 : satz === 2.6 ? 1 : 2,
        ...(satz === 0 || satz === 2.6 || satz === 8.1 ? { mwstSatz: satz as 0 | 2.6 | 8.1 } : {}),
      });
    }
    return baueLieferung(profil.name, b.nr, b.datum, positionen, 0);
  }).filter(l => l.positionen.length > 0);
}

// Bohnenblust-Parser entfernt (Aug 2026): wird ausschliesslich MANUELL erfasst.

// ─── Kopf-Erkennung pro Profil ───────────────────────────────────────────────

interface KopfFelder {
  rechnungsNr: string | null;
  rechnungsdatum: string | null;
  lieferdatum: string | null;
  netto: number | null;
  mwst: number | null;
  mwstSatz: number | null;
  /** Nur aus einer gedruckten MwSt-Zusammenfassung, nie aus Artikelzeilen. */
  mwstKlassen?: MwstKlasse[];
  /** Mehrere gedruckte Sätze ohne verifizierbare Basen: nicht schätzen. */
  gemischteMwstSaetze?: boolean;
  /** Profil-spezifische Hinweise (z.B. Gebinde separat, Kontierung prüfen). */
  hinweise?: string[];
}

/** Gedruckte MwSt-Zusammenfassungen gängiger Lieferantenlayouts. */
function generischeMwstKlassen(text: string): MwstKlasse[] {
  const result: MwstKlasse[] = [];
  const push = (satzRaw: string, basisRaw: string, betragRaw: string) => {
    const satz = parseBetrag(satzRaw);
    const basis = parseBetrag(basisRaw);
    const betrag = parseBetrag(betragRaw);
    if (satz === null || basis === null || betrag === null || ![0, 2.6, 8.1].includes(satz)) return;
    if (!result.some(k => k.satz === satz && Math.abs(k.basis - basis) < 0.005 && Math.abs(k.betrag - betrag) < 0.005)) {
      result.push({ satz, basis: rundung2(basis), betrag: rundung2(betrag) });
    }
  };
  for (const line of text.split('\n')) {
    // Transgourmet: MWST 8.10% | Steuer | exkl. | inkl.
    let m = line.match(new RegExp(`MWST\\s+(\\d{1,2}[.,]\\d{1,2})%\\s+(${BETRAG_RE.source})\\s+(${BETRAG_RE.source})\\s+${BETRAG_RE.source}`, 'i'));
    if (m) { push(m[1], m[3], m[2]); continue; }
    // Caporaso/ähnlich: 2.6% MwSt. aus Betrag von CHF 100.00 CHF 2.60
    m = line.match(new RegExp(`(\\d{1,2}(?:[.,]\\d{1,2})?)%\\s*MwSt\\.?[^\\n]*?(?:von|auf)\\s+(?:CHF\\s*)?(${BETRAG_RE.source})\\s+(?:CHF\\s*)?(${BETRAG_RE.source})`, 'i'));
    if (m) { push(m[1], m[2], m[3]); continue; }
    // Ambro: Mehrwertsteuer 2.6% (...) auf 5'699.94 148.20
    m = line.match(new RegExp(`Mehrwertsteuer\\s+(\\d{1,2}(?:[.,]\\d{1,2})?)%[^\\n]*?auf\\s+(${BETRAG_RE.source})\\s+(${BETRAG_RE.source})`, 'i'));
    if (m) push(m[1], m[2], m[3]);
  }
  return result.sort((a, b) => a.satz - b.satz);
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
  const mwstKlassen = generischeMwstKlassen(text);
  const saetze = [...text.matchAll(/(?:MWST|Mehrwertsteuer)[^\n]{0,40}?(\d{1,2}(?:[.,]\d{1,2})?)\s*%/gi)]
    .map(m => parseBetrag(m[1]))
    .filter((satz): satz is number => satz !== null);
  const unterschiedlicheSaetze = new Set([
    ...saetze.map(satz => Math.round(satz * 10) / 10),
    ...mwstKlassen.map(klasse => klasse.satz),
  ]);
  const gemischteMwstSaetze = unterschiedlicheSaetze.size > 1;
  const satzS = gemischteMwstSaetze ? null : saetze[0] ?? null;
  const mwstSatz = satzS;
  return { rechnungsNr, rechnungsdatum, lieferdatum: null, netto, mwst, mwstSatz, mwstKlassen, gemischteMwstSaetze };
}

/** Deutsches Langdatum («15. Mai 2026») → YYYY-MM-DD. */
function parseDatumLang(tag: string, monat: string, jahr: string): string | null {
  const MONATE: Record<string, number> = {
    januar: 1, februar: 2, 'märz': 3, maerz: 3, april: 4, mai: 5, juni: 6,
    juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
  };
  const mm = MONATE[monat.toLowerCase()];
  const dd = Number(tag), y = Number(jahr);
  if (!mm || dd < 1 || dd > 31 || y < 2000 || y > 2099) return null;
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
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
  obrist: (text) => {
    const g = generischerKopf(text);
    // «Lieferschein … EV144016, vom 01.07.2026   30.06.2026»: das LS-Datum
    // («vom …») ist das LIEFERDATUM, das Datum danach (Spalte «Datum») das
    // Rechnungsdatum.
    const ls = /,\s*vom\s+(\d{1,2}\.\d{1,2}\.\d{4})\s+(\d{1,2}\.\d{1,2}\.\d{4})/.exec(text);
    // «Total Gebinde CHF» = Depot — separat, NIE im Wareneinsatz. Netto/MwSt
    // stammen aus Zwischensumme/MwSt (ohne Gebinde); Brutto = netto+mwst
    // entspricht «Total CHF inkl. MwSt.» (die «Gesamtsumme» enthielte Gebinde).
    const gebinde = sucheBetrag(text, [new RegExp(`Total Gebinde CHF\\s+(${BETRAG_RE.source})`, 'i')]);
    return {
      ...g,
      rechnungsNr: suche(text, [/Rechnung-?Nr\.?\s*:?\s*(\d{3,10})/i]),
      rechnungsdatum: ls ? parseDatumCH(ls[2]) ?? g.rechnungsdatum : g.rechnungsdatum,
      lieferdatum: ls ? parseDatumCH(ls[1]) : null,
      netto: sucheBetrag(text, [new RegExp(`Zwischensumme ohne MwSt\\s*CHF\\s*(${BETRAG_RE.source})`, 'i')]),
      mwst: sucheBetrag(text, [new RegExp(`MwSt\\.\\s*CHF\\s*(${BETRAG_RE.source})`, 'i')]),
      ...(gebinde !== null && gebinde > 0
        ? { hinweise: [`Total Gebinde CHF ${gebinde.toFixed(2)} (Depot) — separat, nicht im Wareneinsatz enthalten.`] }
        : {}),
    };
  },
  // The Asia Company: «Rechnung 297454 · Münchenstein, 15. Mai 2026»;
  // Netto/Brutto aus «Total CHF exkl./inkl. MWST»; Lieferdatum aus
  // «Lieferung Nr. VW108357 vom 07.05.26»; Kontierungs-Codes 420xx = Küche.
  asia: (text, lines) => {
    const g = generischerKopf(text);
    const lang = /,\s*(\d{1,2})\.\s*(Januar|Februar|M(?:ä|ae)rz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+(\d{4})/i.exec(text);
    const rechnungsdatum = lang ? parseDatumLang(lang[1], lang[2], lang[3]) : g.rechnungsdatum;
    // Lieferdatum nur, wenn GENAU EINE Lieferung gelistet ist — nie raten.
    const ldTreffer = [...text.matchAll(/(?:^|\n)Lieferung\s+Nr\.\s*\S+\s+vom\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/gi)];
    const netto = sucheBetrag(text, [new RegExp(`Total CHF exkl\\.\\s*MWST\\s+(${BETRAG_RE.source})`, 'i')]);
    const hinweise: string[] = [];
    // «Zusammenfassung Kontierung»: 5-stellige Codes; alle 420xx sind Küche
    // (42020/42030/42050/42060 …) → Profil-Konto 4060. Fremde Codes oder eine
    // Summenabweichung werden gemeldet — nie stumm umgebucht.
    const start = lines.findIndex(z => /Zusammenfassung\s+Kontierung/i.test(z));
    if (start >= 0) {
      let summe = 0; let gefunden = false;
      for (const z of lines.slice(start + 1)) {
        const m = /^\s*(\d{5})\s{2,}(.+?)\s{2,}[\d.,]+\s*%\s{2,}([\d’'.,]+)\s/.exec(z);
        if (!m) continue;
        gefunden = true;
        summe += parseBetrag(m[3]) ?? 0;
        if (!m[1].startsWith('420')) {
          hinweise.push(`Kontierungscode ${m[1]} (${m[2].trim()}) ausserhalb Warenaufwand Küche — bitte Konto prüfen.`);
        }
      }
      if (gefunden && netto !== null && Math.abs(rundung2(summe) - netto) > 0.05) {
        hinweise.push(`Summe Kontierung ${rundung2(summe).toFixed(2)} ≠ Rechnungs-Netto ${netto.toFixed(2)} — bitte prüfen.`);
      }
    }
    return {
      ...g,
      rechnungsNr: suche(text, [/Rechnung\s+(\d{4,12})/i]) ?? g.rechnungsNr,
      rechnungsdatum,
      lieferdatum: ldTreffer.length === 1 ? parseDatumCH(ldTreffer[0][1]) : null,
      netto,
      mwst: sucheBetrag(text, [new RegExp(`MWST\\s+[\\d.]+\\s*%\\s*von\\s+[\\d’'.,]+\\s+(${BETRAG_RE.source})`, 'i')]),
      mwstSatz: 2.6,
      ...(hinweise.length ? { hinweise } : {}),
    };
  },
  // rutishauser-Parser entfernt (Altlast, kein Lieferant mehr, 08/2026).
  terravigna: (text) => {
    const netto = sucheBetrag(text, [new RegExp(`Total\\s*CHF\\s*ohne\\s*MwSt\\.?\\s+(${BETRAG_RE.source})`, 'i')]);
    // Gemischte MwSt-Sätze möglich (z.B. 8.1% Wein + 2.6% alkoholfrei): Brutto
    // DIREKT aus dem Beleg lesen («Total CHF inkl. MwSt.», ältere Layouts
    // «Gesamtbetrag CHF») und MwSt = Brutto − Netto — nie aus einem
    // Einzelsatz zurückrechnen.
    const brutto = sucheBetrag(text, [
      new RegExp(`Total\\s*CHF\\s*inkl\\.?\\s*MwSt\\.?\\s+(${BETRAG_RE.source})`, 'i'),
      new RegExp(`Gesamtbetrag\\s*CHF\\s+(${BETRAG_RE.source})`, 'i'),
    ]);
    return {
      ...generischerKopf(text),
      rechnungsNr: suche(text, [/Rechnung\s+(\d{4,10})/i]),
      rechnungsdatum: parseDatumCH(suche(text, [/Belegdatum\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? ''),
      // Auftragsbestätigung: Feld «Lieferdatum» kann LEER sein — nur ein
      // tatsächlich vorhandenes Datum lesen (sonst Fallback auf Belegdatum
      // im AB-Lieferungs-Parser).
      lieferdatum: parseDatumCH(suche(text, [/Lieferdatum[ \t]+(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? ''),
      netto,
      mwst: netto !== null && brutto !== null
        ? rundung2(brutto - netto)
        : sucheBetrag(text, [new RegExp(`[\\d.]+\\s*%\\s*MwSt\\.?\\s+(${BETRAG_RE.source})`, 'i')]),
      mwstSatz: 8.1,
    };
  },
  // Bäckerei Bohnenblust: «Rechnungsnummer: 49415   31.07.2026», Netto aus
  // «Zwischentotal … CHF 823.37», MwSt aus «2.6% MwSt. aus Betrag von CHF … CHF 21.41»,
  // Brutto = «Total inkl. MwSt.». Kein Pfand/Gebinde.
  bohnenblust: (text) => {
    const g = generischerKopf(text);
    return {
      ...g,
      rechnungsNr: suche(text, [/Rechnungsnummer\s*:?\s*(\d{3,10})/i]) ?? g.rechnungsNr,
      rechnungsdatum:
        parseDatumCH(suche(text, [/Rechnungsnummer\s*:?\s*\d{3,10}\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? '')
        ?? g.rechnungsdatum,
      netto: sucheBetrag(text, [new RegExp(`Zwischentotal\\s+CHF\\s*(${BETRAG_RE.source})`, 'i')]),
      mwst: sucheBetrag(text, [new RegExp(`MwSt\\.\\s*aus\\s*Betrag\\s*von\\s*CHF\\s*[\\d’'.,]+\\s+CHF\\s*(${BETRAG_RE.source})`, 'i')]),
      mwstSatz: 2.6,
    };
  },
  spahni: (text) => {
    const g = generischerKopf(text);
    // Einzel-Lieferschein: «Liefersch./Kd.-Nr. : 5210840 / XBEA» + «Lieferdatum».
    const ls = /Liefersch\.?\s*\/?\s*Kd\.-?Nr\.?\s*:?\s*(\d{4,10})\s*\/\s*\w+/i.exec(text);
    // «Lieferdatum : Di 04.08.26 / 201» — optionaler WOCHENTAG (nur Mo–So,
    // nie beliebige Tokens/Monatsnamen) vor dem Datum, «/ <Code>» dahinter
    // ignorieren. Kein Fund → null (NIE heutiges Datum raten).
    const lieferdatum = parseDatumCH(suche(text, [SPAHNI_LIEFERDATUM_RE]) ?? '');
    return {
      ...g,
      rechnungsNr: suche(text, [/RECHNUNG\s*:?\s*(\d{4,10})/i]) ?? (ls ? ls[1] : null),
      // Belegdatum-Zeile «Zollikofen , 15.01.26 …» — NUR das Datum direkt nach
      // dem Ort lesen, alles danach ignorieren («/ 500», «/ SAST», «Seite 1»).
      rechnungsdatum:
        parseDatumCH(suche(text, [/Zollikofen\s*,?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? '')
        ?? g.rechnungsdatum,
      lieferdatum: lieferdatum ?? g.lieferdatum,
      // «Total CHF 3'796.25» (netto) und «1 MWST 2.60 % 98.70»
      netto: sucheBetrag(text, [new RegExp(`Total\\s*CHF\\s+(${BETRAG_RE.source})\\s*$`, 'im')]),
      mwst: sucheBetrag(text, [new RegExp(`MWST\\s+[\\d.]+\\s*%\\s+(${BETRAG_RE.source})\\s*$`, 'im')]),
      mwstSatz: 2.6,
    };
  },
  fideco: (text, lines) => {
    const g = generischerKopf(text);
    // «MwSt.-Kz. 1: Netto 2.60% 3.416,45 CHF MwSt. 2.60% 88,85 CHF» — Kz-Zeilen summieren.
    let netto = 0, mwst = 0, gefunden = false;
    const re = /MwSt\.-Kz\.\s*\d+\s*:\s*Netto\s+[\d.,]+%\s+([\d.,]+)\s*CHF\s+MwSt\.\s+[\d.,]+%\s+([\d.,]+)\s*CHF/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      netto += parseBetrag(m[1]) ?? 0; mwst += parseBetrag(m[2]) ?? 0; gefunden = true;
    }
    // Gescannter Einzel-Lieferschein (OCR): «Lieferschein-Nr 7746026»,
    // «LS-Datum 3.08.26» (1-stelliger Tag/2-stelliges Jahr möglich) und
    // «Gesamt-Betrag 164.50» bzw. «CHF / CHILLED Gesamt-Betrag 164.50».
    // Der Gesamt-Betrag wird als NETTO interpretiert (Lieferschein-Warenwert;
    // MWST-Legende 1=2.6%/2=8.1%/3=0% ist auf dem LS nur informativ) —
    // Kontrolle im Abgleich mit der Monatsrechnung.
    // Kein Fund → Felder bleiben leer (nie raten, nie heutiges Datum).
    const lsNr = suche(text, [
      /Lieferschein[\s-]*(?:Nr\.?)?\s*:?\s*(\d{6,10})/i,
      /\bLS[\s-]*Nr\.?\s*:?\s*(\d{6,10})/i,
    ]);
    const lsDatum = parseDatumCH(suche(text, [/LS[\s-]*Datum\s*:?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? '');
    // Neuer Fideco-Lieferschein:
    // 1) Autoritativ ist die Zeile, die mit «Gesamt» beginnt und mit dem
    //    letzten «CHF <Betrag>» endet. Die CHILLED-Zwischensumme ist wegen
    //    Rundungsdifferenzen ausdrücklich keine Primärquelle.
    let gesamtBetrag: number | null = null;
    for (const line of lines) {
      if (!/^\s*Gesamt\b/i.test(line)) continue;
      const match = new RegExp(`CHF\\s*(${BETRAG_RE.source})\\s*$`, 'i').exec(line);
      const betrag = match ? parseBetrag(match[1]) : null;
      if (betrag !== null) gesamtBetrag = betrag;
    }
    // 2) Fallback: echte Artikelzeilen beginnen mit einer Artikelnummer und
    //    enden mit «CHF <Betrag>». Damit sind «CHILLED»-/«Gesamt»-Summenzeilen
    //    ausgeschlossen. Der jeweils letzte CHF-Wert ist der Positionsbetrag.
    const positionsBetraege = lines.flatMap(line => {
      if (!/^\s*[A-Z]?\d{3,8}\b/i.test(line)) return [];
      const match = new RegExp(`CHF\\s*(${BETRAG_RE.source})\\s*$`, 'i').exec(line);
      const betrag = match ? parseBetrag(match[1]) : null;
      return betrag === null ? [] : [betrag];
    });
    const positionsNetto = positionsBetraege.length > 0
      ? rundung2(positionsBetraege.reduce((summe, betrag) => summe + betrag, 0))
      : null;
    const legacyLsBetrag = gefunden ? null
      : sucheBetrag(text, [new RegExp(
        `(?:Gesamt[\\s-]*Betrag|CHF\\s*\\/\\s*CHILLED(?:\\s+(?:Gesamt[\\s-]*Betrag|Total))?|Total\\s+CHF\\s*\\/\\s*CHILLED)\\s*:?\\s*(?:CHF\\s*)?(${BETRAG_RE.source})`,
        'i',
      )]);
    const lsBetrag = gesamtBetrag ?? positionsNetto ?? legacyLsBetrag;
    // Scan-Lieferschein erkannt (LS-Nr oder LS-Datum vorhanden): der Betrag
    // kommt AUSSCHLIESSLICH aus «Gesamt-Betrag» — generische Labels
    // («Warenwert» u.ä.) dürfen im Scan-Pfad KEINEN Betrag liefern (kein
    // Raten); ohne Fund bleibt das Feld leer.
    const istScanLs = !gefunden && (lsNr !== null || lsDatum !== null);
    return {
      ...g,
      rechnungsNr: suche(text, [/RECHNUNG\s+Nr\.\s*(\d{4,10})/i]) ?? lsNr,
      lieferdatum: lsDatum ?? g.lieferdatum,
      netto: gefunden ? rundung2(netto) : istScanLs ? lsBetrag : g.netto,
      mwst: gefunden ? rundung2(mwst) : istScanLs ? null : g.mwst,
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
      // Kopffeld «Lieferdatum 29.07.26» — Einzellieferung.
      lieferdatum: parseDatumCH(suche(text, [/Lieferdatum\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? ''),
      netto: m ? parseBetrag(m[2]) : g.netto,
      mwst: m ? parseBetrag(m[4]) : g.mwst,
      mwstSatz: m ? parseBetrag(m[3]) : g.mwstSatz,
    };
  },
  ambro: (text) => {
    const g = generischerKopf(text);
    // Tabellenzeile unter «Belegnummer  Datum  Fälligkeitsdatum  Seite» —
    // beim LIEFERSCHEIN steht davor die Empfängerzeile («Oliv Gastro AG
    // 26116806  05.08.26  05.08.26  1 / 1»), daher Prefix zulassen.
    const kopfzoneText = text.split('\n').slice(0, 30).join('\n');
    const kopf = /(?:^|\n)[^\n]*?(\d{7,9})\s{2,}(\d{1,2}\.\d{1,2}\.\d{2,4})\s{2,}(\d{1,2}\.\d{1,2}\.\d{2,4})\s{2,}\d+\s*\/\s*\d+/.exec(kopfzoneText);
    const netto = sucheBetrag(text, [new RegExp(`Nettobetrag\\s+(${BETRAG_RE.source})`, 'i')]);
    const mwst = sucheBetrag(text, [new RegExp(`Mehrwertsteuer\\s+[\\d.,]+%[^\\n]*?(${BETRAG_RE.source})\\s*$`, 'im')]);
    // Rundung dem MwSt-Betrag zuschlagen, damit netto+mwst = «Gesamtbetrag CHF».
    const rundung = sucheBetrag(text, [new RegExp(`(?:^|\\n)\\s*Rundung\\s+(${BETRAG_RE.source})`, 'i')]) ?? 0;
    // Lieferschein-Dokument: 3. Spalte ist das LIEFERDATUM (bei der
    // Rechnung ist sie das Fälligkeitsdatum — dort NICHT als Lieferdatum führen).
    const istLieferschein = /(?:^|\n)\s*Lieferschein\b/i.test(text.split('\n').slice(0, 25).join('\n'));
    return {
      ...g,
      rechnungsNr: kopf ? kopf[1] : g.rechnungsNr,
      rechnungsdatum: kopf ? parseDatumCH(kopf[2]) : g.rechnungsdatum,
      lieferdatum: istLieferschein && kopf ? parseDatumCH(kopf[3]) : g.lieferdatum,
      netto: netto ?? g.netto,
      mwst: mwst !== null ? rundung2(mwst + rundung) : g.mwst,
      mwstSatz: 2.6,
    };
  },
  transgourmet: (text) => {
    const g = generischerKopf(text);
    // «Total Rechnung  203.87  4'985.74  [CHF ]5'189.60» → MwSt, Netto.
    const total = /Total Rechnung\s+([\d’'.,]+)\s+([\d’'.,]+)/i.exec(text);
    const ls = /Lieferschein\s+(\d+)\s+(?:\/|vom)\s+(\d{1,2}\.\d{1,2}\.\d{4})/i.exec(text);
    return {
      ...g,
      rechnungsNr: suche(text, [/Rechnungsnummer\s+(\d{6,12})/i]) ?? g.rechnungsNr,
      rechnungsdatum: parseDatumCH(suche(text, [/Rechnungsdatum\s+(\d{1,2}\.\d{1,2}\.\d{4})/i]) ?? '') ?? g.rechnungsdatum,
      lieferdatum: ls ? parseDatumCH(ls[2]) : null,
      netto: total ? parseBetrag(total[2]) : g.netto,
      mwst: total ? parseBetrag(total[1]) : g.mwst,
      // Gemischte Sätze (2.6/8.1/0) — kein einzelner Satz.
      mwstSatz: null,
    };
  },
  caporaso: (text) => {
    const g = generischerKopf(text);
    const mwstKlassen = caporasoMwstBasen(text);
    const lieferdatum = parseDatumCH(suche(text, [CAPORASO_LS_RE]) ?? '');
    const netto = mwstKlassen.length > 0 ? rundung2(mwstKlassen.reduce((s, b) => s + b.basis, 0)) : g.netto;
    const mwst = mwstKlassen.length > 0 ? rundung2(mwstKlassen.reduce((s, b) => s + b.betrag, 0)) : g.mwst;
    return {
      ...g,
      rechnungsNr: suche(text, [/LIEFERSCHEIN-?RECHNUNG\s*:?\s*(\d{4,12})/i]) ?? g.rechnungsNr,
      // Bei Caporaso ist das Lieferschein-Datum zugleich das Rechnungsdatum.
      rechnungsdatum: lieferdatum ?? g.rechnungsdatum,
      lieferdatum,
      netto, mwst,
      mwstKlassen,
      // Gemischte Sätze (2.6 Food / 8.1 Verpackung) — kein einzelner Satz.
      mwstSatz: null,
      gemischteMwstSaetze: mwstKlassen.length > 1,
    };
  },
  espro: (text) => {
    const g = generischerKopf(text);
    // Summenblock: «N26  Exkl. 2.6% MWSt  10.40  400.00» (MwSt, Umsatz netto),
    // «MWSt:  10.40», «Total:  410.40» (brutto).
    const summe = new RegExp(`Exkl\\.\\s*([\\d.,]+)\\s*%\\s*MWSt\\s+(${BETRAG_RE.source})\\s+(${BETRAG_RE.source})`, 'i').exec(text);
    return {
      ...g,
      rechnungsNr: suche(text, [/Rechnung\s+Nr\.\s*(\d{4,10})/i]) ?? g.rechnungsNr,
      rechnungsdatum: parseDatumCH(suche(text, [/Datum:\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i]) ?? '') ?? g.rechnungsdatum,
      netto: summe ? parseBetrag(summe[3]) : g.netto,
      mwst: summe ? parseBetrag(summe[2])
        : sucheBetrag(text, [new RegExp(`MWSt:\\s+(${BETRAG_RE.source})`, 'i')]),
      mwstSatz: summe ? parseBetrag(summe[1]) : 2.6,
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

/**
 * Espro/Amarx: Monats-Sammelrechnung mit Tageslieferungen. Blockkopf
 * «176802.1 vom 05.01.2026», Positionszeile «Piso 4/4  1  04 S  25.00  25.00»
 * (Bezeichnung  Menge  ArtNr  Preis  Betrag; Folgezeilen = Beschreibungs-
 * Fortsetzung, ignoriert). Blockende «Total 176802.1 vom 05.01.2026  50.00» —
 * die Total-Zeile ist KONTROLLE: weichen Σ Positionen ab (oder wurden keine
 * Positionen erkannt), gilt der Total-Betrag als eine Sammelposition, damit
 * Σ Tageslieferungen immer dem Rechnungstotal entspricht. Mehrseitensicher
 * (Seitenkopf/-fuss unterbricht Blöcke nicht).
 */
function parseEsproLieferungen(lines: string[], profil: LieferantenProfil, mwstSatz: number): ParsedCsvRechnung[] {
  const { bloecke } = teileInBloecke(lines, /^\s*(\d{4,10}\.\d)\s+vom\s+(\d{1,2}\.\d{1,2}\.\d{2,4})\s*$/);
  // Preis + Betrag MIT Rappen (QR-/Summenzeilen-Schutz); ArtNr-Spalte frei («04 S»).
  const zeileRe = /^\s*(.+?)\s{2,}(-?\d+)\s{2,}(\S(?:.*\S)?)\s{2,}([\d’',]*\d[.,]\d{2})\s{2,}(-?[\d’',]*\d[.,]\d{2})\s*$/;
  return bloecke.map(b => {
    const positionen: WarenPosition[] = [];
    let kontrollTotal: number | null = null;
    for (const z of b.zeilen) {
      const total = new RegExp(`^\\s*Total\\s+${b.nr.replace('.', '\\.')}\\s+vom\\s+\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}\\s+(${BETRAG_RE.source})\\s*$`, 'i').exec(z);
      if (total) { kontrollTotal = parseBetrag(total[1]); continue; }
      if (/^\s*Total\b/i.test(z) || /Beschreibung\s+Menge/i.test(z)) continue;
      const m = zeileRe.exec(z);
      if (!m) continue;
      positionen.push(position(profil.kategorie, mwstSatz, {
        artNr: m[3].trim(), bezeichnung: m[1].trim(), menge: parseBetrag(m[2]) ?? 0,
        einheit: '', preis: parseBetrag(m[4]) ?? 0, positionspreis: parseBetrag(m[5]) ?? 0,
      }));
    }
    const posSumme = rundung2(positionen.reduce((s, p) => s + p.positionspreis, 0));
    if (kontrollTotal !== null && (positionen.length === 0 || Math.abs(posSumme - kontrollTotal) > 0.02)) {
      // Kontroll-Total führend: Sammelposition statt (unvollständiger) Positionen.
      return baueLieferung(profil.name, b.nr, b.datum, [position(profil.kategorie, mwstSatz, {
        artNr: '', bezeichnung: `Lieferung ${b.nr}`, menge: 1, einheit: '', preis: kontrollTotal, positionspreis: kontrollTotal,
      })], mwstSatz);
    }
    return baueLieferung(profil.name, b.nr, b.datum, positionen, mwstSatz);
  }).filter(l => l.positionen.length > 0);
}

const LIEFERUNG_PARSER: Record<string, (lines: string[], p: LieferantenProfil, satz: number) => ParsedCsvRechnung[]> = {
  spahni: parseSpahniLieferungen,
  fideco: parseFidecoLieferungen,
  gasser: parseGasserLieferungen,
  gourmador: parseGourmadorLieferungen,
  bohnenblust: parseBohnenblustLieferungen,
  terravigna: parseTerravignaLieferungen,
  ambro: parseAmbroLieferungen,
  transgourmet: parseTransgourmetLieferungen,
  caporaso: parseCaporasoLieferungen,
  espro: parseEsproLieferungen,
};

// ─── Caporaso (LIEFERSCHEIN-RECHNUNG) ────────────────────────────────────────

/** «Lieferschein: L12345 vom 15.07.2026» — Lieferdatum (= Rechnungsdatum). */
const CAPORASO_LS_RE = /Lieferschein\s*:?\s*L?\s*\d{2,12}\s+vom\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i;

/**
 * MwSt-Basen aus der Rechnungssumme: Zeilen mit Satz 2.6 % oder 8.1 % und
 * einem Basis/Betrag-Paar. SELBSTVALIDIEREND (basis × Satz ≈ Betrag ±0.06),
 * damit Positionszeilen mit zufälligen Prozentangaben nie mitzählen —
 * unabhängig von der Spaltenreihenfolge des Layouts.
 */
export function caporasoMwstBasen(text: string): MwstKlasse[] {
  const proSatz = new Map<number, MwstKlasse>();
  for (const line of text.split('\n')) {
    // Nur echte MwSt-Zusammenfassungszeilen — Positions-/Rabattzeilen mit
    // zufällig passendem Prozentbetrag dürfen NIE eine Basis stellen.
    if (!/mwst|mehrwertsteuer|\bvat\b|\btva\b/i.test(line)) continue;
    if (/rabatt|skonto|zuschlag/i.test(line)) continue;
    const rm = /(0(?:[.,]0+)?|2[.,]60?|8[.,]10?)\s*%/.exec(line);
    if (!rm) continue;
    const parsedSatz = parseBetrag(rm[1]);
    if (parsedSatz === null) continue;
    const satz = Math.round(parsedSatz * 10) / 10;
    const rest = line.slice(rm.index + rm[0].length);
    const vor = line.slice(0, rm.index);
    // Kandidaten: alle Beträge der Zeile ausser der Satz-Angabe selbst.
    const nums = [...vor.matchAll(/-?[\d’'.,]*\d/g), ...rest.matchAll(/-?[\d’'.,]*\d/g)]
      .map(m => parseBetrag(m[0]))
      .filter((n): n is number => n !== null && Math.abs(n) > 0.005);
    let paar: { basis: number; betrag: number } | null = null;
    // Bei 0 % ist der gedruckte Steuerbetrag ebenfalls 0 und wird oben
    // absichtlich aus der Kandidatenliste entfernt. Die Basis nach «von» ist
    // trotzdem eine echte, explizite Steuerklasse.
    if (satz === 0) {
      const von = new RegExp(`\\bvon\\s+(${BETRAG_RE.source})`, 'i').exec(line);
      // Manche Caporaso-Layouts haben kein «von» und zeigen nur
      // «MwSt 0.00 %  175.00  0.00». Da die Zeile bereits als MwSt-Summe
      // erkannt ist, ist ihr einziger nicht-null Betrag die Basis.
      const basis = von ? parseBetrag(von[1]) : nums[0] ?? null;
      if (basis !== null && basis >= 0) paar = { basis, betrag: 0 };
    }
    for (const basis of nums) {
      if (paar) break;
      for (const betrag of nums) {
        if (basis === betrag) continue;
        if (Math.abs(rundung2(basis * satz / 100) - betrag) <= 0.06 && Math.abs(basis) > Math.abs(betrag)) {
          paar = { basis, betrag };
          break;
        }
      }
      if (paar) break;
    }
    // Pro Satz nur EINMAL zählen (Wiederholung z.B. auf Folgeseite/QR-Teil).
    if (paar && !proSatz.has(satz)) proSatz.set(satz, { satz, ...paar });
  }
  return [...proSatz.values()];
}

interface CaporasoVergleich {
  menge: number;
  einheit: string;
  preis: number;
}

/**
 * Caporaso druckt unter vielen Verpackungsartikeln einen aussagekräftigeren
 * Vergleichspreis («Sack à 25 kg  1.70 / Kg.» bzw. «Karton à 6 Beutel …
 * 4.00 / Stück»). Für die Preisüberwachung wird diese Basis verwendet; Menge
 * und Einheit werden dazu auf kg/Stück normalisiert. Der Positionsbetrag
 * bleibt stets die autoritative Rechnungszeile.
 */
function caporasoVergleich(
  folgezeilen: string[],
  hauptMenge: number,
  hauptEinheit: string,
  hauptPreis: number,
): CaporasoVergleich {
  for (const zeile of folgezeilen) {
    const vergleich = /([\d’'.,]+)\s*\/\s*(Kg|St(?:ü|ue)ck)\.?\s*$/i.exec(zeile);
    if (!vergleich) continue;
    const preis = parseBetrag(vergleich[1]);
    if (preis === null || preis <= 0) continue;
    const einheit = /^kg$/i.test(vergleich[2]) ? 'KG' : 'STK';
    let menge = hauptMenge;
    if (einheit === 'KG') {
      // «Stück à 500 g» / «Sack à 25 kg» — die letzte Gewichtsangabe vor
      // dem Vergleichspreis beschreibt die Basis pro Haupt-Einheit.
      const gewichte = [...zeile.matchAll(/(?:à|x)\s*([\d.,]+)\s*(kg|g)\b/gi)];
      const gewicht = gewichte.at(-1);
      if (gewicht) {
        const n = parseBetrag(gewicht[1]);
        if (n !== null && n > 0) menge = rundung2(hauptMenge * (gewicht[2].toLowerCase() === 'g' ? n / 1000 : n));
      }
    } else {
      // «Karton à 4 Schale» / «Karton à 100 Stück» / «Karton à 6 Beutel».
      const pack = /\bKarton\s+à\s+([\d.,]+)\b/i.exec(zeile);
      const faktor = pack ? parseBetrag(pack[1]) : null;
      if (faktor !== null && faktor > 0) menge = rundung2(hauptMenge * faktor);
    }
    return { menge, einheit, preis };
  }
  return { menge: hauptMenge, einheit: hauptEinheit.replace(/\.$/, '').toUpperCase(), preis: hauptPreis };
}

/**
 * Caporaso: EINE Lieferung mit echten Artikelzeilen. Die MwSt-Klasse der
 * Position steuert weiterhin unverändert den Konto-Split:
 * 2.6 % → «Küche», 8.1 % → «Betriebsmaterial».
 */
function parseCaporasoLieferungen(lines: string[], p: LieferantenProfil): ParsedCsvRechnung[] {
  const text = lines.join('\n');
  const nr = suche(text, [/LIEFERSCHEIN-?RECHNUNG\s*:?\s*(\d{4,12})/i]);
  const datum = parseDatumCH(suche(text, [CAPORASO_LS_RE]) ?? '');
  if (!nr || !datum) return [];
  // pos, Art-Nr, Menge, Einheit, Bezeichnung, PE, Einzelpreis, MwSt-Satz,
  // optional Rabatt-%, Positionsbetrag. Art-Nr ist das harte Struktursignal;
  // Summen-, Rabatt- und QR-Zeilen können deshalb nicht als Artikel matchen.
  const zeileRe = /^\s*(?:TK\s+)?\d{1,3}\.\d{1,3}\s+([A-Z0-9.-]{4,20})\s+(-?[\d’'.,]+)\s+([A-Za-zÄÖÜäöü.]+)\s+(.+?)\s+(\d+(?:[.,]\d+)?)\s+(-?[\d’'.,]+)\s+(2[.,]60?|8[.,]10?)\s*%\s+(?:(-?[\d’'.,]+)\s*%\s+)?(-?[\d’'.,]+)\s*$/i;
  const positionen: WarenPosition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = zeileRe.exec(lines[i]);
    if (!m) continue;
    const hauptMenge = parseBetrag(m[2]);
    const hauptPreis = parseBetrag(m[6]);
    const satz = parseBetrag(m[7].replace(',', '.'));
    const positionspreis = parseBetrag(m[9]);
    // Gratis-/Abverkaufszeilen mit 0.00 sind keine belastbare Preisbeobachtung
    // und verändern die Rechnungssumme nicht.
    if (hauptMenge === null || hauptPreis === null || satz === null || positionspreis === null || positionspreis === 0) continue;
    const folgezeilen: string[] = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      if (zeileRe.test(lines[j]) || /^Lieferschein:|^Netto-Betrag|^\s*\d[\d’'.,]*\s*$/i.test(lines[j])) break;
      folgezeilen.push(lines[j]);
    }
    const vergleich = caporasoVergleich(folgezeilen, hauptMenge, m[3], hauptPreis);
    positionen.push(position(satz === 8.1 ? 'Betriebsmaterial' : 'Küche', satz, {
      artNr: m[1],
      bezeichnung: m[4].trim(),
      menge: vergleich.menge,
      einheit: vergleich.einheit,
      preis: vergleich.preis,
      positionspreis,
    }));
  }
  if (positionen.length === 0) return [];

  // Caporaso rundet die MwSt im Summenblock pro Steuerklasse. Die Summe der
  // einzeln auf Rappen gerundeten Artikelsteuern kann deshalb je Klasse um
  // wenige Rappen abweichen. Der gedruckte Klassenbetrag ist autoritativ; die
  // Differenz wird deterministisch auf die letzte Position derselben Klasse
  // gelegt, damit Positions-, Konto- und Rechnungs-Brutto deckungsgleich sind.
  const basen = caporasoMwstBasen(text);
  for (const basis of basen) {
    const warengruppe = basis.satz === 8.1 ? 'Betriebsmaterial' : 'Küche';
    const indices = positionen.map((pos, index) => pos.warengruppe === warengruppe ? index : -1).filter(index => index >= 0);
    if (indices.length === 0) continue;
    const nettoKlasse = rundung2(indices.reduce((summe, index) => summe + positionen[index].positionspreis, 0));
    if (Math.abs(nettoKlasse - basis.basis) > 0.05) {
      throw new Error(`Caporaso MwSt-Basis ${basis.satz}% nicht durch Artikel gedeckt`);
    }
    const mwstKlasse = rundung2(indices.reduce((summe, index) => summe + positionen[index].mwstBetrag, 0));
    const delta = rundung2(basis.betrag - mwstKlasse);
    if (delta !== 0) {
      const index = indices[indices.length - 1];
      positionen[index] = { ...positionen[index], mwstBetrag: rundung2(positionen[index].mwstBetrag + delta) };
    }
  }
  return [baueLieferung(p.name, nr, datum, positionen, p.mwstSatz ?? 2.6)];
}

// ─── Hauptfunktion ───────────────────────────────────────────────────────────

export function parseProfilPdf(text: string, profile: LieferantenProfil[]): ProfilPdfErgebnis {
  const lines = text.split('\n');
  const { profil, mwstNrn } = findeProfilImText(text, profile);
  const hinweise: string[] = [];
  const belegart = erkenneBelegart(text);
  const kopfFn = profil ? KOPF_PARSER[profil.id] : undefined;
  const kopf = kopfFn ? kopfFn(text, lines) : generischerKopf(text);
  let { netto, mwst } = kopf;
  // Mehrere gedruckte Klassen dürfen nie in einen rechnerischen Mischsatz
  // umgewandelt werden. Ohne exakt extrahierbare Klassen bleibt ein generischer
  // Mischbeleg fail-closed statt mit einem Profil-Defaultsatz falsch zu buchen.
  const hatGemischteKlassen =
    (kopf.mwstKlassen?.length ?? 0) > 1 ||
    // Bei einem nicht zuordenbaren, generischen Beleg gibt es keinen sicheren
    // Profil-Defaultsatz. Bekannte Detailparser werten ihre Positionen selbst
    // aus und dürfen nicht durch Prozentangaben in Artikelzeilen blockieren.
    kopf.gemischteMwstSaetze === true;
  const mwstSatz = hatGemischteKlassen
    ? null
    : kopf.mwstSatz ?? satzAusBetraegen(netto, mwst) ?? profil?.mwstSatz ?? null;
  if (netto !== null && mwst === null && mwstSatz !== null) mwst = rundung2(netto * mwstSatz / 100);
  if (netto === null && mwst !== null && mwstSatz) netto = rundung2(mwst / (mwstSatz / 100));

  // Stufe 2: Positionen je Lieferung (wo Profil-Parser vorhanden)
  let lieferungen: ParsedCsvRechnung[] = [];
  if (profil?.parser && (mwstSatz !== null || kopf.gemischteMwstSaetze === true || profil.id === 'caporaso')) {
    try { lieferungen = LIEFERUNG_PARSER[profil.parser](lines, profil, mwstSatz ?? profil.mwstSatz ?? 0); }
    catch {
      hinweise.push(profil.id === 'ambro' || profil.id === 'caporaso'
        ? 'Artikeldetails verworfen — Positionen konnten nicht vollständig mit den Rechnungswerten abgeglichen werden; Rechnung wird über die Kopfwerte gebucht.'
        : 'Positionen konnten nicht gelesen werden — Kopf-Buchung als Ganzes.');
    }
  }
  if (lieferungen.length > 0 && netto !== null) {
    const summe = rundung2(lieferungen.reduce((s, l) => s + l.nettoTotal, 0));
    if (Math.abs(summe - netto) > 0.05) {
      if (profil?.id === 'ambro' || profil?.id === 'caporaso') {
        // Für diese beiden Detailprofile nie teilweise Artikel persistieren:
        // Kopfwerte bleiben autoritativ, Artikeldetails werden fail-closed
        // verworfen, bis das Layout sicher vollständig gelesen werden kann.
        lieferungen = [];
        hinweise.push(`Positionssumme ${summe.toFixed(2)} ≠ Rechnungs-Netto ${netto.toFixed(2)} — Artikeldetails verworfen; Rechnung wird über die Kopfwerte gebucht.`);
      } else {
        hinweise.push(`Positionssumme ${summe.toFixed(2)} ≠ Rechnungs-Netto ${netto.toFixed(2)} — bitte prüfen.`);
      }
    }
  }
  if (lieferungen.length > 0 && (kopf.mwstKlassen?.length ?? 0) > 0) {
    const positionen = lieferungen.flatMap(lieferung => lieferung.positionen);
    const erwartet = new Map<number, { basis: number; betrag: number }>();
    for (const klasse of kopf.mwstKlassen!) {
      const alt = erwartet.get(klasse.satz) ?? { basis: 0, betrag: 0 };
      erwartet.set(klasse.satz, {
        basis: rundung2(alt.basis + klasse.basis),
        betrag: rundung2(alt.betrag + klasse.betrag),
      });
    }
    const erhalten = new Map<number, { basis: number; betrag: number }>();
    for (const position of positionen) {
      if (position.mwstSatz === undefined) continue;
      const alt = erhalten.get(position.mwstSatz) ?? { basis: 0, betrag: 0 };
      erhalten.set(position.mwstSatz, {
        basis: rundung2(alt.basis + position.positionspreis),
        betrag: rundung2(alt.betrag + position.mwstBetrag),
      });
    }
    const saetze = new Set([...erwartet.keys(), ...erhalten.keys()]);
    const klassenDecken = [...saetze].every(satz => {
      const soll = erwartet.get(satz) ?? { basis: 0, betrag: 0 };
      const ist = erhalten.get(satz) ?? { basis: 0, betrag: 0 };
      return Math.abs(soll.basis - ist.basis) <= 0.05 && Math.abs(soll.betrag - ist.betrag) <= 0.05;
    });
    if (!klassenDecken) {
      lieferungen = [];
      hinweise.push('Artikeldetails verworfen — ihre MwSt-Klassen decken die gedruckte MwSt-Zusammenfassung nicht.');
    }
  }
  const positionenErkannt = lieferungen.length > 0;

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
    if (kopf.hinweise?.length) hinweise.push(...kopf.hinweise);
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
    netto, mwst, mwstSatz, mwstKlassen: kopf.mwstKlassen ?? [],
    brutto: netto !== null && mwst !== null ? rundung2(netto + mwst) : null,
    lieferungen, positionenErkannt, belegart,
    dokumenttyp: (() => {
      const dt = erkenneDokumenttyp(text, belegart);
      // Spahni: RECHNUNGEN sind IMMER finale Monatsrechnungen — auch mit nur
      // EINER Lieferung. Einzel-Lieferscheine (ohne «RECHNUNG»-Kopf, Nr aus
      // «Liefersch./Kd.-Nr.») bleiben provisorisch (dt bleibt null/lieferschein).
      if (dt === null && profil?.id === 'spahni' && belegart === 'rechnung'
        && /RECHNUNG\s*:\s*\d{4,10}/.test(kopfzone(text))) return 'monatsrechnung';
      // Gourmador: die FAKTURA ist IMMER die massgebliche Monatsrechnung —
      // auch mit nur EINER «Beleg-Nr. … vom …»-Lieferung. Einzel-Lieferscheine
      // (explizite «Lieferschein»-Überschrift) bleiben provisorisch (dt gesetzt).
      if (dt === null && profil?.id === 'gourmador' && belegart === 'rechnung'
        && /Beleg-Nr\.\s+\d{6,10}\s+vom\s+\d{1,2}\./i.test(text)) return 'monatsrechnung';
      // Bohnenblust: die Rechnung («Rechnungsnummer: …») ist IMMER die massgeb-
      // liche Monatsrechnung — auch mit nur EINEM Lieferschein-/Nachlieferungs-
      // Block. Die vielen «Lieferschein Nr. …»-Blocküberschriften lassen die
      // generische Erkennung fälschlich auf 'lieferschein' kippen («Rechnungs-
      // nummer» matcht \bRechnung\b nicht) — deshalb auch dt==='lieferschein'
      // übersteuern, sobald der Rechnungskopf vorhanden ist.
      if ((dt === null || dt === 'lieferschein') && profil?.id === 'bohnenblust' && belegart === 'rechnung'
        && /Rechnungsnummer\s*:?\s*\d{3,10}/i.test(text)
        && /(?:Lieferschein|Nachlieferung)\s+Nr\.\s+\d{4,10}\s+vom\s+\d{1,2}\./i.test(text)) return 'monatsrechnung';
      return dt;
    })(),
    hinweise,
  };
}
