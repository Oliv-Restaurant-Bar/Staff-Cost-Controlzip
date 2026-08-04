/**
 * vorjahres-personalkosten.ts
 * ===========================
 * Schreibgeschützte Vorjahres-Personalkosten aus der BUCHHALTUNG.
 *
 * Tabelle `vorjahres_personalkosten` (mandant, jahr, monat, personalkosten_chf,
 * quelle='Buchhaltung') wird AUSSCHLIESSLICH per Daten-Seed/Import befüllt —
 * es gibt bewusst KEIN UI-Eingabefeld und KEINE Schreibfunktion im Frontend.
 *
 * Gültigkeit: NUR für Jahre OHNE Dienstplan-basierte Berechnung
 * (< SCHEDULE_CALC_START_YEAR). Ab 2026 rechnet die App die Personalkosten
 * automatisch aus dem Dienstplan — Buchhaltungswerte dieser Jahre werden
 * ignoriert (Loader liefert null).
 *
 * Verwendung: Cockpit/Monatsreport, Vorjahres-Spalte, NUR Monatsansicht.
 * KEINE Verteilung auf Wochen — die Wochenansicht bleibt leer.
 *
 * Zugriff über einen isolierten Typ-Cast (Muster app-settings-table.ts), da die
 * Tabelle in den auto-generierten Typen fehlt. Lesen ist pre-migration-tolerant:
 * Fehler/fehlende Tabelle ⇒ null (Anzeige bleibt leer, kein Crash).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

/** Ab diesem Jahr werden Personalkosten aus dem Dienstplan gerechnet. */
export const SCHEDULE_CALC_START_YEAR = 2026;

export interface VorjahresPersonalkosten {
  /** Personalkosten des Monats in CHF (Buchhaltungswert). */
  chf: number;
  /** Herkunft, z.B. 'Buchhaltung'. */
  quelle: string;
}

type VpkRow = {
  mandant: string;
  jahr: number;
  monat: number;
  personalkosten_chf: number;
  quelle: string;
};

type VpkDatabase = {
  public: {
    Tables: {
      vorjahres_personalkosten: {
        Row: VpkRow;
        Insert: VpkRow;
        Update: Partial<VpkRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

/** Einziger erlaubter Ort für den Cast (Tabelle fehlt in den generierten Typen). */
function vpkTable() {
  return (supabase as unknown as SupabaseClient<VpkDatabase>)
    .from('vorjahres_personalkosten');
}

/**
 * Ist ein Jahr für den Buchhaltungs-Fallback zulässig?
 * (Nur Jahre OHNE automatische Dienstplan-Berechnung.)
 */
export function isBuchhaltungsJahr(jahr: number): boolean {
  return Number.isInteger(jahr) && jahr < SCHEDULE_CALC_START_YEAR;
}

/**
 * Lädt den Buchhaltungs-Personalkostenwert für Mandant+Jahr+Monat.
 * null bei: Jahr ≥ 2026 (Dienstplan-Ära), fehlender Zeile, Lese-/Tabellenfehler.
 */
export async function loadVorjahresPersonalkosten(
  mandant: string,
  jahr: number,
  monat: number,
): Promise<VorjahresPersonalkosten | null> {
  if (!isBuchhaltungsJahr(jahr)) return null;
  if (!Number.isInteger(monat) || monat < 1 || monat > 12) return null;
  try {
    const { data, error } = await vpkTable()
      .select('personalkosten_chf, quelle')
      .eq('mandant', mandant)
      .eq('jahr', jahr)
      .eq('monat', monat)
      .maybeSingle();
    if (error || !data) return null;
    const chf = Number(data.personalkosten_chf);
    if (!Number.isFinite(chf)) return null;
    return { chf, quelle: data.quelle || 'Buchhaltung' };
  } catch {
    return null;
  }
}
