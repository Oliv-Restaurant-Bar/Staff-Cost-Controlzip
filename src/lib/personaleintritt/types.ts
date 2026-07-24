/**
 * Personaleintritt — Typen (reine Typdefinitionen, kein IO)
 * =========================================================
 * Modul «Personaleintritt & digitaler L-GAV-Arbeitsvertrag».
 * Entwurfs-/Arbeitsdatensatz getrennt vom finalen Personalstamm; erst die
 * Übernahme (Phase 3) schreibt einen Employee in die employees-Tabelle.
 */

export type Vertragstyp = 'SL' | 'ML';

export type PersonaleintrittStatus =
  | 'entwurf'
  | 'eingeladen'
  | 'ausgefuellt'
  | 'geprueft'
  | 'vertrag_gesendet'
  | 'unterzeichnet'
  | 'uebernommen'
  | 'abgebrochen';

export type LohnModus = 'grundlohn' | 'mindestlohn' | 'zieltotal';
export type LohnEinheit = 'monat' | 'stunde';
export type Lohnklasse = 'Ia' | 'Ib' | 'II' | 'IIIa' | 'IIIb' | 'IV';

export const LOHNKLASSEN: Lohnklasse[] = ['Ia', 'Ib', 'II', 'IIIa', 'IIIb', 'IV'];

/** Beschreibungen gemäss L-GAV Art. 10 (Kurzform für die GF-Auswahl). */
export const LOHNKLASSE_LABELS: Record<Lohnklasse, string> = {
  Ia:   'Ia — ohne Berufslehre',
  Ib:   'Ib — ohne Berufslehre, mit Progresso o. ä.',
  II:   'II — 2-jährige Grundbildung (EBA)',
  IIIa: 'IIIa — Berufslehre (EFZ)',
  IIIb: 'IIIb — Berufslehre mit 6 J. Berufserfahrung',
  IV:   'IV — Berufsprüfung (eidg. Fachausweis)',
};

// ─── ma_daten (Phase 2, jsonb) ────────────────────────────────────────────────

export interface MaPersonalien {
  anrede?: string;                    // 'Frau' | 'Herr' | ''
  name?: string;
  vorname?: string;
  strasse?: string;
  plz?: string;
  ort?: string;
  geburtsdatum?: string;              // ISO (YYYY-MM-DD)
  heimatort_nationalitaet?: string;
  telefon?: string;
  email?: string;
}

export interface MaVertrag {
  arbeitsort?: string;
  wochenstunden?: number;             // nur ML relevant
  ferientage?: number;                // Default 35 Kalendertage / 5 Wochen
  kuendigungsfrist?: string;
  besondere_vereinbarungen?: string;
}

export interface MaKind {
  name?: string;
  geburtsdatum?: string;              // ISO
  familienzulage_bei?: string;        // bei welchem Elternteil/Arbeitgeber
}

export interface MaLohnprogramm {
  zivilstand?: string;                // ledig | verheiratet | geschieden | verwitwet | eingetragene Partnerschaft
  ahv_nr?: string;                    // 756.xxxx.xxxx.xx
  iban?: string;
  bank?: string;
  ausweisart?: string;                // ID | Pass | Ausländerausweis
  ausweis_nr?: string;
  aufenthaltsbewilligung?: string;    // CH | C | B | L | G | F | S | N | andere
  /** ZEMIS-Nummer (Zentrales Migrationsinformationssystem) — Pflicht bei Ausweis F/S/B für die SEM-Meldung. */
  zemis_nr?: string;
  konfession?: string;
  ehepartner?: { name?: string; erwerbstaetig?: boolean };
  kinder?: MaKind[];
}

/** Dokument-Uploads: Bucket-Pfade (mitarbeiter-dokumente/…). */
export interface MaDokumente {
  ahv_karte?: string;
  ausweis_vorne?: string;
  ausweis_hinten?: string;
  bankkarte?: string;
  foto?: string;
}

export type MaDokumentTyp = keyof MaDokumente;

