// @vitest-environment node
/**
 * wes-month — verkaufsbasierter Wareneinsatz (SSoT, extrahiert aus der
 * WES-Analyse): Match über Name UND Kategorie, WES ≤ 0 übersprungen,
 * Monatsfilter strikt.
 */
import { describe, it, expect } from 'vitest';
import { computeVerkaufsWes, type WesSaleEntry, type WesCostEntry } from '../wes-month';

const COSTS: WesCostEntry[] = [
  { name: 'Burger', category: 'food', wes: 4.5 },
  { name: 'Cola', category: 'beverage', wes: 0.8 },
  { name: 'Espresso', category: 'beverage', wes: 0 }, // kein positiver WES ⇒ skip
  { name: 'Burger', category: 'beverage', wes: 99 }, // gleicher Name, andere Kategorie
];

const SALES: WesSaleEntry[] = [
  { name: 'Burger', category: 'food', month: '2026-07', count: 100 },
  { name: 'Cola', category: 'beverage', month: '2026-07', count: 200 },
  { name: 'Espresso', category: 'beverage', month: '2026-07', count: 500 },
  { name: 'Burger', category: 'food', month: '2026-06', count: 50 }, // anderer Monat
  { name: 'Unbekannt', category: 'food', month: '2026-07', count: 10 }, // kein Kostensatz
];

describe('computeVerkaufsWes', () => {
  it('summiert Verkaufsmenge × Rezept-WES je Kategorie, nur Zielmonat', () => {
    const r = computeVerkaufsWes(SALES, COSTS, '2026-07');
    expect(r.rezFood).toBeCloseTo(450); // 100 × 4.5 (Juni-Verkäufe nicht dabei)
    expect(r.rezBeverage).toBeCloseTo(160); // 200 × 0.8; Espresso-WES 0 übersprungen
    expect(r.rezTotal).toBeCloseTo(610);
  });

  it('Match über Name UND Kategorie — «Burger/beverage»-Kostensatz greift nicht für food', () => {
    const r = computeVerkaufsWes(
      [{ name: 'Burger', category: 'food', month: '2026-07', count: 1 }],
      COSTS,
      '2026-07',
    );
    expect(r.rezFood).toBeCloseTo(4.5); // 4.5, NICHT 99
  });

  it('keine Treffer ⇒ Totale 0 (Aufrufer interpretiert ≤ 0 als «keine Daten»)', () => {
    const r = computeVerkaufsWes(SALES, COSTS, '2025-01');
    expect(r.rezTotal).toBe(0);
  });

  it('count 0/fehlend trägt nichts bei', () => {
    const r = computeVerkaufsWes(
      [{ name: 'Burger', category: 'food', month: '2026-07', count: 0 }],
      COSTS,
      '2026-07',
    );
    expect(r.rezTotal).toBe(0);
  });
});
