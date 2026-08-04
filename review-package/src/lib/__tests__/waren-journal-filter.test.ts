// @vitest-environment node
/**
 * Lieferanten-Journal-Filter (FIBU-Abgleich mit Warenrechnungen):
 * Nur Buchungen auf Warenaufwand-Konten 4000–Grenze (Standard 4090) gehören
 * ins Journal. Löhne (5xxx), Betriebskosten (6xxx), 4701 Betriebsmaterial,
 * 4800 Gebinde-Verrechnung und 4900 Warenvorrat werden ausgefiltert —
 * die ER-Kontobeträge bleiben davon unberührt.
 */
import { describe, it, expect } from 'vitest';
import { splitWarenJournal, istWarenJournalKonto, DEFAULT_WARENKOSTEN_GRENZE } from '../waren-klassen';

const e = (accountNumber: string, text: string) => ({ accountNumber, text });

describe('istWarenJournalKonto', () => {
  it('4000–4090 sind Waren-Journal-Konten', () => {
    for (const n of ['4000', '4020', '4060', '4070', '4090']) {
      expect(istWarenJournalKonto(n)).toBe(true);
    }
  });
  it('4701/4800/4900/5000/6000 sind KEINE Waren-Journal-Konten', () => {
    for (const n of ['4701', '4800', '4801', '4900', '5000', '6040', '6611']) {
      expect(istWarenJournalKonto(n)).toBe(false);
    }
  });
  it('keine Legacy-Regel: fehlendes/nicht-numerisches Konto → false', () => {
    expect(istWarenJournalKonto(undefined)).toBe(false);
    expect(istWarenJournalKonto('')).toBe(false);
    expect(istWarenJournalKonto('abc')).toBe(false);
  });
  it('5-stellige Konten werden auf 4 Stellen normalisiert (40600 → 4060)', () => {
    expect(istWarenJournalKonto('40600')).toBe(true);
    expect(istWarenJournalKonto('50000')).toBe(false);
  });
  it('konfigurierbare Grenze wird respektiert', () => {
    expect(istWarenJournalKonto('4095', 4099)).toBe(true);
    expect(istWarenJournalKonto('4095', DEFAULT_WARENKOSTEN_GRENZE)).toBe(false);
  });
});

describe('splitWarenJournal', () => {
  it('trennt Waren- von Nicht-Waren-Buchungen (MIRUS/Gebühren fliegen raus)', () => {
    const entries = [
      e('4060', 'Transgourmet'),
      e('4030', 'Feldschlösschen'),
      e('4020', 'Terravigna'),
      e('5000', 'MIRUS Juni 2026'),
      e('6040', 'Finanzverw. Platzgebühr'),
      e('6570', 'Kreditkartenkommissionen'),
      e('4800', 'Gebinde-Verrechnung'),
      e('4900', 'Veränderung Warenvorrat'),
      e('4701', 'Betriebsmaterial'),
    ];
    const { waren, nichtWaren } = splitWarenJournal(entries);
    expect(waren.map(x => x.text)).toEqual(['Transgourmet', 'Feldschlösschen', 'Terravigna']);
    expect(nichtWaren).toHaveLength(6);
    // keine Buchung geht verloren, keine wird doppelt gezählt
    expect(waren.length + nichtWaren.length).toBe(entries.length);
  });
  it('leere Liste bleibt leer', () => {
    const { waren, nichtWaren } = splitWarenJournal([]);
    expect(waren).toEqual([]);
    expect(nichtWaren).toEqual([]);
  });
});
