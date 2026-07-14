// @vitest-environment node
/**
 * Tests für den reinen Kreditoren-OP-Listen-Parser.
 * Fixture ist SYNTHETISCH (kein echtes Beispiel-PDF verfügbar) — Struktur
 * gemäss Spezifikation "Offene Posten mit Fälligkeiten Kreditoren".
 */
import { describe, expect, it } from 'vitest';
import {
  calibrateColumns,
  extractAmountsFromText,
  parseChDate,
  parseOpListe,
  parseSwissAmount,
  type OpPdfLine,
} from '../op-liste-parser';

// ── Fixture-Helfer ───────────────────────────────────────────────────────────

/** Baut eine positionierte Zeile aus [x, text]-Paaren. */
function line(...parts: [number, string][]): OpPdfLine {
  const items = parts.map(([x, text]) => ({ x, text }));
  return { text: items.map(i => i.text).join(' ').replace(/\s{2,}/g, '  ').trim(), items };
}

// Spalten-X-Anker des synthetischen Layouts
const X = {
  text: 40, date: 40, opnr: 120, rgtext: 180,
  offen: 340, b1: 400, b2: 460, b3: 520, b4: 580, b5: 640, b6: 700,
};

const TITLE = line([X.text, 'Offene Posten mit Fälligkeiten Kreditoren']);
const STICHTAG = line([X.text, 'OP-Stichdatum: 09.06.2026 / 11:57']);
const HEADER = line(
  [X.text, 'Konto'], [X.opnr, 'OP-Nr'], [X.rgtext, 'Text'],
  [X.offen, 'Offen'],
  [X.b1, 'über 29 Tage'], [X.b2, 'seit 29 Tagen'], [X.b3, 'seit 14 Tagen'],
  [X.b4, 'in 15 Tagen'], [X.b5, 'in 30 Tagen'], [X.b6, 'nach 30 Tagen'],
);

function standardFixture(): OpPdfLine[] {
  return [
    TITLE,
    STICHTAG,
    HEADER,
    // Lieferant 1: zwei Posten in verschiedenen Buckets
    line([X.text, '2000 Saviva AG']),
    line([X.date, '01.05.2026'], [X.opnr, '12345'], [X.rgtext, 'RG 4711 Lebensmittel'], [X.offen - 6, "1'250.00"], [X.b1 - 4, "1'250.00"]),
    line([X.date, '15.05.2026'], [X.opnr, '12399'], [X.rgtext, 'RG 4790'], [X.offen - 2, '300.50'], [X.b3 - 2, '300.50']),
    line([X.text, 'Total Saviva AG'], [X.offen - 6, "1'550.50"], [X.b1 - 4, "1'250.00"], [X.b3 - 2, '300.50']),
    // Lieferant 2: Behörde, ein Posten fällig in 15 Tagen
    line([X.text, '2100 GastroSocial Ausgleichskasse']),
    line([X.date, '20.05.2026'], [X.opnr, '555'], [X.rgtext, 'AHV Mai 2026'], [X.offen - 6, "2'000.00"], [X.b4 - 6, "2'000.00"]),
    line([X.text, 'Total GastroSocial Ausgleichskasse'], [X.offen - 6, "2'000.00"], [X.b4 - 6, "2'000.00"]),
    // Fussbereich
    line([X.text, 'Gesamtsaldo'], [X.offen - 6, "3'550.50"], [X.b1 - 4, "1'250.00"], [X.b3 - 2, '300.50'], [X.b4 - 6, "2'000.00"]),
    line([X.text, 'Anzahl Posten: 3']),
    line([X.text, 'Angezeigte Personenkonten: 2']),
  ];
}

// ── Zahlen / Daten ───────────────────────────────────────────────────────────

describe('parseSwissAmount', () => {
  it('parst Schweizer Beträge', () => {
    expect(parseSwissAmount("1'250.00")).toBe(1250);
    expect(parseSwissAmount('300.50')).toBe(300.5);
    expect(parseSwissAmount("12'345'678.99")).toBe(12345678.99);
    expect(parseSwissAmount('1 234.50')).toBe(1234.5);
  });
  it('erkennt Negativ-Schreibweisen (Gutschriften)', () => {
    expect(parseSwissAmount('50.00-')).toBe(-50);
    expect(parseSwissAmount('-50.00')).toBe(-50);
    expect(parseSwissAmount('(50.00)')).toBe(-50);
  });
  it('entfernt das Währungskürzel CHF (auch verklebt)', () => {
    expect(parseSwissAmount("CHF 364'637.50")).toBe(364637.5);
    expect(parseSwissAmount('CHF364637.50')).toBe(364637.5);
    expect(parseSwissAmount('CHF -578.95')).toBe(-578.95);
    // reiner Betrag-Parser bleibt strikt: Zeilen mit Text ergeben null
    expect(parseSwissAmount("Total der Währung CHF CHF 364'637.50")).toBeNull();
  });
  it('lehnt Nicht-Beträge ab (OP-Nummern, Daten, Text)', () => {
    expect(parseSwissAmount('12345')).toBeNull();       // Ganzzahl = OP-Nr
    expect(parseSwissAmount('01.05.2026')).toBeNull();  // Datum
    expect(parseSwissAmount('Total')).toBeNull();
    expect(parseSwissAmount('1.5')).toBeNull();         // nur 2 Nachkommastellen
    expect(parseSwissAmount('')).toBeNull();
  });
});

