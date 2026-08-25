// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getLastCompletedWeekRange } from '@/lib/completed-week';

describe('getLastCompletedWeekRange', () => {
  it('returns KW34 for the August 2026 Cockpit on 25 August', () => {
    expect(getLastCompletedWeekRange('2026-08-01', '2026-08-31', '2026-08-25'))
      .toEqual({ from: '2026-08-17', to: '2026-08-23' });
  });

  it('keeps the prior full week at the start of a current month', () => {
    expect(getLastCompletedWeekRange('2025-07-01', '2025-07-31', '2025-07-02'))
      .toEqual({ from: '2025-06-23', to: '2025-06-29' });
  });

  it('uses the final Sunday-ending week for a past month', () => {
    expect(getLastCompletedWeekRange('2025-06-01', '2025-06-30', '2025-07-16'))
      .toEqual({ from: '2025-06-23', to: '2025-06-29' });
  });

  it('has no completed week for a future month', () => {
    expect(getLastCompletedWeekRange('2025-12-01', '2025-12-31', '2025-07-16'))
      .toBeNull();
  });

  it('preserves the full prior week across a year boundary', () => {
    expect(getLastCompletedWeekRange('2026-01-01', '2026-01-31', '2026-01-02'))
      .toEqual({ from: '2025-12-22', to: '2025-12-28' });
  });
});