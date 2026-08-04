/**
 * Personaleintritt — Arbeitsbewilligung & Behörden-Gesuch (REINE Logik)
 * =====================================================================
 * Bewilligungs-Mehrfachauswahl (Auftrag Punkt 4): drei GF-Flags (Ausweis F,
 * Ausweis S, Arbeitsbewilligung) statt der alten Ja/Nein-Frage; die Alt-Spalte
 * bewilligungErforderlich bleibt als Legacy-Input ODER-verknüpft.
 *
 * Routing (Auftrag Punkt 9):
 *   – F/S (Flag ODER Phase-2-Ausweis)      → SEM-Meldeformular (sem-formular.ts)
 *   – N (Asylbewerber, nur Phase-2-Angabe) → NICHT das SEM-Formular, aber
 *     «Bewilligung erforderlich» (Gültigkeits-Zusatz im Vertrag + Gesuch-Text)
 *   – Flag «Arbeitsbewilligung»            → wie N (kein SEM-Formular)
 *
 * Das Gesuch/die Meldung an die Behörde wird hier nur VORBEREITET (Text mit
 * vorausgefüllten Mitarbeiterdaten; fehlende Angaben werden benannt, nie
 * erfunden). Das Auslösen ist eine reine Backoffice-Aktion auf der Detailseite
 * (dokumentiert mit «von wem / wann» auf dem Datensatz).
 */

import type { PersonaleintrittRecord } from './types';

/** Ausweisarten, die das SEM-Meldeverfahren auslösen (NICHT: N). */
export const BEWILLIGUNGSPFLICHTIGE_AUSWEISE = ['S', 'F'] as const;

/** Prüft eine Phase-2-Angabe (z. B. «S», «F — vorläufig aufgenommen») auf einen Präfix-Buchstaben. */
function ausweisIst(aufenthaltsbewilligung: string | undefined | null, buchstabe: string): boolean {
  const wert = aufenthaltsbewilligung?.trim().toUpperCase();
  if (!wert) return false;
  return wert === buchstabe || wert.startsWith(`${buchstabe} `) || wert.startsWith(`${buchstabe}-`) || wert.startsWith(`${buchstabe}(`);
}

/** Phase-2-Angabe auf S/F prüfen (SEM-Meldeverfahren). */
export function istBewilligungspflichtigerAusweis(aufenthaltsbewilligung: string | undefined | null): boolean {
  return BEWILLIGUNGSPFLICHTIGE_AUSWEISE.some(a => ausweisIst(aufenthaltsbewilligung, a));
}

/** Phase-2-Angabe auf N (Asylbewerber) prüfen — bewilligungspflichtig, aber KEIN SEM-Formular. */
export function istAusweisN(aufenthaltsbewilligung: string | undefined | null): boolean {
  return ausweisIst(aufenthaltsbewilligung, 'N');
}

/**
 * ZEMIS-Nummer Pflicht? Bei Ausweis F, S und B (Auftrag Punkt 9) — die
 * ZEMIS-Nr. identifiziert die Person im Melde-/Bewilligungsverfahren.
 */
export function zemisPflicht(aufenthaltsbewilligung: string | undefined | null): boolean {
  return ['F', 'S', 'B'].some(a => ausweisIst(aufenthaltsbewilligung, a));
}

type BewilligungsFelder = Pick<
  PersonaleintrittRecord,
  'bewilligungErforderlich' | 'bewilligungAusweisF' | 'bewilligungAusweisS' | 'bewilligungArbeitsbewilligung' | 'maDaten'
>;

/**
 * Effektiv «Bewilligung erforderlich» (steuert den Gültigkeits-Zusatz im
 * Vertrag): eines der drei GF-Flags ODER Legacy-Ja ODER Phase-2-Ausweis F/S/N.
 */
export function bewilligungErforderlichEffektiv(record: BewilligungsFelder): boolean {
  if (record.bewilligungAusweisF === true || record.bewilligungAusweisS === true ||
      record.bewilligungArbeitsbewilligung === true) return true;
  if (record.bewilligungErforderlich === true) return true; // Legacy (20260724b)
  const ausweis = record.maDaten?.lohnprogramm?.aufenthaltsbewilligung;
  return istBewilligungspflichtigerAusweis(ausweis) || istAusweisN(ausweis);
}

