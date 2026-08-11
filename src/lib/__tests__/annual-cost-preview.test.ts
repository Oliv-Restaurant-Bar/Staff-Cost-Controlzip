// @vitest-environment node
/**
 * annual-cost-preview.test.ts — Konto×Monat-Vorschau + Konfliktmodi (reine Logik)
 * Kernregeln: fehlend ≠ 0 (null); 3xxx explizit ausgewiesen; Pre-Merge lässt
 * den Schreib-Kern unverändert («unangetastet» = bestehende Kategorien).
 */
import { describe, it, expect } from 'vitest';
import {
  buildAnnualCostPreview,
  applyImportMode,
  sameCategorySet,
} from '../annual-cost-preview';
import type { ExpenseCategory } from '@/types/reporting';

const cat = (id: string, amount: number, label = `Konto ${id}`): ExpenseCategory =>
  ({ categoryId: id, label, amount });

describe('buildAnnualCostPreview', () => {
  it('Status je Zelle: neu / identisch / ueberschreiben / entfernt; fehlend = null', () => {
    const neu = new Map<number, ExpenseCategory[]>([
      [1, [cat('4000', 100), cat('6000', 50)]],
      [2, [cat('4000', 120)]],
    ]);
    const bestehend = new Map<number, ExpenseCategory[]>([
      [1, [cat('4000', 100), cat('6500', 30)]],
      [2, [cat('4000', 99)]],
    ]);
    const p = buildAnnualCostPreview(neu, bestehend);

    const r4000 = p.rows.find(r => r.accountNumber === '4000')!;
    expect(r4000.cells[0].status).toBe('identisch');
    expect(r4000.cells[1].status).toBe('ueberschreiben');
    expect(r4000.cells[2]).toMatchObject({ newAmount: null, existingAmount: null, status: null });

    const r6000 = p.rows.find(r => r.accountNumber === '6000')!;
    expect(r6000.cells[0].status).toBe('neu');

    const r6500 = p.rows.find(r => r.accountNumber === '6500')!;
    expect(r6500.cells[0].status).toBe('entfernt');

    expect(p.monthsInFile).toEqual([1, 2]);
    expect(p.incompleteYear).toBe(true);
    expect(p.conflictMonths).toEqual([1, 2]); // Jan: 6500 entfernt; Feb: 4000 geändert
    expect(p.warnings.some(w => w.includes('Unvollständiges Jahr'))).toBe(true);
  });

  it('clearedMonths: bestehender Monat fehlt in der Datei (replace-Warnung)', () => {
    const neu = new Map<number, ExpenseCategory[]>([[1, [cat('4000', 10)]]]);
    const bestehend = new Map<number, ExpenseCategory[]>([[3, [cat('4000', 77)]]]);
    const p = buildAnnualCostPreview(neu, bestehend);
    expect(p.clearedMonths).toEqual([3]);
    expect(p.warnings.some(w => w.includes('Ersetzen') && w.includes('Mär'))).toBe(true);
  });

  it('3xxx-Umsatzkonten werden explizit ausgewiesen (ER-Umsatz-Warnung)', () => {
    const neu = new Map<number, ExpenseCategory[]>([[5, [cat('3000', 5000), cat('4000', 10)]]]);
    const p = buildAnnualCostPreview(neu, new Map());
    expect(p.revenueAccounts).toEqual(['3000']);
    const r3000 = p.rows.find(r => r.accountNumber === '3000')!;
    expect(r3000.isRevenueAccount).toBe(true);
    expect(p.warnings.some(w => w.includes('Umsatzkonto') && w.includes('3000'))).toBe(true);
  });

  it('[Unzugeordnet]-Konten und Duplikate (summiert) werden gemeldet', () => {
    const neu = new Map<number, ExpenseCategory[]>([
      [1, [cat('9999', 5, '[Unzugeordnet] Divers'), cat('4000', 10), cat('4000', 15)]],
    ]);
    const p = buildAnnualCostPreview(neu, new Map());
    expect(p.unmappedAccounts).toEqual(['9999']);
    expect(p.duplicateAccounts).toEqual([{ month: 1, accountNumber: '4000' }]);
    const r4000 = p.rows.find(r => r.accountNumber === '4000')!;
    expect(r4000.cells[0].newAmount).toBe(25); // summiert
    expect(p.warnings.some(w => w.includes('Doppelte Konto-Einträge'))).toBe(true);
  });

  it('nicht-numerische (manuelle) Kategorien werden ignoriert', () => {
    const bestehend = new Map<number, ExpenseCategory[]>([
      [1, [cat('miete', 1000, 'Miete manuell'), cat('4000', 10)]],
    ]);
    const p = buildAnnualCostPreview(new Map(), bestehend);
    expect(p.rows.map(r => r.accountNumber)).toEqual(['4000']);
  });

  it('leere Datei ⇒ klare Warnung, keine Zeilen aus dem Nichts', () => {
    const p = buildAnnualCostPreview(new Map(), new Map());
    expect(p.rows).toEqual([]);
    expect(p.monthsInFile).toEqual([]);
    expect(p.warnings.some(w => w.includes('keine Monatsdaten'))).toBe(true);
  });

  it('Jahressummen: newTotal/existingTotal nur aus vorhandenen Werten', () => {
    const neu = new Map<number, ExpenseCategory[]>([
      [1, [cat('4000', 100)]],
      [2, [cat('4000', -20)]], // Korrekturbuchung bleibt Rohwert
    ]);
    const bestehend = new Map<number, ExpenseCategory[]>([[1, [cat('4000', 50)]]]);
    const p = buildAnnualCostPreview(neu, bestehend);
    const r = p.rows.find(x => x.accountNumber === '4000')!;
    expect(r.newTotal).toBe(80);
    expect(r.existingTotal).toBe(50);
  });
});

