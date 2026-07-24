/**
 * Personaleintritt — Arbeitsbewilligung & Behörden-Gesuch (REINE Logik)
 * =====================================================================
 * Anpassung 5: Kontrollfrage «Benötigt der Mitarbeiter eine Arbeitsbewilligung
 * (z. B. Ausweis S oder F)?» — effektiv erforderlich ist die Bewilligung, wenn
 * die GF die Frage mit Ja beantwortet hat ODER der Mitarbeiter in Phase 2
 * Ausweis S oder F angegeben hat (abgeleitet, KEIN Write-on-load).
 *
 * Das Gesuch/die Meldung an die Behörde wird hier nur VORBEREITET (Text mit
 * vorausgefüllten Mitarbeiterdaten; fehlende Angaben werden benannt, nie
 * erfunden). Das Auslösen ist eine reine Backoffice-Aktion auf der Detailseite
 * (dokumentiert mit «von wem / wann» auf dem Datensatz).
 */

import type { PersonaleintrittRecord } from './types';

/** Ausweisarten, die eine Arbeitsbewilligung der Behörde voraussetzen. */
export const BEWILLIGUNGSPFLICHTIGE_AUSWEISE = ['S', 'F'] as const;

/** Phase-2-Angabe (z. B. «S», «F — vorläufig aufgenommen») auf S/F prüfen. */
export function istBewilligungspflichtigerAusweis(aufenthaltsbewilligung: string | undefined | null): boolean {
  const wert = aufenthaltsbewilligung?.trim().toUpperCase();
  if (!wert) return false;
  return BEWILLIGUNGSPFLICHTIGE_AUSWEISE.some(a => wert === a || wert.startsWith(`${a} `) || wert.startsWith(`${a}-`) || wert.startsWith(`${a}(`));
}

/** Effektiv erforderlich = GF-Kontrollfrage Ja ODER Phase-2-Ausweis S/F. */
export function bewilligungErforderlichEffektiv(record: Pick<PersonaleintrittRecord, 'bewilligungErforderlich' | 'maDaten'>): boolean {
  if (record.bewilligungErforderlich === true) return true;
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
