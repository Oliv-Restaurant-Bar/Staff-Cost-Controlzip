/**
 * Personaleintritt — Dossier-Inhalt (REINE Logik, kein IO, kein pdf-lib)
 * ======================================================================
 * Baut den Inhalt des Personaleintritt-Dossiers (Auftrag Punkt 10):
 * alle Fragen + Antworten der Phasen (GF-Erfassung, MA-Personalien, Vertrags-
 * angaben, Lohnprogramm, Ablauf/Status) plus die Liste der eingebetteten
 * Anhänge (aus maDaten.dokumente, Reihenfolge = MA_DOKUMENT_TYPEN).
 *
 * Fehlende Antworten werden als «—» ausgewiesen — nie erfunden, nie 0.
 * Das Rendering (pdf-lib) liegt getrennt in dossier-pdf.ts.
 */

import type { TenantId } from '@/contexts/TenantContext';
import {
  LOHNKLASSE_LABELS, MA_DOKUMENT_TYPEN, STATUS_LABELS,
  type MaDokumentTyp, type PersonaleintrittRecord,
} from './types';
import { BETRIEBS_CONFIG } from './betriebs-config';

export interface DossierZeile {
  frage: string;
  antwort: string;   // '—' wenn keine Angabe
}

export interface DossierSektion {
  titel: string;
  zeilen: DossierZeile[];
}

export interface DossierAnhang {
  typ: MaDokumentTyp;
  label: string;
  /** Bucket-Pfad (mitarbeiter-dokumente/…). */
  path: string;
}

export interface DossierKopf {
  betrieb: string;
  name: string;          // '—' wenn Personalien fehlen
  eintritt: string;      // dd.mm.yyyy oder '—'
  erstellt: string;      // dd.mm.yyyy
}

export interface DossierInhalt {
  kopf: DossierKopf;
  sektionen: DossierSektion[];
  anhaenge: DossierAnhang[];
  /** Pflicht-Dokumente ohne Upload (im Dossier sichtbar vermerkt). */
  fehlendeDokumente: string[];
  dateiname: string;
}

const LEER = '—';

function datumCh(iso: string | undefined | null): string {
  if (!iso) return LEER;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : LEER;
}

