/**
 * Personaleintritt — PDF-Feld-Mapping (reine Logik, kein IO, kein pdf-lib)
 * ========================================================================
 * Bildet einen PersonaleintrittRecord auf die AcroForm-Feldnamen der beiden
 * L-GAV-Vertragsvorlagen (SL = Stundenlohn, ML = Monatslohn) ab.
 *
 * Feldnamen stammen aus der ausgelesenen Feldliste der Original-PDFs
 * (.local/personaleintritt/pdf-feldliste.json). Die Checkbox-Defaults
 * entsprechen den beiden geprüften Referenzverträgen des Betriebs
 * (Haus-Standard); alles Unklare bleibt LEER und wird als Warnung gemeldet —
 * die GF korrigiert im editierbaren PDF, nie stilles Raten.
 */

import type { PersonaleintrittRecord } from './types';
import { SL_ZUSCHLAEGE, rundeLohn } from './lohn';
import { bewilligungErforderlichEffektiv } from './behoerden-meldung';
import { arbeitgeberZeile } from './betriebs-config';

// ─── Ergebnis ────────────────────────────────────────────────────────────────

export interface PdfFillMap {
  /** Textfelder: AcroForm-Name → Wert (leerer String = Feld leeren). */
  text: Record<string, string>;
  /** Checkboxen: AcroForm-Name → angekreuzt ja/nein. */
  checkboxes: Record<string, boolean>;
  /** Punkte, die die GF im editierbaren PDF prüfen/ergänzen muss. */
  warnungen: string[];
}

// ─── Formatierung (de-CH) ────────────────────────────────────────────────────

/** CHF-Betrag mit Apostroph-Tausendertrennung, 2 Dezimalstellen (4’600.00). */
export function formatChfPdf(wert: number): string {
  const [ganz, dez] = wert.toFixed(2).split('.');
  const mitSep = ganz.replace(/\B(?=(\d{3})+(?!\d))/g, '\u2019');
  return `${mitSep}.${dez}`;
}

