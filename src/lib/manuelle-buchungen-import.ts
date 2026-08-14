/**
 * Import «Manuelle Buchungen (CSV/Text)» — reiner Parser (testbar, kein IO)
 * =========================================================================
 * Festes, semikolon-getrenntes Schema mit Pflicht-Kopfzeile:
 *   Mandant;Lieferant;Datum;BelegNr;Kategorie;Konto;Netto;MwSt%;Bemerkung
 *
 * Regeln (siehe Auftrag):
 * - Trennzeichen: Semikolon; Tab und Komma werden toleriert (Erkennung an
 *   der Kopfzeile — dort stehen keine Beträge, das Trennzeichen ist eindeutig).
 * - Leerzeilen und Zeilen mit führendem «#» werden ignoriert.
 * - Mandant: «Oliv»/«Beaulieu» (case-insensitiv). Fremde/unbekannte Werte
 *   werden als Fehler markiert — NIE still in einen Mandanten gebucht.
 * - Datum: DD.MM.YYYY (auch DD.MM.YY → 20YY). Ungültig → Fehler, nie raten.
 * - Netto: CHF, Tausender-Apostroph/Punkt toleriert, Betrag exakt.
 * - MwSt%: nur 2.6 / 8.1 / 0 (Komma toleriert). Anderes → Fehler (kein Raten).
 * - Kategorie: Food/Beverage (case-insensitiv), sonst «Sonstiges».
 * - MwSt CHF und Brutto rechnet die App selbst (Netto × Satz).
 * - BelegNr: Referenz — alle Zeilen mit gleicher (Mandant, Lieferant, BelegNr)
 *   gehören zu EINEM Beleg (z.B. gemischte MwSt) und ersetzen beim Re-Import
 *   gemeinsam den bestehenden Beleg.
 */
import type { TenantId } from '@/contexts/TenantContext';
import type { WarenKategorie } from './waren-db';

export const MANUELLE_BUCHUNGEN_SPALTEN =
  ['Mandant', 'Lieferant', 'Datum', 'BelegNr', 'Kategorie', 'Konto', 'Netto', 'MwSt%', 'Bemerkung'] as const;

/** Erlaubte MwSt-Sätze (CH 2026). Anderes wird abgelehnt, nie interpretiert. */
const ERLAUBTE_SAETZE = [2.6, 8.1, 0];

export interface ManuelleBuchungZeile {
  /** 1-basierte Zeilennummer im Eingabetext (für Fehlermeldungen). */
  zeileNr: number;
  mandant: TenantId | null;
  mandantRoh: string;
  lieferant: string;
  /** ISO YYYY-MM-DD oder null bei ungültigem Datum. */
  datum: string | null;
  belegNr: string;
  kategorie: WarenKategorie;
  konto: string;
  netto: number | null;
  mwstSatz: number | null;
  /** Berechnet: Netto × Satz (2 Nachkommastellen) — null wenn unvollständig. */
  mwst: number | null;
  brutto: number | null;
  bemerkung: string;
  /** Leer = importierbar. Sonst: Zeile wird NICHT gebucht (klar markiert). */
  fehler: string[];
}

export interface ManuelleBuchungenErgebnis {
  zeilen: ManuelleBuchungZeile[];
  /** Struktur-Fehler (fehlende/falsche Kopfzeile o.ä.) — Import unmöglich. */
  fehler: string[];
}

const rund2 = (n: number) => Math.round(n * 100) / 100;

/** «3.08.26», «03.08.2026» → ISO; null bei allem anderen (nie raten). */
export function parseManuellesDatum(roh: string): string | null {
  const m = roh.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (!m) return null;
  const tag = Number(m[1]);
  const monat = Number(m[2]);
  const jahr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  if (monat < 1 || monat > 12 || tag < 1 || tag > 31) return null;
  const iso = `${jahr}-${String(monat).padStart(2, '0')}-${String(tag).padStart(2, '0')}`;
  // Kalender-Gegenprobe (31.02. u.ä. ablehnen)
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== tag || d.getUTCMonth() + 1 !== monat) return null;
  return iso;
}

