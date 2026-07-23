// @vitest-environment node
/**
 * Tests der reinen Persistenz-Helfer für den erweiterten Z-Bericht:
 * buildExtendedPositionRows (Dedupe nach UNIQUE-Schlüssel) und
 * isMissingExtendedSchemaError (Migrationshinweis-Erkennung).
 */
import { describe, it, expect, vi } from 'vitest';

// Der DB-Layer importiert den Supabase-Client (braucht localStorage) —
// hier werden NUR reine Helfer getestet, der Client wird gemockt.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import {
  buildExtendedPositionRows,
  isMissingExtendedSchemaError,
  GN_EXT_MIGRATION_HINT,
} from '../gn-zbericht-db';
import type { GnExtendedData } from '../gn-zbericht-parser';

const emptyExt = (): GnExtendedData => ({
  mainCategoriesByConsumptionType: [],
  categories: [],
  categoriesByConsumptionType: [],
  positions: [],
});

describe('buildExtendedPositionRows', () => {
  it('baut Zeilen für alle vier Abschnitte mit Abschnitts-Schlüssel', () => {
    const ext = emptyExt();
    ext.mainCategoriesByConsumptionType.push({ name: 'Beverage', quantity: 10, grossAmount: 100, originalAmount: null, consumptionType: 'in_house' });
    ext.categories.push({ name: 'Wein - Rot', quantity: 5, grossAmount: 250.5, originalAmount: 260, consumptionType: null });
    ext.categoriesByConsumptionType.push({ name: 'Wein - Rot', quantity: 5, grossAmount: 250.5, originalAmount: null, consumptionType: 'takeaway' });
    ext.positions.push({ name: 'Espresso', quantity: 37, grossAmount: 164.3, originalAmount: 196.1, consumptionType: null });

    const rows = buildExtendedPositionRows('imp-1', 'oliv', '2026-07-01', '2026-07-01', ext);
    expect(rows).toHaveLength(4);
    expect(rows.map(r => r.section).sort()).toEqual(
      ['categories', 'categories_ct', 'main_categories_ct', 'positions']);
    const pos = rows.find(r => r.section === 'positions')!;
    expect(pos).toMatchObject({
      import_id: 'imp-1', restaurant_id: 'oliv',
      period_from: '2026-07-01', period_to: '2026-07-01',
      name: 'Espresso', quantity: 37, gross_amount: 164.3, original_amount: 196.1,
      consumption_type: null,
    });
  });

  it('dedupliziert identische (section, name, consumptionType) durch Summierung', () => {
    const ext = emptyExt();
    ext.positions.push(
      { name: 'Espresso', quantity: 2, grossAmount: 8.4, originalAmount: null, consumptionType: null },
      { name: 'Espresso', quantity: 3, grossAmount: 12.6, originalAmount: 14, consumptionType: null },
    );
    const rows = buildExtendedPositionRows('imp-1', 'oliv', '2026-07-01', '2026-07-01', ext);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(5);
    expect(rows[0].gross_amount).toBe(21);
    expect(rows[0].original_amount).toBe(14);
  });

  it('trennt gleiche Namen mit unterschiedlichem consumptionType (kein Merge)', () => {
    const ext = emptyExt();
    ext.categoriesByConsumptionType.push(
      { name: 'Bier', quantity: 4, grossAmount: 20, originalAmount: null, consumptionType: 'in_house' },
      { name: 'Bier', quantity: 1, grossAmount: 5, originalAmount: null, consumptionType: 'takeaway' },
    );
    const rows = buildExtendedPositionRows('imp-1', 'b-oliv', null, null, ext);
    expect(rows).toHaveLength(2);
  });

  it('behält 0-CHF-Positionen mit Menge > 0 vollständig', () => {
    const ext = emptyExt();
    ext.positions.push({ name: 'ohne', quantity: 30, grossAmount: 0, originalAmount: null, consumptionType: null });
    const rows = buildExtendedPositionRows('imp-1', 'oliv', '2026-07-01', '2026-07-01', ext);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'ohne', quantity: 30, gross_amount: 0 });
  });

  it('überspringt Einträge ohne Namen, original_amount bleibt null wenn nie vorhanden', () => {
    const ext = emptyExt();
    ext.positions.push(
      { name: '', quantity: 1, grossAmount: 5, originalAmount: null, consumptionType: null },
      { name: 'Cola', quantity: 1, grossAmount: 5, originalAmount: null, consumptionType: null },
    );
    const rows = buildExtendedPositionRows('imp-1', 'oliv', null, null, ext);
    expect(rows).toHaveLength(1);
    expect(rows[0].original_amount).toBeNull();
  });
});

describe('isMissingExtendedSchemaError', () => {
  it('erkennt fehlende Tabelle (42P01/PGRST205) und fehlende Spalte (42703/PGRST204)', () => {
    expect(isMissingExtendedSchemaError({ code: '42P01', message: 'relation "gn_extended_positions" does not exist' })).toBe(true);
    expect(isMissingExtendedSchemaError({ code: 'PGRST205', message: "Could not find the table 'public.gn_extended_positions' in the schema cache" })).toBe(true);
    expect(isMissingExtendedSchemaError({ code: '42703', message: 'column "report_type" of relation "gn_imports" does not exist' })).toBe(true);
    expect(isMissingExtendedSchemaError({ code: 'PGRST204', message: "Could not find the 'report_type' column of 'gn_imports' in the schema cache" })).toBe(true);
  });

  it('meldet KEINE anderen Fehler als Migrationshinweis', () => {
    expect(isMissingExtendedSchemaError(null)).toBe(false);
    expect(isMissingExtendedSchemaError({ code: '42501', message: 'new row violates row-level security policy' })).toBe(false);
    expect(isMissingExtendedSchemaError({ code: '42P01', message: 'relation "andere_tabelle" does not exist' })).toBe(false);
    expect(isMissingExtendedSchemaError({ code: '23505', message: 'duplicate key value violates unique constraint "gn_extended_positions_uniq"' })).toBe(false);
  });

  it('Migrationshinweis nennt die Migrationsdatei', () => {
    expect(GN_EXT_MIGRATION_HINT).toContain('20260723_gn_extended_positions.sql');
  });
});
