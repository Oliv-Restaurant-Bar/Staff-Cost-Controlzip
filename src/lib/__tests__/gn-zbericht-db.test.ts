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

import { checkOverlappingImports , waehleAktiveTagesImporte } from '@/lib/gn-zbericht-db';

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

describe('waehleAktiveTagesImporte (nie doppelt zählen)', () => {
  const row = (id: string, tag: string, cc: string | null, at: string) =>
    ({ id, period_from: tag, period_to: tag, cost_center: cc, imported_at: at });
  it('zwei konkurrierende Voll-Tagesberichte → nur der jüngste', () => {
    const sel = waehleAktiveTagesImporte([row('a', '2026-08-01', null, '2026-08-02T08:00Z'), row('b', '2026-08-01', '', '2026-08-02T09:00Z')]);
    expect(sel.map(r => r.id)).toEqual(['b']);
  });
  it('verschiedene Kostenstellen desselben Tags werden zusammen verwendet', () => {
    const sel = waehleAktiveTagesImporte([row('a', '2026-08-01', 'Oliv', '1'), row('b', '2026-08-01', 'Beaulieu', '2')]);
    expect(sel.map(r => r.id).sort()).toEqual(['a', 'b']);
  });
  it('gleiche Kostenstelle doppelt → nur der jüngste', () => {
    const sel = waehleAktiveTagesImporte([row('a', '2026-08-01', 'Oliv', '1'), row('b', '2026-08-01', 'oliv ', '2')]);
    expect(sel.map(r => r.id)).toEqual(['b']);
  });
  it('Voll-Tagesbericht deckt den Tag ab — Kostenstellen-Teilberichte fallen weg', () => {
    const sel = waehleAktiveTagesImporte([row('a', '2026-08-01', 'Oliv', '1'), row('v', '2026-08-01', null, '2'), row('b', '2026-08-01', 'Beaulieu', '3')]);
    expect(sel.map(r => r.id)).toEqual(['v']);
  });
  it('Perioden-Importe werden ignoriert', () => {
    const sel = waehleAktiveTagesImporte([{ id: 'p', period_from: '2026-08-01', period_to: '2026-08-31', cost_center: null, imported_at: '1' }]);
    expect(sel).toEqual([]);
  });
});
