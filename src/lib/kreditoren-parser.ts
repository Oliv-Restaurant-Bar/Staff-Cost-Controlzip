/**
 * kreditoren-parser – Infoniqa «Personenkonto-Auszug Kreditoren» (PDF)
 * ====================================================================
 * Liest den Kreditoren-Personenkonto-Auszug (pro Kreditor: Datum, Blg, OP,
 * Text, G-Konto, Soll, Haben, Saldo) aus den positionierten PDF-Zeilen
 * (extractPdfTextLines). Spaltenzuordnung der Beträge über X-Koordinaten
 * (Soll/Haben/Saldo-Kopfpositionen, Beträge sind rechtsbündig).
 *
 * Regeln (Spec Kreditoren-Abgleich):
 * - Nur HABEN-Buchungen = Rechnungen/Gutschriften sind relevant.
 * - SOLL mit G-Konto 1021 oder Text «Zahlungslauf» = Zahlung → ignorieren.
 * - Übrige SOLL-Buchungen (z.B. Rückvergütungen) werden als 'soll_sonstig'
 *   mitgeführt (nur Info, nie Übernahme-Vorschlag).
 * - Beträge sind INKL. MwSt (brutto).
 *
 * Debug-Logs: [KREDITOREN]
 */

import type { PositionedPdfLine } from './pdf-import-engine';

// ─── Typen ────────────────────────────────────────────────────────────────────

export type KreditorBuchungTyp = 'haben' | 'soll_zahlung' | 'soll_sonstig';

export interface KreditorBuchung {
  datum: string;          // YYYY-MM-DD
  blg?: string;
  opNr?: string;
  text: string;
  gKonto: string;         // '4070', 'div', '1021', '6510', …
  typ: KreditorBuchungTyp;
  betrag: number;         // brutto, positiv
  /** Belegnummer/Referenz (Folgezeile unter dem Text oder Nummer im Text) */
  referenz?: string;
}

export interface Kreditor {
  nr: string;
  /** Name ohne Ortszusatz (letztes «, Ort» abgeschnitten) */
  name: string;
  /** Vollständige Kopfzeile, z.B. «Metzgerei Spahni AG, Zollikofen» */
  fullName: string;
  buchungen: KreditorBuchung[];
}

export interface KreditorenAuszug {
  firma: string | null;
  /** Aus der Firma abgeleitet: «Oliv Gastro AG» → oliv, «Restaurant Beaulieu AG» → beaulieu */
  mandant: 'oliv' | 'beaulieu' | null;
  vonDatum: string | null;   // YYYY-MM-DD
  bisDatum: string | null;   // YYYY-MM-DD
  kreditoren: Kreditor[];
  warnings: string[];
  debug: {
    zeilen: number;
    buchungenTotal: number;
    habenTotal: number;
    ohneKreditor: number;
    failureReason: string | null;
  };
}

// ─── Waren-Konto-Bereich (Spec B: 4000–4070 oder 4090) ──────────────────────

export function istWarenKonto(konto: string): boolean {
  const n = Number(konto);
  if (!Number.isFinite(n)) return false;
  return (n >= 4000 && n <= 4070) || n === 4090;
}

// ─── Hilfen ──────────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

