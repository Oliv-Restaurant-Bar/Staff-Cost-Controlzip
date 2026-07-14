// @vitest-environment node
/**
 * Schutztest: checkOverlappingImports — Kostenstellen-Filter
 * =========================================================
 * Sichert die Datenintegritäts-Regel ab, dass der Kostenstellen-Filter NUR bei
 * einer NICHT-LEEREN Kostenstelle greift.  Sonst würde ein Batch-Import ohne
 * erkannte Kostenstelle bestehende Tagesimporte MIT Kostenstelle übersehen und
 * denselben Tag doppelt aktiv anlegen (doppelter Umsatz).
 *
 * Szenarien:
 *   1. Einzeldatei-Pfad (kein costCenter-Argument) → rein datumsbasiert
 *   2. Batch mit null-Kostenstelle → KEIN Filter (alle Tagesimporte zählen)
 *   3. Batch mit konkreter Kostenstelle → nur passende cost_center
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Supabase-Mock (chainable Query-Builder) ──────────────────────────────────
let _rows: Array<Record<string, unknown>> = [];
let _error: unknown = null;

function makeBuilder() {
  const builder: Record<string, unknown> = {
    from:   () => builder,
    select: () => builder,
    eq:     () => builder,
    lte:    () => builder,
    gte:    () => builder,
    neq:    () => builder,
    // thenable: `await q` löst zu { data, error } auf
    then:   (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
              resolve({ data: _rows, error: _error }),
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => makeBuilder() },
}));

import { checkOverlappingImports } from '@/lib/gn-zbericht-db';

const row = (id: string, cc: string | null) => ({
  id, file_name: id, period_from: '2026-06-01', period_to: '2026-06-01',
  z_counter: '1', gross_revenue: 1000, import_type: 'z_bericht', cost_center: cc,
});

describe('checkOverlappingImports — Kostenstellen-Filter', () => {
  beforeEach(() => { _rows = []; _error = null; });

  it('Einzeldatei-Pfad (ohne costCenter) → alle Tages-Überschneidungen, unabhängig von cost_center', async () => {
    _rows = [row('a', 'Restaurant Oliv'), row('b', null)];
    const out = await checkOverlappingImports('oliv', '2026-06-01', '2026-06-01');
    expect(out.map(o => o.id).sort()).toEqual(['a', 'b']);
  });

  it('Batch mit null-Kostenstelle → KEIN Filter (gesetzte cost_center wird NICHT herausgefiltert)', async () => {
    _rows = [row('a', 'Restaurant Oliv')];
    const out = await checkOverlappingImports('oliv', '2026-06-01', '2026-06-01', undefined, null);
    expect(out.map(o => o.id)).toEqual(['a']);
  });

  it('Batch mit konkreter Kostenstelle → nur passende cost_center', async () => {
    _rows = [row('a', 'Restaurant Oliv'), row('b', 'Restaurant Beaulieu')];
    const out = await checkOverlappingImports('oliv', '2026-06-01', '2026-06-01', undefined, 'Restaurant Oliv');
    expect(out.map(o => o.id)).toEqual(['a']);
  });

  it('Batch-Kostenstelle ist case/whitespace-insensitiv', async () => {
    _rows = [row('a', 'Restaurant Oliv'), row('b', 'Restaurant Beaulieu')];
    const out = await checkOverlappingImports('oliv', '2026-06-01', '2026-06-01', undefined, '  restaurant oliv ');
    expect(out.map(o => o.id)).toEqual(['a']);
  });
});
