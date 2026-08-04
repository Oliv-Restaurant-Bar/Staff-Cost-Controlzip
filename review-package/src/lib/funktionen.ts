/**
 * Zentrale Funktions-/Positionsliste (EINE Quelle, reine Konstanten)
 * ==================================================================
 * Wird von Personalstamm (Stellenbezeichnung) UND Personaleintritt (Funktion)
 * verwendet — sonst passen Filter/Gruppierung in Dienstplan/Auswertung nicht
 * zusammen (User-Vorgabe, Anpassung 1 Personaleintritt-Formular).
 *
 * «Serviceangestellte» ersetzt die Alt-Werte «Service» und «Servicemitarbeiterin»
 * (Daten-Migration 20260724b). Bestehende abweichende Freitext-Werte werden
 * NICHT still überschrieben: `funktionOptionen` reicht den aktuellen Wert als
 * zusätzliche Option durch, damit kein Bestandswert beim Öffnen verloren geht.
 *
 * HINWEIS: Die Tabelle `positions` (Dienstplan-Planungsbereiche) ist ein
 * SEPARATES Konzept und bleibt unberührt.
 */

export const FUNKTIONEN = [
  'Serviceangestellte',
  'Runner',
  'Barista',
  'Buffet/Office',
  'Küchenchef',
  'Koch',
  'Hilfskoch',
  'Pizzaiolo',
  'Abwäscher',
  'Aushilfe',
] as const;

export type Funktion = (typeof FUNKTIONEN)[number];

/** Alt-Werte, die fachlich «Serviceangestellte» entsprechen (Migration 20260724b). */
export const FUNKTION_ALT_ALIASE: Record<string, Funktion> = {
  Service: 'Serviceangestellte',
  Servicemitarbeiterin: 'Serviceangestellte',
};

/** Ist der Wert eine kanonische Funktion? */
export function istKanonischeFunktion(wert: string | undefined | null): boolean {
  return wert != null && (FUNKTIONEN as readonly string[]).includes(wert);
}

/**
 * Optionen für ein Funktions-Dropdown: kanonische Liste + (falls vorhanden)
 * der aktuelle Bestandswert als Zusatzoption, wenn er nicht kanonisch ist —
 * so wird ein abweichender Alt-Wert sichtbar statt still verworfen.
 */
export function funktionOptionen(aktuellerWert?: string | null): string[] {
  const wert = aktuellerWert?.trim();
  if (wert && !istKanonischeFunktion(wert)) {
    return [wert, ...FUNKTIONEN];
  }
  return [...FUNKTIONEN];
}
