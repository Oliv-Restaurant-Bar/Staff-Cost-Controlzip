// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SOCIAL_COST_RATES,
  SOCIAL_COST_RATE_FIELDS,
  normalizeSocialCostRates,
  normalizeSocialCostRatesBlob,
  totalSocialRatePct,
  socialCostFactorFromRates,
  splitEmployerCost,
  type SocialCostRates,
} from '@/lib/social-costs';

const ZERO_RATES: SocialCostRates = {
  ahvPct: 0, alvPct: 0, fakPct: 0, vkPct: 0, uvgBuPct: 0,
  ktgPct: 0, bvgPct: 0, lgavPct: 0, otherPct: 0,
};

describe('DEFAULT_SOCIAL_COST_RATES', () => {
  it('covers every field defined in SOCIAL_COST_RATE_FIELDS', () => {
    for (const f of SOCIAL_COST_RATE_FIELDS) {
      expect(DEFAULT_SOCIAL_COST_RATES[f.key]).toBeTypeOf('number');
    }
    expect(SOCIAL_COST_RATE_FIELDS.length).toBe(Object.keys(DEFAULT_SOCIAL_COST_RATES).length);
  });

  it('sums to a realistic CH employer rate (10–20%)', () => {
    const total = totalSocialRatePct(DEFAULT_SOCIAL_COST_RATES);
    expect(total).toBeGreaterThan(10);
    expect(total).toBeLessThan(20);
  });
});

describe('totalSocialRatePct / socialCostFactorFromRates', () => {
  it('sums all components', () => {
    const rates = { ...ZERO_RATES, ahvPct: 5.3, alvPct: 1.1, bvgPct: 4.5 };
    expect(totalSocialRatePct(rates)).toBeCloseTo(10.9, 10);
    expect(socialCostFactorFromRates(rates)).toBeCloseTo(1.109, 10);
  });

  it('zero rates → factor 1', () => {
    expect(totalSocialRatePct(ZERO_RATES)).toBe(0);
    expect(socialCostFactorFromRates(ZERO_RATES)).toBe(1);
  });
});

describe('splitEmployerCost', () => {
  it('splits gross into gross/social/total', () => {
    const rates = { ...ZERO_RATES, ahvPct: 10 };
    const s = splitEmployerCost(1000, rates);
    expect(s.gross).toBe(1000);
    expect(s.social).toBeCloseTo(100, 10);
    expect(s.total).toBeCloseTo(1100, 10);
  });

  it('total is always gross + social (default rates)', () => {
    const s = splitEmployerCost(5000, DEFAULT_SOCIAL_COST_RATES);
    expect(s.total).toBeCloseTo(s.gross + s.social, 10);
    expect(s.social).toBeCloseTo(5000 * totalSocialRatePct(DEFAULT_SOCIAL_COST_RATES) / 100, 10);
  });

  it('non-finite gross → 0 (kein NaN in Summen)', () => {
    const s = splitEmployerCost(NaN, DEFAULT_SOCIAL_COST_RATES);
    expect(s.gross).toBe(0);
    expect(s.social).toBe(0);
    expect(s.total).toBe(0);
  });
});

describe('normalizeSocialCostRates', () => {
  it('fills missing fields with defaults', () => {
    const r = normalizeSocialCostRates({ ahvPct: 6 });
    expect(r.ahvPct).toBe(6);
    expect(r.alvPct).toBe(DEFAULT_SOCIAL_COST_RATES.alvPct);
    expect(r.bvgPct).toBe(DEFAULT_SOCIAL_COST_RATES.bvgPct);
  });

  it('rejects negatives and non-numbers (→ default), caps at 50', () => {
    const r = normalizeSocialCostRates({ ahvPct: -1, alvPct: 'abc', bvgPct: 530 });
    expect(r.ahvPct).toBe(DEFAULT_SOCIAL_COST_RATES.ahvPct);
    expect(r.alvPct).toBe(DEFAULT_SOCIAL_COST_RATES.alvPct);
    expect(r.bvgPct).toBe(50);
  });

  it('accepts numeric strings', () => {
    const r = normalizeSocialCostRates({ ahvPct: '5.3' });
    expect(r.ahvPct).toBe(5.3);
  });

  it('null/garbage → full defaults', () => {
    expect(normalizeSocialCostRates(null)).toEqual(DEFAULT_SOCIAL_COST_RATES);
    expect(normalizeSocialCostRates([1, 2])).toEqual(DEFAULT_SOCIAL_COST_RATES);
  });

  it('allows explicit 0 (satz bewusst auf 0 gesetzt)', () => {
    const r = normalizeSocialCostRates({ ...DEFAULT_SOCIAL_COST_RATES, ktgPct: 0 });
    expect(r.ktgPct).toBe(0);
  });
});

describe('normalizeSocialCostRatesBlob', () => {
  it('normalizes empty/garbage to default blob', () => {
    const b = normalizeSocialCostRatesBlob(null);
    expect(b.version).toBe(1);
    expect(b.rates).toEqual(DEFAULT_SOCIAL_COST_RATES);
    expect(b.updatedAt).toBeNull();
  });

  it('preserves updatedAt and meta', () => {
    const b = normalizeSocialCostRatesBlob({
      version: 1,
      rates: { ahvPct: 6 },
      updatedAt: '2026-07-09T10:00:00Z',
      meta: { note: 'x' },
    });
    expect(b.updatedAt).toBe('2026-07-09T10:00:00Z');
    expect(b.meta).toEqual({ note: 'x' });
    expect(b.rates.ahvPct).toBe(6);
  });
});
