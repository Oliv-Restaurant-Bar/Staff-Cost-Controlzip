// @vitest-environment node
/**
 * Regressionstest: Gastronovi Z-Bericht Parser
 * =============================================
 * Bug 1 (Sektionskopf): Die Metadaten-Zeile "Kostenstelle;Restaurant Oliv"
 * wurde fälschlich als Beginn der Sektion "Kostenstellen" erkannt, weil die
 * zweite Spalte nur Text (keine Zahl) enthielt. Dadurch wurden nachfolgende
 * Metadaten (Von, Bis, Z-Zähler) in die Sektion gezogen.
 *   Neue Regel: Eine Zeile ist nur dann ein Sektionskopf, wenn die erste Spalte
 *   einem Sektionsnamen entspricht UND alle weiteren nicht-leeren Spalten
 *   typische Spaltenüberschriften sind (Anzahl, Betrag, Netto, …).
 *
 * Bug 2 (Enddatum): Bei separaten "Von"/"Bis"-Zeilen wurde periodTo
 * fälschlich = periodFrom gesetzt, weil die einzelne "Von"-Zeile als
 * kompletter Bereich behandelt wurde. Jetzt liefert eine Einzeldatums-Zeile
 * nur das Startdatum; periodTo kommt aus der "Bis"-Zeile.
 */
import { describe, it, expect } from 'vitest';
import { parseGnZBericht } from '@/lib/gn-zbericht-parser';

/** Hilfsfunktion: gibt es eine Header-Zeile, deren erste Zelle mit `first` beginnt? */
const headerStartsWith = (rows: string[][], first: string): boolean =>
  rows.some(r => (r[0] ?? '').toLowerCase().startsWith(first.toLowerCase()));

describe('Z-Bericht Parser — Sektionskopf-Erkennung & Metadaten', () => {
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
    expect(r.periodTo).toBe('2026-06-17'); // kommt aus der "Bis"-Zeile
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

  it('übernimmt das Enddatum aus einer kombinierten "Zeitraum"-Bereichszeile', () => {
    const csv = [
      'Zeitraum;01.06.2026 - 17.06.2026',
      'Kostenstelle;Anzahl;Betrag',
      "Hauptkostenstelle;1843;CHF 75'535.90",
    ].join('\n');

    const r = parseGnZBericht(csv, 'oliv-range.csv');
    expect(r.periodFrom).toBe('2026-06-01');
    expect(r.periodTo).toBe('2026-06-17');
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
      'Buchungskonto;Konto;Bezeichnung;Betrag',
      "3200;Speisen;CHF 45'000.00",
      'Zahlungskonto;Konto;Bezeichnung;Betrag',
      "1000;Kasse;CHF 25'000.00",
    ].join('\n');

    const r = parseGnZBericht(csv, 'oliv-full.csv');

    expect(r.costCenter).toBe('Restaurant Oliv');
    expect(r.periodFrom).toBe('2026-05-31');
    expect(r.periodTo).toBe('2026-06-17');
    expect(r.zCounter).toBe('1234');

    const expectedSections = [
      'Umsatz', 'Steuerbericht', 'Kostenstellen', 'Kellner',
      'Bezahlarten', 'Hauptwarengruppen', 'Rabatte', 'Stornierte Artikel',
      'Buchungskonten', 'Zahlungskonten',
    ];
    for (const sec of expectedSections) {
      expect(r.debug.foundSections).toContain(sec);
    }

    // Metadaten-Zeile erzeugt keine doppelte Kostenstellen-Sektion.
    expect(r.debug.rawSectionNames.filter(s => s.canonical === 'Kostenstellen').length).toBe(1);
  });
});
