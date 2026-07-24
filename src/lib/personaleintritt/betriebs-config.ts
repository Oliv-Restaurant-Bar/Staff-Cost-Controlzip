/**
 * Personaleintritt — Betriebs-Config (REINE Konstanten, kein IO)
 * ==============================================================
 * Betriebsabhängige Werte je Mandant (Auftrag Punkt 8): Firmenname, Adresse,
 * UID, Kontaktperson. Verwendet von Vertrags-PDF («zwischen …»-Zeile),
 * SEM-Meldung (Arbeitgeber-Block) und Dossier-Kopf.
 *
 * WICHTIG: Unbekannte Werte bleiben undefined und werden von den Konsumenten
 * SICHTBAR als Warnung gemeldet — nie stilles Raten (z. B. keine erfundene UID).
 */

import type { TenantId } from '@/contexts/TenantContext';

export interface BetriebsConfig {
  /** Anzeigename des Betriebs (entspricht TENANTS[id].name). */
  anzeigename: string;
  /** Juristischer Firmenname (Vertrags-/Behörden-Dokumente). */
  firmenname?: string;
  strasse?: string;
  plzOrt?: string;
  /** UID (CHE-…) — für die SEM-Meldung (Feld NuméroIDEB). */
  uid?: string;
  /** Kontaktperson des Betriebs für Behörden-Rückfragen. */
  kontaktperson?: string;
  kontaktTelefon?: string;
}

export const BETRIEBS_CONFIG: Record<TenantId, BetriebsConfig> = {
  oliv: {
    anzeigename: 'Oliv Restaurant & Bar',
    // Aus den geprüften Referenzverträgen (bisher ARBEITGEBER_ZEILE):
    firmenname: 'Oliv Gastro AG',
    strasse: 'Bethlehemstrasse 36',
    plzOrt: '3027 Bern',
    // UID nicht hinterlegt — Konsumenten warnen sichtbar.
  },
  beaulieu: {
    anzeigename: 'Restaurant Beaulieu',
    // Juristische Daten nicht hinterlegt — Konsumenten warnen sichtbar.
  },
};

/** Arbeitgeber-Zeile «zwischen …» fürs Vertrags-PDF; null wenn unvollständig. */
export function arbeitgeberZeile(tenantId: TenantId): string | null {
  const c = BETRIEBS_CONFIG[tenantId];
  if (!c?.firmenname || !c.strasse || !c.plzOrt) return null;
  return `${c.firmenname}, ${c.strasse}, ${c.plzOrt}`;
}

// ─── SEM-Meldung: kantonale Zustell-Config (beide Betriebe im Kanton Bern) ───

export interface SemKantonConfig {
  kanton: string;
  /** Ort für die Unterschriftszeile («Lieu»). */
  lieu: string;
  /** Zustell-Adresse der kantonalen Behörde. */
  empfaengerEmail: string;
  /** Kontaktperson für Rückfragen (SEM-Felder Nom2/Téléphone2). */
  kontaktName: string;
  kontaktTelefon: string;
}

export const SEM_KANTON_BERN: SemKantonConfig = {
  kanton: 'Bern',
  lieu: 'Bern',
  empfaengerEmail: 'meldeverfahren.midi@be.ch',
  kontaktName: 'Berat Osmani',
  kontaktTelefon: '076 398 67 47',
};

/** Betreffzeile der Meldung: «Meldung Erwerbstätigkeit – [Name] – [Betrieb]». */
export function semBetreff(name: string, betrieb: string): string {
  return `Meldung Erwerbstätigkeit – ${name || '(Name fehlt)'} – ${betrieb || '(Betrieb fehlt)'}`;
}
