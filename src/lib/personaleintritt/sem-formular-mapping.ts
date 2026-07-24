/**
 * Personaleintritt — SEM-Meldeformular: Feld-Mapping (REINE Logik, kein IO)
 * =========================================================================
 * Baut die Feldwerte fürs offizielle SEM-Meldeformular «Meldung
 * Erwerbstätigkeit» (Ausweis F/S, Auftrag Punkt 9) aus dem Datensatz.
 *
 * Die Feldnamen stammen aus der Auftrags-Spec (NrSymic, Noms, Prénoms,
 * Nationalité, Rue, NPALocalité, Numéro de téléphone, Courriel1, NomB, RueB,
 * NPALocaliteB, NuméroIDEB, ActiviteExercee, BrancheEconomique,
 * Beschaeftigunsgrad, Bruttolohn, Stunden/Minuten, Group3/4/5,
 * GroupStartTaetigkeit, ChkBxStartTaetigkeit, DtStartTaetigkeit, Lieu, Nom2,
 * Téléphone2). Da amtliche AcroForm-Namen je Formular-Version leicht variieren
 * können, führt jedes logische Feld eine KANDIDATEN-Liste (Spec-Name zuerst) —
 * der Füller (sem-formular.ts) nimmt die erste Übereinstimmung und meldet
 * nicht gefundene Felder SICHTBAR als Warnung, nie stilles Raten.
 * Fehlende Angaben im Datensatz werden in `fehlend` benannt, nie erfunden.
 * Die Radio-Gruppen Group3/Group4 sind laut Auftrag am gerenderten PDF zu
 * verifizieren — der Füller legt bei Nichttreffern die realen Optionen offen.
 */

import type { PersonaleintrittRecord } from './types';
import {
  type BetriebRecord, betriebAnzeigename, SEM_KANTON_BERN, semBetreff,
} from './betriebs-config';

export interface SemFeld {
  /** Fachliches Label (für Warnungen). */
  label: string;
  wert: string;
  /** AcroForm-Feldnamen-Kandidaten (Spec-Name zuerst; erste Übereinstimmung gewinnt). */
  kandidaten: string[];
}

export interface SemCheckbox {
  label: string;
  an: boolean;
  kandidaten: string[];
}

export interface SemRadio {
  label: string;
  /** Feldnamen-Kandidaten der Radio-/Auswahl-Gruppe. */
  kandidaten: string[];
  /** Options-Kandidaten (erste in der Gruppe vorhandene Option gewinnt). */
  optionKandidaten: string[];
  /** false = Wert im Datensatz unbekannt — Gruppe wird NICHT gesetzt (nie raten). */
  aktiv: boolean;
}

export interface SemFillMap {
  felder: SemFeld[];
  checkboxen: SemCheckbox[];
  radios: SemRadio[];
  /** Fachlich fehlende Angaben (im Datensatz leer — nie erfunden). */
  fehlend: string[];
  /** Betreffzeile + Zustell-Adresse für den E-Mail-Versand (Kanton Bern). */
  betreff: string;
  empfaengerEmail: string;
  dateiname: string;
}