/**
 * SEM-Meldeformular erforderlich? NUR bei Ausweis F/S (GF-Flag ODER
 * Phase-2-Angabe). N und das generische Flag «Arbeitsbewilligung» lösen das
 * Formular NICHT aus (Auftrag Punkt 9).
 */
export function semMeldungErforderlich(record: BewilligungsFelder): boolean {
  if (record.bewilligungAusweisF === true || record.bewilligungAusweisS === true) return true;
  return istBewilligungspflichtigerAusweis(record.maDaten?.lohnprogramm?.aufenthaltsbewilligung);
}

export interface BehoerdenGesuch {
  /** Vorbereiteter Meldungs-/Gesuchstext (vorausgefüllt aus dem Datensatz). */
  text: string;
  dateiname: string;
  /** Fehlende Angaben — werden im Text als «(fehlt)» markiert, nie erfunden. */
  fehlend: string[];
}

function feld(wert: string | undefined | null, label: string, fehlend: string[]): string {
  const v = wert?.trim();
  if (v) return v;
  fehlend.push(label);
  return '(fehlt)';
}

function datumCh(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
}

/**
 * Meldung/Gesuch um Arbeitsbewilligung als vorausgefüllten Text aufbereiten.
 * Reine Funktion — Download/Ablage übernimmt die aufrufende Seite.
 */
export function buildBehoerdenGesuch(record: PersonaleintrittRecord, heuteIso?: string): BehoerdenGesuch {
  const fehlend: string[] = [];
  const p = record.maDaten?.personalien ?? {};
  const l = record.maDaten?.lohnprogramm ?? {};

  const name = feld([p.vorname, p.name].filter(Boolean).join(' '), 'Name/Vorname', fehlend);
  const geburtsdatum = feld(datumCh(p.geburtsdatum), 'Geburtsdatum', fehlend);
  const nationalitaet = feld(p.heimatort_nationalitaet, 'Heimatort/Nationalität', fehlend);
  const adresse = feld(
    [p.strasse, [p.plz, p.ort].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    'Adresse', fehlend,
  );
  const ausweis = feld(l.aufenthaltsbewilligung, 'Aufenthaltsbewilligung (Ausweis)', fehlend);
  const eintritt = feld(datumCh(record.eintritt), 'Eintrittsdatum', fehlend);
  const funktion = feld(record.funktion, 'Funktion', fehlend);
  const betrieb = feld(record.betrieb, 'Betrieb', fehlend);
  const pensum = record.vertragstyp === 'ML'
    ? (record.pensumProzent != null ? `${record.pensumProzent} %` : (fehlend.push('Pensum'), '(fehlt)'))
    : 'Stundenlohn (Pensum variabel)';
  const lohn = record.lohnBerechnet != null
    ? `CHF ${record.lohnBerechnet.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / ${record.lohnEinheit === 'stunde' ? 'Stunde' : 'Monat'}`
    : (fehlend.push('Lohn'), '(fehlt)');

  const heute = datumCh(heuteIso ?? new Date().toISOString().slice(0, 10)) ?? '';

  const text = [
    'MELDUNG / GESUCH UM ARBEITSBEWILLIGUNG',
    '======================================',
    '',
    `Datum: ${heute}`,
    `Arbeitgeber (Betrieb): ${betrieb}`,
    '',
    'Angaben zur mitarbeitenden Person',
    '---------------------------------',
    `Name, Vorname:            ${name}`,
    `Geburtsdatum:             ${geburtsdatum}`,
    `Heimatort / Nationalität: ${nationalitaet}`,
    `Adresse:                  ${adresse}`,
    `Ausweis (Aufenthalt):     ${ausweis}`,
    '',
    'Angaben zur Anstellung',
    '----------------------',
    `Funktion:       ${funktion}`,
    `Stellenantritt: ${eintritt}`,
    `Pensum:         ${pensum}`,
    `Lohn:           ${lohn}`,
    '',
    'Hinweis: Der Arbeitsvertrag erreicht seine Gültigkeit erst bei einer',
    'Arbeitserlaubnis (Besondere Vereinbarung im Vertrag).',
    ...(fehlend.length > 0
      ? ['', `FEHLENDE ANGABEN (vor dem Absenden ergänzen): ${fehlend.join(', ')}`]
      : []),
  ].join('\n');

  const slug = [p.vorname, p.name].filter(Boolean).join('_').replace(/[^\p{L}\p{N}_-]+/gu, '') || record.id;
  return { text, dateiname: `Behoerden_Gesuch_${slug}.txt`, fehlend };
}