describe('extractAmountsFromText', () => {
  it('extrahiert Beträge aus Freitext (CHF-Präfix, negativ)', () => {
    expect(extractAmountsFromText("Total der Währung CHF CHF 364'637.50")).toEqual([364637.5]);
    expect(extractAmountsFromText('Gesamt Saldo von 1 Gutschriften: CHF -578.95')).toEqual([-578.95]);
  });
  it('erfasst KEINE Ganzzahlen ohne Nachkommastellen (Postenanzahl)', () => {
    // „103" (Postenanzahl) darf NICHT als Betrag gelesen werden
    expect(extractAmountsFromText("Gesamt Saldo von 103 Posten: CHF 364'637.50")).toEqual([364637.5]);
  });
  it('liefert eine leere Liste ohne Beträge', () => {
    expect(extractAmountsFromText('Gesamt Saldo von 103 Posten')).toEqual([]);
  });
});

describe('parseChDate', () => {
  it('parst dd.mm.yyyy und dd.mm.yy → ISO', () => {
    expect(parseChDate('09.06.2026')).toBe('2026-06-09');
    expect(parseChDate('01.05.26')).toBe('2026-05-01');
  });
  it('lehnt Unsinn ab', () => {
    expect(parseChDate('32.01.2026')).toBeNull();
    expect(parseChDate('29.02.2026')).toBeNull(); // 2026 kein Schaltjahr
    expect(parseChDate('Total')).toBeNull();
  });
});

describe('calibrateColumns', () => {
  it('kalibriert alle 7 Spalten aus der Kopfzeile', () => {
    const anchors = calibrateColumns(HEADER);
    expect(anchors).not.toBeNull();
    expect(anchors!.map(a => a.key).sort()).toEqual(
      ['dueAfter30', 'dueIn15', 'dueIn30', 'open', 'overdue29Plus', 'overdueSince14', 'overdueSince29'].sort(),
    );
  });
  it('kalibriert auch fragmentierte Labels („über 29" + „Tage")', () => {
    const frag = line(
      [X.offen, 'Offen'],
      [X.b1, 'über 29'], [X.b1 + 30, 'Tage'],
      [X.b2, 'seit 29'], [X.b2 + 30, 'Tagen'],
      [X.b3, 'seit 14 Tagen'], [X.b4, 'in 15 Tagen'], [X.b5, 'in 30 Tagen'], [X.b6, 'nach 30 Tagen'],
    );
    const anchors = calibrateColumns(frag);
    expect(anchors).not.toBeNull();
    // Anker = letztes Fragment (rechtsbündige Spalten)
    expect(anchors!.find(a => a.key === 'overdue29Plus')!.x).toBe(X.b1 + 30);
  });
  it('liefert null ohne „Offen"-Spalte', () => {
    expect(calibrateColumns(line([X.b1, 'über 29 Tage'], [X.b2, 'seit 29 Tagen'], [X.b3, 'seit 14 Tagen'], [X.b4, 'in 15 Tagen']))).toBeNull();
  });
});

// ── Hauptparser ──────────────────────────────────────────────────────────────