describe('applyImportMode (Pre-Merge)', () => {
  const neu = new Map<number, ExpenseCategory[]>([
    [1, [cat('4000', 100)]],
    [2, [cat('4000', 120), cat('6000', 60)]],
    [3, [cat('4000', 130)]],
  ]);
  const bestehend = new Map<number, ExpenseCategory[]>([
    [2, [cat('4000', 99)]],
    [4, [cat('4000', 44)]],
  ]);

  it('replace: Datei gewinnt, absente Monate ohne Eintrag (Schreib-Kern cleart)', () => {
    const { effective, monthsSkipped } = applyImportMode('replace', neu, bestehend);
    expect(effective.get(1)).toEqual([cat('4000', 100)]);
    expect(effective.get(2)).toEqual([cat('4000', 120), cat('6000', 60)]);
    expect(effective.has(4)).toBe(false); // → Kern cleart Monat 4
    expect(monthsSkipped).toEqual([]);
  });

  it('keep-existing: bestehende Werte bleiben, nur neue Konten ergänzt', () => {
    const { effective, monthsSkipped } = applyImportMode('keep-existing', neu, bestehend);
    expect(effective.get(1)).toEqual([cat('4000', 100)]);          // vorher leer → Datei
    expect(effective.get(2)).toEqual([cat('4000', 99), cat('6000', 60)]); // 4000 alt bleibt, 6000 neu
    expect(effective.get(4)).toEqual([cat('4000', 44)]);           // unangetastet (No-op)
    expect(monthsSkipped).toEqual([]);                             // Feb teilweise angewendet
  });

  it('keep-existing ohne neue Konten ⇒ Monat übersprungen', () => {
    const neuNurAlt = new Map<number, ExpenseCategory[]>([[2, [cat('4000', 500)]]]);
    const { effective, monthsSkipped } = applyImportMode('keep-existing', neuNurAlt, bestehend);
    expect(effective.get(2)).toEqual([cat('4000', 99)]); // identisch → Dirty-Check-No-op
    expect(monthsSkipped).toEqual([2]);
  });

  it('fill-empty: nur leere Monate erhalten Daten, cleart NIE absente Monate', () => {
    const { effective, monthsSkipped } = applyImportMode('fill-empty', neu, bestehend);
    expect(effective.get(1)).toEqual([cat('4000', 100)]);
    expect(effective.get(3)).toEqual([cat('4000', 130)]);
    expect(effective.get(2)).toEqual([cat('4000', 99)]); // bestehend bleibt (No-op)
    expect(effective.get(4)).toEqual([cat('4000', 44)]); // absent in Datei → unangetastet
    expect(monthsSkipped).toEqual([2]);
  });

  it('selective: nur gewählte Monate; ungewählte mit Datei-Daten zählen als übersprungen', () => {
    const { effective, monthsSkipped } = applyImportMode('selective', neu, bestehend, new Set([2]));
    expect(effective.get(2)).toEqual([cat('4000', 120), cat('6000', 60)]);
    expect(effective.has(1)).toBe(false);                // ungewählt, kein Bestand → kein Eintrag
    expect(effective.get(4)).toEqual([cat('4000', 44)]); // ungewählt, Bestand → unangetastet
    expect(monthsSkipped).toEqual([1, 3]);
  });

  it('selective: gewählter Monat ohne Datei-Daten wird bewusst gecleart', () => {
    const { effective } = applyImportMode('selective', neu, bestehend, new Set([4]));
    expect(effective.has(4)).toBe(false); // kein Eintrag ⇒ Schreib-Kern entfernt Kontodaten
  });

  it('manuelle Kategorien im Bestand fliessen NIE in den Pre-Merge ein', () => {
    const bestehendMitManuell = new Map<number, ExpenseCategory[]>([
      [2, [cat('miete', 1000, 'Miete manuell'), cat('4000', 99)]],
    ]);
    const { effective } = applyImportMode('fill-empty', neu, bestehendMitManuell);
    expect(effective.get(2)).toEqual([cat('4000', 99)]); // Kern behält manuelle selbst
  });
});