function chf(betrag: number | undefined | null): string {
  if (betrag == null || !isFinite(betrag)) return LEER;
  return `CHF ${betrag.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function text(v: string | undefined | null): string {
  const w = v?.trim();
  return w ? w : LEER;
}

function jaNein(v: boolean | undefined | null): string {
  return v == null ? LEER : v ? 'Ja' : 'Nein';
}

/** Baut den kompletten Dossier-Inhalt aus dem Datensatz (REIN, testbar). */
export function buildDossierInhalt(
  record: PersonaleintrittRecord,
  tenantId: TenantId,
  heuteIso?: string,
): DossierInhalt {
  const p = record.maDaten?.personalien ?? {};
  const v = record.maDaten?.vertrag ?? {};
  const l = record.maDaten?.lohnprogramm ?? {};
  const dok = record.maDaten?.dokumente ?? {};
  const betrieb = BETRIEBS_CONFIG[tenantId];

  const personName = [p.vorname, p.name].filter(Boolean).join(' ');
  const heute = datumCh(heuteIso ?? new Date().toISOString().slice(0, 10));

  const vertragstyp = record.vertragstyp === 'ML' ? 'Monatslohn (ML)'
    : record.vertragstyp === 'SL' ? 'Stundenlohn (SL)' : LEER;
  const probezeit = record.probezeitTage == null ? LEER
    : record.probezeitTage === 0 ? 'Keine'
    : `${record.probezeitTage} Tage`;
  const pensum = record.vertragstyp === 'SL' ? 'variabel (Stundenlohn)'
    : record.pensumProzent != null ? `${record.pensumProzent} %` : LEER;
  const lohnEinheit = record.lohnEinheit === 'stunde' ? '/ Stunde'
    : record.lohnEinheit === 'monat' ? '/ Monat' : '';
  const lohnModus = record.lohnModus === 'grundlohn' ? 'Grundlohn (manuell)'
    : record.lohnModus === 'mindestlohn' ? 'L-GAV-Mindestlohn'
    : record.lohnModus === 'zieltotal' ? 'Ziel-Total (inkl. Zuschläge)' : LEER;

  const bewilligungen: string[] = [];
  if (record.bewilligungAusweisF) bewilligungen.push('Ausweis F (vorläufig aufgenommen)');
  if (record.bewilligungAusweisS) bewilligungen.push('Ausweis S (Schutzstatus)');
  if (record.bewilligungArbeitsbewilligung) bewilligungen.push('Arbeitsbewilligung nötig');
  if (bewilligungen.length === 0 && record.bewilligungErforderlich) bewilligungen.push('Ja (Alt-Erfassung)');

  const sektionen: DossierSektion[] = [
    {
      titel: 'Eintritt (Erfassung Geschäftsführung)',
      zeilen: [
        { frage: 'Betrieb', antwort: text(record.betrieb) !== LEER ? text(record.betrieb) : betrieb.anzeigename },
        { frage: 'Vertragstyp', antwort: vertragstyp },
        { frage: 'Funktion', antwort: text(record.funktion) },
        { frage: 'Eintrittsdatum', antwort: datumCh(record.eintritt) },
        { frage: 'Pensum', antwort: pensum },
        { frage: 'Probezeit', antwort: probezeit },
        {
          frage: 'Vertragsdauer',
          antwort: record.vertragsdauer === 'befristet'
            ? `befristet bis ${datumCh(record.befristetBis)}`
            : record.vertragsdauer === 'unbefristet' ? 'unbefristet' : LEER,
        },
        { frage: 'Lohn-Modus', antwort: lohnModus },
        { frage: 'Lohnklasse (L-GAV)', antwort: record.lohnklasse ? LOHNKLASSE_LABELS[record.lohnklasse] : LEER },
        {
          frage: 'Grundlohn (Eingabe)',
          antwort: record.grundlohn != null
            ? `${chf(record.grundlohn)}${record.grundlohnInkl13 ? ' (inkl. 13. Monatslohn)' : ''}`
            : LEER,
        },
        { frage: 'Ziel-Total', antwort: record.zielTotal != null ? chf(record.zielTotal) : LEER },
        {
          frage: 'Lohn (berechnet)',
          antwort: record.lohnBerechnet != null ? `${chf(record.lohnBerechnet)} ${lohnEinheit}`.trim() : LEER,
        },
        { frage: 'Einführungszeit', antwort: jaNein(record.einfuehrungszeit) },
        { frage: 'Bewilligung erforderlich', antwort: bewilligungen.length > 0 ? bewilligungen.join(', ') : 'Nein' },
        {
          frage: 'Behördenmeldung ausgelöst',
          antwort: record.behoerdeMeldungAm
            ? `${datumCh(record.behoerdeMeldungAm)}${record.behoerdeMeldungVon ? ` (${record.behoerdeMeldungVon})` : ''}`
            : LEER,
        },
      ],
    },
    {
      titel: 'Personalien (Angaben Mitarbeiter/in)',
      zeilen: [
        { frage: 'Anrede', antwort: text(p.anrede) },
        { frage: 'Name', antwort: text(p.name) },
        { frage: 'Vorname', antwort: text(p.vorname) },
        { frage: 'Strasse', antwort: text(p.strasse) },
        { frage: 'PLZ / Ort', antwort: text([p.plz, p.ort].filter(Boolean).join(' ')) },
        { frage: 'Geburtsdatum', antwort: datumCh(p.geburtsdatum) },
        { frage: 'Heimatort / Nationalität', antwort: text(p.heimatort_nationalitaet) },
        { frage: 'Telefon (Mobile)', antwort: text(p.telefon) },
        { frage: 'E-Mail', antwort: text(p.email) },
      ],
    },
    {
      titel: 'Vertragsangaben',
      zeilen: [
        { frage: 'Arbeitsort', antwort: text(v.arbeitsort) },
        { frage: 'Wochenstunden', antwort: v.wochenstunden != null ? `${v.wochenstunden} h` : LEER },
        { frage: 'Ferientage (Kalendertage)', antwort: v.ferientage != null ? String(v.ferientage) : LEER },
        { frage: 'Kündigungsfrist', antwort: text(v.kuendigungsfrist) },
        { frage: 'Besondere Vereinbarungen', antwort: text(v.besondere_vereinbarungen) },
      ],
    },
    {
      titel: 'Lohnprogramm',
      zeilen: [
        { frage: 'Zivilstand', antwort: text(l.zivilstand) },
        { frage: 'AHV-Nr.', antwort: text(l.ahv_nr) },
        { frage: 'IBAN', antwort: text(l.iban) },
        { frage: 'Bank', antwort: text(l.bank) },
        { frage: 'Ausweisart', antwort: text(l.ausweisart) },
        { frage: 'Ausweis-Nr.', antwort: text(l.ausweis_nr) },
        { frage: 'Aufenthaltsbewilligung', antwort: text(l.aufenthaltsbewilligung) },
        { frage: 'ZEMIS-Nr.', antwort: text(l.zemis_nr) },
        { frage: 'Konfession', antwort: text(l.konfession) },
        {
          frage: 'Ehepartner/in',
          antwort: l.ehepartner?.name
            ? `${l.ehepartner.name}${l.ehepartner.erwerbstaetig != null ? ` (erwerbstätig: ${l.ehepartner.erwerbstaetig ? 'Ja' : 'Nein'})` : ''}`
            : LEER,
        },
        {
          frage: 'Kinder (Familienzulagen)',
          antwort: (l.kinder?.length ?? 0) > 0
            ? l.kinder!.map(k => [k.name, k.geburtsdatum ? datumCh(k.geburtsdatum) : null, k.familienzulage_bei ? `Zulage bei: ${k.familienzulage_bei}` : null]
                .filter(Boolean).join(', ')).join(' · ')
            : LEER,
        },
      ],
    },
    {
      titel: 'Ablauf und Status',
      zeilen: [
        { frage: 'Status', antwort: STATUS_LABELS[record.status] ?? record.status },
        { frage: 'Eingeladen am', antwort: datumCh(record.eingeladenAm) },
        { frage: 'Ausgefüllt am', antwort: datumCh(record.ausgefuelltAm) },
        { frage: 'In Personalstamm übernommen', antwort: record.personalstammId ? `Ja (ID ${record.personalstammId})` : 'Nein' },
      ],
    },
  ];

  const anhaenge: DossierAnhang[] = [];
  const fehlendeDokumente: string[] = [];
  for (const t of MA_DOKUMENT_TYPEN) {
    const path = dok[t.typ];
    if (path) anhaenge.push({ typ: t.typ, label: t.label, path });
    else if (t.pflicht) fehlendeDokumente.push(t.label);
  }

  const slug = (personName || record.funktion || record.id).replace(/[^\p{L}\p{N}_-]+/gu, '_');

  return {
    kopf: {
      betrieb: betrieb.anzeigename,
      name: personName || LEER,
      eintritt: datumCh(record.eintritt),
      erstellt: heute,
    },
    sektionen,
    anhaenge,
    fehlendeDokumente,
    dateiname: `Dossier_${slug}.pdf`,
  };
}