describe('parseOpListe — Standard-Fixture', () => {
  const result = parseOpListe(standardFixture());

  it('erkennt Stichtag, Lieferanten und Posten', () => {
    expect(result.success).toBe(true);
    expect(result.snapshotDate).toBe('2026-06-09');
    expect(result.snapshotTime).toBe('11:57');
    expect(result.suppliers).toHaveLength(2);
    expect(result.suppliers[0].name).toBe('2000 Saviva AG');
    expect(result.suppliers[0].items).toHaveLength(2);
    expect(result.suppliers[1].name).toBe('2100 GastroSocial Ausgleichskasse');
  });

  it('ordnet Beträge den Buckets per X-Kalibrierung zu', () => {
    const [it1, it2] = result.suppliers[0].items;
    expect(it1.openAmount).toBe(1250);
    expect(it1.buckets.overdue29Plus).toBe(1250);
    expect(it1.buckets.overdueSince14).toBeNull();
    expect(it2.openAmount).toBe(300.5);
    expect(it2.buckets.overdueSince14).toBe(300.5);
    const it3 = result.suppliers[1].items[0];
    expect(it3.buckets.dueIn15).toBe(2000);
  });

  it('extrahiert Posten-Felder (Datum, OP-Nr, Text)', () => {
    const it1 = result.suppliers[0].items[0];
    expect(it1.opDate).toBe('2026-05-01');
    expect(it1.opNumber).toBe('12345');
    expect(it1.invoiceText).toBe('RG 4711 Lebensmittel');
  });

  it('liest Lieferanten-Totale und Gesamt-Totale', () => {
    expect(result.suppliers[0].total).toBe(1550.5);
    expect(result.suppliers[0].itemsSum).toBe(1550.5);
    expect(result.totals.openAmount).toBe(3550.5);
    expect(result.totals.itemCount).toBe(3);
    expect(result.totals.accountCount).toBe(2);
    expect(result.itemsSum).toBe(3550.5);
  });

  it('hat keine Warnungen bei stimmigen Summen', () => {
    expect(result.warnings).toEqual([]);
  });
});

describe('parseOpListe — Plausibilisierung & Sonderfälle', () => {
  it('warnt bei Abweichung Einzelposten vs. Gesamtsaldo', () => {
    const fixture = standardFixture().map(l =>
      l.text.startsWith('Gesamtsaldo')
        ? line([X.text, 'Gesamtsaldo'], [X.offen - 6, "9'999.00"])
        : l,
    );
    const r = parseOpListe(fixture);
    expect(r.success).toBe(true);
    expect(r.warnings.some(w => w.includes('Gesamtsaldo'))).toBe(true);
  });

  it('warnt bei Abweichung Einzelposten vs. Lieferanten-Total', () => {
    const fixture = standardFixture().map(l =>
      l.text.startsWith('Total Saviva')
        ? line([X.text, 'Total Saviva AG'], [X.offen - 6, "9'999.00"])
        : l,
    );
    const r = parseOpListe(fixture);
    expect(r.warnings.some(w => w.includes('Saviva'))).toBe(true);
  });

  it('Fallback ohne Kopfzeile: nur Offen-Betrag, Buckets null, Warnung', () => {
    const fixture = standardFixture().filter(l => l !== HEADER);
    const r = parseOpListe(fixture);
    expect(r.success).toBe(true);
    expect(r.warnings.some(w => w.includes('Kopfzeile'))).toBe(true);
    const it1 = r.suppliers[0].items[0];
    expect(it1.openAmount).toBe(1250);
    expect(it1.buckets.overdue29Plus).toBeNull();
  });

  it('filtert Seitenkopf-Wiederholungen (mehrseitig) und hält den Lieferantenblock', () => {
    const fixture = standardFixture();
    // Seitenwechsel MITTEN im Saviva-Block: Fusszeile + Titel/Stichtag/Header-Wiederholung
    fixture.splice(5, 0,
      line([X.text, 'Seite 1 / 2']),
      TITLE,
      STICHTAG,
      HEADER,
    );
    const r = parseOpListe(fixture);
    expect(r.success).toBe(true);
    expect(r.suppliers).toHaveLength(2);
    expect(r.suppliers[0].items).toHaveLength(2);
    expect(r.warnings).toEqual([]);
  });

  it('hängt Text-Umbruchzeilen an den vorherigen Posten an', () => {
    const fixture = standardFixture();
    fixture.splice(5, 0, line([X.rgtext, 'Zusatztext Lieferung Mai']));
    const r = parseOpListe(fixture);
    expect(r.suppliers[0].items[0].invoiceText).toBe('RG 4711 Lebensmittel Zusatztext Lieferung Mai');
    expect(r.suppliers[0].items).toHaveLength(2);
  });

  it('verarbeitet Gutschriften (negative Beträge)', () => {
    const fixture = standardFixture();
    fixture.splice(6, 0, line([X.date, '20.05.2026'], [X.opnr, '12400'], [X.rgtext, 'Gutschrift'], [X.offen - 4, '100.00-'], [X.b3 - 4, '100.00-']));
    const r = parseOpListe(fixture);
    const gutschrift = r.suppliers[0].items.find(i => i.opNumber === '12400');
    expect(gutschrift?.openAmount).toBe(-100);
    expect(gutschrift?.buckets.overdueSince14).toBe(-100);
  });
});

