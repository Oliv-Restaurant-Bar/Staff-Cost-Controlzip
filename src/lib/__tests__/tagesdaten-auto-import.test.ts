// @vitest-environment node
/**
 * Tests für die Auto-Typerkennung + Jahr-Zuordnung des kombinierten
 * Tagesdaten-Imports (src/lib/tagesdaten-auto-import.ts).
 *
 * Die Erkennung arbeitet auf normalisierten Zeilen (string[][]) — so lassen sich
 * die vier Typen und der Nicht-erkannt-Fall ohne echte Excel-Datei prüfen.
 */
import { describe, it, expect } from 'vitest';
import { detectTagesdatenTyp, isoFromDayMonth, formatInvalidDayMonth } from '../tagesdaten-auto-import';

const HEADER = ['Bezeichnung', 'Zeitraum', '01.07.', '02.07.', '03.07.'];

describe('detectTagesdatenTyp', () => {
  it('erkennt GÄSTE an «Gesamt» + Personen-Suffix «… P.»', () => {
    const rows = [
      HEADER,
      ['Gesamt', '8604 P.', '300 P.', '280 P.', '310 P.'],
    ];
    expect(detectTagesdatenTyp(rows)).toBe('gaeste');
  });

  it('erkennt MARKETING an der «marketing»-Zeile — auch wenn eine Gesamt-Zeile (CHF) vorhanden ist', () => {
    const rows = [
      HEADER,
      ['Gesamt', 'CHF 5000.00', 'CHF 1600.00', 'CHF 1700.00', 'CHF 1700.00'],
      ['marketing', 'CHF 300.00', 'CHF 100.00', 'CHF 100.00', 'CHF 100.00'],
    ];
    expect(detectTagesdatenTyp(rows)).toBe('marketing');
  });

  it('erkennt DURCHSCHNITT an der «Durchschnitt»-Zeile (CHF)', () => {
    const rows = [
      HEADER,
      ['Durchschnitt', 'CHF 53.47', 'CHF 52.10', 'CHF 55.00', 'CHF 53.30'],
    ];
    expect(detectTagesdatenTyp(rows)).toBe('durchschnitt');
  });

  it('erkennt UMSATZ an Gesamt/Food/Beverage/Take Away in CHF', () => {
    const rows = [
      HEADER,
      ['Gesamt', 'CHF 5000.00', 'CHF 1600.00', 'CHF 1700.00', 'CHF 1700.00'],
      ['Food (Speisen)', 'CHF 3000.00', 'CHF 1000.00', 'CHF 1000.00', 'CHF 1000.00'],
      ['Beverage (Getränke)', 'CHF 1500.00', 'CHF 500.00', 'CHF 500.00', 'CHF 500.00'],
      ['Take Away', 'CHF 500.00', 'CHF 100.00', 'CHF 200.00', 'CHF 200.00'],
    ];
    expect(detectTagesdatenTyp(rows)).toBe('umsatz');
  });

  it('erkennt UMSATZ auch ohne Gesamt-Zeile (nur Food/Beverage)', () => {
    const rows = [
      HEADER,
      ['Food (Speisen)', 'CHF 3000.00', 'CHF 1000.00', 'CHF 1000.00', 'CHF 1000.00'],
      ['Beverage (Getränke)', 'CHF 1500.00', 'CHF 500.00', 'CHF 500.00', 'CHF 500.00'],
    ];
    expect(detectTagesdatenTyp(rows)).toBe('umsatz');
  });

  it('gibt null zurück, wenn nichts erkannt wird', () => {
    const rows = [
      HEADER,
      ['Rabatte', 'CHF 12.00', 'CHF 4.00', 'CHF 4.00', 'CHF 4.00'],
      ['Trinkgeld', 'CHF 20.00', 'CHF 6.00', 'CHF 7.00', 'CHF 7.00'],
    ];
    expect(detectTagesdatenTyp(rows)).toBeNull();
  });

  it('gibt null bei leeren Zeilen zurück', () => {
    expect(detectTagesdatenTyp([])).toBeNull();
    expect(detectTagesdatenTyp([HEADER])).toBeNull();
  });

  it('Gäste hat Vorrang, wenn Gesamt Personen-Suffix trägt', () => {
    // Gesamt mit «P.» → gaeste, auch wenn CHF-artige Zeilen vorhanden wären.
    const rows = [
      HEADER,
      ['Gesamt', '8604 P.', '300 P.', '280 P.', '310 P.'],
      ['Food', '100', '30', '40', '30'],
    ];
    expect(detectTagesdatenTyp(rows)).toBe('gaeste');
  });

  // ── Fix 1: CHF-Härtung + Randfall Durchschnitt vs. Umsatz ──────────────────
  it('durchschnitt NUR wenn die «Durchschnitt»-Zeile CHF-Werte trägt (leere Zeile → null)', () => {
    const rows = [
      HEADER,
      ['Durchschnitt', '', '', '', ''],
    ];
    expect(detectTagesdatenTyp(rows)).toBeNull();
  });

  it('umsatz NUR wenn Kategorienzeilen CHF-Werte tragen (leere Food/Beverage → null)', () => {
    const rows = [
      HEADER,
      ['Food (Speisen)', '', '', '', ''],
      ['Beverage (Getränke)', '', '', '', ''],
    ];
    expect(detectTagesdatenTyp(rows)).toBeNull();
  });

  it('RANDFALL: Umsatz-Datei MIT zusätzlicher «Durchschnitt»-Zeile → umsatz (Mehrheit Kategorien)', () => {
    const rows = [
      HEADER,
      ['Gesamt', 'CHF 5000.00', 'CHF 1600.00', 'CHF 1700.00', 'CHF 1700.00'],
      ['Food (Speisen)', 'CHF 3000.00', 'CHF 1000.00', 'CHF 1000.00', 'CHF 1000.00'],
      ['Beverage (Getränke)', 'CHF 1500.00', 'CHF 500.00', 'CHF 500.00', 'CHF 500.00'],
      ['Durchschnitt', 'CHF 53.47', 'CHF 52.10', 'CHF 55.00', 'CHF 53.30'],
    ];
    expect(detectTagesdatenTyp(rows)).toBe('umsatz');
  });

  it('RANDFALL: reine Durchschnitt-Datei (keine Food/Beverage-Zeilen) → durchschnitt', () => {
    const rows = [
      HEADER,
      ['Durchschnitt', 'CHF 53.47', 'CHF 52.10', 'CHF 55.00', 'CHF 53.30'],
    ];
    expect(detectTagesdatenTyp(rows)).toBe('durchschnitt');
  });
});

