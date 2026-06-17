// @vitest-environment node
/**
 * Regressionstest: Gastronovi Z-Bericht Parser — Sektionskopf-Erkennung
 * =====================================================================
 * Bug: Die Metadaten-Zeile "Kostenstelle;Restaurant Oliv" wurde fälschlich
 * als Beginn der Sektion "Kostenstellen" erkannt, weil die zweite Spalte nur
 * Text (keine Zahl) enthielt. Dadurch wurden nachfolgende Metadaten (Von, Bis,
 * Z-Zähler) in die Sektion gezogen und nicht mehr als Header erkannt.
 *
 * Neue Regel: Eine Zeile ist nur dann ein Sektionskopf, wenn die erste Spalte
 * einem Sektionsnamen entspricht UND alle weiteren nicht-leeren Spalten
 * typische Spaltenüberschriften sind (Anzahl, Betrag, Netto, …).
 *
 * Hinweis zum Scope: Geprüft wird ausschliesslich die Sektionskopf-Erkennung
 * (isSectionHeaderRow). Die Berechnung von periodTo aus separaten "Von"/"Bis"
 * Zeilen sowie das Parsen der Sektions-Tabellenkörper sind nicht Teil dieser
 * Aufgabe und werden hier bewusst nicht streng geprüft.
 */
import { describe, it, expect } from 'vitest';
import { parseGnZBericht } from '@/lib/gn-zbericht-parser';

/** Hilfsfunktion: gibt es eine Header-Zeile, deren erste Zelle mit `first` beginnt? */
const headerStartsWith = (rows: string[][], first: string): boolean =>
  rows.some(r => (r[0] ?? '').toLowerCase().startsWith(first.toLowerCase()));

describe('Z-Bericht Parser — Sektionskopf-Erkennung', () => {
  it('erkennt "Kostenstelle;Restaurant Oliv" NICHT als Sektionskopf', () => {
    const csv = [
      'Kostenstelle;Restaurant Oliv',
      'Von;31.05.2026, 22:24',
      'Bis;17.06.2026, 00:30',
      'Z-Zähler;1234',
      'Kostenstelle;Anzahl;Betrag',
      "Hauptkostenstelle;1843;CHF 75'535.90",
    ].join('\n');

    const r = parseGnZBericht(csv, 'oliv.csv');

    // Metadaten korrekt erkannt — nur möglich, wenn die Zeile im Header blieb.
    expect(r.costCenter).toBe('Restaurant Oliv');
    expect(r.periodFrom).toBe('2026-05-31');
    expect(r.zCounter).toBe('1234');

    // Von / Bis / Z-Zähler bleiben Header-Metadaten (nicht in eine Sektion gezogen).
    expect(headerStartsWith(r.debug.headerRows, 'Von')).toBe(true);
    expect(headerStartsWith(r.debug.headerRows, 'Bis')).toBe(true);
    expect(headerStartsWith(r.debug.headerRows, 'Z-Zähler')).toBe(true);

    // Die Metadaten-Zeile darf KEINE zusätzliche "Kostenstellen"-Sektion erzeugen —
    // nur der echte Tabellenkopf "Kostenstelle;Anzahl;Betrag" zählt.
    const ccSections = r.debug.rawSectionNames.filter(s => s.canonical === 'Kostenstellen');
    expect(ccSections.length).toBe(1);
  });

  it('erkennt den echten Tabellenkopf "Kostenstelle;Anzahl;Betrag" als Sektionskopf', () => {
    const csv = [
      'Kostenstelle;Anzahl;Betrag',
      "Hauptkostenstelle;1843;CHF 75'535.90",
    ].join('\n');

    const r = parseGnZBericht(csv, 'oliv.csv');
    expect(r.debug.foundSections).toContain('Kostenstellen');
  });

  it('parst einen vollständigen Oliv-Z-Bericht: alle Sektionen + Metadaten', () => {
    const csv = [
      'Z-Bericht;Restaurant Oliv',
      'Kostenstelle;Restaurant Oliv',
      'Von;31.05.2026, 22:24',
      'Bis;17.06.2026, 00:30',
      'Z-Zähler;1234',
      'Umsatz',
      "Gesamtumsatz inkl. Trinkgeld;CHF 75'535.90",
      'Steuersatz;Netto;Steuer;Brutto',
      '8.1%;60000.00;4860.00;64860.00',
      'Kostenstelle;Anzahl;Betrag',
      "Hauptkostenstelle;1843;CHF 75'535.90",
      'Kellner;Anzahl;Betrag',
      "Anna;800;CHF 30'000.00",
      'Bezahlart;Anzahl;Betrag',
      "Bar;900;CHF 25'000.00",
      'Hauptwarengruppe;Anzahl;Betrag',
      "Speisen;1200;CHF 45'000.00",
      'Rabatt;Anzahl;Betrag',
      'Marketing;10;CHF -500.00',
      'Stornierte Artikel;Anzahl;Betrag',
      'Storno A;5;CHF -200.00',
    ].join('\n');

    const r = parseGnZBericht(csv, 'oliv-full.csv');

    expect(r.costCenter).toBe('Restaurant Oliv');
    expect(r.periodFrom).toBe('2026-05-31');
    expect(r.zCounter).toBe('1234');

    const expectedSections = [
      'Umsatz', 'Steuerbericht', 'Kostenstellen', 'Kellner',
      'Bezahlarten', 'Hauptwarengruppen', 'Rabatte', 'Stornierte Artikel',
    ];
    for (const sec of expectedSections) {
      expect(r.debug.foundSections).toContain(sec);
    }

    // Metadaten-Zeile erzeugt keine doppelte Kostenstellen-Sektion.
    expect(r.debug.rawSectionNames.filter(s => s.canonical === 'Kostenstellen').length).toBe(1);
  });
});