describe('parseOpListe — Fehlerpfade (failureReason + debug)', () => {
  it('leeres PDF', () => {
    const r = parseOpListe([]);
    expect(r.success).toBe(false);
    expect(r.failureReason).toContain('keinen extrahierbaren Text');
  });

  it('falscher Dokumenttyp', () => {
    const r = parseOpListe([line([40, 'Kontoblatt Januar 2026']), line([40, 'irgendwas 100.00'])]);
    expect(r.success).toBe(false);
    expect(r.failureReason).toContain('Offene Posten');
    expect(r.debug.sampleLines.length).toBeGreaterThan(0);
  });

  it('fehlendes OP-Stichdatum', () => {
    const fixture = standardFixture().filter(l => !/Stichdatum/.test(l.text));
    const r = parseOpListe(fixture);
    expect(r.success).toBe(false);
    expect(r.failureReason).toContain('OP-Stichdatum');
  });

  it('keine Lieferantenblöcke', () => {
    const r = parseOpListe([TITLE, STICHTAG, HEADER]);
    expect(r.success).toBe(false);
    expect(r.failureReason).toContain('Keine Lieferantenblöcke');
  });
});

// ── Gesamtsaldo-Prioritätslogik (echtes Fussformat) ──────────────────────────

/** Standard-Fixture ohne die synthetischen Fusszeilen. */
function fixtureWithoutFooter(): OpPdfLine[] {
  return standardFixture().filter(l =>
    !l.text.startsWith('Gesamtsaldo')
    && !l.text.startsWith('Anzahl Posten')
    && !l.text.startsWith('Angezeigte'),
  );
}

describe('parseOpListe — Gesamtsaldo-Prioritäten', () => {
  it('nimmt „Gesamt Saldo von N Posten" (Prio 1), nicht Rechnungen/Gutschriften/Währung', () => {
    const fixture: OpPdfLine[] = [
      ...fixtureWithoutFooter(),
      line([X.text, 'Gesamt Saldo von 103 Posten:'], [X.offen, "CHF 364'637.50"]),
      line([X.text, 'Gesamt Saldo von 102 Rechnungen:'], [X.offen, "CHF 365'216.45"]),
      line([X.text, 'Gesamt Saldo von 1 Gutschriften:'], [X.offen, 'CHF -578.95']),
      line([X.text, "Total der Währung CHF CHF 364'637.50"]),
    ];
    const r = parseOpListe(fixture);
    expect(r.success).toBe(true);
    expect(r.totals.openAmount).toBe(364637.5);
    // Postenanzahl aus der Posten-Zeile abgeleitet (keine „Anzahl Posten"-Zeile)
    expect(r.totals.itemCount).toBe(103);
  });

  it('nutzt „Total der Währung CHF" (Prio 2), wenn keine Posten-Zeile existiert', () => {
    const fixture: OpPdfLine[] = [
      ...fixtureWithoutFooter(),
      line([X.text, "Total der Währung CHF CHF 3'550.50"]),
    ];
    const r = parseOpListe(fixture);
    expect(r.success).toBe(true);
    expect(r.totals.openAmount).toBe(3550.5);
  });

  it('ignoriert Subtotale (Rechnungen/Gutschriften) als Gesamtsaldo', () => {
    // Nur Subtotale vorhanden → kein echtes Total erkannt → openAmount null
    const fixture: OpPdfLine[] = [
      ...fixtureWithoutFooter(),
      line([X.text, 'Gesamt Saldo von 102 Rechnungen:'], [X.offen, "CHF 365'216.45"]),
      line([X.text, 'Gesamt Saldo von 1 Gutschriften:'], [X.offen, 'CHF -578.95']),
    ];
    const r = parseOpListe(fixture);
    expect(r.success).toBe(true);
    expect(r.totals.openAmount).toBeNull();
  });

  it('lässt den Gesamtsaldo null (kein falscher Wert 0.00) und warnt nur bei erkanntem Total', () => {
    const fixture = fixtureWithoutFooter();
    const r = parseOpListe(fixture);
    expect(r.success).toBe(true);
    expect(r.totals.openAmount).toBeNull();
    // Hinweis auf fehlenden Gesamtsaldo
    expect(r.warnings.some(w => /Gesamtsaldo/i.test(w) && /nicht/i.test(w))).toBe(true);
    // KEINE Abweichungswarnung, wenn gar kein Total erkannt wurde
    expect(r.warnings.some(w => /weicht/i.test(w))).toBe(false);
  });
});