function isoDate(s: string): string | null {
  const m = DATE_RE.exec(s.trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** «1'526.65» → 1526.65 (de-CH Tausender-Apostroph; auch U+2019). */
export function parseChfAmount(s: string): number | null {
  const clean = s.replace(/[’'\u2019\s\u00a0]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export function parseKreditorenAuszug(lines: PositionedPdfLine[]): KreditorenAuszug {
  const warnings: string[] = [];
  const kreditoren: Kreditor[] = [];

  let firma: string | null = null;
  let vonDatum: string | null = null;
  let bisDatum: string | null = null;

  // Spaltenpositionen aus der Kopfzeile «Datum … Soll Haben Saldo»
  let sollX = 398, habenX = 438, saldoX = 495; // Fallback (beobachtete Werte)
  let headerGefunden = false;

  let aktuell: Kreditor | null = null;
  let letzteBuchung: KreditorBuchung | null = null;
  let buchungenTotal = 0;
  let habenTotal = 0;
  let ohneKreditor = 0;

  const closeKreditor = () => {
    if (aktuell) kreditoren.push(aktuell);
    aktuell = null;
    letzteBuchung = null;
  };

  for (const line of lines) {
    const items = [...line.items].sort((a, b) => a.x - b.x).filter(i => i.text.trim() !== '');
    if (items.length === 0) continue;
    const text = line.text.trim();

    // Kopf-Metadaten
    if (text.includes('Personenkonto-Auszug Kreditoren')) {
      const firmaItem = items.find(i => i.x > 200 && i.x < 450 && !i.text.includes('Seite'));
      if (firmaItem && !firma) firma = firmaItem.text.trim();
      continue;
    }
    if (text.startsWith('Auszug vom')) {
      const dates = items.map(i => isoDate(i.text)).filter(Boolean) as string[];
      if (dates.length >= 2 && !vonDatum) { vonDatum = dates[0]; bisDatum = dates[1]; }
      continue;
    }
    if (/^Datum\b/.test(text) && text.includes('Soll') && text.includes('Haben')) {
      for (const it of items) {
        const t = it.text.trim();
        if (t === 'Soll') sollX = it.x;
        else if (t === 'Haben') habenX = it.x;
        else if (t === 'Saldo') saldoX = it.x;
      }
      headerGefunden = true;
      continue;
    }
    if (text.startsWith('Saldo Vortrag')) { letzteBuchung = null; continue; }
    if (/^Totale\b/.test(text) || items[0]?.text.trim() === 'Totale') { closeKreditor(); continue; }

    const first = items[0];

    // Kreditor-Kopf: Nr (x < 100, ganze Zahl) + Name (x ≈ 141)
    if (first.x < 100 && /^\d{1,5}$/.test(first.text.trim()) && items.length >= 2
        && items[1].x > 120 && items[1].x < 200 && !isoDate(items[1].text)) {
      closeKreditor();
      const fullName = items.slice(1).map(i => i.text.trim()).join(' ').trim();
      const name = fullName.replace(/,\s*[^,]*$/, '').trim() || fullName;
      aktuell = { nr: first.text.trim(), name, fullName, buchungen: [] };
      continue;
    }

    // Buchungszeile: beginnt mit Datum
    const datum = first.x < 100 ? isoDate(first.text) : null;
    if (datum) {
      // Grenzen für Betrags-Spalten (Mittelwerte der Kopfpositionen)
      const grenzeSollHaben = (sollX + habenX) / 2;
      const grenzeHabenSaldo = (habenX + saldoX) / 2;

      let blg: string | undefined;
      let opNr: string | undefined;
      const textTeile: string[] = [];
      let gKonto = '';
      let soll: number | null = null;
      let haben: number | null = null;

      for (const it of items.slice(1)) {
        const t = it.text.trim();
        if (it.x < 140) { blg = t; continue; }
        if (it.x < 185) { opNr = t; continue; }
        if (it.x < 322) { textTeile.push(t); continue; }
        if (it.x < 360) { gKonto = t; continue; }
        const betrag = parseChfAmount(t);
        if (betrag === null) { textTeile.push(t); continue; }
        if (it.x < grenzeSollHaben) soll = betrag;
        else if (it.x < grenzeHabenSaldo) haben = betrag;
        // sonst: Saldo → ignorieren
      }

      const btext = textTeile.join(' ').trim();
      let typ: KreditorBuchungTyp;
      let betrag: number;
      if (haben !== null) { typ = 'haben'; betrag = haben; }
      else if (soll !== null) {
        betrag = soll;
        typ = (gKonto === '1021' || /zahlungslauf/i.test(btext)) ? 'soll_zahlung' : 'soll_sonstig';
      } else {
        // Zeile ohne Bewegungsbetrag (nur Saldo?) → überspringen
        letzteBuchung = null;
        continue;
      }

      const buchung: KreditorBuchung = { datum, blg, opNr, text: btext, gKonto, typ, betrag };
      // Referenz aus dem Text (z.B. «Transgourmet 63726180»)
      const refImText = /(\d{5,})\s*$/.exec(btext);
      if (refImText) buchung.referenz = refImText[1];

      buchungenTotal++;
      if (typ === 'haben') habenTotal++;

      if (aktuell) { aktuell.buchungen.push(buchung); letzteBuchung = buchung; }
      else { ohneKreditor++; letzteBuchung = null; }
      continue;
    }

    // Folgezeile: einzelnes Item in der Text-Spalte → Referenz zur letzten Buchung
    if (letzteBuchung && items.length === 1 && first.x > 150 && first.x < 322) {
      const ref = first.text.trim();
      if (ref && !/^Totale/.test(ref)) {
        letzteBuchung.referenz = ref;
      }
      continue;
    }
  }
  closeKreditor();

  let failureReason: string | null = null;
  if (!headerGefunden) failureReason = 'Keine Kopfzeile «Datum … Soll Haben Saldo» gefunden — ist das ein Infoniqa Kreditoren-Personenkonto-Auszug?';
  else if (kreditoren.length === 0) failureReason = 'Keine Kreditoren erkannt (Kopfzeilen «Nr Name, Ort» fehlen).';
  else if (buchungenTotal === 0) failureReason = 'Kreditoren erkannt, aber keine Buchungszeilen (Datum-Zeilen) gelesen.';
  if (ohneKreditor > 0) warnings.push(`${ohneKreditor} Buchungszeilen ohne zugeordneten Kreditor übersprungen.`);

  const mandant = firma?.toLowerCase().includes('oliv') ? 'oliv'
    : firma?.toLowerCase().includes('beaulieu') ? 'beaulieu'
    : null;

  console.log(`[KREDITOREN] Parser: ${kreditoren.length} Kreditoren, ${buchungenTotal} Buchungen (${habenTotal} Haben), Firma=${firma ?? '?'}, ${vonDatum ?? '?'}–${bisDatum ?? '?'}`);

  return {
    firma, mandant, vonDatum, bisDatum, kreditoren, warnings,
    debug: { zeilen: lines.length, buchungenTotal, habenTotal, ohneKreditor, failureReason },
  };
}

// ─── Analyse: Waren-Vorschlag + Abrechnungsmodell ────────────────────────────

export type AbrechnungsModell = 'monatsrechnung' | 'halbmonatlich' | 'einzelrechnungen';

export interface KreditorAnalyse {
  kreditor: Kreditor;
  /** Nur Haben-Buchungen (= Rechnungen/Gutschriften) */
  rechnungen: KreditorBuchung[];
  habenSumme: number;
  /** Haben-Buchungen je 40xx-Warenkonto */
  kontoCounts: Record<string, number>;
  hatDiv: boolean;
  /** Alle Haben-Buchungen sind «div» (kein einziges Warenkonto) */
  nurDiv: boolean;
  /** Auto-Vorschlag: mind. 1 Haben-Buchung auf ein Warenkonto 4000–4070/4090 */
  warenVorschlag: boolean;
  /** Häufigstes Warenkonto der Haben-Buchungen */
  standardKontoVorschlag: string | null;
  modellVorschlag: AbrechnungsModell;
}

export function analysiereKreditor(kreditor: Kreditor): KreditorAnalyse {
  const rechnungen = kreditor.buchungen.filter(b => b.typ === 'haben');
  const kontoCounts: Record<string, number> = {};
  let divCount = 0;
  let nichtDivCount = 0;
  for (const b of rechnungen) {
    if (b.gKonto === 'div') { divCount++; continue; }
    nichtDivCount++;
    if (istWarenKonto(b.gKonto)) kontoCounts[b.gKonto] = (kontoCounts[b.gKonto] ?? 0) + 1;
  }
  const kontoEntries = Object.entries(kontoCounts).sort((a, b) => b[1] - a[1]);
  const habenSumme = Math.round(rechnungen.reduce((s, b) => s + b.betrag, 0) * 100) / 100;

  // Modell aus Monatsmuster: Ø Haben-Rechnungen pro Monat mit Rechnungen
  const perMonth: Record<string, number> = {};
  for (const b of rechnungen) {
    const m = b.datum.slice(0, 7);
    perMonth[m] = (perMonth[m] ?? 0) + 1;
  }
  const counts = Object.values(perMonth);
  const avg = counts.length > 0 ? counts.reduce((s, c) => s + c, 0) / counts.length : 0;
  const modellVorschlag: AbrechnungsModell = avg <= 1.34 ? 'monatsrechnung' : avg <= 2.5 ? 'halbmonatlich' : 'einzelrechnungen';

  return {
    kreditor,
    rechnungen,
    habenSumme,
    kontoCounts,
    hatDiv: divCount > 0,
    nurDiv: rechnungen.length > 0 && nichtDivCount === 0 && divCount > 0,
    warenVorschlag: kontoEntries.length > 0,
    standardKontoVorschlag: kontoEntries[0]?.[0] ?? null,
    modellVorschlag,
  };
}

export function analysiereAuszug(auszug: KreditorenAuszug): KreditorAnalyse[] {
  return auszug.kreditoren.map(analysiereKreditor);
}