/** ISO-Datum (YYYY-MM-DD) → dd.MM.yyyy; ungültig/leer ⇒ ''. */
export function formatDatumPdf(iso: string | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '';
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** Fliesstext in Zeilen von max. `breite` Zeichen umbrechen (Wortgrenzen). */
export function wrapZeilen(text: string, breite: number, maxZeilen: number): string[] {
  const zeilen: string[] = [];
  for (const absatz of text.split(/\r?\n/)) {
    let rest = absatz.trim();
    if (rest === '') continue;
    while (rest.length > breite && zeilen.length < maxZeilen) {
      let cut = rest.lastIndexOf(' ', breite);
      if (cut <= 0) cut = breite;
      zeilen.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    if (zeilen.length < maxZeilen && rest !== '') zeilen.push(rest);
    if (zeilen.length >= maxZeilen) break;
  }
  return zeilen;
}

// ─── Standard-Bemerkungen (Anpassung 6 — automatisch in JEDEN Vertrag) ───────

/** Fixe Standard-Bemerkungen (Ziffer «13 Besondere Vereinbarungen»). */
export const STANDARD_BEMERKUNGEN = [
  'Arztzeugnisse werden ab dem 1. Tag bei Fehlen verlangt.',
  'Stundenblätter müssen nach Abgabe innerhalb von 7 Tagen unterschrieben retourniert werden, ansonsten werden die Stunden als bestätigt angenommen.',
] as const;

/** Zusatz nur bei erforderlicher Arbeitsbewilligung (Anpassung 5/6). */
export const BEMERKUNG_ARBEITSBEWILLIGUNG =
  'Dieser Arbeitsvertrag erreicht seine Gültigkeit erst bei einer Arbeitserlaubnis.';

/** Standard-Bemerkungen + Bewilligungs-Zusatz + GF-Freitext (in dieser Reihenfolge). */
export function bemerkungenFuerVertrag(record: PersonaleintrittRecord): string[] {
  const zeilen: string[] = [...STANDARD_BEMERKUNGEN];
  if (bewilligungErforderlichEffektiv(record)) zeilen.push(BEMERKUNG_ARBEITSBEWILLIGUNG);
  const frei = record.maDaten?.vertrag?.besondere_vereinbarungen?.trim();
  if (frei) zeilen.push(frei);
  return zeilen;
}

// ─── Haus-Konstanten (aus den Referenzverträgen; GF-editierbar im PDF) ───────

/** Standard-Abzugssätze in % (Stand Referenzverträge). */
const ABZUG_AHV = '5.3';
const ABZUG_ALV = '1.1';
const ABZUG_BVG = '7';
const ABZUG_KTG = '8.25';
const VOLLZUGSKOSTEN_JAHR = '99';

// ─── Hauptfunktion ───────────────────────────────────────────────────────────

export function buildPdfFillMap(record: PersonaleintrittRecord, heuteIso?: string): PdfFillMap {
  const text: Record<string, string> = {};
  const checkboxes: Record<string, boolean> = {};
  const warnungen: string[] = [];

  const typ = record.vertragstyp;
  const p = record.maDaten?.personalien ?? {};
  const v = record.maDaten?.vertrag ?? {};
  const l = record.maDaten?.lohnprogramm ?? {};

  // ── Arbeitgeber (zentrale Betriebs-Config, Auftrag Punkt 8) ──
  const agZeile = arbeitgeberZeile(record.restaurantId);
  if (agZeile) {
    text['zwischen'] = agZeile;
  } else {
    text['zwischen'] = record.betrieb ?? '';
    warnungen.push('Arbeitgeber-Zeile («zwischen …») bitte im PDF prüfen — für diesen Betrieb ist keine juristische Adresszeile hinterlegt (betriebs-config.ts ergänzen).');
  }

  // ── Personalien ──
  const nameVorname = [p.vorname, p.name].filter(Boolean).join(' ').trim();
  text['NameVorname'] = nameVorname;
  if (!nameVorname) warnungen.push('Name/Vorname fehlt.');
  text['Strasse'] = p.strasse ?? '';
  text['PLZOrt'] = [p.plz, p.ort].filter(Boolean).join(' ').trim();
  text['Telefon'] = p.telefon ?? '';
  text['Handy'] = '';
  text['Geburtsdatum'] = formatDatumPdf(p.geburtsdatum);
  text['Zivilstand'] = l.zivilstand ?? '';
  const kinder = l.kinder ?? [];
  text['Anzahl Kinder'] = kinder.length > 0 ? String(kinder.length) : '-';
  text['Krankenkasse vom Mitarbeitenden selbst abgeschlossen'] = '';
  text['Ausländerausweis'] = l.aufenthaltsbewilligung ?? '';
  text['AHVNr'] = l.ahv_nr ?? '';
  text['EMail'] = p.email ?? '';

  // ── Eckdaten ──
  text['Vertragsbeginn'] = formatDatumPdf(record.eintritt);
  if (typ === 'ML' && record.pensumProzent != null && record.pensumProzent < 100) {
    text['Funktion'] = `${record.funktion ?? ''} (${record.pensumProzent}%)`.trim();
  } else {
    text['Funktion'] = record.funktion ?? '';
  }

  // ── Probezeit / Kündigungsfrist ──
  if (record.probezeitTage === 0) {
    // Option «Keine» (Auftrag Punkt 3): Feld bewusst leer + sichtbarer Hinweis.
    text['Die Probezeit beträgt'] = '';
    warnungen.push('Keine Probezeit vereinbart — Ziffer Probezeit im PDF prüfen/streichen.');
  } else if (record.probezeitTage != null && record.probezeitTage > 0) {
    const monate = record.probezeitTage / 30;
    if (Number.isInteger(monate)) {
      text['Die Probezeit beträgt'] = String(monate);
    } else {
      text['Die Probezeit beträgt'] = '';
      warnungen.push(`Probezeit ${record.probezeitTage} Tage ist kein ganzer Monatswert — bitte im PDF eintragen.`);
    }
  }
  if (v.kuendigungsfrist) text['die Kündigungsfrist beträgt'] = v.kuendigungsfrist;

  // ── Vertragsdauer ──
  if (record.vertragsdauer === 'befristet') {
    warnungen.push('Befristeter Vertrag: Ziffer Vertragsdauer (Checkboxen b/c und Befristungsdatum) im PDF manuell ausfüllen.');
    if (record.befristetBis) {
      warnungen.push(`Befristet bis ${formatDatumPdf(record.befristetBis)}.`);
    }
  } else {
    checkboxes['a'] = true; // unbefristet (Haus-Standard, beide Referenzverträge)
  }

  // ── Haus-Standard-Checkboxen (beide Referenzverträge identisch) ──
  checkboxes['aa Der Mitarbeitende stimmt einer Beschäftigung in einem Raucherbetrieb oder'] = true;
  checkboxes['d'] = true;
  checkboxes['a_3'] = true;
  checkboxes['g'] = true;   // Berufsausbildung: «mit anderem Zertifikat/ohne» — GF prüft bei EFZ/EBA
  checkboxes['c_4'] = true;
  checkboxes['b_6'] = true;
  checkboxes['aa 24 7 Uhr'] = true;

  // ── Abzugssätze (Haus-Standard) ──
  text['undefined'] = ABZUG_AHV;
  text['Arbeitslosenversicherung'] = ABZUG_ALV;
  text['undefined_2'] = ABZUG_BVG;

  // ── Ort/Datum ──
  const heute = heuteIso ?? new Date().toISOString().slice(0, 10);
  text['undefined_4'] = `Bern, ${formatDatumPdf(heute)}`;

  // ── Besondere Vereinbarungen (Standard-Bemerkungen + GF-Freitext) ──
  const maxVereinbarungen = typ === 'ML' ? 13 : 11;
  const vereinbarungsText = bemerkungenFuerVertrag(record).join('\n');
  if (vereinbarungsText) {
    const alleZeilen = wrapZeilen(vereinbarungsText, 60, Number.MAX_SAFE_INTEGER);
    alleZeilen.slice(0, maxVereinbarungen).forEach((z, i) => {
      text[`13 Besondere Vereinbarungen ${i + 1}`] = z;
    });
    if (alleZeilen.length > maxVereinbarungen) {
      warnungen.push('Besondere Vereinbarungen sind länger als der Platz im PDF — bitte kürzen/prüfen.');
    }
  }

  // ── Lohn + typ-spezifische Felder ──
  if (typ === 'SL') {
    fillSl(record, text, checkboxes, warnungen);
  } else if (typ === 'ML') {
    fillMl(record, v, text, checkboxes, warnungen);
  } else {
    warnungen.push('Vertragstyp fehlt — Lohnfelder nicht ausgefüllt.');
  }

  return { text, checkboxes, warnungen };
}

// ─── SL (Stundenlohn) ────────────────────────────────────────────────────────

function fillSl(
  record: PersonaleintrittRecord,
  text: Record<string, string>,
  checkboxes: Record<string, boolean>,
  warnungen: string[],
): void {
  if (record.lohnBerechnet == null) {
    warnungen.push('Kein berechneter Lohn vorhanden — Lohnfelder leer.');
  } else {
    const basis = rundeLohn(record.lohnBerechnet);
    const ferien = rundeLohn(basis * SL_ZUSCHLAEGE.ferien);
    const feiertag = rundeLohn(basis * SL_ZUSCHLAEGE.feiertag);
    const dreizehnter = rundeLohn(basis * SL_ZUSCHLAEGE.dreizehnter);
    const total = rundeLohn(basis + ferien + feiertag + dreizehnter);
    text['Fr'] = formatChfPdf(basis);
    text['Fr_2'] = formatChfPdf(ferien);
    text['Fr_3'] = formatChfPdf(feiertag);
    text['Fr_4'] = formatChfPdf(dreizehnter);
    text['Fr_5'] = formatChfPdf(total);
  }
  // Zuschlags-Prozentsätze (Beschriftungsfelder im PDF)
  text['Ferien'] = (SL_ZUSCHLAEGE.ferien * 100).toFixed(2);
  text['Feiertag'] = (SL_ZUSCHLAEGE.feiertag * 100).toFixed(2);
  text['13.ML'] = (SL_ZUSCHLAEGE.dreizehnter * 100).toFixed(2);
  // KTG-Satz + Vollzugskostenbeitrag (SL-Feldnamen)
  text['Fr_15'] = ABZUG_KTG;
  text['Fr_20'] = VOLLZUGSKOSTEN_JAHR;
  // Zahlungsweise (Haus-Standard SL)
  checkboxes['c_5'] = true;
}

// ─── ML (Monatslohn) ─────────────────────────────────────────────────────────

function fillMl(
  record: PersonaleintrittRecord,
  vertrag: { wochenstunden?: number },
  text: Record<string, string>,
  checkboxes: Record<string, boolean>,
  warnungen: string[],
): void {
  const pensum = record.pensumProzent ?? 100;
  checkboxes['a für Vollzeitmitarbeiterin'] = pensum >= 100;
  checkboxes['b für Teilzeitmitarbeiterin mit regelmässigem festgelegtem Arbeitspensum'] = pensum < 100;

  if (record.lohnBerechnet == null) {
    warnungen.push('Kein berechneter Lohn vorhanden — Lohnfelder leer.');
  } else {
    const basis = rundeLohn(record.lohnBerechnet);
    const dreizehnter = rundeLohn(basis * SL_ZUSCHLAEGE.dreizehnter);
    const total = rundeLohn(basis + dreizehnter);
    text['Fr'] = formatChfPdf(basis);
    text['Fr_2'] = formatChfPdf(dreizehnter);
    text['Fr_3'] = formatChfPdf(total);
  }

  // Wochenstunden (Vollzeitbasis 42 h)
  const wochenstunden = vertrag.wochenstunden ?? (pensum >= 100 ? 42 : undefined);
  if (wochenstunden != null) {
    text['Stunden unter 42 Stunden bei Kleinbetrieben unter 45 Stunden bei'] = String(wochenstunden);
  } else {
    warnungen.push('Wochenstunden fehlen (Teilzeit) — bitte im PDF eintragen.');
  }

  // KTG-Satz + Vollzugskostenbeitrag (ML-Feldnamen)
  text['Fr_13'] = ABZUG_KTG;
  text['Vollzugskostenbeitrag LGAV falls kein monatlicher Abzug Fr'] = VOLLZUGSKOSTEN_JAHR;
  // Zahlungsweise (Haus-Standard ML)
  checkboxes['b_7'] = true;
}
