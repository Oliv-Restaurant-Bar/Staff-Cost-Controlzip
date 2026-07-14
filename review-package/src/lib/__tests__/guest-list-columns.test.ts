// @vitest-environment node
/**
 * Tests für das Spaltenmodell der Gästeliste (guest-list-columns.ts).
 * Reine Logik + localStorage-Persistenz mit gestubbtem window. Keine PII.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GUEST_COLUMNS,
  GUEST_COLUMN_BY_KEY,
  DEFAULT_VISIBLE_COLUMNS,
  validateVisibleColumns,
  toggleColumn,
  loadVisibleColumns,
  saveVisibleColumns,
  type GuestColumnKey,
} from '../guest-list-columns';

describe('GUEST_COLUMNS / Defaults', () => {
  it('enthält 16 eindeutige Spalten in stabiler Reihenfolge', () => {
    expect(GUEST_COLUMNS).toHaveLength(16);
    const keys = GUEST_COLUMNS.map(c => c.key);
    expect(new Set(keys).size).toBe(16);
    expect(keys[0]).toBe('name');
    expect(keys).not.toContain('allergies');
    expect(keys).not.toContain('crmNote');
  });

  it('hat genau 9 Standardspalten inkl. Pflicht-Kennzahlen', () => {
    expect(DEFAULT_VISIBLE_COLUMNS).toHaveLength(9);
    for (const k of ['name', 'segment', 'visits', 'partySize', 'firstVisit', 'lastVisit', 'interval', 'sinceLast', 'returnRisk'] as GuestColumnKey[]) {
      expect(DEFAULT_VISIBLE_COLUMNS).toContain(k);
    }
    expect(DEFAULT_VISIBLE_COLUMNS).not.toContain('company');
    expect(DEFAULT_VISIBLE_COLUMNS).not.toContain('vipManual');
  });

  it('GUEST_COLUMN_BY_KEY spiegelt jede Spalte', () => {
    for (const c of GUEST_COLUMNS) {
      expect(GUEST_COLUMN_BY_KEY[c.key]).toBe(c);
    }
  });
});

describe('validateVisibleColumns', () => {
  it('Nicht-Array → Standard', () => {
    expect(validateVisibleColumns(null)).toEqual(DEFAULT_VISIBLE_COLUMNS);
    expect(validateVisibleColumns('name')).toEqual(DEFAULT_VISIBLE_COLUMNS);
    expect(validateVisibleColumns(undefined)).toEqual(DEFAULT_VISIBLE_COLUMNS);
  });

  it('verwirft unbekannte Schlüssel', () => {
    expect(validateVisibleColumns(['name', 'unsinn', 'visits'])).toEqual(['name', 'visits']);
  });

  it('leer nach Bereinigung → Standard', () => {
    expect(validateVisibleColumns([])).toEqual(DEFAULT_VISIBLE_COLUMNS);
    expect(validateVisibleColumns(['unsinn', 42, null])).toEqual(DEFAULT_VISIBLE_COLUMNS);
  });

  it('dedupliziert und stellt kanonische Reihenfolge her', () => {
    // Eingabe ungeordnet + doppelt → Reihenfolge folgt GUEST_COLUMNS.
    expect(validateVisibleColumns(['visits', 'name', 'visits', 'segment'])).toEqual(['name', 'segment', 'visits']);
  });
});

describe('toggleColumn', () => {
  it('fügt eine Spalte hinzu (kanonische Reihenfolge)', () => {
    expect(toggleColumn(['name', 'visits'], 'segment')).toEqual(['name', 'segment', 'visits']);
  });
  it('entfernt eine vorhandene Spalte', () => {
    expect(toggleColumn(['name', 'segment', 'visits'], 'segment')).toEqual(['name', 'visits']);
  });
  it('lässt die letzte verbleibende Spalte stehen (No-Op)', () => {
    expect(toggleColumn(['name'], 'name')).toEqual(['name']);
  });
});

// ── localStorage-Persistenz (gestubbtes window) ───────────────────────────────

describe('load/saveVisibleColumns', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('ohne gespeicherten Wert → Standard', () => {
    expect(loadVisibleColumns()).toEqual(DEFAULT_VISIBLE_COLUMNS);
  });

  it('Round-Trip: speichert und lädt eine gültige Auswahl', () => {
    saveVisibleColumns(['name', 'company', 'visits']);
    expect(loadVisibleColumns()).toEqual(['name', 'company', 'visits']);
  });

  it('beschädigter Speicher (kein JSON) → Standard', () => {
    store['gaeste:visibleColumns'] = '{nicht json';
    expect(loadVisibleColumns()).toEqual(DEFAULT_VISIBLE_COLUMNS);
  });

  it('speichert nur validierte Schlüssel', () => {
    saveVisibleColumns(['name', 'unsinn' as GuestColumnKey, 'segment']);
    expect(loadVisibleColumns()).toEqual(['name', 'segment']);
  });
});
