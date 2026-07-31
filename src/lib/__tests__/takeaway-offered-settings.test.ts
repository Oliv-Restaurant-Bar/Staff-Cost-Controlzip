// @vitest-environment node
/**
 * Test: Take Away pro Mandant konfigurierbar («Betrieb bietet Take Away»)
 * ======================================================================
 * Reine, DB-freie Logik:
 *   - Mandanten-Defaults: oliv = ja (true), beaulieu = nein (false).
 *   - normalize: gespeicherter boolean-Wert gewinnt (auch `false`);
 *     fehlend/ungültig → Mandanten-Default.
 *   - filterTakeAwayRows: bei «nein» fehlen die TA-Zeilen (gaeste_take_away,
 *     take_away_anteil), bei «ja» sind alle Zeilen unverändert vorhanden;
 *     Trennzeilen (ohne id) bleiben immer erhalten.
 *   - Custom-Row-Order mit TA-IDs bricht nach dem Filtern NICHT (applyRowOrder
 *     ignoriert unbekannte/entfernte IDs).
 *
 * supabase-db wird gemockt, damit der Import keinen Supabase-Client zieht
 * (jsdom/canvas-Crash vermeiden; reine Logik bleibt unberührt).
 */
import { describe, it, expect, vi } from 'vitest';

// Supabase-Client stubben (braucht localStorage/browser), damit der Import von
// monatsreport.ts / supabase-db unter node läuft — reine Logik bleibt unberührt.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/supabase-db', () => ({
  loadSetting: vi.fn(async () => null),
  saveSetting: vi.fn(async () => undefined),
}));

import {
  defaultTakeAwayOffered,
  normalizeTakeAwayOffered,
  filterTakeAwayRows,
  TAKEAWAY_ROW_IDS,
  TAKEAWAY_OFFERED_KEY,
} from '@/lib/takeaway-offered-settings';
import { applyRowOrder, anchorTakeAwayUmsatz, type MrRow } from '@/lib/monatsreport';

describe('Take Away — Mandanten-Defaults', () => {
  it('oliv → Default ja (true)', () => {
    expect(defaultTakeAwayOffered('oliv')).toBe(true);
  });
  it('beaulieu → Default nein (false)', () => {
    expect(defaultTakeAwayOffered('beaulieu')).toBe(false);
  });
});

describe('Take Away — normalizeTakeAwayOffered', () => {
  it('fehlend (null/undefined) → Mandanten-Default', () => {
    expect(normalizeTakeAwayOffered(null, 'oliv').offered).toBe(true);
    expect(normalizeTakeAwayOffered(undefined, 'beaulieu').offered).toBe(false);
  });
  it('leeres Objekt → Mandanten-Default', () => {
    expect(normalizeTakeAwayOffered({}, 'oliv').offered).toBe(true);
    expect(normalizeTakeAwayOffered({}, 'beaulieu').offered).toBe(false);
  });
  it('ungültiger Typ → Mandanten-Default', () => {
    expect(normalizeTakeAwayOffered({ offered: 'yes' as any }, 'beaulieu').offered).toBe(false);
    expect(normalizeTakeAwayOffered({ offered: 1 as any }, 'oliv').offered).toBe(true);
  });
  it('gespeicherter boolean gewinnt — auch entgegen dem Default', () => {
    // beaulieu (Default nein) mit gespeichertem true → true
    expect(normalizeTakeAwayOffered({ offered: true }, 'beaulieu').offered).toBe(true);
    // oliv (Default ja) mit gespeichertem false → false
    expect(normalizeTakeAwayOffered({ offered: false }, 'oliv').offered).toBe(false);
  });
  it('reicht updatedAt durch', () => {
    const iso = '2025-01-02T03:04:05.000Z';
    expect(normalizeTakeAwayOffered({ offered: true, updatedAt: iso }, 'oliv').updatedAt).toBe(iso);
  });
});

describe('Take Away — filterTakeAwayRows', () => {
  const mk = (): MrRow[] => ([
    { type: 'data', id: 'gaeste_in', label: 'Gäste IN', month: 1, week: null, budget: null, vj: null, vjMonth: null, weekBudget: null, monthBudget: null },
    { type: 'data', id: 'gaeste_take_away', label: 'Gäste Take Away', month: 2, week: null, budget: null, vj: null, vjMonth: null, weekBudget: null, monthBudget: null },
    { type: 'empty', month: null, week: null, budget: null, vj: null, vjMonth: null, weekBudget: null, monthBudget: null },
    { type: 'data', id: 'durchschnittsverkauf', label: 'Durchschnittsverkauf', month: 3, week: null, budget: null, vj: null, vjMonth: null, weekBudget: null, monthBudget: null },
    { type: 'data', id: 'take_away_anteil', label: 'Take Away Anteil', month: 4, week: null, budget: null, vj: null, vjMonth: null, weekBudget: null, monthBudget: null },
    { type: 'data', id: 'take_away_umsatz', label: 'Take Away Umsatz', month: 5, week: null, budget: null, vj: null, vjMonth: null, weekBudget: null, monthBudget: null },
  ]) as MrRow[];

  it('offered=true → alle Zeilen unverändert', () => {
    const rows = mk();
    const out = filterTakeAwayRows(rows, true);
    expect(out).toBe(rows); // identische Referenz (kein Kopieren nötig)
    expect(out.map(r => r.id)).toContain('gaeste_take_away');
    expect(out.map(r => r.id)).toContain('take_away_anteil');
    expect(out.map(r => r.id)).toContain('take_away_umsatz');
  });

  it('offered=false → alle TA-Zeilen fehlen, restliche bleiben', () => {
    const out = filterTakeAwayRows(mk(), false);
    const ids = out.filter(r => r.type === 'data').map(r => r.id);
    expect(ids).not.toContain('gaeste_take_away');
    expect(ids).not.toContain('take_away_anteil');
    expect(ids).not.toContain('take_away_umsatz');
    expect(ids).toContain('gaeste_in');
    expect(ids).toContain('durchschnittsverkauf');
    // Trennzeile (ohne id) bleibt erhalten
    expect(out.some(r => r.type === 'empty')).toBe(true);
  });

  it('TAKEAWAY_ROW_IDS deckt genau die drei TA-Zeilen ab', () => {
    expect([...TAKEAWAY_ROW_IDS].sort()).toEqual(['gaeste_take_away', 'take_away_anteil', 'take_away_umsatz']);
  });

  it('Key ist der erwartete, tenantKey-tauglich (roh, unpräfixiert)', () => {
    expect(TAKEAWAY_OFFERED_KEY).toBe('takeaway_offered_v1');
  });
});