/**
 * Betrag mit Tausender-Apostroph/-Punkt und Dezimal-Punkt/-Komma.
 * Regeln (Beträge exakt, Mehrdeutiges wird ABGELEHNT, nie umgedeutet):
 * - Apostrophe/Leerzeichen/«CHF» werden entfernt.
 * - Komma vorhanden ⇒ Komma ist das Dezimaltrennzeichen, Punkte sind
 *   Tausender («1.234.567,89» → 1234567.89).
 * - Nur Punkte: Punkt-Gruppierung gilt als TAUSENDER, wenn ALLE Gruppen nach
 *   der ersten exakt 3-stellig sind und die erste 1–3-stellig ist
 *   («1.234» → 1234, «1.234.567» → 1234567). Sonst ist ein einzelner Punkt
 *   mit 1–2 Nachkommastellen das Dezimaltrennzeichen («164.50»).
 * - Mehr als 2 Nachkommastellen oder andere Mischformen ⇒ null (ablehnen).
 */
export function parseManuellerBetrag(roh: string): number | null {
  let s = roh.trim().replace(/['’\s]/g, '').replace(/^CHF/i, '').trim();
  if (!s) return null;
  if (s.includes(',')) {
    // Komma = Dezimal, Punkte = Tausender.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes('.')) {
    const neg = s.startsWith('-');
    const teile = (neg ? s.slice(1) : s).split('.');
    if (teile.some(t => !/^\d+$/.test(t))) return null;
    if (teile.length >= 2 && teile[0].length >= 1 && teile[0].length <= 3
      && teile.slice(1).every(g => g.length === 3)) {
      // Eindeutige Schweizer Punkt-Gruppierung (auch «1.234»): Tausender.
      s = (neg ? '-' : '') + teile.join('');
    } else if (teile.length === 2 && teile[1].length <= 2) {
      // Einzelner Punkt mit 1–2 Nachstellen: Dezimaltrennzeichen.
      s = (neg ? '-' : '') + teile.join('.');
    } else {
      return null; // mehrdeutig/ungültig — nie still umdeuten
    }
  }
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseMandant(roh: string): TenantId | null {
  const s = roh.trim().toLowerCase();
  if (s === 'oliv') return 'oliv';
  if (s === 'beaulieu') return 'beaulieu';
  return null;
}

function parseKategorie(roh: string): WarenKategorie {
  const s = roh.trim().toLowerCase();
  if (s === 'food') return 'Food';
  if (s === 'beverage') return 'Beverage';
  return 'Sonstiges';
}

/** Trennzeichen anhand der Kopfzeile bestimmen (dort stehen keine Beträge). */
function erkenneTrenner(kopf: string): string {
  if (kopf.includes(';')) return ';';
  if (kopf.includes('\t')) return '\t';
  return ',';
}

export function parseManuelleBuchungen(input: string): ManuelleBuchungenErgebnis {
  const fehler: string[] = [];
  const zeilen: ManuelleBuchungZeile[] = [];
  const roheZeilen = input.split(/\r?\n/);

  // Kopfzeile suchen: erste nicht-leere, nicht-#-Zeile.
  let kopfIdx = -1;
  for (let i = 0; i < roheZeilen.length; i++) {
    const t = roheZeilen[i].trim();
    if (t === '' || t.startsWith('#')) continue;
    kopfIdx = i;
    break;
  }
  if (kopfIdx === -1) return { zeilen, fehler: ['Keine Daten gefunden.'] };

  const trenner = erkenneTrenner(roheZeilen[kopfIdx]);
  const kopf = roheZeilen[kopfIdx].split(trenner).map(s => s.trim().toLowerCase());
  const erwartet = MANUELLE_BUCHUNGEN_SPALTEN.map(s => s.toLowerCase());
  const kopfOk = erwartet.every((sp, i) => kopf[i] === sp);
  if (!kopfOk) {
    return {
      zeilen,
      fehler: [`Kopfzeile fehlt oder stimmt nicht. Erwartet: ${MANUELLE_BUCHUNGEN_SPALTEN.join(';')}`],
    };
  }

  for (let i = kopfIdx + 1; i < roheZeilen.length; i++) {
    const roh = roheZeilen[i];
    const t = roh.trim();
    if (t === '' || t.startsWith('#')) continue;
    const felder = roh.split(trenner).map(s => s.trim());
    const [mandantRoh = '', lieferant = '', datumRoh = '', belegNr = '', kategorieRoh = '',
      konto = '', nettoRoh = '', satzRoh = '', bemerkung = ''] = felder;

    const zeileFehler: string[] = [];
    const mandant = parseMandant(mandantRoh);
    if (!mandant) zeileFehler.push(`Unbekannter Mandant «${mandantRoh}» (erlaubt: Oliv, Beaulieu)`);
    if (!lieferant) zeileFehler.push('Lieferant fehlt');
    const datum = parseManuellesDatum(datumRoh);
    if (!datum) zeileFehler.push(`Ungültiges Datum «${datumRoh}» (DD.MM.YYYY)`);
    if (!belegNr) zeileFehler.push('BelegNr fehlt');
    if (!konto) zeileFehler.push('Konto fehlt');
    const netto = parseManuellerBetrag(nettoRoh);
    if (netto === null) zeileFehler.push(`Ungültiger Netto-Betrag «${nettoRoh}»`);
    const satzNum = parseManuellerBetrag(satzRoh.replace('%', ''));
    const mwstSatz = satzNum !== null && ERLAUBTE_SAETZE.includes(satzNum) ? satzNum : null;
    if (mwstSatz === null) zeileFehler.push(`Ungültiger MwSt-Satz «${satzRoh}» (erlaubt: 2.6 / 8.1 / 0)`);

    const vollstaendig = netto !== null && mwstSatz !== null;
    const mwst = vollstaendig ? rund2(netto * (mwstSatz / 100)) : null;
    const brutto = vollstaendig ? rund2(netto + (mwst ?? 0)) : null;

    zeilen.push({
      zeileNr: i + 1,
      mandant, mandantRoh: mandantRoh.trim(),
      lieferant, datum, belegNr,
      kategorie: parseKategorie(kategorieRoh),
      konto, netto, mwstSatz, mwst, brutto, bemerkung,
      fehler: zeileFehler,
    });
  }

  if (zeilen.length === 0) fehler.push('Keine Datenzeilen gefunden.');
  return { zeilen, fehler };
}

/**
 * Ersetzbarkeit bestehender Buchungen durch den manuellen Import.
 * NIE ersetzt werden:
 * - final/Monatsrechnungs-Buchungen (massgebliche Quelle im Dual-Modell),
 * - markt-gebundene Buchungen (CSV Prodega/Transgourmet: dieselbe kurze
 *   Referenz kann am selben Tag in ZWEI Märkten vorkommen — Löschen würde
 *   echte Rechnungen treffen und deren Positionen verwaisen lassen).
 * Kollidiert ein Beleg mit einer geschützten Buchung, wird die Zeile
 * ÜBERSPRUNGEN und klar markiert (nie still ersetzen oder addieren).
 */
export function istManuellErsetzbar(e: { final?: boolean; quelle?: string; markt?: string }): boolean {
  return e.final !== true && e.quelle !== 'monatsrechnung' && !e.markt;
}

/** Beleg-Schlüssel: alle Zeilen mit gleicher (Mandant, Lieferant, BelegNr)
 *  gehören zusammen und ersetzen beim Re-Import gemeinsam den Alt-Bestand. */
export function belegKey(mandant: TenantId, lieferant: string, belegNr: string): string {
  return `${mandant}|${lieferant.trim().toLowerCase()}|${belegNr.trim()}`;
}

export interface ManuelleBuchungSummen {
  netto: number;
  mwst: number;
  brutto: number;
  anzahl: number;
}

/** Summen je Mandant über die importierbaren (fehlerfreien) Zeilen. */
export function summenJeMandant(zeilen: ManuelleBuchungZeile[]): Partial<Record<TenantId, ManuelleBuchungSummen>> {
  const out: Partial<Record<TenantId, ManuelleBuchungSummen>> = {};
  for (const z of zeilen) {
    if (z.fehler.length > 0 || !z.mandant || z.netto === null) continue;
    const s = out[z.mandant] ?? { netto: 0, mwst: 0, brutto: 0, anzahl: 0 };
    s.netto = rund2(s.netto + z.netto);
    s.mwst = rund2(s.mwst + (z.mwst ?? 0));
    s.brutto = rund2(s.brutto + (z.brutto ?? 0));
    s.anzahl += 1;
    out[z.mandant] = s;
  }
  return out;
}