describe('isoFromDayMonth — Jahr-Zuordnung (Dropdown ist massgeblich)', () => {
  it('bildet TT.MM. + Jahr → ISO', () => {
    expect(isoFromDayMonth('01.07.', 2026)).toBe('2026-07-01');
    expect(isoFromDayMonth('5.3.', 2025)).toBe('2025-03-05');
    expect(isoFromDayMonth('31.12.', 2023)).toBe('2023-12-31');
  });

  it('funktioniert für eine Ganzjahresdatei (Jan–Dez desselben Jahres)', () => {
    const headers = ['15.01.', '15.02.', '15.03.', '15.04.', '15.05.', '15.06.',
      '15.07.', '15.08.', '15.09.', '15.10.', '15.11.', '15.12.'];
    const isos = headers.map(h => isoFromDayMonth(h, 2024));
    expect(isos).toEqual([
      '2024-01-15', '2024-02-15', '2024-03-15', '2024-04-15', '2024-05-15', '2024-06-15',
      '2024-07-15', '2024-08-15', '2024-09-15', '2024-10-15', '2024-11-15', '2024-12-15',
    ]);
    // Alle im gewählten Jahr — keine Silvester-Heuristik.
    expect(isos.every(iso => iso!.startsWith('2024-'))).toBe(true);
  });

  it('gibt null bei ungültigem/keinem Datumsheader zurück', () => {
    expect(isoFromDayMonth('Zeitraum', 2026)).toBeNull();
    expect(isoFromDayMonth('', 2026)).toBeNull();
    expect(isoFromDayMonth('13.13.', 2026)).toBeNull();
  });

  // ── Fix 2: echte Kalendergültigkeit ────────────────────────────────────────
  it('29.02. nur in Schaltjahren gültig', () => {
    expect(isoFromDayMonth('29.02.', 2025)).toBeNull();       // kein Schaltjahr
    expect(isoFromDayMonth('29.02.', 2024)).toBe('2024-02-29'); // Schaltjahr
  });

  it('unmögliche Monatstage sind ungültig (31.04., 31.06., 31.11.)', () => {
    expect(isoFromDayMonth('31.04.', 2024)).toBeNull();
    expect(isoFromDayMonth('31.06.', 2024)).toBeNull();
    expect(isoFromDayMonth('31.11.', 2024)).toBeNull();
    expect(isoFromDayMonth('30.04.', 2024)).toBe('2024-04-30'); // gültig
  });

  it('formatInvalidDayMonth gibt den getrimmten Header zurück', () => {
    expect(formatInvalidDayMonth(' 29.02. ')).toBe('29.02.');
  });
});