function datumCh(iso: string | undefined | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/**
 * Wochenstunden fürs Formular (Felder Stunden/Minuten): ML aus
 * vertrag.wochenstunden, sonst Wochenstundenmodell des Betriebs × Pensum
 * (L-GAV; Default 42-h-Woche). SL = variabel ⇒ null (Felder bleiben leer,
 * Angabe wird als fehlend benannt).
 */
export function wochenstundenFuerSem(
  record: PersonaleintrittRecord,
  wochenstundenModell: number = 42,
): { stunden: number; minuten: number } | null {
  if (record.vertragstyp !== 'ML') return null;
  const ws = record.maDaten?.vertrag?.wochenstunden
    ?? (record.pensumProzent != null ? wochenstundenModell * record.pensumProzent / 100 : null);
  if (ws == null || !isFinite(ws) || ws <= 0) return null;
  const stunden = Math.floor(ws);
  const minuten = Math.round((ws - stunden) * 60);
  return minuten === 60 ? { stunden: stunden + 1, minuten: 0 } : { stunden, minuten };
}

/**
 * Baut die Feldwerte aus dem Datensatz (REIN, testbar). Leere Werte werden in
 * `fehlend` benannt und als leere Felder geschrieben — nie erfunden.
 */
export function buildSemFillMap(
  record: PersonaleintrittRecord,
  betrieb: BetriebRecord,
  heuteIso?: string,
): SemFillMap {
  const p = record.maDaten?.personalien ?? {};
  const l = record.maDaten?.lohnprogramm ?? {};
  const fehlend: string[] = [];

  const wert = (v: string | undefined | null, label: string): string => {
    const w = v?.trim() ?? '';
    if (!w) fehlend.push(label);
    return w;
  };

  const name = wert(p.name, 'Name');
  const vorname = wert(p.vorname, 'Vorname');
  const geburtsdatum = wert(datumCh(p.geburtsdatum), 'Geburtsdatum');
  const nationalitaet = wert(p.heimatort_nationalitaet, 'Nationalität');
  const zemis = wert(l.zemis_nr, 'ZEMIS-/SYMIC-Nr.');
  const strasse = wert(p.strasse, 'Strasse');
  const npaLocalite = wert([p.plz, p.ort].filter(Boolean).join(' '), 'PLZ/Ort');
  const telefon = wert(p.telefon, 'Telefon');
  const email = wert(p.email, 'E-Mail');
  const eintritt = wert(datumCh(record.eintritt), 'Stellenantritt');
  const funktion = wert(record.funktion, 'Funktion/Tätigkeit');
  const pensum = record.vertragstyp === 'ML'
    ? (record.pensumProzent != null ? `${record.pensumProzent} %` : (fehlend.push('Pensum'), ''))
    : 'variabel (Stundenlohn)';
  const bruttolohn = record.lohnBerechnet != null
    ? record.lohnBerechnet.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : (fehlend.push('Bruttolohn (Basislohn)'), '');

  const ws = wochenstundenFuerSem(record, betrieb.wochenstundenModell);
  if (ws == null) {
    fehlend.push(record.vertragstyp === 'ML'
      ? 'Wochenstunden (Stunden/Minuten)'
      : 'Wochenstunden (Stundenlohn variabel — manuell prüfen)');
  }

  const firmenname = wert(betrieb.name, 'Firmenname (Betrieb)');
  const strasseB = wert(betrieb.strasse, 'Strasse Arbeitgeber (Betrieb)');
  const npaLocaliteB = wert(betrieb.plzOrt, 'PLZ/Ort Arbeitgeber (Betrieb)');
  const uid = wert(betrieb.uid, 'UID/IDE (Betrieb)');
  const heute = datumCh(heuteIso ?? new Date().toISOString().slice(0, 10));

  // Kontakt/Zustellung: Betriebs-Datensatz zuerst, kantonale Config als Fallback.
  const kontaktName = betrieb.kontaktpersonName?.trim() || SEM_KANTON_BERN.kontaktName;
  const kontaktTelefon = betrieb.kontaktpersonTel?.trim() || SEM_KANTON_BERN.kontaktTelefon;
  const empfaengerEmail = betrieb.behoerdeEmail?.trim() || SEM_KANTON_BERN.empfaengerEmail;

  const felder: SemFeld[] = [
    // Mitarbeitende Person
    { label: 'Name', wert: name, kandidaten: ['Noms', 'Nom', 'Name'] },
    { label: 'Vorname', wert: vorname, kandidaten: ['Prénoms', 'Prenoms', 'Prénom', 'Vorname'] },
    { label: 'Geburtsdatum', wert: geburtsdatum, kandidaten: ['Geburtsdatum', 'Date de naissance', 'DateNaissance', 'DtNaissance'] },
    { label: 'Nationalität', wert: nationalitaet, kandidaten: ['Nationalité', 'Nationalite', 'Nationalität'] },
    { label: 'ZEMIS-/SYMIC-Nr.', wert: zemis, kandidaten: ['NrSymic', 'N° SYMIC', 'NumeroSYMIC', 'ZEMIS'] },
    { label: 'Strasse', wert: strasse, kandidaten: ['Rue', 'Strasse', 'Adresse'] },
    { label: 'PLZ/Ort', wert: npaLocalite, kandidaten: ['NPALocalité', 'NPALocalite', 'NPA/Localité', 'PLZOrt'] },
    { label: 'Telefon', wert: telefon, kandidaten: ['Numéro de téléphone', 'Numero de telephone', 'Téléphone1', 'Telefon'] },
    { label: 'E-Mail', wert: email, kandidaten: ['Courriel1', 'Courriel', 'Email', 'E-Mail'] },
    // Anstellung
    { label: 'Stellenantritt', wert: eintritt, kandidaten: ['DtStartTaetigkeit', 'Début de l\u2019activité', 'DateDebut', 'Stellenantritt'] },
    { label: 'Funktion/Tätigkeit', wert: funktion, kandidaten: ['ActiviteExercee', 'Activité exercée', 'Profession', 'Funktion'] },
    { label: 'Branche', wert: 'Gastronomie', kandidaten: ['BrancheEconomique', 'Branche économique', 'Branche'] },
    { label: 'Beschäftigungsgrad', wert: pensum, kandidaten: ['Beschaeftigunsgrad', 'Beschaeftigungsgrad', 'Taux d\u2019occupation', 'Pensum'] },
    { label: 'Bruttolohn', wert: bruttolohn, kandidaten: ['Bruttolohn', 'Salaire brut', 'SalaireBrut', 'Salaire'] },
    { label: 'Stunden', wert: ws ? String(ws.stunden) : '', kandidaten: ['Stunden', 'Heures'] },
    { label: 'Minuten', wert: ws ? String(ws.minuten) : '', kandidaten: ['Minuten', 'Minutes'] },
    { label: 'Kanton', wert: SEM_KANTON_BERN.kanton, kandidaten: ['Kanton', 'Canton'] },
    // Arbeitgeber
    { label: 'Firmenname', wert: firmenname, kandidaten: ['NomB', 'Entreprise', 'Employeur', 'Firma'] },
    { label: 'Strasse Arbeitgeber', wert: strasseB, kandidaten: ['RueB', 'AdresseEmployeur'] },
    { label: 'PLZ/Ort Arbeitgeber', wert: npaLocaliteB, kandidaten: ['NPALocaliteB', 'NPALocalitéB'] },
    { label: 'UID/IDE', wert: uid, kandidaten: ['NuméroIDEB', 'NumeroIDEB', 'IDE', 'UID'] },
    // Kontakt/Unterschrift (Betrieb; Kanton-Bern-Config als Fallback)
    { label: 'Kontaktperson', wert: kontaktName, kandidaten: ['Nom2', 'Personne de contact', 'Kontaktperson'] },
    { label: 'Telefon Kontakt', wert: kontaktTelefon, kandidaten: ['Téléphone2', 'Telephone2'] },
    { label: 'Ort (Unterschrift)', wert: SEM_KANTON_BERN.lieu, kandidaten: ['Lieu', 'Ort'] },
    { label: 'Datum (Unterschrift)', wert: heute, kandidaten: ['Date', 'Datum'] },
  ];

  const checkboxen: SemCheckbox[] = [
    {
      label: 'Start der Tätigkeit',
      an: true, // Spec: ChkBxStartTaetigkeit = On (es wird immer ein Stellenantritt gemeldet)
      kandidaten: ['ChkBxStartTaetigkeit'],
    },
  ];

  // Geschlecht aus der Anrede ableiten (Frau/Herr) — unbekannt ⇒ nie raten.
  const anrede = p.anrede?.trim().toLowerCase();
  const geschlecht: 'M' | 'W' | null = anrede === 'herr' ? 'M' : anrede === 'frau' ? 'W' : null;
  if (!geschlecht) fehlend.push('Geschlecht (Anrede)');

  const radios: SemRadio[] = [
    {
      label: 'Geschlecht (Group3)',
      kandidaten: ['Group3', 'Geschlecht', 'Sexe'],
      optionKandidaten: geschlecht === 'M'
        ? ['M', 'Männlich', 'Homme', 'masculin', 'Herr']
        : ['W', 'F', 'Weiblich', 'Femme', 'féminin', 'Frau'],
      aktiv: geschlecht != null,
    },
    {
      label: 'NAV/GAV (Group4)',
      kandidaten: ['Group4', 'NAV', 'GAV'],
      optionKandidaten: ['Ja', 'Oui', 'GAV'], // Spec: NAV/GAV = Ja (L-GAV Gastgewerbe)
      aktiv: true,
    },
    {
      label: 'Lohnart (Group5)',
      kandidaten: ['Group5', 'Lohnart'],
      optionKandidaten: record.vertragstyp === 'ML'
        ? ['monatlich (13 Monatslöhne)', 'monatlich', 'Monatslohn']
        : ['Stundenlohn', 'stündlich'],
      aktiv: record.vertragstyp === 'ML' || record.vertragstyp === 'SL',
    },
    {
      label: 'Art der Tätigkeit (GroupStartTaetigkeit)',
      kandidaten: ['GroupStartTaetigkeit'],
      optionKandidaten: ['Unselbstaedige', 'Unselbständige', 'Unselbstständige', 'unselbständig'],
      aktiv: true, // Anstellung ⇒ immer unselbständige Erwerbstätigkeit
    },
  ];

  const personName = [vorname, name].filter(Boolean).join(' ');
  const slug = [p.vorname, p.name].filter(Boolean).join('_').replace(/[^\p{L}\p{N}_-]+/gu, '') || record.id;

  return {
    felder,
    checkboxen,
    radios,
    fehlend,
    betreff: semBetreff(personName, betriebAnzeigename(betrieb)),
    empfaengerEmail,
    dateiname: `SEM_Meldung_${slug}.pdf`,
  };
}