export const MA_DOKUMENT_TYPEN: { typ: MaDokumentTyp; label: string; pflicht: boolean }[] = [
  { typ: 'ahv_karte',      label: 'AHV-Karte',              pflicht: true },
  { typ: 'ausweis_vorne',  label: 'Ausweis Vorderseite',    pflicht: true },
  { typ: 'ausweis_hinten', label: 'Ausweis Rückseite',      pflicht: true },
  { typ: 'bankkarte',      label: 'Bankkarte (IBAN)',       pflicht: false },
  { typ: 'foto',           label: 'Foto (Porträt)',         pflicht: false },
];

export interface MaDaten {
  personalien?: MaPersonalien;
  vertrag?: MaVertrag;
  lohnprogramm?: MaLohnprogramm;
  dokumente?: MaDokumente;
}

// ─── Datensatz ────────────────────────────────────────────────────────────────

export interface PersonaleintrittRecord {
  id: string;
  restaurantId: 'oliv' | 'beaulieu';
  status: PersonaleintrittStatus;

  vertragstyp?: Vertragstyp;
  betrieb?: string;
  funktion?: string;
  eintritt?: string;                  // ISO-Datum
  pensumProzent?: number;             // nur ML
  probezeitTage?: number;             // Default 90
  vertragsdauer?: 'unbefristet' | 'befristet';
  befristetBis?: string;              // ISO-Datum

  lohnModus?: LohnModus;
  lohnklasse?: Lohnklasse;
  grundlohn?: number;
  /** Modus «grundlohn», nur ML: Eingabe enthält den 13. bereits (Basis = Eingabe × 12/13). */
  grundlohnInkl13?: boolean;
  zielTotal?: number;
  lohnBerechnet?: number;
  lohnEinheit?: LohnEinheit;
  einfuehrungszeit?: boolean;

  /**
   * GF-Kontrollfrage ALT (Ja/Nein, Migration 20260724b) — bleibt als Legacy-Input
   * bestehen und wird ODER-verknüpft. Neuerfassung nutzt die drei Flags unten.
   */
  bewilligungErforderlich?: boolean;
  /** Bewilligungs-Mehrfachauswahl (Migration 20260724c): Ausweis F (vorläufig aufgenommen). */
  bewilligungAusweisF?: boolean;
  /** Ausweis S (Schutzstatus). */
  bewilligungAusweisS?: boolean;
  /** Arbeitsbewilligung nötig (übrige Fälle, z. B. Ausweis N, Grenzgänger ohne Bewilligung). */
  bewilligungArbeitsbewilligung?: boolean;
  /** Backoffice-Aktion «Meldung an Behörde auslösen» — wann/von wem (Audit). */
  behoerdeMeldungAm?: string;
  behoerdeMeldungVon?: string;

  maDaten: MaDaten;

  inviteExpires?: string;             // ISO-Timestamp
  eingeladenAm?: string;
  ausgefuelltAm?: string;

  pdfPath?: string;
  pdfFlatPath?: string;
  mirusExportPath?: string;
  /** Gefülltes SEM-Meldeformular (Migration 20260724d, editierbare Variante). */
  semFormularPath?: string;
  /** Dossier-PDF (Migration 20260724e): Q&A aller Phasen + Anhänge, Auftrag Punkt 10. */
  dossierPath?: string;
  skribbleRequestId?: string;
  signedPdfPath?: string;
  personalstammId?: string;           // employees.id (TEXT: '14' / 'b-169')

  createdAt?: string;
  updatedAt?: string;
}

/** Status-Anzeige (Badge-Ton über bestehende Designsystem-Töne). */
export const STATUS_LABELS: Record<PersonaleintrittStatus, string> = {
  entwurf:          'Entwurf',
  eingeladen:       'Eingeladen',
  ausgefuellt:      'Ausgefüllt',
  geprueft:         'Geprüft',
  vertrag_gesendet: 'Vertrag gesendet',
  unterzeichnet:    'Unterzeichnet',
  uebernommen:      'Übernommen',
  abgebrochen:      'Abgebrochen',
};
