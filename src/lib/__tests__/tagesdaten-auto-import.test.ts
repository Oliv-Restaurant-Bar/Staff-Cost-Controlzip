// @vitest-environment node
/**
 * Tests für die Auto-Typerkennung + Jahr-Zuordnung des kombinierten
 * Tagesdaten-Imports (src/lib/tagesdaten-auto-import.ts).
 *
 * Die Erkennung arbeitet auf normalisierten Zeilen (string[][]) — so lassen sich
 * die vier Typen und der Nicht-erkannt-Fall ohne echte Excel-Datei prüfen.
 */
import { describe, it, expect } from 'vitest';
import { detectTagesdatenTyp, istDurchschnittMehrdeutig, istChfProPersonDatei, isoFromDayMonth, formatInvalidDayMonth } from '../tagesdaten-auto-import';

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

  it('«Durchschnitt»-Zeile (CHF) ist MEHRDEUTIG (Ø pro Bon vs. pro Person) → kein Auto-Typ', () => {
    const rows = [
      HEADER,
      ['Durchschnitt', 'CHF 53.47', 'CHF 52.10', 'CHF 55.00', 'CHF 53.30'],
    ];
    expect(detectTagesdatenTyp(rows)).toBeNull();
    expect(istDurchschnittMehrdeutig(rows)).toBe(true);
  });

  it('erkennt UMSATZ/GAST an der Bezeichnung «Umsatz pro Gast» bzw. «Umsatz/Gast» (CHF)', () => {
    for (const bez of ['Umsatz pro Gast', ' umsatz pro gast ', 'Umsatz/Gast']) {
      const rows = [
        HEADER,
        [bez, 'CHF 29.48', 'CHF 26.39', 'CHF 29.43', 'CHF 24.82'],
      ];
      expect(detectTagesdatenTyp(rows)).toBe('umsatzprogast');
      expect(istDurchschnittMehrdeutig(rows)).toBe(false);
    }
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

  it('RANDFALL: reine Durchschnitt-Datei (keine Food/Beverage-Zeilen) → mehrdeutig, kein Auto-Typ', () => {
    const rows = [
      HEADER,
      ['Durchschnitt', 'CHF 53.47', 'CHF 52.10', 'CHF 55.00', 'CHF 53.30'],
    ];
    expect(detectTagesdatenTyp(rows)).toBeNull();
    expect(istDurchschnittMehrdeutig(rows)).toBe(true);
  });

  it('istChfProPersonDatei: CHF-Bezeichnungszeile ja, Gäste-Datei nein', () => {
    expect(istChfProPersonDatei([
      HEADER, ['Durchschnitt', 'CHF 29.48', 'CHF 26.39', 'CHF 29.43', 'CHF 24.82'],
    ])).toBe(true);
    expect(istChfProPersonDatei([
      HEADER, ['Umsatz pro Gast', 'CHF 29.48', 'CHF 26.39', 'CHF 29.43', 'CHF 24.82'],
    ])).toBe(true);
    expect(istChfProPersonDatei([
      HEADER, ['Gesamt', '8604 P.', '300 P.', '280 P.', '310 P.'],
    ])).toBe(false);
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

  it('Header MIT Jahr («TT.MM.JJJJ»): Jahr aus dem Header, nicht aus dem Dropdown', () => {
    expect(isoFromDayMonth('01.08.2026', 2025)).toBe('2026-08-01');
    expect(isoFromDayMonth('13.08.2026', 2026)).toBe('2026-08-13');
    expect(isoFromDayMonth('5.3.2024', 2026)).toBe('2024-03-05');
    // Kalendergültigkeit gegen das Header-Jahr: 29.02.2025 existiert nicht.
    expect(isoFromDayMonth('29.02.2025', 2024)).toBeNull();
    expect(isoFromDayMonth('29.02.2024', 2025)).toBe('2024-02-29');
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

// ── Pflicht-Typwahl: Vorschlag + Plausibilitäts-Riegel ──────────────────────
import { suggestTypFromFileName, suggestTagesdatenTyp, analyzeWertemuster, wertemusterWarnung, istHartBlockiert } from '../tagesdaten-auto-import';

describe('suggestTypFromFileName / suggestTagesdatenTyp', () => {
  it('Dateiname «Anzahl …» schlägt gaeste vor — auch wenn der Inhalt wie Umsatz aussieht', () => {
    // Gästezählung OHNE «P.»-Suffix (der Fehlklassifikations-Fall aus der Praxis)
    const rows = [
      ['Bezeichnung', 'Zeitraum', '01.07.', '02.07.', '03.07.'],
      ['Gesamt', '4968', '166', '204', '259'],
    ];
    expect(detectTagesdatenTyp(rows)).toBe('umsatz'); // Inhalts-Erkennung irrt hier
    expect(suggestTypFromFileName('Anzahl Oliv 07.2026.xlsx')).toBe('gaeste');
    expect(suggestTagesdatenTyp('Anzahl Oliv 07.2026.xlsx', rows)).toBe('gaeste'); // Dateiname gewinnt
  });
  it('weitere Dateinamen-Muster', () => {
    expect(suggestTypFromFileName('Umsatz Beaulieu 06.2026.xlsx')).toBe('umsatz');
    expect(suggestTypFromFileName('Durchschnitt 07.2026.xlsx')).toBe('durchschnitt');
    expect(suggestTypFromFileName('Umsatz pro Gast 08.2026.xlsx')).toBe('umsatzprogast');
    expect(suggestTypFromFileName('Maison Marketing.xlsx')).toBe('marketing');
    expect(suggestTypFromFileName('irgendwas.xlsx')).toBeNull();
  });
  it('Dateiname «Durchschnitt» + mehrdeutiger Inhalt → KEIN Vorschlag (neutraler Hinweis in der UI)', () => {
    const rows = [
      ['Bezeichnung', 'Zeitraum', '01.08.', '02.08.', '03.08.'],
      ['Durchschnitt', 'CHF 29.48', 'CHF 26.39', 'CHF 29.43', 'CHF 24.82'],
    ];
    expect(suggestTagesdatenTyp('Durchschnitt Oliv 08.2026.xlsx', rows)).toBeNull();
    // Bezeichnung «Umsatz pro Gast» im Inhalt → eindeutig pro Person.
    const rows2 = [
      ['Bezeichnung', 'Zeitraum', '01.08.', '02.08.', '03.08.'],
      ['Umsatz pro Gast', 'CHF 29.48', 'CHF 26.39', 'CHF 29.43', 'CHF 24.82'],
    ];
    expect(suggestTagesdatenTyp('export.xlsx', rows2)).toBe('umsatzprogast');
  });
});

describe('analyzeWertemuster / wertemusterWarnung', () => {
  const header = ['Bezeichnung', 'Zeitraum', '01.07.', '02.07.', '03.07.'];
  it('ganze Zahlen im Personenbereich → anzahl; CHF-Typ dann mit Warnung', () => {
    const rows = [header, ['Gesamt', '4968', '166', '204', '259']];
    expect(analyzeWertemuster(rows)).toBe('anzahl');
    expect(wertemusterWarnung('umsatz', 'anzahl')).toMatch(/passen nicht/);
    expect(wertemusterWarnung('gaeste', 'anzahl')).toBeNull();
  });
  it('Dezimal-/CHF-Werte → chf; Typ gaeste dann mit Warnung', () => {
    const rows = [header, ['Gesamt', "12'345.50", '1600.50', '1700.00', '1750.25']];
    expect(analyzeWertemuster(rows)).toBe('chf');
    expect(wertemusterWarnung('gaeste', 'chf')).toMatch(/passen nicht/);
    expect(wertemusterWarnung('umsatz', 'chf')).toBeNull();
  });
  it('«P.»-Suffix → anzahl, CHF-Präfix → chf, leer → null (keine Warnung)', () => {
    expect(analyzeWertemuster([header, ['Gesamt', '', '300 P.', '', '']])).toBe('anzahl');
    expect(analyzeWertemuster([header, ['Gesamt', '', 'CHF 1600.00', '', '']])).toBe('chf');
    expect(analyzeWertemuster([header])).toBeNull();
    expect(wertemusterWarnung('umsatz', null)).toBeNull();
  });
});

describe('istHartBlockiert — Anzahl-Muster NIE als Umsatz', () => {
  it('umsatz + anzahl → harter Block; andere Kombinationen nur Warnung/kein Block', () => {
    expect(istHartBlockiert('umsatz', 'anzahl')).toBe(true);
    expect(istHartBlockiert('umsatz', 'chf')).toBe(false);
    expect(istHartBlockiert('umsatz', null)).toBe(false);
    expect(istHartBlockiert('gaeste', 'chf')).toBe(false);      // bestätigbar
    expect(istHartBlockiert('marketing', 'anzahl')).toBe(false); // bestätigbar
    expect(istHartBlockiert('durchschnitt', 'anzahl')).toBe(false);
  });
  it('der Praxisfall «Anzahl Oliv 07.2026.xlsx» (166/204/259) wird als Umsatz hart blockiert', () => {
    const rows = [
      ['Bezeichnung', 'Zeitraum', '01.07.', '02.07.', '03.07.'],
      ['Gesamt', '4968', '166', '204', '259'],
    ];
    expect(istHartBlockiert('umsatz', analyzeWertemuster(rows))).toBe(true);
  });
});
