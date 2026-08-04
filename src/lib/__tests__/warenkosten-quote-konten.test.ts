// @vitest-environment node
/**
 * Konto-Normalisierung in der WKQ-Klassifikation (A3) + Unkontiert-Zähler (A2):
 * 5-stellige Konten (z.B. «40201») zählen über die ersten 4 Stellen —
 * konsistent zu normalizeWarenKonto/istWarenJournalKonto.
 */
import { describe, it, expect } from 'vitest';
import {
  kategorieFromKonto, kategorieOf, normalisiereKontoNummer, zaehleUnkontierte,
} from '@/lib/warenkosten-quote';
import { kontoKlasse } from '@/lib/waren-klassen';

describe('normalisiereKontoNummer', () => {
  it('3–5 Ziffern; 5-stellig → erste 4; sonst null', () => {
    expect(normalisiereKontoNummer('4020')).toBe(4020);
    expect(normalisiereKontoNummer('40201')).toBe(4020);
    expect(normalisiereKontoNummer('400')).toBe(400);
    expect(normalisiereKontoNummer('offen')).toBeNull();
    expect(normalisiereKontoNummer('')).toBeNull();
    expect(normalisiereKontoNummer(undefined)).toBeNull();
    expect(normalisiereKontoNummer('123456')).toBeNull();
  });
});

describe('kategorieFromKonto mit 5-stelligen Konten', () => {
  it('40201 → Beverage (wie 4020), 40001 → Food, 45001 → Sonstiges', () => {
    expect(kategorieFromKonto('40201')).toBe('Beverage');
    expect(kategorieFromKonto('40001')).toBe('Food');
    expect(kategorieFromKonto('45001')).toBe('Sonstiges');
  });
  it('kategorieOf: 5-stelliges Warenkonto ist autoritativ (nie Legacy-Food-Fallback)', () => {
    expect(kategorieOf({ id: 'x', amountNet: 10, warenkonto: '40301', kategorie: 'Food' })).toBe('Beverage');
    expect(kategorieOf({ id: 'y', amountNet: 10, warenkonto: '45001', kategorie: 'Food' })).toBe('Sonstiges');
  });
  it('kontoKlasse: 5-stellig konsistent (40201 → warenkosten, 45001 → betriebskosten)', () => {
    expect(kontoKlasse('40201')).toBe('warenkosten');
    expect(kontoKlasse('45001')).toBe('betriebskosten');
  });
});

describe('zaehleUnkontierte', () => {
  it('zählt kontolose Einträge und nicht-numerische Splits, nie Depot', () => {
    expect(zaehleUnkontierte([
      { id: 'a', amountNet: 10 }, // kontolos → 1
      { id: 'b', amountNet: 10, warenkonto: 'offen' }, // pseudo → 1
      { id: 'c', amountNet: 10, warenkonto: 'Depot' }, // neutral → 0
      { id: 'd', amountNet: 10, warenkonto: '4020' }, // kontiert → 0
      { id: 'e', amountNet: 10, splits: [{ warenkonto: '4020' }, { warenkonto: 'offen' }, { warenkonto: 'Depot' }] }, // 1
    ])).toBe(3);
  });
});
