// @vitest-environment happy-dom
/**
 * updateEmployeeStations: gezieltes Stations-Update mit Tenant-Präfix-Scope.
 *  - Cross-Tenant-IDs werden ABGELEHNT (kein Request).
 *  - UPDATE ist zusätzlich per ID-Präfix-Filter verankert (like/not-like).
 *  - 0 aktualisierte Zeilen = Fehler; Presence-Guard (nur übergebene Felder).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<{ patch: unknown; filters: string[] }> = [];
let returnedRows: Array<{ id: string }> = [{ id: 'x' }];

vi.mock('@/integrations/supabase/client', () => {
  const builder = (patch: unknown) => {
    const filters: string[] = [];
    const q: Record<string, unknown> = {
      eq: (col: string, v: string) => { filters.push(`eq:${col}=${v}`); return q; },
      like: (col: string, v: string) => { filters.push(`like:${col}=${v}`); return q; },
      not: (col: string, op: string, v: string) => { filters.push(`not:${col} ${op} ${v}`); return q; },
      select: () => { calls.push({ patch, filters }); return Promise.resolve({ data: returnedRows, error: null }); },
    };
    return q;
  };
  return {
    supabase: {
      from: () => ({ update: (patch: unknown) => builder(patch) }),
    },
  };
});

import { updateEmployeeStations } from '../supabase-db';

beforeEach(() => { calls.length = 0; returnedRows = [{ id: 'x' }]; });

describe('updateEmployeeStations', () => {
  it('lehnt Cross-Tenant-ID ab, ohne Request', async () => {
    const r1 = await updateEmployeeStations('b-169', { secondaryStations: [] }, 'oliv');
    expect(r1.ok).toBe(false);
    const r2 = await updateEmployeeStations('105', { secondaryStations: [] }, 'beaulieu');
    expect(r2.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('verankert das Tenant-Präfix im UPDATE-Filter', async () => {
    await updateEmployeeStations('105', { secondaryStations: ['service'] }, 'oliv');
    expect(calls[0].filters).toContain('eq:id=105');
    expect(calls[0].filters).toContain('not:id like b-%');

    await updateEmployeeStations('b-169', { primaryStation: 'abwasch' }, 'beaulieu');
    expect(calls[1].filters).toContain('like:id=b-%');
  });

  it('Presence-Guard: nur übergebene Felder im Patch', async () => {
    await updateEmployeeStations('105', { secondaryStations: ['a'] }, 'oliv');
    expect(calls[0].patch).toEqual({ secondary_stations: ['a'] });
    await updateEmployeeStations('105', { primaryStation: '' }, 'oliv');
    // '' = bewusstes Leeren der Hauptposition (identisch zum Personalstamm-Pfad)
    expect(calls[1].patch).toEqual({ primary_station: '' });
  });

  it('0 aktualisierte Zeilen = Fehler', async () => {
    returnedRows = [];
    const r = await updateEmployeeStations('105', { secondaryStations: [] }, 'oliv');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/0 Zeilen|nicht gefunden/);
  });
});
