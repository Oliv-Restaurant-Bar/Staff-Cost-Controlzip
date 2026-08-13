// @vitest-environment happy-dom
/**
 * Artikel-Tracking-Store: Mandanten-Trennung (Oliv ↔ Beaulieu).
 * Oliv nutzt den Legacy-Key 'artikel_purchases_v1' (bestehende globale
 * Daten gehören damit automatisch Oliv), Beaulieu den Key
 * 'beaulieu:artikel_purchases_v1'.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  addPurchase, deletePurchase, loadAllPurchases,
  loadPurchasesForMonth, availablePurchaseYears,
} from '../artikel-tracking-store';

// happy-dom liefert echtes localStorage (supabase-transitive Imports brauchen es)
const mem = {
  clear: () => localStorage.clear(),
  has: (k: string) => localStorage.getItem(k) !== null,
  set: (k: string, v: string) => localStorage.setItem(k, v),
};

const kauf = (name: string) => ({
  articleId: `art-${name}`, articleName: name, date: '2026-08-10',
  quantity: 2, pricePerUnit: 5, supplier: 'Test AG',
});

describe('Artikel-Tracking Mandanten-Trennung', () => {
  beforeEach(() => mem.clear());

  it('Oliv-Einkauf taucht in Beaulieu NICHT auf (und umgekehrt)', () => {
    addPurchase('oliv', kauf('Olivenöl'));
    addPurchase('beaulieu', kauf('Butter'));
    expect(loadAllPurchases('oliv').map(p => p.articleName)).toEqual(['Olivenöl']);
    expect(loadAllPurchases('beaulieu').map(p => p.articleName)).toEqual(['Butter']);
    expect(loadPurchasesForMonth('oliv', 2026, 8)).toHaveLength(1);
    expect(loadPurchasesForMonth('beaulieu', 2026, 8)).toHaveLength(1);
  });

  it('Storage-Keys: Oliv legacy-unpräfixiert, Beaulieu mit Präfix', () => {
    addPurchase('oliv', kauf('A'));
    addPurchase('beaulieu', kauf('B'));
    expect(mem.has('artikel_purchases_v1')).toBe(true);
    expect(mem.has('beaulieu:artikel_purchases_v1')).toBe(true);
  });

  it('Migration ohne Datenverlust: bestehende globale Daten gehören Oliv', () => {
    // Alt-Zustand: globaler Key mit Daten aus der Vor-Tenant-Ära
    mem.set('artikel_purchases_v1', JSON.stringify({
      alt1: { id: 'alt1', articleId: 'a', articleName: 'Altbestand', date: '2026-07-01', year: 2026, month: 7, quantity: 1, pricePerUnit: 3, totalCost: 3, supplier: 'X', createdAt: '', updatedAt: '' },
    }));
    expect(loadAllPurchases('oliv').map(p => p.articleName)).toEqual(['Altbestand']);
    expect(loadAllPurchases('beaulieu')).toEqual([]); // Beaulieu startet leer
  });

  it('Löschen wirkt nur im eigenen Mandanten', () => {
    const o = addPurchase('oliv', kauf('X'));
    const b = addPurchase('beaulieu', kauf('X'));
    deletePurchase('beaulieu', o.id); // falscher Mandant → no-op
    expect(loadAllPurchases('oliv')).toHaveLength(1);
    deletePurchase('oliv', o.id);
    expect(loadAllPurchases('oliv')).toHaveLength(0);
    expect(loadAllPurchases('beaulieu').map(p => p.id)).toEqual([b.id]);
  });

  it('availablePurchaseYears ist tenant-gebunden', () => {
    addPurchase('oliv', { ...kauf('Y'), date: '2024-03-01' });
    expect(availablePurchaseYears('oliv')).toContain(2024);
    expect(availablePurchaseYears('beaulieu')).not.toContain(2024);
  });
});
