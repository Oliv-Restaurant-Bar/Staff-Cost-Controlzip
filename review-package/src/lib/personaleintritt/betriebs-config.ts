/**
 * Personaleintritt — Betriebe (REINE Typen/Konverter, kein IO)
 * ============================================================
 * Seit Migration 20260724f sind Betriebe DATENSÄTZE (Tabelle betriebe):
 * `BetriebRecord` wird als Parameter-Objekt durch die reinen Module gereicht
 * (Vertrags-PDF «zwischen …», SEM-Meldung Arbeitgeber-Block, Dossier-Kopf,
 * Mindestlohn-Stundenmodell). Das IO (Laden/Speichern) liegt in db.ts.
 *
 * BETRIEBS_CONFIG bleibt NUR als pre-migration-Fallback über die EINE
 * Konverter-Funktion `betriebFromLegacyConfig(tenantId)` — kein zweiter
 * Datenpfad. Unbekannte Werte bleiben undefined und werden von den
 * Konsumenten SICHTBAR als Warnung gemeldet — nie stilles Raten.
 */

import type { TenantId } from '@/contexts/TenantContext';

/** Wochenstundenmodell (L-GAV) — bestimmt die Stundenlohn-Spalte in lgav_mindestlohn. */
export type WochenstundenModell = 42 | 43.5 | 45;

export const WOCHENSTUNDEN_MODELLE: WochenstundenModell[] = [42, 43.5, 45];

/** Betrieb als Datensatz (Tabelle betriebe, Migration 20260724f). */
export interface BetriebRecord {
  id: string;
  /** Juristischer Firmenname (Vertrags-/Behörden-Dokumente). */
  name: string;
  /** Anzeigename fürs UI/Betreffzeilen — Fallback: name (betriebAnzeigename). */
  anzeigename?: string;
  strasse?: string;
  plzOrt?: string;
  /** UID (CHE-…) — für die SEM-Meldung (Feld NuméroIDEB). */
  uid?: string;
  land: string;
  wochenstundenModell: WochenstundenModell;
  /** Kontaktperson des Betriebs für Behörden-Rückfragen. */
  kontaktpersonName?: string;
  kontaktpersonTel?: string;
  kontaktpersonEmail?: string;
  /** Zustelladresse der kantonalen Behörde (SEM-Meldung). */
  behoerdeEmail?: string;
  /** Kopplung an die bestehende SCC-Tenancy (Personalstamm/Dienstplan). */
  sccIntegration: boolean;
  /** 'oliv' | 'beaulieu' — nur bei sccIntegration; Dritt-Betriebe: undefined. */
  sccTenant?: TenantId;
  /** Logo (Bucket-Pfad) — Feld angelegt, noch UNBENUTZT. */
  logo?: string;
  aktiv: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Anzeigename mit Fallback auf den juristischen Namen (nie leer). */
export function betriebAnzeigename(betrieb: BetriebRecord): string {
  return betrieb.anzeigename?.trim() || betrieb.name;
}

/** Arbeitgeber-Zeile «zwischen …» fürs Vertrags-PDF; null wenn unvollständig. */
export function arbeitgeberZeile(betrieb: BetriebRecord): string | null {
  if (!betrieb.name?.trim() || !betrieb.strasse?.trim() || !betrieb.plzOrt?.trim()) return null;
  return `${betrieb.name}, ${betrieb.strasse}, ${betrieb.plzOrt}`;
}

// ─── Legacy-Fallback (pre-migration 20260724f) ───────────────────────────────

interface LegacyBetriebsConfig {
  anzeigename: string;
  firmenname?: string;
  strasse?: string;
  plzOrt?: string;
  uid?: string;
}

/** NUR über betriebFromLegacyConfig konsumieren (kein zweiter Datenpfad). */
const BETRIEBS_CONFIG: Record<TenantId, LegacyBetriebsConfig> = {
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

/** Kennzeichnung der Fallback-IDs (nie in betrieb_id persistieren!). */
export const LEGACY_BETRIEB_ID_PREFIX = 'legacy-';

/**
 * EINZIGER pre-migration-Fallback: baut aus der alten Konstanten-Config einen
 * BetriebRecord für den SCC-Tenant. Wird verwendet, solange die Tabelle
 * betriebe fehlt (loadBetriebe ⇒ preMigration) oder ein Alt-Datensatz noch
 * keine betrieb_id trägt. Die synthetische ID darf NIE persistiert werden.
 */
export function betriebFromLegacyConfig(tenantId: TenantId): BetriebRecord {
  const c = BETRIEBS_CONFIG[tenantId];
  return {
    id: `${LEGACY_BETRIEB_ID_PREFIX}${tenantId}`,
    name: c.firmenname ?? c.anzeigename,
    anzeigename: c.anzeigename,
    strasse: c.strasse,
    plzOrt: c.plzOrt,
    uid: c.uid,
    land: 'CH',
    wochenstundenModell: 42,
    kontaktpersonName: SEM_KANTON_BERN.kontaktName,
    kontaktpersonTel: SEM_KANTON_BERN.kontaktTelefon,
    behoerdeEmail: SEM_KANTON_BERN.empfaengerEmail,
    sccIntegration: true,
    sccTenant: tenantId,
    aktiv: true,
  };
}

// ─── SEM-Meldung: kantonale Zustell-Config (Fallback, Kanton Bern) ───────────

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

/**
 * Kantonale Fallback-Werte (beide Alt-Betriebe im Kanton Bern) — greifen nur,
 * wenn der Betrieb-Datensatz behoerde_email/Kontaktperson NICHT führt.
 */
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
