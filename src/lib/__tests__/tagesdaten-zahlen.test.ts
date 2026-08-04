// @vitest-environment node
// Striktes Zahlen-Parsing des Tagesdaten-Imports: nie NaN, nie stilles 0 —
// unlesbare Zellen werden gemeldet (Import-UI blockiert), leer/«-» ⇒ null.
import { describe, it, expect } from 'vitest';
import { parseBetragZelle, unlesbareWerteMeldung } from '@/lib/tagesdaten-zahlen';

const val = (raw: string | number) => {
  const r = parseBetragZelle(raw);
  expect(r.ok).toBe(true);
  return r.ok ? r.value : undefined;
};

describe('parseBetragZelle — erkannte Formate', () => {
  it('CHF-/Fr.-Präfix und -Suffix, Apostroph-Tausender, Punkt-Dezimal', () => {
    expect(val("CHF 1'234.56")).toBe(1234.56);
    expect(val('chf1234')).toBe(1234);
    expect(val('Fr. 100')).toBe(100);
    expect(val('100 CHF')).toBe(100);
    expect(val("1’234.50")).toBe(1234.5);
  });

  it('Komma-Dezimal, deutsches und englisches Tausenderformat', () => {
    expect(val('1234,56')).toBe(1234.56);
    expect(val('CHF 5016,20')).toBe(5016.2);
    expect(val('1.234,56')).toBe(1234.56);
    expect(val('1,234.56')).toBe(1234.56);
  });

  it('Leerzeichen-/NBSP-Tausender, Personen-Suffix, EUR', () => {
    expect(val('1 234')).toBe(1234);
    expect(val('1\u00a0234,50')).toBe(1234.5);
    expect(val("8'584 P.")).toBe(8584);
    expect(val('EUR 99.90')).toBe(99.9);
  });

  it('«1.234»-Ambiguität: bewusst als deutsche Tausendergruppe (=1234) gelesen', () => {
    expect(val('1.234')).toBe(1234);
    expect(val('12.345')).toBe(12345);
    // Punkt-Dezimal bleibt erkannt, wenn keine 3er-Gruppierung vorliegt:
    expect(val('1.23')).toBe(1.23);
    expect(val('1.2345')).toBe(1.2345);
  });

  it('negative Werte (auch mit CHF und Unicode-Minus)', () => {
    expect(val('-50.00')).toBe(-50);
    expect(val('CHF -1\'000,25')).toBe(-1000.25);
    expect(val('\u221250')).toBe(-50);
  });

  it('leer / «-» / «–» ⇒ null (leer statt 0), Zahlen unverändert', () => {
    expect(val('')).toBeNull();
    expect(val('  ')).toBeNull();
    expect(val('-')).toBeNull();
    expect(val('–')).toBeNull();
    expect(val('CHF -')).toBeNull();
    expect(val('None')).toBeNull();
    expect(val('none')).toBeNull();
    expect(val('null')).toBeNull();
    expect(val(42.5)).toBe(42.5);
    expect(val(0)).toBe(0);
  });
});

describe('parseBetragZelle — unlesbar (nie 0, nie NaN)', () => {
  it.each(['abc', '123abc', '12.34.56,7', 'CHF ??', '1..2', 'n/a', '#REF!'])(
    'meldet «%s» als unlesbar', raw => {
      const r = parseBetragZelle(raw);
      expect(r.ok).toBe(false);
      expect(r.roh).toBe(raw);
      expect(r.value).toBeNull();
    },
  );

  it('NaN/Infinity als number ⇒ unlesbar', () => {
    expect(parseBetragZelle(NaN).ok).toBe(false);
    expect(parseBetragZelle(Infinity).ok).toBe(false);
  });
});

describe('unlesbareWerteMeldung', () => {
  it('nennt Zeile/Spalte/Rohwert und begrenzt die Beispiele', () => {
    const zellen = Array.from({ length: 10 }, (_, i) => ({
      zeile: 'Gesamt', spalte: `0${(i % 9) + 1}.07.`, roh: 'kaputt',
    }));
    const msg = unlesbareWerteMeldung(zellen, 3);
    expect(msg).toContain('10 Zellwerte nicht lesbar');
    expect(msg).toContain('Gesamt · Spalte 01.07.: «kaputt»');
    expect(msg).toContain('und 7 weitere');
  });
});
