/**
 * waren-abgrenzungen — TP/RB-Abgrenzungen auflösen (Umdatieren auf den
 * Leistungsmonat).
 * ===========================================================================
 * Die FIBU grenzt Rechnungen über den Monatswechsel ab: «TP RE <Lieferant>»
 * bucht den Aufwand in den Leistungsmonat (z.B. Juni), «RB TP RE <Lieferant>»
 * storniert ihn im Folgemonat (Juli), wo die echte Rechnung gebucht wird.
 * Im App liegt die Rechnung dagegen mit BELEGDATUM im Folgemonat → beide
 * Monats-WKQs weichen von der Erfolgsrechnung ab.
 *
 * Auflösung: die App-Rechnung wird auf den Leistungsmonat UMDATIERT
 * (verschoben, NIE kopiert). Nur auf Vorschlag + Bestätigung, nie automatisch.
 *
 * Zielmonat:
 *  - «RB TP RE …» (Rückbuchung, negativ) im Monat M → Leistungsmonat = M−1
 *    (dort steht der ursprüngliche TP).
 *  - «TP RE …» (positiv) im Monat M → Leistungsmonat = M (die Rechnung liegt
 *    typischerweise im Folgemonat und gehört nach M).
 *
 * Pure Logik (node-testbar) — kein IO, mandantengetrennt über die Eingaben.
 */

import type { InvoiceEntry } from './waren-db';
import type { SageJournalEntry } from '@/types/reporting';
import { buchungsBetrag } from './waren-abgleich';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** «RB TP RE …» = Rückbuchung eines transitorischen Postens. */
export function istRueckbuchung(text: string | null | undefined): boolean {
  return /^rb\s+tp\b/i.test((text ?? '').trim());
}

export function vormonat(monat: string): string {
  const [y, m] = monat.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

/** Leistungsmonat einer Abgrenzungs-Buchung (siehe Kopfkommentar). */
export function abgrenzungZielMonat(buchung: SageJournalEntry, journalMonat: string): string {
  return istRueckbuchung(buchung.text) ? vormonat(journalMonat) : journalMonat;
}

/** Belegdatum in den Zielmonat verschieben (Tag beibehalten, geklemmt). */
export function verschiebeDatumInMonat(datumIso: string, zielMonat: string): string {
  const tag = Number(datumIso.slice(8, 10)) || 1;
  const [y, m] = zielMonat.split('-').map(Number);
  const letzterTag = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${zielMonat}-${String(Math.min(tag, letzterTag)).padStart(2, '0')}`;
}

const norm = (s: string) => s.toLowerCase()
  .replace(/[^a-z0-9äöüéèàç]+/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Lieferant im Abgrenzungs-Text finden: längster normalisierter Name, der im
 * Text vorkommt (≥ 3 Zeichen). Kein Treffer → null (nie raten).
 */
export function findeAbgrenzungLieferant(text: string | null | undefined, namen: string[]): string | null {
  const t = norm(text ?? '');
  if (!t) return null;
  let best: string | null = null;
  for (const name of namen) {
    const n = norm(name);
    if (n.length < 3) continue;
    if (!t.includes(n)) continue;
    if (best === null || norm(best).length < n.length) best = name;
  }
  return best;
}

export interface AbgrenzungVorschlag {
  buchung: SageJournalEntry;
  /** |Betrag| der Abgrenzung (Vergleichsbasis für die Rechnungssuche). */
  betragAbs: number;
  /** Kanonischer Lieferant aus dem Buchungstext; null = nicht erkennbar. */
  lieferant: string | null;
  /** Leistungsmonat, in den die Rechnung gehört. */
  zielMonat: string;
  /** Passende App-Rechnungen (gleicher Lieferant, gleicher Betrag ±0.05),
   *  die NICHT bereits im Zielmonat liegen. Leer = keine gefunden. */
  kandidaten: InvoiceEntry[];
}

/**
 * Vorschläge für alle offenen Abgrenzungen eines Journal-Monats.
 * `resolve` = Alias-Resolver des Abgleichs (kanonische Lieferantennamen);
 * `invoices` = erfasste Rechnungen des Journal-Monats (Quell-Bestand).
 */
export function baueAbgrenzungVorschlaege(input: {
  offen: SageJournalEntry[];
  journalMonat: string; // YYYY-MM
  invoices: InvoiceEntry[];
  resolve: (name: string) => string;
  toleranzChf?: number;
}): AbgrenzungVorschlag[] {
  const tol = input.toleranzChf ?? 0.05;
  const namen = [...new Set(input.invoices.map(e => input.resolve(e.supplierName)))];
  return input.offen.map(buchung => {
    const betragAbs = r2(Math.abs(buchungsBetrag(buchung)));
    const lieferant = findeAbgrenzungLieferant(buchung.text, namen);
    const zielMonat = abgrenzungZielMonat(buchung, input.journalMonat);
    const kandidaten = lieferant === null ? [] : input.invoices.filter(e =>
      input.resolve(e.supplierName) === lieferant
      && e.date.slice(0, 7) !== zielMonat
      && Math.abs(e.amountNet - betragAbs) <= tol);
    return { buchung, betragAbs, lieferant, zielMonat, kandidaten };
  });
}
