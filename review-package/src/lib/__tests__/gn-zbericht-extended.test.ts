// @vitest-environment node
/**
 * Tests: Gastronovi Z-Bericht — erweiterter Bericht (Detailbericht)
 * =================================================================
 * Fixture-Basis: REALER Export «gn-bericht-hauptkostenstelle-506» (Tab-getrennt,
 * alle Zellen gequotet, Sektionen zwischen "---------------------"-Zeilen,
 * "#####################"-Banner vor «Detailbericht»/«Abrechnung»).
 * Kellner-Namen wurden anonymisiert, alle übrigen Werte sind 1:1 original.
 *
 * Fachliche Regeln:
 *  - reportType rein inhaltsbasiert (Detailsektionen vorhanden → 'extended')
 *  - Verzehrart als Namens-Suffix «… - Inner Haus»/«… - Außer Haus»;
 *    NUR das letzte Suffix strippen («Wein - Rose - Inner Haus» → «Wein - Rose»)
 *  - 0-CHF-Positionen (Garstufen, «ohne», …) bleiben erhalten
 *  - keine fachliche Namens-Vereinheitlichung (— «…» vs «… TA» bleiben getrennt)
 *  - Standard-Werte (Umsatz, Steuern, Hauptwarengruppen) unverändert korrekt
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseGnZBericht } from '@/lib/gn-zbericht-parser';

const extendedCsv = readFileSync(
  new URL('./fixtures/gn-zbericht-extended-real.csv', import.meta.url), 'utf-8');
const standardCsv = readFileSync(
  new URL('./fixtures/gn-zbericht-standard-real.csv', import.meta.url), 'utf-8');

describe('Erweiterter Z-Bericht — reale Datei-Struktur', () => {
  const r = parseGnZBericht(extendedCsv, 'gn-extended.csv');

  it('erkennt den Berichtstyp inhaltsbasiert als "extended"', () => {
    expect(r.reportType).toBe('extended');
    expect(r.extendedData).not.toBeNull();
  });

  it('parst die Standard-Metadaten unverändert korrekt', () => {
    expect(r.costCenter).toBe('Hauptkostenstelle');
    expect(r.zCounter).toBe('506');
    expect(r.periodFrom).toBe('2026-06-30');
    expect(r.periodTo).toBe('2026-07-01');
    expect(r.revenue.totalGross).toBe(12225.2);
    expect(r.revenue.totalExclCardTopups).toBe(12145.2);
    expect(r.taxNetTotal).toBe(11366.9);
  });

  it('Hauptwarengruppen (Standard-Sektion) bleiben exakt 2 Einträge — keine Vermischung mit Detailsektionen', () => {
    expect(r.productGroups).toHaveLength(2);
    const bev = r.productGroups.find(p => p.name.startsWith('Beverage'));
    expect(bev?.count).toBe(439);
    expect(bev?.amount).toBe(3338.8);
    expect(bev?.originalAmount).toBe(3404.9); // 4. Spalte = Original vor Rabatt
  });

  it('Hauptwarengruppen (inner/außer Haus): Suffix → consumptionType, Basisname bleibt', () => {
    const main = r.extendedData!.mainCategoriesByConsumptionType;
    expect(main).toHaveLength(4);
    const bevTa = main.find(e => e.name === 'Beverage (Getränke)' && e.consumptionType === 'takeaway');
    expect(bevTa).toEqual({
      name: 'Beverage (Getränke)', quantity: 5, grossAmount: 17.5,
      originalAmount: null, consumptionType: 'takeaway',
    });
    const foodIn = main.find(e => e.name === 'Food (Speisen)' && e.consumptionType === 'in_house');
    expect(foodIn?.quantity).toBe(462);
    expect(foodIn?.grossAmount).toBe(8599);
    expect(foodIn?.originalAmount).toBe(8668);
  });

  it('Warengruppen: 26 Einträge, 0-CHF-Zeilen bleiben, kein Verzehrart-Split', () => {
    const cats = r.extendedData!.categories;
    expect(cats).toHaveLength(26);
    expect(cats.every(c => c.consumptionType === null)).toBe(true);
    const gar = cats.find(c => c.name === 'Garstufen');
    expect(gar).toMatchObject({ quantity: 15, grossAmount: 0 });
    // Namen mit eigenem « - » bleiben intakt
    expect(cats.some(c => c.name === 'Wein - Rot')).toBe(true);
  });

  it('Warengruppen (inner/außer Haus): NUR letztes Suffix strippen («Wein - Rot - Inner Haus»)', () => {
    const catsCt = r.extendedData!.categoriesByConsumptionType;
    expect(catsCt).toHaveLength(29);
    const weinRot = catsCt.find(c => c.name === 'Wein - Rot');
    expect(weinRot?.consumptionType).toBe('in_house');
    expect(weinRot?.grossAmount).toBe(337.6);
    const mineralTa = catsCt.find(c => c.name === 'Mineral' && c.consumptionType === 'takeaway');
    expect(mineralTa?.quantity).toBe(5);
    expect(mineralTa?.grossAmount).toBe(17.5);
    // Kein Eintrag trägt noch ein Suffix
    expect(catsCt.some(c => /inner haus|außer haus|ausser haus/i.test(c.name))).toBe(false);
  });

  it('Positionen: alle 172 Artikel, 0-CHF-Positionen und TA-Varianten bleiben getrennt erhalten', () => {
    const pos = r.extendedData!.positions;
    expect(pos).toHaveLength(172);

    // Rabattierte Position: Betrag nach Rabatt + Original-Betrag
    const espresso = pos.find(p => p.name === 'Espresso');
    expect(espresso).toEqual({
      name: 'Espresso', quantity: 37, grossAmount: 164.3,
      originalAmount: 196.1, consumptionType: null,
    });

    // 0-CHF-Positionen mit Menge > 0 bleiben erhalten
    const ohne = pos.find(p => p.name === 'ohne');
    expect(ohne).toMatchObject({ quantity: 30, grossAmount: 0 });
    // Voll rabattiert: Betrag 0, Original gesetzt
    const kinderPizza = pos.find(p => p.name === 'Kinder Pizza Prosciutto');
    expect(kinderPizza).toMatchObject({ quantity: 1, grossAmount: 0, originalAmount: 15 });

    // Keine fachliche Namens-Vereinheitlichung: Restaurant- und TA-Variante getrennt
    expect(pos.some(p => p.name === 'Pizza Prosciutto')).toBe(true);
    expect(pos.some(p => p.name === 'Pizza Prosciutto TA')).toBe(true);

    // Keine Total-/Trenn-/Banner-Zeilen als Positionen
    expect(pos.some(p => /^total$/i.test(p.name))).toBe(false);
    expect(pos.some(p => /^[-#]{3,}$/.test(p.name))).toBe(false);
  });

  it('Banner-Zeilen («#####», «Detailbericht», «Abrechnung») verschmutzen keine Sektionen', () => {
    // Stornierte Artikel: exakt 1 echter Eintrag (Total gefiltert, Banner geschlossen)
    expect(r.cancellations).toHaveLength(1);
    expect(r.cancellations[0]).toMatchObject({ name: 'Bedienerfehler', count: 6, amount: 57.3 });
  });

  it('alle Standard-Pflichtsektionen gefunden — keine Fehl-Warnungen', () => {
    expect(r.debug.missingSections).toEqual([]);
  });
});

describe('Standard-Z-Bericht — reale Datei-Struktur (ohne Detailbericht)', () => {
  const r = parseGnZBericht(standardCsv, 'gn-standard.csv');

  it('erkennt den Berichtstyp als "standard", extendedData = null', () => {
    expect(r.reportType).toBe('standard');
    expect(r.extendedData).toBeNull();
  });

  it('parst Kennzahlen identisch zum erweiterten Bericht', () => {
    expect(r.revenue.totalGross).toBe(12225.2);
    expect(r.taxNetTotal).toBe(11366.9);
    expect(r.productGroups).toHaveLength(2);
    expect(r.cancellations).toHaveLength(1);
  });
});

describe('Legacy-Kompatibilität: plain «Warengruppen» ohne «Hauptwarengruppen»', () => {
  it('mappt «Warengruppe» weiterhin auf Hauptwarengruppen (Standard-Berichte)', () => {
    const csv = [
      'Kostenstelle;Restaurant Oliv',
      'Von;01.06.2026, 10:00',
      'Bis;01.06.2026, 23:59',
      'Z-Zähler;42',
      'Warengruppe;Anzahl;Betrag',
      'Speisen;10;500.00',
    ].join('\n');
    const r = parseGnZBericht(csv, 'legacy.csv');
    expect(r.reportType).toBe('standard');
    expect(r.debug.foundSections).toContain('Hauptwarengruppen');
    expect(r.debug.foundSections).not.toContain('Warengruppen');
  });

  it('mappt plain «Warengruppen» auf die Detailsektion, sobald explizite «Hauptwarengruppen» existieren', () => {
    const csv = [
      'Kostenstelle;Restaurant Oliv',
      'Von;01.06.2026, 10:00',
      'Bis;01.06.2026, 23:59',
      'Z-Zähler;43',
      'Hauptwarengruppen;Anzahl;Betrag',
      '---------------------;;',
      'Food (Speisen);10;500.00',
      'Warengruppen;Anzahl;Betrag',
      '---------------------;;',
      'Pizza;6;300.00',
      'Pasta;4;200.00',
    ].join('\n');
    const r = parseGnZBericht(csv, 'extended-min.csv');
    expect(r.reportType).toBe('extended');
    expect(r.debug.foundSections).toContain('Warengruppen');
    expect(r.extendedData!.categories.map(c => c.name)).toEqual(['Pizza', 'Pasta']);
    // Standard-Sektion bleibt sauber
    expect(r.productGroups.map(p => p.name)).toEqual(['Food (Speisen)']);
  });
});