describe('Take Away — Custom-Row-Order bricht nicht bei entfernten TA-IDs', () => {
  const mk = (): MrRow[] => ([
    { type: 'data', id: 'gaeste_in', label: 'Gäste IN', month: 1, week: null, budget: null, vj: null, vjMonth: null, weekBudget: null, monthBudget: null },
    { type: 'data', id: 'gaeste_take_away', label: 'Gäste Take Away', month: 2, week: null, budget: null, vj: null, vjMonth: null, weekBudget: null, monthBudget: null },
    { type: 'data', id: 'durchschnittsverkauf', label: 'Durchschnittsverkauf', month: 3, week: null, budget: null, vj: null, vjMonth: null, weekBudget: null, monthBudget: null },
    { type: 'data', id: 'take_away_anteil', label: 'Take Away Anteil', month: 4, week: null, budget: null, vj: null, vjMonth: null, weekBudget: null, monthBudget: null },
  ]) as MrRow[];

  // Eine gespeicherte Reihenfolge, die die TA-IDs enthält.
  const savedOrder = ['take_away_anteil', 'gaeste_take_away', 'gaeste_in', 'durchschnittsverkauf'];

  it('gefilterte Zeilen (offered=false) + Custom-Order → keine TA-IDs, kein Crash, restliche geordnet', () => {
    const filtered = filterTakeAwayRows(mk(), false);
    const ordered = applyRowOrder(filtered, savedOrder);
    const ids = ordered.map(r => r.id);
    expect(ids).not.toContain('gaeste_take_away');
    expect(ids).not.toContain('take_away_anteil');
    // Die im Setting zuerst gelisteten (noch existierenden) IDs führen die Reihenfolge an.
    expect(ids).toEqual(['gaeste_in', 'durchschnittsverkauf']);
  });

  it('offered=true + Custom-Order → alle vier in gespeicherter Reihenfolge', () => {
    const filtered = filterTakeAwayRows(mk(), true);
    const ordered = applyRowOrder(filtered, savedOrder);
    expect(ordered.map(r => r.id)).toEqual(savedOrder);
  });
});

describe('Take Away Umsatz — Anker bei alten gespeicherten Reihenfolgen', () => {
  const row = (id: string): MrRow => ({
    type: 'data', id, label: id, month: 1, week: null, budget: null,
    vj: null, vjMonth: null, weekBudget: null, monthBudget: null,
  } as MrRow);

  it('Order OHNE take_away_umsatz → Zeile rutscht NICHT ans Ende, sondern direkt hinter die letzte TA-Zeile', () => {
    const rows = [
      row('netto_umsatz'), row('take_away_anteil'), row('gaeste_take_away'),
      row('durchschnittsverkauf'), row('take_away_umsatz'),
    ];
    // Altes Setting kennt take_away_umsatz noch nicht → applyRowOrder hängt es
    // hinten an; der Anker zieht es zu den TA-Zeilen.
    const saved = ['netto_umsatz', 'take_away_anteil', 'gaeste_take_away', 'durchschnittsverkauf'];
    const out = applyRowOrder(rows, saved);
    expect(out.map(r => r.id)).toEqual([
      'netto_umsatz', 'take_away_anteil', 'gaeste_take_away', 'take_away_umsatz', 'durchschnittsverkauf',
    ]);
  });

  it('Order MIT take_away_umsatz → Nutzer-Position bleibt massgeblich (kein Anker)', () => {
    const rows = [
      row('netto_umsatz'), row('take_away_anteil'), row('gaeste_take_away'), row('take_away_umsatz'),
    ];
    const saved = ['take_away_umsatz', 'netto_umsatz', 'take_away_anteil', 'gaeste_take_away'];
    const out = applyRowOrder(rows, saved);
    expect(out.map(r => r.id)).toEqual(saved);
  });

  it('anchorTakeAwayUmsatz: ohne TA-Ankerzeilen bleibt alles unverändert', () => {
    const rows = [row('netto_umsatz'), row('take_away_umsatz')];
    expect(anchorTakeAwayUmsatz(rows, null).map(r => r.id))
      .toEqual(['netto_umsatz', 'take_away_umsatz']);
  });
});
