// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase-kv', () => ({
  kvGet: vi.fn(async () => null),
  kvSet: vi.fn(async () => {}),
  kvSetConfirmed: vi.fn(async () => {}),
}));

import {
  effectiveFlexIst, flexOverridesKey, loadFlexIstOverrides, saveFlexIstOverrides,
} from '@/lib/personalfix-flex-overrides';
import { kvGet, kvSetConfirmed } from '@/lib/supabase-kv';

const tk = (k: string) => `beaulieu:${k}`;

describe('effectiveFlexIst', () => {
  it('ohne AG-Häkchen gilt der Betrag 1:1', () => {
    expect(effectiveFlexIst({ amount: 5000, addAg: false }, 1.18)).toBe(5000);
  });
  it('mit AG-Häkchen wird mit dem Faktor hochgerechnet', () => {
    expect(effectiveFlexIst({ amount: 5000, addAg: true }, 1.18)).toBeCloseTo(5900, 5);
  });
});

describe('Persistenz (Mandant + Jahr + Monat)', () => {
  it('Key ist monats- und mandantengetrennt', () => {
    expect(flexOverridesKey(2026, 8)).toBe('pfix-flex-ist-overrides-2026-08');
  });

  it('save schreibt EIN Upsert-Blob unter dem tenant-Key, sanitisiert', async () => {
    await saveFlexIstOverrides(tk, 2026, 8, {
      employees: {
        a: { amount: 4200, addAg: true },
        bad: { amount: NaN as number, addAg: false },
      },
      total: { amount: 61000, addAg: false },
    });
    expect(kvSetConfirmed).toHaveBeenCalledWith('beaulieu:pfix-flex-ist-overrides-2026-08', {
      employees: { a: { amount: 4200, addAg: true } },
      total: { amount: 61000, addAg: false },
    }, 'Flex-Ist-Override');
  });

  it('load: fehlender/kaputter Blob → leere Overrides (nie werfen)', async () => {
    (kvGet as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    expect(await loadFlexIstOverrides(tk, 2026, 8)).toEqual({ employees: {}, total: null });
    (kvGet as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('net'));
    expect(await loadFlexIstOverrides(tk, 2026, 8)).toEqual({ employees: {}, total: null });
    (kvGet as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ employees: { x: { amount: '5' } }, total: 7 });
    expect(await loadFlexIstOverrides(tk, 2026, 8)).toEqual({ employees: {}, total: null });
  });
});
