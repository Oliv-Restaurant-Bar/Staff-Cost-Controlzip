/**
 * Personaleintritt — Lohn-Berechnung (REINE Logik, kein DOM/Supabase)
 * ===================================================================
 * Drei Erfassungs-Modi (Bauauftrag §4):
 *   A «grundlohn»    — GF gibt Basislohn direkt ein (Monatsbrutto exkl. 13. bzw. Stundenlohn).
 *   B «mindestlohn»  — Schnellwahl: Mindestlohn der gewählten Lohnklasse aus lgav_mindestlohn.
 *   C «zieltotal»    — Rückrechnung vom gewünschten Total inkl. allem:
 *                        ML: Basis = Ziel × 12 / 13
 *                        SL: Basis = Ziel / (1 + 0.1065 + 0.0227 + 0.0833) = Ziel / 1.2125
 *
 * Mindestlohn-Prüfung liest IMMER aus der Tabelle lgav_mindestlohn (Eintrittsjahr);
 * Einführungszeit (Einarbeitung) erlaubt −8 %. Unterschreitung ist blockierend,
 * ausser das Einführungszeit-Häkchen ist aktiv UND der Lohn liegt ≥ Mindest −8 %.
 *
 * Rundung: intern roh; `rundeLohn` (2 Dezimalstellen) ist die dokumentierte
 * fachliche Grenze für den persistierten Basislohn (lohn_berechnet).
 */

import type { LohnEinheit, LohnModus, Lohnklasse, Vertragstyp } from './types';

/** SL-Zuschläge auf dem Basislohn (werden im Vertrag separat ausgewiesen). */
export const SL_ZUSCHLAEGE = {
  ferien: 0.1065,       // 10.65 % Ferien
  feiertag: 0.0227,     // 2.27 % Feiertage
  dreizehnter: 0.0833,  // 8.33 % 13. Monatslohn
} as const;

/** 1 + Summe der SL-Zuschläge (Rückrechnungs-Divisor Modus C, SL). */
export const SL_TOTAL_FAKTOR = 1 + SL_ZUSCHLAEGE.ferien + SL_ZUSCHLAEGE.feiertag + SL_ZUSCHLAEGE.dreizehnter; // 1.2125

/** Einführungszeit (Einarbeitung): zulässiger Abzug auf den Mindestlohn. */
export const EINFUEHRUNG_ABZUG = 0.08;

/** Jahresteiler Stundenlohn: 52 Wochen × 42 Stunden. */
export const STUNDEN_PRO_JAHR = 52 * 42;

export interface MindestlohnEintrag {
  jahr: number;
  klasse: Lohnklasse;
  /** CHF/Monat inkl. 13. (×13-Basis) gemäss L-GAV. */
  monatX13: number;
}

/** Fachliche Rundungsgrenze: Basislohn auf 2 Dezimalstellen (Rappen). */
export function rundeLohn(wert: number): number {
  return Math.round(wert * 100) / 100;
}

/**
 * Mindestlohn für Jahr/Klasse/Einheit aus den geladenen Tabellenzeilen.
 * monat: Monats-Basislohn (exkl. 13.) ≥ monat_x13.
 * stunde: monat_x13 × 13 / (52 × 42).
 * Fehlender Tabelleneintrag ⇒ null (fehlend ≠ 0 — Prüfung dann nicht möglich).
 */
export function mindestlohnFuer(
  eintraege: MindestlohnEintrag[],
  jahr: number,
  klasse: Lohnklasse,
  einheit: LohnEinheit,
): number | null {
  const row = eintraege.find(e => e.jahr === jahr && e.klasse === klasse);
  if (!row || !(row.monatX13 > 0)) return null;
  if (einheit === 'monat') return row.monatX13;
  return (row.monatX13 * 13) / STUNDEN_PRO_JAHR;
}

/** Für ein Eintrittsdatum (ISO) das massgebliche Mindestlohn-Jahr. */
export function mindestlohnJahr(eintrittIso: string | undefined): number | null {
  if (!eintrittIso) return null;
  const j = Number(eintrittIso.slice(0, 4));
  return Number.isInteger(j) && j >= 2000 && j <= 2100 ? j : null;
}

export interface LohnBerechnungInput {
  vertragstyp: Vertragstyp;
  modus: LohnModus;
  /** Modus A: direkter Basislohn (Monat exkl. 13. bzw. Stunde). */
  grundlohn?: number;
  /** Modus B + Mindestlohn-Prüfung: Lohnklasse. */
  lohnklasse?: Lohnklasse;
  /** Modus C: Ziel-Total inkl. allem. */
  zielTotal?: number;
  /** Einführungszeit-Häkchen (Mindestlohn −8 % zulässig). */
  einfuehrungszeit?: boolean;
  /** Eintrittsjahr für die Mindestlohn-Prüfung. */
  jahr: number | null;
  /** Geladene lgav_mindestlohn-Zeilen. */
  mindestloehne: MindestlohnEintrag[];
}

export interface SlZuschlagAufschluesselung {
  basis: number;
  ferien: number;
  feiertag: number;
  dreizehnter: number;
  total: number;
}