describe('sameCategorySet (Dirty-Check-Helfer)', () => {
  it('Reihenfolge egal, Betrag/Label/Id zählen', () => {
    expect(sameCategorySet(
      [cat('4000', 10), cat('6000', 20)],
      [cat('6000', 20), cat('4000', 10)],
    )).toBe(true);
    expect(sameCategorySet([cat('4000', 10)], [cat('4000', 11)])).toBe(false);
    expect(sameCategorySet([cat('4000', 10)], [])).toBe(false);
    expect(sameCategorySet([], [])).toBe(true);
  });
});

// ─── Manuell geschützte Zeilen (Vorschau-Gruppe + Summary) ────────────────────

import { sammleManuellGeschuetzt, zaehleImportZeilen, geschuetztKey } from '../annual-cost-preview';

const mcat = (id: string, amount: number, quelle?: 'import' | 'manuell'): ExpenseCategory =>
  ({ categoryId: id, label: `Konto ${id}`, amount, ...(quelle ? { quelle } : {}) });

describe('sammleManuellGeschuetzt', () => {
  it('listet nur numerische quelle=manuell-Zeilen; Importwert & abweichend korrekt', () => {
    const bestehend = new Map<number, ExpenseCategory[]>([
      [3, [mcat('5004', 4200, 'manuell'), mcat('4000', 100, 'import'), { categoryId: 'miete', label: 'Miete', amount: 900, quelle: 'manuell' }]],
      [4, [mcat('5004', 4300, 'manuell')]],
    ]);
    const neu = new Map<number, ExpenseCategory[]>([
      [3, [mcat('5004', 9999), mcat('4000', 100)]],
      // Monat 4: 5004 fehlt in der Datei
    ]);
    const rows = sammleManuellGeschuetzt(neu, bestehend);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ month: 3, accountNumber: '5004', manuellerWert: 4200, importWert: 9999, abweichend: true });
    expect(rows[1]).toMatchObject({ month: 4, importWert: null, abweichend: false });
  });
});

describe('zaehleImportZeilen', () => {
  it('zählt aktualisiert/geschützt/neu; Freigabe verschiebt geschützt → aktualisiert', () => {
    const bestehend = new Map<number, ExpenseCategory[]>([
      [1, [mcat('5004', 4200, 'manuell'), mcat('4000', 100)]],
    ]);
    const neu = new Map<number, ExpenseCategory[]>([
      [1, [mcat('5004', 9999), mcat('4000', 150), mcat('6000', 50)]],
    ]);
    const diff = buildAnnualCostPreview(neu, bestehend);
    const geschuetzt = sammleManuellGeschuetzt(neu, bestehend);

    const s1 = zaehleImportZeilen(diff, geschuetzt, new Set());
    expect(s1).toEqual({ aktualisiert: 1, geschuetzt: 1, neu: 1 });

    const s2 = zaehleImportZeilen(diff, geschuetzt, new Set([geschuetztKey(1, '5004')]));
    expect(s2).toEqual({ aktualisiert: 2, geschuetzt: 0, neu: 1 });
  });
});
