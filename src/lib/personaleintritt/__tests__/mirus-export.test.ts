// @vitest-environment node
/**
 * Tests: MIRUS-Lohnexport (reine Zeilen-Struktur).
 * Schwerpunkte: fehlend = null (nie 0), echte Zahlenwerte für Lohn/Pensum,
 * Pflichtfeld-Hinweise, Kinder-Zeilen, SL/ML-Lohnart-Beschriftung.
 */
import { describe, it, expect } from 'vitest';

import { buildMirusZeilen } from '../mirus-export';
import type { PersonaleintrittRecord } from '../types';

function baseRecord(overrides: Partial<PersonaleintrittRecord> = {}): PersonaleintrittRecord {
  return {
    id: 'test-1',
    restaurantId: 'oliv',
    status: 'geprueft',
    vertragstyp: 'SL',
    betrieb: 'Oliv Restaurant & Bar',
    funktion: 'Servicemitarbeiterin',
    eintritt: '2026-03-05',
    lohnBerechnet: 20.65,
    lohnEinheit: 'stunde',
    maDaten: {
      personalien: {
        anrede: 'Frau', name: 'Muster', vorname: 'Anna',
        geburtsdatum: '2000-12-07',
      },
      lohnprogramm: {
        zivilstand: 'ledig', ahv_nr: '756.0000.0000.00', iban: 'CH00 0000 0000 0000 0000 0',
        kinder: [{ name: 'Kind A', geburtsdatum: '2022-01-15', familienzulage_bei: 'Mutter' }],
      },
      vertrag: {},
    },
    ...overrides,
  };
}

function wert(zeilen: { feld: string; wert: unknown }[], feld: string): unknown {
  const z = zeilen.find(z => z.feld === feld);
  expect(z, `Zeile «${feld}» fehlt`).toBeDefined();
  return z!.wert;
}

describe('buildMirusZeilen', () => {
  it('SL: Lohnart + Basislohn als echte Zahl', () => {
    const { zeilen } = buildMirusZeilen(baseRecord());
    expect(wert(zeilen, 'Lohnart')).toBe('Stundenlohn');
    expect(wert(zeilen, 'Basislohn (CHF/Std., exkl. Zuschläge)')).toBe(20.65);
    expect(wert(zeilen, 'Pensum (%)')).toBeNull(); // Pensum nur bei ML
  });

  it('ML: Pensum als Zahl, Basislohn exkl. 13.', () => {
    const { zeilen } = buildMirusZeilen(baseRecord({
      vertragstyp: 'ML', pensumProzent: 80, lohnBerechnet: 3680, lohnEinheit: 'monat',
    }));
    expect(wert(zeilen, 'Lohnart')).toBe('Monatslohn');
    expect(wert(zeilen, 'Pensum (%)')).toBe(80);
    expect(wert(zeilen, 'Basislohn (CHF/Monat, exkl. 13.)')).toBe(3680);
  });

  it('fehlende Werte = null, NIE 0 oder Leerstring', () => {
    const { zeilen } = buildMirusZeilen(baseRecord({ lohnBerechnet: null }));
    expect(wert(zeilen, 'Basislohn (CHF/Std., exkl. Zuschläge)')).toBeNull();
    expect(wert(zeilen, 'Telefon')).toBeNull();
    expect(wert(zeilen, 'Bank')).toBeNull();
    expect(wert(zeilen, 'Ehepartner Name')).toBeNull();
    expect(wert(zeilen, 'Ehepartner erwerbstätig')).toBeNull(); // kein Partner ⇒ null, nicht «nein»
  });

  it('Daten als dd.MM.yyyy', () => {
    const { zeilen } = buildMirusZeilen(baseRecord());
    expect(wert(zeilen, 'Geburtsdatum')).toBe('07.12.2000');
    expect(wert(zeilen, 'Eintritt')).toBe('05.03.2026');
  });

  it('Kinder erzeugen eigene Zeilen', () => {
    const { zeilen } = buildMirusZeilen(baseRecord());
    expect(wert(zeilen, 'Kind 1 Name')).toBe('Kind A');
    expect(wert(zeilen, 'Kind 1 Familienzulage bei')).toBe('Mutter');
  });

  it('Pflichtfeld-Hinweise bei fehlenden Lohnfeldern + genereller Format-Hinweis', () => {
    const r = baseRecord();
    r.maDaten!.lohnprogramm = { kinder: [] };
    const { hinweise } = buildMirusZeilen(r);
    expect(hinweise.some(h => h.includes('MIRUS-Support'))).toBe(true);
    expect(hinweise.some(h => h.includes('AHV-Nr.'))).toBe(true);
    expect(hinweise.some(h => h.includes('IBAN'))).toBe(true);
    expect(hinweise.some(h => h.includes('Zivilstand'))).toBe(true);
  });

  it('vollständiger Datensatz ⇒ nur der generelle Hinweis', () => {
    const { hinweise } = buildMirusZeilen(baseRecord());
    expect(hinweise).toHaveLength(1);
  });

  it('Dateiname aus Namen, ohne Sonderzeichen', () => {
    const { dateiname } = buildMirusZeilen(baseRecord());
    expect(dateiname).toBe('MIRUS_Export_Anna_Muster.xlsx');
  });
});