export interface LohnBerechnungResult {
  /** Basislohn (roh, ungerundet) — Persistenz über rundeLohn(). */
  lohnBerechnet: number | null;
  lohnEinheit: LohnEinheit;
  /** Nur SL: transparente Zuschlags-Aufschlüsselung auf dem Basislohn. */
  slZuschlaege: SlZuschlagAufschluesselung | null;
  /** Geltender Mindestlohn (bereits inkl. −8 % falls Einführungszeit aktiv). */
  mindestlohn: number | null;
  /** Mindestlohn ohne Einführungsabzug (für die Anzeige). */
  mindestlohnRegulaer: number | null;
  /** true, wenn lohnBerechnet unter dem geltenden Mindestlohn liegt. */
  unterMindestlohn: boolean;
  /** true = Einladung blockieren (unter Mindestlohn). */
  blockierend: boolean;
  /** null-Werte / fehlende Eingaben verständlich begründet. */
  hinweis: string | null;
}

/** SL-Einheit = Stunde, ML-Einheit = Monat (fix aus dem Vertragstyp). */
export function lohnEinheitFuer(vertragstyp: Vertragstyp): LohnEinheit {
  return vertragstyp === 'SL' ? 'stunde' : 'monat';
}

function slAufschluesselung(basis: number): SlZuschlagAufschluesselung {
  return {
    basis,
    ferien: basis * SL_ZUSCHLAEGE.ferien,
    feiertag: basis * SL_ZUSCHLAEGE.feiertag,
    dreizehnter: basis * SL_ZUSCHLAEGE.dreizehnter,
    total: basis * SL_TOTAL_FAKTOR,
  };
}

/**
 * Zentrale Lohn-Berechnung für alle drei Modi inkl. Mindestlohn-Prüfung.
 * Reine Funktion: keine Rundung ausser explizit dokumentiert (Modus B setzt
 * den Mindestlohn als Basis; roh, Rundung erst bei Persistenz/Anzeige).
 */
export function berechneLohn(input: LohnBerechnungInput): LohnBerechnungResult {
  const einheit = lohnEinheitFuer(input.vertragstyp);

  const minRegulaer = input.jahr != null && input.lohnklasse
    ? mindestlohnFuer(input.mindestloehne, input.jahr, input.lohnklasse, einheit)
    : null;
  const minGeltend = minRegulaer != null
    ? (input.einfuehrungszeit ? minRegulaer * (1 - EINFUEHRUNG_ABZUG) : minRegulaer)
    : null;

  let basis: number | null = null;
  let hinweis: string | null = null;

  switch (input.modus) {
    case 'grundlohn':
      basis = input.grundlohn != null && input.grundlohn > 0 ? input.grundlohn : null;
      if (basis == null) hinweis = 'Grundlohn eingeben.';
      break;
    case 'mindestlohn':
      if (!input.lohnklasse) {
        hinweis = 'Lohnklasse wählen.';
      } else if (input.jahr == null) {
        hinweis = 'Eintrittsdatum erfassen (bestimmt das Mindestlohn-Jahr).';
      } else if (minGeltend == null) {
        hinweis = `Kein Mindestlohn für ${input.jahr}/${input.lohnklasse} hinterlegt — Tabelle lgav_mindestlohn ergänzen.`;
      } else {
        basis = minGeltend;
      }
      break;
    case 'zieltotal': {
      const ziel = input.zielTotal != null && input.zielTotal > 0 ? input.zielTotal : null;
      if (ziel == null) {
        hinweis = 'Ziel-Total eingeben.';
      } else {
        basis = input.vertragstyp === 'ML' ? (ziel * 12) / 13 : ziel / SL_TOTAL_FAKTOR;
      }
      break;
    }
  }

  // Mindestlohn-Prüfung (alle Modi). Ohne Klasse/Jahr/Tabelleneintrag keine
  // Prüfung möglich → nicht blockieren, aber Hinweis (fehlend ≠ bestanden).
  let unter = false;
  let blockierend = false;
  if (basis != null) {
    if (minGeltend != null) {
      // Toleranz gegen Fliesskomma-Artefakte auf Rappen-Ebene:
      unter = basis < minGeltend - 0.005;
      blockierend = unter;
    } else if (!hinweis) {
      hinweis = input.lohnklasse
        ? (input.jahr == null
            ? 'Eintrittsdatum fehlt — Mindestlohn-Prüfung nicht möglich.'
            : `Kein Mindestlohn für ${input.jahr}/${input.lohnklasse} hinterlegt — Prüfung nicht möglich.`)
        : 'Lohnklasse wählen, damit der Mindestlohn geprüft werden kann.';
    }
  }

  return {
    lohnBerechnet: basis,
    lohnEinheit: einheit,
    slZuschlaege: input.vertragstyp === 'SL' && basis != null ? slAufschluesselung(basis) : null,
    mindestlohn: minGeltend,
    mindestlohnRegulaer: minRegulaer,
    unterMindestlohn: unter,
    blockierend,
    hinweis,
  };
}
