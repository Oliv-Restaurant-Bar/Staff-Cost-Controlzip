// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { salesUploadSlotFromName } from '../sales-upload-slots';

describe('salesUploadSlotFromName (client file-name convention of the Sales Upload page)', () => {
  it.each([
    ['Anzahl Food 03.2026.csv', { category: 'food', kind: 'anzahl' }],
    ['Umsatz Food 03.2026.csv', { category: 'food', kind: 'umsatz' }],
    ['Anzahl Beverage 03.2026.csv', { category: 'beverage', kind: 'anzahl' }],
    ['umsatz_beverage_märz.csv', { category: 'beverage', kind: 'umsatz' }],
    ['Umsatz Getränke.csv', { category: 'beverage', kind: 'umsatz' }],
  ])('%s', (name, slot) => {
    expect(salesUploadSlotFromName(name)).toEqual(slot);
  });

  it.each([
    'export.csv',
    'Food 03.2026.csv',            // kind missing
    'Anzahl 03.2026.csv',          // category missing
    'Anzahl Umsatz Food.csv',      // both kinds
    'Anzahl Food Beverage.csv',    // both categories
    'Foodcost Umsatz.csv',         // «Foodcost» is not the word «food»
  ])('%s is not placed (never guessed)', name => {
    expect(salesUploadSlotFromName(name)).toBeNull();
  });
});
